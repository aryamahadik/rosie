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

import {
  assertBusinessId,
  BusinessScopeError,
  requireBusinessScope,
  SCOPE_SETTING,
  type Sql,
  type Tx,
} from "../../../../../db/repo/scope";
import { inRuntimeTransaction, transientOrThrow } from "../../../../../db/repo/targets";
import { readTurnStateIn } from "../../../../../db/repo/turn-state";
import type { FrontierRepo, ReadTurnStateAnswer } from "../../../frontier";
import type { BusinessScope } from "../../scope";
import { createTurnFace, type TurnFace, type TurnFaceOptions } from "../turn-face";

/**
 * The frontier's repo on one transaction that already runs under the call's business scope (pgFrontierScope). A read the
 * database cannot answer now (a serialization failure, a deadlock or a lost connection) answers transient; any other
 * failure is thrown, so the call fails closed.
 */
export function pgFrontierRepo(db: Sql | Tx): FrontierRepo {
  return {
    async readTurnState(request) {
      try {
        // T-219 types K-05 v1.2's answer by hand (db/repo/turn-state.ts); the frontier takes the type generated from the
        // same frozen schema (ADR-005), whose JSON values are typed as objects. The tests hold each answer to that schema.
        return (await readTurnStateIn(db, request)) as ReadTurnStateAnswer;
      } catch (error) {
        return transientOrThrow(error);
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
 * The business scope of the frontier hop on `runtime`, the primary handle of a client whose connections run as
 * rosie_job (uncached: arch 10 lines 504, 538): one read-only transaction at repeatable read per call, scoped to the
 * call's business before the repo is handed over, and refused unless it still is at the end (see the top of this file).
 */
export function pgFrontierScope(runtime: Sql): BusinessScope<FrontierRepo> {
  return {
    async withBusiness(businessId, work) {
      assertBusinessId(businessId);
      return inRuntimeTransaction(runtime, { readOnly: true }, async (tx) => {
        await tx`select set_config(${SCOPE_SETTING}, ${businessId}, true)`;
        const result = await work(pgFrontierRepo(tx));
        if ((await requireBusinessScope(tx)) !== businessId) {
          throw new BusinessScopeError("a turn face call must end under the business scope it began with");
        }
        return result;
      });
    },
  };
}

/** The turn face whose frontier reads stored state on `runtime` (rosie_job) under each call's business scope. */
export function pgTurnFace(runtime: Sql, options: Omit<TurnFaceOptions<FrontierRepo>, "scope">): TurnFace {
  return createTurnFace<FrontierRepo>({ ...options, scope: pgFrontierScope(runtime) });
}
