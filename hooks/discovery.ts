// Adaptive discovery (v0.5.1): how much understanding a task warrants before it
// is built, what the model reported finding, the decisions it reported, and
// whether the finished work was checked against the original request.
//
// Pure functions over plain data, like model.ts. Nothing here calls a model,
// reads a clock or touches `$`. The level comes from conservative deterministic
// rules over evidence the host already has; a router may advise elsewhere but
// cannot lower a level, skip a gate or waive a consultation. Everything the
// model reports (criteria, unknowns, decisions, evidence) is stored as
// reported, redacted and clipped, and never completed on its behalf.

import type { Alignment, AlignmentState, ConsultGround, Criterion, CriterionStatus, DecisionRecord, Discovery, DiscoveryLevel, Task, TaskKind, UnknownItem } from '../types'
import { groundsAvailable } from './consult'
import { redactSecrets } from './secrets'

export const LEVELS: readonly DiscoveryLevel[] = ['LIGHT', 'STANDARD', 'DEEP']
export const MAX_CRITERIA = 8
export const MAX_UNKNOWNS = 8
export const MAX_RISKS = 6
export const MAX_DECISIONS = 12
export const MAX_ALTERNATIVES = 4
export const MAX_EVIDENCE = 4
export const MAX_REASONS = 6

/** Redacted before it is stored anywhere, not only when it is exported. */
export const clip = (text: unknown, max: number): string => {
  const line = typeof text === 'string' ? redactSecrets(text).replace(/\s+/g, ' ').trim() : ''

  return line.length > max ? `${line.slice(0, Math.max(0, max - 1))}…` : line
}
const list = (items: unknown, max: number, each: number): string[] =>
  (Array.isArray(items) ? items : []).map(one => clip(one, each)).filter(Boolean).slice(0, max)

export type Change = { task: Task; error?: string; note?: string }

// --- the level -------------------------------------------------------------

const DEEP_RE = /\b(migrat\w*|schema|auth(?:entication|orization|n|z)?|oauth|passwords?|payments?|billing|checkout|refunds?|encrypt\w*|crypto\w*|concurren\w*|race conditions?|deadlocks?|transactions?|data (?:integrity|loss|corruption)|roll-?back|multi-?tenant|permissions?|re-?architect\w*|architect\w*|rewrite)\b/i
const TRIVIAL_RE = /\b(typo|spelling|rename|label|wording|copy|colou?r|css|padding|margin|font|comment|one[- ]line|whitespace|indent\w*|bump)\b/i
const BROAD_RE = /\b(all|every|each|across|throughout|multiple|several|everywhere|feature|refactor\w*|support|integrat\w*)\b/i
const QUESTION_RE = /^\s*(?:what|why|how|where|which|who|when|explain|describe|show|list|summari[sz]e|is there|does|do you)\b/i
const BUILD_RE = /\b(implement\w*|add|build|create|introduce|develop|enable|port|integrat\w*|migrat\w*)\b/i
const ACTION_RE = /\b(implement\w*|add|build|create|fix\w*|debug\w*|refactor\w*|migrat\w*|change|update|support|integrat\w*|write|remove|delete|replace|convert|port|extend|improve|optimi[sz]e|rename|make|re-?design\w*|restructure|overhaul|develop|wire|introduce|enable|handle)\b/i

export const FILES_STANDARD = 3

export type DiscoveryFacts = {
  prompt: string
  files: readonly string[]
  milestones: number
  grounds: readonly ConsultGround[]
}

const rank = (level: DiscoveryLevel): number => LEVELS.indexOf(level)

/** The level the evidence supports, and why in short codes. Escalation only; the caller never lowers it. */
export const classify = (facts: DiscoveryFacts): { level: DiscoveryLevel; reasons: string[] } => {
  const reasons: string[] = []
  let level = 'LIGHT' as DiscoveryLevel
  const raise = (to: DiscoveryLevel, why: string) => { if (rank(to) > rank(level)) level = to; reasons.push(why) }

  // the grounds the consultation policy itself reads, from the prompt and the files touched
  const grounds = groundsAvailable({ prompt: facts.prompt, files: facts.files, milestones: facts.milestones, errorStreak: 0, promptGrounds: facts.grounds })
  for (const ground of grounds) if (ground === 'architecture' || ground === 'security') raise('DEEP', `ground:${ground}`)
  if (DEEP_RE.test(facts.prompt)) raise('DEEP', 'high-risk-term')
  if (level !== 'DEEP') {
    const words = facts.prompt.trim().split(/\s+/).filter(Boolean).length
    // a question or a trivial-looking noun keeps a task LIGHT only when nothing in it asks for something to be built
    if (QUESTION_RE.test(facts.prompt) && !BUILD_RE.test(facts.prompt)) reasons.push('question')
    else if (TRIVIAL_RE.test(facts.prompt) && !BUILD_RE.test(facts.prompt) && words <= 25 && !BROAD_RE.test(facts.prompt)) reasons.push('trivial-shape')
    else if (ACTION_RE.test(facts.prompt)) raise('STANDARD', 'change-request')
    else reasons.push('no-change-requested')
  }
  if (level !== 'DEEP' && facts.files.length >= FILES_STANDARD) raise('STANDARD', `files:${facts.files.length}`)

  return { level, reasons: [...new Set(reasons)].slice(0, MAX_REASONS) }
}

const factsOf = (task: Task): DiscoveryFacts => ({
  prompt: task.lastPrompt,
  files: task.files.map(f => f.path),
  milestones: task.milestones.length,
  grounds: task.promptGrounds ?? [],
})

/**
 * Sets or raises a task's discovery level from the evidence at hand. A level the
 * operator pinned is kept; any other only goes up. `facts` may carry the full
 * prompt (the stored one is clipped) and the grounds the router-independent
 * consultation policy already derived.
 */
export const withDiscovery = (task: Task, override: DiscoveryLevel | null, facts: DiscoveryFacts = factsOf(task)): Task => {
  const held = task.discovery
  if (override !== null) {
    if (held?.source === 'operator' && held.level === override) return task

    const floor = held === undefined ? undefined : held.source === 'auto' ? held.level : held.floor
    const pinned: Task = { ...task, discovery: { ...(held ?? blank(override)), level: override, source: 'operator', reasons: ['operator'], ...(floor === undefined ? {} : { floor }) } }

    return held !== undefined && rank(override) > rank(held.level) ? invalidateAlignment(pinned, 'level raised') : pinned
  }
  if (held?.source === 'operator') return task
  const found = classify(facts)
  if (held === undefined) return { ...task, discovery: { ...blank(found.level), reasons: found.reasons } }
  if (rank(found.level) <= rank(held.level)) return task

  // a higher level asks more of the goal check than the one it was made under
  return invalidateAlignment({ ...task, discovery: { ...held, level: found.level, reasons: [...new Set([...found.reasons, ...held.reasons])].slice(0, MAX_REASONS) } }, 'level raised')
}

/** Gives the level back to the deterministic rules: the person's pin ends and the evidence decides again. */
export const unpin = (task: Task, facts: DiscoveryFacts = factsOf(task)): Task => {
  if (task.discovery === undefined) return withDiscovery(task, null, facts)
  const found = classify(facts)
  const level = task.discovery.floor !== undefined && rank(task.discovery.floor) > rank(found.level) ? task.discovery.floor : found.level
  const { floor: _kept, ...rest } = task.discovery

  return { ...task, discovery: { ...rest, level, source: 'auto', reasons: level === found.level ? found.reasons : [...found.reasons, 'earlier-level'].slice(0, MAX_REASONS) } }
}

const blank = (level: DiscoveryLevel): Discovery => ({ level, source: 'auto', reasons: [], objective: null, criteria: [], unknowns: [], risks: [], guided: null })

export const levelOf = (task: Task | null): DiscoveryLevel | null => task?.discovery?.level ?? null

// --- prompt guidance -------------------------------------------------------

const STANDARD_LINE = 'Cobalt Cockpit discovery (STANDARD): before editing, state the objective and acceptance criteria with progress action "discover", naming only unknowns that would change the implementation. Ask the user only if no safe, reversible assumption exists. Record consequential choices with action "decide". Before DONE, check the result against the original request with action "align".'
const DEEP_LINE = 'Cobalt Cockpit discovery (DEEP, high-risk): before editing, establish the existing architecture, then record with progress action "discover" the objective, acceptance criteria, the unknowns and only the risk categories that apply (compatibility, rollback, security, data integrity, concurrency, performance, edge cases, test gaps). Compare viable approaches and record the choice and rejected alternatives with action "decide". Any Opus consultation still goes through swarm action "consult". Before DONE, check the result against the original request with action "align".'

/** Guidance for the prompt that starts or escalates a task; null for LIGHT and once given for the level. */
export const guidanceFor = (task: Task): string | null => {
  const d = task.discovery
  if (d === undefined || d.level === 'LIGHT' || d.guided === d.level) return null

  return d.level === 'DEEP' ? DEEP_LINE : STANDARD_LINE
}

export const markGuided = (task: Task): Task =>
  task.discovery === undefined ? task : { ...task, discovery: { ...task.discovery, guided: task.discovery.level } }

// --- the `discover` action -------------------------------------------------

/**
 * Folds the field names a model plausibly reaches for into the documented ones: `objective` for `goal`,
 * `acceptance` for `criteria`, top-level `state`/`evidence`/`missing` for `alignment`, and top-level
 * `problem`/`chosen`/`alternatives` for `decision`. Only names are mapped; no value is made up, so every
 * rule about evidence and reasons applies as before.
 */
export const foldAliases = <T extends Record<string, unknown>>(input: T): T => {
  const out: Record<string, unknown> = { ...input }
  if (out['action'] === 'gates') out['action'] = 'gate'
  if (out['action'] === 'discover' && out['goal'] === undefined && typeof out['objective'] === 'string') out['goal'] = out['objective']
  if (out['criteria'] === undefined && Array.isArray(out['acceptance'])) out['criteria'] = out['acceptance']
  if (out['action'] === 'align' && (out['alignment'] === undefined || typeof out['alignment'] !== 'object') && typeof out['state'] === 'string') {
    const evidence = typeof out['evidence'] === 'string' ? out['evidence'] : undefined
    out['alignment'] = { state: out['state'], ...(evidence === undefined ? {} : { demonstrated: [{ id: 'e1', evidence }] }), missing: out['missing'], assumptions: out['assumptions'], note: out['note'] }
  }
  if (out['action'] === 'align' && out['alignment'] !== null && typeof out['alignment'] === 'object') {
    const a = out['alignment'] as Record<string, unknown>
    if (a['demonstrated'] === undefined && typeof a['evidence'] === 'string') out['alignment'] = { ...a, demonstrated: [{ id: 'e1', evidence: a['evidence'] }] }
  }
  if (out['action'] === 'decide' && (out['decision'] === undefined || typeof out['decision'] !== 'object') && (out['problem'] !== undefined || out['chosen'] !== undefined)) {
    out['decision'] = { problem: out['problem'], chosen: out['chosen'], alternatives: out['alternatives'], tradeoffs: out['tradeoffs'], evidence: out['evidence'], status: out['status'], id: out['id'] }
  }

  return out as T
}

// --- acceptance criteria and their evidence --------------------------------

const GENERIC = /^(?:all |the )?(?:tests? |it |this |that |everything )?(?:pass(?:es|ed)?|works?|working|ok(?:ay)?|done|good|fine|verified|complete[d]?|implemented|correct|looks good|lgtm|as expected|all good|success(?:ful)?)\W*$/i

/** A criterion must say something checkable: at least ten characters and two words, and not a bare verdict. */
export const criterionProblem = (text: string): string | null =>
  text.length < 10 || text.split(/\s+/).length < 2 || GENERIC.test(text) ? 'too short or generic to be checked' : null

const normal = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * Evidence must name something that was observed: a file, a quoted test or output, a command, or a
 * figure, and must not be a bare verdict or the criterion restated. This checks the form of what was
 * reported. It cannot check that the report is true.
 */
export const evidenceProblem = (evidence: string, criterion: string): string | null => {
  if (evidence.length < 20) return 'is too short to show what was observed'
  if (GENERIC.test(evidence)) return 'is a bare verdict, not an observation'
  if (!/[`'"][^`'"]{3,}[`'"]|\b[\w./-]+\.[a-z]{1,5}\b|\d/.test(evidence)) return 'names no file, test, command, output or figure'
  if (normal(evidence) === normal(criterion)) return 'only restates the criterion'

  return null
}

const unevaluated = (c: Criterion): Criterion => (c.status === undefined || c.status === 'pending') && !c.evidence ? c : { id: c.id, text: c.text, status: 'pending', evidence: null }

/** Evidence gathered before a change is not evidence of what exists after it. */
export const resetCriteria = (task: Task): Task => {
  const d = task.discovery
  if (d === undefined || d.criteria.every(c => unevaluated(c) === c)) return task

  return { ...task, discovery: { ...d, criteria: d.criteria.map(unevaluated) } }
}

/** A task that must be goal-checked and has no criterion to check it against. */
export const criteriaMissing = (task: Task): boolean => needsAlignment(task) && (task.discovery?.criteria.length ?? 0) === 0

/** The state shown for the goal check: BLOCKED while there is nothing to check against. */
export const alignmentShown = (task: Task): string => (criteriaMissing(task) ? 'BLOCKED' : task.alignment?.state ?? 'PENDING')

export type DiscoverInput = { goal?: unknown; level?: unknown; criteria?: unknown; unknowns?: unknown; risks?: unknown }

const unknownRow = (raw: unknown): { id?: string; text?: string; state?: UnknownItem['state']; note?: string | null } => {
  const row = (raw !== null && typeof raw === 'object' ? raw : { text: raw }) as Record<string, unknown>
  const state = row['state'] === 'resolved' || row['state'] === 'assumed' || row['state'] === 'open' ? row['state'] : undefined
  const text = clip(row['text'], 120)
  const note = clip(row['note'], 120)

  return { ...(typeof row['id'] === 'string' ? { id: row['id'].trim() } : {}), ...(text ? { text } : {}), ...(state ? { state } : {}), ...(note ? { note } : {}) }
}

export const discover = (task: Task, input: DiscoverInput, now: number): Change => {
  const base = task.discovery ?? withDiscovery(task, null).discovery!
  let d: Discovery = { ...base }
  const goal = clip(input.goal, 160)
  if (goal) d = { ...d, objective: goal }
  if (typeof input.level === 'string' && (LEVELS as readonly string[]).includes(input.level.toUpperCase()) && d.source !== 'operator') {
    const asked = input.level.toUpperCase() as DiscoveryLevel
    if (rank(asked) > rank(d.level)) d = { ...d, level: asked, reasons: [...new Set([...d.reasons, 'model-raised'])].slice(0, MAX_REASONS) }
  }
  let criteria = d.criteria
  let revised = false
  const offered = (Array.isArray(input.criteria) ? input.criteria : []).slice(0, MAX_CRITERIA).map(one => {
    const row = (one !== null && typeof one === 'object' ? one : { text: one }) as Record<string, unknown>

    return { id: typeof row['id'] === 'string' ? row['id'].trim() : undefined, text: clip(row['text'], 120) }
  })
  for (const one of offered) {
    const why = criterionProblem(one.text)
    if (why !== null) return { task, error: `criterion ${JSON.stringify(one.text.slice(0, 40))} is ${why}: say what can be observed. Nothing was recorded` }
  }
  for (const one of offered) {
    const known = one.id === undefined ? undefined : criteria.find(c => c.id === one.id)
    if (known !== undefined) {
      if (known.text !== one.text) { criteria = criteria.map(c => c.id === known.id ? { id: c.id, text: one.text, status: 'pending' as const, evidence: null } : c); revised = true }
    } else if (criteria.length < MAX_CRITERIA && !criteria.some(c => normal(c.text) === normal(one.text))) {
      criteria = [...criteria, { id: `c${criteria.length + 1}`, text: one.text, status: 'pending' as const, evidence: null }]
    }
  }
  let unknowns = d.unknowns
  for (const row of (Array.isArray(input.unknowns) ? input.unknowns : []).slice(0, MAX_UNKNOWNS).map(unknownRow)) {
    const known = row.id === undefined ? undefined : unknowns.find(u => u.id === row.id)
    if (known !== undefined) {
      unknowns = unknowns.map(u => u.id === known.id ? { ...u, ...(row.state ? { state: row.state } : {}), ...(row.note !== undefined ? { note: row.note } : {}), ...(row.text ? { text: row.text } : {}) } : u)
    } else if (row.text !== undefined && unknowns.length < MAX_UNKNOWNS && !unknowns.some(u => u.text === row.text)) {
      unknowns = [...unknowns, { id: `u${unknowns.length + 1}`, text: row.text, state: row.state ?? 'open', note: row.note ?? null }]
    }
  }
  const risks = [...new Set([...d.risks, ...list(input.risks, MAX_RISKS, 40)])].slice(0, MAX_RISKS)
  const next: Task = { ...task, discovery: { ...d, criteria, unknowns, risks }, updatedAt: now }
  // A criterion added after alignment was claimed is one it did not check.
  const reopened = unknowns.filter(u => u.state === 'open').length > base.unknowns.filter(u => u.state === 'open').length
  const settled = criteria.length > base.criteria.length || revised || reopened || rank(d.level) > rank(base.level) ? invalidateAlignment(next, 'criteria or unknowns changed') : next
  // The ids are what `align` answers to, so they are told back here.
  const note = criteria.length === 0 ? undefined : `Criteria: ${criteria.map(c => `${c.id} ${c.text.slice(0, 50)}`).join('; ')}. Evaluate each by id in align.demonstrated, with the evidence you observed.`

  return { task: settled, ...(note === undefined ? {} : { note }) }
}

// --- decision records ------------------------------------------------------

export type DecideInput = { decision?: unknown }

const STATUSES = ['provisional', 'verified', 'revised'] as const

/**
 * Records, or revises by id, one decision the model reported. Alternatives need
 * the reason they were rejected and a `verified` decision needs evidence: both
 * are refused rather than filled in.
 */
export const decide = (task: Task, input: DecideInput, now: number): Change => {
  const raw = (input.decision !== null && typeof input.decision === 'object' ? input.decision : {}) as Record<string, unknown>
  const problem = clip(raw['problem'], 160)
  const chosen = clip(raw['chosen'], 200)
  if (!problem || !chosen) return { task, error: 'a decision needs "problem" and "chosen"; nothing was recorded' }
  const alternatives: DecisionRecord['alternatives'] = []
  for (const one of (Array.isArray(raw['alternatives']) ? raw['alternatives'] : []).slice(0, MAX_ALTERNATIVES)) {
    const row = (one !== null && typeof one === 'object' ? one : {}) as Record<string, unknown>
    const option = clip(row['option'], 120)
    const rejectedBecause = clip(row['rejected_because'], 160)
    if (!option || !rejectedBecause) return { task, error: 'each alternative needs "option" and "rejected_because"; omit an alternative you did not actually weigh. Nothing was recorded' }
    alternatives.push({ option, rejectedBecause })
  }
  const evidence = list(raw['evidence'], MAX_EVIDENCE, 120)
  const held = task.decisions ?? []
  const id = typeof raw['id'] === 'string' && /^d\d{1,3}$/.test(raw['id'].trim()) ? raw['id'].trim() : undefined
  const before = id === undefined ? undefined : held.find(d => d.id === id)
  const named = typeof raw['status'] === 'string' && (STATUSES as readonly string[]).includes(raw['status']) ? raw['status'] as DecisionRecord['status'] : undefined
  const status = named ?? (before !== undefined && before.chosen !== chosen ? 'revised' : before?.status ?? 'provisional')
  if (status === 'verified' && evidence.length === 0) return { task, error: 'a "verified" decision needs "evidence"; record it as provisional until there is some. Nothing was recorded' }
  const tradeoffs = clip(raw['tradeoffs'], 200)
  const record: DecisionRecord = {
    id: before?.id ?? `d${Math.max(0, ...held.map(d => Number(d.id.slice(1)))) + 1}`,
    taskId: task.id,
    problem,
    chosen,
    alternatives,
    tradeoffs: tradeoffs || null,
    evidence,
    status,
    at: now,
  }
  const decisions = [...held.filter(d => d.id !== record.id), record].slice(-MAX_DECISIONS)

  return { task: { ...task, decisions, updatedAt: now } }
}

// --- original-goal alignment ----------------------------------------------

export const ALIGNMENT_STATES: readonly AlignmentState[] = ['ALIGNED', 'PARTIAL', 'BLOCKED', 'UNKNOWN']

/** A coding task above LIGHT is not done until its result was checked against the request. */
// a plan declared read-only that went on to edit files is coding work for this purpose
export const needsAlignment = (task: Task): boolean => (task.kind === 'coding' || task.files.length > 0 || task.edited === true) && task.discovery !== undefined && task.discovery.level !== 'LIGHT'

/**
 * The completion rule, stated here and not only at `align`: a goal-checked task is satisfied only when it has
 * criteria, every one is met with evidence recorded for it, and the check itself says ALIGNED. An empty set of
 * criteria is never "all met".
 */
export const isAlignmentSatisfied = (task: Task): boolean => {
  if (!needsAlignment(task)) return true
  const criteria = task.discovery?.criteria ?? []

  return criteria.length > 0 && criteria.every(c => c.status === 'met' && !!c.evidence) && task.alignment?.state === 'ALIGNED'
}

export const alignmentNote = (task: Task): string =>
  criteriaMissing(task) ? 'CRITERIA MISSING (record acceptance criteria with action "discover"); goal alignment BLOCKED' : `goal alignment ${task.alignment?.state ?? 'PENDING'}`

/** Work or criteria changed after the check: what it vouched for is no longer what exists. */
export const invalidateAlignment = (task: Task, why: string): Task => {
  const cleared = resetCriteria(task)

  return cleared.alignment === undefined || cleared.alignment.state === 'PENDING' ? cleared : { ...cleared, alignment: { ...cleared.alignment, state: 'PENDING', note: clip(`reset: ${why}`, 120) } }
}

export type AlignInput = { alignment?: unknown }

/**
 * Records the original-goal check. For work above LIGHT, ALIGNED is refused (and a claim of it without criteria
 * is recorded as BLOCKED) unless: acceptance criteria exist; every one has its own entry, marked met, with
 * evidence that names an observation and is not shared with another criterion; nothing is reported missing; no
 * unknown is open; every milestone before verification is done; there is no blocker; and every required gate
 * passes. Passing tests are one of those conditions, never the whole. Evidence is what the model reported:
 * its form is checked here, its truth is not.
 */
export const align = (task: Task, input: AlignInput, now: number, open: readonly string[]): Change => {
  const raw = (input.alignment !== null && typeof input.alignment === 'object' ? input.alignment : {}) as Record<string, unknown>
  const state = typeof raw['state'] === 'string' ? raw['state'].toUpperCase() as AlignmentState : undefined
  if (state === undefined || !(ALIGNMENT_STATES as readonly string[]).includes(state)) return { task, error: '"alignment.state" must be ALIGNED, PARTIAL, BLOCKED or UNKNOWN' }
  const declared = task.discovery?.criteria ?? []
  const idOf = (row: Record<string, unknown>, n: number): string => {
    const named = typeof row['id'] === 'string' ? row['id'].trim() : ''
    if (declared.some(c => c.id === named)) return named
    // a model that restates the criterion instead of quoting its id still points at one
    const byText = [row['criterion'], row['text'], named].map(t => (typeof t === 'string' ? normal(t) : '')).find(t => t !== '' && declared.some(c => normal(c.text) === t))
    if (byText !== undefined) return declared.find(c => normal(c.text) === byText)!.id

    return /^[A-Za-z0-9]{1,8}$/.test(named) ? named : `e${n + 1}`
  }
  const demonstrated: Alignment['demonstrated'] = []
  for (const [n, one] of (Array.isArray(raw['demonstrated']) ? raw['demonstrated'] : []).slice(0, MAX_CRITERIA).entries()) {
    const row = (one !== null && typeof one === 'object' ? one : {}) as Record<string, unknown>
    const evidence = clip(row['evidence'], 160)
    if (!evidence) return { task, error: 'each "demonstrated" entry needs "evidence": the check that showed it. Nothing was recorded' }
    const status: CriterionStatus = row['status'] === 'failed' || row['status'] === 'unresolved' ? row['status'] : 'met'
    demonstrated.push({ id: idOf(row, n), evidence, status })
  }
  const missing = list(raw['missing'], MAX_CRITERIA, 120)
  const assumptions = list(raw['assumptions'], MAX_CRITERIA, 120)
  const note = clip(raw['note'], 160)
  const strict = task.discovery !== undefined && task.discovery.level !== 'LIGHT'
  let recorded: AlignmentState = state
  let say: string | undefined
  if (state === 'ALIGNED') {
    const problems: string[] = []
    if (task.milestones.length === 0) problems.push('no plan exists yet, so nothing was built to check')
    if (strict && declared.length === 0) {
      // Nothing to check against: the claim is recorded as BLOCKED, never accepted and never silently dropped.
      recorded = 'BLOCKED'
      say = 'CRITERIA MISSING: no acceptance criteria were recorded, so ALIGNED cannot be established. Alignment is BLOCKED. Record criteria with action "discover" (criteria), then evaluate each by id in align.demonstrated.'
    } else if (strict) {
      const seen = new Set<string>()
      for (const c of declared) {
        const entries = demonstrated.filter(d => d.id === c.id)
        const mine = entries[entries.length - 1]
        if (mine === undefined) { problems.push(`criterion ${c.id} (${c.text.slice(0, 40)}) has no evaluation under id "${c.id}"`); continue }
        if (mine.status !== 'met') { problems.push(`criterion ${c.id} is ${mine.status}`); continue }
        const why = evidenceProblem(mine.evidence, c.text)
        if (why !== null) { problems.push(`criterion ${c.id} evidence ${why}`); continue }
        const key = normal(mine.evidence)
        if (seen.has(key)) problems.push(`criterion ${c.id} reuses another criterion's evidence`)
        seen.add(key)
      }
    }
    if (recorded === 'ALIGNED') {
      if (missing.length > 0) problems.push(`${missing.length} requirement(s) reported missing`)
      const unknowns = (task.discovery?.unknowns ?? []).filter(u => u.state === 'open')
      if (unknowns.length > 0) problems.push(`${unknowns.length} unknown(s) still open`)
      if (task.blocker !== null) problems.push('the task is blocked')
      const unfinished = task.milestones.filter(m => m.phase !== 'VERIFY' && m.state !== 'done')
      if (unfinished.length > 0) problems.push(`milestone(s) ${unfinished.map(m => m.id).join(', ')} not complete`)
      if (open.length > 0) problems.push(`gate(s) ${open.join(', ')} not satisfied`)
      if (problems.length > 0) return { task, error: `ALIGNED refused: ${problems.join('; ')}. Report PARTIAL, BLOCKED or UNKNOWN, or finish the work and report the evidence. Nothing was recorded` }
    }
  }
  const criteria = declared.map(c => {
    const mine = demonstrated.filter(d => d.id === c.id).pop()

    return mine === undefined ? c : { id: c.id, text: c.text, status: mine.status ?? 'met', evidence: mine.evidence, basis: 'reported' as const }
  })
  // a claim that was not accepted leaves no criterion looking met
  const evaluated: Criterion[] = recorded === 'ALIGNED' ? criteria : criteria.map(c => (c.status === 'met' && state === 'ALIGNED' ? { ...c, status: 'unresolved' as const } : c))
  const alignment: Alignment = { state: recorded, demonstrated, missing, assumptions, note: (say === undefined ? note : 'criteria missing') || null, at: now }
  const next: Task = { ...task, alignment, ...(task.discovery === undefined ? {} : { discovery: { ...task.discovery, criteria: evaluated } }), updatedAt: now }

  return { task: next, ...(say === undefined ? {} : { note: say }) }
}

// --- presentation ----------------------------------------------------------

const fit = (line: string, width: number): string => (line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line)

/** One compact line for the progress tool and `/cockpit status`; empty for LIGHT and for tasks stored before v0.5.1. */
export const discoverySummary = (task: Task): string => {
  const d = task.discovery
  if (d === undefined || d.level === 'LIGHT') return ''
  const open = d.unknowns.filter(u => u.state === 'open').length

  return ` Discovery ${d.level}: ${open} unknown${open === 1 ? '' : 's'} open, ${(task.decisions ?? []).length} decision${(task.decisions ?? []).length === 1 ? '' : 's'}, alignment ${needsAlignment(task) ? alignmentShown(task) : task.kind === 'unplanned' ? 'decided at plan' : 'not required'}${criteriaMissing(task) ? ' (criteria missing)' : ''}.`
}

/** The `/cockpit discovery` view; every row is clipped to `width` so a narrow terminal stays readable. */
export const discoveryRows = (task: Task | null, width = 72): string[] => {
  const w = Math.max(24, width)
  if (task === null) return ['COBALT / DISCOVERY', 'No task yet.']
  const d = task.discovery
  if (d === undefined) return ['COBALT / DISCOVERY', 'LEVEL / not assessed (task predates v0.5.1)']
  const open = d.unknowns.filter(u => u.state === 'open')
  const rows = [
    'COBALT / DISCOVERY',
    `LEVEL / ${d.level}${d.source === 'operator' ? ' (operator)' : ''}`,
    `GOAL / ${d.objective ?? task.goal ?? 'unknown'}`,
    `UNKNOWNS / ${open.length} unresolved`,
    `DECISIONS / ${(task.decisions ?? []).length} recorded`,
    `CRITERIA / ${d.criteria.length === 0 ? (needsAlignment(task) ? 'MISSING' : 'none') : `${d.criteria.filter(c => c.status === 'met').length} of ${d.criteria.length} met`}`,
    `ALIGNMENT / ${needsAlignment(task) ? alignmentShown(task) : 'NOT REQUIRED'}`,
    `WHY / ${d.reasons.join(', ') || 'unknown'}`,
  ]
  for (const u of open.slice(0, 4)) rows.push(`  ${u.id} ${u.text}`)
  for (const m of (task.alignment?.missing ?? []).slice(0, 4)) rows.push(`  missing ${m}`)

  return rows.map(r => fit(r, w))
}
