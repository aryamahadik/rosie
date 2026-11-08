// Doubles and scenarios for limit 1's tests (T-299). Never imported by the Worker. The doubles stand in for limit 1's
// ports (T-308's K-04 reader, S13-45's one rule, T-322's proof codes) and for limits 2 to 6 (T-300 to T-304), never for
// limit 1. Values come only from the contracts' fixtures and the master's sample cast: K-04 v1's seeds (Sam, Alex, Riley,
// Lee's Barbershop, Alex's haircut), K-22 v1's team at Lee Home Services (Pat, the office manager; Jordan), K-09 v1's
// exchanges (Sam's new mobile, Alex's Nov 14 visit), T-308's examples (A4-26's gift, A4-55's employer) and the master's
// steps (S2-22, S11-42, S11-53, S11-22, S11-25, S11-61, S12-23, S12-24, A7-66, A7-02, A7-11, A7-17, A7-81, A7-98, A3-30,
// A3-48, A3-50, A3-51, A4-14, A4-24, A4-82; round 3: A10-09, A7-92, A7-93, A4-01, A4-09, A4-12, A4-28, A4-80, B4-92);
// phone numbers in the 555-01xx range (rule 9). The turn's bundle (K-01 v1) is a double too: the steps the scenarios
// reach, each with who it is from and to as the master writes it (MASTER_STEPS below), and K-01's own sample bundle.

import { readFileSync } from "node:fs";
import path from "node:path";

import type { BookingHead } from "../../../../db/repo/bookings-head";
import { createIdentityAccess, type IdentityAccess } from "../../domain/identity-access";
import {
  CUT_PAID_BY_EMPLOYER,
  GIFT_FOR_BROTHER,
  HOME_SERVICES,
  adminPowersOf,
  powerRow,
  readerOf,
  seedRecord,
  withRows,
  type TestRecord,
} from "../../domain/identity-access/test-support";
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
  scriptedLimits,
  type LimitCall,
  type PartScript,
  type Script,
} from "../framework/test-support";
import { CONTRACTS_DIR } from "../../tool-api/validator";
import {
  bookingStagesOver,
  sideOf,
  stepCardsOf,
  type BookingStages,
  type CodeAsk,
  type ContactsOnFile,
  type Lane,
  type OwnAsk,
  type PlannedCode,
  type ProofCodes,
  type StepCards,
} from "./facts";
import { createLimit1, type AllowedLimit, type Limit1Deps } from "./index";

export type Text = Context["texts"][number];
export type ContextQuestion = Context["openQuestions"][number];

/** The zone the barbershop's texts resolve in (K-04 seeds; the fixtures' texts). */
export const ZONE = "America/New_York";

/** K-04 seed-business-head's barbershop; K-23's Lee Home Services, where Pat is an admin (K-22). */
export const BARBERSHOP = "biz-lees-barbershop";
export { HOME_SERVICES };

// ---------------------------------------------------------------------------------------------------------------
// The people

export interface Someone {
  /** The person the call acts for (K-09 v1 caller.personId); null for a sender nobody on the record. */
  readonly personId: string | null;
  readonly handleId: string;
  /** The handle's address, as K-04's seed writes it (K-02 writer.handle). */
  readonly address: string;
  readonly name: string;
}

export const SAM: Someone = {
  personId: "person-sam",
  handleId: "handle-sam",
  address: "+15555550100",
  name: "Sam Lee",
};
/** K-09 commit-limit-1-unproven-sender.json: Sam's new mobile, linked to him but not his owner mobile on file. */
export const SAM_NEW_MOBILE: Someone = {
  personId: "person-sam",
  handleId: "handle-sam-new-mobile",
  address: "+15555550177",
  name: "Sam Lee",
};
export const ALEX: Someone = {
  personId: "person-alex",
  handleId: "handle-alex",
  address: "+15555550101",
  name: "Alex M.",
};
/** Alex texting from a new mobile that is not his contact on file. */
export const ALEX_NEW_MOBILE: Someone = {
  personId: "person-alex",
  handleId: "handle-alex-new-mobile",
  address: "+15555550178",
  name: "Alex M.",
};
/** Someone else who writes from Alex's phone (one handle can be several people: arch 01 line 55). */
export const ALEX_PARTNER: Someone = { ...ALEX, personId: "person-alex-partner", name: "Jamie" };
export const RILEY: Someone = {
  personId: "person-riley",
  handleId: "handle-riley",
  address: "+15555550102",
  name: "Riley",
};
/** K-22 seed-staff-invited: Pat, Lee Home Services' office manager, an admin. */
export const PAT: Someone = {
  personId: "person-pat",
  handleId: "handle-pat",
  address: "+15555550107",
  name: "Pat",
};
/** K-22 seed-staff-joined: Jordan, staff at Lee Home Services. */
export const JORDAN: Someone = {
  personId: "person-jordan",
  handleId: "handle-jordan",
  address: "+15555550108",
  name: "Jordan",
};
/** A4-26's brother, the person served on the gift, on his own phone. */
export const BROTHER: Someone = {
  personId: "person-alex-brother",
  handleId: "handle-alex-brother",
  address: "+15555550179",
  name: "Sam M.",
};
/** A4-55's employer, who pays for Alex's cut. */
export const EMPLOYER: Someone = {
  personId: "person-alex-employer",
  handleId: "handle-alex-employer",
  address: "+15555550180",
  name: "Lee Tile",
};
/** A number nobody on the record writes from. */
export const STRANGER: Someone = {
  personId: null,
  handleId: "handle-new-0181",
  address: "+15555550181",
  name: "",
};

// ---------------------------------------------------------------------------------------------------------------
// The bookings and the record

/** K-04 seed-booking-head: Alex books his haircut, is the person served and pays. */
export const HAIRCUT = "booking-alex-haircut";
/** K-09 commit-limit-2-owner-rule.json's visit: Alex with Riley on Nov 14. */
export const NOV14 = "booking-alex-riley-nov14";
/** A4-26 (T-308's GIFT_FOR_BROTHER, booked): Alex books and pays; his brother is the person served. */
export const GIFT = GIFT_FOR_BROTHER.id;
/** A4-55 (T-308's CUT_PAID_BY_EMPLOYER): Alex books and is served; his employer pays. */
export const EMPLOYER_PAYS = CUT_PAID_BY_EMPLOYER.id;
/** A4-26's gift while it is still being made (stage entry). */
export const GIFT_BEING_MADE = "booking-alex-gift-being-made";
/** A new booking Alex is making, before A4-80's who-for answer reaches A4-24. */
export const NEW_REQUEST = "booking-alex-new-request";
/** A booked visit whose person served is not on the record. */
export const SERVED_UNKNOWN = "booking-alex-served-unknown";
/** A booked visit at Lee Home Services (flow B), where Pat is an admin: Alex books it for himself and pays. */
export const HOME_VISIT = "booking-alex-home-visit";
/** Round 3: Sam's own haircut at his barbershop, where he is the owner: he books it, is the person served and pays. */
export const SAM_OWN_CUT = "booking-sam-own-cut";
/** Round 3: Pat's own visit at Lee Home Services, where she is an admin: she books it, is the person served and pays. */
export const PAT_OWN_VISIT = "booking-pat-own-visit";

/** A booked visit someone books for themself and pays for. */
function ownBooking(
  id: string,
  businessId: string,
  flow: BookingHead["flow"],
  personId: string,
): BookingHead {
  return {
    id,
    businessId,
    flow,
    stage: "booked",
    bookerPersonId: personId,
    servedPersonId: personId,
    payerPersonId: personId,
    private: false,
    deceased: false,
    version: 1,
  };
}

function alexBooking(
  id: string,
  stage: BookingHead["stage"],
  served: string | null,
  payer: string | null,
): BookingHead {
  return {
    id,
    businessId: BARBERSHOP,
    flow: "A",
    stage,
    bookerPersonId: "person-alex",
    servedPersonId: served,
    payerPersonId: payer,
    private: false,
    deceased: false,
    version: 1,
  };
}

/**
 * K-04's and K-22's seeds with the scenarios' rows: Sam's new mobile and someone else on Alex's phone (person_handles),
 * the brother's and the employer's own phones, and the bookings above.
 */
export function limitRecord(): TestRecord {
  return withRows(seedRecord(), {
    personHandles: [
      { personId: "person-sam", handleId: SAM_NEW_MOBILE.handleId },
      { personId: "person-alex-partner", handleId: ALEX.handleId },
      { personId: "person-alex-brother", handleId: BROTHER.handleId },
      { personId: "person-alex-employer", handleId: EMPLOYER.handleId },
    ],
    bookings: [
      alexBooking(NOV14, "booked", "person-alex", "person-alex"),
      GIFT_FOR_BROTHER,
      CUT_PAID_BY_EMPLOYER,
      alexBooking(GIFT_BEING_MADE, "entry", "person-alex-brother", "person-alex"),
      alexBooking(NEW_REQUEST, "entry", null, null),
      alexBooking(SERVED_UNKNOWN, "booked", null, "person-alex"),
      {
        ...alexBooking(HOME_VISIT, "booked", "person-alex", "person-alex"),
        businessId: HOME_SERVICES,
        flow: "B",
      },
      ownBooking(SAM_OWN_CUT, BARBERSHOP, "A", "person-sam"),
      ownBooking(PAT_OWN_VISIT, HOME_SERVICES, "B", "person-pat"),
    ],
  });
}

/** The record with Pat (staff-pat-home-services) given these K-22 powers. */
export function patWith(record: TestRecord, ...powers: string[]): TestRecord {
  return withRows(record, {
    powers: powers.map((power) => powerRow("staff-pat-home-services", HOME_SERVICES, power)),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The doubles

/** The repo a test hands the limit: the doubles never read it. */
export const TEST_REPO = { name: "limit-1-test-repo" } as const;

/** T-308's service over a test record, for the call's business, with K-22's powers read from the record. */
export function identityFrom(record: TestRecord): (repo: unknown, businessId: string) => IdentityAccess {
  return (_repo, businessId) =>
    createIdentityAccess({ businessId, reader: readerOf(record), adminPowers: adminPowersOf(record) });
}

/** The stage read over a test record (K-04's booking heads). */
export function stagesFrom(record: TestRecord): (repo: unknown, businessId: string) => BookingStages {
  return (_repo, businessId) => bookingStagesOver(readerOf(record), businessId);
}

// The turn's bundle (K-01 v1), as limit 1 reads each step's side (DL-188 ruling 1)

/** A step as the double writes it: who it is from, who it is to (null: nobody), how, and a split's branches. */
type StepSeed = readonly [
  who: Lane,
  to: Lane | null,
  via: string,
  branches?: readonly (readonly [label: string, steps: readonly string[]])[],
];

/**
 * The master's steps the scenarios reach, as master-A.json and master-B.json write them (the step index of each flow,
 * "who→to via", and a split's branches with their own steps, from MASTER-FLOW-A.md and MASTER-FLOW-B.md). A split whose
 * branches no walk follows (an open question's step) is written without them. A7-02, the booked hub, lists its seven
 * cases and, last, the two cases the round 1 scenarios pick (addPayer, moveVisit), each leading to the master step it
 * stands for: A4-55 "Someone else pays on the page" (other→san page) and A7-03 "Offers new times; moves it" (A7-92's
 * "Alex moves it"). The master's A7-02 does not list those two.
 */
const MASTER_STEPS: Readonly<Record<string, StepSeed>> = {
  "A3-30": ["san", "owner", "msg"],
  "A4-01": ["san", null, "auto"],
  "A4-09": ["san", "owner", "msg"],
  "A4-12": ["san", "cust", "msg"],
  "A4-14": ["agent", "cust", "chat"],
  "A4-15": ["cust", "agent", "chat"],
  "A4-23": ["agent", "san", "sync"],
  "A4-24": ["san", null, "auto"],
  "A4-28": ["san", null, "auto"],
  "A4-55": ["other", "san", "page"],
  "A4-80": ["agent", "cust", "chat"],
  "A4-82": ["agent", "cust", "chat"],
  "A7-02": [
    "san",
    null,
    "auto",
    [
      ["Nothing changes", []],
      ["Alex changes the plan", ["A7-92"]],
      ["The business can't give it", ["A7-93"]],
      ["A plan or count is due", ["A7-94"]],
      ["Something needed first", ["A7-74"]],
      ["A question, note or stop word", ["A7-96"]],
      ["Safety, privacy or a death", ["A7-97"]],
      ["Someone else pays", ["A4-55"]],
      ["Move it", ["A7-03"]],
    ],
  ],
  "A7-03": ["san", "cust", "msg"],
  "A7-05": [
    "san",
    "cust",
    "msg",
    [
      ["2 Cancel it", []],
      ["1 Keep it", []],
      ["No reply", []],
    ],
  ],
  "A7-06": [
    "san",
    "cust",
    "msg",
    [
      ["2 Cancel anyway", []],
      ["1 Keep it", []],
      ["No reply", []],
    ],
  ],
  "A7-14": ["staff", "san", "msg"],
  "A7-15": ["san", "owner", "msg"],
  "A7-17": ["san", "cust", "msg"],
  "A7-23": ["owner", "san", "msg"],
  "A7-31": ["san", "cust", "msg"],
  "A7-32": ["san", "cust", "msg"],
  "A7-66": ["owner", "san", "msg"],
  "A7-68": ["san", "owner", "msg"],
  "A7-70": ["san", "cust", "msg"],
  "A7-92": [
    "san",
    null,
    "auto",
    [
      ["Alex moves it", ["A7-03"]],
      ["Alex cancels in time", ["A7-05"]],
      ["Alex cancels late", ["A7-06"]],
      ["Alex changes what's booked", ["A7-31"]],
      ["Alex runs late", ["A7-70"]],
      ["A plan is skipped, paused or ended", ["A7-32"]],
    ],
  ],
  "A7-93": [
    "san",
    null,
    "auto",
    [
      ["The pro can't come", ["A7-15", "A7-17"]],
      ["The pro runs late", ["A7-14"]],
      ["Sam moves it", ["A7-23"]],
      ["The business cancels it", ["A7-66"]],
      ["Too few booked to run", ["A7-68"]],
    ],
  ],
  "A7-98": ["cust", "san", "msg"],
  "A10-09": ["san", "owner", "msg"],
  "B4-01": ["san", null, "auto"],
  "B4-92": ["agent", "cust", "chat"],
};

/** A K-01 v1 flow graph value holding the seeded steps of one flow, as the turn's bundle stores it. */
function flowGraphOf(flow: "A" | "B"): unknown {
  const steps: Record<string, unknown> = {};
  for (const [id, [who, to, via, branches = []]] of Object.entries(MASTER_STEPS)) {
    if (!id.startsWith(flow)) continue;
    steps[id] = {
      id,
      section: Number(/^[AB](\d+)-/u.exec(id)?.[1]),
      lines: [],
      who,
      ...(to === null ? {} : { to }),
      via,
      title: id,
      does: "",
      pageTypes: [],
      next: null,
      lint: [],
      ...(branches.length === 0
        ? {}
        : {
            type: "split",
            branches: branches.map(([label, own]) => ({
              label,
              tag: "message",
              steps: [...own],
              rejoinAt: null,
              answerFields: [],
              effects: [],
            })),
          }),
    };
  }
  return { contract: "bundle.v1", flow, steps };
}

/** The turn's bundle's step cards over the seeded master steps (both flows). */
export const MASTER_STEP_CARDS: StepCards = stepCardsOf([flowGraphOf("A"), flowGraphOf("B")]);

/** limit 1's `steps` port answering `cards` for any turn (default: the seeded master steps). */
export function stepsOf(cards: StepCards = MASTER_STEP_CARDS): NonNullable<Limit1Deps["steps"]> {
  return () => cards;
}

/** A K-01 v1 sample bundle's flow graph (contracts/bundle/fixtures), freshly parsed. */
export function sampleFlowGraph(file: string, flow: "A" | "B"): unknown {
  const bundle = JSON.parse(readFileSync(path.join(CONTRACTS_DIR, "bundle", "fixtures", file), "utf8")) as {
    flows?: Record<string, unknown>;
  };
  return bundle.flows?.[flow] ?? null;
}

/** A business role's own mobile or email on file (K-22 accounts, staff): the handle that proves it. */
export interface RoleContact {
  readonly personId: string;
  readonly handleId: string;
}

/** Sam's owner mobile (handle-sam), Pat's and Jordan's own mobiles, Riley's: K-22's accounts and staff rows. */
export const ROLE_CONTACTS: readonly RoleContact[] = [
  { personId: "person-sam", handleId: SAM.handleId },
  { personId: "person-pat", handleId: PAT.handleId },
  { personId: "person-jordan", handleId: JORDAN.handleId },
  { personId: "person-riley", handleId: RILEY.handleId },
];

/**
 * S13-45's one rule over the record: a customer standing by the handle K-04 links to the person (as the shipped default),
 * a business standing by the role's own contact on file (`roles`), both only in a turn. Each question is written down.
 */
export function contactsOf(
  record: TestRecord,
  roles: readonly RoleContact[] = ROLE_CONTACTS,
  asked: OwnAsk[] = [],
): (identity: IdentityAccess) => ContactsOnFile {
  return () => ({
    isOwn(ask) {
      asked.push(ask);
      if (ask.caller !== "turn" || ask.handleId === null) return Promise.resolve(false);
      const rows =
        sideOf(ask.as) === "business"
          ? roles
          : record.personHandles.map((link) => ({ personId: link.personId, handleId: link.handleId }));
      return Promise.resolve(
        rows.some((row) => row.personId === ask.personId && row.handleId === ask.handleId),
      );
    },
  });
}

/** T-322's codes as a double: each ask written down, answered with `planned` (default: K-09's limit 1 code). */
export function proofCodesOf(asked: CodeAsk[] = [], planned: PlannedCode = SAM_NEW_MOBILE_CODE): ProofCodes {
  return {
    codeFor(ask) {
      asked.push(ask);
      return Promise.resolve({ ...planned });
    },
  };
}

/** K-09 commit-limit-1-unproven-sender.json's code and the question in the new mobile's chat that takes it. */
export const SAM_NEW_MOBILE_CODE: PlannedCode = {
  proofCodeId: "proof-sam-new-mobile-1",
  openQuestionId: "oq-sam-new-mobile-code",
};

export interface World {
  /** The K-04 and K-22 record T-308 reads; default limitRecord(). */
  readonly record?: TestRecord;
  /** The business roles' own contacts on file; default ROLE_CONTACTS. */
  readonly roles?: readonly RoleContact[];
  /** Where the one rule's questions are written down. */
  readonly ownAsked?: OwnAsk[];
  /** Where the code asks are written down. */
  readonly codeAsked?: CodeAsk[];
  /** T-322's codes; default a double answering SAM_NEW_MOBILE_CODE; null for none (the shipped default). */
  readonly proofCodes?: ProofCodes | null;
  /** The turn's bundle's step cards (K-01 v1); default the seeded master steps (MASTER_STEP_CARDS). */
  readonly steps?: StepCards;
}

/** Limit 1 itself, over doubles of its ports. */
export function limitIn(world: World = {}): AllowedLimit {
  const record = world.record ?? limitRecord();
  const proofCodes = world.proofCodes === undefined ? proofCodesOf(world.codeAsked ?? []) : world.proofCodes;
  return createLimit1({
    identity: identityFrom(record),
    stages: stagesFrom(record),
    contacts: contactsOf(record, world.roles ?? ROLE_CONTACTS, world.ownAsked ?? []),
    steps: stepsOf(world.steps),
    ...(proofCodes === null ? {} : { proofCodes }),
  });
}

/** The gate turn one request gives a limit (as runGate makes it), in the request's business scope. */
export function turnOf(request: GateRequest, repo: unknown = TEST_REPO): GateTurn {
  const { input, caller } = request;
  if (input.kind !== "decided") throw new Error("limit 1's tests gate decided texts");
  if (caller.businessId === null) throw new Error("a gated request names its business");
  return {
    request,
    context: input.decided.context,
    decide: input.decided.decide,
    repo,
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
  if (input.kind !== "decided") throw new Error("limit 1's tests gate decided texts");
  const entry = input.decided.decide.parts[index];
  if (entry === undefined || !isGated(entry.part)) throw new Error(`no gated part ${String(index)}`);
  const { part } = entry;
  const choiceId = part.verb === "choose" || part.verb === "enter" ? part.choice : null;
  const choice = input.decided.context.choices.find((each) => each.choiceId === choiceId) ?? null;
  return { index, part, choice };
}

/** Limits 2 to 6 as the gate framework's scripted doubles, with `limit` in slot 1 (each call written down). */
export function registryWith(limit: Limit<1>, script: Script = {}, calls: LimitCall[] = []): LimitRegistry {
  const [, two, three, four, five, six] = scriptedLimits(script, calls);
  const one: Limit<1> = {
    limit: 1,
    check(part, turn) {
      calls.push({ limit: 1, part: part.index });
      return limit.check(part, turn);
    },
  };
  return [one, two, three, four, five, six];
}

/** A K-09 gate fixture's script without limit 1's verdict: the real limit 1 gives its own. */
export function withoutLimit1(script: Script): Script {
  const out: Record<number, PartScript> = {};
  for (const [part, verdicts] of Object.entries(script)) {
    if (verdicts === undefined) continue;
    const rest: PartScript = { ...verdicts };
    Reflect.deleteProperty(rest, 1);
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
// The frontier's choices

const BUNDLE = { hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037", build: 1 };
/** Sat Oct 24, 11:00am in the barbershop's zone. */
const VISIT = { utc: "2026-10-24T15:00:00Z", zone: ZONE };

const BUSINESS_NAMES: Readonly<Record<string, string>> = {
  [BARBERSHOP]: "Lee's Barbershop",
  [HOME_SERVICES]: "Lee Home Services",
};

/** What a choice acts on: a booking of a business, or none. */
export function targetOf(businessId: string, bookingId: string | null): Choice["target"] {
  return {
    businessId,
    businessName: BUSINESS_NAMES[businessId] ?? businessId,
    bookingId,
    visitAt: bookingId === null ? null : VISIT,
  };
}

type Stakes = Choice["stakesFrom"];

function choiceBase(
  choiceId: string,
  step: string,
  label: string,
  target: Choice["target"],
  stakesFrom: Stakes,
): Choice {
  return {
    choiceId,
    kind: "option",
    label,
    definition: label,
    step,
    question: null,
    branch: null,
    anytimeRow: null,
    door: null,
    hub: null,
    target,
    fields: [],
    stakes: stakesFrom.length > 0 ? "high" : "low",
    stakesFrom,
  };
}

/** An option of an open question, as the frontier offers it. */
export function option(
  choiceId: string,
  question: string,
  step: string,
  branch: string,
  target: Choice["target"],
  stakesFrom: Stakes = [],
): Choice {
  return { ...choiceBase(choiceId, step, branch, target, stakesFrom), question, branch };
}

/** A hub case (arch 03 line 163): chosen with the hub's step as its question (K-02 default 6). */
export function hubCase(
  choiceId: string,
  hubStep: string,
  hub: NonNullable<Choice["hub"]>,
  label: string,
  target: Choice["target"],
  stakesFrom: Stakes = [],
): Choice {
  return {
    ...choiceBase(choiceId, hubStep, label, target, stakesFrom),
    kind: "hub",
    question: hubStep,
    branch: label,
    hub,
  };
}

/** An any-time row (arch 03 lines 169 to 177), entered, with its handler step (bundle any-time table). */
export function anytimeRow(
  choiceId: string,
  row: NonNullable<Choice["anytimeRow"]>,
  handler: string,
  target: Choice["target"],
  stakesFrom: Stakes = [],
): Choice {
  return { ...choiceBase(choiceId, handler, row, target, stakesFrom), kind: "anytime", anytimeRow: row };
}

/** An entry step meaning search adds when nothing fits (K-02 searchEntry; arch 03 line 189), entered. */
export function searchEntry(choiceId: string, step: string, label: string, target: Choice["target"]): Choice {
  return { ...choiceBase(choiceId, step, label, target, []), kind: "searchEntry" };
}

/** A door (arch 03 line 165), entered. */
export function doorOf(
  choiceId: string,
  door: NonNullable<Choice["door"]>,
  step: string,
  target: Choice["target"],
): Choice {
  return { ...choiceBase(choiceId, step, door, target, []), kind: "door", door };
}

/** A typed text of the turn. */
export function typed(eventId: string, words: string, utc = "2026-10-23T14:05:00Z", zone = ZONE): Text {
  return { eventId, kind: "text", words, sentAt: { utc, zone }, attachments: [], poll: null, tapback: null };
}

export interface Ask {
  /** Who sends it, on their handle. */
  readonly who: Someone;
  /** The business the call runs under; default the barbershop. */
  readonly businessId?: string;
  /** The frontier; the part picks `choiceId`. */
  readonly choices: readonly Choice[];
  readonly choiceId: string;
  /** The text's words, which the part quotes whole. */
  readonly words: string;
  /** Another verb than choose or enter: pass_on or hand_off, quoting the words. */
  readonly verb?: "pass_on" | "hand_off";
  /** Who calls; default a turn on the sender's handle. */
  readonly caller?: "turn" | "page" | "agent";
  readonly turnId?: string;
}

let turns = 0;

/** A gateAndCommit request for a turn whose one agreed part picks `ask.choiceId`, both reads agreeing. */
export function requestFor(ask: Ask): GateRequest {
  turns += 1;
  const businessId = ask.businessId ?? BARBERSHOP;
  const turnId = ask.turnId ?? `turn-limit-1-${String(turns)}`;
  const text = typed(`evt-${turnId}`, ask.words);
  const chosen = ask.choices.find((choice) => choice.choiceId === ask.choiceId);
  if (chosen === undefined) throw new Error(`no choice ${ask.choiceId}`);
  const part: DecidePart =
    ask.verb === "pass_on"
      ? { verb: "pass_on", quote: ask.words, words: ask.words }
      : ask.verb === "hand_off"
        ? { verb: "hand_off", quote: ask.words, reason: ask.words, about: "other" }
        : chosen.kind === "option" || chosen.kind === "hub" || chosen.kind === "whichBooking"
          ? {
              verb: "choose",
              quote: ask.words,
              question: chosen.question ?? "",
              choice: chosen.choiceId,
              fields: [],
            }
          : { verb: "enter", quote: ask.words, choice: chosen.choiceId, fields: [] };
  const questions: ContextQuestion[] = ask.choices
    .filter((choice) => choice.kind === "option" && choice.question !== null)
    .map((choice) => ({
      openQuestionId: choice.question ?? "",
      step: choice.step,
      target: copy(choice.target),
      sentAt: { utc: "2026-10-23T14:00:00Z", zone: ZONE },
      pollId: null,
      askCount: 1,
    }))
    .filter(
      (question, index, all) =>
        all.findIndex((each) => each.openQuestionId === question.openQuestionId) === index,
    );
  const [first, ...more] = ask.choices.map((choice) => copy(choice));
  if (first === undefined) throw new Error("a frontier has a choice");
  const high = ask.choices.some((choice) => choice.stakes === "high");
  const traceId = `trace-${turnId}`;
  const decided: Decided = {
    context: {
      turnId,
      bundleId: { ...BUNDLE },
      flow: "A",
      texts: [text],
      writer: {
        handle: ask.who.address,
        // K-02 names at least one person; for a caller acting for no one, a new nameless person (K-09 openRequest).
        people: [
          {
            personId: ask.who.personId ?? "person-new-nameless",
            name: ask.who.name,
            roles: [],
            language: "en",
          },
        ],
      },
      businessLanguage: "en",
      openQuestions: questions,
      choices: [first, ...more],
      cards: [],
      facts: [],
      alwaysOn: {
        flow: "A",
        prefixSha256: "18d7f9c761c1f58436d2e3e9148b64386221b1d0affa33a8c7b0226c06b6ebea",
      },
      recentMessages: [],
      meaningSearch: null,
    },
    decide: {
      turnId,
      bundleId: { ...BUNDLE },
      stakes: high ? "high" : "low",
      routing: high ? { first: "sonnet", second: "haiku" } : { first: "haiku", second: "haiku" },
      reads: [
        { model: high ? "sonnet" : "haiku", role: "first", output: { language: "en", parts: [copy(part)] } },
        { model: "haiku", role: "check", output: { language: "en", parts: [copy(part)] } },
      ],
      agreed: true,
      reread: false,
      language: "en",
      parts: [{ part: copy(part), outcome: "go" }],
    },
  };
  const callerKind = ask.caller ?? "turn";
  return {
    caller: {
      kind: callerKind,
      turnId: callerKind === "turn" ? turnId : null,
      requestId: turnId,
      businessId,
      personId: ask.who.personId,
      traceId,
    },
    turn:
      callerKind === "turn"
        ? {
            id: turnId,
            handleId: ask.who.handleId,
            eventIds: [text.eventId],
            bundleId: { ...BUNDLE },
            traceId,
            joinedTraceIds: [],
            tries: 1,
          }
        : null,
    input: { kind: "decided", decided, planner: null },
    core: [],
    now: text.sentAt.utc,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The master's choices the tests pick

const barbershop = (bookingId: string | null): Choice["target"] => targetOf(BARBERSHOP, bookingId);
const homeServices = (bookingId: string | null): Choice["target"] => targetOf(HOME_SERVICES, bookingId);

/** A7-11: a STOP, the any-time row stop (handler A7-11, flag stopped). */
export function stopRow(bookingId: string | null = HAIRCUT): Choice {
  return anytimeRow("c-stop", "stop", "A7-11", barbershop(bookingId));
}

/** A3-48: the threat row (flag paused): "visits with that person or at their place pause until Sam decides". */
export function pauseRow(bookingId: string | null = HAIRCUT): Choice {
  return anytimeRow("c-pause", "threat", "A3-48", barbershop(bookingId));
}

/** A7-81: the death row (flag deceased): reminders and sales texts about that person stop for that booking. */
export function deathRow(bookingId: string | null = HAIRCUT): Choice {
  return anytimeRow("c-death", "death", "A7-81", barbershop(bookingId));
}

/** A3-50: the private booking that makes contact stricter, as an option of its question. */
export function privateBooking(bookingId: string = HAIRCUT): Choice {
  return option("c-private", "oq-a3-50", "A3-50", "1 Keep it private", barbershop(bookingId));
}

/** The booked hub (A7-02)'s case that adds a payer: someone else pays for the rest (A4-55; S13-31). */
export function addPayer(bookingId: string): Choice {
  return hubCase("c-payer", "A7-02", "booked", "Someone else pays", barbershop(bookingId), [
    { why: "money", step: "A4-55", ref: "pay.payer" },
  ]);
}

/** The booked hub (A7-02)'s case that moves the visit to another time (its calendar entry moves). */
export function moveVisit(bookingId: string): Choice {
  return hubCase("c-move", "A7-02", "booked", "Move it", barbershop(bookingId), [
    { why: "calendarWrite", step: "A7-06", ref: null },
  ]);
}

/** A4-24's "Someone else pays" for a booking still being made. */
export function someoneElsePays(bookingId: string): Choice {
  return option("c-a4-24-payer", "oq-a4-24", "A4-24", "Someone else pays", barbershop(bookingId), [
    { why: "money", step: "A4-55", ref: "pay.payer" },
  ]);
}

/** A4-14's times card for a booking still being made: one time. */
export function pickTime(bookingId: string | null): Choice {
  return option("c-time", "oq-a4-14", "A4-14", "Sat Oct 24, 2:00pm", barbershop(bookingId));
}

/** A7-17's "2 Another time" on a booking (K-09 commit-limit-2-owner-rule.json's choice). */
export function anotherTime(bookingId: string): Choice {
  return option("c-another-time", "oq-a7-17", "A7-17", "2 Another time", barbershop(bookingId));
}

/** S2-22 at Lee Home Services: let the team take bookings (adds authority). */
export function letThemTakeBookings(): Choice {
  return option("c-s2-22", "oq-s2-22", "S2-22", "1 Yes, all of them", homeServices(null));
}

/** S11-42, the team hub at Lee Home Services: someone joins (adds a person). */
export function someoneJoins(): Choice {
  return hubCase("c-joins", "S11-42", "team", "Someone joins", homeServices(null));
}

/** S11-53, the settings hub at Lee Home Services: the booking rules (hours, notice, free-cancel times). */
export function bookingRules(): Choice {
  return hubCase("c-rules", "S11-53", "settings", "The booking rules", homeServices(null));
}

/** S11-22's fee question at Lee Home Services: charge the late-cancel fee (money). */
export function chargeTheFee(bookingId: string | null = null): Choice {
  return option("c-fee", "oq-s11-22", "S11-22", "1 Charge it", homeServices(bookingId), [
    { why: "charge", step: "S11-22", ref: "pay.late" },
  ]);
}

/** The owner hub (S11-12) at Lee Home Services: a refund beyond the terms. */
export function refundBeyondTerms(): Choice {
  return hubCase("c-refund", "S11-12", "owner", "Refund", homeServices(null), [
    { why: "refund", step: "A10-09", ref: "pay.back" },
  ]);
}

/** S11-61 at Lee Home Services: export the customer list ("Only the account owner exports. Admins never do."). */
export function exportList(): Choice {
  return option("c-export", "oq-s11-61", "S11-61", "Export the list", homeServices(null));
}

/** A7-66's read-back put to the business: call off Alex's visit, everything back. */
export function callOff(bookingId: string = HAIRCUT): Choice {
  return option("c-call-off", "oq-a7-66", "A7-66", "1 Yes, call it off", barbershop(bookingId), [
    { why: "refund", step: "A7-66", ref: null },
  ]);
}

/** The contact-change row (handler A7-98): updates go to a new phone or email, which adds a way in (D75). */
export function contactChange(): Choice {
  return anytimeRow("c-contact", "contact-change", "A7-98", barbershop(null));
}

/** The door for a new booking (A3-51). */
export function newBookingDoor(): Choice {
  return doorOf("c-new", "newBooking", "A3-51", barbershop(null));
}

/** The danger row, which only the safety read sets (A3-22). */
export function dangerRow(): Choice {
  return anytimeRow("c-danger", "danger-or-crisis", "A3-22", barbershop(HAIRCUT));
}

// The round 2 scenarios (DL-183)

/** S12-24's question to the owner (san→owner msg), about no booking: "Reply 1 Keep asking me, 2 Block it, 3 Let it book." */
export function s12Options(businessId: string = BARBERSHOP): Choice[] {
  return ["1 Keep asking me", "2 Block it", "3 Let it book"].map((label, index) =>
    option(`c-s12-24-${String(index + 1)}`, "oq-s12-24", "S12-24", label, targetOf(businessId, null)),
  );
}

/** S12-24's "3 Let it book": the owner lets a number that booked under several names book as usual. */
export function letItBook(businessId: string = BARBERSHOP): Choice {
  return option("c-s12-24-3", "oq-s12-24", "S12-24", "3 Let it book", targetOf(businessId, null));
}

/** S12-23 "A booking or a payment looks wrong" as the entry meaning search adds, about no booking. */
export function s12Entry(): Choice {
  return searchEntry("c-s12-23", "S12-23", "A booking or a payment looks wrong", barbershop(null));
}

/** closest-entries.json's entry: A3-51's "Asks for a person", about no booking. */
export function askForAPerson(): Choice {
  return searchEntry("c-a3-51", "A3-51", "Asks for a person", barbershop(null));
}

/** A7-98 "Sends updates to a new phone or email" (the contact-change row's handler) as an entry, about no booking. */
export function newContactEntry(): Choice {
  return searchEntry("c-a7-98", "A7-98", "Sends updates to a new phone or email", barbershop(null));
}

/** A3-30's read-back to the owner (san→owner msg) of a booking the business adds: "3 Change it", about no booking. */
export function changeTheReadBack(): Choice {
  return option("c-a3-30", "oq-a3-30", "A3-30", "3 Change it", barbershop(null));
}

/** A4-82's reach card (agent→cust chat): how to reach the customer (gives reach_by). */
export function reachBy(label = "Texts only", bookingId: string | null = null): Choice {
  return option("c-a4-82", "oq-a4-82", "A4-82", label, barbershop(bookingId));
}

/** A4-24's "Another adult": the booking is for another adult, a person added to it. */
export function anotherAdult(bookingId: string, businessId: string = BARBERSHOP): Choice {
  return option("c-a4-24-adult", "oq-a4-24", "A4-24", "Another adult", targetOf(businessId, bookingId));
}

/** A4-24's "An adult the booker acts for": authority added to the booking. */
export function actsFor(bookingId: string): Choice {
  return option("c-a4-24-acts", "oq-a4-24", "A4-24", "An adult the booker acts for", barbershop(bookingId));
}

/** A7-17's "1 The stand-in instead": no stake of its own. */
export function standIn(bookingId: string): Choice {
  return option("c-stand-in", "oq-a7-17", "A7-17", "1 The stand-in instead", barbershop(bookingId));
}

/** S11-25's question to the owner after a late cancel: "1 Charge or keep it" (a fee: S11-26 takes it). */
export function lateFee(bookingId: string): Choice {
  return option("c-late-fee", "oq-s11-25", "S11-25", "1 Charge or keep it", barbershop(bookingId), [
    { why: "charge", step: "S11-26", ref: "pay.late" },
  ]);
}

/** A7-17's "3 Cancel, no fee" when the frontier builder could not walk it (stake unknown). */
export function unwalked(bookingId: string): Choice {
  return option("c-unwalked", "oq-a7-17", "A7-17", "3 Cancel, no fee", barbershop(bookingId), [
    { why: "unknown", step: null, ref: null },
  ]);
}

// The round 3 scenarios (DL-188)

/** A10-09 "Asks Sam about a refund" (san→owner msg): "1 Refund it", whose branch refunds (A10-10 "Refunds it; tells Alex"). */
export function refundIt(bookingId: string, businessId: string = BARBERSHOP): Choice {
  return option("c-a10-09-1", "oq-a10-09", "A10-09", "1 Refund it", targetOf(businessId, bookingId), [
    { why: "refund", step: "A10-10", ref: "pay.back" },
  ]);
}

/** The booked hub (A7-02)'s case "The business can't give it" (to A7-93: A7-15 asks Sam, A7-66 the business cancels). */
export function businessCantGiveIt(bookingId: string): Choice {
  return hubCase("c-cant-give", "A7-02", "booked", "The business can't give it", barbershop(bookingId));
}

/** The booked hub (A7-02)'s case "Alex changes the plan" (to A7-92: each of its steps a text to Alex). */
export function alexChangesThePlan(bookingId: string): Choice {
  return hubCase("c-changes", "A7-02", "booked", "Alex changes the plan", barbershop(bookingId));
}

/** Journey 4's customer steps about no booking yet (ruling 2), each with one of its branches. */
export const NEW_VISIT_CHOICES: readonly (readonly [string, () => Choice])[] = [
  [
    "A4-01 'Where?' (san, auto): '1 At the shop'",
    () => option("c-a4-01", "oq-a4-01", "A4-01", "1 At the shop", barbershop(null)),
  ],
  [
    "A4-12 'Texts Alex the price' (san→cust msg): 'Picks a time'",
    () => option("c-a4-12", "oq-a4-12", "A4-12", "Picks a time", barbershop(null)),
  ],
  [
    "A4-28 'Anything special?' (san, auto): 'A repeat plan'",
    () => option("c-a4-28", "oq-a4-28", "A4-28", "A repeat plan", barbershop(null)),
  ],
  ["A4-80 'Asks who it's for' (agent→cust chat): 'Fine to go on'", () => whoItsFor(null)],
  [
    "B4-01 'Where?' at Lee Home Services (san, auto): 'Only at the customer's place'",
    () => option("c-b4-01", "oq-b4-01", "B4-01", "Only at the customer's place", homeServices(null)),
  ],
  [
    "B4-92 'Asks who it's for' at Lee Home Services (agent→cust chat): 'Fine to go on'",
    () => option("c-b4-92", "oq-b4-92", "B4-92", "Fine to go on", homeServices(null)),
  ],
];

/** A4-80 "Asks who it's for, and if they're 18 or older" (agent→cust chat): "Fine to go on". */
export function whoItsFor(bookingId: string | null): Choice {
  return option("c-a4-80", "oq-a4-80", "A4-80", "Fine to go on", barbershop(bookingId));
}

/** A4-09 "Sam OKs the price" (san→owner msg), a journey 4 step for the owner: "1 Send it", about no booking yet. */
export function sendThePrice(): Choice {
  return option("c-a4-09", "oq-a4-09", "A4-09", "1 Send it", barbershop(null));
}

/** The one "which booking?" choice for a booking (arch 03 line 167). */
export function whichBooking(bookingId: string = HAIRCUT): Choice {
  return {
    ...choiceBase("c-which", "A7-02", "Which booking?", barbershop(bookingId), []),
    kind: "whichBooking",
    question: bookingId,
  };
}
