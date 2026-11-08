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
