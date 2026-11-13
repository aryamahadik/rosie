// T-198: the reservation rules (K-05 v1 item 6: contracts/data-access/README.md items 8 to 10) against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/reservation-rules`). The schema comes from migrating a fresh
// test schema. The K-04 seeds are loaded by the tables' owner; the calls run as the Tool API's role, rosie_app (T-191),
// through a client whose connections take that role, so row-level security binds them as it will bind the Worker
// (T-1093), except where a test says it runs as the tables' owner.
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { type AddressInfo, createConnection, createServer, type Socket } from "node:net";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type DbClient, resolvePrimaryUrl } from "./client";
import { DataAccessDatabaseError, transientOrScrubbed } from "./clocks";
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
/** Connections in the Tool API's client, toolApi. */
const TOOL_API_POOL = 20;
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
/** toolApi's application_name, this run's own, so a count of its backends waiting on a lock sees only them. */
let toolApiName: string;

function toolApiClient(max: number, name: string): Sql {
  return postgres(resolvePrimaryUrl(), {
    max,
    onnotice: () => undefined,
    connection: { application_name: name, search_path: `${db.schema}, public`, role: TOOL_API_ROLE },
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "reservation_rules", client: { max: 20 } });
  toolApiName = `rosie-t198-tool-api-${db.schema}`;
  toolApi = toolApiClient(TOOL_API_POOL, toolApiName);
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

/** Loads K-04 seeds in order, each after the seeds it names in `after`, every seed once. */
async function loadSeed(...files: string[]): Promise<void> {
  const present = await db.sql<{ name: string }[]>`
    select table_name as name from information_schema.tables where table_schema = current_schema()
  `;
  const tables = new Set(present.map((row) => row.name));
  const seen = new Set<string>();
  for (const row of files.flatMap((file) => seedRows(file, seen))) {
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

/** Who a time is saved for, as the cap of 2 counts it: a mobile at every business, or an agent token at one. */
type Holder = { phoneNumber: string } | { agentToken: string; businessId: string };

const utcOf = (date: Date): string => date.toISOString().replace(".000Z", "Z");

/** The times `holder` has saved that are still saved at `at` (held, ending after it), read as the tables' owner. */
async function savedTimesAt(
  holder: Holder,
  at: string,
): Promise<{ reservationId: string; heldUntil: string }[]> {
  const rows =
    "phoneNumber" in holder
      ? await db.sql<{ id: string; held_until: Date }[]>`
          select id, held_until from reservations
          where for_phone_number = ${holder.phoneNumber} and state = 'held' and held_until > ${at}::timestamptz
          order by held_until, id collate "C"
        `
      : await db.sql<{ id: string; held_until: Date }[]>`
          select id, held_until from reservations
          where for_agent_token = ${holder.agentToken} and business_id = ${holder.businessId} and state = 'held'
            and held_until > ${at}::timestamptz
          order by held_until, id collate "C"
        `;
  return rows.map((row) => ({ reservationId: row.id, heldUntil: utcOf(row.held_until) }));
}

/** Adds `count` rooms, spread over `businesses` in turn, so reserves of different rooms share no slot lock. */
async function addRooms(count: number, businesses: string[]): Promise<{ id: string; businessId: string }[]> {
  const rooms = Array.from({ length: count }, (_, i) => ({
    id: `res-t198-room-${String(i)}`,
    business_id: businesses[i % businesses.length] ?? LEES,
    kind: "room",
    name: `Room ${String(i + 1)}`,
  }));
  await db.sql`insert into resources ${db.sql(rooms)}`;
  return rooms.map((room) => ({ id: room.id, businessId: room.business_id }));
}

/** Holds what `take` locks, in an open transaction of the tables' owner, until the function it returns ends it. */
async function holdLock(take: (tx: Sql) => Promise<unknown>): Promise<() => Promise<void>> {
  const reserved = await db.sql.reserve();
  let open = true;
  const end = async (): Promise<void> => {
    if (!open) {
      return;
    }
    open = false;
    try {
      await reserved`rollback`;
    } finally {
      reserved.release();
    }
  };
  try {
    await reserved`begin`;
    await take(reserved);
  } catch (error) {
    await end();
    throw error;
  }
  return end;
}

/** True once `count` backends of the client named `name` wait on a lock at once (polled every 50 ms, for at most 30 s). */
async function lockWaiters(name: string, count: number): Promise<boolean> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const [row] = await db.sql<{ waiting: number }[]>`
      select count(*)::int as waiting from pg_stat_activity
      where application_name = ${name} and wait_event_type = 'Lock'
    `;
    if ((row?.waiting ?? 0) >= count) {
      return true;
    }
    await sleep(50);
  }
  return false;
}

/**
 * Starts `attempts` on the Tool API's client while the tables' owner holds the cap's lock (`take`), waits until every
 * connection of that client waits on a lock at once (each inside reserve, at the cap's lock, before its count), then
 * lets the lock go and returns every answer.
 */
async function raceAtTheCapLock(
  take: (tx: Sql) => Promise<unknown>,
  attempts: (sql: Sql) => Promise<ReserveOutcome>[],
): Promise<ReserveOutcome[]> {
  const letGo = await holdLock(take);
  try {
    const racing = Promise.all(attempts(toolApi));
    expect(await lockWaiters(toolApiName, TOOL_API_POOL)).toBe(true);
    await letGo();
    return await racing;
  } finally {
    await letGo();
  }
}

/**
 * Exactly one of `outcomes` is held, until `heldUntil`; every other is savedTimeCap naming `first` and the one held,
 * in end order. Returns the id held.
 */
function expectOneHeld(
  outcomes: ReserveOutcome[],
  first: { reservationId: string; heldUntil: string },
  heldUntil: string,
): string {
  expect(tally(outcomes)).toEqual({ held: 1, savedTimeCap: outcomes.length - 1 });
  const won = outcomes.find((outcome) => "result" in outcome && outcome.result === "held");
  if (won === undefined || !("result" in won)) {
    throw new Error("no attempt was held");
  }
  expect(won).toMatchObject({ result: "held", heldUntil, repeated: false });
  const saved = [first, { reservationId: won.reservationId, heldUntil }];
  for (const outcome of outcomes) {
    if ("error" in outcome) {
      expect(outcome).toEqual({ error: "savedTimeCap", saved });
    }
  }
  return won.reservationId;
}

type FirstTry = "waits" | "answers transient";

/**
 * Sends `asked` to extend() on a one-connection client of the Tool API's role while another connection holds the
 * advisory lock `lockKey` (one of the slot's keys extend takes before the row's), so the extend waits on it. If its first
 * try waits, `meanwhile` runs while it waits, then the lock is let go and the extend goes on; if it answers transient,
 * its backend is cut while it waits (nothing written), then `meanwhile` runs. Returns the first try's answer.
 */
async function extendAround(
  lockKey: string,
  asked: ExtendRequest,
  firstTry: FirstTry,
  meanwhile: () => Promise<void>,
): Promise<ExtendOutcome> {
  const url = resolvePrimaryUrl();
  const holder = postgres(url, { max: 1, onnotice: () => undefined });
  const killer = postgres(url, { max: 1, onnotice: () => undefined });
  const caller = await oneConnection("rosie-t198-extend-first-try");
  let letGo: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  try {
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
    const answering = extend(caller.sql, asked);
    expect(await waitsOnLock(caller.pid)).toBe(true);
    if (firstTry === "answers transient") {
      await killer`select pg_terminate_backend(${caller.pid})`;
      const answer = await answering;
      letGo();
      await holding;
      await meanwhile();
      return answer;
    }
    await meanwhile();
    letGo();
    await holding;
    return await answering;
  } finally {
    letGo();
    await killer.end({ timeout: 5 });
    await holder.end({ timeout: 5 });
    // A killed connection is never released (reservation-rules.ts inBusinessTransaction), so nothing ends it but this.
    await caller.sql.end({ timeout: firstTry === "answers transient" ? 0 : 5 });
  }
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

  // From 1 saved time the lock decides (the security reviewer's note a on round 1): each attempt is for its own room,
  // so no slot lock puts them in a row, and every connection waits on the cap's lock at once before any counts.
  it(
    "from 1 saved time, 50 parallel attempts for one mobile at three businesses, all at its phones row's lock at once: exactly 1 held, 49 refused",
    HEAVY,
    async () => {
      await freshSeed();
      const rooms = await addRooms(50, [LEES, YOGA, MOVERS]);
      const at = "2026-11-07T15:07:00Z";
      const outcomes = await raceAtTheCapLock(
        (tx) => tx`select 1 from phones where number = ${ALEX} for update`,
        (sql) =>
          rooms.map((room, i) =>
            reserve(
              sql,
              reserveRequest({
                reservationId: `rsv-alex-race-${String(i)}`,
                businessId: room.businessId,
                resourceId: room.id,
                during: { start: "2026-12-05T10:00:00Z", end: "2026-12-05T11:00:00Z" },
                for: { phoneNumber: ALEX },
                at,
              }),
            ),
          ),
      );
      const avery = { reservationId: ALEX_AVERY, heldUntil: "2026-11-07T15:10:00Z" };
      const won = expectOneHeld(outcomes, avery, plus(at, 10));
      expect(await savedTimesAt({ phoneNumber: ALEX }, at)).toEqual([
        avery,
        { reservationId: won, heldUntil: plus(at, 10) },
      ]);
      const written = await db.sql<{ n: number }[]>`
        select count(*)::int as n from reservations where id like 'rsv-alex-race-%'
      `;
      expect(written[0]?.n).toBe(1);
    },
  );

  it(
    "from 1 saved time, 50 parallel attempts for one agent token at one business, all at its lock at once: exactly 1 held, 49 refused",
    HEAVY,
    async () => {
      await freshSeed();
      const token = "agent-token-t198";
      const first = reserveRequest({
        reservationId: "rsv-token-first",
        businessId: MOVERS,
        resourceId: "res-truck-20",
        during: { start: "2026-12-10T13:00:00Z", end: "2026-12-10T21:00:00Z" },
        for: { agentToken: token },
        at: "2026-11-07T15:05:00Z",
      });
      expect(await reserve(toolApi, first)).toMatchObject({
        result: "held",
        heldUntil: "2026-11-07T15:15:00Z",
      });
      const rooms = await addRooms(50, [MOVERS]);
      const at = "2026-11-07T15:07:00Z";
      // reservations.ts lockAndListSaved's key for a token at a business.
      const tokenKey = `token:${MOVERS}:${token}`;
      const outcomes = await raceAtTheCapLock(
        (tx) => tx`select pg_advisory_xact_lock(hashtextextended(${tokenKey}, 0))`,
        (sql) =>
          rooms.map((room, i) =>
            reserve(
              sql,
              reserveRequest({
                reservationId: `rsv-token-race-${String(i)}`,
                businessId: MOVERS,
                resourceId: room.id,
                during: { start: "2026-12-05T10:00:00Z", end: "2026-12-05T11:00:00Z" },
                for: { agentToken: token },
                at,
              }),
            ),
          ),
      );
      const firstSaved = { reservationId: "rsv-token-first", heldUntil: "2026-11-07T15:15:00Z" };
      const won = expectOneHeld(outcomes, firstSaved, plus(at, 10));
      expect(await savedTimesAt({ agentToken: token, businessId: MOVERS }, at)).toEqual([
        firstSaved,
        { reservationId: won, heldUntil: plus(at, 10) },
      ]);
      const written = await db.sql<{ n: number }[]>`
        select count(*)::int as n from reservations where id like 'rsv-token-race-%'
      `;
      expect(written[0]?.n).toBe(1);
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
      // Saved for Alex's booking: a time held for an agent token is never extended (DL-173), and a booking has no cap.
      expect(
        await reserve(
          toolApi,
          reserveRequest({
            reservationId: id,
            door,
            holdMinutes: minutes,
            during: hourSlot("2026-12-03T10:00:00Z", i),
            for: { bookingId: "booking-alex-haircut" },
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
    await loadSeed("seed-reservation.json", "seed-class-seats.json");
    const seats = (): Promise<{ taken: number; version: number }[]> => db.sql<
      { taken: number; version: number }[]
    >`
      select taken, version from class_seats where resource_id = 'res-handstand-workshop'
    `;
    // The seed's seat is saved for an agent token: never extended (DL-173), and nothing changes.
    expect(
      await extend(toolApi, extendRequest({ reservationId: "rsv-agent-workshop", businessId: YOGA })),
    ).toEqual({ error: "neverExtended", reservationId: "rsv-agent-workshop", door: "ownAi" });
    expect(await heldAs("rsv-agent-workshop")).toEqual({
      state: "held",
      heldUntil: "2026-11-07T15:10:00Z",
      extended: false,
      version: 1,
    });
    expect(await seats()).toEqual([{ taken: 2, version: 3 }]);
    // A seat saved for Alex's mobile (his second saved time, with Avery's) gets its one extension.
    const seat = reserveRequest({
      reservationId: "rsv-alex-workshop-second-seat",
      businessId: YOGA,
      resourceId: "res-handstand-workshop",
      during: { start: "2026-11-14T16:00:00Z", end: "2026-11-14T18:00:00Z" },
      for: { phoneNumber: ALEX },
    });
    expect(await reserve(toolApi, seat)).toMatchObject({
      result: "held",
      heldUntil: "2026-11-07T15:15:00Z",
    });
    expect(await seats()).toEqual([{ taken: 3, version: 4 }]);
    const asked = extendRequest({ reservationId: seat.reservationId, businessId: YOGA });
    expect(await extend(toolApi, asked)).toEqual({
      result: "extended",
      reservationId: seat.reservationId,
      version: 2,
      heldUntil: "2026-11-07T15:25:00Z",
    });
    expect(await extend(toolApi, { ...asked, expectVersion: 2 })).toEqual({
      error: "alreadyExtended",
      reservationId: seat.reservationId,
      heldUntil: "2026-11-07T15:25:00Z",
    });
    expect(await seats()).toEqual([{ taken: 3, version: 4 }]);
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

  it("a time held for an agent token is neverExtended whatever door is named, before the one extension and the version, and nothing changes (DL-173; DL-171)", async () => {
    await freshSeed();
    expect(await call(toolApi, exchangeOf("reserve-ai-door-15-min.json"))).toMatchObject({ result: "held" });
    // The same token's time saved through the standard door: K-04 keeps no door, so it fails closed all the same.
    expect(
      await reserve(
        toolApi,
        reserveRequest({
          reservationId: "rsv-agent-truck-26-nov21",
          businessId: MOVERS,
          resourceId: "res-truck-26",
          during: { start: "2026-11-21T13:00:00Z", end: "2026-11-21T21:00:00Z" },
          for: { agentToken: "agent-token-demo-1" },
          at: "2026-11-07T15:05:00Z",
        }),
      ),
    ).toMatchObject({ result: "held", heldUntil: "2026-11-07T15:15:00Z" });
    const doors: ExtendRequest["door"][] = ["standard", "ownAi", "planCheck", "document", "ownerOk"];
    for (const reservationId of ["rsv-agent-truck-20-nov20", "rsv-agent-truck-26-nov21"]) {
      const before = await heldAs(reservationId);
      for (const door of doors) {
        for (const expectVersion of [1, 7]) {
          for (const sql of [toolApi, db.sql]) {
            const outcome = await extend(
              sql,
              extendRequest({
                reservationId,
                businessId: MOVERS,
                door,
                expectVersion,
                at: "2026-11-07T15:12:00Z",
              }),
            );
            expect(outcome, `${reservationId} ${door} ${String(expectVersion)}`).toEqual({
              error: "neverExtended",
              reservationId,
              door: "ownAi",
            });
            expectContractAnswer("extend", outcome);
          }
        }
      }
      expect(await heldAs(reservationId)).toEqual(before);
    }
  });
});

// ---- no extend makes a third saved time -----------------------------------------------------------------------------

describe("an extend never gives a third saved time: once a reserve or a promotion counted its time as ended, it stays ended (DL-173; arch 05 line 247)", () => {
  interface Race {
    name: string;
    /** Seeds, and the holder's saved times before the race. */
    setUp: () => Promise<void>;
    /** The extend: its first try waits on `lockKey`, one of its slot's locks. */
    asked: ExtendRequest;
    lockKey: string;
    /** Saved for the same holder at a later `at`, while the first try waits or after it answered transient. */
    meanwhile: () => Promise<void>;
    /** The extend's answer once it goes on, and when the same request is sent again. */
    refused: ExtendOutcome;
    /** The extended row's end, unchanged. */
    oldEnd: string;
    holder: Holder;
    /** From the later `at` on, the holder's saved times: never more than 2. */
    from: string;
    savedFrom: { reservationId: string; heldUntil: string }[];
  }

  /** Alex's two saved times: Avery's (seed-reservation) until 15:10 and Riley's (reserve-10-min.json) until 15:15. */
  const ALEX_RILEY = { reservationId: "rsv-alex-riley-nov14", heldUntil: "2026-11-07T15:15:00Z" };
  const MAYA_NOV28 = { start: "2026-11-28T15:00:00Z", end: "2026-11-28T16:00:00Z" };
  const notHeldAvery: ExtendOutcome = { error: "notHeld", reservationId: ALEX_AVERY, state: "held" };

  const RACES: Race[] = [
    {
      name: "Alex's extend at 15:08, then a reserve for Alex at 15:11 that counted Avery's 15:10 as ended",
      setUp: async () => {
        await freshSeed();
        expect(await call(toolApi, exchangeOf("reserve-10-min.json"))).toMatchObject({ result: "held" });
      },
      asked: extendRequest(),
      lockKey: "resource:res-avery",
      meanwhile: async () => {
        expect(
          await reserve(
            toolApi,
            reserveRequest({
              reservationId: "rsv-alex-maya-nov28",
              businessId: YOGA,
              resourceId: "res-maya",
              during: MAYA_NOV28,
              for: { phoneNumber: ALEX },
              at: "2026-11-07T15:11:00Z",
            }),
          ),
        ).toMatchObject({ result: "held", heldUntil: "2026-11-07T15:21:00Z" });
      },
      refused: notHeldAvery,
      oldEnd: "2026-11-07T15:10:00Z",
      holder: { phoneNumber: ALEX },
      from: "2026-11-07T15:11:00Z",
      savedFrom: [ALEX_RILEY, { reservationId: "rsv-alex-maya-nov28", heldUntil: "2026-11-07T15:21:00Z" }],
    },
    {
      name: "a token's extend at 15:14, then a reserve for the token at that business at 15:16 that counted its 15:15 as ended",
      setUp: async () => {
        await freshSeed();
        expect(await call(toolApi, exchangeOf("reserve-ai-door-15-min.json"))).toMatchObject({
          result: "held",
        });
        expect(
          await reserve(
            toolApi,
            reserveRequest({
              reservationId: "rsv-agent-truck-26-nov21",
              businessId: MOVERS,
              resourceId: "res-truck-26",
              during: { start: "2026-11-21T13:00:00Z", end: "2026-11-21T21:00:00Z" },
              for: { agentToken: "agent-token-demo-1" },
              at: "2026-11-07T15:05:00Z",
            }),
          ),
        ).toMatchObject({ result: "held", heldUntil: "2026-11-07T15:15:00Z" });
      },
      asked: extendRequest({
        reservationId: "rsv-agent-truck-26-nov21",
        businessId: MOVERS,
        at: "2026-11-07T15:14:00Z",
      }),
      lockKey: "resource:res-truck-26",
      meanwhile: async () => {
        expect(
          await reserve(
            toolApi,
            reserveRequest({
              reservationId: "rsv-agent-truck-20-nov22",
              businessId: MOVERS,
              resourceId: "res-truck-20",
              during: { start: "2026-11-22T13:00:00Z", end: "2026-11-22T21:00:00Z" },
              for: { agentToken: "agent-token-demo-1" },
              at: "2026-11-07T15:16:00Z",
            }),
          ),
        ).toMatchObject({ result: "held", heldUntil: "2026-11-07T15:26:00Z" });
      },
      refused: { error: "neverExtended", reservationId: "rsv-agent-truck-26-nov21", door: "ownAi" },
      oldEnd: "2026-11-07T15:15:00Z",
      holder: { agentToken: "agent-token-demo-1", businessId: MOVERS },
      from: "2026-11-07T15:16:00Z",
      savedFrom: [
        { reservationId: "rsv-agent-truck-20-nov20", heldUntil: "2026-11-07T15:20:00Z" },
        { reservationId: "rsv-agent-truck-20-nov22", heldUntil: "2026-11-07T15:26:00Z" },
      ],
    },
    {
      name: "Alex's extend at 15:08, then a release at 15:11 that promoted Alex, next in line, counting Avery's 15:10 as ended",
      setUp: async () => {
        await freshSeed();
        // An agent token saves Maya's time; Alex, with only Avery's saved, waits next in line for it.
        expect(
          await reserve(
            toolApi,
            reserveRequest({
              reservationId: "rsv-token-maya-nov28",
              businessId: YOGA,
              resourceId: "res-maya",
              during: MAYA_NOV28,
              for: { agentToken: "agent-token-t198" },
              at: "2026-11-07T15:05:00Z",
            }),
          ),
        ).toMatchObject({ result: "held", heldUntil: "2026-11-07T15:15:00Z" });
        expect(
          await reserve(
            toolApi,
            reserveRequest({
              reservationId: "rsv-alex-maya-nov28",
              businessId: YOGA,
              resourceId: "res-maya",
              during: MAYA_NOV28,
              for: { phoneNumber: ALEX },
              waitIfSaved: true,
              at: "2026-11-07T15:06:00Z",
            }),
          ),
        ).toMatchObject({ result: "waiting", queuedAt: "2026-11-07T15:06:00Z" });
        expect(await call(toolApi, exchangeOf("reserve-10-min.json"))).toMatchObject({ result: "held" });
      },
      asked: extendRequest(),
      lockKey: "resource:res-avery",
      meanwhile: async () => {
        const released = await release(toolApi, {
          reservationId: "rsv-token-maya-nov28",
          businessId: YOGA,
          expectVersion: 1,
          why: "let_go",
          at: "2026-11-07T15:11:00Z",
        });
        expect(released).toMatchObject({
          result: "released",
          promoted: {
            reservationId: "rsv-alex-maya-nov28",
            heldUntil: "2026-11-07T15:21:00Z",
            forPhoneNumber: ALEX,
          },
          skipped: [],
        });
      },
      refused: notHeldAvery,
      oldEnd: "2026-11-07T15:10:00Z",
      holder: { phoneNumber: ALEX },
      from: "2026-11-07T15:11:00Z",
      savedFrom: [ALEX_RILEY, { reservationId: "rsv-alex-maya-nov28", heldUntil: "2026-11-07T15:21:00Z" }],
    },
  ];

  for (const firstTry of ["waits", "answers transient"] as const) {
    for (const race of RACES) {
      it(
        `${race.name}; the extend's first try ${firstTry}, and the same request sent again`,
        SLOW,
        async () => {
          await race.setUp();
          const first = await extendAround(race.lockKey, race.asked, firstTry, race.meanwhile);
          if (firstTry === "waits") {
            expect(first).toEqual(race.refused);
          } else {
            expect(first).toMatchObject({ error: "transient" });
            expect((first as { sqlstate: string }).sqlstate).toMatch(/^(08[0-9A-Z]{3}|57P0[123])$/);
          }
          expectContractAnswer("extend", first);
          // K-05 README line 50: the same request may be sent again.
          const again = await extend(toolApi, race.asked);
          expect(again).toEqual(race.refused);
          expectContractAnswer("extend", again);
          expect(await heldAs(race.asked.reservationId)).toEqual({
            state: "held",
            heldUntil: race.oldEnd,
            extended: false,
            version: 1,
          });
          expect(await savedTimesAt(race.holder, race.from)).toEqual(race.savedFrom);
        },
      );
    }
  }
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

// ---- one row per holder per slot (T-1134) --------------------------------------------------------------------------

describe("T-1134: one row per holder per slot: a save never waits behind its own holder's saved time, and a let-go never promotes the released holder's own waiting row (T-744 round 1's security GAP 1; DL-292; MC C3)", () => {
  const TOKEN_A = "agent-token-t1134-a";
  const TOKEN_B = "agent-token-t1134-b";
  const TOKEN_C = "agent-token-t1134-c";
  /** The movers' 20-ft truck for Nov 27, a vehicle: its slot's one lock is the resource's. */
  const TRUCK = "res-truck-20";
  const TRUCK_DAY = { start: "2026-11-27T13:00:00Z", end: "2026-11-27T21:00:00Z" };
  const TRUCK_SLOT_KEY = `resource:${TRUCK}`;
  /** Riley at Lee's Barbershop, Dec 3 and Dec 4 at 10:00. */
  const RILEY_DEC3 = { start: "2026-12-03T10:00:00Z", end: "2026-12-03T10:30:00Z" };
  const RILEY_DEC4 = { start: "2026-12-04T10:00:00Z", end: "2026-12-04T10:30:00Z" };

  /** A save of the truck's day for `agentToken` through C3's door (ownAi: 15 minutes, never extended), with nextInLine. */
  function c3Save(reservationId: string, agentToken: string, at: string): ReserveRequest {
    return reserveRequest({
      reservationId,
      businessId: MOVERS,
      resourceId: TRUCK,
      during: TRUCK_DAY,
      for: { agentToken },
      door: "ownAi",
      waitIfSaved: true,
      at,
    });
  }

  /** rsv-1 as TOKEN_A's first save got it at 09:50: held through C3's door until 10:05. */
  const RSV_1_HELD = {
    result: "held",
    reservationId: "rsv-1",
    version: 1,
    resourceId: TRUCK,
    during: TRUCK_DAY,
    heldUntil: "2026-11-09T10:05:00Z",
    savedTimeClockId: "rsv-1/saved-time",
  };

  /** The clock's let-go of rsv-1 at 10:05: release, expired, with no version (K-05 README item 9). */
  const lapseOfRsv1 = (): Promise<ReleaseOutcome> =>
    release(toolApi, {
      reservationId: "rsv-1",
      businessId: MOVERS,
      expectVersion: null,
      why: "expired",
      at: "2026-11-09T10:05:00Z",
    });

  /** A promotion's answer: held for the standard 10 minutes from `at` (K-05 README item 9), for an agent token. */
  function promotedFor(reservationId: string, agentToken: string, at: string): Record<string, unknown> {
    return {
      reservationId,
      version: 2,
      heldUntil: plus(at, STANDARD_HOLD_MINUTES),
      forPhoneNumber: null,
      forAgentToken: agentToken,
      bookingId: null,
      savedTimeClockId: `${reservationId}/saved-time`,
    };
  }

  interface SlotRow {
    id: string;
    state: string;
    holder: string | null;
    version: number;
  }

  /** Every row of `resourceId` whose time overlaps `during`, in line order, with who it is saved for (the tables' owner reads). */
  async function rowsOnSlot(resourceId: string, during: { start: string; end: string }): Promise<SlotRow[]> {
    const rows = await db.sql<SlotRow[]>`
      select id, state, coalesce(for_agent_token, for_phone_number, booking_id) as holder, version
      from reservations
      where resource_id = ${resourceId}
        and during && tstzrange(${during.start}::timestamptz, ${during.end}::timestamptz, '[)')
      order by queued_at, id collate "C"
    `;
    return rows.map((row) => ({ ...row }));
  }

  /**
   * A waiting row written straight into the table, as T-187's reserve wrote one before T-1134 (round 1's GAP 1: a holder
   * queued behind its own saved time). Rule (1) never writes one now, but rule (2) must still let it go.
   */
  async function queuedAsBefore(row: {
    id: string;
    businessId: string;
    resourceId: string;
    kind: "worker" | "vehicle";
    personId: string | null;
    during: { start: string; end: string };
    queuedAt: string;
    for: { agentToken: string } | { phoneNumber: string };
  }): Promise<void> {
    await db.sql`insert into reservations ${db.sql({
      id: row.id,
      business_id: row.businessId,
      resource_id: row.resourceId,
      resource_kind: row.kind,
      worker_person_id: row.personId,
      during: `[${row.during.start},${row.during.end})`,
      state: "waiting",
      queued_at: row.queuedAt,
      for_agent_token: "agentToken" in row.for ? row.for.agentToken : null,
      for_phone_number: "phoneNumber" in row.for ? row.for.phoneNumber : null,
    })}`;
  }

  /** A waiting row TOKEN_A had behind its own rsv-1 on the truck's day, queued at `queuedAt`. */
  const tokenAQueuedOnTruck = (id: string, queuedAt: string): Promise<void> =>
    queuedAsBefore({
      id,
      businessId: MOVERS,
      resourceId: TRUCK,
      kind: "vehicle",
      personId: null,
      during: TRUCK_DAY,
      queuedAt,
      for: { agentToken: TOKEN_A },
    });

  /**
   * Starts `attempts` on the Tool API's client while the tables' owner holds the slot's advisory lock (`slotKey`, the
   * key lockSlot takes), waits until `waiters` of that client's connections wait on a lock at once (each inside reserve,
   * at the slot's lock, before it reads the slot), then lets the lock go and returns every answer.
   */
  async function raceAtTheSlotLock(
    slotKey: string,
    waiters: number,
    attempts: (sql: Sql) => Promise<ReserveOutcome>[],
  ): Promise<ReserveOutcome[]> {
    const letGo = await holdLock((tx) => tx`select pg_advisory_xact_lock(hashtextextended(${slotKey}, 0))`);
    try {
      const racing = Promise.all(attempts(toolApi));
      expect(await lockWaiters(toolApiName, waiters)).toBe(true);
      await letGo();
      return await racing;
    } finally {
      await letGo();
    }
  }

  it("(a) the reviewer's scenario: TOKEN_A saves rsv-1 on C3's door at 09:50, held to 10:05, then asks for the same slot with waitIfSaved at 09:51 to 09:54: nothing is written and each answer is rsv-1 as held; at 10:05 the let-go promotes nobody, and the slot opens again", async () => {
    await freshSeed();
    expect(await reserve(toolApi, c3Save("rsv-1", TOKEN_A, "2026-11-09T09:50:00Z"))).toEqual({
      ...RSV_1_HELD,
      repeated: false,
    });
    for (const [i, minute] of ["51", "52", "53", "54"].entries()) {
      const id = `rsv-${String(i + 2)}`;
      const again = await reserve(toolApi, c3Save(id, TOKEN_A, `2026-11-09T09:${minute}:00Z`));
      expect(again, id).toEqual({ ...RSV_1_HELD, repeated: true });
      expectContractAnswer("reserve", again);
      expect(await getReservation(db.sql, id), id).toBeNull();
    }
    expect(await rowsOnSlot(TRUCK, TRUCK_DAY)).toEqual([
      { id: "rsv-1", state: "held", holder: TOKEN_A, version: 1 },
    ]);
    const lapse = await lapseOfRsv1();
    expect(lapse).toEqual({
      result: "released",
      reservationId: "rsv-1",
      version: 2,
      releasedAt: "2026-11-09T10:05:00Z",
      why: "expired",
      promoted: null,
      skipped: [],
      repeated: false,
    });
    expectContractAnswer("release", lapse);
    // The time is let go and the slot opens again (MC C3): the first to ask saves it.
    expect(await reserve(toolApi, c3Save("rsv-b", TOKEN_B, "2026-11-09T10:06:00Z"))).toMatchObject({
      result: "held",
      reservationId: "rsv-b",
      heldUntil: "2026-11-09T10:21:00Z",
      repeated: false,
    });
  });

  it("(a) with TOKEN_B in line from 09:52, TOKEN_A's asks at 09:51 and 09:53 still write nothing; at 10:05 the let-go promotes TOKEN_B, the first other holder", async () => {
    await freshSeed();
    expect(await reserve(toolApi, c3Save("rsv-1", TOKEN_A, "2026-11-09T09:50:00Z"))).toEqual({
      ...RSV_1_HELD,
      repeated: false,
    });
    expect(await reserve(toolApi, c3Save("rsv-2", TOKEN_A, "2026-11-09T09:51:00Z"))).toEqual({
      ...RSV_1_HELD,
      repeated: true,
    });
    expect(await reserve(toolApi, c3Save("rsv-b", TOKEN_B, "2026-11-09T09:52:00Z"))).toEqual({
      result: "waiting",
      reservationId: "rsv-b",
      version: 1,
      resourceId: TRUCK,
      during: TRUCK_DAY,
      queuedAt: "2026-11-09T09:52:00Z",
      repeated: false,
    });
    expect(await reserve(toolApi, c3Save("rsv-3", TOKEN_A, "2026-11-09T09:53:00Z"))).toEqual({
      ...RSV_1_HELD,
      repeated: true,
    });
    expect(await rowsOnSlot(TRUCK, TRUCK_DAY)).toEqual([
      { id: "rsv-1", state: "held", holder: TOKEN_A, version: 1 },
      { id: "rsv-b", state: "waiting", holder: TOKEN_B, version: 1 },
    ]);
    const lapse = await lapseOfRsv1();
    expect(lapse).toEqual({
      result: "released",
      reservationId: "rsv-1",
      version: 2,
      releasedAt: "2026-11-09T10:05:00Z",
      why: "expired",
      promoted: promotedFor("rsv-b", TOKEN_B, "2026-11-09T10:05:00Z"),
      skipped: [],
      repeated: false,
    });
    expect(await rowsOnSlot(TRUCK, TRUCK_DAY)).toEqual([
      { id: "rsv-1", state: "released", holder: TOKEN_A, version: 2 },
      { id: "rsv-b", state: "held", holder: TOKEN_B, version: 2 },
    ]);
  });

  it("(a) waiting rows TOKEN_A already had behind rsv-1, as round 1's reserve wrote them at 09:51 and 09:53, are let go with rsv-1 at 10:05 and never promoted: TOKEN_B, in line between them, is promoted, or with nobody else in line, nobody", async () => {
    for (const othersInLine of [[], ["rsv-b"]]) {
      await freshSeed();
      expect(await reserve(toolApi, c3Save("rsv-1", TOKEN_A, "2026-11-09T09:50:00Z"))).toEqual({
        ...RSV_1_HELD,
        repeated: false,
      });
      await tokenAQueuedOnTruck("rsv-2", "2026-11-09T09:51:00Z");
      for (const id of othersInLine) {
        expect(await reserve(toolApi, c3Save(id, TOKEN_B, "2026-11-09T09:52:00Z"))).toMatchObject({
          result: "waiting",
          reservationId: id,
          repeated: false,
        });
      }
      await tokenAQueuedOnTruck("rsv-3", "2026-11-09T09:53:00Z");
      const lapse = await lapseOfRsv1();
      expect(lapse, othersInLine.join()).toEqual({
        result: "released",
        reservationId: "rsv-1",
        version: 2,
        releasedAt: "2026-11-09T10:05:00Z",
        why: "expired",
        promoted: othersInLine.length === 0 ? null : promotedFor("rsv-b", TOKEN_B, "2026-11-09T10:05:00Z"),
        skipped: [],
        repeated: false,
      });
      expectContractAnswer("release", lapse);
      for (const id of ["rsv-2", "rsv-3"]) {
        expect(await getReservation(db.sql, id), id).toMatchObject({
          state: "released",
          heldUntil: null,
          releasedAt: "2026-11-09T10:05:00Z",
          releasedWhy: "let_go",
          version: 2,
        });
      }
      // TOKEN_A holds and waits on nothing there now; whoever was promoted holds it alone.
      const left = (await rowsOnSlot(TRUCK, TRUCK_DAY)).filter((row) => row.state !== "released");
      expect(left, othersInLine.join()).toEqual(
        othersInLine.length === 0 ? [] : [{ id: "rsv-b", state: "held", holder: TOKEN_B, version: 2 }],
      );
    }
  });

  it("(b) one mobile after its one extension: its asks for the same slot write nothing and answer its row as held to the new end; a waiting row it had there (as round 1 wrote it) is let go at that end, and the first other holder is promoted", async () => {
    await freshSeed();
    const tomas = (reservationId: string, at: string): ReserveRequest =>
      reserveRequest({
        reservationId,
        during: RILEY_DEC3,
        for: { phoneNumber: TOMAS },
        waitIfSaved: true,
        at,
      });
    expect(await reserve(toolApi, tomas("rsv-tomas-1", "2026-11-09T10:00:00Z"))).toMatchObject({
      result: "held",
      reservationId: "rsv-tomas-1",
      heldUntil: "2026-11-09T10:10:00Z",
      repeated: false,
    });
    // Its one extension (Q-12: "once"), before it ends.
    expect(
      await extend(toolApi, extendRequest({ reservationId: "rsv-tomas-1", at: "2026-11-09T10:08:00Z" })),
    ).toEqual({
      result: "extended",
      reservationId: "rsv-tomas-1",
      version: 2,
      heldUntil: "2026-11-09T10:20:00Z",
    });
    const heldAgain = {
      result: "held",
      reservationId: "rsv-tomas-1",
      version: 2,
      resourceId: "res-riley",
      during: RILEY_DEC3,
      heldUntil: "2026-11-09T10:20:00Z",
      savedTimeClockId: "rsv-tomas-1/saved-time",
      repeated: true,
    };
    expect(await reserve(toolApi, tomas("rsv-tomas-2", "2026-11-09T10:09:00Z"))).toEqual(heldAgain);
    await queuedAsBefore({
      id: "rsv-tomas-queued",
      businessId: LEES,
      resourceId: "res-riley",
      kind: "worker",
      personId: "person-riley",
      during: RILEY_DEC3,
      queuedAt: "2026-11-09T10:11:00Z",
      for: { phoneNumber: TOMAS },
    });
    expect(
      await reserve(
        toolApi,
        reserveRequest({
          reservationId: "rsv-c",
          during: RILEY_DEC3,
          for: { agentToken: TOKEN_C },
          waitIfSaved: true,
          at: "2026-11-09T10:12:00Z",
        }),
      ),
    ).toEqual({
      result: "waiting",
      reservationId: "rsv-c",
      version: 1,
      resourceId: "res-riley",
      during: RILEY_DEC3,
      queuedAt: "2026-11-09T10:12:00Z",
      repeated: false,
    });
    // The row it holds answers, not the one it waits on.
    const again = await reserve(toolApi, tomas("rsv-tomas-3", "2026-11-09T10:15:00Z"));
    expect(again).toEqual(heldAgain);
    expectContractAnswer("reserve", again);
    // The one extension is spent.
    expect(
      await extend(
        toolApi,
        extendRequest({ reservationId: "rsv-tomas-1", expectVersion: 2, at: "2026-11-09T10:16:00Z" }),
      ),
    ).toEqual({ error: "alreadyExtended", reservationId: "rsv-tomas-1", heldUntil: "2026-11-09T10:20:00Z" });
    for (const id of ["rsv-tomas-2", "rsv-tomas-3"]) {
      expect(await getReservation(db.sql, id), id).toBeNull();
    }
    const lapse = await release(toolApi, {
      reservationId: "rsv-tomas-1",
      businessId: LEES,
      expectVersion: null,
      why: "expired",
      at: "2026-11-09T10:20:00Z",
    });
    expect(lapse).toEqual({
      result: "released",
      reservationId: "rsv-tomas-1",
      version: 3,
      releasedAt: "2026-11-09T10:20:00Z",
      why: "expired",
      promoted: promotedFor("rsv-c", TOKEN_C, "2026-11-09T10:20:00Z"),
      skipped: [],
      repeated: false,
    });
    expect(await getReservation(db.sql, "rsv-tomas-queued")).toMatchObject({
      state: "released",
      releasedAt: "2026-11-09T10:20:00Z",
      releasedWhy: "let_go",
      version: 2,
    });
    expect(await rowsOnSlot("res-riley", RILEY_DEC3)).toEqual([
      { id: "rsv-tomas-1", state: "released", holder: TOMAS, version: 3 },
      { id: "rsv-tomas-queued", state: "released", holder: TOMAS, version: 2 },
      { id: "rsv-c", state: "held", holder: TOKEN_C, version: 2 },
    ]);
  });

  it(
    "(c) TOKEN_A waits behind TOKEN_B; a second wait by TOKEN_A, for the same time or one that overlaps it, writes nothing; when TOKEN_B lets go (20 times at once) TOKEN_A is promoted once, and TOKEN_A's own let-go promotes the next other holder",
    SLOW,
    async () => {
      await freshSeed();
      const ask = (
        reservationId: string,
        agentToken: string,
        at: string,
        during = RILEY_DEC4,
      ): ReserveRequest =>
        reserveRequest({ reservationId, during, for: { agentToken }, waitIfSaved: true, at });
      expect(await reserve(toolApi, ask("rsv-b", TOKEN_B, "2026-11-09T10:00:00Z"))).toMatchObject({
        result: "held",
        reservationId: "rsv-b",
        heldUntil: "2026-11-09T10:10:00Z",
      });
      const aWaits = {
        result: "waiting",
        reservationId: "rsv-a1",
        version: 1,
        resourceId: "res-riley",
        during: RILEY_DEC4,
        queuedAt: "2026-11-09T10:01:00Z",
      };
      expect(await reserve(toolApi, ask("rsv-a1", TOKEN_A, "2026-11-09T10:01:00Z"))).toEqual({
        ...aWaits,
        repeated: false,
      });
      // Another holder never gets another's row: TOKEN_C waits under its own id.
      expect(await reserve(toolApi, ask("rsv-c", TOKEN_C, "2026-11-09T10:02:00Z"))).toEqual({
        result: "waiting",
        reservationId: "rsv-c",
        version: 1,
        resourceId: "res-riley",
        during: RILEY_DEC4,
        queuedAt: "2026-11-09T10:02:00Z",
        repeated: false,
      });
      const overlapping = { start: "2026-12-04T10:15:00Z", end: "2026-12-04T10:45:00Z" };
      for (const [id, during] of [
        ["rsv-a2", RILEY_DEC4],
        ["rsv-a3", overlapping],
      ] as const) {
        const again = await reserve(toolApi, ask(id, TOKEN_A, "2026-11-09T10:03:00Z", during));
        expect(again, id).toEqual({ ...aWaits, repeated: true });
        expectContractAnswer("reserve", again);
        expect(await getReservation(db.sql, id), id).toBeNull();
      }
      const letGos = await Promise.all(
        Array.from({ length: 20 }, () =>
          release(toolApi, {
            reservationId: "rsv-b",
            businessId: LEES,
            expectVersion: 1,
            why: "let_go",
            at: "2026-11-09T10:05:00Z",
          }),
        ),
      );
      const released = {
        result: "released",
        reservationId: "rsv-b",
        version: 2,
        releasedAt: "2026-11-09T10:05:00Z",
        why: "let_go",
        skipped: [],
      };
      expect(letGos.filter((outcome) => "result" in outcome && !outcome.repeated)).toEqual([
        { ...released, promoted: promotedFor("rsv-a1", TOKEN_A, "2026-11-09T10:05:00Z"), repeated: false },
      ]);
      expect(letGos.filter((outcome) => "result" in outcome && outcome.repeated)).toEqual(
        Array.from({ length: 19 }, () => ({ ...released, promoted: null, repeated: true })),
      );
      expect(await rowsOnSlot("res-riley", RILEY_DEC4)).toEqual([
        { id: "rsv-b", state: "released", holder: TOKEN_B, version: 2 },
        { id: "rsv-a1", state: "held", holder: TOKEN_A, version: 2 },
        { id: "rsv-c", state: "waiting", holder: TOKEN_C, version: 1 },
      ]);
      // Holding it now, TOKEN_A's next ask answers that row, as held.
      expect(await reserve(toolApi, ask("rsv-a4", TOKEN_A, "2026-11-09T10:06:00Z"))).toEqual({
        result: "held",
        reservationId: "rsv-a1",
        version: 2,
        resourceId: "res-riley",
        during: RILEY_DEC4,
        heldUntil: "2026-11-09T10:15:00Z",
        savedTimeClockId: "rsv-a1/saved-time",
        repeated: true,
      });
      expect(
        await release(toolApi, {
          reservationId: "rsv-a1",
          businessId: LEES,
          expectVersion: 2,
          why: "let_go",
          at: "2026-11-09T10:07:00Z",
        }),
      ).toEqual({
        result: "released",
        reservationId: "rsv-a1",
        version: 3,
        releasedAt: "2026-11-09T10:07:00Z",
        why: "let_go",
        promoted: promotedFor("rsv-c", TOKEN_C, "2026-11-09T10:07:00Z"),
        skipped: [],
        repeated: false,
      });
    },
  );

  it("(c) a second waiting row TOKEN_A had in that line (as round 1 wrote it) is never promoted: TOKEN_B's let-go promotes TOKEN_A's first, and TOKEN_A's let-go lets the other go and promotes TOKEN_C", async () => {
    await freshSeed();
    const ask = (reservationId: string, agentToken: string, at: string): ReserveRequest =>
      reserveRequest({ reservationId, during: RILEY_DEC4, for: { agentToken }, waitIfSaved: true, at });
    expect(await reserve(toolApi, ask("rsv-b", TOKEN_B, "2026-11-09T10:00:00Z"))).toMatchObject({
      result: "held",
    });
    expect(await reserve(toolApi, ask("rsv-a1", TOKEN_A, "2026-11-09T10:01:00Z"))).toMatchObject({
      result: "waiting",
      reservationId: "rsv-a1",
    });
    await queuedAsBefore({
      id: "rsv-a-queued",
      businessId: LEES,
      resourceId: "res-riley",
      kind: "worker",
      personId: "person-riley",
      during: RILEY_DEC4,
      queuedAt: "2026-11-09T10:01:30Z",
      for: { agentToken: TOKEN_A },
    });
    expect(await reserve(toolApi, ask("rsv-c", TOKEN_C, "2026-11-09T10:02:00Z"))).toMatchObject({
      result: "waiting",
      reservationId: "rsv-c",
    });
    expect(
      await release(toolApi, {
        reservationId: "rsv-b",
        businessId: LEES,
        expectVersion: 1,
        why: "let_go",
        at: "2026-11-09T10:05:00Z",
      }),
    ).toMatchObject({ promoted: promotedFor("rsv-a1", TOKEN_A, "2026-11-09T10:05:00Z"), skipped: [] });
    const aLetsGo = await release(toolApi, {
      reservationId: "rsv-a1",
      businessId: LEES,
      expectVersion: 2,
      why: "let_go",
      at: "2026-11-09T10:07:00Z",
    });
    expect(aLetsGo).toEqual({
      result: "released",
      reservationId: "rsv-a1",
      version: 3,
      releasedAt: "2026-11-09T10:07:00Z",
      why: "let_go",
      promoted: promotedFor("rsv-c", TOKEN_C, "2026-11-09T10:07:00Z"),
      skipped: [],
      repeated: false,
    });
    expectContractAnswer("release", aLetsGo);
    expect(await rowsOnSlot("res-riley", RILEY_DEC4)).toEqual([
      { id: "rsv-b", state: "released", holder: TOKEN_B, version: 2 },
      { id: "rsv-a1", state: "released", holder: TOKEN_A, version: 3 },
      { id: "rsv-a-queued", state: "released", holder: TOKEN_A, version: 2 },
      { id: "rsv-c", state: "held", holder: TOKEN_C, version: 2 },
    ]);
    expect(await getReservation(db.sql, "rsv-a-queued")).toMatchObject({
      releasedAt: "2026-11-09T10:07:00Z",
      releasedWhy: "let_go",
    });
  });

  for (const [who, holder, holderKey] of [
    ["one token", { agentToken: TOKEN_A }, TOKEN_A],
    ["one mobile", { phoneNumber: ALEX }, ALEX],
  ] as const) {
    it(
      `(d) ${who} saving one slot twice at once, both at the slot's lock: one held row, no waiting row, and both answers name it`,
      SLOW,
      async () => {
        await freshSeed();
        const at = "2026-11-09T09:50:00Z";
        const twice = (reservationId: string): ReserveRequest => ({
          ...c3Save(reservationId, TOKEN_A, at),
          for: holder,
          door: "standard",
        });
        const outcomes = await raceAtTheSlotLock(TRUCK_SLOT_KEY, 2, (sql) => [
          reserve(sql, twice("rsv-twice-1")),
          reserve(sql, twice("rsv-twice-2")),
        ]);
        expect(tally(outcomes)).toEqual({ held: 2 });
        const wrote = outcomes.filter((outcome) => "result" in outcome && !outcome.repeated);
        expect(wrote).toHaveLength(1);
        const [first] = wrote;
        if (first === undefined || !("result" in first)) {
          throw new Error("no save wrote the slot");
        }
        const won = first.reservationId;
        expect(["rsv-twice-1", "rsv-twice-2"]).toContain(won);
        for (const outcome of outcomes) {
          expect(outcome).toEqual({
            result: "held",
            reservationId: won,
            version: 1,
            resourceId: TRUCK,
            during: TRUCK_DAY,
            heldUntil: "2026-11-09T10:00:00Z",
            savedTimeClockId: `${won}/saved-time`,
            repeated: outcome !== first,
          });
        }
        expect(await rowsOnSlot(TRUCK, TRUCK_DAY)).toEqual([
          { id: won, state: "held", holder: holderKey, version: 1 },
        ]);
      },
    );
  }

  it(
    "(d) 200 parallel saves of one slot by 200 holders, asking to wait if it is saved: one held row, and every other holder waits once under its own id",
    HEAVY,
    async () => {
      await freshSeed();
      const at = "2026-11-09T09:50:00Z";
      const outcomes = await raceAtTheSlotLock(TRUCK_SLOT_KEY, TOOL_API_POOL, (sql) =>
        Array.from({ length: 200 }, (_, i) =>
          reserve(sql, c3Save(`rsv-many-${String(i)}`, `agent-token-t1134-${String(i)}`, at)),
        ),
      );
      expect(tally(outcomes)).toEqual({ held: 1, waiting: 199 });
      for (const [i, outcome] of outcomes.entries()) {
        expect(outcome).toMatchObject({ reservationId: `rsv-many-${String(i)}`, repeated: false });
      }
      const rows = await rowsOnSlot(TRUCK, TRUCK_DAY);
      expect(rows.filter((row) => row.state === "held")).toHaveLength(1);
      expect(rows.filter((row) => row.state === "waiting")).toHaveLength(199);
      expect(new Set(rows.map((row) => row.holder)).size).toBe(200);
    },
  );

  it(
    "(d) 200 parallel saves of one slot by 100 holders, each saving it twice: one held row, each other holder waits once, and a holder's two answers name its one row",
    HEAVY,
    async () => {
      await freshSeed();
      const at = "2026-11-09T09:50:00Z";
      const tokenOf = (i: number): string => `agent-token-t1134-${String(i % 100)}`;
      const outcomes = await raceAtTheSlotLock(TRUCK_SLOT_KEY, TOOL_API_POOL, (sql) =>
        Array.from({ length: 200 }, (_, i) => reserve(sql, c3Save(`rsv-pair-${String(i)}`, tokenOf(i), at))),
      );
      expect(tally(outcomes)).toEqual({ held: 2, waiting: 198 });
      const rows = await rowsOnSlot(TRUCK, TRUCK_DAY);
      expect(rows).toHaveLength(100);
      expect(rows.filter((row) => row.state === "held")).toHaveLength(1);
      expect(new Set(rows.map((row) => row.holder)).size).toBe(100);
      const rowOf = new Map(rows.map((row) => [row.holder, row.id]));
      for (let i = 0; i < 100; i += 1) {
        const pair = [outcomes[i], outcomes[i + 100]];
        for (const outcome of pair) {
          expect(outcome, tokenOf(i)).toMatchObject({ reservationId: rowOf.get(tokenOf(i)) });
        }
        expect(
          pair.filter((outcome) => outcome !== undefined && "result" in outcome && !outcome.repeated),
          tokenOf(i),
        ).toHaveLength(1);
      }
    },
  );
});

// ---- T-1322: a statement's own refusal and postgres.js's statement errors leave scrubbed ------------------------------
//
// Five errors are made for real on local PostgreSQL by postgres.js as installed, four of them holding a made-up number
// (rule 9: a 555-01xx number): PostgreSQL's refusal of a statement (22P02, the number in its message) and of a row (a
// CHECK's 23514, the number in its detail, with its table's and constraint's names); postgres.js's UNDEFINED_VALUE (the
// number among the statement's args) and the TypeError its bytea serializer throws (the number in its message); and a
// serialization failure PostgreSQL raises (40001). postgres.js puts the statement on each, its values in args. Each
// reaches the call as postgres.js rejects the call's first statement with it, on a client whose socket fails with it
// (as connect-failures.int.test.ts delivers a socket's error). The first four leave scrubbed: the call's name and the
// code alone, PostgreSQL's as DataAccessDatabaseError (a rule's table and constraint names kept), with the number in no
// message, stack or other own property. 40001 still answers transient with its SQLSTATE.

describe("extend: a statement's own refusal and postgres.js's statement errors leave scrubbed (T-1322)", () => {
  type Kind = "refusal" | "rule" | "undefinedValue" | "serialization" | "serialize";
  /** Thrown as DataAccessDatabaseError (its message's SQLSTATE and names: `shown`), as a client's code, or answered. */
  type Expected =
    | { database: { code: string; table: string | null; constraint: string | null; shown: string } }
    | { client: string }
    | { answer: unknown };
  const NUMBER = "+15555550147";
  const KINDS: { kind: Kind; name: string; expected: Expected }[] = [
    {
      kind: "refusal",
      name: "PostgreSQL's 22P02, the number in its message, leaves as DataAccessDatabaseError",
      expected: { database: { code: "22P02", table: null, constraint: null, shown: "22P02" } },
    },
    {
      kind: "rule",
      name: "a CHECK's 23514, the number in its detail, leaves as DataAccessDatabaseError, its names kept",
      expected: {
        database: {
          code: "23514",
          table: "t1322_numbers",
          constraint: "t1322_numbers_short",
          shown: "23514, table t1322_numbers, constraint t1322_numbers_short",
        },
      },
    },
    {
      kind: "undefinedValue",
      name: "postgres.js's UNDEFINED_VALUE, the number in its args, leaves with its code alone",
      expected: { client: "UNDEFINED_VALUE" },
    },
    {
      kind: "serialize",
      name: "the TypeError of postgres.js's bytea serializer, the number in its message, leaves with its code alone",
      expected: { client: "ERR_INVALID_ARG_TYPE" },
    },
    {
      kind: "serialization",
      name: "PostgreSQL's 40001 still answers transient with its SQLSTATE",
      expected: { answer: { error: "transient", sqlstate: "40001" } },
    },
  ];
  const CALLS: { call: string; run: (sql: Sql) => Promise<unknown> }[] = [
    {
      call: "extend",
      run: (sql) =>
        extend(sql, {
          reservationId: "rsv-t1322",
          businessId: LEES,
          expectVersion: 1,
          door: "standard",
          at: "2026-11-09T15:00:00Z",
        }),
    },
  ];
  const CASES = CALLS.flatMap(({ call, run }) =>
    KINDS.map(({ kind, name, expected }) => ({ call, run, kind, expected, name: `${call}: ${name}` })),
  );
  let made: Record<Kind, Error>;

  /** Every text `value` holds, deeply: its own property names and values, enumerable or not, its stack among them. */
  const textsOf = (value: unknown, seen = new Set<object>()): string[] => {
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
  };
  const holdsNumber = (value: unknown): boolean =>
    textsOf(value).some((text) => text.includes(NUMBER.slice(1)));

  /** The error `statement` is refused with. */
  const refusalOf = async (statement: Promise<unknown>): Promise<Error> => {
    try {
      await statement;
    } catch (error) {
      if (error instanceof Error) {
        return error;
      }
    }
    throw new Error("the statement was not refused with an error");
  };

  /** What `run` gives on a client whose socket fails with `raw`: postgres.js rejects its first statement with it. */
  const outcomeOn = async (
    raw: Error,
    run: (sql: Sql) => Promise<unknown>,
  ): Promise<{ answer: unknown } | { thrown: unknown }> => {
    const options = { max: 1, onnotice: () => undefined, socket: () => Promise.reject(raw) };
    const sql = postgres("postgres://t1322@db-t1322.example.invalid:65123/t1322", options);
    try {
      return { answer: await run(sql) };
    } catch (error) {
      return { thrown: error };
    } finally {
      await sql.end({ timeout: 0 });
    }
  };

  beforeAll(async () => {
    const sql = postgres(resolvePrimaryUrl(), { max: 1, onnotice: () => undefined });
    try {
      await sql`create temp table t1322_numbers (number text constraint t1322_numbers_short check (length(number) < 5))`;
      made = {
        refusal: await refusalOf(sql`select ${NUMBER}::uuid as id`),
        rule: await refusalOf(sql`insert into t1322_numbers (number) values (${NUMBER})`),
        undefinedValue: await refusalOf(
          sql`select ${NUMBER}::text as number, ${undefined as never}::text as gone`,
        ),
        serialization: await refusalOf(
          sql.unsafe(
            "do $$ begin raise exception using errcode = '40001', message = 'could not serialize'; end $$",
          ),
        ),
        serialize: await refusalOf(sql`select ${sql.typed(Number(NUMBER.slice(1)), 17)} as bytes`),
      };
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it.each(CASES)("$name", async ({ call, run, kind, expected }) => {
    const raw = made[kind];
    const outcome = await outcomeOn(raw, run);
    if ("answer" in expected) {
      expect(outcome).toEqual({ answer: expected.answer });
      return;
    }
    // The error holds the number, so the check means something; postgres.js put the statement on it.
    expect(holdsNumber(raw)).toBe(true);
    expect(Object.hasOwn(raw, "args")).toBe(true);
    if (!("thrown" in outcome)) {
      throw new Error(`${call} answered`);
    }
    // Booleans first, so a failing run prints neither error's text.
    const { thrown } = outcome;
    expect(thrown === raw).toBe(false);
    expect(holdsNumber(thrown)).toBe(false);
    if ("database" in expected) {
      const { code, table, constraint, shown } = expected.database;
      expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
      expect(Object.getOwnPropertyNames(thrown).sort()).toEqual([
        "call",
        "code",
        "constraint",
        "message",
        "name",
        "stack",
        "table",
      ]);
      expect(thrown).toMatchObject({
        call,
        code,
        table,
        constraint,
        message: `${call}: the database refused the call (SQLSTATE ${shown})`,
      });
      return;
    }
    expect(Object.getOwnPropertyNames(thrown).sort()).toEqual(["call", "code", "message", "stack"]);
    expect(thrown).toMatchObject({
      call,
      code: expected.client,
      message: `${call}: the database call failed (code ${expected.client})`,
    });
  });
});

// ---- T-1334: inBusinessTransaction reserves through reserveConnection (T-1314's handoff, Gives 3) ----------------------
//
// extend's transaction start reserves its connection through bundles.ts's reserveConnection, so a reserve() that never
// connects leaves as the code 08001 alone, which extend answers transient, never as postgres.js raises it. Raised for real
// through postgres.js's own socket option on the client reserve() opens its connection on, while the pre-probe answers
// on this file's Tool API client: the Workers build's failure, with no code and no statement (cf/polyfills.js;
// connection.js queryError), the made-up connection string in its message; and Node's ECONNREFUSED on a closed port.
// Rule 9: the probe's user, password, database, host and port are made up here (a .invalid name). A check names what
// leaked, never its value.

describe("extend: a reserve() that never connects answers 08001, never as postgres.js raises it (T-1334)", () => {
  const PROBE_USER = "t1334_probe_user";
  const PROBE_PASSWORD = "t1334-probe-password";
  const PROBE_DATABASE = "t1334_probe_db";
  const HOST = "db-t1334.example.invalid";
  const PORT = 65134;
  const NEVER_OPENED = { error: "transient", sqlstate: "08001" };
  const REQUEST: ExtendRequest = {
    reservationId: "rsv-t1334",
    businessId: LEES,
    expectVersion: 1,
    door: "standard",
    at: "2026-11-09T15:00:00Z",
  };

  type Secrets = Readonly<Record<string, RegExp>>;
  type Settled = { answer: unknown } | { thrown: unknown };

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

  const SHAPE_SECRETS = secretsOf({
    host: HOST,
    port: PORT,
    user: PROBE_USER,
    password: PROBE_PASSWORD,
    database: PROBE_DATABASE,
  });

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

  async function settledOf(run: () => Promise<unknown>): Promise<Settled> {
    try {
      return { answer: await run() };
    } catch (error) {
      return { thrown: error };
    }
  }

  /**
   * `statements` with `reserving`'s reserve(): the pre-probe answers on `statements`, and only reserve() opens a
   * connection, as when the probe's connection was taken meanwhile and the one reserve() opens never connects.
   */
  function reserveFrom(statements: Sql, reserving: Sql): Sql {
    return new Proxy(statements, {
      get: (target, key, receiver): unknown =>
        key === "reserve" ? () => reserving.reserve() : (Reflect.get(target, key, receiver) as unknown),
    });
  }

  it("as the Workers build passes it up (no code, no statement), the made-up connection string in it: 08001, holding none of it", async () => {
    const raw = new Error(`Network connection lost: ${probeUrl(HOST, PORT)}`);
    // A client on the made-up connection whose socket fails with `raw` before it opens (postgres.js's own socket option).
    const options = { max: 1, onnotice: () => undefined, socket: () => Promise.reject(raw) };
    const reserving = postgres(probeUrl(HOST, PORT), options);
    let outcome: Settled;
    try {
      outcome = await settledOf(() => extend(reserveFrom(toolApi, reserving), REQUEST));
    } finally {
      await reserving.end({ timeout: 0 });
    }
    expect(outcome).toEqual({ answer: NEVER_OPENED });
    expect(leaksOf(outcome, SHAPE_SECRETS)).toEqual([]);
    // postgres.js passed the socket's error up as it is: no code, no statement, the made-up connection in its message.
    expect((raw as { code?: unknown }).code).toBeUndefined();
    expect(Object.hasOwn(raw, "query") || Object.hasOwn(raw, "parameters")).toBe(false);
    expect(leaksOf(raw, SHAPE_SECRETS)).toEqual(
      expect.arrayContaining(["host", "port", "user", "password", "database"]),
    );
    // extend's own answer to a failure (clocks.ts transientOrScrubbed) would throw it as it is: only reserveConnection
    // makes it a connection that never opened.
    let direct: Settled;
    try {
      direct = { answer: transientOrScrubbed("extend", raw) };
    } catch (error) {
      direct = { thrown: error };
    }
    expect("thrown" in direct && direct.thrown === raw).toBe(true);
  });

  it("for real on a closed port (Node's ECONNREFUSED, on no statement): 08001, holding none of it", async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    server.close();
    await once(server, "close");
    const reserving = postgres(probeUrl("127.0.0.1", port), { max: 1, onnotice: () => undefined });
    let outcome: Settled;
    try {
      outcome = await settledOf(() => extend(reserveFrom(toolApi, reserving), REQUEST));
    } finally {
      await reserving.end({ timeout: 0 });
    }
    expect(outcome).toEqual({ answer: NEVER_OPENED });
    expect(
      leaksOf(
        outcome,
        secretsOf({ port, user: PROBE_USER, password: PROBE_PASSWORD, database: PROBE_DATABASE }),
      ),
    ).toEqual([]);
  });
});

// ---- T-1350: inBusinessTransaction decides its rollback and its release by targets.ts's foundGone (T-1334's handoff a)
//
// extend runs inBusinessTransaction, which decides as inRuntimeTransaction does (T-1334, DL-649): a connection fn found
// gone (a lost connection, or a statement's failure that is a session's failure or that transientOrThrow answers 08001)
// is sent no rollback and is never released. A rosie_job client of this file's schema (one connection; the runtime
// side's role holds the grants on reservations and clock_rows extend uses, behind the business's scope) has its socket
// cut the 8 ways T-1334 cut inRuntimeTransaction's, under extend of Alex's saved time with Avery at a version it never
// had, which writes nothing: as fn's first statement is written, which is then never written; and (T-1330's note d) at
// the first turn of the event loop after fn's first statement is answered, the connection idle in its transaction, by
// which time fn's next statement is already in flight, so postgres.js rejects it with the socket's error, or with its own
// CONNECTION_CLOSED. The socket is destroyed with an error built in the shape Node, OpenSSL or postgres.js gives it, or
// with none. A probe cut the same way shows each raw error holds what it names and the value of the statement it
// rejected, so the checks mean something; each outcome holds none of it, nor any value fn's statements carried; nothing
// is sent after the cut, no rollback and no commit; nothing is thrown outside a promise; a statement sent on the same
// client at once is answered on a new connection, so the dead connection was never released to the pool; and extend
// then answers on the same client. An error fn makes itself, on no statement (the request's `at`, which fn reads after
// its first statement and which then throws in the shape of Node's EACCES, an address and a port on it), found no
// connection gone, whatever its code: it is rolled back, and the connection is released.
//
// Rule 9: the probe's user, password, database, host, address and value are made up here (a .invalid name, RFC 5737's
// documentation address). A check names what leaked, never its value.

describe("T-1350: inBusinessTransaction writes no rollback to a connection fn found gone, and never releases it (targets.ts foundGone)", () => {
  const PROBE_USER = "t1350_probe_user";
  const PROBE_PASSWORD = "t1350-probe-password";
  const PROBE_DATABASE = "t1350_probe_db";
  const HOST = "db-t1350.example.invalid";
  const ADDRESS = "203.0.113.50";
  const PORT = 65150;
  /** The runtime side's role (T-191). */
  const RUNTIME_ROLE = "rosie_job";
  const NEVER_OPENED = { error: "transient", sqlstate: "08001" };
  const LOST = { error: "transient", sqlstate: "08006" };
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
    const destroy = (socket: Socket): void => {
      builtAtCut = sent.length;
      socket.destroy(cut?.raw ?? undefined);
    };
    const options = {
      max: 1,
      onnotice: () => undefined,
      connection: {
        application_name: "rosie-t1350-reservation-rules-cut",
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
        const socket = createConnection(url.port === "" ? 5432 : Number(url.port), url.hostname);
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

  // Alex's saved time with Avery at a version it never had: fn reads the row's slot, its clock row, the slot's locks and
  // the row, then answers versionChanged, writing nothing, so every cut and every answer after it finds the seed as it is.
  const EXTEND = extendRequest({ expectVersion: 7 });
  const VERSION_CHANGED = {
    error: "versionChanged",
    changed: [{ table: "reservations", rowId: ALEX_AVERY, readVersion: 7, currentVersion: 1 }],
  };

  beforeAll(async () => {
    await freshSeed();
  });

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

  /** extend on a client cut as the shape and `when` say: see the top of this block. */
  async function expectCut(shape: (typeof CUTS)[number], when: Cut["when"]): Promise<void> {
    await expectProbeHolds(shape.raw(), shape.holds);
    const raw = shape.raw();
    const client = cutClient({ on: fnsFirst, when, raw });
    try {
      const watchedRun = await watched(async () => {
        const called = await outcomeOf(() => extend(client.sql, EXTEND));
        const builtBefore = client.sent.length;
        // At once: a statement that a dead connection released to the pool would take and never answer (postgres.js
        // 3.4.9 queues its write on that connection, and the close then drops it). Not released, it waits for the pool
        // to reconnect.
        const followed = await outcomeOf(async () => [...(await client.sql<{ n: number }[]>`select 2 as n`)]);
        return { called, builtBefore, followed };
      });
      expect(watchedRun.outcome).not.toBe("never settled");
      expect(watchedRun.uncaught).toEqual([]);
      const { called, builtBefore, followed } = (
        watchedRun.outcome as { answer: { called: Outcome; builtBefore: number; followed: Outcome } }
      ).answer;
      // The statement in flight at the cut: fn's first (write), or fn's second, already built when the connection, idle
      // after fn's first was answered, closed (answered). It is the last one built: no rollback, no commit.
      const first = client.sent.lastIndexOf(SCOPE) + 1;
      const inFlight = when === "write" ? first : first + 1;
      expect(client.builtAtCut()).toBe(inFlight + 1);
      expect(builtBefore).toBe(inFlight + 1);
      // Neither the connection's details nor any value fn's statements carried leaves.
      const carried = valueSecrets(client.values.slice(first, inFlight + 1));
      expect(Object.keys(carried).length).toBeGreaterThan(0);
      expect(leaksOf(called, { ...cutSecrets(), ...carried })).toEqual([]);
      expectOutcome(called, shape.expected, "extend");
      if (raw !== null) {
        // postgres.js rejected the statement in flight with the raw error, that statement and its values put on it.
        expect(Object.hasOwn(raw, "query")).toBe(true);
        const inFlightValues = valueSecrets(client.values.slice(inFlight, inFlight + 1));
        expect(leaksOf(raw, inFlightValues)).toEqual(Object.keys(inFlightValues));
      }
      // The dead connection was never released: the next statement waited for a new one, which answered it.
      expect(followed).toEqual({ answer: [{ n: 2 }] });
      // And extend itself answers on the same client.
      const again = await watched(() => extend(client.sql, EXTEND));
      expect(again.uncaught).toEqual([]);
      expect(again.outcome).toEqual({ answer: VERSION_CHANGED });
    } finally {
      await client.sql.end({ timeout: 0 });
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
    // fn (extendIn) reads the request's `at` for the row's own read, after its first statements have been built, and
    // that read throws.
    const fnStarted = (): boolean => {
      const scope = client.sent.lastIndexOf(SCOPE);
      return scope !== -1 && scope < client.sent.length - 1;
    };
    const asked: ExtendRequest = {
      ...EXTEND,
      get at(): string {
        if (fnStarted()) {
          throw own;
        }
        return EXTEND.at;
      },
    };
    try {
      const [before] = await client.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const { outcome, uncaught } = await watched(() => extend(client.sql, asked));
      expect(uncaught).toEqual([]);
      // Rolled back: the rollback is the last statement built, after fn's own.
      expect(client.sent.at(-1)).toBe("rollback");
      expect(client.sent.length - client.sent.lastIndexOf(SCOPE)).toBeGreaterThan(2);
      // extend answers it as clocks.ts's transientOrScrubbed does: a session's failure, thrown scrubbed.
      expect(leaksOf(outcome, cutSecrets())).toEqual([]);
      expectOutcome(outcome, { code: "EACCES" }, "extend");
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
});
