# history.md — Append-only work log

Newest entries at the bottom. Never rewrite or delete an entry; supersede it with
a new dated entry.

## 2026-11-06 — Repository intake

- Repository contained only the exported dev-doc chat (`chat-encompass-api-middleware-gatew-...md`),
  `LICENSE` (MIT, Corey Burns), and git history (initial commit + upload).
- Read the full dev doc. It specifies a stateless Encompass passthrough gateway:
  field-filtered reads, short-lived read caching, SQS FIFO async writes with retries,
  OAuth persona-token impersonation, and a zero-dependency SSR admin portal, deployed
  as a single-file CloudFormation stack from GitHub.
- Environment checked: Node 20.19.2, npm registry reachable, Docker present, `gh`
  authenticated as `Spuds0588`, repo public, Actions enabled, Pages disabled.
  No AWS CLI, SAM, Encompass credentials, or AWS account. Real AWS/Encompass
  deployment is out of scope for this machine and recorded as BLOCKED in `todo.md`.
- Decisions taken to keep the MVP lean (YAGNI):
  - One Lambda function handles API Gateway and SQS events. No separate portal,
    read, enqueue, worker, and job functions; the router is a few lines.
  - No npm runtime dependencies. AWS SDK v3 ships with the Node 20 runtime, so the
    handler can be inlined as `ZipFile` and deployed without an S3 bucket.
  - Generated `template.yaml` is committed (built from `src/gateway.js` +
    `infra/template.yaml`) so the one-line installer can fetch it from raw GitHub.
  - Added a deployment-time admin token to the portal. The reference implementation
    in the doc allowed anyone who found the URL to mint keys, which is unacceptable
    for a public endpoint.
  - Dropped the Tailwind CDN from the portal in favour of ~20 lines of inline CSS so
    the page works under a strict CSP with no third-party dependency.
  - Read responses use `Cache-Control: private, max-age=30` instead of the doc's
    `public`, because responses are scoped by API key and must not land in shared caches.
  - Client secret is stored as a raw Secrets Manager string (client ID and instance ID
    are non-secret Lambda env vars) to avoid JSON-escaping failures for secrets that
    contain quotes or backslashes.

## 2026-11-06 — MVP implementation

- Added `src/gateway.js`: portal GET/POST, health, field-filtered GET, PATCH enqueue,
  job status, and SQS write worker. Includes token exchange + DynamoDB cache,
  30-second read projection cache, structured JSON logging, tenant scoping, and
  retry classification (423/429/5xx retry, other 4xx fail).
- Added `infra/template.yaml`: Lambda, API Gateway REST + API key usage plan,
  DynamoDB ×3, SQS FIFO + DLQ, Secrets Manager, scoped IAM, log group, outputs.
- Added `scripts/build.js` to inline the handler, verify it is self-contained,
  enforce the 51,200-byte CloudFormation direct-upload cap, and support `--check`.
- Added `deploy.sh` (CloudShell one-liner) with credential verification, prompts,
  admin-token generation, template size check, and stack outputs.
- Added local harness: `dev/fake-encompass.js` (OAuth, loans, 423 lock simulation),
  `dev/memory-store.js`, and `dev/server.js` (API Gateway + SQS emulator with a
  `/dev/drain` route that re-drives failed messages like SQS would).
- Added Node `node:test` suites: 24 handler tests, 1 HTTP e2e flow, 8 template guards.
- Added `.github/workflows/ci.yml` to run tests and the template-sync check on push/PR.

## 2026-11-06 — Test iterations and evidence

- First full test run hung for 120s. Cause: `server.close()` waited on undici
  keep-alive sockets held by `fetch`. Fixed by calling `closeAllConnections()`
  before `close()` in both fake servers; the e2e also now closes its injected
  fake upstream. No orphan processes remained after the fix.
- One unit test failed: it asserted a 423 on a GET loan. That is not Encompass
  behavior (423 Locked applies to concurrent edits). Removed the misleading test
  instead of adding fake read-error behavior; write-lock retries remain covered
  by the worker retry tests.
- Evidence after fixes:
  - `npm test`: 32 tests, 32 pass, 0 fail (~2.1s), process exits cleanly.
  - `node scripts/build.js`: `template.yaml` 40,669 bytes (handler 24,921 bytes),
    under the 51,200-byte limit; `--check` passes.
  - E2E: portal rejects missing token, provisions a key, read is field-filtered and
    cache-hit on the second call, PATCH returns 202, worker completes, 423 loan is
    retried twice then completes, one token exchange serves all operations.
- Not verified: any AWS resource behavior, API Gateway key creation, Secrets Manager,
  DynamoDB TTL, real Encompass OAuth and loan endpoints. Recorded as BLOCKED.
