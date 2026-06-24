/**
 * Vitest setup file — loads `.env` at the SDK root before any test runs.
 *
 * This is test-only: the SDK itself never reads `.env` at runtime.
 * Loaded via `setupFiles` in vitest.config.ts.
 *
 * Tolerant of missing .env / missing dotenv package — unit tests don't
 * need any of this. Integration tests check their own required env vars
 * via `describe.skipIf` and skip the whole suite if anything is missing.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "..", ".env");

if (existsSync(envPath)) {
  try {
    // Dynamic import keeps this optional — if dotenv isn't installed (e.g.
    // a slim CI image), tests still run with whatever env is already set.
    const { config } = await import("dotenv");
    config({ path: envPath, override: false });
  } catch {
    // dotenv not installed; rely on the shell env. No-op.
  }
}
