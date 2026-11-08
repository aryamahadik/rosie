// Data-access calls for reservations and class seats (K-04 v1 core, T-187; K-05 v1 item 6: reserve and release).
//
// The database refuses a double booking, not this code: a worker, room or vehicle's held or booked time cannot overlap
// (EXCLUDE, 23P01), and a class session's seat counter cannot pass its capacity (CHECK, 23514). reserve() writes the row
// and reads the refusal; it never checks for a free slot first, so two parallel calls cannot both pass.
//
// Both calls run under the reservation's business (withBusiness; row-level security itself is T-191's). Every row update
// raises the version by one (trigger from 0002).
//
// Left to later tasks, as the card says: the saved-time clock row (no clock_rows table exists yet, so the answer names
// its id, `<reservation id>/saved-time`, and writes nothing), the cap lookup through an unscoped database function (T-191,
// when row-level security would hide other businesses' rows), the one extension (extend) and the commit's confirm.
import { withBusiness } from "./scope";
import type { Sql, Tx } from "./scope";

type Db = Sql | Tx;

export type ReservationState = "held" | "waiting" | "booked" | "released";
export type ReleaseWhy = "expired" | "let_go" | "cancelled";
export type Door = "standard" | "ownAi" | "planCheck" | "document" | "ownerOk";

/** Who a time is saved for: a mobile, an agent token or a booking (K-04 reservations_for_someone). */
export type SavedFor = { phoneNumber: string } | { agentToken: string } | { bookingId: string };

export interface Reservation {
  id: string;
  businessId: string;
  resourceId: string;
  resourceKind: "worker" | "room" | "vehicle" | "class_session";
  workerPersonId: string | null;
  during: { start: string; end: string };
  state: ReservationState;
  queuedAt: string;
  seats: number;
  heldUntil: string | null;
  extended: boolean;
  forPhoneNumber: string | null;
  forAgentToken: string | null;
  bookingId: string | null;
  releasedAt: string | null;
  releasedWhy: ReleaseWhy | null;
  version: number;
}

export interface ClassSeats {
  resourceId: string;
  businessId: string;
  capacity: number;
  taken: number;
  version: number;
}

export interface ReserveRequest {
  reservationId: string;
  businessId: string;
  resourceId: string;
  during: { start: string; end: string };
  seats: number;
  for: SavedFor;
  door: Door;
  holdMinutes: number | null;
  waitIfSaved: boolean;
  at: string;
}

export type ReserveOutcome =
  | {
      result: "held";
      reservationId: string;
      version: number;
      resourceId: string;
      during: { start: string; end: string };
      heldUntil: string;
      savedTimeClockId: string;
      repeated: boolean;
    }
  | {
      result: "waiting";
      reservationId: string;
      version: number;
      resourceId: string;
      during: { start: string; end: string };
      queuedAt: string;
      repeated: boolean;
    }
  | { error: "overlap"; resourceId: string }
  | { error: "seatsFull"; resourceId: string; capacity: number; taken: number }
  | { error: "savedTimeCap"; saved: { reservationId: string; heldUntil: string }[] }
  | { error: "notBookable"; resourceId: string }
  | { error: "idConflict"; reservationId: string }
  | { error: "transient"; sqlstate: string };

export interface ReleaseRequest {
  reservationId: string;
  businessId: string;
  /** The version read; null for the saved-time clock's expiry, which checks held_until instead. */
  expectVersion: number | null;
  why: ReleaseWhy;
  at: string;
}

export interface Promotion {
  reservationId: string;
  version: number;
  heldUntil: string;
  forPhoneNumber: string | null;
  forAgentToken: string | null;
  bookingId: string | null;
  savedTimeClockId: string;
}

export type ReleaseOutcome =
  | {
      result: "released";
      reservationId: string;
      version: number;
      releasedAt: string;
      why: ReleaseWhy;
      promoted: Promotion | null;
      skipped: { reservationId: string; reason: "overlap" | "savedTimeCap" }[];
      repeated: boolean;
    }
  | { error: "notExpired"; reservationId: string; heldUntil: string }
  | {
      error: "versionChanged";
      changed: { table: "reservations"; rowId: string; readVersion: number; currentVersion: number }[];
    }
  | { error: "notFound"; table: "reservations"; rowId: string }
  | { error: "transient"; sqlstate: string };

/** Minutes of a standard saved time (S12-01) and of the promoted next in line. */
export const STANDARD_HOLD_MINUTES = 10;
const OWN_AI_HOLD_MINUTES = 15;
const MAX_HOLD_MINUTES = { planCheck: 60, document: 1440, ownerOk: 30 } as const;
/** At most this many saved times per mobile across businesses, or per agent token per business (arch 05 line 247). */
const SAVED_TIME_CAP = 2;

const UTC_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const RESERVATION_COLUMNS = `
  id, business_id, resource_id, resource_kind, worker_person_id, lower(during) as d_start, upper(during) as d_end,
  state, queued_at, seats, held_until, extended, for_phone_number, for_agent_token, booking_id, released_at,
  released_why, version
`;

interface ReservationRow {
  id: string;
  business_id: string;
  resource_id: string;
  resource_kind: Reservation["resourceKind"];
  worker_person_id: string | null;
  d_start: Date;
  d_end: Date;
  state: ReservationState;
  queued_at: Date;
  seats: number;
  held_until: Date | null;
  extended: boolean;
  for_phone_number: string | null;
  for_agent_token: string | null;
  booking_id: string | null;
  released_at: Date | null;
  released_why: ReleaseWhy | null;
  version: number;
}

const iso = (date: Date): string => date.toISOString().replace(".000Z", "Z");
const isoOrNull = (date: Date | null): string | null => (date === null ? null : iso(date));

const toReservation = (row: ReservationRow): Reservation => ({
  id: row.id,
  businessId: row.business_id,
  resourceId: row.resource_id,
  resourceKind: row.resource_kind,
  workerPersonId: row.worker_person_id,
  during: { start: iso(row.d_start), end: iso(row.d_end) },
  state: row.state,
  queuedAt: iso(row.queued_at),
  seats: row.seats,
  heldUntil: isoOrNull(row.held_until),
  extended: row.extended,
  forPhoneNumber: row.for_phone_number,
  forAgentToken: row.for_agent_token,
  bookingId: row.booking_id,
  releasedAt: isoOrNull(row.released_at),
  releasedWhy: row.released_why,
  version: row.version,
});

function assertUtc(value: string, what: string): void {
  if (!UTC_FORM.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${what} must be a UTC time such as 2026-11-07T15:05:00Z`);
  }
}

/** How long a saved time lasts for a door (arch 05 line 247; MC C3). */
export function holdMinutesFor(door: Door, holdMinutes: number | null): number {
  if (door === "standard" || door === "ownAi") {
    if (holdMinutes !== null) {
      throw new TypeError(`the ${door} door takes no holdMinutes`);
    }
    return door === "standard" ? STANDARD_HOLD_MINUTES : OWN_AI_HOLD_MINUTES;
  }
  if (holdMinutes === null || !Number.isInteger(holdMinutes) || holdMinutes < 1) {
    throw new TypeError(`the ${door} door needs holdMinutes of at least 1`);
  }
  if (holdMinutes > MAX_HOLD_MINUTES[door]) {
    throw new TypeError(`the ${door} door holds at most ${String(MAX_HOLD_MINUTES[door])} minutes`);
  }
  return holdMinutes;
}

function validateReserve(request: ReserveRequest): number {
  assertUtc(request.at, "at");
  assertUtc(request.during.start, "during.start");
  assertUtc(request.during.end, "during.end");
  if (Date.parse(request.during.start) >= Date.parse(request.during.end)) {
    throw new TypeError("during must start before it ends");
  }
  if (!Number.isInteger(request.seats) || request.seats < 1) {
    throw new TypeError("seats is a positive integer");
  }
  return holdMinutesFor(request.door, request.holdMinutes);
}

function savedForColumns(who: SavedFor): {
  phone: string | null;
  token: string | null;
  booking: string | null;
} {
  return {
    phone: "phoneNumber" in who ? who.phoneNumber : null,
    token: "agentToken" in who ? who.agentToken : null,
    booking: "bookingId" in who ? who.bookingId : null,
  };
}

const transientCodes = new Set(["40001", "40P01"]);

function sqlstateOf(error: unknown): { code: string | undefined; constraint: string | undefined } {
  const failure = error as { code?: string; constraint_name?: string };
  return { code: failure.code, constraint: failure.constraint_name };
}

// ---- reads and set-up ---------------------------------------------------------------------------------------------

export async function getReservation(sql: Db, id: string): Promise<Reservation | null> {
  const [row] = await sql<
    ReservationRow[]
  >`select ${sql.unsafe(RESERVATION_COLUMNS)} from reservations where id = ${id}`;
  return row === undefined ? null : toReservation(row);
}

export async function getClassSeats(sql: Db, resourceId: string): Promise<ClassSeats | null> {
  const [row] = await sql<
    { resource_id: string; business_id: string; capacity: number; taken: number; version: number }[]
  >`select resource_id, business_id, capacity, taken, version from class_seats where resource_id = ${resourceId}`;
  return row === undefined
    ? null
    : {
        resourceId: row.resource_id,
        businessId: row.business_id,
        capacity: row.capacity,
        taken: row.taken,
        version: row.version,
      };
}

/** Makes the seat counter of a class session (a resource of kind class_session) with no seat taken. */
export async function createClassSeats(
  sql: Db,
  input: { resourceId: string; businessId: string; capacity: number },
): Promise<ClassSeats> {
  await sql`
    insert into class_seats (resource_id, business_id, capacity)
    values (${input.resourceId}, ${input.businessId}, ${input.capacity})
  `;
  const made = await getClassSeats(sql, input.resourceId);
  if (made === null) {
    throw new Error("insert into class_seats returned no row");
  }
  return made;
}

// ---- reserve ------------------------------------------------------------------------------------------------------

interface ResourceRow {
  id: string;
  business_id: string;
  kind: Reservation["resourceKind"];
  person_id: string | null;
  active: boolean;
}

interface SavedRow {
  id: string;
  held_until: Date;
}

/**
 * Takes a transaction-level advisory lock on the resource and, for a worker, on the person, in one fixed order. The
 * database's EXCLUDE is what refuses a double booking; this lock only makes parallel inserts for one slot run one after
 * the other, because two inserts that overlap each wait on the other's uncommitted row and PostgreSQL then breaks the
 * deadlock by failing one of them (40P01) after a second. Every call that writes a held row takes it first, before any
 * phones or token lock, so the order is the same everywhere.
 */
async function lockSlot(tx: Tx, resourceId: string, personId: string | null): Promise<void> {
  const keys = [`resource:${resourceId}`, ...(personId === null ? [] : [`person:${personId}`])].sort();
  for (const key of keys) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}

/**
 * Takes the lock that makes the cap of 2 safe, then lists the saved (held, not yet ended) times of who they are for. A
 * mobile: its phones row FOR UPDATE, so parallel reserves for one mobile run one after the other, counted across every
 * business. An agent token (it has no row): a transaction-level advisory lock on the business and the token, counted at
 * that business. A booking: no cap. Waiting rows never count (A4-18).
 */
async function lockAndListSaved(tx: Tx, who: SavedFor, businessId: string, at: string): Promise<SavedRow[]> {
  const columns = savedForColumns(who);
  if (columns.phone !== null) {
    await tx`select 1 from phones where number = ${columns.phone} for update`;
    return tx<SavedRow[]>`
      select id, held_until from reservations
      where for_phone_number = ${columns.phone} and state = 'held' and held_until > ${at}::timestamptz
      order by held_until, id
    `;
  }
  if (columns.token !== null) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`token:${businessId}:${columns.token}`}, 0))`;
    return tx<SavedRow[]>`
      select id, held_until from reservations
      where for_agent_token = ${columns.token} and business_id = ${businessId} and state = 'held'
        and held_until > ${at}::timestamptz
      order by held_until, id
    `;
  }
  return [];
}

const sameRequest = (row: Reservation, request: ReserveRequest): boolean => {
  const who = savedForColumns(request.for);
  return (
    row.businessId === request.businessId &&
    row.resourceId === request.resourceId &&
    Date.parse(row.during.start) === Date.parse(request.during.start) &&
    Date.parse(row.during.end) === Date.parse(request.during.end) &&
    row.seats === request.seats &&
    row.forPhoneNumber === who.phone &&
    row.forAgentToken === who.token &&
    (who.booking === null || row.bookingId === who.booking)
  );
};

/**
 * The same reservation id again: the same request gets its outcome back (`repeated`), another is `idConflict`. K-04 keeps
 * no copy of the request, so "the same" is the row's own business, resource, time, seats and who it is for. A row that
 * has since been booked or released has no reserve outcome to give back, so it also answers `idConflict`.
 */
function repeatOutcome(row: Reservation, request: ReserveRequest): ReserveOutcome {
  if (!sameRequest(row, request) || (row.state !== "held" && row.state !== "waiting")) {
    return { error: "idConflict", reservationId: request.reservationId };
  }
  if (row.state === "held" && row.heldUntil !== null) {
    return heldOutcome(row, true);
  }
  return {
    result: "waiting",
    reservationId: row.id,
    version: row.version,
    resourceId: row.resourceId,
    during: row.during,
    queuedAt: row.queuedAt,
    repeated: true,
  };
}

const savedTimeClockId = (reservationId: string): string => `${reservationId}/saved-time`;

function heldOutcome(row: Reservation, repeated: boolean): ReserveOutcome {
  return {
    result: "held",
    reservationId: row.id,
    version: row.version,
    resourceId: row.resourceId,
    during: row.during,
    heldUntil: row.heldUntil ?? "",
    savedTimeClockId: savedTimeClockId(row.id),
    repeated,
  };
}

/** Thrown inside a savepoint to undo it and leave with an answer. */
class Refused extends Error {
  constructor(readonly outcome: ReserveOutcome) {
    super("refused");
  }
}

async function insertReservation(
  tx: Tx,
  request: ReserveRequest,
  resource: ResourceRow,
  state: "held" | "waiting",
  heldMinutes: number,
): Promise<Reservation> {
  const who = savedForColumns(request.for);
  const [row] = await tx<ReservationRow[]>`
    insert into reservations (
      id, business_id, resource_id, resource_kind, worker_person_id, during, state, queued_at, seats, held_until,
      for_phone_number, for_agent_token, booking_id
    )
    values (
      ${request.reservationId}, ${request.businessId}, ${resource.id}, ${resource.kind}, ${resource.person_id},
      tstzrange(${request.during.start}::timestamptz, ${request.during.end}::timestamptz, '[)'), ${state},
      ${request.at}::timestamptz, ${request.seats},
      ${state === "held" ? tx`${request.at}::timestamptz + make_interval(mins => ${heldMinutes})` : null},
      ${who.phone}, ${who.token}, ${who.booking}
    )
    returning ${tx.unsafe(RESERVATION_COLUMNS)}
  `;
  if (row === undefined) {
    throw new Error("insert into reservations returned no row");
  }
  return toReservation(row);
}

/** Whether a booked time already covers the asked one, for the resource or, for a worker, the person at any business. */
async function bookedOverlap(tx: Tx, request: ReserveRequest, resource: ResourceRow): Promise<boolean> {
  const rows = await tx`
    select 1 from reservations
    where state = 'booked'
      and during && tstzrange(${request.during.start}::timestamptz, ${request.during.end}::timestamptz, '[)')
      and (resource_id = ${resource.id} or (${resource.person_id}::text is not null and worker_person_id = ${resource.person_id}))
    limit 1
  `;
  return rows.length > 0;
}

/**
 * Saves a resource's time inside the transaction `tx`, which the caller scoped to the request's business.
 * Prefer reserve(); this is for a caller that already holds a transaction.
 */
export async function reserveIn(tx: Tx, request: ReserveRequest): Promise<ReserveOutcome> {
  const minutes = validateReserve(request);

  const [resource] = await tx<ResourceRow[]>`
    select id, business_id, kind, person_id, active from resources where id = ${request.resourceId}
  `;
  if (resource?.business_id !== request.businessId || !resource.active) {
    return { error: "notBookable", resourceId: request.resourceId };
  }

  if (resource.kind !== "class_session") {
    await lockSlot(tx, resource.id, resource.person_id);
  }

  const existing = await getReservation(tx, request.reservationId);
  if (existing !== null) {
    return repeatOutcome(existing, request);
  }

  const saved = await lockAndListSaved(tx, request.for, request.businessId, request.at);
  // A parallel call with the same id may have committed while this one waited for the lock: answer as its repeat.
  const writtenMeanwhile = await getReservation(tx, request.reservationId);
  if (writtenMeanwhile !== null) {
    return repeatOutcome(writtenMeanwhile, request);
  }
  if (saved.length >= SAVED_TIME_CAP) {
    return {
      error: "savedTimeCap",
      saved: saved.slice(0, SAVED_TIME_CAP).map((row) => ({
        reservationId: row.id,
        heldUntil: iso(row.held_until),
      })),
    };
  }

  try {
    if (resource.kind === "class_session") {
      return await tx.savepoint(async (sp) => {
        const row = await insertReservation(sp, request, resource, "held", minutes);
        const bumped = await sp`
          update class_seats set taken = taken + ${request.seats}, version = version + 1
          where resource_id = ${resource.id} and business_id = ${request.businessId}
          returning resource_id
        `;
        if (bumped.length === 0) {
          throw new Refused({ error: "notBookable", resourceId: request.resourceId });
        }
        return heldOutcome(row, false);
      });
    }
    return await tx.savepoint(async (sp) =>
      heldOutcome(await insertReservation(sp, request, resource, "held", minutes), false),
    );
  } catch (error) {
    if (error instanceof Refused) {
      return error.outcome;
    }
    const { code, constraint } = sqlstateOf(error);
    if ((code === "23505" && constraint === "reservations_pkey") || code === "23P01") {
      // A parallel call with the same id (no lock to wait on: a booking) may have won the insert: answer as a repeat.
      const first = await getReservation(tx, request.reservationId);
      if (first !== null) {
        return repeatOutcome(first, request);
      }
    }
    if (code === "23514" && constraint === "class_seats_taken_within_capacity") {
      const seats = await getClassSeats(tx, request.resourceId);
      return {
        error: "seatsFull",
        resourceId: request.resourceId,
        capacity: seats?.capacity ?? 0,
        taken: seats?.taken ?? 0,
      };
    }
    if (code === "23P01") {
      if (!request.waitIfSaved || (await bookedOverlap(tx, request, resource))) {
        return { error: "overlap", resourceId: request.resourceId };
      }
      // Someone has saved the time: wait next in line (A4-18), place in line is `at`.
      const waiting = await tx.savepoint((sp) => insertReservation(sp, request, resource, "waiting", 0));
      return {
        result: "waiting",
        reservationId: waiting.id,
        version: waiting.version,
        resourceId: waiting.resourceId,
        during: waiting.during,
        queuedAt: waiting.queuedAt,
        repeated: false,
      };
    }
    throw error;
  }
}

/** Saves a resource's time for a mobile, an agent token or a booking, in one transaction under the request's business. */
export async function reserve(sql: Sql, request: ReserveRequest): Promise<ReserveOutcome> {
  validateReserve(request);
  try {
    return await withBusiness(sql, request.businessId, (tx) => reserveIn(tx, request));
  } catch (error) {
    const { code } = sqlstateOf(error);
    if (code !== undefined && transientCodes.has(code)) {
      return { error: "transient", sqlstate: code };
    }
    throw error;
  }
}

// ---- release ------------------------------------------------------------------------------------------------------

/**
 * Releases a reservation inside the transaction `tx`, which the caller scoped to the request's business: expired (its
 * saved time ended; needs a held row past its held_until), let go or cancelled. A held or booked row promotes the next in
 * line (K-05 README item 9): the waiting rows of the same resource whose time overlaps, earliest queued_at first, a tie to
 * the lower id; the first one that can be held is promoted, and the ones passed over are named.
 */
export async function releaseIn(tx: Tx, request: ReleaseRequest): Promise<ReleaseOutcome> {
  assertUtc(request.at, "at");
  if (
    request.expectVersion !== null &&
    (!Number.isSafeInteger(request.expectVersion) || request.expectVersion < 1)
  ) {
    throw new TypeError("expectVersion is a positive integer or null");
  }
  // The slot's lock first (as reserve takes it), then the row's: see lockSlot.
  const [slot] = await tx<{ resource_id: string; resource_kind: string; worker_person_id: string | null }[]>`
    select resource_id, resource_kind, worker_person_id from reservations where id = ${request.reservationId}
  `;
  if (slot !== undefined && slot.resource_kind !== "class_session") {
    await lockSlot(tx, slot.resource_id, slot.worker_person_id);
  }
  const [locked] = await tx<(ReservationRow & { ended: boolean })[]>`
    select ${tx.unsafe(RESERVATION_COLUMNS)}, coalesce(held_until <= ${request.at}::timestamptz, false) as ended
    from reservations where id = ${request.reservationId} for update
  `;
  if (locked === undefined) {
    return { error: "notFound", table: "reservations", rowId: request.reservationId };
  }
  const before = toReservation(locked);
  if (before.state === "released" && before.releasedAt !== null && before.releasedWhy !== null) {
    return {
      result: "released",
      reservationId: before.id,
      version: before.version,
      releasedAt: before.releasedAt,
      why: before.releasedWhy,
      promoted: null,
      skipped: [],
      repeated: true,
    };
  }
  if (request.why === "expired") {
    if (before.state !== "held" || before.heldUntil === null) {
      // The clock fired for a time that is no longer saved (booked or waiting): there is no end to name.
      throw new Error("an expired release needs a held row");
    }
    if (!locked.ended) {
      return { error: "notExpired", reservationId: before.id, heldUntil: before.heldUntil };
    }
  }
  if (request.expectVersion !== null && request.expectVersion !== before.version) {
    return {
      error: "versionChanged",
      changed: [
        {
          table: "reservations",
          rowId: before.id,
          readVersion: request.expectVersion,
          currentVersion: before.version,
        },
      ],
    };
  }

  const [released] = await tx<ReservationRow[]>`
    update reservations
    set state = 'released', released_at = ${request.at}::timestamptz, released_why = ${request.why},
        version = ${before.version + 1}
    where id = ${before.id}
    returning ${tx.unsafe(RESERVATION_COLUMNS)}
  `;
  if (released === undefined) {
    throw new Error("update of reservations returned no row");
  }
  const after = toReservation(released);

  const tookTime = before.state === "held" || before.state === "booked";
  if (tookTime && before.resourceKind === "class_session") {
    await tx`
      update class_seats set taken = taken - ${before.seats}, version = version + 1
      where resource_id = ${before.resourceId}
    `;
  }

  let promoted: Promotion | null = null;
  const skipped: { reservationId: string; reason: "overlap" | "savedTimeCap" }[] = [];
  if (tookTime && before.resourceKind !== "class_session") {
    const line = await tx<ReservationRow[]>`
      select ${tx.unsafe(RESERVATION_COLUMNS)} from reservations
      where state = 'waiting' and resource_id = ${before.resourceId}
        and during && tstzrange(${before.during.start}::timestamptz, ${before.during.end}::timestamptz, '[)')
      order by queued_at, id
      for update
    `;
    for (const waiting of line.map(toReservation)) {
      const who: SavedFor =
        waiting.forPhoneNumber !== null
          ? { phoneNumber: waiting.forPhoneNumber }
          : waiting.forAgentToken !== null
            ? { agentToken: waiting.forAgentToken }
            : { bookingId: waiting.bookingId ?? "" };
      const saved = await lockAndListSaved(tx, who, waiting.businessId, request.at);
      if (saved.length >= SAVED_TIME_CAP) {
        skipped.push({ reservationId: waiting.id, reason: "savedTimeCap" });
        continue;
      }
      try {
        const held = await tx.savepoint(async (sp) => {
          const [row] = await sp<ReservationRow[]>`
            update reservations
            set state = 'held', version = ${waiting.version + 1},
                held_until = ${request.at}::timestamptz + make_interval(mins => ${STANDARD_HOLD_MINUTES})
            where id = ${waiting.id}
            returning ${sp.unsafe(RESERVATION_COLUMNS)}
          `;
          if (row === undefined) {
            throw new Error("update of reservations returned no row");
          }
          return toReservation(row);
        });
        promoted = {
          reservationId: held.id,
          version: held.version,
          heldUntil: held.heldUntil ?? "",
          forPhoneNumber: held.forPhoneNumber,
          forAgentToken: held.forAgentToken,
          bookingId: held.bookingId,
          savedTimeClockId: savedTimeClockId(held.id),
        };
        break;
      } catch (error) {
        if (sqlstateOf(error).code !== "23P01") {
          throw error;
        }
        skipped.push({ reservationId: waiting.id, reason: "overlap" });
      }
    }
  }

  return {
    result: "released",
    reservationId: after.id,
    version: after.version,
    releasedAt: after.releasedAt ?? request.at,
    why: request.why,
    promoted,
    skipped,
    repeated: false,
  };
}

/** Releases a reservation in one transaction under the request's business, promoting the next in line. */
export async function release(sql: Sql, request: ReleaseRequest): Promise<ReleaseOutcome> {
  try {
    return await withBusiness(sql, request.businessId, (tx) => releaseIn(tx, request));
  } catch (error) {
    const { code } = sqlstateOf(error);
    if (code !== undefined && transientCodes.has(code)) {
      return { error: "transient", sqlstate: code };
    }
    throw error;
  }
}
