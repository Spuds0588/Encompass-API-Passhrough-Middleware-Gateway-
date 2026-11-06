"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createDevGateway } = require("../dev/server");
const { startFakeEncompass } = require("../dev/fake-encompass");

const request = async (url, options = {}) => {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
};

test("full vendor flow over real HTTP (production-shaped)", async () => {
  const fake = await startFakeEncompass({
    loans: {
      "loan-1": { 11: "123 Main St", 12: "Irvine", 14: "CA", 1109: 450000 },
      "loan-locked": { 11: "77 Lock Ln", 12: "Reno", 14: "NV", 1109: 250000 },
    },
    lockAttempts: { "loan-locked": 2 },
  });
  const gateway = await createDevGateway({ fakeEncompass: fake });

  try {
    const health = await request(`${gateway.url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: "ok" });

    const rejected = await request(`${gateway.url}/portal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantName: "Acme", encompassUserId: "persona-1" }),
    });
    assert.equal(rejected.status, 403);

    const provisioned = await request(`${gateway.url}/portal`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": gateway.adminToken },
      body: JSON.stringify({ tenantName: "Acme Title", encompassUserId: "persona-1" }),
    });
    assert.equal(provisioned.status, 200);
    const apiKey = provisioned.body.apiKey;
    assert.ok(apiKey);

    const noKey = await request(`${gateway.url}/v1/loans/loan-1?fields=11,12`);
    assert.equal(noKey.status, 403);

    const first = await request(`${gateway.url}/v1/loans/loan-1?fields=11,12,1109`, {
      headers: { "x-api-key": apiKey },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body._cached, false);
    assert.deepEqual(Object.keys(first.body.fields).sort(), ["11", "1109", "12"]);
    assert.equal(first.headers.get("cache-control"), "private, max-age=30");

    const second = await request(`${gateway.url}/v1/loans/loan-1?fields=11,12,1109`, {
      headers: { "x-api-key": apiKey },
    });
    assert.equal(second.body._cached, true);
    assert.equal(fake.state.reads, 1);

    const accepted = await request(`${gateway.url}/v1/loans/loan-1`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ fields: { 1109: 525000 } }),
    });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.status, "ACCEPTED");

    const pending = await request(`${gateway.url}/v1/jobs/${accepted.body.jobId}`, {
      headers: { "x-api-key": apiKey },
    });
    assert.equal(pending.body.status, "PENDING");

    const drained = await request(`${gateway.url}/dev/drain`, { method: "POST" });
    assert.equal(drained.body.processed, 1);
    assert.equal(drained.body.retried, 0);

    const completed = await request(`${gateway.url}/v1/jobs/${accepted.body.jobId}`, {
      headers: { "x-api-key": apiKey },
    });
    assert.equal(completed.body.status, "COMPLETED");
    assert.equal(fake.state.loans.get("loan-1")[1109], 525000);

    const lockedAccepted = await request(`${gateway.url}/v1/loans/loan-locked`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ fields: { "CX.TITLE.STATUS": "Received" } }),
    });
    assert.equal(lockedAccepted.status, 202);

    const lockedDrain = await request(`${gateway.url}/dev/drain`, { method: "POST" });
    assert.equal(lockedDrain.body.processed, 1);
    assert.equal(lockedDrain.body.retried, 2);

    const lockedJob = await request(`${gateway.url}/v1/jobs/${lockedAccepted.body.jobId}`, {
      headers: { "x-api-key": apiKey },
    });
    assert.equal(lockedJob.body.status, "COMPLETED");
    assert.equal(lockedJob.body.attempts, 3);
    assert.equal(fake.state.loans.get("loan-locked")["CX.TITLE.STATUS"], "Received");

    assert.equal(fake.state.tokenExchanges, 1);

    const unknownJob = await request(`${gateway.url}/v1/jobs/job_missing`, {
      headers: { "x-api-key": apiKey },
    });
    assert.equal(unknownJob.status, 404);
  } finally {
    await gateway.close();
  }
});
