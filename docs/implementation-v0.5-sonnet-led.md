# Sonnet-led profile (unreleased, after 0.4.0)

**Sonnet builds. Haiku scouts. Opus reviews. NobodyWho advises.**

This milestone adds a second orchestration profile, `SONNET_LED`, beside the existing behaviour, which is kept unchanged as `OPUS_LED` and remains the default.

## 1. Architecture recovery (0.4.0)

Where 0.4.0 assumes or enforces that Opus is the main commander:

| Location | Assumption |
| --- | --- |
| `hooks/model-policy.ts` `MAIN_MODEL = 'claude-opus-5-5'`, `desiredRequest()` | The main loop's model is Opus. |
| `hooks/register.tsx` `turn.step` | With orchestration enforced, **every main-loop request is rewritten to Opus** (`constrained = { ...e, model: MAIN_MODEL }`). A user who picks Sonnet with `/model` is overridden; the mismatch is recorded in the ledger. The main loop's *effort* is never rewritten. |
| `hooks/register.tsx` `agent.spawn` | Every orchestrated spawn is forced to Sonnet or Haiku. An OPUS swarm task is refused (`OPUS task stays in commander`), so no Opus subagent can exist. |
| `hooks/swarm.ts` `admissionReason`, `bindAgent` | OPUS tasks are main-loop tasks: "commander occupied", never bound to an agent, not counted in the subagent budget. |
| `serveSwarm` `result` | Reporting an OPUS task's result completes it immediately (it is the main loop's own work). |
| `hooks/orchestra.ts` `orchestrationText`, `hooks/effort.ts` `effortPolicyText` | System prompt: "You are the Opus 5.5 commander"; escalation Haiku → Sonnet → Opus. |
| `agents/*.md` | "Escalate … to the Opus commander". |
| `hooks/orchestra.ts` `mainLabel` | HUD `OPUS / MAIN` (read off the observed model, so it already showed the truth). |

How the main model is enforced: only through `turn.step`, the one hook every model request passes, using the engine's supported request rewrite. That is a native interface, not a permission bypass: the engine resolves the new model again under its own access rules, caps and overrides. `SONNET_LED` uses the same mechanism to request Sonnet, so nothing new is bypassed.

Audit of the decision router (the user's global instruction calls `decision ask`): the router on this machine runs in `local-first` mode. Tiers D1 (local specialist) and D2 (Qwen3.5 9B) are NobodyWho; D3 (JEV, typesafe API) is hard-disabled ("never called in any mode or environment"). So `decision ask` is already a genuine, local, unpaid NobodyWho interface. No global configuration was changed. Cockpit's existing NobodyWho integration was read-only telemetry over the router ledger (`caller: "claude"` receipts). The host offers `$.process.run`, so Cockpit can call the router itself.

Compaction: `~/.claude*/settings.json` already holds `modelSettings["claude-sonnet-5-5"].autoCompactWindow = 400000` (set natively with `/autocompact`). The host declares the window's source (`env`, `settings`, …) in `SessionContextUsage.autocompactSource`; `CLAUDE_CODE_AUTO_COMPACT_WINDOW` would outrank settings. Cockpit adds no compaction command and writes no setting. Subagents keep their own model's defaults.

## 2. Design

### Profile

`userConfig.profile`: `OPUS_LED` (default) or `SONNET_LED`. It applies only with orchestration enforced (`orchestration` or `cobaltStrict`). `isSonnetLed()` in `register.tsx` gates every new path.

### Model policy (`hooks/model-policy.ts`)

`mainModel(profile)`; `desiredRequest(agentId, tier, profile)`: the main loop gets the profile's model and **no effort** (the user's own). `OPUS` is a subagent tier at `high` effort, used only in `SONNET_LED`.

### Opus admission (`hooks/consult.ts`, pure)

- **Grounds.** `architecture` (≥5 milestones, ≥5 files or ≥3 directories touched, or architecture/migration named in the prompt), `security` (security-sensitive path touched, or security named in the prompt), `repeated-failure` (the same failure 3 times in a row: failed, was told to change approach, failed again), `asked` (the prompt asks for Opus), `release` (release approval/gate). Prompt matches ignore negated phrasing ("do not publish", "no release").
- **Mandatory.** `asked`, `release`, and security-sensitive files changed. The task's `review` requirement holds it at 99% / UNVERIFIED, and a VERIFY milestone cannot complete, until the consultation has returned **and** the main session has adjudicated it with `swarm verify` (pass or fail, with evidence). Grounds only accumulate; a new ground kind after adjudication reopens the review.
- **Evidence packet.** objective, architecture, files, alternatives, failures, risk, decision; clipped (1200 chars per field, 12 × 300 per list). Required parts depend on the ground.
- **Bounds.** One live Opus consultation; an unchanged problem (FNV-1a over normalized objective, decision, files, failures, alternatives) is never consulted twice once it returned; one retry after a failed or cancelled run; three discretionary per task (twelve per session). Release consultations have their own allowance (v0.5.1): see the release-review budget below.
- **Lifecycle.** A consultation's state is read off its OPUS swarm task (admitted → running → returned / failed / cancelled); verification is that task's `verification`.

### Swarm (`hooks/swarm.ts`)

`SwarmConfig.opus` (0 by default and in older ledgers, which keeps every legacy OPUS semantic). Above 0, OPUS tasks are real subagents: their own pool, counted inside `total`, bindable. `SONNET_LED_SWARM = { total 4, sonnet 2, haiku 2, opus 1 }` applies where the operator left budgets on AUTO.

### Host wiring (`hooks/register.tsx`)

- `turn.step`: main tier SONNET in `SONNET_LED`; a subagent bound to an OPUS task is requested on Opus.
- `swarm consult`: validates ground and packet, runs `consultVerdict` (no router is asked), records the consultation, submits a read-only OPUS task owning the packet's files inside the project, advances the task's review to `admitted`, and returns the architect brief.
- `swarm assign` refuses tier OPUS in `SONNET_LED`; `swarm verify` on a consultation adjudicates the task's review.
- `agent.spawn`: an OPUS task spawns only with a recorded consultation and only as `cobalt-cockpit:architect`, on Opus. An unassigned call naming Opus or the architect, or the architect on a non-OPUS task, is refused (not silently downgraded).
- `prompt.submit` and edits: mandatory grounds are computed from the **full** prompt text (the stored prompt is clipped) and from touched files.
- System prompt: a `SONNET_LED` section replaces the commander text.

### Session router

The consult-time NobodyWho advice first built for this profile was removed before release. Routing advice is now a per-session choice (`/cockpit router`: off, NobodyWho or JEV), asked once at the start of a task and judged by the rules. Design and measurements are in [delivery-v0.5.0-router.md](delivery-v0.5.0-router.md).

### HUD and Ledger

`SONNET_LED` labels: `MAIN / SONNET`, `SCOUT / HAIKU`, `ENGINEER / SONNET`, `ARCHITECT / OPUS`, `LOCAL CONTROL / NWHO`, `OPUS CONSULTS` with per-consultation lines (ground, mandatory, status, Sonnet's verification, NobodyWho receipt), and `USAGE / OBSERVED`. Tiers come from the observed model, never the label. The Run Ledger adds `observed by tier` (host-reported request tokens; requests without figures counted as unreported, never estimated), `host cost` (the host's own `/cost` total, or `unavailable`), and `11 OPUS CONSULTATIONS` (why admitted, what was asked, the decision returned, verified by main, the NobodyWho receipt or its absence). Consultation packets are shrunk first when the stored ledger exceeds its budget. `OPUS_LED` output is byte-identical to 0.4.0.

## 3. Migration

1. Keep `orchestration` (or `cobaltStrict`) on.
2. `claude plugin configure cobalt-cockpit@cobalt-cockpit`, and set `profile` to `SONNET_LED`.
3. Pick the main model's effort as usual (`/effort medium` recommended). Set the compaction window natively if wanted: `/autocompact 400k` while on Sonnet.
4. Restart Claude Code. `/cockpit` shows `PROFILE / SONNET_LED · main claude-sonnet-5-5 · Opus on admission · budget 4 …`.

Ledgers, preferences and existing swarms carry over: every new field is optional and absent fields mean legacy behaviour.

## 4. Rollback

Set `profile` back to `OPUS_LED` (or remove it) and restart. The main loop is constrained to Opus again, the Opus pool goes back to 0, and OPUS tasks return to the main loop. Recorded consultations stay readable in the ledger. To return to 0.4.0 code entirely: reinstall the 0.4.0 plugin; 0.4.0 ignores the new optional fields.

## 5. Limitations

- Ground detection is deterministic and lexical over prompts and paths: it can miss an architectural change described in other words (the main session can still consult on size), and a prompt that merely mentions security makes `security` *available*, not mandatory.
- Mandatory review cannot be waived by the model. If Opus is unavailable, the task stays UNVERIFIED and should be blocked with the reason.
- Usage is what the host reports per request. Unknown remains unknown; cost is the host's session total, not per tier.
- Live authenticated comparisons are recorded in the delivery report, not in this document.

## Release-review budget (v0.5.1)

Invariant: discretionary consultations (every ground except `release`) are at most 3 per progress task and 12 per ledger; release consultations are never counted in either. A release consultation is admitted only for a candidate, the full 40- or 64-hex commit id of HEAD with an empty `git status --porcelain`; otherwise the verdict is `CANDIDATE UNKNOWN` and nothing starts. For one candidate: one returned consultation (a repeat is `DUPLICATE`, however the packet is worded, because the key is the commit and not the text), at most 2 admitted attempts (`RELEASE RETRY BUDGET`), and at most 6 release consultations per ledger (`RELEASE ALLOWANCE`). The record `{candidate, id, at, returned}` is kept in the plugin store (`release-reviews`, newest 32), read again at every request, so a task reset or a session restart neither erases it nor reopens it; `returned` is set as soon as the host has observed the architect finish (checked at each consultation and progress call), not only when the main session adjudicates it. Ids are unique across the ledger and the store (the counter is the larger of the two), so a restart cannot overwrite a spent attempt. The record is written before the consultation is admitted, and a store that cannot be read, or holds something that is not a list, fails a release request closed. Release requests are serialized, so two at once cannot both pass the bounds. Release records are kept ahead of ordinary ones in the ledger's consultation list. The review requirement carries the candidate; whenever HEAD or the working tree no longer matches, an adjudicated release review goes back to `required` without a consultation and remembers what lapsed; the same commit, clean again, with that consultation having returned, gives it back. A git that does not answer neither withdraws nor restores, and an approval with no commit behind it (a legacy one, or one from another ground) does not stand. A new release consultation for another commit never inherits the earlier approval. Normal admission (profile, ground, one live Opus, ownership, permissions, packet checks) applies first and unchanged. Limits: a consultation that returned in a session that ended before any further call was made is not marked returned, so the cap of two attempts per commit is what bounds it; the store keeps 32 records (and two Cockpits sharing one store can lose an update, as the write is read-modify-write), so a commit older than that is reviewable again.
