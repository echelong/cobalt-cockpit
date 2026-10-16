# v0.7.0 Diff-Aware Verification: design, and what Phase 1 implements

> Part of the [Cobalt Cockpit documentation](README.md). The milestone: [roadmap-v0.7.0-diff-aware-verification.md](roadmap-v0.7.0-diff-aware-verification.md).

Status: **Phase 1 is implemented as four pure modules that nothing registers or calls.** Cockpit's behaviour is unchanged: no option, hook, command, tool or capability was added, and the published version is still 0.6.5. Everything this page describes beyond those modules is design for later phases, each of which needs its own review and the owner's approval.

| | |
| --- | --- |
| Implemented (Phase 1) | `hooks/diffcov-lcov.ts`, `hooks/diffcov-paths.ts`, `hooks/diffcov-classify.ts`, `hooks/diffcov-capture.ts` and their tests: parsing, path matching, classification, rendering, the recording policy and the binding conditions, all as pure functions over data handed in |
| Designed, not implemented | reading Git and the working tree (Phase 2), the options and the capture around test commands (Phase 3), `/cockpit coverage diff` (Phase 4) |
| Not planned | running tests to obtain coverage, source-map remapping, percentages or thresholds, any effect on gates, DONE, reviews, releases or guards |

## What it is, and what it is not

The six gates say that checks ran and what they reported. They do not say whether the lines a change touched were among the lines its tests ran. This layer answers that narrower question for TypeScript and JavaScript, from an LCOV report, and only when Cockpit watched the test run that wrote the report and can show that the source it reports on is the source that run measured.

It is evidence of a limited kind: a coverage tool's claim about which lines ran, checked against what Cockpit observed, never against what the tests assert. A line that ran is not a line that was checked. It is advisory and opt-in, and it neither blocks nor permits DONE.

## Decisions approved by the owner

| Decision | Approved |
| --- | --- |
| The command | `/cockpit coverage diff` (not registered in Phase 1) |
| Options | three, person-only, all off or empty by default (below) |
| Report size | at most 4 MiB, the host's own read limit; no streaming fallback |
| What a record of a test run may hold | the test program's closed label, the outcome (success only), the main session as provenance, the project's identity, the commit and the source identity, the report's path, hash, size and stat stamps, and closed-vocabulary reasons. Never a command, an argument, an environment variable, a token, output, or report content |
| Runs never recorded | outside the repository root; failed, interrupted or timed out; indistinguishable from failure or timeout; in the background; by a helper agent; not a recognised plain test command; without known, stable revision evidence |
| Platforms | Linux only, proven on a real host; the layer stays off where the memory limit measurement relies on is not enforced (macOS and others until tested) |
| Process limits | the existing v0.6.4 bounded runner, reused; no second limit framework. Any environment sanitisation is designed, tested and reviewed on its own before process execution is integrated |
| Cockpit never runs a test | a repository's test script may write its own coverage; Cockpit never runs it, and never trusts a report because it exists |

### The options (planned for Phase 3, not in the manifest)

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `coverageDiff` | boolean | `false` | Turns the layer on: records around accepted test commands, and the report. Off: neither, and nothing else changes. |
| `coverageDiffReport` | string | empty | The one LCOV file, repository-relative, the layer reads. Empty means none: the layer has nothing to read. No glob, `..`, absolute path, backslash or `.git`; anything else is refused, never repaired (`reportPathOf`). |
| `coverageDiffExclude` | string | empty | Comma-separated path prefixes (whole segments, not globs) whose changed lines are EXCLUDED (`excludePrefixesOf`). |

The archived design named them `diffCoverage*`; they follow the approved command word now. Like the Stop guard's options they would be settable only by a person.

## Facts about the host the design now rests on

Measured on Claude Code 2.1.301 (Linux) with a throw-away probe plugin, before any implementation.

| Fact | Consequence |
| --- | --- |
| `$.fs.read` refuses a file over 4 MiB (also a device reached through a link), follows links, and returns nothing for a FIFO | the report cap is 4 MiB; a no-follow stat must come before the read, and the read length and a second stat must match it (`reportReadVerdict`) |
| `$.process.run` returns each stream as UTF-8 text, at most 4 MiB, flagged when cut; invalid bytes become U+FFFD | Git output is read in batches below the cap; truncation is failure; a name containing U+FFFD is refused |
| `$.process.run`'s environment is laid over the host's own | Phase 2 will need a reviewed environment design before it runs anything |
| `$.session.cwd()` follows the shell's `cd`; `npm` runs a script from the package root and writes paths relative to it | a run is recorded only when it starts in the repository root, and relative report paths resolve against the root |
| A helper's tool calls carry `agentId`; a background call says so at once; a failing command and one ended by its own timeout come back alike | helper and background runs are not recorded; only an answer that shows success field by field is |
| A hook's own budget is 10 s and time spent in `$` calls does not count, but it delays the command one for one | every measurement around a command is bounded by its own deadline |
| The host's `TextDecoder` drops a leading byte-order mark even when asked not to | the parser validates UTF-8 itself and allows a byte-order mark only at the very start of a report |
| A plugin may pass `$` only to top-level functions or to functions in its own files, and never read a noun of `$` as a value | the modules take their runner and reader as parameters; `register.tsx` will hold the only `$` calls |

## What the coverage tools write

Measured on one synthetic TypeScript fixture with pinned versions in disposable directories: Node 22.23.3's test runner, c8 12.0.0, Jest 30.5.2 (babel and v8 providers, Babel 7.29.7) and Vitest 5.0.3 (v8 and istanbul providers, Vite 8.3.1). The fixtures used by the tests (`tests/diffcov-fixtures.ts`) are those reports.

| | Node, c8, Jest v8 | Vitest v8, Vitest istanbul, Jest babel |
| --- | --- | --- |
| Lines with an entry | every line: comments, blank lines and type-only lines included | statements only |
| A multi-line statement that never ran | every line 0 | one line 0, its other lines **no entry** |
| A one-line function whose body never ran | the line reported as run (its declaration ran when the module loaded) | the same, where the line has an entry |
| The line after an ignore comment (`v8`, `c8`, `istanbul`, `node:coverage` `ignore next`, each before a one-line declaration) | Node omitted it after `node:coverage ignore next`; c8 and Jest v8 gave every such line an entry | Vitest v8 omitted it after all four; Vitest istanbul and Jest babel after `istanbul ignore next` only |
| A lone carriage return | Git's numbering | an entry past the file's last line |
| Test files, dependencies, files outside the project | Node lists the test file and an outside file; c8 and Jest v8 by default neither | neither |
| Revision, hash, time, `VER:` | none | none |

So an entry means "the tool reported this line", and a missing entry proves nothing: under the statement tools, lines of code that never ran have no entry. Phase 1 therefore never reads a missing entry as "not executable".

## Phase 1 modules

### `diffcov-lcov`: the parser

A report is untrusted in every byte. It is refused whole on any damage or bound, with a code and a line: an empty or oversized report, invalid UTF-8 (checked by Cockpit, not by a replacing decoder), a byte-order mark anywhere but the start, a control character in a line, a malformed record, a record that does not end, a stray end, more than 8 KiB on a line, 50,000 records, too many entries, or 2 s of parsing. Nothing returns a partial result: a truncated record would turn lines that did not run into lines with no entry.

Only the changed lines it is asked about are kept, merged across records of the same path (a line ran if any record says so); a path named two ways, or only by different letter case, is marked and keeps nothing. The parser hands the event loop back every MiB through an injected `pause`, and reads its clock from an injected `now`.

`reportReadVerdict` states what a reader must have established before the bytes may be parsed: every parent a directory, the report an ordinary file with one hard link, not empty, at most 4 MiB; then exactly as many bytes as the stat gave, and the same stat again afterwards.

### `diffcov-paths`: paths are keys

A path a report names is never opened, stat'ed or resolved. Each `SF:` value is normalised by its text and refused if it is a URL of another host or with an encoded separator, a Windows or network path, another scheme, holds a backslash, a C0 or C1 control or a line or paragraph separator, leaves the repository root, or enters `.git`. Spellings of the root nested in one another resolve nothing. What remains is matched exactly against the paths Git listed as changed. The same module validates the person's path options (no leading `-`, among the rest) and escapes every repository-chosen text before it is shown: controls, format and invisible characters, bidirectional controls, lone surrogates, the backslash, and right-to-left letters, which would reorder the digits beside them, become `\u{…}`.

### `diffcov-classify`: one category per changed line

File rules first: not JS/TS, excluded by the option, generated (attribute or marker in the first five lines), or a line table that differs between Git and JavaScript. Then the line rules, in order:

| Rule | Category |
| --- | --- |
| whitespace only | NON-EXECUTABLE (a fact about the text) |
| the evidence is not bound | UNAVAILABLE, with the binding reason |
| the report was refused | UNAVAILABLE |
| no record for the file | UNAVAILABLE |
| records that name it two ways or by case only | UNTRUSTED |
| an entry past the file's last line | UNTRUSTED |
| a record with no entries | UNAVAILABLE |
| an entry with a positive count | COVERED, "reported as run" |
| an entry with count 0 | UNCOVERED, "reported as not run" |
| no entry | UNAVAILABLE, "the coverage tool gave this line no entry" |

Lines cost far more than bytes: a 4 MiB file of line feeds holds 4,194,304 lines, and classifying one such untracked file made as many verdicts, took about 4.8 s and peaked at 1.27 GiB (measured, before these limits). So the work is bounded by lines and paths, each checked before anything is allocated per line, and refused whole past a limit, never cut short:

| Limit | Value | Past it |
| --- | --- | --- |
| Lines of one changed file (Git's numbering, counted from the bytes) | 100,000 | the file is not read: `SOURCE_TOO_MANY_LINES` |
| Changed lines in the change (added plus modified; all lines of an untracked file; excluded and generated files included) | 200,000 | nothing is classified: `TOO_MANY_LINES` |
| Changed and untracked paths | 20,000 | nothing is classified: `TOO_MANY_FILES` |

Facts about a file's lines (blank, ignore comment) are kept as one bit per line, read in one pass over the bytes, so they take at most an eighth of the file's size. Changed line numbers that do not fit the file's text give the file a row (`CHANGE_OUTSIDE_FILE`) and no verdict. Measured in the host's runtime, inside a memory-capped scope whose idle test runner peaks at about 128 MiB: the 4 MiB file of line feeds is refused in 10 ms (peak 141 MiB); a file at the per-file limit is classified in about 170 ms (246 MiB); a change at the total limit, 200,000 verdicts, in about 340 ms (304 MiB); one line more is refused before a verdict exists.

The last line rule replaces the archived design's "no entry is NON-EXECUTABLE", which the producer measurement showed to be wrong. Every changed path has a file row; deleted lines are counted and have nothing to measure. A file excluded as generated is also listed for review, so a marker in a hand-written file cannot hide it quietly; an ignore comment the change adds is listed for classified files. The tests hold, over seeded random changes and reports that reach every file rule:

- exactly one category per changed line, and every path a row;
- no COVERED or UNCOVERED without bound evidence, and no NON-EXECUTABLE line but a blank one;
- taking any one record out never gives COVERED or UNCOVERED to a line that had neither, except a line that record made UNTRUSTED (with two conflicting records, the one left is used: the conflict was the only doubt), and never changes a blank or excluded line;
- a damaged report is refused, and then every non-blank changed line of a classified file is UNAVAILABLE;
- the same value and the same text for the same input.

The report is rendered in counts, never percentages, and its wording rules are tests: it opens with `advisory: approves nothing` and closes with *ADVISORY ONLY. Execution coverage does not prove assertions or correctness.* and *Nothing here changes a gate, DONE, a review or a release.* (word for word; one line each from 76 columns, wrapped below); no verdict word, gate name or ratio appears in its own text; the MATCHED words appear only for bound evidence, and no figure from the report appears otherwise; every reason is in words, and the advice for a refused report follows its reason; repository text and every header value are escaped; no line is wider than the width from 50 to 120 columns, counted in code points (a wide character takes two terminal columns: a known residual); the review list and the file rows are paged twenty at a time, each with its own count of pages; a width or page that is not a finite number draws at 80 columns, page 1.

### `diffcov-capture`: what may be recorded, and when a report binds

A command is recorded only if its raw text is plain words (no `;`, `&&`, `|`, redirection, `&`, quotes, `$`, backticks, parentheses, globs or `~`), from a closed list (`node --test`, `vitest`, `jest`, `deno test`, `bun test`, `npx`/`bunx`/`pnpm exec` of `vitest` or `jest`, `npm`/`pnpm`/`yarn` `test` or `run` of a script), with no flag that moves the tool's root (an abbreviation of one included: npm ran `npm test --prefi=sub` in `sub`, measured) and, for `npm`, `pnpm` and `yarn`, no option of the manager's own before `--`; read by Cockpit's own classifier as a test; on the main session, in the foreground, from the repository root; and only if the host's answer shows success field by field, holding no field the host does not declare. A script's name is the repository's text and is never stored. A record's time must lie between 2020 and 2100 (a safe integer past 8.64e15 is not a date in JavaScript, and formatting one throws), when it is made and again when it is read back; the report shows any other time as unknown and cannot throw on one.

A report binds to a record only when, in order: the reader accepted it; a record exists for this project and this report path; a record holds exactly these bytes; that run changed the report; the source now is the source that run measured; and it did not change while the report was being made. A rerun that left identical bytes, and bytes identical to an earlier run on another source, are notes beside MATCHED, not refusals: genuine reruns produce both. Eight records are kept per project; older ones fall out, and binding then fails closed.

## Later phases, and what must come first

| Phase | Scope | Before it starts |
| --- | --- | --- |
| 2 | Git selection (hardened diff in batches below the host's output cap, untracked listing, base checks), the source identity, the report reader, all against an injected runner built on the v0.6.4 bounded runner | a fresh adversarial security review of Git integration, source hashing, environment isolation and evidence recording; the owner's approval |
| 3 | the three options, the capture around test commands (its own `tool.call` registration, never refusing a command), the store key, PRIVACY.md and SECURITY.md | Phase 2 reviewed; a differential test that gates, DONE, goal checks, reviews, the Stop guard and release records are identical with the option off and on, and a test that the option off does no work at all |
| 4 | `/cockpit coverage diff`, its help and the implementation notes | an interactive acceptance in a disposable configuration |
| 5 | release candidate | the full release gate, including the TypeScript gate on Claude Code 2.1.296 |

Open for later: several reports in a monorepo; showing branch data; a model-readable form of the report (tool schemas stay unchanged in v0.7.0); capturing `cd <dir> && <command>` or commands with an environment prefix; coverage from CI.
