// Cobalt Cockpit's state contract: every value the plugin keeps in `$.state`.
// Session state lives here so a hot reload of the hooks module loses nothing.

/**
 * The work phases a task moves through, plus the two terminal displays.
 */
export type WorkPhase = 'RESEARCH' | 'PLAN' | 'IMPLEMENT' | 'TEST' | 'FIX' | 'VERIFY'
export type Phase = WorkPhase | 'BLOCKED' | 'DONE'

/**
 * What one real observation was, reduced to the vocabulary the Activity Field
 * draws. A closed set: an observation that maps to none of these is not
 * meaningful activity and simply produces no event, so the tape never fills
 * with noise the user did not cause.
 */
export type EventKind =
  | 'READ'
  | 'EDIT'
  | 'WRITE'
  | 'BASH'
  | 'TEST'
  | 'BUILD'
  | 'GIT'
  | 'WEB'
  | 'AGENT'
  | 'PLAN'
  | 'VERIFY'
  | 'NWHO'
  | 'FAULT'

/**
 * `running` while the call is genuinely in flight, `done` when it returned,
 * `failed` when it really errored. Nothing else sets `failed`, so the crawler
 * can never show a break that did not happen.
 */
export type EventState = 'running' | 'waiting' | 'done' | 'failed'

/**
 * One normalized observation, safe to draw.
 *
 * What is deliberately NOT here, and cannot be reconstructed from it: the
 * command a Bash call ran, the contents of a file, the text of a prompt, a
 * subagent's description, or any reasoning. `detail` is a basename, a hostname,
 * a gate name or a count, and `safeDetail` is the only thing that fills it.
 */
export type ActivityEvent = {
  /** Stable across a call's start and end, so the row can be updated in place. */
  id: string
  kind: EventKind
  /** The safe word drawn as the event's verb, e.g. `READ`. */
  label: string
  /** A safe short target, or the empty string when there is nothing safe to say. */
  detail: string
  state: EventState
  startedAt: number
  endedAt: number | null
}

/** The bounded recent window the Activity Field draws from. */
export type ActivityLog = {
  events: ActivityEvent[]
}

export type GateName = 'CODE' | 'TEST' | 'TYPE' | 'BUILD' | 'SECURITY' | 'GIT'

/**
 * `unset`: nothing known. `pending`: a check ran but its result is not known
 * (masked exit status, a background run). `na`: explicitly not applicable.
 */
export type GateState = 'unset' | 'pending' | 'pass' | 'fail' | 'na'

export type Gate = {
  state: GateState
  /** A required gate must be `pass` or `na` before the task may read 100%. */
  isRequired: boolean
  /** One line saying what established the state. */
  evidence: string | null
  /** `auto`: read off a real command's result; `model`: reported by Claude. */
  source: 'auto' | 'model' | null
  at: number | null
}

export type MilestoneState = 'pending' | 'active' | 'done' | 'failed' | 'blocked'

export type Milestone = {
  id: string
  title: string
  phase: WorkPhase
  state: MilestoneState
  note: string | null
}

/**
 * `idle`: no milestones were defined, so there is no progress to show.
 * `unverified`: the work is finished but a required gate is not satisfied.
 */
export type TaskStatus = 'idle' | 'active' | 'unverified' | 'blocked' | 'done'

export type TaskKind = 'unplanned' | 'coding' | 'readonly'

export type TouchedFile = { path: string; added: number; removed: number }

export type Stamped = { at: number; text: string }

export type Task = {
  id: number
  /** Goes up when progress fell far enough to re-arm the sound cues. */
  lifecycle: number
  goal: string
  /** The person's latest prompt in this task: the goal of a plan that names none. */
  lastPrompt: string
  kind: TaskKind
  startedAt: number
  updatedAt: number
  /** HEAD when the task began; null outside a repository. */
  startSha: string | null
  milestones: Milestone[]
  gates: Record<GateName, Gate>
  /** Derived from milestones and gates, never from time or tool counts. */
  percent: number
  phase: Phase
  status: TaskStatus
  blocker: string | null
  hasCue80Fired: boolean
  hasCue100Fired: boolean
  /** The user named CLAUDE.md or AGENTS.md in this task's prompts. */
  hasInstructionFileRequest: boolean
  files: TouchedFile[]
  failures: Stamped[]
  lastAction: Stamped | null
  /**
   * An Opus consultation this task cannot finish without (SONNET_LED only):
   * absent when none is required. Holds the task below 100% until the
   * consultation has returned and the main session has adjudicated it.
   */
  review?: ReviewRequirement
  /** Consultation grounds the person's full prompts raised in this task (SONNET_LED). */
  promptGrounds?: ConsultGround[]
  /** Set once the main loop was reminded that this edited task has no progress plan. */
  progressNudged?: boolean
  /** v0.5.1: set once any edit was seen in this task, by the main session or a helper; survives a plan restart. */
  edited?: true
  /** v0.5.1: how much discovery this task warrants and what it found. Absent on tasks stored by older versions. */
  discovery?: Discovery
  /** v0.5.1: the original-goal check; required for a coding task above LIGHT before it can read DONE. */
  alignment?: Alignment
  /** v0.5.1: consequential decisions the model reported, bounded and redacted. */
  decisions?: DecisionRecord[]
}

export type DiscoveryLevel = 'LIGHT' | 'STANDARD' | 'DEEP'
export type UnknownItem = { id: string; text: string; state: 'open' | 'resolved' | 'assumed'; note: string | null }
export type Discovery = {
  level: DiscoveryLevel
  /** `operator` when the person pinned it with /cockpit discovery. */
  source: 'auto' | 'operator'
  /** Why this level, as short codes (never prompt text). */
  reasons: string[]
  objective: string | null
  criteria: Criterion[]
  unknowns: UnknownItem[]
  /** Risk categories the model named as relevant; never a fixed checklist. */
  risks: string[]
  /** The level the rules had reached when the operator pinned one: `auto` gives it back no lower than this. */
  floor?: DiscoveryLevel
  /** The level the prompt-time guidance was last given for: guidance is never repeated for it. */
  guided: DiscoveryLevel | null
}
/** One acceptance criterion: its own id, description, state and the evidence the model reported for it. */
export type CriterionStatus = 'pending' | 'met' | 'failed' | 'unresolved'
export type Criterion = { id: string; text: string; status?: CriterionStatus; evidence?: string | null; /** Evidence is what the model reported; Cockpit checks its form and completeness, never its truth. */ basis?: 'reported' }
export type AlignmentState = 'PENDING' | 'ALIGNED' | 'PARTIAL' | 'BLOCKED' | 'UNKNOWN'
export type Alignment = {
  state: AlignmentState
  demonstrated: { id: string; evidence: string; status?: CriterionStatus }[]
  missing: string[]
  assumptions: string[]
  note: string | null
  at: number
}
export type DecisionStatus = 'provisional' | 'verified' | 'revised'
export type DecisionRecord = {
  id: string
  taskId: number
  problem: string
  chosen: string
  alternatives: { option: string; rejectedBecause: string }[]
  tradeoffs: string | null
  evidence: string[]
  status: DecisionStatus
  at: number
}
/** What the Run Ledger keeps of a task's discovery: the level and why, no prompt text. */
export type DiscoveryEntry = { taskId: number; level: DiscoveryLevel; source: 'auto' | 'operator'; reasons: string[]; unknownsOpen: number; alignment: AlignmentState | 'NONE'; criteriaTotal?: number; criteriaMet?: number; at: number }

/** Which model leads the main loop when orchestration is enforced. */
export type Profile = 'OPUS_LED' | 'SONNET_LED'

/** Why an Opus consultation may be admitted. */
export type ConsultGround = 'architecture' | 'security' | 'repeated-failure' | 'asked' | 'release'

/** What Opus is given instead of the conversation: bounded, specific, decision-shaped. */
export type EvidencePacket = {
  objective: string
  architecture: string
  files: string[]
  alternatives: string[]
  failures: string[]
  risk: string
  decision: string
}

/**
 * One Opus consultation. Its lifecycle (running, returned, failed) and the main
 * session's verification are read off the swarm task it ran as; this record
 * holds why it was admitted and what it was asked.
 */
export type Consultation = {
  id: string
  ground: ConsultGround
  /** Hash of the problem as stated: an unchanged problem is not consulted twice. */
  key: string
  packet: EvidencePacket
  /** The progress task it belongs to, or null outside one. */
  progressTask: number | null
  /** Whether the ground made this consultation mandatory for the task. */
  isMandatory: boolean
  requestedAt: number
}

export type ReviewRequirement = {
  grounds: ConsultGround[]
  /** The consultation that answers it, once admitted. */
  consult: string | null
  /** required → admitted → returned → adjudicated (main session verified the advice, pass or fail). */
  state: 'required' | 'admitted' | 'returned' | 'adjudicated'
}

export type ActivityKind =
  | 'IDLE'
  | 'THINK'
  | 'READ'
  | 'EDIT'
  | 'BASH'
  | 'TEST'
  | 'BUILD'
  | 'TYPE'
  | 'LINT'
  | 'AUDIT'
  | 'WEB'
  | 'GIT'
  | 'AGENT'
  | 'PLAN'
  | 'TOOL'

export type Activity = {
  kind: ActivityKind
  detail: string
  /** The main loop's turn is running. */
  isWorking: boolean
  /** The call that set `kind`, so its end can clear it. */
  toolUseId: string | null
  /** Subagents seen working, by id: counted apart from the main task. */
  agents: string[]
  at: number
}

export type GitState = {
  isRepo: boolean
  project: string
  branch: string | null
  isDetached: boolean
  sha: string | null
  /** HEAD when the session first read the repository. */
  startSha: string | null
  dirty: number
  /** Null when the branch has no upstream. */
  ahead: number | null
  behind: number | null
  at: number
}

export type Meter = {
  percent: number | null
  tokens: number | null
  window: number | null
  model: string | null
  effort: string | null
  /** AUTO or MANUAL: whether the level was chosen from the task or named. */
  reasoningMode?: ReasoningMode | null
  /** Where the displayed effort came from, when it is known. */
  effortSource?: EffortSource | null
  /** The level the task asked for before any capability fallback. */
  requestedEffort?: string | null
  /** One line on why this level was chosen. */
  effortReason?: string | null
  /** The main loop's level is the host's own: where it was seen to come from. */
  hostSource?: HostEffortSource | null
}

export type GuardFinding = { rule: string; title: string; effect: string }

/** A destructive command waiting on the person's answer. */
export type GuardRequest = {
  question: string
  command: string
  findings: GuardFinding[]
  isSubagent: boolean
  at: number
}

/** Preferences that outlive the session, mirrored from `$.store`. */
/**
 * What a subagent was started as, read off the agent type the engine spawned:
 * the four Cockpit roles, or `AGENT` for any other type.
 */
export type AgentRole = 'WORKER' | 'EXPLORER' | 'RESEARCHER' | 'REVIEWER' | 'SCOUT' | 'UTILITY' | 'AGENT' | (string & {})

/**
 * One subagent's row. `role`, `seq` and `kind` are set from the spawn and the
 * agent's own tool calls; a strip held from before they existed has none and
 * is drawn the way it always was.
 */
export type AgentStrip = { parentRun?: string; originTurn?: string; toolCount?: number; id: string; title: string; model: string | null; effort: string | null; tool: string; state: 'running' | 'waiting' | 'error' | 'done'; startedAt: number; endedAt: number | null; role?: AgentRole; seq?: number; kind?: ActivityKind }
export type VisualSession = { waiting: number; agents: AgentStrip[]; revision: number }

export type Prefs = { isMuted: boolean; isHudHidden: boolean }

/**
 * The optional NobodyWho telemetry this session has actually observed.
 *
 * Both fields stay null until a real receipt for this session's own work
 * arrives. A prune never fills `lastDecision`, because a prune decided
 * nothing: the decision path is a separate receipt and is reported only when
 * the router genuinely writes one.
 */
export type LocalControl = {
  lastDecision: NwhoEvent | null
  lastPrune: NwhoEvent | null
  history: { at: number; op: NwhoOp; text: string }[]
  lastAt: number
}

/** One receipt, reduced to the enumerated and numeric fields the HUD may show. */
export type NwhoEvent = {
  abstention?: boolean
  fallbackTier?: NwhoTier | null
  op: NwhoOp
  tier: 'P0' | '0.6B' | 'Q4B' | '9B'
  latencyMs: number
  at: number
  requestId: string
  route: string | null
  proposed: number | null
  accepted: number | null
  rejected: number | null
}

export type NwhoOp = 'decision' | 'prune'

/** The compact tier names. JEV is deliberately absent: it is disabled. */
export type NwhoTier = 'P0' | '0.6B' | 'Q4B' | '9B'

/** The transient flash of a fresh receipt, held briefly and then gone. */
export type NwhoFlash = { text: string; op: NwhoOp; at: number }

/**
 * The model policy's own count: refusals made, and responses Fable actually
 * answered. The second is read off real responses, so with the block in place
 * it stays 0 because nothing got through, not because nothing was counted.
 */
export type PolicyState = { blocks: number; calls: number; lastBlockAt: number | null }

/** The kind of credential the engine holds for the session, as it reports it. */
export type Credential = 'bearer' | 'api-key' | 'none' | 'unknown'

export type AuthMode = 'subscription' | 'api' | 'unverified'

/**
 * How the session is authenticated. `sources` holds names of API-style
 * configuration that is present (a variable's name, a settings key), never a
 * value.
 */
export type AuthState = { mode: AuthMode; credential: Credential; sources: string[]; at: number }

/**
 * What delegation has come to this session: how many subagents were started,
 * the failure the main loop keeps hitting, and whether a reviewer is owed.
 */
export type Orchestra = {
  /** Subagents started this session: the number the next strip carries. */
  spawned: number
  /** What the main loop's latest failure was of, or null after a success. */
  errorKey: string | null
  /** How many times in a row that same thing has failed. */
  errorStreak: number
  streakAt: number | null
  /** One reviewer is admitted for the current streak. */
  reviewArmed: boolean
  /** The model was told once that the failure is repeating. */
  hinted: boolean
  /** The task whose final review was already admitted. */
  reviewedTask: number | null
  reviewers: number
  refusedLimit: number
  refusedReview: number
}

declare module 'claude-code' {
  interface PluginState {
    'cobalt-cockpit': {
      task: Task | null
      activity: Activity
      git: GitState | null
      meter: Meter
      guards: GuardRequest[]
      visual: VisualSession
      prefs: Prefs
      control: LocalControl
      flash: NwhoFlash | null
      startup: string[]
      events: ActivityLog
      policy: PolicyState
      auth: AuthState | null
      orchestra: Orchestra
      'run-ledger': Ledger
      'replay-position': number
      'ledger-resume': boolean
      'control-cursor': Cursor | null
      'effort-known': Record<string, readonly EffortLevel[]>
      /** The session's router and what it has done; never stored beyond the session. */
      router: RouterState
    }
  }
}

export type ModelTier = 'OPUS' | 'SONNET' | 'HAIKU'

/**
 * How hard a request asks a model to think, in the engine's own order. `xhigh`
 * sits between `high` and `max`. Every level is not supported by every model,
 * account or CLI version, so a level is only ever *requested*; what the engine
 * actually applied is recorded separately (and may be a silent downgrade).
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** A level the commander names, or `AUTO` to let the policy choose from the task. */
export type EffortRequest = EffortLevel | 'AUTO'
/** Where an effort value came from: chosen from the task, named by hand, the engine's own report, or a capability fallback. */
export type EffortSource = 'auto' | 'manual' | 'request' | 'engine' | 'fallback' | 'unknown'
/**
 * Who put the effort on a loop's last request: `host` when it went with the
 * level the engine resolved itself (so the engine's own report describes it),
 * `hook` when this plugin rewrote it in `turn.step` (which the engine's report
 * does not reflect).
 */
export type EffortVia = 'host' | 'hook'
/**
 * Where the main loop's level was seen to come from: the environment variable,
 * a `/effort` of this session, the settings, or `host` when the engine resolved
 * it from something a plugin cannot see (a model default, `--effort`, a picker).
 */
export type HostEffortSource = 'env' | 'session' | 'settings' | 'host'
/** Whether the reasoning mode chooses effort from the task or honours a fixed setting. */
export type ReasoningMode = 'AUTO' | 'MANUAL'
/** One effort step upward within a tier: recorded so history can explain it. */
export type EffortEscalation = { from: EffortLevel; to: EffortLevel; reason: string; at: number }

export type Wave = 'RECONNAISSANCE' | 'ENGINEERING' | 'REVIEW' | 'INTEGRATION' | 'VERIFICATION'
export type TaskState = 'queued' | 'blocked' | 'reserved' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stalled' | 'escalated'
export type Verification = 'pending' | 'pass' | 'fail' | 'unknown'
export type SwarmResult = { conclusion: string; evidence: string[]; changes: string[]; verification: string[]; unresolved: string[]; confidence: string | null; escalation: string | null; rawRef: string | null }
/**
 * A structured handoff toward the commander. `to` moves the tier; `effort`,
 * when set, moves the reasonning level instead or as well (an effort-only
 * escalation keeps the tier and adds reasoning).
 */
export type Handoff = { objective: string; discoveries: string[]; evidence: string[]; question: string; risk: string; nextAction: string; locations: string[]; to: ModelTier; effort?: EffortLevel | null; effortReason?: string | null }
export type SwarmTask = {
  id: string; parentTask: string | null; parentAgent: string | null; agentId: string | null; tier: ModelTier; role: string
  objective: string; scope: string; dependencies: string[]; owned: string[]; mode: 'read' | 'write'; state: TaskState
  cancellationRequested: boolean; wave: Wave; spawnReason: string; escalation: Handoff | null; result: SwarmResult | null; verification: Verification
  /** Report observation, independent of host lifecycle and commander verification. Absent in older ledgers. */
  resultDelivery?: 'reported' | 'host_accepted' | 'answer_observed' | 'unavailable'
  /** The effort the commander requested for this task: a level, or AUTO to choose from the task. */
  requestedEffort: EffortRequest; /** Why that effort (or the AUTO selection) was chosen. */ effortReason: string
  /** The level last applied to this task's live agent requests, where observable; null before any request. */ appliedEffort: string | null
  /** The level set natively on this task's Agent call; null or absent when the call carried none and `turn.step` sets the level instead. */ launchEffort?: string | null
  /** One effort step upward within the tier, recorded when it happened. */ effortEscalation: EffortEscalation | null
  createdAt: number; startedAt: number | null; endedAt: number | null; lastActivityAt: number; reason: string | null
}
export type SwarmEvent = { seq: number; at: number; kind: string; taskId: string | null; agentId: string | null; wave: Wave; detail: string }
export type SwarmConfig = { sonnet: number | 'AUTO'; haiku: number | 'AUTO'; total: number | 'AUTO'; /** Opus specialist subagents allowed at once; 0 (and absent, in older ledgers) keeps OPUS tasks in the main loop. Counted in `total` when above 0. */ opus?: number; maxTasks: number; maxEvents: number; stallMs: number }
export type Swarm = { version: 2; wave: Wave; config: SwarmConfig; tasks: SwarmTask[]; events: SwarmEvent[]; sequence: number; requested: number; actual: number; highWater: number; conflicts: number; droppedEvents: number }
export type TaskInput = Pick<SwarmTask, 'id' | 'tier' | 'role' | 'objective'> & Partial<Pick<SwarmTask, 'parentTask' | 'parentAgent' | 'scope' | 'dependencies' | 'owned' | 'mode' | 'wave' | 'spawnReason'>> & { /** Requested reasoning level, or AUTO to choose from the task. */ effort?: EffortRequest; /** Why the effort was chosen. */ effortReason?: string }

export type Value<T> = T | typeof UNKNOWN
export type Counts = { tools: number; reads: number; edits: number; writes: number; tests: number; builds: number; git: number; failures: number; retries: 'unknown' }
export type Run = { id: string; turnId: string; parentRun: Value<string>; start: number; end: Value<number>; status: string; model: Value<string>; effort: Value<string>; effortSource: 'request' | 'engine' | 'unknown'; effortVia?: EffortVia; requestedEffort?: Value<string>; routingReason?: Value<string>; fallbackReason?: Value<string>; effectiveEffort?: Value<string>; latest: string; counts: Counts }
export type LedgerAgent = { id: string; role: string; name: string; runId: Value<string>; originTurn: Value<string>; parentAgent: Value<string>; requestedModel: Value<string>; requestedEffort: Value<string>; model: Value<string>; effort: Value<string>; effortSource: 'request' | 'engine' | 'unknown'; effortVia?: EffortVia; routingReason?: Value<string>; fallbackReason?: Value<string>; effectiveEffort?: Value<string>; start: Value<number>; end: Value<number>; status: string; latest: string; counts: Counts; source: Value<string>; background: Value<boolean> }
export type ToolEntry = { id: string; runId: Value<string>; turnId: Value<string>; agentId: Value<string>; tool: string; family: string; durationMs: Value<number>; file: Value<string>; start: number; end: Value<number>; status: string; source: Value<string> }
export type Reading = { at: number; turnId: Value<string>; tokens: Value<number>; window: Value<number>; percent: Value<number> }
export type Request = { id: string; runId: Value<string>; turnId: string; agentId: Value<string>; requestedModel: Value<string>; requestedEffort: Value<string>; model: Value<string>; effort: Value<string>; effectiveEffort: Value<string>; input: Value<number>; output: Value<number>; cacheRead: Value<number>; cacheWrite: Value<number> }
export type Checkpoint = { at: number; goal: string; phase: string; completed: string[]; remaining: string[]; latest: string; gates: Record<string, string>; branch: string; startingSha: string; currentSha: string; repo: string; dirty: Value<number>; blockers: string[]; backgroundAgents: string[] }
export type Ledger = { schema: 1 | 2; observedCompletions?: { agentId: string; reason: string; conclusion: string; at: number }[]; swarm?: Swarm; sessionId: string; currentRun: Value<string>; turns: Record<string, string>; runs: Run[]; agents: LedgerAgent[]; tools: ToolEntry[]; requests: Request[]; usage: Reading[]; receipts: NwhoEvent[]; warnings: string[]; replay: ReplayStep[]; checkpoint: Checkpoint | null; /** Opus consultations (SONNET_LED); absent in older ledgers. */ consults?: Consultation[]; /** The session router's decisions, newest last; absent until one is made. */ routing?: RouterDecision[]; /** v0.5.1 decision records, newest last; absent in v0.5.0 ledgers. */ decisions?: DecisionRecord[]; /** v0.5.1: why each task got its discovery level; absent in v0.5.0 ledgers. */ discoveries?: DiscoveryEntry[] }
export type ReplayStep = { id: string; runId: string; turnId: string; agentId: string; file: string; kind: 'Edit' | 'Write'; at: number; before: string; after: string; scope: 'fragment' | 'file'; omitted: boolean }
export type Cursor = { offset: number; size: number; seen: string[]; primed: boolean }

// ---------------------------------------------------------------------------
// The session router (hooks/router.ts).
// ---------------------------------------------------------------------------

/** The session's router. OFF in every new session; chosen with /cockpit router; never stored. */
export type RouterMode = 'OFF' | 'NOBODYWHO' | 'JEV'
export type ActiveMode = Exclude<RouterMode, 'OFF'>
/** What a router may recommend for a task. A recommendation starts nothing. */
export type Route = 'direct' | 'scout' | 'delegate' | 'effort' | 'opus'

/** One routing decision as the ledger keeps it: no prompt text, no credential, only what happened. */
export type RouterDecision = {
  at: number
  mode: ActiveMode
  /** What was asked for; one kind today. */
  asked: 'route'
  /** The provider and model that really answered; null when none did. */
  provider: string | null
  model: string | null
  /** Receipts of the requests that really ran, clipped; empty when none did. */
  receipts: string[]
  /** Requests sent, and how many came back with a receipt. */
  calls: number
  answered: number
  /** Wall time of the whole reading by Cockpit's clock, and the provider's own figures summed. */
  wallMs: number | null
  providerMs: number | null
  agreed: number
  advice: Route | null
  /** What the rules alone say for this task. */
  rules: Route
  outcome: 'accepted' | 'rejected' | 'fallback'
  reason: string
}

export type RouterState = {
  mode: RouterMode
  /** Raised at every switch: a reading begun under another epoch is never used. */
  epoch: number
  /** What is known of the selected provider: nothing yet, that it answered, or why it did not. */
  link: 'unchecked' | 'connected' | 'unavailable'
  detail: string | null
  asked: number
  accepted: number
  rejected: number
  fallbacks: number
  last: RouterDecision | null
}
