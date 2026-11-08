// Doubles and scenarios for limit 6's tests (T-304). Never imported by the Worker. The doubles stand in for limit 6's
// ports (K-04's business head zone, where a visit happens, C-120's photo reading) and for limits 1 to 5 (T-299 to
// T-303), never for limit 6. Values come only from the contracts' fixtures and the master's sample cast and examples:
// K-02 v1's S1-02 and two-requests fixtures, K-09 v1's gate exchanges, K-04 v1's business head seeds, S1-12's price
// board and S1-13's money card read-back word for word, S11-20's "raise haircut to 40", A3-07's Spanish, and the security
// review's cut words of round 1 (DL-184: "raise haircut to 140", "tomorrow at 10", "$1,200", "Oct 24", "12 people",
// "10am"). The geo double's world puts every demo business in America/New_York (K-17 README, "The double"); Lee Home
// Services' flow B visit in Los Angeles is this double's illustration of a visit address in another zone, as the card
// asks. Phone numbers are in the 555-01xx range (rule 9).

import { contractFile } from "../../tool-api/test-support";
import type {
  Choice,
  Context,
  DecidePart,
  Decided,
  GatePart,
  GateRequest,
  GateTurn,
  GatedVerbPart,
  Limit,
  LimitRegistry,
} from "../framework";
import {
  copy,
  gateExchange,
  gateRequest,
  scriptedLimits,
  type LimitCall,
  type PartScript,
  type Script,
} from "../framework/test-support";
import {
  NO_PHOTO_READINGS,
  NO_PLACE_KNOWN,
  type BusinessZones,
  type FieldRef,
  type PhotoReadings,
  type ValueSource,
  type VisitPlace,
  type VisitPlaces,
  type VisitRef,
} from "./facts";
import { createLimit6, type ValuesLimit } from "./index";

export type Text = Context["texts"][number];
export type ContextQuestion = Context["openQuestions"][number];
export type Target = Choice["target"];
type Field = Extract<DecidePart, { verb: "choose" }>["fields"][number];

export const NEW_YORK = "America/New_York";
export const LOS_ANGELES = "America/Los_Angeles";
export const CHICAGO = "America/Chicago";

// ---------------------------------------------------------------------------------------------------------------
// The doubles

/** The repo a test hands the limit: the doubles never read it. */
export const TEST_REPO = { name: "limit-6-test-repo" } as const;

interface SeedRows {
  readonly rows: readonly { readonly table: string; readonly values: Readonly<Record<string, unknown>> }[];
}

/**
 * The business head's zone over K-04 v1's seeds (seed-business-head.json), plus Lee Home Services, which K-04's core
 * seeds leave out: the zone of every demo business in K-04 v1's and K-23 v1's seeds (K-17 README, "The double").
 */
export function seedBusinessZones(read: string[] = []): BusinessZones {
  const seed = contractFile("db-schema/core/fixtures/seed-business-head.json") as SeedRows;
  const zones = new Map<string, string>([["biz-lee-home-services", NEW_YORK]]);
  for (const row of seed.rows) {
    const { id, time_zone: zone } = row.values;
    if (row.table === "businesses" && typeof id === "string" && typeof zone === "string") zones.set(id, zone);
  }
  return {
    zoneOf(businessId) {
      read.push(businessId);
      return Promise.resolve(zones.get(businessId) ?? null);
    },
  };
}

/** Nothing known of a visit's place. */
export const NOWHERE: VisitPlace = { addressZone: null, remote: false, otherZone: null };

/** A visit's key in the places double: its business and booking ("new" for none). */
export const visitKey = (businessId: string, bookingId: string | null): string =>
  `${businessId}/${bookingId ?? "new"}`;

/** Where visits happen, by visitKey; nothing known of any other. Each ask is written down. */
export function placesOf(
  places: Readonly<Partial<Record<string, VisitPlace>>>,
  asked: VisitRef[] = [],
): VisitPlaces {
  return {
    placeOf(visit) {
      asked.push(visit);
      return Promise.resolve(places[visitKey(visit.businessId, visit.bookingId)] ?? NOWHERE);
    },
  };
}

/** What C-120 read from photos, by field name; any other field is from its words. Each ask is written down. */
export function photosOf(
  sources: Readonly<Partial<Record<string, ValueSource>>>,
  asked: FieldRef[] = [],
): PhotoReadings {
  return {
    sourceOf(field) {
      asked.push(field);
      return Promise.resolve(sources[field.field] ?? { from: "words" });
    },
  };
}

export interface World {
  /** The business head's zone; default K-04's seeds (seedBusinessZones). */
  readonly zones?: BusinessZones;
  readonly places?: VisitPlaces;
  readonly photos?: PhotoReadings;
}

/** Limit 6 itself, over doubles of its ports. */
export function limitIn(world: World = {}): ValuesLimit {
  const zones = world.zones ?? seedBusinessZones();
  return createLimit6({
    businessZones: () => zones,
    places: world.places ?? NO_PLACE_KNOWN,
    photos: world.photos ?? NO_PHOTO_READINGS,
  });
}

/** The gate turn one request gives a limit (as runGate makes it), in the request's business scope. */
export function turnOf(request: GateRequest): GateTurn {
  const { input, caller } = request;
  if (input.kind !== "decided") throw new Error("limit 6's tests gate decided texts");
  if (caller.businessId === null) throw new Error("a gated request names its business");
  return {
    request,
    context: input.decided.context,
    decide: input.decided.decide,
    repo: TEST_REPO,
    businessId: caller.businessId,
  };
}

function isGated(part: DecidePart): part is GatedVerbPart {
  return (
    part.verb === "choose" || part.verb === "enter" || part.verb === "pass_on" || part.verb === "hand_off"
  );
}

/** Part `index` of a request as the gate hands it to a limit, with the offered choice it names (as runGate finds it). */
export function partOf(request: GateRequest, index = 0): GatePart {
  const { input } = request;
  if (input.kind !== "decided") throw new Error("limit 6's tests gate decided texts");
  const entry = input.decided.decide.parts[index];
  if (entry === undefined || !isGated(entry.part)) throw new Error(`no gated part ${String(index)}`);
  const { part } = entry;
  const choiceId = part.verb === "choose" || part.verb === "enter" ? part.choice : null;
  const choice = input.decided.context.choices.find((each) => each.choiceId === choiceId) ?? null;
  return { index, part, choice };
}

/** Limits 1 to 5 as the gate framework's scripted doubles, with `limit` in slot 6 (each call written down). */
export function registryWith(
  limit: ValuesLimit,
  script: Script = {},
  calls: LimitCall[] = [],
): LimitRegistry {
  const [one, two, three, four, five] = scriptedLimits(script, calls);
  const six: Limit<6> = {
    limit: 6,
    check(part, turn) {
      calls.push({ limit: 6, part: part.index });
      return limit.check(part, turn);
    },
  };
  return [one, two, three, four, five, six];
}

/** A K-09 gate fixture's script without limit 6's verdict: the real limit 6 gives its own. */
export function withoutLimit6(script: Script): Script {
  const out: Record<number, PartScript> = {};
  for (const [part, verdicts] of Object.entries(script)) {
    if (verdicts === undefined) continue;
    const rest: PartScript = { ...verdicts };
    Reflect.deleteProperty(rest, 6);
    out[Number(part)] = rest;
  }
  return out;
}

/** A K-09 gate exchange's request, freshly parsed. */
export function exchangeRequest(file: string): GateRequest {
  return copy(gateExchange(file).request);
}

/** The decided pair a request carries. */
export function decidedIn(request: GateRequest): Decided {
  if (request.input.kind !== "decided") throw new Error("not decided texts");
  return request.input.decided;
}

// ---------------------------------------------------------------------------------------------------------------
// Building a turn

/** Someone who writes, with their role at a business. */
export interface Writer {
  readonly personId: string;
  readonly name: string;
  /** The handle's address, as K-04's seed writes it (K-02 writer.handle). */
  readonly address: string;
  readonly role: "owner" | "staff" | "customer";
  readonly businessId: string;
}

export const SAM: Writer = {
  personId: "person-sam",
  name: "Sam Lee",
  address: "+15555550100",
  role: "owner",
  businessId: "biz-lees-barbershop",
};
export const ALEX: Writer = {
  personId: "person-alex",
  name: "Alex M.",
  address: "+15555550101",
  role: "customer",
  businessId: "biz-lees-barbershop",
};

export const BARBERSHOP = "biz-lees-barbershop";
export const HOME_SERVICES = "biz-lee-home-services";

/** What a choice acts on: a business, and a booking with its date and time in its zone, or none. */
export function targetAt(
  businessId: string,
  bookingId: string | null = null,
  visitAt: Target["visitAt"] = null,
): Target {
  const businessName = businessId === HOME_SERVICES ? "Lee Home Services" : "Lee's Barbershop";
  return { businessId, businessName, bookingId, visitAt };
}

/** A typed text of the turn, sent at `utc`, shown in `zone`. */
export function typed(eventId: string, words: string, utc: string, zone = NEW_YORK): Text {
  return { eventId, kind: "text", words, sentAt: { utc, zone }, attachments: [], poll: null, tapback: null };
}

interface ChoiceGiven {
  readonly choiceId: string;
  readonly step: string;
  readonly label: string;
  readonly definition: string;
  readonly target: Target;
  readonly fields: Choice["fields"];
  readonly stakesFrom?: Choice["stakesFrom"];
}

const stakesOf = (stakesFrom: Choice["stakesFrom"]): Pick<Choice, "stakes" | "stakesFrom"> => ({
  stakes: stakesFrom.length > 0 ? "high" : "low",
  stakesFrom,
});

/** An option of an open question. */
export function optionChoice(given: ChoiceGiven & { readonly question: string }): Choice {
  return {
    choiceId: given.choiceId,
    kind: "option",
    label: given.label,
    definition: given.definition,
    step: given.step,
    question: given.question,
    branch: given.label,
    anytimeRow: null,
    door: null,
    hub: null,
    target: given.target,
    fields: given.fields,
    ...stakesOf(given.stakesFrom ?? []),
  };
}

/** A hub case (K-02 default 6: chosen, its question the hub's step). */
export function hubChoice(given: ChoiceGiven & { readonly hub: NonNullable<Choice["hub"]> }): Choice {
  return {
    choiceId: given.choiceId,
    kind: "hub",
    label: given.label,
    definition: given.definition,
    step: given.step,
    question: given.step,
    branch: given.label,
    anytimeRow: null,
    door: null,
    hub: given.hub,
    target: given.target,
    fields: given.fields,
    ...stakesOf(given.stakesFrom ?? []),
  };
}

/** The any-time row "move" (arch 03 line 171), high stakes: moveRow (K-02 README "Stakes"). */
export function moveChoice(given: Omit<ChoiceGiven, "stakesFrom">): Choice {
  return {
    choiceId: given.choiceId,
    kind: "anytime",
    label: given.label,
    definition: given.definition,
    step: given.step,
    question: null,
    branch: null,
    anytimeRow: "move",
    door: null,
    hub: null,
    target: given.target,
    fields: given.fields,
    ...stakesOf([{ why: "moveRow", step: null, ref: null }]),
  };
}

/** A door to a new booking (arch 03 line 165). */
export function newBookingDoor(given: Omit<ChoiceGiven, "stakesFrom">): Choice {
  return {
    choiceId: given.choiceId,
    kind: "door",
    label: given.label,
    definition: given.definition,
    step: given.step,
    question: null,
    branch: null,
    anytimeRow: null,
    door: "newBooking",
    hub: null,
    target: given.target,
    fields: given.fields,
    stakes: "low",
    stakesFrom: [],
  };
}

/** A field of a part: its name, the model's value and the words it cites. */
export function field(name: string, value: Field["value"], words: string): Field {
  return { name, value, words };
}

/** The part decide agreed for `choice`: choose for an option or a hub case, enter otherwise. */
export function partFor(choice: Choice, quote: string, fields: readonly Field[]): DecidePart {
  return choice.kind === "option" || choice.kind === "hub" || choice.kind === "whichBooking"
    ? { verb: "choose", quote, question: choice.question ?? "", choice: choice.choiceId, fields: [...fields] }
    : { verb: "enter", quote, choice: choice.choiceId, fields: [...fields] };
}

export interface TurnGiven {
  readonly turnId: string;
  readonly flow: "A" | "B";
  readonly writer: Writer;
  readonly texts: readonly [Text, ...Text[]];
  readonly choices: readonly [Choice, ...Choice[]];
  readonly openQuestions?: readonly ContextQuestion[];
  readonly parts: readonly [DecidePart, ...DecidePart[]];
  /** Whether decide's one Sonnet re-read ran; default false. */
  readonly reread?: boolean;
  /** The text's language as decide reports it; default en. */
  readonly language?: string | null;
}

const BUNDLE = { hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037", build: 1 };
const PREFIX = "18d7f9c761c1f58436d2e3e9148b64386221b1d0affa33a8c7b0226c06b6ebea";

/** A context with the decide result made from it, both reads agreeing on `parts` (and the re-read, when it ran). */
export function decidedFor(given: TurnGiven): Decided {
  const high = given.choices.some((choice) => choice.stakes === "high");
  const language = given.language === undefined ? "en" : given.language;
  const [firstPart, ...moreParts] = given.parts;
  const output: Decided["decide"]["reads"][number]["output"] = {
    language: language ?? "en",
    parts: [copy(firstPart), ...moreParts.map((part) => copy(part))],
  };
  const reread = given.reread ?? false;
  type Reads = Decided["decide"]["reads"];
  const first: Reads[number] = { model: high ? "sonnet" : "haiku", role: "first", output: copy(output) };
  const check: Reads[number] = { model: "haiku", role: "check", output: copy(output) };
  const reads: Reads = reread
    ? [first, check, { model: "sonnet", role: "reread", output: copy(output) }]
    : [first, check];
  return {
    context: {
      turnId: given.turnId,
      bundleId: { ...BUNDLE },
      flow: given.flow,
      texts: [copy(given.texts[0]), ...given.texts.slice(1).map((text) => copy(text))],
      writer: {
        handle: given.writer.address,
        people: [
          {
            personId: given.writer.personId,
            name: given.writer.name,
            roles: [{ role: given.writer.role, businessId: given.writer.businessId }],
            language: "en",
          },
        ],
      },
      businessLanguage: "en",
      openQuestions: (given.openQuestions ?? []).map((question) => copy(question)),
      choices: [copy(given.choices[0]), ...given.choices.slice(1).map((choice) => copy(choice))],
      cards: [],
      facts: [],
      alwaysOn: { flow: given.flow, prefixSha256: PREFIX },
      recentMessages: [],
      meaningSearch: null,
    },
    decide: {
      turnId: given.turnId,
      bundleId: { ...BUNDLE },
      stakes: high ? "high" : "low",
      routing: high ? { first: "sonnet", second: "haiku" } : { first: "haiku", second: "haiku" },
      reads,
      agreed: true,
      reread,
      language,
      parts: [
        { part: copy(firstPart), outcome: "go" },
        ...moreParts.map((part) => ({ part: copy(part), outcome: "go" as const })),
      ],
    },
  };
}

/** A gateAndCommit request for the turn (framework test-support gateRequest: the writer's turn, 'now' its last text). */
export function requestFor(given: TurnGiven): GateRequest {
  return gateRequest(decidedFor(given));
}

/** The same request with decide's one re-read run (the turn back at the gate after C-116). */
export function afterReread(request: GateRequest): GateRequest {
  const call = copy(request);
  const decided = decidedIn(call);
  const [first] = decided.decide.reads;
  decided.decide.reread = true;
  decided.decide.reads.push({ model: "sonnet", role: "reread", output: copy(first.output) });
  return call;
}

// ---------------------------------------------------------------------------------------------------------------
// The scenarios

/** A part's open question as the context lists it. */
export function questionOf(
  openQuestionId: string,
  step: string,
  target: Target,
  sentAt: string,
  askCount = 1,
): ContextQuestion {
  return { openQuestionId, step, target, sentAt: { utc: sentAt, zone: NEW_YORK }, pollId: null, askCount };
}

// ---- Alex moves his Lee Home Services visit (flow B), placed in Los Angeles -------------------------------------------

/** Alex's flow B visit at Lee Home Services (B7-07's move), arriving Fri Oct 30 at 8am in Los Angeles. */
export const ALEX_VISIT = "booking-alex-drain";
export const ALEX_VISIT_AT = { utc: "2026-10-30T15:00:00Z", zone: LOS_ANGELES };
/** Alex, on Lee Home Services' books. */
export const ALEX_FLOW_B: Writer = { ...ALEX, businessId: HOME_SERVICES };
/** Sun Oct 25 2026, 23:30 in New York (EDT): already Mon 03:30 in UTC, still Sun 20:30 in Los Angeles. */
export const LATE_SUNDAY = "2026-10-26T03:30:00Z";

/**
 * Alex texts "can we do tomorrow at 3 instead" at 23:30 New York time to move his flow B visit (the any-time row move,
 * handled by B7-07), decide giving the time `time_saved` as `value` from the words "tomorrow at 3". With `bookingId`
 * null it is a new booking's door instead (B4-16's pick with a time), whose zone is the visit address's.
 */
export function moveRequest(
  value: Field["value"],
  options: { readonly bookingId?: string | null; readonly reread?: boolean } = {},
): GateRequest {
  const bookingId = options.bookingId === undefined ? ALEX_VISIT : options.bookingId;
  const target = targetAt(HOME_SERVICES, bookingId, bookingId === null ? null : ALEX_VISIT_AT);
  const fields: Choice["fields"] = [{ name: "time_saved", type: "time" }];
  const choice =
    bookingId === null
      ? newBookingDoor({
          choiceId: "c-01",
          step: "B4-16",
          label: "A new booking",
          definition: "Something new.",
          target,
          fields,
        })
      : moveChoice({
          choiceId: "c-01",
          step: "B7-07",
          label: "Move",
          definition: "The customer asks to move.",
          target,
          fields,
        });
  const words = "can we do tomorrow at 3 instead";
  return requestFor({
    turnId: `turn-alex-move-${bookingId ?? "new"}`,
    flow: "B",
    writer: ALEX_FLOW_B,
    texts: [typed("evt-alex-0201", words, LATE_SUNDAY)],
    choices: [choice],
    parts: [partFor(choice, words, [field("time_saved", value, "tomorrow at 3")])],
    reread: options.reread ?? false,
  });
}

// ---- Alex moves his haircut across the clocks' change (flow A, the barbershop's zone) ---------------------------------

/** Alex's haircut, Sat Oct 31 at 11:00am at the barbershop (EDT). */
export const HAIRCUT = "booking-alex-haircut";
/** Sat Oct 31 2026, 10:00am in New York (EDT): the clocks fall back that night (S13-03: "like on Sun Nov 1"). */
export const SATURDAY_BEFORE_CHANGE = "2026-10-31T14:00:00Z";

/**
 * Alex texts `words` on Sat Oct 31 at 10:00am to move his haircut (the any-time row move, A7-03's handler), decide giving
 * `time_saved` as `value` from `cited`. With `bookingId` null it is a new booking's door, read in the business's zone.
 * `sentAt` sends the text at another time (UTC).
 */
export function haircutMoveRequest(
  value: Field["value"],
  cited: string,
  words: string,
  options: {
    readonly bookingId?: string | null;
    readonly language?: string | null;
    readonly sentAt?: string;
  } = {},
): GateRequest {
  const bookingId = options.bookingId === undefined ? HAIRCUT : options.bookingId;
  const target = targetAt(
    BARBERSHOP,
    bookingId,
    bookingId === null ? null : { utc: "2026-10-31T15:00:00Z", zone: NEW_YORK },
  );
  const fields: Choice["fields"] = [{ name: "time_saved", type: "time" }];
  const choice =
    bookingId === null
      ? newBookingDoor({
          choiceId: "c-01",
          step: "A3-51",
          label: "A new booking",
          definition: "Something new.",
          target,
          fields,
        })
      : moveChoice({
          choiceId: "c-01",
          step: "A7-03",
          label: "Move",
          definition: "The customer asks to move.",
          target,
          fields,
        });
  return requestFor({
    turnId: `turn-alex-haircut-${bookingId ?? "new"}`,
    flow: "A",
    writer: ALEX,
    texts: [typed("evt-alex-0301", words, options.sentAt ?? SATURDAY_BEFORE_CHANGE)],
    choices: [choice],
    parts: [partFor(choice, words, [field("time_saved", value, cited)])],
    ...(options.language === undefined ? {} : { language: options.language }),
  });
}

// ---- Sam raises the haircut's price (S11-20) -------------------------------------------------------------------------

/** "A change to the settings" (S11-12's hub case, K-02 context-two-requests.json), at the barbershop. */
export function settingsChoice(): Choice {
  return hubChoice({
    choiceId: "c-04",
    step: "S11-12",
    label: "A change to the settings",
    definition: "Sam changes prices, rules, money settings or a part refund by text or call.",
    target: targetAt(BARBERSHOP),
    fields: [
      { name: "service", type: "text" },
      { name: "price", type: "money" },
    ],
    hub: "owner",
  });
}

/** Sam's S11-20 "raise haircut to 40", decide giving the service and the price `price` from `priceWords`. */
export function raisePriceRequest(price: Field["value"], priceWords: string, reread = false): GateRequest {
  return priceChangeRequest("raise haircut to 40", price, priceWords, reread);
}

/**
 * Sam's S11-20 price change for the haircut in his own words `words` ("raise haircut to 140", "raise haircut to $1,200"),
 * decide giving the service from "haircut" and the price `price` from `priceWords`.
 */
export function priceChangeRequest(
  words: string,
  price: Field["value"],
  priceWords: string,
  reread = false,
): GateRequest {
  const choice = settingsChoice();
  const said = words === "raise haircut to 40" ? "" : `${words.replace(/\W+/g, "-")}-`;
  return requestFor({
    turnId: `turn-sam-raise-haircut-${said}${priceWords.replace(/\W+/g, "-")}`,
    flow: "A",
    writer: SAM,
    texts: [typed("evt-sam-1120", words, "2026-10-26T15:40:00Z")],
    choices: [choice],
    parts: [
      partFor(choice, words, [field("service", "haircut", "haircut"), field("price", price, priceWords)]),
    ],
    reread,
  });
}

// ---- Alex asks to bring a group (a new booking's door, with a count) -------------------------------------------------

/** Mon Oct 19 2026, 10:05am in New York (EDT): before the master's own "Sat Oct 24 · 11:00am". */
export const MONDAY_OCT_19 = "2026-10-19T14:05:00Z";

/**
 * Alex texts `words` to the barbershop's door for a new booking (A3-51), decide giving how many people come, `people`
 * (an integer field), as `value` from `cited`.
 */
export function groupRequest(value: Field["value"], cited: string, words: string): GateRequest {
  const choice = newBookingDoor({
    choiceId: "c-01",
    step: "A3-51",
    label: "A new booking",
    definition: "Something new.",
    target: targetAt(BARBERSHOP),
    fields: [{ name: "people", type: "integer" }],
  });
  return requestFor({
    turnId: "turn-alex-group",
    flow: "A",
    writer: ALEX,
    texts: [typed("evt-alex-0401", words, MONDAY_OCT_19)],
    choices: [choice],
    parts: [partFor(choice, words, [field("people", value, cited)])],
  });
}

// ---- Alex picks one of the times offered (an open question's options, with a choice field) ---------------------------

/** A4-14's question to Alex with the two times it offers, as options labelled "10am" and "11am". */
export const TIME_QUESTION = "oq-a4-14-alex";

/**
 * Alex answers A4-14's offered times ("10am", "11am") with `words`, decide choosing the first option, c-01, with the pick
 * `time_pick` (a choice field: an offered option's id) as `value` from `cited`. `askCount` is the question's.
 */
export function timePickRequest(
  value: Field["value"],
  cited: string,
  words: string,
  askCount = 1,
): GateRequest {
  const target = targetAt(BARBERSHOP);
  const fields: Choice["fields"] = [{ name: "time_pick", type: "choice" }];
  const offered = (choiceId: string, label: string): Choice =>
    optionChoice({
      choiceId,
      step: "A4-14",
      question: TIME_QUESTION,
      label,
      definition: "Alex picks the time.",
      target,
      fields,
    });
  const first = offered("c-01", "10am");
  return requestFor({
    turnId: "turn-alex-time-pick",
    flow: "A",
    writer: ALEX,
    texts: [typed("evt-alex-0402", words, MONDAY_OCT_19)],
    choices: [first, offered("c-02", "11am")],
    openQuestions: [questionOf(TIME_QUESTION, "A4-14", target, "2026-10-19T14:00:00Z", askCount)],
    parts: [partFor(first, words, [field("time_pick", value, cited)])],
  });
}

/** The request with an open question its step `step` asked about `target`, asked `askCount` times, in its context. */
export function askedAbout(
  request: GateRequest,
  step: string,
  target: Target,
  askCount: number,
): GateRequest {
  const call = copy(request);
  const id = `oq-${step.toLowerCase()}-asked-${String(askCount)}`;
  decidedIn(call).context.openQuestions.push(questionOf(id, step, target, "2026-10-19T14:00:00Z", askCount));
  return call;
}

// ---- Sam sends his price board as a photo (S1-12), read back on the money card (S1-13) --------------------------------

export const PRICE_BOARD = "att-sam-price-board";
/** S1-13's money card read-back to Sam, word for word (the master's S1-13 message): the haircut's line. */
export const HAIRCUT_LINE = "A) Haircut · $35";
/** When the money card went out. */
export const MONEY_CARD_SENT = "2026-10-19T14:40:00Z";

/** Sam's price board photo with his caption `caption`, decide giving the haircut's price `price` from `cited`. */
export function priceBoardRequest(price: Field["value"], caption: string, cited: string): GateRequest {
  const target = targetAt(BARBERSHOP);
  const choice = optionChoice({
    choiceId: "c-01",
    step: "S1-12",
    question: "oq-s1-12-sam",
    label: "Sends the price list as a photo",
    definition: "Rosie reads the owner's own list into services, and asks about anything it can't read.",
    target,
    fields: [{ name: "price", type: "money" }],
  });
  const photo: Text = {
    ...typed("evt-sam-0112", caption, "2026-10-19T14:30:00Z"),
    attachments: [{ attachmentId: PRICE_BOARD, mediaType: "image/jpeg" }],
  };
  return requestFor({
    turnId: "turn-s1-12-sam-board",
    flow: "A",
    writer: SAM,
    texts: [photo],
    choices: [choice],
    openQuestions: [questionOf("oq-s1-12-sam", "S1-12", target, "2026-10-19T14:20:00Z")],
    parts: [partFor(choice, caption, [field("price", price, cited)])],
  });
}
