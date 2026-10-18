# v0.6.6 Git hardening: Stage A (unreleased)

> Part of the [Cobalt Cockpit documentation](README.md). Status: **Stage A, on a feature branch, not released.** The manifest still says 0.6.5; nothing here is published until Stage B and the real-Git acceptance are done and a release is approved.

Two possible gaps were found in the released measurement (0.6.5):

- **Submodules.** Cockpit's `status` and `diff` examined submodules (`diff.ignoreSubmodules=none`, `--ignore-submodules=none`). A submodule's own configuration can make such a command run a program the repository chose (a clean filter, measured on Git 2.47.3 with a patch-shaped diff and with `status`; an earlier run on 2.43.0 with another setup did not reproduce it). The only gitlink check before those commands read one commit's tree.
- **Partial clones.** Nothing kept Git from lazily fetching a missing object, which runs the promisor remote's transport program (measured: a raw diff with a missing base blob ran a repository-configured `uploadpack` program). SECURITY.md already named the fetch as a residual of a helper's `*` inspection.

Each needs write access to the repository's Git configuration, which already gives code execution through the person's own Git use. What Cockpit added was automatic triggering: its hooks measure the tree after every tool call of the main session, at a prompt, at a Stop and for the HUD. Whether the released 0.6.5 argv reaches either state on real Git is not established; Stage A does not depend on it, because it refuses those states before any such command and pins every command.

## What Stage A changes

**Every measurement process (Cockpit's own Git, through `bounded`).**

| Change | Where |
| --- | --- |
| `GIT_NO_LAZY_FETCH=1` and `GIT_ALLOW_PROTOCOL=cockpit-none`, laid over the caller's environment **last**, so no caller can take them back | `BOUND_PINS` (`hooks/git-integrity.ts`), `bounded` |
| `diff.ignoreSubmodules=all` and `submodule.recurse=false` in `GIT_SAFE`; every `status` and `diff` with `--ignore-submodules=all` | `GIT_SAFE`; the release check, the HUD, the fingerprint |
| **Admission** before anything starts: only `git`, `stat`, `find`, `readlink` and `realpath`; `find` only in its two forms (no `-exec`, `-delete` or `-fprint`); for Git, only the pre-subcommand words Cockpit writes (the `-c` settings of `GIT_SAFE` and no other, one `-C`, the three safe flags); a closed discovery list (where the repository and its files are, configuration, `rev-parse --verify HEAD` without a peel, `--version`) runs freely; `status`, `diff`, `ls-files`, `ls-tree`, `hash-object`, `check-attr` and a commit peel need **a pass for their `-C` root**; any other Git subcommand (a fetch, `submodule`, `gc`, another configuration form) is never started. The arguments of an admitted subcommand are Cockpit's own and are not checked again | `admissionRefusal`, `gitCallOf`, `gitAccessOf`, `nonGitAdmitted` |
| The repository-state check (`repoState`): configuration in every scope (`config --null --list`), promisor packs, gitlinks in the index's stage entries, and gitlinks in any commit compared without being measured. Every answer must be complete: a failure, a cut, stderr or a non-zero exit is "unreadable", never "absent". It returns a pass, an object it creates and records in a module-private `WeakSet`; an object with the same fields made anywhere else is refused | `repoState` |
| The clean/process filter drivers come from a complete configuration read: the check's, held in the pass, and a fresh one right before the `status` or `diff` of a fingerprint or a release check. The filter check no longer reads "no filter" from an exit status a signal could have produced | `gitFiltersReliable` |
| The check runs before any state-reading Git command at every measuring routine, and again after a fingerprint or a release check (`repoMoved`): a gitlink, a partial clone or a filter driver that appeared meanwhile gives no answer | the fingerprint, the release check, the HUD, helper inspection |

**A helper's Git inspection (rewritten by Cockpit, run by the host's Bash tool; orchestration only).**

- The same repository check before the command is allowed: the index, and HEAD's tree when HEAD is a commit. Only Git's own words for a repository with no commit yet ("Needed a single revision", read in the C locale) skip HEAD's tree, which does not exist then; any other failure refuses. For a scoped command also each revision it names, after it is proved a commit. A refusal names the reason and points to Read and Grep.
- Refused where Cockpit's environment sets a Git variable that moves where Git looks, what it reads, what it runs or where it writes. This is a list of 34 known names (`GIT_ENV_REFUSED`), read by literal name and only whether set; it is not a sanitised environment (below).
- Every rebuilt command, a `*` one too, is pinned with `-C` to the verified session directory, whatever directory the helper's shell is in, and carries `diff.submodule=short`, `protocol.allow=never` and `never` for each protocol, and `--ignore-submodules=all` on `diff`, `status`, `log` and `show`.
- An option that examines or recurses into a submodule (`--submodule…`, `--ignore-submodules…`, `--recurse-submodules…`, and their abbreviations) is no inspection, in either rule.

**Visibility.** The refusal words are closed (`REPO_REFUSAL_WORDS`), and the two a person can act on say what can be measured instead. The HUD shows `not measured (submodule | partial clone | state unreadable | unsafe Git inputs | active filter)`, never `clean`; a `status` that failed, was cut short or warned on stderr is `state unreadable`, never a count; a refresh that finishes after a newer one does not write over it. The Run Ledger's checkpoint and export record such a tree's change count as unknown. The release check's refusal names a repository Cockpit does not measure among its causes. `/cockpit doctor` names the Git version, as a warning when it is older than 2.45 or unknown.

## Refusal behaviour

| Where | A refused repository gives |
| --- | --- |
| Fingerprint (prompt baseline, goal-check guard, Stop guard) | UNKNOWN with the reason. No baseline; a goal check claimed ALIGNED is recorded UNKNOWN, in every Stop-guard mode; a passing Stop check is not recorded as verified; the task does not read DONE |
| Release check | no candidate (`CANDIDATE UNKNOWN`); no `status` runs |
| HUD | an explicit refused state with its reason |
| Stop with no task and nothing owed (`stopGuard: ENFORCE`) | a possible change: the check runs, its pass is not recorded as verified, and the task is held. The same where no repository could be verified and Git does not say the session is outside every repository (a failure, a timeout, no shell to set limits): only a repository read in full and found clean, or a session outside every repository, stops without a check |
| Helper inspection | denied with the reason; nothing is sent to the host |

Nothing is retried with weaker settings, without the check, or with `--ignore-submodules=none`. A missing object reached anyway (a race, or a state the check could not see) makes Git fail the command instead of fetching (where Git honours the pins), and the answer is UNKNOWN.

## Process-site coverage

`scripts/check-git-callers.mjs` reads the source and compares it with the checked-in census `scripts/git-callers.json`; CI runs it. It reads text, not a syntax tree, so it is a tripwire for review; the runtime admission is the guard. It fails on a new process site, a new `bounded` call, a new call of a closure that runs Git (with literal or computed arguments), any use of the process capability other than a direct `$.process.run(` call, `child_process`, `eval` or a dynamic `import()` in any hooks module, and a broken admission invariant: only `hooks/register.tsx` starts processes, at exactly 11 sites; every program in every `bounded` call is a measurement program; a pass is created only in `repoState`; `auth` is only ever a pass or the check's own listing capability; the helper's environment check reads exactly `GIT_ENV_REFUSED`, in order. (The plugin test runtime imports only the plugin's own modules, so a test cannot read source files.)

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

Git that the host runs as typed is outside Cockpit's execution guarantee: the commander's own commands (Cockpit only decides whether one is held, so a commander's `git status` in a submodule repository can still enter the submodule), any other Bash, every helper's Git when orchestration is off, and Claude Code's own Git calls.

## What Stage A protects, and what it does not

**Protected, as designed and tested against a fake host:** no Cockpit Git command that reads repository state starts in a repository with a gitlink in its index or in a commit compared without being measured, or with any partial-clone configuration or promisor pack; no Git command outside a closed list starts at all; every Cockpit Git process carries the two pins; no `status` or `diff` examines a submodule; a refusal is never a clean tree, an accepted goal check, a verified Stop check, a release candidate or an allowed inspection.

**Not protected by Stage A:**

1. **The inherited Git environment of Cockpit's own measurement processes.** They still start from the host's environment with Cockpit's variables laid over it (no `env -i`). A launch environment that sets `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CONFIG_PARAMETERS`/`GIT_CONFIG_COUNT`, `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`, `GIT_EXEC_PATH`, `GIT_TRACE*`, a relative `PATH` entry or `LD_PRELOAD` changes what Git reads, runs or writes. What already holds: the two pins override any inherited value of theirs; command-line `-c` beats environment configuration for the keys Cockpit pins (measured for `core.fsmonitor` and `core.hooksPath`); the filter and input checks read every configuration scope, the environment's included; a work tree redirected with `GIT_WORK_TREE` or `core.worktree` fails the root verification. Whether `GIT_DIR` alone, without a work tree, does is not established (Git takes the current directory as the top level then): it is for the real-Git acceptance. Setting such variables needs control of the launch environment, which already gives code execution as the person. **v0.6.6 is not to be released while this stays open:** Stage B decides between a clean environment for measurement and refusing measurement where such variables are set, as helper inspection now does.
2. **The helper's environment is checked against a list, not cleaned.** The plugin interface reads an environment variable only by a name written in the source and cannot list the others, and the Bash tool's own shell start-up (profiles, exported functions, `BASH_ENV`) is not visible to Cockpit. Names not on the list (`GIT_CEILING_DIRECTORIES`, `GIT_DIFF_OPTS`, `GIT_TEMPLATE_DIR`, and non-Git ones such as `PATH`, `HOME`, `XDG_CONFIG_HOME`, `LD_PRELOAD`) are not refused. A sanitised launch for helper commands (an `env -i`-style prefix with a fixed `PATH` and `HOME`) is a Stage B decision that needs a host acceptance test, because it changes the command the host's permission rules see.
3. **Helper commands carry weaker lazy-fetch pins than measurement.** Measurement processes get `GIT_NO_LAZY_FETCH` and `GIT_ALLOW_PROTOCOL` as environment variables; a helper's rebuilt command gets only `-c protocol.*.allow=never`, and whether `-c` settings reach a lazy fetch's child process is not established (one recorded run suggests not). Helper inspection relies on refusing a partial clone, not on its pins.
4. **Check-then-use windows.** The check runs before the commands that need it, the filter drivers are read again right before `status` or `diff`, and `repoMoved` stops a fingerprint or a release check that saw a state change; none undoes a command that already ran. A gitlink, promisor remote or filter driver that appears between the last check and a `status` or `diff` of the same measurement is reached by that command, behind the pins only. The HUD has no repeat check. A helper's command is checked when Cockpit sees the call, and the host may run it later (after a permission dialog, say), so that window has no bound. On Git older than 2.45 (and builds without the backported switch), only `GIT_ALLOW_PROTOCOL` stands behind a missed partial clone.
5. **Promisor packs in an alternate object store** are not listed; the pins still apply.
6. **A `*` helper command that names an older revision** is not parsed for revisions; a gitlink there is kept out by `--ignore-submodules=all`, `diff.submodule=short` and `submodule.recurse=false`, not by the check. Whether those hold on `log` and `show` is for the real-Git acceptance.
7. **The helper's real working directory** is the host's. Cockpit pins the directory each command runs in with `-C`; the helper's shell directory is not observed.
8. **The arguments of an admitted Git subcommand** are not checked by the runner: a pass admits `status`, `diff`, `ls-files`, `ls-tree`, `hash-object`, `check-attr` and a commit peel with whatever arguments the caller gives. Every caller is Cockpit's own code with fixed arguments (the census records them), so this matters only for a future caller; per-subcommand argument checks are a Stage B option.
9. **The HUD after a failure before the repository is found** keeps what it showed before (it cannot tell a repository from none then), and a refresh that fails that way does not replace an older one's state. The Stop guard does not rely on the HUD: it uses its own refresh's answer.
10. **A repository with no commit yet and a configured filter driver** (a global Git LFS install, say): helper inspection is refused with the general identity reason, as in 0.6.5, because the filter check lists HEAD's tree.
11. **Behaviour on real Git** of every pinned argv: tested here only against a fake host that models Git.

## Compatibility

| Situation | 0.6.5 | Stage A |
| --- | --- | --- |
| Ordinary repository | measured | measured; **byte-identical fingerprints** (golden stamps recorded from 0.6.5) |
| Submodule committed at HEAD | fingerprint and release check already UNKNOWN | the same, with the actionable reason; the HUD says `not measured (submodule)` instead of counting submodule changes |
| Gitlink staged in the index only | measured, with Git entering the submodule | UNKNOWN |
| Partial clone (blobless clones, Scalar) | measured; a fetch possible | UNKNOWN everywhere: no goal check accepted, no DONE under ENFORCE, no helper inspection |
| Active filter or unsafe Git inputs (Git LFS with tracked LFS files, say) | fingerprint UNKNOWN; HUD read as "not a repository"; a Stop with no task allowed | fingerprint UNKNOWN; HUD `not measured (…)`; under ENFORCE a Stop with no task runs the check and holds the task |
| A Git that fails or times out before the repository is found, or no shell for the limits | a Stop with no task allowed | under ENFORCE a Stop with no task runs the check and holds the task, unless Git says the session is outside every repository |
| A `status` that warns on stderr (an unreadable directory) | counted | HUD `not measured (state unreadable)` |
| More than about 45,000 tracked paths (the stage listing passes the host's 4 MiB output cap) | fingerprint already UNKNOWN (its tree listing hits the same cap) | the HUD is refused there too |
| Repository with no commit yet | helper inspection allowed | allowed (the index is checked) |
| Helper inspection with a relative path after a `cd` | resolved in the helper's shell directory | resolved in the verified session directory |
| A commander command with a submodule option | read-only inspection | an effect (held while a helper owns the repository) |
| Processes | – | per fingerprint or release check: 4 before and 3 after, one fewer for the two filter checks (one reads the configuration again, one no longer reads it) (+6 net, of which +4 are Git); per HUD refresh +3 net; per helper inspection +5 net (a HEAD check and the five of the check, one fewer for the filter check) |

## Latency

Measured on the development host (Linux, Git 2.47.3, Node 22.23.3) by running exactly the added processes through the limit script with `GIT_BOUNDED`, `GIT_SAFE`, `BOUND_ENV` and the pins, and parsing each listing as the plugin does, against four ordinary repositories: a clone of this repository (236 paths) and synthetic repositories of 2,000, 20,000 and 45,000 paths (the last near the stage listing's 4 MiB ceiling: 3.3 MB). The configuration read the filter checks no longer need is not subtracted. Warm: 200 runs per sequence. Cold: the page cache dropped before each of 40 runs, so the 99th percentile is the maximum. "Fingerprint" is one measurement's added processes (7); "worst tool call" is a fingerprint, a release check and a HUD refresh after one tool call (18), which happens only while a release review is pending. Target: added overhead at the 95th percentile at most 250 ms, at the 99th at most 500 ms.

| Repository | Sequence | Warm p95 / p99 (ms) | Cold p95 / p99 (ms) |
| --- | --- | --- | --- |
| this repository | fingerprint | 27.8 / 28.5 | 46.2 / 163.0 |
| | worst tool call | 74.0 / 76.2 | 90.4 / 100.4 |
| 2,000 paths | fingerprint | 34.8 / 36.3 | 43.6 / 49.3 |
| | worst tool call | 90.6 / 92.0 | 78.4 / 87.1 |
| 20,000 paths | fingerprint | 55.8 / 58.2 | 52.3 / 56.6 |
| | worst tool call | 147.2 / 151.6 | 159.8 / 165.3 |
| 45,000 paths | fingerprint | 84.9 / 87.6 | 97.0 / 98.8 |
| | worst tool call | 221.4 / 224.9 | 231.1 / 232.5 |

Within the target as measured. Not included: the host's own cost of starting a process through `$.process.run` and returning its output (estimated at about 2 ms more per process in 0.6.5's research), and waiting for one of the two measurement slots when measurements overlap. With that estimate the worst tool call at 45,000 paths would be about 255 to 265 ms at the 95th percentile, over the target; a fingerprint alone stays under 140 ms. A measurement through a real host is part of the acceptance. The stage listing's parser reads the text in one pass (9.6 ms at the 95th percentile for 45,000 paths, where a pattern per record took 21 ms).

## Tests

- `tests/git-hardening.test.ts` (118 tests): the admission's forms, the closed Git and `find` lists and the discovery list; the strict parsers (configuration, stage entries, pack markers, filter drivers, the Git version); the pins on every measurement process of a Stop, including one whose caller set its own variables; eight hostile states (a gitlink staged or committed; a promisor remote, `extensions.partialClone`, a partial-clone filter, promisor packs alone; a configuration listing that exits 1; an unlistable pack directory) at each entry point: the Stop guard, a task's baseline and its goal check, the release check, the HUD with a Stop that has no task, wildcard and scoped helper inspection; a failed, cut or noisy `status`, a Git that does not answer, no shell, and the control outside every repository; the Run Ledger's checkpoint; a gitlink in a revision a scoped command names; a repository with no commit yet, and a HEAD that fails otherwise; each of the 34 environment variables; a gitlink, a promisor pack or remote, or a filter driver that appears during a measurement, and a filter driver caught before the diff; the doctor line; the HUD's words; and fingerprint continuity with 0.6.5.
- Changed on purpose, each with a comment: the submodule settings expected on every Git call (`none` to `all`); `--list` among the read-only configuration forms; the promisor listing among the processes allowed in the no-network test; a FIFO `.gitignore` blocking `ls-files -o` (real Git's listing that reads it) rather than every `ls-files`; the per-Stop Git-call bounds raised by four (five Git calls of the check and its repeat, one fewer for the filter checks); the rebuilt helper commands (pins, `-C` for `*` commands, `--ignore-submodules=all`) and the cost of a helper inspection.

## Before release (Stage B and acceptance)

1. Close item 1 above (the inherited Git environment of measurement), and decide items 2 and 8 (the helper's environment; argument checks), as you choose.
2. The real-Git acceptance, approved on its own: the candidate's exact argv against hostile fixtures on Git 2.47.3 and a maintenance release below 2.45, the open questions of items 1, 3, 4 and 6, and an end-to-end run of the candidate plugin in a real host, which also measures latency with the host's own cost.
3. The TypeScript gate on Claude Code 2.1.296 for the release commit, and the full release gate.
4. An independent review of the release candidate.
