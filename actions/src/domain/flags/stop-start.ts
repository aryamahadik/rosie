// recordStopOrStart (T-317; C-078 with C-102; K-09 v1 recordStopOrStart; RULES 7.2 to 7.5, 7.7; MC C1; S13-32; arch 03
// lines 175 to 177; arch 11 line 566): STOP, START and a work phone's answer to "which texts?", each recorded as consent
// rows through T-307's messages-and-consent service, with the phone's stopped flag beside them.
//
//   - Each binds to the number it came from (K-09 v1 README default 29): from a turn, the number must be the turn's own
//     phone and the text one of the turn's; written on return, the text's event must be from that phone; a STOP made on a
//     page, by email or by an outside AI stops only the caller's own mobile. START counts only from the phone's own START
//     text, in its turn or written on return by its actor. Anything else changes nothing: notFromThatPhone.
//   - STOP stops Rosie's texts to that phone for every business, until START (MC C1; RULES 7.2, 7.5): one consent row with
//     no business per person behind the phone (T-307's stop(), K-29 seed-consent-stop-row.json), and the phone's one row
//     stopped with its chat closed (K-04 phones; RULES 4.1b). Its one reply is a quick_reply row back to that phone (K-09
//     README default 6), built by T-307's outboxRows with stopReply; the actor's own send, written on return, is named and
//     never sent again (sentByActor).
//   - START is a new texts row for every business (T-307's start()) and clears the flag, opening the chat (RULES 4.1b).
//   - A phone that also gets work texts (an owner, admin or staff role anywhere) asks which texts a STOP in its turn meant
//     (RULES 7.7; S13-32 lines 7248 to 7250); its answer names the businesses whose texts stop, all of them when it names
//     none, and no answer by its clock means all.
//   - A STOP or START the handle actor writes on return keeps the time it came, not the time it is written, and is keyed by
//     its text's event id, so the same text written twice is written once (arch 11 line 566; T-269's security note c).
//     A replayed word older than the phone's newest opposite word leaves the flag as that newer word set it: the newest
//     word decides, as the newest consent row does (K-29 README), so a replay can never lift a later STOP.
//
// Nothing here logs; what it answers or throws carries ids, flags and labels, never the number (except K-09's own
// notFromThatPhone and notAWorkPhone answers, which name the request's own number back), an address or anyone's words.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. The time a STOP or START written on return keeps is `sentByActor.at`: K-09 v1 carries no other time for it, and the
//      actor answers a stop word at once (arch 02 line 115). Written on return with no such send, it is the call's now
//      (later, so a STOP so written never loses to a START it may have come before: fail closed).
//   2. Whose STOP it is: the caller's person when they are behind the phone, else every person behind it, one row each.
//   3. A work phone's STOP in a turn stops at once the texts of every business where the phone's people hold no work role
//      ("their own appointment texts": a stop stops at once, RULES 7.2), one revoked texts row each at that business, and
//      asks only about the rest; the flag stays clear until an answer, or no answer, covers every business. Made alone or
//      on return, where no question can be asked (no turn writes no outbox row), it stops every text at once.
//   4. The "which texts?" question is open-ended (options as the bundle writes them are not this call's), on S13-32, with
//      the clock line "1 h": an elapsed hour from delivery ends no later than RULES 7.7's "next text hour", which T-255's
//      due rule cannot read yet; its safe default is every text.
//   5. Replies: a work phone's answer naming some businesses gets no reply (C1's stop reply names every business, and a
//      one-business line is not in the bundle this call reads); an answer naming none gets the stop reply; no answer gets
//      none (its question was the one reply). START's reply is the startReply line. A call made alone writes no outbox
//      row (K-04 outbox_rows.turn_id is not null): its reply is shown by the page or was sent by the actor.
//   6. CANCEL (alsoCancelVisit) flags each open booking (stage entry or booked) of the people behind the phone with a
//      booking.flagged entry (K-08 v1), the visit itself unchanged (RULES 7.4: "flags the visit").
//   7. A STOP with no business (every business: K-09 caller.businessId null) has its reply row name no business (Rosie's
//      own line: K-04 outbox_rows.business_id); T-307's service, bound to one business, builds it under EVERY_BUSINESS.

import type { ErrorsOf, RequestOf, ResponseOf } from "../../tool-api";
import {
  CONSENTS_TABLE,
  checkConsentValues,
  createMessagesConsent,
  stateWriteOf,
  wordsSha256,
  type ConsentChannel,
  type ConsentValues,
  type ConsentWrite,
  type MessagesConsent,
  type MessagesReader,
} from "../messages-consent";
import { FlagRefusedError } from "./errors";
import type { FlagIds } from "./ids";
import type { FlagsReader, Handle, Phone } from "./reads";
import { eventEntry, noWrites, type FlagWrites } from "./writes";

export type StopOrStartRequest = RequestOf<"recordStopOrStart">;
export type StopOrStartResponse = ResponseOf<"recordStopOrStart">;
export type StopOrStartError = ErrorsOf<"recordStopOrStart">;
export type StopOrStartAnswer = StopOrStartResponse | StopOrStartError;

/** The stop home's step (S13-32): every row a STOP, START or work phone's answer writes is for it (K-08 v1 why). */
export const STOP_STEP = "S13-32";

/** The fixed lines K-09 v1's fixtures name for the replies (K-01 fixedLineId). */
export const STOP_REPLY = "stopReply";
export const START_REPLY = "startReply";

/** The clock line of a work phone's "which texts?" question (default 4) and what its clock applies (RULES 7.7). */
export const WHICH_TEXTS_CLOCK = "1 h";
export const WHICH_TEXTS_DEFAULT = "everyText";

/** The binding T-307's service takes for rows that name every business (default 7): never written to a row. */
export const EVERY_BUSINESS = "every-business";

const WORK_ROLES: readonly string[] = ["owner", "admin", "staff"];

/** The turn whose commit carries the call (K-05 v1 turn): its id, its handle and its texts' event ids. */
export interface CarryingTurn {
  readonly id: string;
  readonly handleId: string;
  readonly eventIds: readonly string[];
}

export interface StopOrStartCall {
  readonly request: StopOrStartRequest;
  /** The turn whose one commit carries it (a core action of gateAndCommit), or null when it is made alone. */
  readonly turn: CarryingTurn | null;
  /** The call's now, in UTC ending in Z: the gateAndCommit request's now in a turn, the caller's clock when alone. */
  readonly now: string;
}

/**
 * The handle each inbound event came from (K-06 v1), for a STOP or START the handle actor writes on return: the actor's
 * own queue keeps it (T-269), since no turn names it then. Null when unknown: the call then changes nothing.
 */
export interface EventSources {
  handleOf(eventId: string): Promise<string | null>;
}

/** No event's handle is known: a write on return then changes nothing (notFromThatPhone), failing closed. */
export const NO_EVENT_SOURCES: EventSources = {
  handleOf: () => Promise.resolve(null),
};

export interface StopOrStartPorts {
  /** K-04 and K-29 reads on the runtime side (or the call's transaction). */
  readonly reader: FlagsReader;
  /** T-307's reads for the reply rows (messagesReaderOf on the same transaction). */
  readonly messages: MessagesReader;
  readonly ids: FlagIds;
  readonly events: EventSources;
}

/** What one recordStopOrStart call answers and writes. */
export interface StopOrStartPlan {
  /** The key a repeat is known by: the turn, else the text's event for a write on return, else the caller's request. */
  readonly key: string;
  readonly answer: StopOrStartAnswer;
  /** Empty for a refusal or a repeat. */
  readonly writes: FlagWrites;
  /** The stop or start reply this call built as an outbox row, or null: the row the stopped flag lets through for it. */
  readonly replyRowId: string | null;
}

/** The key a repeat is known by (K-09 v1: "the text's turn (or the clock row for workPhoneNoAnswer) is the key"). */
export function keyOf(call: StopOrStartCall): string {
  if (call.turn !== null) return call.turn.id;
  const { caller, inboundEventId } = call.request;
  if (caller.kind === "actorOnReturn" && inboundEventId !== null) return inboundEventId;
  return caller.requestId;
}

/** The time the word came (default 1): written on return, when the actor sent its reply; else the call's now. */
export function timeOf(call: StopOrStartCall): string {
  const { caller, sentByActor } = call.request;
  if (caller.kind === "actorOnReturn" && sentByActor !== null) return sentByActor.at;
  return call.now;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Where the word was given (K-29 v1 consents.channel): a text, an email, a page or an outside AI. */
function channelOf(call: StopOrStartCall, turnHandle: Handle | null): ConsentChannel {
  switch (call.request.caller.kind) {
    case "page":
    case "console":
      return "page";
    case "agent":
      return "ai";
    case "turn":
      return turnHandle?.kind === "email" ? "email" : "text";
    default:
      return "text";
  }
}

/** Whether the word came from the number itself (K-09 v1 README default 29). */
async function fromThatPhone(
  call: StopOrStartCall,
  handle: Handle,
  turnHandle: Handle | null,
  ports: StopOrStartPorts,
): Promise<boolean> {
  const { request, turn } = call;
  const { caller, kind, inboundEventId } = request;
  const callersOwn = async (): Promise<boolean> =>
    caller.personId !== null && (await ports.reader.handleIdsOfPerson(caller.personId)).includes(handle.id);
  switch (caller.kind) {
    case "turn": {
      if (turn === null) return false;
      if (turnHandle?.kind === "email") {
        // A STOP by email stops only the caller's own mobile (RULES 7.2); START never comes by email.
        return kind === "stop" && inboundEventId === null && (await callersOwn());
      }
      if (turn.handleId !== handle.id) return false;
      if (kind === "workPhoneNoAnswer") return true;
      return inboundEventId !== null && turn.eventIds.includes(inboundEventId);
    }
    case "actorOnReturn":
      return (
        kind !== "workPhoneNoAnswer" &&
        inboundEventId !== null &&
        (await ports.events.handleOf(inboundEventId)) === handle.id
      );
    case "page":
    case "agent":
    case "console":
      return kind === "stop" && inboundEventId === null && (await callersOwn());
    case "clockFiring":
      // workPhoneNoAnswer's clock row is the key; the row was armed for that phone by its STOP's turn.
      return kind === "workPhoneNoAnswer";
    default:
      return false;
  }
}

/** The people whose word it is (default 2): the caller's person when behind the phone, else every person behind it. */
function whoseWord(callerPersonId: string | null, people: readonly string[]): string[] {
  if (callerPersonId !== null && people.includes(callerPersonId)) return [callerPersonId];
  return [...people].sort(byId);
}

/** A revoked texts row at one business (a work phone's answer), held to K-29's rules as T-307's rows are. */
async function withdrawAt(input: {
  id: string;
  personId: string;
  businessId: string;
  handleId: string;
  words: string;
  at: string;
  channel: ConsentChannel;
  turnId: string | null;
}): Promise<ConsentWrite> {
  const values: ConsentValues = {
    id: input.id,
    person_id: input.personId,
    business_id: input.businessId,
    kind: "texts",
    revoked: true,
    handle_id: input.handleId,
    booking_id: null,
    exact_words: input.words,
    words_sha256: await wordsSha256(input.words),
    at: input.at,
    channel: input.channel,
    chat_link_id: null,
    turn_id: input.turnId,
  };
  checkConsentValues(values);
  return { op: "insert", table: CONSENTS_TABLE, values };
}

/** A consent row's event-log entry: ids, kind, flags and its words' hash, never its words (K-08 v1 plainValue). */
function consentEntry(write: ConsentWrite, why: FlagWrites["why"]): FlagWrites["stateEvents"][number] {
  const { values } = write;
  return eventEntry({
    id: `log-${values.id}-${values.revoked ? "withdrawn" : "given"}`,
    kind: values.revoked ? "consent.withdrawn" : "consent.given",
    zone: null,
    businessId: values.business_id,
    actor: { personId: values.person_id, role: null },
    table: CONSENTS_TABLE,
    rowId: values.id,
    old: null,
    new: {
      kind: values.kind,
      revoked: values.revoked,
      business_id: values.business_id,
      handle_id: values.handle_id,
      channel: values.channel,
      words_sha256: values.words_sha256,
      at: values.at,
    },
    why,
  });
}

/** The phone's flag as the newest word leaves it (the module note): a replayed word older than the opposite one changes nothing. */
function flagMoves(phone: Phone, stop: boolean, at: string): boolean {
  const when = Date.parse(at);
  if (stop) {
    if (phone.stopped) return false;
    // A START that came after this STOP decides: the person's last word turned texts back on.
    return !(phone.startAt !== null && phone.startAt.getTime() > when);
  }
  if (!phone.stopped) return false;
  // A STOP at or after this START decides (fail closed on a tie): a replay never lifts a later STOP.
  return !(phone.stopAt !== null && phone.stopAt.getTime() >= when);
}

/** The phone's state write and entry for a STOP or a START, compared and set on the version read (K-04 phones). */
function phoneWrite(
  phone: Phone,
  stop: boolean,
  at: string,
  actorPersonId: string | null,
  why: FlagWrites["why"],
  logId: string,
): Pick<FlagWrites, "state" | "stateEvents"> {
  const set: Record<string, unknown> = stop
    ? { stopped: true, chat_open: false, stop_at: at }
    : {
        stopped: false,
        chat_open: true,
        start_at: at,
        ...(phone.chatOpenAt === null ? { chat_open_at: at } : {}),
      };
  return {
    state: [
      { op: "update", table: "phones", key: { number: phone.number }, expectVersion: phone.version, set },
    ],
    stateEvents: [
      eventEntry({
        id: logId,
        kind: stop ? "phone.stopped" : "phone.started",
        zone: null,
        businessId: null,
        actor: actorPersonId === null ? null : { personId: actorPersonId, role: null },
        // K-08 v1 rowRef: a phone row is named by its handle id, never its number.
        table: "phones",
        rowId: phone.handleId,
        old: { stopped: phone.stopped, chat_open: phone.chatOpen },
        new: { ...set, chat_open: !stop },
        why,
      }),
    ],
  };
}

/** Each open booking (stage entry or booked) of these people, by id, at every business the scope shows (default 6). */
async function openBookingsOf(reader: FlagsReader, people: readonly string[]): Promise<string[]> {
  const ids = new Set<string>();
  for (const personId of people) {
    for (const head of await reader.bookingsOfPerson(personId)) {
      if (head.stage === "entry" || head.stage === "booked") ids.add(head.id);
    }
  }
  return [...ids].sort(byId);
}

/** The businesses where these people hold a work role, and those where they hold only other roles (default 3). */
async function rolesOf(
  reader: FlagsReader,
  people: readonly string[],
): Promise<{ work: Set<string>; other: Set<string> }> {
  const work = new Set<string>();
  const other = new Set<string>();
  for (const personId of people) {
    for (const role of await reader.liveRoles(personId)) {
      if (role.endedAt !== null) continue;
      (WORK_ROLES.includes(role.role) ? work : other).add(role.businessId);
    }
  }
  for (const businessId of work) other.delete(businessId);
  return { work, other };
}

/** The service T-307 builds rows with, bound to the call's business or, with none, to EVERY_BUSINESS (default 7). */
function messagesFor(request: StopOrStartRequest, reader: MessagesReader): MessagesConsent {
  return createMessagesConsent({ businessId: request.caller.businessId ?? EVERY_BUSINESS, reader });
}

/**
 * Plans one recordStopOrStart call: what it answers, and what its commit writes. Reads only; nothing is written here, and
 * a repeat of a key already written answers `repeated` with nothing to write.
 */
export async function planStopOrStart(
  call: StopOrStartCall,
  ports: StopOrStartPorts,
): Promise<StopOrStartPlan> {
  const { request, turn } = call;
  const { reader, ids } = ports;
  const key = keyOf(call);
  const why = { step: STOP_STEP, choice: null };
  const answerOnly = (answer: StopOrStartAnswer): StopOrStartPlan => ({
    key,
    answer,
    writes: noWrites(STOP_STEP),
    replyRowId: null,
  });
  const notFromThatPhone = (): StopOrStartPlan =>
    answerOnly({ error: "notFromThatPhone", phoneNumber: request.phoneNumber });

  if (request.caller.kind === "turn" && turn === null) throw new FlagRefusedError("turnRidesInCommit");
  // K-09 v1's schema rule, held in code too: START only from the phone's own START text, by its turn or its actor.
  if (
    request.kind === "start" &&
    (request.inboundEventId === null || !["turn", "actorOnReturn"].includes(request.caller.kind))
  ) {
    return notFromThatPhone();
  }

  const handle = await reader.handleOfAddress(request.phoneNumber);
  const turnHandle = turn === null ? null : await reader.handle(turn.handleId);
  if (handle?.kind !== "phone" || !(await fromThatPhone(call, handle, turnHandle, ports))) {
    return notFromThatPhone();
  }
  const phone = await reader.phone(request.phoneNumber);
  if (phone?.handleId !== handle.id) {
    return answerOnly({ error: "notFound", table: "phones", rowId: handle.id });
  }
  const people = await reader.personIdsOfHandle(handle.id);
  if (people.length === 0)
    return answerOnly({ error: "notFound", table: "person_handles", rowId: handle.id });
  const whose = whoseWord(request.caller.personId, people);
  const roles = await rolesOf(reader, people);
  const isWorkPhone = roles.work.size > 0;
  if ((request.kind === "workPhoneAnswer" || request.kind === "workPhoneNoAnswer") && !isWorkPhone) {
    return answerOnly({ error: "notAWorkPhone", phoneNumber: request.phoneNumber });
  }

  const at = timeOf(call);
  const channel = channelOf(call, turnHandle);
  const turnId = turn?.id ?? null;
  const messages = messagesFor(request, ports.messages);
  const replyBusiness = request.caller.businessId;
  const sent = request.sentByActor;

  /** The reply row back to the phone, built by T-307's outboxRows (stopReply: back where the word came from). */
  const replyRow = async (
    rowId: string,
    openQuestionId: string | null,
  ): Promise<FlagWrites["messages"][number] | null> => {
    if (turn === null) return null;
    const [person] = whose;
    const built = await messages.outboxRows({
      id: rowId,
      to: { personId: person ?? null, via: handle.id },
      bookingId: null,
      openQuestionId,
      sendClass: "quick_reply",
      versionsRead: [],
      stopReply: true,
    });
    const row = built.rows.find((each) => each.id === rowId && each.recipientHandleId === handle.id);
    return row === undefined ? null : { ...row, businessId: replyBusiness };
  };
  const reply = async (
    fixedLineId: string,
  ): Promise<{ answer: StopOrStartResponse["reply"]; row: FlagWrites["messages"][number] | null }> => {
    if (sent !== null) return { answer: { fixedLineId: sent.fixedLineId, outboxRowId: null }, row: null };
    const row = await replyRow(await ids.rowId("stopReply", key), null);
    return { answer: { fixedLineId, outboxRowId: row?.id ?? null }, row };
  };

  const flagged = request.alsoCancelVisit ? await openBookingsOf(reader, people) : [];
  const flaggedEntries = flagged.map((bookingId) =>
    eventEntry({
      id: `log-${bookingId}-cancel-word-${key}`,
      kind: "booking.flagged",
      zone: null,
      businessId: null,
      actor: whose.length === 1 && whose[0] !== undefined ? { personId: whose[0], role: null } : null,
      table: "bookings",
      rowId: bookingId,
      old: null,
      new: { flag: "cancelWord" },
      why,
    }),
  );

  // ---- a work phone's STOP in its turn: ask which texts (default 3) --------------------------------------------------
  const asksWhich = request.kind === "stop" && isWorkPhone && turn !== null;
  // ---- a work phone's answer that names some businesses: their texts stop, the flag stays clear ----------------------
  const namesSome = request.kind === "workPhoneAnswer" && request.workPhoneBusinessIds !== null;

  const consentIds = await Promise.all(whose.map((personId) => ids.rowId("consent", key, personId)));
  const [firstConsent] = consentIds;
  if (!asksWhich && !namesSome && firstConsent !== undefined && (await reader.consentWritten(firstConsent))) {
    // A repeat of a key already written (K-09 v1 "Repeat: safe"): nothing more is written.
    const replyAnswer =
      request.kind === "workPhoneNoAnswer"
        ? null
        : sent !== null
          ? { fixedLineId: sent.fixedLineId, outboxRowId: null }
          : {
              fixedLineId: request.kind === "start" ? START_REPLY : STOP_REPLY,
              outboxRowId: turn === null ? null : await ids.rowId("stopReply", key),
            };
    return answerOnly({
      consentRowIds: consentIds,
      stopped: phone.stopped,
      chatOpen: phone.chatOpen,
      phoneVersion: phone.version,
      reply: replyAnswer,
      askedWhichTexts: null,
      flaggedBookingIds: flagged,
      repeated: true,
    });
  }

  if (asksWhich || namesSome) {
    const businesses = asksWhich
      ? [...roles.other].sort(byId)
      : [...new Set(request.workPhoneBusinessIds ?? [])].sort(byId);
    const writes: ConsentWrite[] = [];
    for (const businessId of businesses) {
      for (const personId of whose) {
        writes.push(
          await withdrawAt({
            id: await ids.rowId("consent", key, `${personId}/${businessId}`),
            personId,
            businessId,
            handleId: handle.id,
            words: request.words,
            at,
            channel,
            turnId,
          }),
        );
      }
    }
    if (namesSome && writes.length > 0 && (await reader.consentWritten(writes[0]?.values.id ?? ""))) {
      return answerOnly({
        consentRowIds: writes.map((write) => write.values.id),
        stopped: phone.stopped,
        chatOpen: phone.chatOpen,
        phoneVersion: phone.version,
        reply: null,
        askedWhichTexts: null,
        flaggedBookingIds: flagged,
        repeated: true,
      });
    }
    let asked: StopOrStartResponse["askedWhichTexts"] = null;
    const asks: FlagWrites["asks"][number][] = [];
    const rows: FlagWrites["messages"][number][] = [];
    if (asksWhich) {
      const questionId = await ids.rowId("whichTexts", key);
      const [person] = whose;
      asks.push({
        question: {
          id: questionId,
          handleId: handle.id,
          personId: person ?? null,
          businessId: replyBusiness,
          bookingId: null,
          step: STOP_STEP,
          options: [],
          readback: null,
          versionsRead: [],
          clock: WHICH_TEXTS_CLOCK,
        },
        safeDefault: WHICH_TEXTS_DEFAULT,
      });
      const row = await replyRow(await ids.rowId("stopReply", key), questionId);
      if (row !== null) rows.push(row);
      // The commit names an asked question's clock row `clock-<question id>` (commit/build.ts questionClock).
      asked = { openQuestionId: questionId, clockRowId: `clock-${questionId}` };
    }
    return {
      key,
      answer: {
        consentRowIds: writes.map((write) => write.values.id),
        stopped: phone.stopped,
        chatOpen: phone.chatOpen,
        phoneVersion: phone.version,
        reply: null,
        askedWhichTexts: asked,
        flaggedBookingIds: flagged,
        repeated: false,
      },
      writes: {
        why,
        versionsRead: [],
        state: writes.map(stateWriteOf),
        stateEvents: [...writes.map((write) => consentEntry(write, why)), ...flaggedEntries],
        asks,
        messages: rows,
        clocks: [],
      },
      replyRowId: null,
    };
  }

  // ---- STOP or START for every business --------------------------------------------------------------------------
  const stop = request.kind !== "start";
  const consents: ConsentWrite[] = [];
  for (const [index, personId] of whose.entries()) {
    const id = consentIds[index];
    if (id === undefined) continue;
    const word = { id, personId, handleId: handle.id, words: request.words, at, channel, turnId };
    consents.push(stop ? await messages.stop(word) : await messages.start(word));
  }
  const moves = flagMoves(phone, stop, at);
  const phoneWrites = moves
    ? phoneWrite(
        phone,
        stop,
        at,
        whose.length === 1 ? (whose[0] ?? null) : null,
        why,
        `log-${firstConsent ?? key}-phone`,
      )
    : { state: [], stateEvents: [] };
  const replied =
    request.kind === "workPhoneNoAnswer"
      ? { answer: null, row: null }
      : await reply(stop ? STOP_REPLY : START_REPLY);
  const stoppedAfter = moves ? stop : phone.stopped;
  return {
    key,
    answer: {
      consentRowIds: consents.map((write) => write.values.id),
      stopped: stoppedAfter,
      chatOpen: moves ? !stop : phone.chatOpen,
      phoneVersion: moves ? phone.version + 1 : phone.version,
      reply: replied.answer,
      askedWhichTexts: null,
      flaggedBookingIds: flagged,
      repeated: false,
    },
    writes: {
      why,
      versionsRead: [],
      state: [...consents.map(stateWriteOf), ...phoneWrites.state],
      stateEvents: [
        ...consents.map((write) => consentEntry(write, why)),
        ...phoneWrites.stateEvents,
        ...flaggedEntries,
      ],
      asks: [],
      messages: replied.row === null ? [] : [replied.row],
      clocks: [],
    },
    replyRowId: replied.row?.id ?? null,
  };
}
