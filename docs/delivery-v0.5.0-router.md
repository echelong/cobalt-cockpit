# Delivery report: the session router (v0.5.0)

Status: implemented and verified on local `main`. This report covers the per-session router selector, the investigation and repair of NobodyWho's routing answers, and the optional JEV provider. It supersedes section 4 of [delivery-v0.5.0-hardening.md](delivery-v0.5.0-hardening.md): the `localAdvice` option described there never shipped and is removed.

## What was built

A session runs in one of three mutually exclusive router modes, chosen by the person with `/cockpit router` and held in session state:

| Mode | What runs | Where the task text goes |
| --- | --- | --- |
| `OFF` (every new session) | Nothing. Cockpit's deterministic policy only | Nowhere |
| `NOBODYWHO` | `decision ask --mode local`: the local decision router, local provider only | Stays on the machine |
| `JEV` | `decision ask --mode jev`: the same router's TypeSafe JEV provider | To the TypeSafe API, over HTTPS, under the operator's key |

`/cockpit router` with no word shows the mode and, in an interactive session, offers the three in the engine's own dialog. `/cockpit router off|nobodywho|jev` switches directly. Selecting a provider sends one fixed availability question that carries nothing of the session, so the state shown (`NOBODYWHO · LOCAL`, `JEV · CONNECTED`, `JEV · UNAVAILABLE (jev_disabled)`) is observed, not assumed. `/cockpit` and `/cockpit version` show the mode. Nothing is written to settings, to the plugin store's preferences or to any router configuration.

Code: `hooks/router.ts` (pure: modes, the question, what counts as an answer, the adjudication, the records) and three functions in `hooks/register.tsx` (`askRouter`, the only place a router process starts; `routeTask`; `selectRouter`).

## NobodyWho: root cause

The earlier evaluation found that the local classifier chose the first-listed option 87.5% of the time and looked stable while doing it. The cause is in two places.

1. **The models have a strong prior that is unrelated to the task.** The router's tier-1 specialist (a 0.6B fine-tuned option-token classifier) follows position on a two-way question, and on a five-way question answers one label ("delegate") for 52 of 56 tasks whatever the order.
2. **The router's own debiasing does not operate on short lists.** The provider shuffles the options per sample from fixed seeds (1234, 1235, 1236) and stops early when two samples agree. For a two-option question all three seeds produce the identity permutation, so every sample sees the caller's order, the first two agree, and sampling stops. The reported `sample_stability` of 0.67 to 1.0 is one biased draw counted twice. For three options, two of the three seeds are again identical.

The router is the operator's own infrastructure and is not changed here. The correction is on Cockpit's side of the interface.

## The corrected, position-independent format

A router is never shown a list it can pick a position from and be believed. Instead:

- **Fixed features, not routes.** Five yes/no questions about the task: security-sensitive, architectural, hard debugging, needs a broad search, has independent parts. The route follows from the features by a fixed priority (`routeOfFeatures`), in Cockpit, not in the model.
- **Both orders, always.** Each question is asked yes-first and no-first: ten requests, issued at the same time. A feature counts only when its two answers agree.
- **A validity floor.** If fewer than four of the five features agree across orders, the reading is position, not judgement, and is discarded whole.
- **A cap.** A reading that affirms more than three features is an answer to everything and is discarded. No measured reading from a working provider affirmed more than three.
- **Provider check.** An answer counts only with a receipt and only from the provider the mode names. NobodyWho mode never accepts a JEV answer, or the reverse.

No stability is manufactured by repeating one order: a provider that follows position fails the floor and deterministic policy decides.

## Evaluation

56 synthetic tasks, eight for each of seven kinds: trivial, ordinary, difficult, architectural, security-sensitive, discovery and independent-parts. The expected routes are direct, direct, effort, Opus, Opus, scout and delegate. In each kind four prompts use plain vocabulary and four are paraphrased to avoid obvious keywords. The cases were written before the lexical rules for the three new features. Every provider saw the same cases in the same request shape. Calls: 896 each for the two local models (including a five-rotation vote that helped neither and was dropped), 672 for JEV. No call failed.

| | Correct of 56 | Plain / paraphrased | Order sensitivity |
| --- | --- | --- | --- |
| Deterministic rules (`deterministicRoute`) | 45 (80%) | 28 / 17 | none |
| Tier-1 specialist, one 5-way question | 12 (21%) | 7 / 5 | label-bound |
| Tier-1 specialist, corrected format | 8 (14%) | 5 / 3 | 62% of feature pairs agree; 19 of 56 readings valid, the rest discarded |
| Qwen3 4B, one 5-way question | 43 (77%) | 23 / 20 | 20% change when the list is reversed |
| **Qwen3 4B, corrected format** | **49 (88%)** | 25 / 24 | 92% of feature pairs agree; 54 of 56 readings valid |
| JEV `jev-1.13.0`, one 5-way question | 52 (93%) | 28 / 24 | 2% change when reversed |
| **JEV, corrected format** | **51 (91%)** | 26 / 25 | 98% of feature pairs agree; 56 of 56 readings valid |

The corrected-format rows are the recorded answers replayed through the shipped `readAnswers`.

Confusion, corrected format (rows: task kind; columns: route read):

| Kind (expected) | Qwen3 4B | JEV |
| --- | --- | --- |
| trivial (direct) | direct 8 | direct 8 |
| ordinary (direct) | direct 8 | direct 6, delegate 2 |
| difficult (effort) | effort 8 | effort 6, Opus 2 |
| architectural (Opus) | Opus 8 | Opus 8 |
| security (Opus) | Opus 3, direct 2, scout 2, discarded 1 | Opus 8 |
| discovery (scout) | scout 6, Opus 1, discarded 1 | scout 7, Opus 1 |
| independent parts (delegate) | delegate 8 | delegate 8 |

Conclusions the data supports:

- The corrected format is a measured improvement for the plain local model: 43 to 49 correct, with position sensitivity removed by construction.
- The tier-1 specialist is not a usable router for this question in any format. NobodyWho mode therefore uses the router's plain local provider (`--mode local`), which is also what guarantees that mode never reaches JEV. Two thirds of the specialist's readings (37 of 56) fail the validity checks in any case.
- JEV is the more accurate reader, by a small margin on this set (51 against 49).
- Both useful providers are better than the lexical rules on paraphrased prompts (24 and 25 of 28 against 17) and no better on plain ones (25 and 26 against 28).

What it does not support: these are 56 synthetic prompts written by the author of the rules, on one machine. They do not establish accuracy on real work.

### As shipped: the rules go first

Cockpit's rules remain authoritative, so the router's reading is not the outcome. Replaying the same answers through the shipped `routeTask` logic and `adjudicate`:

| | Outcome correct | Router asked (rules named no route) | Accepted | Refused by the rules | Discarded |
| --- | --- | --- | --- | --- | --- |
| Rules alone | 45 | 0 | | | |
| NobodyWho (Qwen3 4B) | 47 | 27 | 20 | 6 | 1 |
| NobodyWho (tier-1 specialist) | 45 | 27 | 7 | 2 | 18 |
| JEV | 46 | 27 | 19 | 8 | 0 |

The automatic gain is small, and deliberately so. Most of what the routers add is "this is architectural or security-sensitive", and a router is not allowed to make an Opus consultation happen. Those readings are refused (6 for Qwen3 4B, 8 for JEV, every one of them a task that really was architectural or security-sensitive) and shown to the person as a notice. Saying "ask Opus" is then an explicit request, a ground the rules already honour. JEV's other additions were 5 routes, 3 correct; the two wrong ones recommended delegation for an ordinary task, which is advice the main session may ignore. The unreliable specialist changed no outcome.

## JEV

**Where it was switched off, and why it still is.** Two places on the operator's machine, neither changed:

1. The decision router's own configuration, `jev.enabled: false`: a hard switch. With it false the router never calls JEV in any mode. It is also the router's shipped default.
2. The shell wrappers that start agent sessions unset the TypeSafe key and endpoint variables, so no session or child process inherits them. This does not block the router, which reads its key from its own key file.

**How JEV mode reaches it.** The router has no per-request way to enable JEV. It does read its configuration directory from `DECISION_ROUTER_CONFIG_DIR`. The operator creates one directory holding a copy of the router configuration with JEV enabled and names it in the new `routerConfigDir` option. Cockpit passes that variable to the router's child process, and only for requests made while the session's router is JEV. Cockpit never creates, reads or edits router configuration, and the key never enters the plugin's process. Without `routerConfigDir`, JEV mode runs under the router's own switch and reports `UNAVAILABLE (jev_disabled)` when that is off. The global switch stays off, so no other caller on the machine can reach JEV.

**Measured.** 672 evaluation requests and 25 live ones through the approved configuration, all answered by `jev-1.13.0`, with no error and no timeout. A further 11 live requests without that configuration were refused by the router's own switch, as intended.

| | p50 | p95 | max |
| --- | --- | --- | --- |
| One request, as the router reports it (network included) | 246 ms | 297 ms | 536 ms |
| One request, wall time of the CLI process | 325 ms | 379 ms | |
| One reading (ten requests at once), by the session's clock, live | 418 to 510 ms | | |

The 16 ms figure sometimes quoted for JEV was not observed: a request took about fifteen times that from this machine. Each request reported about 380 input tokens and 40 output tokens of JEV usage; a reading is ten.

**Privacy boundary.** JEV is an external service. In JEV mode the request carries the first 400 characters of the prompt that starts a task and one fixed question. It carries no file content, no path Cockpit observed, no history and no credential, and a prompt containing credential-shaped text is not sent at all (recorded as a fallback with no receipt). The selection reply states this boundary each time JEV is chosen.

## Authority boundaries

A router's recommendation is judged by `adjudicate` against the rules. Accepting one starts nothing.

| A router cannot | Because |
| --- | --- |
| Start Opus | A recommendation for Opus is refused unless `groundsAvailable` already holds on evidence; admission is still `consultVerdict` with a ground and an evidence packet |
| Bypass a mandatory consultation | With a mandatory ground the router is not asked; any other recommendation is refused, and the review hold at 99% is unchanged |
| Change the main model or its effort | Nothing in the router path touches `turn.step`; the "effort" route is text that says the effort is the person's to set |
| Change permissions or ownership | The router path calls no tool, assigns nothing and holds no ownership |
| Spawn agents | A scout or worker it suggests still passes `assign` and the Agent admission hook |
| Override gates | It reads and writes no gate |

It is asked once, at the start of a task the rules do not settle. It is not asked for a prompt inside a task in progress, a tool call, a helper, or an Opus admission.

## Evidence

Each decision is one bounded record in the Run Ledger (`12 SESSION ROUTER`, the last sixteen) and in session state: the mode, the provider and model that really answered, up to four receipt ids, requests sent and answered, wall time by the session's clock and the provider's own latencies summed, how many features agreed, the recommendation, what the rules said, and whether the rules accepted it, refused it or it was discarded, with the reason. No prompt text is kept. No receipt is recorded for a request that did not run. Router figures are a separate section and are never counted as model requests or tokens.

## Switching

Tested in every direction (OFF to NobodyWho, NobodyWho to JEV, JEV to OFF, OFF to JEV, JEV to NobodyWho), in host-hook tests and in one live session. Each switch raises an epoch and clears the previous provider's tallies and last decision. A reading still in flight when the person switches is dropped: not recorded, not said. The main model and its effort are unaffected in both profiles.

## Live acceptance (isolated)

Claude Code 2.1.296, one Cockpit per session (the working tree, loaded inline, with the installed copy disabled for that process only), `cobaltStrict: true`, `profile: SONNET_LED`, Sonnet at medium. Router receipts are attributed by the session's working directory in the router's own ledger.

| Session | Observed |
| --- | --- |
| OFF, ordinary task | 0 router receipts; nothing router-related in the model's context; main `claude-sonnet-5-5` |
| NobodyWho | 11 receipts, all `local` / `nobodywho` (Qwen3 4B); reading 1,145 ms; "scout" accepted and given to the model as one line |
| JEV with `routerConfigDir` | 11 receipts, all `jev` / `jev-1.13.0`; reading 510 ms; "delegate" accepted |
| JEV without `routerConfigDir` | 11 requests refused by the router's own switch (`jev_disabled`); `JEV · UNAVAILABLE`; fallback recorded; the task completed under deterministic policy |
| All five switches | Label correct after each; only the four availability requests ran; none after OFF |
| JEV and a mandatory consultation | Router not asked about the task; architect `claude-opus-5-5` at `high`, verified `pass`; main stayed on Sonnet |
| JEV reads "security", no ground | Refused by the rules; operator notice shown; no Opus ran; nothing added to the model's context |

## Overhead

- **OFF:** none. No process, no request, no added text.
- **Context:** no tool schema is added. One sentence of the system prompt changed (about 40 tokens net). An accepted recommendation adds one line of about 45 tokens to the prompt that starts the task.
- **Time, per new task the rules do not settle:** about 1.1 s with NobodyWho (ten concurrent local requests; about 2.0 s if issued one after another), about 0.4 to 0.5 s with JEV. Selecting a provider costs one request (0.3 to 0.5 s; 1.85 s when the local model had to load).
- **JEV usage:** ten small requests per reading.

## Tests

`tests/router.test.ts`: 36 tests. Pure: modes and parsing; the baseline routes; what a router is shown, including clipping, non-tasks and credential withholding; the ten requests; answer parsing; position-following, yes-to-everything, wrong-provider, no-receipt and failed readings; every adjudication rule; records, labels and the ledger section. Through the real host hooks with a scripted router: OFF asks nothing; each mode's argument array and environment; the configuration directory reaching JEV calls only; the router's own refusal; the rules settling a task without a request; a router unable to cause Opus, lift a hold or start a helper; unreliable providers discarded; a credential prompt withheld; all switches; a reading dropped after a switch; the main model and effort unmoved; no re-routing inside a task; the dialog; the pane; nothing stored.

Six mutations each fail at least one test: the configuration directory given to non-JEV calls; the stale-reading check removed; Opus accepted without a ground; the rules-first short-circuit removed; the agreement floor at zero; the credential withhold removed.

## Limits

- The evaluation is small and synthetic, and the automatic gain over the rules is one or two tasks in 56.
- NobodyWho's quality is the quality of the router's local model. With a weak one most readings are discarded and the rules decide, which is safe but adds a second of latency for nothing.
- A reading costs ten requests. A two-request route question was as accurate for JEV, but the specialist passes its order check while being wrong, so it is not used.
- The router is consulted only at the start of a task. It does not reconsider as a task grows.
- In a headless single-prompt run there is no earlier message in which to select a router, so the mode is OFF unless several messages share the session.
- JEV sends a prompt excerpt to a third party. That is the operator's decision each session, and Cockpit says so each time.
