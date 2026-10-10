# Privacy

This policy describes what Cobalt Cockpit v0.5.1 observes, what it keeps, where it keeps it, how long it stays, how to remove it, and what can reach a model. It is written from the plugin's source. Where the plugin gives no guarantee, this page says so rather than implying one. Last updated 2026-10-08.

[SECURITY.md](SECURITY.md) covers the guards, process access and vulnerability reporting. This page covers data.

## Summary

- Cobalt Cockpit is a Claude Code mod that runs on your machine, inside Claude Code, with your user privileges.
- It has no server, no account, no analytics and no telemetry backend of its own. Nobody operating Cobalt Cockpit receives anything from your sessions, because nothing is sent to them.
- It makes no network request of its own: no HTTP fetch, no model call, no MCP call. One thing it can start does: if you select the JEV router for a session (`/cockpit router jev`), the local decision router sends fixed-vocabulary keywords derived from a new task's prompt (never the prompt text) to the TypeSafe JEV API. That is off in every new session and is described under [The session router](#the-session-router).
- It keeps session state in Claude Code's memory and saves a bounded record of each session, the Run Ledger, to one local file that Claude Code manages.
- Some of what it observes is added to the request Claude Code already sends to your model provider. Apart from the JEV router you may select for a session, that is the only route by which anything Cockpit observed leaves your machine, and it is listed below.
- There is no command that erases the saved ledgers. Removing them is a manual step, described under [Deleting your data](#deleting-your-data).

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
- **Working-tree fingerprint** (v0.5.1): once a goal check is accepted, Cockpit runs `git diff <commit> --name-only`, `git ls-files -o` and `git hash-object` over the changed and untracked files (up to 2000), reduces them in memory to one short hash, and keeps only that hash with the commit id it was measured against, in the task state. File names and contents are read by git for this and are neither stored nor sent anywhere.
- **Discovery, criteria and decisions** (v0.5.1): the objective, acceptance criteria, unknowns, risks, the evidence the model reports for each criterion, and recorded decisions (problem, choice, alternatives, evidence), each clipped and redacted for credentials on entry. They stay in the task state; the Run Ledger holds a short entry per task (level, counts, alignment state) and the decision records, redacted again on write and on export. Nothing is written to a project and nothing is sent to a model beyond what the model itself wrote.
- **Authentication, by kind only.** Whether eight authentication-related environment variables are set (never their values), the names of the settings sources that configure authentication, and the credential kind Claude Code reports (`bearer`, `api-key`, `none` or `unknown`). The handle Claude Code returns is dropped at once.
- **Claude Code settings**: the configured model and advisor names (to apply the optional Fable and advisor rules), the names of the settings entries that configure authentication, and the saved reasoning level and its cap.

Cockpit does not store the model's hidden reasoning, the main conversation's replies, the content of a model request or response, or the content of files it has no reason to snapshot. Responses pass through one of its hooks on their way to Claude Code and are forwarded unread; only the usage figures and the answering model's name are taken from them. The one piece of model output it keeps is the subagent answer excerpt above.

## What is kept, and where

### In the session (Claude Code's memory)

The current task, the activity tape, the HUD's state, guard findings, policy and orchestration counters, the authentication kind and the newest NobodyWho receipts are kept in Claude Code's session state. That state lasts until the session ends or you run `/clear`, `/resume` or `/branch`. It survives a reload of the plugin. Cockpit does not write it to disk.

The task held here contains the 160-character prompt excerpts described above, so in-session task state can contain your own words.

### On disk (Claude Code's plugin store)

Cockpit saves to one place: the key-value store Claude Code gives each plugin, a JSON file of the plugin's own under the `plugins/store/` folder of your Claude Code configuration directory (`~/.claude` by default). The file's name begins with `cobalt-cockpit_`. Cockpit writes no other file and creates none outside that store.

It holds three kinds of entry:

| Entry | Contents |
| --- | --- |
| `prefs` | Two switches: whether cues are muted, and whether the HUD is hidden |
| `ledger-index` | The ids of up to eight sessions whose ledgers are kept |
| `ledger:<session id>` | One Run Ledger for that session |

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
- A checkpoint, rewritten when a turn completes, when you run `/park` or `/ledger`, and when a session ends: the phase, completed and remaining milestone titles, gate states, the task's explicit goal if a plan named one (a prompt excerpt is not used as the goal), any blocker text, the branch, commit ids, repository folder name, changed-file count and the ids of running background agents.

**Treat the store as private.** It can contain file paths, branch names, milestone and task wording, and fragments of source code in replay snapshots.

### What limits the record

- A stored ledger is trimmed to 384,000 bytes, oldest detail first. In memory it holds at most 32 runs, 96 finished agents, 512 tool entries, 512 requests, 64 usage readings, 256 receipts and 32 warnings, plus anything still running.
- Replay keeps at most 24 snapshots and 96,000 characters in all. A snapshot's text is left out when the two sides together exceed 12,000 characters, when the file's name looks sensitive (`.env`, key and credential files, `.ssh`, `.aws` and similar), or when the text matches a credential pattern.
- Short labels (subagent descriptions, answer excerpts, checkpoint text) are cut to 160 characters and passed through the same credential patterns; a match is stored as `unknown`.
- Orchestration text (an assignment's objective, scope, reasons and events, and each field of a result or handoff) is passed through the credential patterns before it is stored: a matching span is replaced with `[redacted]` and the rest of the text is kept. It is then cut to 1,500 characters, with at most twelve entries in a list. Redaction is a list of shapes, not a proof: a secret in an unusual format, or written in prose, can still be stored, so do not put credentials in task objectives or handoffs.

These filters are heuristics. They recognise common key formats and file names. They are not a guarantee that no secret is ever stored, so do not put credentials in prompts, milestone titles, task objectives or file names.

## Retention

Cockpit applies no time limit of its own. Nothing it saves expires after a number of days because of Cockpit.

- Ledgers are kept for the eight most recently written sessions. Writing a ninth deletes the oldest. That is the only deletion Cockpit performs.
- Preferences stay until you change them.
- Claude Code may remove the whole store file itself: its documentation says a plugin's store lasts until the plugin deletes it or no session reads or writes it for the period set by Claude Code's `cleanupPeriodDays` setting. That is Claude Code's behaviour and setting, not Cockpit's.

Cockpit has no control over Claude Code's own transcripts, logs or history, which follow Claude Code's settings.

## Deleting your data

What Cockpit provides:

- `/cockpit reset` clears the current task from the session.
- `/clear` in Claude Code ends the conversation; Cockpit then clears the task, activity, guard findings, HUD state and orchestration counters for the session.
- Setting `localControl` to false stops the NobodyWho reads.

What it does not provide: **there is no command that erases saved Run Ledgers or the store**, and no setting that stops the ledger from being written while the plugin is enabled.

To remove what is saved, quit Claude Code and delete the `cobalt-cockpit_…` JSON file in the `plugins/store/` folder of your Claude Code configuration directory. That removes every saved ledger, checkpoint and both preferences. A session that is still running holds its own ledger in memory and will write it again, which is why Claude Code should be closed first. Disabling or uninstalling the plugin stops further writes; this page does not promise that doing so removes the file, so check the folder.

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

Cockpit starts a small set of local programs (`git`, `realpath`, `tail`, one audio player for the optional cues, and, only while a session router is selected, the local `decision` router) and reads environment variables by name. Apart from the JEV router described above, none of this sends data anywhere. The full list, with the reason for each, is in [SECURITY.md](SECURITY.md) and the README's section on what Cockpit runs, reads and sends.

## Exports and sharing

`/ledger export json` prints the current ledger with replay text, subagent descriptions and the checkpoint's goal, milestone titles and blocker text removed, and with every string passed through the credential patterns. Paths, branch names, ids, repository names and orchestration task text, including each task's conclusion, remain. Nothing is uploaded: the export is text in your terminal. Read an export, a screenshot or a copied ledger before you share it.

## What Cockpit does not do

- It does not send data to its authors. It sends nothing to any third party either, with one exception you control: the JEV router, when you select it for a session, sends a short list of fixed-vocabulary keywords to TypeSafe through your own decision router and key.
- It does not collect analytics, usage statistics or crash reports.
- It does not create accounts, set cookies or track you across machines.
- It does not store, log, export or transmit credential values. The eight authentication variables are read only to test whether each is set.
- It does not write outside Claude Code's plugin store.
- It does not sell or share data, because it holds none outside your machine.

## Changes and contact

This page changes with the plugin. A change to what is observed, kept or sent is recorded in [CHANGELOG.md](CHANGELOG.md) under the version that makes it.

For a privacy question, open an issue in this repository. For anything that involves a secret or a private ledger, use the private reporting route in [SECURITY.md](SECURITY.md) and do not post the material publicly.
