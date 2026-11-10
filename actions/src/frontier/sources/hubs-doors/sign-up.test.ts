// T-1147's proofs: the sign-up door to S1-01 (K-02 v1.1 default 9; ADR-013 sections 2 and 3; K-09 v1.5 default 129),
// which T-293's hubs-and-doors source offers when the guard finds no target, and only when the pinned bundle holds its
// step; and that source wired into its slot (assemble/registry.ts frontierSources, which buildFrontier's handler uses),
// so buildFrontier offers its choices with no stand-in.
//
// Expected values come from the contracts, never from the code under test: the door is build-frontier-s1-01.json's c-01
// (K-09 v1.5), which is K-02 v1.1's context-s1-01.json's; the stored state is Sam's first text as that fixture's note
// gives it (no role, no open question, no booking, no phone row: K-05 v1.2 targets-first-text.json); the bundles are
// K-01 v1's bundle-v0-skeleton.json (the bundle the fixture's turn pins) and bundle-mini-a.json, bundle v0 as bundles/v0
// publishes it (its id read from its manifest), and fixture set v1's two master flows as the emitter compiles them.

import { beforeAll, describe, expect, it } from "vitest";

import { isLabel } from "../../../../../runtime/src/trace";
import { FrontierError } from "../../assemble/handler";
import { FRONTIER_SOURCES, SLOT_NAMES, frontierSources } from "../../assemble/registry";
import {
  bundleIdOf,
  callBuildFrontier,
  checks,
  draftOf,
  fakeBundles,
  s102Exchange,
  sampleBundle,
  stringsIn,
  type BundleDocument,
  type Called,
} from "../../assemble/test-support";
import {
  bundleKey,
  type Context,
  type DraftChoice,
  type FlowLetter,
  type SourceOffer,
} from "../../assemble/types";
import { HUBS_AND_DOORS, SIGN_UP, offerHubsAndDoors } from "./hubs-doors";
import {
  ALEX_HAIRCUT_VISIT,
  LEES_BARBERSHOP,
  LEE_HOME_SERVICES,
  alexHaircut,
  alexState,
  frontierRequest,
  holdsStep,
  masterBundle,
  prepare,
  publishedBundleV0,
  s101Exchange,
  samFirstTextSeed,
  samFirstTextState,
  samState,
  storedSections,
  storedStep,
  withoutStep,
  type Business,
  type InputOptions,
  type Prepared,
} from "./test-support";

const { validator, checker } = checks();

const BUNDLE_V0 = sampleBundle("bundle-v0-skeleton.json");
const MINI_A = sampleBundle("bundle-mini-a.json");
let MASTER: BundleDocument;

beforeAll(async () => {
  MASTER = await masterBundle();
}, 120_000);

/** K-01 v1's five door steps (routingTables.doors), none of which bundle v0 holds (K-09 v1.5 default 129). */
const FIVE_DOOR_STEPS = ["A3-51", "A3-43", "S11-12", "S11-42", "S11-21"];

/** The guard found no target: no role, no open question, no booking (K-09 v1 guardTargets; arch 02 line 115). */
const NO_TARGET = { roles: [], openQuestionIds: [], bookingIds: [], noTarget: true };

/** build-frontier-s1-01.json's one choice, c-01, as a source offers it (no id), about `business`. */
function fixtureDoor(business: Business = LEES_BARBERSHOP): DraftChoice {
  const [door, ...rest] = s101Exchange().outcome.context.choices;
  if (door === undefined || rest.length > 0) throw new Error("build-frontier-s1-01.json gives one choice");
  return {
    ...draftOf(door),
    target: { businessId: business.id, businessName: business.name, bookingId: null, visitAt: null },
  };
}

/** Sam's first text under a business, in its flow, the guard having found no target. */
function firstText(
  documents: BundleDocument[],
  business = LEES_BARBERSHOP,
  flow: FlowLetter = "A",
): InputOptions {
  return {
    state: samFirstTextState((state) => {
      state.businessId = business.id;
    }),
    documents,
    business,
    flow,
    request: frontierRequest(business.id, NO_TARGET),
  };
}

/** The source's offer for one input, each choice held to K-02 v1.1. */
async function offerFor(options: InputOptions): Promise<Prepared & { offer: SourceOffer }> {
  const prepared = await prepare(options);
  const offer = await offerHubsAndDoors(prepared.input, prepared.port);
  for (const choice of offer.choices) {
    expect(checker.check("choice", { ...choice, choiceId: "c-00" })).toEqual([]);
  }
  return { ...prepared, offer };
}

/** Each door offered, by its key and step. */
function doorsOf(offer: SourceOffer): [string | null, string][] {
  return offer.choices.filter((choice) => choice.kind === "door").map((choice) => [choice.door, choice.step]);
}

/** The context of a call that answered one. */
function contextOf(called: Called): Context {
  if (!called.answer.ok || !("context" in called.answer.value)) throw new Error("no context");
  return called.answer.value.context;
}

describe("the sign-up door to S1-01 (K-02 v1.1 default 9), from the hubs-and-doors source", () => {
  it("Sam's first text on bundle v0: the one door, S1-01's, build-frontier-s1-01.json's c-01; one read of the graph", async () => {
    // What the door is made of, as the stored bundle holds it: section 1, '1. Business onboarding', opens with S1-01.
    const [one] = storedSections(BUNDLE_V0, "A");
    expect(one).toMatchObject({ n: 1, title: "1. Business onboarding" });
    expect(one?.steps[0]).toBe("S1-01");
    expect(String(storedStep(BUNDLE_V0, "A", "S1-01").does)).toContain(fixtureDoor().definition);
    expect(fixtureDoor()).toMatchObject({
      door: SIGN_UP,
      step: "S1-01",
      label: "Business onboarding",
      fields: [],
    });

    const { offer, port, log } = await offerFor(firstText([BUNDLE_V0]));
    expect(offer.choices).toEqual([fixtureDoor()]);
    expect(offer.cards).toEqual([]);
    expect(offer.openQuestions).toEqual([]);
    expect(port.reads).toEqual([`${bundleKey(bundleIdOf(BUNDLE_V0))}/flow/A`]);
    expect(log.lines).toEqual([]);
  });

  it("bundle v0 as bundles/v0 publishes it (T-1146's rebuild, its id its manifest's) gives the same one door", async () => {
    const published = publishedBundleV0();
    const { offer, port, log } = await offerFor(firstText([published]));
    expect(offer.choices).toEqual([fixtureDoor()]);
    expect(port.reads).toEqual([`${bundleKey(bundleIdOf(published))}/flow/A`]);
    expect(log.lines).toEqual([]);
  });

  it("no target on the whole master: the new-booking door, then the sign-up door (K-02 v1.1's order), in both flows", async () => {
    const a = await offerFor(firstText([MASTER]));
    expect(doorsOf(a.offer)).toEqual([
      ["newBooking", "A3-51"],
      [SIGN_UP, "S1-01"],
    ]);
    expect(a.offer.choices[1]).toEqual(fixtureDoor());
    expect(a.log.lines).toEqual([]);

    // Flow B's graph names its own section 1, which opens with the same shared step (K-01 README default 4).
    expect(storedSections(MASTER, "B")[0]?.steps[0]).toBe("S1-01");
    const b = await offerFor(firstText([MASTER], LEE_HOME_SERVICES, "B"));
    expect(doorsOf(b.offer)).toEqual([
      ["newBooking", "B3-40"],
      [SIGN_UP, "S1-01"],
    ]);
    expect(b.offer.choices[1]).toEqual(fixtureDoor(LEE_HOME_SERVICES));
  });

  it("a door whose step the pinned bundle lacks is not offered: K-01's five on bundle v0, the sign-up door without S1-01", async () => {
    // Bundle v0 holds none of the five door steps, so its first text gets the sign-up door alone (the first proof above);
    // the new-booking door, open to anyone, is offered wherever A3-51 is held.
    expect(FIVE_DOOR_STEPS.filter((step) => holdsStep(BUNDLE_V0, "A", step))).toEqual([]);

    // bundle-mini-a holds A3-51, not S1-01: the new-booking door alone, nothing logged (a partial bundle's missing step
    // is not reachable there: K-01 README).
    expect([holdsStep(MINI_A, "A", "A3-51"), holdsStep(MINI_A, "A", "S1-01")]).toEqual([true, false]);
    const mini = await offerFor(firstText([MINI_A]));
    expect(doorsOf(mini.offer)).toEqual([["newBooking", "A3-51"]]);
    expect(mini.log.lines).toEqual([]);

    // Bundle v0 without S1-01: no door at all, nothing logged.
    const v0 = await offerFor(firstText([withoutStep(BUNDLE_V0, "A", "S1-01")]));
    expect(v0.offer.choices).toEqual([]);
    expect(v0.log.lines).toEqual([]);

    // The whole master without S1-01: the new-booking door stays; the sign-up door is not offered, logged by its step.
    const master = await offerFor(firstText([withoutStep(MASTER, "A", "S1-01")]));
    expect(doorsOf(master.offer)).toEqual([["newBooking", "A3-51"]]);
    expect(master.log.lines.map((line) => [line.msg, line.source, line.step ?? null])).toEqual([
      ["frontier_step_missing", HUBS_AND_DOORS, "S1-01"],
    ]);
  });

  it("a handle with a target gets no sign-up door: Sam at S1-02 (bundle v0, the master), Alex with his booking", async () => {
    for (const document of [BUNDLE_V0, MASTER]) {
      const { offer } = await offerFor({
        state: samState(),
        documents: [document],
        request: frontierRequest(LEES_BARBERSHOP.id),
      });
      expect(doorsOf(offer).map(([door]) => door)).not.toContain(SIGN_UP);
    }
    // On the master Sam, an owner, gets his doors (T-293), but not the sign-up door.
    const owner = await offerFor({
      state: samState(),
      documents: [MASTER],
      request: frontierRequest(LEES_BARBERSHOP.id),
    });
    expect(doorsOf(owner.offer).length).toBeGreaterThan(0);

    const alex = await offerFor({
      state: alexState(),
      documents: [MASTER],
      visits: { "booking-alex-haircut": ALEX_HAIRCUT_VISIT },
      request: frontierRequest(LEES_BARBERSHOP.id, {
        roles: [{ businessId: LEES_BARBERSHOP.id, personId: "person-alex", role: "customer" }],
        openQuestionIds: ["oq-a7-03-alex"],
        bookingIds: ["booking-alex-haircut"],
        noTarget: false,
      }),
    });
    expect(doorsOf(alex.offer)).toEqual([
      ["newBooking", "A3-51"],
      ["existingBooking", "A3-43"],
    ]);
  });

  it("each target alone gives none on bundle v0, nor does one the read holds while the guard found none (fail closed)", async () => {
    const samQuestion = samState().openQuestions[0];
    if (samQuestion === undefined) throw new Error("Sam's state holds S1-02's question");
    const targets = [
      {
        what: "a role",
        change: (state: InputOptions["state"]) => {
          state.roles = [
            { roleId: "role-sam-barbershop", personId: "person-sam", role: "owner", version: 1 },
          ];
        },
        guard: {
          roles: [{ businessId: LEES_BARBERSHOP.id, personId: "person-sam", role: "owner" as const }],
        },
      },
      {
        what: "an open question",
        change: (state: InputOptions["state"]) => {
          state.openQuestions = [samQuestion];
        },
        guard: { openQuestionIds: [samQuestion.id] },
      },
      {
        what: "a booking",
        change: (state: InputOptions["state"]) => {
          state.bookings = [alexHaircut()];
        },
        guard: { bookingIds: ["booking-alex-haircut"] },
      },
    ];
    for (const { what, change, guard } of targets) {
      const listed = await offerFor({
        ...firstText([BUNDLE_V0]),
        state: samFirstTextState(change),
        request: frontierRequest(LEES_BARBERSHOP.id, { ...NO_TARGET, ...guard, noTarget: false }),
      });
      expect(listed.offer.choices, `the guard lists ${what}`).toEqual([]);
      const readOnly = await offerFor({ ...firstText([BUNDLE_V0]), state: samFirstTextState(change) });
      expect(readOnly.offer.choices, `only the read holds ${what}`).toEqual([]);
    }
    // The guard listing a target while saying noTarget is no first text either.
    const contradicting = await offerFor({
      ...firstText([BUNDLE_V0]),
      request: frontierRequest(LEES_BARBERSHOP.id, { ...NO_TARGET, openQuestionIds: [samQuestion.id] }),
    });
    expect(contradicting.offer.choices).toEqual([]);
  });

  it("a graph with no section 1, or a port that answers no graph: no sign-up door, logged by labels only", async () => {
    const noSections = structuredClone(BUNDLE_V0);
    (noSections.flows.A as { sections: unknown[] }).sections = [];
    const sectionless = await offerFor(firstText([noSections]));
    expect(sectionless.offer.choices).toEqual([]);
    expect(sectionless.log.lines.map((line) => [line.msg, line.source, line.step ?? null])).toEqual([
      ["frontier_step_missing", HUBS_AND_DOORS, null],
    ]);

    const prepared = await prepare(firstText([BUNDLE_V0]));
    const offer = await offerHubsAndDoors(prepared.input, fakeBundles());
    expect(offer.choices).toEqual([]);
    expect(prepared.log.lines.map((line) => [line.msg, line.source, line.step ?? null])).toEqual([
      ["frontier_bundle_missing", HUBS_AND_DOORS, null],
    ]);

    for (const line of [...sectionless.log.lines, ...prepared.log.lines]) {
      expect(stringsIn(line).every((value) => isLabel(value))).toBe(true);
    }
  });
});

describe("wired into its slot: buildFrontier with the registry's own slots, no stand-in", () => {
  it("the registry makes its slots for the frontier's bundles port: the open questions and the hubs and doors built", () => {
    const slots = frontierSources(fakeBundles(BUNDLE_V0));
    expect(slots.map((slot) => slot.name)).toEqual([...SLOT_NAMES]);
    expect(slots.map((slot) => slot.source?.name ?? null)).toEqual([
      "openQuestions",
      null,
      HUBS_AND_DOORS,
      null,
    ]);
    expect(FRONTIER_SOURCES.map((slot) => slot.source?.name ?? null)).toEqual([
      "openQuestions",
      null,
      HUBS_AND_DOORS,
      null,
    ]);
  });

  it("build-frontier-s1-01.json's request gives exactly its one choice on bundle v0: the fixture's whole answer", async () => {
    const exchange = s101Exchange();
    const called = await callBuildFrontier(exchange.request, {
      seed: samFirstTextSeed(),
      bundles: fakeBundles(BUNDLE_V0),
    });
    expect(called.answer).toEqual({ ok: true, value: exchange.outcome });
    const context = contextOf(called);
    expect(context.choices.map((choice) => [choice.choiceId, choice.door, choice.step])).toEqual([
      ["c-01", SIGN_UP, "S1-01"],
    ]);
    expect(checker.check("context", context)).toEqual([]);
    expect(validator.check("buildFrontier", "response", called.answer.ok && called.answer.value)).toEqual([]);
    // Only the slots still unbuilt are logged; the hubs and doors are built and log nothing here.
    expect(called.log.lines.map((line) => [line.msg, line.source])).toEqual([
      ["frontier_source_missing", "branchGates"],
      ["frontier_source_missing", "anyTime"],
    ]);
    expect(called.spans).toHaveLength(1);
    expect(called.spans[0]).toMatchObject({ hop: "frontier", outcome: "ok" });
    expect(called.scope.events.at(-1)).toEqual({ what: "commit" });
  });

  it("the same request pinned to bundle v0 as bundles/v0 publishes it (…/2): the same one choice, under its id", async () => {
    const published = publishedBundleV0();
    const bundleId = bundleIdOf(published);
    const exchange = s101Exchange();
    const request = { ...exchange.request, turn: { ...exchange.request.turn, bundleId } };
    const called = await callBuildFrontier(request, {
      seed: samFirstTextSeed(),
      bundles: fakeBundles(published),
    });
    const context = contextOf(called);
    expect(context.bundleId).toEqual(bundleId);
    expect(context.choices).toEqual(exchange.outcome.context.choices);
    expect(checker.check("context", context)).toEqual([]);
  });

  it("Sam's S1-02 turn pinned to bundle-mini-a: S1-02's three options, then the door A3-51; no sign-up door", async () => {
    const exchange = s102Exchange();
    const request = { ...exchange.request, turn: { ...exchange.request.turn, bundleId: bundleIdOf(MINI_A) } };
    const called = await callBuildFrontier(request, { bundles: fakeBundles(MINI_A, BUNDLE_V0) });
    const context = contextOf(called);
    expect(context.choices.map((choice) => [choice.choiceId, choice.kind, choice.step, choice.door])).toEqual(
      [
        ["c-01", "option", "S1-02", null],
        ["c-02", "option", "S1-02", null],
        ["c-03", "option", "S1-02", null],
        ["c-04", "door", "A3-51", "newBooking"],
      ],
    );
    expect(checker.check("context", context)).toEqual([]);
  });

  it("a handle with a target: build-frontier-s1-02.json's request on bundle v0 gives S1-02's options alone", async () => {
    const called = await callBuildFrontier(s102Exchange().request);
    expect(contextOf(called).choices.map((choice) => [choice.kind, choice.step])).toEqual([
      ["option", "S1-02"],
      ["option", "S1-02"],
      ["option", "S1-02"],
    ]);
    expect(called.log.lines.filter((line) => line.source === HUBS_AND_DOORS)).toEqual([]);
  });

  it("a first text on a bundle without S1-01: no choice at all, so buildFrontier fails closed (noChoices)", async () => {
    const called = await callBuildFrontier(s101Exchange().request, {
      seed: samFirstTextSeed(),
      bundles: fakeBundles(withoutStep(BUNDLE_V0, "A", "S1-01")),
    });
    expect(called.answer.ok).toBe(false);
    const error = called.answer.ok ? undefined : called.answer.error;
    expect(error).toBeInstanceOf(FrontierError);
    expect((error as FrontierError).code).toBe("noChoices");
    expect(called.scope.events.at(-1)).toEqual({ what: "rollback" });
  });
});
