// The turn face's frontier hop on PostgreSQL (T-315; C-074, C-075; K-05 v1.2 item 26 and its default 25): the business
// scope buildFrontier runs under, and the repo the frontier reads the turn's stored state through inside it.
//
// How the call's business scope reaches readTurnState:
//   1. The Tool API base (../../tool-api.ts) checks the request against K-09 v1, takes the business from its
//      caller.businessId, refuses a call that names none (noBusinessScope) before anything is read, and runs the
//      frontier's handler inside withBusiness(that business) below, with the repo withBusiness hands it.
//   2. withBusiness opens one transaction on the runtime client, whose connections run as rosie_job: read only, at
//      repeatable read, so every read of the call is one moment's (K-05 v1.2 readTurnState: "one read of the primary").
//      T-219's runtime transaction clears any scope first; the business is then set for this transaction alone
//      (set_config(rosie.business_id, ..., true)), so the scope ends with the transaction and never stays on a pooled
//      connection.
//   3. The frontier names the call's business (the call context's businessId: the request's caller.businessId) in each
//      readTurnState request, and the repo reads through T-219's readTurnStateIn on that same transaction, which refuses
//      to read anything (BusinessScopeError) unless requireBusinessScope answers that very business: a request naming any
//      other business, or a transaction with no scope, is never read.
//   4. Before the transaction ends, withBusiness checks with requireBusinessScope that the scope is still that business,
//      so nothing read under another scope is ever answered.
// Under the scope, rosie_job's row-level security (0012's runtime policies) shows that business's rows only, and
// readTurnState also names the business in each read of a business-scoped table, so no other business's open question,
// outbox row, role, booking, pause, consent or fact row is read. Rows K-04 scopes none (the handle, its people, its phone)
// are read as on any side.
//
// Why rosie_job (K-05 v1.2 item 26, default 25): readTurnState also reads tables only the runtime side holds (handles,
// person_handles, persons, phones, outbox_parts), and 0012 grants rosie_app none of them. With no scope rosie_job reads
// every business's rows (T-1094's note N2), which step 3 refuses before the first read (STATE's note 22).
//
// The visit times of bookings (FrontierRepo.readVisitTimes) have no K-05 call yet (K-05 v1.2 open gap 25): each booking is
// answered with no visit time, so the frontier offers none of its options (fail closed: frontier/assemble/types.ts). The
// facts and the frame read through readTurnState only. Nothing here logs; an error names a field, a table or a code.
//
// When the database cannot be reached (T-1315; T-1268's transientOrThrow; K-05 README: `transient`, nothing was written
// and the same request may be sent again; ADR-014 section 2: never a connection string, a host, a user or a password):
// the transaction's start (step 2: its first statement, its reserved connection, its begin and both settings) and each
// read go through transientOrThrow under the frontier's K-05 call's name, readTurnState, as K-05's own readTurnState
// does (db/repo/turn-state.ts). So a connection that never opened (08001: a closed port, a name that never resolves,
// postgres.js's CONNECT_TIMEOUT) or was lost (08006, 57P01 to 57P03) answers transient, and a session refused at its
// start (PostgreSQL's class 28 and 53300, a TLS or certificate error, EACCES, postgres.js's SASL_SIGNATURE_MISMATCH) is
// thrown scrubbed: the call's name and the code alone (db/repo/clocks.ts scrubbed). Neither holds the error's message,
// host, port, user, password, statement or values. When the start answers transient, `work` gets a repo that reads
// nothing and answers that transient to each read (unstartedRepo), so the frontier answers it as it answers a read's
// transient, as buildFrontier's own error inside the Tool API base, its span failed. Nothing is read without the
// transaction: that repo never touches the database.
//
// The transaction's end (T-1330; T-1315's handoff a), once `work` has its repo:
//   - `work` answered: a failure of the scope read (step 4) or of the commit is thrown scrubbed under readTurnState
//     (db/repo/clocks.ts scrubbed: the call's name and the code alone; db/repo's own BusinessScopeError as it is). It is
//     never answered transient in place of the answer `work` gave, and never leaves as postgres.js raises it, host and
//     port in its message and on its properties.
//   - `work` threw: its own error leaves, scrubbed the same way (db/repo's and the Tool API base's own errors, such as
//     the base's error answer, as they are), even when inRuntimeTransaction's rollback fails and throws its own error in
//     its place (db/repo/targets.ts).
//   - A read, or the scope read, whose failure found the connection gone (a lost or never-opened connection answered
//     transient, 08xxx or 57P01 to 57P03, or a session's failure) leaves nothing more to send on it. postgres.js 3.4.9
//     writes a statement on a reserved connection whose socket has closed to no socket at all, from a timer: the write
//     throws outside any promise and the statement never settles. So the scope hands inRuntimeTransaction a failure it
//     reads as a lost connection (db/repo/bundles.ts isLostConnection), which writes no rollback on it and never releases
//     it; the scope read and the commit are not sent; and what leaves is `work`'s own error, or the scrubbed failure.

import { isLostConnection } from "../../../../../db/repo/bundles";
import { DataAccessDatabaseError, scrubbed } from "../../../../../db/repo/clocks";
import {
  assertBusinessId,
  BusinessScopeError,
  requireBusinessScope,
  SCOPE_SETTING,
  type Sql,
  type Tx,
} from "../../../../../db/repo/scope";
import {
  inRuntimeTransaction,
  isSessionFailure,
  transientOrThrow,
  type TransientError,
} from "../../../../../db/repo/targets";
import { readTurnStateIn } from "../../../../../db/repo/turn-state";
import type { FrontierRepo, ReadTurnStateAnswer } from "../../../frontier";
import type { BusinessScope } from "../../scope";
import { createTurnFace, type TurnFace, type TurnFaceOptions } from "../turn-face";

/**
 * The K-05 call the frontier's transaction is opened for (K-05 v1.2 readTurnState, its one K-05 call): the name a
 * scrubbed error of its start or of its read carries (T-1268's call-name argument; T-1315).
 */
const FRONTIER_CALL = "readTurnState";

/**
 * The SQLSTATE a session's failure (isSessionFailure) finds the connection gone with: 08006, connection_failure, as
 * transientOrThrow answers a lost connection (T-1330).
 */
const CONNECTION_FAILURE = "08006";

/**
 * What the statements of one transaction found of its connection (T-1330): the SQLSTATE of the first failure that found
 * it gone, else null. Once it is gone, the scope sends nothing more on it (see the top of this file).
 */
interface ConnectionSeen {
  gone: string | null;
}

/**
 * The SQLSTATE a statement's failure leaves the transaction's connection gone with, else null (T-1330): a session's
 * failure (a client's error with a connection's marks or code, PostgreSQL's refusal of a session) as connection_failure;
 * a failure transientOrThrow answers transient with a lost or never-opened connection's SQLSTATE (08xxx, 57P01 to 57P03,
 * which inRuntimeTransaction reads as a lost connection: isLostConnection). A serialization failure or a deadlock
 * (40001, 40P01), a statement's own refusal and db/repo's own errors leave it as it was.
 */
function goneWith(error: unknown): string | null {
  if (isSessionFailure(error)) return CONNECTION_FAILURE;
  try {
    const { sqlstate } = transientOrThrow(error, FRONTIER_CALL);
    return isLostConnection({ code: sqlstate }) ? sqlstate : null;
  } catch {
    // Not transient and not a session's failure: the connection is as it was.
    return null;
  }
}

/**
 * Thrown to inRuntimeTransaction in place of a failure that found the transaction's connection gone (T-1330): its code is
 * that SQLSTATE, a lost connection's, so inRuntimeTransaction writes no rollback on the connection and never releases it.
 * It never leaves pgFrontierScope: `failure` leaves in its place, scrubbed.
 */
class ConnectionGone extends Error {
  override name = "ConnectionGone";
  readonly code: string;
  readonly failure: unknown;

  constructor(code: string, failure: unknown) {
    super("the transaction's connection is gone: nothing more is sent on it");
    this.code = code;
    this.failure = failure;
  }
}

/**
 * The frontier's repo on one transaction that already runs under the call's business scope (pgFrontierScope). A read the
 * database cannot answer now (a serialization failure, a deadlock or a lost connection) answers transient; a session's
 * failure is thrown scrubbed under readTurnState's name, and any other failure as it is, so the call fails closed. A
 * failure that leaves the connection gone is noted in `seen` (T-1330), for the scope's end.
 */
export function pgFrontierRepo(db: Sql | Tx, seen: ConnectionSeen = { gone: null }): FrontierRepo {
  return {
    async readTurnState(request) {
      try {
        // T-219 types K-05 v1.2's answer by hand (db/repo/turn-state.ts); the frontier takes the type generated from the
        // same frozen schema (ADR-005), whose JSON values are typed as objects. The tests hold each answer to that schema.
        return (await readTurnStateIn(db, request)) as ReadTurnStateAnswer;
      } catch (error) {
        seen.gone ??= goneWith(error);
        return transientOrThrow(error, FRONTIER_CALL);
      }
    },
    readVisitTimes(request) {
      return Promise.resolve({
        result: "visits",
        visits: request.bookingIds.map((bookingId) => ({ bookingId, visitAt: null })),
      });
    },
  };
}

/**
 * The frontier's repo when its transaction never started and the start answered `transient` (T-1315): every read
 * answers that transient and reads nothing, never touching the database.
 */
function unstartedRepo(transient: TransientError): FrontierRepo {
  return {
    readTurnState: () => Promise.resolve({ ...transient }),
    readVisitTimes: () => Promise.resolve({ ...transient }),
  };
}

/**
 * The business scope of the frontier hop on `runtime`, the primary handle of a client whose connections run as
 * rosie_job (uncached: arch 10 lines 504, 538): one read-only transaction at repeatable read per call, scoped to the
 * call's business before the repo is handed over, and refused unless it still is at the end (see the top of this file).
 * A start that fails goes through transientOrThrow under readTurnState's name: transient, and `work` gets a repo that
 * answers it to each read and reads nothing; else the scrubbed error, or the error as it is (the top of this file).
 * Once `work` has its repo, what leaves is scrubbed (T-1330): `work`'s own error when it threw, else the end's failure.
 */
export function pgFrontierScope(runtime: Sql): BusinessScope<FrontierRepo> {
  return {
    async withBusiness<T>(businessId: string, work: (repo: FrontierRepo) => Promise<T>): Promise<T> {
      assertBusinessId(businessId);
      // Whether `work` has its transaction's repo (until it does, a failure is the transaction's start's), what it threw,
      // and what the transaction's statements found of its connection.
      const call: { working: boolean; thrown: { error: unknown } | null; seen: ConnectionSeen } = {
        working: false,
        thrown: null,
        seen: { gone: null },
      };
      try {
        return await inRuntimeTransaction(runtime, { readOnly: true }, async (tx) => {
          await tx`select set_config(${SCOPE_SETTING}, ${businessId}, true)`;
          call.working = true;
          let result: T;
          try {
            result = await work(pgFrontierRepo(tx, call.seen));
          } catch (error) {
            call.thrown = { error };
            throw call.seen.gone === null ? error : new ConnectionGone(call.seen.gone, error);
          }
          const { gone } = call.seen;
          if (gone !== null) {
            throw new ConnectionGone(gone, new DataAccessDatabaseError(FRONTIER_CALL, gone, null, null));
          }
          let scope: string;
          try {
            scope = await requireBusinessScope(tx);
          } catch (error) {
            const lost = goneWith(error);
            throw lost === null ? error : new ConnectionGone(lost, error);
          }
          if (scope !== businessId) {
            throw new BusinessScopeError("a turn face call must end under the business scope it began with");
          }
          return result;
        });
      } catch (error) {
        if (!call.working) return work(unstartedRepo(transientOrThrow(error, FRONTIER_CALL)));
        // `work` threw: its own error, which a failed rollback may have replaced on its way out of the transaction.
        if (call.thrown !== null) throw scrubbed(FRONTIER_CALL, call.thrown.error);
        // `work` answered: the end's failure (the scope read, the commit), never answered in place of `work`'s answer.
        throw scrubbed(FRONTIER_CALL, error instanceof ConnectionGone ? error.failure : error);
      }
    },
  };
}

/**
 * The turn face whose frontier reads stored state on `runtime` (rosie_job) under each call's business scope; the calls
 * after it run as `options.calls` binds them (pg/calls.ts pgTurnCalls: the Tool API's own scope, never this one).
 */
export function pgTurnFace<CallRepo = unknown>(
  runtime: Sql,
  options: Omit<TurnFaceOptions<FrontierRepo, CallRepo>, "scope">,
): TurnFace {
  return createTurnFace<FrontierRepo, CallRepo>({ ...options, scope: pgFrontierScope(runtime) });
}
