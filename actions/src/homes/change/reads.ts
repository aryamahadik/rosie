// What the change home reads (T-594): one booking's head (K-04 v1 bookings, T-186) and who decides its visit (T-308's
// identity-and-access service base), through the ports the caller hands in, bound to the call's business scope. No other
// read is made, and none by default. The rest of the reading (the visit's start and zone, the price copied in, the
// need-by date, who could stand in, and the facts no frozen call gives: whether the booking named its pro, someone in
// care, the stand-ins' skills) is the caller's, each fact not on record given as not known so the home fails closed
// (change.ts defaults 1 to 4).
//
// A booking of another business is never answered: the head must be the call's business's (T-308's own rule, kept here
// too, so a reader with no row-level security cannot widen an answer). The reading keeps ids, flags and labels only.

import type { IdentityAccess, IdentityReader } from "../../domain/identity-access";
import type { ChangeBookingRead } from "./change";
import { ChangeHomeError } from "./errors";

/** The reads the change home makes: T-308's port member for the K-04 v1 head, and T-308's who decides. */
export interface ChangeHomeReads {
  /** The booking's head row (K-04 v1 bookings; db/repo getBookingHead), or null: T-308's IdentityReader member. */
  readonly bookingHead: IdentityReader["bookingHead"];
  /** T-308's service for the call's business: its scope, and who decides a visit there. */
  readonly access: Pick<IdentityAccess, "businessId" | "whoDecides">;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Reads one booking of the call's business: its flow, stage and deceased flag from the K-04 v1 head, and who decides the
 * visit (T-308 whoDecides: the person served, or a minor's parents or guardians on file, or nobody, with why). Null when
 * the call's business has no such booking. Throws ChangeHomeError for a request that names no booking.
 */
export async function readChangeBooking(
  reads: ChangeHomeReads,
  bookingId: string,
): Promise<ChangeBookingRead | null> {
  const asked: unknown = bookingId;
  if (!isId(asked)) throw new ChangeHomeError("the request names no booking");
  const businessId = reads.access.businessId;
  const head = await reads.bookingHead(asked);
  if (head === null || head.id !== asked || head.businessId !== businessId) return null;
  const decides = await reads.access.whoDecides({ kind: "visit", bookingId: asked });
  return {
    bookingId: asked,
    businessId,
    flow: head.flow,
    stage: head.stage,
    deceased: head.deceased,
    decides,
  };
}
