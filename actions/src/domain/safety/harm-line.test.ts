// T-1162's proofs (the card's "Proves it with"; CQ-164 (c)'s default, DL-344): harm to a child or older adult, with no
// hotline in the pinned bundle, is recorded with its hold and safetyEmergency (911) as its line, as the handle actor's
// direct path sends it (T-1143), and nothing throws, so its turn commits; a bundle that holds A3-49's hotline still uses
// it, and only then is a harm report filed (K-34 v1 harm_reports_child_or_elder_has_hotline). On K-02 v1's
// safety-child-or-elder.json (Alex's report about his mother: the master's sample cast), bundle v0 as its own files hold
// it (T-163, read through T-1140's double), and T-318's in-memory world, never a database. The service's earlier tests
// are safety.test.ts's, unchanged.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type * as K09 from "../../../../contracts/generated/tool-api/tool-api.v1";
import {
  gateAndCommit,
  type CommitPorts,
  type CommitTurnContext,
  type CoreAction,
  type GateAndCommitRequest,
  type OpenHolds,
} from "../../commit";
import { coreSafetyLines, createRunCore } from "../../commit/core";
import { bundleLines, bundleV0, coreDoublesOn } from "../../commit/core/test-support";
import { doublePorts } from "../../commit/test-support";
import { callContext, copy, scriptedLimits } from "../../gate/framework/test-support";
import { createToolApiValidator, type ToolApiValidator } from "../../tool-api";
import { flagsReaderOn, messagesReaderOn, stringsIn } from "../flags/test-support";
import { contractJson } from "../messages-consent/test-support";
import { recordSafetyOutcomeAlone, recordSafetyOutcomeCore, type SafetyDeps } from "./handlers";
import { KEYED_SAFETY_IDS } from "./ids";
import { FIXED_SAFETY_LINES, PLUGIN_LISTS_NO_STOP_WORDS, type SafetyLines } from "./ports";
import type { RecordRequest, RecordResponse } from "./record";
import type { SafetyOutcome, SafetyResult } from "./rules";
import {
  BARBERSHOP,
  TEST_LINES,
  applySafetyWrites,
  fakeSealer,
  fakeTelling,
  safetyReaderOn,
  safetyWorldOf,
  type FakeSealer,
  type SafetyWorld,
} from "./test-support";

const validator: ToolApiValidator = createToolApiValidator();

type RecordAction = Extract<CoreAction, { call: "recordSafetyOutcome" }>;

const HARM: SafetyOutcome = "Harm to a child or older adult";

/** Alex's text: "my mom's carer leaves her alone without food for days" (K-02 v1 safety-child-or-elder.json). */
const EVENT = "evt-alex-0205";
const NOW = "2026-10-28T14:15:02Z";

const NOTHING_OPEN: OpenHolds = { holds: [], unreadEventIds: [] };

/** K-02 v1's harm read, a fresh copy. */
const harmRead = (): SafetyResult =>
  copy(contractJson("model/fixtures/safety-child-or-elder.json") as SafetyResult);

/**
 * Bundle v0 pinned (T-163: partial, flow A holds S1-01 and S1-02 only, so no A3-49 step and no hotline), as its own lines
 * read it (T-1140's double over bundles/v0/bundle) and under the core's line rule, as runCore hands them to the service.
 */
function bundleV0Pinned(): { readonly own: SafetyLines; readonly core: SafetyLines } {
  const own = bundleLines(bundleV0());
  return { own, core: coreSafetyLines(own) };
}

/** Alex's harm text in its own turn on his handle, with bundle v0's id pinned, as the commit hands it to runCore. */
function harmTurn(sentByActor: RecordRequest["sentByActor"] = null): CommitTurnContext {
  const turnId = "turn-alex-0205";
  const caller: K09.Caller = {
    kind: "turn",
    turnId,
    requestId: turnId,
    businessId: BARBERSHOP,
    personId: "person-alex",
    traceId: `trace-${turnId}`,
  };
  const turn = {
    id: turnId,
    handleId: "handle-alex",
    eventIds: [EVENT] as [string, ...string[]],
    bundleId: bundleV0().bundleId,
    traceId: caller.traceId,
    joinedTraceIds: [],
    tries: 1,
  };
  const record: RecordAction = {
    call: "recordSafetyOutcome",
    request: { caller, safety: harmRead(), handleId: "handle-alex", bookingId: null, sentByActor },
  };
  const request: GateAndCommitRequest = {
    caller,
    turn,
    input: { kind: "coreOnly" },
    core: [record],
    now: NOW,
  };
  return { request, turn, repo: { name: "harm-line-test-repo" }, businessId: BARBERSHOP };
}

/** The record the turn carries. */
function recordIn(turn: CommitTurnContext): RecordAction {
  const action = turn.request.core[0];
  if (action?.call !== "recordSafetyOutcome") throw new Error("the turn carries the harm text's record");
  return action;
}

interface Doubles {
  readonly world: SafetyWorld;
  readonly sealer: FakeSealer;
  readonly deps: SafetyDeps<unknown>;
}

/** Every port of the safety calls over the world, under the barbershop's scope, with the pinned bundle's lines. */
function doublesOn(lines: SafetyLines, world: SafetyWorld = safetyWorldOf()): Doubles {
  const sealer = fakeSealer();
  const deps: SafetyDeps<unknown> = {
    reader: () => safetyReaderOn(world, BARBERSHOP),
    flagsReader: () => flagsReaderOn(world.flags, BARBERSHOP),
    messagesReader: () => messagesReaderOn(world.flags, BARBERSHOP),
    sealer: () => sealer,
    ids: KEYED_SAFETY_IDS,
    lines,
    // The barbershop's plug-in lists no words that stop a booking (K-09 v1.1 j3-safety-arrival-own-line.json).
    stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
    telling: fakeTelling(),
  };
  return { world, sealer, deps };
}

/** The answer of a record's run, refused by nothing and held to K-09 v1's response. */
function responseOf(result: { response: RecordResponse | null; error: unknown }): RecordResponse {
  expect(result.error).toBeNull();
  if (result.response === null) throw new Error("the record answers");
  expect(validator.check("recordSafetyOutcome", "response", result.response)).toEqual([]);
  return result.response;
}

/** The ids the Worker gives the rows of Alex's record (ids.ts). */
async function rowIds() {
  return {
    outcomeId: await KEYED_SAFETY_IDS.rowId("outcome", EVENT),
    holdId: await KEYED_SAFETY_IDS.rowId("hold", EVENT),
    lineId: await KEYED_SAFETY_IDS.rowId("line", EVENT),
    harmId: await KEYED_SAFETY_IDS.rowId("harmReport", EVENT),
  };
}

let warn: MockInstance;
let log: MockInstance;
let error: MockInstance;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  // Nothing the safety calls do writes a log line (K-08 v1: never a person's words, a number or an address).
  expect(warn).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------

describe("with bundle v0 pinned, a harm outcome is recorded with its hold and the 911 line, and nothing throws (CQ-164 (c))", () => {
  it("bundle v0 holds no hotline: its own lines give harm no line, and the core's rule gives 911 with no hotline", () => {
    const { own, core } = bundleV0Pinned();
    expect(own.lineOf(HARM, [])).toBeNull();
    expect(core.lineOf(HARM, [])).toEqual({ fixedLineId: "safetyEmergency", to: "writer", hotline: null });
  });

  it("the outcome, its at-once hold and the 911 line to Alex as a safety row; no hotline made up, so no report", async () => {
    const ids = await rowIds();
    const { own, core } = bundleV0Pinned();
    const cases: [string, SafetyLines][] = [
      ["bundle v0's own lines", own],
      ["bundle v0 under the core's line rule (runCore)", core],
    ];
    for (const [pinned, lines] of cases) {
      const doubles = doublesOn(lines);
      const turn = harmTurn();
      const { run, clocks } = await recordSafetyOutcomeCore(recordIn(turn), turn, NOTHING_OPEN, doubles.deps);
      expect(responseOf(run.result), pinned).toEqual({
        outcomeId: ids.outcomeId,
        outcomes: [HARM],
        hold: { holdId: ids.holdId, releaseRule: "at_once", blocksBooking: false },
        safetyLine: { fixedLineId: "safetyEmergency", outboxRowId: ids.lineId },
        told: [],
        nothingBooks: false,
        repeated: false,
      });
      // The outcome row and its hold, released at once after the outcome's message (arch 06 line 319). No harm report:
      // K-34 files a child-or-elder report only with the hotline given first, and none is ever made up (A3-49).
      expect(
        run.writes.state.map((write) => write.table),
        pinned,
      ).toEqual(["safety_outcomes", "safety_holds"]);
      const hold = run.writes.state.find((write) => write.table === "safety_holds");
      expect(hold?.op === "insert" ? hold.values : null, pinned).toMatchObject({
        id: ids.holdId,
        safety_outcome_id: ids.outcomeId,
        handle_id: "handle-alex",
        person_id: "person-alex",
        turn_id: "turn-alex-0205",
        release_rule: "at_once",
        blocks_booking: false,
        held_at: NOW,
      });
      expect(
        run.writes.stateEvents.map((entry) => entry.kind),
        pinned,
      ).toEqual(["safety_outcome.recorded", "safety_hold.set"]);
      // 911 goes to Alex on the handle he wrote from, at any hour and past any opt-out (send class safety).
      expect(
        run.writes.messages.map((row) => [
          row.id,
          row.recipientPersonId,
          row.recipientHandleId,
          row.sendClass,
        ]),
        pinned,
      ).toEqual([[ids.lineId, "person-alex", "handle-alex", "safety"]]);
      expect(clocks, pinned).toEqual([]);
      // His words are still sealed under his key, and nowhere in plain.
      expect(
        doubles.sealer.calls.map((call) => call.forPersonId),
        pinned,
      ).toEqual(["person-alex"]);
      const everything = stringsIn({ writes: run.writes, answer: run.result });
      expect(
        everything.some((each) => each.includes("leaves her alone")),
        pinned,
      ).toBe(false);
    }
  });

  it("the turn is not failed: through runCore (T-1140) and gateAndCommit it commits the record, its hold and the 911 row", async () => {
    // runCore's own ports over T-318's world: bundle v0's lines (under the core's line rule), the same-bytes sealer.
    const { deps } = coreDoublesOn(safetyWorldOf());
    const doubles = doublePorts();
    const ports: CommitPorts = { ...doubles.ports, runCore: createRunCore(deps) };
    const turn = harmTurn();
    const answer = await gateAndCommit(turn.request, callContext(BARBERSHOP), {
      limits: scriptedLimits(),
      ports,
    });
    if ("error" in answer || answer.result !== "committed") throw new Error("the harm text's turn commits");
    const [core] = answer.core;
    if (core?.call !== "recordSafetyOutcome") throw new Error("its core action is the safety record");
    expect(responseOf(core)).toMatchObject({
      outcomes: [HARM],
      hold: { releaseRule: "at_once", blocksBooking: false },
      safetyLine: { fixedLineId: "safetyEmergency" },
      told: [],
      repeated: false,
    });
    // One commit carries it all: the outcome, its hold and the 911 line's row.
    expect(doubles.k05.requests).toHaveLength(1);
    const [sent] = doubles.k05.requests;
    expect(sent?.writes.state.map((write) => write.table)).toEqual(["safety_outcomes", "safety_holds"]);
    expect(sent?.writes.outboxRows.map((row) => [row.recipientHandleId, row.sendClass])).toEqual([
      ["handle-alex", "safety"],
    ]);
  });

  it("a repeat names what the first record wrote: the 911 line, and no report", async () => {
    const world = safetyWorldOf();
    const doubles = doublesOn(bundleV0Pinned().core, world);
    const turn = harmTurn();
    const first = await recordSafetyOutcomeCore(recordIn(turn), turn, NOTHING_OPEN, doubles.deps);
    applySafetyWrites(world, first.run.writes.state, first.run.writes.messages);
    const again = await recordSafetyOutcomeCore(recordIn(turn), turn, NOTHING_OPEN, doubles.deps);
    expect(responseOf(again.run.result)).toEqual({ ...responseOf(first.run.result), repeated: true });
    expect(again.run.writes.state).toEqual([]);
    expect(again.run.writes.stateEvents).toEqual([]);
    expect(again.run.writes.messages).toEqual([]);
    expect(world.safety.harmReports).toEqual([]);
  });

  it("the actor's direct path sent 911 for it (T-1143): the record on return names that line and nothing throws", async () => {
    const doubles = doublesOn(bundleV0Pinned().core);
    // Sent on arrival while the core was down, a second before this turn (a stand-in Linq id, port-linq's demo pattern).
    const turn = harmTurn({
      fixedLineId: "safetyEmergency",
      at: "2026-10-28T14:15:01Z",
      linqMessageId: "linq-msg-demo-0205",
    });
    const { run } = await recordSafetyOutcomeCore(recordIn(turn), turn, NOTHING_OPEN, doubles.deps);
    expect(responseOf(run.result)).toMatchObject({
      outcomes: [HARM],
      hold: { releaseRule: "at_once" },
      safetyLine: { fixedLineId: "safetyEmergency", outboxRowId: null },
      told: [],
    });
    // The actor sent it, so the commit writes no second row for it.
    expect(run.writes.messages).toEqual([]);
    expect(run.writes.state.map((write) => write.table)).toEqual(["safety_outcomes", "safety_holds"]);
  });

  it("free text from a page with only K-01's own lines wired: the 911 line goes back to the page, and nothing throws", async () => {
    const doubles = doublesOn(FIXED_SAFETY_LINES);
    const committed: unknown[] = [];
    const request: RecordRequest = {
      caller: {
        kind: "page",
        turnId: null,
        requestId: "req-page-alex-harm",
        businessId: BARBERSHOP,
        personId: "person-alex",
        traceId: "trace-alex-page-harm",
      },
      safety: { ...harmRead(), source: "page" },
      handleId: null,
      bookingId: null,
      sentByActor: null,
    };
    const answer = await recordSafetyOutcomeAlone(request, {}, BARBERSHOP, {
      ...doubles.deps,
      commitAlone: {
        commit: (sent) => {
          committed.push(sent);
          return Promise.resolve({ committed: true, repeated: false });
        },
      },
    });
    expect(validator.check("recordSafetyOutcome", "response", answer)).toEqual([]);
    expect(answer).toEqual({
      outcomeId: (await rowIds()).outcomeId,
      outcomes: [HARM],
      hold: null,
      safetyLine: { fixedLineId: "safetyEmergency", outboxRowId: null },
      told: [],
      nothingBooks: false,
      repeated: false,
    });
    expect(committed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("a bundle that holds A3-49's hotline still uses it (A3-49)", () => {
  it("its hotline line goes to Alex, and the report to Rosie's team that day names the hotline given first", async () => {
    const ids = await rowIds();
    const cases: [string, SafetyLines][] = [
      ["the bundle's own lines", TEST_LINES],
      ["under the core's line rule (runCore)", coreSafetyLines(TEST_LINES)],
    ];
    for (const [pinned, lines] of cases) {
      expect(lines.lineOf(HARM, []), pinned).toEqual({
        fixedLineId: "safetyHotlineLine",
        to: "writer",
        hotline: "elder_care",
      });
      const doubles = doublesOn(lines);
      const turn = harmTurn();
      const { run } = await recordSafetyOutcomeCore(recordIn(turn), turn, NOTHING_OPEN, doubles.deps);
      expect(responseOf(run.result), pinned).toEqual({
        outcomeId: ids.outcomeId,
        outcomes: [HARM],
        hold: { holdId: ids.holdId, releaseRule: "at_once", blocksBooking: false },
        safetyLine: { fixedLineId: "safetyHotlineLine", outboxRowId: ids.lineId },
        told: [{ who: "team", via: "harmReport", id: ids.harmId }],
        nothingBooks: false,
        repeated: false,
      });
      expect(
        run.writes.state.map((write) => write.table),
        pinned,
      ).toEqual(["safety_outcomes", "safety_holds", "harm_reports"]);
      const report = run.writes.state.find((write) => write.table === "harm_reports");
      expect(report?.op === "insert" ? report.values : null, pinned).toMatchObject({
        id: ids.harmId,
        business_id: BARBERSHOP,
        kind: "harm_to_child_or_elder",
        safety_outcome_id: ids.outcomeId,
        hotline: "elder_care",
        reported_at: NOW,
        day_zone: "America/New_York",
      });
      expect(
        run.writes.messages.map((row) => [
          row.id,
          row.recipientPersonId,
          row.recipientHandleId,
          row.sendClass,
        ]),
        pinned,
      ).toEqual([[ids.lineId, "person-alex", "handle-alex", "safety"]]);
    }
  });

  it("a repeat names the report the first record filed, and writes nothing", async () => {
    const ids = await rowIds();
    const world = safetyWorldOf();
    const doubles = doublesOn(TEST_LINES, world);
    const turn = harmTurn();
    const first = await recordSafetyOutcomeCore(recordIn(turn), turn, NOTHING_OPEN, doubles.deps);
    applySafetyWrites(world, first.run.writes.state, first.run.writes.messages);
    expect(world.safety.harmReports).toHaveLength(1);
    const again = await recordSafetyOutcomeCore(recordIn(turn), turn, NOTHING_OPEN, doubles.deps);
    const answer = responseOf(again.run.result);
    expect(answer).toEqual({ ...responseOf(first.run.result), repeated: true });
    expect(answer.told).toEqual([{ who: "team", via: "harmReport", id: ids.harmId }]);
    expect(again.run.writes.state).toEqual([]);
    expect(again.run.writes.messages).toEqual([]);
  });
});
