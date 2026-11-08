// Test sources for the slot filler: the master's sample cast (SPEC-master 6: Sam, Lee's Barbershop, Alex M., Riley,
// Ben T., the $35 haircut, check-in code 5160, 88 Elm St, Springfield; the visit Sat Oct 24, 2026, 11:00am), never a
// real person (rule 9). The record's rows are K-01 v1's, read from contracts/bundle/fixtures/bundle-mini-a.json.

import bundleMiniA from "../../../../contracts/bundle/fixtures/bundle-mini-a.json";
import type { RecordReading, SlotRow } from "./record";
import type { Money, SlotSource, Time } from "./types";
import { RECORD_SLOT_NAMES, type RecordSlotName } from "./vocabulary";

/** Lee's Barbershop's zone (K-04 seed-business-head.json). */
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

/**
 * A6-14's booking (flow A, the main path list|card|counter): a card saved for the $20 fee, nothing paid now, $35 due
 * at the chair. Its record values: card, keep (the fee the saved card covers), rest (something is left to pay) and
 * written (the booking is written).
 */
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

/** Every fact of the sample cast, filled at 10:00am on Tue Oct 20, 2026 in the shop's zone. */
export function sampleSource(): SlotSource {
  return {
    filledAt: "2026-10-20T14:00:00Z",
    zones: { visit: ZONE, business: ZONE },
    channel: "imessage",
    sensitive: false,
    record: CARD_COUNTER,
    facts: {
      business: {
        name: "Lee's Barbershop",
        displayName: "Lee's",
        phone: "+15555550177",
        ownerName: "Sam",
      },
      customerName: "Alex M.",
      otherName: "Ben T.",
      proName: "Riley",
      serviceName: "Haircut",
      visit: {
        start: at("2026-10-24T15:00:00Z"),
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

/** A source with no facts and no record: every slot the filler fills from a fact stays unfilled. */
export function emptySource(): SlotSource {
  return {
    filledAt: "2026-10-20T14:00:00Z",
    zones: { visit: null, business: ZONE },
    channel: "imessage",
    sensitive: false,
    record: null,
    facts: {},
  };
}
