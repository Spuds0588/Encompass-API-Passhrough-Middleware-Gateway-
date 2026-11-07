# agents.md — Operating Manual

## Mission

A lean, stateless Encompass passthrough gateway that runs in the lender's AWS account:
field-filtered synchronous reads, asynchronous FIFO writes with retries, a
role-scoped self-serve onboarding portal, field schema discovery, eFolder
document listing, pre-signed attachment upload and download, and enhanced-condition
read/respond. It must keep no loan database or mirror; write payloads transit SQS
and read projections live in Lambda memory for up to 30 seconds.

Top priority (2026-11-06): the loan-file document and condition workflow
(list, upload, download, read/respond) outranks all other backlog work.

Source of truth for scope: `README.md`, `todo.md`, and `llms.txt`. The original
exported AI Studio chat was removed because it is no longer maintained.

## Community support is part of the job

This is an independent, community-supported template. The maintainer cannot run a
live Encompass developer instance or a lender AWS account, so real-world validation
is a shared responsibility. Agents working here must not imply otherwise.

- Bugs, field-shape corrections, and fixes are a shared responsibility: open
  GitHub issues or pull requests with sanitized evidence (redacted field shapes,
  deployment or log excerpts), never secrets or PII. Privately-patched forks are
  discouraged.
- When you fix a bug, add a regression test and upstream the smallest fix via a
  GitHub issue and pull request. Do not leave the fix only in a private fork.
- If a fix cannot be contributed, say so explicitly and explain the limitation.
- Read and follow `CONTRIBUTING.md`; point developers there, to `llms.txt`, and to
  the project page for the shared-testing expectations.
- If behavior or API changes, update `README.md`, `llms.txt`, `index.html`, and this
  file in the same change. Keep `todo.md` current and append to `history.md`.
- Do not claim live Encompass or AWS verification unless it actually happened.

## Non-negotiable principles

1. **YAGNI.** Build only what the task or dev doc requires. Do not add speculative
   endpoints, options, configuration, integrations, or UI. No loan mirror, no sync
   engine, no webhook receiver, no multi-region, no UI framework until a real
   requirement exists. If a feature is not in `todo.md`, do not add it.
2. **Prefer the shortest working solution.** One-line or near-one-line fixes take
   precedence over new abstractions, files, or dependencies. Keep one Lambda
   handler, one table per concern, and zero npm runtime dependencies. Do not
   introduce a library for something the platform already does.
3. **Clean up the dev environment.** This machine has limited memory and disk.
   Stop every server/process you start and leave no running processes. Remove
   `node_modules`, uncommitted build output, logs, temp files, and scratch files.
   The committed `template.yaml` is required delivery, not litter. Avoid installing
   dependencies unless a task genuinely needs them, and remove temporary installs
   when done. Before finishing a task verify with
   `ps -eo pid,args | grep -E "node --test|dev/server"` (expect none),
   `git status`, and a scan for `node_modules`/`dist`/`build`/`*.log`.
4. **Never backtrack.** `history.md` is append-only. If a decision changes, append
   a new dated entry that supersedes the old one; never rewrite history. Tick items
   in `todo.md`; never delete them. Revert only a change made in the current task.
5. **Honest verification.** Local fakes are not Encompass and not AWS. Report what
   was tested, what could not be tested, and what remains blocked.
6. **Stateless by default.** Keep only transient tokens, job status, 30-second
   read projections, and bounded SQS write payloads. Never build a loan database
   or mirror.

## Repo map

| Path | Purpose |
| --- | --- |
| `src/gateway.js` | The entire deployed Lambda: portal, reads, write enqueue, job status, SQS worker. Self-contained. |
| `infra/template.yaml` | CloudFormation source with a `//__GATEWAY_CODE__` placeholder. |
| `template.yaml` | Generated, committed deployable template. Never edit by hand. |
| `scripts/build.js` | Inlines the handler into the template, enforces the 1,000,000-byte S3-hosted limit, supports `--check`. |
| `deploy.sh` | One-line AWS CloudShell deployment; fetches a pinned template release tag, verifies SHA-256, uses TLS-only curl, passes secrets in a protected parameter file, uses `--s3-bucket` above 51,200 bytes, and deploys the stack. |
| `dev/fake-encompass.js` | Local fake OAuth + loans + schema + eFolder documents + pre-signed uploads/downloads + enhanced conditions, including 423 lock simulation. |
| `dev/memory-store.js` | In-memory storage/queue adapter for local runs. Never deployed. |
| `dev/server.js` | Local API Gateway + SQS emulator around the real handler. |
| `test/*.test.js` | Unit, end-to-end HTTP, template, and static-page tests (Node built-in runner). |
| `index.html` | Static SEO/AEO landing page served from GitHub Pages. |
| `llms.txt` | Machine-readable project guide for LLMs and coding agents. |
| `CONTRIBUTING.md` | Community bug-report, testing, and pull-request workflow. |
| `SECURITY.md` | Private vulnerability reporting, invite/key lifecycle, disable/delete commands, orphan cleanup. |
| `robots.txt`, `sitemap.xml` | Crawler policy and sitemap for the static page. |
| `.github/workflows/ci.yml` | Runs tests and template-sync check on push/PR. |

## Commands

```bash
npm run build     # regenerate template.yaml from infra + src
npm test          # 77 tests: unit, HTTP e2e, template and static-page guards
npm run verify    # build --check + npm test (use before committing)
npm run dev       # local gateway at :3000 with fake Encompass
```

## Conventions

- Node.js, CommonJS, no dependencies. The Lambda runtime (nodejs24.x) supplies AWS SDK v3.
  Local tooling and tests run on Node 20+; CI covers 20 and 24.
- `src/gateway.js` exports `handler` (lazy AWS store) and
  `createHandler({ store, env, fetchImpl, now })` for tests.
- Storage interface: `getSecret`, `getTenant`, `putTenant`, `getToken`,
  `putToken`, `getJob`, `putJob`, `enqueueWrite`, `createApiKey`, `getApiKey`,
  `deleteApiKey`, `claimProvisioning`, `getProvisioning`, `putProvisioning`,
  `deleteProvisioning`.
- Structured logs only: `log(level, ACTION, details)` → single-line JSON with
  `timestamp`, `level`, `action`, and the current `requestId`. Never log tokens,
  secrets, API keys, query strings, request/response bodies, or full upstream
  error bodies.
- Every HTTP response includes `x-request-id`; use the API Gateway request ID
  when present and a generated UUID as the fallback. Job records, SQS messages,
  worker logs, and job status responses preserve it.
- API Gateway access logs are metadata-only. Never add query strings, headers,
  bodies, field values, tokens, secrets, or keys to the access-log format.
- Error responses are always `{ "error": "message", ...optionalCode }`.
- API responses are `Cache-Control: no-store` except reads, which use
  `private, max-age=30` (never `public`: responses are tenant-scoped by API key).
  All responses include `x-request-id`.
- Reads project only requested fields and cap field lists at 100.
- `/v1/fields` splits standard (`CX.`/`CUSTnnFV` excluded) and custom IDs, calls
  `schemas/loan/standardFields` and `settings/loan/customFields`, and normalizes
  results to `{ id: { description, type, readOnly?, fieldLock? } }`; the last two
  are included only when Encompass supplies them. Cache per persona + field set
  for 5 minutes; never cache across personas.
- Writes return `202` with a job ID; the SQS event source re-drives retryable
  Encompass failures (423/429/5xx) up to 5 attempts, then marks the job FAILED.
- Documents use `GET /v1/loans/{id}/documents` → native V3 `/documents` and pass
  only `requireActiveAttachments`, `includeRemoved`, `view`, `start`, `limit`.
- Uploads use `POST /v1/loans/{id}/attachmentUploadUrl` and accept only the
  verified `file` (`name`, `contentType`, `size`), `title`, and `assignTo`
  (`entityId`, `entityType: Document`) fields. Return Encompass's
  `CreateAttachmentResponse` unchanged; file bytes go to its pre-signed `url`,
  never through the gateway, and `authorizationHeader` is never logged.
- Downloads use `POST /v1/loans/{id}/attachmentDownloadUrl` with the official
  `{ attachments: [id] }` body (1–20 ids) and return Encompass's download array
  unchanged inside `{ loanId, downloads }`. Each entry's `url` and
  `authorizationHeader` are short-lived credentials; never log or cache them.
- Conditions use native V3 `/conditions`; PATCH sends `?action=update` with an
  array of `{ id, ... }`. Only enhanced conditions are proxied; `status`,
  `statusDate`, and `statusOpen` are retrieve-only and must not be written.
- Document, upload, download, and condition responses are `no-store` and are
  never cached.
- Tests must not require AWS or Encompass. Use the dev fakes and close every
  server in `afterEach`/`finally` so the test process exits.

## Security invariants

- Provisioning requires a role invite code (`INVITE_TITLE`, `INVITE_BROKER`,
  `INVITE_APPRAISAL`) and fails closed if the role or code is unset; comparisons
  are timing-safe. The persona is chosen server-side from `PERSONA_*`; a
  client-supplied Encompass user ID is ignored. Invite codes are bearer secrets
  and are never logged.
- API Gateway API keys are required on `/{proxy+}`; the portal and `/health` are
  the only unauthenticated routes.
- Portal provisioning is idempotent per normalized role + company + email.
  A conditional DynamoDB claim (15-minute lock, 24-hour completion TTL) blocks
  concurrent double-mints. Repeats recover the existing key with API Gateway
  `GetApiKey(includeValue=true)`; plaintext is never stored. A disabled, missing,
  or inconsistent key returns `409` rather than minting a duplicate.
- If tenant mapping fails after key creation, delete the key and release the
  claim. If deletion fails, log `API_KEY_ORPHANED` with the key ID, keep the claim
  to fail closed, and follow the cleanup runbook in `SECURITY.md`.
- Invite codes are shared per role, never single-use. Rotate by redeploying with
  a new role code; existing API keys are unaffected. Never log invite codes.
- `POST /portal` is throttled at the stage to 1 rps / burst 2. Security reports
  go through the private advisory flow in `SECURITY.md`, not public issues.
- The Encompass client secret lives in Secrets Manager; DynamoDB uses SSE.
- Tenant resolution is always `requestContext.identity.apiKeyId` (never a
  client-supplied tenant ID). The tenant must have `status: ACTIVE`; missing or
  inactive status fails closed. Job reads enforce tenant ownership.
- Write queues use SSE-SQS, retain payloads for 1 day, and retain DLQ messages
  for 4 days. A CloudWatch alarm publishes to SNS when the DLQ is non-empty; the
  purge procedure is in `README.md` under Operations. No loan database or mirror
  exists.
- Optional `WRITE_FIELDS_TITLE`, `WRITE_FIELDS_BROKER`, and
  `WRITE_FIELDS_APPRAISAL` allowlists are enforced before enqueue; unset means no
  restriction, malformed fails closed. They are a guardrail, not a substitute
  for Encompass persona permissions.
- Upload/download URLs and their `authorizationHeader` values are short-lived
  credentials. Pass them through without logging or caching.
- Gateway IAM is scoped to the four tables, two queues, one secret, and only the
  API Gateway key operations the portal needs: create/attach, get, remove from the
  usage plan, and delete.
- `deploy.sh` pins `template.yaml` to the `v0.1.0` release tag and verifies
  SHA-256 before deploying; the digest is the integrity anchor, so a moved tag
  fails closed. curl is constrained to HTTPS/TLS 1.2+. The client secret and invite
  codes are written to a `0600` temp parameter file passed as `file://`, never as
  CLI arguments, and the trap removes both temp files. Update `TEMPLATE_REF` and
  `TEMPLATE_SHA256` together; never add a checksum bypass.
- CI runs pinned `cfn-lint` and Checkov against the generated template in
  addition to Node 20/24 tests and the build-sync check. `.checkov.yaml` holds
  only documented intentional exceptions; never add a finding that the template
  can fix.

## Workflow

1. Read `todo.md`; pick the next unchecked item.
2. Follow `todo.md` priority order: document/condition work first, then P1/P2.
   Make the smallest change that completes the item, with a test.
3. `npm run build` if `src/gateway.js` or `infra/template.yaml` changed.
4. `npm run verify`; fix causes, never weaken assertions.
5. Update `todo.md` (tick it) and append to `history.md` (what changed, evidence).
   If behavior or API changed, also update `README.md`, `llms.txt`, `index.html`,
   and this file.
6. Commit. Push only when the user asks. Open a pull request when contributing to
   a shared deployment so the fix is visible to the community.

## Deployment and verification reality

- The target is AWS: API Gateway REST + API key usage plan, Lambda (Node 24,
  arm64), DynamoDB, SQS FIFO + DLQ, Secrets Manager, CloudFormation.
- This development machine has no AWS CLI, SAM, Encompass credentials, or AWS
  account. `template.yaml` is therefore logically tested (resources, wiring,
  size, handler embedding) but **never deployed to AWS from here**.
- The local "production-shaped" test runs the real handler over real HTTP against
  a fake Encompass and in-memory AWS. It proves routing, auth, caching, and retry
  behavior, not AWS resource behavior.
- The deployable artifact is verified in CI on `main`
  (`.github/workflows/ci.yml`) and by fetching the pinned release tag's raw
  `template.yaml` from GitHub, which is exactly what `deploy.sh` downloads.
- `scripts/build.js` compacts the inlined deploy copy and enforces 1,000,000
  bytes. The template is 78,534 bytes, above CloudFormation's 51,200-byte direct
  limit, so `deploy.sh` creates/reuses an S3 bucket and passes `--s3-bucket`
  (S3-hosted limit: 1 MB). Keep the source formatted; do not hand-edit
  `template.yaml`.
- To verify for real: run `deploy.sh` in AWS CloudShell, open one printed role
  invite link, provision a key, then `GET /health`, `GET /v1/fields?ids=...`,
  `GET /v1/loans/{id}?fields=...`, `PATCH /v1/loans/{id}`, and poll
  `GET /v1/jobs/{id}`. Also `GET /v1/loans/{id}/documents`, initiate an upload
  and PUT the bytes to its URL, then `GET`/`PATCH /v1/loans/{id}/conditions` and
  re-read to confirm the status. Repeat with a mismatched role link to confirm
  rejection.
