import { describe, expect, test } from 'claude-code/testing'
import { desiredRequest, HAIKU_MODEL, policyMismatch } from '../hooks/model-policy'
import { DEFAULT_LIMIT, limitOf, admitSpawn, orchestraRows, orchestrationText, roleOf } from '../hooks/orchestra'
import { swarmGraph, swarmTape } from '../hooks/field'
import { emptySwarm, submitTask, summarizeSwarm } from '../hooks/swarm'
import type { AgentStrip } from '../types'
import type { OrchestraView } from '../hooks/orchestra'

const agents = (n: number): AgentStrip[] => Array.from({ length: n }, (_, i) => ({ id: `H${i}`, title: 'Inventory', model: HAIKU_MODEL, effort: null, tool: 'Read', state: 'running', startedAt: 0, endedAt: null, role: 'SCOUT', seq: i + 1 }))
const view = (list: AgentStrip[]): OrchestraView => ({ meter: { percent: 0, tokens: 0, window: 0, model: 'claude-opus-5-5', effort: 'high' }, task: null, activity: { kind: 'IDLE', detail: '', isWorking: false, toolUseId: null, agents: [], at: 0 }, isWorking: true, agents: list, nwho: null, limit: DEFAULT_LIMIT, now: 10 })
const colors = { accent: 'accent', ok: 'success', bad: 'error', steel: 'steel' }

describe('elastic model policy and presentation', () => {
  test('Haiku is a genuine request tier with unspecified effort', () => {
    expect(desiredRequest('H1', 'HAIKU')).toEqual({ model: HAIKU_MODEL })
    expect(desiredRequest('S1')).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' })
    expect(desiredRequest()).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    expect(policyMismatch(HAIKU_MODEL, undefined, 'H1', 'HAIKU')).toBeNull()
    expect(policyMismatch('claude-sonnet-5-5', 'medium', 'H1', 'HAIKU')).not.toBeNull()
  })
  test('AUTO resource budget replaces the old three agent ceiling', () => {
    expect(limitOf(0)).toBe(DEFAULT_LIMIT)
    expect(DEFAULT_LIMIT).toBeGreaterThan(3)
    expect(limitOf(20)).toBe(20)
    expect(admitSpawn(4, 20)).toBeNull()
    expect(admitSpawn(20, 20)).not.toBeNull()
    expect(roleOf('cobalt-cockpit:scout')).toBe('SCOUT')
    expect(roleOf('cobalt-cockpit:utility')).toBe('UTILITY')
  })
  test('twenty Haiku agents are compressed, small pools retain identity', () => {
    const large = orchestraRows(view(agents(20)), 120, colors).map(r => r.map(s => s.text).join('')).join('\n')
    expect(large).toContain('HAIKU / POOL')
    expect(large).toContain('20 observed')
    expect(large.split('\n').length).toBeLessThan(10)
    const small = orchestraRows(view(agents(2)), 120, colors).map(r => r.map(s => s.text).join('')).join('\n')
    expect(small).toContain('SCOUT')
    expect(small).not.toContain('HAIKU / POOL')
  })
  test('field bounds pooled nodes and unavailable telemetry stays unknown', () => {
    let swarm = emptySwarm()
    for (let i = 0; i < 20; i++) swarm = submitTask(swarm, { id: `H${i}`, tier: 'HAIKU', role: 'Scout', objective: `scan ${i}`, owned: [`file${i}`] }, i).swarm
    const graph = swarmGraph(swarm)
    expect(graph?.branches.length).toBe(1)
    expect(graph?.branches[0]?.label).toContain('HAIKU 20')
    expect(graph?.label).toContain('queue 20')
    expect(swarmTape(swarm, 140)?.anchors.length).toBeLessThan(5)
    expect(summarizeSwarm(swarm).tokens).toBeNull()
    expect(summarizeSwarm(swarm).cost).toBeNull()
  })
  test('prompt preserves authority and observable compressed handoffs', () => {
    const prompt = orchestrationText(16)
    for (const term of ['Opus 5.5 high commander', 'Haiku 5.5', '[task:ID]', 'swarm action assign', 'escalate', 'read-only', 'Unknown']) expect(prompt).toContain(term)
  })
})
