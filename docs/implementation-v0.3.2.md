# Cobalt Cockpit v0.3.2 — Directory compliance

Starting SHA: `2a8f884` (Leave the main loop's effort to the host). Plugin and
marketplace version are now 0.3.2. Branch: `release/0.3.2-directory-compliance`.
v0.3.1 stays where it is: its tag, its docs and its manifest are untouched.

This release changes what a directory scanner can see, and one thing a person
can rely on: a hook of Cockpit's that fails now refuses in its place instead of
being skipped. Nothing else about the runtime changed, and the suite that proves
it went from 960 to 976.

## What the portal reported, and what could be reproduced here

The portal reported 2 blocking issues, 7 warnings and 13 policy holds, with the
categories **Skills, agents, commands, hooks** and **Directory lints** failing,
and **Fetch source**, **Unpack and size limits** and **MCP servers and directory
match** passing.

Only part of that is reproducible with the tools on this machine. The portal's
checks run behind claude.ai/directory/manage; `claude plugin validate` (Claude
Code 2.1.294) is a strict subset of them, and it passed on v0.3.1 and on
`2a8f884` too: no errors, no warnings, and 17 gating hooks reported without a
`.catch` handler. Everything below is either reproduced locally or named as
something this machine cannot decide. Nothing here is a guess presented as a
measurement.

### Finding matrix

| # | Finding | Result | File and line | Root cause | Required action | Behaviour change | Verification |
| - | - | - | - | - | - | - | - |
| 1 | An unescaped invisible character in the hooks module | Blocking (the portal's "invalid or unescaped character") | `hooks/policy.ts:36`; also `tests/policy.test.ts:50`, `:51` | Six format code points were typed literally into a regex character class — U+00AD, U+200B, U+200F, U+2060, U+2064, U+FEFF — and two into test strings (U+200B, U+2060). They are invisible in a diff, and U+200B–U+200F and U+2060–U+2064 are exactly what a look-alike name hides behind. They are the only format characters in any tracked file: the other non-ASCII code points are the HUD's own visible glyphs (box drawing, blocks, arrows), the CJK and emoji fixtures, and dashes in prose | Write the same ranges as escapes: `\u00AD\u200B-\u200F\u2060-\u2064\uFEFF`, and the test strings as `'fa\u200Bble'` and `'claude-\u2060fable'` | None. The regex selects the same code points and the strings hold the same values | `python3 scripts/audit-public.py` (new check), the policy tests, and a code-point inventory of every tracked file |
| 2 | 17 hooks that can refuse an action had no `.catch` handler | Blocking (hooks) — and a real fail-open, not a lint | Every gating registration in `hooks/register.tsx`: `classic.SessionStart` :1504, `park` :1510, `ledger` :1515, `replay` :1523, `prompt.submit` :1669, `init` :1713, `tool.call` :1765, `tool.check` :1845, `agent.offer` :1864, `agent.spawn` :1878, `config.set` :2093, `model` :2113, `effort` :2124, `advisor` :2140, `login` :2156, `logout` :2166, `classic.PostToolUse` :2176 | The engine skips a hook that throws, times out or answers a wrong shape, and runs the hooks beneath in its place. For a guard that is fail-open: a failure in the blast-radius guard, the Fable guard or the ownership guard let the call through. The engine's own declarations say so where `Registration` is declared: "A guard that fails is skipped… so give it `.catch(($, e, next) => next.called ? next(e) : { deny: \"no\" })`" | Attach one handler per hook, of the shape the engine documents for that event, refusing only where that hook really guards | Yes, deliberately, and only on the failure path: where a failed hook used to be skipped, the refusal it would have made now stands. Observers keep forwarding, because refusing a person's command or prompt over a lost reading is not a guard | `claude plugin validate --strict --json .` now lists 17 gating hooks, every one `hasCatch: true`; 16 new tests in `tests/compliance.test.ts` invoke each handler |
| 3 | The name `next` used for things that are not pass-throughs | Warning (hooks) | `hooks/register.tsx`: `savePrefs(next: Partial<Prefs>)` :2251, `agentSvgCache.keys().next()` :2551, and `const next`/`let next` in `serveSwarm`, `probeAuth`, `refreshGit`, `setMeter`, `noteEnd`, `adoptLedgerAgents`; `key="next"` in the Replay pane; `hooks/swarm.ts` in `submitTask`, `admitTask` and `markStalled` | A scanner that looks for the pass-through parameter by name finds it used for a preferences patch, an iterator step, a React key and swarm accumulators — inside hook bodies, which is the worst place for it | Rename every one: `patch`, `chain`, `assignedSwarm`, `fresh`, `state`, `moved`, `reserved`, `stalled`, `advance`; the iterator step became a `for…of` over the oldest key | None. Every rename is local, and the iterator change deletes the same key | 976 tests, `tsc -p .`, and the new audit check that refuses `const next`, `let next` or `.next(` in the hooks module |
| 4 | Pass-throughs handed the engine a copy of the event | Warning (hooks) | `hooks/register.tsx`: `tool.call` :1765 (`next(call)`), `agent.spawn` and `prompt.submit` (ternary arguments) | `tool.call` copied the event once, up front, because the guards, the effort policy and the read-only shell rewrite may change it — and then handed on the copy even when nothing had changed | `tool.call` forwards the engine's own event when `isChanged()` is false and the copy when it is true; the two ternaries became explicit branches whose unchanged arm is a literal `next(e)` | One refinement: an untouched call reaches the engine as the frozen event it raised, which is what the mods reference defines `next(e)` to mean. The content is the same either way | `tests/compliance.test.ts`: an untouched Bash call arrives frozen (`Object.isFrozen`), and the effort-rewritten Agent call still carries its level |
| 5 | `types` in `plugin.json` reported as unsupported | Warning (claimed) | `.claude-plugin/plugin.json` | None. `types` is a documented plugin-manifest field for a mod: "A `.d.ts` file that declares the `$.state` values and `$` nouns of a mod". `claude plugin validate` reads the file and prints what it declares. The mod keeps 19 values in `$.state`, so the file is required | Keep it. Removing it would delete the declaration of every value the plugin keeps across a reload | None | `claude plugin validate --strict .` prints the two `types` notes and passes; the manifest table of the plugins reference |
| 6 | Two bundled `.wav` cues | Held for a reviewer | `assets/sounds/checkpoint.wav` (16 KiB), `complete.wav` (72 KiB) | The file rules accept text, SVG, PNG, JPEG, GIF, WebP and fonts. A WAV is a binary the validator will not inspect, so it is held — both the file and the README's reference to its generator | Keep them. They are optional, local, generated by the pinned script beside them, and removing working audio to clear a hold would trade a real feature for a report line | None | The checklist row "Include only text files, SVG included, complete PNG…"; documented here and in `docs/marketplace-submission.md` |
| 7 | Cockpit asks whether `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are set | Held for a reviewer | `hooks/register.tsx`, `probeAuth`, sites :822–:829 | The subscription-only policy and `/cockpit auth` need to know *how* the session authenticates. Each variable is read by literal name and reduced on the spot by `value !== undefined && value !== ''`; only the name survives, in a fixed table. Nothing is stored, logged, exported or sent, and no HTTP hook or fetch exists to send one | Keep, and disclose it in the README and `SECURITY.md`. Dropping the API-auth diagnostic and the `subscriptionOnly` refusal would remove a user-facing safety feature to clear a hold | None (documentation only) | The external-behaviour inventory below, and `SECURITY.md` |
| 8 | No listing icon | Blocks the listing, not the code | no such file exists | No approved Cobalt Cockpit raster asset exists in the repository, and none may be invented: the portal may keep the first icon saved, so this is a branding decision | An owner-supplied 512–2048 px square PNG or JPEG under 2 MB, at `.claude-plugin/icon.png` and named by `icon` in `plugin.json`. The identity already exists as code — the operator VECTOR, drawn in `hooks/mascot.ts` — but not as a raster in that format | None | A search of the repository and the neighbouring projects: no PNG, JPEG, SVG or ICO for this plugin |
| 9 | `turn.step`'s pass-through is `yield* next(constrained)` | Not reproduced | `hooks/register.tsx:1981`, with `constrained` set at :2009, :2024 and :2028 | `turn.step` hooks are async generators, and the reference gives `yield* next(e)` and `next({ ...e, model })` as the two forms. `constrained` is the identical object when no rewrite was made, and a copy naming the resolved model when one was | No change. Rewriting it to satisfy a lexical rule would add a no-op expression to the most safety-critical hook in the module | None | The mods reference, "Hooks on `turn.step` and `process.spawn` are async generators"; a registration-by-registration audit of all 31 found this the only structurally unusual one |
| 10 | `Connector.next` in the shell parser, and other helper-module `next` names | Not reproduced | `hooks/shell.ts:22`, `:237`–`:243`, `:297`; `hooks/classify.ts:125`–`:127`; `hooks/effort.ts:140`; `hooks/field.ts:171`; `hooks/model.ts:232` | A parsed pipeline's join to the next one is a field named `next`, documented as such; the other sites are locals in pure functions. None is a hook registration and none calls `next(...)`. `parseShell` is the reader the blast-radius guard trusts | No change. Renaming a field of the security-critical shell parser buys a scanner nothing and puts the guard at risk | None | The static audit: every `next(` call in the repository is in `hooks/register.tsx` |
| 11 | `claude plugin validate`'s notes | Note | `hooks/hooks.json`, `plugin.json` | The validator prints the hook list, the environment reads, the state keys and the mods API calls it found, plus one line — `./register.tsx answers its own command: command.run{command=cockpit}` — for a plugin registering a command and answering that same command, which is what a plugin command is | No action | None | `claude plugin validate --strict .` passes with exit 0 |

### What could not be reproduced

- **The portal's exact list of 2 blocking issues, 7 warnings and 13 holds.** The
  portal's report text is not on this machine, and its checker is not the same
  program as `claude plugin validate`. Rows 1 and 2 are named from the portal's
  own wording ("an invalid or unescaped character") and from the checklist's
  rules; rows 5–8 are decidable from the checklist and this repository's files.
- **Which findings the portal classes as warnings rather than holds.** The
  vocabulary ("Blocks", "Held for a reviewer", "Warning", "Note") is documented;
  the assignment of a given finding is not.
- **Whether the portal reads only `hooks/register.tsx` or every file under
  `hooks/`.** The audit covers both readings: the module and its 24 helpers were
  searched exhaustively for `next` and for non-ASCII code points.
- **Whether an unrecognised model id in `agents/*.md` is a finding for the
  portal.** `claude plugin validate --strict agents` passes with nothing to
  report, and each file's front matter is valid YAML with `description` as one
  text value.


## The 17 handlers, and what each one does

"Refuses" means the handler answers with the decision the hook itself would have
made; "forwards" means the action goes on as the engine decided, because the
hook only watched it. The `next.called` guard is the engine's rule that a hook
which already passed the event on leaves that result standing.

| Event | Handler's decision | Why that is the honest one |
| - | - | - |
| `tool.call` | Refuses, with the failure named | The blast-radius guard, the ownership guard and the read-only rule all live here, and a skipped `tool.call` hook runs the tool |
| `agent.spawn` | Refuses | Ownership admission, the dependency check and the model choice live here |
| `agent.offer` | Withholds, while `blockFable` or `cobaltStrict` is on | Withholding is what this hook does; with the switch off it holds no decision, so it forwards |
| `config.set` | Refuses, while `blockFable` or `cobaltStrict` is on | A `/config` row that names Fable must not be written; with both switches off the hook only watched |
| `command.run{model}` | Answers with the block line, while `blockFable` is on | The command must not reach the engine and change the session's model |
| `command.run{advisor}` | Answers with the strict refusal, under `cobaltStrict` only | The refusal is this hook's only in the preset; otherwise it watched the command |
| `park` | Answers that nothing was parked | `/park` writes a checkpoint, and a silent failure would read as success |
| `ledger`, `replay` | Answer that nothing was read | They only draw, but a silent empty answer reads as "nothing recorded" |
| `classic.SessionStart` | Forwards | It restores bookkeeping; the session must start either way |
| `prompt.submit` | Forwards | The person's prompt is not Cockpit's to drop over a lost reading |
| `command.run{init}` | Forwards | `/init` is the person asking for a CLAUDE.md, and the hook only notes it |
| `command.run{effort}`, `command.run{login}`, `command.run{logout}` | Forward | Each only notes or re-reads something after the engine's own command ran |
| `tool.check` | Forwards | It watches the verdict the engine reached. Refusing here would block every tool call over a drawing bug. The engine's advice for a guard on this event (`{ decision: 'deny' }`) is right for a hook that decides, and this one does not |
| `classic.PostToolUse` | Forwards | The tool call already ran; the hook records what the engine reported |

## What the hooks do to a session, by kind

| Kind | Hooks | What it is |
| - | - | - |
| Observes only | `session.start`, `session.end`, `turn.start`, `turn.complete`, `session.measure`, `classic.PostToolUse`, `command.run{init}`, `command.run{effort}`, `command.run{login}`, `command.run{logout}`, `tool.check`, `ui.render` (all five sites) | Reads state, draws, records. Each answer it gives is the engine's own |
| Modifies | `prompt.compose` (adds the discipline, hygiene, safety and policy sections to the system prompt), `prompt.submit` (adds one task-status line to the request's context), `attribution.text` (empties the engine's commit/PR attribution while the guard is on), `agent.spawn` (names the model of an admitted subagent when it differs), `turn.step` (names the model, and a subagent's reasoning level, while orchestration is on), `tool.call` (a subagent's read-only `git` calls get `--no-pager --no-ext-diff --no-textconv`) | Changes the event it passes on, never a permission rule |
| Refuses | `tool.call` (blast radius, attribution, ownership, wildcard scope, serialization), `agent.spawn` (ownership, dependency, resource admission, Fable), `agent.offer` (Fable), `config.set` (Fable rows, the strict advisor row), `command.run{model}`, `command.run{advisor}` (Fable, the strict advisor), `turn.step` (Fable, API authentication under `subscriptionOnly`, the strict advisor, cancellation) | Returns `{ deny }`, `{ isOffered: false }` or the block line. Nothing is sent and nothing runs |
| Asks | `tool.call` puts the blast-radius question to the person through the engine's own dialog (`$.ui.ask`) before a destructive command runs, and asks before a `CLAUDE.md`/`AGENTS.md` is created unasked. The person's answer decides the call | Cockpit draws around the engine's dialog and never answers it |
| Changes configuration | `config.set` (refuses), `command.run{cockpit}` (writes its own two preferences, HUD and mute, through `$.store`) | No `/config` row is written by Cockpit: the suite asserts `w.configured` stays empty, and the pane's Refresh button only reads |


## External behaviour and local process invocations

Every path out of the plugin, as measured from the source in this release. "No"
in the Leaves column means nothing leaves this computer.

| What | Where | Why | Leaves? | Approval | Optional |
| - | - | - | - | - | - |
| `fs.stat`, then `fs.read` (or `tail -c 524288`) on the decision-router ledger every 1200 ms, from the end of the file | `pollLedger`, `resolveLedger` | Optional Local Control telemetry, read-only, for the HUD | No | none | yes — `localControl` (default true) and `ledgerPath`; it stops after repeated failures, and never replays history |
| Reading a file about to be written | `ledgerBeforeWrite`, `guard` | A bounded before/after for the replay snapshot; deciding whether a `CLAUDE.md` write would create a file | No | none | yes — sensitive names and oversized files are dropped |
| `realpath -m -- <path>` (2 s) | `canonicalResource` | Canonicalize a model-supplied owned resource so ownership cannot be fooled by `..` or a symlink | No | none | yes — orchestration only |
| `tail -c <bytes> -- <path>` (2 s) | `pollLedger` | Read only the tail of a ledger larger than 512 KiB | No | none | yes — as the ledger read |
| `git --no-optional-locks status --porcelain=v2 --branch`, `git rev-parse --show-toplevel` (6 s each) | `refreshGit` | The HUD's branch, HEAD and change counts | No | none | no; a failure leaves the HUD as it was |
| One of nine audio players, in order: `pw-play`, `paplay`, `aplay`, `ffplay`, `mpv`, `play`, `canberra-gtk-play`, `afplay`, then `sh -c 'printf "\a" > /dev/tty'` (5 s each) | `sound`, `attempt`, `ASSETS` | Play the two cues from `assets/sounds/` | No | none | yes — `sounds` (default true), `volume`, `/cockpit mute` |
| Environment reads by literal name: `CLAUDE_CODE_EFFORT_LEVEL`, `XDG_STATE_HOME`, `HOME`, `COBALT_REDUCED_MOTION` | `hostSignals`, `resolveLedger`, `session.start` | The main loop's effort origin, the ledger path, the guard's home comparison, reduced motion | No | none | no |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_MANTLE`: presence only | `probeAuth` | Whether the session is on API-style authentication, for `subscriptionOnly` and `/cockpit auth` | No — each value is reduced on the spot by `value !== undefined && value !== ''` and only the name is kept | none | no |
| `$.settings.read()` | `probeAuth`, `hostSignals` | The advisor setting, the environment block's names, the saved effort level and cap | No | none | no |
| `$.store` (the host's plugin store, on disk) | `persist`, `checkpoint`, the `/cockpit` preferences | Up to eight bounded run ledgers, bounded replay bodies, checkpoints, and the two preferences | No | none | yes — uninstalling the plugin clears it |
| `$.session.authorize`, `$.session.usage`, `$.session.model`, `$.agent.list`, `$.config.list`, `$.ui.*` | throughout | The engine's own readings for the HUD and the pane | No | none | no |
| `prompt.compose` and `prompt.submit` | `register.tsx` | The discipline, safety and policy sections of the system prompt, and one task-status line | They ride the engine's own model request as part of the prompt | the prompt is the person's | follows the guards that own them |
| Network | — | No `$.http.fetch`, no `$.model.*`, no `$.mcp.*`, no `fetch`, no WebSocket, no dynamic import, no `eval`, no `Function`, no `require`, no `child_process`, no `process.env` anywhere in the plugin | No | — | — |

The suite holds the last row: `tests/world.ts` records every way out to a model
or the network into `w.outbound`, and the public-release tests assert it stays
empty.


## The two bundled cues

`assets/sounds/checkpoint.wav` (16 KiB) and `complete.wav` (72 KiB) are
synthesized 16-bit mono PCM at 44.1 kHz: one quiet 660 Hz blip, and a rising
three-note bell figure at 523.25, 783.99 and 1046.50 Hz, each with a 4 ms attack
and an exponential decay, normalized and written by `assets/sounds/make-sounds.py`
(Python standard library only: `math`, `struct`, `sys`, `wave`). Nothing writes a
WAV at runtime: the plugin reads the two paths and hands them to a player. They
are optional cues, and they stay bundled — the hold is a reviewer's question
about an uninspectable binary, and this document, the generator beside them and
`docs/marketplace-submission.md` are the answer to it.

## The listing icon

No icon is added. The portal wants a square PNG or JPEG, 512–2048 px a side,
under 2 MB, at `.claude-plugin/icon.png` or at a path named by `icon` in
`plugin.json` (Claude Code ignores that field; the directory reads it). No
approved Cobalt Cockpit raster exists in this repository, and one must not be
invented: the portal may keep the first icon saved, so the visual identity is the
owner's decision. The identity itself already exists — the operator VECTOR, drawn
in code in `hooks/mascot.ts` — so what is missing is a raster in that format, not
a design.

## Regression results

- `claude plugin test .` — 976 pass, 0 fail across 23 files (960 before this
  release; 16 added here).
- `tsc -p .` — clean.
- `claude plugin validate --strict .` — exit 0; no errors, no warnings, and 17
  gating hooks each with a handler.
- `claude plugin validate --strict --json .` — 0 errors, 0 warnings; notes only.
- `claude plugin validate --strict agents` — passes with nothing to report.
- `claude plugin validate .` on `hooks/` alone — not a plugin folder, and it says
  so ("No manifest found in directory"); the module is validated with the plugin.
- `python3 scripts/audit-public.py` — 76 files, 1,096,713 bytes, no portability,
  credential or format-character findings.
- `git diff --check` — no whitespace errors.

`tests/compliance.test.ts` holds: all 17 handlers exist; the tool guard refuses
with the failure named; a guard that already passed the call on leaves that
result standing; the agent-admission guard refuses; each conditional guard
refuses only under its own switch; every watcher forwards; an untouched tool call
reaches the engine frozen; an effort-rewritten Agent call arrives as the copy
that carries the level; and a prompt with no task carries no context.

## How to run the portal's own validation

1. Push the branch (or the merged commit), and make the repository public before
   the listing goes live.
2. Open [claude.ai/directory/manage](https://claude.ai/directory/manage), choose
   **Submit new**, then **Plugin bundle**.
3. Enter the repository and the plugin path (the repository root here), then
   select **Validate**. The report covers the commit it read; after a fix, push
   and select **Re-validate** on the same form.
4. Read the result against the tables in the
   [pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist),
   and fix every row marked **Blocks**.
5. Only the portal decides the names, holds and category results. Nothing on this
   machine reproduces the full scan, and this document does not claim it does.

## Residual holds and what a reviewer will read

- Two uninspectable WAV files (row 6).
- The presence-only reads of two authentication variables (row 7), disclosed in
  the README and `SECURITY.md`.
- The name, if "cobalt-cockpit" or "Cobalt Cockpit" is read as close to another
  publisher's. Not decidable here.
- No icon (row 8). A listing cannot go live without one.

## Why the handlers do not raise the supported version

`.catch` is part of `on`'s registration in the mods API, and every hook in this
release uses it. Cockpit still supports Claude Code 2.1.287, its documented
minimum, because `.catch` predates the version whose documentation this release
was written against: the mods reference introduces `on` as returning "a
registration with one method, `.catch(handler)`" with no version note, while the
events that do carry one say so explicitly ("`prompt.mention` … Requires Claude
Code v2.1.290 or later"). The Claude Code changelog's `.catch` entries under
2.1.290 and 2.1.292 are fixes and a validator addition — "Fixed a plugin hook
with a `.catch` being unloaded, and its `.catch` skipped…" and "Added to
`claude plugin validate`: each hook a mod registers at a gating site is listed
with whether it has a `.catch`" — not an introduction. A load-time call that the
engine did not understand would fail the module, so this mattered; it is stated
here because it cannot be measured on an older engine from this machine.

## Changed files

- `hooks/register.tsx` — 18 `.catch` handlers on the 17 gating hooks; explicit
  branches for the pass-throughs of `tool.call`, `agent.spawn` and
  `prompt.submit`; `isChanged` on `tool.call`; `agent.offer` and
  `attribution.text` as block-bodied hooks with explicit returns; every
  identifier named `next` that was not a pass-through renamed; the Replay pane's
  Next button keyed `advance`.
- `hooks/policy.ts` — the invisible-character class written as escapes.
- `hooks/swarm.ts` — `next` locals renamed in `submitTask`, `admitTask` and
  `markStalled`.
- `tests/policy.test.ts` — the two invisible characters written as escapes.
- `tests/compliance.test.ts` — new; 16 tests.
- `scripts/audit-public.py` — the format-character check, the hooks-module
  checks, the engine-generated declarations excluded, version 0.3.2.
- `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — version
  0.3.2.
- `README.md`, `SECURITY.md`, `CHANGELOG.md`, `docs/implementation-v0.3.2.md`.

