// Why the payments and ledger service refuses (C-101, T-763). A refusal writes nothing: the call that asked fails closed,
// so the turn commits no money row (arch 10 line 508). Its message and fields hold labels and field names only, never an
// amount, an id's value, a card's ids, a name or words (K-08 v1 README line 75).

/** Why a money row was refused: a label. */
export type PaymentRefusal =
  /** No exact yes was given (RULES 3.6; BP section 0: no charge without a clear yes tied to that booking). */
  | "noYes"
  /** The yes is not recorded as answered by a commit: waiting, open, defaulted, withdrawn, or never passed the gate. */
  | "yesNotCommitted"
  /** The yes answered a read-back about another booking, or about none. */
  | "yesNotThatBooking"
  /** The yes answered a read-back about another business, or about none. */
  | "yesNotThatBusiness"
  /** The yes is not the booker's own: a relayed yes never counts (RULES 3.6, 3.13). */
  | "yesNotTheirOwn"
  /** A second charge or pay link for one booking in one turn (S12-26: a customer pays only what they agreed to, once). */
  | "secondChargeInTurn"
  /** A hold, an authorization or a later capture asked for in any form: nothing is ever held on a card (RULES 3.2; D65). */
  | "hold"
  /** The booking is not the call's business's: money lands only in the business's own Stripe (RULES 3.1). */
  | "otherBusiness"
  /** An amount a way names that the booking does not carry: never guessed (S13-55; RULES 3.14). */
  | "amountNotKnown"
  /** A charge or pay link for nothing: at least one cent, in the booking's currency. */
  | "nothingDue"
  /** Money now with no card from the page: no card that works (A5-31). */
  | "noCard"
  /** A way that keeps the card (a deposit: A5-13 "the card stays saved") charged on a card not saved for the booking. */
  | "cardNotKept"
  /** The card is not one this charge may go on: removed, replaced by the network, another booking's, or another person's. */
  | "cardNotUsable"
  /** A field that is not the shape K-32, K-14 or K-07 takes: an empty id, a decimal amount, an unknown purpose. */
  | "badInput"
  /** A built effect row the effects runner would refuse (K-14 v1 portRequest; T-326's buildStripeRequest). */
  | "notStripeRequest"
  /** A row id or key past K-14's limits (an idempotency key of at most 255 characters). */
  | "idTooLong"
  /** A pay link with no port to make its code, or a code that is not K-32's form. */
  | "noPayLinkCode"
  /** A ledger line changed: lines are never edited, a refund is a new line (arch 09 line 492). */
  | "ledgerEdit"
  /** A second charge line for one payment, or for one Stripe object (K-32 ledger_lines_payment_charge_key). */
  | "ledgerTwice"
  /** A charge's result that does not match its payment: another effect, payment, amount or currency. */
  | "ledgerMismatch";

/** A money row refused: nothing is written. Names the reason and the fields at fault, never a value. */
export class PaymentRefusedError extends Error {
  override name = "PaymentRefusedError";
  readonly reason: PaymentRefusal;
  readonly fields: readonly string[];

  constructor(reason: PaymentRefusal, fields: readonly string[] = []) {
    super(
      fields.length === 0
        ? `payment refused: ${reason}`
        : `payment refused: ${reason} (${fields.join(", ")})`,
    );
    this.reason = reason;
    this.fields = [...fields];
  }
}

/** Throws the refusal. */
export function refuse(reason: PaymentRefusal, fields: readonly string[] = []): never {
  throw new PaymentRefusedError(reason, fields);
}
