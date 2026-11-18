// T-1443's unit proofs at the turn face (no database): the Tool API base the face builds carries the paging service's six
// calls made alone (domain/paging pagingHandlers) when its calls carry the paging ports, and the face's commit binding
// takes the paging telling port (commit/core pagingTellingPort) and the paging port (TurnCommitBinding.telling and
// .paging), with NOT_TOLD_YET and no paging port, the defaults, answering as before. K-05's calls are doubles in K-05's
// shapes (calls-test-support.ts); T-319's in-memory paging world and reader stand in for the runtime's PagingReader
// (T-1444) and a recording double for K-05's commit with no turn (CQ-44); nothing under test is stood in for. Values come
// only from the contracts' fixtures and the master's sample cast, every recipient by handle id (rule 9).

import { describe, expect, it } from "vitest";

import type { GateAndCommitRequest } from "../../commit";
import { pagingTellingPort } from "../../commit/core";
import { PagingRefusedError, type PagingDeps } from "../../domain/paging";
import {
  SAM,
  fixture,
  fixturePagingIds,
  pagingWorld,
  readerOn,
  type PagingWorld,
} from "../../domain/paging/test-support";
import { NO_ALONE_COMMIT, type AloneCommit, type AloneCommitRequest } from "../../domain/flags";
import { contractJson } from "../../domain/messages-consent/test-support";
import type { SafetyResult } from "../../domain/safety";
import { BARBERSHOP } from "../../domain/safety/test-support";
import { traceFor } from "../test-support";
import { createToolApi, type ToolApi } from "../tool-api";
import { createToolApiValidator } from "../validator";
import { bundleV0, callDoubles, commitRequestAfter, type CallDoublesOptions } from "./calls-test-support";
import { NOTHING_OPEN_AT } from "./commit";
import { callHandlers, createTurnFace, type GateAndCommitCallAnswer } from "./turn-face";

type Json = Record<string, unknown>;

const validator = createToolApiValidator();

/** What the owner hears of crisis words, and all they hear (master A3-25; K-36 hand_offs.summary; DL-930). */
const URGENT_LINE = "Urgent: a customer may need help";

interface Exchange {
  readonly given: { readonly now: string };
  readonly request: Json & { readonly caller: Json };
  readonly outcome: Json;
}

/** K-09 v1's page-team.json: the team paged for Alex's threat, its hand-off unanswered after 5 minutes. */
const pageTeamExchange = (): Exchange => fixture("tool-api/fixtures/page-team.json") as Exchange;

/** The ids page-team.json names (domain/paging's test of it names the same). */
const PAGE_TEAM_IDS = {
  "page|hand_off:handoff-alex-threat|": "page-alex-threat",
  "pageRow|page-alex-threat|1/person-rosie-team-1": "out-page-alex-threat-team-1",
  "pageRow|page-alex-threat|1/person-rosie-team-2": "out-page-alex-threat-team-2",
  "pageRow|page-alex-threat|1/person-pat": "out-page-alex-threat-pat",
  "pageClock|page-alex-threat|2": "clock-page-alex-threat-2",
};

/** Alex's threat hand-off at the barbershop, told to Sam at 14:42:00Z, its escalation clock armed (page-team.json's). */
function threatWorld(): PagingWorld {
  const world = pagingWorld();
  world.handOffs.set("handoff-alex-threat", {
    id: "handoff-alex-threat",
    businessId: BARBERSHOP,
    kind: "threat",
    safetyOutcomeId: "safety-outcome-alex-0204",
    turnId: "turn-alex-threat",
    bookingId: "booking-alex-riley-nov14",
    aboutPersonId: "person-alex",
    toldPersonId: SAM,
    toldAs: "owner",
    alertOutboxRowId: "out-alert-handoff-alex-threat",
    handedAt: "2026-10-23T14:42:00Z",
    escalateAt: "2026-10-23T14:47:00Z",
    escalationClockRowId: "clock-handoff-alex-threat",
    answeredAt: null,
    answeredVia: null,
    answeredByPersonId: null,
    escalatedAt: null,
    version: 1,
  });
  world.clocks.set("clock-handoff-alex-threat", {
    id: "clock-handoff-alex-threat",
    state: "armed",
    version: 1,
    dueAt: "2026-10-23T14:47:00Z",
  });
  return world;
}

/** A commit with no turn that records each request it is asked to commit, and commits it (K-05 open gap: CQ-44). */
function recordingCommit(): {
  readonly committed: AloneCommitRequest[];
  readonly commitAlone: AloneCommit<unknown>;
} {
  const committed: AloneCommitRequest[] = [];
  return {
    committed,
    commitAlone: {
      commit(request) {
        committed.push(request);
        return Promise.resolve({ committed: true, repeated: false });
      },
    },
  };
}

/** The face's own handlers for the calls after the frontier, on a base called as any other caller calls it. */
function baseOver(options: CallDoublesOptions): ToolApi {
  const { calls } = callDoubles(options);
  return createToolApi<unknown>({ validator, scope: calls.scope, handlers: callHandlers(calls, null) });
}

describe("the Tool API base carries the paging service's handlers (T-1443; domain/paging pagingHandlers)", () => {
  it("with the paging ports bound, pageTeam made alone answers page-team.json's outcome and commits once under its key", async () => {
    const exchange = pageTeamExchange();
    const { committed, commitAlone } = recordingCommit();
    const paging: PagingDeps<unknown> = {
      reader: () => readerOn(threatWorld()),
      ids: fixturePagingIds(PAGE_TEAM_IDS),
      environment: "production",
      now: () => exchange.given.now,
      commitAlone,
    };
    const request = structuredClone(exchange.request);
    const answer = await baseOver({ paging }).call("pageTeam", request, traceFor(request).trace);
    expect(answer).toEqual(exchange.outcome);
    expect(committed.map((each) => each.key)).toEqual([
      `pageTeam:${String(exchange.request.caller.requestId)}`,
    ]);
    expect(committed[0]?.writes.outboxRows.map((row) => row.recipientHandleId)).toEqual([
      "handle-team-1",
      "handle-team-2",
      "handle-pat",
    ]);
  });

  it("every one of the six is the paging service's: a console's acknowledgement of a page that is not there answers its notFound", async () => {
    const { commitAlone } = recordingCommit();
    const base = baseOver({ paging: { reader: () => readerOn(pagingWorld()), commitAlone } });
    const request = {
      caller: {
        kind: "console",
        turnId: null,
        requestId: "req-t1443-ack",
        businessId: BARBERSHOP,
        personId: "person-rosie-team-1",
        traceId: "trace-t1443-ack",
      },
      pageId: "page-none",
      expectVersion: 1,
      via: "console_tap",
    };
    expect(await base.call("acknowledgePage", request, traceFor(request).trace)).toEqual({
      error: "notFound",
      table: "team_pages",
      rowId: "page-none",
    });
    const handlers = callHandlers(callDoubles({ paging: {} }).calls, null);
    const stubs = callHandlers(callDoubles().calls, null);
    for (const call of [
      "pageTeam",
      "acknowledgePage",
      "handOff",
      "answerHandOff",
      "openReviewItem",
      "decideReviewItem",
    ] as const) {
      expect(handlers[call], call).not.toBe(stubs[call]);
    }
  });

  it("with no paging ports each answers notBuilt, and with no commit with no turn bound a call made alone answers notBuilt too", async () => {
    const exchange = pageTeamExchange();
    const request = structuredClone(exchange.request);
    expect(await baseOver({}).call("pageTeam", request, traceFor(request).trace)).toEqual({
      error: "notBuilt",
      call: "pageTeam",
    });
    const paging: PagingDeps<unknown> = {
      reader: () => readerOn(threatWorld()),
      environment: "production",
      now: () => exchange.given.now,
      commitAlone: NO_ALONE_COMMIT as AloneCommit<unknown>,
    };
    expect(await baseOver({ paging }).call("pageTeam", request, traceFor(request).trace)).toEqual({
      error: "notBuilt",
      call: "pageTeam",
    });
  });

  it("a turn's own call is never made alone through the base: it rides in its turn's commit (turnRidesInCommit)", async () => {
    const { committed, commitAlone } = recordingCommit();
    const base = baseOver({ paging: { reader: () => readerOn(pagingWorld()), commitAlone } });
    const request = {
      caller: {
        kind: "turn",
        turnId: "turn-t1443-alone",
        requestId: "turn-t1443-alone",
        businessId: BARBERSHOP,
        personId: "person-alex",
        traceId: "trace-t1443-alone",
      },
      kind: "crisis_words",
      about: "other",
      safetyOutcomeId: "safety-outcome-alex-0303",
      bookingId: null,
      aboutPersonId: "person-alex",
      summary: "Alex's text was read.",
    };
    await expect(base.call("handOff", request, traceFor(request).trace)).rejects.toThrow(PagingRefusedError);
    expect(committed).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------------------------

/** A face whose frontier is never called here, over the doubles' calls. */
function faceOver(options: CallDoublesOptions) {
  const doubles = callDoubles(options);
  const face = createTurnFace<never>({
    scope: { withBusiness: () => Promise.reject(new Error("the frontier is not called here")) },
    bundles: bundleV0(),
    validator,
    calls: doubles.calls,
  });
  return { face, doubles };
}

/** commit-s1-01.json's turn with Sam's text read as crisis words (K-02 v1 safety-crisis-words.json, re-keyed to his). */
function crisisTurnOne(): GateAndCommitRequest {
  const request = commitRequestAfter(undefined);
  const safety = structuredClone(contractJson("model/fixtures/safety-crisis-words.json") as SafetyResult);
  const [record] = request.core;
  if (record?.call !== "recordSafetyOutcome") throw new Error("turn 1 carries its record");
  record.request.safety = { ...safety, eventId: record.request.safety.eventId };
  return request;
}

async function commitThrough(
  options: CallDoublesOptions,
  request: GateAndCommitRequest,
): Promise<{ answer: GateAndCommitCallAnswer; doubles: ReturnType<typeof callDoubles> }> {
  const { face, doubles } = faceOver(options);
  const answer = await face.gateAndCommit(structuredClone(request), NOTHING_OPEN_AT, traceFor(request).trace);
  return { answer, doubles };
}

describe("the face's commit binding takes the paging telling port and the paging port (T-1443)", () => {
  it("a crisis-words turn with the port given commits the owner's alert and the team's page rows under the record's business", async () => {
    const telling = pagingTellingPort<unknown>({
      environment: "production",
      reader: () => readerOn(pagingWorld()),
    });
    const { answer, doubles } = await commitThrough({ telling }, crisisTurnOne());
    expect(answer, JSON.stringify(answer)).toMatchObject({ result: "committed", turnId: "turn-s1-01-sam" });
    expect(validator.check("gateAndCommit", "response", answer)).toEqual([]);
    const committed = answer as unknown as { parts: Json[]; core: Json[] };
    // The crisis hold holds S1-01's routine part; the record tells Sam and Rosie's team.
    expect(committed.parts.map((part) => part.result)).toEqual(["held"]);
    expect(committed.core[0]).toMatchObject({
      call: "recordSafetyOutcome",
      response: {
        told: [
          { who: "owner", via: "handOff" },
          { who: "team", via: "teamPage" },
        ],
      },
    });
    const [sent] = doubles.k05.requests;
    if (sent === undefined) throw new Error("one commit was sent");
    const handOff = sent.writes.state.find((write) => write.op === "insert" && write.table === "hand_offs");
    expect(handOff?.op === "insert" ? handOff.values : null).toMatchObject({
      business_id: BARBERSHOP,
      kind: "crisis_words",
      summary: URGENT_LINE,
    });
    expect(
      sent.writes.outboxRows.map((row) => [row.recipientHandleId, row.sendClass, row.businessId]),
    ).toEqual([
      ["handle-sam", "safety", BARBERSHOP],
      ["handle-sam", "safety", BARBERSHOP],
      ["handle-team-1", "safety", BARBERSHOP],
      ["handle-team-2", "safety", BARBERSHOP],
    ]);
  });

  it("on staging the port writes rows to roster test phones alone: Sam's alert and member 2's page wait in the console", async () => {
    const telling = pagingTellingPort<unknown>({
      environment: "staging",
      roster: ["handle-team-1"],
      reader: () => readerOn(pagingWorld()),
    });
    const { answer, doubles } = await commitThrough({ telling }, crisisTurnOne());
    expect(answer).toMatchObject({ result: "committed" });
    const [sent] = doubles.k05.requests;
    // Sam's own line (he wrote the text) first, then member 1's page row; no alert, no row to member 2.
    expect(sent?.writes.outboxRows.map((row) => row.recipientHandleId)).toEqual([
      "handle-sam",
      "handle-team-1",
    ]);
  });

  it("a turn carrying a paging core action commits it through the paging port; with none bound it answers notBuilt", async () => {
    const request = commitRequestAfter(undefined);
    request.core.push({
      call: "handOff",
      request: {
        caller: structuredClone(request.caller),
        kind: "crisis_words",
        about: "other",
        safetyOutcomeId: "safety-outcome-alex-0303",
        bookingId: null,
        aboutPersonId: "person-alex",
        summary: "Alex's text was read.",
      },
    });
    const paging: PagingDeps<unknown> = { reader: () => readerOn(pagingWorld()), environment: "production" };
    const bound = await commitThrough({ paging }, request);
    expect(bound.answer, JSON.stringify(bound.answer)).toMatchObject({ result: "committed" });
    const committed = bound.answer as unknown as { core: Json[] };
    expect(committed.core.map((result) => [result.call, result.error])).toEqual([
      ["recordSafetyOutcome", null],
      ["handOff", null],
    ]);
    const [sent] = bound.doubles.k05.requests;
    expect(sent?.writes.state.map((write) => write.table)).toEqual(
      expect.arrayContaining(["safety_outcomes", "hand_offs", "team_pages"]),
    );

    const unbound = await commitThrough({}, request);
    expect(unbound.answer).toEqual({ error: "notBuilt", call: "gateAndCommit" });
    expect(unbound.doubles.k05.requests).toEqual([]);
  });

  it("with NOT_TOLD_YET, the default, the crisis-words turn answers notBuilt as before, and nothing goes to K-05", async () => {
    const { answer, doubles } = await commitThrough({}, crisisTurnOne());
    expect(answer).toEqual({ error: "notBuilt", call: "gateAndCommit" });
    expect(doubles.k05.requests).toEqual([]);
  });
});
