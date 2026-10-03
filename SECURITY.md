# Security and privacy

Cobalt Cockpit runs as a Claude Code mod with your user privileges. It may observe tool calls, file paths, agent events/descriptions, requested and observed model IDs, token/context telemetry, Git state, verification results and submitted task text. The dashboard makes no model calls or independent network requests.

## Local persistence

The host's plugin store holds sound/HUD preferences and up to eight bounded Run Ledgers. Ledgers include identifiers, tool/path metadata, counts, timings, model usage, sanitized NobodyWho receipts, successful bounded edit/write snapshots and deterministic checkpoints. Checkpoints can contain explicit task goals, milestone labels and blockers; treat the store as private. Task and HUD state also survive hot reload within the session. Cockpit does not control Claude Code's own transcript retention.

Replay omits known sensitive filenames, obvious credential patterns, unavailable files and content exceeding its size limits. It is a heuristic, not a universal secret detector. Hidden reasoning is never stored by Cockpit. Raw tool commands are not ledger fields. NobodyWho ledger access is read-only: prompt/state/details fields are discarded, caller filtering is applied and historical receipts do not count as current activity. NobodyWho is optional; missing files fail silently.

## Export and sharing

`/ledger export json` removes replay bodies, agent descriptions and checkpoint prose, then strips control sequences and detected secrets from string values. Paths, branch names, identifiers and repository metadata may remain sensitive. Review every export and screenshot before sharing. Secrets should never be exported. Do not put credentials in milestone labels, file names or configuration prose.

The plugin declares no MCP server, downloads no runtime code and changes no authentication environment variables. Authentication diagnostics retain only credential kind and known configuration source names, never credential values. Strict policy is opt-in and does not install or replace a subscription-only launcher.

## Guard limitations

Command safety and repository hygiene use recognizable syntax and user confirmation. They are not a sandbox or an exhaustive security boundary. Verification records observations and user/agent-reported evidence; it cannot guarantee code correctness. Keep Claude Code permission controls enabled.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository if available. Otherwise contact the repository maintainer through their GitHub profile to arrange a private channel. Do not post secrets, private ledgers or exploit details in a public issue. Include affected version, a minimal synthetic reproduction and expected impact.
