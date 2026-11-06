// Regressions from mission m-20261105162442-ec5924: requests above Cline's 64 KiB capture preview
// limit were judged "sent model (empty)", failing a correct DeepSeek run; and commander overhead.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { headFields, judgeWire, previewBodyHead, readWireCaptures } from '../src/reasoning.ts'
import { parsePlan, plannerPrompt, workerPrompt } from '../src/planner.ts'
import { byId, env, mission, task, tmp } from './helpers.ts'

const T = { timeout: 120_000 }
/** A capture exactly as Cline 3.0.74 writes it for a body above the preview limit. */
const truncatedCapture = (body: Record<string, unknown>, limit = 65_536): Record<string, unknown> => {
  const text = JSON.stringify({ url: 'https://api.cline.bot/api/v1/chat/completions', method: 'POST', body: JSON.stringify(body) })
  return { timestamp: 't', captureStage: 'wire_request', payload: { truncated: true, bytes: Buffer.byteLength(text), sha256: 'a'.repeat(64), preview: text.slice(0, limit) } }
}
const big = (extra: Record<string, unknown> = {}) => ({ model: 'deepseek/deepseek-v4.1-flash-1017', max_tokens: 117964, reasoning_effort: 'max', ...extra, messages: [{ role: 'user', content: 'y'.repeat(120_000) + ' "model":"evil/other" "reasoning_effort":"low" ' }], tool_choice: 'auto' })

describe('truncated wire captures (root cause of the failed mission)', () => {
  test('model and effort are read from the escaped body head of a truncated preview', () => {
    const d = tmp('trunc'); mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'cap_run_x_1.wire_request.1.provider-request.json'), JSON.stringify(truncatedCapture(big())))
    const r = readWireCaptures(d)
    assert.deepEqual([r[0].source, r[0].model, r[0].effort], ['preview', 'deepseek/deepseek-v4.1-flash-1017', 'max'])
    assert.ok((r[0].bytes ?? 0) > 65_536)
    const v = judgeWire(r, 'deepseek/deepseek-v4.1-flash-1017', 'max')
    assert.equal(v.state, 'confirmed'); assert.match(v.detail, /truncated capture previews/)
  })
  test('text inside messages never counts as the request\'s model or effort', () => {
    const f = headFields(previewBodyHead(JSON.stringify({ body: JSON.stringify(big()) }).slice(0, 65_536)) ?? '')
    assert.equal(f.model, 'deepseek/deepseek-v4.1-flash-1017'); assert.equal(f.reasoning_effort, 'max')
  })
  test('an unreadable capture is unconfirmed with a true message, never "sent model (empty)"', () => {
    const v = judgeWire([{ file: 'a', model: null, effort: null, thinking: null, at: null, source: 'unreadable' }], 'deepseek/deepseek-v4.1-flash-1017', 'max')
    assert.equal(v.state, 'unconfirmed'); assert.match(v.detail, /unreadable/); assert.doesNotMatch(v.detail, /sent model/)
  })
  test('a readable different model is still a mismatch, even next to unreadable captures', () => {
    const v = judgeWire([{ file: 'a', model: null, effort: null, thinking: null, at: null }, { file: 'b', model: 'deepseek/deepseek-v4.1-flash', effort: 'max', thinking: 'on', at: null }], 'deepseek/deepseek-v4.1-flash-1017', 'max')
    assert.equal(v.state, 'mismatch'); assert.match(v.detail, /deepseek-v4\.1-flash instead of/)
  })
  test('a truncated head without the effort field is unconfirmed, not a downgrade', () => {
    const d = tmp('trunc2'); mkdirSync(d, { recursive: true })
    const b = big(); delete (b as { reasoning_effort?: string }).reasoning_effort
    writeFileSync(join(d, 'cap_run_x_1.wire_request.1.provider-request.json'), JSON.stringify(truncatedCapture(b)))
    assert.equal(judgeWire(readWireCaptures(d), 'deepseek/deepseek-v4.1-flash-1017', 'max').state, 'unconfirmed')
  })
  test('a full body that genuinely sends a lower effort is still a downgrade', () => {
    assert.equal(judgeWire([{ file: 'a', model: 'm', effort: 'high', thinking: 'on', at: null, source: 'body' }], 'm', 'max').state, 'mismatch')
  })
  test('end to end: a worker whose requests exceed the preview limit is confirmed and verified (was wire_mismatch)', T, async () => {
    const e = env(); const m = await mission(e, { tasks: [task('a', { prompt: '[[bigbody]] [[repeat:3]] [[write:src/a/out.txt=x]]' })] })
    const v = await m.run()
    assert.equal(v.state, 'DONE', v.reasons.join('; '))
    const a = byId(m, 'a').attempts[0]
    // the verdict now comes from the broker, which saw the full requests (the truncated previews are judged in the unit tests above)
    assert.equal(a.wire?.state, 'confirmed'); assert.match(a.wire?.detail ?? '', /broker carried 3 request\(s\) for deepseek\/deepseek-v4\.1-flash-1017 at reasoning max/)
    assert.ok(a.gates.some(g => g.name === 'sanity' && g.state === 'pass'), 'verification gates ran')
  })
})

describe('commander overhead', () => {
  test('the planner gets the real repository file list, so it need not explore with tool calls', T, async () => {
    const e = env(); const m = await mission(e, { goal: 'Redesign the architecture', swarm: true })
    const prompt = m.live.tasks.plan.spec.prompt
    assert.match(prompt, /README\.md/); assert.match(prompt, /src\/base\.txt/); assert.match(prompt, /tracked file/)
  })
  test('the planner is told to put architecture in "design", not in a separate read-only task', () => {
    const p = plannerPrompt('goal', 'repo'); assert.match(p, /"design"/); assert.match(p, /do NOT add a separate read-only design/)
  })
  test('a plan\'s design is handed to every planned task', T, async () => {
    const e = env()
    const plan = JSON.stringify({ design: 'Use a pure core module with a thin CLI wrapper.', tasks: [{ id: 'core', title: 'core', kind: 'implement', risk: 'medium', complexity: 3, mode: 'write', owned: ['src/core'], dependencies: [], prompt: '[[write:src/core/a.ts=x]]' }] })
    const m = await mission(e, { goal: `[[plan-b64:${Buffer.from(plan).toString('base64')}]] Redesign the architecture`, swarm: true })
    await m.run()
    // handed over as context (which routing never reads), and present in what the worker was sent
    const spec = byId(m, 'core').spec
    assert.match(spec.context ?? '', /Architecture from the commander's plan/); assert.match(spec.context ?? '', /pure core module/)
    assert.doesNotMatch(spec.prompt, /pure core module/)
    assert.match(readFileSync(join(m.dir, 'runs', 'core', '1', 'ro', 'prompt.txt'), 'utf8'), /Architecture from the commander's plan \(follow it\):\nUse a pure core module[\s\S]*\[\[write:src\/core\/a\.ts=x\]\]/)
  })
  test('design text is bounded and validated', () => {
    const long = '```json\n' + JSON.stringify({ design: 'd'.repeat(7000), tasks: [{ id: 'a', title: 'a', kind: 'implement', risk: 'low', complexity: 1, mode: 'write', owned: ['src'], dependencies: [], prompt: 'x' }] }) + '\n```'
    assert.equal(parsePlan(long).ok, false)
  })
  test('a dependency\'s result is passed to the task that depends on it (a design is no longer thrown away)', () => {
    const p = workerPrompt(task('impl'), { readOnly: false, allowedTools: ['editor'], dependencyResults: [{ id: 'design', text: 'Use module X with interface Y' }] })
    assert.match(p, /Results of the tasks this one depends on/); assert.match(p, /\[design\]\nUse module X/)
  })
  test('end to end: a read-only dependency\'s answer reaches its dependent\'s worker prompt', T, async () => {
    const e = env()
    const m = await mission(e, { tasks: [task('scan', { kind: 'scout', mode: 'read', risk: 'low', complexity: 1, owned: ['/src'], prompt: '[[say:The entry point is src/base.txt]]' }), task('impl', { dependencies: ['scan'] })] })
    await m.run()
    const { readFileSync } = await import('node:fs')
    const prompt = readFileSync(join(m.dir, 'runs', 'impl', '1', 'ro', 'prompt.txt'), 'utf8')
    assert.match(prompt, /\[scan\]\nThe entry point is src\/base\.txt/)
  })
})
