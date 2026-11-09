// T-744: the reservations service on local PostgreSQL (`npm run db:up`; `npm run test:integration --
// actions/src/domain/reservations`), through K-05 v1 item 6 as db/repo/reservation-rules.ts gives it (pg.ts
// reservationDataOn), run as the Tool API's role, rosie_app, so row-level security binds the calls as it binds the
// Worker. The schema is a fresh test schema, migrated and dropped by db/repo/test-db.ts; the K-04 seeds are loaded by
// the tables' owner, as db/repo's own integration tests load them. The clock is the test's (FakeClock): the service never
// reads the platform's.
//
// 200 parallel saves on one slot give one success: the database refuses every other (EXCLUDE), whatever the service
// does, and the service answers each refusal as timeTaken, or as next in line when asked.

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolvePrimaryUrl } from "../../../../db/repo/client";
import type { Sql } from "../../../../db/repo/scope";
import { createTestDatabase, type TestDatabase } from "../../../../db/repo/test-db";
import { reservationDataOn } from "./pg";
import { createReservations } from "./service";
import { coreSeedRows, FakeClock } from "./test-support";
import type { LapseOutcome, Reservations, SaveOutcome, SaveRequest } from "./types";

const TOOL_API_ROLE = "rosie_app";
const POOL = 20;
const PARALLEL = 200;
const HEAVY = { timeout: 120_000 };

const LEES = "biz-lees-barbershop";
const TOMAS = "+15555550105";
/** After the seed's own saved time for Alex ends (15:10), so no seed row counts toward a cap. */
const AT = "2026-11-07T16:00:00Z";

let db: TestDatabase;
let toolApi: Sql;

beforeAll(async () => {
  db = await createTestDatabase({ name: "reservations_service" });
  toolApi = postgres(resolvePrimaryUrl(), {
    max: POOL,
    onnotice: () => undefined,
    connection: {
      application_name: `rosie-t744-${db.schema}`,
      search_path: `${db.schema}, public`,
      role: TOOL_API_ROLE,
    },
  });
  const present = await db.sql<{ name: string }[]>`
    select table_name as name from information_schema.tables where table_schema = current_schema()
  `;
  const tables = new Set(present.map((row) => row.name));
  for (const row of coreSeedRows(["seed-reservation.json"])) {
    if (tables.has(row.table)) await db.sql`insert into ${db.sql(row.table)} ${db.sql(row.values)}`;
  }
}, 60_000);

afterAll(async () => {
  await toolApi.end({ timeout: 5 });
  await db.drop();
});

function serviceAt(at: string): { clock: FakeClock; service: Reservations } {
  const clock = new FakeClock(at);
  return { clock, service: createReservations({ data: reservationDataOn(toolApi), now: clock.now }) };
}

function agentSave(i: number, slot: SaveRequest["during"], nextInLine: boolean, prefix: string): SaveRequest {
  const n = String(i).padStart(3, "0");
  return {
    reservationId: `rsv-t744-${prefix}-${n}`,
    businessId: LEES,
    resourceId: "res-riley",
    during: slot,
    seats: 1,
    asker: { kind: "agent", agentToken: `agent-token-t744-${prefix}-${n}` },
    door: { booksAtOnce: false, moneyBefore: false, longer: null },
    nextInLine,
  };
}

const kindOf = (outcome: SaveOutcome): string => ("result" in outcome ? outcome.result : outcome.error);

function tally(outcomes: SaveOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) counts[kindOf(outcome)] = (counts[kindOf(outcome)] ?? 0) + 1;
  return counts;
}

/** The slot's rows as the tables' owner reads them, in id order. */
async function slotRows(slot: SaveRequest["during"]): Promise<{ id: string; state: string }[]> {
  return db.sql<{ id: string; state: string }[]>`
    select id, state from reservations
    where resource_id = 'res-riley'
      and during && tstzrange(${slot.start}::timestamptz, ${slot.end}::timestamptz, '[)')
    order by id collate "C"
  `;
}

describe("200 parallel saves on one slot give one success (EXCLUDE; S12-01)", () => {
  it("not asked to wait: one saved, 199 told the time was just taken, and one row held", HEAVY, async () => {
    const slot = { start: "2026-12-05T15:00:00Z", end: "2026-12-05T15:30:00Z" };
    const { service } = serviceAt(AT);
    const outcomes = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) => service.save(agentSave(i, slot, false, "taken"))),
    );
    expect(tally(outcomes)).toEqual({ saved: 1, timeTaken: PARALLEL - 1 });
    for (const outcome of outcomes) {
      if ("error" in outcome) expect(outcome).toEqual({ error: "timeTaken" });
    }
    const won = outcomes.find((outcome) => "result" in outcome && outcome.result === "saved");
    expect(won).toMatchObject({
      result: "saved",
      version: 1,
      heldUntil: "2026-11-07T16:10:00Z",
      door: "standard",
      extendable: false,
      lapsesBy: "sweep",
      repeated: false,
    });
    const rows = await slotRows(slot);
    expect(rows.map((row) => row.state)).toEqual(["held"]);
    expect(rows[0]?.id).toBe(won !== undefined && "reservationId" in won ? won.reservationId : "");
  });

  it(
    "asked to wait: one saved and 199 next in line; at its end, 20 firings at once promote the first in line once",
    HEAVY,
    async () => {
      const slot = { start: "2026-12-05T17:00:00Z", end: "2026-12-05T17:30:00Z" };
      const { clock, service } = serviceAt(AT);
      const outcomes = await Promise.all(
        Array.from({ length: PARALLEL }, (_, i) => service.save(agentSave(i, slot, true, "line"))),
      );
      expect(tally(outcomes)).toEqual({ saved: 1, nextInLine: PARALLEL - 1 });
      const rows = await slotRows(slot);
      const held = rows.filter((row) => row.state === "held");
      const waiting = rows.filter((row) => row.state === "waiting");
      expect(held).toHaveLength(1);
      expect(waiting).toHaveLength(PARALLEL - 1);

      // Every place in line is the same moment (the clock did not move), so the tie goes to the lower id (K-05 item 9).
      clock.set("2026-11-07T16:10:00Z");
      const firings = await Promise.all(
        Array.from({ length: 20 }, () =>
          service.lapse({ reservationId: held[0]?.id ?? "", businessId: LEES }),
        ),
      );
      const promoted = firings.flatMap((outcome: LapseOutcome) =>
        "result" in outcome && outcome.result === "letGo" && outcome.promoted !== null
          ? [outcome.promoted]
          : [],
      );
      expect(promoted).toEqual([
        {
          reservationId: waiting[0]?.id,
          version: 2,
          heldUntil: "2026-11-07T16:20:00Z",
          heldFor: "agentToken",
          savedTimeClockId: `${waiting[0]?.id ?? ""}/saved-time`,
        },
      ]);
      for (const outcome of firings) expect(outcome).toMatchObject({ result: "letGo", why: "expired" });
      const after = await slotRows(slot);
      expect(after.filter((row) => row.state === "held").map((row) => row.id)).toEqual([waiting[0]?.id]);
      expect(after.filter((row) => row.state === "released").map((row) => row.id)).toEqual([held[0]?.id]);
      expect(after.filter((row) => row.state === "waiting")).toHaveLength(PARALLEL - 2);
    },
  );
});

describe("one row per holder per slot on the database: the reviewer's C3 scenario (T-1134; round 1 GAP 1)", () => {
  const C3 = { booksAtOnce: true, moneyBefore: true, longer: null };
  const c3Save = (
    reservationId: string,
    agentToken: string,
    slot: SaveRequest["during"],
    nextInLine: boolean,
  ): SaveRequest => ({
    reservationId,
    businessId: LEES,
    resourceId: "res-riley",
    during: slot,
    seats: 1,
    asker: { kind: "agent", agentToken },
    door: C3,
    nextInLine,
  });

  async function countOf(ids: readonly string[]): Promise<number> {
    const [row] = await db.sql<{ count: number }[]>`
      select count(*)::int as count from reservations where id in ${db.sql(ids)}
    `;
    return row?.count ?? -1;
  }

  it("TOKEN_A's later saves of its own C3 slot get rsv-1 back and write nothing; at its end the first other holder is promoted", async () => {
    const slot = { start: "2026-12-10T15:00:00Z", end: "2026-12-10T15:30:00Z" };
    const tokenA = "agent-token-t744-c3-a";
    const { clock, service } = serviceAt(AT);
    expect(await service.save(c3Save("rsv-t744-c3-1", tokenA, slot, false))).toMatchObject({
      result: "saved",
      reservationId: "rsv-t744-c3-1",
      heldUntil: "2026-11-07T16:15:00Z",
      door: "ownAi",
      minutes: 15,
      extendable: false,
      repeated: false,
    });

    // Its later saves of the slot, asked to wait, at once: the slot's lock runs them one after the other.
    clock.set("2026-11-07T16:01:00Z");
    const again = await Promise.all(
      ["rsv-t744-c3-2", "rsv-t744-c3-3", "rsv-t744-c3-4"].map((id) =>
        service.save(c3Save(id, tokenA, slot, true)),
      ),
    );
    for (const answer of again) {
      expect(answer).toEqual({
        result: "saved",
        reservationId: "rsv-t744-c3-1",
        version: 1,
        heldUntil: "2026-11-07T16:15:00Z",
        door: "ownAi",
        minutes: 15,
        extendable: false,
        savedTimeClockId: "rsv-t744-c3-1/saved-time",
        lapsesBy: "sweep",
        repeated: true,
      });
    }
    expect(await countOf(["rsv-t744-c3-2", "rsv-t744-c3-3", "rsv-t744-c3-4"])).toBe(0);

    clock.set("2026-11-07T16:02:00Z");
    expect(await service.save(c3Save("rsv-t744-c3-b", "agent-token-t744-c3-b", slot, true))).toEqual({
      result: "nextInLine",
      reservationId: "rsv-t744-c3-b",
      version: 1,
      queuedAt: "2026-11-07T16:02:00Z",
      repeated: false,
    });

    // At its end, its lapse not fired yet: the past end is never a live hold, and nothing is written.
    clock.set("2026-11-07T16:15:00Z");
    expect(await service.save(c3Save("rsv-t744-c3-5", tokenA, slot, true))).toEqual({ error: "timeTaken" });
    expect(await countOf(["rsv-t744-c3-5"])).toBe(0);

    expect(await service.lapse({ reservationId: "rsv-t744-c3-1", businessId: LEES })).toEqual({
      result: "letGo",
      reservationId: "rsv-t744-c3-1",
      releasedAt: "2026-11-07T16:15:00Z",
      why: "expired",
      heldFor: "agentToken",
      promoted: {
        reservationId: "rsv-t744-c3-b",
        version: 2,
        heldUntil: "2026-11-07T16:25:00Z",
        heldFor: "agentToken",
        savedTimeClockId: "rsv-t744-c3-b/saved-time",
      },
      repeated: false,
    });
    expect(await slotRows(slot)).toEqual([
      { id: "rsv-t744-c3-1", state: "released" },
      { id: "rsv-t744-c3-b", state: "held" },
    ]);
  });

  it("with no other holder in line, at its end the let-go promotes nobody", async () => {
    const slot = { start: "2026-12-11T15:00:00Z", end: "2026-12-11T15:30:00Z" };
    const tokenA = "agent-token-t744-c3-alone";
    const { clock, service } = serviceAt(AT);
    await service.save(c3Save("rsv-t744-alone-1", tokenA, slot, false));
    clock.set("2026-11-07T16:01:00Z");
    expect(await service.save(c3Save("rsv-t744-alone-2", tokenA, slot, true))).toMatchObject({
      result: "saved",
      reservationId: "rsv-t744-alone-1",
      heldUntil: "2026-11-07T16:15:00Z",
      repeated: true,
    });
    clock.set("2026-11-07T16:15:00Z");
    expect(await service.lapse({ reservationId: "rsv-t744-alone-1", businessId: LEES })).toEqual({
      result: "letGo",
      reservationId: "rsv-t744-alone-1",
      releasedAt: "2026-11-07T16:15:00Z",
      why: "expired",
      heldFor: "agentToken",
      promoted: null,
      repeated: false,
    });
    expect(await slotRows(slot)).toEqual([{ id: "rsv-t744-alone-1", state: "released" }]);
  });
});

describe("on the database, as the Tool API's role", () => {
  it("two agent tokens saving one time at once: exactly one gets it, the other next in line (S12-02)", async () => {
    const slot = { start: "2026-12-06T15:00:00Z", end: "2026-12-06T15:30:00Z" };
    const { service } = serviceAt(AT);
    const outcomes = await Promise.all([0, 1].map((i) => service.save(agentSave(i, slot, true, "pair"))));
    expect(outcomes.map(kindOf).sort()).toEqual(["nextInLine", "saved"]);
    expect((await slotRows(slot)).map((row) => row.state).sort()).toEqual(["held", "waiting"]);
  });

  it("a third saved time for one mobile is refused with only its own two end times", async () => {
    const { clock, service } = serviceAt(AT);
    const mobileSave = (id: string, day: string): SaveRequest => ({
      reservationId: id,
      businessId: LEES,
      resourceId: "res-riley",
      during: { start: `2026-12-${day}T18:00:00Z`, end: `2026-12-${day}T18:30:00Z` },
      seats: 1,
      asker: { kind: "page", mobile: TOMAS },
      door: { booksAtOnce: false, moneyBefore: false, longer: null },
      nextInLine: false,
    });
    expect(await service.save(mobileSave("rsv-t744-tomas-1", "07"))).toMatchObject({
      result: "saved",
      heldUntil: "2026-11-07T16:10:00Z",
      lapsesBy: "holdersHandle",
      extendable: true,
    });
    clock.set("2026-11-07T16:03:00Z");
    await service.save(mobileSave("rsv-t744-tomas-2", "08"));
    clock.set("2026-11-07T16:05:00Z");
    const third = await service.save(mobileSave("rsv-t744-tomas-3", "09"));
    expect(third).toEqual({
      error: "savedTimeCap",
      endsAt: ["2026-11-07T16:10:00Z", "2026-11-07T16:13:00Z"],
    });
    const [written] = await db.sql<{ count: number }[]>`
      select count(*)::int as count from reservations where id = 'rsv-t744-tomas-3'
    `;
    expect(written?.count).toBe(0);
    // The one extension, then refused (Q-12), on the database.
    expect(
      await service.extendTime({
        reservationId: "rsv-t744-tomas-1",
        businessId: LEES,
        expectVersion: 1,
        asker: { kind: "page", mobile: TOMAS },
      }),
    ).toEqual({
      result: "extended",
      reservationId: "rsv-t744-tomas-1",
      version: 2,
      heldUntil: "2026-11-07T16:20:00Z",
      extendable: false,
    });
    expect(
      await service.extendTime({
        reservationId: "rsv-t744-tomas-1",
        businessId: LEES,
        expectVersion: 2,
        asker: { kind: "page", mobile: TOMAS },
      }),
    ).toEqual({
      error: "alreadyExtended",
      reservationId: "rsv-t744-tomas-1",
      heldUntil: "2026-11-07T16:20:00Z",
    });
  });
});
