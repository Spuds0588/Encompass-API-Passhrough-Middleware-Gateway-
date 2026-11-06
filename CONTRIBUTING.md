# Contributing

This project is community-supported. It is an independent open-source template,
not a vendor-hosted service and not affiliated with ICE Mortgage Technology. The
maintainers do not have a live Encompass developer instance or a lender AWS
account, so real-world validation is a shared responsibility. Please contribute
what you learn back to the project.

## Ways to help

- Report reproducible bugs with a minimal case.
- Submit fixes with regression tests.
- Share sanitized field-shape responses from a real Encompass tenant.
- Run the stack in an AWS sandbox and report what worked or failed.
- Improve the docs, agent directions, SEO/AEO page, or local fakes.
- Review other pull requests.

If you find a bug while deploying the template for a lender, do not leave the fix
only in a private fork. Upstream the smallest fix so the next deployment benefits.

## Before opening an issue

1. Search [existing issues](https://github.com/Spuds0588/Encompass-API-Passhrough-Middleware-Gateway-/issues) first.
2. Run `npm run verify` and include the result.
3. Try to reproduce with the local fake in `dev/fake-encompass.js` and the local
   server with `npm run dev`.
4. Reduce the report to one endpoint and one unexpected behavior where possible.

A useful bug report includes:

- The commit SHA or release you tested.
- Node.js version, and whether you used the local fake, AWS, a real Encompass
  tenant, or a combination.
- Expected behavior and actual behavior.
- Steps to reproduce.
- Sanitized request/response examples and logs.
- Whether `npm run verify` passes.
- The smallest test or fake change that reproduces the issue.

Never include client secrets, API keys, invite codes, OAuth tokens, loan data,
personally identifiable information, or full upstream payloads. Rotate any
credential that was exposed before posting a redacted report. For an unpatched
security issue, use GitHub's private vulnerability reporting for this repository
if it is available; otherwise open a minimal issue without exploit details and
ask for a private follow-up channel.

## Pull requests

1. Fork the repository and create a focused branch.
2. Make the smallest change that fixes the problem. Do not add speculative
   features, new services, or dependencies.
3. Add or update a test that fails before the change.
4. If `src/gateway.js` or `infra/template.yaml` changed, run:

   ```bash
   npm run build
   npm run verify
   ```

5. Optionally lint the generated template. Install `cfn-lint` outside the repo,
   run it, and remove the temporary install:

   ```bash
   python3 -m pip install --quiet --target /tmp/cfnlint cfn-lint
   PYTHONPATH=/tmp/cfnlint /tmp/cfnlint/bin/cfn-lint template.yaml
   rm -rf /tmp/cfnlint
   ```

6. Update the relevant docs when behavior, API, deployment, or security changes:
   `README.md`, `agents.md`, `llms.txt`, `index.html`, and `todo.md`. Maintainers
   should also append to `history.md`; it is an append-only work log.
7. Open the pull request with:
   - What changed and why.
   - Tests run and their results.
   - What was not tested, especially live Encompass or AWS behavior.
   - Any migration, security, or compatibility impact.

CI must pass on Node 20 and Node 24, and `template.yaml` must stay in sync with
the generated build.

## Testing against a real environment

If you have access to an Encompass developer instance or an AWS sandbox:

- Run `deploy.sh` in CloudShell and record the stack outputs.
- Provision one key per role and confirm a mismatched role is rejected.
- Exercise `/v1/fields` with standard and `CX.*` fields.
- Exercise a read, an async write, a retry case, and a job status.
- Report the result with sanitized logs, the Encompass API version or instance
  type, and the exact response shapes that differed from the local fake.

Do not test against production loan data. Use a sandbox and redact all customer
information before sharing anything publicly.

## Community expectations

Keep discussion specific and respectful. Assume good faith, focus on reproducible
behavior, and document uncertainty honestly. A clear bug report with no fix is
more useful than an unverified patch that hides the failure.

By contributing, you agree that your contribution is licensed under the
repository's MIT License.
