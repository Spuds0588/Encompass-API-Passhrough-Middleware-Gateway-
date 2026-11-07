# Security Policy

This is a community-supported template, not a hosted product. Security reports are
welcome and will be handled on a best-effort basis.

## Supported versions

The `main` branch and the latest tagged release are supported. Older commits and
private forks are not. If you deploy a fork, you own its security updates.

## Private vulnerability reporting

**Do not open a public issue for an unpatched vulnerability or include exploit
details, secrets, loan data, API keys, or invite codes in a public issue.**

Use GitHub's private vulnerability reporting / security advisories flow:

1. Open the repository's **Security** tab, then **Advisories**, then **Report a
   vulnerability**.
2. The direct form is
   <https://github.com/Spuds0588/Encompass-API-Passhrough-Middleware-Gateway-/security/advisories/new>.
3. If that form is unavailable, open a minimal public issue asking the
   maintainers to enable a private channel. Do not include vulnerability details
   until a private channel exists.

There is no published security email address. Do not send secrets or personal
data to one. A maintainer will acknowledge a private report when available and
coordinate disclosure through the advisory.

Include the affected commit, the route or template resource, reproduction steps,
impact, and a sanitized proof of concept. Redact client secrets, OAuth tokens,
API keys, invite codes, borrower data, and full upstream response bodies.

## Scope

In scope: the Lambda handler, portal key minting, tenant mapping, invite
validation, API Gateway/CloudFormation configuration, IAM policy, write queue,
and the deployment script. Out of scope: vulnerabilities in Encompass, AWS, or
third-party dependencies; social engineering; and reports that require a live
lender account without a local reproduction.

## Invite lifecycle

Invite codes are **shared per role**, not single-use. A title invite can be used
by multiple title partners and only mints title persona keys. There is no
self-service invite rotation UI.

Rotate a role by redeploying with a new 24+ character `TitleInviteCode`,
`BrokerInviteCode`, or `AppraisalInviteCode` stack parameter. `deploy.sh` accepts
the same values through `TITLE_INVITE_CODE`, `BROKER_INVITE_CODE`, and
`APPRAISAL_INVITE_CODE`. Existing API keys keep working; old invite URLs stop
working immediately after the stack update. If a role's code is omitted,
`deploy.sh` generates a new one, so capture and distribute all three outputs
after every deploy.

Treat invite URLs as bearer secrets: they appear in the query string by design,
and API Gateway access logs deliberately exclude query strings. Do not paste them
into tickets, chat, screenshots, or logs.

## API key lifecycle

Portal provisioning is idempotent for the same normalized role + company name +
email. A conditional DynamoDB claim blocks concurrent double-mints; a repeat
returns the existing key through API Gateway `GetApiKey` with `includeValue=true`.
Plaintext keys are never written to DynamoDB. Complete provisioning records
expire after 24 hours; an abandoned in-progress claim expires after 15 minutes.

To **disable** a compromised key immediately:

```bash
KEY_ID="<apiKeyId from the tenant or provisioning record>"
aws apigateway update-api-key --api-key "$KEY_ID" \
  --patch-operations op=replace,path=/enabled,value=false
```

Then review API Gateway access logs and Lambda logs by `apiKeyId` and
`requestId`, rotate the affected role invite, and mint a replacement key through
the portal. A disabled or missing key is never silently replaced: a repeat
provisioning request returns `409` with `code: API_KEY_UNAVAILABLE`.

To remove a key permanently, first remove its usage-plan association, then
delete it:

```bash
aws apigateway delete-usage-plan-key \
  --usage-plan-id "$USAGE_PLAN_ID" --key-id "$KEY_ID" --key-type API_KEY
aws apigateway delete-api-key --api-key "$KEY_ID"
```

Deletion is irreversible. Disable first so a mistaken deletion does not leave a
working credential behind.

## Orphan-key cleanup

If tenant mapping fails after key creation, the handler deletes the key and
releases the provisioning claim. If that cleanup also fails, it logs
`API_KEY_ORPHANED` with the `apiKeyId` and leaves the claim in place to fail
closed. Investigate those logs, then list keys with `aws apigateway get-api-keys
--name-query tenant-`, compare each key ID with the `apiKeyId` values in the
tenant table, and disable/delete any key with no active tenant mapping. Do not
reuse an orphan key.

## Secret handling

The Encompass client secret belongs in Secrets Manager. API keys, invite codes,
OAuth tokens, upload/download authorization headers, and loan data must never be
committed, logged, cached, or included in reports. See `README.md` and
`agents.md` for the complete data-handling and logging rules.
