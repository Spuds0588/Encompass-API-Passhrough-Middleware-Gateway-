"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const template = fs.readFileSync(path.join(root, "template.yaml"), "utf8");
const source = fs.readFileSync(path.join(root, "src", "gateway.js"), "utf8");

test("committed template.yaml matches the build", () => {
  execFileSync(process.execPath, ["scripts/build.js", "--check"], { cwd: root, stdio: "pipe" });
});

test("template is within the S3-hosted limit and the deploy path scales past 51,200", () => {
  const bytes = Buffer.byteLength(template);
  assert.ok(bytes < 1000000, `template.yaml must be < 1000000 bytes, got ${bytes}`);

  const deploy = fs.readFileSync(path.join(root, "deploy.sh"), "utf8");
  assert.match(deploy, /--s3-bucket/);
  assert.match(deploy, /1000000/);
  assert.match(deploy, /ARTIFACT_BUCKET/);
  assert.match(deploy, /51200/);
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

test("portal key minting is throttled and has idempotent cleanup wiring", () => {
  assert.match(template, /MethodSettings:/);
  assert.match(template, /ResourcePath: "\/portal"/);
  assert.match(template, /HttpMethod: POST\n {10}ThrottlingRateLimit: 1\n {10}ThrottlingBurstLimit: 2/);
  assert.match(template, /ProvisioningTable:/);
  assert.match(template, /PROVISIONING_TABLE: !Ref ProvisioningTable/);
  assert.match(template, /dynamodb:DeleteItem/);
  assert.match(template, /apigateway:GET/);
  assert.match(template, /apigateway:DELETE/);
  assert.match(template, /\/apikeys\/\*/);
  assert.match(template, /\/usageplans\/\$\{UsagePlan\}\/keys\/\*/);
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

test("tables enable PITR, the ops topic is encrypted, and the stage dependency is not repeated", () => {
  assert.equal((template.match(/PointInTimeRecoverySpecification:/g) || []).length, 4);
  assert.equal((template.match(/PointInTimeRecoveryEnabled: true/g) || []).length, 4);
  const topic = template.slice(template.indexOf("OpsAlertTopic:"), template.indexOf("OpsAlertSubscription:"));
  assert.match(topic, /KmsMasterKeyId: alias\/aws\/sns/);
  const stage = template.slice(template.indexOf("ApiStage:"), template.indexOf("UsagePlan:"));
  assert.match(stage, /- ApiGatewayAccount/);
  assert.ok(!stage.includes("- ApiDeployment"), "ApiStage must not repeat the Ref-implied dependency");
});

test("DLQ depth alarm notifies an SNS topic", () => {
  assert.match(template, /AWS::CloudWatch::Alarm/);
  assert.match(template, /AWS::SNS::Topic/);
  assert.match(template, /MetricName: ApproximateNumberOfMessagesVisible/);
  assert.match(template, /ComparisonOperator: GreaterThanThreshold/);
  assert.match(template, /AlarmActions:\n {8}- !Ref OpsAlertTopic/);
  assert.match(template, /HasOpsAlertEmail/);
});

test("request IDs, metadata-only access logs, and operational alarms are wired", () => {
  assert.match(template, /AccessLogSetting:/);
  assert.match(template, /AccessLogGroupName:/);
  assert.match(template, /ApiGatewayCloudWatchRole:/);
  assert.match(template, /AWS::ApiGateway::Account/);
  assert.match(template, /GatewayErrorsAlarm:/);
  assert.match(template, /Api5xxAlarm:/);
  assert.match(template, /MetricName: 5XXError/);
  assert.match(template, /Name: ApiName/);
  assert.match(template, /"requestId":"\$context\.requestId"/);
  assert.match(template, /"apiKeyId":"\$context\.identity\.apiKeyId"/);
  assert.ok(!template.includes("$context.queryString"));
  assert.ok(!template.includes("$context.requestBody"));
  assert.ok(!template.includes("$context.requestHeader"));
});

test("per-role write allowlists are wired into the Lambda environment", () => {
  for (const name of ["TitleWriteFields", "BrokerWriteFields", "AppraisalWriteFields"]) {
    assert.match(template, new RegExp(`${name}:`));
  }
  for (const name of ["WRITE_FIELDS_TITLE", "WRITE_FIELDS_BROKER", "WRITE_FIELDS_APPRAISAL"]) {
    assert.match(template, new RegExp(`${name}: !Ref`));
  }
});

test("embedded handler includes the broker lifecycle and both condition modes", () => {
  for (const route of [
    "/v1/loans",
    "/application",
    "/milestones",
    "/documents",
    "/attachmentUploadUrl",
    "/attachmentDownloadUrl",
    "/conditions",
    "/standard-conditions",
    "LOAN_CREATED",
    "APPLICATION_UPDATED",
    "MILESTONE_UPDATED",
    "DOCUMENTS_CREATED",
    "CONDITIONS_CREATED",
    "STANDARD_CONDITION_CREATED",
    "CONDITION_DOCUMENTS_UPDATED",
    "ATTACHMENT_UPLOAD_INITIATED",
    "ATTACHMENT_DOWNLOAD_URLS_CREATED",
  ]) {
    assert.ok(template.includes(route), `missing ${route}`);
  }
});

test("deploy.sh pins and verifies the template, uses TLS, and keeps secrets out of argv", () => {
  const deployPath = path.join(root, "deploy.sh");
  const stat = fs.statSync(deployPath);
  assert.ok(stat.mode & 0o111, "deploy.sh must be executable");
  const deploy = fs.readFileSync(deployPath, "utf8");
  const ref = deploy.match(/TEMPLATE_REF="\$\{TEMPLATE_REF:-(v\d+\.\d+\.\d+)\}"/);
  const sha = deploy.match(/TEMPLATE_SHA256="\$\{TEMPLATE_SHA256:-([0-9a-f]{64})\}"/);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(ref, "deploy.sh must pin a release tag");
  assert.equal(ref[1], `v${pkg.version}`, "deploy.sh must pin the package release tag");
  assert.ok(sha, "deploy.sh must pin a 64-character template SHA-256");
  assert.equal(sha[1], createHash("sha256").update(template).digest("hex"));
  assert.ok(deploy.includes("/${TEMPLATE_REF}/template.yaml"));
  assert.ok(!deploy.includes("/main/template.yaml"));
  assert.match(deploy, /--proto '=https'/);
  assert.match(deploy, /--tlsv1\.2/);
  assert.match(deploy, /sha256sum/);
  assert.match(deploy, /chmod 600 "\$TMP_PARAMS"/);
  assert.match(deploy, /--parameter-overrides "file:\/\/\$TMP_PARAMS"/);
  assert.match(deploy, /ParameterValue:env\.ENCOMPASS_CLIENT_SECRET/);
  assert.ok(!deploy.includes('EncompassClientSecret="$ENCOMPASS_CLIENT_SECRET"'));
  assert.match(deploy, /aws cloudformation deploy/);
  assert.match(deploy, /--capabilities CAPABILITY_IAM/);
  assert.match(deploy, /\?role=title&code=\$\{TITLE_INVITE_CODE\}/);
  execFileSync("bash", ["-n", deployPath], { stdio: "pipe" });
});

test("CI runs cfn-lint and an IaC security scan", () => {
  const ci = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /cfn-lint==\d+\.\d+\.\d+/);
  assert.match(ci, /checkov==\d+\.\d+\.\d+/);
  assert.match(ci, /template\.yaml/);
  assert.match(ci, /pip install/);
  assert.match(ci, /--config-file \.checkov\.yaml/);
});

test("Checkov policy documents intentional controls and excludes fixed findings", () => {
  const policy = fs.readFileSync(path.join(root, ".checkov.yaml"), "utf8");
  for (const id of [
    "CKV_AWS_149",
    "CKV_AWS_119",
    "CKV_AWS_27",
    "CKV_AWS_158",
    "CKV_AWS_117",
    "CKV_AWS_115",
    "CKV_AWS_173",
    "CKV_AWS_116",
    "CKV_AWS_59",
    "CKV_AWS_120",
    "CKV_AWS_73",
  ]) {
    assert.match(policy, new RegExp(id));
  }
  assert.ok(!policy.includes("CKV_AWS_28"), "DynamoDB PITR must be fixed, not skipped");
  assert.ok(!policy.includes("CKV_AWS_26"), "SNS encryption must be fixed, not skipped");
});
