// T-293's proofs: the frontier's hubs by the target booking's stage and its door entries (arch 03 lines 163 and 165;
// C-076; S13-20). Each hub and door step comes from the routing tables of the K-01 v1 bundle the turn pins: K-01's sample
// bundles (bundle-mini-a.json holds A3-51 and A7-02; bundle-mini-b.json B3-40 and B7-05; bundle v0 S1-01 and S1-02 alone)
// and fixture set v1's two master flows as the emitter compiles them (every hub and door step). The stored state is
// K-05 v1.2's own readTurnState fixtures and Sam's state at S1-02. Every offer is held to K-02 v1 (choice, step card).
//
// Expected values come from the sources, never from the code under test: each hub case is its branch's label and its
// card's definition as the stored bundle holds them; each door is its name as arch 03 line 165 writes it and the first
// sentence of its step as the master writes it (master-A.json and master-B.json `does`).

import { beforeAll, describe, expect, it } from "vitest";

import { isLabel } from "../../../../../runtime/src/trace";
import { createFrontierChecker } from "../../assemble/check";
import {
  bundleIdOf,
  callBuildFrontier,
  fakeBundles,
  s102Exchange,
  sampleBundle,
  stringsIn,
  type BundleDocument,
} from "../../assemble/test-support";
import type { DraftChoice, FlowLetter, SourceOffer, Target, Time } from "../../assemble/types";
import { openQuestionsSource } from "../open-questions";
import {
  DOOR_NAMES,
  HUBS_AND_DOORS,
  createHubsAndDoorsSource,
  offerHubsAndDoors,
  type DoorKey,
  type HubKey,
} from "./hubs-doors";
import {
  ALEX_DRAIN_VISIT,
  ALEX_HAIRCUT_VISIT,
  LEES_BARBERSHOP,
  LEE_HOME_SERVICES,
  alexDrain,
  alexHaircut,
  alexHomeState,
  alexQuestion,
  alexState,
  firstTextState,
  frontierRequest,
  masterBundle,
  prepare,
  samState,
  storedMeans,
  storedStep,
  storedTable,
  withPartial,
  withStepChanged,
  type Business,
  type InputOptions,
  type Prepared,
} from "./test-support";

type Json = Record<string, unknown>;

const checker = createFrontierChecker();

const MINI_A = sampleBundle("bundle-mini-a.json");
const MINI_B = sampleBundle("bundle-mini-b.json");
const BUNDLE_V0 = sampleBundle("bundle-v0-skeleton.json");
let MASTER: BundleDocument;

beforeAll(async () => {
  MASTER = await masterBundle();
}, 120_000);

/** Each door's name, as arch 03 line 165 writes it (K-02 v1 choice.label for a door). */
const NAMES: Record<DoorKey, string> = {
  newBooking: "A new booking or a question about the business",
  existingBooking: "A booking already made",
  ownerCommand: "An owner command",
  teamChange: "A team change",
  unclearOwnerOrHelp: "An unclear owner text or HELP",
};

/** The first sentence of each door step's `does`, as the master writes it (master-A.json and master-B.json). */
const FIRST_SENTENCES: Record<string, string> = {
  "A3-51": "After the danger check, Rosie reads what a new conversation is about.",
  "B3-40": "After the danger check, Rosie reads what a new conversation is about.",
  "A3-43": "A new conversation about a visit already booked, like a change or a question.",
  "B3-35": "A new conversation about a visit already booked, like a change or a question.",
  "S11-12": "Texts are for quick decisions.",
  "S11-42": "Each branch is one change to the team that can happen over the months.",
  "S11-21": "Nothing changes on a text Rosie can't act on for sure.",
};

/** The source's offer for one input, each choice and card held to K-02 v1. */
async function offerFor(options: InputOptions): Promise<Prepared & { offer: SourceOffer }> {
  const prepared = await prepare(options);
  const offer = await offerHubsAndDoors(prepared.input, prepared.port);
  for (const choice of offer.choices) {
    expect(checker.check("choice", { ...choice, choiceId: "c-00" })).toEqual([]);
  }
  for (const card of offer.cards) expect(checker.check("stepCard", card)).toEqual([]);
  expect(offer.openQuestions).toEqual([]);
  return { ...prepared, offer };
}

/** A choice without its stakes, for comparing what it is. */
function shape(choice: DraftChoice): Json {
  const rest: Json = { ...choice };
  delete rest.stakes;
  delete rest.stakesFrom;
  return rest;
}

function hubsOf(offer: SourceOffer): DraftChoice[] {
  return offer.choices.filter((choice) => choice.kind === "hub");
}

function doorsOf(offer: SourceOffer): DraftChoice[] {
  return offer.choices.filter((choice) => choice.kind === "door");
}

/** The hub step a flow graph's routing table names for a key, as stored. */
function hubStep(document: BundleDocument, flow: FlowLetter, key: HubKey): string {
  const step = storedTable(document, flow, "hubs")[key];
  if (typeof step !== "string") throw new Error(`flow ${flow} names no ${key} hub`);
  return step;
}

/** The door step a flow graph's routing table names for a key, as stored. */
function doorStep(document: BundleDocument, flow: FlowLetter, key: DoorKey): string {
  const step = storedTable(document, flow, "doors")[key];
  if (typeof step !== "string") throw new Error(`flow ${flow} names no ${key} door`);
  return step;
}

/** A hub's cases as its stored card defines them (one per branch, the label word for word), about `target`. */
function expectedCases(document: BundleDocument, flow: FlowLetter, key: HubKey, target: Target): Json[] {
  const step = hubStep(document, flow, key);
  return storedMeans(storedStep(document, flow, step)).map((means) => ({
    kind: "hub",
    question: step,
    branch: means.branch,
    anytimeRow: null,
    door: null,
    hub: key,
    label: means.branch,
    definition: means.text,
    step,
    target,
    fields: [],
  }));
}

/** A door as arch 03 line 165 names it and the master defines it, about the business alone. */
function expectedDoor(document: BundleDocument, flow: FlowLetter, key: DoorKey, business: Business): Json {
  const step = doorStep(document, flow, key);
  return {
    kind: "door",
    question: null,
    branch: null,
    anytimeRow: null,
    door: key,
    hub: null,
    label: NAMES[key],
    definition: FIRST_SENTENCES[step],
    step,
    target: aboutBusiness(business),
    fields: [],
  };
}

function aboutBusiness(business: Business): Target {
  return { businessId: business.id, businessName: business.name, bookingId: null, visitAt: null };
}

function aboutBooking(business: Business, bookingId: string, visitAt: Time): Target {
  return { businessId: business.id, businessName: business.name, bookingId, visitAt };
}

/** The full card a hub step holds, as stored. */
function storedCard(document: BundleDocument, flow: FlowLetter, step: string): unknown {
  return storedStep(document, flow, step).card;
}

/** Alex's turn at Lee's Barbershop, his haircut's visit read. */
function alexTurn(documents: BundleDocument[], change?: Parameters<typeof alexState>[0]): InputOptions {
  return {
    state: alexState(change),
    documents,
    visits: { "booking-alex-haircut": ALEX_HAIRCUT_VISIT },
    request: frontierRequest(LEES_BARBERSHOP.id, {
      roles: [{ businessId: LEES_BARBERSHOP.id, personId: "person-alex", role: "customer" }],
      openQuestionIds: ["oq-a7-03-alex"],
      bookingIds: ["booking-alex-haircut"],
      noTarget: false,
    }),
  };
}

/** Alex's turn at Lee Home Services (flow B), his drain clearing's visit read. */
function alexHomeTurn(
  documents: BundleDocument[],
  change?: Parameters<typeof alexHomeState>[0],
): InputOptions {
  return {
    state: alexHomeState(change),
    documents,
    business: LEE_HOME_SERVICES,
    flow: "B",
    visits: { "booking-alex-drain": ALEX_DRAIN_VISIT },
    request: frontierRequest(LEE_HOME_SERVICES.id, {
      roles: [{ businessId: LEE_HOME_SERVICES.id, personId: "person-alex", role: "customer" }],
      openQuestionIds: [],
      bookingIds: ["booking-alex-drain"],
      noTarget: false,
    }),
  };
}

/** Sam's turn at Lee's Barbershop, in a role this test gives him. */
function samTurn(
  documents: BundleDocument[],
  role: "owner" | "admin" | "staff" | "own_business" | "customer",
): InputOptions {
  return {
    state: samState((state) => {
      state.roles = [{ roleId: "role-sam-barbershop", personId: "person-sam", role, version: 1 }];
    }),
    documents,
    request: frontierRequest(LEES_BARBERSHOP.id),
  };
}

const ALEX_HAIRCUT = aboutBooking(LEES_BARBERSHOP, "booking-alex-haircut", ALEX_HAIRCUT_VISIT);
const ALEX_DRAIN = aboutBooking(LEE_HOME_SERVICES, "booking-alex-drain", ALEX_DRAIN_VISIT);

describe("the hub for the target booking's stage (arch 03 line 163), with its full card", () => {
  it("a booked target offers A7-02's cases, one per branch its card defines (bundle-mini-a.json)", async () => {
    const { offer } = await offerFor(alexTurn([MINI_A]));
    expect(hubStep(MINI_A, "A", "booked")).toBe("A7-02");
    expect(hubsOf(offer).map(shape)).toEqual(expectedCases(MINI_A, "A", "booked", ALEX_HAIRCUT));
    expect(hubsOf(offer).map((choice) => choice.label)).toEqual([
      "Nothing changes",
      "Alex changes the plan",
      "The business can't give it",
      "A plan or count is due",
      "Something needed first",
      "A question, note or stop word",
      "Safety, privacy or a death",
    ]);
    expect(offer.cards).toEqual([{ step: "A7-02", card: storedCard(MINI_A, "A", "A7-02") }]);
  });

  it("B7-05 in flow B (bundle-mini-b.json): a booked drain clearing at Lee Home Services", async () => {
    const { offer } = await offerFor(alexHomeTurn([MINI_B]));
    expect(hubStep(MINI_B, "B", "booked")).toBe("B7-05");
    expect(hubsOf(offer).map(shape)).toEqual(expectedCases(MINI_B, "B", "booked", ALEX_DRAIN));
    expect(offer.cards).toEqual([{ step: "B7-05", card: storedCard(MINI_B, "B", "B7-05") }]);
  });

  it("the same in the whole master: A7-02 and B7-05", async () => {
    const a = await offerFor(alexTurn([MASTER]));
    expect(hubsOf(a.offer).map(shape)).toEqual(expectedCases(MASTER, "A", "booked", ALEX_HAIRCUT));
    expect(a.offer.cards.map((card) => card.step)).toEqual(["A7-02"]);
    const b = await offerFor(alexHomeTurn([MASTER]));
    expect(hubsOf(b.offer).map(shape)).toEqual(expectedCases(MASTER, "B", "booked", ALEX_DRAIN));
    expect(b.offer.cards.map((card) => card.step)).toEqual(["B7-05"]);
  });

  it("a checked-in target offers A8-32's cases (B8-22 in flow B)", async () => {
    const a = await offerFor(
      alexTurn([MASTER], (state) => {
        state.bookings = [alexHaircut({ stage: "checked_in" })];
      }),
    );
    expect(hubStep(MASTER, "A", "checkedIn")).toBe("A8-32");
    expect(hubsOf(a.offer).map(shape)).toEqual(expectedCases(MASTER, "A", "checkedIn", ALEX_HAIRCUT));
    expect(hubsOf(a.offer).map((choice) => choice.label)).toEqual([
      "Nothing: it goes as booked",
      "The work changes",
      "Someone's safety",
      "An update for Alex",
      "Something of Alex's is damaged",
    ]);
    expect(a.offer.cards).toEqual([{ step: "A8-32", card: storedCard(MASTER, "A", "A8-32") }]);

    const b = await offerFor(
      alexHomeTurn([MASTER], (state) => {
        state.bookings = [alexDrain({ stage: "checked_in" })];
      }),
    );
    expect(hubStep(MASTER, "B", "checkedIn")).toBe("B8-22");
    expect(hubsOf(b.offer).map(shape)).toEqual(expectedCases(MASTER, "B", "checkedIn", ALEX_DRAIN));
    expect(b.offer.cards).toEqual([{ step: "B8-22", card: storedCard(MASTER, "B", "B8-22") }]);
  });

  it("a done target offers A10-06's cases (B10-07 in flow B)", async () => {
    const a = await offerFor(
      alexTurn([MASTER], (state) => {
        state.bookings = [alexHaircut({ stage: "done" })];
      }),
    );
    expect(hubStep(MASTER, "A", "done")).toBe("A10-06");
    expect(hubsOf(a.offer).map(shape)).toEqual(expectedCases(MASTER, "A", "done", ALEX_HAIRCUT));
    expect(hubsOf(a.offer).map((choice) => choice.label)).toEqual([
      "Nothing more",
      "Alex asks or complains",
      "A bank dispute",
      "More work or a next step",
      "An item isn't picked up",
      "Someone else asks about it",
    ]);
    expect(a.offer.cards.map((card) => card.step)).toEqual(["A10-06"]);

    const b = await offerFor(
      alexHomeTurn([MASTER], (state) => {
        state.bookings = [alexDrain({ stage: "done" })];
      }),
    );
    expect(hubStep(MASTER, "B", "done")).toBe("B10-07");
    expect(hubsOf(b.offer).map(shape)).toEqual(expectedCases(MASTER, "B", "done", ALEX_DRAIN));
    expect(b.offer.cards.map((card) => card.step)).toEqual(["B10-07"]);
  });

  it("an entry target offers A3-51's cases, and the new-booking door, the same step, is then left out", async () => {
    const { offer } = await offerFor(
      alexTurn([MASTER], (state) => {
        state.bookings = [alexHaircut({ stage: "entry" })];
        state.openQuestions = [];
      }),
    );
    expect(hubStep(MASTER, "A", "entry")).toBe("A3-51");
    expect(hubsOf(offer).map(shape)).toEqual(expectedCases(MASTER, "A", "entry", ALEX_HAIRCUT));
    expect(doorsOf(offer).map((choice) => choice.door)).toEqual(["existingBooking"]);
  });

  it("a cancelled target has no hub", async () => {
    const { offer } = await offerFor(
      alexTurn([MASTER], (state) => {
        state.bookings = [alexHaircut({ stage: "cancelled" })];
      }),
    );
    expect(hubsOf(offer)).toEqual([]);
    expect(offer.cards).toEqual([]);
  });

  it("the target is the booking of the question sent last; with none asked, the first booking the read holds", async () => {
    const second = alexHaircut({ id: "booking-alex-beard", stage: "checked_in", version: 1 });
    const visits = {
      "booking-alex-haircut": ALEX_HAIRCUT_VISIT,
      "booking-alex-beard": { utc: "2026-10-31T15:00:00Z", zone: "America/New_York" },
    };
    const asked = await offerFor({
      ...alexTurn([MASTER], (state) => {
        state.bookings = [alexHaircut(), second];
        state.openQuestions = [
          alexQuestion({ id: "oq-a7-03-alex", step: "A7-03", sentAt: "2026-10-23T14:05:05Z" }),
          alexQuestion({
            id: "oq-a8-33-alex",
            step: "A8-33",
            bookingId: "booking-alex-beard",
            sentAt: "2026-10-23T15:00:00Z",
          }),
        ];
      }),
      visits,
    });
    expect([...new Set(hubsOf(asked.offer).map((choice) => choice.step))]).toEqual(["A8-32"]);
    expect(hubsOf(asked.offer)[0]?.target.bookingId).toBe("booking-alex-beard");

    const none = await offerFor({
      ...alexTurn([MASTER], (state) => {
        state.bookings = [second, alexHaircut()];
        state.openQuestions = [];
      }),
      visits,
    });
    expect([...new Set(hubsOf(none.offer).map((choice) => choice.step))]).toEqual(["A8-32"]);
  });
});

describe("journeys 4 to 6 and 9 offer no hub (arch 03 line 163)", () => {
  const cases: { stage: "entry" | "booked" | "checked_in" | "done"; step: string; flow: FlowLetter }[] = [
    { stage: "entry", step: "A4-81", flow: "A" },
    { stage: "entry", step: "A5-04", flow: "A" },
    { stage: "booked", step: "A6-02", flow: "A" },
    { stage: "done", step: "A9-05", flow: "A" },
    { stage: "entry", step: "S12-03", flow: "A" },
    { stage: "entry", step: "B4-04", flow: "B" },
    { stage: "entry", step: "B5-03", flow: "B" },
    { stage: "booked", step: "B6-04", flow: "B" },
    { stage: "checked_in", step: "B9-06", flow: "B" },
  ];

  for (const { stage, step, flow } of cases) {
    const journey = step.startsWith("S12") ? "4" : step.slice(1, step.indexOf("-"));
    it(`a ${stage} booking asked at ${step} (journey ${journey}): no hub, the doors still offered`, async () => {
      const options =
        flow === "A"
          ? alexTurn([MASTER], (state) => {
              state.bookings = [alexHaircut({ stage })];
              state.openQuestions = [alexQuestion({ id: "oq-alex", step })];
            })
          : alexHomeTurn([MASTER], (state) => {
              state.bookings = [alexDrain({ stage })];
              state.openQuestions = [
                alexQuestion({
                  id: "oq-alex",
                  step,
                  businessId: LEE_HOME_SERVICES.id,
                  bookingId: "booking-alex-drain",
                }),
              ];
            });
      const { offer } = await offerFor(options);
      expect(hubsOf(offer)).toEqual([]);
      expect(offer.cards).toEqual([]);
      expect(doorsOf(offer).length).toBeGreaterThan(0);
    });
  }

  it("the same booking asked at a step of journey 7 keeps its hub", async () => {
    const { offer } = await offerFor(alexTurn([MASTER]));
    expect(alexState().openQuestions.map((row) => row.step)).toEqual(["A7-03"]);
    expect(hubsOf(offer)).toHaveLength(7);
  });
});

describe("the hubs of the writer's role (arch 03 line 163)", () => {
  it("an owner gets S11-12 and S11-53, each with its full card", async () => {
    const { offer } = await offerFor(samTurn([MASTER], "owner"));
    expect([hubStep(MASTER, "A", "owner"), hubStep(MASTER, "A", "settings")]).toEqual(["S11-12", "S11-53"]);
    const business = aboutBusiness(LEES_BARBERSHOP);
    expect(hubsOf(offer).map(shape)).toEqual([
      ...expectedCases(MASTER, "A", "owner", business),
      ...expectedCases(MASTER, "A", "settings", business),
    ]);
    expect(offer.cards).toEqual([
      { step: "S11-12", card: storedCard(MASTER, "A", "S11-12") },
      { step: "S11-53", card: storedCard(MASTER, "A", "S11-53") },
    ]);
  });

  it("the team (staff, an admin, someone with their own business) gets S11-42; a customer no role hub", async () => {
    for (const role of ["staff", "admin", "own_business"] as const) {
      const { offer } = await offerFor(samTurn([MASTER], role));
      expect(hubsOf(offer).map(shape)).toEqual(
        expectedCases(MASTER, "A", "team", aboutBusiness(LEES_BARBERSHOP)),
      );
      expect(offer.cards.map((card) => card.step)).toEqual(["S11-42"]);
    }
    const customer = await offerFor(samTurn([MASTER], "customer"));
    expect(hubsOf(customer.offer)).toEqual([]);
  });

  it("the owner's hubs in flow B are the same shared steps, read in flow B's graph", async () => {
    const { offer } = await offerFor({
      ...samTurn([MASTER], "owner"),
      business: LEE_HOME_SERVICES,
      flow: "B",
      request: frontierRequest(LEE_HOME_SERVICES.id),
    });
    const business = aboutBusiness(LEE_HOME_SERVICES);
    expect(hubsOf(offer).map(shape)).toEqual([
      ...expectedCases(MASTER, "B", "owner", business),
      ...expectedCases(MASTER, "B", "settings", business),
    ]);
  });
});

describe("the door entries (arch 03 line 165), so decide can enter a door from any state", () => {
  it("each door is its name and the first sentence of its step; the owner's S11-21 is build-frontier-s1-02.json's door", async () => {
    const { offer } = await offerFor(samTurn([MASTER], "owner"));
    // S11-12 is offered as the owner's hub, so its door is left out: a hub case is chosen, not entered.
    expect(doorsOf(offer).map(shape)).toEqual([
      expectedDoor(MASTER, "A", "newBooking", LEES_BARBERSHOP),
      expectedDoor(MASTER, "A", "teamChange", LEES_BARBERSHOP),
      expectedDoor(MASTER, "A", "unclearOwnerOrHelp", LEES_BARBERSHOP),
    ]);
    const fixtureDoor = s102Exchange().outcome.context.choices.find((choice) => choice.kind === "door");
    const offered = doorsOf(offer).find((choice) => choice.door === "unclearOwnerOrHelp");
    expect(offered).toMatchObject({
      label: fixtureDoor?.label,
      definition: fixtureDoor?.definition,
      step: fixtureDoor?.step,
      door: fixtureDoor?.door,
      fields: fixtureDoor?.fields,
    });
    expect(DOOR_NAMES).toEqual(NAMES);
  });

  it("A3-43 is offered only once the handle passed the code check; before it, only A3-51", async () => {
    // Alex is the booker of his haircut, so his own number is the contact on file (S13-45): checked.
    const checked = await offerFor(alexTurn([MASTER]));
    expect(doorsOf(checked.offer).map(shape)).toEqual([
      expectedDoor(MASTER, "A", "newBooking", LEES_BARBERSHOP),
      expectedDoor(MASTER, "A", "existingBooking", LEES_BARBERSHOP),
    ]);
    // The person served counts as well.
    const served = await offerFor(
      alexTurn([MASTER], (state) => {
        state.bookings = [alexHaircut({ bookerPersonId: "person-sam" })];
      }),
    );
    expect(doorsOf(served.offer).map((choice) => choice.step)).toEqual(["A3-51", "A3-43"]);
    // A booking someone else made for someone else: this handle is no contact on file for it, so not yet checked.
    const before = await offerFor(
      alexTurn([MASTER], (state) => {
        state.bookings = [alexHaircut({ bookerPersonId: "person-sam", servedPersonId: "person-riley" })];
        state.openQuestions = [];
      }),
    );
    expect(doorsOf(before.offer).map(shape)).toEqual([
      expectedDoor(MASTER, "A", "newBooking", LEES_BARBERSHOP),
    ]);
    // No booking at all: the same.
    const none = await offerFor(
      alexTurn([MASTER], (state) => {
        state.bookings = [];
        state.openQuestions = [];
      }),
    );
    expect(doorsOf(none.offer).map((choice) => choice.step)).toEqual(["A3-51"]);
  });

  it("in flow B: B3-35 only once checked; before it, only B3-40", async () => {
    const checked = await offerFor(alexHomeTurn([MASTER]));
    expect(doorsOf(checked.offer).map(shape)).toEqual([
      expectedDoor(MASTER, "B", "newBooking", LEE_HOME_SERVICES),
      expectedDoor(MASTER, "B", "existingBooking", LEE_HOME_SERVICES),
    ]);
    const before = await offerFor(
      alexHomeTurn([MASTER], (state) => {
        state.bookings = [];
      }),
    );
    expect(doorsOf(before.offer).map(shape)).toEqual([
      expectedDoor(MASTER, "B", "newBooking", LEE_HOME_SERVICES),
    ]);
  });

  it("a door never names a booking: its target is the business alone, even for a booking already made", async () => {
    const { offer } = await offerFor(alexTurn([MASTER]));
    for (const door of doorsOf(offer)) expect(door.target).toEqual(aboutBusiness(LEES_BARBERSHOP));
  });

  it("from any state: with S1-02's question open, and with A7-03's, the doors are offered beside it", async () => {
    const sam = await offerFor(samTurn([MASTER], "owner"));
    expect(samState().openQuestions.map((row) => row.step)).toEqual(["S1-02"]);
    expect(doorsOf(sam.offer).length).toBe(3);
    const alex = await offerFor(alexTurn([MASTER]));
    expect(doorsOf(alex.offer).length).toBe(2);
  });

  it("no target (the guard found nothing to fit): the doors alone, no hub", async () => {
    const { offer } = await offerFor({
      ...alexTurn([MASTER]),
      request: frontierRequest(LEES_BARBERSHOP.id, {
        roles: [],
        openQuestionIds: [],
        bookingIds: [],
        noTarget: true,
      }),
    });
    expect(hubsOf(offer)).toEqual([]);
    expect(offer.cards).toEqual([]);
    expect(doorsOf(offer).map((choice) => choice.step)).toEqual(["A3-51", "A3-43"]);
  });

  it("the doors of bundle-mini-a.json and bundle-mini-b.json: A3-51 and B3-40, the only door steps they hold", async () => {
    const a = await offerFor(alexTurn([MINI_A]));
    expect(doorsOf(a.offer).map(shape)).toEqual([expectedDoor(MINI_A, "A", "newBooking", LEES_BARBERSHOP)]);
    const b = await offerFor(alexHomeTurn([MINI_B]));
    expect(doorsOf(b.offer).map(shape)).toEqual([expectedDoor(MINI_B, "B", "newBooking", LEE_HOME_SERVICES)]);
  });
});

describe("no business named yet: search first; named-only work gets one ask for a name (S13-20)", () => {
  /** A new number's first text, before there is a business (K-05 v1.2 read-turn-state-first-text.json). */
  function firstText(documents: BundleDocument[]): InputOptions {
    return {
      state: firstTextState(),
      documents,
      request: frontierRequest(null, { roles: [], openQuestionIds: [], bookingIds: [], noTarget: true }),
    };
  }

  it("with no business named, the door entry is search first: no business's door stands in for it", async () => {
    const { offer, port, log } = await offerFor(firstText([MASTER]));
    expect(offer).toEqual({ openQuestions: [], choices: [], cards: [] });
    expect(port.reads).toEqual([]);
    expect(log.lines).toEqual([]);
    // The same new number writing to a business it named: that business's new-booking door is its entry.
    const named = await offerFor({
      ...firstText([MASTER]),
      state: { ...firstTextState(), businessId: LEES_BARBERSHOP.id },
      request: frontierRequest(LEES_BARBERSHOP.id, {
        roles: [],
        openQuestionIds: [],
        bookingIds: [],
        noTarget: true,
      }),
    });
    expect(named.offer.choices.map(shape)).toEqual([
      expectedDoor(MASTER, "A", "newBooking", LEES_BARBERSHOP),
    ]);
  });

  it("for named-only work one ask for a name: nothing here searches, suggests or ranks a business, and S13-20 is a rule decide reads", async () => {
    // With no business named, no entry of any business is offered, so no business or person is suggested or ranked
    // (S13-20: 'never searches, suggests, ranks or rates'); the one plain ask for a name is S13-20's own rule, among the
    // always-on rules the context names by hash (K-02 v1 context.alwaysOn), which decide reads first.
    for (const document of [MASTER, MINI_A, BUNDLE_V0]) {
      const { offer } = await offerFor(firstText([document]));
      expect(offer.choices).toEqual([]);
      const graph = document.flows.A as { routing: { alwaysOn: { steps: string[] } } };
      expect(graph.routing.alwaysOn.steps).toContain("S13-20");
    }
    expect(storedStep(MASTER, "A", "S13-20")).toMatchObject({ kind: "rule" });
  });
});

describe("stakes, from each choice's own walk (K-02 README, 'Stakes')", () => {
  it("in the sample bundles every hub case and door is low: each walk stops at a step that asks, or one not held", async () => {
    for (const options of [alexTurn([MINI_A]), alexHomeTurn([MINI_B])]) {
      const { offer } = await offerFor(options);
      expect(offer.choices.length).toBeGreaterThan(0);
      for (const choice of offer.choices) expect([choice.stakes, choice.stakesFrom]).toEqual(["low", []]);
    }
  });

  it("a hub case whose branch charges is high, from its own walk; the hub's other cases stay low", async () => {
    const charging = withStepChanged(MINI_A, "A", "A7-02", (step) => {
      const branches = step.branches as Json[];
      const plan = branches.find((branch) => branch.label === "Alex changes the plan");
      if (plan === undefined) throw new Error("no such branch");
      (plan.effects as Json[]).push({ kind: "charge", ref: "fee" });
    });
    const { offer } = await offerFor(alexTurn([charging]));
    expect(hubsOf(offer).map((choice) => [choice.label, choice.stakes, choice.stakesFrom])).toEqual([
      ["Nothing changes", "low", []],
      ["Alex changes the plan", "high", [{ why: "charge", step: "A7-02", ref: "fee" }]],
      ["The business can't give it", "low", []],
      ["A plan or count is due", "low", []],
      ["Something needed first", "low", []],
      ["A question, note or stop word", "low", []],
      ["Safety, privacy or a death", "low", []],
    ]);
  });

  it("a door's walk starts at its step: S11-21 giving booked is high (why booked, at S11-21)", async () => {
    // bundle-mini-a holds S11-21 here as the master compiles it, plus a gives of booked; S11-12, whose branch lists it,
    // is not held, so in this partial bundle the walk ends with S11-21.
    const withDoor = structuredClone(MINI_A);
    const s1121 = { ...storedStep(MASTER, "A", "S11-21"), gives: ["booked"] };
    (withDoor.flows.A as { steps: Record<string, unknown> }).steps["S11-21"] = s1121;
    const { offer } = await offerFor(samTurn([withDoor], "owner"));
    const door = doorsOf(offer).find((choice) => choice.step === "S11-21");
    expect(door).toMatchObject({
      door: "unclearOwnerOrHelp",
      stakes: "high",
      stakesFrom: [{ why: "booked", step: "S11-21", ref: "booked" }],
    });
    expect(doorsOf(offer).find((choice) => choice.step === "A3-51")).toMatchObject({
      stakes: "low",
      stakesFrom: [],
    });
  });
});

describe("what is not offered is logged by its ids, never guessed (fail closed)", () => {
  it("a target booking whose visit time was not read: no hub, logged; the doors still offered", async () => {
    const { offer, log } = await offerFor({ ...alexTurn([MINI_A]), visits: {} });
    expect(hubsOf(offer)).toEqual([]);
    expect(offer.cards).toEqual([]);
    expect(log.lines).toEqual([
      {
        level: "warn",
        msg: "frontier_question_unlabelled",
        trace_id: "trace-sam-0001",
        turn_id: "turn-s1-02-sam-kinds",
        source: HUBS_AND_DOORS,
        step: "A7-02",
        booking_id: "booking-alex-haircut",
      },
    ]);
    expect(doorsOf(offer).map((choice) => choice.step)).toEqual(["A3-51"]);
  });

  it("a whole bundle that does not hold a hub or door step: not offered, logged with the step", async () => {
    const without = structuredClone(MASTER);
    const steps = (without.flows.A as { steps: Record<string, unknown> }).steps;
    delete steps["A7-02"];
    delete steps["A3-43"];
    const { offer, log } = await offerFor(alexTurn([without]));
    expect(hubsOf(offer)).toEqual([]);
    expect(doorsOf(offer).map((choice) => choice.step)).toEqual(["A3-51"]);
    expect(
      log.lines.map((line) => [line.msg, line.source, line.step ?? null, line.booking_id ?? null]),
    ).toEqual([
      ["frontier_step_missing", HUBS_AND_DOORS, "A7-02", "booking-alex-haircut"],
      ["frontier_step_missing", HUBS_AND_DOORS, "A3-43", null],
    ]);
  });

  it("a partial bundle that does not hold them: not reachable there (K-01), so nothing is logged", async () => {
    const { offer, log } = await offerFor(
      alexTurn([withPartial(MINI_A, true)], (state) => {
        state.bookings = [alexHaircut({ stage: "checked_in" })];
      }),
    );
    expect(hubsOf(offer)).toEqual([]);
    expect(doorsOf(offer).map((choice) => choice.step)).toEqual(["A3-51"]);
    expect(log.lines).toEqual([]);
  });

  it("a booking whose flow graph was not read for this call: no hub, logged", async () => {
    const { offer, log } = await offerFor({ ...alexHomeTurn([MINI_A]), flow: "A" });
    expect(hubsOf(offer)).toEqual([]);
    expect(log.lines.map((line) => [line.msg, line.booking_id ?? null])).toEqual([
      ["frontier_bundle_missing", "booking-alex-drain"],
    ]);
  });

  it("a hub case with no definition (K-01 from none) is left out and logged; the rest of the hub stays", async () => {
    const undefinedCase = withStepChanged(MINI_A, "A", "A7-02", (step) => {
      const card = step.card as { means: Json[] };
      const first = card.means[0];
      if (first === undefined) throw new Error("no means");
      card.means[0] = { branch: first.branch, from: "none" };
      step.lint = ["choice-without-definition"];
    });
    const { offer, log } = await offerFor(alexTurn([undefinedCase]));
    expect(hubsOf(offer).map((choice) => choice.label)).not.toContain("Nothing changes");
    expect(hubsOf(offer)).toHaveLength(6);
    expect(log.lines.map((line) => [line.msg, line.step ?? null])).toEqual([
      ["frontier_option_unusable", "A7-02"],
    ]);
  });

  it("every log line is labels only: never a label, a definition, a card's words or a name", async () => {
    const without = structuredClone(MASTER);
    delete (without.flows.A as { steps: Record<string, unknown> }).steps["A7-02"];
    const { log } = await offerFor({ ...alexTurn([without]), visits: {} });
    expect(log.lines.length).toBeGreaterThan(0);
    for (const line of log.lines) expect(stringsIn(line).every((value) => isLabel(value))).toBe(true);
  });
});

describe("reads: the steps from the bundle the turn pins, the doors' words through the bundles port", () => {
  it("one read of the pinned flow graph per call, only when a door is offered; none for bundle v0", async () => {
    const pinned = await offerFor(alexTurn([MINI_A]));
    expect(pinned.port.reads).toEqual([`${bundleIdOf(MINI_A).hash}/1/flow/A`]);
    const v0 = await offerFor({
      ...samTurn([BUNDLE_V0], "owner"),
      request: frontierRequest(LEES_BARBERSHOP.id),
    });
    expect(v0.offer).toEqual({ openQuestions: [], choices: [], cards: [] });
    expect(v0.port.reads).toEqual([]);
    expect(v0.log.lines).toEqual([]);
  });

  it("a port that answers no flow graph: the doors are not offered, logged; the hubs, which need no read, stay", async () => {
    const prepared = await prepare(alexTurn([MINI_A]));
    const empty = fakeBundles();
    const offer = await offerHubsAndDoors(prepared.input, empty);
    expect(doorsOf(offer)).toEqual([]);
    expect(hubsOf(offer)).toHaveLength(7);
    expect(prepared.log.lines.map((line) => [line.msg, line.step ?? null])).toEqual([
      ["frontier_bundle_missing", "A3-51"],
    ]);
  });
});

describe("plugged into T-291's assembler as the hubsAndDoors slot, through buildFrontier", () => {
  it("Sam's S1-02 turn pinned to bundle-mini-a: S1-02's three options, then the door A3-51, a valid K-02 v1 context", async () => {
    const exchange = s102Exchange();
    const miniA = bundleIdOf(MINI_A);
    const request = { ...exchange.request, turn: { ...exchange.request.turn, bundleId: miniA } };
    const bundles = fakeBundles(MINI_A, BUNDLE_V0);
    const called = await callBuildFrontier(request, {
      bundles,
      sources: [
        { name: "openQuestions", source: openQuestionsSource },
        { name: HUBS_AND_DOORS, source: createHubsAndDoorsSource(bundles) },
      ],
    });
    expect(called.answer.ok).toBe(true);
    if (!called.answer.ok || !("context" in called.answer.value)) throw new Error("no context");
    const { context } = called.answer.value;
    expect(checker.check("context", context)).toEqual([]);
    expect(
      context.choices.map((choice) => [choice.choiceId, choice.kind, choice.step, choice.label]),
    ).toEqual([
      ["c-01", "option", "S1-02", "All on the list"],
      ["c-02", "option", "S1-02", "One isn't on the list yet"],
      ["c-03", "option", "S1-02", "Not a service we book"],
      ["c-04", "door", "A3-51", NAMES.newBooking],
    ]);
    expect(context.choices[3]).toMatchObject({
      door: "newBooking",
      definition: FIRST_SENTENCES["A3-51"],
      target: aboutBusiness(LEES_BARBERSHOP),
    });
    expect(called.log.lines.filter((line) => line.source === HUBS_AND_DOORS)).toEqual([]);
  });

  it("pinned to bundle v0 (S1-01 and S1-02 alone), the slot offers nothing and S1-02's frontier is T-291's", async () => {
    const bundles = fakeBundles(BUNDLE_V0);
    const called = await callBuildFrontier(s102Exchange().request, {
      bundles,
      sources: [
        { name: "openQuestions", source: openQuestionsSource },
        { name: HUBS_AND_DOORS, source: createHubsAndDoorsSource(bundles) },
      ],
    });
    if (!called.answer.ok || !("context" in called.answer.value)) throw new Error("no context");
    expect(called.answer.value.context.choices.map((choice) => choice.kind)).toEqual([
      "option",
      "option",
      "option",
    ]);
    expect(called.log.lines).toEqual([]);
  });
});
