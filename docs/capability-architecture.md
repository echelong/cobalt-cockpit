# Hindsight and Obscura integration architecture

Research date: 2026-10-09. Development target: next feature release; the public
manifest remains 0.3.2. No release tag, directory request or publication.

## Existing architecture and integration boundary

`hooks/hooks.json` registers only `register.tsx`. That host module registers
progress/swarm tools, commands, native event guards, HUD and Run Ledger. The
other hooks reduce bounded observations: `model.ts` verification-gated task
progress; `swarm.ts` dependency/admission/ownership; `orchestra.ts` role and
review admission; `model-policy.ts`, `effort.ts` model/effort policy;
`ledger.ts` accounting; `replay.ts` sanitized bounded repository deltas;
`auth.ts`, `policy.ts`, `guard.ts`, `hygiene.ts` refusals; `nwho.ts` read-only
local decision receipts. View/field/progress/mascot modules render those
observations; sound/git/process helpers are existing bounded local effects.
Six agent definitions select the existing Sonnet/Haiku pools. The main loop's
effort remains operator-owned. Neither new service supplies models or agents.

Native tool permission decisions remain with Claude Code: no `tool.check`
hook is added. Bound helpers may call the two effect-free native control tools —
`ToolSearch` for deferred-tool discovery and `SubagentHandback` for a helper's
report to its native parent — without widening ownership; every tool discovery
surfaces still passes its own ownership and native-permission guard, delegation
stays commander-only, and a handback only records the helper's own report. A
helper's report delivery is tracked on its task (`reported`, `host_accepted`,
`answer_observed`, `unavailable`) so it is observable and is never treated as
verification. Since the custom handler answers before core execution, it
queries the supported native check explicitly and proceeds only on `allow`;
`ask`/`deny` refuse before config, worker or service I/O. Existing custom effects under orchestration require
exclusive wildcard writer ownership, and commander effects wait for active
agents. The companion checks this again, even if orchestration is disabled;
unbound agents are refused. A fixed per-UID local file lock serializes separate sessions. Companion
admission/forwarded-effect fences prevent load-order races with agent spawning
and concurrent main effects, independently of the base hook fence.
No agents are automatically spawned, no model requests rewritten, no gate
passed by memory or browser tools. The commander integrates untrusted evidence
and decides verification using the existing progress/swarm interfaces.

The optional `companions/` directory is an independently loaded Claude mod.
The base manifest, hooks, types and agent definitions are unchanged. Companion
host tools call a small Python broker by argument vector and bounded stdin,
never a shell. Broker reads only private operator JSON and invokes either the
stdlib REST adapter or the optional Node CDP worker. Its own HUD and receipt
store form the complete capability record. Base tool-call telemetry is
load-order dependent when the companion answers first; structured results
through the existing swarm/progress interfaces link evidence to the base run. Disabled calls skip
the worker/config/service entirely. No mandatory dependency in the base plugin.

HUD operation labels are observations, not inferences from the request. The
broker and the browser worker write one fixed-shape line per started operation
(`{"cobalt_step":"<name>"}`, an enumerated name and nothing else) to standard
error: the memory adapter when a validated request is about to be issued to
the service, the browser worker when a step begins. The host starts the broker
with `$.process.spawn`, reads that stream and maps each known name to a label;
every other byte on the pipe is discarded unread, and nothing from it is
stored. A call refused before service I/O therefore shows `Starting` and then
its result, never an operation.
The same loop bounds the worker: at the host deadline or on the dispatch's
abort signal (a user interrupt) it leaves the stream, which ends the child,
and records `worker_unavailable_or_timeout` or `interrupted`. A worker that
may already have changed something (navigate, click, fill, retain, forget)
is then recorded with possible effects; a worker that never started is not.

Companion placement is a runtime boundary, not an archive/scanner exclusion:
a future root checkout submission would contain these files. Keep v0.3.2's
already submitted commit immutable and package this companion separately for
owner/directory review. No changed directory submission has been made.

## Hindsight

Reviewed release [0.10.3](https://github.com/vectorize-io/hindsight/releases/tag/v0.10.3).
The [supported OpenAPI](https://github.com/vectorize-io/hindsight/blob/v0.10.3/hindsight-docs/static/openapi.json)
defines retain/recall/reflect, memory list and document deletion under
`/v1/default/banks/{bank_id}`. Cockpit offers only these narrow operations and
health status, not bank configuration/directives, full bank deletion or broad
upstream tools. Requests have wall-clock deadlines and response limits; no
redirects/proxies/cloud endpoint or credential input is accepted in v1.

Bank identity is SHA-256 of canonical credential-free Git origin identity
(transport/userinfo stripped, host normalized, repository path preserved),
or canonical Git common-dir when no suitable remote exists. Thus identical
basenames remain isolated and worktrees share project knowledge. Two clones of
the same repository share a bank deliberately. A changed remote can select a
different bank. Hashes are logical identifiers, not tenant access control.

Retain accepts one <=4,000-character manually reviewed summary with explicit
verification reference and run ID; commit, dirty-tree indicator, timestamp,
repository hash, document UUID and optional source references accompany it.
Retention and independent inference require separate operator configuration.
No transcript, prompt, hidden reasoning or source-file read API exists.
Secret detection is heuristic: the operator must review admitted summaries.
Service output is bounded/sanitized and tagged untrusted/non-authoritative,
including purported verified findings. Freshness is a local timestamp/commit
indicator, not proof. Scores measure relevance, not factual confidence.
Deletion needs the exact companion document ID repeated, within current bank.
The adapter never clears a bank. Timeout during retention has an uncertain
remote outcome; no automatic retry or claim of successful retention follows.

Hindsight consolidates retained documents in the background into derived
observations. The real service returned these without a document ID or any of
the companion's provenance, so the adapter reports them as `unverified` with
unknown freshness and cannot delete them individually. In the real smoke they
disappeared once their source documents were deleted (the bank listed empty);
that is upstream behaviour, observed rather than guaranteed, so check the bank
inventory after a deletion that matters.

Hindsight requires Python >=3.11, PostgreSQL/pgvector or its development pg0,
embedding/reranking and separately configured generation inference. The full
image is large; API minimum documented RAM ~1.5 GiB, plus database and model
memory. The [local inference deployment](https://github.com/vectorize-io/hindsight/blob/v0.10.3/docker/docker-compose/local-llm/README.md)
supports local CPU/GPU models without paid accounts. All databases/models/
caches must be mounted under `/mnt/mem2`. Do not assume subscription auth.
Disable `HINDSIGHT_API_LLM_TRACE_ENABLED` explicitly; upstream defaults can
store full inference prompts/output. Model/cache downloads and provider traffic
are separate from Claude Code model routing. Service operator controls backups,
traces, deletion and authorization; banks alone do not protect a shared API.

Rejected: upstream [Claude integration](https://github.com/vectorize-io/hindsight/blob/v0.10.3/hindsight-integrations/claude-code/README.md)
defaults to auto recall, full transcript/tool retention and basename banks;
direct upstream MCP exposes broader tools and doesn't enforce Cockpit
ownership. Embedding its runtime in the public mod adds unnecessary size,
process/inference/storage privileges. No upstream source is vendored (MIT).

## Obscura

Reviewed [0.2.4](https://github.com/h4ckf0r0day/obscura/releases/tag/v0.2.4).
This is a Rust/V8 browser engine with real JS, DOM and CPU rendering, not
Chromium. Its documented [CDP client interface](https://github.com/h4ckf0r0day/obscura/blob/v0.2.4/docs/Connect-Puppeteer-or-Playwright.md)
and [request interception](https://github.com/h4ckf0r0day/obscura/blob/v0.2.4/docs/Intercept-and-modify-requests.md)
are used through pinned `puppeteer-core`, not a custom protocol. No browser
runtime is downloaded or spawned by normal tools. Operator provides a dedicated
isolated loopback CDP service, without personal cookies, persisted storage,
proxy or stealth. OS/network isolation is mandatory operator configuration;
Obscura's [security boundary](https://github.com/h4ckf0r0day/obscura/blob/v0.2.4/SECURITY.md)
does not contain native V8 exploitation.

Each bounded task creates a fresh browser context and closes it in finally;
cleanup failure invalidates evidence without hiding effects that may already
have happened. All planned URLs are preflighted before connecting. CDP
interception checks subsequent requests and subresources against exact
origins, DNS/address policy, GET/HEAD and absence of credential headers.
Localhost needs separate consent; other private/linklocal/metadata addresses
remain refused. The render engine can issue a navigation redirect hop before
the request policy sees it: the real smoke recorded one request reaching a
non-allowlisted redirect target, so a navigation that does not end on an
allowlisted origin is refused after landing and external egress controls
remain the containment for that hop. External egress controls also cover DNS
rebinding, popup races, WebSocket handshakes (not covered by request
interception) and untrusted native execution; application checks alone do not
guarantee containment. The upstream global private-network switch must never
be described as localhost-only authorization.

A task whose only step is `status` is a readiness probe: it validates the
whole configuration, connects to the control endpoint and disconnects, with no
context, page or navigation. It is the only way the browser HUD shows `Ready`.

Fixed DOM extraction, snapshot, console/network observation, PNG screenshot,
and exactly granted click/fill return untrusted structured evidence. No
user-supplied evaluate, cookie access, storage import or file access tool.
Screenshots require ephemeral consent; network metadata drops path/query.
Page/console text secret redaction is heuristic, not guaranteed DLP. A GET
may mutate a server; origin authorization isn't semantic effect approval.
POST submissions, credentials, purchases and unrestricted destructive actions
are outside this adapter's supported effects. Actual execution never passes a
verification gate automatically. Maximum 12 steps, 30-second browser deadline,
bounded text/images/aggregate output. Resource limits must also bound service
CPU/RAM: V8/CPU rendering can consume substantial resources; no reliable
general workload estimate was measured.

Rejected: direct [upstream MCP](https://github.com/h4ckf0r0day/obscura/blob/v0.2.4/docs/Use-the-MCP-server.md)
shares context/cookies across clients and exposes storage/evaluate tools without
the required per-request host policy; `browser_close` isn't context isolation.
Embedding Rust/V8 in Cockpit would enlarge privileges/runtime and couple plugin
availability to an immature engine. Obscura is Apache-2.0; manual external
runtime installation avoids binary redistribution. Rendering is incomplete
relative to Chromium, so use native browser verification when that coverage
is needed. No stealth/anti-detection capability is enabled by this integration.

## Policy and rollout

The [Anthropic Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy)
limits history/user-file extraction, dynamically loaded behavioral instructions
and arbitrary remote connections. Curated technical findings, explicit
consent, untrusted recall and operator-controlled endpoints reduce risk but
do not establish eligibility. The [submission checklist](https://claude.com/docs/plugins/pre-submission-checklist)
also reviews external launchers/services and dynamic execution. This companion
requires independent review, especially memory persistence/inference and
generic browser networking. No scanner bypass or concealed capability.

Roll out privately to one disposable repository first, memory recall/manual
retention only; review bank/provenance/deletion; then bounded local frontend
browser evidence under real egress/OS isolation. Keep both off globally.
Preserve the existing directory submission. Owner approval is required before
public packaging, pushing, release or portal revalidation. See the delivery
report for mock vs real tests and remaining limitations.
