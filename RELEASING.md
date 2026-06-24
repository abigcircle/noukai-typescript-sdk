# Releasing

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
