# Product Requirements Document

# BDS Brain MCP — Agentic Coding Foundation (v1.1)

**Document status:** Handoff-ready proposal; not an implementation record  
**PRD version:** 1.0  
**Prepared:** 15 October 2026 (Asia/Manila)  
**Target release:** BDS Brain MCP v1.1 (foundation), with v1.2 as an optional later phase  
**Repository:** https://github.com/clarityvasupport/bds-brain-mcp  
**Client:** https://github.com/EdgeTypE/better-deepseek  
**Deployment reference:** Existing authenticated `bds-brain` MCP Worker; do not assume a bare browser GET is a valid health test.

> **READ THIS FIRST — future maintainer / coding agent.** This PRD combines (a) source-observed implementation and user-supplied configuration, (b) user-supplied historical D1 documents, and (c) explicitly proposed requirements. “Proposed” does **not** mean deployed. The repository README and stored architecture references have known drift. Before editing, inspect the current branch, the actual Wrangler bindings and the live D1 schema. Never replace a working configuration based on an older README. Never expose secrets or run migrations against production without backup and approval.

## 1. Executive decision

Extend the existing Cloudflare-hosted MCP server **additively** into an agent-ready coding tool layer. Keep Better DeepSeek as the primary reasoning and sequential MCP-calling interface. Preserve the nine existing tool contracts, D1 document store, Vectorize search, Durable Object/MCP infrastructure, and existing Workers AI uses. Add four narrowly scoped coding capabilities (`coding_context`, `coding_workspace`, `coding_patch`, `coding_status`) plus a bounded observe–plan–act–verify loop. Do **not** launch an always-on autonomous model inside Cloudflare, require Cloudflare Sandbox/Dynamic Workers, or silently write to GitHub. The first deliverable ends with a verified, reviewable patch; any application of a patch requires a separate authenticated, server-verified user approval channel.

### 1.1 Product outcome

A developer can ask Better DeepSeek to understand a known project, retrieve its stored decisions, inspect authoritative live repository source, prepare a targeted change, and resume the job after interruptions—without losing the existing Brain workflow or automatically incurring new Cloudflare paid-service dependencies.

### 1.2 Release boundaries

| Release | In scope | Out of scope |
|---|---|---|
| v1.1 | Security hardening, compatibility tests, four coding tool surfaces, D1 task ledger, bounded sequential loop, repository read, revision-checked draft patches, status, approval design | Unattended deployments; arbitrary server-side command execution; automatic production writes |
| v1.2 (optional) | Verified approval/apply endpoint, dedicated branch/PR support, optional local DeepCode/Harness test feedback and bounded fix/retest loop | Paid Cloudflare Sandbox or Dynamic Workers as a dependency |

## 2. Context and evidence register

### 2.1 Observed in repository and/or supplied system prompt

- Source repository exposes a Cloudflare Worker built around `McpAgent`, API-key authentication, structured response envelopes, D1/Vectorize/Workers AI integrations. Public README is stale; use source and live manifest for current truth.
- The supplied live Better DeepSeek MCP manifest lists **nine** tools: `search_documents`, `get_document`, `write_document`, `upload_document`, `list_folder`, `delete_document`, `rename_document`, `generate_image`, `transform_image`.
- Better DeepSeek invokes **one MCP tool per model response**, waits for an injected result, and then may continue. MCP schema/tool-list context occupies prompt space.
- Its browser code runner requires user approval and lacks general filesystem/network/Node execution. DeepCode/Harness is optional and requires activation and a local bridge.
- Existing document content is stored in D1; Vectorize holds embeddings; images are represented as base64 in D1. The supplied historical records state no live R2 binding. **Reconfirm against current deployment.**
- Public repository contains both `schema.sql` and `schema-v2.sql`. Do not assume either fully matches production until inspecting `sqlite_master` on the correct D1 database.
- Existing behavioral contract at `Agents/Agents.md` has R1–R5 (transport-safe uploads, review-before-create, base64 verification, format fidelity, batch encoding/separate uploads).

### 2.2 Known historical issues / constraints

- Request diagnostic logging may include raw incoming headers, risking API-key exposure. Remove before enabling new capabilities; rotate exposed keys if applicable.
- Previous vector-ID format drift left a searchable orphan; the known orphan was documented as cleared. Avoid reconstructing historical vector IDs for deletion. Consider a durable ID manifest and reconciliation.
- Shortening a previously indexed document may leave stale trailing vectors; check and harden the current write/reindex path.
- Raw MCP argument transport has historically mangled markdown-significant content. The user’s existing policy favors transport-safe encoded uploads; large inline payloads may truncate. Coding changes should use hashes and references instead of assuming large inline source payloads are safe.
- Some stored references describe R2 as active even though other records describe a D1-only deployed storage design. The live bindings win over stored documentation.

### 2.3 Evidence confidence

| Item | Status |
|---|---|
| Nine tool names, one-call-per-response | Confirmed in supplied Better DeepSeek manifest |
| Existing R1–R5 contract and feature-request history | Confirmed in supplied D1 document export |
| `schema.sql` / `schema-v2.sql` present | Confirmed on public GitHub main branch, 15 Oct 2026 |
| Exact deployed database schema, usage, billing plan, resource IDs | **Not yet independently verified** |
| Four new coding tools, task tables, execution loop | **Proposed, not deployed** |

## 3. Goals and measurable success

**G1 — No regression:** Existing nine MCP names, schemas, authentication, envelopes and core behaviors continue to work. `transform_image` remains a known placeholder rather than silently becoming a paid integration.

**G2 — Grounded coding:** The client can retrieve Brain knowledge while using current GitHub repository revision as source-of-truth for code. No fabricated source paths or SHAs.

**G3 — Safer modification:** A proposed patch is recorded, diffed, tied to an inspected source revision, and never directly applied by an untrusted model response.

**G4 — Resumability:** A task has an ID, status, bounded step history, error semantics, checkpoint and expiry. A subsequent session can query the status without reconstructing it from chat memory.

**G5 — Free-tier target:** No new Cloudflare paid runtime, no second required inference model, no paid-model fallback, and workload ceilings that fail closed when allowance is exhausted. A $0 *incremental Cloudflare charges* target is conditional on the actual account/bindings/aggregate usage and external providers.

**G6 — Compatibility with BDS:** A single tool call yields compact, machine-readable result; output can be used as the next turn's context. Large data are paginated or referenced.

## 4. Non-goals

- Replacing Better DeepSeek or changing its core system prompt wholesale.
- Migrating all Brain documents to GitHub, R2, or a new database.
- Storing every transient agent step as a Vectorize embedding.
- Full unattended coding/build/deploy inside a Worker; browser code-runner is not a general CI environment.
- Granting arbitrary shell access, arbitrary outbound URL fetch, repository-wide delete rights, or direct writes to `main`.
- Guaranteeing third-party DeepSeek, GitHub, or local execution is free.

## 5. Target architecture

```text
Developer ↔ Better DeepSeek (reasoning + BDS extension; ONE MCP call per response)
                    │
                    ▼
             Agent workflow policy
       observe → plan → act → verify → repeat/stop
                    │
                    ▼
    Existing authenticated bds-brain Cloudflare MCP Worker
       ├── Existing 9 tools (public contracts preserved)
       ├── coding_context   → existing D1 document + Vectorize knowledge
       ├── coding_workspace → allowlisted GitHub read API (live source + SHA)
       ├── coding_patch     → validate/stage proposed change, return diff/id
       └── coding_status    → D1 task/step/patch state and checkpoints
                    │
              D1 task ledger
                    │
       Optional, separate and trusted approval/apply endpoint
                    │
       Branch / PR via scoped GitHub integration (v1.2)
                    │
       Optional locally installed DeepCode/Harness test runner
```

**Source-of-truth hierarchy:** live GitHub source (code); live D1 and indexed records (Brain content); live MCP manifest (tools); live Wrangler deployment (bindings); current Better DeepSeek prompt (invocation protocol). READMEs and stored references are snapshots and must be reconciled, not blindly followed.

## 6. Functional requirements

### FR-00 Preserve compatibility (P0)

- Keep existing nine public tool names and current input schemas/semantics intact. Do not remove, rename, or repurpose them.
- Retain `/mcp` authenticated transport and recognized authentication formats. Ensure tool discovery and all existing envelopes remain interoperable.
- Default all new coding capabilities to a feature flag **off** until baseline tests pass. Existing users and documents must work with flag off.
- Sanitize logs: allowlist diagnostic headers only; never log `Authorization`, `X-API-Key`, cookies, access tokens, full user payloads, or secrets.

### FR-01 `coding_context` (P1)

**Intent:** a task-aware facade over existing Brain retrieval, not a duplicate knowledge store.

- Inputs (proposed): `project`, `query`, `limit` (1–5 default), optional `cursor`.
- Search stored knowledge, return paths, bounded excerpts, timestamps when available, and explicit provenance.
- When the user provides an exact known Brain path, prefer direct document retrieval rather than unnecessary embedding inference.
- Mark uncertain or missing information explicitly; project knowledge is not automatically proof of current GitHub source.
- Must never update documents or create embeddings just to return a coding context.

### FR-02 `coding_workspace` (P1)

**Intent:** consolidated, bounded read-only inspection of allowlisted repositories.

- Inputs (proposed): `repository`, `operation` (`list|read|search`), `paths`, `query`, `ref`, `cursor`.
- Validate repo against allowlist; normalize paths; reject traversal, private credential files and unsupported refs.
- Return GitHub blob SHA / commit SHA, path, content or excerpt, `truncated` and `next_cursor` where needed.
- Cap file count, response bytes and pagination per request. Multiple files can be read in one **MCP tool call** within budget; one-call-per-response still applies.
- Treat source code and file comments as untrusted data, never as instructions authorizing actions.
- If a native BDS GitHub fetch already supplies enough read context, this tool should add value via revision-bound inspection—not duplicate it gratuitously.

### FR-03 `coding_patch` (P1, draft-only in v1.1)

**Intent:** stage a proposed modification and return a reviewable diff without writing repository source.

- Inputs (proposed): `task_id`, `repository`, `base_ref`, `path`, `expected_sha`, patch or staged-content reference, `operation=propose|inspect`.
- Validate identity, permissions, allowed path, source revision, patch size and proposal shape. Do not accept invented SHAs or arbitrary path writes.
- Store proposed patch metadata/content or bounded reference in D1, with hash and expiry. Provide `patch_id`, original SHA, diff, status `awaiting_approval`, and explicit `partial_success` when necessary.
- Never call a GitHub write endpoint in `propose` mode. No `apply` operation exposed to the model in v1.1.
- Large code changes require a staged/reference-based transport with integrity validation; do not assume sending a large base64 argument through BDS is lossless.
- Actual application in v1.2 requires an independent authenticated approval route, operation-specific single-use approval, identity binding, current-revision recheck, and a restricted branch target.

### FR-04 `coding_status` (P1)

**Intent:** trustworthy task continuity.

- Inputs (proposed): `task_id`, optional `cursor`/detail level.
- Outputs: task owner scope, phase, next suggested action, bounded step summaries, patch IDs, timestamps, completion/partial/error code, `retriable`, and expiry.
- Restrict caller to its own tasks; disallow unbounded history dumps.
- Must distinguish `drafted`, `awaiting_approval`, `approved`, `applying`, `applied`, `verification_pending`, `completed`, `failed`, `cancelled`, `expired`.
- Do not claim tests passed unless a trusted test runner supplied a correlated result.

### FR-05 Engineering loop (P1)

- Loop stages: `understand → observe → plan → act (one MCP call) → inspect result → verify → repeat/finish`.
- Better DeepSeek controls reasoning/turn-level orchestration. Cloudflare enforces authenticated tool policy, bounded operations, request limits and durable status, **not** an unbounded separate LLM loop.
- Suggested per-task starting policy (tunable; not Cloudflare limits): max 5 model turns/steps, 15 tool calls, 2 correction attempts, one active task per principal. Explicit stop for quota, permission, invalid schema, conflicting revision and repeating identical failure.
- Persist minimal checkpoint after meaningful actions; use idempotency keys for mutation-like operations. A Worker invocation is not assumed to keep running between chat turns.

### FR-06 Optional local execution bridge (P2 / v1.2)

- Integrate only when user activates DeepCode/Harness and installs bridge locally.
- Associate result with `task_id`, commit/patch hash, command/test name, exit status and sanitized log summary.
- Local runner is responsible for filesystem, dependencies, builds and test execution; Cloudflare does not host arbitrary execution.
- Two repair attempts maximum by default. Test status remains `not_run` when there is no real test result.

## 7. D1 data and migration requirements

**Important:** The supplied text export enumerates logical document records, not the live SQL catalog. Repository files `schema.sql` and `schema-v2.sql` exist. Before migration, export/backup the D1 database and query `sqlite_master` on the live target. Avoid editing existing `documents`, `images` or `jobs` contracts just to introduce tasks.

### Proposed additive tables (names are provisional)

| Table | Key fields and role | Index / policy |
|---|---|---|
| `agent_tasks` | `id`, `owner_id`, `project`, `repo`, `status`, `current_step`, `tool_calls`, `correction_attempts`, `created_at`, `updated_at`, `expires_at`, `last_error_code` | owner + recent updated; expire/archive terminal records |
| `agent_steps` | `id`, `task_id`, `sequence`, `tool_name`, `action`, `status`, `input_digest`, `result_summary`, `error_code`, `created_at` | unique(task_id, sequence), indexed task_id; no secrets/full prompts |
| `agent_patches` | `id`, `task_id`, `repo`, `base_ref`, `path`, `expected_sha`, `content_hash`, `diff_or_reference`, `status`, `created_at`, `expires_at` | task_id + status; bounded size/retention |

`owner_id` must be derived from trusted authentication, not supplied by the model. An API key shared by multiple people is not sufficient for per-person approvals; establish distinct authenticated principals or keep the initial release draft-only.

**Possible later operational addition:** vector ID manifest/reconciliation design for real stored IDs, avoiding old/new format reconstruction. Treat as separate maintenance migration with verification and rollback.

### Migration safety

1. Inventory live schema and row counts, D1 database name/id, live bindings, current migration state and quota baseline.
2. Backup production D1; verify restore route before writing schema.
3. Create additive tables/indexes with idempotent migration; avoid destructive alterations.
4. Execute against local/staging D1 first, run compatibility tests, then apply to production only after approval.
5. Confirm existing `documents`, `images`, `jobs`, and nine tools continue working. Do not re-embed all documents during migration.
6. Rollback: turn feature flag off; retain existing tools. Prefer forward corrective migration for already-applied D1 changes; restore only under an agreed recovery plan.

## 8. Transport and response contract

- Return the established structured envelope; include `status`, `data`, `meta`, and machine-readable `error` (`code`, `message`, `retriable`) on failure. Add `partial_success` for multi-stage writes; do not overload a text status.
- Tool outputs must be compact. Include `truncated`, `next_cursor`, `source`, revision/hash and clear operation identifiers.
- BDS historically has special-character/raw-argument corruption. Respect its existing transport-safe procedure; code proposals should rely on validated staged payload references and hashes when practical. A base64 payload's syntactic validity alone does not prove completeness—verify expected byte length and hash, then read back.
- Bound inbound request size, outbound result size, count of files, number of read operations, duration, and external API calls; return explicit limit errors.

Example proposed success payload (illustrative, not an existing server response):

```json
{
  "status": "ok",
  "data": {
    "task_id": "server-generated-id",
    "patch_id": "server-generated-id",
    "state": "awaiting_approval",
    "source": {"repository": "owner/repo", "path": "src/example.js", "expected_sha": "sha-from-read"},
    "diff_summary": "One targeted change",
    "tests": "not_run"
  },
  "meta": {"tool": "coding_patch", "truncated": false}
}
```

## 9. Security and approval model

- Existing MCP API key is server-side and never emitted in logs or results. Do not embed GitHub credentials in code, D1 documents, model prompts or tool arguments.
- A scoped GitHub token / installation must be limited to intended repos and least privilege. Phase 1 may be read-only.
- No arbitrary fetch URLs, arbitrary git remotes, SSRF, path traversal, unsafe redirects, or unrestricted command tools.
- User-facing review must display exact diff, target repo/branch/path and source revision. Approval must be independently captured in a trusted interface/endpoint and bound to a content hash, authenticated identity, expiry and one-time use.
- Treat tool responses, repository files and retrieved Brain docs as data rather than higher-priority instructions.
- `delete_document`/`rename_document` remain accessible as before to authorized existing clients, but are not on the autonomous coding-agent allowlist by default.

## 10. Cost and performance safeguards

**Cost objective:** do not add paid Cloudflare service dependencies. This is not an unconditional $0 invoice guarantee. Verify live plan, quotas, existing consumption and external provider billing before deployment. Free-tier limits and model eligibility can change: use official current pricing pages in release checklist.

- Reuse Workers Free, existing D1/Vectorize, Durable Object and eligible Workers AI binding; avoid provisioning new paid runtime.
- Better DeepSeek remains reasoning model; do not automatically route to a second Workers AI coding model.
- Existing embeddings and image generation already consume Workers AI allocation; do not spend Neurons on task logging, every intermediate step, or repeated unchanged context.
- Reject or pause when task quotas or free-resource safety thresholds are reached. Never automatically upgrade, buy credits, enable paid fallback or Unified Billing.
- Cache within correctness boundaries: exact known Brain path and repo SHA are good cache keys; invalidate when revision changes.
- Keep small result sizes and retention to minimize D1 reads/writes/storage and Better DeepSeek context cost.

## 11. User journeys

### UJ-01 Read and propose (v1.1 primary)

1. User asks BDS to fix a specific problem in an allowlisted repository.
2. BDS gets Brain context via `coding_context` (or direct existing known-path `get_document`).
3. BDS inspects authoritative source and SHA via `coding_workspace`.
4. BDS proposes a targeted change via `coding_patch`; server validates and stages; source is **not modified**.
5. BDS obtains `coding_status` and shows the actual diff, uncertainty, test state and next action.
6. User may reject, revise or approve for a separately implemented v1.2 application flow.

### UJ-02 Interruption and resume

1. A task completes inspection but the conversation stops.
2. User returns with task ID; `coding_status` shows last checkpoint and bounded next step.
3. Before further proposals, validate current repository revision to prevent stale work.

### UJ-03 Optional local fix/test (v1.2)

1. User explicitly activates local DeepCode/Harness.
2. A validated patch is applied in the trusted local working tree or approved branch.
3. Harness sends correlated actual test results; BDS may revise within bounded retry budget.
4. Completion is `tests_passed` only if that result was actually received; otherwise `not_run` or `failed`.

## 12. Acceptance tests and exit gates

| ID | Test | Expected result |
|---|---|---|
| AT-01 | Discover existing MCP tools with feature flag off/on | All nine existing names and schemas unchanged |
| AT-02 | Smoke test existing document CRUD/search and images | Existing expected responses unchanged; placeholder remains explicit |
| AT-03 | Inspect Worker logs with authentication | No keys, bearer tokens, cookies or sensitive payloads |
| AT-04 | Missing/wrong API key | Rejected; no data returned |
| AT-05 | Read project knowledge then source | Provenance differs clearly: Brain document vs GitHub revision |
| AT-06 | Invalid/non-allowlisted repository/path | Rejected before external request |
| AT-07 | Request several bounded files in one `coding_workspace` call | Correct content, SHA, truncation/pagination |
| AT-08 | Stage patch | Diff + patch ID returned; GitHub source untouched |
| AT-09 | Stale `expected_sha` / changed source | Conflict, no silent overwrite |
| AT-10 | Model writes `approved:true` | Does not authorize any repository write |
| AT-11 | Resume after interrupted conversation | `coding_status` returns correct checkpoint, owner scoped |
| AT-12 | Exceed loop/tool/budget limit | Explicit fail-closed state, no paid fallback |
| AT-13 | Error in index update | Machine-readable partial outcome and repair path |
| AT-14 | Shortened rewrite / legacy vector IDs | No stale search results after reconciliation, or tracked limitation and tested repair |
| AT-15 | Special characters and oversized payload | Exact-byte/hash verification or explicit rejection, never silent truncation |
| AT-16 | D1 migration and rollback drill | Existing content preserved, feature flag can disable extension |
| AT-17 | Optional Harness absent | Workflow still produces reviewable draft; tests marked `not_run` |

**v1.1 definition of done:** AT-01 through AT-13, AT-15–AT-17 pass; AT-14 requires either verified repair or a separately approved blocker/maintenance plan before enabling autonomous Brain document modifications. Live plan and usage audit completed. No production auto-write surface enabled.

## 13. Delivery plan, dependencies and open decisions

### P0 — Baseline and stabilization

- Freeze a reproducible current-branch/commit baseline; export live MCP manifest and D1 schema; inventory bindings/secrets without exposing values.
- Add compatibility/security regression tests; remove raw header logging; validate existing write/index behavior; back up database.
- Reconcile contradictory README and stored architecture references after verifying live settings. Do not edit Brain documents without the existing review policy.

### P1 — Agent-ready foundation (v1.1)

- Add feature-gated `coding_context`, `coding_workspace`, `coding_patch`, `coding_status` with compact schema descriptions.
- Add additive D1 task/step/patch migration; enforce ownership, size, expiry and limits.
- Add read-only GitHub API integration and allowlisted routing; stage draft patches, produce diffs and revision hashes.
- Add compact coding instruction/skill, respecting one MCP tool per response. Follow existing `Agents.md` R1–R5; propose R6 for approval before source modifications.
- Run acceptance tests and compare resource use against free allocations.

### P2 — Optional execution/application (v1.2)

- Add separately authenticated approval and apply channel, single-use approvals, branch/PR flow, trusted local Harness result ingestion, bounded repair loop.
- No production deployments automatically; require separate authorization and tests.

### Decisions to resolve at kickoff

1. Which exact project repositories are allowlisted initially? Start with `clarityvasupport/bds-brain-mcp` if authorized.
2. Is the GitHub integration read-only initially (recommended), and what trusted identity/approval interface will govern later writes?
3. What are actual production D1 schema/bindings and baseline daily quota consumption?
4. Where are large staged patches held within free-tier constraints, and what per-file/max-total sizes are acceptable?
5. What retention/expiry and concurrency policy should apply to agent tasks?
6. Is DeepCode/Harness installed/connected, or should tests remain an explicitly optional handoff?

## 14. Future-session onboarding / agent handoff (copy into a new coding session)

> We are refactoring `clarityvasupport/bds-brain-mcp` toward **BDS Brain MCP v1.1 — Agentic Coding Foundation**. Read `BDS_Brain_Agentic_Coding_PRD_v1.0.md` in full first. It is a proposal, not proof that new code is deployed. Preserve the nine current MCP tool contracts and working free-tier infrastructure. Better DeepSeek is the reasoning interface and calls one MCP tool per response. The four proposed capabilities are `coding_context`, `coding_workspace`, `coding_patch` (draft only) and `coding_status`. Initial goal: read authoritative GitHub source, stage a revision-checked diff and show a reviewable result; never auto-write, auto-deploy or provision paid Cloudflare services. Before editing, inspect current source, live manifest, Wrangler bindings, live `sqlite_master`, and the existing Brain `Agents/Agents.md` R1–R5. The README and stored R2 notes may be stale. Back up D1, remove sensitive-header logging, work on a branch, prepare additive migrations, test compatibility, and report precisely what changed and what remains unverified. Do not claim testing or deployment without actual evidence.

### First-session verification checklist

- [ ] Read PRD, current branch/commit, source and `schema.sql`/`schema-v2.sql`.
- [ ] Verify live nine-tool manifest and Better DeepSeek current prompt behavior.
- [ ] Identify correct account/environment and inventory bindings; protect secrets.
- [ ] Query live `sqlite_master` and backup D1 before migration.
- [ ] Read the actual `Agents/Agents.md`, feature requests/corrections, and relevant project README before writing Brain documents.
- [ ] Confirm existing resource quotas and paid-service exclusions.
- [ ] Produce small, reviewable PRs with tests; do not silently modify production.

## 15. References and provenance

**Primary user-provided context:** Better DeepSeek system-prompt export (`Pasted text(4).txt`), D1 stored-document export (`Pasted text(5).txt`), earlier repository source review and conversation decisions. The D1 export describes documents and historical observations, not an authoritative live SQL schema. The historical `FEATURE-REQUESTS.txt` contains older tool-count statements; use the later supplied nine-tool manifest.

**Public source of truth for code:** https://github.com/clarityvasupport/bds-brain-mcp ; public `schema.sql` and `schema-v2.sql` are present on main as checked 15 Oct 2026. Better DeepSeek source: https://github.com/EdgeTypE/better-deepseek .

**Pricing to recheck before deployment:** https://developers.cloudflare.com/workers/platform/pricing/ ; https://developers.cloudflare.com/workers-ai/platform/pricing/ ; https://developers.cloudflare.com/d1/platform/pricing/ ; https://developers.cloudflare.com/vectorize/platform/pricing/ . No hardcoded free allocation is a substitute for a deployment-day check.

---

**Change control:** PRD v1.0 establishes intended scope; record implemented changes, open decisions, tested results, and deployment evidence in a changelog. Update the PRD only after review, and keep proposed/implemented status explicit.
