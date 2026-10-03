# Cobalt Cockpit v0.1.1

First public release of a live mission-control layer for Claude Code.

- Cyberpunk HUD and VECTOR / Activity Field with milestone progress.
- Main/subagent orchestration telemetry, radar, context and Git activity.
- Verification gates keep DONE tied to completed milestones and checks.
- Local Run Ledger with sanitized JSON export.
- Bounded replay of successful file deltas and park/resume checkpoints.
- Command safety, repository hygiene, optional sounds and hot reload persistence.
- Optional read-only NobodyWho telemetry, with Decision and Pruning kept separate.

Public defaults observe users' existing architecture. Strict Cobalt enforcement is explicitly opt-in. Requires Claude Code 2.1.287+; tested on 2.1.288.

Known limitations: redaction and command guards are heuristic; effective internal effort is unexposed; macOS coverage is simulated; Windows and claude.ai/Cowork are not supported/tested. Bundled synthesized WAV cues may require manual directory review. A hero image is still a placeholder. Portal validation and name availability require the published repository.
