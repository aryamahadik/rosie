// Test sources for the claim check, from the master's sample cast and fixture set v1's demo shops, never a real person
// (rule 9): Lee's Barbershop, Alex M. and Riley with the $35 haircut, check-in code 5160 and 88 Elm St, Springfield
// (SPEC-master 6; A7-12's relay "Can my son wait in the shop during my cut?"); the therapist demo shop Lee Associates,
// Alex M.'s first session with Maya on Sat Oct 24, 2026 at 11:00am (fixtures/v1/test-kit/shops/therapist.json). The
// record's rows are K-01 v1's, read from contracts/bundle/fixtures/bundle-mini-a.json.

import bundleMiniA from "../../../../contracts/bundle/fixtures/bundle-mini-a.json";
import {
  RECORD_SLOT_NAMES,
  type Money,
  type RecordReading,
  type SlotRow,
  type SlotSource,
  type Time,
} from "../slots";

type RecordSlotName = (typeof RECORD_SLOT_NAMES)[number];

/** Both shops' zone (K-04 seed-business-head.json). */
export const ZONE = "America/New_York";

export function at(utc: string, zone: string = ZONE): Time {
  return { utc, zone };
}

export function usd(cents: number): Money {
  return { cents, currency: "USD" };
}

/** Flow A's record slot rows, as K-01's bundle-mini-a.json holds them. */
export const RECORD_ROWS: Readonly<Partial<Record<RecordSlotName, readonly SlotRow[]>>> = Object.fromEntries(
  RECORD_SLOT_NAMES.map((name) => [name, bundleMiniA.flows.A.record.slots[name].rows]),
);

/** A6-14's booking (flow A, list|card|counter): a card saved, nothing paid now, $35 due at the chair. */
export const CARD_COUNTER: RecordReading = {
  price: "list",
  before: "card",
  after: "counter",
  booking: {},
  switches: [],
  facts: null,
  values: ["card", "keep", "rest", "written"],
  rows: RECORD_ROWS,
};

/** The visit both shops' samples use: Sat Oct 24, 2026, 11:00am in the shop's zone. */
const VISIT_START = at("2026-10-24T15:00:00Z");

/** Lee's Barbershop's facts for Alex M.'s haircut with Riley, filled at 10:00am on Tue Oct 20, 2026. */
export function barberSource(): SlotSource {
  return {
    filledAt: "2026-10-20T14:00:00Z",
    zones: { visit: ZONE, business: ZONE },
    channel: "imessage",
    sensitive: false,
    record: CARD_COUNTER,
    facts: {
      business: { name: "Lee's Barbershop", displayName: "Lee's", phone: "+15555550177", ownerName: "Sam" },
      customerName: "Alex M.",
      otherName: "Ben T.",
      proName: "Riley",
      serviceName: "Haircut",
      visit: {
        start: VISIT_START,
        arrival: { start: at("2026-10-24T12:00:00Z"), end: at("2026-10-24T14:00:00Z") },
        cutoff: at("2026-10-23T15:00:00Z"),
        place: "88 Elm St, Springfield",
        code: "5160",
      },
      amounts: { price: usd(3500), fee: usd(2000), deposit: usd(4000), rest: usd(10000), paid: usd(5500) },
      ledger: {
        paidnow: usd(4000),
        due: usd(3500),
        keep: usd(2000),
        back: usd(4000),
        later: usd(10000),
        backlate: usd(2000),
      },
      links: { secure: "rosfield.com/v/s03", pay: "rosfield.com/p/a2", chat: "rosfield.com/c/k7" },
      askBy: at("2026-10-24T13:00:00Z"),
      change: {
        when: { start: at("2026-10-29T18:00:00Z"), end: at("2026-10-29T21:00:00Z") },
        price: usd(4000),
      },
      relayQuote: "Can my son wait in the shop during my cut?",
    },
  };
}

/** The therapist demo shop's facts for Alex M.'s first session with Maya, with the sensitive switch on (RULES 4.6). */
export function therapistSource(): SlotSource {
  return {
    filledAt: "2026-10-20T14:00:00Z",
    zones: { visit: ZONE, business: ZONE },
    channel: "imessage",
    sensitive: true,
    record: CARD_COUNTER,
    facts: {
      business: { name: "Lee Associates", displayName: "Lee Associates", phone: "+15555550134" },
      customerName: "Alex M.",
      proName: "Maya",
      serviceName: "First session",
      visit: { start: VISIT_START, place: "123 Demo St, Anytown" },
      ledger: { due: usd(19000) },
      links: { secure: "rosfield.com/v/s03" },
      relayQuote: "Can I bring my partner to the session?",
    },
  };
}

/** Every value a sample source holds, as text: none may appear in a claim (claims carry no value). */
export function sampleValues(source: SlotSource): string[] {
  const { facts } = source;
  return [
    facts.business?.name,
    facts.business?.phone,
    facts.business?.ownerName,
    facts.customerName,
    facts.otherName,
    facts.proName,
    facts.serviceName,
    facts.visit?.place,
    facts.visit?.code,
    facts.links?.secure,
    facts.links?.pay,
    facts.links?.chat,
    facts.relayQuote,
  ].filter((value): value is string => value !== undefined);
}
