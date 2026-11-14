// Staging's release flags (the D-017 path audit's P1c: ops/reviews/D-017-path-audit/order_d017.txt line 30; T-1393; the
// lead's notes DL-356, DL-476 and DL-757). T-1257 made this file with its final signature; T-1393 binds it and edits
// nothing else (./options.ts hands it its part).
//
// RootOptions.flags (../skeleton.ts ReleaseFlags) over T-185's readFlag (db/repo/flags.ts), on the job side of ADR-014
// only: release_flags is rosie_job's alone (db/migrations/0012_core_rls.sql: rosie_app holds no grant on it, CQ-59), so
// every read runs on the runtime side of the root's handle (part.db.runtime: one short-lived client from HYPERDRIVE_JOB,
// the login rosie_worker_job, guarded and ended by T-1254's handle). HYPERDRIVE_APP is never read here.
//
//   bound    staging with a HYPERDRIVE_JOB binding. `readFlag(name, subject)` runs db/repo's readFlag at every call, so at
//            every webhook (../skeleton.ts reads the skeleton flag first, before anything else). No answer is remembered:
//            `flags.sh off skeleton` closes the Linq route at the next webhook (D-017's rollback), and the test-phone
//            page's send, which posts through the same route (../root.ts), goes only while the flag is on. It answers
//            `{ enabled }` alone, the shape ReleaseFlags names: never readFlag's `decidedBy`, whose scope can be
//            `phone:<number>` and whose value is a setting.
//   unbound  any environment but staging, checked before anything else is read, or staging with no HYPERDRIVE_JOB: null,
//            as the Worker's root has always handed, so the skeleton flag reads off and the Linq route answers 404 with
//            the body unread and nothing verified or reached (../skeleton.ts). flags is no port, so ../picks.ts closes
//            nothing for it: production rests on the environment check, here and in ./options.ts (critic_collisions N1).
//   failing  bound, and the read cannot be made (the handle's refusal, a connect that fails, DB_SCHEMA set, a database
//            error): it throws and never reads off, so the route answers 503 and Linq sends the webhook again
//            (../skeleton.ts). The handle's own errors name the call, the side, the binding and a reason, a check's
//            label or a SQLSTATE (./db.ts). db/repo's readFlag has no catch, and an error of postgres.js carries its
//            statement and the values bound to it, a phone subject among them, so whatever the handle passes through as
//            it came leaves as db/repo/clocks.ts scrubbed("readFlag", error): the call's name and a SQLSTATE or the
//            client's code, nothing else.
//
// Nothing is logged here: the route's one log line holds its stage and the error's name (../../gateway/answer.ts
// logFailure), and the handle writes each call's timing, labels and numbers only (./part.ts dbCallLine). No number,
// address, scope, flag value, token, hash, host, user or password is in a span, a log line or an error.

import { scrubbed } from "@rosie/db/repo/clocks";
import { readFlag } from "@rosie/db/repo/flags";

import { environmentOf } from "../picks";
import type { ReleaseFlags } from "../skeleton";
import type { StagingPart } from "./part";

/** What T-1393's builder is handed: the env (HYPERDRIVE_JOB, read by the handle at each call) and the root's handle. */
export type FlagsPart = StagingPart;

/** The read's name on the handle: on its timing line, and on every error that leaves it. */
export const READ_FLAG_CALL = "readFlag";

/**
 * RootOptions.flags for staging: T-185's readFlag on one job-side client per read, answering `{ enabled }` alone. Null
 * anywhere but staging (no binding read) and where no HYPERDRIVE_JOB is bound, so the skeleton flag reads off.
 */
export const stagingFlags: (part: FlagsPart) => ReleaseFlags | null = ({ env, db }) => {
  if (environmentOf(env) !== "staging") return null;
  // The binding's presence, once, as the root is built; its connection string is the handle's to read, at each call.
  const binding: unknown = env.HYPERDRIVE_JOB;
  if (binding === undefined || binding === null) return null;
  return {
    async readFlag(name, subject) {
      let enabled: boolean;
      try {
        const reading = await db.runtime(READ_FLAG_CALL, (sql) => readFlag(sql, name, subject));
        enabled = reading.enabled;
      } catch (error) {
        throw scrubbed(READ_FLAG_CALL, error);
      }
      return { enabled };
    },
  };
};
