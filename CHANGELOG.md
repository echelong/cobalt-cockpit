# Changelog

## 0.5.1 — Discovery and decision quality

- Adaptive discovery: a deterministic LIGHT, STANDARD or DEEP level per task, from the prompt, the files edited and the existing consultation grounds. LIGHT work gets no added prompt text; STANDARD and DEEP get one short line, once per level. No new model call, router or consultation path.
- The progress tool gains `discover`, `decide` and `align`. Decisions are bounded records in the Run Ledger (alternatives, reasons, evidence, status), redacted before storage; older ledgers stay readable. `/ledger export decisions` prints them as Markdown. Nothing is written to a project.
- Completion integrity: a change to the implementation after the goal check (main session, helper, or any tool that changes the git working tree) returns the goal check to PENDING, clears the criterion evaluations and sets passed gates back to pending, even after DONE. Unknown criterion statuses are refused, the plan's goal is classified, a failed milestone clears the evidence, and `/cockpit discovery auto` never lowers a level. The fingerprint is of file contents against a commit (staging and committing change nothing), is settled into the task at once, and the goal check is refused over a tree that changed after the checks were observed. Coverage gaps (no git, ignored files, prompts from other origins, a model that never calls the progress tool) are listed in the README.
- Release-review budget: a mandatory release consultation no longer shares the three-per-task discretionary budget. It is tied to the full commit id of a clean working tree (unidentifiable candidates fail closed), is limited to one returned review and one retry per commit and six per session, is recorded in the plugin store across restarts, and is taken back when the commit or the tree changes. Discretionary consultations stay at three per task and are now also bounded at twelve per session.
- Original-goal check: a coding task above LIGHT stays UNVERIFIED until `align` reports ALIGNED. Explicit acceptance criteria are mandatory above LIGHT: without them alignment is BLOCKED (`CRITERIA / MISSING`) and DONE is refused; each criterion needs its own observation-naming evidence (basis `reported`), and edits, replans, revised criteria, failing gates or reopened unknowns make earlier evidence stale. It is a hold inside the existing progress model, beside the six gates and any mandatory Opus consultation, never in place of them.
- `/cockpit discovery` shows and pins the level for the session.
- Existing fixtures that exercise milestones and gates only now pin LIGHT; the shared test helper reports the goal check after the gates.
- Details, schema, measurements and limits: [docs/implementation-v0.5.1-discovery.md](docs/implementation-v0.5.1-discovery.md).

## 0.5.0 — Sonnet-led profile and session router

The session router:

- New `/cockpit router`: each session chooses `off` (the default in every new session), `nobodywho` (the local decision router, local provider only) or `jev` (the same router's TypeSafe JEV provider). The choice is session state and is never saved. One router is active at a time, and a switch discards what the previous one said.
- A router recommends one of five routes for a new task: handle it directly, scout with Haiku, delegate to Sonnet, consider a higher effort, or consider an Opus consultation. It starts, admits and approves nothing. The rules go first: when they settle the route no router is asked, and a recommendation for Opus is refused unless a consultation ground already holds, in which case you are shown a notice instead.
- Position-independent questions. The local classifier's first-option bias was traced to the router's seeded shuffle, which never reorders a two-option list, combined with early stopping. Cockpit now asks five fixed yes/no features, each in both orders, and discards a reading when fewer than four agree or more than three are affirmed.
- JEV is external: since the security audit it receives fixed-vocabulary keywords and a size bucket, never prompt text (NobodyWho, which stays on your machine, still sees up to 400 characters). A prompt in which credential-shaped text is recognised, including AWS ASIA key IDs, is not sent to either router. Orchestration free text and consultation packets are redacted before they are stored.
- Each decision is a bounded ledger record: provider, model, receipts, both latencies, the recommendation, and whether the rules accepted it. Router figures are never counted as model usage.
- Removed before release: the `localAdvice` option and the router call at Opus admission. Admission is by the rules alone.
- Measurements, limits and the live acceptance are in [docs/delivery-v0.5.0-router.md](docs/delivery-v0.5.0-router.md).

Found by independent review before release, and fixed:

- A mandatory Opus review could be discharged without an answer from Opus: by planning again, by a verdict on a consultation that never ran, by a consultation on a different ground, or by adopting another agent into it. A new plan now inherits the review, a verdict is accepted only once the architect has run and finished, only a consultation on one of the review's own grounds advances it, and adoption is refused for Opus tasks.
- The architecture ground no longer holds on the length of the main session's own plan, only on the files the host observed or the person's words.
- The Glob and Grep pattern refusal added for scoped helpers no longer applies to a helper that owns everything, as in 0.4.0.
- Suite: 1049 → 1098. What an upgrading user sees is in [docs/release-v0.5.0.md](docs/release-v0.5.0.md).

Release hardening:

- Fixed: the Opus architect could not read the files it was consulted about. A location written `path:line` became its owned resource verbatim. Line references are now dropped from the read scope, which is confined to project files. A consultation that names no file reads the project, not everything as before. A Glob or Grep pattern that is absolute, home-relative or climbs out is refused, and so is a `~` path.
- Fixed: admitted Opus consultations ran at Medium. They now request High, under the operator ceiling. The engine's applied level is recorded, and any difference is reported as a fallback. The main loop's effort is untouched.
- Progress: when the main loop edits a second file in a task with no plan, it gets one reminder, from that observed edit. `action: "gate"` takes several gates at once (`gates`), all or none. Listing the progress tool in the prompt was measured (+768 tokens a request, no more reporting) and not adopted.
- Root causes, measurements, the security review and the isolated live acceptance are in [docs/delivery-v0.5.0-hardening.md](docs/delivery-v0.5.0-hardening.md).

The Sonnet-led profile:

- New `profile` option. `OPUS_LED` (the default) keeps 0.4.0's models and admission. `SONNET_LED` means: Sonnet builds, Haiku scouts, Opus reviews. The main loop is requested on Sonnet 5.5 at the user's own effort, and Opus 5.5 runs only as an admitted, read-only `cobalt-cockpit:architect` consultation.
- Opus admission (`swarm action consult`): a ground that must hold on evidence (architecture, security, repeated failure, explicit request, release approval) and a bounded evidence packet. One Opus at a time; an unchanged problem is consulted once; one retry; three per task. Routes around it (an unassigned Opus or architect spawn, an OPUS assignment) are refused.
- Mandatory consultations: an explicit request for Opus, a release approval, or a change to security-sensitive files holds the task below 100% until the consultation returns and the main session verifies its advice.
- HUD and Ledger: role labels (MAIN, SCOUT, ENGINEER, ARCHITECT, LOCAL CONTROL), consultation records (ground, decision, verification, receipt), host-reported usage per tier, and the host's cost total. Nothing is estimated.
- `SONNET_LED` AUTO budgets: 4 helpers in all (2 Sonnet, 2 Haiku, 1 Opus).
- Suite: 995 → 1023 → 1049 with the hardening. Design, migration and rollback are in [docs/implementation-v0.5-sonnet-led.md](docs/implementation-v0.5-sonnet-led.md).

## 0.4.0 — Read-only helpers deliver their reports

- Fixed: a read-only helper could finish its work and have no way to report it. Claude Code delivers a background helper's report through its own hand-back tool (`SubagentHandback`) and reaches deferred tools through tool discovery (`ToolSearch`). Cockpit's read-only guard refused both, so a commander running v0.3.2 was told only that the helper "ended without delivering a report", and the commander's own tool discovery was held while any helper was active. A bound helper may now use those two host control tools, and the commander's discovery is no longer held.
- Nothing else widened. Neither tool has a resource effect. A read-only helper's write, shell command and delegation are still refused, a tool that discovery surfaces still passes its own ownership guard and Claude Code's permission check, and a hand-back records only the calling helper's own report.
- Each task now records how its report arrived, in `swarm status` and the Run Ledger: `reported` (the helper filed a structured result), `host_accepted` (the host accepted its hand-back), `answer_observed` (an ordinary final answer was observed) or `unavailable` (the host reported completion with no answer). A lost report is visible instead of silently absent. None of these states is verification; only the commander verifies.
- New host-hook tests hold the fix and its limits: discovery and hand-back delivery, concurrent read-only reports beside a failing sibling, no write consent from discovery, a preserved native rejection, completion racing inside the hand-back tool, a report kept across an interruption, and a host completion with no answer evidence. Suite: 987 → 995.
- Verified live on Claude Code 2.1.295 before release, with real Opus, Sonnet and Haiku sessions: interactive background helpers delivered through the hand-back tool (`host_accepted`); headless foreground and background helpers delivered as answers; two concurrent helpers both delivered; a read-only helper's Write and shell command were refused, and still refused after it used tool discovery; a cancelled helper ended `cancelled`. Details are in [docs/release-v0.4.0.md](docs/release-v0.4.0.md).
- No setting was added and no default changed. Saved preferences and Run Ledgers are kept on update.
- The optional memory and browser companion that was developed in this repository (commits `6700483` and `796171e`) has moved to its own repository, [echelong/cobalt-capabilities](https://github.com/echelong/cobalt-capabilities), with its own releases. This plugin's folder holds only Cockpit again, and Cockpit neither installs nor needs the companion.

## 0.3.2 — Directory compliance and fail-closed guards

- A hook that fails no longer lets an action through. The engine skips a hook that throws, times out or answers a wrong shape and runs what is beneath it, so every Cockpit hook that can refuse now carries a `.catch` handler that refuses in its place: the tool guard, the agent-offer and agent-spawn guards, the `/config` row guard, the `/model` and `/advisor` guards, the checkpoint commands and `/cockpit` itself. This closes a real fail-open in the blast-radius, ownership and Fable gates. Hooks that only observe still forward.
- Decided with the engine's own rule for each event: a guard that had already passed the call on leaves that result standing (`next.called`), and a handler judges the event it was given with the hook's own predicate, so a failure does not refuse a `/model opus`, an ordinary `/config` row, `/advisor off` or an ordinary agent type.
- `turn.step` cannot fail before it decides. A hook that throws before `next` is skipped, and this one's decisions are the Fable, subscription and strict-advisor refusals, so its two pre-decision readings (`taskOfAgent` and the ownership heartbeat) are wrapped in a new `quietly` helper. It carries no `.catch` handler: for a streaming event the handler must itself be a generator, which the engine's failure rule for is not verifiable here.
- An unescaped invisible character was removed from the hooks module: the Fable policy's character class and two test strings carried six format code points (U+00AD, U+200B, U+200F, U+2060, U+2064, U+FEFF) typed literally. They are written as escapes now, with the same meaning. No other file in the repository carries a format character.
- The name `next` is the pass-through parameter and nothing else: the preferences patch, an iterator step, a React key and the swarm accumulators that shared the name are renamed, so a reader or a scanner cannot mistake them for a pass-through.
- `tool.call` hands the engine its own event when the guards, the effort policy and the read-only shell rewrite changed nothing; the copy goes on only when something in it was changed. `agent.spawn` and `prompt.submit` write their one intentional change as an explicit branch instead of a ternary.
- `agent.offer` and `attribution.text` are block-bodied hooks with explicit answers.
- `scripts/audit-public.py` now refuses an unescaped format character in any shipped file, a pass-through named for something else in the hooks module, and any hook that can refuse without a `.catch` handler.
- 20 new tests (`tests/compliance.test.ts`) hold every handler, its fail-closed decision, the event it judges, and the pass-through rule above. Suite: 960 → 980. `claude plugin validate --strict --json` lists 18 gating hooks, every one with a handler.
- The listing icon is VECTOR's own portrait, rendered rather than redrawn: `scripts/make-icon.py` prints `mascotSvg` from `hooks/mascot.ts` and scales it whole, 36×, onto the page's void ground. 1024×1024, 8-bit RGB, 32,706 bytes, no text or profile chunks, byte-identical across runs. The manifest's `icon` field names it (kept out of the marketplace entry, where the validator reads that field as unknown). `scripts/audit-public.py` now checks it: square, 512–2048 px, under 2 MB, complete PNG, no metadata.
- Cockpit no longer has a hook on the permission check. The directory's two blocking findings, read from its own per-finding report on `main @ 310da52`, were neither of the two this release first guessed at. `MOD_PERMISSION_ANSWER_UNREAD` named the `tool.check` watcher, which returned the engine's verdict through a name after reading it to light the HUD's "Needs approval" state; the directory confirms a hook there only when its return is the pass-through itself. The watcher enforced nothing, so it is removed rather than rewritten, and no permission query replaces it. Every guard is where it was, in `tool.call`, `agent.spawn`, `agent.offer`, `config.set`, `prompt.submit` and `turn.step`.
- Changed: the HUD no longer shows QUERY, and a subagent row no longer reads "Needs approval", while Claude Code's own permission dialog is open. Questions put to you and Cockpit's own asks still do.
- `MOD_IMPORT_DYNAMIC_MISSING` named a type in `hooks/replay.ts` written as an `import` call, which the directory read as a file loaded while the mod runs. That type and three more like it (`hooks/field.ts`, `hooks/orchestra.ts`) are now named through each file's static `import type`. Types only: nothing loads differently.
- `scripts/audit-public.py` refuses an `import` call anywhere in the hooks, a `$.tool.check` query, and a `tool.check` hook that returns anything but `next(e)`. Seven tests hold that ordinary allowed calls cause no permission query and that a cancelled destructive command, a Fable route and an unowned write are still refused. Suite: 980 → 987; 17 gating hooks, each with a handler.
- Documentation: `docs/implementation-v0.3.2.md` records the directory findings, what could not be reproduced locally, the external-behaviour inventory, the icon's provenance, and how to re-run the portal's validation.

## 0.3.1 — Effort fidelity

- A subagent's reasoning level is now set natively, on its own Agent call's `effort` parameter (Claude Code 2.1.292 or newer), instead of by rewriting each request. It is per invocation, so parallel agents never share a setting, and the level the engine resolves is the one recorded as applied.
- Fixed: a requested HIGH could silently become MEDIUM. The engine's reported level describes the loop's own settings and does not include a `turn.step` rewrite, so it read MEDIUM for a request that carried HIGH; that report was taken for a downgrade, the level was dropped from the observed capability map, and later requests really were clamped. A report of a request this plugin rewrote is no longer recorded as applied, warned about or learned from.
- Fixed: a subagent's first request could arrive before its spawn was bound to its task and ran at the tier's baseline instead of the assigned level. The task is now found by the id its description carries.
- Fixed: the main Opus loop's effort was rewritten to HIGH on every request, over an explicit `/effort`, `--effort` or `CLAUDE_CODE_EFFORT_LEVEL`. Cockpit no longer writes the main loop's effort at all: the level the engine resolved is sent untouched and recorded as the engine's, with what was seen of its origin (the variable, a `/effort` of this session, the settings, or the host's own). AUTO, MANUAL, the `maxEffort` ceiling and subagent launches leave it alone, and `maxEffortLevel` caps it visibly, with both levels named.
- Changed: with no effort selected anywhere, the main loop now runs at Claude Code's own default for the model rather than a HIGH that Cockpit forced. That default was measured as MEDIUM for Opus 5.5 in an offline run of Claude Code 2.1.294 (an account's own default may differ); run `/effort high` once (it is saved) to keep the earlier level. `/cockpit version` names what AUTO would have chosen, as advice.
- The engine's own limits take precedence and are visible: `maxEffortLevel`, an organization's cap, `CLAUDE_CODE_EFFORT_LEVEL` and model support decide a subagent's final level, and a level resolved differently from the one asked for is named (`EFFORT FALLBACK`) with both levels.
- A level put on the Agent call by hand is respected as the task's requested level when the assignment names none; the assignment's own level and the operator ceiling still win.
- The Run Ledger distinguishes a level the engine resolved (`engine`, observed) from one this plugin requested by rewrite (`request`, observed unknown). `/cockpit version` names which of the two a subagent's level uses.
- An observation of a level above the requested one no longer marks the requested level as supported.

## 0.3.0 — Dynamic reasoning

- Task-aware reasoning effort: AUTO selects a level from the work, a commander can name one per assignment, and MANUAL honours fixed per-tier levels.
- Separate requested and applied effort, an operator `maxEffort` ceiling, and per-model capability fallback that is named (`EFFORT FALLBACK`) rather than hidden.
- Capability is learned only from the engine's own reported applied level; a downgrade removes the level, an honoured request adds it, and the observed map is persisted in plugin state.
- One-step escalation of a failing task: effort within the tier first, then Haiku → Sonnet → Opus, bounded by a budget and never a jump to the top.
- HUD and pane show the reasoning mode and applied effort; `/cockpit version` prints the loaded version, source path, reasoning mode, ceiling and observed capability.
- New `reasoningMode` and `maxEffort` configuration options.

## 0.2.0 — Elastic swarm

- Claude-native commander, Sonnet engineering pool and Haiku utility pool with independent resource budgets.
- Explicit task ownership, queueing, dependencies, waves, cancellation intent, structured handoffs and commander verification.
- Schema-two Run Ledger with schema-one migration, lifecycle replay and bounded tier aggregation.
- Preserve read-only NobodyWho telemetry, milestone gates and park/resume.

## 0.1.1 — First public release

- Cyberpunk HUD, VECTOR / Activity Field, milestones and verification-gated DONE.
- Main/subagent orchestration telemetry, radar, context and Git/activity tracking.
- Local Run Ledger and sanitized JSON export.
- Bounded replay and deterministic park/resume checkpoints.
- Blast-radius and repository-hygiene guards; graceful audio fallback.
- Hot reload persistence and engine image-view compatibility.
- Optional, read-only NobodyWho Decision and Pruning telemetry.
- Public observation defaults and opt-in strict Cobalt architecture.
- Portable synthetic fixtures, privacy documentation and preserved MIT notices.
