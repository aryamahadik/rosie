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
 * The statement withBusiness's watch goes out as (T-1367): it has no values, so postgres.js sends it as a simple query and
 * hands its connection to its `onexecute` as it writes it (connection.js 172-177; a statement with values is described
 * first and hands nothing). The frontier's watch sends the same (actions' pg/frontier.ts, T-1368).
 */
const WATCH_STATEMENT = "select 1 as watch";

/**
 * connection_failure (T-1367): the SQLSTATE a close the watch heard leaves the connection gone with, as does a failure
 * of a lost connection that carries no SQLSTATE of its own (postgres.js's CONNECTION_CLOSED, Node's ECONNRESET), as
 * targets.ts's transientOrThrow answers them.
 */
const CONNECTION_FAILURE = "08006";

/** A lost connection's own SQLSTATE: class 08, and 57P01 to 57P03 (the backend ended), as bundles.ts isLostConnection. */
const LOST_SQLSTATE = /^(08[0-9A-Z]{3}|57P0[123])$/;

/**
 * postgres.js 3.4.9's connection as a statement's `onexecute` is handed it (connection.js 110-123): the one field the
 * watch reads and sets, the close callback its pool calls once, as the connection's socket closes (index.js 421-427),
 * which sql.begin sets to reject its race (index.js 243-246).
 */
interface WatchedConnection {
  onclose?: CloseCallback | null;
}

/** The close callback postgres.js's pool calls with its own CONNECTION_CLOSED (index.js 424; connection.js 457). */
type CloseCallback = (error: unknown) => void;

/** An unsafe statement's options with postgres.js's own `onexecute` (connection.js 172-177), which its types leave out. */
interface WatchOptions extends postgres.UnsafeQueryOptions {
  /** Called with the statement's connection as the statement is written; true leaves the connection where it is. */
  onexecute(connection: WatchedConnection): boolean;
}

/**
 * postgres.js 3.4.9's statement as a tagged call or `unsafe` makes it (query.js 6-37): a promise whose own `handler`
 * hands it to its transaction's connection when it is first awaited or executed (query.js 139-161; index.js 291-296), and
 * whose own `reject` settles it.
 */
interface PendingStatement {
  handler: unknown;
  reject(error: unknown): void;
}

/** A statement's handler, with the `debug` flag postgres.js reads off it (index.js 87; query.js 34-46). */
type StatementHandler = ((statement: PendingStatement) => unknown) & { debug?: unknown };

const isHandler = (value: unknown): value is StatementHandler => typeof value === "function";

/** What withBusiness knows of its transaction as it runs (T-1331, T-1367). */
interface Watch {
  /** sql.begin has called the callback: its begin went. */
  running: boolean;
  /** The start is done (the watch and the scope's set_config answered), so `fn` begins (T-1331's mark). */
  started: boolean;
  /** The callback has settled, or holds (Guard.stop): it sends nothing more. */
  decided: boolean;
  /** The SQLSTATE the transaction's connection was found gone with (a close heard, a failure that found it), or null. */
  gone: string | null;
  /** `fn`'s own error, thrown while its connection was not found gone. */
  thrown: { error: unknown } | null;
}

/** How withBusiness keeps every statement off a connection found gone (T-1367). */
interface Guard {
  readonly watch: Watch;
  /** What a statement made after the connection was found gone is refused with: the call's name and SQLSTATE alone. */
  readonly refused: () => Error;
  /** Hears a failure: one that finds the connection gone (targets.ts foundGone) marks it gone at once. */
  readonly note: (error: unknown) => void;
  /** Holds the callback for good, its connection gone, and hands withBusiness the failure (see withBusiness). */
  readonly stop: (failure: unknown) => Promise<never>;
}

/**
 * The watch on a transaction's connection (T-1367): the options of the statement that hands the connection over, which
 * set its close callback over the one it had (sql.begin's race, still called), and `off`, which puts that one back once
 * the transaction is over, while the watch's is still set (postgres.js's pool calls it once and clears it). A close
 * heard marks the connection gone (connection_failure); the error postgres.js hands the callback, its host and port in
 * it, goes on only to the callback it had.
 */
function watchConnection(watch: Watch): { options: WatchOptions; off: () => void } {
  let watched: WatchedConnection | null = null;
  let before: CloseCallback | null = null;
  const heard: CloseCallback = (error) => {
    watch.gone ??= CONNECTION_FAILURE;
    before?.(error);
  };
  return {
    options: {
      onexecute(connection) {
        watched = connection;
        before = connection.onclose ?? null;
        connection.onclose = heard;
        return true;
      },
    },
    off() {
      if (watched?.onclose === heard) watched.onclose = before;
      watched = null;
    },
  };
}

/** A tagged call's strings, by which postgres.js tells a statement from a fragment (index.js 110-116). */
function isTemplate(value: unknown): boolean {
  return typeof value === "object" && value !== null && Array.isArray((value as { raw?: unknown }).raw);
}

/**
 * Keeps one statement `fn` made off a connection found gone (T-1367): its handler, which postgres.js calls once, when the
 * statement is first awaited or executed, then hands it over only while the connection is not found gone, and else
 * rejects it with `guard.refused()`, built and sent nowhere. Its failure is heard first (`guard.note`), before the code
 * that awaits it runs on, so a lost connection is marked gone before `fn` can make another statement; as postgres.js's
 * own handler does (index.js 292), that also leaves no failure of a statement unhandled. A fragment (a name, a list, a
 * value) is no statement and is passed on as it is.
 */
function guardStatement(made: unknown, guard: Guard): void {
  if (!(made instanceof Promise)) return;
  const statement = made as unknown as PendingStatement;
  const handOver = statement.handler;
  if (!isHandler(handOver)) {
    throw new TypeError("withBusiness: a statement with no handler cannot be kept off a lost connection");
  }
  const guarded: StatementHandler = (pending) => {
    void Promise.prototype.then.call(pending as unknown as Promise<unknown>, undefined, guard.note);
    if (guard.watch.gone !== null) {
      pending.reject(guard.refused());
      return undefined;
    }
    return handOver(pending);
  };
  guarded.debug = handOver.debug;
  statement.handler = guarded;
}

/**
 * A savepoint of the guarded transaction (postgres.js's three forms: a tagged call, a callback, or a name and a callback;
 * index.js 283-289): refused at once on a connection found gone, and else run on postgres.js's own savepoint with its
 * statements guarded too. A failure that finds the connection gone holds it as the transaction's callback is held, so
 * postgres.js sends no `rollback to` on it (index.js 268-271).
 */
async function guardedSavepoint(savepoint: unknown, tx: Tx, args: unknown[], guard: Guard): Promise<unknown> {
  if (guard.watch.gone !== null) throw guard.refused();
  if (typeof savepoint !== "function") throw new TypeError("withBusiness: the transaction has no savepoint");
  const [first, second] = args;
  const tagged = isTemplate(first);
  const named = !tagged && args.length > 1;
  const given = named ? second : first;
  const inner = async (sp: Tx): Promise<unknown> => {
    try {
      const scoped = guardedTransaction(sp, guard);
      let made: unknown;
      if (tagged) {
        made = Reflect.apply(scoped, undefined, args);
      } else if (typeof given === "function") {
        made = Reflect.apply(given, undefined, [scoped]);
      } else {
        throw new TypeError("withBusiness: a savepoint needs a callback");
      }
      return await (Array.isArray(made) ? Promise.all(made) : made);
    } catch (error) {
      guard.note(error);
      if (guard.watch.gone !== null) return await guard.stop(error);
      throw error;
    }
  };
  const handed: unknown = named
    ? Reflect.apply(savepoint, tx, [first, inner])
    : Reflect.apply(savepoint, tx, [inner]);
  return await handed;
}

/**
 * `tx` as `fn` gets it (T-1367): the same transaction, whose every statement (a tagged call, `unsafe`, a savepoint's) is
 * guarded by guardStatement. A statement read from a file (`file`) is refused: postgres.js reads the file after the
 * statement is handed over and only then hands it to the connection (index.js 129-144), out of the guard's reach. No
 * call in this repository reads one.
 */
function guardedTransaction(tx: Tx, guard: Guard): Tx {
  const handOver = (made: unknown): unknown => {
    guardStatement(made, guard);
    return made;
  };
  return new Proxy(tx, {
    apply(target, thisArg, args: unknown[]): unknown {
      return handOver(Reflect.apply(target, thisArg, args));
    },
    get(target, key, receiver): unknown {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      if (key === "unsafe") {
        return (...args: unknown[]): unknown => handOver(Reflect.apply(value, target, args));
      }
      if (key === "savepoint") {
        return (...args: unknown[]): Promise<unknown> => guardedSavepoint(value, target, args, guard);
      }
      if (key === "file") {
        return (): never => {
          throw new TypeError(
            "withBusiness: a statement read from a file is not run inside a business scope",
          );
        };
      }
      return value;
    },
  });
}

/**
 * Runs `fn` in one transaction scoped to `businessId`: the scope is set first, `fn` runs, and the transaction commits
 * (or rolls back when `fn` throws). The scope exists only inside the transaction. On the replica the transaction is
 * read only. Before the commit the scope must still be `businessId`: a callback that emptied it (rosie_job then reads
 * every business's rows) or changed it is refused with BusinessScopeError, the transaction rolls back, and nothing it
 * read is returned.
 *
 * The start (T-1331; T-1315's handoff b; K-05 README: `transient`; ADR-014 section 2): a failure before `fn` begins (the
 * connect and begin of sql.begin, then the watch below and the scope's set_config, sent in one write) goes to clocks.ts's
 * transientOrScrubbed (targets.ts's transientOrThrow, whatever it throws scrubbed) under the name of the call the
 * transaction is opened for (`options.call`; "withBusiness" when none is named), and `fn` never runs:
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
 *
 * A lost connection after the start (T-1367; T-1331's DL-694 task 2): `fn` may await more than this transaction's
 * statements (the turn face's works await the runtime client and the bundles: pg/calls.ts), so the connection may close
 * while no statement is in flight on it (idle_in_transaction_session_timeout, a restart, pg_terminate_backend, the
 * network). postgres.js 3.4.9 then sets its socket to null and rejects sql.begin's race with its own CONNECTION_CLOSED,
 * the host and port in it (connection.js 436-458; index.js 243-246, 421-427; errors.js 16-27), while `fn` runs on: a
 * statement it then makes, the end's scope read, the commit, or postgres.js's own rollback after a failure (index.js
 * 265-279) would be written to no socket at all, from a timer (an uncaught TypeError, and a statement that never
 * settles: connection.js 156-183, 246-259), or, once the pool has opened the connection again for another call, to that
 * call's session. So:
 *   - the watch, a statement with no values sent ahead of the scope's set_config, takes the connection as postgres.js
 *     hands it to the statement's `onexecute` and sets its close callback over sql.begin's own, which it still calls (as
 *     the frontier's watch does: pg/frontier.ts, T-1368): a close heard marks the connection gone (08006) at once;
 *   - `fn` gets the transaction guarded (guardedTransaction): once the connection is found gone (a close heard, or a
 *     statement's failure that finds it gone: targets.ts foundGone), a statement `fn` makes is refused at once, as
 *     DataAccessDatabaseError with the call's name and that SQLSTATE, and built and sent nowhere;
 *   - the callback holds, never settling, once the connection is found gone at the start, in `fn` or at the end, so
 *     postgres.js sends neither its rollback nor its commit (Guard.stop); the failure reaches withBusiness at once, as
 *     does sql.begin's race. Nothing more goes on the connection, and the pool opens it again for its next statement.
 * What leaves once `fn` has begun: a connection found gone before `fn` threw is thrown scrubbed, DataAccessDatabaseError
 * with the call's name and that SQLSTATE alone (08006 for a close), never what `fn` answered, and never K-05's
 * `transient` (`options.transient` is the start's answer: `fn` may have written through another client by then); `fn`'s
 * own error leaves as it is, even when the connection was lost under postgres.js's rollback after it; every other
 * failure (BusinessScopeError, a statement's own refusal that postgres.js reports at the end: index.js 265-272) leaves as
 * it always has.
 *
 * Neither the answer nor a scrubbed error holds the original's message, host, port, user, password, database, statement
 * or values. targets.ts and clocks.ts are imported as each transaction starts, never when this file loads: both import
 * this file in turn, and every script that runs db/ under Node loads this file (db/tsconfig.erasable.json).
 */
export async function withBusiness<T>(
  sql: Sql,
  businessId: string,
  fn: (tx: Tx) => Promise<T>,
  options: { readOnly?: boolean; call?: string; transient?: (answer: TransientError) => T } = {},
): Promise<T> {
  assertBusinessId(businessId);
  const call = options.call ?? "withBusiness";
  // Every decision a failure needs is then made at once, with no turn of the event loop before the next statement.
  const [{ foundGone }, { DataAccessDatabaseError, transientOrScrubbed }] = await Promise.all([
    import("./targets"),
    import("./clocks"),
  ]);
  const watch: Watch = { running: false, started: false, decided: false, gone: null, thrown: null };
  /** The SQLSTATE a failure leaves the connection gone with, or null when it found the connection open. */
  const goneWith = (error: unknown): string | null => {
    if (!foundGone(error)) return null;
    const code = (error as { code?: unknown } | null | undefined)?.code;
    return typeof code === "string" && LOST_SQLSTATE.test(code) ? code : CONNECTION_FAILURE;
  };
  // Rejected with the failure when the callback holds.
  let hold: (failure: unknown) => void = () => undefined;
  const held = new Promise<never>((_resolve, reject) => {
    hold = reject;
  });
  const guard: Guard = {
    watch,
    refused: () => new DataAccessDatabaseError(call, watch.gone ?? CONNECTION_FAILURE, null, null),
    note: (error) => {
      watch.gone ??= goneWith(error);
    },
    stop: (failure) => {
      watch.decided = true;
      hold(failure);
      return new Promise<never>(() => undefined);
    },
  };
  const watcher = watchConnection(watch);
  // Read afresh each time: a close, or a statement's failure, marks the connection gone between any two statements.
  const isGone = (): boolean => watch.gone !== null;
  const run = async (tx: Tx): Promise<T> => {
    watch.running = true;
    try {
      // The watch goes first, the scope's setting behind it in the same write: no round trip more.
      const watching = tx.unsafe(WATCH_STATEMENT, [], watcher.options).execute();
      await Promise.all([watching, setBusinessScope(tx, businessId)]);
    } catch (error) {
      guard.note(error);
      if (isGone()) return await guard.stop(error);
      watch.decided = true;
      throw error;
    }
    watch.started = true;
    const scoped = guardedTransaction(tx, guard);
    let result: T;
    try {
      result = await fn(scoped);
    } catch (error) {
      guard.note(error);
      if (isGone()) return await guard.stop(error);
      watch.thrown = { error };
      watch.decided = true;
      throw error;
    }
    if (isGone()) return await guard.stop(guard.refused());
    let scope: string;
    try {
      scope = await requireBusinessScope(scoped);
    } catch (error) {
      guard.note(error);
      if (isGone()) return await guard.stop(error);
      watch.decided = true;
      throw error;
    }
    watch.decided = true;
    if (scope !== businessId) {
      throw new BusinessScopeError("a Tool API call must end under the business scope it began with");
    }
    return result;
  };
  try {
    const begun = options.readOnly === true ? sql.begin("read only", run) : sql.begin(run);
    const result = await Promise.race([begun, held]);
    return result as T;
  } catch (error) {
    if (watch.running && !watch.decided) {
      // sql.begin settled while its callback had not: its race heard the connection close (index.js 243-246).
      watch.gone ??= goneWith(error) ?? CONNECTION_FAILURE;
    }
    if (!watch.started) {
      const answer = transientOrScrubbed(call, error);
      if (options.transient !== undefined) return options.transient(answer);
      throw new DataAccessDatabaseError(call, answer.sqlstate, null, null);
    }
    const gone = watch.gone ?? goneWith(error);
    if (watch.thrown !== null) throw gone === null ? error : watch.thrown.error;
    if (gone !== null) throw new DataAccessDatabaseError(call, gone, null, null);
    throw error;
  } finally {
    watcher.off();
  }
}
