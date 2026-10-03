import { describe, expect, test } from 'claude-code/testing'
import { command, hostState, mountHud, mountPane, planAndComplete, progress, prompt, rowsOf, start, world, bash , type World } from './world'
import { emptyLedger, exportJSON } from '../hooks/ledger'
import { replayStep, secretText } from '../hooks/replay'
import type { Ledger, ReplayStep } from '../types'

const request = async ($: Parameters<typeof start>[0], model: string, agentId?: string) => {
  const stream = $.turn.step({ turnId: 'public-turn', index: 0, model, effort: 'low', messageCount: 1, ...(agentId ? { agentId } : {}) } as never)
  let next = await stream.next()
  while (!next.done) next = await stream.next()
  return next.value
}
const spawn = ($: Parameters<typeof start>[0], model = 'opus') => $.agent.spawn({ prompt: 'Synthetic task', description: 'Synthetic task', tool_use_id: 'public-spawn', subagentType: 'cobalt-cockpit:worker', model, background: false, fork: false, parentModel: 'haiku', provider: { plugin: 'cobalt-cockpit' } } as never)

describe('public first run', () => {
  test('clean store, no NobodyWho, commands and progress work', async ($, on) => {
    const w = world(on, { players: {}, settings: {}, files: {}, env: {} }); const state = hostState(on, {})
    await start($)
    expect((state.get('run-ledger')?.value as Ledger).runs).toEqual([])
    expect(w.outbound).toEqual([])
    expect(w.toasts.join(' ')).not.toContain('BLOCKED')
    await command($, '')
    expect(w.opened).toContain('cobalt-cockpit')
    await $.command.run({ command: 'ledger', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } })
    expect(w.opened).toContain('cobalt-run-ledger')
    const pane = await mountPane($, 'terminal')
    expect((await rowsOf(pane)).join(' ')).not.toContain('LOCAL CONTROL')
    await pane.unmount()
    await prompt($, 'Synthetic task'); await planAndComplete($, 1)
    expect(await progress($, { action: 'status' })).toContain('20%')
    await bash($, 'git reset --hard')
    expect(w.asked.length).toBe(1)
    expect(w.ran.some(c => c['command'] === 'git reset --hard')).toBe(false)
  })
  test('Fable allowed through prompt, spawn, request, config and slash', async ($, on) => {
    const w = world(on, { model: 'fable' }); await start($)
    expect((await prompt($, 'Synthetic task')).drop).toBeUndefined()
    expect((await spawn($, 'fable')).deny).toBeUndefined()
    await request($, 'fable')
    expect(w.requests[0]?.model).toBe('fable')
    expect((await $.config.set({ key: 'model', value: 'fable' } as never)).deny).toBeUndefined()
    const result = await $.command.run({ command: 'model', args: 'fable', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
    expect(result.text).not.toContain('BLOCKED')
  })
  test('API authentication and user model choices pass unchanged', async ($, on) => {
    const w = world(on, { credential: { handle: 'synthetic-handle', kind: 'api-key' } }); await start($)
    expect((await prompt($, 'Synthetic task')).drop).toBeUndefined()
    await request($, 'haiku'); await spawn($, 'opus')
    expect(w.requests[0]?.model).toBe('haiku'); expect(w.spawns[0]?.['model']).toBe('opus')
  })
  test('strict preset is opt-in and constrains main and agents', { options: { cobaltStrict: true } }, async ($, on) => {
    const w = world(on); await start($); await request($, 'haiku'); const a = await spawn($); await request($, 'haiku', a.agentId)
    expect(w.requests.map(r => r.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect((await spawn($, 'fable')).deny).toContain('FABLE')
    expect((await $.config.set({ key: 'advisorModel', value: 'opus' } as never)).deny).toContain('advisor')
  })
  test('strict preset refuses API authentication', { options: { cobaltStrict: true } }, async ($, on) => {
    const w = world(on, { credential: { handle: 'synthetic-handle', kind: 'api-key' } }); await start($)
    expect((await prompt($, 'Synthetic task')).drop).toContain('API')
    await request($, 'opus'); expect(w.requests).toEqual([])
  })
  for (const players of [{ afplay: 'ok' }, {}] as World['players'][]) {
    test(`audio fallback ${'afplay' in players ? 'macOS' : 'no player'}`, async ($, on) => {
      const w = world(on, { players }); await start($); await prompt($, 'Synthetic task'); await planAndComplete($, 4); await w.clock.settle()
      if ('afplay' in players) expect(w.runs.some(r => r[0] === 'afplay')).toBe(true)
      const hud = await mountHud($, 'terminal', 30); expect((await rowsOf(hud)).length).toBeGreaterThan(0); await hud.unmount()
    })
  }
})

describe('public privacy boundaries', () => {
  test('credential variants are detected', () => {
    for (const value of ['token=synthetic', 'AWS_ACCESS_KEY_ID=synthetic', 'sk_test_synthetic', 'xoxb-synthetic', 'eyJsynthetic.payload.signature']) expect(secretText(value)).toBe(true)
  })
  test('restored malicious telemetry cannot export obvious secrets or control sequences', () => {
    const l = { ...emptyLedger(), warnings: ['password=synthetic-sensitive-value', '\x1b[31mplain'] }
    const out = exportJSON(l); expect(out).not.toContain('synthetic-sensitive-value'); expect(out).not.toContain('\\u001b')
  })
  for (const file of ['/work/.env', '/work/.npmrc', '/work/credentials.json', '/work/key.pem', '/work/.aws/config', '/work/.ssh/config']) {
    test(`replay refuses ${file}`, () => {
      const step = replayStep({ id: 'synthetic', file, before: 'sensitive', after: 'sensitive', kind: 'Write', scope: 'file', at: 1, runId: 'synthetic-run', agentId: 'unknown', turnId: 'synthetic-turn', omitted: false } as ReplayStep)
      expect(step.omitted).toBe(true); expect(step.before).toBe(''); expect(step.file).toBe('unknown')
    })
  }
})
