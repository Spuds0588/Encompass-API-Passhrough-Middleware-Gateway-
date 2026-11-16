# Loan ownership binding: how a key maps to a company's loans

Status: implemented for Encompass. Live-tenant confirmation still BLOCKED (see the end).

## The problem this fixes

Before this change a key resolved to a tenant whose `encompassUserId` was a shared
template persona (`PERSONA_BROKER` and friends). Every broker key in a deployment
therefore acted as the *same* Encompass account, and every loan read was authorized by
"does the caller know a loan GUID that account can reach". A broker with 20 files got no
association to those files at signup, and a leaked GUID plus any valid key returned
another company's loan.

## The decision

One Encompass user per brokerage, impersonated per request. The vendor's own loan
visibility becomes the authorization control, so no gateway-side index of
loan-to-company has to exist or stay current.

Two things follow, and both matter:

- The 20 existing files need no association step. They already belong to that user's
  organization in Encompass, so binding the user covers them immediately.
- Reassigning a loan in Encompass stays correct forever. A gateway index would drift.

## How enrollment works

1. The vendor opens the role invite link and submits company name, developer email, and
   the Encompass login the key should act as (`encompassUserId`).
2. The gateway authenticates the **actor** account (password grant, credentials in the
   Secrets Manager payload) and exchanges that token for an impersonation token for the
   named login.
3. It calls `GET /encompass/v1/company/users/me` with that token.
4. The returned identity must equal the requested login, case-insensitively. If it does
   not, or the token cannot be minted, the gateway releases the provisioning claim and
   returns an error. No key, no tenant row.
5. On success it stores `encompassUserId` plus a binding snapshot — personas,
   `subordinateLoanAccess`, `peerLoanAccess`, and `verifiedAt` — and issues the key.

Verification runs **before** `createApiKey`, so a failed binding cannot leave a usable key
behind. `provisioningKeyFor` includes the login, so two companies binding the same login
do not collide and repeats stay idempotent.

## Token flow

```
POST /oauth2/v1/token          grant_type=password
                               username=<actor>@encompass:<instance>
                               password=<actor password>
                               client_id, client_secret, scope=lp
        -> actor token

POST /oauth2/v1/token          grant_type=urn:ietf:params:oauth:grant-type:token-exchange
                               actor_token=<actor token>
                               actor_token_type=urn:ietf:params:oauth:token-type:access_token
                               subject_user_id=<bound login>
                               client_id, client_secret, scope=lp
        -> impersonation token for the bound user
```

The impersonation token is cached per bound login until shortly before expiry. The actor
token is cached in container memory only. Impersonation requires an actor at or above the
target's privilege level, which is why the actor credential is the sensitive secret here.

## Creating the per-brokerage user

Preferred: bind a user that already exists. Zero creation, zero password handling, and the
company's current loan access applies at once.

If a user must be created:

- `POST /encompass/v3/users?orgId={org}` (Encompass 24.2+) with `Id`, `Firstname`,
  `LastName`, `WorkingFolder`, `Email`, `Personas`.
- Caller needs the administrator, Super Administrator, or Organizations/User persona, and
  can only create users in its own organization or child organizations.
- No password is required when the user is `apiUser = true` or `isSsoOnly = true`.
- For TPO companies the self-service route already exists: pre-provision a TPO Account
  Manager persona, and that company's admin creates their own users in TPO Connect. The
  API equivalent is `PATCH /encompass/v3/externalUsers?orgid={org}&action=add&View=entity`.

So the lender does one-time setup per brokerage (accept the company and give it a
least-privilege persona), and the user creation can be automated or delegated. The
lender's Encompass admin is not in the loop per brokerage.

## Configuration added

The Secrets Manager payload needs two new fields in addition to the existing client
credentials:

```json
{ "clientId": "...", "clientSecret": "...", "actorUsername": "...", "actorPassword": "..." }
```

If they are missing, enrollment fails closed with `502 Encompass identity verification
unavailable`. It does not fall back to a shared persona.

## Behaviour change for existing deployments

`POST /portal` now requires `encompassUserId`. A deployment that relied on `PERSONA_*` to
pick the acting account will reject enrollments until the caller supplies a login. That is
intentional: the old path granted access to any loan the shared account could reach.
Tenants already provisioned keep their existing row until re-provisioned, and because
`provisioningKeyFor` changed they will re-mint once.

## Proven locally

`npm run verify` covers, in `test/identity.test.js`:

- enrollment without a login is rejected (`400`)
- enrollment for a login Encompass cannot mint a token for is rejected (`403`)
- the verified binding is what gets stored, not the persona
- the exchange uses an actor token (`state.actorExchanges === 1`)
- a key cannot read a loan owned by another Encompass user (`404`)
- a leaked loan id resolves for its owner's key and `404`s for the other company's key

## Still BLOCKED, and why

1. Confirming on a live tenant that a user created via `POST /encompass/v3/users` (or an
   existing organization user) sees only that organization's loans.
2. Whether `apiUser = true` behaves per user or per partner client id. It pairs a user
   with an `oAuthClientId`, which reads like a partner-app identity; if it cannot be
   per-brokerage, bind a regular user or an `isSsoOnly` user instead.
3. A **gateway-side** ownership check (defense in depth) is not implemented. It needs the
   field that identifies the owning organization on a loan, and inventing an Encompass
   field code is against this repo's rules. Vendor enforcement is the control today; the
   guard becomes worthwhile once the field is confirmed, because it also protects against
   a lender misconfiguring the bound user's persona.
