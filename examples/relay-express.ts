/**
 * Runnable example: serve a flow to a browser via the relay adapter.
 *
 * Design: 20260903-SDK-agent-relay (PR-1).
 *
 * Your server holds the `nk_` key and exposes a keyless `POST /agent/execute`
 * that a browser drives. The relay bounds abuse, runs your `authorize` hook,
 * then forwards the request verbatim to the flow's `/execute` endpoint and
 * relays the upstream response back unchanged.
 *
 * Run it:
 *   pnpm add @noukai/sdk express
 *   NOUKAI_API_KEY=nk_... npx tsx examples/relay-express.ts
 *
 * Then, as a browser would (no key; x-role gates the maker check):
 *   curl -sS localhost:8000/agent/execute \
 *     -H 'content-type: application/json' -H 'x-role: maker' \
 *     -d '{"messages":[{"role":"user","content":"make me a spelling pack"}],
 *          "tools":[],"toolChoice":"auto"}'
 */

import express from "express";
import { Noukai } from "@noukai/sdk";
import { noukaiRelayHandler } from "@noukai/sdk/adapters/express";

// The client holds the nk_ bearer server-side; the browser never sees it.
const noukai = new Noukai({ apiKey: process.env.NOUKAI_API_KEY ?? "nk_example" });

const app = express();

// IMPORTANT: do NOT mount a JSON body parser on the relay route — the relay
// reads the raw body so it can bound the bytes before parse.
app.post(
  "/agent/execute",
  noukaiRelayHandler({
    client: noukai,
    org: "acme",
    project: "spelling",
    slug: "pack-maker",
    // App authorization — throw to reject. Stays in your app, never in the SDK.
    // An error carrying a numeric `status` is honored; anything else → 403.
    authorize: (req) => {
      if (req.headers["x-role"] !== "maker") {
        throw Object.assign(new Error("maker role required"), { status: 403 });
      }
    },
    bounds: { maxBodyBytes: 262_144, maxMessages: 40 },
  }),
);

app.listen(8000, () => {
  console.log("relay listening on http://127.0.0.1:8000/agent/execute");
});
