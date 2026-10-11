# v0.5.2 release checklist

A green CI run does not establish release readiness. CI covers strict validation, the offline plugin tests, the public audit, the whitespace checks and the secret scan on Claude Code 2.1.296. It does **not** type-check: Claude Code 2.1.296 has no verified unattended way to produce the plugin host declarations, so TypeScript is a separate mandatory gate, attested by a person below.

This checklist has two separate parts. Part A is what a GitHub source release of this repository needs. Part B is what a marketplace directory listing needs on top of it. Passing Part A says nothing about Part B: publishing the source on GitHub is not directory approval, and the directory submission stays blocked until Part B is closed.

## Part A: GitHub source release. Mandatory gates on the exact release candidate SHA

Every gate names one full commit id and holds for that commit only. A new commit, including a documentation-only one, needs every gate again. An earlier verdict is evidence of what was reviewed then, never approval of the new commit, and a consultation budget is not reset to obtain another verdict.

| Gate | How | Where it runs |
|---|---|---|
| Strict validation | `claude plugin validate --strict .` (and `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `agents`) | CI and locally |
| Plugin tests | `claude plugin test .` | CI and locally |
| Public audit, whitespace | `python3 scripts/audit-public.py`, `git diff --check` | CI and locally |
| Secret scan | `scripts/scan-secrets.sh` | CI (Gitleaks) and locally |
| **TypeScript (manual)** | `scripts/typecheck-host.sh` on the exact SHA with a clean tree | **Locally only, by a person** |
| Source-tree comparison, for a candidate that changes documentation only | `git diff --stat <previous candidate> <candidate>` confined to documentation files; `hooks/`, `scripts/`, `tests/`, `types/`, `agents/`, `.claude-plugin/`, `.github/`, `tsconfig.json` and the manifests byte-for-byte unchanged | Locally, recorded in the release record |
| Interactive Cobalt Guard SENT acceptance | By the owner in a terminal, on the notification implementation as shipped; see the evidence below | Locally |
| Independent security reviews A and B | Each returns a fresh GO or NO-GO for the exact SHA, from the unchanged-implementation evidence, the source-tree comparison and the complete diff | Owner-started task with an authorized consultation budget |
| Release-ground consultation | Only after both security reviews return GO; a fresh verdict for the exact SHA | Owner-started task |

A NO-GO from any reviewer stops the release. Nothing below (a tag, a GitHub Release, a fast-forward of `main`, an installation) happens without separate owner authorization after every gate holds.

### Evidence held, by commit

- Security A: GO on f42fa58c2cdc9ae7da9ba58fe575b45001ac032d.
- Security B: GO on f42fa58c2cdc9ae7da9ba58fe575b45001ac032d.
- Release ground: NO-GO on f42fa58c2cdc9ae7da9ba58fe575b45001ac032d, for the documentation findings that the documentation-only commit after it corrects (telemetry retention and placement, the incomplete file and process inventories, the architect-role limitation, this checklist, the stale SENT statements). That NO-GO stands for that commit and is not reinterpreted; the corrected commit needs its own three verdicts.
- Interactive Cobalt Guard SENT acceptance: 2026-10-11, Claude Code 2.1.296, `--permission-mode auto`, a `--plugin-dir` snapshot whose tracked files are byte-identical to f42fa58c2cdc9ae7da9ba58fe575b45001ac032d. The host reported SENT on channel `terminal_bell` for a `run-blocked` alert in two sessions (13:00:01 and 13:26:13 UTC), and the owner observed the terminal's bell, flash and popup at that moment. Details: [docs/implementation-v0.5.2.md](implementation-v0.5.2.md), "Interactive SENT acceptance". A later commit that leaves `hooks/alerts.ts` and the notify call in `hooks/register.tsx` byte-for-byte unchanged carries this evidence; one that changes either needs the acceptance again.

## TypeScript attestation (manual, mandatory)

Prerequisite: the host must have written its own declarations into `.claude-plugin/types/` through an authorized, interactive development-plugin load (`claude --plugin-dir <this folder>`, folder trusted by the person). The script refuses missing or empty declarations, a host other than 2.1.296 and declarations not written by 2.1.296. It never generates, downloads, edits or vendors declarations, copies credentials or changes trust settings.

1. Check out the exact release candidate (including the version bump) with a clean tree.
2. Run `scripts/typecheck-host.sh`. Its exit code is `tsc`'s; exit 2 with `REFUSED` is not a pass.
3. Record the report it prints:

```
TYPECHECK REPORT
  release sha: <full sha>
  working tree: clean
  host: 2.1.296 (Claude Code)
  typescript: 5.9.3
  outcome: PASS
```

Attestation line for the release record: `TypeScript PASS at <full sha> on host 2.1.296, TypeScript 5.9.3, attested by <name> on <date>`.

### When the attestation must be repeated

- Any change to the release candidate SHA, even a documentation or metadata commit: the attestation names a SHA and applies to that SHA only. (A change confined to files `tsc` does not read is the only arguable exception; do not rely on it, rerun, it takes seconds.)
- A different Claude Code version, or declarations rewritten by a different host version.
- Declarations regenerated by the same version are expected to be identical; if `.claude-plugin/types/claude-code/index.d.ts` differs from the one used for the attestation, repeat it.
- A working tree that is not clean at attestation time is not an attestation (the report says `DIRTY`).

## Part B: Marketplace directory listing (BLOCKED)

A directory listing needs, beyond Part A: the directory validator's own pass on the published source, name availability, and the manual-review hold for the two bundled WAV cues ([marketplace-submission.md](marketplace-submission.md)). The directory's validator is not available offline, so none of this can be certified from this repository.

| Item | State |
|---|---|
| Two findings reported by the marketplace directory, exact validator text not yet supplied to this repository | **OPEN.** They cannot be reproduced locally, nothing in this repository claims to have fixed them, and they are not closed by any Part A gate |
| Directory submission | **BLOCKED** until both findings are disclosed, reproduced or ruled out, fixed where needed, and the validator passes on the published source, with separate owner authorization to submit |

A GitHub release, tag or fast-forward of `main` is not a submission and does not close this part.

## Host upgrades

When the supported host version changes, update the pin in `.github/workflows/ci.yml` and `HOST_VERSION` in `scripts/typecheck-host.sh` together, regenerate the declarations interactively, and run the whole table above again. Compare the new declarations with the previous ones by hand for removed or changed members before trusting a pass.
