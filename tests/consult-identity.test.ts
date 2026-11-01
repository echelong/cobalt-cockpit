// v0.5.3 M3: only Cobalt's own architect can run an admitted consultation. A name that merely ends in `:architect`
// (another plugin's agent, a project agent) is an unrelated agent and cannot take the consultation's task or clear a review.

import { describe, expect, test } from 'claude-code/testing'
import { roleOf } from '../hooks/orchestra'
import type { Ledger, Task } from '../types'
import { FIVE, GATE_NAMES, hostState, progress, prompt, start, spawnWorld as world } from './world'

type Engine = Parameters<typeof start>[0]
const SONNET = 'claude-sonnet-5-5'
const LED = { options: { orchestration: true, profile: 'SONNET_LED' } }
const SWARM = 'mcp__cobalt-cockpit__swarm'
const GO = 'RATIONALE: nothing blocking.\nDECISION: GO\nFINDINGS: none above medium.'
let seq = 0
const spawn = ($: Engine, description: string, subagentType: string, provider: unknown = { plugin: 'cobalt-cockpit', tier: 'user' }) => $.agent.spawn({ prompt: 'brief', description, subagentType, tool_use_id: `ci-${++seq}`, parentModel: SONNET, provider, background: true, fork: false } as never)
const ledger = (h: ReturnType<typeof hostState>) => h.get('run-ledger')!.value as Ledger
const task = (h: ReturnType<typeof hostState>) => h.get('task')!.value as Task
const releasePacket = { action: 'consult', ground: 'release', objective: 'Release v0.5.3', architecture: 'Plugin hooks', locations: ['hooks/consult.ts'], risk: 'Broken admission', question: 'Approve the release?' }

describe('M3: the architect role is Cobalt\'s own agent', () => {
  test('roleOf', () => {
    expect(roleOf('cobalt-cockpit:architect')).toBe('ARCHITECT')
    for (const t of ['evil:architect', 'other-plugin:architect', 'architect', 'a:b:architect', 'cobalt-cockpit:architect-evil', 'Cobalt-Cockpit:architect', 'cobalt-cockpit-fake:architect']) expect(roleOf(t)).toBe('AGENT')
    expect(roleOf('cobalt-cockpit:scout')).toBe('SCOUT')
    expect(roleOf('superpowers:code-reviewer')).toBe('REVIEWER')
  })
})

describe('M3: an unrelated :architect agent through the host', () => {
  test('cannot take an admitted release consultation, and the review stays open', LED, async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await prompt($, 'Have Opus review the release candidate before we tag')
    await progress($, { action: 'plan', milestones: FIVE })
    for (const m of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone: m })
    for (const g of GATE_NAMES) await progress($, { action: 'gate', gate: g, state: 'na', evidence: 'fixture' })
    expect(String((await $.tool.call({ tool: SWARM, ...releasePacket } as never)).result)).toContain('OPUS ADMITTED')
    const id = ledger(held).consults!.at(-1)!.id
    for (const type of ['evil:architect', 'architect', 'other-plugin:architect']) {
      const r = await spawn($, `[task:${id}] Opus consultation`, type)
      expect(r.deny).toContain('cobalt-cockpit:architect')
      expect(r.agentId).toBeUndefined()
    }
    expect(w.spawns).toHaveLength(0)
    expect(task(held).review?.state).not.toBe('adjudicated')
    // the exact type from a definition the host does not attribute to this plugin (a user's or project's agent, another plugin) is refused too
    for (const provider of [{ plugin: 'other-plugin', tier: 'user' }, { plugin: 'engine', tier: 'core' }, { plugin: 'cobalt-cockpit-fake', tier: 'user' }, {}, null, 'cobalt-cockpit']) {
      const r = await spawn($, `[task:${id}] Opus consultation`, 'cobalt-cockpit:architect', provider)
      expect([JSON.stringify(provider), r.deny ?? 'ALLOWED']).toEqual([JSON.stringify(provider), expect.stringContaining('provided by this plugin')])
      expect(r.agentId).toBeUndefined()
    }
    expect(w.spawns).toHaveLength(0)
    // the real architect still can
    const ok = await spawn($, `[task:${id}] Opus consultation`, 'cobalt-cockpit:architect')
    expect(ok.deny).toBeUndefined()
    await $.turn.complete({ agentId: ok.agentId, turnId: 't1', reason: 'answer', answer: GO, durationMs: 20, isAborted: false } as never)
    expect(w.spawns).toHaveLength(1)
  })
})
