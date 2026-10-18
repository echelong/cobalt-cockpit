// Cobalt Guard Calibration: the review, label and calibration subcommands of `/cockpit alerts`.
// Synthetic: nothing here shows that a person saw anything. Origins are typed by the test, never by a person.
import { expect, test } from 'claude-code/testing'
import { bounded, episodesOf, occKeyOf } from '../hooks/alerts'
import type { AlertRecord } from '../hooks/alerts'
import { FIVE, hostState, plays, progress, start, world } from './world'

const projectHash = async (cwd: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cobalt-cockpit/alerts/v1\0${cwd}`)))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
const rec = (key: string, over: Partial<AlertRecord> = {}): AlertRecord => ({ key, kind: 'run-blocked', taskId: 1, at: 1000, outcome: 'recorded', attempts: 0, channel: null, ...over })
/** A command typed at the terminal, or from the origin given. An origin passed as undefined stays undefined: a default parameter would turn it into the composer. */
const say = async ($: any, args: string, ...as: unknown[]) => String((await $.command.run({ command: 'cockpit', args, origin: as.length === 0 ? { kind: 'composer' } : as[0], presentation: { isFullscreen: true, columns: 120 } } as never) as { text?: string }).text)
const session = (on: any, id = 's1') => on('session.id', () => ({ value: id }))

const REFUSAL = 'Cockpit: an alert is labelled only by a command you type; nothing was changed.'
const REC = { guardRecordOnly: true }

// One earlier run-blocked incident, seeded as project history.
const seedOne = async (): Promise<{ store: Record<string, unknown>, project: string, id: string }> => {
  const project = await projectHash('/work/example')
  const store: Record<string, unknown> = {}
  const records = bounded([], rec('1@1:run-blocked:task', { taskId: 1, at: 900_000 }))
  const id = episodesOf(records)[0]!.id
  store[occKeyOf(project, id)] = { v: 1, records }
  return { store, project, id }
}
// One incident of each kind, all recorded at the clock's start (00:16:40 UTC), for the simulation tests.
const DETAIL = { 'security-failure': 'SECURITY', 'release-no-go': 'release', 'verification-exhausted': 'TEST', 'review-hold': 'review', 'run-blocked': 'task' } as const
const seedFive = async (): Promise<Record<string, unknown>> => {
  const project = await projectHash('/work/example')
  const store: Record<string, unknown> = {}
  for (const [i, kind] of (Object.keys(DETAIL) as (keyof typeof DETAIL)[]).entries()) {
    const records = bounded([], rec(`${i + 1}@${i + 1}:${kind}:${DETAIL[kind]}`, { kind, taskId: i + 1, at: 1_000_000 }))
    store[occKeyOf(project, episodesOf(records)[0]!.id)] = { v: 1, records }
  }
  return store
}
const labelKeys = (w: { store: Map<string, unknown> }): string[] => [...w.store.keys()].filter(k => k.startsWith('alert-label:'))
const snapshot = (w: { store: Map<string, unknown> }): string => JSON.stringify([...w.store])
const versions = (held: Map<string, { version: unknown }>): unknown[] => [...held].map(([k, v]) => [k, v.version])
const idOf = (text: string): string => /^\s*([0-9a-f]{8})\b/m.exec(text)?.[1] ?? 'missing!'

// A. Human authority and spoofing
/** An origin whose kind says sdk on the first read and composer on the second, and how often it was read. */
const getterOrigin = () => {
  const seen = { reads: 0 }
  const origin: Record<string, unknown> = {}
  Object.defineProperty(origin, 'kind', { enumerable: true, get: () => (++seen.reads === 2 ? 'composer' : 'sdk') })
  return { origin, seen }
}
const BAD: [string, unknown][] = [
  ['sdk', { kind: 'sdk' }], ['plugin', { kind: 'plugin', name: 'x' }], ['future', { kind: 'future' }],
  ['model', { kind: 'model' }], ['subagent', { kind: 'subagent' }], ['agent', { kind: 'agent' }],
  ['hook', { kind: 'hook' }], ['headless', { kind: 'headless' }], ['upper-case', { kind: 'COMPOSER' }],
  ['leading space', { kind: ' composer' }], ['trailing space', { kind: 'composer ' }],
  ['array kind', { kind: ['composer'] }], ['nested kind', { kind: { kind: 'composer' } }],
  ['empty object', {}], ['undefined', undefined], ['null', null], ['bare string', 'composer'],
]
for (const [name, origin] of BAD) {
  test(`a label is not set from origin ${name}`, { options: REC }, async ($, on) => {
    const { store, id } = await seedOne()
    const w = world(on, {}, store)
    hostState(on, {})
    await start($)
    const before = w.storeWrites.length
    expect(await say($, `alerts label ${id} notify`, origin)).toBe(REFUSAL)
    expect(labelKeys(w)).toEqual([])
    expect(w.storeWrites.length).toBe(before)
    expect(w.notified).toEqual([])
  })
  test(`a label is not cleared from origin ${name} and the existing one is kept`, { options: REC }, async ($, on) => {
    const { store, project, id } = await seedOne()
    const w = world(on, {}, store)
    hostState(on, {})
    await start($)
    expect(await say($, `alerts label ${id} noise`)).toContain('is labelled NOISE')
    const before = w.storeWrites.length
    expect(await say($, `alerts label ${id} clear`, origin)).toBe(REFUSAL)
    expect(await say($, `alerts label ${id} notify`, origin)).toBe(REFUSAL)
    expect(w.store.get(`alert-label:${project}:${id}`)).toEqual({ v: 1, label: 'NOISE', at: 1_000_000 })
    expect(w.storeWrites.length).toBe(before)
  })
}

test('an origin whose kind would read composer the second time is read once and refused', { options: REC }, async ($, on) => {
  const { store, project, id } = await seedOne()
  const w = world(on, {}, store)
  hostState(on, {})
  await start($)
  const before = w.storeWrites.length
  // the command is given the origin as the host stamped it: the kind is read once, so a second read cannot change the answer
  const { origin, seen } = getterOrigin()
  expect(await say($, `alerts label ${id} notify`, origin)).toBe(REFUSAL)
  expect(seen.reads).toBe(1)
  expect(labelKeys(w)).toEqual([])
  expect(w.storeWrites.length).toBe(before)
  expect(w.store.has(`alert-label:${project}:${id}`)).toBe(false)
})

for (const origin of [{ kind: 'composer' }, { kind: 'bridge' }]) {
  test(`a label is set and cleared from origin ${origin.kind}`, { options: REC }, async ($, on) => {
    const { store, project, id } = await seedOne()
    const w = world(on, {}, store)
    hostState(on, {})
    await start($)
    expect(await say($, `alerts label ${id} record`, origin)).toContain('is labelled RECORD_ONLY')
    expect(w.store.get(`alert-label:${project}:${id}`)).toEqual({ v: 1, label: 'RECORD_ONLY', at: 1_000_000 })
    expect(await say($, `alerts label ${id} clear`, origin)).toContain('it is unreviewed again.')
    expect(labelKeys(w)).toEqual([])
  })
}

for (const extra of ['notify origin composer', 'notify composer', 'notify {kind:composer}', 'notify --origin=composer']) {
  test(`smuggling "${extra}" in the arguments writes nothing`, { options: REC }, async ($, on) => {
    const { store, id } = await seedOne()
    const w = world(on, {}, store)
    hostState(on, {})
    await start($)
    const before = w.storeWrites.length
    const text = await say($, `alerts label ${id} ${extra}`, { kind: 'sdk' })
    expect(text).toBe(REFUSAL)
    expect(labelKeys(w)).toEqual([])
    expect(w.storeWrites.length).toBe(before)
  })
}

test('the progress tool cannot write a label whatever the action', { options: REC }, async ($, on) => {
  const { store, id } = await seedOne()
  const w = world(on, {}, store)
  hostState(on, {})
  await start($)
  const calls: Record<string, unknown>[] = [
    { action: 'label', id, label: 'NOTIFY' }, { action: 'label', milestone: id, note: 'noise' },
    { action: 'plan', milestones: FIVE.slice(0, 3) }, { action: 'block', milestone: 'm1', note: id },
    { action: 'gate', gate: 'SECURITY', state: 'fail', evidence: `alerts label ${id} notify` },
    { action: 'calibration' }, { action: 'review' },
  ]
  for (const c of calls) {
    try { await ($ as any).tool.call({ tool: 'mcp__cobalt-cockpit__progress', ...c }) } catch { /* a refused action is fine */ }
    expect(labelKeys(w)).toEqual([])
  }
  expect(w.storeWrites.filter(s => s.key.startsWith('alert-label:'))).toEqual([])
})

// B. Lifecycle
test('a label shows in review under the reviewed heading', { options: REC }, async ($, on) => {
  const { store, id } = await seedOne()
  world(on, {}, store)
  hostState(on, {})
  await start($)
  const before = await say($, 'alerts review')
  expect(before).toContain('UNREVIEWED')
  await say($, `alerts label ${id} notify`)
  const after = await say($, 'alerts review')
  expect(after).toContain('REVIEWED (your label)')
  expect(after).toContain('labelled NOTIFY')
})

test('changing a label says what it was', { options: REC }, async ($, on) => {
  const { store, project, id } = await seedOne()
  const w = world(on, {}, store)
  hostState(on, {})
  await start($)
  await say($, `alerts label ${id} notify`)
  await w.clock.advance(5000)
  const text = await say($, `alerts label ${id} noise`)
  expect(text).toContain('is labelled NOISE')
  expect(text).toContain('It was NOTIFY.')
  expect(w.store.get(`alert-label:${project}:${id}`)).toEqual({ v: 1, label: 'NOISE', at: 1_005_000 })
})

test('the same label again changes nothing and writes nothing', { options: REC }, async ($, on) => {
  const { store, id } = await seedOne()
  const w = world(on, {}, store)
  hostState(on, {})
  await start($)
  await say($, `alerts label ${id} noise`)
  const before = w.storeWrites.length
  const snap = snapshot(w)
  expect(await say($, `alerts label ${id} noise`)).toContain('is already labelled')
  expect(w.storeWrites.length).toBe(before)
  expect(snapshot(w)).toBe(snap)
})

test('clearing a label removes the key and says what it was', { options: REC }, async ($, on) => {
  const { store, id } = await seedOne()
  const w = world(on, {}, store)
  hostState(on, {})
  await start($)
  await say($, `alerts label ${id} record`)
  expect(await say($, `alerts label ${id} clear`)).toContain('(it was RECORD_ONLY); it is unreviewed again.')
  expect(labelKeys(w)).toEqual([])
  expect(await say($, 'alerts review')).toContain('UNREVIEWED')
})

test('clearing an unlabelled alert changes nothing', { options: REC }, async ($, on) => {
  const { store, id } = await seedOne()
  const w = world(on, {}, store)
  hostState(on, {})
  await start($)
  const before = w.storeWrites.length
  expect(await say($, `alerts label ${id} clear`)).toContain('has no label. Nothing was changed.')
  expect(w.storeWrites.length).toBe(before)
})

for (const [word, label] of [['notify', 'NOTIFY'], ['record', 'RECORD_ONLY'], ['noise', 'NOISE']] as const) {
  test(`label ${word} stores exactly version, label and time in one write`, { options: REC }, async ($, on) => {
    const { store, project, id } = await seedOne()
    const w = world(on, {}, store)
    hostState(on, {})
    await start($)
    const before = w.storeWrites.length
    await say($, `alerts label ${id} ${word}`)
    const value = w.store.get(`alert-label:${project}:${id}`) as Record<string, unknown>
    expect(value).toEqual({ v: 1, label, at: 1_000_000 })
    expect(Object.keys(value).length).toBe(3)
    expect(w.storeWrites.length).toBe(before + 1)
    expect(w.storeWrites[w.storeWrites.length - 1]!.key).toBe(`alert-label:${project}:${id}`)
  })
}

test('the label word and the id are case-insensitive', { options: REC }, async ($, on) => {
  const { store, project, id } = await seedOne()
  const w = world(on, {}, store)
  hostState(on, {})
  await start($)
  expect(await say($, `alerts label ${id.toUpperCase()} NoIsE`)).toContain('is labelled NOISE')
  expect((w.store.get(`alert-label:${project}:${id}`) as { label: string }).label).toBe('NOISE')
  expect(await say($, `alerts label ${id} CLEAR`)).toContain('it is unreviewed again.')
})

// C. Independence
test('a label does not acknowledge the alert', { options: REC }, async ($, on) => {
  const { store, id } = await seedOne()
  const w = world(on, {}, store)
  hostState(on, {})
  // a session with an identity takes the project's history up into its own records, so the inbox lists it
  session(on)
  await start($)
  expect(await say($, 'alerts')).toContain(`${id} NORMAL run-blocked`)
  await say($, `alerts label ${id} notify`)
  expect(await say($, 'alerts')).toContain('not acknowledged')
  expect([...w.store.keys()].filter(k => k.startsWith('alert-ack:'))).toEqual([])
})

test('a label does not resolve an open condition', { options: { guardRecordOnly: true } }, async ($, on) => {
  const w = world(on, {})
  hostState(on, {})
  await start($)
  await progress($, { action: 'plan', milestones: FIVE.slice(0, 3) })
  await progress($, { action: 'block', milestone: 'm1', note: 'needs the owner' })
  const id = idOf(await say($, 'alerts review'))
  expect(await say($, 'alerts review')).toContain('condition OPEN now')
  await say($, `alerts label ${id} noise`)
  expect(labelKeys(w).length).toBe(1)
  expect(await say($, 'alerts review')).toContain('condition OPEN now')
  expect(await say($, 'alerts')).toContain('condition OPEN now')
})

test('review, label and calibration do not move the since-last-look marker', { options: REC }, async ($, on) => {
  const { store, id } = await seedOne()
  const w = world(on, {}, store)
  hostState(on, {})
  session(on)
  await start($)
  const line = (t: string) => t.split('\n').filter(l => l.includes('SINCE LAST LOOK'))
  const before = line(await say($, 'alerts digest'))
  expect(before.length).toBeGreaterThan(0)
  const keysBefore = [...w.store.keys()].filter(k => k.startsWith('alert-seen:'))
  await say($, 'alerts review')
  await say($, `alerts label ${id} notify`)
  await say($, 'alerts calibration')
  expect([...w.store.keys()].filter(k => k.startsWith('alert-seen:'))).toEqual(keysBefore)
  expect(line(await say($, 'alerts digest'))).toEqual(before)
})

test('alerts ack creates no label', { options: REC }, async ($, on) => {
  const { store, id } = await seedOne()
  const w = world(on, {}, store)
  hostState(on, {})
  session(on)
  await start($)
  expect(await say($, `alerts ack ${id}`)).toContain('was acknowledged')
  expect(labelKeys(w)).toEqual([])
  expect(await say($, 'alerts review')).toContain('UNREVIEWED')
})

test('guard ack creates no label', { options: REC }, async ($, on) => {
  const w = world(on, {})
  hostState(on, {})
  await start($)
  await progress($, { action: 'plan', milestones: FIVE.slice(0, 3) })
  await progress($, { action: 'block', milestone: 'm1', note: 'needs the owner' })
  await say($, 'guard ack')
  expect(labelKeys(w)).toEqual([])
  expect(await say($, 'alerts review')).toContain('UNREVIEWED')
})

test('resolving a condition keeps the label', { options: REC }, async ($, on) => {
  const w = world(on, {})
  hostState(on, {})
  await start($)
  await progress($, { action: 'plan', milestones: FIVE.slice(0, 3) })
  await progress($, { action: 'block', milestone: 'm1', note: 'needs the owner' })
  const id = idOf(await say($, 'alerts review'))
  await say($, `alerts label ${id} notify`)
  const keys = labelKeys(w)
  await progress($, { action: 'unblock', milestone: 'm1' })
  expect(labelKeys(w)).toEqual(keys)
  expect(await say($, 'alerts review')).toContain('labelled NOTIFY')
})

test('clearing a label keeps an existing acknowledgment', { options: REC }, async ($, on) => {
  const { store, id } = await seedOne()
  const w = world(on, {}, store)
  hostState(on, {})
  session(on)
  await start($)
  await say($, `alerts ack ${id}`)
  const acks = [...w.store.keys()].filter(k => k.startsWith('alert-ack:'))
  expect(acks).toHaveLength(1)
  await say($, `alerts label ${id} notify`)
  await say($, `alerts label ${id} clear`)
  expect([...w.store.keys()].filter(k => k.startsWith('alert-ack:'))).toEqual(acks)
})

// D. Read-only
for (const origin of [{ kind: 'composer' }, { kind: 'sdk' }]) {
  for (const args of ['alerts review', 'alerts review 2', 'alerts calibration']) {
    test(`${args} from ${origin.kind} writes nothing and notifies nothing`, { options: REC }, async ($, on) => {
      const { store } = await seedOne()
      const w = world(on, {}, store)
      const held = hostState(on, {})
      await start($)
      // the HUD's first Git refresh, which a session start does not wait for, lands before the snapshot rather than inside the
      // command (v0.6.6 Stage B: the clean launch's probe moved when it lands); one turn of the event loop is enough
      await new Promise<void>(resolve => { (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout(resolve, 0) })
      const writes = w.storeWrites.length
      const snap = snapshot(w)
      const vers = versions(held as never)
      const notified = w.notified.length
      const toasts = w.toasts.length
      const runs = w.runs.length
      await say($, args, origin)
      expect(w.storeWrites.length).toBe(writes)
      expect(snapshot(w)).toBe(snap)
      expect(versions(held as never)).toEqual(vers)
      expect(w.notified.length).toBe(notified)
      expect(w.toasts.length).toBe(toasts)
      expect(w.runs.length).toBe(runs)
      await w.clock.advance(3_600_000)
      expect(w.notified.length).toBe(notified)
    })
  }
}

// E. No notification side effects with alerts on
const ON = { guardAlerts: true, guardRepeat: true, guardRepeatSec: 60, guardCooldownSec: 30, guardMaxAlerts: 20 }
const raise = async ($: any) => {
  await progress($, { action: 'plan', milestones: FIVE.slice(0, 3) })
  await progress($, { action: 'block', milestone: 'm1', note: 'needs the owner' })
}

test('review, label and calibration send no notification and leave the guard state alone', { options: ON }, async ($, on) => {
  const w = world(on, {})
  const held = hostState(on, {})
  await start($)
  await raise($)
  expect(w.notified.length).toBe(1)
  const guard = JSON.stringify(held.get('guard-state')?.value)
  const id = idOf(await say($, 'alerts review'))
  await say($, `alerts label ${id} noise`)
  await say($, 'alerts calibration')
  expect(w.notified.length).toBe(1)
  expect(JSON.stringify(held.get('guard-state')?.value)).toBe(guard)
})

test('a reminder arrives without any label', { options: ON }, async ($, on) => {
  const w = world(on, {})
  hostState(on, {})
  await start($)
  await raise($)
  const before = w.notified.length
  await w.clock.advance(61_000)
  expect(w.notified.length).toBeGreaterThan(before)
})

test('labelling NOISE does not stop the live reminder', { options: ON }, async ($, on) => {
  const w = world(on, {})
  hostState(on, {})
  await start($)
  await raise($)
  const id = idOf(await say($, 'alerts review'))
  await say($, `alerts label ${id} noise`)
  const before = w.notified.length
  await w.clock.advance(61_000)
  expect(w.notified.length).toBeGreaterThan(before)
})

test('calibration does not play a sound', { options: { ...ON, guardSound: true } }, async ($, on) => {
  const w = world(on, {})
  hostState(on, {})
  await start($)
  await raise($)
  const plays0 = plays(w, 'checkpoint')
  const id = idOf(await say($, 'alerts review'))
  await say($, `alerts label ${id} notify`)
  await say($, 'alerts calibration')
  await say($, 'alerts review')
  expect(plays(w, 'checkpoint')).toEqual(plays0)
})

// F. Configuration untouched
const OPTS = { guardRecordOnly: true, guardNotifyKinds: 'none', guardQuietHours: '00:00-00:30', guardQuietTimezone: 'UTC' }

test('calibration leaves the options object unchanged and says so', { options: OPTS }, async ($, on) => {
  const { store } = await seedOne()
  world(on, {}, store)
  hostState(on, {})
  await start($)
  const before = JSON.stringify(OPTS)
  const text = await say($, 'alerts calibration')
  expect(JSON.stringify(OPTS)).toBe(before)
  expect(text).toContain('guardAlerts is off (recording only)')
  expect(text).toContain('was not changed')
})

test('guard still reports recording after calibration', { options: REC }, async ($, on) => {
  const { store } = await seedOne()
  world(on, {}, store)
  hostState(on, {})
  await start($)
  await say($, 'alerts calibration')
  expect(await say($, 'guard')).toContain('GUARD: RECORDING')
})

test('guard still reports off with both settings off after calibration', { options: {} }, async ($, on) => {
  world(on, {})
  hostState(on, {})
  await start($)
  await say($, 'alerts calibration')
  expect(await say($, 'guard')).toContain('GUARD: OFF')
})

// G. The simulation follows the configuration (one incident of each kind)
test('calibration with default options would notify every incident', { options: REC }, async ($, on) => {
  world(on, {}, await seedFive())
  hostState(on, {})
  await start($)
  expect(await say($, 'alerts calibration')).toContain('would notify 5 · would defer for quiet hours 0 · would not notify 0')
})

test('calibration with notify kinds none would notify only the security failure', { options: { ...REC, guardNotifyKinds: 'none' } }, async ($, on) => {
  world(on, {}, await seedFive())
  hostState(on, {})
  await start($)
  const text = await say($, 'alerts calibration')
  expect(text).toContain('would notify 1 · would defer for quiet hours 0 · would not notify 4')
  expect(text).toContain('CRITICAL security-failure · 1 recorded · NOTIFY 0 · RECORD_ONLY 0 · NOISE 0 · unreviewed 1 · would notify 1')
})

test('calibration in quiet hours defers ordinary kinds only', { options: { ...REC, guardQuietHours: '00:00-00:30', guardQuietTimezone: 'UTC' } }, async ($, on) => {
  world(on, {}, await seedFive())
  hostState(on, {})
  await start($)
  expect(await say($, 'alerts calibration')).toContain('would notify 1 · would defer for quiet hours 4 · would not notify 0')
})

test('calibration with critical deferral defers everything in quiet hours', { options: { ...REC, guardQuietHours: '00:00-00:30', guardQuietTimezone: 'UTC', guardQuietCritical: 'defer' } }, async ($, on) => {
  world(on, {}, await seedFive())
  hostState(on, {})
  await start($)
  expect(await say($, 'alerts calibration')).toContain('would notify 0 · would defer for quiet hours 5 · would not notify 0')
})

test('calibration with ordinary kinds notifying in quiet hours defers none', { options: { ...REC, guardQuietHours: '00:00-00:30', guardQuietTimezone: 'UTC', guardQuietOrdinary: 'notify' } }, async ($, on) => {
  world(on, {}, await seedFive())
  hostState(on, {})
  await start($)
  expect(await say($, 'alerts calibration')).toContain('would notify 5 · would defer for quiet hours 0 · would not notify 0')
})

// H. Usage
const USAGE: [string, string][] = [
  ['alerts review 0', 'Usage: /cockpit alerts review [page]'],
  ['alerts review x', 'Usage: /cockpit alerts review [page]'],
  ['alerts review 1 2', 'Usage: /cockpit alerts review [page]'],
  ['alerts calibration now', 'Usage: /cockpit alerts calibration'],
  ['alerts label', 'Usage: /cockpit alerts label'],
  ['alerts label ID', 'Usage: /cockpit alerts label'],
  ['alerts label ID urgent', 'Usage: /cockpit alerts label'],
  ['alerts label ID constructor', 'Usage: /cockpit alerts label'],
  ['alerts label ID __proto__', 'Usage: /cockpit alerts label'],
  ['alerts label ID notify extra', 'Usage: /cockpit alerts label'],
]
for (const [args, expected] of USAGE) {
  test(`"${args}" gives usage and writes nothing`, { options: REC }, async ($, on) => {
    const { store, id } = await seedOne()
    const w = world(on, {}, store)
    hostState(on, {})
    await start($)
    const before = w.storeWrites.length
    expect(await say($, args.replace('ID', id))).toContain(expected)
    expect(w.storeWrites.length).toBe(before)
    expect(labelKeys(w)).toEqual([])
  })
}

test('an unknown alerts word gives general usage naming the new subcommands', { options: REC }, async ($, on) => {
  const w = world(on, {})
  hostState(on, {})
  await start($)
  const text = await say($, 'alerts nonsense')
  expect(text).toContain('review [page]')
  expect(text).toContain('calibration')
  expect(w.storeWrites.length).toBe(0)
})

test('help mentions the review and calibration subcommands', { options: REC }, async ($, on) => {
  world(on, {})
  hostState(on, {})
  await start($)
  const text = await say($, 'help')
  expect(text).toContain('alerts review')
  expect(text).toContain('alerts calibration')
})

// I. Both settings off
test('with both settings off earlier history is listed, labelled and reported', { options: {} }, async ($, on) => {
  const { store, project, id } = await seedOne()
  const w = world(on, {}, store)
  hostState(on, {})
  await start($)
  expect(await say($, 'alerts review')).toContain(id)
  expect(await say($, `alerts label ${id} notify`)).toContain('is labelled NOTIFY')
  expect(w.store.get(`alert-label:${project}:${id}`)).toEqual({ v: 1, label: 'NOTIFY', at: 1_000_000 })
  expect(await say($, 'alerts calibration')).not.toBe('')
  expect(w.notified).toEqual([])
})

test('with both settings off and nothing recorded review is empty and label finds nothing', { options: {} }, async ($, on) => {
  const w = world(on, {})
  hostState(on, {})
  await start($)
  const before = w.storeWrites.length
  expect(await say($, 'alerts review')).toContain('Nothing recorded')
  expect(await say($, 'alerts label deadbeef notify')).toBe('Cockpit: no recorded alert has that id. It may be mistyped, or it may have expired from the bounded history. Nothing was changed.')
  await say($, 'alerts calibration')
  expect(labelKeys(w)).toEqual([])
  expect(w.storeWrites.length).toBe(before)
})
