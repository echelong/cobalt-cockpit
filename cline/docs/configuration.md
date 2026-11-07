# Configuration reference: Cobalt Cockpit for Cline

Every setting the adapter reads, its default and what it does. The defaults are in
[`config/default.json`](../config/default.json); the validator is [`src/config.ts`](../src/config.ts). This page
describes the adapter in `cline/` only; the Claude Code plugin's options are in
[docs/configuration.md](../../docs/configuration.md) at the repository root.

## Where settings come from

Later sources win:

1. `cline/config/default.json`, shipped with the code.
2. Your file: `--config FILE` if given, otherwise `$XDG_CONFIG_HOME/cobalt-cockpit-cline/config.json`
   (`~/.config/cobalt-cockpit-cline/config.json` when `XDG_CONFIG_HOME` is unset), if it exists. `--config`
   replaces the user file; the two are never combined.
3. Command-line overrides: `--budget-usd N` sets `budgets.sessionUsd`.
4. The profile: `--profile NAME`, otherwise `COCKPIT_CLINE_PROFILE`.
5. `--no-strict` sets `strict` to `false`.

Files are merged key by key: an object in your file is merged into the default object, and **any other value,
arrays included, replaces the default**. Setting `sandbox.hide` therefore replaces the whole default list, while
a partial entry such as `"profiles": { "cline": { "roles": { "coder": { "reasoning": "high" } } } }` changes only
that field and keeps the coder's model and version pin.

The merged result is validated strictly. An unknown role, a missing provider or model, an unknown reasoning
level, a negative or non-numeric limit, a value above a documented maximum or a refused sandbox path is an error,
and nothing runs; nothing falls back to a default. `cockpit-cline doctor` and `cockpit-cline models` show the
effective profile, roles, models and reasoning; they do not print budgets, limits or sandbox settings.

**Changing settings and existing conversations.** A mission records a digest of its effective configuration
when it starts, and a copy of that configuration (`config-snapshot.json` in its state directory, mode 0600).
Reopening it under a different effective configuration is refused, with the settings that differ listed: other
budgets, limits, roles, models, reasoning, version pins, tools, sandbox paths, strictness, a different Cline version.
Start a fresh conversation (`--new` in the interactive shell), or pass `--accept-config-change` (to the shell or to
`recover`) to continue anyway: that is recorded, and the mission can then no longer reach `DONE`. `recover` resumes
a mission with that mission's own profile and strictness; reopening a conversation in the interactive shell uses
the current settings, so a different `--profile` or `--no-strict` there counts as a configuration change.

The one exception is text that changes nothing: a profile's `description`, which only `doctor` prints. When the
snapshot is intact (it must hash to the digest the mission started with) and nothing but descriptions differ, the
mission continues without acceptance, and its ledger records `config_equivalent` with the descriptions that
changed (written once the reopened mission runs and holds its supervisor lock). Every other setting counts,
including an unknown key, a reordered list and a change that looks safer (an extra `sandbox.hide` entry or a lower
budget); see
[Existing conversations and new defaults](#existing-conversations-and-new-defaults-migrate-config).

A minimal user file:

```json
{
  "schema": 1,
  "budgets": { "sessionUsd": 1.0 },
  "sandbox": { "allowRead": ["~/.cargo/bin", "~/.rustup"] }
}
```

## Top level

| Key | Default | Meaning |
|---|---|---|
| `schema` | `1` | Required; must be `1`. |
| `profile` | `"cline"` | The profile in `profiles` whose roles are used. Overridden by `--profile` or `COCKPIT_CLINE_PROFILE`. |
| `strict` | `true` | In strict mode a worker that completes without its reasoning effort being confirmed on the wire fails as a wire mismatch instead of being accepted. `--no-strict` turns it off for a new mission. Version pins and the broker's model and effort checks apply in both modes. |

## Profiles and model roles

`profiles.<name>` has a `description` (shown by `doctor`) and `roles`, which must define exactly the five roles:

| Role | Default model (`cline` profile) | Reasoning | Used for |
|---|---|---|---|
| `coder` | `deepseek/deepseek-v4.1-flash-1017`, `requireName: "1017"` | `xhigh` (sent as `max`) | implementation work, by default every write task |
| `commander` | `moonshotai/kimi-k3.1-pro` | `high` | plans for substantial goals, architecture, critical review, escalation target |
| `specialist` | `xiaomi/mimo-v2.6-pro` | `high` (toggle model: thinking on) | non-trivial debugging, independent review, complexity 4+ engineering |
| `frontend` | `qwen/qwen3.8-max-0902`, `requireName: "0902"` | `xhigh` | frontend and UI work, long-context tasks |
| `utility` | `zai/glm-5.3-flash` | `low` | low-risk read-only scouting, narrow low-risk documentation edits |

The `cline-pass` profile uses the same roles with the `cline-pass/…` model ids. ClinePass lists no
version-pinned Qwen3.8 Max 0902, so its `frontend` role is refused until you opt in through `unpinnedAllowed`.

Each role:

| Field | Required | Meaning |
|---|---|---|
| `provider` | yes | The Cline provider id. Only `cline` and `cline-pass` can be served by the credential broker; a role on any other provider fails `doctor`, and its tasks fail before a worker starts. |
| `model` | yes | The exact model id in the **installed** Cline catalog. Aliases (such as `~deepseek/deepseek-flash-latest`) are refused; the catalog entry's id must equal this string. |
| `reasoning` | yes | `none`, `low`, `medium`, `high` or `xhigh`: the level passed to `cline --thinking` on every spawn. |
| `requireName` | no | A version string that must appear in both the catalog id and the catalog name. Without a match the role is refused unless `"<provider>/<model>"` is in `unpinnedAllowed`. Leave it out rather than set it empty or `null` (both are errors). |

**How reasoning is checked.** The requested level is compared with the levels the catalog lists for that model.
A listed level is sent as is. `xhigh` on a model that lists `max` but not `xhigh` is sent as `max`: Cline 3.0.74
does this for DeepSeek V4.1 Flash 1017, and it is the only translation accepted. A toggle-only model (MiMo V2.6 Pro)
means thinking on for any level other than `none`. Any other level the model does not list is refused, never
downgraded. The effort that reached the provider is checked per request by the host-side broker; a request with
another effort fails the attempt.

## Escalation

`escalation` maps each role to the role an implementation failure escalates to, or `null` for none.

| Default | |
|---|---|
| `coder`, `specialist`, `frontend` | `commander` |
| `utility` | `coder` |
| `commander` | `null` |

A role cannot escalate to itself. A failed debugging or test task escalates to `specialist` first, whatever this
map says, unless it already ran on `specialist` or `commander`. How many escalations a task may make is
`limits.maxEscalationsPerTask`.

## Budgets

| Key | Default | Meaning |
|---|---|---|
| `budgets.sessionUsd` | `3.0` | Spend cap for the mission (one interactive conversation or one `run`). `--budget-usd N` overrides it. |
| `budgets.sessionTokens` | `40000000` | Token cap for the mission (input + output). |
| `budgets.taskUsd.<role>` | commander `1.5`, coder `0.75`, specialist `0.75`, frontend `1.0`, utility `0.2` | Spend cap for **each attempt** of a task on that role. A task with a correction and an escalation can spend the sum of its attempts' caps. |
| `budgets.taskTokens.<role>` | commander `3000000`, coder `4000000`, specialist `3000000`, frontend `3000000`, utility `1000000` | Token cap for each attempt. |
| `budgets.alertAt` | `[0.5, 0.8, 1.0]` | Fractions of a cap at which an alert is recorded and shown; each must be in (0, 1]. |
| `budgets.allowUnmetered` | `false` | When `false`, an attempt whose cost cannot be measured (model turns without a usage event, or no reported cost and no pricing) is stopped as `unmetered`. `true` lets it continue; such work is still labelled unmetered and the session cap cannot account for it. |
| `budgets.onSessionCap` | `"cancel"` | What happens at the session cap: `cancel` stops admissions and cancels running workers; `drain` stops admissions and lets running workers finish. |

Caps are enforced from the usage the API itself reports, so one in-flight request can exceed a cap; see README
limitation 5.

## Estimates and pricing

`estimates.<role>` is the configured worst case reserved against the session budget **before** a worker starts:
`input` and `output` are token counts, and `cacheRatio` (0 to 1) is the share of input charged at the cache-read
price. Defaults:

| Role | `input` | `output` | `cacheRatio` |
|---|---|---|---|
| commander | 300000 | 30000 | 0.5 |
| coder | 400000 | 20000 | 0.6 |
| specialist | 300000 | 20000 | 0.5 |
| frontend | 300000 | 20000 | 0.5 |
| utility | 100000 | 5000 | 0.5 |

With the default figures a commander plan reserves about $0.63 although real plans have cost about $0.05, so a
session cap below that refuses `/swarm` before it starts. Lowering the estimates lowers the reservation and
allows a larger overrun of a single request.

`pricingOverrides` replaces the catalog price of a model, keyed by its model id (for example
`"deepseek/deepseek-v4.1-flash-1017"`), with four numbers in US dollars per million tokens (the figures below
illustrate the format; they are not a price list):

```json
{ "pricingOverrides": { "deepseek/deepseek-v4.1-flash-1017": { "input": 0.3, "output": 1.2, "cacheRead": 0.03, "cacheWrite": 0 } } }
```

Pricing is used for the pre-spawn reservation and for labelled estimates when Cline reports tokens but no cost
(or a $0 cost for a priced model). A cost Cline reports is used as reported. Default: `{}` (catalog prices).

## Limits

| Key | Default | Bounds | Meaning |
|---|---|---|---|
| `limits.concurrency.total` | `6` | at least 1 | Workers running at once in a mission. |
| `limits.concurrency.<role>` | commander `1`, coder `6`, specialist `2`, frontend `2`, utility `4` | at least 0 | Workers running at once per role. |
| `limits.perProvider.<provider>` | `cline` `6`, `cline-pass` `6` | at least 0 | Workers at once per provider. The effective cap halves after a provider error and grows back by one per success, up to this value. |
| `limits.spawnsPerMinute` | `12` | at least 1 | Worker starts per minute. |
| `limits.minFreeMemoryMB` | `700` | at least 0 | While at least one worker runs, no further worker starts with less free memory than this. |
| `limits.maxLoadPerCpu` | `2.0` | at least 0 | While at least one worker runs, no further worker starts above this load average per CPU. |
| `limits.maxQueue` | `64` | at least 1 | Queued tasks before new ones are refused (backpressure). |
| `limits.maxTasksPerMission` | `null` | `null` or at least 1 | Total tasks in a mission; `null` is no cap. |
| `limits.maxDelegationDepth` | `2` | at most 4 | How deep work requested by a worker (`COCKPIT_REQUEST`) may nest. |
| `limits.maxChildrenPerTask` | `3` | at least 0 | Tasks one worker may request. |
| `limits.maxAttemptsPerTask` | `4` | 1 to 8 | All attempts of a task: the first, corrections, escalations and transient retries. |
| `limits.maxCorrectionsPerTask` | `1` | at most 2 | Corrections on the same model, given its diff and the gate output, before escalating. |
| `limits.maxEscalationsPerTask` | `1` | at most 2 | Escalations to another role. |
| `limits.maxTransientRetries` | `2` | at most 5 | Retries on the same model after a transient failure: a provider error, a rate limit, a timeout, resource exhaustion or a run whose outcome is unknown. No model is substituted. |
| `limits.retryBaseMs`, `limits.retryMaxMs` | `2000`, `30000` | at least 0 | Exponential backoff with jitter for transient retries: a delay between half and all of `min(retryMaxMs, retryBaseMs × 2^n)`. |
| `limits.providerUnhealthyAfter` | `2` | at least 0 | Consecutive provider errors before the provider's circuit breaker opens and further work on it waits. |
| `limits.workerTimeoutSeconds` | `1800` | at least 0 | Passed to `cline -t`: the longest one worker run may take. |
| `limits.gateTimeoutSeconds` | `900` | at least 0 | The longest one gate command may take. |
| `limits.clineRetries` | `3` | at least 0 | Passed to `cline --retries`: Cline's own retries of a failed API request inside one run. |
| `limits.pageSize` | `256` | at least 1 | Records per page in a mission's archive. |
| `limits.maxStoreBytes` | `268435456` (256 MiB) | at least 1 | Above this size of a mission's state directory no further work is admitted. Nothing is deleted automatically. |

## Version pins: `unpinnedAllowed`

A list of `"<provider>/<model>"` strings that may run although the model does not carry the role's
`requireName`. It is an explicit opt-in per model. Default `[]`. For the ClinePass frontend role:

```json
{ "unpinnedAllowed": ["cline-pass/cline-pass/qwen3.8-max"] }
```

## Sandbox

Workers and gates see only an allowlist of the host (README limitations 2, 3, 21 and 22, and
[SECURITY.md](../../SECURITY.md#cobalt-cockpit-for-cline)). Two settings adjust it.

| Key | Default | Meaning |
|---|---|---|
| `sandbox.allowRead` | `[]` | Extra **read-only** host paths for workers and gates, such as a toolchain or a virtualenv. Each must be absolute or start with `~/`. Each is checked on its real path and refused if it is `/`, a system tree (`/proc`, `/sys`, `/dev`, `/run`, `/var/run`, `/boot`, `/root`), a home directory or an ancestor of one, or if it is, contains or lies inside a credential or private-state location (among them `~/.cline`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config`, `~/.cache`, `~/.local/share`, `~/.local/state`, `~/.npm`, `~/.npmrc`, `~/.docker`, `~/.kube`, `~/.cargo/credentials`, shell histories and rc files; the full list is `SECRET_HOME_PATHS` in [`src/sandbox.ts`](../src/sandbox.ts)). `~/.cargo/bin` is accepted; `~/.cargo` is refused because it contains `~/.cargo/credentials`. |
| `sandbox.hide` | `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gcloud`, `~/.claude`, `~/.local/state/cobalt-cockpit-cline` | A second layer: each existing path that lies inside something already mounted is covered (a directory by an empty tmpfs, a file by `/dev/null`). Paths outside every mount are already invisible and are skipped. Your list replaces this one: to add a path of your own, list the defaults you want to keep as well. |
| `sandbox.allowNetwork` | (removed) | An error if present. Workers reach only the Cline API through the broker; gates have no network. |

The `--share DIR` option is separate: it read-only-binds a dependency directory of your repository, such as
`node_modules`, into worker and gate sandboxes, and refuses `.git`, `.env` and paths outside the repository.

## Existing conversations and new defaults: `migrate-config`

Earlier, the shipped `sandbox.hide` also named three paths of one machine (`~/.claude-main`,
`~/.local/share/cobalt-cockpit-evidence`, `~/.local/share/cobalt-cockpit-backup-key`), and the `cline-pass`
description named a setting that does not exist (`allowUnpinned`). Both are gone from the defaults. If you want to
keep hiding paths of your own, put the whole list in your user file, because a list in your file replaces the
default one:

```json
{ "sandbox": { "hide": ["~/.ssh", "~/.gnupg", "~/.aws", "~/.config/gcloud", "~/.claude", "~/.local/state/cobalt-cockpit-cline", "~/.my-private-dir"] } }
```

Any change to the defaults changes the digest that existing conversations were started with. Missions made before
snapshots existed have no copy of their configuration, so nothing can prove that only a description changed for
them. `migrate-config` shows what a change would do and, only when you ask, records the missing snapshots:

```sh
git show <old-commit>:cline/config/default.json > /tmp/old-default.json      # the defaults they ran under
cockpit-cline migrate-config --previous-defaults /tmp/old-default.json \
  --proposed-config ~/my-new-config.json                                       # dry run: reads, writes nothing
cockpit-cline migrate-config --previous-defaults /tmp/old-default.json --apply # after copying the file into place
```

The report shows the current and the proposed configuration (digest and runtime fingerprint), every setting that
differs and whether any of them is security-relevant, and for each mission: the digest it started with, whether its
original configuration is proven (by its snapshot, or by rebuilding it from the defaults and user file you name and
matching its digest), whether the interactive shell would resume it, and the outcome: `unchanged`, `continues`
(descriptions only), `continues once its snapshot is recorded`, or `REQUIRES --accept-config-change`.

`--apply` creates `config-snapshot.json` only in open conversations whose outcome is `continues once its snapshot
is recorded`. It creates that one file, only if it does not exist yet, complete or not at all, so it is safe to run
twice, at the same time or after an interruption. It skips a conversation held by a running shell or supervisor
(and one whose lock it cannot read or that belongs to another host), and leaves a stale lock for `recover`. It writes
nothing to the mission's ledger: the snapshot records how and from which files it was made, and the ledger records
that as `config_equivalent` when the conversation next runs. It never edits a configuration file or a mission
header, never records a snapshot it cannot prove, never overwrites an existing snapshot (an invalid one is reported
and left alone), leaves closed conversations and other missions as they are, and never accepts a configuration
change. Each mission is judged as reopened with its own profile and strictness, as `recover` does; the interactive
shell uses the current `--profile` and `--no-strict`. Pass `--config FILE` for the user file the missions ran under if
it is not the default one, and `--json` for the report as data.

## Tools

| Key | Default | Meaning |
|---|---|---|
| `tools.allowed` | `read_files`, `search_codebase`, `run_commands`, `editor` | Cline tools a write task may use. |
| `tools.readOnlyAllowed` | `read_files`, `search_codebase`, `run_commands` | Cline tools a read-only task may use. |

Any other tool call, launching an agent, or a Git command that changes history, branches, remotes or configuration
(`commit`, `push`, `checkout`, `branch`, `config` and others) ends the run (Cline's `PreToolUse` hook cancels it). The lists are a policy layer inside the sandbox, not the boundary: adding a tool lets the model
use it, and the sandbox still decides what that tool can reach.

## Environment variables

| Variable | Meaning |
|---|---|
| `COCKPIT_CLINE_PROFILE` | The profile, unless `--profile` is given. |
| `COCKPIT_CLINE_STATE` | The state directory (default `$XDG_STATE_HOME/cobalt-cockpit-cline`, `~/.local/state/cobalt-cockpit-cline`); the `--state DIR` option overrides it for one command. |
| `COCKPIT_CLINE_DATA` | Cline's data directory, whose sign-in the broker reads and refreshes (default `~/.cline/data`). |
| `NO_COLOR`, `COCKPIT_COLOR`, `COCKPIT_REDUCED_MOTION` | HUD colour and motion (README, HUD 2.0). |
| `COCKPIT_WATCH_MS` | How long `watch` runs when its input is not a terminal (default 1500 ms). |

No variable chooses where the broker sends your token, or which bubblewrap or Cline Cockpit runs. `COCKPIT_BROKER_UPSTREAM`,
`COCKPIT_CLINE_BWRAP`, `COCKPIT_CLINE_BIN`, `COCKPIT_CLINE_CATALOG_BIN` and `COCKPIT_CLINE_NODE` were removed:
the broker always uses `https://api.cline.bot`; bubblewrap is the root-owned system binary; Cline is the one in the
Node installation that runs Cockpit (else `/usr/local/bin` or `/usr/bin`), owned by you or root and writable by
nobody else; Node is the `node` on `PATH` (see [SECURITY.md](../../SECURITY.md#what-cockpit-runs-and-what-chooses-it)).
`bin/cockpit-cline` also clears `NODE_OPTIONS`, `NODE_PATH`, `NODE_COMPILE_CACHE`, `LD_PRELOAD`, `LD_AUDIT` and Node's TLS and proxy settings (`NODE_TLS_REJECT_UNAUTHORIZED`,
`NODE_EXTRA_CA_CERTS`, `NODE_USE_ENV_PROXY`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `SSLKEYLOGFILE`, `OPENSSL_CONF`)
before Node starts; started any other way with one of them set (or any `NODE_OPTIONS`), the broker refuses to run.
