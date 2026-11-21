// The bundle as the frontier reads it (T-291): K-01 v1's sample bundles narrowed field by field, so a value that is
// not K-01's shape gives no step rather than a wrong one, and the routing tables are there for the later sources.
// And each choice's own walk (ownStakes, which T-292 to T-294 reuse): it stops only where someone is asked, a clock
// waits or the path ends, and walks through every split code settles (contracts/model README, "Stakes"; arch 03 lines
// 161 and 191). The walks run over bundle-mini-a with the master's own steps around it (test-support.ts): rule 9.

import { describe, expect, it } from "vitest";

import {
  findStep,
  flowOfStep,
  flowViewOf,
  flowsListed,
  ownStakes,
  plainStepStakes,
  readBundle,
  readManifest,
} from "./bundle";
import {
  BUNDLE_V0,
  MASTER_A5_01,
  MASTER_A5_19,
  MASTER_A6_01,
  MASTER_A6_03,
  MASTER_A6_10,
  MASTER_A6_10_AS_WRITTEN,
  bundleIdOf,
  fakeBundles,
  publishedBundle,
  sampleBundle,
  withStepChanged,
  withSteps,
  type BundleDocument,
  type StepJson,
} from "./test-support";
import type { BundleView, FlowView, StakesReason } from "./types";

const V0 = sampleBundle("bundle-v0-skeleton.json");
const MINI_A = sampleBundle("bundle-mini-a.json");

describe("a flow graph (K-01 v1 flowGraph)", () => {
  it("bundle v0's flow A: S1-02 asks, with its three message branches, its gives and its card", () => {
    const flow = flowViewOf(V0.flows.A, "A");
    const step = flow?.step("S1-02");
    expect(step?.split).toBe("asks");
    expect(step?.gives).toEqual(["kinds"]);
    expect(step?.branches.map((branch) => [branch.label, branch.tag, branch.end])).toEqual([
      ["All on the list", "message", "merge"],
      ["One isn't on the list yet", "message", "merge"],
      ["Not a service we book", "message", "end"],
    ]);
    expect(step?.card?.question).toBe("Is each one on Rosie's list?");
    // S1-01 does not ask: it is no split, it only gives the thread and goes on to S1-02.
    expect(flow?.step("S1-01")).toMatchObject({ split: null, gives: ["thread"], next: "S1-02" });
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

  it("each step on a branch's list knows that branch; a step on its section's main path has none", () => {
    const flow = flowViewOf(withSteps(MINI_A, [MASTER_A6_01]).flows.A, "A");
    expect(flow?.enclosing("A6-02").map((each) => [each.split.id, each.branch.label])).toEqual([
      ["A6-01", "Sam's OK first"],
    ]);
    expect(flow?.enclosing("A5-05").map((each) => [each.split.id, each.branch.label])).toEqual([
      ["A5-04", "Nothing taken"],
    ]);
    expect(flow?.enclosing("A6-14")).toEqual([]);
    // bundle-mini-a alone does not hold A6-01, so nothing there lists A6-02.
    expect(flowViewOf(MINI_A.flows.A, "A")?.enclosing("A6-02")).toEqual([]);
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

// ---------------------------------------------------------------------------------------------------------------
// Each choice's own walk

/** A bundle document's flow A, read as the frontier reads it (partial as its manifest says). */
function viewOf(document: BundleDocument): { bundle: BundleView; flow: FlowView } {
  const flow = flowViewOf(document.flows.A, "A");
  if (flow === null) throw new Error("no flow A");
  return {
    bundle: {
      bundleId: bundleIdOf(document),
      partial: document.manifest.partial === true,
      flows: { A: flow },
    },
    flow,
  };
}

/** ownStakes for one option (`label`) of one asked step, over a bundle document's flow A. */
function stakesOf(document: BundleDocument, stepId: string, label: string): StakesReason[] {
  const { bundle, flow } = viewOf(document);
  const step = flow.step(stepId);
  const branch = step?.branches.find((each) => each.label === label);
  if (step === null || branch === undefined) throw new Error(`no ${stepId} '${label}'`);
  return ownStakes(bundle, flow, step, branch);
}

const UNKNOWN: StakesReason = { why: "unknown", step: null, ref: null };

/** bundle-mini-a with the master's A6-01, A6-03 and A6-10 around its A6-02 (partial unless told). */
function aroundA602(a610: StepJson = MASTER_A6_10, partial = true): BundleDocument {
  return withSteps(MINI_A, [MASTER_A6_01, MASTER_A6_03, a610], partial);
}

describe("a split is what its branches' tags make it (K-01 v1 branch.tag; arch 03 line 161)", () => {
  it("asks on a message or clock branch, code when every branch is a lookup; its via does not decide it", () => {
    const { flow } = viewOf(withSteps(MINI_A, [MASTER_A6_01, MASTER_A6_03, MASTER_A6_10, MASTER_A5_19]));
    expect(
      ["A6-02", "A5-31", "A3-51", "A7-02", "A5-04", "A5-19", "A6-01", "A6-10", "A6-03", "A6-14"].map((id) => [
        id,
        flow.step(id)?.split,
      ]),
    ).toEqual([
      ["A6-02", "asks"], // message branches and a clock: Sam is asked, with a deadline
      ["A5-31", "asks"], // via auto, but message branches and a clock: the page's yes, or its clock
      ["A3-51", "asks"], // via auto, the door: message branches
      ["A7-02", "asks"], // via auto, the hub: message branches
      ["A5-04", "code"], // via auto, every branch a lookup: what's taken now
      ["A5-19", "code"], // the plug-in's rules
      ["A6-01", "code"], // the page's choice, never decided again
      ["A6-10", "code"], // via sync, the booking write's own outcome
      ["A6-03", null], // a plain step
      ["A6-14", null],
    ]);
  });
});

describe("each option's own walk (ownStakes; contracts/model README, 'Stakes')", () => {
  it("a walk that meets a code-settled split goes down every branch: A5-01's 'None' passes A5-19 and A5-04, money", () => {
    // 'None' rejoins at A5-19 (code: 'No' goes straight on to A5-04; A5-20 is not in this partial bundle), then A5-04
    // (code: each branch writes what's taken, and its page step gives it), whose branches all rejoin at A5-31, which asks
    // ("Is the page done?"): there every path stops, walked once.
    const money = (step: string, ref: string): StakesReason => ({ why: "money", step, ref });
    expect(stakesOf(withSteps(MINI_A, [MASTER_A5_01, MASTER_A5_19]), "A5-01", "None")).toEqual([
      money("A5-04", "money_before"),
      money("A5-05", "money_before"),
      money("A5-04", "card_saved"),
      money("A5-07", "money_before"),
      money("A5-07", "card_saved"),
      money("A5-04", "deposit_paid"),
      money("A5-13", "money_before"),
      money("A5-13", "card_saved"),
      money("A5-13", "deposit_paid"),
      money("A5-04", "paid_full"),
      money("A5-16", "money_before"),
      money("A5-16", "paid_full"),
    ]);
  });

  it("where a list ends, the branch holding it decides: A6-02's '1 Accept' walks on through A6-01 to A6-10, which books", () => {
    // '1 Accept' lists A6-03, the end of its list; A6-02 ends A6-01's 'Sam's OK first', which rejoins at A6-10. A6-10 is
    // settled by code and gives booked; its branches go on to A6-14 (gives code) or to steps this partial bundle lacks.
    const bundle = aroundA602();
    expect(stakesOf(bundle, "A6-02", "1 Accept")).toEqual([{ why: "booked", step: "A6-10", ref: "booked" }]);
    // '2 Another time' and '3 Decline' list A6-04 and A6-05, which the partial bundle does not hold (not reachable).
    expect(stakesOf(bundle, "A6-02", "2 Another time")).toEqual([]);
    expect(stakesOf(bundle, "A6-02", "3 Decline")).toEqual([]);
    // Without A6-01, the step holding A6-02's list is not in the partial bundle: not reachable, so low.
    expect(stakesOf(MINI_A, "A6-02", "1 Accept")).toEqual([]);
  });

  it("a split the walk cannot classify is unknown, the safer route", () => {
    const branches = MASTER_A6_10.branches ?? [];
    const variants: [string, StepJson][] = [
      ["as the master writes it, before the compiler tags its branches", MASTER_A6_10_AS_WRITTEN],
      [
        "its branches tagged message, on a sync split (nobody there to ask)",
        { ...MASTER_A6_10, branches: branches.map((branch) => ({ ...branch, tag: "message" })) },
      ],
      [
        "a branch with a tag that is none of K-01's three",
        { ...MASTER_A6_10, branches: [...branches, { ...branches[0], label: "Other", tag: "auto" }] },
      ],
      ["no branch at all", { ...MASTER_A6_10, branches: [] }],
      [
        "a branch the frontier cannot read (no label)",
        {
          ...MASTER_A6_10,
          branches: branches.map((branch, index) =>
            index === 0
              ? Object.fromEntries(Object.entries(branch).filter(([key]) => key !== "label"))
              : branch,
          ),
        },
      ],
    ];
    for (const [why, a610] of variants) {
      const bundle = aroundA602(a610);
      expect(viewOf(bundle).flow.step("A6-10")?.split, why).toBe("unknown");
      expect(stakesOf(bundle, "A6-02", "1 Accept"), why).toEqual([UNKNOWN]);
    }
  });

  it("in a full bundle a step the walk cannot find cannot be walked: unknown, listed after what it found", () => {
    // Full, A6-10's branches reach A6-15 (after A6-14), A6-11 and A6-32, none of which this bundle holds.
    expect(stakesOf(aroundA602(MASTER_A6_10, false), "A6-02", "1 Accept")).toEqual([
      { why: "booked", step: "A6-10", ref: "booked" },
      UNKNOWN,
    ]);
  });

  it("a walk that comes back to a step on its own path is a loop (the compiler rejects loops): unknown", () => {
    // A6-10's 'Yes' pointed back at A6-01, whose branches lead to A6-10 and A6-02 again.
    const branches = MASTER_A6_10.branches ?? [];
    const looping: StepJson = {
      ...MASTER_A6_10,
      branches: branches.map((branch, index) => (index === 0 ? { ...branch, rejoinAt: "A6-01" } : branch)),
    };
    expect(stakesOf(aroundA602(looping), "A6-02", "1 Accept")).toEqual([
      { why: "booked", step: "A6-10", ref: "booked" },
      UNKNOWN,
    ]);
  });

  it("a list whose steps end before its last one cannot be walked: unknown", () => {
    // A6-01's 'Sam's OK first' listing a step after A6-02, while A6-02's own next is null.
    const a601: StepJson = {
      ...MASTER_A6_01,
      branches: (MASTER_A6_01.branches ?? []).map((branch, index) =>
        index === 1 ? { ...branch, steps: ["A6-02", "A6-14"] } : branch,
      ),
    };
    expect(stakesOf(withSteps(MINI_A, [a601, MASTER_A6_03, MASTER_A6_10]), "A6-02", "1 Accept")).toEqual([
      UNKNOWN,
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T-1478: a plain step's buttons, and the walk of its answer (K-09 README v1.11 default 179)

const V1 = publishedBundle("v1");
const V2 = publishedBundle("v2");
const S1_04_BUTTONS = ["Some share one", "All share one", "Each is its own"];

type Message = Record<string, unknown>;

/** The step's messages (K-01 v1 step.say), for a test to change. */
function sayOf(step: Record<string, unknown>): Message[] {
  if (!Array.isArray(step.say)) throw new Error("the step has no messages");
  return step.say as Message[];
}

/** Rosie's first message of the step (K-01 v1 message.from "san"). */
function rosiesMessage(step: Record<string, unknown>): Message {
  const message = sayOf(step).find((each) => each.from === "san");
  if (message === undefined) throw new Error("Rosie sends nothing in the step");
  return message;
}

/** A bundle document's flow A's S1-04 answer stakes (plainStepStakes). */
function s104Stakes(document: BundleDocument): StakesReason[] {
  const { bundle, flow } = viewOf(document);
  const step = flow.step("S1-04");
  if (step === null) throw new Error("no S1-04");
  return plainStepStakes(bundle, flow, step);
}

describe("T-1478: the button labels of the messages Rosie sends in a step (K-01 v1 message elements.buttons)", () => {
  it("bundle v1's S1-04 is a plain step with no card and Rosie's three buttons, in order; the owner's reply adds none", () => {
    const step = flowViewOf(V1.flows.A, "A")?.step("S1-04");
    expect(step).toMatchObject({
      split: null,
      card: null,
      branches: [],
      gives: ["companies"],
      next: "S1-08",
      buttons: S1_04_BUTTONS,
    });
    // Bundle v2 keeps S1-04 byte for byte (K-09 default 188), so its buttons are the same, in the same order.
    expect(flowViewOf(V2.flows.A, "A")?.step("S1-04")?.buttons).toEqual(S1_04_BUTTONS);
  });

  it("a step whose messages carry no buttons reads none; a split's own buttons are read as they are", () => {
    const v2 = flowViewOf(V2.flows.A, "A");
    for (const id of ["S1-01", "S1-02", "S1-03", "S1-74", "S1-11", "S1-08"]) {
      expect(v2?.step(id)?.buttons, id).toEqual([]);
    }
    // S1-09 asks with buttons and is a split with its card: Rosie's two buttons, and not the owner's photos reply.
    expect(v2?.step("S1-09")).toMatchObject({
      split: "asks",
      buttons: ["Yes, an owner", "No, I help run it"],
    });
  });

  it("buttons on a message from anyone but Rosie add none", () => {
    const document = withStepChanged(V1, "S1-04", (step) => {
      const owner = sayOf(step).find((each) => each.from === "owner");
      if (owner === undefined) throw new Error("no owner message");
      owner.elements = { buttons: ["Plumbing", "Electrical"] };
    });
    expect(flowViewOf(document.flows.A, "A")?.step("S1-04")?.buttons).toEqual(S1_04_BUTTONS);
  });

  it("buttons the frontier cannot read as labels read null, never a guess: a lettered pair, a button with no words, buttons that are no list", () => {
    const variants: [string, unknown][] = [
      ["a lettered pair (K-01 button pair)", [...S1_04_BUTTONS.slice(0, 2), ["C", "Each is its own"]]],
      ["a button with no words", [...S1_04_BUTTONS, ""]],
      ["buttons that are no list", "Some share one"],
    ];
    for (const [why, buttons] of variants) {
      const document = withStepChanged(V1, "S1-04", (step) => {
        rosiesMessage(step).elements = { buttons };
      });
      expect(flowViewOf(document.flows.A, "A")?.step("S1-04")?.buttons, why).toBeNull();
    }
  });
});

describe("T-1478: the walk of a plain step's answer (plainStepStakes): its gives, then the walk from its next", () => {
  it("bundle v1: S1-04 gives companies (no stake) and its next, S1-08, is a step the partial bundle does not hold: low", () => {
    expect(s104Stakes(V1)).toEqual([]);
  });

  it("bundle v2: S1-04 walks on to S1-08, which only tells, and stops at S1-09's question, before it: low", () => {
    expect(s104Stakes(V2)).toEqual([]);
    // The walk passes S1-08: a charge on it would be met there.
    const chargeAtS108 = withStepChanged(V2, "S1-08", (step) => {
      step.effects = [{ kind: "charge", ref: "plan_fee", to: ["pay"] }];
    });
    expect(s104Stakes(chargeAtS108)).toEqual([{ why: "charge", step: "S1-08", ref: "plan_fee" }]);
    // S1-09 asks (its three message branches), so the walk stops before it: what it gives is never met...
    const s109Books = withStepChanged(V2, "S1-09", (step) => {
      step.gives = ["booked"];
    });
    expect(s104Stakes(s109Books)).toEqual([]);
    // ...while the same step as a plain one would be walked: S1-09 is where the walk stops because it asks.
    const s109Plain = withStepChanged(s109Books, "S1-09", (step) => {
      delete step.type;
      delete step.branches;
      delete step.card;
    });
    expect(s104Stakes(s109Plain)).toEqual([{ why: "booked", step: "S1-09", ref: "booked" }]);
    // And S1-09's ask stops it in a full bundle too, so S1-10, which bundle v2 does not hold, is never reached.
    expect(s104Stakes(withSteps(V2, [], false))).toEqual([]);
  });

  it("the step's own gives count: a money key written by the answer is high", () => {
    const moneyAtS104 = withStepChanged(V1, "S1-04", (step) => {
      step.gives = ["companies", "money_before"];
    });
    expect(s104Stakes(moneyAtS104)).toEqual([{ why: "money", step: "S1-04", ref: "money_before" }]);
  });

  it("a walk it cannot follow is unknown, the safer route: a missing step in a full bundle, a loop back to the asked step", () => {
    // Bundle v1 as a full bundle: S1-08 is missing, a fault, not a step out of reach.
    expect(s104Stakes(withSteps(V1, [], false))).toEqual([UNKNOWN]);
    const loop = withStepChanged(V2, "S1-08", (step) => {
      step.next = "S1-04";
    });
    expect(s104Stakes(loop)).toEqual([UNKNOWN]);
  });

  it("a plain step whose list ends with it and that no branch lists ends the journey there: nothing more to walk", () => {
    const last = withStepChanged(V1, "S1-04", (step) => {
      step.next = null;
    });
    expect(s104Stakes(withSteps(last, [], false))).toEqual([]);
  });
});
