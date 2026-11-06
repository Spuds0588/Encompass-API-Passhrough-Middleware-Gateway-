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
- [x] Generated template stays under CloudFormation's 51,200-byte direct-upload limit (49,922 bytes after 2026-11-06 field/invite work)

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
- [x] Split standard vs `CX.*` / `CUSTnnFV` custom fields and normalize to `{ id: { description, type } }`
- [x] 100-ID cap, strict field-ID validation, 404 when nothing matches, 502 on upstream/schema failure
- [x] 5-minute per-container cache keyed by persona + field set; `Cache-Control: private, max-age=300`
- [x] Static 11-field cheat sheet in the portal with copy-all IDs
- [x] Fake Encompass schema endpoints + call counters
- [x] Tests: mixed lookup, cache hit, validation, tenant scoping, upstream failure, empty result

## Phase 6 — Testing & verification

- [x] Unit + integration tests with fake Encompass and in-memory AWS (Node `node:test`)
- [x] Production-shaped HTTP e2e: portal invite → key → fields → read → enqueue → worker → job → retry
- [x] Template guards: resources, API key requirement, FIFO/DLQ, no secret defaults, invite parameters, native schema paths, size, in-sync
- [x] 41/41 tests passing locally (`npm run verify`)
- [x] GitHub Actions CI on push and PR (tests + template sync)
- [x] `cfn-lint` clean on the final template (exit 0)
- [x] CI green on Node 20 and Node 24 for the earlier MVP commit (`6a22a5e`)
- [x] Earlier production artifact verified against the GitHub contents API and raw URL
- [x] Push invite/field-schema commit and verify new CI run + raw artifact (commit `9d0d23e`, CI run `42298202063` green on Node 20/24; template 49,922 bytes, sha256 `70ce427d...`, raw `main` matches)
- [ ] BLOCKED: deploy stack to a real AWS account (no AWS CLI/credentials here)
- [ ] BLOCKED: live Encompass token exchange / loan read / loan write (no Encompass access)
- [ ] BLOCKED: API Gateway key provisioning against real AWS API Gateway
- [ ] BLOCKED: real standard/custom field schema response shape against an Encompass instance

## Deferred (YAGNI, not in MVP)

- [ ] Loan mirror / sync engine — explicitly rejected in the dev doc
- [ ] Webhook receiver and debouncing — not specified in the extracted endpoints
- [ ] Tenant revocation/deletion endpoint and key rotation UI
- [ ] Invite-code rotation UI or single-use vendor invites (stack parameter update only)
- [ ] CORS support — vendors are expected to call server-to-server
- [ ] Per-tenant quota overrides (single shared usage plan for MVP)

## Next action

Run `deploy.sh` in AWS CloudShell with real Encompass credentials, open one printed
role invite link, provision a key, then execute the smoke sequence in `README.md`
(§ Deploy) and replace the BLOCKED items above.
