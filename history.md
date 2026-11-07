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

## 2026-11-06 — Mission wrap-up and clean-checkout verification

- Audited `agents.md`, `todo.md`, and `history.md` against the shipped `main`
  code at `e90f4eb`. All three existed and described the role-scoped invites and
  the `GET /v1/fields` passthrough. `todo.md` already showed the MVP scope as done
  with the AWS/Encompass blockers, so it was left intact. `agents.md` was corrected
  to state explicitly that cleanup includes removing `node_modules`, uncommitted
  build output, logs, temp/scratch files, and stray processes, while the committed
  `template.yaml` remains required delivery.
- Verification from the working tree and from a `git archive HEAD` clean copy in
  `/tmp`:
  - `npm run verify` passed 41/41 tests in both locations, including the template
    `--check` sync guard.
  - `cfn-lint template.yaml` exited 0 with no findings.
  - `bash -n deploy.sh` exited 0; the template is 49,922 bytes.
  - No `node_modules`, `dist`/`build` output, logs, scratch files, or test/dev
    server processes were left in the repository.
- No new endpoints or features were added. Invite links remain shared per role
  rather than single-use, as instructed. `template.yaml` and `deploy.sh` bytes are
  unchanged from the verified feature commit.
- Remaining limitations: this machine has no AWS account/CLI and no Encompass
  credentials. Real CloudFormation deployment, API Gateway key creation,
  DynamoDB/SQS behavior, OAuth token exchange, loan reads/writes, and live
  standard/custom schema responses remain unverified and BLOCKED.
- This is the wrap-up docs change. A subsequent append-only note records the
  wrap-up commit's CI and raw GitHub artifact verification.

## 2026-11-06 — Post-push wrap-up verification

- Pushed wrap-up docs commit `4e64841` (`docs: close out mission bookkeeping`) to
  `main`. GitHub Actions CI run `42298709440` completed successfully for Node 20
  and Node 24.
- Raw `main` artifact checks after that push:
  - `template.yaml`: 49,922 bytes, sha256
    `70ce427d33b4ef82e23dc64cd318716cda359819957dfbfd8cc0078db55f70dd`; raw
    `main` matches the committed file, and the contents API blob
    `54f4c08d5ac605f52ced40a3da8823aa37bdd172` matches `git hash-object`.
  - `deploy.sh`: raw `main` sha256
    `55dedeea31b438cc157c8db053078d8e10bb3ece04a26e08b3194097b74aa84c` matches
    the committed file; contents API blob
    `83ddfd0d3596b6e6c7e29b894fda87e5dc227941` matches `git hash-object`.
- The only changes in this wrap-up are `agents.md` and `history.md`; no endpoint,
  handler, template, or installer bytes changed. Invites remain shared per role,
  not single-use, as instructed.
- Still BLOCKED: real AWS deployment, API Gateway key creation, DynamoDB/SQS
  behavior, Encompass OAuth/loan calls, and live standard/custom schema responses
  because this machine has no AWS account/CLI and no Encompass credentials.

## 2026-11-06 — Community support, agent guidance, and SEO/AEO

- Added `CONTRIBUTING.md`: community-supported expectation, bug-report checklist,
  sanitization rules, local test commands, PR requirements, and guidance for
  contributors who can test a real Encompass tenant or AWS account.
- Added `llms.txt`: canonical links, API summary, local commands, community
  contract, explicit instructions for coding agents to upstream fixes, and an
  honest list of verified versus unverified behavior.
- Added `index.html`: a static, dependency-free GitHub Pages landing page with
  canonical URL, description, Open Graph/Twitter metadata, `SoftwareSourceCode`
  and `FAQPage` JSON-LD, API summary, field-schema example, agent links, and a
  prominent shared-responsibility/issue/PR section.
- Added `robots.txt` and `sitemap.xml` for the GitHub Pages project URL
  `https://spuds0588.github.io/Encompass-API-Passhrough-Middleware-Gateway-/`.
- Updated `README.md` and `agents.md` with the community-support contract: the
  maintainers cannot run a live Encompass developer instance or lender AWS account,
  so validation is shared; bugs and fixes should go through GitHub issues and pull
  requests, with secrets, invite codes, tokens, and loan data redacted.
- Added `test/static.test.js` (4 tests) covering required community files,
  `llms.txt` agent instructions, index SEO/AEO metadata and valid JSON-LD, and the
  robots/sitemap canonical URL. Test count is now 45.
- Verification before push: `npm run verify` passed 45/45; JSON-LD parsed as
  `WebSite,SoftwareSourceCode,FAQPage` with 7 FAQ entries. No handler, template,
  or installer bytes changed; `template.yaml` remains 49,922 bytes.
- Pending at this entry: commit, push, CI run, GitHub Pages build, and raw GitHub
  artifact checks. Limitations remain: no live AWS or Encompass validation, and
  the page is static documentation, not a hosted runtime gateway.

## 2026-11-06 — Community layer post-push verification

- Pushed commit `a64461f` (`docs: add community support and project landing page`)
  to `main`. GitHub Actions CI run `42299556782` completed successfully for Node 20
  and Node 24.
- GitHub Pages build `1347436024` completed with status `built`. The live page at
  `https://spuds0588.github.io/Encompass-API-Passhrough-Middleware-Gateway-/`
  returned HTTP 200 with the expected title, and `llms.txt`, `robots.txt`, and
  `sitemap.xml` all returned HTTP 200. The served `index.html` and `llms.txt` were
  byte-identical to the committed files.
- Raw `main` `template.yaml` and `deploy.sh` remained byte-identical to local:
  template 49,922 bytes / sha256
  `70ce427d33b4ef82e23dc64cd318716cda359819957dfbfd8cc0078db55f70dd`;
  installer sha256
  `55dedeea31b438cc157c8db053078d8e10bb3ece04a26e08b3194097b74aa84c`.
  No handler, template, or installer bytes changed in the community layer.
- Repository discoverability metadata set: homepage is the live project page,
  description names the community-supported scope, and topics are `api-gateway`,
  `aws-lambda`, `cloudformation`, `encompass`, `ice-mortgage`, `mortgage-tech`,
  `open-source`, and `serverless`.
- Invite links remain shared per role, not single-use, as instructed. Remaining
  limitations are unchanged: no AWS account/CLI and no Encompass credentials here,
  so real deployment, API Gateway key creation, DynamoDB/SQS behavior, OAuth, loan
  calls, and live schema responses remain unverified and BLOCKED.

## 2026-11-06 — Community contract enforcement

- Strengthened `agents.md` so the operating rules are explicit and testable:
  YAGNI forbids speculative endpoints, options, configuration, integrations, and UI;
  the shortest working solution and one-line/near-one-line fixes take precedence
  over new abstractions; cleanup leaves no `node_modules`, build output, logs,
  temp files, scratch files, or running processes.
- Normalized the community-support contract across `agents.md`, `llms.txt`,
  `index.html`, `README.md`, and `CONTRIBUTING.md`: maintainers cannot validate
  against a live Encompass tenant or lender AWS account; bugs, field-shape
  corrections, and fixes are a shared responsibility; reports and fixes must go
  through GitHub issues or pull requests with sanitized evidence (redacted field
  shapes and deployment/log excerpts); never secrets or PII; privately-patched
  forks are discouraged; and unverified live Encompass/AWS claims are forbidden.
- Added two static guards: one requires every community surface to carry the full
  contract, and one requires `agents.md` to carry the YAGNI, shortest-solution,
  and dev-environment cleanup rules. Test count is now 47.
- Verification before push: `npm run verify` passed 47/47. No endpoint, handler,
  template, or installer bytes changed; `template.yaml` remains 49,922 bytes.
- Pending at this entry: commit, push, exact-commit CI, GitHub Pages build, raw
  `main` document checks, and cleanup. Limitations remain: no live AWS or Encompass
  verification is possible from this machine.

## 2026-11-06 — Community contract post-push verification

- Pushed contract-enforcement commit `55ecda7ec3de13b64c9a092ee2a992bd320c0799`.
  CI run `42300329582` completed successfully at that exact SHA on Node 20 and 24.
- GitHub Pages build status is `built` (updated `2026-11-06T21:53:37Z`). The live
  page and `llms.txt`, `robots.txt`, and `sitemap.xml` all returned HTTP 200 and
  were byte-identical to the local files.
- Raw `main` for `agents.md`, `README.md`, `CONTRIBUTING.md`, `llms.txt`,
  `index.html`, `test/static.test.js`, `todo.md`, `history.md`, `template.yaml`,
  and `deploy.sh` matched local bytes. Three raw URLs initially served stale
  `max-age=300` edge copies; the Git content API and commit-pinned raw URLs already
  had the new objects, and the canonical raw URLs refreshed to the same bytes.
- No handler, endpoint, template, or installer changes were made. `template.yaml`
  remains 49,922 bytes with SHA-256
  `70ce427d33b4ef82e23dc64cd318716cda359819957dfbfd8cc0078db55f70dd`;
  `deploy.sh` remains SHA-256
  `55dedeea31b438cc157c8db053078d8e10bb3ece04a26e08b3194097b74aa84c`.
- This history-only follow-up commit is checked after push for exact-commit CI,
  Pages build status, raw bytes, a clean worktree, and removal of temporary files
  and dev processes. Remaining limitation: no AWS account/CLI or Encompass
  credentials exist here, so live deployment, API Gateway key creation,
  DynamoDB/SQS behavior, OAuth, loan calls, and live schema responses are still
  unverified and BLOCKED.

## 2026-11-06 — README deployment quickstart moved to top

- Moved the AWS CloudShell deployment instructions and post-deploy smoke test
  directly below the project summary, ahead of features, community guidance,
  architecture, API reference, and local development.
- Added a `## Features` heading for the relocated capability list. The deployment
  text and the community-support contract are otherwise unchanged.
- Verification before push: `npm run verify` passed 47/47. No code, endpoint,
  template, or installer changes.
- Post-push checks (exact-commit CI, Pages build, live asset bytes, raw README,
  clean worktree, and cleanup) are reported in the delivery response. Remaining
  limitation: no live AWS or Encompass validation is possible from this machine.

## 2026-11-06 — Security, audit, compliance, and usability evaluation (backlog only)

- Reviewed `src/gateway.js`, `infra/template.yaml`, `deploy.sh`, CI, tests, and the
  public docs. No runtime, infrastructure, template, deploy, or test fixes were
  implemented in this pass.
- Verdict: the lean passthrough design is coherent and locally tested, but it is
  not yet audit-ready for real borrower data. Key gap classes: the “no loan data
  stored” claim versus SQS write-payload retention; persona-only authorization
  and no field allowlist; static invite/key lifecycle and unthrottled key
  minting; incomplete request-ID, access-log, and alarm coverage; deploy secret
  and supply-chain exposure; missing input caps and compliance runbooks.
- Template budget finding: `template.yaml` uses **49,922 of 51,200 bytes**,
  leaving **1,278 bytes**. API access logging, WAF, and a full alarm set may
  require a deliberate S3-hosted template or separate hardening stack; they must
  not silently breach the direct-upload limit.
- Added the ranked, unchecked backlog and the explicit not-recommended list to
  `todo.md` Phase 8. The backlog is evaluation only; none of it was implemented.
- Re-checked `agents.md`: the YAGNI/no-speculation rule, shortest-working/one-line
  preference, and dev-environment cleanup requirements are present and enforced
  by the static test suite. No edit was needed there.
- Remaining limitations are unchanged: no AWS account/CLI and no Encompass
  credentials here, so live deployment, API Gateway key creation, DynamoDB/SQS
  behavior, OAuth, loan calls, and live schema responses remain unverified and
  BLOCKED. GitHub Pages remains the only deployed production surface.

## 2026-11-06 — Removed obsolete exported dev documentation

- Deleted `chat-encompass-api-middleware-gatew-google-ai-studio-2026-11-06-1454.md`
  from the current tree (42,563 bytes). It was the original exported AI Studio
  conversation and is no longer maintained or useful.
- Updated `agents.md` so current scope points to `README.md`, `todo.md`, and
  `llms.txt`; the historical reference in this append-only log remains as a
  record of the initial repository state.
- No code, endpoint, template, installer, or test changes. Git history was not
  rewritten; the old blob remains retrievable from prior commits.
- Verification: `npm run verify` passed 47/47; the deleted file has no remaining
  live references. GitHub Pages remains the only deployed production surface.

## 2026-11-06 — Broker field writeability and retention hardening

- Verified the official Encompass Developer Connect contracts before changing
  anything. The V3 standard-field schema exposes `readOnly`, `fieldLock`, and
  related metadata; eFolder documents use `/loans/{loanId}/documents` plus the
  `/loans/{loanId}/attachmentUploadUrl` pre-signed upload flow; enhanced
  conditions use `/loans/{loanId}/conditions`. The gateway has none of those
  document/condition routes, so it cannot certify a broker's full borrower-doc or
  condition workflow. This is recorded in `README.md` and Phase 9 of `todo.md`.
- Added `readOnly` and `fieldLock` to `/v1/fields` definitions when Encompass
  supplies them. This gives brokers visibility into fields Encompass marks
  non-writable, but does not replace persona authorization. The dev fake now
  includes read-only field 1393 and the test suite covers the metadata response.
- Enforced tenant `status: ACTIVE` in `tenantFor`; missing, suspended, or otherwise
  non-active tenants are rejected across reads, writes, schema, and job routes.
  Existing tenant fixtures were updated to use explicit ACTIVE status, and an
  inactive-tenant regression test covers all authenticated route classes.
- Corrected the public claim that no loan data is ever stored. The accurate model
  is: no loan database or mirror; read projections live in Lambda memory for up to
  30 seconds; write payloads transit SQS for up to 1 day (DLQ 4 days); job records
  are metadata only with a 30-day TTL; tokens use TTL; tenant email/name persist
  until removal. Updated `README.md`, `agents.md`, `llms.txt`, and `index.html`.
- Shortened SQS retention to 86,400 seconds for the write queue and 345,600
  seconds for the DLQ, and enabled `SqsManagedSseEnabled` on both queues. Added
  template guards for retention and SSE.
- Added an explicit 100-field `PATCH` cap regression test. Full 1003 submission
  remains field-based and split across jobs; no structured application resource
  was invented.
- Verification before push: `npm run build` produced `template.yaml` at 50,376
  bytes (824 bytes under the direct-upload limit); `npm test` passed 50/50. No AWS
  or live Encompass validation was possible. Pending at this entry: commit, push,
  exact-commit CI, Pages build, raw artifact checks, and cleanup.

## 2026-11-06 — Field writeability/retention hardening production verification

- Pushed commit `83f0057ef7a6236ee921879c77f6dd1b83d7c6ce` (`feat: expose field
  writeability and harden retention`) to `main`.
- CI run `42305287711` completed successfully on that exact SHA for Node 20 and
  Node 24.
- GitHub Pages build completed as `built` (created `2026-11-06T22:30:56Z`). The
  live page returned HTTP 200 with `text/html; charset=utf-8` and HSTS
  `max-age=31556952`; `index.html` was byte-identical. `llms.txt`, `robots.txt`,
  and `sitemap.xml` also returned 200 and matched local bytes.
- Raw `main` matched local bytes for `README.md`, `agents.md`, `llms.txt`,
  `todo.md`, `history.md`, `index.html`, and `template.yaml`. Template size is
  50,376 bytes, sha256
  `c2bd3f9e73edea394623b230ea624159cf3f784a864b8c9668d4b01ebb4653e6`.
- The broker verification stands: field-level 1003 writes and `readOnly`/
  `fieldLock` metadata are supported; eFolder borrower documents, enhanced
  conditions, and structured 1003/application submission are not. No AWS or live
  Encompass validation is claimed.
- This post-push entry is itself a docs-only follow-up commit; its CI, Pages, raw
  `history.md`/`todo.md`, clean-worktree, and cleanup checks are reported in the
  delivery response.

## 2026-11-06 — Broker documents, attachment uploads, conditions, and size-safe delivery

- Verified the official V3 contracts before coding, using the Developer Connect
  reference and the published Postman collection rather than guessed shapes:
  - `GET /encompass/v3/loans/{loanId}/documents` with `requireActiveAttachments`,
    `includeRemoved`, `view`, `start`, and `limit`.
  - `POST /encompass/v3/loans/{loanId}/attachmentUploadUrl` with optional `lockId`
    and body `{ file: { contentType, name, size }, title?, assignTo? }`, where
    `assignTo` is `{ entityId, entityType: "Document" }`. The response is the
    Encompass `CreateAttachmentResponse` (`attachmentId`, `authorizationHeader`,
    `url`, `multiChunkRequired`, `expiresAt`); the client then PUTs the bytes.
  - `GET`/`PATCH /encompass/v3/loans/{loanId}/conditions`; PATCH uses
    `?action=update` and an array of EnhancedConditionContract updates that
    include `id`. Tracking entries are `{ status, isChecked }`; condition
    `status`, `statusDate`, and `statusOpen` are retrieve-only.
- Added four gateway routes with tenant/persona auth, query validation, a 10 KB
  JSON-body cap, and consistent upstream error mapping:
  `GET /v1/loans/{id}/documents`, `POST /v1/loans/{id}/attachmentUploadUrl`,
  `GET /v1/loans/{id}/conditions`, and `PATCH /v1/loans/{id}/conditions`.
  Documents and conditions are wrapped as `{ loanId, documents|conditions }`
  without altering the upstream objects; upload responses pass through unchanged.
- Extended `dev/fake-encompass.js` with eFolder document state, pre-signed upload
  URLs and a real `PUT /upload/{id}` target, enhanced conditions, and condition
  tracking/status updates. The fake assigns an uploaded attachment to the target
  document so a subsequent document read proves the flow, and derives condition
  status from the checked tracking entries.
- Closed both remaining P0 items:
  - Added `DeadLetterAlarm` (SQS `ApproximateNumberOfMessagesVisible` > 0 for one
    5-minute period) publishing to `OpsAlertTopic`, with optional
    `OpsAlertEmail` SNS subscription; documented the inspect/purge runbook in
    `README.md` Operations.
  - Added optional `TitleWriteFields`, `BrokerWriteFields`, and
    `AppraisalWriteFields` parameters, wired to `WRITE_FIELDS_*` env vars. The
    handler rejects out-of-list fields with `403` before enqueue and fails closed
    when a configured list is malformed.
- Resolved the template-size ceiling concretely. `scripts/build.js` now enforces
  CloudFormation's 1,000,000-byte S3-hosted limit and reports whether the build
  needs direct upload or S3. `deploy.sh` still deploys small templates directly;
  above 51,200 bytes it creates/reuses `ARTIFACT_BUCKET` and passes
  `--s3-bucket`, so the committed template is no longer capped at 51,200 bytes.
  The generated template is 64,264 bytes. Direct console upload is documented as
  unsupported at this size; the installer or an S3 URL is required.
- Updated `README.md`, `agents.md`, `llms.txt`, `index.html`, `todo.md`, and the
  portal endpoint list. Document/condition data paths, upload credential handling,
  allowlists, and the DLQ alarm/purge procedure are documented.
- Local verification: `npm run build` produced 64,264 bytes; `npm test` passed
  63/63, including contract tests for document reads, upload initiation plus a
  real pre-signed PUT, condition read/respond with a subsequent read, allowlist
  rejection/fail-closed behavior, and template guards for the alarm, allowlists,
  and S3-hosted size. `bash -n deploy.sh` passed.
- No AWS or live Encompass validation is claimed: there is no AWS account, CLI,
  or Encompass tenant on this machine. Pending at this entry: commit, push,
  exact-SHA CI, Pages rebuild, and raw artifact checks.

## 2026-11-06 — Broker document/condition production verification

- Pushed feature commit `33f237d95c3c993193a33e406175a8d997f42328`
  (`feat: add broker documents, uploads, and conditions`) to `main`.
- CI run `42307486735` completed successfully on that exact SHA for Node 20 and
  Node 24 (`verify (20)` and `verify (24)` both succeeded).
- GitHub Pages rebuilt for the exact SHA; the latest build reported `built`
  (created `2026-11-06T22:48:51Z`).
- Raw `main` matched local bytes for `README.md` (22,225), `todo.md` (15,048),
  `history.md` (31,282), `llms.txt` (8,588), and `template.yaml` (64,264).
- The live page returned HTTP 200 with `text/html; charset=utf-8` and HSTS
  `max-age=31556952`; live `index.html` was byte-identical at 27,312 bytes.
- Not verified: an actual CloudFormation deployment (including `--s3-bucket`
  upload and bucket creation), API Gateway key provisioning, and live Encompass
  document/upload/condition behavior. The local fake proves contract shape and
  routing only. The template-size path is proven locally by the 64,264-byte
  artifact and the guarded `--s3-bucket` branch, not by an AWS run.
- This verification entry is itself a docs-only follow-up commit; its own CI,
  Pages, raw `history.md`/`todo.md`, clean-worktree, and cleanup checks are
  reported in the delivery response.

## 2026-11-06 — Attachment download and top-priority broker workflow

- Reprioritized the backlog on user direction: loan-file document listing,
  upload, download, and condition read/respond are the primary use case and now
  sit at the top of `todo.md`, above all P1/P2 and deferred work.
- Verified the official V3 download contract from Developer Connect and the
  published Postman collection. `POST
  /encompass/v3/loans/{loanId}/attachmentDownloadUrl` takes
  `{"attachments":["ATTACHMENT_ID"]}` (the official Postman example) and
  returns an array of `{ id, url, authorizationHeader?, contentType?, ... }`.
  The caller GETs `url` with `Authorization: <authorizationHeader>` when present.
- Added `POST /v1/loans/{id}/attachmentDownloadUrl` with tenant/persona auth, a
  10 KB body cap, 1–20 attachment ids, strict id validation, and the normal
  upstream error mapping. The response is `{ loanId, downloads: [...] }` with
  the upstream download objects unchanged.
- Extended the fake with stored attachment bytes and a pre-signed
  `GET /download/{id}` target that requires the returned authorization header.
  Tests cover initiation, a real byte download, wrong-header rejection,
  validation, inactive tenants, and an e2e upload → download round trip. 66/66
  tests pass; the template is 66,120 bytes.
- Updated `README.md`, `agents.md`, `llms.txt`, `index.html`, the portal endpoint
  list, `todo.md`, and this history. AWS deployment and live Encompass behavior
  remain unverified.
- This entry was written before the push; exact-SHA CI, Pages, raw bytes, and the
  clean-worktree check are reported in the delivery response.

## 2026-11-06 — Attachment download production verification

- Pushed feature commit `dc2732ce9cfa9dfad20eb6772eb56d7ba426db37`
  (`feat: add attachment downloads and prioritize the broker document flow`).
- CI run `42308902340` completed successfully on that exact SHA for Node 20 and
  Node 24 (`verify (20)` and `verify (24)` both succeeded).
- GitHub Pages rebuilt for the exact SHA; the latest build reported `built`
  (created `2026-11-06T23:00:52Z`).
- Raw `main` matched local bytes for `README.md` (23,327), `todo.md` (15,972),
  `history.md` (34,265), `llms.txt` (8,980), and `template.yaml` (66,120).
- The live page returned HTTP 200; live `index.html` was byte-identical at
  27,783 bytes.
- Not verified: an actual CloudFormation deployment and live Encompass download
  behavior (URL shape, authorization header, cloud versus media storage). The
  local fake proves gateway routing, validation, auth, and byte transfer only.
- This verification entry is itself a docs-only follow-up commit; its own CI,
  Pages, raw `history.md`/`todo.md`, clean-worktree, and cleanup checks are
  reported in the delivery response.

## 2026-11-06 — Request-ID correlation and operational alarms

- Completed the highest unblocked P1: end-to-end request-ID correlation. API
  Gateway request IDs (or a generated UUID fallback) now appear in every HTTP
  response as `x-request-id`, on every write-job record, in the SQS message, in
  `GET /v1/jobs/{id}`, and on every Lambda log line.
- Used `AsyncLocalStorage` so existing operation logs inherit the request ID
  without threading a parameter through every helper. Worker logs use the job's
  originating request ID; older queued messages fall back to the SQS message ID.
- Added metadata-only API Gateway access logging to
  `/aws/apigateway/<stack>-access`. The JSON format records request ID, source IP,
  request time, method, resource path, status, response length, and API key ID —
  no query strings, headers, bodies, field values, or credentials.
- Added the account-wide `ApiGatewayCloudWatchRole`/`ApiGatewayAccount`, plus
  `GatewayErrorsAlarm` and `Api5xxAlarm` publishing to the existing
  `OpsAlertTopic`. The format and alarms are guarded by template tests.
- Local verification: `npm run build` produced 69,757 bytes; `npm test` passed
  68/68, including a test that asserts the same request ID on the response,
  accepted job, queue message, job record, job status, and every worker log
  line. E2E also checks the response header and job-status correlation.
- Updated `README.md`, `agents.md`, `llms.txt`, `index.html`, `todo.md`, and this
  history. Not deployed to AWS, so access-log delivery and alarm firing remain
  unverified.
- This entry was written before the push; exact-SHA CI, Pages, raw bytes, and the
  clean-worktree check are reported in the delivery response.

## 2026-11-06 — Request-ID correlation production verification

- Pushed feature commit `f560219e771269f5d5d3a2884ab4a8ad394f9ff8`
  (`feat: correlate request IDs and add operational alarms`).
- CI run `42329139278` completed successfully on that exact SHA for Node 20 and
  Node 24 (`verify (20)` and `verify (24)` both succeeded).
- GitHub Pages rebuilt for the exact SHA; the latest build reported `built`
  (created `2026-11-07T02:25:01Z`).
- Raw `main` matched local bytes for `README.md` (24,843), `todo.md` (16,426),
  `history.md` (37,116), `llms.txt` (9,480), and `template.yaml` (69,757).
- The live page returned HTTP 200; live `index.html` was byte-identical at
  28,084 bytes.
- Not verified: an actual CloudFormation deployment, API Gateway access-log
  delivery, CloudWatch alarm firing, and live Encompass behavior. Local tests
  prove response headers, job/queue/log propagation, template wiring, and the
  metadata-only format only.
- This verification entry is itself a docs-only follow-up commit; its own CI,
  Pages, raw `history.md`/`todo.md`, clean-worktree, and cleanup checks are
  reported in the delivery response.

## 2026-11-07 — Portal key minting and invite/key lifecycle

- Completed the portal key-minting P1. `POST /portal` is throttled at the stage to
  1 request/second with a burst of 2, and the throttle is asserted in the template
  tests.
- Added a dedicated `ProvisioningTable` for idempotency metadata. Provisioning is
  keyed by a SHA-256 hash of normalized role + company + email; a conditional
  DynamoDB claim blocks concurrent double-mints. Pending claims expire after 15
  minutes; completed records expire after 24 hours. No plaintext API key is
  persisted.
- A repeat submission returns the same key through API Gateway
  `GetApiKey(includeValue=true)` with `reused: true`. A pending claim returns
  `409 PROVISIONING_IN_PROGRESS`; a disabled, missing, or unmapped key returns
  `409` instead of minting a duplicate.
- Partial failure rollback: if tenant mapping fails after key creation, the
  handler removes the usage-plan association, deletes the key, and releases the
  claim. If key deletion fails it logs `API_KEY_ORPHANED` and leaves the claim in
  place to fail closed. IAM now covers the required DynamoDB delete and API
  Gateway get/remove/delete operations.
- Added `SECURITY.md` with private vulnerability reporting through GitHub security
  advisories, invite rotation, key disable/delete, compromise response, and orphan
  cleanup. Invites remain shared per role and are not single-use.
- Updated `README.md`, `agents.md`, `llms.txt`, `index.html`, `todo.md`, and this
  history with the lifecycle and verification limits.
- Local verification: `npm run verify` reported the committed template up to date
  at 78,196 bytes and 74/74 tests passing. Tests cover idempotent repeats,
  concurrent-claim rejection, rollback cleanup, disabled-key rejection, throttle
  wiring, and SECURITY.md/static links. No AWS or live Encompass access was used.
- This entry was written before the push; exact-SHA CI, Pages, raw bytes, and the
  clean-worktree check are reported in the delivery response.

## 2026-11-07 — Portal key lifecycle production verification

- Pushed feature commit `cb47ed99b02b1bb210c7ee0a671672000bd8b955`
  (`feat: protect portal key minting and lifecycle`).
- CI run `42330287575` completed successfully on that exact SHA for Node 20 and
  Node 24 (`verify (20)` and `verify (24)` both succeeded).
- GitHub Pages build `1347960125` reported `built` for the exact SHA.
- Raw artifacts at the exact SHA matched the local files: `README.md` 28,038
  bytes, `todo.md` 17,296, `history.md` 40,275, `llms.txt` 10,587,
  `template.yaml` 78,196, `index.html` 28,557, and `SECURITY.md` 4,839.
- The live page returned HTTP 200 and was byte-identical to `index.html` at
  28,557 bytes.
- Not verified: an actual CloudFormation deployment, API Gateway stage throttle
  enforcement, `GetApiKey` recovery, DynamoDB conditional-claim behavior, and
  live key/usage-plan deletion. Local tests and template assertions cover the
  handler logic, rollback paths, and wiring only.
- This verification entry is itself a docs-only follow-up commit; its own CI,
  Pages build, raw/live bytes, clean worktree, and cleanup checks are reported in
  the delivery response.

## 2026-11-07 — Deploy supply-chain hardening and IaC scanning

- Completed the deploy-hardening P1. `deploy.sh` pins `template.yaml` to the
  `v0.1.0` release tag and verifies SHA-256
  `af75648d5a2382385dbad879076b7965526c6ce6698ca8f3a67ba4c3228e81fe`.
  The tag is only a locator; the digest is the integrity anchor, so a moved or
  mistyped tag fails closed.
- Secret handling no longer exposes material in CLI arguments. The Encompass
  client secret and role invite codes are written by `jq` in a subshell to a
  `0600` temporary JSON parameter file and passed as `--parameter-overrides
  file://...`; an EXIT trap removes the template and parameter files. `jq` and
  `sha256sum` are required checks.
- Added a dedicated CI `iac` job with pinned `cfn-lint==1.60.0` and
  `checkov==3.4.3`. `.checkov.yaml` records 11 documented architecture
  exceptions: AWS-managed keys instead of customer CMKs, SSE-SQS, no VPC/NAT,
  public invite/health routes, tenant-scoped no-cache, no X-Ray, and the Lambda
  DLQ/environment/concurrency choices.
- Fixed the real low-cost findings instead of skipping them: DynamoDB PITR on
  all four tables, SNS topic encryption with `alias/aws/sns`, and removal of the
  redundant `ApiDeployment` stage dependency that cfn-lint reported as W3005.
- Local verification: `npm run verify` passed 77/77 tests with the template in
  sync at 78,534 bytes; `cfn-lint template.yaml` exited 0; Checkov exited 0 with
  28 passed and 0 failed; `bash -n deploy.sh` and `git diff --check` were clean.
- Updated `README.md`, `agents.md`, `llms.txt`, `index.html`, `SECURITY.md`,
  `todo.md`, and this history for the release-tag pin, scanner policy, PITR/SNS
  controls, and new template size. No AWS or Encompass access was used; live
  deployment, KMS/PITR behavior, and CloudShell tag resolution remain
  unverified until the release is pushed and fetched.

## 2026-11-07 — Deploy hardening production verification

- Pushed implementation commit `3dd8feac946469374cdaebcc7fbc7d9f8c4d72e0`
  (`feat: harden deploy supply chain and IaC scanning`).
- CI run `42331446994` completed successfully on that exact SHA: `verify (20)`,
  `verify (24)`, and the new `iac` job all succeeded.
- GitHub Pages build `1347985079` reported `built` for the exact SHA.
- Raw artifacts at the exact SHA matched the local files: `README.md` 28,943
  bytes, `todo.md` 18,363, `history.md` 43,332, `llms.txt` 10,958,
  `template.yaml` 78,534 (SHA-256
  `af75648d5a2382385dbad879076b7965526c6ce6698ca8f3a67ba4c3228e81fe`),
  `index.html` 28,724, `SECURITY.md` 5,867, `deploy.sh` 9,115,
  `.checkov.yaml` 2,677, and `agents.md` 14,589.
- The live page returned HTTP 200 and was byte-identical to `index.html` at
  28,724 bytes; live `llms.txt` matched at 10,958 bytes.
- Cleanup: removed `/tmp/iac-scan-venv` and scanner logs; no `node --test`,
  dev-server, `cfn-lint`, or Checkov processes remained; no
  `node_modules`/`dist`/`build`/`*.log` artifacts were present; the worktree was
  clean before this docs entry.
- Not verified: an actual CloudFormation deployment, DynamoDB PITR/KMS/SNS
  behavior, and live Encompass traffic. CloudShell tag resolution is checked
  after the `v0.1.0` tag is created in the delivery step.
- This verification entry is itself a docs-only follow-up commit; its own CI,
  Pages build, raw/live bytes, tag fetch, and clean-worktree checks are reported
  in the delivery response.

## 2026-11-07 — Final MVP completeness audit

- Recovered the deleted AI Studio dev doc from `6465eb1^` and derived the MVP
  requirements from its architecture, API samples, reference handler, deployment
  section, and verification rules. Audited them against `src/gateway.js`,
  `template.yaml`, the handler/e2e/template tests, `deploy.sh`, and CI instead of
  relying on the project's own summaries.
- Fixed three real inconsistencies found by the audit:
  - Loan reads now project from either a flat Encompass response or a nested
    `fields` object, then return the documented `{ id, fields, _cached }` shape.
    Added a regression test that makes the fake return nested fields.
  - Condition `PATCH` now rejects retrieve-only `status`, `statusDate`, and
    `statusOpen` with `400`; `tracking` and `internalDescription` remain
    writeable. Added a regression test covering all three fields.
  - The portal no longer claims an idempotently recoverable key will never be
    shown again; it states that plaintext is never stored and repeats recover it.
- Recorded deliberate non-gaps: the dev doc's "exponential backoff" is provided
  by the AWS SQS event source's native retry backoff with `maxReceiveCount: 5`;
  reads stay `private` because responses are tenant-scoped; and event-source
  concurrency remains 5, stricter than the diagram's 10.
- Local evidence: `npm run verify` passed 79/79 with the template in sync at
  78,986 bytes (SHA-256
  `4e62005bcf5b85468c8d1ce75c6416493b80b50b8f4caa953a72c7fba766384e`);
  `bash -n deploy.sh` and `git diff --check` exited 0; `cfn-lint` exited 0;
  Checkov 3.4.3 passed 28 and failed 0 with the documented policy.
- Updated `README.md`, `agents.md`, `llms.txt`, `index.html`, `todo.md`, and the
  `deploy.sh` template pin. `template.yaml` was regenerated by `npm run build`,
  not hand-edited. Live AWS deployment and live Encompass contracts remain
  BLOCKED; they are not claimed as verified.
- Pending at this entry: commit, push, exact-SHA CI/Pages checks, tag move, and
  raw/live artifact verification.

## 2026-11-07 — MVP audit delivery verification

- Pushed the audit fix commit `c72904609bb5942d6a7633f7373cbf70be07c060`.
- CI run `42332484211` completed successfully on that exact SHA for
  `verify (20)`, `verify (24)`, and `iac`.
- GitHub Pages build `1348007904` reported `built` for that exact SHA.
- Every commit-pinned raw artifact matched locally byte-for-byte: `README.md`,
  `todo.md`, `history.md`, `agents.md`, `llms.txt`, `template.yaml` (78,986
  bytes, SHA-256
  `4e62005bcf5b85468c8d1ce75c6416493b80b50b8f4caa953a72c7fba766384e`),
  `index.html`, `SECURITY.md`, `deploy.sh`, and `.checkov.yaml`.
- This verification entry is itself a docs-only follow-up commit. Its own
  CI/Pages, live bytes, and the moved `v0.1.0` tag fetch are reported in the
  delivery response; no template or code changed after the verified fix commit.

## 2026-11-07 — MVP closed

**MVP implementation complete.** All locally verifiable dev-doc MVP requirements
are implemented and checked against the code, handler tests, template, deploy
script, and CI. Live AWS deployment and live Encompass contract checks remain
BLOCKED by missing credentials and are not claimed.

- Final verified delivery before this status commit:
  `c032f7c2fe89776357f87e62b99d0fb4db5a7406` — CI run `42332580962` green on
  `verify (20)`, `verify (24)`, and `iac`; Pages build `1348009756` built for
  the exact SHA; live `index.html` and `llms.txt` matched byte-for-byte; all ten
  raw artifacts matched; `v0.1.0` was moved to it.
- This closeout entry is a docs-only follow-up. Its own CI/Pages and live/raw
  checks are reported in the delivery response. No code or template changed.

## 2026-11-07 — Broker loan lifecycle extension

- Added synchronous native lifecycle routes while leaving the existing async
  flat-field `PATCH /v1/loans/{id}` unchanged:
  - `POST /v1/loans` for a full V3 `LoanContract`; requires `loanFolder`, defaults
    `view=id`, allows up to 1 MB, and extracts the loan ID from the native body or
    `Location` header.
  - `PATCH /v1/loans/{id}/application` for chunked V3 contract updates.
  - `GET /v1/loans/{id}/milestones` and
    `PATCH /v1/loans/{id}/milestones/{milestoneId}?action=finish|unfinish` for
    Submittal and Resubmittal.
  - `POST /v1/loans/{id}/documents` for document creation; bytes still use the
    existing pre-signed upload flow.
  - Enhanced-condition create and document list/associate routes.
  - Standard V1 condition read/create/manage and document association routes for
    `underwriting`, `preliminary`, and `postclosing` sets.
- Extended the fake with loan-create/update, milestone, document-create,
  enhanced-condition-create/document, and standard-condition state. Added
  handler tests and a real-HTTP broker lifecycle test covering full registration,
  chunked update, Submittal/Resubmittal, document create/upload, enhanced
  condition evidence and satisfaction, prior-to-funding standard conditions, and
  post-closing conditions.
- Local evidence: focused handler + e2e tests pass; full gate is reported in the
  delivery response. Template regenerated at 101,034 bytes (SHA-256
  `9f0323b8f2f7d6a6bf94481ae97e538f6e094789f4f9d3ac2a0122ada4dabab5`).
- Updated `README.md`, `llms.txt`, `index.html`, `agents.md`, `todo.md`, the
  template route guards, `package.json` (0.2.0), and the `deploy.sh` tag/digest.
- Live AWS deployment and live Encompass lifecycle contracts remain BLOCKED and
  are not claimed. Commit, push, CI, Pages, tag, and raw/live verification are
  pending for this entry.
