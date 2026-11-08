// The business scope every Tool API call runs under (T-290; K-04 v1 rule 4; arch 10 line 546: "Row-level security per
// business on every Tool API call"; db/repo/scope.ts).
//
// The seam is one method on purpose: a call's handler gets its repo only from inside `withBusiness`, so the scope is set
// before the handler can read anything, and the transaction ends with the call. Lead card T-1083 (a lost-connection-safe
// scoped transaction for every repo call) replaces the adapter below without touching the calls.

import type { DbClient } from "../../../db/repo/client";
import type { Tx } from "../../../db/repo/scope";

export interface BusinessScope<Repo> {
  /**
   * Runs `work` inside one transaction whose row-level security scope is `businessId` (the setting `rosie.business_id`),
   * set before `work` gets the repo; it commits when `work` resolves and rolls back when it throws, so the scope never
   * outlives the call.
   */
  withBusiness<T>(businessId: string, work: (repo: Repo) => Promise<T>): Promise<T>;
}

/**
 * The scope over the database client (db/repo/client.ts): its scoped transaction on the primary, since every K-09 v1 call
 * reads the primary, uncached (K-09 README "Reads, repeats and time budgets"; arch 10 line 538).
 */
export function businessScopeOf(client: Pick<DbClient, "withBusiness">): BusinessScope<Tx> {
  return {
    withBusiness: (businessId, work) => client.withBusiness(businessId, work),
  };
}
