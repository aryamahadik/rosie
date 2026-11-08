// T-304's proofs (the card's "Proves it with"), on the contracts' own fixtures and the master's own examples, with
// doubles standing in for limit 6's ports and for limits 1 to 5, never for limit 6:
//   - commit-limit-6-value-fails.json gives its outcome (and commit-limit-6-reread-first.json, before the re-read);
//   - 'tomorrow at 3' sent 23:30 New York for a Los Angeles flow B visit resolves in the visit's zone;
//   - across a DST change it keeps the wall time;
//   - a price the model gave without source words is refused;
//   - a photo value passes only with the owner's approved read-back.
// Also: every other K-09 gate fixture comes out as it states; video or phone visits take either side's zone; limit 6
// checks only parts that carry values; what it returns holds no person's words; the shipped limit sits in slot 6 and
// reads only through the call's database.

import { describe, expect, it } from "vitest";

import { stringsIn } from "../../tool-api/test-support";
import {
  LIMIT_ACTIONS,
  partResultOf,
  runGate,
  type GatePart,
  type GateRequest,
  type GatedPart,
  type GateVerdict,
} from "../framework";
import {
  DECIDED_GATE_FIXTURES,
  bareTwo,
  callContext,
  changePart,
  fixtureScript,
  gateExchange,
  gateRequest,
  modelFixture,
  twoRequests,
  type LimitCall,
} from "../framework/test-support";
import { LIMITS } from "../limits";
import {
  limit6,
  nothingChangedOutcome,
  oneQuestionOutcome,
  type FieldRef,
  type Limit6Outcome,
  type ValueFault,
  type ValuesDecision,
  type VisitRef,
} from "./index";
import {
  BARBERSHOP,
  CHICAGO,
  HAIRCUT_LINE,
  HOME_SERVICES,
  LOS_ANGELES,
  MONEY_CARD_SENT,
  NEW_YORK,
  PRICE_BOARD,
  afterReread,
  decidedIn,
  exchangeRequest,
  haircutMoveRequest,
  limitIn,
  moveRequest,
  partOf,
  photosOf,
  placesOf,
  priceBoardRequest,
  raisePriceRequest,
  registryWith,
  seedBusinessZones,
  turnOf,
  typed,
  visitKey,
  withoutLimit6,
  type World,
} from "./test-support";

const VALUE_FAILS = "commit-limit-6-value-fails.json";
const REREAD_FIRST = "commit-limit-6-reread-first.json";

/** Limit 6's decision on part `index` of `request`, in `world`. */
function decision(world: World, request: GateRequest, index = 0): Promise<ValuesDecision> {
  return limitIn(world).decide(partOf(request, index), turnOf(request));
}

/** The parts of a gated verdict; fails the test for a refused one. */
function gatedParts(verdict: GateVerdict): readonly GatedPart[] {
  if (verdict.verdict !== "gated") throw new Error(`refused: ${JSON.stringify(verdict.error)}`);
  return verdict.parts;
}

/** A K-09 exchange's committed outcome; fails the test for any other. */
function committedOf(file: string) {
  const { outcome } = gateExchange(file);
  if ("error" in outcome || outcome.result !== "committed") throw new Error(`${file} is not committed`);
  return outcome;
}

/** The failure with `outcome`, naming each field of `faults` once, in order, with its fault. */
function failed(outcome: Limit6Outcome, faults: readonly (readonly [string, ValueFault])[]): ValuesDecision {
  const [first, ...rest] = [...new Set(faults.map(([name]) => name))];
  if (first === undefined) throw new Error("a failure names a field");
  return {
    result: "fail",
    outcome,
    fields: [first, ...rest],
    faults: faults.map(([name, why]) => ({ field: name, why })),
  };
}

const at = (utc: string, zone: string) => ({ utc, zone });
const usd = (cents: number) => ({ cents, currency: "USD" });

describe("commit-limit-6-value-fails.json gives its outcome", () => {
  it("after decide's one re-read, Sam's 'Barbershop, plumbing' from 'barbering and some other stuff' fails limit 6 with one question; the part is as the fixture states", async () => {
    const exchange = gateExchange(VALUE_FAILS);
    const request = exchangeRequest(VALUE_FAILS);
    const limit = limitIn();
    const calls: LimitCall[] = [];
    const call = callContext(BARBERSHOP);
    const parts = gatedParts(
      await runGate(request, call, registryWith(limit, withoutLimit6(fixtureScript(exchange)), calls)),
    );
    const stated = committedOf(VALUE_FAILS).parts;
    expect(parts.map((part) => partResultOf(part))).toEqual(stated);
    expect(stated[0]?.stoppedBy).toEqual(oneQuestionOutcome());
    expect(calls).toEqual([1, 2, 3, 4, 5, 6].map((limitNumber) => ({ limit: limitNumber, part: 0 })));
    expect(call.span.limits).toEqual(stated[0]?.limits);
    expect(await limit.decide(partOf(request), turnOf(request))).toEqual(
      failed(oneQuestionOutcome(), [["kinds", "differs"]]),
    );
  });

  it("before the re-read the same turn is refused before any write, naming part 0's kinds (commit-limit-6-reread-first.json)", async () => {
    const exchange = gateExchange(REREAD_FIRST);
    const script = withoutLimit6(fixtureScript(exchange));
    const verdict = await runGate(
      exchangeRequest(REREAD_FIRST),
      callContext(BARBERSHOP),
      registryWith(limitIn(), script),
    );
    expect(verdict).toEqual({ verdict: "refused", error: exchange.outcome });
    expect(exchange.outcome).toEqual({ error: "valueFailsWords", parts: [{ part: 0, fields: ["kinds"] }] });
  });

  it("a value that still fails its words on a question asked again changes nothing (nothingChanged, refuse)", async () => {
    const request = exchangeRequest(VALUE_FAILS);
    for (const question of decidedIn(request).context.openQuestions) question.askCount = 2;
    expect(await decision({}, request)).toEqual(failed(nothingChangedOutcome(), [["kinds", "differs"]]));
    const script = withoutLimit6(fixtureScript(gateExchange(VALUE_FAILS)));
    const [part] = gatedParts(
      await runGate(request, callContext(BARBERSHOP), registryWith(limitIn(), script)),
    );
    expect(part?.stoppedBy).toEqual({ limit: 6, outcome: "refuse", action: "nothingChanged" });
  });

  it.each(DECIDED_GATE_FIXTURES)(
    "%s: with the real limit 6 in its slot, the gate answers as the fixture states",
    async (file) => {
      const exchange = gateExchange(file);
      const verdict = await runGate(
        exchangeRequest(file),
        callContext(BARBERSHOP),
        registryWith(limitIn(), withoutLimit6(fixtureScript(exchange))),
      );
      if ("error" in exchange.outcome) {
        expect(verdict).toEqual({ verdict: "refused", error: exchange.outcome });
        return;
      }
      const stated = committedOf(file).parts;
      expect(
        gatedParts(verdict).map((part, index) => partResultOf(part, stated[index]?.gives ?? [])),
      ).toEqual(stated);
    },
  );
});

describe("'tomorrow at 3' sent 23:30 New York for a Los Angeles flow B visit resolves in the visit's zone", () => {
  it("Alex's flow B visit, stored in Los Angeles: tomorrow at 3 there (3pm, 22:00 UTC; or 3am) passes", async () => {
    const zones: string[] = [];
    const world: World = { zones: seedBusinessZones(zones) };
    expect(await decision(world, moveRequest(at("2026-10-26T22:00:00Z", LOS_ANGELES)))).toEqual({
      result: "pass",
    });
    expect(await decision(world, moveRequest(at("2026-10-26T10:00:00Z", LOS_ANGELES)))).toEqual({
      result: "pass",
    });
    expect(zones).toEqual([]);
  });

  it("the same words read in New York, the text's own zone, or on UTC's calendar fail", async () => {
    expect(await decision({}, moveRequest(at("2026-10-26T19:00:00Z", NEW_YORK)))).toEqual(
      failed(oneQuestionOutcome(), [["time_saved", "wrongZone"]]),
    );
    expect(await decision({}, moveRequest(at("2026-10-26T19:00:00Z", LOS_ANGELES)))).toEqual(
      failed(oneQuestionOutcome(), [["time_saved", "differs"]]),
    );
    expect(await decision({}, moveRequest(at("2026-10-27T22:00:00Z", LOS_ANGELES)))).toEqual(
      failed(oneQuestionOutcome(), [["time_saved", "differs"]]),
    );
  });

  it("a new booking's visit address zone is the one stored with its point (CQ-08: the place port)", async () => {
    const asked: VisitRef[] = [];
    const zones: string[] = [];
    const places = placesOf(
      { [visitKey(HOME_SERVICES, null)]: { addressZone: LOS_ANGELES, remote: false, otherZone: null } },
      asked,
    );
    const request = moveRequest(at("2026-10-26T22:00:00Z", LOS_ANGELES), { bookingId: null });
    expect(await decision({ places, zones: seedBusinessZones(zones) }, request)).toEqual({ result: "pass" });
    expect(asked).toEqual([{ businessId: HOME_SERVICES, bookingId: null, flow: "B" }]);
    expect(zones).toEqual([]);
  });

  it("with no address zone stored yet, a flow B visit resolves in the business's zone (CQ-05's default)", async () => {
    const zones: string[] = [];
    const world: World = { zones: seedBusinessZones(zones) };
    expect(
      await decision(world, moveRequest(at("2026-10-26T22:00:00Z", LOS_ANGELES), { bookingId: null })),
    ).toEqual(failed(oneQuestionOutcome(), [["time_saved", "wrongZone"]]));
    expect(
      await decision(world, moveRequest(at("2026-10-26T19:00:00Z", NEW_YORK), { bookingId: null })),
    ).toEqual({
      result: "pass",
    });
    expect(zones).toEqual([HOME_SERVICES, HOME_SERVICES]);
  });

  it("at the gate: before the re-read a New York reading is refused naming time_saved; after it, one question", async () => {
    const wrong = moveRequest(at("2026-10-26T19:00:00Z", NEW_YORK));
    expect(await runGate(wrong, callContext(HOME_SERVICES), registryWith(limitIn()))).toEqual({
      verdict: "refused",
      error: { error: "valueFailsWords", parts: [{ part: 0, fields: ["time_saved"] }] },
    });
    const [part] = gatedParts(
      await runGate(afterReread(wrong), callContext(HOME_SERVICES), registryWith(limitIn())),
    );
    expect(part?.result).toBe("stopped");
    expect(part?.stoppedBy).toEqual(oneQuestionOutcome());
    const right = moveRequest(at("2026-10-26T22:00:00Z", LOS_ANGELES));
    const [passed] = gatedParts(await runGate(right, callContext(HOME_SERVICES), registryWith(limitIn())));
    expect(passed?.result).toBe("passed");
    expect(passed?.limits[5]).toEqual({ limit: 6, result: "pass", outcome: null });
  });
});

describe("across a DST change it keeps the wall time", () => {
  const words = "can you move me to tomorrow at 3pm";

  it("on Sat Oct 31, 'tomorrow at 3pm' is Sun Nov 1 at 3pm EST (20:00 UTC), never 24 hours on (19:00 UTC)", async () => {
    expect(
      await decision({}, haircutMoveRequest(at("2026-11-01T20:00:00Z", NEW_YORK), "tomorrow at 3pm", words)),
    ).toEqual({ result: "pass" });
    expect(
      await decision({}, haircutMoveRequest(at("2026-11-01T19:00:00Z", NEW_YORK), "tomorrow at 3pm", words)),
    ).toEqual(failed(oneQuestionOutcome(), [["time_saved", "differs"]]));
  });

  it("a new booking at the barbershop reads K-04's business head zone (America/New_York) and keeps the wall time too", async () => {
    const zones: string[] = [];
    const request = haircutMoveRequest(at("2026-11-01T20:00:00Z", NEW_YORK), "tomorrow at 3pm", words, {
      bookingId: null,
    });
    expect(await decision({ zones: seedBusinessZones(zones) }, request)).toEqual({ result: "pass" });
    expect(zones).toEqual([BARBERSHOP]);
  });

  it("an hour the change repeats (1:30am on Nov 1) is either instant; 'Sun Nov 1 at 11am' is EST", async () => {
    const early = "move me to tomorrow at 1:30am";
    for (const utc of ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]) {
      expect(await decision({}, haircutMoveRequest(at(utc, NEW_YORK), "tomorrow at 1:30am", early))).toEqual({
        result: "pass",
      });
    }
    const dated = "move me to Sun Nov 1 at 11am";
    expect(
      await decision(
        {},
        haircutMoveRequest(at("2026-11-01T16:00:00Z", NEW_YORK), "Sun Nov 1 at 11am", dated),
      ),
    ).toEqual({ result: "pass" });
  });

  it("Spanish: 'mañana a las 3 de la tarde' on Sat Oct 31 is Sun Nov 1 at 3pm EST", async () => {
    const spanish = "¿me puede cambiar a mañana a las 3 de la tarde?";
    const request = haircutMoveRequest(
      at("2026-11-01T20:00:00Z", NEW_YORK),
      "mañana a las 3 de la tarde",
      spanish,
      {
        language: "es",
      },
    );
    expect(await decision({}, request)).toEqual({ result: "pass" });
  });

  it("words two texts of the turn carry must re-parse as each one sent them (default 7)", async () => {
    const request = haircutMoveRequest(at("2026-11-01T20:00:00Z", NEW_YORK), "tomorrow at 3pm", words);
    expect(await decision({}, request)).toEqual({ result: "pass" });
    // The same words again on Sun Nov 1 at 9:00am EST: from that text, tomorrow is Mon Nov 2.
    decidedIn(request).context.texts.push(typed("evt-alex-0302", "tomorrow at 3pm", "2026-11-01T14:00:00Z"));
    expect(await decision({}, request)).toEqual(failed(oneQuestionOutcome(), [["time_saved", "differs"]]));
  });
});

describe("a price the model gave without source words is refused", () => {
  it("K-02's 'tile is $12 a foot': the price re-parses from '$12 a foot', and both parts pass limit 6", async () => {
    const parts = gatedParts(
      await runGate(gateRequest(twoRequests()), callContext(HOME_SERVICES), registryWith(limitIn())),
    );
    expect(parts.map((part) => [part.result, part.limits[5]?.result])).toEqual([
      ["passed", "pass"],
      ["passed", "pass"],
    ]);
  });

  /** K-02's two requests with the price cited from the words "tile": in Sam's text, but holding no amount. */
  function priceFromTile(reread: boolean) {
    const pair = changePart(twoRequests(), 1, (part) => {
      if (part.verb !== "choose") throw new Error("part 1 chooses");
      for (const each of part.fields) if (each.name === "price") each.words = "tile";
    });
    const request = gateRequest(pair);
    return reread ? afterReread(request) : request;
  }

  it("the same $12 cited from the words 'tile' is refused before any write, naming part 1's price", async () => {
    expect(await runGate(priceFromTile(false), callContext(HOME_SERVICES), registryWith(limitIn()))).toEqual({
      verdict: "refused",
      error: { error: "valueFailsWords", parts: [{ part: 1, fields: ["price"] }] },
    });
  });

  it("after the re-read it still fails: part 1 stops with one question and nothing is written for it; part 0 goes ahead", async () => {
    const parts = gatedParts(
      await runGate(priceFromTile(true), callContext(HOME_SERVICES), registryWith(limitIn())),
    );
    expect(parts.map((part) => partResultOf(part))).toEqual([
      expect.objectContaining({ part: 0, result: "committed" }),
      expect.objectContaining({ part: 1, result: "stopped", stoppedBy: oneQuestionOutcome(), gives: [] }),
    ]);
    expect(await decision({}, priceFromTile(true), 1)).toEqual(
      failed(oneQuestionOutcome(), [["price", "noValue"]]),
    );
  });

  it("S11-20's 'raise haircut to 40': $40 from '40' passes; from 'raise haircut' it is the model's own price", async () => {
    expect(await decision({}, raisePriceRequest(usd(4000), "40"))).toEqual({ result: "pass" });
    expect(await decision({}, raisePriceRequest(usd(4500), "40"))).toEqual(
      failed(oneQuestionOutcome(), [["price", "differs"]]),
    );
    expect(await decision({}, raisePriceRequest(usd(4000), "raise haircut"))).toEqual(
      failed(oneQuestionOutcome(), [["price", "noValue"]]),
    );
    expect(await decision({}, raisePriceRequest("40", "40"))).toEqual(
      failed(oneQuestionOutcome(), [["price", "typeMismatch"]]),
    );
    expect(
      await runGate(
        raisePriceRequest(usd(4000), "raise haircut"),
        callContext(BARBERSHOP),
        registryWith(limitIn()),
      ),
    ).toEqual({
      verdict: "refused",
      error: { error: "valueFailsWords", parts: [{ part: 0, fields: ["price"] }] },
    });
  });
});

describe("a photo value passes only with the owner's approved read-back", () => {
  const caption = "Here's my price board";
  const board = () => priceBoardRequest(usd(3500), caption, "price board");
  const readBack = (ownerSaidYes: boolean) => ({
    words: HAIRCUT_LINE,
    sentAt: MONEY_CARD_SENT,
    ownerSaidYes,
  });

  it("read from the photo with no read-back out yet: fails", async () => {
    const photos = photosOf({ price: { from: "photo", readBack: null } });
    expect(await decision({ photos }, board())).toEqual(
      failed(oneQuestionOutcome(), [["price", "photoNotReadBack"]]),
    );
  });

  it("read back on the money card, but not yet said yes to: fails", async () => {
    const photos = photosOf({ price: { from: "photo", readBack: readBack(false) } });
    expect(await decision({ photos }, board())).toEqual(
      failed(oneQuestionOutcome(), [["price", "photoNotApproved"]]),
    );
  });

  it("the owner's yes to S1-13's 'A) Haircut · $35': $35 passes, asked about the board's photo", async () => {
    const asked: FieldRef[] = [];
    const photos = photosOf({ price: { from: "photo", readBack: readBack(true) } }, asked);
    expect(await decision({ photos }, board())).toEqual({ result: "pass" });
    expect(asked).toEqual([{ part: 0, field: "price", attachmentIds: [PRICE_BOARD] }]);
  });

  it("a price other than the read-back's fails, even with the owner's yes", async () => {
    const photos = photosOf({ price: { from: "photo", readBack: readBack(true) } });
    expect(await decision({ photos }, priceBoardRequest(usd(4000), caption, "price board"))).toEqual(
      failed(oneQuestionOutcome(), [["price", "differs"]]),
    );
  });

  it("a caption that states the price is not the read-back: a photo value with none out still fails", async () => {
    const stated = priceBoardRequest(usd(3500), "Haircut $35 on my board", "Haircut $35");
    const photos = photosOf({ price: { from: "photo", readBack: null } });
    expect(await decision({ photos }, stated)).toEqual(
      failed(oneQuestionOutcome(), [["price", "photoNotReadBack"]]),
    );
    expect(await decision({}, stated)).toEqual({ result: "pass" });
  });

  it("with no photo reading yet (the shipped default), a price the caption does not state fails", async () => {
    expect(await decision({}, board())).toEqual(failed(oneQuestionOutcome(), [["price", "noValue"]]));
  });
});

describe("video or phone visits show both zones", () => {
  it("a remote session booked at the barbershop: a time in the business's zone or the customer's re-parses; a third zone fails", async () => {
    const places = placesOf({
      [visitKey(BARBERSHOP, null)]: { addressZone: null, remote: true, otherZone: LOS_ANGELES },
    });
    const words = "a video consult tomorrow at 3pm";
    const consult = (utc: string, zone: string) =>
      haircutMoveRequest(at(utc, zone), "tomorrow at 3pm", words, { bookingId: null });
    expect(await decision({ places }, consult("2026-11-01T20:00:00Z", NEW_YORK))).toEqual({ result: "pass" });
    expect(await decision({ places }, consult("2026-11-01T23:00:00Z", LOS_ANGELES))).toEqual({
      result: "pass",
    });
    expect(await decision({ places }, consult("2026-11-01T21:00:00Z", CHICAGO))).toEqual(
      failed(oneQuestionOutcome(), [["time_saved", "wrongZone"]]),
    );
    expect(await decision({}, consult("2026-11-01T23:00:00Z", LOS_ANGELES))).toEqual(
      failed(oneQuestionOutcome(), [["time_saved", "wrongZone"]]),
    );
  });
});

describe("limit 6 checks only parts that carry values", () => {
  it("a choose with no fields (K-02 decide-bare-2.json), a pass_on and a hand_off are not checked, and nothing is read", async () => {
    const zones: string[] = [];
    const asked: VisitRef[] = [];
    const world: World = { zones: seedBusinessZones(zones), places: placesOf({}, asked) };
    const bare = gateRequest(bareTwo());
    expect(await decision(world, bare)).toEqual({ result: "notChecked" });
    for (const file of ["decide-pass-on.json", "decide-hand-off.json"]) {
      const read = (modelFixture(file) as { parts: { part: GatePart["part"] }[] }).parts[0]?.part;
      if (read === undefined) throw new Error(`${file} has a part`);
      const part: GatePart = { index: 0, part: read, choice: null };
      expect(await limitIn(world).decide(part, turnOf(bare))).toEqual({ result: "notChecked" });
    }
    expect([zones, asked]).toEqual([[], []]);
  });

  it("a part with only text values reads no zone and asks no place", async () => {
    const zones: string[] = [];
    const asked: VisitRef[] = [];
    await decision(
      { zones: seedBusinessZones(zones), places: placesOf({}, asked) },
      exchangeRequest(VALUE_FAILS),
    );
    expect([zones, asked]).toEqual([[], []]);
  });

  it("a field no text carries fails, never passes", async () => {
    const request = raisePriceRequest(usd(4000), "40");
    const part = partOf(request);
    if (part.part.verb !== "choose") throw new Error("S11-20's part chooses");
    const changed: GatePart = {
      ...part,
      part: { ...part.part, fields: part.part.fields.map((each) => ({ ...each, words: "fifty" })) },
    };
    expect(await limitIn().decide(changed, turnOf(request))).toEqual(
      failed(oneQuestionOutcome(), [
        ["service", "noText"],
        ["price", "noText"],
      ]),
    );
  });
});

describe("what limit 6 returns holds no person's words and no value", () => {
  it("decisions and verdicts name fields, labels and limits only", async () => {
    const requests = [
      exchangeRequest(VALUE_FAILS),
      moveRequest(at("2026-10-26T19:00:00Z", NEW_YORK)),
      raisePriceRequest(usd(4000), "raise haircut"),
      priceBoardRequest(usd(3500), "Here's my price board", "price board"),
    ];
    const said: string[] = [];
    for (const request of requests) {
      const outcome = await decision({}, request);
      said.push(...stringsIn(outcome));
      said.push(...stringsIn(await limitIn().check(partOf(request), turnOf(request))));
    }
    const labels = new Set([
      "fail",
      "ask",
      "refuse",
      "oneQuestion",
      "nothingChanged",
      "kinds",
      "time_saved",
      "price",
      "differs",
      "wrongZone",
      "noValue",
    ]);
    expect(said.filter((each) => !labels.has(each))).toEqual([]);
    const words = requests.flatMap((request) => decidedIn(request).context.texts.map((text) => text.words));
    for (const each of words) expect(said).not.toContain(each);
  });
});

describe("the shipped limit 6", () => {
  it("is slot 6 of the gate's registry, in place of the fail-closed stub", () => {
    expect(LIMITS[5]).toBe(limit6);
    expect(limit6.limit).toBe(6);
  });

  it("reads the business's zone only through the call's database: with any other repo it throws, so the gate fails the call", async () => {
    const request = haircutMoveRequest(
      at("2026-11-01T20:00:00Z", NEW_YORK),
      "tomorrow at 3pm",
      "tomorrow at 3pm",
      {
        bookingId: null,
      },
    );
    await expect(limit6.check(partOf(request), turnOf(request))).rejects.toThrow(TypeError);
    await expect(runGate(request, callContext(BARBERSHOP), registryWith(limit6))).rejects.toThrow(TypeError);
  });

  it("checks a booking's own zone and text values without reading the database at all", async () => {
    const move = moveRequest(at("2026-10-26T22:00:00Z", LOS_ANGELES));
    expect(await limit6.check(partOf(move), turnOf(move))).toEqual({ result: "pass" });
    const request = exchangeRequest(VALUE_FAILS);
    expect(await limit6.check(partOf(request), turnOf(request))).toEqual({
      result: "fail",
      outcome: oneQuestionOutcome(),
      fields: ["kinds"],
    });
  });

  it("answers only K-09 v1's limit 6 outcomes, each with the kind its action has (the gate's checkOutcome)", () => {
    for (const outcome of [oneQuestionOutcome(), nothingChangedOutcome()]) {
      expect(outcome.limit).toBe(6);
      expect(LIMIT_ACTIONS[6][outcome.action]).toBe(outcome.outcome);
    }
  });
});
