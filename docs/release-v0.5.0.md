# Cobalt Cockpit v0.5.0 — release notes

Core plugin only. v0.5.0 adds an optional Sonnet-led profile and an optional per-session router. Both are off unless you choose them: the default profile is still `OPUS_LED`, and every new session starts with the router `OFF`.

## What is new

**Sonnet-led profile (`profile: SONNET_LED`).** Sonnet 5.5 is the main model at your own effort. Haiku 5.5 scouts and Sonnet 5.5 engineers as before. Opus 5.5 runs at High, and only as a read-only architect consultation that Cockpit admits on a ground that holds on evidence: an architectural change of observed spread or named in your prompt, security-sensitive files or wording, the same failure three times, your explicit request, or a release approval. Your request, a release approval and a change to security-sensitive files make the consultation mandatory: the task holds below 100% until Opus has answered and the main session has verified the answer.

**Session router (`/cockpit router`).** For one session you may select a lightweight classifier that recommends how to handle a new task: `off` (the default), `nobodywho` (the local decision router) or `jev` (the same router's TypeSafe JEV provider, an external API). It recommends and nothing more; Cockpit's rules decide. Details, measurements and the privacy boundary are in the [README](../README.md#session-router) and [delivery-v0.5.0-router.md](delivery-v0.5.0-router.md).

**Progress.** A task that edits a second file with no plan gets one reminder to report its milestones. The `progress` tool's `gate` action can report several gates in one call.

The full list is in [CHANGELOG.md](../CHANGELOG.md).

## Upgrading from 0.4.0

```sh
claude plugin marketplace update cobalt-cockpit
claude plugin update cobalt-cockpit@cobalt-cockpit
```

Restart Claude Code and check `/cockpit version`. Settings, preferences and saved Run Ledgers are kept.

### What you will notice without changing any option

Your main model and the admission policy do not change. These do:

- `/cockpit version` prints one more line, `ROUTER / OFF · deterministic policy only`. There is a new `/cockpit router` command.
- Once per task, after the main session edits a second file without having declared a plan, one line reminding it to report progress is added to that edit's result. This also applies when orchestration is off.
- The `progress` tool accepts `gates` (several gates in one call), and the `swarm` tool lists a `consult` action, which is refused outside `SONNET_LED`.
- A new bundled agent, `cobalt-cockpit:architect`, appears in the agent list. Outside `SONNET_LED` it is an ordinary read-only helper.
- `/ledger` shows token usage by model tier where the host reports it.
- With orchestration on, a scoped helper's reads are checked more exactly. A `~` path is no longer treated as a directory inside the project (in 0.4.0 a helper that owned the project could read your home directory that way). A scoped helper's Glob or Grep pattern that is absolute, home-relative or climbs out with `..` is refused: give the directory as `path` and a pattern relative to it. A helper that owns everything, including an unassigned one, is not affected. Grep and Glob with no `path` are checked against the working directory.

Nothing is sent anywhere new, and no router process starts, unless you select a router in a session.

## Choosing the Sonnet-led profile

Keep your other options. CLI values are strings:

```sh
printf '%s\n' '{"orchestration":"true","profile":"SONNET_LED"}' | claude plugin configure cobalt-cockpit@cobalt-cockpit --values-stdin
```

`cobaltStrict` already turns orchestration on, and it never names a model: strict mode with `SONNET_LED` keeps Sonnet as the main loop. Then:

1. Make Sonnet the session's model (`/model sonnet`) and choose its effort yourself (`/effort medium` is the recommended starting point). Cockpit never rewrites the main loop's effort.
2. Optionally set Sonnet's compaction window natively: `/autocompact 400k`.
3. Restart Claude Code. `/cockpit version` shows `PROFILE / SONNET_LED · main claude-sonnet-5-5 · Opus on admission`.

To check what is really running, look at the model named on the assistant's messages and at `/cockpit version`, not only at the model selector.

## Using the router

```
/cockpit router              show it, and choose in an interactive session
/cockpit router nobodywho    local
/cockpit router jev          TypeSafe API: sends a prompt excerpt off the machine
/cockpit router off
```

The choice lasts for the session. JEV works only if your decision router allows it; the README shows how to give Cockpit's JEV mode its own router configuration without enabling JEV for anything else on the machine.

## Rolling back

To return to the Opus-led behaviour, set the profile back and restart:

```sh
printf '%s\n' '{"profile":"OPUS_LED"}' | claude plugin configure cobalt-cockpit@cobalt-cockpit --values-stdin
```

To return to the 0.4.0 code, install that commit from a clone:

```sh
git clone https://github.com/echelong/cobalt-cockpit.git
git -C cobalt-cockpit checkout c736bee361173a05622ccf8acc6d78b425386ab4
claude --plugin-dir /path/to/cobalt-cockpit
```

Run Ledgers written by 0.5.0 load in 0.4.0: the new fields are optional and ignored there. The `profile` and `routerConfigDir` options are ignored by 0.4.0.

## Verified for this release

- Suite: 1098 tests, with a mutation check for each security-relevant fix. TypeScript, strict plugin validation and the public audit pass.
- Two independent reviews of the complete change set. Their findings, including four ways a mandatory Opus review could have been discharged without an answer from Opus, are fixed and listed in the changelog.
- Isolated live sessions on Claude Code 2.1.296 with one Cockpit loaded: Sonnet 5.5 at medium as the main loop, Haiku scouting, a Sonnet worker, an Opus architect at High that read its evidence and was verified, no Opus during ordinary work, and each router mode with its fallback. See [delivery-v0.5.0-hardening.md](delivery-v0.5.0-hardening.md) and [delivery-v0.5.0-router.md](delivery-v0.5.0-router.md).

## Known limits

- Ground detection is lexical and by file name. A security-sensitive change described in unusual words, in a file with an ordinary name, raises no ground by itself.
- Progress reporting is the model's to make. The reminder is advice.
- A router's measured benefit over the rules is small once the rules go first, and the measurement is 56 synthetic tasks.
- If Opus is unavailable while a consultation is mandatory, the task stays below 100% and should be blocked with the reason.
