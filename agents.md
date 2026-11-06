# agents.md — Operating Manual

## Mission

A lean, stateless Encompass passthrough gateway that runs in the lender's AWS account:
field-filtered synchronous reads, asynchronous FIFO writes with retries, a
role-scoped self-serve onboarding portal, and field schema discovery. It must
never store loan data.

Source of truth for scope: `chat-encompass-api-middleware-gatew-google-ai-studio-2026-11-06-1454.md`.

## Non-negotiable principles

1. **YAGNI.** Build only what the dev doc requires. No loan mirror, no sync engine,
   no webhook receiver, no multi-region, no UI framework until a real requirement
   exists. If a feature is not in `todo.md`, do not add it.
2. **Prefer the smallest solution.** One Lambda handler, one table per concern,
   zero npm runtime dependencies, one-line fixes where one line works. Do not
   introduce a library for something the platform already does.
3. **Clean up the dev environment.** This machine has limited memory. Stop every
   server/process you start, remove temp files and logs, and avoid installing
   dependencies unless a task genuinely needs them. Before finishing a task verify
   with `ps -eo pid,args | grep -E "node --test|dev/server"` (expect none) and
   `git status`.
4. **Never backtrack.** `history.md` is append-only. If a decision changes, append
   a new dated entry that supersedes the old one; never rewrite history. Tick items
   in `todo.md`; never delete them. Revert only a change made in the current task.
5. **Honest verification.** Local fakes are not Encompass and not AWS. Report what
   was tested, what could not be tested, and what remains blocked.
6. **Stateless by default.** Cache tokens, job status, and 30-second read
   projections only. Never persist loan payloads.

## Repo map

| Path | Purpose |
| --- | --- |
| `src/gateway.js` | The entire deployed Lambda: portal, reads, write enqueue, job status, SQS worker. Self-contained. |
| `infra/template.yaml` | CloudFormation source with a `//__GATEWAY_CODE__` placeholder. |
| `template.yaml` | Generated, committed deployable template. Never edit by hand. |
| `scripts/build.js` | Inlines the handler into the template, enforces the 51,200-byte direct-upload limit, supports `--check`. |
| `deploy.sh` | One-line AWS CloudShell deployment; fetches the committed template and deploys the stack. |
| `dev/fake-encompass.js` | Local fake OAuth + loans + standard/custom field schema upstream, including 423 lock simulation. |
| `dev/memory-store.js` | In-memory storage/queue adapter for local runs. Never deployed. |
| `dev/server.js` | Local API Gateway + SQS emulator around the real handler. |
| `test/*.test.js` | Unit, end-to-end HTTP, and template tests (Node built-in runner). |
| `.github/workflows/ci.yml` | Runs tests and template-sync check on push/PR. |

## Commands

```bash
npm run build     # regenerate template.yaml from infra + src
npm test          # 41 tests: unit, HTTP e2e, template guards
npm run verify    # build --check + npm test (use before committing)
npm run dev       # local gateway at :3000 with fake Encompass
```

## Conventions

- Node.js, CommonJS, no dependencies. The Lambda runtime (nodejs24.x) supplies AWS SDK v3.
  Local tooling and tests run on Node 20+; CI covers 20 and 24.
- `src/gateway.js` exports `handler` (lazy AWS store) and
  `createHandler({ store, env, fetchImpl, now })` for tests.
- Storage interface: `getSecret`, `getTenant`, `putTenant`, `getToken`,
  `putToken`, `getJob`, `putJob`, `enqueueWrite`, `createApiKey`.
- Structured logs only: `log(level, ACTION, details)` → single-line JSON with
  `timestamp`, `level`, `action`. Never log tokens, secrets, API keys, or full
  upstream error bodies.
- Error responses are always `{ "error": "message", ...optionalCode }`.
- API responses are `Cache-Control: no-store` except reads, which use
  `private, max-age=30` (never `public`: responses are tenant-scoped by API key).
- Reads project only requested fields and cap field lists at 100.
- `/v1/fields` splits standard (`CX.`/`CUSTnnFV` excluded) and custom IDs, calls
  `schemas/loan/standardFields` and `settings/loan/customFields`, and normalizes
  results to `{ id: { description, type } }`. Cache per persona + field set for
  5 minutes; never cache across personas.
- Writes return `202` with a job ID; the SQS event source re-drives retryable
  Encompass failures (423/429/5xx) up to 5 attempts, then marks the job FAILED.
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
- API key plaintext is returned once by the portal and never stored.
- The Encompass client secret lives in Secrets Manager; DynamoDB uses SSE.
- Tenant resolution is always `requestContext.identity.apiKeyId` (never a
  client-supplied tenant ID), and job reads enforce tenant ownership.
- Gateway IAM is scoped to the three tables, two queues, one secret, and only
  `apigateway:POST` for key provisioning.

## Workflow

1. Read `todo.md`; pick the next unchecked item.
2. Make the smallest change that completes it, with a test.
3. `npm run build` if `src/gateway.js` or `infra/template.yaml` changed.
4. `npm run verify`; fix causes, never weaken assertions.
5. Update `todo.md` (tick it) and append to `history.md` (what changed, evidence).
6. Commit. Push only when the user asks.

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
  (`.github/workflows/ci.yml`) and by fetching the raw `template.yaml` from
  GitHub, which is exactly what `deploy.sh` downloads.
- `scripts/build.js` compacts only the inlined deploy copy (leading indentation
  and blank lines) to keep the single-file template under 51,200 bytes. Keep the
  source formatted; do not hand-edit `template.yaml`.
- To verify for real: run `deploy.sh` in AWS CloudShell, open one printed role
  invite link, provision a key, then `GET /health`, `GET /v1/fields?ids=...`,
  `GET /v1/loans/{id}?fields=...`, `PATCH /v1/loans/{id}`, and poll
  `GET /v1/jobs/{id}`. Repeat with a mismatched role link to confirm rejection.
