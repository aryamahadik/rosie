// Tests of the finalize call (T-313, C-093; K-09 v1 finalizeMessage; arch 02 line 123; arch 07 line 417), run through the
// Tool API base, which holds every request and answer to K-09 v1's frozen schema. The slot filler (T-310), the claim check
// (T-311) and the message checks (T-312) run for real; the row read, T-314's fixed lines and the K-05 and K-37 writes are
// a fake repo (test-support.ts). Values are the master's sample cast (rule 9).

import { describe, expect, it } from "vitest";

import { CHECK_NAMES } from "../checks";
import { NotBuiltError } from "../../tool-api";
import { QUESTION_CUT } from "../index";
import { outcomeOf, type AttemptCheck } from "./attempt";
import { FinalizeRefusedError } from "./errors";
import { PASSED_ON_REVIEW } from "./types";
import { rewriteTold } from "./told";
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

const PASS = exchange("finalize-pass.json");
const REWRITE = exchange("finalize-rewrite.json");
const PASSED_ON = exchange("finalize-passed-on.json");

/** The answer as a K-09 v1 response; fails the test when it is an error or a base refusal. */
function responseOf(run: CallRun): FinalizeResponse {
  expect(run.answer, JSON.stringify(run.answer)).toHaveProperty("outcome");
  return run.answer as FinalizeResponse;
}

/** Each check's name and whether it passed, in order. */
const passes = (result: CheckResult): [string, boolean][] =>
  result.checks.map((check) => [check.check, check.passed]);

/** The checks a result missed, in order. */
const missedIn = (result: CheckResult): string[] =>
  result.checks.filter((check) => !check.passed).map((check) => check.check);

/** The detail of one check of a result. */
const detailOf = (result: CheckResult | undefined, name: string): string | null | undefined =>
  result?.checks.find((check) => check.check === name)?.detail;

/** A request for the same row with another plan, as the composer would send it. */
function withPlan(
  base: FinalizeRequest,
  plan: Partial<FinalizeRequest["plan"]["plan"]>,
  attempt: FinalizeRequest["attempt"] = base.attempt,
): FinalizeRequest {
  return { ...base, attempt, plan: { ...base.plan, plan: { ...base.plan.plan, ...plan } } };
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

// ---------------------------------------------------------------------------------------------------------------

describe("finalize-pass.json: S1-02's plan, the opener added, every value code-supplied", () => {
  it("builds the fixture's final parts word for word, and every check but Length and reading passes", async () => {
    const repo = fakeRepo(s102Row(), openerFirst);
    const response = responseOf(await runFinalize(PASS.request, repo.ports));
    const [composed] = response.checks;
    const [stated] = PASS.outcome.checks;

    // Options, slots, the claim check and the fixed line give exactly the fixture's final parts.
    expect(composed.checked).toEqual(PASS.outcome.finalParts);
    expect(composed.attempt).toBe("composed");
    // Six of the seven checks pass as the fixture states. Length and reading counts the S1-02 card's fact line, 26
    // words of Rosie's own terms in one sentence, as the model's own words (T-312; arch 07 line 413: 22 words), while
    // the fixture shows it passing (arch 07 line 361 has checked terms outside the counts: see the handoff).
    for (const [name, passed] of passes(stated)) {
      const got = composed.checks.find((check) => check.check === name)?.passed;
      expect(got, name).toBe(name === "lengthAndReading" ? false : passed);
    }
    expect(detailOf(composed, "lengthAndReading")).toContain("has 26 words");
    // A first miss gets its one rewrite, and nothing is written.
    expect(response.outcome).toBe("rewrite");
    expect(response.finalParts).toBeNull();
    expect(repo.calls.writes).toEqual([]);
  });

  it("the one rewrite of the same plan sends and is logged, writing finalize-pass.json's final parts with the plan", async () => {
    const repo = fakeRepo(s102Row(), openerFirst);
    await runFinalize(PASS.request, repo.ports);
    const run = await runFinalize({ ...PASS.request, attempt: "rewrite" }, repo.ports);
    const response = responseOf(run);

    expect(response.outcome).toBe("sendAndLog");
    expect(response.finalParts).toEqual(PASS.outcome.finalParts);
    expect(response.questionWithdrawn).toBe(PASS.outcome.questionWithdrawn);
    expect(response.teamPageId).toBe(PASS.outcome.teamPageId);
    expect(repo.calls.writes).toEqual([
      {
        outboxRowId: "outbox-s1-02-sam-1",
        expectVersion: 1,
        plan: PASS.request.plan,
        finalParts: PASS.outcome.finalParts,
      },
    ]);
    expect(run.ended).toBe("commit");
    expect(run.notes).toEqual([
      { row: "outbox-s1-02-sam-1", attempt: "rewrite", outcome: "sendAndLog", missed: ["lengthAndReading"] },
    ]);
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
  it("gives the fixture's result: outcome rewrite, the checked parts word for word, Values failed, nothing written", async () => {
    const repo = fakeRepo(a717Row());
    const run = await runFinalize(REWRITE.request, repo.ports);
    const response = responseOf(run);
    const [stated] = REWRITE.outcome.checks;
    const [composed] = response.checks;

    expect(response.outcome).toBe(REWRITE.outcome.outcome);
    expect(response.checks).toHaveLength(1);
    expect(composed.checked).toEqual(stated.checked);
    expect(passes(composed)).toEqual(passes(stated));
    expect(detailOf(composed, "values")).toContain("The time 10:30am is not a code-supplied fact");
    expect([composed.attempt, composed.outcome, composed.questionWithdrawn, composed.teamPaged]).toEqual([
      "composed",
      "rewrite",
      false,
      false,
    ]);
    expect(response.finalParts).toBeNull();
    expect(response.questionWithdrawn).toBe(false);
    expect(response.teamPageId).toBeNull();
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
  it("gives the fixture's result: passedOn, the passed-on line written word for word, the question withdrawn", async () => {
    const repo = fakeRepo(a717Row());
    const run = await runFinalize(PASSED_ON.request, repo.ports);
    const response = responseOf(run);
    const [rewrite, fallback] = response.checks;
    const [statedRewrite, statedFallback] = PASSED_ON.outcome.checks;

    expect(response.outcome).toBe(PASSED_ON.outcome.outcome);
    expect(response.finalParts).toEqual(PASSED_ON.outcome.finalParts);
    expect(response.questionWithdrawn).toBe(PASSED_ON.outcome.questionWithdrawn);
    // Paging Rosie's team is T-319's (M3b): this card opens no page.
    expect(response.teamPageId).toBeNull();
    expect(response.checks).toHaveLength(2);

    // The rewrite: checked word for word as the fixture's, Values failed, then the fallback.
    expect(rewrite.checked.sends).toEqual(statedRewrite.checked.sends);
    expect(passes(rewrite)).toEqual(passes(statedRewrite));
    expect(detailOf(rewrite, "values")).toContain("The time 10:30am is not a code-supplied fact");
    expect([rewrite.attempt, rewrite.outcome, rewrite.questionWithdrawn, rewrite.teamPaged]).toEqual([
      statedRewrite.attempt,
      statedRewrite.outcome,
      false,
      false,
    ]);

    // The fallback: through the same checks, a slot left with no value fails Values, so nothing passed.
    if (fallback === undefined || statedFallback === undefined) throw new Error("two check results each");
    expect(passes(fallback)).toEqual(passes(statedFallback));
    expect(detailOf(fallback, "values")).toContain("has no value, so '{{' is left in the text.");
    expect([fallback.attempt, fallback.outcome, fallback.questionWithdrawn, fallback.teamPaged]).toEqual([
      statedFallback.attempt,
      statedFallback.outcome,
      true,
      true,
    ]);
    expect(run.ended).toBe("commit");
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

  it("limit 7 runs on the fallback too: the sentence naming name.staff, owner and staff only, is cut for Alex", async () => {
    const response = responseOf(await runFinalize(PASSED_ON.request, fakeRepo(a717Row()).ports));
    const checked = response.checks[1]?.checked;

    expect(A7_17_FALLBACK).toContain("{{name.staff}} can come in early");
    expect(checked?.sends[0].text).toBe(
      "Sorry, Riley can't be in on Sat Oct 24. Please reply by {{ask.by}}.",
    );
    expect(checked?.slotValues).toEqual([
      { slot: "pro.name", value: "Riley" },
      { slot: "day", value: "Sat Oct 24" },
    ]);
  });

  it("a fallback that passes its checks is sent instead, with the two check results", async () => {
    const source = a717Source();
    const withDeadline = {
      ...source,
      facts: { ...source.facts, askBy: { utc: "2026-10-23T23:00:00Z", zone: "America/New_York" } },
    };
    const repo = fakeRepo(a717Row(withDeadline));
    const response = responseOf(await runFinalize(PASSED_ON.request, repo.ports));

    expect(response.outcome).toBe("send");
    expect(response.checks.map((check) => [check.attempt, check.outcome])).toEqual([
      ["rewrite", "fallback"],
      ["fallback", "send"],
    ]);
    expect(response.finalParts?.sends[0].text).toMatch(
      /^Sorry, Riley can't be in on Sat Oct 24\. Please reply by /,
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
