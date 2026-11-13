// The guard's fixed replies (T-267; C-052), run inside the Workers runtime (Vitest project "workers"): a stop word, START or
// HELP alone gets its fixed reply from code, never the composer. Each turn runs through the real guard (T-250) on K-01's
// bundle v0, then the replies; the shared core and its rows are fakes answering as K-09 v1 and v1.1 and K-05 v1 state
// (./test-support.ts), and the rows the replies write go through the real dispatcher and limit 8 (T-257, T-259, T-1099;
// imported read-only) to the dispatcher's own Linq fake. The hard invariant is also run through limit 8's own decision
// function. A vote is scrubbed and sealed by the gateway's own hand-off and opened from its box, as the turn opens it
// (T-1338). Names are the master's sample cast; phones are 555-01xx, Rosie's line +1 555-555-0199 (rule 9). New York is on
// EDT (UTC-4) until 2026-11-01: 16:40Z is 12:40pm, inside every text hour.
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import writePlanSafety from "../../../../contracts/data-access/fixtures/write-plan-alex-safety.json";
import pollVote from "../../../../contracts/inbound-event/fixtures/poll-vote.json";
import sendOverrideOptout from "../../../../contracts/port-linq/fixtures/send-override-optout.json";
import stopTellsBusinesses from "../../../../contracts/tool-api/fixtures/j3-stop-tells-businesses.json";
import startRecorded from "../../../../contracts/tool-api/fixtures/start-recorded.json";
import stopRecorded from "../../../../contracts/tool-api/fixtures/stop-recorded.json";
import fixedLinesFixture from "../../../../contracts/bundle/fixtures/fixed-lines.json";
import type { Manifest } from "../../bundle";
import { BUNDLE_A } from "../../bundle/test-support";
import { runDispatch } from "../../dispatch";
import { decideLimit8 } from "../../dispatch/limit8";
import {
  FakeClock,
  FakeLinq,
  FakeOutboxStore,
  FakeRecipients,
  FakeSendState,
  traceCollector,
  words,
  type SeedRow,
} from "../../dispatch/test-support";
import type { ChatTarget, ClaimedRow, LinqSendRequest, SendState } from "../../dispatch/types";
import { actorNameOf, openWords, prepareHandoff, wordsOfEvent } from "../../gateway";
import { fakeKeyStore } from "../../gateway/test-support";
import type { Span } from "../../trace";
import { guardTurn } from "../guard";
import type { GuardText } from "../types";
import { replyToKeywords, setReplyDeps, type RepliesResult } from "./replies";
import {
  ROSIE_NUMBER,
  fakeCore,
  phone,
  pinnedManifest,
  seedRowsOf,
  turnTrace,
  typed,
  withLine,
  type FakeCore,
  type FakePhone,
} from "./test-support";
import type { CoreCommitted, RecordStopOrStartResponse, TurnCaller, WritePlanRequest } from "./types";
import { Q01_DRAFTED } from "./words";

const LEES = "biz-lees-barbershop";
const LEE_HOME = "biz-lee-home-services";
const YOGA = "biz-yoga-studio";
const STOP_TO_BUSINESS =
  fixedLinesFixture.lines.find((line) => line.id === "stopToBusiness")?.text ?? "(no stopToBusiness line)";

/** The sample cast's handles and their chats (K-11 chat ids; the dispatcher's recipient fake). */
const CHATS: Record<string, ChatTarget> = {
  "handle-alex": { to: "+15555550101", chatId: "linq-chat-demo-alex", service: "imessage" },
  "handle-sam": { to: "+15555550100", chatId: "linq-chat-demo-sam", service: "imessage" },
  "handle-ben": { to: "+15555550131", chatId: "linq-chat-demo-ben", service: "imessage" },
  "handle-avery": { to: "+15555550105", chatId: "linq-chat-demo-avery", service: "imessage" },
};

const ben = (): FakePhone => phone("+15555550131", "handle-ben", "person-ben", 3);
const alex = (version = 3): FakePhone => phone("+15555550101", "handle-alex", "person-alex", version);
const sam = (): FakePhone => phone("+15555550100", "handle-sam", "person-sam", 7);
const avery = (): FakePhone => phone("+15555550105", "handle-avery", "person-avery", 1);

let manifest: Manifest;
let restore: () => void = () => undefined;

beforeAll(async () => {
  manifest = await pinnedManifest();
});

afterEach(() => {
  restore();
});

/** Sets the replies' deps to this fake core, with Rosie's number as configured. */
function wire(fake: FakeCore, rosieNumber = ROSIE_NUMBER): void {
  restore();
  restore = setReplyDeps({ core: fake.core, rows: fake.rows, rosieNumber });
}

interface Ran {
  result: RepliesResult<GuardText>;
  spans: Span[];
}

/** One turn from this phone: the real guard on bundle v0, then the replies, on one trace. */
async function turn(
  who: FakePhone,
  turnId: string,
  texts: GuardText[],
  options: { traceId?: string; manifest?: Manifest; phoneNumber?: string | null } = {},
): Promise<Ran> {
  const bundle = { manifest: options.manifest ?? manifest };
  const { trace, spans } = turnTrace(turnId);
  const guarded = await guardTurn({ handleId: who.handleId, texts, bundle, trace });
  expect(guarded.onward).toBeNull();
  const result = await replyToKeywords({
    turnId,
    handleId: who.handleId,
    phoneNumber: options.phoneNumber === undefined ? who.number : options.phoneNumber,
    personId: who.personId,
    traceId: options.traceId ?? `trace-${turnId}`,
    keywords: guarded.keywords,
    bundle,
    trace,
  });
  return { result, spans: spans.filter((span) => span.hop === "fillAndChecks") };
}

/** The send state the record gives a phone's handle now: its K-04 flags and its newest texts row (K-05 v1.2). */
function sendStateOf(fake: FakeCore, entry: FakePhone): Partial<SendState> {
  const newest = fake.consents.filter((consent) => consent.handleId === entry.handleId).at(-1);
  return {
    stopped: entry.stopped,
    stopAt: entry.stopAt,
    chatOpen: entry.chatOpen,
    audience: entry.handleId === "handle-sam" ? "owner" : "customer",
    textsConsent:
      newest === undefined
        ? null
        : { consentId: newest.id, businessId: newest.businessId, revoked: newest.revoked, at: newest.at },
  };
}

/** The real dispatcher over these rows, with the send state the fake record holds now. */
async function dispatch(fake: FakeCore, rows: readonly SeedRow[]) {
  const clock = new FakeClock(fake.now);
  const store = new FakeOutboxStore(rows);
  const linq = new FakeLinq(clock.now);
  const state = new FakeSendState();
  for (const entry of fake.phones.values()) state.forHandle(entry.handleId, sendStateOf(fake, entry));
  const spans: Span[] = [];
  const report = await runDispatch({
    store,
    linq,
    recipients: new FakeRecipients(CHATS),
    sendState: state,
    environment: "production",
    traceFor: traceCollector(spans),
    now: clock.now,
    claimer: "dispatcher-1",
    limit: 100,
  });
  return { report, store, linq };
}

/** What Linq was asked to send to one number, in order: the words and the override (recipients go at once). */
const sentTo = (requests: readonly LinqSendRequest[], to: string): [string | null, boolean][] =>
  requests.filter((request) => request.to === to).map((request) => [request.text, request.overrideOptout]);

/** The words written into a row (K-05 writePlan), by row id. */
function wordsIn(fake: FakeCore, rowId: string): string | null {
  return fake.outbox.get(rowId)?.finalParts?.sends[0]?.text ?? null;
}

const committed = (fake: FakeCore, index = 0): CoreCommitted => {
  const answer = fake.answers[index];
  if (answer === undefined || !("core" in answer)) throw new Error("no commit");
  return answer as CoreCommitted;
};

describe("a stop word alone: recorded for every business, and one fixed reply from code with override_optout", () => {
  it("Ben's bare STOP is stop-recorded.json's recordStopOrStart: the request, the record for every business, the answer", async () => {
    const fake = fakeCore(stopRecorded.given.now, [ben()]);
    fake.ids.set("turn-ben-stop", { consent: "consent-ben-stop", reply: "out-ben-stop-reply" });
    wire(fake);

    const { result } = await turn(ben(), "turn-ben-stop", [typed("evt-ben-0007", "STOP")], {
      traceId: "trace-ben-0007",
    });

    // The turn's one commit carries exactly the fixture's core action, under the turn's caller (no business: every one).
    const [, stopAction] = stopRecorded.request.core;
    expect(fake.commits).toEqual([{ caller: stopRecorded.request.caller, actions: [stopAction] }]);
    expect(stopRecorded.request.caller.businessId).toBeNull();
    // The double answers as the fixture states (v1.1 adds businessesTold, empty with no open booking).
    expect(committed(fake).core).toEqual([
      {
        ...stopRecorded.outcome.core[1],
        response: { ...stopRecorded.outcome.core[1]?.response, businessesTold: [] },
      },
    ]);
    // K-04: one flag for the number, so for every business, and the chat closed; K-29: a row with no business withdraws.
    expect(fake.phones.get("+15555550131")).toMatchObject({
      stopped: true,
      chatOpen: false,
      stopAt: stopRecorded.given.now,
    });
    expect(fake.consents).toEqual([
      {
        id: "consent-ben-stop",
        personId: "person-ben",
        businessId: null,
        kind: "texts",
        revoked: true,
        handleId: "handle-ben",
        exactWords: "STOP",
        at: stopRecorded.given.now,
        channel: "text",
        turnId: "turn-ben-stop",
      },
    ]);
    expect(result).toEqual({
      replies: [
        {
          text: typed("evt-ben-0007", "STOP"),
          keyword: { kind: "stop", word: "STOP", flagsVisit: false },
          outcome: "replied",
          line: "stopReply",
          words: "q01Default",
          stopped: true,
          rowsWritten: ["out-ben-stop-reply"],
          told: [],
          errorCode: null,
        },
      ],
      rerun: false,
    });
  });

  it("no composer: the reply's row gets the fixed line's words with a plan of no lines, and the turn reads only the bundle's lists", async () => {
    const fake = fakeCore(stopRecorded.given.now, [ben()]);
    wire(fake);
    const reads = new Set<string | symbol>();
    const watched = new Proxy(manifest, {
      get(target, key, receiver) {
        reads.add(key);
        return Reflect.get(target, key, receiver) as unknown;
      },
    });

    const { result } = await turn(ben(), "turn-ben-stop", [typed("evt-ben-0007", "Stop!")], {
      manifest: watched,
    });

    const rowId = result.replies[0]?.rowsWritten[0] ?? "";
    const expected: WritePlanRequest = {
      outboxRowId: rowId,
      expectVersion: 1,
      plan: { ...writePlanSafety.request.plan, row: rowId } as unknown as WritePlanRequest["plan"],
      finalParts: {
        ...writePlanSafety.request.finalParts,
        row: rowId,
        sends: [{ ...writePlanSafety.request.finalParts.sends[0], text: Q01_DRAFTED.stopReply ?? "" }],
        fixedLines: ["stopReply"],
      } as WritePlanRequest["finalParts"],
    };
    // write-plan-alex-safety.json's form for a fixed line: no line of the plan's own, the words added by code.
    expect(writePlanSafety.request.plan.plan.lines).toEqual([]);
    expect(fake.plans).toEqual([expected]);
    // Nothing but the shared lists was read from the bundle: no prompt, no model, no flow graph (the guard reads its
    // keywords there too). The deps hold no composer or model port at all.
    expect([...reads]).toEqual(["lists"]);
    // The person's own words are kept as the consent row's exact words.
    expect(fake.consents[0]?.exactWords).toBe("Stop!");
  });

  it("sends exactly one fixed reply, with override_optout, as K-11's send-override-optout.json sends it", async () => {
    const fake = fakeCore(stopRecorded.given.now, [ben()]);
    fake.ids.set("turn-ben-stop", { reply: "out-ben-stop-reply" });
    wire(fake);
    await turn(ben(), "turn-ben-stop", [typed("evt-ben-0007", "STOP")]);

    const { report, linq } = await dispatch(fake, seedRowsOf(fake));

    expect(report.rows).toEqual([
      { outboxRowId: "out-ben-stop-reply", recipientHandleId: "handle-ben", outcome: "sent", partsSent: 1 },
    ]);
    expect(linq.requests).toHaveLength(1);
    const [sent] = linq.requests;
    expect(Object.keys(sent ?? {}).sort()).toEqual(Object.keys(sendOverrideOptout.request).sort());
    expect(sent).toEqual({
      ...sendOverrideOptout.request,
      idempotencyKey: "out-ben-stop-reply/1/1",
      to: "+15555550131",
      chatId: "linq-chat-demo-ben",
      text: Q01_DRAFTED.stopReply,
      overrideOptout: true,
    });
  });

  it("hard invariant: after the STOP, a routine row for that phone from any business sends nothing; only the reply goes", async () => {
    const fake = fakeCore(stopRecorded.given.now, [ben()]);
    fake.ids.set("turn-ben-stop", { reply: "out-ben-stop-reply" });
    wire(fake);
    await turn(ben(), "turn-ben-stop", [typed("evt-ben-0007", "STOP")]);
    // Rows to Ben from earlier commits, from three businesses and of every class but safety.
    const earlier: SeedRow[] = [
      {
        id: "out-ben-lees-reminder",
        recipient: "handle-ben",
        commitSeq: 1,
        bookingId: "booking-ben-skin-fade",
        sends: [words("Reminder: your skin fade is Sat at 2:00pm.")],
      },
      {
        id: "out-ben-yoga-class",
        recipient: "handle-ben",
        commitSeq: 2,
        sendClass: "quick_reply",
        sends: [words("Your class is booked.")],
      },
      {
        id: "out-ben-plumber-now",
        recipient: "handle-ben",
        commitSeq: 3,
        sendClass: "visit_now",
        sends: [words("Casey is on the way.")],
      },
      {
        id: "out-ben-help-line",
        recipient: "handle-ben",
        commitSeq: 4,
        fixedLines: ["helpReply"],
        sends: [words("help words")],
      },
    ];

    const { report, store, linq } = await dispatch(fake, [...earlier, ...seedRowsOf(fake)]);

    expect(report.rows.map((row) => [row.outboxRowId, row.outcome])).toEqual([
      ["out-ben-lees-reminder", "droppedStopped"],
      ["out-ben-yoga-class", "droppedStopped"],
      ["out-ben-plumber-now", "droppedStopped"],
      ["out-ben-help-line", "droppedStopped"],
      ["out-ben-stop-reply", "sent"],
    ]);
    expect(linq.requests.map((request) => [request.idempotencyKey, request.overrideOptout])).toEqual([
      ["out-ben-stop-reply/1/1", true],
    ]);
    expect(store.rowMarks.map((mark) => mark.request.outcome)).toEqual([
      "droppedStopped",
      "droppedStopped",
      "droppedStopped",
      "droppedStopped",
    ]);
  });

  it("hard invariant through limit 8's own decision: 1,000 rows to the stopped phone, any business, class and hour, are dropped", async () => {
    const fake = fakeCore(stopRecorded.given.now, [ben()]);
    wire(fake);
    await turn(ben(), "turn-ben-stop", [typed("evt-ben-0007", "STOP")]);
    const benPhone = fake.phones.get("+15555550131");
    if (benPhone === undefined) throw new Error("no phone");
    const state: SendState = { ...baseState(), ...sendStateOf(fake, benPhone) };
    expect(state).toMatchObject({ stopped: true, chatOpen: false });

    const random = mulberry32(267);
    const pick = <V>(values: readonly V[]): V => values[Math.floor(random() * values.length)] as V;
    const businesses = [LEES, LEE_HOME, YOGA, "biz-other-1", "biz-other-2", null];
    const classes = ["routine", "quick_reply", "visit_now", "reminder", "notice"];
    const lines: string[][] = [
      [],
      ["opener"],
      ["optOutLine"],
      ["helpReply"],
      ["startReply"],
      ["stopLaterReply"],
    ];
    for (let index = 0; index < 1000; index += 1) {
      const row = claimedRow(`out-sweep-${String(index)}`, {
        businessId: pick(businesses),
        bookingId: pick([null, "booking-ben-skin-fade", "booking-ben-other"]),
        sendClass: pick(classes),
        fixedLines: pick(lines),
      });
      const now = new Date(
        Date.parse("2026-10-21T00:00:00Z") + Math.floor(random() * 3 * 86_400_000),
      ).toISOString();
      const decision = decideLimit8({
        row,
        state,
        now,
        honourOverride: random() < 0.5,
        partOut: random() < 0.3,
      });
      expect(decision, row.outboxRowId).toEqual({
        action: "mark",
        outcome: "droppedStopped",
        heldUntil: null,
      });
    }
    // The stop reply, at 3am too: it goes, with the override.
    const reply = claimedRow("out-ben-stop-reply", { sendClass: "quick_reply", fixedLines: ["stopReply"] });
    expect(
      decideLimit8({ row: reply, state, now: "2026-10-22T07:00:00Z", honourOverride: false, partOut: false }),
    ).toEqual({ action: "send", reason: "stopReply", overrideOptout: true });
  });

  it("a rerun after a crash before the words: the commit repeats, and the words are written once", async () => {
    const fake = fakeCore(stopRecorded.given.now, [ben()]);
    fake.ids.set("turn-ben-stop", { reply: "out-ben-stop-reply" });
    wire(fake);
    fake.failPlanOnce.add("out-ben-stop-reply");

    const first = await turn(ben(), "turn-ben-stop", [typed("evt-ben-0007", "STOP")]);
    expect(first.result.replies[0]).toMatchObject({
      outcome: "noWords",
      errorCode: "noAnswer",
      stopped: true,
    });
    expect(first.result.rerun).toBe(true);
    expect(wordsIn(fake, "out-ben-stop-reply")).toBeNull();

    const second = await turn(ben(), "turn-ben-stop", [typed("evt-ben-0007", "STOP")]);
    expect(committed(fake, 1).repeated).toBe(true);
    expect(second.result.replies[0]).toMatchObject({
      outcome: "replied",
      rowsWritten: ["out-ben-stop-reply"],
    });

    const third = await turn(ben(), "turn-ben-stop", [typed("evt-ben-0007", "STOP")]);
    expect(third.result.replies[0]).toMatchObject({ outcome: "replied", rowsWritten: [], words: null });
    expect(fake.consents).toHaveLength(1);
    expect(fake.plans.map((plan) => plan.outboxRowId)).toEqual(["out-ben-stop-reply", "out-ben-stop-reply"]);
    expect(wordsIn(fake, "out-ben-stop-reply")).toBe(Q01_DRAFTED.stopReply);
  });

  it("a business's notice left without its words asks for a rerun too, which writes only that row", async () => {
    const fake = fakeCore(stopTellsBusinesses.given.now, [alex(), sam()]);
    fake.openBookings.set("+15555550101", [
      { bookingId: "booking-alex-sam-book", businessId: LEES, ownerHandleId: "handle-sam" },
    ]);
    fake.ids.set("turn-alex-stop", {
      reply: "out-alex-stop-reply",
      notices: { [LEES]: "out-sam-alex-texts-off" },
    });
    wire(fake);
    fake.failPlanOnce.add("out-sam-alex-texts-off");

    const first = await turn(alex(), "turn-alex-stop", [typed("evt-alex-0230", "STOP")]);
    expect(first.result.replies[0]).toMatchObject({
      outcome: "replied",
      rowsWritten: ["out-alex-stop-reply"],
      errorCode: "noAnswer",
    });
    expect(first.result.rerun).toBe(true);

    const second = await turn(alex(), "turn-alex-stop", [typed("evt-alex-0230", "STOP")]);
    expect(second.result.replies[0]).toMatchObject({
      outcome: "replied",
      rowsWritten: ["out-sam-alex-texts-off"],
      errorCode: null,
    });
    expect(second.result.rerun).toBe(false);
    expect(wordsIn(fake, "out-sam-alex-texts-off")).toBe(STOP_TO_BUSINESS);
  });
});

describe("START clears the stopped flag for every business and gets one reply", () => {
  it("Ben's START, from his own number and text (start-recorded.json in its turn): flag cleared, one reply, no override", async () => {
    const fake = fakeCore(stopRecorded.given.now, [ben()]);
    wire(fake);
    await turn(ben(), "turn-ben-stop", [typed("evt-ben-0007", "STOP")]);
    fake.now = startRecorded.given.now;

    const { result } = await turn(ben(), "turn-ben-start", [typed("evt-ben-0011", "START")], {
      traceId: "trace-ben-0011",
    });

    const caller: TurnCaller = {
      kind: "turn",
      turnId: "turn-ben-start",
      requestId: "turn-ben-start",
      businessId: null,
      personId: "person-ben",
      traceId: startRecorded.request.caller.traceId,
    };
    expect(fake.commits[1]).toEqual({
      caller,
      actions: [
        { call: "recordStopOrStart", request: { ...startRecorded.request, caller, sentByActor: null } },
      ],
    });
    expect(fake.phones.get("+15555550131")).toMatchObject({ stopped: false, chatOpen: true });
    expect(fake.consents.map((consent) => [consent.businessId, consent.revoked])).toEqual([
      [null, true],
      [null, false],
    ]);
    expect(result.replies[0]).toMatchObject({
      outcome: "replied",
      line: "startReply",
      words: "q01Default",
      stopped: false,
      told: [],
    });

    // The STOP's reply went at its turn; now the START's turn, and a routine row to Ben from another business after it.
    const later: SeedRow = {
      id: "out-ben-yoga-later",
      recipient: "handle-ben",
      commitSeq: 900,
      sends: [words("Your class is Sat at 10am.")],
    };
    const { report, linq } = await dispatch(fake, [...seedRowsOf(fake, "turn-ben-start"), later]);

    expect(report.rows.map((row) => [row.outboxRowId, row.outcome])).toEqual([
      [result.replies[0]?.rowsWritten[0], "sent"],
      ["out-ben-yoga-later", "sent"],
    ]);
    const [startReply] = linq.requests;
    expect(startReply).toMatchObject({ text: Q01_DRAFTED.startReply, overrideOptout: false });
    expect(Q01_DRAFTED.startReply).toMatch(/back on, for every business/u);
  });
});

describe("a vote's STOP or START keeps its option's words as the consent row's exact words (T-1338; K-29)", () => {
  const keys = fakeKeyStore();

  /**
   * A vote from this phone, for an option of these words, as the turn reads it: K-06's poll-vote.json scrubbed and sealed
   * by the gateway's own hand-off (K-06 v1.2: the option's words in its form 2 box, none in the clear), then opened from
   * its box by its form (`openWords`, `wordsOfEvent`), as the turn and the PostgreSQL-down path open a stored text.
   */
  async function boxedVote(who: FakePhone, eventId: string, optionWords: string): Promise<GuardText> {
    const handle = { kind: "phone", address: who.number };
    const prepared = await prepareHandoff(
      {
        event: {
          ...pollVote,
          eventId,
          handle,
          traceId: `trace-${eventId}`,
          poll: { ...pollVote.poll, optionWords },
        },
        partKey: null,
        traceId: `trace-${eventId}`,
        bundleId: BUNDLE_A,
      },
      keys,
    );
    if (prepared.door !== "actor") throw new Error("not an actor event");
    const stored = prepared.handoff.event;
    expect(stored.poll).toEqual({ pollId: pollVote.poll.pollId, optionId: pollVote.poll.optionId });
    if (stored.sealed?.v !== 2) throw new Error("the vote has no form 2 box");
    const box = await openWords(
      stored.sealed,
      await keys.getOrCreateKey(handle),
      actorNameOf(handle),
      eventId,
    );
    return { eventId, kind: stored.kind, words: wordsOfEvent(stored, box) };
  }

  /** The words of each recordStopOrStart the core was asked for, in order. */
  const recordedWords = (fake: FakeCore): string[] =>
    fake.commits
      .flatMap((commit) => commit.actions)
      .flatMap((action) => (action.call === "recordStopOrStart" ? [action.request.words] : []));

  it("a vote for an option that reads STOP commits stop-recorded.json's recordStopOrStart with the option's words, not the list's word", async () => {
    const fake = fakeCore(stopRecorded.given.now, [ben()]);
    fake.ids.set("turn-ben-stop", { consent: "consent-ben-stop", reply: "out-ben-stop-reply" });
    wire(fake);
    const vote = await boxedVote(ben(), "evt-ben-0007", "Stop!");

    const { result } = await turn(ben(), "turn-ben-stop", [vote], { traceId: "trace-ben-0007" });

    // The fixture's one core action under the turn's caller, but for its words: the option's as the person chose it,
    // where the fixture's typed STOP keeps its own "STOP".
    const [, stopAction] = stopRecorded.request.core;
    expect(stopAction?.request).toMatchObject({ kind: "stop", words: "STOP" });
    expect(fake.commits).toEqual([
      {
        caller: stopRecorded.request.caller,
        actions: [{ ...stopAction, request: { ...stopAction?.request, words: "Stop!" } }],
      },
    ]);
    expect(
      result.replies.map((reply) => [reply.text.kind, reply.keyword.word, reply.outcome, reply.stopped]),
    ).toEqual([["pollVote", "STOP", "replied", true]]);
    // K-29: the row that withdraws texts keeps the option's words as its exact words.
    expect(fake.consents.map((consent) => [consent.id, consent.revoked, consent.exactWords])).toEqual([
      ["consent-ben-stop", true, "Stop!"],
    ]);
  });

  it("a vote for an option that reads START commits start-recorded.json's START, in its turn, with the option's words", async () => {
    const fake = fakeCore(stopRecorded.given.now, [ben()]);
    wire(fake);
    await turn(ben(), "turn-ben-stop", [typed("evt-ben-0007", "STOP")]);
    fake.now = startRecorded.given.now;
    const vote = await boxedVote(ben(), "evt-ben-0011", "start");

    const { result } = await turn(ben(), "turn-ben-start", [vote], { traceId: "trace-ben-0011" });

    const caller: TurnCaller = {
      kind: "turn",
      turnId: "turn-ben-start",
      requestId: "turn-ben-start",
      businessId: null,
      personId: "person-ben",
      traceId: startRecorded.request.caller.traceId,
    };
    expect(startRecorded.request.words).toBe("START");
    expect(fake.commits[1]).toEqual({
      caller,
      actions: [
        {
          call: "recordStopOrStart",
          request: { ...startRecorded.request, caller, words: "start", sentByActor: null },
        },
      ],
    });
    expect(result.replies[0]).toMatchObject({ outcome: "replied", line: "startReply", stopped: false });
    expect(fake.phones.get("+15555550131")).toMatchObject({ stopped: false, chatOpen: true });
    expect(fake.consents.map((consent) => [consent.revoked, consent.exactWords])).toEqual([
      [true, "STOP"],
      [false, "start"],
    ]);
  });

  it("a vote for CANCELAR keeps the option's words and still flags the visit (RULES 7.4)", async () => {
    const fake = fakeCore(stopTellsBusinesses.given.now, [alex()]);
    wire(fake);
    const vote = await boxedVote(alex(), "evt-alex-0291", "¡Cancelar!");

    await turn(alex(), "turn-alex-vote-cancelar", [vote]);

    expect(fake.commits[0]?.actions).toMatchObject([
      {
        call: "recordStopOrStart",
        request: {
          kind: "stop",
          inboundEventId: "evt-alex-0291",
          words: "¡Cancelar!",
          alsoCancelVisit: true,
        },
      },
    ]);
    expect(fake.consents.map((consent) => consent.exactWords)).toEqual(["¡Cancelar!"]);
  });

  it("a typed STOP keeps its body, and an email's STOP in its subject alone keeps the subject, as before", async () => {
    const fake = fakeCore(stopTellsBusinesses.given.now, [alex(), ben()]);
    wire(fake);
    // An email's words as its form 2 box opens them: a body with no word in it, the STOP in the subject.
    const email: GuardText = {
      eventId: "evt-alex-0292",
      kind: "text",
      words: { body: "\n", subject: "Stop.", optionWords: null },
    };

    await turn(ben(), "turn-ben-typed-stop", [typed("evt-ben-0292", "stop!")]);
    await turn(alex(), "turn-alex-subject-stop", [email]);

    expect(recordedWords(fake)).toEqual(["stop!", "Stop."]);
    expect(fake.consents.map((consent) => consent.exactWords)).toEqual(["stop!", "Stop."]);
  });
});

describe("HELP gets Rosie's name and number and how to stop", () => {
  it("HELP alone: sendFixedLine helpReply in the turn, its words written by code, one reply sent", async () => {
    const fake = fakeCore(stopTellsBusinesses.given.now, [alex()]);
    wire(fake);

    const { result } = await turn(alex(), "turn-alex-help", [typed("evt-alex-0300", "help?")]);

    const caller: TurnCaller = {
      kind: "turn",
      turnId: "turn-alex-help",
      requestId: "turn-alex-help",
      businessId: null,
      personId: "person-alex",
      traceId: "trace-turn-alex-help",
    };
    expect(fake.commits).toEqual([
      {
        caller,
        actions: [
          {
            call: "sendFixedLine",
            request: {
              caller,
              fixedLineId: "helpReply",
              recipientHandleId: "handle-alex",
              sendClass: "quick_reply",
              sentByActor: null,
            },
          },
        ],
      },
    ]);
    const rowId = result.replies[0]?.rowsWritten[0] ?? "";
    const help = wordsIn(fake, rowId) ?? "";
    expect(help).toContain("This is Rosie");
    expect(help).toContain(ROSIE_NUMBER);
    expect(help).toMatch(/reply STOP\.$/u);
    expect(help).toMatch(/for every business/u);
    expect(help).not.toMatch(/[<>]/u);

    const { linq } = await dispatch(fake, seedRowsOf(fake));
    expect(linq.requests.map((request) => [request.text, request.overrideOptout])).toEqual([[help, false]]);
  });

  it("HELP from a stopped number: the core refuses it (phoneStopped), nothing is written or sent (its one reply is T-268's)", async () => {
    const fake = fakeCore(stopTellsBusinesses.given.now, [alex()]);
    wire(fake);
    await turn(alex(), "turn-alex-stop", [typed("evt-alex-0301", "STOP")]);
    const plansBefore = fake.plans.length;

    const { result, spans } = await turn(alex(), "turn-alex-help", [typed("evt-alex-0302", "HELP")]);

    expect(result.replies[0]).toMatchObject({
      outcome: "refused",
      errorCode: "phoneStopped",
      rowsWritten: [],
    });
    expect(result.rerun).toBe(false);
    expect(fake.plans).toHaveLength(plansBefore);
    expect(seedRowsOf(fake, "turn-alex-help")).toEqual([]);
    expect(spans[0]).toMatchObject({ outcome: "refused", error_code: "phoneStopped" });
  });

  it("with no Rosie number configured, HELP's words are not written (noWords): the reply never goes without the number", async () => {
    const fake = fakeCore(stopTellsBusinesses.given.now, [alex()]);
    wire(fake, " ");

    const { result } = await turn(alex(), "turn-alex-help", [typed("evt-alex-0303", "Help")]);

    expect(result.replies[0]).toMatchObject({ outcome: "noWords", errorCode: "noWords", line: "helpReply" });
    expect(fake.plans).toEqual([]);
  });
});

describe("the stop reply keeps each step's other content (A7-11, B7-15) in C1's every-business meaning", () => {
  it.each([
    ["A7-11", LEES, "Lee's Barbershop", "booking-alex-haircut"],
    ["B7-15", LEE_HOME, "Lee Home Services", "booking-alex-sink"],
  ])("%s: Alex texts 'Cancel' before his visit at %s", async (_step, businessId, businessName, bookingId) => {
    const fake = fakeCore(stopTellsBusinesses.given.now, [alex(), sam()]);
    fake.openBookings.set("+15555550101", [{ bookingId, businessId, ownerHandleId: "handle-sam" }]);
    wire(fake);

    const { result } = await turn(alex(), "turn-alex-cancel", [typed("evt-alex-0310", "Cancel")]);

    // A bare CANCEL is a stop that also flags the visit (RULES 7.4): the visit is flagged, never cancelled.
    const [action] = fake.commits[0]?.actions ?? [];
    expect(action).toMatchObject({
      call: "recordStopOrStart",
      request: { kind: "stop", alsoCancelVisit: true },
    });
    const stop = committed(fake).core[0]?.response as RecordStopOrStartResponse;
    expect(stop.flaggedBookingIds).toEqual([bookingId]);

    const reply = result.replies[0];
    expect(reply).toMatchObject({ outcome: "replied", line: "stopReply", stopped: true, told: [businessId] });
    const text = wordsIn(fake, reply?.rowsWritten[0] ?? "") ?? "";
    expect(text).toMatch(/off, for every business/u); // MC C1: never one business's
    expect(text).not.toContain(businessName);
    expect(text).toMatch(/still booked/u); // A7-11, B7-15: the visit stays booked
    expect(text).toMatch(/to cancel it, call the business/u); // RULES 7.3: how to cancel, by a call
    expect(text).toMatch(/Reply START to turn texts back on\.$/u); // RULES 7.5; S2-08

    // One reply to Alex, past the opt-out; the business hears only its one line (S13-32).
    const { linq } = await dispatch(fake, seedRowsOf(fake));
    expect(sentTo(linq.requests, "+15555550101")).toEqual([[text, true]]);
    expect(sentTo(linq.requests, "+15555550100")).toEqual([[STOP_TO_BUSINESS, false]]);
    expect(linq.requests).toHaveLength(2);
  });

  it("Jay's words, once the bundle carries them, go word for word instead of Q-01's draft", async () => {
    const jays =
      "Texts from Rosie are off for every business. Your visits stay booked: call to cancel. Reply START to undo.";
    const fake = fakeCore(stopTellsBusinesses.given.now, [alex()]);
    wire(fake);

    const { result } = await turn(alex(), "turn-alex-stop", [typed("evt-alex-0320", "STOP")], {
      manifest: withLine(manifest, "stopReply", jays),
    });

    expect(result.replies[0]).toMatchObject({ outcome: "replied", words: "bundle" });
    expect(wordsIn(fake, result.replies[0]?.rowsWritten[0] ?? "")).toBe(jays);
  });

  it("a bundle line naming <business> is not sent as it is (these replies are for every business): Q-01's draft goes", async () => {
    const fake = fakeCore(stopTellsBusinesses.given.now, [alex()]);
    wire(fake);

    const { result } = await turn(alex(), "turn-alex-stop", [typed("evt-alex-0321", "stop")], {
      manifest: withLine(manifest, "stopReply", "Texts from <business> are off."),
    });

    expect(result.replies[0]).toMatchObject({ outcome: "replied", words: "q01Default" });
    expect(wordsIn(fake, result.replies[0]?.rowsWritten[0] ?? "")).toBe(Q01_DRAFTED.stopReply);
  });
});

describe("the owner is told (S2-08; S13-32 and RULES 7.5 through K-09 v1.1 businessesTold)", () => {
  it("j3-stop-tells-businesses.json: Sam hears only the one fixed line, never where the stop came from; Alex gets his reply", async () => {
    const fake = fakeCore(stopTellsBusinesses.given.now, [alex(4), sam()]);
    fake.openBookings.set("+15555550101", [
      { bookingId: "booking-alex-sam-book", businessId: LEES, ownerHandleId: "handle-sam" },
    ]);
    fake.ids.set("turn-alex-stop-0220", {
      consent: "consent-alex-stop-0220",
      reply: "out-alex-stop-reply-0220",
      notices: { [LEES]: "out-sam-alex-texts-off-0220" },
    });
    wire(fake);

    const { result } = await turn(alex(), "turn-alex-stop-0220", [typed("evt-alex-0220", "STOP")], {
      traceId: "trace-alex-0220",
    });

    expect(fake.commits[0]?.actions).toEqual([
      { call: "recordStopOrStart", request: stopTellsBusinesses.request },
    ]);
    expect(committed(fake).core).toEqual([
      { call: "recordStopOrStart", response: stopTellsBusinesses.outcome, error: null },
    ]);
    expect(result.replies[0]).toMatchObject({
      outcome: "replied",
      told: [LEES],
      rowsWritten: ["out-alex-stop-reply-0220", "out-sam-alex-texts-off-0220"],
    });
    // K-09 names the line textsOffReachTheirWay; its words are K-01's stopToBusiness, word for word.
    const notice = fake.plans.find((plan) => plan.outboxRowId === "out-sam-alex-texts-off-0220");
    expect(notice?.finalParts).toMatchObject({
      sends: [{ kind: "words", text: STOP_TO_BUSINESS }],
      fixedLines: ["stopToBusiness"],
      slotValues: [],
    });
    expect(STOP_TO_BUSINESS).toBe("Texts to this customer are off. Reach them their way.");

    const { report, linq } = await dispatch(fake, seedRowsOf(fake));
    expect(report.rows.map((row) => [row.outboxRowId, row.outcome])).toEqual([
      ["out-alex-stop-reply-0220", "sent"],
      ["out-sam-alex-texts-off-0220", "sent"],
    ]);
    expect(sentTo(linq.requests, "+15555550101")).toEqual([[Q01_DRAFTED.stopReply, true]]);
    expect(sentTo(linq.requests, "+15555550100")).toEqual([[STOP_TO_BUSINESS, false]]);
    expect(linq.requests).toHaveLength(2);
  });

  it("S2-08: Avery's STOP to the invite gets C1's every-business reply, with how to turn texts back on", async () => {
    const fake = fakeCore(stopTellsBusinesses.given.now, [avery()]);
    wire(fake);

    const { result } = await turn(avery(), "turn-avery-stop", [typed("evt-avery-0001", "STOP")]);

    expect(result.replies[0]).toMatchObject({ outcome: "replied", line: "stopReply", stopped: true });
    const text = wordsIn(fake, result.replies[0]?.rowsWritten[0] ?? "") ?? "";
    expect(text).toMatch(/off, for every business/u);
    expect(text).not.toContain("Lee's Barbershop");
    expect(text).toMatch(/Reply START to turn texts back on\.$/u); // S2-08: only START turns texts back on
  });
});

describe("several keyword texts in one turn: one commit, in arrival order", () => {
  it("STOP, then HELP, then START: HELP is refused while stopped, START turns texts back on", async () => {
    const fake = fakeCore(stopTellsBusinesses.given.now, [alex()]);
    wire(fake);

    const { result } = await turn(alex(), "turn-alex-three", [
      typed("evt-alex-0401", "STOP"),
      typed("evt-alex-0402", "HELP"),
      typed("evt-alex-0403", "START"),
    ]);

    expect(fake.commits).toHaveLength(1);
    expect(fake.commits[0]?.actions.map((action) => action.call)).toEqual([
      "recordStopOrStart",
      "sendFixedLine",
      "recordStopOrStart",
    ]);
    expect(result.replies.map((reply) => [reply.keyword.kind, reply.outcome, reply.errorCode])).toEqual([
      ["stop", "replied", null],
      ["help", "refused", "phoneStopped"],
      ["start", "replied", null],
    ]);
    expect(fake.phones.get("+15555550101")).toMatchObject({ stopped: false, chatOpen: true });
  });
});

describe("fails closed", () => {
  it("unwired (before D-017): nothing recorded or written; the turn must run again", async () => {
    restore();
    restore = setReplyDeps(null);

    const { result, spans } = await turn(alex(), "turn-alex-stop", [typed("evt-alex-0501", "STOP")]);

    expect(result.replies[0]).toMatchObject({ outcome: "notRecorded", errorCode: "unwired" });
    expect(result.rerun).toBe(true);
    expect(spans[0]).toMatchObject({ hop: "fillAndChecks", outcome: "failed", error_code: "unwired" });
  });

  it.each([
    ["no answer (PostgreSQL down)", "noAnswer", (fake: FakeCore) => (fake.down = true)],
    [
      "a transient answer",
      "transient",
      (fake: FakeCore) => (fake.failNextCommit = { error: "transient", sqlstate: "40001" }),
    ],
  ])(
    "a commit with %s records nothing and writes nothing: the turn must run again",
    async (_case, code, failing) => {
      const fake = fakeCore(stopTellsBusinesses.given.now, [alex()]);
      wire(fake);
      failing(fake);

      const { result } = await turn(alex(), "turn-alex-stop", [typed("evt-alex-0502", "STOP")]);

      expect(result.replies[0]).toMatchObject({ outcome: "notRecorded", errorCode: code });
      expect(result.rerun).toBe(true);
      expect(fake.plans).toEqual([]);
      expect(fake.phones.get("+15555550101")?.stopped).toBe(false);
    },
  );

  it("an answer that is not K-09's for these actions is not read as recorded (badAnswer)", async () => {
    const fake = fakeCore(stopTellsBusinesses.given.now, [alex()]);
    restore();
    restore = setReplyDeps({
      core: {
        commitCore: () =>
          Promise.resolve({ result: "committed", turnId: "turn-alex-stop", repeated: false, core: [] }),
      },
      rows: fake.rows,
      rosieNumber: ROSIE_NUMBER,
    });

    const { result } = await turn(alex(), "turn-alex-stop", [typed("evt-alex-0503", "STOP")]);

    expect(result.replies[0]).toMatchObject({ outcome: "notRecorded", errorCode: "badAnswer" });
    expect(fake.plans).toEqual([]);
  });

  it("an email handle has no number for a STOP: refused here (noPhone), never a rerun; HELP still goes", async () => {
    const fake = fakeCore(stopTellsBusinesses.given.now, [alex()]);
    wire(fake);

    const { result } = await turn(
      alex(),
      "turn-alex-email",
      [typed("evt-alex-0504", "STOP"), typed("evt-alex-0505", "HELP")],
      {
        phoneNumber: null,
      },
    );

    expect(result.replies.map((reply) => [reply.outcome, reply.errorCode])).toEqual([
      ["refused", "noPhone"],
      ["replied", null],
    ]);
    expect(result.rerun).toBe(false);
    expect(fake.commits[0]?.actions.map((action) => action.call)).toEqual(["sendFixedLine"]);
  });
});

describe("the spans hold labels and counts only", () => {
  it("one fillAndChecks span per keyword text, never a number or anyone's words", async () => {
    const fake = fakeCore(stopTellsBusinesses.given.now, [alex(), sam()]);
    fake.openBookings.set("+15555550101", [
      { bookingId: "booking-alex-sam-book", businessId: LEES, ownerHandleId: "handle-sam" },
    ]);
    wire(fake);

    const { spans } = await turn(alex(), "turn-alex-mixed", [
      typed("evt-alex-0601", "Opt Out"),
      typed("evt-alex-0602", "help"),
    ]);

    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({
      hop: "fillAndChecks",
      outcome: "ok",
      event_id: "evt-alex-0601",
      got: { keyword: "stop", flagsVisit: false },
      decided: {
        result: "replied",
        line: "stopReply",
        words: "q01Default",
        stopped: true,
        told: 1,
        rowsWritten: 2,
      },
      error_code: null,
    });
    expect(spans[1]).toMatchObject({
      outcome: "refused",
      error_code: "phoneStopped",
      got: { keyword: "help" },
    });
    const line = JSON.stringify(spans);
    for (const fragment of [
      "+1555",
      "555-0199",
      "Opt Out",
      "OPT OUT",
      "every business",
      "Rosie",
      "this customer",
    ]) {
      expect(line).not.toContain(fragment);
    }
  });
});

// ---- helpers ---------------------------------------------------------------------------------------------------

/** A send state with an open chat, a customer, New York and text hours 08:00 to 20:00 (as the dispatcher's fake gives it). */
function baseState(): SendState {
  return {
    stopped: false,
    chatOpen: true,
    audience: "customer",
    visitZone: null,
    businessZone: "America/New_York",
    textHours: { start: "08:00", end: "20:00" },
    textHoursOverride: false,
    currentVersions: [],
    closed: { booking: false, question: false },
  };
}

/** A claimed row to Ben (K-05 v1.1 claimedRow), its words for the test only. */
function claimedRow(
  id: string,
  over: { businessId?: string | null; bookingId?: string | null; sendClass: string; fixedLines: string[] },
): ClaimedRow {
  return {
    outboxRowId: id,
    version: 4,
    commitSeq: 1,
    recipientHandleId: "handle-ben",
    recipientPersonId: "person-ben",
    businessId: over.businessId ?? null,
    bookingId: over.bookingId ?? null,
    openQuestionId: null,
    channel: "imessage",
    sendClass: over.sendClass,
    versionsRead: [],
    finalParts: {
      row: id,
      channel: "imessage",
      sends: [words("words")],
      fixedLines: over.fixedLines,
      threadReplyTo: null,
    },
    parts: [{ partNo: 1, tryNo: 1, idempotencyKey: `${id}/1/1`, attempts: 1, sent: false }],
    traceId: `trace-${id}`,
    claim: {
      claimer: "dispatcher-1",
      claimedAt: "2026-10-21T19:30:03Z",
      lapsesAt: "2026-10-21T19:31:03Z",
      claimNo: 1,
      firstTryAt: null,
      nextTryNotBefore: null,
    },
    claimedFrom: "checked",
  };
}

/** A small seeded random number generator, so the sweep is the same on every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
