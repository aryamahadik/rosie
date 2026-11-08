// Doubles and scenarios for limit 3's tests (T-301). Never imported by the Worker. The doubles stand in for limit 3's
// ports (the open questions' read, T-308's K-04 reader, the page and AI bindings) and for limits 1, 2, 4, 5 and 6
// (T-299, T-300, T-302 to T-304), never for limit 3. Values come only from the contracts' fixtures and the master's
// sample cast: K-04 v1's seeds (Sam, Alex, Riley, Lee's Barbershop, Alex's haircut, A7-03's question and its outbox
// row), K-06 v1's events (Alex's vote, like and edit), K-09 v1's exchanges, and the master's own read-backs (S2-22,
// A7-31, A7-66) word for word; phone numbers in the 555-01xx range (rule 9).

import type * as K06 from "../../../../contracts/generated/inbound-event/inbound-event.v1";
import { createIdentityAccess, type IdentityAccess } from "../../domain/identity-access";
import {
  GIFT_FOR_BROTHER,
  readerOf,
  seedRecord,
  withRows,
  type TestRecord,
} from "../../domain/identity-access/test-support";
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
  scriptedLimits,
  type LimitCall,
  type PartScript,
  type Script,
} from "../framework/test-support";
import type { AskedQuestion, BoundYes, QuestionReader, RowRef, SentOption, YesBindings } from "./facts";
import { createLimit3, type ExactYesLimit } from "./index";

export type Text = Context["texts"][number];
export type ContextQuestion = Context["openQuestions"][number];
export type StepCard = Context["cards"][number];

/** The zone the barbershop's texts resolve in (K-04 seeds; the fixtures' texts). */
export const ZONE = "America/New_York";

// ---------------------------------------------------------------------------------------------------------------
// The doubles

/** The repo a test hands the limit: the doubles never read it. */
export const TEST_REPO = { name: "limit-3-test-repo" } as const;

/** One read of the open questions' double: which question, from which handle. */
export interface QuestionAsked {
  readonly handleId: string;
  readonly openQuestionId: string;
}

/** The open questions' read over rows: a row answers only for the handle it was sent to. */
export function questionsOf(rows: readonly AskedQuestion[], asked: QuestionAsked[] = []): QuestionReader {
  return {
    liveQuestion(handleId, openQuestionId) {
      asked.push({ handleId, openQuestionId });
      const row = rows.find((each) => each.openQuestionId === openQuestionId && each.handleId === handleId);
      return Promise.resolve(row === undefined ? null : copy(row));
    },
  };
}

/** T-308's service over a test record (identity-access test-support), for the call's business. */
export function identityFrom(record: TestRecord): (repo: unknown, businessId: string) => IdentityAccess {
  return (_repo, businessId) => createIdentityAccess({ businessId, reader: readerOf(record) });
}

/** Page and AI bindings by open question id; none for any other. */
export function bindingsOf(bound: Readonly<Partial<Record<string, BoundYes>>>): YesBindings {
  return {
    boundYes: (_request, openQuestionId) => Promise.resolve(bound[openQuestionId] ?? null),
  };
}

export interface World {
  /** The open questions live on their handles. */
  readonly rows: readonly AskedQuestion[];
  /** The K-04 record T-308 reads; default the frozen seeds. */
  readonly record?: TestRecord;
  /** What page or AI yeses are bound to; default nothing. */
  readonly bound?: Readonly<Partial<Record<string, BoundYes>>>;
}

/** Limit 3 itself, over doubles of its ports. */
export function limitIn(world: World, asked: QuestionAsked[] = []): ExactYesLimit {
  return createLimit3({
    questions: () => questionsOf(world.rows, asked),
    identity: identityFrom(world.record ?? seedRecord()),
    bindings: bindingsOf(world.bound ?? {}),
  });
}

/** The gate turn one request gives a limit (as runGate makes it), in the request's business scope. */
export function turnOf(request: GateRequest): GateTurn {
  const { input, caller } = request;
  if (input.kind !== "decided") throw new Error("limit 3's tests gate decided texts");
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
  if (input.kind !== "decided") throw new Error("limit 3's tests gate decided texts");
  const entry = input.decided.decide.parts[index];
  if (entry === undefined || !isGated(entry.part)) throw new Error(`no gated part ${String(index)}`);
  const { part } = entry;
  const choiceId = part.verb === "choose" || part.verb === "enter" ? part.choice : null;
  const choice = input.decided.context.choices.find((each) => each.choiceId === choiceId) ?? null;
  return { index, part, choice };
}

/** Limits 1, 2, 4, 5 and 6 as the gate framework's scripted doubles, with `limit` in slot 3 (each call written down). */
export function registryWith(
  limit: ExactYesLimit,
  script: Script = {},
  calls: LimitCall[] = [],
): LimitRegistry {
  const [one, two, , four, five, six] = scriptedLimits(script, calls);
  const three: Limit<3> = {
    limit: 3,
    check(part, turn) {
      calls.push({ limit: 3, part: part.index });
      return limit.check(part, turn);
    },
  };
  return [one, two, three, four, five, six];
}

/** A K-09 gate fixture's script without limit 3's verdict: the real limit 3 gives its own. */
export function withoutLimit3(script: Script): Script {
  const out: Record<number, PartScript> = {};
  for (const [part, verdicts] of Object.entries(script)) {
    if (verdicts === undefined) continue;
    const rest: PartScript = { ...verdicts };
    Reflect.deleteProperty(rest, 3);
    out[Number(part)] = rest;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// K-09 v1's exchanges and K-06 v1's events

/** A K-09 gate exchange's request, freshly parsed. */
export function exchangeRequest(file: string): GateRequest {
  return copy(gateExchange(file).request);
}

/** The decided pair a request carries. */
export function decidedIn(request: GateRequest): Decided {
  if (request.input.kind !== "decided") throw new Error("not decided texts");
  return request.input.decided;
}

/** The options a context offers for one of its open questions, as they went out: each choice's id and its words. */
export function optionsIn(context: Context, openQuestionId: string): SentOption[] {
  return context.choices
    .filter((choice) => choice.kind === "option" && choice.question === openQuestionId)
    .map((choice) => ({ id: choice.choiceId, label: choice.branch ?? choice.label }));
}

export interface RowGiven {
  readonly readback: string | null;
  readonly options?: readonly SentOption[];
  readonly versionsRead?: readonly RowRef[];
  readonly askCount?: number;
}

/**
 * The open question row behind a request's open question, as K-05 v1.2's read gives it: sent to the turn's handle for
 * the person the turn acts for, its target, send time, poll and ask count as the context lists them, its options from
 * the context's choices, and the read-back given.
 */
export function rowFor(request: GateRequest, openQuestionId: string, given: RowGiven): AskedQuestion {
  const { context } = decidedIn(request);
  const question = context.openQuestions.find((each) => each.openQuestionId === openQuestionId);
  if (question === undefined) throw new Error(`the context lists no ${openQuestionId}`);
  if (request.turn === null) throw new Error("a turn's request names its handle");
  return {
    openQuestionId,
    handleId: request.turn.handleId,
    personId: request.caller.personId,
    businessId: question.target.businessId,
    bookingId: question.target.bookingId,
    step: question.step,
    options: given.options ?? optionsIn(context, openQuestionId),
    readback: given.readback,
    versionsRead: given.versionsRead ?? [],
    sentAt: question.sentAt.utc,
    pollId: question.pollId,
    askCount: given.askCount ?? question.askCount,
  };
}

/** One of K-06 v1's events (contracts/inbound-event/fixtures), freshly parsed. */
export function inboundEvent(file: string): K06.InboundEvent {
  return contractFile(`inbound-event/fixtures/${file}`) as K06.InboundEvent;
}

/**
 * K-02's text for a K-06 event, as the turn loop reads it (T-251, runtime/src/turn turnTextOf): a text or an edit's new
 * words is a text at its own send time; a vote is a pollVote carrying its option's words; a reaction is a tapback named
 * by its reaction.
 */
export function textOf(event: K06.InboundEvent, zone = ZONE): Text {
  if (event.sentAt === null) throw new Error("a receipt is no text");
  const base = { eventId: event.eventId, sentAt: { utc: event.sentAt, zone }, attachments: [] };
  switch (event.kind) {
    case "text":
    case "edit":
      return { ...base, kind: "text", words: event.body ?? "", poll: null, tapback: null };
    case "pollVote":
      if (event.poll === null) throw new Error("a vote names its poll");
      return {
        ...base,
        kind: "pollVote",
        words: event.poll.optionWords,
        poll: { pollId: event.poll.pollId, optionId: event.poll.optionId },
        tapback: null,
      };
    case "reaction":
      if (event.reaction === null) throw new Error("a reaction names its message");
      return {
        ...base,
        kind: "tapback",
        words: event.reaction.reaction,
        poll: null,
        tapback: { reaction: event.reaction.reaction, onMessageId: event.reaction.onMessageId },
      };
    default:
      throw new Error(`K-02 has no text for a ${event.kind}`);
  }
}

/** A typed text of the turn. */
export function typed(eventId: string, words: string, utc: string, zone = ZONE): Text {
  return { eventId, kind: "text", words, sentAt: { utc, zone }, attachments: [], poll: null, tapback: null };
}

// ---------------------------------------------------------------------------------------------------------------
// The people and the master's read-backs

export interface Someone {
  readonly personId: string;
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
export const ALEX: Someone = {
  personId: "person-alex",
  handleId: "handle-alex",
  address: "+15555550101",
  name: "Alex M.",
};
export const RILEY: Someone = {
  personId: "person-riley",
  handleId: "handle-riley",
  address: "+15555550102",
  name: "Riley",
};
/** Someone else who writes from Alex's phone (one handle can be several people: arch 01 line 55). */
export const ALEX_PARTNER: Someone = { ...ALEX, personId: "person-alex-partner", name: "Jamie" };

export const BARBERSHOP = "biz-lees-barbershop";
const BARBERSHOP_NAME = "Lee's Barbershop";
/** K-04 seed-booking-head: Alex books his haircut, is the person served and pays (version 7). */
export const HAIRCUT = "booking-alex-haircut";
/** A4-26 (T-308's GIFT_FOR_BROTHER): Alex books and pays; his brother is the person served. */
export const GIFT = GIFT_FOR_BROTHER.id;

/** The seeds T-308 reads, with A4-26's gift and someone else on Alex's phone. */
export function barbershopRecord(): TestRecord {
  return withRows(seedRecord(), {
    personHandles: [{ personId: ALEX_PARTNER.personId, handleId: ALEX.handleId }],
    bookings: [GIFT_FOR_BROTHER],
  });
}

/** S2-22's read-back to Sam, word for word (MASTER-FLOW-A line 1441): who takes bookings, and the question. */
export const TEAM_READ_BACK =
  "Everyone's set up. Each person is who you say: you confirm it. Let them take bookings now? / Ready to take bookings / Jordan: plumbing and electrical / Casey: plumbing / Riley: barber, color and house calls / Avery: barber / Reply 1 Yes, all of them, 2 Not yet.";
/** S2-22's options as that read-back typed them. */
export const TEAM_OPTIONS: readonly SentOption[] = [
  { id: "c-01", label: "Yes, all of them" },
  { id: "c-02", label: "Not yet" },
];

/** A7-31's read-back to Alex, word for word (MASTER-FLOW-A line 3498): a higher amount needs his own yes. */
export const BEARD_TRIM_READ_BACK =
  "Riley has time for it. Add a beard trim to your Sat 11:00am visit? / Beard trim · $20 / Added to Sat Oct 24 · 11:00am · Riley / Paid with the rest of your visit / Reply 1 Add it, 2 No thanks.";
/** The same read-back given again with today's price: other words, built from the booking's next version. */
export const BEARD_TRIM_READ_BACK_TODAY =
  "Riley has time for it. Add a beard trim to your Sat 11:00am visit? / Beard trim · $25 / Added to Sat Oct 24 · 11:00am · Riley / Paid with the rest of your visit / Reply 1 Add it, 2 No thanks.";

/** A7-66's read-back to Sam, word for word (MASTER-FLOW-A line 3728): calling off Alex's visit gives everything back. */
export const CALL_OFF_READ_BACK =
  "Call off Alex M.'s Sat 11:00am? There's no fee. They get it all back. / Reply 1 Yes, call it off, 2 Keep it.";

// ---------------------------------------------------------------------------------------------------------------
// Building a turn that answers one question

const BUNDLE = { hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037", build: 1 };
/** Sat Oct 24, 11:00am in the barbershop's zone: Alex's haircut. */
const VISIT = { utc: "2026-10-24T15:00:00Z", zone: ZONE };

/** What a choice acts on: a booking of the barbershop, or none. */
export function barbershopTarget(bookingId: string | null): Choice["target"] {
  return {
    businessId: BARBERSHOP,
    businessName: BARBERSHOP_NAME,
    bookingId,
    visitAt: bookingId === null ? null : VISIT,
  };
}

/** An option of an open question as the frontier offers it. */
export function option(
  choiceId: string,
  question: string,
  step: string,
  branch: string,
  definition: string,
  target: Choice["target"],
  stakesFrom: Choice["stakesFrom"] = [],
): Choice {
  return {
    choiceId,
    kind: "option",
    label: branch,
    definition,
    step,
    question,
    branch,
    anytimeRow: null,
    door: null,
    hub: null,
    target,
    fields: [],
    stakes: stakesFrom.length > 0 ? "high" : "low",
    stakesFrom,
  };
}

export interface Answer {
  /** The person the turn acts for, on their handle. */
  readonly who: Someone;
  /** Their live roles at the barbershop, as the context lists them. */
  readonly role: "owner" | "staff" | "customer";
  readonly question: ContextQuestion;
  readonly choices: readonly Choice[];
  readonly card: StepCard;
  readonly texts: readonly Text[];
  /** The part decide agreed: `verb` of `choiceId`, quoting `quote`. */
  readonly choiceId: string;
  readonly quote: string;
  readonly turnId: string;
}

/** A gateAndCommit request for a turn whose one agreed part answers `answer.question`, both reads agreeing. */
export function requestFor(answer: Answer): GateRequest {
  const [first, ...more] = answer.texts;
  if (first === undefined) throw new Error("a turn has a text");
  const texts: [Text, ...Text[]] = [copy(first), ...more.map((text) => copy(text))];
  const last = texts[texts.length - 1] ?? first;
  const chosen = answer.choices.find((choice) => choice.choiceId === answer.choiceId);
  if (chosen === undefined) throw new Error(`no choice ${answer.choiceId}`);
  const part: DecidePart =
    chosen.kind === "option"
      ? {
          verb: "choose",
          quote: answer.quote,
          question: chosen.question ?? "",
          choice: chosen.choiceId,
          fields: [],
        }
      : { verb: "enter", quote: answer.quote, choice: chosen.choiceId, fields: [] };
  const high = answer.choices.some((choice) => choice.stakes === "high");
  const traceId = `trace-${answer.turnId}`;
  const [firstChoice, ...moreChoices] = answer.choices;
  if (firstChoice === undefined) throw new Error("a frontier has a choice");
  const decided: Decided = {
    context: {
      turnId: answer.turnId,
      bundleId: { ...BUNDLE },
      flow: "A",
      texts,
      writer: {
        handle: answer.who.address,
        people: [
          {
            personId: answer.who.personId,
            name: answer.who.name,
            roles: [{ role: answer.role, businessId: BARBERSHOP }],
            language: "en",
          },
        ],
      },
      businessLanguage: "en",
      openQuestions: [copy(answer.question)],
      choices: [copy(firstChoice), ...moreChoices.map((choice) => copy(choice))],
      cards: [copy(answer.card)],
      facts: [],
      alwaysOn: {
        flow: "A",
        prefixSha256: "18d7f9c761c1f58436d2e3e9148b64386221b1d0affa33a8c7b0226c06b6ebea",
      },
      recentMessages: [],
      meaningSearch: null,
    },
    decide: {
      turnId: answer.turnId,
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
  return {
    caller: {
      kind: "turn",
      turnId: answer.turnId,
      requestId: answer.turnId,
      businessId: BARBERSHOP,
      personId: answer.who.personId,
      traceId,
    },
    turn: {
      id: answer.turnId,
      handleId: answer.who.handleId,
      eventIds: [first.eventId, ...more.map((text) => text.eventId)],
      bundleId: { ...BUNDLE },
      traceId,
      joinedTraceIds: [],
      tries: 1,
    },
    input: { kind: "decided", decided, planner: null },
    core: [],
    now: last.sentAt.utc,
  };
}

/** The same request made by a secure page or an outside AI for `personId` (no turn: arch 02 line 129; K-09 caller). */
export function offChat(request: GateRequest, kind: "page" | "agent", personId: string | null): GateRequest {
  const call = copy(request);
  return {
    ...call,
    caller: {
      ...call.caller,
      kind,
      turnId: null,
      requestId: `req-${kind}-${call.caller.requestId}`,
      personId,
    },
    turn: null,
  };
}

// ---- A7-31: Alex adds a beard trim to his haircut, a higher amount (MASTER-FLOW-A lines 3477 to 3500) ---------------

export const BEARD_TRIM_QUESTION = "oq-a7-31-alex";
/** The read-back went out at 14:04 on Fri Oct 23. */
export const BEARD_TRIM_SENT = "2026-10-23T14:04:00Z";
/** It was built from Alex's haircut at version 7 (K-04 seed-booking-head). */
export const BEARD_TRIM_VERSIONS: readonly RowRef[] = [{ table: "bookings", rowId: HAIRCUT, version: 7 }];
export const BEARD_TRIM_OPTIONS: readonly SentOption[] = [
  { id: "A7-31/1", label: "Add it" },
  { id: "A7-31/2", label: "No thanks" },
];

/** A7-31's card (K-02 v1 stepCard): Means 1 and 2, its Never line and its safe default, word for word. */
export const BEARD_TRIM_CARD: StepCard = {
  step: "A7-31",
  card: {
    question: "Add a beard trim to your Sat 11:00am visit?",
    means: [
      { branch: "1 Add it", text: "a clear yes to the price shown.", from: "meansLine" },
      { branch: "2 No thanks", text: "no thanks.", from: "meansLine" },
    ],
    never: ["Never: move or add on a maybe. Read a new address back first."],
    safeDefault: "nothing is added or moved.",
    clock: { from: "step9Default" },
  },
};

/** A7-31's two options on `bookingId`: adding the trim charges with the rest of the visit (a money part). */
export function beardTrimChoices(question = BEARD_TRIM_QUESTION, bookingId: string = HAIRCUT): Choice[] {
  const target = barbershopTarget(bookingId);
  return [
    option("A7-31/1", question, "A7-31", "1 Add it", "a clear yes to the price shown.", target, [
      { why: "charge", step: "A7-31", ref: null },
    ]),
    option("A7-31/2", question, "A7-31", "2 No thanks", "no thanks.", target, [
      { why: "question", step: null, ref: "A7-31/1" },
    ]),
  ];
}

export interface BeardTrim {
  readonly texts: readonly Text[];
  readonly quote: string;
  /** Default "A7-31/1", Add it. */
  readonly choiceId?: string;
  /** Default Alex, a customer of the barbershop. */
  readonly who?: Someone;
  readonly role?: "owner" | "staff" | "customer";
  readonly question?: string;
  readonly sentAt?: string;
  readonly pollId?: string | null;
  readonly askCount?: number;
  readonly bookingId?: string;
}

/** Alex's turn answering A7-31's read-back. */
export function beardTrimRequest(given: BeardTrim): GateRequest {
  const question = given.question ?? BEARD_TRIM_QUESTION;
  const bookingId = given.bookingId ?? HAIRCUT;
  const who = given.who ?? ALEX;
  return requestFor({
    who,
    role: given.role ?? "customer",
    question: {
      openQuestionId: question,
      step: "A7-31",
      target: barbershopTarget(bookingId),
      sentAt: { utc: given.sentAt ?? BEARD_TRIM_SENT, zone: ZONE },
      pollId: given.pollId ?? null,
      askCount: given.askCount ?? 1,
    },
    choices: beardTrimChoices(question, bookingId),
    card: BEARD_TRIM_CARD,
    texts: given.texts,
    choiceId: given.choiceId ?? "A7-31/1",
    quote: given.quote,
    turnId: `turn-${who.personId}-a7-31-${given.texts.map((text) => text.eventId).join("-")}`,
  });
}

export interface BeardTrimRow {
  readonly question?: string;
  readonly readback?: string | null;
  readonly versionsRead?: readonly RowRef[];
  readonly sentAt?: string | null;
  readonly pollId?: string | null;
  readonly askCount?: number;
  readonly bookingId?: string | null;
  readonly personId?: string | null;
  readonly handleId?: string;
}

/** A7-31's open question to Alex as K-04 holds it: the read-back's words and versions, sent to his phone at 14:04. */
export function beardTrimRow(given: BeardTrimRow = {}): AskedQuestion {
  return {
    openQuestionId: given.question ?? BEARD_TRIM_QUESTION,
    handleId: given.handleId ?? ALEX.handleId,
    personId: given.personId === undefined ? ALEX.personId : given.personId,
    businessId: BARBERSHOP,
    bookingId: given.bookingId === undefined ? HAIRCUT : given.bookingId,
    step: "A7-31",
    options: BEARD_TRIM_OPTIONS,
    readback: given.readback === undefined ? BEARD_TRIM_READ_BACK : given.readback,
    versionsRead: given.versionsRead ?? BEARD_TRIM_VERSIONS,
    sentAt: given.sentAt === undefined ? BEARD_TRIM_SENT : given.sentAt,
    pollId: given.pollId ?? null,
    askCount: given.askCount ?? 1,
  };
}

// ---- A7-03: Alex picks a new time, K-04's seed question and outbox row with K-06's events -------------------------

interface SeedRows {
  readonly rows: readonly { readonly table: string; readonly values: Readonly<Record<string, unknown>> }[];
}

function seedValues(file: string, table: string): Readonly<Record<string, unknown>>[] {
  const seed = contractFile(`db-schema/core/fixtures/${file}`) as SeedRows;
  return seed.rows.filter((row) => row.table === table).map((row) => row.values);
}

function text(values: Readonly<Record<string, unknown>>, column: string): string {
  const value = values[column];
  if (typeof value !== "string") throw new Error(`seed column ${column} is not text`);
  return value;
}

/**
 * K-04 seed-open-question.json's A7-03 question to Alex (no read-back: a pick of a new time), read as K-05 v1.2 reads it
 * with seed-outbox-row.json's parts to his phone: it went out when its last part was sent (the poll, 14:05:05) as the
 * poll linq-msg-demo-0002, whose options K-06's poll-vote.json votes in.
 */
export function moveTimesRow(): AskedQuestion {
  const [question] = seedValues("seed-open-question.json", "open_questions");
  if (question === undefined) throw new Error("seed-open-question.json holds A7-03's question");
  const parts = seedValues("seed-outbox-row.json", "outbox_parts");
  const went = parts.map((part) => text(part, "sent_at")).sort((a, b) => Date.parse(a) - Date.parse(b));
  const poll = parts.find((part) => part.kind === "poll");
  const options = (question.options as readonly { id: string; label: string }[]).map((each) => ({ ...each }));
  return {
    openQuestionId: text(question, "id"),
    handleId: text(question, "handle_id"),
    personId: text(question, "person_id"),
    businessId: text(question, "business_id"),
    bookingId: text(question, "booking_id"),
    step: text(question, "step"),
    options,
    readback: question.readback === null ? null : text(question, "readback"),
    versionsRead: (question.versions_read as readonly RowRef[]).map((row) => ({ ...row })),
    sentAt: went.at(-1) ?? null,
    pollId: poll === undefined ? null : text(poll, "linq_message_id"),
    askCount: question.ask_count as number,
  };
}

/** A7-03's options as the frontier offers them: the seed's option ids, a time each (A7-03, MASTER-FLOW-A line 3391). */
export function moveTimesChoices(row: AskedQuestion): Choice[] {
  return row.options.map((each) =>
    option(
      each.id,
      row.openQuestionId,
      "A7-03",
      each.label,
      "That time with Riley.",
      barbershopTarget(HAIRCUT),
      [{ why: "moveRow", step: null, ref: null }],
    ),
  );
}

/** A7-03's card (K-02 v1 stepCard): a pick of a shown time; its safe default word for word. */
export const MOVE_TIMES_CARD: StepCard = {
  step: "A7-03",
  card: {
    question: "Which time works?",
    means: [],
    never: [],
    safeDefault: "the time stays as booked.",
    clock: {
      from: "clockLine",
      text: "the customer picks within 24 hours; silence keeps the time as booked.",
    },
  },
};

/** Alex's turn answering A7-03's question with `texts`, decide choosing `choiceId` by `quote`. */
export function moveTimesRequest(texts: readonly Text[], choiceId: string, quote: string): GateRequest {
  const row = moveTimesRow();
  return requestFor({
    who: ALEX,
    role: "customer",
    question: {
      openQuestionId: row.openQuestionId,
      step: row.step,
      target: barbershopTarget(HAIRCUT),
      sentAt: { utc: row.sentAt ?? "", zone: ZONE },
      pollId: row.pollId,
      askCount: row.askCount,
    },
    choices: moveTimesChoices(row),
    card: MOVE_TIMES_CARD,
    texts,
    choiceId,
    quote,
    turnId: `turn-alex-a7-03-${texts.map((each) => each.eventId).join("-")}`,
  });
}

// ---- A7-66: Sam calls off Alex's visit, read back first; money goes back (MASTER-FLOW-A lines 3714 to 3732) --------

export const CALL_OFF_QUESTION = "oq-a7-66-sam";
export const CALL_OFF_SENT = "2026-10-23T19:00:00Z";

export const CALL_OFF_CARD: StepCard = {
  step: "A7-66",
  card: {
    question: "Call off Alex M.'s Sat 11:00am?",
    means: [],
    never: [],
    safeDefault: "nothing is called off.",
    clock: { from: "step9Default" },
  },
};

/** The read-back's two options: calling it off refunds everything Alex paid (a money part for the business). */
export function callOffChoices(): Choice[] {
  const target = barbershopTarget(HAIRCUT);
  return [
    option("A7-66/1", CALL_OFF_QUESTION, "A7-66", "1 Yes, call it off", "the visit is called off.", target, [
      { why: "refund", step: "A7-66", ref: null },
      { why: "cancelRow", step: null, ref: null },
    ]),
    option("A7-66/2", CALL_OFF_QUESTION, "A7-66", "2 Keep it", "nothing is called off.", target, [
      { why: "question", step: null, ref: "A7-66/1" },
    ]),
  ];
}

/** `who`'s turn answering A7-66's read-back sent to their own phone. */
export function callOffRequest(who: Someone, role: "owner" | "staff", words: string): GateRequest {
  return requestFor({
    who,
    role,
    question: {
      openQuestionId: CALL_OFF_QUESTION,
      step: "A7-66",
      target: barbershopTarget(HAIRCUT),
      sentAt: { utc: CALL_OFF_SENT, zone: ZONE },
      pollId: null,
      askCount: 1,
    },
    choices: callOffChoices(),
    card: CALL_OFF_CARD,
    texts: [typed(`evt-${who.personId}-call-off`, words, "2026-10-23T19:01:00Z")],
    choiceId: "A7-66/1",
    quote: words,
    turnId: `turn-${who.personId}-a7-66`,
  });
}

/** A7-66's open question as K-04 holds it, sent to `who`'s own phone. */
export function callOffRow(who: Someone): AskedQuestion {
  return {
    openQuestionId: CALL_OFF_QUESTION,
    handleId: who.handleId,
    personId: who.personId,
    businessId: BARBERSHOP,
    bookingId: HAIRCUT,
    step: "A7-66",
    options: [
      { id: "A7-66/1", label: "Yes, call it off" },
      { id: "A7-66/2", label: "Keep it" },
    ],
    readback: CALL_OFF_READ_BACK,
    versionsRead: [{ table: "bookings", rowId: HAIRCUT, version: 7 }],
    sentAt: CALL_OFF_SENT,
    pollId: null,
    askCount: 1,
  };
}
