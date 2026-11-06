"use strict";

const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const { createHandler, _resetReadCache } = require("../src/gateway");
const { createMemoryStore } = require("../dev/memory-store");
const { startFakeEncompass } = require("../dev/fake-encompass");

const INVITES = {
  title: "title-invite-0123456789abcdef",
  broker: "broker-invite-0123456789abcdef",
  appraisal: "appraisal-invite-0123456789abcdef",
};

let fake;
let store;
let handler;

const httpEvent = ({ method = "GET", path, query = null, body = null, apiKeyId = "key-1", headers = {} }) => ({
  httpMethod: method,
  path,
  queryStringParameters: query,
  headers,
  body: body === null ? null : JSON.stringify(body),
  requestContext: { requestId: "request-1", identity: apiKeyId ? { apiKeyId } : {} },
});

const parse = (response) => JSON.parse(response.body);

const queueEvent = (message, attempts = 1) => ({
  Records: [
    {
      messageId: `message-${attempts}`,
      eventSource: "aws:sqs",
      body: JSON.stringify(message),
      attributes: { ApproximateReceiveCount: String(attempts) },
    },
  ],
});

const enqueue = (loanId = "loan-1", fields = { 1109: 500000 }) =>
  handler(httpEvent({ method: "PATCH", path: `/v1/loans/${loanId}`, body: { fields } }));

const provision = (overrides = {}) =>
  handler(
    httpEvent({
      method: "POST",
      path: "/portal",
      body: {
        tenantName: "Acme Title",
        email: "dev@acme.test",
        role: "title",
        code: INVITES.title,
        ...overrides,
      },
    }),
  );

beforeEach(async () => {
  fake = await startFakeEncompass({
    loans: {
      "loan-1": { 11: "123 Main St", 12: "Irvine", 14: "CA", 1109: 450000, "CX.TITLE.STATUS": "Received" },
      "loan-2": { 11: "9 Oak Ave", 12: "Austin", 14: "TX", 1109: 310000 },
    },
  });
  store = createMemoryStore();
  _resetReadCache();
  handler = createHandler({
    store,
    env: {
      ENCOMPASS_BASE_URL: fake.url,
      INVITE_TITLE: INVITES.title,
      PERSONA_TITLE: "api_title_template",
      INVITE_BROKER: INVITES.broker,
      PERSONA_BROKER: "api_broker_template",
      INVITE_APPRAISAL: INVITES.appraisal,
      PERSONA_APPRAISAL: "api_appraisal_template",
      UPSTREAM_TIMEOUT_MS: "3000",
    },
  });
  await store.putTenant({
    apiKeyId: "key-1",
    tenantName: "Acme Title",
    encompassUserId: "persona-1",
    role: "title",
    email: "dev@acme.test",
    status: "ACTIVE",
  });
});

afterEach(async () => {
  await fake.close();
});

test("GET /health is unauthenticated", async () => {
  const response = await handler(httpEvent({ path: "/health", apiKeyId: null }));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(parse(response), { status: "ok" });
});

test("GET loan returns only the requested fields", async () => {
  const response = await handler(httpEvent({ path: "/v1/loans/loan-1", query: { fields: "11,12,1109" } }));
  assert.equal(response.statusCode, 200);

  const body = parse(response);
  assert.equal(body.id, "loan-1");
  assert.deepEqual(Object.keys(body.fields).sort(), ["11", "1109", "12"]);
  assert.equal(body._cached, false);
  assert.equal(fake.state.tokenExchanges, 1);
});

test("second read within the TTL is served from the container cache", async () => {
  const first = await handler(httpEvent({ path: "/v1/loans/loan-1", query: { fields: "11,12" } }));
  const second = await handler(httpEvent({ path: "/v1/loans/loan-1", query: { fields: "11,12" } }));

  assert.equal(parse(first)._cached, false);
  assert.equal(parse(second)._cached, true);
  assert.equal(fake.state.reads, 1);
  assert.equal(fake.state.tokenExchanges, 1);
});

test("scoped token is reused across loans for the same persona", async () => {
  await handler(httpEvent({ path: "/v1/loans/loan-1" }));
  await handler(httpEvent({ path: "/v1/loans/loan-2" }));

  assert.equal(fake.state.reads, 2);
  assert.equal(fake.state.tokenExchanges, 1);
});

test("expired cached token triggers a new token exchange", async () => {
  await handler(httpEvent({ path: "/v1/loans/loan-1" }));
  await store.putToken({ encompassUserId: "persona-1", accessToken: "stale", expiresAt: 1 });
  const response = await handler(httpEvent({ path: "/v1/loans/loan-2" }));

  assert.equal(response.statusCode, 200);
  assert.equal(fake.state.tokenExchanges, 2);
});

test("unknown API key mapping is rejected", async () => {
  const response = await handler(httpEvent({ path: "/v1/loans/loan-1", apiKeyId: "key-unknown" }));
  assert.equal(response.statusCode, 403);
  assert.equal(parse(response).error, "Unauthorized tenant mapping");
});

test("missing API key is rejected", async () => {
  const response = await handler(httpEvent({ path: "/v1/loans/loan-1", apiKeyId: null }));
  assert.equal(response.statusCode, 403);
});

test("rejects malformed field lists", async () => {
  const response = await handler(httpEvent({ path: "/v1/loans/loan-1", query: { fields: "11,12;DROP" } }));
  assert.equal(response.statusCode, 400);
});

test("propagates loan not found", async () => {
  const response = await handler(httpEvent({ path: "/v1/loans/missing" }));
  assert.equal(response.statusCode, 404);
});

test("GET /v1/fields resolves standard and custom definitions", async () => {
  const response = await handler(httpEvent({ path: "/v1/fields", query: { ids: "11,646,CX.TITLE.STATUS" } }));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(parse(response), {
    11: { description: "Subject Property Address", type: "STRING" },
    646: { description: "Title - Lender Title Insurance", type: "DECIMAL" },
    "CX.TITLE.STATUS": { description: "Custom Title Milestone Status", type: "STRING" },
  });
  assert.equal(fake.state.standardSchemaCalls, 1);
  assert.equal(fake.state.customSchemaCalls, 1);
});

test("field schema exposes writeability metadata", async () => {
  const response = await handler(httpEvent({ path: "/v1/fields", query: { ids: "1393" } }));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(parse(response), {
    1393: { description: "Active Milestone", type: "STRING", readOnly: true, fieldLock: true },
  });
});

test("field definitions are cached per persona and field set", async () => {
  await handler(httpEvent({ path: "/v1/fields", query: { ids: "11,646" } }));
  const response = await handler(httpEvent({ path: "/v1/fields", query: { ids: "11,646" } }));

  assert.equal(response.statusCode, 200);
  assert.equal(fake.state.standardSchemaCalls, 1);
  assert.equal(fake.state.customSchemaCalls, 0);
});

test("field schema requires valid ids", async () => {
  assert.equal((await handler(httpEvent({ path: "/v1/fields" }))).statusCode, 400);
  assert.equal((await handler(httpEvent({ path: "/v1/fields", query: { ids: "11;DROP" } }))).statusCode, 400);

  const tooMany = Array.from({ length: 101 }, (_, index) => String(index + 1)).join(",");
  assert.equal((await handler(httpEvent({ path: "/v1/fields", query: { ids: tooMany } }))).statusCode, 400);
});

test("field schema is tenant-scoped and maps upstream failures", async () => {
  const unknown = await handler(httpEvent({ path: "/v1/fields", query: { ids: "11" }, apiKeyId: "key-unknown" }));
  assert.equal(unknown.statusCode, 403);

  fake.state.schemaFailure = 500;
  const failed = await handler(httpEvent({ path: "/v1/fields", query: { ids: "11" } }));
  assert.equal(failed.statusCode, 502);
});

test("field schema returns 404 when nothing matches", async () => {
  const response = await handler(httpEvent({ path: "/v1/fields", query: { ids: "999999" } }));
  assert.equal(response.statusCode, 404);
});

test("PATCH enqueues a job and returns 202", async () => {
  const response = await enqueue();
  assert.equal(response.statusCode, 202);

  const job = parse(response);
  assert.equal(job.status, "ACCEPTED");
  assert.equal(job.loanId, "loan-1");
  assert.match(job.jobId, /^job_/);
  assert.equal(job.statusUrl, `/v1/jobs/${job.jobId}`);
  assert.equal(store.queue.length, 1);
  assert.equal(store.queue[0].loanId, "loan-1");
  assert.deepEqual(store.queue[0].fields, { 1109: 500000 });

  const status = await handler(httpEvent({ path: `/v1/jobs/${job.jobId}` }));
  assert.equal(status.statusCode, 200);
  assert.equal(parse(status).status, "PENDING");
});

test("PATCH validates the fields payload", async () => {
  const missing = await handler(httpEvent({ method: "PATCH", path: "/v1/loans/loan-1", body: {} }));
  assert.equal(missing.statusCode, 400);

  const empty = await enqueue("loan-1", {});
  assert.equal(empty.statusCode, 400);

  const nested = await enqueue("loan-1", { 1109: { amount: 1 } });
  assert.equal(nested.statusCode, 400);
});

test("PATCH rejects invalid JSON", async () => {
  const response = await handler({
    ...httpEvent({ method: "PATCH", path: "/v1/loans/loan-1" }),
    body: "{not-json",
  });
  assert.equal(response.statusCode, 400);
});

test("worker completes an enqueued write", async () => {
  const { jobId } = parse(await enqueue("loan-1", { 1109: 525000 }));
  const message = store.queue.pop();

  const result = await handler(queueEvent(message, 1));
  assert.deepEqual(result.batchItemFailures, []);
  assert.equal(fake.state.loans.get("loan-1")[1109], 525000);

  const job = await handler(httpEvent({ path: `/v1/jobs/${jobId}` }));
  assert.equal(parse(job).status, "COMPLETED");
  assert.equal(parse(job).attempts, 1);
});

test("worker retries Encompass file locks and then completes", async () => {
  fake.state.lockRemaining.set("loan-1", 2);
  const { jobId } = parse(await enqueue("loan-1", { 1109: 480000 }));
  const message = store.queue.pop();

  const first = await handler(queueEvent(message, 1));
  assert.equal(first.batchItemFailures.length, 1);
  let job = parse(await handler(httpEvent({ path: `/v1/jobs/${jobId}` })));
  assert.equal(job.status, "RETRYING");
  assert.equal(job.attempts, 1);

  const second = await handler(queueEvent(message, 2));
  assert.equal(second.batchItemFailures.length, 1);

  const third = await handler(queueEvent(message, 3));
  assert.deepEqual(third.batchItemFailures, []);
  job = parse(await handler(httpEvent({ path: `/v1/jobs/${jobId}` })));
  assert.equal(job.status, "COMPLETED");
  assert.equal(job.attempts, 3);
  assert.equal(fake.state.loans.get("loan-1")[1109], 480000);
});

test("worker fails permanently on a non-retryable Encompass error", async () => {
  const { jobId } = parse(await enqueue("missing-loan", { 1109: 1 }));
  const message = store.queue.pop();

  const result = await handler(queueEvent(message, 1));
  assert.deepEqual(result.batchItemFailures, []);

  const job = parse(await handler(httpEvent({ path: `/v1/jobs/${jobId}` })));
  assert.equal(job.status, "FAILED");
  assert.match(job.error, /404/);
});

test("worker gives up after the maximum number of attempts", async () => {
  fake.state.lockRemaining.set("loan-1", 10);
  const { jobId } = parse(await enqueue("loan-1", { 1109: 1 }));
  const message = store.queue.pop();

  const result = await handler(queueEvent(message, 5));
  assert.deepEqual(result.batchItemFailures, []);

  const job = parse(await handler(httpEvent({ path: `/v1/jobs/${jobId}` })));
  assert.equal(job.status, "FAILED");
  assert.equal(job.attempts, 5);
});

test("inactive tenants are denied across authenticated routes", async () => {
  await store.putTenant({
    apiKeyId: "key-1",
    tenantName: "Acme Title",
    encompassUserId: "persona-1",
    role: "title",
    status: "SUSPENDED",
  });

  for (const request of [
    httpEvent({ path: "/v1/loans/loan-1" }),
    httpEvent({ path: "/v1/fields", query: { ids: "11" } }),
    httpEvent({ method: "PATCH", path: "/v1/loans/loan-1", body: { fields: { 1109: 1 } } }),
    httpEvent({ path: "/v1/jobs/job_missing" }),
    httpEvent({ path: "/v1/loans/loan-1/documents" }),
    httpEvent({ path: "/v1/loans/loan-1/conditions" }),
    httpEvent({ method: "PATCH", path: "/v1/loans/loan-1/conditions", body: [{ id: "condition-1" }] }),
    httpEvent({
      method: "POST",
      path: "/v1/loans/loan-1/attachmentUploadUrl",
      body: { file: { name: "a.pdf", contentType: "application/pdf", size: 1 } },
    }),
  ]) {
    assert.equal((await handler(request)).statusCode, 403);
  }
});

test("PATCH caps fields at 100", async () => {
  const fields = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [String(index + 1), index]));
  assert.equal((await enqueue("loan-1", fields)).statusCode, 400);
});

test("job status is scoped to the requesting tenant", async () => {
  const { jobId } = parse(await enqueue());
  await store.putTenant({ apiKeyId: "key-2", tenantName: "Other", encompassUserId: "persona-2", status: "ACTIVE" });

  const foreign = await handler(httpEvent({ path: `/v1/jobs/${jobId}`, apiKeyId: "key-2" }));
  assert.equal(foreign.statusCode, 404);

  const unknown = await handler(httpEvent({ path: "/v1/jobs/job_missing" }));
  assert.equal(unknown.statusCode, 404);
});

test("portal landing requires an invite link and publishes the field cheat sheet", async () => {
  const response = await handler(httpEvent({ path: "/portal" }));
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Invite link required/);
  assert.match(response.body, /646/);
  assert.match(response.body, /CX\.YOUR\.FIELD/);
  assert.doesNotMatch(response.body, /admin token/i);
});

test("portal renders a persona-locked form for a valid invite", async () => {
  const response = await handler(httpEvent({ path: "/portal", query: { role: "title", code: INVITES.title } }));
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Title \/ Settlement/);
  assert.match(response.body, /api_title_template/);
  assert.match(response.body, /id="email"/);
});

test("portal rejects invalid and role-mismatched invites", async () => {
  const badCode = await handler(httpEvent({ path: "/portal", query: { role: "title", code: "nope" } }));
  assert.equal(badCode.statusCode, 403);
  assert.match(badCode.body, /invalid or has expired/i);

  const mismatch = await provision({ role: "broker", code: INVITES.title });
  assert.equal(mismatch.statusCode, 403);
});

test("portal provisions a persona-locked key via an invite", async () => {
  const response = await provision();
  assert.equal(response.statusCode, 200);

  const body = parse(response);
  assert.equal(body.role, "title");
  assert.equal(body.encompassUserId, "api_title_template");
  assert.ok(body.apiKey);

  const apiKeyId = store.keyIdsByValue.get(body.apiKey);
  assert.ok(apiKeyId);
  const tenant = await store.getTenant(apiKeyId);
  assert.equal(tenant.email, "dev@acme.test");
  assert.equal(tenant.role, "title");
  assert.equal(tenant.encompassUserId, "api_title_template");

  const read = await handler(httpEvent({ path: "/v1/loans/loan-1", apiKeyId }));
  assert.equal(read.statusCode, 200);
});

test("portal validates company name and email", async () => {
  for (const overrides of [
    { tenantName: "" },
    { email: "not-an-email" },
    { email: "" },
  ]) {
    const response = await provision(overrides);
    assert.equal(response.statusCode, 400);
  }
});

test("portal fails closed when the role is not configured", async () => {
  const unconfigured = createHandler({ store, env: { ENCOMPASS_BASE_URL: fake.url } });
  const response = await unconfigured(
    httpEvent({
      method: "POST",
      path: "/portal",
      body: { tenantName: "Acme", email: "dev@acme.test", role: "title", code: INVITES.title },
    }),
  );
  assert.equal(response.statusCode, 403);
});

test("portal serves hardened HTML", async () => {
  const response = await handler(httpEvent({ path: "/portal", query: { role: "title", code: INVITES.title } }));
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.headers["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.match(response.body, /Encompass API Gateway/);
});

test("GET documents returns eFolder documents for the tenant", async () => {
  const response = await handler(httpEvent({ path: "/v1/loans/loan-1/documents", query: { view: "full" } }));
  assert.equal(response.statusCode, 200);

  const body = parse(response);
  assert.equal(body.loanId, "loan-1");
  assert.equal(body.documents.length, 2);
  assert.equal(body.documents[0].attachments[0].fileName, "credit-report.pdf");
  assert.equal(fake.state.documentReads, 1);
});

test("documents query is validated and supports Encompass filters", async () => {
  const active = await handler(
    httpEvent({ path: "/v1/loans/loan-1/documents", query: { requireActiveAttachments: "true" } }),
  );
  assert.equal(active.statusCode, 200);
  assert.deepEqual(parse(active).documents.map((doc) => doc.id), ["doc-1"]);

  assert.equal((await handler(httpEvent({ path: "/v1/loans/loan-1/documents", query: { view: "bogus;drop" } }))).statusCode, 400);
  assert.equal((await handler(httpEvent({ path: "/v1/loans/missing/documents" }))).statusCode, 404);
});

test("attachment upload initiation returns the verified pre-signed contract", async () => {
  const response = await handler(
    httpEvent({
      method: "POST",
      path: "/v1/loans/loan-1/attachmentUploadUrl",
      body: {
        file: { contentType: "application/pdf", name: "returns.pdf", size: 2048 },
        title: "Tax returns",
        assignTo: { entityId: "doc-2", entityType: "Document" },
      },
    }),
  );
  assert.equal(response.statusCode, 200);

  const body = parse(response);
  assert.match(body.attachmentId, /^attachment-/);
  assert.ok(body.authorizationHeader);
  assert.match(body.url, /\/upload\//);
  assert.equal(body.multiChunkRequired, false);
  assert.equal(fake.state.uploadInitiations, 1);
});

test("pre-signed upload attaches the file and a later document read shows it", async () => {
  const initiated = parse(
    await handler(
      httpEvent({
        method: "POST",
        path: "/v1/loans/loan-1/attachmentUploadUrl",
        body: {
          file: { contentType: "application/pdf", name: "returns.pdf", size: 2048 },
          assignTo: { entityId: "doc-2", entityType: "Document" },
        },
      }),
    ),
  );

  const uploaded = await fetch(initiated.url, {
    method: "PUT",
    headers: { Authorization: initiated.authorizationHeader },
    body: Buffer.from("pdf-bytes"),
  });
  assert.equal(uploaded.status, 200);
  assert.equal(fake.state.uploadedBytes, 9);

  const documents = parse(await handler(httpEvent({ path: "/v1/loans/loan-1/documents" }))).documents;
  const target = documents.find((doc) => doc.id === "doc-2");
  assert.equal(target.attachments.length, 1);
  assert.equal(target.attachments[0].fileName, "returns.pdf");
  assert.equal(target.attachments[0].fileSize, 9);
});

test("attachment upload validates the file and assignment", async () => {
  const invalid = [
    {},
    { file: { name: "a.pdf", contentType: "application/pdf" } },
    { file: { name: "", contentType: "application/pdf", size: 1 } },
    { file: { name: "a.pdf", contentType: "pdf", size: 1 } },
    { file: { name: "a.pdf", contentType: "application/pdf", size: -1 } },
    { file: { name: "a.pdf", contentType: "application/pdf", size: 1 }, assignTo: { entityId: "doc-1", entityType: "Loan" } },
  ];
  for (const body of invalid) {
    const response = await handler(httpEvent({ method: "POST", path: "/v1/loans/loan-1/attachmentUploadUrl", body }));
    assert.equal(response.statusCode, 400, JSON.stringify(body));
  }

  const unknownDocument = await handler(
    httpEvent({
      method: "POST",
      path: "/v1/loans/loan-1/attachmentUploadUrl",
      body: {
        file: { name: "a.pdf", contentType: "application/pdf", size: 1 },
        assignTo: { entityId: "doc-missing", entityType: "Document" },
      },
    }),
  );
  assert.equal(unknownDocument.statusCode, 404);
  assert.equal(fake.state.uploadInitiations, 0);
});

test("GET conditions returns enhanced conditions for the tenant", async () => {
  const response = await handler(
    httpEvent({ path: "/v1/loans/loan-1/conditions", query: { conditionType: "Underwriting" } }),
  );
  assert.equal(response.statusCode, 200);

  const body = parse(response);
  assert.equal(body.loanId, "loan-1");
  assert.equal(body.conditions.length, 1);
  assert.equal(body.conditions[0].id, "condition-1");
  assert.equal(body.conditions[0].status, "Requested");
  assert.equal(body.conditions[0].tracking.find((entry) => entry.status === "Received").isChecked, false);
  assert.equal(fake.state.conditionReads, 1);
});

test("condition respond moves the status and a later read proves it", async () => {
  const patch = await handler(
    httpEvent({
      method: "PATCH",
      path: "/v1/loans/loan-1/conditions",
      body: [{ id: "condition-1", tracking: [{ status: "Received", isChecked: true }] }],
    }),
  );
  assert.equal(patch.statusCode, 200);
  assert.deepEqual(parse(patch), { loanId: "loan-1", updated: 1 });
  assert.equal(fake.state.conditionUpdates, 1);

  const after = parse(await handler(httpEvent({ path: "/v1/loans/loan-1/conditions" })));
  assert.equal(after.conditions[0].status, "Received");
  assert.equal(after.conditions[0].statusOpen, true);
  assert.equal(after.conditions[0].tracking.find((entry) => entry.status === "Received").isChecked, true);
});

test("condition update validates the array and maps unknown conditions", async () => {
  const invalid = [
    [],
    {},
    [{ title: "missing id" }],
    [{ id: "bad id!" }],
    Array.from({ length: 21 }, () => ({ id: "condition-1" })),
  ];
  for (const body of invalid) {
    const response = await handler(httpEvent({ method: "PATCH", path: "/v1/loans/loan-1/conditions", body }));
    assert.equal(response.statusCode, 400, JSON.stringify(body));
  }

  const missing = await handler(
    httpEvent({ method: "PATCH", path: "/v1/loans/loan-1/conditions", body: [{ id: "condition-missing" }] }),
  );
  assert.equal(missing.statusCode, 404);
});

test("per-role write allowlist rejects fields outside the role", async () => {
  const restricted = createHandler({
    store,
    env: { ENCOMPASS_BASE_URL: fake.url, WRITE_FIELDS_TITLE: "11,646" },
  });

  const blocked = await restricted(
    httpEvent({ method: "PATCH", path: "/v1/loans/loan-1", body: { fields: { 1109: 1 } } }),
  );
  assert.equal(blocked.statusCode, 403);
  assert.deepEqual(parse(blocked).fields, ["1109"]);
  assert.equal(store.queue.length, 0);

  const allowed = await restricted(
    httpEvent({ method: "PATCH", path: "/v1/loans/loan-1", body: { fields: { 646: 1200 } } }),
  );
  assert.equal(allowed.statusCode, 202);

  const open = createHandler({ store, env: { ENCOMPASS_BASE_URL: fake.url } });
  assert.equal(
    (await open(httpEvent({ method: "PATCH", path: "/v1/loans/loan-1", body: { fields: { 1109: 2 } } }))).statusCode,
    202,
  );
});

test("write allowlist fails closed when malformed", async () => {
  const malformed = createHandler({
    store,
    env: { ENCOMPASS_BASE_URL: fake.url, WRITE_FIELDS_TITLE: "11,not a field" },
  });
  const response = await malformed(
    httpEvent({ method: "PATCH", path: "/v1/loans/loan-1", body: { fields: { 11: "123 Main St" } } }),
  );
  assert.equal(response.statusCode, 403);
});

test("unknown routes return 404 and wrong methods return 405", async () => {
  assert.equal((await handler(httpEvent({ path: "/nope" }))).statusCode, 404);
  assert.equal((await handler(httpEvent({ method: "POST", path: "/v1/loans/loan-1" }))).statusCode, 405);
  assert.equal((await handler(httpEvent({ method: "PUT", path: "/portal" }))).statusCode, 405);
  assert.equal((await handler(httpEvent({ method: "POST", path: "/v1/fields" }))).statusCode, 405);
});
