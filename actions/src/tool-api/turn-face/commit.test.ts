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

import { describe, expect, it } from "vitest";

import type { Span } from "../../../../runtime/src/trace";
import { BARBERSHOP, safetyWorldOf } from "../../domain/safety/test-support";
import { BUNDLE_V0, fakeBundles, sampleBundle, withSteps } from "../../frontier/assemble/test-support";
import { NotBuiltError } from "../errors";
import { traceFor } from "../test-support";
import { createToolApi } from "../tool-api";
import { createToolApiValidator } from "../validator";
import {
  CORE_ROW_IN_WRITTEN,
  bundleV0,
  callDoubles,
  commitContextOf,
  commitRequestAfter,
  commitS101,
  limitOneOnTurnOne,
  openHoldsOn,
  safetyReadsOn,
} from "./calls-test-support";
import {
  NOTHING_OPEN_AT,
  bundleStepCards,
  openHoldsPort,
  pinnedSafetyLines,
  safetyReaderOf,
  type CommitAt,
  type SafetyReads,
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
    // Every field as the fixture states it; `written` too, but for the core action's row main's commit lists first
    // (CORE_ROW_IN_WRITTEN: named, never faked).
    const { written, ...rest } = result as unknown as Json & { written: { written: Json[] } };
    const { written: stated, ...statedRest } = exchange.outcome as unknown as Json & {
      written: { written: Json[]; outboxRows: Json[]; promoted: Json[] };
    };
    expect(rest).toEqual(statedRest);
    expect(written).toEqual({ ...stated, written: [...CORE_ROW_IN_WRITTEN, ...stated.written] });

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
