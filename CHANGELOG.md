# Changelog

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
