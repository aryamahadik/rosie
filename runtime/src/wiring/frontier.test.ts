// The frontier port (T-557; ./real.ts realFrontier), under Node (Vitest project "unit"): K-09 buildFrontier through
// @rosie/actions' turn face, over the frontier's scope (the K-05 v1.2 readTurnState double holding test owner 1's seeded
// rows, ./test-support.ts fakeFrontierScope) and the bundles it reads: the bundle the turn's run pinned, else the bundle
// by its id through the bundle port, KV first and PostgreSQL's copy on a miss (runtime/src/bundle/test-support.ts, K-01's
// bundle v0 skeleton, the bundle build-frontier-s1-01.json names). Under Node the Tool API's validator and the frontier's
// checker are Ajv's over the frozen schemas; inside workerd they are the prebuilt code (./hop6.worker.test.ts).
//
//   - build-frontier-s1-01.json's request gives its outcome, word for word: one choice, c-01, the sign-up door to S1-01;
//   - the call's one span (the Tool API base's) names each bundle part it read and where it came from: KV, or PostgreSQL's
//     copy on KV's miss; a part the run's pin already read (its manifest) is not named again;
//   - a bundle in neither copy is buildFrontier's own bundleNotFound, nothing assembled; a value no copy holds as the
//     bundle's own fails the call closed.
// Test values only (rule 9): the contracts' fixtures and the master's sample cast.
import buildFrontierS101 from "@rosie/contracts/tool-api/fixtures/build-frontier-s1-01.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BundleError, type FlowGraph, type FlowLetter, type PartRead, type PinnedBundle } from "../bundle";
import { BUNDLE_A, BUNDLE_B, fakeBundles, keyIn, WHOLE_A, type FakeBundles } from "../bundle/test-support";
import { openTrace, type BundleId, type Span, type TraceContext } from "../trace";
import { checkedManifest } from "../turn/test-support";
import type { BuildFrontierAnswer, BuildFrontierRequest } from "../turn/types";
import { realFrontier, type FrontierInputs } from "./real";
import { fakeFrontierScope, type FakeFrontierScope } from "./test-support";

const TURN_ONE = buildFrontierS101 as unknown as {
  readonly request: BuildFrontierRequest;
  readonly outcome: Record<string, unknown>;
};

/** The frozen fixture names K-01's bundle v0 skeleton: bundle A of the bundle pin's doubles. */
const FIXTURE_BUNDLE: BundleId = TURN_ONE.request.turn.bundleId;

interface Call {
  readonly answer: BuildFrontierAnswer | undefined;
  readonly thrown: unknown;
  readonly spans: Span[];
}

interface Setup {
  readonly bundles: FakeBundles;
  readonly frontier: FakeFrontierScope;
  /** The bundle a run pinned for the call's trace, or none. */
  pinned: PinnedBundle | null;
  /** One buildFrontier call on a trace of its own, under `bundleId`, with build-frontier-s1-01.json's request. */
  call(bundleId?: BundleId): Promise<Call>;
}

function setup(): Setup {
  const bundles = fakeBundles();
  const frontier = fakeFrontierScope(() => TURN_ONE.request.now);
  const state: Setup = {
    bundles,
    frontier,
    pinned: null,
    async call(bundleId = FIXTURE_BUNDLE) {
      const spans: Span[] = [];
      const trace = openTrace({ openedBy: "textWebhook", bundleId, sink: (span) => spans.push(span) });
      const request = structuredClone(TURN_ONE.request);
      const asked: BuildFrontierRequest = {
        ...request,
        caller: { ...request.caller, traceId: trace.traceId },
        turn: { ...request.turn, traceId: trace.traceId, bundleId: { ...bundleId } },
      };
      trace.setTurn(asked.turn.id);
      const inputs: FrontierInputs = {
        scope: frontier.scope,
        bundles: () => bundles.deps,
        pinnedOf: (of: TraceContext) => (of === trace ? state.pinned : null),
      };
      try {
        return { answer: await realFrontier(inputs).buildFrontier(asked, trace), thrown: undefined, spans };
      } catch (thrown) {
        return { answer: undefined, thrown, spans };
      }
    },
  };
  return state;
}

/**
 * Bundle A as a run pinned it (the pin checked its manifest, read from PostgreSQL's copy), reading each flow through
 * `read` once per run, as the pin's own pinned bundle does (runtime/src/bundle/pin.ts `once`), and logging each read.
 * `asked` counts every ask, read or not.
 */
async function pinnedA(read: (flow: FlowLetter) => { graph: FlowGraph; from: PartRead["from"] }): Promise<{
  bundle: PinnedBundle;
  log: PartRead[];
  asked: FlowLetter[];
}> {
  const manifest = await checkedManifest(WHOLE_A, BUNDLE_A);
  const log: PartRead[] = [{ key: keyIn(BUNDLE_A, "manifest"), kind: "manifest", from: "postgres" }];
  const asked: FlowLetter[] = [];
  const graphs = new Map<FlowLetter, FlowGraph>();
  const bundle: PinnedBundle = {
    bundleId: BUNDLE_A,
    manifest,
    flow(flow) {
      asked.push(flow);
      const listed = manifest.storage.values.some((value) => value.kind === "flow" && value.flow === flow);
      if (!listed) return Promise.reject(new BundleError("notInBundle"));
      const known = graphs.get(flow);
      if (known !== undefined) return Promise.resolve(known);
      const { graph, from } = read(flow);
      graphs.set(flow, graph);
      log.push({ key: keyIn(BUNDLE_A, `flow/${flow}`), kind: "flow", from });
      return Promise.resolve(graph);
    },
    trade: () => Promise.reject(new BundleError("notInBundle")),
    reads: () => log.map((entry) => ({ ...entry })),
  };
  return { bundle, log, asked };
}

beforeEach(() => {
  // The frontier logs each slot not built yet (frontier_source_missing) on console.warn: labels only.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the frontier port over a bundle read by its id through the bundle port", () => {
  it("gives build-frontier-s1-01.json's answer word for word (the sign-up door to S1-01), its one span naming each part read from KV", async () => {
    const run = setup();
    const called = await run.call();

    expect(called.thrown).toBeUndefined();
    expect(called.answer).toEqual(TURN_ONE.outcome);
    expect(run.frontier.reads.map((read) => [read.call, read.scope])).toEqual([
      ["readTurnState", TURN_ONE.request.caller.businessId],
    ]);
    expect(called.spans).toMatchObject([
      {
        hop: "frontier",
        outcome: "ok",
        error_code: null,
        bundle_id: FIXTURE_BUNDLE,
        business_id: TURN_ONE.request.caller.businessId,
        got: {
          toolCall: "buildFrontier",
          callerKind: "turn",
          bundleParts: ["manifest", "flow/A"],
          bundleFrom: ["kv", "kv"],
        },
        decided: { answered: "response" },
      },
    ]);
    // Read once each, even though the hubs-and-doors source reads the flow graph again: KV only, PostgreSQL untouched.
    expect(run.bundles.kvReads).toEqual([keyIn(BUNDLE_A, "manifest"), keyIn(BUNDLE_A, "flow/A")]);
    expect(run.bundles.calls).toEqual([]);
  });

  it("reads PostgreSQL's copy on KV's miss, and the span says so", async () => {
    const run = setup();
    run.bundles.kvMissing.add(keyIn(BUNDLE_A, "manifest"));
    run.bundles.kvMissing.add(keyIn(BUNDLE_A, "flow/A"));
    const called = await run.call();

    expect(called.answer).toEqual(TURN_ONE.outcome);
    expect(called.spans[0]?.got).toMatchObject({
      bundleParts: ["manifest", "flow/A"],
      bundleFrom: ["postgres", "postgres"],
    });
    expect(run.bundles.calls).toEqual([
      { call: "readBundleValue", key: keyIn(BUNDLE_A, "manifest") },
      { call: "readBundleValue", key: keyIn(BUNDLE_A, "flow/A") },
    ]);
  });

  it("a bundle in neither copy is buildFrontier's own bundleNotFound: nothing read, nothing assembled", async () => {
    const run = setup();
    const missing: BundleId = { hash: "0".repeat(64), build: 1 };
    const called = await run.call(missing);

    expect(called.answer).toEqual({ error: "bundleNotFound", bundleId: missing });
    expect(called.spans).toMatchObject([
      { hop: "frontier", outcome: "refused", error_code: "bundleNotFound", got: { bundleParts: [] } },
    ]);
    expect(run.frontier.reads).toEqual([]);
  });

  it("a value no copy holds as the bundle's own fails the call closed, its span failed", async () => {
    const run = setup();
    run.bundles.kvHolds.set(keyIn(BUNDLE_A, "flow/A"), JSON.stringify({ contract: "bundle.v1", flow: "B" }));
    run.bundles.postgres.set(keyIn(BUNDLE_A, "flow/A"), {
      error: "notFound",
      table: "bundle_values",
      rowId: keyIn(BUNDLE_A, "flow/A"),
    });
    const called = await run.call();

    expect(called.answer).toBeUndefined();
    expect(called.thrown).toBeInstanceOf(BundleError);
    expect(called.spans).toMatchObject([
      {
        hop: "frontier",
        outcome: "failed",
        error_code: "BundleError",
        got: { bundleParts: ["manifest"], bundleFrom: ["kv"] },
      },
    ]);
  });
});

describe("the frontier port over the bundle the turn's run pinned", () => {
  it("reads the pinned bundle as the run pinned it: its manifest as checked at the pin, its flow graph through it, and names only what it read", async () => {
    const run = setup();
    const { bundle, log, asked } = await pinnedA((flow) => ({
      graph: WHOLE_A.flows[flow] as FlowGraph,
      from: "postgres",
    }));
    run.pinned = bundle;
    const called = await run.call();

    expect(called.answer).toEqual(TURN_ONE.outcome);
    // Flow A was asked of the pinned bundle (by the frontier, then by its hubs-and-doors source), never flow B, which the
    // manifest does not list; the pinned bundle read it once.
    expect(asked).toEqual(["A", "A"]);
    expect(log.map((entry) => [entry.key, entry.from])).toEqual([
      [keyIn(BUNDLE_A, "manifest"), "postgres"],
      [keyIn(BUNDLE_A, "flow/A"), "postgres"],
    ]);
    // The manifest was the pin's read (its lease span names it): the frontier's span names only its own part.
    expect(called.spans[0]?.got).toMatchObject({ bundleParts: ["flow/A"], bundleFrom: ["postgres"] });
    // Nothing went past the pinned bundle to KV or to PostgreSQL's copy.
    expect(run.bundles.kvReads).toEqual([]);
    expect(run.bundles.calls).toEqual([]);
  });

  it("a request naming another bundle than the run pinned reads that one by its id, never the pinned one's values", async () => {
    const run = setup();
    const { bundle, log } = await pinnedA(() => {
      throw new Error("the pinned bundle is not the one asked for");
    });
    run.pinned = { ...bundle, bundleId: BUNDLE_B };
    const called = await run.call();

    expect(called.answer).toEqual(TURN_ONE.outcome);
    expect(log).toHaveLength(1);
    expect(run.bundles.kvReads).toEqual([keyIn(BUNDLE_A, "manifest"), keyIn(BUNDLE_A, "flow/A")]);
  });
});
