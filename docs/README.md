# Cobalt Cockpit documentation

The root [README](../README.md) is the front page. These files hold the detail.

## Guides

| Page | What it covers |
| --- | --- |
| [orchestration.md](orchestration.md) | Observation and enforcement, elastic execution, task ownership, waves and escalation, dynamic reasoning effort |
| [sonnet-led.md](sonnet-led.md) | The `SONNET_LED` profile: Sonnet as the main loop, Opus as an admitted read-only consultation, setup and rollback |
| [verification.md](verification.md) | Discovery levels, decision records, the goal check, what happens after DONE, and the limits of all of it |
| [cobalt-guard.md](cobalt-guard.md) | Owner alerts: persistence, the inbox, shared history, record-only mode, priorities, quiet hours, the pinned row, notification transport, calibration |
| [session-router.md](session-router.md) | The optional per-session router (NobodyWho or JEV), what it may recommend, what JEV sends, and the read-only NobodyWho telemetry |
| [configuration.md](configuration.md) | Every option with its type, default and description, printed from the manifest |
| [development.md](development.md) | Loading the plugin for development, the validation commands, the manual TypeScript gate |
| [development-auto-mode.md](development-auto-mode.md) | Developing Cockpit under Auto mode: the out-of-tree snapshot launcher and the acceptance procedure |
| [assets/README.md](assets/README.md) | The README's artwork and demo: provenance, what is captured and what is presentation, regeneration |

## Policies

| Page | What it covers |
| --- | --- |
| [PRIVACY.md](../PRIVACY.md) | What Cockpit observes, what is kept and where, retention, deletion, telemetry, the router, exports |
| [SECURITY.md](../SECURITY.md) | Local persistence, environment and process access, working-tree measurement limits, hooks that refuse, agent identity, guard limitations, reporting a vulnerability, secret scanning |
| [CHANGELOG.md](../CHANGELOG.md) | Changes by version |
| [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES) | Adapted work and upstream MIT notices |

## Implementation notes, by version

| Version | Page |
| --- | --- |
| 0.6.6 (Stage A, unreleased) | [Git hardening: submodules, partial clones and the runner's admission](implementation-v0.6.6.md) |
| 0.6.5 | [v0.6.4 maintenance: CI and the Plugin Directory](implementation-v0.6.4.md#after-publication) |
| 0.6.4 | [Fingerprint resource hardening (security)](implementation-v0.6.4.md) |
| 0.6.3 | [Cobalt Guard Calibration](implementation-v0.6.3.md) |
| 0.6.2 | [Persistent Attention](implementation-v0.6.2.md) |
| 0.6.1 | [Smarter swarm operations](implementation-v0.6.1.md) |
| 0.6.0 | [Mission Control operations](implementation-v0.6.0.md) |
| 0.5.9 | [Record-only mode and the since-last-look summary](implementation-v0.5.9.md) |
| 0.5.8 | [Inbox consistency and the return digest](implementation-v0.5.8.md) |
| 0.5.7 | [Alert inbox and recovery](implementation-v0.5.7.md) |
| 0.5.6 | [Alert priorities, quiet hours and the pinned alert row](implementation-v0.5.6.md) |
| 0.5.5 | [Verified notification transport](implementation-v0.5.5.md) |
| 0.5.4 | [Persistent alerts](implementation-v0.5.4.md) |
| 0.5.3 | [Authorization and identity hardening](implementation-v0.5.3.md) |
| 0.5.2 | [Implementation notes](implementation-v0.5.2.md) |
| 0.5.1 | [Discovery and decision quality](implementation-v0.5.1-discovery.md) |
| 0.5 | [Sonnet-led profile](implementation-v0.5-sonnet-led.md) |
| 0.3.2 | [Directory compliance](implementation-v0.3.2.md) |
| 0.3.1 | [Effort Fidelity](implementation-v0.3.1.md) |
| 0.3 | [Implementation report](implementation-v0.3.md) |
| 0.2 | [Implementation report](implementation-v0.2.md) |

## Release notes, checklists and delivery reports

| Page | What it is |
| --- | --- |
| [release-v0.5.0.md](release-v0.5.0.md) | v0.5.0 release notes |
| [release-v0.4.0.md](release-v0.4.0.md) | v0.4.0 release notes |
| [release-v0.1.1.md](release-v0.1.1.md) | v0.1.1 release notes |
| [release-checklist-v0.5.3.md](release-checklist-v0.5.3.md) | v0.5.3 release gates, including the manual TypeScript attestation |
| [release-checklist-v0.5.2.md](release-checklist-v0.5.2.md) | v0.5.2 release checklist |
| [delivery-v0.5.0-router.md](delivery-v0.5.0-router.md) | Delivery report: the session router, with its measurements |
| [delivery-v0.5.0-hardening.md](delivery-v0.5.0-hardening.md) | Delivery report: v0.5.0 release hardening |
| [delivery-sonnet-led.md](delivery-sonnet-led.md) | Delivery report: the Sonnet-led profile |
| [roadmap-security-followups.md](roadmap-security-followups.md) | Security follow-ups recorded after v0.6.1: a P0 on a guard that throws refusing nothing (fixed by the 0.6.1 security hotfix), and read claims widening to `*` (not changed) |
| [roadmap-v0.7.0-diff-aware-verification.md](roadmap-v0.7.0-diff-aware-verification.md) | Roadmap, v0.7.0: evidence that correlates changed lines with measured coverage (in development, not released) |
| [design-v0.7.0-diff-aware-verification.md](design-v0.7.0-diff-aware-verification.md) | Design, v0.7.0: approved decisions, host and coverage-tool measurements, and what Phase 1 implements (pure modules, not registered) versus later phases |
| [roadmap-cobalt-recall-xerj.md](roadmap-cobalt-recall-xerj.md) | Future research proposal: optional Cobalt Recall, XERJ/Corpus Hub integration, source-linked decision memory, NobodyWho retrieval gating, privacy and evidence-freshness benchmarks (not implemented; no release assigned) |
| [roadmap-v0.6.3-guard-calibration.md](roadmap-v0.6.3-guard-calibration.md) | Roadmap, v0.6.3: human labels on recorded incidents and a simulation of the alert policy against them, to inform the decision to enable alerts (implemented in v0.6.3: [implementation-v0.6.3.md](implementation-v0.6.3.md)) |
| [roadmap-v0.6.2-persistent-attention.md](roadmap-v0.6.2-persistent-attention.md) | Roadmap, v0.6.2: acknowledged incidents whose conditions are still open, in the alert digest (implemented in v0.6.2: [implementation-v0.6.2.md](implementation-v0.6.2.md)) |
| [roadmap-v0.5.3-verification-intelligence.md](roadmap-v0.5.3-verification-intelligence.md) | A proposal for verification intelligence |

## Directory submission and upstream

These pages are preparation and evidence. None of them reports an acceptance by the Anthropic Plugin Directory; [implementation-v0.6.0.md](implementation-v0.6.0.md) records that status as NOT VERIFIED.

| Page | What it is |
| --- | --- |
| [marketplace-submission.md](marketplace-submission.md) | Submission preparation for the v0.5.3 candidate |
| [submission-compliance-v0.5.3.md](submission-compliance-v0.5.3.md) | v0.5.3 submission compliance evidence |
| [upstream-issue-host-declarations.md](upstream-issue-host-declarations.md) | A draft issue for the host about plugin declarations (not filed) |
