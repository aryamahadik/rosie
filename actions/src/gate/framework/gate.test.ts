// T-298's proofs (the card's "Proves it with"), on the contracts' own fixtures, with doubles standing in for limits 1 to 6
// (each limit's rule is T-299 to T-304's), never for the gate:
//   - every K-02 v1 refused fixture is refused before any limit runs;
//   - a two-part decide (decide-two-requests.json) where part 2 fails: part 1 still passes and part 2 returns its outcome;
//   - with no limit module built, every part is refused (fail closed), never passed.
// Also: limits run per agreed part in order and stop at the first failure; a failure stops only that part and the parts
// on its booking; limit 6 answers valueFailsWords until decide's re-read; a limit answering outside its interface fails
// the call; each K-09 v1 gate fixture's per-part result comes out as the fixture states it.

import { describe, expect, it } from "vitest";

import { contractFile } from "../../tool-api/test-support";
import { LIMITS } from "../limits";
import { GateLimitError, LimitNotBuiltError } from "./errors";
import {
  LIMIT_ACTIONS,
  LIMIT_NUMBERS,
  NOT_BUILT,
  VALUE_FAILS_WORDS,
  bookingOf,
  partResultOf,
  runGate,
} from "./gate";
import { notBuiltLimit } from "./stub";
import {
  DECIDED_GATE_FIXTURES,
  becomes,
  callContext,
  changePart,
  copy,
  decidedOf,
  fixtureScript,
  gateExchange,
  gateRequest,
  refusedDecideOutputs,
  scriptedLimits,
  stubLimits,
  twoRequests,
  wordsIn,
  type LimitCall,
  type Script,
} from "./test-support";
import type {
  Choice,
  DecidePart,
  Decided,
  GateTurn,
  GatedPart,
  GateVerdict,
  Limit,
  LimitNumber,
  LimitOutcome,
  LimitRegistry,
  LimitResult,
} from "./types";

const PASS_ALL: LimitResult[] = LIMIT_NUMBERS.map((limit) => ({ limit, result: "pass", outcome: null }));
const NONE_CHECKED: LimitResult[] = LIMIT_NUMBERS.map((limit) => ({
  limit,
  result: "notChecked",
  outcome: null,
}));

/** Limits 1 to `failed - 1` passed, `failed` failed with `outcome`, the rest not checked. */
function failedAt(failed: LimitNumber, outcome: string): LimitResult[] {
  return LIMIT_NUMBERS.map((limit) => {
    if (limit < failed) return { limit, result: "pass", outcome: null };
    if (limit === failed) return { limit, result: "fail", outcome };
    return { limit, result: "notChecked", outcome: null };
  });
}

/** The calls of limits 1 to `last` on one part, in order. */
function callsUpTo(part: number, last: LimitNumber): LimitCall[] {
  return LIMIT_NUMBERS.filter((limit) => limit <= last).map((limit) => ({ limit, part }));
}

/** Runs the gate directly on a decided pair, with the given limits. */
async function gate(decided: Decided, limits: LimitRegistry): Promise<GateVerdict> {
  return runGate(gateRequest(decided), callContext(), limits);
}

/** The parts of a gated verdict; fails the test for a refused one. */
function gatedParts(verdict: GateVerdict): readonly GatedPart[] {
  if (verdict.verdict !== "gated") throw new Error(`refused: ${JSON.stringify(verdict.error)}`);
  return verdict.parts;
}

/** The LimitNotBuiltError a gate run throws; fails the test when it gives a verdict instead. */
async function notBuilt(run: Promise<GateVerdict>): Promise<LimitNotBuiltError> {
  const error: unknown = await run.then(
    (verdict) => verdict,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(LimitNotBuiltError);
  if (!(error instanceof LimitNotBuiltError)) throw new Error("no LimitNotBuiltError");
  return error;
}

/** One outcome of each action of each limit (K-09 v1 limit1Outcome to limit6Outcome). */
const EVERY_OUTCOME: LimitOutcome[] = [
  {
    limit: 1,
    outcome: "wait",
    action: "proofCodeSent",
    proofCodeId: "proof-sam-new-mobile-1",
    openQuestionId: "oq-sam-new-mobile-code",
  },
  { limit: 1, outcome: "ask", action: "askedDecider" },
  { limit: 2, outcome: "refuse", action: "saidWhatRuleAllows" },
  { limit: 3, outcome: "ask", action: "freshReadBack" },
  { limit: 3, outcome: "refuse", action: "safeDefault" },
  { limit: 4, outcome: "ask", action: "freshYes" },
  { limit: 4, outcome: "refuse", action: "saidWhatChanged" },
  { limit: 4, outcome: "wait", action: "toPerson" },
  { limit: 5, outcome: "ask", action: "nextOpenTimes" },
  { limit: 5, outcome: "refuse", action: "nothingBooked" },
  { limit: 6, outcome: "ask", action: "oneQuestion" },
  { limit: 6, outcome: "refuse", action: "nothingChanged" },
];

/** A script where part `part` fails `outcome`'s limit with it (limit 6 naming the field at fault). */
function failing(part: number, outcome: LimitOutcome, fields: readonly string[] = []): Script {
  const verdict = { result: "fail", outcome, ...(fields.length > 0 ? { fields } : {}) };
  return { [part]: { [outcome.limit]: verdict } };
}

/** decide's one Sonnet re-read ran (reread true, three reads), as limit 6's own outcome needs (K-09 v1). */
function afterReread(decided: Decided): Decided {
  const pair = copy(decided);
  const [first, second] = pair.decide.reads;
  pair.decide.reads = [first, second, { ...copy(first), model: "sonnet", role: "reread" }];
  pair.decide.reread = true;
  return pair;
}

/** K-02 v1's four refused decide outputs, each as the gate reads it, with the rule that refuses it. */
const REFUSED = refusedDecideOutputs();

describe("every K-02 v1 refused fixture is refused before any limit runs", () => {
  it.each(REFUSED)("%s is refused (decideRefused) and no limit runs", async (_file, decided, rule) => {
    const calls: LimitCall[] = [];
    const call = callContext();
    const verdict = await runGate(gateRequest(decided), call, scriptedLimits({}, calls));
    expect(verdict).toEqual({ verdict: "refused", error: { error: "decideRefused", rule, parts: [0] } });
    expect(calls).toEqual([]);
    expect(call.span.limits).toEqual([]);
  });

  it.each(REFUSED)(
    "%s is refused the same way with no limit built: the checks come first",
    async (_f, decided, rule) => {
      const calls: LimitCall[] = [];
      const verdict = await gate(decided, stubLimits(calls));
      expect(verdict).toEqual({ verdict: "refused", error: { error: "decideRefused", rule, parts: [0] } });
      expect(calls).toEqual([]);
    },
  );
});

describe("a two-part decide (decide-two-requests.json): a failure stops only its part", () => {
  it.each(EVERY_OUTCOME)(
    "part 2 fails limit $limit ($action): part 1 still passes, part 2 returns its outcome",
    async (outcome) => {
      const decided = outcome.limit === 6 ? afterReread(twoRequests()) : twoRequests();
      const calls: LimitCall[] = [];
      const fields = outcome.limit === 6 ? ["price"] : [];
      const parts = gatedParts(await gate(decided, scriptedLimits(failing(1, outcome, fields), calls)));
      expect(parts).toEqual([
        {
          part: 0,
          choiceId: "c-01",
          result: "passed",
          limits: PASS_ALL,
          stoppedBy: null,
          refusedBy: null,
          dependsOnPart: null,
        },
        {
          part: 1,
          choiceId: "c-04",
          result: "stopped",
          limits: failedAt(outcome.limit, outcome.action),
          stoppedBy: outcome,
          refusedBy: null,
          dependsOnPart: null,
        },
      ]);
      expect(calls).toEqual([...callsUpTo(0, 6), ...callsUpTo(1, outcome.limit)]);
    },
  );

  it("part 1 fails: part 2 still passes (neither part is on a booking, so neither depends on the other)", async () => {
    const outcome: LimitOutcome = { limit: 2, outcome: "refuse", action: "saidWhatRuleAllows" };
    const parts = gatedParts(await gate(twoRequests(), scriptedLimits(failing(0, outcome))));
    expect(parts.map((part) => [part.result, part.stoppedBy])).toEqual([
      ["stopped", outcome],
      ["passed", null],
    ]);
  });

  it("each part's result is K-09 v1's shape: the passed part committed with the keys the commit gives", async () => {
    const outcome: LimitOutcome = { limit: 4, outcome: "ask", action: "freshYes" };
    const parts = gatedParts(await gate(twoRequests(), scriptedLimits(failing(1, outcome))));
    const [first, second] = parts;
    if (first === undefined || second === undefined) throw new Error("two parts expected");
    expect(partResultOf(first)).toEqual({
      part: 0,
      choiceId: "c-01",
      result: "committed",
      limits: PASS_ALL,
      stoppedBy: null,
      gives: [],
      dependsOnPart: null,
    });
    expect(partResultOf(second, ["booking_rules"])).toEqual({
      part: 1,
      choiceId: "c-04",
      result: "stopped",
      limits: failedAt(4, "freshYes"),
      stoppedBy: outcome,
      gives: [],
      dependsOnPart: null,
    });
  });
});

describe("with no limit module built, every part is refused (fail closed), never passed", () => {
  it("decide-two-requests.json: both parts refused at limit 1; the gate throws, so the call answers notBuilt", async () => {
    const calls: LimitCall[] = [];
    const call = callContext();
    const error = await notBuilt(runGate(gateRequest(twoRequests()), call, stubLimits(calls)));
    expect(error.call).toBe("gateAndCommit");
    expect(error.limits).toEqual([1]);
    expect(error.parts.map((part) => [part.result, part.refusedBy, part.limits])).toEqual([
      ["refused", 1, failedAt(1, NOT_BUILT)],
      ["refused", 1, failedAt(1, NOT_BUILT)],
    ]);
    expect(calls).toEqual([
      { limit: 1, part: 0 },
      { limit: 1, part: 1 },
    ]);
    expect(call.span.limits).toEqual(failedAt(1, NOT_BUILT));
  });

  it.each(DECIDED_GATE_FIXTURES)("%s: every part is refused, none passed", async (file) => {
    const error = await notBuilt(gate(decidedOf(gateExchange(file)), stubLimits()));
    expect(error.parts.length).toBeGreaterThan(0);
    for (const part of error.parts) {
      expect(part.result).toBe("refused");
      expect(part.refusedBy).toBe(1);
    }
  });

  it.each(LIMIT_NUMBERS)(
    "limit %i alone not built: every part reaching it is refused, never passed",
    async (stub) => {
      const calls: LimitCall[] = [];
      const error = await notBuilt(gate(twoRequests(), scriptedLimits({}, calls, [stub])));
      expect(error.limits).toEqual([stub]);
      for (const part of error.parts) {
        expect(part).toMatchObject({ result: "refused", refusedBy: stub, limits: failedAt(stub, NOT_BUILT) });
      }
      expect(calls).toEqual([...callsUpTo(0, stub), ...callsUpTo(1, stub)]);
    },
  );

  it("a part a real limit stops keeps its outcome, and the call is still refused for the part a stub refused", async () => {
    const outcome: LimitOutcome = { limit: 1, outcome: "ask", action: "askedDecider" };
    const error = await notBuilt(gate(twoRequests(), scriptedLimits(failing(0, outcome), [], [3])));
    expect(error.parts.map((part) => part.result)).toEqual(["stopped", "refused"]);
    expect(error.limits).toEqual([3]);
  });

  it("the stub answers notBuilt for whatever part it is given, naming its own limit", async () => {
    for (const limit of LIMIT_NUMBERS) {
      const stub = notBuiltLimit(limit);
      expect(stub.limit).toBe(limit);
      const anyPart = { index: 0, part: twoRequests().decide.parts[0].part, choice: null } as never;
      await expect(stub.check(anyPart, {} as GateTurn)).resolves.toEqual({ result: "notBuilt" });
    }
  });

  it("a refused part is never answered as a K-09 part result", () => {
    const refused: GatedPart = {
      part: 0,
      choiceId: "c-01",
      result: "refused",
      limits: failedAt(2, NOT_BUILT),
      stoppedBy: null,
      refusedBy: 2,
      dependsOnPart: null,
    };
    expect(() => partResultOf(refused)).toThrow(LimitNotBuiltError);
  });

  it("the shipped registry holds limits 1 to 6, each in its own slot, in order", () => {
    expect(LIMITS.map((limit) => limit.limit)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("limits run per agreed part, in order", () => {
  it("each part takes limits 1 to 6 in order, parts in decide's order, the gate turn and the offered choice", async () => {
    const seen: string[] = [];
    const call = callContext("biz-lee-home-services");
    const decided = twoRequests();
    const watch = <N extends LimitNumber>(limit: N): Limit<N> => ({
      limit,
      check(part, turn) {
        expect(turn.repo).toBe(call.repo);
        expect(turn.businessId).toBe("biz-lee-home-services");
        expect(turn.decide).toEqual(decided.decide);
        const offered: Choice | undefined = decided.context.choices.find(
          (choice) => choice.choiceId === part.choice?.choiceId,
        );
        expect(part.choice).toEqual(offered);
        expect(part.part).toEqual(decided.decide.parts[part.index]?.part);
        seen.push(`${String(part.index)}:${String(limit)}`);
        return Promise.resolve({ result: "pass" });
      },
    });
    const limits: LimitRegistry = [watch(1), watch(2), watch(3), watch(4), watch(5), watch(6)];
    await runGate(gateRequest(decided), call, limits);
    expect(seen).toEqual([
      "0:1",
      "0:2",
      "0:3",
      "0:4",
      "0:5",
      "0:6",
      "1:1",
      "1:2",
      "1:3",
      "1:4",
      "1:5",
      "1:6",
    ]);
  });

  it("a limit that does not apply is logged notChecked, and the part still passes", async () => {
    const script: Script = { 0: { 5: { result: "notChecked" } } };
    const parts = gatedParts(await gate(twoRequests(), scriptedLimits(script)));
    expect(parts[0]?.limits[4]).toEqual({ limit: 5, result: "notChecked", outcome: null });
    expect(parts[0]?.result).toBe("passed");
  });

  it("a part decide ended in one question, or the verb ask, is asked; no limit runs for it", async () => {
    const decided = twoRequests();
    const second = decided.decide.parts[1];
    if (second === undefined) throw new Error("two parts expected");
    second.outcome = "oneQuestion";
    const calls: LimitCall[] = [];
    const parts = gatedParts(await gate(decided, scriptedLimits({}, calls)));
    expect(parts[1]).toEqual({
      part: 1,
      choiceId: "c-04",
      result: "asked",
      limits: NONE_CHECKED,
      stoppedBy: null,
      refusedBy: null,
      dependsOnPart: null,
    });
    expect(calls).toEqual(callsUpTo(0, 6));
    const asked = changePart(twoRequests(), 1, (part) => {
      becomes(part, { verb: "ask", quote: part.quote, questions: ["S11-12"], unclear: "Which setting?" });
    });
    const askedParts = gatedParts(await gate(asked, scriptedLimits()));
    expect(askedParts[1]).toMatchObject({ result: "asked", choiceId: null, limits: NONE_CHECKED });
  });

  it("no_op, redact and none_fits commit nothing: noAction, and no limit runs for them", async () => {
    const quote = "tile is $12 a foot from now on";
    const verbs: DecidePart[] = [
      { verb: "no_op", quote },
      { verb: "redact", quote, words: "tile is $12 a foot" },
      { verb: "none_fits", quote, why: "No offered choice is about tile prices." },
    ];
    for (const next of verbs) {
      const decided = changePart(twoRequests(), 1, (part) => {
        becomes(part, next);
      });
      const calls: LimitCall[] = [];
      const parts = gatedParts(await gate(decided, scriptedLimits({}, calls)));
      expect(parts[1]).toMatchObject({ result: "noAction", choiceId: null, limits: NONE_CHECKED });
      expect(calls).toEqual(callsUpTo(0, 6));
    }
  });

  it("pass_on and hand_off write in the commit, so the limits gate them", async () => {
    const quote = "tile is $12 a foot from now on";
    const verbs: DecidePart[] = [
      { verb: "pass_on", quote, words: "tile is $12 a foot" },
      { verb: "hand_off", quote, reason: "Sam asks for a person about prices.", about: "other" },
    ];
    for (const next of verbs) {
      const decided = changePart(twoRequests(), 1, (part) => {
        becomes(part, next);
      });
      const calls: LimitCall[] = [];
      const parts = gatedParts(await gate(decided, scriptedLimits({}, calls)));
      expect(parts[1]).toMatchObject({ result: "passed", choiceId: null, limits: PASS_ALL });
      expect(calls).toEqual([...callsUpTo(0, 6), ...callsUpTo(1, 6)]);
    }
  });

  it("a turn with no decided texts (a clock's firing, a core-only turn) has no part to gate", async () => {
    for (const file of ["clock-staff-invite-48h.json", "stop-recorded.json"]) {
      const calls: LimitCall[] = [];
      const verdict = await runGate(gateExchange(file).request, callContext(), scriptedLimits({}, calls));
      expect(verdict).toEqual({ verdict: "gated", parts: [] });
      expect(calls).toEqual([]);
    }
  });
});

/**
 * Alex's text with three parts (from K-09's A7-17 fixture context): "2, tonight at 9pm" picks A7-17's other time on the
 * Nov 14 booking; "running late" raises the any-time row on the same booking; "1 for the 21st" answers another
 * question, on another booking.
 */
function alexThreeParts(): Decided {
  const decided = copy(decidedOf(gateExchange("commit-limit-2-owner-rule.json")));
  const { context } = decided;
  context.texts[0].words = "2, tonight at 9pm and running late and 1 for the 21st";
  const [stand, other] = context.choices;
  if (other === undefined) throw new Error("two choices expected");
  const late: Choice = {
    ...copy(stand),
    choiceId: "c-03",
    kind: "anytime",
    label: "Running late",
    definition: "The customer is running late.",
    question: null,
    branch: null,
    anytimeRow: "running-late",
    fields: [],
  };
  const otherBooking: Choice = {
    ...copy(stand),
    choiceId: "c-04",
    question: "oq-a7-17-alex-nov21",
    target: { ...copy(stand.target), bookingId: "booking-alex-avery-nov21" },
  };
  context.choices = [stand, other, late, otherBooking];
  const [question] = context.openQuestions;
  if (question === undefined) throw new Error("no open question");
  context.openQuestions.push({
    ...copy(question),
    openQuestionId: "oq-a7-17-alex-nov21",
    target: copy(otherBooking.target),
  });
  const parts: DecidePart[] = [
    {
      verb: "choose",
      quote: "2, tonight at 9pm",
      question: "oq-a7-17-alex",
      choice: "c-02",
      fields: [{ name: "time", value: "tonight at 9pm", words: "tonight at 9pm" }],
    },
    { verb: "enter", quote: "running late", choice: "c-03", fields: [] },
    { verb: "choose", quote: "1 for the 21st", question: "oq-a7-17-alex-nov21", choice: "c-04", fields: [] },
  ];
  const [first, ...rest] = parts;
  if (first === undefined) throw new Error("no part");
  for (const read of decided.decide.reads) read.output.parts = [copy(first), ...copy(rest)];
  decided.decide.parts = [
    { part: copy(first), outcome: "go" },
    ...rest.map((part) => ({ part: copy(part), outcome: "go" as const })),
  ];
  return decided;
}

describe("a failure stops only its part and what depends on it: the parts on its booking", () => {
  it("the three parts hold: two on the Nov 14 booking, one on another", async () => {
    const parts = gatedParts(await gate(alexThreeParts(), scriptedLimits()));
    expect(parts.map((part) => part.result)).toEqual(["passed", "passed", "passed"]);
  });

  it("part 1 stopped: part 2, on its booking, stops too without running a limit; part 3 goes on", async () => {
    const outcome: LimitOutcome = { limit: 5, outcome: "ask", action: "nextOpenTimes" };
    const calls: LimitCall[] = [];
    const parts = gatedParts(await gate(alexThreeParts(), scriptedLimits(failing(0, outcome), calls)));
    expect(parts.map((part) => [part.result, part.dependsOnPart])).toEqual([
      ["stopped", null],
      ["dependsOnStopped", 0],
      ["passed", null],
    ]);
    expect(parts[1]?.limits).toEqual(NONE_CHECKED);
    expect(calls).toEqual([...callsUpTo(0, 5), ...callsUpTo(2, 6)]);
  });

  it("part 2 stopped: part 1, on its booking, stops too though its limits passed; part 3 goes on", async () => {
    const outcome: LimitOutcome = { limit: 1, outcome: "ask", action: "askedDecider" };
    const parts = gatedParts(await gate(alexThreeParts(), scriptedLimits(failing(1, outcome))));
    expect(parts.map((part) => [part.result, part.dependsOnPart])).toEqual([
      ["dependsOnStopped", 1],
      ["stopped", null],
      ["passed", null],
    ]);
    const [first] = parts;
    if (first === undefined) throw new Error("three parts expected");
    expect(first.limits).toEqual(PASS_ALL);
    expect(partResultOf(first)).toMatchObject({ result: "dependsOnStopped", dependsOnPart: 1 });
  });

  it("part 3 stopped: the parts on another booking go on", async () => {
    const outcome: LimitOutcome = { limit: 3, outcome: "ask", action: "freshReadBack" };
    const parts = gatedParts(await gate(alexThreeParts(), scriptedLimits(failing(2, outcome))));
    expect(parts.map((part) => part.result)).toEqual(["passed", "passed", "stopped"]);
  });

  it("a booking is one business's booking: the key holds both, and no booking depends on nothing", () => {
    const [stand] = alexThreeParts().context.choices;
    expect(bookingOf(stand)).toBe(JSON.stringify(["biz-lees-barbershop", "booking-alex-riley-nov14"]));
    const elsewhere: Choice = {
      ...copy(stand),
      target: { ...copy(stand.target), businessId: "biz-lee-tile" },
    };
    expect(bookingOf(elsewhere)).not.toBe(bookingOf(stand));
    expect(bookingOf({ ...copy(stand), target: { ...copy(stand.target), bookingId: null } })).toBeNull();
    expect(bookingOf(null)).toBeNull();
  });
});

describe("limit 6 waits for decide's one re-read (K-09 v1 rule rereadBeforeQuestion)", () => {
  it("before the re-read, a value that fails its words refuses the call, naming each part and field", async () => {
    const script: Script = {
      0: {
        6: {
          result: "fail",
          outcome: { limit: 6, outcome: "ask", action: "oneQuestion" },
          fields: ["block_when"],
        },
      },
      1: {
        6: {
          result: "fail",
          outcome: { limit: 6, outcome: "ask", action: "oneQuestion" },
          fields: ["price", "service", "price"],
        },
      },
    };
    const call = callContext();
    const verdict = await runGate(gateRequest(twoRequests()), call, scriptedLimits(script));
    expect(verdict).toEqual({
      verdict: "refused",
      error: {
        error: "valueFailsWords",
        parts: [
          { part: 0, fields: ["block_when"] },
          { part: 1, fields: ["price", "service"] },
        ],
      },
    });
    expect(call.span.limits[5]).toEqual({ limit: 6, result: "fail", outcome: VALUE_FAILS_WORDS });
  });

  it("only parts the gate checked are named: a part an earlier limit stopped is not", async () => {
    const script: Script = {
      0: { 2: { result: "fail", outcome: { limit: 2, outcome: "refuse", action: "saidWhatRuleAllows" } } },
      1: {
        6: {
          result: "fail",
          outcome: { limit: 6, outcome: "ask", action: "oneQuestion" },
          fields: ["price"],
        },
      },
    };
    const verdict = await gate(twoRequests(), scriptedLimits(script));
    expect(verdict).toEqual({
      verdict: "refused",
      error: { error: "valueFailsWords", parts: [{ part: 1, fields: ["price"] }] },
    });
  });

  it("after the re-read, limit 6's own outcome stops the part", async () => {
    const outcome: LimitOutcome = { limit: 6, outcome: "refuse", action: "nothingChanged" };
    const parts = gatedParts(
      await gate(afterReread(twoRequests()), scriptedLimits(failing(0, outcome, ["block_when"]))),
    );
    expect(parts[0]).toMatchObject({
      result: "stopped",
      stoppedBy: outcome,
      limits: failedAt(6, "nothingChanged"),
    });
    expect(parts[1]?.result).toBe("passed");
  });
});

describe("each K-09 v1 gate fixture's result comes out as the fixture states it", () => {
  it.each(DECIDED_GATE_FIXTURES)("%s", async (file) => {
    const exchange = gateExchange(file);
    const calls: LimitCall[] = [];
    const verdict = await runGate(
      exchange.request,
      callContext(),
      scriptedLimits(fixtureScript(exchange), calls),
    );
    const { outcome } = exchange;
    if ("error" in outcome) {
      expect(verdict).toEqual({ verdict: "refused", error: outcome });
      return;
    }
    if (outcome.result !== "committed") throw new Error("a committed fixture expected");
    const answered = gatedParts(verdict).map((part, index) =>
      partResultOf(part, outcome.parts[index]?.gives ?? []),
    );
    expect(answered).toEqual(outcome.parts);
    // No limit after the one that failed ever ran.
    for (const part of outcome.parts) {
      const failed = part.stoppedBy?.limit ?? 6;
      expect(calls.filter((each) => each.part === part.part)).toEqual(callsUpTo(part.part, failed));
    }
  });
});

describe("a limit answering outside its interface fails the call: nothing passes", () => {
  const cases: [string, string, Script][] = [
    [
      "another limit's outcome",
      "wrongLimit",
      {
        1: { 2: { result: "fail", outcome: { limit: 3, outcome: "ask", action: "freshReadBack" } } },
      } as never,
    ],
    [
      "an action with another kind",
      "wrongAction",
      { 1: { 4: { result: "fail", outcome: { limit: 4, outcome: "ask", action: "toPerson" } } } } as never,
    ],
    [
      "a field the part does not carry",
      "fieldNotCarried",
      {
        1: {
          3: {
            result: "fail",
            outcome: { limit: 3, outcome: "ask", action: "freshReadBack" },
            fields: ["tip"],
          },
        },
      },
    ],
    [
      "limit 6 failing before the re-read with no field named",
      "noFields",
      { 1: { 6: { result: "fail", outcome: { limit: 6, outcome: "ask", action: "oneQuestion" } } } },
    ],
    ["an answer that is no verdict", "unknownVerdict", { 1: { 2: { result: "maybe" } } } as never],
  ];
  it.each(cases)("%s throws GateLimitError (%s)", async (_name, fault, script) => {
    const decided = twoRequests();
    const run = gate(decided, scriptedLimits(script));
    await expect(run).rejects.toThrow(GateLimitError);
    const error: unknown = await run.catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ fault, part: 1 });
    const message = error instanceof Error ? error.message : "";
    for (const words of wordsIn(decided).filter((each) => each.length >= 3))
      expect(message).not.toContain(words);
  });

  it("a limit's own throw passes through: the call fails, never passes", async () => {
    const broken: Limit<3> = { limit: 3, check: () => Promise.reject(new Error("limit 3 could not read")) };
    const [one, two, , four, five, six] = scriptedLimits();
    await expect(gate(twoRequests(), [one, two, broken, four, five, six])).rejects.toThrow(
      "limit 3 could not read",
    );
  });

  it("a registry whose slots are out of order is refused before any limit runs", async () => {
    const calls: LimitCall[] = [];
    const [one, two, three, four, five, six] = scriptedLimits({}, calls);
    const swapped = [one, three, two, four, five, six] as unknown as LimitRegistry;
    await expect(gate(twoRequests(), swapped)).rejects.toMatchObject({ fault: "wrongSlot", limit: 2 });
    expect(calls).toEqual([]);
  });
});

describe("the gate span logs limits 1 to 6", () => {
  it("one result per limit: fail with the first failing part's outcome, else pass, else notChecked", async () => {
    const script: Script = {
      0: { 5: { result: "notChecked" } },
      1: { 4: { result: "fail", outcome: { limit: 4, outcome: "refuse", action: "saidWhatChanged" } } },
    };
    const call = callContext();
    await runGate(gateRequest(twoRequests()), call, scriptedLimits(script));
    expect(call.span.limits).toEqual([
      { limit: 1, result: "pass", outcome: null },
      { limit: 2, result: "pass", outcome: null },
      { limit: 3, result: "pass", outcome: null },
      { limit: 4, result: "fail", outcome: "saidWhatChanged" },
      { limit: 5, result: "notChecked", outcome: null },
      { limit: 6, result: "pass", outcome: null },
    ]);
  });

  it("gating the same turn again replaces the span's limits (a reload after the commit gates again)", async () => {
    const call = callContext();
    await runGate(gateRequest(twoRequests()), call, scriptedLimits());
    await runGate(gateRequest(twoRequests()), call, scriptedLimits());
    expect(call.span.limits).toEqual(PASS_ALL);
  });
});

describe("K-09 v1's outcomes, as the gate holds them", () => {
  it("each limit's actions and their kinds are K-09 v1's limit1Outcome to limit6Outcome", () => {
    const schema = contractFile("tool-api/tool-api.v1.schema.json") as {
      $defs: Record<string, { oneOf: { properties: Record<string, { const?: number; enum?: string[] }> }[] }>;
    };
    const fromSchema: Record<number, Record<string, string>> = {};
    for (const limit of LIMIT_NUMBERS) {
      const definition = schema.$defs[`limit${String(limit)}Outcome`];
      if (definition === undefined) throw new Error(`no limit${String(limit)}Outcome`);
      const actions: Record<string, string> = {};
      for (const branch of definition.oneOf) {
        expect(branch.properties.limit?.const).toBe(limit);
        const [action] = branch.properties.action?.enum ?? [];
        const [kind] = branch.properties.outcome?.enum ?? [];
        if (action === undefined || kind === undefined)
          throw new Error("an outcome without its action or kind");
        actions[action] = kind;
      }
      fromSchema[limit] = actions;
    }
    expect(LIMIT_ACTIONS).toEqual(fromSchema);
    expect(EVERY_OUTCOME.map((outcome) => `${String(outcome.limit)} ${outcome.action}`)).toEqual(
      LIMIT_NUMBERS.flatMap((limit) =>
        Object.keys(fromSchema[limit] ?? {}).map((action) => `${String(limit)} ${action}`),
      ),
    );
  });
});
