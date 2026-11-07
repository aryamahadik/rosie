// Data-access calls for the bundle registry (K-05 v1 item 7; K-04 v1 core `bundles` and `bundle_values`; T-185).
//
//   readActiveBundle     the active bundle id, read at turn start (arch 10 line 536). A read, primary, uncached.
//   readBundleValue      one bundle value from PostgreSQL's copy, on a KV miss.
//   publishBundleCopy    the registry row and every value, written once, before the active id switches (BP 5.4).
//   setActiveBundle      the deploy script's step 3: compare-and-set of the active id. Rolling back is the same call
//                        with the earlier id: every published bundle stays readable for replay (tour line 658).
//
// Every call answers with the contract's outcome (contracts/data-access fixtures): a response, or an error shape such as
// `notPublished`. A serialization failure (40001), a deadlock (40P01) or a lost connection (postgres.js's
// CONNECTION_CLOSED, CONNECTION_DESTROYED, CONNECTION_ENDED and the socket's ECONNRESET, EPIPE and ETIMEDOUT as 08006;
// SQLSTATE class 08; 57P01 to 57P03) answers
// `transient`: nothing was written and the same request may be sent again. Times are UTC text ending in Z. Every value reaches the database as a bound parameter.
//
// Publishing never changes the active id. Switching serializes on one transaction-level advisory lock, then locks the
// active row and the target row, so parallel switches run one after the other and exactly one id is active at any time
// (the partial unique index bundles_one_active refuses a second one as a last guard).
import { createHash } from "node:crypto";
import type { Sql, Tx } from "./scope";

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

/** A serialization failure, a deadlock, and a server that shut down or dropped this backend (57P01 to 57P03). */
const TRANSIENT_SQLSTATES = new Set(["40001", "40P01", "57P01", "57P02", "57P03"]);
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
const LOST_CONNECTION_SQLSTATE = "08006";
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

/** True for an error that says the connection the call ran on is gone or going (see the codes above). */
export function isLostConnection(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return (
    typeof code === "string" && (LOST_CONNECTION_CODES.has(code) || /^(08[0-9A-Z]{3}|57P0[123])$/.test(code))
  );
}

/**
 * One transaction on one reserved connection (read committed, like sql.begin). postgres.js's own `begin` answers a
 * failure with a `rollback` written to the connection even when that connection is gone, and that write throws from a
 * timer, outside any promise, which would end the process. Here a lost connection is rethrown without a rollback (the
 * server rolled the transaction back when the backend went). A lost connection is also never released: in postgres.js
 * 3.4.9 `release()` puts the connection back in the open queue even after it moved to the closed queue (or before the
 * socket's close event does), and the next query on that client is then written to a null socket. Left unreleased, the
 * connection stays where postgres.js's own close handling puts it and reconnects for the next query. Every other
 * outcome releases the connection.
 */
async function inTransaction<T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  // postgres.js 3.4.9 keeps a killed connection's last query and its FATAL, and the first query after the reconnect
  // fails with that stale error. A failed `reserve()` stays queued and strands the connection it was given, so the
  // stale error is taken here by an ordinary query (which is rejected cleanly) and `reserve()` then finds a
  // connection that has already answered once. The failure of this one query is a transient answer like any other.
  await sql`select 1`;
  const reserved = await sql.reserve();
  let lost = false;
  try {
    await reserved`begin`;
    let result: T;
    try {
      result = await fn(reserved);
    } catch (error) {
      if (!isLostConnection(error)) {
        await reserved`rollback`;
      }
      throw error;
    }
    await reserved`commit`;
    return result;
  } catch (error) {
    lost = isLostConnection(error);
    throw error;
  } finally {
    if (!lost) {
      reserved.release();
    }
  }
}

function transientOrThrow(error: unknown): TransientError {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string") {
    if (TRANSIENT_SQLSTATES.has(code) || /^08[0-9A-Z]{3}$/.test(code)) {
      return { error: "transient", sqlstate: code };
    }
    if (LOST_CONNECTION_CODES.has(code)) {
      return { error: "transient", sqlstate: LOST_CONNECTION_SQLSTATE };
    }
  }
  throw error;
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
    return transientOrThrow(error);
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
    return transientOrThrow(error);
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
    return transientOrThrow(error);
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
    return transientOrThrow(error);
  }
}
