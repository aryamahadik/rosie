// Doubles for the identity-and-access tests (T-308). Never imported by the Worker. No database: an in-memory record built
// from the frozen contracts' seed fixtures (K-04 v1 core, and K-22 v1's team at Lee Home Services with the K-23 v1
// business it loads), read the way the data-access calls read it but with no row-level security, plus rows a test adds
// for the master's own examples (A4-24, A4-25, A4-26, A4-55, A7-81). Values come only from the contracts' fixtures and
// the master's sample cast, never a real person (rule 9).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BookingHead } from "../../../../db/repo/bookings-head";
import type { PersonRole, PersonRoleName } from "../../../../db/repo/people";
import type { AdminPower, AdminPowers, IdentityReader, ServedFacts, ServedFactsReader } from "./facts";

/** The frozen db-schema parts' folder. */
const DB_SCHEMA_DIR = fileURLToPath(new URL("../../../../contracts/db-schema/", import.meta.url));

type Values = Readonly<Record<string, unknown>>;

interface SeedRow {
  readonly table: string;
  readonly values: Values;
}

interface SeedFile {
  readonly after?: readonly string[];
  readonly rows?: readonly SeedRow[];
}

/** The seeds the tests read: K-04's demo shops, people, roles and booking heads; K-22's team at Lee Home Services. */
export const SEEDS = [
  "core/fixtures/seed-business-head.json",
  "core/fixtures/seed-person-roles.json",
  "core/fixtures/seed-booking-head.json",
  "people-access/fixtures/seed-staff-invited.json",
  "people-access/fixtures/seed-staff-joined.json",
] as const;

/**
 * The rows of seed fixtures (paths under contracts/db-schema/), each file's `after` chain first and each file once, as
 * K-04 v1's README loads them ("Seed and refused-row fixtures").
 */
export function seedRows(files: readonly string[]): SeedRow[] {
  const rows: SeedRow[] = [];
  const loaded = new Set<string>();
  const load = (file: string): void => {
    if (loaded.has(file)) return;
    loaded.add(file);
    const seed = JSON.parse(readFileSync(file, "utf8")) as SeedFile;
    for (const after of seed.after ?? []) load(path.resolve(path.dirname(file), after));
    rows.push(...(seed.rows ?? []));
  };
  for (const file of files) load(path.join(DB_SCHEMA_DIR, ...file.split("/")));
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------
// The record

export interface PersonHandle {
  readonly personId: string;
  readonly handleId: string;
}

/** K-22 v1 `staff`: a team member's row at one business, which a team power is given to. */
export interface StaffRow {
  readonly id: string;
  readonly businessId: string;
  readonly personId: string;
}

/** K-22 v1 `team_powers`. */
export interface PowerRow {
  readonly id: string;
  readonly staffId: string;
  readonly businessId: string;
  readonly power: string;
  readonly endedAt: string | null;
}

export interface TestRecord {
  readonly personHandles: readonly PersonHandle[];
  readonly roles: readonly PersonRole[];
  readonly bookings: readonly BookingHead[];
  readonly staff: readonly StaffRow[];
  readonly powers: readonly PowerRow[];
  /** Every name, number and address in the rows: what no answer may carry (K-08 v1; CQ-59). */
  readonly privateValues: readonly string[];
}

/** Columns that hold a person's name, number, email or words (or a business's name), in any table. */
const PRIVATE_COLUMNS: readonly string[] = [
  "name",
  "display_name",
  "address",
  "number",
  "mobile",
  "email",
  "phone_number",
  "joined_from_number",
  "exact_words",
  "ready_text",
];

const ROLE_NAMES: readonly PersonRoleName[] = ["owner", "admin", "staff", "own_business", "customer"];
const FLOWS: readonly BookingHead["flow"][] = ["A", "B"];
const STAGES: readonly BookingHead["stage"][] = ["entry", "booked", "checked_in", "done", "cancelled"];

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

function oneOf<T extends string>(values: Values, column: string, allowed: readonly T[], fallback?: T): T {
  const value = values[column] ?? fallback;
  const found = allowed.find((item) => item === value);
  if (found === undefined) throw new Error(`seed column ${column} is not one of its values`);
  return found;
}

function flag(values: Values, column: string): boolean {
  const value = values[column] ?? false;
  if (typeof value !== "boolean") throw new Error(`seed column ${column} is not a boolean`);
  return value;
}

function version(values: Values): number {
  const value = values.version ?? 1;
  if (typeof value !== "number") throw new Error("seed column version is not a number");
  return value;
}

/** The record the doubles read, from seed rows (a column left out takes its K-04 default). */
export function recordOf(rows: readonly SeedRow[]): TestRecord {
  const personHandles: PersonHandle[] = [];
  const roles: PersonRole[] = [];
  const bookings: BookingHead[] = [];
  const staff: StaffRow[] = [];
  const powers: PowerRow[] = [];
  const privateValues: string[] = [];
  for (const { table, values } of rows) {
    for (const column of PRIVATE_COLUMNS) {
      const value = values[column];
      if (typeof value === "string") privateValues.push(value);
    }
    switch (table) {
      case "person_handles":
        personHandles.push({ personId: text(values, "person_id"), handleId: text(values, "handle_id") });
        break;
      case "person_roles": {
        const endedAt = textOrNull(values, "ended_at");
        roles.push({
          id: text(values, "id"),
          personId: text(values, "person_id"),
          businessId: text(values, "business_id"),
          role: oneOf(values, "role", ROLE_NAMES),
          endedAt: endedAt === null ? null : new Date(endedAt),
          version: version(values),
        });
        break;
      }
      case "bookings":
        bookings.push({
          id: text(values, "id"),
          businessId: text(values, "business_id"),
          flow: oneOf(values, "flow", FLOWS),
          stage: oneOf(values, "stage", STAGES, "entry"),
          bookerPersonId: text(values, "booker_person_id"),
          servedPersonId: textOrNull(values, "served_person_id"),
          payerPersonId: textOrNull(values, "payer_person_id"),
          private: flag(values, "private"),
          deceased: flag(values, "deceased"),
          version: version(values),
        });
        break;
      case "staff":
        staff.push({
          id: text(values, "id"),
          businessId: text(values, "business_id"),
          personId: text(values, "person_id"),
        });
        break;
      case "team_powers":
        powers.push({
          id: text(values, "id"),
          staffId: text(values, "staff_id"),
          businessId: text(values, "business_id"),
          power: text(values, "power"),
          endedAt: textOrNull(values, "ended_at"),
        });
        break;
      default:
        break;
    }
  }
  return { personHandles, roles, bookings, staff, powers, privateValues };
}

/** The record of SEEDS. */
export function seedRecord(): TestRecord {
  return recordOf(seedRows(SEEDS));
}

/** The record with more rows, for a test's own example. */
export function withRows(
  record: TestRecord,
  more: {
    personHandles?: readonly PersonHandle[];
    roles?: readonly PersonRole[];
    bookings?: readonly BookingHead[];
    staff?: readonly StaffRow[];
    powers?: readonly PowerRow[];
  },
): TestRecord {
  return {
    personHandles: [...record.personHandles, ...(more.personHandles ?? [])],
    roles: [...record.roles, ...(more.roles ?? [])],
    bookings: [...record.bookings, ...(more.bookings ?? [])],
    staff: [...record.staff, ...(more.staff ?? [])],
    powers: [...record.powers, ...(more.powers ?? [])],
    privateValues: record.privateValues,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The doubles

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The data-access reads over the record as db/repo answers them on a database with no row-level security yet (T-191):
 * a person's live roles at every business, and any booking by its id.
 */
export function readerOf(record: TestRecord): IdentityReader {
  return {
    personIdsOfHandle: (handleId) =>
      Promise.resolve(
        record.personHandles
          .filter((link) => link.handleId === handleId)
          .map((link) => link.personId)
          .sort(byId),
      ),
    liveRolesOfPerson: (personId) =>
      Promise.resolve(record.roles.filter((row) => row.personId === personId && row.endedAt === null)),
    liveRolesOfBusiness: (businessId, role) =>
      Promise.resolve(
        record.roles.filter(
          (row) => row.businessId === businessId && row.role === role && row.endedAt === null,
        ),
      ),
    bookingHead: (bookingId) =>
      Promise.resolve(record.bookings.find((head) => head.id === bookingId) ?? null),
  };
}

/** A reader that answers every role row of every business, ended ones too, whatever it is asked. */
export function leakyReaderOf(record: TestRecord): IdentityReader {
  return {
    ...readerOf(record),
    liveRolesOfPerson: () => Promise.resolve(record.roles),
    liveRolesOfBusiness: () => Promise.resolve(record.roles),
  };
}

export interface PowerAsked {
  readonly businessId: string;
  readonly personId: string;
  readonly power: AdminPower;
}

/**
 * K-22 v1's team powers as T-321 will read them: a live power row of that business, given to that person's staff row
 * there. Each question is written down in `asked`.
 */
export function adminPowersOf(record: TestRecord, asked: PowerAsked[] = []): AdminPowers {
  return {
    holds(businessId, personId, power) {
      asked.push({ businessId, personId, power });
      const staffIds = record.staff
        .filter((row) => row.businessId === businessId && row.personId === personId)
        .map((row) => row.id);
      return Promise.resolve(
        record.powers.some(
          (row) =>
            staffIds.includes(row.staffId) &&
            row.businessId === businessId &&
            row.power === power &&
            row.endedAt === null,
        ),
      );
    },
  };
}

export interface ServedAsked {
  readonly businessId: string;
  readonly bookingId: string;
  readonly servedPersonId: string;
}

/** What is on file about the person served, by booking; nothing for any other booking. */
export function servedFactsOf(
  byBooking: Readonly<Record<string, ServedFacts>>,
  asked: ServedAsked[] = [],
): ServedFactsReader {
  return {
    servedFacts(businessId, bookingId, servedPersonId) {
      asked.push({ businessId, bookingId, servedPersonId });
      return Promise.resolve(byBooking[bookingId] ?? { ageBand: null, parentOrGuardianIds: [] });
    },
  };
}

/** Every string anywhere in a value, keys excluded. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => stringsIn(item));
  if (typeof value === "object" && value !== null)
    return Object.values(value).flatMap((item) => stringsIn(item));
  return [];
}

// ---------------------------------------------------------------------------------------------------------------
// The businesses and the master's own examples

/** K-04 seed-business-head's demo shops. */
export const BARBERSHOP = "biz-lees-barbershop";
export const YOGA_STUDIO = "biz-yoga-studio";
export const MOVERS = "biz-movers";
/** K-23 seed-company-two-kinds: Sam's Lee Home Services, where Pat is the office manager (K-22 seed-staff-invited). */
export const HOME_SERVICES = "biz-lee-home-services";

/** A booking head at Lee's Barbershop that Alex made (flow A, booked), with the person served and the payer named. */
function alexBooks(id: string, served: string | null, payer: string | null): BookingHead {
  return {
    id,
    businessId: BARBERSHOP,
    flow: "A",
    stage: served === null ? "entry" : "booked",
    bookerPersonId: "person-alex",
    servedPersonId: served,
    payerPersonId: payer,
    private: false,
    deceased: false,
    version: 1,
  };
}

/** A4-26: "It's a gift for my brother. Can I pay for it?" The brother is the person served; Alex books and pays. */
export const GIFT_FOR_BROTHER = alexBooks(
  "booking-alex-gift-for-brother",
  "person-alex-brother",
  "person-alex",
);

/** A4-25: "the kids cut is for your son, and that you're his parent." Alex books and pays; his son is served. */
export const KIDS_CUT_FOR_SON = alexBooks("booking-alex-kids-cut-for-son", "person-alex-son", "person-alex");

/** A4-24: "More than one branch can apply, like a child paid for by someone else." */
export const KIDS_CUT_PAID_BY_SOMEONE_ELSE = alexBooks(
  "booking-alex-kids-cut-paid-by-other",
  "person-alex-son",
  "person-other-payer",
);

/** A4-55: "My employer pays for this cut." Alex books and is served; his employer pays. */
export const CUT_PAID_BY_EMPLOYER = alexBooks(
  "booking-alex-cut-paid-by-employer",
  "person-alex",
  "person-alex-employer",
);

/** Before A4-80's answer reaches A4-24: who it is for, and who pays, are not on the record yet. */
export const WHO_FOR_NOT_ANSWERED = alexBooks("booking-alex-who-for-not-answered", null, null);

/** A7-81: a death reported on a haircut Alex booked for himself. */
export const DEATH_REPORTED: BookingHead = {
  ...alexBooks("booking-alex-death-reported", "person-alex", "person-alex"),
  deceased: true,
};

/** The son's facts on file: a minor whose family record names Alex as his parent (A4-25). */
export const SON_WITH_ALEX_ON_FILE: ServedFacts = {
  ageBand: "under_18",
  parentOrGuardianIds: ["person-alex"],
};

/** A person's role row built for a test (live unless `endedAt` is given). */
export function roleRow(
  id: string,
  personId: string,
  businessId: string,
  role: PersonRoleName,
  endedAt: Date | null = null,
): PersonRole {
  return { id, personId, businessId, role, endedAt, version: endedAt === null ? 1 : 2 };
}

/** A live K-22 team power built for a test, given to an existing staff row. */
export function powerRow(staffId: string, businessId: string, power: string): PowerRow {
  return { id: `power-${staffId}-${power}`, staffId, businessId, power, endedAt: null };
}
