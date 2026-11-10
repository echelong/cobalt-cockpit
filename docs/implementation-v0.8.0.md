# Cobalt Cockpit v0.8.0 — read claims and generated-file reporting

**Status: published.** This page records the two changes in 0.8.0, the decisions behind them and their limits. Neither
changes a gate, a DONE decision, a guard, a review, a release decision, an ownership rule's write side or a permission.

## Read claims are refused rather than widened

**The fault.** An `owned_resources` entry that could not be kept narrow — a pattern (`* ? [ ] { }`), a leading `~`, an
empty list or a path `realpath -m` did not resolve — became `*`. For a writer that is the conservative reading: an
unclear claim locks everything. For a reader it is the opposite: a helper the commander meant to confine could read the
whole repository, and a literal path with brackets such as `app/[id]/page.tsx` could not be claimed at all.

**The decision.** A read claim is never widened. The commander writes `"*"` to claim the whole repository; anything else
must be a literal path that resolves. If any entry cannot be kept narrow, the assignment is refused whole: nothing is
assigned, no task id is consumed, and the reply names how many entries failed and why (`a pattern`, `a home path`,
`a path that did not resolve`) together with what to write instead. The invariant is the one the security roadmap set:
**a reader never holds `*` unless the commander wrote `*`.**

**Bracketed names are literal.** `realpath` expands no pattern, and the plugin runs no shell for this call, so `[`, `]`,
`{` and `}` are ordinary characters in a file name. `app/[id]/page.tsx` is therefore resolved and stored as a literal
claim. `*` and `?` remain patterns and are refused for a reader; a file whose name really contains one cannot be
claimed as a single path.

**`realpath -m` is required.** Where the host's `realpath` does not accept `-m` (older macOS, some BusyBox builds), a
named read claim does not resolve and the assignment is refused with `a path that did not resolve`. It is not widened.
No such host was tested here.

**Writers are unchanged.** A write claim keeps the conservative reading in `canonicalWideIn`: a pattern, `~` or an
unresolvable path still locks the whole repository, and a raw bracketed write claim still becomes `*`. Nothing about
write locking is weaker than 0.7.0.

**Existing sessions and Ledgers.** No stored claim is rewritten. A task assigned before the upgrade keeps the claim it
was given, including `*`, until it ends; the rule applies to new assignments only. Nothing is migrated silently.

**Tests.** `tests/swarm-claims.test.ts` covers a literal bracketed claim, ownership and overlap beside it, the refusal of
an empty, patterned or home-path claim through the swarm tool, and the unchanged write lock. `tests/routing.test.ts`
now checks the refusal instead of the old `SCOPE / … claim is *` reply.

**Not changed.** Ownership remains an admission rule within one session, not a lock. The D12/D13 NO-GO holds: no general
C1a ownership solution, sweep stays off by default, a claim is not deleted solely on an end event, and
`OWNER_ATTESTED` is not proof of termination.

## Generated files are reported apart

The `/cockpit coverage diff` report now adds one advisory line when changed files are excluded as generated:

```
Generated:  2 files excluded (1 attribute, 1 marker); their changed lines are counted as excluded, not measured.
```

It is built from the same `FileRow` reasons the Files list already carries (`GENERATED_ATTRIBUTE`, `GENERATED_MARKER`),
so it changes no count, no category, no evidence state and no decision. It exists because a generated file's changed
lines were previously visible only as one row among many, and "excluded" could be mistaken for "measured and clean".
The Files rows and the `EXCLUDED / NON-EXECUTABLE` counts are unchanged.

**Test.** `tests/diffcov-render.test.ts` adds a golden-free assertion for the line, its two counts and the unchanged
excluded category. The layer stays off by default and still approves, blocks and measures nothing.
