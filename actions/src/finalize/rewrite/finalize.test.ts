// Tests of the finalize call (T-313, C-093; K-09 v1 finalizeMessage; arch 02 line 123; arch 07 line 417), run through the
// Tool API base, which holds every request and answer to K-09 v1's frozen schema. The slot filler (T-310), the claim check
// (T-311) and the message checks (T-312) run for real; the row read, T-314's fixed lines and the K-05 and K-37 writes are
// a fake repo (test-support.ts). Values are the master's sample cast (rule 9). Round 2 follows the lead's rulings
// (DL-158): (a) Rosie's own fixed terms leave the Shape and Length counts; (b) the step's fallback is never cut; (c) no
// check detail and no rewrite request holds a filled value.

import { describe, expect, it } from "vitest";

import { CHECK_NAMES, runMessageChecks } from "../checks";
import { NotBuiltError } from "../../tool-api";
import { QUESTION_CUT } from "../index";
import { outcomeOf, type AttemptCheck } from "./attempt";
import { FinalizeRefusedError } from "./errors";
import { claimFallback } from "./fallback";
import { PASSED_ON_REVIEW } from "./types";
import { rewriteTold, withoutValues } from "./told";
import {
  A7_17_FALLBACK,
  a717Row,
  a717Source,
  exchange,
  fakeRepo,
  openerFirst,
  runFinalize,
  s102Row,
  stringsIn,
  type CallRun,
} from "./test-support";
import type { CheckResult, FinalizeRequest, FinalizeResponse, FinalizeRow } from "./types";
import type { SlotSource } from "../slots";

const PASS = exchange("finalize-pass.json");
const REWRITE = exchange("finalize-rewrite.json");
const PASSED_ON = exchange("finalize-passed-on.json");

/** The answer as a K-09 v1 response; fails the test when it is an error or a base refusal. */
function responseOf(run: CallRun): FinalizeResponse {
  expect(run.answer, JSON.stringify(run.answer)).toHaveProperty("outcome");
  return run.answer as FinalizeResponse;
}

/** The checks a result missed, in order. */
const missedIn = (result: CheckResult): string[] =>
  result.checks.filter((check) => !check.passed).map((check) => check.check);

/** The detail of one check of a result. */
const detailOf = (result: CheckResult | undefined, name: string): string | null | undefined =>
  result?.checks.find((check) => check.check === name)?.detail;

/**
 * A response with each detail's words left out (whether a check has a detail stays): the wording of a detail is T-312's
 * (checks/checks.ts, checks/values.ts), asserted on its own.
 */
const withoutDetails = (response: FinalizeResponse): unknown => ({
  ...response,
  checks: response.checks.map((result) => ({
    ...result,
    checks: result.checks.map((check) => ({ ...check, detail: check.detail === null ? null : "(a detail)" })),
  })),
});

/** A request for the same row with another plan, as the composer would send it. */
function withPlan(
  base: FinalizeRequest,
  plan: Partial<FinalizeRequest["plan"]["plan"]>,
  attempt: FinalizeRequest["attempt"] = base.attempt,
): FinalizeRequest {
  return { ...base, attempt, plan: { ...base.plan, plan: { ...base.plan.plan, ...plan } } };
}

/** A7-17's slot source with more facts. */
function a717With(facts: Partial<SlotSource["facts"]>): SlotSource {
  const source = a717Source();
  return { ...source, facts: { ...source.facts, ...facts } };
}

/** The A7-17 row with its step's options: two buttons, one label past 24 characters (a Shape miss, never a block). */
function a717WithOptions(): FinalizeRow {
  const row = a717Row();
  return {
    ...row,
    checks: {
      ...row.checks,
      options: [
        { id: "A7-17/1", label: "Keep my visit with the new pro" },
        { id: "A7-17/2", label: "Call off the visit" },
      ],
    },
  };
}

const POLL_PLAN: Partial<FinalizeRequest["plan"]["plan"]> = {
  formats: ["text", "poll"],
  lines: [{ role: "first", text: "{{pro.name}} can't be in on {{day}}." }],
  question: { text: "Keep your visit, or call it off?", optionIds: ["A7-17/1", "A7-17/2"] },
};

/** How T-310's filler words finalize-passed-on.json's 7pm deadline (test-support.ts ASK_BY). */
const ASK_BY_WORDS = "7:00pm Fri";

/**
 * finalize-passed-on.json's outcome as the call gives it: every field the fixture's word for word but these, each a
 * fixture error or test data (CQ-90; DL-158 ruling b):
 *   - the rewrite's slotValues: K-03 `slotValues` is "each slot filled and the code-supplied value it took", and the
 *     rewrite's plan fills {{day}} alone. The fixture also lists pro.name and visit.time, row facts that no slot filled,
 *     and name.staff "Avery", which K-03 slots.json's audience (owner and staff) never gives customer Alex (CQ-90 (a));
 *   - the fallback's ask.by: the fixture's "7pm" is test data (CQ-90 (c)); T-310's filler words that 7pm deadline
 *     "7:00pm Fri", in K-03 slots.json's form for ask.by ("9:00am Sat"), in the text and in slotValues alike;
 *   - teamPageId: null, since paging Rosie's team is T-319's (the card's "Not here").
 */
function passedOnOutcome(): FinalizeResponse {
  const outcome = structuredClone(PASSED_ON.outcome);
  const [rewrite, fallback] = outcome.checks;
  if (fallback === undefined) throw new Error("finalize-passed-on.json has two check results");
  rewrite.checked.slotValues = [{ slot: "day", value: "Sat Oct 24" }];
  const [words] = fallback.checked.sends;
  words.text = words.text?.replace("Please reply by 7pm.", `Please reply by ${ASK_BY_WORDS}.`) ?? null;
  fallback.checked.slotValues = fallback.checked.slotValues.map((fact) =>
    fact.slot === "ask.by" ? { slot: fact.slot, value: ASK_BY_WORDS } : fact,
  );
  outcome.teamPageId = null;
  return outcome;
}

// ---------------------------------------------------------------------------------------------------------------

describe("finalize-pass.json: S1-02's plan, the opener added, Rosie's own terms stated, every value code-supplied", () => {
  it("gives the fixture's result word for word: outcome send, every check passed, the final parts written with the plan", async () => {
    const repo = fakeRepo(s102Row(), openerFirst);
    const run = await runFinalize(PASS.request, repo.ports);

    expect(run.answer).toEqual(PASS.outcome);
    expect(repo.calls.writes).toEqual([
      {
        outboxRowId: "outbox-s1-02-sam-1",
        expectVersion: 1,
        plan: PASS.request.plan,
        finalParts: PASS.outcome.finalParts,
      },
    ]);
    expect(repo.calls.cancels).toEqual([]);
    expect(repo.calls.reviews).toEqual([]);
    expect(run.ended).toBe("commit");
    expect(run.notes).toEqual([
      { row: "outbox-s1-02-sam-1", attempt: "composed", outcome: "send", missed: [] },
    ]);
  });

  it("the row's terms are what keep the card's line out of the counts: with none, it is 26 words of the model's", async () => {
    // The same row with no terms given: Length and reading counts the card's fact line, one sentence of 26 words, as the
    // model's own (arch 07 line 413), so the composed plan gets its one rewrite and nothing is written.
    const row = s102Row();
    const repo = fakeRepo({ ...row, checks: { ...row.checks, terms: [] } }, openerFirst);
    const response = responseOf(await runFinalize(PASS.request, repo.ports));
    const [composed] = response.checks;

    expect(response.outcome).toBe("rewrite");
    expect(missedIn(composed)).toEqual(["lengthAndReading"]);
    expect(detailOf(composed, "lengthAndReading")).toContain("has 26 words");
    expect(composed.checked).toEqual(PASS.outcome.finalParts);
    expect(repo.calls.writes).toEqual([]);
  });

  it("a second call for the same row finds it planned: its final parts come back unchanged, nothing more written", async () => {
    const repo = fakeRepo(s102Row(), openerFirst);
    await runFinalize(PASS.request, repo.ports);
    const again = await runFinalize({ ...PASS.request, attempt: "rewrite" }, repo.ports);

    expect(again.answer).toEqual({
      error: "alreadyPlanned",
      outboxRowId: "outbox-s1-02-sam-1",
      finalParts: PASS.outcome.finalParts,
    });
    expect(repo.calls.writes).toHaveLength(1);
    expect(again.notes).toEqual([]);
  });

  it("with every check passing, the composed plan sends at once: outcome send, its final parts written", async () => {
    const repo = fakeRepo(s102Row(), openerFirst);
    const short = withPlan(PASS.request, {
      lines: [
        {
          role: "first",
          text: "I'll set up your business so AI assistants like ChatGPT, Claude and Gemini can book you.",
        },
      ],
    });
    const response = responseOf(await runFinalize(short, repo.ports));
    const [composed] = response.checks;

    expect(response.outcome).toBe("send");
    expect(response.checks).toHaveLength(1);
    expect(composed.checks.every((check) => check.passed)).toBe(true);
    expect(composed.outcome).toBe("send");
    expect(response.finalParts?.fixedLines).toEqual(["opener"]);
    expect(response.finalParts?.sends[0].text).toBe(
      "Hi! I'm Rosie, an automated assistant. I'll set up your business so AI assistants like ChatGPT, Claude and Gemini can book you.\nWhat kinds of work do you do? Just type them.",
    );
    expect(repo.calls.writes.map((write) => write.finalParts)).toEqual([response.finalParts]);
    expect(response.questionWithdrawn).toBe(false);
    expect(response.teamPageId).toBeNull();
  });
});

describe("finalize-rewrite.json: A7-17's plan names a time no fact holds, so Values blocks and the composer gets one rewrite", () => {
  it("gives the fixture's result: outcome rewrite, every field word for word, Values failed, nothing written", async () => {
    const repo = fakeRepo(a717Row());
    const run = await runFinalize(REWRITE.request, repo.ports);
    const response = responseOf(run);
    const [composed] = response.checks;

    // Every field as the fixture states it; the words of the one detail are T-312's, asserted below.
    expect(withoutDetails(response)).toEqual(withoutDetails(REWRITE.outcome));
    // The fixture's detail goes on "the visit is at {{visit.time}}"; T-312's advice reads "write each time as its slot"
    // (it names the time slots among the attempt's slot values, and this plan filled none), and it names Avery too,
    // whom no code-supplied fact holds for Alex.
    expect(detailOf(composed, "values")).toContain("The time 10:30am is not a code-supplied fact;");
    expect(detailOf(composed, "values")).toContain("The name Avery is not a code-supplied fact;");
    // Nothing written, no question withdrawn, no review item.
    expect(repo.calls.writes).toEqual([]);
    expect(repo.calls.cancels).toEqual([]);
    expect(repo.calls.reviews).toEqual([]);
    expect(run.notes).toEqual([
      { row: "outbox-a7-17-alex-text", attempt: "composed", outcome: "rewrite", missed: ["values"] },
    ]);
  });

  it("the rewrite is told each failed check and its detail by slot names and reasons, never a filled value or the parts", async () => {
    const response = responseOf(await runFinalize(REWRITE.request, fakeRepo(a717Row()).ports));
    const told = rewriteTold(response.checks[0]);

    expect(told.map((item) => item.check)).toEqual(["values"]);
    expect(told[0]?.detail).toContain("The time 10:30am is not a code-supplied fact");
    // The filled day (Sat Oct 24) and every other value code holds for Alex never reach the model.
    const text = JSON.stringify(told);
    for (const value of [
      "Sat Oct 24",
      "11:00am",
      "Lee's Barbershop",
      "rosfield.com/v/s03",
      "+15555550177",
      "5160",
    ])
      expect(text).not.toContain(value);
    expect(Object.keys(told[0] ?? {}).sort()).toEqual(["check", "detail"]);
  });

  it("a detail that holds a filled value is told with the value written as its slot", () => {
    const result: CheckResult = {
      row: "outbox-a7-17-alex-text",
      attempt: "composed",
      checked: {
        row: "outbox-a7-17-alex-text",
        channel: "imessage",
        sends: [{ kind: "words", text: "x", calendarFile: "none", options: [], link: null }],
        fixedLines: [],
        slotValues: [
          { slot: "visit.code", value: "5160" },
          { slot: "day", value: "Sat Oct 24" },
        ],
        threadReplyTo: null,
      },
      checks: CHECK_NAMES.map((name) =>
        name === "lengthAndReading"
          ? {
              check: name,
              passed: false,
              detail: 'The sentence "Give code 5160 on Sat Oct 24 ..." has 30 words.',
            }
          : { check: name, passed: true, detail: null },
      ) as CheckResult["checks"],
      outcome: "rewrite",
      questionWithdrawn: false,
      teamPaged: false,
    };
    expect(rewriteTold(result)).toEqual([
      {
        check: "lengthAndReading",
        detail: 'The sentence "Give code {{visit.code}} on {{day}} ..." has 30 words.',
      },
    ]);
  });
});

describe("finalize-passed-on.json: the rewrite fails Values, the step's fallback fails too, so the passed-on line goes", () => {
  it("gives the fixture's result: passedOn, the passed-on line written, the question withdrawn; each fixture error named", async () => {
    const repo = fakeRepo(a717Row());
    const run = await runFinalize(PASSED_ON.request, repo.ports);
    const response = responseOf(run);
    const [rewrite, fallback] = response.checks;
    const [statedRewrite, statedFallback] = PASSED_ON.outcome.checks;

    // The fixture as it stands, for the differences passedOnOutcome() names.
    expect(statedRewrite.checked.slotValues.map((fact) => fact.slot)).toEqual([
      "pro.name",
      "name.staff",
      "day",
      "visit.time",
    ]);
    expect(statedFallback?.checked.sends[0].text).toContain("Please reply by 7pm.");
    expect(PASSED_ON.outcome.teamPageId).toBe("page-alex-a7-17-passed-on");

    // Every other field word for word: the outcome, both attempts' checked parts (the fallback keeps "{{name.staff}}"),
    // which checks failed, each attempt's outcome, the passed-on line as the final parts, the question withdrawn.
    expect(withoutDetails(response)).toEqual(withoutDetails(passedOnOutcome()));
    expect(response.finalParts).toEqual(PASSED_ON.outcome.finalParts);
    // The fallback's Values detail word for word: it names the slot left in the text.
    expect(detailOf(fallback, "values")).toBe(detailOf(statedFallback, "values"));
    expect(detailOf(fallback, "values")).toBe(
      "The slot {{name.staff}} has no value, so '{{' is left in the text.",
    );
    // The rewrite's Values detail in T-312's words (see finalize-rewrite.json's test).
    expect(detailOf(rewrite, "values")).toContain("The time 10:30am is not a code-supplied fact;");
    expect(run.ended).toBe("commit");
    expect(run.notes).toEqual([
      { row: "outbox-a7-17-alex-text", attempt: "rewrite", outcome: "fallback", missed: ["values"] },
      { row: "outbox-a7-17-alex-text", attempt: "fallback", outcome: "passedOn", missed: ["values"] },
    ]);
  });

  it("withdraws the open question with its clock row and opens one review item (fake repo)", async () => {
    const repo = fakeRepo(a717Row());
    const run = await runFinalize(PASSED_ON.request, repo.ports);
    responseOf(run);

    // The passed-on line, written once with the plan.
    expect(repo.calls.writes).toHaveLength(1);
    expect(repo.calls.writes[0]?.finalParts).toEqual(PASSED_ON.outcome.finalParts);
    expect(repo.calls.writes[0]?.plan).toEqual(PASSED_ON.request.plan);
    // The question withdrawn with its clock row, in one K-05 v1 cancelClock (item 5), so no clock arms (RULES 5.2).
    expect(repo.calls.cancels).toEqual([
      {
        clockRowId: "clock-oq-a7-17-alex",
        expectVersion: 1,
        withdrawQuestion: { openQuestionId: "oq-a7-17-alex", expectVersion: 1 },
        at: "2026-10-23T13:00:09Z",
      },
    ]);
    expect(repo.row()?.question).toBeNull();
    // One review item for Rosie's team, about this row, with no value in its summary (K-37 v1 rule 4).
    expect(repo.calls.reviews).toHaveLength(1);
    const review = repo.calls.reviews[0];
    expect(review?.kind).toBe(PASSED_ON_REVIEW);
    expect(review?.subject).toEqual({ table: "outbox_rows", rowId: "outbox-a7-17-alex-text" });
    expect(review?.caller).toEqual(PASSED_ON.request.caller);
    for (const value of ["Riley", "Alex", "Sat Oct 24", "10:30am", "Lee's Barbershop", "Haircut"])
      expect(review?.summary).not.toContain(value);
    // The call's span keeps the rows it wrote, by id.
    expect(run.rows).toEqual([
      { table: "outbox_rows", id: "outbox-a7-17-alex-text" },
      { table: "clock_rows", id: "clock-oq-a7-17-alex" },
      { table: "open_questions", id: "oq-a7-17-alex" },
      { table: "review_items", id: "review-outbox-a7-17-alex-text" },
    ]);
  });

  it("the step's fallback is never cut: name.staff, which Alex may never see, stays as written even with a value", async () => {
    const repo = fakeRepo(a717Row(a717With({ otherName: "Avery" })));
    const response = responseOf(await runFinalize(PASSED_ON.request, repo.ports));
    const fallback = response.checks[1];

    expect(A7_17_FALLBACK).toContain("{{name.staff}} can come in early");
    // Every sentence of the master's words is kept; the slot Alex may not see is never filled, so '{{' stays.
    expect(fallback?.checked.sends[0].text).toBe(
      `Sorry, Riley can't be in on Sat Oct 24. {{name.staff}} can come in early to do your visit, same time and price. Please reply by ${ASK_BY_WORDS}.`,
    );
    expect(fallback?.checked.slotValues).toEqual([
      { slot: "pro.name", value: "Riley" },
      { slot: "day", value: "Sat Oct 24" },
      { slot: "ask.by", value: ASK_BY_WORDS },
    ]);
    expect(detailOf(fallback, "values")).toBe(
      "The slot {{name.staff}} has no value, so '{{' is left in the text.",
    );
    expect(response.outcome).toBe("passedOn");
    // Avery's name, the value code holds, is in nothing the fallback checked and in no final parts written (the plan
    // written with them keeps the composer's own words).
    expect(JSON.stringify(fallback)).not.toContain("Avery");
    expect(JSON.stringify(repo.calls.writes.map((write) => write.finalParts))).not.toContain("Avery");
  });

  it("for a reader who may see every slot of it (the owner), the same fallback is filled and sent, with two check results", async () => {
    const row: FinalizeRow = { ...a717Row(a717With({ otherName: "Avery" })), reader: "owner" };
    const repo = fakeRepo(row);
    const response = responseOf(await runFinalize(PASSED_ON.request, repo.ports));

    expect(response.outcome).toBe("send");
    expect(response.checks.map((check) => [check.attempt, check.outcome])).toEqual([
      ["rewrite", "fallback"],
      ["fallback", "send"],
    ]);
    expect(response.finalParts?.sends[0].text).toBe(
      `Sorry, Riley can't be in on Sat Oct 24. Avery can come in early to do your visit, same time and price. Please reply by ${ASK_BY_WORDS}.`,
    );
    expect(repo.calls.writes.map((write) => write.finalParts)).toEqual([response.finalParts]);
    expect(repo.calls.cancels).toEqual([]);
    expect(repo.calls.reviews).toEqual([]);
  });

  it("a step with no fallback text is passed on straight after the rewrite: one check result, outcome passedOn", async () => {
    const repo = fakeRepo({ ...a717Row(), fallbackText: null });
    const response = responseOf(await runFinalize(PASSED_ON.request, repo.ports));

    expect(response.outcome).toBe("passedOn");
    expect(
      response.checks.map((check) => [
        check.attempt,
        check.outcome,
        check.questionWithdrawn,
        check.teamPaged,
      ]),
    ).toEqual([["rewrite", "passedOn", true, true]]);
    expect(response.finalParts).toEqual(PASSED_ON.outcome.finalParts);
    expect(repo.calls.cancels).toHaveLength(1);
    expect(repo.calls.reviews).toHaveLength(1);
  });
});

describe("the step's fallback through limit 7 and the fill (claimFallback)", () => {
  it("keeps a held-back slot as written, example words and all; a secure-page-only one reads the secure page's words", () => {
    const source = a717With({
      otherName: "Avery",
      visit: {
        start: { utc: "2026-10-24T15:00:00Z", zone: "America/New_York" },
        place: "88 Elm St, Springfield",
      },
    });
    const held = claimFallback("Ask {{name.staff:Dee W.}}. Where: {{visit.place}}.", source, {
      reader: "customer",
    });

    expect(held.ok).toBe(false);
    expect(held.text).toBe("Ask {{name.staff:Dee W.}}. Where: Read it on the secure page.");
    expect(held.slotValues).toEqual([]);
    expect(held.problems.map((problem) => problem.detail)).toEqual([
      "The slot {{name.staff}} has no value, so '{{' is left in the text.",
    ]);
    expect(JSON.stringify(held)).not.toContain("Avery");
    expect(JSON.stringify(held)).not.toContain("88 Elm");
  });

  it("keeps each place of a held-back slot, and fills the rest of the sentence around it", () => {
    const held = claimFallback(
      "{{name.staff}} and {{name.staff}} can see you on {{day}}.",
      a717With({ otherName: "Avery" }),
      { reader: "customer" },
    );
    expect(held.text).toBe("{{name.staff}} and {{name.staff}} can see you on Sat Oct 24.");
    expect(held.slotValues).toEqual([{ slot: "day", value: "Sat Oct 24" }]);
    expect(held.problems.map((problem) => problem.slot)).toEqual(["name.staff"]);
  });

  it("refuses a text whole, nothing filled, for a broken piece, and for a character code keeps for itself", () => {
    const customer = { reader: "customer" } as const;
    for (const text of ["Sorry, {{pro.name}} can't }} be in.", "Ask {{{name.staff}}} on {{day}}."]) {
      const broken = claimFallback(text, a717With({ otherName: "Avery" }), customer);
      expect([broken.ok, broken.text, broken.slotValues], text).toEqual([false, text, []]);
      expect(
        broken.problems.map((problem) => problem.detail),
        text,
      ).toEqual(["A '{{' opens no slot or a '}}' closes none, so nothing in the text is filled."]);
    }
    const own = `Sorry, {{pro.name}} ${String.fromCodePoint(0xe000)} can't be in.`;
    const marked = claimFallback(own, a717Source(), customer);
    expect([marked.ok, marked.text, marked.slotValues]).toEqual([false, own, []]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("a blocking miss gets exactly one rewrite", () => {
  it("composed: one rewrite; the rewrite: the fallback, never a second rewrite; then the row keeps its plan", async () => {
    const repo = fakeRepo(a717Row());
    const first = responseOf(await runFinalize(REWRITE.request, repo.ports));
    const second = responseOf(await runFinalize(PASSED_ON.request, repo.ports));
    const third = await runFinalize(PASSED_ON.request, repo.ports);

    expect(first.outcome).toBe("rewrite");
    expect(second.outcome).not.toBe("rewrite");
    expect(second.checks.map((check) => check.outcome)).not.toContain("rewrite");
    // A third call finds the row planned: its final parts come back unchanged, and nothing more is written.
    expect(third.answer).toEqual({
      error: "alreadyPlanned",
      outboxRowId: "outbox-a7-17-alex-text",
      finalParts: second.finalParts,
    });
    expect(repo.calls.writes).toHaveLength(1);
  });

  it("for every check standing, only the composed plan is ever told to rewrite", () => {
    const passed: AttemptCheck = { checks: [], passed: true, blocked: false, onlyLogged: false, missed: [] };
    const blocked: AttemptCheck = {
      checks: [],
      passed: false,
      blocked: true,
      onlyLogged: false,
      missed: ["values"],
    };
    const shape: AttemptCheck = {
      checks: [],
      passed: false,
      blocked: false,
      onlyLogged: false,
      missed: ["shape"],
    };
    const lines: AttemptCheck = {
      checks: [],
      passed: false,
      blocked: false,
      onlyLogged: true,
      missed: ["shape"],
    };
    for (const check of [passed, blocked, shape, lines]) {
      for (const hasFallback of [true, false]) {
        expect(outcomeOf("rewrite", check, hasFallback)).not.toBe("rewrite");
        expect(outcomeOf("fallback", check, hasFallback)).not.toBe("rewrite");
        expect(outcomeOf("fallback", check, hasFallback)).not.toBe("fallback");
      }
    }
    expect(outcomeOf("composed", blocked, false)).toBe("rewrite");
    expect(outcomeOf("rewrite", blocked, true)).toBe("fallback");
    expect(outcomeOf("rewrite", blocked, false)).toBe("passedOn");
    expect(outcomeOf("fallback", blocked, true)).toBe("passedOn");
    expect(outcomeOf("composed", shape, true)).toBe("rewrite");
    expect(outcomeOf("rewrite", shape, true)).toBe("sendAndLog");
    expect(outcomeOf("composed", lines, true)).toBe("sendAndLog");
  });

  it("a text limit 7 refuses whole blocks and is never written, even where the seven checks see no '{{'", async () => {
    const repo = fakeRepo(a717Row());
    const broken = withPlan(PASSED_ON.request, {
      lines: [{ role: "first", text: "Riley can't be in on }} Sat." }],
    });
    const response = responseOf(await runFinalize(broken, repo.ports));
    const [rewrite] = response.checks;

    expect(detailOf(rewrite, "values")).toContain("closes none, so nothing in the text is filled.");
    expect(rewrite.outcome).toBe("fallback");
    for (const write of repo.calls.writes) expect(JSON.stringify(write.finalParts)).not.toContain("}}");
  });

  it("a question limit 7 cuts whole is a blocking miss the rewrite is told of", async () => {
    const plan = withPlan(REWRITE.request, {
      lines: [{ role: "first", text: "Riley can't be in on {{day}}." }],
      question: { text: "Can {{name.staff}} do it instead?", optionIds: [] },
    });
    const response = responseOf(await runFinalize(plan, fakeRepo(a717Row()).ports));

    expect(response.outcome).toBe("rewrite");
    expect(detailOf(response.checks[0], "values")).toContain(QUESTION_CUT);
  });
});

describe("a shape miss after one rewrite is only logged and the message goes", () => {
  it("composed: a button past 24 characters gets the one rewrite; after it the message is written and logged", async () => {
    const repo = fakeRepo(a717WithOptions());
    const composed = await runFinalize(withPlan(REWRITE.request, POLL_PLAN, "composed"), repo.ports);
    const rewrite = await runFinalize(withPlan(REWRITE.request, POLL_PLAN, "rewrite"), repo.ports);
    const first = responseOf(composed);
    const second = responseOf(rewrite);

    expect(first.outcome).toBe("rewrite");
    expect(missedIn(first.checks[0])).toEqual(["shape"]);
    expect(detailOf(first.checks[0], "shape")).toContain("is over 24 characters");

    expect(second.outcome).toBe("sendAndLog");
    expect(second.checks.map((check) => check.outcome)).toEqual(["sendAndLog"]);
    expect(second.finalParts?.sends.map((send) => send.kind)).toEqual(["words", "poll"]);
    expect(second.finalParts?.sends[1]?.options).toEqual([
      { id: "A7-17/1", label: "Keep my visit with the new pro" },
      { id: "A7-17/2", label: "Call off the visit" },
    ]);
    expect(repo.calls.writes.map((write) => write.finalParts)).toEqual([second.finalParts]);
    expect([...composed.notes, ...rewrite.notes]).toEqual([
      { row: "outbox-a7-17-alex-text", attempt: "composed", outcome: "rewrite", missed: ["shape"] },
      { row: "outbox-a7-17-alex-text", attempt: "rewrite", outcome: "sendAndLog", missed: ["shape"] },
    ]);
  });

  it("a message past four fact lines is only logged, even before any rewrite", async () => {
    const repo = fakeRepo(a717Row());
    const lines = Array.from({ length: 7 }, () => ({
      role: "fact" as const,
      text: "{{pro.name}} · {{day}}",
    }));
    const response = responseOf(
      await runFinalize(withPlan(REWRITE.request, { lines }, "composed"), repo.ports),
    );

    expect(response.outcome).toBe("sendAndLog");
    expect(missedIn(response.checks[0])).toEqual(["shape"]);
    expect(repo.calls.writes).toHaveLength(1);
  });

  it("the notes are labels only: no value, no detail and no words of the text", async () => {
    const runs = [
      await runFinalize(REWRITE.request, fakeRepo(a717Row()).ports),
      await runFinalize(PASSED_ON.request, fakeRepo(a717Row()).ports),
    ];
    const notes = runs.flatMap((run) => run.notes);
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes)
      expect(Object.keys(note).sort()).toEqual(["attempt", "missed", "outcome", "row"]);
    const text = JSON.stringify(notes);
    for (const word of ["Riley", "Avery", "10:30am", "Sat Oct 24", "code-supplied", "{{", "passed this on"])
      expect(text).not.toContain(word);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("no check detail and no rewrite request holds a filled value (DL-158 ruling c)", () => {
  it("'Open {{link.secure}}now': the link glued to a word is in neither the answer's details nor the rewrite's request", async () => {
    const row = a717Row();
    const plan = withPlan(REWRITE.request, {
      lines: [{ role: "first", text: "Open {{link.secure}}now to see your visit." }],
    });
    const response = responseOf(await runFinalize(plan, fakeRepo(row).ports));
    const [composed] = response.checks;

    // The link was filled where the composer glued it, and T-312's own detail quotes it with the word it touches.
    expect(composed.checked.sends[0].text).toBe("Open rosfield.com/v/s03now to see your visit.");
    const raw = runMessageChecks(composed.checked, row.checks).checks.find(
      (check) => check.check === "values",
    );
    expect(raw?.detail).toContain("rosfield.com/v/s03now");
    // The answer and the rewrite are told the slot instead, wherever it stood.
    expect(response.outcome).toBe("rewrite");
    expect(detailOf(composed, "values")).toContain("The link {{link.secure}}now is not a code-supplied fact");
    const told = rewriteTold(composed);
    expect(told.map((item) => item.check)).toEqual(["values"]);
    for (const text of [JSON.stringify(composed.checks), JSON.stringify(told)])
      expect(text).not.toContain("rosfield.com/v/s03");
  });

  it("'Code{{visit.code}}' in a sentence over 22 words: the code is in neither the Length detail nor the rewrite's request", async () => {
    const row = a717Row(
      a717With({ visit: { start: { utc: "2026-10-24T15:00:00Z", zone: "America/New_York" }, code: "5160" } }),
    );
    const sentence =
      "Code{{visit.code}} is the one you give at the door when you come in on the day of your visit to the shop for your cut with us.";
    const plan = withPlan(REWRITE.request, { lines: [{ role: "first", text: sentence }] });
    const response = responseOf(await runFinalize(plan, fakeRepo(row).ports));
    const [composed] = response.checks;

    expect(composed.checked.sends[0].text).toContain("Code5160 is the one");
    const raw = runMessageChecks(composed.checked, row.checks).checks.find(
      (check) => check.check === "lengthAndReading",
    );
    expect(raw?.detail).toContain('"Code5160 is the one ..."');
    // A Length miss on the composed plan: its one rewrite, told the slot in place of the code.
    expect(response.outcome).toBe("rewrite");
    expect(missedIn(composed)).toEqual(["lengthAndReading"]);
    expect(detailOf(composed, "lengthAndReading")).toBe(
      'The sentence "Code{{visit.code}} is the one ..." has 27 words; keep each sentence to 22 words or fewer.',
    );
    const told = rewriteTold(composed);
    for (const text of [JSON.stringify(composed.checks), JSON.stringify(told)])
      expect(text).not.toContain("5160");
  });

  it("writes every place of each value as its slot, longest first, glued or not; a detail still holding one is cut down", () => {
    const shop = [
      { slot: "owner.name", value: "Sam" },
      { slot: "biz.name", value: "Sam's Cuts" },
    ];
    expect(withoutValues("values", "The name xSam's Cutsy and Sam2 are not facts.", shop)).toBe(
      "The name x{{biz.name}}y and {{owner.name}}2 are not facts.",
    );
    // A value's first words where T-312 cuts its quote short: the rest of the address never shows, the start must not.
    const place = [{ slot: "visit.place", value: "88 Elm St, Springfield" }];
    expect(
      withoutValues(
        "lengthAndReading",
        'The sentence "We meet at88 Elm ..." has 25 words; keep each sentence to 22 words or fewer.',
        place,
      ),
    ).toBe("lengthAndReading");
    // A value as the master's word split reads it (a clock time as "time", a long dash as " to ").
    const window = [{ slot: "window", value: "8–10am" }];
    expect(
      withoutValues("lengthAndReading", 'The sentence "Riley comes 8 to time ..." has 24 words.', window),
    ).toBe("lengthAndReading");
    // A value that only an inserted slot's name could hold again is cut down too.
    expect(
      withoutValues("values", "The link rosfield.com/v/s03 is not a fact.", [
        { slot: "link.secure", value: "rosfield.com/v/s03" },
        { slot: "svc.intext", value: "secure" },
      ]),
    ).toBe("values");
    // No value, or none in the detail: the detail as it is.
    expect(withoutValues("values", "The time 10:30am is not a code-supplied fact.", [])).toBe(
      "The time 10:30am is not a code-supplied fact.",
    );
    expect(
      withoutValues("values", "The time 10:30am is not a code-supplied fact.", [{ slot: "day", value: " " }]),
    ).toBe("The time 10:30am is not a code-supplied fact.");
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("the row: refused before anything is checked or written", () => {
  it("answers notFound, rowClosed, alreadyPlanned and versionChanged as K-09 v1 says, writing nothing", async () => {
    const planned = PASSED_ON.outcome.finalParts;
    if (planned === null) throw new Error("finalize-passed-on.json writes final parts");
    const id = "outbox-a7-17-alex-text";
    const cases: [FinalizeRow | null, unknown][] = [
      [null, { error: "notFound", table: "outbox_rows", rowId: id }],
      [
        { ...a717Row(), state: "dropped_stopped" },
        { error: "rowClosed", outboxRowId: id, state: "dropped_stopped" },
      ],
      [
        { ...a717Row(), state: "checked", version: 2, finalParts: planned },
        { error: "alreadyPlanned", outboxRowId: id, finalParts: planned },
      ],
      [
        { ...a717Row(), version: 3 },
        {
          error: "versionChanged",
          changed: [{ table: "outbox_rows", rowId: id, readVersion: 1, currentVersion: 3 }],
        },
      ],
    ];
    for (const [row, answer] of cases) {
      const repo = fakeRepo(row);
      const run = await runFinalize(REWRITE.request, repo.ports);
      expect(run.answer).toEqual(answer);
      expect(run.ended).toBe("rollback");
      expect(repo.calls.writes).toEqual([]);
    }
  });

  it("never finalizes a fixed-line row (STATE note 17) and never writes stopReply (T-267's note b)", async () => {
    const fixedRow = fakeRepo({ ...a717Row(), fixedLineId: "stopReply" });
    await expect(runFinalize(REWRITE.request, fixedRow.ports)).rejects.toThrow(FinalizeRefusedError);
    expect(fixedRow.calls.writes).toEqual([]);

    const stopLine = fakeRepo(a717Row(), (parts) => ({
      ...parts,
      fixedLines: [...parts.fixedLines, "stopReply"],
    }));
    await expect(runFinalize(PASSED_ON.request, stopLine.ports)).rejects.toThrow(/stopReplyLine/);
    expect(stopLine.calls.writes).toEqual([]);
  });

  it("fails closed while a port is not built: the base answers notBuilt and nothing is written", async () => {
    const run = await runFinalize(REWRITE.request);
    expect(run.answer).toEqual({ error: "notBuilt", call: "finalizeMessage" });
    expect(new FinalizeRefusedError("planForOtherRow")).not.toBeInstanceOf(NotBuiltError);
  });

  it("refuses a plan for another row; no answer or error names a value", async () => {
    const other = { ...REWRITE.request, plan: { ...REWRITE.request.plan, row: "outbox-other" } };
    await expect(runFinalize(other, fakeRepo(a717Row()).ports)).rejects.toThrow(/planForOtherRow/);
    const answers = [
      (await runFinalize(REWRITE.request, fakeRepo({ ...a717Row(), version: 3 }).ports)).answer,
      (await runFinalize(REWRITE.request, fakeRepo(null).ports)).answer,
    ];
    for (const value of ["Riley", "Sat Oct 24", "10:30am", "Alex"])
      expect(stringsIn(answers).join(" ")).not.toContain(value);
  });
});
