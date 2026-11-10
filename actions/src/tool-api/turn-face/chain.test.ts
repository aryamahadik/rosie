// T-1141's unit chain (ADR-013 section 6's T-1141 line; DL-322, which settles CQ-156 a): one turn's fixtures, each call's
// output feeding the next, through one turn face: build-frontier-s1-01.json, then commit-s1-01.json (K-09 v1.5), then
// compose-input-s1-02.json on that commit's row, outbox-s1-02-sam-1, then finalize with finalize-pass.json's plan, which on
// bundle v0 (K-01 v1's bundle-v0-skeleton.json, the turn's pin) answers lineNotInBundle for privacyLink (T-314; K-09 v1.5
// open gap 121), the chain's end on that pin; with the line (bundle v0 as bundles/v0 publishes it, T-1146), the final
// parts carry the bundle's opener, the opt-out line and the privacy link (Q-30), not finalize-pass.json's outcome.
//
// Round 2 (DL-364, DL-365, DL-370): the frontier gives the fixture's whole frontier (T-1147), the gate passes the sign-up
// door with commit-s1-01.json's six limit answers (T-1183), and the row, to Sam who holds no role yet, is read by S1-02's
// sign-up line as the owner (K-05 v1.5 item 44, T-1184). The row read answers only a row the commit wrote, as K-05
// answers it after that commit on T-1148's seed (row-reader-s1-02-no-role.json's given: read-outbox-row-s1-02.json with
// recipient.roles empty), and its row, turn, bundle, question, recipient, channel and send class are the commit's own.

import { describe, expect, it } from "vitest";

import {
  captureLog,
  checks,
  fakeBundles,
  fakeRepo,
  frontierScope,
  sampleBundle,
  type BundleDocument,
  type FakeRepo,
} from "../../frontier/assemble/test-support";
import { fixture, traceFor } from "../test-support";
import {
  CORE_ROW_IN_WRITTEN,
  callDoubles,
  commitRequestAfter,
  commitS101,
  firstTextFacts,
  outboxRowTurnOne,
  publishedBundleV0,
  rowDoubles,
  rowUnderPublishedV0,
} from "./calls-test-support";
import { NOTHING_OPEN_AT } from "./commit";
import { composeInputDeps, finalizeDeps, type OutboxRowRead, type RowData } from "./rows";
import { asFarAsMain, firstTextSeed, s101Exchange } from "./test-support";
import { createTurnFace, type TurnFace } from "./turn-face";

type Json = Record<string, unknown>;

const { validator, checker } = checks();
const ROW = "outbox-s1-02-sam-1";

/** One turn face over turn 1's stored state, the bundle the row is read in, and K-05's calls as doubles. */
function chainOf(row: OutboxRowRead, bundle: BundleDocument) {
  // The frontier and the commit read the turn's pin, bundle v0 (K-01 v1's bundle-v0-skeleton.json).
  const pinned = fakeBundles(sampleBundle("bundle-v0-skeleton.json"));
  const repo = fakeRepo(firstTextSeed());
  const commit = callDoubles();
  const rows = rowDoubles({ row, facts: firstTextFacts(), bundle });
  // The row read answers only a row the commit wrote.
  const sent = () => commit.k05.requests.flatMap((request) => request.writes.outboxRows);
  const data: RowData = {
    ...rows.data,
    readOutboxRow: (request) =>
      sent().some((each) => each.id === request.outboxRowId)
        ? rows.data.readOutboxRow(request)
        : Promise.resolve({ error: "notFound", table: "outbox_rows", rowId: request.outboxRowId }),
  };
  const binding = { ...rows.binding, data };
  const face: TurnFace = createTurnFace<FakeRepo>({
    scope: frontierScope(repo),
    bundles: pinned,
    validator,
    checker,
    log: captureLog().sink,
    calls: {
      scope: commit.calls.scope,
      commit: commit.calls.commit,
      compose: composeInputDeps(binding),
      finalize: finalizeDeps(binding),
      held: rows.held,
    },
  });
  return { face, commit, rows, sent };
}

/** Steps 1 and 2: the frontier's answer feeds the commit, which answers commit-s1-01.json's outcome. */
async function frontierThenCommit(chain: ReturnType<typeof chainOf>): Promise<void> {
  // 1. The frontier: the fixture's whole frontier (its last messages empty while no frozen call reads them).
  const frontierExchange = s101Exchange();
  const expected = asFarAsMain(frontierExchange);
  if (expected.ends !== "answer") throw new Error("the frontier gives turn 1's sign-up door since T-1147");
  const frontier = await chain.face.buildFrontier(
    structuredClone(frontierExchange.request),
    traceFor(frontierExchange.request).trace,
  );
  expect(frontier).toEqual(expected.answer);
  const { context } = frontier as unknown as { context: Json };
  expect(context.choices).toEqual(frontierExchange.outcome.context.choices);

  // 2. Gate and commit on the frontier's context: commit-s1-01.json's outcome (CORE_ROW_IN_WRITTEN apart).
  const request = commitRequestAfter(context);
  if (request.input.kind !== "decided") throw new Error("turn 1 is decided");
  expect(request.input.decided.context).toEqual({ ...frontierExchange.outcome.context, recentMessages: [] });
  const committed = await chain.face.gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace);
  expect(validator.check("gateAndCommit", "response", committed)).toEqual([]);
  const stated = commitS101().outcome as Json & { written: { written: Json[] } };
  expect(committed).toEqual({
    ...stated,
    written: { ...stated.written, written: [...CORE_ROW_IN_WRITTEN, ...stated.written.written] },
  });
  expect(chain.commit.k05.requests).toHaveLength(1);
}

/** The row read compose input and finalize get is the commit's own: its row, turn, bundle, question and recipient. */
function expectReadOfCommit(chain: ReturnType<typeof chainOf>, read: OutboxRowRead): void {
  const [request] = chain.commit.k05.requests;
  const [row] = chain.sent();
  if (request === undefined || row === undefined) throw new Error("the commit wrote S1-02's row");
  expect(read.outboxRowId).toBe(row.id);
  expect(read.businessId).toBe(row.businessId);
  expect(read.row).toMatchObject({
    turnId: request.turn.id,
    channel: row.channel,
    sendClass: row.sendClass,
    bookingId: row.bookingId,
    openQuestionId: row.openQuestionId,
    copyOfRowId: row.copyOfRowId,
    hasPlan: false,
  });
  expect(read.recipient).toMatchObject({
    handleId: row.recipientHandleId,
    personId: row.recipientPersonId,
    roles: [],
  });
  expect(read.slotSource.question?.id).toBe(row.openQuestionId);
  expect(read.line).toEqual({ step: "S1-02", index: 0, from: "openQuestion" });
}

describe("one turn's fixtures chain through the turn face (K-09 v1.5 turn 1; ADR-013)", () => {
  it("build-frontier-s1-01, then commit-s1-01, then compose input and finalize on the commit's row: on the turn's pin, finalize ends the chain at lineNotInBundle", async () => {
    const row = outboxRowTurnOne();
    const chain = chainOf(row, sampleBundle("bundle-v0-skeleton.json"));
    const compose = fixture("compose-input-s1-02.json") as { request: Json; outcome: { input: Json } };

    // Before the commit, the row is not there: compose input on it answers notFound.
    expect(
      await chain.face.composeInput(structuredClone(compose.request), traceFor(compose.request).trace),
    ).toEqual({ error: "notFound", table: "outbox_rows", rowId: ROW });

    await frontierThenCommit(chain);
    expectReadOfCommit(chain, row);

    // 3. Compose input on that commit's row (compose-input-s1-02.json's request names it): Sam, with no role, read as the
    // owner by S1-02's sign-up line and addressed as Sam; the words he sent, handed in by gateAndCommit; gentle while the
    // sensitive switch is treated as on (DL-326 note b).
    expect(compose.request.outboxRowId).toBe(ROW);
    const composed = await chain.face.composeInput(
      structuredClone(compose.request),
      traceFor(compose.request).trace,
    );
    expect(validator.check("composeInput", "response", composed)).toEqual([]);
    expect(composed).toEqual({ result: "compose", input: { ...compose.outcome.input, situation: "gentle" } });
    expect(composed).toMatchObject({ input: { audience: { role: "owner", name: "Sam" } } });

    // 4. Finalize with finalize-pass.json's plan on the same row: refused whole on the turn's pin (open gap 121), and
    // nothing written.
    const finalize = fixture("finalize-pass.json") as { request: Json };
    await expect(
      chain.face.finalizeMessage(structuredClone(finalize.request), traceFor(finalize.request).trace),
    ).rejects.toMatchObject({ name: "FixedLineRefusedError", fault: "lineNotInBundle", line: "privacyLink" });
    expect(chain.rows.plans).toEqual([]);
  });

  it("the same chain with the line, the row read in bundle v0 as published (T-1146): finalize sends, its final parts the bundle's opener, the opt-out line and the privacy link, written with the plan once", async () => {
    const published = publishedBundleV0();
    const row = rowUnderPublishedV0(outboxRowTurnOne());
    const chain = chainOf(row, published);
    await frontierThenCommit(chain);
    expectReadOfCommit(chain, row);

    const compose = fixture("compose-input-s1-02.json") as { request: Json };
    const composed = await chain.face.composeInput(
      structuredClone(compose.request),
      traceFor(compose.request).trace,
    );
    expect(validator.check("composeInput", "response", composed)).toEqual([]);
    expect(composed).toMatchObject({
      result: "compose",
      input: { row: ROW, audience: { role: "owner", name: "Sam" } },
    });

    const finalize = fixture("finalize-pass.json") as { request: Json; outcome: Json };
    const answer = (await chain.face.finalizeMessage(
      structuredClone(finalize.request),
      traceFor(finalize.request).trace,
    )) as unknown as Json & { finalParts: { fixedLines: string[]; sends: { text: string }[] } };
    expect(validator.check("finalizeMessage", "response", answer)).toEqual([]);
    expect(answer.outcome).toBe("send");
    expect(answer.finalParts.fixedLines).toEqual(["opener", "optOutLine", "privacyLink"]);
    const fixed = (
      published.manifest.lists as { fixedLines: { lines: { id: string; lang: string; text: string }[] } }
    ).fixedLines.lines;
    const words = (id: string): string =>
      fixed.find((line) => line.id === id && line.lang === "en")?.text ?? "";
    const lines = (answer.finalParts.sends[0]?.text ?? "").split("\n");
    expect(lines[0]?.startsWith(words("opener").replace("<business>", "Lee's Barbershop"))).toBe(true);
    expect(lines.slice(-2)).toEqual([words("optOutLine"), words("privacyLink")]);
    expect(answer).not.toEqual(finalize.outcome);
    expect(chain.rows.plans.map((plan) => [plan.outboxRowId, plan.finalParts])).toEqual([
      [ROW, answer.finalParts],
    ]);
  });
});
