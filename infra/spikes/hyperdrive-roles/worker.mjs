// T-1255: the Worker that runs the probe through the two Hyperdrive bindings, HYPERDRIVE_JOB and HYPERDRIVE_APP. It is
// never deployed: run.mjs starts it as a `wrangler dev --remote` session from a wrangler config written to a temporary
// folder, as the spike T-1124 ran its own. It is not part of the product: nothing imports it.
//
// Bindings: HYPERDRIVE_JOB and HYPERDRIVE_APP (the two configurations), and PROBE_TOKEN (a random value run.mjs makes
// for one run). The connection strings come only from the bindings at request time; they are never logged or
// returned, and every error message passes through a redactor made from them. No other variable or secret of the
// environment is read.
//   GET /ready   {"ready": true, ...}: the Worker answers, the token matches, and which bindings are there (opens
//                no database connection)
//   GET /probe   runs probe.mjs through both bindings and returns its result as JSON (200 when its own checks pass,
//                500 otherwise; run.mjs judges it again either way)
import postgres from "postgres";

import { PROBE, SIDES, makeRedactor, runProbe } from "./probe.mjs";

const MIN_TOKEN_LENGTH = 32;

function json(body, status) {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** Why a request is refused, or null. With no token configured, every request is refused. */
export function refusedBy(request, env) {
  const token = typeof env.PROBE_TOKEN === "string" ? env.PROBE_TOKEN : "";
  if (token.length < MIN_TOKEN_LENGTH) return "no probe token is configured";
  if (!sameText(request.headers.get("x-probe-token") ?? "", token))
    return "the probe token is missing or wrong";
  return null;
}

/** Whether each binding is there: a Hyperdrive binding with a connection string. */
export function boundOf(env) {
  return Object.fromEntries(
    SIDES.map((side) => {
      const binding = env[side.binding];
      return [side.binding, typeof binding?.connectionString === "string" && binding.connectionString !== ""];
    }),
  );
}

export default {
  async fetch(request, env) {
    const refused = refusedBy(request, env);
    if (refused !== null) return json({ ok: false, refused }, 403);
    if (request.method !== "GET") return json({ ok: false, error: "only GET" }, 405);
    const { pathname } = new URL(request.url);
    const bound = boundOf(env);
    if (pathname === "/ready") return json({ ready: true, probe: PROBE, bindings: bound }, 200);
    if (pathname !== "/probe") return json({ ok: false, error: "not found" }, 404);
    const missing = SIDES.filter((side) => !bound[side.binding]).map((side) => side.binding);
    if (missing.length > 0) return json({ ok: false, error: `no ${missing.join(" or ")} binding` }, 500);

    const redact = makeRedactor(
      SIDES.map((side) => env[side.binding].connectionString),
      SIDES.map((side) => side.login),
    );
    // fetch_types off: the probe sends no array values, and the type lookup would be one more round trip on every new
    // connection. No startup parameter is sent (no application_name, no search_path, no role), as the Worker's own
    // handle sends none (ADR-014 section 2).
    const open = (binding, options) =>
      postgres(env[binding].connectionString, {
        fetch_types: false,
        connect_timeout: 15,
        onnotice: () => undefined,
        ...options,
      });
    const result = await runProbe({ open, redact });
    return json(result, result.ok ? 200 : 500);
  },
};
