# Releasing

0. **Check parity with the Python SDK.** Both SDKs share a wire protocol and
   are expected to stay released in lockstep. Run:
   ```bash
   python3 ../noukai-python-sdk/scripts/check_parity.py --ts-repo .
   ```
   Exit codes: `0` in sync, `1` drift detected (review the printed CHANGELOG
   section and either port the missing changes or explicitly accept the drift),
   `2` misconfiguration.
1. Update `package.json` `version` and `CHANGELOG.md` (move `[Unreleased]` content under a dated heading).
2. Commit + push to main.
3. Tag: `git tag v0.1.0 && git push origin v0.1.0`.
4. CI builds + publishes to npm + creates GitHub release.
5. Verify on https://www.npmjs.com/package/@noukai/sdk

## Prerequisites

- `NPM_TOKEN` secret configured in GitHub Settings → Secrets.
- `@noukai` npm scope owned + maintainer permissions granted.
- If using npm OIDC trusted publisher: configure at https://www.npmjs.com/settings/<scope>/trustedpublishers

## Repo extraction note

The SDK currently lives in `development/noukai/sdk/node/` inside the monorepo for fast iteration.
Eventual extraction to `github.com/noukai/noukai-node` is a one-time manual step planned for a
future stable release. The GitHub Actions workflows are written for the standalone repo layout;
adapt paths accordingly when extracting.
