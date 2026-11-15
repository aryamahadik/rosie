// Staging's state reads (the D-017 path audit's SR: ops/reviews/D-017-path-audit/order_d017.txt line 42; T-1400). T-1257
// made this file with its final signature; T-1400 binds it and edits nothing else.
//
//   turnDirectory    RootOptions.turnDirectory (../../turn/types.ts TurnDirectory; ../real.ts realStateReads' partyOf):
//                    who a handle is, which every run of a turn reads first (../../turn/turn.ts) and its park reads the
//                    same way (../../turn/park.ts). partyOf sends K-05 v1.11 item 52's readTurnParty (db/repo/
//                    turn-party.ts; T-1269) the request's K-06 handle alone, its kind and its address, never the actor's
//                    name, on the runtime side of the root's handle (./part.ts StagingDb.runtime over T-1254's ./db.ts;
//                    ADR-014 sections 1 and 2): one short-lived client per call from HYPERDRIVE_JOB, the login
//                    rosie_worker_job, which inherits rosie_job alone, guarded before the read runs and ended after it.
//                    No answer is remembered: each run and each park reads the rows as they stand. The answer is mapped
//                    by one function, turnPartyOf below, exactly as K-05 v1.11's binding line says (README, "Consumers of
//                    v1.11"), so open gap 57's card (T-1272) changes one place.
//   handleDirectory  null, and stoppedFlags null, as the Worker's root has always handed them: no K-05 call names either
//   stoppedFlags     read ("What v1.10 does not name", "What v1.11 does not name"), and neither is built here from other
//                    reads (readTurnParty answers no booking id, which HandleIds holds; build prompt 6.4: a gap is never
//                    filled by a guess). So idsOf and isStopped keep failing closed (../real.ts NoStateReadError) until
//                    a K-05 version names their reads. Neither the first staging turn nor its receipt reaches them.
// Nothing of each text's safety result: a run reads it from its leased turn, which the handle's own actor answers from
// the result its read on arrival kept (ADR-015 section 3; T-1262, T-1264), so no RootOptions input is left for it.
//
// Unbound: any environment but staging (checked first, so no binding is read there, and ../picks.ts keeps the state-reads
// port closed in production whatever it is handed), or staging with no HYPERDRIVE_JOB binding: every input null, so
// partyOf fails closed at once (NoStateReadError "partyOf") with nothing read, and a run ends noDirectory with nothing
// opened, read or written. Only the binding's presence is read here; its connection string is the handle's to read, at
// each call. HYPERDRIVE_APP is never read: rosie_app holds no grant on handles (db/migrations/0012_core_rls.sql).
//
// Bound but failing: the handle's own refusals (./db.ts: the guard's DbGuardRefusal, DbClosedError while DB_SCHEMA is
// set or the binding holds no connection string, a connect that fails as DataAccessDatabaseError) and the read's own
// (a TypeError for a request of the wrong shape, a BrokenRecordError, any other database error scrubbed) are thrown as
// they are: each names a call, a side, the binding's name, a check's label, a field or a SQLSTATE, and never a value.
// K-05's transient answer is thrown too (TurnPartyTransientError: the call's name and the SQLSTATE alone). Every throw
// ends the run noDirectory with nothing opened, read or written, and the lease runs the turn again.
//
// Nothing here logs, and nothing is put in a span: the request holds a person's number or email address, and the actor's
// name holds it too. The handle writes each call's timing, labels and numbers only (./part.ts dbCallLine), on no trace
// (the port's request names none).

import {
  readTurnParty,
  type ReadTurnPartyOutcome,
  type ReadTurnPartyRequest,
} from "@rosie/db/repo/turn-party";

import type { HandleDirectory } from "../../safety/types";
import type { TurnDirectory, TurnParty } from "../../turn/types";
import { environmentOf } from "../picks";
import type { StoppedFlagRead } from "../real";
import type { StagingPart } from "./part";

/** What T-1400's builder is handed: the env and the root's handle. */
export type DirectoryPart = StagingPart;

/** The state reads' RootOptions inputs this part owns, each null where it is not bound. */
export interface DirectoryInputs {
  readonly turnDirectory: TurnDirectory | null;
  readonly handleDirectory: HandleDirectory | null;
  readonly stoppedFlags: StoppedFlagRead | null;
}

/** None of the three bound: each read fails closed (NoStateReadError). */
export const NO_DIRECTORY_INPUTS: DirectoryInputs = Object.freeze({
  turnDirectory: null,
  handleDirectory: null,
  stoppedFlags: null,
});

/** The read's name on the handle: on its timing line, and on the error its transient answer is thrown as. */
export const READ_TURN_PARTY_CALL = "readTurnParty";

/** The zone a party with no business reads its texts' dates in (K-05 v1.11 default 101): the read answers none. */
export const NO_BUSINESS_ZONE = "UTC";

const SQLSTATE = /^[0-9A-Z]{5}$/u;

/**
 * K-05's transient answer to readTurnParty, thrown (K-05 v1.11's binding line): the database could not answer now, so no
 * party is known and the run ends noDirectory with nothing opened, read or written. It carries the call's name and the
 * answer's SQLSTATE (null for one that is no SQLSTATE), and nothing else.
 */
export class TurnPartyTransientError extends Error {
  readonly call: string;
  readonly sqlstate: string | null;

  constructor(sqlstate: unknown) {
    const code = typeof sqlstate === "string" && SQLSTATE.test(sqlstate) ? sqlstate : null;
    super(
      `${READ_TURN_PARTY_CALL}: the database could not answer now (transient${code === null ? "" : `, SQLSTATE ${code}`})`,
    );
    this.name = "TurnPartyTransientError";
    this.call = READ_TURN_PARTY_CALL;
    this.sqlstate = code;
  }
}

/**
 * K-05 v1.11 readTurnParty's answer as the turn's directory gives it (README, "Consumers of v1.11", the runtime
 * engineer's binding), field by field:
 *   atBusiness         as it stands: the handle's id, the one business, the person or null, that business's zone;
 *   noBusiness         the handle's id, no business, the person or null, and the zone UTC (default 101);
 *   unknown            the port's null: no K-04 handle has the request's kind and address, so no turn and no park runs;
 *   businessUndecided  the port's null, whatever its reason (anotherOwner, roleEnded, severalBusinesses): no turn runs,
 *                      and the answer never becomes a party with a business picked or with business null, until open
 *                      gap 57's card (T-1272) maps it to its own path;
 *   transient          thrown (TurnPartyTransientError), as any error the answer names that is none of K-05's two.
 * Nothing else of the answer is handed on: never the reason, and never anything the read did not answer.
 */
export function turnPartyOf(answer: ReadTurnPartyOutcome): TurnParty | null {
  if ("error" in answer) {
    if (answer.error === "businessUndecided") return null;
    throw new TurnPartyTransientError(answer.sqlstate);
  }
  if (answer.handleId === null) return null;
  if (answer.businessId === null) {
    return {
      handleId: answer.handleId,
      businessId: null,
      personId: answer.personId,
      zone: NO_BUSINESS_ZONE,
    };
  }
  return {
    handleId: answer.handleId,
    businessId: answer.businessId,
    personId: answer.personId,
    zone: answer.zone,
  };
}

/** A binding is present when the env holds an object under its name; its connection string is the handle's to read. */
const isBound = (binding: unknown): boolean => typeof binding === "object" && binding !== null;

/**
 * RootOptions.turnDirectory, handleDirectory and stoppedFlags for staging: the turn's directory over K-05 v1.11's
 * readTurnParty, each read on its own job-side client through the root's handle; handleDirectory and stoppedFlags null
 * until a K-05 version names their reads. All null anywhere but staging, and on staging with no HYPERDRIVE_JOB binding.
 */
export const stagingDirectories: (part: DirectoryPart) => DirectoryInputs = ({ env, db }) => {
  if (environmentOf(env) !== "staging" || !isBound(env.HYPERDRIVE_JOB)) return NO_DIRECTORY_INPUTS;
  return {
    turnDirectory: {
      async partyOf({ handle }) {
        // The handle alone, its kind and its address: never the actor's name. A kind K-06 does not have is the read's
        // to refuse, before any statement (a TypeError naming the field).
        const request = { handle: { kind: handle.kind, address: handle.address } } as ReadTurnPartyRequest;
        return turnPartyOf(await db.runtime(READ_TURN_PARTY_CALL, (sql) => readTurnParty(sql, request)));
      },
    },
    handleDirectory: null,
    stoppedFlags: null,
  };
};
