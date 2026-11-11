// Test values for the listing call (T-574): staging's roster and seeded rows as K-21 v1 test-roster.json assumes them,
// taken from the frozen contracts' own seed fixtures (K-04 v1 seed-business-head.json, seed-person-roles.json and
// seed-phone-chat-open.json; K-23 v1 seed-company-two-kinds.json; K-28 v1 seed-customer-mobile-email.json), and the ports
// as fakes that read those rows the way the data-access calls would. Test values only: fixture set v1's demo shops, the
// master's sample cast and the fictional 555-01xx numbers (rule 9). Not imported by any shipped module.

import { readFileSync } from "node:fs";
import path from "node:path";

import { CONTRACTS, ROSTER_FIXTURE } from "../test-phone/test-support";
import type {
  RosterBusinessEntry,
  RosterFlow,
  RosterPhoneEntry,
  RosterRole,
  SeededBusiness,
  SeededCustomer,
  SeededOverride,
  SeededPhone,
  SeededState,
  StagingRoster,
  TestStateCaller,
  TestStateRoster,
} from "./types";

// ---- test-roster.json, as K-21 v1 holds it ----------------------------------------------------------------------------

export interface FixtureBusiness {
  readonly businessId: string;
  readonly name: string;
  readonly flow: RosterFlow;
  readonly kindIds: readonly string[];
  readonly signedUp: boolean;
  readonly live: boolean;
  readonly zone: string;
  readonly textHours: { readonly start: string; readonly end: string };
}

export interface FixturePhone {
  readonly testPhoneId: string;
  readonly last4: string;
  readonly role: RosterRole;
  readonly label: string;
  readonly businessId: string | null;
  readonly personId: string | null;
  readonly seededCustomer: { readonly customerId: string; readonly name: string } | null;
  readonly linqContact: boolean;
  readonly stopped: boolean;
  readonly textHoursOverride: { readonly on: boolean; readonly version: number | null };
}

export interface RosterOutcome {
  readonly result: "testRoster";
  readonly businesses: readonly FixtureBusiness[];
  readonly phones: readonly FixturePhone[];
}

export const ROSTER_OUTCOME = ROSTER_FIXTURE.outcome as unknown as RosterOutcome;

/** A roster phone's number in the fixtures: the fictional +1 555 555 and its last four digits (T-202's fake handles). */
export const numberOf = (last4: string): string => `+1555555${last4}`;

/**
 * Staging's roster for test-roster.json: its two test businesses with their flows, and its five test phones, each at its
 * fictional number, with its role, its label and the business it is seated at. Config values, as the fixture lists them.
 */
export function fixtureRoster(): StagingRoster {
  return {
    businesses: ROSTER_OUTCOME.businesses.map((business): RosterBusinessEntry => ({
      businessId: business.businessId,
      flow: business.flow,
    })),
    phones: ROSTER_OUTCOME.phones.map((phone): RosterPhoneEntry => ({
      testPhoneId: phone.testPhoneId,
      number: numberOf(phone.last4),
      role: phone.role,
      label: phone.label,
      businessId: phone.businessId,
    })),
  };
}

// ---- the seeded rows, from the contracts' own seed fixtures -----------------------------------------------------------

interface SeedRow {
  readonly table: string;
  readonly values: Readonly<Record<string, unknown>>;
}

/** One table's rows of a frozen db-schema seed fixture. */
function seedRows(domain: string, file: string, table: string): Readonly<Record<string, unknown>>[] {
  const fixture = JSON.parse(
    readFileSync(path.join(CONTRACTS, "db-schema", domain, "fixtures", file), "utf8"),
  ) as { rows: SeedRow[] };
  return fixture.rows.filter((row) => row.table === table).map((row) => row.values);
}

/** A seeded customer row with the number and business it is found by. */
export interface CustomerRow extends SeededCustomer {
  readonly number: string;
  readonly businessId: string;
}

/** Staging's seeded rows as the fakes hold them: what each read of SeededState answers from. */
export interface StagingRows {
  businesses: SeededBusiness[];
  /** Kinds of work by business id, in the picker's order. */
  kindIds: Map<string, string[]>;
  /** The businesses that are signed up. */
  signedUp: Set<string>;
  /** K-04 phone rows by number. */
  phones: Map<string, SeededPhone>;
  /** Text-hours override rows by number. */
  overrides: Map<string, SeededOverride>;
  /** The persons who write from each number. */
  persons: Map<string, string[]>;
  customers: CustomerRow[];
}

/** A `time` column as PostgreSQL prints it (db/repo/people.ts: "08:00:00"), from a seed's "08:00". */
const printedTime = (seeded: unknown): string => `${String(seeded)}:00`;

/** A K-04 `businesses` seed row as db/repo/people.ts getBusiness answers it. */
function businessOf(row: Readonly<Record<string, unknown>>, status?: string): SeededBusiness {
  return {
    id: String(row.id),
    name: String(row.name),
    status: status ?? String(row.status),
    timeZone: String(row.time_zone),
    textHoursStart: printedTime(row.text_hours_start),
    textHoursEnd: printedTime(row.text_hours_end),
  };
}

/**
 * The seeded state test-roster.json assumes. From the contracts' seeds: the barbershop's head (K-04), Lee Home Services'
 * head and both shops' kinds of work (K-23), each number's handle, its person and its phone row (K-04), and Alex's
 * customer row at the barbershop (K-28). From the fixture's own note, where no seed fixture holds it: both shops signed
 * up and live (K-23's seed has Lee Home Services still saved), and the staff phone's override row on at version 3 with
 * no row for the other phones.
 */
export function fixtureRows(): StagingRows {
  const numbers = new Set(ROSTER_OUTCOME.phones.map((phone) => numberOf(phone.last4)));
  const head = seedRows("core", "seed-business-head.json", "businesses");
  const setup = seedRows("business-setup", "seed-company-two-kinds.json", "businesses");
  const listed = new Set(ROSTER_OUTCOME.businesses.map((business) => business.businessId));
  const businesses = [...head, ...setup]
    .filter((row) => listed.has(String(row.id)))
    // Signed up and live, as test-roster.json's note has both shops.
    .map((row) => businessOf(row, "live"));

  const kindIds = new Map<string, string[]>();
  for (const row of seedRows("business-setup", "seed-company-two-kinds.json", "company_kinds")) {
    const businessId = String(row.business_id);
    kindIds.set(businessId, [...(kindIds.get(businessId) ?? []), String(row.kind_id)]);
  }

  const handles = seedRows("core", "seed-person-roles.json", "handles").filter((row) =>
    numbers.has(String(row.address)),
  );
  const numberOfHandle = new Map(handles.map((row) => [String(row.id), String(row.address)]));
  const persons = new Map<string, string[]>();
  for (const row of seedRows("core", "seed-person-roles.json", "person_handles")) {
    const number = numberOfHandle.get(String(row.handle_id));
    if (number !== undefined) persons.set(number, [...(persons.get(number) ?? []), String(row.person_id)]);
  }

  const phones = new Map<string, SeededPhone>();
  for (const row of seedRows("core", "seed-phone-chat-open.json", "phones")) {
    const number = String(row.number);
    if (!numbers.has(number)) continue;
    const added = row.linq_contact_added_at;
    phones.set(number, {
      stopped: row.stopped === true,
      linqContactAddedAt: typeof added === "string" ? new Date(added) : null,
    });
  }

  const customers: CustomerRow[] = [];
  for (const row of seedRows("customers", "seed-customer-mobile-email.json", "customers")) {
    const number = numberOfHandle.get(String(row.mobile_handle_id));
    if (number !== undefined && listed.has(String(row.business_id)))
      customers.push({
        number,
        businessId: String(row.business_id),
        id: String(row.id),
        name: String(row.name),
      });
  }

  const staff = ROSTER_OUTCOME.phones.find((phone) => phone.role === "staff");
  if (staff === undefined) throw new Error("test-roster.json lists a staff phone");
  return {
    businesses,
    kindIds,
    signedUp: new Set(listed),
    phones,
    overrides: new Map([[numberOf(staff.last4), { enabled: true, version: 3 }]]),
    persons,
    customers,
  };
}

// ---- the ports, as fakes ----------------------------------------------------------------------------------------------

/** One read a fake took: which read, what it was asked for, and its caller. */
export interface AskedRead {
  readonly read: string;
  readonly key: string;
  readonly caller: TestStateCaller;
}

/** Staging's roster over a fixed config. */
export function fakeRoster(roster: StagingRoster): TestStateRoster & { readonly asked: TestStateCaller[] } {
  const asked: TestStateCaller[] = [];
  return {
    asked,
    listing(caller) {
      asked.push(caller);
      return Promise.resolve(structuredClone(roster));
    },
  };
}

/** The seeded rows' reads over fixed rows, each answering as the data-access call it stands for would. */
export function fakeSeeded(rows: StagingRows): SeededState & { readonly asked: AskedRead[] } {
  const asked: AskedRead[] = [];
  const note = (read: string, key: string, caller: TestStateCaller): void => {
    asked.push({ read, key, caller });
  };
  return {
    asked,
    business(businessId, caller) {
      note("business", businessId, caller);
      return Promise.resolve(rows.businesses.find((row) => row.id === businessId) ?? null);
    },
    kindIds(businessId, caller) {
      note("kindIds", businessId, caller);
      return Promise.resolve(rows.kindIds.get(businessId) ?? []);
    },
    signedUp(businessId, caller) {
      note("signedUp", businessId, caller);
      return Promise.resolve(rows.signedUp.has(businessId));
    },
    phone(number, caller) {
      note("phone", number, caller);
      return Promise.resolve(rows.phones.get(number) ?? null);
    },
    textHoursOverride(number, caller) {
      note("textHoursOverride", number, caller);
      return Promise.resolve(rows.overrides.get(number) ?? null);
    },
    person(number, caller) {
      note("person", number, caller);
      const writers = rows.persons.get(number) ?? [];
      // One person writes from a seeded test phone; none or several is no answer.
      return Promise.resolve(writers.length === 1 ? (writers[0] ?? null) : null);
    },
    customer(number, businessId, caller) {
      note("customer", `${number} ${businessId}`, caller);
      const row = rows.customers.find((each) => each.number === number && each.businessId === businessId);
      return Promise.resolve(row === undefined ? null : { id: row.id, name: row.name });
    },
  };
}
