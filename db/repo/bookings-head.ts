// Data-access calls for bookable resources and the booking head row (K-04 v1 core; T-186).
//
// The head holds what the guard, the hubs and the send-time flags read: business, flow, stage, version, the booker, the
// person served and the payer (three separate references), and the private and deceased flags. The rest of the booking
// is K-30's. Every update is a compare-and-set on the row's version, as db/repo/people.ts: it passes the version the
// caller read, the row is written only if it still has that version, and the version rises by one. A write made from an
// old read changes nothing and returns the row as it is now. The database refuses any other update that does not raise
// the version by one (trigger from 0002).
import type { Sql, Tx } from "./scope";

type Db = Sql | Tx;

export type ResourceKind = "worker" | "room" | "vehicle" | "class_session";
export type BookingFlow = "A" | "B";
export type BookingStage = "entry" | "booked" | "checked_in" | "done" | "cancelled";

export interface Resource {
  id: string;
  businessId: string;
  kind: ResourceKind;
  name: string;
  /** For a worker, the person; null otherwise. */
  personId: string | null;
  active: boolean;
  version: number;
}

export interface BookingHead {
  id: string;
  businessId: string;
  flow: BookingFlow;
  stage: BookingStage;
  /** Who booked. */
  bookerPersonId: string;
  /** The person served; null until known. */
  servedPersonId: string | null;
  /** The payer; null until known. */
  payerPersonId: string | null;
  private: boolean;
  deceased: boolean;
  version: number;
}

/** A compare-and-set: written, or refused with the row as it is now (null when the row does not exist). */
export type UpdateResult<Row> = { ok: true; row: Row } | { ok: false; current: Row | null };

export interface NewResource {
  id: string;
  businessId: string;
  kind: ResourceKind;
  name: string;
  /** Required for a worker, and only for a worker (the database checks resources_worker_is_person). */
  personId?: string | null;
  /** Default true. */
  active?: boolean;
}

export interface NewBookingHead {
  id: string;
  businessId: string;
  flow: BookingFlow;
  /** Default entry. */
  stage?: BookingStage;
  bookerPersonId: string;
  servedPersonId?: string | null;
  payerPersonId?: string | null;
  /** Default false. */
  private?: boolean;
  /** Default false. */
  deceased?: boolean;
}

export interface BookingHeadPatch {
  stage?: BookingStage;
  servedPersonId?: string | null;
  payerPersonId?: string | null;
  private?: boolean;
  deceased?: boolean;
}

interface ResourceRow {
  id: string;
  business_id: string;
  kind: ResourceKind;
  name: string;
  person_id: string | null;
  active: boolean;
  version: number;
}

interface BookingRow {
  id: string;
  business_id: string;
  flow: BookingFlow;
  stage: BookingStage;
  booker_person_id: string;
  served_person_id: string | null;
  payer_person_id: string | null;
  private: boolean;
  deceased: boolean;
  version: number;
}

const toResource = (row: ResourceRow): Resource => ({
  id: row.id,
  businessId: row.business_id,
  kind: row.kind,
  name: row.name,
  personId: row.person_id,
  active: row.active,
  version: row.version,
});

const toBookingHead = (row: BookingRow): BookingHead => ({
  id: row.id,
  businessId: row.business_id,
  flow: row.flow,
  stage: row.stage,
  bookerPersonId: row.booker_person_id,
  servedPersonId: row.served_person_id,
  payerPersonId: row.payer_person_id,
  private: row.private,
  deceased: row.deceased,
  version: row.version,
});

function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError("a row version is a positive integer");
  }
}

// ---- resources ----------------------------------------------------------------------------------------------------

export async function getResource(sql: Db, id: string): Promise<Resource | null> {
  const [row] = await sql<ResourceRow[]>`select * from resources where id = ${id}`;
  return row === undefined ? null : toResource(row);
}

/** A business's resources, by id; with `kind`, only that kind; with `activeOnly`, only those that can be booked now. */
export async function listResources(
  sql: Db,
  businessId: string,
  options: { kind?: ResourceKind; activeOnly?: boolean } = {},
): Promise<Resource[]> {
  const rows = await sql<ResourceRow[]>`
    select * from resources
    where business_id = ${businessId}
      and (${options.kind ?? null}::text is null or kind = ${options.kind ?? null})
      and (${options.activeOnly === true} = false or active)
    order by id
  `;
  return rows.map(toResource);
}

/** Makes a resource at version 1. A worker needs a person and no other kind has one (the database checks). */
export async function createResource(sql: Db, input: NewResource): Promise<Resource> {
  const [row] = await sql<ResourceRow[]>`
    insert into resources (id, business_id, kind, name, person_id, active)
    values (${input.id}, ${input.businessId}, ${input.kind}, ${input.name}, ${input.personId ?? null},
            ${input.active ?? true})
    returning *
  `;
  if (row === undefined) {
    throw new Error("insert into resources returned no row");
  }
  return toResource(row);
}

/** Sets whether a resource can be booked now, if it is still at `expectedVersion`. */
export async function setResourceActive(
  sql: Db,
  id: string,
  expectedVersion: number,
  active: boolean,
): Promise<UpdateResult<Resource>> {
  assertVersion(expectedVersion);
  const [row] = await sql<ResourceRow[]>`
    update resources set active = ${active}, version = ${expectedVersion + 1}
    where id = ${id} and version = ${expectedVersion}
    returning *
  `;
  if (row !== undefined) {
    return { ok: true, row: toResource(row) };
  }
  return { ok: false, current: await getResource(sql, id) };
}

// ---- the booking head ---------------------------------------------------------------------------------------------

export async function getBookingHead(sql: Db, id: string): Promise<BookingHead | null> {
  const [row] = await sql<BookingRow[]>`select * from bookings where id = ${id}`;
  return row === undefined ? null : toBookingHead(row);
}

/** Makes a booking head at version 1, stage entry unless given. The booker is required; served and payer may follow. */
export async function createBookingHead(sql: Db, input: NewBookingHead): Promise<BookingHead> {
  const [row] = await sql<BookingRow[]>`
    insert into bookings (id, business_id, flow, stage, booker_person_id, served_person_id, payer_person_id, private, deceased)
    values (${input.id}, ${input.businessId}, ${input.flow}, ${input.stage ?? "entry"}, ${input.bookerPersonId},
            ${input.servedPersonId ?? null}, ${input.payerPersonId ?? null}, ${input.private ?? false},
            ${input.deceased ?? false})
    returning *
  `;
  if (row === undefined) {
    throw new Error("insert into bookings returned no row");
  }
  return toBookingHead(row);
}

/**
 * The bookings a person is in: as booker or as the person served (the guard lists a handle's bookings, arch 02 line 115),
 * oldest id first. With `stage`, only that stage.
 */
export async function listBookingHeadsOfPerson(
  sql: Db,
  personId: string,
  options: { stage?: BookingStage } = {},
): Promise<BookingHead[]> {
  const rows = await sql<BookingRow[]>`
    select * from bookings
    where (booker_person_id = ${personId} or served_person_id = ${personId})
      and (${options.stage ?? null}::text is null or stage = ${options.stage ?? null})
    order by id
  `;
  return rows.map(toBookingHead);
}

/** A business's bookings in one stage, by id. */
export async function listBookingHeadsOfBusiness(
  sql: Db,
  businessId: string,
  stage: BookingStage,
): Promise<BookingHead[]> {
  const rows = await sql<BookingRow[]>`
    select * from bookings where business_id = ${businessId} and stage = ${stage} order by id
  `;
  return rows.map(toBookingHead);
}

/**
 * Changes the fields of `patch` (those left out stay) if the booking is still at `expectedVersion`, and raises the
 * version by one. A null in `servedPersonId` or `payerPersonId` clears it. The flow and the booker are written once at
 * booking and cannot be changed here. A stale write returns the row as it is now.
 */
export async function updateBookingHead(
  sql: Db,
  id: string,
  expectedVersion: number,
  patch: BookingHeadPatch,
): Promise<UpdateResult<BookingHead>> {
  assertVersion(expectedVersion);
  const has = (key: keyof BookingHeadPatch): boolean => patch[key] !== undefined;
  const [row] = await sql<BookingRow[]>`
    update bookings set
      stage = case when ${has("stage")} then ${patch.stage ?? null} else stage end,
      served_person_id = case when ${has("servedPersonId")} then ${patch.servedPersonId ?? null} else served_person_id end,
      payer_person_id = case when ${has("payerPersonId")} then ${patch.payerPersonId ?? null} else payer_person_id end,
      private = case when ${has("private")} then ${patch.private ?? null}::boolean else private end,
      deceased = case when ${has("deceased")} then ${patch.deceased ?? null}::boolean else deceased end,
      version = ${expectedVersion + 1}
    where id = ${id} and version = ${expectedVersion}
    returning *
  `;
  if (row !== undefined) {
    return { ok: true, row: toBookingHead(row) };
  }
  return { ok: false, current: await getBookingHead(sql, id) };
}
