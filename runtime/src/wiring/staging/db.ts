// The Worker's database handle and its guard in every call (T-1254; ADR-014 section 2 and section 4's piece 6; the D-017
// path audit's P1a, its database part: ops/reviews/D-017-path-audit/order_d017.txt line 29; the T-1154 map's critics,
// critic_collisions B1, B7, N1, N2, N4 and N7 and critic_size B9 and N3; the lead's notes DL-757 and DL-758).
//
// One short-lived client per call. `runtime(call, fn)` and `toolApi(call, fn)` each open a postgres.js client for that one
// call, from one binding, run the guard on it, hand it to `fn` only when the guard passes, and end it after `fn`, also
// when anything throws (opened equals ended: `counts()`):
//   - the runtime side's clients (rosie_job's calls) come from HYPERDRIVE_JOB only, whose configuration stores
//     rosie_worker_job, and the Tool API's (rosie_app's calls) from HYPERDRIVE_APP only, which stores rosie_worker_app
//     (ADR-014 sections 1 and 3). No binding named HYPERDRIVE is read;
//   - before any binding is read, the environment must be staging (../picks.ts environmentOf), so in production the handle
//     reads none (critic_collisions N1), and DB_SCHEMA must be empty: while it is set, no client is opened through either
//     binding (ADR-014 section 2, "DB_SCHEMA: one rule in every runtime"). Either way the call fails closed as it does
//     with no binding (DbClosedError), and nothing is read or written;
//   - the binding and its connection string are read at each call, never when the handle is made (critic_collisions N4);
//   - the client sets no role (no SET ROLE, no SET LOCAL ROLE, no role startup parameter) and sends no search path: its
//     startup is postgres.js's own (the user, the database, the client encoding and postgres.js's application name), and
//     its options are the cap, the connect's time limit, notices kept quiet and the socket below. postgres.js's own first
//     reads stay on (fetch_types: db/repo sends arrays, critic_collisions N7);
//   - each client holds at most CONNECTIONS_PER_CLIENT connections (below).
//
// The guard (ADR-014 section 2's table, as one select, the client's first statement): session_user and current_user are
// the side's login; the login's memberships, read by member (the rows of pg_auth_members whose member is it, never by
// role), are exactly one, the side's role, with inherit true, set false and admin false; pg_has_role(current_user, <its
// own role>, 'USAGE') is true; pg_has_role(current_user, <the other role>, 'MEMBER') is false; row_security_active
// ('businesses') is true; current_schema() is public. Only when every answer is the side's own is the client handed to
// `fn`, and db/repo's calls then run on it unchanged. A wrong answer, or no row, ends the client and throws
// DbGuardRefusal: `fn` never runs, and the guard itself only reads, so nothing is written. The refusal and its one log
// line carry the side, the binding's name and each failed check's label, in the table's order, and nothing else; it has
// no code, so db/repo's transientOrThrow throws it as it is, and it is never answered as `transient` (a retry cannot fix
// a wrong login). A failure of the connect or of the guard's own statement (a binding present but unreachable, a wrong
// password, a database that does not exist, a connection lost under the guard) is thrown as the call's own errors are:
// db/repo's DataAccessDatabaseError, with the call's name and the SQLSTATE alone (PostgreSQL's own, else 08001 for a
// connect that never opened and 08006 for a connection lost under the guard), and `fn` does not run either. No error,
// log line or report of the handle holds a connection string, a host, a user, a password, a row or any value the guard
// read; the one value it reports is the login's name, once the guard has passed (DL-757). Every call runs the guard; no
// answer is remembered for an isolate or a request (a configuration can be updated in place, and a login's memberships
// can change, while an isolate lives).
//
// Time (ADR-014 section 2, "What it costs, timed apart from the connect"): the connect (the socket, postgres.js's startup
// and its own first reads, until the connection is ready for a statement of ours) and the guard (from its select to its
// answer) are each timed as the trace writers time a hop (../../trace TraceContext.start: when it started, in UTC, and its
// whole milliseconds by the clock), and handed to `timing` as two separate values, with the call, the side, the binding
// and the login the guard read, before `fn` runs. Nothing is cached or skipped to save that time: a guard that breaks a
// budget goes to the architect.
//
// The socket (DL-758, the lead's ruling on T-1253's NEED): postgres.js 3.4.9's Workers build ends a client by closing its
// socket (node_modules/postgres/cf/polyfills.js), and the read still pending on that socket then rejects ("This socket has
// been closed."), with postgres.js's listeners already removed, so its read() rejects with nothing to catch it: one
// unhandled rejection after every client it ends. The handle hands postgres.js its own socket (its `socket` option),
// QuietSocket below, which speaks to the same address over cloudflare:sockets as postgres.js's own does and differs in
// that one rule: a read that fails once the socket's own close has begun (postgres.js ended or destroyed it) or once the
// socket has closed ends quietly, and is counted (`quietReads`). The same holds for a write that fails once the socket
// has closed (`quietWrites`): a connect that never opens closes the socket, and postgres.js's startup, written before,
// then fails with no listener left, so its own socket's emit throws it unhandled too (measured: the closed port's case
// in ./db.worker.test.ts). Every other failure of the socket, each one before it has closed, still reaches postgres.js
// as its own socket gives it: 'error', then 'close'. After each call the handle waits for its sockets' reads to end, so
// none is left pending once the call has returned.

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";

import { DataAccessDatabaseError } from "@rosie/db/repo/clocks";
import type { Sql } from "@rosie/db/repo/scope";
import { connect } from "cloudflare:sockets";
import postgres from "postgres";

import { environmentOf } from "../picks";

/**
 * The two sides (ADR-014 sections 1 and 3): the binding each reads, the login its configuration stores, the one role
 * that login inherits, and the other side's role.
 */
export const DB_SIDES = {
  runtime: { binding: "HYPERDRIVE_JOB", login: "rosie_worker_job", role: "rosie_job", other: "rosie_app" },
  toolApi: { binding: "HYPERDRIVE_APP", login: "rosie_worker_app", role: "rosie_app", other: "rosie_job" },
} as const;

/** A side: the runtime side (K-05 scope runtime, rosie_job) or the Tool API (K-05 scope business, rosie_app). */
export type DbSide = keyof typeof DB_SIDES;

/** The binding a side reads. */
export type DbBindingName = (typeof DB_SIDES)[DbSide]["binding"];

/**
 * Connections each client may hold at once (postgres.js's `max`): one. A client serves one call, so one connection holds
 * that call's statements and transactions, and a call that needs the other side opens a client of its own there. The
 * gate's case (ADR-014 Consequences, "Connections inside one call"; critic_collisions N2): a gate holds its Tool API
 * transaction while its runtime-side calls run, so it holds 2 connections, and two such gates at once 4, under the 6 a
 * Worker may hold open at once (infra/spikes/hyperdrive-host/worker.mjs line 77). No client is shared between calls, so
 * no call waits for a connection another call holds while that call waits for one of its own.
 */
export const CONNECTIONS_PER_CLIENT = 1;

/** How long a connect may take before postgres.js gives it up (its CONNECT_TIMEOUT), as db/repo's createClient. */
export const CONNECT_TIMEOUT_SECONDS = 15;

/** How long ending a client may take before postgres.js destroys its connections, then the wait for their reads. */
export const END_TIMEOUT_SECONDS = 5;

/** The SQLSTATE of a connect that never opened (sqlclient_unable_to_establish_sqlconnection), as db/repo answers one. */
const NEVER_OPENED = "08001";
/** The SQLSTATE of a connection lost under the guard (connection_failure), as db/repo answers one. */
const CONNECTION_FAILURE = "08006";
const SQLSTATE = /^[0-9A-Z]{5}$/u;

/** What the handle reads of the Worker's env: at each call, never when the handle is made. */
export interface DbEnv {
  readonly ENVIRONMENT: string;
  readonly DB_SCHEMA?: unknown;
  readonly HYPERDRIVE_JOB?: unknown;
  readonly HYPERDRIVE_APP?: unknown;
}

/** Why a call found no database: not staging, DB_SCHEMA set, or no binding with a connection string. */
export type DbClosedReason = "notStaging" | "dbSchemaSet" | "noBinding";

const SIDE_WORDS: Readonly<Record<DbSide, string>> = {
  runtime: "the runtime side",
  toolApi: "the Tool API",
};

const REASON_WORDS: Readonly<Record<DbClosedReason, string>> = {
  notStaging: "not staging, so no binding is read",
  dbSchemaSet: "DB_SCHEMA is set, so no client is opened",
  noBinding: "no binding with a connection string",
};

/**
 * A call that found no database here, before any client: not staging (no binding read), DB_SCHEMA set (no client
 * opened), or no binding. It fails closed as with no binding; it names the call, the side, the binding and why.
 */
export class DbClosedError extends Error {
  readonly call: string;
  readonly side: DbSide;
  readonly binding: DbBindingName;
  readonly reason: DbClosedReason;

  constructor(call: string, side: DbSide, reason: DbClosedReason) {
    const { binding } = DB_SIDES[side];
    super(`${call}: no database for ${SIDE_WORDS[side]} here (${binding}: ${REASON_WORDS[reason]})`);
    this.name = "DbClosedError";
    this.call = call;
    this.side = side;
    this.binding = binding;
    this.reason = reason;
  }
}

/**
 * The guard's refusal: the side, the binding's name and the label of each check the guard's answer failed, in the table's
 * order, and nothing else (no value the guard read). It has no code: never `transient`.
 */
export class DbGuardRefusal extends Error {
  readonly side: DbSide;
  readonly binding: DbBindingName;
  readonly checks: readonly string[];

  constructor(side: DbSide, checks: readonly string[]) {
    const { binding } = DB_SIDES[side];
    super(`the guard refused ${SIDE_WORDS[side]}'s client from ${binding}: ${checks.join("; ")}`);
    this.name = "DbGuardRefusal";
    this.side = side;
    this.binding = binding;
    this.checks = [...checks];
  }
}

/** A refusal's one log line: the side, the binding's name and the failed checks' labels, and nothing else. */
export interface DbRefusalLine {
  readonly level: "error";
  readonly msg: "dbGuardRefused";
  readonly side: DbSide;
  readonly binding: DbBindingName;
  readonly checks: readonly string[];
}

/** A step's time as the trace writers record a hop's: when it started (UTC, RFC 3339) and its whole milliseconds. */
export interface DbStepTime {
  readonly at: string;
  readonly ms: number;
}

/** One call's times, once its guard has passed: the connect and the guard apart, and the login the guard read. */
export interface DbCallTiming {
  readonly call: string;
  readonly side: DbSide;
  readonly binding: DbBindingName;
  /** The login the guard read (session_user, equal to current_user), the side's own: its name and nothing else (DL-757). */
  readonly login: string;
  readonly connect: DbStepTime;
  readonly guard: DbStepTime;
}

/** What the handle has counted since it was made. */
export interface DbHandleCounts {
  /** Clients opened: one for each call that reached a binding's connection string. */
  readonly opened: number;
  /** Clients ended, with their sockets' reads: equal to `opened` once every call has returned or thrown. */
  readonly ended: number;
  /** Connections (sockets) open now, and the most that were open at once. */
  readonly connectionsOpen: number;
  readonly connectionsPeak: number;
  /** Reads that failed once their socket's own close had begun or it had closed, ended quietly (DL-758). */
  readonly quietReads: number;
  /** Writes that failed once their socket had closed, ended quietly. */
  readonly quietWrites: number;
}

export interface DbHandleOptions {
  /** Where each call's times go once its guard has passed (the call's trace, where T-1257 wires it). Default: nowhere. */
  readonly timing?: (timing: DbCallTiming) => void;
  /** Where a refusal's one log line goes. Default: one JSON line on console.error. */
  readonly log?: (line: DbRefusalLine) => void;
  /** Epoch milliseconds. Default: Date.now. */
  readonly now?: () => number;
}

/** The Worker's database handle: one guarded client for each call, from the call's side's binding. */
export interface DbHandle {
  /** One call on the runtime side: a client from HYPERDRIVE_JOB, as rosie_worker_job, which inherits rosie_job. */
  runtime<T>(call: string, fn: (sql: Sql) => Promise<T>): Promise<T>;
  /** One call of the Tool API: a client from HYPERDRIVE_APP, as rosie_worker_app, which inherits rosie_app. */
  toolApi<T>(call: string, fn: (sql: Sql) => Promise<T>): Promise<T>;
  counts(): DbHandleCounts;
}

// ---- the guard ----------------------------------------------------------------------------------------------------

/** The label of each of ADR-014 section 2's checks for a side. Each names a read, never a value. */
function labelsOf(side: DbSide) {
  const { role, other } = DB_SIDES[side];
  return {
    sessionUser: "session_user",
    currentUser: "current_user",
    memberships: "memberships",
    ownUsage: `pg_has_role(current_user, '${role}', 'USAGE')`,
    otherMember: `pg_has_role(current_user, '${other}', 'MEMBER')`,
    rowSecurity: "row_security_active('businesses')",
    schema: "current_schema()",
  } as const;
}

/** The labels of ADR-014 section 2's checks for a side, in the table's order. */
export function guardChecks(side: DbSide): readonly string[] {
  return Object.values(labelsOf(side));
}

/** The guard's select for a side: ADR-014 section 2's table as one select. The role names are the side's constants. */
export function guardSelect(side: DbSide): string {
  const { role, other } = DB_SIDES[side];
  return `select session_user::pg_catalog.text as session_user_name,
  current_user::pg_catalog.text as current_user_name,
  (select pg_catalog.json_agg(pg_catalog.json_build_object('role', r.rolname::pg_catalog.text,
            'inherit', m.inherit_option, 'set', m.set_option, 'admin', m.admin_option) order by r.rolname)::pg_catalog.text
     from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid = m.roleid
    where m.member = (select u.oid from pg_catalog.pg_roles u where u.rolname = current_user)) as memberships,
  pg_catalog.pg_has_role(current_user, '${role}', 'USAGE') as own_usage,
  pg_catalog.pg_has_role(current_user, '${other}', 'MEMBER') as other_member,
  pg_catalog.row_security_active('businesses') as row_security,
  pg_catalog.current_schema()::pg_catalog.text as schema_name`;
}

interface Membership {
  readonly role: unknown;
  readonly inherit: unknown;
  readonly set: unknown;
  readonly admin: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The memberships cell (json_agg's text; null for none) as a list, or null when it cannot be read. */
function membershipsOf(cell: unknown): readonly Membership[] | null {
  if (cell === null) return [];
  if (typeof cell !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cell);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const list: Membership[] = [];
  for (const entry of parsed as unknown[]) {
    if (!isRecord(entry)) return null;
    list.push({ role: entry.role, inherit: entry.inherit, set: entry.set, admin: entry.admin });
  }
  return list;
}

/**
 * The labels of the checks the guard's row fails for a side, in the table's order: none when every answer is the side's
 * own. No row fails every check.
 */
export function failedChecks(row: unknown, side: DbSide): readonly string[] {
  const { login, role } = DB_SIDES[side];
  const labels = labelsOf(side);
  const answer = isRecord(row) ? row : {};
  const failed: string[] = [];
  if (answer.session_user_name !== login) failed.push(labels.sessionUser);
  if (answer.current_user_name !== login) failed.push(labels.currentUser);
  const own = membershipsOf(answer.memberships ?? null);
  const only = own?.length === 1 ? own[0] : undefined;
  if (only?.role !== role || only.inherit !== true || only.set !== false || only.admin !== false) {
    failed.push(labels.memberships);
  }
  if (answer.own_usage !== true) failed.push(labels.ownUsage);
  if (answer.other_member !== false) failed.push(labels.otherMember);
  if (answer.row_security !== true) failed.push(labels.rowSecurity);
  if (answer.schema_name !== "public") failed.push(labels.schema);
  return failed;
}

// ---- the socket (DL-758) --------------------------------------------------------------------------------------------

/** What postgres.js hands its `socket` option: where to connect, and whether it asks for TLS or a Unix socket's path. */
export interface QuietSocketTarget {
  readonly host: readonly string[];
  readonly port: readonly number[];
  readonly ssl?: unknown;
  readonly path?: unknown;
}

/** The part of a cloudflare:sockets Socket the quiet socket uses. */
export interface RawSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/** Opens a raw socket to an address: cloudflare:sockets' connect, or a test's stand-in. */
export type OpenRawSocket = (address: { hostname: string; port: number }) => RawSocket;

/** What the quiet sockets of one handle (or one test) count. */
export interface QuietTally {
  opened: number;
  closed: number;
  peak: number;
  /** Reads that failed once the socket's own close had begun or it had closed, ended quietly. */
  quietReads: number;
  /** Writes that failed once the socket had closed, ended quietly. */
  quietWrites: number;
}

export function quietTally(): QuietTally {
  return { opened: 0, closed: 0, peak: 0, quietReads: 0, quietWrites: 0 };
}

const openRaw: OpenRawSocket = (address) => connect(address);

/**
 * node:buffer's Buffer, which postgres.js reads its data as (it calls Buffer's own methods on each chunk). Typed here by
 * the one method used: the Workers types declare the global Buffer as `any`, and @types/node's is the same value.
 */
const NodeBuffer = Buffer as { from(bytes: Uint8Array): Uint8Array };

/**
 * The socket the handle hands postgres.js (its `socket` option; DL-758): postgres.js's own Workers socket
 * (node_modules/postgres/cf/polyfills.js) over cloudflare:sockets, with one change. A read that fails once the socket's
 * own close has begun (end or destroy, which postgres.js calls to end a connection) or once the socket has closed, and a
 * write that fails once it has closed, end quietly and are counted: postgres.js removes its listeners at the close, so
 * its own socket's emit throws such a failure with nothing to catch it. Every other failure, each one before the socket
 * has closed, reaches postgres.js as its own socket gives it: 'error', then 'close' (a write that fails, a read that
 * fails while the socket is open, the socket's closed promise rejecting). It connects when it is made, since postgres.js
 * calls no connect on a socket it is handed, and takes one host and port with no TLS and no Unix path: Hyperdrive's
 * connection string names one host, and the Worker speaks to Hyperdrive with no TLS of its own (sslmode=disable in the
 * binding's string; anything else is refused, so the connect fails closed). `done` settles once its reads have ended.
 */
export class QuietSocket extends EventEmitter {
  readyState: "opening" | "open" | "closed" = "opening";
  destroyed = false;
  readonly host: string;
  readonly port: number;
  /** Settles once the socket's reads have ended, quietly or not. */
  readonly done: Promise<void>;
  /** Set once postgres.js ends or destroys the socket: its own close has begun. */
  private closing = false;
  private readonly raw: RawSocket;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly tally: QuietTally;

  constructor(target: QuietSocketTarget, tally: QuietTally, open: OpenRawSocket = openRaw) {
    super();
    const [host] = target.host;
    const [port] = target.port;
    if (
      target.host.length !== 1 ||
      target.port.length !== 1 ||
      host === undefined ||
      port === undefined ||
      (target.ssl !== undefined && target.ssl !== false) ||
      (target.path !== undefined && target.path !== false && target.path !== "")
    ) {
      throw new Error("the handle's socket takes one host and one port, with no TLS and no Unix socket");
    }
    this.host = host;
    this.port = port;
    this.tally = tally;
    this.raw = open({ hostname: host, port });
    tally.opened += 1;
    tally.peak = Math.max(tally.peak, tally.opened - tally.closed);
    this.writer = this.raw.writable.getWriter();
    this.reader = this.raw.readable.getReader();
    void this.raw.closed.then(
      () => {
        this.closeOnce();
      },
      (error: unknown) => {
        if (this.readyState !== "closed") this.fail(error);
      },
    );
    // The open, as postgres.js's own socket marks it: postgres.js ends only a socket whose readyState is "open". A
    // failure here is the one that reaches postgres.js through the read and the closed promise.
    void this.writer.ready.then(
      () => {
        if (this.readyState === "opening") this.readyState = "open";
      },
      () => undefined,
    );
    this.done = this.read();
  }

  write(data: Uint8Array, written?: () => void): boolean {
    void this.writer.write(data).then(written, (error: unknown) => {
      // A write that fails once the socket has closed (a connect that never opened: the startup's write fails after
      // the close) has no listener of postgres.js's left to reach, and its emit would throw it unhandled.
      if (this.readyState === "closed") {
        this.tally.quietWrites += 1;
        return;
      }
      this.fail(error);
    });
    return true;
  }

  end(data?: Uint8Array): void {
    this.closing = true;
    if (data === undefined) {
      this.closeRaw();
      return;
    }
    this.write(data, () => {
      this.closeRaw();
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.end();
  }

  private closeRaw(): void {
    // Its outcome is the closed promise's, which the constructor handles.
    void this.raw.close().then(
      () => undefined,
      () => undefined,
    );
  }

  private async read(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) return;
        this.emit("data", NodeBuffer.from(value));
      }
    } catch (error) {
      if (this.closing || this.readyState === "closed") {
        this.tally.quietReads += 1;
        return;
      }
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    this.emit("error", error);
    this.closeOnce();
  }

  private closeOnce(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.tally.closed += 1;
    this.emit("close");
  }
}

// ---- the handle -----------------------------------------------------------------------------------------------------

/** A string that is a binding's connection string, read once from the binding; null for anything else. */
function connectionStringOf(binding: unknown): string | null {
  if (typeof binding !== "object" || binding === null) return null;
  const value: unknown = (binding as { readonly connectionString?: unknown }).connectionString;
  return typeof value === "string" && value !== "" ? value : null;
}

/** DB_SCHEMA is set unless it is missing or empty. */
const schemaSet = (value: unknown): boolean => value !== undefined && value !== "";

/** The SQLSTATE of a PostgreSQL error, else `otherwise`: never the error's message or any other field. */
function sqlstateOf(error: unknown, otherwise: string): string {
  if (error instanceof Error && error.name === "PostgresError") {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && SQLSTATE.test(code)) return code;
  }
  return otherwise;
}

/** Waits for `promises` to settle, at most `ms` milliseconds. */
async function settled(promises: readonly Promise<unknown>[], ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Makes the Worker's database handle over `env` (read at each call). */
export function dbHandle(env: DbEnv, options: DbHandleOptions = {}): DbHandle {
  const now = options.now ?? Date.now;
  const log =
    options.log ??
    ((line: DbRefusalLine) => {
      console.error(JSON.stringify(line));
    });
  const tally = quietTally();
  const clients = { opened: 0, ended: 0 };
  const stepSince = (startedAt: number): DbStepTime => ({
    at: new Date(startedAt).toISOString(),
    ms: Math.max(0, now() - startedAt),
  });

  async function call<T>(side: DbSide, name: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
    const { binding } = DB_SIDES[side];
    if (environmentOf(env) !== "staging") throw new DbClosedError(name, side, "notStaging");
    if (schemaSet(env.DB_SCHEMA)) throw new DbClosedError(name, side, "dbSchemaSet");
    const connectionString = connectionStringOf(env[binding]);
    if (connectionString === null) throw new DbClosedError(name, side, "noBinding");

    // The client's sockets, and whether its end has begun: from then on it opens no connection (postgres.js keeps a
    // reserve() whose connect failed in its queue, and would connect again for it once the failed connection closes).
    const client = { sockets: [] as QuietSocket[], ending: false, ready: false };
    const clientOptions = {
      max: CONNECTIONS_PER_CLIENT,
      connect_timeout: CONNECT_TIMEOUT_SECONDS,
      onnotice: () => undefined,
      socket: (target: QuietSocketTarget): QuietSocket => {
        if (client.ending) throw new Error("this call's client has ended: it opens no connection");
        const socket = new QuietSocket(target, tally);
        client.sockets.push(socket);
        return socket;
      },
    };
    let sql: Sql;
    try {
      sql = postgres(connectionString, clientOptions);
    } catch {
      // postgres.js could not read the string; its error may quote it, so only the call and 08001 leave.
      throw new DataAccessDatabaseError(name, NEVER_OPENED, null, null);
    }
    clients.opened += 1;
    try {
      const connectStarted = now();
      let reserved: postgres.ReservedSql;
      try {
        reserved = await sql.reserve();
      } catch (error) {
        throw new DataAccessDatabaseError(name, sqlstateOf(error, NEVER_OPENED), null, null);
      }
      client.ready = true;
      const connectTime = stepSince(connectStarted);
      const guardStarted = now();
      let rows: readonly unknown[];
      try {
        rows = await reserved.unsafe(guardSelect(side));
      } catch (error) {
        throw new DataAccessDatabaseError(name, sqlstateOf(error, CONNECTION_FAILURE), null, null);
      } finally {
        reserved.release();
      }
      const guardTime = stepSince(guardStarted);
      const [row] = rows;
      const failed = failedChecks(row, side);
      if (failed.length > 0 || !isRecord(row) || typeof row.session_user_name !== "string") {
        log({ level: "error", msg: "dbGuardRefused", side, binding, checks: failed });
        throw new DbGuardRefusal(side, failed);
      }
      options.timing?.({
        call: name,
        side,
        binding,
        login: row.session_user_name,
        connect: connectTime,
        guard: guardTime,
      });
      return await fn(sql);
    } finally {
      client.ending = true;
      try {
        // A connect that failed leaves nothing to end gracefully: its connections are destroyed at once.
        await sql.end({ timeout: client.ready ? END_TIMEOUT_SECONDS : 0 });
      } finally {
        // postgres.js ends only a socket that is open; one it left (still opening) is closed here, and the call returns
        // only once every read of its sockets has ended.
        for (const socket of client.sockets) {
          if (socket.readyState !== "closed") socket.destroy();
        }
        await settled(
          client.sockets.map((socket) => socket.done),
          END_TIMEOUT_SECONDS * 1000,
        );
        clients.ended += 1;
      }
    }
  }

  return {
    runtime: (name, fn) => call("runtime", name, fn),
    toolApi: (name, fn) => call("toolApi", name, fn),
    counts: () => ({
      opened: clients.opened,
      ended: clients.ended,
      connectionsOpen: tally.opened - tally.closed,
      connectionsPeak: tally.peak,
      quietReads: tally.quietReads,
      quietWrites: tally.quietWrites,
    }),
  };
}
