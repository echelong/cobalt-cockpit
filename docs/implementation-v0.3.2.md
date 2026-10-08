# Cobalt Cockpit v0.3.2 — Directory compliance

Starting SHA: `2a8f884` (Leave the main loop's effort to the host). Plugin and
marketplace version are now 0.3.2. Branch: `release/0.3.2-directory-compliance`.
v0.3.1 stays where it is: its tag, its docs and its manifest are untouched.

This release changes what a directory scanner can see, and one thing a person
can rely on: a hook of Cockpit's that fails now answers in its place instead of
being skipped. Nothing else about the runtime changed, and the suite that proves
it went from 960 to 980.

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
| 1 | An unescaped invisible character in the hooks module | Blocking (the portal's "invalid or unescaped character") | `hooks/policy.ts:36`; also `tests/policy.test.ts:50`, `:51` | Six format code points were typed literally into a regex character class — U+00AD, U+200B, U+200F, U+2060, U+2064, U+FEFF — and two into test strings (U+200B, U+2060). They are invisible in a diff, and U+200B–U+200F and U+2060–U+2064 are exactly what a look-alike name hides behind. They are the only format characters in any tracked text file (the two `.wav` cues are binary, and the validator holds them for that reason; no source file is): the other non-ASCII code points are the HUD's own visible glyphs (box drawing, blocks, arrows), the CJK and emoji fixtures, and dashes in prose | Write the same ranges as escapes: `\u00AD\u200B-\u200F\u2060-\u2064\uFEFF`, and the test strings as `'fa\u200Bble'` and `'claude-\u2060fable'` | None. The regex selects the same code points and the strings hold the same values | `python3 scripts/audit-public.py` (new check), the policy tests, and a code-point inventory of every tracked file |
| 2 | 17 hooks that can refuse an action had no `.catch` handler | Blocking (hooks) — and a real fail-open, not a lint | Every gating registration in `hooks/register.tsx`: `classic.SessionStart` :1518, `park` :1524, `ledger` :1529, `replay` :1537, `prompt.submit` :1683, `init` :1744, `tool.call` :1796, `tool.check` :1876, `agent.offer` :1895, `agent.spawn` :1909, `config.set` :2131, `model` :2154, `effort` :2166, `advisor` :2182, `login` :2201, `logout` :2211, `classic.PostToolUse` :2221, and the `cockpit` command at :2294 (added by this release's own rule; the validator lists it as gating too) | The engine skips a hook that throws, times out or answers a wrong shape, and runs the hooks beneath in its place. For a guard that is fail-open: a failure in the blast-radius guard, the Fable guard or the ownership guard let the call through. The engine's own declarations say so where `Registration` is declared: "A guard that fails is skipped… so give it `.catch(($, e, next) => next.called ? next(e) : { deny: \"no\" })`" | Attach one handler per hook, of the shape the engine documents for that event, refusing only where that hook really guards | Yes, deliberately, and only on the failure path: where a failed hook used to be skipped, the refusal it would have made now stands. Observers keep forwarding, because refusing a person's command or prompt over a lost reading is not a guard | `claude plugin validate --strict --json .` now lists 18 gating hooks, every one `hasCatch: true`; the 20 tests in `tests/compliance.test.ts` exercise the handlers, and each conditional one is judged against the event it was given |
| 3 | The name `next` used for things that are not pass-throughs | Warning (hooks) | `hooks/register.tsx` and `hooks/swarm.ts`, at the identifiers this release renamed: the preferences patch a `command.run{cockpit}` helper took (`(next: Partial<Prefs>)`, now `patch`), the SVG cache's `agentSvgCache.keys().next()` (now a `for…of` over the oldest key), the swarm accumulators that shadowed the name (`admitTask`'s and `markStalled`'s locals, now `moved`, `reserved` and `stalled`), and `const next`/`let next` in `serveSwarm`, `probeAuth`, `refreshGit`, `setMeter`, `noteEnd` and `adoptLedgerAgents`; plus `key="next"` on the Replay pane's Next button (now `advance`) | A scanner that looks for the pass-through parameter by name finds it used for a preferences patch, an iterator step, a React key and swarm accumulators — inside hook bodies, which is the worst place for it | Rename every one, as listed | None. Every rename is local, and the iterator change deletes the same key | 980 tests, `tsc -p .`, and the audit check that refuses `const next`, `let next` or `.next(` in the hooks module |
| 4 | Pass-throughs handed the engine a copy of the event | Warning (hooks) | `hooks/register.tsx`: `tool.call` :1796, whose pass-through is `next(isChanged() ? call : e)` :1846; `agent.spawn` and `prompt.submit` (ternary arguments) | `tool.call` copied the event once, up front, because the guards, the effort policy and the read-only shell rewrite may change it — and then handed on the copy even when nothing had changed. Only two places write to that copy: `launchEffort`'s `call['effort']` and the read-only Bash rewrite's `call['command']`, and `isChanged` compares every key, so neither can be missed | `tool.call` forwards the engine's own event when `isChanged()` is false and the copy when it is true; the two ternaries became explicit branches whose unchanged arm is a literal `next(e)` | One refinement: an untouched call reaches the engine as the event it raised, which is what the mods reference defines `next(e)` to mean. The content is the same either way | `tests/compliance.test.ts` asserts the fields that reach the engine, and the effort-rewritten Agent call still carries its level. The identity itself is not observable through the test kit — it freezes what it hands the bottom hook — so that half rests on the reference's definition, and this document says so rather than claiming a test for it |
| 5 | `types` in `plugin.json` reported as unsupported | Warning (claimed) | `.claude-plugin/plugin.json` | None. `types` is a documented plugin-manifest field for a mod: "A `.d.ts` file that declares the `$.state` values and `$` nouns of a mod". `claude plugin validate` reads the file and prints what it declares. The mod keeps 19 values in `$.state`, so the file is required | Keep it. Removing it would delete the declaration of every value the plugin keeps across a reload | None | `claude plugin validate --strict .` prints the two `types` notes and passes; the manifest table of the plugins reference |
| 6 | Two bundled `.wav` cues | Held for a reviewer | `assets/sounds/checkpoint.wav` (16 KiB), `complete.wav` (72 KiB) | The file rules accept text, SVG, PNG, JPEG, GIF, WebP and fonts. A WAV is a binary the validator will not inspect, so it is held — both the file and the README's reference to its generator | Keep them. They are optional, local, generated by the pinned script beside them, and removing working audio to clear a hold would trade a real feature for a report line | None | The checklist row "Include only text files, SVG included, complete PNG…"; documented here and in `docs/marketplace-submission.md` |
| 7 | Cockpit asks whether `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are set | Held for a reviewer | `hooks/register.tsx`: `isSet` :828, the eight reads :829–:836 | The subscription-only policy and `/cockpit auth` need to know *how* the session authenticates. Each variable is read by literal name and reduced on the spot by `value !== undefined && value !== ''`; only the name survives, in a fixed table. Nothing is stored, logged, exported or sent, and no HTTP hook or fetch exists to send one | Keep, and disclose it in the README and `SECURITY.md`. Dropping the API-auth diagnostic and the `subscriptionOnly` refusal would remove a user-facing safety feature to clear a hold | None (documentation only) | The external-behaviour inventory below, and `SECURITY.md` |
| 8 | No listing icon | Blocks the listing, not the code | no such file exists | No approved Cobalt Cockpit raster asset exists in the repository, and none may be invented: the portal may keep the first icon saved, so this is a branding decision | An owner-supplied 512–2048 px square PNG or JPEG under 2 MB, at `.claude-plugin/icon.png` and named by `icon` in `plugin.json`. The identity already exists as code — the operator VECTOR, drawn in `hooks/mascot.ts` — but not as a raster in that format | None | A search of the repository and the neighbouring projects: no PNG, JPEG, SVG or ICO for this plugin |
| 9 | `turn.step`'s pass-through is `yield* next(constrained)` | Not reproduced | `hooks/register.tsx:2119` (registered at :2012), with `constrained` set at :2066, :2082 and :2086 | `turn.step` hooks are async generators, and the reference gives `yield* next(e)` and `next({ ...e, model })` as the two forms. `constrained` is the identical object when no rewrite was made, and a copy naming the resolved model when one was. The hook has no `.catch` handler: for a streaming event the handler must itself be a generator, and the engine's rule for a failure there is unverified from this machine | No change to the pass-through. Instead the three readings this hook makes *before* it decides — `taskOfAgent`, the ownership heartbeat, and the model's observed effort capability — are wrapped (`quietly` for the two that return a value, `quiet` for the heartbeat), so the hook cannot fail before reaching its decision: the Fable refusal, the subscription refusal and the strict-advisor refusal | None | `tsc -p .`, the suite, and a re-read of the generator: no unguarded `await` remains between the event and the decision |
| 10 | `Connector.next` in the shell parser, and other helper-module `next` names | Not reproduced | `hooks/shell.ts:22`, `:237`–`:243`, `:297`; `hooks/classify.ts:125`–`:127`; `hooks/effort.ts:140`; `hooks/field.ts:171`; `hooks/model.ts:232` | A parsed pipeline's join to the next one is a field named `next`, documented as such; the other sites are locals in pure functions. None is a hook registration and none calls `next(...)`. `parseShell` is the reader the blast-radius guard trusts | No change. Renaming a field of the security-critical shell parser buys a scanner nothing and puts the guard at risk | None | The static audit: every `next(` call in the plugin's hook modules is in `hooks/register.tsx` (the test files call an async stream's own `.next()`, which is not a hook) |
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


## The handlers, and what each one does

"Refuses" means the handler answers with the decision the hook itself would have
made; "forwards" means the action goes on as the engine decided, because the
hook only watched it. The `next.called` guard is the engine's rule that a hook
which already passed the event on leaves that result standing.

The engine's validator lists 18 gating hooks and every one carries a handler.
Cockpit's own audit additionally requires one on every command-answering hook, so
a future command hook cannot be added without it.

| Event | Handler's decision | Why that is the honest one |
| - | - | - |
| `tool.call` | Refuses, with the failure named | The blast-radius guard, the ownership guard and the read-only rule all live here, and a skipped `tool.call` hook runs the tool |
| `agent.spawn` | Refuses | Ownership admission, the dependency check and the model choice live here |
| `agent.offer` | Withholds a Fable type, and only that | The handler judges the event it was given with the same predicate the hook uses (`config.blocksFable && isFable(e.agent)`), so an ordinary agent type is not hidden by a failure |
| `config.set` | Refuses a row the hook would have refused | The row's key and value are judged by the hook's own rules, so an ordinary row (`theme`) is written and only a Fable model or the strict advisor row is left as it was |
| `command.run{model}` | Answers with the block line when the command names Fable | The command's own arguments are read by the hook's own predicate; `/model opus` runs normally |
| `command.run{advisor}` | Answers the Fable line or the strict refusal, matching the hook | A line that names Fable is refused (`blockFable`), and under `cobaltStrict` a command that would change the advisor is; `/advisor off`, `/advisor none` and an empty line run normally |
| `park` | Answers that nothing was parked | `/park` writes a checkpoint, and a silent failure would read as success |
| `ledger`, `replay` | Answer that nothing was read | They only draw, but a silent empty answer reads as "nothing recorded" |
| `cockpit` | Answers that the command could not be read | Cockpit's own command answers with its own text; a silent failure would look like an empty pane |
| `classic.SessionStart` | Forwards | It restores bookkeeping; the session must start either way |
| `prompt.submit` | Makes all three drops the hook itself makes | The strict preset's advisor line, a session set to use Fable (or with Fable as its advisor, counted as a block), and the subscription policy's API refusal. Everything else is the person's own prompt, which a lost reading must not swallow. It is the one handler the harness cannot call directly (a `.catch` handler is only reached inside a dispatch), so it is verified by inspection and its refusals end to end |
| `command.run{init}` | Forwards | `/init` is the person asking for a CLAUDE.md, and the hook only notes it |
| `command.run{effort}`, `command.run{login}`, `command.run{logout}` | Forward | Each only notes or re-reads something after the engine's own command ran |
| `tool.check` | Forwards | It watches the verdict the engine reached. Refusing here would block every tool call over a drawing bug. The engine's advice for a guard on this event (`{ decision: 'deny' }`) is right for a hook that decides, and this one does not |
| `classic.PostToolUse` | Forwards | The tool call already ran; the hook records what the engine reported |
| `turn.step` | No handler; its pre-decision readings are wrapped instead | For a streaming event the handler must itself be a generator, and the engine's failure rule for one is not verifiable from here. `taskOfAgent` and the ownership heartbeat are wrapped in `quietly`, so the hook reaches its Fable, subscription and strict-advisor decisions even when a reading beneath it does not answer |

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

- `claude plugin test .` — 980 pass, 0 fail across 23 files (960 before this
  release; 20 added here).
- `tsc -p .` — clean.
- `claude plugin validate --strict .` — exit 0; no errors, no warnings, and 18
  gating hooks each with a handler.
- `claude plugin validate --strict --json .` — 0 errors, 0 warnings; notes only.
- `claude plugin validate --strict agents` — passes with nothing to report.
- `claude plugin validate .` on `hooks/` alone — not a plugin folder, and it says
  so ("No manifest found in directory"); the module is validated with the plugin.
- `python3 scripts/audit-public.py` — 77 files, no portability, credential or
  format-character findings.
- `git diff --check` — no whitespace errors.

`tests/compliance.test.ts` holds: every hook that can answer or refuse has a
handler, `turn.step` excepted (see the table above); the tool guard refuses with
the failure named; a guard that already passed the call on leaves that result
standing; the agent-admission guard refuses; each conditional guard refuses the
event it would have refused and forwards every other; every watcher forwards; an
untouched tool call reaches the engine with its fields intact; an effort-rewritten
Agent call arrives as the copy that carries the level; and a prompt with no task
carries no context.

### What this verification does not cover

- The event-identity half of the pass-through change (row 4): the test kit freezes
  what it hands the bottom hook, so a copy and the original are indistinguishable
  there. The content assertions hold; the identity rests on the mods reference's
  own definition of `next(e)`.
- The `prompt.submit` handler (row 2's table), for the reason given there.
- The failure behaviour of `turn.step`, which is protected by wrapping rather
  than by a handler. The suite exercises its decisions on the ordinary path; the
  wrapped path is verified by reading the generator.
- The engine-generated `.claude-plugin/types/` directory, which the audit skips
  because it is gitignored and not shipped. It carries a format character of its
  own (a zero-width joiner in the engine's emoji documentation), which is not
  this repository's file.

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

- `hooks/register.tsx` — a `.catch` handler on every hook that can answer or
  refuse; each conditional handler judging the event it was given with the hook's
  own predicate; explicit branches for the pass-throughs of `tool.call`,
  `agent.spawn` and `prompt.submit`; `isChanged` on `tool.call`; `agent.offer`
  and `attribution.text` as block-bodied hooks with explicit returns;
  `turn.step`'s pre-decision readings wrapped in the new `quietly` helper; every
  identifier named `next` that was not a pass-through renamed; the Replay pane's
  Next button keyed `advance`.
- `hooks/policy.ts` — the invisible-character class written as escapes.
- `hooks/swarm.ts` — `next` locals renamed in `admitTask` and `markStalled`.
- `tests/policy.test.ts` — the two invisible characters written as escapes.
- `tests/compliance.test.ts` — new; 20 tests.
- `scripts/audit-public.py` — the format-character check, the hooks-module
  checks, the engine-generated declarations excluded, version 0.3.2.
- `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — version
  0.3.2.
- `README.md`, `SECURITY.md`, `CHANGELOG.md`, `docs/implementation-v0.3.2.md`.

