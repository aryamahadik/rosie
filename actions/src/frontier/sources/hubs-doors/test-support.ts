// Inputs for the hubs-and-doors source's tests (T-293), for the tests only. Never imported by the Worker.
//
// The bundles are K-01 v1's sample bundles (bundle-mini-a.json: A3-51 and A7-02; bundle-mini-b.json: B3-40 and B7-05;
// bundle-v0-skeleton.json: S1-01 and S1-02 alone) and the whole of fixture set v1's two master flows as the merged bundle
// emitter compiles them (T-149, compiler/src/emit buildBundle, with no trade, as actions/src/homes/registry/test-support.ts
// builds them): every hub and door step with its card, branches and words, the master's own (rule 9).
// The stored state is K-05 v1.2 readTurnState's own fixtures (read-turn-state-alex.json, read-turn-state-first-text.json)
// and Sam's state at S1-02 (assemble/test-support.ts samSeed), each held to K-05 v1.2's frozen schema here. Names and
// values come only from the master's sample cast and K-04's seeds (Sam, Alex M., Lee's Barbershop, Lee Home Services; the
// 555-01xx range).

import { buildBundle } from "../../../../../compiler/src/emit";
import { readBundle, readManifest } from "../../assemble/bundle";
import { frontierLogger } from "../../assemble/log";
import {
  bundleIdOf,
  captureLog,
  checks,
  contractFixture,
  fakeBundles,
  k05Problems,
  s102Exchange,
  samSeed,
  type BundleDocument,
  type FakeBundles,
  type LogCapture,
} from "../../assemble/test-support";
import {
  bundleKey,
  type BuildFrontierRequest,
  type BundleView,
  type FlowLetter,
  type FrontierInput,
  type Time,
  type TurnState,
} from "../../assemble/types";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------------------------------------------
// The bundles

/** The id the whole master bundle is built under (any id: the emitter takes it as given, as emit.test.ts does). */
export const MASTER_BUNDLE_ID = { hash: "cd".repeat(32), build: 1 };

let master: Promise<BundleDocument> | undefined;

/** Fixture set v1's two master flows as the emitter compiles them: a whole bundle (not partial), built once. */
export function masterBundle(): Promise<BundleDocument> {
  master ??= buildBundle({
    trades: [],
    bundleId: MASTER_BUNDLE_ID,
    builtAt: "2026-11-08T00:00:00Z",
  }).then((built) => ({ manifest: built.bundle.manifest, flows: built.bundle.flows }));
  return master.then((document) => structuredClone(document));
}

/** One step of a bundle document's flow graph as stored, or a thrown error naming it. */
export function storedStep(document: BundleDocument, flow: FlowLetter, id: string): Json {
  const graph = document.flows[flow];
  const steps = isRecord(graph) && isRecord(graph.steps) ? graph.steps : {};
  const step = steps[id];
  if (!isRecord(step)) throw new Error(`flow ${flow} holds no step ${id}`);
  return step;
}

/** A flow graph's routing table (K-01 v1 routingTables.hubs or .doors), as stored. */
export function storedTable(document: BundleDocument, flow: FlowLetter, name: "hubs" | "doors"): Json {
  const graph = document.flows[flow];
  const routing = isRecord(graph) && isRecord(graph.routing) ? graph.routing : {};
  const table = routing[name];
  if (!isRecord(table)) throw new Error(`flow ${flow} has no ${name}`);
  return table;
}

/** A step's card, as stored: one definition per branch. */
export function storedMeans(step: Json): { branch: string; text: string }[] {
  const card = isRecord(step.card) ? step.card : {};
  const means: unknown[] = Array.isArray(card.means) ? card.means : [];
  return means.flatMap((entry) =>
    isRecord(entry) && typeof entry.branch === "string" && typeof entry.text === "string"
      ? [{ branch: entry.branch, text: entry.text }]
      : [],
  );
}

/** A copy of a bundle document with a step of one flow changed by `change`. */
export function withStepChanged(
  document: BundleDocument,
  flow: FlowLetter,
  id: string,
  change: (step: Json) => void,
): BundleDocument {
  const copy = structuredClone(document);
  change(storedStep(copy, flow, id));
  return copy;
}

/** A copy of a bundle document whose manifest says it is partial, or not. */
export function withPartial(document: BundleDocument, partial: boolean): BundleDocument {
  const copy = structuredClone(document);
  if (partial) copy.manifest.partial = true;
  else delete copy.manifest.partial;
  return copy;
}

// ---------------------------------------------------------------------------------------------------------------
// The businesses (K-04 v1 seeds: business head rows)

export interface Business {
  id: string;
  name: string;
  zone: string;
}

export const LEES_BARBERSHOP: Business = {
  id: "biz-lees-barbershop",
  name: "Lee's Barbershop",
  zone: "America/New_York",
};

export const LEE_HOME_SERVICES: Business = {
  id: "biz-lee-home-services",
  name: "Lee Home Services",
  zone: "America/New_York",
};

/** Alex's haircut, Sat Oct 24, 11:00am at Lee's Barbershop (K-04 v1 seed-reservation.json; the master's A7-02). */
export const ALEX_HAIRCUT_VISIT: Time = { utc: "2026-10-24T15:00:00Z", zone: "America/New_York" };
/** Alex's drain clearing at home, Thu Oct 22, 12:00pm, flow B at Lee Home Services (the master's B7-05). */
export const ALEX_DRAIN_VISIT: Time = { utc: "2026-10-22T16:00:00Z", zone: "America/New_York" };

// ---------------------------------------------------------------------------------------------------------------
// The stored state (K-05 v1.2 readTurnState answers)

type BookingHead = TurnState["bookings"][number];
type OpenQuestionRead = TurnState["openQuestions"][number];

/** A K-05 v1.2 readTurnState answer, checked against K-05 v1.2's frozen schema. */
function checkedState(state: TurnState): TurnState {
  const problems = k05Problems("readTurnState.response", state);
  if (problems.length > 0) throw new Error(`the test's state breaks K-05 v1.2: ${problems.join("; ")}`);
  return state;
}

/** A K-05 v1.2 readTurnState fixture's answer, freshly parsed. */
function fixtureState(file: string): TurnState {
  const exchange = contractFixture(`data-access/fixtures/${file}`);
  if (!isRecord(exchange) || !isRecord(exchange.outcome)) throw new Error(`${file} holds no answer`);
  return exchange.outcome as unknown as TurnState;
}

/** Alex's booked haircut as K-05 v1.2's read-turn-state-alex.json reads it, A7-03's question open. */
export function alexState(change: (state: TurnState) => void = () => undefined): TurnState {
  const state = fixtureState("read-turn-state-alex.json");
  change(state);
  return checkedState(state);
}

/** Alex's booking head, as read-turn-state-alex.json reads it, with other values. */
export function alexHaircut(values: Partial<BookingHead> = {}): BookingHead {
  const state = fixtureState("read-turn-state-alex.json");
  const head = state.bookings[0];
  if (head === undefined) throw new Error("read-turn-state-alex.json reads no booking");
  return { ...head, ...values };
}

/** Alex's drain clearing at Lee Home Services, in flow B, booked. */
export function alexDrain(values: Partial<BookingHead> = {}): BookingHead {
  return alexHaircut({
    id: "booking-alex-drain",
    businessId: LEE_HOME_SERVICES.id,
    flow: "B",
    version: 2,
    ...values,
  });
}

/** Alex's state at Lee Home Services: the drain clearing booked, no question open. */
export function alexHomeState(change: (state: TurnState) => void = () => undefined): TurnState {
  return alexState((state) => {
    state.businessId = LEE_HOME_SERVICES.id;
    state.roles = [{ roleId: "role-alex-home", personId: "person-alex", role: "customer", version: 1 }];
    state.openQuestions = [];
    state.bookings = [alexDrain()];
    state.facts = [];
    change(state);
  });
}

/** An open question about one of Alex's bookings, at a step, as K-05 v1.2 reads it (read-turn-state-alex.json's A7-03). */
export function alexQuestion(
  values: Partial<OpenQuestionRead> & Pick<OpenQuestionRead, "id" | "step">,
): OpenQuestionRead {
  const state = fixtureState("read-turn-state-alex.json");
  const row = state.openQuestions[0];
  if (row === undefined) throw new Error("read-turn-state-alex.json reads no open question");
  return { ...row, ...values };
}

/** Sam's state at S1-02 (assemble/test-support.ts samSeed) as K-05 v1.2 reads it: his owner role, S1-02's question. */
export function samState(change: (state: TurnState) => void = () => undefined): TurnState {
  const seed = samSeed();
  const state: TurnState = {
    result: "turnState",
    handleId: seed.handleId,
    handle: seed.handle,
    businessId: LEES_BARBERSHOP.id,
    readAt: "2026-10-19T14:05:04Z",
    persons: seed.persons,
    roles: seed.roles,
    phone: seed.phone,
    openQuestions: seed.openQuestions,
    bookings: [],
    pauses: [],
    consents: [],
    facts: [],
  };
  change(state);
  return checkedState(state);
}

/** A new number's first text, before there is a business: K-05 v1.2's read-turn-state-first-text.json. */
export function firstTextState(): TurnState {
  return checkedState(fixtureState("read-turn-state-first-text.json"));
}

// ---------------------------------------------------------------------------------------------------------------
// The request (K-09 v1 buildFrontier), and one input to the source

/** build-frontier-s1-02.json's request, with the caller's business and the guard's targets this test gives. */
export function frontierRequest(
  businessId: string | null,
  targets: Partial<BuildFrontierRequest["targets"]> = {},
): BuildFrontierRequest {
  const request = s102Exchange().request as unknown as BuildFrontierRequest;
  const built: BuildFrontierRequest = {
    ...request,
    caller: { ...request.caller, businessId },
    targets: { ...request.targets, ...targets },
  };
  const problems = checks().validator.check("buildFrontier", "request", built);
  if (problems.length > 0) throw new Error(`the test's request breaks K-09 v1: ${problems.join("; ")}`);
  return built;
}

export interface InputOptions {
  state: TurnState;
  /** The bundle the turn pins (first) and any other the turn reads. */
  documents: BundleDocument[];
  business?: Business;
  flow?: FlowLetter;
  visits?: Record<string, Time | null>;
  request?: BuildFrontierRequest;
}

export interface Prepared {
  input: FrontierInput;
  /** The bundles port: what the handler reads with, and the source's own reads, in order. */
  port: FakeBundles;
  log: LogCapture;
}

/** The pinned bundle as the handler reads it for a call (assemble/bundle.ts readManifest, readBundle): every flow. */
async function pinnedView(port: FakeBundles, document: BundleDocument): Promise<BundleView> {
  const id = bundleIdOf(document);
  const manifest = await readManifest(port, id);
  if (manifest === null) throw new Error("the pinned bundle has no manifest");
  return readBundle(port, id, manifest, ["A", "B"]);
}

/** One FrontierInput, as buildFrontier hands it to every source, with the port and the log it reads through. */
export async function prepare(options: InputOptions): Promise<Prepared> {
  const [pinnedDocument] = options.documents;
  if (pinnedDocument === undefined) throw new Error("no pinned bundle");
  const business = options.business ?? LEES_BARBERSHOP;
  const port = fakeBundles(...options.documents);
  const pinned = await pinnedView(port, pinnedDocument);
  port.reads.length = 0;
  const log = captureLog();
  const request = options.request ?? frontierRequest(business.id);
  const input: FrontierInput = {
    request,
    business,
    state: options.state,
    visits: new Map(Object.entries(options.visits ?? {})),
    flow: options.flow ?? "A",
    pinned,
    bundles: new Map([[bundleKey(pinned.bundleId), pinned]]),
    log: frontierLogger(log.sink, { traceId: request.caller.traceId, turnId: request.turn.id }),
  };
  return { input, port, log };
}
