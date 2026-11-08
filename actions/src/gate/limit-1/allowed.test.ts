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
  askedDeciderOutcome,
  contactsOnFileOver,
  createLimit1,
  limit1,
  proofCodeSentOutcome,
  type AllowedDecision,
  type CodeAsk,
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
  JORDAN,
  NEW_REQUEST,
  PAT,
  RILEY,
  SAM,
  SAM_NEW_MOBILE,
  SAM_NEW_MOBILE_CODE,
  SERVED_UNKNOWN,
  STRANGER,
  TEST_REPO,
  addPayer,
  anotherTime,
  bookingRules,
  callOff,
  chargeTheFee,
  contactChange,
  contactsOf,
  dangerRow,
  deathRow,
  exchangeRequest,
  exportList,
  identityFrom,
  letThemTakeBookings,
  limitIn,
  limitRecord,
  moveVisit,
  newBookingDoor,
  partOf,
  patWith,
  pauseRow,
  pickTime,
  privateBooking,
  proofCodesOf,
  refundBeyondTerms,
  registryWith,
  requestFor,
  someoneElsePays,
  someoneJoins,
  stagesFrom,
  stopRow,
  turnOf,
  whichBooking,
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

describe("every other K-09 gate fixture comes out as it states with the real limit 1 in its slot", () => {
  const reaching = [
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
  it("is slot 1 of the gate's registry, in place of the fail-closed stub", () => {
    expect(LIMITS[0]).toBe(limit1);
    expect(limit1.limit).toBe(1);
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
    });
    const request = ask(ALEX, addPayer(HAIRCUT), "my work pays");
    await expect(broken.check(partOf(request), turnOf(request))).rejects.toThrow("the read broke");
  });

  it("over its own defaults (K-04's links, no K-22 reader, no T-322 codes): a customer's own change passes; the owner's needs a code, which is not built, so the call is refused", async () => {
    const record = limitRecord();
    const limit = createLimit1({ identity: identityFrom(record), stages: stagesFrom(record) });
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
