import { describe, expect, test } from 'claude-code/testing'
import { command, start, world } from './world'

describe('diff coverage, disabled', () => {
  test('the command says the layer is off and starts no process', async ($, on) => {
    const w = world(on)
    await start($)
    const before = w.runs.length
    const answer = await command($, 'coverage diff')
    expect(answer.text).toContain('The coverage layer is off.')
    expect(answer.text).toContain('ADVISORY ONLY.')
    expect(w.runs.length).toBe(before)
  })
})
