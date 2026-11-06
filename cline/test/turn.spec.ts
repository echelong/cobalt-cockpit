// Turn classification decides task fields only; the router then picks the model.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { classifyTurn, turnPrompt } from '../src/turn.ts'
import { routeTask } from '../src/router.ts'
import { config, resolutions } from './helpers.ts'

const role = async (text: string): Promise<string | null> => {
  const c = config(); const spec = classifyTurn(text, 't1').spec
  return routeTask({ task: spec, history: { attempts: 0, gateFailures: 0, escalated: false, lastFailure: null }, config: c, resolutions: await resolutions(c), health: {}, spentSessionUsd: 0 }).role
}

describe('conversational turns', () => {
  const cases: [string, string, string][] = [
    ['add a --verbose flag to the CLI', 'coder', 'ordinary change: DeepSeek 1017'],
    ['rename parseArgs to parseArguments everywhere', 'coder', 'refactor: DeepSeek 1017'],
    ['what does the router do?', 'coder', 'a question about the code stays on DeepSeek'],
    ['where are all the uses of base in the whole repo?', 'utility', 'inventory question: GLM'],
    ['which files import the cost module?', 'utility', 'inventory question: GLM'],
    ['build the responsive settings page component', 'frontend', 'UI work: Qwen 0902'],
    ['the test is flaky, debug the root cause', 'specialist', 'difficult debugging: MiMo'],
    ['Design the plugin architecture for the new storage layer', 'commander', 'architecture wording'],
  ]
  for (const [text, want, why] of cases) test(`${why}: "${text}"`, async () => assert.equal(await role(text), want))
  test('a question is read-only, a change writes', () => {
    assert.equal(classifyTurn('what does it do?', 't').spec.mode, 'read')
    assert.equal(classifyTurn('fix the parser', 't').spec.mode, 'write')
  })
  test('the prompt carries the bounded conversation and the files earlier turns changed', () => {
    const p = turnPrompt('and now add tests', [{ role: 'user', text: 'add a parser', turn: 't1', at: '' }, { role: 'assistant', text: 'Added src/parser.ts', turn: 't1', at: '' }], ['src/parser.ts'])
    assert.match(p, /Conversation so far/); assert.match(p, /Person: add a parser/); assert.match(p, /Files changed in earlier turns: src\/parser\.ts/); assert.match(p, /Current request from the person:\nand now add tests$/)
  })
  test('the conversation context is bounded', () => {
    const long = Array.from({ length: 50 }, (_, i) => ({ role: 'user' as const, text: 'x'.repeat(1000) + i, turn: `t${i}`, at: '' }))
    assert.ok(turnPrompt('next', long, []).length < 8000)
  })
})
