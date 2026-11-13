// The walking skeleton's flag (T-552; build prompt section 10, D-017 'Flag: skeleton (staging only)' and 'Rollback: turn
// off the skeleton flag'; d000-factory-spec ADR-010: flags in a PostgreSQL table, per environment). The Linq webhook route
// the root builds answers only while the skeleton flag is on. The flag is read through T-185's release-flag read
// (db/repo/flags.ts readFlag, its database bound by whoever hands the root its flags), for the global scope, at each
// webhook and before anything else:
//
//   on          the gateway's Linq webhook entry takes the request (runtime/src/gateway, T-241): 401, 200 or 503 as it rules
//   off         404, as for a path the Worker does not serve: the body is not read, nothing is verified, no trace is opened
//               and no handle's actor is reached
//   unreadable  503, so Linq sends the webhook again (it retries a 5xx for 30 minutes: K-11 README spike row 4); nothing
//               is read or reached, as when off
//
// Where the root is handed no flags (the Worker, until staging has its database and the flag's deploy step, T-567 and
// T-569) the flag reads off: code ships with its flags off (build prompt 5.4). Never logged: a body, a phone number, a key.

import type { FlagReading, FlagSubject } from "@rosie/db/repo/flags";

import { logFailure, respond, type WebhookEnvironment } from "../gateway/answer";
import { handleLinqWebhook } from "../gateway/linq-webhook";
import type { GatewayDeps } from "../gateway/types";

/** The walking skeleton's release flag (D-017), on staging only. */
export const SKELETON_FLAG = "skeleton";

/**
 * T-185's release-flag read (db/repo/flags.ts readFlag) with its database bound: the most specific row for the subject
 * decides (the phone's, else the business's, else the global one), and no row at all is off.
 */
export interface ReleaseFlags {
  readFlag(name: string, subject?: FlagSubject): Promise<Pick<FlagReading, "enabled">>;
}

export interface SkeletonRouteDeps {
  /** The gateway's doors the route hands an allowed request to. */
  readonly gateway: GatewayDeps;
  /** The release flags; null where none is bound, so the skeleton flag reads off. */
  readonly flags: ReleaseFlags | null;
  /** Where the Worker runs, for every log line (ADR-009). */
  readonly where: WebhookEnvironment;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The skeleton flag for the global scope: true only for an answer that says on. A throw is left to the caller. */
async function skeletonOn(flags: ReleaseFlags | null): Promise<boolean> {
  if (flags === null) return false;
  const reading: unknown = await flags.readFlag(SKELETON_FLAG);
  return isRecord(reading) && reading.enabled === true;
}

/** The Worker's answer to a path it does not serve (runtime/src/index.ts), with one log line naming the flag. */
function notFound(where: WebhookEnvironment): Response {
  const traceId = crypto.randomUUID();
  console.log(
    JSON.stringify({
      level: "info",
      msg: "not_found",
      trace_id: traceId,
      flag: SKELETON_FLAG,
      environment: where.environment,
      version: where.version,
    }),
  );
  return new Response(JSON.stringify({ ok: false, error: "not_found", trace_id: traceId }), {
    status: 404,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-trace-id": traceId,
    },
  });
}

/** One Linq webhook POST through the route behind the skeleton flag. */
export async function skeletonLinqRoute(request: Request, deps: SkeletonRouteDeps): Promise<Response> {
  let on: boolean;
  try {
    on = await skeletonOn(deps.flags);
  } catch (error) {
    const traceId = crypto.randomUUID();
    logFailure(traceId, "skeletonFlag", error);
    return respond({ status: 503, error: "unavailable" }, traceId);
  }
  if (!on) return notFound(deps.where);
  return handleLinqWebhook(request, deps.gateway, deps.where);
}
