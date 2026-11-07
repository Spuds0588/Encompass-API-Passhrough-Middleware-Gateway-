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
    assert.ok(health.headers.get("x-request-id"));

    const landing = await request(`${gateway.url}/portal`);
    assert.equal(landing.status, 200);
    assert.match(landing.body, /Invite link required/);

    const inviteUrl = `${gateway.url}/portal?role=title&code=${encodeURIComponent(gateway.invites.title.code)}`;
    const portalPage = await request(inviteUrl);
    assert.equal(portalPage.status, 200);
    assert.match(portalPage.body, /api_title_template/);
    assert.match(portalPage.body, /646/);

    const rejected = await request(`${gateway.url}/portal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantName: "Acme", email: "dev@acme.test", role: "title", code: "wrong" }),
    });
    assert.equal(rejected.status, 403);

    const provisioned = await request(`${gateway.url}/portal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantName: "Acme Title",
        email: "dev@acme.test",
        role: "title",
        code: gateway.invites.title.code,
      }),
    });
    assert.equal(provisioned.status, 200);
    assert.equal(provisioned.body.encompassUserId, "api_title_template");
    const apiKey = provisioned.body.apiKey;
    assert.equal(provisioned.body.reused, false);
    assert.ok(apiKey);

    const provisionedAgain = await request(`${gateway.url}/portal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantName: "Acme Title",
        email: "dev@acme.test",
        role: "title",
        code: gateway.invites.title.code,
      }),
    });
    assert.equal(provisionedAgain.status, 200);
    assert.equal(provisionedAgain.body.reused, true);
    assert.equal(provisionedAgain.body.apiKey, apiKey);

    const noKey = await request(`${gateway.url}/v1/loans/loan-1?fields=11,12`);
    assert.equal(noKey.status, 403);

    const fields = await request(`${gateway.url}/v1/fields?ids=11,646,CX.TITLE.STATUS`, {
      headers: { "x-api-key": apiKey },
    });
    assert.equal(fields.status, 200);
    assert.deepEqual(fields.body, {
      11: { description: "Subject Property Address", type: "STRING" },
      646: { description: "Title - Lender Title Insurance", type: "DECIMAL" },
      "CX.TITLE.STATUS": { description: "Custom Title Milestone Status", type: "STRING" },
    });

    const fieldsAgain = await request(`${gateway.url}/v1/fields?ids=11,646,CX.TITLE.STATUS`, {
      headers: { "x-api-key": apiKey },
    });
    assert.equal(fieldsAgain.status, 200);
    assert.equal(fake.state.standardSchemaCalls, 1);
    assert.equal(fake.state.customSchemaCalls, 1);

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
    assert.equal(accepted.body.requestId, accepted.headers.get("x-request-id"));

    const pending = await request(`${gateway.url}/v1/jobs/${accepted.body.jobId}`, {
      headers: { "x-api-key": apiKey },
    });
    assert.equal(pending.body.status, "PENDING");
    assert.equal(pending.body.requestId, accepted.body.requestId);

    const drained = await request(`${gateway.url}/dev/drain`, { method: "POST" });
    assert.equal(drained.body.processed, 1);
    assert.equal(drained.body.retried, 0);

    const completed = await request(`${gateway.url}/v1/jobs/${accepted.body.jobId}`, {
      headers: { "x-api-key": apiKey },
    });
    assert.equal(completed.body.status, "COMPLETED");
    assert.equal(completed.body.requestId, accepted.body.requestId);
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

    const documents = await request(`${gateway.url}/v1/loans/loan-1/documents`, {
      headers: { "x-api-key": apiKey },
    });
    assert.equal(documents.status, 200);
    assert.deepEqual(documents.body.documents.map((doc) => doc.id), ["doc-1", "doc-2"]);

    const upload = await request(`${gateway.url}/v1/loans/loan-1/attachmentUploadUrl`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        file: { contentType: "application/pdf", name: "closing-statement.pdf", size: 11 },
        title: "Closing statement",
        assignTo: { entityId: "doc-2", entityType: "Document" },
      }),
    });
    assert.equal(upload.status, 200);
    assert.ok(upload.body.attachmentId);
    assert.ok(upload.body.authorizationHeader);

    const put = await request(upload.body.url, {
      method: "PUT",
      headers: { authorization: upload.body.authorizationHeader },
      body: Buffer.from("upload-body"),
    });
    assert.equal(put.status, 200);

    const documentsAfter = await request(`${gateway.url}/v1/loans/loan-1/documents`, {
      headers: { "x-api-key": apiKey },
    });
    const target = documentsAfter.body.documents.find((doc) => doc.id === "doc-2");
    assert.equal(target.attachments.length, 1);
    assert.equal(target.attachments[0].fileName, "closing-statement.pdf");

    const download = await request(`${gateway.url}/v1/loans/loan-1/attachmentDownloadUrl`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ attachments: [upload.body.attachmentId] }),
    });
    assert.equal(download.status, 200);
    assert.equal(download.body.downloads.length, 1);

    const downloaded = await request(download.body.downloads[0].url, {
      headers: { authorization: download.body.downloads[0].authorizationHeader },
    });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.body, "upload-body");
    assert.equal(fake.state.downloadedBytes, 11);

    const conditions = await request(`${gateway.url}/v1/loans/loan-1/conditions`, {
      headers: { "x-api-key": apiKey },
    });
    assert.equal(conditions.status, 200);
    assert.equal(conditions.body.conditions[0].status, "Requested");

    const responded = await request(`${gateway.url}/v1/loans/loan-1/conditions`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify([{ id: "condition-1", tracking: [{ status: "Received", isChecked: true }] }]),
    });
    assert.equal(responded.status, 200);
    assert.equal(responded.body.updated, 1);

    const conditionsAfter = await request(`${gateway.url}/v1/loans/loan-1/conditions`, {
      headers: { "x-api-key": apiKey },
    });
    assert.equal(conditionsAfter.body.conditions[0].status, "Received");

    assert.equal(fake.state.tokenExchanges, 1);

    const unknownJob = await request(`${gateway.url}/v1/jobs/job_missing`, {
      headers: { "x-api-key": apiKey },
    });
    assert.equal(unknownJob.status, 404);
  } finally {
    await gateway.close();
  }
});

test("broker loan lifecycle over real HTTP", async () => {
  const fake = await startFakeEncompass();
  const gateway = await createDevGateway({ fakeEncompass: fake });

  try {
    const provisioned = await request(`${gateway.url}/portal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantName: "Acme Broker",
        email: "broker@acme.test",
        role: "broker",
        code: gateway.invites.broker.code,
      }),
    });
    assert.equal(provisioned.status, 200);
    const apiKey = provisioned.body.apiKey;
    const headers = { "content-type": "application/json", "x-api-key": apiKey };

    const created = await request(`${gateway.url}/v1/loans?loanFolder=Broker%20Pipeline`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        loanAmount: 525000,
        applications: [{ borrower: { firstName: "Ada", lastName: "Lovelace" } }],
      }),
    });
    assert.equal(created.status, 201);
    const loanId = created.body.loanId;
    assert.match(loanId, /^loan-created-/);

    const application = await request(`${gateway.url}/v1/loans/${loanId}/application`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ applications: [{ borrower: { firstName: "Grace" } }] }),
    });
    assert.equal(application.status, 200);
    assert.equal(application.body.updated, true);

    const milestones = await request(`${gateway.url}/v1/loans/${loanId}/milestones`, {
      headers: { "x-api-key": apiKey },
    });
    assert.equal(milestones.status, 200);
    assert.equal(milestones.body.milestones.some((item) => item.milestoneName === "Submittal"), true);

    for (const milestoneId of ["milestone-submittal", "milestone-resubmittal"]) {
      const finished = await request(
        `${gateway.url}/v1/loans/${loanId}/milestones/${milestoneId}?action=finish`,
        { method: "PATCH", headers: { "x-api-key": apiKey } },
      );
      assert.equal(finished.status, 200);
      assert.equal(finished.body.action, "finish");
    }

    const document = await request(`${gateway.url}/v1/loans/${loanId}/documents`, {
      method: "POST",
      headers,
      body: JSON.stringify([{ title: "Initial underwriting package" }]),
    });
    assert.equal(document.status, 200);
    const documentId = document.body.documents[0].id;

    const upload = await request(`${gateway.url}/v1/loans/${loanId}/attachmentUploadUrl`, {
      method: "POST",
      headers: { "x-api-key": apiKey },
      body: JSON.stringify({
        file: { contentType: "application/pdf", name: "underwriting.pdf", size: 11 },
        assignTo: { entityId: documentId, entityType: "Document" },
      }),
    });
    assert.equal(upload.status, 200);
    const put = await request(upload.body.url, {
      method: "PUT",
      headers: { authorization: upload.body.authorizationHeader },
      body: Buffer.from("underwriting"),
    });
    assert.equal(put.status, 200);

    const condition = await request(`${gateway.url}/v1/loans/${loanId}/conditions`, {
      method: "POST",
      headers,
      body: JSON.stringify([
        {
          conditionType: "Underwriting",
          title: "Provide prior-to-docs package",
          priorTo: "Docs",
        },
      ]),
    });
    assert.equal(condition.status, 200);
    const conditionId = condition.body.conditions[0].id;

    const linked = await request(
      `${gateway.url}/v1/loans/${loanId}/conditions/${conditionId}/documents?action=add`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify([{ entityId: documentId, entityType: "Document" }]),
      },
    );
    assert.equal(linked.status, 200);

    const linkedDocuments = await request(
      `${gateway.url}/v1/loans/${loanId}/conditions/${conditionId}/documents`,
      { headers: { "x-api-key": apiKey } },
    );
    assert.equal(linkedDocuments.status, 200);
    assert.deepEqual(linkedDocuments.body.documents.map((item) => item.id), [documentId]);

    const satisfied = await request(`${gateway.url}/v1/loans/${loanId}/conditions`, {
      method: "PATCH",
      headers,
      body: JSON.stringify([{ id: conditionId, tracking: [{ status: "Cleared", isChecked: true }] }]),
    });
    assert.equal(satisfied.status, 200);

    const initialConditions = await request(`${gateway.url}/v1/loans/loan-1/standard-conditions/underwriting`, {
      headers: { "x-api-key": apiKey },
    });
    assert.equal(initialConditions.status, 200);
    assert.equal(initialConditions.body.conditions.length, 1);

    const fundingCondition = await request(
      `${gateway.url}/v1/loans/loan-1/standard-conditions/underwriting`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Provide prior-to-funding title update", priorTo: "Funding" }),
      },
    );
    assert.equal(fundingCondition.status, 200);
    const fundingConditionId = fundingCondition.body.data.id;

    const fundingSatisfied = await request(
      `${gateway.url}/v1/loans/loan-1/standard-conditions/underwriting?action=update`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ id: fundingConditionId, isFulfilled: true, status: "Fulfilled" }),
      },
    );
    assert.equal(fundingSatisfied.status, 200);

    const fundingDocuments = await request(
      `${gateway.url}/v1/loans/loan-1/standard-conditions/underwriting/${fundingConditionId}/documents?action=add`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify([{ entityId: "doc-2", entityType: "Document" }]),
      },
    );
    assert.equal(fundingDocuments.status, 200);

    const postClosing = await request(
      `${gateway.url}/v1/loans/loan-1/standard-conditions/postclosing`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Provide final title policy" }),
      },
    );
    assert.equal(postClosing.status, 200);

    assert.equal(fake.state.loanCreates, 1);
    assert.equal(fake.state.applicationUpdates, 1);
    assert.equal(fake.state.milestoneUpdates, 2);
    assert.equal(fake.state.conditionDocumentUpdates, 1);
    assert.equal(fake.state.standardConditionCreates, 2);
    assert.equal(fake.state.standardConditionDocumentUpdates, 1);
  } finally {
    await gateway.close();
  }
});
