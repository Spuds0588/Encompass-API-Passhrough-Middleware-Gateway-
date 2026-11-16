"use strict";

const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const { createHandler, _resetReadCache } = require("../src/gateway");
const { createMemoryStore } = require("../dev/memory-store");
const { startFakeEncompass } = require("../dev/fake-encompass");

const INVITES = {
  title: "title-invite-0123456789abcdef",
  broker: "broker-invite-0123456789abcdef",
};

let fake;
let store;
let handler;

const httpEvent = ({ method = "GET", path, query = null, body = null, apiKeyId = null }) => ({
  httpMethod: method,
  path,
  queryStringParameters: query,
  headers: {},
  body: body === null ? null : JSON.stringify(body),
  requestContext: { requestId: "request-1", identity: apiKeyId ? { apiKeyId } : {} },
});

const parse = (response) => JSON.parse(response.body);

const provision = (overrides = {}) =>
  handler(
    httpEvent({
      method: "POST",
      path: "/portal",
      body: {
        tenantName: "Acme Broker",
        email: "dev@acme.test",
        role: "broker",
        code: INVITES.broker,
        encompassUserId: "broker-user-1",
        ...overrides,
      },
    }),
  );

beforeEach(async () => {
  fake = await startFakeEncompass({
    loans: {
      "loan-broker": { 11: "1 Broker Way" },
      "loan-title": { 11: "9 Title Rd" },
    },
    loanOwners: { "loan-broker": "broker-user-1", "loan-title": "title-user-1" },
  });
  store = createMemoryStore();
  _resetReadCache();
  handler = createHandler({
    store,
    env: {
      ENCOMPASS_BASE_URL: fake.url,
      INVITE_TITLE: INVITES.title,
      INVITE_BROKER: INVITES.broker,
      UPSTREAM_TIMEOUT_MS: "3000",
    },
  });
});

afterEach(async () => {
  await fake.close();
});

test("enrollment requires the Encompass login the key acts as", async () => {
  const response = await provision({ encompassUserId: "" });
  assert.equal(response.statusCode, 400);
  assert.match(parse(response).error, /encompassUserId/);
});

test("enrollment refuses a user Encompass cannot mint a token for", async () => {
  const response = await provision({ encompassUserId: "nobody-here" });
  assert.equal(response.statusCode, 403);
});

test("enrollment records the verified binding rather than a shared persona", async () => {
  const response = await provision();
  assert.equal(response.statusCode, 200);

  const body = parse(response);
  assert.equal(body.encompassUserId, "broker-user-1");
  assert.equal(body.binding.mode, "BOUND_SUBJECT");
  assert.equal(body.binding.loanAccess.peer, "Disabled");
  assert.ok(body.binding.verifiedAt);

  const tenant = await store.getTenant(body.apiKeyId);
  assert.equal(tenant.encompassUserId, "broker-user-1");
  assert.equal(tenant.binding.mode, "BOUND_SUBJECT");
});

test("impersonation exchanges an actor token, not just client credentials", async () => {
  assert.equal(fake.state.actorExchanges, 0);
  await provision();
  assert.equal(fake.state.actorExchanges, 1);
  assert.ok(fake.state.tokenExchanges > 0);
});

test("a key cannot read a loan owned by another Encompass user", async () => {
  const provisioned = parse(await provision());

  const own = await handler(
    httpEvent({ path: "/v1/loans/loan-broker", query: { fields: "11" }, apiKeyId: provisioned.apiKeyId }),
  );
  assert.equal(own.statusCode, 200);

  const foreign = await handler(
    httpEvent({ path: "/v1/loans/loan-title", query: { fields: "11" }, apiKeyId: provisioned.apiKeyId }),
  );
  assert.equal(foreign.statusCode, 404);
});

test("a leaked loan id does not resolve for another company's key", async () => {
  const brokerKey = parse(await provision()).apiKeyId;
  const titleKey = parse(
    await provision({
      tenantName: "Other Title Co",
      email: "other@acme.test",
      role: "title",
      code: INVITES.title,
      encompassUserId: "title-user-1",
    }),
  ).apiKeyId;
  assert.notEqual(brokerKey, titleKey);

  const brokerRead = await handler(
    httpEvent({ path: "/v1/loans/loan-title", query: { fields: "11" }, apiKeyId: brokerKey }),
  );
  const titleRead = await handler(
    httpEvent({ path: "/v1/loans/loan-title", query: { fields: "11" }, apiKeyId: titleKey }),
  );
  assert.equal(brokerRead.statusCode, 404);
  assert.equal(titleRead.statusCode, 200);
});
