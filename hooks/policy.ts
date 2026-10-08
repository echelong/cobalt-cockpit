// Model policy: the one model this workflow never runs, and how a name is
// recognised as naming it.
//
// Fable is refused by structure, not by instruction. This module only answers
// "does this name, call or command identify Fable?"; register.tsx asks it at
// every point a model can be chosen (a model request about to be sent, a
// subagent about to start, a tool call, a slash command, a config row, a shell
// command) and refuses before anything runs. Nothing here knows how to call a
// model, so nothing here can fall back to one.
//
// What a block leaves behind is one fixed line and a counter. The prompt, the
// arguments and the name that was asked for are never recorded.

import type { PolicyState } from '../types'
import { parseShell, unwrap } from './shell'

export type { PolicyState } from '../types'

/** The whole record of a refusal: this line, and nothing about the request. */
export const BLOCK_LINE = 'MODEL BLOCK / FABLE / POLICY'

/** The rule as the system prompt states it; the hooks hold it whether or not it is read. */
export const FABLE_RULE =
  `Fable is never used: no model, alias, agent, tool, advisor or launcher that names it. Any such call is refused before it runs (${BLOCK_LINE}). Do not look for a way around it.`

/** What the model reads when its own call was the one refused. */
export const BLOCK_DENY = `${BLOCK_LINE}. Fable is never used in this workflow and nothing was sent. Do not retry with Fable under any name or alias, and do not route to it another way; use sonnet (the default) or opus.`

export const EMPTY_POLICY: PolicyState = { blocks: 0, calls: 0, lastBlockAt: null }

// `fable` as a word of its own inside an identifier: `fable`, `claude-fable`,
// `advisor-fable`, `claude-fable-5-1[1m]`, `us.anthropic.claude-fable-5-1-v1:0`,
// `mcp__fable__ask`. Letters on either side make it another word (`affable`,
// `fables`), which is not the model.
const FABLE = /(^|[^a-z])fable([^a-z]|$)/i
const INVISIBLE = /[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g

/**
 * Whether a model, provider, agent or tool name identifies Fable.
 *
 * Case does not matter, a camel-cased name is read by its words
 * (`advisorFable`), and compatibility forms and invisible characters are
 * folded first, so a name cannot be dressed up past the check.
 */
export const isFable = (name: unknown): boolean => {
  if (typeof name !== 'string' || name === '') return false
  const plain = name.normalize('NFKC').replace(INVISIBLE, '')

  // as written (any case), and again by its camel-cased words
  return FABLE.test(plain) || FABLE.test(plain.replace(/([a-z0-9])([A-Z])/g, '$1 $2'))
}

/** A model id is one short token; a path or a file name is not a model. */
const isModelToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 96 && /^[\w.:@/[\]-]+$/.test(value.trim()) && !/\.[a-z][a-z0-9]{1,11}$/i.test(value.trim())

const AGENT_TOOLS = new Set(['Agent', 'Task'])
/** Parameters that choose a model on a tool that is not the Agent tool. */
const MODEL_KEYS = ['model', 'provider', 'advisor', 'advisor_model', 'advisorModel', 'fallback_model', 'fallbackModel'] as const

/**
 * Whether a tool call would reach Fable: the tool's own name, the Agent tool's
 * `model` or `subagent_type`, or a model-choosing parameter of any other tool.
 *
 * Free text is deliberately not read. A prompt, a description, a file's
 * contents or a search pattern that mentions the word is not a route to the
 * model, and refusing it would stop ordinary work about this very policy.
 */
export const fableInCall = (tool: string, input: Record<string, unknown>): boolean => {
  if (isFable(tool)) return true
  if (AGENT_TOOLS.has(tool)) return isFable(input['model']) || isFable(input['subagent_type'])

  return MODEL_KEYS.some(key => isModelToken(input[key]) && isFable(input[key]))
}

/** Programs that start Claude Code, where a model flag chooses what runs. */
const LAUNCHERS = /^(claude|claude-code|cmax|cmax-opus|csmart|csmart-launcher)$/
/** The helper that exists only to start Fable. */
const FABLE_LAUNCHER = /^cfable$/
const MODEL_FLAGS = new Set(['--model', '--advisor', '--fallback-model', '--subagent-model'])
const MODEL_ENV = /^(ANTHROPIC_MODEL|ANTHROPIC_SMALL_FAST_MODEL|ANTHROPIC_CUSTOM_MODEL_OPTION|ANTHROPIC_DEFAULT_[A-Z0-9_]*MODEL|CLAUDE_CODE_SUBAGENT_MODEL[A-Z_]*)=(.*)$/
/** A model named inside inline JSON (`--settings`, `--agents`). */
const MODEL_JSON = /"(model|advisorModel|fallbackModel)"\s*:\s*"([^"]*)"/gi
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])
/** Builtins that set a variable for everything run after them. */
const ASSIGNERS = new Set(['export', 'declare', 'typeset', 'readonly'])
const MAX_DEPTH = 3

const jsonNamesFable = (text: string): boolean => [...text.matchAll(MODEL_JSON)].some(match => isFable(match[2]))

const argvNamesFable = (argv: readonly string[], depth: number): boolean => {
  const setsFable = (word: string): boolean => isFable(MODEL_ENV.exec(word)?.[2])
  const run = unwrap(argv)
  // `export ANTHROPIC_MODEL=fable` on its own: nothing is run, the variable is set
  if (run === null) return argv.some(setsFable)
  // `ANTHROPIC_MODEL=claude-fable-5-1 claude`, `env ANTHROPIC_MODEL=… claude`:
  // the words ahead of the program are its environment, and the variable picks
  // the model before any flag is read. The same word as an argument to some
  // other program (`grep ANTHROPIC_MODEL=fable notes.md`) sets nothing.
  const at = argv.findIndex(word => word.slice(word.lastIndexOf('/') + 1) === run.program)
  if (argv.slice(0, Math.max(0, at)).some(setsFable)) return true
  if (ASSIGNERS.has(run.program) && run.args.some(setsFable)) return true
  if (FABLE_LAUNCHER.test(run.program)) return true
  if (LAUNCHERS.test(run.program)) {
    for (let at = 0; at < run.args.length; at++) {
      const word = run.args[at] as string
      const [flag, inline] = word.split(/=(.*)/s, 2) as [string, string | undefined]
      if (MODEL_FLAGS.has(flag) && isFable(inline ?? run.args[at + 1])) return true
      if ((flag === '--settings' || flag === '--agents') && jsonNamesFable(inline ?? run.args[at + 1] ?? '')) return true
    }

    return false
  }
  // `bash -c '…'` and `eval '…'` run what they are handed
  if (depth < MAX_DEPTH) {
    if (SHELLS.has(run.program)) {
      const at = run.args.findIndex(word => /^-[a-z]*c$/.test(word))
      const script = at === -1 ? undefined : run.args[at + 1]
      if (script !== undefined && commandNamesFable(script, depth + 1)) return true
    }
    if (run.program === 'eval' && commandNamesFable(run.args.join(' '), depth + 1)) return true
  }

  return false
}

const commandNamesFable = (command: string, depth: number): boolean => {
  const parsed = parseShell(command)
  if (parsed.pipelines.some(pipeline => pipeline.commands.some(simple => argvNamesFable(simple.argv, depth)))) return true

  return depth < MAX_DEPTH && parsed.substitutions.some(inner => commandNamesFable(inner, depth + 1))
}

/**
 * Whether a shell command would start Claude Code on Fable: the `cfable`
 * helper, a launcher given a Fable `--model`, `--advisor` or fallback, or a
 * model variable set to it.
 *
 * Only commands that run are read. `grep fable`, `echo claude --model fable`
 * and editing a file that spells the name are untouched.
 */
export const fableInCommand = (command: string): boolean => {
  if (!/fable/i.test(command.normalize('NFKC'))) return false

  return commandNamesFable(command, 0)
}

const SETTINGS_FILE = /(^|\/)(settings(\.local)?\.json|\.claude\.json|managed-settings\.json)$/
const SETTINGS_MODEL = /"(model|advisorModel|fallbackModel|[A-Z][A-Z0-9_]*MODEL[A-Z0-9_]*)"\s*:\s*"([^"]*)"/g

/**
 * Whether text written to a Claude settings file would configure Fable as the
 * session's model, its advisor, its fallback or an alias's target.
 */
export const fableInSettings = (path: string, text: string): boolean =>
  SETTINGS_FILE.test(path) && [...text.matchAll(SETTINGS_MODEL)].some(match => isFable(match[2]))

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
/** What a shell parser that gave up is replaced by: the launcher and the flags, read as text. */
const SHELL_FALLBACK = /(^|[\s;&|(])cfable(\s|$)|--(model|advisor|fallback-model|subagent-model)[=\s]+\S*fable/i

/**
 * Whether one tool call is a route to Fable, by any of the ways above: its
 * name or model parameters, a shell command that would start Claude Code on
 * it, or an edit that would configure it.
 *
 * Total: it cannot throw, so the caller's refusal can never be skipped by an
 * input this module failed to parse.
 */
export const fableRoute = (tool: string, input: Record<string, unknown>): boolean => {
  if (fableInCall(tool, input)) return true
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  if (tool === 'Bash') {
    const command = text(input['command'])
    try {
      return fableInCommand(command)
    } catch {
      return SHELL_FALLBACK.test(command)
    }
  }
  if (EDIT_TOOLS.has(tool)) return fableInSettings(text(input['file_path']), text(input['new_string']) || text(input['content']))

  return false
}

/** The settings keys that name a model the engine would call without a `turn.step` model of its own. */
export const fableConfigured = (settings: Readonly<Record<string, unknown>>): boolean => isFable(settings['advisorModel'])

/** One refusal, counted. */
export const blocked = (state: PolicyState, at: number): PolicyState => ({ ...state, blocks: state.blocks + 1, lastBlockAt: at })

/**
 * One model response, counted when Fable is what answered. With the block in
 * place this never moves; it is read off real responses so that the `Calls 0`
 * the diagnostics show is a measurement rather than a promise.
 */
export const answered = (state: PolicyState, model: unknown): PolicyState => (isFable(model) ? { ...state, calls: state.calls + 1 } : state)
