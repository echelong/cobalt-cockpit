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

## 6. Independent review

Six fresh-context, read-only reviews (Sonnet, high effort), each given the code and the stated invariants, not
the author's conclusions.

- **Round 1** (on `18c5ca1`): NOT CLEAN, 9 MATERIAL and 3 SHOULD-FIX findings: gate side effects committed
  unchecked; host git trusting worker-writable `.git` metadata (an fsmonitor command could run outside the
  sandbox); a held-after-end task allowing DONE; ownership leaked on a crash during verification; stop and cancel
  lost between admission and launch; polling without a verdict; silently dropped plan tasks; plans parsed from a
  4000-character excerpt; `recover` adopting a changed config; budgets not fail-closed without cost telemetry;
  delegation widening a parent's privileges; stale-lock TOCTOU. While writing their tests a further defect
  surfaced: the pid-namespace inode is reused by the kernel, so a lingering kill loop killed the next worker. All
  fixed in `4456dee` and `c84681a`, each with a regression test (`test/review.spec.ts`, `test/worker.spec.ts`).
- **Round 2** (on `c84681a`): 9 of 12 closed; 2 new MATERIAL defects introduced by the fixes (unmetered marking
  on any outcome stopped retries; recovery could re-run already-integrated work), 6 SHOULD-FIX and 4 NIT.
  Fixed in the following commit with tests: M1, M2, S1 (held slots now end the mission), S2 (late cancel applied
  once the sandbox identity is known), S3 (gate taint covers script bodies, configs, deleted tests), S4 (gate
  artifacts), S5 ($0 reported cost), N1 (real-path comparison of the worktree link), N2 (identity observer
  errors). Left documented: S6 (three-way lock race), N3 (config-diff message lists no keys), N4 (a held
  attempt's estimate stays reserved).
- **Round 3** (on `3d1106d`, the recovery engine and the interactive shell): 3 MATERIAL, 8 SHOULD-FIX and NITs.
  MATERIAL: an open provider breaker was treated as a refusal that could never clear, so a transient outage
  ended tasks instead of waiting (M1); a stop left from a shell that quit mid-turn bricked every later turn of the
  conversation (M2); a new run showed the previous run's verdict while it worked (M3). SHOULD-FIX: a timeout
  masked a policy refusal or wire downgrade (S4); a transient retry lost the correction's evidence (S5); `/new`
  released the old conversation before the new one existed (S6); conversations retired their repository marker
  after every turn (S7); routing read the conversation history and the commander's design, so planned work could
  land on the wrong role (S8, also seen live: a plain implementation task ran on Qwen); a cancel during the gates
  still integrated (S9); a no-change turn claiming success was accepted (S10); misleading PROGRESS and stale
  branch-gate labels (S11). All fixed in `4c21efc` with regression tests (`test/review3.spec.ts`); 13 of its 14
  tests fail on the pre-fix source and pass after (the 14th guards that a malformed request stays refused). The
  review found the truncated-capture parser sound and no path that runs Cline outside the supervisor.
- **Round 4** (on `960c4bd`, HUD 2.0): NOT ready, 3 MATERIAL and 9 SHOULD-FIX. MATERIAL:
  - model, tool, path, gate-output and pasted text reached the terminal unsanitized in several sinks, and C1
    control characters were not stripped;
  - a resize before the conversation opened crashed the shell;
  - the COSTS view showed unknown cost as `$0`.

  SHOULD-FIX:
  - a transient FAILED label while a finished worker was being classified;
  - failing gates outside TEST/TYPE/BUILD were invisible;
  - the spend split was derived from a partial record set;
  - emoji widths were miscounted;
  - the cursor drifted on tabs;
  - a first ledger read could be unbounded;
  - Mission Control swallowed typing silently;
  - a render error froze the screen;
  - events of out-of-view attempts were attributed to COCKPIT.

  All fixed in `3029ccc`, with regression tests in `test/hud.spec.ts` and `test/shell.spec.ts`. The fixes:
  - every row keeps only the HUD's own SGR;
  - escape sequences split across stream chunks are held and removed whole;
  - autowrap is off while the shell runs, and the terminal is restored on any exit;
  - unknown cost reads `—` and partial reporting reads `≥`;
  - an OTHER gate row appears for unmapped gates.

  The review found the DONE gating, read-only use of routing, claims and archive, the reasoning `✓` rule, frame
  geometry, key handling and the ledger-tail offsets sound.
- **Round 5** (fix verification of `3029ccc` and `88a9d13`, by code reading): 11 of the 12 round-4 findings
  were closed. M3 was only partly closed, and three new issues were found:
  - **M3 residue (MATERIAL):** unknown cost still read `$0` in three places: the HUD's BY MODEL line, the
    timeline's task-end event (the ledger's `task_ended.usd` sums unknown costs as 0) and the turn summary.
  - **SHOULD-FIX:** a bracketed paste split across reads was typed key by key, so a pasted newline could submit
    a turn.
  - **SHOULD-FIX:** Ctrl+D or a signal before the conversation opened threw after the terminal was restored.
  - **NIT:** text held behind an escape sequence that never completed was dropped at the end of a turn.

  All four are fixed, with regression tests:
  - unknown cost reads `—` and partial cost reads `≥` in every sink. The timeline counts reported attempts from
    their `worker_exited` charges; the ledger format is unchanged;
  - paste state is kept across reads, including an end marker split between reads;
  - `quit()` exits cleanly without a mission;
  - held text is flushed when a turn finishes.

  A sixth review, of that fix delta (`dc2a52c`), accepted it. It found one regression the paste fix had
  introduced: a paste whose end marker was lost kept every later key, including Ctrl+C and Ctrl+D, as text. Now
  Ctrl+C or Ctrl+D ends such a paste, and so does 2 s without paste data. A paste start marker split across
  reads is held, held stream text is cleared when a turn starts, and the early-quit test now proves it reached
  the early path. Each change has a test.

  The remaining NITs are recorded under limitations: bidi controls are not stripped, and ZWJ and flag emoji are
  counted too narrow. A ledger seek that lands exactly on a line start skips one entry.
- The reviews found sound: the census logic after the inode fix, the ledger hash chain, claim overlap
  normalisation, DeepSeek-never-substituted routing, bounded `nextStep`, wire judging, and that no stop or cancel
  path releases ownership without a clean census.

## 7. Test baseline

Before any change, on `main` at `4e3b90a` with the isolated gate runner (Claude Code 2.1.296, TypeScript 5.9.3,
gitleaks 8.30.1): strict validation of root, plugin.json, marketplace.json and agents passed; capability shape,
public audit, whitespace, host type check and secret scan passed. `claude plugin test .` ran 3148 tests: 3114 and
3115 passed with 34 and 33 failures in two runs, every failure a test over its 5 s budget (5.0–16.4 s) while
another session ran the same suite on this machine (load average 28–38 on 16 cores). The suite is known to have
tests above 4 s of its 5 s budget on a quiet machine. Re-run on a quiet machine (load about 1.5): `main` at
`4e3b90a` 3148 pass / 0 fail, and the branch at `c84681a` 3148 pass / 0 fail with every other gate passing; the
adapter's own tests are `*.spec.ts`, which `claude plugin test` does not collect.

## 8. Live evidence (Cline billing, 2026-11-05)

| Run | Result | Reported cost |
|---|---|---|
| `smoke --yes`, five roles, one request each | all PASS: DeepSeek 1017 xhigh→`max`, Kimi `high`, Qwen 0902 `xhigh`, GLM `low`, MiMo `reasoning_effort=high` (toggle, inferred on) | $0.0463 |
| single task, demo repo, gate `node test.js` | DONE, DeepSeek 1017, 56.9k in (43.3k cache) / 1.7k out / 357 reasoning tokens | $0.00685 |
| swarm, demo repo, three parts | first run PARTIAL: the GIT gate misread a modified tracked path (porcelain trim bug, fixed with a test); re-run DONE: Kimi plan, DeepSeek code, GLM docs, Kimi review | $0.0826, then $0.0946 |

| post-fix smoke (failed-mission analysis, truncated wire captures) | PASS | $0.00426 |
| interactive acceptance, real `cockpit-cline` shell in a pty, `--budget-usd 1.00` | DeepSeek t1, MiMo t2 (seeded rounding bug), Qwen t3 (page), GLM t4 (scout) all completed and integrated; Kimi `/swarm` planned two tasks, both integrated; Esc cancelled t6 at $0. Exposed S8 live (a planned implementation task ran on Qwen) and false delegation problems from empty `COCKPIT_REQUEST` lists; verdict PARTIAL | $0.5107 |
| re-check after `4c21efc`, `--budget-usd 0.50` | Ctrl+D mid-turn stopped t2; relaunch resumed and reconciled; new turn t3 completed (GLM); `/swarm` refused before spawn by the $0.63 commander reservation (fail-closed) | $0.00218 |
| swarm re-check after `4c21efc`, `--budget-usd 1.00` | Kimi plan; planned implementation task on DeepSeek 1017 xhigh→max (rule D), docs on GLM (U2); `FINISHED · VERIFIED`, no problems | $0.0637 |

| HUD 2.0 (`3029ccc`), real shell in a pty at 170×50, `--budget-usd 1.00` | DeepSeek 1017 (xhigh→max ✓) added `milesToKm` with a test; Kimi `/swarm` planned two tasks, DeepSeek (rule D) added temperature conversions and GLM (U2) wrote the README; every task gated and integrated, `FINISHED · VERIFIED`, no problems; quit and reopened at 96×32 with the conversation and timeline restored; frames and PNG screenshots in `acceptance/20261105T201244Z-hud2/` | $0.0489 |

The probes before the adapter existed (GLM write, DeepSeek wire capture with a cancelling hook, GLM in bubblewrap)
cost about $0.005 in total. All live runs together: $0.860 reported by Cline plus about $0.005 of probes. The
run artifacts (frames, ledgers, live state) are kept under `~/.local/state/cobalt-cockpit-cline/acceptance/`.
