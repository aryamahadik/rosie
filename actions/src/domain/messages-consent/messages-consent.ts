// The messages-and-consent service base (T-307; C-102; arch 02 diagram line 105, "Messages · consent"; S13-19, S13-32):
// it gives the turn's one commit its outbox rows and its consent rows, and reads how each person is reached.
//
// One service serves one Tool API call and is bound to the call's business scope (T-290: CallContext.businessId), so a
// row it builds is always this business's. It reads K-04 v1 and K-29 v1 through the data-access calls (reads.ts) and the
// reach card through its port, and it never reads or writes a message's words: ids, flags and closed lists in, rows out.
// Nothing here logs, and what it throws names a fault or an argument, never a number, an address or a person's words.
//
// Outbox rows (arch 01 line 65; K-05 v1 outboxRowNew; K-07 v1): one message to one recipient on one channel, with its
// send class and every version the read-back showed, written by the commit with no plan. The person's way decides the
// channel (RULES 4.8: "Every message goes their way"): texts go in the mobile's chat, on the service Linq reports for it
// (imessage, rcs, or sms through Linq: DL-031), and an email on file gets every message too (RULES 4.1, 4.8); the way
// email sends everything by email. A mobile that is not stopped and whose chat is not open gets no text row, whatever its
// class: Rosie never writes first (MC C9; RULES 4.1b). It is told to the caller (`notBuilt`), and the email on file, if
// any, still carries the message. A stopped mobile gets only a safety line (arch 02 line 111: "past any opt-out"; RULES
// 4.12) or the stop's one reply (RULES 7.3; K-09 stop-recorded.json); nothing else is built for it (RULES 7.2; MC C1).
// No row ever goes by an SMS port: there is none (DL-012; refuse-sms-channel.json).
//
// Consent rows (K-29 v1 consents): a yes bound to the read-back it answered (its exact words, their sha256 and the turn:
// arch 01 line 89; arch 09 line 457), a STOP or a START as a new row for every business (D102; RULES 7.2, 7.5; MC C1),
// each one insert and never an edit (FS line 753). A texts yes counts only from the person themself, for their own
// contact (RULES 7.1; S13-32), and for a stopped mobile only as a fresh yes on a booking sent from that number (RULES
// 7.5; MC C1); only START turns texts back on for every business.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. With no reach card on file (an owner, a staff member, or before a reader of the card exists), the message goes
//      back on the handle the person is writing from (S13-19: "Default: the channel they're using"); with neither, nothing
//      is built and the caller is told (noContact).
//   2. A mobile whose chat Linq has reported no service for is texted by iMessage (arch 02 line 125: "iMessage first for
//      texts").
//   3. The email row of a texts message is the text row's copy (copyOfRowId), id `<row id>-email` as K-04's seed names
//      it; when no text row is built it goes alone, with no copy, under the same id. A stop's reply goes back on the
//      handle the stop came from, whatever the card says, and gets no email copy: RULES 7.3 gives a stop "The one reply".
//   4. A stopped mobile gets a safety line or a stop reply only once it has texted Rosie's number (chat_open_at set): a
//      mobile stopped from a page that never texted is never written to first (MC C9).
//   5. A STOP's or a START's row carries the person's own words as given (K-29 open gap: whole text or the stop word).
//
// Not here: recording STOP and START with the stopped flag, and the other record flags (T-317); chat links (T-325);
// sending, limit 8 at send and the email row's own parts (the dispatcher, C-124 to C-129).

import type { OutboxRowNew, RowRef } from "../../commit";
import {
  CONSENTS_TABLE,
  ConsentRefusedError,
  assertUtc,
  checkConsentValues,
  textsStanding,
  wordsSha256,
  type ConsentChannel,
  type ConsentKind,
  type ConsentValues,
  type ConsentWrite,
} from "./consent";
import {
  OutboxRefusedError,
  SEND_CLASSES,
  checkChannelAndPort,
  emailCopyId,
  portOf,
  versionsReadOf,
  type Channel,
  type SendClass,
} from "./outbox";
import { NO_REACH_CARDS, type MessagesReader, type ReachCard, type ReachCards } from "./reads";

// ---- how a person is reached ----------------------------------------------------------------------------------------

/** Which consent row decides whether a contact takes texts at this business, as the call's scope shows it. */
export interface TextsStanding {
  readonly consentId: string;
  /** True when the newest row withdraws it. */
  readonly revoked: boolean;
}

/** One of the person's mobiles (K-04 v1 phones), by handle id: never its number. */
export interface Mobile {
  readonly handleId: string;
  /** Set by its first text to Rosie's number, cleared by STOP, set again by START (RULES 4.1b). */
  readonly chatOpen: boolean;
  /** The service Linq reports for the chat: imessage, rcs or sms; null before its first text. */
  readonly chatWay: "imessage" | "rcs" | "sms" | null;
  /** STOP: Rosie's texts to this phone are off for every business until START (RULES 7.2, 7.5; MC C1). */
  readonly stopped: boolean;
  /** The handle's chat with Rosie's number (K-04 threads), or null before its first text. */
  readonly chatThreadId: string | null;
  /**
   * This business's texts consent row that decides for this contact (K-29), or null. A STOP or START row covers every
   * business and has no business, so no business scope reads it (K-29 rule 4): `stopped` is what tells a STOP.
   */
  readonly texts: TextsStanding | null;
}

/** One of the person's email addresses (K-04 v1 handles), by handle id: never the address. */
export interface EmailContact {
  readonly handleId: string;
  /** As for a mobile; an email's own stop record has no business and is read at send (limit 8's send state). */
  readonly texts: TextsStanding | null;
}

/** How a person is reached at this business: their way, contacts, flags and stored language (RULES 4.8; S13-19). */
export interface Reach {
  readonly personId: string;
  /** The stored language, a BCP 47 tag such as en or es; null: the business's language (K-04 v1 persons.language). */
  readonly language: string | null;
  /** The reach card on file at this business, or null (an owner, a staff member, or none yet). */
  readonly card: ReachCard | null;
  /** Every mobile the person writes from, in handle id order. */
  readonly mobiles: readonly Mobile[];
  /** Every email address the person writes from, in handle id order. */
  readonly emails: readonly EmailContact[];
}

// ---- outbox rows ----------------------------------------------------------------------------------------------------

/** Who a message is for. */
export interface Recipient {
  /** The person; null for a handle nobody is behind yet, which only `via` reaches (arch 03 line 165, the doors). */
  readonly personId: string | null;
  /**
   * The handle the person is writing from, when the message answers them: with no reach card on file the message goes
   * back that way (default 1). It must be one of the person's own handles.
   */
  readonly via?: string | null;
}

/** One message the commit is to write rows for (K-05 v1 outboxRowNew, with no plan). */
export interface MessageRequest {
  /** The message's row id; its email copy's is `<id>-email` (default 3). */
  readonly id: string;
  readonly to: Recipient;
  readonly bookingId: string | null;
  /** The open question it asks, or null. */
  readonly openQuestionId: string | null;
  readonly sendClass: SendClass;
  /** Every row the read-back showed, at the version shown: each row carries them all (limit 8 compares them at send). */
  readonly versionsRead: readonly RowRef[];
  /**
   * The one reply the stopped flag allows: a stop's reply, or the one reply to a later text (RULES 7.3; K-01 stopReply,
   * stopLaterReply). It goes back on `via`, the handle the stop came from, never by the card (default 3).
   */
  readonly stopReply?: boolean;
}

/** The medium a row would have gone by. */
export type Medium = "text" | "email";

/** Why a row the person's way asked for was not built. */
export type NotBuiltWhy =
  /** A mobile that is not stopped and whose chat is not open: Rosie never writes first (MC C9; RULES 4.1b). */
  | "chatNotOpen"
  /** A stopped mobile: only a safety line or the stop's one reply goes (RULES 7.2, 7.3; MC C1). */
  | "stopped"
  /** The way is texts and no mobile is on file (MC C2: a mobile is required when the customer or their AI books). */
  | "noMobile"
  /** The way is email and no email address is on file. */
  | "noEmail"
  /** Nothing on file to reach them by: no way on the card, or no card and no handle they are writing from (S13-19). */
  | "noContact"
  /** A contact that is not one of the person's own handles: a message reaches only them (RULES 4.8; S13-19). */
  | "notTheirs";

export interface NotBuilt {
  readonly medium: Medium;
  /** The contact it was for, by handle id, or null when there was none. */
  readonly handleId: string | null;
  readonly why: NotBuiltWhy;
}

/** The rows of one message, and what was not built: told to the caller, never sent (MC C9). */
export interface MessageRows {
  /** For UnitWrites.messages, in this order: the text row, then the email row. */
  readonly rows: readonly OutboxRowNew[];
  readonly notBuilt: readonly NotBuilt[];
}

// ---- consent rows ---------------------------------------------------------------------------------------------------

/** A yes bound to the read-back it answered (arch 01 line 89; arch 09 line 457: "Consent: bound to read-back"). */
export interface YesRequest {
  readonly id: string;
  /** Whose own yes it is (RULES 7.1). */
  readonly personId: string;
  readonly kind: ConsentKind;
  /**
   * What the yes answered: the words shown (the read-back, the card, the terms ticked), kept as they were shown, which
   * for an exact yes are the read-back limit 3 bound it to (arch 06 line 303; T-301), and the turn that committed it,
   * whose open question holds the versions read (K-29 README "Bound to the read-back").
   */
  readonly readBack: { readonly words: string; readonly turnId: string | null };
  /** When the yes was given: an instant in UTC ending in Z. */
  readonly at: string;
  readonly channel: ConsentChannel;
  /** The contact a texts yes covers, one of the person's own handles; required for texts (RULES 7.1). */
  readonly handleId?: string | null;
  /** The booking it was given for: required for ticked terms (A5-07) and for a texts yes from a stopped mobile (C1). */
  readonly bookingId?: string | null;
  /** The chat link whose ready text gave it (texts only: MC C9; RULES 7.1, "a yes on a forwarded link"). */
  readonly chatLinkId?: string | null;
  /** The handle it came from: required for a yes by text or email, and whenever given one of the person's own (RULES 7.1). */
  readonly fromHandleId?: string | null;
}

/** A STOP or a START: a new texts row for every business (D102; RULES 7.2, 7.5; MC C1). */
export interface StopRequest {
  readonly id: string;
  /** Whose stop it is: one of the people behind the handle. */
  readonly personId: string;
  /** The contact it answers: the mobile it came from, or an email address for an email stop (RULES 7.2). */
  readonly handleId: string;
  /** The person's own words, as given (RULES 7.2: "in any words or language"; default 5). */
  readonly words: string;
  /** When it came: an instant in UTC ending in Z. */
  readonly at: string;
  readonly channel: ConsentChannel;
  /** The turn that commits it, or null. */
  readonly turnId?: string | null;
}

// ---- the service ----------------------------------------------------------------------------------------------------

export interface MessagesConsent {
  /** The business every row is for: the call's business scope. */
  readonly businessId: string;
  /** How a person is reached here: way, mobiles with chat open and stopped, emails, stored language; null: no person. */
  reach(personId: string): Promise<Reach | null>;
  /** The outbox rows of one message to one recipient, and every row not built with why. */
  outboxRows(message: MessageRequest): Promise<MessageRows>;
  /** A consent row for a yes, bound to the read-back it answered. */
  yes(request: YesRequest): Promise<ConsentWrite>;
  /** A STOP as a new revoked texts row for every business; the earlier rows stay as they are. */
  stop(request: StopRequest): Promise<ConsentWrite>;
  /** A START as a new texts row for every business. */
  start(request: StopRequest): Promise<ConsentWrite>;
}

export interface MessagesConsentOptions {
  /** The business the call runs under: the Tool API call's scope (CallContext.businessId). */
  readonly businessId: string;
  /** The K-04 v1 and K-29 v1 reads, on the call's transaction: messagesReaderOf(context.repo). */
  readonly reader: MessagesReader;
  /** The reach cards on file. Default NO_REACH_CARDS: every message goes back the way the person writes (default 1). */
  readonly reachCards?: ReachCards;
}

/** Ids are opaque strings (CQ-09); the message names the argument, never its value. */
function assertId(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${what} must be a non-empty id`);
  }
}

/** An optional id: absent or null is null; anything else must be an id. */
function optionalId(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  assertId(value, what);
  return value;
}

/** Ids compared, never parsed (CQ-09), each once, in order. */
function sortedIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The way a card's way texts by, or emails by: texts only works like texts while there is no voice (Q-07). */
function mediumOf(way: ReachCard["way"]): Medium | null {
  if (way === null) return null;
  return way === "email" ? "email" : "text";
}

export function createMessagesConsent(options: MessagesConsentOptions): MessagesConsent {
  const { businessId, reader } = options;
  assertId(businessId, "businessId");
  const reachCards = options.reachCards ?? NO_REACH_CARDS;

  /** The person's own handles (K-04 person_handles), or null for a recipient nobody is behind. */
  const ownHandles = async (personId: string | null): Promise<ReadonlySet<string> | null> =>
    personId === null ? null : new Set(await reader.handleIdsOfPerson(personId));

  const standingOf = (row: ReturnType<typeof textsStanding>): TextsStanding | null =>
    row === null ? null : { consentId: row.id, revoked: row.revoked };

  const reach = async (personId: string): Promise<Reach | null> => {
    assertId(personId, "personId");
    const person = await reader.person(personId);
    if (person?.id !== personId) return null;
    const card = await reachCards.cardOf(businessId, personId);
    const consents = (await reader.consentsOfPersons([personId])).filter(
      (row) => row.businessId === businessId || row.businessId === null,
    );
    const mobiles: Mobile[] = [];
    const emails: EmailContact[] = [];
    for (const handleId of sortedIds(await reader.handleIdsOfPerson(personId))) {
      const handle = await reader.handle(handleId);
      if (handle?.id !== handleId) continue;
      const texts = standingOf(textsStanding(consents, personId, businessId, handleId));
      if (handle.kind === "email") {
        emails.push({ handleId, texts });
        continue;
      }
      const phone = await reader.phoneOfHandle(handleId);
      const thread = await reader.chatThreadOf(handleId);
      mobiles.push({
        handleId,
        chatOpen: phone?.chatOpen === true && !phone.stopped,
        chatWay: phone?.chatWay ?? null,
        stopped: phone?.stopped === true,
        chatThreadId: thread !== null && thread.handleId === handleId ? thread.id : null,
        texts,
      });
    }
    return { personId, language: person.language, card, mobiles, emails };
  };

  /**
   * Why no text row goes to this mobile now, or null when one may: a stopped phone takes only a safety line or the stop's
   * one reply, and only once it has texted Rosie's number (default 4); any other phone needs its chat open (MC C9).
   */
  const textHeldBack = async (handleId: string, message: MessageRequest): Promise<NotBuiltWhy | null> => {
    const phone = await reader.phoneOfHandle(handleId);
    if (phone?.handleId !== handleId) return "chatNotOpen";
    if (phone.stopped) {
      const allowed = message.sendClass === "safety" || message.stopReply === true;
      return allowed && phone.chatOpenAt !== null ? null : "stopped";
    }
    return phone.chatOpen ? null : "chatNotOpen";
  };

  /** The mobile's channel: the service Linq reports for its chat, iMessage first (default 2). */
  const textChannel = async (handleId: string): Promise<Channel> =>
    (await reader.phoneOfHandle(handleId))?.chatWay ?? "imessage";

  /** Whether a handle is an email address on K-04's handles. */
  const isEmail = async (handleId: string): Promise<boolean> => {
    const handle = await reader.handle(handleId);
    return handle !== null && handle.id === handleId && handle.kind === "email";
  };

  /**
   * The way and contacts a message goes by: the reach card on file, else the handle the person writes from. A stop's
   * reply answers the stop where it came from, whatever the card says (RULES 7.3: "The one reply"; default 3).
   */
  const contactsOf = async (
    message: MessageRequest,
    own: ReadonlySet<string> | null,
    notBuilt: NotBuilt[],
  ): Promise<{ medium: Medium; mobile: string | null; email: string | null } | null> => {
    const { to } = message;
    const theirs = (handleId: string, medium: Medium): boolean => {
      if (own === null || own.has(handleId)) return true;
      notBuilt.push({ medium, handleId, why: "notTheirs" });
      return false;
    };
    const card =
      to.personId === null || message.stopReply === true
        ? null
        : await reachCards.cardOf(businessId, to.personId);
    if (card !== null) {
      const medium = mediumOf(card.way);
      if (medium === null) {
        notBuilt.push({ medium: "text", handleId: null, why: "noContact" });
        return null;
      }
      const mobile =
        card.mobileHandleId !== null && theirs(card.mobileHandleId, "text") ? card.mobileHandleId : null;
      const email =
        card.emailHandleId !== null && theirs(card.emailHandleId, "email") ? card.emailHandleId : null;
      return { medium, mobile, email };
    }
    const via = optionalId(to.via, "to.via");
    const handle = via === null ? null : await reader.handle(via);
    if (via === null || handle?.id !== via) {
      notBuilt.push({ medium: "text", handleId: null, why: "noContact" });
      return null;
    }
    const medium: Medium = handle.kind === "email" ? "email" : "text";
    if (!theirs(via, medium)) return null;
    return medium === "email" ? { medium, mobile: null, email: via } : { medium, mobile: via, email: null };
  };

  const outboxRows = async (message: MessageRequest): Promise<MessageRows> => {
    assertId(message.id, "id");
    const personId = optionalId(message.to.personId, "to.personId");
    const bookingId = optionalId(message.bookingId, "bookingId");
    const openQuestionId = optionalId(message.openQuestionId, "openQuestionId");
    if (!SEND_CLASSES.includes(message.sendClass)) throw new OutboxRefusedError("sendClassUnknown");
    const versionsRead = versionsReadOf(message.versionsRead);

    const rowOf = (
      id: string,
      handleId: string,
      channel: Channel,
      copyOfRowId: string | null,
    ): OutboxRowNew => {
      checkChannelAndPort({ channel, port: portOf(channel) });
      return {
        id,
        recipientHandleId: handleId,
        recipientPersonId: personId,
        businessId,
        bookingId,
        channel,
        sendClass: message.sendClass,
        openQuestionId,
        copyOfRowId,
        versionsRead: versionsRead.map((ref) => ({ ...ref })),
      };
    };

    const rows: OutboxRowNew[] = [];
    const notBuilt: NotBuilt[] = [];
    const contacts = await contactsOf(message, await ownHandles(personId), notBuilt);
    if (contacts === null) return { rows, notBuilt };

    /** Whether a contact of this medium was already told as not theirs (it is then not told again as missing). */
    const toldNotTheirs = (medium: Medium): boolean =>
      notBuilt.some((each) => each.medium === medium && each.why === "notTheirs");

    let textRow: OutboxRowNew | null = null;
    if (contacts.medium === "text") {
      if (contacts.mobile === null) {
        if (!toldNotTheirs("text")) notBuilt.push({ medium: "text", handleId: null, why: "noMobile" });
      } else {
        const why = await textHeldBack(contacts.mobile, message);
        if (why === null) {
          textRow = rowOf(message.id, contacts.mobile, await textChannel(contacts.mobile), null);
          rows.push(textRow);
        } else {
          notBuilt.push({ medium: "text", handleId: contacts.mobile, why });
        }
      }
    }

    const copyOfAStopReply = contacts.medium === "text" && message.stopReply === true;
    if (contacts.email !== null && !copyOfAStopReply) {
      if (await isEmail(contacts.email)) {
        const id = contacts.medium === "email" ? message.id : emailCopyId(message.id);
        rows.push(rowOf(id, contacts.email, "email", textRow === null ? null : textRow.id));
      } else {
        notBuilt.push({ medium: "email", handleId: contacts.email, why: "noEmail" });
      }
    } else if (contacts.medium === "email" && !toldNotTheirs("email")) {
      notBuilt.push({ medium: "email", handleId: null, why: "noEmail" });
    }
    return { rows, notBuilt };
  };

  /** One consent row as the insert the commit writes, its hash made from its words, held to K-29's rules. */
  const writeOf = async (values: Omit<ConsentValues, "words_sha256">): Promise<ConsentWrite> => {
    assertUtc(values.at);
    const full: ConsentValues = { ...values, words_sha256: await wordsSha256(values.exact_words) };
    checkConsentValues(full);
    return { op: "insert", table: CONSENTS_TABLE, values: full };
  };

  const yes = async (request: YesRequest): Promise<ConsentWrite> => {
    assertId(request.id, "id");
    assertId(request.personId, "personId");
    const handleId = optionalId(request.handleId, "handleId");
    const bookingId = optionalId(request.bookingId, "bookingId");
    const chatLinkId = optionalId(request.chatLinkId, "chatLinkId");
    const fromHandleId = optionalId(request.fromHandleId, "fromHandleId");
    const turnId = optionalId(request.readBack.turnId, "readBack.turnId");
    const values: Omit<ConsentValues, "words_sha256"> = {
      id: request.id,
      person_id: request.personId,
      business_id: businessId,
      kind: request.kind,
      revoked: false,
      handle_id: handleId,
      booking_id: bookingId,
      exact_words: request.readBack.words,
      at: request.at,
      channel: request.channel,
      chat_link_id: chatLinkId,
      turn_id: turnId,
    };
    checkConsentValues({ ...values, words_sha256: "" });

    const own = new Set(await reader.handleIdsOfPerson(request.personId));
    const byContact = request.channel === "text" || request.channel === "email";
    const fromThem = fromHandleId === null ? !byContact : own.has(fromHandleId);
    if (!fromThem) throw new ConsentRefusedError("notFromThem");
    if (handleId !== null && !own.has(handleId)) throw new ConsentRefusedError("notTheirContact");
    if (request.kind === "texts" && handleId !== null) {
      const phone = await reader.phoneOfHandle(handleId);
      const stopped = phone !== null && phone.handleId === handleId && phone.stopped;
      const freshYesFromThatNumber =
        bookingId !== null && request.channel === "text" && fromHandleId === handleId;
      if (stopped && !freshYesFromThatNumber) throw new ConsentRefusedError("stoppedNumber");
    }
    return writeOf(values);
  };

  /** A STOP (revoked) or a START: kind texts, no business, the contact it answers, the person's own words. */
  const everyBusiness = async (request: StopRequest, revoked: boolean): Promise<ConsentWrite> => {
    assertId(request.id, "id");
    assertId(request.personId, "personId");
    assertId(request.handleId, "handleId");
    const turnId = optionalId(request.turnId, "turnId");
    const values: Omit<ConsentValues, "words_sha256"> = {
      id: request.id,
      person_id: request.personId,
      business_id: null,
      kind: "texts",
      revoked,
      handle_id: request.handleId,
      booking_id: null,
      exact_words: request.words,
      at: request.at,
      channel: request.channel,
      chat_link_id: null,
      turn_id: turnId,
    };
    checkConsentValues({ ...values, words_sha256: "" });
    const own = new Set(await reader.handleIdsOfPerson(request.personId));
    if (!own.has(request.handleId)) throw new ConsentRefusedError("notTheirContact");
    return writeOf(values);
  };

  return {
    businessId,
    reach,
    outboxRows,
    yes,
    stop: (request) => everyBusiness(request, true),
    start: (request) => everyBusiness(request, false),
  };
}
