// The Activity Field's event model, held to two rules: it records only what the
// host really reported, and it can never carry anything private.

import { describe, expect, test } from 'claude-code/testing'

import {
  closeOf,
  currentOf,
  EMPTY_LOG,
  EVENT_MAX,
  EVENT_TTL_MS,
  eventOf,
  kindOf,
  liveOf,
  push,
  safeDetail,
  settledIds,
} from '../hooks/activity'
import type { ActivityEvent, ActivityLog } from '../hooks/activity'

const AT = 1_000

const read = (file = '/work/example/src/auth.ts') => eventOf('Read', { file_path: file }, AT, 'tu-1')
const finished = (over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: 'a',
  kind: 'READ',
  label: 'READ',
  detail: 'auth.ts',
  state: 'done',
  startedAt: AT,
  endedAt: AT + 10,
  ...over,
})

describe('events come from real observations', () => {
  test('a real read is a READ with its basename', () => {
    expect(read()).toMatchObject({ kind: 'READ', label: 'READ', detail: 'auth.ts', state: 'running', id: 'tu-1' })
  })

  test('a call with no use id still yields an event, keyed by its start', () => {
    const event = eventOf('Edit', { file_path: '/x/session.ts' }, AT)
    expect(event?.id).toBe(`at-${AT}`)
  })

  test('a tool that is not activity yields no event at all', () => {
    expect(kindOf('SomeMcpTool', {})).toBeNull()
    expect(eventOf('SomeMcpTool', {}, AT, 'tu-9')).toBeNull()
  })

  test('bash is classified by what it runs, not by the command being kept', () => {
    expect(kindOf('Bash', { command: 'git status' })).toBe('GIT')
    expect(kindOf('Bash', { command: 'pnpm test -- --run' })).toBe('TEST')
    expect(kindOf('Bash', { command: 'npm run build' })).toBe('BUILD')
    expect(kindOf('Bash', { command: 'ls -la' })).toBe('BASH')
    expect(kindOf('Bash', { command: '' })).toBeNull()
  })
})

describe('nothing sensitive reaches an event', () => {
  test('a bash command never becomes a detail', () => {
    expect(safeDetail('Bash', { command: 'curl -H "Authorization: Bearer sk-secret" https://x' })).toBe('')
  })

  test('a path is reduced to its basename', () => {
    expect(safeDetail('Read', { file_path: '/home/example/secret/keys/id_rsa.pub' })).toBe('id_rsa.pub')
    expect(safeDetail('Write', { file_path: '../../etc/passwd' })).toBe('passwd')
  })

  test('a subagent description is prompt text and is never read', () => {
    expect(safeDetail('Task', { description: 'read my AWS keys in ~/.aws/credentials' })).toBe('')
    const event = eventOf('Task', { description: 'secret prompt text', prompt: 'more secrets' }, AT, 'tu-2')
    expect(event?.detail).toBe('')
    expect(JSON.stringify(event)).not.toContain('secret')
  })

  test('a url contributes only its hostname', () => {
    expect(safeDetail('WebFetch', { url: 'https://docs.example.com/a/b?token=sekrit' })).toBe('docs.example.com')
  })

  test('file contents are not an input the model even offers', () => {
    const event = eventOf('Read', { file_path: 'a.ts', content: 'const password = 1' }, AT, 'tu-3')
    expect(JSON.stringify(event)).not.toContain('password')
  })
})

describe('the window is bounded and honest', () => {
  test('pushing many events keeps only the recent window', () => {
    let log = EMPTY_LOG
    for (let n = 0; n < EVENT_MAX + 20; n++) log = push(log, finished({ id: `e${n}` }))
    expect(log.events).toHaveLength(EVENT_MAX)
    // The newest survive; the oldest have genuinely fallen off.
    expect(log.events[log.events.length - 1]?.id).toBe(`e${EVENT_MAX + 19}`)
    expect(log.events.some(event => event.id === 'e0')).toBe(false)
  })

  test('the same id updates in place rather than stacking', () => {
    const log = push(push(EMPTY_LOG, finished({ id: 'x' })), finished({ id: 'x', detail: 'other.ts' }))
    expect(log.events.filter(event => event.id === 'x')).toHaveLength(1)
    expect(log.events[0]?.detail).toBe('other.ts')
  })

  test('a completion with no start changes nothing', () => {
    const log = push(EMPTY_LOG, finished({ id: 'a' }))
    const closed = closeOf(log, 'never-started', false, AT)
    expect(closed.events).toHaveLength(1)
    expect(closed.events[0]?.endedAt).toBe(AT + 10)
  })

  test('a real failure is recorded as failed, and only a real one', () => {
    const started = push(EMPTY_LOG, finished({ id: 'a', state: 'running', endedAt: null }))
    expect(closeOf(started, 'a', true, AT + 5).events[0]?.state).toBe('failed')
    expect(closeOf(started, 'a', false, AT + 5).events[0]?.state).toBe('done')
  })

  test('events expire by age, and a running one never does', () => {
    const log: ActivityLog = {
      events: [
        finished({ id: 'old', endedAt: AT }),
        finished({ id: 'live', state: 'running', endedAt: null }),
      ],
    }
    const live = liveOf(log, AT + EVENT_TTL_MS + 1)
    expect(live.map(event => event.id)).toEqual(['live'])
  })

  test('the current event is the one really in flight', () => {
    const events = [finished({ id: 'a', state: 'done' }), finished({ id: 'b', state: 'running', endedAt: null })]
    expect(currentOf(events)?.id).toBe('b')
    expect(currentOf([])).toBeNull()
  })

  test('only genuinely finished events count as settled', () => {
    const events = [finished({ id: 'a' }), finished({ id: 'b', state: 'failed' }), finished({ id: 'c', state: 'running', endedAt: null })]
    expect(settledIds(events)).toEqual(['a'])
  })
})