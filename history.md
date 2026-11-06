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

## 2026-11-06 — Runtime bump, template lint, and production verification

- Ran `cfn-lint` against the generated template (installed with `pip --target /tmp/cfnlint`;
  no system packages or venv changes). Its only finding was W2531: `nodejs20.x` is
  deprecated (creation disabled 2027-07-29). This supersedes the dev doc's Node 20
  choice: the Lambda now uses `nodejs24.x`, which still bundles AWS SDK v3 and
  supports every API the handler uses. CI also tests Node 20 and 24.
- CI run `42295856689` then failed on Node 24 because `node --test test/` is treated
  as a module path there. Changed the script to `node --test` (built-in discovery),
  which passes on both versions. This supersedes the earlier test command.
- Verification evidence:
  - CI run `42295967345` on `6a22a5e`: `verify (20)` and `verify (24)` both success.
  - `cfn-lint template.yaml`: exit 0, no findings.
  - `npm run verify`: 32/32 tests, template in sync, `template.yaml` 40,669 bytes.
  - GitHub contents API blob for `template.yaml` (`ce73addc...`, 40,669 bytes) matches
    `git hash-object template.yaml`; the commit-pinned raw URL matches the local
    sha256 `9024e98b...`; `deploy.sh` blob also matches its local blob.
  - Caveat: the raw `main` URL used by `deploy.sh` was still serving the pre-bump
    template at check time due to raw.githubusercontent CDN caching. Repo content is
    correct; allow a few minutes after a push before running the installer.
- Still BLOCKED: real AWS stack deployment, API Gateway key provisioning, DynamoDB/SQS
  behavior, and Encompass OAuth/read/write, because this machine has no AWS credentials
  or CLI and no Encompass access.
- Cleanup at task close: removed the throwaway `/tmp` cfn-lint install, raw artifact
  copies, and test logs; no npm dependencies installed; no background servers left.

## 2026-11-06 — Role-scoped invites and field schema discovery

- The user supplied the full onboarding notes, superseding the earlier admin-token
  interpretation. The portal must not let an unauthenticated visitor choose a
  persona; onboarding must take the Encompass admin out of the loop.
- Replaced the shared admin token with three role-scoped invite codes:
  `INVITE_TITLE`, `INVITE_BROKER`, `INVITE_APPRAISAL`. Each link also carries a
  role; the server maps it to `PERSONA_TITLE`, `PERSONA_BROKER`, or
  `PERSONA_APPRAISAL`. The vendor sends only company name and developer email.
  Any client-supplied Encompass user ID is ignored; role/code mismatch is 403 and
  an unconfigured role fails closed. Comparisons remain timing-safe and codes are
  never logged.
- Added the dynamic field schema route `GET /v1/fields?ids=...` for standard and
  custom fields. Researched the native APIs first: the notes' path
  `/encompass/v3/schemas/loan/fields` is not the schema endpoint. The handler uses
  `/encompass/v3/schemas/loan/standardFields` for standard IDs and
  `/encompass/v3/settings/loan/customFields` for `CX.*` / `CUSTnnFV` IDs, both with
  `start=0&limit=10000&ids=...`, then normalizes the array response to
  `{ id: { description, type } }`. Results cache per persona + field set for five
  minutes, capped at 200 entries.
- Rebuilt the portal as an invite page: locked role badge/persona, company + email
  form, result panel with key, endpoint list, and cURL examples, plus the 11-field
  cheat sheet and a copy-all-IDs button. Without an invite it shows a landing
  message and the cheat sheet only. No admin token input remains.
- Added the three invite codes and three persona parameters to `infra/template.yaml`
  (all codes `NoEcho`, `MinLength: 24`), removed `AdminPortalToken`/`ADMIN_TOKEN`,
  and added a `FieldsUrl` output. `deploy.sh` now generates 24-byte (48 hex chars)
  codes with `openssl`, prints one link per role, and reuses codes/personas from
  the environment on updates.
- Extended the fake Encompass with standard/custom schema endpoints, schema call
  counters, and a configurable schema failure. The dev server now prints the title
  invite link and exports all three invites. The e2e flow covers landing page,
  valid invite, rejected code, provisioned persona, fields lookup/cache, read,
  write, retry, and job status.
- Template size grew to 53,958 bytes, over CloudFormation's 51,200-byte
  direct-upload cap. Instead of dropping features or moving to S3 packaging,
  `scripts/build.js` now compacts only the inlined deploy copy (strips leading
  indentation/blank lines, uses 9-space YAML content indent). Source remains
  formatted and readable; the deployed handler is verified separately from the
  extracted template block. Final template: 49,922 bytes (31,689-byte embedded
  handler).
- Evidence:
  - `npm run verify`: 41/41 tests pass, template in sync.
  - `cfn-lint template.yaml`: exit 0, no findings.
  - Extracted inlined handler: `node --check` passes; a portal smoke call against
    the extracted handler returns 200 with the locked persona and cheat sheet.
  - `node scripts/build.js`: 49,922 bytes, under the 51,200-byte limit.
- Pending at this entry: commit, push, new CI run, and raw artifact verification.
  Still BLOCKED: real AWS deployment, API Gateway key creation, real Encompass
  OAuth/loans, and the live schema response shape.

## 2026-11-06 — Invite/field-schema CI and production artifact verification

- Pushed commit `9d0d23e` (`feat: add role-scoped invites and field schema
  discovery`) to `main`. GitHub Actions CI run `42298202063` completed successfully
  for both Node 20 and Node 24.
- Artifact evidence at that commit:
  - `template.yaml`: 49,922 bytes, sha256
    `70ce427d33b4ef82e23dc64cd318716cda359819957dfbfd8cc0078db55f70dd`,
    git blob `54f4c08d5ac605f52ced40a3da8823aa37bdd172`. The GitHub contents API
    blob matches, and both the commit-pinned raw URL and the raw `main` URL (used
    by `deploy.sh`) returned byte-identical content on the first poll.
  - `deploy.sh`: git blob `83ddfd0d3596b6e6c7e29b894fda87e5dc227941` matches the
    contents API; raw `main` sha256
    `55dedeea31b438cc157c8db053078d8e10bb3ece04a26e08b3194097b74aa84c` matches
    the local file. The installer will therefore fetch the verified template.
- This docs/evidence follow-up commit does not change `template.yaml`, `deploy.sh`,
  or handler bytes, so the artifact hashes above remain the deployed content.
- Still BLOCKED: real AWS deployment, API Gateway key creation, real Encompass
  OAuth/loans, and the live schema response shape.
