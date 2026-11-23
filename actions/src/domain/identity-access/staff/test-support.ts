// Doubles for the staff tests (T-321). Never imported by the Worker. No database: K-22 v1's team rows read from the
// frozen contracts' seed fixtures (seed-staff-invited: Pat, Lee Home Services' office manager, invited, who may OK prices
// over $500; seed-staff-joined: Jordan and Casey at Lee Home Services and Riley at Lee's Barbershop, joined and bookable),
// with the rows a test changes or adds for the master's own examples (S2-08's STOP, a removal, a power given or taken
// back). Values come only from the contracts' fixtures and the master's sample cast, never a real person (rule 9).

import { seedRows } from "../test-support";
import {
  STAFF_STATUSES,
  TEAM_POWERS,
  type StaffOnFile,
  type StaffReader,
  type StaffStatus,
  type TeamPower,
  type TeamPowerOnFile,
} from "./staff";

/** The seeds of K-22's team (each with its `after` chain: K-04's people and roles, K-23's Lee Home Services). */
export const STAFF_SEEDS = [
  "people-access/fixtures/seed-staff-invited.json",
  "people-access/fixtures/seed-staff-joined.json",
] as const;

type Values = Readonly<Record<string, unknown>>;

function text(values: Values, column: string): string {
  const value = values[column];
  if (typeof value !== "string") throw new Error(`seed column ${column} is not text`);
  return value;
}

function textOrNull(values: Values, column: string): string | null {
  const value = values[column];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`seed column ${column} is not text`);
  return value;
}

function numberOrNull(values: Values, column: string): number | null {
  const value = values[column];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number") throw new Error(`seed column ${column} is not a number`);
  return value;
}

function oneOf<T extends string>(values: Values, column: string, allowed: readonly T[]): T {
  const found = allowed.find((item) => item === values[column]);
  if (found === undefined) throw new Error(`seed column ${column} is not one of its values`);
  return found;
}

/** K-22's team rows as the service reads them, from seed rows (a column left out takes its K-22 default). */
export interface TeamRecord {
  readonly staff: readonly StaffOnFile[];
  readonly powers: readonly TeamPowerOnFile[];
}

export function teamRecordOf(rows: readonly { table: string; values: Values }[]): TeamRecord {
  const staff: StaffOnFile[] = [];
  const powers: TeamPowerOnFile[] = [];
  for (const { table, values } of rows) {
    if (table === "staff") {
      staff.push({
        id: text(values, "id"),
        businessId: text(values, "business_id"),
        personId: text(values, "person_id"),
        status: oneOf(values, "status", STAFF_STATUSES),
        joinedAt: textOrNull(values, "joined_at"),
        stoppedAt: textOrNull(values, "stopped_at"),
        bookableAt: textOrNull(values, "bookable_at"),
        version: numberOrNull(values, "version") ?? 1,
      });
    } else if (table === "team_powers") {
      powers.push({
        id: text(values, "id"),
        staffId: text(values, "staff_id"),
        businessId: text(values, "business_id"),
        power: oneOf(values, "power", TEAM_POWERS),
        overCents: numberOrNull(values, "over_cents"),
        overCurrency: textOrNull(values, "over_currency"),
        endedAt: textOrNull(values, "ended_at"),
      });
    }
  }
  return { staff, powers };
}

/** The team of STAFF_SEEDS. */
export function seedTeam(): TeamRecord {
  return teamRecordOf(seedRows(STAFF_SEEDS));
}

/** The record with one staff row changed, as a commit at the row's version would write it. */
export function withStaff(record: TeamRecord, staffId: string, change: Partial<StaffOnFile>): TeamRecord {
  if (!record.staff.some((row) => row.id === staffId)) throw new Error(`no staff row ${staffId}`);
  return {
    ...record,
    staff: record.staff.map((row) =>
      row.id === staffId ? { ...row, ...change, version: row.version + 1 } : row,
    ),
  };
}

/** S2-08: the member replied STOP at `at`. */
export function stopped(record: TeamRecord, staffId: string, at = "2026-10-26T13:00:00Z"): TeamRecord {
  return withStaff(record, staffId, { status: "stopped", stoppedAt: at });
}

/** The member is taken off the team (core's role ends in the same commit). */
export function removed(record: TeamRecord, staffId: string): TeamRecord {
  return withStaff(record, staffId, { status: "removed" });
}

/** The record with one status set, for a member whose times already allow it. */
export function withStatus(record: TeamRecord, staffId: string, status: StaffStatus): TeamRecord {
  return withStaff(record, staffId, { status });
}

/** A live power given to an existing staff row, by the owner, after the read-back (S2-02, S2-15). */
export function givePower(record: TeamRecord, staffId: string, power: TeamPower): TeamRecord {
  const row = record.staff.find((one) => one.id === staffId);
  if (row === undefined) throw new Error(`no staff row ${staffId}`);
  return {
    ...record,
    powers: [
      ...record.powers,
      {
        id: `power-${staffId}-${power}`,
        staffId,
        businessId: row.businessId,
        power,
        overCents: null,
        overCurrency: null,
        endedAt: null,
      },
    ],
  };
}

/** The owner takes a power back at `at` (team_powers.ended_at). */
export function endPower(record: TeamRecord, powerId: string, at = "2026-10-27T09:00:00Z"): TeamRecord {
  if (!record.powers.some((row) => row.id === powerId)) throw new Error(`no power row ${powerId}`);
  return {
    ...record,
    powers: record.powers.map((row) => (row.id === powerId ? { ...row, endedAt: at } : row)),
  };
}

/** What a reader was asked, in order. */
export interface TeamAsked {
  readonly read: "staff" | "powers";
  readonly businessId: string;
}

/** K-22's team rows of one business, as the data-access reads answer them under the call's business scope. */
export function staffReaderOf(record: TeamRecord, asked: TeamAsked[] = []): StaffReader {
  return {
    staffOfBusiness(businessId) {
      asked.push({ read: "staff", businessId });
      return Promise.resolve(record.staff.filter((row) => row.businessId === businessId));
    },
    powersOfBusiness(businessId) {
      asked.push({ read: "powers", businessId });
      return Promise.resolve(record.powers.filter((row) => row.businessId === businessId));
    },
  };
}

/** A reader with no row-level security that answers every business's rows, whatever it is asked. */
export function leakyStaffReaderOf(record: TeamRecord): StaffReader {
  return {
    staffOfBusiness: () => Promise.resolve(record.staff),
    powersOfBusiness: () => Promise.resolve(record.powers),
  };
}
