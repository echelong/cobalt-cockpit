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
import { agentsText, shortResource, swarmHint, taskText } from './inspector'
import { readyText } from './readiness'
import { textOf } from './ledger'
import { atom, read, update } from 'claude-code'
import { desiredRequest, policyMismatch, AGENT_MODEL, HAIKU_MODEL, MAIN_MODEL, OPUS_MODEL, isProfile, DEFAULT_PROFILE } from './model-policy'
import type { SubagentTier, Profile } from './model-policy'
import { discoveryRows, guidanceFor, markGuided, needsAlignment, unpin, withDiscovery } from './discovery'
import { addConsult, advanceReview, briefOf, clearReview, consultVerdict, factsOf, hasReturned, isCandidate, isGround, promptOrigin, releaseDecision, revalidateRelease, withRelease, mandatoryGrounds, packetOf, promptGroundsOf, readScopeOf, requireReview, CONSULT_EFFORT, GROUNDS } from './consult'
import type { Consultation } from './consult'
import type { ReleaseOutcome, ReleaseRecord, AlertRecord } from '../types'
import { addDecision, adjudicate, adviceLine, answerOf, callsFor, carriesCredential, decisionOf, deterministicRoute, operatorNotice, readAnswers, routerArgv, routerLabel, routerLine, routerModeOf, routerStateOf, switchRouter, withDecision, AVAILABILITY_STATE, CALL_TIMEOUT_MS, EMPTY_ROUTER, PROVIDER, ROUTER_MODES } from './router'
import type { ActiveMode, RouterAnswer, RouterMode, RouterPolicy, RouterState } from './router'
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
import { addAgent, adoptAgent, beginTool, checkpointOf, classicTelemetry, decisionsMarkdown, migrateLedger, recordDiscovery, emptyLedger, exportJSON, finishTool, finishTurn, ledgerLines, originOf, reading, recordRequest, receipts, storageLedger, jsonBytes, startRun, UNKNOWN, warn, word, withReplay, usageByTier } from './ledger'
import type { Ledger } from './ledger'
import { replayTimeline, safeFile, STEP_BYTES } from './replay'

import type { Activity, ActivityLog, AgentStrip, AuthState, Credential, EffortLevel, EffortRequest, GitState, GuardFinding, GuardRequest, Meter, Prefs, ReasoningMode, Task, DiscoveryLevel } from '../types'
import { ASSETS, PLAYERS, PLAY_TIMEOUT_MS, clampVolume } from './audio'
import { EMPTY_TRANSPORT, added as addedTest, codeOf, confirm as confirmTest, linkOf, mayTest, mine as myTests, statusOf as transportStatus, testMessage, transportLines, validTransport } from './transport'
import type { TransportTest } from './transport'
import type { Player } from './audio'
import { EMPTY_LOG, EVENT_TTL_MS, callOf, closeOf, liveOf, push } from './activity'
import { activityOf, readBash } from './classify'
import { parseStatus, projectOf, filterCommands, activeFilter } from './git'
import { GIT_SAFE, commitEntries, BOUND_AS_KIB, BOUND_CPU_S, BOUND_ENV, BOUND_PROBE_CAPPED, BOUND_PROBE_CONTROL, BOUND_PROBE_GROUP, BOUND_PROBE_SET, BOUND_SLOTS, BOUND_TAG, FINGERPRINT_FILE_BYTES, FINGERPRINT_TOTAL_BYTES, GIT_BOUNDED, INSPECT_BSD, INSPECT_GNU, SOURCE_BYTES, boundScript, inspectedOf } from './git-integrity'
import type { CommitEntry, DiskEntry, Inspected, Kind, Measurement } from './git-integrity'
import { assessCommand } from './guard'
import { failClosed, guardFailure, isInsideFolder } from './guard-rules'
import {
  addedAttribution,
  attributionInCommand,
  findAttribution,
  instructionFilesWritten,
  isInstructionFile,
} from './hygiene'
import type { Attribution } from './hygiene'
import { redactSecrets } from './secrets'
import type { Observation } from './alerts'
import { exportOf, hudCountsOf, standingOf, isMigratedEpisode, legacyPlanOf, legacyPlanText, EMPTY_GUARD, ID_RE, OCC_PER_PROJECT, PROJECT_RE, ackKeyOf, ackOccurrence, ackedIdsOf, applyAcks, digestText, digestToast, excessAckKeys, excessOccKeys, excessSeenKeys, historyFrom, historyKeyOf, isRecording, occIdsOf, occKeyOf, pageIdsOf, pendingIdsOf, seenIdsOf, seenKeyOf, withSeen, episodesOf, inboxPages, inboxText, isAckedSince, noticedOf, occurrencesOf, validAlerts, withAck, closedOf, exhaustedBlocker, bounded as boundedAlerts, decide as decideAlert, deferredOf, digestOf, dueOf, episodeOf, guardConfigOf, guardText, hasWorkLeft, holdOf, isSettledQuietly, labelOf as guardLabel, lapsedOf, messageOf as alertMessage, pinLine, pinsOf, policyLines, remind, reminderOf } from './alerts'
import type { Facts, GuardConfig, GuardView, Open, PinLine } from './alerts'
import { LABEL_MEANING, LABEL_USAGE, calibrationOf, calibrationText, labelKeyOf, labelOfValue, labelOfWord, labelValueOf, labelledIdsOf, ledgerIdsOf, legacyIdsOf, observedOf, orphanLabelKeys, parseLabelKey, reviewText, simulationConfigOf } from './calibration'
import type { Reviewed } from './calibration'
import { isQuiet } from './quiet'
import { uidOf, attemptsOf, spentOf, boundedChecks, retainChecks, validChecks, configOf as stopConfigOf, hasChangeSummary, hasChanges, outputTail, migrateStopHold, verdictOf, compareTree, type CheckRecord, type StopConfig, type TreeVerdict } from './stopguard'
import { applyAction, clearHold, reclassifyChanged, markEdited, setGuardRequired, isGuardOwned, withdrawDone, holdTask, isGuardHeld, releaseHold, newTask, noteFailure, oneLine, progressNudge, checkedAt, reopenVerification, setGate, settle, stampGates, summaryOf, touchFile, treeMoved, treeUnmeasured, unmeasuredWhy, unqualifiedEvidence, hasUnboundPass, reportedGates, revokeTrustedCompletion } from './model'
import type { Cue, ProgressInput } from './model'
import { basename } from './shell'
import { agentInspection, readOnlyShell, rebuildGit, scopedGit, SCOPED_FORM } from './git-inspect'
import type { ScopedPin } from './git-inspect'
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
import { API_REFUSAL, AUTH_UNREADABLE_REFUSAL, AUTH_UNVERIFIED_REFUSAL, authLines, authOf, authRows, settingsSources } from './auth'
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
import { isHumanAuthority, isPersonOrigin } from './origin'
import { agentsOf, readCache } from './cache'
import type { CacheReading } from './cache'
import { doctorText, shown as shownPath } from './doctor'
import type { DoctorFacts, Install, StopFacts } from './doctor'
import { dirFor, filesFor, gather, health, healthOf, limits, newSid, prepared, queue as teleQueue, segment, setEnabled as setTelemetry } from './telemetry-store'
import { flowGrid, flowOf, flowRow, flowText, layoutOf as flowLayout } from './flow'
import type { FlowInput, FlowTier } from './flow'
import { agentRole, cleanEvent, encode, expiredFiles, isTelemetryFile, modelTier, monthKey, parseWindow, segmentName, shedFiles, statsCsv, statsJson, statsText, TOTAL_CAP_BYTES } from './telemetry'
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
const FLOW_KEY = 'neural-flow'
const GUARD_HEADER = 'Blast radius'
const PROCEED = 'Proceed'
const CANCEL = 'Cancel'

const IDLE: Activity = { kind: 'IDLE', detail: '', isWorking: false, toolUseId: null, agents: [], at: 0 }
const NO_METER: Meter = { percent: null, tokens: null, window: null, model: null, effort: null }
const DEFAULT_PREFS: Prefs = { isMuted: false, isHudHidden: false }

const taskAtom = atom({ plugin: 'cobalt-cockpit', key: 'task' } as const, null)
const activityAtom = atom({ plugin: 'cobalt-cockpit', key: 'activity' } as const, IDLE)
const gitAtom = atom({ plugin: 'cobalt-cockpit', key: 'git' } as const, null)
/**
 * A verification obligation that outlives the task presentation: work that may have changed the workspace and was never verified by a
 * completed Stop check (a tool that can write ran while no task existed; a task that edited or was held was reset or cleared). Only a
 * completed check clears it. It is session state the progress tool cannot reach.
 */
const owedAtom = atom({ plugin: 'cobalt-cockpit', key: 'stop-owed' } as const, null as { at: number; why: string } | null)
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
// The session's router: OFF in every fresh session, switched only by /cockpit router, never stored.
/** The discovery level the person pinned with /cockpit discovery; null lets the rules decide. This session only. */
const discoveryPinAtom = atom({ plugin: 'cobalt-cockpit', key: 'discovery-pin' } as const, null as DiscoveryLevel | null)
const routerAtom = atom({ plugin: 'cobalt-cockpit', key: 'router' } as const, EMPTY_ROUTER as RouterState)
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
    to: { type: 'string', enum: ['SONNET','OPUS'] }, discoveries: { type: 'array', items: { type: 'string' } }, question: { type: 'string' }, risk: { type: 'string' }, next_action: { type: 'string' }, locations: { type: 'array', items: { type: 'string' } }, state: { type: 'string', enum: ['pending','pass','fail','unknown'] }, release_outcome: { type: 'string', enum: ['go','no-go'], description: 'verify (a release consultation, state pass): your confirmation of the architect\'s own DECISION line; it cannot be more favourable than that line' },
    effort: { type: 'string', enum: ['AUTO','low','medium','high','xhigh','max'], description: 'assign/escalate: the reasoning level this task deserves, or AUTO to choose from the task' }, effort_reason: { type: 'string', description: 'assign/escalate: why that level was chosen' },
  }, required: ['action'] },
} as const
// Canonicalize both assignment and use. Unknown aliases conservatively lock all.
const canonicalIn = async ($: EngineInterface, base: string, path: string): Promise<string> => {
  // `~` is the engine's to expand, not a directory under cwd: it is unknown, so everything.
  if (!path || /[*?\[\]{}]/.test(path) || path.startsWith('~')) return '*'
  try {
    const r = await $.process.run(['realpath','-m','--', path.startsWith('/') ? path : `${base}/${path}`], { timeoutMs: 2000 })
    return r.exitCode === 0 && !r.isStdoutTruncated ? normalizeOwned(r.stdout.trim()) : '*'
  } catch { return '*' }
}
const canonicalResource = async ($: EngineInterface, path: string): Promise<string> => canonicalIn($, cwd, path)
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
// --- Bounded measurement processes (v0.6.4; the limits and why: git-integrity.ts) ---
// Every git, stat, find, readlink and realpath this file starts to measure or inspect the working tree goes through
// `bounded`. Where the platform enforces it, a process may use at most BOUND_AS_KIB of memory; everywhere it may use
// BOUND_CPU_S of CPU, write files of at most 64 MiB and dump no core; the host's timeout ends it in any case. A limit
// already stricter is kept. What the platform enforces is probed once a registration and reported by /cockpit doctor;
// it is never assumed. Behind `sh`, the host's own git handling no longer applies, so GIT_BOUNDED turns repo hooks off.
/**
 * What the probe found. `script`: the limit script measurement runs under, with the address-space limit wherever `ulimit -v`
 * is accepted (setting a limit a platform ignores is harmless), or none at all. `enforced`: whether a 64 MiB allocation really
 * failed under a 32 MiB limit; null when a probe did not answer. A result in which a probe did not answer (a timeout under load,
 * say) stands for BOUND_RETRY_MS and is then probed again, so one slow moment cannot lower the rest of the session.
 */
type Bound = { script: 'memory' | 'basic' | null; enforced: boolean | null; group: boolean; settled: boolean }
/** A measurement that was not started because its limits could not be applied (v0.6.4): the caller's answer is UNKNOWN. */
class BoundRefused extends Error {}
/**
 * Measurement processes running now, and those waiting for one of BOUND_SLOTS; a slot is handed straight to the next in line.
 * One pool for the whole process, never reset: every slot is given back in a `finally` when its run ends, and the host's
 * `process.run` always ends (it rejects at its timeout).
 */
let boundRunning = 0
const boundWaiting: (() => void)[] = []
const boundSlot = async (): Promise<() => void> => {
  const release = () => { const heir = boundWaiting.shift(); if (heir !== undefined) heir(); else boundRunning-- }
  if (boundRunning < BOUND_SLOTS) { boundRunning++; return release }
  await new Promise<void>(resolve => boundWaiting.push(resolve))

  return release
}
type RunInit = { cwd?: string; timeoutMs?: number; env?: Record<string, string>; stdin?: string }
let boundMode: Promise<Bound> | null = null
/** Until when an unanswered probe's result stands before the next probe (no shell at all would otherwise cost two failed starts a call). */
let boundRetryAt = 0
const BOUND_RETRY_MS = 30_000
const probeBound = async ($: EngineInterface): Promise<Bound> => {
  const sh = (script: string) => $.process.run(['sh', '-c', script], { timeoutMs: 5000, env: { LC_ALL: 'C' } }).then(r => r, () => null)
  const set = await sh(BOUND_PROBE_SET(true))
  const timeout = await sh(BOUND_PROBE_GROUP)
  const group = timeout !== null && /\(GNU coreutils\)/.test(timeout.stdout)
  if (set !== null && set.exitCode === 0 && set.stdout.trim() === 'set') {
    // accepted is not enforced: a 64 MiB allocation must succeed without the cap and fail under a 32 MiB one
    const control = await sh(BOUND_PROBE_CONTROL)
    const capped = await sh(BOUND_PROBE_CAPPED)
    const enforced = control === null || capped === null ? null : control.exitCode === 0 && capped.exitCode !== 0
    return { script: 'memory', enforced, group, settled: enforced !== null && timeout !== null }
  }
  const basic = await sh(BOUND_PROBE_SET(false))
  const settled = set !== null && basic !== null && timeout !== null
  // a shell that answers one probe but not the other is a slow one, not one without `ulimit -v`: keep the stronger script
  if (basic !== null && basic.exitCode === 0 && basic.stdout.trim() === 'set') return { script: set === null ? 'memory' : 'basic', enforced: set === null ? null : false, group, settled }
  return { script: null, enforced: false, group: false, settled }
}
const boundOf = async ($: EngineInterface): Promise<Bound> => {
  if (boundMode !== null && boundRetryAt !== 0 && (await $.clock.now()) >= boundRetryAt) { boundMode = null; boundRetryAt = 0 }
  const probing = (boundMode ??= probeBound($))
  const found = await probing
  if (!found.settled && boundMode === probing && boundRetryAt === 0) boundRetryAt = (await $.clock.now()) + BOUND_RETRY_MS
  return found
}
const bounded = async ($: EngineInterface, argv: string[], init: RunInit = {}) => {
  const { script, group } = await boundOf($)
  // no limit can be applied: nothing is started, rather than something unbounded (v0.6.4)
  if (script === null) throw new BoundRefused('resource limits could not be applied here (no POSIX shell answered), so nothing was measured')
  const inner = argv[0] === 'git' ? ['git', ...GIT_BOUNDED, ...argv.slice(1)] : argv
  const run = { ...init, env: { ...BOUND_ENV, ...(init.env ?? {}) } }
  // the group timeout ends a second before the host's, so the whole group is gone before the host gives up on it
  const seconds = String(Math.max(1, Math.floor(((init.timeoutMs ?? 30_000) - 1000) / 1000)))
  const release = await boundSlot()
  try {
    return await $.process.run(['sh', '-c', boundScript(script === 'memory', group), BOUND_TAG, seconds, ...inner], run)
  } finally {
    release()
  }
}
/** For /cockpit doctor: what limits measurement processes run under here, in words. */
const boundWords = async ($: EngineInterface): Promise<{ enforced: boolean; text: string }> => {
  const found = await boundOf($)
  const rest = `files written at most 64 MiB, no core dump, at most ${BOUND_SLOTS} at once, and ${found.group ? 'a timeout that ends the process and every child it started' : 'the host\'s timeout; no GNU timeout here, so a child process a measurement starts may outlive it'}`
  const gap = 'Cockpit still never opens a device, FIFO or oversized file itself, but a file Git reads on its own (a linked worktree\'s commondir, a configuration include, grafts, sparse-checkout) is bounded only by CPU time and the timeout'
  if (found.script === 'memory' && found.enforced === true) return { enforced: found.group, text: `working-tree measurement runs under kernel limits: memory ${BOUND_AS_KIB / 1024} MiB, CPU ${BOUND_CPU_S} s, ${rest}` }
  if (found.script === 'memory' && found.enforced === null) return { enforced: false, text: `working-tree measurement sets memory ${BOUND_AS_KIB / 1024} MiB, CPU ${BOUND_CPU_S} s, ${rest}, but whether the memory limit is enforced could not be confirmed (the probe did not answer; it runs again at the next measurement)` }
  if (found.script === 'memory') return { enforced: false, text: `working-tree measurement runs under CPU ${BOUND_CPU_S} s, ${rest}; this platform does NOT enforce the memory limit it accepts. ${gap}` }
  if (found.script === 'basic') return { enforced: false, text: `working-tree measurement runs under CPU ${BOUND_CPU_S} s, ${rest}; no memory limit could be set here. ${gap}` }
  return { enforced: false, text: 'working-tree measurement is OFF: no shell here could set kernel limits, so no measurement process is started and the working tree is UNKNOWN' }
}

/** One line of a `stat` error whose cause is a path that is not there (C locale), the cause read after the path, as the line ends. */
const ENOENT = /^[^\n]*: No such file or directory$/
const MISSING: Inspected = { kind: 'missing', mode: 0, size: 0, identity: 'missing' }
/**
 * Inspects paths without following a final link (`follow`: following it, for configured files a person may keep
 * as links), in order, through bounded GNU or BSD `stat`. A path that does not exist is 'missing'; any other failure,
 * or a malformed answer, is null: the caller's measurement is then UNKNOWN.
 */
const inspectPaths = async ($: EngineInterface, cwd: string, paths: string[], follow = false): Promise<Inspected[] | null> => {
  if (paths.length === 0) return []
  const L = follow ? ['-L'] : []
  // not `ask`: that name is the dialog helper `$` is passed to, and the Directory reads a second binding of it as hiding the first
  const runStat = async (names: string[], gnu: boolean) => bounded($, gnu ? ['stat', ...L, '--printf', INSPECT_GNU, '--', ...names] : ['stat', ...L, '-f', INSPECT_BSD, '--', ...names], { cwd, timeoutMs: GIT_TIMEOUT_MS, env: { LC_ALL: 'C' } }).catch(() => null)
  const records = (text: string, gnu: boolean): Inspected[] | null => {
    const rows = text === '' ? [] : gnu ? (text.endsWith('\0') ? text.split('\0').slice(0, -1) : null) : text.endsWith('\n') ? text.split('\n').slice(0, -1) : null
    if (rows === null) return null
    const out = rows.map(r => inspectedOf(r, gnu))
    return out.every((x): x is Inspected => x !== null) ? out : null
  }
  // GNU first, all at once. Its records name the path they answer for, so where some paths could not be inspected (one is
  // missing, say) the others still count. When every error is "No such file or directory" and there is one for each path
  // not answered, those are missing; otherwise only those are asked about again, one at a time. An error line ends with
  // the system's own words after the path, so a path cannot pass for another error.
  const known = new Map<string, Inspected>()
  const gnu = await runStat(paths, true)
  const rows = gnu !== null && !gnu.isStdoutTruncated && !gnu.isStderrTruncated ? records(gnu.stdout, true) : null
  if (gnu !== null && gnu.exitCode === 0 && gnu.stderr.trim() === '' && rows !== null && rows.length === paths.length && rows.every((s, k) => s.name === paths[k])) return rows
  if (gnu !== null && rows !== null) {
    for (const s of rows) if (paths.includes(s.name!)) known.set(s.name!, s)
    const open = paths.filter(p => !known.has(p))
    const errors = gnu.stderr.split('\n').filter(Boolean)
    if (gnu.exitCode !== 0 && open.length > 0 && errors.length === open.length && errors.every(line => ENOENT.test(line))) return paths.map(p => known.get(p) ?? MISSING)
  }
  if (known.size === 0) {
    // no GNU answer at all: BSD stat, all at once (its records carry no name, so only a complete answer counts)
    const bsd = await runStat(paths, false)
    const all = bsd !== null && gitAnswered(bsd) ? records(bsd.stdout, false) : null
    if (all !== null && all.length === paths.length) return all
  }
  const out: Inspected[] = []
  for (const path of paths) {
    let got: Inspected | null = known.get(path) ?? null
    for (const isGnu of [true, false]) {
      if (got !== null) break
      const r = await runStat([path], isGnu)
      if (r === null) return null
      if (gitAnswered(r)) { const one = records(r.stdout, isGnu); got = one !== null && one.length === 1 && (!isGnu || one[0]!.name === path) ? one[0]! : null }
      else if (r.exitCode !== 0 && !r.isStderrTruncated && ENOENT.test(r.stderr.replace(/\n$/, ''))) got = MISSING
    }
    if (got === null) return null
    out.push(got)
  }
  return out
}

/** One file Git reads whole: where it is (null: not configured), whether it decides what is untracked (a fingerprint source), and what is there. */
type GitInput = { label: string; path: string | null; source: boolean; seen: Inspected | null }
/**
 * What Git reads whole while it lists, diffs, checks attributes or reports status: the excludes and attributes files (the
 * repository's and the configured ones) and the list of alternate object stores. Read whole, a device or FIFO there exhausted
 * memory or blocked (measured), so before any such Git command each must be an ordinary file of at most SOURCE_BYTES, or absent.
 * A configured file is followed through a link (a person may keep a global ignore file as one); what it leads to is never read
 * here. Anything else, or a Git that cannot say where they are, is { why }: the caller's answer is UNKNOWN.
 */
const gitInputs = async ($: EngineInterface, top: string): Promise<GitInput[] | { why: string }> => {
  const where = await bounded($, ['git', ...GIT_SAFE, '-C', top, 'rev-parse', '--git-path', 'info/exclude', '--git-path', 'info/attributes', '--git-path', 'objects/info/alternates'], { timeoutMs: GIT_TIMEOUT_MS })
  const own = gitAnswered(where) && where.stdout.endsWith('\n') ? where.stdout.slice(0, -1).split('\n') : null
  if (own === null || own.length !== 3 || own.some(p => p === '')) return { why: 'Git could not say where its excludes, attributes and alternates files are (it failed, timed out or reached a resource limit)' }
  const setting = async (name: string): Promise<string | null | undefined> => {
    const r = await bounded($, ['git', ...GIT_SAFE, '-C', top, 'config', '--type=path', '--get', name], { timeoutMs: GIT_TIMEOUT_MS })
    if (r.exitCode === 1 && r.stdout === '' && !r.isStderrTruncated && r.stderr.trim() === '') return null
    return gitAnswered(r) ? r.stdout.replace(/\n$/, '') || null : undefined
  }
  const excludesFile = await setting('core.excludesFile')
  const attributesFile = await setting('core.attributesFile')
  if (excludesFile === undefined || attributesFile === undefined) return { why: 'Git\'s core.excludesFile or core.attributesFile setting could not be read' }
  const named: GitInput[] = [
    { label: 'info/exclude', path: own[0]!, source: true, seen: null },
    { label: 'core.excludesFile', path: excludesFile, source: true, seen: null },
    { label: 'info/attributes', path: own[1]!, source: true, seen: null },
    { label: 'core.attributesFile', path: attributesFile, source: true, seen: null },
    { label: 'objects/info/alternates', path: own[2]!, source: false, seen: null },
  ]
  const present = named.filter(n => n.path !== null)
  const seen = await inspectPaths($, top, present.map(n => n.path!), true)
  if (seen === null) return { why: 'Git\'s excludes, attributes or alternates files could not be inspected' }
  for (const [k, s] of seen.entries()) {
    present[k]!.seen = s
    if (s.kind === 'missing' || (s.kind === 'file' && s.size <= SOURCE_BYTES)) continue
    return { why: `${present[k]!.label} is ${s.kind === 'file' ? `larger than ${SOURCE_BYTES / 1024 / 1024} MiB` : `a ${KIND_WORDS[s.kind]}, not an ordinary file`}; Git would read it without bound, so the working tree is not measured` }
  }
  return named
}

/**
 * The commit a release review is for: the full id of HEAD, and only when the working tree is clean (every
 * untracked file and submodule counted, whatever the user's git configuration says), because a review of a
 * commit says nothing of changes that are not in it. `dirty` is a real difference; `unknown` is git failing.
 */
type Candidate = { sha: string } | { sha: null; why: 'dirty' | 'unknown' }
/** Match Git's root + relative prefix to the actual session directory. A linked worktree or a session
 * below the root is valid; core.worktree / environment redirection to a different directory is not. */
const verifiedGitPlace = async ($: EngineInterface): Promise<{ root: string; dir: string } | null> => {
  const intended = await $.session.cwd()
  if (!intended) return null
  const top = await bounded($, ['git', ...GIT_SAFE, 'rev-parse', '--show-toplevel'], { cwd: intended, timeoutMs: GIT_TIMEOUT_MS })
  const prefix = await bounded($, ['git', ...GIT_SAFE, 'rev-parse', '--show-prefix'], { cwd: intended, timeoutMs: GIT_TIMEOUT_MS })
  if (top.exitCode !== 0 || prefix.exitCode !== 0 || top.isStdoutTruncated || prefix.isStdoutTruncated || top.isStderrTruncated || prefix.isStderrTruncated || top.stderr.trim() !== '' || prefix.stderr.trim() !== '') return null
  const root = top.stdout.replace(/\n$/, '')
  const relative = prefix.stdout.replace(/\n$/, '')
  if (!root.startsWith('/') || relative.startsWith('/') || relative.split('/').some(part => part === '..' || part === '.')) return null
  const actual = await bounded($, ['realpath', '-e', '--', intended], { timeoutMs: GIT_TIMEOUT_MS })
  const reported = await bounded($, ['realpath', '-e', '--', `${root}/${relative}`], { timeoutMs: GIT_TIMEOUT_MS })
  if (actual.exitCode !== 0 || reported.exitCode !== 0 || actual.isStdoutTruncated || reported.isStdoutTruncated || actual.isStderrTruncated || reported.isStderrTruncated || actual.stderr.trim() !== '' || reported.stderr.trim() !== '') return null
  const canonical = (value: string) => value.replace(/\n$/, '').replace(/\/+$/, '') || '/'
  return canonical(actual.stdout) === canonical(reported.stdout) ? { root, dir: intended } : null
}
const verifiedGitRoot = async ($: EngineInterface): Promise<string | null> => {
  const place = await verifiedGitPlace($)

  return place === null ? null : place.root
}
/** Check attributes before status/diff can run a repository-controlled clean/process command. The effective
 * command value wins; dormant filters (for example globally installed LFS) do not make ordinary trees unknown. */
const gitFiltersReliable = async ($: EngineInterface, top: string, committed: string[] = []): Promise<boolean> => {
  const cfg = await bounded($, ['git', ...GIT_SAFE, '-C', top, 'config', '--null', '--get-regexp', '^filter\\..*\\.(clean|process)$'], { timeoutMs: GIT_TIMEOUT_MS })
  if (cfg.isStdoutTruncated || cfg.isStderrTruncated || cfg.stderr.trim() !== '' || (cfg.exitCode !== 0 && cfg.exitCode !== 1)) return false
  if (cfg.exitCode === 1) return cfg.stdout === ''
  const drivers = filterCommands(cfg.stdout)
  if (drivers === null) return false
  if (drivers.size === 0) return true
  const tree = await bounded($, ['git', ...GIT_SAFE, '-C', top, 'ls-tree', '-r', '-z', '--full-tree', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS })
  const base = gitAnswered(tree) ? commitEntries(tree.stdout) : null
  if (base === null) return false
  const paths = await bounded($, ['git', ...GIT_SAFE, '-C', top, 'ls-files', '-z'], { timeoutMs: GIT_TIMEOUT_MS })
  if (paths.exitCode !== 0 || paths.isStdoutTruncated || paths.isStderrTruncated || paths.stderr.trim() !== '') return false
  if (paths.stdout !== '' && !paths.stdout.endsWith('\0')) return false
  const all = [...new Set([...paths.stdout.split('\0').filter(Boolean), ...base.map(e => e.path), ...committed])]
  if (all.length > 100_000) return false
  for (let i = 0; i < all.length; i += HASH_CHUNK) {
    const names = all.slice(i, i + HASH_CHUNK).join('\0') + '\0'
    const attrs = await bounded($, ['git', ...GIT_SAFE, '-C', top, 'check-attr', '-z', '--stdin', 'filter'], { stdin: names, timeoutMs: GIT_TIMEOUT_MS })
    if (attrs.exitCode !== 0 || attrs.isStdoutTruncated || attrs.isStderrTruncated || attrs.stderr.trim() !== '' || activeFilter(attrs.stdout, drivers, names) !== false) return false
  }
  return true
}
const gitAnswered = (r: { exitCode: number | null; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }) =>
  r.exitCode === 0 && !r.isStdoutTruncated && !r.isStderrTruncated && r.stderr.trim() === ''
const hashesOf = (text: string, count: number): string[] | null => {
  const hashes = text.split('\n').filter(Boolean)
  return hashes.length === count && hashes.every(x => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(x)) ? hashes : null
}

/** The text of a symbolic link, which is what Git records for one, read without following it; null when it cannot be read reliably. */
const linkText = async ($: EngineInterface, root: string, path: string): Promise<string | null> => {
  let link = await bounded($, ['readlink', '-z', '--', path], { cwd: root, timeoutMs: GIT_TIMEOUT_MS })
  if (!gitAnswered(link)) {
    const fallback = await bounded($, ['readlink', path], { cwd: root, timeoutMs: GIT_TIMEOUT_MS })
    if (!gitAnswered(fallback) || !fallback.stdout.endsWith('\n')) return null
    link = { ...fallback, stdout: fallback.stdout.slice(0, -1) + '\0' }
  }
  return link.stdout.endsWith('\0') && link.stdout.length <= 4096 && !link.stdout.slice(0, -1).includes('\0') ? link.stdout.slice(0, -1) : null
}
/** What a path that is never read is, in words. */
const KIND_WORDS: Record<Kind, string> = { file: 'file', link: 'symbolic link', dir: 'directory', fifo: 'FIFO', socket: 'socket', char: 'character device', block: 'block device', missing: 'missing path' }

/** Bytes read by one fingerprint, shared by its steps so that the total is bounded (FINGERPRINT_TOTAL_BYTES). */
type ReadBudget = { bytes: number }
const GIB = 1024 ** 3
/** Read every intended tracked file even if status, diff, and the index's dirty listing all say clean. */
const measureCommit = async ($: EngineInterface, root: string, sha: string, budget: ReadBudget = { bytes: 0 }): Promise<Measurement> => {
  try {
    const began = await $.clock.now()
    const late = async () => await $.clock.now() - began > FINGERPRINT_BUDGET_MS
    const git = (args: string[], stdin?: string) => bounded($, ['git', ...GIT_SAFE, '-C', root, ...args], { timeoutMs: GIT_TIMEOUT_MS, ...(stdin === undefined ? {} : { stdin }) })
    const tree = await git(['ls-tree', '-r', '-z', '--full-tree', sha])
    const entries = gitAnswered(tree) ? commitEntries(tree.stdout) : null
    if (entries === null) return { why: 'the intended commit tree is unreadable, malformed or exceeds the tracked-file limit' }
    if (entries.some(e => e.mode === '160000')) return { why: 'a submodule needs independent nested-tree verification; its index/status alone is insufficient' }
    const out: DiskEntry[] = []
    let regularLinks: boolean | undefined
    for (let i = 0; i < entries.length; i += HASH_CHUNK) {
      if (await late()) return { why: 'tracked-file measurement exceeded its time budget' }
      const chunk = entries.slice(i, i + HASH_CHUNK)
      // What is on disk at each path, without following a link: a link is measured by its own text, never the file it leads
      // to, and a directory, FIFO, socket or device is never opened. A missing tracked file is a known deletion.
      const seen = await inspectPaths($, root, chunk.map(e => `./${e.path}`))
      if (seen === null) return { why: 'tracked files could not be inspected completely' }
      const regular: number[] = []
      for (let n = 0; n < chunk.length; n++) {
        const s = seen[n]!
        if (s.kind === 'file') {
          if (s.size > FINGERPRINT_FILE_BYTES) return { why: `a tracked file is larger than ${FINGERPRINT_FILE_BYTES / GIB} GiB, more than the fingerprint reads` }
          budget.bytes += s.size
          regular.push(n)
        } else if (s.kind !== 'link' && s.kind !== 'missing') return { why: 'a tracked path is not an ordinary file or symbolic link (a directory, FIFO, socket or device), so it is not read' }
      }
      if (budget.bytes > FINGERPRINT_TOTAL_BYTES) return { why: `the working tree holds more than ${FINGERPRINT_TOTAL_BYTES / GIB} GiB to read, more than the fingerprint reads` }
      // not `read`: that is the host's own function `$` is passed to, and a second binding of it hides which one receives `$`
      const hashing = regular.length ? await git(['hash-object', '--no-filters', '--', ...regular.map(n => `./${chunk[n]!.path}`)]) : null
      const hashes = hashing === null ? [] : gitAnswered(hashing) ? hashesOf(hashing.stdout, regular.length) : null
      if (hashes === null) return { why: 'tracked working-tree bytes could not be hashed completely (a file could not be read, or its process reached a resource limit)' }
      // A file replaced (by a link to a device, say) or rewritten between the inspection and the read is not believed.
      if (regular.length) {
        const again = await inspectPaths($, root, regular.map(n => `./${chunk[n]!.path}`))
        if (again === null || again.some((s, k) => s.identity !== seen[regular[k]!]!.identity)) return { why: TRACKED_RACE }
      }
      let at = 0
      for (let n = 0; n < chunk.length; n++) {
        if (await late()) return { why: 'tracked-file measurement exceeded its time budget' }
        const e = chunk[n]!, s = seen[n]!
        if (s.kind === 'file') {
          let isSameType = e.mode !== '120000'
          if (!isSameType) {
            if (regularLinks === undefined) {
              const config = await git(['config', '--bool', '--get', 'core.symlinks'])
              regularLinks = gitAnswered(config) && config.stdout.trim() === 'false'
            }
            isSameType = regularLinks
          }
          out.push({ ...e, raw: hashes[at++]!, isSameType, diskMode: s.mode & 0o111 ? '100755' : '100644' })
        } else if (s.kind === 'link') {
          // Hash the link target, not the file it leads to; Git commits the target's bytes.
          const text = await linkText($, root, `./${e.path}`)
          if (text === null) return { why: 'a tracked symbolic link could not be read reliably' }
          const hash = await git(['hash-object', '--no-filters', '--stdin'], text)
          const got = gitAnswered(hash) ? hashesOf(hash.stdout, 1) : null
          if (got === null) return { why: 'a tracked symbolic link could not be hashed' }
          out.push({ ...e, raw: got[0]!, isSameType: e.mode === '120000', diskMode: '120000' })
        } else {
          out.push({ ...e, raw: '', isSameType: false, diskMode: 'missing' })
        }
      }
    }
    return await late() ? { why: 'tracked-file measurement exceeded its time budget' } : { entries: out }
  } catch { return { why: 'tracked-content verification failed or timed out' } }
}

/** Called only after effective external clean/process filters have been ruled out for all commit paths.
 * Native Git EOL/encoding normalization remains supported without trusting cached index content. */
const matchesCommit = async ($: EngineInterface, root: string, entries: DiskEntry[]): Promise<boolean | null> => {
  const began = await $.clock.now()
  if (entries.some(e => !e.isSameType)) return false
  if (entries.some(e => e.mode !== '120000' && e.diskMode !== undefined && e.diskMode !== e.mode)) {
    const config = await bounded($, ['git', ...GIT_SAFE, '-C', root, 'config', '--bool', '--get', 'core.filemode'], { timeoutMs: GIT_TIMEOUT_MS }).catch(() => null)
    if (config === null || config.isStdoutTruncated || config.isStderrTruncated || config.stderr.trim() !== '' || ![0, 1].includes(config.exitCode ?? -1)) return null
    if (config.exitCode === 1 || config.stdout.trim() === 'true') return false
    if (config.stdout.trim() !== 'false') return null
  }
  const changed = entries.filter(e => e.raw !== e.oid)
  if (changed.some(e => e.mode === '120000')) return false
  for (let i = 0; i < changed.length; i += HASH_CHUNK) {
    if (await $.clock.now() - began > FINGERPRINT_BUDGET_MS) return null
    const chunk = changed.slice(i, i + HASH_CHUNK)
    // Each is read again, so each is inspected again: only an ordinary file within the size bound, unchanged by the read.
    const seen = await inspectPaths($, root, chunk.map(e => `./${e.path}`))
    if (seen === null || seen.some(s => s.kind !== 'file' || s.size > FINGERPRINT_FILE_BYTES)) return null
    const r = await bounded($, ['git', ...GIT_SAFE, '-C', root, 'hash-object', '--', ...chunk.map(e => `./${e.path}`)], { timeoutMs: GIT_TIMEOUT_MS }).catch(() => null)
    const hashes = r !== null && gitAnswered(r) ? hashesOf(r.stdout, chunk.length) : null
    if (hashes === null) return null
    const again = await inspectPaths($, root, chunk.map(e => `./${e.path}`))
    if (again === null || again.some((s, n) => s.identity !== seen[n]!.identity)) return null
    if (chunk.some((e, n) => hashes[n] !== e.oid)) return false
  }
  return await $.clock.now() - began > FINGERPRINT_BUDGET_MS ? null : true
}

const candidateOf = async ($: EngineInterface): Promise<Candidate> => {
  try {
    const top = await verifiedGitRoot($)
    if (top === null || 'why' in await gitInputs($, top) || !(await gitFiltersReliable($, top))) return { sha: null, why: 'unknown' }
    const run = (argv: string[]) => bounded($, ['git', ...GIT_SAFE, '-C', top, ...argv], { timeoutMs: GIT_TIMEOUT_MS })
    const head = await run(['rev-parse', '--verify', 'HEAD'])
    if (head.exitCode !== 0 || head.isStdoutTruncated || head.isStderrTruncated || head.stderr.trim() !== '') return { sha: null, why: 'unknown' }
    const sha = head.stdout.trim()
    if (!isCandidate(sha)) return { sha: null, why: 'unknown' }
    const measured = await measureCommit($, top, sha)
    if ('why' in measured || !(await gitFiltersReliable($, top, measured.entries.map(e => e.path)))) return { sha: null, why: 'unknown' }
    const matches = await matchesCommit($, top, measured.entries)
    if (matches === null) return { sha: null, why: 'unknown' }
    if (!matches) return { sha: null, why: 'dirty' }
    const status = await run(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'])
    if (status.exitCode !== 0 || status.isStdoutTruncated || status.isStderrTruncated || status.stderr.trim() !== '') return { sha: null, why: 'unknown' }
    if (status.stdout.trim() !== '') return { sha: null, why: 'dirty' }
    // `status` does not see a path the index is told to ignore: assume-unchanged (a lowercase tag) or skip-worktree (S or s). A flagged
    // path can hide a change, so the tree is not shown clean; an unreadable listing is no answer either.
    const flags = await run(['ls-files', '-v', '-z'])
    if (flags.exitCode !== 0 || flags.isStdoutTruncated || flags.isStderrTruncated || flags.stderr.trim() !== '') return { sha: null, why: 'unknown' }
    if (flags.stdout.split('\0').some(entry => /^[a-zSs] /.test(entry))) return { sha: null, why: 'unknown' }
    const finalHead = await run(['rev-parse', '--verify', 'HEAD'])
    if (finalHead.exitCode !== 0 || finalHead.isStdoutTruncated || finalHead.isStderrTruncated || finalHead.stderr.trim() !== '' || finalHead.stdout.trim() !== sha) return { sha: null, why: 'unknown' }
    return { sha }
  } catch {
    return { sha: null, why: 'unknown' }
  }
}
const releaseRecords = (held: unknown): ReleaseRecord[] => (Array.isArray(held) ? held.filter((record): record is ReleaseRecord => record !== null && typeof record === 'object' && isCandidate((record as ReleaseRecord).candidate) && typeof (record as ReleaseRecord).id === 'string' && typeof (record as ReleaseRecord).returned === 'boolean' && typeof (record as ReleaseRecord).at === 'number').map(record => {
  // a verdict is kept only in its two known forms; anything else reads as no verdict, which never approves
  const { verified, outcome, ...rest } = record
  return { ...rest, ...(verified === 'pass' || verified === 'fail' ? { verified } : {}), ...(outcome === 'go' || outcome === 'no-go' ? { outcome } : {}) }
}) : [])
/** The store's release records. Strict: a store that cannot be read, or holds something else, fails a release request closed. */
const releaseHistory = async ($: EngineInterface): Promise<ReleaseRecord[]> => {
  const held = await $.store.get('release-reviews')
  if (held !== undefined && !Array.isArray(held)) throw new Error('OPUS / RELEASE RECORD UNREADABLE. The stored record of release reviews is not usable, so the allowance cannot be established. Nothing was started.')

  return releaseRecords(held)
}
/** One strict read of the release records for a view: what they hold, and whether they could be read at all. */
const releaseRead = async ($: EngineInterface): Promise<{ history: ReleaseRecord[]; readable: boolean }> => {
  try { return { history: await releaseHistory($), readable: true } } catch { return { history: [], readable: false } }
}
/** The same, for housekeeping: what can be read. */
const releaseHistorySoft = async ($: EngineInterface): Promise<ReleaseRecord[]> => releaseRecords(await $.store.get('release-reviews').catch(() => undefined))
/**
 * Every write of the release records goes through here, one at a time inside this process: the list is read again
 * inside the queue, changed, written, and read back, and a record that did not come back as written fails the
 * operation (so an admission that depends on it admits nothing). LIMIT: the store offers get and set only, with no
 * compare-and-set, so two Cockpit processes sharing one store can still overwrite each other between the read and the
 * write. The read-back catches a write that is already gone, not one that is lost a moment later; the merge by id and
 * the read-again keep what a second process wrote earlier. A release admission is the one place that cannot be left
 * ambiguous, and it fails closed on any mismatch.
 */
let releaseQueue: Promise<unknown> = Promise.resolve()
const mutateRelease = ($: EngineInterface, f: (held: ReleaseRecord[]) => ReleaseRecord[]): Promise<ReleaseRecord[]> => {
  const run = releaseQueue.then(async () => {
    const held = await releaseHistory($)
    const written = f(held)
    if (JSON.stringify(written) === JSON.stringify(held)) return held
    await $.store.set('release-reviews', written)
    const back = releaseRecords(await $.store.get('release-reviews'))
    const lost = written.find(n => { const b = back.find(x => x.id === n.id); return b === undefined || b.candidate !== n.candidate || b.returned !== n.returned || b.verified !== n.verified || b.outcome !== n.outcome })
    if (lost !== undefined) throw new Error(`OPUS / RELEASE RECORD NOT PERSISTED. The record of release consultation ${lost.id} did not read back as written, so nothing that depends on it was started.`)

    return written
  })
  releaseQueue = run.catch(() => undefined)

  return run
}
/** A release consultation the host saw return is recorded as returned where a restart cannot lose it, whether or not it has been verified yet. */
const syncRelease = async ($: EngineInterface): Promise<void> => {
  const ledger = await read($, ledgerAtom)
  const swarm = swarmState(ledger)
  const back = (ledger.consults ?? []).filter(c => c.ground === 'release' && c.candidate !== undefined && hasReturned(swarm.tasks.find(t => t.id === c.id)))
  if (back.length === 0) return
  await mutateRelease($, held => back.reduce((all, c) => (all.some(entry => entry.id === c.id && entry.returned) ? all : withRelease(all, { candidate: c.candidate!, id: c.id, at: c.requestedAt, returned: true })), held))
}
/**
 * A release approval stands only for the commit it was given for, on a clean tree: a change takes it back, and the
 * same commit, clean again, gives it back from the stored record of a verified GO (`revalidateRelease`). A git that
 * does not answer suspends current clearance; the stored historical records are never touched.
 */
const reconcileRelease = async ($: EngineInterface): Promise<void> => {
  const task = await read($, taskAtom)
  const review = task?.review
  if (review === undefined || !review.grounds.includes('release')) return
  const history = await releaseHistorySoft($)
  // nothing held and nothing stored that could stand for a commit: git need not be asked
  if (review.cleared?.some(x => x.ground === 'release') !== true && review.state !== 'adjudicated' && !history.some(entry => entry.returned && entry.verified === 'pass' && entry.outcome === 'go')) return
  const candidate = await candidateOf($)
  const revalidated = revalidateRelease(review, candidate, history)
  if (revalidated === review) return
  const was = JSON.stringify(review)
  await update($, taskAtom, t => (t?.review !== undefined && JSON.stringify(t.review) === was ? settle({ ...t, review: revalidated }).task : t))
}

/**
 * One Opus consultation requested by the main session (SONNET_LED). The ground
 * and packet are checked by `consultVerdict` alone; no router is asked. Admission
 * reserves nothing yet: the OPUS swarm task it submits is admitted again, with
 * ownership and budget, when the architect's Agent call arrives.
 */
let consulting: Promise<unknown> = Promise.resolve()
/** One consultation request at a time: two cannot both pass the bounds before either is recorded. */
const serveConsult = ($: EngineInterface, e: Record<string, unknown>, at: number): Promise<string> => {
  const run = consulting.then(() => serveConsultNow($, e, at), () => serveConsultNow($, e, at))
  consulting = run.catch(() => undefined)

  return run
}
const serveConsultNow = async ($: EngineInterface, e: Record<string, unknown>, at: number): Promise<string> => {
  const ground = e['ground']
  if (!isGround(ground)) throw new Error(`Valid ground required: ${GROUNDS.join(', ')}`)
  const made = packetOf(ground, { objective: e['objective'], architecture: e['architecture'], files: e['locations'], alternatives: e['alternatives'], failures: e['failures'], risk: e['risk'], decision: e['question'] })
  if ('error' in made) throw new Error(`Evidence packet incomplete: ${made.error}`)
  const task = await read($, taskAtom)
  const facts = factsOf(task, (await read($, orchestraAtom)).errorStreak, task?.promptGrounds ?? [])
  const ledger = await read($, ledgerAtom)
  const consults = ledger.consults ?? []
  if (ground === 'release') {
    await syncRelease($)
    // a verified GO already held for this exact clean commit is applied to this task before the duplicate is refused
    await quiet(() => reconcileRelease($))
  }
  const candidate = ground === 'release' ? (await candidateOf($)).sha : null
  const history = ground === 'release' ? await releaseHistory($) : []
  const verdict = consultVerdict({ profile: config.hasOrchestration ? config.profile : 'OPUS_LED', ground, packet: made.packet, facts, consults, swarm: swarmState(ledger), progressTask: task?.id ?? null, candidate, history })
  if (!verdict.ok) {
    await quiet(() => mutateLedger($, l => warn(l, `${verdict.reason.split('.')[0]} (${ground})`)))
    await tele($, { k: 'consult', ground, ev: 'refused' })
    throw new Error(verdict.reason)
  }
  // The architect reads the files the packet names (line references dropped),
  // inside the project only; a packet that names none reads the project, never `*`.
  const root = await canonicalResource($, cwd || '.')
  if (root === '*') throw new Error('OPUS / the project root could not be resolved, so no read scope can be given; nothing was admitted')
  const named = await Promise.all(readScopeOf(made.packet).map(p => canonicalResource($, p)))
  const owned = named.filter(p => p !== '*' && (p === root || p.startsWith(`${root}/`)))
  const outside = named.length - owned.length
  // The path lookups take time: another consultation may have been
  // admitted meanwhile, so the bounds are checked again on the ledger as it is now.
  const fresh = await read($, ledgerAtom)
  // the candidate is read again as well: it is the commit the review is for, and it must still be the one
  const nowCandidate = ground === 'release' ? (await candidateOf($)).sha : null
  const fresher = ground === 'release' ? await releaseHistory($) : []
  const again = consultVerdict({ profile: config.hasOrchestration ? config.profile : 'OPUS_LED', ground, packet: made.packet, facts, consults: fresh.consults ?? [], swarm: swarmState(fresh), progressTask: task?.id ?? null, candidate: nowCandidate, history: fresher })
  if (!again.ok) { await tele($, { k: 'consult', ground, ev: 'refused' }); throw new Error(again.reason) }
  if (nowCandidate !== candidate) throw new Error('OPUS / CANDIDATE CHANGED. The commit moved or the working tree changed while the consultation was being admitted; nothing was started. Ask again for the commit you mean.')
  const counter = (list: readonly { id: string }[]) => Math.max(0, ...list.map(x => Number(/^opus-(\d+)-/.exec(x.id)?.[1] ?? 0)))
  // unique across the ledger and the store, so a restart cannot reuse the id of an attempt already spent
  const id = `opus-${Math.max(counter(fresh.consults ?? []), counter(fresher)) + 1}-${verdict.key.slice(0, 6)}`
  // the record that bounds a release review is written first, and a write that fails admits nothing
  if (ground === 'release' && nowCandidate !== null) await mutateRelease($, held => withRelease(held, { candidate: nowCandidate, id, at, returned: false }))
  await changeSwarm($, held => submitTask(held, { id, tier: 'OPUS', role: ground === 'release' || ground === 'security' ? 'REVIEW' : 'ARCHITECT', objective: made.packet.decision, scope: `Opus consultation · ${ground}`, owned: owned.length ? owned : [root], mode: 'read', parentTask: null, effort: CONSULT_EFFORT, effortReason: `Opus consultation: ${CONSULT_EFFORT} by default`, spawnReason: `Opus admitted on ${ground}${verdict.isMandatory ? ' (mandatory)' : ''}` }, at).swarm)
  const c: Consultation = { id, ground, key: verdict.key, packet: made.packet, progressTask: task?.id ?? null, isMandatory: verdict.isMandatory, requestedAt: at, ...(ground === 'release' && candidate !== null ? { candidate } : {}) }
  await mutateLedger($, l => ({ ...l, consults: addConsult(l.consults ?? [], c) }))
  // A review is advanced only by a consultation on one of the grounds that made
  // it necessary: an easier consultation on another ground does not stand in for it.
  if (task !== null) await change($, t => {
    if (t.id !== task.id) return t
    const held = verdict.isMandatory ? requireReview(t, [ground]) : t
    // an approval given for another commit was withdrawn above (`reconcileRelease`); an attempt carries no commit
    // onto the review, only a cleared release ground does (`advanceReview`, `clearReview`)
    const admitted = held.review?.grounds.includes(ground) ? advanceReview(held.review, id, 'admitted') : undefined

    return admitted === undefined ? held : { ...held, review: admitted }
  })

  await tele($, { k: 'consult', ground, ev: 'admitted', mandatory: verdict.isMandatory })
  const scope = `Read scope: ${owned.length ? `${owned.length} named file${owned.length === 1 ? '' : 's'}` : 'the project'}${outside ? `; ${outside} location${outside === 1 ? '' : 's'} not readable (outside the project, home-relative or not a plain path)` : ''}.`

  return `OPUS ADMITTED / ${id} · ${ground}${verdict.isMandatory ? ' · mandatory for this task' : ''}. ${scope}\nSpawn Agent with subagent_type "cobalt-cockpit:architect", description "[task:${id}] Opus ${ground} consultation", and exactly this brief as the prompt:\n\n${briefOf(c)}\n\nIts answer is advice until you verify it. Then record swarm action "verify" for ${id}: pass when the advice checks out, fail when it does not, with evidence either way.`
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
      return { result: JSON.stringify({ ...summarizeSwarm(s), tasks: selected.map(t => ({ id:t.id, tier:t.tier, suggested:t.suggestedTier ?? null, role:t.role, state:t.state, reason:t.reason, agent:t.agentId, effort:t.requestedEffort, launchEffort:t.launchEffort ?? null, appliedEffort:t.appliedEffort, effortReason:t.effortReason, result:t.result ? { conclusion:t.result.conclusion.slice(0,160), evidence:t.result.evidence.slice(0,3).map(x=>x.slice(0,160)), unresolved:t.result.unresolved.slice(0,3).map(x=>x.slice(0,160)) } : null, escalation:t.escalation ? { to:t.escalation.to, effort:t.escalation.effort ?? null, question:t.escalation.question.slice(0,160), risk:t.escalation.risk.slice(0,160) } : null, verification:t.verification, resultDelivery:t.resultDelivery ?? 'unavailable' })) }) }
    }
    if (action === 'assign') {
      if (typeof e['objective'] !== 'string' || !e['objective'].trim()) throw new Error('Bounded objective required')
      if (!/^[\w.-]{1,80}$/.test(id) || !['OPUS','SONNET','HAIKU'].includes(String(e['tier']))) throw new Error('Valid task_id and tier required')
      if (e['tier'] === 'OPUS' && isSonnetLed()) throw new Error('OPUS / in SONNET_LED an Opus task is admitted only through action consult, with a ground and an evidence packet')
      const named = list('owned_resources')
      const owned = await Promise.all(named.map(p => canonicalResource($, p)))
      // A claim that is a pattern, starts with "~" or does not resolve has always been taken as the whole repository: the
      // safe reading for a lock, and a wide one for a reader. It is not narrowed here, and it is no longer silent.
      const widened = named.filter((p, i) => p.trim() !== '*' && owned[i] === '*').length
      const scopeNote = widened > 0 ? ` SCOPE / ${widened} of the owned_resources could not be kept narrow (a pattern, "~" or a path that did not resolve), so this task's claim is *: it may read, and it locks, the whole repository. Cancel it and assign literal paths under a new task_id to keep it narrow.` : named.length === 0 ? ' SCOPE / no owned_resources were named, so this task\'s claim is *: the whole repository.' : ''
      let isRepeat = false
      const assignedSwarm = await changeSwarm($, held => { const made = submitTask(held, { id, tier: e['tier'] as ModelTier, role: str('role'), objective: str('objective'), scope: str('scope'), dependencies:list('dependencies'), owned, mode: e['mode'] === 'write' ? 'write' : 'read', parentTask: typeof e['parent_task'] === 'string' ? e['parent_task'] : null, spawnReason: str('spawn_reason'), ...(isEffortRequest(e['effort']) ? { effort: e['effort'] } : {}), ...(typeof e['effort_reason'] === 'string' ? { effortReason: str('effort_reason') } : {}) }, at); isRepeat = made.duplicate; const submitted = made.swarm; if (jsonBytes(submitted.tasks.map(t=>({ ...t,result:null,escalation:null }))) > 192_000) throw new Error('Ownership metadata storage budget reached; finish/archive work before assigning more'); return submitted })
      const assigned = assignedSwarm.tasks.find(t => t.id === id)
      // a task id is never reused: assigning one that has already ended assigns nothing, and saying "cancelled; use Agent" would mislead
      if (isRepeat && assigned && ['completed', 'failed', 'cancelled'].includes(assigned.state)) return { result: `Task ${id} already exists and is ${assigned.state}; nothing was assigned. A task id is never reused: assign the work under a new task_id.` }
      // the route's reading of the assignment is advice beside the commander's choice: it changes no tier and starts nothing
      // how the advice could be followed, where it can be: a task id is never reused, and Opus is not a tier to assign in SONNET_LED
      const follow = assigned?.suggestedTier === 'OPUS' ? (isSonnetLed() ? 'An Opus view is asked for with action consult, on a ground that holds.' : 'That decision is the commander\'s to make in the main session.') : 'To follow it, cancel this task and assign the work under a new task_id.'
      const advice = assigned && assigned.suggestedTier !== undefined && assigned.suggestedTier !== assigned.tier ? ` ROUTE / ${assigned.suggestedTier} suggested (${assigned.routeReason ?? 'no reason recorded'}); ${assigned.tier} kept as assigned. Advice only. ${follow}` : ''
      return { result: assigned ? `Task ${id} ${assigned.state}; use Agent description [task:${id}]. OPUS tasks stay in main.${advice}${scopeNote}` : 'Duplicate suppressed; see swarm status for existing task.' }
    }
    if (action === 'consult') { const reply = await serveConsult($, e, at); await persist($); return { result: reply } }
    if (action === 'wave') { if (!['RECONNAISSANCE','ENGINEERING','REVIEW','INTEGRATION','VERIFICATION'].includes(String(e['wave']))) throw new Error('Valid wave required'); await changeSwarm($, held => setWave(held, e['wave'] as Wave, at)) }
    else {
      if (!task) throw new Error('Unknown task')
      if (action === 'adopt') {
        if (task.tier === 'OPUS') throw new Error('OPUS / a consultation runs only as the cobalt-cockpit:architect spawned for its [task:ID]; an existing agent cannot be adopted into it')
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
      else if (action === 'verify') { if (!['pending','pass','fail','unknown'].includes(String(e['state']))) throw new Error('Valid verification state required')
        // A consultation's advice can be judged, pass or fail, only once Opus has given it.
        const consult = (await read($, ledgerAtom)).consults?.find(c => c.id === id)
        const judged = e['state'] === 'pass' || e['state'] === 'fail'
        // a recorded release recommendation is final: it is not judged again, so nothing can turn a NO-GO into a GO
        if (consult?.ground === 'release' && judged && (await releaseHistory($)).some(entry => entry.id === id && entry.outcome !== undefined)) throw new Error('OPUS / RELEASE VERDICT RECORDED. This release consultation already has its recommendation recorded and it is final. Ask again only on a changed commit.')
        if (consult && judged && !hasReturned(task)) throw new Error('OPUS / this consultation has not returned. Spawn cobalt-cockpit:architect with its [task:ID] and let it answer; a review is adjudicated only on an answer Opus gave')
        // A release ground is cleared by a recommendation, not by the advice being sound. The recommendation is the
        // architect's own DECISION line; `release_outcome` is the main session confirming it, and can only be as
        // strict or stricter. A missing, repeated, hedged or contradicted one records and clears nothing.
        let outcome: ReleaseOutcome | undefined
        if (consult?.ground === 'release' && e['state'] === 'pass') {
          const said = task.agentId === null ? undefined : (await read($, ledgerAtom)).observedCompletions?.find(c => c.agentId === task.agentId)?.decision
          if (said === undefined) throw new Error('OPUS / RELEASE DECISION UNREADABLE. The architect\'s returned answer does not carry exactly one line "DECISION: GO" or "DECISION: NO-GO", so no release recommendation can be read from it. Nothing was recorded. Verify it with state "fail", or ask again on a changed commit.')
          const asked = e['release_outcome']
          if (asked !== 'go' && asked !== 'no-go') throw new Error('OPUS / release_outcome required: "go" or "no-go", confirming the architect\'s DECISION line. A verified pass alone approves nothing. Nothing was recorded.')
          if (asked === 'go' && said === 'no-go') throw new Error('OPUS / the architect\'s DECISION is NO-GO; a GO cannot be declared over it. Verify with release_outcome "no-go". Nothing was recorded.')
          outcome = asked === 'go' && said === 'go' ? 'go' : 'no-go'
        }
        // the record a later task or a restart relies on is written first; a write that does not read back stops here
        if (consult?.ground === 'release' && consult.candidate !== undefined && judged) await mutateRelease($, held => withRelease(held, { candidate: consult.candidate!, id, at: consult.requestedAt, returned: true, verified: e['state'] as 'pass' | 'fail', ...(outcome === undefined ? {} : { outcome }) }))
        await changeSwarm($, held => verifyTask(held,id,e['state'] as Verification,at,list('evidence').join('; ')))
        // The main session judging a consultation's advice clears the one ground that consultation was asked on, and no other.
        if (consult && judged) {
          const now = consult.ground === 'release' ? (await candidateOf($)).sha : null
          await change($, t => t.review ? { ...t, review: clearReview(t.review, consult, e['state'] as 'pass' | 'fail', outcome, now) } : t)
          await tele($, { k: 'consult', ground: consult.ground, ev: 'verified', state: e['state'], ...(outcome === undefined ? {} : { rel: outcome }) })
        }
        // a release consultation that really returned is recorded as such where a restart cannot lose it
        await quiet(() => syncRelease($))
      }
      else throw new Error('Unknown swarm action')
    }
    await persist($)
    return { result: `Swarm ${action} recorded; host completion and commander verification remain distinct.` }
  } catch (error) { return { result: `SWARM / ${error instanceof Error ? error.message : 'invalid input'}`, isError: true } }
}
// Read-only Git inspection for subagents. The two rules are in ./git-inspect (pure); what needs the host is here: the
// verified repository, canonical paths checked against the task's ownership, and proof that each revision is a commit.
const GIT_IDENTITY_DENY = 'SWARM / read-only Git inspection cannot establish safe repository identity and filter configuration; use the host Read/Grep tools instead'
const SEARCH_HINT = ' To search or list inside your scope: git grep -n <pattern> -- <path>, git ls-files -- <path>; to read a file: the Read tool.'
type GitPlan = { pin?: ScopedPin; root?: string }
const ownedText = (task: SwarmTask): string => `${task.owned.slice(0, 4).map(shortResource).join(', ')}${task.owned.length > 4 ? ` +${task.owned.length - 4}` : ''}`
/**
 * A narrowly scoped task's Git inspection: accepted only when the command has the allowed shape, every path it names is
 * inside the task's owned resources, and every revision is a commit (so none addresses a tree or a file). Nothing is
 * widened: a path outside the scope is refused with the scope named, and the commander is the one who can change it.
 */
const scopedGitPlan = async ($: EngineInterface, s: Swarm, task: SwarmTask, command: string): Promise<{ pin: ScopedPin; root: string } | { deny: string; isGit: boolean }> => {
  const vetted = scopedGit(command)
  if (!vetted.ok) return { deny: `SWARM / ${vetted.reason}. Owned: ${ownedText(task)}.`, isGit: vetted.isGit }
  try {
    const place = await verifiedGitPlace($)
    if (place === null) return { deny: GIT_IDENTITY_DENY, isGit: true }
    const outside = (shown: string): { deny: string; isGit: boolean } => ({ deny: `SWARM / read outside owned resources: ${shown} is not inside this task's scope (owned: ${ownedText(task)}). A read-only Git command does not widen a scope; ask the commander to assign the path.`, isGit: true })
    const paths: string[] = []
    for (const path of vetted.git.paths) {
      const canonical = await canonicalIn($, place.dir, path)
      if (canonical === '*' || !ownershipAllows(s, task.id, canonical, 'read')) return outside(canonical === '*' ? 'a path that could not be resolved' : shortResource(canonical))
      paths.push(canonical)
    }
    for (const object of vetted.git.objects) {
      // Git reads <rev>:<path> by name in that commit's tree and follows no link, while realpath follows the links the
      // working tree has today. A directory that became a link into the scope must not open what it used to hold: the
      // path as written and the path as resolved must both be owned.
      const written = normalizeOwned(`${place.root}/${object.path}`)
      const canonical = await canonicalIn($, place.root, object.path)
      if (written === '*' || canonical === '*') return outside('a path that could not be resolved')
      if (!ownershipAllows(s, task.id, written, 'read')) return outside(shortResource(written))
      if (!ownershipAllows(s, task.id, canonical, 'read')) return outside(shortResource(canonical))
    }
    for (const name of vetted.git.commits) {
      const peeled = await bounded($, ['git', ...GIT_SAFE, '-C', place.dir, 'rev-parse', '--verify', '--quiet', `${name}^{commit}`], { timeoutMs: GIT_TIMEOUT_MS })
      if (!gitAnswered(peeled) || hashesOf(peeled.stdout, 1) === null) return { deny: `SWARM / "${name.slice(0, 60)}" does not name a commit here. Under a narrow scope a revision must be a branch, tag or commit id that resolves to a commit; a tree, a file or an unknown name is refused.`, isGit: true }
    }

    return { pin: { git: vetted.git, dir: place.dir, paths }, root: place.root }
  } catch { return { deny: GIT_IDENTITY_DENY, isGit: true } }
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
const guardSwarm = async ($: EngineInterface, e: Record<string, unknown>, plan: GitPlan = {}): Promise<string | null> => {
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
  const command = tool === 'Bash' ? String(e['command'] ?? '') : ''
  // A task with named paths, not `*`: its shell is read-only Git inspection of those paths and nothing else.
  const isScopedShell = task !== undefined && tool === 'Bash' && !task.owned.includes('*')
  if (task !== undefined && isScopedShell) {
    const scoped = await scopedGitPlan($, s, task, command)
    if ('pin' in scoped) { plan.pin = scoped.pin; plan.root = scoped.root }
    // a Git inspection this scope cannot run is told exactly why; any other command meets the rules below
    else if (scoped.isGit) return scoped.deny
  }
  // a subagent's inspection is rebuilt before it runs, so quoted text in it is data; the commander's runs as typed
  const readTool = ['Read','Grep','Glob','WebFetch','WebSearch'].includes(tool) || plan.pin !== undefined || (tool === 'Bash' && !isScopedShell && (agent ? agentInspection(command) : readOnlyShell(command)))
  if (task && task.mode === 'read' && !readTool) return `SWARM / read-only tasks may use inspection tools only; shell/custom effects require commander investigation.${SEARCH_HINT}`
  if (task && ['Read','Grep','Glob'].includes(tool)) {
    // Grep and Glob without a path search the working directory: that is the claim checked, not everything.
    const path = String(e['file_path'] ?? e['path'] ?? (tool !== 'Read' && cwd ? cwd : '*'))
    // A pattern reaches only below that path: one that is absolute, home-relative or climbs out is refused.
    const pattern = tool === 'Glob' ? e['pattern'] : tool === 'Grep' ? e['glob'] : undefined
    if (typeof pattern === 'string' && !task.owned.includes('*') && /(?:^|[{,])\s*[\/~]|(?:^|[\/\\{,])\.\.(?:[\/\\},]|$)/.test(pattern.trim())) return 'SWARM / read outside owned resources: give the directory as path and a pattern relative to it'
    const resource = await canonicalResource($, path)
    if (!ownershipAllows(s, task.id, resource, 'read')) return 'SWARM / read outside owned resources'
  }
  if (isScopedShell && plan.pin === undefined) return `SWARM / shell inspection requires declared wildcard read scope; under a narrow scope the shell runs only read-only Git inspection of owned paths (${SCOPED_FORM})`
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
    '"gate": report a verification gate (CODE, TEST, TYPE, BUILD, SECURITY, GIT) as pass, fail, na or pending with one line of "evidence"; or several at once in "gates". ' +
    '"discover": for a multi-file or risky task, record the objective, acceptance "criteria", material "unknowns" and relevant "risks". ' +
    '"decide": record one consequential decision as "decision" {problem, chosen, alternatives[{option, rejected_because}], tradeoffs, evidence[], status}. ' +
    '"align": before DONE, check the result against the original request as "alignment" {state ALIGNED|PARTIAL|BLOCKED|UNKNOWN, demonstrated[{id, evidence}], missing[], assumptions[]}; ALIGNED needs evidence per criterion. ' +
    '"status": read the current state. ' +
    'Progress is completed milestones over all milestones; 100% needs every milestone complete and every required gate pass or na. Never complete a milestone that is not finished.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['plan', 'start', 'complete', 'fail', 'block', 'unblock', 'gate', 'discover', 'decide', 'align', 'status'] },
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
      gates: { type: 'array', description: 'gate: several gates in one call; all are recorded or none', items: { type: 'object', properties: { gate: { type: 'string', enum: ['CODE', 'TEST', 'TYPE', 'BUILD', 'SECURITY', 'GIT'] }, state: { type: 'string', enum: ['pass', 'fail', 'na', 'pending'] }, evidence: { type: 'string' } }, required: ['gate', 'state'] } },
      note: { type: 'string', description: 'why a milestone failed or is blocked, or a remark on its completion' },
      level: { type: 'string', enum: ['STANDARD', 'DEEP'], description: 'discover: raise the discovery level (never lowers it)' },
      criteria: { type: 'array', items: { type: 'string' }, description: 'discover: acceptance criteria, each a checkable sentence (at least two words); required before ALIGNED for STANDARD and DEEP work' },
      unknowns: { type: 'array', description: 'discover: material unknowns {id?, text, state open|resolved|assumed, note}', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, state: { type: 'string', enum: ['open', 'resolved', 'assumed'] }, note: { type: 'string' } } } },
      risks: { type: 'array', items: { type: 'string' }, description: 'discover: only the risk categories that apply' },
      decision: { type: 'object', description: 'decide: one consequential decision. An alternative needs the reason it was rejected; verified needs evidence', properties: { id: { type: 'string' }, problem: { type: 'string' }, chosen: { type: 'string' }, alternatives: { type: 'array', items: { type: 'object', properties: { option: { type: 'string' }, rejected_because: { type: 'string' } }, required: ['option', 'rejected_because'] } }, tradeoffs: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['provisional', 'verified', 'revised'] } }, required: ['problem', 'chosen'] },
      alignment: { type: 'object', description: 'align: the original-goal check. ALIGNED needs one demonstrated entry per criterion id from discover, with its evidence', properties: { state: { type: 'string', enum: ['ALIGNED', 'PARTIAL', 'BLOCKED', 'UNKNOWN'] }, demonstrated: { type: 'array', description: 'one entry per criterion id, each with its own observed evidence (a file, test name, command output or figure)', items: { type: 'object', properties: { id: { type: 'string', description: 'criterion id such as c1' }, status: { type: 'string', enum: ['met', 'failed', 'unresolved'] }, evidence: { type: 'string' } }, required: ['id', 'evidence'] } }, missing: { type: 'array', items: { type: 'string' } }, assumptions: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } }, required: ['state'] },
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
4. Report each verification gate with action "gate" (CODE, TEST, TYPE, BUILD, SECURITY, GIT; several in one call with "gates"): pass or fail with the command and its outcome as evidence, or na with the reason it does not apply. Test, type-check, build, lint and audit commands run through Bash are recorded automatically from their exit status; when that status is masked (output piped to another command, a background run) report the result yourself.
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
  '/cockpit discovery  show the discovery level, unknowns, decisions and goal check; pin light | standard | deep, or auto\n' +
  '/cockpit router     show this session\'s router, or switch it: off, nobodywho, jev (this session only)\n' +
  '/cockpit stats     observed model use, routing and consultations: 7d | 30d | all, with --json or --csv\n' +
  '/cockpit agents    the agent inspector: tasks, agents, waves, ownership, requested versus applied effort, and why a task is waiting (read-only); agents <task> explains one\n' +
  '/cockpit ready     which recorded conditions stand between the task and DONE: gates, review, goal check, guard, escalations (read-only; approves nothing)\n' +
  '/cockpit flow      the Neural Flow in words: which of input, discovery, routing, workers, verify and done are verified\n' +
  '/cockpit guard     Cobalt Guard owner alerts: status, priorities, quiet hours and active conditions; ack, silence or unsilence; test and seen check that a notification reaches you (none changes a verdict)\n' +
  '/cockpit alerts   the alert inbox: recorded alerts with their notification outcome, acknowledgment and whether the condition is still open; alerts digest summarises the unacknowledged and what is new since your last look; alerts ack <id> acknowledges one (changes no verdict); alerts review lists incidents to label, alerts label <id> notify|record|noise|clear records whether you would have wanted a notification, and alerts calibration reports how the alert policy would have done against your labels (simulated: nothing is sent and no setting changes)\n' +
  '/cockpit doctor    read-only checks: installs, profile, telemetry storage, host and prompt-cache policy\n' +
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

const healthLine = (): string => {
  const health = healthOf()

  return !health.enabled ? 'TELEMETRY / off (telemetry=false); nothing is being recorded.' : `TELEMETRY / this session wrote ${health.writes} record${health.writes === 1 ? '' : 's'}${health.failures > 0 ? `, ${health.failures} could not be written (incomplete coverage)` : ''} · files ${health.permissions === 'verified' ? 'read back as 0700 directory, 0600 files' : health.permissions === 'unverified' ? 'permissions could NOT be confirmed (the host gives plugins no file mode; the directory is only as private as your umask)' : 'not yet written'}`
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
  hasFlow: boolean
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
  /**
   * A decision-router configuration directory the operator made for Cockpit's
   * JEV mode, or empty. It is handed to the router child process alone, and
   * only while the session's router is JEV; Cockpit never creates or edits it.
   */
  routerConfigDir: string
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
let config: Config = { hasHud: true, hasFlow: true, isAnimated: true, hasSounds: true, hasGuard: true, hasAttributionGuard: true, volume: 0.6, hasLocalControl: true, ledgerPath: '', blocksFable: false, isStrict: false, hasOrchestration: false, maxSubagents: 16, maxSonnet: 'AUTO', maxHaiku: 'AUTO', isSubscriptionOnly: false, reasoningMode: 'AUTO', maxEffort: DEFAULT_CEILING, modelEffort: {}, profile: DEFAULT_PROFILE, routerConfigDir: '' }
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
type MountedBand = { requestId: string; width: number; input: HudInput; visual: Visual; agents: AgentStrip[]; glide: Glide; motion: boolean; lastCells: Map<string, string>; waiting: boolean; field: { tape: Tape; state: string; rows: number; width: number; graph: Graph | null } | null; flow: { input: FlowInput; width: number } | null }
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
  const fresh = (await read($, ledgerAtom)).receipts
  await mutateLedger($, l => receipts(l, drained.events))
  for (const x of drained.events) if (!fresh.some(old => old.requestId === x.requestId)) await tele($, { k: 'nwho', op: x.op, tier: String(x.tier).toLowerCase(), ms: typeof x.latencyMs === 'number' ? x.latencyMs : null })
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
// --- Prompt-cache policy (cache.ts): read, never written. ---
let cacheReading: CacheReading | null = null
let seenPermissionMode: string | null = null
const otherCockpits: { root: string; provenance: string }[] = []
const cacheFacts = async ($: EngineInterface): Promise<CacheReading> => {
  const version = await $.session.version().catch(() => null)
  // only the one setting is taken from the merged settings; nothing else in them is read, kept or shown
  const settings = await $.settings.read().catch(() => ({} as Record<string, unknown>))

  return readCache({
    version: version === null ? null : (version.base ?? version.version),
    forceFiveMinute: await $.env.get('FORCE_PROMPT_CACHING_5M').catch(() => undefined),
    envTtl: await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL').catch(() => undefined),
    settingTtl: settings['subagentPromptCacheTtl'],
    enableOneHour: await $.env.get('ENABLE_PROMPT_CACHING_1H').catch(() => undefined),
  })
}
const flowTierOf = (model: string | null | undefined): FlowTier | null => { const t = modelTier(model); return t === 'OTHER' ? null : t }
const flowInputOf = (input: HudInput, agents: readonly AgentStrip[], isWorking: boolean): FlowInput => ({
  task: input.task,
  // the same two witnesses as the HUD's own state: the engine says a turn runs and Cockpit saw the activity
  isWorking: isWorking && input.activity.isWorking,
  agents: agents.map(a => ({ tier: flowTierOf(a.model), running: a.state === 'running' })),
  mainTier: flowTierOf(input.meter.model),
})
const stopFacts = async ($: EngineInterface): Promise<StopFacts> => {
  const c = await loadStopCfg($)
  const last = (await checksOf($)).at(-1)

  return {
    policy: c.policy, script: c.script === null ? null : c.script.slice(c.script.lastIndexOf('/') + 1), pinned: c.pin !== null,
    timeoutSec: Math.round(c.timeoutMs / 1000), maxAttempts: c.maxAttempts, problems: c.problems, trust: c.script === null ? 'no script' : TRUST_WORDS[(await trustState($, c)).state],
    last: last === undefined ? null : { outcome: last.outcome, exit: last.exit, at: last.at },
  }
}

/** The owner-alert facts the doctor shows: the mode, the counts, the transport and the active conditions. */
const guardFacts = async ($: EngineInterface): Promise<DoctorFacts['guard']> => {
  const v = await guardView($)
  const transport = await transportText($)
  const view = isRecording(guardCfg) ? await guardSeen($, v.kept) : undefined
  const policy = view === undefined ? [] : policyLines(guardCfg, v.kept, view)

  return { enabled: guardCfg.enabled, recordOnly: guardCfg.recordOnly, label: guardLabel(guardCfg, v.state, v.kept), used: v.state.count, max: guardCfg.maxPerSession, cooldownSec: Math.round(guardCfg.cooldownMs / 1000), repeat: guardCfg.repeat, sound: guardCfg.sound, transport, policy }
}
/** Refreshes the git state and the meter together, as the pane's button asks. */
const refreshAll = async ($: EngineInterface): Promise<void> => {
  const git = refreshGit($)
  const meter = refreshMeter($)
  await Promise.all([git, meter])
}
const doctorFacts = async ($: EngineInterface): Promise<DoctorFacts> => {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? null
  const version = await $.session.version().catch(() => null)
  const host = version === null ? null : (version.base ?? version.version)
  let manifestVersion: string = UNKNOWN
  try { manifestVersion = /"version"\s*:\s*"([^"]+)"/.exec(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))?.[1] ?? UNKNOWN } catch { /* unreadable */ }
  // the install record lists plugin installs; only the cobalt-cockpit entries are taken from it
  let installs: Install[] | null = null
  try {
    const dir = (await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)) ?? (home === null ? null : `${home}/.claude`)
    if (dir !== null) {
      const record = JSON.parse(await $.fs.read(`${dir}/plugins/installed_plugins.json`)) as { plugins?: Record<string, unknown> }
      installs = Object.entries(record.plugins ?? {}).filter(([key]) => key.startsWith('cobalt-cockpit@')).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((v): Install => {
        const r = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>

        return { key, version: typeof r['version'] === 'string' ? r['version'] : null, path: typeof r['installPath'] === 'string' ? r['installPath'] : null }
      }))
    }
  } catch { installs = null }
  let enabled: string[] | null = null
  try {
    const settings = await $.settings.read()
    const plugins = (typeof settings['enabledPlugins'] === 'object' && settings['enabledPlugins'] !== null ? settings['enabledPlugins'] : {}) as Record<string, unknown>
    enabled = Object.entries(plugins).filter(([key, isEnabled]) => key.startsWith('cobalt-cockpit@') && isEnabled === true).map(([key]) => key)
  } catch { enabled = null }
  let listed: { files: number; bytes: number } | null = null
  const dir = await telemetryDir($)
  if (dir !== null) {
    try {
      const files = (await $.fs.list(dir)).filter(x => x.kind === 'file' && isTelemetryFile(x.name))
      listed = { files: files.length, bytes: files.reduce((n, x) => n + x.size, 0) }
    } catch { listed = null }
  }
  const ledger = await read($, ledgerAtom)
  const health = healthOf()

  return {
    version: manifestVersion, root: $.plugin.root, home, host, hostSupported: host === null ? null : isSupported,
    profile: config.profile, orchestration: config.hasOrchestration, reasoning: config.reasoningMode, router: (await read($, routerAtom)).mode,
    permissionMode: seenPermissionMode, installs, enabled, otherRegistrations: [...otherCockpits],
    telemetry: { enabled: health.enabled, dir, listed, writes: health.writes, failures: health.failures, permissions: health.permissions, shed: health.shed },
    cache: await cacheFacts($),
    agents: agentsOf(ledger.agents.map(a => (typeof a.start === 'number' && typeof a.end === 'number' ? a.end - a.start : null))),
    stop: await stopFacts($),
    guard: await guardFacts($),
    measurement: await boundWords($).catch(() => undefined),
  }
}

// --- Local telemetry (what is kept and how: telemetry.ts). The host follows `$` only into functions declared in this file. ---
const telemetryDir = async ($: EngineInterface): Promise<string | null> =>
  dirFor(await $.env.get('XDG_STATE_HOME').catch(() => undefined), await $.env.get('HOME').catch(() => undefined))

/** Reads a mode back with stat, so "restricted" is only ever said of a mode that was seen. A refusal or an error is "unverified"; nothing else is tried. */
const modeIs = async ($: EngineInterface, path: string, mode: string): Promise<boolean> => {
  try {
    const r = await $.process.run(['stat', '-c', '%a', path], { timeoutMs: 5000 })

    return r.exitCode === 0 && r.stdout.trim() === mode
  } catch { return false }
}

const restrictTelemetry = async ($: EngineInterface, dir: string): Promise<void> => {
  // the host's write has no mode argument, so the directories are asked to be 0700 first and each file 0600 once it exists
  let ok = true
  for (const d of [dir.slice(0, dir.lastIndexOf('/')), dir]) {
    try { ok = (await $.process.run(['mkdir', '-p', '-m', '700', d], { timeoutMs: 5000 })).exitCode === 0 && ok } catch { ok = false }
  }
  // mkdir -m leaves an existing directory as it was, so the mode is read back rather than assumed
  health.permissions = ok && await modeIs($, dir, '700') ? 'verified' : 'unverified'
}

const pruneTelemetry = async ($: EngineInterface, dir: string, now: number): Promise<void> => {
  try {
    const listed = (await $.fs.list(dir)).filter(x => x.kind === 'file' && !x.isLink && isTelemetryFile(x.name))
    // exact telemetry file names only, inside our own directory; a refusal is final and is not worked around
    const doomed = new Set([...expiredFiles(listed.map(x => x.name), now), ...shedFiles(listed.filter(x => !expiredFiles([x.name], now).length), TOTAL_CAP_BYTES, new Set())])
    for (const name of doomed) {
      const r = await $.process.run(['rm', '-f', '--', `${dir}/${name}`], { timeoutMs: 5000 })
      if (r.exitCode === 0) health.shed++
    }
  } catch { /* retention is best effort */ }
}

/** Records one observed event. Never throws; writes are taken one at a time, and only this process's own segment is ever written. */
const tele = ($: EngineInterface, event: Record<string, unknown>): Promise<void> => {
  if (!health.enabled) return Promise.resolve()
  teleQueue.tail = teleQueue.tail.then(async () => {
    try {
      const dir = await telemetryDir($)
      if (dir === null) { health.failures++; return }
      const at = await $.clock.now()
      const e = cleanEvent({ v: 1, t: at, ...event })
      if (e === null) { health.failures++; return }
      health.dir = dir
      if (prepared.dir !== dir) {
        prepared.dir = dir
        // a smaller segment may be asked for (never a larger one); it exists so the sealing can be exercised without writing 64 KiB
        const asked = Number(await $.env.get('COBALT_TELEMETRY_SEGMENT_BYTES').catch(() => undefined))
        if (Number.isInteger(asked) && asked >= 512 && asked < limits.segmentCap) limits.segmentCap = asked
        await restrictTelemetry($, dir); await pruneTelemetry($, dir, at)
      }
      const line = encode(e)
      const month = monthKey(at)
      segment.sid ??= newSid(at)
      // a full segment is sealed and never written again; a new month starts a new one
      if (segment.month !== month || segment.bytes + line.length + 1 > limits.segmentCap) { segment.n = segment.month === null ? 0 : segment.n + 1; segment.month = month; segment.lines = []; segment.bytes = 0 }
      segment.lines.push(line); segment.bytes += line.length + 1
      const path = `${dir}/${segmentName(month, segment.sid, segment.n)}`
      // this process is the only writer of this file, so the whole segment is rewritten from memory with nothing read back
      await $.fs.write(path, `${segment.lines.join('\n')}\n`)
      if (!segment.verified.has(path)) {
        segment.verified.add(path)
        let ok = false
        try { ok = (await $.process.run(['chmod', '600', path], { timeoutMs: 5000 })).exitCode === 0 } catch { ok = false }
        if (!ok || !(await modeIs($, path, '600'))) health.permissions = 'unverified'
      }
      health.writes++
    } catch { health.failures++ }
  })

  return teleQueue.tail
}

/** Reads the events of a window. Unreadable files and damaged lines are counted, not thrown. */
const readStats = async ($: EngineInterface, win: { label: string; days: number | null }) => {
  const now = await $.clock.now()
  const dir = await telemetryDir($)
  const texts: (string | null)[] = []
  if (dir !== null) {
    let names: string[] = []
    try { names = (await $.fs.list(dir)).filter(x => x.kind === 'file' && !x.isLink).map(x => x.name) } catch { /* no directory yet */ }
    for (const name of filesFor(names, now, win)) texts.push(await $.fs.read(`${dir}/${name}`).catch(() => null))
  }

  return gather(texts, now, win)
}

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
  mounted.visual.active || mounted.agents.some(a => a.state === 'running') || mounted.field !== null || (mounted.flow !== null && flowOf(mounted.flow.input).live)

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
    // The Neural Flow: the marker moves only while the flow's input says work is live; the per-key diff drops identical frames.
    if (mounted.flow !== null) {
      const f = flowOf(mounted.flow.input)
      const grid = f.live ? flowGrid(f, mounted.flow.width, { now, motion: true, light: isLight }) : null
      if (grid !== null) await blit(FLOW_KEY, grid.encode(), 1, mounted.flow.width)
    }
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

/**
 * The refusal text when the session's requests are refused because it is not on the subscription, else null. With the
 * policy on, only a confirmed subscription passes: an API-style configuration, an unconfirmed sign-in (`unverified`), a
 * state not yet read and a state that cannot be read are each a refusal, and each says which.
 */
const apiRefusal = async ($: EngineInterface): Promise<string | null> => {
  // a host this plugin stands by on is not this plugin's to police
  if (!config.isSubscriptionOnly || !isSupported) return null
  try {
    let mode = (await read($, authAtom))?.mode
    if (mode !== 'subscription' && mode !== 'api') {
      // not read yet, or not confirmed: read once more before refusing, so a sign-in made since is seen
      await quiet(() => probeAuth($, false))
      mode = (await read($, authAtom))?.mode
    }
    if (mode === 'subscription') return null

    return mode === 'api' ? API_REFUSAL : AUTH_UNVERIFIED_REFUSAL
  } catch {
    return AUTH_UNREADABLE_REFUSAL
  }
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

/**
 * The guard's check records are kept twice: in the Run Ledger (per session, with the rest of the run) and in a durable, versioned
 * store key of their own, because a task is carried into a session whose Ledger starts empty. A budget, a verifier identity or a
 * hold's history read from either is read from both; a record in one is never forgotten because the other was reset.
 */
const CHECKS_KEY = 'stop-checks'
const durableChecks = async ($: EngineInterface): Promise<CheckRecord[]> => {
  const stored = (await $.store.get(CHECKS_KEY).catch(() => undefined)) as { v?: unknown; checks?: unknown } | undefined

  return stored?.v === 1 ? validChecks(stored.checks) : []
}
const checksOf = async ($: EngineInterface): Promise<CheckRecord[]> => {
  const mine = (await read($, ledgerAtom)).stopChecks ?? []
  const durable = await durableChecks($)
  const keyOf = (c: CheckRecord) => `${c.uid}|${c.at}|${c.outcome}|${c.complete}|${c.verifier}|${c.exit}|${c.tree}`
  // a multiset union: a record held by both is one record, two alike (same millisecond) are two
  const count = (list: readonly CheckRecord[]) => list.reduce((m, c) => m.set(keyOf(c), (m.get(keyOf(c)) ?? 0) + 1), new Map<string, number>())
  const inLedger = count(mine)
  const missing: CheckRecord[] = []
  const used = new Map<string, number>()
  for (const c of durable) {
    const k = keyOf(c)
    const n = (used.get(k) ?? 0) + 1
    used.set(k, n)
    if (n > (inLedger.get(k) ?? 0)) missing.push(c)
  }

  return retainChecks([...missing, ...mine].map((c, i) => ({ c, i })).sort((a, b) => a.c.at - b.c.at || a.i - b.i).map(x => x.c))
}
const keepCheck = async ($: EngineInterface, rec: CheckRecord): Promise<void> => {
  await update($, ledgerAtom, old => ({ ...old, stopChecks: boundedChecks(old.stopChecks ?? [], rec) }))
  const all = await durableChecks($)
  await hush(() => $.store.set(CHECKS_KEY, { v: 1, checks: boundedChecks(all, rec) }))
}

/**
 * A task saved before the Stop guard's hold was a field of its own is settled once, from the guard's own records
 * (see migrateStopHold). Idempotent, and run before any action can touch the task, so no path sees the old shape.
 */
const adoptLegacyHold = async ($: EngineInterface): Promise<void> => {
  const held = await read($, taskAtom)
  if (held === null || held.guardSchema === 1) return
  const ledger = await read($, ledgerAtom)
  const checks = await checksOf($)
  const now = await $.clock.now()
  // A hold added by the migration is reconciled with the rest of the task at once: a saved DONE / 100% cannot stand beside it,
  // and the next prompt finds a held, blocked task rather than a finished one.
  await update($, taskAtom, old => {
    if (old === null) return old
    const migrated = migrateStopHold(old, checks, ledger.stopDropped ?? 0, stopCfg.maxAttempts, now)

    return migrated.stopHold !== undefined && old.stopHold === undefined ? settle(migrated).task : migrated
  })
}

/**
 * Resetting or clearing the task presentation does not discharge an unverified obligation: a task that edited, touched files or was
 * held by the guard, and was not completed by it, leaves the obligation behind. The next Stop (with or without a new task) checks.
 */
const carryObligation = async ($: EngineInterface, abandoned: Task | null, how: string): Promise<void> => {
  if (abandoned === null || !guardEnforcing() || isGuardOwned(abandoned)) return
  if (abandoned.edited !== true && abandoned.files.length === 0 && !isGuardHeld(abandoned)) return
  const at = await $.clock.now()
  await update($, owedAtom, held => held ?? { at, why: `a task with unverified work was abandoned by ${how}` })
}

/** A held task that a person abandons (a reset, a /clear) stays in the record as what it was: not a pass, not marked done. */
const recordAbandoned = async ($: EngineInterface, abandoned: Task | null, how: string): Promise<void> => {
  if (abandoned === null || !isGuardHeld(abandoned)) return
  const at = await $.clock.now()
  await keepCheck($, { taskId: abandoned.id, uid: uidOf(abandoned), verifier: 'released', complete: true, name: how.replace(/^\/(cockpit )?/, ''), sha: null, at, outcome: 'released', exit: null, ms: null, tree: null, summary: oneLine(`abandoned by ${how} while held: ${abandoned.stopHold?.reason ?? ''}`, 600), hasSummary: true })
  await hush(() => persist($))
}

/** Applies a change to the task, settles what follows from it, and plays what it earned. */
const change = async ($: EngineInterface, apply: (task: Task, now: number) => Task): Promise<Task | null> => {
  await hush(() => adoptLegacyHold($))
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
    const root = await verifiedGitRoot($)
    // HUD reads must not run repository-controlled clean/process filters either.
    const reliable = root !== null && !('why' in await gitInputs($, root)) && await gitFiltersReliable($, root)
    const status = reliable ? await bounded($, ['git', ...GIT_SAFE, '-C', root!, 'status', '--porcelain=v2', '--branch'], {
      timeoutMs: GIT_TIMEOUT_MS,
    }) : { exitCode: 128, stdout: '' }
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
      const top = await bounded($, ['git', ...GIT_SAFE, 'rev-parse', '--show-toplevel'], { timeoutMs: GIT_TIMEOUT_MS })
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

const routerPolicy = (): RouterPolicy => ({ profile: config.profile, hasOrchestration: config.hasOrchestration, hasHaiku: config.maxHaiku !== 0, hasSonnet: config.maxSonnet !== 0 })

let routerDirSeen: { option: string; cwd: string; dir: string | null; refused: string | null } | null = null

/**
 * The operator's router configuration directory for JEV mode, resolved, or why
 * it is not used. It must be the operator's own: a directory inside the project
 * is refused, because a repository must never be able to choose where the
 * router sends a request or which key it presents. Cockpit only names the
 * directory to the router's child process; it does not read or write it.
 */
const routerDir = async ($: EngineInterface): Promise<{ dir: string | null; refused: string | null }> => {
  const option = config.routerConfigDir
  if (option === '') return { dir: null, refused: null }
  if (routerDirSeen !== null && routerDirSeen.option === option && routerDirSeen.cwd === cwd) return routerDirSeen
  const judged = await (async (): Promise<{ dir: string | null; refused: string | null }> => {
    let path = option
    if (option.startsWith('~/')) {
      const home = await $.env.get('HOME').catch(() => undefined)
      if (home === undefined || !home.startsWith('/')) return { dir: null, refused: 'HOME is not set, so ~ could not be resolved' }
      path = `${home.replace(/\/+$/, '')}${option.slice(1)}`
    }
    const real = await canonicalResource($, path)
    const root = await canonicalResource($, cwd || '.')
    if (real === '*' || real === '/') return { dir: null, refused: 'it could not be resolved to a directory' }
    if (root === '*') return { dir: null, refused: 'the project root could not be resolved, so it could not be told apart from the project' }
    if (real === root || real.startsWith(`${root}/`) || root.startsWith(`${real}/`)) return { dir: null, refused: 'it is inside this project (or contains it); a router configuration must be your own, outside any repository' }

    return { dir: real, refused: null }
  })()
  routerDirSeen = { option, cwd, ...judged }

  return judged
}

/** The environment of a router child: nothing, except the operator's directory in JEV mode. */
const routerEnv = async ($: EngineInterface, mode: ActiveMode): Promise<Record<string, string> | undefined> => {
  if (mode !== 'JEV') return undefined
  const { dir } = await routerDir($)

  return dir === null ? undefined : { DECISION_ROUTER_CONFIG_DIR: dir }
}

/**
 * Runs the router's own CLI once per body, at the same time, and reads each
 * answer. This is the only place a router process starts, and it starts only
 * for a mode the person selected. Every request is started before the first
 * await, so nothing can come between the caller's last check and the start.
 * No credential enters this process: the router reads its own key.
 */
const askRouter = ($: EngineInterface, mode: ActiveMode, bodies: readonly string[], env: Record<string, string> | undefined): Promise<(RouterAnswer | null)[]> =>
  Promise.all(bodies.map(async body => {
    try {
      const r = await $.process.run(routerArgv(mode, body), { timeoutMs: CALL_TIMEOUT_MS[mode], ...(env === undefined ? {} : { env }) })

      return r.exitCode === 0 && !r.isStdoutTruncated ? answerOf(r.stdout) : null
    } catch { return null }
  }))

/**
 * The router's reading of a new task, when one is selected and the rules have
 * not already settled the route. Returns the one advisory line an accepted
 * recommendation adds to the task, or null. Whatever happened is recorded as
 * it happened; a reading begun before a switch is dropped, not used.
 */
const routeTask = async ($: EngineInterface, text: string, facts: Parameters<typeof deterministicRoute>[0]): Promise<string | null> => {
  const held = await read($, routerAtom)
  // what happened at the start of this task is told to telemetry as it was: no router, or the rules settling it, or a router asked
  if (held.mode === 'OFF') { await tele($, { k: 'route', mode: 'OFF', path: 'off', calls: 0, answered: 0, outcome: 'none', provider: null, ms: null }); return null }
  const mode = held.mode
  // Decided more cheaply by rule: a mandatory consultation, or a route the rules read off the task.
  const rules = deterministicRoute(facts)
  if (mandatoryGrounds(facts).length > 0 || rules.route !== 'direct') { await tele($, { k: 'route', mode, path: 'rules', calls: 0, answered: 0, outcome: 'none', provider: null, ms: null }); return null }
  const state = routerStateOf(text, mode)
  const calls = state === null ? [] : callsFor(state)
  if (state === null && !carriesCredential(text)) return null
  const env = calls.length === 0 ? undefined : await routerEnv($, mode)
  const started = await $.clock.now()
  // the last look before anything is sent: a switch made meanwhile sends nothing
  if ((await read($, routerAtom)).epoch !== held.epoch) return null
  const answers = calls.length === 0 ? [] : await askRouter($, mode, calls.map(c => c.body), env)
  const at = await $.clock.now()
  const reading = calls.length === 0 ? { route: null, features: {}, agreed: 0, invalid: 'prompt withheld: credential-shaped text is never shown to a router' } : readAnswers(mode, calls, answers)
  const verdict = reading.route === null ? null : adjudicate(reading.route, facts, routerPolicy())
  const decision = decisionOf({ at, mode, calls: calls.length, answers, wallMs: calls.length === 0 ? null : at - started, reading, rules: rules.route, verdict })
  if ((await read($, routerAtom)).epoch !== held.epoch) return null
  await update($, routerAtom, s => withDecision(s, held.epoch, decision))
  await mutateLedger($, l => ({ ...l, routing: addDecision(l.routing ?? [], decision) }))
  await tele($, { k: 'route', mode, path: calls.length > 0 ? 'router' : 'rules', calls: decision.calls, answered: decision.answered, outcome: decision.outcome, provider: decision.provider, ms: decision.wallMs })
  // An Opus reading the rules refuse goes to the person, never to the model.
  const notice = operatorNotice(mode, reading, verdict)
  if (notice !== null) await quiet(() => $.ui.toast(notice, { timeoutMs: 15_000 }))

  return decision.outcome === 'accepted' && reading.route !== null ? adviceLine(mode, reading.route) : null
}

/** Switches the session's router and, for a provider, checks once that it answers. Returns what to tell the person. */
const selectRouter = async ($: EngineInterface, mode: RouterMode): Promise<string> => {
  const switched = await update($, routerAtom, s => switchRouter(s, mode))
  if (mode === 'OFF') return 'ROUTER / OFF · deterministic policy only. No router is asked in this session.'
  // One fixed question that carries nothing of the session, so the mode's state is seen, not assumed.
  const probe = callsFor(AVAILABILITY_STATE)[0]!
  const dir = mode === 'JEV' ? await routerDir($) : { dir: null, refused: null }
  const env = await routerEnv($, mode)
  const started = await $.clock.now()
  if ((await read($, routerAtom)).epoch !== switched.epoch) return `ROUTER / ${routerLine(await read($, routerAtom))}`
  const [answer = null] = await askRouter($, mode, [probe.body], env)
  const wall = (await $.clock.now()) - started
  const isUp = answer !== null && answer.provider === PROVIDER[mode] && answer.failure === null && answer.choice !== null
  const detail = isUp ? `${answer.model ?? PROVIDER[mode]} · ${wall}ms` : answer === null ? 'no answer' : answer.failure ?? `answered by ${answer.provider}`
  const now = await update($, routerAtom, s => s.epoch !== switched.epoch ? s : { ...s, link: isUp ? 'connected' as const : 'unavailable' as const, detail })

  return [
    `ROUTER / ${routerLabel(now)}${isUp ? ` · ${detail}` : ''}`,
    mode === 'JEV'
      ? `JEV is the TypeSafe API, reached through the local decision router${dir.dir !== null ? ` with the router configuration at ${dir.dir} (routerConfigDir)` : dir.refused !== null ? ` under its own JEV switch: routerConfigDir was NOT used because ${dir.refused}` : ' under its own JEV switch (no routerConfigDir is set)'}. Each prompt you submit outside a planned task counts as a new task: when the rules do not settle it, only fixed-vocabulary engineering keywords and a size bucket are sent to JEV in ten small requests. Nothing else is sent, and a prompt in which credential-shaped text is recognised is withheld (a pattern list, not a guarantee: do not paste secrets).`
      : 'NobodyWho is asked through the local decision router with its local provider only (--mode local); an answer from any other provider is discarded. Each prompt you submit outside a planned task counts as a new task and is asked about when the rules do not settle it.',
    'Advisory only: Cockpit\'s rules still decide admission, ownership, mandatory consultations and verification gates. This session only; a new session starts OFF.',
  ].join('\n')
}

/** The engine's own dialog for the three modes; null when dismissed or when there is no one to ask. */
const pickRouter = async ($: EngineInterface, current: RouterMode): Promise<RouterMode | null> => {
  try {
    await update($, visualAtom, old => ({ ...old, waiting: old.waiting + 1 }))
    stopTicker()
    try {
      return routerModeOf(await $.ui.ask(`Which router should advise this session? (now ${current})`, { options: [...ROUTER_MODES], header: 'Router' }))
    } finally {
      await update($, visualAtom, old => ({ ...old, waiting: Math.max(0, old.waiting - 1) }))
    }
  } catch { return null }
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

const isInsidePlugin = ($: EngineInterface, path: string): boolean => isInsideFolder($.plugin.root, path)

const allowInstructionFile = async ($: EngineInterface, path: string, isMoved = false): Promise<{ deny: string } | null> => {
  const absolute = path.startsWith('/') ? path : `${cwd}/${path}`
  // A check that cannot be made is not an answer: it throws, and the guard refuses the call (see `failClosed`).
  // A command that changes directory first writes somewhere the session's directory says nothing about: it is new.
  const hasFile = !isMoved && await $.fs.exists(absolute)
  const task = await read($, taskAtom)
  if (hasFile || task?.hasInstructionFileRequest === true) return null
  const name = basename(path)
  const answer = await ask(
    $,
    `Claude is about to create ${name} at ${oneLine(absolute, 80)}. A prompt that mentions it is not permission; only this answer, or a /init you typed, is. Create it?`,
    'New file',
    ['Block', 'Create'],
  )
  if (answer === 'Create') return null

  return {
    deny: `Cobalt Cockpit: ${name} is only created when the user asks for one in this repository, and that was not confirmed. It was not written. Do not create it another way; say so if you think one would help.`,
  }
}

/** The guards: a `{ deny }` when the call must not run, else null. Each guard is judged on its own, and a guard that throws refuses. */
const guard = async ($: EngineInterface, e: { tool: string; agentId?: string } & Record<string, unknown>): Promise<{ deny: string } | null> => {
  if (e.tool === 'Bash') {
    // a Bash call whose command is not text cannot be judged by any guard, so it is refused, not read as an empty command
    if ((config.hasAttributionGuard || config.hasGuard) && typeof e['command'] !== 'string') {
      return { deny: 'Cobalt Cockpit: this Bash call carries no command text the guards can read, so it did not run.' }
    }
    const command = typeof e['command'] === 'string' ? e['command'] : ''
    if (config.hasAttributionGuard) {
      const attribution = await failClosed('attribution', 'Bash', async () => {
        const found = attributionInCommand(command)[0]

        return found === undefined ? null : attributionDeny(found, 'this command')
      })
      if (attribution !== null) return attribution
      const instruction = await failClosed('instruction-file', 'Bash', async () => {
        const isMoved = /\b(cd|pushd|popd)\b|--chdir|\s-C\s?\S/.test(command)
        for (const path of instructionFilesWritten(command)) {
          const refusal = await allowInstructionFile($, path, isMoved && !path.startsWith('/'))
          if (refusal !== null) return refusal
        }

        return null
      })
      if (instruction !== null) return instruction
    }
    if (config.hasGuard) {
      return failClosed('destructive-command', 'Bash', async () => {
        const findings = assessCommand(command, { cwd, home })
        if (findings.length > 0 && !(await confirmDestructive($, command, findings, e.agentId !== undefined))) {
          return {
            deny: `Cobalt Cockpit: the user did not approve this destructive command (${findings
              .map(one => one.title)
              .join(', ')}). It did not run. Do not retry it or reach the same effect another way; ask the user how to proceed.`,
          }
        }

        return null
      })
    }

    return null
  }

  if (!config.hasAttributionGuard || (e.tool !== 'Edit' && e.tool !== 'Write' && e.tool !== 'NotebookEdit' && e.tool !== 'MultiEdit')) return null
  const attribution = await failClosed('attribution', e.tool, async () => {
    if (e.tool !== 'MultiEdit') return editGuard($, e)
    if (!Array.isArray(e['edits'])) throw new TypeError('MultiEdit without a list of edits')
    for (const one of e['edits'] as Record<string, unknown>[]) {
      const refusal = await editGuard($, { tool: 'Edit', file_path: e['file_path'], old_string: one['old_string'], new_string: one['new_string'] })
      if (refusal !== null) return refusal
    }

    return null
  })
  if (attribution !== null) return attribution

  // Creating an instruction file is asked about whatever tool creates it: an Edit with an empty old_string, a MultiEdit and a
  // NotebookEdit create a file as a Write does. A file that exists, or that the person asked for (/init), is not asked about.
  return failClosed('instruction-file', e.tool, async () => {
    const path = String(e['file_path'] ?? e['notebook_path'] ?? '')
    return path === '' || isInsidePlugin($, path) || !isInstructionFile(path) ? null : allowInstructionFile($, path)
  })
}

/** The attribution guard over one Edit, Write or NotebookEdit. */
const editGuard = async ($: EngineInterface, e: { tool: string } & Record<string, unknown>): Promise<{ deny: string } | null> => {
  const path = String(e['file_path'] ?? e['notebook_path'] ?? '')
  // this plugin's own sources and tests spell the patterns out
  if (path === '' || isInsidePlugin($, path)) return null
  const after = String(e['new_string'] ?? e['content'] ?? e['new_source'] ?? '')
  let added: Attribution[] = []
  if (e.tool === 'Edit') {
    added = addedAttribution(String(e['old_string'] ?? ''), after)
  } else if (findAttribution(after).length > 0) {
    // an unreadable file reads as empty, which counts every attribution line as added: the stricter reading
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
  return null
}

/**
 * A fingerprint of the project's working tree, from git, that depends on file contents and not on how git
 * stages them: every file that differs from the commit it was taken against (changed, staged, or untracked)
 * with the hash of its content, and the paths deleted. A commit, an add or a stash therefore leaves it
 * unchanged, and any tool that changes a tracked or unignored file changes it, whatever the tool is called and
 * whether or not it reports a diff. A read does not. It is `base:hash`; `base` is the commit it is measured
 * against and is passed back to measure the same way later. Null where there is no repository, no commit yet,
 * a git command failed, was cut short or timed out, or more than TREE_FILES files differ; no change outside
 * Edit, Write and a Bash edit diff can then be observed. Ignored files are not seen.
 */
/**
 * Every git call of the fingerprint ignores what a repository's own configuration could use to hide a change: replacement refs
 * (a replaced blob makes HEAD look like the working file; reproduced), a filesystem monitor that reports nothing, a submodule
 * set to ignore=all (reproduced), an untracked cache. A user's git configuration is not trusted to describe the work.
 */
const TREE_FILES = 20_000
const HASH_CHUNK = 400
/** Most ignored and watched files one fingerprint measures. Measured: 100,000 files take about 0.65 s; beyond it the tree is UNKNOWN. */
const IGNORED_FILES = 100_000
/** The whole ignored-file measurement of one fingerprint may take this long; beyond it the tree is UNKNOWN. */
const FINGERPRINT_BUDGET_MS = 25_000
/** The whole fingerprint may take this long between its steps (each process has its own timeout too); beyond it the tree is UNKNOWN. */
const FINGERPRINT_DEADLINE_MS = 90_000
/** Why the latest fingerprint was unknown, in words for the Ledger and HUD. Empty after a known one. */
let treeWhy = ''
/** measureCommit's reason for a tracked file that changed while it was read. */
const TRACKED_RACE = 'a tracked file changed while it was being measured'
/**
 * One measurement of the working tree. `stamp` is null where it could not be taken, with `why`; `raced` when the only cause
 * was a file that changed or vanished while it was read; `noRepo` only where the session is outside any Git repository
 * (outsideGit), which is the one case a goal check may be accepted without a fingerprint (as UNPROTECTED); `inRepo` when there
 * is positive evidence of a repository here, measurable or not. Returned whole so that concurrent measurements cannot swap
 * each other's reasons.
 */
type TreeReading = { stamp: string | null; why: string; raced: boolean; noRepo: boolean; inRepo: boolean }
const treeStamp = async ($: EngineInterface, base?: string): Promise<string | null> => {
  const reading = await measureTree($, base)
  treeWhy = reading.why

  return reading.stamp
}
const measureTree = async ($: EngineInterface, base?: string): Promise<TreeReading> => {
  let why = ''
  let raced = false
  let noRepo = false
  let inRepo = false
  const unknown = (reason: string, isRace = false): null => { why = reason; raced = isRace; return null }
  const stamp = await (async (): Promise<string | null> => { try {
    const began = await $.clock.now()
    const overdue = async () => (await $.clock.now()) - began > FINGERPRINT_DEADLINE_MS
    const late = `measuring the working tree took longer than ${FINGERPRINT_DEADLINE_MS / 1000}s`
    const sh = async (argv: string[]): Promise<string | null> => {
      const r = await bounded($, ['git', ...GIT_SAFE, ...argv], { timeoutMs: GIT_TIMEOUT_MS })

      return r.exitCode === 0 && !r.isStdoutTruncated ? r.stdout : null
    }
    // `git ls-files -o` exits 0 and only warns on stderr when a directory cannot be opened ("could not open directory"), leaving the
    // files in it out of the listing (reproduced with real git). Any stderr from a listing means it was not complete: UNKNOWN.
    let incomplete = ''
    const listing = async (argv: string[]): Promise<string | null> => {
      const r = await bounded($, ['git', ...GIT_SAFE, ...argv], { timeoutMs: GIT_TIMEOUT_MS })
      if (r.exitCode === 0 && r.stderr.trim() !== '') incomplete = oneLine(r.stderr, 160)

      return r.exitCode === 0 && !r.isStdoutTruncated && r.stderr.trim() === '' ? r.stdout : null
    }
    const top = await verifiedGitRoot($)
    if (top === null) {
      // outside any repository is not the same as a repository Git cannot read: only the first may go unprotected
      const place = await outsideGit($)
      if (place === 'outside') { noRepo = true; return unknown('this project is not a Git repository') }
      if (place === 'unknown') return unknown('Git could not say whether this is a Git repository (it failed or timed out)')
      inRepo = true
      return unknown('a Git repository is here, but Git could not read it, its work tree is not the session directory, or its identity could not be verified')
    }
    inRepo = true
    const at = (...argv: string[]) => sh(['-C', top, ...argv])
    // Git's excludes, attributes and alternates files are checked before any Git command below reads them (gitInputs).
    const inputs = await gitInputs($, top)
    if ('why' in inputs) return unknown(inputs.why)
    if (!(await gitFiltersReliable($, top))) return unknown('an active clean/process filter or unreadable filter configuration makes the working tree unreliable')
    // Bytes read by the whole fingerprint, against FINGERPRINT_TOTAL_BYTES.
    const budget: ReadBudget = { bytes: 0 }
    // Reads regular files already inspected, then inspects them again: a file replaced (by a link to a device, say) or rewritten in
    // between is not believed. `follow` as when they were inspected.
    const hashFiles = async (names: string[], seen: Inspected[], follow: boolean): Promise<string[] | { why: string; raced?: true }> => {
      if (names.length === 0) return []
      for (const s of seen) {
        if (s.size > FINGERPRINT_FILE_BYTES) return { why: `a file is larger than ${FINGERPRINT_FILE_BYTES / GIB} GiB, more than the fingerprint reads` }
        budget.bytes += s.size
      }
      if (budget.bytes > FINGERPRINT_TOTAL_BYTES) return { why: `the working tree holds more than ${FINGERPRINT_TOTAL_BYTES / GIB} GiB to read, more than the fingerprint reads` }
      const r = await bounded($, ['git', ...GIT_SAFE, '-C', top, 'hash-object', '--no-filters', '--', ...names], { timeoutMs: GIT_TIMEOUT_MS })
      const hashes = gitAnswered(r) ? hashesOf(r.stdout, names.length) : null
      if (hashes === null) return { why: 'a file could not be hashed (deleted meanwhile, unreadable, not present in a sparse checkout, or its process reached a time or memory limit)' }
      const again = await inspectPaths($, top, names, follow)
      if (again === null) return { why: 'a file could not be inspected again after it was read' }
      if (again.some((s, k) => s.identity !== seen[k]!.identity)) return { why: 'a file changed while it was being measured', raced: true }
      return hashes
    }
    // The files (and links) under a directory, for what git cannot hash or list file by file. A directory that exists but cannot be read
    // in full is never "missing" and never a partial answer: the caller makes the tree UNKNOWN. Nothing is read but the listing.
    const walk = async (dir: string): Promise<{ names: string[] } | { missing: true } | { why: string }> => {
      const f = await bounded($, ['find', '-H', dir, '(', '-type', 'f', '-o', '-type', 'l', ')', '-print0'], { timeoutMs: GIT_TIMEOUT_MS }).catch(() => null)
      if (f !== null && f.exitCode === 0 && !f.isStdoutTruncated) return { names: f.stdout.split('\0').filter(Boolean).sort() }
      // "missing" only when the system says there is no such file: a path that is there but cannot be entered (permission denied on a
      // parent) must not become a constant "missing" that a writer can keep equal at both measurements. C locale: stable wording.
      const there = await bounded($, ['stat', '--', dir], { timeoutMs: GIT_TIMEOUT_MS, env: { LC_ALL: 'C' } }).catch(() => null)
      if (f !== null && f.exitCode !== 0 && there !== null && there.exitCode !== 0 && !there.isStderrTruncated && ENOENT.test(there.stderr.replace(/\n$/, ''))) return { missing: true }

      return { why: `${dir} exists but could not be listed in full (unreadable, too large or timed out)` }
    }
    const head = base ?? (await at('rev-parse', '--verify', 'HEAD'))?.trim()
    if (!head) return unknown('no commit to measure against')
    const tracked = await measureCommit($, top, head, budget)
    if ('why' in tracked) return unknown(tracked.why, tracked.why === TRACKED_RACE)
    if (!(await gitFiltersReliable($, top, tracked.entries.map(e => e.path)))) return unknown('active commit-path filters make the working tree unreliable')
    if (await overdue()) return unknown(late)
    // -O/dev/null: a configured diff.orderFile is read whole (measured: one pointed at a device exhausted memory); no order is needed here.
    const changed = await at('diff', head, '-O/dev/null', '--no-renames', '--ignore-submodules=none', '--name-only', '-z', '--diff-filter=d')
    const deleted = await at('diff', head, '-O/dev/null', '--no-renames', '--ignore-submodules=none', '--name-only', '-z', '--diff-filter=D')
    const untracked = await listing(['-C', top, 'ls-files', '-o', '--exclude-standard', '-z'])
    // What git ignores is not hashed, but its NAMES are part of the state: a nested .gitignore of `*`, a line in .git/info/exclude or in
    // any global ignore file moves a new file out of the untracked list and into this one, which is a change in itself (reproduced).
    // Every ignored FILE is listed (no --directory): a directory's own stat does not move when a file inside it is rewritten, so a
    // collapsed entry would prove nothing about its contents. Operator-authorized volatile prefixes are pruned at the listing itself.
    const ignored = await listing(['-C', top, 'ls-files', '-o', '-i', '--exclude-standard', '-z', '--', '.', ...stopCfg.volatile.map(v => `:(exclude)${v}`)])
    // Paths the index is told to ignore (assume-unchanged: a lowercase tag; skip-worktree: S or s) are invisible to diff. They are
    // hashed from the disk instead; a path that cannot be hashed (a sparse-checkout file that is not there) makes the tree unknown.
    const flags = await at('ls-files', '-v', '-z')
    if (incomplete !== '') return unknown(`git could not read part of the work tree, so its listing is incomplete (${incomplete})`)
    if (changed === null || deleted === null || untracked === null) return unknown('a git command failed, timed out, reached a resource limit or its output was cut short')
    if (ignored === null) return unknown('the ignored-entry listing failed, timed out or was cut short')
    if (flags === null) return unknown('the index listing failed, timed out or was cut short by the host output limit')
    const hidden = flags.split('\0').filter(l => l.length > 2 && (/[a-z]/.test(l[0] as string) || l[0] === 'S')).map(l => l.slice(2))
    // The sources that decide what "untracked" means are part of the state, so adding a file to them is a change in itself. They were
    // inspected before Git read them; one that is gone is 'none', and one that cannot be read or changed meanwhile is UNKNOWN.
    const sourceList = inputs.filter(n => n.source)
    const readable = sourceList.filter((n): n is GitInput & { path: string; seen: Inspected } => n.seen?.kind === 'file')
    const sourceHashes = await hashFiles(readable.map(n => n.path), readable.map(n => n.seen), true)
    if ('why' in sourceHashes) return unknown(`the excludes or attributes files: ${sourceHashes.why}`, sourceHashes.raced)
    const sources = sourceList.map(n => (n.path === null ? '-' : n.seen?.kind === 'file' ? sourceHashes[readable.indexOf(n as typeof readable[number])]! : 'none'))
    // Operator-authorized volatile directories (caches, build output) leave the IGNORED part of the stamp; nothing else is excluded.
    const ignoredNames = ignored.split('\0').filter(Boolean).sort().filter(name => !stopCfg.volatile.some(v => name.startsWith(v) || `${name}/` === v))
    if (ignoredNames.length > IGNORED_FILES) return unknown(`more than ${IGNORED_FILES} ignored files (list the generated directories in stopVolatile, or the check runs every time)`)
    // git lists an ignored directory that holds its own repository (a clone, a vendored checkout) as ONE entry even without
    // --directory (reproduced with real git): its own stat does not move when a file inside is rewritten. Those entries are expanded to
    // their files under the same bound; one that cannot be listed in full makes the tree unknown.
    const embedded: string[] = []
    for (const entry of ignoredNames.filter(name => name.endsWith('/'))) {
      if (await overdue()) return unknown(late)
      const listed = await walk(`${top}/${entry.replace(/\/+$/, '')}`)
      if ('why' in listed) return unknown(listed.why)
      if ('missing' in listed) return unknown(`${entry} vanished while it was listed`, true)
      embedded.push(...listed.names)
      if (embedded.length + ignoredNames.length > IGNORED_FILES) return unknown(`more than ${IGNORED_FILES} ignored files (list the generated directories in stopVolatile, or the check runs every time)`)
    }
    // The verifier and the operator's watched paths are measured whatever git says about them, following a link the operator named: a
    // file by its content; a DIRECTORY by its files, listed (find follows no link below the start) and measured like the ignored files,
    // with the same bound. A watched device, FIFO or socket is never read: UNKNOWN.
    const watched: string[] = []
    const watchedFiles: string[] = []
    for (const file of [stopCfg.script, ...stopCfg.watch]) {
      if (file === null || file === undefined) continue
      if (await overdue()) return unknown(late)
      const full = file.startsWith('/') ? file : `${top}/${file}`
      const seen = await inspectPaths($, top, [full], true)
      if (seen === null) return unknown(`the watched path ${file} could not be inspected`)
      const s = seen[0]!
      if (s.kind === 'missing') { watched.push(`W\0${file}\0none`); continue }
      if (s.kind === 'file') {
        const got = await hashFiles([full], [s], true)
        if ('why' in got) return unknown(`the watched path ${file}: ${got.why}`, got.raced)
        watched.push(`W\0${file}\0${got[0]}`)
        continue
      }
      if (s.kind !== 'dir') return unknown(`the watched path ${file} is a ${KIND_WORDS[s.kind]}, which is never read`)
      const listed = await walk(full)
      if ('missing' in listed) { watched.push(`W\0${file}\0none`); continue }
      if ('why' in listed) return unknown(`the watched path ${file}: ${listed.why}`)
      const names = listed.names
      if (watchedFiles.length + names.length > IGNORED_FILES) return unknown(`more than ${IGNORED_FILES} files under the watched paths`)
      watchedFiles.push(...names)
      watched.push(`W\0${file}\0dir\0${names.length}`)
    }
    // An ignored or watched file that exists is measured by inode, size, and modification and change times in nanoseconds (no
    // reads), so a rewrite is a change even when the content keeps its size and the parent directory's own stat does not move. A name
    // alone would miss it. The whole measurement has a time budget; running out of it is UNKNOWN, never a partial "unchanged".
    const toMeasure = [...new Set([...ignoredNames, ...embedded, ...watchedFiles])].sort()
    if (toMeasure.length > IGNORED_FILES) return unknown(`more than ${IGNORED_FILES} ignored and watched files`)
    const measured: string[] = []
    const ignoredBegan = await $.clock.now()
    for (let i = 0; i < toMeasure.length; i += HASH_CHUNK) {
      if ((await $.clock.now()) - ignoredBegan > FINGERPRINT_BUDGET_MS) return unknown(`measuring the ignored files took longer than ${FINGERPRINT_BUDGET_MS / 1000}s`)
      if (await overdue()) return unknown(late)
      const chunk = toMeasure.slice(i, i + HASH_CHUNK)
      const first = await bounded($, ['stat', '--printf', '%i %s %.9Y %.9Z %n\\0', '--', ...chunk], { cwd: top, timeoutMs: GIT_TIMEOUT_MS })
      let r = first
      let lines: string[] = r.exitCode === 0 ? r.stdout.split('\0').filter(Boolean) : []
      if (r.exitCode !== 0) {
        r = await bounded($, ['stat', '-f', '%i %z %m %c %N', '--', ...chunk], { cwd: top, timeoutMs: GIT_TIMEOUT_MS })
        lines = r.exitCode === 0 ? r.stdout.split('\n').filter(Boolean) : []
      }
      // each record must be the form asked for: GNU `stat -f` is another command (file system status), not BSD's format
      const form = r === first ? /^\d+ \d+ \d+(?:\.\d+)? \d+(?:\.\d+)? / : /^\d+ \d+ \d+ \d+ /
      // a race only when every error was a vanished entry; a timeout, a cut or a wrong form is not measured again
      const vanished = first.exitCode !== 0 && !first.isStderrTruncated && first.stderr.split('\n').filter(Boolean).length > 0 && first.stderr.split('\n').filter(Boolean).every(line => ENOENT.test(line))
      if (r.exitCode !== 0 || r.isStdoutTruncated || lines.length !== chunk.length || !lines.every(line => form.test(line))) return unknown('ignored entries could not be measured (stat failed, or an entry vanished meanwhile)', vanished)
      measured.push(...lines)
    }
    const committedPaths = new Set(tracked.entries.map(e => e.path))
    const paths = [...new Set([...changed.split('\0'), ...untracked.split('\0'), ...hidden].filter(path => path !== '' && !committedPaths.has(path)))].sort()
    if (paths.length > TREE_FILES) return unknown(`more than ${TREE_FILES} changed, untracked or flagged files`)
    const lines: string[] = [...deleted.split('\0').filter(Boolean).sort().map(path => `D\0${path}`), `X\0${sources.join('\0')}`, ...measured.map(line => `S\0${line}`), ...watched]
    // Changed, untracked and flagged paths are inspected before anything is read, without following a final link: a regular file is
    // hashed by content, a link by its own text (as Git records it, never the file it leads to), and a FIFO, socket or device by its
    // kind alone, never opened. A directory here (a nested repository) or a path gone meanwhile is UNKNOWN.
    for (let i = 0; i < paths.length; i += HASH_CHUNK) {
      if (await overdue()) return unknown(late)
      const chunk = paths.slice(i, i + HASH_CHUNK)
      const seen = await inspectPaths($, top, chunk.map(path => `./${path}`))
      if (seen === null) return unknown('a changed or untracked path could not be inspected')
      const regular: number[] = []
      for (let n = 0; n < chunk.length; n++) {
        const s = seen[n]!
        if (s.kind === 'file') regular.push(n)
        else if (s.kind === 'dir') return unknown('a changed or untracked path is a directory (a nested repository?), which is not measured')
        else if (s.kind === 'missing') return unknown('a changed or untracked file vanished while it was measured', true)
      }
      const hashes = await hashFiles(regular.map(n => `./${chunk[n]}`), regular.map(n => seen[n]!), false)
      if ('why' in hashes) return unknown(hashes.why, hashes.raced)
      let hashed = 0
      for (let n = 0; n < chunk.length; n++) {
        const path = chunk[n]!, s = seen[n]!
        if (s.kind === 'file') { lines.push(`${hashes[hashed++]}\0${path}`); continue }
        if (s.kind === 'link') {
          const text = await linkText($, top, `./${path}`)
          if (text === null) return unknown('a changed or untracked symbolic link could not be read reliably')
          lines.push(`L\0${path}\0${text}`)
          continue
        }
        lines.push(`K\0${path}\0${s.kind}\0${(s.mode & 0o7777).toString(8)}`)
      }
    }
    // The commit enumerates authority; raw disk bytes are measured even when the index says every entry is clean.
    for (const e of tracked.entries) {
      if (e.diskMode === 'missing') {
        if (!deleted.split('\0').includes(e.path)) lines.push(`D\0${e.path}`)
      } else if (e.raw !== e.oid || !e.isSameType || (e.diskMode !== undefined && e.diskMode !== e.mode)) lines.push(`${e.raw}\0${e.path}\0${e.isSameType ? 'blob' : 'type-changed'}\0${e.diskMode}`)
    }
    if (await overdue()) return unknown(late)
    const text = lines.join('\n')
    // SHA-256, cut to 128 bits (v0.6.4; two 32-bit FNV hashes before). Paths, link texts and kinds are chosen by whoever writes the
    // tree, and a fast non-cryptographic hash let a chosen change keep the stamp equal. Paths and hashes never leave this function.
    const digest = (await sha256Text(`cobalt-cockpit/tree/v2\0${text}`)).slice(0, 32)

    // The project is part of the fingerprint: the same measurement from another checkout, worktree or repository is another project
    // and compares UNKNOWN (see compareTree), never as an unchanged tree. A SHA-256 of the work tree path, cut to 128 bits: the path
    // itself is never stored.
    const id = (await sha256Text(`cobalt-cockpit/project/v1\0${top}`)).slice(0, 32)

    return `${head}:${lines.length}.${digest}@${id}`
  } catch (error) {
    return unknown(error instanceof BoundRefused ? error.message : 'git raised an error or timed out')
  } })()

  return stamp !== null ? { stamp, why: '', raced: false, noRepo: false, inRepo: true } : { stamp, why, raced, noRepo, inRepo }
}
/**
 * Whether the session directory is outside every Git repository: Git says so, in the C locale and in its own words (or no Git is
 * installed), and no `.git` entry exists in the directory or any parent, along the path the session names and along its physical
 * path. 'repository' is evidence of one: Git found it, or a `.git` entry is there (a damaged or hostile `.git`, a repository Git
 * refuses, one whose work tree is elsewhere): its fingerprint is UNKNOWN, never that of a project without one. 'unknown' for
 * anything else: a timeout, a signal, a limit, another message, or an inspection that could not answer.
 */
const outsideGit = async ($: EngineInterface): Promise<'outside' | 'repository' | 'unknown'> => {
  const cwd = await $.session.cwd()
  if (!cwd || !cwd.startsWith('/')) return 'unknown'
  const r = await bounded($, ['git', ...GIT_SAFE, 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: GIT_TIMEOUT_MS, env: { LC_ALL: 'C' } }).catch(() => null)
  if (r === null || r.isStdoutTruncated || r.isStderrTruncated) return 'unknown'
  // Evidence of a repository is Git finding one, or a `.git` entry being there (the walk below). Anything else Git says, or a
  // timeout, a signal or a limit, is no evidence either way. Outside Git needs Git's own "not a git repository", or no Git at all.
  if (r.exitCode === 0) return 'repository'
  const notRepository = r.exitCode === 128 && NOT_A_REPOSITORY.test(r.stderr)
  const noGit = r.exitCode === 127 && /\bgit\b[^\n]*(?:not found|No such file or directory)/.test(r.stderr)
  // Git searches up the physical path; the session may name it through a link. Both chains of parents are checked.
  const real = await bounded($, ['realpath', '-e', '--', cwd], { timeoutMs: GIT_TIMEOUT_MS }).catch(() => null)
  if (real === null || !gitAnswered(real) || !real.stdout.startsWith('/')) return 'unknown'
  const dotGit: string[] = []
  for (const start of new Set([cwd, real.stdout.replace(/\n$/, '')])) {
    let dir = start.replace(/\/+$/, '') || '/'
    for (let depth = 0; ; dir = dir.slice(0, dir.lastIndexOf('/')) || '/', depth++) {
      // a path deeper than this is not walked to the root: no answer, rather than an answer about part of it
      if (depth >= 256) return 'unknown'
      dotGit.push(`${dir === '/' ? '' : dir}/.git`)
      if (dir === '/') break
    }
  }
  const seen = await inspectPaths($, '/', [...new Set(dotGit)])
  if (seen === null) return 'unknown'
  if (seen.some(s => s.kind !== 'missing')) return 'repository'

  return notRepository || noGit ? 'outside' : 'unknown'
}
/** Git's whole answer outside a repository (C locale), with the line it adds when the search stops at a file-system boundary. */
const NOT_A_REPOSITORY = /^fatal: not a git repository \((?:or any of the parent directories\): \.git|or any parent up to mount point [^\n]*\))\n(?:Stopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.\n)?$/
/** The commit a stored fingerprint was taken against; only a full commit id is passed back to Git, anything else measures against HEAD. */
const baseOf = (stamp: string | undefined): string | undefined => (typeof stamp === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64}):/.test(stamp) ? stamp.slice(0, stamp.indexOf(':')) : undefined)
/**
 * A fingerprint, taken once more when the first was cut short only by a race (a file that changed or vanished while it was
 * read): a tree in use is not called unmeasurable for one unlucky moment. A second race, and every other failure, stand.
 */
const settledReading = async ($: EngineInterface, base?: string): Promise<TreeReading> => {
  const first = await measureTree($, base)
  const reading = first.stamp !== null || !first.raced ? first : await measureTree($, base)
  treeWhy = reading.why

  return reading
}

/** If a goal check was accepted for another working tree than the present one, it is stale now. */
const reconcileOnce = async ($: EngineInterface): Promise<void> => {
  const task = await read($, taskAtom)
  const accepted = task?.alignment?.tree
  if (task?.alignment?.state === 'ALIGNED' && typeof accepted !== 'string' && task.alignment.protection === undefined && needsAlignment(task)) {
    // Accepted without a fingerprint before v0.6.4, for a reason not recorded: measured once now. Outside Git (and not begun in a
    // repository) it stands, marked UNPROTECTED; anywhere else nothing shows it still holds, so the goal check is pending again.
    const reading = await settledReading($)
    const now = await $.clock.now()
    const held = await update($, taskAtom, t => {
      if (t === null || t.alignment?.state !== 'ALIGNED' || typeof t.alignment.tree === 'string' || t.alignment.protection !== undefined) return t
      if (reading.noRepo && typeof t.startTree !== 'string' && t.repoSeen !== true) return { ...t, alignment: { ...t.alignment, protection: { state: 'UNPROTECTED' as const, why: reading.why } } }

      return settle(reopenVerification(t, reading.stamp === null ? unmeasuredWhy(reading.why) : 'the goal check was accepted without a working-tree fingerprint (before v0.6.4)')).task
    })
    if (held !== null) await quiet(async () => { await mutateLedger($, l => recordDiscovery(l, held, now)); await persist($) })

    return
  }
  if (task?.alignment?.state === 'ALIGNED' && task.alignment.protection?.state === 'UNPROTECTED') {
    // Accepted outside Git: if a repository has appeared since (`git init`), nothing measured the tree the check was made on, so
    // it is pending again, and the task is one for which a repository was seen.
    if ((await outsideGit($)) !== 'repository') return
    const now = await $.clock.now()
    const held = await update($, taskAtom, t => (t === null || t.alignment?.protection?.state !== 'UNPROTECTED' || t.alignment.state !== 'ALIGNED' ? t : settle(reopenVerification({ ...t, repoSeen: true }, 'a Git repository appeared after the goal check was accepted without a fingerprint')).task))
    if (held !== null) await quiet(async () => { await mutateLedger($, l => recordDiscovery(l, held, now)); await persist($) })

    return
  }
  if (task?.alignment?.state !== 'ALIGNED' || typeof accepted !== 'string') return
  const reading = await settledReading($, baseOf(accepted))
  const tree = reading.stamp
  const why = reading.why
  if (tree === accepted) return
  const now = await $.clock.now()
  // only the check that was measured: one made since is about a newer tree. A tree that can no longer be measured is not the
  // one the check was accepted for either: the acceptance is stale, never kept on a failed measurement.
  const held = await update($, taskAtom, t => (t === null || t.alignment?.tree !== accepted ? t : settle(tree === null ? treeUnmeasured(t, why) : treeMoved(t, tree)).task))
  if (held !== null) await quiet(async () => { await mutateLedger($, l => recordDiscovery(l, held, now)); await persist($) })
}
// One measurement at a time; calls that arrive while one runs share the next, which starts after they did.
let reconciling: Promise<void> | null = null
let reconcileNext: Promise<void> | null = null
const reconcileTree = ($: EngineInterface): Promise<void> => {
  if (reconciling === null) {
    reconciling = reconcileOnce($).finally(() => { reconciling = null })

    return reconciling
  }
  reconcileNext ??= reconciling.then(() => { reconcileNext = null; return reconcileTree($) }, () => { reconcileNext = null; return reconcileTree($) })

  return reconcileNext
}

const serveProgress = async ($: EngineInterface, e: ProgressInput & { agentId?: string }): Promise<{ result: string }> => {
  await hush(() => adoptLegacyHold($))
  if (e.agentId !== undefined) {
    return {
      result: 'Cobalt Cockpit: the task state belongs to the main conversation. Report your result to it instead; nothing was changed.',
    }
  }
  const now = await $.clock.now()
  const sha = (await read($, gitAtom))?.sha ?? null
  await quiet(() => reconcileTree($))
  await quiet(() => syncRelease($))
  await quiet(() => reconcileRelease($))
  // the tree an accepted goal check is about, taken before the answer is recorded
  const before = e.action === 'align' || e.action === 'gate' || (e.action as string) === 'gates' ? await read($, taskAtom) : null
  const goalChecked = before !== null && needsAlignment(before)
  const stampReading = goalChecked && e.action === 'align' ? await settledReading($, baseOf(before.gateTree)) : null
  const stamp = stampReading?.stamp ?? null
  const stampWhy = stampReading?.why ?? ''
  // A goal check may stand without a fingerprint only outside every Git repository, and then as UNPROTECTED (v0.6.4).
  const stampNoRepo = stampReading?.noRepo === true
  const gateReading = goalChecked && (e.action === 'gate' || (e.action as string) === 'gates') ? await settledReading($, baseOf(before.gateTree)) : null
  const gateStamp = gateReading?.stamp ?? null
  // why the gate measurement failed, when it was taken and failed; undefined when none was taken
  const gateWhy = gateReading !== null && gateReading.stamp === null ? gateReading.why : undefined
  // A model's "read-only" is a claim. With the Stop guard enforcing, it is accepted only when the tree is still the one the task
  // began with (a known baseline taken by the host, no edit seen); an unknown baseline or fingerprint cannot show that, so the
  // task is planned as coding and the enrolled check runs. The baseline is never replaced by a later fingerprint.
  let input: ProgressInput & { agentId?: string } = e
  let claimNote = ''
  if (e.action === 'plan' && (e as { kind?: unknown }).kind === 'readonly') {
    const cfg = await loadStopCfg($)
    if (cfg.policy === 'ENFORCE' && cfg.problems.length === 0 && cfg.script !== null) {
      const standing = await read($, taskAtom)
      const nowTree = await treeStamp($)
      const isProven = standing !== null && typeof standing.startTree === 'string' && nowTree !== null && nowTree === standing.startTree && standing.edited !== true && standing.files.length === 0
      if (!isProven) {
        input = { ...e, kind: 'coding' } as ProgressInput & { agentId?: string }
        claimNote = 'Read-only was not accepted: the working tree cannot be shown to be unchanged since this task began, so it is planned as coding and the Stop guard check applies.'
      }
    }
  }
  let reply = ''
  let unprotected = ''
  let cues: Cue[] = []
  let wasDone = false
  const pin = await read($, discoveryPinAtom)
  const held = await update($, taskAtom, old => {
    cues = []
    wasDone = old?.status === 'done'
    // the passed checks must be about the tree the goal check is made for
    if (e.action === 'align' && old !== null && stamp !== null && old.gateTree !== undefined && old.gateTree !== stamp) {
      reply = 'error: ALIGNED refused: the working tree changed after the checks were last observed, so they no longer describe it. Run the checks again, record the gates, then align. Nothing was recorded'

      return reopenVerification(old, 'the working tree changed since the checks were observed')
    }
    // checks observed on a measured tree say nothing about one that can no longer be measured
    if (e.action === 'align' && goalChecked && old !== null && stamp === null && old.gateTree !== undefined) {
      reply = `error: ALIGNED refused: ${unmeasuredWhy(stampWhy)}, so the checks observed on it before cannot be shown to describe it. Run the checks again, record the gates, then align. Nothing was recorded`

      return reopenVerification(old, unmeasuredWhy(stampWhy))
    }
    // a pass that was never observed on a measured tree cannot be taken to describe this one, however it is measured now (v0.6.6)
    if (e.action === 'align' && goalChecked && old !== null && stamp !== null && hasUnboundPass(old)) {
      reply = 'error: ALIGNED refused: a passed check was not observed on a measured working tree, so it cannot be shown to describe this one. Run the checks again, record the gates, then align. Nothing was recorded'

      return reopenVerification(old, 'a passed check was not observed on a measured working tree')
    }
    const outcome = applyAction(old === null ? { ...newTask(1, '', now, sha), startTree: null } : checkedAt(old, gateStamp, gateWhy), input, now, sha)
    if (outcome.error !== undefined) {
      reply = `error: ${outcome.error}`

      return old
    }
    // The person's pin and the evidence of the plan are applied before the task is settled, so the goal check counts toward DONE.
    // A task stored by v0.5.0 (milestones, no discovery) keeps the rules it began under, unless this call starts a new one.
    const isLegacy = old !== null && old.milestones.length > 0 && old.discovery === undefined && e.action !== 'plan'
    // only the gates this call reported are bound to the tree measured for it; an older unbound pass is not (v0.6.6)
    const gated = e.action === 'gate' || (e.action as string) === 'gates' ? stampGates(outcome.task, gateStamp, reportedGates(input)) : outcome.task
    let stamped = stamp !== null && gated.alignment?.state === 'ALIGNED' ? { ...gated, alignment: { ...gated.alignment, tree: stamp } } : gated
    let notAccepted = ''
    if (goalChecked && e.action === 'align' && stamp === null && gated.alignment?.state === 'ALIGNED') {
      // a task that began in a measured repository is not made unprotected by that repository going away
      const leftGit = stampNoRepo && (typeof gated.startTree === 'string' || gated.repoSeen === true)
      const why = leftGit ? 'this task began in a Git repository that is no longer there' : stampWhy
      if (stampNoRepo && !leftGit) {
        // outside every repository there is nothing to fingerprint: accepted as before, and marked so wherever it is shown
        stamped = { ...gated, alignment: { ...gated.alignment, protection: { state: 'UNPROTECTED', why: stampWhy } } }
        unprotected = 'UNPROTECTED: this project is not a Git repository, so no working-tree fingerprint protects this goal check; a later change outside Edit, Write and Bash edit diffs will not be noticed.'
      } else {
        // A repository is here and could not be measured safely: the claim is recorded as UNKNOWN, never as an accepted check, and
        // the failure is read as neither a clean nor a changed tree. Criteria it marked met are unresolved, as for any claim refused.
        const criteria = gated.discovery?.criteria.map(c => (c.status === 'met' ? { ...c, status: 'unresolved' as const } : c))
        stamped = {
          ...gated,
          alignment: { ...gated.alignment, state: 'UNKNOWN', protection: { state: 'UNKNOWN', why }, note: oneLine(`working tree unmeasurable: ${why}`, 160) },
          ...(gated.discovery === undefined || criteria === undefined ? {} : { discovery: { ...gated.discovery, criteria } }),
        }
        notAccepted = `error: ALIGNED not accepted: this Git repository's working tree cannot be measured safely (${why}), so the goal check is recorded as UNKNOWN, not ALIGNED. A measurement that fails says nothing of a clean or a changed tree. Resolve the cause, then align again.`
      }
    }
    const seen = stampReading?.inRepo === true || gateReading?.inRepo === true
    const marked: Task = seen && stamped.repoSeen !== true ? { ...stamped, repoSeen: true } : stamped
    const settled = settle(isLegacy ? marked : withDiscovery(marked, pin))
    cues = settled.cues
    reply = [notAccepted, outcome.note, claimNote, unprotected, summaryOf(settled.task)].filter(Boolean).join(' ')

    return settled.task
  })
  for (const cue of cues) void sound($, cue)
  if (held !== null) await quiet(async () => { await mutateLedger($, l => recordDiscovery(l, held, now)); await persist($) })
  // a task is counted when it first reads DONE; an Opus consultation is one the ledger admitted for this task
  if (held !== null && held.status === 'done' && held.percent === 100 && !wasDone) await quiet(async () => tele($, { k: 'task', opus: ((await read($, ledgerAtom)).consults ?? []).some(c => c.progressTask === held.id) }))

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
  // Any tool that can write, after the guard recorded a completion, withdraws it: the tree it stood for may no longer exist, and the
  // next Stop or prompt must show otherwise. (Reads leave it alone.)
  if (e.tool === 'Bash' || e.tool === 'Write' || e.tool === 'Edit' || e.tool === 'MultiEdit' || e.tool === 'NotebookEdit' || (e.tool.startsWith('mcp__') && !e.tool.startsWith('mcp__cobalt-cockpit__'))) {
    if ((await read($, taskAtom))?.guardDone !== undefined) await change($, t => withdrawDone(t))
    // With no task to carry the fact, the obligation is kept apart from it. (Reads never create one; a Bash call may write, and no
    // reading of its command is trusted to say that it did not.)
    if (ran.deny === undefined && guardEnforcing() && (await read($, taskAtom)) === null) {
      const at = await $.clock.now()
      await update($, owedAtom, held => held ?? { at, why: `${e.tool} ran while no task was in progress` })
    }
  }
  if (e.agentId !== undefined) {
    // A helper's edit never moves the task, but it does make an earlier goal check stale.
    const made = (ran.deny === undefined && ran.isError !== true ? ran.result : null) as Record<string, unknown> | null
    const now = await $.clock.now()
    const wrote = made !== null && made['staged'] !== true && (e.tool === 'Edit' || e.tool === 'Write' || (e.tool === 'Bash' && Array.isArray((made['bashEditDiff'] as { files?: unknown } | undefined)?.files)))
    if (wrote) {
      await quiet(async () => {
        const held = await change($, task => markEdited(task, 'a helper changed files'))
        if (held !== null) await mutateLedger($, l => recordDiscovery(l, held, now))
      })
    }
    if (ran.deny === undefined && e.tool !== TOOL) await quiet(() => reconcileTree($))

    return
  }
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

  const measuring = readings.some(r => r.state === 'pass')
  const observedReading = measuring ? await settledReading($, baseOf((await read($, taskAtom))?.gateTree)) : null
  const observed = observedReading?.stamp ?? null
  const observedWhy = observedReading !== null && observedReading.stamp === null ? observedReading.why : undefined
  // a repository is (or may be) here and its tree could not be measured: outside every repository there is no tree to identify
  const unidentified = observedReading !== null && observedReading.stamp === null && observedReading.noRepo !== true
  if (edits.length > 0 || readings.length > 0) {
    await change($, (task, now) => {
      let chain = task
      for (const edit of edits) chain = touchFile(chain, edit.path, edit.added, edit.removed)
      if (measuring) chain = checkedAt(chain, observed, observedWhy)
      if (edits.length > 0 && isSonnetLed()) chain = requireReview(chain, mandatoryGrounds(factsOf({ ...chain, files: chain.files.map(f => ({ ...f, path: relative(f.path) })) }, 0, chain.promptGrounds ?? [])))
      // A goal-checked task's pass needs the tree it was observed on: where that cannot be identified, the exit is kept as an
      // observation (pending, with its evidence), never as a qualified pass a later measurement could adopt (v0.6.6).
      const mustIdentify = unidentified && needsAlignment(chain)
      const recorded: (typeof readings)[number]['gate'][] = []
      for (const reading of readings) {
        // a test command's result cannot lift or replace what the Stop guard holds the task for
        if (reading.gate === 'TEST' && isGuardHeld(chain)) continue
        const isUnqualified = mustIdentify && reading.state === 'pass'
        chain = setGate(chain, reading.gate, isUnqualified ? 'pending' : reading.state, isUnqualified ? unqualifiedEvidence(reading.evidence, observedWhy ?? '') : reading.evidence, 'auto', now)
        recorded.push(reading.gate)
      }
      if (observed !== null) chain = stampGates(chain, observed, recorded)

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
  // Whatever else a tool did to the project, a goal check made for another tree is stale.
  if (ran.deny === undefined && e.tool !== TOOL) { await quiet(() => reconcileTree($)); await quiet(() => reconcileRelease($)) }
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
  // one observed request, as the ledger now holds it; tokens only when the host reported both figures
  await hush(async () => {
    const r = (await read($, ledgerAtom)).requests.at(-1)
    if (r === undefined) return
    const raw = (typeof actual.usage === 'object' && actual.usage !== null ? actual.usage : {}) as Record<string, unknown>
    const split = (typeof raw['cache_creation'] === 'object' && raw['cache_creation'] !== null ? raw['cache_creation'] : {}) as Record<string, unknown>
    await tele($, {
      k: 'req', tier: modelTier(r.model), sub: e.agentId !== undefined,
      ...(typeof r.input === 'number' && typeof r.output === 'number' ? { inTok: r.input, outTok: r.output } : {}),
      ...(typeof r.cacheRead === 'number' && typeof r.cacheWrite === 'number' ? { cr: r.cacheRead, cw: r.cacheWrite } : {}),
      // the 5m / 1h split exists only if the host passed it through; the typed usage does not carry it
      ...(typeof split['ephemeral_5m_input_tokens'] === 'number' && typeof split['ephemeral_1h_input_tokens'] === 'number' ? { w5: split['ephemeral_5m_input_tokens'], w1: split['ephemeral_1h_input_tokens'] } : {}),
      ...(e.agentId !== undefined && cacheReading !== null ? { pol: cacheReading.ttl } : {}),
    })
  })
  await persist($)
}
/**
 * What the host's store does, read from its implementation in Claude Code 2.1.296 and not documented by it: every
 * `$.store.set` and `$.store.delete` takes a lock file beside the store (retried a few times, so a contended set can be
 * rejected), reads the whole store inside the lock, changes that one key and writes; so one session's set is serialised
 * against another's while the lock holds, and a set of one key never changes another. Stale-lock takeover and the atomicity
 * of the file write itself were not examined. There is no compare-and-set and no transaction: a `get` followed by a `set` is two steps, and another session's set may come between
 * them. Nothing here claims more than that.
 *
 * So the alerts are kept in two kinds of key (v0.5.8):
 *  - one key per acknowledged occurrence, `alert-ack:<project>:<id>`, written once with a constant value. It is never read
 *    and then written back, so no stale session can undo it; two sessions acknowledging the same occurrence write the same
 *    thing. Sessions find acknowledgments with `$.store.keys()` and apply them to their own records.
 *  - one key per project for its records, `alert-history:<project>`, replaced by a read, a merge and a set. That one is
 *    last-writer-wins: a session's records written between another's read and set can be lost from the stored history (not
 *    from their own Ledger). An acknowledgment is not among the things that can be lost, because it is not kept there.
 * v0.5.7 kept all projects under one key, `alert-history`; it is still read (never written) when a project has no key yet.
 * Both kinds hold only what the Ledger holds: a closed vocabulary, numbers, a short channel name, a hash of the directory
 * and an occurrence id. Bounded: four projects of 32 records, 128 acknowledgments.
 */
const LEGACY_HISTORY_KEY = 'alert-history'
/** The records an earlier build kept for a project in one key (v0.5.8 per project, v0.5.7 for all): read, never written. */
const legacyHistory = async ($: EngineInterface, project: string): Promise<AlertRecord[]> => {
  const own = (await $.store.get(historyKeyOf(project)).catch(() => undefined)) as { v?: unknown; alerts?: unknown } | undefined
  if (own?.v === 1) return validAlerts(own.alerts)
  const old = (await $.store.get(LEGACY_HISTORY_KEY).catch(() => undefined)) as { v?: unknown; projects?: unknown } | undefined
  if (old?.v === 1 && old.projects !== null && typeof old.projects === 'object' && Object.hasOwn(old.projects as object, project)) return validAlerts((old.projects as Record<string, unknown>)[project])

  return []
}
/** The occurrences of a project in keys of their own, in the order the store lists them. A value whose records are not that occurrence's is ignored. */
const storedOccurrences = async ($: EngineInterface, project: string): Promise<{ id: string; records: AlertRecord[] }[]> => {
  const out: { id: string; records: AlertRecord[] }[] = []
  for (const id of occIdsOf(await $.store.keys().catch(() => [] as string[]), project)) {
    const v = (await $.store.get(occKeyOf(project, id)).catch(() => undefined)) as { v?: unknown; records?: unknown } | undefined
    const records = v?.v === 1 ? validAlerts(v.records) : []
    if (records.length > 0 && episodesOf(records)[0]?.id === id) out.push({ id, records })
  }

  return out
}
const alertProject = async ($: EngineInterface): Promise<string> => (await sha256Text(`cobalt-cockpit/alerts/v1\0${(await $.session.cwd().catch(() => '')) || ''}`)).slice(0, 12)
/** The occurrences of a project that the store holds an acknowledgment for. Unreadable: none, so nothing is marked on a guess. */
const storedAcks = async ($: EngineInterface, project: string): Promise<Set<string>> => ackedIdsOf(await $.store.keys().catch(() => [] as string[]), project)
/** Writes one key per acknowledged occurrence (one atomic set each) and forgets the oldest beyond the bound. False if any set failed. */
const recordAcks = async ($: EngineInterface, project: string, ids: readonly string[]): Promise<boolean> => {
  let ok = true
  for (const id of ids) {
    try { await $.store.set(ackKeyOf(project, id), { v: 1 }) } catch { ok = false }
  }
  await hush(async () => { for (const k of excessAckKeys(await $.store.keys())) await $.store.delete(k) })

  return ok
}
/** Marks the Ledger's records of every occurrence acknowledged in the store, in this session or another. Writes nothing to the store. */
let syncedAt = -Infinity
const SYNC_MIN_MS = 5000
const syncAcks = async ($: EngineInterface, rearm = true, throttled = false): Promise<void> => {
  // an alert pass runs on every tool result: the store's key list is read at most every few seconds there; a command or a start always reads it
  if (throttled) {
    const now = await $.clock.now()
    if (now >= syncedAt && now - syncedAt < SYNC_MIN_MS) return
    syncedAt = now
  }
  const held = await read($, ledgerAtom)
  const alerts = held.alerts ?? []
  if (held.alertsProject === undefined || alerts.every(a => a.acked === true || a.outcome === 'resolved')) return
  const ids = await storedAcks($, held.alertsProject)
  if (applyAcks(alerts, ids) === alerts) return
  await update($, ledgerAtom, old => ({ ...old, alerts: applyAcks(old.alerts ?? [], ids) }))
  await hush(() => persist($))
  // an acknowledgment made elsewhere ends the reminders here at once, not at the timer's next look
  if (rearm) await armReminders($)
}
/**
 * What this session last put in, or found in, each occurrence's key. An occurrence is written only when this session changed its
 * records since: a resumed older session that records nothing writes nothing, and cannot put its older copy over a newer one.
 */
const occSigs = new Map<string, string>()
const primeSigs = (project: string, records: readonly AlertRecord[], present: ReadonlySet<string>): void => {
  for (const e of episodesOf(records)) if (present.has(e.id)) occSigs.set(occKeyOf(project, e.id), JSON.stringify(e.records))
}
/**
 * Writes the Ledger's occurrences, each to a key of its own with one `set`. Two sessions that record different occurrences write
 * different keys, so neither can lose the other's; two that change the same occurrence write the same key and the later write wins.
 */
const keepAlertHistory = async ($: EngineInterface, ledger: Ledger): Promise<void> => {
  const project = ledger.alertsProject
  const records = validAlerts(ledger.alerts)
  if (project === undefined || !PROJECT_RE.test(project) || records.length === 0) return
  const episodes = episodesOf(records)
  let wrote = false
  for (const e of episodes) {
    const key = occKeyOf(project, e.id)
    const sig = JSON.stringify(e.records)
    if (occSigs.get(key) === sig) continue
    try {
      await $.store.set(key, { v: 1, records: e.records })
      occSigs.set(key, sig)
      wrote = true
    } catch { /* not marked written: the next persist tries again */ }
  }
  // the store's key list is read, and old keys given up, only when something was written
  if (!wrote) return
  await hush(async () => {
    const own = new Set(episodes.map(e => occKeyOf(project, e.id)))
    const keys = await $.store.keys()
    for (const k of excessOccKeys(keys, own, project)) { await $.store.delete(k); occSigs.delete(k) }
    // another session's pruning can have given up one of this session's occurrences: it is written again, from the Ledger's copy
    const have = new Set(keys)
    for (const e of episodes) {
      const key = occKeyOf(project, e.id)
      if (!have.has(key)) { await $.store.set(key, { v: 1, records: e.records }); occSigs.set(key, JSON.stringify(e.records)) }
    }
  })
}
/** Once per session: a Ledger with no alerts of its own takes up what its project's history holds, with the acknowledgments the store has; either way it is tied to the project. */
let seededFor = ''
const seedAlerts = async ($: EngineInterface): Promise<void> => {
  const held = await read($, ledgerAtom)
  if (held.sessionId === UNKNOWN || seededFor === held.sessionId) return
  seededFor = held.sessionId
  if (held.alertsProject !== undefined) {
    primeSigs(held.alertsProject, validAlerts(held.alerts), new Set(occIdsOf(await $.store.keys().catch(() => [] as string[]), held.alertsProject)))
    await syncAcks($, false)

    return
  }
  const project = await alertProject($)
  const parts = await storedOccurrences($, project)
  const legacy = await legacyHistory($, project)
  const acked = await storedAcks($, project)
  const past = applyAcks(historyFrom(parts, legacy), acked)
  const mine = (held.alerts ?? []).length === 0 ? past : validAlerts(held.alerts)
  // with both settings off nothing is written, so what an earlier format held is not copied into keys of its own
  primeSigs(project, mine, isRecording(guardCfg) ? new Set(parts.map(x => x.id)) : new Set(episodesOf(mine).map(e => e.id)))
  // with nothing recorded earlier and neither alerts nor record-only on, nothing is taken up and nothing is written: no new history is kept
  if ((held.alerts ?? []).length === 0 && past.length === 0 && !isRecording(guardCfg)) return
  await update($, ledgerAtom, old => (old.alertsProject !== undefined ? old : { ...old, alertsProject: project, alerts: (old.alerts ?? []).length === 0 ? past : old.alerts }))
  await persist($)
  // the v0.5.8 key of this project is given up once every occurrence in it has a key of its own, so it cannot bring back what is pruned later
  if (isRecording(guardCfg)) {
    await hush(async () => {
      const old = (await $.store.get(historyKeyOf(project)).catch(() => undefined)) as { v?: unknown; alerts?: unknown } | undefined
      if (old?.v !== 1) return
      // only a key every record of which this build understands, and every occurrence of which its own key holds in full (read back,
      // not merely named), is given up
      const understood = Array.isArray(old.alerts) && validAlerts(old.alerts).length === old.alerts.length
      // the key is read again first, then every occurrence key, so the last reads before the delete are of the copies it depends on
      const again = await $.store.get(historyKeyOf(project)).catch(() => undefined)
      let held = understood && JSON.stringify(again) === JSON.stringify(old)
      for (const e of held ? episodesOf(validAlerts(old.alerts)) : []) {
        const value = await $.store.get(occKeyOf(project, e.id)).catch(() => undefined)
        if (!isMigratedEpisode(e.records, e.id, value)) { held = false; break }
      }
      if (held) await $.store.delete(historyKeyOf(project))
    })
  }
  await syncAcks($, false)
}
const persist = async ($: EngineInterface): Promise<void> => {
  let ledger = await read($, ledgerAtom)
  if (ledger.sessionId === UNKNOWN) return
  if ((ledger.alerts ?? []).length > 0 && ledger.alertsProject === undefined) {
    const project = await alertProject($)
    await update($, ledgerAtom, old => (old.alertsProject === undefined ? { ...old, alertsProject: project } : old))
    ledger = await read($, ledgerAtom)
  }
  await hush(() => keepAlertHistory($, ledger))
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
  await hush(() => seedAlerts($))
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
    const first = e.agentId === undefined ? undefined : !(await read($, ledgerAtom)).observedCompletions?.some(c => c.agentId === e.agentId)
    await mutateLedger($, l => {
      const ended = finishTurn(l,e,at)
      if (!e.agentId) return ended
      // the stored conclusion is one folded, shortened line; the DECISION line is read from the answer as given
      const decision = releaseDecision(e.answer)
      const first = ended.observedCompletions?.find(c => c.agentId === e.agentId)
      const owner = swarmState(ended).tasks.find(t => t.agentId === e.agentId)
      // An architect that has already returned is not asked again for approval: a later turn of the same agent (a message
      // sent to it, a resume) is kept beside its answer as separate information and changes neither the recorded decision
      // nor the consultation's state.
      if (first !== undefined && owner !== undefined && owner.tier === 'OPUS' && hasReturned(owner)) {
        const later = { at, reason: e.reason, conclusion: textOf(e.answer), ...(decision === undefined ? {} : { decision }) }

        return { ...ended, observedCompletions: (ended.observedCompletions ?? []).map(c => c === first ? { ...c, later: [...(c.later ?? []), later].slice(-4) } : c) }
      }
      const completed = [...(ended.observedCompletions ?? []).filter(c=>c.agentId!==e.agentId), { agentId:e.agentId,reason:e.reason,conclusion:textOf(e.answer),at,...(decision === undefined ? {} : { decision }) }].slice(-128)
      const task = swarmState(ended).tasks.find(t=>t.agentId===e.agentId)
      return { ...ended, observedCompletions:completed, swarm:task ? finishObserved(swarmState(ended),task.id,e.reason,textOf(e.answer),at) : swarmState(ended) }
    })
    // a subagent's first end is one observed ending, with its lifetime by the plugin's clock; a later turn of the same agent is not another
    if (e.agentId !== undefined && first === true) await hush(async () => {
      const l = await read($, ledgerAtom)
      const agent = l.agents.find(a => a.id === e.agentId)
      const started = typeof agent?.start === 'number' ? agent.start : null
      await tele($, { k: 'agent', tier: modelTier(agent?.model), role: agentRole(agent?.role), ok: e.reason === 'answer', ms: started === null ? null : Math.max(0, at - started) })
      const owner = swarmState(l).tasks.find(t => t.agentId === e.agentId)
      const consult = owner?.tier === 'OPUS' ? l.consults?.find(c => c.id === owner.id) : undefined
      if (consult !== undefined) await tele($, { k: 'consult', ground: consult.ground, ev: 'returned', mandatory: consult.isMandatory, ms: Math.max(0, at - consult.requestedAt) })
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
    await hush(() => adoptLegacyHold($))
    await hush(() => reconcileCompletion($))

    return ran
  }).catch(($, e, next) => next(e))
  on('classic.Stop', async ($, e, next) => {
    // an exception in the guard is not a pass: the task is held with that reason and the stop is allowed (no loop, no DONE)
    const reason = await stopGuard($, e).catch(async () => {
      await hush(() => change($, (t, now) => (stopCfg.policy === 'ENFORCE' ? holdTask(t, 'the Stop guard raised an error while checking', 0, now) : t)))

      return null
    })
    // a stop that is about to be allowed is when an unfinished run needs a person
    if (reason === null) await raiseAlerts($, true)
    if (reason !== null) return { block: reason }

    return next(e)
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
    if (e.args.trim() === 'export decisions') return { text: decisionsMarkdown(l) }
    if (e.args.trim() !== '') return { text: 'Usage: /ledger | /ledger export json | /ledger export decisions' }
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


// --- Cobalt Guard: opt-in owner alerts (policy and wording: guard.ts). Reads verification state; changes none of it. ---
const guardAtom = atom({ plugin: 'cobalt-cockpit', key: 'guard-state' } as const, EMPTY_GUARD)
let guardCfg: GuardConfig = guardConfigOf({})
let guarding = false

/**
 * The one timer the alerts own. It exists only while some alerted condition could still be repeated, or an alert quiet
 * hours held back is still owed, and is cancelled when neither is so (acknowledged, silenced, resolved, spent, told),
 * on session end, and by the host on a reload: `session.start` arms it again from the kept records, so a reload
 * neither doubles it nor restarts a count. Each look reads the clock afresh; nothing is scheduled for a moment ahead.
 */
let reminderTimer: Timer | null = null
/** Set at session end: a late call after it must not bring the timer back. */
let isSessionOver = false
const REMINDER_POLL_MS = 30_000
const stopReminders = () => {
  reminderTimer?.cancel()
  reminderTimer = null
}
const armReminders = async ($: EngineInterface): Promise<void> => {
  try {
    const view = guardCfg.enabled && !isSessionOver ? await guardView($) : null
    // the current task's conditions are this session's own, whether or not a pass has run yet (a reload resumes them)
    const current = view === null ? null : await read($, taskAtom)
    if (current !== null) ownedUids.add(uidOf(current))
    // a release NO-GO whose history cannot be read is neither open nor closed here, and no reminder can come of it
    const releaseBlind = view !== null && view.kept.some(a => a.kind === 'release-no-go') && !(await releaseRead($)).readable
    if (view === null || !hasWorkLeft(guardCfg, view.state, view.kept.filter(a => isOwned(a.key) && !(releaseBlind && a.kind === 'release-no-go')))) { stopReminders(); return }
    if (reminderTimer !== null) return
    reminderTimer = $.clock.every(REMINDER_POLL_MS, () => quiet(() => raiseAlerts($, false)))
  } catch { stopReminders() }
}

/** Asks the host to notify. What comes back is what was attempted and written, never what was seen. */
const notifyOwner = async ($: EngineInterface, text: string): Promise<{ outcome: 'sent' | 'failed' | 'refused'; channel: string | null; why?: TransportTest['why'] }> => {
  let outcome: 'sent' | 'failed' | 'refused' = 'failed'
  let channel: string | null = null
  let why: TransportTest['why']
  try {
    const r = await $.ui.notify(text, { title: 'Cobalt Guard' })
    if (r.isSent) { outcome = 'sent'; channel = r.channel } else { outcome = r.reason === 'refused' ? 'refused' : 'failed'; why = r.reason as TransportTest['why'] }
  } catch { outcome = 'failed'; why = 'error' }

  return { outcome, channel, ...(why === undefined ? {} : { why }) }
}

/**
 * The alert cue, when `guardSound` is on: the existing cue player, whose last resort is the terminal bell; it honours the
 * sounds option and /cockpit mute and never throws. It is started and not waited for, so a slow or missing player never
 * delays the tool call or the stop an alert was raised from; the record is marked once a player has exited 0.
 */
const cueOwner = ($: EngineInterface, key: string, at: number): void => {
  // in the quiet window the extra cue is never played; an alert the operator kept is its notification alone
  if (!guardCfg.sound || isQuiet(guardCfg.quiet, at)) return
  void (async () => {
    const played = await sound($, 'checkpoint')
    if (played === null) return
    const cue = played === 'bell' ? 'bell' as const : 'sound' as const
    await update($, ledgerAtom, old => ({ ...old, alerts: (old.alerts ?? []).map(a => (a.key === key && a.at === at && a.outcome !== 'resolved' && a.outcome !== 'throttled' && a.cue === undefined ? { ...a, cue } : a)) }))
    await persist($)
  })().catch(() => undefined)
}

/** The facts the alert policy reads off a task. `withRelease` false leaves the release history unread (no NO-GO is then reported). */
const alertFacts = async ($: EngineInterface, task: Task, atStop: boolean, withRelease = true, given?: ReleaseRecord[]): Promise<Facts> => {
  const history = withRelease ? (given ?? await releaseHistorySoft($)) : []
  const latest = [...history].sort((a, b) => b.at - a.at)[0]
  const review = task.review

  return {
    taskUid: uidOf(task),
    securityFailed: task.gates.SECURITY.state === 'fail',
    // only a check that really ran and kept failing is "retries exhausted"; a missing, changed or unstartable script is a blocked run
    stopBlocker: exhaustedBlocker(task.stopHold?.reason ?? null),
    blocker: task.stopHold?.reason ?? task.blocker,
    releaseNoGo: review !== undefined && review.grounds.includes('release') && !(review.cleared ?? []).some(c => c.ground === 'release') && latest?.outcome === 'no-go',
    reviewOpen: review !== undefined && review.state !== 'adjudicated',
    atStop,
  }
}

/**
 * Every alert condition that holds now, and what this session can observe of the rest: read-only. With no task, or when the task
 * cannot be read, nothing is open and nothing is observable (`uid` null): a condition is then UNKNOWN, never resolved. A NO-GO
 * is judged from the release history, so when that cannot be read the kind is `blind` and is not reported as cleared either.
 */
const observeAlerts = async ($: EngineInterface, kept: readonly AlertRecord[]): Promise<{ open: Open[]; observation: Observation }> => {
  try {
    const task = await read($, taskAtom)
    if (task === null || kept.length === 0) return { open: [], observation: { uid: null, blind: [] } }

    // the release history is read only when a NO-GO was raised: without a record it could not be listed anyway
    // read once and strictly: a value that cannot be used makes the kind blind, so a NO-GO is never read as cleared from it
    const wantsRelease = kept.some(a => a.kind === 'release-no-go')
    const release = wantsRelease ? await releaseRead($) : { history: [], readable: true }
    const releaseReadable = release.readable
    const facts = await alertFacts($, task, true, wantsRelease && releaseReadable, release.history)

    return { open: dueOf(facts), observation: { uid: facts.taskUid, blind: releaseReadable ? [] : ['release-no-go'] } }
  } catch { return { open: [], observation: { uid: null, blind: [] } } }
}
/** Every alert condition that holds now, for the HUD and the status: read-only, and empty when it cannot be read. */
const openAlerts = async ($: EngineInterface, kept: readonly AlertRecord[]): Promise<Open[]> => (await observeAlerts($, kept)).open

/** The identities of the tasks this process has held: the only ones whose conditions it may record as resolved. */
const ownedUids = new Set<string>()
const isOwned = (key: string): boolean => [...ownedUids].some(u => key.startsWith(`${u}:`))

/** Raises whatever alert is due. Never throws, never loops, and never touches a gate, a review or an approval. */
const raiseAlerts = async ($: EngineInterface, atStop: boolean): Promise<void> => {
  if (!isRecording(guardCfg) || guarding) return
  guarding = true
  try {
    // an occurrence acknowledged in another session is acknowledged here before anything is decided about it
    await hush(() => syncAcks($, false, true))
    const task = await read($, taskAtom)
    if (task === null) {
      // no task: only a condition still to be closed (told, or held back by quiet hours) calls for a look
      const held = (await read($, ledgerAtom)).alerts ?? []
      if (noticedOf(held).length === 0 && !held.some(a => a.outcome === 'deferred')) return
    }
    // the release records are read once per pass, strictly: the facts and the decision to close a NO-GO use the same read
    const release = await releaseRead($)
    const facts = task === null ? null : await alertFacts($, task, atStop, true, release.history)
    // every condition that holds now, the ones only told at a stop included: what a reminder or a resolution is judged against
    const open = facts === null ? [] : dueOf({ ...facts, atStop: true })
    {
      // a condition that was told or held back by quiet hours, and no longer holds (fixed, or its task is gone), is recorded resolved once; it is not announced, and if it holds again it is a new occurrence
      const now = await $.clock.now()
      const before = (await read($, ledgerAtom)).alerts ?? []
      const keys = open.map(o => o.key)
      // only a condition of a task this session has itself held is judged here: another session's, or one from before this
      // session, cannot be observed from here, and recording it resolved would turn UNKNOWN into a stored resolution
      if (facts !== null) ownedUids.add(facts.taskUid)
      const releaseBlind = !release.readable
      const closed = [...closedOf(before, keys), ...lapsedOf(before, keys)].filter(a => isOwned(a.key) && !(releaseBlind && a.kind === 'release-no-go'))
      if (closed.length > 0) {
        await update($, ledgerAtom, old => ({ ...old, alerts: closed.reduce((all, a) => boundedAlerts(all, { key: a.key, kind: a.kind, taskId: a.taskId, at: now, outcome: 'resolved', attempts: 0, channel: null }), old.alerts ?? []) }))
        await hush(() => persist($))
      }
    }
    if (task === null || facts === null) return
    // Record-only (alerts off): each condition that would be told is written down once for its occurrence, and nothing is sent.
    // No notification, no cue, no budget and no cooldown is touched; silence and the notified kinds govern telling, not recording.
    if (!guardCfg.enabled) {
      for (const one of dueOf(facts)) {
        const now = await $.clock.now()
        const kept = (await read($, ledgerAtom)).alerts ?? []
        if (episodeOf(kept, one.key).length > 0) continue
        await update($, ledgerAtom, old => ({ ...old, alerts: boundedAlerts(old.alerts ?? [], { key: one.key, kind: one.kind, taskId: task.id, at: now, outcome: 'recorded', attempts: 0, channel: null }) }))
        await hush(() => persist($))
      }

      return
    }
    // what is told on this pass: what is due now, and what quiet hours held back and is still open (a stop-only condition included)
    const owed = deferredOf((await read($, ledgerAtom)).alerts ?? []).map(d => d.key)
    const dueNow = dueOf(facts).map(d => d.key)
    const due = open.filter(o => dueNow.includes(o.key) || owed.includes(o.key))
    /** A due alert that is not sent leaves one record saying why, so it is never lost silently; the same reason is not written twice running. */
    const note = async (one: Open, outcome: 'throttled' | 'silenced' | 'deferred', why: AlertRecord['why'], now: number, since: number): Promise<void> => {
      const last = [...(await read($, ledgerAtom)).alerts ?? []].reverse().find(a => a.key === one.key)
      if (last?.outcome === outcome && last.why === why) return
      // an acknowledgment typed while this pass was deciding covers the record it is about to write, as it covers a notice
      const acked = isAckedSince(await read($, guardAtom), one.key, since)
      await update($, ledgerAtom, old => ({ ...old, alerts: boundedAlerts(old.alerts ?? [], { key: one.key, kind: one.kind, taskId: task.id, at: now, outcome, attempts: 0, channel: null, ...(why === undefined ? {} : { why }), ...(acked ? { acked: true as const } : {}) }) }))
      await hush(() => persist($))
    }
    // after quiet hours, several held-back conditions are one notification, not one each
    const batch: Open[] = []
    {
      const now = await $.clock.now()
      const state = await read($, guardAtom)
      const kept = (await read($, ledgerAtom)).alerts ?? []
      const late = due.filter(o => {
        if (!owed.includes(o.key) || holdOf(guardCfg, o.kind, now) !== null) return false
        const d = decideAlert(guardCfg, state, kept, o.key, now)

        return d.send || d.why === 'throttled' || d.why === 'budget'
      })
      if (late.length >= 2) {
        batch.push(...late)
        const first = decideAlert(guardCfg, state, kept, (late[0] as Open).key, now)
        if (!first.send) for (const one of late) await note(one, 'throttled', first.why === 'throttled' ? 'cooldown' : 'budget', now, state.seq ?? 0)
        else {
          const attempts = new Map(late.map(o => [o.key, episodeOf(kept, o.key).filter(a => a.outcome === 'failed' || a.outcome === 'refused').length + 1]))
          await update($, guardAtom, old => ({ ...old, pending: true }))
          const told = await notifyOwner($, digestOf(late.map(o => o.kind), task.id))
          await update($, guardAtom, old => ({ ...old, pending: false, sentAt: now, count: old.count + 1 }))
          const after = await read($, guardAtom)
          await update($, ledgerAtom, old => ({ ...old, alerts: late.reduce((all, one) => boundedAlerts(all, { key: one.key, kind: one.kind, taskId: task.id, at: now, attempts: attempts.get(one.key) ?? 1, ...told, ...(isAckedSince(after, one.key, state.seq ?? 0) ? { acked: true as const } : {}) }), old.alerts ?? []) }))
          await hush(() => persist($))
          cueOwner($, (late[0] as Open).key, now)
        }
      }
    }
    for (const one of due) {
      if (batch.includes(one)) continue
      const now = await $.clock.now()
      const state = await read($, guardAtom)
      const kept = (await read($, ledgerAtom)).alerts ?? []
      // held back, then acknowledged before anything was sent: the person knows, and it is not announced afterwards
      if (isSettledQuietly(kept, one.key)) continue
      const decision = decideAlert(guardCfg, state, kept, one.key, now)
      if (!decision.send && decision.why !== 'throttled' && decision.why !== 'budget') {
        // a silence mutes the notification, not the condition: one that was never told is recorded so it stays on the HUD
        if (decision.why === 'silenced' && !episodeOf(kept, one.key).some(a => a.outcome === 'sent')) await note(one, 'silenced', undefined, now, state.seq ?? 0)
        continue
      }
      // its kind is turned off, or quiet hours hold it: nothing is written to the terminal and no cue is played
      const hold = holdOf(guardCfg, one.kind, now)
      if (hold !== null) { await note(one, hold === 'quiet' ? 'deferred' : 'silenced', hold, now, state.seq ?? 0); continue }
      if (!decision.send) {
        // an alert that is due but held back is recorded once, with the reason, so a final blocked-run alert is never lost silently
        await note(one, 'throttled', decision.why === 'throttled' ? 'cooldown' : 'budget', now, state.seq ?? 0)
        continue
      }
      await update($, guardAtom, old => ({ ...old, pending: true }))
      const told = await notifyOwner($, alertMessage(one.kind, task.id))
      await update($, guardAtom, old => ({ ...old, pending: false, sentAt: now, count: old.count + 1 }))
      // an acknowledgment typed while the notification was being written covers it
      const acked = isAckedSince(await read($, guardAtom), one.key, state.seq ?? 0)
      await update($, ledgerAtom, old => ({ ...old, alerts: boundedAlerts(old.alerts ?? [], { key: one.key, kind: one.kind, taskId: task.id, at: now, attempts: decision.attempts, ...told, ...(acked ? { acked: true as const } : {}) }) }))
      await hush(() => persist($))
      cueOwner($, one.key, now)
    }
    // persistent alerts: a condition already told, still open and not acknowledged, is told again inside the same bounds
    if (guardCfg.repeat) {
      for (const one of open) {
        const now = await $.clock.now()
        const state = await read($, guardAtom)
        // this pass settles each notice before the next, so a mark seen here was left by a module that is gone: it costs one look, the `finally` clears it
        if (state.pending) continue
        // in the quiet window a reminder waits like any alert of its class; none is queued, so one comes due afterwards, not one per interval missed
        if (holdOf(guardCfg, one.kind, now) !== null) continue
        const again = remind(guardCfg, state, (await read($, ledgerAtom)).alerts ?? [], one.key, now)
        if (!again.send) continue
        await update($, guardAtom, old => ({ ...old, pending: true }))
        const told = await notifyOwner($, reminderOf(one.kind, task.id, again.nth, guardCfg.maxReminders))
        // a reminder is spent whether or not the host wrote it: a channel that keeps failing is not retried without end
        await update($, guardAtom, old => ({ ...old, pending: false, sentAt: now, count: old.count + 1 }))
        const acked = isAckedSince(await read($, guardAtom), one.key, state.seq ?? 0)
        await update($, ledgerAtom, old => ({ ...old, alerts: boundedAlerts(old.alerts ?? [], { key: one.key, kind: one.kind, taskId: task.id, at: now, attempts: 1, nth: again.nth, ...told, ...(acked ? { acked: true as const } : {}) }) }))
        await hush(() => persist($))
        cueOwner($, one.key, now)
      }
    }
  } catch { /* an alert that cannot be raised never fails the work */ } finally {
    guarding = false
    await update($, guardAtom, old => (old.pending ? { ...old, pending: false } : old)).catch(() => undefined)
    await armReminders($)
  }
}

/** The key of the occurrence with this id: what a single acknowledgment is noted against while a pass may be writing. */
const episodesKey = (kept: readonly AlertRecord[], id: string): string | null => episodesOf(kept).find(e => e.id === id)?.key ?? null
/**
 * The look marker (v0.5.9): one key per project holding the ids of the occurrences a person's `/cockpit alerts` last displayed, so
 * "since your last look" is counted by identity and not by the clock. A look writes the union of what the key held and what it
 * showed, with one `set`. That is a read and a write, not an atomic update: two sessions looking at once can leave the key
 * without the other's ids, and the next look then counts those occurrences as new again. It can over-report, never mark an
 * occurrence seen that nobody displayed. Best effort, and described so.
 */
const readSeen = async ($: EngineInterface, project: string | undefined): Promise<Set<string> | null | undefined> =>
  project === undefined ? undefined : seenIdsOf(await $.store.get(seenKeyOf(project)).catch(() => undefined))
const markSeen = async ($: EngineInterface, project: string, prev: ReadonlySet<string> | null, shown: readonly string[]): Promise<void> => {
  if (prev !== null && shown.every(id => prev.has(id))) return
  await $.store.set(seenKeyOf(project), { v: 1, ids: withSeen(prev, shown) })
  for (const k of excessSeenKeys(await $.store.keys(), seenKeyOf(project))) await $.store.delete(k)
}

// --- Cobalt Guard Calibration (v0.6.3; labels, the simulation and the wording: calibration.ts). An evaluation: it reads the alert records and the configuration and changes neither. ---
/**
 * What the calibration commands read: this session's records and the occurrences other sessions keep for the project in keys of
 * their own, with the acknowledgments and the labels the store holds, joined in memory. Read-only: nothing is written to the
 * Ledger, the store or the look marker, and no acknowledgment is taken up. The project is the Ledger's, or the hash of the
 * working directory when the Ledger has none; computing it ties nothing to a project.
 */
const calibrationView = async ($: EngineInterface): Promise<{ project: string; items: Reviewed[]; observation: Observation }> => {
  const ledger = await read($, ledgerAtom)
  const project = ledger.alertsProject !== undefined && PROJECT_RE.test(ledger.alertsProject) ? ledger.alertsProject : await alertProject($)
  const keys = await $.store.keys().catch(() => [] as string[])
  const own = ledger.alerts ?? []
  const mine = new Set(episodesOf(own).map(e => e.id))
  const stored: { id: string; records: AlertRecord[] }[] = []
  // bounded as the history is: at most the newest 32 occurrence keys of the project are read, and none this session already holds
  for (const id of occIdsOf(keys, project).filter(x => !mine.has(x)).slice(-OCC_PER_PROJECT)) {
    const v = (await $.store.get(occKeyOf(project, id)).catch(() => undefined)) as { v?: unknown; records?: unknown } | undefined
    const records = v?.v === 1 ? validAlerts(v.records) : []
    if (records.length > 0 && episodesOf(records)[0]?.id === id) stored.push({ id, records })
  }
  const { open, observation } = await observeAlerts($, [...own, ...stored.flatMap(s => s.records)])
  const labelled = labelledIdsOf(keys, project)
  const items: Reviewed[] = []
  for (const occurrence of observedOf(own, stored, ackedIdsOf(keys, project), open)) {
    const hasKey = labelled.has(occurrence.id)
    const value = hasKey ? await $.store.get(labelKeyOf(project, occurrence.id)).catch(() => undefined) : undefined
    items.push({ occurrence, label: labelOfValue(value), hasKey })
  }

  return { project, items, observation }
}
/**
 * Forgets the label keys whose occurrence is gone, after a person set or removed a label: besides the removal a person asks
 * for, the only place a label key is ever deleted. A label is kept while the store lists its occurrence's key, while this
 * session reads the occurrence (`own`), while any session's persisted Ledger of its project holds it (another session can
 * have pruned the occurrence's key at the bound while one that still holds it will write it again), and while an earlier-format
 * history of its project holds it. A store read that fails keeps the labels of every project that read was for, and an
 * earlier-format history that is not understood keeps the labels of its project; a session's persisted Ledger that is not of
 * this build's shape holds nothing. The key list is read again before anything is deleted, so an occurrence written meanwhile
 * keeps its label. Another session's label of an occurrence that the store or a session still holds is never among them.
 */
const sweepLabels = async ($: EngineInterface, project: string, own: ReadonlySet<string>): Promise<void> => {
  const isMine = (p: string, id: string): boolean => p === project && own.has(id)
  const keys = await $.store.keys()
  const candidates = orphanLabelKeys(keys, isMine)
  if (candidates.length === 0) return
  const projects = [...new Set(candidates.flatMap(k => parseLabelKey(k)?.project ?? []))]
  const elsewhere = new Map<string, (Set<string> | null)[]>(projects.map(p => [p, []]))
  const readOrNull = async (key: string, of: (value: unknown, p: string) => Set<string> | null): Promise<void> => {
    let value: unknown
    try { value = await $.store.get(key) } catch { for (const p of projects) elsewhere.get(p)?.push(null); return }
    for (const p of projects) elsewhere.get(p)?.push(of(value, p))
  }
  // what the sessions of the last few runs still hold, as they last persisted it
  for (const k of keys.filter(x => x.startsWith('ledger:'))) await readOrNull(k, ledgerIdsOf)
  for (const p of projects) if (keys.includes(historyKeyOf(p))) elsewhere.get(p)?.push(legacyIdsOf(await $.store.get(historyKeyOf(p)).catch(() => undefined), p, false))
  if (keys.includes(LEGACY_HISTORY_KEY)) await readOrNull(LEGACY_HISTORY_KEY, (value, p) => legacyIdsOf(value, p, true))
  // a project first seen in the second listing was not looked up: its labels are kept
  const isKept = (p: string, id: string): boolean => isMine(p, id) || (elsewhere.get(p) ?? [null]).some(ids => ids === null || ids.has(id))
  const still = new Set(orphanLabelKeys(await $.store.keys(), isKept))
  for (const k of orphanLabelKeys(keys, isKept)) {
    if (!still.has(k)) continue
    try { await $.store.delete(k) } catch { /* left in place: the next sweep finds it */ }
  }
}
const DIGEST_KEY = 'alert-digest'
const DIGEST_RELOAD_MS = 30 * 60_000
/**
 * The session start's one line, when `guardDigest` is on: shown in the terminal's own toast (never a desktop notification),
 * computed from the records. A hot reload fires the session start again and finds the host-held Ledger already this session's:
 * it shows nothing. A resume comes back with the same session id and an empty Ledger: the marker holds the session id and the
 * moment, and the line is not shown again for the same session within half an hour (two starts of one process in a row). A moment in the future (a clock stepped back) counts as recent. The marker is a read and a write of
 * one key, so two sessions starting at once can drop each other's entry; that can only show the line once more.
 */
const showDigest = async ($: EngineInterface): Promise<void> => {
  if (!guardCfg.digest) return
  const id = (await read($, ledgerAtom)).sessionId
  if (id === UNKNOWN) return
  const held = (await $.store.get(DIGEST_KEY).catch(() => undefined)) as { v?: unknown; shown?: unknown } | undefined
  const shown = held?.v === 1 && Array.isArray(held.shown) ? held.shown.filter((x): x is { id: string; at: number } => x !== null && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string' && typeof (x as { at?: unknown }).at === 'number').slice(-15) : []
  const now = await $.clock.now()
  if (shown.some(x => x.id === id && !(now - x.at >= DIGEST_RELOAD_MS))) return
  // marked before it is shown: a reload that comes straight after does not show it twice
  await $.store.set(DIGEST_KEY, { v: 1, shown: [...shown.filter(x => x.id !== id), { id, at: now }] })
  await hush(() => syncAcks($, false))
  const kept = (await read($, ledgerAtom)).alerts ?? []
  const open = await openAlerts($, kept)
  const line = digestToast(occurrencesOf(kept, open))
  if (line !== null) await $.ui.toast(line, { timeoutMs: 12_000 })
}
const guardView = async ($: EngineInterface) => ({ state: await read($, guardAtom), kept: (await read($, ledgerAtom)).alerts ?? [] })

// --- Verified notification transport (policy and wording: transport.ts). Tests are kept apart from the alerts and change no verdict. ---
const transportAtom = atom({ plugin: 'cobalt-cockpit', key: 'guard-transport' } as const, EMPTY_TRANSPORT)
/** Where the person is, as far as this process can say: the session, and whether it was started in an SSH session. */
const transportScope = async ($: EngineInterface) => ({
  session: (await $.session.id().catch(() => '')) || '',
  link: linkOf(await $.env.get('SSH_CONNECTION').catch(() => undefined), await $.env.get('SSH_TTY').catch(() => undefined)),
  now: await $.clock.now(),
})
/**
 * What the alert status needs beyond the records: the moment, what holds now, the connection, and the channel the host
 * last reported writing to in this session (an alert's or a test's), which is all that is known about how it sounds.
 */
const guardSeen = async ($: EngineInterface, kept: readonly AlertRecord[]): Promise<GuardView> => {
  const scope = await transportScope($).catch(() => ({ session: '', link: 'local' as const, now: 0 }))
  const tests = await read($, transportAtom).then(t => myTests(validTransport(t), scope.session)).catch(() => [])
  const last = [...kept.filter(a => a.outcome === 'sent' && a.channel !== null).map(a => ({ at: a.at, channel: a.channel })), ...tests.filter(a => a.outcome === 'sent' && a.channel !== null).map(a => ({ at: a.at, channel: a.channel }))].sort((a, b) => a.at - b.at).at(-1)

  return { now: scope.now, open: await openAlerts($, kept), channel: last?.channel ?? null, isSsh: scope.link === 'ssh' }
}
/** The HUD's one alert row: open conditions, and a transport nobody confirmed. Null when there is nothing to pin or it cannot be read. */
const guardPin = async ($: EngineInterface, view: { state: typeof EMPTY_GUARD; kept: AlertRecord[] }, width: number): Promise<PinLine | null> => {
  try {
    if (!isRecording(guardCfg)) return null
    // record-only sends nothing, so an unconfirmed transport is not something to ask the person about
    const scope = await transportScope($)
    const unconfirmed = guardCfg.enabled && transportStatus(validTransport(await read($, transportAtom)), scope.session, scope.link, scope.now) !== 'USER CONFIRMED'

    const { open, observation } = await observeAlerts($, view.kept)
    const counts = hudCountsOf(occurrencesOf(view.kept, open), observation)

    return pinLine(pinsOf(view.kept, open), unconfirmed, guardLabel(guardCfg, view.state, view.kept), width, counts.unread, counts)
  } catch { return null }
}
const transportText = async ($: EngineInterface): Promise<string[]> => {
  try {
    const scope = await transportScope($)

    return transportLines(validTransport(await read($, transportAtom)), scope.session, scope.link, scope.now, { enabled: guardCfg.enabled, repeat: guardCfg.repeat })
  } catch { return ['TRANSPORT: NOT TESTED (the transport state could not be read just now)'] }
}
/** Four random bytes for a test's code: the host's web crypto when it has one, the clock otherwise. */
const codeBytes = (at: number): number[] => {
  try {
    const bytes = new Uint8Array(4)
    globalThis.crypto.getRandomValues(bytes)

    return [...bytes]
  } catch { return [at, at / 31, at / 961, at / 29_791].map(n => Math.floor(n) % 256) }
}
/** One test at a time: the limit is read and the test recorded without another slipping between. */
let isTesting = false
/** One labelled test notification, asked for by the person. It touches no alert record, budget, gate or approval. */
const sendTest = async ($: EngineInterface, wantsSound: boolean): Promise<string> => {
  if (isTesting) return 'Cockpit: a test notification is being sent right now. Nothing more was sent.'
  isTesting = true
  try { return await sendTestNow($, wantsSound) } finally { isTesting = false }
}
const sendTestNow = async ($: EngineInterface, wantsSound: boolean): Promise<string> => {
  const scope = await transportScope($)
  const may = mayTest(validTransport(await read($, transportAtom)), scope.session, scope.now)
  if (!may.ok) return may.why === 'cooldown' ? `Cockpit: a test was sent a moment ago; try again in ${may.waitSec}s. Nothing was sent.` : may.why === 'budget' ? 'Cockpit: this session has used all of its test notifications. Nothing was sent.' : 'Cockpit: the session could not be identified, so a test could not be tied to it. Nothing was sent.'
  const code = codeOf(codeBytes(scope.now))
  const told = await notifyOwner($, testMessage(code))
  const test: TransportTest = { code, at: scope.now, session: scope.session, link: scope.link, outcome: told.outcome === 'sent' ? 'sent' : told.outcome === 'refused' ? 'refused' : 'failed', channel: told.channel, ...(told.why === undefined ? {} : { why: told.why }), sound: wantsSound ? 'pending' : 'not-requested' }
  await update($, transportAtom, old => addedTest(validTransport(old), test))
  if (wantsSound) {
    // started and not waited for, like an alert's cue; the test is marked once a player answered, or none did
    void (async () => {
      const played = await sound($, 'checkpoint')
      await update($, transportAtom, old => ({ tests: validTransport(old).tests.map(a => (a.code === code && a.at === scope.now && a.sound === 'pending' ? { ...a, sound: played === null ? 'none' as const : played === 'bell' ? 'bell' as const : 'sound' as const } : a)) }))
    })().catch(() => undefined)
  }

  return [test.outcome === 'sent' ? `Cockpit: a TEST notification was SENT via ${test.channel ?? 'unknown'}. The host reported writing it; that is not proof you saw it.` : `Cockpit: a TEST notification was ATTEMPTED and not sent (${test.outcome}${test.why === undefined ? '' : `: ${test.why}`}).`,
    test.outcome !== 'sent' ? 'There is nothing to confirm. /cockpit guard shows why.' : test.channel === 'terminal_bell' ? 'This channel only rings the bell and shows no text. If you heard or saw the bell, type /cockpit guard seen.' : 'If you saw it, type /cockpit guard seen <the code it shows>. If you did not, do not confirm.',
    'No gate, hold, review, approval, alert record or alert budget was touched.'].join('\n')
}
const CONFIRM_TEXT = {
  confirmed: 'Cockpit: recorded. You confirmed the test notification in this session. That is your statement, not proof of delivery, and it is not carried to another session.',
  already: 'Cockpit: the latest test is already confirmed; nothing was changed.',
  none: 'Cockpit: there is no test notification in this session to confirm. /cockpit guard test sends one. Nothing was changed.',
  'not-sent': 'Cockpit: the host did not report writing the latest test, so it cannot be confirmed. Nothing was changed.',
  expired: 'Cockpit: the latest test is too old to confirm (10 minutes). Send a new one with /cockpit guard test. Nothing was changed.',
  'other-link': 'Cockpit: the connection kind changed since the test was sent, so it cannot be confirmed here. Send a new one. Nothing was changed.',
  'wrong-code': 'Cockpit: that is not the code of the latest test; nothing was changed.',
  'bad-code': 'Cockpit: a test code is four letters or digits. Usage: /cockpit guard seen [code]. Nothing was changed.',
  'needs-code': 'Cockpit: this channel shows the notification text, so type the code it showed: /cockpit guard seen <code>. If you did not see it, there is nothing to confirm. Nothing was changed.',
} as const
const confirmSeen = async ($: EngineInterface, typed: string): Promise<string> => {
  const scope = await transportScope($)
  const outcome = confirmTest(validTransport(await read($, transportAtom)), scope.session, scope.link, typed, scope.now)
  if (outcome.result === 'confirmed') await update($, transportAtom, old => confirmTest(validTransport(old), scope.session, scope.link, typed, scope.now).transport)

  return CONFIRM_TEXT[outcome.result]
}


// --- Optional Stop-hook verification guard (policy and wording: stopguard.ts). ---
let stopOptions: Readonly<Record<string, unknown>> = {}
let stopCfg: StopConfig = stopConfigOf({}, null)
/** The guard's settings with ~ resolved against HOME; refreshed whenever the guard is consulted. */
/** The guard can be asked for a verdict: ENFORCE with a usable script. Only then is DONE the guard's to give. */
const guardEnforcing = (): boolean => stopCfg.policy === 'ENFORCE' && stopCfg.problems.length === 0 && stopCfg.script !== null

const loadStopCfg = async ($: EngineInterface): Promise<StopConfig> => {
  stopCfg = stopConfigOf(stopOptions, (await $.env.get('HOME').catch(() => undefined)) ?? null)
  setGuardRequired(stopCfg.policy === 'ENFORCE')

  return stopCfg
}

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
const sha256Text = async (text: string): Promise<string> => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

/** The script's sha-256 over its raw bytes; null when it cannot be read. */
const rawSha = async ($: EngineInterface, path: string): Promise<string | null> => {
  try {
    const { base64 } = await $.fs.read(path, { as: 'bytes' })
    const bin = atob(base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)

    return hex(await crypto.subtle.digest('SHA-256', bytes))
  } catch { return null }
}

/** The Stop guard's and the alerts' own settings: they decide whether a task may finish, so only the person changes them. */
const GUARD_FIELDS = /^(?:stopGuard|verifyScript|verifyScriptSha256|verifyTimeoutSec|stopMaxContinuations|stopVolatile|stopWatch|guardAlerts|guardCooldownSec|guardMaxAlerts|guardRepeat|guardRepeatSec|guardMaxReminders|guardSound|guardNotifyKinds|guardQuietHours|guardQuietTimezone|guardQuietOrdinary|guardQuietCritical|guardDigest|guardRecordOnly)$/
const isGuardRow = (e: { key: string }): boolean => {
  const at = e.key.indexOf('.')

  return (at > 0 && e.key.slice(0, at) === 'cobalt-cockpit' && GUARD_FIELDS.test(e.key.slice(at + 1)))
}
/** Only the person's own change in the config menu: the bridge is not attestably the owner's hand, a plugin's `$.config.set` never is. */
const isMenuChange = (e: { origin?: unknown }): boolean => typeof e.origin === 'object' && e.origin !== null && (e.origin as { kind?: unknown }).kind === 'composer'
const GUARD_ROW_REFUSED = 'COBALT / the Stop guard and alert settings are changed only by you in the config menu; nothing was changed.'

const TRUST_KEY = 'stop-trust'
type TrustRecord = { sha: string; at: number }
const trustMap = async ($: EngineInterface): Promise<Record<string, TrustRecord>> => {
  const held = await $.store.get(TRUST_KEY).catch(() => undefined)
  const out: Record<string, TrustRecord> = {}
  if (held !== null && typeof held === 'object') {
    for (const [k, v] of Object.entries(held as Record<string, unknown>).slice(0, 32)) {
      const r = v as Partial<TrustRecord> | null
      if (typeof k === 'string' && r !== null && typeof r === 'object' && typeof r.sha === 'string' && /^[0-9a-f]{64}$/.test(r.sha) && typeof r.at === 'number') out[k] = { sha: r.sha, at: r.at }
    }
  }

  return out
}
/** Trust is per project and per script path, so it follows neither a task reset nor another repository. */
const trustScope = async ($: EngineInterface, script: string): Promise<{ key: string; verifier: string }> => {
  const cwd = (await $.session.cwd().catch(() => '')) || ''
  const key = `${cwd}\0${script}`

  return { key, verifier: (await sha256Text(key)).slice(0, 12) }
}

type TrustState = { state: 'enrolled' | 'not-enrolled' | 'changed' | 'pin-mismatch' | 'missing'; sha: string | null; verifier: string }
const trustState = async ($: EngineInterface, c: StopConfig): Promise<TrustState> => {
  const script = c.script as string
  const scope = await trustScope($, script)
  const sha = await rawSha($, script)
  if (sha === null) return { state: 'missing', sha, verifier: scope.verifier }
  if (c.pin !== null && sha !== c.pin) return { state: 'pin-mismatch', sha, verifier: scope.verifier }
  const enrolled = (await trustMap($))[scope.key]
  if (enrolled === undefined) return { state: 'not-enrolled', sha, verifier: scope.verifier }

  return { state: enrolled.sha === sha ? 'enrolled' : 'changed', sha, verifier: scope.verifier }
}
const TRUST_WORDS: Record<TrustState['state'], string> = { enrolled: 'enrolled', 'not-enrolled': 'not enrolled', changed: 'changed since it was enrolled', 'pin-mismatch': 'does not match its pin', missing: 'missing' }

/** Runs the owner's check once, on a tree that must not move. Argv only, never a shell; a refusal or failure to start is final. */
const runStopCheck = async ($: EngineInterface, task: Task, hasSummary: boolean, prior: readonly CheckRecord[]): Promise<CheckRecord> => {
  const script = stopCfg.script as string
  const at = await $.clock.now()
  const name = script.slice(script.lastIndexOf('/') + 1)
  const uid = uidOf(task)
  const trust = await trustState($, stopCfg)
  const rec = (r: Partial<CheckRecord> & Pick<CheckRecord, 'outcome'>): CheckRecord => ({ taskId: task.id, uid, verifier: trust.verifier, complete: false, name, sha: null, at, exit: null, ms: null, tree: null, summary: '', hasSummary, ...r })
  if (trust.state === 'missing') return rec({ outcome: 'missing' })
  const short = (trust.sha as string).slice(0, 8)
  if (trust.state !== 'enrolled') return rec({ outcome: 'untrusted', sha: short, summary: TRUST_WORDS[trust.state] })
  // a task keeps the verifier it started with: another script or project cannot take over its verdict
  const first = prior.find(c => c.uid === uid && c.outcome !== 'released')
  if (first !== undefined && first.verifier !== trust.verifier) return rec({ outcome: 'untrusted', sha: short, summary: 'another verifier than the one this task started with' })
  const cwd = await $.session.cwd().catch(() => undefined)
  try {
    // Before EVERY execution the script is checked against the enrolled bytes again, and once more after it ran: a swap between
    // two runs, or during one, makes the result untrusted. The exec itself is by path, so the interval between this check and the
    // exec remains (the plugin API has no exec-by-descriptor); it is narrowed, not closed.
    const runOnce = async () => {
      const now = await trustState($, stopCfg)
      if (now.state !== 'enrolled' || now.sha !== trust.sha) return null
      const out = await $.process.run([script], { timeoutMs: stopCfg.timeoutMs, ...(cwd === undefined ? {} : { cwd }) })

      return (await rawSha($, script)) === trust.sha ? out : null
    }
    const changedMeanwhile = () => rec({ outcome: 'untrusted', sha: short, summary: 'changed while the guard was using it' })
    // A check that leaves artifacts behind (a cache directory, build output) moves the tree itself. It is run once more from
    // the tree it left, and only a tree that still moves is unstable. At most two runs; a check cannot loop here.
    let before = await treeStamp($)
    let r = await runOnce()
    if (r === null) return changedMeanwhile()
    let after = await treeStamp($)
    if (before !== null && after !== null && before !== after) {
      before = after
      r = await runOnce()
      if (r === null) return changedMeanwhile()
      after = await treeStamp($)
    }
    const ms = (await $.clock.now()) - at
    const summary = outputTail(redactSecrets(`${r.stderr}\n${r.stdout}`))
    // two fingerprints are not an atomic snapshot, but a tree seen to move while the check ran is not what was checked
    if (before !== null && after !== null && before !== after) return rec({ outcome: 'unstable', sha: short, exit: r.exitCode, ms, tree: after, summary })
    // a pass is only a pass about a tree seen at both ends: an unknown start cannot show the tree stood still
    if (r.exitCode === 0) return rec({ outcome: 'pass', sha: short, exit: 0, ms, tree: before === null ? null : after, summary })

    return rec({ outcome: ms >= stopCfg.timeoutMs ? 'timeout' : 'fail', sha: short, exit: r.exitCode, ms, tree: after, summary })
  } catch (error) {
    const text = String((error as { message?: unknown })?.message ?? '')

    return rec({ outcome: /time/i.test(text) ? 'timeout' : 'error', sha: short, summary: outputTail(redactSecrets(text)) })
  }
}

/**
 * Whether the work changed since the task began: UNCHANGED and CHANGED are measured, UNKNOWN is neither. Unknown is never
 * proof of an unchanged tree, and it is not evidence of a change either; it asks for the check without calling the task coding.
 */
const changeState = async ($: EngineInterface, task: Task): Promise<{ state: TreeVerdict; why: string; tree: string | null }> => {
  if (hasChanges(task)) return { state: 'CHANGED', why: 'edits were observed', tree: null }
  // A task is measured only against its own start. With no known starting fingerprint (git was unreadable when it began, or no
  // prompt began it) nothing can be said about what changed, and the end state is never used to reconstruct one: `git status` being
  // clean at the Stop, after a commit, an index flag or a repaired repository, is not evidence that no work occurred.
  if (typeof task.startTree !== 'string') return { state: 'UNKNOWN', why: 'the task has no known starting fingerprint', tree: null }
  const now = await treeStamp($)
  const state = compareTree(task.startTree, now)

  return { state, why: state !== 'UNKNOWN' ? '' : treeWhy, tree: now }
}

/** The guard's record that a read-only task changed nothing: only a tree measured equal to the task's own start qualifies. */
const recordUnchanged = async ($: EngineInterface, task: Task, tree: string | null): Promise<void> => {
  if (tree === null || tree !== task.startTree || isGuardOwned(task)) return
  const at = await $.clock.now()
  const name = (stopCfg.script as string).slice((stopCfg.script as string).lastIndexOf('/') + 1)
  await keepCheck($, { taskId: task.id, uid: uidOf(task), verifier: (await trustState($, stopCfg)).verifier, complete: true, name, sha: null, at, outcome: 'unchanged', exit: null, ms: 0, tree, summary: 'the working tree equals the fingerprint taken when the task began; no check was needed', hasSummary: true })
  await hush(() => persist($))
  await change($, (t, now) => (t.guardDone === undefined && uidOf(t) === uidOf(task) && t.stopHold === undefined ? { ...t, guardDone: { uid: uidOf(t), tree, check: `${name}@${at}`, outcome: 'unchanged' as const, at: now } } : t))
}

/**
 * Why a verified completion no longer rests on the trust in force, or null when it does. Its check, as the Run Ledger keeps it,
 * must have run for this script and project (verifier), on these bytes, after the current enrolment, with the script enrolled
 * and matching its pin now. A withdrawn, re-enrolled or changed trust, or a check that cannot be found, is not in force. A
 * record that the tree was unchanged ran no script and rests on no trust (v0.6.6).
 */
const completionDistrust = async ($: EngineInterface, task: Task): Promise<string | null> => {
  const done = task.guardDone
  if (done === undefined || done.outcome !== 'verified') return null
  if (stopCfg.script === null) return 'no verification script is configured now'
  const trust = await trustState($, stopCfg)
  if (trust.state !== 'enrolled') return `the verification script ${trust.state === 'pin-mismatch' ? '' : 'is '}${TRUST_WORDS[trust.state]}`
  const run = (await checksOf($)).find(c => c.uid === done.uid && c.complete && c.outcome === 'pass' && `${c.name}@${c.at}` === done.check)
  if (run === undefined) return 'the check it rests on is no longer in the Run Ledger'
  if (run.verifier !== trust.verifier || run.sha === null || !(trust.sha ?? '').startsWith(run.sha)) return 'it was checked under another trust'
  const enrolled = (await trustMap($))[(await trustScope($, stopCfg.script)).key]
  if (enrolled === undefined || enrolled.at > run.at) return 'the trust it was checked under was withdrawn or enrolled again since'

  return null
}

const REVOKED_NOTE = ' The completion this task was verified with under the earlier trust no longer counts; the check runs again at the next Stop.'

/**
 * A typed untrust or enrolment replaces the trust for one script and project. A completion the current task's check verified
 * under it is revoked at once. A completion whose check record shows another verifier is left (the completion check still
 * weighs it against the trust in force). One whose check record cannot be found cannot be shown to be unrelated, so it is
 * revoked too (v0.6.6).
 */
const revokeScoped = async ($: EngineInterface, verifier: string, why: string): Promise<boolean> => {
  const done = (await read($, taskAtom))?.guardDone
  if (done === undefined || done.outcome !== 'verified') return false
  const run = (await checksOf($)).find(r => r.uid === done.uid && `${r.name}@${r.at}` === done.check)
  if (run !== undefined && run.verifier !== verifier) return false
  await change($, t => (t.guardDone?.check === done.check ? revokeTrustedCompletion(t, why) : t))

  return true
}

/**
 * Before another task can start or a session can go on: a task that claims to be finished is checked against the guard's own
 * record. No record for this task, a record for another tree, a tree that cannot be identified, or a record whose trust is no
 * longer in force: the task is held, so what was done without a completed check is neither DONE nor the next task's baseline.
 * A read-only task whose tree still equals its own start needs no check and is recorded here.
 */
const reconcileCompletion = async ($: EngineInterface): Promise<void> => {
  await loadStopCfg($)
  await hush(() => adoptLegacyHold($))
  if (!guardEnforcing()) return
  const task = await read($, taskAtom)
  if (task === null || isGuardHeld(task) || task.milestones.length === 0 || !task.milestones.every(m => m.state === 'done')) return
  let why: string | null = null
  let distrust: string | null = null
  if (task.guardDone !== undefined && isGuardOwned(task)) {
    const now = await treeStamp($, baseOf(task.guardDone.tree))
    const whyTree = treeWhy
    distrust = await completionDistrust($, task)
    if (now !== null && now === task.guardDone.tree && distrust === null) return
    why = distrust !== null
      ? `the trust this completion was checked under is no longer in force (${distrust})`
      : now === null ? `the tree cannot be identified (${whyTree}), so the guard's record for it cannot be matched` : 'the tree changed after the guard completed this task'
  } else if (task.kind === 'readonly' && typeof task.startTree === 'string') {
    const now = await treeStamp($)
    if (now !== null && now === task.startTree) return recordUnchanged($, task, now)
    why = now === null ? `the tree cannot be identified (${treeWhy}); a read-only task is only complete on a tree known to equal its start` : 'the tree changed after this read-only task began'
  } else {
    why = 'the task finished without a completed Stop check for this task and tree'
  }
  const reason = why
  const revoked = distrust
  await change($, (t, now) => (uidOf(t) === uidOf(task) && !isGuardHeld(t) ? holdTask(revoked !== null ? revokeTrustedCompletion(t, revoked) : withdrawDone(t), reason, 0, now) : t))
}

const stopGuard = async ($: EngineInterface, e: { stop_hook_active?: boolean; last_assistant_message?: string }): Promise<string | null> => {
  await loadStopCfg($)
  await hush(() => adoptLegacyHold($))
  let task = await read($, taskAtom)
  if (stopCfg.policy !== 'ENFORCE') return null
  // ENFORCE that cannot be carried out is not OBSERVE. The stop is refused once with the reason (a person can always end the
  // session: the repeat is allowed), and a task is held so it cannot read DONE until the configuration is fixed and a check passes.
  if (stopCfg.problems.length > 0 || stopCfg.script === null) {
    const problem = stopCfg.problems.join('; ') || 'verifyScript is not set'
    if (task !== null && !isGuardHeld(task)) await change($, (t, now) => holdTask(t, `the Stop guard is set to ENFORCE but cannot run: ${problem}`, 0, now))

    return e.stop_hook_active === true ? null : `STOP GUARD: ENFORCE is configured but cannot run (${problem}). Nothing has been verified. Tell the person to fix the plugin options; do not claim the work is verified. (this stop is refused once)`
  }
  // Work with no task at all (no prompt was seen, or the task was reset) is still work: a changed repository is checked as a
  // coding task, and only a repository known to be clean needs nothing.
  if (task === null) {
    // A clean `git status` is not evidence that nothing happened: a tool that can write ran with no task (or an unverified task was
    // reset), and that obligation stands until a check completes. With no such evidence and no visible change there is nothing to ask:
    // a conversation that touched nothing is not made to verify, even where git cannot be read (the host gives no more to go on).
    const owed = await read($, owedAtom)
    if (owed === null) {
      await quiet(() => refreshGit($))
      if (((await read($, gitAtom))?.dirty ?? 0) === 0) return null
    }
    const now = await $.clock.now()
    const sha = (await read($, gitAtom))?.sha ?? null
    const why = owed === null ? 'changes were found with no task in progress' : owed.why
    task = await update($, taskAtom, old => old ?? markEdited({ ...newTask(1, '', now, sha), startTree: null }, why))
    if (task === null) return null
  }
  // a record that still matches this task and this tree, under the trust in force now: there is nothing to ask again
  if (!isGuardHeld(task) && isGuardOwned(task) && task.guardDone !== undefined) {
    const now = await treeStamp($, baseOf(task.guardDone.tree))
    const distrust = await completionDistrust($, task)
    if (now !== null && now === task.guardDone.tree && distrust === null) return null
    await change($, t => (distrust !== null ? revokeTrustedCompletion(t, distrust) : withdrawDone(t)))
  }
  const seen = isGuardHeld(task) ? { state: 'CHANGED' as TreeVerdict, why: 'the task is held', tree: null } : await changeState($, task)
  if (seen.state === 'UNCHANGED') {
    if (task.kind === 'readonly') await recordUnchanged($, task, seen.tree)

    return null
  }
  // a read-only claim contradicted by a tree known to differ from the task's start is a coding task from here on; an unknown
  // tree is checked but not called a change
  if (task.kind === 'readonly' && seen.state === 'CHANGED' && !isGuardHeld(task) && !hasChanges(task)) await change($, (t, at) => reclassifyChanged(t, at))
  // A task with no known starting fingerprint was never measurable: the check runs for that reason, and the record says so.
  let unknownWhy = seen.state === 'UNKNOWN' ? seen.why : ''
  if (unknownWhy === '' && typeof task.startTree !== 'string' && task.edited !== true && task.files.length === 0) {
    const nowTree = await treeStamp($)
    unknownWhy = nowTree === null ? treeWhy : 'the task has no known starting fingerprint'
  }
  const unknownNote = unknownWhy === '' ? '' : `[change detection unknown: ${unknownWhy}] `
  const uid = uidOf(task)
  // the Ledger is where the attempts are kept, so a resumed session finds the budget as it was left
  const checks = await checksOf($)
  const spent = spentOf(checks, task)
  const hasSummary = hasChangeSummary(e.last_assistant_message)
  const lastRun = [...checks].reverse().find(c => c.uid === uid)
  // every check since the last one that completed the task is an attempt, whatever it said: the budget cannot be reset by a pass.
  // A spent budget stays spent until a person releases the hold; the hold is put back if it is somehow missing.
  if (spent >= stopCfg.maxAttempts) {
    if (!isGuardHeld(task) && lastRun !== undefined && !lastRun.complete) await change($, (t, now) => holdTask(t, 'the refusal budget is spent without a completed check', spent, now))

    return null
  }
  // a refusal or a script that cannot start is final for this task: it is not asked again
  if (lastRun !== undefined && (lastRun.outcome === 'error' || lastRun.outcome === 'untrusted')) {
    if (!isGuardHeld(task)) await change($, (t, now) => holdTask(t, `the last check could not run (${lastRun.outcome})`, spent, now))

    return null
  }
  // Reserve the attempt BEFORE running or writing its log. Exceptions, failed log writes and recovery cannot renew it.
  // If the task changed or its allowance was consumed meanwhile, this check no longer has a reservation.
  let reserved = false
  await change($, (t, now) => {
    reserved = false
    if (uidOf(t) !== uid || spentOf(checks, t) !== spent) return t
    reserved = true
    return holdTask(t, 'a Stop check is in progress', spent + 1, now)
  })
  if (!reserved) return null
  const run = await runStopCheck($, task, hasSummary, checks)
  const unidentified = run.outcome === 'pass' && run.tree === null
  const whyNow = treeWhy
  const verdict = verdictOf({ cfg: stopCfg, spent, run, hasSummary })
  // a pass on a tree the guard cannot identify is not a completion: it would be a record of nothing
  const isComplete = verdict.action === 'allow' && verdict.state === 'VERIFIED' && !unidentified
  const notes = `${unknownNote}${unidentified ? `[tree identity unknown: ${whyNow}; a pass on it is not recorded as verified] ` : ''}`
  const done: CheckRecord = { ...run, complete: isComplete, ...(notes === '' ? {} : { summary: oneLine(`${notes}${run.summary}`, 600) }) }
  await keepCheck($, done)
  // a completed check on an identified tree discharges the obligation (a failed, unstable or unidentified one does not)
  if (isComplete) await update($, owedAtom, () => null)
  await hush(() => persist($))
  const detail = run.exit === null ? run.outcome : `${run.outcome} (exit ${run.exit})`
  await change($, (t, now) => {
    if (uidOf(t) !== uid) return t // a result for a replaced task cannot hold or complete its successor
    let chain = t
    if (run.outcome === 'pass' && run.tree !== null) chain = checkedAt(chain, run.tree)
    // Exit 0 on a tree the guard cannot identify is an observation, kept in the Ledger record above and in the gate's evidence,
    // not a qualified TEST pass; and checks observed on a measured tree cannot be shown to describe this one (v0.6.6).
    if (unidentified) chain = setGate(checkedAt(chain, null, whyNow), 'TEST', 'pending', unqualifiedEvidence(`stop check ${run.name} ${detail}`, whyNow), 'auto', now)
    else if (run.outcome === 'pass' || run.outcome === 'fail' || run.outcome === 'timeout') chain = setGate(chain, 'TEST', run.outcome === 'pass' ? 'pass' : 'fail', `stop check ${run.name} ${detail}`, 'auto', now)
    if (run.outcome === 'pass' && run.tree !== null) chain = stampGates(chain, run.tree, ['TEST'])
    // Every check that did not complete the task holds it, not only once the budget is spent: the refusal count bounds the loop,
    // the hold keeps the task from reading DONE in between (and across a prompt, a restart or a release).
    if (!isComplete) {
      const reason = unidentified
        ? `the check passed but the tree identity is unknown (${whyNow}); no completion is recorded`
        : verdict.action === 'block'
          ? `the last check ${run.outcome === 'pass' ? 'passed but the change summary was missing' : run.outcome}: attempt ${spent + 1} of ${stopCfg.maxAttempts}`
          : 'reason' in verdict ? verdict.reason : `the last check ${run.outcome}`

      return holdTask(chain, reason, spent + 1, now)
    }
    // the completion record is written in the same step that lifts the hold, after the result was persisted above
    if (uidOf(chain) !== uid) return chain                                              // another task by now: this record is not for it
    return { ...clearHold(chain, now), guardDone: { uid: uidOf(chain), tree: run.tree as string, check: `${run.name}@${run.at}`, outcome: 'verified' as const, at: now } }
  })

  return verdict.action === 'block' && !unidentified ? verdict.reason : null
}

export const register: Register = (on, options) => {
  const profile: Profile = isProfile(options['profile']) ? options['profile'] : DEFAULT_PROFILE
  const isLed = profile === 'SONNET_LED'
  config = {
    hasHud: options['hud'] !== false,
    hasFlow: options['flow'] !== false,
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
    routerConfigDir: typeof options['routerConfigDir'] === 'string' && /^(?:\/|~\/)[^\0\n]{1,1024}$/.test(options['routerConfigDir'].trim()) && !/(?:^|\/)\.\.(?:\/|$)/.test(options['routerConfigDir']) ? options['routerConfigDir'].trim() : '',
  }

  setTelemetry(options['telemetry'] !== false)
  stopOptions = options
  guardCfg = guardConfigOf(options)
  stopCfg = stopConfigOf(options, null)
  // what limits a measurement process runs under is probed again for this registration's host
  boundMode = null
  boundRetryAt = 0
  // the process slots are not reset: a measurement started before this registration still holds its slot until it ends
  // Before the first settings read the home directory is unknown, so `~/…` cannot be expanded: ENFORCE with a script named is
  // enforcing already (fail closed); loadStopCfg refines it once the configuration is read.
  setGuardRequired(stopCfg.policy === 'ENFORCE')
  registerLedger(on)

  // another Cockpit that registers after this one: all the host lets a plugin see of the others
  on('plugin.register', async ($, e, next) => {
    if (e.name === 'cobalt-cockpit' && e.root !== $.plugin.root && otherCockpits.length < 8) otherCockpits.push({ root: e.root, provenance: e.provenance })

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await quiet(async () => {
      const version = await $.session.version()
      isSupported = isAtLeast(version.base ?? version.version, MIN_VERSION)
      cacheReading = await cacheFacts($)
      hasNativeEffort = isAtLeast(version.base ?? version.version, NATIVE_EFFORT_VERSION)
      if (!isSupported) {
        $.ui.log(`cobalt-cockpit needs Claude Code ${MIN_VERSION.join('.')} or newer (this is ${version.version}); it is standing by.`)
      }
    })
    if (!isSupported) return next(e)

    // Left to the host's deferral. Listing it in the prompt (isDeferred: false)
    // was measured in v0.5.0: 768 more prompt tokens on every request and no more
    // progress reporting. What moved reporting is the one observed reminder below.
    await quiet(() => $.tool.register(PROGRESS_TOOL))
    await quiet(() => $.tool.register(SWARM_TOOL))
    await quiet(() =>
      $.command.register({
        name: 'cockpit',
        description: 'Mission Control: task progress, milestones, verification gates, git and context',
        argumentHint: '[status|reset|mute|unmute|hud on|hud off|auth|version|stats 7d|30d|all|flow|guard|alerts|agents|ready|doctor|sound]',
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
    // a hot reload finds the host-held Ledger already belonging to this session; a resume or a new process finds it empty
    let isReload = false
    try {
      const id = (await $.session.id().catch(() => '')) || UNKNOWN
      isReload = id !== UNKNOWN && (await read($, ledgerAtom)).sessionId === id
    } catch { /* unreadable: treated as not a reload, and the marker decides */ }
    await ledgerStart($)
    // opt-in (guardDigest): one line about unacknowledged recorded alerts, once for this session, never again on a reload
    if (!isReload) await quiet(() => showDigest($))
    await changeSwarm($, held => configureSwarm(held, { total: config.maxSubagents, sonnet: config.maxSonnet, haiku: config.maxHaiku, opus: isSonnetLed() ? (SONNET_LED_SWARM.opus as number) : 0 }))
    void refreshGit($)
    void refreshMeter($)
    // The NobodyWho watcher: read-only, stat-gated, and started only once the
    // ledger's location is known. Its first read primes at the end of the file,
    // so nothing historical ever reaches the HUD.
    await quiet(() => startLedgerWatch($))
    // persistent alerts: a reload or a restart finds what is still open in the kept records and resumes, it does not start over
    isSessionOver = false
    ownedUids.clear()
    await armReminders($)
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
    isSessionOver = true
    stopReminders()
    band = null
    foldTimer?.cancel()
    foldTimer = null
    gitTimer?.cancel()
    gitTimer = null
    // The router belongs to the session that chose it: whatever follows starts OFF.
    await quiet(() => update($, routerAtom, held => held.mode === 'OFF' ? held : switchRouter(held, 'OFF')))
    if (e.reason === 'clear') {
      // a /clear ends the conversation the task belonged to; a task the guard held is recorded as abandoned, not as done
      await quiet(async () => { await carryObligation($, await read($, taskAtom), '/clear') })
      await quiet(async () => { await recordAbandoned($, await read($, taskAtom), '/clear') })
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
    const apiDrop = await apiRefusal($)
    if (apiDrop !== null) return { drop: apiDrop }
    if (!isSupported) return next(e)
    // a task saved before the hold was a field of its own is settled before this prompt can start another task
    await hush(() => reconcileCompletion($))
    // The init line has done its job the moment real work arrives.
    await dismissStartup($)
    const added: string[] = []
    await quiet(async () => {
      const isPerson = isPersonOrigin(e.origin)
      if (!isPerson) return
      const now = await $.clock.now()
      const sha = (await read($, gitAtom))?.sha ?? null
      const before = await read($, taskAtom)
      const isNewTask = !(before !== null && before.milestones.length > 0 && before.status !== 'done')
      const pin = await read($, discoveryPinAtom)
      let guidance: string | null = null
      // Discovery is read from the full prompt (the stored one is clipped) and only ever goes up; guidance is said once per level.
      const discovered = (t: Task): Task => {
        if (t.milestones.length > 0 && t.discovery === undefined) return t
        const d = withDiscovery(t, pin, { prompt: e.text, files: t.files.map(f => f.path), milestones: t.milestones.length, grounds: [...new Set([...(t.promptGrounds ?? []), ...promptGroundsOf(e.text)])] })
        guidance = guidanceFor(d)

        return guidance === null ? d : markGuided(d)
      }
      // The baseline of a task is taken here, at the host's own boundary and before any work of this prompt; a task that goes on
      // keeps the one it has, so nothing the model does later can move it.
      const standing = await read($, taskAtom)
      const startReading = standing !== null && standing.status !== 'done' ? null : await measureTree($)
      treeWhy = startReading?.why ?? treeWhy
      const startStamp = startReading?.stamp ?? null
      // an unverified obligation (see owedAtom) goes on with the next task: that task is a coding task from its first moment
      const isOwed = (await read($, owedAtom)) !== null
      const task = await update($, taskAtom, old => {
        // An unfinished planned task goes on, and so does one the Stop guard holds, planned or not: a prompt is not a reset.
        // Only a person's `/cockpit reset` abandons a held task. Anything else is a new one.
        const isContinuing = old !== null && old.status !== 'done' && (old.milestones.length > 0 || isGuardHeld(old))
        // A mandatory review the person or the files raised before any plan is not waived by a later prompt: it goes on
        // with the unplanned task until Opus has answered it. Only a finished task, or an explicit `/cockpit reset`, starts clean.
        const owed = old !== null && !isContinuing && old.status !== 'done' && old.review !== undefined && old.review.state !== 'adjudicated'
        // Work an unfinished task already did is not forgotten by the next prompt: its baseline (unknown for a task saved before
        // baselines existed) and the fact that it edited go on with whatever follows it.
        const unfinished = old !== null && old.status !== 'done'
        const startTree = unfinished ? (old.startTree === undefined ? null : old.startTree) : startStamp
        // a repository seen at any measurement for this task stays seen (v0.6.4): it never becomes "outside Git" by going away
        const repoSeen = (unfinished && old.repoSeen === true) || startReading?.inRepo === true
        const base = isContinuing ? old : { ...newTask((old?.id ?? 0) + 1, e.text, now, sha), startTree, ...(repoSeen ? { repoSeen: true as const } : {}), ...((unfinished && (old.edited === true || old.files.length > 0)) || isOwed ? { edited: true as const } : {}), ...(owed ? { review: old.review, ...(old.promptGrounds === undefined ? {} : { promptGrounds: old.promptGrounds }) } : {}) }

        const prompted: Task = {
          ...base,
          lastPrompt: oneLine(e.text, 160),
          updatedAt: now,
          hasInstructionFileRequest: base.hasInstructionFileRequest,
        }
        if (!isSonnetLed()) return settle(discovered(prompted)).task
        // Grounds are read from the full prompt: the stored one is clipped.
        const promptGrounds = [...new Set([...(prompted.promptGrounds ?? []), ...promptGroundsOf(e.text)])]
        const withGrounds: Task = { ...prompted, promptGrounds }

        return settle(discovered(requireReview(withGrounds, mandatoryGrounds(factsOf(withGrounds, 0, promptGrounds)), promptOrigin(e.text)))).task
      })
      if (task !== null) await mutateLedger($, l => recordDiscovery(l, task, now))
      if (guidance !== null) added.push(guidance)
      if (task !== null && task.milestones.length > 0) added.push(`Cobalt Cockpit, state of the task in progress: ${summaryOf(task)}`)
      // The session router, when one is selected, is asked once at the start of
      // a task and never for a prompt inside one, a tool call or a helper.
      if (isNewTask) {
        const advice = await routeTask($, e.text, { prompt: e.text, files: [], milestones: 0, errorStreak: (await read($, orchestraAtom)).errorStreak, promptGrounds: task?.promptGrounds ?? [] }).catch(() => null)
        if (advice !== null) added.push(advice)
      }
    })

    // A prompt goes on either way: this hook adds what it observed to the
    // context, and a hook that fails would be skipped rather than drop one.
    if (added.length === 0) return next(e)

    return next({ ...e, context: [...(e.context ?? []), ...added] })
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
    const apiDrop = await apiRefusal($)
    if (apiDrop !== null) return { drop: apiDrop }

    return next(e)
  })

  on('command.run', { command: 'init' }, async ($, e, next) => {
    // /init is the person asking for a CLAUDE.md, when the person typed it: any other origin asks for nothing
    if (isHumanAuthority(e.origin)) await quiet(() => change($, task => ({ ...task, hasInstructionFileRequest: true })))

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
        // a turn that ended any way but an answer never reached the Stop guard: what it left is reconciled now, not at the next prompt
        if (e.reason !== 'answer') await hush(() => reconcileCompletion($))
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
    if (String(e.tool) === SWARM_TOOL_NAME) { const r = await serveSwarm($, call); await ledgerToolEnd($, call, r); await raiseAlerts($, false); return r }
    const gitPlan: GitPlan = {}
    const swarmRefusal = await guardSwarm($, call, gitPlan)
    if (swarmRefusal) { await ledgerToolEnd($, call, { deny: swarmRefusal }); return { deny: swarmRefusal } }
    if (e.tool === TOOL) { const r = await serveProgress($, call as ProgressInput & { agentId?: string }); await ledgerToolEnd($, call, r); await raiseAlerts($, false); return r }

    // A guard that fails refuses the call it guards (see `failClosed`) and nothing else. This catch is the last net: whatever
    // escapes the guards is still a refusal, never a pass.
    const refusal = await guard($, call).catch((error: unknown) => guardFailure('tool', String(e.tool), error))
    if (refusal !== null) { await ledgerToolEnd($, call, refusal); return refusal }

    if (config.hasOrchestration && e.agentId && e.tool === 'Bash' && (gitPlan.pin !== undefined || agentInspection(String(call['command'] ?? '')))) {
      // a scoped command's repository was verified when its paths were checked; a wildcard one's is verified here
      const root = gitPlan.root ?? await verifiedGitRoot($)
      if (root === null || 'why' in await gitInputs($, root) || !(await gitFiltersReliable($, root))) {
        const deny = GIT_IDENTITY_DENY
        await ledgerToolEnd($, call, { deny })
        return { deny }
      }
      // what runs is never the text the agent typed: every word is quoted again behind the safe flags
      (call as Record<string, unknown>)['command'] = rebuildGit(String(call['command']), gitPlan.pin)
    }
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
    // A task that is plainly under way with no plan is reminded once, beside the
    // edit that showed it (the host's own observation, not the model's word).
    if (e.agentId === undefined && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(e.tool) && 'result' in ran && ran.isError === undefined && ran.deny === undefined) {
      let note: string | null = null
      await quiet(() => update($, taskAtom, t => { const nudged = t === null ? null : progressNudge(t, TOOL); if (nudged === null) return t; note = nudged.note; return nudged.task }))
      if (note !== null) return { ...ran, context: [...(ran.context ?? []), note] }
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
    if (typeof e.permissionMode === 'string') seenPermissionMode = e.permissionMode
    // Refused before the engine resolves a model: a spawn that names Fable, an
    // agent type that does, or a fork of a parent that is on it.
    if (config.blocksFable && (isFable(e.model) || isFable(e.subagentType) || (e.fork && isFable(e.parentModel)))) {
      await recordBlock($)

      return { deny: BLOCK_DENY }
    }
    if (!isSupported) return next(e)
    const role = roleOf(e.subagentType)
    // The architect is Cobalt's own agent: the exact type AND a definition the host attributes to this plugin (`provider` is set by the host,
    // not by a plugin). A plugin of the same name from another source is not distinguishable by it; the human publication gate stays.
    if (role === 'ARCHITECT' && (typeof e.provider !== 'object' || e.provider === null || e.provider.plugin !== 'cobalt-cockpit')) return { deny: 'OPUS / the architect must be the agent provided by this plugin (cobalt-cockpit:architect); this definition is attributed elsewhere. Nothing was started.' }
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
          const state = await changeSwarm($, held => submitTask(held, { id: assignedId!, tier, role, objective: textOf(e.description || e.subagentType), mode: ['EXPLORER','RESEARCHER','REVIEWER','SCOUT','UTILITY','ARCHITECT'].includes(role) ? 'read' : 'write', owned:['*'], spawnReason:'Legacy Agent call; unknown scope conservatively exclusive' },at).swarm)
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
    const apiStep = await apiRefusal($)
    if (apiStep !== null) {
      const text = apiStep === API_REFUSAL ? 'AUTH / API DETECTED' : apiStep === AUTH_UNVERIFIED_REFUSAL ? 'AUTH / UNVERIFIED' : 'AUTH / STATE UNREADABLE'
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
    const signals = isMain ? await hostSignals($, e.turnId, e.model) : null
    const host = signals === null ? null : hostEffort(e.effort, signals)
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
    if (isGuardRow(e) && !isMenuChange(e)) return { deny: GUARD_ROW_REFUSED }
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
    if (isGuardRow(e) && !isMenuChange(e)) return { deny: GUARD_ROW_REFUSED }
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
        // Clearing the task also clears a held mandatory review, so it is the person's alone: a command another plugin ran,
        // a trigger, a peer or an origin this build does not know is refused, and nothing is changed.
        if (!isHumanAuthority(e.origin)) return { text: 'Cockpit: the task is cleared only by a command you type; nothing was changed.' }
        const abandoned = await read($, taskAtom)
        await hush(() => carryObligation($, abandoned, '/cockpit reset'))
        await update($, taskAtom, () => null)
        await hush(() => recordAbandoned($, abandoned, '/cockpit reset'))

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
      case 'discovery': {
        const pinned = value === '' ? undefined : value === 'auto' ? null : (['light', 'standard', 'deep'].includes(value) ? value.toUpperCase() as DiscoveryLevel : undefined)
        const isPerson = isHumanAuthority(e.origin)
        if (value !== '' && pinned === undefined) return { text: `Cockpit: "${value}" is not a level. Use /cockpit discovery light | standard | deep | auto.` }
        // Only the person pins a level; a command another plugin ran may look.
        if (pinned !== undefined && !isPerson) return { text: 'Cockpit: the discovery level is pinned only by a command you type; nothing was changed.' }
        if (pinned !== undefined) {
          await update($, discoveryPinAtom, () => pinned)
          await change($, task => pinned === null ? unpin(task) : withDiscovery(task, pinned))
        }
        const columns = (e as { presentation?: { columns?: number } }).presentation?.columns
        const task = await read($, taskAtom)
        const pin = await read($, discoveryPinAtom)

        return { text: [...discoveryRows(task, columns ?? 72), `PIN / ${pin ?? 'none (rules decide)'}${value === '' ? ' · /cockpit discovery light | standard | deep | auto (this session only; LIGHT also waives the goal check; gates and consultations are unchanged)' : ''}`].join('\n') }
      }
      case 'router': {
        const held = await read($, routerAtom)
        let target = value === '' ? null : routerModeOf(value)
        // Only the person switches a router: a command another plugin or a trigger ran may look, not choose.
        const isPerson = isHumanAuthority(e.origin)
        if (target !== null && target !== held.mode && !isPerson) return { text: `ROUTER / ${routerLine(held)}\nCockpit: the router is switched only by a command you type; nothing was changed.` }
        if (value !== '' && target === null) return { text: `Cockpit: "${value}" is not a router. Use /cockpit router off | nobodywho | jev.\nROUTER / ${routerLine(held)}` }
        // no word given: the engine's own dialog, where there is someone to ask
        if (target === null && isPerson) target = await pickRouter($, held.mode)
        if (target === null) return { text: `ROUTER / ${routerLine(held)}\nSwitch with /cockpit router off | nobodywho | jev. The choice lasts for this session; a new session starts OFF.` }
        if (target === held.mode) return { text: `ROUTER / ${routerLine(held)} (unchanged)` }

        return { text: await selectRouter($, target) }
      }
      case 'stats': {
        // read-only; it makes no model call and touches nothing but the local telemetry files
        const words = e.args.trim().toLowerCase().split(/\s+/).slice(1)
        const format = words.includes('--json') ? 'json' : words.includes('--csv') ? 'csv' : 'text'
        const win = parseWindow(words.find(w => !w.startsWith('--')) ?? '30d')
        const strays = words.filter(w => w.startsWith('--') && w !== '--json' && w !== '--csv')
        if (win === null || strays.length > 0 || (words.includes('--json') && words.includes('--csv'))) return { text: 'Cockpit: usage /cockpit stats 7d | 30d | all [--json | --csv]' }
        const stats = await readStats($, win)
        const note = stats.unreadableFiles > 0 ? `${stats.unreadableFiles} telemetry file${stats.unreadableFiles === 1 ? '' : 's'} could not be read; the figures are incomplete.` : ''
        if (format === 'json') return { text: statsJson(stats) }
        if (format === 'csv') return { text: statsCsv(stats) }

        return { text: [statsText(stats), note, healthLine()].filter(Boolean).join('\n') }
      }
      case 'agents': {
        // read-only: the swarm and the Ledger as recorded, explained; nothing is changed, admitted or cancelled from here
        const words = e.args.trim().split(/\s+/)
        const columns = (e as { presentation?: { columns?: number } }).presentation?.columns ?? 100
        const held = await read($, ledgerAtom)
        const at = await $.clock.now()
        const view = { swarm: swarmState(held), agents: held.agents, now: at, columns }
        if (words.length > 2) return { text: 'Usage: /cockpit agents | /cockpit agents <task>' }

        return { text: words[1] === undefined ? agentsText(view) : taskText(view, words[1]) }
      }
      case 'ready': {
        // read-only: which recorded conditions stand between the task and DONE; it approves and clears nothing
        const columns = (e as { presentation?: { columns?: number } }).presentation?.columns ?? 100
        const task = await read($, taskAtom)
        const held = await read($, ledgerAtom)

        return { text: readyText(task, swarmState(held), columns) }
      }
      case 'flow': {
        const task = await read($, taskAtom)
        const session = await read($, visualAtom)
        const input = await hudInput($, (await read($, activityAtom)).isWorking)

        return { text: flowText(flowOf(flowInputOf({ ...input, task }, session.agents, input.isWorking))) }
      }
      case 'guard': {
        const words = e.args.trim().toLowerCase().split(/\s+/)
        const arg = words[1] ?? ''
        if (arg === 'trust' || arg === 'untrust') {
          // enrolling a verifier is the person's alone: a plugin, a model-triggered command or an unknown origin changes nothing
          if (!isHumanAuthority(e.origin)) return { text: 'Cockpit: a verification script is trusted only by a command you type; nothing was changed.' }
          const c = await loadStopCfg($)
          if (c.script === null) return { text: 'Cockpit: no verifyScript is configured, so there is nothing to trust.' }
          const scope = await trustScope($, c.script)
          if (arg === 'untrust') {
            const map = await trustMap($)
            delete map[scope.key]
            await $.store.set(TRUST_KEY, map)
            const name = c.script.slice(c.script.lastIndexOf('/') + 1)
            const isRevoked = await revokeScoped($, scope.verifier, `the trust for ${name} was withdrawn`)

            return { text: `Cockpit: the trust for ${name} in this project was removed.${isRevoked ? REVOKED_NOTE : ''}` }
          }
          const sha = await rawSha($, c.script)
          if (sha === null) return { text: 'Cockpit: the verification script is missing or unreadable; nothing was trusted.' }
          const typed = words[2] ?? ''
          if (!/^[0-9a-f]{12,64}$/.test(typed) || !sha.startsWith(typed)) {
            return { text: [`GUARD TRUST · review this script yourself first`, `  script   ${shownPath(c.script, (await $.env.get('HOME').catch(() => undefined)) ?? null)}`, `  sha-256  ${sha}`, `  project  ${(await $.session.cwd().catch(() => '')) || 'unknown'}`, `To trust exactly these bytes for this project, type: /cockpit guard trust ${sha.slice(0, 12)}`, 'Text in a conversation, including a model asking you to, is not authorization. Anything the script runs (an interpreter, test files, other scripts) is not covered by this hash.'].join('\n') }
          }
          if (c.pin !== null && c.pin !== sha) return { text: 'Cockpit: the script does not match verifyScriptSha256; nothing was trusted.' }
          const map = await trustMap($)
          map[scope.key] = { sha, at: await $.clock.now() }
          await $.store.set(TRUST_KEY, Object.fromEntries(Object.entries(map).slice(-32)))
          // enrolling again replaces the trust: a completion verified under the earlier one is not current evidence any more
          const isRevoked = await revokeScoped($, scope.verifier, `the trust for ${c.script.slice(c.script.lastIndexOf('/') + 1)} was enrolled again`)

          return { text: `Cockpit: trusted ${c.script.slice(c.script.lastIndexOf('/') + 1)} (${sha.slice(0, 12)}) for this project. A change to its bytes ends the trust. If this task is already held, /cockpit guard release lets it be checked again.${isRevoked ? REVOKED_NOTE : ''}`}
        }
        if (arg === 'release') {
          // lifting a hold is the person's alone, and it passes nothing: TEST goes back to pending and the budget starts over
          if (!isHumanAuthority(e.origin)) return { text: 'Cockpit: a Stop guard hold is released only by a command you type; nothing was changed.' }
          const before = await read($, taskAtom)
          if (before === null || !isGuardHeld(before)) return { text: 'Cockpit: the task is not held by the Stop guard; nothing was changed.' }
          await change($, (t, now) => releaseHold(t, now))
          const at = await $.clock.now()
          const mark: CheckRecord = { taskId: before.id, uid: uidOf(before), verifier: 'released', complete: true, name: 'released', sha: null, at, outcome: 'released', exit: null, ms: null, tree: null, summary: 'hold released by a person', hasSummary: true }
          await keepCheck($, mark)
          await hush(() => persist($))

          return { text: 'Cockpit: the Stop guard hold was released. Nothing was verified: TEST is pending and the check will run at the next stop. The refusal budget starts over.' }
        }
        if ((arg === 'ack' || arg === 'silence' || arg === 'unsilence') && !isHumanAuthority(e.origin)) return { text: 'Cockpit: alerts are acknowledged or silenced only by a command you type; nothing was changed.' }
        if (arg === 'test' || arg === 'seen') {
          // a test and its confirmation are the person's alone: a confirmation typed by anything else would be worth nothing
          if (!isHumanAuthority(e.origin)) return { text: 'Cockpit: a notification test is sent or confirmed only by a command you type; nothing was sent or changed.' }
          if (arg === 'test' && words[2] !== undefined && words[2] !== 'sound') return { text: 'Usage: /cockpit guard test [sound]' }
          if (arg === 'seen' && words.length > 3) return { text: 'Usage: /cockpit guard seen [code]' }
          let said: string
          try { said = arg === 'test' ? await sendTest($, words[2] === 'sound' || guardCfg.sound) : await confirmSeen($, words[2] ?? '') } catch { said = arg === 'test' ? 'Cockpit: the test could not be completed and is not recorded as sent.' : 'Cockpit: the confirmation could not be recorded; nothing was changed.' }

          return { text: `${said}\n${(await transportText($)).join('\n')}` }
        }
        if (arg === 'ack' || arg === 'silence') {
          // the count first, then the records: a notice appended between the two is covered by one or the other
          await update($, guardAtom, old => ({ ...withAck(old, null), ...(arg === 'silence' ? { all: true } : {}) }))
          // the occurrences acknowledged are those the update itself marks, so a record appended meanwhile is not left without its key
          let pending: string[] = []
          await update($, ledgerAtom, old => { pending = pendingIdsOf(old.alerts ?? []); return { ...old, alerts: (old.alerts ?? []).map(a => (a.acked === true ? a : { ...a, acked: true as const })) } })
          // each occurrence acknowledged here is a key of its own as well, so another session reads it
          const project = (await read($, ledgerAtom)).alertsProject
          if (project !== undefined && pending.length > 0) await hush(() => recordAcks($, project, pending))
          await hush(() => persist($))
        } else if (arg === 'unsilence') await update($, guardAtom, old => (old.all ? { ...old, all: false } : old))
        else if (arg === '' && isRecording(guardCfg)) await hush(() => syncAcks($))
        else if (arg !== '') return { text: 'Usage: /cockpit guard | ack | silence | unsilence | test [sound] | seen [code] | trust [hash] | untrust | release' }
        // an acknowledgment or a silence ends the repeats now, not at the timer's next look
        if (arg !== '') await armReminders($)
        const view = await guardView($)

        const seenView = isRecording(guardCfg) ? await guardSeen($, view.kept) : undefined
        const status = guardText(guardCfg, view.state, view.kept, seenView)
        const transport = await transportText($)

        return { text: `${status}\n${transport.join('\n')}${arg === 'ack' || arg === 'silence' || arg === 'unsilence' ? '\nThe verification verdict was not changed.' : ''}` }
      }
      case 'alerts': {
        const words = e.args.trim().toLowerCase().split(/\s+/)
        const arg = words[1] ?? ''
        const columns = (e as { presentation?: { columns?: number } }).presentation?.columns ?? 100
        if (arg === 'ack') {
          // an acknowledgment is the person's alone: nothing a plugin, a model or an unknown origin sends can make one
          if (!isHumanAuthority(e.origin)) return { text: 'Cockpit: alerts are acknowledged only by a command you type; nothing was changed.' }
          if (words.length !== 3) return { text: 'Usage: /cockpit alerts ack <id>  (the 8-character id listed by /cockpit alerts). Nothing was changed.' }
          const id = words[2] as string
          const before = (await read($, ledgerAtom)).alerts ?? []
          const { open, observation } = await observeAlerts($, before)
          const result = ackOccurrence(before, open, id)
          if (result.result === 'malformed') return { text: 'Cockpit: an alert id is 8 characters, 0-9 and a-f, as /cockpit alerts lists it. Nothing was changed.' }
          if (result.result === 'unknown') {
            // an acknowledgment key can outlive the record it was made for: say so rather than call the id unknown
            const project = (await read($, ledgerAtom)).alertsProject
            if (project !== undefined && (await storedAcks($, project)).has(id)) return { text: `Cockpit: alert ${id} was acknowledged earlier; its record has expired from the bounded history. Nothing was changed.` }

            return { text: 'Cockpit: no recorded alert has that id. It may be mistyped, or it may have expired from the bounded history. Nothing was changed.' }
          }
          const o = result.occurrence
          const named = o === undefined ? id : `${id} (${o.level} ${o.kind}, task ${o.taskId})`
          if (result.result === 'already') return { text: `Cockpit: alert ${named} was already acknowledged. Nothing was changed.` }
          // the count first, then the records: a notice appended between the two is covered by one or the other
          const key = episodesKey(before, id)
          if (key !== null) await update($, guardAtom, old => withAck(old, key))
          await update($, ledgerAtom, old => ({ ...old, alerts: ackOccurrence(old.alerts ?? [], open, id).alerts }))
          // the acknowledgment as a key of its own: one atomic set that no other session's write can undo
          const project = (await read($, ledgerAtom)).alertsProject
          const shared = project === undefined ? false : await recordAcks($, project, [id])
          await hush(() => persist($))
          // its reminders end now, not at the timer's next look
          await armReminders($)
          const standing = o === undefined ? 'UNKNOWN' : standingOf(o, observation)
          const where = shared ? ' It is recorded for this project, so another session reads it too.' : ' It could not be recorded for the project: it holds in this session only.'

          return { text: `Cockpit: alert ${named} was acknowledged${standing === 'OPEN' ? '; its condition is still open, and no more reminders will be sent for it' : standing === 'UNKNOWN' ? '; its condition cannot be observed from this session, so it is not known whether it still holds, and this only marks the record' : '; its condition no longer holds, so this only marks the record'}.${where} Other alerts, gates, reviews, approvals and the verification verdict were not changed.` }
        }
        if (arg === 'export') {
          // printed for the person who typed it, never written or sent anywhere; acknowledgments in the store are applied in memory only
          if (!isHumanAuthority(e.origin)) return { text: 'Cockpit: the alert export is printed only for a command you type; nothing was printed.' }
          if (words.length > 2) return { text: 'Usage: /cockpit alerts export' }
          const ledgerNow = await read($, ledgerAtom)
          const kept = ledgerNow.alerts ?? []
          const project = ledgerNow.alertsProject ?? null
          const acked = project === null ? new Set<string>() : await storedAcks($, project)
          const records = applyAcks(kept, acked)
          const { open: openNow, observation } = await observeAlerts($, records)
          const at = await $.clock.now()

          return { text: exportOf(occurrencesOf(records, openNow), project, at, observation) }
        }
        if (arg === 'legacy') {
          const keys = await $.store.keys().catch(() => [] as string[])
          const names = keys.filter(k => k === LEGACY_HISTORY_KEY || k.startsWith(`${LEGACY_HISTORY_KEY}:`))
          const values: { key: string; value: unknown }[] = []
          for (const key of names) {
            const value = await $.store.get(key).catch(() => undefined)
            values.push({ key, value })
          }
          // an occurrence counts as migrated only when its own key holds it in full: the values are read, not only the names
          const occ = new Map<string, unknown>()
          for (const key of keys.filter(k => k.startsWith('alert-occ:'))) {
            const value = await $.store.get(key).catch(() => undefined)
            occ.set(key, value)
          }
          const plan = legacyPlanOf(values, keys, occ)
          if (words[2] === undefined) return { text: legacyPlanText(plan) }
          if (words[2] !== 'delete' || words.length !== 4) return { text: 'Usage: /cockpit alerts legacy (a dry run) | /cockpit alerts legacy delete <code from the dry run>' }
          // deleting is the person's alone, and only what the plan the person read calls safe
          if (!isHumanAuthority(e.origin)) return { text: 'Cockpit: legacy alert history is deleted only by a command you type; nothing was changed.' }
          if (words[3] !== plan.token) return { text: 'Cockpit: that code does not match the store as it is now (it changed since the dry run, or the code was mistyped). Nothing was deleted. Run /cockpit alerts legacy again.' }
          if (plan.deletable.length === 0) return { text: 'Cockpit: nothing can be deleted safely. Nothing was changed.' }
          const removed: string[] = []
          for (const key of plan.deletable) {
            // read again just before the delete: the key itself, and every occurrence key it depends on, must be as the plan saw them
            const now = await $.store.get(key).catch(() => undefined)
            const was = values.find(v => v.key === key)?.value
            if (JSON.stringify(now) !== JSON.stringify(was)) continue
            const occNow = new Map<string, unknown>()
            for (const k of [...occ.keys()]) {
              const value = await $.store.get(k).catch(() => undefined)
              occNow.set(k, value)
            }
            const keysNow = await $.store.keys().catch(() => [] as string[])
            const again = legacyPlanOf(values.filter(v => v.key === key), keysNow, occNow)
            if (!again.deletable.includes(key)) continue
            try {
              await $.store.delete(key)
              removed.push(key)
            } catch { /* left in place: reported below */ }
          }
          const left = plan.deletable.filter(k => !removed.includes(k))

          return { text: `Cockpit: deleted ${removed.length === 0 ? 'nothing' : removed.join(', ')}; every occurrence they held was already held in full by a key of its own.${left.length > 0 ? ` Could not delete: ${left.join(', ')}.` : ''}${plan.kept.length > 0 ? ` Kept: ${plan.kept.join(', ')}.` : ''} No alert record, acknowledgment, gate or verdict was changed.` }
        }
        if (arg === 'label') {
          // a label is the person's judgment alone: nothing a plugin, a model, an SDK turn or an unknown origin sends can set, change or remove one
          if (!isHumanAuthority(e.origin)) return { text: 'Cockpit: an alert is labelled only by a command you type; nothing was changed.' }
          const label = labelOfWord(words[3])
          if (words.length !== 4 || label === null) return { text: `${LABEL_USAGE}. Nothing was changed.` }
          const id = words[2] as string
          if (!ID_RE.test(id)) return { text: 'Cockpit: an alert id is 8 characters, 0-9 and a-f, as /cockpit alerts review lists it. Nothing was changed.' }
          const view = await calibrationView($)
          const item = view.items.find(x => x.occurrence.id === id)
          // an id no record has, or one that expired from the bounded history: refused before anything is written
          if (item === undefined) return { text: 'Cockpit: no recorded alert has that id. It may be mistyped, or it may have expired from the bounded history. Nothing was changed.' }
          const o = item.occurrence
          const named = `${id} (${o.level} ${o.kind}, task ${o.taskId})`
          const key = labelKeyOf(view.project, id)
          const own = new Set(view.items.map(x => x.occurrence.id))
          const untouched = ' Nothing was acknowledged, resolved or sent, and no setting, gate, review, approval or verdict was changed.'
          if (label === 'clear') {
            if (!item.hasKey) return { text: `Cockpit: alert ${named} has no label. Nothing was changed.` }
            try { await $.store.delete(key) } catch { return { text: `Cockpit: the label of alert ${named} could not be removed. Nothing was changed.` } }
            await hush(() => sweepLabels($, view.project, own))

            return { text: `Cockpit: the label of alert ${named} was removed${item.label === null ? '' : ` (it was ${item.label})`}; it is unreviewed again.${untouched}` }
          }
          if (item.label === label) return { text: `Cockpit: alert ${named} is already labelled ${label}. Nothing was changed.` }
          // the label as a key of its own, written whole: one atomic set that no other session's write of another key can undo
          try { await $.store.set(key, labelValueOf(label, await $.clock.now())) } catch { return { text: `Cockpit: the label of alert ${named} could not be recorded. Nothing was changed.` } }
          await hush(() => sweepLabels($, view.project, own))

          return { text: `Cockpit: alert ${named} is labelled ${label}: ${LABEL_MEANING[label]}.${item.label === null ? '' : ` It was ${item.label}.`} It is recorded for this project, so another session reads it too.${untouched}` }
        }
        if (arg === 'review') {
          const page = words[2] === undefined ? 1 : /^\d{1,3}$/.test(words[2]) ? Number(words[2]) : -1
          if (page < 1 || words.length > 3) return { text: 'Usage: /cockpit alerts review [page]' }
          // read-only: no look marker is written, nothing is acknowledged, and another session's acknowledgments are applied in memory only
          const view = await calibrationView($)

          return { text: reviewText(view.items, page, await $.clock.now(), view.observation) }
        }
        if (arg === 'calibration') {
          if (words.length > 2) return { text: 'Usage: /cockpit alerts calibration' }
          const view = await calibrationView($)
          // the policy is simulated on a frozen copy of the options with notifications on: the configuration is read, never written, and nothing is sent
          const simulated = simulationConfigOf(stopOptions)

          return { text: calibrationText(calibrationOf(view.items, simulated), simulated, { enabled: guardCfg.enabled, recording: guardCfg.recordOnly }) }
        }
        await hush(() => syncAcks($))
        if (arg === 'digest') {
          if (words.length > 2) return { text: 'Usage: /cockpit alerts digest' }
          const ledgerNow = await read($, ledgerAtom)
          const recorded = ledgerNow.alerts ?? []
          // read-only: the look marker is read to say what is new and is never written here
          const seen = await readSeen($, ledgerNow.alertsProject)

          const { open: openNow, observation } = await observeAlerts($, recorded)
          const at = await $.clock.now()

          return { text: digestText(occurrencesOf(recorded, openNow), at, guardCfg.enabled, { seen, recording: guardCfg.recordOnly, columns, observation }) }
        }
        const page = arg === '' ? 1 : /^\d{1,3}$/.test(arg) ? Number(arg) : -1
        if (page < 1 || words.length > 2) return { text: 'Usage: /cockpit alerts [page] | digest | ack <id> | review [page] | label <id> notify|record|noise|clear | calibration | export | legacy [delete <code>]' }
        const ledgerNow = await read($, ledgerAtom)
        const kept = ledgerNow.alerts ?? []
        const { open: openNow, observation } = await observeAlerts($, kept)
        const occ = occurrencesOf(kept, openNow)
        const shownPage = Math.min(page, inboxPages(occ.length))
        const seen = await readSeen($, ledgerNow.alertsProject)
        const text = inboxText(occ, shownPage, await $.clock.now(), guardCfg.enabled, { seen, recording: guardCfg.recordOnly, columns, observation })
        // a person's look marks what it showed; the count above was taken first. Nothing is acknowledged by looking.
        // with both settings off nothing new is kept, the look marker included
        if (isRecording(guardCfg) && isHumanAuthority(e.origin) && ledgerNow.alertsProject !== undefined && occ.length > 0) await hush(() => markSeen($, ledgerNow.alertsProject as string, seen ?? null, pageIdsOf(occ, shownPage, observation)))

        return { text }
      }
      case 'doctor':
        const facts = await doctorFacts($)

        return { text: doctorText(facts) }
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
        // the path is the point of this line, so it stays whole but for a personal directory's name
        const sourceHome = (await $.env.get('HOME').catch(() => undefined)) ?? null
        const meter = await read($, meterAtom)
        // What AUTO would name for the commander is advice only, and only when
        // no selection of the person's was seen: the level stays the host's.
        const advised = config.hasOrchestration && config.reasoningMode === 'AUTO' && meter.hostSource === 'host'
          ? chooseEffort('AUTO', { tier: isSonnetLed() ? 'SONNET' : 'OPUS' }, capabilityOf(isSonnetLed() ? AGENT_MODEL : MAIN_MODEL, Object.fromEntries(observed)), config.maxEffort).applied
          : undefined

        return {
          text: [
            `PLUGIN / ${$.plugin.name} ${version}`,
            `SOURCE / ${shownPath($.plugin.root, sourceHome)}`,
            `SESSION MODEL / ${model === '' ? UNKNOWN : model}`,
            ...(config.hasOrchestration ? [`PROFILE / ${config.profile}${isSonnetLed() ? ` · main ${AGENT_MODEL} · Opus on admission · budget ${config.maxSubagents} (Sonnet ${String(config.maxSonnet)} · Haiku ${String(config.maxHaiku)} · Opus 1)` : ` · main ${MAIN_MODEL}`}`] : []),
            `ROUTER / ${routerLine(await read($, routerAtom))}`,
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
    // The Neural Flow takes one row, paid for out of the strips' rows like the orchestration line; it is not drawn when the band is short.
    const flowInput = flowInputOf(input, session.agents, e.props.isWorking)
    const flowWidth = e.props.bodyColumns
    const flowWanted = config.hasFlow && input.task !== null && e.props.maxRows >= 4 && flowLayout(flowWidth) !== null
    // The swarm's recorded state, from the Ledger this render reads anyway: no timer, no poll, no new subscription. One
    // static line, only while a task is blocked, quiet or escalated, paid for out of the strips' rows like the crew line.
    const runLedger = await read($, ledgerAtom)
    const stripBudget = Math.max(0, e.props.maxRows - 1 - (layout.columns >= 44 ? 1 : 0) - (flowWanted ? 1 : 0))
    // only under enforced orchestration (an earlier session's Ledger says nothing of this one's swarm), and only where a
    // strip row exists to give up: the band is never taller for it
    const swarmNote = config.hasOrchestration && stripBudget >= 1 ? swarmHint(swarmState(runLedger), layout.columns) : null
    const room = swarmNote === null ? stripBudget : stripBudget - 1
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
    const flowDraw = { now, motion, light: isLight }
    const flowCellsNow = flowWanted ? flowGrid(flowOf(flowInput), flowWidth, flowDraw)?.encode() ?? null : null
    const flowTextRow = flowWanted ? flowRow(flowOf(flowInput), flowWidth, flowDraw) : null
    const flowEl = flowCellsNow !== null && e.surface === 'terminal' && Raster
      ? <Raster key={FLOW_KEY} columns={flowWidth} rows={1} cells={flowCellsNow} />
      : flowTextRow === null ? null : <Text key="flow-text" wrap="truncate-end">{flowTextRow.map((segment, n) => <Text key={`flow-${n}`} {...styleOf(segment)}>{segment.text}</Text>)}</Text>
    // NobodyWho, only while a real receipt is fresh. An empty list draws no row,
    // so a session with no receipts looks exactly as it always did.
    const flashRows = stripRows(await read($, flashAtom), now, layout.columns, reducedMotion)
    // The initialization line, shown only while it is genuinely still running.
    // Claude's own mascot is left untouched above it: there is no supported way
    // to replace it, and none is attempted here.
    const startup = startupOf(await read($, startupAtom), false)
    const resumed = await resumeLine($)
    const modelWarning = runLedger.warnings.at(-1) ?? null
    const guardNow = await guardView($)
    // The alert row: pinned while a raised condition is open and unacknowledged, or the transport is unconfirmed; the
    // plain state otherwise. One row either way, never animated, and apart from the verification and progress rows.
    const pinned = await guardPin($, guardNow, layout.columns)
    // alerts on: the pin, or the plain state; record-only: the pin or the count, and no row at all when there is nothing to show
    const guardText1 = guardCfg.enabled ? pinned?.text ?? `GUARD: ${guardLabel(guardCfg, guardNow.state, guardNow.kept)}` : guardCfg.recordOnly ? pinned?.text ?? null : null
    const guardLine = guardText1 === null ? null : pinned === null || pinned.level === 'INFO'
      ? <Text key="guard" dimColor wrap="truncate-end">{guardText1}</Text>
      : <Text key="guard" color={pinned.level === 'CRITICAL' ? COLORS.bad : COLORS.warn} bold={pinned.level !== 'NORMAL'} wrap="truncate-end">{guardText1}</Text>
    const swarmLine = swarmNote === null ? null : <Text key="swarm-hint" color={COLORS.warn} wrap="truncate-end">{swarmNote}</Text>
    const startupRows: Row[] = startup.active && layout.columns >= 44 ? [[{ text: startup.line, color: COLORS.steel, isBold: true }]] : []
    let rail: RenderElement
    if (e.surface === 'terminal' && Raster) {
      const lastCells = new Map([[TRACK_KEY, cells]])
      // The field's own Raster is blitted from the same loop, so the crawler
      // keeps walking the tape between full redraws.
      if (field !== null) lastCells.set(FIELD_KEY, fieldCells)
      if (flowCellsNow !== null) lastCells.set(FLOW_KEY, flowCellsNow)
      band = { requestId: e.requestId, width: trackWidth, input, visual: v, agents: agents.shown, glide, motion, lastCells, waiting, field: field === null ? null : { tape, state: crawler.crawler.state, rows: Math.min(2, fieldRowsWanted), width: fieldColumns, graph }, flow: flowCellsNow === null ? null : { input: flowInput, width: flowWidth } }
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
          {flowEl}
          {guardLine}
          {swarmLine}
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
        {flowEl}
        {guardLine}
        {swarmLine}
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
    const paneRouter = await read($, routerAtom)
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
      // the session router is named whenever one is selected, and in SONNET_LED also when it is OFF
      ...(paneRouter.mode !== 'OFF' || isSonnetLed() ? { router: routerLine(paneRouter) } : {}),
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
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refreshAll($)} />
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
