// The contact home's module for the home registry (T-588 through T-586's createHomeRegistry; S13-30; S13-19).
//
// S13-30: a step points to a home by meaning, and where its words differ the home wins. A step's words reach the
// registry as claims, a point and a value per home, labels only (T-586 default 1); this module rules on the contact
// home's points from the message's contact reading (the person, the message and the bundle's S13-19 words), so a step
// that says it texts someone whose chat is not open, or messages a customer the business booked with no yes, gets the
// home's value, and the registry logs the difference by label. Its points:
//   - reachWay: "text" (into the chat the mobile opened), "email" or "none" (contact.ts: never SMS, never a call);
//   - replyClock: "onceReached" when the message goes their way, "never" when it reaches nobody (S13-19: "A reply clock
//     starts only once they were reached their way");
//   - handlingLine: "privateBooking" on an owner or staff message about a private booking, else "none" (S13-19: "Every
//     owner and staff message about a private booking carries one line"; its words: record.ts).

import { isLabel } from "../../../../runtime/src/trace";
import type { Reach } from "../../domain/messages-consent";
import type { HomeModule } from "../registry";
import { contactWay, type ContactMessage } from "./contact";
import { ContactHomeError, type ContactRecord } from "./record";

/** What the contact home rules by: one message to one person, and the contact home's part of the bundle's flow. */
export interface ContactReading {
  readonly person: Reach;
  readonly message: ContactMessage;
  readonly record: ContactRecord;
}

/** The context the registry hands the contact home's rule (beside the other homes' parts of one context). */
export interface ContactHomeContext {
  readonly contact: ContactReading;
}

/** The contact home's points, each a label (T-586: unique across the homes). */
export const CONTACT_POINTS = ["reachWay", "replyClock", "handlingLine"] as const;
export type ContactPoint = (typeof CONTACT_POINTS)[number];

/** The contact home's ruling on one point, a label. */
export function contactRule(point: string, context: ContactHomeContext): string {
  const { contact } = context as Partial<ContactHomeContext>;
  if (contact === undefined)
    throw new ContactHomeError("the contact home was asked to rule with no contact reading");
  const decision = contactWay(contact.person, contact.message, contact.record);
  if (point === "reachWay") return decision.way;
  if (point === "replyClock") return decision.replyClock;
  if (point === "handlingLine") return decision.handling?.line ?? "none";
  throw new ContactHomeError(
    `${isLabel(point) ? point : "the point given"} is not a point of the contact home`,
  );
}

/** The contact home's module, for createHomeRegistry({ flows, modules }): the S13-19 home (record.homes.contact). */
export function contactHome(): HomeModule<ContactHomeContext> {
  return { home: "contact", points: CONTACT_POINTS, rule: contactRule };
}
