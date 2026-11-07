// Business scope for row-level security (K-04 v1 rule 4; K-05 README "Scope"; arch 10 line 546).
//
// A Tool API call runs inside one transaction whose setting `rosie.business_id` is its business. The setting is set with
// set_config(..., is_local = true), so PostgreSQL drops it at COMMIT or ROLLBACK: a connection returned to the pool
// carries no scope, and the next transaction on it starts unscoped. The runtime side (jobs that work across businesses
// by handle) runs a plain transaction and never sets it.
import type postgres from "postgres";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

/** The setting row-level security policies read: `current_setting('rosie.business_id', true)`. */
export const SCOPE_SETTING = "rosie.business_id";

/** Which handle a scoped transaction runs on: decisions and writes on the primary, search and reports on the replica. */
export type ScopeHandle = "primary" | "replica";

const MAX_BUSINESS_ID_LENGTH = 128;

/** Refuses an id that cannot be a business id; an empty scope would read as "no scope" (the unscoped side). */
export function assertBusinessId(businessId: string): void {
  if (
    businessId.trim() === "" ||
    businessId.length > MAX_BUSINESS_ID_LENGTH ||
    businessId.includes("\u0000")
  ) {
    throw new TypeError("a business scope needs a non-empty business id of at most 128 characters");
  }
}

/**
 * Sets the scope for the rest of the transaction `tx` (also usable again to change it: the per write scope of K-05,
 * set to each write's own business before that write). Never call it outside a transaction: the setting would then
 * last only for the one statement, so it would silently scope nothing.
 */
export async function setBusinessScope(tx: Tx, businessId: string): Promise<void> {
  assertBusinessId(businessId);
  await tx`select set_config(${SCOPE_SETTING}, ${businessId}, true)`;
}

/** The scope the current transaction (or statement) sees, or null when there is none. */
export async function readBusinessScope(sql: Sql | Tx): Promise<string | null> {
  const [row] = await sql<
    { scope: string | null }[]
  >`select current_setting(${SCOPE_SETTING}, true) as scope`;
  const scope = row?.scope ?? null;
  // A setting that was set and then dropped at the end of a transaction reads as '' on that connection, not null.
  return scope === null || scope === "" ? null : scope;
}

/**
 * Runs `fn` in one transaction scoped to `businessId`: the scope is set first, `fn` runs, and the transaction commits
 * (or rolls back when `fn` throws). The scope exists only inside the transaction. On the replica the transaction is
 * read only.
 */
export async function withBusiness<T>(
  sql: Sql,
  businessId: string,
  fn: (tx: Tx) => Promise<T>,
  options: { readOnly?: boolean } = {},
): Promise<T> {
  assertBusinessId(businessId);
  const run = async (tx: Tx): Promise<T> => {
    await setBusinessScope(tx, businessId);
    return fn(tx);
  };
  const result = options.readOnly === true ? await sql.begin("read only", run) : await sql.begin(run);
  return result as T;
}
