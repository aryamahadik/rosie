// Staging's K-05 calls at a turn's start (the D-017 path audit's P2b: ops/reviews/D-017-path-audit/order_d017.txt line 32;
// T-1395). T-1257 made this file with its final signature; T-1395 binds it and edits nothing else.
//
// The turn's four RootOptions inputs, every call through the root's handle on the runtime side (./part.ts StagingDb.runtime
// over T-1254's ./db.ts; ADR-014 sections 1 and 2): one short-lived client per call from HYPERDRIVE_JOB, the login
// rosie_worker_job, which inherits rosie_job alone, guarded before the call's code runs and ended after it. None is kept
// on the root or for an isolate, and nothing is cached to save a connect.
//
//   bundleReads    K-05 v1 item 7's readActiveBundle and readBundleValue (db/repo/bundles.ts), as rosie_job with no
//                  business scope (DL-345). The port carries no KV: KV stays the actor's BUNDLES binding, which the pin
//                  reads first, with PostgreSQL's copy on a miss and, where no BUNDLES is bound, for every value, each
//                  value checked by its size and sha256 against the manifest its id names (../../bundle/pin.ts,
//                  values.ts). The gateway's active bundle id and the PostgreSQL-down path's probe read through the same
//                  port (../root.ts activeBundleId, postgresAnswers), so once bound the probe answers from the database.
//                  ./options.ts hands these reads to the model readers (./models.ts) and to the bundle's safety lines
//                  (./bundle-safety.ts).
//   handleTargets  K-05 v1.2 item 27 (db/repo/targets.ts), as rosie_job with no business scope (DL-345).
//   frontierScope  K-05 v1.2 item 26's readTurnState under each call's business (default 25): @rosie/actions'
//                  pgFrontierScope over that call's own job client, which opens one read-only transaction, sets the call's
//                  business for it alone, refuses a read naming any other business before anything is read, and checks the
//                  scope again before it ends. Never the Tool API's side: rosie_app holds no grant on handles, persons,
//                  phones or outbox_parts. A frontier call's own bundle reads each open a client of their own while the
//                  scope's stays open, two connections at most for one call (T-1254's cap is one a client).
//   turnRows       K-05 v1.1 item 1 commitTurn (db/repo/commit-turn.ts) and K-05 v1 parkTurn (db/repo/park.ts), each
//                  under the trace its turn names, so the call's timing is written on that trace (./part.ts dbCall).
//                  ../real.ts's turn id check stays in front of both.
//
// Unbound: any environment but staging (checked first, so no binding is read there), or staging with no HYPERDRIVE_JOB
// binding: each input is null, so each port fails closed as it always has (../real.ts NoDatabaseError naming the call): no
// turn's bundle is pinned, no targets are read, every frontier fails closed inside the Tool API base, every commit and
// park fails closed, and the gateway's trace names bundle v0's stand-in. Only the binding's presence is read here; its
// connection string is read by the handle at each call. HYPERDRIVE_APP is never read for these calls.
//
// Bound but failing (the guard's refusal, a connect that fails, DB_SCHEMA set, K-05's transient): the handle's and K-05's
// own answers go back as they are, and each port answers as its contract says: no pin, so no turn's work starts and the
// lease reruns it; no targets, so no text reaches the frontier; the frontier fails closed inside the Tool API base, its
// span failed; a commit not taken and a park tried again; the gateway's trace takes bundle v0's stand-in; the probe reads
// down. A throw carries a call's name and SQLSTATE, or the guard's labels, and nothing else (./db.ts; db/repo and
// pgFrontierScope scrub their own). K-05's answers go back unchanged. Nothing here logs.

import { pgFrontierScope } from "@rosie/actions/src/tool-api/turn-face/pg/frontier";
import { readActiveBundle, readBundleValue } from "@rosie/db/repo/bundles";
import { commitTurn } from "@rosie/db/repo/commit-turn";
import { parkTurn } from "@rosie/db/repo/park";
import { handleTargets } from "@rosie/db/repo/targets";

import { environmentOf } from "../picks";
import type { BundleReadCalls, FrontierScope, HandleTargetsCall, TurnRowCalls } from "../real";
import type { StagingPart } from "./part";

/** What T-1395's builder is handed: the env and the root's handle. */
export type TurnCallsPart = StagingPart;

/** The turn's four RootOptions inputs, each null where it is not bound. */
export interface TurnCallInputs {
  readonly bundleReads: BundleReadCalls | null;
  readonly handleTargets: HandleTargetsCall | null;
  readonly frontierScope: FrontierScope | null;
  readonly turnRows: TurnRowCalls | null;
}

/** None of the four bound: each fails closed as its port does with nothing bound. */
export const NO_TURN_CALL_INPUTS: TurnCallInputs = Object.freeze({
  bundleReads: null,
  handleTargets: null,
  frontierScope: null,
  turnRows: null,
});

/** A binding is present when the env holds an object under its name; its connection string is the handle's to read. */
const isBound = (binding: unknown): boolean => typeof binding === "object" && binding !== null;

/**
 * RootOptions.bundleReads, handleTargets, frontierScope and turnRows for staging: K-05's calls, each on its own job-side
 * client through the root's handle. All null anywhere but staging, and on staging with no HYPERDRIVE_JOB binding.
 */
export const stagingTurnCalls: (part: TurnCallsPart) => TurnCallInputs = ({ env, db }) => {
  if (environmentOf(env) !== "staging" || !isBound(env.HYPERDRIVE_JOB)) return NO_TURN_CALL_INPUTS;
  return {
    bundleReads: {
      readActiveBundle: () => db.runtime("readActiveBundle", (sql) => readActiveBundle(sql)),
      readBundleValue: (request) => db.runtime("readBundleValue", (sql) => readBundleValue(sql, request)),
    },
    handleTargets: (request) => db.runtime("handleTargets", (sql) => handleTargets(sql, request)),
    frontierScope: {
      withBusiness: (businessId, work) =>
        db.runtime("readTurnState", (sql) => pgFrontierScope(sql).withBusiness(businessId, work)),
    },
    turnRows: {
      commitTurn: (request) =>
        db.runtime("commitTurn", (sql) => commitTurn(sql, request), request.turn.traceId),
      parkTurn: (request) => db.runtime("parkTurn", (sql) => parkTurn(sql, request), request.turn.traceId),
    },
  };
};
