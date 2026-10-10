# v0.5.1 implementation: discovery and decision quality

Cockpit's own heuristic, not an official Anthropic workflow. Principle: understand the objective, find the unknowns that matter, choose deliberately, record consequential choices, build incrementally, and compare the result with the request before saying DONE, without extra model calls or recurring prompt text.

## Existing mechanisms reused

| Need | Reused |
| --- | --- |
| Task state, progress percent, gates | `Task` in `hooks/model.ts`; the goal check is one more condition of `isVerified`, next to the gates and the consultation |
| Consultation grounds | `groundsAvailable` in `hooks/consult.ts`, read, not changed |
| Storage, retention, migration | `Ledger`, `storageLedger`, `migrateLedger` in `hooks/ledger.ts` |
| Prompt hook, tool, command | `prompt.submit`, the `progress` tool and `/cockpit` in `hooks/register.tsx` |
| Redaction | `redactSecrets` in `hooks/secrets.ts` |

New: `hooks/discovery.ts` (pure), optional fields on `Task` and `Ledger`, and `tests/discovery.test.ts`.

## Level

`classify` returns the level and short reason codes. DEEP: an `architecture` or `security` consultation ground (from the prompt or sensitive files), or a high-risk term (migration, schema, auth, payments, encryption, concurrency, transactions, data integrity, rollback, permissions, architecture, rewrite). Otherwise a question or no change request is LIGHT, a short trivial-shaped edit is LIGHT, a change request is STANDARD, and three or more edited files make it at least STANDARD. `withDiscovery` only raises. An operator pin (`/cockpit discovery`) is kept and is session state. A router is never an input.

Examples: "Fix the typo in the README heading" LIGHT; "What does parseStatus do?" LIGHT; "Add booking cancellation to the API and the UI" STANDARD; "Migrate the payments schema" DEEP.

## Prompt guidance

At `prompt.submit` only: nothing for LIGHT, a ~55-word line for STANDARD, a ~80-word line for DEEP. `discovery.guided` records the level already guided, so a follow-up prompt does not repeat it; a later escalation gives the new level's line once. The tool description grew by about 90 words.

## Records

`Task.discovery`, `Task.decisions`, `Task.alignment` are optional. `Ledger.decisions` (64) and `Ledger.discoveries` (16) are optional and mirrored from the task by `recordDiscovery`, keyed by task and decision id, so a revision replaces its earlier form. `migrateLedger` adds both as empty lists; a v0.5.0 ledger reads unchanged.

`DecisionRecord`: `id` (`d1`…), `taskId`, `problem`, `chosen`, `alternatives[{option, rejectedBecause}]`, `tradeoffs`, `evidence[]`, `status` (`provisional` | `verified` | `revised`), `at`. `DiscoveryEntry`: `taskId`, `level`, `source`, `reasons[]`, `unknownsOpen`, `alignment`, `at`.

Redaction is applied in `clip` when the model's input is accepted, and again in `recordDiscovery`, so neither task state nor the ledger holds a credential shape. A decision input is refused, with nothing recorded, when an alternative lacks its reason or a `verified` decision lacks evidence. `/ledger export json` is a whitelist and does not include decisions; `/ledger export decisions` prints Markdown on request.

## Goal check

`needsAlignment`: a `coding` task with a level above LIGHT. `isAlignmentSatisfied` is true only when criteria exist, every criterion is `met` with evidence, and `Task.alignment.state` is ALIGNED; an empty criteria set is never satisfied (`criteriaMissing`). Criteria carry `basis: 'reported'`; `criterionProblem`/`evidenceProblem` reject generic text, and `invalidateAlignment` resets every evaluation. `Task.edited` marks a read-only plan that edited files. It feeds `percentOf` (cap at 99), `statusOf` (UNVERIFIED), and the VERIFY-milestone hold in `completeMilestone`, as the gates and the consultation do. `align` refuses ALIGNED when any criterion lacks evidence, anything is reported missing, an unknown is open, a milestone before verification is unfinished, the task is blocked or a required gate is open. New edits, a failing required gate or a new criterion reset the check to PENDING. Read-only tasks, LIGHT tasks and tasks without `discovery` (stored by older versions) are not held.

## Privacy and retention

Local only, in the existing ledger store; no network use. Free text is redacted and clipped (problem 160, chosen 200, alternative 120/160, evidence 120 × 4). Level reasons are codes. The prompt is never stored by this feature.

## Compatibility

SONNET_LED and OPUS_LED, router modes, model roles, effort handling, admission and the mandatory consultation gates are untouched: `hooks/discovery.ts` imports only `consult.ts` (read) and `secrets.ts`. Existing tests that exercise milestones and gates pin LIGHT in their fixtures.

## Known limits

The level is a regex heuristic. The goal check trusts the evidence the model reports and cannot verify it. Haiku scouts can feed `discover`, but only the main session records, and nothing marks an unverified scout claim as a fact.

## Completion integrity after the goal check

`reopenVerification` (model.ts) is the one transition for "the implementation changed": `invalidateAlignment` plus every passed gate to pending ("stale: reason"), for goal-checked work only. `touchFile` (Edit, Write, Bash edit diff) and the helper-edit branch of `noteEnd` use it. `Alignment.tree` holds a git working-tree fingerprint (`treeStamp`: status, diff against HEAD, content hashes of up to 200 untracked files) taken by `serveProgress` when ALIGNED is accepted. `reconcileTree` compares it after every non-progress tool call of the main loop or a helper, and before every progress call; a mismatch calls `treeMoved`, which reopens verification. `invalidateAlignment` drops the stamp, so a second reconcile cannot undo checks that were re-observed. Where git gives no fingerprint the stamp is null and only the direct paths apply. `unpin` (`/cockpit discovery auto`) keeps the level the task already reached as a floor.
