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
