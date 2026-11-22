// T-1141's unit proof of the turn face's gate and commit (K-09 v1.5 commit-s1-01.json, the skeleton's turn 1: ADR-013),
// through the Tool API base with the gate and its limits as registered (limit 1 given bundle v0's step cards: STATE note
// 65), T-1139's walk, T-1140's runCore with T-318's safety service, and the bindings of commit.ts: openHolds joined with
// the runtime's commit-time context, the safety reader over K-05 v1.4's reads, the pinned bundle's lines. K-05's calls are
// doubles in K-05's shapes (calls-test-support.ts); nothing under test is stood in for.
//
// Round 2 (DL-364): limit 1 passes turn 1's sign-up door since T-1183, so the turn commits exactly as commit-s1-01.json
// states it: the six limit answers, S1-01's thread, S1-02's question with its clock row and outbox-s1-02-sam-1, and the
// text's safety record, under one turn id and its trace.
//
// T-1193 (DL-376): the handle actor's turn records the gate (one span per part, with its limits) and the commit itself,
// so the face's gateAndCommit leaves no span of the base's; the same handlers on a base called without the face's option
// give the same commit and record the base's one gate span, labels only.
//
// T-1194: the answer's `written` leaves the safety record's row out, as commit-s1-01.json's does (K-09 v1.5 default 134),
// so the whole answer equals the fixture's; K-05's one commit still writes the record.
//
// T-1266 (ADR-015's new task "The commit names every event of the turn"; DL-508): a customer's tapback joins the turn but
// is never read by the safety read, so K-34 never holds a row for it. The commit names to readOpenHolds only the turn's
// texts the safety read reads (K-05 item 34: "the turn's texts"), so a tapback beside a recorded text no longer holds every
// routine part, while a real text with no record still does.
//
// T-1519 (DL-1048): with the walk's chat read bound (TurnCommitBinding.readChatHandle, K-05 v1.10 item 51), a turn 1 whose
// chat Sam's own chat thread already holds commits S1-02's question with no thread written; one whose chat no thread
// holds commits exactly as commit-s1-01.json states it; an error answer fails the call closed.
//
// T-1493 (H1a; K-09 README default 199; DL-1033, DL-1075): signUpSteps, given the one-kind path's reads (`companies`) and
// S1-08's own stop reads (`plan`), binds S1-02 through T-1492's one-kind wrapper inside T-634's, S1-04's buttons settler
// from the same instance (TurnCommitBinding.buttonsSettlers, handed to the walk) and S1-08's writer (T-1482); left out,
// the object is today's, field for field. On the walk the binding hands writesOf, over bundle v2 and the doubles of
// items 78, 79 and 72, the catalog by id, the stop home and the trade overlays: "Plumbing" walks S1-04 without asking it,
// to S1-08's row and S1-09's question; "Barbershop, plumbing, electrical" still asks S1-04; with S1-08's stop reads left
// out the walk is refused with nothing returned. The integration test (pg/one-kind.int.test.ts) commits it for real.
//
// T-1520 (DL-1056, DL-1076): S1-03 is bound through the same instance's draft wrapper beside S1-02's binding, so a
// one-kind "One isn't on the list yet" drafts under the pick's business; without the companies reads, as today.

import { describe, expect, it } from "vitest";

import type { Span } from "../../../../runtime/src/trace";
import type { GateAndCommitRequest } from "../../commit";
import type { CoreFlagsDeps } from "../../commit/core";
import { WalkNotBuiltError, type WalkQuestions } from "../../commit/walk";
import { NOTHING_OPEN, commitS1_02, questionsOver } from "../../commit/walk/test-support";
import { NOT_TOLD_YET, PLUGIN_LISTS_NO_STOP_WORDS } from "../../domain/safety";
import { BARBERSHOP, safetyWorldOf } from "../../domain/safety/test-support";
import { BUNDLE_V0, fakeBundles, sampleBundle, withSteps } from "../../frontier/assemble/test-support";
import type { Decided } from "../../gate/framework";
import { readsOn, seedWorld } from "../../homes/stop/test-support";
import { NotBuiltError } from "../errors";
import { companiesReadsOf } from "../journey-1/companies";
import { SAM_COMPANY, catalogDefaults, fakeCompaniesK05 } from "../journey-1/companies/test-support";
import { kindsReadsOf } from "../journey-1/kinds";
import { PACK_HIKES, fakeK05, turnWithWords } from "../journey-1/kinds/test-support";
import { PlanNotBuiltError } from "../journey-1/plan";
import { PF_TEXT_KEYS } from "../journey-1/plug-ins";
import { traceFor } from "../test-support";
import { createToolApi } from "../tool-api";
import { createToolApiValidator } from "../validator";
import {
  SAM_KEY,
  bundleV0,
  bundleV2Id,
  callDoubles,
  commitContextOf,
  commitRequestAfter,
  commitS101,
  limitOneOnTurnOne,
  openHoldsOn,
  publishedBundleV2,
  safetyReadsOn,
  tradesOverV2,
  type OpenHoldsRead,
} from "./calls-test-support";
import {
  NOTHING_OPEN_AT,
  bundleStepCards,
  keywordCommitDeps,
  openHoldsPort,
  pinnedSafetyLines,
  safetyReaderOf,
  signUpSteps,
  turnCommitDeps,
  walkChatsOf,
  type CommitAt,
  type SafetyReads,
  type SignUpWriterDeps,
  type TurnCommitBinding,
} from "./commit";
import { TurnFaceReadError, TurnFaceRefusedError } from "./errors";
import { callHandlers, createTurnFace, type GateAndCommitCallAnswer, type TurnFaceCalls } from "./turn-face";

type Json = Record<string, unknown>;

const validator = createToolApiValidator();

/** A face whose frontier is never called here, with the calls given. */
function faceOver(calls: TurnFaceCalls<unknown> | undefined) {
  return createTurnFace<never>({
    scope: { withBusiness: () => Promise.reject(new Error("the frontier is not called here")) },
    bundles: bundleV0(),
    validator,
    ...(calls === undefined ? {} : { calls }),
  });
}

/** One gateAndCommit through the face, with its spans. */
async function commitThrough(
  calls: TurnFaceCalls<unknown>,
  request: unknown,
  at: CommitAt = NOTHING_OPEN_AT,
): Promise<{ answer: GateAndCommitCallAnswer; spans: Span[] }> {
  const { trace, spans } = traceFor(request);
  const answer = await faceOver(calls).gateAndCommit(structuredClone(request), at, trace);
  return { answer, spans };
}

/** The committed answer, held to K-09 v1.5's response. */
function committed(answer: GateAndCommitCallAnswer): Json & { parts: Json[]; written: Json } {
  expect(answer, JSON.stringify(answer)).toHaveProperty("result", "committed");
  expect(validator.check("gateAndCommit", "response", answer)).toEqual([]);
  return answer as unknown as Json & { parts: Json[]; written: Json };
}

describe("the gate as bound: limit 1 on turn 1's sign-up door (T-1183)", () => {
  it("limit 1, given bundle v0's step cards, passes the door on anyone's word", async () => {
    expect(await limitOneOnTurnOne(bundleV0())).toEqual({ result: "pass" });
  });
});

describe("gateAndCommit through the turn face: commit-s1-01.json, turn 1 (K-09 v1.5)", () => {
  it("commits exactly as commit-s1-01.json states it, under one turn id and its trace: the six limits, S1-01's thread, S1-02's question and clock row, outbox-s1-02-sam-1", async () => {
    const exchange = commitS101();
    const doubles = callDoubles();
    const { answer, spans } = await commitThrough(doubles.calls, commitRequestAfter(undefined));
    const result = committed(answer);
    // Every field as the fixture states it, `written` included: the rows the walk wrote, the core action's left out and
    // named in its response instead (K-09 v1.5 default 134; T-1194).
    expect(result).toEqual(exchange.outcome);

    // One K-05 commit, its turn row K-05's seven fields alone (default 135), the record's row and entry among its writes.
    expect(doubles.k05.requests).toHaveLength(1);
    const [sent] = doubles.k05.requests;
    if (sent === undefined) throw new Error("one commit was sent");
    expect(Object.keys(sent.turn).sort()).toEqual(
      ["bundleId", "eventIds", "handleId", "id", "joinedTraceIds", "traceId", "tries"].sort(),
    );
    expect(sent.turn).toMatchObject({ id: "turn-s1-01-sam", traceId: "trace-sam-0000" });
    expect(sent.writes.events.map((entry) => entry.kind)).toContain("safety_outcome.recorded");
    expect(sent.writes.outboxRows.map((row) => row.id)).toEqual(["outbox-s1-02-sam-1"]);
    // The safety record is still written, by that same commit: K-05 wrote its row first, then the rows `written` lists.
    expect(doubles.k05.commits).toEqual([
      {
        turnId: "turn-s1-01-sam",
        written: [
          { table: "safety_outcomes", rowId: "safety-outcome-sam-s1-01", version: 1 },
          ...exchange.outcome.written.written,
        ],
      },
    ]);

    // No span of the base's on the turn's trace: the turn records the gate and the commit itself, and the face tells the
    // base so (T-1193). The base's own gate span, without the face's option, is the next test's.
    expect(spans).toEqual([]);
  });

  it("without the face's option, the same handlers on the base give the same commit and record its one gate span: the rows by table and id, never a word or the chat id (T-1193)", async () => {
    const request = commitRequestAfter(undefined);
    const faceDoubles = callDoubles();
    const viaFace = await commitThrough(faceDoubles.calls, request);
    expect(viaFace.spans).toEqual([]);
    // The face's own handlers for gateAndCommit, on a base called as any other caller calls it.
    const doubles = callDoubles();
    const base = createToolApi<unknown>({
      validator,
      scope: doubles.calls.scope,
      handlers: callHandlers(doubles.calls, NOTHING_OPEN_AT),
    });
    const { trace, spans } = traceFor(request);
    const answer = await base.call("gateAndCommit", structuredClone(request), trace);
    expect(answer).toEqual(viaFace.answer);
    expect(doubles.k05.requests).toEqual(faceDoubles.k05.requests);

    // One gate span on the turn's trace: the gate's limits, the rows by table and id, never a word or the chat id.
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span).toMatchObject({
      hop: "gate",
      trace_id: "trace-sam-0000",
      turn_id: "turn-s1-01-sam",
      business_id: BARBERSHOP,
      outcome: "ok",
    });
    expect(validator.checkSpan(span)).toEqual([]);
    const text = JSON.stringify(span);
    for (const secret of [
      "linq-chat-demo-sam",
      "Hi, I want to put my barbershop on Rosie",
      "+15555550100",
      "Sam Lee",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("replaying the same turn writes nothing twice: the repeat answers the first commit, repeated, with no row", async () => {
    const doubles = callDoubles();
    const request = commitRequestAfter(undefined);
    const first = committed((await commitThrough(doubles.calls, request)).answer);
    const again = committed((await commitThrough(doubles.calls, request)).answer);
    expect(doubles.k05.commits).toHaveLength(1);
    expect(again).toMatchObject({ turnId: first.turnId, committedAt: first.committedAt, repeated: true });
    expect((again.written as { written: unknown[] }).written).toEqual([]);
    expect(again.openQuestions).toEqual({ opened: [], closed: [] });
  });

  it("reads what is open at commit time under the call's business only, and the safety reads name it", async () => {
    const doubles = callDoubles();
    await commitThrough(doubles.calls, commitRequestAfter(undefined));
    // The turn's one text has its record among the core actions, so no text is named; Sam's handle, the barbershop.
    expect(doubles.openHoldsReads.map((read) => read.request)).toEqual([
      { handleId: "handle-sam", businessId: BARBERSHOP, eventIds: [] },
    ]);
    expect(doubles.safetyReads.length).toBeGreaterThan(0);
    for (const read of doubles.safetyReads) expect(read.businessId).toBe(BARBERSHOP);
    // Sam's words are sealed under his own key, never written in plain.
    expect(doubles.sealer.calls.map((call) => call.forPersonId)).toEqual(["person-sam"]);
  });

  it("an open hold the runtime holds at commit time holds the routine part back, and nothing of it is written", async () => {
    const doubles = callDoubles();
    const at: CommitAt = {
      holds: [
        {
          eventId: "evt-sam-earlier",
          holdId: "hold-sam-earlier",
          rule: "after_safe",
          outcomes: ["Crisis words"],
          blocksBooking: false,
        },
      ],
      unread: [],
    };
    const result = committed((await commitThrough(doubles.calls, commitRequestAfter(undefined), at)).answer);
    const [part] = result.parts;
    expect(part).toMatchObject({ part: 0, result: "held", gives: [] });
    const [sent] = doubles.k05.requests;
    expect(sent?.writes.state.map((write) => write.table)).toEqual(["safety_outcomes"]);
    expect(sent?.writes.outboxRows).toEqual([]);
  });

  it("without the calls bound, gate and commit, compose input and finalize each answer notBuilt and read nothing", async () => {
    const face = faceOver(undefined);
    const request = commitRequestAfter(undefined);
    const { trace } = traceFor(request);
    expect(await face.gateAndCommit(request, NOTHING_OPEN_AT, trace)).toEqual({
      error: "notBuilt",
      call: "gateAndCommit",
    });
  });
});

describe("the walk's chat read: S1-01 reuses the handle's own chat thread (T-1519; DL-1048)", () => {
  /** The chat read as K-05 v1.10 readChatHandle answers it: the handle `handleId` holds the chat id, its number beside it. */
  function chatRead(handleId: string | null, asked: string[] = []) {
    return (request: { linqChatId: string }) => {
      asked.push(request.linqChatId);
      return Promise.resolve(
        handleId === null
          ? { handleId: null, handle: null }
          : { handleId, handle: { kind: "phone" as const, address: "+15555550100" } },
      );
    };
  }

  it("Sam's own chat thread holds the turn's chat: turn 1 commits S1-02's question, its clock row and outbox row with no thread written, and the part gives thread", async () => {
    const exchange = commitS101();
    const asked: string[] = [];
    const doubles = callDoubles({ readChatHandle: chatRead("handle-sam", asked) });
    const { answer } = await commitThrough(doubles.calls, commitRequestAfter(undefined));
    const result = committed(answer);
    // The fixture's answer but the thread's row: the same parts (S1-01 gives thread), S1-02's question opened.
    expect(result).toEqual({
      ...exchange.outcome,
      written: {
        ...exchange.outcome.written,
        written: exchange.outcome.written.written.filter((row) => row.table !== "threads"),
      },
    });
    expect(result.parts).toEqual(exchange.outcome.parts);
    // K-05's one commit writes the text's safety record and no thread, with no thread.created entry.
    const [sent] = doubles.k05.requests;
    expect(sent?.writes.state.map((write) => write.table)).toEqual(["safety_outcomes"]);
    expect(sent?.writes.events.map((entry) => entry.kind)).not.toContain("thread.created");
    expect(sent?.writes.outboxRows.map((row) => row.id)).toEqual(["outbox-s1-02-sam-1"]);
    // The read was asked once, for the turn's chat id alone.
    expect(asked).toEqual(["linq-chat-demo-sam"]);
  });

  it("no chat thread holds the turn's chat: turn 1 commits exactly as commit-s1-01.json states it, the thread inserted", async () => {
    const asked: string[] = [];
    const doubles = callDoubles({ readChatHandle: chatRead(null, asked) });
    const { answer } = await commitThrough(doubles.calls, commitRequestAfter(undefined));
    expect(committed(answer)).toEqual(commitS101().outcome);
    expect(asked).toEqual(["linq-chat-demo-sam"]);
  });

  it("walkChatsOf hands the walk the handle id alone, and throws an error answer, never read as none", async () => {
    const chats = walkChatsOf(chatRead("handle-sam"));
    expect(await chats.chatHandle("linq-chat-demo-sam")).toBe("handle-sam");
    expect(await walkChatsOf(chatRead(null)).chatHandle("linq-chat-demo-sam")).toBeNull();
    const failing = walkChatsOf(() => Promise.resolve({ error: "transient" }));
    const error = await failing.chatHandle("linq-chat-demo-sam").then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TurnFaceReadError);
    expect(error).toMatchObject({ read: "readChatHandle", code: "transient" });
    // The error names the read and its code, never the chat id or the number.
    expect(String(error)).not.toContain("linq-chat-demo-sam");
  });

  it("a chat read that answers an error fails the call closed: the face throws it as the base does, and nothing is committed", async () => {
    const doubles = callDoubles({ readChatHandle: () => Promise.resolve({ error: "transient" }) });
    const request = commitRequestAfter(undefined);
    const { trace } = traceFor(request);
    await expect(
      faceOver(doubles.calls).gateAndCommit(structuredClone(request), NOTHING_OPEN_AT, trace),
    ).rejects.toMatchObject({ name: "TurnFaceReadError", read: "readChatHandle", code: "transient" });
    expect(doubles.k05.requests).toEqual([]);
    expect(doubles.k05.commits).toEqual([]);
  });
});

describe("openHolds: K-05 readOpenHolds joined with the runtime's commit-time context (DL-326)", () => {
  const request = commitRequestAfter(undefined);

  it("names the turn's texts whose record is not among the core actions, and every unread id the runtime carries", async () => {
    const reads: { request: unknown }[] = [];
    const port = openHoldsPort<unknown>(NOTHING_OPEN_AT, openHoldsOn(safetyWorldOf(), reads as never[]));
    expect(await port(commitContextOf(request))).toEqual({ holds: [], unreadEventIds: [] });

    // With no record among the core actions, the turn's own text is named, and with no safety row it is unread.
    const bare = structuredClone(request);
    bare.core = [];
    const unread = await port(commitContextOf(bare));
    expect(unread).toEqual({ holds: [], unreadEventIds: ["evt-sam-s1-01"] });
    expect(reads.map((read) => read.request)).toEqual([
      { handleId: "handle-sam", businessId: BARBERSHOP, eventIds: [] },
      { handleId: "handle-sam", businessId: BARBERSHOP, eventIds: ["evt-sam-s1-01"] },
    ]);
  });

  it("joins the actor's holds: a recorded one by its id and rule, one with no id or still unread as an unread text", async () => {
    const at: CommitAt = {
      holds: [
        {
          eventId: "evt-a",
          holdId: "hold-a",
          rule: "after_safe",
          outcomes: ["Crisis words"],
          blocksBooking: false,
        },
        {
          eventId: "evt-b",
          holdId: null,
          rule: "never",
          outcomes: ["A threat to staff or others"],
          blocksBooking: true,
        },
        { eventId: "evt-c", holdId: "hold-c", rule: "unread", outcomes: [], blocksBooking: false },
      ],
      unread: ["evt-d"],
    };
    const reads: { request: { eventIds: readonly string[] } }[] = [];
    const port = openHoldsPort<unknown>(at, openHoldsOn(safetyWorldOf(), reads as never[]));
    expect(await port(commitContextOf(request))).toEqual({
      holds: [{ holdId: "hold-a", releaseRule: "after_safe", blocksBooking: false }],
      unreadEventIds: ["evt-d", "evt-b", "evt-c"],
    });
    expect(reads.map((read) => read.request.eventIds)).toEqual([["evt-d"]]);
  });

  it("keeps the runtime's unread ids whole, even one the read finds a safety row for (DL-133)", async () => {
    // K-34's crisis seed records evt-alex-0201's outcome under the barbershop: the read would not call it unread.
    const world = safetyWorldOf(["db-schema/safety-incidents/fixtures/seed-outcome-crisis.json"]);
    const recordedId = world.safety.outcomes[0]?.eventId;
    if (recordedId === undefined) throw new Error("the seed records a text");
    const port = openHoldsPort<unknown>({ holds: [], unread: [recordedId] }, openHoldsOn(world));
    const open = await port(commitContextOf(request));
    expect(open.unreadEventIds).toEqual([recordedId]);
  });

  it("a read that answers an error fails the commit closed, never read as nothing open", async () => {
    const port = openHoldsPort<unknown>(NOTHING_OPEN_AT, () =>
      Promise.resolve({ error: "notFound", table: "businesses", rowId: BARBERSHOP }),
    );
    await expect(port(commitContextOf(request))).rejects.toMatchObject({
      name: "TurnFaceReadError",
      read: "readOpenHolds",
      code: "notFound",
    });
  });
});

/** One text of the turn as decide reads it (K-02 v1.1 context.texts). */
type DecidedText = Decided["context"]["texts"][number];

/** Sam's text of turn 1 (commit-s1-01.json): the event the safety record in its core actions names. */
const SAM_TEXT = "evt-sam-s1-01";

/**
 * Sam's tapback in the batch of his first text (T-1266): a like on one of Rosie's messages, in K-06 v1
 * reaction-from-customer.json's form, as the turn hands it to decide (runtime/src/turn/turn.ts turnTextOf: a reaction is
 * a K-02 tapback named by its reaction). It has no words: the safety read never reads it (runtime/src/safety/arrival.ts
 * READ_KINDS), so K-34 never holds an outcome row for it (0016: one row per read text).
 */
const SAM_TAPBACK: DecidedText = {
  eventId: "evt-sam-s1-01-like",
  kind: "tapback",
  words: "like",
  sentAt: { utc: "2026-10-19T18:05:02Z", zone: "America/New_York" },
  attachments: [],
  poll: null,
  tapback: { reaction: "like", onMessageId: "linq-msg-demo-0001" },
};

/**
 * The request with these texts joining its turn after its own, in arrival order: decide's texts, and each new event once
 * among the turn's event ids.
 */
function joining(request: GateAndCommitRequest, ...texts: DecidedText[]): GateAndCommitRequest {
  const next = structuredClone(request);
  if (next.turn === null || next.input.kind !== "decided") throw new Error("turn 1 decides its texts");
  const { decided } = next.input;
  const own = next.turn.eventIds;
  const added = texts
    .map((text) => text.eventId)
    .filter((id, at, ids) => !own.includes(id) && ids.indexOf(id) === at);
  return {
    ...next,
    turn: { ...next.turn, eventIds: [...own, ...added] },
    input: {
      ...next.input,
      decided: { ...decided, context: { ...decided.context, texts: [...decided.context.texts, ...texts] } },
    },
  };
}

describe("a turn with a customer's tapback: the texts not read are only those the safety read reads (T-1266)", () => {
  it("Sam's text with its record and his tapback commit as turn 1 does: the tapback is never named among the texts not read, so the routine part is not held", async () => {
    const exchange = commitS101();
    const doubles = callDoubles();
    const request = joining(commitRequestAfter(undefined), SAM_TAPBACK);
    const result = committed((await commitThrough(doubles.calls, request)).answer);

    // What the commit named to readOpenHolds, and what it answered for S1-01's door (a routine part). Naming the tapback,
    // which no K-34 row can ever call read, held every routine part of the turn.
    expect({
      named: doubles.openHoldsReads.map((read) => read.request.eventIds),
      parts: result.parts.map((part) => part.result),
    }).toEqual({ named: [[]], parts: ["committed"] });
    // Every field as commit-s1-01.json states it: the tapback changes nothing that commits.
    expect(result).toEqual(exchange.outcome);

    // One K-05 commit: its turn row names both events, and it writes the record, the thread, the question and the row.
    expect(doubles.k05.requests).toHaveLength(1);
    const [sent] = doubles.k05.requests;
    expect(sent?.turn.eventIds).toEqual([SAM_TEXT, SAM_TAPBACK.eventId]);
    expect(sent?.writes.outboxRows.map((row) => row.id)).toEqual(["outbox-s1-02-sam-1"]);
    expect(doubles.k05.commits).toEqual([
      {
        turnId: "turn-s1-01-sam",
        written: [
          { table: "safety_outcomes", rowId: "safety-outcome-sam-s1-01", version: 1 },
          ...exchange.outcome.written.written,
        ],
      },
    ]);
  });

  it("Sam's text whose record is missing still holds every routine part beside his tapback: the text is named and unread, and nothing of the part is written", async () => {
    const doubles = callDoubles();
    const request: GateAndCommitRequest = {
      ...joining(commitRequestAfter(undefined), SAM_TAPBACK),
      core: [],
    };
    const result = committed((await commitThrough(doubles.calls, request)).answer);
    expect(result.parts).toEqual([expect.objectContaining({ part: 0, result: "held", gives: [] })]);
    const [read] = doubles.openHoldsReads;
    expect(read?.request.eventIds).toContain(SAM_TEXT);
    const [sent] = doubles.k05.requests;
    expect(sent?.writes.state).toEqual([]);
    expect(sent?.writes.outboxRows).toEqual([]);
    expect(sent?.writes.openQuestions.open).toEqual([]);
  });

  it("openHolds names the turn's texts the safety read reads, never a tapback: with the record nothing is named; without it Sam's text alone, unread", async () => {
    const request = joining(commitRequestAfter(undefined), SAM_TAPBACK);
    const reads: OpenHoldsRead[] = [];
    const port = openHoldsPort<unknown>(NOTHING_OPEN_AT, openHoldsOn(safetyWorldOf(), reads));
    expect(await port(commitContextOf(request))).toEqual({ holds: [], unreadEventIds: [] });
    expect(await port(commitContextOf({ ...request, core: [] }))).toEqual({
      holds: [],
      unreadEventIds: [SAM_TEXT],
    });
    expect(reads.map((read) => read.request.eventIds)).toEqual([[], [SAM_TEXT]]);
  });

  it("an event is left out only when decide's texts name it as a tapback and as nothing else: a vote, an event decide does not hold and every event of a core-only turn stay named (fail closed)", async () => {
    const vote: DecidedText = {
      eventId: "evt-sam-s1-01-vote",
      kind: "pollVote",
      words: "Barber",
      sentAt: { utc: "2026-10-19T18:05:03Z", zone: "America/New_York" },
      attachments: [],
      poll: { pollId: "linq-poll-demo-0001", optionId: "linq-option-demo-0001" },
      tapback: null,
    };
    // One event that decide's texts name twice, as a tapback and as a text: they do not agree that it is only a tapback.
    const twice: DecidedText = {
      ...SAM_TAPBACK,
      eventId: "evt-sam-s1-01-twice",
      kind: "text",
      words: "like",
      tapback: null,
    };
    const asTapback: DecidedText = { ...SAM_TAPBACK, eventId: twice.eventId };
    const decided = joining(commitRequestAfter(undefined), SAM_TAPBACK, vote, asTapback, twice);
    // A STOP beside the decided texts is a keyword text, which decide never reads: its event is in the turn alone.
    const stop = "evt-sam-s1-01-stop";
    if (decided.turn === null) throw new Error("turn 1 carries its turn");
    const withStop: GateAndCommitRequest = {
      ...decided,
      turn: { ...decided.turn, eventIds: [...decided.turn.eventIds, stop] },
    };
    const reads: OpenHoldsRead[] = [];
    const port = openHoldsPort<unknown>(NOTHING_OPEN_AT, openHoldsOn(safetyWorldOf(), reads));
    const named = [vote.eventId, twice.eventId, stop];
    expect(await port(commitContextOf(withStop))).toEqual({ holds: [], unreadEventIds: named });

    // A core-only turn carries no texts of decide's, so nothing tells a tapback from a text with no record: it is named.
    const coreOnly: GateAndCommitRequest = { ...withStop, input: { kind: "coreOnly" } };
    expect(await port(commitContextOf(coreOnly))).toEqual({
      holds: [],
      unreadEventIds: [SAM_TAPBACK.eventId, ...named],
    });
    expect(reads.map((read) => read.request.eventIds)).toEqual([named, [SAM_TAPBACK.eventId, ...named]]);
  });

  it("the runtime's unread ids are kept whole, a tapback's included (DL-133): any unread id holds", async () => {
    const request = joining(commitRequestAfter(undefined), SAM_TAPBACK);
    const at: CommitAt = { holds: [], unread: [SAM_TAPBACK.eventId] };
    const reads: OpenHoldsRead[] = [];
    const port = openHoldsPort<unknown>(at, openHoldsOn(safetyWorldOf(), reads));
    expect(await port(commitContextOf(request))).toEqual({
      holds: [],
      unreadEventIds: [SAM_TAPBACK.eventId],
    });
    expect(reads.map((read) => read.request.eventIds)).toEqual([[SAM_TAPBACK.eventId]]);
  });
});

describe("runCore's safety reader over K-05 v1.4 (DL-348, DL-352)", () => {
  it("each read names the call's own business; arrivedAt is null until T-1155", async () => {
    const seen: { read: string; businessId: string }[] = [];
    const reader = safetyReaderOf(safetyReadsOn(safetyWorldOf(), seen), { name: "repo" }, BARBERSHOP);
    expect(await reader.outcomeOfEvent("evt-sam-s1-01")).toBeNull();
    expect(await reader.holdOfOutcome("safety-outcome-sam-s1-01")).toBeNull();
    expect(await reader.outboxRowWritten("outbox-s1-02-sam-1")).toBe(false);
    expect(await reader.businessZone(BARBERSHOP)).toBe("America/New_York");
    expect(await reader.ownerOf(BARBERSHOP)).toBeNull();
    expect(await reader.arrivedAt("evt-sam-s1-01")).toBeNull();
    expect(seen.every((read) => read.businessId === BARBERSHOP)).toBe(true);
  });

  it("notFound, moreThanOneOwner and transient are thrown, never read as none; another business is never read", async () => {
    const refusing = (error: Json): SafetyReads<unknown> => {
      const answer = () => Promise.resolve(error as never);
      return {
        outcomeOfEvent: answer,
        outcome: answer,
        hold: answer,
        holdOfOutcome: answer,
        outboxRowWritten: answer,
        businessZone: answer,
        businessOwner: answer,
      };
    };
    for (const error of [
      { error: "notFound", table: "businesses", rowId: BARBERSHOP },
      { error: "transient", sqlstate: "40001" },
    ]) {
      const reader = safetyReaderOf(refusing(error), {}, BARBERSHOP);
      for (const read of [
        reader.outcomeOfEvent("evt-sam-s1-01"),
        reader.outcome("safety-outcome-sam-s1-01"),
        reader.hold("hold-x"),
        reader.holdOfOutcome("safety-outcome-sam-s1-01"),
        reader.outboxRowWritten("outbox-s1-02-sam-1"),
        reader.businessZone(BARBERSHOP),
        reader.ownerOf(BARBERSHOP),
      ]) {
        await expect(read).rejects.toMatchObject({ name: "TurnFaceReadError", code: error.error });
      }
    }
    const owners = safetyReaderOf(
      refusing({ error: "moreThanOneOwner", businessId: BARBERSHOP }),
      {},
      BARBERSHOP,
    );
    await expect(owners.ownerOf(BARBERSHOP)).rejects.toBeInstanceOf(TurnFaceReadError);
    const reader = safetyReaderOf(safetyReadsOn(safetyWorldOf()), {}, BARBERSHOP);
    await expect(reader.ownerOf("biz-yoga-studio")).rejects.toMatchObject({ code: "otherBusiness" });
    await expect(reader.businessZone("biz-yoga-studio")).rejects.toMatchObject({ code: "otherBusiness" });
  });
});

describe("the pinned bundle's checked lines and limit 1's step cards (STATE note 65)", () => {
  it("bundle v0's lines: K-01's crisis, emergency and outage lines to the writer, and none for No", async () => {
    const lines = await pinnedSafetyLines(bundleV0(), BUNDLE_V0);
    const writer = (fixedLineId: string) => ({ fixedLineId, to: "writer", hotline: null });
    expect(lines.lineOf("No", [])).toBeNull();
    expect(lines.lineOf("Crisis words", ["selfHarm"])).toEqual(writer("safetyCrisis"));
    expect(lines.lineOf("An emergency", [])).toEqual(writer("safetyEmergency"));
    expect(lines.lineOf("Unsure", ["selfHarm"])).toEqual(writer("safetyCrisis"));
    expect(lines.lineOf("Unsure", ["other"])).toEqual(writer("safetyEmergency"));
    expect(lines.lineOf("A threat to staff or others", [])).toBeNull();
    expect(lines.outageLine()).toBe("outage");
  });

  it("a bundle that holds a safety step answers notBuilt for a danger line; a bundle neither KV nor PostgreSQL holds is refused", async () => {
    const withSafetyStep = withSteps(sampleBundle("bundle-v0-skeleton.json"), [
      { id: "A3-24", who: "san", via: "msg", title: "Sends the 911 safety message", next: null },
    ]);
    const lines = await pinnedSafetyLines(fakeBundles(withSafetyStep), BUNDLE_V0);
    expect(lines.lineOf("No", [])).toBeNull();
    expect(() => lines.lineOf("An emergency", [])).toThrow(NotBuiltError);
    await expect(pinnedSafetyLines(fakeBundles(), { hash: BUNDLE_V0.hash, build: 9 })).rejects.toBeInstanceOf(
      TurnFaceRefusedError,
    );
  });

  it("limit 1 reads S1-02's card from bundle v0, and no card from a bundle it cannot read", async () => {
    const cards = bundleStepCards(bundleV0())(BUNDLE_V0, "A");
    expect(await cards.step("S1-02")).toMatchObject({ id: "S1-02", section: 1, who: "san", to: "owner" });
    expect(await cards.step("A3-24")).toBeNull();
    expect(await bundleStepCards(fakeBundles())(BUNDLE_V0, "A").step("S1-02")).toBeNull();
  });
});

// ---- T-1505: the asked turn's question read ------------------------------------------------------------------------------

describe("the commit is handed the walk's question read and turn key for an asked turn, only where the read is bound (T-1505; K-09 v1.12)", () => {
  const never = (): Promise<never> => Promise.reject(new Error("nothing is read or written here"));
  /** A binding whose ports are never called here: building the deps reads nothing. */
  function bindingOf(extra: Partial<TurnCommitBinding<unknown>> = {}): TurnCommitBinding<unknown> {
    return {
      bundles: bundleV0(),
      commitTurn: never,
      readOpenHolds: never,
      safetyReads: safetyReadsOn(safetyWorldOf()),
      sealer: { seal: never },
      stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
      telling: NOT_TOLD_YET,
      ...extra,
    };
  }
  const questions: WalkQuestions = { liveQuestion: () => Promise.resolve(null) };

  it("with the question read bound: the same read and the binding's turn key, or the turn's own id when it names none", () => {
    const keyed = turnCommitDeps(bindingOf({ questions, turnKey: () => SAM_KEY }))(NOTHING_OPEN_AT);
    expect(keyed.askAgain?.questions).toBe(questions);
    expect(keyed.askAgain?.turnKey?.(commitContextOf(commitS101().request).turn)).toBe(SAM_KEY);
    const unkeyed = turnCommitDeps(bindingOf({ questions }))(NOTHING_OPEN_AT);
    expect(unkeyed.askAgain?.questions).toBe(questions);
    expect(unkeyed.askAgain !== undefined && Object.hasOwn(unkeyed.askAgain, "turnKey")).toBe(false);
  });

  it("with no question read bound, and in the keyword door's commit whatever its binding carries: none, so an asked turn writes nothing", () => {
    expect(Object.hasOwn(turnCommitDeps(bindingOf())(NOTHING_OPEN_AT), "askAgain")).toBe(false);
    // The door's binding, carrying a question read all the same: K-05 v1.4's record reads in their no-business forms.
    const doorBinding = {
      ...bindingOf({ questions }),
      safetyReads: {
        outcomeOfEvent: never,
        outcome: never,
        hold: never,
        holdOfOutcome: never,
        outboxRowWritten: never,
      },
    };
    expect(doorBinding.questions).toBe(questions);
    const door = keywordCommitDeps(doorBinding, {} as CoreFlagsDeps<unknown>)(NOTHING_OPEN_AT);
    expect(Object.hasOwn(door, "askAgain")).toBe(false);
  });
});

// ---- T-1493: the one-kind path on the turn face's binding ----------------------------------------------------------------

describe("signUpSteps with the one-kind path: S1-04's settler and S1-08's writer, bound from the deps handed in (T-1493, H1a)", () => {
  const never = (): Promise<never> => Promise.reject(new Error("nothing is read or written here"));

  /**
   * Which of the new deps a case hands in: the companies reads, and S1-08's deps with or without the stop reads; and
   * whether the kinds deps carry the stop reads S1-03's message is ruled with (T-1520's case walks S1-03).
   */
  interface NewDeps {
    readonly companies?: boolean;
    readonly plan?: "withStop" | "noStop";
    readonly kindsStop?: boolean;
  }

  /** The sign-up steps' deps over the doubles (items 78 and 79, item 72 and the catalog, the stop home, bundle v2's overlays). */
  function signUpOver(given: NewDeps = {}) {
    const k05 = fakeK05();
    const companies = fakeCompaniesK05();
    const trades = tradesOverV2();
    const stop = readsOn(seedWorld(), null);
    const deps: SignUpWriterDeps = {
      kinds: { reads: kindsReadsOf(k05.k05), ...(given.kindsStop === true ? { stop } : {}) },
      plugIns: { bundles: trades.bundles },
      ...(given.companies === true ? { companies: companiesReadsOf(companies.k05) } : {}),
      ...(given.plan === undefined ? {} : { plan: given.plan === "withStop" ? { stop } : {} }),
    };
    return { deps, k05, companies, trades };
  }

  /** The turn face's binding over `deps` on bundle v2, its ports never called but the walk's, the sign-up steps spread in. */
  function bindingOver(deps: SignUpWriterDeps): TurnCommitBinding<unknown> {
    return {
      bundles: fakeBundles(publishedBundleV2()),
      commitTurn: never,
      readOpenHolds: never,
      safetyReads: safetyReadsOn(safetyWorldOf()),
      sealer: { seal: never },
      stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
      telling: NOT_TOLD_YET,
      turnKey: () => SAM_KEY,
      questions: questionsOver().questions,
      ...signUpSteps<unknown>(deps),
    };
  }

  /**
   * What the walk turnCommitDeps hands writesOf answers for turn 2 choosing `choiceId` (default c-01, "All on the list")
   * with `words`, pinned to bundle v2.
   */
  async function walked(deps: SignUpWriterDeps, words: string, choiceId = "c-01") {
    const turn = turnWithWords(choiceId, words);
    const context = { ...turn.context, turn: { ...turn.context.turn, bundleId: bundleV2Id() } };
    return turnCommitDeps(bindingOver(deps))(NOTHING_OPEN_AT).ports.writesOf(
      turn.part,
      context,
      NOTHING_OPEN,
    );
  }

  it("with neither new dep the object is today's, field for field: writers and settlers alone, no buttons settler, no writer at S1-08", () => {
    const { deps, k05, trades } = signUpOver();
    const steps = signUpSteps<unknown>(deps);
    expect(Object.keys(steps).sort()).toEqual(["settlers", "writers"]);
    expect(steps.writers("S1-08")).toBeNull();
    expect(steps.settlers("S1-04")).toBeNull();
    // A binding that spreads it carries no buttonsSettlers field, so the walk is handed none.
    expect(Object.hasOwn(bindingOver(deps), "buttonsSettlers")).toBe(false);
    expect(k05.asked).toEqual([]);
    expect(trades.reads).toEqual([]);
  });

  it("with the companies reads and S1-08's deps: S1-04's buttons settler alone, S1-08's writer, S1-02's settler and the other writers as before; building them reads nothing", () => {
    const { deps, k05, companies, trades } = signUpOver({ companies: true, plan: "withStop" });
    const steps = signUpSteps<unknown>(deps);
    expect(Object.keys(steps).sort()).toEqual(["buttonsSettlers", "settlers", "writers"]);
    expect(typeof steps.buttonsSettlers?.("S1-04")).toBe("function");
    for (const stepId of ["S1-02", "S1-08", "S1-09", "s1-04", "", "constructor", "__proto__"]) {
      expect(steps.buttonsSettlers?.(stepId), stepId).toBeNull();
    }
    for (const stepId of ["S1-02", "S1-03", "S1-74", "S1-11", "S1-08"]) {
      expect(typeof steps.writers(stepId), stepId).toBe("function");
    }
    for (const stepId of ["S1-01", "S1-04", "S1-09", "toString", "__proto__"]) {
      expect(steps.writers(stepId), stepId).toBeNull();
    }
    expect(typeof steps.settlers("S1-02")).toBe("function");
    expect(steps.settlers("S1-04")).toBeNull();
    expect(Object.hasOwn(bindingOver(deps), "buttonsSettlers")).toBe(true);
    expect(k05.asked).toEqual([]);
    expect(companies.asked).toEqual([]);
    expect(trades.reads).toEqual([]);
  });

  it("each new dep binds its own piece: the companies reads alone give S1-04's settler and no S1-08 writer; S1-08's deps alone give its writer and no buttons settler", () => {
    const companiesOnly = signUpSteps<unknown>(signUpOver({ companies: true }).deps);
    expect(typeof companiesOnly.buttonsSettlers?.("S1-04")).toBe("function");
    expect(companiesOnly.writers("S1-08")).toBeNull();
    const planOnly = signUpSteps<unknown>(signUpOver({ plan: "withStop" }).deps);
    expect(Object.hasOwn(planOnly, "buttonsSettlers")).toBe(false);
    expect(typeof planOnly.writers("S1-08")).toBe("function");
  });

  it("the walk turnCommitDeps hands writesOf: 'Plumbing' walks S1-04 without asking it, the one pick placed with its company kind first, S1-11's blocks under the business, S1-08's row, then S1-09's question", async () => {
    const { deps, companies } = signUpOver({ companies: true, plan: "withStop" });
    const writes = await walked(deps, "Plumbing");
    expect(writes.closes.map((close) => [close.id, close.status])).toEqual([["oq-s1-02", "answered"]]);
    expect(writes.state.map((write) => `${write.op} ${write.table}`)).toEqual([
      "insert company_kinds",
      "insert picked_kinds",
      ...PF_TEXT_KEYS.map(() => "insert picked_kind_texts"),
    ]);
    const plumber = catalogDefaults("plumber");
    const [kind, pick, ...texts] = writes.state;
    expect(kind).toEqual({
      op: "insert",
      table: "company_kinds",
      values: {
        company_id: SAM_COMPANY,
        kind_id: "plumber",
        business_id: BARBERSHOP,
        trade_name: null,
        pf_facts: plumber.facts,
        pf_switches_a: plumber.switchesA,
        pf_switches_b: plumber.switchesB,
      },
    });
    expect(pick).toMatchObject({
      op: "insert",
      table: "picked_kinds",
      values: {
        id: "pick-s1-02-sam-1",
        kind_id: "plumber",
        outcome: "listed",
        company_id: SAM_COMPANY,
        business_id: BARBERSHOP,
      },
    });
    for (const text of texts) {
      expect(text).toMatchObject({ values: { picked_kind_id: "pick-s1-02-sam-1", business_id: BARBERSHOP } });
    }
    // No S1-04 question: S1-09's alone, and two rows, S1-08's (no question) then S1-09's, each with its step and line 0.
    expect(writes.asks.map((ask) => [ask.question.id, ask.question.step])).toEqual([
      ["oq-s1-09-sam-1", "S1-09"],
    ]);
    expect(
      writes.messages.map((row) => [row.id, row.step, row.lineNo, row.openQuestionId, row.sendClass]),
    ).toEqual([
      ["outbox-s1-08-sam-1", "S1-08", 0, null, "quick_reply"],
      ["outbox-s1-09-sam-1", "S1-09", 0, "oq-s1-09-sam-1", "quick_reply"],
    ]);
    expect(writes.gives).toEqual([...commitS1_02().given.stated.gives, "companies"]);
    // The one-kind pieces read item 79 once for the walk, item 72 once and the catalog once, each for Sam at his business.
    expect(companies.asked.map((asked) => asked.read)).toEqual([
      "readPickedKinds",
      "readBusinessKinds",
      "readTurnState",
    ]);
  });

  it("'Barbershop, plumbing, electrical' still asks S1-04 with the one-kind path bound, its picks unplaced, as without it; and without the companies reads 'Plumbing' asks S1-04 as today", async () => {
    const bound = await walked(
      signUpOver({ companies: true, plan: "withStop" }).deps,
      "Barbershop, plumbing, electrical",
    );
    const today = await walked(signUpOver().deps, "Barbershop, plumbing, electrical");
    expect(bound.asks.map((ask) => ask.question.step)).toEqual(["S1-04"]);
    expect(bound).toEqual(today);
    expect(
      bound.state.flatMap((write) =>
        write.op === "insert" && write.table === "picked_kinds"
          ? [[write.values.company_id, write.values.business_id]]
          : [],
      ),
    ).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
    const plumbingToday = await walked(signUpOver({ plan: "withStop" }).deps, "Plumbing");
    expect(plumbingToday.asks.map((ask) => ask.question.step)).toEqual(["S1-04"]);
    expect(plumbingToday.messages.map((row) => row.step)).toEqual(["S1-04"]);
  });

  it("S1-03 bound through the same instance's draft wrapper (T-1520): a one-kind 'One isn't on the list yet' drafts under the pick's business; without the companies reads, with no business, as today", async () => {
    const draftsOf = (writes: Awaited<ReturnType<typeof walked>>): unknown[][] =>
      writes.state.flatMap((write) =>
        write.op === "insert" && write.table === "new_work_drafts"
          ? [[write.values.picked_kind_id, write.values.business_id]]
          : [],
      );
    const bound = await walked(
      signUpOver({ companies: true, plan: "withStop", kindsStop: true }).deps,
      PACK_HIKES,
      "c-02",
    );
    expect(bound.asks.map((ask) => ask.question.step)).toEqual(["S1-09"]);
    expect(
      bound.state.flatMap((write) =>
        write.op === "insert" && write.table === "picked_kinds"
          ? [[write.values.id, write.values.company_id, write.values.business_id]]
          : [],
      ),
    ).toEqual([["pick-s1-02-sam-1", SAM_COMPANY, BARBERSHOP]]);
    expect(draftsOf(bound)).toEqual([["pick-s1-02-sam-1", BARBERSHOP]]);
    expect(bound.messages.map((row) => row.step)).toEqual(["S1-03", "S1-08", "S1-09"]);
    const today = await walked(signUpOver({ plan: "withStop", kindsStop: true }).deps, PACK_HIKES, "c-02");
    expect(today.asks.map((ask) => ask.question.step)).toEqual(["S1-04"]);
    expect(draftsOf(today)).toEqual([["pick-s1-02-sam-1", null]]);
  });

  it("with S1-08's stop reads left out, 'Plumbing' is refused with nothing returned: no S1-08 deps (no writer at S1-08) or S1-08's deps without the stop reads (stopNotWired)", async () => {
    await expect(walked(signUpOver({ companies: true }).deps, "Plumbing")).rejects.toBeInstanceOf(
      WalkNotBuiltError,
    );
    const noStop = walked(signUpOver({ companies: true, plan: "noStop" }).deps, "Plumbing");
    await expect(noStop).rejects.toBeInstanceOf(PlanNotBuiltError);
    await expect(noStop).rejects.toMatchObject({ seam: "stopNotWired", ids: ["S1-08"] });
  });

  it("the keyword door's commit hands the walk no buttons settler, whatever its binding object carries", async () => {
    const { deps, companies } = signUpOver({ companies: true, plan: "withStop" });
    const binding = bindingOver(deps);
    expect(Object.hasOwn(binding, "buttonsSettlers")).toBe(true);
    const doorBinding = {
      ...binding,
      safetyReads: {
        outcomeOfEvent: never,
        outcome: never,
        hold: never,
        holdOfOutcome: never,
        outboxRowWritten: never,
      },
    };
    const door = keywordCommitDeps(doorBinding, {} as CoreFlagsDeps<unknown>)(NOTHING_OPEN_AT);
    const turn = turnWithWords("c-01", "Plumbing");
    const context = { ...turn.context, turn: { ...turn.context.turn, bundleId: bundleV2Id() } };
    await expect(door.ports.writesOf(turn.part, context, NOTHING_OPEN)).rejects.toBeInstanceOf(
      WalkNotBuiltError,
    );
    expect(companies.asked).toEqual([]);
  });
});
