// Conversational turns. A message typed into the interactive shell becomes one supervised task:
// these rules decide its kind, mode and risk (the router then picks the model), and build the
// worker prompt with a bounded transcript so the conversation keeps its context across turns.
// Code changes carry over through the mission branch: each turn starts from the integrated head.
import { lexicalFeatures } from './core/engine.ts'
import type { TaskSpec } from './router.ts'

/** `rejected`: an assistant answer whose turn did not pass Cockpit's verification (its changes were not kept). */
export type Entry = { role: 'user' | 'assistant' | 'system'; text: string; turn: string | null; at: string; rejected?: boolean }

const EDIT = /\b(?:add|implement|create|write|fix|change|update|modify|refactor|rename|remove|delete|replace|move|extract|convert|migrate|bump|upgrade|introduce|make\s+(?:it|the|a|an)\b|edit|patch|rewrite|clean\s+up|optimi[sz]e|support)\b/i
const ASK = /^\s*(?:what|why|how|where|which|who|when|is|are|does|do|can|could|should|explain|describe|summari[sz]e|tell\s+me|show\s+me|list)\b|\?\s*$/i
const DEBUG = /\b(?:bug|error|exception|crash|traceback|stack\s*trace|failing|fails|broken|regression|doesn'?t\s+work|not\s+working|flaky|hang|deadlock|leak)\b/i
const FRONTEND = /\b(?:ui|ux|front-?end|css|tailwind|react|vue|svelte|component|layout|responsive|accessibility|a11y|screenshot|visual\s+design|ui\s+design|design\s+system|animation|html|page)\b/i
const TESTS = /\b(?:tests?|spec|coverage)\b/i
/** Questions that inventory the code (where/which/find … uses, callers, definitions): repository scouting. */
const SCOUT = /\b(?:where|which|find|list|show|locate)\b.*\b(?:all|every|uses?|usages?|references?|callers?|call\s+sites?|occurrences?|defined|declared|imports?|files?)\b/i

export type Classified = { spec: TaskSpec; reason: string }

/** Decides the task fields for one turn by fixed rules; nothing here chooses a model. */
export const classifyTurn = (message: string, turnId: string): Classified => {
  const text = message.trim()
  const f = lexicalFeatures({ prompt: text, files: [], milestones: 0, errorStreak: 0 })
  const edits = EDIT.test(text)
  const question = ASK.test(text) && !edits
  const long = text.length > 600 ? 4 : text.length > 240 ? 3 : 2
  const base = { id: turnId, title: text.split('\n')[0].slice(0, 120) || turnId, dependencies: [], prompt: text, priority: 7, depth: 0, parent: null, allowNoChanges: true }
  if (question) {
    if (f.discovery || SCOUT.test(text)) return { spec: { ...base, kind: 'scout', risk: 'low', complexity: 1, mode: 'read', owned: ['*'] }, reason: 'question that inventories or searches the code: read-only scouting' }
    return { spec: { ...base, kind: 'ask', risk: 'low', complexity: long, mode: 'read', owned: ['*'] }, reason: 'question about the code: read-only answer' }
  }
  // architecture wording goes to the commander before any other rule (a design turn may also write)
  if (f.architecture) return { spec: { ...base, kind: 'architecture', risk: f.security ? 'high' : 'medium', complexity: Math.max(long, 4), mode: edits ? 'write' : 'read', owned: ['*'] }, reason: 'architecture work: the commander' }
  if (DEBUG.test(text)) return { spec: { ...base, kind: 'debug', risk: f.security ? 'high' : 'medium', complexity: Math.max(long, f.difficult ? 4 : 2), mode: 'write', owned: ['*'] }, reason: 'reports a failure: debugging with edits' }
  if (FRONTEND.test(text)) return { spec: { ...base, kind: 'frontend', risk: 'medium', complexity: long, mode: 'write', owned: ['*'] }, reason: 'frontend/UI work' }
  if (TESTS.test(text) && edits) return { spec: { ...base, kind: 'test', risk: 'medium', complexity: long, mode: 'write', owned: ['*'] }, reason: 'writes or changes tests' }
  return { spec: { ...base, kind: 'implement', risk: f.security ? 'high' : 'medium', complexity: long, mode: 'write', owned: ['*'] }, reason: edits ? 'asks for a change: implementation' : 'instruction without a question: implementation' }
}

const MAX_CONTEXT_CHARS = 6000
export const REQUEST_HEADING = 'Current request from the person:'
/**
 * The background a turn's worker gets before its request: the recent conversation and the files
 * earlier turns changed. It is the task's `context`, which routing never reads, so an earlier
 * turn's wording cannot change where this turn goes.
 */
export const turnContext = (transcript: readonly Entry[], integrated: string[]): string => {
  const prior: string[] = []
  let size = 0
  for (const e of [...transcript].reverse()) {
    if (e.role === 'system') continue
    const who = e.role === 'user' ? 'Person' : e.rejected ? 'You (earlier turn; NOT accepted by Cockpit\'s verification, its changes were discarded)' : 'You (earlier turn)'
    const line = `${who}: ${e.text.replace(/\s+\n/g, '\n').slice(0, 1500)}`
    if (size + line.length > MAX_CONTEXT_CHARS) break
    prior.unshift(line); size += line.length
  }
  return [
    prior.length ? `Conversation so far (most recent last; accepted turns' code changes are already in this checkout):\n${prior.join('\n\n')}\n` : '',
    integrated.length ? `Files changed in earlier turns: ${integrated.slice(-30).join(', ')}\n` : '',
  ].join('\n').trim()
}
/** The turn's own request: the only text (with its title) the router reads. */
export const turnRequest = (message: string): string => `${REQUEST_HEADING}\n${message}`
/** Context and request together, as the worker sees them. */
export const turnPrompt = (message: string, transcript: readonly Entry[], integrated: string[]): string => [turnContext(transcript, integrated), turnRequest(message)].filter(Boolean).join('\n\n')
