// The effect kinds and the port each one runs through (C-109, T-323): K-07 v1's effectKind and effectRow.port, the table
// the effects runner (./runner) reads to call each kind's port, and the seam each kind's own task fills.
//
// An effect is one write, message, charge, refund or clock a choice causes; code runs it and the model never names it
// (arch 01 line 77). Stripe and calendar calls run from the effect rows the commit wrote (arch 10 line 508; tour line 420:
// "Charges, refunds and calendar updates run after the save, from rows it wrote, once each").
//
// Each kind runs through one port (K-07 v1 effectRow.port; its table list's effects_port_matches_kind): Stripe's six kinds
// through K-14, the calendar's three through K-16 and Linq's contacts/add through K-11 (CQ-04). Each kind's effectRun span
// names the port contract's call (K-08 v1 `call`: "the port call by its port contract's name"), as the call tables of
// K-14, K-16 and K-11 tie each call to its K-07 kind: saveCard, charge (stripe_charge and rosfield_monthly_charge), payLink,
// refund and disputeEvidence; calendarWrite, calendarUpdate and calendarDelete; contactAdd.
//
// What a kind sends is its own task's, each implementing KindPort in its own folder: contacts/add T-324
// (effects/contact-add), Stripe T-326 (effects/stripe), calendars T-327 (effects/calendar). A kind with no port given is
// never run: the runner claims only the rows of the ports whose every kind has one (servedPorts), so a row waits pending
// until its kind is built rather than being tried by a runner that cannot run it.

import type * as K05 from "../../../contracts/generated/data-access/data-access.v1.1";
import type { Provider } from "../../../runtime/src/trace";

/** K-07 v1 effectKind (outbox-effects.v1.schema.json), as K-05 v1.1 carries it. */
export type EffectKind = K05.EffectKind;
/** One effect row as it stands (K-07 v1 effectRow, as K-05 v1.1 claimEffects returns it). */
export type EffectRow = K05.EffectRow;
/** The port an effect runs through: stripe (K-14), calendar (K-16) or linq (K-11) (K-07 v1 effectRow.port). */
export type EffectPortName = EffectRow["port"];

/** What one kind is: the port it runs through and the port contract's call its span names. */
export interface KindInfo {
  readonly port: EffectPortName;
  readonly call: string;
}

/** Every K-07 v1 effect kind, with its port and its call (K-07 effects_port_matches_kind; K-14, K-16, K-11 call tables). */
export const EFFECT_KINDS: Readonly<Record<EffectKind, KindInfo>> = {
  stripe_save_card: { port: "stripe", call: "saveCard" },
  stripe_charge: { port: "stripe", call: "charge" },
  stripe_refund: { port: "stripe", call: "refund" },
  stripe_pay_link: { port: "stripe", call: "payLink" },
  stripe_dispute_evidence: { port: "stripe", call: "disputeEvidence" },
  rosfield_monthly_charge: { port: "stripe", call: "charge" },
  calendar_write: { port: "calendar", call: "calendarWrite" },
  calendar_update: { port: "calendar", call: "calendarUpdate" },
  calendar_delete: { port: "calendar", call: "calendarDelete" },
  linq_contact_add: { port: "linq", call: "contactAdd" },
};

/** The three ports, in K-07 v1's order. */
export const EFFECT_PORTS: readonly EffectPortName[] = ["stripe", "calendar", "linq"];

/** True for a K-07 v1 effect kind. */
export function isEffectKind(value: unknown): value is EffectKind {
  return typeof value === "string" && Object.hasOwn(EFFECT_KINDS, value);
}

/** The kinds that run through one port, in K-07 v1's order. */
export function kindsOf(port: EffectPortName): EffectKind[] {
  return (Object.keys(EFFECT_KINDS) as EffectKind[]).filter((kind) => EFFECT_KINDS[kind].port === port);
}

/**
 * The outside service an effect row's span names (K-08 v1 `provider`): stripe, linq, or the calendar's own, google or
 * microsoft (K-07 v1 effectRow.calendarProvider). Null when the row does not say which calendar, which K-07 v1's schema
 * refuses and its table's CHECK lets through (QUESTIONS.md CQ-76): such a row is never run.
 */
export function providerOf(row: Pick<EffectRow, "port" | "calendarProvider">): Provider | null {
  if (row.port === "stripe") return "stripe";
  if (row.port === "linq") return "linq";
  if (row.calendarProvider === "google") return "google_calendar";
  if (row.calendarProvider === "microsoft") return "microsoft_calendar";
  return null;
}

/** What a kind's port is given for one try. */
export interface KindCall {
  /** The effect row as claimed: its portRequest is the request in the port's terms (K-07 v1). */
  readonly effect: EffectRow;
  /** The row's one idempotency key, sent with every try of every run (arch 10 line 542). */
  readonly idempotencyKey: string;
  /** The try in this run, from 1 to 5 (K-08 v1 `attempt`). */
  readonly attempt: number;
  /** When the port must have answered (UTC): the runner stops waiting then and counts the try a network error. */
  readonly answerBy: string;
  /** Aborted when the runner stops waiting, so the port can let its call go. */
  readonly signal: AbortSignal;
}

/** The provider did it: its id of what it made or changed, and the ledger line, when there is one (K-05 v1.1 ok). */
export interface KindOk {
  readonly outcome: "ok";
  readonly providerObjectId: string | null;
  readonly ledgerLineId: string | null;
}

/** A card decline: recorded once, never tried again (arch 10 line 542; RULES 3.11; K-05 v1.1 declined). */
export interface KindDeclined {
  readonly outcome: "declined";
  readonly errorCode: string;
}

/** The network or the provider failed: tried again on the same key (K-05 v1.1 networkError), sooner on a shorter Retry-After. */
export interface KindNetworkError {
  readonly outcome: "networkError";
  readonly errorCode: string;
  /** The provider's Retry-After in milliseconds, or null when it gave none. */
  readonly retryAfterMs: number | null;
}

/** One try's answer, in K-05 v1.1 recordEffectResult's three outcomes. */
export type KindAnswer = KindOk | KindDeclined | KindNetworkError;

/** One kind's port: one try of one effect row, on the row's one idempotency key. */
export interface KindPort {
  run(call: KindCall): Promise<KindAnswer>;
}

/** The ports given to a runner, by kind; a kind left out is not built yet. */
export type KindPorts = Partial<Readonly<Record<EffectKind, KindPort>>>;

/** The ports whose every kind has a port in `ports`, in K-07 v1's order: the only ports a runner claims rows of. */
export function servedPorts(ports: KindPorts): EffectPortName[] {
  return EFFECT_PORTS.filter((port) => kindsOf(port).every((kind) => ports[kind] !== undefined));
}
