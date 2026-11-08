// What the slot filler reads and gives (C-088; K-03 v1 contracts/message-plan; the shared formats of
// contracts/common/formats.v1.schema.json, CQ-09).
//
// The model never writes a value a person reads (arch 01 line 35; build prompt rule 4): every number, date, price,
// code, name and link in a message is a slot that code fills from the record and code facts (arch 02 line 123, step 7;
// arch 07 line 409). A SlotSource is those facts for one outbox row, each in its own value type: money as whole cents
// with its currency, times as an instant in UTC with the zone they are shown in (CQ-09).

import type { RecordReading } from "./record";

/** An amount: whole cents with its currency code, never a decimal (formats.v1 `money`; CQ-09). */
export interface Money {
  readonly cents: number;
  readonly currency: string;
}

/** A time: the instant in UTC with the IANA zone it is shown and reasoned in (formats.v1 `time`; CQ-09; S13-03). */
export interface Time {
  readonly utc: string;
  readonly zone: string;
}

/** A start and an end, shown in the start's zone: an arrival window ("8–10am") or a block ("Thu Oct 29, 2–5pm"). */
export interface TimeRange {
  readonly start: Time;
  readonly end: Time;
}

/** The channel the outbox row goes on (K-03 `channel`). */
export type Channel = "imessage" | "rcs" | "sms" | "email";

/**
 * The zones a reader's day is read in, for 'today' and 'tomorrow': the visit's zone when the message is about a
 * visit, else the business's (CQ-05's default; K-04 v1 default 9: no person carries a zone).
 */
export interface ReaderZones {
  readonly visit: string | null;
  readonly business: string;
}

/** The business the message speaks for (K-04 `businesses` name and display_name; K-23 listing phone; the owner). */
export interface BusinessFacts {
  /** The business name as listed (biz.name). */
  readonly name: string;
  /** The name texts show under the sensitive switch (biz.name's displayName form; RULES 4.6). */
  readonly displayName: string;
  /** The business's phone number in E.164, such as +15555550177 (biz.phone). */
  readonly phone?: string;
  /** The owner's name (owner.name). */
  readonly ownerName?: string;
}

/** The visit the message is about. Each time is shown in the zone it carries: the visit's zone (S13-03). */
export interface VisitFacts {
  /** The visit's start (day, visit.time; arrive and window for a set-start business). */
  readonly start?: Time;
  /** The pro's arrival window (arrive, window). */
  readonly arrival?: TimeRange;
  /** The free-cancel cutoff, by the business's own rule for this visit (cutoff; D48). */
  readonly cutoff?: Time;
  /** Where the visit is: the address and way in, or the meeting point (visit.place). */
  readonly place?: string;
  /** The visit's check-in code (visit.code; S13-45). */
  readonly code?: string;
}

/** The amounts on the booking's money path (price, fee, deposit, rest, paid). */
export interface AmountFacts {
  readonly price?: Money;
  readonly fee?: Money;
  readonly deposit?: Money;
  readonly rest?: Money;
  readonly paid?: Money;
}

/** The booking's ledger (record ledger_rules: paidnow, due, keep, back, later, backlate; a bare {{keep}} is keep). */
export interface LedgerFacts {
  readonly paidnow?: Money;
  readonly due?: Money;
  readonly keep?: Money;
  readonly back?: Money;
  readonly later?: Money;
  readonly backlate?: Money;
}

/** The links this message may carry, signed for this reader and booking (link.secure, link.pay, link.chat). */
export interface LinkFacts {
  readonly secure?: string;
  readonly pay?: string;
  /** The chat link; link.chatqr is its QR code, where a screen shows it. */
  readonly chat?: string;
}

/** A pending change read back before its yes (change.when, change.price; arch 07 line 409). */
export interface ChangeFacts {
  /** The date and time it sets: a range (a block), or a start alone (a move). */
  readonly when?: { readonly start: Time; readonly end: Time | null };
  readonly price?: Money;
}

/** The code facts for one outbox row, each in its value type. A fact left out leaves the slots that read it unfilled. */
export interface SlotFacts {
  readonly business?: BusinessFacts;
  /** The booking's customer, as owner and staff texts name them (alex.staff). */
  readonly customerName?: string;
  /** Another person a line names, such as another customer of the business (name.staff). */
  readonly otherName?: string;
  /** The pro on the booking (pro.name). */
  readonly proName?: string;
  /** The booked service's name (svc.intext; the amount slot name). */
  readonly serviceName?: string;
  readonly visit?: VisitFacts;
  readonly amounts?: AmountFacts;
  readonly ledger?: LedgerFacts;
  readonly links?: LinkFacts;
  /** The open question's deadline: its clock row's due time (ask.by). */
  readonly askBy?: Time;
  readonly change?: ChangeFacts;
  /** A relayed person's words after the edge scrub and limit 7 (relay.quote; arch 07 line 359). */
  readonly relayQuote?: string;
}

/** Everything the slot filler reads for one outbox row. */
export interface SlotSource {
  /** When code fills the plan (UTC): 'today' and 'tomorrow' are bound to a day from it (arch 07 line 409). */
  readonly filledAt: string;
  readonly zones: ReaderZones;
  readonly channel: Channel;
  /** The sensitive switch: each slot shows its sensitive form (RULES 4.6; S13-22; D41). */
  readonly sensitive: boolean;
  /** The booking's path and record values the record slots' rows are read on; null for a message about no booking. */
  readonly record: RecordReading | null;
  readonly facts: SlotFacts;
}
