# Cobalt Cockpit v0.3.1 — Effort Fidelity

Starting SHA: `f48a016` (Release Cobalt Cockpit 0.2.0 + 0.3.0). Plugin and marketplace version are now 0.3.1.

## Goal

v0.3.0 chose a reasoning level per task, but a live run showed the level Claude Code reported for a subagent disagreeing with the level Cockpit asked for:

| Requested | Reported in the Run Ledger (v0.3.0) |
| --- | --- |
| Haiku low | unknown |
| Haiku high | medium |
| Sonnet medium | medium |
| Sonnet high | medium |

This release establishes which of those were wrong reports and which were wrong requests, fixes both, and makes the ledger say only what the engine can confirm. Orchestration, the swarm, NobodyWho telemetry, the HUD, the Run Ledger and replay are otherwise unchanged.

## What the engine does (Claude Code 2.1.294)

The effort path was traced in the engine and then measured on the wire. The measurement used a scripted local listener in place of the API, a throwaway configuration directory and a placeholder key, so no credential and no model was involved: the listener logs the `output_config.effort` each request really carries.

- A request's effort is resolved by one function from, in order: a `turn.step` hook's rewrite; `CLAUDE_CODE_EFFORT_LEVEL`; the loop's own level (for a subagent, the Agent call's `effort` parameter, else the agent definition's `effort` frontmatter); the session's level (`/effort`, `--effort`, `modelSettings.<model>.effortLevel`); the model's default. The result is clamped by `maxEffortLevel`, an organization's per-model cap and the model's support for `xhigh` and `max`.
- The Agent tool takes an `effort` parameter per call. It replaces the agent definition's frontmatter for that one subagent.
- `turn.step` hands a hook the level the engine resolved *without* a hook's rewrite. This is the same function the request is built with, so when no hook rewrites it, it is exactly what is sent.
- The level reported to hooks (`classic.PostToolUse` `effort.level`, and `CLAUDE_EFFORT`) is resolved from the loop's settings. A `turn.step` rewrite is not in it.

Measured, one subagent per row, no other plugin loaded:

| Subagent | How the level was set | On the wire | `turn.step` level | Reported level |
| --- | --- | --- | --- | --- |
| Sonnet, frontmatter `medium` | nothing | medium | medium | medium |
| Sonnet, frontmatter `medium` | Agent `effort: high` | high | high | high |
| Sonnet, frontmatter `medium` | Agent `effort: low` | low | low | low |
| Sonnet, frontmatter `medium` | `turn.step` rewrite to high | high | medium | medium |
| Haiku, no frontmatter | nothing | medium | medium | medium |
| Haiku, no frontmatter | Agent `effort: high` | high | high | high |
| Haiku, no frontmatter | Agent `effort: low` | low | low | low |
| Haiku, no frontmatter | `turn.step` rewrite to high | high | medium | medium |

Under `maxEffortLevel: medium`, Agent `effort: high` is sent as medium and reported as medium; a rewrite to high is also sent as medium, with nothing saying so. Under `CLAUDE_CODE_EFFORT_LEVEL=low`, Agent `effort: high` is sent as low and reported as low; a rewrite to high is sent as high, over the variable.

Both models take distinct levels. The rewrite reaches the wire but the engine never reports it, cannot be seen to be capped, and overrides the environment variable.

## Root cause

v0.3.0 applied every level by a `turn.step` rewrite and read `classic.PostToolUse` `effort.level` as "what the engine really applied". Three defects follow.

1. **A wrong report taken for a downgrade.** For a rewritten request the reported level is the loop's own (the agent frontmatter's `medium`, or Haiku's default `medium`), not what was sent. Haiku high and Sonnet high were sent at high and reported as medium.
2. **The wrong report then caused a real downgrade.** The reported level was folded into the observed capability map as evidence that the requested level is unsupported. `high` was removed for the model, and later requests were clamped to `medium` with the reason "high is not supported (observed)". The Sonnet high run in the table above ended this way: its first request went out at high and its later ones at medium.
3. **The first request of a subagent ran at the tier's baseline.** A subagent's first request can arrive before its spawn has returned and bound it to its task. With no task found, the rewrite used the tier baseline: a Haiku task named high was sent `low` first, a Sonnet task named high `medium` first. This was found by the end-to-end run below, not by the reports.

"Haiku low → unknown" was the absence of a report: that agent's only tool calls were to the swarm tool, which the plugin answers itself, so the engine issued no report, and nothing else recorded a level. The engine-resolved level is now recorded on every request, so it does not depend on a tool report arriving.

## Mechanism

**A subagent's level is set on its own Agent call.** In `tool.call`, for the commander's `Agent` call under orchestration, Cockpit resolves the level and writes it to the call's `effort` parameter:

- the level the assignment names, else a level the commander put on the call by hand, else AUTO's choice (the fixed tier level in MANUAL; nothing for Haiku in MANUAL);
- under the operator's `maxEffort` ceiling and the model's known capability, exactly as before.

The level is per invocation. Nothing global is set, so parallel agents cannot race on it. The agent definitions are unchanged and no variants were added: the parameter overrides the `effort` frontmatter for that subagent only.

**The engine's resolution is read, not fought.** For a subagent launched this way `turn.step` no longer rewrites the effort. It reads the level the engine resolved for the request and records that as applied. When it is not the level launched with — a cap, an override, a model sent no effort — the ledger names both levels (`EFFORT FALLBACK / engine applied medium; requested high`, and the same on the agent's row), and the model's observed capability is updated. The engine's caps and overrides therefore take precedence, visibly.

**The launch level is on the task before the subagent exists**, and a request from a subagent not yet bound to its task finds the task by the `[task:ID]` its description carries. The first request runs at the task's level.

**A report of a rewritten request is not an observation.** Each request records who put the effort on it: `host` when it carried the engine's own level, `hook` when this plugin rewrote it. For a `hook` loop the engine's reported level is not recorded as applied, not warned about and not learned from. This is noted before the request is sent, because a tool of that same response can report back before the request is in the ledger.

**The rewrite remains where there is no native setting**: the main loop, a subagent that no Agent call launched, and an engine older than 2.1.292. There the ledger shows the level as requested (`request`) and leaves observed unknown.

| Ledger row | Meaning |
| --- | --- |
| `high (engine) · observed high` | The engine resolved this level itself; it is what was sent. |
| `medium (engine) · observed medium · fallback the engine resolved medium …; requested high` | The engine resolved a different level than the one asked for. |
| `high (request) · observed unknown` | Cockpit put this level on the request by rewrite; the engine does not report it back. |

`/cockpit version` adds a `SUBAGENT EFFORT` line naming which of the two a subagent's level uses on this engine. The swarm `status` action reports `launchEffort` beside `appliedEffort`.

## Verification

### Requested versus observed, live

One bounded headless session on the subscription (Claude Code 2.1.294, this tree loaded with `--plugin-dir`, orchestration enabled through a temporary `--settings` layer, the user's own settings otherwise in force, including a persisted `modelSettings` level of `medium` for Sonnet). The commander assigned four read-only tasks and started four subagents; each read one file and reported. A second plugin that only records what the engine hands the hooks was loaded as an independent witness.

| Task | Model | Requested | Native configuration | Engine-resolved, every request | Engine-reported | Ledger | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Haiku low | `claude-haiku-5-5` | low | Agent `effort: low` | low, low, low | low | low (engine), observed low | completed |
| Haiku high | `claude-haiku-5-5` | high | Agent `effort: high` | high, high, high | high | high (engine), observed high | completed |
| Sonnet medium | `claude-sonnet-5-5` | medium | Agent `effort: medium` | medium, medium, medium | medium | medium (engine), observed medium | completed |
| Sonnet high | `claude-sonnet-5-5` | high | Agent `effort: high` | high, high, high | high | high (engine), observed high | completed |

No warning was recorded. The commander ran on `claude-opus-5-5` at high throughout.

### The real plugin in the real engine, scripted

The same four tasks plus an AUTO Haiku and an AUTO Sonnet task, driven by the scripted listener so the wire is visible:

- Default settings: wire, engine-resolved, engine-reported and ledger agree for all six (low, high, medium, high, AUTO → low, AUTO → medium), on every request including the first. Repeated on Claude Code 2.1.292 with the same result.
- `maxEffortLevel: medium`: the two high tasks are sent and recorded as medium, each with `the engine resolved medium …; requested high` and an `EFFORT FALLBACK` warning. The others are unchanged.
- `CLAUDE_CODE_EFFORT_LEVEL=low`: every subagent is sent and recorded as low; each task that asked for more carries the same named fallback.

A requested high therefore becomes medium only when the engine says so, and the ledger says so with it.

### Gates

| Gate | Exact command | Result |
| --- | --- | --- |
| Complete suite | `claude plugin test .` | PASS: 932 tests, 0 failures, 22 files |
| Typecheck | `tsc -p .` | PASS, exit 0 |
| Repository structural validation | `claude plugin validate --strict .` | PASS, exit 0 |
| Plugin contract validation | `claude plugin validate --strict .claude-plugin/plugin.json` | PASS |
| Marketplace validation | `claude plugin validate --strict .claude-plugin/marketplace.json` | PASS |
| Agent validation | `claude plugin validate --strict agents` | PASS |
| Public portability/credential audit | `python3 scripts/audit-public.py` | PASS; zero findings |
| Diff whitespace check | `git diff --check` | PASS, exit 0 |

### Tests

The suite grew from 902 to 932. Three tests in `tests/effort-host.test.ts` asserted the defect itself — a reported level lower than a rewritten request being warned about, learned from and clamped to — and were rewritten onto the native path, where the engine's level is a real observation. New coverage:

- each Agent call carrying its own level (Haiku low and high, Sonnet medium and high) and the engine's level being read rather than rewritten;
- an engine cap recorded with its reason and learned, and a model sent no effort recorded as none;
- a level put on the Agent call by hand, the assignment's level winning it, the ceiling, MANUAL, an unassigned call, and orchestration off;
- a subagent whose first request arrives before it is bound;
- the regression itself: a rewritten request reported as medium stays high, warns nothing and teaches nothing, including when the report arrives while the request is still answering, and for the main loop;
- the pure pieces in `tests/effort.test.ts`, `tests/ledger.test.ts` and `tests/swarm.test.ts`.

## Known limitations

- The engine does not expose the effort a request was finally sent with. For a level the engine resolved itself, the level it hands `turn.step` is the same resolution the request is built from, and that is what is recorded; it was confirmed against the wire here, but it is the engine's statement, not a receipt from the API.
- The main loop's level is still applied by a `turn.step` rewrite, since there is no per-request native setting for it. That rewrite overrides `CLAUDE_CODE_EFFORT_LEVEL` and a session `/effort`, is still clamped by `maxEffortLevel` with nothing saying so, and is never confirmed by the engine. The ledger shows it as requested with observed unknown. When the session's own level already equals the policy's, nothing is rewritten and the level is the engine's own.
- The same holds for a subagent on an engine older than 2.1.292 and for one that no Agent call launched (a plugin's `$.agent.spawn`, a workflow's agent).
- The native path was measured on 2.1.292 and 2.1.294. An engine that drops or renames the Agent call's `effort` parameter would resolve the agent's own level instead; that shows as a named fallback, not as a silent difference.
- A level the engine caps or overrides is learned as unsupported for that model for the rest of the session. Lifting the cap mid-session is not noticed until the next session.
- The effort of a subagent that is already running is fixed by its launch. An effort escalation applies to the next launch.
- The v0.2 and v0.3 limitations on host stop APIs, wildcard serialization, macOS rendering, AUTO backpressure and `modelEffort` are unchanged.

## Changed files

- `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `scripts/audit-public.py` — version 0.3.1.
- `hooks/register.tsx` — the Agent call's native level, the launch bound to its task, the early-request task lookup, `turn.step` reading the engine's level, the effort channel, the gated report handling, the diagnostics line.
- `hooks/effort.ts` — `launchFallback`, exact capability observation, the policy sentence.
- `hooks/ledger.ts`, `hooks/swarm.ts`, `hooks/orchestra.ts`, `types/index.d.ts` — the effort channel and observed level on a request, `launchEffort` on a task, one prompt sentence.
- `tests/effort-host.test.ts`, `tests/effort.test.ts`, `tests/ledger.test.ts`, `tests/swarm.test.ts`.
- `README.md`, `CHANGELOG.md`, `docs/implementation-v0.3.1.md`.
