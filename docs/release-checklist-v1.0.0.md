# v1.0.0 release checklist

This checklist records the gates for the v1.0.0 release. Local results were observed on the working tree that becomes
the release commit. A commit cannot contain its own SHA, so the exact release commit is the target of the annotated
`v1.0.0` tag; its full SHA is recorded in the tag message and in the GitHub Release for that tag. The baseline before
the release changes is `7e8f3ae6513e666e4c4995bbea2602ed24c4ac59`.

## Release identity

| Item | Value |
| --- | --- |
| Baseline `main` | `7e8f3ae6513e666e4c4995bbea2602ed24c4ac59` |
| Release commit | The commit that carries this checklist; exact full SHA is the target of `v1.0.0^{}` and is recorded in the annotated tag message and the GitHub Release |
| Release tag | Annotated `v1.0.0` |
| Plugin version | `1.0.0` in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` |
| Branch | `main` only |
| Release date | 2026-11-10 |

## Local gates observed before the release commit

| Gate | Result |
| --- | --- |
| Plugin suite (`claude plugin test .`) | **PASS**: 3,192 pass, 0 fail, 83 files, 139.52 s |
| Strict plugin validation | **PASS**: `claude plugin validate --strict` exit 0 on `.`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and `agents` (4/4) |
| Capability shape | **PASS**: 18/18 self-test, no findings in `hooks/` (a local approximation, not the Directory's validator) |
| Public audit (`python3 scripts/audit-public.py`) | **PASS**: 326 files, 0 portability/credential findings; manifest, defaults, license and icon checks pass |
| TypeScript (`tsc -p .`, TypeScript 5.9.3) | **PASS**: exit 0 against the 2.1.296 declarations this tree carries |
| Pinned-host typecheck (`scripts/typecheck-host.sh`) | **REFUSED (not a pass)**: installed host 2.1.322, gate requires 2.1.296. No host-version attestation is claimed. |
| Git whitespace (`git diff --check`) | **PASS**: exit 0 |
| Secret scan (`scripts/scan-secrets.sh`, Gitleaks 8.30.1) | **PASS**: history 0 findings, worktree 0 findings, clean |

The public audit's byte total changes when prose is edited and is therefore not recorded here; the file count and zero
findings are the stable result. The audit script's only change in this release is its exact-version assertion, from
`0.9.0` to `1.0.0`.

## Remote gates required on the tagged SHA

These cannot be observed before the commit is pushed. Their actual results are recorded in the GitHub Release for
`v1.0.0` and in the final release report; this checklist does not claim them in advance.

| Gate | Requirement |
| --- | --- |
| GitHub CI | Must pass on the exact `v1.0.0` commit; TypeScript is not verified by CI |
| Commit attribution | Must pass on the exact `v1.0.0` commit: no `codebuff`, `Codebuff`, `freebuff` or `codebuff-team` in author, committer or trailers |
| Secret scan | Must pass on the exact `v1.0.0` commit |

## Repository invariants

- **One branch.** `git ls-remote --heads origin` reports only `refs/heads/main`; no other branch is created or pushed.
- **No forbidden attribution.** `git log --all` must contain zero `codebuff`, `Codebuff`, `freebuff`, `codebuff-team` or
  `Co-authored-by` matches. The local `commit-msg` hook and `.github/workflows/commit-attribution.yml` remain in place
  and are not weakened.
- **Human identity.** Author, committer and tagger are `echelong <186010546+echelong@users.noreply.github.com>`; no
  commit is amended and no push is forced.
- **History preserved.** Tags `v0.7.0`, `v0.8.0`, `v0.9.0` and their Releases are not deleted or moved.

## NO-GO statements

**D12/D13 remain NO-GO.** No general C1a ownership solution is implemented or claimed. Sweep stays off by default. A
claim is not deleted solely on an end event. `OWNER_ATTESTED` is not proof of termination.

**Cobalt Recall integration remains NO-GO.** The v0.9.0 spike is fixture-only and permanently off. No XERJ release,
corpus, backend, network call or runtime caller is part of this release. Integration requires the go/no-go criteria in
[implementation-v0.9.0.md](implementation-v0.9.0.md#go-no-go-criteria-for-any-future-integration) and an explicit human
GO.

## Scope statement

v1.0.0 changes no hook, agent, command, option, default, permission, guard, gate, DONE rule, ownership rule, storage key,
network path, dependency or Cline behavior. The only code change is the audit's exact-version assertion. The release is
a stability statement and documentation hardening, not a new capability.
