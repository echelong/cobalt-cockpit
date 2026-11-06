# Cobalt Cockpit for Cline

A supervisor that runs Cline workers under Cobalt Cockpit's engine: deterministic model routing across five
configured roles, OS-sandboxed workers in their own git worktrees, durable ownership, verification gates the
model cannot satisfy for itself, measured cost and a live mission-control screen. The Claude Code plugin in
this repository is unchanged: the adapter imports the engine's pure modules (`hooks/swarm.ts`, `guard.ts`,
`effort.ts`, `verification.ts`, `secrets.ts`, `router.ts`) through `src/core/engine.ts` and modifies none of them.

Status: **local prototype**, Linux only, tested against Cline CLI 3.0.74 (`@cline/core`/`@cline/llms` 0.2.0).
It is not a Cline plugin and does not claim Cline feature parity; see [Limitations](#limitations).

## Requirements

- Linux with unprivileged user namespaces and `bwrap` (bubblewrap). `cockpit-cline doctor` checks both.
- Node 24 (the one that runs `cline`), `git`, and the `cline` CLI on `PATH`, signed in (`cline auth`).
- No npm install: the adapter has no dependencies. Type checking uses TypeScript 5.9.3 (`scripts/typecheck.sh`).

## Setup

```sh
git -C /path/to/cobalt-cockpit switch cline-adapter          # or use the worktree that holds the branch
/path/to/cobalt-cockpit/cline/bin/cockpit-cline doctor        # installed Cline, sandbox, auth, model ids, reasoning
# optional: put the launcher on PATH under a name that does not collide with anything you already use
ln -s /path/to/cobalt-cockpit/cline/bin/cockpit-cline ~/.local/bin/cockpit-cline
```

`doctor` must print `doctor: OK`. It resolves every role against the **installed** Cline model catalog, checks that
the configured reasoning level exists for that model, and reports whether each provider has credentials (it
never prints them).

## The interactive Cockpit (one command)

```sh
cd ~/code/app && cockpit-cline            # or: cockpit-cline --repo ~/code/app --gate test="npm test"
```

On this machine `cline-cockpit` (a personal launcher in `~/.local/bin` that runs `bin/cockpit-cline`) opens the
same shell; any wrapper that execs `bin/cockpit-cline` with your arguments works the same way.

With no command, on a terminal, `cockpit-cline` opens the integrated Cockpit: a persistent live HUD on top, the
conversation in the middle, an input line at the bottom. Type a request as you would in Cline. **Every message is
one supervised task**: it is classified (question, change, debugging, UI, scouting, architecture), routed by the
fixed rules to its role's pinned model, run as a sandboxed `cline` worker in its own worktree, verified by the
supervisor's gates and integrated on `cockpit/<mission>`. The worker's answer streams into the transcript. The
next message carries the conversation (bounded) and starts from the integrated code, so the conversation continues
normally. The conversation reaches the worker as background context only: a turn is routed on its own words, so
an earlier "React layout" turn never sends a later "add a flag" turn to the frontend model, and a commander's
design never reroutes the tasks it planned. Answers from turns that did not pass verification are labelled as
such in later turns' context. Reopening `cockpit-cline` in the same repository resumes the conversation: transcript, mission state and
any interrupted work are reconciled by process identity first (`--new` starts a fresh conversation).

### HUD 2.0

The HUD uses the Claude Code Cockpit's design language: its palette (`hooks/theme.ts`: red for activity, amber
for waiting, green for done, deep red for failure, cyan only for scanning and checks), numbered dossier sections
and `NAME / VALUE` labels. Every figure comes from the supervisor's live state, its hash-chained ledger (tailed
by byte offset) or the worker's own Cline event stream. Nothing is estimated for display, and an unknown value
reads `—` or `?`, never zero or ✓.

| Section | What it shows |
|---|---|
| header | mission state pill (RUNNING, VERIFYING, RETRYING, WAITING, BLOCKED, `FINISHED · VERIFIED` only on a DONE verdict, otherwise `FINISHED · PARTIAL`/`UNVERIFIED`/…), `◈ KIMI ORCHESTRATING` while a plan runs, elapsed time, spend of budget, repo, branch@head, profile, Cline version, ownership claims |
| `01 SWARM / FIVE MODELS` | one row per role: model (DeepSeek 1017 marked `★` as the default coder), provider, reasoning requested→effective (`✓` confirmed on the wire, `?` unconfirmed or not sent yet, `~` inferred for MiMo's toggle, `✗` mismatch, `◌` expected but not yet observed), state (RUNNING with a spinner, VERIFYING, RETRY Ns, WAITING with the admission reason, QUEUED, BLOCKED, DONE, FAILED, UNAVAILABLE), the task and what the worker is doing now (its last tool call), escalation origin, tokens in/out, cost (`~` estimated, `—` not reported), elapsed |
| `02 VERIFY / GATES` | TEST, TYPE, BUILD, SECURITY, GIT: PASS, FAIL, PENDING, SKIPPED (not configured), UNVERIFIABLE (the change edits its own gate definition), NOT RUN, each with where it ran (task attempt or branch@head) and the OUTCOME line, which says "an ended run is not a verified task" until the supervisor's verdict |
| `03 SPEND / BUDGET` | session spend and bar, what is left after reservations for running workers, reported vs estimated vs unmetered, spend by model family, crossed alerts and a reached cap |
| `04 ACTIVITY / LIVE` | the latest real events: routing, sandbox start, edits, commands and test runs, gates, integration, failures, retries, escalations, budget alerts, verdicts, each with the agent and task |

**Mission Control** (Tab, or `/cockpit <view>`) is full screen with seven views: `1` OVERVIEW (mission, status,
verdict reasons, turn milestones, problems, alerts, ownership), `2` AGENTS (every attempt: Enter expands routing
rules and signals, reasoning evidence, token breakdown incl. cache and reasoning tokens, cost basis, tools,
changes, gates, commit, sandbox census, worktree, prompt), `3` TIMELINE (the whole history, scrollable, Enter for
details, `f` filters by agent), `4` ROUTING (the fixed role policy and every decision with its rules, signals,
retries and escalations), `5` VERIFY (the five gates with their evidence and the DONE rules), `6` COSTS (session,
by model, by task), `?` KEYS.

Rendering is flicker-free: frames are written inside a synchronized-update block and only changed rows are
rewritten; a resize repaints once at the new size; nothing reaches the last column and autowrap is off while the
shell runs, so a frame can never wrap or scroll. Text from models, tools, file paths, test output and pastes is
stripped of every escape and control sequence (CSI, OSC, DCS, 8-bit C1) before it is shown, including sequences a
stream splits across chunks; only the HUD's own colour codes reach the terminal, and the terminal is restored
however the shell exits. Wide, medium (80–119 columns),
narrow (under 80) and very small terminals each get their own layout, down to 40×12. `NO_COLOR=1` draws no colour
(state pills keep their shape as `[READY]`), `COCKPIT_COLOR=none|16|256|truecolor` forces a mode, and
`COCKPIT_REDUCED_MOTION=1` turns off the spinner and waveform (the screen then changes only when state does, plus
a once-a-second clock while work runs). One 120 ms timer drives the screen; a frame with 2000 records and 5000
events renders in a few milliseconds, so the display never holds up the supervisor.

| Input | Effect |
|---|---|
| text, Enter | a supervised turn (Alt+Enter inserts a newline; ↑/↓ history) |
| `/swarm <goal>` | Kimi plans; Cockpit routes and admits every planned task |
| Tab · `/cockpit` | open or close Mission Control |
| `/cockpit overview\|agents\|timeline\|routing\|gates\|costs` | open that view; `/cockpit ready` and `/cockpit doctor` print their checks |
| Mission Control: ←/→, `1`–`6`, `?` · ↑/↓ or j/k · Enter/Space · PgUp/PgDn, Home/End · `f` · Esc | switch view · select · expand details · page · timeline agent filter · back |
| `/keys` · `/route <text>` · `/models` · `/diff` · `/new` | keyboard help · explain a route without running it · roles · branch diff · new conversation |
| Esc / `/cancel` | cancel the running turn (its sandbox is accounted for before ownership is released) |
| Ctrl+C | clear the input; on a running turn cancel it, twice to stop and quit; on an empty line quit |
| Ctrl+D / `/quit` | quit (a running turn is stopped first) |

**Why not inside the stock `cline` TUI.** Cline 3.0.74's terminal UI is OpenTUI compiled into the `cline` binary.
Its plugin API (`registerCommand`) can return a text reply or submit a prompt, but has no rendering surface for a
persistent HUD and no way to make typed turns run through Cockpit's routing, sandbox and gates; a HUD bolted onto an
unsupervised Cline session would be decorative. So the integrated experience is Cockpit's own terminal frontend over
supervised `cline` runs. The stock `cline` command and installation are left exactly as they are.

**Optional integration with the normal `cline` command: investigated, not built.** The only reversible hooks
into `cline` itself are a plugin command (text replies only, see above) or a shell alias/wrapper named `cline`.
A wrapper would also intercept every other tool that runs `cline`, including Cockpit itself (it finds `cline`
on `PATH`, so its sandboxed workers would start the wrapper instead of Cline), and it would change a command you
already rely on. So the interactive Cockpit stays a separate command, `cockpit-cline`. If you want one anyway, a personal
alias such as `alias clc=cockpit-cline` is reversible and touches nothing else.

`/new` opens the new conversation first and closes the old one only when none of its tasks holds ownership;
quitting mid-turn (Ctrl+D, a closed terminal) stops the running worker, and the next launch resumes the
conversation and accepts new turns.

## Recovery

| Failure (classified from the run's own error text) | What follows |
|---|---|
| provider 5xx/network, rate limit, resource exhaustion, a lost run | retry on the same model, bounded (2), exponential backoff with jitter; a provider circuit breaker delays further work on that model, never reroutes it; the retry waits out the breaker's cool-down and is its half-open try, so an open breaker never turns into a refusal |
| a correction attempt that hits a transient error | the retry keeps the correction's evidence (diff and gate output) |
| cancel while the gates run | the task ends cancelled before anything is committed or integrated |
| implementation (gates fail, claimed success without changes) | one correction on the same model with its diff and the gate output; then one escalation (MiMo for debugging, Kimi otherwise) told to diagnose first; then stop |
| authentication or billing refused | stop at once: sign in with `cline auth`, then `cockpit-cline recover` |
| budget, policy/sandbox/ownership refusal, model or reasoning mismatch | stop: a safety refusal stays a refusal |
| a pinned model missing from the catalog | the task is refused with the permitted routes; no checkpoint is switched |

Dependents wait while a dependency recovers and run once it has genuinely completed. Integrated work is never
redone after a restart (recovery finds an already-integrated commit by its task tag). Every attempt is bounded by
`limits.maxAttemptsPerTask` (4).

## Model roles (default profile `cline`, Cline billing)

| Role | Model id (verified in the installed catalog) | Reasoning requested → sent on the wire | Used for |
|---|---|---|---|
| coder (default) | `deepseek/deepseek-v4.1-flash-1017` (pinned: id and name must carry `1017`) | `xhigh` → `max` (catalog lists none/low/high/max; Cline sends max) | all implementation work by default |
| commander | `moonshotai/kimi-k3.1-pro` | `high` → `high` | planning substantial goals, architecture, critical review, escalation target |
| specialist | `xiaomi/mimo-v2.6-pro` | `high` → `reasoning_effort=high` (toggle-only model: shown as "thinking on, inferred") | non-trivial debugging, independent review, complexity 4+ engineering |
| frontend | `qwen/qwen3.8-max-0902` (pinned `0902`) | `xhigh` → `xhigh` | frontend/UI work, long-context tasks |
| utility | `zai/glm-5.3-flash` | `low` → `low` | low-risk read-only scouting, narrow low-risk docs edits |

No `1017 Fast` DeepSeek variant exists in either Cline catalog (checked 2026-11-05), so none is used; the alias
`~deepseek/deepseek-flash-latest` and other checkpoints are refused. Every spawn passes `--thinking` explicitly,
so a restart never falls back to the level last chosen in Cline's `/model`.

**ClinePass:** `--profile cline-pass` (or `COCKPIT_CLINE_PROFILE=cline-pass`) switches every role to the
`cline-pass/…` ids. ClinePass lists no version-pinned Qwen3.8 Max 0902, so in strict mode the frontend role is
refused there (frontend tasks fail closed, nothing is substituted) until you add
`"unpinnedAllowed": ["cline-pass/cline-pass/qwen3.8-max"]` to your config.

Your own overrides go in `~/.config/cobalt-cockpit-cline/config.json` (merged over `config/default.json`), or
`--config FILE`. Validation is strict: an unknown role or reasoning level is an error, not a default.

## Usage

```sh
cockpit-cline run --repo ~/code/app --gate test="npm test" "Fix the off-by-one in src/pager.ts"       # one coder task
cockpit-cline run --repo ~/code/app --swarm --gate test="npm test" --share node_modules "Parts: …"      # commander plans
cockpit-cline run --repo ~/code/app --plan tasks.json --gate typecheck="npm run typecheck"             # your own plan
cockpit-cline watch            # mission control for the latest mission (q quits, c then y cancels)
cockpit-cline status [MISSION] [--json] · list · replay [MISSION] · cancel MISSION [TASK…]
cockpit-cline recover [MISSION]                 # after a crash: reconcile by process identity, then continue
cockpit-cline recover --lost MISSION --repo DIR # the mission's state directory was deleted
cockpit-cline route --kind debug --complexity 3 --mode write --prompt "…"   # explain one routing decision
cockpit-cline smoke --yes [--roles coder,utility] [--max-usd 0.25]           # LIVE, spends credits
```

- Small goals go straight to one coder task; `--swarm`, architecture wording or three or more listed parts make
  the commander plan first. The commander proposes tasks; Cockpit validates the plan and picks every model.
- Work lands on the branch `cockpit/<mission>` in your repository, one commit per verified task, created with your
  own Git identity and no tool attribution. Your current branch, `main` and the working tree are never touched.
  Review the branch and merge it yourself.
- `--gate name=command` adds a required gate (repeatable). Without `--gate`, `package.json` scripts named
  typecheck, lint, test and build are used; with none at all the verdict is `UNVERIFIED`, never `DONE`.
- `--share node_modules` read-only-binds your checkout's dependency directory into gate sandboxes (gates run
  without network, in fresh worktrees that have no `node_modules` of their own).
- `--budget-usd N` sets the session cap; per-task caps are in the config.

## What a mission guarantees, and how

| Property | Mechanism | Test |
|---|---|---|
| Correct model per worker | deterministic rules (`src/router.ts`), every decision lists fired rules and rejected roles; Cline's reported model and the wire request are both compared with the route | `routing.spec.ts`, `integration.spec.ts` (wrong model version) |
| Reasoning never silently downgraded | capability check against the catalog; every wire request's effort is read from Cline's capture; strict mode fails a run whose effort cannot be confirmed | downgrade, no-capture tests; live smoke |
| Workers cannot write outside their task | bubblewrap: read-only root, writable worktree only, git dir read-only, secret dirs hidden, `/run/user/<uid>` hidden; PreToolUse hook refuses out-of-scope edits and dangerous commands; GIT gate re-checks the diff | adversarial tests |
| No uncontrolled spawning | native `spawn_agent`/`team_*` and agent launchers are refused; workers can only *request* work (`COCKPIT_REQUEST`), which goes through central admission with depth, child and queue limits | delegation tests |
| Cancellation is real | each worker is a pid namespace; ending it kills every process in it, detached ones included; ownership is released only after a process census of the namespace init and the attempt marker is clean | detached-children, cancel tests |
| Crash safety | `--die-with-parent`; claims live in the repository's git dir, so a restarted supervisor (or another mission) sees them; `recover` reconciles by identity; unknown status keeps the claim and blocks overlapping work | crash `kill -9` test |
| Cost is measured | Cline's per-request usage events (tokens, cache reads, reasoning tokens, reported cost); catalog pricing only for labelled estimates; no usage → `unmetered`, admissions stop, no DONE | budget, unmetered tests |
| DONE means verified | every task: GIT, SECURITY and your command gates pass, run by the supervisor after the worker ended; mission branch: final gates; ledger chain intact; costs metered | verdict assertions throughout |

## Evidence

Each mission keeps, under `~/.local/state/cobalt-cockpit-cline/missions/<id>/` (0700): `mission.json`,
`live.json`, `report.json`, the hash-chained `ledger/`, the paginated `archive/`, and per attempt `runs/<task>/<n>/`
with the exact argv, the policy, the JSONL stream, stderr, the hook log, Cline's wire captures (full request
bodies, kept as evidence; they contain your code and prompts, never credentials) and gate logs with SHA-256.

## Tests

```sh
scripts/test.sh            # offline: fake providers, real bubblewrap, real git, the real hook (≈ 90 s)
scripts/typecheck.sh       # TypeScript 5.9.3, strict
bin/cockpit-cline smoke --yes --max-usd 0.25   # live, opt-in, budget bounded
```

`COCKPIT_SCALE_N` sets the sequential-task scale test (default 2000).

## Limitations

Verified facts and known gaps, as of Cline 3.0.74 on Fedora, 2026-11-05:

1. **Linux only**, and it needs unprivileged user namespaces for bubblewrap.
2. **Network and loopback are shared.** Workers need the provider API, so they can reach the network and
   localhost services, including a running Cline hub daemon (`doctor` warns). The hook refuses `cline` and other
   agent launchers, but a determined model could talk to a local service directly. Stop local services you do
   not trust a worker with, or run missions on a machine without them.
3. **Cline's data directory (`~/.cline/data`) is writable inside the sandbox**: Cline needs it for its sessions
   and to refresh OAuth tokens. A worker can therefore read the Cline credentials it is already using.
4. **Evidence from inside a sandbox can be forged by an adversarial model**: the JSONL stream, wire captures and
   reported cost are written by processes in that sandbox. Gates, the GIT scope check and the census are done by
   the supervisor outside it; treat stream-derived figures as Cline-reported, not independently attested.
5. **The spending cap is not exact.** A worker is stopped as soon as a usage event crosses its budget, so one
   in-flight request can exceed it; the session cap stops admissions and, by default, cancels running workers.
   Admission reserves each running worker's remaining pre-spawn estimate. When Cline reports tokens but no cost
   (or a $0 cost for a priced model), the budget is enforced on the estimate from configured pricing and the
   verdict says the cost was estimated; with no pricing either, the worker is stopped as unmetered.
   The pre-spawn reservation is the role's configured worst case (`estimates` × pricing), not a forecast: with the
   default figures a Kimi plan reserves about $0.63 while real plans have cost about $0.05, so a session cap
   below $0.63 refuses `/swarm` before it starts (observed live with `--budget-usd 0.50`). Lower `estimates`
   only if you accept a larger possible overrun of a single request.
6. **Hook semantics**: a `PreToolUse` `cancel` aborts the whole Cline run (observed), so a policy violation ends
   the attempt. Hooks are a second layer; bubblewrap is the boundary.
7. **MiMo V2.6 Pro** is toggle-only in the catalog; Cline still sends `reasoning_effort`. Whether the provider
   honours a level for it is not observable, so the HUD says "inferred".
8. **Worker reuse** (`cline --id` resume) is not used: every attempt is a fresh process and worktree.
9. **Retention**: archives and ledgers are kept; nothing is deleted automatically, and claims are never dropped
   to save space. Worktrees under the state directory are kept for inspection.
10. The native `@cline/sdk` plugin route was assessed and not built (see `docs/architecture-audit.md`).
11. **Gates run code the worker may have written.** Their side effects are re-checked (scope, hooks, links,
    credentials) before anything is committed; new untracked files created only by the gates are treated as
    build artifacts and removed from the attempt's worktree. A change that touches what its gates are defined by
    (a file a gate runs, `package.json` scripts, test/lint/type configuration, or a deleted test) ends
    `UNVERIFIED`, not `DONE`: review it. The heuristic covers common conventions, not every ecosystem.
12. **Resuming a mission** (`recover`) uses the mission's own profile and strictness; any other difference in the
    effective configuration (budgets, a `--config` file, a Cline or package upgrade) is refused unless you pass
    `--accept-config-change`, which is recorded and keeps that mission from `DONE`.
13. **Lock takeover** after a crash renames the stale lock aside and verifies it; three contenders racing in the
    same instant can still both proceed (narrow, documented in `src/store.ts`).
14. A worker that is **held** (its processes could not be accounted for) keeps its slot, its claim and its
    reserved estimate until `recover` confirms it is gone; the mission ends `BLOCKED` instead of waiting.
15. **Conversation memory between turns** is Cockpit's bounded transcript (about 6 000 characters) plus the
    integrated code, not Cline's own message history: each turn is a fresh supervised `cline` run. Very long
    conversations lose their oldest turns from the model's context (they stay in the transcript file).
16. **Turn classification is rule-based** (keywords for questions, changes, debugging, UI, scouting, architecture).
    A message can land on a different role than you meant; `/route <text>` shows the decision first, and the
    transcript always names the role, model and rule for every turn. Only the turn's own text is classified and
    routed; the conversation and a commander's design are context the router never reads.
18. **Workers sometimes misuse the delegation marker.** Models have ended answers with `COCKPIT_REQUEST` and an
    empty list (now treated as no request) or with a duplicate request for work a sibling task already owns, in
    the wrong format. A malformed non-empty request is refused and recorded, and it keeps the mission from `DONE`
    (it may describe work that was not done): read the Guard line and the ledger's `delegation_refused` entry.
19. **Verdicts are per conversation, not per turn.** A failed or cancelled turn keeps the conversation's outcome
    `PARTIAL` for the rest of that conversation; `/new` starts a fresh one. Each turn's own result line is exact.
17. The interactive shell needs a real terminal (it refuses to start otherwise) and has been tested in
    pseudo-terminals at 160×46 and 72×24; it is a line-oriented UI, not a full editor (no mouse, no syntax
    highlighting).
20. **HUD text edge cases**:
    - bidi control characters in model text are not stripped;
    - ZWJ emoji sequences and flags are counted narrower than some terminals draw them, which can shift a row's
      right edge (autowrap stays off, so a row never wraps);
    - an Alt+key chord (Esc and a printable key in one read) is ignored rather than typed.
