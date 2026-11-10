// Tests of the One question check on the composed words only (T-1178, C-092; DL-355; T-1164's handoff 3 and its security
// review's n4). The fixed-line inserter adds K-01's danger question, safetyAsk ("Is anyone in danger right now?"), on its
// own line after a safety line when a text the row answers holds a label of unknown tense (T-1164), so a composed question
// beside it counted as two and blocked the message. A fixed line is code's own words, like a slot value (arch 07 line
// 361; DL-158 a): its question never counts, whichever line holds it (safetyAsk, the opt-out line, the privacy link), and
// only the composed words do. Two composed questions still fail, as K-03's check-two-questions.json says (S13-28 rule 50;
// arch 07 line 411). The row is T-313's A7-17 text to Alex with K-01's lines and T-1164's crisis read (K-02's own
// safety-crisis-words.json, read with a tense of unknown), run through the checks alone, the inserter and the finalize
// call. Names and values are the master's sample cast (Lee's Barbershop, Alex M., Riley; rule 9).

import { describe, expect, it } from "vitest";

import { insertFixedLines, type FixedLineFacts } from "../fixed-lines";
import {
  DAY,
  FIRST_TEXT,
  RILEY,
  SECOND_TEXT,
  answeredFrom,
  factsPort,
  firstTextRow,
  partsOf,
  repoWithInserter,
  wordsSend,
} from "../fixed-lines/test-support";
import type { FinalizeRequest, FinalizeResponse } from "../rewrite";
import { exchange, runFinalize, type CallRun } from "../rewrite/test-support";
import { contractFile } from "../../tool-api/test-support";
import { fixedLineWords } from "./reading";
import {
  fixedLinesFaults,
  oneQuestionFaults,
  runMessageChecks,
  type CheckContext,
  type CheckOutcome,
  type FinalParts,
} from "./index";

/** T-313's A7-17 row to Alex, with K-01's sample lines and the privacy link (T-1164's first text row). */
const ROW = firstTextRow();
const CONTEXT: CheckContext = ROW.checks;

/** A fixed line's words as the bundle writes them (K-01 v1), <business> filled, as the inserter and the checks read them. */
function lineWords(id: string): string {
  const source = fixedLineWords(id, CONTEXT);
  if (!("words" in source)) throw new Error(source.fault);
  return source.words;
}

/** K-03 v1's check-two-questions.json: A7-17's text to Alex with two questions, and the checks it states. */
const TWO_QUESTIONS_FIXTURE = contractFile("message-plan/fixtures/check-two-questions.json") as {
  readonly checked: FinalParts;
  readonly checks: readonly CheckOutcome[];
};

/** The fault K-03 states for two questions, in the words the rewrite is told. */
const TWO_QUESTIONS =
  TWO_QUESTIONS_FIXTURE.checks.find((check) => check.check === "oneQuestion")?.detail ?? "";

/** A7-17's composed words with one question: the first line, then the question on its own line (rewrite/parts.ts). */
const QUESTION = "Does another day work for you?";
const ONE_ASKED = `Riley can't be in on Sat Oct 24.\n${QUESTION}`;
/** The same words asking a second question, as check-two-questions.json does. */
const SECOND_QUESTION = "Or should we find another time?";
const TWO_ASKED = `${ONE_ASKED} ${SECOND_QUESTION}`;

/** Composed words with fixed lines after them, each on its own line, as the inserter adds a row's other lines. */
function withLinesAfter(composed: string, ids: readonly string[]): FinalParts {
  return partsOf([wordsSend([composed, ...ids.map(lineWords)].join("\n"))], [RILEY, DAY], ids);
}

/** Alex's crisis words (K-02 safety-crisis-words.json), read with a tense of unknown: the inserter adds safetyAsk. */
const CRISIS_UNKNOWN = answeredFrom("safety-crisis-words.json", { tenses: ["unknown"] });

/** The facts of `base` with the crisis line listed and the crisis read of unknown tense answered. */
const crisisFacts = (base: FixedLineFacts): FixedLineFacts => ({
  ...base,
  lines: ["safetyCrisis"],
  answeredTexts: [CRISIS_UNKNOWN],
});

/** The words send's text of some parts. */
const wordsOf = (parts: FinalParts | null | undefined): string | null | undefined =>
  parts?.sends.find((send) => send.kind === "words")?.text;

/** The checks that missed, by name. */
const missed = (checks: readonly CheckOutcome[]): string[] =>
  checks.filter((check) => !check.passed).map((check) => check.check);

/** A7-17's composed plan (finalize-rewrite.json's row) asking `question` after Riley's line, as text alone. */
function askingPlan(question: string): FinalizeRequest {
  const base = exchange("finalize-rewrite.json").request;
  return {
    ...base,
    plan: {
      ...base.plan,
      plan: {
        ...base.plan.plan,
        formats: ["text"],
        lines: [{ role: "first", text: "{{pro.name}} can't be in on {{day}}." }],
        question: { text: question, optionIds: [] },
      },
    },
  };
}

/** The answer as a K-09 v1 response; fails the test when it is an error or a base refusal. */
function responseOf(run: CallRun): FinalizeResponse {
  expect(run.answer, JSON.stringify(run.answer)).toHaveProperty("outcome");
  return run.answer as FinalizeResponse;
}

// ---------------------------------------------------------------------------------------------------------------

describe("oneQuestion counts the composed words only: a fixed line's question never counts (T-1178)", () => {
  it("reads K-01's danger question as a question, and K-03's fault for two", () => {
    expect(lineWords("safetyAsk")).toMatch(/\?$/);
    expect(TWO_QUESTIONS).not.toBe("");
  });

  it("one composed question with a safety line and safetyAsk after it passes, and every check passes", () => {
    const parts = withLinesAfter(ONE_ASKED, ["safetyCrisis", "safetyAsk"]);
    expect(oneQuestionFaults(parts, CONTEXT)).toEqual([]);
    const result = runMessageChecks(parts, CONTEXT);
    expect(missed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("two composed questions with safetyAsk still fail, the fault counting the composed two only", () => {
    const parts = withLinesAfter(TWO_ASKED, ["safetyCrisis", "safetyAsk"]);
    expect(oneQuestionFaults(parts, CONTEXT)).toEqual([TWO_QUESTIONS]);
    const result = runMessageChecks(parts, CONTEXT);
    expect(missed(result.checks)).toEqual(["oneQuestion"]);
    expect(result.blocked).toBe(true);
  });

  it("check-two-questions.json still fails as K-03 says, alone and with a safety line and safetyAsk added", () => {
    const stated = TWO_QUESTIONS_FIXTURE;
    expect(runMessageChecks(stated.checked, CONTEXT).checks).toEqual(stated.checks);
    const words = [wordsOf(stated.checked) ?? "", lineWords("safetyEmergency"), lineWords("safetyAsk")];
    const withAsk: FinalParts = {
      ...stated.checked,
      sends: [wordsSend(words.join("\n"))],
      fixedLines: ["safetyEmergency", "safetyAsk"],
    };
    expect(runMessageChecks(withAsk, CONTEXT).checks).toEqual(stated.checks);
  });

  it("takes a fixed line's words out at one place only: the model's own copy of the danger question counts, and changed words count", () => {
    // The model asked the danger question itself and one more; the safetyAsk code added after the safety line is code's.
    const copied = withLinesAfter(`${lineWords("safetyAsk")}\n${ONE_ASKED}`, ["safetyCrisis", "safetyAsk"]);
    expect(oneQuestionFaults(copied, CONTEXT)).toEqual([TWO_QUESTIONS]);
    // Words listed as safetyAsk but changed are not the line (the Fixed lines check fails them), so their question counts.
    const changed = partsOf(
      [wordsSend(`${ONE_ASKED}\nIs anyone in danger now?`)],
      [RILEY, DAY],
      ["safetyAsk"],
    );
    expect(oneQuestionFaults(changed, CONTEXT)).toEqual([TWO_QUESTIONS]);
    expect(fixedLinesFaults(changed, CONTEXT)).not.toEqual([]);
  });

  it("as the inserter adds a first text's lines (T-1164): the opener, the crisis line, safetyAsk, the opt-out line and the privacy link never count", () => {
    const one = insertFixedLines(partsOf([wordsSend(ONE_ASKED)]), ROW, crisisFacts(FIRST_TEXT));
    expect(one.fixedLines).toEqual(["opener", "safetyCrisis", "safetyAsk", "optOutLine", "privacyLink"]);
    expect(oneQuestionFaults(one, CONTEXT)).toEqual([]);
    expect(missed(runMessageChecks(one, CONTEXT).checks)).toEqual([]);

    const two = insertFixedLines(partsOf([wordsSend(TWO_ASKED)]), ROW, crisisFacts(FIRST_TEXT));
    expect(oneQuestionFaults(two, CONTEXT)).toEqual([TWO_QUESTIONS]);
    expect(runMessageChecks(two, CONTEXT).blocked).toBe(true);
  });

  it("through the finalize call: a composed question beside the danger question sends, with no rewrite", async () => {
    const port = factsPort(crisisFacts(SECOND_TEXT));
    const { repo, ports } = repoWithInserter(firstTextRow(), port);
    const sent = responseOf(await runFinalize(askingPlan(QUESTION), ports));

    expect(sent.outcome).toBe("send");
    expect(sent.checks).toHaveLength(1);
    expect(missed(sent.checks[0].checks)).toEqual([]);
    expect(wordsOf(sent.finalParts)).toBe(
      [ONE_ASKED, lineWords("safetyCrisis"), lineWords("safetyAsk")].join("\n"),
    );
    expect(sent.finalParts?.fixedLines).toEqual(["safetyCrisis", "safetyAsk"]);
    expect(repo.calls.writes.map((write) => write.finalParts)).toEqual([sent.finalParts]);
  });

  it("through the finalize call: two composed questions beside it still get the rewrite, told the composed two", async () => {
    const port = factsPort(crisisFacts(SECOND_TEXT));
    const { repo, ports } = repoWithInserter(firstTextRow(), port);
    const rewrite = responseOf(await runFinalize(askingPlan(`${QUESTION} ${SECOND_QUESTION}`), ports));

    expect(rewrite.outcome).toBe("rewrite");
    expect(rewrite.finalParts).toBeNull();
    const [composed] = rewrite.checks;
    expect(composed.attempt).toBe("composed");
    expect(missed(composed.checks)).toEqual(["oneQuestion"]);
    expect(composed.checks.find((check) => check.check === "oneQuestion")?.detail).toBe(TWO_QUESTIONS);
    expect(repo.calls.writes).toEqual([]);
  });
});
