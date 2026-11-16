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
      AUTHORIZED_USER_TITLE: "title-user-1",
      INVITE_BROKER: INVITES.broker,
      AUTHORIZED_USER_BROKER: "broker-user-1",
      UPSTREAM_TIMEOUT_MS: "3000",
    },
  });
});

afterEach(async () => {
  await fake.close();
});

test("enrollment refuses a login the invite was not issued for, before minting a token", async () => {
  const response = await provision({ encompassUserId: "title-user-1" });
  assert.equal(response.statusCode, 403);
  assert.match(parse(response).error, /not authorized/i);

  // Entitlement is decided before any credential is minted, and no key is stored.
  assert.equal(fake.state.actorExchanges, 0);
  assert.equal(fake.state.tokenExchanges, 0);
  assert.equal(store.apiKeys.size, 0);
});

test("enrollment derives the acting login from the invite when the form omits it", async () => {
  const response = await provision({ encompassUserId: "" });
  assert.equal(response.statusCode, 200);
  assert.equal(parse(response).encompassUserId, "broker-user-1");
});

test("an invite with no pre-authorized login fails closed", async () => {
  const { createHandler } = require("../src/gateway");
  const unbound = createHandler({
    store,
    env: {
      ENCOMPASS_BASE_URL: fake.url,
      INVITE_BROKER: INVITES.broker,
      UPSTREAM_TIMEOUT_MS: "3000",
    },
  });
  const response = await unbound(
    httpEvent({
      method: "POST",
      path: "/portal",
      body: {
        tenantName: "Acme Broker",
        email: "dev@acme.test",
        role: "broker",
        code: INVITES.broker,
        encompassUserId: "broker-user-1",
      },
    }),
  );
  assert.equal(response.statusCode, 403);
  assert.equal(store.apiKeys.size, 0);
});

test("a JSON invite binding authorizes exactly the login it names", async () => {
  const { createHandler } = require("../src/gateway");
  const code = "bound-invite-code-0123456789";
  const bound = createHandler({
    store,
    env: {
      ENCOMPASS_BASE_URL: fake.url,
      UPSTREAM_TIMEOUT_MS: "3000",
      INVITE_BINDINGS: JSON.stringify([
        { code, role: "title", encompassUserId: "title-user-1", company: "Acme Title" },
      ]),
    },
  });
  const post = (encompassUserId) =>
    bound(
      httpEvent({
        method: "POST",
        path: "/portal",
        body: {
          tenantName: "Acme Title",
          email: "dev@acme.test",
          role: "title",
          code,
          encompassUserId,
        },
      }),
    );

  assert.equal((await post("broker-user-1")).statusCode, 403);
  const allowed = await post("title-user-1");
  assert.equal(allowed.statusCode, 200);
  assert.equal(parse(allowed).encompassUserId, "title-user-1");
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
