// The slot vocabulary the slot filler fills (C-088; K-03 v1 contracts/message-plan/fixtures/slots.json).
//
// K-03 v1 holds 52 slots: the record's 16 named slots, the 8 auto-fill slots, the 6 amount slots, the 5 ledger
// amounts, today and tomorrow (filled at send), the 4 link slots and the 11 slots the compiler makes from sample values
// (CQ-17's proposed names). SLOT_NAMES lists them in slots.json's order, so the type system asks for a filler for each;
// the unit tests hold this list, the fillers and slots.json to each other, so a slot the vocabulary gains without a
// filler fails them. hold is not a slot: refused since D66 (SPEC-master D66 amendments, #3 and the 5h amendment).

import slotsJson from "../../../../contracts/message-plan/fixtures/slots.json";

export const SLOT_NAMES = [
  "pay.asks",
  "pay.price",
  "pay.took",
  "pay.left",
  "pay.cancel",
  "pay.late",
  "pay.noshow",
  "pay.back",
  "pay.after",
  "pay.staff",
  "pay.failed",
  "clock.pay",
  "two.count",
  "reach.way",
  "reach.to",
  "who.ok",
  "alex.staff",
  "name.staff",
  "svc.intext",
  "arrive",
  "window",
  "cutoff",
  "day",
  "keep",
  "price",
  "fee",
  "deposit",
  "rest",
  "paid",
  "name",
  "paidnow",
  "due",
  "back",
  "later",
  "backlate",
  "today",
  "tomorrow",
  "link.secure",
  "link.pay",
  "link.chat",
  "link.chatqr",
  "biz.name",
  "biz.phone",
  "owner.name",
  "pro.name",
  "visit.time",
  "visit.place",
  "visit.code",
  "ask.by",
  "change.when",
  "change.price",
  "relay.quote",
] as const;

/** A slot of K-03 v1's vocabulary. */
export type SlotName = (typeof SLOT_NAMES)[number];

/** The record's 16 named slots, whose words are rows of the bundle's record (K-01 record.slots). */
export const RECORD_SLOT_NAMES = [
  "pay.asks",
  "pay.price",
  "pay.took",
  "pay.left",
  "pay.cancel",
  "pay.late",
  "pay.noshow",
  "pay.back",
  "pay.after",
  "pay.staff",
  "pay.failed",
  "clock.pay",
  "two.count",
  "reach.way",
  "reach.to",
  "who.ok",
] as const satisfies readonly SlotName[];

export type RecordSlotName = (typeof RECORD_SLOT_NAMES)[number];

/** The two slots filled at send, in the reader's zone (arch 07 line 409). */
export type SendSlotName = "today" | "tomorrow";

/** K-03 `valueType`: the kind of value a slot holds, as the Values check reads it. */
export type ValueType =
  | "phrase"
  | "personName"
  | "businessName"
  | "money"
  | "date"
  | "time"
  | "timeRange"
  | "deadline"
  | "place"
  | "phone"
  | "code"
  | "link"
  | "words";

/** K-03 `sensitiveForm`: what a slot shows with the sensitive switch on (RULES 4.6; S13-22; D41). */
export type SensitiveForm = "asIs" | "initials" | "emptyOrAlternate" | "displayName" | "securePageOnly";

/** K-03 `filledBy`: the slot filler (after the composer, before the checks) or the send (today and tomorrow). */
export type FilledBy = "slotFiller" | "send";

/** One slot as slots.json describes it (the fields the filler and its tests read). */
export interface VocabularySlot {
  readonly name: string;
  readonly kind: string;
  readonly valueType: string;
  readonly sensitiveForm: string;
  readonly filledBy: string;
}

/** K-03 v1's slot vocabulary, as contracts/message-plan/fixtures/slots.json lists it. */
export const VOCABULARY: readonly VocabularySlot[] = slotsJson.slots;

const NAMES: ReadonlySet<string> = new Set<string>(SLOT_NAMES);
const RECORD_NAMES: ReadonlySet<string> = new Set<string>(RECORD_SLOT_NAMES);

export function isSlotName(name: string): name is SlotName {
  return NAMES.has(name);
}

export function isRecordSlotName(name: string): name is RecordSlotName {
  return RECORD_NAMES.has(name);
}
