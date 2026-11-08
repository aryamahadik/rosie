// The bundle as the frontier reads it (T-291): K-01 v1's sample bundles narrowed field by field, so a value that is
// not K-01's shape gives no step rather than a wrong one, and the routing tables are there for the later sources.

import { describe, expect, it } from "vitest";

import { findStep, flowOfStep, flowViewOf, flowsListed, readBundle, readManifest } from "./bundle";
import { BUNDLE_V0, bundleIdOf, fakeBundles, sampleBundle } from "./test-support";

const V0 = sampleBundle("bundle-v0-skeleton.json");
const MINI_A = sampleBundle("bundle-mini-a.json");

describe("a flow graph (K-01 v1 flowGraph)", () => {
  it("bundle v0's flow A: S1-02 asks, with its three message branches, its gives and its card", () => {
    const flow = flowViewOf(V0.flows.A, "A");
    const step = flow?.step("S1-02");
    expect(step?.asks).toBe(true);
    expect(step?.gives).toEqual(["kinds"]);
    expect(step?.branches.map((branch) => [branch.label, branch.tag, branch.end])).toEqual([
      ["All on the list", "message", "merge"],
      ["One isn't on the list yet", "message", "merge"],
      ["Not a service we book", "message", "end"],
    ]);
    expect(step?.card?.question).toBe("Is each one on Rosie's list?");
    // S1-01 does not ask: it only gives the thread and goes on to S1-02.
    expect(flow?.step("S1-01")).toMatchObject({ asks: false, gives: ["thread"], next: "S1-02" });
    // A step the bundle does not hold is no step (bundle v0 is partial: S1-11 is not reachable).
    expect(flow?.step("S1-11")).toBeNull();
  });

  it("the always-on prefix's hash and the routing tables, for the hubs, doors and any-time sources", () => {
    const flow = flowViewOf(V0.flows.A, "A");
    expect(flow?.alwaysOnSha256).toBe("18d7f9c761c1f58436d2e3e9148b64386221b1d0affa33a8c7b0226c06b6ebea");
    expect(flow?.routing.doors).toMatchObject({ unclearOwnerOrHelp: "S11-21", newBooking: "A3-51" });
    expect(flow?.routing.hubs).toMatchObject({ booked: "A7-02", owner: "S11-12" });
  });

  it("a value that is not K-01's graph of that flow gives none", () => {
    expect(flowViewOf(V0.flows.A, "B")).toBeNull();
    expect(flowViewOf({ ...(V0.flows.A as object), contract: "bundle.v2" }, "A")).toBeNull();
    expect(flowViewOf(null, "A")).toBeNull();
    expect(flowViewOf("{}", "A")).toBeNull();
  });

  it("a step whose own id is another's, or a branch with no label, is left out", () => {
    const graph = structuredClone(V0.flows.A) as { steps: Record<string, Record<string, unknown>> };
    const s102 = graph.steps["S1-02"];
    if (s102 === undefined) throw new Error("no S1-02");
    graph.steps["S1-99"] = { ...s102 };
    (s102.branches as Record<string, unknown>[])[0] = { tag: "message" };
    const flow = flowViewOf(graph, "A");
    expect(flow?.step("S1-99")).toBeNull();
    expect(flow?.step("S1-02")?.branches.map((branch) => branch.label)).toEqual([
      "One isn't on the list yet",
      "Not a service we book",
    ]);
  });
});

describe("a bundle's manifest and flows", () => {
  it("the flows a manifest lists, and whether the bundle is partial", async () => {
    expect(flowsListed(V0.manifest)).toEqual(["A"]);
    expect(flowsListed({})).toEqual(["A", "B"]);
    const bundles = fakeBundles(V0, MINI_A);
    expect(await readManifest(bundles, BUNDLE_V0)).toEqual({ partial: true, flows: ["A"] });
    expect(await readManifest(bundles, { hash: "e".repeat(64), build: 1 })).toBeNull();
    const manifest = await readManifest(bundles, bundleIdOf(MINI_A));
    if (manifest === null) throw new Error("no manifest");
    const bundle = await readBundle(bundles, bundleIdOf(MINI_A), manifest, ["A", "B"]);
    expect(Object.keys(bundle.flows)).toEqual(manifest.flows);
  });

  it("finds an A or B step in its own flow, and a shared step in the context's flow first", () => {
    expect([flowOfStep("A6-02"), flowOfStep("B7-05"), flowOfStep("S1-02")]).toEqual(["A", "B", null]);
    const v0 = flowViewOf(V0.flows.A, "A");
    if (v0 === null) throw new Error("no flow");
    const bundle = { bundleId: BUNDLE_V0, partial: true, flows: { A: v0 } };
    expect(findStep(bundle, "S1-02", "B")?.flow.flow).toBe("A");
    expect(findStep(bundle, "S1-02", "A")?.step.id).toBe("S1-02");
    expect(findStep(bundle, "B1-02", "A")).toBeNull();
  });
});
