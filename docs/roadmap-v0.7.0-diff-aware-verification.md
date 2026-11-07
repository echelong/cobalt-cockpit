# Planned for v0.7.0: Diff-Aware Verification

Status: implementation complete in the isolated v0.7.0 release candidate; not published. Phases 1, 1.5 and 1.6 remain the pure modules and tests, Phase 2 adds Git selection and source identity, Phase 3 adds the three off-by-default options and capture around observed test commands, and Phase 4 adds `/cockpit coverage diff`. The layer is advisory and changes no gate, DONE, review, release, guard, ownership or permission behavior. It is a milestone of its own, separate from [Persistent Attention](roadmap-v0.6.2-persistent-attention.md).

## Objective

Design a new evidence layer that correlates the executable lines a change touched with coverage measured from an actual test execution.

The six gates say that checks ran and what they reported. They do not say whether the lines that changed were among the lines the tests ran. This layer would answer that narrower question, and only that one.

## Scope of the first version

- TypeScript and JavaScript, with LCOV as the coverage format, where the project's tooling supports it.
- Coverage reports bound to the source revision they were measured on. Evidence that is stale, or that does not match the revision and working tree in question, is rejected and reported as such, never used.
- Advisory and opt-in.

## What it reports

Four categories, kept apart:

1. changed executable lines that were covered;
2. changed lines that were not covered;
3. lines that are excluded or not executable;
4. coverage that is unavailable or cannot be trusted, with the reason.

## What it must never claim

- A line that ran is not a line that was checked. Line execution is never equated with assertion quality.
- Coverage is never presented as proof of correctness.
- The figures are evidence for a reviewer to weigh. They are not a verdict.

## Constraints

- **The six-gate DONE requirements do not change silently.** This layer begins as advice beside them. It adds no gate, removes none, and neither blocks nor permits DONE.
- Opt-in initially: off unless a person turns it on.
- No change to the existing verification, goal-check or release rules.

## To investigate before implementation

Each of these is an open question, and the design is not ready until each has an answer with evidence:

- **Security boundaries.** A coverage report is a file the repository, or a command the repository controls, produced. What reading and correlating it may trust, and what a hostile report could make Cockpit do or claim.
- **Parser safety.** Parsing LCOV and reading source positions with bounded time and memory on malformed, enormous or adversarial input.
- **Performance.** The cost on large diffs and large reports, and where in a session the work would run.
- **Diff-base selection.** Which revision a change is measured against, and how that choice is shown so the figures cannot quietly mean something else.
- **Working-tree modifications.** Uncommitted and untracked changes, and edits made after the coverage was measured, which make the evidence stale.
- **Source maps.** Mapping coverage of built output back to changed source lines, and what is reported where the mapping is missing or ambiguous.
- **Generated files.** Telling generated code from authored code, and how each is counted or excluded.
- **Review of uncovered changes.** How uncovered changed lines are presented so that a person can review them, rather than only count them.

## Acceptance criteria for the design

- Each question above is answered in writing, with what was measured or tested to answer it.
- The four report categories are defined precisely enough to be tested, including when evidence is rejected as stale or mismatched.
- The wording rules (no claim of assertion quality, no claim of correctness) are stated as testable rules.
- The existing six gates and the conditions for DONE are shown to be unchanged with the layer off and with it on.
- A decision is recorded on whether to implement, and in what order, before implementation starts.
