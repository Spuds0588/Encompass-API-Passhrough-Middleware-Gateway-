# todo.md — Encompass API Passthrough Gateway MVP

Legend: `[x]` done and verified · `[ ]` open · `BLOCKED` needs AWS/Encompass access.

## Phase 1 — Core infrastructure & distribution

- [x] Single-file CloudFormation template (`infra/template.yaml` → generated `template.yaml`)
- [x] Lambda (Node 20, arm64) with inline handler code; no zip/S3 bucket required
- [x] API Gateway REST API, stage `prod`, API key requirement on `/{proxy+}`
- [x] Usage plan (50 rps, 100 burst, 100k/day) for runtime-created keys
- [x] Three DynamoDB tables (tenants, tokens, jobs), on-demand, SSE, TTL on tokens/jobs
- [x] SQS FIFO write queue (grouped by loan) + DLQ, `maxReceiveCount: 5`
- [x] Secrets Manager for the Encompass client secret
- [x] Scoped IAM role (no wildcard resources for data access)
- [x] `deploy.sh` one-line CloudShell installer with outputs and admin token generation
- [x] Generated template stays under CloudFormation's 51,200-byte direct-upload limit (40,669 bytes)

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
- [x] Admin token required (timing-safe), fail closed when unconfigured
- [x] API key returned once; plaintext never persisted
- [x] Curl example shown after provisioning

## Phase 6 — Testing & verification

- [x] Unit + integration tests with fake Encompass and in-memory AWS (Node `node:test`)
- [x] Production-shaped HTTP e2e: portal → key → read → enqueue → worker → job → retry
- [x] Template guards: resources, API key requirement, FIFO/DLQ, no secret defaults, size, in-sync
- [x] 32/32 tests passing locally (`npm test`)
- [x] GitHub Actions CI on push and PR (tests + template sync)
- [ ] BLOCKED: deploy stack to a real AWS account (no AWS CLI/credentials here)
- [ ] BLOCKED: live Encompass token exchange / loan read / loan write (no Encompass access)
- [ ] BLOCKED: API Gateway key provisioning against real AWS API Gateway

## Deferred (YAGNI, not in MVP)

- [ ] Loan mirror / sync engine — explicitly rejected in the dev doc
- [ ] Webhook receiver and debouncing — not specified in the extracted endpoints
- [ ] Tenant revocation/deletion endpoint and key rotation UI
- [ ] CORS support — vendors are expected to call server-to-server
- [ ] Per-tenant quota overrides (single shared usage plan for MVP)

## Next action

Run `deploy.sh` in AWS CloudShell with real Encompass credentials, then execute
the smoke sequence in `README.md` (§ Deploy) and replace the BLOCKED items above.
