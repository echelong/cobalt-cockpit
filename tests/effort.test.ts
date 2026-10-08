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
  isEffortLevel,
  isEffortRequest,
  modelFamily,
  nextEffort,
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

describe('the policy the prompt states', () => {
  test('AUTO and MANUAL read differently, and the ceiling is named', () => {
    const auto = effortPolicyText('AUTO', 'max')
    expect(auto).toContain('Reasoning mode is AUTO')
    expect(auto).toContain('AUTO names a level from the task')
    expect(auto).toContain('ceiling for any request is MAX')
    expect(auto).toContain('requested and applied effort are recorded separately')
    const manual = effortPolicyText('MANUAL', 'high')
    expect(manual).toContain('Reasoning mode is MANUAL')
    expect(manual).toContain('ceiling for any request is HIGH')
  })
})