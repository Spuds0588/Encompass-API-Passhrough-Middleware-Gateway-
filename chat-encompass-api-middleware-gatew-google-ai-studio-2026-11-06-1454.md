# Encompass API Middleware Gatew | Google AI Studio

> Exported from https://aistudio.google.com/prompts/1lnamP7iT0E8tGEhIMstQvIiPnhCaihDn on 2026-11-06 14:54 · AI Studio · 7 messages

## Assistant

**No. Absolutely do not do this.**

Taking on a "functional copy" and building a data-sync engine turns a lean, 1-click passthrough gateway into a multi-million dollar distributed data synchronization nightmare. It directly violates YAGNI and creates four massive problems you will spend the next two years trying to solve:

---

### 1. Encompass is a Business Logic Engine, Not a Database

This is the biggest trap with Encompass.

### 2. The 400 KB DynamoDB Wall vs. The 10 MB Encompass Loan

### 3. Master-Master Conflict & Data Loss

### 4. Regulatory & Compliance Explosion (GLBA / SOC2)

---

### What We Should Do Instead (The Lean Architecture)

Mortgage APIs are inherently eventual-consistency systems. Third parties already expect asynchronous operations for complex files. You don't need to fake a synchronous database to give them a modern developer experience.

Here is how we get fast reads and reliable writes without storing a single loan:

```
[Vendor]
   │
   ├─► GET /loans/{id}?fields=11,12,1109 ──► [In-Memory Cache (TTL: 30s)] ──► Encompass (Field Filtered)
   │                                           └─ Fast (150ms)
   │
   └─► PATCH /loans/{id} ────────────────► [SQS FIFO] ──► [Worker] ──► Encompass
                                               │
                                       Returns 202 Accepted + Job ID
```

Stick to the passthrough model. It keeps the gateway stateless, serverless, cheap, and out of compliance trouble.

Do we agree to keep it stateless and optimize via **field-level querying** and **short-lived read caching**?

---

## Assistant

**Considering Deployment Speed**

I'm now focused on achieving a near "1-click deployment" experience for this stateless passthrough approach. My current question revolves around whether an automated deployment, perhaps via a single-line script, is feasible. This should reduce friction and increase adoption.

**Analyzing Onboarding Friction**

I'm now diving into the user experience, specifically regarding API key retrieval. I'm trying to decide between light server-side rendering or an embeddable widget that can display the key. The goal is to make the partner onboarding and key management experience as fast as possible, ideally, just 1 minute. I want to generate the full code files and keep the solution to one line when appropriate.

**Evaluating Deployment Automation**

I've been weighing the pros and cons of different deployment approaches. The CloudFormation Quick-Create stack seems like the closest thing to a true "1-click" experience. The 1-line CLI script is another viable solution. We need to consider how to prompt users for their credentials in either case. The best solution must require as little effort as possible. I'm taking a hard look at the "pushback" realities like AWS account setup.

**Prioritizing User Convenience**

I'm now thinking about how to provide the **CloudFormation Quick-Create URL** as the primary deployment option, along with a terminal command fallback. This offers a balance between ease and flexibility. It seems the "1-click" cloudformation option will be far more convenient, while the 1 line script will offer a path for customization.

I'm also considering the best solution for API key generation. While the PM's suggestion of an embeddable widget is tempting, I'm concerned about the security implications of exposing an API key generation screen and its security. I'm worried it opens attack vectors such as clickjacking. Plus, the complexity of a full-fledged OAuth/DevPortal embed widget is pushing me away.

**Refining Onboarding UI**

I'm now zeroing in on a lightweight server-side rendered (SSR) solution using a Lambda function. I envision a simple API Gateway endpoint returning HTML, Tailwind CDN, and PicoCSS. The user would enter tenant details and generate credentials, which are then displayed securely with a copy button and a curl example. Embedding via &lt;iframe> is possible, but I think a standalone link generated from CloudFormation is safer and cleaner, avoiding potential security issues.

**Optimizing Installer Options**

I'm now prioritizing two deployment options: the **AWS CloudFormation Quick-Create URL**, which allows for 1-click browser deployment, and a single npx deploy-encompass-gateway or bash one-liner. The CloudFormation approach will highlight the returned gateway URLs for the Admin Portal and Webhook Receiver. For key provisioning, I'm leaning heavily towards a light SSR via a single Lambda, which delivers an admin portal with zero dependencies. This provides a secure and user-friendly experience, avoiding iframe vulnerabilities and providing copyable curl examples.

---

## Assistant

We can get this down to **true 1-click deployment** and a **zero-friction key distribution system**, but we need to do it without falling into security and iframe traps.

Here is how we accomplish both, followed by where I am going to push back on your embed idea, and the exact code to make it work.

---

### 1. The Deployment: CloudFormation "Quick-Create" (True 1-Click)

Forget running bash scripts in a terminal—most mortgage lender IT admins don't have AWS CLI configured locally, and npm/npx scripts will get blocked by corporate endpoint security.

The standard for AWS 1-click is a **CloudFormation Quick-Create Link**.
You host our SAM/CloudFormation template on a public S3 bucket and give the lender a link:

```
https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?templateURL=https://s3.amazonaws.com/your-bucket/encompass-gateway.yaml&stackName=EncompassGateway
```

**The Lender Experience:**

Deployment time: **under 3 minutes, zero terminal commands.**

---

### 2. Pushback on the "Embed/iFrame" Idea

You asked: “Can we do some light server-side rendering or something so they can use an embed or alike with a url source and id?”

**Do not put API key issuance in an embeddable iframe.**

### The Leaner, 1-Minute Solution: "Single-Lambda SSR Portal"

Instead of an embed, API Gateway serves a **lightweight, zero-dependency, server-side rendered HTML page** directly out of a single Lambda.

---

### Implementation: The Standalone Admin & Key Generation Lambda

Here is the complete, full-file implementation of the SSR Portal Handler (admin_portal.js). It handles both serving the clean web interface and handling the POST request to issue the API key via AWS API Gateway and DynamoDB.

```
/**
 * File: admin_portal.js
 * Description: Lightweight SSR Admin Portal for Encompass Gateway.
 * Issues scoped API keys and tenant mappings with zero frontend build dependencies.
 */

const { APIGatewayClient, CreateApiKeyCommand, CreateUsagePlanKeyCommand } = require("@aws-sdk/client-api-gateway");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

const apiGateway = new APIGatewayClient({});
const ddbDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const USAGE_PLAN_ID = process.env.USAGE_PLAN_ID;
const TENANT_TABLE = process.env.TENANT_TABLE;

// Utility for clean, traceable logging
const log = (level, action, details) => {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, action, ...details }));
};

exports.handler = async (event) => {
  const method = event.httpMethod || event.requestContext?.http?.method;
  const path = event.path || event.rawPath;

  log("INFO", "PORTAL_REQUEST_RECEIVED", { method, path });

  try {
    // 1. POST: Generate Key and Save Mapping
    if (method === "POST") {
      let body;
      try {
        body = JSON.parse(event.body || "{}");
      } catch (e) {
        log("WARN", "PAYLOAD_PARSE_FAILED", { rawBody: event.body });
        return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Invalid JSON" }) };
      }

      const { tenantName, encompassUserId } = body;

      if (!tenantName || !encompassUserId) {
        log("WARN", "VALIDATION_FAILED", { body });
        return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Missing required fields" }) };
      }

      log("INFO", "PROVISIONING_PARTNER_KEY", { tenantName, encompassUserId });

      // Step A: Create API Key in API Gateway
      const apiKeyResponse = await apiGateway.send(new CreateApiKeyCommand({
        name: `tenant-${tenantName.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
        enabled: true,
        generateDistinctId: true,
        description: `Encompass gateway key for ${tenantName} mapped to ${encompassUserId}`
      }));

      // Step B: Associate Key with Gateway Usage Plan
      await apiGateway.send(new CreateUsagePlanKeyCommand({
        keyId: apiKeyResponse.id,
        keyType: "API_KEY",
        usagePlanId: USAGE_PLAN_ID
      }));

      // Step C: Save Tenant Mapping to DynamoDB
      await ddbDoc.send(new PutCommand({
        TableName: TENANT_TABLE,
        Item: {
          apiKeyId: apiKeyResponse.id,
          apiKeySecret: apiKeyResponse.value, // Used for verification / lookup
          tenantName,
          encompassUserId,
          createdAt: new Date().toISOString(),
          status: "ACTIVE"
        }
      }));

      log("INFO", "PARTNER_PROVISIONED_SUCCESSFULLY", {
        tenantName,
        apiKeyId: apiKeyResponse.id,
        encompassUserId
      });

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Tenant provisioned successfully",
          apiKey: apiKeyResponse.value,
          tenantName,
          encompassUserId
        })
      };
    }

    // 2. GET: Serve Clean HTML Portal
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: renderHTML()
    };

  } catch (error) {
    log("ERROR", "PORTAL_INTERNAL_ERROR", { message: error.message, stack: error.stack });
    return {
      statusCode: 500,
      headers: { "Content-Type": "text/html" },
      body: `<h3>Internal Server Error</h3><pre>${error.message}</pre>`
    };
  }
};

function renderHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Encompass Gateway Management</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen flex items-center justify-center p-6">
  <div class="max-w-xl w-full bg-slate-800 border border-slate-700 rounded-xl p-8 shadow-2xl">
    <div class="mb-6 border-b border-slate-700 pb-4">
      <h1 class="text-2xl font-bold tracking-tight text-white">Encompass API Gateway</h1>
      <p class="text-sm text-slate-400 mt-1">Generate self-serve API credentials with persona mapping.</p>
    </div>

    <!-- Generation Form -->
    <div id="form-container" class="space-y-4">
      <div>
        <label class="block text-xs uppercase font-semibold text-slate-400 mb-1">Partner / Vendor Name</label>
        <input id="tenantName" type="text" placeholder="e.g. First American Title"
          class="w-full bg-slate-950 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-indigo-500">
      </div>
      <div>
        <label class="block text-xs uppercase font-semibold text-slate-400 mb-1">Encompass Impersonation User ID</label>
        <input id="encompassUserId" type="text" placeholder="e.g. api_title_vendor"
          class="w-full bg-slate-950 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-indigo-500">
        <p class="text-xs text-slate-500 mt-1">Requests using this key will inherit this Encompass user's Persona/Access limits.</p>
      </div>
      <button onclick="generateKey()" id="btn-submit"
        class="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-3 rounded-lg transition-all">
        Provision API Access
      </button>
    </div>

    <!-- Success Result Box (Hidden by default) -->
    <div id="result-box" class="hidden mt-6 bg-slate-950 border border-emerald-500/30 rounded-lg p-5">
      <div class="flex items-center space-x-2 text-emerald-400 mb-3">
        <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path></svg>
        <span class="font-semibold text-sm">Key Provisioned Successfully</span>
      </div>
      <p class="text-xs text-slate-400 mb-2">Copy this key now. It will not be shown again.</p>
      <div class="flex items-center space-x-2 mb-4">
        <input id="out-key" readonly class="w-full bg-slate-900 border border-slate-700 text-yellow-300 font-mono text-sm px-3 py-2 rounded">
        <button onclick="copyKey()" class="bg-slate-800 hover:bg-slate-700 px-3 py-2 rounded text-xs font-semibold">Copy</button>
      </div>

      <label class="block text-xs uppercase font-semibold text-slate-400 mb-1">Partner Verification cURL</label>
      <pre id="out-curl" class="bg-slate-900 p-3 rounded font-mono text-xs text-slate-300 overflow-x-auto"></pre>

      <button onclick="resetForm()" class="mt-4 text-xs text-slate-400 hover:text-white underline">Provision another partner</button>
    </div>
  </div>

  <script>
    async function generateKey() {
      const btn = document.getElementById('btn-submit');
      const tenantName = document.getElementById('tenantName').value.trim();
      const encompassUserId = document.getElementById('encompassUserId').value.trim();

      if (!tenantName || !encompassUserId) {
        alert('Please fill out all fields.');
        return;
      }

      btn.disabled = true;
      btn.innerText = 'Provisioning...';

      try {
        const res = await fetch(window.location.pathname, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tenantName, encompassUserId })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to create key');

        document.getElementById('form-container').classList.add('hidden');
        document.getElementById('result-box').classList.remove('hidden');
        document.getElementById('out-key').value = data.apiKey;

        const gatewayOrigin = window.location.origin;
        document.getElementById('out-curl').innerText =
          'curl -X GET "' + gatewayOrigin + '/v1/loans/SOME_LOAN_GUID?fields=11,12,1109" \\\\n' +
          '  -H "x-api-key: ' + data.apiKey + '"';

      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
        btn.innerText = 'Provision API Access';
      }
    }

    function copyKey() {
      const copyText = document.getElementById("out-key");
      copyText.select();
      navigator.clipboard.writeText(copyText.value);
      alert("API Key copied to clipboard");
    }

    function resetForm() {
      document.getElementById('tenantName').value = '';
      document.getElementById('encompassUserId').value = '';
      document.getElementById('result-box').classList.add('hidden');
      document.getElementById('form-container').classList.remove('hidden');
    }
  </script>
</body>
</html>`;
}
```

---

### Why This Is the Best Way Forward

Are you good with this portal approach? If so, next we'll build the core **Passthrough Router Lambda** (handling the token cache and field-filtered proxying to Encompass).

---

## Assistant

**Defining the Goal**

I'm focusing on the distribution method – a public GitHub repository with GitHub Pages, or a similar static hosting approach. This constraint shapes all subsequent considerations. I'm actively exploring how to best leverage this requirement.

**Confirming CloudFormation Limitation**

I've verified the CloudFormation behavior regarding templateURL. My research confirms that it explicitly rejects non-S3 URLs, as the documentation clearly states. This restriction is quite firm, using exclusively S3 URLs for template access.

**Exploring Alternative Delivery Methods**

I'm now investigating alternative delivery methods since CloudFormation restricts templateURL to S3. My current focus is on a potential workaround. I'm considering if GitHub Actions can publish the YAML to a public S3 bucket upon release. The challenge, however, is the user's preference for GitHub Pages or similar hosting. Could GitHub Pages host a 1-click installer using the AWS SDK in JavaScript within the browser? This might bypass the direct S3 requirement.

**Addressing the Direct Deployment**

I've hit a roadblock. Direct integration of Netlify or GitHub Pages with CloudFormation's URL-based launcher won't work. The system absolutely demands an S3 URL. I now recall the user's initial preference: a public GitHub repo with Pages enabled. This eliminates the feasibility of a direct link, forcing us to explore alternatives.

**Devising Implementation Strategies**

I've crafted three solutions that maintain a 100% GitHub-centric approach without external infrastructure. First, a "1-Click Download & Launch" button on GitHub Pages will allow users to download the template and open the CloudFormation console for upload, bypassing S3 restrictions. Secondly, a one-line terminal command for AWS CloudShell will utilize curl to fetch the template directly, again avoiding S3 involvement.

**Evaluating CloudShell Deployment**

I'm now zeroing in on an interactive bash script hosted on GitHub Pages or raw GitHub, deployable within AWS CloudShell. This approach runs a curl command to fetch and execute a script that prompts users for necessary parameters and then executes aws cloudformation deploy. This completely bypasses S3 requirements and offers a zero-setup deployment.

**Clarifying Solution Feasibility**

I've clarified the direct limitations of CloudFormation's templateURL requirement, confirming the impossibility of direct integration with GitHub Pages or similar services. However, this has led me to explore a clear path forward, and the project is still viable!

\n\n

I'm now outlining a clear and direct answer without any fluff. I've confirmed CloudFormation's strict S3 URL validation. However, the project remains feasible. I'll showcase a one-line script deployment using GitHub Pages and AWS CloudShell. I also see that users can drag-and-drop templates, offering a direct CloudFormation upload for distribution.

**Refining Distribution Strategies**

I am now focusing on refining the two zero-cost, GitHub-only distribution methods. Method A, the AWS CloudShell one-liner, provides an exceptional user experience, especially for IT administrators, as it's a seamless and authenticated deployment within the AWS console. Method B, the download and drag-and-drop template, is a simple, zero-terminal option for users who may prefer a more graphical approach to upload and deployment. Both bypass any need for external infrastructure and meet project constraints.

---

## Assistant

Yes, there is a catch here, but **no, it is not a dealbreaker.**

Here is the exact technical reality from AWS, why GitHub Pages alone cannot use the browser's templateURL link, and the **GitHub-native 1-line solution** that solves it without requiring you to run or pay for any hosting.

---

### The Reality Check: CloudFormation's S3 Restriction

If you try to link to GitHub Pages using the CloudFormation quick-create URL:

```
https://console.aws.amazon.com/cloudformation/home#/stacks/create/review?templateURL=https://myorg.github.io/encompass-gateway.yaml
```

**AWS will throw an error:** TemplateURL must be an Amazon S3 URL.[[1](https://www.google.com/url?sa=E&q=https%3A%2F%2Fvertexaisearch.cloud.google.com%2Fgrounding-api-redirect%2FAUZIYQF_ZJyvpuhTXlU-BlW5KgPPXINqhgY5Z7CQtnhAHiQK0nLsGoLDx86pRx4BVz1aLWOx84oDNrZm62cbkdYQdaxOUfJDMm8LgR0TwO5uZeWTRK1ys8ZjbYY1fz_lT5eHdcjwQZOKAyGQLvHi8ysaYivmXnMHUVEWDEkvTEp4zDqcZT0K1zUXNuxt4-VnJSbS9g%3D%3D)][[2](https://www.google.com/url?sa=E&q=https%3A%2F%2Fvertexaisearch.cloud.google.com%2Fgrounding-api-redirect%2FAUZIYQHyPly0VuqFvhXA2ChbObEq-_rDh02oEk3s4ptZImXSL42aSH9GbuPRpTiiHBaAaSg_xlZaJ0kOg0n2HuROo__U76YkAwXQNcBi5btBnSvzflqCjbkH7Bk8SLxNUyXrI3Q%3D)]

AWS explicitly hardcodes that parameter to reject non-S3 HTTPS links[[3](https://www.google.com/url?sa=E&q=https%3A%2F%2Fvertexaisearch.cloud.google.com%2Fgrounding-api-redirect%2FAUZIYQFdKr1XjuxsL2hkSnm9Evhrbv4LsjdfSiGK34ZeHmXnYZl5GHCXmpbCn0bB-gPy-Tf3hWbnsMO3NeUul0A_X7rNhvBhuXVWWKYmNCYI_vDQq2txkpeqQ-1UlNbYqJMj12L1q6QbZp-Kkv3X5x8pUkh9r6mqRWAcNaQuEO30fAZRNxrn7lme3YOEjQqpXF_MXOXM3eAE3B_45SySRjZfKRsIQamqnftZ)][[4](https://www.google.com/url?sa=E&q=https%3A%2F%2Fvertexaisearch.cloud.google.com%2Fgrounding-api-redirect%2FAUZIYQF_ZJyvpuhTXlU-BlW5KgPPXINqhgY5Z7CQtnhAHiQK0nLsGoLDx86pRx4BVz1aLWOx84oDNrZm62cbkdYQdaxOUfJDMm8LgR0TwO5uZeWTRK1ys8ZjbYY1fz_lT5eHdcjwQZOKAyGQLvHi8ysaYivmXnMHUVEWDEkvTEp4zDqcZT0K1zUXNuxt4-VnJSbS9g%3D%3D)]. They will not fetch from GitHub Pages, Netlify, or raw GitHub URLs.

---

### The Solution: 1-Line Deployment via AWS CloudShell

You can keep this 100% hosted on GitHub / GitHub Pages with **zero external infrastructure, zero cost, and zero server maintenance on your end**.

Instead of a browser link that fails on S3 validation, you leverage **AWS CloudShell**.
Every AWS console has CloudShell built directly into the top navigation bar. It is free, pre-authenticated, and includes the AWS CLI out of the box.

On your GitHub Pages site, your "1-Click" experience looks like this:

> **Deploy to AWS in 60 Seconds:**
>
> ```
> bash <(curl -sSL https://raw.githubusercontent.com/YOUR_USER/YOUR_REPO/main/deploy.sh)
> ```

Because CloudShell runs with the admin’s active AWS session, it executes natively without requiring them to install Node.js, Git, or AWS CLI on their local machine.

---

### The Single-File CloudFormation Trick (No Lambda Zip Files)

Normally, CloudFormation requires you to upload your Lambda code as .zip files to an S3 bucket before deploying. That would break your "GitHub Pages only" rule.

To bypass this completely, we use **CloudFormation Inline Code (ZipFile)**.
The entire gateway—API Gateway, DynamoDB, SQS FIFO, Secrets Manager, and the Lambda handlers (including the Admin SSR Portal)—lives inside **one single template.yaml file** in your GitHub repository.

---

### Complete Code: deploy.sh

Commit this file directly to the root of your GitHub repo. When piped to bash, it prompts the admin for their Encompass details and provisions the entire stack.

```
#!/usr/bin/env bash
# File: deploy.sh
# Description: Automated, zero-dependency 1-line deployment script for Encompass API Gateway.
# Designed to run in AWS CloudShell or standard bash terminal.

set -euo pipefail

# ANSI Color codes for clean output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

STACK_NAME="Encompass-API-Gateway"
GITHUB_RAW_URL="https://raw.githubusercontent.com/YOUR_USER/YOUR_REPO/main/template.yaml"

echo -e "${BLUE}====================================================${NC}"
echo -e "${BLUE}       Encompass API Passthrough Gateway Setup      ${NC}"
echo -e "${BLUE}====================================================${NC}"

# Check AWS CLI existence
if ! command -v aws &> /dev/null; then
    echo -e "${RED}[ERROR] AWS CLI is not installed or available in PATH.${NC}"
    exit 1
fi

# Confirm Active AWS Identity
echo -e "\n${YELLOW}[1/4] Verifying AWS Credentials...${NC}"
CALLER_ARN=$(aws sts get-caller-identity --query "Arn" --output text 2>/dev/null || true)
if [ -z "$CALLER_ARN" ]; then
    echo -e "${RED}[ERROR] No active AWS session detected. Configure AWS CLI or run in AWS CloudShell.${NC}"
    exit 1
fi
echo -e "${GREEN}Deploying as: ${CALLER_ARN}${NC}"

# Collect Encompass Inputs
echo -e "\n${YELLOW}[2/4] Encompass API Configuration...${NC}"
read -rp "Enter Encompass Instance ID (e.g., BE11122233): " ENCOMPASS_INSTANCE
read -rp "Enter Encompass API Client ID: " ENCOMPASS_CLIENT_ID
read -rsp "Enter Encompass API Client Secret: " ENCOMPASS_CLIENT_SECRET
echo ""

if [[ -z "$ENCOMPASS_INSTANCE" || -z "$ENCOMPASS_CLIENT_ID" || -z "$ENCOMPASS_CLIENT_SECRET" ]]; then
    echo -e "${RED}[ERROR] All Encompass parameters are required.${NC}"
    exit 1
fi

# Download Template into Memory/Temp
echo -e "\n${YELLOW}[3/4] Pulling latest template from GitHub...${NC}"
TMP_TEMPLATE=$(mktemp /tmp/encompass-gateway-XXXXXX.yaml)
trap 'rm -f "$TMP_TEMPLATE"' EXIT

if ! curl -sSL "$GITHUB_RAW_URL" -o "$TMP_TEMPLATE"; then
    echo -e "${RED}[ERROR] Failed to fetch template from ${GITHUB_RAW_URL}${NC}"
    exit 1
fi

# Execute CloudFormation Deployment
echo -e "\n${YELLOW}[4/4] Deploying CloudFormation Stack (${STACK_NAME})...${NC}"
echo -e "${BLUE}This step provisions API Gateway, Lambda, SQS FIFO, DynamoDB, and Secrets Manager...${NC}"

aws cloudformation deploy \
  --template-file "$TMP_TEMPLATE" \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
      EncompassInstanceId="$ENCOMPASS_INSTANCE" \
      EncompassClientId="$ENCOMPASS_CLIENT_ID" \
      EncompassClientSecret="$ENCOMPASS_CLIENT_SECRET"

echo -e "\n${GREEN}====================================================${NC}"
echo -e "${GREEN}             DEPLOYMENT SUCCESSFUL!                 ${NC}"
echo -e "${GREEN}====================================================${NC}"

# Fetch Outputs
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[*].[OutputKey, OutputValue]" \
  --output table

echo -e "\n${YELLOW}Next Step:${NC} Open the ${GREEN}AdminPortalUrl${NC} printed above to issue your first vendor API key."
```

---

### Alternative: The "Zero-Terminal" Drag-and-Drop Button

If a lender refuses to touch CloudShell:

This approach keeps everything 100% inside your GitHub repo and GitHub Pages site, without you managing S3 buckets, Netlify backends, or deployment servers.

---

## Assistant

**Defining the Project Scope**

Okay, I'm currently focusing on defining the scope of this "master dev markdown file." I'm identifying the key components: the PRD, the Implementation Guide, and the Dev documentation. It's about structuring a comprehensive repository for project knowledge, encompassing product requirements, development instructions, and implementation details. I'm aiming for clarity in defining the information to be included.

**Refining the Specification**

I've been refining the specification, now including a task list with a new focus on AGENTS.md for AI coding agents. I've updated the plan to reflect design decisions. This includes stateless passthrough, OAuth token caching, synchronous reads with caching and rate limiting, and asynchronous writes with SQS FIFO. I am also working on job status tracking, and the zero-dependency admin portal.

**Structuring the Master Document**

I'm now determining the structure of the master document, titling it "Encompass API Passthrough & Middleware Gateway - Master Dev Document." Part 1 is the PRD, and I've defined its components: Executive Summary, Problem Statement, Target Audience, and Architecture Principles. I'm focusing on core functional requirements like authentication, read passthrough with caching, and asynchronous write pipelines. I'm also planning non-functional requirements such as latency and scalability.

**Outlining the Implementation Guide**

I'm now outlining the implementation guide, focusing on system architecture. I'm detailing the AWS component stack and the OAuth token exchange. I'm also planning the concurrency and rate-limiting engine, which is critical to protecting the Encompass limit. The write pipeline, webhook debouncing, and distribution engine are next.

---

## Assistant

# Master Dev Document: Encompass API Passthrough & Middleware Gateway

---

## Part 1: Product Requirements Document (PRD)

### 1. Executive Summary

Lenders using ICE Mortgage Technology’s Encompass platform face friction onboarding external third-party systems (title companies, appraisal management companies, brokerages, and verification vendors). Encompass enforces strict instance-wide rate limits (typically 30 concurrent API calls), requires manual Super Admin intervention to provision API keys, lacks native external API key scoping, and frequently throws File Lock errors (423 Locked) during concurrent record edits.

This product is a **zero-vendor-footprint, open-source, serverless middleware gateway**. It deploys directly into the lender's AWS account in 60 seconds via a single-line script run inside AWS CloudShell or direct CloudFormation upload. The gateway abstracts Encompass authentication via OAuth 2.0 Persona Token Impersonation, enforces field-level read filtering to keep responses sub-second, cushions Encompass from write spikes using an SQS FIFO queue with exponential backoff, and provides a built-in, zero-dependency SSR Admin Portal to generate scoped API keys.

---

### 2. Architecture Principles & Constraints

---

### 3. Target Audience

---

### 4. Detailed System Requirements

---

### 5. API Specification

#### External API Endpoints (Vendor-Facing)

```
{
  "id": "guid-uuid-1234",
  "fields": {
    "11": "123 Main St",
    "12": "Irvine",
    "14": "CA",
    "1109": 450000.00
  },
  "_cached": false
}
```

```
{
  "fields": {
    "CX.TITLE.STATUS": "Received",
    "CX.TITLE.FEE": 1250.00
  }
}
```

```
{
  "status": "ACCEPTED",
  "jobId": "job-abc-123-xyz",
  "loanId": "guid-uuid-1234",
  "statusUrl": "/v1/jobs/job-abc-123-xyz"
}
```

```
{
  "jobId": "job-abc-123-xyz",
  "loanId": "guid-uuid-1234",
  "status": "COMPLETED", // PENDING | RETRYING | COMPLETED | FAILED
  "attempts": 2,
  "updatedAt": "2026-11-06T15:00:00Z",
  "error": null
}
```

#### Internal / Administrative Endpoints

---

## Part 2: Implementation Guide & Architecture

### 1. System Architecture Diagram

```
[EXTERNAL PARTNERS]
                                       │
                                ( x-api-key )
                                       ▼
                         [ AMAZON API GATEWAY REST API ]
                                       │
            ┌──────────────────────────┼──────────────────────────┐
            ▼                          ▼                          ▼
   GET /portal (SSR)           GET /v1/loans/{id}         PATCH /v1/loans/{id}
   POST /portal (Provision)    (Synchronous Read)         (Async Enqueue)
            │                          │                          │
            ▼                          ▼                          ▼
   ┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐
   │  Admin Portal   │        │   Read Proxy    │        │  Write Enqueue  │
   │  Lambda Handler │        │  Lambda Handler │        │  Lambda Handler │
   └────────┬────────┘        └────────┬────────┘        └────────┬────────┘
            │                          │                          │
            ├────────────┐             │                          ▼
            ▼            ▼             │                ┌──────────────────┐
     [DynamoDB:   [API Gateway         │                │  SQS FIFO Queue  │
      Tenants]     Usage Plan]         │                │(GroupID=LoanId)  │
                                       │                └─────────┬────────┘
                                       │                          │
                                       │                          ▼
                                       │                 ┌─────────────────┐
                                       │                 │  Write Worker   │
                                       │                 │  Lambda Handler │
                                       │                 │ (Max Concurrency│
                                       │                 │     Limit=10)   │
                                       │                 └────────┬────────┘
                                       │                          │
                                       ▼                          ▼
                         ┌───────────────────────────────────────────────┐
                         │          TOKEN CACHE & CLIENT ENGINE          │
                         │   1. Check DynamoDB for valid token by user   │
                         │   2. If expired: Call Secrets Manager ->      │
                         │      Exchange Master for Scoped Persona Token │
                         │   3. Cache token in DynamoDB (TTL = 30m)      │
                         └──────────────────────┬────────────────────────┘
                                                │
                                                ▼
                                   [ICE ENCOMPASS API HOST]
                                  https://api.elliemae.com
```

---

### 2. AWS Component Specifications

#### A. Amazon API Gateway (REST API)

#### B. AWS Secrets Manager

#### C. Amazon DynamoDB Tables

#### D. Amazon SQS FIFO Queue

#### E. AWS Lambda Functions (Inline Bundling via CFN ZipFile)

---

### 3. Core Logic & Execution Flows

#### Flow 1: Scoped Token Generation & DynamoDB Cache

```
Caller (Internal Lambda Engine)
  │
  ├─► Check DynamoDB: `EncompassGatewayTokens` for PK: `encompassUserId`
  │     │
  │     ├─► [Cache Hit: Token valid for > 5 min] ──► Return cached token immediately.
  │     │
  │     └─► [Cache Miss or Expirable]
  │           │
  │           ├─► Retrieve Master Client ID & Secret from AWS Secrets Manager
  │           │
  │           ├─► Call Encompass API: POST https://api.elliemae.com/oauth2/v1/token
  │           │   Headers: Content-Type: application/x-www-form-urlencoded
  │           │   Body:
  │           │     grant_type=urn:ietf:params:oauth:grant-type:token-exchange
  │           │     &client_id=[MASTER_CLIENT_ID]
  │           │     &client_secret=[MASTER_CLIENT_SECRET]
  │           │     &subject_token_type=urn:ietf:params:oauth:token-type:access_token
  │           │     &subject_user_id=[ENCOMPASS_USER_ID]
  │           │
  │           ├─► Store returned token in DynamoDB `EncompassGatewayTokens`:
  │           │   {
  │           │     "encompassUserId": "api_title_vendor",
  │           │     "accessToken": "...",
  │           │     "expiresAt": (CurrentEpoch + response.expires_in - 300)
  │           │   }
  │           │
  │           └─► Return new scoped token.
```

#### Flow 2: Synchronous Read with Projection Filtering

#### Flow 3: Asynchronous FIFO Write Pipeline & File Lock Retries

---

## Part 3: Developer Task List

### Phase 1: Core Infrastructure & Distribution Packaging

### Phase 2: Token Management & Encompass Impersonation Engine

### Phase 3: Synchronous Read Passthrough

### Phase 4: SQS FIFO Write Pipeline & Job Engine

### Phase 5: Self-Serve SSR Admin Portal

### Phase 6: Integration Testing & Verification

---

## Part 4: AGENTS.md (AI Agent & Developer Operating Manual)

### 1. Operating Philosophy

### 2. Standardized Logging Schema

All Lambda handlers **must** output structured JSON to console.log. This enables unified CloudWatch log filtering and immediate troubleshooting when inspecting production issues.

```
// Standard Logging Schema
const log = (level, action, details = {}) => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,              // "INFO" | "WARN" | "ERROR"
    action,             // e.g. "TOKEN_EXCHANGE_SUCCESS", "FILE_LOCK_BACKOFF"
    ...details
  }));
};
```

#### Mandatory Log Events:

---

### 3. Complete Reference Implementation: Core Passthrough Handler (read_proxy.js)

Below is the canonical implementation of the synchronous read router, illustrating the logging standard, token caching, and field-projection handling.

```
/**
 * File: read_proxy.js
 * Description: Synchronous, field-filtered read passthrough for Encompass loans.
 * Runtime: Node.js 20.x (Zero external dependencies).
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secretsManager = new SecretsManagerClient({});

const SECRET_ARN = process.env.ENCOMPASS_SECRET_ARN;
const TENANT_TABLE = process.env.TENANT_TABLE;
const TOKEN_TABLE = process.env.TOKEN_TABLE;
const ENCOMPASS_BASE_URL = "https://api.elliemae.com";

const log = (level, action, details = {}) => {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, action, ...details }));
};

// Cached Secrets Manager credentials in Lambda memory across invocations
let cachedCredentials = null;

async function getEncompassCredentials() {
  if (cachedCredentials) return cachedCredentials;
  log("INFO", "FETCHING_MASTER_SECRETS");
  const res = await secretsManager.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  cachedCredentials = JSON.parse(res.SecretString);
  return cachedCredentials;
}

async function getScopedToken(encompassUserId) {
  const now = Math.floor(Date.now() / 1000);

  // 1. Check DynamoDB Cache
  const tokenRecord = await ddb.send(new GetCommand({
    TableName: TOKEN_TABLE,
    Key: { encompassUserId }
  }));

  if (tokenRecord.Item && tokenRecord.Item.expiresAt > (now + 300)) {
    log("INFO", "TOKEN_CACHE_HIT", { encompassUserId });
    return tokenRecord.Item.accessToken;
  }

  log("INFO", "TOKEN_EXCHANGE_REQUEST", { encompassUserId });
  const credentials = await getEncompassCredentials();

  // 2. Perform OAuth Token Exchange
  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    subject_user_id: encompassUserId
  });

  const response = await fetch(`${ENCOMPASS_BASE_URL}/oauth2/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  if (!response.ok) {
    const errorText = await response.text();
    log("ERROR", "TOKEN_EXCHANGE_FAILED", { status: response.status, errorText });
    throw new Error(`Encompass auth failure: ${response.status}`);
  }

  const tokenData = await response.json();
  const expiresAt = now + (tokenData.expires_in || 1800);

  // 3. Cache Token
  await ddb.send(new PutCommand({
    TableName: TOKEN_TABLE,
    Item: {
      encompassUserId,
      accessToken: tokenData.access_token,
      expiresAt
    }
  }));

  log("INFO", "TOKEN_EXCHANGE_SUCCESS", { encompassUserId, expiresAt });
  return tokenData.access_token;
}

exports.handler = async (event) => {
  const requestId = event.requestContext?.requestId;
  const loanId = event.pathParameters?.id;
  const apiKeyId = event.requestContext?.identity?.apiKeyId;
  const fields = event.queryStringParameters?.fields || "11,12,14,1109"; // Default minimal set

  log("INFO", "READ_REQUEST_RECEIVED", { requestId, loanId, apiKeyId, fields });

  try {
    if (!loanId) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing loanId in path" }) };
    }

    // 1. Resolve Tenant Persona Mapping
    const tenantRecord = await ddb.send(new GetCommand({
      TableName: TENANT_TABLE,
      Key: { apiKeyId }
    }));

    if (!tenantRecord.Item || !tenantRecord.Item.encompassUserId) {
      log("WARN", "TENANT_MAPPING_NOT_FOUND", { apiKeyId });
      return { statusCode: 403, body: JSON.stringify({ error: "Unauthorized tenant mapping" }) };
    }

    const encompassUserId = tenantRecord.Item.encompassUserId;

    // 2. Fetch Cached or Impersonated Token
    const accessToken = await getScopedToken(encompassUserId);

    // 3. Forward Field-Filtered Request to Encompass
    const targetUrl = `${ENCOMPASS_BASE_URL}/encompass/v1/loans/${loanId}?entities=fields&fields=${encodeURIComponent(fields)}`;
    const startTime = Date.now();

    const encompassResponse = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });

    const durationMs = Date.now() - startTime;
    const responseBody = await encompassResponse.text();

    log("INFO", "ENCOMPASS_READ_COMPLETE", {
      loanId,
      status: encompassResponse.status,
      durationMs
    });

    return {
      statusCode: encompassResponse.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=30" // 30s Client Caching
      },
      body: responseBody
    };

  } catch (error) {
    log("ERROR", "READ_HANDLER_EXCEPTION", { message: error.message, stack: error.stack });
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal Gateway Error", details: error.message })
    };
  }
};
```

---

### 4. Verification & Testing Procedures

When a bug or behavior issue is reported:
