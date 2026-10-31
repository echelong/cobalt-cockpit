// v0.5.6 alert priorities, notified kinds, quiet hours and the pinned HUD row. A held-back alert writes nothing to the
// terminal, stays visible, and is told once afterwards; nothing here changes a verdict; and nothing is ever called seen.
// These are synthetic: no test here shows that a person saw, heard or was spared anything.

import { describe, expect, test } from 'claude-code/testing'
import { EMPTY_GUARD, KINDS, LEVEL, PRIORITY, byPriority, conditionsOf, decide, deferredOf, digestOf, guardConfigOf, guardText, hasWorkLeft, holdOf, isAlertRecord, isCritical, isSettledQuietly, kindsOf, lapsedOf, pinLine, pinsOf, policyLines, remind, validAlerts } from '../hooks/alerts'
import type { AlertKind, AlertRecord, Open, Pin } from '../hooks/alerts'
import { emptyLedger, migrateLedger } from '../hooks/ledger'
import { applyAction, newTask, settle } from '../hooks/model'
import { QUIET_OFF, audibleText, clockOf, inWindow, isHeld, isQuiet, isZone, localMinutes, minutesOf, quietConfigOf, quietLines } from '../hooks/quiet'
import type { Ledger, Task } from '../types'
import { FIVE, command, hostState, mountHud, planAndComplete, plays, progress, rowsOf, start, world } from './world'

const MIN = 60_000
const HOUR = 60 * MIN
const at = (iso: string): number => Date.parse(iso)
const quietOf = (extra: Record<string, unknown> = {}, zone = 'UTC') => quietConfigOf({ guardAlerts: true, guardQuietHours: '22:00-07:00', ...extra }, zone)
const rec = (key: string, over: Partial<AlertRecord> = {}): AlertRecord => ({ key, kind: 'run-blocked', taskId: 1, at: 1000, outcome: 'sent', attempts: 1, channel: 'kitty', ...over })
const deferred = (key: string, over: Partial<AlertRecord> = {}): AlertRecord => rec(key, { outcome: 'deferred', attempts: 0, channel: null, why: 'quiet', ...over })
const ledger = (held: ReturnType<typeof hostState>) => held.get('run-ledger')!.value as Ledger
const task = (held: ReturnType<typeof hostState>) => held.get('task')!.value as Task
const outcomes = (held: ReturnType<typeof hostState>) => (ledger(held).alerts ?? []).map(a => `${a.kind}:${a.outcome}${a.nth === undefined ? '' : `#${a.nth}`}`)
const say = async ($: any, args: string) => String((await command($, args)).text)
const failSecurity = ($: any) => progress($, { action: 'gate', gate: 'SECURITY', state: 'fail', evidence: 'x' })
const block = ($: any) => progress($, { action: 'block', milestone: 'm2', note: 'needs the owner' })
const guardRow = async ($: any, columns = 120) => (await rowsOf(await mountHud($, 'terminal', columns))).find(r => r.includes('GUARD') || r.includes('▲'))
/** The mock clock starts at 00:16:40 UTC, so this window is open at the start and ends 13 minutes 20 seconds later. */
const QUIET = { guardAlerts: true, guardCooldownSec: 30, guardQuietHours: '23:00-00:30', guardQuietTimezone: 'UTC' }
const quietly = (extra: Record<string, unknown> = {}) => ({ options: { ...QUIET, ...extra } })
const NEVER_CLAIMED = /\b(seen|heard|delivered|read by|silent(ly)?)\b/i

describe('the quiet window', () => {
  test('times are 24-hour HH:MM, and nothing else', () => {
    expect([minutesOf('00:00'), minutesOf('7:05'), minutesOf('22:00'), minutesOf('23:59'), minutesOf(' 06:30 ')]).toEqual([0, 425, 1320, 1439, 390])
    for (const bad of ['24:00', '12:60', '12', '12:5', 'noon', '', '10pm', '-1:00', '12:00:00', '1e1:00']) expect(minutesOf(bad)).toBeNull()
    expect(clockOf(425)).toBe('07:05')
  })
  test('a window in one day: the start is inside, the end is not', () => {
    expect([539, 540, 1019, 1020].map(m => inWindow(m, 540, 1020))).toEqual([false, true, true, false])
  })
  test('a window across midnight holds on both sides of it', () => {
    const inside = (m: number) => inWindow(m, 22 * 60, 7 * 60)
    expect([21 * 60 + 59, 22 * 60, 23 * 60 + 59, 0, 6 * 60 + 59, 7 * 60, 12 * 60].map(inside)).toEqual([false, true, true, true, true, false, false])
  })
  test('a window of no length is never open', () => {
    expect(inWindow(600, 600, 600)).toBe(false)
  })
})

describe('quiet hours configuration', () => {
  test('off by default, and off without guardAlerts', () => {
    expect(quietConfigOf({}, 'UTC')).toEqual(QUIET_OFF)
    expect(quietConfigOf({ guardAlerts: true }, 'UTC')).toMatchObject({ asked: false, on: false })
    expect(quietConfigOf({ guardAlerts: true, guardQuietHours: '' }, 'UTC')).toMatchObject({ asked: false, on: false })
    expect(quietConfigOf({ guardQuietHours: '22:00-07:00' }, 'UTC')).toMatchObject({ asked: false, on: false })
    expect(guardConfigOf({ guardAlerts: true }).quiet.on).toBe(false)
    expect(isQuiet(QUIET_OFF, at('2026-01-15T03:00:00Z'))).toBe(false)
  })
  test('a window, with ordinary alerts deferred and critical ones still sent unless set otherwise', () => {
    expect(quietOf()).toMatchObject({ asked: true, on: true, start: 1320, end: 420, zone: 'UTC', zoneFrom: 'machine', ordinary: 'defer', critical: 'notify', problems: [] })
    expect(quietOf({ guardQuietOrdinary: 'notify', guardQuietCritical: 'defer' })).toMatchObject({ on: true, ordinary: 'notify', critical: 'defer' })
  })
  test('an explicit zone is used; a missing one is this machine\'s, and says so', () => {
    expect(quietOf({ guardQuietTimezone: 'Europe/Berlin' }, 'UTC')).toMatchObject({ on: true, zone: 'Europe/Berlin', zoneFrom: 'option' })
    expect(quietOf({}, 'Asia/Tokyo')).toMatchObject({ on: true, zone: 'Asia/Tokyo', zoneFrom: 'machine' })
    expect(quietOf({ guardQuietTimezone: '   ' }, 'Asia/Tokyo')).toMatchObject({ on: true, zone: 'Asia/Tokyo', zoneFrom: 'machine' })
    // a machine that names no usable zone is read as UTC, which the status then shows
    expect(quietOf({}, 'Nowhere/Land')).toMatchObject({ on: true, zone: 'UTC', zoneFrom: 'machine' })
    expect(quietLines(quietOf({}, 'Asia/Tokyo'), at('2026-01-15T03:00:00Z'), null, true).join('\n')).toContain('WARN the window uses the zone of the machine Claude Code runs on, and this is an SSH session')
    expect(quietLines(quietOf({ guardQuietTimezone: 'Asia/Tokyo' }), at('2026-01-15T03:00:00Z'), null, true).join('\n')).not.toContain('WARN')
  })
  test('a zone, a window or a mode that is not understood turns quiet hours off and says why: it never holds an alert back', () => {
    const cases: Record<string, unknown>[] = [
      { guardQuietTimezone: 'Mars/Phobos' }, { guardQuietTimezone: 'not a zone' }, { guardQuietTimezone: 7 }, { guardQuietTimezone: 'x'.repeat(200) },
      { guardQuietHours: '22:00' }, { guardQuietHours: '22-7' }, { guardQuietHours: '25:00-07:00' }, { guardQuietHours: 'night' }, { guardQuietHours: '22:00-07:00-09:00' }, { guardQuietHours: true }, { guardQuietHours: 2200 },
      { guardQuietHours: '07:00-07:00' }, { guardQuietOrdinary: 'mute' }, { guardQuietCritical: true },
    ]
    for (const extra of cases) {
      const q = quietOf(extra)
      expect(q.asked).toBe(true)
      expect(q.on).toBe(false)
      expect(q.problems.length).toBeGreaterThan(0)
      for (const moment of ['2026-01-15T00:00:00Z', '2026-01-15T03:00:00Z', '2026-01-15T12:00:00Z', '2026-01-15T23:00:00Z']) {
        expect(isQuiet(q, at(moment))).toBe(false)
        expect(isHeld(q, false, at(moment))).toBe(false)
      }
      const lines = quietLines(q, at('2026-01-15T03:00:00Z'), null, false).join('\n')
      expect(lines).toContain('NOT IN FORCE')
      expect(lines).toContain('every alert is sent as usual')
      // the reason is a closed sentence: no setting's value is repeated back
      expect(lines).not.toContain('Phobos')
    }
    expect(isZone('Europe/Berlin')).toBe(true)
    expect([isZone(''), isZone('Mars/Phobos')]).toEqual([false, false])
  })
})

describe('time zones and daylight saving', () => {
  test('the window is read in its zone, not in UTC', () => {
    const berlin = quietOf({ guardQuietTimezone: 'Europe/Berlin' })
    // 21:30 UTC is 22:30 in Berlin in winter
    expect(isQuiet(berlin, at('2026-01-15T21:30:00Z'))).toBe(true)
    expect(isQuiet(quietOf({ guardQuietTimezone: 'UTC' }), at('2026-01-15T21:30:00Z'))).toBe(false)
    expect(localMinutes(at('2026-01-15T21:30:00Z'), 'Europe/Berlin')).toBe(22 * 60 + 30)
    // a zone with a half-hour offset
    expect(localMinutes(at('2026-01-15T00:00:00Z'), 'Asia/Kolkata')).toBe(5 * 60 + 30)
  })
  test('it follows the wall clock across a daylight-saving change', () => {
    const berlin = quietOf({ guardQuietTimezone: 'Europe/Berlin' })
    // the same UTC instant is before the window on the last winter evening and inside it on the first summer evening
    expect(isQuiet(berlin, at('2026-03-28T20:30:00Z'))).toBe(false)
    expect(isQuiet(berlin, at('2026-03-29T20:30:00Z'))).toBe(true)
  })
  test('spring forward: a window across the skipped hour is that much shorter, and one inside it never opens', () => {
    // New York, 2026-03-08: 01:59 EST is followed by 03:00 EDT
    const across = quietOf({ guardQuietHours: '01:30-03:30', guardQuietTimezone: 'America/New_York' })
    expect(isQuiet(across, at('2026-03-08T06:29:00Z'))).toBe(false)
    expect(isQuiet(across, at('2026-03-08T06:30:00Z'))).toBe(true)
    expect(isQuiet(across, at('2026-03-08T06:59:00Z'))).toBe(true)
    expect(isQuiet(across, at('2026-03-08T07:00:00Z'))).toBe(true)
    expect(isQuiet(across, at('2026-03-08T07:29:00Z'))).toBe(true)
    expect(isQuiet(across, at('2026-03-08T07:30:00Z'))).toBe(false)
    const skipped = quietOf({ guardQuietHours: '02:15-02:45', guardQuietTimezone: 'America/New_York' })
    for (let m = 0; m < 180; m++) expect(isQuiet(skipped, at('2026-03-08T05:30:00Z') + m * MIN)).toBe(false)
    // and the night after, that same window opens as usual
    expect(isQuiet(skipped, at('2026-03-09T06:30:00Z'))).toBe(true)
  })
  test('fall back: a window in the repeated hour is open both times, and closes once', () => {
    // New York, 2026-11-01: 01:59 EDT is followed by 01:00 EST
    const q = quietOf({ guardQuietHours: '01:00-02:00', guardQuietTimezone: 'America/New_York' })
    expect(isQuiet(q, at('2026-11-01T04:59:00Z'))).toBe(false)
    expect(isQuiet(q, at('2026-11-01T05:30:00Z'))).toBe(true)
    expect(isQuiet(q, at('2026-11-01T06:30:00Z'))).toBe(true)
    expect(isQuiet(q, at('2026-11-01T07:00:00Z'))).toBe(false)
  })
  test('a moment that cannot be read is outside the window: nothing is held back on a broken clock', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 8.7e15]) {
      expect(isQuiet(quietOf(), bad)).toBe(false)
      expect(localMinutes(bad, 'UTC')).toBeNull()
    }
    expect(quietLines(quietOf(), Number.NaN, null, false).join('\n')).toContain('the time there cannot be read, so the window is treated as closed')
  })
  test('a clock that jumps is simply read again: nothing is remembered from the last look', () => {
    const q = quietOf()
    const night = at('2026-01-15T23:00:00Z')
    expect([night, night - 3 * HOUR, night + 9 * HOUR, night - 30 * 24 * HOUR].map(t => isQuiet(q, t))).toEqual([true, false, false, true])
  })
})

describe('priorities', () => {
  test('each kind has one fixed level, and the order is total and stable', () => {
    expect(LEVEL).toEqual({ 'security-failure': 'CRITICAL', 'release-no-go': 'HIGH', 'verification-exhausted': 'HIGH', 'review-hold': 'HIGH', 'run-blocked': 'NORMAL' })
    expect([...PRIORITY].sort()).toEqual([...KINDS].sort())
    expect(KINDS.filter(isCritical)).toEqual(['security-failure'])
    const shuffled: AlertKind[] = ['run-blocked', 'review-hold', 'security-failure', 'verification-exhausted', 'release-no-go']
    expect([...shuffled].sort(byPriority)).toEqual(['security-failure', 'release-no-go', 'verification-exhausted', 'review-hold', 'run-blocked'])
    expect([...shuffled].reverse().sort(byPriority)).toEqual([...shuffled].sort(byPriority))
  })
  test('the defaults are v0.5.5: every kind notified, no window, and the same decisions', () => {
    const cfg = guardConfigOf({ guardAlerts: true })
    expect(cfg.kinds).toEqual(KINDS)
    expect(cfg.kindProblems).toEqual([])
    for (const kind of KINDS) expect(holdOf(cfg, kind, at('2026-01-15T03:00:00Z'))).toBeNull()
    expect(decide(cfg, EMPTY_GUARD, [], 'k', 1)).toEqual({ send: true, attempts: 1 })
  })
  test('the notified kinds are a list of names; the critical kind cannot be turned off', () => {
    expect(kindsOf(undefined)).toEqual({ kinds: KINDS, problems: [] })
    expect(kindsOf('')).toEqual({ kinds: KINDS, problems: [] })
    expect(kindsOf('all')).toEqual({ kinds: KINDS, problems: [] })
    expect(kindsOf('run-blocked, review-hold').kinds).toEqual(['security-failure', 'review-hold', 'run-blocked'])
    expect(kindsOf('RELEASE-NO-GO verification-exhausted').kinds).toEqual(['verification-exhausted', 'security-failure', 'release-no-go'])
    expect(kindsOf('none')).toEqual({ kinds: ['security-failure'], problems: [] })
    expect(kindsOf('run-blocked').kinds).toContain('security-failure')
  })
  test('a list that is not understood notifies more, never less, and says so without repeating it', () => {
    expect(kindsOf('everything')).toMatchObject({ kinds: KINDS })
    expect(kindsOf('everything').problems.join()).toContain('so every kind is notified')
    expect(kindsOf(7)).toMatchObject({ kinds: KINDS })
    expect(kindsOf(['run-blocked'])).toMatchObject({ kinds: KINDS })
    const partly = kindsOf('run-blocked, secrets-in-here, other')
    expect(partly.kinds).toEqual(['security-failure', 'run-blocked'])
    expect(partly.problems).toEqual(['guardNotifyKinds names 2 kinds Cockpit does not know; they were ignored'])
    expect(partly.problems.join()).not.toContain('secrets-in-here')
    expect(guardConfigOf({ guardNotifyKinds: 'bogus' }).kindProblems).toEqual([])
  })
  test('held back: a kind that is off, or a class quiet hours hold; critical is its own class', () => {
    const night = at('2026-01-15T03:00:00Z')
    const day = at('2026-01-15T12:00:00Z')
    const cfg = guardConfigOf({ guardAlerts: true, guardQuietHours: '22:00-07:00', guardQuietTimezone: 'UTC', guardNotifyKinds: 'release-no-go,run-blocked' })
    expect(holdOf(cfg, 'run-blocked', night)).toBe('quiet')
    expect(holdOf(cfg, 'run-blocked', day)).toBeNull()
    expect(holdOf(cfg, 'security-failure', night)).toBeNull()
    expect(holdOf(cfg, 'review-hold', day)).toBe('kind-off')
    expect(holdOf(cfg, 'review-hold', night)).toBe('kind-off')
    const strict = guardConfigOf({ guardAlerts: true, guardQuietHours: '22:00-07:00', guardQuietTimezone: 'UTC', guardQuietCritical: 'defer', guardQuietOrdinary: 'notify' })
    expect(holdOf(strict, 'security-failure', night)).toBe('quiet')
    expect(holdOf(strict, 'run-blocked', night)).toBeNull()
  })
})

describe('deferred alerts in the records', () => {
  const k = '1@0:run-blocked:task'
  const s = '1@0:security-failure:SECURITY'
  const cfg = guardConfigOf({ guardAlerts: true, guardQuietHours: '22:00-07:00', guardQuietTimezone: 'UTC' })
  test('a deferral is owed a notification until one is written, it is acknowledged, or it resolves', () => {
    expect(deferredOf([deferred(k)]).map(a => a.key)).toEqual([k])
    expect(deferredOf([deferred(k), rec(k, { at: 2000 })])).toEqual([])
    expect(deferredOf([deferred(k, { acked: true })])).toEqual([])
    expect(deferredOf([deferred(k), rec(k, { at: 2000, outcome: 'resolved', attempts: 0, channel: null })])).toEqual([])
    // a failed attempt is not a notification: it is still owed
    expect(deferredOf([deferred(k), rec(k, { at: 2000, outcome: 'failed', channel: null, why: 'error' })]).map(a => a.key)).toEqual([k])
    expect(deferredOf([deferred(k), rec(k, { at: 2000, outcome: 'throttled', attempts: 0, channel: null, why: 'cooldown' })]).map(a => a.key)).toEqual([k])
  })
  test('a deferral that can no longer be told is not owed, so it neither keeps the timer nor is promised', () => {
    const fail = (n: number) => rec(k, { at: 2000 + n, outcome: 'failed', channel: null, why: 'error' })
    expect(deferredOf([deferred(k), fail(1), fail(2)]).map(a => a.key)).toEqual([k])
    expect(deferredOf([deferred(k), fail(1), fail(2), fail(3)])).toEqual([])
    expect(hasWorkLeft(cfg, EMPTY_GUARD, [deferred(k), fail(1), fail(2), fail(3)])).toBe(false)
    // its kind was turned off, or the session silenced, after it was deferred
    const off = [deferred(k), rec(k, { at: 2000, outcome: 'silenced', attempts: 0, channel: null, why: 'kind-off' })]
    expect(deferredOf(off)).toEqual([])
    expect(hasWorkLeft(cfg, EMPTY_GUARD, off)).toBe(false)
    expect(deferredOf([deferred(k), rec(k, { at: 2000, outcome: 'silenced', attempts: 0, channel: null })])).toEqual([])
    expect(policyLines(cfg, off, { now: at('2026-01-15T12:00:00Z'), open: [{ kind: 'run-blocked', key: k }], channel: null, isSsh: false }).join('\n')).not.toContain('owed a notification')
  })
  test('acknowledged while deferred is settled: the person knows, and a later occurrence is new', () => {
    expect(isSettledQuietly([deferred(k, { acked: true })], k)).toBe(true)
    expect(isSettledQuietly([deferred(k)], k)).toBe(false)
    expect(isSettledQuietly([rec(k, { acked: true })], k)).toBe(false)
    const again = [deferred(k, { acked: true }), rec(k, { at: 2000, outcome: 'resolved', attempts: 0, channel: null })]
    expect(isSettledQuietly(again, k)).toBe(false)
    expect(decide(cfg, EMPTY_GUARD, again, k, 9e9)).toEqual({ send: true, attempts: 1 })
  })
  test('a deferred condition that no longer holds is closed whether or not it was acknowledged', () => {
    const kept = [deferred(k), deferred(s, { kind: 'security-failure', acked: true }), rec('1@0:review-hold:review', { kind: 'review-hold' })]
    expect(lapsedOf(kept, [k, s])).toEqual([])
    expect(lapsedOf(kept, []).map(a => a.key)).toEqual([k, s])
    expect(lapsedOf(kept, [s]).map(a => a.key)).toEqual([k])
    // a condition that was notified is the persistent alerts' to close, not this
    expect(lapsedOf([deferred(k), rec(k, { at: 2000 })], [])).toEqual([])
  })
  test('the timer has work while a deferral is owed and can still be told, and none otherwise', () => {
    expect(hasWorkLeft(cfg, EMPTY_GUARD, [deferred(k)])).toBe(true)
    expect(hasWorkLeft(cfg, EMPTY_GUARD, [])).toBe(false)
    expect(hasWorkLeft(cfg, EMPTY_GUARD, [deferred(k, { acked: true })])).toBe(false)
    expect(hasWorkLeft(cfg, EMPTY_GUARD, [deferred(k), rec(k, { at: 2000 })])).toBe(false)
    expect(hasWorkLeft(cfg, { ...EMPTY_GUARD, all: true }, [deferred(k)])).toBe(false)
    expect(hasWorkLeft(cfg, { ...EMPTY_GUARD, count: cfg.maxPerSession }, [deferred(k)])).toBe(false)
    expect(hasWorkLeft(guardConfigOf({}), EMPTY_GUARD, [deferred(k)])).toBe(false)
  })
  test('the new records are kept as written and a malformed one is dropped', () => {
    const good = [deferred(k), rec(k, { outcome: 'silenced', attempts: 0, channel: null, why: 'kind-off' })]
    expect(good.every(isAlertRecord)).toBe(true)
    const bad = [{ ...deferred(k), why: 'night' }, { ...deferred(k), outcome: 'postponed' }, { ...deferred(k), why: 7 }, { ...deferred(k), acked: 'yes' }]
    expect(validAlerts([...good, ...bad])).toEqual(good)
    expect(migrateLedger({ ...emptyLedger('s'), alerts: [...good, ...bad] } as never).alerts).toEqual(good)
  })
  test('the digest is a count, one closed sentence and a task number', () => {
    const text = digestOf(['run-blocked', 'security-failure', 'review-hold'], 4)
    expect(text).toBe('Cobalt Guard · task 4, quiet hours ended: 3 conditions are still open; the first: a security check failed; the task cannot be called verified. Nothing was approved or released. /cockpit guard')
  })
  test('a reminder waits out the window and is one reminder afterwards, not one per interval missed', () => {
    const rcfg = guardConfigOf({ guardAlerts: true, guardRepeat: true, guardRepeatSec: 60, guardMaxReminders: 3, guardCooldownSec: 30, guardQuietHours: '22:00-07:00', guardQuietTimezone: 'UTC' })
    const sentAt = at('2026-01-15T21:59:00Z')
    const kept = [rec(k, { at: sentAt })]
    expect(holdOf(rcfg, 'run-blocked', sentAt + 2 * HOUR)).toBe('quiet')
    expect(remind(rcfg, EMPTY_GUARD, kept, k, at('2026-01-16T07:00:00Z'))).toEqual({ send: true, nth: 1 })
    // once that one is written the next waits its whole interval again
    const after = [...kept, rec(k, { at: at('2026-01-16T07:00:00Z'), nth: 1 })]
    expect(remind(rcfg, EMPTY_GUARD, after, k, at('2026-01-16T07:00:30Z'))).toEqual({ send: false, why: 'waiting' })
  })
})

describe('the pinned row', () => {
  const k = '1@0:run-blocked:task'
  const s = '1@0:security-failure:SECURITY'
  const r = '1@0:review-hold:review'
  const open: Open[] = [{ kind: 'run-blocked', key: k }, { kind: 'review-hold', key: r }, { kind: 'security-failure', key: s }]
  const pin = (over: Partial<Pin> = {}): Pin => ({ key: s, kind: 'security-failure', taskId: 3, level: 'CRITICAL', status: 'sent', acked: false, ...over })
  test('a pin is a raised condition that still holds and was not acknowledged, gravest first', () => {
    const kept = [rec(k), rec(s, { kind: 'security-failure' }), rec(r, { kind: 'review-hold' })]
    expect(pinsOf(kept, open).map(p => `${p.level} ${p.kind} ${p.status}`)).toEqual(['CRITICAL security-failure sent', 'HIGH review-hold sent', 'NORMAL run-blocked sent'])
    // a condition only told at a stop is not pinned before it was raised
    expect(pinsOf([rec(k)], open).map(p => p.kind)).toEqual(['run-blocked'])
    expect(pinsOf([], open)).toEqual([])
  })
  test('it clears when the condition resolves or is acknowledged, and returns for news', () => {
    expect(pinsOf([rec(k)], [])).toEqual([])
    expect(pinsOf([rec(k, { acked: true })], open)).toEqual([])
    expect(conditionsOf([rec(k, { acked: true })], open).map(p => p.acked)).toEqual([true])
    expect(pinsOf([rec(k), rec(k, { at: 2000, outcome: 'resolved', attempts: 0, channel: null })], open)).toEqual([])
    // held back and acknowledged, then written after all: that notice is news
    const news = [rec(k, { outcome: 'throttled', attempts: 0, channel: null, why: 'cooldown', acked: true }), rec(k, { at: 2000 })]
    expect(pinsOf(news, open).map(p => p.status)).toEqual(['sent'])
  })
  test('what became of the notification is told as it is', () => {
    const status = (records: AlertRecord[]) => pinsOf(records, open)[0]?.status
    expect(status([rec(k)])).toBe('sent')
    expect(status([rec(k, { outcome: 'failed', channel: null, why: 'no-channel' })])).toBe('not-sent')
    expect(status([rec(k, { outcome: 'refused', channel: null, why: 'refused' })])).toBe('not-sent')
    expect(status([deferred(k)])).toBe('deferred')
    expect(status([rec(k, { outcome: 'throttled', attempts: 0, channel: null, why: 'budget' })])).toBe('held')
    expect(status([rec(k, { outcome: 'silenced', attempts: 0, channel: null, why: 'kind-off' })])).toBe('kind-off')
    expect(status([rec(k, { outcome: 'silenced', attempts: 0, channel: null })])).toBe('silenced')
    expect(status([deferred(k), rec(k, { at: 2000, outcome: 'failed', channel: null, why: 'error' })])).toBe('not-sent')
  })
  test('nothing to pin draws nothing: no open condition and a confirmed transport', () => {
    expect(pinLine([], false, 'ARMED', 120)).toBeNull()
  })
  test('an unconfirmed transport is surfaced while armed, plainly and without colour', () => {
    expect(pinLine([], true, 'ARMED', 120)).toEqual({ text: 'GUARD: ARMED · transport not confirmed · /cockpit guard test', level: 'INFO' })
  })
  test('the row names the level, the condition, the task and the notification, and never a person\'s attention', () => {
    const line = pinLine([pin(), pin({ kind: 'run-blocked', level: 'NORMAL' })], true, 'SENT', 160)!
    expect(line).toEqual({ text: 'GUARD ▲ CRITICAL security check failed · task 3 · notification SENT, not acknowledged · +1 more · transport not confirmed · /cockpit alerts', level: 'CRITICAL' })
    for (const status of ['sent', 'not-sent', 'deferred', 'held', 'kind-off', 'silenced'] as const) {
      for (const width of [200, 100, 60, 40, 20, 8]) expect(pinLine([pin({ status })], width % 3 === 0, 'ARMED', width)!.text).not.toMatch(NEVER_CLAIMED)
    }
  })
  test('it fits the width it is given, keeping the level longest', () => {
    for (let width = 0; width <= 170; width++) {
      for (const pins of [[pin()], [pin(), pin({ kind: 'review-hold', level: 'HIGH' }), pin({ kind: 'run-blocked', level: 'NORMAL' })], []]) {
        const line = pinLine(pins, true, 'ALERT PENDING', width)
        expect(line === null ? 0 : line.text.length).toBeLessThanOrEqual(width)
        if (pins.length > 0 && width >= 10) expect(line!.text).toContain('▲ CRITICAL')
        if (pins.length > 1 && width >= 13) expect(line!.text).toContain('+2')
      }
    }
    expect(pinLine([pin()], false, 'ARMED', 40)!.text).toBe('GUARD ▲ CRITICAL security check failed')
    expect(pinLine([pin({ status: 'deferred' })], false, 'ARMED', 50)!.text).toBe('GUARD ▲ CRITICAL security check failed · DEFERRED')
  })
})

describe('the status', () => {
  const k = '1@0:run-blocked:task'
  const cfg = guardConfigOf({ guardAlerts: true, guardQuietHours: '22:00-07:00', guardQuietTimezone: 'Europe/Berlin', guardNotifyKinds: 'run-blocked,release-no-go' })
  const night = at('2026-01-15T23:30:00Z')
  const view = { now: night, open: [{ kind: 'run-blocked' as const, key: k }], channel: 'terminal_bell', isSsh: true }
  test('shows priorities, notified kinds, the window with the time there, and each active condition', () => {
    const text = policyLines(cfg, [deferred(k, { taskId: 2 })], view).join('\n')
    expect(text).toContain('Priority: CRITICAL security-failure · HIGH release-no-go, verification-exhausted, review-hold · NORMAL run-blocked.')
    expect(text).toContain('Notified kinds: security-failure, release-no-go, run-blocked · NOT notified: verification-exhausted, review-hold')
    expect(text).toContain('Quiet hours: 22:00-07:00 Europe/Berlin (guardQuietTimezone) · now 00:30 there · ACTIVE')
    expect(text).toContain('ordinary alerts: DEFERRED until 07:00: nothing is written to your terminal, so nothing rings')
    expect(text).toContain('ACTIVE NORMAL run-blocked · task 2 · DEFERRED, quiet hours · not acknowledged')
    expect(text).toContain('1 deferred alert is owed a notification: after quiet hours end, if still open then.')
    expect(policyLines(guardConfigOf({}), [], view)).toEqual([])
  })
  test('on a bell channel an alert kept in the window is called audible; only an unsent one is called quiet', () => {
    const text = policyLines(cfg, [], view).join('\n')
    expect(text).toContain('critical alerts (security failure): still sent · AUDIBLE: your channel is the terminal bell, so the notification itself rings')
    expect(audibleText('iterm2_with_bell')).toContain('AUDIBLE')
    expect(audibleText('kitty')).toContain('whether that makes a sound is decided by your terminal and desktop, which Cockpit cannot see')
    expect(audibleText(null)).toContain('may be audible')
    for (const channel of ['terminal_bell', 'iterm2_with_bell', 'iterm2', 'kitty', 'ghostty', null]) expect(audibleText(channel)).not.toMatch(/silent|quiet|muted/i)
  })
  test('with the defaults the status says so, and the old three-argument form is unchanged', () => {
    const plain = guardConfigOf({ guardAlerts: true })
    const text = guardText(plain, EMPTY_GUARD, [], { now: night, open: [], channel: null, isSsh: false })
    expect(text).toContain('Notified kinds: all five (guardNotifyKinds).')
    expect(text).toContain('Quiet hours: off')
    expect(text).toContain('Active conditions: none raised and still open.')
    expect(guardText(plain, EMPTY_GUARD, [])).not.toContain('Quiet hours')
    expect(guardText(guardConfigOf({}), EMPTY_GUARD, [], { now: night, open: [], channel: null, isSsh: false })).not.toContain('Quiet hours')
  })
})

describe('in a run: quiet hours', () => {
  test('off by default: an alert is sent at once, at any hour', { options: { guardAlerts: true, guardCooldownSec: 30 } }, async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    expect(w.notified.length).toBe(1)
    expect(outcomes(held)).toEqual(['run-blocked:sent'])
    expect(await say($, 'guard')).toContain('Quiet hours: off')
  })
  test('an ordinary alert in the window writes nothing to the terminal, is recorded and pinned, and is told once when the window ends', quietly({ guardSound: true }), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1)
    const before = JSON.stringify([task(held).gates, task(held).status, task(held).review ?? null])
    await block($)
    expect(w.notified).toEqual([])
    expect(plays(w, 'checkpoint')).toEqual([])
    expect(outcomes(held)).toEqual(['run-blocked:deferred'])
    expect(await guardRow($)).toContain('GUARD ▲ NORMAL run blocked · task 1 · DEFERRED, quiet hours')
    const status = await say($, 'guard')
    expect(status).toContain('Quiet hours: 23:00-00:30 UTC (guardQuietTimezone) · now 00:16 there · ACTIVE')
    expect(status).toContain('ACTIVE NORMAL run-blocked · task 1 · DEFERRED, quiet hours · not acknowledged')
    expect(status).toContain('1 deferred alert is owed a notification: after quiet hours end')
    // further activity in the window records nothing more and still sends nothing
    await progress($, { action: 'status' }); await progress($, { action: 'status' })
    await w.clock.advance(13 * MIN)
    expect(w.notified).toEqual([])
    expect(outcomes(held)).toEqual(['run-blocked:deferred'])
    // the window ends at 00:30: the timer alone tells it, with nothing else happening
    await w.clock.advance(MIN)
    expect(w.notified.length).toBe(1)
    expect(w.notified[0]!.text).toBe('Cobalt Guard · task 1: the run is blocked and needs you. Nothing was approved or released. /cockpit guard')
    expect(outcomes(held)).toEqual(['run-blocked:deferred', 'run-blocked:sent'])
    expect(await guardRow($)).toContain('notification SENT, not acknowledged')
    // and it is told once: hours later there is still one notification
    await w.clock.advance(6 * HOUR)
    expect(w.notified.length).toBe(1)
    // no verdict moved: the block is the model's own, the gates are where they were
    expect(JSON.stringify([task(held).gates, task(held).status, task(held).review ?? null])).toBe(before.replace('"active"', `"${task(held).status}"`))
    expect(task(held).blocker).toBe('needs the owner')
  })
  test('a critical alert is still sent in the window by default, without the extra cue', quietly({ guardSound: true }), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    expect(w.notified.length).toBe(1)
    expect(w.notified[0]!.text).toContain('a security check failed')
    await w.clock.settle()
    expect(plays(w, 'checkpoint')).toEqual([])
    expect(outcomes(held)).toEqual(['security-failure:sent'])
    expect(await guardRow($)).toContain('GUARD ▲ CRITICAL security check failed')
  })
  test('outside the window the cue plays as it always did', quietly({ guardSound: true, guardQuietHours: '03:00-04:00' }), async ($, on) => {
    const w = world(on)
    await start($); await planAndComplete($, 1); await failSecurity($)
    await w.clock.settle()
    expect(w.notified.length).toBe(1)
    expect(plays(w, 'checkpoint').length).toBe(1)
  })
  test('a critical alert the operator chose to defer stays visible on the HUD the whole time', quietly({ guardQuietCritical: 'defer' }), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    expect(w.notified).toEqual([])
    expect(outcomes(held)).toEqual(['security-failure:deferred'])
    expect(await guardRow($)).toContain('GUARD ▲ CRITICAL security check failed · task 1 · DEFERRED, quiet hours')
    expect(task(held).gates.SECURITY.state).toBe('fail')
    await w.clock.advance(14 * MIN)
    expect(w.notified.length).toBe(1)
    expect(task(held).gates.SECURITY.state).toBe('fail')
  })
  test('ordinary alerts set to notify are sent in the window', quietly({ guardQuietOrdinary: 'notify' }), async ($, on) => {
    const w = world(on)
    await start($); await planAndComplete($, 1); await block($)
    expect(w.notified.length).toBe(1)
  })
  test('no flood when the window ends: several held-back conditions are one notification, and one budget unit', quietly({ guardQuietCritical: 'defer', guardRepeat: false }), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($); await block($)
    expect(w.notified).toEqual([])
    expect(outcomes(held)).toEqual(['security-failure:deferred', 'run-blocked:deferred'])
    await w.clock.advance(14 * MIN)
    expect(w.notified.length).toBe(1)
    expect(w.notified[0]!.text).toBe('Cobalt Guard · task 1, quiet hours ended: 2 conditions are still open; the first: a security check failed; the task cannot be called verified. Nothing was approved or released. /cockpit guard')
    expect(outcomes(held)).toEqual(['security-failure:deferred', 'run-blocked:deferred', 'security-failure:sent', 'run-blocked:sent'])
    expect(await say($, 'guard')).toContain('Armed · 1 of 5 alerts used this session')
    await w.clock.advance(12 * HOUR)
    await progress($, { action: 'status' })
    expect(w.notified.length).toBe(1)
  })
  // The host-backed virtual reminder sequence exceeded 5s under full-suite contention.
  test('with reminders on, a long window owes one reminder afterwards, not one per interval missed', { timeoutMs: 20000, options: { guardAlerts: true, guardCooldownSec: 30, guardRepeat: true, guardRepeatSec: 600, guardMaxReminders: 3, guardMaxAlerts: 10, guardQuietHours: '00:20-01:20', guardQuietTimezone: 'UTC' } }, async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    // 00:16: before the window, so it is sent
    expect(w.notified.length).toBe(1)
    // an hour of window is five reminder intervals missed (the timer looks every 30 seconds throughout)
    await w.clock.advance(55 * MIN)
    expect(w.notified.length).toBe(1)
    // 01:20 passes: exactly one reminder, then the next a whole interval later
    await w.clock.advance(10 * MIN)
    expect(w.notified.length).toBe(2)
    expect(w.notified[1]!.text).toContain('still open (reminder 1 of 3)')
    await w.clock.advance(8 * MIN)
    expect(w.notified.length).toBe(2)
    expect(outcomes(held)).toEqual(['run-blocked:sent', 'run-blocked:sent#1'])
    await w.clock.advance(2 * MIN)
    expect(w.notified.length).toBe(3)
    expect(w.notified[2]!.text).toContain('reminder 2 of 3')
  })
  test('acknowledged before the window ends: nothing is sent afterwards, and the pin is gone', quietly(), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    expect(await guardRow($)).toContain('DEFERRED')
    const out = await say($, 'guard ack')
    expect(out).toContain('ACTIVE NORMAL run-blocked · task 1 · DEFERRED, quiet hours · acknowledged')
    expect(out).toContain('The verification verdict was not changed.')
    expect(await guardRow($)).not.toContain('▲')
    await w.clock.advance(12 * HOUR)
    await progress($, { action: 'status' })
    expect(w.notified).toEqual([])
    expect(outcomes(held)).toEqual(['run-blocked:deferred'])
    expect(task(held).blocker).toBe('needs the owner')
  })
  test('a deferral whose kind is turned off afterwards is not sent and not promised', quietly({ guardQuietHours: '22:00-00:10', guardNotifyKinds: 'none' }), async ($, on) => {
    const t = settle(applyAction(settle(applyAction(newTask(1, 'goal', 100, null), { action: 'plan', milestones: FIVE.slice(0, 3) } as never, 101, null).task).task, { action: 'block', milestone: 'm1', note: 'needs the owner' } as never, 102, null).task).task
    const w = world(on, {}, { 'ledger:s1': { ...emptyLedger('s1'), alerts: [deferred(`${t.id}@${t.startedAt}:run-blocked:task`, { at: 1 })] } })
    on('session.id', () => ({ value: 's1' }))
    const held = hostState(on, { task: t })
    await start($)
    await w.clock.advance(HOUR)
    expect(w.notified).toEqual([])
    expect(outcomes(held)).toEqual(['run-blocked:deferred', 'run-blocked:silenced'])
    const status = await say($, 'guard')
    expect(status).toContain('NOT NOTIFIED, kind off')
    expect(status).not.toContain('owed a notification')
  })
  test('resolved before the window ends: recorded resolved, never announced, and the pin is gone', quietly(), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    await progress($, { action: 'unblock', milestone: 'm2' })
    expect(outcomes(held)).toEqual(['run-blocked:deferred', 'run-blocked:resolved'])
    expect(await guardRow($)).not.toContain('▲')
    await w.clock.advance(12 * HOUR)
    expect(w.notified).toEqual([])
    // it holds again the next day, outside the window: a new occurrence, told as usual
    await block($)
    expect(w.notified.length).toBe(1)
  })
  test('the task is reset while an alert is deferred: nothing is sent for it, and the timer finds nothing left', quietly(), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    expect(await say($, 'reset')).toContain('task cleared')
    expect(await guardRow($)).not.toContain('▲')
    await w.clock.advance(12 * HOUR)
    expect(w.notified).toEqual([])
    expect(outcomes(held)).toEqual(['run-blocked:deferred', 'run-blocked:resolved'])
  })
  test('a new task does not inherit the old one\'s deferral', quietly(), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    await say($, 'reset')
    await planAndComplete($, 1)
    await w.clock.advance(14 * MIN)
    expect(w.notified).toEqual([])
    expect(outcomes(held)).toEqual(['run-blocked:deferred', 'run-blocked:resolved'])
    expect(await guardRow($)).not.toContain('▲')
  })
  test('the session ending cancels the timer: nothing is sent after it', quietly(), async ($, on) => {
    const w = world(on)
    await start($); await planAndComplete($, 1); await block($)
    await $.session.end({ reason: 'exit', sessionId: 's1' } as never)
    await w.clock.advance(12 * HOUR)
    expect(w.notified).toEqual([])
  })
  test('a silence in the window leaves the deferral unsent after it; unsilence does not replay it', quietly(), async ($, on) => {
    const w = world(on)
    await start($); await planAndComplete($, 1); await block($)
    await say($, 'guard silence')
    await w.clock.advance(12 * HOUR)
    expect(w.notified).toEqual([])
    await say($, 'guard unsilence')
    await w.clock.advance(MIN)
    await progress($, { action: 'status' })
    expect(w.notified).toEqual([])
  })
  test('the cooldown and the budget still bound what is told after the window', quietly({ guardMaxAlerts: 1, guardQuietHours: '00:17-00:30' }), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    // 00:16, before the window: the session's one alert is spent
    expect(w.notified.length).toBe(1)
    await w.clock.advance(MIN)
    await block($)
    expect(outcomes(held)).toEqual(['security-failure:sent', 'run-blocked:deferred'])
    await w.clock.advance(12 * HOUR)
    await progress($, { action: 'status' })
    expect(w.notified.length).toBe(1)
    expect(outcomes(held)).toEqual(['security-failure:sent', 'run-blocked:deferred', 'run-blocked:throttled'])
    expect(await say($, 'guard')).toContain('ACTIVE NORMAL run-blocked · task 1 · HELD BACK, cooldown or budget · not acknowledged')
  })
  test('settings that are not understood hold nothing back', quietly({ guardQuietTimezone: 'Mars/Phobos' }), async ($, on) => {
    const w = world(on)
    await start($); await planAndComplete($, 1); await block($)
    expect(w.notified.length).toBe(1)
    const status = await say($, 'guard')
    expect(status).toContain('Quiet hours: NOT IN FORCE')
    expect(status).toContain('WARN guardQuietTimezone is not a time zone this machine knows')
  })
  test('a window that is not understood holds nothing back either', quietly({ guardQuietHours: 'overnight' }), async ($, on) => {
    const w = world(on)
    await start($); await planAndComplete($, 1); await block($)
    expect(w.notified.length).toBe(1)
    expect(await say($, 'guard')).toContain('WARN guardQuietHours is not a window like 22:00-07:00')
  })
  test('the window is read in its zone: the same moment is day in Tokyo', quietly({ guardQuietTimezone: 'Asia/Tokyo' }), async ($, on) => {
    const w = world(on)
    await start($); await planAndComplete($, 1); await block($)
    // 00:16 UTC is 09:16 in Tokyo
    expect(w.notified.length).toBe(1)
    expect(await say($, 'guard')).toContain('now 09:16 there · not active')
  })
  test('on the bell-only channel a kept alert is reported as audible, never as quiet', quietly(), async ($, on) => {
    const w = world(on, { notifyChannel: 'terminal_bell' })
    await start($); await planAndComplete($, 1); await failSecurity($)
    expect(w.notified.length).toBe(1)
    const status = await say($, 'guard')
    expect(status).toContain('critical alerts (security failure): still sent · AUDIBLE: your channel is the terminal bell, so the notification itself rings')
    expect(status).toContain('ordinary alerts: DEFERRED until 00:30: nothing is written to your terminal, so nothing rings')
    expect(status).toContain('security-failure · task 1 · sent via terminal_bell')
  })
})

describe('in a run: notified kinds', () => {
  test('a kind that is off is not notified, and is still recorded, pinned and listed', { options: { guardAlerts: true, guardCooldownSec: 30, guardNotifyKinds: 'release-no-go' } }, async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    expect(w.notified).toEqual([])
    expect(outcomes(held)).toEqual(['run-blocked:silenced'])
    expect((ledger(held).alerts ?? [])[0]!.why).toBe('kind-off')
    expect(await guardRow($)).toContain('GUARD ▲ NORMAL run blocked · task 1 · NOT NOTIFIED, kind off')
    const status = await say($, 'guard')
    expect(status).toContain('NOT notified: verification-exhausted, review-hold, run-blocked')
    expect(status).toContain('ACTIVE NORMAL run-blocked · task 1 · NOT NOTIFIED, kind off · not acknowledged')
    await progress($, { action: 'status' })
    await w.clock.advance(HOUR)
    expect(outcomes(held)).toEqual(['run-blocked:silenced'])
    // the critical kind cannot be turned off
    await failSecurity($)
    expect(w.notified.length).toBe(1)
    expect(w.notified[0]!.text).toContain('a security check failed')
    expect(await guardRow($)).toContain('GUARD ▲ CRITICAL security check failed')
    expect(await guardRow($)).toContain('+1 more')
  })
  test('a list that is not understood notifies every kind and warns', { options: { guardAlerts: true, guardNotifyKinds: 'blocked-runs' } }, async ($, on) => {
    const w = world(on)
    await start($); await planAndComplete($, 1); await block($)
    expect(w.notified.length).toBe(1)
    expect(await say($, 'guard')).toContain('WARN guardNotifyKinds names no kind Cockpit knows, so every kind is notified')
  })
  test('a new condition while the session is silenced is not notified but stays on the HUD', { options: { guardAlerts: true, guardCooldownSec: 30 } }, async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1)
    await say($, 'guard silence')
    // a record decided in the very millisecond of the silence is covered by it; this one comes later
    await w.clock.advance(1000)
    await block($)
    expect(w.notified).toEqual([])
    expect(outcomes(held)).toEqual(['run-blocked:silenced'])
    expect(await guardRow($)).toContain('GUARD ▲ NORMAL run blocked · task 1 · NOT NOTIFIED, silenced')
    await progress($, { action: 'status' })
    expect(outcomes(held)).toEqual(['run-blocked:silenced'])
  })
})

describe('in a run: the pinned row', () => {
  const session = (on: any) => on('session.id', () => ({ value: 's1' }))
  test('with alerts off the HUD has no alert row at all', async ($, on) => {
    world(on); hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    expect(await guardRow($)).toBeUndefined()
  })
  test('armed with nothing open: the unconfirmed transport is surfaced, and a confirmation clears it', { options: { guardAlerts: true } }, async ($, on) => {
    const w = world(on); hostState(on, {}); session(on)
    await start($)
    expect(await guardRow($)).toBe('GUARD: ARMED · transport not confirmed · /cockpit guard test')
    await say($, 'guard test')
    // sent is not confirmed: only the person's statement clears it
    expect(await guardRow($)).toBe('GUARD: ARMED · transport not confirmed · /cockpit guard test')
    const code = /TEST ([A-Z0-9]{4}):/.exec(w.notified[0]!.text)![1]!
    await say($, `guard seen ${code}`)
    expect(await guardRow($)).toBe('GUARD: ARMED')
  })
  test('a raised condition is pinned with its level; an acknowledgment clears it; so does its resolution', { options: { guardAlerts: true, guardCooldownSec: 30 } }, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await failSecurity($)
    const pinned = (await guardRow($))!
    expect(pinned).toBe('GUARD ▲ CRITICAL security check failed · task 1 · notification SENT, not acknowledged · transport not confirmed')
    expect(pinned).not.toMatch(NEVER_CLAIMED)
    await say($, 'guard ack')
    // v0.6.2: the pin is gone, but the failed gate still holds, so the row says an acknowledged condition is still open
    expect(await guardRow($)).toBe('GUARD: ARMED · 1 acknowledged, still open · transport not confirmed · /cockpit alerts digest')
    // the acknowledgment cleared the pin and nothing else
    expect(task(held).gates.SECURITY.state).toBe('fail')
    // a second condition, later, is pinned on its own; fixing it clears it without any acknowledgment
    await w.clock.advance(MIN)
    await block($)
    expect(await guardRow($)).toContain('GUARD ▲ NORMAL run blocked')
    await progress($, { action: 'unblock', milestone: 'm2' })
    expect(await guardRow($)).not.toContain('▲')
  })
  test('a failed notification is pinned as not sent', { options: { guardAlerts: true } }, async ($, on) => {
    world(on, { notifyMode: 'disabled' }); hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    expect(await guardRow($)).toContain('GUARD ▲ NORMAL run blocked · task 1 · notification NOT SENT')
  })
  test('it respects the width, down to a narrow band', { options: { guardAlerts: true } }, async ($, on) => {
    world(on); hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    for (const columns of [200, 120, 80, 60, 44, 30, 24]) {
      const row = (await guardRow($, columns))!
      expect(row.length).toBeLessThanOrEqual(columns)
      expect(row).toContain('▲ CRITICAL')
    }
    expect(await guardRow($, 200)).toContain('· /cockpit alerts')
  })
  test('reduced motion draws the identical row: the pin never animates', { options: { guardAlerts: true, reducedMotion: true } }, async ($, on) => {
    world(on); hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    expect(await guardRow($)).toBe('GUARD ▲ CRITICAL security check failed · task 1 · notification SENT, not acknowledged · transport not confirmed')
  })
  test('the pin is apart from progress and verification: the other rows are what they were', { options: { guardAlerts: true } }, async ($, on) => {
    world(on); hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1)
    const calm = (await rowsOf(await mountHud($, 'terminal'))).filter(r => !r.includes('GUARD'))
    await say($, 'guard test')
    const tested = (await rowsOf(await mountHud($, 'terminal'))).filter(r => !r.includes('GUARD'))
    expect(tested).toEqual(calm)
  })
  test('doctor lists the same status, warnings as warnings', { options: { guardAlerts: true, guardQuietHours: '23:00-00:30', guardQuietTimezone: 'Mars/Phobos', guardNotifyKinds: 'run-blocked' } }, async ($, on) => {
    world(on); hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    const text = await say($, 'doctor')
    expect(text).toContain('INFO Priority: CRITICAL security-failure')
    expect(text).toContain('INFO Notified kinds: security-failure, run-blocked · NOT notified: release-no-go, verification-exhausted, review-hold')
    expect(text).toContain('INFO Quiet hours: NOT IN FORCE')
    expect(text).toContain('WARN guardQuietTimezone is not a time zone this machine knows')
    expect(text).toContain('INFO ACTIVE NORMAL run-blocked · task 1 · notification SENT · not acknowledged')
  })
})

describe('reload and restart', () => {
  const blockedTask = (): Task => {
    let t = newTask(1, 'goal', 100, null)
    t = settle(applyAction(t, { action: 'plan', milestones: FIVE.slice(0, 3) } as never, 101, null).task).task

    return settle(applyAction(t, { action: 'block', milestone: 'm1', note: 'needs the owner' } as never, 102, null).task).task
  }
  const keyOfTask = (t: Task) => `${t.id}@${t.startedAt}:run-blocked:task`
  test('a reload inside the window keeps the deferral: one timer, nothing sent, then told once', quietly(), async ($, on) => {
    const t = blockedTask()
    const w = world(on, {}, { 'ledger:s1': { ...emptyLedger('s1'), alerts: [deferred(keyOfTask(t), { at: 1 })] } })
    on('session.id', () => ({ value: 's1' }))
    const held = hostState(on, { task: t })
    await start($); await start($); await start($)
    await w.clock.advance(13 * MIN)
    expect(w.notified).toEqual([])
    await w.clock.advance(MIN)
    expect(w.notified.length).toBe(1)
    await w.clock.advance(6 * HOUR)
    expect(w.notified.length).toBe(1)
    expect(outcomes(held)).toEqual(['run-blocked:deferred', 'run-blocked:sent'])
  })
  test('a restart after the window has ended tells what was held back, once', quietly({ guardQuietHours: '22:00-00:10' }), async ($, on) => {
    const t = blockedTask()
    const w = world(on, {}, { 'ledger:s1': { ...emptyLedger('s1'), alerts: [deferred(keyOfTask(t), { at: 1 })] } })
    on('session.id', () => ({ value: 's1' }))
    hostState(on, { task: t })
    await start($)
    expect(w.notified).toEqual([])
    await w.clock.advance(31_000)
    expect(w.notified.length).toBe(1)
    await w.clock.advance(6 * HOUR)
    expect(w.notified.length).toBe(1)
  })
  test('a stored deferral of a task that is gone is never told, and not recorded resolved by a session that never held it', quietly(), async ($, on) => {
    const w = world(on, {}, { 'ledger:s1': { ...emptyLedger('s1'), alerts: [deferred('9@9:run-blocked:task', { at: 1, taskId: 9 })] } })
    on('session.id', () => ({ value: 's1' }))
    const held = hostState(on, {})
    await start($)
    await w.clock.advance(12 * HOUR)
    expect(w.notified).toEqual([])
    expect(outcomes(held)).toEqual(['run-blocked:deferred'])
  })
  test('quiet hours turned off after a deferral: it is told at the next look', { options: { guardAlerts: true, guardCooldownSec: 30 } }, async ($, on) => {
    const t = blockedTask()
    const w = world(on, {}, { 'ledger:s1': { ...emptyLedger('s1'), alerts: [deferred(keyOfTask(t), { at: 1 })] } })
    on('session.id', () => ({ value: 's1' }))
    hostState(on, { task: t })
    await start($)
    await w.clock.advance(31_000)
    expect(w.notified.length).toBe(1)
  })
  test('malformed stored records neither throw nor hold anything back', quietly(), async ($, on) => {
    const t = blockedTask()
    const w = world(on, {}, { 'ledger:s1': { ...emptyLedger('s1'), alerts: [{ ...deferred(keyOfTask(t)), why: 'night' }, { key: 7 }, null, { ...deferred(keyOfTask(t)), outcome: 'postponed' }] } })
    on('session.id', () => ({ value: 's1' }))
    const held = hostState(on, { task: t })
    await start($)
    expect(ledger(held).alerts ?? []).toEqual([])
    expect(await say($, 'guard')).toContain('GUARD:')
    expect(await guardRow($)).not.toContain('▲')
  })
})
