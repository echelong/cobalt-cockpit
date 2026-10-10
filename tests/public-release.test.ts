import { describe, expect, test } from 'claude-code/testing'
import { command, hostState, mountHud, mountPane, planAndComplete, progress, prompt, rowsOf, start, world, bash , type World } from './world'
import { emptyLedger, exportJSON } from '../hooks/ledger'
import { replayStep, secretText } from '../hooks/replay'
import { carriesCredential, redactSecrets } from '../hooks/secrets'
import { routerStateOf } from '../hooks/router'
import { emptySwarm, finishTask, submitTask } from '../hooks/swarm'
import { packetOf, readScopeOf } from '../hooks/consult'
import type { Ledger, ReplayStep } from '../types'

const request = async ($: Parameters<typeof start>[0], model: string, agentId?: string) => {
  const stream = $.turn.step({ turnId: 'public-turn', index: 0, model, effort: 'low', messageCount: 1, ...(agentId ? { agentId } : {}) } as never)
  let next = await stream.next()
  while (!next.done) next = await stream.next()
  return next.value
}
let publicSeq = 0
const spawn = async ($: Parameters<typeof start>[0], model = 'opus') => {
  const taskId = `public-task-${++publicSeq}`
  await $.tool.call({ tool: 'mcp__cobalt-cockpit__swarm', action: 'assign', task_id: taskId, tier: 'SONNET', role: 'ENGINEER', objective: `Synthetic task ${taskId}`, scope: 'Synthetic task', owned_resources: [`/work/synthetic/${taskId}`], mode: 'read', dependencies: [], spawn_reason: 'Independent public fixture' } as never)
  return $.agent.spawn({ prompt: 'Synthetic task', tool_use_id: 'public-spawn', subagentType: 'cobalt-cockpit:worker', model, background: false, fork: false, parentModel: 'haiku', provider: { plugin: 'cobalt-cockpit' }, description: `[task:${taskId}] Synthetic task` } as never)
}

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

describe('credential shapes shared by every store and outgoing text', () => {
  const join = (...parts: string[]): string => parts.join('')
  test('AWS temporary (ASIA) and long-term (AKIA) key IDs are recognised everywhere', () => {
    for (const id of [join('AS', 'IA', 'QWERTY0123456789'), join('AK', 'IA', 'QWERTY0123456789')]) {
      expect(secretText(`id ${id}`)).toBe(true)
      expect(carriesCredential(`id ${id}`)).toBe(true)
      expect(redactSecrets(`id ${id} ok`)).toBe('id [redacted] ok')
    }
  })
  test('redaction keeps the useful state around a secret', () => {
    const out = redactSecrets(`Fix the uploader, api_key=${join('sk-', 'live-', 'abcdefgh12345678')} is in the log; sha 0123456789abcdef0123456789abcdef01234567`)
    expect(out).toBe('Fix the uploader, [redacted] is in the log; sha 0123456789abcdef0123456789abcdef01234567')
  })
  test('a task, its events and its handback never keep a credential shape', () => {
    const key = join('AS', 'IA', 'QWERTY0123456789')
    const { swarm } = submitTask(emptySwarm(), { id: 'a', tier: 'HAIKU', role: 'scout', objective: `Inventory files; password: hunter2hunter2 and ${key}`, spawnReason: `needs ${key}` }, 1)
    const done = finishTask(swarm, 'a', 'failed', { conclusion: `saw Bearer abcdefghijklmnop and ${key}`, evidence: [`token=abcdef12345`] }, 2)
    expect(JSON.stringify(done)).not.toMatch(/hunter2|QWERTY|abcdefghijklmnop|abcdef12345/)
    expect(JSON.stringify(done)).toContain('Inventory files')
  })
  test('a consultation packet is redacted before it is kept', () => {
    const key = join('AS', 'IA', 'QWERTY0123456789')
    const out = packetOf('architecture', { objective: `design ${key}`, decision: 'which?', risk: 'r', files: ['hooks/a.ts'], alternatives: ['x'] })
    expect('packet' in out && JSON.stringify(out.packet)).not.toContain('QWERTY')
  })
})

describe('credential filter hardening', () => {
  const join = (...parts: string[]): string => parts.join('')
  test('a private key is redacted through its END line, body included', () => {
    const body = Array.from({ length: 6 }, (_, n) => join('MIIEvQIBADAN', 'BgkqhkiG9w0BAQEFAASC').repeat(2) + n).join('\n')
    const out = redactSecrets(`before ${join('-----BEGIN ', 'PRIVATE KEY-----')}\n${body}\n${join('-----END ', 'PRIVATE KEY-----')} after`)
    expect(out).toBe('before [redacted] after')
    expect(redactSecrets(`${join('-----BEGIN RSA ', 'PRIVATE KEY-----')}\n${body}`)).toBe('[redacted]')
  })
  test('file locations with a line number are kept, never redacted, and never reach ownership as [redacted]', () => {
    const out = packetOf('security', { objective: 'review', decision: 'ok?', risk: 'r', files: ['hooks/auth.ts:120', 'tests/token-store.ts:12:3', 'src/password-reset.ts:42'] })
    if (!('packet' in out)) throw new Error(out.error)
    expect(readScopeOf(out.packet)).toEqual(['hooks/auth.ts', 'tests/token-store.ts', 'src/password-reset.ts'])
    expect(redactSecrets('Fix auth: login fails in hooks/auth.ts:120')).toBe('Fix auth: login fails in hooks/auth.ts:120')
    expect('error' in packetOf('security', { objective: 'a', decision: 'b', risk: 'c', files: [`src/${join('api', '_key', '=abc', 'def123456')}`] })).toBe(true)
  })
  test('hostile long input is bounded and fast', () => {
    for (const text of ['x://' + ':'.repeat(200_000), 'a-'.repeat(100_000), 'token'.repeat(40_000), 'eyJ-'.repeat(50_000), 'A'.repeat(200_000)]) {
      const started = performance.now()
      redactSecrets(text); carriesCredential(text); secretText(text)
      expect(performance.now() - started).toBeLessThan(250)
    }
    expect(carriesCredential('word '.repeat(10_000))).toBe(true)
  })
})

describe('credential filter, second review', () => {
  const join = (...parts: string[]): string => parts.join('')
  test('auth schemes and quoted multi-word values lose the whole value', () => {
    expect(redactSecrets(`Authorization: ${join('Ba', 'sic')} ${join('dXNlcjpw', 'YXNzd29yZA==')} end`)).not.toContain('dXNlcjpw')
    expect(redactSecrets(`password = "correct horse battery" end`)).toBe('[redacted] end')
    expect(secretText(`password: "ab cd"`)).toBe(true)
    expect(secretText(`"auth": "${join('dXNlcjpw', 'YXNzd29yZA==')}"`)).toBe(true)
    expect(secretText(`_auth=${join('dXNlcjpw', 'YXNzd29yZA==')}`)).toBe(true)
  })
  test('file references stay readable in free text', () => {
    for (const text of ['fails in src/token-store.ts:120', 'see hooks/auth.ts:120:3', 'Fix auth: login fails']) expect(redactSecrets(text)).toBe(text)
  })
  test('a secret cut by the scan limit is not left half-redacted', () => {
    const key = join('wJalrXUtnFEMI', 'K7MDENGbPxRfiCYEXAMPLEKEY'.slice(0, 27))
    const out = redactSecrets('a '.repeat(9_995) + key)
    expect(out).not.toContain(key.slice(0, 20))
  })
  test('hostile input just under each limit is fast in every filter', () => {
    for (const size of [19_999, 79_999]) for (const unit of ['x://:', 'a-', 'token', 'eyJ-', 'A']) {
      const text = unit.repeat(Math.ceil(size / unit.length)).slice(0, size)
      for (const run of [redactSecrets, carriesCredential, secretText]) {
        const started = performance.now(); run(text)
        expect([unit, size, performance.now() - started < 250]).toEqual([unit, size, true])
      }
    }
  })
  test('only a local router is ever shown the task line', () => {
    const line = 'Refactor the payments module across every file'
    expect(routerStateOf(line, 'NOBODYWHO')).toContain('payments')
    expect(routerStateOf(line, 'JEV')).not.toContain('payments')
    expect(routerStateOf(line, 'OFF' as never)).toBeNull()
  })
})
