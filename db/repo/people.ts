// Data-access calls for the business head, persons and per-business roles (K-04 v1 core; T-181).
//
// Every update here is a compare-and-set on the row's version: it passes the version the caller read, and the row is
// written only if it still has that version, with the version raised by one (arch 01 line 85; arch 10 line 506). A
// write made from an old read changes nothing and returns the row as it is now, so the caller can read and decide
// again. The database refuses any update that does not raise the version by one (a trigger), so no other path can
// skip the rule either.
//
// Ids are opaque strings the caller makes (CQ-09); nothing here parses one. Time columns come back as the strings
// PostgreSQL prints (`time` as "08:00:00", `timestamptz` as a Date).
import type { Sql, Tx } from "./scope";

type Db = Sql | Tx;

export type BusinessStatus = "offline" | "saved" | "live";
export type PersonRoleName = "owner" | "admin" | "staff" | "own_business" | "customer";

export interface Business {
  id: string;
  name: string;
  displayName: string;
  status: BusinessStatus;
  /** An IANA zone name such as America/New_York. */
  timeZone: string;
  /** Start of the owner's text hours, "HH:MM:SS" in the business's zone. */
  textHoursStart: string;
  textHoursEnd: string;
  version: number;
}

export interface Person {
  id: string;
  name: string | null;
  /** A BCP 47 tag such as en or es; null: the business's language. */
  language: string | null;
  version: number;
}

export interface PersonRole {
  id: string;
  personId: string;
  businessId: string;
  role: PersonRoleName;
  endedAt: Date | null;
  version: number;
}

/** A compare-and-set: written, or refused with the row as it is now (null when the row does not exist). */
export type UpdateResult<Row> = { ok: true; row: Row } | { ok: false; current: Row | null };

export interface NewBusiness {
  id: string;
  name: string;
  displayName: string;
  timeZone: string;
  /** Default offline. */
  status?: BusinessStatus;
  /** Default "08:00". */
  textHoursStart?: string;
  /** Default "20:00". */
  textHoursEnd?: string;
}

export interface BusinessPatch {
  name?: string;
  displayName?: string;
  status?: BusinessStatus;
  timeZone?: string;
  textHoursStart?: string;
  textHoursEnd?: string;
}

export interface NewPerson {
  id: string;
  name?: string | null;
  language?: string | null;
}

export interface PersonPatch {
  name?: string | null;
  language?: string | null;
}

export interface NewPersonRole {
  id: string;
  personId: string;
  businessId: string;
  role: PersonRoleName;
}

interface BusinessRow {
  id: string;
  name: string;
  display_name: string;
  status: BusinessStatus;
  time_zone: string;
  text_hours_start: string;
  text_hours_end: string;
  version: number;
}

interface PersonRow {
  id: string;
  name: string | null;
  language: string | null;
  version: number;
}

interface PersonRoleRow {
  id: string;
  person_id: string;
  business_id: string;
  role: PersonRoleName;
  ended_at: Date | null;
  version: number;
}

const toBusiness = (row: BusinessRow): Business => ({
  id: row.id,
  name: row.name,
  displayName: row.display_name,
  status: row.status,
  timeZone: row.time_zone,
  textHoursStart: row.text_hours_start,
  textHoursEnd: row.text_hours_end,
  version: row.version,
});

const toPerson = (row: PersonRow): Person => ({
  id: row.id,
  name: row.name,
  language: row.language,
  version: row.version,
});

const toRole = (row: PersonRoleRow): PersonRole => ({
  id: row.id,
  personId: row.person_id,
  businessId: row.business_id,
  role: row.role,
  endedAt: row.ended_at,
  version: row.version,
});

function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError("a row version is a positive integer");
  }
}

// ---- businesses -------------------------------------------------------------------------------------------------

export async function getBusiness(sql: Db, id: string): Promise<Business | null> {
  const [row] = await sql<BusinessRow[]>`select * from businesses where id = ${id}`;
  return row === undefined ? null : toBusiness(row);
}

/** Inserts a business at version 1. A duplicate id, a bad status, zone or hours is refused by the database. */
export async function createBusiness(sql: Db, input: NewBusiness): Promise<Business> {
  const [row] = await sql<BusinessRow[]>`
    insert into businesses (id, name, display_name, time_zone, status, text_hours_start, text_hours_end)
    values (
      ${input.id}, ${input.name}, ${input.displayName}, ${input.timeZone},
      coalesce(${input.status ?? null}, 'offline'),
      coalesce(${input.textHoursStart ?? null}::time, '08:00'),
      coalesce(${input.textHoursEnd ?? null}::time, '20:00')
    )
    returning *
  `;
  if (row === undefined) {
    throw new Error("insert into businesses returned no row");
  }
  return toBusiness(row);
}

/**
 * Changes the named fields of a business if it is still at `expectedVersion`, and raises the version by one. Fields
 * left undefined keep their value; an empty patch still raises the version (a touch).
 */
export async function updateBusiness(
  sql: Db,
  id: string,
  expectedVersion: number,
  patch: BusinessPatch,
): Promise<UpdateResult<Business>> {
  assertVersion(expectedVersion);
  const [row] = await sql<BusinessRow[]>`
    update businesses set
      name = coalesce(${patch.name ?? null}, name),
      display_name = coalesce(${patch.displayName ?? null}, display_name),
      status = coalesce(${patch.status ?? null}, status),
      time_zone = coalesce(${patch.timeZone ?? null}, time_zone),
      text_hours_start = coalesce(${patch.textHoursStart ?? null}::time, text_hours_start),
      text_hours_end = coalesce(${patch.textHoursEnd ?? null}::time, text_hours_end),
      version = ${expectedVersion + 1}
    where id = ${id} and version = ${expectedVersion}
    returning *
  `;
  if (row !== undefined) {
    return { ok: true, row: toBusiness(row) };
  }
  return { ok: false, current: await getBusiness(sql, id) };
}

// ---- persons ----------------------------------------------------------------------------------------------------

export async function getPerson(sql: Db, id: string): Promise<Person | null> {
  const [row] = await sql<PersonRow[]>`select * from persons where id = ${id}`;
  return row === undefined ? null : toPerson(row);
}

/** Inserts a person at version 1. */
export async function createPerson(sql: Db, input: NewPerson): Promise<Person> {
  const [row] = await sql<PersonRow[]>`
    insert into persons (id, name, language)
    values (${input.id}, ${input.name ?? null}, ${input.language ?? null})
    returning *
  `;
  if (row === undefined) {
    throw new Error("insert into persons returned no row");
  }
  return toPerson(row);
}

/**
 * Changes the named fields of a person if still at `expectedVersion`, and raises the version by one. A field left
 * undefined keeps its value; null sets it to null (name unknown, language: the business's).
 */
export async function updatePerson(
  sql: Db,
  id: string,
  expectedVersion: number,
  patch: PersonPatch,
): Promise<UpdateResult<Person>> {
  assertVersion(expectedVersion);
  const setName = patch.name !== undefined;
  const setLanguage = patch.language !== undefined;
  const [row] = await sql<PersonRow[]>`
    update persons set
      name = case when ${setName} then ${patch.name ?? null} else name end,
      language = case when ${setLanguage} then ${patch.language ?? null} else language end,
      version = ${expectedVersion + 1}
    where id = ${id} and version = ${expectedVersion}
    returning *
  `;
  if (row !== undefined) {
    return { ok: true, row: toPerson(row) };
  }
  return { ok: false, current: await getPerson(sql, id) };
}

// ---- person roles -----------------------------------------------------------------------------------------------

export async function getPersonRole(sql: Db, id: string): Promise<PersonRole | null> {
  const [row] = await sql<PersonRoleRow[]>`select * from person_roles where id = ${id}`;
  return row === undefined ? null : toRole(row);
}

/**
 * Gives a person a role at a business, at version 1. The same live role twice is refused by the database
 * (person_roles_one_live_role, SQLSTATE 23505); a role that ended can be given again as a new row.
 */
export async function addPersonRole(sql: Db, input: NewPersonRole): Promise<PersonRole> {
  const [row] = await sql<PersonRoleRow[]>`
    insert into person_roles (id, person_id, business_id, role)
    values (${input.id}, ${input.personId}, ${input.businessId}, ${input.role})
    returning *
  `;
  if (row === undefined) {
    throw new Error("insert into person_roles returned no row");
  }
  return toRole(row);
}

/**
 * Ends a role now if it is still at `expectedVersion` and has not ended. The row stays, with ended_at set, so the
 * event log's who stays readable. Ending an ended role is refused as a version conflict (the row is returned).
 */
export async function endPersonRole(
  sql: Db,
  id: string,
  expectedVersion: number,
): Promise<UpdateResult<PersonRole>> {
  assertVersion(expectedVersion);
  const [row] = await sql<PersonRoleRow[]>`
    update person_roles set ended_at = now(), version = ${expectedVersion + 1}
    where id = ${id} and version = ${expectedVersion} and ended_at is null
    returning *
  `;
  if (row !== undefined) {
    return { ok: true, row: toRole(row) };
  }
  return { ok: false, current: await getPersonRole(sql, id) };
}

/** A person's roles that still hold, across every business (the guard's list, arch 02 line 115), by business and role. */
export async function listLiveRolesOfPerson(sql: Db, personId: string): Promise<PersonRole[]> {
  const rows = await sql<PersonRoleRow[]>`
    select * from person_roles where person_id = ${personId} and ended_at is null order by business_id, role, id
  `;
  return rows.map(toRole);
}

/** A business's roles that still hold, all or of one role (its owners, its staff). */
export async function listLiveRolesOfBusiness(
  sql: Db,
  businessId: string,
  role?: PersonRoleName,
): Promise<PersonRole[]> {
  const rows = await sql<PersonRoleRow[]>`
    select * from person_roles
    where business_id = ${businessId} and ended_at is null and (${role ?? null}::text is null or role = ${role ?? null})
    order by role, person_id, id
  `;
  return rows.map(toRole);
}
