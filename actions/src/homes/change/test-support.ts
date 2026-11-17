// Test sources for the change home, for the tests only.
//
// The booking heads are the frozen contracts' seeds as T-308's doubles read them (K-04 v1 seed-booking-head: Alex M.'s
// haircut at Lee's Barbershop, booked, flow A; T-308's own A4-25 son's kids cut and A7-81's death report), read through
// T-308's identity-and-access service (who decides the visit) and this home's readChangeBooking. The visit is the
// master's own: Alex's haircut with Riley on Sat Oct 24 at 11:00am, $35 (K-30 v1 seed-booking-flow-a; A7-17: "Sorry,
// Riley can't be in Saturday. Avery can come in early to do your visit, same time and price"), and Sun Nov 1 is the
// master's clock change (S13-03). Amounts are the master's (the $35 haircut, the $40 raise of S11-54, the $55 signature
// cut). No number, address or name is in any reading: ids, flags, times and amounts only (rule 9). The flows are fixture
// set v1's master flows as the merged bundle emitter compiles them (the home registry's emittedFlows).

import {
  BARBERSHOP,
  readerOf,
  seedRecord,
  servedFactsOf,
  withRows,
  type TestRecord,
} from "../../domain/identity-access/test-support";
import { createIdentityAccess, type ServedFacts } from "../../domain/identity-access";
import type { ChangeBooking, ChangeBookingRead, ChangeFacts, ChangeReading, StandIn } from "./change";
import { readChangeBooking, type ChangeHomeReads } from "./reads";

export {
  BARBERSHOP,
  DEATH_REPORTED,
  KIDS_CUT_FOR_SON,
  SON_WITH_ALEX_ON_FILE,
  WHO_FOR_NOT_ANSWERED,
  YOGA_STUDIO,
  seedRecord,
  withRows,
} from "../../domain/identity-access/test-support";

/** S13-56's first line, word for word (master-A.json and master-B.json S13-56 `does`). */
export const S13_56_DOES =
  "One path for every reason the business can't give a booked visit, and one path for someone who leaves.";

/** S13-56's lines the module rules by, word for word, as the bundle compiles them (both flows' S13-56 `more`). */
export const S13_56_RULES = [
  "Any reason counts: a pro can't come, the business is closed, a part is late, or a tool is out.",
  "Also the weather, too few booked, a removal or a quit, a license lapse, or the owner unable to act.",
  "The business offers another pro, only where the booking didn't name a person. Or another time, or a free cancel with everything back.",
  "First, any people-per-staff or two-adult rule is checked again for whoever is left.",
  "Another pro needs the skill (and any license the owner says it needs), at the same price or lower. A higher price needs the customer's yes.",
  "Never say why the pro is out.",
  "The one exception, a pro running late: 'No reply: the later start stands, and nothing else changes.'",
  "Never: a booking that named a person (a child's too), or someone in care, is moved to another person on silence:",
  "Sam calls them.",
  "The customer is reached their way (S13-19). The offer names the deadline: 7pm the day before, or 2 hours before for a visit today.",
  "Or the plug-in's shorter time.",
  "A customer not reached their way by then: the owner gets a named list to call. Not marked reached: Rosie's team calls.",
  "No answer by the deadline: called off, no fee, all paid goes back, after every channel is tried. Nothing moves on silence.",
  "On a job over several days, only that day is called off.",
  "The other visits, and the money for them, are never kept or refunded for one miss.",
  "A bare 'ok' picks nothing: ask once which.",
  "A crew, class seat, party or drop-off where nobody was named, with no one in care: the business staffs it.",
  "A job sent now whose pro can't come, and nobody takes it: called off with no fee, and everything paid is refunded.",
  "A booking with a need-by date: new times only before it. None fits: the owner is told at once, and the customer may cancel free.",
  "The owner can't act, and nobody else can: visits only the owner could give get a free cancel, with everything back.",
  "Rosie's team acts when the owner can't be reached in time (judgment rule 57).",
  "Someone leaves, by asking, by removal or by quitting: their last day is set, and their future bookings go to this path.",
  "Their access ends: sign-in, texts, day-list links and code views end at once, or at the set time.",
  "Their booked customers get the choices above. Customers stay with the business, never with the person.",
  "A business that closes: every future booking is called off with everything back, and each customer is told (S11-75).",
] as const;

/** K-04 v1 seed-booking-head: Alex M.'s haircut at Lee's Barbershop. */
export const HAIRCUT = "booking-alex-haircut";
/** K-04 v1 seed-booking-head: Alex M.'s workshop at the yoga studio. */
export const WORKSHOP = "booking-alex-workshop";

/** K-04 v1 seed-business-head: Lee's Barbershop's zone. */
export const SHOP_ZONE = "America/New_York";

/** The barbers (K-04 v1 seed-person-roles): Riley is out; Avery could stand in. */
export const RILEY = "person-riley";
export const AVERY = "person-avery";
export const SAM = "person-sam";
export const ALEX = "person-alex";

/** The master's amounts, in cents: the $35 haircut, S11-54's $40 raise, the $55 signature cut. */
export const USD_35 = { cents: 3500, currency: "USD" } as const;
export const USD_40 = { cents: 4000, currency: "USD" } as const;
export const USD_55 = { cents: 5500, currency: "USD" } as const;

/** The times the tests use, UTC (Lee's Barbershop is America/New_York: EDT until Sun Nov 1, 2:00am, EST after). */
export const T = {
  /** Sat Oct 24, 11:00am EDT: Alex's haircut with Riley. */
  visitSat11am: "2026-10-24T15:00:00Z",
  /** Wed Oct 21, 9:00am EDT. */
  wed9am: "2026-10-21T13:00:00Z",
  /** Fri Oct 23, 9:00am EDT: the day before. */
  fri9am: "2026-10-23T13:00:00Z",
  /** Fri Oct 23, 7:00pm EDT: 7pm the day before Saturday's visit. */
  fri7pm: "2026-10-23T23:00:00Z",
  /** Fri Oct 23, 8:30pm EDT: after 7pm the day before. */
  fri830pm: "2026-10-24T00:30:00Z",
  /** Fri Oct 23, 9:30pm EDT: an hour after 8:30pm. */
  fri930pm: "2026-10-24T01:30:00Z",
  /** Sat Oct 24, 7:30am EDT: the visit's own day. */
  sat730am: "2026-10-24T11:30:00Z",
  /** Sat Oct 24, 9:00am EDT: 2 hours before the 11:00am visit. */
  sat9am: "2026-10-24T13:00:00Z",
  /** Sat Oct 24, 10:30am EDT: half an hour before the visit. */
  sat1030am: "2026-10-24T14:30:00Z",
  /** Sat Oct 24, 3:00pm EDT: a later visit the same day. */
  visitSat3pm: "2026-10-24T19:00:00Z",
  /** Sat Oct 24, 1:00pm EDT: 2 hours before the 3:00pm visit. */
  sat1pm: "2026-10-24T17:00:00Z",
  /** Sat Oct 31, 9:00am EDT. */
  sat31_9am: "2026-10-31T13:00:00Z",
  /** Mon Nov 2, 10:00am EST: a visit after the clock change. */
  visitMonNov2: "2026-11-02T15:00:00Z",
  /** Sun Nov 1, 7:00pm EST: 7pm the day before Monday's visit, after the clocks fell back. */
  sunNov1_7pmEst: "2026-11-02T00:00:00Z",
} as const;

/** T-308's service and the K-04 head reader over a record, under one business's scope. */
export function readsOn(
  record: TestRecord,
  businessId: string,
  served: Readonly<Record<string, ServedFacts>> = {},
): ChangeHomeReads {
  const reader = readerOf(record);
  const access = createIdentityAccess({ businessId, reader, servedFacts: servedFactsOf(served) });
  return { bookingHead: (bookingId) => reader.bookingHead(bookingId), access };
}

/** A booking read through readChangeBooking, or a thrown error when the business has no such booking. */
export async function readBooking(reads: ChangeHomeReads, bookingId: string): Promise<ChangeBookingRead> {
  const read = await readChangeBooking(reads, bookingId);
  if (read === null) throw new Error(`no booking ${bookingId} at this business`);
  return read;
}

/** Alex's haircut with Riley, Sat 11:00am, $35: a visit that named nobody and serves nobody in care. */
export const HAIRCUT_FACTS: ChangeFacts = {
  proPersonId: RILEY,
  named: false,
  inCare: false,
  holds: "visit",
  staffRuleHolds: true,
  sentNow: false,
  needBy: null,
  visitStartsAt: T.visitSat11am,
  businessZone: SHOP_ZONE,
  visitAddressZone: null,
  price: USD_35,
};

/** Avery: free and said yes, with the skill, no license lacking, every staff rule holding, at the same $35. */
export const AVERY_SAME_PRICE: StandIn = {
  personId: AVERY,
  saidYes: true,
  skill: true,
  licenseLacking: false,
  staffRulesHold: true,
  price: USD_35,
};

/** A booking: a read head with the caller's facts, changed as given. */
export function bookingOf(read: ChangeBookingRead, facts: Partial<ChangeFacts> = {}): ChangeBooking {
  return { ...read, ...HAIRCUT_FACTS, ...facts };
}

/** A reading: the booking, a reason, the offer's time and the stand-ins (Avery by default). */
export function readingOf(
  booking: ChangeBooking,
  reason: ChangeReading["reason"],
  offeredAt: string = T.fri9am,
  standIns: readonly StandIn[] = [AVERY_SAME_PRICE],
): ChangeReading {
  return { booking, reason, offeredAt, standIns };
}

/** The seeds' record (K-04 v1 core with K-22's team), under Lee's Barbershop's scope. */
export function shopReads(served: Readonly<Record<string, ServedFacts>> = {}): ChangeHomeReads {
  return readsOn(seedRecord(), BARBERSHOP, served);
}

/** The record with a test's own booking heads beside the seeds. */
export function shopReadsWith(
  bookings: Parameters<typeof withRows>[1]["bookings"],
  served: Readonly<Record<string, ServedFacts>> = {},
): ChangeHomeReads {
  return readsOn(withRows(seedRecord(), { bookings: bookings ?? [] }), BARBERSHOP, served);
}
