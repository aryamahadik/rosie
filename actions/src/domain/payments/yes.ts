// The hard invariant (BP section 0; RULES 3.6; S13-55): no charge without a clear yes tied to that booking. Every money row
// the service builds (a charge, a pay link, a booking's money step) first holds its yes here, and a yes that does not bind
// refuses the row before anything is built (C-101, T-763).
//
// A yes binds when it is:
//   - committed: recorded as the answer by a commit, this turn's (the gate passed the part as an exact yes, limit 3, and
//     its close rides the same commit as the money rows, so both land or neither) or an earlier one's (K-04
//     open_questions.status answered). A yes still waiting, open, defaulted or withdrawn binds nothing;
//   - bound to that booking: its read-back is about this booking and this business (limit 3 ties a money part to them);
//   - the booker's own: the person the read-back went to, who pays what is due at booking; the payer of the rest approves
//     nothing, and a yes relayed by anyone else never counts (RULES 3.6, 3.13).
//
// What the gate did is the caller's to say (answeredIn): this service is pure and reads no row. It is called only for a
// part the gate passed (T-305's writesOf) or with the answered question it read.

import type { Booking, ExactYes } from "./types";
import { refuse, type PaymentRefusal } from "./errors";

/** Why a yes does not bind this booking's money, or null when it does. */
export function yesRefusal(yes: ExactYes | null, booking: Booking): PaymentRefusal | null {
  if (yes === null) return "noYes";
  if (yes.answeredIn === null || yes.answeredIn.length === 0) return "yesNotCommitted";
  if (yes.businessId !== booking.businessId) return "yesNotThatBusiness";
  if (yes.bookingId !== booking.id) return "yesNotThatBooking";
  if (yes.personId !== booking.bookerPersonId) return "yesNotTheirOwn";
  return null;
}

/** Holds a money row to its yes: throws the refusal when the yes does not bind this booking. */
export function requireBoundYes(yes: ExactYes | null, booking: Booking): void {
  const why = yesRefusal(yes, booking);
  if (why !== null) refuse(why);
}

/** Whether the yes binds this booking's money. */
export function yesBinds(yes: ExactYes | null, booking: Booking): boolean {
  return yesRefusal(yes, booking) === null;
}
