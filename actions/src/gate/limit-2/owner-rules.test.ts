// T-300's proofs (the card's "Proves it with"), on the contracts' own fixtures, with doubles standing in for limit 2's
// ports (the walk, the read of K-26's rules) and for limits 1 and 3 to 6, never for limit 2 or the evaluator:
//   - commit-limit-2-owner-rule.json fails with the rule's allowed range: Alex's "tonight at 9pm" stops at limit 2 with
//     saidWhatRuleAllows, saying the earliest start the barbershop's notice allows, and through the gate the part comes
//     out as the fixture states; nothing is saved;
//   - a $250 minimum fails a $200 service and passes $200 plus $60 of extras (the total with extras);
//   - an hourly or at-visit price passes and sets the 'minimum could not be checked' note;
//   - an unknown rule kind is refused, never ignored: the part is refused and the gate refuses the whole call.
// Round 2 (the lead's ruling, DL-328): a proposal with a list price that has no amount, or a price on a basis none of
// the sources names, never passes limit 2: the evaluator cannot read it and throws, and the gate's call rolls back.
// Also: Sam's S1-02 answer passes with nothing read, as commit-s1-02.json states, and the shipped limit sits in slot 2,
// passes each K-09 gate fixture's S step part and refuses each visit step's until the walk and the rules read are wired
// (fails closed); what it returns holds no person's words.

import { describe, expect, it } from "vitest";

import type { PriceBasis, Proposal } from "../../rules/evaluator";
import {
  HOME_SERVICES,
  MINIMUM_250,
  NOTICE_24H,
  NOV_14,
  SAT_11AM,
  k26Rows,
  priceOf,
  priceOutsideType,
  proposalOf,
  refusedK26Row,
  usd,
} from "../../rules/evaluator/test-support";
import { stringsIn } from "../../tool-api/test-support";
import {
  LimitNotBuiltError,
  partResultOf,
  runGate,
  type GateRequest,
  type GateVerdict,
  type GatedPart,
} from "../framework";
import {
  DECIDED_GATE_FIXTURES,
  callContext,
  fixtureScript,
  gateExchange,
  scriptedLimits,
  wordsIn,
  type LimitCall,
} from "../framework/test-support";
import {
  ALEX,
  BARBERSHOP,
  decidedIn,
  exchangeRequest,
  option,
  partOf,
  requestFor,
  stopRow,
  targetOf,
  turnOf,
} from "../limit-1/test-support";
import { LIMITS } from "../limits";
import { createLimit2, limit2, saidWhatRuleAllowsOutcome, type OwnerRulesDecision } from "./index";
import {
  TONIGHT_AT_9,
  limitIn,
  proposing,
  registryWith,
  rulesFrom,
  walkOf,
  watchedRepo,
  withoutLimit2,
  type RulesAsk,
} from "./test-support";

const LIMIT_2_FIXTURE = "commit-limit-2-owner-rule.json";
/** K-09's stated outcome for limit 2 (K-09 v1 limit2Outcome). */
const SAID_WHAT_RULE_ALLOWS = { limit: 2, outcome: "refuse", action: "saidWhatRuleAllows" } as const;

/** The barbershop's rules: the tap list Sam kept and his note (K-26 v1 seeds), with a 24-hour notice (made up). */
const BARBERSHOP_RULES = [
  ...k26Rows("seed-rules-tap-list.json"),
  ...k26Rows("seed-note-only-rule.json"),
  NOTICE_24H,
];

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

/** The failure of a decision; fails the test for any other. */
function failed(decision: OwnerRulesDecision): Extract<OwnerRulesDecision, { result: "fail" }> {
  if (decision.result !== "fail") throw new Error(`not a failure: ${decision.result}`);
  return decision;
}

/** A new booking Alex picks at Lee Home Services (B4-15's times card, about no booking yet), his text quoted. */
function homeServicesPick(): GateRequest {
  const pick = option("c-b4-15", "oq-b4-15", "B4-15", "Sat Oct 24, 11:00am", targetOf(HOME_SERVICES, null));
  return requestFor({
    who: ALEX,
    businessId: HOME_SERVICES,
    choices: [pick],
    choiceId: "c-b4-15",
    words: "Sat at 11",
  });
}

/** The walk's proposal for that pick, with its price. */
function pickPriced(basis: PriceBasis, cents: number | null, extras: number[] = []): Proposal {
  return proposalOf({
    businessId: HOME_SERVICES,
    flow: "B",
    visitAt: SAT_11AM,
    price: priceOf(basis, cents, extras),
  });
}

describe("commit-limit-2-owner-rule.json fails with the rule's allowed range", () => {
  it("Alex's 'tonight at 9pm' fails with saidWhatRuleAllows, saying the notice allows a start from Sat Oct 24, 9:30am", async () => {
    const request = exchangeRequest(LIMIT_2_FIXTURE);
    const limit = limitIn({ rows: BARBERSHOP_RULES, walk: proposing(TONIGHT_AT_9) });
    const decision = await limit.decide(partOf(request), turnOf(request));
    expect(decision).toEqual({
      result: "fail",
      outcome: SAID_WHAT_RULE_ALLOWS,
      allows: [
        {
          kind: "notice",
          ruleIds: ["rule-lees-barbershop-notice"],
          result: "broken",
          allows: {
            kind: "notice",
            minutes: 1440,
            from: { utc: "2026-10-24T13:30:04Z", zone: "America/New_York" },
          },
        },
      ],
    });
    expect(await limit.check(partOf(request), turnOf(request))).toEqual({
      result: "fail",
      outcome: SAID_WHAT_RULE_ALLOWS,
    });
    expect(saidWhatRuleAllowsOutcome()).toEqual(committedOf(LIMIT_2_FIXTURE).parts[0]?.stoppedBy);
  });

  it("through the gate the part comes out exactly as the fixture states: stopped by limit 2, the later limits not checked", async () => {
    const exchange = gateExchange(LIMIT_2_FIXTURE);
    const calls: LimitCall[] = [];
    const limit = limitIn({ rows: BARBERSHOP_RULES, walk: proposing(TONIGHT_AT_9) });
    const registry = registryWith(limit, withoutLimit2(fixtureScript(exchange)), calls);
    const verdict = await runGate(exchangeRequest(LIMIT_2_FIXTURE), callContext(BARBERSHOP), registry);
    const [part] = gatedParts(verdict);
    expect(part).toBeDefined();
    if (part === undefined) return;
    expect(partResultOf(part)).toEqual(committedOf(LIMIT_2_FIXTURE).parts[0]);
    expect(calls).toEqual([
      { limit: 1, part: 0 },
      { limit: 2, part: 0 },
    ]);
  });

  it("saves nothing: it reads the rules once per run and never touches the call's repo; a repeat answers the same", async () => {
    const request = exchangeRequest(LIMIT_2_FIXTURE);
    const touched: string[] = [];
    const repo = watchedRepo(touched);
    const rulesAsked: RulesAsk[] = [];
    const repos: unknown[] = [];
    const walked: number[] = [];
    const limit = limitIn({
      rows: BARBERSHOP_RULES,
      walk: proposing(TONIGHT_AT_9, walked),
      rulesAsked,
      repos,
    });
    const first = await limit.decide(partOf(request), turnOf(request, repo));
    const again = await limit.decide(partOf(request), turnOf(request, repo));
    expect(again).toEqual(first);
    expect(touched).toEqual([]);
    expect(repos).toHaveLength(2);
    expect(repos.every((each) => each === repo)).toBe(true);
    expect(rulesAsked).toEqual([
      { businessId: BARBERSHOP, at: TONIGHT_AT_9.rulesAt },
      { businessId: BARBERSHOP, at: TONIGHT_AT_9.rulesAt },
    ]);
    expect(walked).toEqual([0, 0]);
  });

  it("what it decides holds none of the turn's words", async () => {
    const request = exchangeRequest(LIMIT_2_FIXTURE);
    const limit = limitIn({ rows: BARBERSHOP_RULES, walk: proposing(TONIGHT_AT_9) });
    const decision = await limit.decide(partOf(request), turnOf(request));
    const words = wordsIn(decidedIn(request));
    expect(words).toContain("tonight at 9pm");
    expect(stringsIn(decision).filter((each) => words.some((word) => each.includes(word)))).toEqual([]);
  });

  it("the shipped limit 2 refuses it, never passes it, while the walk is not built: the gate refuses the call", async () => {
    const request = exchangeRequest(LIMIT_2_FIXTURE);
    expect(await limit2.decide(partOf(request), turnOf(request))).toEqual({
      result: "notBuilt",
      port: "proposals",
    });
    expect(await limit2.check(partOf(request), turnOf(request))).toEqual({ result: "notBuilt" });
    const run = runGate(request, callContext(BARBERSHOP), registryWith(limit2));
    await expect(run).rejects.toBeInstanceOf(LimitNotBuiltError);
    await expect(run).rejects.toMatchObject({ limits: [2] });
  });

  it("an OK rule never refuses: with no notice, the tap list's same-day rule lets tonight's time pass, waiting for Sam's OK", async () => {
    const request = exchangeRequest(LIMIT_2_FIXTURE);
    const rows = [...k26Rows("seed-rules-tap-list.json"), ...k26Rows("seed-note-only-rule.json")];
    const decision = await limitIn({ rows, walk: proposing(TONIGHT_AT_9) }).decide(
      partOf(request),
      turnOf(request),
    );
    expect(decision).toEqual({ result: "pass", why: "rulesHold", notes: [], ownerOkFirst: true });
  });
});

describe("a $250 minimum, on the booking's total with extras, through limit 2", () => {
  it("fails a $200 service, saying the rule allows at least $250", async () => {
    const request = homeServicesPick();
    const limit = limitIn({ rows: [MINIMUM_250], walk: proposing(pickPriced("list", 20_000)) });
    expect(failed(await limit.decide(partOf(request), turnOf(request))).allows).toEqual([
      {
        kind: "minimum_job",
        ruleIds: ["rule-lee-home-services-minimum"],
        result: "broken",
        allows: { kind: "minimum", atLeast: usd(25_000) },
      },
    ]);
    expect(await limit.check(partOf(request), turnOf(request))).toEqual({
      result: "fail",
      outcome: SAID_WHAT_RULE_ALLOWS,
    });
  });

  it("passes $200 plus $60 of extras", async () => {
    const request = homeServicesPick();
    const limit = limitIn({ rows: [MINIMUM_250], walk: proposing(pickPriced("list", 20_000, [6_000])) });
    expect(await limit.decide(partOf(request), turnOf(request))).toEqual({
      result: "pass",
      why: "rulesHold",
      notes: [],
      ownerOkFirst: false,
    });
    expect(await limit.check(partOf(request), turnOf(request))).toEqual({ result: "pass" });
  });

  it("a photo quote is checked once it is priced: before, nothing to hold; priced at $200, it fails", async () => {
    const request = homeServicesPick();
    const unpriced = limitIn({ rows: [MINIMUM_250], walk: proposing(pickPriced("photoQuote", null)) });
    expect(await unpriced.check(partOf(request), turnOf(request))).toEqual({ result: "pass" });
    const priced = limitIn({ rows: [MINIMUM_250], walk: proposing(pickPriced("photoQuote", 20_000)) });
    expect(await priced.check(partOf(request), turnOf(request))).toEqual({
      result: "fail",
      outcome: SAID_WHAT_RULE_ALLOWS,
    });
  });
});

describe("an hourly or at-visit price passes and sets the 'minimum could not be checked' note", () => {
  for (const basis of ["hourly", "atVisit"] as const) {
    it(`${basis}: passes, noting minimumNotChecked for the owner's booking card`, async () => {
      const request = homeServicesPick();
      const limit = limitIn({ rows: [MINIMUM_250], walk: proposing(pickPriced(basis, null)) });
      const note = {
        kind: "minimum_job",
        ruleIds: ["rule-lee-home-services-minimum"],
        result: "noted",
        note: "minimumNotChecked",
      };
      expect(await limit.decide(partOf(request), turnOf(request))).toEqual({
        result: "pass",
        why: "rulesHold",
        notes: [note],
        ownerOkFirst: false,
      });
      expect(await limit.check(partOf(request), turnOf(request))).toEqual({ result: "pass" });
    });
  }
});

describe("a price the evaluator cannot read never passes limit 2 (DL-328)", () => {
  it("a list price with no amount, or a basis none of the sources names, throws at limit 2, never a pass, noted or not", async () => {
    const request = homeServicesPick();
    for (const basis of ["list", "estimate"]) {
      const proposal = proposalOf({
        businessId: HOME_SERVICES,
        flow: "B",
        visitAt: SAT_11AM,
        price: priceOutsideType(basis, null, [30_000]),
      });
      const limit = limitIn({ rows: [MINIMUM_250], walk: proposing(proposal) });
      await expect(limit.decide(partOf(request), turnOf(request))).rejects.toBeInstanceOf(TypeError);
      await expect(limit.check(partOf(request), turnOf(request))).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("through the gate the call rolls back with nothing passed, whatever the business's rules", async () => {
    const request = exchangeRequest(LIMIT_2_FIXTURE);
    const unreadable = proposalOf({ visitAt: NOV_14, price: priceOutsideType("list", null, [30_000]) });
    const calls: LimitCall[] = [];
    const limit = limitIn({ rows: BARBERSHOP_RULES, walk: proposing(unreadable) });
    const run = runGate(request, callContext(BARBERSHOP), registryWith(limit, {}, calls));
    await expect(run).rejects.toBeInstanceOf(TypeError);
    expect(calls).toEqual([
      { limit: 1, part: 0 },
      { limit: 2, part: 0 },
    ]);
  });
});

describe("an unknown rule kind is refused, never ignored", () => {
  const phoneLine = refusedK26Row("refuse-unknown-rule-kind.json");

  it("K-26's phone-line row among the barbershop's rules refuses the part, though every other rule allows the time", async () => {
    const request = exchangeRequest(LIMIT_2_FIXTURE);
    const saturday = proposalOf({ visitAt: { ...SAT_11AM } });
    const allowed = limitIn({ rows: BARBERSHOP_RULES, walk: proposing(saturday) });
    expect(await allowed.check(partOf(request), turnOf(request))).toEqual({ result: "pass" });
    const limit = limitIn({ rows: [...BARBERSHOP_RULES, phoneLine], walk: proposing(saturday) });
    expect(await limit.decide(partOf(request), turnOf(request))).toEqual({
      result: "refused",
      refused: [{ ruleId: "rule-lees-barbershop-phone-line", kind: "phone_line", why: "unknownKind" }],
    });
    expect(await limit.check(partOf(request), turnOf(request))).toEqual({ result: "notBuilt" });
  });

  it("the gate refuses the whole call (notBuilt), so nothing is written and nothing passes", async () => {
    const request = exchangeRequest(LIMIT_2_FIXTURE);
    const limit = limitIn({ rows: [phoneLine], walk: proposing(proposalOf({ visitAt: NOV_14 })) });
    const run = runGate(request, callContext(BARBERSHOP), registryWith(limit));
    await expect(run).rejects.toBeInstanceOf(LimitNotBuiltError);
    await expect(run).rejects.toMatchObject({ limits: [2], parts: [{ result: "refused", refusedBy: 2 }] });
  });
});

describe("what limit 2 checks", () => {
  it("passes Sam's S1-02 answer with no rule read and no walk, as commit-s1-02.json states", async () => {
    const request = exchangeRequest("commit-s1-02.json");
    const rulesAsked: RulesAsk[] = [];
    const limit = createLimit2({ rules: rulesFrom(BARBERSHOP_RULES, rulesAsked) });
    expect(await limit.decide(partOf(request), turnOf(request))).toEqual({
      result: "pass",
      why: "nothingRuled",
      notes: [],
      ownerOkFirst: false,
    });
    expect(rulesAsked).toEqual([]);
    const stated = committedOf("commit-s1-02.json").parts[0]?.limits.find((entry) => entry.limit === 2);
    expect(stated).toEqual({ limit: 2, result: "pass", outcome: null });
    expect(await limit2.check(partOf(request), turnOf(request))).toEqual({ result: "pass" });
  });

  it("the shipped limit passes each K-09 gate fixture's S step part and refuses each visit step's (fails closed)", async () => {
    const expected: Record<(typeof DECIDED_GATE_FIXTURES)[number], string> = {
      "commit-s1-02.json": "pass",
      "commit-limit-1-unproven-sender.json": "pass",
      "commit-limit-2-owner-rule.json": "notBuilt",
      "commit-limit-3-no-exact-yes.json": "pass",
      "commit-limit-4-changed.json": "pass",
      "commit-limit-5-taken.json": "notBuilt",
      "commit-limit-6-reread-first.json": "pass",
      "commit-limit-6-value-fails.json": "pass",
    };
    for (const file of DECIDED_GATE_FIXTURES) {
      const request = exchangeRequest(file);
      expect({ file, verdict: (await limit2.check(partOf(request), turnOf(request))).result }).toEqual({
        file,
        verdict: expected[file],
      });
    }
  });

  it("pass_on and hand_off choose nothing an owner rule governs: notChecked, nothing read", async () => {
    const walked: number[] = [];
    const limit = limitIn({ rows: [NOTICE_24H], walk: proposing(TONIGHT_AT_9, walked) });
    for (const verb of ["pass_on", "hand_off"] as const) {
      const pick = option(
        "c-a7-17",
        "oq-a7-17",
        "A7-17",
        "2 Another time",
        targetOf(BARBERSHOP, "booking-alex-haircut"),
      );
      const request = requestFor({ who: ALEX, choices: [pick], choiceId: "c-a7-17", words: "ask Sam", verb });
      expect(await limit.check(partOf(request), turnOf(request))).toEqual({ result: "notChecked" });
    }
    expect(walked).toEqual([]);
  });

  it("never holds back a change that only protects: a STOP on a booking passes with nothing read", async () => {
    const stop = stopRow();
    const request = requestFor({ who: ALEX, choices: [stop], choiceId: stop.choiceId, words: "STOP" });
    const rulesAsked: RulesAsk[] = [];
    const limit = createLimit2({ rules: rulesFrom([NOTICE_24H], rulesAsked) });
    expect(await limit.decide(partOf(request), turnOf(request))).toMatchObject({
      result: "pass",
      why: "nothingRuled",
    });
    expect(rulesAsked).toEqual([]);
  });

  it("refuses (notBuilt) a proposal at another business than the call's, and one with no rules read wired", async () => {
    const request = exchangeRequest(LIMIT_2_FIXTURE);
    const elsewhere = limitIn({
      rows: [NOTICE_24H],
      walk: proposing(proposalOf({ businessId: HOME_SERVICES, visitAt: NOV_14 })),
    });
    expect(await elsewhere.decide(partOf(request), turnOf(request))).toEqual({
      result: "notBuilt",
      port: "rules",
    });
    const noRules = createLimit2({ proposals: proposing(TONIGHT_AT_9) });
    expect(await noRules.decide(partOf(request), turnOf(request))).toEqual({
      result: "notBuilt",
      port: "rules",
    });
    const unknown = limitIn({ rows: [NOTICE_24H], walk: walkOf(() => ({ kind: "unknown" })) });
    expect(await unknown.check(partOf(request), turnOf(request))).toEqual({ result: "notBuilt" });
  });

  it("sits in slot 2 of the shipped registry, and the gate passes S1-02 through it", async () => {
    expect(LIMITS[1]).toBe(limit2);
    const exchange = gateExchange("commit-s1-02.json");
    const request = exchangeRequest("commit-s1-02.json");
    const calls: LimitCall[] = [];
    const [one, , three, four, five, six] = scriptedLimits(withoutLimit2(fixtureScript(exchange)), calls);
    const verdict = await runGate(request, callContext(BARBERSHOP), [one, limit2, three, four, five, six]);
    const [part] = gatedParts(verdict);
    expect(part?.limits.find((entry) => entry.limit === 2)).toEqual({
      limit: 2,
      result: "pass",
      outcome: null,
    });
    expect(part?.result).toBe("passed");
  });
});
