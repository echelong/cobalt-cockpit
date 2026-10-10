# Security and privacy

Cobalt Cockpit runs as a Claude Code mod with your user privileges. It may observe tool calls, file paths, agent events/descriptions, requested and observed model IDs, token/context telemetry, Git state, verification results and submitted task text. The dashboard makes no model calls or independent network requests.

## Local persistence

The host's plugin store holds sound/HUD preferences and up to eight bounded Run Ledgers. Ledgers include identifiers, tool/path metadata, counts, timings, model usage, sanitized NobodyWho receipts, successful bounded edit/write snapshots and deterministic checkpoints. Checkpoints can contain explicit task goals, milestone labels and blockers; treat the store as private. Task and HUD state also survive hot reload within the session. Cockpit does not control Claude Code's own transcript retention.

Replay omits known sensitive filenames, obvious credential patterns, unavailable files and content exceeding its size limits. It is a heuristic, not a universal secret detector. Hidden reasoning is never stored by Cockpit. Raw tool commands are not ledger fields. NobodyWho ledger access is read-only: prompt/state/details fields are discarded, caller filtering is applied and historical receipts do not count as current activity. NobodyWho is optional; missing files fail silently.

## Export and sharing

`/ledger export json` removes replay bodies, agent descriptions and checkpoint prose, then strips control sequences and detected secrets from string values. Paths, branch names, identifiers and repository metadata may remain sensitive. Review every export and screenshot before sharing. Secrets should never be exported. Do not put credentials in milestone labels, file names or configuration prose.

The plugin declares no MCP server, downloads no runtime code and changes no authentication environment variables. Authentication diagnostics retain only credential kind and known configuration source names, never credential values.

## Environment and process access

Cockpit reads environment variables by name and never writes one. Four of the names are its own configuration and runtime: `CLAUDE_CODE_EFFORT_LEVEL` (to name where the main loop's reasoning level came from), `XDG_STATE_HOME` and `HOME` (to resolve the optional decision-router ledger path), and `COBALT_REDUCED_MOTION` (to freeze animation). Eight are authentication variables, read only to decide whether the session is on API-style authentication, for the `subscriptionOnly` refusal and the `/cockpit auth` diagnostic: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` and `CLAUDE_CODE_USE_MANTLE`. Each value is reduced on the spot by `value !== undefined && value !== ''`; only the literal variable name reaches plugin state, and nothing is logged, exported or sent. `$.session.authorize()` answers the engine's own credential kind; the handle it returns is dropped immediately.

Cockpit runs local processes with the user's privileges: `realpath -m` (orchestration only), `tail -c` (a ledger tail larger than 512 KiB), `git status`/`git rev-parse` (the HUD), the audio cues through the first player that answers, and, only in the `SONNET_LED` profile with `localAdvice` on (off by default), `decision ask --caller cockpit --json <question>` twice, with the choices swapped, after the rules have admitted a non-mandatory Opus consultation (the local NobodyWho decision router, 20-second timeout each; its stdout is parsed for a receipt and nothing else). Every invocation is an argument array; no shell string is built from model or user text, and the one `sh -c` in the plugin is the fixed terminal-bell literal. There is no shell command from a hook, no MCP server command and no launcher, so nothing downloads or installs a package.

The plugin makes no network request of its own: no `$.http.fetch`, no model call, no MCP call, no dynamic import, no `eval`. Its `prompt.compose` and `prompt.submit` hooks contribute text to the model request Claude Code already sends, which is the only route by which observed state can reach a model.

## Hooks that refuse

A hook of Cockpit's that fails is not allowed to let an action through. The engine skips a hook that throws, times out or answers a wrong shape and runs what is beneath it, so every hook that can answer or refuse carries a `.catch` handler that answers in its place — the tool guard, the agent-offer and agent-spawn guards, the `/config` row guard, the `/model` and `/advisor` guards, the checkpoint commands and `/cockpit` itself; `turn.step` is the one exception, below. Each handler judges the event it was given with the hook's own rule, so a failure refuses what the hook would have refused and lets everything else run, and a prompt is dropped only where this plugin's own policy would drop it. `claude plugin validate --strict --json` reports each hook and whether it has a handler.

`turn.step` is the exception, and the reason is structural: for a streaming event the handler must itself be a generator. Its pre-decision readings are wrapped instead, so the hook reaches its Fable, subscription and strict-advisor decisions even when a reading beneath it does not answer. Hooks that only observe — `/init`, `/effort`, `/login`, `/logout`, post-tool readings — forward, because refusing a person's own action over a lost reading is not a guard.

Cockpit has no hook on Claude Code's permission check (`tool.check`) and asks no permission decision of its own. Its guards run earlier, in `tool.call`, and only ever refuse a call or put a question to you; nothing in the plugin approves one, so your permission rules, your permission mode and the engine's own dialog decide every call that Cockpit lets through.

## Helpers and their reports

With orchestration on, a bound helper may use two host control tools whatever its ownership: tool discovery (`ToolSearch`) and the report hand-back to its parent (`SubagentHandback`). Neither has a resource effect. Discovery grants no right to run what it finds: every tool still passes its own ownership guard and Claude Code's permission check, so a read-only helper's write, shell command and delegation are refused exactly as before. A hand-back records only the calling helper's own report. How a report arrived (`reported`, `host_accepted`, `answer_observed`, `unavailable`) is recorded on the task and is never verification; only the commander verifies.

## Guard limitations

Command safety and repository hygiene use recognizable syntax and user confirmation. They are not a sandbox or an exhaustive security boundary. Verification records observations and user/agent-reported evidence; it cannot guarantee code correctness. Keep Claude Code permission controls enabled.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository if available. Otherwise contact the repository maintainer through their GitHub profile to arrange a private channel. Do not post secrets, private ledgers or exploit details in a public issue. Include affected version, a minimal synthetic reproduction and expected impact.
