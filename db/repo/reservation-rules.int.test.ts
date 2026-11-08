// T-198: the reservation rules (K-05 v1 item 6: contracts/data-access/README.md items 8 to 10) against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/reservation-rules`). The schema comes from migrating a fresh
// test schema. The K-04 seeds are loaded by the tables' owner; the calls run as the Tool API's role, rosie_app (T-191),
// through a client whose connections take that role, so row-level security binds them as it will bind the Worker
// (T-1093), except where a test says it runs as the tables' owner.
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type DbClient, resolvePrimaryUrl } from "./client";
import {
  doorMinutes,
  EXTEND_MINUTES,
  extend,
  extendIn,
  getReservation,
  release,
  reserve,
  STANDARD_HOLD_MINUTES,
  type ExtendOutcome,
  type ExtendRequest,
  type ReleaseOutcome,
  type ReleaseRequest,
  type ReserveOutcome,
  type ReserveRequest,
} from "./reservation-rules";
import { SCOPE_SETTING, type Sql } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const TOOL_API_ROLE = "rosie_app";
const HEAVY = { timeout: 120_000 };
const SLOW = { timeout: 60_000 };

const LEES = "biz-lees-barbershop";
const YOGA = "biz-yoga-studio";
const MOVERS = "biz-movers";
const ALEX = "+15555550101";
const TOMAS = "+15555550105";
/** Alex's saved time with Avery (seed-reservation): held until 15:10, version 1, never extended. */
const ALEX_AVERY = "rsv-alex-saved-avery";

/** The six fixtures of the card (K-05 v1 item 6). */
const FIXTURES = [
  "reserve-ai-door-15-min.json",
  "reserve-third-refused.json",
  "reserve-next-in-line.json",
  "release-expired-promotes.json",
  "extend-once.json",
  "extend-ai-door-refused.json",
] as const;

interface SeedFile {
  after: string[];
  rows: { table: string; values: Record<string, string | number | boolean | null> }[];
}

interface Exchange {
  call: "reserve" | "release" | "extend";
  given: { k04Seeds: string[]; after: string[]; now: string; note?: string };
  request: unknown;
  outcome: unknown;
}

type Outcome = ReserveOutcome | ReleaseOutcome | ExtendOutcome;

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const exchangeOf = (file: string): Exchange => readJson(new URL(file, ACCESS_DIR)) as Exchange;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `at` plus `minutes`, in the contract's UTC form (2026-11-07T15:20:00Z). */
function plus(at: string, minutes: number): string {
  return new Date(Date.parse(at) + minutes * 60_000).toISOString().replace(".000Z", "Z");
}

/** The i-th of many one-hour times from `base`, none overlapping another. */
function hourSlot(base: string, i: number): { start: string; end: string } {
  return { start: plus(base, i * 60), end: plus(base, i * 60 + 60) };
}

const kindOf = (outcome: Outcome): string => ("result" in outcome ? outcome.result : outcome.error);

function tally(outcomes: Outcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) {
    counts[kindOf(outcome)] = (counts[kindOf(outcome)] ?? 0) + 1;
  }
  return counts;
}

// ---- the contract's own schema, for the answers no fixture shows (Ajv 2020-12, strict, as contracts:check runs it) --

function schemaFiles(dir: URL): URL[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".schema.json") && !file.endsWith(".meta.schema.json"))
    .filter((file) => !file.startsWith("generated/") && !file.startsWith("scripts/"))
    .filter((file) => !file.includes("node_modules"))
    .map((file) => new URL(file, dir));
}

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
for (const file of schemaFiles(CONTRACTS)) {
  ajv.addSchema(readJson(file) as object);
}
const V1_ID = (readJson(new URL("data-access/data-access.v1.schema.json", CONTRACTS)) as { $id: string }).$id;

/** Ajv's complaints about `value` against one $defs entry of data-access v1 (none when it passes). */
function schemaErrors(def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${V1_ID}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`data-access v1 has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/** An answer of `call` is one of the contract's: its response or one of its errors. */
function expectContractAnswer(call: Exchange["call"], outcome: Outcome): void {
  const def = "result" in outcome ? `${call}.response` : `${call}.errors`;
  expect(schemaErrors(def, outcome), `${call} ${kindOf(outcome)}`).toEqual([]);
}

// ---- the database, the Tool API's client, and the seeds ------------------------------------------------------------

let db: TestDatabase;
/** Connections that run as rosie_app, the Tool API's role, with this file's schema first. */
let toolApi: Sql;

function toolApiClient(max: number, name: string): Sql {
  return postgres(resolvePrimaryUrl(), {
    max,
    onnotice: () => undefined,
    connection: { application_name: name, search_path: `${db.schema}, public`, role: TOOL_API_ROLE },
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "reservation_rules", client: { max: 20 } });
  toolApi = toolApiClient(20, "rosie-t198-tool-api");
}, 60_000);

afterAll(async () => {
  await toolApi.end({ timeout: 5 });
  await db.drop();
});

/** The rows of a K-04 seed and of the seeds it names in `after`, in load order. */
function seedRows(file: string, seen = new Set<string>()): SeedFile["rows"] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const seed = readJson(new URL(file, CORE_DIR)) as SeedFile;
  return [...seed.after.flatMap((before) => seedRows(before, seen)), ...seed.rows];
}

async function loadSeed(file: string): Promise<void> {
  const present = await db.sql<{ name: string }[]>`
    select table_name as name from information_schema.tables where table_schema = current_schema()
  `;
  const tables = new Set(present.map((row) => row.name));
  for (const row of seedRows(file)) {
    if (tables.has(row.table)) {
      await db.sql`insert into ${db.sql(row.table)} ${db.sql(row.values)}`;
    }
  }
}

async function emptyTables(): Promise<void> {
  await db.sql`truncate clock_rows, reservations, class_seats, messages, openers_sent, threads, bookings, resources, pauses, phones, person_handles, handles, person_roles, sealing_keys, persons, businesses cascade`;
}

async function freshSeed(): Promise<void> {
  await emptyTables();
  await loadSeed("seed-reservation.json");
}

async function call(sql: Sql, exchange: Exchange): Promise<Outcome> {
  switch (exchange.call) {
    case "reserve":
      return reserve(sql, exchange.request as ReserveRequest);
    case "release":
      return release(sql, exchange.request as ReleaseRequest);
    case "extend":
      return extend(sql, exchange.request as ExtendRequest);
  }
}

/** Seeds a fixture's K-04 seeds, runs its `after` chain (each giving its own outcome), then its own request. */
async function runFixture(file: string, sql: Sql): Promise<{ outcome: Outcome; expected: unknown }> {
  const exchange = exchangeOf(file);
  await emptyTables();
  for (const seed of exchange.given.k04Seeds) {
    await loadSeed(seed);
  }
  for (const before of exchange.given.after) {
    const earlier = exchangeOf(before);
    expect(await call(sql, earlier), before).toEqual(earlier.outcome);
  }
  return { outcome: await call(sql, exchange), expected: exchange.outcome };
}

/** A reserve request for the barbershop's Riley, for an agent token of its own, unless said otherwise. */
function reserveRequest(over: Partial<ReserveRequest> & { reservationId: string }): ReserveRequest {
  return {
    businessId: LEES,
    resourceId: "res-riley",
    during: { start: "2026-12-01T16:00:00Z", end: "2026-12-01T16:30:00Z" },
    seats: 1,
    for: { agentToken: `token-${over.reservationId}` },
    door: "standard",
    holdMinutes: null,
    waitIfSaved: false,
    at: "2026-11-07T15:05:00Z",
    ...over,
  };
}

/** extend-once.json's request (Alex's saved time with Avery, at 15:08), unless said otherwise. */
function extendRequest(over: Partial<ExtendRequest> = {}): ExtendRequest {
  return {
    reservationId: ALEX_AVERY,
    businessId: LEES,
    expectVersion: 1,
    door: "standard",
    at: "2026-11-07T15:08:00Z",
    ...over,
  };
}

async function heldAs(
  id: string,
): Promise<{ state: string; heldUntil: string | null; extended: boolean; version: number }> {
  const row = await getReservation(db.sql, id);
  if (row === null) {
    throw new Error(`reservation ${id} not found`);
  }
  return { state: row.state, heldUntil: row.heldUntil, extended: row.extended, version: row.version };
}

/** A one-connection client of the Tool API's role, and its backend's pid, to watch it wait on a lock. */
async function oneConnection(name: string): Promise<{ sql: Sql; pid: number }> {
  const sql = toolApiClient(1, name);
  const [row] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
  return { sql, pid: row?.pid ?? 0 };
}

/** True once the backend `pid` waits on a lock (polled every 50 ms, for at most 10 s). */
async function waitsOnLock(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [state] = await db.sql<{ waiting: boolean | null }[]>`
      select (wait_event_type = 'Lock') as waiting from pg_stat_activity where pid = ${pid}
    `;
    if (state?.waiting === true) {
      return true;
    }
    await sleep(50);
  }
  return false;
}

/**
 * A transaction left open, as the Tool API's role under `businessId`'s scope, on a reserved connection of the owner's
 * client (as reserve and extend run theirs), so a test can hold what a call inside it locked.
 */
async function openToolApiTransaction(
  businessId: string,
): Promise<{ tx: Sql; commit: () => Promise<void>; rollback: () => Promise<void> }> {
  const reserved = await db.sql.reserve();
  await reserved`begin`;
  await reserved`select set_config(${SCOPE_SETTING}, ${businessId}, true)`;
  await reserved.unsafe(`set local role ${TOOL_API_ROLE}`);
  let open = true;
  const end = async (statement: "commit" | "rollback"): Promise<void> => {
    if (!open) {
      return;
    }
    open = false;
    try {
      await reserved.unsafe(statement);
    } finally {
      reserved.release();
    }
  };
  return { tx: reserved, commit: () => end("commit"), rollback: () => end("rollback") };
}

// ---- the fixtures --------------------------------------------------------------------------------------------------

describe("K-05 v1 item 6's fixtures: each request gives its response", () => {
  for (const file of FIXTURES) {
    it(`${file}, as the Tool API's role under row-level security`, async () => {
      const { outcome, expected } = await runFixture(file, toolApi);
      expect(outcome).toEqual(expected);
    });

    it(`${file}, as the tables' owner`, async () => {
      const { outcome, expected } = await runFixture(file, db.sql);
      expect(outcome).toEqual(expected);
    });
  }
});

// ---- door lengths --------------------------------------------------------------------------------------------------

describe("reserve() saves each door's own minutes (arch 05 line 247; MC C3; A4-21)", () => {
  it("standard 10, ownAi 15, planCheck up to 60, document up to 24 hours, ownerOk up to 30", async () => {
    await freshSeed();
    expect(STANDARD_HOLD_MINUTES).toBe(10);
    const at = "2026-11-07T15:05:00Z";
    const cases: [ReserveRequest["door"], number | null, number][] = [
      ["standard", null, 10],
      ["ownAi", null, 15],
      ["planCheck", 60, 60],
      ["planCheck", 45, 45],
      ["document", 1440, 1440],
      ["ownerOk", 30, 30],
    ];
    for (const [i, [door, holdMinutes, minutes]] of cases.entries()) {
      expect(doorMinutes(door, holdMinutes), door).toBe(minutes);
      const id = `rsv-door-${String(i)}`;
      const outcome = await reserve(
        toolApi,
        reserveRequest({
          reservationId: id,
          door,
          holdMinutes,
          during: hourSlot("2026-12-02T10:00:00Z", i),
          at,
        }),
      );
      expect(outcome, door).toEqual({
        result: "held",
        reservationId: id,
        version: 1,
        resourceId: "res-riley",
        during: hourSlot("2026-12-02T10:00:00Z", i),
        heldUntil: plus(at, minutes),
        savedTimeClockId: `${id}/saved-time`,
        repeated: false,
      });
      expect(await heldAs(id)).toEqual({
        state: "held",
        heldUntil: plus(at, minutes),
        extended: false,
        version: 1,
      });
    }
  });

  it("minutes a door does not allow, and a door that is none of the five, are refused before anything is written", async () => {
    const refused: [string, number | null][] = [
      ["standard", 5],
      ["ownAi", 15],
      ["ownAi", 30],
      ["planCheck", 61],
      ["planCheck", null],
      ["planCheck", 0],
      ["document", 1441],
      ["ownerOk", 31],
      ["sameDay", 30],
      ["", 10],
    ];
    for (const [door, holdMinutes] of refused) {
      expect(
        () => doorMinutes(door as ReserveRequest["door"], holdMinutes),
        `${door} ${String(holdMinutes)}`,
      ).toThrow(TypeError);
    }
    // An unknown door may not take any minutes it asks for (T-187's security note N4): nothing is written.
    await expect(
      reserve(
        toolApi,
        reserveRequest({
          reservationId: "rsv-door-unknown",
          door: "sameDay" as ReserveRequest["door"],
          holdMinutes: 5000,
        }),
      ),
    ).rejects.toThrow(TypeError);
    expect(await getReservation(db.sql, "rsv-door-unknown")).toBeNull();
  });

  for (const [file, fixed, minutes] of [
    ["refuse-reserve-ai-door-with-minutes.json", null, 15],
    ["refuse-reserve-document-over-24-hours.json", 1440, 1440],
  ] as const) {
    it(`${file} is refused, and the same request passes without its fault`, async () => {
      await freshSeed();
      const asked = readJson(new URL(`invalid/${file}`, ACCESS_DIR)) as ReserveRequest;
      await expect(reserve(toolApi, asked)).rejects.toThrow(TypeError);
      expect(await getReservation(db.sql, asked.reservationId)).toBeNull();
      expect(await reserve(toolApi, { ...asked, holdMinutes: fixed })).toMatchObject({
        result: "held",
        heldUntil: plus(asked.at, minutes),
      });
    });
  }
});

// ---- the cap of 2 saved times --------------------------------------------------------------------------------------

describe("a third saved time is refused, with both existing end times (arch 05 line 247)", () => {
  const ALEX_SAVED = [
    { reservationId: ALEX_AVERY, heldUntil: "2026-11-07T15:10:00Z" },
    { reservationId: "rsv-alex-riley-nov14", heldUntil: "2026-11-07T15:15:00Z" },
  ];

  it("for one mobile at its own business, and nothing is written", async () => {
    await freshSeed();
    expect(await call(toolApi, exchangeOf("reserve-10-min.json"))).toMatchObject({ result: "held" });
    const third = await reserve(
      toolApi,
      reserveRequest({
        reservationId: "rsv-alex-third-lees",
        during: { start: "2026-11-21T16:00:00Z", end: "2026-11-21T16:30:00Z" },
        for: { phoneNumber: ALEX },
        at: "2026-11-07T15:07:00Z",
      }),
    );
    expect(third).toEqual({ error: "savedTimeCap", saved: ALEX_SAVED });
    expectContractAnswer("reserve", third);
    expect(await getReservation(db.sql, "rsv-alex-third-lees")).toBeNull();
  });

  it(
    "50 parallel third attempts for one mobile, from another business, are all refused, each with both end times",
    HEAVY,
    async () => {
      await freshSeed();
      expect(await call(toolApi, exchangeOf("reserve-10-min.json"))).toMatchObject({ result: "held" });
      const outcomes = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          reserve(
            toolApi,
            reserveRequest({
              reservationId: `rsv-alex-third-${String(i)}`,
              businessId: YOGA,
              resourceId: "res-maya",
              during: hourSlot("2026-12-01T10:00:00Z", i),
              for: { phoneNumber: ALEX },
              waitIfSaved: true,
              at: "2026-11-07T15:07:00Z",
            }),
          ),
        ),
      );
      expect(tally(outcomes)).toEqual({ savedTimeCap: 50 });
      for (const outcome of outcomes) {
        expect(outcome).toEqual({ error: "savedTimeCap", saved: ALEX_SAVED });
      }
      const written = await db.sql<{ n: number }[]>`
      select count(*)::int as n from reservations where id like 'rsv-alex-third-%'
    `;
      expect(written[0]?.n).toBe(0);
      const held = await db.sql<{ id: string }[]>`
      select id from reservations where for_phone_number = ${ALEX} and state = 'held' order by id collate "C"
    `;
      expect(held.map((row) => row.id)).toEqual(["rsv-alex-riley-nov14", ALEX_AVERY]);
    },
  );

  it(
    "50 parallel third attempts for one agent token at one business are all refused, each with both end times; at another business it saves again",
    HEAVY,
    async () => {
      await freshSeed();
      const token = { agentToken: "agent-token-t198" };
      const first = reserveRequest({
        reservationId: "rsv-token-first",
        businessId: MOVERS,
        resourceId: "res-truck-20",
        during: { start: "2026-12-10T13:00:00Z", end: "2026-12-10T21:00:00Z" },
        for: token,
        at: "2026-11-07T15:05:00Z",
      });
      const second = {
        ...first,
        reservationId: "rsv-token-second",
        resourceId: "res-truck-26",
        at: "2026-11-07T15:06:00Z",
      };
      expect(await reserve(toolApi, first)).toMatchObject({
        result: "held",
        heldUntil: "2026-11-07T15:15:00Z",
      });
      expect(await reserve(toolApi, second)).toMatchObject({
        result: "held",
        heldUntil: "2026-11-07T15:16:00Z",
      });
      const saved = [
        { reservationId: "rsv-token-first", heldUntil: "2026-11-07T15:15:00Z" },
        { reservationId: "rsv-token-second", heldUntil: "2026-11-07T15:16:00Z" },
      ];
      const outcomes = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          reserve(
            toolApi,
            reserveRequest({
              reservationId: `rsv-token-third-${String(i)}`,
              businessId: MOVERS,
              resourceId: i % 2 === 0 ? "res-truck-20" : "res-truck-26",
              during: hourSlot("2027-01-04T10:00:00Z", i),
              for: token,
              at: "2026-11-07T15:07:00Z",
            }),
          ),
        ),
      );
      expect(tally(outcomes)).toEqual({ savedTimeCap: 50 });
      for (const outcome of outcomes) {
        expect(outcome).toEqual({ error: "savedTimeCap", saved });
      }
      const written = await db.sql<{ n: number }[]>`
      select count(*)::int as n from reservations where id like 'rsv-token-third-%'
    `;
      expect(written[0]?.n).toBe(0);
      // The cap is per business for a token: at the yoga studio it saves a time.
      expect(
        await reserve(
          toolApi,
          reserveRequest({
            reservationId: "rsv-token-yoga",
            businessId: YOGA,
            resourceId: "res-studio-room",
            during: { start: "2026-12-10T13:00:00Z", end: "2026-12-10T14:00:00Z" },
            for: token,
            at: "2026-11-07T15:07:00Z",
          }),
        ),
      ).toMatchObject({ result: "held", reservationId: "rsv-token-yoga" });
    },
  );

  it("waiting rows never count: a mobile waiting next in line still saves two times, and its third names only those", async () => {
    await freshSeed();
    expect(await call(toolApi, exchangeOf("reserve-next-in-line.json"))).toMatchObject({ result: "waiting" });
    const tomas = (id: string, businessId: string, resourceId: string): ReserveRequest =>
      reserveRequest({
        reservationId: id,
        businessId,
        resourceId,
        during: { start: "2026-12-02T16:00:00Z", end: "2026-12-02T17:00:00Z" },
        for: { phoneNumber: TOMAS },
        at: "2026-11-07T15:06:00Z",
      });
    expect(await reserve(toolApi, tomas("rsv-tomas-a", LEES, "res-riley"))).toMatchObject({ result: "held" });
    expect(await reserve(toolApi, tomas("rsv-tomas-b", YOGA, "res-maya"))).toMatchObject({ result: "held" });
    expect(await reserve(toolApi, tomas("rsv-tomas-c", YOGA, "res-studio-room"))).toEqual({
      error: "savedTimeCap",
      saved: [
        { reservationId: "rsv-tomas-a", heldUntil: "2026-11-07T15:16:00Z" },
        { reservationId: "rsv-tomas-b", heldUntil: "2026-11-07T15:16:00Z" },
      ],
    });
    expect(await heldAs("rsv-tomas-avery-nov14")).toMatchObject({ state: "waiting" });
  });
});

// ---- next in line, and the release that promotes it ----------------------------------------------------------------

describe("when a saved time expires or is let go, the first in line gets it, exactly once", () => {
  /** Avery's line (seed-reservation): agent-token-demo-2 queued 15:02, inserted after agent-token-demo-3 queued 15:04. */
  const FIRST_IN_LINE = "rsv-agent-waiting-avery";
  const SECOND_IN_LINE = "rsv-agent-waiting-avery-second";

  async function parallelReleases(requests: ReleaseRequest[]): Promise<ReleaseOutcome[]> {
    await freshSeed();
    return Promise.all(requests.map((asked) => release(toolApi, asked)));
  }

  /** One release promoted the first in line, held from `at` for 10 minutes; every other call is its repeat. */
  async function expectPromotedOnce(outcomes: ReleaseOutcome[], at: string): Promise<void> {
    const released = outcomes.filter(
      (outcome): outcome is Extract<ReleaseOutcome, { result: "released" }> => "result" in outcome,
    );
    expect(released).toHaveLength(outcomes.length);
    const first = released.filter((outcome) => !outcome.repeated);
    expect(first).toHaveLength(1);
    const winner = first[0];
    if (winner === undefined) {
      throw new Error("no release wrote");
    }
    expect(winner).toEqual({
      result: "released",
      reservationId: ALEX_AVERY,
      version: 2,
      releasedAt: at,
      why: winner.why,
      promoted: {
        reservationId: FIRST_IN_LINE,
        version: 2,
        heldUntil: plus(at, 10),
        forPhoneNumber: null,
        forAgentToken: "agent-token-demo-2",
        bookingId: null,
        savedTimeClockId: `${FIRST_IN_LINE}/saved-time`,
      },
      skipped: [],
      repeated: false,
    });
    expectContractAnswer("release", winner);
    const repeats = released.filter((outcome) => outcome.repeated);
    expect(repeats).toHaveLength(outcomes.length - 1);
    for (const repeat of repeats) {
      expect(repeat).toEqual({ ...winner, promoted: null, repeated: true });
    }
    expect(await heldAs(ALEX_AVERY)).toMatchObject({ state: "released", version: 2 });
    expect(await heldAs(FIRST_IN_LINE)).toEqual({
      state: "held",
      heldUntil: plus(at, 10),
      extended: false,
      version: 2,
    });
    expect(await heldAs(SECOND_IN_LINE)).toEqual({
      state: "waiting",
      heldUntil: null,
      extended: false,
      version: 1,
    });
  }

  it("100 parallel expiries (the clock's release, sent again and again)", HEAVY, async () => {
    const at = "2026-11-07T15:10:00Z";
    const outcomes = await parallelReleases(
      Array.from({ length: 100 }, () => ({
        reservationId: ALEX_AVERY,
        businessId: LEES,
        expectVersion: null,
        why: "expired" as const,
        at,
      })),
    );
    await expectPromotedOnce(outcomes, at);
    expect(outcomes.every((outcome) => "why" in outcome && outcome.why === "expired")).toBe(true);
  });

  it("100 parallel let-gos", HEAVY, async () => {
    const at = "2026-11-07T15:06:00Z";
    const outcomes = await parallelReleases(
      Array.from({ length: 100 }, () => ({
        reservationId: ALEX_AVERY,
        businessId: LEES,
        expectVersion: 1,
        why: "let_go" as const,
        at,
      })),
    );
    await expectPromotedOnce(outcomes, at);
    expect(outcomes.every((outcome) => "why" in outcome && outcome.why === "let_go")).toBe(true);
  });

  it(
    "50 expiries and 50 let-gos racing: whichever releases first promotes, and the rest repeat its release",
    HEAVY,
    async () => {
      const at = "2026-11-07T15:10:00Z";
      const outcomes = await parallelReleases(
        Array.from({ length: 100 }, (_, i) => ({
          reservationId: ALEX_AVERY,
          businessId: LEES,
          expectVersion: i % 2 === 0 ? null : 1,
          why: i % 2 === 0 ? ("expired" as const) : ("let_go" as const),
          at,
        })),
      );
      await expectPromotedOnce(outcomes, at);
    },
  );
});

// ---- extend --------------------------------------------------------------------------------------------------------

describe("extend() adds 10 minutes once, never on the ownAi door (README item 10; Q-12; MC C3)", () => {
  it("a second extend is refused, and the first request sent again changes nothing (alreadyExtended)", async () => {
    await freshSeed();
    expect(EXTEND_MINUTES).toBe(10);
    expect(await extend(toolApi, extendRequest())).toEqual({
      result: "extended",
      reservationId: ALEX_AVERY,
      version: 2,
      heldUntil: "2026-11-07T15:20:00Z",
    });
    const second = await extend(toolApi, extendRequest({ expectVersion: 2, at: "2026-11-07T15:18:00Z" }));
    expect(second).toEqual({
      error: "alreadyExtended",
      reservationId: ALEX_AVERY,
      heldUntil: "2026-11-07T15:20:00Z",
    });
    expectContractAnswer("extend", second);
    expect(await extend(toolApi, extendRequest())).toEqual(second);
    expect(await heldAs(ALEX_AVERY)).toEqual({
      state: "held",
      heldUntil: "2026-11-07T15:20:00Z",
      extended: true,
      version: 2,
    });
  });

  it(
    "50 parallel extends of one saved time: exactly one extends it, the other 49 are alreadyExtended",
    HEAVY,
    async () => {
      await freshSeed();
      const outcomes = await Promise.all(Array.from({ length: 50 }, () => extend(toolApi, extendRequest())));
      expect(tally(outcomes)).toEqual({ extended: 1, alreadyExtended: 49 });
      for (const outcome of outcomes) {
        expect(outcome).toEqual(
          "result" in outcome
            ? { result: "extended", reservationId: ALEX_AVERY, version: 2, heldUntil: "2026-11-07T15:20:00Z" }
            : { error: "alreadyExtended", reservationId: ALEX_AVERY, heldUntil: "2026-11-07T15:20:00Z" },
        );
      }
      expect(await heldAs(ALEX_AVERY)).toEqual({
        state: "held",
        heldUntil: "2026-11-07T15:20:00Z",
        extended: true,
        version: 2,
      });
    },
  );

  it("any extend on the ownAi door is refused, before the one extension and the version are looked at, and nothing changes", async () => {
    const { outcome } = await runFixture("extend-ai-door-refused.json", toolApi);
    expect(outcome).toEqual({
      error: "neverExtended",
      reservationId: "rsv-agent-truck-20-nov20",
      door: "ownAi",
    });
    expectContractAnswer("extend", outcome);
    const truck = {
      reservationId: "rsv-agent-truck-20-nov20",
      businessId: MOVERS,
      at: "2026-11-07T15:12:00Z",
    };
    expect(await extend(toolApi, extendRequest({ ...truck, door: "ownAi", expectVersion: 7 }))).toEqual(
      outcome,
    );
    expect(await heldAs("rsv-agent-truck-20-nov20")).toEqual({
      state: "held",
      heldUntil: "2026-11-07T15:20:00Z",
      extended: false,
      version: 1,
    });
    // The caller names the door (K-04 keeps none: K-05 open gap 2): named ownAi, Alex's saved time is never extended
    // either, before or after its one extension.
    const named = { error: "neverExtended", reservationId: ALEX_AVERY, door: "ownAi" };
    expect(await extend(toolApi, extendRequest({ door: "ownAi" }))).toEqual(named);
    expect(await heldAs(ALEX_AVERY)).toMatchObject({ heldUntil: "2026-11-07T15:10:00Z", version: 1 });
    expect(await extend(toolApi, extendRequest())).toMatchObject({ result: "extended", version: 2 });
    expect(await extend(toolApi, extendRequest({ door: "ownAi", expectVersion: 2 }))).toEqual(named);
    expect(await heldAs(ALEX_AVERY)).toEqual({
      state: "held",
      heldUntil: "2026-11-07T15:20:00Z",
      extended: true,
      version: 2,
    });
  });

  it("every other door is extended once by 10 minutes on its own end: planCheck, document and ownerOk", async () => {
    await freshSeed();
    const at = "2026-11-07T15:05:00Z";
    const doors: [ReserveRequest["door"], number][] = [
      ["planCheck", 60],
      ["document", 1440],
      ["ownerOk", 30],
    ];
    for (const [i, [door, minutes]] of doors.entries()) {
      const id = `rsv-extend-${door}`;
      expect(
        await reserve(
          toolApi,
          reserveRequest({
            reservationId: id,
            door,
            holdMinutes: minutes,
            during: hourSlot("2026-12-03T10:00:00Z", i),
            at,
          }),
        ),
      ).toMatchObject({ result: "held", heldUntil: plus(at, minutes) });
      const asked = extendRequest({ reservationId: id, door, at: "2026-11-07T15:30:00Z" });
      expect(await extend(toolApi, asked), door).toEqual({
        result: "extended",
        reservationId: id,
        version: 2,
        heldUntil: plus(at, minutes + EXTEND_MINUTES),
      });
      expect(await extend(toolApi, { ...asked, expectVersion: 2 }), door).toEqual({
        error: "alreadyExtended",
        reservationId: id,
        heldUntil: plus(at, minutes + EXTEND_MINUTES),
      });
    }
  });

  it("a class seat's saved time is extended the same way, and its session's seats stay as they are", async () => {
    await emptyTables();
    await loadSeed("seed-class-seats.json");
    const asked = extendRequest({ reservationId: "rsv-agent-workshop", businessId: YOGA });
    expect(await extend(toolApi, asked)).toEqual({
      result: "extended",
      reservationId: "rsv-agent-workshop",
      version: 2,
      heldUntil: "2026-11-07T15:20:00Z",
    });
    expect(await extend(toolApi, { ...asked, expectVersion: 2 })).toEqual({
      error: "alreadyExtended",
      reservationId: "rsv-agent-workshop",
      heldUntil: "2026-11-07T15:20:00Z",
    });
    const seats = await db.sql<{ taken: number; version: number }[]>`
      select taken, version from class_seats where resource_id = 'res-handstand-workshop'
    `;
    expect(seats).toEqual([{ taken: 2, version: 3 }]);
  });

  it("a time that is not saved now is notHeld with its state: at its end, past it, waiting, booked or released", async () => {
    await freshSeed();
    const cases: [Partial<ExtendRequest>, string][] = [
      [{ at: "2026-11-07T15:10:00Z" }, "held"],
      [{ at: "2026-11-07T15:11:00Z" }, "held"],
      [{ reservationId: "rsv-agent-waiting-avery" }, "waiting"],
      [{ reservationId: "rsv-alex-haircut", expectVersion: 2 }, "booked"],
      [{ reservationId: "rsv-truck-expired", businessId: MOVERS, expectVersion: 2 }, "released"],
    ];
    for (const [over, state] of cases) {
      const asked = extendRequest(over);
      const before = await heldAs(asked.reservationId);
      const outcome = await extend(toolApi, asked);
      expect(outcome, state).toEqual({ error: "notHeld", reservationId: asked.reservationId, state });
      expectContractAnswer("extend", outcome);
      expect(await heldAs(asked.reservationId)).toEqual(before);
    }
  });

  it("a stale version is refused with the row that changed, and nothing changes", async () => {
    await freshSeed();
    const outcome = await extend(toolApi, extendRequest({ expectVersion: 3 }));
    expect(outcome).toEqual({
      error: "versionChanged",
      changed: [{ table: "reservations", rowId: ALEX_AVERY, readVersion: 3, currentVersion: 1 }],
    });
    expectContractAnswer("extend", outcome);
    expect(await heldAs(ALEX_AVERY)).toEqual({
      state: "held",
      heldUntil: "2026-11-07T15:10:00Z",
      extended: false,
      version: 1,
    });
  });

  it("a reservation that does not exist, or another business's, is notFound, as the Tool API's role and as the tables' owner", async () => {
    await freshSeed();
    for (const sql of [toolApi, db.sql]) {
      const missing = await extend(sql, extendRequest({ reservationId: "rsv-none" }));
      expect(missing).toEqual({ error: "notFound", table: "reservations", rowId: "rsv-none" });
      expectContractAnswer("extend", missing);
      expect(await extend(sql, extendRequest({ businessId: YOGA }))).toEqual({
        error: "notFound",
        table: "reservations",
        rowId: ALEX_AVERY,
      });
    }
    expect(await heldAs(ALEX_AVERY)).toMatchObject({ heldUntil: "2026-11-07T15:10:00Z", version: 1 });
  });

  it("a request that is not well formed is refused before anything is read", async () => {
    const bad: unknown[] = [
      extendRequest({ at: "tomorrow" }),
      extendRequest({ at: "2026-11-07 15:08" }),
      extendRequest({ expectVersion: 0 }),
      extendRequest({ expectVersion: 1.5 }),
      extendRequest({ door: "sameDay" as ExtendRequest["door"] }),
      extendRequest({ reservationId: "" }),
      extendRequest({ businessId: "" }),
      { ...extendRequest(), holdMinutes: 10 },
    ];
    for (const asked of bad) {
      await expect(extend(toolApi, asked as ExtendRequest)).rejects.toThrow(TypeError);
    }
  });

  it("the saved-time clock row's due time moves with the extension; a cancelled one stays as it is (Q-12)", async () => {
    await freshSeed();
    expect(await call(toolApi, exchangeOf("reserve-10-min.json"))).toMatchObject({ result: "held" });
    // Each row as K-05 item 8 makes one (and commit-turn.ts makes a promoted row's): armed, due at held_until in the
    // business's zone, owned by the mobile's handle, firing the expiry's release.
    const insertClock = async (
      reservationId: string,
      row: { dueAt: string; state: "armed" | "cancelled"; armedAt: string; cancelledAt: string | null },
    ): Promise<void> => {
      await db.sql`
        insert into clock_rows (
          id, kind, reservation_id, handle_id, business_id, due_at, due_zone, state, armed_at, cancelled_at, fires
        )
        values (
          ${`${reservationId}/saved-time`}, 'saved_time', ${reservationId}, 'handle-alex', ${LEES},
          ${row.dueAt}::timestamptz, 'America/New_York', ${row.state}, ${row.armedAt}::timestamptz,
          ${row.cancelledAt}::timestamptz, ${db.sql.json({ release: reservationId, why: "expired" })}
        )
      `;
    };
    await insertClock(ALEX_AVERY, {
      dueAt: "2026-11-07T15:10:00Z",
      state: "armed",
      armedAt: "2026-11-07T15:00:00Z",
      cancelledAt: null,
    });
    await insertClock("rsv-alex-riley-nov14", {
      dueAt: "2026-11-07T15:15:00Z",
      state: "cancelled",
      armedAt: "2026-11-07T15:05:00Z",
      cancelledAt: "2026-11-07T15:06:00Z",
    });
    const read = async (id: string): Promise<Record<string, unknown> | undefined> => {
      const [row] = await db.sql<Record<string, unknown>[]>`
        select id, kind, reservation_id, handle_id, business_id, due_at, due_zone, state, armed_at, fires, fired_at,
               cancelled_at, created_by_turn_id, version
        from clock_rows where id = ${id}
      `;
      return row;
    };
    const armedBefore = await read(`${ALEX_AVERY}/saved-time`);
    const cancelledBefore = await read("rsv-alex-riley-nov14/saved-time");

    expect(await extend(toolApi, extendRequest())).toMatchObject({
      result: "extended",
      heldUntil: "2026-11-07T15:20:00Z",
    });
    expect(await read(`${ALEX_AVERY}/saved-time`)).toEqual({
      ...armedBefore,
      due_at: new Date("2026-11-07T15:20:00Z"),
      version: 2,
    });

    expect(
      await extend(
        toolApi,
        extendRequest({ reservationId: "rsv-alex-riley-nov14", at: "2026-11-07T15:09:00Z" }),
      ),
    ).toMatchObject({ result: "extended", heldUntil: "2026-11-07T15:25:00Z" });
    expect(await read("rsv-alex-riley-nov14/saved-time")).toEqual(cancelledBefore);
  });

  it(
    "a reserve for the same mobile waits for an extension in flight and counts its new end, so the cap stays 2",
    SLOW,
    async () => {
      await freshSeed();
      expect(await call(toolApi, exchangeOf("reserve-10-min.json"))).toMatchObject({ result: "held" });
      const open = await openToolApiTransaction(LEES);
      const waiter = await oneConnection("rosie-t198-waiter");
      try {
        expect(await extendIn(open.tx, extendRequest({ at: "2026-11-07T15:09:00Z" }))).toEqual({
          result: "extended",
          reservationId: ALEX_AVERY,
          version: 2,
          heldUntil: "2026-11-07T15:20:00Z",
        });
        // At 15:11 Avery's old end (15:10) has passed: counted without the extension, this would be Alex's second.
        const pending = reserve(
          waiter.sql,
          reserveRequest({
            reservationId: "rsv-alex-maya-race",
            businessId: YOGA,
            resourceId: "res-maya",
            during: { start: "2026-11-28T15:00:00Z", end: "2026-11-28T16:00:00Z" },
            for: { phoneNumber: ALEX },
            at: "2026-11-07T15:11:00Z",
          }),
        );
        expect(await waitsOnLock(waiter.pid)).toBe(true);
        await open.commit();
        expect(await pending).toEqual({
          error: "savedTimeCap",
          saved: [
            { reservationId: "rsv-alex-riley-nov14", heldUntil: "2026-11-07T15:15:00Z" },
            { reservationId: ALEX_AVERY, heldUntil: "2026-11-07T15:20:00Z" },
          ],
        });
        expect(await getReservation(db.sql, "rsv-alex-maya-race")).toBeNull();
      } finally {
        await open.rollback();
        await waiter.sql.end({ timeout: 5 });
      }
    },
  );

  it("a reserve for the same agent token at that business waits the same way", SLOW, async () => {
    await freshSeed();
    expect(await call(toolApi, exchangeOf("reserve-ai-door-15-min.json"))).toMatchObject({ result: "held" });
    const second = reserveRequest({
      reservationId: "rsv-agent-truck-26-nov21",
      businessId: MOVERS,
      resourceId: "res-truck-26",
      during: { start: "2026-11-21T13:00:00Z", end: "2026-11-21T21:00:00Z" },
      for: { agentToken: "agent-token-demo-1" },
      at: "2026-11-07T15:05:00Z",
    });
    expect(await reserve(toolApi, second)).toMatchObject({
      result: "held",
      heldUntil: "2026-11-07T15:15:00Z",
    });
    const open = await openToolApiTransaction(MOVERS);
    const waiter = await oneConnection("rosie-t198-token-waiter");
    try {
      expect(
        await extendIn(
          open.tx,
          extendRequest({
            reservationId: second.reservationId,
            businessId: MOVERS,
            at: "2026-11-07T15:14:00Z",
          }),
        ),
      ).toMatchObject({ result: "extended", heldUntil: "2026-11-07T15:25:00Z" });
      const pending = reserve(
        waiter.sql,
        reserveRequest({
          reservationId: "rsv-agent-truck-20-nov22",
          businessId: MOVERS,
          resourceId: "res-truck-20",
          during: { start: "2026-11-22T13:00:00Z", end: "2026-11-22T21:00:00Z" },
          for: { agentToken: "agent-token-demo-1" },
          at: "2026-11-07T15:16:00Z",
        }),
      );
      expect(await waitsOnLock(waiter.pid)).toBe(true);
      await open.commit();
      expect(await pending).toEqual({
        error: "savedTimeCap",
        saved: [
          { reservationId: "rsv-agent-truck-20-nov20", heldUntil: "2026-11-07T15:20:00Z" },
          { reservationId: "rsv-agent-truck-26-nov21", heldUntil: "2026-11-07T15:25:00Z" },
        ],
      });
      expect(await getReservation(db.sql, "rsv-agent-truck-20-nov22")).toBeNull();
    } finally {
      await open.rollback();
      await waiter.sql.end({ timeout: 5 });
    }
  });
});

// ---- a lost connection ---------------------------------------------------------------------------------------------

describe("a lost connection: extend answers transient, writes nothing, and the same request then extends (K-05 README line 50)", () => {
  /**
   * Runs `run` on its own one-connection client while another connection holds `lockKey`'s advisory lock (one of the
   * slot's keys extend takes), waits until the call's backend waits on it, cuts that backend with pg_terminate_backend
   * from a third connection, and returns the call's answer with the killed client for the resend.
   */
  async function killWhileWaiting<T>(
    lockKey: string,
    run: (sql: Sql) => Promise<T>,
  ): Promise<{ answer: T; victim: DbClient }> {
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
        await tx`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        locked();
        await hold;
      });
      await isLocked;
      const [backend] = await victim.primary<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const pid = backend?.pid ?? 0;
      const answering = run(victim.primary);
      expect(await waitsOnLock(pid)).toBe(true);
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

  it(
    "extend waiting on its slot's lock, its backend terminated: transient, nothing written; sent again, it extends",
    SLOW,
    async () => {
      await freshSeed();
      const asked = extendRequest();
      const { answer, victim } = await killWhileWaiting("resource:res-avery", (sql) => extend(sql, asked));
      try {
        expect(answer).toMatchObject({ error: "transient" });
        expect((answer as { sqlstate: string }).sqlstate).toMatch(/^(08[0-9A-Z]{3}|57P0[123])$/);
        expectContractAnswer("extend", answer);
        expect(await heldAs(ALEX_AVERY)).toEqual({
          state: "held",
          heldUntil: "2026-11-07T15:10:00Z",
          extended: false,
          version: 1,
        });
        // postgres.js keeps the killed query's error for the next query on that client: at most one stale transient.
        const answers: ExtendOutcome[] = [];
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const again = await extend(victim.primary, asked);
          answers.push(again);
          if (!("error" in again) || again.error !== "transient") {
            break;
          }
        }
        expect(answers.length).toBeLessThanOrEqual(2);
        expect(answers.at(-1)).toEqual({
          result: "extended",
          reservationId: ALEX_AVERY,
          version: 2,
          heldUntil: "2026-11-07T15:20:00Z",
        });
      } finally {
        await victim.close();
      }
    },
  );
});
