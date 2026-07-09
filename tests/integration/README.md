# Noukai Node SDK — Integration Test Suite

Integration tests exercise the SDK against a **real Noukai server** (dev or
production). They are **skipped by default** via `describe.skipIf` and only
run when the required environment variables are set.

---

## When to run

| Trigger | Who | Notes |
|---------|-----|-------|
| Locally, before pushing to `main` | Developer | Fastest feedback loop |
| Nightly CI | GitHub Actions | `.github/workflows/integration.yml` |
| On semver tag push (`v*.*.*`) | GitHub Actions | Same workflow, release gate |
| `workflow_dispatch` | Any contributor | Manual trigger from the Actions UI |

---

## Prerequisites

### 1. Noukai account and fixture project

You need a Noukai project that contains the three fixture flows. If you do not
have one yet:

1. Sign in to Noukai and create an organisation (e.g. `acme`).
2. Create a project (e.g. `sdk-test-fixtures`).
3. Follow `fixtures/README.md` to author the three fixture flows via
   `noukai-mcp`.

### 2. Mint an `nk_*` API key

In the Noukai dashboard (or via the `tokenauth-vendor` API):

```bash
# Example using the tokenauth-vendor API directly:
curl -X POST https://api.noukai.dev/api/v1/projects/acme/sdk-test-fixtures/keys \
  -H "Authorization: Bearer <supabase-jwt>" \
  -d '{"name": "SDK integration tests", "scopes": ["execute"]}'
```

Copy the returned `nk_*` key — it is shown only once.

### 3. Configure environment variables

**Recommended**: copy the example file and edit values in place.

```bash
cd development/noukai/sdk/node
cp .env.example .env
# edit .env with your real key/project/slugs
```

`tests/setup-env.ts` (wired via vitest `setupFiles`) auto-loads `.env`
from the SDK root via the `dotenv` dev dependency. No need to `source`
it manually.

**Alternative**: export inline (no `.env` file).

| Variable | Required | Example |
|----------|----------|---------|
| `NOUKAI_INTEGRATION_KEY` | Yes | `nk_live_abcdef...` |
| `NOUKAI_INTEGRATION_PROJECT` | Yes | `acme/sdk-test-fixtures` |
| `NOUKAI_INTEGRATION_HELLO_SLUG` | Yes | `hello-world` |
| `NOUKAI_INTEGRATION_TWO_STEP_SLUG` | No | `two-step` |
| `NOUKAI_INTEGRATION_TOOLS_SLUG` | No | `tools-enabled` |
| `NOUKAI_ENV` | No | `dev` to target `http://localhost:8080` |
| `NOUKAI_RUN_PROXY_TESTS` | No | `true` to enable the (server-prereq-blocked) run-proxy suite |

When `TWO_STEP_SLUG` / `TOOLS_SLUG` are absent, those test suites are
automatically skipped via `describe.skipIf`. The `.env` file is in
`.gitignore` — never commit it.

---

## Running the tests

### Local — against the dev server

```bash
# Start the dev server first (in a separate terminal)
# cd development/server && make run

export NOUKAI_INTEGRATION_KEY="nk_dev_..."
export NOUKAI_INTEGRATION_PROJECT="acme/sdk-test-fixtures"
export NOUKAI_INTEGRATION_HELLO_SLUG="hello-world"
export NOUKAI_INTEGRATION_TWO_STEP_SLUG="two-step"
export NOUKAI_INTEGRATION_TOOLS_SLUG="tools-enabled"
export NOUKAI_ENV="dev"

cd development/noukai/sdk/node
pnpm test:integration
```

### Local — against staging / production

Same as above but omit `NOUKAI_ENV=dev` (or set it to `production`) and use a
production `nk_*` key:

```bash
export NOUKAI_INTEGRATION_KEY="nk_live_..."
# ... other vars as above ...
unset NOUKAI_ENV   # defaults to production

pnpm test:integration
```

### Run unit tests only (no network)

```bash
pnpm test           # or pnpm test:unit
```

### Run everything

```bash
pnpm test:all
```

---

## Test file overview

| File | Fixture required | Coverage |
|------|-----------------|----------|
| `execute.integration.test.ts` | `hello-world` | `Flow.execute()`, typed result, costUsd wire contract |
| `execute-async.integration.test.ts` | `hello-world` | `Flow.executeAsync()`, `Job.poll()`, `Job.wait()`, timeout |
| `steps.integration.test.ts` | `hello-world` + `two-step` | `Flow.steps()`, StepCompleted events, step count |
| `events.integration.test.ts` | `hello-world` + `two-step` | All major SSE event types, `runRemaining` |
| `tool-calls.integration.test.ts` | `tools-enabled` | Auto/manual tool-call modes, `maxToolRounds` limit |
| `run-proxy.integration.test.ts` | `hello-world` + `two-step` | **BLOCKED** — see below |
| `errors.integration.test.ts` | `hello-world` (project coords only) | AuthenticationError, FlowNotFoundError, statusCode, code |

---

## Blocked tests: run proxy

All tests in `run-proxy.integration.test.ts` are statically skipped via
`SERVER_PREREQ_DONE = false`.

They are blocked until the server adds slug-scoped `/seq/{org}/{project}/{slug}/runs/...`
endpoints that accept `nk_*` API keys:

```
GET /seq/{org}/{project}/{slug}/runs/{executionId}/trace
GET /seq/{org}/{project}/{slug}/runs/{executionId}/trace/stream
GET /seq/{org}/{project}/{slug}/runs/{executionId}/steps/{stepId}/trace
```

Once that server-side work lands, flip `SERVER_PREREQ_DONE = true` in the file
and the tests will run automatically.

---

## CI

The nightly integration workflow is at `.github/workflows/integration.yml`.
It reads secrets and vars from the repository:

| GitHub secret / var | Maps to |
|--------------------|---------|
| `secrets.NOUKAI_INTEGRATION_KEY` | `NOUKAI_INTEGRATION_KEY` |
| `vars.NOUKAI_INTEGRATION_PROJECT` | `NOUKAI_INTEGRATION_PROJECT` |
| `vars.NOUKAI_INTEGRATION_HELLO_SLUG` | `NOUKAI_INTEGRATION_HELLO_SLUG` |
| `vars.NOUKAI_INTEGRATION_TWO_STEP_SLUG` | `NOUKAI_INTEGRATION_TWO_STEP_SLUG` |
| `vars.NOUKAI_INTEGRATION_TOOLS_SLUG` | `NOUKAI_INTEGRATION_TOOLS_SLUG` |

Configure these in **Settings → Secrets and variables → Actions** on the
`noukai/noukai-node` repository before enabling the workflow.

---

## Timeout notes

All integration tests set explicit Vitest timeouts (typically 60–120 s) to
account for LLM latency. The CI job itself is capped at 30 minutes
(`timeout-minutes: 30` in the workflow).

If a test consistently times out, check:
1. The fixture flow is not stuck in a queue.
2. The server is healthy (`GET /health`).
3. The API key has `execute` scope.
