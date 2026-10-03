// The Activity Field's event model: what the plugin is allowed to show, and
// nothing else.
//
// Every row in the field is built here from something the host actually
// reported, and every field of an `ActivityEvent` is chosen so that a row can
// never carry something private. The rules, each enforced by the code below:
//
//   - SAFE BY CONSTRUCTION. `safeDetail` is the only thing that ever fills
//     `detail`, and it accepts a basename, a hostname or an enumerated word.
//     There is no path by which a command line, a file's contents, a prompt, a
//     subagent's description or any reasoning reaches the field, because none of
//     those are ever read into an event.
//   - REAL BY CONSTRUCTION. An observation that does not map to one of the
//     `EventKind`s produces no event at all, rather than a guess. The tape can
//     therefore only ever be as long as the real activity.
//   - BOUNDED. `push` keeps a fixed recent window, so a long session cannot grow
//     the field without limit.
//   - NO BACKDATING. `startedAt` and `endedAt` come from the host's clock, and
//     an event with no end carries `endedAt: null`, so nothing is ever drawn as
//     finished that is still running.

import type { ActivityEvent, ActivityLog, EventKind, EventState } from '../types'
import { basename } from './shell'

export type { ActivityEvent, ActivityLog, EventKind, EventState } from '../types'

/** The most events kept. Older ones fall off the end and are never drawn. */
export const EVENT_MAX = 24
/** How long a finished event stays meaningful before the field forgets it. */
export const EVENT_TTL_MS = 120_000

export const EMPTY_LOG: ActivityLog = { events: [] }

const MAX_DETAIL = 24
const MAX_LABEL = 6

/** Strips anything that is not a plain, safe word. */
const word = (value: unknown, max: number): string =>
  (typeof value === 'string' ? value : '')
    .replace(/[^A-Za-z0-9._/:-]/g, '')
    .slice(0, max)

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LSP', 'NotebookRead', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit'])
const WRITE_TOOLS = new Set(['Write', 'Create'])
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])
const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'EnterPlanMode', 'ExitPlanMode'])
const AGENT_TOOLS = new Set(['Task', 'Agent'])

/** The envelope's own fields, which are never a tool's arguments. */
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'input'])

/**
 * What kind of observation a tool call is, or null when it is not activity
 * worth a row.
 *
 * A Bash call is classified by what it runs, and only the resulting word
 * survives: the command itself is discarded here and never enters an event.
 */
export const kindOf = (tool: string, input: Record<string, unknown>): EventKind | null => {
  if (tool === 'Bash') return bashKind(input)
  if (READ_TOOLS.has(tool)) return 'READ'
  if (EDIT_TOOLS.has(tool)) return 'EDIT'
  if (WRITE_TOOLS.has(tool)) return 'WRITE'
  if (WEB_TOOLS.has(tool)) return 'WEB'
  if (AGENT_TOOLS.has(tool)) return 'AGENT'
  if (PLAN_TOOLS.has(tool)) return 'PLAN'

  return null
}

// A tool call's own arguments, which the envelope carries spread flat beside
// `tool` and `tool_use_id` rather than under an `input` field.
const argsOf = (call: Record<string, unknown>): Record<string, unknown> => {
  const nested = call['input']
  const flat = Object.fromEntries(Object.entries(call).filter(([key]) => !RESERVED.has(key)))

  return nested !== null && typeof nested === 'object' ? { ...flat, ...(nested as Record<string, unknown>) } : flat
}

/** A Bash call's kind, from a coarse reading of the command that never leaves here. */
const bashKind = (input: Record<string, unknown>): EventKind | null => {
  const command = text(input['command']).toLowerCase()
  if (command === '') return null
  if (/\b(git|gh)\b/.test(command)) return 'GIT'
  if (/\b(test|tests|spec|vitest|jest|pytest|mocha|ava)\b/.test(command)) return 'TEST'
  if (/\b(build|compile|bundle|tsc|typecheck|type-check)\b/.test(command)) return 'BUILD'

  return 'BASH'
}

/**
 * The safe target for an event, or the empty string when nothing safe exists.
 *
 * This is the security boundary of the Activity Field, and it is deliberately
 * narrow. A path becomes its basename; a URL becomes its hostname. Anything else
 * yields `''`, which draws the verb alone. In particular the `description` of an
 * `Agent` call is never read, because a task description is prompt text, and no
 * field of a `Bash` call other than the command's coarse shape is either.
 */
export const safeDetail = (tool: string, input: Record<string, unknown>): string => {
  if (tool === 'Bash') return ''
  if (READ_TOOLS.has(tool) || EDIT_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) {
    const path = text(input['file_path']) || text(input['notebook_path']) || text(input['path'])

    return path === '' ? '' : word(basename(path), MAX_DETAIL)
  }
  if (tool === 'Grep' || tool === 'Glob') return word(text(input['pattern']), MAX_DETAIL)
  if (WEB_TOOLS.has(tool)) {
    const url = text(input['url'])

    return url !== '' && URL.canParse(url) ? word(new URL(url).hostname, MAX_DETAIL) : word(text(input['query']), MAX_DETAIL)
  }

  return ''
}

/**
 * One real tool call as an event, or null when the call is not activity the
 * field should draw.
 *
 * `envelope` is the whole `tool.call` argument, whose own arguments sit flat
 * beside `tool` and `tool_use_id`; `argsOf` separates the two so a path can be
 * read without the envelope's own fields ever being mistaken for one.
 *
 * `id` is the call's own `tool_use_id` when it has one, so the event can later
 * be closed by that id; a call without one gets a synthetic id derived from its
 * start time, which cannot be closed, and that is honest: nothing invented.
 */
export const callOf = (envelope: Record<string, unknown>, at: number): ActivityEvent | null => {
  const tool = typeof envelope['tool'] === 'string' ? (envelope['tool'] as string) : ''
  const useId = typeof envelope['tool_use_id'] === 'string' ? (envelope['tool_use_id'] as string) : undefined

  return eventOf(tool, argsOf(envelope), at, useId)
}

/**
 * One real tool call as an event, or null when the call is not activity the
 * field should draw.
 */
export const eventOf = (tool: string, input: Record<string, unknown>, at: number, toolUseId?: string): ActivityEvent | null => {
  const kind = kindOf(tool, input)
  if (kind === null) return null

  return {
    id: toolUseId === undefined || toolUseId === '' ? `at-${at}` : toolUseId,
    kind,
    label: word(kind, MAX_LABEL),
    detail: safeDetail(tool, input),
    state: 'running',
    startedAt: at,
    endedAt: null,
  }
}
/**
 * Closes the event for a finished call.
 *
 * A call with no matching running event adds nothing: a completion that never
 * had a start cannot be shown as having happened. This is what makes the field
 * unable to contain an imaginary event.
 */
export const closeOf = (log: ActivityLog, id: string, failed: boolean, at: number): ActivityLog => {
  const index = log.events.findIndex(event => event.id === id && event.endedAt === null)
  const target = log.events[index]
  if (target === undefined) return log
  const events = log.events.slice()

  events[index] = { ...target, state: failed ? 'failed' : 'done', endedAt: at }

  return { events }
}

/**
 * Adds one event and keeps the window bounded, dropping whatever fell off the
 * end. A duplicate id replaces the running row rather than stacking a second
 * one, so a re-observed call cannot inflate the tape.
 */
export const push = (log: ActivityLog, event: ActivityEvent): ActivityLog => {
  const events = log.events.filter(one => one.id !== event.id)

  events.push(event)

  return { events: events.slice(-EVENT_MAX) }
}

/**
 * The events still worth drawing: everything unexpired, oldest first.
 *
 * Expiry is by age since the event ended, so a running event is never expired
 * and the field can never claim a live call has gone stale.
 */
export const liveOf = (log: ActivityLog, now: number): ActivityEvent[] =>
  log.events.filter(event => event.endedAt === null || now - event.endedAt < EVENT_TTL_MS)

/**
 * The newest event that is really happening or really just happened: the one
 * the crawler attaches to. A running event wins over a finished one, because
 * that is the thing actually in flight.
 */
export const currentOf = (events: readonly ActivityEvent[]): ActivityEvent | null => {
  const running = events.filter(event => event.state === 'running')

  return running[running.length - 1] ?? events[events.length - 1] ?? null
}

/** The ids of events that really finished: what VERIFY revisits. */
export const settledIds = (events: readonly ActivityEvent[]): string[] => events.filter(event => event.state === 'done').map(event => event.id)