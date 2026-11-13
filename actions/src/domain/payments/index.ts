// The payments and ledger service (T-763; C-101; S13-55; RULES 3.1 to 3.14): a booking's money step turned into exactly one
// Stripe effect row with its key (a card save, a deposit or the full price, on the business's own account), the money rows
// that ride the turn's one commit, pay links, and the append-only ledger; never a hold, never a charge without a committed
// exact yes bound to that booking, never two charges for one booking in one turn. See service.ts, rows.ts, yes.ts,
// turn.ts and ledger.ts.

export { PaymentRefusedError, type PaymentRefusal } from "./errors";
export {
  appendLine,
  appendTo,
  chargeLine,
  chargeLineId,
  takenFromEvent,
  type ChargeTaken,
  type LedgerLine,
  type LedgerPayment,
  type StripeEvent,
} from "./ledger";
export {
  MAX_KEY_LENGTH,
  accountOf,
  checkEffect,
  claimedRowOf,
  descriptionOf,
  effectNewOf,
  isId,
  rowId,
  withMoney,
} from "./rows";
export {
  createPayments,
  isPaymentRefusal,
  type ChargeInput,
  type LineRead,
  type PayLinkInput,
  type Payments,
  type SaveCardInput,
} from "./service";
export { CHARGE_KINDS, TurnCharges, checkTurnCharges, isChargeKind, type EffectOfTurn } from "./turn";
export {
  BOOKING_PURPOSES,
  type Booking,
  type BookingLine,
  type BookingPurpose,
  type BusinessAccount,
  type Card,
  type CardSave,
  type ChargePort,
  type ExactYes,
  type GivenVia,
  type MoneyEffect,
  type MoneyEffectKind,
  type MoneyStep,
  type MoneyStepInput,
  type MoneyWay,
  type MoneyWrites,
  type PayLinkAsked,
  type PayLinkCodes,
  type PayLinkPort,
  type PayingBusiness,
  type PaymentAsked,
  type PaymentItem,
  type PaymentsDeps,
  type SaveCardPort,
  type SavedCard,
  type Share,
  type StripePurpose,
} from "./types";
export { requireBoundYes, yesBinds, yesRefusal } from "./yes";
