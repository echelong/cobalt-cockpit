# Security follow-ups recorded after v0.6.1

Status: the P0 below is fixed on `main` by the security hotfix in the CHANGELOG's 0.6.1 entry (see its section); the read-claim item is fixed in v0.8.0 ([implementation notes](implementation-v0.8.0.md)). Neither item was part of v0.6.1 as first released. That release fixed the three faults its review reproduced ([Corrections to earlier rules](implementation-v0.6.1.md#corrections-to-earlier-rules)) and changed neither of the things below. Each needs its own design, review and tests before any code.

## P0: a guard that throws refuses nothing

**Fixed.** Each guard in the `tool.call` hook runs under `failClosed` (`hooks/guard-rules.ts`) and a throw is a refusal naming the guard, the tool and the error kind; the outer net refuses too. Decisions taken: a failed shell command is refused (not put to the person, which would turn a failed check into an approval request); a failed attribution check on an edit is refused; the person learns of it from the refusal text and the Run Ledger entry, which carry no command, path or error message; the session is not left unusable because only the failing guard's tool class is refused, nothing latches, and the operator's own options turn a guard off. Neighbouring shapes found and fixed: `fs.exists(...).catch(() => true)` in the instruction-file check, and the `subscriptionOnly` check reading a failed read of the authentication state as "not API" (an `unverified` mode is refused since the closeout). Also closed: a Bash call with no text command was assessed as empty and passed, and `MultiEdit` skipped the attribution guard. Tests: `tests/guard-failure.test.ts`, and a static check in `scripts/audit-public.py`.

The original record follows.

**Where.** `hooks/register.tsx`, in the `tool.call` hook:

```ts
// a guard that fails must not take every tool call down with it
const refusal = await guard($, call).catch(() => null)
```

**What `guard` covers.** For a shell command: the attribution guard, the instruction-file guard and the destructive-command guard with its confirmation. For Edit, Write and NotebookEdit: the attribution guard.

**The risk.** Any exception inside `guard`, from any cause, becomes "no refusal": the call goes on to the host as if the guard had passed it. v0.6.1 removed the one cause that was found (a program named like an inherited property made `unwrap` throw, so `valueOf -x; git push --force` was not asked about). The handling itself is unchanged. The next fault of that kind, in the shell reader, in a rule or in the confirmation, would fail open in the same way, and an input that can make the guard throw is an input that can switch it off.

**It is not what the policy says.** SECURITY.md, "Hooks that refuse": "A hook of Cockpit's that fails is not allowed to let an action through." The outer handler of `tool.call` does refuse when the hook as a whole fails. This inner catch does not.

**Why P0.** It is the destructive-command guard, it applies with orchestration on or off, and the failure is silent: nothing tells the person that a guard did not run.

**What a fix has to decide.**

- What a failed guard does to a shell command: refuse it, or put the question to the person.
- What it does to an edit, where the guard that failed is the attribution check.
- How the person learns that a guard failed, and how a session is not left unable to run anything.
- Whether the same shape exists elsewhere: every catch, `quiet(…)` and `hush(…)` around something that can refuse.

**Acceptance.** A test makes each part of the guard throw and shows that the call does not reach the host unasked. A call the guard would have passed still passes when nothing throws. SECURITY.md's sentence is true of the code.

## Security design: a read claim that cannot be kept narrow becomes the whole repository

**Where.** `canonicalIn` in `hooks/register.tsx` and `normalizeOwned` in `hooks/swarm.ts`. An `owned_resources` entry that contains `* ? [ ] { }`, starts with `~`, or that `realpath -m` does not resolve becomes `*`. An empty list is `*`.

**The risk.** `*` is the conservative reading for a lock: a writer whose claim is unclear locks everything. For a reader it is the opposite. A helper the commander meant to confine may read the whole repository, and with `*` it is judged by the wider Git rule. A real path with brackets in it, such as `app/[id]/page.tsx`, cannot be claimed narrowly at all. On a host whose `realpath` has no `-m`, every named claim would widen; no such host has been checked.

**What v0.6.1 did.** It did not change the behaviour. The reply to `assign` now says when a claim became `*`.

**What a design has to decide.**

- Whether a read claim that cannot be kept narrow is refused instead of widened.
- Whether write claims keep the conservative lock.
- How a literal path that contains pattern characters is claimed.
- What happens where `realpath -m` is not available.
- What sessions and Ledgers that already hold widened claims do after the change.

**Acceptance.** No reader receives `*` unless the commander wrote `*`. The commander is told why a claim was refused and what to write instead. Writers' locking is no weaker than it is today.

### Investigation notes (not a change)

Checked against the code: the widening happens in two places that agree, `canonicalIn` (`hooks/register.tsx`) and `normalizeOwned` (`hooks/swarm.ts`), and `submitTask` turns an empty list into `*`. Each of these reaches a reader as `*`: a literal path with brackets (`app/[id]/page.tsx`), any `* ? { }`, a leading `~`, a path `realpath -m` does not resolve, an empty list, and a `..` that climbs above the root. The reply to `assign` says so after the fact; nothing refuses. `realpath -m` is GNU coreutils; a host whose `realpath` lacks `-m` (older macOS, some BusyBox builds) fails the call, `canonicalIn` returns `*`, and every named claim widens: no such host has been tested here.

Why it was not changed in the hotfix: refusing a read claim that cannot be kept narrow is a behaviour change for every commander that assigns a reader with no `owned_resources` (the default today is `*`), with literal-bracket paths (they need a way to be written that is not a pattern), and for Ledgers that already hold widened claims. It changes the contract of `assign`, and it needs its own design (an explicit `*` spelling for readers, a literal-path escape, a fallback where `realpath -m` is missing, and how stored claims are read), review and tests. Writers keep the conservative lock throughout; nothing in this list weakens it. Target invariant for that work: a reader never holds `*` unless the commander wrote `*`.

### Decision (v0.8.0): refused, not widened

- A read claim that cannot be kept narrow is refused whole; nothing is assigned and the reply says which entries failed and what to write. `"*"` is the only way a reader receives `*`.
- A bracketed or braced name is a literal path: `realpath` expands no pattern and no shell runs, so `app/[id]/page.tsx` is claimed as written. `*` and `?` stay patterns and are refused for a reader.
- Where `realpath -m` is unavailable the named claim is refused (`a path that did not resolve`), never widened. No such host was tested.
- Write claims keep the conservative whole-repository lock unchanged. Stored claims are not migrated; a task assigned before the upgrade keeps what it was given until it ends.
- Tests: `tests/swarm-claims.test.ts`; the reply change is covered in `tests/routing.test.ts`. Full record: [implementation-v0.8.0.md](implementation-v0.8.0.md).
