// T-1517: the staging-only reset of a roster phone (db/seeds/roster-reset.ts), against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/seeds/roster-reset`). Each block migrates a fresh test schema of its own
// (db/repo/test-db.ts) and drops it at the end; the shared public schema is never touched.
//
// The card's proofs (Gives 3), on the user's phone's state as DL-1032 left it: a roster phone made a test owner by the
// roster-owner set (T-1450) after its first sight and its first text's receipt (the gateway's own handleSealingKey and
// openChatOnText), whose turn 1 asked S1-02 and whose turn 2 answered it with one kind ("Plumbing": one listed pick with
// no company, and one of its text blocks) and opened S1-04's question with its armed clock. The reset withdraws that
// question and cancels its clock, gives the phone a fresh stand-in business head, and moves the handle's link to it;
// afterwards the roster-owner set's checks hold for the fresh head's ids (one person, no role, its company alone, no live
// owner, a first text), so K-05's readTurnParty answers atBusiness with the fresh business, handleTargets a first text
// and readPickedKinds no pick on file, each read as the runtime reads it (a client of this file's own whose connections
// run as rosie_job with no business scope): the next turn's frontier starts at S1-01. Every old row is still there, the
// question and clock closed, the pick and its text block with the old person, the turns, the phone row and the key as
// they were. A second run, with nothing live, changes nothing and says so. A handle off the list, with its own live
// question and clock, is never touched; a place with nothing live is never touched; each refusal writes nothing for any
// place; no number is in any answer, error or line the runner prints.
//
// The rows are built from the K-04 seed fixtures and the K-09 commit fixture the roster-owner set's own test uses
// (seed-bundle-registry.json, commit-s1-01.json), the skeleton seed's rows (T-1148) and made-up ids. Every number here is
// a whole literal in the fiction range 555-0100 to 555-0199 (rule 9), and the wrapping key the first sight wraps its key
// under is made at random in the run, never written down.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openChatOnText } from "../repo/chat-open";
import { resolvePrimaryUrl } from "../repo/client";
import { handleSealingKey } from "../repo/handle-keys";
import { readPickedKinds } from "../repo/kinds-reads";
import { stopPhone } from "../repo/phones";
import type { Sql } from "../repo/scope";
import { handleTargets, type HandleTargetsResponse } from "../repo/targets";
import { createTestDatabase, type TestDatabase } from "../repo/test-db";
import { readTurnParty } from "../repo/turn-party";
import { ALLOWLIST_VARIABLE, rosterOwnerIds, RosterOwnerSeedError, seedRosterOwner } from "./roster-owner";
import {
  MAX_GENERATION,
  rosterResetIds,
  RosterResetSeedError,
  seed,
  seedRosterReset,
  type RosterResetSeedResult,
} from "./roster-reset";
import { SKELETON_ROWS } from "./skeleton";

const SLOW = { timeout: 120_000 };
const RUNTIME_ROLE = "rosie_job";
const ZONE = "America/New_York";
const REPO = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const RUNNER = path.join(REPO, "db/seeds/run.mjs");
const CONTRACTS = new URL("../../contracts/", import.meta.url);
// The roster phones of these tests, and one phone off the list: whole literals in the fiction range, none a test phone's
// fixed fake handle.
const PHONE_A = "+15555550160";
const PHONE_B = "+15555550161";
const PHONE_C = "+15555550162";
const OFF_LIST = "+15555550169";
const SEED_TABLES = [
  "businesses",
  "business_setup",
  "persons",
  "companies",
  "company_kinds",
  "person_handles",
] as const;
// Every table the reset reads or writes, and every table whose rows decide a phone's targets, party and picks.
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
  "turns",
  "open_questions",
  "clock_rows",
  "kinds",
  "picked_kinds",
  "picked_kind_texts",
] as const;
// The wrapping key a first sight wraps its new key under: made here at random, for this run alone.
const WRAP_NAME = "SEALING_WRAP_KEY";
const wrappingKey = new Uint8Array(randomBytes(32));
const KEYS = {
  resolve: (name: string): Uint8Array | undefined => (name === WRAP_NAME ? wrappingKey : undefined),
};

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface CommitExchange {
  request: { turn: { eventIds: string[]; bundleId: { hash: string; build: number }; traceId: string } };
  outcome: { committedAt: string };
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(new URL(file, CONTRACTS), "utf8"));
const FIRST_TEXT = readJson("data-access/fixtures/targets-first-text.json") as {
  given: { now: string };
  outcome: HandleTargetsResponse;
};
const TURN_1_COMMIT = readJson("tool-api/fixtures/commit-s1-01.json") as CommitExchange;
const BUNDLE = TURN_1_COMMIT.request.turn.bundleId;

/** The bundle row K-04's seed-bundle-registry.json holds for commit-s1-01.json's bundle. */
function bundleRow(): Record<string, Json> {
  const rows = (
    readJson("db-schema/core/fixtures/seed-bundle-registry.json") as {
      rows: { table: string; values: Record<string, Json> }[];
    }
  ).rows.filter(
    (row) => row.table === "bundles" && row.values.hash === BUNDLE.hash && row.values.build === BUNDLE.build,
  );
  expect(rows).toHaveLength(1);
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
      application_name: "rosie-t1517-roster-reset",
      search_path: `${db.schema}, public`,
      role: RUNTIME_ROLE,
    },
  });
}

/** The gateway's first sight of a number (handleSealingKey), then its first text's receipt (openChatOnText). */
async function firstText(
  runtime: Sql,
  address: string,
  tag: string,
): Promise<{ handleId: string; personId: string }> {
  const sight = await handleSealingKey(runtime, KEYS, {
    handle: { kind: "phone", address },
    newHandleId: `handle-rr-${tag}`,
    newPersonId: `person-rr-${tag}`,
    wrappingKeyName: WRAP_NAME,
  });
  if (!("result" in sight.outcome)) {
    throw new Error("the first sight made no key");
  }
  const opened = await openChatOnText(runtime, {
    eventId: `evt-rr-${tag}`,
    handleId: sight.outcome.handleId,
    service: "imessage",
    receivedAt: "2026-11-18T00:02:00Z",
    traceId: `trace-rr-${tag}`,
  });
  if (!("result" in opened) || opened.result !== "inserted") {
    throw new Error("the first text's receipt inserted no phone row");
  }
  return { handleId: sight.outcome.handleId, personId: sight.outcome.personId };
}

/** The ids of one sign-up's rows, all made up and the test's own. */
interface SignUp {
  readonly turn1: string;
  readonly turn2: string;
  readonly askedS102: string;
  readonly askedS104: string;
  readonly clock: string;
  readonly pick: string;
}

const signUpIds = (tag: string): SignUp => ({
  turn1: `turn-rr-${tag}-1`,
  turn2: `turn-rr-${tag}-2`,
  askedS102: `oq-rr-${tag}-s1-02`,
  askedS104: `oq-rr-${tag}-s1-04`,
  clock: `clock-rr-${tag}-s1-04`,
  pick: `pick-rr-${tag}-plumbing`,
});

/** The bundle the turns ran under, and the catalog's plumbing kind, once per schema. */
async function sharedRows(sql: Sql): Promise<void> {
  await sql`insert into bundles ${sql(bundleRow() as Record<string, never>)} on conflict do nothing`;
  await sql`
    insert into kinds (id, name, style, pattern, source)
    values ('plumbing', 'Plumbing', 'trade', 'fix', 'trade_file') on conflict do nothing
  `;
}

/**
 * The user's phone as DL-1032 left it, under `businessId` and `personId`: turn 1 asked S1-02 (answered by turn 2), turn 2
 * saved one plumbing pick with no company and one of its text blocks, and asked S1-04, whose clock armed at delivery.
 */
async function signUpToS104(
  sql: Sql,
  ids: SignUp,
  handleId: string,
  personId: string,
  businessId: string,
): Promise<void> {
  const { turn } = TURN_1_COMMIT.request;
  await sharedRows(sql);
  await sql.begin(async (tx) => {
    for (const [id, at] of [
      [ids.turn1, TURN_1_COMMIT.outcome.committedAt],
      [ids.turn2, "2026-11-20T22:15:13Z"],
    ] as const) {
      await tx`
        insert into turns (id, handle_id, event_ids, state, bundle_hash, bundle_build, trace_id, committed_at)
        values (${id}, ${handleId}, ${[`evt-${id}`]}, 'committed', ${BUNDLE.hash}, ${BUNDLE.build}, ${turn.traceId},
                ${at})
      `;
    }
    await tx`
      insert into open_questions (id, turn_id, handle_id, person_id, business_id, step, options, versions_read,
                                  bundle_hash, bundle_build, status, closed_at)
      values (${ids.askedS102}, ${ids.turn1}, ${handleId}, ${personId}, ${businessId}, 'S1-02', '[]', '[]',
              ${BUNDLE.hash}, ${BUNDLE.build}, 'answered', '2026-11-20T22:15:13Z')
    `;
    await tx`
      insert into picked_kinds (id, owner_person_id, position, words, outcome, kind_id, picked_at)
      values (${ids.pick}, ${personId}, 1, 'Plumbing', 'listed', 'plumbing', '2026-11-20T22:15:13Z')
    `;
    await tx`
      insert into picked_kind_texts (picked_kind_id, pf_key, block) values (${ids.pick}, 'pf.license', '"none"')
    `;
    await tx`
      insert into open_questions (id, turn_id, handle_id, person_id, business_id, step, options, versions_read,
                                  bundle_hash, bundle_build, status)
      values (${ids.askedS104}, ${ids.turn2}, ${handleId}, ${personId}, ${businessId}, 'S1-04', '[]', '[]',
              ${BUNDLE.hash}, ${BUNDLE.build}, 'open')
    `;
    await tx`
      insert into clock_rows (id, kind, open_question_id, handle_id, business_id, due_at, due_zone, state, armed_at,
                              fires, created_by_turn_id)
      values (${ids.clock}, 'question', ${ids.askedS104}, ${handleId}, ${businessId}, '2026-11-22T01:00:00Z', ${ZONE},
              'armed', '2026-11-20T22:15:34Z', '{}', ${ids.turn2})
    `;
  });
}

/** The guard's read of a handle, at targets-first-text.json's moment. */
function guardRead(runtime: Sql, handleId: string): ReturnType<typeof handleTargets> {
  return handleTargets(runtime, { handleId }, { now: new Date(FIRST_TEXT.given.now) });
}

/** targets-first-text.json's answer for a handle whose one person is `personId`, with the chat its first text opened. */
function firstTextAnswer(handleId: string, personId: string): HandleTargetsResponse {
  const { outcome } = FIRST_TEXT;
  expect(outcome.persons).toHaveLength(1);
  return {
    ...outcome,
    handleId,
    persons: outcome.persons.map((person) => ({ ...person, personId })),
    phone: { stopped: false, chatOpen: true, version: 1 },
  };
}

/** readTurnParty for a number, as the handle actor's turn reads it. */
function partyOf(runtime: Sql, address: string): ReturnType<typeof readTurnParty> {
  return readTurnParty(runtime, { handle: { kind: "phone", address } });
}

/** Every row of the watched tables, in key order. */
async function snapshot(sql: Sql): Promise<Record<string, unknown[]>> {
  const rows: Record<string, unknown[]> = {};
  for (const table of WATCHED) {
    rows[table] = [...(await sql`select * from ${sql(table)} order by 1, 2`)];
  }
  return rows;
}

/** A snapshot with the given rows of a table left out, by their first column. */
function without(state: Record<string, unknown[]>, leave: Record<string, readonly string[]>) {
  return Object.fromEntries(
    Object.entries(state).map(([table, rows]) => [
      table,
      rows.filter((row) => !(leave[table] ?? []).includes(Object.values(row as object)[0] as string)),
    ]),
  );
}

/** The counts of a run that reset `resets` places. */
function countsOf(resets: number) {
  return Object.fromEntries(SEED_TABLES.map((table) => [table, { rows: resets, inserted: resets, kept: 0 }]));
}

/** No number of these tests, nor any part of one, is in a text: no 555 and no run of four digits. */
function expectNoNumber(text: string, what: string): void {
  expect(text, what).not.toMatch(/555|[0-9]{4}/);
}

/** An answer of the set, with its ids, which hold no number, read as one text. */
function expectNoNumberIn(result: RosterResetSeedResult): void {
  expectNoNumber(JSON.stringify(result), "the answer");
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

/** The set refuses `env`'s list, naming each of `reasons` and no number, and leaves every watched row as it was. */
async function expectRefused(
  sql: Sql,
  env: Record<string, string>,
  reasons: readonly string[],
): Promise<void> {
  const before = await snapshot(sql);
  const error = await refusal(seedRosterReset(sql, { env }));
  expect(error).toBeInstanceOf(RosterResetSeedError);
  expect(error.message).toMatch(/^the roster reset seed refused, writing nothing: /);
  for (const reason of reasons) {
    expect(error.message).toContain(reason);
  }
  expectNoNumber(error.message, "the refusal");
  expect(await snapshot(sql)).toEqual(before);
}

/** Empties every table of this file's schema (truncating the heads cascades to the rest). */
async function emptied(sql: Sql): Promise<void> {
  await sql`truncate businesses, persons, handles, bundles, kinds cascade`;
}

/** The fresh head's rows, every column the set writes, as roster-owner writes them for its own ids. */
function freshRows(place: number, generation: number, handleId: string): Record<string, unknown[]> {
  const ids = rosterResetIds(place, generation);
  const [business] = SKELETON_ROWS.businesses;
  const [company] = SKELETON_ROWS.companies;
  const [kind] = SKELETON_ROWS.company_kinds;
  return {
    businesses: [{ ...business, id: ids.businessId }],
    business_setup: [{ business_id: ids.businessId, control_proven_at: null, no_money: false, version: 1 }],
    persons: [{ id: ids.personId, name: null, language: null, version: 1 }],
    companies: [
      { ...company, id: ids.companyId, owner_person_id: ids.personId, business_id: ids.businessId },
    ],
    company_kinds: [{ ...kind, company_id: ids.companyId, business_id: ids.businessId }],
    person_handles: [{ person_id: ids.personId, handle_id: handleId }],
  };
}

/** The same rows as the database holds them. */
async function rowsOf(sql: Sql, place: number, generation: number, handleId: string) {
  const ids = rosterResetIds(place, generation);
  return {
    businesses: [
      ...(await sql`
        select id, name, display_name, status, time_zone, to_char(text_hours_start, 'HH24:MI') as text_hours_start,
               to_char(text_hours_end, 'HH24:MI') as text_hours_end, version
        from businesses where id = ${ids.businessId}
      `),
    ],
    business_setup: [
      ...(await sql`
        select business_id, control_proven_at, no_money, version from business_setup
        where business_id = ${ids.businessId}
      `),
    ],
    persons: [...(await sql`select id, name, language, version from persons where id = ${ids.personId}`)],
    companies: [
      ...(await sql`
        select id, owner_person_id, name, business_id, version from companies where owner_person_id = ${ids.personId}
      `),
    ],
    company_kinds: [
      ...(await sql`
        select company_id, kind_id, business_id, trade_name, pf_facts, pf_switches_a, pf_switches_b, version
        from company_kinds where business_id = ${ids.businessId}
      `),
    ],
    person_handles: [
      ...(await sql`select person_id, handle_id from person_handles where handle_id = ${handleId}`),
    ],
  };
}

/** A question's and a clock's closing columns, as stored. */
async function closing(sql: Sql, ids: SignUp) {
  const [question] = await sql<
    { status: string; closed: boolean; answered: string | null; version: number }[]
  >`
    select status, closed_at is not null as closed, answered_option_id as answered, version
    from open_questions where id = ${ids.askedS104}
  `;
  const [clock] = await sql<{ state: string; cancelled: boolean; fired: boolean; version: number }[]>`
    select state, cancelled_at is not null as cancelled, fired_at is not null as fired, version
    from clock_rows where id = ${ids.clock}
  `;
  return { question, clock };
}

describe("a roster phone with an open S1-04 question and a pick", () => {
  let db: TestDatabase;
  let runtime: Sql;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_roster_reset" });
    runtime = runtimeClient(db);
  }, 120_000);

  afterAll(async () => {
    await runtime.end({ timeout: 5 });
    await db.drop();
  });

  beforeEach(async () => {
    await emptied(db.sql);
  });

  /** The user's phone at place 1 after DL-1032, and a phone off the list with its own live question and clock. */
  async function world(): Promise<{ handleId: string; personId: string; ids: SignUp; offList: SignUp }> {
    const phone = await firstText(runtime, PHONE_A, "a");
    await seedRosterOwner(db.sql, { env: listOf(PHONE_A) });
    const ids = signUpIds("a");
    await signUpToS104(db.sql, ids, phone.handleId, phone.personId, rosterOwnerIds(1).businessId);
    const other = await firstText(runtime, OFF_LIST, "off");
    await db.sql`
      insert into businesses (id, name, display_name, time_zone)
      values ('biz-t1517-off-list', 'Other Shop', 'Other Shop', ${ZONE})
    `;
    const offList = signUpIds("off");
    await signUpToS104(db.sql, offList, other.handleId, other.personId, "biz-t1517-off-list");
    return { ...phone, ids, offList };
  }

  it("is the set T-201's runner finds by its file name: `seed` is this seed", () => {
    expect(seed).toBe(seedRosterReset);
  });

  it("names each generation's ids from roster-owner's, never from a number: generation 1 is roster-owner's own", () => {
    expect(rosterResetIds(1, 1)).toEqual({
      businessId: rosterOwnerIds(1).businessId,
      companyId: rosterOwnerIds(1).companyId,
      personId: rosterOwnerIds(1).personId,
    });
    expect(rosterResetIds(3, 2)).toEqual({
      businessId: "biz-roster-owner-3-g2",
      companyId: "company-roster-owner-3-g2",
      personId: "person-roster-owner-3-g2",
    });
    for (const generation of [0, -1, 1.5, MAX_GENERATION + 1]) {
      expect(() => rosterResetIds(1, generation), String(generation)).toThrow(RangeError);
    }
  });

  it(
    "is reset: S1-04's question withdrawn and its clock cancelled, a fresh head written and the handle's link moved to it, as rosie_job; roster-owner's checks hold for the fresh head (readTurnParty atBusiness, handleTargets a first text, no pick on file), so the next turn starts at S1-01; every old row is still there, closed; the phone off the list is untouched; a second run changes nothing and says so",
    SLOW,
    async () => {
      const { handleId, personId, ids, offList } = await world();
      const old = rosterOwnerIds(1);
      // Today's state on staging: the phone's turns run under its roster business, its S1-04 question live.
      expect(await partyOf(runtime, PHONE_A)).toMatchObject({
        handleId,
        personId,
        businessId: old.businessId,
      });
      const live = await guardRead(runtime, handleId);
      expect("openQuestions" in live && live.openQuestions.map((question) => question.id)).toEqual([
        ids.askedS104,
      ]);
      const before = await snapshot(db.sql);

      const first = await seedRosterReset(db.sql, { env: listOf(PHONE_A) });
      const fresh = rosterResetIds(1, 2);
      expect(first).toEqual({
        ranAs: RUNTIME_ROLE,
        tables: countsOf(1),
        closed: { open_questions: 1, clock_rows: 1, person_handles: 1 },
        places: [
          {
            place: 1,
            outcome: "reset",
            handleId,
            from: { businessId: old.businessId, companyId: old.companyId, personId, generation: 1 },
            to: { ...fresh, generation: 2 },
            withdrawn: [ids.askedS104],
            cancelled: [ids.clock],
          },
        ],
      });
      expectNoNumberIn(first);

      // Closed, never deleted: withdrawn (never answered or defaulted) and cancelled (never fired), each version raised.
      expect(await closing(db.sql, ids)).toEqual({
        question: { status: "withdrawn", closed: true, answered: null, version: 2 },
        clock: { state: "cancelled", cancelled: true, fired: false, version: 2 },
      });
      // The fresh head, as roster-owner writes its rows for its own ids.
      expect(await rowsOf(db.sql, 1, 2, handleId)).toEqual(freshRows(1, 2, handleId));
      // Every other row as it was: the old head, the old person with its pick, text block and key, the turns, S1-02's
      // answered question, the phone row and the handle; the one link removed is the old person's to the handle.
      const after = await snapshot(db.sql);
      const changed = {
        open_questions: [ids.askedS104],
        clock_rows: [ids.clock],
        businesses: [fresh.businessId],
        business_setup: [fresh.businessId],
        persons: [fresh.personId],
        companies: [fresh.companyId],
        company_kinds: [fresh.companyId],
        person_handles: [personId, fresh.personId],
      };
      expect(without(after, changed)).toEqual(without(before, changed));
      const [kept] = await db.sql<
        { pick: string; texts: number; owner: string; s102: string; keys: number; links: number }[]
      >`
        select p.owner_person_id as owner, p.id as pick,
               (select count(*)::int from picked_kind_texts where picked_kind_id = p.id) as texts,
               (select status from open_questions where id = ${ids.askedS102}) as s102,
               (select count(*)::int from sealing_keys where person_id = ${personId}) as keys,
               (select count(*)::int from person_handles where person_id = ${personId}) as links
        from picked_kinds p where p.id = ${ids.pick}
      `;
      expect(kept).toEqual({
        pick: ids.pick,
        texts: 1,
        owner: personId,
        s102: "answered",
        keys: 1,
        links: 0,
      });
      // The phone off the list: its live question and armed clock as they were.
      expect(await closing(db.sql, offList)).toEqual({
        question: { status: "open", closed: false, answered: null, version: 1 },
        clock: { state: "armed", cancelled: false, fired: false, version: 1 },
      });

      // roster-owner's checks, for the fresh head's ids, as the runtime reads them: the turn runs under the fresh
      // business with the fresh person, in the barbershop's zone; the guard finds a first text (the doors); no pick and
      // only the fresh company are on file for the next S1-02.
      expect(await partyOf(runtime, PHONE_A)).toEqual({
        handleId,
        businessId: fresh.businessId,
        personId: fresh.personId,
        zone: ZONE,
      });
      expect(await guardRead(runtime, handleId)).toEqual(firstTextAnswer(handleId, fresh.personId));
      const onFile = await readPickedKinds(runtime, {
        businessId: fresh.businessId,
        personId: fresh.personId,
      });
      expect(onFile).toMatchObject({ result: "pickedKinds", picks: [] });
      expect("companies" in onFile && onFile.companies.map((company) => company.id)).toEqual([
        fresh.companyId,
      ]);
      // The old sign-up reads as it ended: the old person's plumbing pick, on file for the old person alone.
      const history = await readPickedKinds(runtime, { businessId: old.businessId, personId });
      expect("picks" in history && history.picks.map((pick) => pick.id)).toEqual([ids.pick]);

      // A second run: nothing live, so nothing written, and it says so.
      const settled = await snapshot(db.sql);
      const second = await seedRosterReset(db.sql, { env: listOf(PHONE_A) });
      expect(second).toEqual({
        ranAs: RUNTIME_ROLE,
        tables: countsOf(0),
        closed: { open_questions: 0, clock_rows: 0, person_handles: 0 },
        places: [{ place: 1, outcome: "nothingLive", handleId }],
      });
      expect(await snapshot(db.sql)).toEqual(settled);
    },
  );

  it(
    "a reset phone that signs up again and holds a live question once more is reset to the next generation, generation 3, from the fresh head",
    SLOW,
    async () => {
      const { handleId } = await world();
      await seedRosterReset(db.sql, { env: listOf(PHONE_A) });
      const second = rosterResetIds(1, 2);
      const again = signUpIds("a-again");
      await signUpToS104(db.sql, again, handleId, second.personId, second.businessId);

      const result = await seedRosterReset(db.sql, { env: listOf(PHONE_A) });
      const third = rosterResetIds(1, 3);
      expect(result.places).toEqual([
        {
          place: 1,
          outcome: "reset",
          handleId,
          from: { ...second, generation: 2 },
          to: { ...third, generation: 3 },
          withdrawn: [again.askedS104],
          cancelled: [again.clock],
        },
      ]);
      expect(await rowsOf(db.sql, 1, 3, handleId)).toEqual(freshRows(1, 3, handleId));
      expect(await partyOf(runtime, PHONE_A)).toEqual({
        handleId,
        businessId: third.businessId,
        personId: third.personId,
        zone: ZONE,
      });
      expect(await guardRead(runtime, handleId)).toEqual(firstTextAnswer(handleId, third.personId));
    },
  );

  it(
    "places with nothing live are never touched: a number no handle holds yet, and a test owner with no live question; only the place with something live is reset",
    SLOW,
    async () => {
      const b = await firstText(runtime, PHONE_B, "b");
      const a = await firstText(runtime, PHONE_A, "a");
      await seedRosterOwner(db.sql, { env: listOf(PHONE_C, PHONE_B, PHONE_A) });
      const ids = signUpIds("a");
      await signUpToS104(db.sql, ids, a.handleId, a.personId, rosterOwnerIds(3).businessId);
      const before = await snapshot(db.sql);

      const result = await seedRosterReset(db.sql, { env: listOf(PHONE_C, PHONE_B, PHONE_A) });
      expect(result.tables).toEqual(countsOf(1));
      expect(result.places.map((place) => [place.place, place.outcome, place.handleId])).toEqual([
        [1, "nothingLive", rosterOwnerIds(1).handleId],
        [2, "nothingLive", b.handleId],
        [3, "reset", a.handleId],
      ]);
      const fresh = rosterResetIds(3, 2);
      const changed = {
        open_questions: [ids.askedS104],
        clock_rows: [ids.clock],
        businesses: [fresh.businessId],
        business_setup: [fresh.businessId],
        persons: [fresh.personId],
        companies: [fresh.companyId],
        company_kinds: [fresh.companyId],
        person_handles: [a.personId, fresh.personId],
      };
      expect(without(await snapshot(db.sql), changed)).toEqual(without(before, changed));
      expect(await partyOf(runtime, PHONE_B)).toMatchObject({ businessId: rosterOwnerIds(2).businessId });
      expect(await partyOf(runtime, PHONE_C)).toMatchObject({ businessId: rosterOwnerIds(1).businessId });
    },
  );

  it(
    "the runner (T-201) finds the set by its name, reads the list by name and prints the fresh head's counts alone, never a number; a second run prints none written; an ill-formed list exits 1 with nothing written and no part of it shown",
    SLOW,
    async () => {
      await world();
      const local = { DATABASE_URL: resolvePrimaryUrl(), DB_SCHEMA: db.schema };
      const run = await runSeed({ ...local, ...listOf(PHONE_A, PHONE_B) });
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).toBe("");
      expect(lines(run.stdout)).toEqual([
        `seed: set roster-reset into schema ${db.schema} on the local database`,
        ...SEED_TABLES.map((table) => `seed: ${table}: 1 row (1 inserted, 0 kept)`),
        `seed: done: set roster-reset into schema ${db.schema}: 6 rows in 6 tables (6 inserted, 0 kept)`,
      ]);
      expectNoNumber(`${run.stdout}${run.stderr}`.replaceAll(db.schema, ""), "the runner's output");

      const settled = await snapshot(db.sql);
      const again = await runSeed({ ...local, ...listOf(PHONE_A, PHONE_B) });
      expect(again.code, again.stderr).toBe(0);
      expect(lines(again.stdout)).toEqual([
        `seed: set roster-reset into schema ${db.schema} on the local database`,
        ...SEED_TABLES.map((table) => `seed: ${table}: 0 rows (0 inserted, 0 kept)`),
        `seed: done: set roster-reset into schema ${db.schema}: 0 rows in 6 tables (0 inserted, 0 kept)`,
      ]);
      expect(await snapshot(db.sql)).toEqual(settled);

      const refused = await runSeed({ ...local, [ALLOWLIST_VARIABLE]: `${PHONE_A}, ${PHONE_C}` });
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe(`seed: set roster-reset into schema ${db.schema} on the local database\n`);
      expect(lines(refused.stderr)).toEqual([
        "seed: failed: the roster owner seed refused, writing nothing: STAGING_LINQ_ALLOWLIST entry 2 of 2 is not " +
          "an E.164 number (+, then 7 to 15 digits, joined by commas with no space) (no part of its value is shown)",
      ]);
      expectNoNumber(`${refused.stdout}${refused.stderr}`.replaceAll(db.schema, ""), "the refusal's output");
      expect(await snapshot(db.sql)).toEqual(settled);
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

/** Runs `node db/seeds/run.mjs --set roster-reset` with this environment's variables, less the child's own, plus `env`. */
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
      [RUNNER, "--set", "roster-reset"],
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

describe("never past what is the phone's own sign-up: the set refuses, writing nothing for any place", () => {
  let db: TestDatabase;
  let runtime: Sql;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_roster_reset_refusals" });
    runtime = runtimeClient(db);
  }, 120_000);

  afterAll(async () => {
    await runtime.end({ timeout: 5 });
    await db.drop();
  });

  beforeEach(async () => {
    await emptied(db.sql);
  });

  /** Places 1 and 2 test owners, place 2 at S1-04 as the user's phone is; its handle and person. */
  async function twoOwners(): Promise<{ handleId: string; personId: string; ids: SignUp }> {
    await firstText(runtime, PHONE_A, "a");
    const b = await firstText(runtime, PHONE_B, "b");
    await seedRosterOwner(db.sql, { env: listOf(PHONE_A, PHONE_B) });
    const ids = signUpIds("b");
    await signUpToS104(db.sql, ids, b.handleId, b.personId, rosterOwnerIds(2).businessId);
    return { ...b, ids };
  }

  /** A business no roster phone's rows name. */
  async function otherBusiness(): Promise<string> {
    await db.sql`
      insert into businesses (id, name, display_name, time_zone)
      values ('biz-t1517-other', 'Other Shop', 'Other Shop', ${ZONE})
    `;
    return "biz-t1517-other";
  }

  it("an ill-formed list, before anything is read or written: roster-owner's own words", SLOW, async () => {
    await twoOwners();
    for (const value of ["", `${PHONE_A}, ${PHONE_B}`, `${PHONE_B};${PHONE_A}`, `${PHONE_B},${PHONE_B}`]) {
      const before = await snapshot(db.sql);
      const error = await refusal(seedRosterReset(db.sql, { env: { [ALLOWLIST_VARIABLE]: value } }));
      expect(error, value).toBeInstanceOf(RosterOwnerSeedError);
      expect(error.message, value).toContain("(no part of its value is shown)");
      expectNoNumber(error.message, value);
      expect(await snapshot(db.sql)).toEqual(before);
    }
    await expect(seedRosterReset(db.sql, { env: {} })).rejects.toThrow(
      "STAGING_LINQ_ALLOWLIST is not set, or is empty",
    );
  });

  it("a stopped phone: a recorded STOP is never reset", SLOW, async () => {
    await twoOwners();
    const stop = await stopPhone(db.sql, PHONE_B, 1, new Date("2026-11-20T23:00:00Z"));
    expect(stop.ok).toBe(true);
    await expectRefused(db.sql, listOf(PHONE_A, PHONE_B), [
      "entry 2's phone is stopped, and a recorded STOP is never reset",
    ]);
  });

  it("a booking the person made or is served by", SLOW, async () => {
    const { personId } = await twoOwners();
    const business = await otherBusiness();
    await db.sql`
      insert into bookings (id, business_id, flow, stage, booker_person_id, served_person_id)
      values ('booking-t1517', ${business}, 'A', 'booked', ${personId}, ${personId})
    `;
    await expectRefused(db.sql, listOf(PHONE_A, PHONE_B), ["entry 2's handle has 1 booking"]);
  });

  it("a role, live or ended, and a company other than its place's newest", SLOW, async () => {
    const { personId } = await twoOwners();
    const business = await otherBusiness();
    await db.sql`
      insert into person_roles (id, person_id, business_id, role, ended_at)
      values ('role-t1517-ended', ${personId}, ${business}, 'customer', '2026-10-01T00:00:00Z')
    `;
    await expectRefused(db.sql, listOf(PHONE_A, PHONE_B), ["entry 2's person holds 1 role, live or ended"]);
    await db.sql`delete from person_roles where id = 'role-t1517-ended'`;
    await db.sql`
      insert into companies (id, owner_person_id, name, business_id)
      values ('company-t1517-own', ${personId}, 'Own Shop LLC', null)
    `;
    await expectRefused(db.sql, listOf(PHONE_A, PHONE_B), [
      "entry 2's person does not own its place's newest company alone",
    ]);
  });

  it("a live question or clock of another business", SLOW, async () => {
    const { ids } = await twoOwners();
    const business = await otherBusiness();
    await db.sql`update open_questions set business_id = ${business}, version = version + 1 where id = ${ids.askedS104}`;
    await db.sql`update clock_rows set business_id = ${business}, version = version + 1 where id = ${ids.clock}`;
    await expectRefused(db.sql, listOf(PHONE_A, PHONE_B), [
      "entry 2's handle has 1 live open question of another business",
      "entry 2's handle has 1 live clock of another business or handle",
    ]);
  });

  it("two people on the handle", SLOW, async () => {
    const { handleId } = await twoOwners();
    await db.sql`insert into persons (id) values ('person-t1517-other')`;
    await db.sql`insert into person_handles (person_id, handle_id) values ('person-t1517-other', ${handleId})`;
    await expectRefused(db.sql, listOf(PHONE_A, PHONE_B), ["entry 2's handle has 2 people, not one"]);
  });

  it("an id of the next generation held already", SLOW, async () => {
    await twoOwners();
    await db.sql`insert into persons (id) values (${rosterResetIds(2, 2).personId})`;
    await expectRefused(db.sql, listOf(PHONE_A, PHONE_B), [
      "an id of entry 2's next generation is held already",
    ]);
  });

  it(
    "a live question on a phone roster-owner never made a test owner: its roster business does not exist yet",
    SLOW,
    async () => {
      const a = await firstText(runtime, PHONE_A, "a");
      const business = await otherBusiness();
      await signUpToS104(db.sql, signUpIds("a"), a.handleId, a.personId, business);
      await expectRefused(db.sql, listOf(PHONE_A), ["entry 1's roster business does not exist yet"]);
    },
  );
});
