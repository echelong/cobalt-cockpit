# Cobalt Cockpit v0.2 implementation report

Starting SHA: `20089937e9024b0bdea70d26d030e8077ce81eea`. Ending HEAD: `20089937e9024b0bdea70d26d030e8077ce81eea`. Changes remain in the working tree; no commit, installation or publication was performed. Repository started clean. Plugin and marketplace version are now 0.2.0.

## Architecture

```text
                   Opus 5.5 High (one commander)
                 planning / architecture / integration
                       final verification
                         /          \
        Sonnet 5.5 Medium            Haiku 5.5
       bounded engineering           scouts / utility
                         \          /
                    structured handoffs
                  Haiku → Sonnet → Opus

Cobalt Cockpit: ownership → admission → waves → HUD → ledger → replay
NobodyWho: existing local Decision / Pruning / read-only control telemetry
```

The existing Claude Code hook architecture remains authoritative. No external provider, routing framework or orchestration dependency was added. Architectural responsibility stays with the main session. This implementation was performed by the supplied Codex runtime; it does not claim that the implementation session itself ran as Claude Opus.

Sonnet and Haiku have independently configurable resource budgets. AUTO currently provides 8 Sonnet, 16 Haiku and 16 total simultaneous subagents; explicit resource budgets support up to 128. Zero disables an individual pool. The former three-agent product ceiling is removed, while an explicit user budget of three remains supported. Small or coupled tasks stay in the commander. Scout and utility definitions select exact Haiku 5.5; request policy preserves that tier instead of converting it to Sonnet. Sonnet definitions request medium effort; Opus requests high; Haiku effort is unspecified.

## Ownership, routing and lifecycle

The `swarm` tool records task IDs, parent task/agent, assigned tier, semantic role, objective, scope, dependencies, read/write ownership, spawn reason, wave, state, cancellation intent, escalation, result and independent verification. Agent descriptions carry `[task:ID]`. Immutable state updates reserve resources and ownership before awaiting host spawn. Canonical path claims detect same-file, ancestor-directory and wildcard conflicts; ambiguous paths become exclusive wildcard scope. Reads may overlap reads. Scoped writers use explicit editing tools; arbitrary shell/custom effects require exclusive wildcard ownership. Main-session effects and pending admissions exclude each other across asynchronous work.

Routing uses semantic task facts and explicit commander discretion rather than keywords: architecture/ambiguity/high risk/integration or trivial coupled work stays in Opus; substantial bounded reasoning goes to Sonnet; extractive bounded utility work goes to Haiku. Duplicate equivalent work is suppressed. Dependencies block admission; failed siblings leave unrelated tasks running. Queue dispatch remains commander-controlled through Agent calls, preventing autonomous spawn loops.

All five execution waves are recorded. Structured escalation carries discoveries, evidence, unresolved question, risk, next action and locations. It retains active ownership until observed termination, then remains unresolved until commander `resolve` supplies integration evidence. Independent task verification stays separate from a subagent's checks and from mission verification gates.

Cancellation stops queued dispatch immediately. For active agents it suppresses subsequent model/tool actions and retains ownership until host termination is observed. Stalled work is observable and retains locks; positive terminal host status is reconciled on resume. Early completion before binding is reconciled without phantom running agents. Parent completion with unresolved children is recorded as failure and releases only the stopped parent's ownership. Running agents from older ledgers can receive explicit assignments through `adopt`; missing ownership is never guessed.

## HUD, Activity Field, ledger and replay

The existing Cockpit styling, crawler and spine remain. Pools above eight agents aggregate; active strip state is retained beyond 32 agents while completed visual history is bounded. The HUD shows waves, task completion, parallelism, queue, blockers, escalation, conflicts, per-tier activity and verification. Activity Field nodes aggregate by tier and state. Commander model labels derive from observed telemetry, including unknown.

Ledger schema two adds the task registry, bounded lifecycle events, requested versus observed agents, high-water concurrency, ownership, compressed results and verification. Schema-one records migrate without invented tasks or lost deltas. Park/resume and sanitized JSON export remain compatible. Storage pruning removes detail while preserving ownership/dependency skeletons. Metadata admission has a byte budget; tasks/events also have bounded retention. Costs, effective effort and unavailable token/context measurements remain unknown.

Replay combines original successful Edit/Write deltas with assignment, reservation, creation/adoption, wave, blocking, collision, completion, cancellation, escalation, resolution and verification events. Each lifecycle step explains why the task existed, its ownership, and the current disposition of its result.

NobodyWho adapter, authentication boundaries and existing model-block policy are unchanged. No decision/pruning execution or autonomous writing was added to NobodyWho.

## Tests and verification

New test files cover the pure state machine, presentation and real Claude Code hook integration. Existing model, ledger, orchestration, public defaults and host fixtures were updated for intentional schema/model/resource changes. Coverage includes multiple Sonnet/Haiku agents, mixed eight-agent requests, twenty Haiku tasks, routing/direct execution, dependencies, cycles, queueing, duplicate suppression, simultaneous writer collision, directory/wildcard aliases, parallel reads, cancellation/failure/stalls, structured escalation/resolution, commander authority, early completion, blocked children, shell editor-launch rejection, commander/spawn races, old/current parked resume, adoption, bounded storage, replay, aggregation and unknown telemetry.

Commands were executed from the repository. Long stdout used the existing `decision prune --caller codex -- bash -c` adapter; redirects preserved test/validation logs and exit status.

| Gate | Exact command | Result |
| --- | --- | --- |
| Complete relevant suite | `claude plugin test .` | PASS: 866 tests, 0 failures, 20 files |
| Typecheck | `tsc -p .` | PASS, exit 0 |
| Emitted TypeScript build | `tsc -p . --noEmit false --outDir /tmp/cobalt-cockpit-v0.2-build` | PASS, exit 0 |
| Repository structural lint/validation | `claude plugin validate --strict .` | PASS, exit 0 |
| Plugin contract validation | `claude plugin validate --strict .claude-plugin/plugin.json` | PASS, exit 0 |
| Agent validation | `claude plugin validate --strict agents` | PASS, exit 0 |
| Marketplace validation | `claude plugin validate --strict .claude-plugin/marketplace.json` | PASS, exit 0 |
| Public portability/credential audit | `python3 scripts/audit-public.py` | PASS; zero findings |
| Diff whitespace check | `git diff --check` | PASS, exit 0 |

Final diffs and new files were reviewed independently, then integrated fixes were checked by the commander. Native model IDs and tier preservation were verified through the host request boundary. Existing optional control boundaries were checked by diff and the complete suite. No new package manifest, network model client, external router or provider dependency was introduced. The repository has no separate ESLint/package lint command; strict host validation and the diff check are the available lint gates. The emitted build checks compilation; deployment packaging remains handled by Claude Code.

## Known limitations and remaining work

- Live account entitlement to the requested Claude 5.5 models and live model inference were not exercised. Host tests use synthetic model responses. A real authenticated session smoke test remains unverified.
- There is no host agent stop API. An already-running tool/request cannot be forcibly killed by Cockpit; cancellation intent waits for observed termination. Missing host state remains unknown and does not unlock work.
- Shell/custom tools use conservative wildcard serialization. If GNU `realpath -m` is unavailable, claims fall back to wildcard; this preserves safety but reduces concurrency. Physical macOS and live desktop rendering were not tested.
- AUTO provides resource defaults; Opus still selects useful work and dispatch. It is not an autonomous distributed scheduler. Histories and result detail remain bounded by documented budgets.
- Observation remains the public default. Set `orchestration: true` or the existing `cobaltStrict` preset to enforce admission/ownership/model policy.

No source implementation work remains. Live deployment/account smoke checks are the remaining environmental verification.

## Files changed (28)

- `.claude-plugin/marketplace.json`
- `.claude-plugin/plugin.json`
- `CHANGELOG.md`
- `README.md`
- `agents/explorer.md`
- `agents/researcher.md`
- `agents/reviewer.md`
- `agents/scout.md`
- `agents/utility.md`
- `agents/worker.md`
- `docs/implementation-v0.2.md`
- `hooks/field.ts`
- `hooks/ledger.ts`
- `hooks/model-policy.ts`
- `hooks/orchestra.ts`
- `hooks/register.tsx`
- `hooks/replay.ts`
- `hooks/swarm.ts`
- `scripts/audit-public.py`
- `tests/ledger.test.ts`
- `tests/orchestra.test.ts`
- `tests/orchestration.test.ts`
- `tests/public-release.test.ts`
- `tests/swarm-host.test.ts`
- `tests/swarm-presentation.test.ts`
- `tests/swarm.test.ts`
- `tests/world.ts`
- `types/index.d.ts`
