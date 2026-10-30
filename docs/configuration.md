# Configuration

> Part of the [Cobalt Cockpit documentation](README.md). The first section was moved here from the root README (wording unchanged); the reference table below it is new and is printed from `.claude-plugin/plugin.json` at v0.6.0, so every title, description and default is the manifest's own.

Use `/config` or `claude plugin configure cobalt-cockpit@cobalt-cockpit` to inspect options. CLI input values are strings, even for Boolean options:

```sh
# Full opt-in policy: orchestration plus Fable and external-advisor blocking
printf '%s\n' '{"cobaltStrict":"true"}' | claude plugin configure cobalt-cockpit@cobalt-cockpit --values-stdin
```

Restart Claude Code after changing configuration. To enable just Fable blocking alongside orchestration, configure `blockFable: true` separately. No external router is required.

The Stop guard's and the alerts' settings (`stopGuard`, `verify*`, `stop*` and every `guard*` option) are the person's alone: they are accepted only from you in the config menu (`/config`), never from a plugin or a model, as [cobalt-guard.md](cobalt-guard.md) and [SECURITY.md](../SECURITY.md#hooks-that-refuse) describe. The blast-radius guard and the attribution guard are ordinary options.

## Calibrating alerts before turning them on

No option was added for [Guard Calibration](implementation-v0.6.3.md). With `guardRecordOnly` on and `guardAlerts` off, incidents are recorded and nobody is told. Label some with `/cockpit alerts label` and read `/cockpit alerts calibration`. To compare configurations you can change `guardNotifyKinds` or the quiet-hours options in `/config`, restart Claude Code as for any option, and read the report again. The report reads those options and writes none of them. `guardAlerts` stays as you set it, and `security-failure` stays notified.

## Every option and its default

43 options. "empty" is an empty string.

The descriptions are the manifest's own words. Where one says "verified" (the `sounds` cue, `verifyScript`), it means the task reached DONE, or the enrolled script exited 0 (on `main`, on a working tree the Stop guard could identify). It does not mean independent verification or a security attestation: [What DONE rests on](verification.md#what-done-rests-on).

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `hud` | boolean | `true` | **Show the HUD.** Draw the compact particle progress band above the prompt. |
| `flow` | boolean | `true` | **Neural Flow.** Draw the INPUT, DISCOVERY, ROUTING, WORKERS, VERIFY, DONE flow in the HUD. Every state comes from the task's real milestones and gates and the agents the host reported; the moving marker is drawn only while work is live. Reduced motion and narrow terminals are honoured. |
| `animation` | boolean | `true` | **Animate progress particles.** Twinkle particles and glide the stage pill only while work is active. |
| `sounds` | boolean | `true` | **Play sounds.** Play the checkpoint cue at 80% and the completion cue at a verified 100%. |
| `volume` | number | `0.6` | **Sound volume.** Cue volume from 0 to 1, for players that take one. |
| `blastRadiusGuard` | boolean | `true` | **Blast-radius guard.** Ask before genuinely destructive commands (hard reset, clean, force push, broad recursive deletes, database drops, production teardown). |
| `attributionGuard` | boolean | `true` | **AI attribution guard.** Keep AI attribution out of commits, pull requests and files, and ask before CLAUDE.md or AGENTS.md is created unasked. |
| `stopGuard` | string (`OBSERVE` / `ENFORCE`) | `OBSERVE` | **Stop-hook verification guard.** OBSERVE (default) does nothing. ENFORCE runs your verifyScript when the agent tries to finish a task that changed files, and refuses the stop (up to the attempt limit) until the script exits 0. Needs verifyScript. Cockpit makes no model call; a refused stop makes the agent continue with its normal turns. |
| `verifyScript` | string | empty | **Verification script (absolute path).** Your own check script, run directly (no shell) in the project directory. Exit 0 means verified. It is not trusted until you enroll its sha-256 with /cockpit guard trust; it is re-hashed before every run and a changed script is not run. Leave empty to disable the guard. |
| `verifyScriptSha256` | string | empty | **Pinned script sha-256 (optional).** If set, the script must match this 64-hex sha-256 exactly or its result is not trusted. |
| `verifyTimeoutSec` | number | `120` | **Check timeout (seconds).** Default 120, maximum 600 (the host runs a process for ten minutes at most; a larger value is lowered to 600). A timed-out check counts as failed. |
| `stopMaxContinuations` | number | `3` | **Stop-guard attempts.** How many refused stops one task may take before it is marked BLOCKED and the stop is allowed. Default 3, maximum 10. |
| `stopVolatile` | string | empty | **Volatile ignored directories (optional).** Comma-separated repository-relative directories ending in / (for example node_modules/,dist/,.pytest_cache/) whose git-IGNORED entries are left out of the change fingerprint, so caches and build output do not turn read-only work into coding. They never exclude a tracked or untracked file, and a directory that holds the verifier or a watched path is refused. Anything a model writes inside them goes unseen: you are accepting that. Default: none. |
| `stopWatch` | string | empty | **Watched files (optional).** Comma-separated paths (repository-relative or absolute) whose content is hashed into the change fingerprint even when git ignores them: an ignored config, the files your verifyScript depends on. The verifyScript itself is always watched. |
| `guardAlerts` | boolean | `false` | **Cobalt Guard owner alerts.** Off by default. When on, a terminal notification (through Claude Code's own notification channel) tells you when a run needs a person: verification retries exhausted, a security check failed, a release NO-GO, an open mandatory review, or a blocked run. It never approves, releases or clears anything, and it cannot confirm that you saw it. No webhook, email or push. |
| `guardCooldownSec` | number | `300` | **Guard cooldown (seconds).** Minimum time between alerts. Default 300, minimum 30. |
| `guardMaxAlerts` | number | `5` | **Guard alerts per session.** Most alerts one session may raise, reminders included. Default 5, maximum 20. |
| `guardRepeat` | boolean | `false` | **Persistent alerts (reminders).** Off by default; needs guardAlerts. When on, an alert whose condition is still open is repeated until you acknowledge it (/cockpit guard ack), silence it, or the condition is resolved. Reminders stay inside the cooldown and the per-session alert budget, never use the budget's last alert, and stop at guardMaxReminders for each condition. A reminder never approves, releases or clears anything. |
| `guardRepeatSec` | number | `900` | **Reminder interval (seconds).** Time between reminders of one open condition. Default 900, minimum 60. |
| `guardMaxReminders` | number | `3` | **Reminders per condition.** Most reminders one condition may get; a reminder that failed to send counts. Default 3, maximum 10. |
| `guardSound` | boolean | `false` | **Alert sound.** Off by default; needs guardAlerts. When on, the checkpoint cue is tried with each alert and reminder through the same local players as the other cues, the terminal bell last. It honours the sounds option and /cockpit mute. A player that exits 0 is recorded as attempted; Cockpit cannot tell whether it was heard. |
| `guardNotifyKinds` | string | empty | **Notified alert kinds (optional).** Empty (default) or all: every kind is notified. Otherwise a comma-separated list of the kinds to notify: release-no-go, verification-exhausted, review-hold, run-blocked. security-failure is critical and is always notified; none leaves only it. A kind left out is still recorded and shown on the HUD and in /cockpit guard. A list that is not understood notifies every kind. |
| `guardQuietHours` | string | empty | **Quiet hours (optional).** Empty (default): off. A daily window as 24-hour HH:MM-HH:MM, for example 22:00-07:00; it may cross midnight. In the window an alert that is deferred sends no notification and plays no sound (nothing is written to the terminal), stays on the HUD, and is told once after the window ends if still open and not acknowledged. Needs guardAlerts. A window that is not understood is not applied. |
| `guardQuietTimezone` | string | empty | **Quiet hours time zone (optional).** An IANA zone name such as Europe/Berlin, used to read the quiet-hours window by that zone's wall clock, daylight-saving changes included. Empty (default): the zone of the machine Claude Code runs on, which over SSH may not be yours. A zone that is not known turns quiet hours off rather than guessing. |
| `guardQuietOrdinary` | string (`defer` / `notify`) | `defer` | **Quiet hours: ordinary alerts.** defer (default): held back until the window ends. notify: sent as usual in the window. |
| `guardQuietCritical` | string (`defer` / `notify`) | `notify` | **Quiet hours: critical alerts.** What a security-failure alert does in the window. notify (default): sent as usual; on a channel that rings the terminal bell that is audible, and Cockpit cannot send it silently. defer: held back until the window ends, and still shown on the HUD. |
| `guardRecordOnly` | boolean | `false` | **Record incidents without notifying.** Off by default. When on and guardAlerts is off, the conditions Cobalt Guard would alert about (a failed security check, a NO-GO, exhausted verification, an open review, a blocked run) are written down, with their level, for /cockpit alerts and /cockpit alerts digest, and nothing is ever sent: no notification, sound or bell. With guardAlerts also on, nothing changes: alerts are sent as they always are and incidents are recorded either way. A condition recorded this way is not announced if you turn guardAlerts on later. Records are the same closed-vocabulary entries alerts keep, in the same bounded project history. |
| `guardDigest` | boolean | `false` | **Return digest at session start.** Off by default. When on, the start of a session shows one line in the terminal (never a desktop notification) counting the recorded alerts nobody acknowledged, by level, when there are any; once per session, not again on a reload. Computed from the records, no model is called. It reads what was recorded; it does not turn guardAlerts on or record anything new, and works with guardAlerts off. /cockpit alerts digest shows the same summary at any time. |
| `telemetry` | boolean | `true` | **Local model telemetry.** Keep a bounded local record of observed model requests, subagents, router calls and Opus consultations under ~/.local/state/cobalt-cockpit/telemetry/ for /cockpit stats. No prompt, code, path or secret is stored and nothing is uploaded. |
| `reducedMotion` | boolean | `false` | **Reduced motion.** Freeze particles and move the progress head directly; desktop also respects prefers-reduced-motion. |
| `localControl` | boolean | `true` | **Local Control telemetry.** Read the decision-router ledger read-only and flash a line when a real prune or decision receipt arrives, with a LOCAL CONTROL section in /cockpit. Nothing is shown when no receipt is observed. |
| `ledgerPath` | string | empty | **Telemetry ledger path.** Override the decision-router ledger path. Defaults to $XDG_STATE_HOME/decision-router/ledger.jsonl, then $HOME/.local/state. |
| `orchestration` | boolean | `false` | **Orchestration rules.** Observe by default. Enable the Opus 5.5 commander at the effort you set, elastic Sonnet 5.5 engineering and Haiku 5.5 utility pools with task-aware effort, task ownership and resource admission. |
| `profile` | string (`OPUS_LED` / `SONNET_LED`) | `OPUS_LED` | **Orchestration profile.** With orchestration enforced: OPUS_LED (default, legacy) keeps the Opus 5.5 main loop as commander. SONNET_LED runs the main loop on Sonnet 5.5 at your chosen effort, Haiku 5.5 scouts, and Opus 5.5 only as an admitted architect/reviewer consultation (one at a time; mandatory for explicit requests, release approval and security-sensitive files). SONNET_LED's AUTO budgets are 4 helpers: 2 Sonnet, 2 Haiku, 1 Opus. |
| `routerConfigDir` | string | empty | **Router configuration for JEV mode.** Optional. A decision-router configuration directory you created for Cockpit's JEV mode (for example ~/.config/cobalt-cockpit/router-jev, a copy of your router config with JEV enabled). It is passed as DECISION_ROUTER_CONFIG_DIR to the router's child process only while this session's router is JEV (/cockpit router jev). Empty: the router's own configuration and its JEV switch apply. Cockpit never creates or edits router configuration, and the router is OFF in every new session. |
| `maxSubagents` | number | `0` | **Parallel subagents.** Concurrent subagent resource budget: 0 selects AUTO (16 total); explicit values 1–128. Tasks remain queued until dependencies and ownership are safe. |
| `subscriptionOnly` | boolean | `false` | **Subscription only.** Opt-in refusal of API-style authentication. Cockpit never changes your launcher or credentials. |
| `blockFable` | boolean | `false` | **Block Fable.** Opt-in block of Fable model routes. Off in public defaults. |
| `cobaltStrict` | boolean | `false` | **Strict Cobalt preset.** Explicitly enforce orchestration, block Fable and external advisor selection, and require subscription-style authentication. Overrides individual switches while enabled. |
| `reasoningMode` | string (`AUTO` / `MANUAL`) | `AUTO` | **Reasoning mode.** AUTO names a reasoning level from each task: extractive work light, engineering medium, complex debugging, concurrency, migration, security and high-risk architecture high or xhigh. MANUAL honours the fixed per-tier levels. An explicit level on a task always wins. The main loop's effort is always yours (/effort, --effort, CLAUDE_CODE_EFFORT_LEVEL): Cockpit reads it and never rewrites it. |
| `maxEffort` | string (`low` / `medium` / `high` / `xhigh` / `max`) | `max` | **Reasoning effort ceiling.** Nothing above this level is ever requested for a subagent; a higher ask falls back and is recorded. Each model also has its own supported ceiling, so the applied level may still be lower. The main loop's own level is not Cockpit's to cap: use maxEffortLevel in settings for that. |
| `maxSonnetAgents` | number | `-1` | **Sonnet pool resource budget.** Independent Sonnet concurrency budget: -1 selects AUTO (8); 0 disables this pool; 1–128 selects an explicit budget, subject to the total budget. |
| `maxHaikuAgents` | number | `-1` | **Haiku pool resource budget.** Independent Haiku concurrency budget: -1 selects AUTO (16); 0 disables this pool; 1–128 selects an explicit budget, subject to the total budget. |

## The defaults in short

The summary table the README carries:

| Option | Public default |
| --- | --- |
| `hud`, `animation`, `sounds` | true |
| `volume` | 0.6 |
| `blastRadiusGuard`, `attributionGuard` | true |
| `guardAlerts` | false; owner alerts through the host's terminal notification. `guardCooldownSec` 300, `guardMaxAlerts` 5 |
| `guardRepeat` | false; persistent alerts (needs `guardAlerts`). `guardRepeatSec` 900 (minimum 60), `guardMaxReminders` 3 (maximum 10) |
| `guardSound` | false; tries the checkpoint cue, or the terminal bell, with each alert (needs `guardAlerts`, honours `sounds` and `/cockpit mute`) |
| `reducedMotion` | false; `COBALT_REDUCED_MOTION=1` also disables motion |
| `localControl` | true, optional detection |
| `ledgerPath` | empty, resolves from the environment |
| `orchestration` | false (observe); true enforces model/admission policy |
| `maxSubagents` | 0 = AUTO (16 total); explicit resource budget 1–128 |
| `maxSonnetAgents`, `maxHaikuAgents` | -1 = AUTO (8 Sonnet / 16 Haiku); 0 disables a pool; subject to total budget |
| `blockFable`, `subscriptionOnly`, `cobaltStrict` | false |
| `reasoningMode` | `AUTO`; `MANUAL` honours fixed per-tier levels for subagents; the main loop's effort stays yours |
| `maxEffort` | `max`; lower ceilings cap every subagent request and are recorded |
| `profile` | `OPUS_LED` (legacy: Opus main loop); `SONNET_LED` runs the main loop on Sonnet and consults Opus on admission |
| `routerConfigDir` | empty; a decision-router configuration directory you created for the JEV router mode, used only while a session's router is JEV |
