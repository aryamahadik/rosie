// T-561's finalize port (./real.ts realFinalize), under Node (Vitest project "unit"): K-09 finalizeMessage through
// @rosie/actions' turn face (T-313's finalize with T-314's fixed-line inserter over T-1141's row binding), over K-05
// doubles of its row calls (./test-support.ts fakeFinalizeData) over the rows K-05 v1's commit-s1-01-sam.json writes (turn
// 1's S1-02 row, outbox-s1-02-sam-1, its turn under bundle v0 as bundles/v0 publishes it) and test owner 1's seeded rows,
// with bundle v0 read through the bundle port (fakeBundleReads). Under Node the Tool API's validator is Ajv's over the
// frozen schemas; inside workerd it is the prebuilt code (./hop10.worker.test.ts runs the port in the JOIN's turn).
//
//   - finalize-pass.json's request on its own row: send, every message check passed as check-pass.json lists them, and
//     final parts Q-30's (the opener, the plan's words, the STOP, HELP and rates line, the privacy link alone last), written
//     with the plan once through writePlan; the same request again answers K-09's alreadyPlanned with the stored final
//     parts and writes nothing more;
//   - the Tool API base records no span for the call (DL-376: the turn records fillAndChecks), and finalize's note is one
//     line of labels on the call's trace id;
//   - a request under another business reads nothing that business does not hold: notFound, nothing written;
//   - with no data bound (the Worker until T-567), the call fails closed inside the Tool API base, before any read.
// Test values only (rule 9): the contracts' fixtures and the master's sample cast.
import { HeldTurns } from "@rosie/actions/src/tool-api/turn-face/held";
import checkPass from "@rosie/contracts/message-plan/fixtures/check-pass.json";
import planS102 from "@rosie/contracts/message-plan/fixtures/plan-s1-02.json";
import commitS101Sam from "@rosie/contracts/data-access/fixtures/commit-s1-01-sam.json";
import finalizePass from "@rosie/contracts/tool-api/fixtures/finalize-pass.json";
import type { CommitTurnRequest } from "@rosie/db/repo/commit-turn";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { openTrace, type Span, type TraceContext } from "../trace";
import type { FinalizeMessageRequest, FinalizeMessageResponse } from "../turn/types";
import { NoDatabaseError, realBundles, realFinalize, type FinalizeData } from "./index";
import {
  BUNDLE_V0,
  bundleV0FixedLine,
  fakeBundleReads,
  fakeFinalizeData,
  fakeTurnRows,
  TEST_OWNER_1,
  TEST_OWNER_1_BUSINESS_NAME,
  type FakeFinalizeData,
} from "./test-support";

const ROW = finalizePass.request.outboxRowId;
const PLAN_S1_02 = planS102 as unknown as {
  readonly lines: readonly { readonly text: string }[];
  readonly question: { readonly text: string };
};
/** The time finalize-pass.json's call runs at. */
const NOW = finalizePass.given.now;

/** The words of Rosie's first text to Sam about Lee's Barbershop: the opener, the plan's words, then Q-30's lines. */
const FIRST_TEXT = [
  `${bundleV0FixedLine("opener").replace("<business>", TEST_OWNER_1_BUSINESS_NAME)} ${[
    ...PLAN_S1_02.lines.map((line) => line.text),
    PLAN_S1_02.question.text,
  ].join("\n")}`,
  bundleV0FixedLine("optOutLine"),
  bundleV0FixedLine("privacyLink"),
].join("\n");

const FINAL_PARTS = {
  row: ROW,
  channel: "imessage",
  sends: [{ kind: "words", text: FIRST_TEXT, calendarFile: "none", options: [], link: null }],
  fixedLines: ["opener", "optOutLine", "privacyLink"],
  slotValues: [],
  threadReplyTo: null,
};

interface Setup {
  readonly finalize: FakeFinalizeData;
  readonly spans: Span[];
  /** finalize-pass.json's request on a trace of its own, its caller's business `businessId`, through the port over `data`. */
  readonly call: (options?: { businessId?: string; data?: FinalizeData | null }) => Promise<unknown>;
}

/** The K-05 doubles after commit-s1-01-sam.json's commit (its turn under bundle v0), and the port over them. */
async function setup(): Promise<Setup> {
  const turnRows = fakeTurnRows();
  const bundleReads = fakeBundleReads();
  const finalize = fakeFinalizeData(turnRows, () => Date.parse(NOW));
  const commit = structuredClone(commitS101Sam.request) as unknown as CommitTurnRequest;
  const committed = await turnRows.calls.commitTurn({
    ...commit,
    turn: { ...commit.turn, bundleId: { hash: BUNDLE_V0.hash, build: BUNDLE_V0.build } },
  });
  if (!("result" in committed)) throw new Error("commit-s1-01-sam.json's commit was not taken");
  const spans: Span[] = [];
  return {
    finalize,
    spans,
    call: ({ businessId = TEST_OWNER_1.businessId, data = finalize.data } = {}) => {
      const trace: TraceContext = openTrace({
        openedBy: "textWebhook",
        bundleId: BUNDLE_V0,
        sink: (span) => spans.push(span),
      });
      const request = structuredClone(finalizePass.request) as unknown as FinalizeMessageRequest;
      trace.setTurn(request.caller.turnId);
      const port = realFinalize({
        data,
        bundles: () => realBundles({ calls: bundleReads.calls }),
        pinnedOf: () => null,
        held: new HeldTurns(),
        now: () => Date.parse(NOW),
      });
      return port.finalizeMessage(
        { ...request, caller: { ...request.caller, businessId, traceId: trace.traceId } },
        trace,
      );
    },
  };
}

let info: MockInstance;

beforeEach(() => {
  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("finalize bound to @rosie/actions' turn face: slots, fixed lines, the claim check and the message checks", () => {
  it("finalize-pass.json's plan on turn 1's row sends at the first attempt, every message check passed, with Q-30's final parts written into the row with the plan once; the base records no span, and the note is labels on the trace id", async () => {
    const { finalize, spans, call } = await setup();

    const answer = (await call()) as FinalizeMessageResponse;

    expect(answer).toMatchObject({ outcome: "send", questionWithdrawn: false, teamPageId: null });
    expect(answer.checks.map((result) => [result.row, result.attempt, result.outcome])).toEqual([
      [ROW, "composed", "send"],
    ]);
    expect(answer.checks[0]?.checks).toEqual(checkPass.checks);
    expect(answer.finalParts).toEqual(FINAL_PARTS);
    // Not finalize-pass.json's outcome, which predates T-314's first-text lines (K-09 v1.5 open gap 121).
    expect(answer).not.toEqual(finalizePass.outcome);
    // Written once with the plan (T-196's writePlan), the row checked at its next version.
    expect(finalize.writes).toEqual([
      { outboxRowId: ROW, expectVersion: 1, plan: finalizePass.request.plan, finalParts: FINAL_PARTS },
    ]);
    expect(finalize.plans.get(ROW)?.version).toBe(2);
    // Read under the call's business, once each, on the runtime side.
    expect(finalize.scopes).toEqual([TEST_OWNER_1.businessId]);
    expect(finalize.rowReads).toEqual([{ outboxRowId: ROW, businessId: TEST_OWNER_1.businessId }]);
    expect(finalize.factReads).toEqual([{ outboxRowId: ROW, businessId: TEST_OWNER_1.businessId }]);
    // No span of the base's: the turn records the row's fillAndChecks span (DL-376).
    expect(spans).toEqual([]);
    const notes = info.mock.calls.map(
      (each: unknown[]) => JSON.parse(String(each[0])) as Record<string, unknown>,
    );
    expect(notes).toEqual([
      {
        level: "info",
        msg: "finalize_attempt",
        trace_id: expect.any(String) as unknown,
        row: ROW,
        attempt: "composed",
        outcome: "send",
        missed: [],
      },
    ]);
  });

  it("the same request again answers alreadyPlanned with the final parts the row holds, and writes nothing more", async () => {
    const { finalize, call } = await setup();
    await call();

    expect(await call()).toEqual({ error: "alreadyPlanned", outboxRowId: ROW, finalParts: FINAL_PARTS });
    expect(finalize.writes).toHaveLength(1);
    expect(finalize.plans.get(ROW)).toEqual({
      plan: finalizePass.request.plan,
      finalParts: FINAL_PARTS,
      version: 2,
    });
  });

  it("under another business, the row is not there: notFound, and nothing is written", async () => {
    const { finalize, call } = await setup();

    expect(await call({ businessId: "biz-other" })).toEqual({
      error: "notFound",
      table: "outbox_rows",
      rowId: ROW,
    });
    expect(finalize.scopes).toEqual(["biz-other"]);
    expect(finalize.writes).toEqual([]);
  });

  it("with no data bound (the Worker until T-567), the call fails closed inside the Tool API base: nothing read or written, no span", async () => {
    const { finalize, spans, call } = await setup();

    await expect(call({ data: null })).rejects.toThrow(new NoDatabaseError("finalizeMessage"));
    expect(finalize.rowReads).toEqual([]);
    expect(finalize.writes).toEqual([]);
    expect(spans).toEqual([]);
  });
});
