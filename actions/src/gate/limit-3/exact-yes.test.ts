// T-301's proofs (the card's "Proves it with"), on the contracts' own fixtures and the master's own read-backs, with
// doubles standing in for limit 3's ports and for limits 1, 2, 4, 5 and 6, never for limit 3:
//   - commit-limit-3-no-exact-yes.json gives its outcome;
//   - the hard invariant (no charge without a clear yes tied to that booking): a money part with a yes bound to an older
//     read-back text or version is refused;
//   - a tapback on the read-back is refused;
//   - a yes relayed by a third party is refused;
//   - a poll vote on the read-back's own poll passes;
//   - an unbound own-AI confirm is refused (Q-09);
//   - a second failure on one question returns the step's safe default and an owner notice, never a third read-back.
// Also: K-06's edit-after-commit.json is a new answer at its own send time; every other K-09 gate fixture that reaches
// limit 3 comes out as it states; limit 3 checks only what needs a yes; what it returns holds no person's words; the
// shipped limit sits in slot 3 and reads only through the call's database.

import { describe, expect, it } from "vitest";

import { stringsIn } from "../../tool-api/test-support";
import {
  LIMIT_ACTIONS,
  partResultOf,
  runGate,
  type DecideResult,
  type GatePart,
  type GateRequest,
  type GatedPart,
  type GateVerdict,
} from "../framework";
import {
  callContext,
  fixtureScript,
  gateExchange,
  modelFixture,
  type LimitCall,
} from "../framework/test-support";
import { LIMITS } from "../limits";
import {
  freshReadBackOutcome,
  isExactAnswer,
  limit3,
  safeDefaultOutcome,
  sha256Hex,
  type BoundYes,
  type ExactYesDecision,
  type RowRef,
} from "./index";
import {
  ALEX,
  ALEX_PARTNER,
  BARBERSHOP,
  BEARD_TRIM_CARD,
  BEARD_TRIM_OPTIONS,
  BEARD_TRIM_QUESTION,
  BEARD_TRIM_READ_BACK,
  BEARD_TRIM_READ_BACK_TODAY,
  BEARD_TRIM_VERSIONS,
  GIFT,
  HAIRCUT,
  RILEY,
  SAM,
  TEAM_OPTIONS,
  TEAM_READ_BACK,
  barbershopRecord,
  barbershopTarget,
  beardTrimChoices,
  beardTrimRequest,
  beardTrimRow,
  callOffRequest,
  callOffRow,
  decidedIn,
  exchangeRequest,
  inboundEvent,
  limitIn,
  moveTimesRequest,
  moveTimesRow,
  offChat,
  option,
  partOf,
  registryWith,
  requestFor,
  rowFor,
  textOf,
  turnOf,
  typed,
  withoutLimit3,
  type QuestionAsked,
  type World,
} from "./test-support";

/** Limit 3's decision on part `index` of `request`, in `world`. */
function decision(world: World, request: GateRequest, index = 0): Promise<ExactYesDecision> {
  return limitIn(world).decide(partOf(request, index), turnOf(request));
}

/** The parts of a gated verdict; fails the test for a refused one. */
function gatedParts(verdict: GateVerdict): readonly GatedPart[] {
  if (verdict.verdict !== "gated") throw new Error(`refused: ${JSON.stringify(verdict.error)}`);
  return verdict.parts;
}

/** What a fixture or scenario must hold for a test to read it. */
function missing(): never {
  throw new Error("the fixture lacks what the test reads");
}

/** A K-09 exchange's committed outcome; fails the test for any other. */
function committedOf(file: string) {
  const { outcome } = gateExchange(file);
  if ("error" in outcome || outcome.result !== "committed") throw new Error(`${file} is not committed`);
  return outcome;
}

const S2_22 = "oq-s2-22-sam";
const LIMIT_3_FIXTURE = "commit-limit-3-no-exact-yes.json";
/** Alex's haircut at its next version: the booking changed after the first read-back. */
const VERSIONS_TODAY: readonly RowRef[] = [{ table: "bookings", rowId: HAIRCUT, version: 8 }];
/** Alex's own "1", typed a minute after A7-31's read-back went out (14:04). */
const ALEX_YES = typed("evt-alex-0031-1", "1", "2026-10-23T14:05:00Z");

/** A binding as a page server or a bound token carries it: Alex's, to `words` at `versions`. */
async function alexBound(
  words: string,
  versions: readonly RowRef[],
  personId = ALEX.personId,
): Promise<BoundYes> {
  return {
    personId,
    handleId: ALEX.handleId,
    readBackSha256: await sha256Hex(words),
    versionsRead: versions,
  };
}

describe("commit-limit-3-no-exact-yes.json gives its outcome", () => {
  it("Sam's 'sure i guess' to S2-22's read-back fails limit 3 with a fresh read-back, once; the part is as the fixture states", async () => {
    const exchange = gateExchange(LIMIT_3_FIXTURE);
    const request = exchangeRequest(LIMIT_3_FIXTURE);
    const row = rowFor(request, S2_22, { readback: TEAM_READ_BACK, options: TEAM_OPTIONS });
    const limit = limitIn({ rows: [row] });
    const calls: LimitCall[] = [];
    const call = callContext(BARBERSHOP);
    const script = withoutLimit3(fixtureScript(exchange));
    const parts = gatedParts(await runGate(request, call, registryWith(limit, script, calls)));
    const stated = committedOf(LIMIT_3_FIXTURE).parts;
    expect(parts.map((part) => partResultOf(part))).toEqual(stated);
    expect(stated[0]?.stoppedBy).toEqual({ limit: 3, outcome: "ask", action: "freshReadBack" });
    expect(calls).toEqual([
      { limit: 1, part: 0 },
      { limit: 2, part: 0 },
      { limit: 3, part: 0 },
    ]);
    expect(call.span.limits).toEqual(stated[0]?.limits);
    expect(await limit.decide(partOf(request), turnOf(request))).toEqual({
      result: "fail",
      why: "notExact",
      outcome: freshReadBackOutcome(),
      next: { kind: "freshReadBack", openQuestionId: S2_22, step: "S2-22", askCount: 2 },
    });
  });

  const reaching: readonly [string, string, string | null][] = [
    ["commit-s1-02.json", "oq-s1-02", null],
    ["commit-limit-4-changed.json", S2_22, TEAM_READ_BACK],
    ["commit-limit-5-taken.json", "oq-a4-14-alex", null],
    ["commit-limit-6-value-fails.json", "oq-s1-02", null],
  ];

  it.each(reaching)(
    "%s: with the real limit 3 in its slot, every part comes out as the fixture states",
    async (file, question, readback) => {
      const request = exchangeRequest(file);
      const row = rowFor(
        request,
        question,
        readback === null ? { readback } : { readback, options: TEAM_OPTIONS },
      );
      const script = withoutLimit3(fixtureScript(gateExchange(file)));
      const parts = gatedParts(
        await runGate(request, callContext(BARBERSHOP), registryWith(limitIn({ rows: [row] }), script)),
      );
      const stated = committedOf(file).parts;
      expect(parts.map((part, index) => partResultOf(part, stated[index]?.gives ?? []))).toEqual(stated);
    },
  );
});

describe("hard invariant: no charge without a clear yes tied to that booking", () => {
  it("Alex's own '1' to A7-31's read-back of the $20 trim, after it went out, passes", async () => {
    const request = beardTrimRequest({ texts: [ALEX_YES], quote: "1" });
    expect(await decision({ rows: [beardTrimRow()] }, request)).toEqual({ result: "pass" });
  });

  it("a money part with a yes bound to an older read-back is refused: '1' typed before today's read-back went out", async () => {
    // A7-31 read back again at 14:06 with today's price ($25): other words, built from the haircut's next version.
    const today = "oq-a7-31-alex-2";
    const row = beardTrimRow({
      question: today,
      readback: BEARD_TRIM_READ_BACK_TODAY,
      versionsRead: VERSIONS_TODAY,
      sentAt: "2026-10-23T14:06:00Z",
    });
    const request = beardTrimRequest({
      texts: [ALEX_YES],
      quote: "1",
      question: today,
      sentAt: "2026-10-23T14:06:00Z",
    });
    expect(await decision({ rows: [row] }, request)).toEqual({
      result: "fail",
      why: "staleReadBack",
      outcome: freshReadBackOutcome(),
      next: { kind: "freshReadBack", openQuestionId: today, step: "A7-31", askCount: 2 },
    });
  });

  it("a page's yes bound to an older read-back's words, or to today's words at an older version, is refused", async () => {
    const row = beardTrimRow({ readback: BEARD_TRIM_READ_BACK_TODAY, versionsRead: VERSIONS_TODAY });
    const page = offChat(beardTrimRequest({ texts: [ALEX_YES], quote: "1" }), "page", ALEX.personId);
    const oldWords = await alexBound(BEARD_TRIM_READ_BACK, VERSIONS_TODAY);
    const oldVersions = await alexBound(BEARD_TRIM_READ_BACK_TODAY, BEARD_TRIM_VERSIONS);
    const current = await alexBound(BEARD_TRIM_READ_BACK_TODAY, VERSIONS_TODAY);
    for (const bound of [oldWords, oldVersions]) {
      expect(await decision({ rows: [row], bound: { [BEARD_TRIM_QUESTION]: bound } }, page)).toMatchObject({
        result: "fail",
        why: "staleReadBack",
        outcome: freshReadBackOutcome(),
      });
    }
    expect(await decision({ rows: [row], bound: { [BEARD_TRIM_QUESTION]: current } }, page)).toEqual({
      result: "pass",
    });
  });

  it("a bound own AI's confirm naming the read-back Alex saw before today's is refused", async () => {
    const row = beardTrimRow({ readback: BEARD_TRIM_READ_BACK_TODAY, versionsRead: VERSIONS_TODAY });
    const agent = offChat(beardTrimRequest({ texts: [ALEX_YES], quote: "1" }), "agent", ALEX.personId);
    const bound = await alexBound(BEARD_TRIM_READ_BACK, BEARD_TRIM_VERSIONS);
    expect(await decision({ rows: [row], bound: { [BEARD_TRIM_QUESTION]: bound } }, agent)).toMatchObject({
      result: "fail",
      why: "staleReadBack",
    });
  });

  it("a money part answering a question that carries no read-back is refused: the yes binds to no words", async () => {
    const request = beardTrimRequest({ texts: [ALEX_YES], quote: "1" });
    expect(await decision({ rows: [beardTrimRow({ readback: null })] }, request)).toMatchObject({
      result: "fail",
      why: "noReadBack",
    });
  });

  it("a money part entered with no question at all (an any-time row whose walk reaches a charge) is refused", async () => {
    const charged = {
      ...option("c-cancel", "", "A7-92", "Cancel", "Alex calls off the visit.", barbershopTarget(HAIRCUT), [
        { why: "charge", step: "A7-06", ref: null },
      ]),
      kind: "anytime" as const,
      question: null,
      branch: null,
      anytimeRow: "cancel" as const,
    };
    const request = requestFor({
      who: ALEX,
      role: "customer",
      question:
        decidedIn(beardTrimRequest({ texts: [ALEX_YES], quote: "1" })).context.openQuestions[0] ?? missing(),
      choices: [...beardTrimChoices(), charged],
      card: BEARD_TRIM_CARD,
      texts: [typed("evt-alex-0031-2", "cancel it", "2026-10-23T14:05:00Z")],
      choiceId: "c-cancel",
      quote: "cancel it",
      turnId: "turn-alex-cancel-charged",
    });
    expect(await decision({ rows: [beardTrimRow()] }, request)).toEqual({
      result: "fail",
      why: "noReadBack",
      outcome: freshReadBackOutcome(),
      next: { kind: "freshReadBack", openQuestionId: null, step: "A7-92", askCount: 1 },
    });
  });

  it("a choice the frontier builder could not walk (stakes unknown) may reach a charge: no read-back, refused", async () => {
    const row = moveTimesRow();
    const request = moveTimesRequest(
      [typed("evt-alex-0031-11", "2pm works", "2026-10-23T14:06:00Z")],
      "A7-03/2",
      "2pm works",
    );
    for (const choice of decidedIn(request).context.choices)
      choice.stakesFrom = [{ why: "unknown", step: null, ref: null }];
    expect(await decision({ rows: [row] }, request)).toMatchObject({ result: "fail", why: "noReadBack" });
  });

  it("a choice at another business than the call's has no decider in this call", async () => {
    const request = beardTrimRequest({ texts: [ALEX_YES], quote: "1" });
    for (const choice of decidedIn(request).context.choices) choice.target.businessId = "biz-yoga-studio";
    expect(await decision({ rows: [beardTrimRow()] }, request)).toMatchObject({
      result: "fail",
      why: "notDecider",
    });
  });

  it("a read-back about another booking never binds a money part on this one", async () => {
    const request = beardTrimRequest({ texts: [ALEX_YES], quote: "1" });
    expect(await decision({ rows: [beardTrimRow({ bookingId: GIFT })] }, request)).toMatchObject({
      result: "fail",
      why: "notThatBooking",
    });
  });

  it("a read-back none of which has gone out binds nothing", async () => {
    const request = beardTrimRequest({ texts: [ALEX_YES], quote: "1" });
    expect(await decision({ rows: [beardTrimRow({ sentAt: null })] }, request)).toMatchObject({
      result: "fail",
      why: "readBackNotSent",
    });
  });

  it.each(["yeah ok", "sure i guess", "yes", "ok", "1?", "maybe", "👍"])(
    "'%s' is not one of the read-back's own answers: the fresh read-back (A7-31: 'Anything else: ask once')",
    async (words) => {
      const request = beardTrimRequest({
        texts: [typed("evt-alex-0031-3", words, "2026-10-23T14:05:00Z")],
        quote: words,
      });
      expect(await decision({ rows: [beardTrimRow()] }, request)).toMatchObject({
        result: "fail",
        why: "notExact",
        outcome: freshReadBackOutcome(),
      });
    },
  );

  it.each(["1", "1.", "Add it", "add it!", "1 Add it", "1) add it", "A"])(
    "'%s' is the read-back's own answer for Add it: it passes",
    async (words) => {
      const request = beardTrimRequest({
        texts: [typed("evt-alex-0031-4", words, "2026-10-23T14:05:00Z")],
        quote: words,
      });
      expect(await decision({ rows: [beardTrimRow()] }, request)).toEqual({ result: "pass" });
    },
  );
});

describe("a tapback on the read-back is refused", () => {
  it("K-06 reaction-from-customer.json: Alex's like on A7-03's question (K-04's seed row and outbox) is never a pick", async () => {
    const like = textOf(inboundEvent("reaction-from-customer.json"));
    expect(like.kind).toBe("tapback");
    const row = moveTimesRow();
    // Even when decide reads the like as a pick of 2pm, the limit refuses it: where a pick is needed, Rosie asks which.
    const request = moveTimesRequest([like], "A7-03/2", like.words);
    expect(await decision({ rows: [row] }, request)).toEqual({
      result: "fail",
      why: "tapback",
      outcome: freshReadBackOutcome(),
      next: { kind: "freshReadBack", openQuestionId: row.openQuestionId, step: "A7-03", askCount: 2 },
    });
  });

  it("the same like on A7-31's read-back of the trim is refused", async () => {
    const event = inboundEvent("reaction-from-customer.json");
    const like = textOf({ ...event, reaction: { reaction: "like", onMessageId: "linq-msg-demo-0031" } });
    const request = beardTrimRequest({ texts: [like], quote: like.words });
    expect(await decision({ rows: [beardTrimRow()] }, request)).toMatchObject({
      result: "fail",
      why: "tapback",
      outcome: freshReadBackOutcome(),
    });
  });
});

describe("a yes relayed by a third party is refused", () => {
  it("A4-26: the gift's read-back went to Alex, the booker; his own '1' is refused, since T-308 names his brother", async () => {
    const request = beardTrimRequest({ texts: [ALEX_YES], quote: "1", bookingId: GIFT });
    const world = { rows: [beardTrimRow({ bookingId: GIFT })], record: barbershopRecord() };
    expect(await decision(world, request)).toMatchObject({ result: "fail", why: "notDecider" });
  });

  it("someone else writing from Alex's phone answers his read-back: not his own, refused", async () => {
    const request = beardTrimRequest({ texts: [ALEX_YES], quote: "1", who: ALEX_PARTNER });
    const world = { rows: [beardTrimRow()], record: barbershopRecord() };
    expect(await decision(world, request)).toMatchObject({ result: "fail", why: "notTheirOwn" });
  });

  it("Riley relaying Alex's yes from his own phone (B8-23's 'Alex wants it') finds no read-back of Alex's there", async () => {
    const relayed = typed("evt-riley-0031", "1", "2026-10-23T14:05:00Z");
    const request = beardTrimRequest({ texts: [relayed], quote: "1", who: RILEY, role: "staff" });
    expect(await decision({ rows: [beardTrimRow()] }, request)).toMatchObject({
      result: "fail",
      why: "questionNotLive",
    });
  });

  it("an outside AI whose token is bound to someone else, answering for Alex, is refused", async () => {
    const agent = offChat(beardTrimRequest({ texts: [ALEX_YES], quote: "1" }), "agent", ALEX.personId);
    const bound = await alexBound(BEARD_TRIM_READ_BACK, BEARD_TRIM_VERSIONS, SAM.personId);
    expect(
      await decision({ rows: [beardTrimRow()], bound: { [BEARD_TRIM_QUESTION]: bound } }, agent),
    ).toMatchObject({
      result: "fail",
      why: "notTheirOwn",
    });
  });

  it("A7-66: a call-off that gives money back takes the business's refund decider: Riley (staff) is refused, Sam passes", async () => {
    expect(await decision({ rows: [callOffRow(RILEY)] }, callOffRequest(RILEY, "staff", "1"))).toMatchObject({
      result: "fail",
      why: "notDecider",
    });
    expect(await decision({ rows: [callOffRow(SAM)] }, callOffRequest(SAM, "owner", "1"))).toEqual({
      result: "pass",
    });
  });
});

describe("a poll vote on the read-back's own poll passes", () => {
  const POLL = "linq-msg-demo-0031";

  it("A7-31's read-back went as text, then a poll: Alex's vote for 'Add it' on it (K-06 poll-vote.json's shape) passes", async () => {
    const event = inboundEvent("poll-vote.json");
    const vote = textOf({
      ...event,
      poll: { pollId: POLL, optionId: "linq-opt-demo-31-1", optionWords: "Add it" },
    });
    const request = beardTrimRequest({ texts: [vote], quote: "Add it", pollId: POLL });
    expect(await decision({ rows: [beardTrimRow({ pollId: POLL })] }, request)).toEqual({ result: "pass" });
  });

  it("K-06 poll-vote.json as it is: Alex's vote for 'Sat 2:00pm' on A7-03's own poll (K-04's seed outbox) passes", async () => {
    const vote = textOf(inboundEvent("poll-vote.json"));
    const row = moveTimesRow();
    expect(row.pollId).toBe("linq-msg-demo-0002");
    expect(await decision({ rows: [row] }, moveTimesRequest([vote], "A7-03/2", vote.words))).toEqual({
      result: "pass",
    });
  });

  it("the same vote on another poll than the question's own (an older one) is refused", async () => {
    const vote = textOf(inboundEvent("poll-vote.json"));
    const row = { ...moveTimesRow(), pollId: "linq-msg-demo-0003" };
    expect(await decision({ rows: [row] }, moveTimesRequest([vote], "A7-03/2", vote.words))).toMatchObject({
      result: "fail",
      why: "notOwnPoll",
    });
    const event = inboundEvent("poll-vote.json");
    const old = textOf({
      ...event,
      poll: { pollId: POLL, optionId: "linq-opt-demo-31-1", optionWords: "Add it" },
    });
    const request = beardTrimRequest({ texts: [old], quote: "Add it", pollId: "linq-msg-demo-0032" });
    expect(await decision({ rows: [beardTrimRow({ pollId: "linq-msg-demo-0032" })] }, request)).toMatchObject(
      {
        result: "fail",
        why: "notOwnPoll",
      },
    );
  });

  it("a vote for one option that decide reads as the other is refused", async () => {
    const event = inboundEvent("poll-vote.json");
    const vote = textOf({
      ...event,
      poll: { pollId: POLL, optionId: "linq-opt-demo-31-2", optionWords: "No thanks" },
    });
    const request = beardTrimRequest({
      texts: [vote],
      quote: "No thanks",
      choiceId: "A7-31/1",
      pollId: POLL,
    });
    expect(await decision({ rows: [beardTrimRow({ pollId: POLL })] }, request)).toMatchObject({
      result: "fail",
      why: "notExact",
    });
  });
});

describe("an unbound own-AI confirm is refused (Q-09: the tie is required)", () => {
  it("an outside AI's confirm for Alex, with no token bound to him by a code he typed back, is refused", async () => {
    const agent = offChat(beardTrimRequest({ texts: [ALEX_YES], quote: "1" }), "agent", ALEX.personId);
    expect(await decision({ rows: [beardTrimRow()] }, agent)).toEqual({
      result: "fail",
      why: "unboundAgent",
      outcome: freshReadBackOutcome(),
      next: { kind: "freshReadBack", openQuestionId: BEARD_TRIM_QUESTION, step: "A7-31", askCount: 2 },
    });
  });

  it("the shipped limit 3 binds no AI yet (T-328): it refuses every own-AI confirm, before reading anything", async () => {
    const agent = offChat(beardTrimRequest({ texts: [ALEX_YES], quote: "1" }), "agent", ALEX.personId);
    expect(await limit3.check(partOf(agent), turnOf(agent))).toEqual({
      result: "fail",
      outcome: freshReadBackOutcome(),
    });
  });

  it("a secure page's yes with nothing its page server kept is refused (K-21's capture is not built)", async () => {
    const page = offChat(beardTrimRequest({ texts: [ALEX_YES], quote: "1" }), "page", ALEX.personId);
    expect(await decision({ rows: [beardTrimRow()] }, page)).toMatchObject({
      result: "fail",
      why: "noPageYes",
    });
  });

  it("an own AI bound to Alex, confirming the read-back's exact words and versions, counts as his own (RULES 3.6)", async () => {
    const agent = offChat(beardTrimRequest({ texts: [ALEX_YES], quote: "1" }), "agent", ALEX.personId);
    const bound = await alexBound(BEARD_TRIM_READ_BACK, BEARD_TRIM_VERSIONS);
    expect(
      await decision({ rows: [beardTrimRow()], bound: { [BEARD_TRIM_QUESTION]: bound } }, agent),
    ).toEqual({
      result: "pass",
    });
  });
});

describe("a second failure on one question returns the step's safe default and an owner notice, never a third read-back", () => {
  it("S2-22 read back fresh: Sam's 'sure i guess' again takes the safe default, and Rosie's team is told (Sam's own question)", async () => {
    const request = exchangeRequest(LIMIT_3_FIXTURE);
    const asked = decidedIn(request).context.openQuestions[0] ?? missing();
    asked.askCount = 2;
    const row = rowFor(request, S2_22, { readback: TEAM_READ_BACK, options: TEAM_OPTIONS });
    const limit = limitIn({ rows: [row] });
    expect(await limit.decide(partOf(request), turnOf(request))).toEqual({
      result: "fail",
      why: "notExact",
      outcome: safeDefaultOutcome(),
      next: {
        kind: "safeDefault",
        openQuestionId: S2_22,
        step: "S2-22",
        safeDefault: "they stay off the calendar, and Sam's morning list asks again.",
        told: {
          to: "rosieTeam",
          businessId: BARBERSHOP,
          step: "S2-22",
          openQuestionId: S2_22,
          why: "notExact",
        },
      },
    });
    const script = withoutLimit3(fixtureScript(gateExchange(LIMIT_3_FIXTURE)));
    const [part] = gatedParts(await runGate(request, callContext(BARBERSHOP), registryWith(limit, script)));
    expect(part?.stoppedBy).toEqual({ limit: 3, outcome: "refuse", action: "safeDefault" });
  });

  it("A7-31 read back fresh: Alex's 'yeah ok' again takes 'nothing is added or moved', and the owner is told", async () => {
    const okay = typed("evt-alex-0031-5", "yeah ok", "2026-10-23T14:07:00Z");
    const request = beardTrimRequest({ texts: [okay], quote: "yeah ok", askCount: 2 });
    expect(await decision({ rows: [beardTrimRow({ askCount: 2 })] }, request)).toEqual({
      result: "fail",
      why: "notExact",
      outcome: safeDefaultOutcome(),
      next: {
        kind: "safeDefault",
        openQuestionId: BEARD_TRIM_QUESTION,
        step: "A7-31",
        safeDefault: "nothing is added or moved.",
        told: {
          to: "owner",
          businessId: BARBERSHOP,
          step: "A7-31",
          openQuestionId: BEARD_TRIM_QUESTION,
          why: "notExact",
        },
      },
    });
  });

  it("the fresh read-back is the question asked twice, so the failure after it is the safe default", async () => {
    const first = await decision(
      { rows: [beardTrimRow()] },
      beardTrimRequest({ texts: [typed("evt-alex-0031-6", "sure", "2026-10-23T14:05:00Z")], quote: "sure" }),
    );
    if (first.result !== "fail" || first.next.kind !== "freshReadBack") throw new Error("no fresh read-back");
    const again = "oq-a7-31-alex-readback";
    const askCount = first.next.askCount;
    const second = await decision(
      { rows: [beardTrimRow({ question: again, askCount, sentAt: "2026-10-23T14:05:10Z" })] },
      beardTrimRequest({
        texts: [typed("evt-alex-0031-7", "sure", "2026-10-23T14:06:00Z")],
        quote: "sure",
        question: again,
        askCount,
        sentAt: "2026-10-23T14:05:10Z",
      }),
    );
    expect(second).toMatchObject({
      result: "fail",
      outcome: safeDefaultOutcome(),
      next: { kind: "safeDefault" },
    });
  });

  it("every way of failing a question asked twice takes the safe default: tapback, relayed, older read-back, unbound AI", async () => {
    const like = textOf({
      ...inboundEvent("reaction-from-customer.json"),
      reaction: { reaction: "like", onMessageId: "linq-msg-demo-0031" },
    });
    const twice = beardTrimRow({ askCount: 2 });
    const cases: [World, GateRequest][] = [
      [{ rows: [twice] }, beardTrimRequest({ texts: [like], quote: like.words, askCount: 2 })],
      [
        { rows: [twice], record: barbershopRecord() },
        beardTrimRequest({ texts: [ALEX_YES], quote: "1", who: ALEX_PARTNER, askCount: 2 }),
      ],
      [
        { rows: [beardTrimRow({ askCount: 2, sentAt: "2026-10-23T14:06:00Z" })] },
        beardTrimRequest({ texts: [ALEX_YES], quote: "1", askCount: 2 }),
      ],
      [
        { rows: [twice] },
        offChat(beardTrimRequest({ texts: [ALEX_YES], quote: "1", askCount: 2 }), "agent", ALEX.personId),
      ],
    ];
    for (const [world, request] of cases) {
      const decided = await decision(world, request);
      expect(decided).toMatchObject({
        result: "fail",
        outcome: safeDefaultOutcome(),
        next: { kind: "safeDefault" },
      });
      expect(stringsIn(decided)).not.toContain("freshReadBack");
    }
  });
});

describe("an edit after its turn committed is a new answer (K-06 edit-after-commit.json; S13-25 rules 20, 21)", () => {
  const edit = textOf(inboundEvent("edit-after-commit.json"));

  it("it answers, at its own send time, the read-back that went out before it: Alex's edited '2' is No thanks", async () => {
    expect(edit).toMatchObject({ kind: "text", words: "2", sentAt: { utc: "2026-10-23T14:09:00Z" } });
    const request = beardTrimRequest({ texts: [edit], quote: "2", choiceId: "A7-31/2" });
    expect(await decision({ rows: [beardTrimRow()] }, request)).toEqual({ result: "pass" });
  });

  it("it never acts on an old button: a read-back that went out after the edit is not what it answered", async () => {
    const today = "oq-a7-31-alex-2";
    const row = beardTrimRow({
      question: today,
      readback: BEARD_TRIM_READ_BACK_TODAY,
      versionsRead: VERSIONS_TODAY,
      sentAt: "2026-10-23T14:09:30Z",
    });
    const request = beardTrimRequest({
      texts: [edit],
      quote: "2",
      choiceId: "A7-31/2",
      question: today,
      sentAt: "2026-10-23T14:09:30Z",
    });
    expect(await decision({ rows: [row] }, request)).toMatchObject({ result: "fail", why: "staleReadBack" });
  });
});

describe("limit 3 checks only the parts that need a yes", () => {
  it("pass_on and hand_off (K-02 decide-pass-on.json, decide-hand-off.json) are not checked", async () => {
    const turn = turnOf(beardTrimRequest({ texts: [ALEX_YES], quote: "1" }));
    for (const file of ["decide-pass-on.json", "decide-hand-off.json"]) {
      const said = (modelFixture(file) as DecideResult).parts[0].part;
      if (said.verb !== "pass_on" && said.verb !== "hand_off")
        throw new Error(`${file} has no pass_on or hand_off`);
      const part: GatePart = { index: 0, part: said, choice: null };
      expect(await limitIn({ rows: [] }).decide(part, turn)).toEqual({ result: "notChecked" });
    }
  });

  it("a door entered with no money is not checked, and nothing is read for it", async () => {
    const door = {
      ...option(
        "c-door",
        "",
        "A3-51",
        "A new booking or a question",
        "Something new.",
        barbershopTarget(null),
      ),
      kind: "door" as const,
      question: null,
      branch: null,
      door: "newBooking" as const,
    };
    const request = requestFor({
      who: ALEX,
      role: "customer",
      question:
        decidedIn(beardTrimRequest({ texts: [ALEX_YES], quote: "1" })).context.openQuestions[0] ?? missing(),
      choices: [...beardTrimChoices(), door],
      card: BEARD_TRIM_CARD,
      texts: [typed("evt-alex-0031-8", "can I book a beard trim too", "2026-10-23T14:05:00Z")],
      choiceId: "c-door",
      quote: "can I book a beard trim too",
      turnId: "turn-alex-new-booking",
    });
    const asked: QuestionAsked[] = [];
    expect(await limitIn({ rows: [] }, asked).decide(partOf(request), turnOf(request))).toEqual({
      result: "notChecked",
    });
    expect(asked).toEqual([]);
  });

  it("a plain question with no money (no read-back): the person's own reply passes, its words decide's", async () => {
    const request = moveTimesRequest(
      [typed("evt-alex-0031-9", "2pm works", "2026-10-23T14:06:00Z")],
      "A7-03/2",
      "2pm works",
    );
    expect(await decision({ rows: [moveTimesRow()] }, request)).toEqual({ result: "pass" });
  });
});

describe("a read-back's own answers (default 1)", () => {
  const options = BEARD_TRIM_OPTIONS;
  const team = TEAM_OPTIONS;

  it.each([
    ["1", options, 0],
    ["2", options, 1],
    ["b", options, 1],
    ["No thanks.", options, 1],
    ["2 No thanks", options, 1],
    ["  ADD   IT  ", options, 0],
    ["1", team, 0],
    ["yes, all of them", team, 0],
    ["1 Yes, all of them", team, 0],
  ] as const)("'%s' answers option %#", (said, sent, index) => {
    expect(isExactAnswer(said, sent, index)).toBe(true);
  });

  it.each([
    ["2", options, 0],
    ["1 No thanks", options, 1],
    ["add", options, 0],
    ["yes", team, 0],
    ["sure i guess", team, 0],
    ["1?", options, 0],
    ["", options, 0],
    ["1", options, 5],
  ] as const)("'%s' is not the answer at %#", (said, sent, index) => {
    expect(isExactAnswer(said, sent, index)).toBe(false);
  });
});

describe("what limit 3 returns holds no person's words, and no read-back's", () => {
  it("decisions and verdicts name labels, ids and steps; the only words are a step card's safe default", async () => {
    const like = textOf(inboundEvent("reaction-from-customer.json"));
    const okay = typed("evt-alex-0031-10", "yeah ok", "2026-10-23T14:07:00Z");
    const fixture = exchangeRequest(LIMIT_3_FIXTURE);
    const team = rowFor(fixture, S2_22, { readback: TEAM_READ_BACK, options: TEAM_OPTIONS, askCount: 2 });
    const decisions = [
      await decision({ rows: [team] }, fixture),
      await decision(
        { rows: [beardTrimRow({ askCount: 2 })] },
        beardTrimRequest({ texts: [okay], quote: "yeah ok" }),
      ),
      await decision({ rows: [moveTimesRow()] }, moveTimesRequest([like], "A7-03/2", like.words)),
    ];
    const words = [
      TEAM_READ_BACK,
      BEARD_TRIM_READ_BACK,
      "sure i guess",
      "yeah ok",
      like.words,
      ALEX.address,
      SAM.address,
    ];
    const said = decisions.flatMap((each) => stringsIn(each));
    for (const each of words) expect(said).not.toContain(each);
    const cardWords = [
      "they stay off the calendar, and Sam's morning list asks again.",
      "nothing is added or moved.",
    ];
    expect(said.filter((each) => each.includes(" ")).every((each) => cardWords.includes(each))).toBe(true);
  });
});

describe("the shipped limit 3", () => {
  it("is slot 3 of the gate's registry, in place of the fail-closed stub", () => {
    expect(LIMITS[2]).toBe(limit3);
    expect(limit3.limit).toBe(3);
  });

  it("reads only through the call's database: with any other repo it throws, so the gate fails the call", async () => {
    const request = beardTrimRequest({ texts: [ALEX_YES], quote: "1" });
    await expect(limit3.check(partOf(request), turnOf(request))).rejects.toThrow(TypeError);
    const call = callContext(BARBERSHOP);
    await expect(runGate(request, call, registryWith(limit3))).rejects.toThrow(TypeError);
  });

  it("answers only K-09 v1's limit 3 outcomes, each with the kind its action has (the gate's checkOutcome)", () => {
    for (const outcome of [freshReadBackOutcome(), safeDefaultOutcome()]) {
      expect(outcome.limit).toBe(3);
      expect(LIMIT_ACTIONS[3][outcome.action]).toBe(outcome.outcome);
    }
  });
});
