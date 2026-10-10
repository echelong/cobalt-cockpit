# Developing Cockpit under Auto mode

## Root cause of the protected-plugin-path failures

An empty `--plugin-dir` resolves to the working directory. When a development launch passes the snapshot through a variable (`--plugin-dir "$SNAP"`) and the variable is unset in a fresh terminal, Claude Code loads the **repository being edited** as the plugin directory and protects it from Auto-mode edits: the Edit and Write calls that change the repository are refused as writes to a plugin path.

It is an environment fault, not a Cockpit defect. The cure is never to loosen the host: do not switch to Accept Edits, do not disable the classifier and do not add blanket permissions. The cure is to load an out-of-tree snapshot, and to make launching without one impossible.

## The launcher

```sh
scripts/dev-launch.sh                     # snapshot of the committed tree (git archive HEAD)
scripts/dev-launch.sh --source WORKTREE   # snapshot including uncommitted changes
scripts/dev-launch.sh --check             # every preflight, then stop
scripts/dev-launch.sh -- -p "…"           # arguments after -- go to claude
```

It creates a private (mode 0700) snapshot under `${TMPDIR:-/tmp}/cobalt-inline-*` and refuses to launch unless:

- the snapshot path is nonempty, is a directory and has files;
- it is not the repository, is not inside it and does not contain it, and the working directory is not inside it;
- `.claude-plugin/plugin.json` exists in the snapshot and names `cobalt-cockpit` with a version.

It then starts `claude --permission-mode auto --plugin-dir <snapshot> --settings <overlay>`. The overlay switches the installed marketplace copy off for this launch only (so exactly one Cockpit is active) and configures the inline copy as `SONNET_LED`. No settings file is written, the permission mode is never anything but `auto`, no allow rule is added, and the installed production plugin is never touched. The snapshot is removed on exit unless `--keep` is given. `CLAUDE_CONFIG_DIR` is honoured; when unset and `~/.claude-main` exists, that is used.

A launch from the snapshot sees the code as of the snapshot: after committing, take a new one to review a candidate.

## Auto-mode release acceptance

Run for every release candidate, from a snapshot taken at the candidate commit (`--source HEAD`, clean tree):

1. Preflight: the process list shows one `--plugin-dir` with a nonempty `/tmp` snapshot distinct from the repository, one Cockpit in the session's init event, profile `SONNET_LED`, and genuine Auto mode (not Accept Edits, no classifier override, no blanket allow).
2. Real-host compatibility: in that session, an Edit and a Write to the repository succeed through the normal authorized flow, a Bash test run is recorded as a gate, and a protected path outside the working tree is still refused.
3. Record which decisions were **native Auto fast-path** (read-only and in-project edits allowed by the mode itself, no classifier) and which were **classifier-backed**. They are different evidence: the first says nothing about the classifier, and a classifier outage (unavailable, rate-limited) is a host condition, not a verdict on the candidate. Backend availability is not guaranteed and is never claimed.
4. The verification set, run fresh and never carried over from an earlier build: `claude plugin test .`, `tsc -p . --noEmit`, `claude plugin validate --strict` on `.`, `.claude-plugin/plugin.json` and `agents`, `python3 scripts/audit-public.py`, `scripts/scan-secrets.sh`, `git diff --check`.
5. The release consultation (below).

## Release consultation

One release-ground consultation per candidate commit, on a clean tree, from a snapshot of that commit. Three things stay apart:

- **Returned**: the architect finished and its answer was seen.
- **Verified**: the main session judged the advice (`swarm verify`) and, for a release, confirmed the architect's own `DECISION:` line.
- **GO**: only a returned, verified answer whose single `DECISION:` line reads exactly `DECISION: GO` approves. A NO-GO, a missing, repeated, hedged or decorated line, or a main-session claim that is more favourable than the architect's approves nothing. A recorded recommendation is final and a later turn of the same architect is kept beside it, never over it.

Owner approval to publish is a separate decision and nothing here implies it.

## Roadmap: v0.5.2 (not part of v0.5.1)

- Model-usage telemetry under `~/.local/state/cobalt-cockpit/telemetry/`.
- `/cockpit stats` with 7-day, 30-day and all-time aggregates.
- Real observed Haiku, Sonnet and Opus shares, and NobodyWho and JEV shares.
- A live animated COBALT NEURAL FLOW terminal HUD.
- The Auto-mode release acceptance above as a permanent gate.
