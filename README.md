# Cobalt Cockpit v0.3 — Dynamic Reasoning

A live mission-control layer for Claude Code: see what is happening, what is verified, and what is safe to run.

<!-- Hero screenshot / GIF placeholder: add a synthetic session capture before promotion. -->

## What it does

Cockpit adds a cyberpunk HUD and local dashboard to Claude Code. Progress follows milestones; DONE requires verification gates. Reasoning effort is chosen per task in AUTO, so a cheap inventory and a difficult migration are not run at the same level. The dashboard makes no model calls.

## Features

- VECTOR / Activity Field, milestone progress, verification-gated DONE, context usage and Git/activity tracking.
- Dynamic, task-aware reasoning effort: AUTO selection, a commander-named level per assignment, an operator ceiling and capability fallback, with requested and applied effort kept apart.
- Main and subagent orchestration telemetry, subagent radar, observed model/effort and token usage.
- Local Run Ledger, sanitized JSON export, bounded replay, and park/resume checkpoints.
- Blast-radius protection, repository hygiene, optional sounds and hot reload persistence.
- Narrow-terminal and reduced-motion layouts; preserves the engine's image viewer.
- Optional read-only NobodyWho telemetry and opt-in orchestration policy enforcement.

## Quick start

Requires **Claude Code 2.1.287 or later** with mods enabled. Tested on 2.1.288 (the suite's default) and 2.1.294 (the native-effort and directory-validation paths). Check `claude --version` first.

After the repository is published:

```sh
claude plugin marketplace add echelong/cobalt-cockpit
claude plugin install cobalt-cockpit@cobalt-cockpit
```

Restart Claude Code, or run `/reload-plugins` in an open session. Open `/cockpit`.
For development or a single-session trial:

```sh
git clone https://github.com/echelong/cobalt-cockpit.git
claude --plugin-dir /path/to/cobalt-cockpit
```

Disable or remove an installed copy:

```sh
claude plugin disable cobalt-cockpit@cobalt-cockpit
claude plugin uninstall cobalt-cockpit@cobalt-cockpit
```

A `--plugin-dir` copy stops loading when you omit the flag next session.

## Commands

| Command | Action |
| --- | --- |
| `/cockpit` | Open or close Mission Control |
| `/cockpit status` | Print current progress |
| `/cockpit auth` | Authentication and policy diagnostics, without credential values |
| `/cockpit mute` / `/cockpit unmute` | Persist sound preference |
| `/cockpit hud off` / `/cockpit hud on` | Persist HUD preference |
| `/cockpit reset` | Clear the current task |
| `/ledger` | Open local Run Ledger |
| `/ledger export json` | Print sanitized telemetry JSON |
| `/replay` | Browse successful edit/write snapshots |
| `/park` | Save a deterministic checkpoint for later resume |

## Orchestration

Observation works with users' existing models and authentication. Public defaults do not block Fable, rewrite model requests, enforce a subagent limit, or require subscription authentication. Bundled explorer, researcher, worker and reviewer definitions select Sonnet 5.5; scout and utility select Haiku 5.5. Observation does not rewrite host requests.

**Strict Cobalt is optional.** Enable `cobaltStrict` to request Opus 5.5 for main at the effort you set, Sonnet 5.5 engineering and Haiku 5.5 utility pools with independent resource budgets, isolated agents rather than inherited forks, Fable blocking, external advisor disabled, and subscription-style authentication only. These model IDs must be available to your account; there is no model fallback. Requested effort is observable; effective model-internal effort remains unknown.

The preset takes precedence over the individual enforcement switches. Disable it to return to observation. NobodyWho remains optional even in strict mode: Cockpit reads its telemetry if installed; it never installs it or routes decisions/pruning itself.

### Elastic execution

Opus remains the single commander: architecture, planning, decomposition, integration, escalation decisions and final verification. Sonnet engineers substantial bounded changes and independent reviews. Haiku scouts repositories and processes extractive, repetitive work. Small or tightly coupled work stays in the main session.

The `swarm` tool records bounded assignments before spawning. Each assignment carries a task ID, parent, tier, semantic role, objective, scope, dependencies, resource ownership, read/write mode and spawn reason. Include the exact `[task:ID]` marker in the Agent description. Queued tasks wait for resource capacity; blocked tasks wait for dependencies; intersecting write scopes are serialized. Read-only scopes may overlap. Scoped agents use Read/Grep/Glob for inspection and Edit/Write for changes. Shell or custom tools require exclusive wildcard ownership; a narrow set of safe Git inspection commands remains available for wildcard read-only tasks. Path canonicalization fails conservatively to wildcard when unavailable. Resource budgets replace the old three-agent ceiling; AUTO provides backpressure rather than uncontrolled fan-out.

Run waves are reconnaissance → engineering → review → integration → verification. Waves are observable phases; they do not replace dependency checks. Haiku may escalate reasoning to Sonnet; Sonnet escalates ambiguity, architecture and high-risk changes to Opus. Handoffs preserve objectives, discoveries, evidence, unresolved questions, risk and next actions. Escalation is distinct from ordinary completion. Agents return concise conclusion/evidence/change/check/uncertainty artifacts; commanders verify claims independently.

`/cockpit` groups observed tiers, compresses pools larger than eight agents and reports task progress, queue, blockers, ownership conflicts and escalations. The Activity Field retains its crawler/spine identity and aggregates utility pools. The Run Ledger and replay explain assignment, spawn reason, wave, completion, escalation and verification. Escalated results remain unresolved after their host stops; the commander uses `swarm resolve` with evidence before dependent work can proceed. Queued dispatch stays under the commander through Agent, rather than automatic spawn loops. Active cancellation suppresses further model/tool actions and retains ownership until host termination is observed (the host exposes no stop API). For a running pre-v0.2 agent with unknown ownership, the commander explicitly assigns its scope then uses `swarm adopt` with the observed `agent_id`; until then further agent tool effects are held. Older ledgers default to an empty swarm; unavailable telemetry stays unknown. NobodyWho boundaries remain read-only.

```text
Opus 5.5          — commander / integration / final verification, at your /effort
  ├─ Sonnet 5.5     — 0..N bounded engineering and review, effort per task
  └─ Haiku 5.5      — 0..N scouts and utility work, effort per task
       escalation → Sonnet → Opus
Cobalt Cockpit — ownership / waves / backpressure / HUD / ledger / replay
NobodyWho     — local Decision / Pruning / read-only control telemetry
```

## Dynamic reasoning

Model selection and effort selection are separate decisions. The 5.5 tiers still command, engineer and scout. **You control the main Opus loop's effort; Cockpit manages the subagents'**, per task rather than fixed per tier.

- **AUTO** (default) names a level from the task: extractive inventories, classification and summaries run light; normal feature work, bug fixes and refactors run medium; complex debugging, concurrency, migrations, security analysis and high-risk architectural reasoning run high or xhigh; unusually difficult high-stakes reasoning may use max. A task that names no class falls back to its tier's baseline.
- A commander can name a level explicitly per assignment with the `swarm` tool's `effort` field (LOW / MEDIUM / HIGH / XHIGH / MAX, or AUTO). A named level wins AUTO. **MANUAL** mode instead honours the fixed per-tier levels and leaves Haiku unspecified.
- A level is only ever *requested*. Each model supports its own ceiling and the operator's `maxEffort` caps every request, so the *applied* level may be lower after a fallback. Requested and applied effort are recorded separately in the Run Ledger, a fallback is named (`EFFORT FALLBACK`), and the model's real capability is learned only from what the engine reports it applied — never assumed.
- A subagent's level is set natively, on its own Agent call's `effort` parameter (Claude Code 2.1.292 or newer): one level per invocation, with no global setting for parallel agents to race on. It overrides the agent definition's `effort` frontmatter and a per-model `effortLevel` for that subagent only. The engine's own limits still win — `maxEffortLevel`, an organization's cap, `CLAUDE_CODE_EFFORT_LEVEL` and the model's support — and the level the engine resolves is what the ledger records as applied. When that is not the level asked for, the difference is named with both levels; it is never rewritten back.
- **The main loop's effort is never written by Cockpit.** A `turn.step` rewrite sits above everything in the engine's order (rewrite, then `CLAUDE_CODE_EFFORT_LEVEL`, then a session level from `/effort`, `--effort` or the model picker, then the settings' `effortLevel`, then the model's default, all under `maxEffortLevel`), and most of those cannot be seen from a plugin, so there is no way to offer a level *beneath* your own choice. The level the engine resolved is sent untouched and recorded as `engine`, with what was seen of its origin: the variable, a `/effort` typed this session, the settings, or `host` when none of those accounts for it. A cap that lowered your selection is named with both levels. AUTO and MANUAL, the `maxEffort` ceiling and every subagent launch leave it alone. With no selection of your own the main loop runs at the host's default for the model, which is not necessarily the level AUTO would name: `/cockpit version` then says what AUTO would name, as advice, and `/effort <level>` sets it.
- A subagent on an older engine, or one that no Agent call launched, gets its level from a per-request `turn.step` rewrite instead. The engine does not report that rewrite back, so there the ledger shows the level as *requested* (`request`), leaves *observed* unknown, and learns nothing about capability from the engine's reports.
- A failing task escalates one step at a time: raise effort within the tier first, then move a tier (Haiku → Sonnet → Opus). It never jumps to the top and stops at the budget rather than retrying forever.

The HUD shows the applied effort beside the model; `/cockpit version` prints the reasoning mode, the ceiling, the main loop's host-resolved level and where it was seen to come from, how a subagent's level reaches the engine, and only the capability this session has really observed.

## HUD states

| State | Meaning |
| --- | --- |
| IDLE | No active work |
| SCAN | Main loop working without a tool in flight |
| ACTIVE | Tool or agent activity observed |
| QUERY | Waiting for user input |
| FAULT | Failure or blocker |
| VERIFIED | Milestones complete and required gates satisfied |

A completed turn does not complete a task. Missing measurements stay unknown.

## Run Ledger

Ledger records observed runs, agents, tools, usage, verification and optional local-control receipts. It keeps up to eight sessions in the host's plugin store, with a 384,000-byte budget per stored ledger and bounded detail windows. Live agents and originating runs are retained; oldest detail is evicted first. `/park` stores phase, explicit goal/milestones, blockers and Git checkpoint data. Resuming the same session restores its checkpoint; this is not an automatic new-session handoff or model summary.

Replay retains at most 24 snapshots, with a 96,000-character aggregate budget and 12,000-character per-step budget. Sensitive filenames, detected credentials and oversized content are omitted. JSON export excludes snapshot bodies, agent descriptions and checkpoint prose. It includes sanitized structured task assignments, ownership, results and lifecycle evidence.

## Safety

Blast-radius protection asks before recognized destructive shell commands. Repository hygiene checks attribution and unsolicited instruction-file creation. These guards supplement Claude Code permissions; they are heuristic and cannot recognize every shell program or obfuscated command. Verification gates use observed exit status and explicit reported evidence, not proof of correctness.

## NobodyWho integration

Optional and read-only. By default, Cockpit checks `$XDG_STATE_HOME/decision-router/ledger.jsonl`, or `$HOME/.local/state/decision-router/ledger.jsonl`. Set `ledgerPath` to override it; set `localControl` false to stop reading.

Only `caller: "claude"` receipts arriving after startup are shown. Decision comes from an `ask` receipt; Pruning comes from a `prune` receipt. They stay separate. Missing, malformed or unavailable ledgers are silent; LOCAL CONTROL is omitted when nothing is observed. There is no fake activity, JEV integration, cloud fallback or dependency on local control. Raw prompts, hidden reasoning, receipt details and credential values are not copied into this adapter's telemetry.

## Configuration

Use `/config` or `claude plugin configure cobalt-cockpit@cobalt-cockpit` to inspect options. CLI values are strings:

```sh
printf '%s\n' '{"cobaltStrict":"true"}' | claude plugin configure cobalt-cockpit@cobalt-cockpit --values-stdin
```

Reload plugins after changing configuration.

| Option | Public default |
| --- | --- |
| `hud`, `animation`, `sounds` | true |
| `volume` | 0.6 |
| `blastRadiusGuard`, `attributionGuard` | true |
| `reducedMotion` | false; `COBALT_REDUCED_MOTION=1` also disables motion |
| `localControl` | true, optional detection |
| `ledgerPath` | empty, resolves from the environment |
| `orchestration` | false (observe); true enforces model/admission policy |
| `maxSubagents` | 0 = AUTO (16 total); explicit resource budget 1–128 |
| `maxSonnetAgents`, `maxHaikuAgents` | -1 = AUTO (8 Sonnet / 16 Haiku); 0 disables a pool; subject to total budget |
| `blockFable`, `subscriptionOnly`, `cobaltStrict` | false |
| `reasoningMode` | `AUTO`; `MANUAL` honours fixed per-tier levels for subagents; the main loop's effort stays yours |
| `maxEffort` | `max`; lower ceilings cap every subagent request and are recorded |

## Compatibility

Linux and macOS terminals use standard text/Braille rendering; Kitty or WezTerm is not required. Narrow widths drop detail progressively. Desktop uses SVG where available; terminal retains text/Raster equivalents. Core commands and guards do not need desktop graphics. Image viewing delegates to Claude Code.

Sounds try PipeWire, PulseAudio, ALSA, ffplay, mpv, SoX, Canberra, macOS afplay, then a terminal bell. Missing/failing players fall back to silence. `/cockpit mute` disables cues. macOS behavior is covered by the engine test harness, not a physical macOS run. Windows is not tested. Mods may be disabled by organizational policy; this dashboard is intended for Claude Code, not claude.ai/Cowork.

## Privacy

Run Ledger is local. Cockpit observes tool calls, paths, agent events, token/context telemetry, Git state and verification. In-session task state can contain user text; persisted checkpoints retain explicit goals and milestone labels. Hidden reasoning is never stored. Redaction is heuristic: review exports before sharing, and never export secrets. See [SECURITY.md](SECURITY.md).

### What Cockpit runs, reads and sends

Cockpit installs no launcher and downloads nothing. It runs local processes, with your privileges and without prompting, for four reasons: `realpath -m` canonicalizes a path a subagent claims as its own (orchestration only), `tail -c` reads the end of a telemetry ledger larger than 512 KiB, `git status --porcelain=v2` and `git rev-parse --show-toplevel` feed the HUD, and one of nine audio players plays the optional cues (`pw-play`, `paplay`, `aplay`, `ffplay`, `mpv`, `play`, `canberra-gtk-play`, `afplay`, then a terminal bell). Each is an argument array: no shell string is ever built from model or user text.

It reads files: the decision-router ledger (read-only, optional, `localControl`), a file about to be written (a bounded replay snapshot), and Claude Code's settings. It reads environment variables **by name**: `CLAUDE_CODE_EFFORT_LEVEL`, `XDG_STATE_HOME`, `HOME`, `COBALT_REDUCED_MOTION`, and eight authentication variables — `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_MANTLE` — whose values are reduced to set-or-not-set on the spot and never stored, logged, exported or sent. It writes nothing outside the host's plugin store, which holds up to eight bounded run ledgers, bounded replay bodies, checkpoints and two preferences.

It makes no network request of its own: no fetch, no model call, no MCP call. Its two prompt hooks add text to the request Claude Code already sends — the discipline, safety and policy sections of the system prompt, and one line of task status — which is the only route by which anything Cockpit observed reaches a model. Every path above is listed with its call site in [docs/implementation-v0.3.2.md](docs/implementation-v0.3.2.md).

The guards are not a sandbox: they use recognizable syntax and your confirmation. Keep Claude Code's permission controls enabled.

## Development

Load the folder once with `claude --plugin-dir /path/to/cobalt-cockpit` to generate the host API declarations. TypeScript 5.4+ is needed for type checking; Python 3 runs the portability audit.

```sh
claude plugin validate --strict .
claude plugin validate --strict .claude-plugin/plugin.json
claude plugin validate --strict agents
claude plugin test .
tsc -p .
python3 scripts/audit-public.py
```

All fixtures are synthetic. Test with an isolated HOME/config/state directory. Do not use a real telemetry ledger or private session capture in fixtures.

## License

MIT. Adapted work and required upstream MIT notices are preserved in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
