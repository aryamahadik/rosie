// The fixed replies against the frozen schemas (T-267), under Node (Vitest project "unit"), since the Workers runtime cannot
// run Ajv: every core action the replies make is K-09 v1's, every plan they write is K-05 v1's `writePlan.request` (K-03
// v1's row plan and final parts), every span is K-08 v1's, and the words follow K-01 v1's fixed lines. The Workers tests
// beside it (replies.worker.test.ts) run the same code through the guard, the shared core's double and the dispatcher.
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Manifest } from "../../bundle";
import { readContractJson, schemaErrors } from "../../trace/test-support";
import { contractProblems, K09_V1 } from "../test-support";
import type { Keyword, KeywordText } from "../types";
import { actionFor, fixedLinePlan, replyToKeywords, setReplyDeps } from "./replies";
import { ROSIE_NUMBER, fakeCore, phone, pinnedManifest, turnTrace, typed, withLine } from "./test-support";
import type { TurnCaller, UnplannedRow } from "./types";
import { HELP_REPLY, Q01_DRAFTED, START_REPLY, STOP_REPLY, fixedLinesOf, wordsFor } from "./words";

const K05_V1 = "data-access/data-access.v1.schema.json";

const FIXED_LINES = readContractJson("bundle/fixtures/fixed-lines.json") as {
  lines: { id: string; text: string | null; status: string }[];
};
const KEYWORDS = readContractJson("bundle/fixtures/keywords.json") as {
  start: string;
  help: string;
  optOut: string[];
  flagsVisit: string[];
};

const CALLER: TurnCaller = {
  kind: "turn",
  turnId: "turn-alex-stop-0220",
  requestId: "turn-alex-stop-0220",
  businessId: null,
  personId: "person-alex",
  traceId: "trace-alex-0220",
};

const keywordText = (eventId: string, body: string, keyword: Keyword): KeywordText => ({
  text: typed(eventId, body),
  keyword,
});

let manifest: Manifest;
let restore: () => void = () => undefined;

beforeAll(async () => {
  manifest = await pinnedManifest();
});

afterEach(() => {
  restore();
});

describe("the core actions are K-09 v1's", () => {
  const turn = { handleId: "handle-alex", phoneNumber: "+15555550101" };

  it("the turn's caller is K-09 v1's caller, with no business (a STOP covers every one)", () => {
    expect(contractProblems(K09_V1, "caller", CALLER)).toEqual([]);
  });

  it.each(KEYWORDS.optOut)("a bare %s is recordStopOrStart kind stop, a K-09 v1 CoreAction", (word) => {
    const flagsVisit = KEYWORDS.flagsVisit.includes(word);
    const action = actionFor(
      keywordText("evt-alex-0220", word.toLowerCase(), { kind: "stop", word, flagsVisit }),
      turn,
      CALLER,
    );

    expect(action).toMatchObject({
      call: "recordStopOrStart",
      request: {
        kind: "stop",
        words: word.toLowerCase(),
        alsoCancelVisit: flagsVisit,
        phoneNumber: "+15555550101",
      },
    });
    expect(contractProblems(K09_V1, "coreAction", action)).toEqual([]);
    expect(contractProblems(K09_V1, "recordStopOrStart.request", action?.request)).toEqual([]);
  });

  it("START is recordStopOrStart kind start from the text's own event, which K-09 v1 requires of a START", () => {
    const action = actionFor(
      keywordText("evt-alex-0230", "Start!", { kind: "start", word: KEYWORDS.start, flagsVisit: false }),
      turn,
      CALLER,
    );

    expect(action).toMatchObject({
      call: "recordStopOrStart",
      request: { kind: "start", inboundEventId: "evt-alex-0230" },
    });
    expect(contractProblems(K09_V1, "coreAction", action)).toEqual([]);
  });

  it("HELP is sendFixedLine helpReply to the turn's handle, a quick reply", () => {
    const action = actionFor(
      keywordText("evt-alex-0240", "help", { kind: "help", word: KEYWORDS.help, flagsVisit: false }),
      turn,
      CALLER,
    );

    expect(action).toEqual({
      call: "sendFixedLine",
      request: {
        caller: CALLER,
        fixedLineId: "helpReply",
        recipientHandleId: "handle-alex",
        sendClass: "quick_reply",
        sentByActor: null,
      },
    });
    expect(contractProblems(K09_V1, "coreAction", action)).toEqual([]);
  });

  it("an email's subject is the words when its body has none, as the guard reads it", () => {
    const found: KeywordText = {
      text: { eventId: "evt-alex-0250", kind: "text", words: { body: " ", subject: "STOP" } },
      keyword: { kind: "stop", word: "STOP", flagsVisit: false },
    };

    expect(actionFor(found, turn, CALLER)?.request).toMatchObject({ words: "STOP" });
  });

  it("a vote's STOP or START is K-09 v1's recordStopOrStart with its option's words; words with no letter or digit take the list's word", () => {
    const stop: Keyword = { kind: "stop", word: "STOP", flagsVisit: false };
    const vote = (eventId: string, optionWords: string | null, keyword: Keyword): KeywordText => ({
      text: { eventId, kind: "pollVote", words: { body: null, subject: null, optionWords } },
      keyword,
    });
    const actions = [
      actionFor(vote("evt-alex-0270", "Stop!", stop), turn, CALLER),
      actionFor(
        vote("evt-alex-0271", "start", { kind: "start", word: KEYWORDS.start, flagsVisit: false }),
        turn,
        CALLER,
      ),
    ];

    expect(actions.map((action) => action?.request)).toMatchObject([
      { kind: "stop", inboundEventId: "evt-alex-0270", words: "Stop!" },
      { kind: "start", inboundEventId: "evt-alex-0271", words: "start" },
    ]);
    for (const action of actions) {
      expect(contractProblems(K09_V1, "recordStopOrStart.request", action?.request)).toEqual([]);
    }
    // Never a keyword the guard finds, but K-09 still gets words (minLength 1): the list's.
    for (const blank of [null, "", " ", "!!"]) {
      expect(actionFor(vote("evt-alex-0272", blank, stop), turn, CALLER)?.request).toMatchObject({
        words: "STOP",
      });
    }
    const unworded: KeywordText = {
      text: { eventId: "evt-alex-0273", kind: "text", words: null },
      keyword: stop,
    };
    expect(actionFor(unworded, turn, CALLER)?.request).toMatchObject({ words: "STOP" });
  });

  it("with no number (an email handle) a STOP or START makes no action; HELP still does", () => {
    const email = { handleId: "handle-alex-email", phoneNumber: null };
    const stop = keywordText("evt-alex-0260", "STOP", { kind: "stop", word: "STOP", flagsVisit: false });
    const help = keywordText("evt-alex-0261", "HELP", { kind: "help", word: "HELP", flagsVisit: false });

    expect(actionFor(stop, email, CALLER)).toBeNull();
    expect(actionFor(help, email, CALLER)?.call).toBe("sendFixedLine");
  });
});

describe("the words are K-01 v1's fixed lines, or Q-01's draft while they wait for Jay", () => {
  it("K-01 v1 holds the stop, START and HELP replies with no words yet (pendingJay), and the rest as written", () => {
    const byId = new Map(FIXED_LINES.lines.map((line) => [line.id, line]));
    for (const id of [STOP_REPLY, START_REPLY, HELP_REPLY]) {
      expect(byId.get(id)).toMatchObject({ text: null, status: "pendingJay" });
    }
    expect(byId.get("stopToBusiness")).toMatchObject({ status: "asWritten" });
    expect(Object.keys(Q01_DRAFTED).sort()).toEqual([HELP_REPLY, START_REPLY, STOP_REPLY].sort());
  });

  it("bundle v0's lines: each Q-01 reply takes its draft, a line as written goes word for word, an unknown one has none", () => {
    const lines = fixedLinesOf(manifest);

    expect(wordsFor(STOP_REPLY, lines, ROSIE_NUMBER)).toEqual({
      lineId: STOP_REPLY,
      text: Q01_DRAFTED[STOP_REPLY],
      from: "q01Default",
    });
    expect(wordsFor("stopLaterReply", lines, ROSIE_NUMBER)).toEqual({
      lineId: "stopLaterReply",
      text: "Texts are off. Reply START, or call the business.",
      from: "bundle",
    });
    expect(wordsFor("noSuchLine", lines, ROSIE_NUMBER)).toBeNull();
  });

  it("K-09 v1.1's textsOffReachTheirWay is K-01's stopToBusiness, word for word (RULES 7.5)", () => {
    expect(wordsFor("textsOffReachTheirWay", fixedLinesOf(manifest), ROSIE_NUMBER)).toEqual({
      lineId: "stopToBusiness",
      text: "Texts to this customer are off. Reach them their way.",
      from: "bundle",
    });
  });

  it("HELP's words get Rosie's number from config, and none go without it", () => {
    const lines = fixedLinesOf(manifest);

    expect(wordsFor(HELP_REPLY, lines, ROSIE_NUMBER)?.text).toContain(`Rosie's number is ${ROSIE_NUMBER}.`);
    expect(wordsFor(HELP_REPLY, lines, "")).toBeNull();
  });

  it("Jay's words in the bundle win; a line left with a placeholder falls back to the draft", () => {
    const jays = withLine(manifest, START_REPLY, "Texts from Rosie are back on. Reply STOP to end them.");
    const holed = withLine(manifest, START_REPLY, "Texts from <business> are back on.");

    expect(wordsFor(START_REPLY, fixedLinesOf(jays), ROSIE_NUMBER)?.from).toBe("bundle");
    expect(wordsFor(START_REPLY, fixedLinesOf(holed), ROSIE_NUMBER)?.from).toBe("q01Default");
  });

  it("a manifest with no fixed lines gives none: only the drafts remain", () => {
    expect(fixedLinesOf({ lists: { fixedLines: "no" } }).size).toBe(0);
    expect(fixedLinesOf({}).size).toBe(0);
    expect(wordsFor(STOP_REPLY, fixedLinesOf({}), ROSIE_NUMBER)?.from).toBe("q01Default");
  });
});

describe("the plans and spans the replies write are the contracts'", () => {
  it("a fixed line's plan is K-05 v1's writePlan.request, with K-03 v1's row plan and final parts", () => {
    const row: UnplannedRow = {
      outboxRowId: "out-alex-stop-reply-0220",
      version: 1,
      commitSeq: 3,
      recipientHandleId: "handle-alex",
      channel: "imessage",
      copyOfRowId: null,
    };

    const plan = fixedLinePlan(row, STOP_REPLY, Q01_DRAFTED[STOP_REPLY] ?? "");

    expect(contractProblems(K05_V1, "writePlan.request", plan)).toEqual([]);
    expect(plan.finalParts.fixedLines).toEqual(["stopReply"]);
  });

  it("each keyword text's fillAndChecks span is K-08 v1's, with labels and counts only", async () => {
    const fake = fakeCore("2026-10-22T16:40:02Z", [
      phone("+15555550101", "handle-alex", "person-alex"),
      phone("+15555550100", "handle-sam", "person-sam"),
    ]);
    fake.openBookings.set("+15555550101", [
      { bookingId: "booking-alex-sam-book", businessId: "biz-lees-barbershop", ownerHandleId: "handle-sam" },
    ]);
    restore = setReplyDeps({ core: fake.core, rows: fake.rows, rosieNumber: ROSIE_NUMBER });
    const { trace, spans } = turnTrace("turn-alex-spans");

    const result = await replyToKeywords({
      turnId: "turn-alex-spans",
      handleId: "handle-alex",
      phoneNumber: "+15555550101",
      personId: "person-alex",
      traceId: "trace-alex-spans",
      keywords: [
        keywordText("evt-alex-0701", "Cancel", { kind: "stop", word: "CANCEL", flagsVisit: true }),
        keywordText("evt-alex-0702", "HELP", { kind: "help", word: "HELP", flagsVisit: false }),
        keywordText("evt-alex-0703", "START", { kind: "start", word: "START", flagsVisit: false }),
      ],
      bundle: { manifest },
      trace,
    });

    expect(result.replies.map((reply) => reply.outcome)).toEqual(["replied", "refused", "replied"]);
    expect(spans).toHaveLength(3);
    for (const span of spans) {
      expect(span.hop).toBe("fillAndChecks");
      expect(schemaErrors("span", span)).toEqual([]);
    }
    // Every plan written is K-05 v1's, the replies' and the notice's alike.
    expect(fake.plans).toHaveLength(3);
    for (const plan of fake.plans) expect(contractProblems(K05_V1, "writePlan.request", plan)).toEqual([]);
  });
});
