# Cobalt Cockpit v0.7.0 — diff-aware verification candidate

**Status: release candidate, not published.** Owner approval is required before any publication. This candidate is isolated on branch `v0.7.0-diffcov` in a separate worktree from `de3e361af180c9ab6d49613648a77d8d45228410`; the owner's `main` checkout is untouched.

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
| Plugin test harness | **3,163 pass, 0 fail, 81 files** (`claude plugin test .`, 140.40 s) |
| Parser tests | 15 focused tests in `tests/diffcov-git.test.ts`: raw NUL lists, renames/deletions, unsafe paths, zero-context hunks, binary/mode-only blocks, hunk-count mismatches, attributes, stat and identity |
| Disabled behavior | `tests/diffcov-off.test.ts`: `/cockpit coverage diff` renders the off state and adds **zero** process calls |
| Real-host acceptance | Claude Code **2.1.319**, isolated `CLAUDE_CONFIG_DIR`, disposable repository, seeded valid capture: MATCHED evidence, `COVERED 1`, `src/price.ts:1`, advisory closing. With `coverageDiff:false`: explicit off state. |
| Strict plugin validation | **PASS** (`claude plugin validate --strict .`, exit 0) |
| Capability-shape | **PASS**: 18/18 self-test, no findings in `hooks/` |
| Public security audit | **PASS**: 316 files, 6,957,080 bytes, manifest/defaults/license checks, icon checks, 0 portability/credential findings |
| Whitespace | **PASS** (`git diff --check` and the new files) |
| Gitleaks | **PASS**: history 0 findings; worktree 0 findings; clean |
| Typecheck against 2.1.296 | **Not run.** The host here is 2.1.319 and the generated 2.1.296 declarations are absent; the repository's mandatory script refuses rather than attesting. |
| Claude Code 2.1.296 / 2.1.316 | **Not run.** No compatibility with either version is claimed from the 2.1.319 acceptance. |
| Independent review | **None available.** The author performed an explicit adversarial self-review; no independent approval is claimed. |
| Candidate diff | The final changed-path list and diff SHA-256 are in the delivery report for the exact committed candidate; no publication is performed. |

### Known coverage gaps

1. The live capture wrapper was not exercised by a model-driven test command. Its pure decisions (`captureBefore`, `captureAfter`, `captureRecordOf`, `bindEvidence`) have focused and end-to-end synthetic tests; the host adapter that snapshots Git/stat around a real Bash call is covered by the disabled-path test, not by a real successful test command. The MATCHED real-host acceptance used a capture record written in the exact validated shape, not one produced live.
2. The report reader and classifier are exercised by the Phase 1.5/1.6 suites; the real-host command read a real report and real Git tree.
3. The Git adapter is tested with synthetic raw/patch fixtures; it was also exercised against a disposable repository in the real-host acceptance.
4. No independent reviewer was available. Treat the self-review as a limitation, not a substitute.

## Security properties established by the implementation

- Only the existing hardened `bounded` runner is used for Git/stat; no unbounded process is added.
- Git output and report bytes are untrusted. Paths that are absolute, traverse, enter `.git`, use backslashes/globs/control characters or are not UTF-8 are refused.
- The report must be an ordinary file with exactly one hard link, not reached through a linked parent, of bounded size, read whole and unchanged by the read. A symlink, FIFO, socket, device, hard link, linked parent, empty/oversized report or a read race is refused.
- The report path is excluded from the source identity, so a coverage write cannot masquerade as a source change.
- Evidence binds only to a capture for the same project and report path, the exact report SHA-256, a report whose stat changed during the run, and the same content identity now and after all reads. Stale, mismatched or tampered records are dropped, never repaired.
- The feature is unavailable rather than weakened when the platform does not enforce the measurement memory limit, when Git is too old, when filters/partial clone make identity unreliable, or when a required safety property cannot be established.
- When disabled, no capture, Git inspection, report reading or added process work occurs.

## Changed paths in this candidate

Modified: `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, `CHANGELOG.md`, `PRIVACY.md`, `README.md`, `SECURITY.md`, `docs/README.md`, `docs/configuration.md`, `docs/design-v0.7.0-diff-aware-verification.md`, `docs/roadmap-v0.7.0-diff-aware-verification.md`, `hooks/register.tsx`, `scripts/audit-public.py`.

Added: `docs/release-v0.7.0.md`, `hooks/diffcov-git.ts`, `tests/diffcov-git.test.ts`, `tests/diffcov-off.test.ts`.

The audit script's only change is its exact-version assertion, from `0.6.6` to `0.7.0`; no audit check was weakened.

## Migration and compatibility

- Existing installations keep `coverageDiff: false`; installing or updating does not silently enable capture.
- No existing option, gate, review, guard, command, tool schema, storage migration or Cline behavior changes.
- The plugin manifest and marketplace entry both read `0.7.0` in this candidate.
- A v0.6.6 store is read as before; the new capture key is absent until the owner enables the layer and an eligible run is observed.

## Publication plan (owner only)

1. Review the exact candidate commit and this page.
2. Run the final strict validation, capability-shape, public audit, whitespace, Gitleaks and TYPE gates on the exact candidate.
3. Publish only after the owner's explicit approval, using the repository's normal reviewed release path; do not force-push or rewrite history.
4. Verify the marketplace and manifest versions agree and that the Cline adapter is unaffected.

## Rollback plan

- Before publication: delete the isolated worktree/branch; `main` and the installed plugin are already untouched.
- After publication: publish a reviewed revert or a 0.7.1 that sets `coverageDiff` back to its default and removes the command only if the owner decides the feature must be withdrawn. Never force-push, delete history or reuse the tag.
- Disabling `coverageDiff` is the immediate operational rollback: the layer reads no report and starts no coverage work, while every existing guard and gate stays in force.
