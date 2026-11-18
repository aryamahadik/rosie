// T-1459's proofs (the card's "Proves it with"; DL-961, the architect's ruling on the second turn, card A): default 14 in
// allowed.ts, on K-09 v1.5's own turn 2 (commit-s1-02.json: Sam's answer to S1-02's question, "Barbershop, plumbing,
// electrical") with Sam as the signer before S1-75, who holds no role yet (ADR-013 section 4), and doubles of limit 1's
// ports (T-308's K-04 reader, S13-45's one rule, T-322's codes, default 14's stored facts), never of limit 1:
//   - a role-less signer's S1-02 answer to the question sent on that handle, with control not proven, passes;
//   - it fails as today for another person on the same handle; the same person on another handle; a question sent on
//     another handle or at another business; a question that is not live or has not gone out; control proven (with no
//     role); a money or team choice, an owner-only or a live step; a step outside S1; and each of the three facts
//     missing or unreadable. "As today" is the part's answer with nothing stored for default 14 to read, and each case
//     also names that answer outright;
//   - the sign-up door and a customer's own record answer as before, with no fact of default 14 read. Every earlier limit
//     1 test is unchanged: allowed.test.ts is not touched.
// Numbers are the seeds' own 555-01xx ones; no model call, no network and no database (the integration case is pg/).

import { describe, expect, it } from "vitest";

import { stringsIn } from "../../tool-api/test-support";
import {
  partResultOf,
  runGate,
  type Choice,
  type GateRequest,
  type GatedPart,
  type GateVerdict,
} from "../framework";
import { callContext, fixtureScript, gateExchange } from "../framework/test-support";
import type { AskedQuestion } from "../limit-3/facts";
import {
  LIVE_STEPS,
  askedDeciderOutcome,
  createLimit1,
  type AllowedDecision,
  type CodeAsk,
  type OwnAsk,
} from "./index";
import {
  ALEX,
  ALEX_NEW_MOBILE,
  BARBERSHOP,
  HAIRCUT,
  HOME_SERVICES,
  NOTHING_STORED,
  S1_02_QUESTION,
  SAM,
  SAM_HELPER,
  SAM_NEW_MOBILE,
  SECOND_TURN_FIXTURE,
  SIGN_UP_FIXTURE,
  STRANGER,
  TEST_REPO,
  doorOf,
  exchangeRequest,
  hubCase,
  identityFrom,
  limitIn,
  limitRecord,
  option,
  partOf,
  reachBy,
  registryWith,
  requestFor,
  s1_02Asked,
  searchEntry,
  secondTurnFrom,
  signUpDoor,
  signUpRecord,
  signUpsOf,
  stagesFrom,
  stepsOf,
  targetOf,
  turnOf,
  withoutLimit1,
  type SignUpRead,
  type SignUpWorld,
  type Someone,
  type World,
} from "./test-support";

/** Limit 1's decision on part 0 of `request`, with default 14's stored facts as `facts` gives them (over signUpRecord). */
function decided(facts: SignUpWorld, request: GateRequest, world: World = {}): Promise<AllowedDecision> {
  return limitIn({ record: signUpRecord(), ...world, signUps: facts }).decide(
    partOf(request),
    turnOf(request),
  );
}

/** The same part with nothing stored for default 14 to read: as limit 1 answered it before T-1459. */
function asBefore(request: GateRequest, world: World = {}): Promise<AllowedDecision> {
  return decided(NOTHING_STORED, request, world);
}

/** `who`'s turn choosing `choice` with `words`, at the barbershop unless `extra` says otherwise. */
function ask(
  who: Someone,
  choice: Choice,
  words = "1",
  extra: Partial<Parameters<typeof requestFor>[0]> = {},
): GateRequest {
  return requestFor({ who, choices: [choice], choiceId: choice.choiceId, words, ...extra });
}

/** Sam's open question at `step` under `openQuestionId`, stored as S1-02's is (s1_02Asked), live; `over` changes more. */
function storedAt(step: string, openQuestionId: string, over: Partial<AskedQuestion> = {}): SignUpWorld {
  return { questions: [{ asked: s1_02Asked({ openQuestionId, step, ...over }), live: true }] };
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

/** The sender's own word on their own record: the decider is the sender (defaults 3a and 14). */
const PASS_OWN: AllowedDecision = { result: "pass", why: "decider" };

/** Nobody to ask: before S1-75 the barbershop has no owner, so the step's safe default runs (default 7), as before. */
function nobodyAllowedAt(step: string): AllowedDecision {
  return {
    result: "fail",
    why: "nobodyDecides",
    outcome: askedDeciderOutcome(),
    next: { kind: "nobodyDecides", why: "nobodyAllowed", step },
  };
}

const barbershop = targetOf(BARBERSHOP, null);

/** S1-02's option "All on the list" for Sam's question, as commit-s1-02.json's frontier offers it, with `over` changed. */
function allOnTheList(over: Partial<Choice> = {}): Choice {
  return { ...option("c-01", S1_02_QUESTION, "S1-02", "All on the list", barbershop), ...over };
}

describe("T-1459: a role-less signer's own answer to S1-02's question passes while the business's control is not proven (default 14)", () => {
  it("commit-s1-02.json's part from Sam, who holds no role yet, answering the question sent to him on his own handle, with control not proven: passes as his own record, proven by his handle, with no code asked", async () => {
    const reads: SignUpRead[] = [];
    const ownAsked: OwnAsk[] = [];
    const codeAsked: CodeAsk[] = [];
    const request = exchangeRequest(SECOND_TURN_FIXTURE);
    expect(await decided({ reads }, request, { ownAsked, codeAsked })).toEqual(PASS_OWN);
    // Each fact read once, in its order: the question's row, the link, the control.
    expect(reads).toEqual(["question", "linked", "control"]);
    // The one rule proves him in the customer's standing, by the turn's handle K-04 links to him (default 5).
    expect(ownAsked).toEqual([
      { businessId: BARBERSHOP, personId: "person-sam", as: "self", caller: "turn", handleId: SAM.handleId },
    ]);
    expect(codeAsked).toEqual([]);
    // Before T-1459 the same part was the business's settings, which nobody at the barbershop could decide yet.
    expect(await asBefore(request)).toEqual(nobodyAllowedAt("S1-02"));
  });

  it("through the gate: limit 1 passes it, and every part is as commit-s1-02.json states", async () => {
    const exchange = gateExchange(SECOND_TURN_FIXTURE);
    const request = exchangeRequest(SECOND_TURN_FIXTURE);
    const script = withoutLimit1(fixtureScript(exchange));
    const limit = limitIn({ record: signUpRecord(), signUps: {} });
    const parts = gatedParts(await runGate(request, callContext(BARBERSHOP), registryWith(limit, script)));
    const stated = committedOf(SECOND_TURN_FIXTURE).parts;
    expect(parts.map((part, index) => partResultOf(part, stated[index]?.gives ?? []))).toEqual(stated);
    expect(stated[0]?.limits[0]).toEqual({ limit: 1, result: "pass", outcome: null });
  });

  it("over the shipped defaults (K-04's links for the one rule, no K-22 reader, no T-322 codes), it passes: the answer no longer waits for a code the gate cannot send", async () => {
    const record = signUpRecord();
    const doubles = { identity: identityFrom(record), stages: stagesFrom(record), steps: stepsOf() };
    const limit = createLimit1({ ...doubles, signUps: signUpsOf({}, record) });
    const request = exchangeRequest(SECOND_TURN_FIXTURE);
    expect(await limit.decide(partOf(request), turnOf(request))).toEqual(PASS_OWN);
    expect(await limit.check(partOf(request), turnOf(request))).toEqual({ result: "pass" });
    // With the shipped read over a repo that is no database, no fact can be read: the part answers as before.
    const shipped = createLimit1(doubles);
    expect(await shipped.decide(partOf(request), turnOf(request, TEST_REPO))).toEqual(
      nobodyAllowedAt("S1-02"),
    );
  });

  it("S1-04's answer, the sign-up's next question, passes the same way: any S1 step's settings about no booking", async () => {
    const shareOne = option("c-s1-04-1", "oq-s1-04-sam", "S1-04", "1 Some share one", barbershop);
    const request = ask(SAM, shareOne, "1 Plumbing and electrical share Lee Home Services");
    expect(await decided(storedAt("S1-04", "oq-s1-04-sam"), request)).toEqual(PASS_OWN);
    expect(await asBefore(request)).toEqual(nobodyAllowedAt("S1-04"));
  });

  it("nothing is written and no role is named: the answer is two labels, and the record's roles are as they were", async () => {
    const record = signUpRecord();
    const rolesBefore = structuredClone(record.roles);
    const decision = await decided({}, exchangeRequest(SECOND_TURN_FIXTURE), { record });
    expect(stringsIn(decision)).toEqual(["pass", "decider"]);
    expect(record.roles).toEqual(rolesBefore);
    expect(record.roles.some((row) => row.personId === "person-sam" && row.businessId === BARBERSHOP)).toBe(
      false,
    );
  });
});

describe("T-1459: any fact that does not hold, is missing or cannot be read answers as today, never passes", () => {
  const cases: readonly (readonly [string, SignUpWorld, () => GateRequest])[] = [
    [
      "another person on the same handle: Sam's helper, linked to his phone, answering the question asked of Sam",
      {},
      () => secondTurnFrom(SAM_HELPER),
    ],
    [
      "the same person on another handle: Sam from his new mobile, linked to him, while the question is live on his own handle alone",
      {},
      () => secondTurnFrom(SAM_NEW_MOBILE),
    ],
    [
      "a question sent on another handle: stored for Sam's new mobile, answered from his own phone",
      { questions: [{ asked: s1_02Asked({ handleId: SAM_NEW_MOBILE.handleId }), live: true }] },
      () => exchangeRequest(SECOND_TURN_FIXTURE),
    ],
    [
      "a question at another business: stored for Lee Home Services",
      {
        questions: [{ asked: s1_02Asked({ businessId: HOME_SERVICES }), live: true }],
        control: { [BARBERSHOP]: null, [HOME_SERVICES]: null },
      },
      () => exchangeRequest(SECOND_TURN_FIXTURE),
    ],
    [
      "a question that is not live: answered already",
      { questions: [{ asked: s1_02Asked(), live: false }] },
      () => exchangeRequest(SECOND_TURN_FIXTURE),
    ],
    [
      "a question that has not gone out to the handle yet",
      { questions: [{ asked: s1_02Asked({ sentAt: null }), live: true }] },
      () => exchangeRequest(SECOND_TURN_FIXTURE),
    ],
    [
      "a question asked of nobody on the record",
      { questions: [{ asked: s1_02Asked({ personId: null }), live: true }] },
      () => exchangeRequest(SECOND_TURN_FIXTURE),
    ],
    [
      "a question stored at another step than the part's (S1-04's under S1-02's id)",
      storedAt("S1-04", S1_02_QUESTION),
      () => exchangeRequest(SECOND_TURN_FIXTURE),
    ],
    [
      "a question stored about a booking",
      { questions: [{ asked: s1_02Asked({ bookingId: HAIRCUT }), live: true }] },
      () => exchangeRequest(SECOND_TURN_FIXTURE),
    ],
    [
      "control proven, while Sam still holds no role",
      { control: { [BARBERSHOP]: "2026-10-19T14:10:00Z" } },
      () => exchangeRequest(SECOND_TURN_FIXTURE),
    ],
    ["the question's row missing", { questions: [] }, () => exchangeRequest(SECOND_TURN_FIXTURE)],
    [
      "the link missing: no person_handles row ties Sam to the handle",
      { links: [] },
      () => exchangeRequest(SECOND_TURN_FIXTURE),
    ],
    ["the business_setup row missing", { control: {} }, () => exchangeRequest(SECOND_TURN_FIXTURE)],
    ["the question's row unreadable", { unreadable: "question" }, () => exchangeRequest(SECOND_TURN_FIXTURE)],
    ["the link unreadable", { unreadable: "linked" }, () => exchangeRequest(SECOND_TURN_FIXTURE)],
    [
      "the business_setup row unreadable",
      { unreadable: "control" },
      () => exchangeRequest(SECOND_TURN_FIXTURE),
    ],
  ];

  it.each(cases)("%s", async (_what, facts, requestOf) => {
    const request = requestOf();
    const answered = await decided(facts, request);
    expect(answered).toEqual(await asBefore(request));
    expect(answered).toEqual(nobodyAllowedAt("S1-02"));
  });

  it("a read that answers another handle's or another business's row anyway (as one with no row-level security could) is still kept out by default 14's own checks", async () => {
    const record = signUpRecord();
    const request = exchangeRequest(SECOND_TURN_FIXTURE);
    for (const asked of [
      s1_02Asked({ businessId: HOME_SERVICES }),
      s1_02Asked({ handleId: SAM_NEW_MOBILE.handleId }),
      s1_02Asked({ openQuestionId: "oq-s1-02-another" }),
    ]) {
      const limit = createLimit1({
        identity: identityFrom(record),
        stages: stagesFrom(record),
        steps: stepsOf(),
        signUps: () => ({
          question: () => Promise.resolve(asked),
          linked: () => Promise.resolve(true),
          control: () => Promise.resolve({ provenAt: null }),
        }),
      });
      expect(await limit.decide(partOf(request), turnOf(request))).toEqual(nobodyAllowedAt("S1-02"));
    }
  });

  it("with the link and the one rule both missing, the sender is unproven as before: the code to the contact on file, or notBuilt with no T-322 codes", async () => {
    const record = { ...signUpRecord(), personHandles: [] };
    const request = exchangeRequest(SECOND_TURN_FIXTURE);
    const codeAsked: CodeAsk[] = [];
    const withCodes = await decided({}, request, { record, codeAsked });
    expect(withCodes).toEqual(await asBefore(request, { record }));
    expect(withCodes).toMatchObject({
      result: "fail",
      why: "unproven",
      outcome: { action: "proofCodeSent" },
    });
    expect(codeAsked[0]).toMatchObject({ forPersonId: "person-sam", as: "self", typedBackIn: SAM.handleId });
    expect(await decided({}, request, { record, proofCodes: null })).toEqual({
      result: "notBuilt",
      port: "proofCodes",
    });
  });
});

describe("T-1459: money, team, live and owner-only matters, other steps and other callers stay as they were", () => {
  const charge = { why: "charge", step: "S1-27", ref: null } as const;
  const matters: readonly (readonly [string, () => GateRequest, SignUpWorld, string])[] = [
    [
      "a fee stake at an S1 step (a charge on its walk)",
      () => ask(SAM, allOnTheList({ stakes: "high", stakesFrom: [charge] })),
      {},
      "S1-02",
    ],
    [
      "money taken on its walk",
      () =>
        ask(SAM, allOnTheList({ stakes: "high", stakesFrom: [{ why: "money", step: "S1-13", ref: null }] })),
      {},
      "S1-02",
    ],
    [
      "a refund stake",
      () =>
        ask(SAM, allOnTheList({ stakes: "high", stakesFrom: [{ why: "refund", step: "S1-27", ref: null }] })),
      {},
      "S1-02",
    ],
    [
      "an unknown stake (a walk the frontier builder could not follow)",
      () =>
        ask(SAM, allOnTheList({ stakes: "high", stakesFrom: [{ why: "unknown", step: null, ref: null }] })),
      {},
      "S1-02",
    ],
    [
      "a booking its walk writes",
      () =>
        ask(SAM, allOnTheList({ stakes: "high", stakesFrom: [{ why: "booked", step: "A6-01", ref: null }] })),
      {},
      "S1-02",
    ],
    [
      "a calendar entry its walk writes",
      () =>
        ask(
          SAM,
          allOnTheList({ stakes: "high", stakesFrom: [{ why: "calendarWrite", step: "A6-01", ref: null }] }),
        ),
      {},
      "S1-02",
    ],
    [
      "another option of its question that is high",
      () =>
        ask(
          SAM,
          allOnTheList({ stakes: "high", stakesFrom: [{ why: "question", step: null, ref: "c-02" }] }),
        ),
      {},
      "S1-02",
    ],
    [
      "a team matter at an S1 step: the team hub's case, naming S1-02's question",
      () =>
        ask(SAM, {
          ...hubCase("c-team", "S1-02", "team", "Someone joins", barbershop),
          question: S1_02_QUESTION,
        }),
      {},
      "S1-02",
    ],
    [
      "a team matter at an S1 step: the team door, naming S1-02's question",
      () =>
        ask(SAM, { ...doorOf("c-team-door", "teamChange", "S1-02", barbershop), question: S1_02_QUESTION }),
      {},
      "S1-02",
    ],
    [
      "an owner-only step: S11-61's export, its question stored as Sam's",
      () => ask(SAM, option("c-export", "oq-s11-61-sam", "S11-61", "Export the list", barbershop)),
      storedAt("S11-61", "oq-s11-61-sam"),
      "S11-61",
    ],
    [
      "a live step: S1-29's '1 Go live'",
      () =>
        ask(
          SAM,
          option("c-s1-29-1", "oq-s1-29-sam", "S1-29", "1 Nothing left to sign", barbershop),
          "Go live",
        ),
      storedAt("S1-29", "oq-s1-29-sam"),
      "S1-29",
    ],
    [
      "a live step: S1-35's '1 Start now'",
      () => ask(SAM, option("c-s1-35-1", "oq-s1-35-sam", "S1-35", "1 Start now", barbershop)),
      storedAt("S1-35", "oq-s1-35-sam"),
      "S1-35",
    ],
    [
      "a step outside S1: S2-22's '1 Yes, all of them' (team)",
      () => ask(SAM, option("c-s2-22", "oq-s2-22-sam", "S2-22", "1 Yes, all of them", barbershop)),
      storedAt("S2-22", "oq-s2-22-sam"),
      "S2-22",
    ],
    [
      "a step outside S1: S12-24's '3 Let it book' (settings)",
      () => ask(SAM, option("c-s12-24-3", "oq-s12-24-sam", "S12-24", "3 Let it book", barbershop), "3"),
      storedAt("S12-24", "oq-s12-24-sam"),
      "S12-24",
    ],
    [
      "a choice on a booking at an S1 step",
      () => ask(SAM, allOnTheList({ target: targetOf(BARBERSHOP, HAIRCUT) })),
      {},
      "S1-02",
    ],
    [
      "a meaning-search entry at an S1 step, which answers no open question",
      () =>
        ask(SAM, searchEntry("c-s1-02-entry", "S1-02", "Asks what work Sam does", barbershop), "barbershop"),
      {},
      "S1-02",
    ],
    [
      "off the chat: a page acting for Sam",
      () => ask(SAM, allOnTheList(), "Barbershop", { caller: "page" }),
      {},
      "S1-02",
    ],
    [
      "off the chat: an AI acting for Sam",
      () => ask(SAM, allOnTheList(), "Barbershop", { caller: "agent" }),
      {},
      "S1-02",
    ],
    ["a sender nobody on the record", () => ask(STRANGER, allOnTheList(), "Barbershop"), {}, "S1-02"],
  ];

  it.each(matters)("%s: as today", async (_what, requestOf, facts, step) => {
    const request = requestOf();
    const answered = await decided(facts, request);
    expect(answered).toEqual(await asBefore(request));
    expect(answered).toEqual(nobodyAllowedAt(step));
  });

  it("what needs no read comes first: a money stake, a live step, a step outside S1 or a caller off the chat reads no fact", async () => {
    const requests = [
      ask(SAM, allOnTheList({ stakes: "high", stakesFrom: [charge] })),
      ask(SAM, option("c-s1-29-1", "oq-s1-29-sam", "S1-29", "1 Nothing left to sign", barbershop)),
      ask(SAM, option("c-s2-22", "oq-s2-22-sam", "S2-22", "1 Yes, all of them", barbershop)),
      ask(SAM, allOnTheList(), "Barbershop", { caller: "page" }),
      ask(STRANGER, allOnTheList(), "Barbershop"),
    ];
    for (const request of requests) {
      const reads: SignUpRead[] = [];
      await decided({ reads }, request);
      expect(reads).toEqual([]);
    }
  });

  it("the live steps are S1-29's Go live and S1-35's goes live", () => {
    expect([...LIVE_STEPS].sort()).toEqual(["S1-29", "S1-35"]);
  });
});

describe("T-1459: the sign-up door and a customer's own record answer as before, with no fact of default 14 read", () => {
  const PASS_ANYONE: AllowedDecision = { result: "pass", why: "anyone" };

  it("the sign-up door is anyone's to enter (default 13): commit-s1-01.json's part, and the door from the signer, his helper or a number nobody on the record writes from", async () => {
    const reads: SignUpRead[] = [];
    expect(await decided({ reads }, exchangeRequest(SIGN_UP_FIXTURE))).toEqual(PASS_ANYONE);
    for (const who of [SAM, SAM_HELPER, STRANGER]) {
      const request = ask(who, signUpDoor(), "Hi, I want to put my barbershop on Rosie");
      expect(await decided({ reads }, request)).toEqual(PASS_ANYONE);
    }
    expect(reads).toEqual([]);
  });

  it("A4-82's reach card is still the customer's own record (OWN_RECORD_STEPS): Alex's own phone passes, a phone not on file gets the code", async () => {
    const reads: SignUpRead[] = [];
    const world: World = { record: limitRecord() };
    expect(await decided({ reads }, ask(ALEX, reachBy("Texts only"), "texts only please"), world)).toEqual(
      PASS_OWN,
    );
    expect(
      await decided({ reads }, ask(ALEX_NEW_MOBILE, reachBy("Texts only"), "texts only"), world),
    ).toMatchObject({
      result: "fail",
      why: "unproven",
      outcome: { action: "proofCodeSent" },
    });
    expect(reads).toEqual([]);
  });
});
