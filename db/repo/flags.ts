// Release flags (K-04 v1 core `release_flags`; D-000 factory spec ADR-010 draft; BP 5.4; T-185).
//
// Code ships with flags off, then flags turn on. A flag is set globally, for one business, or for one phone (a test
// phone on an allow-list: BP 9.4). Reading a flag for a request picks the most specific row that exists: the phone's, else
// the business's, else the global one; with no row at all the flag is off. So a flag that is off globally and on for one
// phone is on for that phone only.
//
// Turning a flag on in production is the release job's (C-013, C-015), not this file's. Updates are compare-and-set on
// the row's version like people.ts (the database refuses any update that does not raise the version by one). Every value
// reaches the database as a bound parameter.
import type { Sql, Tx } from "./scope";
import type { UpdateResult } from "./threads";

type Db = Sql | Tx;

export interface ReleaseFlag {
  name: string;
  /** `global`, `business:<business id>` or `phone:<E.164 number>`. */
  scope: string;
  enabled: boolean;
  /** A setting the flag carries, or null. */
  value: unknown;
  version: number;
}

export interface NewReleaseFlag {
  name: string;
  /** Default `global`. */
  scope?: string;
  /** Default false: flags start off. */
  enabled?: boolean;
  value?: unknown;
}

export interface FlagSubject {
  businessId?: string | null;
  /** The phone's E.164 number. */
  phone?: string | null;
}

export interface FlagReading {
  enabled: boolean;
  /** The row that decided, or null when no row applies (off). */
  decidedBy: ReleaseFlag | null;
}

interface FlagRow {
  name: string;
  scope: string;
  enabled: boolean;
  value: unknown;
  version: number;
}

export const GLOBAL_SCOPE = "global";

export const businessScope = (businessId: string): string => `business:${businessId}`;
export const phoneScope = (number: string): string => `phone:${number}`;

function toFlag(row: FlagRow): ReleaseFlag {
  return { name: row.name, scope: row.scope, enabled: row.enabled, value: row.value, version: row.version };
}

function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError("a row version is a positive integer");
  }
}

/** The row for exactly this name and scope (default global), or null. */
export async function getFlag(
  sql: Db,
  name: string,
  scope: string = GLOBAL_SCOPE,
): Promise<ReleaseFlag | null> {
  const [row] = await sql<FlagRow[]>`select * from release_flags where name = ${name} and scope = ${scope}`;
  return row === undefined ? null : toFlag(row);
}

/** Every row of one flag, or of every flag, in name and scope order. */
export async function listFlags(sql: Db, name?: string): Promise<ReleaseFlag[]> {
  const rows = await sql<FlagRow[]>`
    select * from release_flags
    where (${name ?? null}::text is null or name = ${name ?? null})
    order by name, scope
  `;
  return rows.map(toFlag);
}

/**
 * Makes a flag row at version 1, off unless `enabled` says otherwise. A second row for the same name and scope, a name
 * or a scope in the wrong form, is refused by the database.
 */
export async function createFlag(sql: Db, input: NewReleaseFlag): Promise<ReleaseFlag> {
  const value = input.value === undefined || input.value === null ? null : sql.json(input.value as never);
  const [row] = await sql<FlagRow[]>`
    insert into release_flags (name, scope, enabled, value)
    values (${input.name}, ${input.scope ?? GLOBAL_SCOPE}, ${input.enabled ?? false}, ${value})
    returning *
  `;
  if (row === undefined) {
    throw new Error("insert into release_flags returned no row");
  }
  return toFlag(row);
}

/**
 * Turns a flag row on or off, and optionally replaces its value (`null` clears it), if it is still at
 * `expectedVersion`. A refused write returns the row as it is now (null when it does not exist).
 */
export async function updateFlag(
  sql: Db,
  name: string,
  scope: string,
  expectedVersion: number,
  change: { enabled?: boolean; value?: unknown },
): Promise<UpdateResult<ReleaseFlag>> {
  assertVersion(expectedVersion);
  const setValue = change.value !== undefined;
  const value = change.value === undefined || change.value === null ? null : sql.json(change.value as never);
  const [row] = await sql<FlagRow[]>`
    update release_flags set
      enabled = coalesce(${change.enabled ?? null}::boolean, enabled),
      value = case when ${setValue} then ${value}::jsonb else value end,
      version = ${expectedVersion + 1}
    where name = ${name} and scope = ${scope} and version = ${expectedVersion}
    returning *
  `;
  if (row !== undefined) {
    return { ok: true, row: toFlag(row) };
  }
  return { ok: false, current: await getFlag(sql, name, scope) };
}

/**
 * The flag for one request: the phone's row, else the business's, else the global one, else off. The most specific row
 * that exists decides, whether it is on or off (a phone row that is off turns a globally on flag off for that phone).
 */
export async function readFlag(sql: Db, name: string, subject: FlagSubject = {}): Promise<FlagReading> {
  const phone = subject.phone ?? null;
  const business = subject.businessId ?? null;
  const [row] = await sql<FlagRow[]>`
    select * from release_flags
    where name = ${name}
      and (
        scope = ${GLOBAL_SCOPE}
        or (${phone}::text is not null and scope = 'phone:' || ${phone}::text)
        or (${business}::text is not null and scope = 'business:' || ${business}::text)
      )
    order by case when scope like 'phone:%' then 0 when scope like 'business:%' then 1 else 2 end
    limit 1
  `;
  return row === undefined
    ? { enabled: false, decidedBy: null }
    : { enabled: row.enabled, decidedBy: toFlag(row) };
}

/** Whether the flag is on for this request (see readFlag). */
export async function isFlagOn(sql: Db, name: string, subject: FlagSubject = {}): Promise<boolean> {
  return (await readFlag(sql, name, subject)).enabled;
}
