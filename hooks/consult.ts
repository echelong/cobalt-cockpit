// Opus consultation admission for the SONNET_LED profile.
//
// Sonnet builds, Haiku scouts, Opus reviews, NobodyWho advises. In this profile
// Opus is never the main loop and never a background model: it is one bounded
// architect/reviewer subagent, admitted on a stated ground, given a concise
// evidence packet instead of the conversation, and asked for one decision.
//
// This module is pure. It reads facts the host already reported (the person's
// prompt, the files the task touched, the failure streak, the swarm) and
// answers whether a consultation may start, whether the task needs one before
// it can finish, and what the consultation is told. It never spawns and never
// calls a model or a router: the session router (router.ts) is asked at the
// start of a task, never at admission, and never decides it.
//
//   - GROUNDS. architecture, security, repeated-failure, asked, release. A
//     ground holds on evidence, not on the main loop's say-so.
//   - MANDATORY. asked, release and security-sensitive files: the task is held
//     below 100% until a consultation has returned and the main session has
//     adjudicated its advice (verified it, pass or fail).
//   - BOUNDS. One live Opus at a time; an unchanged problem is consulted once;
//     a failed consultation is retried at most once; three per task.

import { redactSecrets, secretText } from './secrets'
import type { ClearedGround, ConsultGround, Consultation, EvidencePacket, Profile, ReleaseOutcome, ReleaseRecord, ReviewRequirement, Swarm, SwarmTask, Task } from '../types'
export type { ConsultGround, Consultation, EvidencePacket, ReviewRequirement } from '../types'

export const GROUNDS: readonly ConsultGround[] = ['architecture', 'security', 'repeated-failure', 'asked', 'release']
export const MANDATORY: readonly ConsultGround[] = ['asked', 'release', 'security']
/** The same failure this many times in a row: failed, was told to change approach, failed again. */
export const FAILURE_STREAK = 3
export const MAX_PER_TASK = 3
/**
 * The budget, in three separate parts. DISCRETIONARY consultations (every ground but release) are three per
 * task and MAX_DISCRETIONARY_LEDGER per ledger, so resetting the task does not give more. RELEASE consultations
 * are not counted in either: each is tied to one full commit id, one may return per commit, and at most
 * MAX_RELEASE_ATTEMPTS are admitted for it (the first and one retry after an attempt that did not return),
 * with MAX_RELEASE_SESSION in one ledger. The per-commit record also lives in the store across sessions.
 */
export const MAX_DISCRETIONARY_LEDGER = 12
export const MAX_RELEASE_ATTEMPTS = 2
export const MAX_RELEASE_SESSION = 6
export const MAX_RELEASE_RECORDS = 32
export const isCandidate = (value: unknown): value is string => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
/** Attempts of one unchanged problem: the first and one retry after a failed or cancelled run. */
export const MAX_ATTEMPTS_PER_KEY = 2
export const MAX_CONSULTS = 32
const TEXT_MAX = 1200
const ITEM_MAX = 300
const LIST_MAX = 12
/** An architectural change of this observed spread may consult Opus. A plan's length is the main loop's own word and is not counted. */
export const ARCH_FILES = 5
export const ARCH_DIRS = 3

export const isGround = (value: unknown): value is ConsultGround => typeof value === 'string' && (GROUNDS as readonly string[]).includes(value)

const NEGATION = /\b(?:no|not|don'?t|do\s+not|never|without|skip|avoid|nor)\b[^.;:!?\n]{0,24}$/i

/** True when `pattern` occurs in `text` at least once without a negation just before it. */
export const affirmed = (text: string, pattern: RegExp): boolean => {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  for (const match of text.matchAll(global)) {
    if (!NEGATION.test(text.slice(Math.max(0, (match.index ?? 0) - 40), match.index))) return true
  }

  return false
}

const ASKS_OPUS = /\b(?:ask|consult|get|have|involve|use|bring\s+in)\s+(?:an?\s+|the\s+)?opus\b|\bopus\s+(?:review|consult(?:ation)?|architect|opinion|sign[- ]?off|approval)\b|\barchitect(?:ural)?\s+review\b/i
const ASKS_RELEASE = /\b(?:release\s+(?:gate|review|approval|candidate)|approve\s+(?:the\s+)?release|cut\s+(?:a\s+)?(?:release|tag)|go\/no-go|publish\s+(?:the\s+)?(?:release|plugin|package|version)|ship\s+(?:it|this|v?\d))\b/i
const MENTIONS_ARCH = /\b(?:architect(?:ure|ural)|redesign|re-architect|migrat(?:e|ion)|cross-cutting|data\s+model|schema\s+change|public\s+api)\b/i
const MENTIONS_SECURITY = /\b(?:security|vulnerab\w*|authenticat\w*|authoriz\w*|credentials?|secrets?|sandbox\w*|privilege\w*|injection|permission\s+model)\b/i
/** Paths whose change is security-sensitive by name: auth, secrets, permissions, policy and guards. */
export const SENSITIVE_PATH = /(?:^|\/)(?:auth[nz]?|security|secrets?|credentials?|permissions?|crypto|sandbox|polic(?:y|ies)|guards?)(?:[._/-]|$)|(?:^|\/)\.env(?:\.|$)|(?:^|\/)id_(?:rsa|ed25519)|\.pem$/i

export type ConsultFacts = {
  /** The person's latest prompt. */
  prompt: string
  /** Files the task has touched. */
  files: readonly string[]
  milestones: number
  /** How many times in a row the same failure has repeated. */
  errorStreak: number
  /** Grounds read off the person's full prompts earlier in this task (prompts are stored clipped). */
  promptGrounds?: readonly ConsultGround[]
}

export const factsOf = (task: Task | null, errorStreak: number, promptGrounds: readonly ConsultGround[] = []): ConsultFacts => ({
  prompt: task?.lastPrompt ?? '',
  files: task?.files.map(f => f.path) ?? [],
  milestones: task?.milestones.length ?? 0,
  errorStreak,
  promptGrounds,
})

/** The grounds a person's prompt raises by itself, read from its full text. */
export const promptGroundsOf = (text: string): ConsultGround[] => groundsAvailable({ prompt: text, files: [], milestones: 0, errorStreak: 0 })

const dirsOf = (files: readonly string[]): number => new Set(files.map(f => f.replace(/^\/+/, '').split('/').slice(0, -1).join('/') || '.')).size

/** The grounds on which Opus may be consulted now. Empty for ordinary work. */
export const groundsAvailable = (facts: ConsultFacts): ConsultGround[] => {
  const out: ConsultGround[] = []
  const large = facts.files.length >= ARCH_FILES || dirsOf(facts.files) >= ARCH_DIRS
  if (large || affirmed(facts.prompt, MENTIONS_ARCH)) out.push('architecture')
  if (facts.files.some(f => SENSITIVE_PATH.test(f)) || affirmed(facts.prompt, MENTIONS_SECURITY)) out.push('security')
  if (facts.errorStreak >= FAILURE_STREAK) out.push('repeated-failure')
  if (affirmed(facts.prompt, ASKS_OPUS)) out.push('asked')
  if (affirmed(facts.prompt, ASKS_RELEASE)) out.push('release')

  return [...new Set([...out, ...(facts.promptGrounds ?? [])])].sort((a, b) => GROUNDS.indexOf(a) - GROUNDS.indexOf(b))
}

/** The grounds that make a consultation a condition of finishing. Security is mandatory only for sensitive files changed. */
export const mandatoryGrounds = (facts: ConsultFacts): ConsultGround[] => {
  const out: ConsultGround[] = []
  if (facts.files.some(f => SENSITIVE_PATH.test(f))) out.push('security')
  if (affirmed(facts.prompt, ASKS_OPUS)) out.push('asked')
  if (affirmed(facts.prompt, ASKS_RELEASE)) out.push('release')
  for (const g of facts.promptGrounds ?? []) if ((g === 'asked' || g === 'release') && !out.includes(g)) out.push(g)

  return out
}

const clip = (text: unknown, max: number): string => {
  const line = typeof text === 'string' ? redactSecrets(text).replace(/[ \t]+/g, ' ').trim() : ''

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
// A location is a path the architect reads; it is refused, never rewritten, when it is credential-shaped.
const plain = (text: unknown, max: number): string => { const line = typeof text === 'string' ? text.replace(/[ \t]+/g, ' ').trim() : ''; return line.length > max ? line.slice(0, max) : line }
const clipList = (items: unknown): string[] => (Array.isArray(items) ? items : []).map(i => clip(i, ITEM_MAX)).filter(Boolean).slice(0, LIST_MAX)

/**
 * The file a packet location names. A location is evidence for the brief and
 * may carry a line reference (`src/a.ts:8`, `src/a.ts:8-12`, `src/a.ts:8:3`,
 * `src/a.ts#L8-L12`); the architect's read scope is the file itself, so the
 * reference is dropped here and kept, verbatim, in the brief.
 */
export const locationPath = (location: string): string =>
  location.trim().replace(/#L\d+(?:-L?\d+)?$/, '').replace(/:\d+(?:[-:]\d+){0,2}$/, '')

/** Where a consultation may read: each named file once, in order. */
export const readScopeOf = (p: EvidencePacket): string[] => [...new Set(p.files.map(locationPath).filter(Boolean))]

/** An admitted consultation asks for this level unless the operator's ceiling or the engine holds it lower. */
export const CONSULT_EFFORT = 'high' as const

/** A packet held to its bounds, or the first thing missing from it. */
export const packetOf = (ground: ConsultGround, raw: Partial<Record<keyof EvidencePacket, unknown>>): { packet: EvidencePacket } | { error: string } => {
  const packet: EvidencePacket = {
    objective: clip(raw.objective, TEXT_MAX),
    architecture: clip(raw.architecture, TEXT_MAX),
    files: (Array.isArray(raw.files) ? raw.files : []).map(i => plain(i, ITEM_MAX)).filter(Boolean).slice(0, LIST_MAX),
    alternatives: clipList(raw.alternatives),
    failures: clipList(raw.failures),
    risk: clip(raw.risk, TEXT_MAX),
    decision: clip(raw.decision, TEXT_MAX),
  }
  if (packet.files.some(f => secretText(locationPath(f)))) return { error: 'locations must be file paths: one looks like a credential' }
  if (!packet.objective) return { error: 'objective required: what the work is for' }
  if (!packet.decision) return { error: 'question required: the precise decision Opus is asked for' }
  if (!packet.risk) return { error: 'risk required: what goes wrong if the decision is wrong' }
  if (['architecture', 'security', 'repeated-failure'].includes(ground) && packet.files.length === 0) return { error: 'locations required: the relevant files' }
  if (['architecture', 'repeated-failure'].includes(ground) && packet.alternatives.length === 0) return { error: 'alternatives required: the approaches considered or already tried' }
  if (ground === 'repeated-failure' && packet.failures.length === 0) return { error: 'failures required: the failing output, briefly' }

  return { packet }
}

/** FNV-1a over the normalized problem: the same problem, however it is spaced, has one key. */
export const problemKey = (ground: ConsultGround, p: EvidencePacket): string => {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const text = [ground, norm(p.objective), norm(p.decision), [...p.files].map(norm).sort().join('|'), p.failures.map(norm).join('|'), p.alternatives.map(norm).sort().join('|')].join('\u0000')
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0

  return hash.toString(16).padStart(8, '0')
}

/**
 * The terminal states of a consultation, read one way everywhere:
 *   admitted / running  open: nothing can be admitted beside it.
 *   returned            the host saw the architect finish (`hasReturned`); only this is an answer from Opus.
 *   failed              the run failed, or was marked complete with no architect seen to finish: a spent attempt.
 *   cancelled           withdrawn before it answered: a spent attempt.
 *   escalated           the architect handed the problem on instead of answering: a spent attempt, never an answer
 *                       and never an approval.
 * Past `returned` there are three more facts, kept apart: VERIFIED (the main session judged the advice, pass or
 * fail), the RECOMMENDATION (GO or NO-GO, read off the architect's own DECISION line) and the owner's approval to
 * publish, which Cockpit never records. Only a returned, verified pass with a GO for the exact clean commit clears a
 * release ground.
 */
export type ConsultStatus = 'admitted' | 'running' | 'returned' | 'failed' | 'cancelled' | 'escalated'

/** A consultation's lifecycle, read off the swarm task it ran as. */
export const statusOf = (task: SwarmTask | undefined): ConsultStatus => {
  if (task === undefined) return 'cancelled'
  if (task.state === 'queued' || task.state === 'blocked' || task.state === 'reserved') return 'admitted'
  if (task.state === 'running' || task.state === 'stalled') return 'running'
  if (task.state === 'completed') return hasReturned(task) ? 'returned' : 'failed'
  if (task.state === 'escalated') return 'escalated'

  return task.state === 'cancelled' ? 'cancelled' : 'failed'
}

/**
 * Whether a consultation was really answered: its task was bound to the
 * architect the admission hook spawned for it, and the host observed that agent
 * finish. A result or a verdict filed without that is not an answer from Opus.
 */
export const hasReturned = (task: SwarmTask | undefined): boolean => task !== undefined && task.tier === 'OPUS' && task.state === 'completed' && task.agentId !== null && task.endedAt !== null

const taskOf = (swarm: Swarm, id: string): SwarmTask | undefined => swarm.tasks.find(t => t.id === id)

export type ConsultRequest = {
  profile: Profile
  ground: ConsultGround
  packet: EvidencePacket
  facts: ConsultFacts
  consults: readonly Consultation[]
  swarm: Swarm
  progressTask: number | null
  /** A release consultation's commit: the full id of HEAD of a clean working tree, or null where it could not be established. */
  candidate?: string | null
  /** The store's release records, across sessions. */
  history?: readonly ReleaseRecord[]
}

/**
 * Whether a consultation may start, and why not. In order: the profile, the
 * ground, one live Opus at a time, an unchanged problem consulted once, the
 * retry budget of a problem, the budget of a task.
 */
export const consultVerdict = (r: ConsultRequest): { ok: true; key: string; isMandatory: boolean } | { ok: false; reason: string } => {
  if (r.profile !== 'SONNET_LED') return { ok: false, reason: 'OPUS / LEGACY PROFILE. In OPUS_LED the main loop is already Opus; there is no consultation subagent.' }
  const available = groundsAvailable(r.facts)
  if (!available.includes(r.ground)) {
    return { ok: false, reason: available.length === 0
      ? `OPUS / NOT ADMITTED. Nothing supports "${r.ground}" here: this is ordinary work, so Sonnet completes and verifies it without Opus. Nothing was started.`
      : `OPUS / NOT ADMITTED. "${r.ground}" does not hold here; the grounds that do are ${available.join(', ')}. Nothing was started.` }
  }
  const live = r.consults.find(c => ['admitted', 'running'].includes(statusOf(taskOf(r.swarm, c.id))))
  if (live) return { ok: false, reason: `OPUS / OCCUPIED. Consultation ${live.id} is still open; one Opus specialist at a time. Spawn it, wait for it, or cancel it.` }
  if (r.ground === 'release') return releaseVerdict(r, mandatoryGrounds(r.facts).includes('release'))
  const key = problemKey(r.ground, r.packet)
  const same = r.consults.filter(c => c.key === key)
  const answered = same.find(c => statusOf(taskOf(r.swarm, c.id)) === 'returned')
  if (answered) return { ok: false, reason: `OPUS / DUPLICATE. This unchanged problem was already consulted (${answered.id}). Act on its decision, or change the evidence (new failures, a different approach) before asking again.` }
  if (same.length >= MAX_ATTEMPTS_PER_KEY) return { ok: false, reason: `OPUS / RETRY BUDGET. This problem has had ${same.length} consultations that did not return; continue in Sonnet or block with the reason.` }
  const discretionary = r.consults.filter(c => c.ground !== 'release')
  if (discretionary.length >= MAX_DISCRETIONARY_LEDGER) return { ok: false, reason: `OPUS / LEDGER BUDGET. This session has had ${discretionary.length} discretionary consultations in all; a task reset does not give more. Continue in Sonnet or block with the reason.` }
  if (r.progressTask !== null && discretionary.filter(c => c.progressTask === r.progressTask).length >= MAX_PER_TASK) return { ok: false, reason: `OPUS / TASK BUDGET. This task has had ${MAX_PER_TASK} consultations; continue in Sonnet or block with the reason.` }

  return { ok: true, key, isMandatory: mandatoryGrounds(r.facts).includes(r.ground) }
}

/**
 * A release consultation: tied to the full commit id it reviews, and bounded apart from the discretionary
 * budget. An unidentifiable candidate is refused, never approved. Approval of one commit says nothing of
 * another, and a commit that returned is not reviewed again.
 */
const releaseVerdict = (r: ConsultRequest, isMandatory: boolean): { ok: true; key: string; isMandatory: boolean } | { ok: false; reason: string } => {
  if (!isCandidate(r.candidate)) return { ok: false, reason: 'OPUS / CANDIDATE UNKNOWN. A release review is tied to one full commit id of a clean working tree, and none could be established (no repository, no commit, uncommitted changes, or git did not answer). Commit the candidate, then ask again. Nothing was started.' }
  const sha = r.candidate
  const mine = r.consults.filter(c => c.ground === 'release' && c.candidate === sha)
  const kept = (r.history ?? []).filter(h => h.candidate === sha)
  const answered = mine.find(c => statusOf(taskOf(r.swarm, c.id)) === 'returned') ?? kept.find(h => h.returned)
  if (answered) return { ok: false, reason: `OPUS / DUPLICATE. Commit ${sha.slice(0, 12)} was already reviewed (${answered.id}); no second consultation is started. A verified GO for this exact commit is applied to this task by itself; a NO-GO, or a review not yet verified, is not an approval. A changed commit is a new candidate.` }
  const attempts = new Set([...mine.map(c => c.id), ...kept.map(h => h.id)]).size
  if (attempts >= MAX_RELEASE_ATTEMPTS) return { ok: false, reason: `OPUS / RELEASE RETRY BUDGET. Commit ${sha.slice(0, 12)} has had ${attempts} release consultations that did not return; block with the reason.` }
  const inSession = r.consults.filter(c => c.ground === 'release').length
  if (inSession >= MAX_RELEASE_SESSION) return { ok: false, reason: `OPUS / RELEASE ALLOWANCE. This session has had ${inSession} release consultations; block with the reason.` }
  const text = `release\u0000${sha}`
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0

  return { ok: true, key: hash.toString(16).padStart(8, '0'), isMandatory }
}

/**
 * Adds a consultation record, keeping the newest MAX_CONSULTS. Release records are kept ahead of the rest
 * (up to MAX_RELEASE_RECORDS), so a crowd of ordinary consultations cannot push a release record out.
 */
export const addConsult = (consults: readonly Consultation[], c: Consultation): Consultation[] => {
  const all = [...consults.filter(old => old.id !== c.id), c]
  const release = all.filter(x => x.ground === 'release').slice(-MAX_RELEASE_RECORDS)
  const rest = all.filter(x => x.ground !== 'release').slice(-Math.max(0, MAX_CONSULTS - release.length))
  const keep = new Set([...release, ...rest])

  return all.filter(x => keep.has(x))
}

/**
 * The store's release records after one more consultation or one more fact about it. Merged by id: a record keeps
 * the commit and time it was first written with, `returned` never goes back to false, and a later write that knows
 * less (no verdict yet) cannot erase what an earlier one recorded.
 */
export const withRelease = (history: readonly ReleaseRecord[], record: ReleaseRecord): ReleaseRecord[] => {
  const old = history.find(h => h.id === record.id)
  const merged: ReleaseRecord = old === undefined ? record : { candidate: old.candidate, id: old.id, at: old.at, returned: old.returned || record.returned, ...((record.verified ?? old.verified) === undefined ? {} : { verified: record.verified ?? old.verified }), ...((record.outcome ?? old.outcome) === undefined ? {} : { outcome: record.outcome ?? old.outcome }) } as ReleaseRecord

  return [...history.filter(h => h.id !== record.id), merged].slice(-MAX_RELEASE_RECORDS)
}

/**
 * The architect's release recommendation: exactly one `DECISION:` line, saying GO or NO-GO and nothing else it could
 * be mistaken for. Missing, repeated, hedged or unreadable is undefined, and undefined never approves.
 */
export const releaseDecision = (answer: unknown): ReleaseOutcome | undefined => {
  if (typeof answer !== 'string') return undefined
  const lines = answer.split(/\r?\n/).filter(l => /^[\s>*_#-]*DECISION[\s*_]*:/i.test(l))
  if (lines.length !== 1) return undefined
  const verdict = /^[\s>*_#-]*DECISION[\s*_]*:[\s*_]*(NO[-\s]?GO|GO)(?![\w-])/i.exec(lines[0]!)?.[1]
  if (verdict === undefined) return undefined

  return /^no/i.test(verdict) ? 'no-go' : 'go'
}

/**
 * The stored review that can stand for a commit in a later task: it returned, its advice was verified as a pass,
 * and its recommendation is GO. A NO-GO for the same commit outranks any GO. Nothing else is eligible: not a review
 * that has only returned, not a failed or pending verification, not a record from before outcomes were kept.
 */
export const releaseEligible = (history: readonly ReleaseRecord[], sha: string): ReleaseRecord | undefined => {
  const mine = history.filter(h => h.candidate === sha && h.returned && h.verified === 'pass')
  if (mine.some(h => h.outcome === 'no-go')) return undefined

  return mine.filter(h => h.outcome === 'go').at(-1)
}

/**
 * The review after the main session judged one consultation's advice. The only place a ground is cleared, and only by
 * a consultation of that very ground. A release ground is cleared only by a verified pass whose recommendation is GO
 * for the commit the consultation was admitted for, while that commit is still the clean one (`now`); every other
 * outcome leaves it uncleared. The review is adjudicated when all of its grounds are cleared.
 */
export const clearReview = (review: ReviewRequirement | undefined, c: Consultation, state: 'pass' | 'fail', outcome: ReleaseOutcome | undefined, now: string | null): ReviewRequirement | undefined => {
  if (review === undefined || !review.grounds.includes(c.ground)) return review
  const mine = review.consult === c.id
  const entry: ClearedGround | undefined = c.ground !== 'release'
    ? { ground: c.ground, consult: c.id }
    : state === 'pass' && outcome === 'go' && c.candidate !== undefined && c.candidate === now ? { ground: 'release', consult: c.id, candidate: c.candidate } : undefined
  if (entry === undefined) return mine ? { ...review, consult: null, state: review.state === 'admitted' ? 'required' : review.state } : review
  const cleared = [...(review.cleared ?? []).filter(x => x.ground !== c.ground), entry]
  const base: ReviewRequirement = { ...review, cleared, ...(entry.candidate === undefined ? {} : { candidate: entry.candidate }) }
  if (review.grounds.every(g => cleared.some(x => x.ground === g))) return { ...base, consult: c.id, state: 'adjudicated' }

  return { ...base, consult: mine ? null : review.consult, state: mine || review.state === 'adjudicated' ? 'required' : review.state }
}

/** What git says about the working tree: a clean commit, a real difference, or no answer. */
export type GitCandidate = { sha: string } | { sha: null; why: 'dirty' | 'unknown' }

/**
 * A review's release ground against what git now says. Cleared for a commit that has moved or a tree that has changed:
 * withdrawn. Not cleared, and git names the clean commit of an eligible stored review: cleared again, marked reused.
 * Git not answering is neither: a held approval is kept (nothing shows it moved), none is granted or restored, and the
 * stored records are never touched. An approval with no commit behind it (stored before v0.5.1) does not stand.
 */
export const revalidateRelease = (review: ReviewRequirement, now: GitCandidate, history: readonly ReleaseRecord[]): ReviewRequirement => {
  if (!review.grounds.includes('release')) return review
  const held = review.cleared?.find(x => x.ground === 'release')
  const open = review.state !== 'adjudicated'
  const { candidate: _gone, ...rest } = review
  if (held === undefined && review.state === 'adjudicated') return { ...rest, cleared: (review.cleared ?? []).filter(x => x.ground !== 'release'), consult: null, state: 'required' }
  if (held !== undefined) {
    if (now.sha === held.candidate || (now.sha === null && now.why === 'unknown')) return review

    return { ...rest, cleared: (review.cleared ?? []).filter(x => x.ground !== 'release'), consult: open ? review.consult : null, state: open ? review.state : 'required' }
  }
  if (now.sha === null) return review
  const record = releaseEligible(history, now.sha)
  if (record === undefined) return review
  const cleared = [...(review.cleared ?? []), { ground: 'release' as const, consult: record.id, candidate: now.sha, reused: true as const }]
  const base: ReviewRequirement = { ...review, cleared, candidate: now.sha }

  return review.grounds.every(g => cleared.some(x => x.ground === g)) ? { ...base, consult: record.id, state: 'adjudicated' } : base
}

/**
 * The task with the review it now requires. Grounds only accumulate within a
 * task; a ground kind that appears after the review was adjudicated reopens
 * it, because that review never saw the change that raised it.
 */
export const requireReview = (task: Task, grounds: readonly ConsultGround[]): Task => {
  if (grounds.length === 0) return task
  const had = task.review
  const merged = [...new Set([...(had?.grounds ?? []), ...grounds])]
  if (had === undefined) return { ...task, review: { grounds: merged, consult: null, state: 'required' } }
  const isNew = merged.length > had.grounds.length
  if (!isNew) return task

  return { ...task, review: had.state === 'adjudicated' ? { grounds: merged, consult: null, state: 'required' } : { ...had, grounds: merged } }
}

/** The review moved on by what happened to its consultation. */
export const advanceReview = (review: ReviewRequirement | undefined, consultId: string, step: 'admitted' | 'returned' | 'adjudicated'): ReviewRequirement | undefined => {
  if (review === undefined) return undefined
  if (step === 'admitted') {
    if (review.state === 'adjudicated') return review
    // a commit is carried only by a cleared release ground, never by an attempt: nothing stale rides along
    const { candidate: _stale, ...rest } = review
    const held = review.cleared?.find(x => x.ground === 'release')?.candidate

    return { ...rest, ...(held === undefined ? {} : { candidate: held }), consult: consultId, state: 'admitted' }
  }
  if (review.consult !== consultId) return review

  return { ...review, state: step }
}

/** The brief an Opus consultation receives: the packet and the shape of the answer, nothing else. */
export const briefOf = (c: Consultation): string => {
  const p = c.packet
  const list = (items: readonly string[]) => (items.length === 0 ? '  (none given)' : items.map(i => `  - ${i}`).join('\n'))

  return [
    `[task:${c.id}] Opus consultation · ground ${c.ground}${c.isMandatory ? ' · mandatory' : ''}`,
    '',
    ...(c.candidate === undefined ? [] : [`CANDIDATE COMMIT\n  ${c.candidate} (a clean working tree at exactly this commit; review this commit, not a branch or a later one)`]),
    `OBJECTIVE\n  ${p.objective}`,
    `CURRENT ARCHITECTURE\n  ${p.architecture || '(not stated)'}`,
    `RELEVANT FILES\n${list(p.files)}`,
    `ALTERNATIVES CONSIDERED OR TRIED\n${list(p.alternatives)}`,
    `FAILURES\n${list(p.failures)}`,
    `RISK\n  ${p.risk}`,
    `DECISION REQUESTED\n  ${p.decision}`,
    '',
    'Answer with: DECISION (one line), RATIONALE, PLAN or FINDINGS (ordered, path:line where it applies), RISKS, and VERIFICATION (the checks Sonnet must run to confirm it). Do not implement; Sonnet implements and verifies.',
    ...(c.ground === 'release' ? ['', 'The DECISION line is read by machine: write exactly one line, "DECISION: GO" or "DECISION: NO-GO", and no other line that starts with DECISION. GO only if no critical or high finding remains. State which files you could and could not read.'] : []),
  ].join('\n')
}

/** One line for a consultation, as the HUD and the ledger show it. */
export const consultLine = (c: Consultation, swarm: Swarm): string => {
  const t = taskOf(swarm, c.id)
  const status = statusOf(t)
  const verified = t?.verification ?? 'unknown'

  return `${c.id} ${c.ground.toUpperCase()}${c.isMandatory ? '*' : ''} · ${status}${status === 'returned' ? ` · verified ${verified}` : ''}`
}
