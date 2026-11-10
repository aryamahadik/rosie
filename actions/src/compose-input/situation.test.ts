// The situation tag (C-090, T-309; arch 07 line 357): the signals and their order, as the line lists them.

import { describe, expect, it } from "vitest";

import { barberSource, therapistSource } from "../finalize/claim-check/test-support";
import { VOCABULARY } from "../finalize/slots";
import { MONEY_SLOTS, SIGNAL_TAGS, SITUATIONS, sensitiveOn, signalsOf, situationOf } from "./index";

describe("the tag order: the first that fits wins (arch 07 line 357)", () => {
  it("a row about a death is gentle even when it also names money: a refund and an amount", () => {
    expect(situationOf(["refund", "amount", "deathReport"])).toBe("gentle");
    expect(
      situationOf(signalsOf({ safetyOutcomes: [], about: ["fee", "deathReport"] }, false, ["pay.back"])),
    ).toBe("gentle");
  });

  it("lists the tags in the line's order: gentle, problem, money or consent, then routine", () => {
    expect(SITUATIONS).toStrictEqual(["gentle", "problem", "moneyOrConsent", "routine"]);
  });

  it("tags each signal as the line lists it", () => {
    expect(SIGNAL_TAGS).toStrictEqual({
      safetyOutcome: "gentle",
      deathReport: "gentle",
      sensitiveSwitch: "gentle",
      gettingWorse: "problem",
      paymentProblem: "problem",
      complaint: "problem",
      damage: "problem",
      lateness: "problem",
      businessCannotMakeIt: "problem",
      platformFailure: "problem",
      readBack: "moneyOrConsent",
      charge: "moneyOrConsent",
      refund: "moneyOrConsent",
      fee: "moneyOrConsent",
      amount: "moneyOrConsent",
    });
  });

  it("puts gentle before a problem, a problem before money or consent, and routine last", () => {
    expect(situationOf(["paymentProblem", "sensitiveSwitch"])).toBe("gentle");
    expect(situationOf(["charge", "safetyOutcome"])).toBe("gentle");
    expect(situationOf(["fee", "lateness"])).toBe("problem");
    expect(situationOf(["readBack", "complaint", "amount"])).toBe("problem");
    expect(situationOf(["readBack"])).toBe("moneyOrConsent");
    expect(situationOf(["amount"])).toBe("moneyOrConsent");
    expect(situationOf([])).toBe("routine");
  });
});

describe("what fits a row (signalsOf)", () => {
  it("a safety outcome other than No fits gentle; No alone does not", () => {
    expect(signalsOf({ safetyOutcomes: ["No"], about: [] }, false, [])).toStrictEqual([]);
    expect(signalsOf({ safetyOutcomes: ["No", "Emergency now"], about: [] }, false, [])).toStrictEqual([
      "safetyOutcome",
    ]);
    expect(signalsOf({ safetyOutcomes: ["Unsure"], about: [] }, false, [])).toStrictEqual(["safetyOutcome"]);
  });

  it("the sensitive switch, on in the slot source or in the record's live switches", () => {
    expect(sensitiveOn(therapistSource())).toBe(true);
    expect(sensitiveOn(barberSource())).toBe(false);
    const source = barberSource();
    const record = source.record;
    if (record === null) throw new Error("the barber source reads a record");
    expect(sensitiveOn({ ...source, record: { ...record, switches: ["sensitive"] } })).toBe(true);
    expect(signalsOf({ safetyOutcomes: [], about: [] }, true, [])).toStrictEqual(["sensitiveSwitch"]);
  });

  it("an amount, when a slot the input names is money; each signal once", () => {
    expect(signalsOf({ safetyOutcomes: [], about: [] }, false, ["day", "visit.time"])).toStrictEqual([]);
    expect(
      signalsOf({ safetyOutcomes: [], about: [] }, false, ["pay.price", "price", "link.pay"]),
    ).toStrictEqual(["amount"]);
    expect(
      signalsOf({ safetyOutcomes: ["Unsure", "Unsure"], about: ["refund", "refund"] }, true, ["due"]),
    ).toStrictEqual(["safetyOutcome", "sensitiveSwitch", "refund", "amount"]);
  });
});

describe("the money slots", () => {
  it("hold every amount of K-03's vocabulary, the record's money rows, the pay link's deadline, the $2 line and the pay link", () => {
    for (const slot of VOCABULARY.filter((each) => each.valueType === "money")) {
      expect(MONEY_SLOTS.has(slot.name)).toBe(true);
    }
    for (const slot of VOCABULARY.filter((each) => each.name.startsWith("pay."))) {
      expect(MONEY_SLOTS.has(slot.name)).toBe(true);
    }
    for (const slot of ["clock.pay", "two.count", "link.pay"]) expect(MONEY_SLOTS.has(slot)).toBe(true);
  });

  it("hold nothing else: no name, time, place, code or other link", () => {
    for (const slot of [
      "svc.intext",
      "alex.staff",
      "day",
      "visit.time",
      "visit.place",
      "visit.code",
      "link.secure",
    ]) {
      expect(MONEY_SLOTS.has(slot)).toBe(false);
    }
    expect([...MONEY_SLOTS].every((slot) => VOCABULARY.some((each) => each.name === slot))).toBe(true);
  });
});
