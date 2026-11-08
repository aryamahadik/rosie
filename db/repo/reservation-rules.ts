// Data-access K-05 v1 item 6, the reservation rules (T-198; contracts/data-access/README.md items 8 to 10; arch 05
// line 247; Master Corrections C3; QUESTIONS.md Q-12): how long each door saves a time, the cap of 2 saved times, next in
// line, the release that promotes it, and the one extension.
//
// reserve() and release() are T-187's (db/repo/reservations.ts); this file builds on them and gives them on, rules and all:
//   door lengths   held_until is `at` plus the door's minutes: standard 10 (S12-01; A4-21), ownAi 15 (MC C3: the
//                  customer's own AI booking a service that books at once, with money due or a card to save), planCheck
//                  up to 60 and document up to 1440 (A4-21), ownerOk up to 30 (A5-08, B5-06; MC C3). reserve() here
//                  first refuses a door that is none of the five, since holdMinutesFor alone lets an unknown door take
//                  any minutes (T-187's security note N4).
//   the cap        a third saved time for one mobile (across businesses: its phones row locked FOR UPDATE, then counted
//                  through reservations_saved_times, which runs unscoped and gives only ids and ends) or for one agent
//                  token at one business (a transaction-level advisory lock on the business and the token) is refused
//                  with savedTimeCap and both ends. Waiting rows never count (A4-18).
//   next in line   a time someone else saved, asked with waitIfSaved, becomes a waiting row whose place is `at`.
//   promotion      release() of a held or booked row holds the first waiting row of the same resource whose time
//                  overlaps (queued_at, a tie to the lower id) for 10 minutes, passing over a capped one or one EXCLUDE
//                  refuses. It locks the row first, so of many parallel releases only one releases and promotes; the
//                  others answer repeated, with no promotion.
//
// extend() is this file's (item 10): a saved time gets its one extension, 10 more minutes on its old end (arch 05 line
// 247: "Offered 10 more minutes once, before it ends"; Q-12's default), never on the ownAi door (MC C3: "the 15 minutes
// are never extended"). K-04 v1 keeps no door on the row (K-05 open gap 2), so the caller names it. In one transaction
// under the reservation's business (K-05 "Scope": business), as reserve and release run:
//   1. The row's slot, read without a lock. A row this business cannot see, or that does not exist, is notFound: every
//      read also names the business, so another business's row answers notFound whichever role runs the call (the
//      tables' owner, which row-level security does not bind, until T-1093).
//   2. The locks, in commitTurn's order (db/repo/commit-turn.ts): the reservation's saved-time clock row
//      (`<id>/saved-time`) FOR UPDATE first, as commitTurn and a clock's firing take a clock row before its reservation;
//      then the slot's advisory locks (the resource, and for a worker the person, sorted: the keys reservations.ts's
//      lockSlot takes, slot before row as reserve and release take them), since the new held_until gives the row new
//      index entries that EXCLUDE checks, and two such writes on one slot without the lock wait on each other until
//      PostgreSQL fails one (40P01: T-187's finding); then the row FOR UPDATE. reserve and release take no clock row
//      lock yet; once T-1084 has release cancel the row, taking it before the slot keeps this order.
//   3. The checks, in item 10's order: not held, or its end has passed (held_until <= at, as release counts an ended
//      time), is notHeld with the row's state; the ownAi door is neverExtended; the extension already given is
//      alreadyExtended, so the same request again lands here and changes nothing (README: "the one extension is given
//      once"); then the version is compared (versionChanged).
//   4. The cap's own lock for who the time is saved for (the phones row through reservations_saved_times, or the agent
//      token's advisory lock: what reserve takes before it counts), so a reserve for the same mobile or token that comes
//      while this extension is in flight waits for it and counts the saved time with its new end.
//   5. held_until rises by 10 minutes, extended is set and the version rises by one; the saved-time clock row's due time
//      moves with it while it is armed (Q-12). A fired or cancelled one stays as it is; a saved-time row is armed when
//      it is made (item 8), never waiting. Until reserve() writes that row (lead card T-1084) there is none to move.
// A serialization failure, a deadlock or a lost connection answers transient (nothing was written; the same request may
// be sent again), on a lost-connection-safe transaction as reservations.ts's: no rollback is written to a dead connection
// and it is never released. Nothing here logs; errors name a call or a field, never a value.
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. extend's version is compared last, after notHeld, neverExtended and alreadyExtended, so a repeat of the one
//      extension answers alreadyExtended rather than versionChanged (README table: "Safe: the one extension is given
//      once (alreadyExtended)"; the schema's AlreadyExtendedError: "a repeat lands here and changes nothing").
//   2. Its end has passed when held_until <= at, as release(expired) counts it; an extension asked at the end is notHeld.
//   3. The saved-time clock row moves only while armed (commit-turn.ts default 3 cancels one only while waiting or armed).
//   4. extend takes the slot's and the cap's locks as well as the row's (item 10 names only the row's), for steps 2 and 4.
//   5. reserve() refuses an unknown door with a TypeError before any read, as it refuses wrong minutes for a known one.
import type * as K05 from "../../contracts/generated/data-access/data-access.v1";
import { isLostConnection } from "./bundles";
import {
  holdMinutesFor,
  reserve as reserveSaving,
  reserveIn as reserveSavingIn,
  type Door,
  type ReservationState,
  type ReserveOutcome,
  type ReserveRequest,
} from "./reservations";
import { assertBusinessId, SCOPE_SETTING, type Sql, type Tx } from "./scope";
import { assertRequestShape, transientOrThrow, utc } from "./targets";

export {
  getReservation,
  release,
  releaseIn,
  STANDARD_HOLD_MINUTES,
  type Door,
  type Promotion,
  type ReleaseOutcome,
  type ReleaseRequest,
  type ReleaseWhy,
  type Reservation,
  type ReservationState,
  type ReserveOutcome,
  type ReserveRequest,
  type SavedFor,
} from "./reservations";

/** A transaction's connection: postgres.js's own Tx, or the reserved connection a call runs its transaction on. */
type Conn = Sql | Tx;

/** K-05 v1 extend.request: the reservation, its business, the version read, the door the caller names, and now. */
export type ExtendRequest = K05.ExtendRequest;
/** K-05 v1 extend.response: extended, with the new end. */
export type ExtendResponse = K05.ExtendResponse;
/** K-05 v1 extend.errors: refused, nothing written. */
export type ExtendError = K05.ExtendErrors;
export type ExtendOutcome = ExtendResponse | ExtendError;

/** The one extension: 10 more minutes, once (arch 05 line 247; Q-12's default). */
export const EXTEND_MINUTES = 10;

const DOORS: ReadonlySet<string> = new Set<Door>(["standard", "ownAi", "planCheck", "document", "ownerOk"]);
const EXTEND_FIELDS = ["reservationId", "businessId", "expectVersion", "door", "at"] as const;
const UTC_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

const savedTimeClockId = (reservationId: string): string => `${reservationId}/saved-time`;

// ---- door lengths, and reserve with them --------------------------------------------------------------------------

/**
 * How many minutes a door saves a time for (arch 05 line 247; MC C3; A4-21): standard 10 and ownAi 15, with no
 * holdMinutes; planCheck up to 60, document up to 1440 and ownerOk up to 30, as asked. A door that is none of the five,
 * or minutes the door does not allow, is refused with a TypeError.
 */
export function doorMinutes(door: Door, holdMinutes: number | null): number {
  if (!DOORS.has(door)) {
    throw new TypeError("door is one of standard, ownAi, planCheck, document and ownerOk");
  }
  return holdMinutesFor(door, holdMinutes);
}

/**
 * Saves a resource's time for a mobile, an agent token or a booking, for its door's minutes, in one transaction under
 * the request's business (db/repo/reservations.ts reserve, T-187), after refusing a door that is none of the five.
 */
export async function reserve(sql: Sql, request: ReserveRequest): Promise<ReserveOutcome> {
  doorMinutes(request.door, request.holdMinutes);
  const outcome = await reserveSaving(sql, request);
  return outcome;
}

/** reserve() inside the transaction `tx`, which the caller scoped to the request's business. */
export async function reserveIn(tx: Conn, request: ReserveRequest): Promise<ReserveOutcome> {
  doorMinutes(request.door, request.holdMinutes);
  const outcome = await reserveSavingIn(tx, request);
  return outcome;
}

// ---- extend --------------------------------------------------------------------------------------------------------

interface SlotRow {
  resource_id: string;
  resource_kind: string;
  worker_person_id: string | null;
}

interface LockedRow {
  state: ReservationState;
  held_until: Date | null;
  extended: boolean;
  version: number;
  for_phone_number: string | null;
  for_agent_token: string | null;
  ended: boolean;
}

function assertId(value: unknown, what: string): void {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`extend: ${what} is a non-empty id`);
  }
}

/** Refuses a request that is not K-05's extend.request before anything is read. */
function validateExtend(request: ExtendRequest): void {
  assertRequestShape(request, "extend", EXTEND_FIELDS);
  const raw: Record<string, unknown> = { ...request };
  assertId(raw.reservationId, "reservationId");
  assertId(raw.businessId, "businessId");
  assertBusinessId(request.businessId);
  if (!Number.isSafeInteger(raw.expectVersion) || request.expectVersion < 1) {
    throw new TypeError("extend: expectVersion is a positive integer");
  }
  if (typeof raw.door !== "string" || !DOORS.has(raw.door)) {
    throw new TypeError("extend: door is one of standard, ownAi, planCheck, document and ownerOk");
  }
  if (typeof raw.at !== "string" || !UTC_FORM.test(raw.at) || Number.isNaN(Date.parse(raw.at))) {
    throw new TypeError("extend: at must be a UTC time such as 2026-11-07T15:08:00Z");
  }
}

/**
 * The slot's advisory locks: the resource and, for a worker, the person, sorted, with the same keys as
 * db/repo/reservations.ts's lockSlot and db/repo/commit-turn.ts's lockReleaseSlots, so a write that changes a held
 * row's index entries waits for a reserve or release on the same slot instead of deadlocking with it.
 */
async function lockSlot(tx: Conn, resourceId: string, personId: string | null): Promise<void> {
  const keys = [`resource:${resourceId}`, ...(personId === null ? [] : [`person:${personId}`])].sort();
  for (const key of keys) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}

/**
 * The lock reserve takes before it counts saved times against the cap of 2: a mobile's phones row, FOR UPDATE, through
 * reservations_saved_times (the Tool API's role has no grant on phones; the function locks the row for the rest of
 * this transaction), or an agent token's advisory lock at the business. A booking has no cap and takes none.
 */
async function lockSavedFor(tx: Conn, row: LockedRow, businessId: string, at: string): Promise<void> {
  if (row.for_phone_number !== null) {
    await tx`
      select count(*)::int as saved from reservations_saved_times(${row.for_phone_number}, ${at}::timestamptz)
    `;
    return;
  }
  if (row.for_agent_token !== null) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`token:${businessId}:${row.for_agent_token}`}, 0))`;
  }
}

/**
 * Gives a saved time its one extension inside the transaction `tx`, which the caller scoped to the request's business.
 * Prefer extend(); this is for a caller that already holds a transaction (and so takes the locks above in its order).
 */
export async function extendIn(tx: Conn, request: ExtendRequest): Promise<ExtendOutcome> {
  validateExtend(request);
  const { reservationId: id, businessId } = request;
  const notFound: K05.NotFoundError = { error: "notFound", table: "reservations", rowId: id };

  const [slot] = await tx<SlotRow[]>`
    select resource_id, resource_kind, worker_person_id from reservations
    where id = ${id} and business_id = ${businessId}
  `;
  if (slot === undefined) {
    return notFound;
  }
  const clockId = savedTimeClockId(id);
  const [clock] = await tx<{ state: string }[]>`
    select state from clock_rows
    where id = ${clockId} and business_id = ${businessId} and kind = 'saved_time' and reservation_id = ${id}
    for update
  `;
  if (slot.resource_kind !== "class_session") {
    await lockSlot(tx, slot.resource_id, slot.worker_person_id);
  }
  const [row] = await tx<LockedRow[]>`
    select state, held_until, extended, version, for_phone_number, for_agent_token,
           coalesce(held_until <= ${request.at}::timestamptz, false) as ended
    from reservations
    where id = ${id} and business_id = ${businessId}
    for update
  `;
  if (row === undefined) {
    return notFound;
  }

  if (row.state !== "held" || row.held_until === null || row.ended) {
    return { error: "notHeld", reservationId: id, state: row.state };
  }
  if (request.door === "ownAi") {
    return { error: "neverExtended", reservationId: id, door: "ownAi" };
  }
  if (row.extended) {
    return { error: "alreadyExtended", reservationId: id, heldUntil: utc(row.held_until) };
  }
  if (row.version !== request.expectVersion) {
    return {
      error: "versionChanged",
      changed: [
        { table: "reservations", rowId: id, readVersion: request.expectVersion, currentVersion: row.version },
      ],
    };
  }

  await lockSavedFor(tx, row, businessId, request.at);
  const [extended] = await tx<{ held_until: Date; version: number }[]>`
    update reservations
    set held_until = held_until + make_interval(mins => ${EXTEND_MINUTES}), extended = true,
        version = ${row.version + 1}
    where id = ${id} and business_id = ${businessId}
    returning held_until, version
  `;
  if (extended === undefined) {
    throw new Error("extend: the update of reservations returned no row");
  }
  if (clock?.state === "armed") {
    await tx`
      update clock_rows set due_at = ${extended.held_until}, version = version + 1
      where id = ${clockId} and state = 'armed'
    `;
  }
  return {
    result: "extended",
    reservationId: id,
    version: extended.version,
    heldUntil: utc(extended.held_until),
  };
}

/**
 * One transaction on one reserved connection, scoped to `businessId` (set_config inside it, is_local), read committed:
 * reservations.ts's inScopedTransaction. A lost connection is rethrown without a rollback (the server rolled the
 * transaction back when the backend went) and is never released (postgres.js 3.4.9 would put it back in the open
 * queue); the pre-probe takes the stale error a killed connection keeps before a connection is reserved.
 */
async function inBusinessTransaction<T>(
  sql: Sql,
  businessId: string,
  fn: (tx: Conn) => Promise<T>,
): Promise<T> {
  assertBusinessId(businessId);
  await sql`select 1`;
  const reserved = await sql.reserve();
  let lost = false;
  try {
    await reserved`begin`;
    let result: T;
    try {
      await reserved`select set_config(${SCOPE_SETTING}, ${businessId}, true)`;
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

/**
 * Gives a saved time its one extension, 10 more minutes on its end, never for the ownAi door, in one transaction under
 * the request's business (K-05 v1 item 6; README item 10).
 */
export async function extend(sql: Sql, request: ExtendRequest): Promise<ExtendOutcome> {
  validateExtend(request);
  try {
    return await inBusinessTransaction(sql, request.businessId, (tx) => extendIn(tx, request));
  } catch (error) {
    return transientOrThrow(error);
  }
}
