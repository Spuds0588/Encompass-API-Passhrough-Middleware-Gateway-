# Encompass API Passthrough Gateway

Stateless AWS middleware that gives third-party vendors a small, stable API in
front of ICE Encompass. No loan data is ever stored.

- **Field-filtered reads** — `GET /v1/loans/{id}?fields=11,12,1109` returns only
  what the vendor asked for, with a 30-second per-container projection cache.
- **Async writes** — `PATCH /v1/loans/{id}` validates and enqueues to SQS FIFO
  (grouped by loan), returns `202` + job ID, and retries Encompass file locks.
- **Persona impersonation** — vendors get a scoped API key mapped to an Encompass
  service account; OAuth token exchange results are cached per persona.
- **Role-scoped self-serve onboarding** — the lender shares a title, broker, or
  appraisal invite link. The vendor enters a company name and developer email;
  the gateway locks the key to that role's Encompass persona server-side. No
  admin token and no Encompass admin in the onboarding loop.
- **Field discovery** — the portal publishes a common-field cheat sheet, and
  `GET /v1/fields?ids=11,646,CX.TITLE.STATUS` returns live definitions from
  Encompass's native standard and custom field schema APIs.
- **Zero-dependency portal** — one Lambda renders the invite page, provisions
  keys, attaches them to the usage plan, and stores the tenant mapping.
- **One-file deployment** — the whole stack lives in a single CloudFormation
  template under the 51,200-byte direct-upload limit; no S3 bucket or Lambda zip.

## Architecture

```text
Vendor ──invite link──► GET  /portal?role=title&code=... → persona-locked form
Vendor ──x-api-key────► API Gateway (usage plan)
                         ├── POST /portal          → invite code → API key + tenant
                         ├── GET  /health          → unauthenticated health
                         ├── GET  /v1/fields       → Encompass field schema lookup
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
| `GET` | `/portal` | none (page only) | HTML invite landing page + field cheat sheet |
| `GET` | `/portal?role=title&code=...` | invite code | HTML form locked to the role's persona |
| `POST` | `/portal` | `{ role, code }` in body | `{ message, apiKey, tenantName, email, role, encompassUserId }` |
| `GET` | `/v1/fields?ids=11,646,CX.TITLE.STATUS` | `x-api-key` | `{ "11": { description, type }, ... }` |
| `GET` | `/v1/loans/{id}?fields=11,12,1109` | `x-api-key` | `{ id, fields: { ... }, _cached }` |
| `PATCH` | `/v1/loans/{id}` body `{ "fields": { "1109": 450000 } }` | `x-api-key` | `202 { status: "ACCEPTED", jobId, loanId, statusUrl }` |
| `GET` | `/v1/jobs/{id}` | `x-api-key` | `{ jobId, loanId, status, attempts, createdAt, updatedAt, error }` |

Job statuses: `PENDING` → `RETRYING` → `COMPLETED` / `FAILED`.
Default read field set: `11,12,14,1109` (max 100 fields per request).
Field lookups accept standard IDs, `CX.*` custom fields, and `CUSTnnFV` custom
fields (max 100 per request), and cache results per persona for 5 minutes.

Example:

```bash
curl -s "$GATEWAY_URL/v1/fields?ids=11,646,CX.TITLE.STATUS" -H "x-api-key: $KEY"
curl -s "$GATEWAY_URL/v1/loans/LOAN_GUID?fields=11,12,1109" -H "x-api-key: $KEY"
curl -s -X PATCH "$GATEWAY_URL/v1/loans/LOAN_GUID" \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"fields":{"1109":525000}}'
```

### Roles and personas

| Role | Persona parameter | Default service account | Invite parameter |
| --- | --- | --- | --- |
| `title` | `TitleServiceUserId` | `api_title_template` | `TitleInviteCode` |
| `broker` | `BrokerServiceUserId` | `api_broker_template` | `BrokerInviteCode` |
| `appraisal` | `AppraisalServiceUserId` | `api_appraisal_template` | `AppraisalInviteCode` |

The persona comes from the role parameter, never from the request body, so a
vendor holding one invite link cannot mint a key for another role.

## Deploy (AWS CloudShell, ~3 minutes)

```bash
bash <(curl -sSL https://raw.githubusercontent.com/Spuds0588/Encompass-API-Passhrough-Middleware-Gateway-/main/deploy.sh)
```

The script verifies your AWS session, asks for the Encompass instance ID, client
ID, and client secret, generates three role invite codes, fetches the committed
template, and deploys `Encompass-API-Gateway` with `CAPABILITY_IAM`.

It prints:

- `GatewayUrl` — base URL for vendor calls
- `AdminPortalUrl` — the invite portal (the output keeps its original name)
- `HealthUrl`
- `FieldsUrl`
- three ready-to-share role links, for example
  `...?role=title&code=...`, plus the persona each role uses

The invite codes are bearer secrets. The script prints each one once; save them
and pass the same values back through the environment on stack updates so
existing links keep working.

Environment overrides: `STACK_NAME`, `AWS_REGION`, `ENCOMPASS_INSTANCE`,
`ENCOMPASS_CLIENT_ID`, `ENCOMPASS_CLIENT_SECRET`, `TITLE_INVITE_CODE`,
`BROKER_INVITE_CODE`, `APPRAISAL_INVITE_CODE`, `TITLE_PERSONA`,
`BROKER_PERSONA`, `APPRAISAL_PERSONA`, `TEMPLATE_URL`.

Prefer the console? Upload `template.yaml` directly in CloudFormation
("Upload a template file") and fill in the same parameters. It is under the
51,200-byte direct-upload limit.

### Smoke test after deploy

```bash
curl -s "$HEALTH_URL"
curl -s "$PORTAL_URL?role=title&code=$TITLE_INVITE_CODE"
curl -s -X POST "$PORTAL_URL" -H "content-type: application/json" \
  -d "{\"role\":\"title\",\"code\":\"$TITLE_INVITE_CODE\",\"tenantName\":\"Acme Title\",\"email\":\"dev@acme.test\"}"
# use the returned apiKey:
curl -s "$GATEWAY_URL/v1/fields?ids=11,646,CX.TITLE.STATUS" -H "x-api-key: $KEY"
curl -s "$GATEWAY_URL/v1/loans/LOAN_GUID?fields=11,12,1109" -H "x-api-key: $KEY"
curl -s -X PATCH "$GATEWAY_URL/v1/loans/LOAN_GUID" -H "x-api-key: $KEY" \
  -H "content-type: application/json" -d '{"fields":{"1109":525000}}'
curl -s "$GATEWAY_URL/v1/jobs/$JOB_ID" -H "x-api-key: $KEY"
```

## Local development

No dependencies to install. The local server runs the real handler against a fake
Encompass and in-memory AWS (DynamoDB/SQS/Secrets/API Gateway behaviour). The fake
also serves the standard and custom field schema endpoints.

```bash
npm run dev
# Gateway:   http://127.0.0.1:3000
# Portal:    http://127.0.0.1:3000/portal
# Title:     http://127.0.0.1:3000/portal?role=title&code=local-title-invite-0123456789
# Broker:    http://127.0.0.1:3000/portal?role=broker&code=local-broker-invite-0123456789
# Appraisal: http://127.0.0.1:3000/portal?role=appraisal&code=local-appraisal-invite-0123456789
```

The fake Encompass accepts `test-client` / `test-secret`, serves `loan-1` and
`loan-locked` (which returns 423 twice to exercise retries), and the dev server
exposes `POST /dev/drain` to run the SQS worker immediately.

## Tests

```bash
npm test          # 41 tests: handler unit/integration, HTTP e2e, template guards (CI: Node 20 + 24)
npm run verify    # template in sync + npm test
npm run build     # regenerate template.yaml after editing src/ or infra/
```

Coverage highlights: token exchange and cache reuse/expiry, tenant isolation,
field projection and validation, read cache hits, 202 enqueue, job ownership,
worker success, 423 retry-then-success, permanent 4xx failure, attempt exhaustion,
invite validation and role mismatch, persona locking, field schema lookup and
caching, CSP on the portal, and template guards (API key requirement, FIFO + DLQ,
no secret defaults, invite parameters, native schema paths, size, embedded code).

## Repository layout

```text
src/gateway.js        deployed Lambda (self-contained CommonJS)
infra/template.yaml   CloudFormation source with code placeholder
template.yaml         generated deployable template (committed)
scripts/build.js      inline + compact deploy copy + size guard + --check
deploy.sh             one-line CloudShell installer
dev/                  fake Encompass (loans + schema), in-memory store, local emulator
test/                 node:test suites
agents.md             operating manual (YAGNI, cleanup, conventions)
todo.md               phase tracker and blocked production items
history.md            append-only work log
```

## Security notes

- Provisioning fails closed unless the role's invite code is configured and
  matches; comparisons are timing-safe. Unknown or unset roles are rejected.
- The Encompass persona is selected from the server-side role table; a
  client-supplied `encompassUserId` is ignored.
- Invite links are bearer secrets. They appear in the URL query string by design,
  so treat browser history, shared links, and any access logs as sensitive.
  Rotate by updating the stack parameter; there is no self-service rotation UI.
- API keys are created in API Gateway, attached to the usage plan, returned once,
  and never stored in plaintext. Only `apiKeyId` is persisted.
- Every vendor route resolves the tenant from `requestContext.identity.apiKeyId`;
  job reads additionally verify ownership.
- Field schema calls use the tenant's persona token and return definitions only,
  never loan data. Results are cached per persona and field set for 5 minutes.
- Gateway IAM is scoped to the three tables, two queues, one secret, and the
  API Gateway key-provisioning actions.
- The Encompass client secret is stored in Secrets Manager and cached only in
  Lambda memory. Tokens, secrets, invite codes, and keys never appear in logs.
- Read responses are `private, max-age=30`; schema responses are
  `private, max-age=300`; the portal sends a strict CSP plus `frame-ancestors 'none'`.

## Known limitations

- **Not deployed to AWS from this repository's development environment** (no AWS
  credentials or Encompass access). Production verification so far is CI plus the
  raw-template fetch used by `deploy.sh`; see `history.md`.
- No tenant revocation endpoint, key rotation UI, admin dashboard, or CORS.
  Vendors are expected to integrate server-to-server.
- One shared usage plan/quota for all tenants (per-tenant quotas are deferred).
- The three invite codes are global per role, not single-use per vendor. Anyone
  with a role link can mint keys for that role until the code is rotated.
- The cheat sheet covers 11 common fields. The lender's `CX.*` fields are only
  discoverable through `/v1/fields` once they exist in that Encompass instance.
- The `EncompassBaseUrl` default is `https://api.elliemae.com`; override it for
  sandbox or instance-specific hosts.
- `deploy.sh` pulls `template.yaml` from the `main` raw URL;
  raw.githubusercontent.com may serve a cached copy for a few minutes after a push.
