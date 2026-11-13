// Data-access calls for reservations and class seats (K-04 v1 core, T-187; K-05 v1 item 6: reserve and release).
//
// The database refuses a double booking, not this code: a worker, room or vehicle's held or booked time cannot overlap
// (EXCLUDE, 23P01), and a class session's seat counter cannot pass its capacity (CHECK, 23514). reserve() writes the row
// and reads the refusal; it never checks for a free slot first, so two parallel calls cannot both pass.
//
// Both calls run under the reservation's business (the scope set inside their own transaction), and row-level security
// (T-191) shows them only that business's rows. Two reads must see beyond it, so they go through the security-definer
// database functions of T-191's migration (K-05 item 8; T-1085), narrowed by T-1094's, which return only ids and ends,
// or yes or no: a mobile's saved times at every business for the cap of 2 (reservations_saved_times, which also locks
// its phones row), and whether a booked time covers the asked one for the resource at this business or for its worker
// at any business (reservations_booked_overlap; FS line 743). Their transaction is lost-connection safe
// (inScopedTransaction): a lost connection answers transient with no rollback written to the dead connection. Every row
// update raises the version by one (trigger from 0002).
//
// A failure of the database is answered by targets.ts's transientOrThrow under the call's K-05 name, reserve or release,
// as extend's and the runtime side's calls' are (T-1314): a serialization failure, a deadlock, a lost connection and a
// connection that never opened (08001, a reserve() that never connects included: bundles.ts reserveConnection) answer
// transient; any other failure to open or keep a session is thrown scrubbed, the call's name and the code alone, never
// a host, port, user or password.
//
// One row per holder per slot (T-1134, from T-744 round 1's security review, GAP 1; DL-292). A holder is who the cap of
// 2 counts (holderOf, the one definition): a mobile, the same at every business, or an agent token at one business; a
// time saved for a booking has no holder. A slot is a resource's time that overlaps the asked or released one, as EXCLUDE
// and the line read it. Both rules run inside the call's one transaction, under the slot's lock:
//   (1) reserve() with waitIfSaved, for a holder that already holds or waits on the slot, writes nothing and answers its
//       own row as its first save got it (held with its end, or waiting with its place in line), repeated, under that
//       row's id. So a save never waits behind its own holder's saved time, and one holder saving one slot twice at once
//       gets one row: the second save waits on the slot's lock, then finds the first.
//   (2) release() of a held or booked row lets go every waiting row of the released holder in its line (released,
//       let_go, at `at`) and promotes the first waiting row of another holder, or nobody. So no holder holds one slot
//       twice in a row through the line, and MC C3's 15 minutes ("never extended", line 35) are never extended that way.
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. (1)'s answer says repeated: the call wrote nothing, as a repeat of the same request answers (K-05 README,
//      "Repeating it"); its reservationId is the holder's own row's, not the asked one.
//   2. (1) is read before the cap of 2: asking again for the slot it holds or waits on is no third saved time.
//   3. A held row whose end has passed counts as held until its release lets it go: EXCLUDE still covers it.
//   4. A class session has no line (reserve answers seatsFull, K-05 README item 9), so neither rule applies to it.
//   5. (2)'s rows are released with why let_go (the card's "let go with it"); release's answer names none of them, since
//      K-05 v1's skipped has no reason for them.
//
// Left to later tasks: the saved-time clock row and the one extension (extend). clock_rows exists (migration 0009), but
// reserve() writes no clock row yet: the answer names its id, `<reservation id>/saved-time`. That row is owned by the
// mobile's handle (K-05 item 8), which this call's role (rosie_app) cannot read from handles or phones, so the task that
// writes it reads the handle's id alone through handles_id_of_mobile (T-1094). The commit confirms a held row
// (db/repo/commit-turn.ts, T-195).
import type postgres from "postgres";
import { isLostConnection, reserveConnection } from "./bundles";
import { assertBusinessId, SCOPE_SETTING } from "./scope";
import type { Sql, Tx } from "./scope";
import { foundGone, transientOrThrow } from "./targets";

type Db = Sql | Tx;
/** A transaction's connection: postgres.js's own Tx, or the reserved connection inScopedTransaction runs on. */
type Conn = Db;

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

/**
 * Who holds a saved time, as the cap of 2 counts it (arch 05 line 247; K-05 README item 8): a mobile, the same at every
 * business, or an agent token at one business. A time saved for a booking has no holder (no cap, and neither of
 * T-1134's rules). The one definition the cap, reserve's own row and release's let-go read (T-1134).
 */
type Holder = { phone: string } | { agentToken: string; businessId: string };

function holderOf(who: SavedFor, businessId: string): Holder | null {
  const columns = savedForColumns(who);
  if (columns.phone !== null) {
    return { phone: columns.phone };
  }
  if (columns.token !== null) {
    return { agentToken: columns.token, businessId };
  }
  return null;
}

/** Who a row is saved for, as a promotion counts it: its mobile, else its agent token, else its booking. */
function savedForOf(row: Reservation): SavedFor {
  if (row.forPhoneNumber !== null) {
    return { phoneNumber: row.forPhoneNumber };
  }
  if (row.forAgentToken !== null) {
    return { agentToken: row.forAgentToken };
  }
  return { bookingId: row.bookingId ?? "" };
}

const holderOfRow = (row: Reservation): Holder | null => holderOf(savedForOf(row), row.businessId);

/** Whether two holders are one: the same mobile, or the same agent token at the same business. No holder is nobody's. */
function sameHolder(a: Holder | null, b: Holder | null): boolean {
  if (a === null || b === null) {
    return false;
  }
  if ("phone" in a) {
    return "phone" in b && a.phone === b.phone;
  }
  return "agentToken" in b && a.agentToken === b.agentToken && a.businessId === b.businessId;
}

/** The rows of `holder`, as a condition on reservations: its mobile's at any business, or its token's at its business. */
function ofHolder(tx: Conn, holder: Holder): postgres.Fragment {
  return "phone" in holder
    ? tx`for_phone_number = ${holder.phone}`
    : tx`for_agent_token = ${holder.agentToken} and business_id = ${holder.businessId}`;
}

function sqlstateOf(error: unknown): { code: string | undefined; constraint: string | undefined } {
  const failure = error as { code?: string; constraint_name?: string };
  return { code: failure.code, constraint: failure.constraint_name };
}

let savepointCount = 0;

/**
 * Runs `fn` inside a savepoint of the open transaction (the reserved connection has no `savepoint` method of its own):
 * on a failure the savepoint is rolled back, so the transaction can go on; on a lost connection nothing is written to
 * the dead connection.
 */
async function inSavepoint<T>(tx: Conn, fn: () => Promise<T>): Promise<T> {
  savepointCount += 1;
  const name = `rosie_sp_${String(savepointCount)}`;
  await tx.unsafe(`savepoint ${name}`);
  try {
    const result = await fn();
    await tx.unsafe(`release savepoint ${name}`);
    return result;
  } catch (error) {
    if (!isLostConnection(error)) {
      await tx.unsafe(`rollback to savepoint ${name}`);
    }
    throw error;
  }
}

/**
 * One transaction on one reserved connection, scoped to `businessId` (set_config inside it, is_local), read committed
 * like sql.begin. postgres.js's own `begin` writes a `rollback` to a connection that is gone, from a timer outside any
 * promise (T-185), so a connection found gone (targets.ts's foundGone, as inRuntimeTransaction decides it: a lost
 * connection, or a statement's failure that is a session's failure or answers 08001; T-1350) is rethrown here without
 * a rollback (the server rolled the transaction back when the backend went) and is never released (postgres.js 3.4.9
 * would put it back in the open queue); an error fn makes itself is rolled back and released. A connection that closes
 * while idle between fn's statements is met as a statement's failure too (T-1330's note d): fn awaits nothing but
 * statements on this connection, so its next statement is in flight before Node delivers the socket's error or close,
 * and postgres.js rejects it with that error. The same pre-probe as bundles.ts takes the stale error a killed
 * connection keeps, by an ordinary query, before a connection is reserved, and a reserve() that never connects leaves
 * as a connection that never opened (bundles.ts reserveConnection, T-1314).
 */
async function inScopedTransaction<T>(
  sql: Sql,
  businessId: string,
  fn: (tx: Conn) => Promise<T>,
): Promise<T> {
  assertBusinessId(businessId);
  await sql`select 1`;
  const reserved = await reserveConnection(sql);
  let lost = false;
  try {
    await reserved`begin`;
    let result: T;
    try {
      await reserved`select set_config(${SCOPE_SETTING}, ${businessId}, true)`;
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
async function lockSlot(tx: Conn, resourceId: string, personId: string | null): Promise<void> {
  const keys = [`resource:${resourceId}`, ...(personId === null ? [] : [`person:${personId}`])].sort();
  for (const key of keys) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}

/**
 * Takes the lock that makes the cap of 2 safe, then lists the saved (held, not yet ended) times of who they are for. A
 * mobile: its phones row FOR UPDATE, so parallel reserves for one mobile run one after the other, counted across every
 * business; both happen in reservations_saved_times (K-05 item 8), which runs unscoped, since this transaction's scope
 * shows only its own business's rows, and returns only the rows' ids and ends. An agent token (it has no row): a
 * transaction-level advisory lock on the business and the token, counted at that business. A booking (no holder): no cap.
 * Waiting rows never count (A4-18).
 */
async function lockAndListSaved(tx: Conn, holder: Holder | null, at: string): Promise<SavedRow[]> {
  if (holder === null) {
    return [];
  }
  if ("phone" in holder) {
    return tx<SavedRow[]>`
      select id, held_until from reservations_saved_times(${holder.phone}, ${at}::timestamptz)
      order by held_until, id
    `;
  }
  await tx`select pg_advisory_xact_lock(hashtextextended(${`token:${holder.businessId}:${holder.agentToken}`}, 0))`;
  return tx<SavedRow[]>`
    select id, held_until from reservations
    where ${ofHolder(tx, holder)} and state = 'held' and held_until > ${at}::timestamptz
    order by held_until, id
  `;
}

/**
 * T-1134 rule (1): the holder's own row on the asked slot, when it already holds or waits on it: its held or waiting row
 * of the same resource whose time overlaps the asked one (as EXCLUDE and the line read a slot), a held one first, then
 * the earliest in line. Read under the slot's lock, which every save, promotion and let-go of the slot takes first, so a
 * parallel save of the same slot by the same holder is seen once it commits.
 */
async function ownRowOnSlot(tx: Conn, request: ReserveRequest, holder: Holder): Promise<Reservation | null> {
  const [row] = await tx<ReservationRow[]>`
    select ${tx.unsafe(RESERVATION_COLUMNS)} from reservations
    where resource_id = ${request.resourceId} and state in ('held', 'waiting')
      and during && tstzrange(${request.during.start}::timestamptz, ${request.during.end}::timestamptz, '[)')
      and ${ofHolder(tx, holder)}
    order by state = 'held' desc, queued_at, id
    limit 1
  `;
  return row === undefined ? null : toReservation(row);
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
  return answeredAgain(row);
}

/**
 * A held or waiting row's save, answered again with nothing written (`repeated`): held with its end, or waiting with its
 * place in line, as it stands now. A repeat of the same request answers this way, and so does T-1134's rule (1).
 */
function answeredAgain(row: Reservation): ReserveOutcome {
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
  readonly outcome: ReserveOutcome;

  constructor(outcome: ReserveOutcome) {
    super("refused");
    this.outcome = outcome;
  }
}

async function insertReservation(
  tx: Conn,
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

/**
 * Whether a booked time already covers the asked one, for the resource at this business or, for a worker, the person at
 * any business (FS line 743): read through reservations_booked_overlap, a security-definer function (the other
 * businesses' rows are hidden from this transaction's scope) that matches the resource only within the scope, the
 * worker anywhere, and answers only yes or no.
 */
async function bookedOverlap(tx: Conn, request: ReserveRequest, resource: ResourceRow): Promise<boolean> {
  const [row] = await tx<{ overlap: boolean }[]>`
    select reservations_booked_overlap(
      ${resource.id},
      ${resource.person_id}::text,
      tstzrange(${request.during.start}::timestamptz, ${request.during.end}::timestamptz, '[)')
    ) as overlap
  `;
  return row?.overlap === true;
}

/**
 * Saves a resource's time inside the transaction `tx`, which the caller scoped to the request's business.
 * Prefer reserve(); this is for a caller that already holds a transaction.
 */
export async function reserveIn(tx: Conn, request: ReserveRequest): Promise<ReserveOutcome> {
  const minutes = validateReserve(request);

  // The same reservation id with the same request answers its outcome again, whatever has changed about the resource
  // since (K-05 README item 8, and the table of repeats: "Safe").
  const known = await getReservation(tx, request.reservationId);
  if (known !== null) {
    return repeatOutcome(known, request);
  }

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

  const holder = holderOf(request.for, request.businessId);
  const saved = await lockAndListSaved(tx, holder, request.at);
  // A parallel call with the same id may have committed while this one waited for the lock: answer as its repeat.
  const writtenMeanwhile = await getReservation(tx, request.reservationId);
  if (writtenMeanwhile !== null) {
    return repeatOutcome(writtenMeanwhile, request);
  }
  // T-1134 rule (1): a holder that already holds or waits on this slot, asking to wait if it is saved, gets its own row
  // back as its first save got it, and nothing is written: a save never waits behind its own holder's saved time.
  if (request.waitIfSaved && holder !== null && resource.kind !== "class_session") {
    const own = await ownRowOnSlot(tx, request, holder);
    if (own !== null) {
      return answeredAgain(own);
    }
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
      return await inSavepoint(tx, async () => {
        const row = await insertReservation(tx, request, resource, "held", minutes);
        const bumped = await tx`
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
    return await inSavepoint(tx, async () =>
      heldOutcome(await insertReservation(tx, request, resource, "held", minutes), false),
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
      if (code === "23505") {
        // The id is taken by another business's reservation, which this scope cannot see (row-level security): it is
        // never this request, so another request with that id.
        return { error: "idConflict", reservationId: request.reservationId };
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
      // Someone has saved the time (never this holder: rule (1) answered that above): wait next in line (A4-18), place
      // in line is `at`.
      const waiting = await inSavepoint(tx, () => insertReservation(tx, request, resource, "waiting", 0));
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
    return await inScopedTransaction(sql, request.businessId, (tx) => reserveIn(tx, request));
  } catch (error) {
    return transientOrThrow(error, "reserve");
  }
}

// ---- release ------------------------------------------------------------------------------------------------------

/**
 * Releases a reservation inside the transaction `tx`, which the caller scoped to the request's business: expired (its
 * saved time ended; needs a held row past its held_until), let go or cancelled. A held or booked row promotes the next in
 * line (K-05 README item 9): the waiting rows of the same resource whose time overlaps, earliest queued_at first, a tie to
 * the lower id; the first one that can be held is promoted, and the ones passed over are named. The released holder's
 * own waiting rows in that line are never promoted: they are let go with it (T-1134 rule (2)).
 */
export async function releaseIn(tx: Conn, request: ReleaseRequest): Promise<ReleaseOutcome> {
  assertUtc(request.at, "at");
  if (request.expectVersion === null) {
    // null is only for the clock's expiry (K-05 README item 9); a let go or a cancel always compares the version.
    if (request.why !== "expired") {
      throw new TypeError(
        `a ${request.why} release needs the version read (null is only for the clock's expiry)`,
      );
    }
  } else if (!Number.isSafeInteger(request.expectVersion) || request.expectVersion < 1) {
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
    const line = (
      await tx<ReservationRow[]>`
        select ${tx.unsafe(RESERVATION_COLUMNS)} from reservations
        where state = 'waiting' and resource_id = ${before.resourceId}
          and during && tstzrange(${before.during.start}::timestamptz, ${before.during.end}::timestamptz, '[)')
        order by queued_at, id
        for update
      `
    ).map(toReservation);
    // T-1134 rule (2): the released holder's own waiting rows, wherever they stand in the line, are let go with it and
    // never promoted, so its time never passes back to it through the line.
    const releasedHolder = holderOfRow(before);
    const own = line.filter((waiting) => sameHolder(holderOfRow(waiting), releasedHolder));
    if (own.length > 0) {
      await tx`
        update reservations
        set state = 'released', released_at = ${request.at}::timestamptz, released_why = 'let_go',
            version = version + 1
        where id in ${tx(own.map((waiting) => waiting.id))} and state = 'waiting'
      `;
    }
    for (const waiting of line.filter((row) => !own.includes(row))) {
      const saved = await lockAndListSaved(tx, holderOfRow(waiting), request.at);
      if (saved.length >= SAVED_TIME_CAP) {
        skipped.push({ reservationId: waiting.id, reason: "savedTimeCap" });
        continue;
      }
      try {
        const held = await inSavepoint(tx, async () => {
          const [row] = await tx<ReservationRow[]>`
            update reservations
            set state = 'held', version = ${waiting.version + 1},
                held_until = ${request.at}::timestamptz + make_interval(mins => ${STANDARD_HOLD_MINUTES})
            where id = ${waiting.id}
            returning ${tx.unsafe(RESERVATION_COLUMNS)}
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
    return await inScopedTransaction(sql, request.businessId, (tx) => releaseIn(tx, request));
  } catch (error) {
    return transientOrThrow(error, "release");
  }
}
