// The session router: an optional classifier beside Cockpit's own rules.
//
// A session runs in one of three modes, chosen by the person with
// `/cockpit router` and held in session state, never in a setting:
//
//   OFF        (every fresh session) Cockpit's deterministic policy only. No
//              router process is started.
//   NOBODYWHO  the local decision router, local provider only.
//   JEV        the same router's TypeSafe JEV provider.
//
// A router RECOMMENDS one of five routes for a new task. It starts nothing,
// admits nothing and changes no model, effort, permission or gate: the rules in
// consult.ts and swarm.ts stay authoritative, and `adjudicate` below is where a
// recommendation is accepted or refused against them.
//
// This module is pure. It builds the question, reads the answer and judges it;
// the one process call lives in register.tsx.

import { affirmed, groundsAvailable, mandatoryGrounds } from './consult'
import type { ConsultFacts } from './consult'
import type { ActiveMode, ConsultGround, Route, RouterDecision, RouterMode, RouterState } from '../types'
export type { ActiveMode, Route, RouterDecision, RouterMode, RouterState } from '../types'

export const ROUTER_MODES: readonly RouterMode[] = ['OFF', 'NOBODYWHO', 'JEV']
export const DEFAULT_ROUTER: RouterMode = 'OFF'

/** The mode a word names (`off`, `NobodyWho`, `nwho`, `jev`), or null. */
export const routerModeOf = (word: string): RouterMode | null => {
  const w = word.trim().toLowerCase()
  if (w === 'off' || w === 'none' || w === 'deterministic') return 'OFF'
  if (w === 'nobodywho' || w === 'nwho' || w === 'local') return 'NOBODYWHO'
  if (w === 'jev') return 'JEV'

  return null
}

export const ROUTES: readonly Route[] = ['direct', 'scout', 'delegate', 'effort', 'opus']
export const isRoute = (value: unknown): value is Route => typeof value === 'string' && (ROUTES as readonly string[]).includes(value)

/** What each route asks of the main session, as it is said to it. */
export const ROUTE_ADVICE: Record<Route, string> = {
  direct: 'handle it directly in the main session',
  scout: 'ask a Haiku scout to search or inventory first',
  delegate: 'delegate the independent bounded parts to Sonnet workers',
  effort: 'consider a higher-effort attempt (the effort is yours to set: /effort)',
  opus: 'consider an Opus consultation (swarm action consult, on a ground that holds)',
}

/** The fixed task features a route is read from, in the order they decide it. */
export type Feature = 'security' | 'architecture' | 'difficult' | 'discovery' | 'parallel'
export const FEATURES: readonly Feature[] = ['security', 'architecture', 'difficult', 'discovery', 'parallel']
export type Features = Record<Feature, boolean>

const FEATURE_ROUTE: Record<Feature, Route> = { security: 'opus', architecture: 'opus', difficult: 'effort', discovery: 'scout', parallel: 'delegate' }

/** The route a set of features names: the first that holds, in FEATURES order; none is `direct`. */
export const routeOfFeatures = (features: Partial<Features>): Route => {
  for (const f of FEATURES) if (features[f] === true) return FEATURE_ROUTE[f]

  return 'direct'
}

const DIFFICULT = /\b(?:race\s+conditions?|deadlocks?|intermittent(?:ly)?|flak(?:y|iness)|heisenbug|memory\s+leaks?|leaks?|non-?determinis\w*|hangs?|sporadic(?:ally)?|occasionally|sometimes|(?:can(?:no|')t|nobody\s+can|unable\s+to)\s+reproduce|root\s+cause|debug)\b/i
const DISCOVERY = /\b(?:(?:find|list|show)\s+(?:me\s+)?(?:all|every)|every\s+place|inventory|(?:search|across|throughout|over)\s+the\s+(?:whole\s+|entire\s+)?(?:repo(?:sitory)?|codebase|project|tree)|entire\s+tree|whole\s+repo|which\s+files|who\s+calls|where\s+(?:do|does|is|are)\s+(?:we|it|the)|map\s+(?:them\s+)?(?:all\s+)?(?:out|of))\b/i
const PARALLEL = /\b(?:independent(?:ly)?|in\s+parallel|separately|unrelated|share\s+no\s+code|neither\s+touches|nothing\s+in\s+common)\b/i

/** The grounds that make the task one for Opus by Cockpit's own rules. */
const opusGrounds = (facts: ConsultFacts): ConsultGround[] => groundsAvailable(facts)

/** The features read off the prompt and the task's own facts, by rule alone. */
export const lexicalFeatures = (facts: ConsultFacts): Features => {
  const grounds = opusGrounds(facts)

  return {
    security: grounds.includes('security'),
    architecture: grounds.some(g => g === 'architecture' || g === 'asked' || g === 'release' || g === 'repeated-failure'),
    difficult: facts.errorStreak >= 2 || affirmed(facts.prompt, DIFFICULT),
    discovery: affirmed(facts.prompt, DISCOVERY),
    parallel: affirmed(facts.prompt, PARALLEL),
  }
}

/** Cockpit's own recommendation: what stands when no router is selected, or one fails. */
export const deterministicRoute = (facts: ConsultFacts): { route: Route; features: Features } => {
  const features = lexicalFeatures(facts)

  return { route: routeOfFeatures(features), features }
}

// ---------------------------------------------------------------------------
// The question. A router is never shown a list it can pick a position from
// and be believed: the local classifiers measurably follow position (see
// docs/delivery-v0.5.0-router.md), so every question is asked in both orders
// and an answer counts only when the two agree.
// ---------------------------------------------------------------------------

/** One fixed yes/no question per feature. */
export const FEATURE_QUESTION: Record<Feature, string> = {
  security: 'Does this task change authentication, permissions, secrets, cryptography or other security-sensitive behaviour?',
  architecture: 'Does this task require an architectural or cross-module design decision?',
  difficult: 'Is this a hard debugging problem with an unclear cause, such as concurrency or an intermittent failure?',
  discovery: 'Does this task first need a broad search or inventory across many files?',
  parallel: 'Does this task consist of independent parts that separate workers could complete in parallel?',
}

/** How much of the person's prompt a router is shown. */
export const TASK_MAX = 400
/** Of the five features, how many must be answered the same in both orders for a reading to count. */
export const AGREEMENT_FLOOR = 4
/** A reading that affirms more features than this is a model saying yes, not a judgement (no measured task affirmed more). */
export const AFFIRM_CAP = 3
/** A prompt this short names no task to classify (`yes`, `go on`). */
export const MIN_PROMPT = 16

// Text that looks like a credential. Deliberately broad: a prompt that matches is
// not shown to any router, and withholding one that was harmless costs nothing
// but a fallback. It is a list of shapes, not a proof: see PRIVACY.md.
const CREDENTIAL_ANY_CASE = new RegExp([
  '-----BEGIN [A-Z ]*PRIVATE KEY',
  // a name that says secret, then a value: api_key=…, SECRET_KEY: …, db-password = …, authToken=…
  '[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|passwd|pwd|credential|private[_-]?key|access[_-]?key|session[_-]?key|auth(?:orization)?)[A-Za-z0-9_.-]*["\']?\\s*[=:]\\s*["\']?[^\\s"\']{3,}',
  // said in words
  '\\b(?:password|passphrase|passcode|secret|token|api\\s+key)\\s+(?:is|was)\\s+\\S+',
  // inside a URL, on a command line, or a webhook that is itself the secret
  '\\b[a-z][a-z0-9+.-]*:\\/\\/[^\\s\\/@]*:[^\\s\\/@]+@',
  '(?:^|\\s)(?:-u|--user)\\s+\\S+:\\S+',
  'hooks\\.slack\\.com\\/services\\/',
  '\\bBearer\\s+[A-Za-z0-9._~+\\/-]{8,}',
  // well-known token prefixes
  '\\b(?:sk-|sk_live_|sk_test_|rk_live_|pk_live_|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abeprs]-|npm_|hf_)[A-Za-z0-9_-]{8,}',
  '\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+',
  // a long unbroken run of letters and digits: a key or a digest, whatever it is called
  '(?<![A-Za-z0-9+_=-])(?=[A-Za-z0-9+_=-]*[0-9])(?=[A-Za-z0-9+_=-]*[A-Za-z])[A-Za-z0-9+_=-]{32,}',
].join('|'), 'i')
const CREDENTIAL_EXACT_CASE = new RegExp([
  // a line of a pasted .env: NAME=value
  '\\b[A-Z][A-Z0-9_]{2,}=\\S{6,}',
  '\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b',
  '\\bAIza[A-Za-z0-9_-]{20,}',
  // forty characters of mixed-case base64: the shape of a cloud secret key
  '(?<![A-Za-z0-9+\\/])(?=[A-Za-z0-9+\\/]{40}(?![A-Za-z0-9+\\/]))(?=[A-Za-z0-9+\\/]*[a-z])(?=[A-Za-z0-9+\\/]*[A-Z])(?=[A-Za-z0-9+\\/]*[0-9])[A-Za-z0-9+\\/]{40}',
].join('|'))

/** Whether a prompt carries something credential-shaped, anywhere in it; such a prompt is not shown to a router. */
export const carriesCredential = (prompt: string): boolean => CREDENTIAL_ANY_CASE.test(prompt) || CREDENTIAL_EXACT_CASE.test(prompt)

/**
 * What a router is shown of a task: the person's prompt on one line, clipped.
 * Nothing else leaves: no file content, no path Cockpit observed, no history.
 * Null when the prompt names no task or carries something credential-shaped,
 * in which case no router is asked at all.
 */
export const routerStateOf = (prompt: string): string | null => {
  const line = prompt.replace(/\s+/g, ' ').trim()
  if (line.length < MIN_PROMPT || line.startsWith('/') || carriesCredential(prompt)) return null

  return `task: ${line.length > TASK_MAX ? `${line.slice(0, TASK_MAX - 1)}…` : line}`
}

export type RouterCall = { feature: Feature; swapped: boolean; body: string }

/** The ten requests of one reading: each feature, yes-first and no-first. */
export const callsFor = (state: string): RouterCall[] => FEATURES.flatMap(feature => [false, true].map(swapped => ({
  feature,
  swapped,
  body: JSON.stringify({ state, question: FEATURE_QUESTION[feature], choices: swapped ? { no: 'No', yes: 'Yes' } : { yes: 'Yes', no: 'No' }, allow_abstain: false }),
})))

/** The state of the one request that checks a provider answers at all; it carries nothing of the session. */
export const AVAILABILITY_STATE = 'task: router availability check'

/** The provider each mode's answers must come from; anything else is not that mode's answer. */
export const PROVIDER: Record<ActiveMode, string> = { NOBODYWHO: 'nobodywho', JEV: 'jev' }
/** The router's own mode flag: `local` is its local provider alone, `jev` its JEV provider alone. */
const CLI_MODE: Record<ActiveMode, string> = { NOBODYWHO: 'local', JEV: 'jev' }
/** One request may take this long before it is abandoned. The requests of a reading run together, so this is also the most a reading can delay a prompt. */
export const CALL_TIMEOUT_MS: Record<ActiveMode, number> = { NOBODYWHO: 5000, JEV: 3000 }

/** The argument array of one router request. Fixed words and one JSON body; no shell. */
export const routerArgv = (mode: ActiveMode, body: string): string[] => ['decision', 'ask', '--caller', 'cockpit', '--mode', CLI_MODE[mode], '--json', body]

/** One answer the router really gave, reduced to what is recorded. */
export type RouterAnswer = {
  requestId: string
  choice: string | null
  provider: string
  model: string | null
  latencyMs: number | null
  /** The router's own reason no choice was made (`jev_disabled`, `jev_timeout`, …), or null. */
  failure: string | null
}

const WORD = /^[A-Za-z0-9._:+-]{1,48}$/

/** An answer from `decision ask` output, only when it carries a receipt id. */
export const answerOf = (stdout: string): RouterAnswer | null => {
  let row: unknown
  try { row = JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1) ?? '') } catch { return null }
  if (row === null || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  if (typeof r['request_id'] !== 'string' || !/^[\w-]{8,64}$/.test(r['request_id'])) return null
  const d = (r['decision'] !== null && typeof r['decision'] === 'object' ? r['decision'] : {}) as Record<string, unknown>
  const word = (v: unknown): string | null => typeof v === 'string' && WORD.test(v) ? v : null
  const isAbstain = d['abstain'] === true

  return {
    requestId: r['request_id'],
    choice: isAbstain ? null : (typeof d['choice'] === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(d['choice']) ? d['choice'] : null),
    provider: word(d['provider']) ?? 'unknown',
    model: word(d['model']),
    latencyMs: typeof d['latency_ms'] === 'number' && Number.isFinite(d['latency_ms']) ? Math.round(d['latency_ms']) : null,
    failure: word(d['fallback_reason']) ?? (isAbstain ? 'abstained' : null),
  }
}

/** What ten answers amount to: the features that held in both orders, and whether enough did. */
export type Reading = {
  /** The route the agreed features name; null when the reading does not count. */
  route: Route | null
  features: Partial<Features>
  /** Features answered the same in both orders. */
  agreed: number
  /** Why the reading does not count, or null when it does. */
  invalid: string | null
}

/**
 * Reads one mode's answers. An answer counts only with a receipt, from that
 * mode's own provider, naming yes or no; a feature counts only when its two
 * orders agree. Fewer than AGREEMENT_FLOOR agreeing features is position, not
 * judgement, and more than AFFIRM_CAP affirmed is a fixed answer; either way
 * the whole reading is discarded.
 */
export const readAnswers = (mode: ActiveMode, calls: readonly RouterCall[], answers: readonly (RouterAnswer | null)[]): Reading => {
  const failure = answers.find(a => a !== null && a.failure !== null && a.failure !== 'abstained')?.failure
  const got = answers.filter(a => a !== null)
  if (got.length === 0) return { route: null, features: {}, agreed: 0, invalid: 'no answer with a receipt' }
  const foreign = got.find(a => a!.provider !== PROVIDER[mode])
  if (foreign) return { route: null, features: {}, agreed: 0, invalid: failure ?? `answered by ${foreign!.provider}, not ${PROVIDER[mode]}` }
  const features: Partial<Features> = {}
  let agreed = 0
  for (const feature of FEATURES) {
    const pair = calls.map((c, i) => c.feature === feature ? answers[i]?.choice ?? null : undefined).filter(v => v !== undefined)
    if (pair.length === 2 && pair[0] === pair[1] && (pair[0] === 'yes' || pair[0] === 'no')) { agreed++; features[feature] = pair[0] === 'yes' }
  }
  if (agreed < AGREEMENT_FLOOR) return { route: null, features, agreed, invalid: failure ?? `order-sensitive: ${agreed} of ${FEATURES.length} features agreed across orders` }
  const affirmed = FEATURES.filter(f => features[f] === true).length
  if (affirmed > AFFIRM_CAP) return { route: null, features, agreed, invalid: `affirmed ${affirmed} of ${FEATURES.length} features: an answer to everything, not a judgement` }

  return { route: routeOfFeatures(features), features, agreed, invalid: null }
}

// ---------------------------------------------------------------------------
// Authority. A recommendation is judged against the rules, never the reverse.
// ---------------------------------------------------------------------------

export type RouterPolicy = {
  profile: 'OPUS_LED' | 'SONNET_LED'
  hasOrchestration: boolean
  /** Whether a helper of that tier may be assigned at all (its pool is not zero). */
  hasHaiku: boolean
  hasSonnet: boolean
}

export type Verdict = { outcome: 'accepted' | 'rejected'; reason: string }

/**
 * Whether Cockpit's rules accept a recommendation. Accepting one starts
 * nothing: a scout or a worker still passes assignment and admission, an Opus
 * consultation still needs its ground and its evidence packet, and the effort
 * stays the person's. Refusing one leaves the rules' own answer standing.
 */
export const adjudicate = (advice: Route, facts: ConsultFacts, policy: RouterPolicy): Verdict => {
  const mandatory = mandatoryGrounds(facts)
  if (mandatory.length > 0) {
    return advice === 'opus'
      ? { outcome: 'accepted', reason: `matches the mandatory ${mandatory.join(', ')} consultation the rules already require` }
      : { outcome: 'rejected', reason: `a mandatory Opus consultation (${mandatory.join(', ')}) stands` }
  }
  const rules = deterministicRoute(facts)
  if (rules.route !== 'direct' && advice !== rules.route) {
    return { outcome: 'rejected', reason: `the rules read ${FEATURES.filter(f => rules.features[f]).join(', ')} from the task: ${rules.route} stands` }
  }
  if (advice === 'opus') {
    if (!policy.hasOrchestration || policy.profile !== 'SONNET_LED') return { outcome: 'rejected', reason: 'this profile has no Opus consultation to consider' }
    if (groundsAvailable(facts).length === 0) return { outcome: 'rejected', reason: NO_GROUND }

    return { outcome: 'accepted', reason: 'a consultation ground holds; admission is still by the rules' }
  }
  if (advice === 'scout' && !(policy.hasOrchestration && policy.hasHaiku)) return { outcome: 'rejected', reason: 'no Haiku scout may be assigned here' }
  if (advice === 'delegate' && !(policy.hasOrchestration && policy.hasSonnet)) return { outcome: 'rejected', reason: 'no Sonnet worker may be assigned here' }

  return { outcome: 'accepted', reason: advice === rules.route ? 'agrees with the rules' : 'the rules name no route; advisory' }
}

/** The reason a router's Opus reading is refused when nothing on record supports a consultation. */
const NO_GROUND = 'no consultation ground holds on evidence; ask for Opus yourself if you agree'

/**
 * What the person, and only the person, is told when a router reads a task as
 * one for Opus and the rules refuse it for want of a ground. Nothing is started
 * and the model is told nothing: the person asking for Opus is a ground the
 * rules already honour, so the decision is handed to them.
 */
export const operatorNotice = (mode: ActiveMode, reading: Reading, verdict: Verdict | null): string | null => {
  if (reading.route !== 'opus' || verdict === null || verdict.outcome !== 'rejected' || verdict.reason !== NO_GROUND) return null
  const why = (['security', 'architecture'] as const).filter(f => reading.features[f] === true).join(' and ')

  return `ROUTER / ${mode} reads this task as ${why || 'one for Opus'}-sensitive. No consultation ground holds on evidence, so nothing was started. Say "ask Opus" if you agree.`
}

/** The one line an accepted recommendation adds to the task's context; `direct` adds none. */
export const adviceLine = (mode: ActiveMode, route: Route): string | null => route === 'direct' ? null
  : `Cobalt Cockpit router (${mode}, advisory): ${ROUTE_ADVICE[route]}. It is a recommendation: Cockpit's rules still decide admission, ownership and verification.`

// ---------------------------------------------------------------------------
// Session state and its display.
// ---------------------------------------------------------------------------

export const MAX_DECISIONS = 16

export const addDecision = (list: readonly RouterDecision[], d: RouterDecision): RouterDecision[] => [...list, d].slice(-MAX_DECISIONS)

export const EMPTY_ROUTER: RouterState = { mode: DEFAULT_ROUTER, epoch: 0, link: 'unchecked', detail: null, asked: 0, accepted: 0, rejected: 0, fallbacks: 0, last: null }

/** The state after a switch: the new mode, a new epoch, and nothing carried over from the old provider. */
export const switchRouter = (state: RouterState, mode: RouterMode): RouterState => ({ ...EMPTY_ROUTER, mode, epoch: state.epoch + 1 })

/**
 * The state after a decision made under `epoch`; unchanged when the router was
 * switched meanwhile. A decision in which nothing was sent (a withheld prompt)
 * is counted as a fallback and says nothing about the provider.
 */
export const withDecision = (state: RouterState, epoch: number, d: RouterDecision): RouterState => {
  if (state.epoch !== epoch || state.mode !== d.mode) return state
  const tally = { fallbacks: state.fallbacks + (d.outcome === 'fallback' ? 1 : 0), last: d }
  if (d.calls === 0) return { ...state, ...tally }
  const isOwn = d.answered > 0 && d.provider === PROVIDER[d.mode]

  return {
    ...state,
    ...tally,
    link: isOwn && d.outcome !== 'fallback' ? 'connected' : !isOwn ? 'unavailable' : state.link,
    detail: d.outcome === 'fallback' ? d.reason : state.detail,
    asked: state.asked + 1,
    accepted: state.accepted + (d.outcome === 'accepted' ? 1 : 0),
    rejected: state.rejected + (d.outcome === 'rejected' ? 1 : 0),
  }
}

const SITE: Record<ActiveMode, string> = { NOBODYWHO: 'LOCAL', JEV: 'TYPESAFE API' }

/** `OFF`, `NOBODYWHO · LOCAL`, `JEV · CONNECTED`, `JEV · UNAVAILABLE (jev_disabled) · deterministic policy decides`. */
export const routerLabel = (state: RouterState): string => {
  if (state.mode === 'OFF') return 'OFF'
  const link = state.link === 'unavailable' ? `UNAVAILABLE (${state.detail ?? 'no answer'}) · deterministic policy decides` : state.mode === 'JEV' ? (state.link === 'connected' ? 'CONNECTED' : 'SELECTED') : SITE.NOBODYWHO

  return `${state.mode} · ${link}`
}

/** The label with what the session's decisions came to, for /cockpit and /cockpit version. */
export const routerLine = (state: RouterState): string => {
  if (state.mode === 'OFF') return 'OFF · deterministic policy only'
  const tally = state.asked === 0 ? 'no decision yet' : `${state.asked} asked · ${state.accepted} accepted · ${state.rejected} rejected · ${state.fallbacks} fallback`
  const last = state.last === null ? '' : ` · last ${state.last.advice ?? 'none'} ${state.last.outcome}${state.last.wallMs === null ? '' : ` ${state.last.wallMs}ms`}`

  return `${routerLabel(state)} · advisory · ${tally}${last}`
}

/** One ledger row for a decision. */
export const decisionLine = (d: RouterDecision): string =>
  `${d.mode} · asked ${d.asked} · advised ${d.advice ?? 'nothing'} · ${d.outcome}: ${d.reason} · rules ${d.rules} · ${d.provider ?? 'no provider'}${d.model ? ` ${d.model}` : ''} · ${d.answered}/${d.calls} answered · agreed ${d.agreed}/${FEATURES.length} · wall ${d.wallMs ?? 'unknown'}ms · provider ${d.providerMs ?? 'unknown'}ms${d.receipts.length ? ` · receipts ${d.receipts.join(',')}` : ' · no receipt'}`

/** A decision built from what really happened; the receipts are the ones that came back, never more. */
export const decisionOf = (input: { at: number; mode: ActiveMode; calls: number; answers: readonly (RouterAnswer | null)[]; wallMs: number | null; reading: Reading; rules: Route; verdict: Verdict | null }): RouterDecision => {
  const got = input.answers.filter((a): a is RouterAnswer => a !== null)
  const timed = got.map(a => a.latencyMs).filter((n): n is number => n !== null)
  const own = got.find(a => a.provider === PROVIDER[input.mode]) ?? got[0]

  return {
    at: input.at,
    mode: input.mode,
    asked: 'route',
    provider: own?.provider ?? null,
    model: own?.model ?? null,
    receipts: got.slice(0, 4).map(a => a.requestId.slice(0, 12)),
    calls: input.calls,
    answered: got.length,
    wallMs: input.wallMs,
    providerMs: timed.length ? timed.reduce((a, b) => a + b, 0) : null,
    agreed: input.reading.agreed,
    advice: input.reading.route,
    rules: input.rules,
    outcome: input.reading.route === null || input.verdict === null ? 'fallback' : input.verdict.outcome,
    reason: input.reading.route === null || input.verdict === null ? (input.reading.invalid ?? 'no reading') : input.verdict.reason,
  }
}
