"use strict";

const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const { createHandler, _resetReadCache } = require("../src/gateway");
const { createMemoryStore } = require("../dev/memory-store");
const { startFakeEncompass } = require("../dev/fake-encompass");

const ADMIN_TOKEN = "test-admin-token-0123456789";

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
    env: { ENCOMPASS_BASE_URL: fake.url, ADMIN_TOKEN, UPSTREAM_TIMEOUT_MS: "3000" },
  });
  await store.putTenant({
    apiKeyId: "key-1",
    tenantName: "Acme Title",
    encompassUserId: "persona-1",
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

test("job status is scoped to the requesting tenant", async () => {
  const { jobId } = parse(await enqueue());
  await store.putTenant({ apiKeyId: "key-2", tenantName: "Other", encompassUserId: "persona-2" });

  const foreign = await handler(httpEvent({ path: `/v1/jobs/${jobId}`, apiKeyId: "key-2" }));
  assert.equal(foreign.statusCode, 404);

  const unknown = await handler(httpEvent({ path: "/v1/jobs/job_missing" }));
  assert.equal(unknown.statusCode, 404);
});

test("portal rejects a missing or wrong admin token", async () => {
  const body = { tenantName: "Acme", encompassUserId: "persona-9" };

  const missing = await handler(httpEvent({ method: "POST", path: "/portal", body }));
  assert.equal(missing.statusCode, 403);

  const wrong = await handler(
    httpEvent({ method: "POST", path: "/portal", body, headers: { "x-admin-token": "wrong-token-wrong-token" } }),
  );
  assert.equal(wrong.statusCode, 403);
});

test("portal provisions a key and maps the tenant", async () => {
  const response = await handler(
    httpEvent({
      method: "POST",
      path: "/portal",
      body: { tenantName: "Acme Title", encompassUserId: "persona-9" },
      headers: { "x-admin-token": ADMIN_TOKEN },
    }),
  );
  assert.equal(response.statusCode, 200);

  const body = parse(response);
  assert.equal(body.tenantName, "Acme Title");
  assert.equal(body.encompassUserId, "persona-9");
  assert.ok(body.apiKey);

  const apiKeyId = store.keyIdsByValue.get(body.apiKey);
  assert.ok(apiKeyId);

  const read = await handler(httpEvent({ path: "/v1/loans/loan-1", apiKeyId }));
  assert.equal(read.statusCode, 200);
});

test("portal validates required fields", async () => {
  const response = await handler(
    httpEvent({
      method: "POST",
      path: "/portal",
      body: { tenantName: "", encompassUserId: "" },
      headers: { "x-admin-token": ADMIN_TOKEN },
    }),
  );
  assert.equal(response.statusCode, 400);
});

test("portal fails closed when no admin token is configured", async () => {
  const unconfigured = createHandler({ store, env: { ENCOMPASS_BASE_URL: fake.url } });
  const response = await unconfigured(
    httpEvent({
      method: "POST",
      path: "/portal",
      body: { tenantName: "Acme", encompassUserId: "persona-9" },
      headers: { "x-admin-token": ADMIN_TOKEN },
    }),
  );
  assert.equal(response.statusCode, 503);
});

test("portal serves hardened HTML", async () => {
  const response = await handler(httpEvent({ path: "/portal" }));
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.headers["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.match(response.body, /Encompass API Gateway/);
});

test("unknown routes return 404 and wrong methods return 405", async () => {
  assert.equal((await handler(httpEvent({ path: "/nope" }))).statusCode, 404);
  assert.equal((await handler(httpEvent({ method: "POST", path: "/v1/loans/loan-1" }))).statusCode, 405);
  assert.equal((await handler(httpEvent({ method: "PUT", path: "/portal" }))).statusCode, 405);
});
