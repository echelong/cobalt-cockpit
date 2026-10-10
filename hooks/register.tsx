// Cobalt Cockpit: a coding HUD and workflow controller.
//
// The HUD above the prompt and the /cockpit pane draw one task model
// (model.ts): milestones Claude declares through the `progress` tool, and
// verification gates settled by real command results or by Claude's report.
// A turn ending changes none of it. Everything a drawing reads lives in
// `$.state`, so a hot reload of this module loses nothing; what is kept here
// in variables (timers, the mounted waveform) is rebuilt as events arrive.
// No bookkeeping in this file may fail a tool call: it runs under `quiet`.

import { emptySwarm, configureSwarm, submitTask, admitTask, bindAgent, finishTask, resolveEscalation, setWave, escalateTask, verifyTask, reportResult, acknowledgeHandback, requestCancel, releaseReservation, summarizeSwarm, markStalled, heartbeat, normalizeOwned, overlaps, ownershipAllows, setAppliedEffort, setLaunchEffort, SONNET_LED_SWARM } from './swarm'
import type { Swarm, SwarmTask, ModelTier, Wave, Verification } from './swarm'
import { textOf } from './ledger'
import { atom, read, update } from 'claude-code'
import { desiredRequest, policyMismatch, AGENT_MODEL, HAIKU_MODEL, MAIN_MODEL, OPUS_MODEL, isProfile, DEFAULT_PROFILE } from './model-policy'
import type { SubagentTier, Profile } from './model-policy'
import { addConsult, adviceOf, adviceRequest, advanceReview, briefOf, consultVerdict, factsOf, isGround, mandatoryGrounds, packetOf, promptGroundsOf, requireReview, GROUNDS } from './consult'
import type { Consultation, LocalAdvice } from './consult'
import {
  DEFAULT_CEILING,
  capabilityFor,
  chooseEffort,
  effortPolicyText,
  factsFromRole,
  hostEffort,
  isEffortLevel,
  isEffortRequest,
  launchFallback,
  observeCapability,
  settingsEffort,
} from './effort'
import type { EffortFacts, EffortResolution, HostEffortSignals } from './effort'
import { orchestrationGraph, orchestrationTape } from './field'
import type { EngineInterface, On, Register, RenderElement, Timer } from 'claude-code'
import { addAgent, adoptAgent, beginTool, checkpointOf, classicTelemetry, migrateLedger, emptyLedger, exportJSON, finishTool, finishTurn, ledgerLines, originOf, reading, recordRequest, receipts, storageLedger, jsonBytes, startRun, UNKNOWN, warn, word, withReplay, usageByTier } from './ledger'
import type { Ledger } from './ledger'
import { replayTimeline, safeFile, STEP_BYTES } from './replay'

import type { Activity, ActivityLog, AgentStrip, AuthState, Credential, EffortLevel, EffortRequest, GitState, GuardFinding, GuardRequest, Meter, Prefs, ReasoningMode, Task } from '../types'
import { ASSETS, PLAYERS, PLAY_TIMEOUT_MS, clampVolume } from './audio'
import type { Player } from './audio'
import { EMPTY_LOG, EVENT_TTL_MS, callOf, closeOf, liveOf, push } from './activity'
import { activityOf, readBash } from './classify'
import { parseStatus, projectOf } from './git'
import { assessCommand } from './guard'
import {
  addedAttribution,
  attributionInCommand,
  findAttribution,
  instructionFilesWritten,
  isInstructionFile,
  namesInstructionFile,
} from './hygiene'
import type { Attribution } from './hygiene'
import { applyAction, newTask, noteFailure, oneLine, setGate, settle, summaryOf, touchFile } from './model'
import type { Cue, ProgressInput } from './model'
import { basename, parseShell, unwrap } from './shell'
import { COLORS, fit, heading, hudRows, paneRows, visualStateOf } from './view'
import {
  FOLD_MS,
  STATE_COLOR,
  STATE_LABEL,
  TRACK_H,
  TRACK_W,
  cellsOf,
  fitText,
  layoutOf,
  positionAt,
  secondaryText,
  stripGrid,
  stripSvg,
  trackGrid,
  trackSvg,
  transition,
  visibleAgents,
  visualOf,
} from './progress-visual'
import type { Glide, Visual } from './progress-visual'
import { MICRO, OPERATOR, PANEL_H, PANEL_W, mascotAlt, mascotGrid, mascotSvg } from './mascot'
import { crawlerForm, crawlerGlyph, crawlerSvg, layerOf, positionOf, startupOf, stateOf, STARTUP_STEPS } from './crawler'
import type { CrawlerInput, Motion, NwhoLayer, Observations } from './crawler'
import { NO_NWHO } from './crawler'
import { advance, fieldGrid, fieldRows, fieldSvg, graphOf, RESTING, rowsOf as fieldRowsOf, tapeOf } from './field'
import type { Graph, Tape, Walker } from './field'
import {
  EMPTY_CONTROL,
  controlLabel,
  controlRows,
  cursorAt,
  drain,
  flashStrength,
  fold,
  liveFlash,
  seenAny,
  stripRows,
  stripText,
} from './nwho'
import type { Cursor, Flash, LocalControl, NwhoEvent } from './nwho'
import { paintCrawler } from './progress-visual'
import { API_REFUSAL, authLines, authOf, authRows, settingsSources } from './auth'
import {
  EMPTY_ORCHESTRA,
  admitSpawn,
  hasRole,
  headerText,
  limitOf,
  noteOutcome,
  orchestraRows,
  orchestrationText,
  reviewAdmitted,
  reviewHint,
  reviewVerdict,
  roleOf,
  roleStrip,
  tierOf,
} from './orchestra'
import type { OrchestraView } from './orchestra'
import { BLOCK_DENY, BLOCK_LINE, EMPTY_POLICY, FABLE_RULE, answered, blocked, fableConfigured, fableRoute, isFable } from './policy'
import type { HudInput, Row, Segment } from './view'

const PANE = 'cobalt-cockpit'
const TOOL = 'mcp__cobalt-cockpit__progress'
const MIN_VERSION = [2, 1, 287] as const
// The first engine seen to carry the Agent tool's own `effort` parameter. On an
// older one the level is set by the `turn.step` rewrite alone.
const NATIVE_EFFORT_VERSION = [2, 1, 292] as const
const FRAME_MS = 60
const GIT_DEBOUNCE_MS = 400
const GIT_TIMEOUT_MS = 6_000
const TRACK_KEY = 'progress-track'
/** The Activity Field's Raster, blitted from the same loop as the track. */
const FIELD_KEY = 'activity-field'
const GUARD_HEADER = 'Blast radius'
const PROCEED = 'Proceed'
const CANCEL = 'Cancel'

const IDLE: Activity = { kind: 'IDLE', detail: '', isWorking: false, toolUseId: null, agents: [], at: 0 }
const NO_METER: Meter = { percent: null, tokens: null, window: null, model: null, effort: null }
const DEFAULT_PREFS: Prefs = { isMuted: false, isHudHidden: false }

const taskAtom = atom({ plugin: 'cobalt-cockpit', key: 'task' } as const, null)
const activityAtom = atom({ plugin: 'cobalt-cockpit', key: 'activity' } as const, IDLE)
const gitAtom = atom({ plugin: 'cobalt-cockpit', key: 'git' } as const, null)
const meterAtom = atom({ plugin: 'cobalt-cockpit', key: 'meter' } as const, NO_METER)
const guardsAtom = atom({ plugin: 'cobalt-cockpit', key: 'guards' } as const, [])
const visualAtom = atom({ plugin: 'cobalt-cockpit', key: 'visual' } as const, { waiting: 0, agents: [] as AgentStrip[], revision: 0 })
const prefsAtom = atom({ plugin: 'cobalt-cockpit', key: 'prefs' } as const, DEFAULT_PREFS)
// Local Control: the optional NobodyWho telemetry observed this session, and
// the transient flash the HUD shows while a real receipt is fresh. Both live in
// `$.state`, so a hot reload keeps them and never replays old receipts, because
// the ledger cursor below is module state and deliberately starts at the end.
const controlAtom = atom({ plugin: 'cobalt-cockpit', key: 'control' } as const, EMPTY_CONTROL)
const cursorAtom = atom({ plugin: 'cobalt-cockpit', key: 'control-cursor' } as const, null as Cursor | null)
const flashAtom = atom({ plugin: 'cobalt-cockpit', key: 'flash' } as const, null as Flash | null)
const startupAtom = atom({ plugin: 'cobalt-cockpit', key: 'startup' } as const, [] as string[])
// The Activity Field's tape: the bounded window of real observations the field
// draws and the crawler walks. It lives in `$.state` so a hot reload keeps it,
// and every entry is one event `activity.ts` already reduced to safe fields.
const eventsAtom = atom({ plugin: 'cobalt-cockpit', key: 'events' } as const, EMPTY_LOG)
// The model policy's count, how the session is authenticated, and what
// delegation has come to. All three are facts a drawing reads, so they live in
// `$.state` and a hot reload neither loses a refusal nor forgets a reviewer.
const policyAtom = atom({ plugin: 'cobalt-cockpit', key: 'policy' } as const, EMPTY_POLICY)
const authAtom = atom({ plugin: 'cobalt-cockpit', key: 'auth' } as const, null as AuthState | null)
const orchestraAtom = atom({ plugin: 'cobalt-cockpit', key: 'orchestra' } as const, EMPTY_ORCHESTRA)
// The effort capability this session has really observed, by model id: folded
// in from the engine's own applied level, so a declared baseline is replaced
// only by a fact. It lives in `$.state`, so a hot reload keeps it.
const effortKnownAtom = atom({ plugin: 'cobalt-cockpit', key: 'effort-known' } as const, {} as Record<string, readonly EffortLevel[]>)

// Synchronous fence covers the whole awaited commander effect, including path resolution.
const commanderEffects = new Set<symbol>()
const SWARM_TOOL_NAME = 'mcp__cobalt-cockpit__swarm'
const poolBudget = (v: unknown): number | 'AUTO' => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(128,Math.floor(v)) : 'AUTO'
// Operator-declared effort capability, by model id: a level or a list of them.
// Anything else is ignored rather than guessed.
const parseModelEffort = (v: unknown): Record<string, readonly EffortLevel[]> => {
  if (v === null || typeof v !== 'object') return {}
  const out: Record<string, readonly EffortLevel[]> = {}
  for (const [model, levels] of Object.entries(v as Record<string, unknown>)) {
    const allowed = Array.isArray(levels) ? levels.filter(isEffortLevel) : isEffortLevel(levels) ? [levels] : []
    if (allowed.length > 0) out[model] = allowed
  }

  return out
}
const SWARM_TOOL = {
  name: 'swarm', description: 'Commander task ownership and elastic admission. SONNET_LED: action consult requests one Opus consultation (ground, objective, architecture, locations, alternatives, failures, risk, question) and returns the brief for cobalt-cockpit:architect. Assign before Agent; put [task:ID] in Agent description. Queue is commander dispatched: retry Agent after dependencies/resources clear. Result/escalate preserve locks until observed turn completion. No automatic model spawning. Read-only tools may run within declared scope; scoped writers cannot use Bash (declare exclusive * ownership for shell work).',
  inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['assign','status','wave','result','escalate','cancel','verify','resolve','adopt','consult'] },
    ground: { type: 'string', enum: [...GROUNDS], description: 'consult (SONNET_LED): why Opus is needed — architecture, security, repeated-failure, asked or release' },
    architecture: { type: 'string', description: 'consult: the current architecture, briefly' }, alternatives: { type: 'array', items: { type: 'string' }, description: 'consult: approaches considered or already tried' }, failures: { type: 'array', items: { type: 'string' }, description: 'consult: failing output, briefly' },
    task_id: { type: 'string' }, agent_id: { type: 'string', description: 'adopt: existing running host agent ID; commander binds an explicit assignment when old ownership was unavailable' }, tier: { type: 'string', enum: ['OPUS','SONNET','HAIKU'] }, role: { type: 'string' }, objective: { type: 'string' }, scope: { type: 'string' },
    dependencies: { type: 'array', items: { type: 'string' } }, owned_resources: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['read','write'] },
    parent_task: { type: 'string' }, spawn_reason: { type: 'string' }, wave: { type: 'string', enum: ['RECONNAISSANCE','ENGINEERING','REVIEW','INTEGRATION','VERIFICATION'] },
    conclusion: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } }, changes: { type: 'array', items: { type: 'string' } }, verification: { type: 'array', items: { type: 'string' } }, unresolved: { type: 'array', items: { type: 'string' } }, confidence: { type: 'string' },
    to: { type: 'string', enum: ['SONNET','OPUS'] }, discoveries: { type: 'array', items: { type: 'string' } }, question: { type: 'string' }, risk: { type: 'string' }, next_action: { type: 'string' }, locations: { type: 'array', items: { type: 'string' } }, state: { type: 'string', enum: ['pending','pass','fail','unknown'] },
    effort: { type: 'string', enum: ['AUTO','low','medium','high','xhigh','max'], description: 'assign/escalate: the reasoning level this task deserves, or AUTO to choose from the task' }, effort_reason: { type: 'string', description: 'assign/escalate: why that level was chosen' },
  }, required: ['action'] },
} as const
// Canonicalize both assignment and use. Unknown aliases conservatively lock all.
const canonicalResource = async ($: EngineInterface, path: string): Promise<string> => {
  if (!path || /[*?\[\]{}]/.test(path)) return '*'
  try {
    const r = await $.process.run(['realpath','-m','--', path.startsWith('/') ? path : `${cwd}/${path}`], { timeoutMs: 2000 })
    return r.exitCode === 0 && !r.isStdoutTruncated ? normalizeOwned(r.stdout.trim()) : '*'
  } catch { return '*' }
}
const swarmState = (l: Ledger): Swarm => l.swarm ?? emptySwarm()
const changeSwarm = async ($: EngineInterface, f: (s: Swarm) => Swarm): Promise<Swarm> => {
  const l = await update($, ledgerAtom, old => ({ ...old, schema: 2 as const, swarm: f(swarmState(old)) }))
  return l.swarm!
}
const finishObserved = (s: Swarm, id: string, reason: string, conclusion: string, at: number): Swarm => {
  const task = s.tasks.find(t=>t.id===id)
  if (!task) return s
  s = { ...s, tasks: s.tasks.map(t => t.id === id ? { ...t, resultDelivery: t.resultDelivery ?? (conclusion.trim() && conclusion !== 'unknown' && conclusion !== 'Host reports stopped; result unavailable' ? 'answer_observed' as const : 'unavailable' as const) } : t) }
  const result = task.result ?? { conclusion, unresolved:['Structured result unavailable; commander verification pending'] }
  const state = task.cancellationRequested || ['aborted','cancelled'].includes(reason) ? 'cancelled' : ['answer','completed'].includes(reason) ? 'completed' : 'failed'
  try { return finishTask(s,id,state,result,at) } catch {
    return finishTask(s,id,'failed',{ ...result, unresolved:[...('unresolved' in result ? result.unresolved : []),'Host stopped with unresolved dependencies/child work; completion rejected'] },at)
  }
}
/**
 * One Opus consultation requested by the main session (SONNET_LED). The ground
 * and packet are checked by `consultVerdict`; NobodyWho's advice, when a real
 * receipt comes back, is recorded beside it and never decides it. Admission
 * reserves nothing yet: the OPUS swarm task it submits is admitted again, with
 * ownership and budget, when the architect's Agent call arrives.
 */
const serveConsult = async ($: EngineInterface, e: Record<string, unknown>, at: number): Promise<string> => {
  const ground = e['ground']
  if (!isGround(ground)) throw new Error(`Valid ground required: ${GROUNDS.join(', ')}`)
  const made = packetOf(ground, { objective: e['objective'], architecture: e['architecture'], files: e['locations'], alternatives: e['alternatives'], failures: e['failures'], risk: e['risk'], decision: e['question'] })
  if ('error' in made) throw new Error(`Evidence packet incomplete: ${made.error}`)
  const task = await read($, taskAtom)
  const facts = factsOf(task, (await read($, orchestraAtom)).errorStreak, task?.promptGrounds ?? [])
  const ledger = await read($, ledgerAtom)
  const consults = ledger.consults ?? []
  const verdict = consultVerdict({ profile: config.hasOrchestration ? config.profile : 'OPUS_LED', ground, packet: made.packet, facts, consults, swarm: swarmState(ledger), progressTask: task?.id ?? null })
  if (!verdict.ok) {
    await quiet(() => mutateLedger($, l => warn(l, `${verdict.reason.split('.')[0]} (${ground})`)))
    throw new Error(verdict.reason)
  }
  let advice: LocalAdvice | null = null
  let adviceNote: string | null = null
  if (!config.hasLocalAdvice) adviceNote = 'local advice off'
  else {
    try {
      const r = await $.process.run(['decision', 'ask', '--caller', 'cockpit', '--json', adviceRequest(ground, made.packet, facts)], { timeoutMs: 20_000 })
      advice = r.exitCode === 0 ? adviceOf(r.stdout) : null
      if (advice === null) adviceNote = r.exitCode === 0 ? 'no receipt in router output' : `router exited ${r.exitCode}`
    } catch { adviceNote = 'router unavailable' }
  }
  const id = `opus-${consults.length + 1}-${verdict.key.slice(0, 6)}`
  const owned = await Promise.all(made.packet.files.map(p => canonicalResource($, p)))
  await changeSwarm($, held => submitTask(held, { id, tier: 'OPUS', role: ground === 'release' || ground === 'security' ? 'REVIEW' : 'ARCHITECT', objective: made.packet.decision, scope: `Opus consultation · ${ground}`, owned: owned.length ? owned : ['*'], mode: 'read', parentTask: null, spawnReason: `Opus admitted on ${ground}${verdict.isMandatory ? ' (mandatory)' : ''}` }, at).swarm)
  const c: Consultation = { id, ground, key: verdict.key, packet: made.packet, progressTask: task?.id ?? null, isMandatory: verdict.isMandatory, requestedAt: at, advice, adviceNote }
  await mutateLedger($, l => ({ ...l, consults: addConsult(l.consults ?? [], c) }))
  if (task !== null) await change($, t => t.id !== task.id ? t : { ...t, review: advanceReview(verdict.isMandatory ? requireReview(t, [ground]).review : t.review, id, 'admitted') })
  const local = advice === null ? `NobodyWho: no advice (${adviceNote}).` : `NobodyWho advised ${advice.abstain ? 'abstain' : advice.choice ?? 'nothing'} (receipt ${advice.requestId.slice(0, 12)}, tier ${advice.tier ?? '?'}); advisory only.`

  return `OPUS ADMITTED / ${id} · ${ground}${verdict.isMandatory ? ' · mandatory for this task' : ''}. ${local}\nSpawn Agent with subagent_type "cobalt-cockpit:architect", description "[task:${id}] Opus ${ground} consultation", and exactly this brief as the prompt:\n\n${briefOf(c)}\n\nIts answer is advice until you verify it. Then record swarm action "verify" for ${id}: pass when the advice checks out, fail when it does not, with evidence either way.`
}
const serveSwarm = async ($: EngineInterface, e: Record<string, unknown>): Promise<{ result: string; isError?: boolean }> => {
  try {
    const action = String(e['action'] ?? ''), id = String(e['task_id'] ?? ''), agent = typeof e['agentId'] === 'string' ? e['agentId'] : undefined
    const at = await $.clock.now()
    const str = (k: string) => textOf(e[k])
    const list = (k: string) => Array.isArray(e[k]) ? (e[k] as unknown[]).filter((v): v is string => typeof v === 'string').slice(0, 64).map(textOf) : []
    const s = await changeSwarm($, held => markStalled(held,at)); const task = s.tasks.find(t => t.id === id)
    if (agent && (!task || task.agentId !== agent || !['result','escalate','status'].includes(action))) throw new Error('Only commander assigns, verifies, cancels or changes waves; agents report their own task only')
    if (action === 'status') {
      const selected = id ? s.tasks.filter(t=>t.id===id) : [...s.tasks.filter(t=>!['completed','failed','cancelled'].includes(t.state)), ...s.tasks.filter(t=>['completed','failed','cancelled'].includes(t.state)).slice(-8)].slice(0,32)
      return { result: JSON.stringify({ ...summarizeSwarm(s), tasks: selected.map(t => ({ id:t.id, tier:t.tier, role:t.role, state:t.state, reason:t.reason, agent:t.agentId, effort:t.requestedEffort, launchEffort:t.launchEffort ?? null, appliedEffort:t.appliedEffort, effortReason:t.effortReason, result:t.result ? { conclusion:t.result.conclusion.slice(0,160), evidence:t.result.evidence.slice(0,3).map(x=>x.slice(0,160)), unresolved:t.result.unresolved.slice(0,3).map(x=>x.slice(0,160)) } : null, escalation:t.escalation ? { to:t.escalation.to, effort:t.escalation.effort ?? null, question:t.escalation.question.slice(0,160), risk:t.escalation.risk.slice(0,160) } : null, verification:t.verification, resultDelivery:t.resultDelivery ?? 'unavailable' })) }) }
    }
    if (action === 'assign') {
      if (typeof e['objective'] !== 'string' || !e['objective'].trim()) throw new Error('Bounded objective required')
      if (!/^[\w.-]{1,80}$/.test(id) || !['OPUS','SONNET','HAIKU'].includes(String(e['tier']))) throw new Error('Valid task_id and tier required')
      if (e['tier'] === 'OPUS' && isSonnetLed()) throw new Error('OPUS / in SONNET_LED an Opus task is admitted only through action consult, with a ground and an evidence packet')
      const owned = await Promise.all(list('owned_resources').map(p => canonicalResource($, p)))
      const assignedSwarm = await changeSwarm($, held => { const submitted = submitTask(held, { id, tier: e['tier'] as ModelTier, role: str('role'), objective: str('objective'), scope: str('scope'), dependencies:list('dependencies'), owned, mode: e['mode'] === 'write' ? 'write' : 'read', parentTask: typeof e['parent_task'] === 'string' ? e['parent_task'] : null, spawnReason: str('spawn_reason'), ...(isEffortRequest(e['effort']) ? { effort: e['effort'] } : {}), ...(typeof e['effort_reason'] === 'string' ? { effortReason: str('effort_reason') } : {}) }, at).swarm; if (jsonBytes(submitted.tasks.map(t=>({ ...t,result:null,escalation:null }))) > 192_000) throw new Error('Ownership metadata storage budget reached; finish/archive work before assigning more'); return submitted })
      const assigned = assignedSwarm.tasks.find(t => t.id === id)
      return { result: assigned ? `Task ${id} ${assigned.state}; use Agent description [task:${id}]. OPUS tasks stay in main.` : 'Duplicate suppressed; see swarm status for existing task.' }
    }
    if (action === 'consult') { const reply = await serveConsult($, e, at); await persist($); return { result: reply } }
    if (action === 'wave') { if (!['RECONNAISSANCE','ENGINEERING','REVIEW','INTEGRATION','VERIFICATION'].includes(String(e['wave']))) throw new Error('Valid wave required'); await changeSwarm($, held => setWave(held, e['wave'] as Wave, at)) }
    else {
      if (!task) throw new Error('Unknown task')
      if (action === 'adopt') {
        const existingId = String(e['agent_id'] ?? '')
        const listed = await $.agent.list()
        if (!listed.some(a=>a.id===existingId && a.status==='running')) throw new Error('Adoption requires an observed running host agent')
        await changeSwarm($, held => { const admitted = admitTask(held,id,at); if (!admitted.ok) throw new Error(admitted.reason!); return bindAgent(admitted.swarm,id,existingId,at,'adopt') })
      } else if (action === 'result') {
        await changeSwarm($, held => {
          let chain = held
          if (task.tier === 'OPUS' && (held.config.opus ?? 0) === 0 && ['queued','blocked'].includes(task.state)) { const admitted = admitTask(held,id,at); if (!admitted.ok) throw new Error(admitted.reason!); chain = admitted.swarm }
          chain = reportResult(chain, id, { conclusion:str('conclusion'), evidence:list('evidence'), changes:list('changes'), verification:list('verification'), unresolved:list('unresolved'), confidence: typeof e['confidence'] === 'string' ? str('confidence') : null }, at)
          return task.tier === 'OPUS' && (held.config.opus ?? 0) === 0 ? finishTask(chain,id,'completed',chain.tasks.find(t=>t.id===id)!.result,at) : chain
        })
      } else if (action === 'escalate') {
        if (!['SONNET','OPUS'].includes(String(e['to']))) throw new Error('Valid escalation destination required')
        await changeSwarm($, held => escalateTask(held,id,{ objective: task.objective, discoveries:list('discoveries'), evidence:list('evidence'), question:str('question'), risk:str('risk'), nextAction:str('next_action'), locations:list('locations'), to:e['to'] as ModelTier, effort: isEffortLevel(e['effort']) ? e['effort'] : null, effortReason: typeof e['effort_reason'] === 'string' ? str('effort_reason') : null },at))
      } else if (action === 'resolve') await changeSwarm($, held => resolveEscalation(held,id,{ conclusion:str('conclusion'),evidence:list('evidence'), changes:list('changes'), verification:list('verification'), unresolved:list('unresolved') },at))
      else if (action === 'cancel') await changeSwarm($, held => requestCancel(held,id,at))
      else if (action === 'verify') { if (!['pending','pass','fail','unknown'].includes(String(e['state']))) throw new Error('Valid verification state required'); await changeSwarm($, held => verifyTask(held,id,e['state'] as Verification,at,list('evidence').join('; ')))
        // The main session adjudicating a consultation's advice, pass or fail, is what a required review waits for.
        const consult = (await read($, ledgerAtom)).consults?.find(c => c.id === id)
        if (consult && (e['state'] === 'pass' || e['state'] === 'fail')) await change($, t => t.id === consult.progressTask && t.review ? { ...t, review: advanceReview(t.review, id, 'adjudicated') } : t)
      }
      else throw new Error('Unknown swarm action')
    }
    await persist($)
    return { result: `Swarm ${action} recorded; host completion and commander verification remain distinct.` }
  } catch (error) { return { result: `SWARM / ${error instanceof Error ? error.message : 'invalid input'}`, isError: true } }
}
// Bounded inspection shell compatibility. No substitutions, redirects, wrappers,
// output flags or arbitrary commands; scoped writes still require Edit/Write.
const readOnlyShell = (command: string): boolean => {
  if (/[<>`\n]/.test(command) || command.includes('$') || /--(?:output|ext-diff|textconv)|--no-index/.test(command)) return false
  try {
    const parsed = parseShell(command)
    if (!parsed.pipelines.length || parsed.substitutions.length) return false
    return parsed.pipelines.every(p => p.commands.every(c => {
      const r = unwrap(c.argv)
      return !!r && r.program === 'git' && ['diff','status','log','show','ls-files','rev-parse','grep'].includes(r.args[0] ?? '') && !r.args.some(a=>a === '-c' || a.startsWith('--output') || a === '--exec' || a === '--help' || a === '-h' || a.startsWith('--open') || a.startsWith('-O') || a.startsWith('--out') || a.startsWith('--ext') || a.startsWith('--text')) && r.wrappers.length === 0 && c.argv[0] === 'git'
    }))
  } catch { return false }
}
/**
 * Sets the reasoning level on an Agent call natively, on the tool's own
 * `effort` parameter: one subagent's level, for that call alone. It overrides
 * the agent definition's frontmatter, the engine clamps it under its own caps
 * and overrides, and the level the engine resolves is what it then reports.
 *
 * The level is the one the assignment names, else one the commander put on the
 * call by hand, else AUTO's choice (the fixed tier level in MANUAL), under the
 * operator ceiling and the model's known capability. A call it leaves alone
 * (MANUAL names no level for Haiku) runs at the engine's own.
 */
const launchEffort = async ($: EngineInterface, call: Record<string, unknown>): Promise<void> => {
  const useId = typeof call['tool_use_id'] === 'string' ? call['tool_use_id'] : ''
  const type = String(call['subagent_type'] ?? '')
  if (useId === '' || type === 'fork') return
  const id = /\[task:([\w.-]+)\]/.exec(String(call['description'] ?? ''))?.[1]
  const task = id === undefined ? undefined : swarmState(await read($, ledgerAtom)).tasks.find(t => t.id === id)
  // the tier and the work an unassigned call gets are the ones `agent.spawn` gives it
  const role = roleOf(type)
  const tier: SubagentTier = task?.tier === 'OPUS' && isSonnetLed() ? 'OPUS' : (task ? task.tier === 'HAIKU' : tierOf(String(call['model'] ?? '')) === 'HAIKU' || role === 'SCOUT' || role === 'UTILITY') ? 'HAIKU' : 'SONNET'
  const facts: EffortFacts = { tier, ...(task ? factsFromRole(task.role, task.mode) : factsFromRole(role, ['EXPLORER', 'RESEARCHER', 'REVIEWER', 'SCOUT', 'UTILITY'].includes(role) ? 'read' : 'write')) }
  const onCall = isEffortLevel(call['effort']) ? call['effort'] : null
  const assigned = task !== undefined && task.requestedEffort !== 'AUTO' ? task.requestedEffort : null
  const named = assigned ?? onCall
  const fixed = desiredRequest('agent', tier, config.profile).effort
  if (config.reasoningMode === 'MANUAL' && named === null && !isEffortLevel(fixed)) return
  const requested: EffortRequest = named ?? (config.reasoningMode === 'MANUAL' && isEffortLevel(fixed) ? fixed : 'AUTO')
  const resolution = chooseEffort(requested, facts, capabilityOf(MODEL_FOR[tier], await read($, effortKnownAtom)), config.maxEffort)
  if (resolution.applied === undefined) return
  call['effort'] = resolution.applied
  launches.set(useId, { level: resolution.applied, named: assigned === null ? onCall : null })
  for (const old of [...launches.keys()].slice(0, -LAUNCHES_MAX)) launches.delete(old)
}
/**
 * What can be seen of where the main loop's level comes from: the variable, a
 * `/effort` typed this session, and the level and cap the settings hold for
 * the model. Read once a turn; nothing is written. `--effort`, a level picked
 * in the model picker and the model's default are not visible to a plugin, and
 * nothing is claimed about them.
 */
const hostSignals = async ($: EngineInterface, turnId: string, model: string): Promise<HostEffortSignals> => {
  if (hostSignalsAt?.turnId === turnId) return hostSignalsAt.signals
  let env: string | undefined
  let held: { level: string | null; cap: string | null } = { level: null, cap: null }
  try { env = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL') } catch { /* no environment to read: nothing is claimed about it */ }
  try { held = settingsEffort(await $.settings.read(), model) } catch { /* no settings to read: nothing is claimed about them */ }
  const signals: HostEffortSignals = { env, command: effortCommand, settings: held.level, cap: held.cap }
  hostSignalsAt = { turnId, signals }

  return signals
}
/**
 * The task a subagent's request belongs to. A subagent's first request can
 * arrive before its spawn has bound it to its task; the task is then found by
 * the id its Agent call's description carries, so that request runs at the
 * task's level like every later one instead of at the tier's baseline.
 */
const taskOfAgent = async ($: EngineInterface, agentId: string): Promise<SwarmTask | undefined> => {
  const tasks = swarmState(await read($, ledgerAtom)).tasks
  const bound = tasks.find(t => t.agentId === agentId)
  if (bound !== undefined || !config.hasOrchestration) return bound
  const listed = (await $.agent.list().catch(() => [])).find(a => a.id === agentId)
  const id = /\[task:([\w.-]+)\]/.exec(listed?.description ?? '')?.[1]

  return id === undefined ? undefined : tasks.find(t => t.id === id && t.agentId === null && !['completed', 'failed', 'cancelled'].includes(t.state))
}
const guardSwarm = async ($: EngineInterface, e: Record<string, unknown>): Promise<string | null> => {
  if (!config.hasOrchestration) return null
  const agent = typeof e['agentId'] === 'string' ? e['agentId'] : undefined
  const s = swarmState(await read($, ledgerAtom)), task = s.tasks.find(t => t.agentId === agent && agent !== undefined)
  if (task?.cancellationRequested) return 'SWARM / cancellation requested; awaiting observed termination'
  const observedAt = await $.clock.now()
  if (task) await changeSwarm($, held => heartbeat(held,task.id,observedAt))
  const tool = String(e['tool'])
  if (tool === SWARM_TOOL_NAME || tool === TOOL) return null
  if (agent && !task) return 'SWARM / agent has no bound ownership; commander must assign before further tools'
  // Host control has no resource effects. Discovery grants no execution rights:
  // each discovered tool still passes its own ownership/native permission guard.
  // Handback returns only this bound helper's report to its native parent.
  if (tool === 'ToolSearch' || (agent && tool === 'SubagentHandback')) return null
  if (agent && (tool === 'Agent' || tool === 'Task')) return 'SWARM / only commander delegates; escalate instead'
  const write = ['Edit','Write','MultiEdit','NotebookEdit'].includes(tool)
  if (!agent && ['Agent','Task','TaskOutput','TaskStop','SendMessage'].includes(tool)) return null
  const readTool = ['Read','Grep','Glob','WebFetch','WebSearch'].includes(tool) || (tool === 'Bash' && readOnlyShell(String(e['command'] ?? '')))
  if (task && task.mode === 'read' && !readTool) return 'SWARM / read-only tasks may use inspection tools only; shell/custom effects require commander investigation'
  if (task && ['Read','Grep','Glob'].includes(tool)) {
    const path = String(e['file_path'] ?? e['path'] ?? '*')
    if (!ownershipAllows(s,task.id,await canonicalResource($,path),'read')) return 'SWARM / read outside owned resources'
  }
  if (task && tool === 'Bash' && !task.owned.includes('*')) return 'SWARM / shell inspection requires declared wildcard read scope'
  if (write) {
    const paths = tool === 'MultiEdit' && Array.isArray(e['edits']) ? (e['edits'] as Record<string,unknown>[]).map(x=>String(x['file_path'] ?? e['file_path'] ?? '')) : [String(e['file_path'] ?? e['notebook_path'] ?? '')]
    for (const path of paths) {
      const canonical = await canonicalResource($,path)
      if (task && !ownershipAllows(s,task.id,canonical)) return 'SWARM / write outside owned resources'
      if (!task && s.tasks.some(t=>t.tier !== 'OPUS' && t.endedAt === null && (['reserved','running'].includes(t.state) || (!['completed','failed','cancelled'].includes(t.state) && (t.agentId !== null || t.startedAt !== null))) && t.owned.some(p=>overlaps(p,canonical)))) return 'SWARM / commander write conflicts with active ownership'
    }
  } else if (!readTool) {
    if (task && !task.owned.includes('*')) return 'SWARM / shell/custom tools require exclusive wildcard ownership'
    if (!task && s.tasks.some(t=>t.tier !== 'OPUS' && t.endedAt === null && (['reserved','running'].includes(t.state) || (!['completed','failed','cancelled'].includes(t.state) && (t.agentId !== null || t.startedAt !== null))))) return 'SWARM / shell/custom effects held until active ownership releases'
  }
  return null
}

const PROGRESS_TOOL = {
  name: 'progress',
  description:
    'Reports real task progress to the Cobalt Cockpit HUD the user watches. ' +
    'action "plan": define the milestones of a substantial task before editing (3-7, in order, each with a phase; kind "coding" or "readonly"; replan true only to refine the current plan). ' +
    '"start" / "complete" / "fail" / "block" / "unblock": move one milestone (by id such as m2, or title); give "note" for fail and block. ' +
    '"gate": report a verification gate (CODE, TEST, TYPE, BUILD, SECURITY, GIT) as pass, fail, na or pending with one line of "evidence". ' +
    '"status": read the current state. ' +
    'Progress is completed milestones over all milestones; 100% needs every milestone complete and every required gate pass or na. Never complete a milestone that is not finished.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['plan', 'start', 'complete', 'fail', 'block', 'unblock', 'gate', 'status'] },
      goal: { type: 'string', description: 'plan: the task in one line' },
      kind: { type: 'string', enum: ['coding', 'readonly'], description: 'plan: readonly tasks need no verification gates' },
      milestones: {
        type: 'array',
        description: 'plan: the milestones in order',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            phase: { type: 'string', enum: ['RESEARCH', 'PLAN', 'IMPLEMENT', 'TEST', 'FIX', 'VERIFY'] },
          },
          required: ['title'],
        },
      },
      replan: { type: 'boolean', description: 'plan: keep the state of milestones whose titles are kept' },
      milestone: { type: 'string', description: 'start/complete/fail/block: the milestone id (m1, m2, ...) or title' },
      gate: { type: 'string', enum: ['CODE', 'TEST', 'TYPE', 'BUILD', 'SECURITY', 'GIT'] },
      state: { type: 'string', enum: ['pass', 'fail', 'na', 'pending'] },
      evidence: { type: 'string', description: 'gate: the command run and its outcome, or why the gate does not apply' },
      note: { type: 'string', description: 'why a milestone failed or is blocked, or a remark on its completion' },
    },
    required: ['action'],
  },
} as const

const DISCIPLINE = `# Cobalt Cockpit

The user watches a HUD fed by the ${TOOL} tool. It shows real milestone progress and verification gates, never a guess.

For a substantial coding task (more than a trivial edit):
1. Inspect before editing, then call ${TOOL} with action "plan": 3-7 milestones in order, each with a phase (typically Inspect, Implement, Test, Fix, Verify).
2. Call "start" as you begin a milestone and "complete" only when it is really finished. Use "fail" or "block" with a note when it is not. Never complete a milestone to move the bar.
3. After implementing, run the relevant tests and checks, fix what fails, and verify the final state of the repository.
4. Report each verification gate with action "gate" (CODE, TEST, TYPE, BUILD, SECURITY, GIT): pass or fail with the command and its outcome as evidence, or na with the reason it does not apply. Test, type-check, build, lint and audit commands run through Bash are recorded automatically from their exit status; when that status is masked (output piped to another command, a background run) report the result yourself.
5. The task reads 100% and DONE only when every milestone is complete and every required gate is pass or na. If something cannot be verified, leave it UNVERIFIED and tell the user exactly what was not verified. If you are stuck, use "block" and state the blocker plainly. The end of a turn is not the end of the task.

For questions, explanations and other read-only work, skip the tool (or plan with kind "readonly") and do not run tests the work does not call for.`

const HYGIENE = `

Repository hygiene for this user:
- Never add AI attribution to repository work: no Co-authored-by line naming Claude, Anthropic, ChatGPT, Codex or any AI assistant, and no "Generated by AI", "Built with Claude" or similar, in commit messages, pull requests, code or docs.
- Do not create CLAUDE.md or AGENTS.md unless the user explicitly asks for one in that repository.`

const SAFETY = `

Destructive commands (hard reset, clean, force push, broad recursive deletes, database drops, production teardown) are shown to the user for confirmation before they run. If the user cancels one, do not retry it or reach the same effect another way; ask how to proceed.`

const HELP =
  '/cockpit            open or close Mission Control\n' +
  '/cockpit status     print the task state\n' +
  '/cockpit reset      clear the current task\n' +
  '/cockpit mute       silence the cues (kept across sessions); unmute to undo\n' +
  '/cockpit hud off    hide the HUD (kept across sessions); hud on to undo\n' +
  '/cockpit auth       print how the session is authenticated and the Fable policy\n' +
  '/cockpit version    print the loaded plugin version, its source path and the reasoning mode\n' +
  '/cockpit sound      play both cues'

const isAtLeast = (version: string, floor: readonly number[]): boolean => {
  const parts = version.split(/[.-]/).map(Number)
  for (let at = 0; at < floor.length; at++) {
    const have = parts[at] ?? 0
    const want = floor[at] ?? 0
    if (Number.isNaN(have)) return true
    if (have !== want) return have > want
  }

  return true
}

const countPatch = (patch: unknown): { added: number; removed: number } => {
  let added = 0
  let removed = 0
  for (const hunk of Array.isArray(patch) ? patch : []) {
    const lines: unknown = (hunk as { lines?: unknown } | null)?.lines
    for (const line of Array.isArray(lines) ? lines : []) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }

  return { added, removed }
}

const isSameGit = (a: GitState | null, b: GitState): boolean =>
  a !== null &&
  a.isRepo === b.isRepo &&
  a.project === b.project &&
  a.branch === b.branch &&
  a.isDetached === b.isDetached &&
  a.sha === b.sha &&
  a.startSha === b.startSha &&
  a.dirty === b.dirty &&
  a.ahead === b.ahead &&
  a.behind === b.behind

const styleOf = (segment: Segment) => ({
  ...(segment.color !== undefined ? { color: segment.color } : {}),
  ...(segment.isDim === true ? { dimColor: true } : {}),
  ...(segment.isBold === true ? { bold: true } : {}),
})

type Config = {
  hasHud: boolean
  isAnimated: boolean
  hasSounds: boolean
  hasGuard: boolean
  hasAttributionGuard: boolean
  volume: number
  /** Whether the optional NobodyWho ledger is read at all. */
  hasLocalControl: boolean
  /** An explicit ledger path, or '' to resolve one from the environment. */
  ledgerPath: string
  /** Whether the subagent limit, the Sonnet default and the reviewer's grounds are enforced. */
  blocksFable: boolean
  isStrict: boolean
  hasOrchestration: boolean
  /** The most subagents that run at once. */
  maxSubagents: number
  maxSonnet: number | 'AUTO'
  maxHaiku: number | 'AUTO'
  /** Whether a session on API-style authentication is refused its model requests. */
  isSubscriptionOnly: boolean
  /** AUTO chooses reasoning effort from the task; MANUAL honours the fixed tier levels. */
  reasoningMode: ReasoningMode
  /** Nothing above this level is ever requested; a higher ask falls back and is recorded. */
  maxEffort: EffortLevel
  /** Operator-declared effort capability per model id, overriding the built-in table. */
  modelEffort: Readonly<Record<string, readonly EffortLevel[]>>
  /** OPUS_LED (legacy): Opus commands. SONNET_LED: Sonnet builds and Opus is consulted on admission. */
  profile: Profile
  /** Whether an Opus consultation asks NobodyWho (`decision ask`) for advisory input. */
  hasLocalAdvice: boolean
}

/** SONNET_LED is in force only where orchestration is enforced. */
const isSonnetLed = (): boolean => config.hasOrchestration && config.profile === 'SONNET_LED'

// The model each tier is requested on. The tier is the policy's; the model id is
// what the engine was asked for, and the capability table reads it.
const MODEL_FOR: Record<ModelTier, string> = { OPUS: MAIN_MODEL, SONNET: AGENT_MODEL, HAIKU: HAIKU_MODEL }

/**
 * The severity the effort policy may ask for, from the runtime observations the
 * session has really made, the operator's declared overrides, and the built-in
 * baseline. It is read-only over the facts and never assumes a level works.
 */
const capabilityOf = (model: string, known: Readonly<Record<string, readonly EffortLevel[]>>) =>
  capabilityFor(model, known, config.modelEffort)

// Set by register(); the rest is rebuilt as events arrive after a reload.
// Nothing a drawing depends on lives here: that is all in `$.state`.
let config: Config = { hasHud: true, isAnimated: true, hasSounds: true, hasGuard: true, hasAttributionGuard: true, volume: 0.6, hasLocalControl: true, ledgerPath: '', blocksFable: false, isStrict: false, hasOrchestration: false, maxSubagents: 16, maxSonnet: 'AUTO', maxHaiku: 'AUTO', isSubscriptionOnly: false, reasoningMode: 'AUTO', maxEffort: DEFAULT_CEILING, modelEffort: {}, profile: DEFAULT_PROFILE, hasLocalAdvice: true }
let isSupported = true
/** True once the engine is known to take `effort` on an Agent call. */
let hasNativeEffort = false
/**
 * What each Agent call in flight was launched with, by its tool-use id: the
 * level set on the call, and the level the commander put there by hand, if
 * any. `agent.spawn` takes the entry and binds it to the task; the map is
 * bounded so a call that never spawns leaves nothing behind for long.
 */
const launches = new Map<string, { level: EffortLevel; named: EffortLevel | null }>()
const LAUNCHES_MAX = 64
/**
 * Who put the effort on each loop's request in flight, by agent id (`main` for
 * the main loop): set before the request is sent, because a tool of that very
 * response can report back before the request is recorded in the ledger.
 */
const sentVia = new Map<string, 'host' | 'hook'>()
/** The level the last `/effort` command of this session named, as typed; null when none was seen. */
let effortCommand: string | null = null
/** What was last seen of the main loop's effort sources, and the turn it was read in. */
let hostSignalsAt: { turnId: string; signals: HostEffortSignals } | null = null
let ticker: Timer | null = null
let gitTimer: Timer | null = null
type MountedBand = { requestId: string; width: number; input: HudInput; visual: Visual; agents: AgentStrip[]; glide: Glide; motion: boolean; lastCells: Map<string, string>; waiting: boolean; field: { tape: Tape; state: string; rows: number; width: number; graph: Graph | null } | null }
let band: MountedBand | null = null
let head: { id: string; glide: Glide } | null = null
let isLight = false
let reducedMotion = false
let foldTimer: Timer | null = null
const agentSvgCache = new Map<string, { signature: string; source: string }>()
const svgCache = new Map<string, { signature: string; base: string; overlay: string }>()
let isTurnRunning = false
let cwd = ''
let home = ''

// The NobodyWho ledger watcher.
//
// Design constraints this satisfies, all of them load-bearing:
//   - read-only. Cockpit never writes, truncates or locks the ledger, and never
//     tells NobodyWho what to do; it only reads what the router already wrote.
//   - not aggressive. It polls on a slow timer and reads the file body only
//     when `$.fs.stat` says the size or mtime actually moved. A quiet ledger
//     costs one stat per tick and no read at all.
//   - self-limiting. It only ever looks for this session's own receipts, and it
//     gives up entirely once a read has failed twice in a row, so a broken or
//     hostile path cannot make the session do work forever.
//   - clean. `stopLedgerWatch` is idempotent and is called on session end and
//     before a reload re-primes, so no timer outlives the session.
//   - silent on failure. Every path returns without throwing; a ledger problem
//     must never touch the host.
let ledgerTimer: Timer | null = null
let ledgerCursor: Cursor | null = null
let ledgerPath: string | null = null
let ledgerMisses = 0

const LEDGER_POLL_MS = 1200
const LEDGER_MAX_BYTES = 512 * 1024
const LEDGER_GIVE_UP = 2

/** Where the router writes its receipts, or null when this machine has no home. */
const resolveLedger = async ($: EngineInterface): Promise<string | null> => {
  // An explicit setting wins, so a caller who keeps the ledger somewhere else
  // says so rather than the plugin guessing.
  if (config.ledgerPath !== '') return config.ledgerPath
  // `XDG_STATE_HOME` is authoritative when set, and `HOME` is the documented
  // fallback. Each is read behind its own guard, because a host that does not
  // expose `$.env` is a host where this integration simply stays off, which is
  // the correct outcome rather than a failure. The names are spelled out
  // literally because that is what lets the host list what the module reads.
  const state = await $.env.get('XDG_STATE_HOME').catch(() => undefined)
  if (state !== undefined && state !== '') return `${state}/decision-router/ledger.jsonl`
  const home = await $.env.get('HOME').catch(() => undefined)

  return home === undefined || home === '' ? null : `${home}/.local/state/decision-router/ledger.jsonl`
}

const stopLedgerWatch = () => {
  ledgerTimer?.cancel()
  ledgerTimer = null
}

/**
 * Reads the ledger once and folds in whatever is genuinely new.
 *
 * The first read primes the cursor at the end of the file and emits nothing,
 * which is what stops a session from flashing a year of history on startup and
 * what makes a hot reload resume instead of replay.
 */
const utf8Bytes = (text: string): number => [...text].reduce((n, ch) => { const cp = ch.codePointAt(0)!; return n + (cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4) }, 0)
const sliceBytes = (text: string, offset: number): string => { let at = 0, index = 0; for (const ch of text) { if (at >= offset) break; at += utf8Bytes(ch); index += ch.length } return text.slice(index) }

const pollLedger = async ($: EngineInterface): Promise<void> => {
  const path = ledgerPath
  if (path === null) return
  let size = -1
  try {
    const stat = await $.fs.stat(path)
    size = stat.size
  } catch {
    // No ledger, or no permission: this is normal, not an error.
    if (++ledgerMisses >= LEDGER_GIVE_UP) stopLedgerWatch()

    return
  }
  const cursor = ledgerCursor ?? await read($, cursorAtom) ?? cursorAt(size)
  if (cursor.primed && size === cursor.size) return
  // A file that shrank was rotated or replaced: resume at its end rather than
  // slicing a stale offset into different content.
  const rotated = size < cursor.size
  const from = rotated ? cursorAt(size) : cursor
  let text = ''
  try {
    // Only the tail is read, and only a bounded slice of it, so a large ledger
    // is never copied into the session in full.
    if (size > LEDGER_MAX_BYTES) {
      const tail = await $.process.run(['tail', '-c', String(LEDGER_MAX_BYTES), '--', path], { timeoutMs: 2000 })
      if (tail.exitCode !== 0 || tail.isStdoutTruncated) throw new Error('ledger tail unavailable')
      // Locate the old cursor by bytes within the bounded UTF-8 tail.
      const bytes = utf8Bytes(tail.stdout)
      const start = size - bytes
      const offset = Math.max(0, from.offset - start)
      text = sliceBytes(tail.stdout, offset)
      if (from.offset < start) text = text.slice(text.indexOf('\n') + 1)
    } else {
      const whole = await $.fs.read(path)
      text = sliceBytes(whole, from.offset)
    }
  } catch {
    if (++ledgerMisses >= LEDGER_GIVE_UP) stopLedgerWatch()

    return
  }
  ledgerMisses = 0
  // `drain` works on the tail it is handed, so its cursor offset is relative to
  // that tail; the absolute position stays here in `ledgerCursor`.
  const tail = { ...from, offset: 0 }
  const drained = drain(text, tail, 'claude')
  const remainingBytes = utf8Bytes(text.slice(drained.cursor.offset))
  ledgerCursor = { ...drained.cursor, offset: size - remainingBytes, size }
  await update($, cursorAtom, () => ledgerCursor)
  if (drained.events.length === 0) return
  await mutateLedger($, l => receipts(l, drained.events))
  // Only now, with real events in hand, does the session's telemetry change.
  const seen = await $.clock.now()
  await update($, controlAtom, old => fold(old, drained.events, seen))
  const newest = drained.events[drained.events.length - 1]
  if (newest === undefined) return
  await update($, flashAtom, () => ({ text: stripText(newest), op: newest.op, at: seen }))
}

/** Starts the watcher once, after the ledger's location is known. */
const startLedgerWatch = async ($: EngineInterface): Promise<void> => {
  if (ledgerTimer !== null || !config.hasLocalControl) return
  ledgerPath = await resolveLedger($)
  // No resolvable ledger means this machine does not run the router, so there is
  // nothing to watch and no timer is ever created.
  if (ledgerPath === null) return
  await quiet(async () => pollLedger($))
  ledgerTimer = $.clock.every(LEDGER_POLL_MS, () => quiet(async () => pollLedger($)))
}
let lastEffort: string | null = null
/** The player that worked; null once none did, so a silent machine is asked once. */
let player: Player | null | undefined
/**
 * Where the field's crawler currently stands. Module state, like the ticker: it
 * is animation rather than fact, so it is rebuilt from the real tape on every
 * draw and a hot reload simply restarts the walk where the tape now says.
 */
let fieldWalker: Walker = RESTING

/** Runs bookkeeping that must never fail the event it rides on. */
const quiet = async (work: () => unknown): Promise<void> => {
  try {
    await work()
  } catch {
    // the HUD goes stale rather than the session breaking
  }
}

/**
 * A reading whose failure must not fail the event it rides on, for the one case
 * `quiet` cannot serve: a hook that fails *before* `next` is skipped by the
 * engine, so a hook that decides must reach its decision even when a reading
 * beneath it does not answer.
 */
const quietly = async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await work()
  } catch {
    return undefined
  }
}

const stopTicker = () => {
  ticker?.cancel()
  ticker = null
}

/** Whether anything on the band is genuinely animating right now. */
const bandBusy = (mounted: MountedBand): boolean =>
  mounted.visual.active || mounted.agents.some(a => a.state === 'running') || mounted.field !== null

const startTicker = ($: EngineInterface) => {
  if (!config.isAnimated || reducedMotion || ticker !== null || band === null || !band.motion) return
  if (!bandBusy(band)) return
  ticker = $.clock.every(FRAME_MS, async () => {
    const mounted = band
    if (!mounted || !mounted.motion || !bandBusy(mounted)) {
      stopTicker()
      return
    }
    const now = await $.clock.now()
    const blit = async (key: string, cells: string, rows = 1, columns = mounted.width) => {
      if (mounted.lastCells.get(key) === cells) return
      mounted.lastCells.set(key, cells)
      const result = await $.ui.blit({ requestId: mounted.requestId, key, cells, columns, rows }).catch(() => ({ deny: 'unmounted' }))
      if (result.deny && band === mounted) { band = null; stopTicker() }
    }
    if (mounted.visual.active) {
      // The track is redrawn whole each frame because the crawler rides it: the
      // per-key cell diff still suppresses the blit whenever the result is
      // byte-identical, so a still crawler costs nothing.
      const grid = trackGrid(mounted.input, mounted.visual, mounted.width, { head: positionAt(mounted.glide, now), now, motion: true, light: isLight })
      const input = await crawlerOf($, mounted.input, mounted.visual, mounted.waiting)
      if (crawlerForm(mounted.width) === 'body') paintCrawler(grid, { ...input.crawler, progress: positionAt(mounted.glide, now) }, { now, reducedMotion: false }, layerFor(input.crawler, input.newest))
      await blit(TRACK_KEY, grid.encode())
    }
    // No full-tree redraws for clocks: only the strips whose cells changed.
    for (const a of mounted.agents) if (a.state === 'running') await blit(`agent-${a.id}`, stripGrid(a, mounted.width, now, isLight, true).encode())
    // The Activity Field: the crawler takes one step per frame and the whole
    // field is repainted, because the creature moves through the tape rather
    // than sitting on it. The per-key diff still suppresses the blit whenever a
    // frame is byte-identical, so a settled crawler costs nothing at all.
    if (mounted.field !== null && mounted.field.tape.anchors.length > 0) {
      fieldWalker = advance(fieldWalker, mounted.field.tape, mounted.field.state, { now, reducedMotion: false })
      await blit(FIELD_KEY, fieldGrid(mounted.field.tape, fieldWalker, mounted.field.state, mounted.field.width, mounted.field.rows).encode(), mounted.field.rows, mounted.field.width)
    }
  })
}

const editAgent = async ($: EngineInterface, id: string, edit: (a: AgentStrip) => AgentStrip) => {
  await update($, visualAtom, old => ({ ...old, agents: old.agents.map(a => a.id === id ? edit(a) : a) }))
}
const scheduleFold = async ($: EngineInterface) => {
  foldTimer?.cancel()
  foldTimer = null
  const now = await $.clock.now()
  const agents = (await read($, visualAtom)).agents
  const due = agents.filter(a => a.state === 'done' && a.endedAt !== null && a.endedAt + FOLD_MS > now).map(a => a.endedAt! + FOLD_MS)
  if (!due.length) return
  foldTimer = $.clock.after(Math.min(...due) - now, async () => {
    foldTimer = null
    await update($, visualAtom, old => ({ ...old, revision: old.revision + 1 }))
    await scheduleFold($)
  })
}

// Spawns in flight: `agent.spawn` hooks that have not returned yet, each with
// the id of the agent it started once the engine has answered. Several Agent
// calls of one message reach the hook together, so each counts the ones ahead of
// it that the engine's own list does not show yet, and none is counted twice.
const spawning = new Map<symbol, string | null>()
/** The settings name Fable as the advisor: read with the auth probe, and enough to refuse every request. */
let isAdvisorFable = false
let hasAdvisor = false
const AUTH_TOAST_MS = 8000

/** Counts one refusal and leaves its one line. Nothing about the request is kept. */
const recordBlock = async ($: EngineInterface): Promise<void> => {
  await quiet(async () => {
    const now = await $.clock.now()
    await update($, policyAtom, old => blocked(old, now))
  })
  await quiet(() => $.ui.log(BLOCK_LINE))
}

/**
 * Reads how the session is authenticated, without ever holding a secret
 * longer than it takes to see that one is there.
 *
 * The engine answers the kind of its own credential; each API-style variable
 * is asked for by its literal name and reduced to present or absent on the
 * spot; the settings are read for a key helper, the same variables and an
 * advisor. Only names from `auth.ts`'s fixed table reach the state.
 */
const probeAuth = async ($: EngineInterface, announce: boolean): Promise<void> => {
  const present: string[] = []
  const isSet = (value: string | undefined): boolean => value !== undefined && value !== ''
  if (isSet(await $.env.get('ANTHROPIC_API_KEY').catch(() => undefined))) present.push('env ANTHROPIC_API_KEY')
  if (isSet(await $.env.get('ANTHROPIC_AUTH_TOKEN').catch(() => undefined))) present.push('env ANTHROPIC_AUTH_TOKEN')
  if (isSet(await $.env.get('ANTHROPIC_BASE_URL').catch(() => undefined))) present.push('env ANTHROPIC_BASE_URL')
  if (isSet(await $.env.get('ANTHROPIC_CUSTOM_HEADERS').catch(() => undefined))) present.push('env ANTHROPIC_CUSTOM_HEADERS')
  if (isSet(await $.env.get('CLAUDE_CODE_USE_BEDROCK').catch(() => undefined))) present.push('env CLAUDE_CODE_USE_BEDROCK')
  if (isSet(await $.env.get('CLAUDE_CODE_USE_VERTEX').catch(() => undefined))) present.push('env CLAUDE_CODE_USE_VERTEX')
  if (isSet(await $.env.get('CLAUDE_CODE_USE_FOUNDRY').catch(() => undefined))) present.push('env CLAUDE_CODE_USE_FOUNDRY')
  if (isSet(await $.env.get('CLAUDE_CODE_USE_MANTLE').catch(() => undefined))) present.push('env CLAUDE_CODE_USE_MANTLE')
  let credential: Credential = 'unknown'
  try {
    const held = await $.session.authorize()
    // the handle is dropped here: only the kind is of interest
    credential = held === null ? 'none' : held.kind
  } catch {
    // an engine that does not answer leaves the reading UNVERIFIED
  }
  try {
    const settings = await $.settings.read()
    present.push(...settingsSources(settings))
    isAdvisorFable = fableConfigured(settings)
    hasAdvisor = typeof settings['advisorModel'] === 'string' && settings['advisorModel'] !== ''
  } catch {
    // no settings to read: nothing is claimed about them
  }
  const fresh = authOf(credential, present, await $.clock.now())
  const old = await read($, authAtom)
  const isSame = old !== null && old.mode === fresh.mode && old.credential === fresh.credential && old.sources.join() === fresh.sources.join()
  if (isSame) return
  await update($, authAtom, () => fresh)
  if (!announce) return
  // The startup diagnostic: a few seconds over the transcript, then gone, so
  // nothing about Fable holds a row of the HUD.
  await quiet(() => $.ui.toast(authLines(fresh, config.blocksFable).join(' · '), { timeoutMs: AUTH_TOAST_MS }))
  if (fresh.mode === 'api') {
    await quiet(() =>
      $.ui.log(
        `AUTH / API DETECTED (${[...(fresh.credential === 'api-key' ? ['engine holds an API key'] : []), ...fresh.sources].join(', ')}). ${
          config.isSubscriptionOnly ? 'Cockpit sends no model request on API-style authentication.' : 'The subscriptionOnly option is off, so requests are allowed.'
        }`,
      ),
    )
  }
}

/** Whether the session's requests are refused because it is not on the subscription. */
const isApiRefused = async ($: EngineInterface): Promise<boolean> => {
  if (!config.isSubscriptionOnly) return false

  return (await read($, authAtom).catch(() => null))?.mode === 'api'
}

/**
 * The ids of the subagents running now: the engine's own list where it
 * answers, and the strips this plugin drew from real spawns where it does not.
 */
const runningAgents = async ($: EngineInterface): Promise<Set<string>> => {
  try {
    return new Set((await $.agent.list()).filter(one => one.status === 'running' && one.type !== 'teammate').map(one => one.id))
  } catch {
    return new Set((await read($, visualAtom)).agents.filter(a => a.endedAt === null).map(a => a.id))
  }
}

/** What the failure streak is keyed on: the gates a check settles, or the tool and program that ran. */
const outcomeKey = (tool: string, input: Record<string, unknown>, gates: readonly string[]): string => {
  if (gates.length > 0) return gates.join('+')
  if (tool !== 'Bash') {
    // the same tool on the same file: a second missing file is a different failure
    const target = basename(String(input['file_path'] ?? input['notebook_path'] ?? '')).replace(/[^\w.-]/g, '').slice(0, 40)

    return target === '' ? tool : `${tool} ${target}`
  }
  const program = basename(String(input['command'] ?? '').trim().split(/\s+/)[0] ?? '').replace(/[^\w.-]/g, '').slice(0, 24)

  return program === '' ? 'Bash' : `Bash ${program}`
}

/**
 * The one-time note for a failure that has repeated, or null.
 *
 * This is the whole of the "repeated error" path: a counter, the local
 * router's latest decision if a real receipt arrived since the streak began,
 * and one sentence. No model is called to decide it.
 */
const repeatedErrorHint = async ($: EngineInterface): Promise<string | null> => {
  if (!config.hasOrchestration) return null
  const o = await read($, orchestraAtom)
  const decision = (await read($, controlAtom)).lastDecision
  const route = decision !== null && o.streakAt !== null && decision.at >= o.streakAt ? decision.route : null
  const hint = reviewHint(o, route)
  if (hint !== null) await update($, orchestraAtom, old => ({ ...old, hinted: true }))

  return hint
}

/** Refuses `/model fable` and `/advisor fable` before the engine changes anything. */
const guardModelCommand = async ($: EngineInterface, args: string): Promise<{ text: string } | null> => {
  if (!config.blocksFable) return null
  if (!args.split(/[\s=,]+/).some(isFable)) return null
  await recordBlock($)

  return { text: `${BLOCK_LINE}. Nothing was changed.` }
}

const attempt = async ($: EngineInterface, candidate: Player, file: string): Promise<boolean> => {
  try {
    const ran = await $.process.run(candidate.argv(file, config.volume), { timeoutMs: PLAY_TIMEOUT_MS })

    return ran.exitCode === 0
  } catch {
    // not installed, or still running at the timeout: the next one is tried
    return false
  }
}

/**
 * Plays a cue with the first player this machine answers to, PipeWire's
 * first, the terminal bell last; resolves with its name, or null for silence.
 * It never throws and never writes to the transcript.
 */
const sound = async ($: EngineInterface, cue: Cue): Promise<string | null> => {
  try {
    if (!config.hasSounds || (await read($, prefsAtom)).isMuted) return null
    const file = `${$.plugin.root}/${ASSETS[cue]}`
    if (player === null) return null
    if (player !== undefined) return (await attempt($, player, file)) ? player.name : null
    for (const candidate of PLAYERS) {
      if (await attempt($, candidate, file)) {
        player = candidate
        $.ui.log(`cues play through ${candidate.name}`, { to: 'debug' })

        return candidate.name
      }
    }
    player = null
    $.ui.log('no audio player answered; cues are silent', { to: 'debug' })

    return null
  } catch {
    return null
  }
}

/** Applies a change to the task, settles what follows from it, and plays what it earned. */
const change = async ($: EngineInterface, apply: (task: Task, now: number) => Task): Promise<Task | null> => {
  const now = await $.clock.now()
  let cues: Cue[] = []
  const task = await update($, taskAtom, old => {
    cues = []
    if (old === null) return old
    const settled = settle(apply(old, now))
    cues = settled.cues

    return settled.task
  })
  for (const cue of cues) void sound($, cue)

  return task
}

const refreshGit = async ($: EngineInterface): Promise<void> => {
  try {
    const now = await $.clock.now()
    cwd = await $.session.cwd()
    const status = await $.process.run(['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'], {
      timeoutMs: GIT_TIMEOUT_MS,
    })
    const old = await read($, gitAtom)
    let state: GitState
    if (status.exitCode !== 0) {
      state = {
        isRepo: false,
        project: projectOf(cwd),
        branch: null,
        isDetached: false,
        sha: null,
        startSha: null,
        dirty: 0,
        ahead: null,
        behind: null,
        at: now,
      }
    } else {
      const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: GIT_TIMEOUT_MS })
      const project = projectOf(top.exitCode === 0 && top.stdout.trim() !== '' ? top.stdout.trim() : cwd)
      const parsed = parseStatus(status.stdout)
      const isSameRepo = old !== null && old.isRepo && old.project === project
      state = {
        isRepo: true,
        project,
        ...parsed,
        startSha: isSameRepo ? (old.startSha ?? parsed.sha) : parsed.sha,
        at: now,
      }
    }
    if (!isSameGit(old, state)) await update($, gitAtom, () => state)
  } catch {
    // git missing or slow: the HUD keeps what it had
  }
}

const scheduleGit = ($: EngineInterface) => {
  if (gitTimer !== null) return
  gitTimer = $.clock.after(GIT_DEBOUNCE_MS, () => {
    gitTimer = null
    void refreshGit($)
  })
}

const setMeter = async ($: EngineInterface, patch: Partial<Meter>): Promise<void> => {
  const old = await read($, meterAtom)
  const merged = { ...old, ...patch }
  const isSame = (Object.keys(merged) as (keyof Meter)[]).every(key => merged[key] === old[key])
  if (!isSame) await update($, meterAtom, current => ({ ...current, ...patch }))
}

const refreshMeter = async ($: EngineInterface): Promise<void> => {
  try {
    const usage = await $.session.usage()
    const selectedModel = await $.session.model()
    const ledger = await read($, ledgerAtom)
    const actualModel = ledger.runs.find(r => r.id === ledger.currentRun)?.model
    const model = actualModel && actualModel !== UNKNOWN ? actualModel : selectedModel
    await setMeter($, {
      percent: usage.context.percent ?? null,
      tokens: usage.context.tokens ?? null,
      window: usage.context.window,
      model,
    })
  } catch {
    // no reading yet
  }
}

const ask = async ($: EngineInterface, question: string, header: string, choices: readonly [string, string]): Promise<string | null> => {
  try {
    await update($, visualAtom, old => ({ ...old, waiting: old.waiting + 1 }))
    stopTicker()
    try {
      return await $.ui.ask(question, { options: choices, header })
    } finally {
      await update($, visualAtom, old => ({ ...old, waiting: Math.max(0, old.waiting - 1) }))
    }
  } catch {
    // dismissed, or nobody to ask (a headless run): the cautious answer
    return null
  }
}

const quote = (text: string): string => JSON.stringify(oneLine(text, 90))

const confirmDestructive = async (
  $: EngineInterface,
  command: string,
  findings: GuardFinding[],
  isSubagent: boolean,
): Promise<boolean> => {
  // the panel drawn above the dialog carries the detail; the question stands alone without it
  const titles = findings.map(one => one.title).join(', ')
  const question = `Destructive: ${oneLine(titles, 80)}. Run ${quote(command)}?`
  const request: GuardRequest = { question, command, findings, isSubagent, at: await $.clock.now() }
  await quiet(() => update($, guardsAtom, list => [...list, request].slice(-4)))
  // Cancel is listed first, so a reflexive Enter does not run it
  const answer = await ask($, question, GUARD_HEADER, [CANCEL, PROCEED])
  await quiet(() => update($, guardsAtom, list => list.filter(one => one.question !== question)))

  return answer === PROCEED
}

const attributionDeny = (found: Attribution, where: string): { deny: string } => ({
  deny: `Cobalt Cockpit: ${where} would add AI attribution (${quote(found.line)}). This user's repositories carry none. Do it again without that text.`,
})

const allowInstructionFile = async ($: EngineInterface, path: string): Promise<{ deny: string } | null> => {
  const absolute = path.startsWith('/') ? path : `${cwd}/${path}`
  const hasFile = await $.fs.exists(absolute).catch(() => true)
  const task = await read($, taskAtom)
  if (hasFile || task?.hasInstructionFileRequest === true) return null
  const name = basename(path)
  const answer = await ask(
    $,
    `Claude is about to create ${name} at ${oneLine(absolute, 80)}, which you did not ask for. Create it?`,
    'New file',
    ['Block', 'Create'],
  )
  if (answer === 'Create') return null

  return {
    deny: `Cobalt Cockpit: ${name} is only created when the user asks for one in this repository, and the user has not. It was not written. Do not create it another way; say so if you think one would help.`,
  }
}

/** The guards: a `{ deny }` when the call must not run, else null. */
const guard = async ($: EngineInterface, e: { tool: string; agentId?: string } & Record<string, unknown>): Promise<{ deny: string } | null> => {
  if (e.tool === 'Bash') {
    const command = typeof e['command'] === 'string' ? e['command'] : ''
    if (config.hasAttributionGuard) {
      const found = attributionInCommand(command)[0]
      if (found !== undefined) return attributionDeny(found, 'this command')
      for (const path of instructionFilesWritten(command)) {
        const refusal = await allowInstructionFile($, path)
        if (refusal !== null) return refusal
      }
    }
    if (config.hasGuard) {
      const findings = assessCommand(command, { cwd, home })
      if (findings.length > 0 && !(await confirmDestructive($, command, findings, e.agentId !== undefined))) {
        return {
          deny: `Cobalt Cockpit: the user did not approve this destructive command (${findings
            .map(one => one.title)
            .join(', ')}). It did not run. Do not retry it or reach the same effect another way; ask the user how to proceed.`,
        }
      }
    }

    return null
  }

  if (!config.hasAttributionGuard || (e.tool !== 'Edit' && e.tool !== 'Write' && e.tool !== 'NotebookEdit')) return null
  const path = String(e['file_path'] ?? e['notebook_path'] ?? '')
  // this plugin's own sources and tests spell the patterns out
  if (path === '' || path.startsWith(`${$.plugin.root}/`)) return null
  const after = String(e['new_string'] ?? e['content'] ?? e['new_source'] ?? '')
  let added: Attribution[] = []
  if (e.tool === 'Edit') {
    added = addedAttribution(String(e['old_string'] ?? ''), after)
  } else if (findAttribution(after).length > 0) {
    const before = e.tool === 'Write' ? await $.fs.read(path).catch(() => '') : ''
    added = addedAttribution(before, after)
  }
  const trailer = added.find(one => one.kind === 'trailer')
  if (trailer !== undefined) return attributionDeny(trailer, `this edit to ${basename(path)}`)
  const phrase = added[0]
  if (phrase !== undefined) {
    const answer = await ask(
      $,
      `This edit adds a line to ${basename(path)} that reads as AI attribution: ${quote(phrase.line)}. Keep it out of the repository?`,
      'Attribution',
      ['Block', 'Allow once'],
    )
    if (answer !== 'Allow once') return attributionDeny(phrase, `this edit to ${basename(path)}`)
  }
  if (e.tool === 'Write' && isInstructionFile(path)) return allowInstructionFile($, path)

  return null
}

const serveProgress = async ($: EngineInterface, e: ProgressInput & { agentId?: string }): Promise<{ result: string }> => {
  if (e.agentId !== undefined) {
    return {
      result: 'Cobalt Cockpit: the task state belongs to the main conversation. Report your result to it instead; nothing was changed.',
    }
  }
  const now = await $.clock.now()
  const sha = (await read($, gitAtom))?.sha ?? null
  let reply = ''
  let cues: Cue[] = []
  await update($, taskAtom, old => {
    cues = []
    const outcome = applyAction(old ?? newTask(1, '', now, sha), e, now, sha)
    if (outcome.error !== undefined) {
      reply = `error: ${outcome.error}`

      return old
    }
    const settled = settle(outcome.task)
    cues = settled.cues
    reply = [outcome.note, summaryOf(settled.task)].filter(Boolean).join(' ')

    return settled.task
  })
  for (const cue of cues) void sound($, cue)

  return { result: reply }
}

const relative = (path: string): string => (cwd !== '' && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)

/** A tool call of the main loop begins: what the HUD says Claude is doing. */
const noteStart = async ($: EngineInterface, e: { tool: string; tool_use_id: string; agentId?: string } & Record<string, unknown>) => {
  const now = await $.clock.now()
  const agentId = e.agentId
  if (agentId !== undefined) {
    const doing = activityOf(e.tool, e).kind
    const count = (await read($, ledgerAtom)).agents.find(a => a.id === agentId)?.counts.tools
    await editAgent($, agentId, a => ({ ...a, state: 'running', tool: e.tool, kind: doing, toolCount: count ?? a.toolCount }))
    // a subagent's work is counted apart: it never moves the task
    const activity = await read($, activityAtom)
    if (!activity.agents.includes(agentId)) {
      await update($, activityAtom, old => (old.agents.includes(agentId) ? old : { ...old, agents: [...old.agents, agentId].slice(-16) }))
    }

    return
  }
  const { kind, detail } = activityOf(e.tool, e)
  await update($, activityAtom, old => ({ ...old, kind, detail, isWorking: true, toolUseId: e.tool_use_id, at: now }))
  await change($, task => {
    const noted = { ...task, lastAction: { at: now, text: oneLine(`${kind} ${detail}`, 80) } }
    if (task.milestones.length > 0) return noted
    // no plan: the phase is read off what is actually being done
    const phase =
      kind === 'EDIT' ? 'IMPLEMENT' : kind === 'TEST' ? 'TEST' : kind === 'PLAN' ? 'PLAN' : kind === 'READ' || kind === 'WEB' ? 'RESEARCH' : task.phase

    return { ...noted, phase }
  })
  startTicker($)
}

/** The call returned: gates from real results, files touched, a fresh look at the repository. */
const noteEnd = async (
  $: EngineInterface,
  e: { tool: string; tool_use_id: string; agentId?: string } & Record<string, unknown>,
  ran: { deny?: string | undefined; isError?: boolean | undefined; result?: unknown },
) => {
  if (e.agentId !== undefined) return
  const result = (ran.deny === undefined && ran.isError !== true ? ran.result : null) as Record<string, unknown> | null
  const edits: { path: string; added: number; removed: number }[] = []
  if ((e.tool === 'Edit' || e.tool === 'Write') && result !== null && result['staged'] !== true) {
    const path = String(result['filePath'] ?? e['file_path'] ?? '')
    // a new file has no patch: every line of it was added
    const counts =
      result['type'] === 'create' && typeof result['content'] === 'string'
        ? { added: result['content'].replace(/\n$/, '').split('\n').length, removed: 0 }
        : countPatch(result['structuredPatch'])
    if (path !== '') edits.push({ path: relative(path), ...counts })
  }
  if (e.tool === 'Bash' && result !== null) {
    const files: unknown = (result['bashEditDiff'] as { files?: unknown } | undefined)?.files
    for (const file of Array.isArray(files) ? files : []) {
      const path = String((file as { filePath?: unknown }).filePath ?? '')
      if (path !== '') edits.push({ path: relative(path), ...countPatch((file as { hunks?: unknown }).hunks) })
    }
  }
  const readings =
    e.tool === 'Bash' && ran.deny === undefined
      ? readBash(String(e['command'] ?? '')).read(
          ran.isError === true
            ? 'error'
            : result !== null && (result['backgroundTaskId'] !== undefined || result['interrupted'] === true)
              ? 'unknown'
              : 'ok',
        )
      : []

  if (edits.length > 0 || readings.length > 0) {
    await change($, (task, now) => {
      let chain = task
      for (const edit of edits) chain = touchFile(chain, edit.path, edit.added, edit.removed)
      if (edits.length > 0 && isSonnetLed()) chain = requireReview(chain, mandatoryGrounds(factsOf({ ...chain, files: chain.files.map(f => ({ ...f, path: relative(f.path) })) }, 0, chain.promptGrounds ?? [])))
      for (const reading of readings) chain = setGate(chain, reading.gate, reading.state, reading.evidence, 'auto', now)

      return chain
    })
  }
  // The failure streak: the same check failing again, or the same tool erroring
  // again. A refused call ran nothing and says nothing about either.
  if (config.hasOrchestration && ran.deny === undefined && e.tool !== TOOL) {
    const failing = readings.filter(one => one.state === 'fail').map(one => one.gate)
    const passing = readings.filter(one => one.state === 'pass').map(one => one.gate)
    const failed = failing.length > 0 || (ran.isError === true && readings.length === 0)
    // a check whose result is masked settles nothing, and neither lengthens nor ends a streak
    if (failed || passing.length > 0 || readings.length === 0) {
      const key = outcomeKey(e.tool, e, failed ? failing : passing)
      const at = await $.clock.now()
      const held = await read($, orchestraAtom)
      if (noteOutcome(held, key, failed, at) !== held) await update($, orchestraAtom, old => noteOutcome(old, key, failed, at))
    }
  }
  const activity = await read($, activityAtom)
  if (activity.toolUseId === e.tool_use_id) {
    await update($, activityAtom, (old): Activity =>
      old.toolUseId === e.tool_use_id ? { ...old, kind: old.isWorking ? 'THINK' : 'IDLE', detail: '', toolUseId: null } : old,
    )
  }
  scheduleGit($)
  void refreshMeter($)
}

const hudInput = async ($: EngineInterface, isWorking: boolean): Promise<HudInput> => ({
  task: await read($, taskAtom),
  activity: await read($, activityAtom),
  git: await read($, gitAtom),
  meter: await read($, meterAtom),
  isWorking,
})

/**
 * What the crawler is allowed to know this frame, and the state it derived.
 *
 * Every field is read from state the host already reported. `progress` comes
 * from `settle`, which refuses to call a task 100% until its gates really
 * passed, so the crawler cannot be shown a completion that did not happen.
 */
const crawlerOf = async ($: EngineInterface, input: HudInput, visual: Visual, waiting: boolean): Promise<{ crawler: CrawlerInput; newest: NwhoEvent | null }> => {
  const settled = input.task === null ? null : settle(input.task).task
  // The same three facts `visualStateOf` believes, read the same way, so the
  // crawler can never disagree with the HUD's own state word.
  const failed =
    input.task?.milestones.some(m => m.state === 'failed') === true ||
    Object.values(input.task?.gates ?? {}).some(g => g.state === 'fail') ||
    ((input.task?.failures.length ?? 0) > 0 && input.task?.phase === 'FIX')
  const observations: Observations = {
    phase: input.task?.phase ?? 'RESEARCH',
    progress: (settled?.percent ?? 0) / 100,
    hasTask: input.task !== null,
    allGatesPassed: settled !== null && settled.status === 'done',
    isDone: input.task?.status === 'done' && settled?.status === 'done' && settled.percent === 100,
    activity: input.activity.kind === 'IDLE' ? null : input.activity.kind,
    failed,
    waiting,
    // `isWorking` is the band's own flag, which is what the HUD's state word is
    // derived from too: a turn that has started but has not reached a tool is a
    // scan here and a glitch in the panel, and the two can never disagree.
    isWorking: input.isWorking,
  }
  const now = await $.clock.now()
  const flash = await read($, flashAtom)
  const control = await read($, controlAtom)
  const strength = flashStrength(flash, now, reducedMotion)
  // Only the newest live receipt drives the layer, and only while it is live.
  const newest = control.lastPrune !== null && (control.lastDecision === null || control.lastPrune.at >= control.lastDecision.at) ? control.lastPrune : control.lastDecision
  const live = newest !== null && strength > 0

  return {
    crawler: {
      state: stateOf(observations),
      progress: observations.progress,
      milestones: input.task?.milestones.length ?? 0,
      activity: observations.activity ?? '',
      nwhoTier: live ? newest?.tier ?? null : null,
      nwhoOp: live ? newest?.op ?? null : null,
      nwhoStrength: live ? strength : 0,
    },
    newest: live ? newest : null,
  }
}

/**
 * The NobodyWho layer for a frame.
 *
 * A prune draws only branches, a decision only a junction, and an absent or
 * faded receipt draws nothing at all. The counts come from the receipt that
 * actually arrived, so a branch is only ever drawn for a block the router
 * really judged and really dropped.
 */
const layerFor = (crawler: CrawlerInput, newest: NwhoEvent | null): NwhoLayer =>
  newest === null ? NO_NWHO : layerOf(crawler, newest.accepted, newest.rejected)

/**
 * Records that one startup module really finished initializing.
 *
 * The step is appended only once, so a hot reload that re-runs `register` does
 * not double-count, and the sequence's own progress can never exceed the work
 * that actually happened.
 */
const markStartup = async ($: EngineInterface, step: string): Promise<void> => {
  const done = await read($, startupAtom)
  if (done.includes(step)) return
  await update($, startupAtom, old => (old.includes(step) ? old : [...old, step]))
}

/** Drops the init line the moment real work begins, so it never lingers. */
const dismissStartup = ($: EngineInterface) => quiet(async () => {
  if ((await read($, startupAtom)).length > 0) await update($, startupAtom, () => [])
})

export const ledgerAtom = atom({ plugin: 'cobalt-cockpit', key: 'run-ledger' } as const, emptyLedger())
const positionAtom = atom({ plugin: 'cobalt-cockpit', key: 'replay-position' } as const, 0)
const resumeAtom = atom({ plugin: 'cobalt-cockpit', key: 'ledger-resume' } as const, false)
const LEDGER_PANE = 'cobalt-run-ledger'
const REPLAY_PANE = 'cobalt-replay'
const STORE_MAX_SESSIONS = 8
const hush = async (work: () => Promise<unknown>) => { try { await work() } catch { /* bookkeeping never fails an engine action */ } }
export const mutateLedger = async ($: EngineInterface, f: (l: Ledger) => Ledger): Promise<void> => {
  const old = await read($, ledgerAtom)
  if (f(old) !== old) await update($, ledgerAtom, f)
}
export const ledgerSpawn = async ($: EngineInterface, e: { subagentType: string; description: string; model?: string; parentAgentId?: string; background: boolean; parentModel: string; provider: { plugin: string } }, spawned: { agentId?: string; model?: string; deny?: string }, originLedger?: Ledger, spawnAt?: number): Promise<void> => {
  if (!spawned.agentId) return
  const at = spawnAt ?? await $.clock.now()
  const origin = originLedger === undefined ? undefined : originOf(originLedger, e.parentAgentId)
  const originTurn = originLedger?.turns[e.parentAgentId ?? 'main']
  await mutateLedger($, l => addAgent({ ...l, runs: l.runs.map(r => e.parentAgentId === undefined && r.id === (origin ?? l.currentRun) && r.model === UNKNOWN ? { ...r, model: word(e.parentModel) } : r) }, { agentId: spawned.agentId!, subagentType: e.subagentType, description: e.description, requestedModel: e.model, model: spawned.model, parentAgentId: e.parentAgentId, background: e.background, source: e.provider.plugin, originRun: origin, originTurn }, at))
  await persist($)
}
const adoptLedgerAgents = async ($: EngineInterface): Promise<void> => {
  const listed = await $.agent.list()
  const at = await $.clock.now()
  await changeSwarm($, held => {
    let chain = held
    for (const info of listed) {
      const t = chain.tasks.find(t=>t.agentId === info.id && !['completed','failed','cancelled'].includes(t.state))
      if (t && ['completed','failed','error','cancelled','aborted'].includes(info.status)) {
        chain = finishObserved(chain,t.id,info.status,'Host reports stopped; result unavailable',at)
      }
    }
    return markStalled(chain,at)
  })
  await mutateLedger($, l => listed.reduce((chain, info) => adoptAgent(chain, info), l))
}
export const ledgerRequest = async ($: EngineInterface, e: { turnId: string; index: number; agentId?: string; model: string; effort?: unknown }, actual: { model?: string; effort?: unknown; usage?: unknown; routingReason?: string; fallbackReason?: string | null; via?: 'host' | 'hook' }, warning?: string | null): Promise<void> => {
  if (e.agentId && !(await read($, ledgerAtom)).agents.some(a => a.id === e.agentId)) await hush(() => adoptLedgerAgents($))
  await mutateLedger($, l => {
    const noted = recordRequest(l, e, { ...actual, usage: actual.usage as Record<string, unknown> | null })
    return warning ? warn(noted, warning) : noted
  })
  await persist($)
}
const persist = async ($: EngineInterface): Promise<void> => {
  const ledger = await read($, ledgerAtom)
  if (ledger.sessionId === UNKNOWN) return
  await $.store.set(`ledger:${ledger.sessionId}`, storageLedger(ledger))
  const index = (await $.store.get('ledger-index')) as string[] | undefined
  const ids = [...(Array.isArray(index) ? index.filter(s => typeof s === 'string' && s !== ledger.sessionId) : []), ledger.sessionId]
  for (const old of ids.slice(0, -STORE_MAX_SESSIONS)) await $.store.delete(`ledger:${old}`)
  await $.store.set('ledger-index', ids.slice(-STORE_MAX_SESSIONS))
}
const checkpoint = async ($: EngineInterface) => {
  const task = (await read($, { plugin: 'cobalt-cockpit', key: 'task' })) ?? null
  const git = (await read($, { plugin: 'cobalt-cockpit', key: 'git' })) ?? null
  const at = await $.clock.now()
  await mutateLedger($, l => ({ ...l, checkpoint: checkpointOf(l, task, git, at) }))
  await persist($)
}
const sample = async ($: EngineInterface) => {
  const usage = await $.session.usage()
  const at = await $.clock.now()
  await mutateLedger($, l => reading(l, usage.context, at))
}
const restore = async ($: EngineInterface) => {
  const id = (await $.session.id().catch(() => UNKNOWN)) || UNKNOWN
  const held = await read($, ledgerAtom)
  const stored = await $.store.get(`ledger:${id}`) as Ledger | undefined
  if (held.sessionId !== id) {
    await mutateLedger($, () => stored && (stored.schema === 1 || stored.schema === 2) && stored.sessionId === id ? migrateLedger(stored) : emptyLedger(id))
    if (stored?.checkpoint) {
      await update($, resumeAtom, () => true)
      await $.ui.toast(`COBALT / RESUME · ${stored.checkpoint.phase} · ${stored.checkpoint.remaining.length} milestones remaining`, { timeoutMs: 8000 })
    }
  } else if (!held.swarm || held.schema === 1) await mutateLedger($, migrateLedger)
}
export const ledgerStart = async ($: EngineInterface) => {
      await hush(() => restore($))
      await hush(() => adoptLedgerAgents($))
      for (const name of ['ledger', 'replay', 'park']) await hush(() => $.command.register({ name, description: name === 'ledger' ? 'Cobalt Control / Run Ledger; export json' : name === 'replay' ? 'Successful repository deltas' : 'Deterministic checkpoint', immediate: true }))
      await hush(() => sample($))
    }
export const ledgerTurnStart = async ($: EngineInterface, turnId: string) => { await hush(async () => { await restore($); const at = await $.clock.now(); await mutateLedger($, l => startRun(l, turnId, at)) }) }
export const ledgerTurnComplete = async ($: EngineInterface, e: { turnId: string; agentId?: string; reason: string; answer?: string }) => {
  await hush(async () => {
    const at = await $.clock.now()
    await mutateLedger($, l => {
      const ended = finishTurn(l,e,at)
      if (!e.agentId) return ended
      const completed = [...(ended.observedCompletions ?? []).filter(c=>c.agentId!==e.agentId), { agentId:e.agentId,reason:e.reason,conclusion:textOf(e.answer),at }].slice(-128)
      const task = swarmState(ended).tasks.find(t=>t.agentId===e.agentId)
      return { ...ended, observedCompletions:completed, swarm:task ? finishObserved(swarmState(ended),task.id,e.reason,textOf(e.answer),at) : swarmState(ended) }
    })
    if (!e.agentId) await sample($)
    await checkpoint($)
  })
}
export const ledgerEnd = async ($: EngineInterface) => { await hush(() => checkpoint($)) }
export const ledgerMeasure = async ($: EngineInterface) => { await hush(() => sample($)) }
export const ledgerPrompt = async ($: EngineInterface) => { await hush(() => update($, resumeAtom, () => false)) }
export const ledgerToolStart = async ($: EngineInterface, call: Record<string, unknown>) => { await hush(async () => { const at = await $.clock.now(); await mutateLedger($, l => beginTool(l, call, at)) }) }
export const ledgerToolEnd = async ($: EngineInterface, call: Record<string, unknown>, r: { deny?: string; isError?: boolean; result?: unknown }, before?: string) => {
      await hush(async () => {
        const end = await $.clock.now(), id = String(call['tool_use_id']), tool = call['tool']
        const failed = r.deny !== undefined || r.isError === true
        await mutateLedger($, l => finishTool(l, id, failed, end))
        const result = r.result as { staged?: boolean } | undefined
        if (!failed && result?.staged !== true && (tool === 'Edit' || tool === 'Write')) {
          const oldText = tool === 'Edit' ? call['old_string'] : before, newText = tool === 'Edit' ? call['new_string'] : call['content']
          await mutateLedger($, l => {
            const origin = l.tools.find(t => t.id === id)
            return withReplay(l, { id, runId: origin?.runId ?? UNKNOWN, turnId: origin?.turnId ?? UNKNOWN, agentId: typeof call['agentId'] === 'string' ? call['agentId'] : UNKNOWN, file: safeFile(call['file_path']), kind: tool, at: end, before: typeof oldText === 'string' ? oldText : '', after: typeof newText === 'string' ? newText : '', scope: tool === 'Edit' ? 'fragment' : 'file', omitted: typeof oldText !== 'string' || typeof newText !== 'string' })
          })
        }
        await persist($)
      })
    }
export const ledgerBeforeWrite = async ($: EngineInterface, path: unknown): Promise<string | undefined> => {
      if (safeFile(path) === UNKNOWN) return undefined
      try { const file = String(path); if (!await $.fs.exists(file)) return ''; if ((await $.fs.stat(file)).size > STEP_BYTES) return undefined; return await $.fs.read(file) } catch { return undefined }
}

export const registerLedger = (on: On): void => {
  // The session's own start. `restore` rides on it, and a hook that fails
  // before `next` is skipped, so its handler lets the session start.
  on('classic.SessionStart', async ($, e, next) => {
    const ran = await next(e)
    if (e.source === 'resume') await hush(() => restore($))

    return ran
  }).catch(($, e, next) => next(e))
  on('command.run', { command: 'park' }, async $ => {
    await checkpoint($)
    const c = (await read($, ledgerAtom)).checkpoint!
    return { text: `COBALT / PARKED · ${c.phase}\nCompleted ${c.completed.length} · remaining ${c.remaining.length} · background agents ${c.backgroundAgents.length}\nResume with Claude Code's normal session resume.` }
  }).catch(($, e, next) => next.called ? next(e) : { text: 'COBALT / the checkpoint could not be written; nothing was parked.' })
  on('command.run', { command: 'ledger' }, async ($, e) => {
    await checkpoint($)
    const l = await read($, ledgerAtom)
    if (e.args.trim() === 'export' || e.args.trim() === 'export json') return { text: exportJSON(l) }
    if (e.args.trim() !== '') return { text: 'Usage: /ledger | /ledger export json' }
    await $.ui.open({ id: LEDGER_PANE, title: 'COBALT / RUN LEDGER', focus: true })
    return { text: 'COBALT / RUN LEDGER' }
  }).catch(($, e, next) => next.called ? next(e) : { text: 'Cobalt: the Run Ledger could not be read; nothing was opened.' })
  on('command.run', { command: 'replay' }, async $ => {
    const l = await read($, ledgerAtom)
    if (!replayTimeline(l).length) return { text: 'No successful Edit/Write snapshots observed.' }
    await update($, positionAtom, () => 0)
    await $.ui.open({ id: REPLAY_PANE, title: 'COBALT / REPLAY', focus: true })
    return { text: `COBALT / REPLAY · ${replayTimeline(l).length} steps` }
  }).catch(($, e, next) => next.called ? next(e) : { text: 'Cobalt: the replay timeline could not be read; nothing was opened.' })
  on('ui.render', { component: 'Pane', requestId: LEDGER_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const auth = await read($, { plugin: 'cobalt-cockpit', key: 'auth' })
    // The host's own /cost total where it keeps one; nothing is estimated in its place.
    const cost = isSonnetLed() ? await $.session.usage().then(u => (u.cost === undefined ? 'unavailable' : `$${u.cost.usd.toFixed(2)} (host-reported, session)`), () => 'unavailable') : undefined
    const lines = ledgerLines(await read($, ledgerAtom), await $.clock.now(), auth?.mode === 'subscription' ? 'SUBSCRIPTION' : auth?.mode === 'api' ? 'API' : UNKNOWN, cost)
    return <Box flexDirection="column">{lines.map((line, i) => <Text key={String(i)} color={/^COBALT|^\d\d /.test(line) ? COLORS.accent : undefined} wrap="truncate-end">{line}</Text>)}<Button key="close" label="Close" hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: LEDGER_PANE })} /></Box>
  })
  on('ui.render', { component: 'Pane', requestId: REPLAY_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const steps = replayTimeline(await read($, ledgerAtom))
    const pos = Math.min(await read($, positionAtom), Math.max(0, steps.length - 1))
    const step = steps[pos]
    return <Box flexDirection="column"><Text color={COLORS.accent}>{step ? `COBALT / REPLAY · ${pos + 1}/${steps.length} · ${step.title}` : 'No snapshots'}</Text>{step && step.lines.map((line, i) => <Text key={String(i)} color={line.startsWith('+') ? COLORS.ok : line.startsWith('-') ? COLORS.bad : undefined} wrap="truncate-end">{line}</Text>)}<Box flexDirection="row"><Button key="previous" label="Previous" hotkey="p" onPress={() => update($, positionAtom, n => Math.max(0, n - 1))} /><Button key="advance" label="Next" hotkey="n" onPress={() => update($, positionAtom, n => Math.min(steps.length - 1, n + 1))} /><Button key="close" label="Close" hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: REPLAY_PANE })} /></Box></Box>
  })
}

export const resumeLine = async ($: EngineInterface): Promise<string | null> => {
  if (!await read($, resumeAtom)) return null
  const c = (await read($, ledgerAtom)).checkpoint
  return c ? `COBALT / RESUME · ${c.phase} · ${c.completed.length} complete · ${c.remaining.length} remaining · /ledger` : null
}

export const register: Register = (on, options) => {
  const profile: Profile = isProfile(options['profile']) ? options['profile'] : DEFAULT_PROFILE
  const isLed = profile === 'SONNET_LED'
  config = {
    hasHud: options['hud'] !== false,
    isAnimated: options['animation'] !== false,
    hasSounds: options['sounds'] !== false,
    hasGuard: options['blastRadiusGuard'] !== false,
    hasAttributionGuard: options['attributionGuard'] !== false,
    volume: clampVolume(options['volume']),
    hasLocalControl: options['localControl'] !== false,
    ledgerPath: typeof options['ledgerPath'] === 'string' ? options['ledgerPath'] : '',
    blocksFable: options['cobaltStrict'] === true || options['blockFable'] === true,
    isStrict: options['cobaltStrict'] === true,
    hasOrchestration: options['cobaltStrict'] === true || options['orchestration'] === true,
    // SONNET_LED's AUTO budgets are its conservative ones; an explicit value still wins.
    maxSubagents: isLed && !(typeof options['maxSubagents'] === 'number' && options['maxSubagents'] > 0) ? (SONNET_LED_SWARM.total as number) : limitOf(options['maxSubagents']),
    maxSonnet: ((v: number | 'AUTO') => (isLed && v === 'AUTO' ? (SONNET_LED_SWARM.sonnet as number) : v))(poolBudget(options['maxSonnet'] ?? options['maxSonnetAgents'])),
    maxHaiku: ((v: number | 'AUTO') => (isLed && v === 'AUTO' ? (SONNET_LED_SWARM.haiku as number) : v))(poolBudget(options['maxHaiku'] ?? options['maxHaikuAgents'])),
    isSubscriptionOnly: options['cobaltStrict'] === true || options['subscriptionOnly'] === true,
    reasoningMode: options['reasoningMode'] === 'MANUAL' ? 'MANUAL' : 'AUTO',
    maxEffort: isEffortLevel(options['maxEffort']) ? options['maxEffort'] : DEFAULT_CEILING,
    modelEffort: parseModelEffort(options['modelEffort']),
    profile,
    hasLocalAdvice: options['localAdvice'] !== false,
  }

  registerLedger(on)

  on('session.start', async ($, e, next) => {
    await quiet(async () => {
      const version = await $.session.version()
      isSupported = isAtLeast(version.base ?? version.version, MIN_VERSION)
      hasNativeEffort = isAtLeast(version.base ?? version.version, NATIVE_EFFORT_VERSION)
      if (!isSupported) {
        $.ui.log(`cobalt-cockpit needs Claude Code ${MIN_VERSION.join('.')} or newer (this is ${version.version}); it is standing by.`)
      }
    })
    if (!isSupported) return next(e)

    await quiet(() => $.tool.register(PROGRESS_TOOL))
    await quiet(() => $.tool.register(SWARM_TOOL))
    await quiet(() =>
      $.command.register({
        name: 'cockpit',
        description: 'Mission Control: task progress, milestones, verification gates, git and context',
        argumentHint: '[status|reset|mute|unmute|hud on|hud off|auth|version|sound]',
        immediate: true,
      }),
    )
    await quiet(async () => {
      const stored = (await $.store.get('prefs')) as Partial<Prefs> | undefined
      const prefs: Prefs = { isMuted: stored?.isMuted === true, isHudHidden: stored?.isHudHidden === true }
      const held = await read($, prefsAtom)
      if (held.isMuted !== prefs.isMuted || held.isHudHidden !== prefs.isHudHidden) await update($, prefsAtom, () => prefs)
    })
    await quiet(async () => {
      cwd = e.cwd
      home = (await $.env.get('HOME')) ?? ''
    })
    await quiet(async () => {
      reducedMotion = options['reducedMotion'] === true || (await $.env.get('COBALT_REDUCED_MOTION')) === '1'
      const theme = (await $.config.list()).find(row => row.key === 'theme')
      isLight = /light/i.test(String(theme?.value ?? ''))
    })
    // a reload in the middle of a turn: the state says so, the timer is gone
    await quiet(() => scheduleFold($))
    await quiet(async () => {
      if ((await read($, activityAtom)).isWorking) {
        isTurnRunning = true
        startTicker($)
      }
    })
    await ledgerStart($)
    await changeSwarm($, held => configureSwarm(held, { total: config.maxSubagents, sonnet: config.maxSonnet, haiku: config.maxHaiku, opus: isSonnetLed() ? (SONNET_LED_SWARM.opus as number) : 0 }))
    void refreshGit($)
    void refreshMeter($)
    // The NobodyWho watcher: read-only, stat-gated, and started only once the
    // ledger's location is known. Its first read primes at the end of the file,
    // so nothing historical ever reaches the HUD.
    await quiet(() => startLedgerWatch($))
    // How the session is authenticated, read once here and again after a
    // sign-in changes it. The reading is announced the first time and whenever
    // it changes, never on a reload that finds it as it was.
    await quiet(() => probeAuth($, true))
    // Cobalt's own initialization line, shown in the supported AbovePrompt
    // region because Claude Code exposes no startup surface to replace. Each
    // step is appended only as that module really finishes its work, so the
    // line can never claim a step that did not run.
    await quiet(() => markStartup($, 'graph'))
    await quiet(() => markStartup($, 'palette'))
    await quiet(() => markStartup($, 'operator'))
    await quiet(() => markStartup($, 'telemetry'))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await ledgerEnd($)
    stopTicker()
    fieldWalker = RESTING
    // The ledger watcher is cancelled here, so no timer outlives the session.
    stopLedgerWatch()
    band = null
    foldTimer?.cancel()
    foldTimer = null
    gitTimer?.cancel()
    gitTimer = null
    if (e.reason === 'clear') {
      // a /clear ends the conversation the task belonged to
      await quiet(() => update($, taskAtom, () => null))
      await quiet(() => update($, activityAtom, () => IDLE))
      await quiet(() => update($, guardsAtom, () => []))
      await quiet(() => update($, visualAtom, () => ({ waiting: 0, agents: [], revision: 0 })))
      await quiet(() => update($, orchestraAtom, () => EMPTY_ORCHESTRA))
    }
    spawning.clear()

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await ledgerPrompt($)
    if (config.isStrict && hasAdvisor) return { drop: 'COBALT STRICT / disable the external advisor before continuing.' }
    // A session already on Fable, or with Fable configured as its advisor, is
    // told so here, before a turn begins; `turn.step` holds the same line for
    // every request this does not see.
    const model = await $.session.model().catch(() => '')
    if (config.blocksFable && (isFable(model) || isAdvisorFable)) {
      await recordBlock($)

      return { drop: `${BLOCK_LINE}. This session is set to use Fable${isAdvisorFable && !isFable(model) ? ' as its advisor' : ''}, which this workflow never runs. Nothing was sent. Switch with /model opus${isAdvisorFable ? ' and turn the advisor off (/advisor)' : ''}.` }
    }
    if (await isApiRefused($).catch(() => false)) return { drop: API_REFUSAL }
    if (!isSupported) return next(e)
    // The init line has done its job the moment real work arrives.
    await dismissStartup($)
    let context: string | null = null
    await quiet(async () => {
      const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk'
      if (!isPerson) return
      const now = await $.clock.now()
      const sha = (await read($, gitAtom))?.sha ?? null
      const task = await update($, taskAtom, old => {
        // an unfinished planned task goes on; anything else is a new one
        const isContinuing = old !== null && old.milestones.length > 0 && old.status !== 'done'
        const base = isContinuing ? old : newTask((old?.id ?? 0) + 1, e.text, now, sha)

        const prompted: Task = {
          ...base,
          lastPrompt: oneLine(e.text, 160),
          updatedAt: now,
          hasInstructionFileRequest: base.hasInstructionFileRequest || namesInstructionFile(e.text),
        }
        if (!isSonnetLed()) return prompted
        // Grounds are read from the full prompt: the stored one is clipped.
        const promptGrounds = [...new Set([...(prompted.promptGrounds ?? []), ...promptGroundsOf(e.text)])]
        const withGrounds: Task = { ...prompted, promptGrounds }

        return settle(requireReview(withGrounds, mandatoryGrounds(factsOf(withGrounds, 0, promptGrounds)))).task
      })
      if (task !== null && task.milestones.length > 0) context = `Cobalt Cockpit, state of the task in progress: ${summaryOf(task)}`
    })

    // A prompt goes on either way: this hook adds what it observed to the
    // context, and a hook that fails would be skipped rather than drop one.
    if (context === null) return next(e)

    return next({ ...e, context: [...(e.context ?? []), context] })
  }).catch(async ($, e, next) => {
    // The three drops this hook makes — the strict preset's advisor line, a
    // session set to use Fable, and the subscription policy's — are made here
    // too: forwarding them would send a request the policy exists to refuse.
    if (next.called) return next(e)
    if (config.isStrict && hasAdvisor) return { drop: 'COBALT STRICT / disable the external advisor before continuing.' }
    if (config.blocksFable) {
      const model = await $.session.model().catch(() => '')
      if (isFable(model) || isAdvisorFable) {
        await recordBlock($)

        return { drop: `${BLOCK_LINE}. This session is set to use Fable, which this workflow never runs. Nothing was sent.` }
      }
    }
    if (await isApiRefused($).catch(() => false)) return { drop: API_REFUSAL }

    return next(e)
  })

  on('command.run', { command: 'init' }, async ($, e, next) => {
    // /init is the person asking for a CLAUDE.md
    await quiet(() => change($, task => ({ ...task, hasInstructionFileRequest: true })))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (isSupported) await ledgerTurnStart($, e.turnId)
    if (isSupported) {
      await quiet(async () => {
        const now = await $.clock.now()
        isTurnRunning = true
        await update($, activityAtom, (old): Activity => ({ ...old, kind: 'THINK', detail: '', isWorking: true, toolUseId: null, at: now }))
        startTicker($)
      })
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (isSupported) {
      await quiet(async () => {
        const agentId = e.agentId
        if (agentId !== undefined) {
          sentVia.delete(agentId)
          const now = await $.clock.now()
          await editAgent($, agentId, a => ({ ...a, state: e.reason === 'answer' ? 'done' : 'error', tool: e.reason === 'answer' ? 'Done' : 'Failed', endedAt: now }))
          await scheduleFold($)
          // a subagent finished its own turn: the parent task is exactly where it was
          await update($, activityAtom, old => ({ ...old, agents: old.agents.filter(id => id !== agentId) }))

          return
        }
        const now = await $.clock.now()
        isTurnRunning = false
        stopTicker()
        await update($, activityAtom, (old): Activity => ({ ...old, kind: 'IDLE', detail: '', isWorking: false, toolUseId: null, at: now }))
        // the turn is over; whether the task is done is the milestones' and the gates' to say
        if (e.reason === 'error' || e.reason === 'refusal') {
          await change($, task => noteFailure(task, now, `the turn ended on ${e.reason === 'error' ? 'an API error' : 'a refusal'}`))
        }
        void refreshGit($)
        void refreshMeter($)
      })
    }

    if (isSupported) await ledgerTurnComplete($, e)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // The event is copied because the guards, the effort policy and the
    // read-only shell rewrite may change it; `isChanged` answers whether that
    // copy differs from the event the engine raised.
    const call = { ...e } as typeof e & Record<string, unknown>
    const isChanged = (): boolean =>
      Object.keys(call).length !== Object.keys(e).length ||
      Object.keys(e).some(key => (call as Record<string, unknown>)[key] !== (e as Record<string, unknown>)[key])
    // Fable first, on every engine version and in every loop: a pure check
    // that cannot throw, so no failure below can let the call through.
    if (config.blocksFable && fableRoute(e.tool, call)) {
      await recordBlock($)

      return { deny: BLOCK_DENY }
    }
    if (!isSupported) return next(e)
    const effect = config.hasOrchestration && !e.agentId && !['Read','Grep','Glob','WebFetch','WebSearch','ToolSearch','Agent','Task','TaskOutput','TaskStop','SendMessage',TOOL,SWARM_TOOL_NAME].includes(String(e.tool)) && !(e.tool === 'Bash' && readOnlyShell(String(call['command'] ?? '')))
    if (effect && (spawning.size || commanderEffects.size)) return { deny:'SWARM / commander effect or agent admission in flight; serialize this operation' }
    const effectToken = Symbol(e.tool_use_id)
    if (effect) commanderEffects.add(effectToken)
    try {
    await ledgerToolStart($, call)
    if (String(e.tool) === SWARM_TOOL_NAME) { const r = await serveSwarm($, call); await ledgerToolEnd($, call, r); return r }
    const swarmRefusal = await guardSwarm($, call)
    if (swarmRefusal) { await ledgerToolEnd($, call, { deny: swarmRefusal }); return { deny: swarmRefusal } }
    if (e.tool === TOOL) { const r = await serveProgress($, call as ProgressInput & { agentId?: string }); await ledgerToolEnd($, call, r); return r }

    // a guard that fails must not take every tool call down with it
    const refusal = await guard($, call).catch(() => null)
    if (refusal !== null) { await ledgerToolEnd($, call, refusal); return refusal }

    if (config.hasOrchestration && e.agentId && e.tool === 'Bash' && readOnlyShell(String(call['command'] ?? ''))) (call as Record<string,unknown>)['command'] = String(call['command']).replace(/\bgit\s+(diff|show|log)\b/g, 'git $1 --no-ext-diff --no-textconv').replace(/\bgit\b/g,'git --no-pager')
    // A subagent's reasoning level goes on its own Agent call: the engine's
    // native, per-invocation setting, so nothing global moves under a sibling.
    if (config.hasOrchestration && hasNativeEffort && !e.agentId && e.tool === 'Agent') await quiet(() => launchEffort($, call))
    const beforeWrite = e.tool === 'Write' ? await ledgerBeforeWrite($, call['file_path']) : undefined

    await quiet(() => noteStart($, call))
    // The Activity Field's tape: one entry when a call really starts, closed
    // when it really returns. `callOf` reduces it to safe fields, and a call it
    // does not recognize contributes nothing at all.
    const fieldEvent = callOf(call, await $.clock.now())
    if (fieldEvent !== null) await quiet(() => update($, eventsAtom, log => push(log, fieldEvent)))
    const isQuestion = e.tool === 'AskUserQuestion'
    if (isQuestion) {
      await quiet(() => e.agentId ? editAgent($, e.agentId, a => ({ ...a, state: 'waiting', tool: 'Needs input' })) : update($, visualAtom, old => ({ ...old, waiting: old.waiting + 1 })))
      stopTicker()
    }
    let ran
    try { ran = await next(isChanged() ? call : e) }
    catch (error) { await ledgerToolEnd($, call, { isError: true }); throw error }
    finally {
      if (isQuestion) await quiet(() => e.agentId ? editAgent($, e.agentId, a => ({ ...a, state: 'running', tool: 'Thinking' })) : update($, visualAtom, old => ({ ...old, waiting: Math.max(0, old.waiting - 1) })))
    }
    await ledgerToolEnd($, call, ran, beforeWrite)
    // `SubagentHandback` is the native report channel a bounded helper uses to
    // answer its parent; the host documents it on the Agent result (`handback`)
    // but not in the tool-name union, so it is matched by value, never by name.
    const handbackAgent: string | undefined = typeof e['agentId'] === 'string' ? e['agentId'] : undefined
    if (config.hasOrchestration && handbackAgent !== undefined && (e.tool as string) === 'SubagentHandback' && !ran.deny && !ran.isError && typeof call['message'] === 'string') await quiet(async () => {
      const at = await $.clock.now()
      await changeSwarm($, s => acknowledgeHandback(s, handbackAgent, textOf(call['message']), at))
      await persist($)
    })
    if (e.agentId) await quiet(async () => { const a = (await read($, ledgerAtom)).agents.find(a => a.id === e.agentId); if (a) await editAgent($, e.agentId!, old => ({ ...old, toolCount: a.counts.tools })) })
    await quiet(() => noteEnd($, call, ran))
    // Close the field's entry with the call's real outcome, so the tape can show
    // a break that really happened and never one that did not.
    if (fieldEvent !== null && e.tool_use_id) {
      const finished = await $.clock.now()
      const failed = String((ran as { decision?: string } | undefined)?.decision ?? '') === 'deny'
      await quiet(() => update($, eventsAtom, log => closeOf(log, e.tool_use_id as string, failed, finished)))
    }
    // A failure that has repeated is said once, beside the result it repeated
    // on. Every other call returns exactly what the engine answered.
    if (e.agentId === undefined && ran.isError === true) {
      const hint = await repeatedErrorHint($).catch(() => null)
      if (hint !== null) return { ...ran, context: [...(ran.context ?? []), hint] }
    }

    return ran
    } finally { commanderEffects.delete(effectToken) }
  }).catch(($, e, next) => next.called ? next(e) : { deny: `COCKPIT / the tool guard failed, so this call did not run (${next.error.kind}). Do not reach the same effect another way; reload the plugin first.` })

  on('agent.offer', ($, e, next) => {
    // A type whose name identifies Fable is withheld from the listing, and its
    // dispatch is refused with it.
    if (config.blocksFable && isFable(e.agent)) return { isOffered: false }

    return next(e)
  }).catch(($, e, next) => {
    // Judged against the event this handler was given, not refused wholesale: a
    // type whose name identifies Fable is withheld, and every other type goes on.
    if (next.called || !config.blocksFable || !isFable(e.agent)) return next(e)

    return { isOffered: false }
  })

  on('agent.spawn', async ($, e, next) => {
    // Refused before the engine resolves a model: a spawn that names Fable, an
    // agent type that does, or a fork of a parent that is on it.
    if (config.blocksFable && (isFable(e.model) || isFable(e.subagentType) || (e.fork && isFable(e.parentModel)))) {
      await recordBlock($)

      return { deny: BLOCK_DENY }
    }
    if (!isSupported) return next(e)
    const role = roleOf(e.subagentType)
    let assignedId = /\[task:([\w.-]+)\]/.exec(e.description)?.[1]
    let reservedId: string | undefined
    // what this spawn's Agent call was launched with, taken once
    const launch = launches.get(e.tool_use_id)
    launches.delete(e.tool_use_id)
    // Reserved before the first await, so the spawns of one message are counted
    // in the order they arrived.
    const token = Symbol(e.tool_use_id)
    const ahead = [...spawning.keys()]
    spawning.set(token, null)
    try {
      if (config.hasOrchestration) {
        if (commanderEffects.size) return { deny:'SWARM / commander effect in flight; assignment remains queued until it completes' }
        const running = await runningAgents($)
        // the spawns ahead of this one that the list does not show yet
        const pending = ahead.filter(one => spawning.has(one) && !running.has(spawning.get(one) ?? '')).length
        const refusal = admitSpawn(running.size + pending, config.maxSubagents)
        if (refusal !== null) {
          await quiet(() => update($, orchestraAtom, old => ({ ...old, refusedLimit: old.refusedLimit + 1 })))

          return { deny: refusal }
        }
        if (role === 'REVIEWER' && !assignedId) {
          const strips = (await read($, visualAtom)).agents
          const task = await read($, taskAtom)
          const verdict = reviewVerdict(await read($, orchestraAtom), {
            task,
            reviewerRunning: strips.some(a => a.role === 'REVIEWER' && a.endedAt === null && running.has(a.id)),
          })
          if (!verdict.ok) {
            await quiet(() => update($, orchestraAtom, old => ({ ...old, refusedReview: old.refusedReview + 1 })))

            return { deny: verdict.reason }
          }
          await update($, orchestraAtom, old => reviewAdmitted(old, verdict.why, task?.id ?? null))
        }
      }
      // A spawn that names no model runs on Sonnet instead of inheriting.
      if (config.hasOrchestration && e.fork) {
        await quiet(() => mutateLedger($, l => warn(l, 'MODEL POLICY / fork refused: forks inherit parent model')))
        return { deny: 'MODEL POLICY / fork inherits its parent model; use an isolated Sonnet agent.' }
      }
      let assigned = swarmState(await read($, ledgerAtom)).tasks.find(t => t.id === assignedId)
      if (config.hasOrchestration) {
        if (e.parentAgentId) return { deny: 'SWARM / only commander delegates; escalate a structured handoff' }
        if (assignedId && !assigned) return { deny: 'SWARM / unknown assignment' }
        const at = await $.clock.now()
        // SONNET_LED: Opus runs only as an admitted consultation. Naming Opus or
        // the architect on an unassigned call is refused, not quietly downgraded.
        if (isSonnetLed() && !assigned && (role === 'ARCHITECT' || tierOf(e.model) === 'OPUS')) return { deny: 'OPUS / NOT ADMITTED. Opus runs only as an admitted consultation: request one with swarm action "consult" (ground and evidence packet), then spawn cobalt-cockpit:architect with the [task:ID] it returns. Nothing was started.' }
        if (!assigned) {
          assignedId = `legacy-${e.tool_use_id}-${(await read($, orchestraAtom)).spawned}`.replace(/[^\w.-]/g,'-')
          const tier = tierOf(e.model) === 'HAIKU' || role === 'SCOUT' || role === 'UTILITY' ? 'HAIKU' : 'SONNET'
          const state = await changeSwarm($, held => submitTask(held, { id: assignedId!, tier, role, objective: textOf(e.description || e.subagentType), mode: ['EXPLORER','RESEARCHER','REVIEWER','SCOUT','UTILITY'].includes(role) ? 'read' : 'write', owned:['*'], spawnReason:'Legacy Agent call; unknown scope conservatively exclusive' },at).swarm)
          assigned = state.tasks.find(t => t.id === assignedId)
          if (!assigned) return { deny: 'SWARM / duplicate work suppressed; inspect swarm status' }
        }
        if (assigned.tier === 'OPUS' && !isSonnetLed()) return { deny: 'SWARM / OPUS task stays in commander; no coordinator subagent' }
        if (assigned.tier === 'OPUS') {
          if (!(await read($, ledgerAtom)).consults?.some(c => c.id === assigned!.id)) return { deny: 'OPUS / NOT ADMITTED. An OPUS task runs only as an admitted consultation; request one with swarm action "consult". Nothing was started.' }
          if (role !== 'ARCHITECT') return { deny: 'OPUS / an admitted consultation runs as cobalt-cockpit:architect (read-only) and nothing else. Nothing was started.' }
        } else if (role === 'ARCHITECT' && isSonnetLed()) return { deny: 'OPUS / the architect runs only for an admitted consultation; its task must come from swarm action "consult". Nothing was started.' }
        let admission: ReturnType<typeof admitTask> | undefined
        await changeSwarm($, held => { admission = admitTask(held,assignedId!,at); return admission.swarm })
        if (!admission!.ok) return { deny: `SWARM / queued ${assignedId}: ${admission!.reason}; retry after dependency/ownership/resource clears` }
        reservedId = assignedId
      }
      const model = config.hasOrchestration ? (assigned?.tier === 'HAIKU' ? HAIKU_MODEL : assigned?.tier === 'OPUS' && isSonnetLed() ? OPUS_MODEL : AGENT_MODEL) : e.model
      const originLedger = await read($, ledgerAtom)
      const spawnAt = await $.clock.now()
      // The launch level is on the task before the subagent exists: its first
      // request can arrive before the spawn below has returned and bound it.
      if (reservedId) await changeSwarm($, held => setLaunchEffort(held, reservedId!, launch?.level ?? null, launch?.named ?? null))
      const spawned = model === undefined || model === e.model
        ? await next(e)
        : await next({ ...e, model })
      if (reservedId && spawned.agentId) await changeSwarm($, held => bindAgent(held,reservedId!,spawned.agentId!,spawnAt))
      else if (reservedId) await changeSwarm($, held => setLaunchEffort(releaseReservation(held,reservedId!,spawnAt,spawned.deny ?? 'Host did not report agent ID'), reservedId!, null))
      await quiet(() => ledgerSpawn($, e, spawned, originLedger, spawnAt))
      if (reservedId && spawned.agentId) await mutateLedger($, l => { const done = l.observedCompletions?.find(c=>c.agentId===spawned.agentId); return done ? { ...finishTurn(l,{ turnId:l.turns[spawned.agentId!] ?? UNKNOWN,agentId:spawned.agentId!,reason:done.reason },done.at), swarm:finishObserved(swarmState(l),reservedId!,done.reason,done.conclusion,done.at) } : l })
      if (spawned.agentId) {
        spawning.set(token, spawned.agentId)
        await quiet(async () => {
          const now = await $.clock.now()
          const seq = (await update($, orchestraAtom, old => ({ ...old, spawned: old.spawned + 1 }))).spawned
          const ledgerAgent = (await read($, ledgerAtom)).agents.find(a => a.id === spawned.agentId)
          const agent: AgentStrip = { parentRun: ledgerAgent?.runId, originTurn: ledgerAgent?.originTurn, toolCount: 0, id: spawned.agentId!, title: oneLine(e.description || e.subagentType, 60), model: spawned.model ?? null, effort: null, tool: ledgerAgent?.status === 'success' ? 'Done' : ledgerAgent && ledgerAgent.status !== 'running' ? 'Failed' : 'Starting', state: ledgerAgent?.status === 'success' ? 'done' : ledgerAgent && ledgerAgent.status !== 'running' ? 'error' : 'running', startedAt: now, endedAt: typeof ledgerAgent?.end === 'number' ? ledgerAgent.end : null, role: assigned?.role ?? role, seq }
          await update($, visualAtom, old => ({ ...old, agents: [...old.agents.filter(a => a.id !== agent.id), agent].filter((a,i,all)=>a.endedAt === null || i >= all.length - 32) }))
        })
      }

      return spawned
    } catch (error) {
      if (reservedId) { const at = await $.clock.now(); await changeSwarm($, held => { const t = held.tasks.find(t=>t.id===reservedId); return t?.state === 'reserved' && !t.agentId ? setLaunchEffort(releaseReservation(held,reservedId!,at,'Host spawn failed'), reservedId!, null) : held }) }
      throw error
    } finally {
      spawning.delete(token)
    }
  }).catch(($, e, next) => next.called ? next(e) : { deny: 'COCKPIT / the agent-admission guard failed, so no subagent started. Nothing was sent; reload the plugin before retrying.' })

  on('turn.step', async function* ($, e, next) {
    // The one place every model request passes, main's and a subagent's, with
    // the model the engine resolved for it (the session's, an alias's target, a
    // fallback's). Answering without `next` sends nothing, so a request that
    // names Fable, or would carry Fable as its advisor, is never made: the
    // refusal is the response, and there is no request to reject afterward.
    if (config.blocksFable && (isFable(e.model) || isAdvisorFable)) {
      await recordBlock($)
      yield { kind: 'text', index: 0, text: BLOCK_LINE }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }

      return { turnId: e.turnId, index: e.index, answer: BLOCK_LINE, toolUses: [], stopReason: 'end_turn', usage: null }
    }
    // The same for a session that is not on the subscription.
    if (await isApiRefused($).catch(() => false)) {
      const text = 'AUTH / API DETECTED'
      yield { kind: 'text', index: 0, text }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }

      return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
    }
    if (config.isStrict && hasAdvisor) return { turnId: e.turnId, index: e.index, answer: 'COBALT STRICT / external advisor disabled.', toolUses: [], stopReason: 'end_turn', usage: null }
    // Every reading below is quiet: a hook that fails before `next` is skipped,
    // which for this one would send a request the policy exists to refuse.
    const agentId = e.agentId
    const task = agentId === undefined ? undefined : await quietly(() => taskOfAgent($, agentId))
    if (config.hasOrchestration && task?.cancellationRequested) {
      const text = 'SWARM / cancellation requested'
      yield { kind: 'text', index: 0, text }; yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index:e.index, answer:text, toolUses:[], stopReason:'end_turn', usage:null }
    }
    if (task && config.hasOrchestration) {
      const id = task.id
      await quiet(async () => { const at = await $.clock.now(); await changeSwarm($, held => heartbeat(held,id,at)) })
    }
    // The tier is the policy's. OPUS_LED: Opus commands, Sonnet engineers, Haiku
    // scouts. SONNET_LED: Sonnet leads and builds, Haiku scouts, and Opus runs
    // only as an admitted consultation's subagent. The model id follows from the
    // tier; the effort below is resolved separately, so two agents side by side
    // can run at different levels without a global move.
    const tier: ModelTier = !e.agentId ? (isSonnetLed() ? 'SONNET' : 'OPUS') : (task?.tier ?? (tierOf(e.model) === 'HAIKU' ? 'HAIKU' : 'SONNET'))
    const subTier: SubagentTier = tier === 'HAIKU' ? 'HAIKU' : tier === 'OPUS' && e.agentId !== undefined && isSonnetLed() ? 'OPUS' : 'SONNET'
    const wanted = desiredRequest(e.agentId, subTier, config.profile)
    const isMain = e.agentId === undefined
    let constrained = e
    let mismatch: string | null = null
    let resolution: EffortResolution | null = null
    // The level this loop's Agent call was launched with, when one was set
    // natively. The engine has then already resolved the request's effort from
    // it, under its own caps and overrides: that level is read, not rewritten.
    const launched = config.hasOrchestration && isEffortLevel(task?.launchEffort) ? task.launchEffort : null
    let hostReason: string | null = null
    if (config.hasOrchestration && isMain) {
      // The profile's model leads; how hard it thinks is the person's to say. A rewrite here
      // would outrank `/effort`, `--effort`, the settings and the variable
      // alike, so the main loop's effort is left exactly as the engine resolved it.
      constrained = { ...e, model: wanted.model }
      mismatch = policyMismatch(e.model, e.effort, e.agentId, subTier, config.profile)
    } else if (config.hasOrchestration) {
      const facts: EffortFacts = { tier, ...(task ? factsFromRole(task.role, task.mode) : {}) }
      // An explicit level on the task is the commander's, and wins; otherwise
      // AUTO names one from the task and MANUAL honours the fixed tier level.
      const named = task !== undefined && task.requestedEffort !== 'AUTO' ? task.requestedEffort : null
      const known = await quietly(() => read($, effortKnownAtom))
      const capability = capabilityOf(wanted.model, known ?? {})
      const manual = config.reasoningMode === 'MANUAL' && named === null
      // A subagent no task is known for yet, on an engine that takes the level
      // on the Agent call: its request already carries what it was launched
      // with, and the tier's baseline must not be written over that.
      const isUnknown = hasNativeEffort && task === undefined
      if (isUnknown || (manual && !isEffortLevel(wanted.effort))) {
        // MANUAL names no level for this tier (Haiku): leave the engine's own in place.
        constrained = { ...e, model: wanted.model }
      } else {
        const requested: EffortRequest = manual ? wanted.effort as EffortLevel : named ?? 'AUTO'
        resolution = chooseEffort(requested, facts, capability, config.maxEffort)
        constrained = launched !== null ? { ...e, model: wanted.model } : { ...e, model: wanted.model, ...(resolution.applied === undefined ? {} : { effort: resolution.applied }) }
        if (launched !== null) hostReason = launchFallback(resolution, launched, e.effort, wanted.model)
      }
      // a natively launched loop's level is judged against its launch above, not against the fixed tier level
      mismatch = policyMismatch(e.model, launched === null && !isUnknown ? e.effort : wanted.effort, e.agentId, subTier, config.profile)
      const applied = launched !== null ? (e.effort === undefined ? null : String(e.effort)) : resolution?.applied
      // The engine's own resolution of a level this plugin launched with is a
      // real observation: learned from, and said aloud when it differs.
      if (task && applied !== undefined && task.appliedEffort !== applied) {
        await quiet(() => changeSwarm($, held => setAppliedEffort(held, task.id, applied)))
        if (launched !== null && isEffortLevel(e.effort)) { const level = e.effort; await quiet(() => update($, effortKnownAtom, known => observeCapability(known, wanted.model, launched, level))) }
      }
      if (launched !== null && e.effort !== launched) {
        const said = `EFFORT FALLBACK / engine applied ${applied ?? 'no effort'}; requested ${launched}`
        await quiet(() => mutateLedger($, l => l.warnings.includes(said) ? l : warn(l, said)))
      }
    }
    // The main loop's level is the host's, with what can be seen of where it
    // came from. A request moved to another model is resolved again by the
    // engine for that model, so the level it arrived with says nothing certain.
    const host = isMain ? hostEffort(e.effort, await hostSignals($, e.turnId, e.model)) : null
    const isMoved = isMain && constrained.model !== e.model
    const mainReason = host === null ? undefined : isMoved ? `host-resolved ${e.effort === undefined ? 'no effort' : String(e.effort)} for ${e.model}; moved to ${constrained.model}, which the engine resolves again` : host.reason
    if (host !== null && host.selected !== null && host.selected !== e.effort) {
      const said = `EFFORT FALLBACK / engine applied ${String(e.effort)}; requested ${host.selected}`
      await quiet(() => mutateLedger($, l => l.warnings.includes(said) ? l : warn(l, said)))
    }
    // Who put the effort on this request: the engine, or this hook's rewrite.
    const via = constrained.effort === e.effort && !isMoved ? 'host' as const : 'hook' as const
    sentVia.set(e.agentId ?? 'main', via)
    if (e.agentId) await quiet(() => editAgent($, e.agentId!, a => ({ ...a, model: constrained.model, effort: constrained.effort === undefined ? null : String(constrained.effort) })))
    // the main loop's effort, as the engine resolved it for this request
    else if (isSupported) await quiet(() => setMeter($, { model: constrained.model, effort: e.effort === undefined ? null : String(e.effort), reasoningMode: config.reasoningMode, effortSource: e.effort === undefined ? null : 'engine', requestedEffort: host?.selected ?? (e.effort === undefined ? null : String(e.effort)), effortReason: mainReason ?? null, hostSource: host?.source ?? null }))
    const result = yield* next(constrained)
    const asked = host !== null ? { ...e, effort: host.selected ?? e.effort } : resolution === null ? e : { ...e, effort: resolution.selected }
    await quiet(() => ledgerRequest($, asked, { model: constrained.model, effort: constrained.effort, usage: result.usage, routingReason: host !== null ? mainReason : resolution?.reason, fallbackReason: host !== null ? host.capReason : launched === null ? resolution?.fallbackReason : hostReason, via }, mismatch))
    if (result.usage && result.usage.model !== constrained.model) await quiet(() => mutateLedger($, l => warn(l, `MODEL POLICY / response mismatch: ${result.usage!.model}`)))
    // What answered is read off the response itself. With the refusal above it
    // is never Fable; if it ever were, the count says so.
    const answeredBy = result.usage?.model
    if (isFable(answeredBy)) await quiet(() => update($, policyAtom, old => answered(old, answeredBy)))

    return result
  })

  on('config.set', async ($, e, next) => {
    // A config row that chooses a model (the session's, the advisor's, a
    // fallback's) is not set to Fable. The rows that deny models are left alone.
    if (config.isStrict && /advisor/i.test(e.key) && e.value) return { deny: 'COBALT STRICT / external advisor disabled.' }
    const names = typeof e.value === 'string' ? [e.value] : Array.isArray(e.value) ? e.value : []
    if (config.blocksFable && /model|advisor/i.test(e.key) && !/denied|blocked/i.test(e.key) && names.some(isFable)) {
      await recordBlock($)

      return { deny: BLOCK_LINE }
    }

    return next(e)
  }).catch(($, e, next) => {
    // The row this handler was given is judged by the rule this hook holds, so
    // an ordinary row is written and only the rows it would have refused are not.
    if (next.called) return next(e)
    const names = typeof e.value === 'string' ? [e.value] : Array.isArray(e.value) ? e.value : []
    if (config.blocksFable && /model|advisor/i.test(e.key) && !/denied|blocked/i.test(e.key) && names.some(isFable)) return { deny: 'COBALT / the model-configuration guard failed, so the row was left as it was.' }
    if (config.isStrict && /advisor/i.test(e.key) && e.value) return { deny: 'COBALT STRICT / the advisor guard failed, so the row was left as it was.' }

    return next(e)
  })

  on('command.run', { command: 'model' }, async ($, e, next) => {
    const refused = await guardModelCommand($, e.args)
    if (refused !== null) return refused

    return next(e)
  }).catch(($, e, next) => {
    // Only a command line that names Fable is refused; anything else runs.
    if (next.called || !config.blocksFable || !e.args.split(/[\s=,]+/).some(isFable)) return next(e)

    return { text: `${BLOCK_LINE}. The model guard failed, so nothing was changed.` }
  })

  on('command.run', { command: 'effort' }, async ($, e, next) => {
    // The person's own choice for the session, and all of it a plugin can see:
    // the level as typed. It is only noted, to name where the main loop's level
    // came from; the command runs as it was given. A choice made in the picker
    // (no argument) is not visible, and nothing is noted for it.
    const ran = await next(e)
    const typed = e.args.trim().split(/\s+/)[0] ?? ''
    effortCommand = typed === '' ? null : typed.toLowerCase()
    hostSignalsAt = null

    return ran
  }).catch(($, e, next) => {
    // It only notes what was typed: the command runs either way.
    return next(e)
  })

  on('command.run', { command: 'advisor' }, async ($, e, next) => {
    if (config.isStrict && e.args.trim() && !/^(off|none|disable)$/i.test(e.args.trim())) return { text: 'COBALT STRICT / external advisor disabled.' }
    const refusal = await guardModelCommand($, e.args)
    if (refusal !== null) return refusal
    const ran = await next(e)
    // the picker may have changed the advisor: read the settings again
    await quiet(() => probeAuth($, true))

    return ran
  }).catch(($, e, next) => {
    // The two refusals this hook makes, judged on the command it was given: a
    // line that names Fable, and the strict preset's advisor change.
    if (next.called) return next(e)
    if (config.blocksFable && e.args.split(/[\s=,]+/).some(isFable)) return { text: `${BLOCK_LINE}. The advisor guard failed, so nothing was changed.` }
    if (!config.isStrict || e.args.trim() === '' || /^(off|none|disable)$/i.test(e.args.trim())) return next(e)

    return { text: 'COBALT STRICT / the advisor guard failed, so nothing was changed.' }
  })

  on('command.run', { command: 'login' }, async ($, e, next) => {
    const ran = await next(e)
    await quiet(() => probeAuth($, true))

    return ran
  }).catch(($, e, next) => {
    // It only re-reads the authentication: the command runs either way.
    return next(e)
  })

  on('command.run', { command: 'logout' }, async ($, e, next) => {
    const ran = await next(e)
    await quiet(() => probeAuth($, true))

    return ran
  }).catch(($, e, next) => {
    // It only re-reads the authentication: the command runs either way.
    return next(e)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    // The engine reports the level its own settings resolve for the loop. A
    // level this plugin rewrote onto the request in `turn.step` is not in that
    // report, so for such a loop it is neither recorded as applied, nor warned
    // about as a downgrade, nor learned from: it says nothing about the request.
    let via = sentVia.get(e.agent_id ?? 'main')
    if (isSupported && via === undefined) await quiet(async () => {
      const before = await read($, ledgerAtom)
      via = e.agent_id === undefined ? before.runs.find(r => r.id === before.currentRun)?.effortVia : before.agents.find(a => a.id === e.agent_id)?.effortVia
    })
    const level = via === 'hook' ? undefined : e.effort?.level
    if (isSupported) await quiet(async () => {
      await mutateLedger($, l => classicTelemetry(l, e, via))
      if (level !== undefined) {
        // What the engine really applied this turn, next to what this request
        // asked for: when they differ the request was downgraded, and the fact
        // is recorded and folded into the model's observed capability.
        const held = await read($, ledgerAtom)
        const agent = e.agent_id === undefined ? undefined : held.agents.find(a => a.id === e.agent_id)
        const run = held.runs.find(r => r.id === held.currentRun)
        // `classicTelemetry` has already replaced `effort` with the engine's
        // applied level, so the comparison this warning exists for must be made
        // against what this plugin *requested* (`requestedEffort`), not against
        // the value that was just overwritten. Otherwise `expected` would always
        // equal `level` and neither the fallback nor the observation could fire.
        const expected = e.agent_id === undefined ? run?.requestedEffort : agent?.requestedEffort
        const observed = e.agent_id === undefined ? run?.model : agent?.model
        if (agent !== undefined) await editAgent($, e.agent_id!, a => ({ ...a, effort: level }))
        if (expected !== undefined && expected !== UNKNOWN && expected !== level) await mutateLedger($, l => warn(l, `EFFORT FALLBACK / engine applied ${level}; requested ${expected}`))
        // The main loop's requested level is the person's own selection: a lower
        // applied level there is a cap of the host's, not something the model cannot do.
        if (observed !== undefined && observed !== UNKNOWN && isEffortLevel(expected) && isEffortLevel(level) && (e.agent_id !== undefined || expected === level)) await update($, effortKnownAtom, known => observeCapability(known, observed, expected, level))
      }
      await persist($)
    })
    if (isSupported && e.agent_id === undefined && level !== undefined && level !== lastEffort) {
      lastEffort = level
      await quiet(() => setMeter($, { effort: level }))
    }

    return next(e)
  }).catch(($, e, next) => {
    // A reading of what the engine reported, not a gate: the tool call already
    // ran, and nothing about it is undone here.
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (isSupported) await ledgerMeasure($)
    if (isSupported) {
      await quiet(() =>
        setMeter($, { percent: e.context.percent ?? null, tokens: e.context.tokens ?? null, window: e.context.window }),
      )
    }

    return next(e)
  })

  on('attribution.text', async ($, e, next) => {
    // the trailer and footer the engine would have Claude write into commits and PRs
    if (config.hasAttributionGuard && (e.kind === 'commit' || e.kind === 'pr')) return { text: '' }

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!isSupported || e.traits.includes('bare')) return composed
    const text = `${DISCIPLINE}${config.hasAttributionGuard ? HYGIENE : ''}${config.hasGuard ? SAFETY : ''}${config.hasOrchestration ? orchestrationText(config.maxSubagents, config.profile) + effortPolicyText(config.reasoningMode, config.maxEffort, config.profile) : ''}${config.blocksFable ? `\n\n${FABLE_RULE}` : ''}`

    return { sections: [...composed.sections, { id: 'cobalt-cockpit:discipline', text, scope: 'session' }] }
  })

  on('command.run', { command: 'cockpit' }, async ($, e) => {
    const [verb = '', value = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const savePrefs = async (patch: Partial<Prefs>): Promise<Prefs> => {
      const prefs = await update($, prefsAtom, old => ({ ...old, ...patch }))
      await quiet(() => $.store.set('prefs', prefs))

      return prefs
    }
    switch (verb) {
      case '':
      case 'open': {
        const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
        if (isOpen && verb === '') {
          await $.ui.close({ id: PANE })

          return {}
        }
        const opened = await $.ui.open({ id: PANE, title: `${OPERATOR} // Mission Control` })

        return opened.isPlaced ? {} : { text: `Cockpit is waiting to be placed: ${opened.reason}` }
      }
      case 'close':
        await $.ui.close({ id: PANE })

        return {}
      case 'status':
        return { text: summaryOf(await read($, taskAtom)) }
      case 'reset':
        await update($, taskAtom, () => null)

        return { text: 'Cockpit: task cleared.' }
      case 'mute':
      case 'unmute':
        await savePrefs({ isMuted: verb === 'mute' })

        return { text: verb === 'mute' ? 'Cockpit: cues muted.' : 'Cockpit: cues on.' }
      case 'hud': {
        const held = await read($, prefsAtom)
        const isHudHidden = value === 'off' ? true : value === 'on' ? false : !held.isHudHidden
        await savePrefs({ isHudHidden })

        return { text: isHudHidden ? 'Cockpit: HUD hidden.' : 'Cockpit: HUD shown.' }
      }
      case 'version':
      case 'source': {
        // What is really loaded, and where from: the manifest on disk, not a
        // version this module remembers. A stale install and a live source tree
        // are told apart by the path, which is the failure this diagnostic exists
        // for. The observed effort capability is printed only when one was seen.
        let version: string = UNKNOWN
        try { version = /"version"\s*:\s*"([^"]+)"/.exec(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))?.[1] ?? UNKNOWN } catch { /* manifest unreadable: version stays unknown */ }
        const observed = Object.entries(await read($, effortKnownAtom))
        const model = await $.session.model().catch(() => '')
        const meter = await read($, meterAtom)
        // What AUTO would name for the commander is advice only, and only when
        // no selection of the person's was seen: the level stays the host's.
        const advised = config.hasOrchestration && config.reasoningMode === 'AUTO' && meter.hostSource === 'host'
          ? chooseEffort('AUTO', { tier: isSonnetLed() ? 'SONNET' : 'OPUS' }, capabilityOf(isSonnetLed() ? AGENT_MODEL : MAIN_MODEL, Object.fromEntries(observed)), config.maxEffort).applied
          : undefined

        return {
          text: [
            `PLUGIN / ${$.plugin.name} ${version}`,
            `SOURCE / ${$.plugin.root}`,
            `SESSION MODEL / ${model === '' ? UNKNOWN : model}`,
            ...(config.hasOrchestration ? [`PROFILE / ${config.profile}${isSonnetLed() ? ` · main ${AGENT_MODEL} · Opus on admission · budget ${config.maxSubagents} (Sonnet ${String(config.maxSonnet)} · Haiku ${String(config.maxHaiku)} · Opus 1) · NobodyWho advice ${config.hasLocalAdvice ? 'on' : 'off'}` : ` · main ${MAIN_MODEL}`}`] : []),
            `REASONING / ${config.reasoningMode} · ceiling ${config.maxEffort.toUpperCase()}`,
            // the main loop's level is the host's: read, with what was seen of its origin
            `MAIN EFFORT / host-resolved, never rewritten${meter.effort ? ` · ${meter.effort}${meter.hostSource ? ` (${meter.hostSource})` : ''}` : ''}${advised !== undefined && meter.effort && advised !== meter.effort ? ` · AUTO would name ${advised}: /effort ${advised} to set it` : ''}`,
            // how a subagent's level reaches the engine, and whether the engine's reports can confirm it
            ...(config.hasOrchestration ? [`SUBAGENT EFFORT / ${hasNativeEffort ? 'set on the Agent call · engine-resolved level recorded' : 'turn.step rewrite · the engine does not report it back'}`] : []),
            ...(observed.length ? [`OBSERVED EFFORT / ${observed.map(([id, levels]) => `${id} ${[...levels].join('/')}`).join(' · ')}`] : []),
          ].join('\n'),
        }
      }
      case 'auth': {
        await quiet(() => probeAuth($, false))
        const auth = await read($, authAtom)
        const policy = await read($, policyAtom)

        return {
          text: [
            ...(auth === null ? ['AUTH / NOT READ'] : authLines(auth, config.blocksFable)),
            ...(auth?.mode === 'api' ? [...(auth.credential === 'api-key' ? ['SOURCE / engine holds an API key'] : []), ...auth.sources.map(source => `SOURCE / ${source}`)] : []),
            `FABLE CALLS / ${policy.calls}`,
            ...(policy.blocks > 0 ? [`FABLE REFUSED / ${policy.blocks}`] : []),
          ].join('\n'),
        }
      }
      case 'sound': {
        if (!config.hasSounds) return { text: 'Cockpit: sounds are off in the plugin configuration.' }
        if ((await read($, prefsAtom)).isMuted) return { text: 'Cockpit: cues are muted (/cockpit unmute).' }
        const first = await sound($, 'checkpoint')
        await $.clock.sleep(350).catch(() => undefined)
        await sound($, 'complete')

        return { text: first === null ? 'Cockpit: no audio player answered; cues are silent.' : `Cockpit: played both cues with ${first}.` }
      }
      default:
        return { text: HELP }
    }
  }).catch(($, e, next) => next.called ? next(e) : { text: 'Cobalt: the cockpit command could not be read; nothing was changed.' })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!isSupported || !config.hasHud || e.props.hasSurvey || (await read($, prefsAtom)).isHudHidden || e.props.maxRows < 1) {
      band = null
      stopTicker()
      return next(e)
    }
    const input = await hudInput($, e.props.isWorking)
    const session = await read($, visualAtom)
    const now = await $.clock.now()
    const v = visualOf(input, session.waiting > 0 || (await read($, guardsAtom)).length > 0)
    const motion = config.isAnimated && !reducedMotion
    const layout = layoutOf(e.props.bodyColumns, v.percentText)
    const id = `${input.task?.id ?? 0}/${input.task?.lifecycle ?? 0}`
    const glide = transition(head?.id === id ? head.glide : null, v.percent / 100, now, motion && v.active)
    head = { id, glide }
    const { Box, Text } = $.ui.resolve(e)
    const t = $.ui.resolve(e)
    const Raster = 'Raster' in t ? t.Raster : null
    const Svg = 'Svg' in t ? t.Svg : null
    const room = Math.max(0, e.props.maxRows - 1 - (layout.columns >= 44 ? 1 : 0))
    // The orchestration line sits above the strips and is paid for out of their
    // rows, so the band is never taller for it; with one row to spare the strips
    // keep it and the line is left out.
    const crew = visibleAgents(session.agents, now, session.agents.length).shown
    const hasCrew = config.hasOrchestration && room >= 2 && crew.some(hasRole)
    const stripRoom = hasCrew ? room - 1 : room
    let agents = visibleAgents(session.agents, now, Math.min(3, stripRoom))
    if (agents.folded && stripRoom > 1) agents = visibleAgents(session.agents, now, Math.min(2, stripRoom - 1))
    const crewView: OrchestraView = { meter: input.meter, task: input.task, activity: input.activity, isWorking: e.props.isWorking, agents: crew, nwho: null, limit: config.maxSubagents, now, ...(isSonnetLed() ? { profile: 'SONNET_LED' as const } : {}) }
    const crewLine = hasCrew && agents.shown.length > 0 ? headerText(crewView, layout.columns) : ''
    // API-style authentication is the one diagnostic that stays on screen: it
    // is a warning, and it is only ever there when it is true.
    const auth = await read($, authAtom)
    const authWarning = auth?.mode === 'api' && layout.columns >= 20 ? fitText('AUTH / API DETECTED', layout.columns) : ''
    // VECTOR, in whichever form this surface can carry: a portrait where SVG
    // exists, three cells of visor on a terminal, one glyph in a narrow band.
    // The badge is static per state, so it never enters the blit loop.
    let badge: RenderElement | null = null
    if (layout.badgeWidth >= 3) {
      if (e.surface === 'terminal' && Raster) badge = <Raster key="operator" columns={3} rows={1} cells={mascotGrid(v.state).encode()} />
      else if (Svg) badge = <Svg key="operator" source={mascotSvg(v.state, motion)} alt={mascotAlt(v.state)} width={PANEL_W} height={PANEL_H} />
      else badge = <Text key="operator" color={STATE_COLOR[v.state]} bold>{MICRO[v.state]}</Text>
    } else if (layout.badgeWidth === 1) {
      badge = <Text key="operator" color={STATE_COLOR[v.state]} bold>{MICRO[v.state]}</Text>
    }
    // one column of air between the operator and whatever sits beside it
    const gutter = badge === null ? null : <Text> </Text>
    const title = fitText(input.task?.goal || input.git?.project || OPERATOR, Math.max(0, layout.titleWidth - 2))
    const trackWidth = layout.trackWidth
    // The crawler rides the track. On a terminal it is painted into the track's
    // own cells; on the desktop it is the SVG layer above the rail. Either way
    // it never covers the stage, the percentage or the milestones, and it only
    // travels as far as the real progress allows.
    const crawler = await crawlerOf($, input, v, session.waiting > 0 || (await read($, guardsAtom)).length > 0)
    const waiting = crawler.crawler.state === 'query'
    const crawlerMotion: Motion = { now, reducedMotion }
    // The real head on the track, which is where the crawler may travel to.
    const headAt = positionAt(glide, now)
    const layer = layerFor(crawler.crawler, crawler.newest)
    const track = trackGrid(input, v, trackWidth, { head: headAt, now, motion, light: isLight })
    if (crawlerForm(trackWidth) === 'body') paintCrawler(track, { ...crawler.crawler, progress: headAt }, crawlerMotion, layer)
    const cells = track.encode()
    const secondary = secondaryText(input, layout.columns)
    // The Activity Field: a bounded tape of real activity above the HUD, and the
    // surface the crawler walks through. The crawler state is the existing one,
    // derived from what the host really reported, so the field and the rail can
    // never disagree about what is happening.
    const control = await read($, controlAtom)
    const runLedger = await read($, ledgerAtom)
    const graph: Graph | null = orchestrationGraph(runLedger, now) ?? graphOf(control.lastPrune, control.lastDecision)
    const tape = orchestrationTape(runLedger, e.props.bodyColumns, now) ?? tapeOf(liveOf(await read($, eventsAtom), now), e.props.bodyColumns)
    const fieldRowsWanted = fieldRowsOf(tape, graph, now, EVENT_TTL_MS)
    const fieldMotion = { now, reducedMotion }
    const walker = advance(fieldWalker, tape, crawler.crawler.state, fieldMotion)
    // The walker is module state rather than `$.state`: it is animation, not
    // fact, so a hot reload restarts it at whatever the real tape says rather
    // than restoring a position nothing observed.
    fieldWalker = walker
    const fieldRowsOut = fieldRows(tape, walker, crawler.crawler.state, e.props.bodyColumns)
    // The field as elements, for whichever surface is drawing. A terminal paints
    // it into a Raster the ticker can blit, a desktop draws it as SVG, and
    // anything else falls back to the same reading as styled text. With no real
    // events there is nothing to draw and no row is spent on it at all.
    const fieldColumns = e.props.bodyColumns
    const fieldCells = fieldGrid(tape, walker, crawler.crawler.state, fieldColumns, fieldRowsWanted).encode()
    const fieldVector = fieldSvg(tape, walker, crawler.crawler.state, graph, fieldColumns * 8, 14, now, EVENT_TTL_MS)
    const fieldText = fieldRowsOut.map((row, at) => (
      <Text key={`field-${at}`} wrap="truncate-end">
        {row.map((segment, n) => (
          <Text key={`field-${at}-${n}`} {...styleOf(segment)}>{segment.text}</Text>
        ))}
      </Text>
    ))
    const field = tape.anchors.length === 0 || fieldRowsWanted < 1
      ? null
      : e.surface === 'terminal' && Raster
        ? <Raster key={FIELD_KEY} columns={fieldColumns} rows={Math.min(2, fieldRowsWanted)} cells={fieldCells} />
        : Svg
          ? <Svg key={FIELD_KEY} source={fieldVector.svg} alt={fieldVector.alt} width={fieldColumns * 8} height={14} />
          : fieldText
    // NobodyWho, only while a real receipt is fresh. An empty list draws no row,
    // so a session with no receipts looks exactly as it always did.
    const flashRows = stripRows(await read($, flashAtom), now, layout.columns, reducedMotion)
    // The initialization line, shown only while it is genuinely still running.
    // Claude's own mascot is left untouched above it: there is no supported way
    // to replace it, and none is attempted here.
    const startup = startupOf(await read($, startupAtom), false)
    const resumed = await resumeLine($)
    const modelWarning = runLedger.warnings.at(-1) ?? null
    const startupRows: Row[] = startup.active && layout.columns >= 44 ? [[{ text: startup.line, color: COLORS.steel, isBold: true }]] : []
    let rail: RenderElement
    if (e.surface === 'terminal' && Raster) {
      const lastCells = new Map([[TRACK_KEY, cells]])
      // The field's own Raster is blitted from the same loop, so the crawler
      // keeps walking the tape between full redraws.
      if (field !== null) lastCells.set(FIELD_KEY, fieldCells)
      band = { requestId: e.requestId, width: trackWidth, input, visual: v, agents: agents.shown, glide, motion, lastCells, waiting, field: field === null ? null : { tape, state: crawler.crawler.state, rows: Math.min(2, fieldRowsWanted), width: fieldColumns, graph } }
      rail = <Raster key={TRACK_KEY} columns={trackWidth} rows={1} cells={cells} />
      startTicker($)
      if (!v.active && !agents.shown.some(a => a.state === 'running') && field === null) stopTicker()
    } else if (Svg) {
      band = null
      stopTicker()
      const width = trackWidth * TRACK_W
      const signature = JSON.stringify([input.task, v, width, motion])
      let cached = svgCache.get(id)
      if (cached?.signature !== signature) {
        cached = { signature, ...trackSvg(input, v, width, glide.from, motion) }
        svgCache.clear()
        svgCache.set(id, cached)
      }
      // The crawler's own SVG sits over the rail and is not interactive, so it
      // can never steal a hover from the stage checkpoints underneath it.
      const drawn = crawlerForm(trackWidth) === 'none' ? null : crawlerSvg({ ...crawler.crawler, progress: headAt }, { x: 0, y: 0, width, height: TRACK_H }, crawlerMotion, layer)
      rail = <Box width={width} height={TRACK_H}>
        <Svg key={TRACK_KEY} source={cached.base} alt={`${v.stage} ${v.percentText} ${STATE_LABEL[v.state]}`} width={width} height={TRACK_H} />
        <Box position="absolute" top={0} left={0}><Svg key="progress-hover" source={cached.overlay} alt="Stage and step checkpoints" width={width} height={TRACK_H} isInteractive /></Box>
        {drawn === null ? null : <Box position="absolute" top={0} left={0}><Svg key="crawler" source={drawn.svg} alt={drawn.alt} width={width} height={TRACK_H} /></Box>}
      </Box>
    } else {
      // A surface with neither Raster nor Svg: the same reading, as rows of
      // text, laid out by the same narrowing rules as everything else.
      band = null
      stopTicker()
      const rows = hudRows(input, layout.columns, e.props.maxRows)
      // `next(e)` first, then Cockpit's own rows. Every other plugin that draws
      // in this band composes the same way, and hooks run post-order with the
      // first plugin loaded outermost, so whichever of us is outer decides the
      // stack. Placing what we were given above our own rows means the reading
      // is the same either way round: whatever another plugin drew sits directly
      // above Cockpit's HUD, and neither plugin can suppress the other.
      const below = await next(e)

      return (
        <Box flexDirection="column">
          {below}
          {field}
          {rows.map((row, at) => (
            <Text key={`row-${at}`} wrap="truncate-end">
              {row.map(segment => (
                <Text {...styleOf(segment)}>{segment.text}</Text>
              ))}
            </Text>
          ))}
        </Box>
      )
    }
    // The same composition as the text path above: anything another plugin drew
    // in this band is kept, and sits above Cockpit's HUD rather than replacing
    // it. This is what lets a second AbovePrompt plugin (a pasted-image viewer,
    // say) coexist instead of one of the two quietly swallowing the other.
    const below = await next(e)

    return (
      <Box flexDirection="column">
        {below}
        {field}
        <Box flexDirection="row" alignItems="center">
          {badge}
          {gutter}
          {layout.titleWidth > 0 ? <Text wrap="truncate-end">{`${title}${' '.repeat(Math.max(0, layout.titleWidth - cellsOf(title)))}   `}</Text> : null}
          {rail}
          {layout.percentWidth > 0 ? <Text color={STATE_COLOR[v.state]}>{` ${v.percentText.slice(0, layout.percentWidth)}`}</Text> : null}
        </Box>
        {secondary && e.props.maxRows > 1 ? <Text dimColor wrap="truncate-end">{secondary}</Text> : null}
        {startupRows.map((row, at) => (
          <Text key={`startup-${at}`} wrap="truncate-end">
            {row.map((segment, n) => (
              <Text key={`startup-${at}-${n}`} {...styleOf(segment)}>{segment.text}</Text>
            ))}
          </Text>
        ))}
        {/* NobodyWho's one line, only while a real receipt is live. It costs a row
            only while there is something true to say, and is gone again after. */}
        {flashRows.map((row, at) => (
          <Text key={`nwho-${at}`} wrap="truncate-end">
            {row.map((segment, n) => (
              <Text key={`nwho-${at}-${n}`} {...styleOf(segment)}>{segment.text}</Text>
            ))}
          </Text>
        ))}
        {modelWarning ? <Text key="model-warning" color={COLORS.warn} wrap="truncate-end">{modelWarning}</Text> : null}
        {resumed ? <Text key="resume" color={COLORS.accent} wrap="truncate-end">{resumed}</Text> : null}
        {authWarning !== '' ? <Text key="auth-warning" color={COLORS.warn} bold wrap="truncate-end">{authWarning}</Text> : null}
        {crewLine !== '' ? <Text key="crew" color={COLORS.steel} wrap="truncate-end">{crewLine}</Text> : null}
        {agents.shown.map(a => {
          const state = a.state === 'waiting' ? 'needs_input' : a.state
          if (e.surface === 'terminal' && Raster) return <Box key={`row-${a.id}`} marginLeft={layout.titleWidth ? layout.titleWidth + 3 : 0}><Raster key={`agent-${a.id}`} columns={trackWidth} rows={1} cells={stripGrid(a, trackWidth, now, isLight, motion).encode()} /></Box>
          if (Svg) {
            const signature = JSON.stringify([a, trackWidth, isLight, motion])
            let cached = agentSvgCache.get(a.id)
            if (cached?.signature !== signature) {
              cached = { signature, source: stripSvg(a, trackWidth * TRACK_W, now, isLight, motion) }
              agentSvgCache.set(a.id, cached)
              if (agentSvgCache.size > 32) {
                // the first key is the oldest: removed by name, so no identifier
                // called `next` sits inside a hook body, where it reads as a pass-through
                for (const oldest of agentSvgCache.keys()) { agentSvgCache.delete(oldest); break }
              }
            }
            return <Box key={`row-${a.id}`} marginLeft={layout.titleWidth ? layout.titleWidth + 3 : 0}><Svg key={`agent-${a.id}`} source={cached.source} alt={hasRole(a) ? roleStrip(a, trackWidth, now) : `${a.title} ${a.tool} ${state}`} width={trackWidth * TRACK_W} height={18} /></Box>
          }
          return <Text color={STATE_COLOR[state]} wrap="truncate-end">{hasRole(a) ? roleStrip(a, layout.columns, now) : fitText(a.title, layout.columns)}</Text>
        })}
        {agents.folded > 0 && room > agents.shown.length ? <Text dimColor>{`+${agents.folded} more agents`}</Text> : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const activity = await read($, activityAtom)
    const input = await hudInput($, activity.isWorking)
    const state = visualStateOf(input, (await read($, visualAtom)).waiting > 0)
    const surface = $.ui.resolve(e)
    const Svg = 'Svg' in surface ? surface.Svg : null
    const base = paneRows(input, Math.max(20, e.props.bodyColumns), await $.clock.now())
    // LOCAL CONTROL is appended only when this session really observed a
    // NobodyWho receipt. With none, `controlRows` returns nothing and the
    // dossier is byte-for-byte what it was before Local Control existed.
    const control = await read($, controlAtom)
    const width = Math.max(20, e.props.bodyColumns)
    // ORCHESTRATION: who is main, what NobodyWho last did if it did anything,
    // and every subagent the engine really spawned. AUTH: how the session is
    // authenticated and the Fable policy with its counted calls. Fable is named
    // here, in the detailed diagnostics, and nowhere on the HUD.
    const session = await read($, visualAtom)
    const paneNow = await $.clock.now()
    const newest = control.lastPrune !== null && (control.lastDecision === null || control.lastPrune.at >= control.lastDecision.at) ? control.lastPrune : control.lastDecision
    const paneLedger = await read($, ledgerAtom)
    const view: OrchestraView = {
      meter: input.meter,
      task: input.task,
      activity,
      isWorking: activity.isWorking,
      agents: session.agents,
      swarm: paneLedger.swarm,
      nwho: newest === null ? null : stripText(newest).replace(/^NWHO · /, ''),
      limit: config.maxSubagents,
      now: paneNow,
      ...(isSonnetLed() ? { profile: 'SONNET_LED' as const, consults: paneLedger.consults ?? [], usage: usageByTier(paneLedger.requests) } : {}),
    }
    const rows = [
      ...base,
      ...(seenAny(control) ? controlRows(control, width, COLORS.accent) : []),
      ...heading('10', 'ORCHESTRATION', width, COLORS.accent),
      ...orchestraRows(view, width, COLORS),
      ...heading('11', 'AUTH', width, COLORS.accent),
      ...authRows(await read($, authAtom), await read($, policyAtom), COLORS, config.blocksFable),
    ].map(row => fit(row, width))
    const line = (row: Row): RenderElement =>
      row.length === 0 ? (
        <Text> </Text>
      ) : (
        <Text wrap="truncate-end">
          {row.map(segment => (
            <Text {...styleOf(segment)}>{segment.text}</Text>
          ))}
        </Text>
      )
    return (
      <Box flexDirection="column">
        {/* The operator's portrait, where the surface can draw one. The words
            beside it are already in the banner below, so this is only the art. */}
        {Svg ? <Svg source={mascotSvg(state, config.isAnimated && !reducedMotion)} alt={mascotAlt(state)} width={PANEL_W} height={PANEL_H} /> : null}
        {rows.map(line)}
        <Box marginTop={1} gap={1}>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => Promise.all([refreshGit($), refreshMeter($)]).then(() => undefined)} />
          <Button key="close" label="Close" hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const dialog = await next(e)
    try {
      const asked = e.props.questions[0] as { question?: unknown; header?: unknown } | undefined
      if (asked?.header !== GUARD_HEADER) return dialog
      const request = (await read($, guardsAtom)).find(one => one.question === asked.question)
      if (request === undefined) return dialog
      const git = await read($, gitAtom)
      const columns = Math.max(20, (e.viewport?.columns ?? 80) - 4)
      const { Box, Text } = $.ui.resolve(e)
      const stake =
        git !== null && git.isRepo
          ? `${git.project} · ${git.isDetached ? 'detached HEAD' : (git.branch ?? 'no branch')} · ${
              git.dirty === 0 ? 'working tree clean' : `${git.dirty} uncommitted change${git.dirty === 1 ? '' : 's'} at stake`
            }`
          : ''

      return (
        <Box flexDirection="column">
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color={COLORS.bad}>
              BLAST RADIUS / HOLD{request.isSubagent ? '  · FROM SUBAGENT' : ''}
            </Text>
            <Text wrap="truncate-end">$ {oneLine(request.command, columns - 2)}</Text>
            {request.findings.map(finding => (
              <Text wrap="wrap">
                <Text color={COLORS.bad}> ▎✗ </Text>
                <Text bold>{finding.title}</Text>
                <Text dimColor> {finding.effect}</Text>
              </Text>
            ))}
            {stake !== '' && <Text dimColor>{stake}</Text>}
          </Box>
          {dialog}
        </Box>
      )
    } catch {
      return dialog
    }
  })
}
