// T-1148: test owner 1's seed for D-017 (db/seeds/skeleton.ts), against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/seeds/skeleton`). Each block that needs a database migrates a fresh test schema of its
// own (db/repo/test-db.ts) and drops it at the end; the shared public schema is never touched.
//
// The card's proofs: after the seed, K-05's handleTargets for tp-01's handle answers as targets-first-text.json does (no
// role, no open question, no booking, no phone row), and the business head exists; the seed runs twice with no change.
// handleTargets runs as the guard runs it: on the runtime side, through a client of this file's own whose connections
// run as rosie_job with no business scope (T-191; K-05 v1.2 README line 153). The tables' owner (the migrations' role)
// reads every row and writes the state a refusal starts from.
//
// What the rows must be is read here from the frozen fixtures themselves (node:fs), never through the seed: K-04 v1
// seed-business-head.json and seed-person-roles.json, K-21 v1 test-roster.json (tp-01), K-02 v1.1 context-s1-01.json
// (turn 1's writer) and K-05 v1.2 targets-first-text.json (the guard's answer); for the refusals, K-04's
// seed-bundle-registry.json and seed-phone-chat-open.json and K-09 v1.5's commit-s1-01.json (what turn 1's commit
// leaves). No value is a real person's: the master's sample cast and the fictional 555-01xx numbers only (rule 9).
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "../repo/client";
import type { Sql } from "../repo/scope";
import { handleTargets, type HandleTargetsResponse } from "../repo/targets";
import { createTestDatabase, type TestDatabase } from "../repo/test-db";
import { seedCore } from "./core";
import { seed, seedSkeleton, SKELETON_ROWS, SkeletonSeedError, TEST_OWNER_1 } from "./skeleton";

const SLOW = { timeout: 120_000 };
const RUNTIME_ROLE = "rosie_job";
const CONTRACTS = new URL("../../contracts/", import.meta.url);
// The fiction range: 555-0100 to 555-0199 in an area code, as E.164.
const FICTIONAL = /^\+1[2-9][0-9]{2}55501[0-9]{2}$/;
const SKELETON_TABLES = ["businesses", "persons", "handles", "person_handles"] as const;
// Every table whose rows decide tp-01's targets, the rows the seed writes, and a key it never writes.
const WATCHED = [
  "businesses",
  "persons",
  "person_roles",
  "handles",
  "person_handles",
  "phones",
  "sealing_keys",
  "bookings",
  "bundles",
  "turns",
  "open_questions",
] as const;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Values = Record<string, Json>;

interface SeedFile {
  after: string[];
  rows: { table: string; values: Values }[];
}

interface RosterPhone {
  testPhoneId: string;
  last4: string;
  role: string;
  label: string;
  businessId: string | null;
  personId: string | null;
}

interface WriterPerson {
  personId: string;
  name: string;
  roles: unknown[];
  language: string | null;
}

interface TargetsExchange {
  given: { now: string };
  request: { handleId: string };
  outcome: HandleTargetsResponse;
}

interface CommitExchange {
  request: {
    turn: {
      id: string;
      handleId: string;
      eventIds: string[];
      bundleId: { hash: string; build: number };
      traceId: string;
      joinedTraceIds: string[];
      tries: number;
    };
  };
  given: {
    stated: {
      writes: {
        openQuestions: {
          id: string;
          handleId: string;
          personId: string | null;
          businessId: string | null;
          bookingId: string | null;
          step: string;
          options: Json[];
          readback: string | null;
          versionsRead: Json[];
          clock: string | null;
        }[];
      };
    };
  };
  outcome: { committedAt: string };
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, CONTRACTS), "utf8"));
const k04 = (file: string): SeedFile => readJson(`db-schema/core/fixtures/${file}`) as SeedFile;

/** One row of a K-04 seed fixture: the one of `table` whose values match `where`. */
function k04Row(file: string, table: string, where: Values): Values {
  const rows = k04(file).rows.filter(
    (row) =>
      row.table === table && Object.entries(where).every(([column, value]) => row.values[column] === value),
  );
  expect(rows, `${file}: one ${table} row`).toHaveLength(1);
  return rows[0]?.values ?? {};
}

/** A K-04 seed fixture's rows with its `after` chain first, each fixture once, in order. */
function k04Chain(file: string, seen = new Set<string>()): SeedFile["rows"] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const fixture = k04(file);
  return [...fixture.after.flatMap((before) => k04Chain(before, seen)), ...fixture.rows];
}

/** A text value of a fixture row, refused when it is anything else. */
function textOf(values: Values, column: string): string {
  const value = values[column];
  if (typeof value !== "string") {
    throw new Error(`${column} is not text in the fixture`);
  }
  return value;
}

const ROSTER = readJson("page-api/fixtures/test-roster.json") as { outcome: { phones: RosterPhone[] } };
const TP_01 = ROSTER.outcome.phones.find((phone) => phone.testPhoneId === "tp-01");
const TURN_1_WRITER = (
  readJson("model/fixtures/context-s1-01.json") as { writer: { handle: string; people: WriterPerson[] } }
).writer;
const FIRST_TEXT = readJson("data-access/fixtures/targets-first-text.json") as TargetsExchange;
const TURN_1_COMMIT = readJson("tool-api/fixtures/commit-s1-01.json") as CommitExchange;

/**
 * targets-first-text.json's answer, for tp-01's handle: the fixture's new number made a handle and a person at first
 * sight; here they are test owner 1's, and every other part of the answer is the fixture's own.
 */
function firstTextAnswer(): HandleTargetsResponse {
  const { outcome, request } = FIRST_TEXT;
  expect(outcome.handleId).toBe(request.handleId);
  expect(outcome.persons).toHaveLength(1);
  return {
    ...outcome,
    handleId: TEST_OWNER_1.handleId,
    persons: outcome.persons.map((person) => ({ ...person, personId: TEST_OWNER_1.personId })),
  };
}

/** Connections that run as rosie_job, the guard's role, with `schema` first and no business scope. */
function runtimeClient(schema: string): Sql {
  return postgres(resolvePrimaryUrl(), {
    max: 2,
    onnotice: () => undefined,
    connection: {
      application_name: "rosie-t1148-skeleton",
      search_path: `${schema}, public`,
      role: RUNTIME_ROLE,
    },
  });
}

/** The guard's read of tp-01's handle, at targets-first-text.json's moment. */
function guardRead(runtime: Sql): ReturnType<typeof handleTargets> {
  return handleTargets(runtime, { handleId: TEST_OWNER_1.handleId }, { now: new Date(FIRST_TEXT.given.now) });
}

/** The skeleton tables' rows, in key order, with the text hours in the fixtures' form (08:00). */
async function skeletonRows(sql: Sql): Promise<Record<string, unknown[]>> {
  return {
    businesses: [
      ...(await sql`
        select id, name, display_name, status, time_zone, to_char(text_hours_start, 'HH24:MI') as text_hours_start,
               to_char(text_hours_end, 'HH24:MI') as text_hours_end, version
        from businesses order by id
      `),
    ],
    persons: [...(await sql`select id, name, language from persons order by id`)],
    handles: [...(await sql`select id, kind, address from handles order by id`)],
    person_handles: [
      ...(await sql`select person_id, handle_id from person_handles order by person_id, handle_id`),
    ],
  };
}

/** Every row of the watched tables, in key order. */
async function snapshot(sql: Sql): Promise<Record<string, unknown[]>> {
  const rows: Record<string, unknown[]> = {};
  for (const table of WATCHED) {
    rows[table] = [...(await sql`select * from ${sql(table)} order by 1, 2`)];
  }
  return rows;
}

/** The rows of `files` (each with its `after` chain), written as the tables' owner in one transaction. */
async function loadK04(sql: Sql, files: readonly string[]): Promise<void> {
  const seen = new Set<string>();
  const rows = files.flatMap((file) => k04Chain(file, seen));
  await sql.begin(async (tx) => {
    for (const row of rows) {
      await tx`insert into ${tx(row.table)} ${tx(row.values as Record<string, never>)}`;
    }
  });
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

/** The seed refuses, naming `reason` and no value of a row, and leaves every watched row as it was. */
async function expectRefused(sql: Sql, reason: string): Promise<void> {
  const before = await snapshot(sql);
  const error = await refusal(seedSkeleton(sql));
  expect(error).toBeInstanceOf(SkeletonSeedError);
  expect(error.message).toContain(reason);
  expect(error.message).not.toMatch(/555|Sam|Lee/);
  expect(await snapshot(sql)).toEqual(before);
}

describe("the rows: test owner 1 as the frozen fixtures give him", () => {
  it("tp-01 on K-21 test-roster.json is test owner 1: the owner's phone of Lee's Barbershop, held by Sam", () => {
    expect(TP_01).toMatchObject({
      testPhoneId: TEST_OWNER_1.testPhoneId,
      label: "Test owner 1",
      role: "owner",
      businessId: TEST_OWNER_1.businessId,
      personId: TEST_OWNER_1.personId,
    });
  });

  it("the business head is K-04 seed-business-head.json's row for tp-01's business, value for value", () => {
    expect(SKELETON_ROWS.businesses).toEqual([
      k04Row("seed-business-head.json", "businesses", { id: TEST_OWNER_1.businessId }),
    ]);
  });

  it("the handle is K-04 seed-person-roles.json's handle-sam, at tp-01's number, and the number turn 1's writer texts from", () => {
    const handle = k04Row("seed-person-roles.json", "handles", { id: TEST_OWNER_1.handleId });
    const address = textOf(handle, "address");
    expect(SKELETON_ROWS.handles).toEqual([handle]);
    expect(address.slice(-4)).toBe(TP_01?.last4);
    expect(address).toBe(TURN_1_WRITER.handle);
    expect(address).toMatch(FICTIONAL);
    expect(SKELETON_ROWS.person_handles).toEqual([
      k04Row("seed-person-roles.json", "person_handles", {
        person_id: TEST_OWNER_1.personId,
        handle_id: TEST_OWNER_1.handleId,
      }),
    ]);
  });

  it("the person is Sam as K-04 and turn 1's context name him, with no language stored yet (K-02 v1.1 default 11), and no role", () => {
    const person = k04Row("seed-person-roles.json", "persons", { id: TEST_OWNER_1.personId });
    expect(TURN_1_WRITER.people).toEqual([
      { personId: TEST_OWNER_1.personId, name: person.name, roles: [], language: null },
    ]);
    expect(SKELETON_ROWS.persons).toEqual([{ id: TEST_OWNER_1.personId, name: person.name, language: null }]);
    // seed-person-roles.json gives Sam three owner roles: the reason this set exists. It holds no roles table at all.
    expect(Object.keys(SKELETON_ROWS).sort()).toEqual([...SKELETON_TABLES].sort());
  });
});

describe("the skeleton seed on a fresh schema", () => {
  let db: TestDatabase;
  let runtime: Sql;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_skeleton" });
    runtime = runtimeClient(db.schema);
  }, 120_000);

  afterAll(async () => {
    await runtime.end({ timeout: 5 });
    await db.drop();
  });

  it("is the set T-201's runner finds by its file name: `seed` is this seed", () => {
    expect(seed).toBe(seedSkeleton);
  });

  it(
    "writes its four rows and nothing else, as the job role, rosie_job, with no business scope",
    SLOW,
    async () => {
      const first = await seedSkeleton(db.sql);
      expect(first).toEqual({
        ranAs: RUNTIME_ROLE,
        tables: {
          businesses: { rows: 1, inserted: 1, kept: 0 },
          persons: { rows: 1, inserted: 1, kept: 0 },
          handles: { rows: 1, inserted: 1, kept: 0 },
          person_handles: { rows: 1, inserted: 1, kept: 0 },
        },
        testOwner: TEST_OWNER_1,
      });
      expect(await skeletonRows(db.sql)).toEqual(SKELETON_ROWS);
      const counts = await db.sql<
        { roles: number; phones: number; keys: number; questions: number; bookings: number }[]
      >`
      select (select count(*)::int from person_roles) as roles, (select count(*)::int from phones) as phones,
             (select count(*)::int from sealing_keys) as keys, (select count(*)::int from open_questions) as questions,
             (select count(*)::int from bookings) as bookings
    `;
      expect(counts).toEqual([{ roles: 0, phones: 0, keys: 0, questions: 0, bookings: 0 }]);
    },
  );

  it("K-05 handleTargets for tp-01's handle answers as targets-first-text.json does: no role, no open question, no booking, no phone row", async () => {
    const answer = await guardRead(runtime);
    expect(answer).toEqual(firstTextAnswer());
    expect(answer).toMatchObject({
      persons: [{ personId: TEST_OWNER_1.personId, roles: [] }],
      openQuestions: [],
      bookings: [],
      phone: null,
    });
  });

  it("the business head the turn runs under exists, as K-04 seed-business-head.json gives it", async () => {
    const rows = await skeletonRows(db.sql);
    expect(rows.businesses).toEqual([
      k04Row("seed-business-head.json", "businesses", { id: TEST_OWNER_1.businessId }),
    ]);
  });

  it(
    "runs twice with no change: the second run writes nothing, every row stays as it was, version included, and JOIN is still a first text",
    SLOW,
    async () => {
      const before = await snapshot(db.sql);
      const second = await seedSkeleton(db.sql);
      expect(second.ranAs).toBe(RUNTIME_ROLE);
      for (const table of SKELETON_TABLES) {
        expect(second.tables[table], table).toEqual({ rows: 1, inserted: 0, kept: 1 });
      }
      expect(await snapshot(db.sql)).toEqual(before);
      expect(await guardRead(runtime)).toEqual(firstTextAnswer());
    },
  );

  it(
    "writes a row that went missing again, as the first run wrote it, and changes nothing else",
    SLOW,
    async () => {
      const before = await snapshot(db.sql);
      await db.sql`delete from person_handles where handle_id = ${TEST_OWNER_1.handleId}`;
      const third = await seedSkeleton(db.sql);
      expect(third.tables).toEqual({
        businesses: { rows: 1, inserted: 0, kept: 1 },
        persons: { rows: 1, inserted: 0, kept: 1 },
        handles: { rows: 1, inserted: 0, kept: 1 },
        person_handles: { rows: 1, inserted: 1, kept: 0 },
      });
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );
});

describe("D-017's order: the core set (T-200), then this seed", () => {
  let db: TestDatabase;
  let runtime: Sql;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_skeleton_core" });
    runtime = runtimeClient(db.schema);
  }, 120_000);

  afterAll(async () => {
    await runtime.end({ timeout: 5 });
    await db.drop();
  });

  it(
    "both load, sharing no id or number, and tp-01's JOIN is still a first text; a second run of both writes nothing",
    SLOW,
    async () => {
      const core = await seedCore(db.sql);
      const skeleton = await seedSkeleton(db.sql);
      for (const table of SKELETON_TABLES) {
        expect(skeleton.tables[table], table).toEqual({ rows: 1, inserted: 1, kept: 0 });
      }
      const ours = new Set<string>([
        ...Object.values(TEST_OWNER_1),
        ...SKELETON_ROWS.handles.map((h) => h.address),
      ]);
      for (const shop of core.shops) {
        const keys = [shop.businessId, shop.personId, shop.roleId, shop.handleId, shop.phoneNumber];
        expect(
          keys.filter((key) => ours.has(key)),
          shop.shopId,
        ).toEqual([]);
      }
      const [counts] = await db.sql<{ businesses: number; persons: number; roles: number; phones: number }[]>`
        select (select count(*)::int from businesses) as businesses, (select count(*)::int from persons) as persons,
               (select count(*)::int from person_roles) as roles, (select count(*)::int from phones) as phones
      `;
      expect(counts).toEqual({ businesses: 246, persons: 246, roles: 245, phones: 245 });
      expect(await guardRead(runtime)).toEqual(firstTextAnswer());

      const before = await snapshot(db.sql);
      const coreAgain = await seedCore(db.sql);
      const skeletonAgain = await seedSkeleton(db.sql);
      expect(coreAgain.tables.businesses).toEqual({ rows: 245, inserted: 0, kept: 245 });
      for (const table of SKELETON_TABLES) {
        expect(skeletonAgain.tables[table], table).toEqual({ rows: 1, inserted: 0, kept: 1 });
      }
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );
});

describe("never on top of a state where tp-01's JOIN is not a first text: the seed refuses and writes nothing", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_skeleton_refusals" });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    // Empties every table (truncating the heads cascades to the rest; this file's schema only).
    await db.sql`truncate businesses, persons, handles, bundles, release_flags cascade`;
  });

  it("on top of K-04's seed-person-roles.json, which gives Sam three owner roles", SLOW, async () => {
    await loadK04(db.sql, ["seed-person-roles.json"]);
    await expectRefused(db.sql, "3 live roles");
  });

  it(
    "with a live role for Sam, such as the customer role T-202 plans for each test phone; a role that ended is no target",
    SLOW,
    async () => {
      await seedSkeleton(db.sql);
      await db.sql`
        insert into person_roles (id, person_id, business_id, role, ended_at)
        values ('role-sam-barber-ended', ${TEST_OWNER_1.personId}, ${TEST_OWNER_1.businessId}, 'customer',
                '2026-10-01T00:00:00Z')
      `;
      await expect(seedSkeleton(db.sql)).resolves.toMatchObject({ ranAs: RUNTIME_ROLE });
      await db.sql`
        insert into person_roles (id, person_id, business_id, role)
        values ('role-sam-barber-customer', ${TEST_OWNER_1.personId}, ${TEST_OWNER_1.businessId}, 'customer')
      `;
      await expectRefused(db.sql, "1 live role");
    },
  );

  it(
    "once turn 1 has committed: S1-02's open question to Sam (K-09 v1.5 commit-s1-01.json) waits for his answer",
    SLOW,
    async () => {
      await seedSkeleton(db.sql);
      const { turn } = TURN_1_COMMIT.request;
      const [question, ...others] = TURN_1_COMMIT.given.stated.writes.openQuestions;
      if (question === undefined) {
        throw new Error("commit-s1-01.json states no open question");
      }
      expect(others).toEqual([]);
      expect([turn.handleId, question.handleId, question.personId]).toEqual([
        TEST_OWNER_1.handleId,
        TEST_OWNER_1.handleId,
        TEST_OWNER_1.personId,
      ]);
      const bundle = k04Row("seed-bundle-registry.json", "bundles", {
        hash: turn.bundleId.hash,
        build: turn.bundleId.build,
      });
      await db.sql.begin(async (tx) => {
        await tx`insert into bundles ${tx(bundle as Record<string, never>)}`;
        await tx`
        insert into turns (id, handle_id, event_ids, state, bundle_hash, bundle_build, trace_id, joined_trace_ids,
                           tries, committed_at)
        values (${turn.id}, ${turn.handleId}, ${turn.eventIds}, 'committed', ${turn.bundleId.hash},
                ${turn.bundleId.build}, ${turn.traceId}, ${turn.joinedTraceIds}, ${turn.tries},
                ${TURN_1_COMMIT.outcome.committedAt})
      `;
        await tx`
        insert into open_questions (id, turn_id, handle_id, person_id, business_id, booking_id, step, options,
                                    readback, versions_read, bundle_hash, bundle_build, clock)
        values (${question.id}, ${turn.id}, ${question.handleId}, ${question.personId}, ${question.businessId},
                ${question.bookingId}, ${question.step}, ${tx.json(question.options)}, ${question.readback},
                ${tx.json(question.versionsRead)}, ${turn.bundleId.hash}, ${turn.bundleId.build},
                ${question.clock})
      `;
      });
      await expectRefused(db.sql, "1 live open question");
    },
  );

  it("with a phone row for tp-01's number (K-04 seed-phone-chat-open.json's)", SLOW, async () => {
    await seedSkeleton(db.sql);
    const phone = k04Row("seed-phone-chat-open.json", "phones", { handle_id: TEST_OWNER_1.handleId });
    await db.sql`insert into phones ${db.sql(phone as Record<string, never>)}`;
    await expectRefused(db.sql, "a phone row");
  });

  it("with a booking Sam made or is served by", SLOW, async () => {
    await seedSkeleton(db.sql);
    await db.sql`
      insert into bookings (id, business_id, flow, stage, booker_person_id, served_person_id)
      values ('booking-sam-haircut', ${TEST_OWNER_1.businessId}, 'A', 'booked', ${TEST_OWNER_1.personId},
              ${TEST_OWNER_1.personId})
    `;
    await expectRefused(db.sql, "1 booking");
  });

  it("with a second person writing from Sam's handle", SLOW, async () => {
    await seedSkeleton(db.sql);
    await db.sql`insert into persons (id) values ('person-other')`;
    await db.sql`insert into person_handles (person_id, handle_id) values ('person-other', ${TEST_OWNER_1.handleId})`;
    await expectRefused(db.sql, "2 people, not test owner 1 alone");
  });

  it(
    "when another handle holds tp-01's number, or test owner 1's handle holds another number",
    SLOW,
    async () => {
      const [handle] = SKELETON_ROWS.handles;
      if (handle === undefined) {
        throw new Error("the skeleton seed has no handle row");
      }
      await db.sql`insert into handles (id, kind, address) values ('handle-other', 'phone', ${handle.address})`;
      await expectRefused(db.sql, "another handle holds tp-01's number");

      await db.sql`truncate businesses, persons, handles, bundles, release_flags cascade`;
      await db.sql`insert into handles (id, kind, address) values (${TEST_OWNER_1.handleId}, 'phone', '+15555550199')`;
      await expectRefused(db.sql, "test owner 1's handle holds another number");
    },
  );
});
