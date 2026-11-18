// T-1450: the roster phone as a test owner on staging (C-202, staging's seeded state; C-011, the seed runner; DL-943,
// DL-944; D-018's human test, D-017's repeated from a real iPhone). A roster phone is a number on STAGING_LINQ_ALLOWLIST,
// the list T-416's guard lets staging's real Linq line send to (T-1449, T-572). Its texts reach staging, but the handle
// the gateway makes at its first sight holds one person and no business (db/repo/handle-keys.ts step 4), so
// readTurnParty answers noBusiness and the Tool API base refuses JOIN's turn with noBusinessScope: K-09 README open gap
// 119, a real new owner's first text before any business head. On staging only tp-01's seeded rows put a JOIN under a
// business head (T-1148's skeleton.ts; K-09 README default 130; DL-847). This set gives each roster phone the rows
// T-1148 gives tp-01, under a test business of its own, so its JOIN is a first text that the frontier answers with
// S1-02's question. For the entry at place <n> of the list (from 1), table by table, in the order the foreign keys need:
//   businesses      biz-roster-owner-<n>: T-1148's business head for tp-01 (K-04 v1 seed-business-head.json's
//                   biz-lees-barbershop, fixture set v1's barbershop), value for value, version included, but its id
//   persons         the handle's one person, as it is, when the number's handle holds one (made at first sight, as the
//                   roster phone's is on staging); else person-roster-owner-<n>, with no name and no language, as first
//                   sight writes a person ("null until known"; K-02 v1.1 default 11)
//   handles         the handle that holds the number, as it is; else handle-roster-owner-<n>, kind phone, at the number
//   person_handles  the person writes from that handle: kept as it is, or written with a new person
//   companies       company-roster-owner-<n>: T-1148's company-lees-barbershop (K-23 v1 seed-company-two-kinds.json),
//                   value for value, but owned by that person and naming biz-roster-owner-<n>
//   company_kinds   company-roster-owner-<n>'s barber: T-1148's one kind of work, fixture set v1's barber shop with its
//                   facts and no switch on in either flow, so K-05 v1.6 reads the business's sensitive switch as off
// The ids are the set's own for each place, never made from the number. No other column of these rows must be unique
// (K-04 core; K-23 companies_business_key holds the business's id, the set's own), so every value is the barbershop's as
// T-1148 writes it. Never seeded: a role, an open question, a booking, a phone row or a sealing key (T-1148's list and its
// reasons: a role, an open question or a booking makes JOIN a turn with a target, a phone row is written at receipt
// (K-05 v1.7 openChatOnText) and a sealing key at first sight (handleSealingKey), each by the gateway). The guard reads no
// company and no kind of work (K-05 v1.2 handleTargets), so JOIN stays a first text; readTurnParty reads the person's one
// company with no role anywhere (K-05 v1.11 item 52, default 100), so the turn runs under biz-roster-owner-<n>, in
// America/New_York.
//
//   const result = await seedRosterOwner(sql);   // result.tables.companies: { rows: 1, inserted: 1, kept: 0 }
//
// The numbers (NQ-DB-2's default: a number is personal data, never in the repository): STAGING_LINQ_ALLOWLIST, read by
// name at run time (infra/scripts/seed-staging.sh hands it to this set's run alone, on that run's line, from the build
// Mac's environment or .dev.vars). It is split on "," alone, as T-416's guard splits it (adapters/src/linq/roster), and
// each entry must be E.164, exactly. Refused before anything is read or written, naming an entry by its place alone: the
// list unset or blank (T-416's guard fails closed on it too); an entry that is not E.164 (a space, an empty entry,
// another separator); a number given twice; and a test phone's fixed fake handle (lib/roster.ts: 555-0100 to 555-0105),
// whose rows are skeleton's and staging-core's, so either set runs before or after this one unchanged.
//
// Then, in one transaction as the job role rosie_job with no business scope (T-191), as the skeleton seed writes, reading
// every entry first and refusing, writing nothing for any number, with every problem named by its entry's place:
//   - the number's handle has more than one person;
//   - its person holds a role, live or ended, or owns a company other than the one this set gives its place;
//   - its handle has a live open question, a booking (its person booked or is served) or a phone row (K-05 v1.2
//     handleTargets, the guard's read);
//   - two entries' handles are one person's;
//   - an id this set gives a place is held otherwise: its handle at another number, its new person on another handle,
//     its company by another person, or its business by another company (the list's order changed since the set first
//     ran: each number keeps its place).
// A handle with no person (an erasure that removed the link: K-05 v1.11 default 4) takes person-roster-owner-<n> and the
// link, as the skeleton seed writes Sam's. Each row is written only when its primary key is free (ON CONFLICT DO NOTHING;
// nothing is updated or deleted), and a clash on any other key is an error that rolls the whole transaction back. After
// the writes it reads every entry again and refuses, rolling everything back, unless the number's handle is a phone
// handle whose one person has no role and owns this place's company alone, whose business holds no live owner role, and
// the guard finds a first text (no live open question, no booking, no phone row): so readTurnParty answers atBusiness
// with biz-roster-owner-<n>, and handleTargets the doors. Idempotent: a second run writes nothing and leaves every row as
// it was, version included. Once a turn from a roster phone has committed (S1-02's question waits for its answer, and its
// phone row stands), the set refuses, as the skeleton seed does for tp-01. Nothing is printed, and no error names a
// number or a value of a row: the runner (T-201) prints the counts this returns.
//
// It runs only when named, `npm run seed:staging -- --set roster-owner`, never in D-017's run (seed-staging.sh's
// D017_SETS). It reads and writes the database alone: the roster phone's actor is cleared by T-1452's staging-only reset
// (DL-944), never here.
import { SCOPE_SETTING, type Sql, type Tx } from "../repo/scope";
import { handleTargetsIn } from "../repo/targets";
import { type CoreSeedTableCount, SEED_ROLE } from "./core";
import { ROSTER } from "./lib/roster";
import {
  type SkeletonBusinessRow,
  type SkeletonCompanyKindRow,
  type SkeletonCompanyRow,
  type SkeletonHandleRow,
  type SkeletonPersonHandleRow,
  SKELETON_ROWS,
} from "./skeleton";

/** The environment variable that names the roster phones: T-416's list, E.164 numbers joined by commas, no space. */
export const ALLOWLIST_VARIABLE = "STAGING_LINQ_ALLOWLIST";

/** The ids this set gives the roster phone at one place of the list: its own, never made from the number. */
export interface RosterOwnerIds {
  readonly businessId: string;
  readonly companyId: string;
  /** The person written when the number's handle holds none, or there is no handle yet. */
  readonly personId: string;
  /** The handle written when no handle holds the number yet. */
  readonly handleId: string;
}

/** The ids of the roster phone at place `place` of the list (from 1). */
export function rosterOwnerIds(place: number): RosterOwnerIds {
  const n = String(place);
  return {
    businessId: `biz-roster-owner-${n}`,
    companyId: `company-roster-owner-${n}`,
    personId: `person-roster-owner-${n}`,
    handleId: `handle-roster-owner-${n}`,
  };
}

/** A person this set writes: no name and no language yet, as the gateway's first sight writes one. */
export interface RosterOwnerPersonRow {
  readonly id: string;
  readonly name: null;
  readonly language: null;
}

/** The set's rows, table by table, in the order their foreign keys need: one row of each table for each roster phone. */
export interface RosterOwnerSeedRows {
  readonly businesses: readonly SkeletonBusinessRow[];
  readonly persons: readonly RosterOwnerPersonRow[];
  readonly handles: readonly SkeletonHandleRow[];
  readonly person_handles: readonly SkeletonPersonHandleRow[];
  readonly companies: readonly SkeletonCompanyRow[];
  readonly company_kinds: readonly SkeletonCompanyKindRow[];
}

export type RosterOwnerSeedTable = keyof RosterOwnerSeedRows;

/** A roster phone as the set left it, by ids alone (never its number), in the list's order. */
export interface RosterOwner {
  /** Its place on STAGING_LINQ_ALLOWLIST, from 1. */
  readonly place: number;
  /** The handle that holds the number: the one made at first sight, or the set's own. */
  readonly handleId: string;
  /** The handle's one person: the one found there, or the set's own. */
  readonly personId: string;
  readonly businessId: string;
  readonly companyId: string;
}

export interface RosterOwnerSeedResult {
  /** The database role that wrote the rows (current_user inside the seed's transaction). */
  readonly ranAs: string;
  readonly tables: Readonly<Record<RosterOwnerSeedTable, CoreSeedTableCount>>;
  readonly owners: readonly RosterOwner[];
}

export interface RosterOwnerSeedOptions {
  /** Where STAGING_LINQ_ALLOWLIST is read. Default process.env. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** The seed refused, writing nothing. Its message names no number, no part of the list and no value of a row. */
export class RosterOwnerSeedError extends Error {
  override readonly name = "RosterOwnerSeedError";
}

// K-11's phone, as T-416's guard reads each entry of the list (adapters/src/linq/roster/roster.ts E164).
const E164 = /^\+[1-9][0-9]{6,14}$/;
const LIST_FORM = "+, then 7 to 15 digits, joined by commas with no space";
const WHEN =
  "run it on a roster phone that has no handle yet or one made at first sight, before a turn from it has committed " +
  "(after that S1-02's question waits for its answer, and only a fresh schema makes its JOIN a first text again), " +
  "with each number at the place it held when the set first ran";

/** T-1148's rows for tp-01, the values every roster phone's rows take (see the top of this file). */
function skeletonRow<T>(rows: readonly T[], table: string): T {
  const [row, ...more] = rows;
  if (row === undefined || more.length > 0) {
    throw new Error(`the skeleton seed has not one ${table} row, whose values this set takes`);
  }
  return row;
}

const BUSINESS = skeletonRow(SKELETON_ROWS.businesses, "businesses");
const COMPANY = skeletonRow(SKELETON_ROWS.companies, "companies");
const KIND = skeletonRow(SKELETON_ROWS.company_kinds, "company_kinds");

const counted = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

const refused = (why: string): RosterOwnerSeedError =>
  new RosterOwnerSeedError(`the roster owner seed refused, writing nothing: ${why}`);

const listRefused = (why: string): RosterOwnerSeedError =>
  refused(`${ALLOWLIST_VARIABLE} ${why} (no part of its value is shown)`);

/** "entry 2" or "entries 1 and 3": places on the list, never their values. */
function entryNames(places: readonly number[]): string {
  const named = places.map(String);
  if (named.length === 1) {
    return `entry ${named[0] ?? ""}`;
  }
  return `entries ${named.slice(0, -1).join(", ")} and ${named[named.length - 1] ?? ""}`;
}

/**
 * The roster phones STAGING_LINQ_ALLOWLIST names, in its order: split on "," alone, each entry E.164 exactly, as T-416's
 * guard reads the list. Refuses, naming entries by their places alone: the list unset or blank, an entry that is not
 * E.164, a number given twice and a test phone's fixed fake handle (lib/roster.ts), which skeleton or staging-core seeds.
 */
export function rosterNumbers(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") {
    throw listRefused(
      "is not set, or is empty: this set makes each roster phone the list names a test owner, and it names none",
    );
  }
  const numbers = value.split(",");
  const malformed = numbers.flatMap((entry, index) => (E164.test(entry) ? [] : [index + 1]));
  if (malformed.length > 0) {
    const are = malformed.length === 1 ? "is" : "are";
    throw listRefused(
      `${entryNames(malformed)} of ${String(numbers.length)} ${are} not an E.164 number (${LIST_FORM})`,
    );
  }
  const firstPlace = new Map<string, number>();
  for (const [index, number] of numbers.entries()) {
    const before = firstPlace.get(number);
    if (before !== undefined) {
      throw listRefused(`${entryNames([before, index + 1])} give the same number`);
    }
    firstPlace.set(number, index + 1);
    const testPhone = ROSTER.find((phone) => phone.fakeNumber === number);
    if (testPhone !== undefined) {
      throw listRefused(
        `${entryNames([index + 1])} is the fixed fake handle of ${testPhone.testPhoneId}, a test phone whose rows the ` +
          "skeleton or staging-core set writes, never this one",
      );
    }
  }
  return numbers;
}

/** What one entry of the list resolves to: the handle and person the set uses for it, and the ids it gives its place. */
interface Plan {
  readonly place: number;
  readonly number: string;
  readonly ids: RosterOwnerIds;
  readonly handleId: string;
  readonly personId: string;
}

/** The handle that holds a number (handles_address_key), or null. */
async function handleAt(tx: Tx, number: string): Promise<{ id: string; kind: string } | null> {
  const [found] = await tx<
    { id: string; kind: string }[]
  >`select id, kind from handles where address = ${number}`;
  return found ?? null;
}

/** The people who write from a handle, in id order. */
async function peopleOf(tx: Tx, handleId: string): Promise<string[]> {
  const links = await tx<{ person_id: string }[]>`
    select person_id from person_handles where handle_id = ${handleId} order by person_id collate "C"
  `;
  return links.map((link) => link.person_id);
}

/** How many roles a person holds, live or ended, at any business. */
async function rolesOf(tx: Tx, personId: string): Promise<number> {
  const [row] = await tx<
    { n: number }[]
  >`select count(*)::int as n from person_roles where person_id = ${personId}`;
  return row?.n ?? 0;
}

/** The companies a person owns, by id and business. */
async function companiesOf(tx: Tx, personId: string): Promise<{ id: string; business_id: string | null }[]> {
  const companies = await tx<{ id: string; business_id: string | null }[]>`
    select id, business_id from companies where owner_person_id = ${personId} order by id collate "C"
  `;
  return [...companies];
}

/** Whether a person owns this place's company alone, naming this place's business. */
function ownsOnlyItsCompany(
  companies: readonly { id: string; business_id: string | null }[],
  ids: RosterOwnerIds,
): boolean {
  return companies.every((company) => company.id === ids.companyId && company.business_id === ids.businessId);
}

/**
 * What the guard would find on a handle (K-05 v1.2 handleTargets, read inside the seed's transaction, on the runtime
 * side), as problems: a live open question, a booking its people booked or are served by, and a phone row.
 */
async function guardProblems(tx: Tx, handleId: string, entry: string): Promise<string[]> {
  const targets = await handleTargetsIn(tx, { handleId });
  if ("error" in targets) {
    return [`${entry}'s handle is missing`];
  }
  const problems: string[] = [];
  if (targets.openQuestions.length > 0) {
    problems.push(
      `${entry}'s handle has ${counted(targets.openQuestions.length, "live open question", "live open questions")}`,
    );
  }
  if (targets.bookings.length > 0) {
    problems.push(`${entry}'s handle has ${counted(targets.bookings.length, "booking", "bookings")}`);
  }
  if (targets.phone !== null) {
    problems.push(`${entry}'s handle has a phone row`);
  }
  return problems;
}

/** The problems with the ids this set gives a place, when the person is `personId` (see the top of this file). */
async function idProblems(tx: Tx, ids: RosterOwnerIds, personId: string, entry: string): Promise<string[]> {
  const problems: string[] = [];
  const [company] = await tx<{ owner_person_id: string; business_id: string | null }[]>`
    select owner_person_id, business_id from companies where id = ${ids.companyId}
  `;
  if (
    company !== undefined &&
    (company.owner_person_id !== personId || company.business_id !== ids.businessId)
  ) {
    problems.push(`the company this set gives ${entry} is another person's or names another business`);
  }
  const others = await tx<{ id: string }[]>`
    select id from companies where business_id = ${ids.businessId} and id <> ${ids.companyId}
  `;
  if (others.length > 0) {
    problems.push(`the business this set gives ${entry} is another company's`);
  }
  return problems;
}

/**
 * Reads every entry before anything is written and resolves each to its handle and person, or refuses, writing nothing
 * for any number, naming every problem by its entry's place (see the top of this file).
 */
async function planOwners(tx: Tx, numbers: readonly string[]): Promise<Plan[]> {
  const problems: string[] = [];
  const plans: Plan[] = [];
  const placeOfPerson = new Map<string, number>();
  for (const [index, number] of numbers.entries()) {
    const place = index + 1;
    const entry = entryNames([place]);
    const ids = rosterOwnerIds(place);
    const handle = await handleAt(tx, number);
    let handleId = ids.handleId;
    let personId = ids.personId;
    let newPerson = true;
    if (handle === null) {
      const [taken] = await tx<{ id: string }[]>`select id from handles where id = ${ids.handleId}`;
      if (taken !== undefined) {
        problems.push(`the handle this set gives ${entry} holds another number`);
      }
    } else {
      handleId = handle.id;
      const people = await peopleOf(tx, handle.id);
      const [only, ...more] = people;
      if (more.length > 0) {
        problems.push(`${entry}'s handle has ${counted(people.length, "person", "people")}, not one`);
      } else if (only !== undefined) {
        personId = only;
        newPerson = false;
      }
      problems.push(...(await guardProblems(tx, handle.id, entry)));
    }
    if (newPerson) {
      const [taken] = await tx<{ id: string }[]>`select id from persons where id = ${ids.personId}`;
      if (taken !== undefined) {
        problems.push(`the person this set gives ${entry} exists already, writing from another handle`);
      }
    } else {
      const roles = await rolesOf(tx, personId);
      if (roles > 0) {
        problems.push(`${entry}'s person holds ${counted(roles, "role", "roles")}, live or ended`);
      }
      if (!ownsOnlyItsCompany(await companiesOf(tx, personId), ids)) {
        problems.push(`${entry}'s person owns a company already`);
      }
      const before = placeOfPerson.get(personId);
      if (before !== undefined) {
        problems.push(`${entryNames([before, place])} are one person's handles`);
      }
      placeOfPerson.set(personId, place);
    }
    problems.push(...(await idProblems(tx, ids, personId, entry)));
    plans.push({ place, number, ids, handleId, personId });
  }
  if (problems.length > 0) {
    throw refused(`${problems.join("; ")}; ${WHEN}`);
  }
  return plans;
}

/** Each roster phone's rows (see the top of this file), one of each table, in the list's order. */
function rowsOf(plans: readonly Plan[]): RosterOwnerSeedRows {
  return {
    businesses: plans.map(({ ids }): SkeletonBusinessRow => ({ ...BUSINESS, id: ids.businessId })),
    persons: plans.map(({ personId }): RosterOwnerPersonRow => ({
      id: personId,
      name: null,
      language: null,
    })),
    handles: plans.map(({ handleId, number }): SkeletonHandleRow => ({
      id: handleId,
      kind: "phone",
      address: number,
    })),
    person_handles: plans.map(({ personId, handleId }): SkeletonPersonHandleRow => ({
      person_id: personId,
      handle_id: handleId,
    })),
    companies: plans.map(({ ids, personId }): SkeletonCompanyRow => ({
      ...COMPANY,
      id: ids.companyId,
      owner_person_id: personId,
      business_id: ids.businessId,
    })),
    company_kinds: plans.map(({ ids }): SkeletonCompanyKindRow => ({
      ...KIND,
      company_id: ids.companyId,
      business_id: ids.businessId,
    })),
  };
}

/**
 * Reads every entry again after the writes, inside the seed's transaction, and refuses, rolling everything back, unless
 * each is a test owner as tp-01 is: the number's handle is the planned phone handle, whose one person holds no role and
 * owns this place's company alone; the business is there and holds no live owner role (readTurnParty's step 5); and the
 * guard finds a first text (handleTargets: no live open question, no booking, no phone row). So readTurnParty answers
 * atBusiness with this place's business (K-05 v1.11 default 100), and the guard offers the doors.
 */
async function requireTestOwners(tx: Tx, plans: readonly Plan[]): Promise<void> {
  const problems: string[] = [];
  for (const { place, number, ids, handleId, personId } of plans) {
    const entry = entryNames([place]);
    const handle = await handleAt(tx, number);
    if (handle?.id !== handleId || handle.kind !== "phone") {
      problems.push(`${entry}'s number is not held by its phone handle`);
      continue;
    }
    const people = await peopleOf(tx, handleId);
    if (people.length !== 1 || people[0] !== personId) {
      problems.push(
        `${entry}'s handle has ${counted(people.length, "person", "people")}, not its owner alone`,
      );
    }
    if ((await rolesOf(tx, personId)) > 0) {
      problems.push(`${entry}'s person holds a role`);
    }
    const companies = await companiesOf(tx, personId);
    if (companies.length !== 1 || !ownsOnlyItsCompany(companies, ids)) {
      problems.push(`${entry}'s person does not own its company alone`);
    }
    const [business] = await tx<{ owners: number }[]>`
      select (select count(*)::int from person_roles
              where business_id = ${ids.businessId} and role = 'owner' and ended_at is null) as owners
      from businesses where id = ${ids.businessId}
    `;
    if (business === undefined) {
      problems.push(`${entry}'s business is missing`);
    } else if (business.owners > 0) {
      problems.push(`${entry}'s business has a live owner role`);
    }
    problems.push(...(await guardProblems(tx, handleId, entry)));
  }
  if (problems.length > 0) {
    throw refused(
      `a roster phone's JOIN would not be a first text under its own business: ${problems.join("; ")}`,
    );
  }
}

/** Gives each roster phone on STAGING_LINQ_ALLOWLIST tp-01's test-owner rows (see the top of this file). */
export async function seedRosterOwner(
  sql: Sql,
  options: RosterOwnerSeedOptions = {},
): Promise<RosterOwnerSeedResult> {
  const numbers = rosterNumbers((options.env ?? process.env)[ALLOWLIST_VARIABLE]);

  const written = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${SEED_ROLE}`);
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    const [who] = await tx<{ role: string }[]>`select current_user as role`;
    const plans = await planOwners(tx, numbers);
    const rows = rowsOf(plans);
    const businesses = await tx`
      insert into businesses ${tx(
        rows.businesses,
        "id",
        "name",
        "display_name",
        "status",
        "time_zone",
        "text_hours_start",
        "text_hours_end",
        "version",
      )}
      on conflict (id) do nothing
    `;
    const persons = await tx`
      insert into persons ${tx(rows.persons, "id", "name", "language")} on conflict (id) do nothing
    `;
    const handles = await tx`
      insert into handles ${tx(rows.handles, "id", "kind", "address")} on conflict (id) do nothing
    `;
    const personHandles = await tx`
      insert into person_handles ${tx(rows.person_handles, "person_id", "handle_id")}
      on conflict (person_id, handle_id) do nothing
    `;
    const companies = await tx`
      insert into companies ${tx(rows.companies, "id", "owner_person_id", "name", "business_id", "version")}
      on conflict (id) do nothing
    `;
    const companyKinds = await tx`
      insert into company_kinds ${tx(
        rows.company_kinds,
        "company_id",
        "kind_id",
        "business_id",
        "trade_name",
        "pf_facts",
        "pf_switches_a",
        "pf_switches_b",
        "version",
      )}
      on conflict (company_id, kind_id) do nothing
    `;
    await requireTestOwners(tx, plans);
    return {
      ranAs: who?.role ?? "",
      plans,
      inserted: {
        businesses: businesses.count,
        persons: persons.count,
        handles: handles.count,
        person_handles: personHandles.count,
        companies: companies.count,
        company_kinds: companyKinds.count,
      },
    };
  });

  const total = written.plans.length;
  const count = (table: RosterOwnerSeedTable): CoreSeedTableCount => {
    const inserted = written.inserted[table];
    return { rows: total, inserted, kept: total - inserted };
  };
  return {
    ranAs: written.ranAs,
    tables: {
      businesses: count("businesses"),
      persons: count("persons"),
      handles: count("handles"),
      person_handles: count("person_handles"),
      companies: count("companies"),
      company_kinds: count("company_kinds"),
    },
    owners: written.plans.map(({ place, handleId, personId, ids }) => ({
      place,
      handleId,
      personId,
      businessId: ids.businessId,
      companyId: ids.companyId,
    })),
  };
}

/** The entry every seed set exports under one name, so a runner finds a set by its file name (T-201). */
export const seed = seedRosterOwner;
