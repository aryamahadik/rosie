// T-304's proofs (the card's "Proves it with"), on the contracts' own fixtures and the master's own examples, with
// doubles standing in for limit 6's ports and for limits 1 to 5, never for limit 6:
//   - commit-limit-6-value-fails.json gives its outcome (and commit-limit-6-reread-first.json, before the re-read);
//   - 'tomorrow at 3' sent 23:30 New York for a Los Angeles flow B visit resolves in the visit's zone;
//   - across a DST change it keeps the wall time;
//   - a price the model gave without source words is refused;
//   - a photo value passes only with the owner's approved read-back.
// Also: every other K-09 gate fixture comes out as it states; video or phone visits take either side's zone; limit 6
// checks only parts that carry values; what it returns holds no person's words; the shipped limit sits in slot 6 and
// reads only through the call's database. Round 2 (DL-184): words cut out of a longer word or number are carried by no
// text (the security review's six cases fail, their whole forms pass), and a value failing on a door, an any-time row or
// a hub case changes nothing once its question was asked again.

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
  ALEX_VISIT,
  ALEX_VISIT_AT,
  BARBERSHOP,
  CHICAGO,
  HAIRCUT,
  HAIRCUT_LINE,
  HOME_SERVICES,
  LOS_ANGELES,
  MONDAY_OCT_19,
  MONEY_CARD_SENT,
  NEW_YORK,
  PRICE_BOARD,
  afterReread,
  askedAbout,
  decidedIn,
  exchangeRequest,
  groupRequest,
  haircutMoveRequest,
  limitIn,
  moveRequest,
  partOf,
  photosOf,
  placesOf,
  priceBoardRequest,
  priceChangeRequest,
  raisePriceRequest,
  registryWith,
  seedBusinessZones,
  targetAt,
  timePickRequest,
  turnOf,
  typed,
  visitKey,
  withoutLimit6,
  type Target,
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

/** The words a request's part 0 cites for its field `name`. */
function citedIn(request: GateRequest, name: string): string {
  const { part } = partOf(request);
  if (part.verb !== "choose" && part.verb !== "enter") throw new Error("part 0 chooses or enters");
  const cited = part.fields.find((each) => each.name === name);
  if (cited === undefined) throw new Error(`part 0 has no field ${name}`);
  return cited.words;
}

describe("words cut out of a longer word or number are carried by no text (DL-184 item 1)", () => {
  const LATER = "can you move me to tomorrow at 10";
  const OCT_24 = "can I come in Oct 24 at 11am";
  const PEOPLE = "can you fit 12 people tomorrow";
  const newOn19 = { bookingId: null, sentAt: MONDAY_OCT_19 } as const;
  // [case, the field, the request citing words cut out of the person's text, the same text cited whole]
  const cases: [string, string, () => GateRequest, () => GateRequest][] = [
    [
      "money: '40' out of 'raise haircut to 140' (the whole '140' is $140)",
      "price",
      () => priceChangeRequest("raise haircut to 140", usd(4000), "40"),
      () => priceChangeRequest("raise haircut to 140", usd(14000), "140"),
    ],
    [
      "time: 'tomorrow at 1' out of 'tomorrow at 10' (the whole is Sun Nov 1 at 10am)",
      "time_saved",
      () => haircutMoveRequest(at("2026-11-01T18:00:00Z", NEW_YORK), "tomorrow at 1", LATER),
      () => haircutMoveRequest(at("2026-11-01T15:00:00Z", NEW_YORK), "tomorrow at 10", LATER),
    ],
    [
      "money: '$1' out of '$1,200' (the whole is $1,200)",
      "price",
      () => priceChangeRequest("raise haircut to $1,200", usd(100), "$1"),
      () => priceChangeRequest("raise haircut to $1,200", usd(120000), "$1,200"),
    ],
    [
      "date: 'Oct 2' out of 'Oct 24' (the whole is Sat Oct 24, at 11am)",
      "time_saved",
      () => haircutMoveRequest(at("2027-10-02T04:00:00Z", NEW_YORK), "Oct 2", OCT_24, newOn19),
      () => haircutMoveRequest(at("2026-10-24T15:00:00Z", NEW_YORK), "Oct 24 at 11am", OCT_24, newOn19),
    ],
    [
      "count: 2 out of '12 people' (the whole is 12)",
      "people",
      () => groupRequest(2, "2 people", PEOPLE),
      () => groupRequest(12, "12 people", PEOPLE),
    ],
    [
      "option: 1 out of '10am' (the whole '10am' names the first option)",
      "time_pick",
      () => timePickRequest("c-01", "1", "10am works"),
      () => timePickRequest("c-01", "10am", "10am works"),
    ],
  ];

  it.each(cases)("%s: the cut fails (noText), the whole passes", async (_case, name, cut, whole) => {
    const request = cut();
    const cited = citedIn(request, name);
    const texts = decidedIn(request).context.texts;
    // The cut words are in the text as a plain substring, inside a longer word or number.
    expect(texts.some((text) => text.words.includes(cited))).toBe(true);
    expect(await decision({}, request)).toEqual(failed(oneQuestionOutcome(), [[name, "noText"]]));
    expect(await decision({}, whole())).toEqual({ result: "pass" });
    // Said whole in a text of the turn, the same words re-parse as that value: only the cut refused it.
    const said = cut();
    const [first] = decidedIn(said).context.texts;
    decidedIn(said).context.texts.push(typed("evt-whole-0001", cited, first.sentAt.utc));
    expect(await decision({}, said)).toEqual({ result: "pass" });
  });

  it.each(cases)(
    "%s: at the gate the quote check refuses the cut before any limit; the whole passes limit 6",
    async (_case, _name, cut, whole) => {
      expect(await runGate(cut(), callContext(BARBERSHOP), registryWith(limitIn()))).toEqual({
        verdict: "refused",
        error: { error: "decideRefused", rule: "quoteInText", parts: [0] },
      });
      const [part] = gatedParts(await runGate(whole(), callContext(BARBERSHOP), registryWith(limitIn())));
      expect(part?.result).toBe("passed");
      expect(part?.limits[5]).toEqual({ limit: 6, result: "pass", outcome: null });
    },
  );
});

describe("a value failing on a door, an any-time row or a hub case changes nothing once its question was asked again (DL-184 item 3)", () => {
  const ALEX_VISIT_TARGET = targetAt(HOME_SERVICES, ALEX_VISIT, ALEX_VISIT_AT);
  // [kind, the failing request, its step, its target, the field, why it fails]
  const kinds: [string, () => GateRequest, string, Target, string, ValueFault][] = [
    [
      "a door (A3-51's new booking): 13 from '12 people'",
      () => groupRequest(13, "12 people", "can you fit 12 people tomorrow"),
      "A3-51",
      targetAt(BARBERSHOP),
      "people",
      "differs",
    ],
    [
      "an any-time row (B7-07's move): 'tomorrow at 3' read in New York",
      () => moveRequest(at("2026-10-26T19:00:00Z", NEW_YORK)),
      "B7-07",
      ALEX_VISIT_TARGET,
      "time_saved",
      "wrongZone",
    ],
    [
      "a hub case (S11-12's settings change): a price from 'raise haircut'",
      () => raisePriceRequest(usd(4000), "raise haircut"),
      "S11-12",
      targetAt(BARBERSHOP),
      "price",
      "noValue",
    ],
  ];

  it.each(kinds)(
    "%s: one question until its step's question about its target was asked twice, then nothingChanged",
    async (_kind, request, step, target, name, why) => {
      const ask = failed(oneQuestionOutcome(), [[name, why]]);
      const nothing = failed(nothingChangedOutcome(), [[name, why]]);
      expect(await decision({}, request())).toEqual(ask);
      expect(await decision({}, askedAbout(request(), step, target, 1))).toEqual(ask);
      expect(await decision({}, askedAbout(request(), step, target, 2))).toEqual(nothing);
      expect(await decision({}, askedAbout(request(), step, target, 3))).toEqual(nothing);
      // Another booking's question, or another step's, is not the part's own.
      const elsewhere = { ...target, bookingId: target.bookingId === null ? HAIRCUT : null };
      expect(await decision({}, askedAbout(request(), step, elsewhere, 2))).toEqual(ask);
      expect(await decision({}, askedAbout(request(), "A7-17", target, 2))).toEqual(ask);
    },
  );

  it("at the gate: before the re-read it is still refused naming the field; after it, the part stops with nothingChanged", async () => {
    const asked = askedAbout(
      moveRequest(at("2026-10-26T19:00:00Z", NEW_YORK)),
      "B7-07",
      ALEX_VISIT_TARGET,
      2,
    );
    expect(await runGate(asked, callContext(HOME_SERVICES), registryWith(limitIn()))).toEqual({
      verdict: "refused",
      error: { error: "valueFailsWords", parts: [{ part: 0, fields: ["time_saved"] }] },
    });
    const [part] = gatedParts(
      await runGate(afterReread(asked), callContext(HOME_SERVICES), registryWith(limitIn())),
    );
    expect(part?.result).toBe("stopped");
    expect(part?.stoppedBy).toEqual(nothingChangedOutcome());
  });

  it("an option's question is still the open question it answers, by its id, never another of its step's", async () => {
    const wrong = () => timePickRequest("c-02", "10am", "10am works");
    expect(await decision({}, wrong())).toEqual(failed(oneQuestionOutcome(), [["time_pick", "differs"]]));
    expect(await decision({}, timePickRequest("c-02", "10am", "10am works", 2))).toEqual(
      failed(nothingChangedOutcome(), [["time_pick", "differs"]]),
    );
    expect(await decision({}, askedAbout(wrong(), "A4-14", targetAt(BARBERSHOP), 2))).toEqual(
      failed(oneQuestionOutcome(), [["time_pick", "differs"]]),
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

// Round 3 (DL-189): word edges are judged on the folded text the readers read (fullwidth and small marks are their
// marks, every apostrophe a joiner, what shows nothing taken out), and a number's value is re-read from its whole value
// phrase in the text, so a unit, part of an hour or a zone left out of the cited words fails.

const ZERO_WIDTH_SPACE = "​";

describe("cut out of a longer number behind a fullwidth mark or a character that shows nothing (DL-189 item 1)", () => {
  const LATER = "can you move me to tomorrow at 10：30";
  const TABLE = "table for 9：30 tomorrow";
  const HIDDEN = `raise haircut to 1${ZERO_WIDTH_SPACE}40`;
  // [case, the field, the request citing words cut out of the person's text, the same text cited whole]
  const cases: [string, string, () => GateRequest, () => GateRequest][] = [
    [
      "money: '$1' out of '$1，200' (the whole is $1,200)",
      "price",
      () => priceChangeRequest("raise haircut to $1，200", usd(100), "$1"),
      () => priceChangeRequest("raise haircut to $1，200", usd(120000), "$1，200"),
    ],
    [
      "time: 'tomorrow at 10' out of 'tomorrow at 10：30' (the whole is Sun Nov 1 at 10:30am)",
      "time_saved",
      () => haircutMoveRequest(at("2026-11-01T15:00:00Z", NEW_YORK), "tomorrow at 10", LATER),
      () => haircutMoveRequest(at("2026-11-01T15:30:00Z", NEW_YORK), "tomorrow at 10：30", LATER),
    ],
    [
      "money: '$12' out of '$12．50' (the whole is $12.50)",
      "price",
      () => priceChangeRequest("raise haircut to $12．50", usd(1200), "$12"),
      () => priceChangeRequest("raise haircut to $12．50", usd(1250), "$12．50"),
    ],
    [
      "count: 9 out of 'table for 9：30 tomorrow' (the whole '9：30 tomorrow' is a time: 9:30am)",
      "people",
      () => groupRequest(9, "9", TABLE),
      () => haircutMoveRequest(at("2026-11-01T14:30:00Z", NEW_YORK), "9：30 tomorrow", TABLE),
    ],
    [
      "money: '40' out of '1​40', a zero-width space inside (the whole is $140)",
      "price",
      () => priceChangeRequest(HIDDEN, usd(4000), "40"),
      () => priceChangeRequest(HIDDEN, usd(14000), `1${ZERO_WIDTH_SPACE}40`),
    ],
    [
      "money: '$40' out of '$40/hr' (the whole is $40 an hour)",
      "price",
      () => priceChangeRequest("raise haircut to $40/hr", usd(4000), "$40"),
      () => priceChangeRequest("raise haircut to $40/hr", usd(4000), "$40/hr"),
    ],
  ];

  it.each(cases)("%s: the cut fails (noText), the whole passes", async (_case, name, cut, whole) => {
    const request = cut();
    const cited = citedIn(request, name);
    expect(decidedIn(request).context.texts.some((text) => text.words.includes(cited))).toBe(true);
    expect(await decision({}, request)).toEqual(failed(oneQuestionOutcome(), [[name, "noText"]]));
    expect(await decision({}, whole())).toEqual({ result: "pass" });
  });

  it.each(cases)(
    "%s: at the gate the quote check refuses the cut before any limit (quoteInText); the whole passes limit 6",
    async (_case, _name, cut, whole) => {
      expect(await runGate(cut(), callContext(BARBERSHOP), registryWith(limitIn()))).toEqual({
        verdict: "refused",
        error: { error: "decideRefused", rule: "quoteInText", parts: [0] },
      });
      const [part] = gatedParts(await runGate(whole(), callContext(BARBERSHOP), registryWith(limitIn())));
      expect(part?.result).toBe("passed");
      expect(part?.limits[5]).toEqual({ limit: 6, result: "pass", outcome: null });
    },
  );

  it("the whole '9：30' holds no count, and the same text read whole as 140 passes from '140' too", async () => {
    expect(await decision({}, groupRequest(9, "9：30", TABLE))).toEqual(
      failed(oneQuestionOutcome(), [["people", "noValue"]]),
    );
    expect(await decision({}, priceChangeRequest(HIDDEN, usd(14000), "140"))).toEqual({ result: "pass" });
  });
});

describe("a number's value is re-read from its whole value phrase (DL-189 item 2)", () => {
  const QUARTER = "can you move me to quarter to 3 tomorrow";
  const MEDIA = "¿me puede cambiar a mañana a las 3 y media?";
  const PACIFIC = "can you move me to tomorrow at 3pm PST";
  const THREE_PM = at("2026-11-01T20:00:00Z", NEW_YORK);
  // [case, the field, the request citing words that leave part of the phrase out, its fault, the whole cited, its decision]
  const cases: [string, string, () => GateRequest, ValueFault, () => GateRequest, ValuesDecision][] = [
    [
      "'40' out of '40%' (the whole '40%' is a share, no amount)",
      "price",
      () => priceChangeRequest("raise haircut to 40%", usd(4000), "40"),
      "noText",
      () => priceChangeRequest("raise haircut to 40%", usd(4000), "40%"),
      failed(oneQuestionOutcome(), [["price", "noValue"]]),
    ],
    [
      "'40' out of '40¢' (the whole is 40 cents)",
      "price",
      () => priceChangeRequest("raise haircut to 40¢", usd(4000), "40"),
      "differs",
      () => priceChangeRequest("raise haircut to 40¢", usd(40), "40¢"),
      { result: "pass" },
    ],
    [
      "'3 tomorrow' out of 'quarter to 3 tomorrow' (the whole is 2:45)",
      "time_saved",
      () => haircutMoveRequest(THREE_PM, "3 tomorrow", QUARTER),
      "differs",
      () => haircutMoveRequest(at("2026-11-01T19:45:00Z", NEW_YORK), "quarter to 3 tomorrow", QUARTER),
      { result: "pass" },
    ],
    [
      "'mañana a las 3' out of 'mañana a las 3 y media' (the whole is 3:30)",
      "time_saved",
      () => haircutMoveRequest(THREE_PM, "mañana a las 3", MEDIA, { language: "es" }),
      "differs",
      () =>
        haircutMoveRequest(at("2026-11-01T20:30:00Z", NEW_YORK), "mañana a las 3 y media", MEDIA, {
          language: "es",
        }),
      { result: "pass" },
    ],
    [
      "'tomorrow at 3pm' out of 'tomorrow at 3pm PST' for a New York visit (the whole is 3pm Pacific)",
      "time_saved",
      () => haircutMoveRequest(THREE_PM, "tomorrow at 3pm", PACIFIC),
      "wrongZone",
      () => haircutMoveRequest(THREE_PM, "tomorrow at 3pm PST", PACIFIC),
      failed(oneQuestionOutcome(), [["time_saved", "wrongZone"]]),
    ],
  ];

  it.each(cases)(
    "%s: the cut words stand whole but fail on the whole phrase; the whole gives its own reading",
    async (_case, name, cut, why, whole, wholeDecision) => {
      const request = cut();
      expect(
        decidedIn(request).context.texts.some((text) => text.words.includes(citedIn(request, name))),
      ).toBe(true);
      expect(await decision({}, request)).toEqual(failed(oneQuestionOutcome(), [[name, why]]));
      expect(await decision({}, whole())).toEqual(wholeDecision);
    },
  );

  it.each(cases)(
    "%s: at the gate the quote check passes; before the re-read it is refused naming the field, after it one question",
    async (_case, name, cut) => {
      expect(await runGate(cut(), callContext(BARBERSHOP), registryWith(limitIn()))).toEqual({
        verdict: "refused",
        error: { error: "valueFailsWords", parts: [{ part: 0, fields: [name] }] },
      });
      const [part] = gatedParts(
        await runGate(afterReread(cut()), callContext(BARBERSHOP), registryWith(limitIn())),
      );
      expect(part?.result).toBe("stopped");
      expect(part?.stoppedBy).toEqual(oneQuestionOutcome());
    },
  );

  it("'tomorrow at 3pm PST' passes for Alex's Los Angeles visit, read in its zone", async () => {
    const words = "can we do tomorrow at 3pm PST instead";
    const pacific = (cited: string) => moveRequest(at("2026-10-26T22:00:00Z", LOS_ANGELES), { words, cited });
    expect(await decision({}, pacific("tomorrow at 3pm PST"))).toEqual({ result: "pass" });
    expect(await decision({}, pacific("tomorrow at 3pm"))).toEqual({ result: "pass" });
    expect(
      await decision(
        {},
        moveRequest(at("2026-10-26T19:00:00Z", NEW_YORK), { words, cited: "tomorrow at 3pm" }),
      ),
    ).toEqual(failed(oneQuestionOutcome(), [["time_saved", "wrongZone"]]));
  });
});

// Round 4 (DL-199): the readers define the phrase. The person's whole text is read with the same reader that read the
// field, and the value must hold on the reading whose span holds the cited words: the round 3 review's G1 to G10 and
// N1 to N4 fail, and each whole form gives its own reading.

describe("the phrase is the readers' own: the round 3 review's G1 to G10 fail at limit 6 (DL-199)", () => {
  const FRIDAY_OCT_30 = "2026-10-30T14:00:00Z"; // Fri Oct 30 2026, 10:00am in New York (EDT)
  const ny = (utc: string) => at(utc, NEW_YORK);
  const es = { language: "es" } as const;
  const day = "can you move me to the day after tomorrow at 3pm";
  const pasado = "¿me puede cambiar a pasado mañana a las 3?";
  const afternoon = "can you do tomorrow afternoon at 3";
  const tarde = "mañana en la tarde a las 3";
  const night = "tomorrow night at 9 works";
  const noon = "can you do tomorrow at noon";
  const mediodia = "mañana al mediodía";
  const comma = "can you do tomorrow, 3pm";
  const pst = "can we do tomorrow at 3pm, PST instead";
  const nextFriday = "can you do next Friday at 3";
  // [case, the request citing words that leave part of the phrase out, its fault, the whole cited, which passes]
  const cases: [string, () => GateRequest, ValueFault, () => GateRequest][] = [
    [
      "G1: 'tomorrow at 3pm' out of 'the day after tomorrow at 3pm' (the whole is Mon Nov 2 at 3pm)",
      () => haircutMoveRequest(ny("2026-11-01T20:00:00Z"), "tomorrow at 3pm", day),
      "differs",
      () => haircutMoveRequest(ny("2026-11-02T20:00:00Z"), "the day after tomorrow at 3pm", day),
    ],
    [
      "G2: 'mañana a las 3' out of 'pasado mañana a las 3' (the whole is Mon Nov 2)",
      () => haircutMoveRequest(ny("2026-11-01T20:00:00Z"), "mañana a las 3", pasado, es),
      "differs",
      () => haircutMoveRequest(ny("2026-11-02T20:00:00Z"), "pasado mañana a las 3", pasado, es),
    ],
    [
      "G3: 'at 3' out of 'tomorrow afternoon at 3', as today's 3pm (the whole is Sun Nov 1 at 3pm)",
      () => haircutMoveRequest(ny("2026-10-31T19:00:00Z"), "at 3", afternoon),
      "differs",
      () => haircutMoveRequest(ny("2026-11-01T20:00:00Z"), "tomorrow afternoon at 3", afternoon),
    ],
    [
      "G4: 'a las 3' out of 'mañana en la tarde a las 3' (the whole is Sun Nov 1 at 3pm)",
      () => haircutMoveRequest(ny("2026-10-31T19:00:00Z"), "a las 3", tarde, es),
      "differs",
      () => haircutMoveRequest(ny("2026-11-01T20:00:00Z"), tarde, tarde, es),
    ],
    [
      "G5: 'at 9' out of 'tomorrow night at 9', as tonight's 9pm (the whole is Sun Nov 1 at 9pm)",
      () => haircutMoveRequest(ny("2026-11-01T01:00:00Z"), "at 9", night),
      "differs",
      () => haircutMoveRequest(ny("2026-11-02T02:00:00Z"), "tomorrow night at 9", night),
    ],
    [
      "G6: 'tomorrow' out of 'tomorrow at noon' (the whole is Sun Nov 1 at noon)",
      () => haircutMoveRequest(ny("2026-11-01T04:00:00Z"), "tomorrow", noon),
      "differs",
      () => haircutMoveRequest(ny("2026-11-01T17:00:00Z"), "tomorrow at noon", noon),
    ],
    [
      "G7: 'mañana' out of 'mañana al mediodía' (the whole is Sun Nov 1 at noon)",
      () => haircutMoveRequest(ny("2026-11-01T04:00:00Z"), "mañana", mediodia, es),
      "differs",
      () => haircutMoveRequest(ny("2026-11-01T17:00:00Z"), mediodia, mediodia, es),
    ],
    [
      "G8: 'tomorrow' out of 'tomorrow, 3pm' (the whole is Sun Nov 1 at 3pm)",
      () => haircutMoveRequest(ny("2026-11-01T04:00:00Z"), "tomorrow", comma),
      "differs",
      () => haircutMoveRequest(ny("2026-11-01T20:00:00Z"), "tomorrow, 3pm", comma),
    ],
    [
      "G9: 'tomorrow at 3pm' out of 'tomorrow at 3pm, PST' for a New York visit (the whole passes in Los Angeles)",
      () => haircutMoveRequest(ny("2026-11-01T20:00:00Z"), "tomorrow at 3pm", pst),
      "wrongZone",
      () =>
        moveRequest(at("2026-10-26T22:00:00Z", LOS_ANGELES), {
          words: pst,
          cited: "tomorrow at 3pm, PST",
        }),
    ],
    [
      "G10: 'Friday at 3' out of 'next Friday at 3', sent Fri Oct 30 (the whole is Fri Nov 6 at 3pm)",
      () =>
        haircutMoveRequest(ny("2026-10-30T19:00:00Z"), "Friday at 3", nextFriday, { sentAt: FRIDAY_OCT_30 }),
      "differs",
      () =>
        haircutMoveRequest(ny("2026-11-06T20:00:00Z"), "next Friday at 3", nextFriday, {
          sentAt: FRIDAY_OCT_30,
        }),
    ],
  ];

  it.each(cases)(
    "%s: the cut stands whole but fails on the reader's phrase; the whole passes",
    async (_case, cut, why, whole) => {
      const request = cut();
      const cited = citedIn(request, "time_saved");
      expect(decidedIn(request).context.texts.some((text) => text.words.includes(cited))).toBe(true);
      expect(await decision({}, request)).toEqual(failed(oneQuestionOutcome(), [["time_saved", why]]));
      expect(await decision({}, whole())).toEqual({ result: "pass" });
    },
  );

  const atTheGate = cases.filter(([name]) => /^G(?:1|2|3|6|9):/.test(name));
  /** The call context of a request's own business (Alex's flow B visit is Lee Home Services'). */
  const contextOf = (request: GateRequest) => callContext(turnOf(request).businessId);

  it.each(atTheGate)(
    "%s: at the gate the quote check passes; before the re-read it is refused naming the field, after it one question",
    async (_case, cut, _why, whole) => {
      expect(await runGate(cut(), contextOf(cut()), registryWith(limitIn()))).toEqual({
        verdict: "refused",
        error: { error: "valueFailsWords", parts: [{ part: 0, fields: ["time_saved"] }] },
      });
      const [part] = gatedParts(await runGate(afterReread(cut()), contextOf(cut()), registryWith(limitIn())));
      expect(part?.result).toBe("stopped");
      expect(part?.stoppedBy).toEqual(oneQuestionOutcome());
      const [passed] = gatedParts(await runGate(whole(), contextOf(whole()), registryWith(limitIn())));
      expect(passed?.result).toBe("passed");
      expect(passed?.limits[5]).toEqual({ limit: 6, result: "pass", outcome: null });
    },
  );

  it("the gate checks the five the review ran there: G1, G2, G3, G6 and G9", () => {
    expect(atTheGate.map(([name]) => name.slice(0, name.indexOf(":")))).toEqual([
      "G1",
      "G2",
      "G3",
      "G6",
      "G9",
    ]);
  });
});

describe("the round 3 review's N1 to N4 fail at limit 6 and, cut at a joined mark, at the gate (DL-199)", () => {
  const eur = (cents: number) => ({ cents, currency: "EUR" });
  const mxn = (cents: number) => ({ cents, currency: "MXN" });
  // [case, the field, the request citing words that leave part of the value out, its fault, the whole, its decision]
  const cases: [string, string, () => GateRequest, ValueFault, () => GateRequest, ValuesDecision][] = [
    [
      "N1: '40' out of '40 euros' (the whole is 40 euros, no dollars)",
      "price",
      () => priceChangeRequest("raise haircut to 40 euros", usd(4000), "40"),
      "differs",
      () => priceChangeRequest("raise haircut to 40 euros", eur(4000), "40 euros"),
      { result: "pass" },
    ],
    [
      "N1: '40' out of '40 pesos' (the whole is 40 pesos)",
      "price",
      () => priceChangeRequest("raise haircut to 40 pesos", usd(4000), "40"),
      "differs",
      () => priceChangeRequest("raise haircut to 40 pesos", mxn(4000), "40 pesos"),
      { result: "pass" },
    ],
    [
      "N2: '$1' out of '$1 million' (the whole is $1,000,000)",
      "price",
      () => priceChangeRequest("raise haircut to $1 million", usd(100), "$1"),
      "differs",
      () => priceChangeRequest("raise haircut to $1 million", usd(100_000_000), "$1 million"),
      { result: "pass" },
    ],
    [
      "N3: '$12' out of '$12～15' (the whole is a range: several)",
      "price",
      () => priceChangeRequest("raise haircut to $12～15", usd(1200), "$12"),
      "noText",
      () => priceChangeRequest("raise haircut to $12～15", usd(1200), "$12～15"),
      failed(oneQuestionOutcome(), [["price", "several"]]),
    ],
    [
      "N3: '5pm' out of '3～5pm' (the whole is a range: several)",
      "time_saved",
      () => haircutMoveRequest(at("2026-10-31T21:00:00Z", NEW_YORK), "5pm", "can you move me to 3～5pm"),
      "noText",
      () => haircutMoveRequest(at("2026-10-31T21:00:00Z", NEW_YORK), "3～5pm", "can you move me to 3～5pm"),
      failed(oneQuestionOutcome(), [["time_saved", "several"]]),
    ],
    [
      "N4: '$40' out of '$40_000' (an underscore joins; the whole leaves 000 unread)",
      "price",
      () => priceChangeRequest("raise haircut to $40_000", usd(4000), "$40"),
      "noText",
      () => priceChangeRequest("raise haircut to $40_000", usd(4000), "$40_000"),
      failed(oneQuestionOutcome(), [["price", "noText"]]),
    ],
  ];

  it.each(cases)(
    "%s: the cut fails at limit 6; the whole gives its own reading",
    async (_case, name, cut, why, whole, wholeDecision) => {
      const request = cut();
      expect(
        decidedIn(request).context.texts.some((text) => text.words.includes(citedIn(request, name))),
      ).toBe(true);
      expect(await decision({}, request)).toEqual(failed(oneQuestionOutcome(), [[name, why]]));
      expect(await decision({}, whole())).toEqual(wholeDecision);
    },
  );

  it.each(cases.filter(([, , , why]) => why === "noText"))(
    "%s: at the gate the quote check refuses the cut before any limit (quoteInText)",
    async (_case, _name, cut) => {
      expect(await runGate(cut(), callContext(BARBERSHOP), registryWith(limitIn()))).toEqual({
        verdict: "refused",
        error: { error: "decideRefused", rule: "quoteInText", parts: [0] },
      });
    },
  );
});

// Round 5 (DL-209): a bare hour the reader reads beside a day joins the day's phrase whatever other time the text holds
// (the round 4 review's GAP 4: H1 to H3), and the readers learn a bare hour after a part-of-day word, a currency code
// beside an amount and "M" as million (its notes N2 and N1).

describe("a bare hour beside a day joins the day's phrase whatever other time the text holds: the round 4 review's H1 to H3 (DL-209)", () => {
  const ny = (utc: string) => at(utc, NEW_YORK);
  const es = { language: "es" } as const;
  const H1 = "my 2pm doesn't work. can we do Thursday, 3?";
  const H2 = "can't make my 2pm, 3 tomorrow?";
  const H3 = "a las 2 no puedo. ¿el jueves, 3?";
  // [case, the request citing the day alone, read at its start (sent Sat Oct 31 at 10:00am in New York)]
  const cases: [string, () => GateRequest][] = [
    [
      "H1: 'Thursday' (Thu Nov 5 at its start) out of 'my 2pm doesn't work. can we do Thursday, 3?'",
      () => haircutMoveRequest(ny("2026-11-05T05:00:00Z"), "Thursday", H1),
    ],
    [
      "H2: 'tomorrow' (Sun Nov 1 at its start) out of 'can't make my 2pm, 3 tomorrow?'",
      () => haircutMoveRequest(ny("2026-11-01T04:00:00Z"), "tomorrow", H2),
    ],
    [
      "H3: 'el jueves' (Thu Nov 5 at its start) out of 'a las 2 no puedo. ¿el jueves, 3?'",
      () => haircutMoveRequest(ny("2026-11-05T05:00:00Z"), "el jueves", H3, es),
    ],
  ];
  /** The call context of a request's own business. */
  const contextOf = (request: GateRequest) => callContext(turnOf(request).businessId);

  it.each(cases)("%s: limit 6 fails it (differs)", async (_case, cut) => {
    const request = cut();
    const cited = citedIn(request, "time_saved");
    expect(decidedIn(request).context.texts.some((text) => text.words.includes(cited))).toBe(true);
    expect(await decision({}, request)).toEqual(failed(oneQuestionOutcome(), [["time_saved", "differs"]]));
    expect(await decision({}, afterReread(request))).toEqual(
      failed(oneQuestionOutcome(), [["time_saved", "differs"]]),
    );
  });

  it.each(cases)(
    "%s: at the gate the quote check passes; before the re-read it is refused naming the field, after it one question",
    async (_case, cut) => {
      expect(await runGate(cut(), contextOf(cut()), registryWith(limitIn()))).toEqual({
        verdict: "refused",
        error: { error: "valueFailsWords", parts: [{ part: 0, fields: ["time_saved"] }] },
      });
      const [part] = gatedParts(await runGate(afterReread(cut()), contextOf(cut()), registryWith(limitIn())));
      expect(part?.result).toBe("stopped");
      expect(part?.stoppedBy).toEqual(oneQuestionOutcome());
    },
  );

  it.each([
    ["3pm", "2026-11-05T20:00:00Z"],
    ["3am", "2026-11-05T08:00:00Z"],
  ])(
    "the whole 'Thursday, 3' passes as %s (CQ-119's default: either reading passes), at limit 6 and the gate",
    async (_reading, utc) => {
      const whole = haircutMoveRequest(ny(utc), "Thursday, 3", H1);
      expect(await decision({}, whole)).toEqual({ result: "pass" });
      const [passed] = gatedParts(await runGate(whole, contextOf(whole), registryWith(limitIn())));
      expect(passed?.result).toBe("passed");
      expect(passed?.limits[5]).toEqual({ limit: 6, result: "pass", outcome: null });
      expect(await decision({}, haircutMoveRequest(ny(utc), "el jueves, 3", H3, { language: "es" }))).toEqual(
        { result: "pass" },
      );
    },
  );

  it("the whole 'Thursday, 3' read at another hour differs", async () => {
    expect(await decision({}, haircutMoveRequest(ny("2026-11-05T21:00:00Z"), "Thursday, 3", H1))).toEqual(
      failed(oneQuestionOutcome(), [["time_saved", "differs"]]),
    );
  });
});

describe("the readers learn a bare hour after a part-of-day word, a currency code beside an amount and 'M' as million (DL-209)", () => {
  const ny = (utc: string) => at(utc, NEW_YORK);
  const SUNDAY = ny("2026-11-01T04:00:00Z"); // Sun Nov 1 at its start
  // [case, the cut request and its fault, the whole request]
  const cases: [string, () => GateRequest, string, ValueFault, () => GateRequest][] = [
    [
      "N2: 'tomorrow morning' out of 'tomorrow morning, 9' (the whole is Sun Nov 1 at 9am)",
      () => haircutMoveRequest(SUNDAY, "tomorrow morning", "can you do tomorrow morning, 9"),
      "time_saved",
      "differs",
      () =>
        haircutMoveRequest(
          ny("2026-11-01T14:00:00Z"),
          "tomorrow morning, 9",
          "can you do tomorrow morning, 9",
        ),
    ],
    [
      "N2: 'tomorrow evening' out of 'tomorrow evening at 7' (the whole is Sun Nov 1 at 7pm)",
      () => haircutMoveRequest(SUNDAY, "tomorrow evening", "can you do tomorrow evening at 7"),
      "time_saved",
      "differs",
      () =>
        haircutMoveRequest(
          ny("2026-11-02T00:00:00Z"),
          "tomorrow evening at 7",
          "can you do tomorrow evening at 7",
        ),
    ],
    [
      "N2 with another time in the text: 'tomorrow morning' out of 'my 2pm is out. tomorrow morning, 9?'",
      () => haircutMoveRequest(SUNDAY, "tomorrow morning", "my 2pm is out. tomorrow morning, 9?"),
      "time_saved",
      "differs",
      () =>
        haircutMoveRequest(
          ny("2026-11-01T14:00:00Z"),
          "tomorrow morning, 9",
          "my 2pm is out. tomorrow morning, 9?",
        ),
    ],
    [
      "N1: '$40' out of 'MXN $40' (the whole is 40 Mexican pesos)",
      () => priceChangeRequest("raise haircut to MXN $40", usd(4000), "$40"),
      "price",
      "differs",
      () => priceChangeRequest("raise haircut to MXN $40", { cents: 4000, currency: "MXN" }, "MXN $40"),
    ],
    [
      "N1: '40$' out of '40$ CAD' (the whole is 40 Canadian dollars)",
      () => priceChangeRequest("raise haircut to 40$ CAD", usd(4000), "40$"),
      "price",
      "differs",
      () => priceChangeRequest("raise haircut to 40$ CAD", { cents: 4000, currency: "CAD" }, "40$ CAD"),
    ],
    [
      "N1: '$1M' read as $1 (the whole is $1,000,000)",
      () => priceChangeRequest("raise haircut to $1M", usd(100), "$1M"),
      "price",
      "differs",
      () => priceChangeRequest("raise haircut to $1M", usd(100_000_000), "$1M"),
    ],
  ];

  it.each(cases)("%s: the cut fails at limit 6; the whole passes", async (_case, cut, name, why, whole) => {
    expect(await decision({}, cut())).toEqual(failed(oneQuestionOutcome(), [[name, why]]));
    expect(await decision({}, whole())).toEqual({ result: "pass" });
  });

  it("a non-USD reading fails a USD field even cited whole: 'MXN $40' and '40$ CAD' as dollars differ", async () => {
    for (const [words, cited] of [
      ["raise haircut to MXN $40", "MXN $40"],
      ["raise haircut to 40$ CAD", "40$ CAD"],
    ] as const) {
      expect(await decision({}, priceChangeRequest(words, usd(4000), cited))).toEqual(
        failed(oneQuestionOutcome(), [["price", "differs"]]),
      );
    }
  });
});

// Round 6 (DL-217): a sentence mark with no digit right after it ends a cued or bare hour, as a comma does (round 5's
// default b), so the hour stays in its day's phrase and a cut that drops it differs (the round 5 review's GAP 5: P1 to
// P4); "3.30" and "3.5" keep their readings.

describe("a sentence mark right after a cued or bare hour ends the hour, which stays in the day's phrase: the round 5 review's P1 to P4 (DL-217)", () => {
  const ny = (utc: string) => at(utc, NEW_YORK);
  const es = { language: "es" } as const;
  const SUNDAY = ny("2026-11-01T04:00:00Z"); // Sun Nov 1 at its start (still EDT)
  const THURSDAY = ny("2026-11-05T05:00:00Z"); // Thu Nov 5 at its start (EST)
  const P1 = "can you do tomorrow at 3.";
  const P2 = "puedo mañana a las 3.";
  const P3 = "my 2pm doesn't work. can we do Thursday, 3.";
  const P4 = "can you do tomorrow morning, 9.";
  // [case, the request citing the day alone, read at its start (sent Sat Oct 31 at 10:00am in New York), the whole]
  const cases: [string, () => GateRequest, () => GateRequest][] = [
    [
      "P1: 'tomorrow' out of 'can you do tomorrow at 3.' (the whole is Sun Nov 1 at 3pm)",
      () => haircutMoveRequest(SUNDAY, "tomorrow", P1),
      () => haircutMoveRequest(ny("2026-11-01T20:00:00Z"), "tomorrow at 3", P1),
    ],
    [
      "P2: 'mañana' out of 'puedo mañana a las 3.' (the whole is Sun Nov 1 at 3pm)",
      () => haircutMoveRequest(SUNDAY, "mañana", P2, es),
      () => haircutMoveRequest(ny("2026-11-01T20:00:00Z"), "mañana a las 3", P2, es),
    ],
    [
      "P3: 'Thursday' out of 'my 2pm doesn't work. can we do Thursday, 3.' (the whole is Thu Nov 5 at 3pm)",
      () => haircutMoveRequest(THURSDAY, "Thursday", P3),
      () => haircutMoveRequest(ny("2026-11-05T20:00:00Z"), "Thursday, 3", P3),
    ],
    [
      "P4: 'tomorrow morning' out of 'can you do tomorrow morning, 9.' (the whole is Sun Nov 1 at 9am)",
      () => haircutMoveRequest(SUNDAY, "tomorrow morning", P4),
      () => haircutMoveRequest(ny("2026-11-01T14:00:00Z"), "tomorrow morning, 9", P4),
    ],
  ];
  /** The call context of a request's own business. */
  const contextOf = (request: GateRequest) => callContext(turnOf(request).businessId);

  it.each(cases)("%s: limit 6 fails the cut (differs), before and after the re-read", async (_case, cut) => {
    const request = cut();
    const cited = citedIn(request, "time_saved");
    expect(decidedIn(request).context.texts.some((text) => text.words.includes(cited))).toBe(true);
    expect(await decision({}, request)).toEqual(failed(oneQuestionOutcome(), [["time_saved", "differs"]]));
    expect(await decision({}, afterReread(request))).toEqual(
      failed(oneQuestionOutcome(), [["time_saved", "differs"]]),
    );
  });

  it.each(cases)(
    "%s: at the gate the quote check passes; before the re-read the cut is refused naming the field, after it one question",
    async (_case, cut) => {
      expect(await runGate(cut(), contextOf(cut()), registryWith(limitIn()))).toEqual({
        verdict: "refused",
        error: { error: "valueFailsWords", parts: [{ part: 0, fields: ["time_saved"] }] },
      });
      const [part] = gatedParts(await runGate(afterReread(cut()), contextOf(cut()), registryWith(limitIn())));
      expect(part?.result).toBe("stopped");
      expect(part?.stoppedBy).toEqual(oneQuestionOutcome());
    },
  );

  it.each(cases)("%s: the whole passes at limit 6 and the gate", async (_case, _cut, whole) => {
    const request = whole();
    expect(await decision({}, request)).toEqual({ result: "pass" });
    const [passed] = gatedParts(await runGate(request, contextOf(request), registryWith(limitIn())));
    expect(passed?.result).toBe("passed");
    expect(passed?.limits[5]).toEqual({ limit: 6, result: "pass", outcome: null });
  });

  it("the whole 'tomorrow at 3.' passes as 3am too (CQ-119's default) and, read at another hour, differs", async () => {
    expect(await decision({}, haircutMoveRequest(ny("2026-11-01T08:00:00Z"), "tomorrow at 3.", P1))).toEqual({
      result: "pass",
    });
    expect(await decision({}, haircutMoveRequest(ny("2026-11-01T21:00:00Z"), "tomorrow at 3", P1))).toEqual(
      failed(oneQuestionOutcome(), [["time_saved", "differs"]]),
    );
  });

  it("each other sentence mark after the hour gives the same: '…', ';', '!', '?', a fullwidth '．'", async () => {
    for (const mark of ["…", ";", "!", "?", "．"]) {
      const words = `can you do tomorrow at 3${mark}`;
      expect(await decision({}, haircutMoveRequest(SUNDAY, "tomorrow", words))).toEqual(
        failed(oneQuestionOutcome(), [["time_saved", "differs"]]),
      );
      expect(
        await decision({}, haircutMoveRequest(ny("2026-11-01T20:00:00Z"), "tomorrow at 3", words)),
      ).toEqual({ result: "pass" });
    }
  });

  it("a mark glued before the hour hides it no more (default): 'tomorrow' out of 'can't make my 2pm,3 tomorrow?' and 'hmm...3pm tomorrow?' differs", async () => {
    for (const words of ["can't make my 2pm,3 tomorrow?", "hmm...3pm tomorrow?"]) {
      const request = haircutMoveRequest(SUNDAY, "tomorrow", words);
      expect(await decision({}, request)).toEqual(failed(oneQuestionOutcome(), [["time_saved", "differs"]]));
      expect(await runGate(request, contextOf(request), registryWith(limitIn()))).toEqual({
        verdict: "refused",
        error: { error: "valueFailsWords", parts: [{ part: 0, fields: ["time_saved"] }] },
      });
    }
  });
});

// Round 7 (DL-228): the number edge by construction. A mark (any character that is neither a digit nor a letter) is
// part of a number only with a digit right before it and right after it; anywhere else it ends the number, before and
// after it. So a colon right after an hour ends it as a period does (the round 6 review's GAP 6: Q1 to Q4), and so does
// a colon glued before a time ("Update:3pm tomorrow"); the reader also learns a weekday's short form with its period,
// an hour with a period and two minute digits after a cue or before am or pm, and "+" between counts (DL-228 item 2).

describe("the number edge by construction: a colon right after an hour ends it, and the hour stays in the day's phrase: the round 6 review's Q1 to Q4 (DL-228 item 1)", () => {
  const ny = (utc: string) => at(utc, NEW_YORK);
  const es = { language: "es" } as const;
  const SUNDAY = ny("2026-11-01T04:00:00Z"); // Sun Nov 1 at its start (still EDT)
  const THURSDAY = ny("2026-11-05T05:00:00Z"); // Thu Nov 5 at its start (EST)
  const Q1 = "see you tomorrow at 3:)";
  const Q2 = "puedo mañana a las 3:)";
  const Q3 = "my 2pm doesn't work. can we do Thursday, 3:)";
  const Q4 = "can you do tomorrow morning, 9:)";
  const COLON = "can you do tomorrow at 3:";
  const UPDATE = "Update:3pm tomorrow";
  // [case, the request citing the day alone, read at its start (sent Sat Oct 31 at 10:00am in New York), the whole]
  const cases: [string, () => GateRequest, () => GateRequest][] = [
    [
      "Q1: 'tomorrow' out of 'see you tomorrow at 3:)' (the whole is Sun Nov 1 at 3pm)",
      () => haircutMoveRequest(SUNDAY, "tomorrow", Q1),
      () => haircutMoveRequest(ny("2026-11-01T20:00:00Z"), "tomorrow at 3", Q1),
    ],
    [
      "Q2: 'mañana' out of 'puedo mañana a las 3:)' (the whole is Sun Nov 1 at 3pm)",
      () => haircutMoveRequest(SUNDAY, "mañana", Q2, es),
      () => haircutMoveRequest(ny("2026-11-01T20:00:00Z"), "mañana a las 3", Q2, es),
    ],
    [
      "Q3: 'Thursday' out of 'my 2pm doesn't work. can we do Thursday, 3:)' (the whole is Thu Nov 5 at 3pm)",
      () => haircutMoveRequest(THURSDAY, "Thursday", Q3),
      () => haircutMoveRequest(ny("2026-11-05T20:00:00Z"), "Thursday, 3", Q3),
    ],
    [
      "Q4: 'tomorrow morning' out of 'can you do tomorrow morning, 9:)' (the whole is Sun Nov 1 at 9am)",
      () => haircutMoveRequest(SUNDAY, "tomorrow morning", Q4),
      () => haircutMoveRequest(ny("2026-11-01T14:00:00Z"), "tomorrow morning, 9", Q4),
    ],
    [
      "'tomorrow' out of 'can you do tomorrow at 3:' (the whole is Sun Nov 1 at 3pm)",
      () => haircutMoveRequest(SUNDAY, "tomorrow", COLON),
      () => haircutMoveRequest(ny("2026-11-01T20:00:00Z"), "tomorrow at 3", COLON),
    ],
    [
      "'tomorrow' out of 'Update:3pm tomorrow' (the whole is Sun Nov 1 at 3pm)",
      () => haircutMoveRequest(SUNDAY, "tomorrow", UPDATE),
      () => haircutMoveRequest(ny("2026-11-01T20:00:00Z"), UPDATE, UPDATE),
    ],
  ];
  /** The call context of a request's own business. */
  const contextOf = (request: GateRequest) => callContext(turnOf(request).businessId);

  it.each(cases)("%s: limit 6 fails the cut (differs), before and after the re-read", async (_case, cut) => {
    const request = cut();
    const cited = citedIn(request, "time_saved");
    expect(decidedIn(request).context.texts.some((text) => text.words.includes(cited))).toBe(true);
    expect(await decision({}, request)).toEqual(failed(oneQuestionOutcome(), [["time_saved", "differs"]]));
    expect(await decision({}, afterReread(request))).toEqual(
      failed(oneQuestionOutcome(), [["time_saved", "differs"]]),
    );
  });

  it.each(cases)(
    "%s: at the gate the quote check passes; before the re-read the cut is refused naming the field, after it one question",
    async (_case, cut) => {
      expect(await runGate(cut(), contextOf(cut()), registryWith(limitIn()))).toEqual({
        verdict: "refused",
        error: { error: "valueFailsWords", parts: [{ part: 0, fields: ["time_saved"] }] },
      });
      const [part] = gatedParts(await runGate(afterReread(cut()), contextOf(cut()), registryWith(limitIn())));
      expect(part?.result).toBe("stopped");
      expect(part?.stoppedBy).toEqual(oneQuestionOutcome());
    },
  );

  it.each(cases)("%s: the whole passes at limit 6 and the gate", async (_case, _cut, whole) => {
    const request = whole();
    expect(await decision({}, request)).toEqual({ result: "pass" });
    const [passed] = gatedParts(await runGate(request, contextOf(request), registryWith(limitIn())));
    expect(passed?.result).toBe("passed");
    expect(passed?.limits[5]).toEqual({ limit: 6, result: "pass", outcome: null });
  });

  it("each whole passes cited with its mark too, and as 3am (CQ-119's default); read at another hour it differs", async () => {
    expect(await decision({}, haircutMoveRequest(ny("2026-11-01T20:00:00Z"), "tomorrow at 3:)", Q1))).toEqual(
      {
        result: "pass",
      },
    );
    expect(await decision({}, haircutMoveRequest(ny("2026-11-05T20:00:00Z"), "Thursday, 3:)", Q3))).toEqual({
      result: "pass",
    });
    expect(await decision({}, haircutMoveRequest(ny("2026-11-01T08:00:00Z"), "tomorrow at 3", Q1))).toEqual({
      result: "pass",
    });
    expect(await decision({}, haircutMoveRequest(ny("2026-11-01T21:00:00Z"), "tomorrow at 3", Q1))).toEqual(
      failed(oneQuestionOutcome(), [["time_saved", "differs"]]),
    );
  });

  it("'3:30' keeps its reading: the whole 'tomorrow at 3:30' passes as 3:30pm, and as 3pm it differs", async () => {
    const words = "can you do tomorrow at 3:30";
    expect(
      await decision({}, haircutMoveRequest(ny("2026-11-01T20:30:00Z"), "tomorrow at 3:30", words)),
    ).toEqual({ result: "pass" });
    expect(
      await decision({}, haircutMoveRequest(ny("2026-11-01T20:00:00Z"), "tomorrow at 3:30", words)),
    ).toEqual(failed(oneQuestionOutcome(), [["time_saved", "differs"]]));
  });
});

describe("three readings the reader learns: a weekday's short form with its period, '3.30' after a cue or before am or pm, and '+' between counts (DL-228 item 2)", () => {
  const ny = (utc: string) => at(utc, NEW_YORK);
  const SUNDAY = ny("2026-11-01T04:00:00Z"); // Sun Nov 1 at its start
  const THURSDAY = ny("2026-11-05T05:00:00Z"); // Thu Nov 5 at its start
  const THURS = "can you do Thurs. 3pm";
  const DOTTED = "can you do tomorrow at 3.30";
  const PLUS = "booking for 2 adults + 1 child";
  // [case, the cut request, its field and fault]
  const cases: [string, () => GateRequest, string, ValueFault][] = [
    [
      "2a: 'Thurs' out of 'Thurs. 3pm' (the whole is Thu Nov 5 at 3pm)",
      () => haircutMoveRequest(THURSDAY, "Thurs", THURS),
      "time_saved",
      "differs",
    ],
    [
      "2b: 'tomorrow' out of 'tomorrow at 3.30' (the whole is Sun Nov 1 at 3:30)",
      () => haircutMoveRequest(SUNDAY, "tomorrow", DOTTED),
      "time_saved",
      "differs",
    ],
    [
      "2c: '2 adults' out of 'booking for 2 adults + 1 child' (two counts, so several)",
      () => groupRequest(2, "2 adults", PLUS),
      "people",
      "several",
    ],
  ];
  /** The call context of a request's own business. */
  const contextOf = (request: GateRequest) => callContext(turnOf(request).businessId);

  it.each(cases)("%s: limit 6 fails the cut, before and after the re-read", async (_case, cut, name, why) => {
    expect(await decision({}, cut())).toEqual(failed(oneQuestionOutcome(), [[name, why]]));
    expect(await decision({}, afterReread(cut()))).toEqual(failed(oneQuestionOutcome(), [[name, why]]));
  });

  it.each(cases)(
    "%s: at the gate the cut is refused naming the field before the re-read, and one question after it",
    async (_case, cut, name) => {
      expect(await runGate(cut(), contextOf(cut()), registryWith(limitIn()))).toEqual({
        verdict: "refused",
        error: { error: "valueFailsWords", parts: [{ part: 0, fields: [name] }] },
      });
      const [part] = gatedParts(await runGate(afterReread(cut()), contextOf(cut()), registryWith(limitIn())));
      expect(part?.result).toBe("stopped");
      expect(part?.stoppedBy).toEqual(oneQuestionOutcome());
    },
  );

  it("each whole passes at limit 6 and the gate: 'Thurs. 3pm', 'tomorrow at 3.30' (3:30pm or 3:30am), '2 adults' alone", async () => {
    const wholes = [
      haircutMoveRequest(ny("2026-11-05T20:00:00Z"), "Thurs. 3pm", THURS),
      haircutMoveRequest(ny("2026-11-01T20:30:00Z"), "tomorrow at 3.30", DOTTED),
      haircutMoveRequest(ny("2026-11-01T08:30:00Z"), "tomorrow at 3.30", DOTTED),
      groupRequest(2, "2 adults", "booking for 2 adults"),
    ];
    for (const request of wholes) {
      expect(await decision({}, request)).toEqual({ result: "pass" });
      const [passed] = gatedParts(await runGate(request, contextOf(request), registryWith(limitIn())));
      expect(passed?.result).toBe("passed");
    }
  });

  it("'tomorrow at 3.30' read as 3pm differs, and the whole 'tomorrow 3.30pm' (pm after it) passes as 3:30pm", async () => {
    expect(
      await decision({}, haircutMoveRequest(ny("2026-11-01T20:00:00Z"), "tomorrow at 3.30", DOTTED)),
    ).toEqual(failed(oneQuestionOutcome(), [["time_saved", "differs"]]));
    expect(
      await decision(
        {},
        haircutMoveRequest(ny("2026-11-01T20:30:00Z"), "tomorrow 3.30pm", "tomorrow 3.30pm"),
      ),
    ).toEqual({ result: "pass" });
  });
});

// T-1130 (CQ-121's default: each form found later is added to the readers; DL-236, DL-238): the readers learn the forms
// T-304's last review found. The count reader starts and ends a count at round 7's number edge, so a count glued to a
// mark joins its phrase (the round 7 review's GAP 7); the time reader learns the round 7 review's N1 to N3; and the
// number join takes a bracket (the re-review's note). Each cut fails at limit 6 and at the gate; each whole passes.

describe("T-1130 item 1: a count glued to a mark joins its phrase, so a cut of it fails (the round 7 review's GAP 7)", () => {
  const C1 = "can we get a table for 4 or 5:)";
  const C2 = "party of 4, maybe 5:)";
  const C4 = "Update:2 adults + 1 child";
  // [case, the request citing the cut, its fault]
  const cases: [string, () => GateRequest, ValueFault][] = [
    [
      "C1: '4' out of 'can we get a table for 4 or 5:)' (two counts)",
      () => groupRequest(4, "4", C1),
      "several",
    ],
    ["C2: '4' out of 'party of 4, maybe 5:)' (two counts)", () => groupRequest(4, "4", C2), "several"],
    [
      "C4: '1 child' out of 'Update:2 adults + 1 child' (two counts)",
      () => groupRequest(1, "1 child", C4),
      "several",
    ],
    ["'5' out of 're:4 or 5' (two counts)", () => groupRequest(5, "5", "re:4 or 5"), "several"],
    [
      "'4' out of 'table for 4 or 5/6' ('5/6' joins by 'or' and is no count)",
      () => groupRequest(4, "4", "table for 4 or 5/6"),
      "noText",
    ],
  ];
  /** The call context of a request's own business. */
  const contextOf = (request: GateRequest) => callContext(turnOf(request).businessId);

  it.each(cases)("%s: limit 6 fails the cut, before and after the re-read", async (_case, cut, why) => {
    const request = cut();
    const cited = citedIn(request, "people");
    expect(decidedIn(request).context.texts.some((text) => text.words.includes(cited))).toBe(true);
    expect(await decision({}, request)).toEqual(failed(oneQuestionOutcome(), [["people", why]]));
    expect(await decision({}, afterReread(request))).toEqual(failed(oneQuestionOutcome(), [["people", why]]));
  });

  it.each(cases)(
    "%s: at the gate the quote check passes; before the re-read the cut is refused naming the field, after it one question",
    async (_case, cut) => {
      expect(await runGate(cut(), contextOf(cut()), registryWith(limitIn()))).toEqual({
        verdict: "refused",
        error: { error: "valueFailsWords", parts: [{ part: 0, fields: ["people"] }] },
      });
      const [part] = gatedParts(await runGate(afterReread(cut()), contextOf(cut()), registryWith(limitIn())));
      expect(part?.result).toBe("stopped");
      expect(part?.stoppedBy).toEqual(oneQuestionOutcome());
    },
  );

  it("each whole passes at limit 6 and the gate with its own reading: a count glued to a mark alone is that count", async () => {
    const wholes = [
      groupRequest(5, "5", "can we get a table for 5:)"),
      groupRequest(5, "5", "table for 5:"),
      groupRequest(2, "Update:2 adults", "Update:2 adults"),
      groupRequest(4, "re:4", "re:4"),
    ];
    for (const request of wholes) {
      expect(await decision({}, request)).toEqual({ result: "pass" });
      const [passed] = gatedParts(await runGate(request, contextOf(request), registryWith(limitIn())));
      expect(passed?.result).toBe("passed");
      expect(passed?.limits[5]).toEqual({ limit: 6, result: "pass", outcome: null });
    }
  });
});

describe("T-1130 item 2: the time reader learns the round 7 review's N1 to N3, so the day's phrase holds its time", () => {
  const ny = (utc: string) => at(utc, NEW_YORK);
  const es = { language: "es" } as const;
  const SUNDAY = ny("2026-11-01T04:00:00Z"); // Sun Nov 1 at its start (still EDT)
  const THURSDAY = ny("2026-11-05T05:00:00Z"); // Thu Nov 5 at its start (EST)
  const SUNDAY_3PM = ny("2026-11-01T20:00:00Z");
  const SUNDAY_330PM = ny("2026-11-01T20:30:00Z");
  const SUNDAY_7PM = ny("2026-11-02T00:00:00Z");
  /** The day cut alone (read at its start) and the whole, both cited out of `words`, sent Sat Oct 31 at 10:00am. */
  const pair = (
    words: string,
    cut: string,
    day: ReturnType<typeof ny>,
    whole: string,
    value: ReturnType<typeof ny>,
    options: { readonly language?: string } = {},
  ): [() => GateRequest, () => GateRequest] => [
    () => haircutMoveRequest(day, cut, words, options),
    () => haircutMoveRequest(value, whole, words, options),
  ];
  // [case, the request citing the day alone, the request citing the whole]
  const cases: [string, () => GateRequest, () => GateRequest][] = [
    [
      "N1: 'tomorrow' out of 'can you do tomorrow at 3.5' (the whole is Sun Nov 1 at 3:30)",
      ...pair("can you do tomorrow at 3.5", "tomorrow", SUNDAY, "tomorrow at 3.5", SUNDAY_330PM),
    ],
    [
      "N1: 'tomorrow' out of 'can you do tomorrow at 3:30:15' (the whole is Sun Nov 1 at 3:30)",
      ...pair("can you do tomorrow at 3:30:15", "tomorrow", SUNDAY, "tomorrow at 3:30:15", SUNDAY_330PM),
    ],
    [
      "N1: 'tomorrow' out of 'can you do tomorrow at 1530' (the whole is Sun Nov 1 at 15:30)",
      ...pair("can you do tomorrow at 1530", "tomorrow", SUNDAY, "tomorrow at 1530", SUNDAY_330PM),
    ],
    [
      "N1: 'tomorrow' out of 'can you do tomorrow around 3.30' (the whole is Sun Nov 1 at 3:30)",
      ...pair("can you do tomorrow around 3.30", "tomorrow", SUNDAY, "tomorrow around 3.30", SUNDAY_330PM),
    ],
    [
      "N1: 'tomorrow' out of 'can you do tomorrow at ~3' (the whole is Sun Nov 1 at 3)",
      ...pair("can you do tomorrow at ~3", "tomorrow", SUNDAY, "tomorrow at ~3", SUNDAY_3PM),
    ],
    [
      "N2: 'tomorrow' out of 'can you do *3pm* tomorrow' (the whole is Sun Nov 1 at 3pm)",
      ...pair("can you do *3pm* tomorrow", "tomorrow", SUNDAY, "*3pm* tomorrow", SUNDAY_3PM),
    ],
    [
      "N2: 'tomorrow' out of 'can you do tomorrow [3pm]' (the whole is Sun Nov 1 at 3pm)",
      ...pair("can you do tomorrow [3pm]", "tomorrow", SUNDAY, "tomorrow [3pm]", SUNDAY_3PM),
    ],
    [
      "N2: 'tomorrow' out of 'can you do tomorrow at \"3pm\"' (the whole is Sun Nov 1 at 3pm)",
      ...pair('can you do tomorrow at "3pm"', "tomorrow", SUNDAY, 'tomorrow at "3pm"', SUNDAY_3PM),
    ],
    [
      "N2: 'tomorrow' out of 'can you do tomorrow 👍 3pm' (the whole is Sun Nov 1 at 3pm)",
      ...pair("can you do tomorrow 👍 3pm", "tomorrow", SUNDAY, "tomorrow 👍 3pm", SUNDAY_3PM),
    ],
    [
      "N3: 'tomorrow' out of 'table tomorrow for 2 at 7pm' (the whole is Sun Nov 1 at 7pm)",
      ...pair("table tomorrow for 2 at 7pm", "tomorrow", SUNDAY, "tomorrow for 2 at 7pm", SUNDAY_7PM),
    ],
    [
      "N3: 'tmrw' out of 'can you do tmrw. 3pm' (the whole is Sun Nov 1 at 3pm)",
      ...pair("can you do tmrw. 3pm", "tmrw", SUNDAY, "tmrw. 3pm", SUNDAY_3PM),
    ],
    [
      "N3: 'Thursday' out of 'can you do Thursday: 3' (the whole is Thu Nov 5 at 3)",
      ...pair("can you do Thursday: 3", "Thursday", THURSDAY, "Thursday: 3", ny("2026-11-05T20:00:00Z")),
    ],
    [
      "N3: 'tomorrow' out of 'can you do tomorrow at \"3\"' (the whole is Sun Nov 1 at 3)",
      ...pair('can you do tomorrow at "3"', "tomorrow", SUNDAY, 'tomorrow at "3"', SUNDAY_3PM),
    ],
    [
      "N3: 'tomorrow' out of 'can you do tomorrow at (3)' (the whole is Sun Nov 1 at 3)",
      ...pair("can you do tomorrow at (3)", "tomorrow", SUNDAY, "tomorrow at (3)", SUNDAY_3PM),
    ],
    [
      "Spanish: 'mañana' out of 'puedo mañana a las 1530' (the whole is Sun Nov 1 at 15:30)",
      ...pair("puedo mañana a las 1530", "mañana", SUNDAY, "mañana a las 1530", SUNDAY_330PM, es),
    ],
  ];
  /** The call context of a request's own business. */
  const contextOf = (request: GateRequest) => callContext(turnOf(request).businessId);

  it.each(cases)("%s: limit 6 fails the cut (differs), before and after the re-read", async (_case, cut) => {
    const request = cut();
    const cited = citedIn(request, "time_saved");
    expect(decidedIn(request).context.texts.some((text) => text.words.includes(cited))).toBe(true);
    expect(await decision({}, request)).toEqual(failed(oneQuestionOutcome(), [["time_saved", "differs"]]));
    expect(await decision({}, afterReread(request))).toEqual(
      failed(oneQuestionOutcome(), [["time_saved", "differs"]]),
    );
  });

  it.each(cases)(
    "%s: at the gate the quote check passes; before the re-read the cut is refused naming the field, after it one question",
    async (_case, cut) => {
      expect(await runGate(cut(), contextOf(cut()), registryWith(limitIn()))).toEqual({
        verdict: "refused",
        error: { error: "valueFailsWords", parts: [{ part: 0, fields: ["time_saved"] }] },
      });
      const [part] = gatedParts(await runGate(afterReread(cut()), contextOf(cut()), registryWith(limitIn())));
      expect(part?.result).toBe("stopped");
      expect(part?.stoppedBy).toEqual(oneQuestionOutcome());
    },
  );

  it.each(cases)("%s: the whole passes at limit 6 and the gate", async (_case, _cut, whole) => {
    const request = whole();
    expect(await decision({}, request)).toEqual({ result: "pass" });
    const [passed] = gatedParts(await runGate(request, contextOf(request), registryWith(limitIn())));
    expect(passed?.result).toBe("passed");
    expect(passed?.limits[5]).toEqual({ limit: 6, result: "pass", outcome: null });
  });

  it("each whole read at another time differs: 'at 3.5' is half past, never 3:00; '1530' is 3:30pm, never 3:30am", async () => {
    const half = "can you do tomorrow at 3.5";
    expect(
      await decision({}, haircutMoveRequest(ny("2026-11-01T08:30:00Z"), "tomorrow at 3.5", half)),
    ).toEqual({
      result: "pass",
    });
    expect(await decision({}, haircutMoveRequest(SUNDAY_3PM, "tomorrow at 3.5", half))).toEqual(
      failed(oneQuestionOutcome(), [["time_saved", "differs"]]),
    );
    const military = "can you do tomorrow at 1530";
    expect(
      await decision({}, haircutMoveRequest(ny("2026-11-01T08:30:00Z"), "tomorrow at 1530", military)),
    ).toEqual(failed(oneQuestionOutcome(), [["time_saved", "differs"]]));
  });

  it("the party between the day and the time is the count's: '2' out of 'table tomorrow for 2 at 7pm' passes as the count", async () => {
    const request = groupRequest(2, "2", "table tomorrow for 2 at 7pm");
    expect(await decision({}, request)).toEqual({ result: "pass" });
    const [passed] = gatedParts(
      await runGate(request, callContext(turnOf(request).businessId), registryWith(limitIn())),
    );
    expect(passed?.result).toBe("passed");
  });
});

describe("T-1130: the number join takes a bracket, so '$40' out of 'raise haircut to $40 (or $50)' fails (the re-review's note, DL-238)", () => {
  // [case, the request citing the cut, its field, its fault]
  const cases: [string, () => GateRequest, string, ValueFault][] = [
    [
      "'$40' out of 'raise haircut to $40 (or $50)' (two amounts)",
      () => priceChangeRequest("raise haircut to $40 (or $50)", usd(4000), "$40"),
      "price",
      "several",
    ],
    [
      "'4' out of 'party of 4 (maybe 5)' (two counts)",
      () => groupRequest(4, "4", "party of 4 (maybe 5)"),
      "people",
      "several",
    ],
  ];
  /** The call context of a request's own business. */
  const contextOf = (request: GateRequest) => callContext(turnOf(request).businessId);

  it.each(cases)("%s: limit 6 fails the cut, before and after the re-read", async (_case, cut, name, why) => {
    expect(await decision({}, cut())).toEqual(failed(oneQuestionOutcome(), [[name, why]]));
    expect(await decision({}, afterReread(cut()))).toEqual(failed(oneQuestionOutcome(), [[name, why]]));
  });

  it.each(cases)(
    "%s: at the gate the cut is refused naming the field before the re-read, and one question after it",
    async (_case, cut, name) => {
      expect(await runGate(cut(), contextOf(cut()), registryWith(limitIn()))).toEqual({
        verdict: "refused",
        error: { error: "valueFailsWords", parts: [{ part: 0, fields: [name] }] },
      });
      const [part] = gatedParts(await runGate(afterReread(cut()), contextOf(cut()), registryWith(limitIn())));
      expect(part?.result).toBe("stopped");
      expect(part?.stoppedBy).toEqual(oneQuestionOutcome());
    },
  );

  it("a bracket with no number beside it joins nothing: '$40' out of 'raise haircut to $40 (firm)' and '4' out of 'party of 4 (just us)' pass", async () => {
    const wholes = [
      priceChangeRequest("raise haircut to $40 (firm)", usd(4000), "$40"),
      groupRequest(4, "4", "party of 4 (just us)"),
    ];
    for (const request of wholes) {
      expect(await decision({}, request)).toEqual({ result: "pass" });
      const [passed] = gatedParts(await runGate(request, contextOf(request), registryWith(limitIn())));
      expect(passed?.result).toBe("passed");
    }
  });
});

describe("T-1130 by construction, at limit 6 and the gate: every mark but a sentence mark joins (an arrow joins no time), not a list of marks", () => {
  const ny = (utc: string) => at(utc, NEW_YORK);
  const SUNDAY = ny("2026-11-01T04:00:00Z");
  const THURSDAY = ny("2026-11-05T05:00:00Z");
  // [case, the request citing the cut, its field, its fault]
  const cases: [string, () => GateRequest, string, ValueFault][] = [
    [
      "'tomorrow' out of 'can you do _3pm_ tomorrow' (underscore italics)",
      () => haircutMoveRequest(SUNDAY, "tomorrow", "can you do _3pm_ tomorrow"),
      "time_saved",
      "differs",
    ],
    [
      "'tomorrow' out of 'can you do tomorrow {3pm}'",
      () => haircutMoveRequest(SUNDAY, "tomorrow", "can you do tomorrow {3pm}"),
      "time_saved",
      "differs",
    ],
    [
      "'Thursday' out of 'can you do Thursday - 3'",
      () => haircutMoveRequest(THURSDAY, "Thursday", "can you do Thursday - 3"),
      "time_saved",
      "differs",
    ],
    [
      "'tomorrow' out of 'table tomorrow, party of 4, at 7pm'",
      () => haircutMoveRequest(SUNDAY, "tomorrow", "table tomorrow, party of 4, at 7pm"),
      "time_saved",
      "differs",
    ],
    [
      "'$40' out of 'raise haircut to $40 [or $50]'",
      () => priceChangeRequest("raise haircut to $40 [or $50]", usd(4000), "$40"),
      "price",
      "several",
    ],
  ];
  /** The call context of a request's own business. */
  const contextOf = (request: GateRequest) => callContext(turnOf(request).businessId);

  it.each(cases)("%s: limit 6 fails the cut, before and after the re-read", async (_case, cut, name, why) => {
    expect(await decision({}, cut())).toEqual(failed(oneQuestionOutcome(), [[name, why]]));
    expect(await decision({}, afterReread(cut()))).toEqual(failed(oneQuestionOutcome(), [[name, why]]));
  });

  it.each(cases)(
    "%s: at the gate the cut is refused naming the field before the re-read, and one question after it",
    async (_case, cut, name) => {
      expect(await runGate(cut(), contextOf(cut()), registryWith(limitIn()))).toEqual({
        verdict: "refused",
        error: { error: "valueFailsWords", parts: [{ part: 0, fields: [name] }] },
      });
      const [part] = gatedParts(await runGate(afterReread(cut()), contextOf(cut()), registryWith(limitIn())));
      expect(part?.result).toBe("stopped");
      expect(part?.stoppedBy).toEqual(oneQuestionOutcome());
    },
  );

  it("each whole passes at limit 6 and the gate, and '4pm' out of 'move my 3pm -> 4pm' passes as the 4pm said (an arrow reads as 'to')", async () => {
    const wholes = [
      haircutMoveRequest(ny("2026-11-01T20:00:00Z"), "_3pm_ tomorrow", "can you do _3pm_ tomorrow"),
      haircutMoveRequest(ny("2026-11-05T20:00:00Z"), "Thursday - 3", "can you do Thursday - 3"),
      haircutMoveRequest(
        ny("2026-11-02T00:00:00Z"),
        "tomorrow, party of 4, at 7pm",
        "table tomorrow, party of 4, at 7pm",
      ),
      haircutMoveRequest(ny("2026-10-31T20:00:00Z"), "4pm", "can you move my 3pm -> 4pm"),
    ];
    for (const request of wholes) {
      expect(await decision({}, request)).toEqual({ result: "pass" });
      const [passed] = gatedParts(await runGate(request, contextOf(request), registryWith(limitIn())));
      expect(passed?.result).toBe("passed");
    }
  });
});

// T-1130 round 2 (DL-251): round 1's security review found three gaps, and each fix is built from one definition, never
// a list of marks (T-304's do-not-try-again; round 1's CUED list): GAP A, a cue's opening marks are the joining marks
// (times.ts JOINING_MARK), any number of them, with or without a space; GAP B, the time reader and the phrase builder
// share that one definition, so a letter of any script is a letter in both; GAP C, every count the count reader reads
// between a day and a time keeps the day's phrase whole, whatever its digits, and only a count written as a party counts
// as read (which closes N1, "Friday the 13 at 7pm"). Every probe of the review is here, at limit 6 and at the gate, before
// and after the re-read, sent Sat Oct 31 at 10:00am New York, with each whole passing with its own reading or several.

describe("T-1130 round 2: every probe of round 1's security review fails at limit 6 and the gate, before and after the re-read", () => {
  const ny = (utc: string) => at(utc, NEW_YORK);
  const es = { language: "es" } as const;
  const SUNDAY = ny("2026-11-01T04:00:00Z"); // Sun Nov 1 at its start (still EDT)
  const THURSDAY = ny("2026-11-05T05:00:00Z"); // Thu Nov 5 at its start (EST)
  const SUNDAY_3PM = ny("2026-11-01T20:00:00Z");
  const SUNDAY_330PM = ny("2026-11-01T20:30:00Z");
  const SUNDAY_930AM = ny("2026-11-01T14:30:00Z");
  const SUNDAY_NOON = ny("2026-11-01T17:00:00Z");
  const SUNDAY_7PM = ny("2026-11-02T00:00:00Z");
  const THURSDAY_3PM = ny("2026-11-05T20:00:00Z");
  /** A time cut and its whole, both cited out of `words`. */
  const pair = (
    words: string,
    cut: string,
    cutValue: ReturnType<typeof ny>,
    whole: string,
    wholeValue: ReturnType<typeof ny>,
    options: { readonly language?: string } = {},
  ): [() => GateRequest, string, ValueFault, () => GateRequest] => [
    () => haircutMoveRequest(cutValue, cut, words, options),
    "time_saved",
    "differs",
    () => haircutMoveRequest(wholeValue, whole, words, options),
  ];
  /** The day cut out of `words` (read at its start) and the whole, read at `wholeValue`. */
  const sunday = (words: string, whole: string, wholeValue: ReturnType<typeof ny>) =>
    pair(words, "tomorrow", SUNDAY, whole, wholeValue);
  const thursday = (words: string, whole: string) => pair(words, "Thursday", THURSDAY, whole, THURSDAY_3PM);
  /** A count or amount cut out of `words`, and the whole, which is several. */
  const people = (
    words: string,
    cut: string,
    count: number,
    why: ValueFault,
    whole: string,
  ): [() => GateRequest, string, ValueFault, () => GateRequest] => [
    () => groupRequest(count, cut, words),
    "people",
    why,
    () => groupRequest(count, whole, words),
  ];
  const price = (
    words: string,
    whole: string,
  ): [() => GateRequest, string, ValueFault, () => GateRequest] => [
    () => priceChangeRequest(words, usd(4000), "$40"),
    "price",
    "several",
    () => priceChangeRequest(words, usd(4000), whole),
  ];
  // [case, the request citing the cut, its field, its fault, the request citing the whole]
  const cases: [string, () => GateRequest, string, ValueFault, () => GateRequest][] = [
    // GAP A: any joining marks between a cue and its hour, with or without a space.
    [
      "GAP A: 'tomorrow' out of 'can you do tomorrow at »3«'",
      ...sunday("can you do tomorrow at »3«", "tomorrow at »3«", SUNDAY_3PM),
    ],
    [
      "GAP A: 'tomorrow' out of 'can you do tomorrow at ›3‹'",
      ...sunday("can you do tomorrow at ›3‹", "tomorrow at ›3‹", SUNDAY_3PM),
    ],
    [
      "GAP A: 'tomorrow' out of 'can you do tomorrow at ‚3‘'",
      ...sunday("can you do tomorrow at ‚3‘", "tomorrow at ‚3‘", SUNDAY_3PM),
    ],
    [
      "GAP A: 'tomorrow' out of 'can you do tomorrow at 「3」'",
      ...sunday("can you do tomorrow at 「3」", "tomorrow at 「3」", SUNDAY_3PM),
    ],
    [
      "GAP A: 'tomorrow' out of 'can you do tomorrow at ≈3'",
      ...sunday("can you do tomorrow at ≈3", "tomorrow at ≈3", SUNDAY_3PM),
    ],
    [
      "GAP A: 'tomorrow' out of 'can you do tomorrow at ±3'",
      ...sunday("can you do tomorrow at ±3", "tomorrow at ±3", SUNDAY_3PM),
    ],
    [
      "GAP A: 'tomorrow' out of 'can you do tomorrow at #3'",
      ...sunday("can you do tomorrow at #3", "tomorrow at #3", SUNDAY_3PM),
    ],
    [
      "GAP A: 'tomorrow' out of 'can you do tomorrow at ⏰3'",
      ...sunday("can you do tomorrow at ⏰3", "tomorrow at ⏰3", SUNDAY_3PM),
    ],
    [
      "GAP A: 'tomorrow' out of 'can you do tomorrow at: 3'",
      ...sunday("can you do tomorrow at: 3", "tomorrow at: 3", SUNDAY_3PM),
    ],
    ["GAP A: 'tomorrow' out of 'tomorrow at:3'", ...sunday("tomorrow at:3", "tomorrow at:3", SUNDAY_3PM)],
    [
      "GAP A (Spanish): 'mañana' out of 'puedo mañana a las »3«'",
      ...pair("puedo mañana a las »3«", "mañana", SUNDAY, "mañana a las »3«", SUNDAY_3PM, es),
    ],
    // GAP C: every count between a day and a time keeps the phrase whole, whatever its digits.
    [
      "GAP C: 'tomorrow' out of 'can we book tomorrow for 120 at 7pm'",
      ...sunday("can we book tomorrow for 120 at 7pm", "tomorrow for 120 at 7pm", SUNDAY_7PM),
    ],
    [
      "GAP C: 'tomorrow' out of 'table tomorrow for 120 at 7pm'",
      ...sunday("table tomorrow for 120 at 7pm", "tomorrow for 120 at 7pm", SUNDAY_7PM),
    ],
    [
      "GAP C: 'tomorrow' out of 'catering tomorrow for 150 at noon'",
      ...sunday("catering tomorrow for 150 at noon", "tomorrow for 150 at noon", SUNDAY_NOON),
    ],
    [
      "GAP C: 'tomorrow' out of 'can we book tomorrow for 100 at 7pm'",
      ...sunday("can we book tomorrow for 100 at 7pm", "tomorrow for 100 at 7pm", SUNDAY_7PM),
    ],
    [
      "GAP C: 'tomorrow' out of 'tomorrow for 1,200 at noon'",
      ...sunday("tomorrow for 1,200 at noon", "tomorrow for 1,200 at noon", SUNDAY_NOON),
    ],
    [
      "GAP C (Spanish): 'mañana' out of 'mañana para 120 a las 7'",
      ...pair("mañana para 120 a las 7", "mañana", SUNDAY, "mañana para 120 a las 7", SUNDAY_7PM, es),
    ],
    [
      "GAP C's control: 'tomorrow' out of 'can we book tomorrow for 12 at 7pm'",
      ...sunday("can we book tomorrow for 12 at 7pm", "tomorrow for 12 at 7pm", SUNDAY_7PM),
    ],
    [
      "GAP C's control: 'tomorrow' out of 'tomorrow for 100 people at 7pm'",
      ...sunday("tomorrow for 100 people at 7pm", "tomorrow for 100 people at 7pm", SUNDAY_7PM),
    ],
    [
      "GAP C's control: 'tomorrow' out of 'tomorrow for 250 guests at noon'",
      ...sunday("tomorrow for 250 guests at noon", "tomorrow for 250 guests at noon", SUNDAY_NOON),
    ],
    // The review's other probes: a count or an amount glued to a mark or joined by a bracket is several, or noText.
    [
      "'4' out of 'can we get a table for 4 or 5:-)'",
      ...people("can we get a table for 4 or 5:-)", "4", 4, "several", "4 or 5:-)"),
    ],
    ["'4' out of 'table for 4 or 5;)'", ...people("table for 4 or 5;)", "4", 4, "several", "4 or 5;)")],
    ["'4' out of 'table for 4 or 5…'", ...people("table for 4 or 5…", "4", 4, "several", "4 or 5…")],
    [
      "'2 adults' out of '2 adults +1 child'",
      ...people("2 adults +1 child", "2 adults", 2, "several", "2 adults +1 child"),
    ],
    [
      "'4' out of 'table for 4 or 5/6 ppl' ('5/6' joins by 'or' and is no count)",
      ...people("table for 4 or 5/6 ppl", "4", 4, "noText", "4 or 5/6 ppl"),
    ],
    ["'4' out of 'party of 4 (or 5)'", ...people("party of 4 (or 5)", "4", 4, "several", "4 (or 5)")],
    [
      "'$40' out of 'raise haircut to $40 [or $50]'",
      ...price("raise haircut to $40 [or $50]", "$40 [or $50]"),
    ],
    [
      "'$40' out of 'raise haircut to $40 (maybe $50)'",
      ...price("raise haircut to $40 (maybe $50)", "$40 (maybe $50)"),
    ],
    ["'$40' out of 'raise haircut to $40/$50'", ...price("raise haircut to $40/$50", "$40/$50")],
    // The review's other probes: the forms round 1 learned, varied, keep the day's phrase whole.
    [
      "'tomorrow' out of 'tomorrow at 3.5pm'",
      ...sunday("tomorrow at 3.5pm", "tomorrow at 3.5pm", SUNDAY_330PM),
    ],
    ["'tomorrow' out of 'tomorrow at 0930'", ...sunday("tomorrow at 0930", "tomorrow at 0930", SUNDAY_930AM)],
    [
      "'tomorrow' out of 'tomorrow at 3:30:15pm'",
      ...sunday("tomorrow at 3:30:15pm", "tomorrow at 3:30:15pm", SUNDAY_330PM),
    ],
    [
      "'tomorrow' out of 'tomorrow about 3.30'",
      ...sunday("tomorrow about 3.30", "tomorrow about 3.30", SUNDAY_330PM),
    ],
    [
      "'tomorrow' out of 'tomorrow approx. 3.30'",
      ...sunday("tomorrow approx. 3.30", "tomorrow approx. 3.30", SUNDAY_330PM),
    ],
    [
      "'tomorrow' out of 'tomorrow at around 3'",
      ...sunday("tomorrow at around 3", "tomorrow at around 3", SUNDAY_3PM),
    ],
    ["'tomorrow' out of 'tomorrow ~3'", ...sunday("tomorrow ~3", "tomorrow ~3", SUNDAY_3PM)],
    ["'tomorrow' out of 'tomorrow ★3pm★'", ...sunday("tomorrow ★3pm★", "tomorrow ★3pm★", SUNDAY_3PM)],
    ["'tomorrow' out of 'tomorrow | 3pm'", ...sunday("tomorrow | 3pm", "tomorrow | 3pm", SUNDAY_3PM)],
    ["'tomorrow' out of 'tomorrow 👍🏽 3pm'", ...sunday("tomorrow 👍🏽 3pm", "tomorrow 👍🏽 3pm", SUNDAY_3PM)],
    [
      "'tomorrow' out of 'tomorrow, party of 4, at 7pm'",
      ...sunday("tomorrow, party of 4, at 7pm", "tomorrow, party of 4, at 7pm", SUNDAY_7PM),
    ],
    [
      "'tomorrow' out of 'tomorrow for 2 ppl at 7pm'",
      ...sunday("tomorrow for 2 ppl at 7pm", "tomorrow for 2 ppl at 7pm", SUNDAY_7PM),
    ],
    [
      "'tomorrow' out of 'tomorrow for twelve at 7pm'",
      ...sunday("tomorrow for twelve at 7pm", "tomorrow for twelve at 7pm", SUNDAY_7PM),
    ],
    [
      "(Spanish) 'mañana' out of 'mañana para 4 a las 7'",
      ...pair("mañana para 4 a las 7", "mañana", SUNDAY, "mañana para 4 a las 7", SUNDAY_7PM, es),
    ],
    ["'tmr' out of 'tmr. 3pm'", ...pair("tmr. 3pm", "tmr", SUNDAY, "tmr. 3pm", SUNDAY_3PM)],
    ["'Thursday' out of 'Thursday — 3'", ...thursday("Thursday — 3", "Thursday — 3")],
    ["'Thursday' out of 'Thursday [3]'", ...thursday("Thursday [3]", "Thursday [3]")],
    ["'Thursday' out of 'Thursday @ 3'", ...thursday("Thursday @ 3", "Thursday @ 3")],
  ];
  /** The call context of a request's own business. */
  const contextOf = (request: GateRequest) => callContext(turnOf(request).businessId);

  it.each(cases)("%s: limit 6 fails the cut, before and after the re-read", async (_case, cut, name, why) => {
    expect(await decision({}, cut())).toEqual(failed(oneQuestionOutcome(), [[name, why]]));
    expect(await decision({}, afterReread(cut()))).toEqual(failed(oneQuestionOutcome(), [[name, why]]));
  });

  it.each(cases)(
    "%s: at the gate the cut is refused naming the field before the re-read, and one question after it",
    async (_case, cut, name) => {
      expect(await runGate(cut(), contextOf(cut()), registryWith(limitIn()))).toEqual({
        verdict: "refused",
        error: { error: "valueFailsWords", parts: [{ part: 0, fields: [name] }] },
      });
      const [part] = gatedParts(await runGate(afterReread(cut()), contextOf(cut()), registryWith(limitIn())));
      expect(part?.result).toBe("stopped");
      expect(part?.stoppedBy).toEqual(oneQuestionOutcome());
    },
  );

  it.each(cases)(
    "%s: the whole passes with its own reading at limit 6 and the gate, or is several",
    async (_case, _cut, name, why, whole) => {
      const request = whole();
      if (name === "time_saved") {
        expect(await decision({}, request)).toEqual({ result: "pass" });
        expect(await decision({}, afterReread(request))).toEqual({ result: "pass" });
        const [passed] = gatedParts(await runGate(request, contextOf(request), registryWith(limitIn())));
        expect(passed?.result).toBe("passed");
        expect(passed?.limits[5]).toEqual({ limit: 6, result: "pass", outcome: null });
      } else {
        expect(await decision({}, request)).toEqual(failed(oneQuestionOutcome(), [[name, why]]));
        expect(await runGate(request, contextOf(request), registryWith(limitIn()))).toEqual({
          verdict: "refused",
          error: { error: "valueFailsWords", parts: [{ part: 0, fields: [name] }] },
        });
      }
    },
  );

  it("N1: 'Friday the 13 at 7pm' never passes as Fri Nov 6 at 7pm ('the 13' is no party, so it stays unread); 'Friday the 13th at 7pm' passes as Fri Nov 13", async () => {
    const words = "can we do Friday the 13 at 7pm";
    const nov6 = haircutMoveRequest(ny("2026-11-07T00:00:00Z"), "Friday the 13 at 7pm", words);
    const nov13 = haircutMoveRequest(ny("2026-11-14T00:00:00Z"), "Friday the 13 at 7pm", words);
    const friday = haircutMoveRequest(ny("2026-11-06T05:00:00Z"), "Friday", words);
    expect(await decision({}, nov6)).toEqual(failed(oneQuestionOutcome(), [["time_saved", "noText"]]));
    expect(await decision({}, afterReread(nov6))).toEqual(
      failed(oneQuestionOutcome(), [["time_saved", "noText"]]),
    );
    expect(await decision({}, nov13)).toEqual(failed(oneQuestionOutcome(), [["time_saved", "differs"]]));
    expect(await decision({}, friday)).toEqual(failed(oneQuestionOutcome(), [["time_saved", "differs"]]));
    for (const request of [nov6, nov13, friday]) {
      expect(await runGate(request, contextOf(request), registryWith(limitIn()))).toEqual({
        verdict: "refused",
        error: { error: "valueFailsWords", parts: [{ part: 0, fields: ["time_saved"] }] },
      });
      const [part] = gatedParts(
        await runGate(afterReread(request), contextOf(request), registryWith(limitIn())),
      );
      expect(part?.result).toBe("stopped");
      expect(part?.stoppedBy).toEqual(oneQuestionOutcome());
    }
    const ordinal = haircutMoveRequest(
      ny("2026-11-14T00:00:00Z"),
      "Friday the 13th at 7pm",
      "can we do Friday the 13th at 7pm",
    );
    expect(await decision({}, ordinal)).toEqual({ result: "pass" });
  });

  it("the review's wholes pass with their own reading: 'tomorrow at 3.5' (3:30), 'Thursday: 3' and 'table for 5:)'", async () => {
    const wholes = [
      haircutMoveRequest(SUNDAY_330PM, "tomorrow at 3.5", "can you do tomorrow at 3.5"),
      haircutMoveRequest(THURSDAY_3PM, "Thursday: 3", "can we do Thursday: 3"),
      groupRequest(5, "5", "table for 5:)"),
    ];
    for (const request of wholes) {
      expect(await decision({}, request)).toEqual({ result: "pass" });
      const [passed] = gatedParts(await runGate(request, contextOf(request), registryWith(limitIn())));
      expect(passed?.result).toBe("passed");
    }
  });

  it("the count between the day and the time stays the count reader's: '120' out of 'can we book tomorrow for 120 at 7pm' passes as the party", async () => {
    const request = groupRequest(120, "120", "can we book tomorrow for 120 at 7pm");
    expect(await decision({}, request)).toEqual({ result: "pass" });
    const [passed] = gatedParts(await runGate(request, contextOf(request), registryWith(limitIn())));
    expect(passed?.result).toBe("passed");
  });
});

describe("T-1130 round 2, GAP B: a letter of any script is a letter for the time reader and the phrase builder alike", () => {
  const ny = (utc: string) => at(utc, NEW_YORK);
  const es = { language: "es" } as const;
  const SUNDAY = ny("2026-11-01T04:00:00Z");
  const THURSDAY = ny("2026-11-05T05:00:00Z");
  // [case, the text, the same text with an ASCII letter in place of the other script's, the day cited, its start, the
  //  whole cited, the hour the person meant, options]
  const cases: [
    string,
    string,
    string,
    string,
    ReturnType<typeof ny>,
    string,
    ReturnType<typeof ny>,
    { readonly language?: string },
  ][] = [
    [
      "'Thursday ー 3' (the Japanese keyboard's prolonged sound mark, a letter)",
      "can we do Thursday ー 3",
      "can we do Thursday x 3",
      "Thursday",
      THURSDAY,
      "Thursday ー 3",
      ny("2026-11-05T20:00:00Z"),
      {},
    ],
    [
      "'Thursday ｰ 3' (its half-width form)",
      "can we do Thursday ｰ 3",
      "can we do Thursday x 3",
      "Thursday",
      THURSDAY,
      "Thursday ｰ 3",
      ny("2026-11-05T20:00:00Z"),
      {},
    ],
    [
      "'Thursday 下午 3' (a word no reader knows)",
      "can we do Thursday 下午 3",
      "can we do Thursday xx 3",
      "Thursday",
      THURSDAY,
      "Thursday 下午 3",
      ny("2026-11-05T20:00:00Z"),
      {},
    ],
    [
      "'3 ー tomorrow' (the hour first)",
      "can you do 3 ー tomorrow",
      "can you do 3 x tomorrow",
      "tomorrow",
      SUNDAY,
      "3 ー tomorrow",
      ny("2026-11-01T20:00:00Z"),
      {},
    ],
    [
      "(Spanish) 'el jueves ー 3'",
      "puedo el jueves ー 3",
      "puedo el jueves x 3",
      "el jueves",
      THURSDAY,
      "el jueves ー 3",
      ny("2026-11-05T20:00:00Z"),
      es,
    ],
    [
      "'tomorrow morning ー 9' (after a part-of-day word)",
      "can you do tomorrow morning ー 9",
      "can you do tomorrow morning x 9",
      "tomorrow morning",
      SUNDAY,
      "tomorrow morning ー 9",
      ny("2026-11-01T14:00:00Z"),
      {},
    ],
    [
      "'Thursday ー 3' with another time in the text",
      "my 2pm doesn't work. can we do Thursday ー 3?",
      "my 2pm doesn't work. can we do Thursday x 3?",
      "Thursday",
      THURSDAY,
      "Thursday ー 3",
      ny("2026-11-05T20:00:00Z"),
      {},
    ],
  ];
  /** The call context of a request's own business. */
  const contextOf = (request: GateRequest) => callContext(turnOf(request).businessId);

  it.each(cases)(
    "%s: the hour the person meant is refused at limit 6 and the gate, before and after the re-read, since the reader reads no hour across a letter",
    async (_case, words, _ascii, _day, _start, whole, meant, options) => {
      const request = haircutMoveRequest(meant, whole, words, options);
      expect(await decision({}, request)).toEqual(failed(oneQuestionOutcome(), [["time_saved", "differs"]]));
      expect(await decision({}, afterReread(request))).toEqual(
        failed(oneQuestionOutcome(), [["time_saved", "differs"]]),
      );
      expect(await runGate(request, contextOf(request), registryWith(limitIn()))).toEqual({
        verdict: "refused",
        error: { error: "valueFailsWords", parts: [{ part: 0, fields: ["time_saved"] }] },
      });
      const [part] = gatedParts(
        await runGate(afterReread(request), contextOf(request), registryWith(limitIn())),
      );
      expect(part?.result).toBe("stopped");
      expect(part?.stoppedBy).toEqual(oneQuestionOutcome());
    },
  );

  it.each(cases)(
    "%s: the day alone and the whole at the day's start give, at limit 6 and the gate, before and after the re-read, exactly what an ASCII letter in its place gives: the reader's whole phrase, CQ-121's residual (words no reader knows)",
    async (_case, words, ascii, day, start, whole, _meant, options) => {
      const asciiWhole = whole.replace(/ー|ｰ|下午/u, (letter) => (letter === "下午" ? "xx" : "x"));
      const pairs: [GateRequest, GateRequest][] = [
        [haircutMoveRequest(start, day, words, options), haircutMoveRequest(start, day, ascii, options)],
        [
          haircutMoveRequest(start, whole, words, options),
          haircutMoveRequest(start, asciiWhole, ascii, options),
        ],
      ];
      for (const [request, control] of pairs) {
        expect(await decision({}, request)).toEqual(await decision({}, control));
        expect(await decision({}, afterReread(request))).toEqual(await decision({}, afterReread(control)));
        expect(await decision({}, request)).toEqual({ result: "pass" });
        const [passed] = gatedParts(await runGate(request, contextOf(request), registryWith(limitIn())));
        const [controlled] = gatedParts(await runGate(control, contextOf(control), registryWith(limitIn())));
        expect(passed?.result).toBe(controlled?.result);
        const [reread] = gatedParts(
          await runGate(afterReread(request), contextOf(request), registryWith(limitIn())),
        );
        expect(reread?.result).toBe("passed");
      }
    },
  );
});
