// T-300's proofs for the one owner rule evaluator that limit 2 and search share (the card's "Proves it with", the
// evaluator's half), on K-26 v1's own fixtures and rows made in their form:
//   - a $250 minimum fails a $200 service, saying it allows at least $250, and passes $200 plus $60 of extras (the total
//     with extras);
//   - an hourly or at-visit price passes and sets the 'minimum could not be checked' note;
//   - an unknown rule kind is refused, never ignored: K-26's refuse-unknown-rule-kind.json row refuses the whole verdict,
//     whatever the other rules say, in effect or not, in scope or not.
// Also: the registry is K-26 v1's seed, kind for kind; every other kind as its registry entry means it; effective dates
// and the most specific scope; what the verdict holds names no owner's or person's words.

import { describe, expect, it } from "vitest";

import { contractFile, stringsIn } from "../../tool-api/test-support";
import {
  RULE_KINDS,
  RULE_KIND_NAMES,
  evaluateRules,
  isRuleKind,
  readRule,
  type PriceBasis,
  type Proposal,
  type RuleRow,
  type RulesVerdict,
} from "./index";
import {
  BARBERSHOP,
  HOME_SERVICES,
  MINIMUM_250,
  NOTICE_24H,
  NOV_14,
  NOV_2,
  NOW,
  RETURNING,
  SAT_11AM,
  TONIGHT_9PM,
  ZONE,
  countRule,
  datesRule,
  k26Rows,
  k26Values,
  moneyRule,
  onRule,
  proposalOf,
  refusedK26Row,
  ruleRowOf,
  spanRule,
  usd,
} from "./test-support";

/** The broken checks of a verdict; fails the test for any other. */
function brokenOf(verdict: RulesVerdict) {
  if (verdict.result !== "broken") throw new Error(`not broken: ${verdict.result}`);
  return verdict.broken;
}

/** A verdict that holds; fails the test for any other. */
function holdsOf(verdict: RulesVerdict) {
  if (verdict.result !== "holds") throw new Error(`does not hold: ${JSON.stringify(verdict)}`);
  return verdict;
}

/** A proposal at Lee Home Services in flow B with a price. */
const homeServices = (more: Partial<Proposal>): Proposal =>
  proposalOf({ businessId: HOME_SERVICES, flow: "B", ...more });

describe("the closed registry is K-26 v1's", () => {
  it("holds exactly the seed's 16 rule kinds, in order, each with its one value type and the fact it needs", () => {
    const seed = contractFile("db-schema/rules/fixtures/seed-rule-registry.json") as {
      rows: { table: string; values: Record<string, unknown> }[];
    };
    const seeded = seed.rows
      .filter((row) => row.table === "rule_kinds")
      .map(({ values }) => ({ id: values.id, valueType: values.value_type, needsFact: values.needs_fact }));
    expect(seeded).toHaveLength(16);
    expect(
      RULE_KIND_NAMES.map((kind) => ({
        id: kind,
        valueType: RULE_KINDS[kind].valueType,
        needsFact: RULE_KINDS[kind].needsFact,
      })),
    ).toEqual(seeded);
  });

  it("knows no other name, an inherited one included", () => {
    for (const name of ["phone_line", "hours", "toString", "constructor", "__proto__", "Note", ""]) {
      expect(isRuleKind(name)).toBe(false);
    }
  });
});

describe("a $250 minimum, on the booking's total with any extra work (arch 06 line 301)", () => {
  const minimumAt = (basis: PriceBasis, cents: number | null, extras: number[] = []): RulesVerdict =>
    evaluateRules(
      [MINIMUM_250],
      homeServices({ price: { basis, price: cents === null ? null : usd(cents), extras: extras.map(usd) } }),
    );
  const broken = {
    kind: "minimum_job",
    ruleIds: ["rule-lee-home-services-minimum"],
    result: "broken",
    allows: { kind: "minimum", atLeast: usd(25_000) },
  };

  it("fails a $200 service, saying the rule allows at least $250", () => {
    expect(minimumAt("list", 20_000)).toEqual({ result: "broken", broken: [broken], checks: [broken] });
  });

  it("passes $200 plus $60 of extras: the total with extras", () => {
    const holding = { kind: "minimum_job", ruleIds: ["rule-lee-home-services-minimum"], result: "holds" };
    expect(minimumAt("list", 20_000, [6_000])).toEqual({
      result: "holds",
      checks: [holding],
      notes: [],
      ownerOkFirst: false,
    });
  });

  it("adds every extra, and holds at the minimum itself, never a cent under", () => {
    expect(minimumAt("list", 20_000, [3_000, 2_000]).result).toBe("holds");
    expect(minimumAt("list", 25_000).result).toBe("holds");
    expect(brokenOf(minimumAt("list", 20_000, [3_000, 1_999]))).toEqual([broken]);
  });

  it("checks a photo quote when it is priced, never before (A4-05)", () => {
    expect(holdsOf(minimumAt("photoQuote", null)).checks).toEqual([
      {
        kind: "minimum_job",
        ruleIds: ["rule-lee-home-services-minimum"],
        result: "notApplicable",
        why: "notPricedYet",
      },
    ]);
    expect(brokenOf(minimumAt("photoQuote", 20_000))).toEqual([broken]);
    expect(minimumAt("photoQuote", 20_000, [6_000]).result).toBe("holds");
  });

  it("an hourly or at-visit price passes and sets the 'minimum could not be checked' note", () => {
    const noted = {
      kind: "minimum_job",
      ruleIds: ["rule-lee-home-services-minimum"],
      result: "noted",
      note: "minimumNotChecked",
    };
    for (const basis of ["hourly", "atVisit"] as const) {
      for (const cents of [null, 5_000]) {
        expect(minimumAt(basis, cents)).toEqual({
          result: "holds",
          checks: [noted],
          notes: [noted],
          ownerOkFirst: false,
        });
      }
    }
  });

  it("cannot meet the minimum with an amount in another currency (fails closed)", () => {
    const verdict = evaluateRules(
      [MINIMUM_250],
      homeServices({ price: { basis: "list", price: { cents: 30_000, currency: "CAD" }, extras: [] } }),
    );
    expect(brokenOf(verdict)).toEqual([broken]);
  });

  it("does not apply to a proposal that sets no price (a move keeps the price it was made with)", () => {
    expect(holdsOf(evaluateRules([MINIMUM_250], homeServices({ visitAt: SAT_11AM }))).checks).toEqual([
      {
        kind: "minimum_job",
        ruleIds: ["rule-lee-home-services-minimum"],
        result: "notApplicable",
        why: "notInProposal",
      },
    ]);
  });
});

describe("an unknown rule kind is refused, never ignored", () => {
  const phoneLine = refusedK26Row("refuse-unknown-rule-kind.json");
  const refused = {
    result: "refused",
    refused: [{ ruleId: "rule-lees-barbershop-phone-line", kind: "phone_line", why: "unknownKind" }],
  };

  it("K-26's phone-line row refuses the whole verdict, though every other rule holds", () => {
    const rows = [...k26Rows("seed-rules-tap-list.json"), phoneLine];
    const proposal = proposalOf({ visitAt: SAT_11AM, customer: RETURNING });
    expect(holdsOf(evaluateRules(rows.slice(0, -1), proposal)).ownerOkFirst).toBe(false);
    expect(evaluateRules(rows, proposal)).toEqual(refused);
  });

  it("refuses beside a broken rule too, and out of effect, out of scope, or for a proposal with nothing in it", () => {
    const proposal = proposalOf({ visitAt: TONIGHT_9PM });
    expect(evaluateRules([NOTICE_24H, phoneLine], proposal)).toEqual(refused);
    const elsewhere: RuleRow[] = [
      { ...phoneLine, effectiveTo: "2026-10-20T00:00:00Z" },
      { ...phoneLine, effectiveFrom: "2026-12-01T05:00:00Z" },
      { ...phoneLine, flow: "B" },
      { ...phoneLine, kindId: "plumber" },
      { ...phoneLine, businessId: HOME_SERVICES },
    ];
    for (const row of elsewhere) {
      expect(evaluateRules([row], proposal)).toEqual(refused);
      expect(evaluateRules([row], proposalOf())).toEqual(refused);
    }
  });

  it("reads the same row with a registry kind (the fixture's own pass)", () => {
    expect(readRule({ ...phoneLine, ruleKind: "ok_same_day" })).toMatchObject({
      ok: true,
      rule: { id: "rule-lees-barbershop-phone-line", kind: "ok_same_day", value: { type: "on", on: true } },
    });
  });

  it("refuses every row it cannot read: a wrong type, a bad value, a bad scope or bad dates", () => {
    const cases: [RuleRow, string][] = [
      [{ ...NOTICE_24H, valueType: "money" }, "wrongType"],
      [moneyRule("r-1", "notice", 100), "wrongType"],
      [{ ...MINIMUM_250, valueCents: -1 }, "badValue"],
      [{ ...MINIMUM_250, valueCents: 250.5 }, "badValue"],
      [{ ...MINIMUM_250, valueCurrency: "usd" }, "badValue"],
      [{ ...MINIMUM_250, valueCurrency: null }, "badValue"],
      [spanRule("r-2", "notice", 0), "badValue"],
      [countRule("r-3", "no_show_count", 0), "badValue"],
      [onRule("r-4", "ok_same_day", true, { valueOn: null }), "badValue"],
      [datesRule("r-5", "months_offered", "2026-11-01", "2026-11-01"), "badValue"],
      [datesRule("r-6", "months_offered", "2026-02-30", null), "badValue"],
      [datesRule("r-7", "months_offered", "Nov 1", null), "badValue"],
      [{ ...NOTICE_24H, flow: "C" }, "badScope"],
      [{ ...NOTICE_24H, kindId: "Barber Shop" }, "badScope"],
      [{ ...NOTICE_24H, effectiveFrom: "soon" }, "badDates"],
      [{ ...NOTICE_24H, effectiveTo: NOTICE_24H.effectiveFrom }, "badDates"],
    ];
    for (const [row, why] of cases) {
      expect(evaluateRules([row], proposalOf({ visitAt: SAT_11AM }))).toEqual({
        result: "refused",
        refused: [{ ruleId: row.id, kind: row.ruleKind, why }],
      });
    }
  });

  it("names an unknown kind only when it is name-shaped, never other text", () => {
    const odd = { ...phoneLine, ruleKind: "Missed calls go to (555) 010-0177" };
    expect(evaluateRules([odd], proposalOf())).toEqual({
      result: "refused",
      refused: [{ ruleId: "rule-lees-barbershop-phone-line", kind: null, why: "unknownKind" }],
    });
  });
});

describe("every other kind, as its registry entry means it", () => {
  it("notice: a time with less notice is broken, saying the earliest start it allows, in the visit's zone", () => {
    const broken = {
      kind: "notice",
      ruleIds: ["rule-lees-barbershop-notice"],
      result: "broken",
      allows: { kind: "notice", minutes: 1440, from: { utc: "2026-10-24T13:30:04Z", zone: ZONE } },
    };
    expect(brokenOf(evaluateRules([NOTICE_24H], proposalOf({ visitAt: TONIGHT_9PM })))).toEqual([broken]);
    expect(evaluateRules([NOTICE_24H], proposalOf({ visitAt: SAT_11AM })).result).toBe("holds");
  });

  it("months_offered: several ranges add up, and a day in none is broken with every range", () => {
    const spring = datesRule("rule-months-spring", "months_offered", "2026-04-01", "2026-06-01");
    const autumn = datesRule("rule-months-autumn", "months_offered", "2026-09-01", "2026-11-01");
    expect(evaluateRules([spring, autumn], proposalOf({ visitAt: SAT_11AM })).result).toBe("holds");
    expect(brokenOf(evaluateRules([autumn, spring], proposalOf({ visitAt: NOV_14 })))).toEqual([
      {
        kind: "months_offered",
        ruleIds: ["rule-months-autumn", "rule-months-spring"],
        result: "broken",
        allows: {
          kind: "dates",
          days: [
            { from: "2026-04-01", until: "2026-06-01" },
            { from: "2026-09-01", until: "2026-11-01" },
          ],
        },
      },
    ]);
  });

  it("the OK rules never break: Sam's tap list makes a same-day or new customer's booking wait for his OK (A4-98)", () => {
    const tapList = k26Rows("seed-rules-tap-list.json");
    const tonight = holdsOf(
      evaluateRules(tapList, proposalOf({ visitAt: TONIGHT_9PM, customer: RETURNING })),
    );
    expect(tonight.ownerOkFirst).toBe(true);
    expect(tonight.checks).toContainEqual({
      kind: "ok_same_day",
      ruleIds: ["rule-lees-barbershop-ok-same-day"],
      result: "ownerOkFirst",
    });
    expect(
      holdsOf(evaluateRules(tapList, proposalOf({ visitAt: SAT_11AM, customer: RETURNING }))).ownerOkFirst,
    ).toBe(false);
    const newCustomer = { ...RETURNING, isNew: true };
    expect(
      holdsOf(evaluateRules(tapList, proposalOf({ visitAt: SAT_11AM, customer: newCustomer }))).ownerOkFirst,
    ).toBe(true);
    const off = tapList.map((row) => ({ ...row, valueOn: false }));
    expect(
      holdsOf(evaluateRules(off, proposalOf({ visitAt: TONIGHT_9PM, customer: newCustomer }))).ownerOkFirst,
    ).toBe(false);
    const okDates = datesRule("rule-ok-dates", "ok_dates", "2026-10-24", "2026-10-25");
    expect(holdsOf(evaluateRules([okDates], proposalOf({ visitAt: SAT_11AM }))).ownerOkFirst).toBe(true);
    expect(holdsOf(evaluateRules([okDates], proposalOf({ visitAt: NOV_14 }))).ownerOkFirst).toBe(false);
  });

  it("a deposit or fee cap is broken over the cap, saying the most it allows", () => {
    const depositCap = moneyRule("rule-deposit-cap", "deposit_cap", 5_000);
    const feeCap = moneyRule("rule-fee-cap", "fee_cap", 2_500);
    expect(
      evaluateRules([depositCap, feeCap], proposalOf({ deposit: usd(5_000), fee: usd(2_500) })).result,
    ).toBe("holds");
    expect(
      brokenOf(evaluateRules([depositCap, feeCap], proposalOf({ deposit: usd(6_000), fee: usd(3_000) }))),
    ).toEqual([
      {
        kind: "deposit_cap",
        ruleIds: ["rule-deposit-cap"],
        result: "broken",
        allows: { kind: "atMost", of: "deposit", cap: usd(5_000) },
      },
      {
        kind: "fee_cap",
        ruleIds: ["rule-fee-cap"],
        result: "broken",
        allows: { kind: "atMost", of: "fee", cap: usd(2_500) },
      },
    ]);
  });

  it("who may book: own customers only, members who pay elsewhere turned off, and a card after the no-show count", () => {
    const own = onRule("rule-own", "own_customers_only", true);
    const members = onRule("rule-members", "members_paying_elsewhere", false);
    const noShows = countRule("rule-no-shows", "no_show_count", 2);
    const rows = [own, members, noShows];
    expect(evaluateRules(rows, proposalOf({ customer: RETURNING })).result).toBe("holds");
    const stranger = { ...RETURNING, isOwn: false, memberPayingElsewhere: true, noShows: 2 };
    expect(
      brokenOf(evaluateRules(rows, proposalOf({ customer: stranger }))).map((check) => check.allows),
    ).toEqual([
      { kind: "cardToBook", afterNoShows: 2 },
      { kind: "noMembersPayingElsewhere" },
      { kind: "ownCustomersOnly" },
    ]);
    expect(
      brokenOf(evaluateRules(rows, proposalOf({ customer: { ...stranger, cardOnFile: true } }))).map(
        (check) => check.kind,
      ),
    ).toEqual(["members_paying_elsewhere", "own_customers_only"]);
    // Unset, members who pay elsewhere are booked (the registry: "On").
    expect(evaluateRules([], proposalOf({ customer: stranger })).result).toBe("holds");
  });

  it("a note is never enforced, and a setting holds no booking back", () => {
    const note = k26Rows("seed-note-only-rule.json");
    const settings = [
      onRule("rule-waitlist", "waitlist", true),
      onRule("rule-tips", "tip_line", true),
      moneyRule("rule-bank", "bank_transfer_over", 100_000),
      onRule("rule-one-bill", "one_bill", true),
    ];
    const proposal = proposalOf({
      kindId: "barber",
      visitAt: TONIGHT_9PM,
      price: { basis: "list", price: usd(3_500), extras: [] },
      customer: RETURNING,
    });
    expect(holdsOf(evaluateRules([...note, ...settings], proposal)).checks).toEqual([
      { kind: "waitlist", ruleIds: ["rule-waitlist"], result: "notApplicable", why: "setting" },
      { kind: "tip_line", ruleIds: ["rule-tips"], result: "notApplicable", why: "setting" },
      { kind: "bank_transfer_over", ruleIds: ["rule-bank"], result: "notApplicable", why: "setting" },
      { kind: "one_bill", ruleIds: ["rule-one-bill"], result: "notApplicable", why: "setting" },
      { kind: "note", ruleIds: ["rule-lees-barbershop-note-kids-cut"], result: "notApplicable", why: "note" },
    ]);
  });
});

describe("the rules that apply: effective dates and the most specific scope", () => {
  it("a booking follows the rules in effect when it is made: a change closes one row and opens the next (S11-57)", () => {
    const before = { ...MINIMUM_250, effectiveTo: NOV_2 };
    const after = moneyRule("rule-lee-home-services-minimum-2", "minimum_job", 30_000, {
      businessId: HOME_SERVICES,
      effectiveFrom: NOV_2,
    });
    const price = { basis: "list" as const, price: usd(28_000), extras: [] };
    expect(
      evaluateRules([before, after], homeServices({ price, rulesAt: "2026-11-01T15:00:00Z" })).result,
    ).toBe("holds");
    expect(brokenOf(evaluateRules([before, after], homeServices({ price, rulesAt: NOV_2 })))).toEqual([
      {
        kind: "minimum_job",
        ruleIds: ["rule-lee-home-services-minimum-2"],
        result: "broken",
        allows: { kind: "minimum", atLeast: usd(30_000) },
      },
    ]);
    expect(evaluateRules([after], homeServices({ price, rulesAt: NOW })).result).toBe("holds");
  });

  it("with the kind of work and flow known the most specific rule wins; with either unknown, every rule must hold", () => {
    const barbersInB = moneyRule("rule-barbers-flow-b", "minimum_job", 10_000, {
      businessId: HOME_SERVICES,
      flow: "B",
      kindId: "barber",
    });
    const price = { basis: "list" as const, price: usd(20_000), extras: [] };
    const rows = [MINIMUM_250, barbersInB];
    expect(evaluateRules(rows, homeServices({ kindId: "barber", price })).result).toBe("holds");
    expect(
      brokenOf(evaluateRules(rows, homeServices({ kindId: "plumber", price }))).map((c) => c.ruleIds),
    ).toEqual([["rule-lee-home-services-minimum"]]);
    expect(
      brokenOf(evaluateRules(rows, homeServices({ kindId: null, price }))).map((c) => c.ruleIds),
    ).toEqual([["rule-lee-home-services-minimum"]]);
    expect(evaluateRules(rows, homeServices({ flow: "A", kindId: "barber", price })).result).toBe("broken");
  });

  it("a dates kind's ranges add up within one scope only: with the kind of work unknown, each scope's days must hold", () => {
    const business = datesRule("rule-months-business", "months_offered", "2026-04-01", "2026-06-01");
    const barbers = datesRule("rule-months-barbers", "months_offered", "2026-09-01", "2026-11-01", {
      kindId: "barber",
    });
    const rows = [business, barbers];
    expect(evaluateRules(rows, proposalOf({ kindId: "barber", visitAt: SAT_11AM })).result).toBe("holds");
    expect(brokenOf(evaluateRules(rows, proposalOf({ kindId: null, visitAt: SAT_11AM })))).toEqual([
      {
        kind: "months_offered",
        ruleIds: ["rule-months-business"],
        result: "broken",
        allows: { kind: "dates", days: [{ from: "2026-04-01", until: "2026-06-01" }] },
      },
    ]);
    const okDates = datesRule("rule-ok-dates-barbers", "ok_dates", "2026-10-24", "2026-10-25", {
      kindId: "barber",
    });
    expect(
      holdsOf(evaluateRules([okDates], proposalOf({ kindId: null, visitAt: SAT_11AM }))).ownerOkFirst,
    ).toBe(true);
  });

  it("another business's rules never apply", () => {
    expect(
      evaluateRules([NOTICE_24H], proposalOf({ businessId: HOME_SERVICES, visitAt: TONIGHT_9PM })).result,
    ).toBe("holds");
    expect(
      evaluateRules([MINIMUM_250], proposalOf({ price: { basis: "list", price: usd(1), extras: [] } }))
        .result,
    ).toBe("holds");
  });

  it("with no rule at all, every proposal holds", () => {
    expect(evaluateRules([], proposalOf({ visitAt: TONIGHT_9PM }))).toEqual({
      result: "holds",
      checks: [],
      notes: [],
      ownerOkFirst: false,
    });
  });
});

describe("what the evaluator reads and says", () => {
  it("never says the owner's words: the note's and the refused row's words stay out of the verdict", () => {
    const noteValues = k26Values("seed-note-only-rule.json", "rule-lees-barbershop-note-kids-cut");
    const withWords = { ...ruleRowOf(noteValues), words: noteValues.words };
    const verdict = evaluateRules([withWords, NOTICE_24H], proposalOf({ visitAt: TONIGHT_9PM }));
    expect(stringsIn(verdict)).not.toContain(noteValues.words);
    expect(stringsIn(verdict).some((each) => each.includes("parent"))).toBe(false);
  });

  it("throws on a proposal it cannot read, naming no value", () => {
    const bad: Partial<Proposal>[] = [
      { rulesAt: "tonight" },
      { madeAt: "" },
      { visitAt: { utc: "9pm", zone: ZONE } },
      { visitAt: { utc: TONIGHT_9PM.utc, zone: "Lee's Barbershop time" } },
      { businessZone: "Eastern" },
      { price: { basis: "list", price: { cents: 199.5, currency: "USD" }, extras: [] } },
      { deposit: { cents: 100, currency: "dollars" } },
      { customer: { ...RETURNING, noShows: -1 } },
    ];
    for (const more of bad) {
      expect(() => evaluateRules([NOTICE_24H], proposalOf(more))).toThrow(TypeError);
    }
    expect(() => evaluateRules([], proposalOf({ businessZone: "Eastern" }))).toThrow(/business zone/u);
  });

  it("reads each K-26 v1 accepted rules row of the barbershop", () => {
    for (const row of [...k26Rows("seed-rules-tap-list.json"), ...k26Rows("seed-note-only-rule.json")]) {
      expect(row.businessId).toBe(BARBERSHOP);
      expect(readRule(row).ok).toBe(true);
    }
  });
});
