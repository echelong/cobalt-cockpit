# Cobalt Cockpit v0.5.1 — Elastic Swarm + Adaptive Intelligence

**Mission control for Claude Code.** Follow real task progress, coordinate bounded subagents, review verification gates, and replay what happened, without replacing Claude Code's native model and permission controls.

[![Source branch: main](https://img.shields.io/badge/source-main-blue)](https://github.com/echelong/cobalt-cockpit/tree/main)
[![CI](https://github.com/echelong/cobalt-cockpit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/echelong/cobalt-cockpit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Privacy](PRIVACY.md) · [Security](SECURITY.md)

## What it does

Cobalt Cockpit adds a cyberpunk HUD, orchestration controls, and a local Run Ledger to Claude Code. It tracks **observed** milestones and verification rather than inventing progress. With orchestration enabled, Opus coordinates bounded Sonnet engineering and Haiku utility tasks, each with task-aware reasoning effort. The dashboard itself makes no model calls.

## How the swarm works

```mermaid
flowchart TD
    U["You: goal and Opus effort preference"] --> O["Opus 5.5 · commander<br/>Plan · delegate · integrate · verify"]
    O <--> C["Cobalt Cockpit<br/>Admission · task ownership · waves · safety"]
    C --> D{"Delegate only when useful"}
    D -->|"Bounded investigation / routine work"| H["Haiku 5.5 pool<br/>Scout · inventory · classify<br/>Per-task effort"]
    D -->|"Implementation / deep review"| S["Sonnet 5.5 pool<br/>Engineer · debug · review<br/>Per-task effort"]
    D -->|"Architecture / small coupled task"| O
    H -. "Complexity escalation" .-> S
    S -. "Architectural escalation" .-> O
    H --> R["Structured evidence and results"]
    S --> R
    R --> O
    O --> V["Verification gates<br/>Tests · typecheck · build · review"]
    V --> L["Run Ledger · HUD · replay"]
    N["NobodyWho (optional)<br/>Read-only local decision/pruning receipts"] -.-> C
```

Opus remains **one main commander** and keeps the reasoning effort you select in Claude Code. Sonnet handles well-scoped engineering and review; Haiku handles bounded reconnaissance and repetitive processing. Cockpit tracks ownership, dependencies, escalation, and evidence. It is not an independent model router or a guarantee that every available agent slot will be used.

**AUTO resource budgets:** up to 8 Sonnet, up to 16 Haiku, and **16 total subagents** under Cockpit's default admission policy. Actual Claude Code concurrency and model availability may be lower. Independent tasks can run in parallel; competing writers are serialized.

## Features

- VECTOR / Activity Field, milestone progress, verification-gated DONE, context usage and Git/activity tracking.
- Dynamic, task-aware reasoning effort: AUTO selection, a commander-named level per assignment, an operator ceiling and capability fallback, with requested and applied effort kept apart.
- Main and subagent orchestration telemetry, subagent radar, observed model/effort and token usage.
- Local Run Ledger, sanitized JSON export, bounded replay, and park/resume checkpoints.
- Blast-radius protection, repository hygiene, optional sounds and hot reload persistence.
- Fail-closed guards: a hook that cannot reach its decision refuses the action it guards rather than letting it run, and every such decision is judged against the event it was given.
- Narrow-terminal and reduced-motion layouts; preserves the engine's image viewer.
- Optional read-only NobodyWho telemetry and opt-in orchestration policy enforcement.
- Optional Sonnet-led profile (`profile: SONNET_LED`): Sonnet 5.5 is the main model at your effort, and Opus 5.5 runs at High only as an admitted, read-only architect consultation. `OPUS_LED` stays the default.
- Optional per-session router (`/cockpit router`): OFF by default, NobodyWho (local) or JEV (TypeSafe API) for advisory routing recommendations. Cockpit's deterministic rules stay authoritative.
- Read-only helpers can deliver their reports: a bound helper may use the host's tool discovery and report hand-back without gaining any write, shell or delegation right, and each task records how its report arrived.

## Quick start

Requires Claude Code with mods/plugins enabled. **Claude Code 2.1.292+ is needed for native per-invocation subagent effort**; native subagent effort was live-tested on Claude Code 2.1.294. Check `claude --version` first. Older hosts have reduced effort observability and compatibility fallbacks.

Install from this repository's **public GitHub marketplace**:

```sh
claude plugin marketplace add echelong/cobalt-cockpit
claude plugin install cobalt-cockpit@cobalt-cockpit
```

Restart Claude Code, open `/cockpit`, and inspect `/cockpit version`. By default Cockpit **observes**; orchestration enforcement is opt-in.

To enable orchestration with the supported configuration CLI:

```sh
printf '%s\n' '{"orchestration":"true"}' | claude plugin configure cobalt-cockpit@cobalt-cockpit --values-stdin
```

Restart Claude Code again after changing settings. Enabling orchestration activates model/admission and ownership policy; it does not enable Fable blocking unless you also opt into `blockFable` or `cobaltStrict`.

**Updating an existing public-marketplace installation:**

```sh
claude plugin marketplace update cobalt-cockpit
claude plugin update cobalt-cockpit@cobalt-cockpit
```

Restart Claude Code and check `/cockpit version`. Your settings, preferences and saved Run Ledgers are kept. v0.5.0 keeps `OPUS_LED` as the default profile, so the main model does not change unless you choose `SONNET_LED` (below). It adds one option, `routerConfigDir`, empty by default, and the session router is OFF in every new session.

The marketplace name in this repository is `cobalt-cockpit`. Some existing private/local setups use a separately registered marketplace alias such as `cobalt`; for those, use the identity shown by `claude plugin list` rather than copying the public suffix.

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
| `/cockpit discovery` / `/cockpit discovery light\|standard\|deep\|auto` | Show the discovery level, open unknowns, decisions and goal check, or pin a level (this session only) |
| `/cockpit router` / `/cockpit router off\|nobodywho\|jev` | Show this session's router, or switch it (this session only; a new session starts OFF) |
| `/ledger` | Open local Run Ledger |
| `/ledger export json` | Print sanitized telemetry JSON |
| `/ledger export decisions` | Print recorded decisions as Markdown to paste into project docs (nothing is written to disk) |
| `/replay` | Browse successful edit/write snapshots |
| `/park` | Save a deterministic checkpoint for later resume |

## Orchestration

**Observation is the public default.** With `orchestration: false`, Cockpit observes your existing Claude Code activity without enforcing model routing, subagent budgets, Fable blocking, or subscription-only authentication. The bundled explorer/researcher/worker/reviewer agent definitions use Sonnet 5.5; scout/utility use Haiku 5.5.

Set **`orchestration: true`** to enforce the Opus/Sonnet/Haiku policy, independent pool resource budgets, and explicit task ownership. Orchestration does not by itself block Fable outside routed work. **`blockFable` is a separate opt-in**. **`cobaltStrict`** is an optional stricter preset that also blocks Fable/external advisor selection and requires subscription-style authentication. These models must be available to your account; Cockpit cannot grant model access.

The strict preset takes precedence over individual enforcement switches. NobodyWho remains optional: Cockpit observes its local receipts if configured and does not install it. It sends the local router a request only in a session where you selected a router with `/cockpit router`.

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
- A task's level is *requested*, not guaranteed. The operator's `maxEffort` cap applies to subagents, and the host can apply its own limits. The Ledger distinguishes the requested level from the **engine-resolved** level and names a mismatch (`EFFORT FALLBACK`). This is host-resolution evidence, **not an independently captured wire receipt**. Unknown stays unknown.
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
| QUERY | Waiting on a question put to you, or on one of Cockpit's own asks. Claude Code's permission dialog is not tracked |
| FAULT | Failure or blocker |
| VERIFIED | Milestones complete and required gates satisfied |

A completed turn does not complete a task. Missing measurements stay unknown.

## Run Ledger

Ledger records observed runs, agents, tools, usage, verification and optional local-control receipts. It keeps up to eight sessions in the host's plugin store, with a 384,000-byte budget per stored ledger and bounded detail windows. Live agents and originating runs are retained; oldest detail is evicted first. `/park` stores phase, explicit goal/milestones, blockers and Git checkpoint data. Resuming the same session restores its checkpoint; this is not an automatic new-session handoff or model summary.

Replay retains at most 24 snapshots, with a 96,000-character aggregate budget and 12,000-character per-step budget. Sensitive filenames, detected credentials and oversized content are omitted. JSON export excludes snapshot bodies, agent descriptions and checkpoint prose. It includes sanitized structured task assignments, ownership, results and lifecycle evidence.

## Discovery, decisions and goal check

Added in v0.5.1. It is Cockpit's own heuristic, not an Anthropic workflow or endorsement, and it adds no model call: the level comes from deterministic rules over the prompt, the files the host saw edited and the consultation grounds Cockpit already reads. A router (NobodyWho or JEV) may still advise on routing; it cannot lower a level, skip a gate or waive a consultation.

| Level | When | What changes |
| --- | --- | --- |
| `LIGHT` | A typo, a label, a rename, a question, a single obvious edit | Nothing is added to the prompt. No questions, no record. Progress and gates apply as before. |
| `STANDARD` | A change request, a feature, real debugging, three or more files edited | One short line once: state the objective and acceptance criteria, name only unknowns that change the implementation, assume safely otherwise, record consequential choices, check the goal before DONE. |
| `DEEP` | A migration, authentication, payments, concurrency, data integrity, architecture, or a security or architecture consultation ground | A longer line once: establish the architecture, name only the risk categories that apply, compare approaches. Any Opus consultation still goes through `swarm consult` and its admission rules. |

A level only goes up during a task, and each level's guidance is given once. The progress tool gained three actions: `discover` (objective, acceptance criteria, material unknowns, relevant risks), `decide` (one decision) and `align` (the goal check). `/cockpit discovery` shows the state:

```
COBALT / DISCOVERY
LEVEL / STANDARD
GOAL / Implement booking cancellation
UNKNOWNS / 2 unresolved
DECISIONS / 1 recorded
ALIGNMENT / PENDING
```

**Decisions.** A record holds a problem, the chosen approach, alternatives with the reason each was rejected, trade-offs, evidence and a status (`provisional`, `verified`, `revised`). Cockpit stores what the model reported and nothing else: an alternative without its reason, or a `verified` decision without evidence, is refused rather than filled in. Records are redacted for credential shapes before they enter task state or the Run Ledger, bounded (12 per task, 64 per ledger, detail dropped before records when the 384,000-byte budget is tight) and not required for LIGHT work. The ledger also keeps one entry per task saying which level was chosen and why, in short codes, with no prompt text. Cockpit never creates `DECISIONS.md` or `CLAUDE.md`; `/ledger export decisions` prints Markdown for you to paste.

**Goal check.** A coding task above LIGHT cannot read DONE until `align` reports `ALIGNED`: every declared acceptance criterion needs its own evidence, nothing reported missing, no unknown still open, every earlier milestone done, no blocker and every required gate passed. Passing tests are one input, never the whole. `PARTIAL`, `BLOCKED` and `UNKNOWN` are recorded and do not complete the task. Editing files (by the main session or a helper), failing a required gate or milestone, a new criterion or open unknown, or a new plan afterwards takes the check back. `ALIGNED` is refused before a plan exists, and a read-only plan that goes on to edit files is held like coding work. A plan restart cannot lower the level a task reached. The result is a hold on the existing progress model (the task stays UNVERIFIED below 100%), not a second percentage. LIGHT, read-only and operator-pinned LIGHT tasks, and tasks stored before v0.5.1, are never held by it. A pin of `light` waives this check for the rest of the session, for every later task, until you set `auto`; it changes only this check and the guidance: mandatory Opus consultations and the six gates are unaffected.

**Limits.** The level is a heuristic over words and file names, so it can misjudge a terse or oddly worded prompt in either direction; pin it with `/cockpit discovery`. The goal check is as honest as the evidence the model reports: Cockpit refuses an `ALIGNED` that is incomplete on its face but cannot judge whether the evidence is true.

## Safety

Blast-radius protection asks before recognized destructive shell commands. Repository hygiene checks attribution and unsolicited instruction-file creation. These guards supplement Claude Code permissions; they are heuristic and cannot recognize every shell program or obfuscated command. Verification gates use observed exit status and explicit reported evidence, not proof of correctness.

Cockpit does not take part in Claude Code's permission check. It registers no hook on it and makes no permission query; its guards run before it and can only refuse a call or ask you about it, never approve one.

### Sonnet-led profile

`profile: SONNET_LED` (with orchestration enforced): **Sonnet builds. Haiku scouts. Opus reviews. A router, if you select one, advises.**

- The main loop is requested on Sonnet 5.5 at your own effort (`/effort`, settings, `modelSettings`); Cockpit never rewrites that effort.
- Haiku scouts and Sonnet workers run as before. AUTO budgets are conservative: 4 helpers in all, 2 Sonnet, 2 Haiku and 1 Opus within them. Explicit `maxSubagents`/pool values still win.
- Opus 5.5 is never the main loop and never a background model. The main session requests it with `swarm action consult`: a ground (`architecture`, `security`, `repeated-failure`, `asked`, `release`) and a concise evidence packet (objective, architecture, files, alternatives, failures, risk, decision). Cockpit admits it only where the ground holds on evidence: a large or spread change, or architecture named in the prompt; security-sensitive files or a security prompt; the same failure three times in a row; an explicit request for Opus; a release approval. One Opus at a time, an unchanged problem consulted once, one retry after a failed run, three per task. The admitted consultation runs as `cobalt-cockpit:architect` (read-only, Opus, high effort) and returns a structured decision; Sonnet implements and verifies it.
- Opus cannot be reached around this: an unassigned Agent call naming Opus or the architect, an `assign` of tier OPUS, or the architect on a Sonnet task is refused.
- Mandatory consultations: an explicit request for Opus, a release approval, or a change to security-sensitive files (auth, secrets, credentials, permissions, policy, guards, `.env`, keys) holds the task below 100% until a consultation has returned and the main session has verified its advice with `swarm action verify` (pass or fail, with evidence). Review findings are advice until verified.
- No router is asked when Opus is admitted: admission is by the rules alone. The optional session router (below) is asked only at the start of a task and never decides admission.
- HUD and Ledger name the roles (MAIN, SCOUT, ENGINEER, ARCHITECT, LOCAL CONTROL), list each consultation with its ground, whether it returned, its decision and Sonnet's verification, and report host-reported tokens per tier. Requests without usage figures are counted as unreported; nothing is estimated. `/ledger` shows the host's `/cost` total where it keeps one.
- Context: set Sonnet's compaction window natively (`/autocompact 400k`, stored as `modelSettings["claude-sonnet-5-5"].autoCompactWindow`). Cockpit does not compact or change settings. Subagents keep their own model defaults.

`OPUS_LED` remains the default: Opus commands, as in 0.4.0, and nothing about models or admission changes unless you choose the other profile. What an upgrading user does see is listed in [docs/release-v0.5.0.md](docs/release-v0.5.0.md). `cobaltStrict` turns orchestration on and adds safety restrictions; it never names a model, so strict mode with `SONNET_LED` keeps Sonnet as the main loop.

**Set up SONNET_LED** (keep your other options; CLI values are strings):

```sh
printf '%s\n' '{"orchestration":"true","profile":"SONNET_LED"}' | claude plugin configure cobalt-cockpit@cobalt-cockpit --values-stdin
```

Then choose the main effort yourself (`/effort medium` is recommended), optionally `/autocompact 400k` while on Sonnet, and restart Claude Code. `/cockpit version` shows `PROFILE / SONNET_LED · main claude-sonnet-5-5 · Opus on admission`.

**Roll back** to the previous behaviour by setting `profile` to `OPUS_LED` (or removing it) and restarting:

```sh
printf '%s\n' '{"profile":"OPUS_LED"}' | claude plugin configure cobalt-cockpit@cobalt-cockpit --values-stdin
```

Run Ledgers and preferences stay readable in both directions. Design, measurements and the v0.5.0 corrections are in [docs/implementation-v0.5-sonnet-led.md](docs/implementation-v0.5-sonnet-led.md) and [docs/delivery-v0.5.0-hardening.md](docs/delivery-v0.5.0-hardening.md).

## Session router

A router is an optional, lightweight classifier that **recommends** how to handle a new task. You choose it per session:

```
/cockpit router              show the active router (and choose one, in an interactive session)
/cockpit router off          Cockpit's deterministic policy only (every new session starts here)
/cockpit router nobodywho    the local decision router, local provider only
/cockpit router jev          the same router's TypeSafe JEV provider (an external API)
```

The choice lasts for the session and is never saved. One router is active at a time, and switching discards everything the previous one said. `/cockpit` and `/cockpit version` show it: `ROUTER / OFF`, `ROUTER / NOBODYWHO · LOCAL`, `ROUTER / JEV · CONNECTED`.

What a router may do is recommend one of five routes: handle it in the main session, scout with Haiku, delegate bounded parts to Sonnet, consider a higher effort, or consider an Opus consultation. What it may not do is anything else. It never starts an agent, admits or skips an Opus consultation, or changes a model, an effort, a permission, an ownership rule or a verification gate. Cockpit's rules judge every recommendation:

- The rules go first. When they already settle the route (a mandatory consultation, or a route read off the prompt), no router is asked at all.
- A recommendation for Opus is refused unless a consultation ground already holds on evidence. You are shown a notice instead, and asking for Opus yourself is a ground the rules honour.
- An accepted recommendation adds one advisory line to the task. A scout or worker it suggests still goes through assignment and admission.
- If the router is down, slow, or its answer does not hold up, the deterministic policy decides and the fallback is recorded.

A router is asked once per task, at its start, when the rules do not settle it; never for a tool call, a helper or an Opus admission. What counts as a task: with a plan in progress, the whole plan is one task and prompts inside it are not asked about. Without a plan, each prompt you submit (of 16 characters or more) is a task of its own, so each is asked about. The question is five fixed yes/no features of the task, each asked in both orders. A feature counts only when both orders agree, and the whole reading is discarded when fewer than four of five agree or more than three are affirmed. That is what makes the answer independent of option position: the local classifiers measurably follow position otherwise.

Measured for v0.5.0 on 56 balanced synthetic tasks (details and limits in [docs/delivery-v0.5.0-router.md](docs/delivery-v0.5.0-router.md)): the rules alone classified 45; the router's reading alone was right for 49 with the local Qwen3 4B model and 51 with JEV, and 8 with the router's 0.6B tier-1 specialist, which is why NobodyWho mode uses the router's plain local provider. With the rules going first, as shipped, the outcome was right for 47 (NobodyWho) and 46 (JEV): most of what a router adds is "this is one for Opus", which it may only tell you. JEV answered in about 250 ms per request (p50 246 ms, p95 297 ms), not the 16 ms sometimes quoted.

**JEV sends data off your machine.** In JEV mode ten small requests go to the TypeSafe API through your own decision router. They carry only words from a fixed engineering vocabulary found in the prompt that starts a task, and a size bucket: never prompt text, names, paths or numbers. A prompt in which credential-shaped text is recognised is not sent to any router. See PRIVACY.md.

```sh
# one time: a copy of your router config with JEV enabled, used by Cockpit's JEV mode only
mkdir -m 700 -p ~/.config/cobalt-cockpit/router-jev
python3 -c "import json,os;h=os.path.expanduser;c=json.load(open(h('~/.config/decision-router/config.json')));c.setdefault('jev',{})['enabled']=True;open(h('~/.config/cobalt-cockpit/router-jev/config.json'),'w').write(json.dumps(c,indent=1)+'\n')"
printf '%s\n' '{"routerConfigDir":"~/.config/cobalt-cockpit/router-jev"}' | claude plugin configure cobalt-cockpit@cobalt-cockpit --values-stdin
```

Your global router configuration is untouched, so nothing else on the machine reaches JEV. The directory must be your own: one inside the project you are working in is refused, so a repository can never choose where the router sends a request. Without `routerConfigDir`, JEV mode reports `JEV · UNAVAILABLE (jev_disabled)` whenever the router's own switch is off.

## NobodyWho integration

This section is the read-only telemetry; the router you can select is described above. By default, Cockpit checks `$XDG_STATE_HOME/decision-router/ledger.jsonl`, or `$HOME/.local/state/decision-router/ledger.jsonl`. Set `ledgerPath` to override it; set `localControl` false to stop reading.

Only `caller: "claude"` receipts arriving after startup are shown. Decision comes from an `ask` receipt; Pruning comes from a `prune` receipt. They stay separate. Missing, malformed or unavailable ledgers are silent; LOCAL CONTROL is omitted when nothing is observed. This telemetry shows no fake activity, has no cloud fallback and does not depend on local control. (JEV is reachable only as the session router you may select, described above.) Raw prompts, hidden reasoning, receipt details and credential values are not copied into this adapter's telemetry.

## Configuration

Use `/config` or `claude plugin configure cobalt-cockpit@cobalt-cockpit` to inspect options. CLI input values are strings, even for Boolean options:

```sh
# Full opt-in policy: orchestration plus Fable and external-advisor blocking
printf '%s\n' '{"cobaltStrict":"true"}' | claude plugin configure cobalt-cockpit@cobalt-cockpit --values-stdin
```

Restart Claude Code after changing configuration. To enable just Fable blocking alongside orchestration, configure `blockFable: true` separately. No external router is required.

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
| `profile` | `OPUS_LED` (legacy: Opus main loop); `SONNET_LED` runs the main loop on Sonnet and consults Opus on admission |
| `routerConfigDir` | empty; a decision-router configuration directory you created for the JEV router mode, used only while a session's router is JEV |

## Compatibility

Linux and macOS terminals use standard text/Braille rendering; Kitty or WezTerm is not required. Narrow widths drop detail progressively. Desktop uses SVG where available; terminal retains text/Raster equivalents. Core commands and guards do not need desktop graphics. Image viewing delegates to Claude Code.

Sounds try PipeWire, PulseAudio, ALSA, ffplay, mpv, SoX, Canberra, macOS afplay, then a terminal bell. Missing/failing players fall back to silence. `/cockpit mute` disables cues. macOS behavior is covered by the engine test harness, not a physical macOS run. Windows is not tested. Mods may be disabled by organizational policy; this dashboard is intended for Claude Code, not claude.ai/Cowork.

## Privacy

Run Ledger is local. Cockpit observes tool calls, paths, agent events, token/context telemetry, Git state and verification. In-session task state can contain user text; persisted checkpoints retain explicit goals and milestone labels. Hidden reasoning is never stored. Redaction is heuristic: review exports before sharing, and never export secrets. The full policy is in [PRIVACY.md](PRIVACY.md); see also [SECURITY.md](SECURITY.md).

### What Cockpit runs, reads and sends

Cockpit installs no launcher and downloads nothing. It runs local processes, with your privileges and without prompting, for five reasons: `realpath -m` canonicalizes a path a subagent claims as its own (orchestration only), `tail -c` reads the end of a telemetry ledger larger than 512 KiB, `git status --porcelain=v2` and `git rev-parse --show-toplevel` feed the HUD, one of nine audio players plays the optional cues (`pw-play`, `paplay`, `aplay`, `ffplay`, `mpv`, `play`, `canberra-gtk-play`, `afplay`, then a terminal bell), and, only while a session router is selected (`/cockpit router`, off in every new session), `decision ask --caller cockpit --mode local|jev --json <question>` asks the local decision router about a new task: the question is the first 400 characters of your prompt and one fixed yes/no question. With `local` the router's own model answers on this machine. With `jev` the router sends the request to the TypeSafe JEV API under your key, which Cockpit never reads; an operator-set `routerConfigDir` is passed to that process as `DECISION_ROUTER_CONFIG_DIR` in JEV mode only. Each is an argument array: no shell string is ever built from model or user text.

It reads files: the decision-router ledger (read-only, optional, `localControl`), a file about to be written (a bounded replay snapshot), and Claude Code's settings. It reads environment variables **by name**: `CLAUDE_CODE_EFFORT_LEVEL`, `XDG_STATE_HOME`, `HOME`, `COBALT_REDUCED_MOTION`, and eight authentication variables — `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_MANTLE` — whose values are reduced to set-or-not-set on the spot and never stored, logged, exported or sent. It writes nothing outside the host's plugin store, which holds up to eight bounded run ledgers, bounded replay bodies, checkpoints and two preferences.

It makes no network request of its own: no fetch, no model call, no MCP call. The one program it starts that can is the decision router in JEV mode, in a session where you selected it. Its two prompt hooks add text to the request Claude Code already sends — the discipline, safety and policy sections of the system prompt, and one line of task status — which is the only route by which anything Cockpit observed reaches a model. Every path above is listed with its call site in [docs/implementation-v0.3.2.md](docs/implementation-v0.3.2.md).

The guards are not a sandbox: they use recognizable syntax and your confirmation. Keep Claude Code's permission controls enabled.

## Development

Load the folder once with `claude --plugin-dir /path/to/cobalt-cockpit` to generate the host API declarations. TypeScript 5.4+ is needed for type checking; Python 3 runs the portability audit. The suite's default host version is 2.1.288, and the native-effort and directory-validation paths are exercised at 2.1.294.

```sh
claude plugin validate --strict .
claude plugin validate --strict .claude-plugin/plugin.json
claude plugin validate --strict agents
claude plugin test .
tsc -p .
python3 scripts/audit-public.py
python3 scripts/make-icon.py    # re-render the listing icon from the HUD portrait
```

All fixtures are synthetic. Test with an isolated HOME/config/state directory. Do not use a real telemetry ledger or private session capture in fixtures.

## License

MIT. Adapted work and required upstream MIT notices are preserved in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).

## Optional companion: memory and browser

Cockpit is complete on its own: it needs no memory service, no browser, no database and no extra inference, and this repository contains none of that code.

[`cobalt-capabilities`](https://github.com/echelong/cobalt-capabilities) is a separate plugin, in its own repository with its own releases, for people who want explicit project memory (through a Hindsight service they run) or bounded browser evidence (through an Obscura service they run) alongside Cockpit v0.4.0 or later. It is not installed with Cockpit, both of its capabilities are off until configured, and its privacy and security documentation is its own. Install instructions and limits are in that repository's README.
