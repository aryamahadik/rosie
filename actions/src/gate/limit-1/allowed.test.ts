// T-299's proofs (the card's "Proves it with"), on the contracts' own fixtures and the master's own steps, with doubles
// standing in for limit 1's ports (T-308's K-04 reader, S13-45's one rule, T-322's codes) and for limits 2 to 6, never
// for limit 1:
//   - commit-limit-1-unproven-sender.json gives its outcome, and the outcome has no word confirming a booking exists;
//   - a protect-only change (pause, stop texts) from a non-decider passes;
//   - adding a payer from a non-decider fails with a question in the decider's own chat;
//   - fees, refunds beyond the terms, team and settings pass only for the owner or a permitted admin.
// Also: every other K-09 gate fixture comes out as it states with the real limit 1; the one rule comes first, so an
// unproven sender's answer never depends on who decides or whether a booking exists; nobody to ask gives the step's safe
// default; limit 1 checks only what it applies to; what it returns holds no person's words; the shipped limit sits in
// slot 1, fails closed without T-322's codes, and reads only through the call's database (with none, it refuses).
// Round 2 (the lead's rulings on the card, DL-183): a choice about no booking is the sender's own record only at a listed
// customer-side step and the business's anywhere else (S12-24's "3 Let it book" from Sam's new mobile gets the code, as
// S2-22 does; staff, an admin without the power and a customer are refused), search entries alike; a business role with
// no part in a booking decides only its fee or refund, whatever proves the role; nobody to ask gives the safe default.
// Round 3 (DL-188): a step's side is read from its card in the turn's bundle (K-01: who it is from and to), so A10-09's
// "1 Refund it" (a question to the owner) is refused for Alex on his own haircut, for Pat without the money power on her
// own booking and for Sam answering from his new mobile, while Sam on his own mobile and Pat with the money power pass; a
// sender with a part on the booking and a business role is asked which role; A7-02's "The business can't give it" stays
// the business's; a card that cannot be read is the business's; row 1 covers journey 4's customer steps about no booking
// yet and A3-51's meaning-search entries. Three earlier lines changed with the rulings: two tests that build limit 1 from
// partial doubles get the new bundle port's double (stepsOf), and A3-51's entry now passes as row 1 (ruling 2).
// T-1183 (DL-364): K-02 v1.1's sign-up door, as K-09 v1.5's commit-s1-01.json gives it, is anyone's to enter, with no
// proof asked and nothing read; only the door K-02 v1.1 shapes passes, and the setup step after it stays the business's;
// each of K-01's five doors answers as before; a door the gate does not know still answers unknown, then nobodyDecides.

import { describe, expect, it } from "vitest";

import { createIdentityAccess } from "../../domain/identity-access";
import { readerOf } from "../../domain/identity-access/test-support";
import { stringsIn } from "../../tool-api/test-support";
import { createToolApiValidator } from "../../tool-api/validator";
import {
  LIMIT_ACTIONS,
  LimitNotBuiltError,
  partResultOf,
  runGate,
  type Choice,
  type GateRequest,
  type GatedPart,
  type GateVerdict,
} from "../framework";
import { callContext, fixtureScript, gateExchange, type LimitCall } from "../framework/test-support";
import { LIMITS } from "../limits";
import {
  NEW_BOOKING_DOORS,
  NEW_VISIT_STEPS,
  NO_STEP_CARDS,
  OWN_RECORD_STEPS,
  askedDeciderOutcome,
  changeOf,
  contactsOnFileOver,
  createLimit1,
  limit1,
  proofCodeSentOutcome,
  sideOfStep,
  stepCardsOf,
  type AllowedDecision,
  type Change,
  type ChangeReads,
  type CodeAsk,
  type NobodyWhy,
  type OwnAsk,
} from "./index";
import {
  ALEX,
  ALEX_NEW_MOBILE,
  ALEX_PARTNER,
  BARBERSHOP,
  BROTHER,
  EMPLOYER,
  EMPLOYER_PAYS,
  GIFT,
  GIFT_BEING_MADE,
  HAIRCUT,
  HOME_SERVICES,
  HOME_VISIT,
  JORDAN,
  K01_DOORS,
  MASTER_STEP_CARDS,
  NEW_REQUEST,
  NEW_VISIT_CHOICES,
  NOV14,
  PAT,
  PAT_OWN_VISIT,
  RILEY,
  SAM,
  SAM_NEW_MOBILE,
  SAM_NEW_MOBILE_CODE,
  SAM_OWN_CUT,
  SERVED_UNKNOWN,
  SIGN_UP_FIXTURE,
  STRANGER,
  TEST_REPO,
  actsFor,
  addPayer,
  alexChangesThePlan,
  anotherAdult,
  anotherTime,
  askForAPerson,
  bookingRules,
  businessCantGiveIt,
  callOff,
  changeTheReadBack,
  chargeTheFee,
  contactChange,
  contactsOf,
  dangerRow,
  deathRow,
  exchangeRequest,
  exportList,
  identityFrom,
  k01Door,
  lateFee,
  letItBook,
  letThemTakeBookings,
  limitIn,
  limitRecord,
  moveVisit,
  newBookingDoor,
  newContactEntry,
  option,
  partOf,
  patWith,
  pauseRow,
  pickTime,
  privateBooking,
  proofCodesOf,
  reachBy,
  refundBeyondTerms,
  refundIt,
  registryWith,
  requestFor,
  s12Entry,
  s12Options,
  sampleFlowGraph,
  sendThePrice,
  signUpDoor,
  someoneElsePays,
  someoneJoins,
  stagesFrom,
  standIn,
  stepsOf,
  stopRow,
  targetOf,
  turnOf,
  unknownDoor,
  unwalked,
  whichBooking,
  whoItsFor,
  withoutLimit1,
  type Someone,
  type World,
} from "./test-support";

/** Limit 1's decision on part `index` of `request`, in `world`. */
function decision(world: World, request: GateRequest, index = 0): Promise<AllowedDecision> {
  return limitIn(world).decide(partOf(request, index), turnOf(request));
}

/** `who`'s turn picking `choice`, the text's words quoted whole. */
function ask(
  who: Someone,
  choice: Choice,
  words = "yes",
  extra: Partial<Parameters<typeof requestFor>[0]> = {},
) {
  return requestFor({ who, choices: [choice], choiceId: choice.choiceId, words, ...extra });
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

const LIMIT_1_FIXTURE = "commit-limit-1-unproven-sender.json";
const visit = (bookingId: string) => ({ kind: "visit", bookingId }) as const;
const PASS_DECIDER: AllowedDecision = { result: "pass", why: "decider" };
const PASS_PROTECTS: AllowedDecision = { result: "pass", why: "protects" };

/** The wrong person: a question in each named decider's own chat, about these matters. */
function askedOf(deciders: readonly string[], matters: readonly object[]): AllowedDecision {
  return {
    result: "fail",
    why: "notDecider",
    outcome: askedDeciderOutcome(),
    next: { kind: "askDecider", deciders, matters },
  } as AllowedDecision;
}

/** Words that would confirm a booking exists, or point at one. */
const BOOKING_WORDS = /booking|booked|visit|appointment|haircut|cut|nov|oct|sat|:\d\d/i;

describe("commit-limit-1-unproven-sender.json gives its outcome, in words that never confirm a booking exists", () => {
  it("Sam's 'Yes, all of them' to S2-22 from his new mobile: a code to his owner contact on file, waiting; the part is as the fixture states", async () => {
    const exchange = gateExchange(LIMIT_1_FIXTURE);
    const request = exchangeRequest(LIMIT_1_FIXTURE);
    const codeAsked: CodeAsk[] = [];
    const limit = limitIn({ codeAsked });
    const calls: LimitCall[] = [];
    const call = callContext(BARBERSHOP);
    const script = withoutLimit1(fixtureScript(exchange));
    const parts = gatedParts(await runGate(request, call, registryWith(limit, script, calls)));
    const stated = committedOf(LIMIT_1_FIXTURE).parts;
    expect(parts.map((part) => partResultOf(part))).toEqual(stated);
    expect(stated[0]?.stoppedBy).toEqual({
      limit: 1,
      outcome: "wait",
      action: "proofCodeSent",
      proofCodeId: "proof-sam-new-mobile-1",
      openQuestionId: "oq-sam-new-mobile-code",
    });
    expect(calls).toEqual([{ limit: 1, part: 0 }]);
    expect(call.span.limits).toEqual(stated[0]?.limits);
    expect(await limit.decide(partOf(request), turnOf(request))).toEqual({
      result: "fail",
      why: "unproven",
      outcome: proofCodeSentOutcome(SAM_NEW_MOBILE_CODE),
      next: { kind: "proofCode", ...SAM_NEW_MOBILE_CODE },
    });
    // The code goes to Sam's owner contact on file, typed back in the new mobile's own chat (S13-45).
    expect(codeAsked[0]).toEqual({
      businessId: BARBERSHOP,
      forPersonId: "person-sam",
      as: "owner",
      typedBackIn: "handle-sam-new-mobile",
      turnId: "turn-sam-new-mobile-s2-22",
      part: 0,
    });
  });

  it("the outcome, the decision and the code ask name no booking, no visit, and nobody's name or number", async () => {
    const request = exchangeRequest(LIMIT_1_FIXTURE);
    const codeAsked: CodeAsk[] = [];
    const limit = limitIn({ codeAsked });
    const decided = await limit.decide(partOf(request), turnOf(request));
    const verdict = await limit.check(partOf(request), turnOf(request));
    const record = limitRecord();
    const said = [...stringsIn(decided), ...stringsIn(verdict), ...stringsIn(codeAsked)];
    for (const each of said) {
      expect(each).not.toMatch(BOOKING_WORDS);
      expect(each).not.toMatch(/\s/u);
      expect(record.bookings.map((head) => head.id)).not.toContain(each);
      expect(record.privateValues).not.toContain(each);
    }
    expect(said).not.toContain(SAM_NEW_MOBILE.address);
  });

  it("an unproven sender gets the same answer whether or not a booking exists: Alex from a new mobile, on his haircut and on a booking not on file", async () => {
    const asked: CodeAsk[] = [];
    const turnId = "turn-alex-new-mobile-move";
    const onHaircut = await decision(
      { codeAsked: asked },
      ask(ALEX_NEW_MOBILE, anotherTime(HAIRCUT), "2, sat at 2", { turnId }),
    );
    const onNothing = await decision(
      { codeAsked: asked },
      ask(ALEX_NEW_MOBILE, anotherTime("booking-not-on-file"), "2, sat at 2", { turnId }),
    );
    expect(onHaircut).toEqual({
      result: "fail",
      why: "unproven",
      outcome: proofCodeSentOutcome(SAM_NEW_MOBILE_CODE),
      next: { kind: "proofCode", ...SAM_NEW_MOBILE_CODE },
    });
    expect(onNothing).toEqual(onHaircut);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toEqual(asked[0]);
    expect(asked[0]).toMatchObject({
      forPersonId: "person-alex",
      as: "self",
      typedBackIn: ALEX_NEW_MOBILE.handleId,
    });
  });

  it("the one rule comes first: an admin texting from a phone not on file gets the same code with or without the power to decide", async () => {
    const fromNewPhone: Someone = { ...PAT, handleId: "handle-pat-new-mobile", address: "+15555550182" };
    const request = ask(fromNewPhone, bookingRules(), "change the hours", { businessId: HOME_SERVICES });
    const asked: CodeAsk[] = [];
    const withPower = await decision(
      { record: patWith(limitRecord(), "settings"), codeAsked: asked },
      request,
    );
    const without = await decision({ record: limitRecord(), codeAsked: asked }, request);
    expect(withPower).toMatchObject({
      result: "fail",
      why: "unproven",
      outcome: { action: "proofCodeSent" },
    });
    expect(without).toEqual(withPower);
    expect(asked[1]).toEqual(asked[0]);
    expect(asked[0]).toMatchObject({ forPersonId: "person-pat", as: "admin" });
  });
});

describe("a protect-only change from a non-decider passes, on anyone's word", () => {
  const protecting: readonly [string, () => Choice][] = [
    ["stop texts (A7-11)", () => stopRow()],
    ["the pause (A3-48)", () => pauseRow()],
    ["a death report (A7-81)", () => deathRow()],
    ["the private booking, stricter contact (A3-50)", () => privateBooking()],
  ];
  const nonDeciders: readonly [string, Someone][] = [
    ["someone else on Alex's phone", ALEX_PARTNER],
    ["Riley, staff, from his own phone", RILEY],
    ["a number nobody on the record writes from", STRANGER],
    ["Alex from a phone not on file", ALEX_NEW_MOBILE],
  ];

  for (const [what, choiceOf] of protecting) {
    it.each(nonDeciders)(`${what} from %s passes, with no proof asked and no code`, async (_who, who) => {
      const ownAsked: OwnAsk[] = [];
      const codeAsked: CodeAsk[] = [];
      const request = ask(who, choiceOf(), "stop");
      expect(await decision({ ownAsked, codeAsked, proofCodes: null }, request)).toEqual(PASS_PROTECTS);
      expect(ownAsked).toEqual([]);
      expect(codeAsked).toEqual([]);
    });
  }

  it("through the gate: the pause from Riley passes limit 1, and limits 2 to 6 run on it", async () => {
    const calls: LimitCall[] = [];
    const request = ask(RILEY, pauseRow(), "pause him");
    const [part] = gatedParts(
      await runGate(request, callContext(BARBERSHOP), registryWith(limitIn(), {}, calls)),
    );
    expect(part?.result).toBe("passed");
    expect(part?.limits[0]).toEqual({ limit: 1, result: "pass", outcome: null });
    expect(calls.map((each) => each.limit)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("the same non-decider's change that does not only protect fails: Riley moving Alex's haircut is a question in Alex's own chat", async () => {
    expect(await decision({}, ask(RILEY, moveVisit(HAIRCUT), "move alex to 2"))).toEqual(
      askedOf(["person-alex"], [visit(HAIRCUT)]),
    );
  });
});

describe("adding a payer from a non-decider fails with a question in the decider's own chat", () => {
  it("Riley (staff) adds Alex's employer as payer on Alex's haircut: askedDecider, a question in Alex's own chat", async () => {
    expect(await decision({}, ask(RILEY, addPayer(HAIRCUT), "his employer pays"))).toEqual(
      askedOf(["person-alex"], [visit(HAIRCUT)]),
    );
  });

  it("someone else writing from Alex's phone adds a payer: the question goes to Alex", async () => {
    expect(await decision({}, ask(ALEX_PARTNER, addPayer(HAIRCUT), "my work pays"))).toEqual(
      askedOf(["person-alex"], [visit(HAIRCUT)]),
    );
  });

  it("A4-26: Alex, the booker, adds a payer to his brother's booked gift: the question goes to the brother", async () => {
    expect(await decision({}, ask(ALEX, addPayer(GIFT), "my employer pays"))).toEqual(
      askedOf(["person-alex-brother"], [visit(GIFT)]),
    );
  });

  it("A4-55: the payer never decides by paying: the employer adding a payer from its own phone asks Alex", async () => {
    expect(await decision({}, ask(EMPLOYER, addPayer(EMPLOYER_PAYS), "we pay half"))).toEqual(
      askedOf(["person-alex"], [visit(EMPLOYER_PAYS)]),
    );
  });

  it("through the gate: the part stops at limit 1 with askedDecider; limits 2 to 6 are not checked and never called", async () => {
    const calls: LimitCall[] = [];
    const request = ask(RILEY, addPayer(HAIRCUT), "his employer pays");
    const [part] = gatedParts(
      await runGate(request, callContext(BARBERSHOP), registryWith(limitIn(), {}, calls)),
    );
    expect(part).toMatchObject({
      result: "stopped",
      stoppedBy: { limit: 1, outcome: "ask", action: "askedDecider" },
    });
    expect(part?.limits.slice(1).every((entry) => entry.result === "notChecked")).toBe(true);
    expect(calls).toEqual([{ limit: 1, part: 0 }]);
  });

  it("the decider's own yes passes: Alex adds a payer to his own haircut from his own phone, his brother to the gift from his", async () => {
    expect(await decision({}, ask(ALEX, addPayer(HAIRCUT), "my employer pays"))).toEqual(PASS_DECIDER);
    expect(await decision({}, ask(BROTHER, addPayer(GIFT), "my employer pays"))).toEqual(PASS_DECIDER);
  });

  it("while a booking is still being made, its booker goes on making it (S13-45 row 1): once booked, the person served decides", async () => {
    expect(await decision({}, ask(ALEX, pickTime(NEW_REQUEST), "2pm works"))).toEqual(PASS_DECIDER);
    expect(await decision({}, ask(ALEX, someoneElsePays(GIFT_BEING_MADE), "my employer pays"))).toEqual(
      PASS_DECIDER,
    );
    expect(await decision({}, ask(ALEX_PARTNER, pickTime(NEW_REQUEST), "2pm works"))).toEqual(
      askedOf(["person-alex"], [visit(NEW_REQUEST)]),
    );
    expect(await decision({}, ask(ALEX, addPayer(GIFT), "my employer pays"))).toMatchObject({
      why: "notDecider",
    });
  });
});

describe("fees, refunds beyond the terms, team and settings pass only for the owner or a permitted admin", () => {
  const matters: readonly [string, () => Choice, string, object[]][] = [
    ["team: S2-22, let them take bookings (adds authority)", letThemTakeBookings, "team", [{ kind: "team" }]],
    ["team: S11-42, someone joins (adds a person)", someoneJoins, "team", [{ kind: "team" }]],
    ["settings: S11-53, the booking rules", bookingRules, "settings", [{ kind: "settings" }]],
    ["fees: S11-22, charge the late-cancel fee", () => chargeTheFee(), "money", [{ kind: "fee" }]],
    ["refunds beyond the terms: the owner hub's refund", refundBeyondTerms, "money", [{ kind: "refund" }]],
  ];

  describe.each(matters)("%s", (_what, choiceOf, power, asked) => {
    const at = { businessId: HOME_SERVICES };

    it("the owner, from the owner's mobile on file, passes", async () => {
      expect(await decision({}, ask(SAM, choiceOf(), "yes", at))).toEqual(PASS_DECIDER);
    });

    it(`an admin the owner lets (Pat, with the ${power} power) passes`, async () => {
      const record = patWith(limitRecord(), power);
      expect(await decision({ record }, ask(PAT, choiceOf(), "yes", at))).toEqual(PASS_DECIDER);
    });

    it("an admin without that power (Pat, prices only: K-22's seed) gets a question in the owner's own chat", async () => {
      expect(await decision({}, ask(PAT, choiceOf(), "yes", at))).toEqual(askedOf(["person-sam"], asked));
    });

    it("staff (Jordan) and a customer (Alex) get a question in the owner's own chat", async () => {
      expect(await decision({}, ask(JORDAN, choiceOf(), "yes", at))).toEqual(askedOf(["person-sam"], asked));
      expect(await decision({}, ask(ALEX, choiceOf(), "yes", at))).toEqual(askedOf(["person-sam"], asked));
    });
  });

  it("an admin with every power still never exports the customer list (S11-61): only the owner", async () => {
    const record = patWith(limitRecord(), "money", "team", "settings");
    const at = { businessId: HOME_SERVICES };
    expect(await decision({ record }, ask(PAT, exportList(), "export", at))).toEqual(
      askedOf(["person-sam"], [{ kind: "export" }]),
    );
    expect(await decision({ record }, ask(SAM, exportList(), "export", at))).toEqual(PASS_DECIDER);
  });

  it("A7-66's call-off put to the business gives money back: Sam passes; Riley (staff, not on the booking) gets a question in Sam's chat", async () => {
    expect(await decision({}, ask(SAM, callOff(), "1"))).toEqual(PASS_DECIDER);
    expect(await decision({}, ask(RILEY, callOff(), "1"))).toEqual(
      askedOf(["person-sam"], [{ kind: "refund" }]),
    );
  });

  it("with T-321's powers not wired (no AdminPowers), no admin decides, whatever the record holds", async () => {
    const record = patWith(limitRecord(), "money", "team", "settings");
    const limit = createLimit1({
      identity: (_repo, businessId) => createIdentityAccess({ businessId, reader: readerOf(record) }),
      stages: stagesFrom(record),
      contacts: contactsOf(record),
      proofCodes: proofCodesOf(),
    });
    const request = ask(PAT, bookingRules(), "change the hours", { businessId: HOME_SERVICES });
    expect(await limit.decide(partOf(request), turnOf(request))).toEqual(
      askedOf(["person-sam"], [{ kind: "settings" }]),
    );
  });

  it("an owner whose phone is not the owner's mobile on file is not the owner's word: the code (as commit-limit-1 shows)", async () => {
    expect(
      await decision({}, ask(SAM_NEW_MOBILE, bookingRules(), "yes", { businessId: HOME_SERVICES })),
    ).toMatchObject({ result: "fail", why: "unproven", outcome: { action: "proofCodeSent" } });
  });
});

describe("the wrong person, off the chat, and nobody to ask", () => {
  it("off the chat (a page, an AI): an unproven caller's change is a question in the deciders' own chats, never a code", async () => {
    const codeAsked: CodeAsk[] = [];
    for (const caller of ["page", "agent"] as const) {
      expect(await decision({ codeAsked }, ask(ALEX, addPayer(HAIRCUT), "my work pays", { caller }))).toEqual(
        {
          ...askedOf(["person-alex"], [visit(HAIRCUT)]),
          why: "unproven",
        },
      );
    }
    expect(codeAsked).toEqual([]);
  });

  it("a sender nobody on the record is the wrong person: the deciders are asked in their own chats", async () => {
    expect(await decision({}, ask(STRANGER, addPayer(HAIRCUT), "add a payer"))).toEqual(
      askedOf(["person-alex"], [visit(HAIRCUT)]),
    );
  });

  it("a booked visit whose person served is not on the record: nobody decides, and the step's safe default runs", async () => {
    expect(await decision({}, ask(ALEX, addPayer(SERVED_UNKNOWN), "my work pays"))).toEqual({
      result: "fail",
      why: "nobodyDecides",
      outcome: askedDeciderOutcome(),
      next: { kind: "nobodyDecides", why: "servedNotOnRecord", step: "A7-02" },
    });
  });

  it("a question about a booking this business does not hold is nobody's to answer, even for its staff", async () => {
    expect(await decision({}, ask(RILEY, callOff("booking-not-on-file"), "1"))).toEqual({
      result: "fail",
      why: "nobodyDecides",
      outcome: askedDeciderOutcome(),
      next: { kind: "nobodyDecides", why: "bookingNotFound", step: "A7-66" },
    });
  });

  it("a danger row decide entered (only the safety read sets it) has no matter: nobody decides", async () => {
    expect(await decision({}, ask(ALEX, dangerRow(), "help"))).toEqual({
      result: "fail",
      why: "nobodyDecides",
      outcome: askedDeciderOutcome(),
      next: { kind: "nobodyDecides", why: "unknownChange", step: "A3-22" },
    });
  });

  it("a choice at another business than the call's has no decider here, unless it only protects", async () => {
    const elsewhere = {
      ...addPayer(HAIRCUT),
      target: { ...addPayer(HAIRCUT).target, businessId: "biz-yoga-studio" },
    };
    expect(await decision({}, ask(ALEX, elsewhere, "my work pays"))).toMatchObject({
      result: "fail",
      next: { kind: "nobodyDecides", why: "unknownChange" },
    });
    const stopElsewhere = { ...stopRow(), target: { ...stopRow().target, businessId: "biz-yoga-studio" } };
    expect(await decision({}, ask(ALEX, stopElsewhere, "stop"))).toEqual(PASS_PROTECTS);
  });
});

describe("round 2, GAP 1: a choice about no booking is a business matter unless it is the sender's own record at a listed customer-side step", () => {
  const settings = [{ kind: "settings" }];

  it("the reviewer's scenario: Sam's new mobile picks S12-24's '3 Let it book': a code to his owner contact on file, as on S2-22", async () => {
    const codeAsked: CodeAsk[] = [];
    const turnId = "turn-sam-new-mobile-s12-24";
    expect(await decision({ codeAsked }, ask(SAM_NEW_MOBILE, letItBook(), "3", { turnId }))).toEqual({
      result: "fail",
      why: "unproven",
      outcome: proofCodeSentOutcome(SAM_NEW_MOBILE_CODE),
      next: { kind: "proofCode", ...SAM_NEW_MOBILE_CODE },
    });
    // The same code ask as commit-limit-1-unproven-sender.json's S2-22 turn: to Sam as owner, typed back in the new mobile.
    const onS2: CodeAsk[] = [];
    const fixture = exchangeRequest(LIMIT_1_FIXTURE);
    await limitIn({ codeAsked: onS2 }).decide(partOf(fixture), turnOf(fixture));
    expect(onS2[0]).toMatchObject({ forPersonId: "person-sam", as: "owner" });
    expect(codeAsked).toEqual([{ ...onS2[0], turnId }]);
  });

  it("through the gate: the part stops at limit 1 with proofCodeSent and limits 2 to 6 never run", async () => {
    const calls: LimitCall[] = [];
    const request = ask(SAM_NEW_MOBILE, letItBook(), "3");
    const [part] = gatedParts(
      await runGate(request, callContext(BARBERSHOP), registryWith(limitIn(), {}, calls)),
    );
    expect(part).toMatchObject({
      result: "stopped",
      stoppedBy: { limit: 1, outcome: "wait", action: "proofCodeSent", ...SAM_NEW_MOBILE_CODE },
    });
    expect(calls).toEqual([{ limit: 1, part: 0 }]);
  });

  const refused: readonly [string, Someone, string][] = [
    ["a staff member (Riley)", RILEY, BARBERSHOP],
    ["an admin without the settings power (Pat, prices only)", PAT, HOME_SERVICES],
    ["a customer (Alex)", ALEX, BARBERSHOP],
  ];

  it.each(refused)(
    "S12-24's options offered to %s are refused: a question in the owner's own chat",
    async (_who, who, businessId) => {
      for (const choice of s12Options(businessId)) {
        expect(
          await decision({}, ask(who, choice, choice.label, { businessId, choices: s12Options(businessId) })),
        ).toEqual(askedOf(["person-sam"], settings));
      }
    },
  );

  it("S12-24 passes for the owner from his mobile on file, and for an admin the owner lets with the settings power", async () => {
    expect(await decision({}, ask(SAM, letItBook(), "3"))).toEqual(PASS_DECIDER);
    const at = { businessId: HOME_SERVICES };
    const record = patWith(limitRecord(), "settings");
    expect(await decision({ record }, ask(PAT, letItBook(HOME_SERVICES), "3", at))).toEqual(PASS_DECIDER);
    const otherPowers = patWith(limitRecord(), "money", "team");
    expect(await decision({ record: otherPowers }, ask(PAT, letItBook(HOME_SERVICES), "3", at))).toEqual(
      askedOf(["person-sam"], settings),
    );
  });

  it("a sender nobody on the record offered S12-24 gets a question in the owner's own chat", async () => {
    expect(await decision({}, ask(STRANGER, letItBook(), "3"))).toEqual(askedOf(["person-sam"], settings));
  });

  it("over the shipped defaults (K-04's links, no K-22 reader, no T-322 codes), S12-24 passes for nobody", async () => {
    const record = limitRecord();
    const limit = createLimit1({ identity: identityFrom(record), stages: stagesFrom(record) });
    for (const who of [SAM, SAM_NEW_MOBILE, RILEY]) {
      const request = ask(who, letItBook(), "3");
      expect(await limit.decide(partOf(request), turnOf(request))).toEqual({
        result: "notBuilt",
        port: "proofCodes",
      });
    }
    const fromAlex = ask(ALEX, letItBook(), "3");
    expect(await limit.decide(partOf(fromAlex), turnOf(fromAlex))).toEqual(askedOf(["person-sam"], settings));
  });

  it("N1: a meaning-search entry about no booking at an S12 step follows the same rule", async () => {
    expect(await decision({}, ask(SAM_NEW_MOBILE, s12Entry(), "someone keeps booking"))).toMatchObject({
      result: "fail",
      why: "unproven",
      outcome: { action: "proofCodeSent" },
    });
    for (const who of [RILEY, ALEX, STRANGER]) {
      expect(await decision({}, ask(who, s12Entry(), "someone keeps booking"))).toEqual(
        askedOf(["person-sam"], settings),
      );
    }
    expect(await decision({}, ask(SAM, s12Entry(), "someone keeps booking"))).toEqual(PASS_DECIDER);
  });

  it("any step on neither list is the business's too: A3-30's read-back K-01 marks for the owner, and A3-51's meaning-search entry, with no booking", async () => {
    expect(await decision({}, ask(RILEY, changeTheReadBack(), "3"))).toEqual(
      askedOf(["person-sam"], settings),
    );
    expect(await decision({}, ask(SAM, changeTheReadBack(), "3"))).toEqual(PASS_DECIDER);
    // Round 3 (DL-188 ruling 2): A3-51's meaning-search entries are S13-45 row 1, open to anyone.
    expect(await decision({}, ask(ALEX, askForAPerson(), "can riley call me"))).toEqual({
      result: "pass",
      why: "anyone",
    });
  });

  it("the lists: customer-side steps that write the sender's own person or handle rows; a new visit's times cards and pick (row 1)", () => {
    expect([...OWN_RECORD_STEPS].sort()).toEqual(["A4-23", "A4-82", "A7-98", "B4-25", "B4-93", "B7-88"]);
    expect([...NEW_VISIT_STEPS].sort()).toEqual([
      "A4-14",
      "A4-15",
      "A4-33",
      "A4-62",
      "A4-68",
      "B4-15",
      "B4-16",
      "B4-84",
      "B4-85",
      "B4-89",
    ]);
  });

  it("row 1 at a new visit's times: a time picked about no booking yet passes on anyone's word, with no proof asked, as commit-limit-5-taken.json states", async () => {
    for (const who of [ALEX, ALEX_NEW_MOBILE, ALEX_PARTNER, STRANGER]) {
      const ownAsked: OwnAsk[] = [];
      expect(await decision({ ownAsked, proofCodes: null }, ask(who, pickTime(null), "2pm works"))).toEqual({
        result: "pass",
        why: "anyone",
      });
      expect(ownAsked).toEqual([]);
    }
  });

  it("at a listed step it is the sender's own record: from their own phone it passes; from a phone not on file, the code", async () => {
    for (const choice of [reachBy("Texts only"), newContactEntry()]) {
      expect(await decision({}, ask(ALEX, choice, "texts only please"))).toEqual(PASS_DECIDER);
      const asked: CodeAsk[] = [];
      expect(
        await decision({ codeAsked: asked }, ask(ALEX_NEW_MOBILE, choice, "texts only please")),
      ).toMatchObject({ result: "fail", why: "unproven", outcome: { action: "proofCodeSent" } });
      expect(asked[0]).toMatchObject({ forPersonId: "person-alex", as: "self" });
    }
  });
});

describe("round 2, N2: a business role with no part in a booking decides only its fee or refund beyond the terms", () => {
  const adding: readonly [string, (bookingId: string) => Choice][] = [
    ["a person (A4-24's 'Another adult')", (bookingId) => anotherAdult(bookingId)],
    ["a payer (A4-24's 'Someone else pays')", someoneElsePays],
    ["a way in (A4-82's 'Email')", (bookingId) => reachBy("Email", bookingId)],
    ["authority (A4-24's 'An adult the booker acts for')", actsFor],
    ["nothing its stakes name (A7-17's '1 The stand-in instead')", standIn],
  ];

  it.each(adding)(
    "adding %s to Alex's haircut, from Riley (staff) or Sam (owner), each proven in their role by a stand-in reader: a question in Alex's own chat",
    async (_what, choiceOf) => {
      for (const [who, role] of [
        [RILEY, "staff"],
        [SAM, "owner"],
      ] as const) {
        const ownAsked: OwnAsk[] = [];
        expect(await decision({ ownAsked }, ask(who, choiceOf(HAIRCUT), "yes"))).toEqual(
          askedOf(["person-alex"], [visit(HAIRCUT)]),
        );
        // The stand-in reader (the role's own contact on file, as T-321's K-22 reader will be) proved the role.
        expect(ownAsked).toEqual([
          {
            businessId: BARBERSHOP,
            personId: who.personId,
            as: role,
            caller: "turn",
            handleId: who.handleId,
          },
        ]);
      }
    },
  );

  it("an admin the owner lets with every power (Pat at Lee Home Services) adds no person to a customer's booking there", async () => {
    const record = patWith(limitRecord(), "money", "team", "settings");
    const request = ask(PAT, anotherAdult(HOME_VISIT, HOME_SERVICES), "yes", { businessId: HOME_SERVICES });
    expect(await decision({ record }, request)).toEqual(askedOf(["person-alex"], [visit(HOME_VISIT)]));
  });

  it("the booking's fee stays the business's: S11-25's late fee passes for Sam; Riley and Alex himself get a question in Sam's chat", async () => {
    expect(await decision({}, ask(SAM, lateFee(HAIRCUT), "1"))).toEqual(PASS_DECIDER);
    for (const who of [RILEY, ALEX]) {
      expect(await decision({}, ask(who, lateFee(HAIRCUT), "1"))).toEqual(
        askedOf(["person-sam"], [{ kind: "fee" }]),
      );
    }
  });

  it("an unknown stake may be a fee, a refund and the visit: nobody holds all three, so the step's safe default", async () => {
    for (const who of [SAM, RILEY]) {
      expect(await decision({}, ask(who, unwalked(HAIRCUT), "3"))).toEqual({
        result: "fail",
        why: "nobodyDecides",
        outcome: askedDeciderOutcome(),
        next: { kind: "nobodyDecides", why: "nobodyAllowed", step: "A7-17" },
      });
    }
  });
});

describe("round 2, N4: nobody to ask gives the step's safe default, never a question to nobody", () => {
  const safeDefault = (why: NobodyWhy, step: string): AllowedDecision => ({
    result: "fail",
    why: "nobodyDecides",
    outcome: askedDeciderOutcome(),
    next: { kind: "nobodyDecides", why, step },
  });

  it("a sender nobody on the record, at an own-record step: nobody's record to change, so the safe default", async () => {
    expect(await decision({}, ask(STRANGER, reachBy("Texts only"), "texts only"))).toEqual(
      safeDefault("noSender", "A4-82"),
    );
  });

  it("a sender nobody on the record, on a booking nobody decides or this business does not hold: the safe default", async () => {
    expect(await decision({}, ask(STRANGER, addPayer(SERVED_UNKNOWN), "add a payer"))).toEqual(
      safeDefault("servedNotOnRecord", "A7-02"),
    );
    expect(await decision({}, ask(STRANGER, anotherTime("booking-not-on-file"), "2"))).toEqual(
      safeDefault("bookingNotFound", "A7-17"),
    );
  });

  it("off the chat, an unproven caller with nobody to ask: the safe default too", async () => {
    expect(
      await decision({}, ask(ALEX, addPayer(SERVED_UNKNOWN), "my work pays", { caller: "page" })),
    ).toEqual(safeDefault("servedNotOnRecord", "A7-02"));
  });

  it("no decision ever asks nobody", async () => {
    const requests = [
      ask(STRANGER, letItBook(), "3"),
      ask(STRANGER, reachBy("Email"), "email"),
      ask(STRANGER, addPayer(HAIRCUT), "add a payer"),
      ask(STRANGER, addPayer(SERVED_UNKNOWN), "add a payer"),
      ask(ALEX, addPayer(SERVED_UNKNOWN), "my work pays", { caller: "agent" }),
      ask(RILEY, unwalked(HAIRCUT), "3"),
      ask(RILEY, callOff("booking-not-on-file"), "1"),
    ];
    for (const request of requests) {
      const decided = await decision({}, request);
      if (decided.result === "fail" && decided.next.kind === "askDecider") {
        expect(decided.next.deciders.length).toBeGreaterThan(0);
      }
    }
  });
});

/** Two roles fit: a question in the sender's own chat, which role (DL-188 ruling 1; S13-31), never a pass. */
function askedWhich(personId: string, matters: readonly object[]): AllowedDecision {
  return {
    result: "fail",
    why: "twoRoles",
    outcome: askedDeciderOutcome(),
    next: { kind: "askWhichRole", personId, matters },
  } as AllowedDecision;
}

describe("round 3, ruling 1: a step's side comes from its card in the turn's bundle (K-01), and the business's step stays the business's whoever answers", () => {
  const refund = [{ kind: "refund" }];
  const settings = [{ kind: "settings" }];
  const homeServices = { businessId: HOME_SERVICES };

  it("the reviewer's scenario 1: Alex picks A10-09's '1 Refund it' (a question K-01 sends to the owner) on his own haircut: a question in Sam's own chat", async () => {
    expect(await decision({}, ask(ALEX, refundIt(HAIRCUT), "1 refund it"))).toEqual(
      askedOf(["person-sam"], refund),
    );
  });

  it("scenario 2: Pat, an admin without the money power, offered it about her own booking through S11-18: a question in Sam's chat; with the money power, asked which role, never passed", async () => {
    const request = ask(PAT, refundIt(PAT_OWN_VISIT, HOME_SERVICES), "1", homeServices);
    expect(await decision({}, request)).toEqual(askedOf(["person-sam"], refund));
    const record = patWith(limitRecord(), "money");
    expect(await decision({ record }, request)).toEqual(askedWhich("person-pat", refund));
  });

  it("scenario 3: Sam, the person served on his own shop's booking, from his new mobile: the code to his owner contact on file; from his owner mobile, asked which role, never passed", async () => {
    const codeAsked: CodeAsk[] = [];
    const turnId = "turn-sam-new-mobile-a10-09";
    expect(
      await decision({ codeAsked }, ask(SAM_NEW_MOBILE, refundIt(SAM_OWN_CUT), "1", { turnId })),
    ).toEqual({
      result: "fail",
      why: "unproven",
      outcome: proofCodeSentOutcome(SAM_NEW_MOBILE_CODE),
      next: { kind: "proofCode", ...SAM_NEW_MOBILE_CODE },
    });
    expect(codeAsked).toEqual([
      {
        businessId: BARBERSHOP,
        forPersonId: "person-sam",
        as: "owner",
        typedBackIn: SAM_NEW_MOBILE.handleId,
        turnId,
        part: 0,
      },
    ]);
    expect(await decision({}, ask(SAM, refundIt(SAM_OWN_CUT), "1"))).toEqual(
      askedWhich("person-sam", refund),
    );
  });

  it("it passes for Sam on his own mobile and for Pat with the money power, on a booking neither plays a part on; staff, and Pat without the power, get a question in Sam's chat", async () => {
    expect(await decision({}, ask(SAM, refundIt(HAIRCUT), "1"))).toEqual(PASS_DECIDER);
    const request = ask(PAT, refundIt(HOME_VISIT, HOME_SERVICES), "1", homeServices);
    expect(await decision({ record: patWith(limitRecord(), "money") }, request)).toEqual(PASS_DECIDER);
    expect(await decision({ record: patWith(limitRecord(), "settings", "team") }, request)).toEqual(
      askedOf(["person-sam"], refund),
    );
    expect(await decision({}, ask(RILEY, refundIt(HAIRCUT), "1"))).toEqual(askedOf(["person-sam"], refund));
  });

  it("through the gate: scenario 1 stops at limit 1 with askedDecider, and limits 2 to 6 never run", async () => {
    const calls: LimitCall[] = [];
    const request = ask(ALEX, refundIt(HAIRCUT), "1");
    const [part] = gatedParts(
      await runGate(request, callContext(BARBERSHOP), registryWith(limitIn(), {}, calls)),
    );
    expect(part).toMatchObject({
      result: "stopped",
      stoppedBy: { limit: 1, outcome: "ask", action: "askedDecider" },
    });
    expect(calls).toEqual([{ limit: 1, part: 0 }]);
  });

  it("the hub case A7-02 'The business can't give it' stays the business's (its branch leads to A7-15, a question to the owner): Alex is refused; Sam passes", async () => {
    expect(await decision({}, ask(ALEX, businessCantGiveIt(HAIRCUT), "the barber cant make it"))).toEqual(
      askedOf(["person-sam"], settings),
    );
    expect(await decision({}, ask(SAM, businessCantGiveIt(HAIRCUT), "riley is out sick"))).toEqual(
      PASS_DECIDER,
    );
  });

  it("a hub case whose every step is the customer's stays the booking's visit: 'Alex changes the plan' passes for Alex; Riley's is a question in Alex's chat", async () => {
    expect(await decision({}, ask(ALEX, alexChangesThePlan(HAIRCUT), "can i move it"))).toEqual(PASS_DECIDER);
    expect(await decision({}, ask(RILEY, alexChangesThePlan(HAIRCUT), "alex wants to move it"))).toEqual(
      askedOf(["person-alex"], [visit(HAIRCUT)]),
    );
  });

  it("any step whose card cannot be read is the business's: with no bundle read (the shipped default) or a bundle without the step, Alex's own choices are questions in Sam's chat", async () => {
    for (const steps of [NO_STEP_CARDS, stepCardsOf([])]) {
      expect(await decision({ steps }, ask(ALEX, anotherTime(NOV14), "2, sat at 2"))).toEqual(
        askedOf(["person-sam"], settings),
      );
      expect(await decision({ steps }, ask(ALEX, addPayer(HAIRCUT), "my work pays"))).toEqual(
        askedOf(["person-sam"], [{ kind: "fee" }]),
      );
      expect(await decision({ steps }, ask(ALEX, whoItsFor(null), "its for me"))).toEqual(
        askedOf(["person-sam"], settings),
      );
    }
  });

  it("the side is read from who the step is from and to: the owner's or staff's steps are the business's; the customer's, anyone else's and Rosie's alone are the customer's", async () => {
    const sides: Record<string, string> = {};
    for (const step of ["A10-09", "A7-66", "A7-14", "A3-30", "A7-17", "A4-80", "A4-55", "A4-01", "A7-02"]) {
      sides[step] = sideOfStep(step, await MASTER_STEP_CARDS.step(step));
    }
    expect(sides).toEqual({
      "A10-09": "business",
      "A7-66": "business",
      "A7-14": "business",
      "A3-30": "business",
      "A7-17": "customer",
      "A4-80": "customer",
      "A4-55": "customer",
      "A4-01": "customer",
      "A7-02": "customer",
    });
    // Every S1, S2, S11, S12 and S13 step is the business's, whatever its card says.
    const customerCard = { id: "x", section: 12, who: "cust", to: "san", branches: [] } as const;
    for (const step of ["S1-02", "S2-22", "S11-25", "S12-24", "S13-45"]) {
      expect(sideOfStep(step, { ...customerCard, id: step })).toBe("business");
    }
  });
});

describe("round 3, ruling 2: row 1 covers every customer step of booking a new visit before the booking exists, and the new-booking door's meaning-search entries", () => {
  it.each(NEW_VISIT_CHOICES)(
    "%s, about no booking yet: passes on anyone's word, with no proof asked",
    async (_what, choiceOf) => {
      for (const who of [ALEX, ALEX_NEW_MOBILE, ALEX_PARTNER, STRANGER]) {
        const ownAsked: OwnAsk[] = [];
        const choice = choiceOf();
        const request = ask(who, choice, "yes", { businessId: choice.target.businessId });
        expect(await decision({ ownAsked, proofCodes: null }, request)).toEqual({
          result: "pass",
          why: "anyone",
        });
        expect(ownAsked).toEqual([]);
      }
    },
  );

  it("A3-51's meaning-search entry (closest-entries.json's 'Asks for a person') passes on anyone's word, even with no bundle read", async () => {
    expect([...NEW_BOOKING_DOORS].sort()).toEqual(["A3-51", "B3-40"]);
    for (const who of [ALEX, STRANGER, RILEY]) {
      for (const steps of [MASTER_STEP_CARDS, NO_STEP_CARDS]) {
        expect(
          await decision({ steps, proofCodes: null }, ask(who, askForAPerson(), "can i talk to someone")),
        ).toEqual({
          result: "pass",
          why: "anyone",
        });
      }
    }
  });

  it("a journey 4 step K-01 sends to the owner is not row 1: A4-09's '1 Send it' about no booking yet is a question in Sam's chat; Sam passes", async () => {
    expect(await decision({}, ask(ALEX, sendThePrice(), "send it"))).toEqual(
      askedOf(["person-sam"], [{ kind: "settings" }]),
    );
    expect(await decision({}, ask(SAM, sendThePrice(), "1"))).toEqual(PASS_DECIDER);
  });

  it("row 1 is about no booking yet: on a booking being made, A4-80 is its visit (Alex goes on making it; someone else on his phone is a question to him)", async () => {
    expect(await decision({}, ask(ALEX, whoItsFor(NEW_REQUEST), "its for me"))).toEqual(PASS_DECIDER);
    expect(await decision({}, ask(ALEX_PARTNER, whoItsFor(NEW_REQUEST), "its for me"))).toEqual(
      askedOf(["person-alex"], [visit(NEW_REQUEST)]),
    );
  });

  it("what adds a way in or a name to the sender's own record is not row 1: A4-82 stays their own record, the code from a phone not on file", async () => {
    expect(
      await decision({}, ask(ALEX_NEW_MOBILE, reachBy("Texts only"), "texts only please")),
    ).toMatchObject({ result: "fail", why: "unproven", outcome: { action: "proofCodeSent" } });
  });
});

describe("round 3: the step cards read from K-01 v1 flow graphs (stepCardsOf)", () => {
  it("reads who it is from and to, its section and its branches from K-01's own sample bundle (bundle-mini-a.json)", async () => {
    const cards = stepCardsOf([sampleFlowGraph("bundle-mini-a.json", "A")]);
    expect(await cards.step("S1-37")).toEqual({
      id: "S1-37",
      section: 1,
      who: "owner",
      to: "san",
      branches: [],
    });
    const door = await cards.step("A3-51");
    expect(door).toMatchObject({ id: "A3-51", section: 3, who: "san", to: null });
    expect(door?.branches.map((branch) => branch.label)).toContain("Asks for a person");
    expect(sideOfStep("A3-51", door ?? null)).toBe("customer");
    expect(sideOfStep("S1-37", await cards.step("S1-37"))).toBe("business");
  });

  it("a value that is not K-01's graph, a step value without its own id, or a step of the other flow gives no card", async () => {
    const graph = {
      contract: "bundle.v1",
      flow: "A",
      steps: { "A7-66": { id: "A7-66", who: "owner", to: "san" } },
    };
    expect(await stepCardsOf([graph]).step("A7-66")).toMatchObject({ who: "owner", to: "san" });
    expect(await stepCardsOf([{ ...graph, contract: "bundle.v2" }]).step("A7-66")).toBeNull();
    expect(await stepCardsOf([{ ...graph, flow: "B" }]).step("A7-66")).toBeNull();
    expect(
      await stepCardsOf([{ ...graph, steps: { "A7-66": { id: "A7-17", who: "cust", to: "san" } } }]).step(
        "A7-66",
      ),
    ).toBeNull();
    expect(await stepCardsOf([null, "flow", graph]).step("A7-66")).toMatchObject({ who: "owner" });
    expect(
      sideOfStep(
        "A7-66",
        await stepCardsOf([{ ...graph, steps: { "A7-66": { id: "A7-66" } } }]).step("A7-66"),
      ),
    ).toBe("business");
  });
});

describe("limit 1 checks only what it applies to", () => {
  it("a question passed on and a hand-off change nothing on the record: not checked", async () => {
    for (const verb of ["pass_on", "hand_off"] as const) {
      expect(await decision({}, ask(STRANGER, addPayer(HAIRCUT), "can you ask sam", { verb }))).toEqual({
        result: "notChecked",
      });
    }
  });

  it("the 'which booking?' pick changes nothing: not checked", async () => {
    expect(await decision({}, ask(ALEX_PARTNER, whichBooking(), "the haircut"))).toEqual({
      result: "notChecked",
    });
  });

  it("the door for a new booking is open to anyone (S13-45 row 1), with no proof asked", async () => {
    const ownAsked: OwnAsk[] = [];
    expect(
      await decision({ ownAsked, proofCodes: null }, ask(STRANGER, newBookingDoor(), "a haircut please")),
    ).toEqual({ result: "pass", why: "anyone" });
    expect(ownAsked).toEqual([]);
  });

  it("the contact-change row adds a way in: the person's own chat passes; from a phone not on file, the code", async () => {
    expect(await decision({}, ask(ALEX, contactChange(), "use my email"))).toEqual(PASS_DECIDER);
    expect(await decision({}, ask(ALEX_NEW_MOBILE, contactChange(), "use this number"))).toMatchObject({
      result: "fail",
      why: "unproven",
      outcome: { action: "proofCodeSent" },
    });
  });
});

describe("T-1183: K-02 v1.1's sign-up door is anyone's to enter, and every other door answers as before (DL-364)", () => {
  /** changeOf's reads, which no door needs: each fails the test if asked. */
  const NO_READS: ChangeReads = {
    identity: () => {
      throw new Error("a door's change reads no decider");
    },
    steps: () => {
      throw new Error("a door's change reads no step card");
    },
  };
  const SAMS_TEXT = "Hi, I want to put my barbershop on Rosie";
  const ANYONE: Change = { kind: "anyone" };
  const PASS_ANYONE: AllowedDecision = { result: "pass", why: "anyone" };
  const NOBODY_DECIDES: AllowedDecision = {
    result: "fail",
    why: "nobodyDecides",
    outcome: askedDeciderOutcome(),
    next: { kind: "nobodyDecides", why: "unknownChange", step: "S1-01" },
  };
  const business = (kind: "settings" | "team"): Change => ({
    kind: "decided",
    matters: [{ kind }],
    inRole: false,
    twoRoles: false,
  });

  it("commit-s1-01.json's part: Sam entering the sign-up door changes no existing record, so anyone may; limit 1 passes it with no proof asked and nothing read, as the fixture states", async () => {
    const request = exchangeRequest(SIGN_UP_FIXTURE);
    expect(await changeOf(partOf(request), turnOf(request), NO_READS)).toEqual(ANYONE);
    const ownAsked: OwnAsk[] = [];
    const codeAsked: CodeAsk[] = [];
    expect(await decision({ ownAsked, codeAsked }, request)).toEqual(PASS_ANYONE);
    expect([ownAsked, codeAsked]).toEqual([[], []]);
    // The shipped limit, over a repo that is no database: a part that needed a read would be refused (notBuilt).
    expect(await limit1.decide(partOf(request), turnOf(request, TEST_REPO))).toEqual(PASS_ANYONE);
    expect(await limit1.check(partOf(request), turnOf(request, TEST_REPO))).toEqual({ result: "pass" });
    expect(committedOf(SIGN_UP_FIXTURE).parts[0]?.limits[0]).toEqual({
      limit: 1,
      result: "pass",
      outcome: null,
    });
  });

  it("whoever writes it: a number nobody on the record writes from, a customer, staff, or the owner from a phone not proven; no code is sent", async () => {
    for (const who of [STRANGER, ALEX, RILEY, SAM_NEW_MOBILE]) {
      const codeAsked: CodeAsk[] = [];
      const passed = await decision({ codeAsked }, ask(who, signUpDoor(), SAMS_TEXT));
      expect({ who: who.handleId, passed, codeAsked }).toEqual({
        who: who.handleId,
        passed: PASS_ANYONE,
        codeAsked: [],
      });
    }
  });

  it("only the door as K-02 v1.1 shapes it: one on a booking, with a stake or a field, or at another business, is nobody's to decide (fails closed)", async () => {
    const door = signUpDoor();
    const variants: [string, Choice][] = [
      ["on a booking", { ...door, target: { ...door.target, bookingId: HAIRCUT } }],
      [
        "with a stake",
        { ...door, stakes: "high", stakesFrom: [{ why: "charge", step: "S1-27", ref: null }] },
      ],
      ["carrying a field", { ...door, fields: [{ name: "kinds", type: "text" }] }],
      [
        "at another business",
        { ...door, target: { ...door.target, businessId: HOME_SERVICES, businessName: "Lee Home Services" } },
      ],
    ];
    for (const [variant, choice] of variants) {
      const request = ask(SAM, choice, SAMS_TEXT);
      expect({
        variant,
        change: await changeOf(partOf(request), turnOf(request), NO_READS),
        decided: await decision({}, request),
      }).toEqual({ variant, change: { kind: "unknown" }, decided: NOBODY_DECIDES });
    }
  });

  it("each of K-01's five doors answers as it did before: the new-booking, booking-already-made and unclear-owner doors are anyone's; the owner-command and team doors are the business's settings and team", async () => {
    const answers = [];
    for (const [door, step] of K01_DOORS) {
      const fromSam = ask(SAM, k01Door(door, step), "yes");
      answers.push({
        door,
        change: await changeOf(partOf(fromSam), turnOf(fromSam), NO_READS),
        sam: await decision({}, fromSam),
        alex: await decision({}, ask(ALEX, k01Door(door, step), "yes")),
      });
    }
    expect(answers).toEqual([
      { door: "newBooking", change: ANYONE, sam: PASS_ANYONE, alex: PASS_ANYONE },
      { door: "existingBooking", change: ANYONE, sam: PASS_ANYONE, alex: PASS_ANYONE },
      {
        door: "ownerCommand",
        change: business("settings"),
        sam: PASS_DECIDER,
        alex: askedOf(["person-sam"], [{ kind: "settings" }]),
      },
      {
        door: "teamChange",
        change: business("team"),
        sam: PASS_DECIDER,
        alex: askedOf(["person-sam"], [{ kind: "team" }]),
      },
      { door: "unclearOwnerOrHelp", change: ANYONE, sam: PASS_ANYONE, alex: PASS_ANYONE },
    ]);
  });

  it("a door the gate does not know still answers unknown, then nobodyDecides: the step's safe default, with no question to anyone", async () => {
    for (const who of [SAM, ALEX, STRANGER]) {
      const request = ask(who, unknownDoor(), "yes");
      expect({
        who: who.handleId,
        change: await changeOf(partOf(request), turnOf(request), NO_READS),
        decided: await decision({}, request),
      }).toEqual({ who: who.handleId, change: { kind: "unknown" }, decided: NOBODY_DECIDES });
    }
  });

  it("the door decides nothing for an existing business: S1-02's answer after it stays the business's settings, so a sender who is not its owner is asked of the owner, never passed", async () => {
    const kinds = option("c-s1-02", "oq-s1-02-sam-1", "S1-02", "All on the list", targetOf(BARBERSHOP, null));
    for (const who of [ALEX, STRANGER]) {
      expect(await decision({}, ask(who, kinds, "Barbershop"))).toEqual(
        askedOf(["person-sam"], [{ kind: "settings" }]),
      );
    }
  });
});

describe("every other K-09 gate fixture comes out as it states with the real limit 1 in its slot", () => {
  const reaching = [
    SIGN_UP_FIXTURE,
    "commit-s1-02.json",
    "commit-limit-2-owner-rule.json",
    "commit-limit-3-no-exact-yes.json",
    "commit-limit-4-changed.json",
    "commit-limit-5-taken.json",
    "commit-limit-6-value-fails.json",
  ];

  it.each(reaching)("%s: limit 1 passes, and every part is as the fixture states", async (file) => {
    const request = exchangeRequest(file);
    const script = withoutLimit1(fixtureScript(gateExchange(file)));
    const parts = gatedParts(
      await runGate(request, callContext(BARBERSHOP), registryWith(limitIn(), script)),
    );
    const stated = committedOf(file).parts;
    expect(parts.map((part, index) => partResultOf(part, stated[index]?.gives ?? []))).toEqual(stated);
    expect(stated.every((part) => part.limits[0]?.result === "pass")).toBe(true);
  });

  it("commit-limit-6-reread-first.json: limit 1 passes, then the gate refuses with valueFailsWords as stated", async () => {
    const file = "commit-limit-6-reread-first.json";
    const exchange = gateExchange(file);
    const request = exchangeRequest(file);
    const verdict = await runGate(
      request,
      callContext(BARBERSHOP),
      registryWith(limitIn(), fixtureScript(exchange)),
    );
    expect(verdict).toEqual({ verdict: "refused", error: exchange.outcome });
  });
});

describe("what limit 1 returns holds no person's words, name or number", () => {
  it("decisions and verdicts name labels, ids and steps only", async () => {
    const requests = [
      exchangeRequest(LIMIT_1_FIXTURE),
      ask(RILEY, addPayer(HAIRCUT), "Alex's employer Lee Tile pays"),
      ask(ALEX, addPayer(SERVED_UNKNOWN), "my boss pays"),
      ask(PAT, bookingRules(), "open at 7 on Mondays", { businessId: HOME_SERVICES }),
      ask(ALEX_PARTNER, stopRow(), "STOP texting this phone"),
    ];
    const record = limitRecord();
    const limit = limitIn({ record });
    for (const request of requests) {
      const decided = await limit.decide(partOf(request), turnOf(request));
      const said = stringsIn(decided);
      const words = stringsIn(request.input.kind === "decided" ? request.input.decided.context.texts : []);
      for (const each of said) {
        expect(each).not.toMatch(/\s/u);
        expect(words).not.toContain(each);
        expect(record.privateValues).not.toContain(each);
      }
      for (const someone of [SAM, ALEX, RILEY, PAT, EMPLOYER]) {
        expect(said).not.toContain(someone.address);
        expect(said).not.toContain(someone.name);
      }
    }
  });
});

describe("the default one rule (contactsOnFileOver)", () => {
  const record = limitRecord();
  const contacts = contactsOnFileOver(() =>
    createIdentityAccess({ businessId: BARBERSHOP, reader: readerOf(record) }),
  );
  const base = { businessId: BARBERSHOP, caller: "turn" } as const;

  it("as a customer: a turn's handle K-04 links to the person proves them; another handle does not", async () => {
    expect(
      await contacts.isOwn({ ...base, personId: "person-alex", as: "self", handleId: ALEX.handleId }),
    ).toBe(true);
    expect(
      await contacts.isOwn({
        ...base,
        personId: "person-alex",
        as: "self",
        handleId: ALEX_NEW_MOBILE.handleId,
      }),
    ).toBe(false);
  });

  it("a business role needs its own mobile or email on file (K-22), which has no reader yet: never proven here", async () => {
    for (const as of ["owner", "admin", "staff"] as const) {
      expect(await contacts.isOwn({ ...base, personId: "person-sam", as, handleId: SAM.handleId })).toBe(
        false,
      );
    }
  });

  it("a page's session and an AI's token are not read yet: never proven here", async () => {
    for (const caller of ["page", "agent", "console", "job"] as const) {
      expect(
        await contacts.isOwn({
          ...base,
          caller,
          personId: "person-alex",
          as: "self",
          handleId: ALEX.handleId,
        }),
      ).toBe(false);
    }
  });
});

describe("the shipped limit 1", () => {
  it("is slot 1 of the gate's registry, whole behind the record flags check, in place of the fail-closed stub", async () => {
    const slot = LIMITS[0];
    expect(slot.limit).toBe(1);
    expect(limit1.limit).toBe(1);
    // The slot keeps limit 1's own decide, with limit 1's type (compared with ===: the lint forbids handing an unbound
    // method to expect).
    const decide: typeof limit1.decide = slot.decide;
    expect(decide === limit1.decide).toBe(true);
    expect(typeof slot.flags).toBe("function");
    // A protect-only part (no flag can hold it, nothing to read): the slot's verdict is limit 1's own, a pass.
    const request = ask(ALEX_PARTNER, stopRow(), "stop");
    const verdict = await slot.check(partOf(request), turnOf(request, TEST_REPO));
    expect(verdict).toEqual(await limit1.check(partOf(request), turnOf(request, TEST_REPO)));
    expect(verdict).toEqual({ result: "pass" });
  });

  it("passes a protect-only change with nothing read: stop texts from Alex's phone", async () => {
    const request = ask(ALEX_PARTNER, stopRow(), "stop");
    expect(await limit1.check(partOf(request), turnOf(request, TEST_REPO))).toEqual({ result: "pass" });
  });

  it("reads only through the call's database: with any other repo a part that needs a decider is refused (notBuilt), so the gate refuses the call", async () => {
    const request = ask(ALEX, addPayer(HAIRCUT), "my work pays");
    expect(await limit1.decide(partOf(request), turnOf(request, TEST_REPO))).toEqual({
      result: "notBuilt",
      port: "database",
    });
    expect(await limit1.check(partOf(request), turnOf(request, TEST_REPO))).toEqual({ result: "notBuilt" });
    await expect(runGate(request, callContext(BARBERSHOP), registryWith(limit1))).rejects.toBeInstanceOf(
      LimitNotBuiltError,
    );
  });

  it("any other throw of its ports still fails the whole call: it is never answered as a pass or a refusal", async () => {
    const record = limitRecord();
    const broken = createLimit1({
      identity: identityFrom(record),
      stages: () => ({ stageOf: () => Promise.reject(new Error("the read broke")) }),
      contacts: contactsOf(record),
      steps: stepsOf(),
    });
    const request = ask(ALEX, addPayer(HAIRCUT), "my work pays");
    await expect(broken.check(partOf(request), turnOf(request))).rejects.toThrow("the read broke");
  });

  it("over its own defaults (K-04's links, no K-22 reader, no T-322 codes): a customer's own change passes; the owner's needs a code, which is not built, so the call is refused", async () => {
    const record = limitRecord();
    const limit = createLimit1({
      identity: identityFrom(record),
      stages: stagesFrom(record),
      steps: stepsOf(),
    });
    const own = ask(ALEX, addPayer(HAIRCUT), "my work pays");
    expect(await limit.decide(partOf(own), turnOf(own))).toEqual(PASS_DECIDER);
    const settings = ask(SAM, bookingRules(), "change the hours", { businessId: HOME_SERVICES });
    expect(await limit.decide(partOf(settings), turnOf(settings))).toEqual({
      result: "notBuilt",
      port: "proofCodes",
    });
    expect(await limit.check(partOf(settings), turnOf(settings))).toEqual({ result: "notBuilt" });
    await expect(runGate(settings, callContext(HOME_SERVICES), registryWith(limit))).rejects.toBeInstanceOf(
      LimitNotBuiltError,
    );
  });

  it("answers only K-09 v1's limit 1 outcomes, each with the kind its action has, as gateAndCommit's answer allows", async () => {
    for (const outcome of [proofCodeSentOutcome(SAM_NEW_MOBILE_CODE), askedDeciderOutcome()]) {
      expect(outcome.limit).toBe(1);
      expect(LIMIT_ACTIONS[1][outcome.action]).toBe(outcome.outcome);
    }
    // Riley's payer, stopped by limit 1, in commit-limit-1's answer: K-09 v1's gateAndCommit response accepts it.
    const request = ask(RILEY, addPayer(HAIRCUT), "his employer pays");
    const [part] = gatedParts(await runGate(request, callContext(BARBERSHOP), registryWith(limitIn())));
    if (part === undefined) throw new Error("no part");
    const answer = structuredClone(committedOf(LIMIT_1_FIXTURE));
    answer.parts = [partResultOf(part)];
    expect(createToolApiValidator().check("gateAndCommit", "response", answer)).toEqual([]);
  });

  it("a proof code port answering a code without its ids fails the call (fail closed)", async () => {
    const request = exchangeRequest(LIMIT_1_FIXTURE);
    const limit = limitIn({ proofCodes: proofCodesOf([], { proofCodeId: "", openQuestionId: "oq-1" }) });
    await expect(limit.check(partOf(request), turnOf(request))).rejects.toThrow(TypeError);
  });
});
