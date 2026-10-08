# Changelog

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
- Documentation: `docs/implementation-v0.3.2.md` records the directory findings, what could not be reproduced locally, the external-behaviour inventory, and how to re-run the portal's validation.

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
