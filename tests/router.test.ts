// The session router: OFF, NOBODYWHO or JEV, chosen per session. The pure
// rules first (what is asked, what counts as an answer, what the rules accept),
// then the real host hooks with a scripted `decision` CLI: which processes
// really started, with what arguments and environment, and what was recorded.

import { describe, expect, test } from 'claude-code/testing'
import { adjudicate, adviceLine, answerOf, callsFor, carriesCredential, decisionOf, deterministicRoute, operatorNotice, readAnswers, routeOfFeatures, routerArgv, routerLabel, routerLine, routerModeOf, routerStateOf, switchRouter, withDecision, AFFIRM_CAP, AGREEMENT_FLOOR, DEFAULT_ROUTER, EMPTY_ROUTER, FEATURES, MAX_DECISIONS, ROUTER_MODES, TASK_MAX, addDecision } from '../hooks/router'
import type { ActiveMode, Feature, RouterAnswer, RouterDecision, RouterPolicy, RouterState } from '../hooks/router'
import type { ConsultFacts } from '../hooks/consult'
import { ledgerLines, emptyLedger, exportJSON } from '../hooks/ledger'
import type { Ledger, Task } from '../types'
import { command, FIVE, GATE_NAMES, hostState, mountPane, progress, prompt, rowsOf, start, world } from './world'

type Engine = Parameters<typeof start>[0]
type World = ReturnType<typeof world>
const SWARM = 'mcp__cobalt-cockpit__swarm'
const SONNET = 'claude-sonnet-5-5'
const LED = { options: { orchestration: true, profile: 'SONNET_LED' } }
const JEV_DIR = { options: { orchestration: true, profile: 'SONNET_LED', routerConfigDir: '/home/op/.config/cobalt-cockpit/router-jev' } }

const facts = (promptText: string, over: Partial<ConsultFacts> = {}): ConsultFacts => ({ prompt: promptText, files: [], milestones: 0, errorStreak: 0, ...over })
const POLICY: RouterPolicy = { profile: 'SONNET_LED', hasOrchestration: true, hasHaiku: true, hasSonnet: true }
const answer = (n: number, choice: string | null, over: Partial<RouterAnswer> = {}): RouterAnswer => ({ requestId: `rcpt${String(n).padStart(8, '0')}`, choice, provider: 'nobodywho', model: 'Qwen3-4B', latencyMs: 100, failure: null, ...over })
/** Ten answers for a set of features, as a provider that judges would give them. */
const judged = (yes: readonly Feature[], over: Partial<RouterAnswer> = {}): RouterAnswer[] => callsFor('task: x').map((c, i) => answer(i, yes.includes(c.feature) ? 'yes' : 'no', over))

describe('router modes', () => {
  test('three modes, OFF by default, named case-insensitively', () => {
    expect(ROUTER_MODES).toEqual(['OFF', 'NOBODYWHO', 'JEV'])
    expect(DEFAULT_ROUTER).toBe('OFF')
    expect(EMPTY_ROUTER.mode).toBe('OFF')
    for (const [word, mode] of [['off', 'OFF'], ['OFF', 'OFF'], ['NobodyWho', 'NOBODYWHO'], ['nwho', 'NOBODYWHO'], ['JEV', 'JEV'], [' jev ', 'JEV']] as const) expect(routerModeOf(word)).toBe(mode)
    for (const word of ['', 'opus', 'jev2', 'on', 'both']) expect(routerModeOf(word)).toBeNull()
  })
  test('a switch carries nothing over from the provider before it', () => {
    const used: RouterState = { ...EMPTY_ROUTER, mode: 'NOBODYWHO', epoch: 3, link: 'connected', detail: 'Qwen', asked: 4, accepted: 2, rejected: 1, fallbacks: 1, last: {} as RouterDecision }
    expect(switchRouter(used, 'JEV')).toEqual({ ...EMPTY_ROUTER, mode: 'JEV', epoch: 4 })
    expect(switchRouter(used, 'OFF')).toMatchObject({ mode: 'OFF', epoch: 4, last: null, asked: 0 })
  })
})

describe('the deterministic baseline', () => {
  test('routes come from fixed features, the first that holds deciding', () => {
    expect(routeOfFeatures({})).toBe('direct')
    expect(routeOfFeatures({ parallel: true, discovery: true })).toBe('scout')
    expect(routeOfFeatures({ difficult: true, parallel: true })).toBe('effort')
    expect(routeOfFeatures({ architecture: true, difficult: true })).toBe('opus')
    expect(routeOfFeatures({ security: true })).toBe('opus')
  })
  test('each feature is read off plain wording; ordinary work is direct', () => {
    for (const [text, route] of [
      ['Fix the typo in the README heading.', 'direct'],
      ['Add pagination to the /items endpoint with limit and offset.', 'direct'],
      ['There is a race condition in the job queue under load.', 'effort'],
      ['The suite fails intermittently on CI; debug it.', 'effort'],
      ['Redesign the persistence layer across all modules.', 'opus'],
      ['Rewrite the authentication flow to use rotating tokens.', 'opus'],
      ['Find every place the deprecated logger is called.', 'scout'],
      ['Which files import the legacy client? Search the whole repo.', 'scout'],
      ['Add validation to each of the five independent form modules.', 'delegate'],
    ] as const) expect(deterministicRoute(facts(text)).route).toBe(route)
    // a negated feature is not the feature
    expect(deterministicRoute(facts('Rename the helper; no redesign, and not a security change.')).route).toBe('direct')
    // a failure that has repeated is hard, whatever the words
    expect(deterministicRoute(facts('Make the test pass.', { errorStreak: 2 })).route).toBe('effort')
  })
})

// Synthetic credentials are built at run time from parts, so no source line is itself credential-shaped.
const join = (...parts: string[]): string => parts.join('')

describe('what a router is shown', () => {
  test('the prompt on one line, clipped; nothing for a non-task; never a credential', () => {
    expect(routerStateOf('Add a retry\n  to the uploader and test it.', 'NOBODYWHO')).toBe('task: Add a retry to the uploader and test it.')
    const long = routerStateOf(`Refactor ${'x'.repeat(900)}`, 'NOBODYWHO')!
    expect(long.length).toBe('task: '.length + TASK_MAX)
    for (const none of ['yes', 'go on', '/cockpit router jev', '   ']) expect(routerStateOf(none, 'NOBODYWHO')).toBeNull()
    for (const secret of [`Use api_key=${join('sk-', 'live-', 'abcdefgh12345678')} to call the billing service please`, 'Deploy with password: hunter2hunter2 on the staging box', 'Set Authorization: Bearer abcdefghijklmnop for the client']) {
      expect(carriesCredential(secret)).toBe(true)
      expect(routerStateOf(secret, 'NOBODYWHO')).toBeNull()
    }
    expect(carriesCredential('Rotate the token store implementation and add tests')).toBe(false)
  })
  test('the credential filter is broad by design: named values, URLs, known prefixes, long runs, a pasted .env', () => {
    // Synthetic shapes only. Two are assembled from parts so that no line of this file is itself credential-shaped.
    for (const secret of [
      'SECRET_KEY=abc123xyz', 'PRIVATE_KEY=abcdefgh', 'SESSION_KEY=zzzzzzzz1', 'db-password = s3cretvalue', 'authToken="abc123def"', 'export FOO_TOKEN=x1y2z3a4',
      'DATABASE_URL=postgres://u:p@h/db', 'connect to postgres://admin:hunter2@db.internal/app', 'redis://:pw123456@cache:6379', 'https://user:pw@host/path', join('curl ', '-u user', ':pw https://x'),
      join('key wJalr', 'XUtn', 'FEMI/K7MD', 'ENG/bPxR', 'fiCYEX', 'AMPLEKEY ok'), join('AS', 'IA', 'IOSFODNN7', 'EXAMPLE'), join('AK', 'IA', 'IOSFODNN7', 'EXAMPLE'), join('AS', 'IA', 'QWERTY0123456789'), join('sk', '-abcdefghijklmnop1234'), join('sk', '-proj-abcdefghijklmnop1234'), join('glpat', '-abcdefghijklmnopqrst'),
      'AIzaSyA-abcdefghijklmnopqrstuvwxyz012', 'npm_abcdefghijklmnopqrstuvwx', 'hf_abcdefghijklmnopqrstuvwx', `${'gh'}${'p_'}abcdefghijklmnopqrstuvwxyz0123456789`, 'https://hooks.slack.com/services/T000/B000/XXXX',
      'the password is hunter2', '?token=abcdef', 'Authorization: Bearer abcdefghijkl', join('digest 9f86d081884c7d65', '9a2feaa0c55ad015a3bf4f1b2b0b822c', 'd15d6c15b0f00a08 here'),
    ]) expect([secret, carriesCredential(`Use this when you fix the uploader: ${secret}`)]).toEqual([secret, true])
    // ordinary engineering prompts are not withheld
    for (const plain of [
      'Add a --verbose flag to the CLI that prints each processed file.', 'Fix the bug in src/components/settings/ThemeToggle.tsx and packages/app-server/src/handlers/user.ts',
      'Make the password field validate length on blur', 'Document how secrets are loaded by the config module', 'Bump the version string to 1.4.2 in package.json.',
      'Use https://example.com/docs/api as the reference for pagination', 'Rewrite the authentication flow to use rotating refresh tokens.',
    ]) expect([plain, carriesCredential(plain)]).toEqual([plain, false])
  })
  test('ten requests: five fixed yes/no features, each in both orders, nothing else', () => {
    const calls = callsFor('task: x')
    expect(calls).toHaveLength(10)
    for (const f of FEATURES) {
      const pair = calls.filter(c => c.feature === f).map(c => JSON.parse(c.body))
      expect(pair.map(b => Object.keys(b.choices))).toEqual([['yes', 'no'], ['no', 'yes']])
      expect(pair[0].question).toBe(pair[1].question)
      for (const b of pair) expect(Object.keys(b).sort()).toEqual(['allow_abstain', 'choices', 'question', 'state'])
    }
  })
  test('each mode names its one provider on the command line; no shell, no other flag', () => {
    expect(routerArgv('NOBODYWHO', '{}')).toEqual(['decision', 'ask', '--caller', 'cockpit', '--mode', 'local', '--json', '{}'])
    expect(routerArgv('JEV', '{}')).toEqual(['decision', 'ask', '--caller', 'cockpit', '--mode', 'jev', '--json', '{}'])
  })
})

describe('what counts as an answer', () => {
  test('only output with a receipt; failures are named, never guessed', () => {
    const real = JSON.stringify({ request_id: 'fba8fd394b6a440ead8d2883f267cb64', mode: 'jev', follow: 'yes', decision: { provider: 'jev', choice: 'yes', abstain: false, model: 'jev-1.13.0', latency_ms: 246.4, confidence: 0.98 } })
    expect(answerOf(real)).toEqual({ requestId: 'fba8fd394b6a440ead8d2883f267cb64', choice: 'yes', provider: 'jev', model: 'jev-1.13.0', latencyMs: 246, failure: null })
    expect(answerOf(JSON.stringify({ decision: { provider: 'jev', choice: 'yes' } }))).toBeNull()
    expect(answerOf('not json')).toBeNull()
    expect(answerOf('')).toBeNull()
    const off = answerOf(JSON.stringify({ request_id: 'aaaaaaaaaaaa', follow: null, decision: { provider: 'jev', choice: null, abstain: false, fallback_reason: 'jev_disabled', error: 'JEV is disabled' } }))
    expect(off).toMatchObject({ choice: null, failure: 'jev_disabled' })
    // text the router did not mean as a word is not carried
    expect(answerOf(JSON.stringify({ request_id: 'aaaaaaaaaaaa', decision: { provider: 'x y; rm', model: 'sk-live-abcdefgh', choice: 'Yes please', fallback_reason: 'a b' } }))).toMatchObject({ provider: 'unknown', choice: null, failure: null })
  })
  test('a judging provider is read; the route is the first agreed feature', () => {
    const calls = callsFor('task: x')
    expect(readAnswers('NOBODYWHO', calls, judged([]))).toMatchObject({ route: 'direct', agreed: 5, invalid: null })
    expect(readAnswers('NOBODYWHO', calls, judged(['discovery']))).toMatchObject({ route: 'scout', invalid: null })
    expect(readAnswers('NOBODYWHO', calls, judged(['parallel', 'difficult']))).toMatchObject({ route: 'effort', invalid: null })
    expect(readAnswers('JEV', calls, judged(['security'], { provider: 'jev' }))).toMatchObject({ route: 'opus', invalid: null })
  })
  test('a provider that follows position is discarded: repeating one order is not stability', () => {
    const calls = callsFor('task: x')
    // always the first-listed option: every pair disagrees
    const positional = calls.map((c, i) => answer(i, c.swapped ? 'no' : 'yes'))
    expect(readAnswers('NOBODYWHO', calls, positional)).toMatchObject({ route: null, agreed: 0, invalid: 'order-sensitive: 0 of 5 features agreed across orders' })
    // one feature may disagree, two may not
    const oneOff = judged(['discovery']).map((a, i) => i === 0 ? { ...a, choice: 'yes' } : a)
    expect(readAnswers('NOBODYWHO', calls, oneOff)).toMatchObject({ route: 'scout', agreed: 4, invalid: null })
    const twoOff = oneOff.map((a, i) => i === 2 ? { ...a, choice: 'yes' } : a)
    expect(readAnswers('NOBODYWHO', calls, twoOff)).toMatchObject({ route: null, agreed: 3 })
    expect(AGREEMENT_FLOOR).toBe(4)
  })
  test('a provider that says yes to everything is discarded too', () => {
    const calls = callsFor('task: x')
    expect(AFFIRM_CAP).toBe(3)
    expect(readAnswers('NOBODYWHO', calls, judged(['security', 'architecture', 'difficult']))).toMatchObject({ route: 'opus', invalid: null })
    expect(readAnswers('NOBODYWHO', calls, judged([...FEATURES]))).toMatchObject({ route: null, invalid: 'affirmed 5 of 5 features: an answer to everything, not a judgement' })
    expect(readAnswers('NOBODYWHO', calls, judged(['security', 'architecture', 'difficult', 'discovery']))).toMatchObject({ route: null })
  })
  test('another provider, no receipt, a failure or a word that is not yes or no is no answer', () => {
    const calls = callsFor('task: x')
    expect(readAnswers('NOBODYWHO', calls, judged(['discovery'], { provider: 'jev' }))).toMatchObject({ route: null, invalid: 'answered by jev, not nobodywho' })
    expect(readAnswers('JEV', calls, judged(['discovery']))).toMatchObject({ route: null, invalid: 'answered by nobodywho, not jev' })
    expect(readAnswers('JEV', calls, calls.map(() => null))).toMatchObject({ route: null, invalid: 'no answer with a receipt' })
    expect(readAnswers('JEV', calls, calls.map((_, i) => answer(i, null, { provider: 'jev', failure: 'jev_disabled' })))).toMatchObject({ route: null, invalid: 'jev_disabled' })
    expect(readAnswers('NOBODYWHO', calls, calls.map((_, i) => answer(i, 'maybe')))).toMatchObject({ route: null, agreed: 0 })
  })
})

describe('the rules judge a recommendation, never the reverse', () => {
  const plain = facts('Add a CSV option to the export button and test it.')
  test('where the rules name no route, a recommendation is accepted as advice', () => {
    for (const route of ['direct', 'scout', 'delegate', 'effort'] as const) expect(adjudicate(route, plain, POLICY)).toMatchObject({ outcome: 'accepted' })
    expect(adviceLine('JEV', 'scout')).toContain('router (JEV, advisory): ask a Haiku scout')
    expect(adviceLine('JEV', 'effort')).toContain('the effort is yours to set')
    expect(adviceLine('NOBODYWHO', 'direct')).toBeNull()
  })
  test('Opus is never recommended into being: a ground must hold on evidence', () => {
    expect(adjudicate('opus', plain, POLICY)).toEqual({ outcome: 'rejected', reason: 'no consultation ground holds on evidence; ask for Opus yourself if you agree' })
    expect(adjudicate('opus', facts('Redesign the persistence layer across modules.'), POLICY)).toMatchObject({ outcome: 'accepted' })
    const said = (yes: readonly Feature[]) => readAnswers('JEV', callsFor('task: x'), judged(yes, { provider: 'jev' }))
    expect(operatorNotice('JEV', said(['security', 'architecture']), adjudicate('opus', plain, POLICY))).toBe('ROUTER / JEV reads this task as security and architecture-sensitive. No consultation ground holds on evidence, so nothing was started. Say "ask Opus" if you agree.')
    // nothing to tell when the reading was not Opus, was accepted, or was refused for another reason
    expect(operatorNotice('JEV', said(['discovery']), adjudicate('scout', plain, POLICY))).toBeNull()
    expect(operatorNotice('JEV', said(['security']), adjudicate('opus', facts('Redesign the persistence layer across modules.'), POLICY))).toBeNull()
    expect(operatorNotice('JEV', said(['security']), adjudicate('opus', plain, { ...POLICY, profile: 'OPUS_LED' }))).toBeNull()
    expect(operatorNotice('JEV', said(['security']), null)).toBeNull()
    expect(adjudicate('opus', facts('Redesign the persistence layer across modules.'), { ...POLICY, profile: 'OPUS_LED' })).toMatchObject({ outcome: 'rejected', reason: 'this profile has no Opus consultation to consider' })
    expect(adjudicate('opus', facts('Redesign the persistence layer across modules.'), { ...POLICY, hasOrchestration: false })).toMatchObject({ outcome: 'rejected' })
  })
  test('a mandatory consultation stands whatever a router says', () => {
    for (const mandatory of [facts('Ask Opus to review the cache design.'), facts('Please approve the release of v2.'), facts('Tidy the helper.', { files: ['src/auth/session.ts'] })]) {
      for (const route of ['direct', 'scout', 'delegate', 'effort'] as const) expect(adjudicate(route, mandatory, POLICY)).toMatchObject({ outcome: 'rejected', reason: expect.stringContaining('mandatory Opus consultation') })
      expect(adjudicate('opus', mandatory, POLICY)).toMatchObject({ outcome: 'accepted' })
    }
  })
  test('a route the rules read off the task stands against a different recommendation', () => {
    const scout = facts('Find every place the deprecated logger is called.')
    expect(adjudicate('direct', scout, POLICY)).toEqual({ outcome: 'rejected', reason: 'the rules read discovery from the task: scout stands' })
    expect(adjudicate('scout', scout, POLICY)).toEqual({ outcome: 'accepted', reason: 'agrees with the rules' })
  })
  test('a helper that may not be assigned is not recommended', () => {
    expect(adjudicate('scout', plain, { ...POLICY, hasHaiku: false })).toMatchObject({ outcome: 'rejected' })
    expect(adjudicate('delegate', plain, { ...POLICY, hasSonnet: false })).toMatchObject({ outcome: 'rejected' })
    expect(adjudicate('scout', plain, { ...POLICY, hasOrchestration: false })).toMatchObject({ outcome: 'rejected' })
  })
})

describe('what is recorded and shown', () => {
  const calls = callsFor('task: x')
  const made = (over: Partial<Parameters<typeof decisionOf>[0]> = {}): RouterDecision => {
    const answers = judged(['discovery'], { provider: 'jev', model: 'jev-1.13.0', latencyMs: 250 })
    const reading = readAnswers('JEV', calls, answers)
    return decisionOf({ at: 5, mode: 'JEV', calls: 10, answers, wallMs: 380, reading, rules: 'direct', verdict: { outcome: 'accepted', reason: 'the rules name no route; advisory' }, ...over })
  }
  test('a decision holds what happened: provider, receipts that came back, both latencies, the verdict', () => {
    const d = made()
    expect(d).toMatchObject({ mode: 'JEV', asked: 'route', provider: 'jev', model: 'jev-1.13.0', calls: 10, answered: 10, wallMs: 380, providerMs: 2500, agreed: 5, advice: 'scout', rules: 'direct', outcome: 'accepted' })
    expect(d.receipts).toEqual(['rcpt00000000', 'rcpt00000001', 'rcpt00000002', 'rcpt00000003'])
    expect(JSON.stringify(d)).not.toContain('task:')
  })
  test('no receipt is invented for a request that did not run or did not answer', () => {
    const none = calls.map(() => null)
    const d = decisionOf({ at: 5, mode: 'JEV', calls: 10, answers: none, wallMs: 4000, reading: readAnswers('JEV', calls, none), rules: 'direct', verdict: null })
    expect(d).toMatchObject({ provider: null, model: null, receipts: [], answered: 0, providerMs: null, advice: null, outcome: 'fallback', reason: 'no answer with a receipt' })
    const withheld = decisionOf({ at: 5, mode: 'JEV', calls: 0, answers: [], wallMs: null, reading: { route: null, features: {}, agreed: 0, invalid: 'prompt withheld' }, rules: 'direct', verdict: null })
    expect(withheld).toMatchObject({ calls: 0, answered: 0, receipts: [], wallMs: null, outcome: 'fallback' })
  })
  test('the state follows decisions of its own epoch only; the labels say what is known', () => {
    let s = switchRouter(EMPTY_ROUTER, 'JEV')
    expect(routerLabel(EMPTY_ROUTER)).toBe('OFF')
    expect(routerLine(EMPTY_ROUTER)).toBe('OFF · deterministic policy only')
    expect(routerLabel(s)).toBe('JEV · SELECTED')
    s = withDecision(s, s.epoch, made())
    expect(s).toMatchObject({ link: 'connected', asked: 1, accepted: 1 })
    expect(routerLabel(s)).toBe('JEV · CONNECTED')
    expect(routerLine(s)).toBe('JEV · CONNECTED · advisory · 1 asked · 1 accepted · 0 rejected · 0 fallback · last scout accepted 380ms')
    // a withheld prompt sent nothing: it is a fallback, and says nothing about the provider
    const withheld = decisionOf({ at: 6, mode: 'JEV', calls: 0, answers: [], wallMs: null, reading: { route: null, features: {}, agreed: 0, invalid: 'prompt withheld' }, rules: 'direct', verdict: null })
    const after = withDecision(s, s.epoch, withheld)
    expect(after).toMatchObject({ link: 'connected', asked: 1, fallbacks: 1, last: withheld })
    expect(routerLabel(after)).toBe('JEV · CONNECTED')
    // a reading from before a switch is not this router's
    const later = switchRouter(s, 'NOBODYWHO')
    expect(withDecision(later, s.epoch, made())).toBe(later)
    expect(routerLabel(later)).toBe('NOBODYWHO · LOCAL')
    const none = calls.map(() => null)
    const down = withDecision(switchRouter(later, 'JEV'), later.epoch + 1, decisionOf({ at: 6, mode: 'JEV', calls: 10, answers: none, wallMs: 4000, reading: readAnswers('JEV', calls, none), rules: 'direct', verdict: null }))
    expect(routerLabel(down)).toBe('JEV · UNAVAILABLE (no answer with a receipt) · deterministic policy decides')
  })
  test('the ledger keeps a bounded, separate section; nothing of it is a model request', () => {
    let list: RouterDecision[] = []
    for (let i = 0; i < MAX_DECISIONS + 5; i++) list = addDecision(list, made({ at: i }))
    expect(list).toHaveLength(MAX_DECISIONS)
    expect(list[0]!.at).toBe(5)
    const l: Ledger = { ...emptyLedger('s'), routing: list.slice(-2) }
    const lines = ledgerLines(l, 3).join('\n')
    expect(lines).toContain('12 SESSION ROUTER')
    expect(lines).toContain('JEV · asked route · advised scout · accepted: the rules name no route; advisory · rules direct · jev jev-1.13.0 · 10/10 answered · agreed 5/5 · wall 380ms · provider 2500ms · receipts rcpt00000000,rcpt00000001,rcpt00000002,rcpt00000003')
    expect(ledgerLines(emptyLedger('s'), 3).join('\n')).not.toContain('SESSION ROUTER')
    expect(l.requests).toEqual([])
    expect(JSON.parse(exportJSON(l)).routing).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Through the real host hooks.
// ---------------------------------------------------------------------------

type Script = { provider: string; model?: string; yes?: readonly Feature[]; kind?: 'judge' | 'positional' | 'yesman' | 'disabled' | 'silent' }
const FEATURE_OF = (question: string): Feature => question.includes('security-sensitive') ? 'security' : question.includes('architectural') ? 'architecture' : question.includes('hard debugging') ? 'difficult' : question.includes('broad search') ? 'discovery' : 'parallel'
/** A `decision` CLI that answers by script, per --mode, and records what it was asked. */
const scripted = (w: World, by: Partial<Record<'local' | 'jev', Script>>) => {
  const asked: { mode: string; state: string; question: string; keys: string[] }[] = []
  w.outputs['decision'] = argv => {
    const mode = argv[argv.indexOf('--mode') + 1] ?? ''
    const body = JSON.parse(String(argv.at(-1)))
    asked.push({ mode, state: body.state, question: body.question, keys: Object.keys(body.choices) })
    const script = by[mode as 'local' | 'jev']
    const id = `rcpt${String(asked.length).padStart(12, '0')}`
    if (script === undefined || script.kind === 'silent') return 'unavailable'
    if (script.kind === 'disabled') return JSON.stringify({ request_id: id, mode, follow: null, decision: { provider: script.provider, choice: null, abstain: false, fallback_reason: 'jev_disabled', error: 'JEV is disabled' } })
    const keys = Object.keys(body.choices)
    const choice = script.kind === 'positional' ? keys[0] : script.kind === 'yesman' ? 'yes' : (script.yes ?? []).includes(FEATURE_OF(body.question)) ? 'yes' : 'no'
    return JSON.stringify({ request_id: id, mode, follow: choice, decision: { provider: script.provider, choice, abstain: false, model: script.model ?? 'model-x', latency_ms: 120 } })
  }
  return asked
}
const routerRuns = (w: World) => w.runs.map((argv, i) => ({ argv, env: w.runEnvs[i] })).filter(r => r.argv[0] === 'decision')
const ledger = (held: ReturnType<typeof hostState>) => held.get('run-ledger')!.value as Ledger
const routerState = (held: ReturnType<typeof hostState>) => (held.get('router')?.value ?? EMPTY_ROUTER) as RouterState
const text = async (p: Promise<{ text?: string }>) => String((await p).text ?? '')
const step = async ($: Engine, model: string, over: Record<string, unknown> = {}) => {
  const stream = $.turn.step({ turnId: 't1', index: 0, model, messageCount: 3, ...over } as never)
  let at = await stream.next()
  while (at.done !== true) at = await stream.next()
}
const ORDINARY = 'Add a CSV option to the export button and cover it with a test.'
const NWHO: Script = { provider: 'nobodywho', model: 'Qwen3-4B', yes: ['discovery'] }
const JEV: Script = { provider: 'jev', model: 'jev-1.13.0', yes: ['parallel'] }

describe('the session router through the host', () => {
  test('a fresh session is OFF: nothing is asked, whatever the task, and the prompt is untouched', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); const asked = scripted(w, { local: NWHO, jev: JEV }); await start($)
    for (const p of [ORDINARY, 'Find every place the deprecated logger is called.', 'Redesign the persistence layer across modules.']) await prompt($, p)
    expect(asked).toHaveLength(0)
    expect(routerRuns(w)).toHaveLength(0)
    expect(routerState(held).mode).toBe('OFF')
    expect(w.submitted.every(s => s.context.every(c => !c.includes('router')))).toBe(true)
    expect(await text(command($, 'router'))).toContain('ROUTER / OFF · deterministic policy only')
    expect(await text(command($, 'version'))).toContain('ROUTER / OFF · deterministic policy only')
  })
  test('NOBODYWHO: selected by command, checked once, then asked for a task the rules do not settle', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); const asked = scripted(w, { local: NWHO, jev: JEV }); await start($)
    const reply = await text(command($, 'router NOBODYWHO'))
    expect(reply).toContain('ROUTER / NOBODYWHO · LOCAL · Qwen3-4B')
    expect(reply).toContain('Advisory only')
    expect(reply).toContain('a new session starts OFF')
    // the one availability request carries nothing of the session
    expect(asked).toEqual([{ mode: 'local', state: 'task: router availability check', question: expect.any(String), keys: ['yes', 'no'] }])
    await prompt($, ORDINARY)
    expect(asked).toHaveLength(11)
    expect(asked.slice(1).every(a => a.mode === 'local' && a.state === `task: ${ORDINARY}`)).toBe(true)
    // NobodyWho only: the local provider is named on every call and no router configuration is handed over
    expect(routerRuns(w).every(r => r.argv.includes('local') && !r.argv.includes('jev') && r.env === undefined)).toBe(true)
    expect(w.submitted.at(-1)!.context.filter(c => c.includes('router'))).toEqual(['Cobalt Cockpit router (NOBODYWHO, advisory): ask a Haiku scout to search or inventory first. It is a recommendation: Cockpit\'s rules still decide admission, ownership and verification.'])
    const d = ledger(held).routing!
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ mode: 'NOBODYWHO', provider: 'nobodywho', model: 'Qwen3-4B', calls: 10, answered: 10, agreed: 5, advice: 'scout', rules: 'direct', outcome: 'accepted', providerMs: 1200 })
    expect(typeof d[0]!.wallMs).toBe('number')
    expect(JSON.stringify(d)).not.toContain('CSV')
    expect(routerState(held)).toMatchObject({ mode: 'NOBODYWHO', link: 'connected', asked: 1, accepted: 1 })
    expect(w.outbound).toEqual([])
  })
  test('JEV: the operator\'s router configuration reaches the JEV child process and no other', JEV_DIR, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); const asked = scripted(w, { local: NWHO, jev: JEV }); await start($)
    // before JEV is selected nothing names it, in OFF or in NOBODYWHO
    await prompt($, ORDINARY)
    await command($, 'router nobodywho')
    await prompt($, 'Make the export button remember the last format chosen.')
    expect(routerRuns(w).some(r => r.argv.includes('jev') || r.env !== undefined)).toBe(false)
    const before = routerRuns(w).length
    const reply = await text(command($, 'router jev'))
    expect(reply).toContain('ROUTER / JEV · CONNECTED · jev-1.13.0')
    expect(reply).toContain('its first 400 characters are sent to JEV in ten small requests')
    expect(reply).toContain('Each prompt you submit outside a planned task counts as a new task')
    expect(reply).toContain('with the router configuration at /home/op/.config/cobalt-cockpit/router-jev (routerConfigDir)')
    expect(reply).toContain('not a guarantee')
    await prompt($, 'Show the build number in the footer of every page.')
    const jev = routerRuns(w).slice(before)
    expect(jev).toHaveLength(11)
    expect(jev.every(r => r.argv[5] === 'jev' && r.env !== undefined && Object.keys(r.env).join() === 'DECISION_ROUTER_CONFIG_DIR' && r.env['DECISION_ROUTER_CONFIG_DIR'] === '/home/op/.config/cobalt-cockpit/router-jev')).toBe(true)
    expect(ledger(held).routing!.at(-1)).toMatchObject({ mode: 'JEV', provider: 'jev', advice: 'delegate', outcome: 'accepted' })
    expect(w.submitted.at(-1)!.context.some(c => c.includes('router (JEV, advisory): delegate the independent bounded parts'))).toBe(true)
    expect(asked.at(-1)!.mode).toBe('jev')
    // nothing of the configuration directory or any key reaches plugin state
    expect(JSON.stringify([...held.entries()])).not.toContain('router-jev')
  })
  test('JEV without a configuration directory runs under the router\'s own switch, and a refusal falls back', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); scripted(w, { local: NWHO, jev: { provider: 'jev', kind: 'disabled' } }); await start($)
    const reply = await text(command($, 'router JEV'))
    expect(reply).toContain('ROUTER / JEV · UNAVAILABLE (jev_disabled) · deterministic policy decides')
    expect(reply).toContain('no routerConfigDir is set')
    expect(routerRuns(w).every(r => r.env === undefined)).toBe(true)
    await prompt($, ORDINARY)
    expect(ledger(held).routing!.at(-1)).toMatchObject({ mode: 'JEV', advice: null, outcome: 'fallback', reason: 'jev_disabled', rules: 'direct' })
    expect(w.submitted.at(-1)!.context.every(c => !c.includes('router'))).toBe(true)
    expect(routerState(held)).toMatchObject({ link: 'unavailable', fallbacks: 1 })
  })
  test('the rules settle it more cheaply: no request for a mandatory consultation or a route read off the task', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); const asked = scripted(w, { local: NWHO }); await start($)
    await command($, 'router nobodywho')
    for (const p of ['Ask Opus to review the cache design.', 'Please approve the release of v2.0.', 'Find every place the deprecated logger is called.', 'Redesign the persistence layer across modules.', 'yes', '/cockpit status']) await prompt($, p)
    expect(asked).toHaveLength(1)
    expect(ledger(held).routing ?? []).toHaveLength(0)
  })
  test('a router cannot make Opus happen, lift a mandatory hold or start a helper', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); scripted(w, { local: { provider: 'nobodywho', yes: ['security'] } }); await start($)
    await command($, 'router nobodywho')
    await prompt($, ORDINARY)
    // it said Opus; no ground holds, so the rules refuse the advice and nothing is said to the model
    expect(ledger(held).routing!.at(-1)).toMatchObject({ advice: 'opus', outcome: 'rejected', reason: 'no consultation ground holds on evidence; ask for Opus yourself if you agree' })
    expect(w.submitted.at(-1)!.context.every(c => !c.includes('router'))).toBe(true)
    // the person is told, and only the person: asking for Opus is theirs to do
    expect(w.toasts.filter(t => t.startsWith('ROUTER'))).toEqual(['ROUTER / NOBODYWHO reads this task as security-sensitive. No consultation ground holds on evidence, so nothing was started. Say "ask Opus" if you agree.'])
    // admission is unchanged: the same ordinary task is still refused a consultation
    expect(String((await $.tool.call({ tool: SWARM, action: 'consult', ground: 'security', objective: 'CSV export', locations: ['src/export.ts'], risk: 'none', question: 'ok?' } as never)).result)).toContain('NOT ADMITTED')
    expect(ledger(held).consults ?? []).toHaveLength(0)
    expect(w.spawns).toHaveLength(0)
    // a mandatory review holds at 99% in every mode
    await prompt($, 'Please approve the release of v0.5.0 after checking everything')
    await progress($, { action: 'plan', milestones: FIVE })
    for (const m of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone: m })
    for (const g of GATE_NAMES) await progress($, { action: 'gate', gate: g, state: 'na', evidence: 'fixture' })
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toContain('HELD')
    expect((held.get('task')!.value as Task).percent).toBeLessThan(100)
  })
  test('unreliable providers are discarded: position-following, yes to everything, the wrong provider, silence', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); await start($)
    const last = () => ledger(held).routing!.at(-1)!
    const cases: [Script, string][] = [
      [{ provider: 'nobodywho', kind: 'positional' }, 'order-sensitive: 0 of 5 features agreed across orders'],
      [{ provider: 'nobodywho', kind: 'yesman' }, 'affirmed 5 of 5 features: an answer to everything, not a judgement'],
      [{ provider: 'jev', yes: ['discovery'] }, 'answered by jev, not nobodywho'],
      [{ provider: 'nobodywho', kind: 'silent' }, 'no answer with a receipt'],
    ]
    let n = 0
    for (const [script, reason] of cases) {
      scripted(w, { local: script })
      await command($, 'router off'); await command($, 'router nobodywho')
      await prompt($, `${ORDINARY} (${++n})`)
      expect(last()).toMatchObject({ outcome: 'fallback', advice: null, reason })
      expect(w.submitted.at(-1)!.context.every(c => !c.includes('router'))).toBe(true)
    }
    expect(last()).toMatchObject({ provider: null, receipts: [], answered: 0 })
  })
  test('a prompt with a credential in it is never shown to a router, and that is recorded without a receipt', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); const asked = scripted(w, { jev: JEV }); await start($)
    await command($, 'router jev')
    await prompt($, `Call the billing service with api_key=${join('sk-', 'live-', 'abcdefgh12345678')} and store the result.`)
    expect(asked).toHaveLength(1)
    expect(ledger(held).routing!.at(-1)).toMatchObject({ calls: 0, answered: 0, receipts: [], outcome: 'fallback', reason: expect.stringContaining('prompt withheld') })
    expect(JSON.stringify(ledger(held).routing)).not.toContain('sk-live')
  })
  test('switching: every pair of modes, an unambiguous state, and nothing stale carried across', JEV_DIR, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); scripted(w, { local: NWHO, jev: JEV }); await start($)
    const go = async (mode: string) => { await command($, `router ${mode}`); return routerState(held) }
    let epoch = routerState(held).epoch
    for (const [mode, label] of [['nobodywho', 'NOBODYWHO · LOCAL'], ['jev', 'JEV · CONNECTED'], ['off', 'OFF'], ['jev', 'JEV · CONNECTED'], ['nobodywho', 'NOBODYWHO · LOCAL'], ['off', 'OFF']] as const) {
      if (mode !== 'off') { await prompt($, `${ORDINARY} [${epoch}]`) }
      const s = await go(mode)
      expect(s.epoch).toBe(++epoch)
      expect(routerLabel(s)).toBe(label)
      // the new mode starts with no decision of the old one
      expect(s).toMatchObject({ last: null, asked: 0, accepted: 0, rejected: 0, fallbacks: 0 })
      expect(await text(command($, 'version'))).toContain(`ROUTER / ${label}`)
    }
    // OFF again: no further router process, however many tasks follow
    const runs = routerRuns(w).length
    await prompt($, 'Rename the export helper and update its two callers.')
    expect(routerRuns(w)).toHaveLength(runs)
    // selecting the mode already selected changes nothing and asks nothing
    const same = await text(command($, 'router off'))
    expect(same).toContain('(unchanged)')
    expect(routerState(held).epoch).toBe(epoch)
    expect(await text(command($, 'router opus'))).toContain('"opus" is not a router')
  })
  test('a reading that returns after a switch is dropped: it is not recorded and not said', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); const asked = scripted(w, { local: NWHO, jev: JEV }); await start($)
    await command($, 'router nobodywho')
    let switched = false
    // the person switches while the first request of the reading is in flight
    w.duringRun = async argv => { if (argv[0] === 'decision' && !switched) { switched = true; await command($, 'router off') } }
    await prompt($, ORDINARY)
    expect(switched).toBe(true)
    expect(asked.length).toBeGreaterThan(1)
    expect(ledger(held).routing ?? []).toHaveLength(0)
    expect(w.submitted.at(-1)!.context.every(c => !c.includes('router'))).toBe(true)
    expect(routerState(held)).toMatchObject({ mode: 'OFF', last: null })
  })
  test('switching never moves the main model or its effort, in either profile', { options: { cobaltStrict: true, profile: 'SONNET_LED' } }, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); scripted(w, { local: NWHO, jev: JEV }); await start($)
    for (const mode of ['nobodywho', 'jev', 'off', 'jev', 'nobodywho']) {
      await command($, `router ${mode}`)
      await prompt($, `${ORDINARY} <${mode}>`)
      await step($, SONNET, { effort: 'medium' })
      expect(w.efforts.at(-1)).toEqual({ model: SONNET, effort: 'medium' })
      await step($, 'claude-opus-5-5', { effort: 'high' })
      expect(w.efforts.at(-1)).toEqual({ model: SONNET, effort: 'high' })
    }
    expect(ledger(held).warnings.filter(x => x.startsWith('EFFORT'))).toEqual([])
    expect(w.configured).toEqual([])
    expect(w.spawns).toHaveLength(0)
  })
  test('a task in progress is not re-routed, and neither are tool calls or helpers', LED, async ($, on) => {
    const w = world(on); const asked = scripted(w, { local: NWHO }); await start($)
    await command($, 'router nobodywho')
    await prompt($, ORDINARY)
    expect(asked).toHaveLength(11)
    await progress($, { action: 'plan', milestones: FIVE })
    await prompt($, 'Also handle the empty-table case in the same change.')
    await $.tool.call({ tool: 'Read', file_path: '/work/example/src/export.ts', tool_use_id: 'r1' } as never)
    await $.tool.call({ tool: 'Bash', command: 'git status', tool_use_id: 'b1' } as never)
    await $.tool.call({ tool: 'Edit', file_path: '/work/example/src/export.ts', old_string: 'a', new_string: 'b', tool_use_id: 'e1' } as never)
    expect(asked).toHaveLength(11)
  })
  test('with no word and someone to ask, the engine\'s dialog chooses; dismissed, it only reports', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); scripted(w, { local: NWHO, jev: JEV }); await start($)
    w.answer = 'NOBODYWHO'
    expect(await text(command($, 'router'))).toContain('ROUTER / NOBODYWHO · LOCAL')
    expect(w.asked.at(-1)).toContain('Which router should advise this session?')
    expect(routerState(held).mode).toBe('NOBODYWHO')
    w.answer = null
    const reply = await text(command($, 'router'))
    expect(reply).toContain('ROUTER / NOBODYWHO · LOCAL')
    expect(reply).toContain('Switch with /cockpit router off | nobodywho | jev')
    expect(routerState(held).mode).toBe('NOBODYWHO')
  })
  test('the pane names the router in SONNET_LED, and in the legacy profile only once one is selected', { options: { orchestration: true } }, async ($, on) => {
    const w = world(on); scripted(w, { local: NWHO }); await start($)
    const pane = async () => { const p = await mountPane($, 'terminal', 120); const rows = (await rowsOf(p)).join('\n'); await p.unmount(); return rows }
    expect(await pane()).not.toContain('ROUTER')
    await command($, 'router nobodywho')
    expect(await pane()).toContain('NOBODYWHO · LOCAL · advisory · no decision yet')
  })
  test('the router is not a setting: nothing is stored beyond the session and no configuration is written', LED, async ($, on) => {
    const w = world(on); scripted(w, { local: NWHO, jev: JEV }); await start($)
    await command($, 'router jev'); await command($, 'router nobodywho')
    expect(w.storeWrites.filter(s => s.key === 'prefs' || JSON.stringify(s.value).includes('NOBODYWHO') && s.key !== 'ledger-index' && !s.key.startsWith('ledger:'))).toEqual([])
    expect(w.configured).toEqual([])
  })
})

describe('the session router: review findings', () => {
  test('outside a planned task every prompt is a task of its own, and is asked about', LED, async ($, on) => {
    const w = world(on); const asked = scripted(w, { local: NWHO }); await start($)
    await command($, 'router nobodywho')
    await prompt($, ORDINARY)
    await prompt($, 'Now do the same for the import dialog as well.')
    await prompt($, 'go on')
    // two prompts long enough to be tasks: two readings; the third names no task
    expect(asked).toHaveLength(1 + 10 + 10)
  })
  test('a configuration directory inside the project is refused: a repository cannot choose where the router sends', { options: { orchestration: true, profile: 'SONNET_LED', routerConfigDir: '/work/example/.router' } }, async ($, on) => {
    const w = world(on); scripted(w, { jev: { provider: 'jev', kind: 'disabled' } }); await start($)
    const reply = await text(command($, 'router jev'))
    expect(reply).toContain('routerConfigDir was NOT used because it is inside this project')
    await prompt($, ORDINARY)
    expect(routerRuns(w).length).toBeGreaterThan(1)
    expect(routerRuns(w).every(r => r.env === undefined)).toBe(true)
  })
  for (const [dir, why] of [['/work/example', 'the project itself'], ['/work', 'a directory that contains the project']] as const) {
    test(`a configuration directory that is ${why} is refused`, { options: { orchestration: true, profile: 'SONNET_LED', routerConfigDir: dir } }, async ($, on) => {
      const w = world(on); scripted(w, { jev: JEV }); await start($)
      expect(await text(command($, 'router jev'))).toContain('routerConfigDir was NOT used')
      expect(routerRuns(w).every(r => r.env === undefined)).toBe(true)
    })
  }
  test('a configuration directory with a parent segment is not an option at all', { options: { orchestration: true, profile: 'SONNET_LED', routerConfigDir: '/home/op/../../work/example/.router' } }, async ($, on) => {
    const w = world(on); scripted(w, { jev: JEV }); await start($)
    expect(await text(command($, 'router jev'))).toContain('no routerConfigDir is set')
    expect(routerRuns(w).every(r => r.env === undefined)).toBe(true)
  })
  test('~ is resolved from HOME', { options: { orchestration: true, profile: 'SONNET_LED', routerConfigDir: '~/.config/cobalt-cockpit/router-jev' } }, async ($, on) => {
    const w = world(on, { env: { HOME: '/home/op' } }); scripted(w, { jev: JEV }); await start($)
    expect(await text(command($, 'router jev'))).toContain('with the router configuration at /home/op/.config/cobalt-cockpit/router-jev')
    expect(routerRuns(w).at(-1)!.env).toEqual({ DECISION_ROUTER_CONFIG_DIR: '/home/op/.config/cobalt-cockpit/router-jev' })
  })
  test('without HOME a ~ directory is not used, and the reply does not claim it was', { options: { orchestration: true, profile: 'SONNET_LED', routerConfigDir: '~/.config/cobalt-cockpit/router-jev' } }, async ($, on) => {
    const w = world(on, { env: { HOME: '' } }); scripted(w, { jev: JEV }); await start($)
    const reply = await text(command($, 'router jev'))
    expect(reply).toContain('routerConfigDir was NOT used because HOME is not set')
    expect(routerRuns(w).every(r => r.env === undefined)).toBe(true)
  })
  test('only a command the person typed switches the router', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); const asked = scripted(w, { jev: JEV }); await start($)
    for (const kind of ['task-notification', 'scheduled-trigger']) {
      const reply = String((await $.command.run({ command: 'cockpit', args: 'router jev', origin: { kind }, presentation: { isFullscreen: true, columns: 120 } } as never)).text)
      expect(reply).toContain('switched only by a command you type')
      expect(routerState(held).mode).toBe('OFF')
    }
    expect(asked).toHaveLength(0)
    // it may still be read
    expect(String((await $.command.run({ command: 'cockpit', args: 'router', origin: { kind: 'task-notification' }, presentation: { isFullscreen: true, columns: 120 } } as never)).text)).toContain('ROUTER / OFF')
    expect(w.asked).toHaveLength(0)
  })
  test('after a switch to OFF mid-reading, nothing is kept and the next task asks nothing', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); const asked = scripted(w, { local: NWHO }); await start($)
    await command($, 'router nobodywho')
    expect(asked).toHaveLength(1)
    // the person switches off after the reading has begun and before its last look at the mode
    let switched = false
    w.duringRun = async argv => { if (argv[0] === 'decision' && !switched) { switched = true; await command($, 'router off') } }
    await prompt($, ORDINARY)
    // the requests that had started are answered into nothing: no decision, no advice, OFF
    expect(routerState(held)).toMatchObject({ mode: 'OFF', last: null })
    expect(ledger(held).routing ?? []).toHaveLength(0)
    expect(w.submitted.at(-1)!.context.every(c => !c.includes('router'))).toBe(true)
    // and the next task asks nothing at all
    const n = asked.length
    await prompt($, 'Rename the export helper and update both callers.')
    expect(asked).toHaveLength(n)
  })
  test('a session that ends leaves no router selected for what follows', JEV_DIR, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); const asked = scripted(w, { jev: JEV }); await start($)
    for (const reason of ['clear', 'other']) {
      await command($, 'router jev')
      expect(routerState(held).mode).toBe('JEV')
      const n = asked.length
      await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } } as never)
      expect(routerState(held)).toMatchObject({ mode: 'OFF', last: null, link: 'unchecked' })
      await prompt($, `${ORDINARY} after ${reason}`)
      expect(asked).toHaveLength(n)
    }
  })
  test('a withheld prompt does not make a connected provider look down', JEV_DIR, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); scripted(w, { jev: JEV }); await start($)
    await command($, 'router jev')
    await prompt($, 'Deploy to staging with DATABASE_URL=postgres://app:hunter2@db.internal/app and report back.')
    expect(routerState(held)).toMatchObject({ link: 'connected', asked: 0, fallbacks: 1 })
    expect(await text(command($, 'version'))).toContain('ROUTER / JEV · CONNECTED')
  })
})

describe('what JEV is shown', () => {
  test('vocabulary words and a size bucket only: no name, path, sentence or number leaves', () => {
    const prompt = 'Debug the intermittent race in /srv/acme-billing/src/payments.ts for Dana Whitfield, ticket 48211, then add tests'
    const state = routerStateOf(prompt, 'JEV')!
    expect(state).toBe('task keywords: debug, intermittent, race, add, tests; size: short')
    for (const leaked of ['acme', 'billing', 'payments', 'Dana', 'Whitfield', '48211', '/srv']) expect(state).not.toContain(leaked)
    expect(routerStateOf(prompt, 'NOBODYWHO')).toContain('acme-billing')
  })
  test('a prompt with no vocabulary word, or a credential anywhere, asks nobody', () => {
    expect(routerStateOf('Please make the thing nicer for everyone today', 'JEV')).toBeNull()
    expect(routerStateOf(`Fix the build with ${join('AS', 'IA', 'QWERTY0123456789')} in it`, 'JEV')).toBeNull()
  })
  test('every request JEV is sent carries only the keyword state', () => {
    const state = routerStateOf('Refactor the module interface across every file in the codebase', 'JEV')!
    for (const call of callsFor(state)) expect(JSON.parse(call.body).state).toBe(state)
    expect(state.length).toBeLessThan(120)
  })
})
