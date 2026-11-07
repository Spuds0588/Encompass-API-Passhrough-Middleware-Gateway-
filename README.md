# Encompass API Passthrough Gateway

Stateless AWS middleware that gives third-party vendors a small, stable API in
front of ICE Encompass. It keeps no loan database or mirror: write payloads
transit SQS, and read projections live in Lambda memory for up to 30 seconds.

## Deploy (AWS CloudShell, ~3 minutes)

```bash
bash <(curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/Spuds0588/Encompass-API-Passhrough-Middleware-Gateway-/main/deploy.sh)
```

The script verifies your AWS session, asks for the Encompass instance ID, client
ID, and client secret, generates three role invite codes, fetches the committed
template from a pinned release tag, verifies its SHA-256, and deploys
`Encompass-API-Gateway` with `CAPABILITY_IAM`. The client secret and invite codes
are written to a `0600` temporary parameter file and passed to CloudFormation as
`file://`; they do not appear in process arguments.

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
`BROKER_PERSONA`, `APPRAISAL_PERSONA`, `TEMPLATE_REF`, `TEMPLATE_SHA256`,
`TEMPLATE_URL`, `ARTIFACT_BUCKET`. The default `TEMPLATE_REF` is the `v0.2.0`
release tag; the pinned SHA-256 is the integrity anchor, so a moved or mistyped
tag aborts. Change `TEMPLATE_REF` and `TEMPLATE_SHA256` together when pinning a
fork or new release.

The committed template is larger than CloudFormation's 51,200-byte direct-upload
limit. `deploy.sh` detects that and uploads it to an S3 bucket it creates
(`ARTIFACT_BUCKET` overrides the name), which allows templates up to 1,000,000
bytes. If you prefer the console, upload `template.yaml` to S3 first and choose
"Amazon S3 URL"; direct "Upload a template file" only works below 51,200 bytes.

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
  what the vendor asked for, normalizing flat or nested Encompass field payloads
  to `{ id, fields, _cached }`, with a 30-second per-container projection cache.
- **Async writes** — `PATCH /v1/loans/{id}` validates and enqueues to SQS FIFO
  (grouped by loan), returns `202` + job ID, and retries Encompass file locks.
- **Persona impersonation** — vendors get a scoped API key mapped to an Encompass
  service account; OAuth token exchange results are cached per persona.
- **Role-scoped self-serve onboarding** — the lender shares a title, broker, or
  appraisal invite link. The vendor enters a company name and developer email;
  the gateway locks the key to that role's Encompass persona server-side. No
  admin token and no Encompass admin in the onboarding loop. Repeated
  submissions return the same key instead of minting duplicates.
- **Field discovery** — the portal publishes a common-field cheat sheet, and
  `GET /v1/fields?ids=11,646,CX.TITLE.STATUS` returns live definitions from
  Encompass's native standard and custom field schema APIs. `readOnly` and
  `fieldLock` are included when Encompass supplies them.
- **Broker loan lifecycle (top priority)** — `POST /v1/loans` creates a V3
  `LoanContract` for full applications (up to 1 MB); `PATCH
  /v1/loans/{id}/application` applies chunked contract updates. Milestone reads
  and `finish`/`unfinish` updates drive Submittal and Resubmittal. `POST
  /v1/loans/{id}/documents` creates eFolder documents, and enhanced and standard
  condition routes create conditions, attach documents, and mark them fulfilled.
  Existing document listing, pre-signed upload/download, and enhanced-condition
  read/respond remain available. File bytes move directly between the vendor and
  Encompass storage.
- **Zero-dependency portal** — one Lambda renders the invite page, provisions
  keys, attaches them to the usage plan, and stores the tenant mapping.
- **One-file deployment** — the whole stack lives in a single CloudFormation
  template. When it exceeds 51,200 bytes, `deploy.sh` uploads it to S3
automatically (1,000,000-byte limit); no Lambda zip or build service is needed.

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
                         ├── POST /v1/loans                         → full V3 registration
                         ├── PATCH /v1/loans/{id}/application      → chunked V3 update
                         ├── GET/PATCH /v1/loans/{id}/milestones    → submit/re-submit
                         ├── GET  /v1/loans/{id}/documents          → eFolder document list
                         ├── POST /v1/loans/{id}/documents          → create eFolder document
                         ├── POST /v1/loans/{id}/attachmentUploadUrl → pre-signed upload URL
                         ├── POST /v1/loans/{id}/attachmentDownloadUrl → pre-signed download URLs
                         ├── GET/POST/PATCH /v1/loans/{id}/conditions → enhanced conditions
                         ├── GET/PATCH /v1/loans/{id}/conditions/{conditionId}/documents → condition evidence
                         ├── GET/POST/PATCH /v1/loans/{id}/standard-conditions/{type} → standard conditions
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
| `PATCH` | `/v1/loans/{id}` body `{ "fields": { "1109": 450000 } }` | `x-api-key` | `202 { status: "ACCEPTED", jobId, loanId, requestId, statusUrl }` |
| `POST` | `/v1/loans?loanFolder=...` body full V3 `LoanContract` | `x-api-key` | `201 { loanId, data }` |
| `PATCH` | `/v1/loans/{id}/application` body V3 `LoanContract` | `x-api-key` | `200 { loanId, updated, data }` |
| `GET` | `/v1/loans/{id}/milestones` | `x-api-key` | `{ loanId, milestones: [...] }` |
| `PATCH` | `/v1/loans/{id}/milestones/{milestoneId}?action=finish\|unfinish` | `x-api-key` | `200 { loanId, milestoneId, action, data }` |
| `GET` | `/v1/loans/{id}/documents?view=full` | `x-api-key` | `{ loanId, documents: [...] }` (Encompass document objects unchanged) |
| `POST` | `/v1/loans/{id}/documents` body array of document objects | `x-api-key` | `200 { loanId, documents }` |
| `POST` | `/v1/loans/{id}/attachmentUploadUrl` body `{ file, title?, assignTo? }` | `x-api-key` | Encompass `CreateAttachmentResponse` (`attachmentId`, `authorizationHeader`, `url`, `multiChunkRequired`, `expiresAt`) |
| `POST` | `/v1/loans/{id}/attachmentDownloadUrl` body `{ "attachments": ["ATTACHMENT_ID"] }` | `x-api-key` | `{ loanId, downloads: [{ id, url, authorizationHeader?, contentType?, ... }] }` |
| `GET` | `/v1/loans/{id}/conditions?conditionType=Underwriting` | `x-api-key` | `{ loanId, conditions: [...] }` (enhanced conditions) |
| `POST` | `/v1/loans/{id}/conditions` body array of enhanced conditions | `x-api-key` | `200 { loanId, conditions }` |
| `PATCH` | `/v1/loans/{id}/conditions` body `[{ "id": "...", "tracking": [{ "status": "Received", "isChecked": true }] }]` | `x-api-key` | `{ loanId, updated }` |
| `GET` | `/v1/loans/{id}/conditions/{conditionId}/documents` | `x-api-key` | `{ loanId, conditionId, documents }` |
| `PATCH` | `/v1/loans/{id}/conditions/{conditionId}/documents?action=add\|remove` body document references | `x-api-key` | `{ loanId, conditionId, action, updated }` |
| `GET` | `/v1/loans/{id}/standard-conditions/{type}` | `x-api-key` | `{ loanId, conditionType, conditions }` |
| `POST` | `/v1/loans/{id}/standard-conditions/{type}` body condition object | `x-api-key` | `200 { loanId, conditionType, data }` |
| `PATCH` | `/v1/loans/{id}/standard-conditions/{type}?action=add\|update\|remove` | `x-api-key` | `200 { loanId, conditionType, action, data }` |
| `PATCH` | `/v1/loans/{id}/standard-conditions/{type}/{conditionId}/documents?action=add\|remove` | `x-api-key` | `{ loanId, conditionType, conditionId, action, updated }` |
| `GET` | `/v1/jobs/{id}` | `x-api-key` | `{ jobId, requestId, loanId, status, attempts, createdAt, updatedAt, error }` |

Condition `PATCH` accepts `tracking` and `internalDescription` updates and returns
`400` for retrieve-only `status`, `statusDate`, or `statusOpen`.

Job statuses: `PENDING` → `RETRYING` → `COMPLETED` / `FAILED`.
Every response includes `x-request-id`. Write jobs store the originating request
ID, return it from `GET /v1/jobs/{id}`, and the SQS worker logs the same ID on
every attempt.
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

### Document upload and download flow

1. `POST /v1/loans/{loanId}/attachmentUploadUrl` with the verified Encompass body:
   `{"file":{"contentType":"application/pdf","name":"returns.pdf","size":1234},"title":"Tax returns","assignTo":{"entityId":"DOC_GUID","entityType":"Document"}}`.
   `assignTo` is optional; without it Encompass files the attachment as unassigned.
   Add `?lockId=...` only if the persona already holds a loan lock.
2. Take `url` and `authorizationHeader` from the `200` response and `PUT` the raw
   file bytes to `url` with `Authorization: <authorizationHeader>`. Do **not** send
   the `x-api-key` to that URL; it is a short-lived Encompass upload credential.
3. Re-read `GET /v1/loans/{loanId}/documents` to confirm the attachment.
4. `POST /v1/loans/{loanId}/attachmentDownloadUrl` with the official Postman
   body `{"attachments":["ATTACHMENT_ID"]}` (1–20 ids). The `200` response is
   `{ loanId, downloads: [...] }`; each entry keeps Encompass's `id`, `url`,
   optional `authorizationHeader`, `contentType`, and related fields.
5. `GET` each `url`, sending `Authorization: <authorizationHeader>` when it is
   present. Download bytes, like upload bytes, go directly between the vendor
   and Encompass storage and never pass through the gateway.

File bytes go directly to Encompass storage and never pass through the gateway.
If a response has `multiChunkRequired: true` (files over 60 MB), Encompass's
multi-chunk `commitUrl` flow is required; the gateway passes the response through
but does not orchestrate chunks. Treat `authorizationHeader` as a secret.

### Roles and personas

| Role | Persona parameter | Default service account | Invite parameter |
| --- | --- | --- | --- |
| `title` | `TitleServiceUserId` | `api_title_template` | `TitleInviteCode` |
| `broker` | `BrokerServiceUserId` | `api_broker_template` | `BrokerInviteCode` |
| `appraisal` | `AppraisalServiceUserId` | `api_appraisal_template` | `AppraisalInviteCode` |

The persona comes from the role parameter, never from the request body, so a
vendor holding one invite link cannot mint a key for another role.

## Broker loan lifecycle

The lifecycle routes are synchronous native passthroughs. They resolve the tenant
from the API key, exchange for the tenant's persona token, and forward the request
directly to Encompass. The gateway does not persist loan, condition, or document
bodies and does not maintain a loan mirror.

| Stage | Route | Native contract |
| --- | --- | --- |
| Full registration | `POST /v1/loans?loanFolder=...` | V3 create loan with a full `LoanContract`; `loanFolder` required, `view=id` by default, 1 MB body cap. |
| Chunked application | `PATCH /v1/loans/{id}/application` | V3 update loan with a partial `LoanContract`; repeat with additional chunks. |
| Initial submission | `PATCH /v1/loans/{id}/milestones/{milestoneId}?action=finish` | V1 milestone update for Submittal. |
| Re-submission | Same milestone route with the Resubmittal milestone | V1 milestone update after conditions and documents are supplied. |
| Read conditions | `GET /v1/loans/{id}/conditions` or `GET /v1/loans/{id}/standard-conditions/{type}` | Enhanced V3 conditions or standard V1 underwriting/preliminary/postclosing sets. |
| Create document | `POST /v1/loans/{id}/documents` | V3 document add; then upload bytes with the pre-signed attachment flow. |
| Attach evidence | `PATCH /v1/loans/{id}/conditions/{conditionId}/documents?action=add` or the standard `.../{conditionId}/documents` route | V3 enhanced-condition documents or V1 standard-condition documents. |
| Satisfy condition | `PATCH /v1/loans/{id}/conditions` with `tracking`, or standard `PATCH ...?action=update` with `isFulfilled`/`status` | Native condition update. |
| Prior-to-docs / funding | Create or update conditions with `priorTo` set to `Docs`, `Funding`, `Closing`, or another Encompass value | V3 enhanced conditions or V1 standard underwriting/preliminary conditions. |
| Post-closing | Standard `postclosing` set, or enhanced conditions with a post-closing condition type | V1 post-closing conditions or V3 enhanced conditions. |

`{type}` is `underwriting`, `preliminary`, or `postclosing`. Enhanced conditions
and standard conditions are separate Encompass APIs; use the set configured for
the loan (`loan.useEnhancedConditionIndicator`). The gateway passes the native
objects through rather than reinterpreting them.

A complete broker flow is: create the loan, read milestones, finish Submittal,
create and upload documents, create/read conditions, attach documents, satisfy
the conditions, finish Resubmittal, add prior-to-docs and prior-to-funding
conditions/documents, and finally add post-closing conditions. The same flow can
start from an existing loan with `PATCH /application` and continue through the
condition and document routes.

Limits and guardrails:

- Full loan create/update bodies are capped at 1 MB; document and condition
  batches are capped at 20 entries. The legacy flat-field `PATCH` remains capped
  at 100 fields per async job and is not transactional across jobs.
- The gateway does not provide a cross-request transaction, document
  update/remove, condition comments, or multi-chunk upload orchestration. File
  bytes still go directly between the vendor and Encompass storage.
- Enhanced condition `PATCH` continues to reject retrieve-only `status`,
  `statusDate`, and `statusOpen`; use `tracking` and `internalDescription`.
- Encompass persona permissions remain the authorization control. The optional
  per-role field allowlists apply to the flat-field enqueue path, not to the
  native lifecycle routes.

Official references: [create a loan](https://developer.icemortgagetechnology.com/developer-connect/reference/create-loan-1),
[update a loan](https://developer.icemortgagetechnology.com/developer-connect/reference/update-loan-1),
[get milestones](https://developer.icemortgagetechnology.com/developer-connect/reference/get-all-milestones),
[update a milestone](https://developer.icemortgagetechnology.com/developer-connect/reference/update-a-milestone),
[manage enhanced conditions](https://developer.icemortgagetechnology.com/developer-connect/reference/manage-enhanced-conditions-1),
[manage enhanced-condition documents](https://developer.icemortgagetechnology.com/developer-connect/reference/manage-documents-1-1),
[create underwriting conditions](https://developer.icemortgagetechnology.com/developer-connect/reference/create-underwriting-conditions),
[manage underwriting conditions](https://developer.icemortgagetechnology.com/developer-connect/reference/manage-underwriting-conditions),
[create preliminary conditions](https://developer.icemortgagetechnology.com/developer-connect/reference/create-preliminary-conditions),
and [create post-closing conditions](https://developer.icemortgagetechnology.com/developer-connect/reference/create-post-closing-conditions).

These routes are locally verified against the fake. Live Encompass contract and
AWS deployment checks remain BLOCKED and are not claimed.

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
npm test          # 89 tests: handler unit/integration, HTTP e2e, template and static-page guards (CI: Node 20 + 24)
npm run verify    # template in sync + npm test
npm run build     # regenerate template.yaml after editing src/ or infra/
```

Coverage highlights: token exchange and cache reuse/expiry, tenant isolation,
field projection (including nested payloads) and validation, retrieve-only
condition rejection, writeability metadata, inactive-tenant rejection,
idempotent portal provisioning, concurrent-claim rejection, rollback of a new key
when tenant mapping fails, disabled-key rejection, the stage throttle and IAM
wiring for portal key minting, and the deploy-script TLS/checksum/secret-file
guards, DynamoDB point-in-time recovery, SNS encryption, and the documented
Checkov policy. CI pins `cfn-lint` and Checkov and runs both against the
generated template.
attachment download URLs plus a real byte download, request-ID correlation across
HTTP responses, jobs, SQS, and worker logs, read cache hits, 202 enqueue, job
ownership, worker success, 423 retry-then-success,
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
SECURITY.md           private vulnerability reporting and credential lifecycle
robots.txt            crawler policy for the static page
sitemap.xml           sitemap for the static page
agents.md             operating manual (YAGNI, cleanup, conventions)
todo.md               phase tracker and blocked production items
history.md            append-only work log
```

## Operations

### Request IDs, access logs, and alarms

Every HTTP response includes `x-request-id`. The value is the API Gateway request
ID when present and a generated UUID otherwise. The same ID is stored on each
write job, carried in the SQS message, returned by `GET /v1/jobs/{id}`, and added
to every Lambda log line, including worker retries.

API Gateway access logs go to `/aws/apigateway/<stack>-access` in JSON and contain
only metadata: request ID, source IP, request time, method, resource path, status,
response length, and API key ID. Query strings, headers, request/response bodies,
field values, and credentials are deliberately excluded.

`GatewayErrorsAlarm` and `Api5xxAlarm` publish to `OpsAlertTopic` alongside
`DeadLetterAlarm`; set `OpsAlertEmail` to receive them. The API alarms use the
existing SNS topic and do not enable execution logging or data tracing.

### DLQ alarm and purge procedure

`DeadLetterAlarm` fires when the write DLQ has at least one visible message for
one 5-minute period and publishes to `OpsAlertTopic`. Set `OpsAlertEmail` to
receive email; confirm the SNS subscription once. A DLQ message means a write job
exhausted its five attempts; the job record remains queryable at
`GET /v1/jobs/{jobId}` (metadata only, 30-day TTL).

1. Identify the failed job IDs from the alarm period, then read each job record
   and search CloudWatch logs for the matching `jobId`.
2. Capture sanitized evidence before deleting anything. Do not put field values,
   tokens, or borrower data in tickets.
3. Purge the DLQ only after the evidence is captured:

```bash
aws sqs purge-queue --queue-url "$DLQ_URL"
```

   Purging is irreversible, and FIFO queues enforce a 60-second cooldown between
   purges. To inspect a message first, use `receive-message` with
   `--max-number-of-messages 1` and delete it explicitly afterward. Never delete
   the queue itself; CloudFormation owns it.
4. Fix the upstream cause (persona permissions, field validity, Encompass
   availability) before re-driving work. Failed jobs are not replayed
   automatically; resubmit the write with a new job.

### API key and invite lifecycle

Invite codes are shared per role, not single-use. A title invite can be used by
multiple title partners and only mints title-persona keys. There is no
self-service revocation or invitation-management UI.

Rotate a role by redeploying with a new 24+ character invite code. Existing API
keys keep working; the old invite URL stops working immediately:

```bash
TITLE_INVITE_CODE="$(openssl rand -hex 24)" \
BROKER_INVITE_CODE="$BROKER_INVITE_CODE" \
APPRAISAL_INVITE_CODE="$APPRAISAL_INVITE_CODE" \
bash <(curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/Spuds0588/Encompass-API-Passhrough-Middleware-Gateway-/main/deploy.sh)
```

If a role's code is omitted, `deploy.sh` generates a new one and prints it. Save
all three outputs, or the omitted role's partners will need the newly printed
link.

Disable a compromised key immediately, before deleting anything:

```bash
KEY_ID="<apiKeyId>"
aws apigateway update-api-key --api-key "$KEY_ID" \
  --patch-operations op=replace,path=/enabled,value=false
```

Review access logs by `apiKeyId` and `requestId`, rotate the affected invite, and
mint a replacement through the portal. A disabled or deleted key is never
silently replaced: a repeat provisioning request returns `409` with
`code: API_KEY_UNAVAILABLE`. To delete a key permanently, remove its usage-plan
association and then delete it:

```bash
aws apigateway delete-usage-plan-key \
  --usage-plan-id "$USAGE_PLAN_ID" --key-id "$KEY_ID" --key-type API_KEY
aws apigateway delete-api-key --api-key "$KEY_ID"
```

Portal provisioning is idempotent for the same normalized role, company, and
email. DynamoDB holds a conditional provisioning claim and a 24-hour completion
record, never the key value. A repeat uses API Gateway
`GetApiKey(includeValue=true)` to return the same key, and a concurrent request
returns `409 PROVISIONING_IN_PROGRESS` instead of minting a second key. If tenant
mapping fails after key creation, the handler deletes the key and releases the
claim; a cleanup failure logs `API_KEY_ORPHANED` and leaves the claim in place to
fail closed. See `SECURITY.md` for orphan cleanup and reporting.

### Per-role field write allowlists

Set `TitleWriteFields`, `BrokerWriteFields`, or `AppraisalWriteFields` to a
comma-separated list of field IDs to enforce a gateway-level write allowlist for
that role. Leave a parameter empty to allow any valid field ID. A malformed list
fails closed and rejects every write for that role. Enforced at enqueue time, so
rejected payloads never enter SQS.

## Data handling

No loan database or mirror is maintained. The actual data paths are:

- **Lambda memory:** requested read projections for up to 30 seconds.
- **SQS:** write payloads in an encrypted FIFO queue for up to 1 day; DLQ up to
  4 days. SSE-SQS is enabled.
- **DynamoDB:** tenant name, email, role, persona, and API key ID; OAuth tokens
  with a TTL at token expiry (DynamoDB TTL deletion is eventual); job metadata for
  30 days; and provisioning idempotency metadata (a hash, status, and API key ID,
  never plaintext keys) with a 15-minute pending lock and a 24-hour completion
  TTL. Job records do not contain field values.
- **Documents and conditions:** document lists, condition reads and lifecycle
  writes, and upload-URL responses are passed through and never stored or cached.
  File bytes go from the vendor directly to Encompass's pre-signed URL; the
  gateway never proxies them and never logs the upload authorization header.
- **CloudWatch:** structured metadata logs with request IDs, plus metadata-only
  API Gateway access logs. Neither contains query strings, headers, bodies, field
  values, tokens, secrets, API keys, or upload credentials; retention is
  `LogRetentionInDays`.

Tenant records persist until removed from the table. See `todo.md` for the
remaining deletion, alarm, and offboarding work.

## Security notes

- Provisioning fails closed unless the role's invite code is configured and
  matches; comparisons are timing-safe. Unknown or unset roles are rejected.
- The Encompass persona is selected from the server-side role table; a
  client-supplied `encompassUserId` is ignored.
- Invite links are bearer secrets. They appear in the URL query string by design,
  so treat browser history and shared links as sensitive. The template's API
  Gateway access-log format deliberately excludes query strings. Rotate by
  updating the stack parameter; there is no self-service rotation UI.
- Portal key minting is idempotent per normalized role, company, and email for
  24 hours. A conditional DynamoDB claim blocks concurrent double-mints; repeats
  return the same key through `GetApiKey(includeValue=true)`, and plaintext is
  never persisted. A disabled or missing key returns `409` instead of minting a
  duplicate.
- `POST /portal` is throttled at the stage to 1 request/second with a burst of 2.
  Invite codes are shared per role rather than single-use.
- Report vulnerabilities through the private advisory flow in `SECURITY.md`.
  Never open a public issue with unpatched exploit details.
- Every vendor route resolves the tenant from `requestContext.identity.apiKeyId`;
  the tenant must be `ACTIVE`, and job reads additionally verify ownership.
- Field schema calls use the tenant's persona token and return definitions only,
  never loan data. Results are cached per persona and field set for 5 minutes.
- Gateway IAM is scoped to the four tables, two queues, one secret, and the
  API Gateway key lifecycle actions used by the portal (create, attach, get,
  remove from the usage plan, and delete).
- Document, lifecycle, upload, and condition routes resolve the tenant from the
  API key and use that tenant's persona token. Upload responses are `no-store` and
  their short-lived `authorizationHeader` is treated as a credential.
- Optional `*WriteFields` allowlists are enforced before enqueue and fail closed
  when malformed; they do not replace Encompass persona permissions.
- The Encompass client secret is stored in Secrets Manager and cached only in
  Lambda memory. Tokens, secrets, invite codes, and keys never appear in logs.
- Read responses are `private, max-age=30`; schema responses are
  `private, max-age=300`; the portal sends a strict CSP plus `frame-ancestors 'none'`.

## Known limitations

- **Not deployed to AWS from this repository's development environment** (no AWS
  credentials or Encompass access). Production verification so far is CI plus the
  pinned-template fetch and SHA-256 check used by `deploy.sh`; see `history.md`.
- No tenant revocation endpoint, key rotation UI, admin dashboard, or CORS.
  Vendors are expected to integrate server-to-server.
- One shared usage plan/quota for all tenants (per-tenant quotas are deferred).
- The three invite codes are global per role, not single-use per vendor. Anyone
  with a role link can mint keys for that role until the code is rotated.
- The cheat sheet covers 11 common fields. The lender's `CX.*` fields are only
  discoverable through `/v1/fields` once they exist in that Encompass instance.
- Broker support covers native loan registration/chunked application updates,
  milestones, eFolder document listing/creation, pre-signed upload/download,
  enhanced conditions, and standard underwriting/preliminary/post-closing
  conditions with document association. It does not provide a transactional
  cross-request workflow, document update/remove, condition comments, or
  multi-chunk upload orchestration. Flat-field `PATCH` remains limited to 100
  fields per job; use the V3 create/update routes for full applications.
- `/v1/fields` exposes read-only metadata. Optional `TitleWriteFields`,
  `BrokerWriteFields`, and `AppraisalWriteFields` parameters add a gateway-level
  write allowlist; Encompass persona permissions remain the authorization control.
- The template is 101,034 bytes, over CloudFormation's 51,200-byte direct-upload
  limit. Use `deploy.sh` (S3-hosted) or upload the template to S3 yourself; the
  S3-hosted limit is 1,000,000 bytes.
- Access logging configures one account-wide API Gateway CloudWatch role
  (`ApiGatewayAccount`). In a shared account, confirm that this does not replace
  a role another stack relies on before deploying.
- The `EncompassBaseUrl` default is `https://api.elliemae.com`; override it for
  sandbox or instance-specific hosts.
- `deploy.sh` fetches `template.yaml` from the `v0.2.0` release tag and fails
  closed on a SHA-256 mismatch. The digest, not the tag, is the integrity anchor.
  To deploy a fork or a new release, set `TEMPLATE_REF` and `TEMPLATE_SHA256`
  together; do not disable the checksum check.
