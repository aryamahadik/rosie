// T-187: reservations and class seats against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/reservations`). The schema comes from migrating a fresh test schema.
import { readFileSync } from "node:fs";
import net from "node:net";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createResource } from "./bookings-head";
import { createClient, resolvePrimaryUrl } from "./client";
import { DataAccessDatabaseError } from "./clocks";
import {
  createClassSeats,
  getClassSeats,
  getReservation,
  holdMinutesFor,
  release,
  releaseIn,
  reserve,
  reserveIn,
  type ReleaseOutcome,
  type ReserveOutcome,
  type ReserveRequest,
} from "./reservations";
import { SCOPE_SETTING, withBusiness, type Sql } from "./scope";
import { type TransientError, transientOrThrow } from "./targets";
import { createTestDatabase, type TestDatabase } from "./test-db";

const CORE_DIR = new URL("../../contracts/db-schema/core/", import.meta.url);
const ACCESS_DIR = new URL("../../contracts/data-access/fixtures/", import.meta.url);
const OWN_TABLES = ["class_seats", "reservations"] as const;
const HEAVY = { timeout: 120_000 };

interface FixtureFile {
  after: string[];
  rows: { table: string; values: Record<string, string | number | boolean | null> }[];
  refused?: {
    action: "insert" | "update";
    table: string;
    values?: Record<string, string | number | boolean | null>;
    set?: Record<string, string | number | boolean | null>;
    where?: Record<string, string | number>;
    expect: { sqlstate: string; constraintOneOf?: string[] };
  };
}

interface AccessFixture {
  call: "reserve" | "release";
  given: { k04Seeds: string[]; after: string[]; now: string };
  request: ReserveRequest | Parameters<typeof release>[1];
  outcome: unknown;
}

interface ContractTable {
  name: string;
  columns: { name: string; type: string; null: boolean; default?: string }[];
  primaryKey?: string[];
  checks?: { name: string }[];
  foreignKeys?: { name: string }[];
  exclude?: { name: string; elements: { column: string; operator: string }[]; where: string }[];
  indexes?: { name: string; columns: string[]; where?: string }[];
  versioned: boolean;
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));

/** The rows of a fixture and of the fixtures it names in `after`, in load order. */
function fixtureRows(file: string, seen = new Set<string>()): FixtureFile["rows"] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const fixture = readJson(new URL(`fixtures/${file}`, CORE_DIR)) as FixtureFile;
  return [...fixture.after.flatMap((before) => fixtureRows(before, seen)), ...fixture.rows];
}

async function loadFixture(sql: Sql, file: string): Promise<void> {
  const present = await sql<{ name: string }[]>`
    select table_name as name from information_schema.tables where table_schema = current_schema()
  `;
  const tables = new Set(present.map((row) => row.name));
  for (const row of fixtureRows(file)) {
    if (tables.has(row.table)) {
      await sql`insert into ${sql(row.table)} ${sql(row.values)}`;
    }
  }
}

async function emptyTables(sql: Sql): Promise<void> {
  await sql`truncate reservations, class_seats, messages, openers_sent, threads, bookings, resources, pauses, phones, person_handles, handles, person_roles, sealing_keys, persons, businesses cascade`;
}

/** What the database says about a failed statement: its SQLSTATE and the constraint it names. */
async function refusal(
  promise: Promise<unknown>,
): Promise<{ code: string | undefined; constraint: string | undefined }> {
  try {
    await promise;
  } catch (error) {
    const failure = error as { code?: string; constraint_name?: string };
    return { code: failure.code, constraint: failure.constraint_name };
  }
  throw new Error("the statement was accepted; the database should have refused it");
}

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase({ name: "reservations", client: { max: 20 } });
}, 60_000);

afterAll(async () => {
  await db.drop();
});

/** A request for the lee's-barbershop worker Riley unless said otherwise. */
function request(overrides: Partial<ReserveRequest> & { reservationId: string }): ReserveRequest {
  return {
    businessId: "biz-lees-barbershop",
    resourceId: "res-riley",
    during: { start: "2026-12-01T16:00:00Z", end: "2026-12-01T16:30:00Z" },
    seats: 1,
    for: { agentToken: `token-${overrides.reservationId}` },
    door: "standard",
    holdMinutes: null,
    waitIfSaved: false,
    at: "2026-11-07T15:05:00Z",
    ...overrides,
  };
}

const outcomeOf = (outcome: ReserveOutcome | ReleaseOutcome): string =>
  "result" in outcome ? outcome.result : outcome.error;

function tally(outcomes: (ReserveOutcome | ReleaseOutcome)[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) {
    counts[outcomeOf(outcome)] = (counts[outcomeOf(outcome)] ?? 0) + 1;
  }
  return counts;
}

describe("the migration against the frozen table list (K-04 v1 core)", () => {
  const typeNames: Record<string, string> = {
    text: "text",
    integer: "int4",
    boolean: "bool",
    timestamptz: "timestamptz",
    tstzrange: "tstzrange",
  };
  const tables = (
    readJson(new URL("core.v1.tables.json", CORE_DIR)) as { tables: ContractTable[] }
  ).tables.filter((table) => (OWN_TABLES as readonly string[]).includes(table.name));

  it("covers exactly the two tables of the card", () => {
    expect(tables.map((table) => table.name).sort()).toEqual(["class_seats", "reservations"]);
  });

  for (const table of tables) {
    it(`${table.name}: columns, types, nulls and defaults are the table list's`, async () => {
      const found = await db.sql<{ name: string; type: string; nullable: string; default: string | null }[]>`
        select column_name as name, udt_name as type, is_nullable as nullable, column_default as default
        from information_schema.columns
        where table_schema = ${db.schema} and table_name = ${table.name}
        order by ordinal_position
      `;
      expect(found.map((column) => column.name)).toEqual(table.columns.map((column) => column.name));
      for (const column of table.columns) {
        const actual = found.find((candidate) => candidate.name === column.name);
        expect(actual?.type, `${table.name}.${column.name} type`).toBe(typeNames[column.type]);
        expect(actual?.nullable === "YES", `${table.name}.${column.name} null`).toBe(column.null);
        if (column.default === undefined) {
          expect(actual?.default, `${table.name}.${column.name} default`).toBeNull();
        } else {
          expect((actual?.default ?? "").replace(/::.*$/, ""), `${table.name}.${column.name} default`).toBe(
            column.default,
          );
        }
      }
    });

    it(`${table.name}: primary key, checks, foreign keys, EXCLUDE rules and indexes are the table list's`, async () => {
      const constraints = await db.sql<{ name: string; kind: string; definition: string }[]>`
        select conname as name, contype as kind, pg_get_constraintdef(oid) as definition
        from pg_constraint where conrelid = ${`${db.schema}.${table.name}`}::regclass
      `;
      const pk = constraints.find((constraint) => constraint.kind === "p");
      expect(pk?.definition).toBe(`PRIMARY KEY (${(table.primaryKey ?? []).join(", ")})`);
      const named = (kind: string): string[] =>
        constraints
          .filter((constraint) => constraint.kind === kind)
          .map((constraint) => constraint.name)
          .sort();
      expect(named("c")).toEqual((table.checks ?? []).map((check) => check.name).sort());
      expect(named("f")).toEqual((table.foreignKeys ?? []).map((key) => key.name).sort());
      expect(named("x")).toEqual((table.exclude ?? []).map((rule) => rule.name).sort());
      expect(named("u")).toEqual([]);
      for (const rule of table.exclude ?? []) {
        const definition = constraints.find((constraint) => constraint.name === rule.name)?.definition ?? "";
        const elements = rule.elements
          .map((element) => `${element.column} WITH ${element.operator}`)
          .join(", ");
        expect(definition, rule.name).toContain(`EXCLUDE USING gist (${elements})`);
      }

      const indexes = await db.sql<{ name: string; definition: string }[]>`
        select indexname as name, indexdef as definition from pg_indexes
        where schemaname = ${db.schema} and tablename = ${table.name}
      `;
      const expected = [
        `${table.name}_pkey`,
        ...(table.exclude ?? []).map((rule) => rule.name),
        ...(table.indexes ?? []).map((index) => index.name),
      ].sort();
      expect(indexes.map((index) => index.name).sort()).toEqual(expected);
      for (const wanted of table.indexes ?? []) {
        const index = indexes.find((candidate) => candidate.name === wanted.name);
        expect(index?.definition).toContain(`(${wanted.columns.join(", ")})`);
        expect(index?.definition.includes("WHERE"), wanted.name).toBe(wanted.where !== undefined);
      }
    });

    it(`${table.name}: foreign keys refuse deletes, and the version trigger exists exactly when versioned`, async () => {
      const keysFound = await db.sql<{ name: string; definition: string }[]>`
        select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint where conrelid = ${`${db.schema}.${table.name}`}::regclass and contype = 'f'
      `;
      for (const key of keysFound) {
        expect(key.definition, key.name).toContain("ON DELETE RESTRICT");
      }
      const triggers = await db.sql<{ name: string }[]>`
        select tgname as name from pg_trigger
        where tgrelid = ${`${db.schema}.${table.name}`}::regclass and not tgisinternal
      `;
      expect(triggers.map((trigger) => trigger.name)).toEqual(
        table.versioned ? [`${table.name}_version_raised`] : [],
      );
    });
  }

  it("the two EXCLUDE rules cover held and booked time only, and the composite keys use 0007's unique keys", async () => {
    const rows = await db.sql<{ name: string; definition: string }[]>`
      select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = ${`${db.schema}.reservations`}::regclass and contype in ('x', 'f')
    `;
    const byName = new Map(rows.map((row) => [row.name, row.definition]));
    expect(byName.get("reservations_no_overlap_per_resource")).toContain(
      "state = ANY (ARRAY['held'::text, 'booked'::text])",
    );
    expect(byName.get("reservations_no_overlap_per_resource")).toContain(
      "'worker'::text, 'room'::text, 'vehicle'::text",
    );
    expect(byName.get("reservations_no_overlap_per_worker")).toContain("worker_person_id IS NOT NULL");
    expect(byName.get("reservations_resource_kind_fk")).toContain("REFERENCES resources(id, kind)");
    expect(byName.get("reservations_worker_person_fk")).toContain("REFERENCES resources(id, person_id)");
    expect(byName.get("reservations_phone_fk")).toContain("REFERENCES phones(number)");
    expect(byName.get("reservations_booking_fk")).toContain("REFERENCES bookings(id)");
  });

  it("is expand only: plain tables, each with row-level security per business (T-191)", async () => {
    const rows = await db.sql<{ name: string; kind: string; rls: boolean }[]>`
      select c.relname as name, c.relkind as kind, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${db.schema} and c.relname in ('class_seats', 'reservations')
      order by c.relname
    `;
    expect(rows.map((row) => [row.name, row.kind, row.rls])).toEqual([
      ["class_seats", "r", true],
      ["reservations", "r", true],
    ]);
  });

  it("is recorded in schema_migrations", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    expect(rows.map((row) => row.name)).toContain("core_reservations");
  });
});

describe("the database refuses a double booking by itself (a direct INSERT, not reserve())", () => {
  const riley = {
    business_id: "biz-lees-barbershop",
    resource_id: "res-riley",
    resource_kind: "worker",
    worker_person_id: "person-riley",
    state: "held",
    seats: 1,
    held_until: "2026-12-01T10:00:00Z",
    for_agent_token: "agent-direct",
  };

  it("two overlapping held reservations for one worker: the second is refused (EXCLUDE 23P01)", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    await db.sql`insert into reservations ${db.sql({ ...riley, id: "d-1", during: "[2026-12-01T16:00:00Z,2026-12-01T16:30:00Z)" })}`;
    expect(
      await refusal(
        db.sql`insert into reservations ${db.sql({ ...riley, id: "d-2", during: "[2026-12-01T16:15:00Z,2026-12-01T16:45:00Z)" })}`,
      ),
    ).toEqual({ code: "23P01", constraint: "reservations_no_overlap_per_resource" });
    // A booked row refuses the same way.
    expect(
      await refusal(
        db.sql`insert into reservations ${db.sql({ ...riley, id: "d-3", state: "booked", held_until: null, during: "[2026-12-01T16:29:00Z,2026-12-01T17:00:00Z)" })}`,
      ),
    ).toEqual({ code: "23P01", constraint: "reservations_no_overlap_per_resource" });
  });

  it("a room and a vehicle are refused the same way", async () => {
    for (const [resource, kind] of [
      ["res-studio-room", "room"],
      ["res-truck-20", "vehicle"],
    ] as const) {
      const business = resource === "res-studio-room" ? "biz-yoga-studio" : "biz-movers";
      const row = {
        ...riley,
        business_id: business,
        resource_id: resource,
        resource_kind: kind,
        worker_person_id: null,
      };
      await db.sql`insert into reservations ${db.sql({ ...row, id: `d-${kind}-1`, during: "[2026-12-02T10:00:00Z,2026-12-02T12:00:00Z)" })}`;
      expect(
        await refusal(
          db.sql`insert into reservations ${db.sql({ ...row, id: `d-${kind}-2`, during: "[2026-12-02T11:00:00Z,2026-12-02T13:00:00Z)" })}`,
        ),
      ).toEqual({ code: "23P01", constraint: "reservations_no_overlap_per_resource" });
    }
  });

  it("a worker who is staff at two businesses cannot be booked twice at once (per worker person)", async () => {
    await createResource(db.sql, {
      id: "res-riley-yoga",
      businessId: "biz-yoga-studio",
      kind: "worker",
      name: "Riley at yoga",
      personId: "person-riley",
    });
    expect(
      await refusal(
        db.sql`insert into reservations ${db.sql({
          ...riley,
          id: "d-w-2",
          business_id: "biz-yoga-studio",
          resource_id: "res-riley-yoga",
          during: "[2026-12-01T16:10:00Z,2026-12-01T16:20:00Z)",
        })}`,
      ),
    ).toEqual({ code: "23P01", constraint: "reservations_no_overlap_per_worker" });
  });

  it("touching times, other resources, waiting rows, released rows and class sessions are accepted", async () => {
    const at = (id: string, over: Record<string, unknown>): Promise<unknown> =>
      db.sql`insert into reservations ${db.sql({ ...riley, id, during: "[2026-12-01T16:00:00Z,2026-12-01T16:30:00Z)", ...over })}`;
    await at("ok-touch", { during: "[2026-12-01T16:30:00Z,2026-12-01T17:00:00Z)" });
    await at("ok-other", { resource_id: "res-avery", worker_person_id: "person-avery" });
    await at("ok-waiting", { state: "waiting", held_until: null });
    await at("ok-released", {
      state: "released",
      released_at: "2026-12-01T09:00:00Z",
      released_why: "let_go",
    });
    for (const id of ["ok-class-1", "ok-class-2"]) {
      await at(id, {
        business_id: "biz-yoga-studio",
        resource_id: "res-handstand-workshop",
        resource_kind: "class_session",
        worker_person_id: null,
      });
    }
    const n = await db.sql<{ n: number }[]>`select count(*)::int as n from reservations where id like 'ok-%'`;
    expect(n[0]?.n).toBe(6);
  });

  it("the table refuses rows that break its other rules", async () => {
    const base = { ...riley, during: "[2027-01-01T10:00:00Z,2027-01-01T11:00:00Z)" };
    const insert = (id: string, over: Record<string, unknown>): Promise<unknown> =>
      db.sql`insert into reservations ${db.sql({ ...base, id, ...over })}`;
    const rules: [string, Record<string, unknown>, string][] = [
      ["r-state", { state: "lost" }, "reservations_state_known"],
      ["r-kind", { resource_kind: "boat" }, "reservations_kind_known"],
      [
        "r-why",
        { state: "released", released_at: "2027-01-01T00:00:00Z", released_why: "bored" },
        "reservations_released_why_known",
      ],
      ["r-nokind", { worker_person_id: null }, "reservations_worker_person"],
      ["r-seats", { seats: 2 }, "reservations_seats"],
      ["r-empty", { during: "empty" }, "reservations_during_bounded"],
      ["r-open", { during: "[2027-01-01T10:00:00Z,)" }, "reservations_during_bounded"],
      ["r-noend", { held_until: null }, "reservations_held_has_end"],
      ["r-nowhy", { state: "released", held_until: null }, "reservations_released_has_why"],
      ["r-nobody", { for_agent_token: null }, "reservations_for_someone"],
    ];
    for (const [id, over, constraint] of rules) {
      expect(await refusal(insert(id, over)), id).toEqual({ code: "23514", constraint });
    }
    expect(await refusal(insert("r-biz", { business_id: "biz-none" }))).toEqual({
      code: "23503",
      constraint: "reservations_business_fk",
    });
    expect(await refusal(insert("r-res", { resource_id: "res-none" }))).toMatchObject({ code: "23503" });
    // The kind and the person are copies the resource must agree with.
    expect(await refusal(insert("r-wrongkind", { resource_kind: "room", worker_person_id: null }))).toEqual({
      code: "23503",
      constraint: "reservations_resource_kind_fk",
    });
    expect(await refusal(insert("r-wrongperson", { worker_person_id: "person-avery" }))).toEqual({
      code: "23503",
      constraint: "reservations_worker_person_fk",
    });
    expect(await refusal(insert("r-phone", { for_phone_number: "+15555559999" }))).toEqual({
      code: "23503",
      constraint: "reservations_phone_fk",
    });
    expect(await refusal(insert("r-booking", { booking_id: "booking-none" }))).toEqual({
      code: "23503",
      constraint: "reservations_booking_fk",
    });
    expect(await refusal(insert("d-1", {}))).toEqual({ code: "23505", constraint: "reservations_pkey" });
    expect(await refusal(db.sql`update reservations set seats = 1 where id = 'd-1'`)).toEqual({
      code: "23514",
      constraint: "reservations_version_raised",
    });
  });
});

describe("class seats never pass capacity (CHECK 23514)", () => {
  it("seed-class-seats loads as the fixture has it", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-class-seats.json");
    expect(await getClassSeats(db.sql, "res-handstand-workshop")).toEqual({
      resourceId: "res-handstand-workshop",
      businessId: "biz-yoga-studio",
      capacity: 10,
      taken: 2,
      version: 3,
    });
    expect((await getReservation(db.sql, "rsv-agent-workshop"))?.state).toBe("held");
    expect(await getClassSeats(db.sql, "none")).toBeNull();
  });

  it("the table refuses a counter past capacity, below zero, or on a resource that is not a class session", async () => {
    const taken = (n: number, version: number): Promise<unknown> =>
      db.sql`update class_seats set taken = ${n}, version = ${version} where resource_id = 'res-handstand-workshop'`;
    expect(await refusal(taken(11, 4))).toEqual({
      code: "23514",
      constraint: "class_seats_taken_within_capacity",
    });
    expect(await refusal(taken(-1, 4))).toEqual({
      code: "23514",
      constraint: "class_seats_taken_not_negative",
    });
    expect(
      await refusal(
        db.sql`update class_seats set capacity = 1, version = 4 where resource_id = 'res-handstand-workshop'`,
      ),
    ).toEqual({ code: "23514", constraint: "class_seats_taken_within_capacity" });
    expect(
      await refusal(db.sql`update class_seats set taken = 4 where resource_id = 'res-handstand-workshop'`),
    ).toEqual({
      code: "23514",
      constraint: "class_seats_version_raised",
    });
    await taken(10, 4);
    expect(
      await refusal(
        createClassSeats(db.sql, { resourceId: "res-riley", businessId: "biz-lees-barbershop", capacity: 3 }),
      ),
    ).toEqual({ code: "23503", constraint: "class_seats_resource_fk" });
    expect(
      await refusal(
        createClassSeats(db.sql, {
          resourceId: "res-handstand-workshop",
          businessId: "biz-yoga-studio",
          capacity: 3,
        }),
      ),
    ).toEqual({ code: "23505", constraint: "class_seats_pkey" });
    await createResource(db.sql, {
      id: "res-class-zero",
      businessId: "biz-yoga-studio",
      kind: "class_session",
      name: "Zero",
    });
    expect(
      await refusal(
        createClassSeats(db.sql, {
          resourceId: "res-class-zero",
          businessId: "biz-yoga-studio",
          capacity: 0,
        }),
      ),
    ).toEqual({ code: "23514", constraint: "class_seats_capacity_positive" });
  });
});

describe("the refused-row fixtures of K-04 are refused", () => {
  for (const file of ["refuse-overlapping-reservation.json", "refuse-seats-over-capacity.json"]) {
    it(`${file}: refused as its expect says, and the same row passes without its fault`, async () => {
      const fixture = readJson(new URL(`fixtures/invalid/${file}`, CORE_DIR)) as FixtureFile & {
        refused: NonNullable<FixtureFile["refused"]>;
      };
      const refused = fixture.refused;
      await emptyTables(db.sql);
      const afterFile = fixture.after[0];
      if (afterFile === undefined) {
        throw new Error("the fixture names no seed");
      }
      await loadFixture(db.sql, afterFile);
      const run = (patch: Record<string, string | number | boolean | null>): Promise<unknown> => {
        if (refused.action === "insert") {
          return db.sql`insert into ${db.sql(refused.table)} ${db.sql({ ...refused.values, ...patch })}`;
        }
        const where = refused.where ?? {};
        return db.sql`
          update ${db.sql(refused.table)} set ${db.sql({ ...refused.set, ...patch })}
          where resource_id = ${where.resource_id ?? null} and version = ${where.version ?? null}
        `;
      };
      const outcome = await refusal(run({}));
      expect(outcome.code).toBe(refused.expect.sqlstate);
      expect(refused.expect.constraintOneOf).toContain(outcome.constraint);
      // Without its one fault the same action passes.
      await run(
        refused.action === "insert"
          ? { during: "[2026-10-24T16:00:00Z,2026-10-24T16:30:00Z)" }
          : { taken: 10 },
      );
    });
  }
});

/** Runs a data-access fixture's chain (`after`) and then its own request, against a freshly seeded schema. */
async function runFixture(file: string): Promise<{ outcome: unknown; expected: unknown }> {
  const fixture = readJson(new URL(file, ACCESS_DIR)) as AccessFixture;
  const call = async (item: AccessFixture): Promise<unknown> =>
    item.call === "reserve"
      ? reserve(db.sql, item.request as ReserveRequest)
      : release(db.sql, item.request as Parameters<typeof release>[1]);
  await emptyTables(db.sql);
  for (const seed of fixture.given.k04Seeds) {
    await loadFixture(db.sql, seed);
  }
  for (const before of fixture.given.after) {
    const earlier = readJson(new URL(before, ACCESS_DIR)) as AccessFixture;
    await call(earlier);
  }
  return { outcome: await call(fixture), expected: fixture.outcome };
}

describe("K-05 v1 fixtures for reserve and release", () => {
  for (const file of [
    "reserve-10-min.json",
    "reserve-ai-door-15-min.json",
    "reserve-overlap-refused.json",
    "reserve-next-in-line.json",
    "reserve-third-refused.json",
    "release-expired-promotes.json",
  ]) {
    it(`${file} gives its outcome`, async () => {
      const { outcome, expected } = await runFixture(file);
      expect(outcome).toEqual(expected);
    });
  }
});

describe("reserve", () => {
  it("1,000 parallel reserve() calls on one slot give exactly one success", HEAVY, async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    const outcomes = await Promise.all(
      Array.from({ length: 1000 }, (_, i) => reserve(db.sql, request({ reservationId: `par-${String(i)}` }))),
    );
    expect(tally(outcomes)).toEqual({ held: 1, overlap: 999 });
    const rows = await db.sql<{ n: number }[]>`
      select count(*)::int as n from reservations where id like 'par-%' and state = 'held'
    `;
    expect(rows[0]?.n).toBe(1);
  });

  it(
    "1,000 parallel calls that wait if saved give one held row and 999 waiting rows, one holder",
    HEAVY,
    async () => {
      await emptyTables(db.sql);
      await loadFixture(db.sql, "seed-reservation.json");
      const outcomes = await Promise.all(
        Array.from({ length: 1000 }, (_, i) =>
          reserve(db.sql, request({ reservationId: `wait-${String(i)}`, waitIfSaved: true })),
        ),
      );
      expect(tally(outcomes)).toEqual({ held: 1, waiting: 999 });
    },
  );

  it("1,000 parallel seat reserves on a capacity-12 session give exactly 12 successes", HEAVY, async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    await createResource(db.sql, {
      id: "res-class-12",
      businessId: "biz-yoga-studio",
      kind: "class_session",
      name: "Capacity twelve",
    });
    await createClassSeats(db.sql, {
      resourceId: "res-class-12",
      businessId: "biz-yoga-studio",
      capacity: 12,
    });
    const outcomes = await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        reserve(
          db.sql,
          request({
            reservationId: `seat-${String(i)}`,
            businessId: "biz-yoga-studio",
            resourceId: "res-class-12",
            during: { start: "2026-12-05T17:00:00Z", end: "2026-12-05T18:00:00Z" },
          }),
        ),
      ),
    );
    expect(tally(outcomes)).toEqual({ held: 12, seatsFull: 988 });
    const full = outcomes.find((outcome) => "error" in outcome && outcome.error === "seatsFull");
    expect(full).toEqual({ error: "seatsFull", resourceId: "res-class-12", capacity: 12, taken: 12 });
    expect(await getClassSeats(db.sql, "res-class-12")).toMatchObject({ capacity: 12, taken: 12 });
    const held = await db.sql<{ n: number }[]>`
      select coalesce(sum(seats), 0)::int as n from reservations where resource_id = 'res-class-12' and state = 'held'
    `;
    expect(held[0]?.n).toBe(12);
  });

  it("a party of several seats takes them together or not at all", async () => {
    const big = request({
      reservationId: "party-5",
      businessId: "biz-yoga-studio",
      resourceId: "res-class-12",
      seats: 5,
    });
    // Twelve are taken: five more do not fit, and nothing is written.
    const before = await getClassSeats(db.sql, "res-class-12");
    expect(await reserve(db.sql, big)).toMatchObject({ error: "seatsFull", capacity: 12 });
    expect(await getReservation(db.sql, "party-5")).toBeNull();
    expect(await getClassSeats(db.sql, "res-class-12")).toEqual(before);
  });

  it(
    "two parallel reserves for one mobile pass the cap of 2 one after the other: exactly 2 held",
    HEAVY,
    async () => {
      await emptyTables(db.sql);
      await loadFixture(db.sql, "seed-reservation.json");
      const rooms = Array.from({ length: 40 }, (_, i) => `res-cap-room-${String(i)}`);
      for (const id of rooms) {
        await createResource(db.sql, { id, businessId: "biz-lees-barbershop", kind: "room", name: id });
      }
      const outcomes = await Promise.all(
        rooms.map((resourceId) =>
          reserve(
            db.sql,
            request({
              reservationId: `cap-${resourceId}`,
              resourceId,
              for: { phoneNumber: "+15555550102" },
            }),
          ),
        ),
      );
      expect(tally(outcomes)).toEqual({ held: 2, savedTimeCap: 38 });
    },
  );

  it("two parallel reserves for one agent token also stop at 2 at that business", HEAVY, async () => {
    const rooms = Array.from({ length: 30 }, (_, i) => `res-cap-room-${String(i)}`);
    const outcomes = await Promise.all(
      rooms.map((resourceId) =>
        reserve(
          db.sql,
          request({
            reservationId: `tok-${resourceId}`,
            resourceId,
            during: { start: "2026-12-09T10:00:00Z", end: "2026-12-09T11:00:00Z" },
            for: { agentToken: "agent-capped" },
          }),
        ),
      ),
    );
    expect(tally(outcomes)).toEqual({ held: 2, savedTimeCap: 28 });
  });

  it(
    "30 parallel calls with the same id and the same request give one write and 29 repeats",
    HEAVY,
    async () => {
      const same = request({ reservationId: "same-id", for: { phoneNumber: "+15555550104" } });
      const outcomes = await Promise.all(Array.from({ length: 30 }, () => reserve(db.sql, same)));
      expect(outcomes.every((outcome) => "result" in outcome && outcome.result === "held")).toBe(true);
      expect(outcomes.filter((outcome) => "repeated" in outcome && !outcome.repeated)).toHaveLength(1);
      expect(
        await reserve(db.sql, {
          ...same,
          during: { start: "2026-12-01T16:00:00Z", end: "2026-12-01T17:00:00Z" },
        }),
      ).toEqual({
        error: "idConflict",
        reservationId: "same-id",
      });
    },
  );

  it("a time that is not bookable: inactive, another business's, or no counter row", async () => {
    await db.sql`update resources set active = false, version = version + 1 where id = 'res-avery'`;
    expect(await reserve(db.sql, request({ reservationId: "nb-1", resourceId: "res-avery" }))).toEqual({
      error: "notBookable",
      resourceId: "res-avery",
    });
    expect(await reserve(db.sql, request({ reservationId: "nb-2", resourceId: "res-maya" }))).toEqual({
      error: "notBookable",
      resourceId: "res-maya",
    });
    expect(await reserve(db.sql, request({ reservationId: "nb-3", resourceId: "res-none" }))).toEqual({
      error: "notBookable",
      resourceId: "res-none",
    });
    // A class session with no seat counter: nothing is written, the reservation row is undone with it.
    expect(
      await reserve(
        db.sql,
        request({
          reservationId: "nb-4",
          businessId: "biz-yoga-studio",
          resourceId: "res-handstand-workshop",
        }),
      ),
    ).toEqual({ error: "notBookable", resourceId: "res-handstand-workshop" });
    expect(await getReservation(db.sql, "nb-4")).toBeNull();
  });

  it("the doors set how long: 10, 15, and the asked minutes up to each door's limit", async () => {
    expect(holdMinutesFor("standard", null)).toBe(10);
    expect(holdMinutesFor("ownAi", null)).toBe(15);
    expect(holdMinutesFor("planCheck", 60)).toBe(60);
    expect(holdMinutesFor("ownerOk", 30)).toBe(30);
    expect(holdMinutesFor("document", 1440)).toBe(1440);
    expect(() => holdMinutesFor("standard", 5)).toThrow(TypeError);
    expect(() => holdMinutesFor("planCheck", 61)).toThrow(TypeError);
    expect(() => holdMinutesFor("ownerOk", 31)).toThrow(TypeError);
    expect(() => holdMinutesFor("document", 1441)).toThrow(TypeError);
    expect(() => holdMinutesFor("document", null)).toThrow(TypeError);
    const held = await reserve(
      db.sql,
      request({
        reservationId: "door-doc",
        resourceId: "res-riley",
        during: { start: "2026-12-20T10:00:00Z", end: "2026-12-20T11:00:00Z" },
        door: "document",
        holdMinutes: 1440,
      }),
    );
    expect(held).toMatchObject({ result: "held", heldUntil: "2026-11-08T15:05:00Z" });
  });

  it("refuses a request that is not well formed before touching the database", async () => {
    await expect(reserve(db.sql, request({ reservationId: "bad-1", at: "tomorrow" }))).rejects.toThrow(
      TypeError,
    );
    await expect(
      reserve(
        db.sql,
        request({
          reservationId: "bad-2",
          during: { start: "2026-12-01T17:00:00Z", end: "2026-12-01T16:00:00Z" },
        }),
      ),
    ).rejects.toThrow(TypeError);
    await expect(reserve(db.sql, request({ reservationId: "bad-3", seats: 0 }))).rejects.toThrow(TypeError);
  });
});

describe("release", () => {
  it("release() frees the slot, and a later reserve() on it succeeds", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    const first = await reserve(db.sql, request({ reservationId: "free-1" }));
    expect(first).toMatchObject({ result: "held", version: 1 });
    expect(await reserve(db.sql, request({ reservationId: "free-2" }))).toEqual({
      error: "overlap",
      resourceId: "res-riley",
    });
    const released = await release(db.sql, {
      reservationId: "free-1",
      businessId: "biz-lees-barbershop",
      expectVersion: 1,
      why: "let_go",
      at: "2026-11-07T15:06:00Z",
    });
    expect(released).toEqual({
      result: "released",
      reservationId: "free-1",
      version: 2,
      releasedAt: "2026-11-07T15:06:00Z",
      why: "let_go",
      promoted: null,
      skipped: [],
      repeated: false,
    });
    expect(await reserve(db.sql, request({ reservationId: "free-3" }))).toMatchObject({ result: "held" });
  });

  it("a release repeated returns the first release; a stale version, an early expiry and a missing row are refused", async () => {
    const again = await release(db.sql, {
      reservationId: "free-1",
      businessId: "biz-lees-barbershop",
      expectVersion: 1,
      why: "cancelled",
      at: "2026-11-07T16:00:00Z",
    });
    expect(again).toEqual({
      result: "released",
      reservationId: "free-1",
      version: 2,
      releasedAt: "2026-11-07T15:06:00Z",
      why: "let_go",
      promoted: null,
      skipped: [],
      repeated: true,
    });
    const base = { businessId: "biz-lees-barbershop", at: "2026-11-07T15:06:00Z" };
    expect(
      await release(db.sql, { ...base, reservationId: "free-3", expectVersion: 5, why: "let_go" }),
    ).toEqual({
      error: "versionChanged",
      changed: [{ table: "reservations", rowId: "free-3", readVersion: 5, currentVersion: 1 }],
    });
    expect(
      await release(db.sql, { ...base, reservationId: "free-3", expectVersion: null, why: "expired" }),
    ).toEqual({
      error: "notExpired",
      reservationId: "free-3",
      heldUntil: "2026-11-07T15:15:00Z",
    });
    expect(
      await release(db.sql, { ...base, reservationId: "nope", expectVersion: 1, why: "let_go" }),
    ).toEqual({
      error: "notFound",
      table: "reservations",
      rowId: "nope",
    });
    expect(await getReservation(db.sql, "free-3")).toMatchObject({ state: "held", version: 1 });
    await expect(
      release(db.sql, { ...base, reservationId: "free-3", expectVersion: 0, why: "let_go" }),
    ).rejects.toThrow(TypeError);
  });

  it("releasing a class seat gives it back: a full session takes another reserve", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-class-seats.json");
    const yoga = { businessId: "biz-yoga-studio", resourceId: "res-handstand-workshop" };
    const during = { start: "2026-11-14T16:00:00Z", end: "2026-11-14T18:00:00Z" };
    const fill = await reserve(db.sql, request({ ...yoga, during, reservationId: "fill", seats: 8 }));
    expect(fill).toMatchObject({ result: "held" });
    expect(await getClassSeats(db.sql, "res-handstand-workshop")).toMatchObject({ taken: 10 });
    expect(await reserve(db.sql, request({ ...yoga, during, reservationId: "one-more" }))).toEqual({
      error: "seatsFull",
      resourceId: "res-handstand-workshop",
      capacity: 10,
      taken: 10,
    });
    await release(db.sql, {
      reservationId: "fill",
      businessId: "biz-yoga-studio",
      expectVersion: 1,
      why: "let_go",
      at: "2026-11-07T15:06:00Z",
    });
    expect(await getClassSeats(db.sql, "res-handstand-workshop")).toMatchObject({ taken: 2 });
    expect(await reserve(db.sql, request({ ...yoga, during, reservationId: "one-more" }))).toMatchObject({
      result: "held",
    });
  });

  it("promotes exactly one waiting row, in queue order, and names those it passes over", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    // Two agent tokens wait on Avery's saved time (queued 15:02, 15:04); a mobile waits behind them, and a mobile that
    // already holds two saved times waits ahead of everyone (queued 15:01).
    await db.sql`insert into reservations ${db.sql({
      id: "rsv-cap-held-1",
      business_id: "biz-movers",
      resource_id: "res-truck-20",
      resource_kind: "vehicle",
      worker_person_id: null,
      during: "[2026-12-01T10:00:00Z,2026-12-01T11:00:00Z)",
      state: "held",
      held_until: "2026-11-07T16:00:00Z",
      for_phone_number: "+15555550103",
    })}`;
    await db.sql`insert into reservations ${db.sql({
      id: "rsv-cap-held-2",
      business_id: "biz-movers",
      resource_id: "res-truck-26",
      resource_kind: "vehicle",
      worker_person_id: null,
      during: "[2026-12-01T10:00:00Z,2026-12-01T11:00:00Z)",
      state: "held",
      held_until: "2026-11-07T16:00:00Z",
      for_phone_number: "+15555550103",
    })}`;
    await db.sql`insert into reservations ${db.sql({
      id: "rsv-aaa-capped",
      business_id: "biz-lees-barbershop",
      resource_id: "res-avery",
      resource_kind: "worker",
      worker_person_id: "person-avery",
      during: "[2026-11-14T15:10:00Z,2026-11-14T15:20:00Z)",
      state: "waiting",
      queued_at: "2026-11-07T15:01:00Z",
      for_phone_number: "+15555550103",
    })}`;
    const outcome = await release(db.sql, {
      reservationId: "rsv-alex-saved-avery",
      businessId: "biz-lees-barbershop",
      expectVersion: 1,
      why: "let_go",
      at: "2026-11-07T15:06:00Z",
    });
    expect(outcome).toMatchObject({
      result: "released",
      skipped: [{ reservationId: "rsv-aaa-capped", reason: "savedTimeCap" }],
      promoted: {
        reservationId: "rsv-agent-waiting-avery",
        version: 2,
        heldUntil: "2026-11-07T15:16:00Z",
        forAgentToken: "agent-token-demo-2",
      },
    });
    // Only that one moved: the other token's row still waits, and the capped mobile's row stays waiting.
    const states = await db.sql<{ id: string; state: string }[]>`
      select id, state from reservations where resource_id = 'res-avery' order by id
    `;
    expect(states).toEqual([
      { id: "rsv-aaa-capped", state: "waiting" },
      { id: "rsv-agent-waiting-avery", state: "held" },
      { id: "rsv-agent-waiting-avery-second", state: "waiting" },
      { id: "rsv-alex-saved-avery", state: "released" },
    ]);
  });

  it("a waiting row whose time another held row now covers is skipped for overlap and stays waiting", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    // Another saved time covers the second half of the waiting rows' slot, so promoting them is refused by EXCLUDE.
    await db.sql`insert into reservations ${db.sql({
      id: "rsv-cover",
      business_id: "biz-lees-barbershop",
      resource_id: "res-avery",
      resource_kind: "worker",
      worker_person_id: "person-avery",
      during: "[2026-11-14T15:30:00Z,2026-11-14T16:00:00Z)",
      state: "held",
      held_until: "2026-11-07T16:00:00Z",
      for_agent_token: "agent-cover",
    })}`;
    await db.sql`update reservations set during = '[2026-11-14T15:00:00Z,2026-11-14T15:45:00Z)', version = version + 1 where id = 'rsv-agent-waiting-avery'`;
    await db.sql`update reservations set state = 'released', released_at = '2026-11-07T15:05:00Z', released_why = 'let_go', version = version + 1 where id = 'rsv-agent-waiting-avery-second'`;
    const outcome = await release(db.sql, {
      reservationId: "rsv-alex-saved-avery",
      businessId: "biz-lees-barbershop",
      expectVersion: null,
      why: "expired",
      at: "2026-11-07T15:10:00Z",
    });
    expect(outcome).toMatchObject({
      result: "released",
      promoted: null,
      skipped: [{ reservationId: "rsv-agent-waiting-avery", reason: "overlap" }],
    });
    expect(await getReservation(db.sql, "rsv-agent-waiting-avery")).toMatchObject({
      state: "waiting",
      version: 2,
    });
  });

  it("releasing a booked row promotes too; releasing a waiting row promotes nobody", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    const waiting = await release(db.sql, {
      reservationId: "rsv-agent-waiting-avery",
      businessId: "biz-lees-barbershop",
      expectVersion: 1,
      why: "let_go",
      at: "2026-11-07T15:06:00Z",
    });
    expect(waiting).toMatchObject({ result: "released", promoted: null, skipped: [] });
    await db.sql`update reservations set state = 'booked', held_until = null, booking_id = 'booking-alex-haircut', version = version + 1 where id = 'rsv-alex-saved-avery'`;
    const booked = await release(db.sql, {
      reservationId: "rsv-alex-saved-avery",
      businessId: "biz-lees-barbershop",
      expectVersion: 2,
      why: "cancelled",
      at: "2026-11-07T15:07:00Z",
    });
    expect(booked).toMatchObject({
      result: "released",
      promoted: { reservationId: "rsv-agent-waiting-avery-second", heldUntil: "2026-11-07T15:17:00Z" },
    });
  });

  it("an expired release of a row that is no longer held is an error the caller sees, and writes nothing", async () => {
    await db.sql`insert into reservations ${db.sql({
      id: "rsv-still-waiting",
      business_id: "biz-lees-barbershop",
      resource_id: "res-riley",
      resource_kind: "worker",
      worker_person_id: "person-riley",
      during: "[2026-12-03T10:00:00Z,2026-12-03T10:30:00Z)",
      state: "waiting",
      for_agent_token: "agent-w",
    })}`;
    await expect(
      release(db.sql, {
        reservationId: "rsv-still-waiting",
        businessId: "biz-lees-barbershop",
        expectVersion: null,
        why: "expired",
        at: "2026-11-07T15:20:00Z",
      }),
    ).rejects.toThrow("an expired release needs a held row");
    expect(await getReservation(db.sql, "rsv-still-waiting")).toMatchObject({ state: "waiting", version: 1 });
  });

  it("runs under the request's business scope and drops it at the end", async () => {
    const scope = await withBusiness(db.sql, "biz-lees-barbershop", async (tx) => {
      const [row] = await tx<{ scope: string }[]>`select current_setting('rosie.business_id', true) as scope`;
      return row?.scope;
    });
    expect(scope).toBe("biz-lees-barbershop");
  });

  it("a let go or a cancel with no version is refused before any write; null is only for the clock's expiry", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    const held = await reserve(db.sql, request({ reservationId: "needs-version" }));
    expect(held).toMatchObject({ result: "held", version: 1 });
    for (const why of ["let_go", "cancelled"] as const) {
      await expect(
        release(db.sql, {
          reservationId: "needs-version",
          businessId: "biz-lees-barbershop",
          expectVersion: null,
          why,
          at: "2026-11-07T15:06:00Z",
        }),
      ).rejects.toThrow(TypeError);
    }
    expect(await getReservation(db.sql, "needs-version")).toMatchObject({ state: "held", version: 1 });
    // The clock's expiry still takes null.
    expect(
      await release(db.sql, {
        reservationId: "needs-version",
        businessId: "biz-lees-barbershop",
        expectVersion: null,
        why: "expired",
        at: "2026-11-07T15:15:00Z",
      }),
    ).toMatchObject({ result: "released", why: "expired", repeated: false });
  });
});

describe("a repeat answers before the resource is looked at", () => {
  it("the same reserve again answers repeated after its resource went inactive; another request is idConflict", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    const first = request({ reservationId: "repeat-first" });
    expect(await reserve(db.sql, first)).toMatchObject({ result: "held", repeated: false });
    await db.sql`update resources set active = false, version = version + 1 where id = 'res-riley'`;
    expect(await reserve(db.sql, first)).toMatchObject({ result: "held", repeated: true });
    expect(
      await reserve(db.sql, {
        ...first,
        during: { start: "2026-12-02T16:00:00Z", end: "2026-12-02T16:30:00Z" },
      }),
    ).toEqual({ error: "idConflict", reservationId: "repeat-first" });
    expect(await reserve(db.sql, request({ reservationId: "repeat-other" }))).toEqual({
      error: "notBookable",
      resourceId: "res-riley",
    });
    await db.sql`update resources set active = true, version = version + 1 where id = 'res-riley'`;
  });
});

describe("under row-level security, the cap and the booked check still see every business (K-05 item 8; T-1085)", () => {
  /**
   * The test's connection owns the tables and bypasses row-level security (T-191), so these calls run as the Tool API's
   * role, rosie_app, in one transaction on a reserved connection scoped to the request's business, as reserve() runs
   * its own (inScopedTransaction; postgres.js's begin() would fail the whole transaction on a statement reserveIn
   * refuses inside its savepoint).
   */
  async function asToolApi<T>(businessId: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
    const reserved = await db.sql.reserve();
    try {
      await reserved`begin`;
      try {
        await reserved`select set_config(${SCOPE_SETTING}, ${businessId}, true)`;
        await reserved.unsafe("set local role rosie_app");
        const result = await fn(reserved);
        await reserved`commit`;
        return result;
      } catch (error) {
        await reserved`rollback`;
        throw error;
      }
    } finally {
      reserved.release();
    }
  }
  const ALEX = "+15555550101";
  const alexAtYoga = {
    id: "rsv-alex-maya-saved",
    business_id: "biz-yoga-studio",
    resource_id: "res-maya",
    resource_kind: "worker",
    worker_person_id: "person-maya",
    during: "[2026-11-21T15:00:00Z,2026-11-21T16:00:00Z)",
    state: "held",
    held_until: "2026-11-07T15:20:00Z",
    for_phone_number: ALEX,
  };

  it("a mobile's saved times at two businesses both count: its third is refused from either business, naming both", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    // Alex's mobile holds rsv-alex-saved-avery at Lee's Barbershop (ends 15:10) and now one at the yoga studio (15:20).
    await db.sql`insert into reservations ${db.sql(alexAtYoga)}`;
    const at = "2026-11-07T15:06:00Z";
    // The barbershop's scope shows only its own saved time: a direct count would see 1 and let a third through.
    const direct = await asToolApi(
      "biz-lees-barbershop",
      (tx) =>
        tx<{ id: string }[]>`select id from reservations where for_phone_number = ${ALEX} and state = 'held'`,
    );
    expect(direct.map((row) => row.id)).toEqual(["rsv-alex-saved-avery"]);
    const both = [
      { reservationId: "rsv-alex-saved-avery", heldUntil: "2026-11-07T15:10:00Z" },
      { reservationId: "rsv-alex-maya-saved", heldUntil: "2026-11-07T15:20:00Z" },
    ];
    expect(
      await asToolApi("biz-lees-barbershop", (tx) =>
        reserveIn(tx, request({ reservationId: "rsv-alex-third", for: { phoneNumber: ALEX }, at })),
      ),
    ).toEqual({ error: "savedTimeCap", saved: both });
    expect(
      await asToolApi("biz-yoga-studio", (tx) =>
        reserveIn(
          tx,
          request({
            reservationId: "rsv-alex-third-yoga",
            businessId: "biz-yoga-studio",
            resourceId: "res-maya",
            during: { start: "2026-11-28T15:00:00Z", end: "2026-11-28T16:00:00Z" },
            for: { phoneNumber: ALEX },
            at,
          }),
        ),
      ),
    ).toEqual({ error: "savedTimeCap", saved: both });
    expect(await getReservation(db.sql, "rsv-alex-third")).toBeNull();
    expect(await getReservation(db.sql, "rsv-alex-third-yoga")).toBeNull();
    // Once the barbershop's has ended, the yoga studio's still counts: one saved time, so a second is held.
    expect(
      await asToolApi("biz-lees-barbershop", (tx) =>
        reserveIn(
          tx,
          request({
            reservationId: "rsv-alex-second",
            for: { phoneNumber: ALEX },
            at: "2026-11-07T15:11:00Z",
          }),
        ),
      ),
    ).toMatchObject({ result: "held", reservationId: "rsv-alex-second", repeated: false });
  });

  it("reserve-third-refused.json (Alex's third saved time, at another business) gives its outcome as the Tool API role", async () => {
    const fixture = readJson(new URL("reserve-third-refused.json", ACCESS_DIR)) as AccessFixture;
    await emptyTables(db.sql);
    for (const seed of fixture.given.k04Seeds) {
      await loadFixture(db.sql, seed);
    }
    for (const before of fixture.given.after) {
      const earlier = (readJson(new URL(before, ACCESS_DIR)) as AccessFixture).request as ReserveRequest;
      await asToolApi(earlier.businessId, (tx) => reserveIn(tx, earlier));
    }
    const asked = fixture.request as ReserveRequest;
    expect(asked.businessId).not.toBe("biz-lees-barbershop");
    expect(await asToolApi(asked.businessId, (tx) => reserveIn(tx, asked))).toEqual(fixture.outcome);
  });

  it("nothing but the held rows' ids and ends leaves reservations_saved_times, under any business's scope", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    await db.sql`insert into reservations ${db.sql(alexAtYoga)}`;
    // Rows that never leave it: Alex's booked haircut (seeded), a waiting row, an ended saved time, another mobile's.
    const others = [
      {
        id: "rsv-alex-waiting",
        state: "waiting",
        held_until: null,
        during: "[2026-11-22T15:00:00Z,2026-11-22T16:00:00Z)",
      },
      {
        id: "rsv-alex-ended",
        state: "held",
        held_until: "2026-11-07T15:01:00Z",
        during: "[2026-11-23T15:00:00Z,2026-11-23T16:00:00Z)",
      },
      {
        id: "rsv-other-mobile",
        state: "held",
        for_phone_number: "+15555550102",
        during: "[2026-11-24T15:00:00Z,2026-11-24T16:00:00Z)",
      },
    ];
    for (const row of others) {
      await db.sql`insert into reservations ${db.sql({ ...alexAtYoga, ...row })}`;
    }
    for (const business of ["biz-lees-barbershop", "biz-yoga-studio", "biz-movers"]) {
      const rows = await asToolApi(
        business,
        (tx) =>
          tx<
            Record<string, unknown>[]
          >`select * from reservations_saved_times(${ALEX}, '2026-11-07T15:06:00Z')`,
      );
      expect(
        rows.map((row) => Object.keys(row).sort()),
        business,
      ).toEqual([
        ["held_until", "id"],
        ["held_until", "id"],
      ]);
      expect(
        rows.map((row) => ({ id: row.id, heldUntil: (row.held_until as Date).toISOString() })),
        business,
      ).toEqual([
        { id: "rsv-alex-saved-avery", heldUntil: "2026-11-07T15:10:00.000Z" },
        { id: "rsv-alex-maya-saved", heldUntil: "2026-11-07T15:20:00.000Z" },
      ]);
    }
  });

  it("a worker booked at one business is an overlap at another's resource, though that scope cannot see the booking", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    await createResource(db.sql, {
      id: "res-riley-yoga",
      businessId: "biz-yoga-studio",
      kind: "worker",
      name: "Riley at yoga",
      personId: "person-riley",
    });
    // Riley's booked haircut at Lee's Barbershop is Oct 24, 15:00 to 15:30 (seed-reservation).
    const booked = await asToolApi(
      "biz-yoga-studio",
      (tx) => tx`select id from reservations where state = 'booked' and worker_person_id = 'person-riley'`,
    );
    expect(booked).toHaveLength(0);
    const ask = (id: string, start: string, end: string): ReserveRequest =>
      request({
        reservationId: id,
        businessId: "biz-yoga-studio",
        resourceId: "res-riley-yoga",
        during: { start, end },
        waitIfSaved: true,
      });
    // Asking to wait if saved: a booked time is never waited on (K-05 item 8), so this is an overlap, not a waiting row.
    expect(
      await asToolApi("biz-yoga-studio", (tx) =>
        reserveIn(tx, ask("rsv-yoga-riley", "2026-10-24T15:10:00Z", "2026-10-24T15:20:00Z")),
      ),
    ).toEqual({ error: "overlap", resourceId: "res-riley-yoga" });
    expect(await getReservation(db.sql, "rsv-yoga-riley")).toBeNull();
    const [answer] = await asToolApi(
      "biz-yoga-studio",
      (tx) => tx<Record<string, unknown>[]>`
        select reservations_booked_overlap('res-riley-yoga', 'person-riley',
          tstzrange('2026-10-24T15:10:00Z', '2026-10-24T15:20:00Z', '[)')) as overlap
      `,
    );
    expect(answer).toEqual({ overlap: true });
    // Riley free at both businesses: held.
    expect(
      await asToolApi("biz-yoga-studio", (tx) =>
        reserveIn(tx, ask("rsv-yoga-riley-free", "2026-10-24T16:00:00Z", "2026-10-24T16:30:00Z")),
      ),
    ).toMatchObject({ result: "held", reservationId: "rsv-yoga-riley-free" });
  });

  it("the booked-overlap probe: another business's booked room answers nothing, a worker's booked time answers yes or no from any business, and a saved time never counts (T-1094; FS line 743)", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    // The yoga studio's room, booked Nov 30 from 10:00 to 11:00.
    await db.sql`insert into reservations ${db.sql({
      id: "rsv-studio-room-booked",
      business_id: "biz-yoga-studio",
      resource_id: "res-studio-room",
      resource_kind: "room",
      worker_person_id: null,
      during: "[2026-11-30T10:00:00Z,2026-11-30T11:00:00Z)",
      state: "booked",
      for_agent_token: "agent-token-t1094",
    })}`;
    const probe = (
      business: string,
      resource: string,
      worker: string | null,
      during: [string, string],
    ): Promise<boolean | undefined> =>
      asToolApi(business, async (tx) => {
        const [row] = await tx<{ overlap: boolean }[]>`
          select reservations_booked_overlap(${resource}, ${worker}::text,
            tstzrange(${during[0]}::timestamptz, ${during[1]}::timestamptz, '[)')) as overlap
        `;
        return row?.overlap;
      });
    const inRoomTime: [string, string] = ["2026-11-30T10:15:00Z", "2026-11-30T10:45:00Z"];
    // Another business's room: nothing, from either other business, though it is booked over that time.
    for (const other of ["biz-lees-barbershop", "biz-movers"]) {
      expect(await probe(other, "res-studio-room", null, inRoomTime), other).toBe(false);
    }
    // The room's own business: yes over its booked time, no after it.
    expect(await probe("biz-yoga-studio", "res-studio-room", null, inRoomTime)).toBe(true);
    expect(
      await probe("biz-yoga-studio", "res-studio-room", null, [
        "2026-11-30T11:00:00Z",
        "2026-11-30T11:30:00Z",
      ]),
    ).toBe(false);
    // So reserve() at the room's own business still answers overlap for a booked time, never a waiting row.
    expect(
      await asToolApi("biz-yoga-studio", (tx) =>
        reserveIn(
          tx,
          request({
            reservationId: "rsv-studio-room-ask",
            businessId: "biz-yoga-studio",
            resourceId: "res-studio-room",
            during: { start: inRoomTime[0], end: inRoomTime[1] },
            waitIfSaved: true,
          }),
        ),
      ),
    ).toEqual({ error: "overlap", resourceId: "res-studio-room" });
    expect(await getReservation(db.sql, "rsv-studio-room-ask")).toBeNull();
    // A worker: Riley's booked haircut at Lee's Barbershop (Oct 24, 15:00 to 15:30) answers yes from the yoga studio,
    // and no for a time Riley is free.
    expect(
      await probe("biz-yoga-studio", "res-maya", "person-riley", [
        "2026-10-24T15:10:00Z",
        "2026-10-24T15:20:00Z",
      ]),
    ).toBe(true);
    expect(
      await probe("biz-yoga-studio", "res-maya", "person-riley", [
        "2026-10-24T16:00:00Z",
        "2026-10-24T16:30:00Z",
      ]),
    ).toBe(false);
    // Avery's saved time at Lee's Barbershop (Nov 14, held) is no booked time: only reservations_saved_times reads
    // saved times across businesses, and it answers ids and ends.
    expect(
      await probe("biz-yoga-studio", "res-maya", "person-avery", [
        "2026-11-14T15:10:00Z",
        "2026-11-14T15:20:00Z",
      ]),
    ).toBe(false);
  });

  it("release() skips a waiting mobile capped by saved times at another business, as the Tool API role", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    // The mobile +15555550103 holds two saved times at the movers and waits first in line for Avery at the barbershop.
    for (const [id, resource] of [
      ["rsv-cap-held-1", "res-truck-20"],
      ["rsv-cap-held-2", "res-truck-26"],
    ] as const) {
      await db.sql`insert into reservations ${db.sql({
        id,
        business_id: "biz-movers",
        resource_id: resource,
        resource_kind: "vehicle",
        worker_person_id: null,
        during: "[2026-12-01T10:00:00Z,2026-12-01T11:00:00Z)",
        state: "held",
        held_until: "2026-11-07T16:00:00Z",
        for_phone_number: "+15555550103",
      })}`;
    }
    await db.sql`insert into reservations ${db.sql({
      id: "rsv-aaa-capped",
      business_id: "biz-lees-barbershop",
      resource_id: "res-avery",
      resource_kind: "worker",
      worker_person_id: "person-avery",
      during: "[2026-11-14T15:10:00Z,2026-11-14T15:20:00Z)",
      state: "waiting",
      queued_at: "2026-11-07T15:01:00Z",
      for_phone_number: "+15555550103",
    })}`;
    const outcome = await asToolApi("biz-lees-barbershop", (tx) =>
      releaseIn(tx, {
        reservationId: "rsv-alex-saved-avery",
        businessId: "biz-lees-barbershop",
        expectVersion: 1,
        why: "let_go",
        at: "2026-11-07T15:06:00Z",
      }),
    );
    expect(outcome).toMatchObject({
      result: "released",
      skipped: [{ reservationId: "rsv-aaa-capped", reason: "savedTimeCap" }],
      promoted: { reservationId: "rsv-agent-waiting-avery" },
    });
    expect(await getReservation(db.sql, "rsv-aaa-capped")).toMatchObject({ state: "waiting" });
  });

  it("a reservation id another business holds is idConflict, though its scope cannot see it, and nothing is written", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    // rsv-alex-saved-avery is Lee's Barbershop's.
    expect(
      await asToolApi("biz-yoga-studio", (tx) =>
        reserveIn(
          tx,
          request({
            reservationId: "rsv-alex-saved-avery",
            businessId: "biz-yoga-studio",
            resourceId: "res-maya",
            during: { start: "2026-11-28T15:00:00Z", end: "2026-11-28T16:00:00Z" },
          }),
        ),
      ),
    ).toEqual({ error: "idConflict", reservationId: "rsv-alex-saved-avery" });
    expect(await getReservation(db.sql, "rsv-alex-saved-avery")).toMatchObject({
      businessId: "biz-lees-barbershop",
      state: "held",
      version: 1,
    });
  });
});

describe("a lost connection answers transient, writes nothing, and the same request then succeeds (K-05 README line 46)", () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  interface Killed<T> {
    answer: T;
    victim: ReturnType<typeof createClient>;
  }

  /**
   * Runs `call` on its own one-connection client while another connection holds the slot's advisory lock (the one
   * lockSlot takes), waits until the call's backend waits on that lock, cuts it with pg_terminate_backend from a third
   * connection, and returns the call's answer with the killed client for the resend.
   */
  async function killWhileWaitingOnSlot<T>(call: (sql: Sql) => Promise<T>): Promise<Killed<T>> {
    const url = resolvePrimaryUrl();
    const holder = postgres(url, { max: 1, onnotice: () => undefined });
    const killer = postgres(url, { max: 1, onnotice: () => undefined });
    const victim = createClient({ primaryUrl: url, schema: db.schema, max: 1 });
    try {
      let letGo: () => void = () => undefined;
      const hold = new Promise<void>((resolve) => {
        letGo = resolve;
      });
      let locked: () => void = () => undefined;
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holding = holder.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${"resource:res-riley"}, 0))`;
        locked();
        await hold;
      });
      await isLocked;

      const [backend] = await victim.primary<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const pid = backend?.pid ?? 0;
      const answering = call(victim.primary);
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
        const [state] = await killer<{ waiting: boolean }[]>`
          select (wait_event_type = 'Lock') as waiting from pg_stat_activity where pid = ${pid}
        `;
        waiting = state?.waiting === true;
        if (!waiting) {
          await sleep(50);
        }
      }
      expect(waiting).toBe(true);
      await killer`select pg_terminate_backend(${pid})`;
      const answer = await answering;
      letGo();
      await holding;
      return { answer, victim };
    } catch (error) {
      await victim.close();
      throw error;
    } finally {
      await killer.end({ timeout: 5 });
      await holder.end({ timeout: 5 });
    }
  }

  /** The same request again on the killed client: at most one stale transient (postgres.js keeps the killed query's FATAL). */
  async function resend<T>(call: (sql: Sql) => Promise<T>, victim: Killed<T>["victim"]): Promise<T[]> {
    const answers: T[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const again = await call(victim.primary);
      answers.push(again);
      if ((again as { error?: string }).error !== "transient") {
        break;
      }
    }
    return answers;
  }

  const lostConnection = /^(08[0-9A-Z]{3}|57P0[123])$/;

  it("reserve() waiting on the slot lock, its backend terminated, answers transient and writes nothing; the same request then holds the time", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    const asked = request({ reservationId: "killed-reserve" });
    const { answer, victim } = await killWhileWaitingOnSlot((sql) => reserve(sql, asked));
    try {
      expect(answer).toMatchObject({ error: "transient" });
      expect((answer as { sqlstate: string }).sqlstate).toMatch(lostConnection);
      expect(await getReservation(db.sql, "killed-reserve")).toBeNull();
      const answers = await resend((sql) => reserve(sql, asked), victim);
      expect(answers.length).toBeLessThanOrEqual(2);
      for (const stale of answers.slice(0, -1)) {
        expect(stale).toMatchObject({ error: "transient" });
      }
      expect(answers.at(-1)).toMatchObject({
        result: "held",
        reservationId: "killed-reserve",
        repeated: false,
      });
      expect(await getReservation(db.sql, "killed-reserve")).toMatchObject({ state: "held", version: 1 });
    } finally {
      await victim.close();
    }
  }, 30_000);

  it("release() waiting on the slot lock, its backend terminated, answers transient and writes nothing; the same request then releases", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    expect(await reserve(db.sql, request({ reservationId: "killed-release" }))).toMatchObject({
      result: "held",
    });
    const asked = {
      reservationId: "killed-release",
      businessId: "biz-lees-barbershop",
      expectVersion: 1,
      why: "let_go" as const,
      at: "2026-11-07T15:06:00Z",
    };
    const { answer, victim } = await killWhileWaitingOnSlot((sql) => release(sql, asked));
    try {
      expect(answer).toMatchObject({ error: "transient" });
      expect((answer as { sqlstate: string }).sqlstate).toMatch(lostConnection);
      expect(await getReservation(db.sql, "killed-release")).toMatchObject({ state: "held", version: 1 });
      const answers = await resend((sql) => release(sql, asked), victim);
      expect(answers.length).toBeLessThanOrEqual(2);
      for (const stale of answers.slice(0, -1)) {
        expect(stale).toMatchObject({ error: "transient" });
      }
      expect(answers.at(-1)).toMatchObject({ result: "released", version: 2, repeated: false });
      expect(await getReservation(db.sql, "killed-release")).toMatchObject({ state: "released", version: 2 });
    } finally {
      await victim.close();
    }
  }, 30_000);
});

describe("T-1134: one row per holder per slot, in reserve and release themselves (DL-292)", () => {
  const LEES = "biz-lees-barbershop";
  const ALEX = "+15555550101";

  /** reserveIn or releaseIn as the Tool API's role, in one transaction on a reserved connection scoped to `businessId`. */
  async function inToolApiTransaction<T>(businessId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
    const reserved = await db.sql.reserve();
    try {
      await reserved`begin`;
      try {
        await reserved`select set_config(${SCOPE_SETTING}, ${businessId}, true)`;
        await reserved.unsafe("set local role rosie_app");
        const result = await fn(reserved);
        await reserved`commit`;
        return result;
      } catch (error) {
        await reserved`rollback`;
        throw error;
      }
    } finally {
      reserved.release();
    }
  }

  /** A waiting row written straight into the table, as reserve wrote one before T-1134, for Alex's mobile. */
  async function alexQueuedAsBefore(
    id: string,
    resourceId: string,
    personId: string,
    during: string,
    queuedAt: string,
  ): Promise<void> {
    await db.sql`insert into reservations ${db.sql({
      id,
      business_id: LEES,
      resource_id: resourceId,
      resource_kind: "worker",
      worker_person_id: personId,
      during,
      state: "waiting",
      queued_at: queuedAt,
      for_phone_number: ALEX,
    })}`;
  }

  it("with waitIfSaved, a holder's second save of the slot it holds writes nothing and answers its row; without waitIfSaved it is still an overlap; another holder waits under its own id", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    const own = { agentToken: "agent-token-t1134" };
    const first = await reserve(db.sql, request({ reservationId: "own-1", for: own, waitIfSaved: true }));
    expect(first).toMatchObject({ result: "held", reservationId: "own-1", version: 1, repeated: false });
    expect(await reserve(db.sql, request({ reservationId: "own-2", for: own, waitIfSaved: true }))).toEqual({
      ...first,
      repeated: true,
    });
    expect(await reserve(db.sql, request({ reservationId: "own-3", for: own }))).toEqual({
      error: "overlap",
      resourceId: "res-riley",
    });
    for (const id of ["own-2", "own-3"]) {
      expect(await getReservation(db.sql, id), id).toBeNull();
    }
    expect(await reserve(db.sql, request({ reservationId: "other-1", waitIfSaved: true }))).toMatchObject({
      result: "waiting",
      reservationId: "other-1",
      repeated: false,
    });
  });

  it("reserveIn as the Tool API's role: Tomás, waiting on Avery's saved time (reserve-next-in-line.json), asks again and gets his waiting row back, with nothing written", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    const fixture = readJson(new URL("reserve-next-in-line.json", ACCESS_DIR)) as AccessFixture;
    const asked = fixture.request as ReserveRequest;
    expect(await inToolApiTransaction(LEES, (tx) => reserveIn(tx, asked))).toEqual(fixture.outcome);
    const again = { ...asked, reservationId: "rsv-tomas-avery-again", at: "2026-11-07T15:07:00Z" };
    expect(await inToolApiTransaction(LEES, (tx) => reserveIn(tx, again))).toEqual({
      ...(fixture.outcome as Record<string, unknown>),
      repeated: true,
    });
    expect(await getReservation(db.sql, "rsv-tomas-avery-again")).toBeNull();
  });

  it("releaseIn as the Tool API's role lets go every waiting row of the released holder in its line, before and after the one it promotes, and nothing else", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    // Alex's mobile holds Avery's Nov 14 time; two agent tokens wait on it (15:02, 15:04). Alex's own waiting rows: one in
    // that line before everyone (15:01), one after (15:05), and two outside it (Avery another day, Riley that time).
    await alexQueuedAsBefore(
      "rsv-alex-wait-first",
      "res-avery",
      "person-avery",
      "[2026-11-14T15:00:00Z,2026-11-14T15:30:00Z)",
      "2026-11-07T15:01:00Z",
    );
    await alexQueuedAsBefore(
      "rsv-alex-wait-last",
      "res-avery",
      "person-avery",
      "[2026-11-14T15:15:00Z,2026-11-14T15:45:00Z)",
      "2026-11-07T15:05:00Z",
    );
    await alexQueuedAsBefore(
      "rsv-alex-wait-later",
      "res-avery",
      "person-avery",
      "[2026-11-21T15:00:00Z,2026-11-21T15:30:00Z)",
      "2026-11-07T15:01:00Z",
    );
    await alexQueuedAsBefore(
      "rsv-alex-wait-riley",
      "res-riley",
      "person-riley",
      "[2026-11-14T15:00:00Z,2026-11-14T15:30:00Z)",
      "2026-11-07T15:01:00Z",
    );
    const outcome = await inToolApiTransaction(LEES, (tx) =>
      releaseIn(tx, {
        reservationId: "rsv-alex-saved-avery",
        businessId: LEES,
        expectVersion: 1,
        why: "let_go",
        at: "2026-11-07T15:06:00Z",
      }),
    );
    expect(outcome).toEqual({
      result: "released",
      reservationId: "rsv-alex-saved-avery",
      version: 2,
      releasedAt: "2026-11-07T15:06:00Z",
      why: "let_go",
      promoted: {
        reservationId: "rsv-agent-waiting-avery",
        version: 2,
        heldUntil: "2026-11-07T15:16:00Z",
        forPhoneNumber: null,
        forAgentToken: "agent-token-demo-2",
        bookingId: null,
        savedTimeClockId: "rsv-agent-waiting-avery/saved-time",
      },
      skipped: [],
      repeated: false,
    });
    const rows = await db.sql<
      { id: string; state: string; why: string | null; at: Date | null; version: number }[]
    >`
      select id, state, released_why as why, released_at as at, version from reservations
      where for_phone_number = ${ALEX} or resource_id = 'res-avery'
      order by id collate "C"
    `;
    const letGo = { state: "released", why: "let_go", at: new Date("2026-11-07T15:06:00Z"), version: 2 };
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { id: "rsv-agent-waiting-avery", state: "held", why: null, at: null, version: 2 },
      { id: "rsv-agent-waiting-avery-second", state: "waiting", why: null, at: null, version: 1 },
      { id: "rsv-alex-haircut", state: "booked", why: null, at: null, version: 2 },
      { id: "rsv-alex-saved-avery", ...letGo },
      { id: "rsv-alex-wait-first", ...letGo },
      { id: "rsv-alex-wait-last", ...letGo },
      { id: "rsv-alex-wait-later", state: "waiting", why: null, at: null, version: 1 },
      { id: "rsv-alex-wait-riley", state: "waiting", why: null, at: null, version: 1 },
    ]);
  });

  it("a booked row's release does the same: Alex's cancelled haircut lets his own waiting row go and promotes the agent token in line", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-reservation.json");
    // Alex's haircut with Riley is booked for Oct 24, 15:00 to 15:30 (seed-reservation).
    await alexQueuedAsBefore(
      "rsv-alex-wait-haircut",
      "res-riley",
      "person-riley",
      "[2026-10-24T15:00:00Z,2026-10-24T15:30:00Z)",
      "2026-10-20T10:00:00Z",
    );
    await db.sql`insert into reservations ${db.sql({
      id: "rsv-token-wait-haircut",
      business_id: LEES,
      resource_id: "res-riley",
      resource_kind: "worker",
      worker_person_id: "person-riley",
      during: "[2026-10-24T15:00:00Z,2026-10-24T15:30:00Z)",
      state: "waiting",
      queued_at: "2026-10-20T10:01:00Z",
      for_agent_token: "agent-token-t1134",
    })}`;
    const outcome = await release(db.sql, {
      reservationId: "rsv-alex-haircut",
      businessId: LEES,
      expectVersion: 2,
      why: "cancelled",
      at: "2026-10-21T09:00:00Z",
    });
    expect(outcome).toMatchObject({
      result: "released",
      why: "cancelled",
      promoted: {
        reservationId: "rsv-token-wait-haircut",
        heldUntil: "2026-10-21T09:10:00Z",
        forAgentToken: "agent-token-t1134",
      },
      skipped: [],
    });
    expect(await getReservation(db.sql, "rsv-alex-wait-haircut")).toMatchObject({
      state: "released",
      releasedAt: "2026-10-21T09:00:00Z",
      releasedWhy: "let_go",
      version: 2,
    });
  });
});

// ---- T-1314: no failure to reach the database leaves raw --------------------------------------------------------------
//
// reserve and release answer a failure exactly as targets.ts's transientOrThrow does, under their K-05 names (Gives 1
// and 5); a socket's failure with no code under a statement is a lost connection, so no rollback is written to it
// (Gives 2, through bundles.ts's isLostConnection); a reserve() that never connects answers 08001 (Gives 3, through
// bundles.ts's reserveConnection). Each failure that can be made locally is raised for real: a closed port, a .invalid
// host, a login the local database refuses, a socket cut under a statement. The rest are built in postgres.js's and
// Node's shapes and raised through postgres.js's own socket option, so postgres.js passes each up as it does a socket's
// error. Each raw error is checked to hold what it names, and each outcome to hold none of it. Rule 9: the probe's user,
// password, database and hosts are made up here (.invalid names). A check names what leaked, never its value.

describe("T-1314: a failure to reach the database answers as targets.ts's transientOrThrow does, never raw", () => {
  const PROBE_USER = "t1314_probe_user";
  const PROBE_PASSWORD = "t1314-probe-password";
  const PROBE_DATABASE = "t1314_probe_db";
  /** RFC 6761: no name under .invalid ever resolves. */
  const UNRESOLVABLE_HOST = "rosie-t1314.invalid";
  /** The shapes' made-up host and port. */
  const SHAPE_HOST = "db-t1314.example.invalid";
  const SHAPE_PORT = 65124;
  const NEVER_OPENED: TransientError = { error: "transient", sqlstate: "08001" };
  const LOST: TransientError = { error: "transient", sqlstate: "08006" };
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** postgres.js's own PostgresError, which its type file gives no constructor of fields. */
  const { PostgresError } = postgres as unknown as {
    PostgresError: new (fields: Record<string, unknown>) => Error;
  };

  const probeUrl = (host: string, port: number): string =>
    `postgres://${PROBE_USER}:${PROBE_PASSWORD}@${host}:${String(port)}/${PROBE_DATABASE}`;

  type Secrets = Readonly<Record<string, RegExp>>;

  /** The secrets by name: a text wherever it appears, a number (a port) as a whole number. */
  function secretsOf(values: Readonly<Record<string, string | number>>): Secrets {
    const secrets: Record<string, RegExp> = {};
    for (const [name, value] of Object.entries(values)) {
      secrets[name] =
        typeof value === "number"
          ? new RegExp(`(^|[^0-9])${String(value)}([^0-9]|$)`)
          : new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
    return secrets;
  }

  /** A connection's own: its host, its port, the probe's user and its password. */
  const connectionSecrets = (host: string, port: number): Secrets =>
    secretsOf({ host, port, user: PROBE_USER, password: PROBE_PASSWORD });
  const SHAPE_SECRETS = connectionSecrets(SHAPE_HOST, SHAPE_PORT);

  /** Every text `value` holds, deeply: its own property names and values, enumerable or not (an error's stack too). */
  function textsOf(value: unknown, seen = new Set<object>()): string[] {
    if (typeof value === "string") {
      return [value];
    }
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
      return [String(value)];
    }
    if (typeof value !== "object" || value === null || seen.has(value)) {
      return [];
    }
    seen.add(value);
    const texts: string[] = [];
    for (const key of Object.getOwnPropertyNames(value)) {
      texts.push(key, ...textsOf((value as Record<string, unknown>)[key], seen));
    }
    return texts;
  }

  /** The names of the secrets `value` holds anywhere, never their values. */
  function leaksOf(value: unknown, secrets: Secrets): string[] {
    const texts = textsOf(value);
    return Object.entries(secrets)
      .filter(([, secret]) => texts.some((text) => secret.test(text)))
      .map(([name]) => name);
  }

  /** A local port nothing listens on: one the system just handed out and took back. */
  async function closedPort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    return port;
  }

  type Outcome = { answer: unknown } | { thrown: unknown };

  async function outcomeOf(run: () => Promise<unknown>): Promise<Outcome> {
    try {
      return { answer: await run() };
    } catch (error) {
      return { thrown: error };
    }
  }

  function syncOutcomeOf(run: () => unknown): Outcome {
    try {
      return { answer: run() };
    } catch (error) {
      return { thrown: error };
    }
  }

  /** What `promise` rejects with (it must reject). */
  async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    const outcome = await outcomeOf(() => promise);
    if (!("thrown" in outcome)) {
      throw new Error("the promise was fulfilled");
    }
    return outcome.thrown;
  }

  /** An error's own fields but its stack, which says where it was made. */
  function fieldsOf(error: unknown): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(error)) {
      if (key !== "stack") {
        fields[key] = (error as Record<string, unknown>)[key];
      }
    }
    return fields;
  }

  /**
   * `outcome` is what targets.ts's transientOrThrow makes of `raw` under `call`: the same answer, the same error thrown
   * as it is, or a scrubbed error of the same class with the same fields, the call's name among them.
   */
  function expectAsTargets(outcome: Outcome, raw: Error, call: string): void {
    const expected = syncOutcomeOf(() => transientOrThrow(raw, call));
    if ("answer" in expected) {
      expect(outcome, call).toEqual(expected);
      return;
    }
    const thrown = "thrown" in outcome ? outcome.thrown : undefined;
    if (expected.thrown === raw) {
      expect(thrown === raw, call).toBe(true);
      return;
    }
    expect(thrown instanceof Error && thrown !== raw, call).toBe(true);
    expect((thrown as Error).constructor, call).toBe((expected.thrown as Error).constructor);
    expect(fieldsOf(thrown), call).toEqual(fieldsOf(expected.thrown));
    expect(fieldsOf(thrown), call).toMatchObject({ call });
  }

  /**
   * A client on the made-up connection whose socket fails with `raw` before it opens, as Node's socket or TLS would fail
   * it (postgres.js's own socket option): postgres.js passes `raw` up as it does a socket's error.
   */
  function failingSocketClient(raw: Error): Sql {
    const options = { max: 1, onnotice: () => undefined, socket: () => Promise.reject(raw) };
    return postgres(probeUrl(SHAPE_HOST, SHAPE_PORT), options);
  }

  /**
   * A client whose statements run on `statements` and whose reserve() is `reserving`'s: the pre-probe answers, and only
   * reserve() opens a connection, as when the probe's connection was taken meanwhile and the one reserve() opens never
   * connects.
   */
  function reserveFrom(statements: Sql, reserving: Sql): Sql {
    return new Proxy(statements, {
      get: (target, key, receiver): unknown =>
        key === "reserve" ? () => reserving.reserve() : (Reflect.get(target, key, receiver) as unknown),
    });
  }

  // The shapes, as postgres.js and Node give them.
  /** postgres.js's own connection error (errors.js connection): "write <code> <host>:<port>". */
  const clientError = (code: string): Error =>
    Object.assign(new Error(`write ${code} ${SHAPE_HOST}:${String(SHAPE_PORT)}`), {
      code,
      errno: code,
      address: SHAPE_HOST,
      port: SHAPE_PORT,
    });
  /** Node's error for a connect its socket could not make: syscall connect, the address and the port. */
  const connectError = (code: string, errno: number): Error =>
    Object.assign(new Error(`connect ${code} ${SHAPE_HOST}:${String(SHAPE_PORT)}`), {
      errno,
      code,
      syscall: "connect",
      address: SHAPE_HOST,
      port: SHAPE_PORT,
    });
  /** Node's error for a name its lookup could not resolve. */
  const lookupError = (code: string, errno: number): Error =>
    Object.assign(new Error(`getaddrinfo ${code} ${SHAPE_HOST}`), {
      errno,
      code,
      syscall: "getaddrinfo",
      hostname: SHAPE_HOST,
    });
  /** The Workers build's socket error (cf/polyfills.js passes the socket's own failure up): no code. */
  const workersSocketError = (): Error =>
    new Error(`Network connection lost to ${SHAPE_HOST}:${String(SHAPE_PORT)}`);
  /** A socket's error whose code is a number, not a name (as a DOMException's is). */
  const numberCodedError = (): Error =>
    Object.assign(new Error(`connect to ${SHAPE_HOST} failed`), { name: "NetworkError", code: 19 });
  /** Node's TLS name check: the host and the certificate on the error. */
  const tlsNameError = (): Error =>
    Object.assign(new Error(`Hostname/IP does not match certificate's altnames: Host: ${SHAPE_HOST}.`), {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
      host: SHAPE_HOST,
      cert: { subject: { CN: "other.example.invalid" } },
    });
  /** postgres.js's generic error (errors.js generic): "<code>: <text>". */
  const genericError = (code: string, text: string): Error =>
    Object.assign(new Error(`${code}: ${text}`), { code });
  const refusedPassword = `password authentication failed for user "${PROBE_USER}"`;

  const SHAPES: { name: string; make: () => Error; holds: readonly string[] }[] = [
    {
      name: "postgres.js's CONNECT_TIMEOUT",
      make: () => clientError("CONNECT_TIMEOUT"),
      holds: ["host", "port"],
    },
    { name: "Node's ECONNREFUSED", make: () => connectError("ECONNREFUSED", -61), holds: ["host", "port"] },
    { name: "Node's ENOTFOUND", make: () => lookupError("ENOTFOUND", -3008), holds: ["host"] },
    { name: "Node's EAI_AGAIN", make: () => lookupError("EAI_AGAIN", -3001), holds: ["host"] },
    { name: "Node's ECONNRESET", make: () => connectError("ECONNRESET", -54), holds: ["host", "port"] },
    {
      name: "postgres.js's CONNECTION_CLOSED",
      make: () => clientError("CONNECTION_CLOSED"),
      holds: ["host", "port"],
    },
    {
      name: "a socket's failure with no code (the Workers build's)",
      make: workersSocketError,
      holds: ["host", "port"],
    },
    { name: "a socket's failure whose code is a number", make: numberCodedError, holds: ["host"] },
    {
      name: "PostgreSQL's 57P01",
      make: () => new PostgresError({ severity: "FATAL", code: "57P01", message: "terminating connection" }),
      holds: [],
    },
    {
      name: "PostgreSQL's 40P01 (a deadlock)",
      make: () => new PostgresError({ severity: "ERROR", code: "40P01", message: "deadlock detected" }),
      holds: [],
    },
    { name: "Node's TLS name check", make: tlsNameError, holds: ["host"] },
    { name: "Node's EACCES", make: () => connectError("EACCES", -13), holds: ["host", "port"] },
    {
      name: "postgres.js's SASL_SIGNATURE_MISMATCH",
      make: () => genericError("SASL_SIGNATURE_MISMATCH", "The server did not return the correct signature"),
      holds: [],
    },
    {
      name: "PostgreSQL's 28P01, naming the user",
      make: () => new PostgresError({ severity: "FATAL", code: "28P01", message: refusedPassword }),
      holds: ["user"],
    },
    {
      name: "a PostgresError with no SQLSTATE, naming the user",
      make: () => new PostgresError({ severity: "FATAL", message: refusedPassword }),
      holds: ["user"],
    },
    {
      name: "a statement's own refusal (23505), thrown as it is",
      make: () => new PostgresError({ severity: "ERROR", code: "23505", message: "duplicate key value" }),
      holds: [],
    },
    {
      name: "a TypeError for a value postgres.js cannot send, thrown as it is",
      make: () => new TypeError("Do not know how to serialize a BigInt"),
      holds: [],
    },
  ];

  const accessFixture = (file: string): AccessFixture => readJson(new URL(file, ACCESS_DIR)) as AccessFixture;
  const CALLS: [string, (sql: Sql) => Promise<unknown>][] = [
    ["reserve", (sql) => reserve(sql, accessFixture("reserve-10-min.json").request as ReserveRequest)],
    ["release", (sql) => release(sql, accessFixture("release-expired-promotes.json").request as never)],
  ];

  describe("Gives 1 and 5: reserve and release answer as targets.ts's transientOrThrow does, under their names", () => {
    it.each(SHAPES)("$name", async ({ make, holds }) => {
      for (const [call, run] of CALLS) {
        const raw = make();
        expect(leaksOf(raw, SHAPE_SECRETS), call).toEqual(expect.arrayContaining([...holds]));
        const sql = failingSocketClient(raw);
        let outcome: Outcome;
        try {
          outcome = await outcomeOf(() => run(sql));
        } finally {
          await sql.end({ timeout: 0 });
        }
        // postgres.js rejected the call's first statement with the socket's error, the statement put on it.
        expect(Object.hasOwn(raw, "query"), call).toBe(true);
        expectAsTargets(outcome, raw, call);
        if (!("thrown" in outcome && outcome.thrown === raw)) {
          expect(leaksOf(outcome, SHAPE_SECRETS), call).toEqual([]);
        }
      }
    });

    it("a closed port (ECONNREFUSED) and an unresolvable .invalid host answer 08001 from both, holding none of it", async () => {
      const port = await closedPort();
      for (const [host, hostPort] of [
        ["127.0.0.1", port],
        [UNRESOLVABLE_HOST, SHAPE_PORT],
      ] as const) {
        for (const [call, run] of CALLS) {
          const client = createClient({ primaryUrl: probeUrl(host, hostPort), max: 1, env: {} });
          try {
            const outcome = await run(client.primary);
            expect(outcome, call).toEqual(NEVER_OPENED);
            expect(leaksOf(outcome, connectionSecrets(host, hostPort)), call).toEqual([]);
          } finally {
            await client.close();
          }
        }
      }
    });

    it("a login the local database refuses (class 28, naming the user) is thrown as DataAccessDatabaseError under each call's name", async () => {
      const url = new URL(resolvePrimaryUrl());
      url.username = PROBE_USER;
      url.password = PROBE_PASSWORD;
      const secrets = connectionSecrets(url.hostname, url.port === "" ? 5432 : Number(url.port));
      for (const [call, run] of CALLS) {
        const client = createClient({ primaryUrl: url.toString(), max: 1, env: {} });
        try {
          const thrown = await rejectionOf(run(client.primary));
          expect(thrown, call).toBeInstanceOf(DataAccessDatabaseError);
          expect(thrown, call).toMatchObject({ call, table: null, constraint: null });
          expect(["28P01", "28000"], call).toContain((thrown as { code: string }).code);
          expect(leaksOf(thrown, secrets), call).toEqual([]);
        } finally {
          await client.close();
        }
      }
    });
  });

  describe("Gives 3: a reserve() that never connects answers 08001 from reserve and release", () => {
    it("as the Workers build passes it up (no code, no statement)", async () => {
      for (const [call, run] of CALLS) {
        const raw = workersSocketError();
        const reserving = failingSocketClient(raw);
        try {
          const outcome = await run(reserveFrom(db.sql, reserving));
          expect(outcome, call).toEqual(NEVER_OPENED);
          expect(leaksOf(outcome, SHAPE_SECRETS), call).toEqual([]);
        } finally {
          await reserving.end({ timeout: 0 });
        }
        // postgres.js passed the socket's error up as it is (connection.js queryError: no statement on a reserve()'s
        // error), with no code and its host and port in its message: targets.ts's transientOrThrow alone would throw it
        // as it is.
        expect((raw as { code?: unknown }).code, call).toBeUndefined();
        expect(Object.hasOwn(raw, "query") || Object.hasOwn(raw, "parameters"), call).toBe(false);
        expect(leaksOf(raw, SHAPE_SECRETS), call).toEqual(expect.arrayContaining(["host", "port"]));
        expect(
          syncOutcomeOf(() => transientOrThrow(raw, call)),
          call,
        ).toEqual({ thrown: raw });
      }
    });

    it("for real on a closed port (Node's ECONNREFUSED, on no statement)", async () => {
      const port = await closedPort();
      for (const [call, run] of CALLS) {
        const reserving = postgres(probeUrl("127.0.0.1", port), { max: 1, onnotice: () => undefined });
        try {
          const outcome = await run(reserveFrom(db.sql, reserving));
          expect(outcome, call).toEqual(NEVER_OPENED);
          expect(leaksOf(outcome, connectionSecrets("127.0.0.1", port)), call).toEqual([]);
        } finally {
          await reserving.end({ timeout: 0 });
        }
      }
    });
  });

  describe("Gives 2: a socket's failure with no code under a statement writes no rollback, and nothing is written", () => {
    /**
     * A one-connection client of the test schema whose sockets the test holds, so it can fail the live one as the Workers
     * build's socket fails: an error with no code (cf/polyfills.js), which postgres.js puts the statement in flight on.
     */
    function cuttableClient(): { sql: Sql; cut: () => void } {
      const url = new URL(resolvePrimaryUrl());
      const sockets: net.Socket[] = [];
      const options = {
        max: 1,
        onnotice: () => undefined,
        connection: { search_path: `${db.schema}, public` },
        socket: () => {
          const socket = net.connect(Number(url.port === "" ? "5432" : url.port), url.hostname);
          sockets.push(socket);
          return socket;
        },
      };
      return {
        sql: postgres(url.toString(), options),
        cut: () => {
          sockets.at(-1)?.destroy(workersSocketError());
        },
      };
    }

    /**
     * Runs `call` on a cuttable client while another connection holds the slot's advisory lock (the one lockSlot takes),
     * cuts the call's socket once its backend waits on that lock, and returns the call's answer and the same request sent
     * again on that client once the lock is let go (after `beforeResend`, which reads what the cut call left), until one
     * answers without transient (at most 4). Were a rollback written to the dead connection, the call would never answer
     * (postgres.js keeps a write to a destroyed socket queued) and the test would time out.
     */
    async function answerAfterCut<T>(
      call: (sql: Sql) => Promise<T>,
      beforeResend: () => Promise<void>,
    ): Promise<{ answer: T; resends: T[] }> {
      const holder = postgres(resolvePrimaryUrl(), { max: 1, onnotice: () => undefined });
      const victim = cuttableClient();
      try {
        let letGo: () => void = () => undefined;
        const hold = new Promise<void>((resolve) => {
          letGo = resolve;
        });
        let locked: () => void = () => undefined;
        const isLocked = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const holding = holder.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtextextended(${"resource:res-riley"}, 0))`;
          locked();
          await hold;
        });
        await isLocked;
        const [backend] = await victim.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
        const pid = backend?.pid ?? 0;
        const answering = call(victim.sql);
        let waiting = false;
        for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
          const [state] = await db.sql<{ waiting: boolean }[]>`
            select (wait_event_type = 'Lock') as waiting from pg_stat_activity where pid = ${pid}
          `;
          waiting = state?.waiting === true;
          if (!waiting) {
            await sleep(50);
          }
        }
        expect(waiting).toBe(true);
        victim.cut();
        const answer = await answering;
        letGo();
        await holding;
        await beforeResend();
        const resends: T[] = [];
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const again = await call(victim.sql);
          resends.push(again);
          if ((again as { error?: string }).error !== "transient") {
            break;
          }
        }
        return { answer, resends };
      } finally {
        await victim.sql.end({ timeout: 0 });
        await holder.end({ timeout: 5 });
      }
    }

    /** At most one stale transient, then the answer the call gives on a working connection. */
    function expectResent(resends: unknown[], expected: Record<string, unknown>): void {
      expect(resends.length).toBeGreaterThanOrEqual(1);
      expect(resends.length).toBeLessThanOrEqual(2);
      for (const stale of resends.slice(0, -1)) {
        expect(stale).toMatchObject({ error: "transient" });
      }
      expect(resends.at(-1)).toMatchObject(expected);
    }

    it("reserve() waiting on the slot lock, its socket failing with no code, answers 08006 and writes nothing; the same request then holds the time", async () => {
      await emptyTables(db.sql);
      await loadFixture(db.sql, "seed-reservation.json");
      const asked = request({ reservationId: "cut-reserve" });
      const { answer, resends } = await answerAfterCut(
        (sql) => reserve(sql, asked),
        async () => {
          expect(await getReservation(db.sql, "cut-reserve")).toBeNull();
        },
      );
      expect(answer).toEqual(LOST);
      expectResent(resends, { result: "held", reservationId: "cut-reserve", repeated: false });
      expect(await getReservation(db.sql, "cut-reserve")).toMatchObject({ state: "held", version: 1 });
    }, 30_000);

    it("release() waiting on the slot lock, its socket failing with no code, answers 08006 and writes nothing; the same request then releases", async () => {
      await emptyTables(db.sql);
      await loadFixture(db.sql, "seed-reservation.json");
      expect(await reserve(db.sql, request({ reservationId: "cut-release" }))).toMatchObject({
        result: "held",
      });
      const asked = {
        reservationId: "cut-release",
        businessId: "biz-lees-barbershop",
        expectVersion: 1,
        why: "let_go" as const,
        at: "2026-11-07T15:06:00Z",
      };
      const { answer, resends } = await answerAfterCut(
        (sql) => release(sql, asked),
        async () => {
          expect(await getReservation(db.sql, "cut-release")).toMatchObject({ state: "held", version: 1 });
        },
      );
      expect(answer).toEqual(LOST);
      expectResent(resends, { result: "released", version: 2, repeated: false });
      expect(await getReservation(db.sql, "cut-release")).toMatchObject({ state: "released", version: 2 });
    }, 30_000);
  });
});

// ---- T-1350: inScopedTransaction decides its rollback and its release by targets.ts's foundGone (T-1334's handoff a) --
//
// reserve and release run inScopedTransaction, which decides as inRuntimeTransaction does (T-1334, DL-649): a connection
// fn found gone (a lost connection, or a statement's failure that is a session's failure or that transientOrThrow answers
// 08001) is sent no rollback and is never released. A rosie_job client of this file's schema (one connection; the
// runtime side's role holds the grants on reservations and resources both calls use, behind the business's scope) has
// its socket cut the 8 ways T-1334 cut inRuntimeTransaction's: as fn's first statement is written, which is then never
// written; and (T-1330's note d) at the first turn of the event loop after fn's first statement is answered, the
// connection idle in its transaction, by which time fn's next statement is already in flight, so postgres.js rejects it
// with the socket's error, or with its own CONNECTION_CLOSED. The socket is destroyed with an error built in the shape
// Node, OpenSSL or postgres.js gives it, or with none. A probe cut the same way shows each raw error holds what it names
// and the value of the statement it rejected, so the checks mean something; each outcome holds none of it, nor any value
// fn's statements carried; nothing is sent after the cut, no rollback and no commit; nothing is thrown outside a promise;
// a statement sent on the same client at once is answered on a new connection, so the dead connection was never released
// to the pool; and the call then answers on the same client. An error fn makes itself, on no statement (a value of the
// request fn reads after its first statement, which then throws in the shape of Node's EACCES, an address and a port on
// it), found no connection gone, whatever its code: it is rolled back, and the connection is released.
//
// Rule 9: the probe's user, password, database, host, address and value are made up here (a .invalid name, RFC 5737's
// documentation address), as are the ids the calls ask for. A check names what leaked, never its value.

describe("T-1350: inScopedTransaction writes no rollback to a connection fn found gone, and never releases it (targets.ts foundGone)", () => {
  const PROBE_USER = "t1350_probe_user";
  const PROBE_PASSWORD = "t1350-probe-password";
  const PROBE_DATABASE = "t1350_probe_db";
  const HOST = "db-t1350.example.invalid";
  const ADDRESS = "203.0.113.50";
  const PORT = 65150;
  /** The runtime side's role (T-191). */
  const RUNTIME_ROLE = "rosie_job";
  const NEVER_OPENED: TransientError = { error: "transient", sqlstate: "08001" };
  const LOST: TransientError = { error: "transient", sqlstate: "08006" };
  /** The transaction's setting of its business scope: fn's first statement is the one built right after it. */
  const SCOPE = "select set_config($1, $2, true)";
  /** The probe's statement as postgres.js builds it, and the value it carries. */
  const PROBE_STATEMENT = "select $1::text as t1350_cut";
  const PROBE_VALUE = "t1350-probe-value";
  /** How long a call may take before it counts as never settled (a statement written to no socket never settles). */
  const SETTLES_WITHIN = 10_000;
  const CUT_TIMEOUT = 60_000;

  type Secrets = Readonly<Record<string, RegExp>>;
  type Outcome = { answer: unknown } | { thrown: unknown };
  /** What a call gives: K-05's answer, or an error thrown scrubbed to the call's name and this code alone. */
  type Expected = { answer: unknown } | { code: string };

  const probeUrl = (host: string, port: number): string =>
    `postgres://${PROBE_USER}:${PROBE_PASSWORD}@${host}:${String(port)}/${PROBE_DATABASE}`;

  /** The secrets by name: a text wherever it appears, a number (a port) as a whole number. */
  function secretsOf(values: Readonly<Record<string, string | number>>): Secrets {
    const secrets: Record<string, RegExp> = {};
    for (const [name, value] of Object.entries(values)) {
      secrets[name] =
        typeof value === "number"
          ? new RegExp(`(^|[^0-9])${String(value)}([^0-9]|$)`)
          : new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
    return secrets;
  }

  /** The made-up connection the built errors name. */
  const SHAPE_SECRETS = secretsOf({
    host: HOST,
    address: ADDRESS,
    port: PORT,
    user: PROBE_USER,
    password: PROBE_PASSWORD,
    database: PROBE_DATABASE,
  });

  /**
   * What an outcome must never hold: the made-up connection, and the local server's host and port, which postgres.js's
   * own CONNECTION_CLOSED names. The local login, password and database are `rosie`, this repository's own folder, which
   * every stack's file paths name, so they are not listed: postgres.js's connection errors never carry them.
   */
  function cutSecrets(): Secrets {
    const url = new URL(resolvePrimaryUrl());
    const port = url.port === "" ? 5432 : Number(url.port);
    return { ...SHAPE_SECRETS, ...secretsOf({ "server host": url.hostname, "server port": port }) };
  }

  /** The texts of 8 characters or more among statements' values (their parameters), each named by its place alone. */
  function valueSecrets(values: readonly (readonly unknown[])[]): Secrets {
    const texts = values
      .flat()
      .filter((value): value is string => typeof value === "string" && value.length >= 8);
    return secretsOf(Object.fromEntries(texts.map((text, index) => [`value ${String(index + 1)}`, text])));
  }

  /** Every text `value` holds, deeply: its own property names and values, enumerable or not (an error's stack too). */
  function textsOf(value: unknown, seen = new Set<object>()): string[] {
    if (typeof value === "string") {
      return [value];
    }
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
      return [String(value)];
    }
    if (typeof value !== "object" || value === null || seen.has(value)) {
      return [];
    }
    seen.add(value);
    return Object.getOwnPropertyNames(value).flatMap((key) => [
      key,
      ...textsOf((value as Record<string, unknown>)[key], seen),
    ]);
  }

  /** The names of the secrets `value` holds anywhere, never their values. */
  function leaksOf(value: unknown, secrets: Secrets): string[] {
    const texts = textsOf(value);
    return Object.entries(secrets)
      .filter(([, secret]) => texts.some((text) => secret.test(text)))
      .map(([name]) => name);
  }

  async function outcomeOf(run: () => Promise<unknown>): Promise<Outcome> {
    try {
      return { answer: await run() };
    } catch (error) {
      return { thrown: error };
    }
  }

  /**
   * What `run` gives, or "never settled" after SETTLES_WITHIN, and every error thrown outside any promise meanwhile:
   * postgres.js writes a statement from a timer, so a write to a connection with no socket throws there.
   */
  async function watched(
    run: () => Promise<unknown>,
  ): Promise<{ outcome: Outcome | "never settled"; uncaught: unknown[] }> {
    const uncaught: unknown[] = [];
    const note = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", note);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        outcomeOf(run),
        new Promise<"never settled">((resolve) => {
          timer = setTimeout(() => {
            resolve("never settled");
          }, SETTLES_WITHIN);
        }),
      ]);
      // A write postgres.js put on a timer has run by the next turn of the event loop.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      return { outcome, uncaught };
    } finally {
      clearTimeout(timer);
      process.off("uncaughtException", note);
    }
  }

  /** `outcome` is `expected`: the answer, or an error with the call's name and the code alone, nothing of the original. */
  function expectOutcome(outcome: Outcome | "never settled", expected: Expected, call: string): void {
    if ("answer" in expected) {
      expect(outcome, call).toEqual({ answer: expected.answer });
      return;
    }
    if (outcome === "never settled" || !("thrown" in outcome)) {
      throw new Error(`${call} did not throw`);
    }
    const { thrown } = outcome;
    expect(thrown, call).toBeInstanceOf(Error);
    expect(Object.getOwnPropertyNames(thrown).sort(), call).toEqual(["call", "code", "message", "stack"]);
    expect(thrown, call).toMatchObject({
      call,
      code: expected.code,
      message: `${call}: the database call failed (code ${expected.code})`,
    });
  }

  // The errors, in the shapes Node, OpenSSL and postgres.js give them, each naming the made-up connection.

  /** postgres.js's own connection error (errors.js connection): "write <code> <host>:<port>". */
  const connectionError = (code: string): Error =>
    Object.assign(new Error(`write ${code} ${HOST}:${String(PORT)}`), {
      code,
      errno: code,
      address: HOST,
      port: PORT,
    });
  /** Node's error for a connection the other end reset under a read: syscall read, and no address on it. */
  const resetError = (): Error =>
    Object.assign(new Error("read ECONNRESET"), { errno: -54, code: "ECONNRESET", syscall: "read" });
  /** A socket's failure with no code (the Workers build's), naming the made-up connection string. */
  const codelessError = (): Error => new Error(`the socket closed: ${probeUrl(HOST, PORT)}`);
  /** Node's error on a connected socket's read or write: the syscall, the address and the port. */
  const socketError = (syscall: string, code: string, errno: number): Error =>
    Object.assign(new Error(`${syscall} ${code} ${ADDRESS}:${String(PORT)}`), {
      errno,
      code,
      syscall,
      address: ADDRESS,
      port: PORT,
    });
  /** OpenSSL's error for a record it could not decrypt, as Node's TLS socket gives it, the made-up host and port in it. */
  const tlsRecordError = (): Error =>
    Object.assign(
      new Error(`error:0A000119:SSL routines::decryption failed or bad record mac (${HOST}:${String(PORT)})`),
      {
        library: "SSL routines",
        reason: "decryption failed or bad record mac",
        code: "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC",
      },
    );
  /** A socket's error that no list names, known only by a connection's marks (syscall, errno), the made-up host on it. */
  const ioError = (): Error =>
    Object.assign(new Error(`read EIO ${HOST}`), { errno: -5, code: "EIO", syscall: "read", hostname: HOST });

  /** T-1334's 8 ways: isLostConnection's own 4 (T-1330's), then DL-649's 4, which only foundGone knows. */
  const CUTS: { name: string; raw: () => Error | null; holds: readonly string[]; expected: Expected }[] = [
    {
      name: "the socket closes: postgres.js's own CONNECTION_CLOSED, the server's host and port in it",
      raw: () => null,
      holds: ["server host", "server port"],
      expected: { answer: LOST },
    },
    {
      name: "postgres.js's CONNECTION_CLOSED, the made-up host and port on it",
      raw: () => connectionError("CONNECTION_CLOSED"),
      holds: ["host", "port"],
      expected: { answer: LOST },
    },
    { name: "Node's ECONNRESET under a read", raw: resetError, holds: [], expected: { answer: LOST } },
    {
      name: "a socket's failure with no code (the Workers build's), the made-up connection string in it",
      raw: codelessError,
      holds: ["host", "port", "user", "password", "database"],
      expected: { answer: LOST },
    },
    {
      name: "Node's EHOSTUNREACH under a read, the made-up address and port on it (answered 08001)",
      raw: () => socketError("read", "EHOSTUNREACH", -65),
      holds: ["address", "port"],
      expected: { answer: NEVER_OPENED },
    },
    {
      name: "Node's EPERM on a write, the made-up address and port on it (a session's failure)",
      raw: () => socketError("write", "EPERM", -1),
      holds: ["address", "port"],
      expected: { code: "EPERM" },
    },
    {
      name: "OpenSSL's bad record MAC under a read, the made-up host and port in it (a TLS error)",
      raw: tlsRecordError,
      holds: ["host", "port"],
      expected: { code: "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC" },
    },
    {
      name: "Node's EIO under a read, known by a connection's marks alone, the made-up host on it",
      raw: ioError,
      holds: ["host"],
      expected: { code: "EIO" },
    },
  ];

  /**
   * Where a client's socket is cut, with `raw` or none (it closes): `write`, as the statement `on` picks (the last built)
   * is written, which is then never written; `answered`, at the first turn of the event loop after that statement's
   * answer has come (its ReadyForQuery), the connection idle in its transaction.
   */
  interface Cut {
    on: (sent: readonly string[]) => boolean;
    when: "write" | "answered";
    raw: Error | null;
  }

  /** A chunk the server sent that ends with ReadyForQuery ('Z', length 5, the transaction's status): an answer's end. */
  function endsAnswer(chunk: unknown): boolean {
    if (!(chunk instanceof Uint8Array) || chunk.length < 6) {
      return false;
    }
    const at = chunk.length - 6;
    return [0x5a, 0, 0, 0, 5].every((byte, index) => chunk[at + index] === byte);
  }

  /**
   * A client of this file's schema as rosie_job (the schema first), one connection, through a socket to the same server
   * that is cut once, as `cut` says (postgres.js's own socket option, as targets.int.test.ts cuts one for T-1334). `sent`
   * holds each statement's text as postgres.js built it (its debug hook), in order, and `values` its parameters: a
   * statement written to a connection with no socket is built, so it is listed too. `builtAtCut` is how many statements
   * were built when the socket was cut.
   */
  function cutClient(cut: Cut | null): {
    sql: Sql;
    sent: string[];
    values: unknown[][];
    builtAtCut: () => number | undefined;
  } {
    const url = new URL(resolvePrimaryUrl());
    const sent: string[] = [];
    const values: unknown[][] = [];
    let armed = false;
    let builtAtCut: number | undefined;
    const destroy = (socket: net.Socket): void => {
      builtAtCut = sent.length;
      socket.destroy(cut?.raw ?? undefined);
    };
    const options = {
      max: 1,
      onnotice: () => undefined,
      connection: {
        application_name: "rosie-t1350-reservations-cut",
        search_path: `${db.schema}, public`,
        role: RUNTIME_ROLE,
      },
      debug: (_connection: number, text: string, parameters: unknown[]) => {
        sent.push(text.trim());
        values.push([...parameters]);
        if (cut !== null && builtAtCut === undefined && !armed && cut.on(sent)) {
          armed = true;
        }
      },
      socket: () => {
        const socket = net.connect(Number(url.port === "" ? "5432" : url.port), url.hostname);
        const write = socket.write.bind(socket);
        socket.write = ((...args: Parameters<typeof write>) => {
          if (!armed || cut?.when !== "write") return write(...args);
          armed = false;
          destroy(socket);
          return true;
        }) as typeof socket.write;
        const emit = socket.emit.bind(socket);
        socket.emit = ((event: string | symbol, ...args: unknown[]) => {
          const emitted = emit(event, ...args);
          if (armed && cut?.when === "answered" && event === "data" && endsAnswer(args[0])) {
            armed = false;
            setImmediate(() => {
              destroy(socket);
            });
          }
          return emitted;
        }) as typeof socket.emit;
        return socket;
      },
    };
    return { sql: postgres(resolvePrimaryUrl(), options), sent, values, builtAtCut: () => builtAtCut };
  }

  /** fn's first statement: the one built right after the transaction set its business scope. */
  const fnsFirst = (sent: readonly string[]): boolean => sent.at(-2) === SCOPE;

  // The two calls on inScopedTransaction, each on ids no fixture holds.
  const RESERVE = request({ reservationId: "rsv-t1350-reserve", resourceId: "res-t1350-none" });
  const RELEASE: Parameters<typeof release>[1] = {
    reservationId: "rsv-t1350-release",
    businessId: "biz-lees-barbershop",
    expectVersion: 1,
    why: "let_go",
    at: "2026-11-07T15:05:00Z",
  };
  const CALLS: { call: string; run: (sql: Sql) => Promise<unknown>; answers: Record<string, unknown> }[] = [
    {
      call: "reserve",
      run: (sql) => reserve(sql, RESERVE),
      answers: { error: "notBookable", resourceId: "res-t1350-none" },
    },
    {
      call: "release",
      run: (sql) => release(sql, RELEASE),
      answers: { error: "notFound", table: "reservations", rowId: "rsv-t1350-release" },
    },
  ];

  /**
   * The probe: a statement cut as `raw` makes it, as it is written, is rejected with an error that holds what the shape
   * names and the statement's value, the statement put on it.
   */
  async function expectProbeHolds(raw: Error | null, holds: readonly string[]): Promise<void> {
    const probe = cutClient({ on: (sent) => sent.at(-1) === PROBE_STATEMENT, when: "write", raw });
    let rejected: Outcome;
    try {
      rejected = await outcomeOf(() => probe.sql`select ${PROBE_VALUE}::text as t1350_cut`);
    } finally {
      await probe.sql.end({ timeout: 0 });
    }
    if (!("thrown" in rejected)) {
      throw new Error("the cut statement answered");
    }
    const secrets = { ...cutSecrets(), ...secretsOf({ value: PROBE_VALUE }) };
    expect(leaksOf(rejected.thrown, secrets)).toEqual(expect.arrayContaining([...holds, "value"]));
    expect(Object.hasOwn(rejected.thrown as object, "query")).toBe(true);
  }

  /** Each call on a client cut as the shape and `when` say: see the top of this block. */
  async function expectCut(shape: (typeof CUTS)[number], when: Cut["when"]): Promise<void> {
    await expectProbeHolds(shape.raw(), shape.holds);
    for (const { call, run, answers } of CALLS) {
      const raw = shape.raw();
      const client = cutClient({ on: fnsFirst, when, raw });
      try {
        const watchedRun = await watched(async () => {
          const called = await outcomeOf(() => run(client.sql));
          const builtBefore = client.sent.length;
          // At once: a statement that a dead connection released to the pool would take and never answer (postgres.js
          // 3.4.9 queues its write on that connection, and the close then drops it). Not released, it waits for the
          // pool to reconnect.
          const followed = await outcomeOf(async () => [
            ...(await client.sql<{ n: number }[]>`select 2 as n`),
          ]);
          return { called, builtBefore, followed };
        });
        expect(watchedRun.outcome, call).not.toBe("never settled");
        expect(watchedRun.uncaught, call).toEqual([]);
        const { called, builtBefore, followed } = (
          watchedRun.outcome as { answer: { called: Outcome; builtBefore: number; followed: Outcome } }
        ).answer;
        // The statement in flight at the cut: fn's first (write), or fn's second, already built when the connection,
        // idle after fn's first was answered, closed (answered). It is the last one built: no rollback, no commit.
        const first = client.sent.lastIndexOf(SCOPE) + 1;
        const inFlight = when === "write" ? first : first + 1;
        expect(client.builtAtCut(), call).toBe(inFlight + 1);
        expect(builtBefore, call).toBe(inFlight + 1);
        // Neither the connection's details nor any value fn's statements carried leaves.
        const carried = valueSecrets(client.values.slice(first, inFlight + 1));
        expect(Object.keys(carried).length, call).toBeGreaterThan(0);
        expect(leaksOf(called, { ...cutSecrets(), ...carried }), call).toEqual([]);
        expectOutcome(called, shape.expected, call);
        if (raw !== null) {
          // postgres.js rejected the statement in flight with the raw error, that statement and its values put on it.
          expect(Object.hasOwn(raw, "query"), call).toBe(true);
          const inFlightValues = valueSecrets(client.values.slice(inFlight, inFlight + 1));
          expect(leaksOf(raw, inFlightValues), call).toEqual(Object.keys(inFlightValues));
        }
        // The dead connection was never released: the next statement waited for a new one, which answered it.
        expect(followed, call).toEqual({ answer: [{ n: 2 }] });
        // And the call itself answers on the same client.
        const again = await watched(() => run(client.sql));
        expect(again.uncaught, call).toEqual([]);
        expect(again.outcome, call).toMatchObject({ answer: answers });
      } finally {
        await client.sql.end({ timeout: 0 });
      }
    }
  }

  it.each(CUTS)(
    "fn's first statement cut as it is written ($name): no rollback, nothing thrown outside a promise, the error that leaves scrubbed; the same client then answers",
    async (shape) => {
      await expectCut(shape, "write");
    },
    CUT_TIMEOUT,
  );

  it.each(CUTS)(
    "the connection closing while idle after fn's first statement is answered ($name): fn's next statement is in flight, so the same holds",
    async (shape) => {
      await expectCut(shape, "answered");
    },
    CUT_TIMEOUT,
  );

  it("an error fn makes itself, on no statement, found no connection gone, whatever its code: rolled back and released", async () => {
    const own = socketError("connect", "EACCES", -13);
    expect(leaksOf(own, SHAPE_SECRETS)).toEqual(expect.arrayContaining(["address", "port"]));
    const client = cutClient(null);
    // fn (releaseIn) reads the request's `at` again for its second statement, after its first has been built, and that
    // read throws.
    const fnStarted = (): boolean => {
      const scope = client.sent.lastIndexOf(SCOPE);
      return scope !== -1 && scope < client.sent.length - 1;
    };
    const asked: Parameters<typeof release>[1] = {
      ...RELEASE,
      get at(): string {
        if (fnStarted()) {
          throw own;
        }
        return RELEASE.at;
      },
    };
    try {
      const [before] = await client.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const { outcome, uncaught } = await watched(() => release(client.sql, asked));
      expect(uncaught).toEqual([]);
      // Rolled back: the rollback is the last statement built, after fn's first.
      expect(client.sent.at(-1)).toBe("rollback");
      expect(client.sent.at(-3)).toBe(SCOPE);
      // release answers it as targets.ts's transientOrThrow does: a session's failure, thrown scrubbed.
      expect(leaksOf(outcome, cutSecrets())).toEqual([]);
      expectOutcome(outcome, { code: "EACCES" }, "release");
      // Released: the client's one connection, the same backend, answers the next statement, its scope gone.
      const next = await watched(async () => [
        ...(await client.sql<{ pid: number; scope: string | null }[]>`
          select pg_backend_pid() as pid, nullif(current_setting(${SCOPE_SETTING}, true), '') as scope
        `),
      ]);
      expect(next.outcome).toEqual({ answer: [{ pid: before?.pid, scope: null }] });
    } finally {
      await client.sql.end({ timeout: 0 });
    }
  });

  // ---- T-1362: inSavepoint decides by foundGone too (T-1350's builder handoff b, its security review's new task a) ----
  //
  // reserveIn and releaseIn do part of their work inside a savepoint (inSavepoint): reserveIn its insert (a held row; a
  // class seat with its counter; or, once EXCLUDE refused the held row in the transaction's first savepoint, a waiting
  // row in its second), releaseIn its promotion of the next in line. A connection the savepoint's work found gone
  // (foundGone) is sent no `rollback to savepoint` and no other statement: postgres.js 3.4.9 would queue it behind the
  // statement the failure rejected and never settle it. The failure then leaves through inScopedTransaction as above.
  // The same rosie_job client has its socket cut the same 8 ways at the same 2 points, now at the savepoint's first
  // statement: as it is written; and at the first turn of the event loop after it is answered, by which time the
  // savepoint's next statement (its release, or the class seat's counter) is in flight. Each call settles within
  // SETTLES_WITHIN; nothing is built after the statement in flight; nothing is thrown outside a promise; the outcome is
  // scrubbed; a statement sent at once is answered on a new connection (another backend), so the dead one was never
  // released; and the call then answers on the same client as it would have, so the cut call wrote nothing. A failure
  // the savepoint's work meets on a live connection is still rolled back to the savepoint: a statement's own refusal
  // (EXCLUDE's 23P01, the statement put on it), after which the transaction goes on; and an error the work makes itself
  // on no statement, in the shape of Node's EACCES, after which the transaction is rolled back and the connection
  // released.
  //
  // Rule 9: the rows are fixture set v1's (seed-reservation.json), and the other rows and ids are made up here.

  describe("T-1362: inSavepoint writes no `rollback to savepoint` to a connection the savepoint's work found gone (targets.ts foundGone)", () => {
    const LEES = "biz-lees-barbershop";
    const YOGA = "biz-yoga-studio";
    /** A class session with room, made here: seed-class-seats.json loads its resources again beside seed-reservation. */
    const CLASS = "res-t1362-class";
    /** The start of a savepoint, as inSavepoint builds it, and its name. */
    const SAVEPOINT = /^savepoint (rosie_sp_\d+)$/;

    const HELD_ASKED = request({ reservationId: "rsv-t1362-held" });
    const SEAT_ASKED = request({
      reservationId: "rsv-t1362-seat",
      businessId: YOGA,
      resourceId: CLASS,
      during: { start: "2026-12-05T17:00:00Z", end: "2026-12-05T18:00:00Z" },
    });
    /** Riley's Dec 2 time, which another agent token holds (seed below), so EXCLUDE refuses the held row first. */
    const WAITING_ASKED = request({
      reservationId: "rsv-t1362-waiting",
      during: { start: "2026-12-02T16:00:00Z", end: "2026-12-02T16:30:00Z" },
      waitIfSaved: true,
    });
    const WAITING_ANSWER: ReserveOutcome = {
      result: "waiting",
      reservationId: "rsv-t1362-waiting",
      version: 1,
      resourceId: "res-riley",
      during: { start: "2026-12-02T16:00:00Z", end: "2026-12-02T16:30:00Z" },
      queuedAt: "2026-11-07T15:05:00Z",
      repeated: false,
    };
    /** Alex's saved time with Avery (seed-reservation.json), let go: the agent token first in line is promoted. */
    const RELEASE_ASKED: Parameters<typeof release>[1] = {
      reservationId: "rsv-alex-saved-avery",
      businessId: LEES,
      expectVersion: 1,
      why: "let_go",
      at: "2026-11-07T15:06:00Z",
    };

    /** Fixture set v1's reservations, a class session of 20 seats, and Riley's Dec 2 time held by another agent token. */
    async function seed(): Promise<void> {
      await emptyTables(db.sql);
      await loadFixture(db.sql, "seed-reservation.json");
      await createResource(db.sql, {
        id: CLASS,
        businessId: YOGA,
        kind: "class_session",
        name: "T-1362 class",
      });
      await createClassSeats(db.sql, { resourceId: CLASS, businessId: YOGA, capacity: 20 });
      await db.sql`insert into reservations ${db.sql({
        id: "rsv-t1362-taken",
        business_id: LEES,
        resource_id: "res-riley",
        resource_kind: "worker",
        worker_person_id: "person-riley",
        during: "[2026-12-02T16:00:00Z,2026-12-02T16:30:00Z)",
        state: "held",
        held_until: "2026-11-07T15:15:00Z",
        for_agent_token: "agent-t1362-taken",
      })}`;
    }

    /** The index of the last savepoint's start among `sent`, or -1. */
    function lastSavepoint(sent: readonly string[]): number {
      for (let k = sent.length - 1; k >= 0; k -= 1) {
        if (SAVEPOINT.test(sent[k] ?? "")) {
          return k;
        }
      }
      return -1;
    }

    /** The statement built right after the `nth` savepoint of the transaction under way: that savepoint's work's first. */
    const savepointsFirst =
      (nth: number) =>
      (sent: readonly string[]): boolean => {
        const scope = sent.lastIndexOf(SCOPE);
        return (
          scope !== -1 &&
          SAVEPOINT.test(sent.at(-2) ?? "") &&
          sent.slice(scope).filter((text) => SAVEPOINT.test(text)).length === nth
        );
      };

    /** The savepoint's release: its next statement when its work has one statement. */
    const releaseOf = (savepoint: string): RegExp => new RegExp(`^release savepoint ${savepoint}$`);

    interface SavepointCall {
      name: string;
      /** The K-05 call's name, which a scrubbed error carries. */
      call: "reserve" | "release";
      run: (sql: Sql) => Promise<unknown>;
      /** The savepoint of the call's transaction whose work is cut: its first, or its second. */
      nth: number;
      /** The savepoint's statement after its work's first, in flight at the "answered" cut. */
      next: (savepoint: string) => RegExp;
      /** What the call answers on a working connection, as the first to write it. */
      answers: ReserveOutcome | ReleaseOutcome;
    }

    const SAVEPOINT_CALLS: SavepointCall[] = [
      {
        name: "reserveIn's held row (reserve)",
        call: "reserve",
        run: (sql) => reserve(sql, HELD_ASKED),
        nth: 1,
        next: releaseOf,
        answers: {
          result: "held",
          reservationId: "rsv-t1362-held",
          version: 1,
          resourceId: "res-riley",
          during: { start: "2026-12-01T16:00:00Z", end: "2026-12-01T16:30:00Z" },
          heldUntil: "2026-11-07T15:15:00Z",
          savedTimeClockId: "rsv-t1362-held/saved-time",
          repeated: false,
        },
      },
      {
        name: "reserveIn's class seat and its counter (reserve)",
        call: "reserve",
        run: (sql) => reserve(sql, SEAT_ASKED),
        nth: 1,
        next: () => /^update class_seats set taken = taken \+ \$1, version = version \+ 1\s/,
        answers: {
          result: "held",
          reservationId: "rsv-t1362-seat",
          version: 1,
          resourceId: CLASS,
          during: { start: "2026-12-05T17:00:00Z", end: "2026-12-05T18:00:00Z" },
          heldUntil: "2026-11-07T15:15:00Z",
          savedTimeClockId: "rsv-t1362-seat/saved-time",
          repeated: false,
        },
      },
      {
        name: "reserveIn's waiting row, in its second savepoint once EXCLUDE refused the held row (reserve)",
        call: "reserve",
        run: (sql) => reserve(sql, WAITING_ASKED),
        nth: 2,
        next: releaseOf,
        answers: WAITING_ANSWER,
      },
      {
        name: "releaseIn's promotion of the next in line (release)",
        call: "release",
        run: (sql) => release(sql, RELEASE_ASKED),
        nth: 1,
        next: releaseOf,
        answers: {
          result: "released",
          reservationId: "rsv-alex-saved-avery",
          version: 2,
          releasedAt: "2026-11-07T15:06:00Z",
          why: "let_go",
          promoted: {
            reservationId: "rsv-agent-waiting-avery",
            version: 2,
            heldUntil: "2026-11-07T15:16:00Z",
            forPhoneNumber: null,
            forAgentToken: "agent-token-demo-2",
            bookingId: null,
            savedTimeClockId: "rsv-agent-waiting-avery/saved-time",
          },
          skipped: [],
          repeated: false,
        },
      },
    ];

    /** The call cut inside its savepoint as the shape and `when` say: see the top of this block. */
    async function expectSavepointCut(
      { call, run, nth, next, answers }: SavepointCall,
      shape: (typeof CUTS)[number],
      when: Cut["when"],
    ): Promise<void> {
      await seed();
      await expectProbeHolds(shape.raw(), shape.holds);
      const raw = shape.raw();
      const client = cutClient({ on: savepointsFirst(nth), when, raw });
      try {
        const [before] = await client.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
        const watchedRun = await watched(async () => {
          const called = await outcomeOf(() => run(client.sql));
          const builtBefore = client.sent.length;
          // At once, as above: a dead connection released to the pool would take this statement and never answer it.
          const followed = await outcomeOf(async () => {
            const [row] = await client.sql<
              { n: number; pid: number }[]
            >`select 2 as n, pg_backend_pid() as pid`;
            return { n: row?.n, newBackend: row !== undefined && row.pid !== before?.pid };
          });
          return { called, builtBefore, followed };
        });
        expect(watchedRun.outcome, call).not.toBe("never settled");
        expect(watchedRun.uncaught, call).toEqual([]);
        const { called, builtBefore, followed } = (
          watchedRun.outcome as { answer: { called: Outcome; builtBefore: number; followed: Outcome } }
        ).answer;
        // The statement in flight at the cut: the savepoint's work's first (write), or the savepoint's next statement,
        // already built when the connection, idle after that first was answered, closed (answered). It is the last one
        // built: no `rollback to savepoint`, no rollback, no commit.
        const built = client.sent.slice(0, builtBefore);
        const savepoint = lastSavepoint(built);
        const name = SAVEPOINT.exec(built[savepoint] ?? "")?.[1] ?? "";
        const inFlight = when === "write" ? savepoint + 1 : savepoint + 2;
        expect(savepoint, call).toBeGreaterThan(built.lastIndexOf(SCOPE));
        if (when === "answered") {
          expect(built[inFlight], call).toMatch(next(name));
        }
        expect(client.builtAtCut(), call).toBe(inFlight + 1);
        expect(builtBefore, call).toBe(inFlight + 1);
        expect(built, call).not.toContain(`rollback to savepoint ${name}`);
        // Neither the connection's details nor any value the call's statements carried leaves.
        const first = built.lastIndexOf(SCOPE) + 1;
        const carried = valueSecrets(client.values.slice(first, inFlight + 1));
        expect(Object.keys(carried).length, call).toBeGreaterThan(0);
        expect(leaksOf(called, { ...cutSecrets(), ...carried }), call).toEqual([]);
        expectOutcome(called, shape.expected, call);
        if (raw !== null) {
          // postgres.js rejected the statement in flight with the raw error, that statement and its values put on it.
          expect(Object.hasOwn(raw, "query"), call).toBe(true);
          const inFlightValues = valueSecrets(client.values.slice(inFlight, inFlight + 1));
          expect(leaksOf(raw, inFlightValues), call).toEqual(Object.keys(inFlightValues));
        }
        // The dead connection was never released: the next statement waited for a new connection, another backend.
        expect(followed, call).toEqual({ answer: { n: 2, newBackend: true } });
        // And the call answers on the same client as the first to write it: the cut call wrote nothing.
        const again = await watched(() => run(client.sql));
        expect(again.uncaught, call).toEqual([]);
        expect(again.outcome, call).toEqual({ answer: answers });
      } finally {
        await client.sql.end({ timeout: 0 });
      }
    }

    describe.each(SAVEPOINT_CALLS)("$name", (savepointCall) => {
      it.each(CUTS)(
        "the savepoint's first statement cut as it is written ($name): no `rollback to savepoint`, nothing thrown outside a promise, the error that leaves scrubbed; the same client then answers",
        async (shape) => {
          await expectSavepointCut(savepointCall, shape, "write");
        },
        CUT_TIMEOUT,
      );

      it.each(CUTS)(
        "the connection closing while idle after the savepoint's first statement is answered ($name): the savepoint's next statement is in flight, so the same holds",
        async (shape) => {
          await expectSavepointCut(savepointCall, shape, "answered");
        },
        CUT_TIMEOUT,
      );
    });

    /**
     * The transaction's first savepoint was rolled back right after its work's first statement was refused, and the
     * transaction went on: its second savepoint's work, then that savepoint's release, then the commit, last.
     */
    function expectRolledBackAndOn(sent: readonly string[]): void {
      const scope = sent.lastIndexOf(SCOPE);
      const names = sent.slice(scope).flatMap((text) => SAVEPOINT.exec(text)?.slice(1, 2) ?? []);
      expect(names).toHaveLength(2);
      const [first = "", second = ""] = names;
      const started = sent.indexOf(`savepoint ${first}`, scope);
      expect(sent[started + 2]).toBe(`rollback to savepoint ${first}`);
      expect(sent.slice(-2)).toEqual([`release savepoint ${second}`, "commit"]);
    }

    it("a statement's own refusal in the savepoint is rolled back to it and the transaction goes on: reserveIn's held row refused by EXCLUDE (23P01), then its waiting row saved", async () => {
      await seed();
      const client = cutClient(null);
      try {
        const { outcome, uncaught } = await watched(() => reserve(client.sql, WAITING_ASKED));
        expect(uncaught).toEqual([]);
        expect(outcome).toEqual({ answer: WAITING_ANSWER });
        expectRolledBackAndOn(client.sent);
        expect(await getReservation(db.sql, "rsv-t1362-waiting")).toMatchObject({
          state: "waiting",
          version: 1,
        });
      } finally {
        await client.sql.end({ timeout: 0 });
      }
    });

    it("a statement's own refusal in the savepoint is rolled back to it and the transaction goes on: releaseIn's promotion refused by EXCLUDE (23P01), then the next in line promoted", async () => {
      await seed();
      // Another saved time covers the second half of the first waiting row's time (made longer), so its promotion is
      // refused, as in "a waiting row whose time another held row now covers is skipped for overlap" above.
      await db.sql`insert into reservations ${db.sql({
        id: "rsv-t1362-cover",
        business_id: LEES,
        resource_id: "res-avery",
        resource_kind: "worker",
        worker_person_id: "person-avery",
        during: "[2026-11-14T15:30:00Z,2026-11-14T16:00:00Z)",
        state: "held",
        held_until: "2026-11-07T16:00:00Z",
        for_agent_token: "agent-t1362-cover",
      })}`;
      await db.sql`update reservations set during = '[2026-11-14T15:00:00Z,2026-11-14T15:45:00Z)', version = version + 1 where id = 'rsv-agent-waiting-avery'`;
      const client = cutClient(null);
      try {
        const { outcome, uncaught } = await watched(() => release(client.sql, RELEASE_ASKED));
        expect(uncaught).toEqual([]);
        expect(outcome).toEqual({
          answer: {
            result: "released",
            reservationId: "rsv-alex-saved-avery",
            version: 2,
            releasedAt: "2026-11-07T15:06:00Z",
            why: "let_go",
            promoted: {
              reservationId: "rsv-agent-waiting-avery-second",
              version: 2,
              heldUntil: "2026-11-07T15:16:00Z",
              forPhoneNumber: null,
              forAgentToken: "agent-token-demo-3",
              bookingId: null,
              savedTimeClockId: "rsv-agent-waiting-avery-second/saved-time",
            },
            skipped: [{ reservationId: "rsv-agent-waiting-avery", reason: "overlap" }],
            repeated: false,
          },
        });
        expectRolledBackAndOn(client.sent);
        expect(await getReservation(db.sql, "rsv-agent-waiting-avery")).toMatchObject({
          state: "waiting",
          version: 2,
        });
      } finally {
        await client.sql.end({ timeout: 0 });
      }
    });

    /** Each call with the request's `at` read through `readAt`, which its savepoint's work reads for its first statement. */
    const OWN_ERROR_CALLS: {
      call: "reserve" | "release";
      run: (sql: Sql, readAt: (at: string) => string) => Promise<unknown>;
    }[] = [
      {
        call: "reserve",
        run: (sql, readAt) =>
          reserve(sql, {
            ...HELD_ASKED,
            get at(): string {
              return readAt(HELD_ASKED.at);
            },
          }),
      },
      {
        call: "release",
        run: (sql, readAt) =>
          release(sql, {
            ...RELEASE_ASKED,
            get at(): string {
              return readAt(RELEASE_ASKED.at);
            },
          }),
      },
    ];

    it.each(OWN_ERROR_CALLS)(
      "an error the savepoint's work makes itself, on no statement, found no connection gone, whatever its code ($call): rolled back to the savepoint, then the transaction rolled back and the connection released",
      async ({ call, run }) => {
        await seed();
        const own = socketError("connect", "EACCES", -13);
        expect(leaksOf(own, SHAPE_SECRETS)).toEqual(expect.arrayContaining(["address", "port"]));
        const client = cutClient(null);
        // The savepoint's work reads the request's `at` for its first statement, after the savepoint is answered, and
        // that read throws; every read before the savepoint answers.
        const readAt = (at: string): string => {
          if (SAVEPOINT.test(client.sent.at(-1) ?? "")) {
            throw own;
          }
          return at;
        };
        try {
          const [before] = await client.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
          const { outcome, uncaught } = await watched(() => run(client.sql, readAt));
          expect(uncaught).toEqual([]);
          // Rolled back to the savepoint at once, with no statement of its work built, then the transaction rolled back.
          const savepoint = lastSavepoint(client.sent);
          const name = SAVEPOINT.exec(client.sent[savepoint] ?? "")?.[1] ?? "";
          expect(savepoint).toBeGreaterThan(client.sent.lastIndexOf(SCOPE));
          expect(client.sent.slice(savepoint)).toEqual([
            `savepoint ${name}`,
            `rollback to savepoint ${name}`,
            "rollback",
          ]);
          // The call answers it as targets.ts's transientOrThrow does: a session's failure, thrown scrubbed.
          expect(leaksOf(outcome, cutSecrets())).toEqual([]);
          expectOutcome(outcome, { code: "EACCES" }, call);
          // Released: the client's one connection, the same backend, answers the next statement, its scope gone.
          const next = await watched(async () => [
            ...(await client.sql<{ pid: number; scope: string | null }[]>`
              select pg_backend_pid() as pid, nullif(current_setting(${SCOPE_SETTING}, true), '') as scope
            `),
          ]);
          expect(next.outcome).toEqual({ answer: [{ pid: before?.pid, scope: null }] });
        } finally {
          await client.sql.end({ timeout: 0 });
        }
      },
    );
  });
});
