// Spike T-1124: the Worker that runs the probe through the Hyperdrive binding. It is never deployed: run.sh starts
// it as a `wrangler dev --remote` session (or, as the fallback, uploads it as a version that takes no traffic),
// from a wrangler config written to a temporary folder. It is not part of the product: nothing imports it.
//
// Bindings: HYPERDRIVE (the Hyperdrive configuration), PROBE_TOKEN (a random value run.sh makes for one run) and,
// for an uploaded version, PROBE_EXPIRES (epoch milliseconds after which every request is refused).
// The connection string comes only from env.HYPERDRIVE at request time. It is never logged or returned, and every
// error message passes through a redactor made from it.
//   GET /ready    {"ready": true}: the Worker answers and the token matches (opens no database connection)
//   GET /probe    runs probe.mjs and returns its result as JSON (?commits=50..200, default 60)
//   GET /cleanup  drops the schema spike_hyperdrive if a run left it behind
import postgres from "postgres";
import { clampCommits, dropSchema, makeRedactor, runProbe } from "./probe.mjs";

const MIN_TOKEN_LENGTH = 32;

function json(body, status) {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function sameText(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

/** Why a request is refused, or null. With no token configured, every request is refused. */
export function refusedBy(request, env, now = Date.now()) {
  const token = typeof env.PROBE_TOKEN === "string" ? env.PROBE_TOKEN : "";
  if (token.length < MIN_TOKEN_LENGTH) {
    return "no probe token is configured";
  }
  if (env.PROBE_EXPIRES !== undefined && env.PROBE_EXPIRES !== "") {
    const expires = Number(env.PROBE_EXPIRES);
    if (!Number.isFinite(expires) || now > expires) {
      return "this probe has expired";
    }
  }
  if (!sameText(request.headers.get("x-probe-token") ?? "", token)) {
    return "the probe token is missing or wrong";
  }
  return null;
}

export default {
  async fetch(request, env) {
    const refused = refusedBy(request, env);
    if (refused !== null) {
      return json({ ok: false, refused }, 403);
    }
    const { pathname, searchParams } = new URL(request.url);
    if (request.method !== "GET") {
      return json({ ok: false, error: "only GET" }, 405);
    }
    if (pathname === "/ready") {
      return json(
        { ready: true, probe: "T-1124 hyperdrive-host", hyperdrive_bound: env.HYPERDRIVE !== undefined },
        200,
      );
    }
    if (pathname !== "/probe" && pathname !== "/cleanup") {
      return json({ ok: false, error: "not found" }, 404);
    }
    const connectionString = env.HYPERDRIVE?.connectionString;
    if (typeof connectionString !== "string" || connectionString === "") {
      return json({ ok: false, error: "no HYPERDRIVE binding" }, 500);
    }
    const redact = makeRedactor([connectionString]);
    // max 4 + 1: a Worker may hold 6 connections open at once. fetch_types off: the probe sends no array values, and
    // the type lookup would be one more round trip on every new connection.
    const open = (options) =>
      postgres(connectionString, {
        max: 4,
        fetch_types: false,
        connect_timeout: 15,
        onnotice: () => undefined,
        ...options,
      });

    if (pathname === "/cleanup") {
      const sql = open({ max: 1 });
      try {
        return json(await dropSchema(sql), 200);
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 300);
        return json({ ok: false, error: message }, 500);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }

    const result = await runProbe({
      open,
      redact,
      commits: clampCommits(searchParams.get("commits") ?? 60),
      via: "worker",
    });
    return json(result, result.ok ? 200 : 500);
  },
};
