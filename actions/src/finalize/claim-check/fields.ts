// The fields a slot's value is read from, and their audiences (C-091; arch 06 line 311; arch 01 line 91).
//
// A field is a column of a frozen table list, named part.table.column (02-contracts section 2 item 3: "each field's
// audience (customer, staff, owner, secure page only, or never: RULES 4.5; arch 06 line 311)"): K-04 v1's core part and
// the domain parts, each at its frozen versions (people-access v1 and its v1.1 addition). A slot also carries its own
// audience in K-03 v1 (slots.json). The claim check takes the narrowest of the slot's audience and the audience of every
// field it reads; a field no table list names, or an audience that cannot be read, is never shown (fail closed).
//
// SLOT_FIELDS names the fields where K-03's `reads` names a record field a table list holds. The other slots read no
// column, and their K-03 audience alone governs them: the record's named slots (the bundle's record rows: K-01
// record.slots; the slots inside a row are claimed with it), amounts from the flow's amount table (the bundle) or the
// record's ledger rules, 'today' and 'tomorrow' (the send time), the links code makes for the reader, the pending
// choice a read-back states (K-02 fields), a question's deadline and a relayed person's words. Two of those read a column
// that K-04 v1 marks never, and are left unbound on purpose (defaults, for ops/QUESTIONS.md):
//   - ask.by reads the question's clock row, whose due_at K-04 v1 marks never, while RULES 4.2 and arch 07 line 409
//     require every message that starts a clock to state its deadline: the raw row is never shown, the deadline is.
//   - relay.quote reads a message's words, which K-04 v1 marks never (messages.words, the message log; sealed under
//     CQ-54's default), while A7-12 relays a person's own words: RULES 4.5's rule for them applies instead (private or
//     unsure: the secure page).

import availability from "../../../../contracts/db-schema/availability/availability.v1.tables.json";
import bookingsChanges from "../../../../contracts/db-schema/bookings-changes/bookings-changes.v1.tables.json";
import businessSetup from "../../../../contracts/db-schema/business-setup/business-setup.v1.tables.json";
import conversationsConsent from "../../../../contracts/db-schema/conversations-consent/conversations-consent.v1.tables.json";
import core from "../../../../contracts/db-schema/core/core.v1.tables.json";
import customers from "../../../../contracts/db-schema/customers/customers.v1.tables.json";
import documentsLicenses from "../../../../contracts/db-schema/documents-licenses/documents-licenses.v1.tables.json";
import kindsOfWork from "../../../../contracts/db-schema/kinds-of-work/kinds-of-work.v1.tables.json";
import money from "../../../../contracts/db-schema/money/money.v1.tables.json";
import notifications from "../../../../contracts/db-schema/notifications/notifications.v1.tables.json";
import peopleAccessV1 from "../../../../contracts/db-schema/people-access/people-access.v1.tables.json";
import peopleAccessV11 from "../../../../contracts/db-schema/people-access/people-access.v1.1.tables.json";
import platformBilling from "../../../../contracts/db-schema/platform-billing/platform-billing.v1.tables.json";
import platformReview from "../../../../contracts/db-schema/platform-review/platform-review.v1.tables.json";
import rules from "../../../../contracts/db-schema/rules/rules.v1.tables.json";
import safetyIncidents from "../../../../contracts/db-schema/safety-incidents/safety-incidents.v1.tables.json";
import servicesPrices from "../../../../contracts/db-schema/services-prices/services-prices.v1.tables.json";
import slotsJson from "../../../../contracts/message-plan/fixtures/slots.json";
import { type SlotName } from "../slots";
import { slotAudience, tableAudience, type FieldAudience } from "./audience";

/** The frozen table lists the claim check reads, each as its file holds it (K-04 v1 and the domain parts). */
export const TABLE_LISTS: readonly unknown[] = [
  core,
  availability,
  bookingsChanges,
  businessSetup,
  conversationsConsent,
  customers,
  documentsLicenses,
  kindsOfWork,
  money,
  notifications,
  peopleAccessV1,
  peopleAccessV11,
  platformBilling,
  platformReview,
  rules,
  safetyIncidents,
  servicesPrices,
];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function itemsOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** One column of a table list: its field name and its audience, null when the audience cannot be read. */
export interface ListedField {
  readonly field: string;
  readonly audience: FieldAudience | null;
}

/** Every column of a table list, by field name (part.table.column); a column whose names cannot be read is skipped. */
export function fieldsOf(list: unknown): ListedField[] {
  if (!isRecord(list) || typeof list.part !== "string") return [];
  const part = list.part;
  const out: ListedField[] = [];
  for (const table of itemsOf(list.tables)) {
    if (!isRecord(table) || typeof table.name !== "string") continue;
    const tableName = table.name;
    for (const column of itemsOf(table.columns)) {
      if (!isRecord(column) || typeof column.name !== "string") continue;
      out.push({ field: `${part}.${tableName}.${column.name}`, audience: tableAudience(column.audience) });
    }
  }
  return out;
}

function sameAudience(a: FieldAudience | null, b: FieldAudience | null): boolean {
  if (a === null || b === null) return false;
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.length === b.length && a.every((reader) => b.includes(reader));
}

function fieldAudiences(lists: readonly unknown[]): ReadonlyMap<string, FieldAudience | null> {
  const audiences = new Map<string, FieldAudience | null>();
  for (const list of lists) {
    for (const { field, audience } of fieldsOf(list)) {
      const known = audiences.get(field);
      // A field two lists give different audiences is not read (fail closed); a minor version only adds (BP 6.4).
      audiences.set(field, known === undefined || sameAudience(known, audience) ? audience : null);
    }
  }
  return audiences;
}

/** Each field of the frozen table lists and its audience (null when it cannot be read). */
export const FIELD_AUDIENCES: ReadonlyMap<string, FieldAudience | null> = fieldAudiences(TABLE_LISTS);

/** A field's audience by its name (part.table.column), or null when no table list names it or it cannot be read. */
export function fieldAudience(field: string): FieldAudience | null {
  return FIELD_AUDIENCES.get(field) ?? null;
}

function slotAudiences(vocabulary: unknown): ReadonlyMap<string, FieldAudience | null> {
  const audiences = new Map<string, FieldAudience | null>();
  if (!isRecord(vocabulary)) return audiences;
  for (const slot of itemsOf(vocabulary.slots)) {
    if (!isRecord(slot) || typeof slot.name !== "string") continue;
    audiences.set(slot.name, audiences.has(slot.name) ? null : slotAudience(slot.audience));
  }
  return audiences;
}

/** Each slot's own audience, as K-03 v1's slots.json gives it (null when it cannot be read). */
export const SLOT_AUDIENCES: ReadonlyMap<string, FieldAudience | null> = slotAudiences(slotsJson);

/** A slot's own K-03 audience, or null when slots.json gives none it can read. */
export function slotAudienceOf(slot: SlotName): FieldAudience | null {
  return SLOT_AUDIENCES.get(slot) ?? null;
}

const NONE: readonly string[] = [];

/** The time a visit starts and how long it runs (K-04 v1 reservations.during: the visit's reservation). */
const VISIT_TIME = "core.reservations.during";
const PERSON_NAME = "core.persons.name";
const SERVICE_NAME = "services-prices.services.name";
const ARRIVAL_WINDOW = "bookings-changes.booking_visits.arrival_window";

/**
 * The fields each slot's value is read from, by default (K-03 v1 slots.json `reads`). A caller that read another field
 * names it in the claim context (ClaimContext.fields): visit.place reads the business's location in flow A and the visit
 * address in flow B, so with neither named it takes both, and the visit address keeps it on the secure page.
 */
export const SLOT_FIELDS: Readonly<Record<SlotName, readonly string[]>> = {
  // The record's 16 named slots: the bundle's record rows (K-01 record.slots), claimed with the slots inside them.
  "pay.asks": NONE,
  "pay.price": NONE,
  "pay.took": NONE,
  "pay.left": NONE,
  "pay.cancel": NONE,
  "pay.late": NONE,
  "pay.noshow": NONE,
  "pay.back": NONE,
  "pay.after": NONE,
  "pay.staff": NONE,
  "pay.failed": NONE,
  "clock.pay": NONE,
  "two.count": NONE,
  "reach.way": NONE,
  "reach.to": NONE,
  "who.ok": NONE,

  // The auto-fill slots (SPEC-master 5h).
  "alex.staff": [PERSON_NAME], // the booking's customer name
  "name.staff": [PERSON_NAME], // the named person's name
  "svc.intext": [SERVICE_NAME], // the booking's service name
  arrive: [ARRIVAL_WINDOW, "business-setup.flow_defaults.arrive", VISIT_TIME], // the window, or a set start (D48)
  window: [ARRIVAL_WINDOW, VISIT_TIME],
  cutoff: ["bookings-changes.booking_visits.cutoff_at"], // the visit's free-cancel cutoff, by the business's rule
  day: [VISIT_TIME], // the visit's start
  keep: NONE, // its own words, or the ledger's keep

  // The amounts on the money path: the flow's amount table (K-01 tradeMoney); name is the booked service's name.
  price: NONE,
  fee: NONE,
  deposit: NONE,
  rest: NONE,
  paid: NONE,
  name: [SERVICE_NAME],

  // The ledger amounts: the record's ledger rules.
  paidnow: NONE,
  due: NONE,
  back: NONE,
  later: NONE,
  backlate: NONE,

  // Filled at send: the send time in the reader's zone.
  today: NONE,
  tomorrow: NONE,

  // The links code makes for this reader (CQ-17's proposed names).
  "link.secure": NONE,
  "link.pay": NONE,
  "link.chat": NONE,
  "link.chatqr": NONE,

  // The slots the compiler makes from sample values (CQ-17's proposed names).
  "biz.name": ["core.businesses.name", "core.businesses.display_name"],
  "biz.phone": ["business-setup.business_setup.listing_phone"],
  "owner.name": [PERSON_NAME],
  "pro.name": [PERSON_NAME],
  "visit.time": [VISIT_TIME],
  "visit.place": ["business-setup.locations.address", "bookings-changes.booking_addresses.address"],
  "visit.code": ["bookings-changes.booking_visits.check_in_code"],
  "ask.by": NONE,
  "change.when": NONE,
  "change.price": NONE,
  "relay.quote": NONE,
};

/**
 * The slot that holds a relayed person's own words (arch 07 line 359; A7-12). RULES 4.5: they reach a reader "only with
 * nothing private in them; else 'Read it on the secure page.' When unsure, treat it as private." Under the sensitive
 * switch they are the reason, which only the secure page shows (RULES 4.6; S13-22): a person's own words may say why
 * they come, and no slot of K-03 v1 holds the reason otherwise (default).
 */
export const QUOTE_SLOT: SlotName = "relay.quote";
