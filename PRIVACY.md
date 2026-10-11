# Privacy

This policy describes what Cobalt Cockpit v0.5.2 observes, what it keeps, where it keeps it, how long it stays, how to remove it, and what can reach a model. It is written from the plugin's source. Where the plugin gives no guarantee, this page says so rather than implying one. Last updated 2026-10-11.

[SECURITY.md](SECURITY.md) covers the guards, process access and vulnerability reporting. This page covers data.

## Summary

- Cobalt Cockpit is a Claude Code mod that runs on your machine, inside Claude Code, with your user privileges.
- It has no server, no account, no analytics and no telemetry backend of its own. Nobody operating Cobalt Cockpit receives anything from your sessions, because nothing is sent to them. The local model telemetry described below is a set of files on your machine, read only by `/cockpit stats` and `/cockpit doctor`.
- It makes no network request of its own: no HTTP fetch, no model call, no MCP call. One thing it can start does: if you select the JEV router for a session (`/cockpit router jev`), the local decision router sends fixed-vocabulary keywords derived from a new task's prompt (never the prompt text) to the TypeSafe JEV API. That is off in every new session and is described under [The session router](#the-session-router).
- It keeps session state in Claude Code's memory and saves two kinds of record on disk: a bounded record of each session, the Run Ledger, in the key-value store file that Claude Code manages for the plugin, and, with `telemetry` on (the default), a small local usage record in files of its own under your state directory (`~/.local/state/cobalt-cockpit/telemetry/` unless `XDG_STATE_HOME` is set). The two are bounded, kept and deleted under different rules; see [What is kept, and where](#what-is-kept-and-where) and [Retention](#retention).
- Some of what it observes is added to the request Claude Code already sends to your model provider. Apart from the JEV router you may select for a session, that is the only route by which anything Cockpit observed leaves your machine, and it is listed below.
- There is no command that erases the saved ledgers or the telemetry files. Removing them is a manual step, described under [Deleting your data](#deleting-your-data).

## What Cockpit observes

While a session runs, Cockpit's hooks see the events Claude Code raises. From them it reads:

- **Prompts you submit.** The first 160 characters of a prompt, on one line, become the working title of an unplanned task and the "latest prompt" of the current one. The full prompt is not copied.
- **Tool calls.** The tool's name, its id, how long it took, whether it failed, and a file path where the call has one. For `Edit` and `Write`, the text before and after the change is read for the replay snapshot. A shell command is read to classify it and to check it against the blast-radius and attribution guards. The HUD's current-activity line holds a short label for the call in flight: a file's base name, a search pattern, a web host, or the first 40 characters of a shell command, a search query or a subagent's description.
- **Subagents.** Their ids, types, the short description on the call that started them, requested and observed model names and reasoning levels, status and counts, and the first 160 characters of a subagent's final answer, kept as that agent's conclusion.
- **Orchestration assignments**, when the model uses the `swarm` tool: each task's objective, scope, dependencies, the paths it owns, its results and handoffs.
- **Progress reports**, when the model uses the `progress` tool: the goal, milestone titles and notes, gate states and the one-line evidence given for each.
- **Model requests.** The model and reasoning level requested and observed, and token counts (input, output, cache read, cache write) where Claude Code reports them. Not the content of a request or a response.
- **Context usage**: tokens used, window size and percent, from Claude Code's own meter.
- **Git state**: branch name, HEAD and starting commit ids, the repository's folder name, and counts of changed files, from `git status` and `git rev-parse`.
- **Working-tree fingerprint** (v0.5.1): once a goal check is accepted, Cockpit runs `git diff <commit> --name-only`, `git ls-files -o` and `git hash-object` over the changed and untracked files (up to 2000), reduces them in memory to one short hash, and keeps only that hash with the commit id it was measured against, in the task state. From v0.5.2 the same fingerprint is also taken when a prompt starts a task (the task's baseline) and, while the Stop-hook verification guard enforces, at each Stop it checks; it then also covers ignored files and watched paths: their names are listed and their size, inode and timestamps (not contents) are read with `git ls-files -o -i`, `find` and `stat` (up to 100,000 files). File names and contents are read by git for this and are neither stored nor sent anywhere.
- **Release-review record** (v0.5.1): for each release consultation, the commit id it was for, the consultation id, a time and whether it returned (newest 32), in the plugin store, so a restart cannot reset the budget. Commit ids only; no file content.
- **Verification-script runs** (v0.5.2, only with `stopGuard: ENFORCE` and a script you enrolled): the script's exit code, how long it ran, a short hash of the working-tree fingerprint before and after it, and the last six lines of its output on one line (600 characters at most, passed through the credential patterns), in the Run Ledger and the plugin store. The script's own files, arguments and environment are not recorded.
- **Claude Code's installed-plugin record**: `/cockpit doctor` reads `plugins/installed_plugins.json` in your Claude Code configuration directory and keeps, in memory and for that command only, the name, version and install path of each Cockpit entry.
- **Discovery, criteria and decisions** (v0.5.1): the objective, acceptance criteria, unknowns, risks, the evidence the model reports for each criterion, and recorded decisions (problem, choice, alternatives, evidence), each clipped and redacted for credentials on entry. They stay in the task state; the Run Ledger holds a short entry per task (level, counts, alignment state) and the decision records, redacted again on write and on export. Nothing is written to a project and nothing is sent to a model beyond what the model itself wrote.
- **Authentication, by kind only.** Whether eight authentication-related environment variables are set (never their values), the names of the settings sources that configure authentication, and the credential kind Claude Code reports (`bearer`, `api-key`, `none` or `unknown`). The handle Claude Code returns is dropped at once.
- **Claude Code settings**: the configured model and advisor names (to apply the optional Fable and advisor rules), the names of the settings entries that configure authentication, and the saved reasoning level and its cap.

Cockpit does not store the model's hidden reasoning, the main conversation's replies, the content of a model request or response, or the content of files it has no reason to snapshot. Responses pass through one of its hooks on their way to Claude Code and are forwarded unread; only the usage figures and the answering model's name are taken from them. The one piece of model output it keeps is the subagent answer excerpt above.

## What is kept, and where

### In the session (Claude Code's memory)

The current task, the activity tape, the HUD's state, guard findings, policy and orchestration counters, the authentication kind and the newest NobodyWho receipts are kept in Claude Code's session state. That state lasts until the session ends or you run `/clear`, `/resume` or `/branch`. It survives a reload of the plugin. Cockpit does not write it to disk.

The task held here contains the 160-character prompt excerpts described above, so in-session task state can contain your own words.

### On disk, first place: Claude Code's plugin store

Cockpit saves to two places. The first is the key-value store Claude Code gives each plugin, a JSON file of the plugin's own under the `plugins/store/` folder of your Claude Code configuration directory (`~/.claude` by default). The file's name begins with `cobalt-cockpit_`. The second, with `telemetry` on (the default), is a directory of Cockpit's own under your state directory, described under [Local model telemetry](#local-model-telemetry-052). Apart from those two places Cockpit writes no file: nothing into a project, nothing into Claude Code's settings.

The store holds six kinds of entry:

| Entry | Contents |
| --- | --- |
| `prefs` | Two switches: whether cues are muted, and whether the HUD is hidden |
| `ledger-index` | The ids of up to eight sessions whose ledgers are kept |
| `ledger:<session id>` | One Run Ledger for that session |
| `release-reviews` | For each release consultation (v0.5.1): the commit id it was for, the consultation id, a time and whether it returned; newest 32 |
| `stop-checks` | The Stop-hook verification guard's check records (v0.5.2): the task's number and identity, a 12-character digest that names the project and script, the script's file name, outcome, exit code, duration, a short fingerprint hash and the output excerpt described above; newest 24 |
| `stop-trust` | Script enrollments made with `/cockpit guard trust` (v0.5.2), keyed by the project's path and the script's absolute path, each holding the sha-256 of the script's bytes and the time of enrollment; newest 32 |

A Run Ledger contains:

- The session id, and each run's and turn's id, start, end and status.
- Subagents: id, role, the description from the call that started it (cut to 160 characters), models, reasoning levels, status, timings and counts, and for up to 128 finished subagents the 160-character answer excerpt.
- Tool entries: id, tool name, kind, duration, status, the MCP server name for an MCP tool, and a file path where there is one. **Shell commands and tool arguments are not ledger fields.**
- Requests: model, reasoning level, routing and fallback reasons, and token counts.
- Context-usage readings.
- Replay snapshots: for a successful `Edit` or `Write`, the file path and the text before and after. See the limits below.
- Orchestration: each assigned task's objective, scope, dependencies, owned paths, results (including that answer excerpt as the task's conclusion), handoffs and lifecycle events.
- NobodyWho receipts, reduced as described under [NobodyWho](#optional-nobodywho-telemetry).
- Opus consultations (`SONNET_LED`): the ground, and the evidence packet the main session wrote for it (objective, architecture, file locations, alternatives, failures, risk and question), with credential-shaped spans replaced by `[redacted]` before it is kept or briefed. `/ledger export json` passes it through the credential patterns again.
- Session router decisions, as described under [The session router](#the-session-router).
- Warnings Cockpit raised.
- Stop-guard check records (v0.5.2, the same records as `stop-checks`, kept with their session) and, with `guardAlerts` on, alert outcomes: kind, task number, time, sent or failed, the channel name the host reported; newest 32.
- A checkpoint, rewritten when a turn completes, when you run `/park` or `/ledger`, and when a session ends: the phase, completed and remaining milestone titles, gate states, the task's explicit goal if a plan named one (a prompt excerpt is not used as the goal), any blocker text, the branch, commit ids, repository folder name, changed-file count and the ids of running background agents.

**Treat the store as private.** It can contain file paths, branch names, milestone and task wording, and fragments of source code in replay snapshots.

### What limits the record

- A stored ledger is trimmed to 384,000 bytes, oldest detail first. In memory it holds at most 32 runs, 96 finished agents, 512 tool entries, 512 requests, 64 usage readings, 256 receipts and 32 warnings, plus anything still running.
- Replay keeps at most 24 snapshots and 96,000 characters in all. A snapshot's text is left out when the two sides together exceed 12,000 characters, when the file's name looks sensitive (`.env`, key and credential files, `.ssh`, `.aws` and similar), or when the text matches a credential pattern.
- Short labels (subagent descriptions, answer excerpts, checkpoint text) are cut to 160 characters and passed through the same credential patterns; a match is stored as `unknown`.
- Orchestration text (an assignment's objective, scope, reasons and events, and each field of a result or handoff) is passed through the credential patterns before it is stored: a matching span is replaced with `[redacted]` and the rest of the text is kept. It is then cut to 1,500 characters, with at most twelve entries in a list. Redaction is a list of shapes, not a proof: a secret in an unusual format, or written in prose, can still be stored, so do not put credentials in task objectives or handoffs.

These filters are heuristics. They recognise common key formats and file names. They are not a guarantee that no secret is ever stored, so do not put credentials in prompts, milestone titles, task objectives or file names.

## Retention

The plugin store and the telemetry files are kept under different rules.

**Plugin store.** Cockpit applies no time limit to it; nothing in it expires after a number of days because of Cockpit.

- Ledgers are kept for the eight most recently written sessions. Writing a ninth deletes the oldest.
- Release-review records keep the newest 32, Stop-guard check records the newest 24 and script enrollments the newest 32; an older entry is dropped when a new one is written.
- Preferences stay until you change them.
- Claude Code may remove the whole store file itself: its documentation says a plugin's store lasts until the plugin deletes it or no session reads or writes it for the period set by Claude Code's `cleanupPeriodDays` setting. That is Claude Code's behaviour and setting, not Cockpit's.

**Telemetry files.** Cockpit itself deletes these, by age and by size, on a best-effort basis. When a process records its first telemetry event it lists its telemetry directory and removes, with `rm -f`, every file whose month is older than the current month and the twelve before it (13 months in all), and then, oldest file name first, enough files to bring the directory under 4 MiB. Only names of the telemetry file form (`YYYY-MM-<8 hex>-<n>.jsonl`, or `YYYY-MM.jsonl` from an earlier build) are ever listed for removal or removed, and only inside that directory. A removal that fails is not retried another way; it is attempted again the next time a process writes. `/cockpit doctor` shows how many files the current session removed. A session with `telemetry` off, or one that records no event, performs no cleanup, so the limits are enforced by the next session that writes rather than continuously.

Cockpit has no control over Claude Code's own transcripts, logs or history, which follow Claude Code's settings.

## Deleting your data

What Cockpit provides:

- `/cockpit reset` clears the current task from the session.
- `/clear` in Claude Code ends the conversation; Cockpit then clears the task, activity, guard findings, HUD state and orchestration counters for the session.
- Setting `localControl` to false stops the NobodyWho reads.
- Setting `telemetry` to false stops the local model telemetry from being written (restart Claude Code to apply it). It deletes nothing, and `/cockpit stats` still reads what exists.

What it does not provide: **there is no command that erases saved Run Ledgers, the store or the telemetry files**, and no setting that stops the ledger from being written while the plugin is enabled. The deletions Cockpit performs by itself are the two described under [Retention](#retention): the oldest ledger when a ninth is written, and expired or excess telemetry files when a process first writes telemetry.

To remove what is saved in the store, quit Claude Code and delete the `cobalt-cockpit_…` JSON file in the `plugins/store/` folder of your Claude Code configuration directory. That removes every saved ledger, checkpoint, release-review record, Stop-guard check record, script enrollment and both preferences; an enrolled script has to be enrolled again afterwards. A session that is still running holds its own ledger in memory and will write it again, which is why Claude Code should be closed first.

To remove the telemetry, quit Claude Code and delete the `cobalt-cockpit/telemetry` directory under your state directory (`$XDG_STATE_HOME/cobalt-cockpit/telemetry/`, or `~/.local/state/cobalt-cockpit/telemetry/` when that variable is unset). The next session with `telemetry` on creates it again, empty.

Disabling or uninstalling the plugin stops further writes to both places; this page does not promise that doing so removes either, so check both folders.

## Local model telemetry (0.5.2)

**It is on by default.** The `telemetry` option defaults to `true`; set it to `false` and restart Claude Code to stop recording. This is the one thing Cockpit writes outside Claude Code's plugin store.

**What is recorded.** One line per observed event, every field an enumeration, a boolean or a number, rebuilt from a fixed list of fields both when written and when read, so nothing outside that list can enter a file or be read back from one:

- a model request: the tier (Haiku, Sonnet, Opus, other), whether it was a subagent's, input and output token counts and cache read and write counts when the host reported them, and the subagent prompt-cache policy in force;
- a subagent that ended: its tier, its role as one of seven fixed words or `other`, whether it succeeded, and its duration;
- a session-router decision: the mode, whether the rules or the router decided, the provider's name, how many requests were made and answered, the outcome and the latency;
- a NobodyWho receipt: the operation (decision or prune), the tier and the latency;
- an Opus consultation: its ground, what happened (refused, admitted, returned, verified), whether it was mandatory, pass or fail, GO or NO-GO for a release, and the latency;
- a finished task: whether Opus took part.

It never stores a prompt, code, diff, file path, command, session id, agent name, model id, credential or any free text, and nothing is sent anywhere.

**Where.** `$XDG_STATE_HOME/cobalt-cockpit/telemetry/` when that variable holds an absolute path, otherwise `$HOME/.local/state/cobalt-cockpit/telemetry/`. When neither is known nothing is recorded and `/cockpit doctor` says so. Cockpit creates the `cobalt-cockpit` directory and the `telemetry` directory under it with `mkdir -p -m 700`; a state directory missing above them is created by that same call with the default mode. It creates nothing else.

**Files.** Each process writes only files of its own, named `YYYY-MM-<8 hex id>-<n>.jsonl` (the month, a random id chosen when the process first writes, a running number): a segment is rewritten whole, from memory, by its one writer until it holds 64 KiB or the month changes, then sealed and never written again. No file is ever written by two processes, and a torn write can damage at most one segment, whose damaged lines the reader skips and counts. The directory is bounded at 4 MiB and 13 months by the cleanup described under [Retention](#retention).

**Permissions.** The plugin API writes a file but has no file-mode argument. Cockpit asks for the modes it wants (`mkdir -p -m 700` for the two directories, `chmod 600` for each segment after its first write), reads them back with `stat`, and reports them as verified only when the read-back shows 0700 and 0600; an existing directory is left with the mode it has and reported unverified. Between the host's write and the `chmod` a new segment briefly carries the host's default mode. `/cockpit doctor` prints the result. This is a request and a check, not a guarantee.

**Who reads it.** `/cockpit stats 7d|30d|all [--json|--csv]` reads the files of the window and prints the figures in your terminal, and `/cockpit doctor` lists the file count, size and this session's write, failure and cleanup counts. Nothing else reads the files, nothing is added to a model request from them, and nothing is uploaded; the printed output goes into the Claude Code transcript like any command's.

**Deleting.** Described under [Deleting your data](#deleting-your-data): manual removal of the directory, plus the age and size cleanup Cockpit performs. `COBALT_TELEMETRY_SEGMENT_BYTES`, read only to let a test seal a segment early, can lower the 64 KiB segment size and never raise it.

## Owner alerts (0.5.2)

With `guardAlerts` on (off by default) Cockpit asks Claude Code to raise a terminal notification whose text is one fixed sentence and a task number. It contains no prompt, path or code. Alert outcomes (kind, task number, time, sent/failed, channel name) are kept in the Run Ledger. SENT means the host reported that it wrote the notification to the channel it names (for example `terminal_bell`); Cockpit cannot tell whether you saw it. Nothing leaves your machine; the terminal decides what to show.

## What can reach a model

Cockpit never calls a model. It does add text to requests that Claude Code itself sends to whichever model provider your session uses, and anything in those requests is handled under that provider's terms and Claude Code's settings, not under this policy.

- **System prompt.** A fixed section of instructions: working discipline, repository hygiene, safety, and, when you enable them, the orchestration, reasoning-effort and Fable rules. It is the same text for every user apart from the numbers taken from your configuration. It contains nothing observed from your session.
- **Task status.** When a planned task is in progress, one line is added to a prompt you submit: percent, phase, each milestone's id, title and state, gate states, and a blocker's text if the task is blocked. Milestone titles and blocker text are words the model or you wrote.
- **Tool results.** The `progress` and `swarm` tools are called by the model and answer it with task and assignment status. A guard's refusal is returned to the model as the result of the call it refused. Once per task, after the main session has edited a second file with no plan declared, one line reminding it to report progress is added to that edit's result. With orchestration on, a note that the same failure is repeating is added to that failure's result; it names what failed and, if a NobodyWho decision arrived since the failures began, that decision's route label.
- **Router advice.** With a session router selected, one line naming its recommendation is added to the prompt that starts a task, and only when Cockpit's rules accept it.
- **Command output.** Text a Cockpit command prints, such as `/cockpit status`, `/cockpit auth` or `/ledger export json`, goes into the Claude Code transcript like any command's output. Cockpit does not decide what Claude Code later does with its transcript.

Replay snapshots and stored ledgers are not added to requests by Cockpit, and apart from the route label above neither are NobodyWho receipts.

## Optional NobodyWho telemetry

NobodyWho is a separate, optional local tool. Cockpit does not install it, and starts it only when you select a session router (next section). The telemetry described here only reads its ledger.

When `localControl` is on (the default), Cockpit looks for a decision-router ledger at `$XDG_STATE_HOME/decision-router/ledger.jsonl`, then `$HOME/.local/state/decision-router/ledger.jsonl`, or at the path in `ledgerPath`. If the file is missing or unreadable nothing happens and nothing is shown. If it exists, Cockpit reads it, and never writes it, about every 1.2 seconds, from the end of the file, taking only lines written after the session started.

From each line it keeps the operation (a decision or a prune), the tier, the latency, the timestamp, the request id, a route label of at most twelve characters, whether the router abstained, and block counts. It discards every other field, including prompt, state and detail fields, and ignores receipts whose caller is not `claude`. The reduced receipts appear in the HUD and are saved in the Run Ledger with the rest.

## The session router

Cockpit has an optional router you choose per session with `/cockpit router`: `off`, `nobodywho` or `jev`. Every new session starts `off`, the choice is held in session state and is never saved, and with it off no router program is started.

When a router is selected, Cockpit asks it about a **new task** that its own rules do not already settle. With a plan in progress the plan is one task, and prompts inside it are not asked about. **Without a plan, each prompt you submit is a task of its own**: every prompt of 16 characters or more is asked about, unless the rules settle it. It is never asked for a tool call, a helper or an Opus admission, and never when the rules already require an Opus consultation or read a route off the prompt.

- **What is sent.** To NobodyWho (on your machine): the first 400 characters of the prompt you submitted, on one line, with five fixed yes/no questions about it (ten requests: each question in both orders). To JEV (external): no prompt text at all. Cockpit sends only words that appear in a fixed engineering vocabulary (`debug`, `race`, `refactor`, `across`, `tests` and similar, listed in `hooks/router.ts`) and a size bucket (short, medium or long), as `task keywords: …; size: …`, in the same ten requests. Names, paths, numbers and sentences cannot be sent because only whole vocabulary words are ever copied. A prompt with no vocabulary word asks nobody. In both modes a prompt in which Cockpit recognises something credential-shaped, anywhere in it, is not sent at all: named values such as `SECRET_KEY=…`, URLs that carry a password, AWS key IDs (`AKIA…`, `ASIA…`), known token prefixes, `.env` lines, long unbroken runs of letters and digits, and phrases such as "the password is …". This is a list of patterns, deliberately broad, and not a guarantee: it cannot recognise every secret, so do not put one in a prompt while a router is selected. A router that times out (3 s per JEV request, 5 s local) or does not answer leaves the deterministic rules in charge.
- **NobodyWho** runs on your machine. Cockpit asks the local `decision` router for its local provider only (`--mode local`) and discards an answer from any other provider. That the request stays local is the router's behaviour, which Cockpit asks for and checks but does not implement. The router keeps its own receipt ledger of each request (digests of the request, the question and the answer), outside Cockpit's control.
- **JEV is an external service.** In JEV mode the same requests go from the local `decision` router to the TypeSafe JEV API over HTTPS, under your own TypeSafe key. Cockpit never reads, holds or logs that key: the router reads it from its own key file. If you set `routerConfigDir`, that directory is passed to the router's child process as `DECISION_ROUTER_CONFIG_DIR`, in JEV mode only; Cockpit never creates or edits router configuration, and refuses a directory inside the project you are working in. What TypeSafe does with a request is governed by TypeSafe's terms, not by Cockpit.
- **What is kept.** For each decision: the mode, the provider and model that answered, up to four request ids, how many requests were answered, the two latencies, the recommendation, what Cockpit's rules said and whether they accepted it. Not the prompt. The last sixteen are kept in the Run Ledger.
- **What reaches your model.** One line, only when Cockpit's rules accept a recommendation other than "handle it directly". A recommendation for Opus that the rules refuse is shown to you as a notice and is not given to the model.

A router recommends. It cannot start an agent, admit or skip an Opus consultation, change a model, a permission, an ownership rule or a verification gate.

## Local processes, files and environment

Cockpit starts a small set of local programs: `git` (read-only commands for the HUD, the release-review commit check and the working-tree fingerprint), `realpath`, `tail`, `find` and `stat` (the fingerprint's ignored and watched entries), `mkdir`, `chmod`, `stat` and `rm` (creating, restricting and trimming its own telemetry directory, and nothing outside it), one audio player for the optional cues, only while a session router is selected the local `decision` router, and, only with `stopGuard: ENFORCE`, the verification script you enrolled, run by its path with no shell. It reads environment variables by name. Apart from the JEV router described above, none of this sends data anywhere. The full list, with the reason for each, is in [SECURITY.md](SECURITY.md) and the README's section on what Cockpit runs, reads and sends.

## Exports and sharing

`/ledger export json` prints the current ledger with replay text, subagent descriptions and the checkpoint's goal, milestone titles and blocker text removed, and with every string passed through the credential patterns. Paths, branch names, ids, repository names and orchestration task text, including each task's conclusion, remain. Nothing is uploaded: the export is text in your terminal. Read an export, a screenshot or a copied ledger before you share it.

## What Cockpit does not do

- It does not send data to its authors. It sends nothing to any third party either, with one exception you control: the JEV router, when you select it for a session, sends a short list of fixed-vocabulary keywords to TypeSafe through your own decision router and key.
- It does not collect analytics, usage statistics or crash reports for its authors or for anyone else. The local model telemetry is a usage record that stays in files on your machine, is read only by `/cockpit stats` and `/cockpit doctor`, and can be switched off.
- It does not create accounts, set cookies or track you across machines.
- It does not store, log, export or transmit credential values. The eight authentication variables are read only to test whether each is set.
- It does not write outside two places: Claude Code's plugin store, and its own telemetry directory under your state directory. It writes nothing into a project and nothing into Claude Code's settings.
- It does not sell or share data, because it holds none outside your machine.

## Changes and contact

This page changes with the plugin. A change to what is observed, kept or sent is recorded in [CHANGELOG.md](CHANGELOG.md) under the version that makes it.

For a privacy question, open an issue in this repository. For anything that involves a secret or a private ledger, use the private reporting route in [SECURITY.md](SECURITY.md) and do not post the material publicly.
