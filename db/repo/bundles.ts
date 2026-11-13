// Data-access calls for the bundle registry (K-05 v1 item 7; K-04 v1 core `bundles` and `bundle_values`; T-185).
//
//   readActiveBundle     the active bundle id, read at turn start (arch 10 line 536). A read, primary, uncached.
//   readBundleValue      one bundle value from PostgreSQL's copy, on a KV miss.
//   publishBundleCopy    the registry row and every value, written once, before the active id switches (BP 5.4).
//   setActiveBundle      the deploy script's step 3: compare-and-set of the active id. Rolling back is the same call
//                        with the earlier id: every published bundle stays readable for replay (tour line 658).
//
// Every call answers with the contract's outcome (contracts/data-access fixtures): a response, or an error shape such as
// `notPublished`. A failure of the database is answered by targets.ts's transientOrThrow under the call's K-05 name, as
// every runtime-side call's is (T-1314): a serialization failure (40001), a deadlock (40P01), a lost connection
// (SQLSTATE class 08; 57P01 to 57P03; postgres.js's CONNECTION_CLOSED, CONNECTION_DESTROYED, CONNECTION_ENDED, the
// socket's ECONNRESET, EPIPE and ETIMEDOUT, and a socket's failure with no code, as 08006) and a connection that never
// opened (08001: CONNECT_TIMEOUT, ECONNREFUSED, ENOTFOUND and the others of T-1268; a reserve() that never connects,
// below) answer `transient`: nothing was written and the same request may be sent again. Any other failure to open or
// keep a session (a TLS or certificate error, EACCES, SASL_SIGNATURE_MISMATCH, PostgreSQL's class 28 and 53300) is
// thrown scrubbed: the call's name and the code alone, never a host, port, user or password. Times are UTC text ending
// in Z. Every value reaches the database as a bound parameter.
//
// This file imports none of its neighbours when it loads: infra/ci/release-harness.mjs imports it under Node with no
// resolve hook, and Node finds a neighbour named without its extension (./targets) only through one. So targets.ts's
// transientOrThrow is imported when a call fails (targets.ts imports this file in turn, for isLostConnection).
//
// Publishing never changes the active id. Switching serializes on one transaction-level advisory lock, then locks the
// active row and the target row, so parallel switches run one after the other and exactly one id is active at any time
// (the partial unique index bundles_one_active refuses a second one as a last guard).
import { createHash } from "node:crypto";
import type { Sql, Tx } from "./scope";

/** A connection `sql.reserve()` gives: one transaction's own, until it is released. */
type Reserved = Awaited<ReturnType<Sql["reserve"]>>;

export interface BundleId {
  hash: string;
  build: number;
}

/** One bundle value as PostgreSQL's copy holds it: the K-01 key and kind, its size and sha256, and its UTF-8 text. */
export interface StoredText {
  key: string;
  kind: "manifest" | "flow" | "trade";
  bytes: number;
  sha256: string;
  text: string;
}

export interface TransientError {
  error: "transient";
  sqlstate: string;
}

export type ReadActiveBundleResult =
  | { result: "active"; bundleId: BundleId; manifestKey: string; activatedAt: string }
  | { error: "noActiveBundle" }
  | TransientError;

export interface ReadBundleValueRequest {
  key: string;
}

export type ReadBundleValueResult =
  | { result: "value"; value: StoredText }
  | { error: "notFound"; table: "bundle_values"; rowId: string }
  | TransientError;

export interface PublishBundleCopyRequest {
  bundleId: BundleId;
  builtAt: string;
  manifestKey: string;
  values: StoredText[];
}

export type PublishBundleCopyResult =
  | { result: "published"; bundleId: BundleId; publishedAt: string; values: number; repeated: boolean }
  | { error: "valueMismatch"; key: string }
  | TransientError;

export interface SetActiveBundleRequest {
  bundleId: BundleId;
  /** The active id the script read, or null when none was active. */
  expectActive: BundleId | null;
  at: string;
}

export type SetActiveBundleResult =
  | {
      result: "activated";
      bundleId: BundleId;
      /** The id that was active before; null when none was, and on a repeat. */
      previous: BundleId | null;
      activatedAt: string;
      repeated: boolean;
    }
  | { error: "notPublished"; bundleId: BundleId }
  | { error: "activeChanged"; active: BundleId | null }
  | TransientError;

export interface PublishOptions {
  /** The moment of publishing (default: the database clock). */
  now?: Date;
}

interface BundleRow {
  hash: string;
  build: number;
  manifest_key: string;
  published_at: Date;
  active: boolean;
  activated_at: Date | null;
}

interface ValueRow {
  key: string;
  kind: StoredText["kind"];
  bytes: number;
  sha256: string;
  value: Uint8Array;
}

/**
 * postgres.js's own codes for a connection that is gone. They carry no SQLSTATE, so they answer 08006
 * (connection_failure), a default listed in the handoff.
 */
const LOST_CONNECTION_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  // A reset or broken socket reaches the call as the socket's own error, with no CONNECTION_CLOSED.
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
]);
/**
 * Node's code for a connection its own side gave up (ECONNABORTED): gone too, so isLostConnection knows it and no
 * rollback is written to it, nor is it released (T-1314 round 2, from T-1330's finding b; DL-649). It is not answered
 * 08006: targets.ts's transientOrThrow throws it scrubbed, as T-1268 rules (a session that failed, not transient).
 */
const ABORTED_CONNECTION_CODE = "ECONNABORTED";
/**
 * JavaScript's own errors for a value or a program at fault, the names of targets.ts's FAULT_NAMES: postgres.js rejects
 * a statement with one when it cannot build the statement or read its rows (a value it cannot send), never when its
 * socket fails, so the connection is still open.
 */
const FAULT_NAMES = new Set([
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
]);
/** The SQLSTATE of a connection the client could not open: 08001, sqlclient_unable_to_establish_sqlconnection. */
const NEVER_OPENED_SQLSTATE = "08001";
/** Held for the length of a switch of the active bundle. */
const ACTIVE_SWITCH_LOCK = "rosie.bundles.active";

/** UTC text ending in Z, without a zero fraction (the contract's form: 2026-11-07T08:06:00Z). */
function utc(date: Date): string {
  return date.toISOString().replace(".000Z", "Z");
}

function idOf(row: { hash: string; build: number }): BundleId {
  return { hash: row.hash, build: row.build };
}

function sameId(a: BundleId, b: BundleId): boolean {
  return a.hash === b.hash && a.build === b.build;
}

/**
 * True for an error that says the connection the call ran on is gone or going (see the codes above, ECONNABORTED among
 * them), and for a socket's failure with no code (T-1314): postgres.js's Workers build passes its socket's failure up as
 * the socket gives it, with no code (cf/polyfills.js), and rejects the statement in flight with it, the statement put on
 * it as own properties (connection.js queryError: query and parameters), a commit or a rollback as any other. That is
 * targets.ts's transientOrThrow's own rule for a lost connection with no code (08006), so inRuntimeTransaction and the
 * transactions below never write a rollback to that dead connection, and never release it. PostgreSQL's own errors and
 * JavaScript's errors for a fault (FAULT_NAMES), which postgres.js also rejects a statement with, are not: their
 * connection is still open, and is rolled back.
 */
export function isLostConnection(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string") {
    return (
      LOST_CONNECTION_CODES.has(code) ||
      code === ABORTED_CONNECTION_CODE ||
      /^(08[0-9A-Z]{3}|57P0[123])$/.test(code)
    );
  }
  return (
    error instanceof Error &&
    error.name !== "PostgresError" &&
    !FAULT_NAMES.has(error.name) &&
    (Object.hasOwn(error, "query") || Object.hasOwn(error, "parameters"))
  );
}

/**
 * `sql.reserve()`, whose failure to connect never leaves raw (T-1314). A reserve() that never connects passes up the
 * error its connect failed with as it is: postgres.js's connection.js queryError puts no statement on a reserve()'s
 * error, and in its Workers build the socket's failure has no code (cf/polyfills.js), so transientOrThrow could tell it
 * by nothing and would throw it as it is. Such a failure, with no code and not PostgreSQL's own, leaves here as a
 * connection that never opened: a new error carrying the code 08001 and a fixed message, with no message, stack, cause
 * or property of the original's, which transientOrThrow answers transient 08001, as T-1268 answers a connect that never
 * opened (no statement went out: nothing was written, and the same request may be sent again). A failure with a code
 * (Node's ECONNREFUSED, postgres.js's CONNECT_TIMEOUT, a TLS error) and PostgreSQL's refusal of the session are passed
 * on as they are, for transientOrThrow to answer by its lists.
 */
export async function reserveConnection(sql: Sql): Promise<Reserved> {
  try {
    return await sql.reserve();
  } catch (error) {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    const postgresError = error instanceof Error && error.name === "PostgresError";
    throw typeof code !== "string" && !postgresError ? neverOpened() : error;
  }
}

/** A connection that never opened, as reserveConnection passes it on: the code 08001 alone. */
function neverOpened(): Error {
  return Object.assign(
    new Error(`the database connection never opened (SQLSTATE ${NEVER_OPENED_SQLSTATE})`),
    {
      code: NEVER_OPENED_SQLSTATE,
    },
  );
}

/**
 * One transaction on one reserved connection (read committed, like sql.begin). postgres.js's own `begin` answers a
 * failure with a `rollback` written to the connection even when that connection is gone, and that write throws from a
 * timer, outside any promise, which would end the process. Here a connection found gone (targets.ts's foundGone, as
 * inRuntimeTransaction decides it: a lost connection, or a statement's failure that is a session's failure or answers
 * 08001; T-1350) is rethrown without a rollback (the server rolled the transaction back when the backend went). Such a
 * connection is also never released: in postgres.js 3.4.9 `release()` puts the connection back in the open queue even
 * after it moved to the closed queue (or before the socket's close event does), and the next query on that client is
 * then written to a null socket. Left unreleased, the connection stays where postgres.js's own close handling puts it
 * and reconnects for the next query. Every other failure, an error fn makes itself among them, is rolled back, and
 * every other outcome releases the connection. foundGone is imported as the transaction starts, before a connection is
 * reserved (never when this file loads: see its top), so each decision is made at once, with no turn of the event loop
 * between a failure and its rollback. A connection that closes while idle between fn's statements is met as a
 * statement's failure too (T-1330's note d): fn awaits nothing but statements on this connection, so its next
 * statement is in flight before Node delivers the socket's error or close, and postgres.js rejects it with that error.
 */
async function inTransaction<T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  const { foundGone } = await import("./targets");
  // postgres.js 3.4.9 keeps a killed connection's last query and its FATAL, and the first query after the reconnect
  // fails with that stale error. A failed `reserve()` stays queued and strands the connection it was given, so the
  // stale error is taken here by an ordinary query (which is rejected cleanly) and `reserve()` then finds a
  // connection that has already answered once. The failure of this one query is a transient answer like any other.
  await sql`select 1`;
  const reserved = await reserveConnection(sql);
  let lost = false;
  try {
    await reserved`begin`;
    let result: T;
    try {
      result = await fn(reserved);
    } catch (error) {
      if (!foundGone(error)) {
        await reserved`rollback`;
      }
      throw error;
    }
    await reserved`commit`;
    return result;
  } catch (error) {
    lost = foundGone(error);
    throw error;
  } finally {
    if (!lost) {
      reserved.release();
    }
  }
}

/**
 * A call's answer to a failure: targets.ts's transientOrThrow, under the K-05 call's name (T-1314; see the top of this
 * file), so these calls answer exactly as the runtime side's do and their scrubbed errors carry their names. Imported
 * here, when a call fails, never when this file loads (see the top of this file).
 */
async function transientOrThrow(error: unknown, call: string): Promise<TransientError> {
  const targets = await import("./targets");
  return targets.transientOrThrow(error, call);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toStoredText(row: ValueRow): StoredText {
  return {
    key: row.key,
    kind: row.kind,
    bytes: row.bytes,
    sha256: row.sha256,
    text: decoder.decode(row.value),
  };
}

// ---- reads ---------------------------------------------------------------------------------------------------------

/** The active bundle id with its manifest key, or `noActiveBundle` before the first deploy's step 3. */
export async function readActiveBundle(sql: Sql | Tx): Promise<ReadActiveBundleResult> {
  try {
    const [row] = await sql<BundleRow[]>`select * from bundles where active`;
    if (row === undefined || row.activated_at === null) {
      return { error: "noActiveBundle" };
    }
    return {
      result: "active",
      bundleId: idOf(row),
      manifestKey: row.manifest_key,
      activatedAt: utc(row.activated_at),
    };
  } catch (error) {
    return transientOrThrow(error, "readActiveBundle");
  }
}

/** One value by its KV key, with its stored size and sha256, which the reader checks against the text. */
export async function readBundleValue(
  sql: Sql | Tx,
  request: ReadBundleValueRequest,
): Promise<ReadBundleValueResult> {
  const { key } = request;
  try {
    const [row] = await sql<ValueRow[]>`
      select key, kind, bytes, sha256, value from bundle_values where key = ${key}
    `;
    if (row === undefined) {
      return { error: "notFound", table: "bundle_values", rowId: key };
    }
    return { result: "value", value: toStoredText(row) };
  } catch (error) {
    return transientOrThrow(error, "readBundleValue");
  }
}

// ---- publish -------------------------------------------------------------------------------------------------------

/** The first value whose size or sha256 does not match its text, or whose key is not this bundle's own. */
function firstBadValue(request: PublishBundleCopyRequest): string | null {
  const { hash, build } = request.bundleId;
  for (const value of request.values) {
    const bytes = encoder.encode(value.text);
    const parts = value.key.split("/");
    const ofThisBundle =
      parts[0] === "bundle" && parts[1] === hash && parts[2] === String(build) && parts[3] === value.kind;
    if (bytes.length !== value.bytes || sha256Hex(bytes) !== value.sha256 || !ofThisBundle) {
      return value.key;
    }
  }
  return null;
}

/**
 * Writes the registry row (not active) and every value in one transaction. The same bundle again with the same values
 * writes nothing and answers `repeated` with the first publishing time. A value whose bytes or sha256 do not match its
 * text, a key that already holds other bytes, or a key the bundle did not hold at its first publish answers
 * `valueMismatch` and writes nothing. It never changes which bundle is active.
 */
export async function publishBundleCopy(
  sql: Sql,
  request: PublishBundleCopyRequest,
  options: PublishOptions = {},
): Promise<PublishBundleCopyResult> {
  const bad = firstBadValue(request);
  if (bad !== null) {
    return { error: "valueMismatch", key: bad };
  }
  // K-05's schema: values has at least one entry, the manifest among them (K-05 gives no answer to a refused request;
  // default: valueMismatch naming the manifest key, the value that is missing).
  if (!request.values.some((value) => value.kind === "manifest" && value.key === request.manifestKey)) {
    return { error: "valueMismatch", key: request.manifestKey };
  }
  const { hash, build } = request.bundleId;
  const at = options.now ?? null;
  try {
    return await inTransaction<PublishBundleCopyResult>(sql, async (tx) => {
      // A parallel publish of the same id waits on the unique indexes here, then sees the winner's row and does nothing
      // (no conflict target: the manifest key, which the id determines, is a second unique rule).
      const [inserted] = await tx<BundleRow[]>`
        insert into bundles (hash, build, manifest_key, built_at, published_at)
        values (
          ${hash}, ${build}, ${request.manifestKey}, ${request.builtAt}::timestamptz,
          coalesce(${at}::timestamptz, clock_timestamp())
        )
        on conflict do nothing
        returning *
      `;
      if (inserted !== undefined) {
        for (const value of request.values) {
          await tx`
            insert into bundle_values (key, bundle_hash, bundle_build, kind, bytes, sha256, value)
            values (
              ${value.key}, ${hash}, ${build}, ${value.kind}, ${value.bytes}, ${value.sha256},
              ${encoder.encode(value.text)}::bytea
            )
          `;
        }
        return {
          result: "published",
          bundleId: { hash, build },
          publishedAt: utc(inserted.published_at),
          values: request.values.length,
          repeated: false,
        };
      }
      const [first] = await tx<BundleRow[]>`select * from bundles where hash = ${hash} and build = ${build}`;
      if (first === undefined) {
        throw new Error("the bundle row is missing after a conflict");
      }
      for (const value of request.values) {
        const [stored] = await tx<ValueRow[]>`
          select key, kind, bytes, sha256, value from bundle_values where key = ${value.key}
        `;
        if (stored?.kind !== value.kind || stored.bytes !== value.bytes || stored.sha256 !== value.sha256) {
          return { error: "valueMismatch", key: value.key };
        }
      }
      return {
        result: "published",
        bundleId: { hash, build },
        publishedAt: utc(first.published_at),
        values: request.values.length,
        repeated: true,
      };
    });
  } catch (error) {
    return transientOrThrow(error, "publishBundleCopy");
  }
}

// ---- switching the active id ---------------------------------------------------------------------------------------

/**
 * The deploy script's step 3. In one transaction: take the switch lock, lock the active row and the target row, then
 *   - no registry row for the target: `notPublished`;
 *   - the target is already active: `repeated` (checked before `expectActive`, so a repeated call is a repeat);
 *   - the active id is not `expectActive`: `activeChanged` with the id that is active;
 *   - else clear the active row and set the target, with `activated_at` = `at`. Both versions rise by one.
 * Rolling back is the same call with the earlier id.
 */
export async function setActiveBundle(
  sql: Sql,
  request: SetActiveBundleRequest,
): Promise<SetActiveBundleResult> {
  const target = request.bundleId;
  try {
    return await inTransaction<SetActiveBundleResult>(sql, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${ACTIVE_SWITCH_LOCK}))`;
      const [current] = await tx<BundleRow[]>`select * from bundles where active for update`;
      const [wanted] = await tx<BundleRow[]>`
        select * from bundles where hash = ${target.hash} and build = ${target.build} for update
      `;
      if (wanted === undefined) {
        return { error: "notPublished", bundleId: target };
      }
      if (wanted.active) {
        return {
          result: "activated",
          bundleId: target,
          previous: null,
          activatedAt: utc(wanted.activated_at ?? new Date(request.at)),
          repeated: true,
        };
      }
      const active = current === undefined ? null : idOf(current);
      const expected = request.expectActive;
      const matches = expected === null ? active === null : active !== null && sameId(active, expected);
      if (!matches) {
        return { error: "activeChanged", active };
      }
      if (current !== undefined) {
        await tx`
          update bundles set active = false, version = version + 1
          where hash = ${current.hash} and build = ${current.build}
        `;
      }
      const [updated] = await tx<BundleRow[]>`
        update bundles set active = true, activated_at = ${request.at}::timestamptz, version = version + 1
        where hash = ${target.hash} and build = ${target.build}
        returning *
      `;
      if (updated === undefined || updated.activated_at === null) {
        throw new Error("the target bundle row is missing after the switch");
      }
      return {
        result: "activated",
        bundleId: target,
        previous: active,
        activatedAt: utc(updated.activated_at),
        repeated: false,
      };
    });
  } catch (error) {
    return transientOrThrow(error, "setActiveBundle");
  }
}
