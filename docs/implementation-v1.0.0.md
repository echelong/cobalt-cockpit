# Cobalt Cockpit v1.0.0 — release hardening and the 1.0 statement

**Status: released 2026-11-10.** v1.0.0 is a release-hardening and documentation release. It adds no feature, command,
option, network call or permission. It changes no hook, agent file, gate, DONE rule, ownership rule, storage format or
Cline adapter behavior. The complete observed gate table is in
[release-checklist-v1.0.0.md](release-checklist-v1.0.0.md); the GitHub Release for the annotated `v1.0.0` tag records
the same release identity and the remote results.

## What 1.0 means

**1.0 is stable observation + advisory evidence.** It is the first stable release of the Cockpit described in the
README. It is not a new capability, a security certification, an independent verification of work, or a promise that a
retrieval index improves an agent. The evidence and the limits are the ones the earlier documentation already states.

### The six gates and DONE rules are unchanged

CODE, TEST, TYPE, BUILD, SECURITY and GIT, the goal check and the conditions for DONE are exactly as
[verification.md](verification.md) describes. A DONE claim is still a task-completion status that says what it rests on
(`SELF_REPORTED_UNCHECKED`, `PROVISIONAL_CHECKED`, `UNCHANGED_UNCHECKED`, `PROVENANCE_UNKNOWN` or
`UNKNOWN_INVALIDATED`); it is not independent verification and not a security attestation. No label added here changes
gate eligibility, a Stop-guard verdict, `ALIGNED`, a release decision or what the Run Ledger stores.

### Ownership remains an admission rule within one session, not a lock

Task ownership decides what Cockpit admits next while its hooks run. It does not survive `/clear` or cross sessions, and
it does not stop a running agent. Cockpit provides no native fencing, effect drainage or verified termination. The
operational rule is unchanged: do not use `/clear`, switch sessions, or replace overlapping tasks while an agent is
running or ownership remains uncertain. Details and the observed host behavior: [orchestration.md](orchestration.md#what-task-ownership-does-and-does-not-guarantee).

### Diff-aware coverage and Cobalt Recall are advisory or research-only

`/cockpit coverage diff` remains opt-in and off by default. It reads a configured LCOV report and renders evidence; it
never runs a test, approves or blocks DONE, or changes a gate, review, release, ownership rule or permission.

The Cobalt Recall spike remains a fixture-only, permanently off module with no command, option, backend, corpus,
network call or runtime caller. Full integration remains **NO-GO** until the criteria in
[implementation-v0.9.0.md](implementation-v0.9.0.md#go-no-go-criteria-for-any-future-integration) are met and an explicit
human GO is recorded. The spike's existence is not evidence that retrieval helps.

### D12/D13 remain NO-GO

No general C1a ownership solution is implemented or claimed. Sweep stays off by default. A claim is not deleted solely
because an end event was reported. `OWNER_ATTESTED` is not proof of termination. The read-claim hardening from v0.8.0
remains in force: a reader is never widened to `*` unless the commander wrote `*`.

### The Claude Code plugin and the Cline adapter remain separate tracks

`cline/` is a separate program with its own security model, tests and release history. It is not loaded by the plugin,
is not part of the v1.0.0 artifact, and its results are not evidence for the plugin. No Cline behavior changed here.

## What changed in 1.0.0

- The plugin manifest, marketplace entry and public-audit assertion now read `1.0.0`.
- The README, documentation index, orchestration version line and release record state `1.0.0` consistently. Historical
  version references for 0.7.0, 0.8.0 and 0.9.0 remain historical and are not rewritten.
- Two stale labels were corrected: the v0.5 Sonnet-led page is no longer titled "unreleased", and the v0.5.3
  marketplace-submission page is marked as a historical record rather than a current publication state.
- [release-checklist-v1.0.0.md](release-checklist-v1.0.0.md) records the release identity, local gates, repository
  invariants, the D12/D13 NO-GO and the Cobalt Recall NO-GO.

## What did not change

No hook, agent definition, command, option, default, permission, guard, gate, DONE rule, ownership rule, storage key,
network path, dependency, Cline file or release rule changed. The six gates and their evidence labels are unchanged.
The only code file touched is `scripts/audit-public.py`, and its only change is the exact-version assertion from
`0.9.0` to `1.0.0`; no audit check was weakened.

## Release gates

The exact observed results are in the [release checklist](release-checklist-v1.0.0.md). They are: 3,192 plugin tests
pass on 83 files with 0 failures (139.52 s); strict validation passes on the plugin, `plugin.json`,
`marketplace.json` and `agents`; capability shape passes its 18/18 self-test with no findings in `hooks/`; the public
audit passes with 0 findings; `tsc -p .` passes on TypeScript 5.9.3. `scripts/typecheck-host.sh` REFUSED because the
installed host is 2.1.322 while the gate pins 2.1.296, so no host-version attestation is claimed. The secret scan is
clean in history and the working tree. Whitespace checks are clean.

Remote CI, commit-attribution and secret-scan results are required on the exact tagged SHA and are recorded on the
v1.0.0 GitHub Release after the push; this page does not claim a remote result before it is observed.

## Limits

1.0 is a stability and documentation statement, not a new verification mechanism. It does not resolve F01/A2, the
D12/D13 NO-GO, the ownership gaps around `/clear` or detached processes, or any measurement limit in
[SECURITY.md](../SECURITY.md#working-tree-measurement-limits). It does not make diff-aware coverage or Cobalt Recall
authoritative, and it does not change the fact that a passing command is evidence about the tree it ran on, not proof
that the work is correct.
