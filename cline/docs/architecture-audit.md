# Cobalt Cockpit for Cline: architecture audit, compatibility matrix and risk register

Stage A record for the `cline-adapter` branch, 2026-11-05. Base: `main` at `4e3b90a`. Installed host under test:
Cline CLI 3.0.74 (`@cline/sdk`, `@cline/core`, `@cline/agents`, `@cline/llms`, `@cline/shared` 0.2.0), Node 24,
bubblewrap, Fedora. Labels: **OBS** observed on this host, **DOC** upstream documentation, **SRC** read in the
installed package or upstream source, **INF** inference.

## 1. What the engine already is

The Claude Code plugin's behaviour lives in `hooks/register.tsx` (host bindings) and a set of pure modules that
take data and return data: `swarm.ts` (task admission, ownership overlap, dependencies, uncertain-spawn holds,
release on observed end), `guard.ts` (shell command risk), `effort.ts` (effort vocabulary and ranks),
`verification.ts` (evidence vocabulary, `SECURITY_ATTESTED` reserved), `secrets.ts` (credential patterns and
redaction), `router.ts` (lexical task features), `model-policy.ts` (Claude model ids per tier), `orchestra.ts`,
`ledger.ts` (the Claude run ledger and HUD rows). None of the pure modules imports the host. `model-policy.ts`,
`orchestra.ts` and `ledger.ts` are Claude-specific (model ids, tier names, HUD rows) and are not reused.

Decision (recorded with the Cockpit `decide` action): a facade, `cline/src/core/engine.ts`, imports those modules
unchanged; a 13-line Node resolve hook loads their extensionless imports. Nothing under `hooks/`, `tests/`,
`agents/`, `types/` or `.claude-plugin/` changes (`git diff --name-only 4e3b90a HEAD -- hooks tests agents types .claude-plugin` is empty).
Rejected: moving modules into a shared `core/` (changes the import graph `claude plugin validate` checks and every
test import, no gain); rewriting (the brief requires reuse).

## 2. How Cline is driven

| Interface | Finding | Source |
|---|---|---|
| `cline --json -P <provider> -m <model> --thinking <none…xhigh> -c <dir>` | one non-interactive run, JSONL on stdout, model and provider per process | OBS |
| JSONL events | `hook_event` (agent_start, tool_call, tool_result, agent_error, agent_end); `agent_event` with `usage` {inputTokens, outputTokens, cacheReadTokens, cost, totalCost, reasoningTokenCount}; `run_result` {finishReason, usage, aggregateUsage, model {id, provider}}; `run_aborted` | OBS |
| Cost | `totalCost` is Cline-reported; for GLM it matched catalog pricing within 0.6 % when input tokens include cache reads; for DeepSeek it differed from catalog pricing (provider-side pricing), so reported cost is the measured figure | OBS |
| `--thinking xhigh` on `deepseek/deepseek-v4.1-flash-1017` | wire body `"reasoning_effort":"max"` | OBS (wire capture) |
| `CLINE_CAPTURE_PROVIDER_REQUEST=full` + `CLINE_CAPTURE_WIRE=true` + `CLINE_CAPTURE_DIR` | writes every provider request body (no headers) | SRC, OBS |
| `--hooks-dir` with `PreToolUse.sh` | stdin JSON `preToolUse{toolName, parameters}`, `agent_id`, `sessionContext.rootSessionId`; `{"cancel":true}` aborts the whole run | OBS |
| Hub daemon | the CLI ran tools in-process inside bubblewrap (editor got EROFS on a read-only bind) even with the person's hub daemon running | OBS |
| Native `spawn_agent`, `team_*` | input schemas carry no provider or model: sub-agents inherit the parent's | OBS (tool schemas in the capture) |
| SDK plugins (`AgentPlugin`, hooks beforeRun…onEvent, `beforeTool` → `{skip}`) | per-session provider/model possible through `ClineCore` session manager (`agents-squad` example); hook errors default to `hookErrorMode: "ignore"` | DOC, SRC |
| Hooks and the model of a running session | `beforeModel` can change messages/tools/options; the docs do not describe changing the model of a run; not relied on | DOC |

### Why a supervisor and not a native plugin

A native `@cline/sdk` plugin (the `agents-squad` pattern) can start sessions with their own provider and model,
but every session shares one Node process: there is no per-worker filesystem sandbox, no per-worker process group
or pid namespace to kill, and hook failures are ignored by default. Those are the properties the brief makes
mandatory (OS enforcement, safe cancellation, detached children). The supervisor therefore runs one `cline`
process per worker inside its own bubblewrap sandbox. A native plugin remains a sensible future bridge for
*interactive* Cline: a tool that forwards a request into the supervisor's admission queue. It is not built.

## 3. Compatibility matrix

| Concern | Claude Code plugin (unchanged) | Cline adapter |
|---|---|---|
| Host | Claude Code function hooks | `cline` CLI 3.0.74 per worker |
| Models | Opus / Sonnet / Haiku | Kimi K3.1 Pro, DeepSeek V4.1 Flash 1017, MiMo V2.6 Pro, Qwen3.8 Max 0902, GLM 5.3 Flash (profiles `cline`, `cline-pass`) |
| Model choice | commander assigns a tier; engine suggests | deterministic router; commander only proposes task fields |
| Ownership | engine swarm, session-scoped claims | same engine swarm per mission + repository-scoped claim files in the git common dir |
| Isolation | in-session claims, host permission system | bubblewrap per worker, git worktree per write attempt |
| Hooks | `tool.call` etc., fail closed by `.catch` | `PreToolUse.sh` (abort on violation); not the boundary |
| Verification | gates reported to the HUD, Stop guard | supervisor-run GIT, SECURITY and command gates; DONE only if all pass and costs are metered |
| Cost | not measured (unknown) | Cline-reported per request; catalog estimates labelled |
| Persistence | `$.store` / `$.state` | atomic JSON, paginated archive, hash-chained ledger |
| HUD | Claude Code panel | `cockpit-cline watch` terminal screen |

## 4. The Claude lifecycle limitations, and what the adapter does about them

| Id | Limitation on Claude Code (from the P0.5 feasibility report) | Cline adapter |
|---|---|---|
| C1 | `/clear` drops session-scoped claims while a background agent keeps running; a replacement was admitted | Claims are not session-scoped: they are files in the repository's git dir, read by every supervisor and every mission under a lock. Tested: a second mission's overlapping task waits for the first mission's claim. |
| C2 | resume/fork under another session id, or a second process, sees other claims | Same: one claim namespace per repository; a second supervisor for a mission is refused by an identity-checked lock. Tested. |
| C3 | a deleted store reads as "no claims" | Every mission writes a marker in the git dir with its state path and epoch; a missing or replaced store makes new missions on that repository refuse until `recover --lost`, which retires claims only after a clean census. Tested. |
| C4 | claims never retired, a restart can revive finished work | A claim is retired when its attempt ends with a clean census and its outcome is recorded; restart reconciles open attempts by identity. Tested with `kill -9`. |
| C5/C6 | a deny or a resume is not proof of no-start | Not applicable as such: the supervisor itself starts the process and records an `uncertainSpawn` before dispatch; ownership is released only after the census. |
| C7 | bind race | Bind is the supervisor's own call after bubblewrap reports the init pid; the claim is held from before dispatch, so a race cannot release it. |
| C8 | ownership ended at `turn.complete` while escaped effects ran on (about 4.9 s measured) | Ownership is released only after the sandbox init (pid + start time) is reaped, which the kernel allows only once every process in the namespace has exited, and no process of the user carries the attempt marker. Tested with `setsid` children. |

## 5. Risk register

| # | Risk | Category | Likelihood / impact | Mitigation | Residual |
|---|---|---|---|---|---|
| R1 | Worker reaches loopback services (e.g. the Cline hub daemon) and runs work outside the sandbox | security | low / high | hook refuses agent launchers; `doctor` warns when a hub daemon runs; `/run/user/<uid>` hidden | **open**: no network namespace (API access needed); future: pasta/slirp with loopback isolation |
| R2 | Adversarial model forges stream, cost or wire captures inside its sandbox | security, data integrity | low / medium | supervisor runs gates, scope check and census itself; figures labelled Cline-reported | open, documented |
| R3 | Worker reads Cline credentials in `~/.cline/data` | security | medium / medium | required by Cline for token refresh; other secret dirs hidden | open, documented |
| R4 | Spending overshoots the cap by one in-flight request | cost | medium / low | per-request usage checked live; session cap stops admissions and cancels workers | documented: the cap is not claimed exact |
| R5 | Provider changes the wire mapping for xhigh, or model ids | compatibility | medium / high | every request's model and effort read from the wire; strict mode fails closed; `doctor` and `smoke` re-check | covered by tests and live smoke |
| R6 | Cline JSONL or hook protocol changes in a future version | compatibility | medium / high | stream folding counts unknown lines; missing run result → unknown outcome; hook failure cancels | re-run smoke after a Cline update |
| R7 | Integration conflict between parallel writers | concurrency | medium / low | overlapping owned paths serialized; integration serial; conflict aborts the pick and retries once on the new head | covered |
| R8 | Store growth | data integrity, performance | medium / low | live state holds only unfinished work; archive pages; no automatic deletion | retention policy is an owner decision |
| R9 | `/proc` census answer `unknown` (uninspectable processes during an attempt with no init identity) | edge cases | low / medium | claim held, overlapping work blocked, `recover` retries the census | fail closed by design |
| R10 | Gates in fresh worktrees lack dependencies | edge cases | high / low | `--share node_modules` read-only bind; gates run without network | person must pass `--share` |
| R11 | Claude plugin test runner picks up adapter tests | compatibility | was high | adapter tests are `*.spec.ts`; `claude plugin test` runs `*.test.ts` only | covered |

## 6. Test baseline

Before any change, on `main` at `4e3b90a` with the isolated gate runner (Claude Code 2.1.296, TypeScript 5.9.3,
gitleaks 8.30.1): strict validation of root, plugin.json, marketplace.json and agents passed; capability shape,
public audit, whitespace, host type check and secret scan passed. `claude plugin test .` ran 3148 tests: 3114 and
3115 passed with 34 and 33 failures in two runs, every failure a test over its 5 s budget (5.0–16.4 s) while
another session ran the same suite on this machine (load average 28–38 on 16 cores). The suite is known to have
tests above 4 s of its 5 s budget on a quiet machine. See the final gate record in the branch report for the
post-change runs.
