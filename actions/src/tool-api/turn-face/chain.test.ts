// T-1141's unit chain (ADR-013 section 6's T-1141 line; DL-322, which settles CQ-156 a): one turn's fixtures, each call's
// output feeding the next, through one turn face: build-frontier-s1-01.json, then commit-s1-01.json (K-09 v1.5), then
// compose-input-s1-02.json on that commit's row, outbox-s1-02-sam-1, then finalize with finalize-pass.json's plan, which on
// bundle v0 (K-01 v1's bundle-v0-skeleton.json, the turn's pin) answers lineNotInBundle for privacyLink (T-314; K-09 v1.5
// open gap 121): the chain's end until the pinned bundle carries the line (with it: rows.test.ts).
//
// As far as main gives it, each step waiting named, never faked: the frontier fails closed (noChoices) while the sign-up
// door waits for T-1147 (T-315's WAITING), so the commit reads the fixture's context, which is that frontier's answer;
// the gate's limit 1 stops the door (GATE_WAITING), so the commit writes Sam's record alone and no row; and compose input
// on the row the fixture names then answers notFound. Once both land, the same test runs the chain to its end: the row
// the commit wrote, read as K-05's read-outbox-row-s1-02.json answers it after that commit, gives compose-input-s1-02.json's
// input, and finalize on it the refusal above.

import { describe, expect, it } from "vitest";

import { FrontierError } from "../../frontier";
import {
  captureLog,
  checks,
  fakeBundles,
  fakeRepo,
  frontierScope,
  sampleBundle,
  type FakeRepo,
} from "../../frontier/assemble/test-support";
import { fixture, traceFor } from "../test-support";
import {
  LIMIT_ONE_WAITS,
  callDoubles,
  commitRequestAfter,
  firstTextFacts,
  outboxRowS102,
  rowDoubles,
} from "./calls-test-support";
import { NOTHING_OPEN_AT } from "./commit";
import { composeInputDeps, finalizeDeps, type RowData } from "./rows";
import { asFarAsMain, firstTextSeed, s101Exchange } from "./test-support";
import { createTurnFace } from "./turn-face";

type Json = Record<string, unknown>;

const { validator, checker } = checks();
const ROW = "outbox-s1-02-sam-1";

describe("one turn's fixtures chain through the turn face (K-09 v1.5 turn 1; ADR-013)", () => {
  it("build-frontier-s1-01, then commit-s1-01, then compose input and finalize on the commit's row: as far as main gives each", async () => {
    // One face over the turn's stored state (T-1148's seed), bundle v0, and K-05's calls as doubles.
    const bundles = fakeBundles(sampleBundle("bundle-v0-skeleton.json"));
    const repo = fakeRepo(firstTextSeed());
    const commit = callDoubles();
    const rows = rowDoubles({ facts: firstTextFacts() });
    // The row read answers only a row the commit wrote, as K-05's read-outbox-row-s1-02.json gives it after that commit.
    const written = (): boolean =>
      commit.k05.requests.some((request) => request.writes.outboxRows.some((row) => row.id === ROW));
    const data: RowData = {
      ...rows.data,
      readOutboxRow: (request) =>
        written()
          ? rows.data.readOutboxRow(request)
          : Promise.resolve({ error: "notFound", table: "outbox_rows", rowId: request.outboxRowId }),
    };
    const binding = { ...rows.binding, data, bundles };
    const face = createTurnFace<FakeRepo>({
      scope: frontierScope(repo),
      bundles,
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

    // 1. The frontier: the fixture's frontier as far as main's sources give it, else fail closed (T-315's WAITING).
    const frontierExchange = s101Exchange();
    const expected = asFarAsMain(frontierExchange);
    const frontier = await face
      .buildFrontier(structuredClone(frontierExchange.request), traceFor(frontierExchange.request).trace)
      .then(
        (answer) => ({ answer, thrown: undefined }),
        (thrown: unknown) => ({ answer: undefined, thrown }),
      );
    let context: unknown;
    if (expected.ends === "answer") {
      expect(frontier.answer).toEqual(expected.answer);
      context = (frontier.answer as { context: unknown }).context;
    } else {
      expect(frontier.thrown).toBeInstanceOf(FrontierError);
      expect((frontier.thrown as FrontierError).code).toBe("noChoices");
    }
    // The commit's context is the frontier's answer: when main gave none, the fixture's own, which is that answer.
    const commitRequest = commitRequestAfter(context);
    if (commitRequest.input.kind !== "decided") throw new Error("turn 1 is decided");
    expect(commitRequest.input.decided.context).toEqual(frontierExchange.outcome.context);

    // 2. Gate and commit: one commit under the turn id, as far as main's gate gives it (GATE_WAITING).
    const committed = (await face.gateAndCommit(
      commitRequest,
      NOTHING_OPEN_AT,
      traceFor(commitRequest).trace,
    )) as unknown as Json & { written: { outboxRows: { id: string }[] } };
    expect(committed).toMatchObject({ result: "committed", turnId: "turn-s1-01-sam", repeated: false });
    const rowIds = committed.written.outboxRows.map((row) => row.id);
    expect(rowIds).toEqual(LIMIT_ONE_WAITS ? [] : [ROW]);

    // 3. Compose input on that commit's row (compose-input-s1-02.json's request names it).
    const compose = fixture("compose-input-s1-02.json") as { request: Json; outcome: { input: Json } };
    expect(compose.request.outboxRowId).toBe(ROW);
    const composed = await face.composeInput(
      structuredClone(compose.request),
      traceFor(compose.request).trace,
    );
    if (!written()) {
      // The commit wrote no row (limit 1 waits): the chain ends here, nothing composed.
      expect(composed).toEqual({ error: "notFound", table: "outbox_rows", rowId: ROW });
      return;
    }
    expect(outboxRowS102().outboxRowId).toBe(ROW);
    expect(composed).toEqual({ result: "compose", input: { ...compose.outcome.input, situation: "gentle" } });

    // 4. Finalize with finalize-pass.json's plan on the same row: refused whole on bundle v0 (open gap 121).
    const finalize = fixture("finalize-pass.json") as { request: Json };
    await expect(
      face.finalizeMessage(structuredClone(finalize.request), traceFor(finalize.request).trace),
    ).rejects.toMatchObject({ name: "FixedLineRefusedError", fault: "lineNotInBundle", line: "privacyLink" });
    expect(rows.plans).toEqual([]);
  });
});
