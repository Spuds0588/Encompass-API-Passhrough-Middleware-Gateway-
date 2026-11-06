# Encompass API Passthrough Gateway

Stateless AWS middleware that gives third-party vendors a small, stable API in
front of ICE Encompass. It keeps no loan database or mirror: write payloads
transit SQS, and read projections live in Lambda memory for up to 30 seconds.

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

## Features

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
  Encompass's native standard and custom field schema APIs. `readOnly` and
  `fieldLock` are included when Encompass supplies them.
- **Zero-dependency portal** — one Lambda renders the invite page, provisions
  keys, attaches them to the usage plan, and stores the tenant mapping.
- **One-file deployment** — the whole stack lives in a single CloudFormation
  template under the 51,200-byte direct-upload limit; no S3 bucket or Lambda zip.

## Community-supported

This is an independent, community-supported template, not a vendor-hosted product
and not affiliated with ICE Mortgage Technology. The maintainers cannot run a live
Encompass developer instance or a lender AWS account, so real-world validation is
a shared responsibility. If you deploy this template, please upstream what you
learn:

- **Project page:** https://spuds0588.github.io/Encompass-API-Passhrough-Middleware-Gateway-/
- **Bugs and field-shape reports:** https://github.com/Spuds0588/Encompass-API-Passhrough-Middleware-Gateway-/issues
- **Fixes and tests:** https://github.com/Spuds0588/Encompass-API-Passhrough-Middleware-Gateway-/pulls and [`CONTRIBUTING.md`](CONTRIBUTING.md)
- **Agent/LLM entry points:** [`agents.md`](agents.md) and [`llms.txt`](llms.txt)

Bugs, field-shape corrections, and fixes are a shared responsibility: file them as
GitHub issues or pull requests with sanitized evidence (redacted field shapes,
deployment or log excerpts), never secrets or PII. Privately-patched forks are
discouraged. If you can test a real Encompass tenant or AWS account, report the
sanitized result so other deployments benefit. Do not claim live Encompass or AWS
verification that did not happen.

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
| `GET` | `/v1/fields?ids=11,646,CX.TITLE.STATUS` | `x-api-key` | `{ "11": { description, type, readOnly?, fieldLock? }, ... }` |
| `GET` | `/v1/loans/{id}?fields=11,12,1109` | `x-api-key` | `{ id, fields: { ... }, _cached }` |
| `PATCH` | `/v1/loans/{id}` body `{ "fields": { "1109": 450000 } }` | `x-api-key` | `202 { status: "ACCEPTED", jobId, loanId, statusUrl }` |
| `GET` | `/v1/jobs/{id}` | `x-api-key` | `{ jobId, loanId, status, attempts, createdAt, updatedAt, error }` |

Job statuses: `PENDING` → `RETRYING` → `COMPLETED` / `FAILED`.
Default read field set: `11,12,14,1109` (max 100 fields per request).
Field lookups accept standard IDs, `CX.*` custom fields, and `CUSTnnFV` custom
fields (max 100 per request), and cache results per persona for 5 minutes. The
response includes `readOnly` and `fieldLock` when Encompass returns them, so a
broker can identify fields Encompass marks non-writable.

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

## Broker 1003, documents, and conditions

The gateway is a field-level passthrough, not a complete broker origination
client. A broker can write 1003 data when it knows the Encompass field IDs, but
at most 100 fields per async job. Larger applications must be split across jobs;
there is no transaction across jobs.

`GET /v1/fields` exposes `readOnly` and `fieldLock` when Encompass supplies them,
so a broker can identify fields Encompass marks non-writable. That is visibility,
not authorization: the persona still decides whether a write is allowed, and
`fields` projection is not an access-control list.

Not supported today:

- **Borrower documents.** There is no eFolder document, attachment, or pre-signed
  upload route. Encompass V3 uses `/loans/{loanId}/documents` and
  `/loans/{loanId}/attachmentUploadUrl`; this gateway is JSON-only.
- **Conditions.** There is no enhanced-condition read or respond route.
  Encompass V3 uses `/loans/{loanId}/conditions`.
- **Structured 1003 submission.** There is no application/borrower-pair resource;
  only flat field `PATCH`. A full URLA may exceed the 100-field cap and is not
  atomic across jobs.

Official references: [V3 Manage Documents](https://developer.icemortgagetechnology.com/developer-connect/reference/get-list-of-documents),
[V3 Create Attachment URL](https://developer.icemortgagetechnology.com/developer-connect/reference/create-attachment-url),
and [V3 Manage Enhanced Conditions](https://developer.icemortgagetechnology.com/developer-connect/reference/manage-enhanced-conditions-1).

Do not represent this deployment as sufficient for a broker's full
1003/document/condition workflow yet. The missing surfaces are tracked in
`todo.md`.

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
npm test          # 50 tests: handler unit/integration, HTTP e2e, template and static-page guards (CI: Node 20 + 24)
npm run verify    # template in sync + npm test
npm run build     # regenerate template.yaml after editing src/ or infra/
```

Coverage highlights: token exchange and cache reuse/expiry, tenant isolation,
field projection and validation, writeability metadata, inactive-tenant rejection,
read cache hits, 202 enqueue, job ownership, worker success, 423 retry-then-success,
permanent 4xx failure, attempt exhaustion, invite validation and role mismatch,
persona locking, field schema lookup and caching, CSP on the portal, and template
guards (API key requirement, FIFO + DLQ, SSE, bounded retention, no secret
defaults, invite parameters, native schema paths, size, embedded code).
Static-page guards check the community contribution links, cross-surface support
contract, agent-principle rules, `llms.txt` guidance, JSON-LD structured data,
canonical metadata, robots policy, and sitemap.

## Repository layout

```text
src/gateway.js        deployed Lambda (self-contained CommonJS)
infra/template.yaml   CloudFormation source with code placeholder
template.yaml         generated deployable template (committed)
scripts/build.js      inline + compact deploy copy + size guard + --check
deploy.sh             one-line CloudShell installer
dev/                  fake Encompass (loans + schema), in-memory store, local emulator
test/                 node:test suites (including static-page/community guards)
index.html            static SEO/AEO landing page served by GitHub Pages
llms.txt              compact machine-readable guide for LLMs and coding agents
CONTRIBUTING.md       community bug-report and pull-request workflow
robots.txt            crawler policy for the static page
sitemap.xml           sitemap for the static page
agents.md             operating manual (YAGNI, cleanup, conventions)
todo.md               phase tracker and blocked production items
history.md            append-only work log
```

## Data handling

No loan database or mirror is maintained. The actual data paths are:

- **Lambda memory:** requested read projections for up to 30 seconds.
- **SQS:** write payloads in an encrypted FIFO queue for up to 1 day; DLQ up to
  4 days. SSE-SQS is enabled.
- **DynamoDB:** tenant name, email, role, persona, and API key ID; OAuth tokens
  with a TTL at token expiry (DynamoDB TTL deletion is eventual); job metadata for
  30 days. Job records do not contain field values.
- **CloudWatch:** structured metadata logs only, never field values, tokens,
  secrets, or API keys; retention is `LogRetentionInDays`.

Tenant records persist until removed from the table. See `todo.md` for the
remaining deletion, alarm, and offboarding work.

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
  the tenant must be `ACTIVE`, and job reads additionally verify ownership.
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
- Broker support is field-level only: no eFolder document upload or
  enhanced-condition endpoints. Full 1003s may exceed the 100-field per-job cap.
- `/v1/fields` exposes read-only metadata, but there is no per-role field
  allowlist; Encompass persona permissions remain the authorization control.
- The `EncompassBaseUrl` default is `https://api.elliemae.com`; override it for
  sandbox or instance-specific hosts.
- `deploy.sh` pulls `template.yaml` from the `main` raw URL;
  raw.githubusercontent.com may serve a cached copy for a few minutes after a push.
