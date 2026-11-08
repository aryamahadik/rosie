// T-187: reservations and class seats against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/reservations`). The schema comes from migrating a fresh test schema.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createResource } from "./bookings-head";
import { createClient, resolvePrimaryUrl } from "./client";
import {
  createClassSeats,
  getClassSeats,
  getReservation,
  holdMinutesFor,
  release,
  reserve,
  type ReleaseOutcome,
  type ReserveOutcome,
  type ReserveRequest,
} from "./reservations";
import { withBusiness, type Sql } from "./scope";
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

  it("is expand only: plain tables, no row-level security here (T-191)", async () => {
    const rows = await db.sql<{ name: string; kind: string; rls: boolean }[]>`
      select c.relname as name, c.relkind as kind, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${db.schema} and c.relname in ('class_seats', 'reservations')
      order by c.relname
    `;
    expect(rows.map((row) => [row.name, row.kind, row.rls])).toEqual([
      ["class_seats", "r", false],
      ["reservations", "r", false],
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
