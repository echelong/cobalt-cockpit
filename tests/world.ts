// The world beneath the plugin, for tests: a clock that moves when told, a
// store in memory, a git that answers from a string, audio players that can
// be missing or broken, and tools that run nothing. Every call the plugin
// makes on the host is recorded, so a test asserts on what really happened.

import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

export const PLUGIN = 'cobalt-cockpit'
export const TOOL = 'mcp__cobalt-cockpit__progress'

export type PlayerBehavior = 'ok' | 'fails' | 'missing' | 'hangs'

export type World = {
  clock: MockClock
  /** Every `$.process.run`, as its argv. */
  runs: string[][]
  /** The environment each process was started with over the host's own, in the order of `runs`; undefined when none was given. */
  runEnvs: (Readonly<Record<string, string>> | undefined)[]
  /** The tool calls that reached the engine, in order: what actually ran. */
  ran: Record<string, unknown>[]
  /** The questions put to the person. */
  asked: string[]
  /** The label the person picks; null dismisses the dialog. */
  answer: string | null
  /** Lines the plugin wrote to the transcript (not the debug log). */
  transcript: string[]
  blits: number
  /** What `git status --porcelain=v2 --branch` prints; null: not a repository. */
  gitStatus: string | null
  players: Record<string, PlayerBehavior>
  /** A program that answers with this stdout (exit 0), by name; checked before `players`. */
  outputs: Record<string, (argv: readonly string[]) => string>
  /** The tools the plugin registered, as it registered them. */
  registered: Record<string, unknown>[]
  usage: { percent?: number; tokens?: number; window: number }
  files: Record<string, string>
  /** Commands that exit non-zero. */
  failing: RegExp | null
  /** Tools other than Bash that answer with an error, by name. */
  failingTools: string[]
  version: string
  /** What `prompt.submit` carried into the session. */
  submitted: { text: string; context: readonly string[] }[]
  /** Panes the plugin opened. */
  opened: string[]
  /** Runs while a question is on screen, before it is answered. */
  whileAsked: ((question: string) => Promise<void>) | null
  /** The credential the engine holds, as `$.session.authorize()` answers it; null: none. */
  credential: { handle: string; kind: 'bearer' | 'api-key' } | null
  /** What `$.settings.read()` answers. */
  settings: Record<string, unknown>
  /** The environment beneath the plugin; a test sets a variable before `start`. */
  env: Record<string, string>
  /** What `$.session.model()` answers: the main loop's model. */
  model: string
  /** The session's subagents, as `$.agent.list()` answers them. */
  agents: { id: string; description: string; type: string; status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed' }[]
  /** The spawns that reached the engine, as they arrived: what really started. */
  spawns: Record<string, unknown>[]
  /** The model requests that reached the engine: what was really sent. */
  requests: { model: string; agentId?: string }[]
  /** The effort each request really carried after the hooks rewrote it. */
  efforts: { model: string; effort?: unknown; agentId?: string }[]
  /** The model that answers a request, when it is not the one asked for. */
  answersAs: string | null
  /** Toasts the plugin showed. */
  toasts: string[]
  /** Every `/config` row the plugin set by itself, by key: a setting written, not read. */
  configured: string[]
  /**
   * Every way out to a model or the network the plugin took by itself, named:
   * `http.fetch`, `model.complete`, `model.fork`, `model.classify`, `mcp.call`.
   * The plugin has no business with any of them, so a test asserts this stays empty.
   */
  outbound: string[]
  /** Every value the plugin handed to `$.store.set`, in order: what it persisted
   * beyond the session, so a test can read back a stored ledger. */
  storeWrites: { key: string; value: unknown }[]
  /** Runs inside a process call, before it answers: a host event racing a process (a command typed while a router request is in flight). */
  duringRun: ((argv: readonly string[]) => void | Promise<void>) | null
  /** Runs inside the native tool call, before it answers: a host event racing a
   * tool (a turn completing while its handback is still running). */
  duringToolCall: ((call: Record<string, unknown>) => void | Promise<void>) | null
}

const MODEL_ALIAS: Record<string, string> = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' }

export const CLEAN_REPO = '# branch.oid 1111111aaaaaaa\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n'

const ran = (exitCode: number, stdout = '') => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

/** Registers the bottom of every chain the plugin reaches, and returns the handles a test steers by. */
export const world = (on: On, overrides: Partial<World> = {}, stored: Readonly<Record<string, unknown>> = {}): World => {
  const w: World = {
    clock: mock.clock(on, { now: 1_000_000 }),
    runs: [],
    runEnvs: [],
    ran: [],
    asked: [],
    answer: 'Cancel',
    transcript: [],
    blits: 0,
    gitStatus: CLEAN_REPO,
    players: { 'pw-play': 'ok' },
    outputs: {},
    registered: [],
    usage: { percent: 39, tokens: 78_000, window: 200_000 },
    files: {},
    failing: null,
    failingTools: [],
    version: '2.1.288',
    submitted: [],
    opened: [],
    whileAsked: null,
    credential: { handle: 'held-by-the-engine', kind: 'bearer' },
    settings: {},
    env: {},
    model: 'claude-opus-5-5',
    agents: [],
    spawns: [],
    requests: [],
    efforts: [],
    answersAs: null,
    toasts: [],
    configured: [],
    outbound: [],
    storeWrites: [],
    duringToolCall: null,
    duringRun: null,
    ...overrides,
  }
  // A store write is the plugin's durable persistence. `mock.store` registers
  // `store.set` itself, so this outermost wildcard observes every write before
  // handing the event down to it. It records only `store.set` and passes all
  // other events through untouched.
  on('*', ($, e, next) => {
    if (next.is('store.set', e)) w.storeWrites.push({ key: e.key, value: e.value })

    return next(e)
  })
  mock.store(on, stored)
  mock.env(on, { HOME: '/home/tester', ...w.env })

  on('session.version', () => ({ value: { version: w.version, base: w.version } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: w.usage.window, ...(w.usage.percent === undefined ? {} : { percent: w.usage.percent, tokens: w.usage.tokens ?? 0 }) }, rateLimits: [] },
  }))
  on('config.list', () => ({ value: [] }))
  // The engine starting a subagent: it resolves the model the spawn names (an
  // alias to its id, none to the haiku this world has always answered) and
  // lists the agent as running until its turn completes.
  on('agent.spawn', ($, e) => {
    w.spawns.push(e as unknown as Record<string, unknown>)
    const agentId = `spawned-${w.spawns.length}`
    w.agents.push({ id: agentId, description: e.description, type: e.subagentType, status: 'running' })

    return { agentId, model: e.model === undefined ? 'claude-haiku-4-5' : (MODEL_ALIAS[e.model] ?? e.model) }
  })
  on('agent.offer', () => ({ isOffered: true }))
  on('agent.list', () => ({ value: w.agents.map(one => ({ ...one })) }))
  on('session.model', () => ({ value: w.model }))
  on('session.authorize', () => ({ value: w.credential }))
  on('settings.read', () => ({ value: w.settings }))
  on('config.set', ($, e) => {
    w.configured.push(e.key)

    return { value: e.value }
  })
  on('http.fetch', ($, e) => {
    w.outbound.push(`http.fetch ${e.url}`)

    return { value: { status: 599, headers: {}, body: '' } } as never
  })
  on('model.complete', ($, e) => {
    w.outbound.push(`model.complete ${e.model}`)

    return { value: { reason: 'refused by the test world' } } as never
  })
  on('model.fork', () => {
    w.outbound.push('model.fork')

    return { value: { reason: 'refused by the test world' } } as never
  })
  on('model.classify', () => {
    w.outbound.push('model.classify')

    return { value: undefined }
  })
  on('mcp.call', ($, e) => {
    w.outbound.push(`mcp.call ${String((e as { server?: unknown }).server ?? '')}`)

    return { value: { content: [] } } as never
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)

    return { value: undefined }
  })
  // A model request reaching the engine: recorded, then answered by the model
  // it named unless the test says another one answers.
  on('turn.step', async function* ($, e) {
    w.requests.push({ model: e.model, ...(e.agentId === undefined ? {} : { agentId: e.agentId }) })
    w.efforts.push({ model: e.model, ...(e.effort === undefined ? {} : { effort: e.effort }), ...(e.agentId === undefined ? {} : { agentId: e.agentId }) })
    const usage = { model: w.answersAs ?? e.model, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    yield { kind: 'text', index: 0, text: 'ok' } as never
    yield { kind: 'stop', stopReason: 'end_turn', usage } as never

    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  on('session.cwd', () => ({ value: '/work/example' }))
  on('tool.register', ($, e) => { w.registered.push({ ...e }); return { value: { tool: `mcp__${PLUGIN}__${e.name}` } } })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.log', ($, e) => {
    if (e.to === 'transcript') w.transcript.push(e.text)

    return { value: undefined }
  })
  on('ui.blit', () => {
    w.blits += 1

    return { value: {} }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', ($, e) => {
    w.opened.push(e.id)

    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('fs.exists', ($, e) => ({ value: e.path in w.files }))
  // `stat` answers from the same map the reads come from, so a test that puts a
  // ledger in `files` gets a size that matches what `read` will hand back.
  on('fs.stat', ($, e) => {
    const text = w.files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)

    return { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const text = w.files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)

    return { value: text }
  })

  on('process.run', async ($, e) => {
    w.runs.push([...e.argv])
    w.runEnvs.push(e.init?.env)
    if (w.duringRun !== null) await w.duringRun(e.argv)
    const program = e.argv[0] ?? ''
    if (program === 'realpath') return ran(0, String(e.argv.at(-1)) + '\n')
    if (program === 'git') {
      if (w.gitStatus === null) return ran(128)

      return e.argv.includes('rev-parse') ? ran(0, '/work/example\n') : ran(0, w.gitStatus)
    }
    const output = w.outputs[program]
    if (output !== undefined) return ran(0, output(e.argv))
    const behavior = w.players[program] ?? 'missing'
    if (behavior === 'missing') throw new Error(`spawn ${program} ENOENT`)
    if (behavior === 'hangs') throw new Error(`${program} was still running at the timeout`)

    return ran(behavior === 'ok' ? 0 : 1)
  })

  // the engine's own drawing, where the plugin draws nothing or wraps it
  on('ui.render', ($, e) => {
    // a dialog is the engine's to draw: one engine node, which a hook may wrap
    if (e.component === 'AskUserQuestion') return { type: 'engine', ref: 1 }
    const { Box, Text } = $.ui.resolve(e)

    return Box({ children: [Text({ children: `engine:${e.component}` })] })
  })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('prompt.submit', ($, e) => {
    w.submitted.push({ text: e.text, context: e.context ?? [] })

    return { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => {
    // a subagent whose turn ended is no longer running
    const agent = w.agents.find(one => one.id === e.agentId)
    if (agent !== undefined) agent.status = e.reason === 'answer' ? 'completed' : 'failed'

    return { text: e.answer }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  on('attribution.text', ($, e) => ({ text: e.text }))
  on('command.run', () => ({ text: '' }))
  on('classic.PostToolUse', () => ({}))

  on('tool.call', async ($, e) => {
    const call = e as unknown as Record<string, unknown>
    w.ran.push(call)
    if (w.duringToolCall !== null) await w.duringToolCall(call)
    if (e.tool === 'AskUserQuestion') {
      const question = String((call['questions'] as { question: string }[])[0]?.question ?? '')
      w.asked.push(question)
      if (w.whileAsked !== null) await w.whileAsked(question)
      if (w.answer === null) return { deny: 'The user dismissed the question.' }

      return { result: { questions: call['questions'], answers: { [question]: w.answer } } } as never
    }
    if (e.tool === 'Bash') {
      const command = String(call['command'] ?? '')
      if (w.failing !== null && w.failing.test(command)) {
        return { isError: true, result: 'Exit code 1', text: 'Exit code 1' } as never
      }

      return { result: { stdout: '', stderr: '', interrupted: false } } as never
    }
    if (w.failingTools.includes(e.tool)) return { isError: true, result: 'The tool reported an error', text: 'The tool reported an error' } as never
    if (e.tool === 'Write' && !(String(call['file_path']) in w.files)) {
      return { result: { type: 'create', filePath: call['file_path'], content: call['content'], structuredPatch: [] } } as never
    }
    if (e.tool === 'Edit' || e.tool === 'Write') {
      return {
        result: { filePath: call['file_path'], structuredPatch: [{ lines: [' same', '+added one', '+added two', '-removed'] }] },
      } as never
    }

    return { result: {} } as never
  })

  return w
}

export const start = ($: Engine) => $.session.start({ cwd: '/work/example', surface: 'terminal', isInteractive: true })

export const prompt = ($: Engine, text: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

/** One call of the progress tool, answered with its text. */
export const progress = async ($: Engine, input: Record<string, unknown>): Promise<string> => {
  const answer = await $.tool.call({ tool: TOOL, ...input } as never)

  return String((answer as { result?: unknown }).result ?? '')
}

export const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command } as never)

const band = (columns: number, isWorking: boolean) => ({
  plugin: PLUGIN,
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking,
    maxRows: 12,
    bodyColumns: columns,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
  viewport: { columns, rows: 40, isFullscreen: true },
})

/** Mounts the HUD on a surface at a width. */
export const mountHud = ($: Engine, surface: 'terminal' | 'desktop', columns = 120, isWorking = false) =>
  $.ui.mount({ ...band(columns, isWorking), surface })

/** Mounts the Mission Control pane. */
export const mountPane = ($: Engine, surface: 'terminal' | 'desktop', columns = 80) =>
  $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    requestId: PLUGIN,
    props: {
      title: 'Cockpit',
      isFocused: false,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
    viewport: { columns: columns + 40, rows: 40, isFullscreen: true },
  })

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] } | string

const textOfNode = (node: unknown): string => {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (node === null || typeof node !== 'object') return ''
  const element = node as Exclude<Node, string>
  if (element.type === 'Raster') {
    const cells = Uint8Array.from(atob(String(element.props?.['cells'] ?? '')), c => c.charCodeAt(0))
    const view = new DataView(cells.buffer)
    return Array.from({ length: cells.length / 12 }, (_, i) => String.fromCodePoint(view.getUint32(i * 12, true))).join('')
  }
  if (element.type === 'Svg') return element.props?.['isInteractive'] ? '' : String(element.props?.['alt'] ?? '').split(' ')[0]?.slice(0, Math.floor(Number(element.props?.['width'] ?? 0) / 8)) ?? ''

  const children = element.children ?? (element.props?.['children'] as unknown[] | undefined) ?? []

  return (Array.isArray(children) ? children : [children]).map(textOfNode).join('')
}

/** Every element in the drawing, depth first, for assertions `find` cannot make. */
export const elementsOf = async (ui: { drawn: () => Promise<unknown> }): Promise<Exclude<Node, string>[]> => {
  const out: Exclude<Node, string>[] = []
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    const element = node as Exclude<Node, string>
    if (element.type !== undefined) out.push(element)
    for (const child of element.children ?? (element.props?.['children'] as unknown[] | undefined) ?? []) walk(child)
  }
  walk(await ui.drawn())

  return out
}

/** The one element of `type` a drawing carries, or undefined. */
export const elementOf = async (ui: { drawn: () => Promise<unknown> }, type: string, at = 0): Promise<Exclude<Node, string> | undefined> =>
  (await elementsOf(ui)).filter(one => one.type === type)[at]

/**
 * The foreground colour of the middle cell of the operator's badge, as the
 * `0x00RRGGBB` a Raster cell carries: what state the badge is painted in.
 */
export const badgeLitOf = async (ui: { drawn: () => Promise<unknown> }): Promise<number> => {
  const tree = (await ui.drawn()) as Exclude<Node, string>
  const find = (node: unknown): (Exclude<Node, string> & { props: Record<string, unknown> }) | undefined => {
    if (node === null || typeof node !== 'object') return undefined
    const element = node as Exclude<Node, string> & { props: Record<string, unknown> }
    if (element.type === 'Raster' && element.props['key'] === 'operator') return element
    for (const child of element.children ?? (element.props?.['children'] as unknown[] | undefined) ?? []) {
      const hit = find(child)
      if (hit !== undefined) return hit
    }

    return undefined
  }
  const badge = find(tree)
  const cells = Uint8Array.from(atob(String(badge?.props['cells'] ?? '')), c => c.charCodeAt(0))

  // cell layout is [codePoint, foreground, background]; the visor is cell one
  return new DataView(cells.buffer).getUint32(3 * 4 + 4, true)
}

/**
 * The engine's own drawing for a component, as the mock hands it back.
 *
 * `AbovePrompt` is documented as a band where "the engine draws nothing of its
 * own here", so in a real session `next(e)` resolves to nothing and Cockpit
 * simply keeps it. The mock still resolves it to a labelled sentinel row, which
 * `rowsOf` drops so a test reads Cockpit's rows and not the mock's marker.
 */
const isEngineSentinel = (node: unknown): boolean => typeof node === 'object' && node !== null && textOfNode(node) === 'engine:AbovePrompt'

/** The drawing as rows of text: one string per row Box or line; a Raster reads as `~`. */
export const rowsOf = async (ui: { drawn: () => Promise<unknown> }): Promise<string[]> => {
  const tree = (await ui.drawn()) as Exclude<Node, string>
  const children = tree.children ?? (tree.props?.['children'] as unknown[] | undefined) ?? []

  return (Array.isArray(children) ? children : [children]).filter(child => !isEngineSentinel(child)).map(textOfNode)
}

/**
 * The Activity Field as text: one string per row of its Raster, or its SVG's
 * alt when the surface has no Raster. The field is the first thing above the
 * HUD, so this reads the drawing element-by-element rather than by row index,
 * which keeps the assertion honest on either surface.
 */
export const fieldRowsOf = async (ui: { drawn: () => Promise<unknown> }): Promise<string[]> => {
  const drawn = await elementsOf(ui)
  const field = drawn.find(one => one.props?.['key'] === 'activity-field')
  if (field?.type !== 'Raster') return [String(field?.props?.['alt'] ?? '')]
  const columns = Number(field.props?.['columns'] ?? 0)
  const rows = Number(field.props?.['rows'] ?? 1)
  const cells = Uint8Array.from(atob(String(field.props?.['cells'] ?? '')), c => c.charCodeAt(0))
  const view = new DataView(cells.buffer)

  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, col) => String.fromCodePoint(view.getUint32((row * columns + col) * 12, true))).join(''),
  )
}

/** The Bash commands that reached the engine: what actually ran. */
export const commandsRun = (w: World): string[] =>
  w.ran.filter(call => call['tool'] === 'Bash').map(call => String(call['command']))

/** How many times a cue's file was handed to a player. */
export const plays = (w: World, cue: 'checkpoint' | 'complete'): string[][] =>
  w.runs.filter(argv => argv.some(arg => arg.endsWith(`assets/sounds/${cue}.wav`)))

/**
 * State the host already holds when the module loads: what a hot reload
 * finds. Answers `$.state` beneath the plugin from a map seeded with it.
 */
export const hostState = (on: On, seed: Record<string, unknown>): Map<string, { value: unknown; version: number }> => {
  const held = new Map(Object.entries(seed).map(([key, value]) => [key, { value, version: 1 }]))
  on('state.get', ($, e) => {
    const one = held.get(e.key)

    return { value: { value: one?.value, version: one?.version ?? 0 } } as never
  })
  on('state.set', ($, e) => {
    const write = e as unknown as { key: string; value: unknown; ifVersion?: number }
    const standing = held.get(write.key)?.version ?? 0
    if (write.ifVersion !== undefined && write.ifVersion !== standing) {
      return { value: { isSet: false, version: standing } } as never
    }
    held.set(write.key, { value: write.value, version: standing + 1 })

    return { value: { isSet: true, version: standing + 1 } } as never
  })

  return held
}

export const command = ($: Engine, args: string) =>
  $.command.run({ command: 'cockpit', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

export const FIVE = ['Inspect', 'Implement', 'Test', 'Fix', 'Verify'].map(title => ({ title }))
export const GATE_NAMES = ['CODE', 'TEST', 'TYPE', 'BUILD', 'SECURITY', 'GIT'] as const

/** Plans the usual five milestones and completes the first `done` of them. */
export const planAndComplete = async ($: Engine, done: number): Promise<string> => {
  let last = await progress($, { action: 'plan', milestones: FIVE })
  for (let n = 1; n <= done; n++) last = await progress($, { action: 'complete', milestone: `m${n}` })

  return last
}

/**
 * Passes every gate. Unless `align` is false it also records one acceptance criterion and its evidence, which is what STANDARD
 * and DEEP work needs before it can read DONE. Both are refused, and change nothing, while milestones before verification are open.
 */
export const passAllGates = async ($: Engine, options: { align?: boolean } = {}): Promise<void> => {
  for (const gate of GATE_NAMES) await progress($, { action: 'gate', gate, state: 'pass', evidence: `${gate} verified` })
  if (options.align === false) return
  await progress($, { action: 'discover', criteria: ['The fixture behaviour is accepted'] })
  await progress($, { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: "fixture test 'acceptance' passes in fixture.test.ts (1 pass)" }] } })
}
