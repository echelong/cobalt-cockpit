# Cobalt Cockpit v0.7.0 — diff-aware verification

**Status: published.** The annotated tag `v0.7.0` points at `943f41f9564aa707609b4ecdad51f7aecdeafdc6` on `main`, and this page is the body of the GitHub Release for that tag. The work was prepared on branch `v0.7.0-diffcov` from `de3e361af180c9ab6d49613648a77d8d45228410` and is now on `main`.

## What this release adds

- `coverageDiff` (default `false`), `coverageDiffReport` (empty) and `coverageDiffExclude` (empty), the three person-only options in the v0.7.0 design.
- Capture around an eligible foreground test command observed from the main session in the verified repository root. The layer never starts a test. A capture is written only when the command plainly succeeded, the source identity is known and unchanged across the run, and the report was refreshed by the run.
- `/cockpit coverage diff [--page N] [--base <commit>]`, which reads the current change and the configured LCOV report and renders changed lines as covered, uncovered, excluded/non-executable, unavailable or untrusted, with the evidence state and the exact advisory wording.
- Bounded Git selection, safe paths, generated-file attributes, symlink/deleted/untracked handling, no-follow report reading, hard-link and linked-parent refusal, report/source binding, stale-evidence refusal and per-project bounded storage.

## What it does not do

- It never approves, blocks or changes DONE, any of the six gates, a review, a release decision, a Stop hold, agent ownership, permission handling or the Cline adapter.
- It never executes tests, reads a report when disabled, stores command text/arguments/environment/tokens/test output/report content, invents a coverage percentage, confidence score or threshold, or claims that execution coverage proves assertion quality or correctness.
- It does not import the experimental P0.5 C1a work, reopen the F01/A2 or v0.6.6 Stage A/B NO-GO decisions, or change model routing or credentials.
- It does not publish, merge, tag or update an installed plugin.

## Verification evidence

| Gate | Result |
| --- | --- |
| Plugin test harness | **3,164 pass, 0 fail, 81 files** (`claude plugin test .`, 150.76 s) |
| Parser tests | 14 focused tests in `tests/diffcov-git.test.ts`: raw NUL lists, renames/deletions, unsafe paths, zero-context hunks, binary/mode-only blocks, hunk-count mismatches, attributes, stat and identity |
| Disabled behavior | `tests/diffcov-off.test.ts`: `/cockpit coverage diff` renders the off state and adds **zero** process calls |
| Real-host acceptance | Claude Code **2.1.319**, isolated `CLAUDE_CONFIG_DIR`, disposable repository, **live capture**: a real host Bash call ran `npm test` and wrote `coverage/lcov.info`; the capture record carried project, HEAD, identity, report SHA-256/stat and `npm test (ok)`. A second real session rendered `MATCHED`, `COVERED 2`, `UNCOVERED 1`, `UNAVAILABLE 1`, `src/price.ts:3` and the advisory closing. With `coverageDiff:false`: explicit off state. The assistant turn came from a local scripted Messages endpoint; no model credential was used. |
| Strict plugin validation | **PASS** (`claude plugin validate --strict .`, exit 0) |
| Capability-shape | **PASS**: 18/18 self-test, no findings in `hooks/` |
| Public security audit | **PASS** on the final candidate: 316 files, manifest/defaults/license checks, icon checks, 0 portability/credential findings; exact byte total and full output are in the delivery report. |
| Whitespace | **PASS** (`git diff --check` and the new files) |
| Gitleaks | **PASS**: history 0 findings; worktree 0 findings; clean |
| Typecheck against 2.1.296 | **PASS**: `scripts/typecheck-host.sh` with the pinned 2.1.296 binary and declarations written by that host, TypeScript 5.9.3, exit 0. The declarations were attached to gitignored `.claude-plugin/types/`; this unauthenticated environment cannot regenerate them. |
| Claude Code 2.1.296 / 2.1.316 live sessions | **Not run.** 2.1.296 is covered by TYPE only; 2.1.316 is not covered. No runtime compatibility with either is claimed from the 2.1.319 acceptance. |
| Independent review | **None available.** The author performed an explicit adversarial self-review; no independent approval is claimed. |
| Candidate diff | The final changed-path list and diff SHA-256 are in the delivery report for the exact committed candidate; no publication is performed. |

### Defects found by these gates, and fixed

1. `hush` discarded the work result, so the capture frame never reached the store. It now returns the result.
2. Identity after reads was re-measured from `ChangedFile` without Git modes, which could call a tracked change stale. It now uses the selected identity files, modes included.
3. Claude Code 2.1.319 adds `subagentCapApplied`, `tailInputPath`, `tailInputNote`, `memoryLimitNote` and `triggeredNote` to the result. The capture adapter now accepts the result only while these annotations are absent; a set annotation yields `RESULT_UNRECOGNISED` and no capture.
4. The raw Git parser now raises an explicit `DiffParseError` for an undefined rename word instead of passing it to a path check.

### Known coverage gaps

1. The 2.1.319 live acceptance was host-real but not model-real. The assistant turn was served by a local scripted Messages endpoint; the real host executed the Bash tool, `npm test`, the Git/stat/report reads, the capture write and the second `/cockpit coverage diff` session. The model's choice to run the command remains untested.
2. The 2.1.296 declarations used by TYPE were written by the pinned 2.1.296 host in the devtools store and attached to gitignored `.claude-plugin/types/`; this environment cannot generate fresh ones because the host requires login. TYPE compiled the exact candidate source against those declarations, but the declarations were not regenerated for this tree.
3. A live session on 2.1.296 or 2.1.316 was not run. No runtime compatibility with either version is claimed; 2.1.296 is covered by TYPE, 2.1.316 by neither.
4. The report reader and classifier are exercised by the Phase 1.5/1.6 suites; the real-host command read a real report and real Git tree.
5. The Git adapter is tested with synthetic raw/patch fixtures and was exercised against the disposable repository.
6. No independent reviewer was available. Treat the self-review as a limitation, not a substitute.

## Security properties established by the implementation

- Only the existing hardened `bounded` runner is used for Git/stat; no unbounded process is added.
- Git output and report bytes are untrusted. Paths that are absolute, traverse, enter `.git`, use backslashes/globs/control characters or are not UTF-8 are refused.
- The report must be an ordinary file with exactly one hard link, not reached through a linked parent, of bounded size, read whole and unchanged by the read. A symlink, FIFO, socket, device, hard link, linked parent, empty/oversized report or a read race detected by the before/after stat check is refused; the check is not atomic against a replacement between the stat and the open/read.
- The report path is excluded from the source identity, so a coverage write cannot masquerade as a source change.
- Evidence binds only to a capture for the same project and report path, the exact report SHA-256, a report whose stat changed during the run, and the same content identity now and after all reads. Stale, mismatched or tampered records are dropped, never repaired.
- The feature is unavailable rather than weakened when the platform does not enforce the measurement memory limit, when Git is too old, when filters/partial clone make identity unreliable, or when a required safety property cannot be established.
- When disabled, no capture, Git inspection, report reading or added process work occurs.

## Changed paths in this release

Modified: `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, `CHANGELOG.md`, `PRIVACY.md`, `README.md`, `SECURITY.md`, `docs/README.md`, `docs/configuration.md`, `docs/design-v0.7.0-diff-aware-verification.md`, `docs/roadmap-v0.7.0-diff-aware-verification.md`, `hooks/diffcov-capture.ts`, `hooks/register.tsx`, `scripts/audit-public.py`, `tests/diffcov-capture.test.ts`.

Added: `docs/release-v0.7.0.md`, `hooks/diffcov-git.ts`, `tests/diffcov-git.test.ts`, `tests/diffcov-off.test.ts`.

The audit script's only change is its exact-version assertion, from `0.6.6` to `0.7.0`; no audit check was weakened.

## Migration and compatibility

- Existing installations keep `coverageDiff: false`; installing or updating does not silently enable capture.
- No existing option, gate, review, guard, command, tool schema, storage migration or Cline behavior changes.
- The plugin manifest and marketplace entry both read `0.7.0` in this candidate.
- A v0.6.6 store is read as before; the new capture key is absent until the owner enables the layer and an eligible run is observed.

## Publication

1. The owner reviewed the exact commit and this page.
2. The final strict validation, capability-shape, public audit, whitespace, Gitleaks and TYPE gates were run on the exact candidate; the results and the gaps are in the table above.
3. Publication used the repository's normal reviewed release path for the existing annotated tag; history was not force-pushed or rewritten for it.
4. The marketplace and manifest versions agreed at `0.7.0`, and the Cline adapter was unaffected.
5. The GitHub Release for the existing `v0.7.0` tag was created later, after publication, from this page. No second tag was created.

## Rollback plan

- Before publication: delete the isolated worktree/branch; `main` and the installed plugin are already untouched.
- After publication: publish a reviewed revert or a 0.7.1 that sets `coverageDiff` back to its default and removes the command only if the owner decides the feature must be withdrawn. Never force-push, delete history or reuse the tag.
- Disabling `coverageDiff` is the immediate operational rollback: the layer reads no report and starts no coverage work, while every existing guard and gate stays in force.
