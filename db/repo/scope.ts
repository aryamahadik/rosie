// Business scope for row-level security (K-04 v1 rule 4; K-05 README "Scope"; arch 10 line 546).
//
// A Tool API call runs inside one transaction whose setting `rosie.business_id` is its business. The setting is set with
// set_config(..., is_local = true), so PostgreSQL drops it at COMMIT or ROLLBACK: a connection returned to the pool
// carries no scope, and the next transaction on it starts unscoped. The runtime side (jobs that work across businesses
// by handle) runs a plain transaction and never sets it.
//
// A Tool API call never runs with no scope (T-1094; T-191's security review, note b; QUESTIONS.md CQ-70's default).
// With none, rosie_app sees no business's row, but rosie_job, the runtime side's role, sees every business's rows, so a
// Tool API path that runs as rosie_job (a business-scoped read that also needs a table only the runtime side holds,
// such as handles or phones) would fail open. Such a path calls requireBusinessScope() inside its transaction before
// its first read, and withBusiness() refuses a callback that ends with its scope emptied or changed.
import type postgres from "postgres";
import type { TransientError } from "./targets";

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

/**
 * The setting K-22's person policies read (K-22 README rule 4): `nullif(current_setting('rosie.person_id', true), '')`,
 * the person a Tool API call acts for. Unset, or the '' an ended transaction leaves, matches no row.
 */
export const PERSON_SETTING = "rosie.person_id";

/** Refuses an id that cannot be a person's; an empty one would read as "no person". Names no value. */
function assertPersonId(personId: string): void {
  if (personId.trim() === "" || personId.length > MAX_BUSINESS_ID_LENGTH || personId.includes("\u0000")) {
    throw new TypeError("a call's person needs a non-empty person id of at most 128 characters");
  }
}

/**
 * Sets the person the rest of the transaction `tx` acts for (K-22 README rule 4; K-05 v1.13 "rosie.person_id per
 * call"): set_config('rosie.person_id', <persons.id>, true), as setBusinessScope sets the business, so PostgreSQL drops
 * it at COMMIT or ROLLBACK and the connection goes back to the pool acting for no one. K-05 v1.13 sets it in two calls
 * only, each inside its own transaction: proveSignIn once check_proof_code answers right (the attempt's person), and
 * endSession once session_for_token answers (that session's person). It takes a transaction's handle (`Tx`, from
 * sql.begin) and nothing else, so it is never called on a pooled handle, where the setting would last one statement.
 * Called outside a transaction it would fail closed: the next statement acts for no one, and K-22's policies show it
 * no code or session and refuse its session insert (42501).
 */
export async function setPersonScope(tx: Tx, personId: string): Promise<void> {
  assertPersonId(personId);
  await tx`select set_config(${PERSON_SETTING}, ${personId}, true)`;
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

/** A Tool API call with no business scope, or one that ended under another scope than it began with. Names no value. */
export class BusinessScopeError extends Error {
  override name = "BusinessScopeError";
}

/**
 * The business scope the transaction `tx` runs under, as PostgreSQL reads it; refused with BusinessScopeError when there
 * is none (never set, or ''). A Tool API path that runs as rosie_job calls it inside its transaction before its first
 * read: rosie_job with no scope reads every business's rows, where rosie_app with none reads no business's.
 */
export async function requireBusinessScope(tx: Sql | Tx): Promise<string> {
  const scope = await readBusinessScope(tx);
  if (scope === null) {
    throw new BusinessScopeError(
      "a Tool API call needs a business scope: with none, the runtime side's role reads every business's rows",
    );
  }
  return scope;
}

/**
 * Runs `fn` in one transaction scoped to `businessId`: the scope is set first, `fn` runs, and the transaction commits
 * (or rolls back when `fn` throws). The scope exists only inside the transaction. On the replica the transaction is
 * read only. Before the commit the scope must still be `businessId`: a callback that emptied it (rosie_job then reads
 * every business's rows) or changed it is refused with BusinessScopeError, the transaction rolls back, and nothing it
 * read is returned.
 *
 * The start (T-1331; T-1315's handoff b; K-05 README: `transient`; ADR-014 section 2): a failure before `fn` begins (the
 * connect and begin of sql.begin, then the scope's set_config) goes to clocks.ts's transientOrScrubbed (targets.ts's
 * transientOrThrow, whatever it throws scrubbed) under the name of the call the transaction is opened for
 * (`options.call`; "withBusiness" when none is named), and `fn` never runs:
 *   - a connection that never opened (08001: a closed port, a name that never resolves, postgres.js's CONNECT_TIMEOUT)
 *     or was lost (08006, 57P01 to 57P03) is K-05's `transient`: nothing was written and the same request may be sent
 *     again. Where the call's contract has that answer, the caller passes `options.transient` and withBusiness resolves
 *     with what it gives for the answer; otherwise the failure is thrown scrubbed, as clocks.ts's DataAccessDatabaseError
 *     with the call's name and that SQLSTATE alone;
 *   - every other failure of the start is thrown scrubbed (clocks.ts's scrubbed: the call's name and the code alone, a
 *     PostgresError as DataAccessDatabaseError with its SQLSTATE), and is never K-05's `transient`, the caller's answer
 *     or not: a session refused at its start (PostgreSQL's class 28 and 53300, a TLS or certificate error, EACCES,
 *     postgres.js's SASL_SIGNATURE_MISMATCH; and PostgreSQL's 3D000, 42501 and 55000, whose messages name the database),
 *     and a set_config refused with any other SQLSTATE (57014, a statement timeout or a cancel), whose statement holds
 *     the business id.
 * Neither the answer nor a scrubbed error holds the original's message, host, port, user, password, database, statement
 * or values. Once `fn` has begun, what it throws, and the end's scope check and commit, leave as they always have.
 * clocks.ts (and targets.ts through it) is imported only when a start fails, never when this file loads: both import
 * this file in turn, and every script that runs db/ under Node loads this file (db/tsconfig.erasable.json).
 */
export async function withBusiness<T>(
  sql: Sql,
  businessId: string,
  fn: (tx: Tx) => Promise<T>,
  options: { readOnly?: boolean; call?: string; transient?: (answer: TransientError) => T } = {},
): Promise<T> {
  assertBusinessId(businessId);
  // Whether `fn` has begun: until it has, a failure is the start's.
  const progress = { started: false };
  const run = async (tx: Tx): Promise<T> => {
    await setBusinessScope(tx, businessId);
    progress.started = true;
    const result = await fn(tx);
    if ((await requireBusinessScope(tx)) !== businessId) {
      throw new BusinessScopeError("a Tool API call must end under the business scope it began with");
    }
    return result;
  };
  try {
    const result = options.readOnly === true ? await sql.begin("read only", run) : await sql.begin(run);
    return result as T;
  } catch (error) {
    if (progress.started) throw error;
    const call = options.call ?? "withBusiness";
    const { DataAccessDatabaseError, transientOrScrubbed } = await import("./clocks");
    const answer = transientOrScrubbed(call, error);
    if (options.transient !== undefined) return options.transient(answer);
    throw new DataAccessDatabaseError(call, answer.sqlstate, null, null);
  }
}
