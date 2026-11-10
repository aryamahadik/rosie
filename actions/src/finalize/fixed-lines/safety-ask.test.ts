// Tests of the danger question after a safety line (T-1164, C-089; CQ-164 (d)'s default, DL-344; arch 06 line 329;
// S13-24 rule 10). The core's safety record does not choose safetyAsk (T-1140's handoff 4), so the inserter adds K-01's
// safetyAsk right after the row's safety line, once, when a text the row answers holds a label of unknown tense other
// than No, as the handle actor's direct path does (runtime/src/safety/rules.ts checkedLineFor, T-1143). The texts' reads
// are K-05 v1.3 readOutboxRow's answered texts, made from K-02 v1's own safety fixtures (Alex's texts to Lee's
// Barbershop); the inserter runs alone and as the finalize call's insertFixedLines port, through the Tool API base on
// T-313's fake repo, with the claim check and the message checks for real. The earlier inserter tests
// (fixed-lines.test.ts) run as they were. Values are the master's sample cast (rule 9).

import { describe, expect, it } from "vitest";

import { checkedLineFor } from "../../../../runtime/src/safety/rules";
import type { BundleSafety, SafetyLabel, SafetyResult } from "../../../../runtime/src/safety/types";
import { contractFile } from "../../tool-api/test-support";
import { runMessageChecks } from "../checks";
import { fixedLineWords } from "../checks/reading";
import type { FinalizeRequest, FinalizeResponse, FinalParts } from "../rewrite";
import { bareContext, bundleLists, exchange, runFinalize, type CallRun } from "../rewrite/test-support";
import {
  FixedLineRefusedError,
  SAFETY_ASK_LINE,
  SAFETY_LINES,
  asksIfInDanger,
  dangerQuestionAfter,
  fixedLineInserter,
  insertFixedLines,
  type AnsweredText,
  type FixedLineFacts,
} from "./index";
import {
  CODE_TEXT_LINE,
  FIRST_TEXT,
  OPENER,
  OPT_OUT,
  PRIVACY,
  SAFETY_ASK,
  SAFETY_CRISIS,
  SAFETY_EMERGENCY,
  SECOND_TEXT,
  answeredFrom,
  factsPort,
  firstTextRow,
  partsOf,
  repoWithInserter,
  wordsSend,
  type Tense,
} from "./test-support";

const REWRITE = exchange("finalize-rewrite.json");
const PASSED_ON = exchange("finalize-passed-on.json");

/** A7-17's composed plan, put so that every check passes: Riley can't be in on Saturday (as fixed-lines.test.ts has it). */
function passingPlan(): FinalizeRequest {
  const base = REWRITE.request;
  return {
    ...base,
    plan: {
      ...base.plan,
      plan: {
        ...base.plan.plan,
        formats: ["text"],
        lines: [{ role: "first", text: "{{pro.name}} can't be in on {{day}}." }],
        question: null,
      },
    },
  };
}

/** The words the composed plan fills to, as rewrite/parts.ts builds them (T-310's filler). */
const COMPOSED = "Riley can't be in on Sat Oct 24.";

/** The answer as a K-09 v1 response; fails the test when it is an error or a base refusal. */
function responseOf(run: CallRun): FinalizeResponse {
  expect(run.answer, JSON.stringify(run.answer)).toHaveProperty("outcome");
  return run.answer as FinalizeResponse;
}

/** The words send's text of some parts. */
const wordsOf = (parts: FinalParts | null | undefined): string | null | undefined =>
  parts?.sends.find((send) => send.kind === "words")?.text;

/** How many times `piece` stands in `text`. */
const timesIn = (text: string | null | undefined, piece: string): number =>
  (text ?? "").split(piece).length - 1;

/** The facts of `base` with the lines the port lists and the texts the row answers. */
const factsWith = (
  lines: readonly string[],
  answeredTexts: readonly AnsweredText[],
  base: FixedLineFacts = SECOND_TEXT,
): FixedLineFacts => ({ ...base, lines, answeredTexts });

/** Alex's crisis words (K-02 safety-crisis-words.json), read with a tense of unknown: now, or over? */
const CRISIS_UNKNOWN = answeredFrom("safety-crisis-words.json", { tenses: ["unknown"] });

/** K-02's own unknown tense: a fire in the back room with no time given, An emergency (safety-unknown-tense.json). */
const EMERGENCY_UNKNOWN = answeredFrom("safety-unknown-tense.json");

// ---------------------------------------------------------------------------------------------------------------

describe("a crisis line with a label of unknown tense gets the danger question right after it (CQ-164 d)", () => {
  it("Alex's crisis words of unknown tense: the 988 and 911 line, then 'Is anyone in danger right now?' on its own line", () => {
    const row = firstTextRow();
    const facts = factsWith(["safetyCrisis"], [CRISIS_UNKNOWN]);
    const added = insertFixedLines(partsOf([wordsSend(COMPOSED)]), row, facts);

    expect(wordsOf(added)).toBe(`${COMPOSED}\n${SAFETY_CRISIS}\n${SAFETY_ASK}`);
    expect(added.fixedLines).toEqual(["safetyCrisis", "safetyAsk"]);
    // Both are K-01's own words, as the Fixed lines check reads them, and all seven checks pass.
    expect(fixedLineWords("safetyCrisis", row.checks)).toEqual({ words: SAFETY_CRISIS });
    expect(fixedLineWords(SAFETY_ASK_LINE, row.checks)).toEqual({ words: SAFETY_ASK });
    expect(runMessageChecks(added, row.checks).checks.every((check) => check.passed)).toBe(true);
  });

  it("K-02's own unknown tense (safety-unknown-tense.json): the emergency's 911 line, then the question", () => {
    const row = firstTextRow();
    const facts = factsWith(["safetyEmergency"], [EMERGENCY_UNKNOWN]);
    const added = insertFixedLines(partsOf([wordsSend(COMPOSED)]), row, facts);

    expect(EMERGENCY_UNKNOWN).toEqual({
      eventId: "evt-alex-0209",
      outcomes: ["An emergency"],
      tenses: ["unknown"],
    });
    expect(wordsOf(added)).toBe(`${COMPOSED}\n${SAFETY_EMERGENCY}\n${SAFETY_ASK}`);
    expect(added.fixedLines).toEqual(["safetyEmergency", "safetyAsk"]);
    expect(fixedLineWords("safetyEmergency", row.checks)).toEqual({ words: SAFETY_EMERGENCY });
    expect(runMessageChecks(added, row.checks).checks.every((check) => check.passed)).toBe(true);
  });

  it("on a first text it follows the safety line, before the lines after it, the opt-out line and the privacy link", () => {
    const row = firstTextRow();
    const code = (CODE_TEXT_LINE.text ?? "").replace("<business>", "Lee's Barbershop");
    const facts = factsWith(["safetyCrisis", "codeText"], [CRISIS_UNKNOWN], FIRST_TEXT);
    const added = insertFixedLines(partsOf([wordsSend(COMPOSED)]), row, facts);

    expect(wordsOf(added)).toBe(
      `${OPENER} ${COMPOSED}\n${SAFETY_CRISIS}\n${SAFETY_ASK}\n${code}\n${OPT_OUT}\n${PRIVACY}`,
    );
    expect(added.fixedLines).toEqual([
      "opener",
      "safetyCrisis",
      "safetyAsk",
      "codeText",
      "optOutLine",
      "privacyLink",
    ]);
    expect(runMessageChecks(added, row.checks).checks.every((check) => check.passed)).toBe(true);
  });

  it("through the finalize call: written once, word for word, with every check passed", async () => {
    const port = factsPort(factsWith(["safetyCrisis"], [CRISIS_UNKNOWN], FIRST_TEXT));
    const { repo, ports } = repoWithInserter(firstTextRow(), port);
    const sent = responseOf(await runFinalize(passingPlan(), ports));

    expect(sent.outcome).toBe("send");
    expect(sent.checks[0].checks.every((check) => check.passed)).toBe(true);
    expect(wordsOf(sent.finalParts)).toBe(
      `${OPENER} ${COMPOSED}\n${SAFETY_CRISIS}\n${SAFETY_ASK}\n${OPT_OUT}\n${PRIVACY}`,
    );
    expect(sent.finalParts?.fixedLines).toEqual([
      "opener",
      "safetyCrisis",
      "safetyAsk",
      "optOutLine",
      "privacyLink",
    ]);
    expect(repo.calls.writes.map((write) => write.finalParts)).toEqual([sent.finalParts]);
    expect(port.reads).toEqual(["outbox-a7-17-alex-text@biz-lees-barbershop"]);
  });

  it("the passed-on line of such a row carries the line and the question, once", async () => {
    const port = factsPort(factsWith(["safetyCrisis"], [CRISIS_UNKNOWN], FIRST_TEXT));
    const { repo, ports } = repoWithInserter(firstTextRow(), port);
    const response = responseOf(await runFinalize(PASSED_ON.request, ports));

    expect(response.outcome).toBe("passedOn");
    expect(wordsOf(response.finalParts)).toBe(
      `${OPENER} I’ve passed this on. Rosie’s team will reply within 1 business day.\n${SAFETY_CRISIS}\n${SAFETY_ASK}\n${OPT_OUT}\n${PRIVACY}`,
    );
    expect(response.finalParts?.fixedLines).toEqual([
      "passedOn",
      "opener",
      "safetyCrisis",
      "safetyAsk",
      "optOutLine",
      "privacyLink",
    ]);
    expect(repo.calls.writes).toHaveLength(1);
    // Each attempt checked carried the line and the question word for word.
    for (const result of response.checks)
      expect(result.checks.find((check) => check.check === "fixedLines")?.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("no label of unknown tense other than No: no question", () => {
  it.each<[string, Tense]>([
    ["over (the past tense)", "over"],
    ["now", "now"],
    ["could restart", "could restart"],
    ["joke", "joke"],
  ])("a crisis line whose text's label reads %s gets none", (_name, tense) => {
    const read = answeredFrom("safety-crisis-words.json", { tenses: [tense] });
    const added = insertFixedLines(
      partsOf([wordsSend(COMPOSED)]),
      firstTextRow(),
      factsWith(["safetyCrisis"], [read]),
    );

    expect(wordsOf(added)).toBe(`${COMPOSED}\n${SAFETY_CRISIS}`);
    expect(added.fixedLines).toEqual(["safetyCrisis"]);
  });

  it("No gets none: a No label of unknown tense, K-02's plain No, and the gas leak fixed in March (No, over)", () => {
    const reads = [
      answeredFrom("safety-no.json", { tenses: ["unknown"] }),
      answeredFrom("safety-no.json"),
      answeredFrom("safety-over-gas-leak.json"),
    ];
    for (const read of reads) {
      const added = insertFixedLines(
        partsOf([wordsSend(COMPOSED)]),
        firstTextRow(),
        factsWith(["safetyEmergency"], [read]),
      );
      expect(read.outcomes).toEqual(["No"]);
      expect(added.fixedLines, read.eventId).toEqual(["safetyEmergency"]);
      expect(wordsOf(added)).toBe(`${COMPOSED}\n${SAFETY_EMERGENCY}`);
    }
  });

  it("a read that timed out (no label: CQ-163 b) and a text whose read the scope does not show get none", () => {
    const timedOut = answeredFrom("safety-timeout-danger-word.json");
    expect(timedOut).toEqual({ eventId: "evt-alex-0210", outcomes: ["Unsure"], tenses: [] });
    const unseen: AnsweredText = { eventId: "evt-alex-0209", outcomes: null, tenses: null };
    for (const read of [timedOut, unseen]) {
      const added = insertFixedLines(
        partsOf([wordsSend(COMPOSED)]),
        firstTextRow(),
        factsWith(["safetyEmergency"], [read]),
      );
      expect(added.fixedLines, read.eventId).toEqual(["safetyEmergency"]);
    }
  });

  it("a row with no safety line gets none, whatever its texts hold: the question follows a line", () => {
    const parts = partsOf([wordsSend(COMPOSED)]);
    expect(insertFixedLines(parts, firstTextRow(), factsWith([], [CRISIS_UNKNOWN]))).toBe(parts);
    const code = insertFixedLines(
      parts,
      firstTextRow(),
      factsWith(["codeText"], [CRISIS_UNKNOWN, EMERGENCY_UNKNOWN]),
    );
    expect(code.fixedLines).toEqual(["codeText"]);
    expect(timesIn(wordsOf(code), SAFETY_ASK)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("the question is never added twice", () => {
  it("two texts that each hold a label of unknown tense: one question", () => {
    const added = insertFixedLines(
      partsOf([wordsSend(COMPOSED)]),
      firstTextRow(),
      factsWith(["safetyCrisis"], [CRISIS_UNKNOWN, EMERGENCY_UNKNOWN]),
    );
    expect(added.fixedLines).toEqual(["safetyCrisis", "safetyAsk"]);
    expect(timesIn(wordsOf(added), SAFETY_ASK)).toBe(1);
  });

  it("two safety lines: one question, after the last of them", () => {
    const added = insertFixedLines(
      partsOf([wordsSend(COMPOSED)]),
      firstTextRow(),
      factsWith(["safetyCrisis", "safetyEmergency"], [CRISIS_UNKNOWN]),
    );
    expect(wordsOf(added)).toBe(`${COMPOSED}\n${SAFETY_CRISIS}\n${SAFETY_EMERGENCY}\n${SAFETY_ASK}`);
    expect(added.fixedLines).toEqual(["safetyCrisis", "safetyEmergency", "safetyAsk"]);
  });

  it("a port that lists the question too: one, right after the safety line, wherever the port put it", () => {
    const placed: [readonly string[], readonly string[]][] = [
      [
        ["safetyCrisis", "safetyAsk"],
        ["safetyCrisis", "safetyAsk"],
      ],
      [
        ["safetyAsk", "safetyCrisis"],
        ["safetyCrisis", "safetyAsk"],
      ],
      [
        ["safetyAsk", "codeText", "safetyCrisis", "handlingPrivate"],
        ["codeText", "safetyCrisis", "safetyAsk", "handlingPrivate"],
      ],
    ];
    for (const [listed, lines] of placed) {
      expect(dangerQuestionAfter(listed, [CRISIS_UNKNOWN])).toEqual(lines);
      const added = insertFixedLines(
        partsOf([wordsSend(COMPOSED)]),
        firstTextRow({ reader: "owner" }),
        factsWith(listed, [CRISIS_UNKNOWN]),
      );
      expect(added.fixedLines).toEqual(lines);
      expect(timesIn(wordsOf(added), SAFETY_ASK)).toBe(1);
    }
    // T-314's rule stands: a port that lists one line twice is refused.
    expect(() =>
      insertFixedLines(
        partsOf([wordsSend(COMPOSED)]),
        firstTextRow(),
        factsWith(["safetyAsk", "safetyAsk", "safetyCrisis"], [CRISIS_UNKNOWN]),
      ),
    ).toThrow(/lineListedTwice: safetyAsk/);
  });

  it("parts that carry it already are left as they are: inserting again adds nothing, alone or through the port", async () => {
    const row = firstTextRow();
    const facts = factsWith(["safetyCrisis"], [CRISIS_UNKNOWN], FIRST_TEXT);
    const added = insertFixedLines(partsOf([wordsSend(COMPOSED)]), row, facts);

    expect(timesIn(wordsOf(added), SAFETY_ASK)).toBe(1);
    expect(insertFixedLines(added, row, facts)).toBe(added);
    expect(await fixedLineInserter(factsPort(facts))(added, row, bareContext())).toBe(added);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("the question's words are the bundle's: refused whole when it has none (fail closed)", () => {
  it("a bundle with no words for safetyAsk refuses the row, and nothing is written; with no such label the row goes", async () => {
    const lists = firstTextRow().checks.lists;
    const noAsk = firstTextRow(
      {},
      {
        lists: {
          ...lists,
          fixedLines: { lines: lists.fixedLines.lines.filter((line) => line.id !== SAFETY_ASK_LINE) },
        },
      },
    );
    const facts = factsWith(["safetyCrisis"], [CRISIS_UNKNOWN]);
    expect(() => insertFixedLines(partsOf([wordsSend(COMPOSED)]), noAsk, facts)).toThrow(
      /lineNotInBundle: safetyAsk/,
    );
    const { repo, ports } = repoWithInserter(noAsk, factsPort(facts));
    await expect(runFinalize(passingPlan(), ports)).rejects.toThrow(FixedLineRefusedError);
    expect(repo.calls.writes).toEqual([]);

    const now = factsWith(["safetyCrisis"], [answeredFrom("safety-crisis-words.json")]);
    expect(insertFixedLines(partsOf([wordsSend(COMPOSED)]), noAsk, now).fixedLines).toEqual(["safetyCrisis"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("the rule as readOutboxRow's facts tell it (insert.ts asksIfInDanger, default 1)", () => {
  const text = (outcomes: AnsweredText["outcomes"], tenses: AnsweredText["tenses"]): AnsweredText => ({
    eventId: "evt-alex-0209",
    outcomes,
    tenses,
  });

  it("asks when one text's tenses hold unknown and something other than No holds; never otherwise", () => {
    expect(asksIfInDanger([text(["An emergency"], ["unknown"])])).toBe(true);
    expect(asksIfInDanger([text(["Unsure"], ["unknown"])])).toBe(true);
    expect(asksIfInDanger([text(["Crisis words", "An emergency"], ["now", "unknown"])])).toBe(true);
    expect(asksIfInDanger([text(["No"], ["now"]), text(["An emergency"], ["unknown"])])).toBe(true);

    expect(asksIfInDanger([text(["No"], ["unknown"])])).toBe(false);
    expect(asksIfInDanger([text(["An emergency"], ["now", "over"])])).toBe(false);
    expect(asksIfInDanger([text(["Unsure"], [])])).toBe(false);
    expect(asksIfInDanger([text([], [])])).toBe(false);
    expect(asksIfInDanger([text(null, null)])).toBe(false);
    expect(asksIfInDanger([])).toBe(false);
  });

  it("a No label of unknown tense beside a danger outcome asks too: these facts cannot tell it apart (default 1)", () => {
    // Labels [Harm to a child or older adult, now] and [No, unknown] hold Harm alone. The actor's path, which reads each
    // label's outcome, adds no question there (runtime/src/safety/rules.test.ts); readOutboxRow gives only what holds
    // and the tenses, which are the same as for [Harm, unknown] and [No, now], where the actor's path does ask.
    const mixed = text(["Harm to a child or older adult"], ["now", "unknown"]);
    expect(asksIfInDanger([mixed])).toBe(true);
    expect(dangerQuestionAfter(["safetyEmergency"], [mixed])).toEqual(["safetyEmergency", "safetyAsk"]);
  });

  it("the safety lines are K-01's two, and the question is K-01's safetyAsk", () => {
    expect(SAFETY_LINES).toEqual(["safetyEmergency", "safetyCrisis"]);
    const ids = bundleLists().fixedLines.lines.map((line) => line.id);
    for (const id of [...SAFETY_LINES, SAFETY_ASK_LINE]) expect(ids).toContain(id);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("as the handle actor's direct path does (T-1143's checkedLineFor, on K-02 v1's own safety reads)", () => {
  /** K-01's fixed lines as the actor reads a partial bundle such as bundle v0: no step's own line (T-1143). */
  const PARTIAL: BundleSafety = {
    fixedLine(id) {
      const line = bundleLists().fixedLines.lines.find(
        (candidate) => candidate.id === id && candidate.lang === "en",
      );
      return line === undefined || line.text === null ? null : { id, text: line.text };
    },
    outcomeLine: () => null,
    dangerWords: () => [],
  };

  /** K-02 v1's accepted safety reads (contracts/model/fixtures/index.json). */
  const SAFETY_READS = (
    contractFile("model/fixtures/index.json") as {
      fixtures: readonly { file: string; version: string; def: string; expect: string }[];
    }
  ).fixtures
    .filter((entry) => entry.version === "v1" && entry.def === "safetyResult" && entry.expect === "accept")
    .map((entry) => entry.file);

  /**
   * A K-02 safety read as it is, or with every label's tense unknown. Every v1 read has at most one label, never one of
   * over or joke that holds danger, so unknown keeps what holds: a danger label of unknown tense still holds, a No label
   * still does not (ai/src/safety read.ts heldOutcomes).
   */
  function resultOf(file: string, everyTenseUnknown: boolean): SafetyResult {
    const result = contractFile(`model/fixtures/${file}`) as SafetyResult;
    if (!everyTenseUnknown || result.read === null) return result;
    const labels = result.read.labels.map((label): SafetyLabel => ({ ...label, tense: "unknown" }));
    return { ...result, read: { labels } };
  }

  /** The text as readOutboxRow answers it: what holds and each label's tense (K-34 v1 safety_outcomes). */
  const answeredOf = (result: SafetyResult): AnsweredText => ({
    eventId: result.eventId,
    outcomes: result.outcomes,
    tenses: result.read?.labels.map((label) => label.tense) ?? [],
  });

  /** Each read as it is, and again with every tense unknown where that changes one (a timeout has no label). */
  const READS = SAFETY_READS.flatMap((file) => {
    const asRead = resultOf(file, false);
    const changes = asRead.read?.labels.some((label) => label.tense !== "unknown") ?? false;
    return changes ? [asRead, resultOf(file, true)] : [asRead];
  });
  const SENT = READS.flatMap((result) => {
    const line = checkedLineFor(result, PARTIAL);
    return line === null ? [] : [{ result, line }];
  });

  it("covers K-02's eleven safety reads, and each again with an unknown tense; the actor sends no line for No and a threat", () => {
    expect(SAFETY_READS).toHaveLength(11);
    expect(READS).toHaveLength(19);
    const unsent = READS.filter((result) => checkedLineFor(result, PARTIAL) === null);
    expect(unsent.map((result) => result.outcomes)).toEqual([
      ["No"],
      ["No"],
      ["A threat to staff or others"],
      ["A threat to staff or others"],
      ["No"],
      ["No"],
    ]);
    expect(SENT).toHaveLength(13);
    // Both kinds are here: lines that ask, and lines that do not.
    const asking = SENT.filter(({ line }) => line.text.endsWith(` ${SAFETY_ASK}`));
    expect(asking.length).toBeGreaterThan(0);
    expect(asking.length).toBeLessThan(SENT.length);
  });

  it.each(
    SENT.map(({ result, line }) => {
      const read = (result.read?.labels ?? []).map((label) => `${label.outcome} (${label.tense})`);
      return [`${result.eventId}: ${read.join(", ") || "timed out"}`, result, line] as const;
    }),
  )("%s: the same line, then the same question when the actor's path asks it", (_name, result, line) => {
    const asks = line.text.endsWith(` ${SAFETY_ASK}`);
    const added = insertFixedLines(
      partsOf([wordsSend(COMPOSED)]),
      firstTextRow(),
      factsWith([line.id], [answeredOf(result)]),
    );

    expect(asksIfInDanger([answeredOf(result)])).toBe(asks);
    expect(added.fixedLines).toEqual(asks ? [line.id, SAFETY_ASK_LINE] : [line.id]);
    // The actor's direct send puts the question on the line's own line; the inserter puts each fixed line on its own.
    expect(wordsOf(added)).toBe(
      `${COMPOSED}\n${asks ? line.text.replace(` ${SAFETY_ASK}`, `\n${SAFETY_ASK}`) : line.text}`,
    );
  });
});
