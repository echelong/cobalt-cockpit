# Optional capability delivery — 2026-10-09

Development implementation for the next feature release. The public plugin
version remains v0.3.2; the separate companion is provisionally 0.1.0.
Both capabilities default OFF. No production installation, GitHub push, release
tag or changed Anthropic directory submission has occurred.

## 1–2. Architecture and actual functionality

Hindsight uses a narrow stdlib Python REST client against an independently
operated numeric-loopback API. Implemented status, explicit recall, reviewed
verified-summary retain, reflect, bounded list and scoped forget. Provenance
includes repository hash, HEAD, dirty status, run, timestamp, verification and
source references. Recall is always untrusted/non-authoritative and includes
age/commit/relevance indicators, never claimed factual confidence. Service
failure falls back safely; ambiguous retention reports an unknown outcome and
document ID for reconciliation. Reflection is implemented and mock-tested,
but was not exercised against real inference.

Obscura uses its supported CDP interface through pinned puppeteer-core. Tasks
create/close a fresh context, apply request policy, navigate and inspect real
JS-rendered DOM, capture readable snapshots/console/network metadata and
optionally ephemeral PNGs. Click/fill need exact private operator grants.
No arbitrary agent JavaScript, cookie/storage tools, credential submissions,
POST forms, stealth or proxies. Execution returns structured untrusted evidence
pending commander verification, never an automatic pass.

The separate native Claude mod registers tools, calls a bounded broker by
argument vector/stdin, checks native permission (`allow` only), and fences
ownership/admission/effects independently of plugin load order. No orchestrator,
agent pool, model provider or routing layer is introduced. NobodyWho remains
the existing read-only local decision/pruning/control layer. Full analysis and
rejected alternatives: [architecture](capability-architecture.md).

## 3. Files changed

Added companion manifest, native hooks/state contract, private config example,
README/license/notices, Python broker/memory adapter, Node browser worker,
pinned optional npm package/lockfile, deterministic Python/Node tests and two
opt-in real-service smoke scripts under `companions/`.

Added `tests/capabilities.test.ts`, this report, architecture/setup documentation
and bounded [real evidence metadata](capability-evidence.json). Updated README,
SECURITY and PRIVACY to distinguish base behavior from enabled capabilities.
CI gains an independent offline adapter job plus companion strict/type checks.
`.gitignore` and the public audit exclude only host-generated declarations and
Python bytecode; authored companion code remains audited.

Unchanged: base `.claude-plugin` manifests, all registered base hooks/types,
all six agent definitions, model hierarchy/effort, base HUD styling and core
Run Ledger/verification logic. The original submitted commit is preserved.

## 4–5. Dependencies and exact configuration

See the complete [setup/configuration instructions](../companions/README.md)
and [tested disposable service recipes](capability-smoke-setup.md). Required:
Claude Code 2.1.294 for this verification, Linux Python >=3.11, and browser-only
Node >=22.12 with optional puppeteer-core25.13.0. Hindsight0.10.3 independently
needs a database/embeddings/reranker/generation inference; Obscura0.2.4 needs
the render-enabled, nonstealth binary and OS/network isolation. Neither is a
base plugin dependency or automatic installer. Upstream license/runtime/model
conditions are documented and no full upstream repository is vendored.

Copy the companion into a separate `/mnt/mem2` development installation, use
its lockfile with `npm ci --ignore-scripts`, and load it explicitly alongside
the checkout. In supported plugin configuration set `configurationPath` to a
UID-owned regular 0600 JSON file and enable only the desired host switch.
Separately enable the same private JSON switch. Native `/permissions` approval
of the exact tool is also required; enable switches never imply permission.

Memory config: `memory_enabled`, numeric-loopback `hindsight_endpoint`,
`memory_retention_consent`, `memory_inference_configured`,
`memory_timeout_ms` (100–120000). Browser config: `browser_enabled`, loopback
`obscura_endpoint`, exact `browser_allowed_origins`, independent
`browser_allow_localhost`, `browser_isolation_confirmed`,
`browser_timeout_ms` (100–30000), exact `browser_authorized_actions`,
`screenshot_retention` (`none` or `ephemeral`). No credential inputs or automatic
recall/transcript hooks. Explicit task-start recall is available to commander.
Fixed per-UID operation locks live under `/mnt/mem2`; configurations cannot
select different lock directories and bypass cross-session exclusivity.

## 6–8. Isolation, security/privacy, HUD and ledger

Bank ID hashes canonical credential-free Git repository identity, with verified
Git common-dir fallback; same repository worktrees/clones share a bank, unrelated
repository basenames do not. Remote changes may change bank selection. Logical
banks do not substitute for service tenant authorization.

Only reviewed short findings/provenance or explicit queries go to Hindsight;
no transcript/source-file read API. Generation/embedding/reranking/consolidation
are Hindsight's separate inference and must be explicitly configured. Tested
deployment used local CPU Qwen with tracing/audit storage disabled. Enabled
browser networking and untrusted JS are explicit: Obscura is not a native
exploit sandbox. External OS/egress isolation is required for DNS rebinding,
WebSockets, popup races and the broad upstream private-network flag. Contexts
never inherit personal cookies. Secret filtering is heuristic; GET can mutate
a server. Native permission deny/ask, missing ownership and resource conflicts
refuse before worker/config/service I/O.

The optional static HUD row displays observed tool activity/readiness and bank;
both switches off leave the HUD untouched. `/capabilities` displays/stores
64 projected metadata receipts: operation, result count, duration, bank/task,
browser operation names and fixed fallback/error codes. Queries/findings/page
contents/URLs/PNG bytes are not stored in receipts. Explicit ephemeral PNG/tool
responses can still enter Claude Code's own session history.

Base tool-call telemetry depends on hook order when the companion answers
first; the dedicated companion receipt is the complete capability record.
Commander structured `swarm result`/verification links evidence to the base
run. No automatic gate pass, simulated browser result or inference progress.

## 9–10. Verification and real end-to-end evidence

| Check | Observed result |
|---|---|
| Baseline plugin tests before edits | 987 passed,0failed |
| Full final plugin suite | 995 passed,0failed (987existing+8new) |
| Hindsight/bridge deterministic Python suite | 24 passed (20memory+4broker) |
| Obscura deterministic Node suite | 25 passed; injected CDP client |
| Root and companion TypeScript | Passed against generated Claude declarations |
| Strict root/manifests/agents/companion validation | Passed on Claude2.1.294 |
| Public audit | Passed,0portability/credential findings |
| Git whitespace | Passed |
| Real Claude host with both mods disabled | `/capabilities` succeeded, no inference/service install |
| Real Hindsight0.10.3/local CPU Ollama | Retain/list/recall/forget/failure/recovery passed |
| Real Obscura0.2.4 isolated namespace | JS/DOM/PNG/console/network/isolation/refusal/interaction/timeout/recovery passed |

The new source-guard tests run the actual two hook implementations in both
orders with a mocked host, including admission/effect races and native deny/ask.
They are deterministic tests, not an enabled Claude conversation smoke.

Real Hindsight: dedicated Podman storage/pg0 and isolated CPU-only
Ollama qwen2.5:3b. First successful retain72,220ms; final retain30,478ms with
CPU prompt cache, recall3 extracted findings65ms, own document deletion11ms,
zero findings afterward. A verified disposable stale-lock failure/recovery
fixture supplied the admitted summary. Missing endpoint reported unavailable
and real endpoint recovery ready. No paid/cloud inference or production data.

Real Obscura: pinned archive checksum matched upstream; bubblewrap fresh
network namespace, read-only runtime/worker mounts, tmpfs and cleared environment.
Real JS mutation and localStorage isolation, 9,046-byte PNG, console.error,
network200, blocked foreign origin (server0hits), metadata refusal, unauthorized
click refusal/granted click, deadline failure and fresh recovery all passed.
Main integrator independently reran this smoke. No screenshot persisted.

All created services stopped. Hindsight container/image/model/db in the
dedicated store were removed; existing Ollama/Podman resources preserved.
Browser test binary/dependencies/cache and isolated host config were removed.
Only small Hindsight evidence/logs (~68KiB) remain under `/mnt/mem2`.
Replaying requires explicit setup again; smoke scripts never install services.

## 11–12. CI and Anthropic directory

The new independent Actions job uses Python stdlib and Node mocks without
installing puppeteer/browser/database/models or contacting an integration
service. Existing verify job keeps offline plugin tests and adds companion
strict/type checks. Its relevant test/type/validation/audit commands passed
locally. No GitHub run for this unpushed commit was triggered or claimed.
The existing main workflow [run37767849204](https://github.com/echelong/cobalt-cockpit/actions/runs/37767849204)
was successful at baseline commit9fabc6692e85b507b96bfc9b618ca39ad667dea1.

Directory eligibility is unresolved, not certified by local strict validation.
Networking, memory persistence, independent inference, external processes/CDP
and browser JavaScript require explicit policy review. A repository-root
submission can include companion files even though runtime registration is
separate; future packaging must deliberately exclude them unless approved.
No scanner restrictions are concealed/bypassed, and the submitted version is
unchanged publicly. Do not request portal revalidation automatically.

## 13–15. Limitations, rollout and Git

Remaining limits: real reflection and fill were not exercised; general browser
conformance/public-network containment are not established; this is Linux-only
broker locking and loopback-only services without credential support. CPU
retention needs an explicitly raised timeout and workload-specific validation.
HUD activity is whole-tool/coarse rather than live per-CDP-step navigation/
capture states. Companion receipts remain pending/unknown rather than copying
commander verification or retaining durable image/evidence references, and
old receipt store is not reloaded in a new session. Fine-grained HUD/ledger
enhancements should precede a broad feature-release acceptance claim.

Independent security/privacy review used a separate Codex agent, not the
requested Sonnet model. It identified permission/ownership/lock/data-boundary
defects that were fixed; no remaining known source security blocker was found,
conditional on passing final tests (now passed). Actual requested Claude-model
review remains a rollout requirement if the owner requires that exact reviewer.
The real service smokes do not establish a fully enabled Claude task end-to-end.

Recommended rollout: private explicit companion install for one disposable
repository; memory manual recall/retention only; then local frontend evidence
inside actual OS/egress isolation. Leave both off globally. Obtain directory
review and owner publication approval before any public integration release.

Work stayed on `main`, starting from clean9fabc6692e85b507b96bfc9b618ca39ad667dea1.
Base manifests remain0.3.2. Changes are committed locally only after checks;
the delivery response supplies the final commit hash and clean working-tree
state. No branch/history rewrite, force-push, tag, production installation or
GitHub publication. This delivers real optional adapter capabilities with the
documented remaining feature-release acceptance limits above.
