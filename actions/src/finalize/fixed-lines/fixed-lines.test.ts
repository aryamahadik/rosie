// Tests of the fixed-line inserter (T-314, C-089; arch 07 line 361; RULES 1.11, 4.3; S13-01, S13-02, S13-19, S13-45;
// Q-30). The inserter runs alone and as the finalize call's insertFixedLines port, through the Tool API base on T-313's
// fake repo, with the slot filler, the claim check and the message checks for real; the send-state facts are a double of
// the inserter's port (test-support.ts). Values are the master's sample cast (rule 9).

import { describe, expect, it } from "vitest";

import { fixedLinesFaults, lengthAndReadingFaults, runMessageChecks, type FixedLine } from "../checks";
import { fixedLineWords } from "../checks/reading";
import {
  passedOnParts,
  passedOnWords,
  type FinalizeRequest,
  type FinalizeResponse,
  type FinalParts,
} from "../rewrite";
import {
  a717Source,
  bareContext,
  exchange,
  runFinalize,
  stringsIn,
  type CallRun,
} from "../rewrite/test-support";
import {
  FIRST_TEXT_LINES,
  FixedLineRefusedError,
  SIGN_UP_OPENER_LINE,
  claimedBusiness,
  firstTextLines,
  fixedLineInserter,
  insertFixedLines,
  notBuiltFixedLinePorts,
  openerOf,
  type FixedLineFacts,
} from "./index";
import {
  CODE_TEXT_LINE,
  DAY,
  FIRST_TEXT,
  HANDLING_LINE,
  OPENER,
  OPT_OUT,
  OPT_OUT_ES,
  PRIVACY,
  RILEY,
  SAFETY_ASK,
  SECOND_TEXT,
  SIGN_UP_FIRST_TEXT,
  SIGN_UP_OPENER,
  bundleV2Manifest,
  factsPort,
  firstTextRow,
  listsWithFirstText,
  listsWithSignUpOpener,
  msgtextSource,
  partsOf,
  repoWithInserter,
  signUpRow,
  wordsSend,
} from "./test-support";

const REWRITE = exchange("finalize-rewrite.json");
const PASSED_ON = exchange("finalize-passed-on.json");

/** A7-17's composed plan, put so that every check passes: Riley can't be in on Saturday. */
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

/** The facts with other lines the row carries. */
const withLines = (facts: FixedLineFacts, lines: readonly string[]): FixedLineFacts => ({ ...facts, lines });

/**
 * A sentence of ten one-syllable words, 43 characters with its full stop, starting with a capital as the master's split
 * needs to see a new sentence (lib.js): no value, no name, a low grade.
 */
const SENTENCE = "We will keep the chair for you at the shop.";

// ---------------------------------------------------------------------------------------------------------------

describe("first texts: the opener, the opt-out line and the privacy link last (arch 07 line 361; Q-30)", () => {
  it("the first text to a new handle about a business carries S13-01's opener, the opt-out line and the privacy link alone on the last line", () => {
    const row = firstTextRow();
    const parts = partsOf([wordsSend(COMPOSED)]);
    const added = insertFixedLines(parts, row, FIRST_TEXT);

    expect(wordsOf(added)).toBe(`${OPENER} ${COMPOSED}\n${OPT_OUT}\n${PRIVACY}`);
    expect(wordsOf(added)?.split("\n").at(-1)).toBe(PRIVACY);
    expect(added.fixedLines).toEqual(["opener", "optOutLine", "privacyLink"]);
    // Every fixed line word for word as the Fixed lines check reads it, and all seven checks pass.
    expect(runMessageChecks(added, row.checks).checks.every((check) => check.passed)).toBe(true);
  });

  it("the second text to that handle about that business carries none of them", () => {
    const parts = partsOf([wordsSend(COMPOSED)]);
    expect(insertFixedLines(parts, firstTextRow(), SECOND_TEXT)).toBe(parts);
    expect(firstTextLines("imessage", SECOND_TEXT)).toEqual({
      opener: false,
      optOut: false,
      privacyLink: false,
    });
  });

  it("through the finalize call: the first text is written with the three lines, every check passed; the second text carries none", async () => {
    const port = factsPort(FIRST_TEXT);
    const first = repoWithInserter(firstTextRow(), port);
    const sent = responseOf(await runFinalize(passingPlan(), first.ports));

    expect(sent.outcome).toBe("send");
    expect(sent.checks[0].checks.every((check) => check.passed)).toBe(true);
    expect(wordsOf(sent.finalParts)).toBe(`${OPENER} ${COMPOSED}\n${OPT_OUT}\n${PRIVACY}`);
    expect(sent.finalParts?.fixedLines).toEqual(["opener", "optOutLine", "privacyLink"]);
    expect(first.repo.calls.writes.map((write) => write.finalParts)).toEqual([sent.finalParts]);
    // The facts are read in the call's own business scope, once for the one attempt.
    expect(port.reads).toEqual(["outbox-a7-17-alex-text@biz-lees-barbershop"]);

    const second = repoWithInserter(firstTextRow(), factsPort(SECOND_TEXT));
    const later = responseOf(await runFinalize(passingPlan(), second.ports));
    expect(later.outcome).toBe("send");
    expect(wordsOf(later.finalParts)).toBe(COMPOSED);
    expect(later.finalParts?.fixedLines).toEqual([]);
  });

  it("a number's first text about another business: the opener and the privacy link, never the opt-out line again (RULES 4.3)", () => {
    const facts: FixedLineFacts = { ...FIRST_TEXT, optOutLineDeliveredAt: "2026-10-12T16:20:00Z" };
    const added = insertFixedLines(partsOf([wordsSend(COMPOSED)]), firstTextRow(), facts);
    expect(wordsOf(added)).toBe(`${OPENER} ${COMPOSED}\n${PRIVACY}`);
    expect(added.fixedLines).toEqual(["opener", "privacyLink"]);
  });

  it("the opt-out line rides on a number's texts until one that carried it is delivered (arch 07 line 361)", () => {
    const facts: FixedLineFacts = { ...SECOND_TEXT, optOutLineDeliveredAt: null };
    const added = insertFixedLines(partsOf([wordsSend(COMPOSED)]), firstTextRow(), facts);
    expect(wordsOf(added)).toBe(`${COMPOSED}\n${OPT_OUT}`);
    expect(added.fixedLines).toEqual(["optOutLine"]);
  });

  it("an email row never carries the opt-out line, a number's line; its first text about a business carries the opener and the privacy link", () => {
    const parts: FinalParts = { ...partsOf([wordsSend(COMPOSED)]), channel: "email" };
    const added = insertFixedLines(parts, firstTextRow({ channel: "email" }), FIRST_TEXT);
    expect(wordsOf(added)).toBe(`${OPENER} ${COMPOSED}\n${PRIVACY}`);
    expect(added.fixedLines).toEqual(["opener", "privacyLink"]);
  });

  it("with a poll after the words, the lines go in the words, the privacy link last there, and the poll keeps the step's words", () => {
    const typed = "Reply 1 Keep my visit, 2 Call off the visit.";
    const poll = {
      kind: "poll" as const,
      text: null,
      calendarFile: "none" as const,
      options: [
        { id: "A7-17/1", label: "Keep my visit" },
        { id: "A7-17/2", label: "Call off the visit" },
      ],
      link: null,
    };
    const parts = partsOf([wordsSend(`${COMPOSED}\nKeep your visit, or call it off?\n${typed}`), poll]);
    const row = firstTextRow({}, { options: poll.options, typedOptions: typed });
    const added = insertFixedLines(parts, row, FIRST_TEXT);

    expect(wordsOf(added)).toBe(
      `${OPENER} ${COMPOSED}\nKeep your visit, or call it off?\n${typed}\n${OPT_OUT}\n${PRIVACY}`,
    );
    expect(added.sends[1]).toEqual(poll);
    expect(runMessageChecks(added, row.checks).checks.every((check) => check.passed)).toBe(true);
  });

  it("a poll or card alone gets a words send before it for the lines; a tapback alone, which carries no words, is refused", () => {
    const card = {
      kind: "linkCard" as const,
      text: "Lee's Barbershop",
      calendarFile: "none" as const,
      options: [],
      link: "rosfield.com/v/s03",
    };
    const added = insertFixedLines(partsOf([card]), firstTextRow(), FIRST_TEXT);
    expect(added.sends).toEqual([wordsSend(`${OPENER}\n${OPT_OUT}\n${PRIVACY}`), card]);

    const tapback = {
      kind: "tapback" as const,
      text: null,
      calendarFile: "none" as const,
      options: [],
      link: null,
    };
    expect(() => insertFixedLines(partsOf([tapback], []), firstTextRow(), FIRST_TEXT)).toThrow(
      /tapbackAlone/,
    );
    // A tapback is never a first text in practice; on a later text it carries nothing and goes as it is.
    const later = partsOf([tapback], []);
    expect(insertFixedLines(later, firstTextRow(), SECOND_TEXT)).toBe(later);
  });

  it("the passed-on line of a first text carries them too (finalize's passed-on path writes it as it is)", async () => {
    const { repo, ports } = repoWithInserter(firstTextRow(), factsPort(FIRST_TEXT));
    const response = responseOf(await runFinalize(PASSED_ON.request, ports));

    expect(response.outcome).toBe("passedOn");
    expect(wordsOf(response.finalParts)).toBe(
      `${OPENER} I’ve passed this on. Rosie’s team will reply within 1 business day.\n${OPT_OUT}\n${PRIVACY}`,
    );
    expect(response.finalParts?.fixedLines).toEqual(["passedOn", "opener", "optOutLine", "privacyLink"]);
    expect(response.finalParts?.slotValues).toEqual([]);
    expect(repo.calls.writes).toHaveLength(1);
    // Each attempt checked carried the lines word for word: the Fixed lines check passed on both.
    for (const result of response.checks)
      expect(result.checks.find((check) => check.check === "fixedLines")?.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("outside the length counts: the 260 or 320 characters and the 22 words (arch 07 lines 361, 413, 417)", () => {
  it("own words of 307 characters with the first text's lines pass the 320; counted as the model's, the same words fail", () => {
    const own = Array.from({ length: 7 }, () => SENTENCE).join(" ");
    expect(own).toHaveLength(307);
    const row = firstTextRow();
    const added = insertFixedLines(partsOf([wordsSend(own)], []), row, FIRST_TEXT);
    expect(wordsOf(added)?.length).toBeGreaterThan(320);

    expect(lengthAndReadingFaults(added, row.checks)).toEqual([]);
    expect(lengthAndReadingFaults({ ...added, fixedLines: [] }, row.checks).join(" ")).toContain(
      "keep them to 320",
    );
  });

  it("with a poll, own words of 236 characters and the lines pass the 260; counted as the model's, they fail", () => {
    const own = [...Array.from({ length: 5 }, () => SENTENCE), "We will keep it."].join(" ");
    expect(own).toHaveLength(236);
    const poll = {
      kind: "poll" as const,
      text: null,
      calendarFile: "none" as const,
      options: [
        { id: "A7-17/1", label: "Keep my visit" },
        { id: "A7-17/2", label: "Call off the visit" },
      ],
      link: null,
    };
    const row = firstTextRow();
    const added = insertFixedLines(partsOf([wordsSend(own), poll], []), row, FIRST_TEXT);

    expect(lengthAndReadingFaults(added, row.checks)).toEqual([]);
    expect(lengthAndReadingFaults({ ...added, fixedLines: [] }, row.checks).join(" ")).toContain(
      "keep them to 260 with a poll or card",
    );
  });

  it("a fixed line of 30 words in one sentence is no sentence of the model's: the 22 words never count it", () => {
    const long: FixedLine = {
      id: "termLong",
      text: `${[1, 2, 3].map(() => SENTENCE.slice(0, -1)).join(" ")}.`,
      lang: "en",
    };
    const lists = listsWithFirstText();
    const row = firstTextRow(
      {},
      { lists: { ...lists, fixedLines: { lines: [...lists.fixedLines.lines, long] } } },
    );
    const added = insertFixedLines(partsOf([wordsSend(COMPOSED)]), row, withLines(SECOND_TEXT, ["termLong"]));

    expect(wordsOf(added)).toBe(`${COMPOSED}\n${long.text ?? ""}`);
    expect(lengthAndReadingFaults(added, row.checks)).toEqual([]);
    expect(lengthAndReadingFaults({ ...added, fixedLines: [] }, row.checks).join(" ")).toContain(
      "has 30 words; keep each sentence to 22 words or fewer",
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("Spanish handles: msgtext.js's es wording of S13-02's line (msgtext.js line 14)", () => {
  it("the opt-out line words are msgtext.js's own, in English and in Spanish (WORDS lines 31 and 32, joined as stopLine joins them)", () => {
    const source = msgtextSource();
    expect(source).toContain('return parts.join(" ");');
    for (const [lang, line] of [
      ["en", OPT_OUT],
      ["es", OPT_OUT_ES],
    ] as const) {
      const words = new RegExp(`${lang}: \\{[^}]*\\}`).exec(source)?.[0] ?? "";
      const part = (key: string): string => new RegExp(`${key}: "([^"]*)"`).exec(words)?.[1] ?? `(no ${key})`;
      expect([part("stop"), part("rates"), part("help")].join(" "), lang).toBe(line);
    }
  });

  it("a Spanish handle's first text carries the es opt-out line word for word, through the finalize call", async () => {
    const row = firstTextRow({}, { language: "es" });
    const { ports } = repoWithInserter(row, factsPort(FIRST_TEXT));
    const response = responseOf(await runFinalize(passingPlan(), ports));

    expect(response.outcome).toBe("send");
    // The bundle has no Spanish opener or privacy line yet, so those go in English, as the Fixed lines check reads them.
    expect(wordsOf(response.finalParts)).toBe(`${OPENER} ${COMPOSED}\n${OPT_OUT_ES}\n${PRIVACY}`);
    expect(response.checks[0].checks.find((check) => check.check === "fixedLines")?.passed).toBe(true);
    expect(fixedLineWords("optOutLine", row.checks)).toEqual({ words: OPT_OUT_ES });
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("the code text, safety lines, checked terms and the handling line, each word for word (S13-45, arch 06, S13-19)", () => {
  it("each line the row carries goes on its own line after the words, before the opt-out line and the privacy link, <business> filled", () => {
    const row = firstTextRow({ reader: "owner" });
    const lines = ["codeText", "safetyAsk", "handlingPrivate"];
    const code = (CODE_TEXT_LINE.text ?? "").replace("<business>", "Lee's Barbershop");
    const handling = HANDLING_LINE.text ?? "";

    const later = insertFixedLines(partsOf([wordsSend(COMPOSED)]), row, withLines(SECOND_TEXT, lines));
    expect(wordsOf(later)).toBe(`${COMPOSED}\n${code}\n${SAFETY_ASK}\n${handling}`);
    expect(later.fixedLines).toEqual(lines);

    const first = insertFixedLines(partsOf([wordsSend(COMPOSED)]), row, withLines(FIRST_TEXT, lines));
    expect(wordsOf(first)).toBe(
      `${OPENER} ${COMPOSED}\n${code}\n${SAFETY_ASK}\n${handling}\n${OPT_OUT}\n${PRIVACY}`,
    );
    expect(first.fixedLines).toEqual(["opener", ...lines, "optOutLine", "privacyLink"]);
  });

  it("through the finalize call they pass every check: word for word, and outside Shape and Length", async () => {
    const row = firstTextRow({ reader: "owner" });
    const facts = withLines(FIRST_TEXT, ["codeText", "safetyAsk", "handlingPrivate"]);
    const { ports } = repoWithInserter(row, factsPort(facts));
    const response = responseOf(await runFinalize(passingPlan(), ports));

    expect(response.outcome).toBe("send");
    expect(response.checks[0].checks.every((check) => check.passed)).toBe(true);
    expect(response.finalParts?.fixedLines).toEqual([
      "opener",
      "codeText",
      "safetyAsk",
      "handlingPrivate",
      "optOutLine",
      "privacyLink",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("<business> as limit 7 lets this reader see it (STATE note 26; RULES 4.6, S13-22)", () => {
  it("is biz.name through the claim check: the business's name, and its display name under the sensitive switch", () => {
    expect(claimedBusiness(firstTextRow())).toBe("Lee's Barbershop");
    expect(claimedBusiness(firstTextRow({ source: { ...a717Source(), sensitive: true } }))).toBe("Lee's");
    expect(claimedBusiness(firstTextRow({ source: { ...a717Source(), facts: {} } }))).toBeNull();
  });

  it("under the sensitive switch the opener names the display name, which the row read gives the checks: every check passes", async () => {
    const row = firstTextRow({ source: { ...a717Source(), sensitive: true } }, { businessName: "Lee's" });
    const { ports } = repoWithInserter(row, factsPort(FIRST_TEXT));
    const response = responseOf(await runFinalize(passingPlan(), ports));

    expect(response.outcome).toBe("send");
    expect(wordsOf(response.finalParts)).toBe(
      `This is Rosie, the automated booking assistant for Lee's. ${COMPOSED}\n${OPT_OUT}\n${PRIVACY}`,
    );
    expect(stringsIn(response).join(" ")).not.toContain("Lee's Barbershop");
  });

  it("a row read whose businessName is not the claimed name is refused whole, and nothing is written", async () => {
    const row = firstTextRow({ source: { ...a717Source(), sensitive: true } });
    expect(() => insertFixedLines(partsOf([wordsSend(COMPOSED)]), row, FIRST_TEXT)).toThrow(
      /businessNotClaimed: opener/,
    );
    const { repo, ports } = repoWithInserter(row, factsPort(FIRST_TEXT));
    await expect(runFinalize(passingPlan(), ports)).rejects.toThrow(FixedLineRefusedError);
    expect(repo.calls.writes).toEqual([]);
  });

  it("an opener that names <business> with no business for it is refused (S1-02's opener has no K-01 words yet)", () => {
    const parts = partsOf([wordsSend(COMPOSED)]);
    const noBusiness = firstTextRow({ source: { ...a717Source(), facts: {} } }, { businessName: null });
    expect(() => insertFixedLines(parts, noBusiness, FIRST_TEXT)).toThrow(/noBusiness: opener/);
    const notSeen = firstTextRow({ source: { ...a717Source(), facts: {} } });
    expect(() => insertFixedLines(parts, notSeen, FIRST_TEXT)).toThrow(/businessNotClaimed: opener/);
    // A line that names no business needs none: the second text's opt-out line still goes.
    const rides: FixedLineFacts = { ...SECOND_TEXT, optOutLineDeliveredAt: null };
    expect(wordsOf(insertFixedLines(parts, noBusiness, rides))).toBe(`${COMPOSED}\n${OPT_OUT}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("refused whole when a line cannot go word for word: nothing written (fail closed)", () => {
  it("a first text while the bundle has no privacy link line (K-01 v1's sample list)", async () => {
    const row = firstTextRow();
    const sample = firstTextRow(
      {},
      {
        lists: {
          ...row.checks.lists,
          fixedLines: {
            lines: row.checks.lists.fixedLines.lines.filter((line) => line.id !== "privacyLink"),
          },
        },
      },
    );
    expect(() => insertFixedLines(partsOf([wordsSend(COMPOSED)]), sample, FIRST_TEXT)).toThrow(
      /lineNotInBundle: privacyLink/,
    );
    const { repo, ports } = repoWithInserter(sample, factsPort(FIRST_TEXT));
    await expect(runFinalize(passingPlan(), ports)).rejects.toThrow(/lineNotInBundle: privacyLink/);
    expect(repo.calls.writes).toEqual([]);
  });

  it("a line that waits for Jay, stopReply, a first text's line asked for by the port, a line asked for twice, a line not in the bundle", () => {
    const parts = partsOf([wordsSend(COMPOSED)]);
    const row = firstTextRow();
    const cases: [readonly string[], RegExp][] = [
      [["helpReply"], /lineWaitsForJay: helpReply/],
      [["stopReply"], /stopReplyLine: stopReply/],
      [["optOutLine"], /firstTextLineListed: optOutLine/],
      [["opener"], /firstTextLineListed: opener/],
      [["safetyAsk", "safetyAsk"], /lineListedTwice: safetyAsk/],
      [["madeUp"], /lineNotInBundle: madeUp/],
    ];
    for (const [lines, fault] of cases)
      expect(() => insertFixedLines(parts, row, withLines(SECOND_TEXT, lines))).toThrow(fault);
  });

  it("a refusal names only its fault and a line id: never a name, a line's words or anything that is not an id", () => {
    const row = firstTextRow({ source: { ...a717Source(), sensitive: true } });
    let refused: unknown = null;
    try {
      insertFixedLines(partsOf([wordsSend(COMPOSED)]), row, FIRST_TEXT);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(FixedLineRefusedError);
    const message = (refused as Error).message;
    for (const value of ["Lee's", "Riley", "Sat Oct 24", "Rosie", "STOP"])
      expect(message).not.toContain(value);
    expect(new FixedLineRefusedError("lineNotInBundle", "Alex M. +15555550177").message).toBe(
      "insertFixedLines: refused (lineNotInBundle); nothing was written",
    );
  });

  it("while the send-state reader is not built, the finalize call answers notBuilt and writes nothing", async () => {
    const { repo, ports } = repoWithInserter(firstTextRow(), notBuiltFixedLinePorts());
    const run = await runFinalize(passingPlan(), ports);
    expect(run.answer).toEqual({ error: "notBuilt", call: "finalizeMessage" });
    expect(repo.calls.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("the parts are kept as they are around the lines (STATE note 34)", () => {
  it("keeps the slot values, the parts' own fixed lines, the row, the channel and the thread, and adds no slot value", async () => {
    const parts: FinalParts = {
      ...partsOf([wordsSend(COMPOSED)], [RILEY, DAY], ["passedOn"]),
      threadReplyTo: "msg-alex-1",
    };
    const added = insertFixedLines(parts, firstTextRow(), FIRST_TEXT);
    expect(added.slotValues).toEqual([RILEY, DAY]);
    expect(added.fixedLines).toEqual(["passedOn", "opener", "optOutLine", "privacyLink"]);
    expect({ row: added.row, channel: added.channel, thread: added.threadReplyTo }).toEqual({
      row: parts.row,
      channel: parts.channel,
      thread: "msg-alex-1",
    });
    // A line the parts carry already is not added twice.
    expect(insertFixedLines(added, firstTextRow(), FIRST_TEXT)).toBe(added);

    // Through the port, the same: the parts the finalize call checks keep every slot value it filled.
    const through = await fixedLineInserter(factsPort(FIRST_TEXT))(parts, firstTextRow(), bareContext());
    expect(through).toEqual(added);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T-1511: K-01 README default 19 (T-1510; DL-1033 fault 1). An owner's sign-up texts open with S1-02's own words,
// signUpOpener, never with a business the owner has not named.

const PASS = exchange("finalize-pass.json");

/** finalize-pass.json's final words: S1-02's own words before the composed plan (the fixture marks them "opener"). */
const PASS_TEXT = PASS.outcome.finalParts?.sends[0].text ?? "";

/** S1-02's fallback text, the master's S1-02 words (T-313's S1-02 row): it begins with the sign-up opener's words. */
const S1_02_FALLBACK = signUpRow().fallbackText ?? "";

/** How many times `piece` stands in `text`. */
const timesIn = (text: string | null | undefined, piece: string): number =>
  (text ?? "").split(piece).length - 1;

/** The sign-up row's composed plan as its one rewrite, put to miss Values: a slot this row holds no value for. */
function missingRewrite(): FinalizeRequest {
  const base = PASS.request;
  return {
    ...base,
    attempt: "rewrite",
    plan: {
      ...base.plan,
      plan: {
        ...base.plan.plan,
        lines: [{ role: "first", text: "{{pro.name}} will set up your business." }],
      },
    },
  };
}

/** The sign-up row on a bundle without the line (bundles v0, v1, v1.1): K-01 v1's lines with the first text's. */
const withoutTheLine = (change: Parameters<typeof signUpRow>[0] = {}) =>
  signUpRow(change, { lists: listsWithFirstText() });

describe("the sign-up opener: S1-02's own words in opener's place on an owner's sign-up texts (K-01 README default 19)", () => {
  it("bundle v2 carries the line as default 19 states it, once, naming no business; S1-02's master text begins with it", () => {
    const lines = bundleV2Manifest().lists.fixedLines.lines.filter((line) => line.id === SIGN_UP_OPENER_LINE);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      id: "signUpOpener",
      text: SIGN_UP_OPENER,
      lang: "en",
      status: "asWritten",
    });
    expect(S1_02_FALLBACK.startsWith(SIGN_UP_OPENER)).toBe(true);
    expect(PASS_TEXT.startsWith(`${SIGN_UP_OPENER} `)).toBe(true);
    // No <business> in it: the Fixed lines check takes it as written with no business at all.
    expect(fixedLineWords(SIGN_UP_OPENER_LINE, signUpRow().checks)).toEqual({ words: SIGN_UP_OPENER });
    expect(FIRST_TEXT_LINES).toContain(SIGN_UP_OPENER_LINE);
  });

  it("the signUp fact picks the opener, one per row: signUpOpener when true, today's opener when false", () => {
    expect(openerOf(SIGN_UP_FIRST_TEXT)).toBe("signUpOpener");
    expect(openerOf(FIRST_TEXT)).toBe("opener");
    // Whether the row carries an opener at all is the first-text rule's alone, the same for both.
    expect(firstTextLines("imessage", SIGN_UP_FIRST_TEXT)).toEqual(firstTextLines("imessage", FIRST_TEXT));
    expect(
      insertFixedLines(partsOf([wordsSend(COMPOSED)]), signUpRow(), { ...SECOND_TEXT, signUp: true }),
    ).toEqual(insertFixedLines(partsOf([wordsSend(COMPOSED)]), signUpRow(), SECOND_TEXT));
  });

  it("through the finalize call: the owner's first sign-up text is finalize-pass.json's words with the opt-out line and the privacy link, fixedLines signUpOpener first, every check passed, no business named", async () => {
    const { repo, ports } = repoWithInserter(signUpRow(), factsPort(SIGN_UP_FIRST_TEXT));
    const sent = responseOf(await runFinalize(PASS.request, ports));

    expect(sent.outcome).toBe("send");
    expect(sent.checks[0].checks.every((check) => check.passed)).toBe(true);
    expect(wordsOf(sent.finalParts)).toBe(`${PASS_TEXT}\n${OPT_OUT}\n${PRIVACY}`);
    expect(sent.finalParts?.fixedLines).toEqual(["signUpOpener", "optOutLine", "privacyLink"]);
    expect(timesIn(wordsOf(sent.finalParts), SIGN_UP_OPENER)).toBe(1);
    expect(stringsIn(sent).join(" ")).not.toContain("booking assistant for");
    expect(repo.calls.writes.map((write) => write.finalParts)).toEqual([sent.finalParts]);
  });

  it("with the opt-out line delivered before, the ids go in the order signUpOpener, privacyLink (the privacy link alone on the last line)", async () => {
    const delivered: FixedLineFacts = {
      ...SIGN_UP_FIRST_TEXT,
      optOutLineDeliveredAt: "2026-10-12T16:20:00Z",
    };
    const { ports } = repoWithInserter(signUpRow(), factsPort(delivered));
    const sent = responseOf(await runFinalize(PASS.request, ports));

    expect(sent.outcome).toBe("send");
    expect(sent.finalParts?.fixedLines).toEqual(["signUpOpener", "privacyLink"]);
    expect(wordsOf(sent.finalParts)).toBe(`${PASS_TEXT}\n${PRIVACY}`);
  });

  it("names no business whatever the row holds: a business's name, or none at all; the same row with signUp false needs one (noBusiness)", () => {
    // A row whose business head holds a name, as staging's stand-in head does: the sign-up opener never shows it.
    const named = firstTextRow({ reader: "owner" }, { lists: listsWithSignUpOpener() });
    const added = insertFixedLines(partsOf([wordsSend(COMPOSED)]), named, SIGN_UP_FIRST_TEXT);
    expect(wordsOf(added)).toBe(`${SIGN_UP_OPENER} ${COMPOSED}\n${OPT_OUT}\n${PRIVACY}`);
    expect(wordsOf(added)).not.toContain("Lee's Barbershop");
    expect(runMessageChecks(added, named.checks).checks.every((check) => check.passed)).toBe(true);

    // S1-02's row before there is a business: signUpOpener goes; today's opener cannot fill <business> and is refused.
    const parts = partsOf([wordsSend(COMPOSED)], []);
    expect(insertFixedLines(parts, signUpRow(), SIGN_UP_FIRST_TEXT).fixedLines).toEqual([
      "signUpOpener",
      "optOutLine",
      "privacyLink",
    ]);
    expect(() => insertFixedLines(parts, signUpRow(), FIRST_TEXT)).toThrow(/noBusiness: opener/);
  });

  it("every other row keeps today's opener with the business's name, exactly as before (a reader by a role, staff or a customer, a step that needs business)", () => {
    const row = firstTextRow({}, { lists: listsWithSignUpOpener() });
    const added = insertFixedLines(partsOf([wordsSend(COMPOSED)]), row, FIRST_TEXT);
    expect(wordsOf(added)).toBe(`${OPENER} ${COMPOSED}\n${OPT_OUT}\n${PRIVACY}`);
    expect(added.fixedLines).toEqual(["opener", "optOutLine", "privacyLink"]);
    // The bundle carrying the sign-up line changes nothing for such a row: the same parts as on K-01 v1's lists.
    expect(added).toEqual(insertFixedLines(partsOf([wordsSend(COMPOSED)]), firstTextRow(), FIRST_TEXT));
  });

  it("one opener per row: parts that carry either id get neither again, and the port may never ask for signUpOpener", () => {
    const row = firstTextRow({}, { lists: listsWithSignUpOpener() });
    const cases: [string, FixedLineFacts][] = [
      ["opener", SIGN_UP_FIRST_TEXT],
      ["signUpOpener", FIRST_TEXT],
      ["signUpOpener", SIGN_UP_FIRST_TEXT],
      ["opener", FIRST_TEXT],
    ];
    for (const [carried, facts] of cases) {
      const added = insertFixedLines(partsOf([wordsSend(COMPOSED)], [RILEY, DAY], [carried]), row, facts);
      expect(added.fixedLines, carried).toEqual([carried, "optOutLine", "privacyLink"]);
      expect(wordsOf(added), carried).toBe(`${COMPOSED}\n${OPT_OUT}\n${PRIVACY}`);
    }
    expect(() =>
      insertFixedLines(partsOf([wordsSend(COMPOSED)]), row, { ...SECOND_TEXT, lines: ["signUpOpener"] }),
    ).toThrow(/firstTextLineListed: signUpOpener/);
  });
});

describe("no doubles: words that already begin with the opener's exact words get its id and no second copy (default 19)", () => {
  it("S1-02's fallback text, which begins with the sign-up opener's words: the id is recorded, the words stay once, and the Fixed lines check finds them", () => {
    const row = signUpRow();
    const parts = partsOf([wordsSend(S1_02_FALLBACK)], []);
    const added = insertFixedLines(parts, row, SIGN_UP_FIRST_TEXT);

    expect(wordsOf(added)).toBe(`${S1_02_FALLBACK}\n${OPT_OUT}\n${PRIVACY}`);
    expect(timesIn(wordsOf(added), SIGN_UP_OPENER)).toBe(1);
    expect(added.fixedLines).toEqual(["signUpOpener", "optOutLine", "privacyLink"]);
    expect(fixedLinesFaults(added, row.checks)).toEqual([]);
    // On a later text the opener's words are the text's own: nothing is recorded or added.
    expect(insertFixedLines(parts, row, { ...SECOND_TEXT, signUp: true })).toBe(parts);
  });

  it("through the finalize call's fallback attempt (index.ts fallbackAttempt): the rewrite misses Values, S1-02's fallback is sent with the sign-up opener's words once", async () => {
    const { repo, ports } = repoWithInserter(signUpRow(), factsPort(SIGN_UP_FIRST_TEXT));
    const response = responseOf(await runFinalize(missingRewrite(), ports));

    expect(response.checks.map((result) => [result.attempt, result.outcome])).toEqual([
      ["rewrite", "fallback"],
      ["fallback", "send"],
    ]);
    expect(response.outcome).toBe("send");
    expect(wordsOf(response.finalParts)).toBe(`${S1_02_FALLBACK}\n${OPT_OUT}\n${PRIVACY}`);
    expect(timesIn(wordsOf(response.finalParts), SIGN_UP_OPENER)).toBe(1);
    expect(response.finalParts?.fixedLines).toEqual(["signUpOpener", "optOutLine", "privacyLink"]);
    expect(response.checks[1]?.checks.find((check) => check.check === "fixedLines")?.passed).toBe(true);
    expect(repo.calls.writes.map((write) => write.finalParts)).toEqual([response.finalParts]);
  });

  it("the same rule for opener with its name filled: words that begin with it get the id and no second copy", () => {
    const row = firstTextRow();
    const parts = partsOf([wordsSend(`${OPENER} ${COMPOSED}`)]);
    const added = insertFixedLines(parts, row, FIRST_TEXT);
    expect(wordsOf(added)).toBe(`${OPENER} ${COMPOSED}\n${OPT_OUT}\n${PRIVACY}`);
    expect(timesIn(wordsOf(added), OPENER)).toBe(1);
    expect(added.fixedLines).toEqual(["opener", "optOutLine", "privacyLink"]);
    expect(runMessageChecks(added, row.checks).checks.every((check) => check.passed)).toBe(true);
  });

  it("only the exact words from the first character count: words that merely resemble the line, or hold it later, get the line before them", () => {
    const row = signUpRow();
    for (const text of [
      `Hi, I'm Rosie, an automated assistant. ${COMPOSED}`,
      `hi! i'm rosie, an automated assistant. ${COMPOSED}`,
      ` ${S1_02_FALLBACK}`,
    ]) {
      const added = insertFixedLines(partsOf([wordsSend(text)], []), row, SIGN_UP_FIRST_TEXT);
      expect(wordsOf(added), text).toBe(`${SIGN_UP_OPENER} ${text}\n${OPT_OUT}\n${PRIVACY}`);
      expect(added.fixedLines, text).toEqual(["signUpOpener", "optOutLine", "privacyLink"]);
    }
  });

  it("pinned as default 19 accepts it: an owner who already holds a role gets opener before S1-02's fallback, so both openers' words show (K-05's test world only)", () => {
    // A reader by the owner's role is never read by the sign-up line, so signUp is false (rows.ts signUpOf).
    const row = firstTextRow({ reader: "owner" });
    const added = insertFixedLines(partsOf([wordsSend(S1_02_FALLBACK)], []), row, FIRST_TEXT);
    expect(wordsOf(added)).toBe(`${OPENER} ${S1_02_FALLBACK}\n${OPT_OUT}\n${PRIVACY}`);
    expect(added.fixedLines).toEqual(["opener", "optOutLine", "privacyLink"]);
    expect(timesIn(wordsOf(added), SIGN_UP_OPENER)).toBe(1);
    expect(timesIn(wordsOf(added), OPENER)).toBe(1);
  });
});

describe("fail closed: a pinned bundle without signUpOpener refuses an owner's sign-up text, never falling back to opener (default 19)", () => {
  it("the inserter refuses it (lineNotInBundle: signUpOpener), even when the words already begin with the line's words, and with a business to name", () => {
    const parts = partsOf([wordsSend(COMPOSED)], []);
    expect(() => insertFixedLines(parts, withoutTheLine(), SIGN_UP_FIRST_TEXT)).toThrow(
      /lineNotInBundle: signUpOpener/,
    );
    expect(() =>
      insertFixedLines(partsOf([wordsSend(S1_02_FALLBACK)], []), withoutTheLine(), SIGN_UP_FIRST_TEXT),
    ).toThrow(/lineNotInBundle: signUpOpener/);
    // A row whose business has a name still never gets opener in its place.
    let refused: unknown = null;
    try {
      insertFixedLines(partsOf([wordsSend(COMPOSED)]), firstTextRow({ reader: "owner" }), SIGN_UP_FIRST_TEXT);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(FixedLineRefusedError);
    expect(refused).toMatchObject({ fault: "lineNotInBundle", line: "signUpOpener" });
    // The line's words alone are no line: a bundle must carry it by its id.
    expect(fixedLinesFaults({ ...parts, fixedLines: ["signUpOpener"] }, withoutTheLine().checks)).toEqual([
      "The fixed line signUpOpener is not one of the bundle's fixed lines.",
    ]);
  });

  it("through the finalize call the text is refused whole and nothing is written", async () => {
    const { repo, ports } = repoWithInserter(withoutTheLine(), factsPort(SIGN_UP_FIRST_TEXT));
    await expect(runFinalize(PASS.request, ports)).rejects.toMatchObject({
      name: "FixedLineRefusedError",
      fault: "lineNotInBundle",
      line: "signUpOpener",
    });
    expect(repo.calls.writes).toEqual([]);
  });

  it("the passed-on line of a sign-up row is refused too (finalize's passed-on path, index.ts passOn): nothing written, no clock cancelled, no review item", async () => {
    const row = withoutTheLine({ fallbackText: null });
    const words = passedOnWords(row.checks);
    if (words === null) throw new Error("K-01 v1's lines hold the passed-on line");
    expect(() =>
      insertFixedLines(passedOnParts(row, PASS.request.plan, words), row, SIGN_UP_FIRST_TEXT),
    ).toThrow(/lineNotInBundle: signUpOpener/);
    const { repo, ports } = repoWithInserter(row, factsPort(SIGN_UP_FIRST_TEXT));
    await expect(runFinalize(missingRewrite(), ports)).rejects.toThrow(/lineNotInBundle: signUpOpener/);
    expect(repo.calls.writes).toEqual([]);
    expect(repo.calls.cancels).toEqual([]);
    expect(repo.calls.reviews).toEqual([]);
  });

  it("with the line, the sign-up row's passed-on line carries it: the passed-on words after signUpOpener's, the opt-out line and the privacy link", async () => {
    const { repo, ports } = repoWithInserter(
      signUpRow({ fallbackText: null }),
      factsPort(SIGN_UP_FIRST_TEXT),
    );
    const response = responseOf(await runFinalize(missingRewrite(), ports));

    expect(response.outcome).toBe("passedOn");
    expect(wordsOf(response.finalParts)).toBe(
      `${SIGN_UP_OPENER} I’ve passed this on. Rosie’s team will reply within 1 business day.\n${OPT_OUT}\n${PRIVACY}`,
    );
    expect(response.finalParts?.fixedLines).toEqual([
      "passedOn",
      "signUpOpener",
      "optOutLine",
      "privacyLink",
    ]);
    expect(repo.calls.writes).toHaveLength(1);
  });

  it("the Fixed lines check holds either id to its own words: signUpOpener's words are not opener's, nor the other way", () => {
    const row = firstTextRow({}, { lists: listsWithSignUpOpener() });
    const said = (text: string, id: string): FinalParts => partsOf([wordsSend(text)], [RILEY, DAY], [id]);
    expect(fixedLinesFaults(said(`${SIGN_UP_OPENER} ${COMPOSED}`, "signUpOpener"), row.checks)).toEqual([]);
    expect(fixedLinesFaults(said(`${OPENER} ${COMPOSED}`, "opener"), row.checks)).toEqual([]);
    expect(fixedLinesFaults(said(`${OPENER} ${COMPOSED}`, "signUpOpener"), row.checks)).toEqual([
      `The fixed line signUpOpener is not in the text word for word: "${SIGN_UP_OPENER}"`,
    ]);
    expect(fixedLinesFaults(said(`${SIGN_UP_OPENER} ${COMPOSED}`, "opener"), row.checks)).toEqual([
      `The fixed line opener is not in the text word for word: "${OPENER}"`,
    ]);
  });
});
