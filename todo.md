# todo.md — Encompass API Passthrough Gateway MVP

Legend: `[x]` done and verified · `[ ]` open · `BLOCKED` needs AWS/Encompass access.

## Phase 1 — Core infrastructure & distribution

- [x] Single-file CloudFormation template (`infra/template.yaml` → generated `template.yaml`)
- [x] Lambda (Node 24, arm64) with inline handler code; no zip/S3 bucket required
- [x] API Gateway REST API, stage `prod`, API key requirement on `/{proxy+}`
- [x] Usage plan (50 rps, 100 burst, 100k/day) for runtime-created keys
- [x] Three DynamoDB tables (tenants, tokens, jobs), on-demand, SSE, TTL on tokens/jobs
- [x] SQS FIFO write queue (grouped by loan) + DLQ, `maxReceiveCount: 5`
- [x] Secrets Manager for the Encompass client secret
- [x] Scoped IAM role (no wildcard resources for data access)
- [x] `deploy.sh` one-line CloudShell installer with outputs (superseded: now generates three role invite codes instead of an admin token)
- [x] Generated template stays under CloudFormation's 51,200-byte direct-upload limit (50,376 bytes after 2026-11-06 field/writeability work)

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
- [x] API key returned once; plaintext never persisted
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
- [x] Field writeability/retention hardening verified at commit `83f0057` (CI run `42305287711` green on Node 20/24; Pages `built`; live index, docs, and template bytes verified)
- [x] GitHub Actions CI on push and PR (tests + template sync)
- [x] `cfn-lint` clean on the final template (exit 0)
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

- [ ] **P0 — Correct the loan-data retention claim and bound queue retention.**
  Replace “No loan data is ever stored” with an accurate statement: no loan
  database or mirror; write payloads transit SQS. Shorten write-queue and DLQ
  retention, enable explicit SQS encryption, add a DLQ alarm/purge procedure, and
  document the full data inventory (tenant email, jobs, tokens, SQS, CloudWatch).
- [ ] **P0 — Make Encompass persona least privilege an explicit control and
  enforce tenant status.** Require field/loan-scoped service accounts, validate
  at least one restricted persona, and document that `fields` is projection, not
  authorization. Make `tenantFor` reject non-ACTIVE tenants; if Encompass cannot
  scope fields, add a per-role allowlist and include tenant/role in cache keys.
- [ ] **P1 — Protect portal key minting and define key/invite lifecycle.** Add a
  stage method throttle for `POST /portal`; document API Gateway key disable and
  invite rotation; add a `SECURITY.md` with private vulnerability reporting. Keep
  invites shared per role; do not make them single-use. Make provisioning
  idempotent and clean up orphan keys on partial failure.
- [ ] **P1 — Add end-to-end request-ID correlation.** Propagate the API Gateway
  request ID through every operation, log entry, response header, and job record.
  Add metadata-only access logs if the template budget permits; add Lambda error,
  API 5xx, and DLQ alarms. Never enable full request/response body logging.
- [ ] **P1 — Harden `deploy.sh` against supply-chain and secret exposure.** Pin a
  release tag or commit and verify SHA-256; use TLS-constrained curl; avoid
  passing the client secret through CLI process arguments where a pre-created
  secret ARN is practical. Add `cfn-lint` and an IaC security scan to CI.
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

### Template distribution decision (unchecked)

- [ ] **Decide before adding large controls.** `template.yaml` uses **50,376 of
  51,200 bytes**, leaving **824 bytes**. Small code/template changes can fit,
  but WAF, API Gateway access logging, and a full alarm set may require an
  S3-hosted template or a separate hardening stack. Make that a deliberate
  product/distribution decision, not an accidental limit breach.

### Implemented hardening (2026-11-06)

- [x] Public docs now state no loan database or mirror; write payloads transit
  SQS and read projections stay in Lambda memory for up to 30 seconds.
- [x] Write queue retention shortened to 1 day, DLQ to 4 days, with SSE-SQS.
- [x] Tenant reads, writes, schema, and job routes reject missing/non-`ACTIVE`
  tenant status.
- [x] Data inventory and queue retention documented in `README.md`.
- [x] `/v1/fields` exposes `readOnly` and `fieldLock` when Encompass supplies
  them; writeability remains persona-scoped, not an API allowlist.
- [ ] DLQ alarm/purge procedure and per-role field allowlist remain open in the
  P0 items above.

## Phase 9 — Broker origination readiness (2026-11-06)

- [x] Expose `readOnly`/`fieldLock` field metadata through `/v1/fields`.
- [x] Verify official eFolder document and enhanced-condition surfaces; document
  that documents, conditions, and structured 1003 submission are not supported.
- [ ] Add eFolder document list/upload/attach support using the native
  `/documents` and `/attachmentUploadUrl` pre-signed URL flow, including binary
  handling and tenant/role scoping.
- [ ] Add enhanced-condition read/respond support for
  `/loans/{loanId}/conditions`, with async jobs and the same retry policy.
- [ ] Add a structured 1003/application write surface or a validated broker field
  pack. Current field `PATCH` is capped at 100 fields and is non-transactional.

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
(§ Deploy) and replace the BLOCKED items above.
