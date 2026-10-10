# Delivery report: v0.5.0 release hardening

Status: implemented, verified and committed on local `main`. Not pushed, tagged, published or installed. The production plugin, operator settings, Cobalt Capabilities v0.1.1 and the pending directory submission are untouched. The version string is still 0.4.0 and is set at release.

This report covers four corrections to the Sonnet-led profile (`profile: SONNET_LED`) found in the [Sonnet-led delivery](delivery-sonnet-led.md) runs, an independent security review, and a clean live acceptance.

## 1. The Opus architect could not read its evidence

**Root cause: declared resource ownership.** The cause was not reference parsing, agent permissions or a host restriction. `swarm consult` canonicalized each packet location verbatim into the read-only OPUS task's owned resources, so `src/stats.js:8-12` became the owned path `<repo>/src/stats.js:8-12`. `ownershipAllows` matches a claim that equals an owned path or lies beneath it, so a `Read` of `<repo>/src/stats.js` was refused with `SWARM / read outside owned resources`. The isolated baseline run reproduced it: the owned resource was `…/src/stats.js:8-12`, and the architect's `Read` was refused.

**Fix** (`hooks/consult.ts`, `serveConsult` in `hooks/register.tsx`):
- `locationPath` drops a trailing line reference (`:8`, `:8-12`, `:8:3`, `:8-12:3`, `#L8`, `#L8-L12`), and `readScopeOf` dedupes. The brief keeps the locations verbatim as evidence.
- Only files inside the project root are owned. Locations outside it, home-relative (`~`) or containing glob characters are not readable, and the reply counts them.
- A packet that names no file is scoped to the project root. The old fallback, `*`, meant the whole filesystem and is removed. An unresolvable root refuses admission.
- Grep and Glob without a `path` search the working directory, and the guard now checks that directory instead of `*`. A task still needs to own the whole directory to use them.
- Following the security review: a Glob `pattern`, or a Grep `glob`, that is absolute, home-relative or climbs out with `..` is refused. A `~` path canonicalizes to `*`, so it is never treated as inside the project.

Ownership was not loosened globally. Every change narrows or makes exact what a task may read. The architect keeps its tool list (swarm, Read, Grep, Glob), no Agent, no Bash (shell needs owned `*`, which it can no longer get), and no writes.

## 2. The architect ran at Medium

**Root cause.** The consult task was submitted with no effort, so AUTO derived facts from its role: `ARCHITECT` in read mode maps to `inspection`, which selects **medium**. On engines with native effort, Cockpit puts that level on the Agent call, and it overrides the agent file's `effort: high`. The host's own subagent metadata for the baseline run recorded `"model":"claude-opus-5-5","effort":"medium"`.

**Fix.** An admitted consultation's task requests `high` (`CONSULT_EFFORT`). The level still passes through the operator ceiling (`maxEffort`) and the model's known capability. The engine's own resolution is read back and recorded as `appliedEffort`, and a difference is warned as `EFFORT FALLBACK / engine applied X; requested high`. The main loop's effort is never written, and Haiku and Sonnet helpers keep their own levels.

**Observed, final code (isolated live run):** the host's subagent metadata recorded `"model":"claude-opus-5-5","effort":"high"`. Cockpit's ledger recorded `requestedEffort high · launchEffort high · appliedEffort high`, with no fallback warning. The architect read `src/stats.js` and `test/stats.test.js` successfully, filed a structured result (`resultDelivery: reported`), and the main session verified it (`pass`). In the same run the main loop stayed on `claude-sonnet-5-5` at `medium`.

## 3. Progress tracking

**Hypothesis tested and rejected.** The earlier report blamed the tool's deferral. I measured it, with one Cockpit per session:

| | Deferred (host default) | `isDeferred: false` |
| --- | --- | --- |
| Loaded MCP tool schema per request | 611 tokens | 1.4k tokens (+768, the progress schema) |
| Runs in which the Sonnet main loop called progress | 3 of 7 | 0 of 7 |

Each column holds the same scenarios. Two runs in each column also had the first reminder wording described below. The three deferred runs that reported had already planned on their own.

Listing the tool cost 768 prompt tokens on every request and produced no progress reporting. The discipline section does reach the model (a probe quoted it verbatim). **Root cause:** Sonnet skips prompt-only guidance on its own judgement, even for a three-file task. The tool is left deferred.

**Fix: one reminder from a host observation.** When the main loop successfully edits a second distinct file in a task that has no plan, Cockpit adds one line of context beside that edit's result (about 60 tokens, once per task). The line says that the HUD shows no milestones and that the model should plan now. It sets no milestone, gate or percentage. A single-file fix, a planned task, a helper's edit and a failed edit never trigger it. The first wording ("…if it is trivial, ignore this") was delivered in 3 of 3 runs and ignored in 3 of 3. Without the escape clause, 3 of 3 runs planned. Each run completed its milestones and reported gates, and finished `DONE 100%` only after every gate was in.

**Fewer calls.** Most of the extra calls were one gate per call. `action: "gate"` now also takes `gates: [{gate, state, evidence}, …]`, and either all of them are recorded or none is. The progress schema grew from 768 to 913 tokens; it stays deferred, so this is paid only when the tool is loaded.

Unchanged, and covered by tests: a turn ending never completes a task; gates alone never finish a task whose milestones are open; with no milestones the HUD draws no percentage.

## 4. NobodyWho decision behaviour

**Interface.** `decision ask` (router mode `local-first`; JEV hard-disabled: "never called in any mode or environment"). Cockpit's call takes the tier-1 route, `local-jev-tev-specialist-v1` (f16, nobodywho 3.0.0, 3 samples at temperature 0.7 with fixed seeds, option-token grammar, no per-option logits). The output schema is `{request_id, mode, follow, decision: {provider, choice, abstain, confidence, votes, latency_ms, …}}`.

**Evaluation.** A balanced synthetic set of 12 trivial and 12 architectural problems, in Cockpit's exact request format. Grounds were spread evenly over both classes, so the ground label carries no class information. Four orderings were tested: Cockpit's order, reversed, neutral keys `option_a/option_b`, and neutral keys reversed. Every call returned a receipt from the local provider; none went to JEV. Raw results stayed in the session scratchpad and are not part of the repository.

| Route (as Cockpit calls it) | Calls | Picked the option listed first | Correct on decided calls | Repeats consistent | Median latency |
| --- | --- | --- | --- | --- | --- |
| tier-1 specialist (`local-first`) | 192 (2 repeats) | 168 / 192 (87.5%) | 112 / 192 (58%) | 96 / 96 | 371 ms (p90 512 ms) |
| Qwen3 4B (`--mode local`, for comparison) | 96 | 23 / 96 (prefers the second option) | 71 / 96 (74%) | — | 135 ms |

With neutral labels, the tier-1 specialist chose `option_a` in 94 of 96 calls, whatever the content. Swapping the order flipped its answer for 13 of 24 problems with Cockpit's keys and 23 of 24 with neutral keys. Its consistency across repeats comes from the fixed seeds, not from judgement. Neither local route distinguishes trivial from architectural work independently of option position. In the baseline live run it advised `sonnet_continues` on a *mandatory* consultation.

**Change (superseded before release).** The `localAdvice` option described in the next three points never shipped. It was replaced by the per-session router, which asks at the start of a task and never at admission; see [delivery-v0.5.0-router.md](delivery-v0.5.0-router.md). The measurements above stand.
- `localAdvice` is now **off by default**. Admission, mandatory consultations and their limits are decided by the deterministic rules alone.
- When someone turns it on, the router is asked only after the rules have admitted a **non-mandatory** consultation. It is asked twice, with the choices swapped. The advice is kept only if both receipts are distinct and name the same offered choice. Otherwise it is discarded, and both receipt ids are recorded with the reason (for example `order-sensitive: … discarded`).
- No classification result can admit, refuse or bypass a consultation. This was already true, and it is now tested from both sides.

No router, JEV path or paid inference was added.

## 5. Security review

An independent Sonnet reviewer, given the four corrections with an adversarial brief, found no critical or high issue and confirmed that `..`, symlinks, `/`, empty locations and an empty or `/` cwd all fail closed. Its findings and their disposition:

| Severity | Finding | Disposition |
| --- | --- | --- |
| Medium | A Glob `pattern` was never checked, and a no-path call now claims cwd, so `Glob{pattern:'/home/u/.ssh/*'}` could pass for a cwd-scoped task | Fixed: absolute, `~` and `..` patterns (and Grep `glob`) refused; tested |
| Medium | `~/…` canonicalized under cwd | Fixed: `~` resolves to `*`; tested |
| Low | Consult bounds checked on a ledger read before slow router and realpath calls | Fixed: verdict re-checked on a fresh ledger before recording |
| Low | One receipt returned twice would count as order-checked | Fixed: identical receipts are refused; tested |
| Low | `a.ts:8-12:3` not fully stripped; misleading "outside the project" for glob-character paths | Fixed; message reworded |
| Low | cwd captured at start | Not changed: `refreshGit` re-reads `session.cwd()` on every refresh |

A mutation that removes the new pattern and `~` guards fails a test. So do mutations that reintroduce verbatim locations (1 test) and drop the consultation's High request (3 tests).

## 6. Live acceptance (isolated)

Claude Code 2.1.296. Each run used a fresh copy of a small fixture repository with two seeded bugs (`mean` divides by n−1; `range` excludes its end). It loaded exactly one Cockpit (`--plugin-dir`, inline) with the installed copy disabled for that process only: `--settings '{"enabledPlugins":{"cobalt-cockpit@cobalt-cockpit":false},…}'`. The `init` event listed a single `cobalt-cockpit` in every run. Options were `cobaltStrict: true, profile: SONNET_LED`, with `--model sonnet --effort medium`. Models are read from each assistant message the host streamed; effort comes from the host's subagent metadata and Cockpit's ledger.

| Check | Observed (final code) |
| --- | --- |
| Sonnet 5.5 Medium main | Every main-loop message `claude-sonnet-5-5`; host-resolved `medium` |
| Opus 5.5 High on a genuine consultation | `claude-opus-5-5`, effort `high` (host metadata and ledger) |
| No Opus during ordinary work | Ordinary, delegated and substantial runs: zero Opus messages |
| Haiku scouting | `claude-haiku-5-5` scout, effort `low`, report delivered |
| Sonnet engineering delegation | `claude-sonnet-5-5` worker owning `src/range.js`, effort `low`, fix landed, report delivered |
| Opus read-only source inspection | `Read src/stats.js` ok, `Read test/stats.test.js` ok, whole-repo `Glob` refused (outside its scope) |
| Progress fidelity | Delegated, consultation and both substantial runs planned and finished `DONE 100%` only after gates; the single-file run correctly had no plan and no reminder |
| Agent handbacks | Architect `reported`, scout and worker `answer_observed`; Sonnet verified the architect's advice `pass` |

The baseline is HEAD `1f5aeb6` under the same isolation. Delegated and consultation runs are n=1 per cell; substantial runs are n=2 (figures are means). Cost is the host's `total_cost_usd`, an API-price equivalent: this account is on a subscription, so it is not a charge. Every run met its scoped goal: the targeted tests pass; the other seeded bug, out of scope for runs 1–3, still fails.

| Scenario | Baseline: cost · wall · turns · progress | Final: cost · wall · turns · progress |
| --- | --- | --- |
| Ordinary one-file fix | $0.123 · 21 s · 8 · none | $0.116 · 21 s · 6 · none (correct: trivial) |
| Haiku scout + Sonnet worker | $0.276 · 54 s · 6 · 7 calls | $0.279 · 54 s · 5 · 7 calls |
| Opus consultation | $0.292 · 58 s · 18 · 6 calls; architect **refused** its file, Opus **medium** | $0.323 · 69 s · 20 · 8 calls; architect **read** its files, Opus **high** |
| Substantial (median + tests + README) | $0.185 · 41 s · 14 · **0 of 2** planned | $0.216 · 51 s · 21 · **2 of 2** planned to DONE |

Opus share in the consultation runs: baseline 26.2k tokens in / 2.4k out ($0.104); final 26.9k in / 2.4k out ($0.104). Most of the consultation cost is Sonnet's main loop.

What this shows: the architect now reads its evidence at the requested level for about the same Opus cost. Reliable progress on substantial work costs roughly 7 more turns and $0.03 per task in this fixture. Ordinary work is unchanged. What it does not show: one small fixture and 1–2 runs per cell do not establish general percentages. The earlier six-run benchmark had two Cockpit policies loaded and is not used here.

## Gates

| Gate | Command | Result |
| --- | --- | --- |
| Core suite | `claude plugin test .` | 1049 pass, 0 fail (1023 before) |
| TypeScript | `tsc -p .` (typescript 5.7.2, host declarations) | exit 0 |
| Plugin validation | `claude plugin validate --strict` on `.`, `plugin.json`, `marketplace.json`, `agents/` | all passed |
| Public audit | `python3 scripts/audit-public.py` | 90 files, manifest/defaults/license checks passed, 0 portability/credential findings |
| Whitespace | `git diff --check` | clean |
| Live model/effort | Isolated runs above, one Cockpit each | Sonnet medium main; Opus high architect; Haiku low; Sonnet worker low |

## Remaining limitations

- Progress reporting is still the model's to make. The reminder is advisory: it moved 5 of 5 substantial runs here, but it is not enforced, and a task that edits only one file is never reminded.
- With `localAdvice` on, a consultation costs two local router calls (up to 20 s each) after admission. The measured classifier rarely survives the order check, so in practice it adds latency and no advice.
- Ground detection is still lexical (unchanged).
