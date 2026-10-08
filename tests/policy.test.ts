// The model policy on its own: what counts as a name for Fable, and which
// calls, commands and edits are routes to it. Pure, so every case is a value.

import { describe, expect, test } from 'claude-code/testing'

import {
  BLOCK_DENY,
  BLOCK_LINE,
  EMPTY_POLICY,
  answered,
  blocked,
  fableConfigured,
  fableInCall,
  fableInCommand,
  fableInSettings,
  fableRoute,
  isFable,
} from '../hooks/policy'

describe('a name that identifies Fable', () => {
  for (const name of [
    'fable',
    'claude-fable',
    'advisor-fable',
    'claude-fable-5-1',
    'claude-fable-5-1[1m]',
    'claude-fable-5',
    'us.anthropic.claude-fable-5-1-v1:0',
    'anthropic/claude-fable-5-1',
    'fable-5.1',
    'fable5',
    'mcp__fable__ask',
    'mcp__advisor-fable__consult',
    'advisor_fable',
  ]) {
    test(`${name} is refused`, () => {
      expect(isFable(name)).toBe(true)
    })
  }

  for (const name of ['Fable', 'FABLE', 'Claude-Fable-5-1', 'CLAUDE-FABLE', 'Advisor-Fable', 'aDvIsOr-FaBlE', 'advisorFable', 'claudeFable51']) {
    test(`mixed case ${name} is refused`, () => {
      expect(isFable(name)).toBe(true)
    })
  }

  test('a name dressed up with compatibility forms or invisible characters is still read', () => {
    // fullwidth letters fold to ASCII, and a zero-width space is dropped
    expect(isFable('ｆａｂｌｅ')).toBe(true)
    expect(isFable('fa\u200Bble')).toBe(true)
    expect(isFable('claude-\u2060fable')).toBe(true)
  })

  for (const name of [
    'opus',
    'sonnet',
    'haiku',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-4-5-20251001',
    'opusplan',
    'inherit',
    'general-purpose',
    'Explore',
    'cobalt-cockpit:worker',
    'cobalt-cockpit:reviewer',
    'nobodywho',
    'Qwen_Qwen3-4B-Q4_K_M',
    'affable',
    'fables',
    'unfabled',
    '',
  ]) {
    test(`${name} is not Fable`, () => {
      expect(isFable(name)).toBe(false)
    })
  }

  test('only a string can name a model', () => {
    for (const value of [undefined, null, 0, 51, true, {}, ['fable'], { model: 'fable' }]) expect(isFable(value)).toBe(false)
  })
})

describe('a tool call that would reach Fable', () => {
  test('the Agent tool with a Fable model, by any spelling', () => {
    for (const model of ['fable', 'Fable', 'claude-fable-5-1', 'advisor-fable', 'CLAUDE-FABLE']) {
      expect(fableInCall('Agent', { prompt: 'x', description: 'y', model })).toBe(true)
      expect(fableInCall('Task', { prompt: 'x', model })).toBe(true)
    }
  })

  test('the Agent tool with an agent type named for it', () => {
    expect(fableInCall('Agent', { prompt: 'x', subagent_type: 'advisor-fable' })).toBe(true)
    expect(fableInCall('Agent', { prompt: 'x', subagent_type: 'plugin:fable' })).toBe(true)
  })

  test('a tool whose own name identifies it', () => {
    expect(fableInCall('mcp__advisor-fable__ask', { question: 'x' })).toBe(true)
    expect(fableInCall('mcp__fable__complete', {})).toBe(true)
    expect(fableInCall('FableAdvisor', {})).toBe(true)
  })

  test('any tool handed Fable as its model, provider or advisor', () => {
    expect(fableInCall('mcp__llm__complete', { model: 'claude-fable-5-1', prompt: 'x' })).toBe(true)
    expect(fableInCall('mcp__llm__complete', { provider: 'anthropic/claude-fable-5-1' })).toBe(true)
    expect(fableInCall('mcp__router__ask', { advisor: 'fable' })).toBe(true)
    expect(fableInCall('mcp__router__ask', { advisor_model: 'Fable' })).toBe(true)
    expect(fableInCall('mcp__router__ask', { fallbackModel: 'fable' })).toBe(true)
  })

  test('Opus, Sonnet and Haiku pass, named or not', () => {
    for (const model of ['opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5-5', undefined]) {
      expect(fableInCall('Agent', { prompt: 'x', subagent_type: 'cobalt-cockpit:worker', ...(model === undefined ? {} : { model }) })).toBe(false)
    }
  })

  test('free text that mentions the word is not a route', () => {
    expect(fableInCall('Agent', { prompt: 'Explain why fable is blocked', description: 'fable policy notes', name: 'fable-notes' })).toBe(false)
    expect(fableInCall('Grep', { pattern: 'fable', path: '.' })).toBe(false)
    expect(fableInCall('Read', { file_path: '/work/docs/fable.md' })).toBe(false)
    expect(fableInCall('Write', { file_path: '/work/notes.md', content: 'claude-fable-5-1 is blocked' })).toBe(false)
    expect(fableInCall('WebSearch', { query: 'Aesop fable summary' })).toBe(false)
    // a file handed as a "model" is a file, not a Claude model
    expect(fableInCall('mcp__comfy__download_model', { model: 'fable-xl.safetensors' })).toBe(false)
  })
})

describe('a shell command that would start Fable', () => {
  for (const command of [
    'cfable',
    'cfable -p "hello"',
    'claude --model fable',
    'claude --model=fable -p hi',
    'claude -p hi --model claude-fable-5-1',
    'claude --model Claude-FABLE-5-1',
    'claude --advisor fable',
    'claude --advisor=claude-fable-5-1 -p hi',
    'claude --fallback-model fable -p hi',
    'command claude --model fable',
    'env CLAUDE_CONFIG_DIR=/x claude --model fable',
    'timeout 60 claude -p hi --model fable',
    'cd /work && claude --model fable -p "go"',
    'echo hi | claude -p --model fable',
    'ANTHROPIC_MODEL=claude-fable-5-1 claude -p hi',
    'ANTHROPIC_DEFAULT_OPUS_MODEL=claude-fable-5-1 claude',
    'CLAUDE_CODE_SUBAGENT_MODEL=fable claude -p hi',
    'export ANTHROPIC_MODEL=fable',
    'env ANTHROPIC_MODEL=fable claude -p hi',
    'declare -x ANTHROPIC_DEFAULT_SONNET_MODEL=claude-fable-5-1',
    'ANTHROPIC_MODEL=fable',
    'bash -c "claude --model fable -p hi"',
    "sh -c 'cfable'",
    'echo $(claude -p hi --model fable)',
    'csmart --model fable',
    'claude --settings \'{"model":"claude-fable-5-1"}\' -p hi',
    'claude --settings \'{"advisorModel":"fable"}\'',
    '/home/example/.local/bin/claude --model fable',
  ]) {
    test(`${command} is refused`, () => {
      expect(fableInCommand(command)).toBe(true)
    })
  }

  for (const command of [
    'grep -rn fable .',
    'rg -i "claude-fable" hooks/',
    'echo "claude --model fable"',
    'git commit -m "block fable in the cockpit"',
    'cat docs/fable.md',
    'claude --model opus -p hi',
    'claude --model sonnet',
    'claude plugin test .',
    'claude plugin validate --strict .',
    'claude -p "is fable blocked?" --model sonnet',
    'ANTHROPIC_MODEL=claude-opus-5-5 claude -p hi',
    'decision ask --caller claude --json \'{"question":"fable?","choices":{"a":"x","b":"y"}}\'',
    'decision prune --caller claude -- bash -c "npm test"',
    'grep -n ANTHROPIC_MODEL=fable notes.md',
    'echo ANTHROPIC_MODEL=claude-fable-5-1',
    'npm test',
    'ls',
  ]) {
    test(`${command} runs`, () => {
      expect(fableInCommand(command)).toBe(false)
    })
  }
})

describe('an edit that would configure Fable', () => {
  test('a Claude settings file given Fable as a model, an advisor or an alias target', () => {
    expect(fableInSettings('/home/example/.claude-main/settings.json', '{ "model": "claude-fable-5-1" }')).toBe(true)
    expect(fableInSettings('/work/.claude/settings.local.json', '{"advisorModel":"fable"}')).toBe(true)
    expect(fableInSettings('/work/.claude/settings.json', '{"env":{"ANTHROPIC_DEFAULT_OPUS_MODEL":"claude-fable-5-1"}}')).toBe(true)
    expect(fableInSettings('/home/example/.claude.json', '"fallbackModel": "Fable"')).toBe(true)
  })

  test('denying it, and any other file, is not configuring it', () => {
    expect(fableInSettings('/home/example/.claude-main/settings.json', '{ "deniedModels": ["fable", "claude-fable-5-1"] }')).toBe(false)
    expect(fableInSettings('/home/example/.claude-main/settings.json', '{ "model": "opus" }')).toBe(false)
    expect(fableInSettings('/work/tests/policy.test.ts', '{ "model": "claude-fable-5-1" }')).toBe(false)
    expect(fableInSettings('/work/README.md', '"model": "fable"')).toBe(false)
  })

  test('an advisor set to Fable in the settings is seen', () => {
    expect(fableConfigured({ advisorModel: 'claude-fable-5-1' })).toBe(true)
    expect(fableConfigured({ advisorModel: 'Fable' })).toBe(true)
    expect(fableConfigured({ advisorModel: 'opus' })).toBe(false)
    expect(fableConfigured({})).toBe(false)
    expect(fableConfigured({ deniedModels: ['fable'] })).toBe(false)
  })
})

describe('one check for every tool call', () => {
  test('each route is caught through it', () => {
    expect(fableRoute('Agent', { prompt: 'x', model: 'fable' })).toBe(true)
    expect(fableRoute('mcp__advisor-fable__ask', {})).toBe(true)
    expect(fableRoute('Bash', { command: 'cfable -p hi' })).toBe(true)
    expect(fableRoute('Bash', { command: 'claude --model Fable' })).toBe(true)
    expect(fableRoute('Edit', { file_path: '/home/example/.claude-main/settings.json', old_string: '"model": "opus"', new_string: '"model": "claude-fable-5-1"' })).toBe(true)
    expect(fableRoute('Write', { file_path: '/work/.claude/settings.json', content: '{"advisorModel":"fable"}' })).toBe(true)
  })

  test('ordinary work passes, including work about this policy', () => {
    expect(fableRoute('Bash', { command: 'grep -rn fable tests/' })).toBe(false)
    expect(fableRoute('Bash', { command: 'npm test' })).toBe(false)
    expect(fableRoute('Edit', { file_path: '/work/tests/policy.test.ts', old_string: 'a', new_string: "isFable('claude-fable-5-1')" })).toBe(false)
    expect(fableRoute('Agent', { prompt: 'implement it', subagent_type: 'cobalt-cockpit:worker', model: 'sonnet' })).toBe(false)
    expect(fableRoute('Agent', { prompt: 'plan it', model: 'opus' })).toBe(false)
    expect(fableRoute('Read', { file_path: '/work/a.ts' })).toBe(false)
  })

  test('it answers for input it was never meant to see, and never throws', () => {
    const odd: Record<string, unknown>[] = [{}, { command: 42 }, { command: null }, { file_path: {}, content: [] }, { model: { name: 'fable' } }, { command: '"unterminated $( claude --model fable' }]
    for (const input of odd) for (const tool of ['Bash', 'Edit', 'Write', 'Agent', 'Other']) expect(typeof fableRoute(tool, input)).toBe('boolean')
    // a command the parser cannot finish still does not start Fable
    expect(fableRoute('Bash', { command: 'claude --model fable "unterminated' })).toBe(true)
  })
})

describe('what a refusal leaves behind', () => {
  test('the record is one fixed line', () => {
    expect(BLOCK_LINE).toBe('MODEL BLOCK / FABLE / POLICY')
    expect(BLOCK_DENY.startsWith('MODEL BLOCK / FABLE / POLICY')).toBe(true)
  })

  test('a refusal is counted and carries nothing of the request', () => {
    const once = blocked(EMPTY_POLICY, 1000)
    expect(once).toEqual({ blocks: 1, calls: 0, lastBlockAt: 1000 })
    expect(Object.keys(blocked(once, 2000)).sort()).toEqual(['blocks', 'calls', 'lastBlockAt'])
    expect(blocked(once, 2000).blocks).toBe(2)
  })

  test('calls are counted from what really answered', () => {
    expect(answered(EMPTY_POLICY, 'claude-opus-5-5')).toBe(EMPTY_POLICY)
    expect(answered(EMPTY_POLICY, 'claude-sonnet-5-5').calls).toBe(0)
    expect(answered(EMPTY_POLICY, undefined).calls).toBe(0)
    expect(answered(EMPTY_POLICY, 'claude-fable-5-1').calls).toBe(1)
  })
})
