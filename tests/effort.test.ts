// The dynamic reasoning policy, as arithmetic. Nothing here calls a model or
// touches state: every assertion is about what a task deserves, what a model
// can really honour, and how a failing task moves up one step at a time.

import { describe, expect, test } from 'claude-code/testing'
import {
  BASE_EFFORT,
  DECLARED_CAPABILITY,
  DEFAULT_CEILING,
  EFFORT_LEVELS,
  MAX_ESCALATIONS,
  UNKNOWN_CAPABILITY,
  capabilityFor,
  chooseEffort,
  clampToCapability,
  effortPolicyText,
  effortRank,
  escalationFor,
  escalationLine,
  factsFromRole,
  hostEffort,
  settingsEffort,
  isEffortLevel,
  isEffortRequest,
  modelFamily,
  nextEffort,
  launchFallback,
  observeCapability,
  selectEffort,
  selectModel,
  supportsEffort,
} from '../hooks/effort'

describe('effort vocabulary', () => {
  test('the levels are ordered weakest first', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortRank('low')).toBeLessThan(effortRank('xhigh'))
    expect(effortRank('max')).toBeGreaterThan(effortRank('high'))
  })
  test('a level and AUTO are recognized, anything else is not', () => {
    for (const level of EFFORT_LEVELS) expect(isEffortLevel(level)).toBe(true)
    expect(isEffortLevel('MAX')).toBe(false)
    expect(isEffortRequest('AUTO')).toBe(true)
    expect(isEffortRequest('high')).toBe(true)
    expect(isEffortRequest('auto')).toBe(false)
    expect(isEffortLevel(undefined)).toBe(false)
  })
  test('a model id is reduced to its family, or none', () => {
    expect(modelFamily('claude-opus-5-5')).toBe('OPUS')
    expect(modelFamily('claude-sonnet-5-5')).toBe('SONNET')
    expect(modelFamily('claude-haiku-5-5')).toBe('HAIKU')
    expect(modelFamily('some-other-model')).toBeNull()
  })
})

describe('declared capability and observation', () => {
  test('the declared baseline is conservative: Haiku never assumes xhigh', () => {
    expect(DECLARED_CAPABILITY.HAIKU).toEqual(['low', 'medium', 'high'])
    expect(DECLARED_CAPABILITY.SONNET).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(DECLARED_CAPABILITY.OPUS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(UNKNOWN_CAPABILITY).toEqual(['low', 'medium', 'high'])
  })
  test('capability prefers configured over observed over declared', () => {
    const declared = capabilityFor('claude-opus-5-5')
    expect(declared.source).toBe('declared')
    expect(declared.ceiling).toBe('max')
    const observed = capabilityFor('claude-opus-5-5', { 'claude-opus-5-5': ['low', 'high'] })
    expect(observed.source).toBe('observed')
    expect(observed.ceiling).toBe('high')
    const configured = capabilityFor('claude-opus-5-5', { 'claude-opus-5-5': ['low', 'high'] }, { 'claude-opus-5-5': ['low'] })
    expect(configured.source).toBe('configured')
    expect(configured.ceiling).toBe('low')
  })
  test('an unknown model family gets the common core, not Opus', () => {
    const unknown = capabilityFor('mystery-model')
    expect(unknown.tier).toBeNull()
    expect(unknown.allowed).toEqual(['low', 'medium', 'high'])
  })
  test('observation records a level that was honoured and drops one that was not', () => {
    const honoured = observeCapability({}, 'claude-sonnet-5-5', 'xhigh', 'xhigh')
    expect(honoured['claude-sonnet-5-5']).toContain('xhigh')
    const downgraded = observeCapability(honoured, 'claude-sonnet-5-5', 'max', 'xhigh')
    expect(downgraded['claude-sonnet-5-5']).not.toContain('max')
    expect(downgraded['claude-sonnet-5-5']).toContain('xhigh')
  })
  test('a level applied above the requested one says nothing about the requested one', () => {
    const before = { 'claude-sonnet-5-5': ['medium', 'high'] as const }
    // an override ran the request at high: low was neither honoured nor refused
    const overridden = observeCapability(before, 'claude-sonnet-5-5', 'low', 'high')
    expect(overridden['claude-sonnet-5-5']).toEqual(['medium', 'high'])
    // and a model with no observation yet gains none from it
    expect(observeCapability({}, 'claude-haiku-5-5', 'low', 'medium')).toEqual({})
  })
  test('an honoured level is recorded once, however often it is seen', () => {
    const once = observeCapability({}, 'claude-haiku-5-5', 'high', 'high')
    expect(observeCapability(once, 'claude-haiku-5-5', 'high', 'high')['claude-haiku-5-5']).toEqual(['low', 'medium', 'high'])
  })
  test('a model that cannot reach the level names the fallback, never hides it', () => {
    const haiku = capabilityFor('claude-haiku-5-5')
    expect(supportsEffort(haiku, 'low')).toBe(true)
    expect(supportsEffort(haiku, 'max')).toBe(false)
    const high = clampToCapability('max', haiku)
    expect(high.applied).toBe('high')
    expect(high.fallbackReason).toContain('not supported')
    const exact = clampToCapability('medium', haiku)
    expect(exact.applied).toBe('medium')
    expect(exact.fallbackReason).toBeNull()
  })
})

describe('what a task deserves', () => {
  test('extractive work is light, engineering is medium, hard reasoning is heavy', () => {
    expect(selectEffort({ tier: 'HAIKU', inventory: true }).effort).toBe('low')
    expect(selectEffort({ tier: 'SONNET', feature: true }).effort).toBe('medium')
    expect(selectEffort({ tier: 'SONNET', refactor: true }).effort).toBe('medium')
    expect(selectEffort({ tier: 'OPUS', debug: true }).effort).toBe('xhigh')
    expect(selectEffort({ tier: 'OPUS', security: true }).effort).toBe('xhigh')
    expect(selectEffort({ tier: 'OPUS', architecture: true }).effort).toBe('high')
    expect(selectEffort({ tier: 'OPUS', extraordinary: true }).effort).toBe('max')
  })
  test('a tier baseline is used when the task classifies itself not at all', () => {
    for (const tier of ['HAIKU', 'SONNET', 'OPUS'] as const) expect(selectEffort({ tier }).effort).toBe(BASE_EFFORT[tier])
  })
  test('a named class never exceeds its own tier ceiling', () => {
    // debug is xhigh, above Haiku's ceiling, so Haiku gets the ceiling, not xhigh.
    expect(selectEffort({ tier: 'HAIKU', debug: true }).effort).toBe('high')
  })
  test('a failure raises the level by exactly one step, however often it repeated', () => {
    const once = selectEffort({ tier: 'SONNET', feature: true, failedAttempts: 1 })
    expect(once.effort).toBe('high')
    // One step only: a repeated failure does not jump two rungs at selection
    // time. Further climbing is escalationFor's job, one step per retry.
    const twice = selectEffort({ tier: 'SONNET', feature: true, failedAttempts: 2 })
    expect(twice.effort).toBe('high')
    expect(twice.reason).toContain('failed 2 times')
    const failed = selectEffort({ tier: 'OPUS', feature: true, verificationFailed: true })
    expect(failed.effort).toBe('high')
  })
  test('routing: architecture to Opus, extractive to Haiku, the rest to Sonnet', () => {
    expect(selectModel({ architecture: true }).tier).toBe('OPUS')
    expect(selectModel({ inventory: true }).tier).toBe('HAIKU')
    expect(selectModel({ recon: true }).tier).toBe('HAIKU')
    expect(selectModel({ feature: true }).tier).toBe('SONNET')
  })
  test('a role maps to the work it does, read or write', () => {
    expect(factsFromRole('Scout')).toMatchObject({ inventory: true })
    expect(factsFromRole('utility')).toMatchObject({ extraction: true })
    expect(factsFromRole('reviewer')).toMatchObject({ verification: true })
    expect(factsFromRole('worker')).toMatchObject({ feature: true })
    expect(factsFromRole('explorer')).toMatchObject({ inspection: true })
    expect(factsFromRole('unknown-role', 'write')).toMatchObject({ feature: true })
  })
})

describe('resolving a request against a capability', () => {
  test('AUTO selects from the task; a named level is taken as-is', () => {
    const sonnet = capabilityFor('claude-sonnet-5-5')
    const auto = chooseEffort('AUTO', { tier: 'SONNET', feature: true }, sonnet)
    expect(auto.selected).toBe('medium')
    expect(auto.applied).toBe('medium')
    expect(auto.source).toBe('auto')
    const named = chooseEffort('xhigh', { tier: 'SONNET' }, sonnet)
    expect(named.selected).toBe('xhigh')
    expect(named.applied).toBe('xhigh')
    expect(named.source).toBe('manual')
  })
  test('the operator ceiling caps a request and the reason says so', () => {
    const opus = capabilityFor('claude-opus-5-5')
    const capped = chooseEffort('max', { tier: 'OPUS' }, opus, 'high')
    expect(capped.selected).toBe('high')
    expect(capped.applied).toBe('high')
    expect(capped.reason).toContain('ceiling')
  })
  test('a requested level is preserved even when the applied one differs', () => {
    const haiku = capabilityFor('claude-haiku-5-5')
    const resolved = chooseEffort('max', { tier: 'HAIKU' }, haiku)
    expect(resolved.requested).toBe('max')
    expect(resolved.applied).toBe('high')
    expect(resolved.source).toBe('fallback')
    expect(resolved.fallbackReason).toContain('not supported')
  })
  test('the default ceiling is max', () => {
    expect(DEFAULT_CEILING).toBe('max')
  })
})

describe('escalation, one step at a time', () => {
  test('nothing failing does not escalate', () => {
    const c = capabilityFor('claude-sonnet-5-5')
    expect(escalationFor({}, { tier: 'SONNET', effort: 'medium' }, c).kind).toBe('none')
  })
  test('within a tier, the next level up is one step', () => {
    const c = capabilityFor('claude-sonnet-5-5')
    const step = escalationFor({ failedAttempts: 1 }, { tier: 'SONNET', effort: 'medium' }, c)
    expect(step).toMatchObject({ kind: 'effort', to: 'high' })
  })
  test('at the tier ceiling the next step is a tier, not a jump to the top', () => {
    const c = capabilityFor('claude-sonnet-5-5')
    const step = escalationFor({ failedAttempts: 1 }, { tier: 'SONNET', effort: 'xhigh' }, c)
    expect(step).toMatchObject({ kind: 'tier', to: 'OPUS' })
  })
  test('Opus at max stops rather than looping, and a budget bounds the climb', () => {
    const c = capabilityFor('claude-opus-5-5')
    const top = escalationFor({ failedAttempts: 1 }, { tier: 'OPUS', effort: 'max' }, c)
    expect(top.kind).toBe('none')
    expect(top.reason).toContain('ceiling')
    const budget = escalationFor({ failedAttempts: MAX_ESCALATIONS + 1 }, { tier: 'SONNET', effort: 'medium' }, c)
    expect(budget.kind).toBe('none')
    expect(budget.reason).toContain('budget')
  })
  test('nextEffort walks the capability and stops at its ceiling', () => {
    const haiku = capabilityFor('claude-haiku-5-5')
    expect(nextEffort('low', haiku)).toBe('medium')
    expect(nextEffort('high', haiku)).toBeNull()
  })
  test('an escalation line reads LOW → MEDIUM', () => {
    expect(escalationLine({ from: 'low', to: 'medium', reason: 'x', at: 0 })).toBe('LOW → MEDIUM')
  })
})

describe('a natively launched level against what the engine resolved', () => {
  const sonnet = capabilityFor('claude-sonnet-5-5')
  const named = (level: 'low' | 'medium' | 'high' | 'xhigh' | 'max') => chooseEffort(level, { tier: 'SONNET' }, sonnet)
  test('the engine resolving the launched level is no fallback', () => {
    expect(launchFallback(named('high'), 'high', 'high', 'claude-sonnet-5-5')).toBeNull()
  })
  test('a level the engine resolved lower is named with both levels, never hidden', () => {
    const reason = launchFallback(named('high'), 'high', 'medium', 'claude-sonnet-5-5')
    expect(reason).toContain('engine resolved medium')
    expect(reason).toContain('requested high')
  })
  test('an engine override above the launched level is named too', () => {
    expect(launchFallback(named('low'), 'low', 'high', 'claude-sonnet-5-5')).toContain('engine resolved high')
  })
  test('a model the engine sends no effort is said to get none', () => {
    expect(launchFallback(named('high'), 'high', undefined, 'claude-haiku-5-5')).toContain('no effort')
  })
  test('a capability clamp made at launch keeps its own reason', () => {
    // max is above Sonnet's declared capability: launched at xhigh, and the engine gave xhigh
    const clamped = named('max')
    expect(clamped.applied).toBe('xhigh')
    expect(launchFallback(clamped, 'xhigh', 'xhigh', 'claude-sonnet-5-5')).toContain('not supported')
  })
  test('a clamp the capability map no longer explains is still named', () => {
    // launched at high when xhigh was clamped; the map has since moved on
    const now = chooseEffort('xhigh', { tier: 'SONNET' }, capabilityFor('claude-sonnet-5-5', { 'claude-sonnet-5-5': ['low', 'medium'] }))
    expect(now.applied).toBe('medium')
    expect(launchFallback(now, 'high', 'high', 'claude-sonnet-5-5')).toBe('xhigh was clamped to high when the agent was launched')
  })
})

describe('the main loop level is the host own: what is known of where it came from', () => {
  test('the origin is named only when an observed selection agrees with the resolved level', () => {
    expect(hostEffort('low', { env: 'low' })).toEqual({ source: 'env', selected: 'low', reason: 'host-resolved low; matches CLAUDE_CODE_EFFORT_LEVEL', capReason: null })
    expect(hostEffort('max', { command: 'MAX' })).toMatchObject({ source: 'session', selected: 'max' })
    expect(hostEffort('medium', { command: 'med' })).toMatchObject({ source: 'session', selected: 'medium' })
    expect(hostEffort('xhigh', { settings: 'xhigh' })).toMatchObject({ source: 'settings', selected: 'xhigh' })
  })

  test('the engine order of precedence is the order looked in: the variable, the session, the settings', () => {
    expect(hostEffort('high', { env: 'high', command: 'high', settings: 'high' }).source).toBe('env')
    expect(hostEffort('high', { command: 'high', settings: 'high' }).source).toBe('session')
    // a selection that does not agree with the level is not what decided it
    expect(hostEffort('high', { env: 'low', command: 'medium', settings: 'high' }).source).toBe('settings')
  })

  test('a level no observed selection accounts for is the host own, and no selection is invented', () => {
    for (const signals of [{}, { settings: 'high' }, { env: 'bogus' }, { command: 'ultracode' }, { command: null, settings: null, cap: null }]) {
      const read = hostEffort('low', signals)
      expect(read).toMatchObject({ source: 'host', selected: null, capReason: null })
      expect(read.reason).toContain('no observed selection matches it')
    }
    // an indistinguishable host default is not taken for an explicit choice
    expect(hostEffort('high')).toMatchObject({ source: 'host', selected: null })
  })

  test('a cap of the settings explains a selection above it, and only then', () => {
    const capped = hostEffort('medium', { settings: 'xhigh', cap: 'medium' })
    expect(capped).toMatchObject({ source: 'settings', selected: 'xhigh' })
    expect(capped.reason).toBe('host-resolved medium; the settings effortLevel names xhigh, capped by maxEffortLevel medium')
    expect(capped.capReason).toBe('maxEffortLevel medium capped xhigh (the settings effortLevel)')
    expect(hostEffort('medium', { env: 'max', cap: 'medium' })).toMatchObject({ source: 'env', selected: 'max' })
    // a selection at or under the cap, a level that is not the cap, and `max` (no cap) explain nothing
    expect(hostEffort('low', { settings: 'xhigh', cap: 'medium' }).source).toBe('host')
    expect(hostEffort('medium', { settings: 'low', cap: 'medium' }).source).toBe('host')
    expect(hostEffort('high', { settings: 'xhigh', cap: 'max' }).source).toBe('host')
  })

  test('auto and unset in the variable are the engine choice of the model default', () => {
    expect(hostEffort('high', { env: 'auto', settings: 'low' })).toMatchObject({ source: 'env', selected: null, reason: 'host-resolved high; CLAUDE_CODE_EFFORT_LEVEL=auto selects the model default' })
    expect(hostEffort('high', { env: ' UNSET ' }).reason).toContain('CLAUDE_CODE_EFFORT_LEVEL=unset')
  })

  test('a model the engine sends no effort, or a numeric level, is said as it is', () => {
    expect(hostEffort(undefined, { settings: 'high' })).toMatchObject({ source: 'host', selected: null })
    expect(hostEffort(undefined).reason).toContain('host-resolved no effort')
    expect(hostEffort(42, { env: 'high' })).toMatchObject({ source: 'host', selected: null })
  })

  test('the settings are read for the model: its own entry first, then the top level', () => {
    const settings = { effortLevel: 'low', maxEffortLevel: 'high', modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' }, 'claude-sonnet-5-5[1m]': { maxEffortLevel: 'medium' } } }
    expect(settingsEffort(settings, 'claude-opus-5-5')).toEqual({ level: 'xhigh', cap: 'high' })
    expect(settingsEffort(settings, 'claude-opus-5-5[1m]')).toEqual({ level: 'xhigh', cap: 'high' })
    expect(settingsEffort(settings, 'claude-sonnet-5-5')).toEqual({ level: 'low', cap: 'medium' })
    expect(settingsEffort(settings, 'claude-haiku-5-5')).toEqual({ level: 'low', cap: 'high' })
    expect(settingsEffort({}, 'claude-opus-5-5')).toEqual({ level: null, cap: null })
    expect(settingsEffort({ modelSettings: ['not', 'a', 'table'], effortLevel: 7 }, 'claude-opus-5-5')).toEqual({ level: null, cap: null })
  })
})

describe('the policy the prompt states', () => {
  test('AUTO and MANUAL read differently, and the ceiling is named', () => {
    const auto = effortPolicyText('AUTO', 'max')
    expect(auto).toContain('Reasoning mode is AUTO')
    expect(auto).toContain('AUTO names a level from the task')
    expect(auto).toContain('ceiling for any request is MAX')
    expect(auto).toContain('requested and applied effort are recorded separately')
    expect(auto).toContain("A subagent's level is set on its Agent call from the assignment")
    expect(auto).toContain("The main loop's effort is the user's. Cockpit never sets or rewrites it")
    expect(effortPolicyText('MANUAL', 'high')).toContain("The main loop's effort is the user's")
    const manual = effortPolicyText('MANUAL', 'high')
    expect(manual).toContain('Reasoning mode is MANUAL')
    expect(manual).toContain('ceiling for any request is HIGH')
  })
})