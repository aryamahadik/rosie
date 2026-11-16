// Test sources for the stop home, for the tests only.
//
// The record is the frozen contracts' seeds as T-317's doubles read them (K-04 v1 core: people, handles, roles, phones,
// booking heads; K-29 v1: Ben's and Avery's texts yeses and the chat links, Pat's invite never answered), on the runtime
// side or under one business's scope, and written by T-317's fake of K-05's commit. Yeses go through T-307's own yes(),
// and STOP and START through T-317's own planStopOrStart, so the home reads what those services write. The flows are
// fixture set v1's master flows as the merged bundle emitter compiles them (the home registry's emittedFlows). Every
// number is the seeds' own, in the 555-01xx range; every name is the master's cast (rule 9).

import { KEYED_IDS, NO_EVENT_SOURCES, planStopOrStart, type StopOrStartRequest } from "../../domain/flags";
import {
  FLAG_SEEDS,
  applied,
  flagsReaderOn,
  flagsRecordOf,
  messagesReaderOn,
  worldOf,
  type World,
} from "../../domain/flags/test-support";
import {
  createMessagesConsent,
  stateWriteOf,
  type ConsentWrite,
  type YesRequest,
} from "../../domain/messages-consent";
import type { StopHomeReads } from "./reads";

export {
  BARBERSHOP,
  YOGA_STUDIO,
  applied,
  withPhones,
  worldOf,
  type World,
} from "../../domain/flags/test-support";

/** K-04 seed-business-head's third demo shop (Sam owns it; Tomás works there). */
export const MOVERS = "biz-movers";

/** K-29 v1's seed of Ben's STOP (Oct 20): a withdrawn texts row for his mobile with no business, for every business. */
export const BEN_STOP_SEED = "db-schema/conversations-consent/fixtures/seed-consent-stop-row.json";

/** The seeds' mobiles (K-04 seed-person-roles, seed-phone-stopped; K-29 seed-chat-link), in the 555-01xx range. */
export const NUMBERS = {
  sam: "+15555550100",
  alex: "+15555550101",
  ben: "+15555550106",
  pat: "+15555550107",
} as const;

/** RULES 4.1b's ready text for a booking (MC C9): the words a chat link's text shows. */
export const BOOKING_READY_TEXT = "Hey, send me further updates about my booking";

/** S13-32's lines the module rules by, as the bundle compiles them with C1 (compiler/src/corrections/c1.ts). */
export const S13_32_RULES = [
  "A yes to texts: their own number given for this booking, a team join, or a yes on a forwarded link.",
  "Never on someone else's word: not a brother, a parent, a payer, or the person a job is about.",
  "The business's word counts only for someone who gave the business their number for this booking.",
  "The payer gives their own OK to texts on their link. Rosie texts the payer only after that OK.",
  "It stops Rosie's texts to that phone for every business, at once, until START turns them back on. Every business texts from the one Rosie number.",
  "Only START turns Rosie's texts to that phone back on, for every business. A fresh yes on a new booking, sent from that number, turns on that booking's texts only. A booking made any other way sends that phone no text.",
  "Alone, a stop word never cancels, moves or skips a booked visit, and never ends a plan.",
  "It never stops a charge for work already given. Its one reply says how to cancel, by a call.",
  "It also does what it answers in one case only.",
  "Inside a legal cancel period, a stop that replies to the cancel notice counts as the cancel.",
  "So does one that replies to a text about that sold work.",
  "A bare 'Cancel' stops texts and flags the visit. The one text says how to call it off, by a call.",
  "The opt-out line goes only in the very first text Rosie ever sends a number. No other message carries it.",
];

/** The seeds' world: T-317's seeds (T-307's with K-04's booking heads), with Ben's STOP row when asked. */
export function seedWorld(options: { readonly benStop?: boolean } = {}): World {
  return worldOf(flagsRecordOf(options.benStop === true ? [...FLAG_SEEDS, BEN_STOP_SEED] : FLAG_SEEDS));
}

/** The stop home's reads over the world, as T-307's and T-317's doubles answer them under the scope (null: runtime). */
export function readsOn(world: World, scope: string | null): StopHomeReads {
  const messages = messagesReaderOn(world, scope);
  const flags = flagsReaderOn(world, scope);
  return {
    handle: (handleId) => messages.handle(handleId),
    handleIdsOfPerson: (personId) => messages.handleIdsOfPerson(personId),
    phoneOfHandle: (handleId) => messages.phoneOfHandle(handleId),
    consentsOfPersons: (personIds) => messages.consentsOfPersons(personIds),
    personIdsOfHandle: (handleId) => flags.personIdsOfHandle(handleId),
  };
}

/** A yes recorded through T-307's own yes(), at the business, as its commit writes it; the write is returned. */
export async function recordYes(
  world: World,
  businessId: string,
  request: YesRequest,
  options: { readonly commit?: boolean } = {},
): Promise<ConsentWrite> {
  const service = createMessagesConsent({ businessId, reader: messagesReaderOn(world, businessId) });
  const write = await service.yes(request);
  if (options.commit !== false) world.record = applied(world.record, [stateWriteOf(write)]);
  return write;
}

/** A yes to texts by text from the person's own mobile, for a booking, in their own turn (T-307 YesRequest). */
export function textYes(input: {
  readonly id: string;
  readonly personId: string;
  readonly handleId: string;
  readonly bookingId: string | null;
  readonly turnId: string;
  readonly at: string;
  readonly fromHandleId?: string;
  readonly chatLinkId?: string | null;
}): YesRequest {
  return {
    id: input.id,
    personId: input.personId,
    kind: "texts",
    readBack: { words: BOOKING_READY_TEXT, turnId: input.turnId },
    at: input.at,
    channel: "text",
    handleId: input.handleId,
    bookingId: input.bookingId,
    chatLinkId: input.chatLinkId ?? null,
    fromHandleId: input.fromHandleId ?? input.handleId,
  };
}

/**
 * A STOP or a START texted from a phone in its own turn, recorded by T-317's own planStopOrStart on the runtime side and
 * committed by its fake of K-05's commit. `businessId` is the business whose thread it came in (null: Rosie's own).
 */
export async function textWord(
  world: World,
  input: {
    readonly kind: "stop" | "start";
    readonly personId: string;
    readonly handleId: string;
    readonly number: string;
    readonly turnId: string;
    readonly now: string;
    readonly businessId: string | null;
    readonly alsoCancelVisit?: boolean;
  },
): Promise<Awaited<ReturnType<typeof planStopOrStart>>> {
  const eventId = `evt-${input.turnId}`;
  const request: StopOrStartRequest = {
    caller: {
      kind: "turn",
      turnId: input.turnId,
      requestId: input.turnId,
      businessId: input.businessId,
      personId: input.personId,
      traceId: `trace-${input.turnId}`,
    },
    kind: input.kind,
    phoneNumber: input.number,
    inboundEventId: eventId,
    words: input.kind === "stop" ? (input.alsoCancelVisit === true ? "CANCEL" : "STOP") : "START",
    alsoCancelVisit: input.alsoCancelVisit ?? false,
    workPhoneBusinessIds: null,
    sentByActor: null,
  };
  const plan = await planStopOrStart(
    { request, turn: { id: input.turnId, handleId: input.handleId, eventIds: [eventId] }, now: input.now },
    {
      reader: flagsReaderOn(world, null),
      messages: messagesReaderOn(world, null),
      ids: KEYED_IDS,
      events: NO_EVENT_SOURCES,
    },
  );
  world.record = applied(world.record, plan.writes.state);
  return plan;
}
