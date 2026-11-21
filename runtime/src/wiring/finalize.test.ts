// T-561's finalize port (./real.ts realFinalize), under Node (Vitest project "unit"): K-09 finalizeMessage through
// @rosie/actions' turn face (T-313's finalize with T-314's fixed-line inserter over T-1141's row binding), over K-05
// doubles of its row calls (./test-support.ts fakeFinalizeData) over the rows K-05 v1's commit-s1-01-sam.json writes (turn
// 1's S1-02 row, outbox-s1-02-sam-1) and test owner 1's seeded rows, with the bundles read through the bundle port
// (fakeBundleReads). Under Node the Tool API's validator is Ajv's over the frozen schemas; inside workerd it is the
// prebuilt code (./hop10.worker.test.ts runs the port in the JOIN's turn).
//
// Sam holds no role at Lee's Barbershop (T-1148), so the row is read by S1-02's sign-up line as the owner, on a step that
// does not need business: Rosie's first text to him opens with signUpOpener, S1-02's own words, never with the business
// opener (K-01 README default 19; T-1511; DL-1033 fault 1). Bundle v2 carries that line (T-1477), so the turn is committed
// under bundle v2's id (T-1512); under bundle v0's, which has no such line, finalize refuses the text (fail closed).
//
//   - finalize-pass.json's request on its own row: send, every message check passed as check-pass.json lists them, and
//     final parts Q-30's (signUpOpener, the plan's words, the STOP, HELP and rates line, the privacy link alone last), each
//     line word for word as bundle v2 writes it and no business named, written with the plan once through writePlan; the
//     same request again answers K-09's alreadyPlanned with the stored final parts and writes nothing more;
//   - the Tool API base records no span for the call (DL-376: the turn records fillAndChecks), and finalize's note is one
//     line of labels on the call's trace id;
//   - the same row committed under bundle v0's id: finalize refuses the text (lineNotInBundle, signUpOpener), never
//     falling back to the business opener; nothing written;
//   - a request under another business reads nothing that business does not hold: notFound, nothing written;
//   - with no data bound (the Worker until T-567), the call fails closed inside the Tool API base, before any read.
// Test values only (rule 9): the contracts' fixtures and the master's sample cast.
import { FixedLineRefusedError } from "@rosie/actions/src/finalize/fixed-lines/errors";
import { HeldTurns } from "@rosie/actions/src/tool-api/turn-face/held";
import checkPass from "@rosie/contracts/message-plan/fixtures/check-pass.json";
import planS102 from "@rosie/contracts/message-plan/fixtures/plan-s1-02.json";
import commitS101Sam from "@rosie/contracts/data-access/fixtures/commit-s1-01-sam.json";
import finalizePass from "@rosie/contracts/tool-api/fixtures/finalize-pass.json";
import type { CommitTurnRequest } from "@rosie/db/repo/commit-turn";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { openTrace, type BundleId, type Span, type TraceContext } from "../trace";
import type { FinalizeMessageRequest, FinalizeMessageResponse } from "../turn/types";
import { NoDatabaseError, realBundles, realFinalize, type FinalizeData } from "./index";
import {
  BUNDLE_V0,
  BUNDLE_V2,
  bundleV0FixedLine,
  bundleV2FixedLine,
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

/** Bundle v2's sign-up opener, S1-02's own first words (K-01 README default 19): it names no business. */
const SIGN_UP_OPENER = bundleV2FixedLine("signUpOpener");

/**
 * The words of Rosie's first text to Sam, read by S1-02's sign-up line as the owner: signUpOpener, the plan's words, then
 * Q-30's lines, each as bundle v2 writes it.
 */
const FIRST_TEXT = [
  `${SIGN_UP_OPENER} ${[...PLAN_S1_02.lines.map((line) => line.text), PLAN_S1_02.question.text].join("\n")}`,
  bundleV2FixedLine("optOutLine"),
  bundleV2FixedLine("privacyLink"),
].join("\n");

const FINAL_PARTS = {
  row: ROW,
  channel: "imessage",
  sends: [{ kind: "words", text: FIRST_TEXT, calendarFile: "none", options: [], link: null }],
  fixedLines: ["signUpOpener", "optOutLine", "privacyLink"],
  slotValues: [],
  threadReplyTo: null,
};

interface Setup {
  readonly finalize: FakeFinalizeData;
  readonly spans: Span[];
  /** finalize-pass.json's request on a trace of its own, its caller's business `businessId`, through the port over `data`. */
  readonly call: (options?: { businessId?: string; data?: FinalizeData | null }) => Promise<unknown>;
}

/**
 * The K-05 doubles after commit-s1-01-sam.json's commit, its turn under `bundleId` (bundle v2, an owner's sign-up turn's,
 * by default), and the port over them.
 */
async function setup(bundleId: BundleId = BUNDLE_V2): Promise<Setup> {
  const turnRows = fakeTurnRows();
  const bundleReads = fakeBundleReads(bundleId);
  const finalize = fakeFinalizeData(turnRows, () => Date.parse(NOW));
  const commit = structuredClone(commitS101Sam.request) as unknown as CommitTurnRequest;
  const committed = await turnRows.calls.commitTurn({
    ...commit,
    turn: { ...commit.turn, bundleId: { hash: bundleId.hash, build: bundleId.build } },
  });
  if (!("result" in committed)) throw new Error("commit-s1-01-sam.json's commit was not taken");
  const spans: Span[] = [];
  return {
    finalize,
    spans,
    call: ({ businessId = TEST_OWNER_1.businessId, data = finalize.data } = {}) => {
      const trace: TraceContext = openTrace({
        openedBy: "textWebhook",
        bundleId,
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
  it("finalize-pass.json's plan on turn 1's row, under bundle v2, sends at the first attempt, every message check passed, with Q-30's final parts opening with signUpOpener and naming no business, written into the row with the plan once; the base records no span, and the note is labels on the trace id", async () => {
    const { finalize, spans, call } = await setup();

    const answer = (await call()) as FinalizeMessageResponse;

    expect(answer).toMatchObject({ outcome: "send", questionWithdrawn: false, teamPageId: null });
    expect(answer.checks.map((result) => [result.row, result.attempt, result.outcome])).toEqual([
      [ROW, "composed", "send"],
    ]);
    expect(answer.checks[0]?.checks).toEqual(checkPass.checks);
    expect(answer.finalParts).toEqual(FINAL_PARTS);
    // S1-02's own words first (K-01 README default 19), with the privacy link alone on the last line; the business
    // opener's words are nowhere, and neither is the business's name: Sam has named no business yet.
    const text = String((answer.finalParts?.sends[0] as { text?: unknown } | undefined)?.text);
    expect(text.startsWith(`${SIGN_UP_OPENER} `)).toBe(true);
    expect(text.split("\n").at(-1)).toBe(bundleV2FixedLine("privacyLink"));
    expect(text).not.toContain(bundleV0FixedLine("opener").replace(" <business>.", ""));
    expect(text).not.toContain(TEST_OWNER_1_BUSINESS_NAME);
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

  it("the same row committed under bundle v0's id, which has no signUpOpener: finalize refuses the text (lineNotInBundle, signUpOpener), never falling back to the business opener, and nothing is written", async () => {
    const { finalize, spans, call } = await setup(BUNDLE_V0);
    // Bundle v0 holds the business opener and no sign-up opener (K-01 README default 19: bundles v0, v1 and v1.1).
    expect(bundleV0FixedLine("opener")).toContain("<business>");
    expect(() => bundleV0FixedLine("signUpOpener")).toThrow("bundles/v0 holds no en fixed line signUpOpener");

    await expect(call()).rejects.toThrow(new FixedLineRefusedError("lineNotInBundle", "signUpOpener"));
    // Read once each under Lee's Barbershop, and nothing written: no plan, no final parts, no clock cancelled.
    expect(finalize.rowReads).toEqual([{ outboxRowId: ROW, businessId: TEST_OWNER_1.businessId }]);
    expect(finalize.writes).toEqual([]);
    expect(finalize.plans.get(ROW)).toBeUndefined();
    expect(finalize.cancels).toEqual([]);
    expect(spans).toEqual([]);
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
