// The reservations service (T-744; C-100, C-134) on a fake clock, against the K-05 v1 item 6 double (test-support.ts),
// which first answers each of K-05's item 6 fixtures as the contract does. The database's own guard (EXCLUDE, the cap's
// locks) under 200 parallel saves is reservations.int.test.ts, on local PostgreSQL.
//
// The people and tokens are the contracts' sample cast: fictional 555-01xx mobiles (K-04 seed-phone-chat-open.json) and
// made-up agent tokens (rule 9).

import { describe, expect, it } from "vitest";

import type { ExtendRequest, ReleaseRequest, ReserveRequest } from "../../../../db/repo/reservation-rules";
import { ReservationRequestError } from "./doors";
import { createReservations } from "./service";
import { accessExchange, fireDue, ReservationsDouble, serviceOn, type AccessExchange } from "./test-support";
import type { Asker, DoorFacts, LapseOutcome, SaveRequest } from "./types";

/** K-04's reservation seed: Lee's Barbershop (Riley, Avery), the yoga studio (Maya) and the movers, with their phones. */
const SEEDS = ["seed-reservation.json"] as const;

const LEES = "biz-lees-barbershop";
const YOGA = "biz-yoga-studio";
const ALEX = "+15555550101";
const TOMAS = "+15555550105";
const SAM = "+15555550100";
const TOKEN_A = "agent-token-t744-a";
const TOKEN_B = "agent-token-t744-b";

/** Saturday Nov 21, 10:00 to 10:30am in New York, with Riley: free in the seed. */
const SAT_RILEY = { start: "2026-11-21T15:00:00Z", end: "2026-11-21T15:30:00Z" };
const SAT_AVERY = { start: "2026-11-21T16:00:00Z", end: "2026-11-21T16:30:00Z" };
const SUN_RILEY = { start: "2026-11-22T15:00:00Z", end: "2026-11-22T15:30:00Z" };

const AT = "2026-11-12T09:50:00Z";
const STANDARD: DoorFacts = { booksAtOnce: false, moneyBefore: false, longer: null };
const C3: DoorFacts = { booksAtOnce: true, moneyBefore: true, longer: null };

const turn = (mobile: string | null): Asker => ({ kind: "turn", mobile });
const page = (mobile: string | null): Asker => ({ kind: "page", mobile });
const agent = (agentToken: string): Asker => ({ kind: "agent", agentToken });

function saveRequest(over: Partial<SaveRequest> & { reservationId: string; asker: Asker }): SaveRequest {
  return {
    businessId: LEES,
    resourceId: "res-riley",
    during: SAT_RILEY,
    seats: 1,
    door: STANDARD,
    nextInLine: false,
    ...over,
  };
}

/** Every value an answer must never carry: the cast's mobiles and the tests' tokens (K-08; the lead's note on T-744). */
const PRIVATE = ["+1555555", "agent-token"];

function expectNothingPrivate(answer: unknown): void {
  const text = JSON.stringify(answer);
  for (const value of PRIVATE) expect(text).not.toContain(value);
}

const at = (time: string): string => `2026-11-12T${time}Z`;

// ---- the double is the contract's ----------------------------------------------------------------------------------

describe("the K-05 double answers K-05 v1 item 6's fixtures as the contract does", () => {
  const FIXTURES = [
    "reserve-10-min.json",
    "reserve-ai-door-15-min.json",
    "reserve-next-in-line.json",
    "reserve-overlap-refused.json",
    "reserve-third-refused.json",
    "release-expired-promotes.json",
    "extend-once.json",
    "extend-ai-door-refused.json",
  ];

  async function callDouble(double: ReservationsDouble, exchange: AccessExchange): Promise<unknown> {
    switch (exchange.call) {
      case "reserve":
        return double.data.reserve(exchange.request as ReserveRequest);
      case "release":
        return double.data.release(exchange.request as ReleaseRequest);
      case "extend":
        return double.data.extend(exchange.request as ExtendRequest);
    }
  }

  for (const file of FIXTURES) {
    it(file, async () => {
      const exchange = accessExchange(file);
      const double = new ReservationsDouble(exchange.given.k04Seeds);
      for (const before of exchange.given.after) {
        const earlier = accessExchange(before);
        expect(await callDouble(double, earlier), before).toEqual(earlier.outcome);
      }
      expect(await callDouble(double, exchange)).toEqual(exchange.outcome);
    });
  }
});

// ---- a saved time lets go at its end ---------------------------------------------------------------------------------

describe("a saved time lets go at its end and the first in line is promoted once (S12-01, S12-02; A4-18)", () => {
  it("held from 9:50 to 10:00; at 10:00 its clock row lets it go and the first in line is held until 10:10, once", async () => {
    const { double, clock, service } = serviceOn(SEEDS, AT);

    const saved = await service.save(saveRequest({ reservationId: "rsv-alex-sat", asker: turn(ALEX) }));
    expect(saved).toEqual({
      result: "saved",
      reservationId: "rsv-alex-sat",
      version: 1,
      heldUntil: at("10:00:00"),
      door: "standard",
      minutes: 10,
      extendable: true,
      savedTimeClockId: "rsv-alex-sat/saved-time",
      lapsesBy: "holdersHandle",
      repeated: false,
    });
    // Its clock row, armed at its end on the mobile's own handle (K-05 item 8).
    expect(double.clockRow("rsv-alex-sat/saved-time")).toMatchObject({
      state: "armed",
      dueAt: at("10:00:00"),
      dueZone: "America/New_York",
      handleId: "handle-alex",
      fires: { release: "rsv-alex-sat", why: "expired" },
    });

    clock.set(at("09:52:00"));
    const tomas = await service.save(
      saveRequest({ reservationId: "rsv-tomas-sat", asker: page(TOMAS), nextInLine: true }),
    );
    expect(tomas).toEqual({
      result: "nextInLine",
      reservationId: "rsv-tomas-sat",
      version: 1,
      queuedAt: at("09:52:00"),
      repeated: false,
    });
    clock.set(at("09:53:00"));
    const second = await service.save(
      saveRequest({ reservationId: "rsv-agent-sat", asker: agent(TOKEN_A), nextInLine: true }),
    );
    expect(second).toMatchObject({ result: "nextInLine", queuedAt: at("09:53:00") });
    expectNothingPrivate([saved, tomas, second]);

    // A second before its end: nothing is due, and the time is still saved.
    clock.set(at("09:59:59"));
    expect(await fireDue(double, clock, service)).toEqual([]);
    expect(double.stored("rsv-alex-sat")).toMatchObject({ state: "held", heldUntil: at("10:00:00") });

    clock.set(at("10:00:00"));
    const lapsed = await fireDue(double, clock, service);
    expect(lapsed).toEqual([
      {
        result: "letGo",
        reservationId: "rsv-alex-sat",
        releasedAt: at("10:00:00"),
        why: "expired",
        heldFor: "phoneNumber",
        promoted: {
          reservationId: "rsv-tomas-sat",
          version: 2,
          heldUntil: at("10:10:00"),
          heldFor: "phoneNumber",
          savedTimeClockId: "rsv-tomas-sat/saved-time",
        },
        repeated: false,
      },
    ]);
    expectNothingPrivate(lapsed);
    // Nothing is booked when a saved time runs out (S12-04: "Nothing is booked or charged").
    expect(double.stored("rsv-alex-sat")).toMatchObject({
      state: "released",
      releasedWhy: "expired",
      releasedAt: at("10:00:00"),
      bookingId: null,
    });
    expect(double.clockRow("rsv-alex-sat/saved-time")).toMatchObject({ state: "fired" });
    // The first in line has the time at once, with its own clock row (S12-02: "it's saved for Dee at once").
    expect(double.clockRow("rsv-tomas-sat/saved-time")).toMatchObject({
      state: "armed",
      dueAt: at("10:10:00"),
      handleId: "handle-tomas",
    });

    // The alarm and the sweep fire again: the row is fired, and a lapse run again promotes nobody else.
    expect(await fireDue(double, clock, service)).toEqual([]);
    const again = await Promise.all([
      service.lapse({ reservationId: "rsv-alex-sat", businessId: LEES }),
      service.lapse({ reservationId: "rsv-alex-sat", businessId: LEES }),
    ]);
    for (const outcome of again) {
      expect(outcome).toEqual({
        result: "letGo",
        reservationId: "rsv-alex-sat",
        releasedAt: at("10:00:00"),
        why: "expired",
        heldFor: "phoneNumber",
        promoted: null,
        repeated: true,
      });
    }
    expect(double.onSlot("res-riley", SAT_RILEY).map((row) => [row.id, row.state])).toEqual([
      ["rsv-agent-sat", "waiting"],
      ["rsv-alex-sat", "released"],
      ["rsv-tomas-sat", "held"],
    ]);

    // The promoted time lets go at its own end, and the line moves on by one.
    clock.set(at("10:10:00"));
    expect(await fireDue(double, clock, service)).toEqual([
      {
        result: "letGo",
        reservationId: "rsv-tomas-sat",
        releasedAt: at("10:10:00"),
        why: "expired",
        heldFor: "phoneNumber",
        promoted: {
          reservationId: "rsv-agent-sat",
          version: 2,
          heldUntil: at("10:20:00"),
          heldFor: "agentToken",
          savedTimeClockId: "rsv-agent-sat/saved-time",
        },
        repeated: false,
      },
    ]);
    expect(double.clockRow("rsv-agent-sat/saved-time")).toMatchObject({
      state: "armed",
      dueAt: at("10:20:00"),
      handleId: null,
    });
  });

  it("twenty firings of one saved time's end at once promote the first in line exactly once", async () => {
    const { double, clock, service } = serviceOn(SEEDS, AT);
    await service.save(saveRequest({ reservationId: "rsv-alex-sat", asker: turn(ALEX) }));
    for (const [i, mobile] of [TOMAS, SAM].entries()) {
      clock.set(at(`09:5${String(i + 1)}:00`));
      await service.save(
        saveRequest({ reservationId: `rsv-line-${String(i)}`, asker: page(mobile), nextInLine: true }),
      );
    }
    clock.set(at("10:00:00"));
    const firings = await Promise.all(
      Array.from({ length: 20 }, () => service.lapse({ reservationId: "rsv-alex-sat", businessId: LEES })),
    );
    const promoted = firings.filter(
      (outcome): outcome is Extract<LapseOutcome, { result: "letGo" }> =>
        "result" in outcome && outcome.result === "letGo" && outcome.promoted !== null,
    );
    expect(promoted.map((outcome) => outcome.promoted?.reservationId)).toEqual(["rsv-line-0"]);
    expect(firings.filter((outcome) => "result" in outcome && outcome.result === "letGo")).toHaveLength(20);
    expect(double.stored("rsv-line-0")).toMatchObject({
      state: "held",
      heldUntil: at("10:10:00"),
      version: 2,
    });
    expect(double.stored("rsv-line-1")).toMatchObject({ state: "waiting", version: 1 });
  });

  it("a quiet AI's saved time keeps running and is let go at its end by the sweep; nothing is booked (S12-03)", async () => {
    const { double, clock, service } = serviceOn(SEEDS, AT);
    const saved = await service.save(saveRequest({ reservationId: "rsv-quiet-ai", asker: agent(TOKEN_A) }));
    expect(saved).toMatchObject({
      result: "saved",
      door: "standard",
      heldUntil: at("10:00:00"),
      extendable: false,
      lapsesBy: "sweep",
    });
    expect(double.clockRow("rsv-quiet-ai/saved-time")).toMatchObject({
      handleId: null,
      dueAt: at("10:00:00"),
    });
    clock.set(at("09:59:00"));
    expect(await fireDue(double, clock, service)).toEqual([]);
    clock.set(at("10:00:30"));
    expect(await fireDue(double, clock, service)).toEqual([
      {
        result: "letGo",
        reservationId: "rsv-quiet-ai",
        releasedAt: at("10:00:30"),
        why: "expired",
        heldFor: "agentToken",
        promoted: null,
        repeated: false,
      },
    ]);
    expect(double.stored("rsv-quiet-ai")).toMatchObject({ state: "released", bookingId: null });
  });

  it("a lapse finds nothing to let go for a time booked or still in line, and waits for one not ended", async () => {
    const { double, clock, service } = serviceOn(SEEDS, AT);
    await service.save(saveRequest({ reservationId: "rsv-alex-sat", asker: turn(ALEX) }));
    await service.save(saveRequest({ reservationId: "rsv-tomas-sat", asker: turn(TOMAS), nextInLine: true }));
    expect(await service.lapse({ reservationId: "rsv-alex-sat", businessId: LEES })).toEqual({
      result: "notYet",
      reservationId: "rsv-alex-sat",
      heldUntil: at("10:00:00"),
    });
    expect(await service.lapse({ reservationId: "rsv-tomas-sat", businessId: LEES })).toEqual({
      result: "notSaved",
      reservationId: "rsv-tomas-sat",
      state: "waiting",
    });
    double.confirm("rsv-alex-sat", "booking-alex-sat");
    clock.set(at("10:00:00"));
    expect(await fireDue(double, clock, service)).toEqual([]);
    expect(await service.lapse({ reservationId: "rsv-alex-sat", businessId: LEES })).toEqual({
      result: "notSaved",
      reservationId: "rsv-alex-sat",
      state: "booked",
    });
    // Another business's time is not this business's to let go.
    expect(await service.lapse({ reservationId: "rsv-alex-sat", businessId: YOGA })).toEqual({
      error: "notFound",
      reservationId: "rsv-alex-sat",
    });
  });
});

// ---- C3's door --------------------------------------------------------------------------------------------------------

describe("C3's door saves 15 minutes and every extend is refused (MC C3; C-250)", () => {
  it("the customer's own AI booking a service that books at once, with money before: ownAi, 15 minutes", async () => {
    const { double, service } = serviceOn(SEEDS, AT);
    const saved = await service.save(
      saveRequest({ reservationId: "rsv-c3", asker: agent(TOKEN_A), door: C3 }),
    );
    expect(saved).toEqual({
      result: "saved",
      reservationId: "rsv-c3",
      version: 1,
      heldUntil: at("10:05:00"),
      door: "ownAi",
      minutes: 15,
      extendable: false,
      savedTimeClockId: "rsv-c3/saved-time",
      lapsesBy: "sweep",
      repeated: false,
    });
    expect(double.stored("rsv-c3")).toMatchObject({ forAgentToken: TOKEN_A, forPhoneNumber: null });
  });

  it("every extend is refused, whoever asks and whenever, and the saved time does not move", async () => {
    const { double, clock, service } = serviceOn(SEEDS, AT);
    await service.save(saveRequest({ reservationId: "rsv-c3", asker: agent(TOKEN_A), door: C3 }));
    for (const time of ["09:50:00", "09:51:00", "09:58:00", "10:04:59"]) {
      clock.set(at(time));
      for (const asker of [agent(TOKEN_A), agent(TOKEN_B), turn(ALEX), page(ALEX)]) {
        const answer = await service.extendTime({
          reservationId: "rsv-c3",
          businessId: LEES,
          expectVersion: 1,
          asker,
        });
        expect(answer, `${time} ${asker.kind}`).toEqual({
          error: "notExtendable",
          reservationId: "rsv-c3",
          heldFor: "agentToken",
        });
        expectNothingPrivate(answer);
      }
    }
    expect(double.stored("rsv-c3")).toMatchObject({
      state: "held",
      heldUntil: at("10:05:00"),
      extended: false,
      version: 1,
    });
    expect(double.clockRow("rsv-c3/saved-time")).toMatchObject({ dueAt: at("10:05:00"), version: 1 });
    // The data layer refuses the door too, whatever door its caller names (K-05 neverExtended; DL-173 ruling 3).
    for (const door of ["ownAi", "standard"] as const) {
      expect(
        await double.data.extend({
          reservationId: "rsv-c3",
          businessId: LEES,
          expectVersion: 1,
          door,
          at: at("10:04:59"),
        }),
      ).toEqual({ error: "neverExtended", reservationId: "rsv-c3", door: "ownAi" });
    }
  });

  it("the longer saves never apply to C3's door, and it is let go at 15 minutes with nothing booked", async () => {
    const { double, clock, service } = serviceOn(SEEDS, AT);
    const saved = await service.save(
      saveRequest({
        reservationId: "rsv-c3-longer",
        asker: agent(TOKEN_A),
        door: { ...C3, longer: { door: "planCheck", minutes: 60 } },
      }),
    );
    expect(saved).toMatchObject({ door: "ownAi", minutes: 15, heldUntil: at("10:05:00") });
    clock.set(at("10:05:00"));
    expect(await fireDue(double, clock, service)).toMatchObject([
      { result: "letGo", reservationId: "rsv-c3-longer", why: "expired", promoted: null },
    ]);
    expect(double.stored("rsv-c3-longer")).toMatchObject({ state: "released", bookingId: null });
  });

  it("only the customer's own AI takes C3's door: a turn's or a page's save, or an AI's that does not book at once, is standard", async () => {
    const { service } = serviceOn(SEEDS, AT);
    const cases: [string, Asker, DoorFacts][] = [
      ["rsv-turn-money", turn(ALEX), C3],
      ["rsv-page-money", page(TOMAS), C3],
      ["rsv-ai-owner-ok", agent(TOKEN_A), { booksAtOnce: false, moneyBefore: true, longer: null }],
      ["rsv-ai-no-money", agent(TOKEN_B), { booksAtOnce: true, moneyBefore: false, longer: null }],
    ];
    for (const [i, [reservationId, asker, door]] of cases.entries()) {
      const saved = await service.save(
        saveRequest({
          reservationId,
          asker,
          door,
          during: { start: `2026-11-2${String(i)}T15:00:00Z`, end: `2026-11-2${String(i)}T15:30:00Z` },
        }),
      );
      expect(saved, reservationId).toMatchObject({
        result: "saved",
        door: "standard",
        minutes: 10,
        heldUntil: at("10:00:00"),
        extendable: asker.kind !== "agent",
      });
    }
  });
});

// ---- the one extension ----------------------------------------------------------------------------------------------

describe("other doors extend 10 minutes once, then refuse (Q-12; arch 05 line 247)", () => {
  const DOORS: [string, DoorFacts, number][] = [
    ["standard", STANDARD, 10],
    ["planCheck", { ...STANDARD, longer: { door: "planCheck", minutes: 60 } }, 60],
    ["document", { ...STANDARD, longer: { door: "document", minutes: 1440 } }, 1440],
    ["ownerOk", { ...STANDARD, longer: { door: "ownerOk", minutes: 30 } }, 30],
  ];

  for (const [door, facts, minutes] of DOORS) {
    it(`${door}: ${String(minutes)} minutes, then 10 more once, then refused`, async () => {
      const { double, clock, service } = serviceOn(SEEDS, AT);
      const id = `rsv-${door}`;
      const end = new Date(Date.parse(AT) + minutes * 60_000).toISOString().replace(".000Z", "Z");
      const later = new Date(Date.parse(end) + 10 * 60_000).toISOString().replace(".000Z", "Z");
      expect(
        await service.save(
          saveRequest({ reservationId: id, asker: page(ALEX), door: facts, during: SUN_RILEY }),
        ),
      ).toMatchObject({ result: "saved", door, minutes, heldUntil: end, extendable: true });

      clock.set(at("09:58:00"));
      const extended = await service.extendTime({
        reservationId: id,
        businessId: LEES,
        expectVersion: 1,
        asker: page(ALEX),
      });
      expect(extended).toEqual({
        result: "extended",
        reservationId: id,
        version: 2,
        heldUntil: later,
        extendable: false,
      });
      // Its clock row moves with it (K-05 item 10; Q-12).
      expect(double.clockRow(`${id}/saved-time`)).toMatchObject({ state: "armed", dueAt: later });

      for (const expectVersion of [2, 1]) {
        expect(
          await service.extendTime({ reservationId: id, businessId: LEES, expectVersion, asker: turn(ALEX) }),
        ).toEqual({ error: "alreadyExtended", reservationId: id, heldUntil: later });
      }
      expect(double.stored(id)).toMatchObject({ heldUntil: later, extended: true, version: 2 });
    });
  }

  it("a saved time past its end is not extended (notHeld), and nothing moves", async () => {
    const { double, clock, service } = serviceOn(SEEDS, AT);
    await service.save(saveRequest({ reservationId: "rsv-alex-sat", asker: turn(ALEX) }));
    clock.set(at("10:00:00"));
    expect(
      await service.extendTime({
        reservationId: "rsv-alex-sat",
        businessId: LEES,
        expectVersion: 1,
        asker: turn(ALEX),
      }),
    ).toEqual({ error: "notHeld", reservationId: "rsv-alex-sat", state: "held" });
    expect(double.stored("rsv-alex-sat")).toMatchObject({ heldUntil: at("10:00:00"), extended: false });
  });

  it("the extension is the holder's own: another mobile, an AI or another business asks as for a time that does not exist", async () => {
    const { double, service } = serviceOn(SEEDS, AT);
    await service.save(saveRequest({ reservationId: "rsv-alex-sat", asker: turn(ALEX) }));
    const notFound = { error: "notFound", table: "reservations", rowId: "rsv-alex-sat" };
    for (const [businessId, asker] of [
      [LEES, turn(TOMAS)],
      [LEES, page(null)],
      [LEES, agent(TOKEN_A)],
      [YOGA, turn(ALEX)],
    ] as const) {
      expect(
        await service.extendTime({ reservationId: "rsv-alex-sat", businessId, expectVersion: 1, asker }),
      ).toEqual(notFound);
    }
    expect(double.stored("rsv-alex-sat")).toMatchObject({ extended: false, version: 1 });
  });

  it("an AI's standard save and a booking's hold are not extendable (DL-171; K-09 v1.2 notExtendable)", async () => {
    const { double, service } = serviceOn(SEEDS, AT);
    const ai = await service.save(saveRequest({ reservationId: "rsv-ai-sat", asker: agent(TOKEN_A) }));
    expect(ai).toMatchObject({ door: "standard", extendable: false });
    expect(
      await service.extendTime({
        reservationId: "rsv-ai-sat",
        businessId: LEES,
        expectVersion: 1,
        asker: agent(TOKEN_A),
      }),
    ).toEqual({ error: "notExtendable", reservationId: "rsv-ai-sat", heldFor: "agentToken" });
    // The business's own BOOK holds a time for its booking (K-09 v1.1 openRequest at door business).
    await double.data.reserve({
      reservationId: "rsv-booking-hold",
      businessId: LEES,
      resourceId: "res-avery",
      during: SAT_AVERY,
      seats: 1,
      for: { bookingId: "booking-lees-walk-in" },
      door: "standard",
      holdMinutes: null,
      waitIfSaved: false,
      at: AT,
    });
    expect(
      await service.extendTime({
        reservationId: "rsv-booking-hold",
        businessId: LEES,
        expectVersion: 1,
        asker: page(ALEX),
      }),
    ).toEqual({ error: "notExtendable", reservationId: "rsv-booking-hold", heldFor: "booking" });
  });

  it("a repeated save answers its first save, and says the extension is used once it is", async () => {
    const { clock, service } = serviceOn(SEEDS, AT);
    const request = saveRequest({ reservationId: "rsv-alex-sat", asker: turn(ALEX) });
    await service.save(request);
    clock.set(at("09:55:00"));
    expect(await service.save(request)).toMatchObject({
      result: "saved",
      heldUntil: at("10:00:00"),
      extendable: true,
      repeated: true,
    });
    await service.extendTime({
      reservationId: "rsv-alex-sat",
      businessId: LEES,
      expectVersion: 1,
      asker: turn(ALEX),
    });
    expect(await service.save(request)).toMatchObject({
      result: "saved",
      version: 2,
      heldUntil: at("10:10:00"),
      extendable: false,
      repeated: true,
    });
    // The same id for another request is another request's (K-05 idConflict).
    expect(await service.save({ ...request, during: SUN_RILEY })).toEqual({
      error: "idConflict",
      reservationId: "rsv-alex-sat",
    });
  });
});

// ---- the cap of 2 ------------------------------------------------------------------------------------------------------

describe("a third saved time for one mobile at one business is refused with both end times (arch 05 line 247)", () => {
  it("names only when the mobile's own two saved times end, and holds nothing", async () => {
    const { double, clock, service } = serviceOn(SEEDS, AT);
    await service.save(saveRequest({ reservationId: "rsv-alex-1", asker: turn(ALEX) }));
    clock.set(at("09:52:00"));
    await service.save(
      saveRequest({
        reservationId: "rsv-alex-2",
        asker: page(ALEX),
        resourceId: "res-avery",
        during: SAT_AVERY,
      }),
    );
    clock.set(at("09:55:00"));
    for (const nextInLine of [false, true]) {
      const third = await service.save(
        saveRequest({ reservationId: "rsv-alex-3", asker: turn(ALEX), during: SUN_RILEY, nextInLine }),
      );
      expect(third).toEqual({ error: "savedTimeCap", endsAt: [at("10:00:00"), at("10:02:00")] });
      expectNothingPrivate(third);
      expect(JSON.stringify(third)).not.toContain("rsv-");
      expect(JSON.stringify(third)).not.toContain("biz-");
    }
    expect(double.stored("rsv-alex-3")).toBeUndefined();

    // Once one of the two has run out, a new one can be saved: the cap counts the saved times still running.
    clock.set(at("10:00:00"));
    await fireDue(double, clock, service);
    expect(
      await service.save(saveRequest({ reservationId: "rsv-alex-3", asker: turn(ALEX), during: SUN_RILEY })),
    ).toMatchObject({ result: "saved", heldUntil: at("10:10:00") });
  });

  it("counts the mobile at every business, so a third at another business is refused too", async () => {
    const { clock, service } = serviceOn(SEEDS, AT);
    await service.save(saveRequest({ reservationId: "rsv-alex-1", asker: turn(ALEX) }));
    clock.set(at("09:51:00"));
    await service.save(saveRequest({ reservationId: "rsv-alex-2", asker: turn(ALEX), during: SUN_RILEY }));
    expect(
      await service.save(
        saveRequest({
          reservationId: "rsv-alex-yoga",
          asker: page(ALEX),
          businessId: YOGA,
          resourceId: "res-maya",
          during: SAT_RILEY,
        }),
      ),
    ).toEqual({ error: "savedTimeCap", endsAt: [at("10:00:00"), at("10:01:00")] });
  });

  it("a time in line never counts: two saved and one in line is not a third", async () => {
    const { service } = serviceOn(SEEDS, AT);
    await service.save(saveRequest({ reservationId: "rsv-tomas-1", asker: turn(TOMAS) }));
    expect(
      await service.save(
        saveRequest({ reservationId: "rsv-alex-line", asker: turn(ALEX), nextInLine: true }),
      ),
    ).toMatchObject({ result: "nextInLine" });
    await service.save(saveRequest({ reservationId: "rsv-alex-1", asker: turn(ALEX), during: SUN_RILEY }));
    expect(
      await service.save(
        saveRequest({
          reservationId: "rsv-alex-2",
          asker: turn(ALEX),
          resourceId: "res-avery",
          during: SAT_AVERY,
        }),
      ),
    ).toMatchObject({ result: "saved" });
  });
});

describe("a third saved time for one agent token at one business is refused with both end times", () => {
  it("names only when the token's own two saved times end; the same token still saves at another business", async () => {
    const { double, clock, service } = serviceOn(SEEDS, AT);
    await service.save(saveRequest({ reservationId: "rsv-token-1", asker: agent(TOKEN_A) }));
    clock.set(at("09:53:00"));
    await service.save(
      saveRequest({
        reservationId: "rsv-token-2",
        asker: agent(TOKEN_A),
        door: C3,
        resourceId: "res-avery",
        during: SAT_AVERY,
      }),
    );
    clock.set(at("09:54:00"));
    const third = await service.save(
      saveRequest({ reservationId: "rsv-token-3", asker: agent(TOKEN_A), during: SUN_RILEY }),
    );
    expect(third).toEqual({ error: "savedTimeCap", endsAt: [at("10:00:00"), at("10:08:00")] });
    expectNothingPrivate(third);
    expect(double.stored("rsv-token-3")).toBeUndefined();

    // 2 per agent token per business: at the yoga studio the same token saves a time.
    expect(
      await service.save(
        saveRequest({
          reservationId: "rsv-token-yoga",
          asker: agent(TOKEN_A),
          businessId: YOGA,
          resourceId: "res-maya",
        }),
      ),
    ).toMatchObject({ result: "saved", heldUntil: at("10:04:00") });
    // Another token at the same business is not this one.
    expect(
      await service.save(
        saveRequest({ reservationId: "rsv-other-token", asker: agent(TOKEN_B), during: SUN_RILEY }),
      ),
    ).toMatchObject({ result: "saved" });
  });
});

// ---- concurrency -------------------------------------------------------------------------------------------------------

describe("two agent tokens saving one time at once: exactly one gets it, the other next in line (S12-01, S12-02)", () => {
  const AIS = [
    { token: TOKEN_A, reservationId: "rsv-ai-a" },
    { token: TOKEN_B, reservationId: "rsv-ai-b" },
  ] as const;

  const ORDERS: [string, readonly { token: string; reservationId: string }[]][] = [
    ["rsv-ai-a first", [AIS[0], AIS[1]]],
    ["rsv-ai-b first", [AIS[1], AIS[0]]],
  ];

  for (const [first, order] of ORDERS) {
    it(`asked to wait (${first}): one saved, one next in line, held at once when the first runs out`, async () => {
      const { double, clock, service } = serviceOn(SEEDS, AT);
      const answers = await Promise.all(
        order.map(({ token, reservationId }) =>
          service.save(saveRequest({ reservationId, asker: agent(token), nextInLine: true })),
        ),
      );
      const kinds = answers.map((answer) => ("result" in answer ? answer.result : answer.error));
      expect([...kinds].sort()).toEqual(["nextInLine", "saved"]);
      expectNothingPrivate(answers);
      const held = double.onSlot("res-riley", SAT_RILEY).filter((row) => row.state === "held");
      expect(held.map((row) => row.id)).toHaveLength(1);
      const waiting = double.onSlot("res-riley", SAT_RILEY).filter((row) => row.state === "waiting");
      expect(waiting.map((row) => row.id)).toHaveLength(1);

      // S12-02: "If Ben's saved time runs out, it's saved for Dee at once."
      clock.set(at("10:00:00"));
      expect(await fireDue(double, clock, service)).toMatchObject([
        {
          result: "letGo",
          reservationId: held[0]?.id,
          promoted: { reservationId: waiting[0]?.id, heldFor: "agentToken", heldUntil: at("10:10:00") },
        },
      ]);
    });
  }

  it("not asked to wait: one saved, the other hears at once it was just taken, and never who", async () => {
    const { double, service } = serviceOn(SEEDS, AT);
    const answers = await Promise.all(
      AIS.map(({ token, reservationId }) =>
        service.save(saveRequest({ reservationId, asker: agent(token) })),
      ),
    );
    expect(answers.filter((answer) => "result" in answer && answer.result === "saved")).toHaveLength(1);
    expect(answers.filter((answer) => "error" in answer)).toEqual([{ error: "timeTaken" }]);
    expect(double.onSlot("res-riley", SAT_RILEY)).toHaveLength(1);
  });

  it("a booked time is taken even for one asked to wait (S12-02: 'If Ben confirms, Gemini hears it's gone')", async () => {
    const { double, service } = serviceOn(SEEDS, AT);
    await service.save(saveRequest({ reservationId: "rsv-ben", asker: agent(TOKEN_A) }));
    double.confirm("rsv-ben", "booking-ben-sat");
    expect(
      await service.save(saveRequest({ reservationId: "rsv-dee", asker: agent(TOKEN_B), nextInLine: true })),
    ).toEqual({ error: "timeTaken" });
    expect(double.stored("rsv-dee")).toBeUndefined();
  });
});

// ---- one row per holder per slot (T-1134; round 1 GAP 1; DL-292, DL-294) ---------------------------------------------

describe("one row per holder per slot: the reviewer's C3 scenario (T-1134 rules (1) and (2); MC C3)", () => {
  it("TOKEN_A's later saves of its own C3 slot get rsv-1 back and write nothing; at 10:05 the first other holder is promoted", async () => {
    const { double, clock, service } = serviceOn(SEEDS, AT);
    expect(
      await service.save(saveRequest({ reservationId: "rsv-1", asker: agent(TOKEN_A), door: C3 })),
    ).toMatchObject({
      result: "saved",
      reservationId: "rsv-1",
      heldUntil: at("10:05:00"),
      door: "ownAi",
      minutes: 15,
      extendable: false,
      repeated: false,
    });

    // Its later saves of the same slot, asked to wait, at once: rsv-1 back, never a place in line behind itself.
    clock.set(at("09:51:00"));
    const again = await Promise.all(
      ["rsv-2", "rsv-3", "rsv-4"].map((reservationId) =>
        service.save(saveRequest({ reservationId, asker: agent(TOKEN_A), door: C3, nextInLine: true })),
      ),
    );
    for (const answer of again) {
      expect(answer).toEqual({
        result: "saved",
        reservationId: "rsv-1",
        version: 1,
        heldUntil: at("10:05:00"),
        door: "ownAi",
        minutes: 15,
        extendable: false,
        savedTimeClockId: "rsv-1/saved-time",
        lapsesBy: "sweep",
        repeated: true,
      });
    }
    expect(double.onSlot("res-riley", SAT_RILEY).map((row) => [row.id, row.state])).toEqual([
      ["rsv-1", "held"],
    ]);

    // Another holder waits next in line (A4-18); TOKEN_A asking again still gets rsv-1, never a row behind it.
    clock.set(at("09:52:00"));
    expect(
      await service.save(
        saveRequest({ reservationId: "rsv-b", asker: agent(TOKEN_B), door: C3, nextInLine: true }),
      ),
    ).toEqual({
      result: "nextInLine",
      reservationId: "rsv-b",
      version: 1,
      queuedAt: at("09:52:00"),
      repeated: false,
    });
    clock.set(at("09:53:00"));
    expect(
      await service.save(
        saveRequest({ reservationId: "rsv-5", asker: agent(TOKEN_A), door: C3, nextInLine: true }),
      ),
    ).toMatchObject({ result: "saved", reservationId: "rsv-1", heldUntil: at("10:05:00"), repeated: true });
    for (const id of ["rsv-2", "rsv-3", "rsv-4", "rsv-5"]) expect(double.stored(id)).toBeUndefined();

    // The 15 minutes are never extended: at 10:05 rsv-1 is let go and the first other holder is held 10 minutes.
    clock.set(at("10:04:59"));
    expect(await fireDue(double, clock, service)).toEqual([]);
    clock.set(at("10:05:00"));
    const lapsed = await fireDue(double, clock, service);
    expect(lapsed).toEqual([
      {
        result: "letGo",
        reservationId: "rsv-1",
        releasedAt: at("10:05:00"),
        why: "expired",
        heldFor: "agentToken",
        promoted: {
          reservationId: "rsv-b",
          version: 2,
          heldUntil: at("10:15:00"),
          heldFor: "agentToken",
          savedTimeClockId: "rsv-b/saved-time",
        },
        repeated: false,
      },
    ]);
    expectNothingPrivate(lapsed);
    expect(
      double.onSlot("res-riley", SAT_RILEY).map((row) => [row.id, row.state, row.forAgentToken]),
    ).toEqual([
      ["rsv-1", "released", TOKEN_A],
      ["rsv-b", "held", TOKEN_B],
    ]);
  });

  it("with no other holder in line, at 10:05 the let-go promotes nobody and the slot opens again", async () => {
    const { double, clock, service } = serviceOn(SEEDS, AT);
    await service.save(saveRequest({ reservationId: "rsv-1", asker: agent(TOKEN_A), door: C3 }));
    clock.set(at("09:51:00"));
    expect(
      await service.save(
        saveRequest({ reservationId: "rsv-2", asker: agent(TOKEN_A), door: C3, nextInLine: true }),
      ),
    ).toMatchObject({ result: "saved", reservationId: "rsv-1", heldUntil: at("10:05:00"), repeated: true });
    clock.set(at("10:05:00"));
    expect(await fireDue(double, clock, service)).toEqual([
      {
        result: "letGo",
        reservationId: "rsv-1",
        releasedAt: at("10:05:00"),
        why: "expired",
        heldFor: "agentToken",
        promoted: null,
        repeated: false,
      },
    ]);
    expect(double.onSlot("res-riley", SAT_RILEY).map((row) => [row.id, row.state])).toEqual([
      ["rsv-1", "released"],
    ]);
    expect(
      await service.save(saveRequest({ reservationId: "rsv-b", asker: agent(TOKEN_B), door: C3 })),
    ).toMatchObject({ result: "saved", reservationId: "rsv-b", heldUntil: at("10:20:00") });
  });

  it("a held row whose end has passed, its lapse not fired yet, is never shown as a live hold and never extended", async () => {
    const { double, clock, service } = serviceOn(SEEDS, AT);
    await service.save(saveRequest({ reservationId: "rsv-1", asker: agent(TOKEN_A), door: C3 }));
    await service.save(saveRequest({ reservationId: "rsv-alex-sun", asker: turn(ALEX), during: SUN_RILEY }));
    // Past both ends (10:05 and 10:00), and nothing has fired yet (a late sweep; on the database, T-1084).
    clock.set(at("10:06:00"));
    const asks = [
      saveRequest({ reservationId: "rsv-2", asker: agent(TOKEN_A), door: C3, nextInLine: true }),
      saveRequest({ reservationId: "rsv-1", asker: agent(TOKEN_A), door: C3 }),
      saveRequest({ reservationId: "rsv-alex-2", asker: page(ALEX), during: SUN_RILEY, nextInLine: true }),
      saveRequest({ reservationId: "rsv-alex-sun", asker: turn(ALEX), during: SUN_RILEY }),
    ];
    for (const request of asks) {
      expect(await service.save(request), request.reservationId).toEqual({ error: "timeTaken" });
    }
    expect(double.stored("rsv-2")).toBeUndefined();
    expect(double.stored("rsv-alex-2")).toBeUndefined();
    expect(
      await service.extendTime({
        reservationId: "rsv-1",
        businessId: LEES,
        expectVersion: 1,
        asker: agent(TOKEN_A),
      }),
    ).toEqual({ error: "notExtendable", reservationId: "rsv-1", heldFor: "agentToken" });
    expect(
      await service.extendTime({
        reservationId: "rsv-alex-sun",
        businessId: LEES,
        expectVersion: 1,
        asker: turn(ALEX),
      }),
    ).toEqual({ error: "notHeld", reservationId: "rsv-alex-sun", state: "held" });
    expect(double.stored("rsv-1")).toMatchObject({ heldUntil: at("10:05:00"), extended: false, version: 1 });
    expect(double.stored("rsv-alex-sun")).toMatchObject({
      heldUntil: at("10:00:00"),
      extended: false,
      version: 1,
    });
    // The late firing lets both go, and promotes nobody.
    expect(await fireDue(double, clock, service)).toMatchObject([
      { result: "letGo", reservationId: "rsv-alex-sun", promoted: null },
      { result: "letGo", reservationId: "rsv-1", promoted: null },
    ]);
  });

  it("a mobile after its one extension gets its own row back, not a place in line; its let-go promotes another holder", async () => {
    const { double, clock, service } = serviceOn(SEEDS, AT);
    await service.save(saveRequest({ reservationId: "rsv-alex-1", asker: turn(ALEX) }));
    clock.set(at("09:58:00"));
    expect(
      await service.extendTime({
        reservationId: "rsv-alex-1",
        businessId: LEES,
        expectVersion: 1,
        asker: turn(ALEX),
      }),
    ).toMatchObject({ result: "extended", heldUntil: at("10:10:00") });
    clock.set(at("09:59:00"));
    expect(
      await service.save(saveRequest({ reservationId: "rsv-alex-2", asker: page(ALEX), nextInLine: true })),
    ).toEqual({
      result: "saved",
      reservationId: "rsv-alex-1",
      version: 2,
      heldUntil: at("10:10:00"),
      door: "standard",
      minutes: 10,
      extendable: false,
      savedTimeClockId: "rsv-alex-1/saved-time",
      lapsesBy: "holdersHandle",
      repeated: true,
    });
    expect(double.stored("rsv-alex-2")).toBeUndefined();
    clock.set(at("10:00:00"));
    expect(
      await service.save(saveRequest({ reservationId: "rsv-tomas", asker: page(TOMAS), nextInLine: true })),
    ).toMatchObject({ result: "nextInLine", reservationId: "rsv-tomas" });
    clock.set(at("10:10:00"));
    expect(await fireDue(double, clock, service)).toMatchObject([
      {
        result: "letGo",
        reservationId: "rsv-alex-1",
        heldFor: "phoneNumber",
        promoted: { reservationId: "rsv-tomas", heldUntil: at("10:20:00"), heldFor: "phoneNumber" },
      },
    ]);
  });

  it("a let-go never promotes the released holder's own waiting row: it is let go with it, and the next holder is held", async () => {
    const { double, clock, service } = serviceOn(SEEDS, AT);
    await service.save(saveRequest({ reservationId: "rsv-b", asker: agent(TOKEN_B) }));
    clock.set(at("09:51:00"));
    expect(
      await service.save(
        saveRequest({ reservationId: "rsv-alex-wait", asker: turn(ALEX), nextInLine: true }),
      ),
    ).toMatchObject({ result: "nextInLine", reservationId: "rsv-alex-wait" });
    // Alex's two saved times elsewhere make the cap pass over its place in line when rsv-b ends at 10:00.
    clock.set(at("09:52:00"));
    await service.save(saveRequest({ reservationId: "rsv-alex-sun", asker: turn(ALEX), during: SUN_RILEY }));
    await service.save(
      saveRequest({
        reservationId: "rsv-alex-avery",
        asker: turn(ALEX),
        resourceId: "res-avery",
        during: SAT_AVERY,
      }),
    );
    clock.set(at("10:00:00"));
    expect(await fireDue(double, clock, service)).toMatchObject([
      { result: "letGo", reservationId: "rsv-b", promoted: null },
    ]);
    clock.set(at("10:02:00"));
    await fireDue(double, clock, service);
    // The slot is free with Alex's row still in line; Alex saves it outright, then Tomas waits behind it.
    clock.set(at("10:03:00"));
    expect(
      await service.save(saveRequest({ reservationId: "rsv-alex-again", asker: turn(ALEX) })),
    ).toMatchObject({ result: "saved", reservationId: "rsv-alex-again", heldUntil: at("10:13:00") });
    clock.set(at("10:04:00"));
    expect(
      await service.save(saveRequest({ reservationId: "rsv-tomas", asker: page(TOMAS), nextInLine: true })),
    ).toMatchObject({ result: "nextInLine", reservationId: "rsv-tomas" });

    clock.set(at("10:13:00"));
    expect(await fireDue(double, clock, service)).toEqual([
      {
        result: "letGo",
        reservationId: "rsv-alex-again",
        releasedAt: at("10:13:00"),
        why: "expired",
        heldFor: "phoneNumber",
        promoted: {
          reservationId: "rsv-tomas",
          version: 2,
          heldUntil: at("10:23:00"),
          heldFor: "phoneNumber",
          savedTimeClockId: "rsv-tomas/saved-time",
        },
        repeated: false,
      },
    ]);
    expect(double.stored("rsv-alex-wait")).toMatchObject({
      state: "released",
      releasedWhy: "let_go",
      releasedAt: at("10:13:00"),
      heldUntil: null,
      version: 2,
    });
  });
});

describe("C3's saves are token holds, never a booking's hold (T-1134 security note 2)", () => {
  it("every save on C3's door is held for the asking AI's own token, and no save is ever held for a booking", async () => {
    const askers = [agent(TOKEN_A), agent(TOKEN_B), turn(ALEX), page(TOMAS)];
    const facts: DoorFacts[] = [
      C3,
      { ...C3, longer: { door: "planCheck", minutes: 60 } },
      STANDARD,
      { booksAtOnce: true, moneyBefore: false, longer: null },
      { booksAtOnce: false, moneyBefore: true, longer: null },
    ];
    let ownAi = 0;
    for (const asker of askers) {
      for (const [i, door] of facts.entries()) {
        const { double, clock } = serviceOn(SEEDS, AT);
        const sent: ReserveRequest[] = [];
        const service = createReservations({
          data: {
            ...double.data,
            reserve: (request) => {
              sent.push(request);
              return double.data.reserve(request);
            },
          },
          now: clock.now,
        });
        const reservationId = `rsv-door-${String(i)}`;
        expect(await service.save(saveRequest({ reservationId, asker, door }))).toMatchObject({
          result: "saved",
        });
        expect(sent).toHaveLength(1);
        const [request] = sent;
        expect(request?.for, reservationId).not.toHaveProperty("bookingId");
        expect(double.stored(reservationId)).toMatchObject({ bookingId: null });
        if (request?.door !== "ownAi") continue;
        ownAi += 1;
        expect(asker.kind).toBe("agent");
        expect(request.for).toEqual({ agentToken: asker.kind === "agent" ? asker.agentToken : "" });
        expect(double.stored(reservationId)).toMatchObject({
          forAgentToken: asker.kind === "agent" ? asker.agentToken : "",
          forPhoneNumber: null,
          bookingId: null,
        });
      }
    }
    // Both AIs on both C3 facts took the ownAi door; nobody else did.
    expect(ownAi).toBe(4);
  });
});

// ---- the clock home, holders and requests ----------------------------------------------------------------------------------

describe("a saved time ends by the visit's start (the clock home, S13-35: 'No clock runs past the visit')", () => {
  it("a door of fixed minutes that would run past the visit holds nothing; ending at the start is allowed", async () => {
    const { double, service } = serviceOn(SEEDS, AT);
    const soon = { start: at("09:59:00"), end: at("10:29:00") };
    expect(
      await service.save(saveRequest({ reservationId: "rsv-soon", asker: turn(ALEX), during: soon })),
    ).toEqual({ error: "tooSoon", visitStartsAt: at("09:59:00") });
    expect(
      await service.save(
        saveRequest({ reservationId: "rsv-soon-c3", asker: agent(TOKEN_A), door: C3, during: soon }),
      ),
    ).toEqual({ error: "tooSoon", visitStartsAt: at("09:59:00") });
    expect(double.stored("rsv-soon")).toBeUndefined();
    expect(
      await service.save(
        saveRequest({
          reservationId: "rsv-at-start",
          asker: turn(ALEX),
          during: { start: at("10:00:00"), end: at("10:30:00") },
        }),
      ),
    ).toMatchObject({ result: "saved", heldUntil: at("10:00:00") });
  });

  it("a longer save is cut to end at the visit's start", async () => {
    const { service } = serviceOn(SEEDS, AT);
    expect(
      await service.save(
        saveRequest({
          reservationId: "rsv-plan-check",
          asker: page(ALEX),
          door: { ...STANDARD, longer: { door: "planCheck", minutes: 60 } },
          during: { start: at("10:20:00"), end: at("11:20:00") },
        }),
      ),
    ).toMatchObject({ result: "saved", door: "planCheck", minutes: 30, heldUntil: at("10:20:00") });
  });
});

describe("who a time is held for, and what a save refuses before anything is held", () => {
  it("a turn's or a page's booker with no mobile on file saves nothing (mobileRequired)", async () => {
    const { double, service } = serviceOn(SEEDS, AT);
    for (const asker of [turn(null), page(null)]) {
      expect(await service.save(saveRequest({ reservationId: "rsv-no-mobile", asker }))).toEqual({
        error: "mobileRequired",
      });
    }
    expect(double.stored("rsv-no-mobile")).toBeUndefined();
  });

  it("a turn's or a page's save is held for the mobile, an AI's for its token", async () => {
    const { double, service } = serviceOn(SEEDS, AT);
    await service.save(saveRequest({ reservationId: "rsv-mobile", asker: page(ALEX) }));
    await service.save(saveRequest({ reservationId: "rsv-token", asker: agent(TOKEN_A), during: SUN_RILEY }));
    expect(double.stored("rsv-mobile")).toMatchObject({ forPhoneNumber: ALEX, forAgentToken: null });
    expect(double.stored("rsv-token")).toMatchObject({ forPhoneNumber: null, forAgentToken: TOKEN_A });
  });

  it("a resource of another business is not bookable", async () => {
    const { service } = serviceOn(SEEDS, AT);
    expect(
      await service.save(
        saveRequest({ reservationId: "rsv-maya", asker: turn(ALEX), resourceId: "res-maya" }),
      ),
    ).toEqual({ error: "notBookable" });
  });

  it("a request it cannot carry out is refused before anything is read, naming the field, never a value", async () => {
    const { service } = serviceOn(SEEDS, AT);
    const bad: [string, SaveRequest][] = [
      ["reservationId", saveRequest({ reservationId: "", asker: turn(ALEX) })],
      [
        "during",
        saveRequest({
          reservationId: "rsv-x",
          asker: turn(ALEX),
          during: { start: SAT_RILEY.end, end: SAT_RILEY.start },
        }),
      ],
      [
        "during.start",
        saveRequest({
          reservationId: "rsv-x",
          asker: turn(ALEX),
          during: { start: "Sat 10am", end: SAT_RILEY.end },
        }),
      ],
      ["seats", saveRequest({ reservationId: "rsv-x", asker: turn(ALEX), seats: 0 })],
      ["asker.kind", saveRequest({ reservationId: "rsv-x", asker: { kind: "console" } as unknown as Asker })],
      ["asker.agentToken", saveRequest({ reservationId: "rsv-x", asker: agent("") })],
      [
        "door.booksAtOnce",
        saveRequest({
          reservationId: "rsv-x",
          asker: agent(TOKEN_A),
          door: { ...C3, booksAtOnce: "yes" } as unknown as DoorFacts,
        }),
      ],
      [
        "door.longer",
        saveRequest({
          reservationId: "rsv-x",
          asker: page(ALEX),
          door: { ...STANDARD, longer: { door: "sameDay", minutes: 30 } } as unknown as DoorFacts,
        }),
      ],
    ];
    for (const [field, request] of bad) {
      const refused = service.save(request);
      await expect(refused, field).rejects.toThrow(ReservationRequestError);
      await expect(refused, field).rejects.toThrow(field);
    }
    // Minutes a door does not allow are K-05's refusal (doorMinutes), before anything is held.
    await expect(
      service.save(
        saveRequest({
          reservationId: "rsv-x",
          asker: page(ALEX),
          door: { ...STANDARD, longer: { door: "document", minutes: 1441 } },
        }),
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      service.extendTime({ reservationId: "rsv-x", businessId: LEES, expectVersion: 0, asker: turn(ALEX) }),
    ).rejects.toThrow("expectVersion");
  });
});
