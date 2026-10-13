# Proposed roadmap: Cobalt Recall (optional reference memory)

Status: **research proposal only**. Not implemented, not approved for implementation, and not part of v0.6.3 Guard Calibration or v0.7.0 Diff-Aware Verification. No release number or delivery date is assigned. First decision is whether a controlled research spike justifies any integration.

## Goal

Give Cobalt Cockpit's agents relevant, source-linked knowledge at the moment they need it, without confusing retrieved text with instructions, authorization, current code, or verification. XERJ is a candidate **replaceable retrieval backend**, not the source of authority. Cobalt Recall is the proposed Cockpit layer that decides *whether* retrieval helps, *what* is admissible, *which revision* it came from and *how* to cite it.

The proposal is explicitly **not** a promise that an indexed corpus makes agents "superintelligent." Judge usefulness on measured task outcomes and costs.

## Existing roadmap and boundary

1. **v0.6.3 Cobalt Guard Calibration**: remains the next planned implementation milestone. [Scope](roadmap-v0.6.3-guard-calibration.md).
2. **v0.7.0 Diff-Aware Verification**: remains independent. [Scope](roadmap-v0.7.0-diff-aware-verification.md).
3. **Cobalt Recall research spike**, after the above or in a separately approved non-blocking investigation: benchmark XERJ against the native agent workflow.
4. **Optional integration prototype**, only if the spike passes a documented go/no-go review.
5. **Potential subsequent features**: durable decision memory, staleness detection, reviewed Corpus Hub imports, evidence-linked verification. No version assigned.

Retrieval must not change Cockpit's security guards, DONE criteria, reviewer verification, approvals, agent attribution, access scope, or native Claude Code permissions.

## Components and boundaries

| Component | Proposed responsibility | Must not do |
| --- | --- | --- |
| **Opus coordinator and existing swarm** | Decide how retrieved evidence applies to an assigned task; cite and verify before acting | Treat retrieval as proof a task is correct |
| **XERJ Community** | Locally index and query approved code, documentation, logs, and optional agent memory; provide search through a version-checked CLI, MCP or local HTTP adapter | Become a mandatory installation or silently send data remotely |
| **XERJ Corpus Hub** | Optional discovery of pinned public reference-code corpora and structured packs | Automatically import, execute or copy third-party code into a project |
| **NobodyWho** | Optional local retrieval decision, query selection, relevance/pruning and bounded context budget, compared against a deterministic baseline | Obtain authority over tool permissions, guard outcomes or release gates |
| **Run Ledger** | Remain the source of record for Cockpit decisions, reviews, verification and replay | Be replaced by a lossy search index |
| **Cobalt Recall (proposed)** | Compose source-scoped queries; deduplicate, filter, cite, rank and freshness-check results; surface uncertainty | Treat indexed content, model output or a remote corpus as trusted instructions |
| **Evidence checks** | Confirm repository, path, line span, blob/commit SHA, retrieval timestamp, scope, license and authority before reporting a source as current | Grant access outside an agent's declared ownership or convert absence of evidence into a pass |

### Data flows

- On a task: the coordinator or a bounded local decision rule may request retrieval with an explicit project/repository identity, purpose, allowable source scopes and token/time budget.
- Adapter queries only an operator-enabled XERJ instance, then returns a limited number of **untrusted citations**. At a minimum each result identifies source type, repository/corpus, source path, commit or content hash when available, excerpt, retrieval time, and freshness/permission state.
- NobodyWho may decline retrieval or prune *candidates*. A deterministic path must work without NobodyWho. Retrieval may not be needed on routine work.
- Every result is checked against the requesting agent's effective read scope **before** it is returned. No silent widening of an invalid scope to `*`; unresolved scope must fail closed or decline retrieval. Resolve the existing read-claim hardening roadmap first where relevant: [security follow-ups](roadmap-security-followups.md).
- A result from an old SHA must say **STALE/UNKNOWN** until checked against the current repository. A historical decision is not an instruction to repeat it.
- Returned material stays evidence, not authority. A reviewer or the coordinator must verify applicability against current files and tests.

## Proposed capabilities

### A. Project and cross-session engineering memory

- Search repo docs, architecture notes, accepted/rejected options, Run Ledger decisions and reviewer findings across sessions where permitted.
- Store only deliberately selected, compact decision records with provenance, reasoning summary, relevant paths and revisions; distinguish facts observed from hypotheses and operator preferences.
- Show contradictions and superseded decisions instead of silently preferring the latest or most semantically similar text.
- Keep the Run Ledger authoritative. Rebuildable indexes are caches, not durable ledgers; loss of XERJ must not lose decisions.

### B. Reference coding with pinned external knowledge

- Offer an explicit opt-in flow to select, inspect and import named Corpus Hub entries, pinned by source commit and with verified license boundaries.
- Treat per-corpus license descriptions as **claims requiring checks**, especially mixed-source or restrictive-license corpora. Track attribution and notices as needed. Do not paste code just because it was retrieved.
- Keep local project indexes and third-party reference corpora in distinct namespaces and retrieval results. Cite sources and avoid blending trust levels.
- Validate downloaded manifests, signatures/checksums where provided, size budgets and source pins before indexing. Never automatically run hooks or scripts from a corpus.

### C. NobodyWho-guided retrieval and pruning

- Compare (1) no retrieval, (2) deterministic retrieval, (3) NobodyWho-routed retrieval on the same task fixtures.
- Route by expected informational value and enforce maximum indexed files, search calls, returned excerpts, token budget and timeout.
- Expose why retrieval was skipped or why a document was selected, without leaking private corpus content to logs.

### D. Freshness and contradiction checking

- Bind code-derived results to exact repository identity, path and revision; label external references as **reference, not current project state**.
- Check repository movement, file changes, expired index freshness, deleted/renamed paths and conflicting current evidence.
- Never silently equate `unknown` with `current`, `verified` or `resolved`. Propagate freshness uncertainty to the UI and agent.

### E. Evidence-linked verification

- Let independent reviewers inspect the same bounded source citations and verify whether code changes actually conform to them.
- Log source identifiers, effective read scope, query version and freshness verdict, without capturing secrets or full private transcripts by default.
- Existing typecheck, tests, security, native permissions and human approvals remain mandatory. Retrieval is **not** a new independent release gate by default.

## Security, privacy and operator control (design blockers)

- **Local-first and opt-in**: no XERJ startup, auto-install, indexing, external network access, Corpus Hub sync, telemetry, AI embedding service or API-key change without operator opt-in.
- **Allowlist inputs**: default index excludes `.env`, credentials and keys, files that are ignored or private, uploaded customer material, sensitive logs and large generated artifacts; scrutinize symlinks, nested repositories, path traversal and file-permission boundaries. Avoid guessing what a user's data policy permits.
- **Prompt injection**: mark retrieved documents as untrusted data; sanitize display; never execute commands, agent directives, tool calls or file paths embedded in a retrieved excerpt.
- **External connections**: identify lexical/offline versus neural, embedding-proxy and reranking modes. Any mode that can transmit document excerpts, vectors or queries requires a separate explicit consent and network/privacy review.
- **Server binding**: if using local HTTP, require loopback-only authentication/TLS as appropriate. No default insecure publicly reachable service or automatically exposed MCP endpoint.
- **Retention**: per-project namespaces, quotas, retention, explicit inspect/export/delete/reindex, scoped deletion of memory and indexes, and test that deletion covers derived representations where supported.
- **Cost and storage**: XERJ advertises a free Community **single-node** tier with no per-document/vector/query license charges; self-hosting still costs machine resources. Paid Professional/Enterprise offerings exist. Current upstream license is reported as Apache-2.0, but pin and verify the actual version, NOTICE and bundled/transitive dependency terms before redistributing anything. No assumption of free remote AI embeddings/reranking or unlimited hosted service.
- **Location**: offer a configurable, project-external index/data path. On the owner's Fedora machine, bulky data should preferentially live on `/mnt/mem2`; this is a **local preference, not a portable Cockpit default**. Never index the XERJ data directory itself.
- **Reliability**: non-availability, corrupted cache, outdated index, missing XERJ or denied access must produce a clear degraded status and fall back to existing Claude/Cockpit behavior, never a guard bypass.
- **Multi-session**: avoid clobbering index metadata, leaking across unrelated projects or identities, and silently deleting shared memories; isolate namespaces and test concurrent writes/reads.
- **Governance**: document provenance and privacy in `PRIVACY.md`, security boundaries in `SECURITY.md`, and any upstream licensing/attribution in notices *if implemented*. Nothing in this proposal authorizes those runtime changes.

## Research spike: benchmark before integrating

Run in an isolated project with a pinned XERJ release or source SHA and an operator-approved set of non-sensitive fixture repos. Evaluate identical tasks, constraints and model settings under:

1. Native Claude Code tools and current Cockpit, with no XERJ.
2. Same workflow with a minimal XERJ retrieval adapter.
3. Same adapter with NobodyWho decision/pruning enabled, if available.

Select representative **unfamiliar** tasks: locating unfamiliar code paths, multi-file bug fixes, architectural evidence searches, doc-driven migrations and reviewer counterexample searches. Include negative controls: stale branch/index, conflicting architecture decision, ambiguous license, hostile prompt-injection document, missing corpus, missing backend and permission-scoped reviewers.

Record for each task: verified correct completion rate; tests/independent-review result; task time; full input/output token cost including indexing/query overhead; wall-clock latency (cold/warm); retrieval precision and citation correctness; scope violations; stale evidence accepted as current; data-leak attempts; RAM, CPU, disk and index time. Do not invent performance claims or compare unpaired tasks.

**Go/no-go**: approve only if retrieval measurably helps at least one valuable workflow without degrading verified correctness, guard behavior, privacy, reliability or operational cost. Report failures and tasks where native tools are better. Keep all raw observations reproducible; vendor benchmarks are hypotheses, not Cockpit acceptance evidence.

## Suggested implementation sequence, only after a GO

- **Spike 0: Upstream due diligence**: pinned license, available CLI/MCP/HTTP interfaces, local security defaults, memory APIs, maintenance, reproducible install/uninstall, availability and costs.
- **Spike 1: Offline, read-only adapter**: minimal optional search, local config, scoped citations, token limits, timeout/fallback, no new writable memory.
- **Spike 2: Evaluation**: baseline versus adapter, then NobodyWho route/prune, hostile/stale fixtures, cold-start/resource measurements.
- **Prototype 1: Decision memory**: operator-approved write/forget, per-project isolation, Run Ledger provenance and rebuildability, concurrent sessions.
- **Prototype 2: Corpus Hub imports and source freshness**: per-entry license/pin review, explicit download, signatures where supported, status UI and purge.
- **Prototype 3: Evidence-linked reviewer handoff**: scoped citations and trust labels, no changes to Cockpit guard or release verdict semantics.

Each stage gets a separate branch, independent Sonnet review, full security/TypeScript/strict/audit tests, Gitleaks, appropriate real-host acceptance and an explicit human GO. No feature lands solely because it passes a retrieval benchmark.

## What this proposal does not commit to

No new release number, no dependency installation, no cloud account, no automatic downloading from hub.xerj.org, no private-code upload, no remote model spend, no change to v0.6.3/v0.7.0 scope, and no claim that a local semantic index is authoritative or makes an agent more intelligent.

## Upstream references for the eventual spike

- [XERJ repository and Apache-2.0 license](https://github.com/xerj-org/xerj)
- [Community versus paid editions](https://www.xerj.org/pricing/)
- [Agent quickstart: local memory and Elasticsearch-compatible surface](https://www.xerj.org/docs/agents/quickstart)
- [Corpus Hub registry, pinned sources and license review](https://www.xerj.org/docs/corpus-hub)
- [Corpus Hub catalog](https://hub.xerj.org/)
- [XERJ machine-readable onboarding](https://xerj.org/llms.txt)

These describe upstream behavior at research time and must be checked again against the pinned version when the spike begins.
