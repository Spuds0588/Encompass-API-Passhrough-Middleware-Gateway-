# todo.md — Encompass API Passthrough Gateway MVP

Legend: `[x]` done and verified · `[ ]` open · `BLOCKED` needs AWS/Encompass access.

## Priority order (2026-11-06)

**Top priority: loan-file documents and conditions.** Listing, uploading,
downloading, reading, and responding to documents/conditions is the primary
broker use case and outranks every P1/P2 and deferred item below.

- [x] eFolder document listing
- [x] Pre-signed attachment upload initiation
- [x] Pre-signed attachment download URLs and byte downloads
- [x] Enhanced-condition read/respond
- [x] Full and chunked V3 loan registration, milestone submission, document creation, and enhanced/standard condition lifecycle
- [ ] BLOCKED: live-tenant verification of the lifecycle, document/upload/download, and condition contracts

## Broker lifecycle extension (2026-11-07)

- [x] Added `POST /v1/loans` for a full V3 `LoanContract`; requires `loanFolder`,
  defaults `view=id`, and accepts up to 1 MB.
- [x] Added `PATCH /v1/loans/{id}/application` for chunked V3 contract updates.
- [x] Added `GET /v1/loans/{id}/milestones` and
  `PATCH /v1/loans/{id}/milestones/{milestoneId}?action=finish|unfinish` for
  Submittal and Resubmittal.
- [x] Added `POST /v1/loans/{id}/documents` for eFolder document creation, then
  reused the pre-signed upload flow for bytes and the existing document list.
- [x] Added `POST /v1/loans/{id}/conditions`, plus enhanced-condition document
  list/associate routes for prior-to-docs, prior-to-funding, and post-closing
  evidence.
- [x] Added standard V1 condition routes for `underwriting`, `preliminary`, and
  `postclosing`: read, create, manage, and document association.
- [x] Extended the fake and tests for full/chunked writes, milestones, document
  creation, enhanced/standard condition creation and document association, and
  a real-HTTP broker lifecycle.
- [x] Local gate: `npm run verify` 89/89; template regenerated at 101,034 bytes
  (SHA-256 `9f0323b8f2f7d6a6bf94481ae97e538f6e094789f4f9d3ac2a0122ada4dabab5`).
- [ ] BLOCKED: verify the lifecycle routes against a live Encompass tenant and
  AWS stack. Only local fake contracts and CI are proven here.

## MVP completeness audit (2026-11-07)

**Status: MVP implementation complete.** Code, template, docs, and local
verification are closed; live AWS deployment and live Encompass contract checks
remain BLOCKED by missing credentials and are not claimed.

- [x] Recovered and read the full dev doc, then derived every MVP requirement
  from its PRD, API samples, architecture, reference handler, and verification
  sections instead of trusting the project's summaries.
- [x] Audited each requirement against `src/gateway.js`, `template.yaml`, the
  handler/e2e/template tests, `deploy.sh`, and CI.
- [x] Fixed loan reads to project nested Encompass `fields` payloads as well as
  flat responses, preserving `{ id, fields, _cached }`; added a regression test.
- [x] Enforced retrieve-only condition fields: `PATCH` now returns `400` for
  `status`, `statusDate`, or `statusOpen`; added a regression test.
- [x] Corrected the portal key copy to match idempotent recovery semantics.
- [x] MVP-audit local gate (superseded by the lifecycle extension):
  `npm run verify` 79/79, template in sync at 78,986 bytes
  (SHA-256 `4e62005bcf5b85468c8d1ce75c6416493b80b50b8f4caa953a72c7fba766384e`);
  `bash -n deploy.sh`, `git diff --check`, `cfn-lint`, and Checkov pass.
- [x] Recorded the audit outcome in `agents.md` and `history.md`; public docs,
  deploy pin, and release tag move with the final verified SHA.
- [ ] BLOCKED: real CloudFormation deployment, API Gateway usage-plan/key
  behavior, DynamoDB/SQS/KMS/SNS runtime behavior, and live Encompass contracts.

## Phase 1 — Core infrastructure & distribution

- [x] Single-file CloudFormation template (`infra/template.yaml` → generated `template.yaml`)
- [x] Lambda (Node 24, arm64) with inline handler code; no zip/S3 bucket required
- [x] API Gateway REST API, stage `prod`, API key requirement on `/{proxy+}`
- [x] Usage plan (50 rps, 100 burst, 100k/day) for runtime-created keys
- [x] Four DynamoDB tables (tenants, provisioning, tokens, jobs), on-demand, SSE, TTL on provisioning/tokens/jobs
- [x] SQS FIFO write queue (grouped by loan) + DLQ, `maxReceiveCount: 5`
- [x] Secrets Manager for the Encompass client secret
- [x] Scoped IAM role (no wildcard resources for data access)
- [x] `deploy.sh` one-line CloudShell installer with outputs (superseded: now generates three role invite codes instead of an admin token)
- [x] Generated template stays under CloudFormation's 51,200-byte direct-upload limit (50,376 bytes after 2026-11-06 field/writeability work)
- [x] Size-safe delivery after Phase 9: build enforces 1,000,000 bytes; `deploy.sh` creates/reuses an S3 bucket and passes `--s3-bucket` above 51,200 bytes (template now 101,034 bytes)

## Phase 2 — Token management & impersonation

- [x] OAuth token exchange (`urn:ietf:params:oauth:grant-type:token-exchange`, `subject_user_id`)
- [x] Per-container credentials cache
- [x] DynamoDB token cache keyed by Encompass user, 5-minute refresh skew, TTL
- [x] Expired/missing token re-exchange path tested

## Phase 3 — Synchronous read passthrough

- [x] `GET /v1/loans/{id}?fields=...` with tenant → persona resolution
- [x] Field projection, default field set, 100-field cap, field-ID validation
- [x] 30-second per-container read cache scoped by persona + loan + fields (`_cached`)
- [x] Upstream error mapping (404, 423 FILE_LOCKED, 429, auth failure, 5xx)
- [x] `Cache-Control: private, max-age=30`

## Phase 4 — Async write pipeline & job engine

- [x] `PATCH /v1/loans/{id}` validates `fields`, creates job, enqueues FIFO, returns `202`
- [x] `GET /v1/jobs/{id}` with tenant ownership check
- [x] SQS worker: complete, retry on 423/429/5xx, fail fast on 4xx, 5-attempt cap
- [x] Idempotent worker (skips completed jobs), partial batch failures, DLQ
- [x] Retry loop exercised end-to-end through the local queue

## Phase 5 — Self-serve admin portal

- [x] SSR portal at `GET /portal` (inline CSS/JS, no CDN, CSP + no framing)
- [x] `POST /portal` creates API key, attaches it to the usage plan, stores tenant mapping
- [x] ~~Admin token required (timing-safe), fail closed when unconfigured~~ (superseded 2026-11-06 by role-scoped invite codes)
- [x] API key returned once on first mint; plaintext never persisted; idempotent repeats recover the same key via `GetApiKey(includeValue=true)`
- [x] Curl example shown after provisioning

## Phase 5.5 — Role-scoped invite onboarding (2026-11-06)

- [x] Three `NoEcho` invite-code parameters: `TitleInviteCode`, `BrokerInviteCode`, `AppraisalInviteCode`
- [x] Three persona parameters with defaults: `api_title_template`, `api_broker_template`, `api_appraisal_template`
- [x] `GET /portal?role=...&code=...` shows a persona-locked form; plain `/portal` shows the landing page + cheat sheet
- [x] Vendor enters company name + developer email only; email persisted on the tenant record
- [x] `POST /portal` validates role + code, ignores any client-supplied persona, rejects role mismatch
- [x] Per-role invite links printed by `deploy.sh`; codes reuse stack parameters on update
- [x] Fail closed when a role's code or persona is unset
- [x] Tests: valid invite, landing page, invalid code, role mismatch, field validation, unconfigured role, CSP

## Phase 5.6 — Field schema discovery (2026-11-06)

- [x] `GET /v1/fields?ids=11,646,CX.TITLE.STATUS` with tenant auth
- [x] Correct native Encompass endpoints: `schemas/loan/standardFields` and `settings/loan/customFields` (dev doc's `/schemas/loan/fields` is not the schema route)
- [x] Split standard vs `CX.*` / `CUSTnnFV` custom fields and normalize to `{ id: { description, type, readOnly?, fieldLock? } }`
- [x] 100-ID cap, strict field-ID validation, 404 when nothing matches, 502 on upstream/schema failure
- [x] 5-minute per-container cache keyed by persona + field set; `Cache-Control: private, max-age=300`
- [x] Static 11-field cheat sheet in the portal with copy-all IDs
- [x] Fake Encompass schema endpoints + call counters
- [x] Tests: mixed lookup, cache hit, validation, tenant scoping, upstream failure, empty result

## Phase 6 — Testing & verification

- [x] Unit + integration tests with fake Encompass and in-memory AWS (Node `node:test`)
- [x] Production-shaped HTTP e2e: portal invite → key → fields → read → enqueue → worker → job → retry
- [x] Template guards: resources, API key requirement, FIFO/DLQ, no secret defaults, invite parameters, native schema paths, size, in-sync
- [x] 50/50 tests passing locally (`npm run verify`)
- [x] 77/77 tests passing locally after deploy hardening (`npm run verify`; template 78,534 bytes, S3-hosted delivery)
- [x] Field writeability/retention hardening verified at commit `83f0057` (CI run `42305287711` green on Node 20/24; Pages `built`; live index, docs, and template bytes verified)
- [x] GitHub Actions CI on push and PR (tests + template sync)
- [x] `cfn-lint` clean on the final template (exit 0); CI also runs pinned Checkov with a documented `.checkov.yaml` policy
- [x] CI green on Node 20 and Node 24 for the earlier MVP commit (`6a22a5e`)
- [x] Earlier production artifact verified against the GitHub contents API and raw URL
- [x] Push invite/field-schema commit and verify new CI run + raw artifact (commit `9d0d23e`, CI run `42298202063` green on Node 20/24; template 49,922 bytes, sha256 `70ce427d...`, raw `main` matches)
- [ ] BLOCKED: deploy stack to a real AWS account (no AWS CLI/credentials here)
- [ ] BLOCKED: live Encompass token exchange / loan read / loan write (no Encompass access)
- [ ] BLOCKED: API Gateway key provisioning against real AWS API Gateway
- [ ] BLOCKED: real standard/custom field schema response shape against an Encompass instance

## Phase 7 — Community support and discoverability (2026-11-06)

- [x] `CONTRIBUTING.md` with bug-report, sanitization, testing, and PR workflow
- [x] `llms.txt` for LLMs/coding agents, including upstreaming and live-verification rules
- [x] `index.html` with SEO metadata, JSON-LD FAQ/software schema, and contribution links
- [x] `robots.txt` and `sitemap.xml` for the GitHub Pages project page
- [x] Shared-responsibility language in `README.md` and `agents.md`
- [x] `test/static.test.js` guards for contribution links, metadata, schemas, and sitemap
- [x] Cross-surface community-contract and agent-principle guards in the static suite
- [x] Verify the GitHub Pages build and CI run for the community-support commit (commit `a64461f`, CI run `42299556782` green on Node 20/24; Pages build `1347436024` succeeded; live index and `llms.txt` byte-identical)

## Phase 8 — Security, audit, compliance, and usability backlog (2026-11-06)

Status: ranked backlog. Completed hardening is recorded below; remaining items
stay open. Do not mark one done without the change, tests, and a matching
`history.md` entry. These are ranked candidates, not permission to expand scope
speculatively.

### Ranked backlog (all unchecked)

- [x] **P0 — Correct the loan-data retention claim and bound queue retention.**
  Replace “No loan data is ever stored” with an accurate statement: no loan
  database or mirror; write payloads transit SQS. Shorten write-queue and DLQ
  retention, enable explicit SQS encryption, add a DLQ alarm/purge procedure, and
  document the full data inventory (tenant email, jobs, tokens, SQS, CloudWatch).
  Completed 2026-11-06: retention/claim fixes landed earlier; Phase 9 added
  `DeadLetterAlarm` + `OpsAlertTopic`/optional `OpsAlertEmail`, the purge runbook
  in README Operations, and the document/condition data paths.
- [x] **P0 — Make Encompass persona least privilege an explicit control and
  enforce tenant status.** Require field/loan-scoped service accounts, validate
  at least one restricted persona, and document that `fields` is projection, not
  authorization. Make `tenantFor` reject non-ACTIVE tenants; if Encompass cannot
  scope fields, add a per-role allowlist and include tenant/role in cache keys.
  Completed 2026-11-06: ACTIVE enforcement and persona documentation landed
  earlier; Phase 9 added optional per-role `*WriteFields` allowlists enforced
  before enqueue, failing closed when malformed.
- [x] **P1 — Protect portal key minting and define key/invite lifecycle.** Add a
  stage method throttle for `POST /portal`; document API Gateway key disable and
  invite rotation; add a `SECURITY.md` with private vulnerability reporting. Keep
  invites shared per role; do not make them single-use. Make provisioning
  idempotent and clean up orphan keys on partial failure.
  Completed 2026-11-07: `POST /portal` is throttled to 1 rps / burst 2; a new
  `ProvisioningTable` holds a conditional, hashed claim (15-minute pending lock,
  24-hour completion TTL, no plaintext keys). Repeats return the same API Gateway
  key via `GetApiKey(includeValue=true)`; disabled/missing keys return `409`.
  Partial tenant-mapping failures delete the key and release the claim, logging
  `API_KEY_ORPHANED` if deletion fails. Added `SECURITY.md` plus README, portal,
  agent, and LLM lifecycle guidance; invites remain shared per role. Template
  assertions and local tests cover throttle wiring and idempotency/rollback. Not
  deployed to AWS here, so live throttling, `GetApiKey`, and cleanup behavior
  remain unverified.
- [x] **P1 — Add end-to-end request-ID correlation.** Propagate the API Gateway
  request ID through every operation, log entry, response header, and job record.
  Add metadata-only access logs if the template budget permits; add Lambda error,
  API 5xx, and DLQ alarms. Never enable full request/response body logging.
  Completed 2026-11-06: every HTTP response returns `x-request-id`; write jobs
  store it, SQS messages carry it, `GET /v1/jobs/{id}` returns it, and every
  Lambda log line, including worker retries, inherits it through
  AsyncLocalStorage. Added a metadata-only API Gateway access-log format,
  `GatewayErrorsAlarm`, and `Api5xxAlarm` on the existing SNS topic. Not deployed
  to AWS here; local tests prove the HTTP/job/queue/log propagation only.
- [x] **P1 — Harden `deploy.sh` against supply-chain and secret exposure.** Pin a
  release tag or commit and verify SHA-256; use TLS-constrained curl; avoid
  passing the client secret through CLI process arguments where a pre-created
  secret ARN is practical. Add `cfn-lint` and an IaC security scan to CI.
  Completed 2026-11-07: `deploy.sh` pins the template to the `v0.2.0` release tag
  with SHA-256
  `9f0323b8f2f7d6a6bf94481ae97e538f6e094789f4f9d3ac2a0122ada4dabab5`,
  uses `curl --proto '=https' --tlsv1.2`, and aborts on a digest mismatch; the
  digest is the integrity anchor, so a moved tag fails closed. The client secret
  and invite codes are passed through a `0600` temporary JSON parameter file
  (`file://`), not CLI arguments; an EXIT trap removes it. Added a dedicated CI
  `iac` job with pinned `cfn-lint` 1.60.0 and Checkov 3.4.3, plus `.checkov.yaml`
  documenting intentional architecture exceptions. Fixed the real low-cost
  findings in the template: DynamoDB PITR on all four tables, SNS topic
  encryption, and a redundant API stage dependency. Local `cfn-lint` and Checkov
  both exit 0 (template 78,534 bytes). Local tests assert the pin/hash, TLS
  flags, secret-file path, shell syntax, PITR/SNS wiring, scanner policy, and CI
  wiring. Live AWS deployment remains unverified.
- [ ] **P2 — Add input and capacity limits.** Cap request body, field-value,
  and loan-ID sizes; validate `Content-Type`; add `413`/`415` responses and
  `Retry-After` guidance. Document that usage-plan limits are not per-tenant
  aggregates, and consider reserved concurrency or a conservative stage throttle.
- [ ] **P2 — Add compliance and operations documentation.** Document data
  inventory/retention, deletion and tenant offboarding, key/invite compromise,
  incident response, access review, and the deployment's shared-responsibility
  boundary. This supports lender GLBA/SOC 2 programs; it does not certify them.
- [ ] **P2 — Add optional usability surfaces.** Add a static OpenAPI spec for
  vendor integration. Add a custom domain/HSTS only if a lender requires it;
  these are not MVP requirements.

### Template distribution decision (decided 2026-11-06)

- [x] **Decided: keep one self-contained template and host it through S3 when
  needed.** `template.yaml` is now **101,034 bytes**, over the 51,200-byte direct
  limit. `deploy.sh` auto-creates/reuses an artifact bucket and passes
  `--s3-bucket` (S3-hosted limit 1 MB); the build enforces 1,000,000 bytes and
  names the delivery mode. Direct console upload is no longer supported for this
  template; use the installer or an S3 URL. No separate hardening stack was
  added.

### Implemented hardening (2026-11-06)

- [x] Public docs now state no loan database or mirror; write payloads transit
  SQS and read projections stay in Lambda memory for up to 30 seconds.
- [x] Write queue retention shortened to 1 day, DLQ to 4 days, with SSE-SQS.
- [x] Tenant reads, writes, schema, and job routes reject missing/non-`ACTIVE`
  tenant status.
- [x] Data inventory and queue retention documented in `README.md`.
- [x] `/v1/fields` exposes `readOnly` and `fieldLock` when Encompass supplies
  them; writeability remains persona-scoped, not an API allowlist.
- [x] DLQ alarm/purge procedure and per-role field allowlist completed in Phase 9
  (2026-11-06).

## Phase 9 — Broker origination readiness (top priority, 2026-11-06)

- [x] Expose `readOnly`/`fieldLock` field metadata through `/v1/fields`.
- [x] Verify official eFolder document and enhanced-condition surfaces; the
  earlier "not supported" documentation is superseded by the routes below.
- [x] Add eFolder document list support via native V3 `/loans/{loanId}/documents`,
  with `requireActiveAttachments`, `includeRemoved`, `view`, `start`, and `limit`
  passed through.
- [x] Add attachment upload initiation via native V3
  `/loans/{loanId}/attachmentUploadUrl`, returning Encompass's
  `CreateAttachmentResponse` unchanged so the client can PUT bytes directly to
  the pre-signed URL. Tenant/persona scoping and the 10 KB JSON-body cap apply.
- [x] Add attachment download URLs via native V3
  `/loans/{loanId}/attachmentDownloadUrl` with the official
  `{ attachments: [id] }` body (1–20 ids), returning the download array inside
  `{ loanId, downloads }`; the client then GETs each URL with its
  `authorizationHeader`. The gateway never proxies file bytes.
- [x] Add enhanced-condition read/respond via `/loans/{loanId}/conditions`
  (`PATCH ?action=update`), with the update array validated and a subsequent read
  proving the status change in contract tests.
- [x] Add fake Encompass state and contract tests for documents, upload
  initiation plus real pre-signed PUT/GET round trips, attachment download, and
  condition read/respond (68/68 pass at that milestone).
- [x] Add structured application writes: V3 loan create and chunked application
  update routes now cover full applications; the legacy field `PATCH` remains
  capped at 100 fields and non-transactional.
- [ ] BLOCKED: verify these V3 document/upload/condition routes against a live
  Encompass tenant. Only the local fake contract is proven here.

## Deferred (YAGNI, not in MVP)

- [ ] Loan mirror / sync engine — explicitly rejected in the dev doc
- [ ] Webhook receiver and debouncing — not specified in the extracted endpoints
- [ ] Tenant revocation/deletion endpoint and key rotation UI
- [ ] Invite-code rotation UI or single-use vendor invites (stack parameter update only)
- [ ] CORS support — vendors are expected to call server-to-server
- [ ] Per-tenant quota overrides (single shared usage plan for MVP)

### Explicitly not recommended

Do not re-propose these without a new user or lender requirement recorded in
`todo.md` first.

- [ ] Single-use vendor invites or an invite-rotation UI — keep shared per-role
  links; rotate by updating stack parameters.
- [ ] Admin dashboard or tenant CRUD UI — adds authentication and state; use the
  documented AWS CLI runbook instead.
- [ ] Loan mirror, sync engine, write webhooks, or debouncing — violates the
  passthrough/stateless scope.
- [ ] CORS — vendors are server-to-server; keep the browser surface closed.
- [ ] Separate audit database, SIEM, or external log pipeline — CloudWatch plus
  job metadata is sufficient for the MVP.
- [ ] API Gateway full request/response logging — risks keys, invite codes, and
  loan data; access logs must be metadata-only.
- [ ] mTLS, custom domain/HSTS, or per-tenant usage plans without a lender
  requirement — cost and operational complexity are not justified speculatively.
- [ ] WAF managed rule sets without a concrete abuse pattern — use targeted
  method throttling and rate limiting first.

## Maintenance

- [x] Removed the obsolete exported AI Studio dev-doc chat; current scope is defined by
  `README.md`, `todo.md`, and `llms.txt` (2026-11-06).

## Next action

Run `deploy.sh` in AWS CloudShell with real Encompass credentials, open one printed
role invite link, provision a key, then execute the smoke sequence in `README.md`
(§ Deploy), including full/chunked registration, milestone submission, document
create/upload/download, and enhanced/standard condition association and
fulfillment. Replace the BLOCKED items above with sanitized results.
