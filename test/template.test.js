"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const template = fs.readFileSync(path.join(root, "template.yaml"), "utf8");
const source = fs.readFileSync(path.join(root, "src", "gateway.js"), "utf8");

test("committed template.yaml matches the build", () => {
  execFileSync(process.execPath, ["scripts/build.js", "--check"], { cwd: root, stdio: "pipe" });
});

test("template stays under CloudFormation's direct upload limit", () => {
  assert.ok(Buffer.byteLength(template) < 51200, "template.yaml must be < 51200 bytes");
});

test("template embeds the handler and has no leftover placeholder", () => {
  assert.match(template, /ZipFile: \|/);
  assert.ok(template.includes("exports.handler"));
  assert.ok(!template.includes("__GATEWAY_CODE__"));
  assert.match(source, /Runtime: Node\.js 24\.x/);
});

test("template provisions the expected AWS resources", () => {
  for (const resource of [
    "AWS::Lambda::Function",
    "AWS::ApiGateway::RestApi",
    "AWS::ApiGateway::UsagePlan",
    "AWS::ApiGateway::Stage",
    "AWS::DynamoDB::Table",
    "AWS::SQS::Queue",
    "AWS::SecretsManager::Secret",
    "AWS::Lambda::EventSourceMapping",
  ]) {
    assert.ok(template.includes(resource), `missing ${resource}`);
  }
});

test("vendor routes require an API key", () => {
  const proxy = template.slice(template.indexOf("ProxyAny:"), template.indexOf("ApiDeployment:"));
  assert.match(proxy, /ApiKeyRequired: true/);
  assert.match(proxy, /HttpMethod: ANY/);
  assert.ok(!template.slice(template.indexOf("PortalGet:"), template.indexOf("ProxyAny:")).includes("ApiKeyRequired"));
});

test("secrets have no default values and invite codes are per role", () => {
  const secretParams = template.slice(template.indexOf("Parameters:"), template.indexOf("Resources:"));
  assert.match(secretParams, /EncompassClientSecret:[\s\S]*?NoEcho: true/);
  for (const name of ["TitleInviteCode", "BrokerInviteCode", "AppraisalInviteCode"]) {
    assert.match(secretParams, new RegExp(`${name}:[\\s\\S]*?NoEcho: true[\\s\\S]*?MinLength: 24`));
  }
  assert.ok(!secretParams.includes("AdminPortalToken"));
  assert.ok(!secretParams.includes("ClientSecret:\n    Type: String\n    Default"));
});

test("portal provisioning is role-scoped and has no admin token", () => {
  assert.match(template, /INVITE_TITLE/);
  assert.match(template, /PERSONA_BROKER/);
  assert.match(template, /PORTAL_INVITE_REJECTED/);
  assert.ok(!template.includes("ADMIN_TOKEN"));
  assert.ok(!template.includes("AdminPortalToken"));
});

test("field schema proxy uses native Encompass endpoints", () => {
  assert.match(template, /schemas\/loan\/standardFields/);
  assert.match(template, /settings\/loan\/customFields/);
});

test("write pipeline is FIFO with retries, SSE, and bounded retention", () => {
  assert.match(template, /FifoQueue: true/);
  assert.match(template, /RedrivePolicy:/);
  assert.match(template, /maxReceiveCount: 5/);
  assert.match(template, /FunctionResponseTypes:\n {8}- ReportBatchItemFailures/);
  assert.match(template, /MaximumConcurrency: 5/);
  assert.match(template, /MessageRetentionPeriod: 86400/);
  assert.match(template, /MessageRetentionPeriod: 345600/);
  assert.match(template, /SqsManagedSseEnabled: true/);
});

test("deploy.sh is executable and points at this repository's template", () => {
  const deployPath = path.join(root, "deploy.sh");
  const stat = fs.statSync(deployPath);
  assert.ok(stat.mode & 0o111, "deploy.sh must be executable");
  const deploy = fs.readFileSync(deployPath, "utf8");
  assert.match(deploy, /Spuds0588\/Encompass-API-Passhrough-Middleware-Gateway-\/main\/template\.yaml/);
  assert.match(deploy, /aws cloudformation deploy/);
  assert.match(deploy, /--capabilities CAPABILITY_IAM/);
  assert.match(deploy, /TitleInviteCode="\$TITLE_INVITE_CODE"/);
  assert.match(deploy, /\?role=title&code=\$\{TITLE_INVITE_CODE\}/);
});
