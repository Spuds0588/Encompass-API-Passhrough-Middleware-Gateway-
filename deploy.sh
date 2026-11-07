#!/usr/bin/env bash
# One-line deployment for the Encompass API Passthrough Gateway.
#
# Run inside AWS CloudShell (no local tooling needed) or any shell with
# authenticated AWS CLI v2:
#
#   bash <(curl -sSL https://raw.githubusercontent.com/Spuds0588/Encompass-API-Passhrough-Middleware-Gateway-/main/deploy.sh)
#
# Optional environment overrides:
#   STACK_NAME, AWS_REGION, ENCOMPASS_INSTANCE, ENCOMPASS_CLIENT_ID,
#   ENCOMPASS_CLIENT_SECRET, TITLE_INVITE_CODE, BROKER_INVITE_CODE,
#   APPRAISAL_INVITE_CODE, TITLE_PERSONA, BROKER_PERSONA, APPRAISAL_PERSONA,
#   TEMPLATE_REF, TEMPLATE_SHA256, TEMPLATE_URL, ARTIFACT_BUCKET
#
# The template is fetched from the pinned v0.1.0 release tag and verified against
# its SHA-256 before deployment. The tag is only a locator; the digest is the
# integrity anchor, so a moved or mistyped tag fails closed. The client secret and invite codes are written to a 0600
# temporary parameter file and passed as file://, never as process arguments.
#
# Templates up to 51,200 bytes deploy directly. Larger templates are uploaded
# to an S3 bucket (created automatically unless ARTIFACT_BUCKET is set), which
# raises CloudFormation's template limit to 1,000,000 bytes.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

STACK_NAME="${STACK_NAME:-Encompass-API-Gateway}"
TEMPLATE_REF="${TEMPLATE_REF:-v0.1.0}"
TEMPLATE_SHA256="${TEMPLATE_SHA256:-4e62005bcf5b85468c8d1ce75c6416493b80b50b8f4caa953a72c7fba766384e}"
TEMPLATE_URL="${TEMPLATE_URL:-https://raw.githubusercontent.com/Spuds0588/Encompass-API-Passhrough-Middleware-Gateway-/${TEMPLATE_REF}/template.yaml}"

say() { printf '%b\n' "$1"; }

say "${BLUE}====================================================${NC}"
say "${BLUE}     Encompass API Passthrough Gateway Setup        ${NC}"
say "${BLUE}====================================================${NC}"

command -v aws >/dev/null 2>&1 || { say "${RED}[ERROR] AWS CLI not found. Run this in AWS CloudShell.${NC}"; exit 1; }
command -v curl >/dev/null 2>&1 || { say "${RED}[ERROR] curl not found.${NC}"; exit 1; }
command -v openssl >/dev/null 2>&1 || { say "${RED}[ERROR] openssl not found; set invite codes manually.${NC}"; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { say "${RED}[ERROR] sha256sum not found.${NC}"; exit 1; }
command -v jq >/dev/null 2>&1 || { say "${RED}[ERROR] jq not found; install jq or use CloudShell.${NC}"; exit 1; }
if ! printf '%s' "$TEMPLATE_SHA256" | grep -Eq '^[0-9a-fA-F]{64}$'; then
  say "${RED}[ERROR] TEMPLATE_SHA256 must be a 64-character hex digest.${NC}"; exit 1
fi

say "\n${YELLOW}[1/4] Verifying AWS credentials...${NC}"
CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text 2>/dev/null || true)"
if [ -z "$CALLER_ARN" ]; then
  say "${RED}[ERROR] No active AWS session. Open AWS CloudShell or configure the CLI.${NC}"
  exit 1
fi
AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
say "${GREEN}Deploying as ${CALLER_ARN}${NC}"

say "\n${YELLOW}[2/4] Encompass API configuration...${NC}"
ENCOMPASS_INSTANCE="${ENCOMPASS_INSTANCE:-}"
ENCOMPASS_CLIENT_ID="${ENCOMPASS_CLIENT_ID:-}"
ENCOMPASS_CLIENT_SECRET="${ENCOMPASS_CLIENT_SECRET:-}"

[ -n "$ENCOMPASS_INSTANCE" ] || read -rp "Encompass instance ID (e.g. BE11122233): " ENCOMPASS_INSTANCE
[ -n "$ENCOMPASS_CLIENT_ID" ] || read -rp "Encompass API client ID: " ENCOMPASS_CLIENT_ID
if [ -z "$ENCOMPASS_CLIENT_SECRET" ]; then
  read -rsp "Encompass API client secret: " ENCOMPASS_CLIENT_SECRET
  echo
fi

if [ -z "$ENCOMPASS_INSTANCE" ] || [ -z "$ENCOMPASS_CLIENT_ID" ] || [ -z "$ENCOMPASS_CLIENT_SECRET" ]; then
  say "${RED}[ERROR] Instance ID, client ID, and client secret are all required.${NC}"
  exit 1
fi

# Role-scoped invite codes. A vendor with one code cannot mint keys for another role.
TITLE_INVITE_CODE="${TITLE_INVITE_CODE:-$(openssl rand -hex 24)}"
BROKER_INVITE_CODE="${BROKER_INVITE_CODE:-$(openssl rand -hex 24)}"
APPRAISAL_INVITE_CODE="${APPRAISAL_INVITE_CODE:-$(openssl rand -hex 24)}"
TITLE_PERSONA="${TITLE_PERSONA:-api_title_template}"
BROKER_PERSONA="${BROKER_PERSONA:-api_broker_template}"
APPRAISAL_PERSONA="${APPRAISAL_PERSONA:-api_appraisal_template}"

say "${GREEN}Role invite codes are ready (printed with links after deployment).${NC}"

say "\n${YELLOW}[3/4] Fetching pinned template...${NC}"
TMP_TEMPLATE="$(mktemp "${TMPDIR:-/tmp}/encompass-gateway-XXXXXX.yaml")"
TMP_PARAMS="$(mktemp "${TMPDIR:-/tmp}/encompass-gateway-params-XXXXXX.json")"
chmod 600 "$TMP_PARAMS"
trap 'rm -f "$TMP_TEMPLATE" "$TMP_PARAMS"' EXIT

if ! curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 \
  "$TEMPLATE_URL" --output "$TMP_TEMPLATE"; then
  say "${RED}[ERROR] Could not download ${TEMPLATE_URL} over TLS.${NC}"
  exit 1
fi

ACTUAL_SHA256="$(sha256sum "$TMP_TEMPLATE" | awk '{print $1}')"
EXPECTED_SHA256="$(printf '%s' "$TEMPLATE_SHA256" | tr '[:upper:]' '[:lower:]')"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  say "${RED}[ERROR] Template SHA-256 mismatch.${NC}"
  say "${RED}Expected: ${EXPECTED_SHA256}${NC}"
  say "${RED}Actual:   ${ACTUAL_SHA256}${NC}"
  exit 1
fi

TEMPLATE_BYTES="$(wc -c < "$TMP_TEMPLATE" | tr -d ' ')"
if [ "$TEMPLATE_BYTES" -gt 1000000 ]; then
  say "${RED}[ERROR] Template is ${TEMPLATE_BYTES} bytes; the S3-hosted CloudFormation limit is 1000000.${NC}"
  exit 1
fi

S3_ARGS=()
if [ "$TEMPLATE_BYTES" -gt 51200 ]; then
  ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-encompass-gateway-cfn-${AWS_ACCOUNT_ID}-${AWS_REGION:-us-east-1}}"
  ARTIFACT_BUCKET="$(printf '%s' "$ARTIFACT_BUCKET" | tr '[:upper:]' '[:lower:]' | cut -c1-63)"
  if ! aws s3api head-bucket --bucket "$ARTIFACT_BUCKET" >/dev/null 2>&1; then
    say "${YELLOW}Creating template bucket s3://${ARTIFACT_BUCKET}...${NC}"
    if [ -n "${AWS_REGION:-}" ] && [ "$AWS_REGION" != "us-east-1" ]; then
      aws s3 mb "s3://$ARTIFACT_BUCKET" --region "$AWS_REGION" >/dev/null
    else
      aws s3 mb "s3://$ARTIFACT_BUCKET" >/dev/null
    fi
  fi
  S3_ARGS=(--s3-bucket "$ARTIFACT_BUCKET")
  say "${GREEN}Template OK (${TEMPLATE_BYTES} bytes); uploading via s3://${ARTIFACT_BUCKET}${NC}"
else
  say "${GREEN}Template OK (${TEMPLATE_BYTES} bytes); direct upload${NC}"
fi

say "\n${YELLOW}[4/4] Deploying stack ${STACK_NAME}...${NC}"
say "${BLUE}This provisions API Gateway, Lambda, SQS FIFO, DynamoDB, and Secrets Manager.${NC}"

REGION_ARGS=()
if [ -n "${AWS_REGION:-}" ]; then
  REGION_ARGS=(--region "$AWS_REGION")
fi

# Keep secrets out of process arguments. jq reads them from the environment in
# a subshell; only this protected file path is passed to the AWS CLI.
if ! (
  export ENCOMPASS_INSTANCE ENCOMPASS_CLIENT_ID ENCOMPASS_CLIENT_SECRET
  export TITLE_INVITE_CODE BROKER_INVITE_CODE APPRAISAL_INVITE_CODE
  export TITLE_PERSONA BROKER_PERSONA APPRAISAL_PERSONA
  jq -n '[
    {ParameterKey:"EncompassInstanceId",ParameterValue:env.ENCOMPASS_INSTANCE},
    {ParameterKey:"EncompassClientId",ParameterValue:env.ENCOMPASS_CLIENT_ID},
    {ParameterKey:"EncompassClientSecret",ParameterValue:env.ENCOMPASS_CLIENT_SECRET},
    {ParameterKey:"TitleInviteCode",ParameterValue:env.TITLE_INVITE_CODE},
    {ParameterKey:"BrokerInviteCode",ParameterValue:env.BROKER_INVITE_CODE},
    {ParameterKey:"AppraisalInviteCode",ParameterValue:env.APPRAISAL_INVITE_CODE},
    {ParameterKey:"TitleServiceUserId",ParameterValue:env.TITLE_PERSONA},
    {ParameterKey:"BrokerServiceUserId",ParameterValue:env.BROKER_PERSONA},
    {ParameterKey:"AppraisalServiceUserId",ParameterValue:env.APPRAISAL_PERSONA}
  ]' > "$TMP_PARAMS"
); then
  say "${RED}[ERROR] Could not prepare parameter overrides.${NC}"
  exit 1
fi

aws cloudformation deploy \
  "${REGION_ARGS[@]}" \
  "${S3_ARGS[@]}" \
  --template-file "$TMP_TEMPLATE" \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "file://$TMP_PARAMS"

say "\n${GREEN}====================================================${NC}"
say "${GREEN}             DEPLOYMENT SUCCESSFUL                  ${NC}"
say "${GREEN}====================================================${NC}"

aws cloudformation describe-stacks \
  "${REGION_ARGS[@]}" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs" \
  --output table

PORTAL_URL="$(aws cloudformation describe-stacks \
  "${REGION_ARGS[@]}" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='AdminPortalUrl'].OutputValue" \
  --output text)"

say "\n${YELLOW}Portal:${NC} ${GREEN}${PORTAL_URL}${NC}"
say "${YELLOW}Title invite:${NC}     ${GREEN}${PORTAL_URL}?role=title&code=${TITLE_INVITE_CODE}${NC}"
say "${YELLOW}Broker invite:${NC}    ${GREEN}${PORTAL_URL}?role=broker&code=${BROKER_INVITE_CODE}${NC}"
say "${YELLOW}Appraisal invite:${NC} ${GREEN}${PORTAL_URL}?role=appraisal&code=${APPRAISAL_INVITE_CODE}${NC}"
say "${YELLOW}Personas:${NC} title=${TITLE_PERSONA} broker=${BROKER_PERSONA} appraisal=${APPRAISAL_PERSONA}"
say "${RED}These links are bearer secrets. Share each role's link only with that role's partners, and reuse the same codes on stack updates.${NC}"
