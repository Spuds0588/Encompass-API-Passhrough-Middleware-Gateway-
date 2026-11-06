# Encompass API Passthrough Gateway

Stateless AWS middleware that gives third-party vendors a small, stable API in
front of ICE Encompass. No loan data is ever stored.

- **Field-filtered reads** — `GET /v1/loans/{id}?fields=11,12,1109` returns only
  what the vendor asked for, with a 30-second per-container projection cache.
- **Async writes** — `PATCH /v1/loans/{id}` validates and enqueues to SQS FIFO
  (grouped by loan), returns `202` + job ID, and retries Encompass file locks.
- **Persona impersonation** — vendors get a scoped API key mapped to an Encompass
  user; OAuth token exchange results are cached per persona in DynamoDB.
- **Zero-dependency portal** — one Lambda renders a small SSR page that creates
  API keys, attaches them to a usage plan, and stores the tenant mapping.
- **One-file deployment** — the whole stack lives in a single CloudFormation
  template under the 51,200-byte direct-upload limit; no S3 bucket or Lambda zip.

## Architecture

```text
Vendor ──x-api-key──► API Gateway (usage plan)
                         ├── GET  /portal          → SSR key portal (admin token)
                         ├── POST /portal          → create API key + tenant mapping
                         ├── GET  /health          → unauthenticated health
                         ├── GET  /v1/loans/{id}    → read proxy (field projection, 30s cache)
                         ├── PATCH /v1/loans/{id}   → SQS FIFO enqueue → 202 + job
                         └── GET  /v1/jobs/{id}     → job status
                                                       │
                              SQS FIFO (group = loan) ─┘─► Lambda worker ──► Encompass
                                                             (5 attempts, then DLQ)

Storage: DynamoDB tenants + persona tokens + jobs (TTL) · Secrets Manager (client secret)
```

## API

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| `GET` | `/health` | none | `{ "status": "ok" }` |
| `GET` | `/portal` | none (page only) | HTML key portal |
| `POST` | `/portal` | `x-admin-token` | `{ message, apiKey, tenantName, encompassUserId }` |
| `GET` | `/v1/loans/{id}?fields=11,12,1109` | `x-api-key` | `{ id, fields: { ... }, _cached }` |
| `PATCH` | `/v1/loans/{id}` body `{ "fields": { "1109": 450000 } }` | `x-api-key` | `202 { status: "ACCEPTED", jobId, loanId, statusUrl }` |
| `GET` | `/v1/jobs/{id}` | `x-api-key` | `{ jobId, loanId, status, attempts, createdAt, updatedAt, error }` |

Job statuses: `PENDING` → `RETRYING` → `COMPLETED` / `FAILED`.
Default read field set: `11,12,14,1109` (max 100 fields per request).

Example:

```bash
curl -s "$GATEWAY_URL/v1/loans/LOAN_GUID?fields=11,12,1109" -H "x-api-key: $KEY"
curl -s -X PATCH "$GATEWAY_URL/v1/loans/LOAN_GUID" \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"fields":{"1109":525000}}'
```

## Deploy (AWS CloudShell, ~3 minutes)

```bash
bash <(curl -sSL https://raw.githubusercontent.com/Spuds0588/Encompass-API-Passhrough-Middleware-Gateway-/main/deploy.sh)
```

The script verifies your AWS session, asks for the Encompass instance ID, client
ID, and client secret, generates an admin token, fetches the committed template,
and deploys `Encompass-API-Gateway` with `CAPABILITY_IAM`.

It prints:

- `GatewayUrl` — base URL for vendor calls
- `AdminPortalUrl` — open this, enter the admin token, provision a vendor key
- `HealthUrl`
- the generated admin token (save it; it is not recoverable from the stack)

Environment overrides: `STACK_NAME`, `AWS_REGION`, `ENCOMPASS_INSTANCE`,
`ENCOMPASS_CLIENT_ID`, `ENCOMPASS_CLIENT_SECRET`, `ADMIN_TOKEN`, `TEMPLATE_URL`.

Prefer the console? Upload `template.yaml` directly in CloudFormation
("Upload a template file") and fill in the same parameters. It is under the
51,200-byte direct-upload limit.

### Smoke test after deploy

```bash
curl -s "$HEALTH_URL"
curl -s -X POST "$PORTAL_URL" -H "x-admin-token: $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"tenantName":"Acme Title","encompassUserId":"api_title_vendor"}'
# use the returned apiKey:
curl -s "$GATEWAY_URL/v1/loans/LOAN_GUID?fields=11,12,1109" -H "x-api-key: $KEY"
curl -s -X PATCH "$GATEWAY_URL/v1/loans/LOAN_GUID" -H "x-api-key: $KEY" \
  -H "content-type: application/json" -d '{"fields":{"1109":525000}}'
curl -s "$GATEWAY_URL/v1/jobs/$JOB_ID" -H "x-api-key: $KEY"
```

## Local development

No dependencies to install. The local server runs the real handler against a fake
Encompass and in-memory AWS (DynamoDB/SQS/Secrets/API Gateway behaviour).

```bash
npm run dev
# Gateway:     http://127.0.0.1:3000
# Portal:      http://127.0.0.1:3000/portal
# Admin token: local-admin-token-change-me-1234
```

The fake Encompass accepts `test-client` / `test-secret`, serves `loan-1` and
`loan-locked` (which returns 423 twice to exercise retries), and the dev server
exposes `POST /dev/drain` to run the SQS worker immediately.

## Tests

```bash
npm test          # 32 tests: handler unit/integration, HTTP e2e, template guards (CI: Node 20 + 24)
npm run verify    # template in sync + npm test
npm run build     # regenerate template.yaml after editing src/ or infra/
```

Coverage highlights: token exchange and cache reuse/expiry, tenant isolation,
field projection and validation, read cache hits, 202 enqueue, job ownership,
worker success, 423 retry-then-success, permanent 4xx failure, attempt exhaustion,
portal auth (missing/wrong/unconfigured), CSP on the portal, and template guards
(API key requirement, FIFO + DLQ, no secret defaults, size, embedded handler).

## Repository layout

```text
src/gateway.js        deployed Lambda (self-contained CommonJS)
infra/template.yaml   CloudFormation source with code placeholder
template.yaml         generated deployable template (committed)
scripts/build.js      inline + size guard + --check
deploy.sh             one-line CloudShell installer
dev/                  fake Encompass, in-memory store, local API Gateway emulator
test/                 node:test suites
agents.md             operating manual (YAGNI, cleanup, conventions)
todo.md               phase tracker and blocked production items
history.md            append-only work log
```

## Security notes

- `POST /portal` fails closed without `ADMIN_TOKEN`; comparisons are timing-safe.
- API keys are created in API Gateway, attached to the usage plan, returned once,
  and never stored in plaintext. Only `apiKeyId` is persisted.
- Every vendor route resolves the tenant from `requestContext.identity.apiKeyId`;
  job reads additionally verify ownership.
- Gateway IAM is scoped to the three tables, two queues, one secret, and the
  API Gateway key-provisioning actions.
- The Encompass client secret is stored in Secrets Manager and cached only in
  Lambda memory. Tokens, secrets, and keys never appear in logs.
- Read responses are `private, max-age=30` and the portal sends a strict CSP plus
  `frame-ancestors 'none'`.

## Known limitations

- **Not deployed to AWS from this repository's development environment** (no AWS
  credentials or Encompass access). Production verification so far is CI plus the
  raw-template fetch used by `deploy.sh`; see `history.md`.
- No webhook receiver, tenant revocation endpoint, key rotation UI, or CORS.
  Vendors are expected to integrate server-to-server.
- One shared usage plan/quota for all tenants (per-tenant quotas are deferred).
- The `EncompassBaseUrl` default is `https://api.elliemae.com`; override it for
  sandbox or instance-specific hosts.
- `deploy.sh` pulls `template.yaml` from the `main` raw URL;
  raw.githubusercontent.com may serve a cached copy for a few minutes after a push.
