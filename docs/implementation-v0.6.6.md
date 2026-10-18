# v0.6.6 Git hardening: Stage A (unreleased)

> Part of the [Cobalt Cockpit documentation](README.md). Status: **Stage A, on a feature branch, not released.** The manifest still says 0.6.5; nothing here is published until Stage B and the real-Git acceptance are done and a release is approved.

Two possible gaps were found in the released measurement (0.6.5):

- **Submodules.** Cockpit's `status` and `diff` examined submodules (`diff.ignoreSubmodules=none`, `--ignore-submodules=none`). A submodule's own configuration can make such a command run a program the repository chose (a clean filter, measured on Git 2.47.3 with a patch-shaped diff and with `status`). The only gitlink check before those commands read one commit's tree.
- **Partial clones.** Nothing kept Git from lazily fetching a missing object, which runs the promisor remote's transport program (measured: a raw diff with a missing base blob ran a repository-configured `uploadpack` program). SECURITY.md already named the fetch as a residual of a helper's `*` inspection.

Each needs write access to the repository's Git configuration, which already gives code execution through the person's own Git use. What Cockpit added was automatic triggering: its hooks measure the tree after every tool call of the main session, at a prompt, at a Stop and for the HUD. Whether the released 0.6.5 argv reaches either state on real Git is not established; Stage A does not depend on it, because it refuses those states before any such command and pins every command.

## What Stage A changes

**Every measurement process (Cockpit's own Git, through `bounded`).**

| Change | Where |
| --- | --- |
| `GIT_NO_LAZY_FETCH=1` and `GIT_ALLOW_PROTOCOL=cockpit-none`, laid over the caller's environment **last**, so no caller can take them back | `BOUND_PINS` (`hooks/git-integrity.ts`), `bounded` |
| `diff.ignoreSubmodules=all` and `submodule.recurse=false` in `GIT_SAFE`; every `status` and `diff` with `--ignore-submodules=all` | `GIT_SAFE`; the release check, the HUD, the fingerprint |
| An admission check before anything starts: only `git`, `stat`, `find`, `readlink` and `realpath`; only the pre-subcommand words Cockpit writes (`-c key=value`, one `-C`, the three safe flags); a closed discovery list (where the repository and its files are, configuration, `rev-parse --verify HEAD` without a peel, `--version`) runs freely; **every other Git command, which reads the index, the work tree or objects, needs a pass for its `-C` root** | `admissionRefusal`, `gitCallOf`, `gitAccessOf` |
| The repository-state check (`repoState`): configuration in every scope (`config --null --list`), promisor packs, gitlinks in the index's stage entries, and gitlinks in any commit compared without being measured. It returns a pass, an object it creates and records in a module-private `WeakSet`; an object with the same fields made anywhere else is refused. Every answer must be complete: a failure, a cut, stderr or a non-zero exit is "unreadable", never "absent" | `repoState` |
| The check runs before any state-reading Git command at every measuring routine, and again after a measurement (`repoMoved`): a state that appeared meanwhile gives no stamp | the fingerprint, the release check, the HUD, helper inspection |

**A helper's Git inspection (rewritten by Cockpit, run by the host's Bash tool; orchestration only).**

- The same repository check before the command is allowed (HEAD and the index; for a scoped command also each revision it names, after it is proved a commit). A refusal names the reason and points to Read and Grep.
- Refused where Cockpit's environment sets a Git variable that moves where Git looks, what it reads, what it runs or where it writes (26 names, read by literal name, only whether set): the helper's command inherits the host's environment.
- Every rebuilt command, a `*` one too, is pinned with `-C` to the verified session directory, whatever directory the helper's shell is in, and carries `diff.submodule=short`, `protocol.allow=never` and `never` for each protocol, and `--ignore-submodules=all` on `diff`, `status`, `log` and `show`.
- An option that examines or recurses into a submodule (`--submodule…`, `--ignore-submodules…`, `--recurse-submodules…`, and their abbreviations) is no inspection, in either rule.

**Visibility.** The refusal words are closed (`REPO_REFUSAL_WORDS`), and the two a person can act on say what can be measured instead. The HUD shows `not measured (submodule | partial clone | state unreadable | unsafe Git inputs | active filter)`, never `clean`. `/cockpit doctor` names the Git version and what keeps measurement from fetching.

## Refusal behaviour

| Where | A refused repository gives |
| --- | --- |
| Fingerprint (prompt baseline, goal-check guard, Stop guard) | UNKNOWN with the reason. No baseline; a goal check claimed ALIGNED is recorded UNKNOWN, in every Stop-guard mode; a passing Stop check is not recorded as verified; the task does not read DONE |
| Release check | no candidate (`CANDIDATE UNKNOWN`); no `status` runs |
| HUD | an explicit refused state with its reason; a failed `status` in a verified repository is refused too, never a stale or a clean line |
| Stop with no task and nothing owed (`stopGuard: ENFORCE`) | a possible change: the check is asked for, as for a repository with uncommitted changes |
| Helper inspection | denied with the reason; nothing is sent to the host |

Nothing is retried with weaker settings, without the check, or with `--ignore-submodules=none`. A missing object reached anyway (a race, or a state the check could not see) makes Git fail the command instead of fetching, and the answer is UNKNOWN.

## Process-site coverage

`scripts/check-git-callers.mjs` reads the source and compares it with the checked-in census `scripts/git-callers.json`; CI runs it. It fails on a new process site, a new `bounded` call or a new call of a closure that runs Git, and it holds the admission's invariants: only `hooks/register.tsx` starts processes, at exactly 11 sites, with no `$.process.spawn`; every `bounded` call starts a measurement program; a pass is created only in `repoState`; `auth` is only ever a pass or the check's own listing capability; the helper's environment check reads exactly the 26 names, in order. (The plugin test runtime imports only the plugin's own modules, so a test cannot read source files.)

| Site (`hooks/register.tsx`) | Program | Covered by |
| --- | --- | --- |
| `canonicalIn` | `realpath -m` | not Git; census |
| `probeBound` | `sh` (the limit probes, fixed scripts) | not Git; census |
| `bounded` | every measurement process | admission, pins, `repoState` |
| `pollLedger` | `tail -c` | not Git; census |
| `modeIs`, `restrictTelemetry`, `pruneTelemetry`, `tele` | `stat`, `mkdir`, `rm`, `chmod` on the telemetry directory | not Git; census |
| `attempt` | the audio player | person's program; outside the guarantee |
| `askRouter` | the decision router | person's program, only while selected; outside the guarantee |
| `runStopCheck` | the enrolled verification script | person's program, hash-pinned; outside the guarantee |
| helper inspection (not a site: the host's Bash tool runs it) | `git` | the helper checks above |

Git that the host runs as typed is outside Cockpit's execution guarantee: the commander's own commands (Cockpit only decides whether one is held), any other Bash, every helper's Git when orchestration is off, and Claude Code's own Git calls.

## What Stage A protects, and what it does not

**Protected, as designed and tested against a fake host:** no Cockpit Git command that reads repository state starts in a repository with a gitlink in its index or in a commit compared without being measured, or with any partial-clone configuration or promisor pack; every Cockpit Git process carries the two pins; no `status` or `diff` examines a submodule; a refusal is never a clean tree, an accepted goal check, a verified Stop check, a release candidate or an allowed inspection.

**Not protected by Stage A:**

1. **The inherited Git environment of Cockpit's own measurement processes.** They still start from the host's environment with Cockpit's variables laid over it (no `env -i`). A launch environment that sets `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CONFIG_PARAMETERS`/`GIT_CONFIG_COUNT`, `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`, `GIT_EXEC_PATH`, `GIT_TRACE*`, a relative `PATH` entry or `LD_PRELOAD` changes what Git reads, runs or writes. What already holds: the two pins override any inherited value of theirs; command-line `-c` beats environment configuration for the keys Cockpit pins (measured for `core.fsmonitor` and `core.hooksPath`); the filter and input checks read every configuration scope, the environment's included; a redirected work tree fails the root verification. Setting such variables needs control of the launch environment, which already gives code execution as the person. **v0.6.6 is not to be released while this stays open:** Stage B decides between a clean environment for measurement and refusing measurement where such variables are set, as helper inspection now does.
2. **Promisor packs in an alternate object store** are not listed; `GIT_NO_LAZY_FETCH` (Git 2.45 and later) and `GIT_ALLOW_PROTOCOL` still apply.
3. **A `*` helper command that names an older revision** is not parsed for revisions; a gitlink there is kept out by `--ignore-submodules=all`, `diff.submodule=short` and `submodule.recurse=false`, not by the check. Whether those hold on `log` and `show` is for the real-Git acceptance.
4. **Whether `-c` settings reach a lazy fetch's child process** is not established (one recorded run suggests not). Helper inspection relies on the refusal, not on its `-c` protocol pins.
5. **The helper's real environment and working directory** are the host's. Cockpit takes the Bash tool's environment to be its own and pins the directory with `-C`; neither is observed directly.
6. **A filter check that reads exit 1 as "no filter"** (`config --get-regexp`) is unchanged from 0.6.5; a signal can read as exit 1 where GNU `timeout` is absent. The new check never does this.
7. **Behaviour on real Git** of every pinned argv: tested here only against a fake host that models Git.

## Compatibility

| Situation | 0.6.5 | Stage A |
| --- | --- | --- |
| Ordinary repository | measured | measured; **byte-identical fingerprints** (golden stamps recorded from 0.6.5) |
| Submodule committed at HEAD | fingerprint and release check already UNKNOWN | the same, with the actionable reason; the HUD says `not measured (submodule)` instead of counting submodule changes |
| Gitlink staged in the index only | measured, with Git entering the submodule | UNKNOWN |
| Partial clone (blobless clones, Scalar) | measured; a fetch possible | UNKNOWN everywhere: no goal check accepted, no DONE under ENFORCE, no helper inspection |
| Active filter or unsafe Git inputs (Git LFS with tracked LFS files, say) | fingerprint UNKNOWN; HUD read as "not a repository"; a Stop with no task allowed | fingerprint UNKNOWN; HUD `not measured (…)`; under ENFORCE a Stop with no task asks for the check |
| More than about 45,000 tracked paths (the stage listing passes the host's 4 MiB output cap) | fingerprint already UNKNOWN (its tree listing hits the same cap) | the HUD is refused there too |
| Helper inspection with a relative path after a `cd` | resolved in the helper's shell directory | resolved in the verified session directory |
| A commander command with a submodule option | read-only inspection | an effect (held while a helper owns the repository) |
| Cost | – | about 7 more processes per measurement (4 before, 3 after), 4 per HUD refresh, 5 per helper inspection; see below |

## Latency

Measured on the development host (Linux, Git 2.47.3, Node 22.23.3) by running exactly the added processes through the limit script with `GIT_BOUNDED`, `GIT_SAFE`, `BOUND_ENV` and the pins, against three ordinary repositories: a clone of this repository (236 paths) and synthetic repositories of 2,000 and 20,000 paths. Warm: 200 runs per sequence. Cold: the page cache dropped before each of 40 runs. "Worst tool call" is a fingerprint, a release check and a HUD refresh after one tool call (18 processes). Target: added overhead at the 95th percentile at most 250 ms, at the 99th at most 500 ms.

| Repository | Sequence | Warm p95 / p99 (ms) | Cold p95 / p99 (ms) |
| --- | --- | --- | --- |
| this repository | fingerprint (7) | 32.1 / 33.2 | 37.9 / 56.1 |
| | worst tool call (18) | 78.2 / 82.1 | 85.9 / 91.3 |
| 2,000 paths | fingerprint (7) | 33.0 / 34.1 | 39.4 / 39.6 |
| | worst tool call (18) | 79.0 / 80.6 | 99.4 / 101.3 |
| 20,000 paths | fingerprint (7) | 47.5 / 57.0 | 54.8 / 56.9 |
| | worst tool call (18) | 126.7 / 133.0 | 119.4 / 123.1 |

Within the target. Not included: the host's own cost of starting a process through `$.process.run` (measured at about 2 ms more per process in 0.6.5's research, so about 36 ms for the worst tool call), and waiting for one of the two measurement slots when measurements overlap. With 40 cold runs, the 99th percentile is the maximum.

## Tests

- `tests/git-hardening.test.ts` (99 tests): the admission's forms and the discovery list; the strict parsers (configuration, stage entries, pack markers, the Git version); the pins on every measurement process of a Stop, including one whose caller set its own variables; eight hostile states (a gitlink staged or committed; a promisor remote, `extensions.partialClone`, a partial-clone filter, promisor packs alone; a configuration listing that exits 1; an unlistable pack directory) at each entry point: the Stop guard, a task's baseline and its goal check, the release check, the HUD with a Stop that has no task, wildcard and scoped helper inspection; a gitlink in a revision a scoped command names; each of the 26 environment variables; a state that appears during a measurement; the doctor line; the HUD's words; and fingerprint continuity with 0.6.5.
- Changed on purpose, each with a comment: the submodule settings expected on every Git call (`none` to `all`); `--list` among the read-only configuration forms; the promisor listing among the processes allowed in the no-network test; a FIFO `.gitignore` blocking `ls-files -o` (real Git's listing that reads it) rather than every `ls-files`; the per-Stop Git-call bounds raised by the five calls of the check and its repeat; the rebuilt helper commands (pins, `-C` for `*` commands, `--ignore-submodules=all`) and the cost of a scoped inspection.

## Before release (Stage B and acceptance)

1. Close item 1 above (the inherited Git environment of measurement), as decided.
2. The real-Git acceptance, approved on its own: the candidate's exact argv against hostile fixtures on Git 2.47.3 and a maintenance release below 2.45, and an end-to-end run of the candidate plugin in a real host; with the open questions of items 2 to 5.
3. The TypeScript gate on Claude Code 2.1.296 for the release commit, and the full release gate.
4. An independent review of the release candidate.
