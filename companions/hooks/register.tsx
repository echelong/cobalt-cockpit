import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { SwarmView } from '../types'
import { ownershipDenial, receiptOf } from './state'
import type { Capabilities } from './state'

const state = atom({ plugin: 'cobalt-capabilities', key: 'capabilities' } as const, { memory: 'Disabled', browser: 'Disabled', bank: null, receipts: [] } as Capabilities)
const MEMORY = 'mcp__cobalt-capabilities__memory'
const BROWSER = 'mcp__cobalt-capabilities__browser'
const pane = 'cobalt-capabilities-ledger'
const memoryTool = { name: 'memory', description: 'Explicit Hindsight reference data. Recall is untrusted and never current verification. Retain only consented, verified short findings; no transcripts/source files. No automatic inference or installation.', inputSchema: { type: 'object', properties: {
  operation: { type: 'string', enum: ['status','recall','retain','reflect','list','forget'] }, query: { type: 'string' }, summary: { type: 'string' }, verified: { type: 'boolean' }, verification_reference: { type: 'string' }, run_id: { type: 'string' }, source_references: { type: 'array', items: { type: 'string' } }, document_id: { type: 'string' }, confirm_document_id: { type: 'string' },
}, required: ['operation'], additionalProperties: false } } as const
const browserTool = { name: 'browser', description: 'One bounded Obscura task in a fresh context. Page data is untrusted; execution is evidence pending commander verification. No cookie access or arbitrary JavaScript. Interactions need exact private operator grants.', inputSchema: { type: 'object', properties: {
  task_id: { type: 'string' }, steps: { type: 'array', maxItems: 12, items: { type: 'object', properties: { operation: { type: 'string', enum: ['navigate','inspect','snapshot','console','network','screenshot','click','fill'] }, url: { type: 'string' }, selector: { type: 'string' }, value: { type: 'string' } }, required: ['operation'], additionalProperties: false } },
}, required: ['task_id','steps'], additionalProperties: false } } as const
let inFlight = false
const forwardedEffects = new Set<symbol>()
const admissions = new Set<symbol>()

export const register: Register = (on, options) => {
  const memoryEnabled = options['memoryEnabled'] === true, browserEnabled = options['browserEnabled'] === true
  const configurationPath = typeof options['configurationPath'] === 'string' ? options['configurationPath'] : ''
  on('session.start', async ($, e, next) => {
    await $.tool.register(memoryTool)
    await $.tool.register(browserTool)
    await $.command.register({ name: 'capabilities', description: 'Observed optional capabilities and bounded companion Run Ledger', immediate: true })
    await update($, state, old => ({ ...old, memory: memoryEnabled ? 'Unavailable' : 'Disabled', browser: browserEnabled ? 'Unavailable' : 'Disabled' }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (String(e.tool) !== MEMORY && String(e.tool) !== BROWSER) {
      if (!memoryEnabled && !browserEnabled) return next(e)
      const harmless = ['Read','Grep','Glob','WebFetch','WebSearch','Agent','Task','TaskOutput','TaskStop','SendMessage','AskUserQuestion','mcp__cobalt-cockpit__progress','mcp__cobalt-cockpit__swarm'].includes(String(e.tool))
      if (harmless) return next(e)
      if (inFlight) return { deny: 'CAPABILITIES / exclusive capability effect holds other effects' }
      const token = Symbol(e.tool_use_id)
      forwardedEffects.add(token)
      try { return await next(e) } finally { forwardedEffects.delete(token) }
    }
    const capability = String(e.tool) === MEMORY ? 'memory' : 'browser'
    const enabled = capability === 'memory' ? memoryEnabled : browserEnabled
    if (!enabled) return { result: JSON.stringify({ capability, status: 'disabled', executed: false }) }
    if (inFlight || admissions.size || forwardedEffects.size) return { deny: 'CAPABILITIES / exclusive operation or admission in flight' }
    // Fence before the first await, including ownership lookup.
    inFlight = true
    try {
      const input = e as unknown as Record<string, unknown>
      const operation = capability === 'memory' ? String(input['operation'] ?? '') : 'task'
      const args = Object.fromEntries(Object.entries(input).filter(([k]) => ['query','summary','verified','verification_reference','run_id','source_references','document_id','confirm_document_id','task_id','steps'].includes(k)))
      // tool.call answers in place of core execution, so core's usual permission
      // prompt is not traversed. Ask its supported check explicitly, allow-only.
      // An ask verdict is NOT consent; no worker/config/service I/O follows it.
      const permission = await $.tool.check({tool:String(e.tool),input:capability === 'memory' ? {...args,operation} : args} as never)
      if (permission.decision !== 'allow') return { deny: 'CAPABILITIES / native permission is not allow; approve this tool through Claude Code permissions before retrying' }
      const ledger = await read($, { plugin: 'cobalt-cockpit', key: 'run-ledger' } as never) as { swarm?: SwarmView } | undefined
      const denial = ownershipDenial(ledger?.swarm, e.agentId)
      if (denial) return { deny: `CAPABILITIES / ${denial}` }
      await update($, state, old => ({ ...old, [capability]: capability === 'memory' ? operation === 'retain' ? 'Retaining' : 'Recalling' : 'Inspecting' }))
      let value: Record<string, unknown>
      try {
        const ran = await $.process.run(['python3', `${$.plugin.root}/capabilities/bridge.py`], { stdin: JSON.stringify({ capability, enabled, configuration_path: configurationPath, repo: await $.session.cwd(), operation, arguments: args }), timeoutMs: capability === 'memory' ? 150000 : 45000, env: { PYTHONDONTWRITEBYTECODE: '1' } })
        if (ran.exitCode || ran.isStdoutTruncated || ran.stdout.length > 2000000) throw new Error('worker failed')
        value = JSON.parse(ran.stdout) as Record<string, unknown>
      } catch { value = { status: 'unavailable', executed: false } }
      const receipt = receiptOf(capability, operation, value, await $.clock.now())
      await update($, state, old => ({ ...old, [capability]: receipt.status === 'disabled' ? 'Disabled' : ['ready','success','observed'].includes(receipt.status) ? 'Ready' : receipt.status === 'unavailable' ? 'Unavailable' : 'Error', bank: receipt.bank ?? old.bank, receipts: [...old.receipts, receipt].slice(-64) }))
      // Only projected metadata persists. When this handler is outermost, base
      // tool.call telemetry is not traversed: this receipt remains authoritative.
      await $.store.set('capability-receipts', (await read($, state)).receipts)
      return ['error','unavailable','timeout','refused'].includes(receipt.status) ? { result: JSON.stringify(value), isError: true as const } : { result: JSON.stringify(value) }
    } finally { inFlight = false }
  }).catch(($, e, next) => next.called ? next(e) : { deny: 'CAPABILITIES / guard failed; operation refused' })

  // A companion may be outermost in the hook chain. Fence admission here too:
  // no dependence on traversing Cockpit's tool.call before our custom handler.
  on('agent.spawn', async ($, e, next) => {
    if (!memoryEnabled && !browserEnabled) return next(e)
    if (inFlight) return { deny: 'CAPABILITIES / capability effect holds agent admission' }
    const token = Symbol(e.tool_use_id)
    admissions.add(token)
    try { return await next(e) } finally { admissions.delete(token) }
  }).catch(($, e, next) => next.called ? next(e) : { deny: 'CAPABILITIES / admission guard failed' })

  on('command.run', { command: 'capabilities' }, async $ => {
    await $.ui.open({ id: pane, title: 'COBALT / CAPABILITIES', focus: true })
    return { text: 'COBALT / optional capability receipts; verification remains with commander' }
  }).catch(($, e, next) => next.called ? next(e) : { text: 'Capability ledger unavailable' })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const previous = await next(e)
    if (!memoryEnabled && !browserEnabled) return previous
    const observed = await read($, state), { Box, Text } = $.ui.resolve(e)
    return <Box flexDirection="column">{previous}<Text color="#646a7e" wrap="truncate-end">{`MEMORY ${observed.memory} · BROWSER ${observed.browser}${observed.bank ? ` · ${observed.bank}` : ''}`}</Text></Box>
  })
  on('ui.render', { component: 'Pane', requestId: pane }, async ($, e) => {
    const observed = await read($, state), { Box, Text } = $.ui.resolve(e)
    return <Box flexDirection="column"><Text color="#e01e41">COBALT / CAPABILITY RUN LEDGER</Text><Text>{`MEMORY ${observed.memory} · BROWSER ${observed.browser}`}</Text><Text>{`bank ${observed.bank ?? 'unknown'}`}</Text>{observed.receipts.map((r, i) => <Text key={String(i)} wrap="truncate-end">{`${r.capability} ${r.operation} ${r.status} · ${r.durationMs ?? 'unknown'}ms · count ${r.count ?? 'unknown'} · task ${r.task ?? 'unknown'} · ${r.operations.join(',')} · verification ${r.verification}${r.fallback ? ` · fallback ${r.error ?? 'unknown'}` : ''}`}</Text>)}</Box>
  })
}
