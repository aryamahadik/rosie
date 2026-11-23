// T-1450: the roster phone as a test owner on staging (db/seeds/roster-owner.ts), against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/seeds/roster-owner`). Each block that needs a database migrates a
// fresh test schema of its own (db/repo/test-db.ts) and drops it at the end; the shared public schema is never touched.
//
// The card's proofs: a roster number with no handle yet gets its person, handle, link, business head, company and kind
// of work; a roster number whose handle was made at first sight (by the gateway's own key call, handleSealingKey) keeps
// that handle and person and gets the business, company and kind, and so does one whose chat its first text's receipt
// opened (the real openChatOnText's phone row, which the set adopts as it is: round 2's ruling, DL-948); after any of
// them, K-05's readTurnParty answers atBusiness with the set's business and handleTargets a first text, both read as the
// runtime reads them (a client of this file's own whose connections run as rosie_job with no business scope). Each
// refusal writes nothing for any number: two people on the handle, a role (live or ended), a company, an open question,
// a booking, every phone row but the one openChatOnText's insert leaves (stopped, and each of stop_at, start_at,
// optout_line_delivered_at, linq_contact_added_at and poll_voted_at set; round 2 replaced run 1's refusal of that row)
// and an ill-formed list. A second run writes nothing. The skeleton and staging-core sets, run before or after it, write
// what they write on a fresh schema and keep it after. The runner finds the set by its name and prints counts alone.
//
// T-1462's proofs (DL-964, the architect's N1 on T-1459): each roster business also gets its K-23 v1 business_setup row,
// its business_id alone (control_proven_at and control_proven_via null, no contact value, no_money false, version 1),
// after its businesses row in the set's one transaction, so limit 1's default 14 reads its control as not proven, on the
// runtime side and as the Tool API under that business's scope. A re-run over a set seeded before T-1462 (no such row)
// adds the row and keeps every other row; a row already there, a proven one included, is kept as it is and counted as
// kept; a refusal, before the writes or after them, writes none. Every count and snapshot of T-1450's cases holds the
// table too, so each of them proves the row as well.
//
// What the rows must be is read here from the skeleton seed's rows (T-1148, which its own test checks against K-04's
// seed-business-head.json and K-23's seed-company-two-kinds.json) and the frozen K-05 fixtures (targets-first-text.json,
// read-turn-party-first-text.json, read-turn-party-test-owner-1.json). Every number here is a whole literal in the
// fiction range 555-0100 to 555-0199 (rule 9), and the wrapping key the first sight wraps its key under is made at random
// in the run, never written down.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openChatOnText, type OpenChatOnTextInserted } from "../repo/chat-open";
import { resolvePrimaryUrl } from "../repo/client";
import { handleSealingKey } from "../repo/handle-keys";
import {
  recordLinqContactAdded,
  recordOptoutLineDelivered,
  recordPollVoted,
  startPhone,
  stopPhone,
} from "../repo/phones";
import { type Sql, withBusiness } from "../repo/scope";
import { handleTargets, type HandleTargetsResponse } from "../repo/targets";
import { createTestDatabase, type TestDatabase } from "../repo/test-db";
import { readTurnParty } from "../repo/turn-party";
import { seedCore } from "./core";
import { ROSTER } from "./lib/roster";
import {
  ALLOWLIST_VARIABLE,
  rosterNumbers,
  rosterOwnerIds,
  RosterOwnerSeedError,
  seed,
  seedRosterOwner,
} from "./roster-owner";
import { seedSkeleton, SKELETON_ROWS, TEST_OWNER_1 } from "./skeleton";
import { seedStagingCore } from "./staging-core";

const SLOW = { timeout: 120_000 };
const RUNTIME_ROLE = "rosie_job";
const ZONE = "America/New_York";
const REPO = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const RUNNER = path.join(REPO, "db/seeds/run.mjs");
const CONTRACTS = new URL("../../contracts/", import.meta.url);
// The roster phones of these tests: whole literals in the fiction range, none a test phone's fixed fake handle.
const PHONE_A = "+15555550150";
const PHONE_B = "+15555550151";
const PHONE_C = "+15555550152";
const SEED_TABLES = [
  "businesses",
  "business_setup",
  "persons",
  "handles",
  "person_handles",
  "companies",
  "company_kinds",
] as const;
// Every table whose rows decide a roster phone's targets and party, the rows the set writes, and the keys it never
// writes.
const WATCHED = [
  "businesses",
  "business_setup",
  "persons",
  "person_roles",
  "handles",
  "person_handles",
  "companies",
  "company_kinds",
  "phones",
  "sealing_keys",
  "bookings",
  "bundles",
  "turns",
  "open_questions",
] as const;
// The wrapping key a first sight wraps its new key under: made here at random, for this run alone.
const WRAP_NAME = "SEALING_WRAP_KEY";
const wrappingKey = new Uint8Array(randomBytes(32));
const KEYS = {
  resolve: (name: string): Uint8Array | undefined => (name === WRAP_NAME ? wrappingKey : undefined),
};

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Values = Record<string, Json>;

interface SeedFile {
  rows: { table: string; values: Values }[];
}

interface Exchange<Request, Outcome> {
  given: { now: string };
  request: Request;
  outcome: Outcome;
}

interface TurnParty {
  handleId: string | null;
  businessId: string | null;
  personId: string | null;
  zone: string | null;
}

interface CommitExchange {
  request: {
    turn: {
      id: string;
      eventIds: string[];
      bundleId: { hash: string; build: number };
      traceId: string;
      joinedTraceIds: string[];
      tries: number;
    };
  };
  given: {
    stated: {
      writes: { openQuestions: { id: string; step: string; options: Json[]; versionsRead: Json[] }[] };
    };
  };
  outcome: { committedAt: string };
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(new URL(file, CONTRACTS), "utf8"));
const FIRST_TEXT = readJson("data-access/fixtures/targets-first-text.json") as Exchange<
  { handleId: string },
  HandleTargetsResponse
>;
const PARTY_FIRST_SIGHT = readJson("data-access/fixtures/read-turn-party-first-text.json") as Exchange<
  unknown,
  TurnParty
>;
const PARTY_TEST_OWNER_1 = readJson("data-access/fixtures/read-turn-party-test-owner-1.json") as Exchange<
  unknown,
  TurnParty
>;
const TURN_1_COMMIT = readJson("tool-api/fixtures/commit-s1-01.json") as CommitExchange;

/** One row of a K-04 seed fixture: the one of `table` whose values match `where`. */
function k04Row(file: string, table: string, where: Values): Values {
  const rows = (readJson(`db-schema/core/fixtures/${file}`) as SeedFile).rows.filter(
    (row) =>
      row.table === table && Object.entries(where).every(([column, value]) => row.values[column] === value),
  );
  expect(rows, `${file}: one ${table} row`).toHaveLength(1);
  return rows[0]?.values ?? {};
}

/** The list as the build Mac's .dev.vars holds it: E.164 numbers joined by commas with no space. */
const listOf = (...numbers: string[]): Record<string, string> => ({
  [ALLOWLIST_VARIABLE]: numbers.join(","),
});

/** Connections that run as rosie_job, the runtime's role, with `db`'s schema first and no business scope. */
function runtimeClient(db: TestDatabase): Sql {
  return db.connect({
    max: 2,
    onnotice: () => undefined,
    connection: {
      application_name: "rosie-t1450-roster-owner",
      search_path: `${db.schema}, public`,
      role: RUNTIME_ROLE,
    },
  });
}

/** targets-first-text.json's answer for a roster phone's handle and person: no role, question, booking or phone row. */
function firstTextAnswer(handleId: string, personId: string): HandleTargetsResponse {
  const { outcome } = FIRST_TEXT;
  expect(outcome.persons).toHaveLength(1);
  return {
    ...outcome,
    handleId,
    persons: outcome.persons.map((person) => ({ ...person, personId })),
  };
}

/** The guard's read of a handle, at targets-first-text.json's moment. */
function guardRead(runtime: Sql, handleId: string): ReturnType<typeof handleTargets> {
  return handleTargets(runtime, { handleId }, { now: new Date(FIRST_TEXT.given.now) });
}

/** readTurnParty for a roster phone's number, as the handle actor's turn reads it. */
function partyOf(runtime: Sql, address: string): ReturnType<typeof readTurnParty> {
  return readTurnParty(runtime, { handle: { kind: "phone", address } });
}

/** read-turn-party-test-owner-1.json's answer, for a roster phone: at its own business, in the barbershop's zone. */
function atBusiness(handleId: string, personId: string, businessId: string): TurnParty {
  expect(PARTY_TEST_OWNER_1.outcome.zone).toBe(ZONE);
  return { ...PARTY_TEST_OWNER_1.outcome, handleId, personId, businessId };
}

/** The gateway's first sight of a number (K-05 handleSealingKey): a handle, a person with no name, their link, a key. */
async function firstSight(
  runtime: Sql,
  address: string,
  tag: string,
): Promise<{ handleId: string; personId: string }> {
  const result = await handleSealingKey(runtime, KEYS, {
    handle: { kind: "phone", address },
    newHandleId: `handle-t1450-${tag}`,
    newPersonId: `person-t1450-${tag}`,
    wrappingKeyName: WRAP_NAME,
  });
  if (!("result" in result.outcome)) {
    throw new Error("the first sight made no key");
  }
  expect(result.outcome.created).toEqual({ handle: true, person: true, key: true });
  return { handleId: result.outcome.handleId, personId: result.outcome.personId };
}

/** When a roster phone's first text reached the gateway, in these tests. */
const FIRST_TEXT_AT = "2026-11-18T00:02:00Z";
/** handleTargets' phone (K-05 v1.2 phoneFlags) for the row openChatOnText inserts: not stopped, chat open, version 1. */
const OPENED_FLAGS = { stopped: false, chatOpen: true, version: 1 };

/**
 * The gateway's receipt of a number's first text (K-05 v1.7 openChatOnText, called at receipt, before the turn): the
 * phone row it inserts, its chat open since then by iMessage, not stopped, every other column at K-04's defaults.
 */
async function openChat(runtime: Sql, handleId: string, tag: string): Promise<OpenChatOnTextInserted> {
  const opened = await openChatOnText(runtime, {
    eventId: `evt-t1450-${tag}`,
    handleId,
    service: "imessage",
    receivedAt: FIRST_TEXT_AT,
    traceId: `trace-t1450-${tag}`,
  });
  if (!("result" in opened) || opened.result !== "inserted") {
    throw new Error("the first text's receipt inserted no phone row");
  }
  return opened;
}

/**
 * K-23 v1.1 business_setup's row, every column, as the set writes it for a business (T-1462): its business_id alone, and
 * every other column null or its default (no_money false, version 1). So control is not proven (control_proven_at and
 * control_proven_via null), and it holds no contact value (listing phone or email, website), no About us or profile,
 * no Stripe account, no terms and no sign-up claim (signup_claim and claimed_by_person_id null).
 */
function setupRowOf(businessId: string): Record<string, unknown> {
  return {
    business_id: businessId,
    listing_phone: null,
    listing_email: null,
    website: null,
    about: null,
    profile_confirmed_at: null,
    stripe_account_id: null,
    no_money: false,
    terms_accepted_at: null,
    terms_accepted_by_person_id: null,
    control_proven_at: null,
    control_proven_via: null,
    version: 1,
    signup_claim: null,
    claimed_by_person_id: null,
  };
}

/** The set's rows for the roster phone at `place`, with the handle and person it found or wrote. */
function rowsFor(
  place: number,
  number: string,
  handleId: string,
  personId: string,
): Record<string, unknown[]> {
  const ids = rosterOwnerIds(place);
  const [business] = SKELETON_ROWS.businesses;
  const [company] = SKELETON_ROWS.companies;
  const [kind] = SKELETON_ROWS.company_kinds;
  return {
    businesses: [{ ...business, id: ids.businessId }],
    business_setup: [setupRowOf(ids.businessId)],
    persons: [{ id: personId, name: null, language: null }],
    handles: [{ id: handleId, kind: "phone", address: number }],
    person_handles: [{ person_id: personId, handle_id: handleId }],
    companies: [{ ...company, id: ids.companyId, owner_person_id: personId, business_id: ids.businessId }],
    company_kinds: [{ ...kind, company_id: ids.companyId, business_id: ids.businessId }],
  };
}

/**
 * The rows of the set's seven tables that hold one of the roster phone's keys, in the skeleton test's columns, and
 * business_setup's with every column.
 */
async function rowsOf(
  sql: Sql,
  handleId: string,
  personId: string,
  place: number,
): Promise<Record<string, unknown[]>> {
  const ids = rosterOwnerIds(place);
  return {
    businesses: [
      ...(await sql`
        select id, name, display_name, status, time_zone, to_char(text_hours_start, 'HH24:MI') as text_hours_start,
               to_char(text_hours_end, 'HH24:MI') as text_hours_end, version
        from businesses where id = ${ids.businessId}
      `),
    ],
    business_setup: [...(await sql`select * from business_setup where business_id = ${ids.businessId}`)],
    persons: [...(await sql`select id, name, language from persons where id = ${personId}`)],
    handles: [...(await sql`select id, kind, address from handles where id = ${handleId}`)],
    person_handles: [
      ...(await sql`select person_id, handle_id from person_handles where handle_id = ${handleId}`),
    ],
    companies: [
      ...(await sql`
        select id, owner_person_id, name, business_id, version from companies where owner_person_id = ${personId}
      `),
    ],
    company_kinds: [
      ...(await sql`
        select company_id, kind_id, business_id, trade_name, pf_facts, pf_switches_a, pf_switches_b, version
        from company_kinds where business_id = ${ids.businessId}
      `),
    ],
  };
}

/** The counts of a run whose every table holds `rows` rows, `inserted` of them written by it. */
function countsOf(rows: number, inserted: Partial<Record<(typeof SEED_TABLES)[number], number>>) {
  return Object.fromEntries(
    SEED_TABLES.map((table) => {
      const added = inserted[table] ?? 0;
      return [table, { rows, inserted: added, kept: rows - added }];
    }),
  );
}

/** Every row of the watched tables, in key order. */
async function snapshot(sql: Sql): Promise<Record<string, unknown[]>> {
  const rows: Record<string, unknown[]> = {};
  for (const table of WATCHED) {
    rows[table] = [...(await sql`select * from ${sql(table)} order by 1, 2`)];
  }
  return rows;
}

/** What a refused call threw. */
async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("the seed ran; it should have refused");
}

/** No number of these tests, nor any part of one, is in a text: no 555 and no run of four digits. */
function expectNoNumber(text: string, what: string): void {
  expect(text, what).not.toMatch(/555|[0-9]{4}/);
}

/**
 * The seed refuses `env`'s list, naming each of `reasons` and no number, and leaves every watched row as it was: nothing
 * is written for any number on the list. Gives back what it threw.
 */
async function expectRefused(
  sql: Sql,
  env: Record<string, string>,
  reasons: readonly string[],
): Promise<Error> {
  const before = await snapshot(sql);
  const error = await refusal(seedRosterOwner(sql, { env }));
  expect(error).toBeInstanceOf(RosterOwnerSeedError);
  expect(error.message).toMatch(/^the roster owner seed refused, writing nothing: /);
  for (const reason of reasons) {
    expect(error.message).toContain(reason);
  }
  expectNoNumber(error.message, "the refusal");
  expect(await snapshot(sql)).toEqual(before);
  return error;
}

/** Empties every table of this file's schema (truncating the heads cascades to the rest). */
async function emptied(sql: Sql): Promise<void> {
  await sql`truncate businesses, persons, handles, bundles, release_flags cascade`;
}

describe("the list: STAGING_LINQ_ALLOWLIST, read as T-416's guard reads it", () => {
  it("is the variable T-416's guard and seed-staging.sh name", () => {
    expect(ALLOWLIST_VARIABLE).toBe("STAGING_LINQ_ALLOWLIST");
  });

  it("splits on commas alone, in the list's order, each entry E.164 exactly", () => {
    expect(rosterNumbers(PHONE_A)).toEqual([PHONE_A]);
    expect(rosterNumbers(`${PHONE_B},${PHONE_A},${PHONE_C}`)).toEqual([PHONE_B, PHONE_A, PHONE_C]);
  });

  it("refuses, naming entries by their places alone and no part of the value: unset, blank, an entry not E.164, a number twice, a test phone's fake handle", () => {
    const cases: [string | undefined, string][] = [
      [undefined, "STAGING_LINQ_ALLOWLIST is not set, or is empty"],
      ["", "STAGING_LINQ_ALLOWLIST is not set, or is empty"],
      ["  ", "STAGING_LINQ_ALLOWLIST is not set, or is empty"],
      [`${PHONE_A}, ${PHONE_B}`, "STAGING_LINQ_ALLOWLIST entry 2 of 2 is not an E.164 number"],
      [` ${PHONE_A}`, "STAGING_LINQ_ALLOWLIST entry 1 of 1 is not an E.164 number"],
      [`${PHONE_A},`, "STAGING_LINQ_ALLOWLIST entry 2 of 2 is not an E.164 number"],
      [`${PHONE_A},,${PHONE_B}`, "STAGING_LINQ_ALLOWLIST entry 2 of 3 is not an E.164 number"],
      [`${PHONE_A};${PHONE_B}`, "STAGING_LINQ_ALLOWLIST entry 1 of 1 is not an E.164 number"],
      [PHONE_A.slice(1), "STAGING_LINQ_ALLOWLIST entry 1 of 1 is not an E.164 number"],
      [`(555) 555-0150,${PHONE_B}`, "STAGING_LINQ_ALLOWLIST entry 1 of 2 is not an E.164 number"],
      [`x,${PHONE_A},y`, "STAGING_LINQ_ALLOWLIST entries 1 and 3 of 3 are not an E.164 number"],
      [`${PHONE_A},${PHONE_B},${PHONE_A}`, "STAGING_LINQ_ALLOWLIST entries 1 and 3 give the same number"],
      [`${PHONE_A},+15555550100`, "entry 2 is the fixed fake handle of tp-01"],
      ["+15555550101", "entry 1 is the fixed fake handle of tp-03"],
    ];
    for (const [value, says] of cases) {
      const what = value === undefined ? "unset" : JSON.stringify(value);
      let thrown: unknown;
      try {
        rosterNumbers(value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, what).toBeInstanceOf(RosterOwnerSeedError);
      const message = (thrown as Error).message;
      expect(message, what).toContain(says);
      expect(message, what).toContain("(no part of its value is shown)");
      expectNoNumber(message, what);
    }
  });

  it("each test phone's fixed fake handle is refused: those rows are the skeleton's and staging-core's", () => {
    for (const phone of ROSTER) {
      expect(() => rosterNumbers(`${PHONE_A},${phone.fakeNumber}`), phone.testPhoneId).toThrow(
        `entry 2 is the fixed fake handle of ${phone.testPhoneId}`,
      );
    }
  });
});

describe("a roster number with no handle yet, and one whose handle was made at first sight", () => {
  let db: TestDatabase;
  let runtime: Sql;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_roster_owner" });
    runtime = runtimeClient(db);
  }, 120_000);

  afterAll(async () => {
    await runtime.end({ timeout: 5 });
    await db.drop();
  });

  beforeEach(async () => {
    await emptied(db.sql);
  });

  it("is the set T-201's runner finds by its file name: `seed` is this seed", () => {
    expect(seed).toBe(seedRosterOwner);
  });

  it(
    "no handle yet: the person, handle, link, business head, company and kind are written as rosie_job, and nothing else; readTurnParty answers atBusiness with that business and handleTargets a first text; a second run writes nothing",
    SLOW,
    async () => {
      const ids = rosterOwnerIds(1);
      const first = await seedRosterOwner(db.sql, { env: listOf(PHONE_A) });
      expect(first).toEqual({
        ranAs: RUNTIME_ROLE,
        tables: countsOf(1, {
          businesses: 1,
          business_setup: 1,
          persons: 1,
          handles: 1,
          person_handles: 1,
          companies: 1,
          company_kinds: 1,
        }),
        owners: [
          {
            place: 1,
            handleId: ids.handleId,
            personId: ids.personId,
            businessId: ids.businessId,
            companyId: ids.companyId,
          },
        ],
      });
      expect(await rowsOf(db.sql, ids.handleId, ids.personId, 1)).toEqual(
        rowsFor(1, PHONE_A, ids.handleId, ids.personId),
      );
      const [never] = await db.sql<
        { roles: number; phones: number; keys: number; questions: number; bookings: number }[]
      >`
        select (select count(*)::int from person_roles) as roles, (select count(*)::int from phones) as phones,
               (select count(*)::int from sealing_keys) as keys, (select count(*)::int from open_questions) as questions,
               (select count(*)::int from bookings) as bookings
      `;
      expect(never).toEqual({ roles: 0, phones: 0, keys: 0, questions: 0, bookings: 0 });
      expect(await partyOf(runtime, PHONE_A)).toEqual(atBusiness(ids.handleId, ids.personId, ids.businessId));
      expect(await guardRead(runtime, ids.handleId)).toEqual(firstTextAnswer(ids.handleId, ids.personId));

      const before = await snapshot(db.sql);
      const second = await seedRosterOwner(db.sql, { env: listOf(PHONE_A) });
      expect(second.tables).toEqual(countsOf(1, {}));
      expect(second.owners).toEqual(first.owners);
      expect(await snapshot(db.sql)).toEqual(before);
      expect(await partyOf(runtime, PHONE_A)).toEqual(atBusiness(ids.handleId, ids.personId, ids.businessId));
    },
  );

  it(
    "made at first sight (the gateway's key call: one person, no name, a key, nothing else): that handle and person are used, the business, company and kind are written, and the key is left as it was; noBusiness before, atBusiness and a first text after; a second run writes nothing",
    SLOW,
    async () => {
      const sight = await firstSight(runtime, PHONE_A, "first-sight");
      // Today's state on staging: the turn would run with no business (open gap 119).
      expect(await partyOf(runtime, PHONE_A)).toEqual({
        ...PARTY_FIRST_SIGHT.outcome,
        handleId: sight.handleId,
        personId: sight.personId,
      });
      const keysBefore = [...(await db.sql`select * from sealing_keys order by person_id`)];
      expect(keysBefore).toHaveLength(1);

      const ids = rosterOwnerIds(1);
      const first = await seedRosterOwner(db.sql, { env: listOf(PHONE_A) });
      expect(first.ranAs).toBe(RUNTIME_ROLE);
      expect(first.tables).toEqual(
        countsOf(1, { businesses: 1, business_setup: 1, companies: 1, company_kinds: 1 }),
      );
      expect(first.owners).toEqual([
        {
          place: 1,
          handleId: sight.handleId,
          personId: sight.personId,
          businessId: ids.businessId,
          companyId: ids.companyId,
        },
      ]);
      expect(await rowsOf(db.sql, sight.handleId, sight.personId, 1)).toEqual(
        rowsFor(1, PHONE_A, sight.handleId, sight.personId),
      );
      expect([...(await db.sql`select * from sealing_keys order by person_id`)]).toEqual(keysBefore);
      const [never] = await db.sql<{ persons: number; roles: number; phones: number; handles: number }[]>`
        select (select count(*)::int from persons) as persons, (select count(*)::int from person_roles) as roles,
               (select count(*)::int from phones) as phones, (select count(*)::int from handles) as handles
      `;
      expect(never).toEqual({ persons: 1, roles: 0, phones: 0, handles: 1 });
      expect(await partyOf(runtime, PHONE_A)).toEqual(
        atBusiness(sight.handleId, sight.personId, ids.businessId),
      );
      expect(await guardRead(runtime, sight.handleId)).toEqual(
        firstTextAnswer(sight.handleId, sight.personId),
      );

      const before = await snapshot(db.sql);
      const second = await seedRosterOwner(db.sql, { env: listOf(PHONE_A) });
      expect(second.tables).toEqual(countsOf(1, {}));
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );

  it(
    "made at first sight, its chat opened by its first text's receipt (the real openChatOnText's phone row: stopped false; stop_at, start_at, optout_line_delivered_at, linq_contact_added_at and poll_voted_at null): that handle and person are used and the phone row is left as it was; noBusiness before, atBusiness and a first text after (no role, open question or booking: the doors); the next JOIN's receipt writes nothing and both reads answer the same; a second run writes nothing",
    SLOW,
    async () => {
      const sight = await firstSight(runtime, PHONE_A, "chat-opened");
      const opened = await openChat(runtime, sight.handleId, "chat-opened");
      // Staging's state since the roster phone first texted: its handle, its key and its open chat, and its turns run
      // with no business (open gap 119).
      expect(await partyOf(runtime, PHONE_A)).toEqual({
        ...PARTY_FIRST_SIGHT.outcome,
        handleId: sight.handleId,
        personId: sight.personId,
      });
      const phonesBefore = [...(await db.sql`select * from phones order by number`)];
      expect(phonesBefore).toEqual([
        {
          number: PHONE_A,
          handle_id: sight.handleId,
          chat_open: true,
          chat_open_at: new Date(FIRST_TEXT_AT),
          chat_way: "imessage",
          stopped: false,
          stop_at: null,
          start_at: null,
          linq_contact_added_at: null,
          poll_voted_at: null,
          optout_line_delivered_at: null,
          version: 1,
        },
      ]);
      const keysBefore = [...(await db.sql`select * from sealing_keys order by person_id`)];

      const ids = rosterOwnerIds(1);
      const first = await seedRosterOwner(db.sql, { env: listOf(PHONE_A) });
      expect(first.ranAs).toBe(RUNTIME_ROLE);
      expect(first.tables).toEqual(
        countsOf(1, { businesses: 1, business_setup: 1, companies: 1, company_kinds: 1 }),
      );
      expect(first.owners).toEqual([
        {
          place: 1,
          handleId: sight.handleId,
          personId: sight.personId,
          businessId: ids.businessId,
          companyId: ids.companyId,
        },
      ]);
      expect(await rowsOf(db.sql, sight.handleId, sight.personId, 1)).toEqual(
        rowsFor(1, PHONE_A, sight.handleId, sight.personId),
      );
      expect([...(await db.sql`select * from phones order by number`)]).toEqual(phonesBefore);
      expect([...(await db.sql`select * from sealing_keys order by person_id`)]).toEqual(keysBefore);
      const firstTextWithChat = {
        ...firstTextAnswer(sight.handleId, sight.personId),
        phone: OPENED_FLAGS,
      };
      expect(await partyOf(runtime, PHONE_A)).toEqual(
        atBusiness(sight.handleId, sight.personId, ids.businessId),
      );
      expect(await guardRead(runtime, sight.handleId)).toEqual(firstTextWithChat);

      // The roster phone's next JOIN: its receipt finds the chat open and writes nothing, and its turn reads the same.
      const before = await snapshot(db.sql);
      const join = await openChatOnText(runtime, {
        eventId: "evt-t1450-next-join",
        handleId: sight.handleId,
        service: "imessage",
        receivedAt: "2026-11-18T00:30:00Z",
        traceId: "trace-t1450-next-join",
      });
      expect(join).toEqual({
        result: "alreadyOpen",
        handleId: sight.handleId,
        phone: opened.phone,
        event: null,
      });
      expect(await snapshot(db.sql)).toEqual(before);
      expect(await partyOf(runtime, PHONE_A)).toEqual(
        atBusiness(sight.handleId, sight.personId, ids.businessId),
      );
      expect(await guardRead(runtime, sight.handleId)).toEqual(firstTextWithChat);

      const second = await seedRosterOwner(db.sql, { env: listOf(PHONE_A) });
      expect(second.tables).toEqual(countsOf(1, {}));
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );

  it(
    "a handle that holds the number with no person (an erasure removed the link): the set's person and the link are written, as the skeleton seed writes Sam's",
    SLOW,
    async () => {
      await db.sql`insert into handles (id, kind, address) values ('handle-t1450-no-person', 'phone', ${PHONE_A})`;
      const ids = rosterOwnerIds(1);
      const first = await seedRosterOwner(db.sql, { env: listOf(PHONE_A) });
      expect(first.tables).toEqual(
        countsOf(1, {
          businesses: 1,
          business_setup: 1,
          persons: 1,
          person_handles: 1,
          companies: 1,
          company_kinds: 1,
        }),
      );
      expect(first.owners).toMatchObject([{ handleId: "handle-t1450-no-person", personId: ids.personId }]);
      expect(await rowsOf(db.sql, "handle-t1450-no-person", ids.personId, 1)).toEqual(
        rowsFor(1, PHONE_A, "handle-t1450-no-person", ids.personId),
      );
      expect(await partyOf(runtime, PHONE_A)).toEqual(
        atBusiness("handle-t1450-no-person", ids.personId, ids.businessId),
      );
      expect(await guardRead(runtime, "handle-t1450-no-person")).toEqual(
        firstTextAnswer("handle-t1450-no-person", ids.personId),
      );
    },
  );

  it(
    "three roster phones at once, each at its place: one with no handle, one made at first sight, one with no person; each its own business, and a second run writes nothing",
    SLOW,
    async () => {
      const sight = await firstSight(runtime, PHONE_B, "first-sight-b");
      await db.sql`insert into handles (id, kind, address) values ('handle-t1450-no-person-c', 'phone', ${PHONE_C})`;
      const env = listOf(PHONE_A, PHONE_B, PHONE_C);
      const first = await seedRosterOwner(db.sql, { env });
      expect(first.tables).toEqual(
        countsOf(3, {
          businesses: 3,
          business_setup: 3,
          persons: 2,
          handles: 1,
          person_handles: 2,
          companies: 3,
          company_kinds: 3,
        }),
      );
      const expected = [
        { number: PHONE_A, handleId: rosterOwnerIds(1).handleId, personId: rosterOwnerIds(1).personId },
        { number: PHONE_B, handleId: sight.handleId, personId: sight.personId },
        { number: PHONE_C, handleId: "handle-t1450-no-person-c", personId: rosterOwnerIds(3).personId },
      ];
      for (const [index, { number, handleId, personId }] of expected.entries()) {
        const place = index + 1;
        const { businessId, companyId } = rosterOwnerIds(place);
        expect(first.owners[index]).toEqual({ place, handleId, personId, businessId, companyId });
        expect(await rowsOf(db.sql, handleId, personId, place)).toEqual(
          rowsFor(place, number, handleId, personId),
        );
        expect(await partyOf(runtime, number)).toEqual(atBusiness(handleId, personId, businessId));
        expect(await guardRead(runtime, handleId)).toEqual(firstTextAnswer(handleId, personId));
      }
      const before = await snapshot(db.sql);
      const second = await seedRosterOwner(db.sql, { env });
      expect(second.tables).toEqual(countsOf(3, {}));
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );

  it(
    "the runner (T-201) finds the set by its name, reads the list by name and prints counts alone, never a number; an ill-formed list exits 1 with nothing written and no part of it shown",
    SLOW,
    async () => {
      const local = { DATABASE_URL: resolvePrimaryUrl(), DB_SCHEMA: db.schema };
      const run = await runSeed({ ...local, ...listOf(PHONE_A, PHONE_B) });
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).toBe("");
      expect(lines(run.stdout)).toEqual([
        `seed: set roster-owner into schema ${db.schema} on the local database`,
        ...SEED_TABLES.map((table) => `seed: ${table}: 2 rows (2 inserted, 0 kept)`),
        `seed: done: set roster-owner into schema ${db.schema}: 14 rows in 7 tables (14 inserted, 0 kept)`,
      ]);
      expectNoNumber(`${run.stdout}${run.stderr}`.replaceAll(db.schema, ""), "the runner's output");

      const before = await snapshot(db.sql);
      const refused = await runSeed({ ...local, [ALLOWLIST_VARIABLE]: `${PHONE_A}, ${PHONE_C}` });
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe(`seed: set roster-owner into schema ${db.schema} on the local database\n`);
      expect(lines(refused.stderr)).toEqual([
        "seed: failed: the roster owner seed refused, writing nothing: STAGING_LINQ_ALLOWLIST entry 2 of 2 is not " +
          "an E.164 number (+, then 7 to 15 digits, joined by commas with no space) (no part of its value is shown)",
      ]);
      expectNoNumber(`${refused.stdout}${refused.stderr}`.replaceAll(db.schema, ""), "the refusal's output");
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );
});

// ---- the runner, run as seed-staging.sh runs it ----------------------------------------------------------------------

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

// The variables the runner and this set read: each child run sets only the ones it names.
const CHILD_VARIABLES = new Set([
  "DATABASE_URL",
  "DATABASE_REPLICA_URL",
  "DB_SCHEMA",
  "STAGING_DATABASE_URL",
  "CI",
  ALLOWLIST_VARIABLE,
]);

/** Runs `node db/seeds/run.mjs --set roster-owner` with this environment's variables, less the child's own, plus `env`. */
function runSeed(env: Readonly<Record<string, string>>): Promise<Run> {
  const childEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !CHILD_VARIABLES.has(name)) {
      childEnv[name] = value;
    }
  }
  Object.assign(childEnv, env);
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [RUNNER, "--set", "roster-owner"],
      { cwd: REPO, env: childEnv, timeout: 110_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : error.code;
        if (typeof code === "number") {
          resolve({ code, stdout, stderr });
        } else {
          reject(error ?? new Error("the runner ended with no exit code"));
        }
      },
    );
  });
}

const lines = (text: string): string[] => text.split("\n").filter((line) => line !== "");

describe("never on top of a state where a roster phone's JOIN would not be a first text: the seed refuses, writing nothing for any number", () => {
  let db: TestDatabase;
  let runtime: Sql;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_roster_owner_refusals" });
    runtime = runtimeClient(db);
  }, 120_000);

  afterAll(async () => {
    await runtime.end({ timeout: 5 });
    await db.drop();
  });

  beforeEach(async () => {
    await emptied(db.sql);
  });

  /** A business no roster phone's rows name, for a role, a company or a booking to sit at. */
  async function otherBusiness(): Promise<string> {
    await db.sql`
      insert into businesses (id, name, display_name, time_zone)
      values ('biz-t1450-other', 'Other Shop', 'Other Shop', ${ZONE})
    `;
    return "biz-t1450-other";
  }

  it("an ill-formed list, before anything is read or written", SLOW, async () => {
    await firstSight(runtime, PHONE_A, "ill-formed");
    for (const value of ["", `${PHONE_A}, ${PHONE_B}`, `${PHONE_B};${PHONE_A}`, `${PHONE_B},${PHONE_B}`]) {
      await expectRefused(db.sql, { [ALLOWLIST_VARIABLE]: value }, [ALLOWLIST_VARIABLE]);
    }
    const before = await snapshot(db.sql);
    await expect(seedRosterOwner(db.sql, { env: {} })).rejects.toThrow(
      "STAGING_LINQ_ALLOWLIST is not set, or is empty",
    );
    expect(await snapshot(db.sql)).toEqual(before);
  });

  it("two people on the handle", SLOW, async () => {
    const sight = await firstSight(runtime, PHONE_B, "two-people");
    await db.sql`insert into persons (id) values ('person-t1450-other')`;
    await db.sql`insert into person_handles (person_id, handle_id) values ('person-t1450-other', ${sight.handleId})`;
    await expectRefused(db.sql, listOf(PHONE_A, PHONE_B), ["entry 2's handle has 2 people, not one"]);
  });

  it("a role, live or ended, at any business", SLOW, async () => {
    const sight = await firstSight(runtime, PHONE_B, "role");
    const business = await otherBusiness();
    await db.sql`
      insert into person_roles (id, person_id, business_id, role, ended_at)
      values ('role-t1450-ended', ${sight.personId}, ${business}, 'customer', '2026-10-01T00:00:00Z')
    `;
    await expectRefused(db.sql, listOf(PHONE_A, PHONE_B), ["entry 2's person holds 1 role, live or ended"]);
    await db.sql`
      insert into person_roles (id, person_id, business_id, role)
      values ('role-t1450-live', ${sight.personId}, ${business}, 'staff')
    `;
    await expectRefused(db.sql, listOf(PHONE_B, PHONE_A), ["entry 1's person holds 2 roles, live or ended"]);
  });

  it("a company the person owns already, with a business or none yet", SLOW, async () => {
    const sight = await firstSight(runtime, PHONE_B, "company");
    await db.sql`
      insert into companies (id, owner_person_id, name, business_id)
      values ('company-t1450-own', ${sight.personId}, 'Own Shop LLC', null)
    `;
    await expectRefused(db.sql, listOf(PHONE_A, PHONE_B), ["entry 2's person owns a company already"]);
    const business = await otherBusiness();
    await db.sql`update companies set business_id = ${business}, version = 2 where id = 'company-t1450-own'`;
    await expectRefused(db.sql, listOf(PHONE_A, PHONE_B), ["entry 2's person owns a company already"]);
  });

  it(
    "an open question: once the roster phone's turn 1 has committed, S1-02's question waits for its answer (K-09 v1.5 commit-s1-01.json's)",
    SLOW,
    async () => {
      await seedRosterOwner(db.sql, { env: listOf(PHONE_A) });
      const ids = rosterOwnerIds(1);
      const { turn } = TURN_1_COMMIT.request;
      const [question] = TURN_1_COMMIT.given.stated.writes.openQuestions;
      if (question === undefined) {
        throw new Error("commit-s1-01.json states no open question");
      }
      const bundle = k04Row("seed-bundle-registry.json", "bundles", {
        hash: turn.bundleId.hash,
        build: turn.bundleId.build,
      });
      await db.sql.begin(async (tx) => {
        await tx`insert into bundles ${tx(bundle as Record<string, never>)}`;
        await tx`
          insert into turns (id, handle_id, event_ids, state, bundle_hash, bundle_build, trace_id, joined_trace_ids,
                             tries, committed_at)
          values ('turn-t1450-s1-01', ${ids.handleId}, ${turn.eventIds}, 'committed', ${turn.bundleId.hash},
                  ${turn.bundleId.build}, ${turn.traceId}, ${turn.joinedTraceIds}, ${turn.tries},
                  ${TURN_1_COMMIT.outcome.committedAt})
        `;
        await tx`
          insert into open_questions (id, turn_id, handle_id, person_id, business_id, booking_id, step, options,
                                      readback, versions_read, bundle_hash, bundle_build, clock)
          values ('oq-t1450-s1-02', 'turn-t1450-s1-01', ${ids.handleId}, ${ids.personId}, ${ids.businessId}, null,
                  ${question.step}, ${tx.json(question.options)}, null, ${tx.json(question.versionsRead)},
                  ${turn.bundleId.hash}, ${turn.bundleId.build}, null)
        `;
      });
      await expectRefused(db.sql, listOf(PHONE_A, PHONE_B), ["entry 1's handle has 1 live open question"]);
    },
  );

  it("a booking the person made or is served by", SLOW, async () => {
    const sight = await firstSight(runtime, PHONE_B, "booking");
    const business = await otherBusiness();
    await db.sql`
      insert into bookings (id, business_id, flow, stage, booker_person_id, served_person_id)
      values ('booking-t1450', ${business}, 'A', 'booked', ${sight.personId}, ${sight.personId})
    `;
    await expectRefused(db.sql, listOf(PHONE_A, PHONE_B), ["entry 2's handle has 1 booking"]);
  });

  // Every phone row but the one openChatOnText's insert leaves (round 2's ruling, DL-948; it replaces run 1's refusal of
  // that row, which the set now adopts): each made from that row, by db/repo/phones.ts's own writer where one sets the
  // column alone, else by an update of that column alone, the version raised as K-04's trigger asks.
  const STOP_AT = new Date("2026-11-18T00:05:00Z");
  const START_AT = new Date("2026-11-18T00:06:00Z");
  /** The row's change went through: the writer's compare-and-set at the version it read. */
  const applied = (result: { ok: boolean }): void => {
    expect(result.ok).toBe(true);
  };
  const phoneRowCases: { what: string; tag: string; change: () => Promise<void>; says: string[] }[] = [
    {
      what: "stopped (the real stopPhone): a recorded STOP is never adopted",
      tag: "stopped",
      change: async () => {
        applied(await stopPhone(db.sql, PHONE_B, 1, STOP_AT));
      },
      says: [
        "entry 2's phone is stopped, and a recorded STOP is never adopted",
        "entry 2's phone row has stop_at set",
      ],
    },
    {
      what: "stop_at set, not stopped",
      tag: "stop-at",
      change: async () => {
        await db.sql`update phones set stop_at = ${STOP_AT}, version = version + 1 where number = ${PHONE_B}`;
      },
      says: ["entry 2's phone row has stop_at set, so it is not the row openChatOnText's insert leaves"],
    },
    {
      what: "start_at set",
      tag: "start-at",
      change: async () => {
        await db.sql`update phones set start_at = ${START_AT}, version = version + 1 where number = ${PHONE_B}`;
      },
      says: ["entry 2's phone row has start_at set, so it is not the row openChatOnText's insert leaves"],
    },
    {
      what: "optout_line_delivered_at set (the real recordOptoutLineDelivered: the STOP, HELP and rates line went)",
      tag: "optout-line",
      change: async () => {
        applied(await recordOptoutLineDelivered(db.sql, PHONE_B, 1, START_AT));
      },
      says: [
        "entry 2's phone row has optout_line_delivered_at set, so it is not the row openChatOnText's insert leaves",
      ],
    },
    {
      what: "linq_contact_added_at set (the real recordLinqContactAdded)",
      tag: "linq-contact",
      change: async () => {
        applied(await recordLinqContactAdded(db.sql, PHONE_B, 1, START_AT));
      },
      says: [
        "entry 2's phone row has linq_contact_added_at set, so it is not the row openChatOnText's insert leaves",
      ],
    },
    {
      what: "poll_voted_at set (the real recordPollVoted)",
      tag: "poll-voted",
      change: async () => {
        applied(await recordPollVoted(db.sql, PHONE_B, 1, START_AT));
      },
      says: [
        "entry 2's phone row has poll_voted_at set, so it is not the row openChatOnText's insert leaves",
      ],
    },
    {
      what: "a STOP, then a START (the real stopPhone and startPhone): not stopped, stop_at and start_at set",
      tag: "started-again",
      change: async () => {
        applied(await stopPhone(db.sql, PHONE_B, 1, STOP_AT));
        applied(await startPhone(db.sql, PHONE_B, 2, START_AT));
      },
      says: [
        "entry 2's phone row has stop_at and start_at set, so it is not the row openChatOnText's insert leaves",
      ],
    },
  ];

  for (const { what, tag, change, says } of phoneRowCases) {
    it(`a phone row other than the one openChatOnText's insert leaves: ${what}`, SLOW, async () => {
      const sight = await firstSight(runtime, PHONE_B, tag);
      await openChat(runtime, sight.handleId, tag);
      await change();
      const error = await expectRefused(db.sql, listOf(PHONE_A, PHONE_B), says);
      if (tag !== "stopped") {
        expect(error.message).not.toContain("is stopped");
      }
    });
  }

  it("two entries whose handles are one person's", SLOW, async () => {
    const sight = await firstSight(runtime, PHONE_A, "one-person");
    await db.sql`insert into handles (id, kind, address) values ('handle-t1450-second', 'phone', ${PHONE_B})`;
    await db.sql`insert into person_handles (person_id, handle_id) values (${sight.personId}, 'handle-t1450-second')`;
    await expectRefused(db.sql, listOf(PHONE_A, PHONE_B), ["entries 1 and 2 are one person's handles"]);
  });

  it(
    "the list's order changed since the set first ran: a place's handle at another number, its company another person's",
    SLOW,
    async () => {
      await seedRosterOwner(db.sql, { env: listOf(PHONE_A, PHONE_B) });
      await expectRefused(db.sql, listOf(PHONE_C), [
        "the handle this set gives entry 1 holds another number",
      ]);
      await expectRefused(db.sql, listOf(PHONE_B, PHONE_A), [
        "entry 1's person owns a company already",
        "the company this set gives entry 1 is another person's or names another business",
        "entry 2's person owns a company already",
        "the company this set gives entry 2 is another person's or names another business",
      ]);
    },
  );
});

describe("with D-017's sets: core, staging-core and skeleton run before or after it, as they run on their own", () => {
  let db: TestDatabase;
  let runtime: Sql;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_roster_owner_d017" });
    runtime = runtimeClient(db);
  }, 120_000);

  afterAll(async () => {
    await runtime.end({ timeout: 5 });
    await db.drop();
  });

  beforeEach(async () => {
    await emptied(db.sql);
  });

  /** D-017's sets but staging-testers and check-tester, in D-017's order, with staging-core at its fake handles. */
  async function d017(): Promise<Record<string, Record<string, { inserted: number; kept: number }>>> {
    const core = await seedCore(db.sql);
    const stagingCore = await seedStagingCore(db.sql, { env: {} });
    const skeleton = await seedSkeleton(db.sql);
    return { core: core.tables, stagingCore: stagingCore.tables, skeleton: skeleton.tables };
  }

  /** Every count a run of D-017's sets returned, as "<set> <table>: <inserted> inserted, <kept> kept". */
  const flat = (runs: Record<string, Record<string, { inserted: number; kept: number }>>): string[] =>
    Object.entries(runs).flatMap(([set, tables]) =>
      Object.entries(tables).map(
        ([table, count]) => `${set} ${table}: ${String(count.inserted)} inserted, ${String(count.kept)} kept`,
      ),
    );

  it(
    "before it and after it, D-017's sets write what they write on a fresh schema and keep it after; tp-01's JOIN and each roster phone's are first texts, each under its own business",
    SLOW,
    async () => {
      // D-017's sets alone, on a fresh schema: what they write.
      const alone = flat(await d017());
      await emptied(db.sql);

      // The roster phones first, then D-017's sets: the same counts.
      const roster = await seedRosterOwner(db.sql, { env: listOf(PHONE_A, PHONE_B) });
      expect(roster.tables).toEqual(
        countsOf(2, {
          businesses: 2,
          business_setup: 2,
          persons: 2,
          handles: 2,
          person_handles: 2,
          companies: 2,
          company_kinds: 2,
        }),
      );
      expect(flat(await d017())).toEqual(alone);

      // Then each again: nothing more is written.
      const before = await snapshot(db.sql);
      const again = await seedRosterOwner(db.sql, { env: listOf(PHONE_A, PHONE_B) });
      expect(again.tables).toEqual(countsOf(2, {}));
      for (const line of flat(await d017())) {
        expect(line).toMatch(/: 0 inserted, /);
      }
      expect(await snapshot(db.sql)).toEqual(before);

      // tp-01 runs under Lee's Barbershop and each roster phone under its own business.
      const ownerAddress = SKELETON_ROWS.handles[0]?.address ?? "";
      expect(await partyOf(runtime, ownerAddress)).toEqual(PARTY_TEST_OWNER_1.outcome);
      for (const [index, number] of [PHONE_A, PHONE_B].entries()) {
        const ids = rosterOwnerIds(index + 1);
        expect(await partyOf(runtime, number)).toEqual(
          atBusiness(ids.handleId, ids.personId, ids.businessId),
        );
        expect(await guardRead(runtime, ids.handleId)).toEqual(firstTextAnswer(ids.handleId, ids.personId));
      }
      expect(await guardRead(runtime, TEST_OWNER_1.handleId)).toEqual(
        firstTextAnswer(TEST_OWNER_1.handleId, TEST_OWNER_1.personId),
      );
    },
  );

  it(
    "after D-017's sets, the roster phones' rows: D-017's sets then this set, and this set then D-017's sets again, write nothing more",
    SLOW,
    async () => {
      await d017();
      const roster = await seedRosterOwner(db.sql, { env: listOf(PHONE_A, PHONE_B) });
      expect(roster.tables).toEqual(
        countsOf(2, {
          businesses: 2,
          business_setup: 2,
          persons: 2,
          handles: 2,
          person_handles: 2,
          companies: 2,
          company_kinds: 2,
        }),
      );
      const before = await snapshot(db.sql);
      for (const line of flat(await d017())) {
        expect(line).toMatch(/: 0 inserted, /);
      }
      expect((await seedRosterOwner(db.sql, { env: listOf(PHONE_A, PHONE_B) })).tables).toEqual(
        countsOf(2, {}),
      );
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );
});

// ---- business_setup (T-1462) -----------------------------------------------------------------------------------------

describe("each roster business's business_setup row, its control not proven (T-1462; DL-964, the architect's N1 on T-1459): written after its businesses row in the set's one transaction, then kept as it is", () => {
  let db: TestDatabase;
  let runtime: Sql;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_roster_owner_setup" });
    runtime = runtimeClient(db);
  }, 120_000);

  afterAll(async () => {
    await runtime.end({ timeout: 5 });
    await db.drop();
  });

  beforeEach(async () => {
    await emptied(db.sql);
  });

  // S1-75's two proofs of a business's control (K-23 v1 control_proven_via), and a role's end, in these tests.
  const CODE_CAME_BACK_AT = new Date("2026-11-18T01:00:00Z");
  const TEAM_CHECKED_AT = new Date("2026-11-18T01:30:00Z");
  const ROLE_ENDED_AT = new Date("2026-11-18T02:00:00Z");

  /** Every business_setup row, every column, in business order. */
  async function setupRows(): Promise<unknown[]> {
    return [...(await db.sql`select * from business_setup order by business_id`)];
  }

  /** What a run of the set from before T-1462 left: its rows, and no business_setup row (it wrote none). */
  async function asBeforeT1462(): Promise<void> {
    await db.sql`delete from business_setup`;
    expect(await setupRows()).toEqual([]);
  }

  /** The control state limit 1's default 14 reads (DL-961 (d)) of a business whose control is not proven. */
  const notProven = (businessId: string): Record<string, unknown> => ({
    business_id: businessId,
    control_proven_at: null,
    control_proven_via: null,
  });

  /** readTurnParty's and the guard's answers for each roster phone, as the runtime reads them. */
  async function readsOf(owners: readonly { number: string; handleId: string }[]): Promise<unknown[]> {
    const answers: unknown[] = [];
    for (const { number, handleId } of owners) {
      answers.push({ party: await partyOf(runtime, number), guard: await guardRead(runtime, handleId) });
    }
    return answers;
  }

  it(
    "a first run writes one row per roster entry, whatever its handle (none yet; made at first sight, its chat opened; one with no person): its business_id alone, after its businesses row (the foreign key is checked at once), so control_proven_at and control_proven_via are null and it holds no contact value; the runtime side (rosie_job, no scope) reads each, and the Tool API (rosie_app) under a roster business's scope its own alone",
    SLOW,
    async () => {
      const sight = await firstSight(runtime, PHONE_B, "setup-first-run");
      await openChat(runtime, sight.handleId, "setup-first-run");
      await db.sql`insert into handles (id, kind, address) values ('handle-t1462-no-person', 'phone', ${PHONE_C})`;
      const first = await seedRosterOwner(db.sql, { env: listOf(PHONE_A, PHONE_B, PHONE_C) });
      const businessIds = [1, 2, 3].map((place) => rosterOwnerIds(place).businessId);
      expect(first.owners.map((owner) => owner.businessId)).toEqual(businessIds);
      expect(first.tables.business_setup).toEqual({ rows: 3, inserted: 3, kept: 0 });
      expect(await setupRows()).toEqual(businessIds.map((businessId) => setupRowOf(businessId)));

      expect([
        ...(await runtime`
          select business_id, control_proven_at, control_proven_via from business_setup order by business_id
        `),
      ]).toEqual(businessIds.map((businessId) => notProven(businessId)));
      for (const businessId of businessIds) {
        const seen = await withBusiness(db.sql, businessId, async (tx) => {
          await tx`set local role rosie_app`;
          return [
            ...(await tx`select business_id, control_proven_at, control_proven_via from business_setup`),
          ];
        });
        expect(seen, businessId).toEqual([notProven(businessId)]);
      }
    },
  );

  it(
    "a re-run over a set seeded before T-1462 (its rows, no business_setup row) adds each business's row, control not proven, and keeps every other row as it was, version included; a refused run before it adds none; readTurnParty and the guard answer as before; a third run writes nothing",
    SLOW,
    async () => {
      const sight = await firstSight(runtime, PHONE_B, "setup-before");
      const env = listOf(PHONE_A, PHONE_B);
      await seedRosterOwner(db.sql, { env });
      await asBeforeT1462();
      const owners = [
        { number: PHONE_A, handleId: rosterOwnerIds(1).handleId, personId: rosterOwnerIds(1).personId },
        { number: PHONE_B, handleId: sight.handleId, personId: sight.personId },
      ];
      const readsBefore = await readsOf(owners);
      expect(readsBefore).toEqual(
        owners.map(({ handleId, personId }, index) => ({
          party: atBusiness(handleId, personId, rosterOwnerIds(index + 1).businessId),
          guard: firstTextAnswer(handleId, personId),
        })),
      );
      const before = await snapshot(db.sql);

      // A refusal adds no row: the list's order changed since the set ran, so each place's company is the other's.
      await expectRefused(db.sql, listOf(PHONE_B, PHONE_A), [
        "entry 1's person owns a company already",
        "entry 2's person owns a company already",
      ]);

      const again = await seedRosterOwner(db.sql, { env });
      expect(again.tables).toEqual(countsOf(2, { business_setup: 2 }));
      expect(await snapshot(db.sql)).toEqual({
        ...before,
        business_setup: [1, 2].map((place) => setupRowOf(rosterOwnerIds(place).businessId)),
      });
      expect(await readsOf(owners)).toEqual(readsBefore);

      const after = await snapshot(db.sql);
      expect((await seedRosterOwner(db.sql, { env })).tables).toEqual(countsOf(2, {}));
      expect(await snapshot(db.sql)).toEqual(after);
    },
  );

  it(
    "a row already there is kept as it is and counted as kept, never updated, reset or deleted, a proven one included (S1-75: the listing's code came back right, or Rosie's team checked); a business that lacks its row gets it; a second run writes nothing",
    SLOW,
    async () => {
      const env = listOf(PHONE_A, PHONE_B, PHONE_C);
      await seedRosterOwner(db.sql, { env });
      const byCode = rosterOwnerIds(1).businessId;
      const byTeam = rosterOwnerIds(2).businessId;
      const missing = rosterOwnerIds(3).businessId;
      await db.sql`
        update business_setup
        set control_proven_at = ${CODE_CAME_BACK_AT}, control_proven_via = 'listing_code', version = version + 1
        where business_id = ${byCode}
      `;
      await db.sql`
        update business_setup
        set control_proven_at = ${TEAM_CHECKED_AT}, control_proven_via = 'team_check', version = version + 1
        where business_id = ${byTeam}
      `;
      await db.sql`delete from business_setup where business_id = ${missing}`;
      const proven = [
        {
          ...setupRowOf(byCode),
          control_proven_at: CODE_CAME_BACK_AT,
          control_proven_via: "listing_code",
          version: 2,
        },
        {
          ...setupRowOf(byTeam),
          control_proven_at: TEAM_CHECKED_AT,
          control_proven_via: "team_check",
          version: 2,
        },
      ];
      expect(await setupRows()).toEqual(proven);
      const before = await snapshot(db.sql);

      const run = await seedRosterOwner(db.sql, { env });
      expect(run.tables).toEqual(countsOf(3, { business_setup: 1 }));
      expect(run.tables.business_setup).toEqual({ rows: 3, inserted: 1, kept: 2 });
      expect(await snapshot(db.sql)).toEqual({ ...before, business_setup: [...proven, setupRowOf(missing)] });

      const after = await snapshot(db.sql);
      expect((await seedRosterOwner(db.sql, { env })).tables).toEqual(countsOf(3, {}));
      expect(await snapshot(db.sql)).toEqual(after);
    },
  );

  it(
    "in the set's one transaction: a refusal after the writes (the recheck: another person holds a live owner role at the roster business, so readTurnParty would not answer atBusiness) rolls the row back with every other write, so nothing is written; once that role has ended, the same run writes it",
    SLOW,
    async () => {
      const env = listOf(PHONE_A);
      await seedRosterOwner(db.sql, { env });
      await asBeforeT1462();
      const { businessId } = rosterOwnerIds(1);
      await db.sql`insert into persons (id) values ('person-t1462-other-owner')`;
      await db.sql`
        insert into person_roles (id, person_id, business_id, role)
        values ('role-t1462-other-owner', 'person-t1462-other-owner', ${businessId}, 'owner')
      `;
      await expectRefused(db.sql, env, [
        "a roster phone's JOIN would not be a first text under its own business: entry 1's business has a live owner role",
      ]);

      await db.sql`
        update person_roles set ended_at = ${ROLE_ENDED_AT}, version = version + 1 where id = 'role-t1462-other-owner'
      `;
      const before = await snapshot(db.sql);
      const run = await seedRosterOwner(db.sql, { env });
      expect(run.tables).toEqual(countsOf(1, { business_setup: 1 }));
      expect(await snapshot(db.sql)).toEqual({ ...before, business_setup: [setupRowOf(businessId)] });
    },
  );
});
