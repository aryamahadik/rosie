// The fixed replies against the frozen schemas (T-267), under Node (Vitest project "unit"), since the Workers runtime cannot
// run Ajv: every core action the replies make is K-09 v1's, every plan they write is K-05 v1's `writePlan.request` (K-03
// v1's row plan and final parts), every span is K-08 v1's, and the words follow K-01 v1's fixed lines. The Workers tests
// beside it (replies.worker.test.ts) run the same code through the guard, the shared core's double and the dispatcher.
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Manifest } from "../../bundle";
import { readContractJson, schemaErrors } from "../../trace/test-support";
import { contractProblems, K09_V1 } from "../test-support";
import type { GuardText, Keyword, KeywordText } from "../types";
import {
  actionFor,
  fixedLinePlan,
  replyToKeywords,
  setReplyDeps,
  stopOrStartFor,
  type KeywordReply,
} from "./replies";
import {
  ROSIE_NUMBER,
  fakeCore,
  phone,
  pinnedManifest,
  turnTrace,
  typed,
  withLine,
  type FakeCore,
} from "./test-support";
import type { CoreCommitted, RecordStopOrStartRequest, TurnCaller, UnplannedRow } from "./types";
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
    const first = turnTrace("turn-alex-spans");
    const second = turnTrace("turn-alex-spans-2");
    const alexTurn = (turnId: string, keywords: KeywordText[], trace: typeof first.trace) =>
      replyToKeywords({
        turnId,
        handleId: "handle-alex",
        phoneNumber: "+15555550101",
        personId: "person-alex",
        traceId: `trace-${turnId}`,
        keywords,
        bundle: { manifest },
        trace,
      });

    // CANCEL, HELP, START: the phone's one record is its newest word's, the START (T-1416), so HELP is answered too.
    const result = await alexTurn(
      "turn-alex-spans",
      [
        keywordText("evt-alex-0701", "Cancel", { kind: "stop", word: "CANCEL", flagsVisit: true }),
        keywordText("evt-alex-0702", "HELP", { kind: "help", word: "HELP", flagsVisit: false }),
        keywordText("evt-alex-0703", "START", { kind: "start", word: "START", flagsVisit: false }),
      ],
      first.trace,
    );
    // Then STOP and HELP: the stop reply and the business's notice are written, and HELP is refused while stopped.
    const later = await alexTurn(
      "turn-alex-spans-2",
      [
        keywordText("evt-alex-0704", "STOP", { kind: "stop", word: "STOP", flagsVisit: false }),
        keywordText("evt-alex-0705", "HELP", { kind: "help", word: "HELP", flagsVisit: false }),
      ],
      second.trace,
    );

    expect(result.replies.map((reply) => reply.outcome)).toEqual(["replied", "replied", "replied"]);
    expect(later.replies.map((reply) => reply.outcome)).toEqual(["replied", "refused"]);
    const spans = [...first.spans, ...second.spans];
    expect(spans).toHaveLength(5);
    for (const span of spans) {
      expect(span.hop).toBe("fillAndChecks");
      expect(schemaErrors("span", span)).toEqual([]);
    }
    // Every plan written is K-05 v1's, the replies' and the notice's alike.
    expect(fake.plans.map((plan) => plan.finalParts.fixedLines)).toEqual([
      ["startReply"],
      ["helpReply"],
      ["stopReply"],
      ["stopToBusiness"],
    ]);
    for (const plan of fake.plans) expect(contractProblems(K05_V1, "writePlan.request", plan)).toEqual([]);
  });
});

describe("one recordStopOrStart per phone per keyword turn, from the phone's newest word (T-1416; T-317's note N1)", () => {
  const ALEX = "+15555550101";
  const LEES = "biz-lees-barbershop";
  const turn = { handleId: "handle-alex", phoneNumber: ALEX };
  const STOP: Keyword = { kind: "stop", word: "STOP", flagsVisit: false };
  const START: Keyword = { kind: "start", word: "START", flagsVisit: false };
  const HELP: Keyword = { kind: "help", word: "HELP", flagsVisit: false };
  const CANCEL: Keyword = { kind: "stop", word: "CANCEL", flagsVisit: true };
  const CANCELAR: Keyword = { kind: "stop", word: "CANCELAR", flagsVisit: true };

  /**
   * The shared core over Alex's and Sam's phones, keyed by the turn as K-09 v1 keys a STOP or a START (the core's keyOf):
   * a commit that gives one id twice is refused whole, as the commit refuses it, with nothing written.
   */
  function keyedCore(): FakeCore {
    const fake = fakeCore("2026-10-22T16:40:02Z", [
      phone(ALEX, "handle-alex", "person-alex"),
      phone("+15555550100", "handle-sam", "person-sam"),
    ]);
    fake.keyedByTurn = true;
    restore();
    restore = setReplyDeps({ core: fake.core, rows: fake.rows, rosieNumber: ROSIE_NUMBER });
    return fake;
  }

  /** One keyword turn of Alex's, with its spans. */
  async function alexTurn(turnId: string, keywords: KeywordText[]) {
    const { trace, spans } = turnTrace(turnId);
    const result = await replyToKeywords({
      turnId,
      handleId: "handle-alex",
      phoneNumber: ALEX,
      personId: "person-alex",
      traceId: `trace-${turnId}`,
      keywords,
      bundle: { manifest },
      trace,
    });
    return { result, spans };
  }

  /** Each commit's recordStopOrStart requests, commit by commit. */
  const recordsOf = (fake: FakeCore): RecordStopOrStartRequest[][] =>
    fake.commits.map((commit) =>
      commit.actions.flatMap((action) => (action.call === "recordStopOrStart" ? [action.request] : [])),
    );

  /** How each keyword text was answered: its word, its outcome, its line, the flag and the code. */
  const answered = (replies: readonly KeywordReply<GuardText>[]) =>
    replies.map((reply) => [reply.keyword.word, reply.outcome, reply.line, reply.stopped, reply.errorCode]);

  it.each([
    ["STOP then STOP", [STOP, STOP], "evt-alex-0811", "stop!", "stop", false],
    ["START then STOP", [START, STOP], "evt-alex-0811", "stop!", "stop", false],
    ["STOP then START", [STOP, START], "evt-alex-0811", "start!", "start", false],
    ["CANCEL then STOP", [CANCEL, STOP], "evt-alex-0811", "stop!", "stop", true],
    ["STOP then CANCELAR", [STOP, CANCELAR], "evt-alex-0811", "cancelar!", "stop", true],
    ["CANCEL then START", [CANCEL, START], "evt-alex-0811", "start!", "start", true],
    ["STOP, HELP, then START", [STOP, HELP, START], "evt-alex-0812", "start!", "start", false],
    ["START, STOP, HELP", [START, STOP, HELP], "evt-alex-0811", "stop!", "stop", false],
  ] as const)(
    "%s: one K-09 v1 recordStopOrStart, the newest word's kind, event and words, the visit flagged by any CANCEL",
    (_case, keywords, inboundEventId, words, kind, alsoCancelVisit) => {
      // Each text's words are its keyword's, as typed: "stop!", "start!", ... at evt-alex-0810, 0811 and 0812.
      const texts = keywords.map((keyword, index) =>
        keywordText(`evt-alex-08${String(10 + index)}`, `${keyword.word.toLowerCase()}!`, keyword),
      );

      const action = stopOrStartFor(texts, turn, CALLER);

      expect(action).toEqual({
        call: "recordStopOrStart",
        request: {
          caller: CALLER,
          kind,
          phoneNumber: ALEX,
          inboundEventId,
          words,
          alsoCancelVisit,
          workPhoneBusinessIds: null,
          sentByActor: null,
        },
      });
      expect(contractProblems(K09_V1, "coreAction", action)).toEqual([]);
      expect(contractProblems(K09_V1, "recordStopOrStart.request", action?.request)).toEqual([]);
    },
  );

  it("no stop word or START, or no number: no record (each HELP stays its own sendFixedLine)", () => {
    const stop = keywordText("evt-alex-0818", "STOP", STOP);
    const help = keywordText("evt-alex-0819", "HELP", HELP);

    expect(stopOrStartFor([], turn, CALLER)).toBeNull();
    expect(stopOrStartFor([help, help], turn, CALLER)).toBeNull();
    expect(
      stopOrStartFor([stop, help], { handleId: "handle-alex-email", phoneNumber: null }, CALLER),
    ).toBeNull();
    expect(actionFor(help, turn, CALLER)?.call).toBe("sendFixedLine");
  });

  it("N1, the shape this card ends: one action per text gives two rows one id, so a core keyed by the turn refuses the whole commit on every run", async () => {
    const fake = keyedCore();
    const caller: TurnCaller = { ...CALLER, turnId: "turn-alex-stop-stop", requestId: "turn-alex-stop-stop" };
    const actions = [
      actionFor(keywordText("evt-alex-0801", "STOP", STOP), turn, caller),
      actionFor(keywordText("evt-alex-0802", "stop", STOP), turn, caller),
    ].filter((action) => action !== null);
    expect(actions).toHaveLength(2);

    for (let run = 1; run <= 3; run += 1) {
      await expect(fake.core.commitCore({ caller, actions })).rejects.toThrow(/idTwice/u);
    }

    // Nothing landed: no consent row, no reply row, the phone not stopped.
    expect(fake.consents).toEqual([]);
    expect(fake.outbox.size).toBe(0);
    expect(fake.phones.get(ALEX)).toMatchObject({ stopped: false, chatOpen: true, version: 3 });
  });

  it("two STOP texts in one turn give one action and both replies recorded: one consent row, one reply row, the phone moved once", async () => {
    const fake = keyedCore();

    const { result, spans } = await alexTurn("turn-alex-stop-stop", [
      keywordText("evt-alex-0801", "STOP", STOP),
      keywordText("evt-alex-0802", "stop", STOP),
    ]);

    // One commit with one record: the newest word's event and words.
    expect(recordsOf(fake)).toEqual([
      [
        {
          caller: {
            ...CALLER,
            turnId: "turn-alex-stop-stop",
            requestId: "turn-alex-stop-stop",
            traceId: "trace-turn-alex-stop-stop",
          },
          kind: "stop",
          phoneNumber: ALEX,
          inboundEventId: "evt-alex-0802",
          words: "stop",
          alsoCancelVisit: false,
          workPhoneBusinessIds: null,
          sentByActor: null,
        },
      ],
    ]);
    expect(fake.commits[0]?.actions).toHaveLength(1);
    // It landed: one consent row and one reply row, each its own id, and the phone's version moved once (3 to 4).
    expect(fake.consents.map((consent) => [consent.id, consent.revoked, consent.exactWords])).toEqual([
      ["consent-turn-alex-stop-stop", true, "stop"],
    ]);
    expect([...fake.outbox.keys()]).toEqual(["out-turn-alex-stop-stop-stopReply"]);
    expect(fake.phones.get(ALEX)).toMatchObject({ stopped: true, chatOpen: false, version: 4 });
    // Both texts are answered from that one action, recorded, and the turn need not run again.
    expect(answered(result.replies)).toEqual([
      ["STOP", "replied", "stopReply", true, null],
      ["STOP", "replied", "stopReply", true, null],
    ]);
    expect(result.rerun).toBe(false);
    // The one reply's words are written once, and listed on the newest text's reply alone.
    expect(fake.plans.map((plan) => plan.outboxRowId)).toEqual(["out-turn-alex-stop-stop-stopReply"]);
    expect(result.replies.map((reply) => [reply.rowsWritten, reply.words])).toEqual([
      [[], null],
      [["out-turn-alex-stop-stop-stopReply"], "q01Default"],
    ]);
    // One fillAndChecks span per text, each K-08 v1's.
    expect(spans.map((span) => [span.event_id, span.decided])).toMatchObject([
      ["evt-alex-0801", { result: "replied", line: "stopReply", stopped: true, rowsWritten: 0 }],
      ["evt-alex-0802", { result: "replied", line: "stopReply", stopped: true, rowsWritten: 1 }],
    ]);
    for (const span of spans) expect(schemaErrors("span", span)).toEqual([]);
  });

  it("START then STOP gives one stop: from a phone on or one stopped before, the START never lifts it and writes no row", async () => {
    const fake = keyedCore();
    const startThenStop = (turnId: string, at: number) =>
      alexTurn(turnId, [
        keywordText(`evt-alex-08${String(at)}`, "START", START),
        keywordText(`evt-alex-08${String(at + 1)}`, "Stop", STOP),
      ]);

    const fromOn = await startThenStop("turn-alex-start-stop-1", 20);
    expect(fake.phones.get(ALEX)).toMatchObject({ stopped: true, chatOpen: false });
    const fromStopped = await startThenStop("turn-alex-start-stop-2", 22);

    // Each turn carries one record, the STOP: the newest word, its event and its words.
    expect(recordsOf(fake)).toMatchObject([
      [{ kind: "stop", inboundEventId: "evt-alex-0821", words: "Stop", alsoCancelVisit: false }],
      [{ kind: "stop", inboundEventId: "evt-alex-0823", words: "Stop", alsoCancelVisit: false }],
    ]);
    expect(fake.commits.map((commit) => commit.actions.length)).toEqual([1, 1]);
    // No START row was ever written, and the phone stays stopped.
    expect(fake.consents.map((consent) => [consent.revoked, consent.exactWords])).toEqual([
      [true, "Stop"],
      [true, "Stop"],
    ]);
    expect(fake.phones.get(ALEX)).toMatchObject({ stopped: true, chatOpen: false });
    for (const { result } of [fromOn, fromStopped]) {
      expect(answered(result.replies)).toEqual([
        ["START", "replied", "stopReply", true, null],
        ["STOP", "replied", "stopReply", true, null],
      ]);
    }
  });

  it("STOP then START gives one start: no stop row or stop reply is written, from a phone on or one stopped before", async () => {
    const fake = keyedCore();
    const stopThenStart = (turnId: string, at: number) =>
      alexTurn(turnId, [
        keywordText(`evt-alex-08${String(at)}`, "STOP", STOP),
        keywordText(`evt-alex-08${String(at + 1)}`, "Start", START),
      ]);

    const fromOn = await stopThenStart("turn-alex-stop-start-1", 30);
    // Only the START's row and reply: no stopReply row, which limit 8 would send past the flag.
    expect(fake.consents.map((consent) => [consent.revoked, consent.exactWords])).toEqual([[false, "Start"]]);
    expect([...fake.outbox.values()].map((row) => row.fixedLineId)).toEqual(["startReply"]);
    await alexTurn("turn-alex-stop-0832", [keywordText("evt-alex-0832", "STOP", STOP)]);
    expect(fake.phones.get(ALEX)).toMatchObject({ stopped: true });
    const fromStopped = await stopThenStart("turn-alex-stop-start-2", 33);

    expect(recordsOf(fake)).toMatchObject([
      [{ kind: "start", inboundEventId: "evt-alex-0831", words: "Start", alsoCancelVisit: false }],
      [{ kind: "stop", inboundEventId: "evt-alex-0832" }],
      [{ kind: "start", inboundEventId: "evt-alex-0834", words: "Start", alsoCancelVisit: false }],
    ]);
    expect(fake.commits.map((commit) => commit.actions.length)).toEqual([1, 1, 1]);
    expect(fake.consents.map((consent) => consent.revoked)).toEqual([false, true, false]);
    expect(fake.phones.get(ALEX)).toMatchObject({ stopped: false, chatOpen: true });
    for (const { result } of [fromOn, fromStopped]) {
      expect(answered(result.replies)).toEqual([
        ["STOP", "replied", "startReply", false, null],
        ["START", "replied", "startReply", false, null],
      ]);
    }
  });

  it("CANCEL then STOP keeps alsoCancelVisit: one stop with the STOP's words flags the visit, and the business is told once", async () => {
    const fake = keyedCore();
    fake.openBookings.set(ALEX, [
      { bookingId: "booking-alex-sam-book", businessId: LEES, ownerHandleId: "handle-sam" },
    ]);

    const { result } = await alexTurn("turn-alex-cancel-stop", [
      keywordText("evt-alex-0841", "Cancel", CANCEL),
      keywordText("evt-alex-0842", "STOP", STOP),
    ]);

    expect(recordsOf(fake)).toMatchObject([
      [{ kind: "stop", inboundEventId: "evt-alex-0842", words: "STOP", alsoCancelVisit: true }],
    ]);
    const [stop] = (fake.answers[0] as CoreCommitted).core;
    expect(stop?.response).toMatchObject({
      stopped: true,
      flaggedBookingIds: ["booking-alex-sam-book"],
      businessesTold: [
        { businessId: LEES, outboxRowId: "out-turn-alex-cancel-stop-biz-lees-barbershop-texts-off" },
      ],
    });
    expect(result.replies.map((reply) => [reply.keyword.word, reply.outcome, reply.told])).toEqual([
      ["CANCEL", "replied", [LEES]],
      ["STOP", "replied", [LEES]],
    ]);
    // The reply's and the notice's words are written once each, on the newest text's reply.
    expect(result.replies.map((reply) => reply.rowsWritten)).toEqual([
      [],
      ["out-turn-alex-cancel-stop-stopReply", "out-turn-alex-cancel-stop-biz-lees-barbershop-texts-off"],
    ]);
    expect(fake.plans.map((plan) => plan.finalParts.fixedLines)).toEqual([["stopReply"], ["stopToBusiness"]]);
  });

  it("HELP beside STOP keeps both actions: each HELP its own sendFixedLine, the one record in the place of the phone's first word", async () => {
    const beside = keyedCore();

    const { result } = await alexTurn("turn-alex-stop-help", [
      keywordText("evt-alex-0851", "STOP", STOP),
      keywordText("evt-alex-0852", "HELP", HELP),
    ]);

    expect(beside.commits.map((commit) => commit.actions.map((action) => action.call))).toEqual([
      ["recordStopOrStart", "sendFixedLine"],
    ]);
    // HELP is answered as before: refused from a stopped number (phoneStopped), its one reply T-268's.
    expect(answered(result.replies)).toEqual([
      ["STOP", "replied", "stopReply", true, null],
      ["HELP", "refused", null, null, "phoneStopped"],
    ]);

    const mixed = keyedCore();

    const { result: mixedResult } = await alexTurn("turn-alex-help-mixed", [
      keywordText("evt-alex-0853", "HELP", HELP),
      keywordText("evt-alex-0854", "START", START),
      keywordText("evt-alex-0855", "help", HELP),
      keywordText("evt-alex-0856", "Stop", STOP),
    ]);

    expect(mixed.commits.map((commit) => commit.actions.map((action) => action.call))).toEqual([
      ["sendFixedLine", "recordStopOrStart", "sendFixedLine"],
    ]);
    expect(recordsOf(mixed)).toMatchObject([
      [{ kind: "stop", inboundEventId: "evt-alex-0856", words: "Stop" }],
    ]);
    // The HELP before the phone's first word meets the phone on; the HELP after it meets the phone as its newest word,
    // the STOP, leaves it, though the word just before that HELP was START.
    expect(answered(mixedResult.replies)).toEqual([
      ["HELP", "replied", "helpReply", null, null],
      ["START", "replied", "stopReply", true, null],
      ["HELP", "refused", null, null, "phoneStopped"],
      ["STOP", "replied", "stopReply", true, null],
    ]);
  });

  it("every word of the phone is answered from the one action when it fails too: not recorded, and the rerun lands the same one record", async () => {
    const fake = keyedCore();
    const texts = [
      keywordText("evt-alex-0861", "STOP", STOP),
      keywordText("evt-alex-0862", "Start", START),
      keywordText("evt-alex-0863", "stop", STOP),
    ];
    fake.down = true;

    const first = await alexTurn("turn-alex-rerun", texts);

    expect(first.result.replies.map((reply) => [reply.outcome, reply.errorCode])).toEqual([
      ["notRecorded", "noAnswer"],
      ["notRecorded", "noAnswer"],
      ["notRecorded", "noAnswer"],
    ]);
    expect(first.result.rerun).toBe(true);

    fake.down = false;
    const second = await alexTurn("turn-alex-rerun", texts);

    // Each run carries the same one record, so the turn's key gives its rows once.
    const [down, up] = recordsOf(fake);
    expect(down).toEqual(up);
    expect(up).toMatchObject([{ kind: "stop", inboundEventId: "evt-alex-0863", words: "stop" }]);
    expect(answered(second.result.replies)).toEqual([
      ["STOP", "replied", "stopReply", true, null],
      ["START", "replied", "stopReply", true, null],
      ["STOP", "replied", "stopReply", true, null],
    ]);
    expect(second.result.rerun).toBe(false);
    expect(fake.consents).toHaveLength(1);
  });
});
