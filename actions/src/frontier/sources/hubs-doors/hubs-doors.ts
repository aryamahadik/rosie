// The frontier's hubs and doors (T-293; C-075, C-076; S13-20). arch 03 lines 163 and 165:
//   "Hubs by the target booking's stage: entry A3-51 (B3-40); booked A7-02 (B7-05); checked in A8-32 (B8-22); done
//    A10-06 (B10-07); owner S11-12, settings S11-53; team S11-42. Journeys 4-6 and 9 have no hub."
//   "Doors: a new booking or a question about the business, A3-51 (B3-40); a booking already made, A3-43 (B3-35) after a
//    code check; an owner command, S11-12; a team change, S11-42; an unclear owner text or HELP, S11-21. No business named
//    yet: search first; named-only work gets one ask for a name (S13-20)."
// Every hub and door step comes from the routing tables of the K-01 v1 bundle the turn pins (routingTables.hubs and
// .doors, in the flow graph that holds the step); this file names no step id.
//
// What it offers, in this order (arch 03 lines 163 then 165):
//   1. The target booking's hub: its stage's hub (K-05 v1.2 bookingHead.stage; K-04 v1 bookings.stage "The hub reads
//      it": entry, booked, checked_in, done; cancelled has none), read in the booking's own flow, one choice per message
//      branch its card defines, labelled by business, date and time (arch 03 line 159). None while the booking is in
//      journey 4, 5, 6 or 9 (a live open question about it asked at one of their steps: those journeys' own questions
//      carry the turn), and none when its visit time was not read (never a guess at its date).
//   2. The hubs of the writer's role at this business (K-05 v1.2 readTurnState roles): an owner's S11-12 and S11-53; the
//      team's S11-42 (admin, staff or own business: K-05 v1.2 item 31's team).
//      Each hub case is chosen, not entered, with the hub's step as its question (K-02 v1 default 6), and each hub comes
//      with its full step card (arch 03 line 181).
//   3. The doors decide can enter from any state, in K-01's order, each labelled with its name (arch 03 line 165) and
//      defined by the first sentence of its step (K-02 v1 default 3): the new-booking door for anyone; the door to a
//      booking already made only once the handle passed the code check; an owner command and an unclear owner text or
//      HELP for an owner; a team change for the business side. A door whose step is offered as a hub this turn is left
//      out: its cases are listed, and a hub case is chosen, not entered.
//
// No target (K-09 v1 guardTargets.noTarget: "nothing fits as a target: the doors are offered"; arch 02 line 115 "No
// target: the doors"): the doors alone. No business named yet (the read ran with no business, K-05 v1.2 readTurnState
// businessId null, as read-turn-state-first-text.json shows, or the call names none): nothing here, since every one of
// these entries acts on a business (K-02 v1 target.businessId) and none may stand in for search, which comes first, or
// for the one ask for a name that named-only work gets (S13-20, an always-on rule decide reads in the cached prefix).
//
// Each choice's stakes come from its walk (assemble/bundle.ts ownStakes): a hub case's from its branch on; a door's from
// its step on, as code's walk after enter goes (arch 03 line 191). The door's definition is read from the pinned flow
// graph through the bundles port, since the frontier's step view (assemble/types.ts BundleStep) holds no `does`; the
// port is read once per call, and only when a door is to be offered.
//
// What is not offered is logged by its ids (assemble/log.ts: labels only), with the events of the frontier's closed list
// (assemble/types.ts FrontierEvent): a hub or door step a whole bundle does not hold, a hub step with no card or a door
// step with no `does` (frontier_step_missing); a flow graph not read for this call (frontier_bundle_missing); a hub case
// whose card gives no definition (frontier_option_unusable); a target booking that cannot be labelled by its date and
// time (frontier_question_unlabelled). A step a partial bundle does not hold is not logged: it is not reachable there by
// K-01's own rule (contracts/bundle README, fixtures), and bundle v0 holds none of these steps.
// Never logged: a label, a definition, a card's words or a name.
//
// Defaults, where no frozen source gives a value (ops/QUESTIONS.md, through the report):
//   - the target booking is the booking of the most recently sent live open question about one of this business's
//     bookings the read holds, else the first of them (CQ-150 (b), as cap/cap.ts targetBookingOf reads it);
//   - journey N holds section N's A and B steps and the shared steps K-01's journey table gives it (contracts/bundle
//     README, "Journey membership": S12-01 to S12-05 and S12-28 in 4, S12-16 to S12-18 and S12-26 in 5, S12-33 in 6);
//   - the code check is passed when one of the handle's people is the booker or the person served of a booking of this
//     business the read holds: the contact on file in its own thread (S13-45), as the guard lists a handle's bookings
//     (K-05 v1.2 handleTargets), which a code typed back makes the handle's too (D75, D100);
//   - who is the owner and who the team: K-05 v1.2 item 31's classes (owner; admin, staff and own_business);
//   - a hub case's fields are its branch's answer fields, else the hub step's gives keys as text fields (T-291's rule
//     for an option); a door carries none.

import { findStep, ownStakes } from "../../assemble/bundle";
import type {
  AnswerField,
  BundleBranch,
  BundleId,
  BundleStep,
  BundleView,
  Choice,
  DraftChoice,
  FlowLetter,
  FlowView,
  FrontierBundles,
  FrontierInput,
  FrontierSource,
  SourceOffer,
  StakesReason,
  StepCard,
  Target,
  TurnState,
} from "../../assemble/types";
import { firstSentence } from "./first-sentence";

/** This source's slot name (assemble/registry.ts). */
export const HUBS_AND_DOORS = "hubsAndDoors";

/** A hub's key: the target booking's stage, or the writer's role (K-01 v1 routingTables.hubs; K-02 v1 choice.hub). */
export type HubKey = NonNullable<Choice["hub"]>;
/** A door's key (K-01 v1 routingTables.doors; K-02 v1 choice.door). */
export type DoorKey = NonNullable<Choice["door"]>;

type BookingHead = TurnState["bookings"][number];
type Role = TurnState["roles"][number]["role"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** K-01 v1 stepId. */
const STEP_ID = /^[SAB](?:1[0-3]|[1-9])-x?[0-9]{2,3}$/u;

/** K-01 v1 routingTables.hubs, in the schema's order. */
const HUB_KEYS: readonly HubKey[] = ["entry", "booked", "checkedIn", "done", "owner", "settings", "team"];

/** K-01 v1 routingTables.doors, in the schema's order. */
const DOOR_KEYS: readonly DoorKey[] = [
  "newBooking",
  "existingBooking",
  "ownerCommand",
  "teamChange",
  "unclearOwnerOrHelp",
];

/** Each door's name, its label (K-02 v1 choice.label: "the door's name (arch 03 line 165)"). */
export const DOOR_NAMES: Readonly<Record<DoorKey, string>> = {
  newBooking: "A new booking or a question about the business",
  existingBooking: "A booking already made",
  ownerCommand: "An owner command",
  teamChange: "A team change",
  unclearOwnerOrHelp: "An unclear owner text or HELP",
};

/** The hub a booking's stage reads (K-04 v1 bookings.stage: "The hub reads it"); a cancelled booking has none. */
const STAGE_HUBS: Readonly<Record<BookingHead["stage"], HubKey | null>> = {
  entry: "entry",
  booked: "booked",
  checked_in: "checkedIn",
  done: "done",
  cancelled: null,
};

/** The journeys with no hub (arch 03 line 163). */
const JOURNEYS_WITHOUT_HUB: ReadonlySet<number> = new Set([4, 5, 6, 9]);

/** The shared steps that ride with journeys 4 to 6 (contracts/bundle README, "Journey membership"). */
const SHARED_STEPS_WITHOUT_HUB: ReadonlySet<string> = new Set([
  "S12-01",
  "S12-02",
  "S12-03",
  "S12-04",
  "S12-05",
  "S12-28",
  "S12-16",
  "S12-17",
  "S12-18",
  "S12-26",
  "S12-33",
]);

/** The owner (arch 03 line 163: "owner S11-12, settings S11-53"; line 165: an owner command, an unclear owner text). */
const OWNER: ReadonlySet<Role> = new Set(["owner"]);
/** The business's team (arch 03 line 163: "team S11-42"; K-05 v1.2 item 31: admin, staff or own_business). */
const TEAM: ReadonlySet<Role> = new Set(["admin", "staff", "own_business"]);

/** The hubs each role reads (arch 03 line 163). */
const ROLE_HUBS: readonly { hub: HubKey; roles: ReadonlySet<Role> }[] = [
  { hub: "owner", roles: OWNER },
  { hub: "settings", roles: OWNER },
  { hub: "team", roles: TEAM },
];

/** Who may enter each door: anyone (null), or the roles named (arch 03 line 165). */
const DOOR_ROLES: Readonly<Record<DoorKey, ReadonlySet<Role> | null>> = {
  newBooking: null,
  existingBooking: null,
  ownerCommand: OWNER,
  teamChange: new Set([...OWNER, ...TEAM]),
  unclearOwnerOrHelp: OWNER,
};

/** The step a door's walk starts from, standing for decide's enter: no gives, and no step has this id (K-01 stepId). */
const ENTER: BundleStep = {
  id: "enter",
  split: null,
  gives: [],
  next: null,
  branches: [],
  effects: [],
  card: null,
};

/** One routing table of a flow graph (K-01 v1 routingTables.hubs or .doors), each key with a step id. */
function tableOf<K extends string>(
  flow: FlowView,
  name: "hubs" | "doors",
  keys: readonly K[],
): Partial<Record<K, string>> {
  const table = flow.routing[name];
  const out: Partial<Record<K, string>> = {};
  if (!isRecord(table)) return out;
  for (const key of keys) {
    const step = table[key];
    if (typeof step === "string" && STEP_ID.test(step)) out[key] = step;
  }
  return out;
}

/** Whether a step rides with a journey that has no hub (see the defaults above). */
function inJourneyWithoutHub(step: string): boolean {
  if (SHARED_STEPS_WITHOUT_HUB.has(step)) return true;
  const section = /^[AB](\d{1,2})-/u.exec(step)?.[1];
  return section !== undefined && JOURNEYS_WITHOUT_HUB.has(Number(section));
}

/** This business's booking heads the read holds. */
function headsOf(input: FrontierInput): BookingHead[] {
  return input.state.bookings.filter((head) => head.businessId === input.business.id);
}

/** The turn's target booking (see the defaults above), or null when the read holds none of this business. */
export function targetBookingOf(input: FrontierInput): BookingHead | null {
  const heads = headsOf(input);
  let newest: { head: BookingHead; at: number } | null = null;
  for (const row of input.state.openQuestions) {
    if (row.bookingId === null || row.sentAt === null) continue;
    const head = heads.find((each) => each.id === row.bookingId);
    const at = Date.parse(row.sentAt);
    if (head === undefined || Number.isNaN(at)) continue;
    if (newest === null || at > newest.at) newest = { head, at };
  }
  return newest?.head ?? heads[0] ?? null;
}

/** Whether the handle passed the code check (see the defaults above). */
export function passedCodeCheck(input: FrontierInput): boolean {
  const people = new Set(input.state.persons.map((person) => person.personId));
  return headsOf(input).some(
    (head) =>
      people.has(head.bookerPersonId) || (head.servedPersonId !== null && people.has(head.servedPersonId)),
  );
}

/** The writer's roles at this business (K-05 v1.2 readTurnState: the handle's people's live roles here). */
function rolesOf(input: FrontierInput): Set<Role> {
  return new Set(input.state.roles.map((role) => role.role));
}

/** Whether any of the roles is in the set. */
function anyOf(roles: ReadonlySet<Role>, allowed: ReadonlySet<Role>): boolean {
  return [...roles].some((role) => allowed.has(role));
}

/** A hub case's fields: its branch's answer fields, else the hub step's gives keys as text fields. */
function fieldsOf(step: BundleStep, branch: BundleBranch): AnswerField[] {
  if (branch.answerFields.length > 0) return branch.answerFields.map((field) => ({ ...field }));
  return step.gives.map((name) => ({ name, type: "text" }));
}

/** The target of a choice about no booking: the business alone. */
function businessTarget(input: FrontierInput): Target {
  return { businessId: input.business.id, businessName: input.business.name, bookingId: null, visitAt: null };
}

/** A hub to offer: its key, its step, the flow graph that holds it and what its cases act on. */
interface Hub {
  key: HubKey;
  step: BundleStep;
  flow: FlowView;
  target: Target;
}

/** What one call needs on hand. */
interface Call {
  readonly input: FrontierInput;
  readonly port: FrontierBundles;
  readonly bundle: BundleView;
  readonly flow: FlowView | null;
}

/** A hub or door step the pinned bundle does not hold: logged, unless the bundle is partial (not reachable there). */
function stepMissing(call: Call, step: string | null, bookingId: string | null = null): void {
  if (call.bundle.partial) return;
  call.input.log.warn("frontier_step_missing", {
    source: HUBS_AND_DOORS,
    ...(step === null ? {} : { step }),
    ...(bookingId === null ? {} : { booking_id: bookingId }),
  });
}

/** A hub step of the pinned bundle, read in `flow` (an A or B step in its own flow, a shared one in `flow` first). */
function hubStepOf(
  call: Call,
  flow: FlowView,
  key: HubKey,
  bookingId: string | null,
): { step: BundleStep; flow: FlowView } | null {
  const id = tableOf(flow, "hubs", HUB_KEYS)[key] ?? null;
  const found = id === null ? null : findStep(call.bundle, id, flow.flow);
  if (found === null) {
    stepMissing(call, id, bookingId);
    return null;
  }
  return found;
}

/** The target booking's hub, or null (see the header). */
function bookingHub(call: Call): Hub | null {
  const { input } = call;
  const head = targetBookingOf(input);
  if (head === null) return null;
  const key = STAGE_HUBS[head.stage];
  if (key === null) return null;
  const asked = input.state.openQuestions.some(
    (row) => row.bookingId === head.id && inJourneyWithoutHub(row.step),
  );
  if (asked) return null;
  const flow = call.bundle.flows[head.flow];
  if (flow === undefined) {
    input.log.warn("frontier_bundle_missing", { source: HUBS_AND_DOORS, booking_id: head.id });
    return null;
  }
  const found = hubStepOf(call, flow, key, head.id);
  if (found === null) return null;
  const visitAt = input.visits.get(head.id) ?? null;
  if (visitAt === null) {
    input.log.warn("frontier_question_unlabelled", {
      source: HUBS_AND_DOORS,
      step: found.step.id,
      booking_id: head.id,
    });
    return null;
  }
  return {
    key,
    ...found,
    target: {
      businessId: input.business.id,
      businessName: input.business.name,
      bookingId: head.id,
      visitAt: { utc: visitAt.utc, zone: visitAt.zone },
    },
  };
}

/** The hubs of the writer's role at this business, in K-01's order. */
function roleHubs(call: Call): Hub[] {
  const roles = rolesOf(call.input);
  const { flow } = call;
  if (flow === null) return [];
  return ROLE_HUBS.flatMap(({ hub, roles: allowed }): Hub[] => {
    if (!anyOf(roles, allowed)) return [];
    const found = hubStepOf(call, flow, hub, null);
    return found === null ? [] : [{ key: hub, ...found, target: businessTarget(call.input) }];
  });
}

/** One hub's cases and its full card, or null when its card defines none it can offer (each such case logged). */
function offerHub(call: Call, hub: Hub): { choices: DraftChoice[]; card: StepCard } | null {
  const { log } = call.input;
  const { step } = hub;
  if (step.card === null) {
    log.warn("frontier_step_missing", { source: HUBS_AND_DOORS, step: step.id });
    return null;
  }
  const choices: DraftChoice[] = [];
  for (const means of step.card.means) {
    const branch = step.branches.find((each) => each.label === means.branch);
    if (branch?.tag !== "message" || means.from === "none" || means.text === undefined) {
      log.warn("frontier_option_unusable", { source: HUBS_AND_DOORS, step: step.id });
      continue;
    }
    const reasons = ownStakes(call.bundle, hub.flow, step, branch);
    choices.push({
      kind: "hub",
      question: step.id,
      branch: branch.label,
      anytimeRow: null,
      door: null,
      hub: hub.key,
      label: branch.label,
      definition: means.text,
      step: step.id,
      target: { ...hub.target, visitAt: hub.target.visitAt === null ? null : { ...hub.target.visitAt } },
      fields: fieldsOf(step, branch),
      stakes: reasons.length > 0 ? "high" : "low",
      stakesFrom: reasons,
    });
  }
  return choices.length === 0 ? null : { choices, card: { step: step.id, card: step.card } };
}

/** Why a door is high, from its walk: the door step and on, as code's walk after enter goes (arch 03 line 191). */
function doorStakes(call: Call, flow: FlowView, step: string): StakesReason[] {
  const entered: BundleBranch = {
    label: "enter",
    tag: "lookup",
    steps: [step],
    end: "end",
    rejoinAt: null,
    answerFields: [],
    effects: [],
  };
  return ownStakes(call.bundle, flow, ENTER, entered);
}

/** The doors this writer may enter now (see the header), each with the step the pinned bundle holds for it. */
function doorsOf(
  call: Call,
  hubSteps: ReadonlySet<string>,
): { key: DoorKey; step: BundleStep; flow: FlowView }[] {
  const { input, flow } = call;
  if (flow === null) return [];
  const roles = rolesOf(input);
  const checked = passedCodeCheck(input);
  const table = tableOf(flow, "doors", DOOR_KEYS);
  return DOOR_KEYS.flatMap((key) => {
    const allowed = DOOR_ROLES[key];
    if (allowed !== null && !anyOf(roles, allowed)) return [];
    if (key === "existingBooking" && !checked) return [];
    const id = table[key] ?? null;
    if (id !== null && hubSteps.has(id)) return [];
    const found = id === null ? null : findStep(call.bundle, id, flow.flow);
    if (found === null) {
      stepMissing(call, id);
      return [];
    }
    return [{ key, ...found }];
  });
}

/** The first sentence of each step's `does` in one flow graph of the pinned bundle, read through the port. */
async function firstSentencesOf(
  port: FrontierBundles,
  bundleId: BundleId,
  flow: FlowLetter,
  ids: readonly string[],
): Promise<Map<string, string> | null> {
  const graph = await port.flow(bundleId, flow);
  if (!isRecord(graph) || graph.contract !== "bundle.v1" || graph.flow !== flow || !isRecord(graph.steps)) {
    return null;
  }
  const steps = graph.steps;
  const out = new Map<string, string>();
  for (const id of ids) {
    const step = Object.hasOwn(steps, id) ? steps[id] : undefined;
    if (!isRecord(step) || typeof step.does !== "string") continue;
    const sentence = firstSentence(step.does);
    if (sentence !== "") out.set(id, sentence);
  }
  return out;
}

/** The doors, each defined by its step's first sentence (a door whose step has none is logged and left out). */
async function offerDoors(call: Call, hubSteps: ReadonlySet<string>): Promise<DraftChoice[]> {
  const doors = doorsOf(call, hubSteps);
  const first = doors[0];
  if (first === undefined || call.flow === null) return [];
  const { input } = call;
  const sentences = await firstSentencesOf(
    call.port,
    call.bundle.bundleId,
    call.flow.flow,
    doors.map((door) => door.step.id),
  );
  if (sentences === null) {
    input.log.warn("frontier_bundle_missing", { source: HUBS_AND_DOORS, step: first.step.id });
    return [];
  }
  const target = businessTarget(input);
  return doors.flatMap(({ key, step, flow }): DraftChoice[] => {
    const definition = sentences.get(step.id);
    if (definition === undefined) {
      input.log.warn("frontier_step_missing", { source: HUBS_AND_DOORS, step: step.id });
      return [];
    }
    const reasons = doorStakes(call, flow, step.id);
    return [
      {
        kind: "door",
        question: null,
        branch: null,
        anytimeRow: null,
        door: key,
        hub: null,
        label: DOOR_NAMES[key],
        definition,
        step: step.id,
        target: { ...target },
        fields: [],
        stakes: reasons.length > 0 ? "high" : "low",
        stakesFrom: reasons,
      },
    ];
  });
}

/** The hubs and doors of one turn (see the header). */
export async function offerHubsAndDoors(input: FrontierInput, port: FrontierBundles): Promise<SourceOffer> {
  const offer: SourceOffer = { openQuestions: [], choices: [], cards: [] };
  if (input.state.businessId === null || input.request.caller.businessId === null) return offer;
  const call: Call = { input, port, bundle: input.pinned, flow: input.pinned.flows[input.flow] ?? null };
  if (call.flow === null) {
    input.log.warn("frontier_bundle_missing", { source: HUBS_AND_DOORS });
    return offer;
  }

  const hubs: Hub[] = [];
  if (!input.request.targets.noTarget) {
    const booking = bookingHub(call);
    if (booking !== null) hubs.push(booking);
    for (const hub of roleHubs(call)) {
      if (!hubs.some((listed) => listed.step.id === hub.step.id)) hubs.push(hub);
    }
  }
  const offered = new Set<string>();
  for (const hub of hubs) {
    const cases = offerHub(call, hub);
    if (cases === null) continue;
    offered.add(hub.step.id);
    offer.choices.push(...cases.choices);
    offer.cards.push(cases.card);
  }
  offer.choices.push(...(await offerDoors(call, offered)));
  return offer;
}

/** The hubs-and-doors source, reading door steps' words through the bundles port the frontier reads the bundle with. */
export function createHubsAndDoorsSource(port: FrontierBundles): FrontierSource {
  return { name: HUBS_AND_DOORS, offer: (input) => offerHubsAndDoors(input, port) };
}
