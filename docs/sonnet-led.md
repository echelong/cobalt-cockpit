# The Sonnet-led profile

> Part of the [Cobalt Cockpit documentation](README.md). This text was moved here from the root README when the README was restructured for v0.6.0; the wording is unchanged unless a sentence says otherwise. Overview: [Swarm architecture](../README.md#swarm-architecture). Two sentences differ from the README they came from. A cross-reference that read "(below)" now links to [session-router.md](session-router.md). The sentence on the architect's identity is corrected: the README still said any agent type ending in `architect` passed the role check, which stopped being true with the v0.5.3 identity hardening; it now says what `hooks/orchestra.ts` and [SECURITY.md](../SECURITY.md#agent-identity-and-the-architect-role) say.

`profile: SONNET_LED` (with orchestration enforced): **Sonnet builds. Haiku scouts. Opus reviews. A router, if you select one, advises.**

- The main loop is requested on Sonnet 5.5 at your own effort (`/effort`, settings, `modelSettings`); Cockpit never rewrites that effort.
- Haiku scouts and Sonnet workers run as before. AUTO budgets are conservative: 4 helpers in all, 2 Sonnet, 2 Haiku and 1 Opus within them. Explicit `maxSubagents`/pool values still win.
- Opus 5.5 is never the main loop and never a background model. The main session requests it with `swarm action consult`: a ground (`architecture`, `security`, `repeated-failure`, `asked`, `release`) and a concise evidence packet (objective, architecture, files, alternatives, failures, risk, decision). Cockpit admits it only where the ground holds on evidence: a large or spread change, or architecture named in the prompt; security-sensitive files or a security prompt; the same failure three times in a row; an explicit request for Opus; a release approval. One Opus at a time, an unchanged problem consulted once, one retry after a failed run, and a budget in two separate parts: three discretionary consultations per task (twelve per session, so resetting the task gives no more) and, apart from them, a bounded release-review allowance. A release review is tied to one full commit id of a clean working tree: a returned review is the only one that commit gets, one retry follows an attempt that did not return, the allowance is six per session, and the record lives in the plugin store so a restart does not reset it. An unidentifiable commit (no repository, no commit, uncommitted changes, git silent) fails closed; the approval of one commit never covers another, and a new commit or a changed tree takes the approval back. The admitted consultation runs as `cobalt-cockpit:architect` (read-only, Opus, high effort) and returns a structured decision; Sonnet implements and verifies it. The architect role requires the exact agent type `cobalt-cockpit:architect`, and at spawn the host must attribute its definition to `provider.plugin: cobalt-cockpit`; another project's or plugin's `architect` suffix does not establish it. Cockpit forces the model and the read-only assignment. The host supplies only the provider's plugin name, not a signed source identity, so another installation also named `cobalt-cockpit` is not distinguished (see [SECURITY.md](../SECURITY.md#agent-identity-and-the-architect-role)).
- Opus cannot be reached around this: an unassigned Agent call naming Opus or the architect, an `assign` of tier OPUS, or the architect on a Sonnet task is refused.
- Mandatory consultations: an explicit request for Opus, a release approval, or a change to security-sensitive files (auth, secrets, credentials, permissions, policy, guards, `.env`, keys) holds the task below 100% until a consultation has returned and the main session has verified its advice with `swarm action verify` (pass or fail, with evidence). Review findings are advice until verified. That verdict is the main session's own report: on `main` (not yet released) it is shown as a commander report (`SELF_REPORTED_UNCHECKED`), never as a check Cockpit ran or a security attestation, and it lifts the hold under the same rule as before. A returned release consultation is a recorded response, not an approval: only a GO the main session confirms against the architect's own DECISION line (`release_outcome`) clears the release ground.
- No router is asked when Opus is admitted: admission is by the rules alone. The optional session router ([session-router.md](session-router.md)) is asked only at the start of a task and never decides admission.
- HUD and Ledger name the roles (MAIN, SCOUT, ENGINEER, ARCHITECT, LOCAL CONTROL), list each consultation with its ground, whether it returned, its decision and Sonnet's verification, and report host-reported tokens per tier. Requests without usage figures are counted as unreported; nothing is estimated. `/ledger` shows the host's `/cost` total where it keeps one.
- Context: set Sonnet's compaction window natively (`/autocompact 400k`, stored as `modelSettings["claude-sonnet-5-5"].autoCompactWindow`). Cockpit does not compact or change settings. Subagents keep their own model defaults.

`OPUS_LED` remains the default: Opus commands, as in 0.4.0, and nothing about models or admission changes unless you choose the other profile. What an upgrading user does see is listed in [docs/release-v0.5.0.md](release-v0.5.0.md). `cobaltStrict` turns orchestration on and adds safety restrictions; it never names a model, so strict mode with `SONNET_LED` keeps Sonnet as the main loop.

**Set up SONNET_LED** (keep your other options; CLI values are strings):

```sh
printf '%s\n' '{"orchestration":"true","profile":"SONNET_LED"}' | claude plugin configure cobalt-cockpit@cobalt-cockpit --values-stdin
```

Then choose the main effort yourself (`/effort medium` is recommended), optionally `/autocompact 400k` while on Sonnet, and restart Claude Code. `/cockpit version` shows `PROFILE / SONNET_LED · main claude-sonnet-5-5 · Opus on admission`.

**Roll back** to the previous behaviour by setting `profile` to `OPUS_LED` (or removing it) and restarting:

```sh
printf '%s\n' '{"profile":"OPUS_LED"}' | claude plugin configure cobalt-cockpit@cobalt-cockpit --values-stdin
```

Run Ledgers and preferences stay readable in both directions. Design, measurements and the v0.5.0 corrections are in [docs/implementation-v0.5-sonnet-led.md](implementation-v0.5-sonnet-led.md) and [docs/delivery-v0.5.0-hardening.md](delivery-v0.5.0-hardening.md).
