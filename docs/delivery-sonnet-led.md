# Delivery report: Sonnet-led profile

Status: implemented, verified, committed on local `main`. Not pushed, tagged, released or installed. The production plugin and operator configuration are untouched.

Design, migration and rollback: [implementation-v0.5-sonnet-led.md](implementation-v0.5-sonnet-led.md).

## Implementation decisions

1. **A profile, not a rewrite.** `profile: OPUS_LED | SONNET_LED`, default `OPUS_LED`. All 995 tests from 0.4.0 pass unchanged; `OPUS_LED` output is byte-identical.
2. **The main model comes from the engine's supported `turn.step` rewrite.** 0.4.0 already constrained every orchestrated main-loop request to Opus there, which overrode `/model sonnet`. `SONNET_LED` requests Sonnet the same way. Effort is never rewritten.
3. **Opus is a real native subagent.** It runs as `agents/architect.md` (Opus, `effort: high`, read-only tools, no Agent tool), spawned through the ordinary Agent tool. Admission happens before the spawn, with no label or simulated consultation.
4. **Admission is deterministic and lives in a pure module** (`hooks/consult.ts`). Grounds must hold on evidence from prompts, touched files and the failure streak. An unchanged problem is identified by its hash.
5. **Mandatory review is enforced through the task model**, not the prompt. `Task.review` holds progress at 99% and holds VERIFY milestones until the main session adjudicates the consultation.
6. **NobodyWho is advisory and calls the router's own CLI.** It never decides admission. Advice is recorded only with a receipt id.
7. **Opus counts toward the swarm budget.** `SwarmConfig.opus` adds an Opus pool inside the total. 0 keeps the legacy semantics, including for older ledgers.
8. **Usage comes only from what the host reports.** Per-request tokens are grouped by tier, `/ledger` shows the host's `/cost` total, and a request without figures is shown as unreported.

## Changed files

| File | Change |
| --- | --- |
| `hooks/consult.ts` (new) | Grounds, mandatory grounds, evidence packet, problem key, admission verdict, review requirement, architect brief, NobodyWho request/receipt parsing |
| `hooks/model-policy.ts` | `Profile`, `mainModel`, OPUS subagent tier, profile-aware `desiredRequest`/`policyMismatch` |
| `hooks/swarm.ts` | Opus pool (`opus`), `SONNET_LED_SWARM` budgets, OPUS binding when the pool is open |
| `hooks/model.ts` | Review hold in `percentOf`, status, VERIFY completion, summary |
| `hooks/register.tsx` | Profile config; `turn.step` main/Opus tiers; `agent.spawn` Opus admission and refusals; swarm `consult` action, OPUS-assign refusal, verify → adjudication; mandatory grounds from full prompts and edits; HUD/pane/ledger wiring; `/cockpit version` PROFILE line |
| `hooks/orchestra.ts` | `ARCHITECT` role; SONNET_LED system prompt; role-labelled HUD rows, consultation rows, observed usage |
| `hooks/ledger.ts` | `usageByTier`, `usageLine`, `observed by tier`, `host cost`, `11 OPUS CONSULTATIONS`, consultation export, packet pruning |
| `hooks/effort.ts` | Profile-aware effort policy text |
| `types/index.d.ts` | `Profile`, `ConsultGround`, `EvidencePacket`, `Consultation`, `LocalAdvice`, `ReviewRequirement`, `Task.review/promptGrounds`, `SwarmConfig.opus`, `Ledger.consults` |
| `agents/architect.md` (new) | The Opus consultant |
| `agents/*.md` | "Opus commander" → "the main session (the commander)" |
| `.claude-plugin/plugin.json` | `profile`, `localAdvice` options |
| `tests/sonnet-led.test.ts` (new) | 28 tests |
| README, SECURITY, PRIVACY, CHANGELOG, docs | Profile, new local process (`decision ask`), options, migration |

## Verification

| Gate | Command | Result |
| --- | --- | --- |
| Core suite | `claude plugin test .` | 1023 pass, 0 fail (995 legacy + 28 new) |
| Bypass mutations | Admission refusal disabled; review hold disabled | Each caught by a failing test, then restored |
| TypeScript | `tsc -p .` (typescript 5.9.3, host declarations) | exit 0 |
| Plugin validation | `claude plugin validate --strict` on ., plugin.json, marketplace.json, agents | passed |
| Public audit | `python3 scripts/audit-public.py` | 0 findings |
| Whitespace | `git diff --check` | clean |
| Host load | `claude --plugin-dir . -p '/cockpit version'` with `profile: SONNET_LED` | `PROFILE / SONNET_LED · main claude-sonnet-5-5 · Opus on admission · budget 4 (Sonnet 2 · Haiku 2 · Opus 1) · NobodyWho advice on` |

What the new tests cover: policy (main model per profile, Opus tier, untouched main effort); every ground, negation and the mandatory set; packet validation and bounds; duplicate, occupied, retry and task budgets; the Opus pool inside four helpers; receipt-only NobodyWho advice; the review hold at 99%, the held VERIFY milestone and reopening on a new ground; HUD labels with the legacy view unchanged; observed, unreported and unavailable usage; the ledger consultation section and pruning. Through the real host hooks: main requested on Sonnet (legacy on Opus); refusal of unassigned Opus, the architect spawned for nothing, OPUS assignment and an architect smuggled onto a Sonnet task; ordinary work refused a consultation that still finishes at 100% without a router call; a release consultation that is mandatory, admitted once, run on Opus, refused as OCCUPIED and then DUPLICATE, and finished only after `verify`; a security-file edit making review mandatory; a router answer without a receipt not reported as a decision; the four-helper budget.

## Live comparison (measured)

Six headless authenticated sessions (`claude -p --output-format json`), Claude Code 2.1.296. The dev plugin was loaded with `--plugin-dir` and the options `orchestration` + `cobaltStrict` + `profile`. Each run used a fresh copy of a scratch fixture repo (a small ESM library with node tests) and the user's own model efforts (Opus high, Sonnet medium from `modelSettings`). OPUS_LED ran `--model claude-opus-5-5`; SONNET_LED ran `--model claude-sonnet-5-5`. Every result was then checked independently: tests re-run and the diff inspected.

| Scenario | Profile | Correct (verified) | Turns | Tool calls | Wall time | Opus tokens out | Sonnet tokens out | Cost (host) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Small coding (`clamp` + tests) | OPUS_LED | yes: 8/8 tests, only the 2 allowed files | 32 | 30 | 65 s | 6,370 | 0 | $0.544 |
| | SONNET_LED | yes: 4/4 tests, only the 2 allowed files | 7 | 6 | 18 s | **0** | 1,639 | $0.120 |
| Difficult debug (2 root causes, one hidden) | OPUS_LED | yes: suite green, no test changed, both causes fixed | 34 | 32 | 62 s | 5,759 | 0 | $0.509 |
| | SONNET_LED | yes: suite green, no test changed, both causes fixed | 10 | 8 | 24 s | **0** | 2,182 | $0.158 |
| Release approval (correct answer NO-GO) | OPUS_LED | yes: NO-GO, both defects named, no files changed | 9 | 8 | 37 s | 3,337 | 0 | $0.323 |
| | SONNET_LED | yes: NO-GO, both defects named, no files changed | 8 | 24 | 79 s | 4,209 (architect) | 4,517 | $0.370 |

Totals for the three scenarios: OPUS_LED $1.376, 70 tool calls, 164 s. SONNET_LED $0.648, 38 tool calls, 121 s. Opus spend in SONNET_LED was $0.153, all of it in the one mandatory consultation.

Cost is the host's `total_cost_usd`, a cost equivalent on a subscription session. Token counts are the host's `modelUsage`. Turns and tool calls come from the session transcripts.

Observed behaviour:
- **No unnecessary Opus.** For the small coding and debug tasks, SONNET_LED made zero Opus requests and attempted no consultation.
- **Mandatory consultation happened and was not bypassed.** In the SONNET_LED release run, the main session planned a consultation milestone. `swarm consult` returned `OPUS ADMITTED … release · mandatory`. NobodyWho returned a real receipt advising `sonnet_continues`, which was recorded as advisory and correctly did not override the mandatory ground. The architect then ran on Opus. Sonnet verified the advice with its own evidence ("Confirmed: with numeric sort, percentile([10,9,2],50) returns 10 not 9 (node check)") and recorded `verify pass`. Only then did the task reach 100%. Bypass resistance itself is shown by the host-hook tests and the mutation check, not by this run.
- **Equal quality on this sample.** Both profiles fixed both bugs. The two fixes are equally correct but use different percentile conventions: Opus used `round(p·(n−1))`, Sonnet used nearest-rank `ceil(p·n)−1`. Both release reviews found the hidden second defect.
- **SONNET_LED skipped the progress tool on the two small tasks**; OPUS_LED used it 13–15 times each. Much of the turn and tool-call difference comes from this, so the HUD tracked those small Sonnet tasks less completely.
- **The SONNET_LED release run was slower in wall time** (79 s against 37 s), because the consultation added a full Opus subagent pass. The host's `duration_ms` (14.6 s) excludes the background architect, so wall time is reported here.

Limits of this measurement: one run per cell, one fixture, no repeated-failure, multi-file or security-edit live run (those paths are covered by host-hook tests only). It shows the mechanism works and the direction of the cost difference. **It does not establish a general percentage reduction.** Raw results stayed in the session scratchpad (`live/summary.json`, `live/tools.json`) and are not part of the repository.

## Unresolved limitations

- Ground detection is lexical (prompt phrases, path names). An architectural change described in unusual words is only caught by size or spread.
- Mandatory review cannot be waived by the model. If Opus is unavailable, the task stays UNVERIFIED and should be blocked with the reason.
- A readonly-planned task does not require its gates. In the release run a failing TEST reading did not block 100%. That is 0.4.0 behaviour, unchanged here, and the mandatory review still held.
- Delegation lesson from this milestone: a scoped writer cannot read files outside its owned resources, so a worker briefed to depend on types in an unowned file stopped without writing anything. Briefs must include those types, or ownership must list them as read resources.
- No user-level configuration was changed. To use the profile, set it yourself (see migration).

## Model-policy P1 investigation

Report: an ordinary session showed `MODEL POLICY / requested claude-sonnet-5-5 · medium; constrained to claude-opus-5-5 · effort unspecified`.

**Root cause.** That session loaded exactly one Cockpit, the installed production 0.4.0. 0.4.0 has no `profile` option. With `cobaltStrict: true` its `turn.step` hook rewrites every main-loop request to `MAIN_MODEL` (Opus). The host recorded it: every assistant message in that session came from `claude-opus-5-5` while the selected model was `sonnet`, and 0.4.0's own ledger holds the warning above. The rewrite carries the host's Sonnet level (`medium`) onto the Opus request. The development code was not loaded in that session.

**Precedence (development code, unchanged; now pinned by tests).** The profile names the main model. `cobaltStrict` turns orchestration on and adds safety restrictions (Fable block, subscription-only, no external advisor). It names no model.

| Options | Main model |
| --- | --- |
| `orchestration` or `cobaltStrict`, `profile` absent or `OPUS_LED` | Opus 5.5 |
| `orchestration` or `cobaltStrict` (or both), `profile: SONNET_LED` | Sonnet 5.5, at the host's effort |
| neither on (any `profile`) | the host's own choice, untouched |

An admitted consultation runs as a separate `cobalt-cockpit:architect` agent on Opus. The main loop's requests stay on Sonnet while it runs.

**Test isolation.** The earlier six-run benchmark loaded the development plugin with `--plugin-dir` beside the enabled production plugin, so two Cockpit policy hooks were active in those runs. A clean test session disables the installed copy for that process only:

```
claude -p … --plugin-dir <repo> \
  --settings '{"enabledPlugins":{"cobalt-cockpit@cobalt-cockpit":false},"pluginConfigs":{"cobalt-cockpit@inline":{"options":{"cobaltStrict":true,"profile":"SONNET_LED"}}}}'
```

The `init` event then lists a single `cobalt-cockpit@inline`. User settings are not modified.

**Live matrix** (Claude Code 2.1.296, one development Cockpit per session, model read from each assistant message the host streamed):

| # | Options | Session model / effort | Main ran on | Opus | Policy warning |
| --- | --- | --- | --- | --- | --- |
| 1 | strict, OPUS_LED | sonnet / default | Opus | main | yes (legacy, expected) |
| 2 | strict, SONNET_LED | sonnet / default | Sonnet medium | none | none |
| 3 | orchestration, strict off, SONNET_LED | sonnet / default | Sonnet medium | none | none |
| 4 | strict, SONNET_LED | sonnet / `--effort medium` | Sonnet medium | none | none |
| 4c | strict, SONNET_LED | sonnet / `--effort high` | Sonnet high | none | none |
| 4b | strict, SONNET_LED | opus / default | Sonnet | none | yes (moved to Sonnet) |
| 5 | strict, SONNET_LED, "Ask Opus to review…" | sonnet / medium | Sonnet (10 msgs) | 1 architect agent (4 msgs) | none |
| 6 | strict, SONNET_LED, ordinary coding | sonnet / medium | Sonnet | none | none |
| 7 | resume run 1 under SONNET_LED, then OPUS_LED | sonnet | Sonnet, then Opus | — | — |
| 8 | orchestration off | opus / sonnet | Opus / Sonnet (native) | — | none |

Deterministic tests: nine precedence cases through the real `turn.step` hook, plus one that holds the main loop on Sonnet at the host's effort while an admitted architect runs. A mutation that makes strict mode force `OPUS_LED` fails four of them.

Remaining for release hardening, found in these runs: a consultation location written `path:line` becomes the architect's owned resource verbatim, so the architect could not read the file (run 5, where Sonnet verified the advice independently); the architect ran at `medium`, not `high`; and in run 6 Sonnet still made no progress calls, because the progress tool is registered as deferred.

## Migration and rollback

Migration: keep orchestration on, set `profile` to `SONNET_LED`, choose `/effort` (medium recommended), optionally run `/autocompact 400k` while on Sonnet (already set on this machine), and restart. Rollback: set `profile` back to `OPUS_LED`, or remove it, and restart. Details and data compatibility are in [implementation-v0.5-sonnet-led.md](implementation-v0.5-sonnet-led.md).
