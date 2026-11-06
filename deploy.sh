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
#   ENCOMPASS_CLIENT_SECRET, ADMIN_TOKEN, TEMPLATE_URL

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

STACK_NAME="${STACK_NAME:-Encompass-API-Gateway}"
TEMPLATE_URL="${TEMPLATE_URL:-https://raw.githubusercontent.com/Spuds0588/Encompass-API-Passhrough-Middleware-Gateway-/main/template.yaml}"

say() { printf '%b\n' "$1"; }

say "${BLUE}====================================================${NC}"
say "${BLUE}     Encompass API Passthrough Gateway Setup        ${NC}"
say "${BLUE}====================================================${NC}"

command -v aws >/dev/null 2>&1 || { say "${RED}[ERROR] AWS CLI not found. Run this in AWS CloudShell.${NC}"; exit 1; }
command -v curl >/dev/null 2>&1 || { say "${RED}[ERROR] curl not found.${NC}"; exit 1; }

say "\n${YELLOW}[1/4] Verifying AWS credentials...${NC}"
CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text 2>/dev/null || true)"
if [ -z "$CALLER_ARN" ]; then
  say "${RED}[ERROR] No active AWS session. Open AWS CloudShell or configure the CLI.${NC}"
  exit 1
fi
say "${GREEN}Deploying as ${CALLER_ARN}${NC}"

say "\n${YELLOW}[2/4] Encompass API configuration...${NC}"
ENCOMPASS_INSTANCE="${ENCOMPASS_INSTANCE:-}"
ENCOMPASS_CLIENT_ID="${ENCOMPASS_CLIENT_ID:-}"
ENCOMPASS_CLIENT_SECRET="${ENCOMPASS_CLIENT_SECRET:-}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"

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

if [ -z "$ADMIN_TOKEN" ]; then
  ADMIN_TOKEN="$(openssl rand -hex 24)"
  say "${YELLOW}Generated an admin portal token. Save it now; it is required to create API keys:${NC}"
  say "${GREEN}${ADMIN_TOKEN}${NC}"
fi

say "\n${YELLOW}[3/4] Fetching latest template...${NC}"
TMP_TEMPLATE="$(mktemp "${TMPDIR:-/tmp}/encompass-gateway-XXXXXX.yaml")"
trap 'rm -f "$TMP_TEMPLATE"' EXIT

if ! curl -fsSL "$TEMPLATE_URL" -o "$TMP_TEMPLATE"; then
  say "${RED}[ERROR] Could not download ${TEMPLATE_URL}${NC}"
  exit 1
fi

TEMPLATE_BYTES="$(wc -c < "$TMP_TEMPLATE" | tr -d ' ')"
if [ "$TEMPLATE_BYTES" -gt 51200 ]; then
  say "${RED}[ERROR] Template is ${TEMPLATE_BYTES} bytes; CloudFormation's direct upload limit is 51200.${NC}"
  exit 1
fi
say "${GREEN}Template OK (${TEMPLATE_BYTES} bytes)${NC}"

say "\n${YELLOW}[4/4] Deploying stack ${STACK_NAME}...${NC}"
say "${BLUE}This provisions API Gateway, Lambda, SQS FIFO, DynamoDB, and Secrets Manager.${NC}"

REGION_ARGS=()
if [ -n "${AWS_REGION:-}" ]; then
  REGION_ARGS=(--region "$AWS_REGION")
fi

aws cloudformation deploy \
  "${REGION_ARGS[@]}" \
  --template-file "$TMP_TEMPLATE" \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    EncompassInstanceId="$ENCOMPASS_INSTANCE" \
    EncompassClientId="$ENCOMPASS_CLIENT_ID" \
    EncompassClientSecret="$ENCOMPASS_CLIENT_SECRET" \
    AdminPortalToken="$ADMIN_TOKEN"

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

say "\n${YELLOW}Admin portal:${NC} ${GREEN}${PORTAL_URL}${NC}"
say "${YELLOW}Admin token:${NC}  ${GREEN}${ADMIN_TOKEN}${NC}"
say "${YELLOW}Next:${NC} open the portal, enter the admin token, and provision your first vendor key."
say "${RED}Do not commit the admin token. For stack updates, reuse the same token.${NC}"
