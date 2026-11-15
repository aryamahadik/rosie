// The business scope every Tool API call runs under (T-290; K-04 v1 rule 4; arch 10 line 546: "Row-level security per
// business on every Tool API call"; db/repo/scope.ts).
//
// The seam is one method on purpose: a call's handler gets its repo only from inside `withBusiness`, so the scope is set
// before the handler can read anything, and the transaction ends with the call. Lead card T-1083 (a lost-connection-safe
// scoped transaction for every repo call) replaces the adapter below without touching the calls.
//
// The base tells the scope which call it opens the transaction for (T-1368; T-1331's handoff, task 3): the K-09 call's
// name and, where that call's errors have K-05's `transient`, its answer to a start the database could not make. They
// are db/repo/scope.ts withBusiness's own `call` and `transient` options, for a scope over it to hand on.

import type { DbClient } from "../../../db/repo/client";
import type { Tx } from "../../../db/repo/scope";
import type { TransientError } from "../../../db/repo/targets";

/**
 * The call a scoped transaction is opened for, as the Tool API base names it (T-1368): db/repo/scope.ts withBusiness's
 * `call` and `transient` options.
 */
export interface ScopeCall<T> {
  /** The K-09 call's name: the name a failure of the transaction's start is thrown scrubbed under. */
  readonly call: string;
  /**
   * The call's answer to K-05's `transient` at the transaction's start (a connection that never opened or was lost:
   * nothing was written, and the same request may be sent again), given only where the call's K-09 errors have
   * `transient`. Without it such a start is thrown scrubbed, as every other failure of the start is, and `work` never
   * runs either way.
   */
  readonly transient?: (answer: TransientError) => T;
}

export interface BusinessScope<Repo> {
  /**
   * Runs `work` inside one transaction whose row-level security scope is `businessId` (the setting `rosie.business_id`),
   * set before `work` gets the repo; it commits when `work` resolves and rolls back when it throws, so the scope never
   * outlives the call. `call` names the call the transaction is opened for (ScopeCall): a scope over db/repo/scope.ts
   * withBusiness hands it on as withBusiness's `call` and `transient`; a scope whose start answers otherwise may leave it
   * unread.
   */
  withBusiness<T>(businessId: string, work: (repo: Repo) => Promise<T>, call?: ScopeCall<T>): Promise<T>;
}

/**
 * The scope over the database client (db/repo/client.ts): its scoped transaction on the primary, since every K-09 v1 call
 * reads the primary, uncached (K-09 README "Reads, repeats and time budgets"; arch 10 line 538). The client's
 * withBusiness takes no call or transient (db/repo/client.ts), so this scope leaves `call` unread.
 */
export function businessScopeOf(client: Pick<DbClient, "withBusiness">): BusinessScope<Tx> {
  return {
    withBusiness: (businessId, work) => client.withBusiness(businessId, work),
  };
}
