import { describe, expect, test } from 'claude-code/testing'
import { admitTask, bindAgent, emptySwarm, normalizeClaim, normalizeLiteralOwned, normalizeOwned, overlaps, ownershipAllows, submitTask } from '../hooks/swarm'
import { start, world } from './world'

// v0.8.0: a read claim that cannot be kept narrow is refused, never widened. A bracketed path is a literal file name,
// because `realpath` expands no pattern and the host runs no shell for it. Writers keep the conservative whole-repository
// lock they always had.

describe('a read claim that cannot be kept narrow', () => {
  test('a canonical absolute path is literal, so a bracketed name is a path and not a glob', () => {
    expect(normalizeLiteralOwned('/app/[id]/page.tsx')).toBe('/app/[id]/page.tsx')
    expect(normalizeLiteralOwned('/src/{a,b}.ts')).toBe('/src/{a,b}.ts')
    expect(normalizeClaim('/app/[id]/page.tsx')).toBe('/app/[id]/page.tsx')
    expect(normalizeOwned('/app/[id]/page.tsx')).toBe('*')
    // text that was never resolved keeps the conservative reading
    expect(normalizeClaim('app/[id]/page.tsx')).toBe('*')
    for (const bad of ['', '~/.ssh', '/src/**', '/src/?.ts', '/../outside']) expect(normalizeLiteralOwned(bad)).toBeNull()
  })
  test('a reader owns its bracketed path and nothing beside it', () => {
    const s = submitTask(emptySwarm(), { id: 'reader', tier: 'HAIKU', role: 'EXPLORER', objective: 'Inspect the page', owned: ['/app/[id]/page.tsx'], mode: 'read' }, 1).swarm
    const running = bindAgent(admitTask(s, 'reader', 2).swarm, 'reader', 'agent-reader', 3)
    expect(running.tasks[0]!.owned).toEqual(['/app/[id]/page.tsx'])
    expect(ownershipAllows(running, 'reader', '/app/[id]/page.tsx', 'read')).toBe(true)
    expect(ownershipAllows(running, 'reader', '/app/[id]/page.tsx.bak', 'read')).toBe(false)
    expect(ownershipAllows(running, 'reader', '/app/[id]/other.tsx', 'read')).toBe(false)
    expect(ownershipAllows(running, 'reader', '*', 'read')).toBe(false)
  })
  test('overlap is literal for bracketed claims; only the repository-wide claim is global', () => {
    expect(overlaps('/app/[id]/page.tsx', '/app/[id]')).toBe(true)
    expect(overlaps('/app/[id]/page.tsx', '/app/[id2]')).toBe(false)
    expect(overlaps('*', '/app/[id]/page.tsx')).toBe(true)
  })
  test('a writer\'s raw bracketed claim still locks the whole repository', () => {
    const s = submitTask(emptySwarm(), { id: 'writer', tier: 'SONNET', role: 'ENGINEER', objective: 'Write', owned: ['/app/[id]/page.tsx'], mode: 'write' }, 1).swarm
    expect(s.tasks[0]!.owned).toEqual(['*'])
  })
})

describe('through the swarm tool', () => {
  const SWARM = 'mcp__cobalt-cockpit__swarm'
  const options = { options: { orchestration: true, maxSubagents: 6, maxSonnetAgents: 3, maxHaikuAgents: 4 } }
  const call = ($: Parameters<typeof start>[0], input: Record<string, unknown>) => $.tool.call({ tool: SWARM, ...input } as never)
  test('a reader with no paths or an ambiguous one is refused; "*" must be written', options, async ($, on) => {
    world(on); await start($)
    const none = String((await call($, { action: 'assign', task_id: 'none', tier: 'SONNET', role: 'EXPLORER', objective: 'Read', owned_resources: [], mode: 'read' })).result)
    expect(none).toContain('READ SCOPE / a read task needs owned_resources')
    expect(none).toContain('Nothing was assigned.')
    for (const [id, claim] of [['glob', 'src/**/*.ts'], ['question', 'src/?.ts'], ['home', '~/notes']] as const) {
      const reply = String((await call($, { action: 'assign', task_id: id, tier: 'SONNET', role: 'EXPLORER', objective: 'Read', owned_resources: [claim], mode: 'read' })).result)
      expect([id, reply.includes('READ SCOPE /'), reply.includes('Nothing was assigned.')]).toEqual([id, true, true])
    }
    const star = String((await call($, { action: 'assign', task_id: 'whole', tier: 'SONNET', role: 'EXPLORER', objective: 'Read', owned_resources: ['*'], mode: 'read' })).result)
    expect(star).toContain('this read task claims *, the whole repository, as you wrote it.')
  })
})
