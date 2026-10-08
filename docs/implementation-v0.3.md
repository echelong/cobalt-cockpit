# Cobalt Cockpit v0.3 implementation report

Starting SHA: `2008993` (Release Cobalt Cockpit 0.1.1). Plugin and marketplace version are now 0.3.0. The v0.2 and v0.3 changes remain in the working tree; the release commit is described at the end but was not pushed.

## Goal

Make reasoning effort dynamic and task-aware instead of fixed per tier, across the existing Opus 5.5 / Sonnet 5.5 / Haiku 5.5 architecture, without introducing Fable, JEV, OpenRouter, external inference routing or any new orchestration dependency. Preserve the v0.2 Elastic Swarm architecture.

## Three ideas kept apart

```text
REQUESTED   what the commander (or AUTO) asked for: a level, or AUTO
SELECTED    for AUTO, what the task facts imply; for a manual request, the level itself
APPLIED     what the model's capability actually allows, after a fallback
```

A requested level the model cannot honour is not pretended. The applied level is the closest supported one, the fallback is named (`EFFORT FALLBACK`), and requested and applied effort are recorded separately in the Run Ledger.

## Policy (`hooks/effort.ts`)

A pure module: arithmetic and naming over facts the commander, the task and the engine already reported. It never calls a model, never touches `$` and never sets a global setting. The one place effort is applied is `turn.step`, which rewrites a request's `effort` for a single turn, so two agents side by side can ask for different levels.

- **AUTO selection**: extractive (`inventory`, `extraction`, `classification`, `summary`) → low; `implementation`/`simpleTest` → low; normal engineering (`feature`, `bugfix`, `refactor`, `dependencyMap`, `inspection`, `triage`, `coordination`) → medium; `architecture`, `verification`, `investigation`, `recon`, ambiguity/uncertainty/coupling → high; `debug`, `security`, `concurrency`, `migration`, `integrationFailure`, high-risk architectural work → xhigh; `extraordinary` → max. A task that names no class uses its tier baseline (Haiku low, Sonnet medium, Opus high). A named class is capped at its tier's own ceiling.
- **Capability**: configured override > runtime observation > declared baseline. Declared: Opus `…xhigh,max`, Sonnet `…xhigh`, Haiku `…high`, unknown family the conservative common core `low|medium|high`. Nothing assumes `max` without an observation.
- **Observation**: the engine reports the level it really applied. Honoured (actual ≥ requested) adds the level; a downgrade removes it. Nothing is invented.
- **Resolution**: `chooseEffort` applies the operator ceiling first (so the reason names the ceiling rather than a capability), then clamps to capability, preserving `requested` exactly.
- **Escalation**: `escalationFor` moves one step — effort within the tier first, then Haiku → Sonnet → Opus — with a bounded budget and no jump to the top.

## Host wiring (`hooks/register.tsx`, `hooks/ledger.ts`, `hooks/swarm.ts`, `hooks/orchestra.ts`)

- `turn.step` builds facts from the task's role and mode, takes the commander's named level if present, otherwise AUTO (or the fixed level in MANUAL), and rewrites `model` and `effort` on the request. It records `resolution.selected` as the requested effort and the clamped level as applied, with `routingReason` and `fallbackReason`, and folds the applied level onto the swarm task via `setAppliedEffort`.
- `classic.PostToolUse` is the only place the engine's real applied level surfaces. It warns when the applied level differs from the recorded requested level and folds the fact into the per-model observation map. The comparison reads `requestedEffort`; this was corrected during implementation because `classicTelemetry` runs first and overwrites `effort` with the engine's level, which would otherwise make both the warning and the observation inert.
- The meter, the wide HUD (`model · effort`), the pane `REASONING` row, the swarm `EFFORT STEPS` row, the Run Ledger (`requested`/`applied`/`observed`) and `/cockpit version` (mode, ceiling, observed capability) all expose the policy.
- The composed system prompt appends `effortPolicyText`, and the `swarm` tool gained `effort` / `effort_reason` on assign and escalate.

## Configuration

New `userConfig` fields, both strings with declared options: `reasoningMode` (`AUTO` default, `MANUAL`) and `maxEffort` (`max` default, down to `low`). Operator-declared per-model capability (`modelEffort`) is parsed by the module but has no manifest field, because `userConfig` values are scalars or string lists; it remains an internal override.

## Tests and verification

New `tests/effort.test.ts` covers the pure policy (vocabulary, declared capability and observation, AUTO selection, ceiling and fallback, escalation). New `tests/effort-host.test.ts` covers the real hooks: AUTO levels reaching the engine, a commander-named level, the operator ceiling, MANUAL, capability fallback with the `EFFORT FALLBACK` warning and the observed map, `/cockpit version`, the HUD effort label, the pane `REASONING` row and the composed prompt.

| Gate | Exact command | Result |
| --- | --- | --- |
| Complete suite | `claude plugin test .` | PASS: 902 tests, 0 failures, 22 files |
| Typecheck | `tsc -p .` | PASS, exit 0 |
| Repository structural validation | `claude plugin validate --strict .` | PASS, exit 0 |
| Plugin contract validation | `claude plugin validate --strict .claude-plugin/plugin.json` | PASS |
| Marketplace validation | `claude plugin validate --strict .claude-plugin/marketplace.json` | PASS |
| Agent validation | `claude plugin validate --strict agents` | PASS |
| Public portability/credential audit | `python3 scripts/audit-public.py` | PASS; zero findings |
| Diff whitespace check | `git diff --check` | PASS, exit 0 |

## Live acceptance

The plugin was loaded from source with `claude --plugin-dir <repo>` (CLI 2.1.293) for two bounded, non-interactive turns:

1. Public defaults (orchestration off), `--model opus`: a real turn completed on `claude-opus-5-5`, exit 0, no stderr. This verifies the plugin loads and does not break a live turn.
2. Orchestration and dynamic reasoning enabled through a temporary `--settings` `pluginConfigs` file: the model confirmed its system context contained `Reasoning mode is AUTO` and quoted the exact sentence `The ceiling for any request is MAX; a higher request falls back and is recorded.`, exit 0. This verifies the `userConfig` fields parse, `prompt.compose` injects the policy and the orchestration/effort path is active in the real host.

## Installation state

The v0.3.0 tree was synced over the user-scope directory marketplace install (a 0.2.0 backup was taken first), its local marketplace identity `cobalt` preserved, and `claude plugin update cobalt-cockpit@cobalt` moved the installed plugin from 0.2.0 to 0.3.0. `claude plugin list` reports 0.3.0 read from that folder; `claude plugin details` reports the six agents (explorer, researcher, reviewer, scout, utility, worker).

## Known limitations

- Live per-tier subagent effort (Haiku low/high, Sonnet medium/high) was not exercised as live model runs. Subagent model/effort rewriting is verified through the real hook boundary in `tests/orchestration.test.ts`, `tests/effort-host.test.ts` and `tests/public-release.test.ts` with synthetic engine responses; the live acceptance exercises the main loop and the policy injection.
- Capability is learned only from what the engine reports it applied. A transient downgrade is treated as an unsupported level and removes it from the observed map, as documented.
- `modelEffort` has no manifest field; it can only be set programmatically or in tests.
- The v0.2 limitations on host stop APIs, wildcard serialization, macOS rendering and AUTO backpressure are unchanged.

## Files changed in v0.3 (relative to the v0.2 tree)

- `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — version 0.3.0, `reasoningMode` / `maxEffort` options, description.
- `CHANGELOG.md`, `README.md` — v0.3 notes, dynamic-reasoning section, configuration rows.
- `hooks/effort.ts` (new), `hooks/register.tsx`, `hooks/ledger.ts`, `hooks/swarm.ts`, `hooks/orchestra.ts`, `types/index.d.ts`.
- `tests/effort.test.ts` (new), `tests/effort-host.test.ts` (new), `tests/world.ts`.
- `scripts/audit-public.py` — expected version 0.3.0.
- `docs/implementation-v0.3.md` (this file).