# Cobalt Cockpit v0.4.0 — release notes

Released 2026-10-09. Core plugin only: this repository's plugin folder holds Cockpit and nothing else.

## What changed

A read-only helper can now deliver its report. Claude Code 2.1.295 delivers a background helper's report through its own hand-back tool (`SubagentHandback`) and reaches deferred tools through tool discovery (`ToolSearch`). Cockpit v0.3.2's read-only guard refused both. The full change list is in [CHANGELOG.md](../CHANGELOG.md).

## How the defect looked on v0.3.2

Reproduced in a real orchestrated session on the installed v0.3.2 the same day: two read-only helpers (one Sonnet reviewer, one Haiku scout) did their work, and the commander received, for each, only "The subagent ended without delivering a report through SubagentHandback". The Sonnet helper's ledger entry read "The swarm guard refused all five attempts with 'read-only tasks may use inspection tools only…'". While either helper was active the commander's own tool discovery was held as an effect.

## What was verified for this release

All of it on Claude Code 2.1.295 with real model sessions (Opus 5.5 commander, Sonnet 5.5 and Haiku 5.5 helpers), using a disposable synthetic repository with planted facts and a commander forbidden to read files itself, so a fact in its report could only have come from a helper.

| Check | Observed |
|---|---|
| Interactive session, two concurrent background read-only helpers (Sonnet explorer, Haiku scout) | Both reports reached the commander through the hand-back tool; `swarm status` and the stored Run Ledger show `host_accepted` for both; the ledger pane shows `latest SubagentHandback TOOL` on each |
| Headless, foreground helpers (Sonnet, Haiku, two in one turn) | Every planted fact reached the commander in the Agent result; delivery `reported` or `answer_observed`; no permission denial |
| Headless, six background helpers | All six delivered in their task notifications; delivery `answer_observed` |
| Legitimate refused write | A read-mode task given to a worker-type agent: `Write` and a shell `touch` were refused by the read-only guard; no file was created |
| Discovery without escalation | The same helper's `ToolSearch` returned a schema; its next `Write` was still refused; it had no Agent tool |
| Helper reporting uncertainty | Asked for a fact the repository does not contain, the helper said so and listed what it checked |
| Cancelled helper | Ended `cancelled`; its later tool call was refused "cancellation requested"; no findings were attributed to it |
| Commander verification | `swarm verify` recorded pass only after the commander read the file itself; delivery state never implied verification |

Automated: 995 plugin tests, TypeScript against the host declarations, strict validation of the plugin, its manifests and its agents, the public audit, and the Git whitespace check. The hook modules are byte-identical to commit `796171e`, where the fix landed.

## Upgrading

```sh
claude plugin marketplace update cobalt-cockpit
claude plugin update cobalt-cockpit@cobalt-cockpit
```

Restart Claude Code and run `/cockpit version`. No setting was added and no default changed; preferences and saved Run Ledgers are kept. To go back, reinstall the earlier commit from a clone with `--plugin-dir`, or uninstall and install again once a later release exists; there is no earlier tagged release.

## Known limits

- How a report arrived is recorded, not judged: `answer_observed` means the host observed a final answer, including a cancelled helper's last words. Only `swarm verify` by the commander is verification.
- A helper that calls the swarm tool without an `action` gets a general refusal message rather than a description of the missing field. Its report still arrives through the host.
- Read-only helpers cannot run shell commands outside Cockpit's read-only allowlist, harmless ones included.
- Tokens and cost in `swarm status` remain unknown where the host does not report them.

## The optional companion

The memory and browser companion developed here earlier today now lives in [echelong/cobalt-capabilities](https://github.com/echelong/cobalt-capabilities) with its own releases. Cockpit does not install it, does not need it, and contains none of its code. Commits `6700483` and `796171e` in this repository's history carried an earlier build of it.

## Anthropic plugin directory

A v0.3.2 submission of this plugin is in review with Anthropic. The directory follows this repository's `main` branch and scans each pushed commit as a new version of that submission, so this release will be scanned too. Nothing was resubmitted, withdrawn or changed in the portal for this release, and a GitHub release is not directory approval.
