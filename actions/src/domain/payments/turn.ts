// One charge per booking per turn (C-101, T-763; S12-26: "a customer pays only what they agreed to, once"; RULES 3.2: all
// that is due now is one payment, on one card). A turn's one commit (C-087, T-305) carries every unit's effect rows; two
// that take a booking's money (a charge, or a pay link, each a payment) in the same turn are refused before anything is
// written, so a booking is never charged twice by one turn: two parts that each reach the money step, a step that runs
// twice, or a charge and a pay link side by side.
//
// The service refuses a second charge it is asked for itself (service.ts); checkTurnCharges holds the whole turn, every
// unit's effects together, since two parts may each have their own service.

import { refuse } from "./errors";

/** The effect kinds that take a booking's money: each makes one payment (K-32 payments_stripe_runs_from_effect). */
export const CHARGE_KINDS: readonly string[] = ["stripe_charge", "stripe_pay_link"];

/** Whether an effect row takes a booking's money. */
export function isChargeKind(kind: unknown): boolean {
  return typeof kind === "string" && CHARGE_KINDS.includes(kind);
}

/** An effect row as the turn's check reads it: a K-05 v1.1 effectNew, or the service's own MoneyEffect. */
export interface EffectOfTurn {
  readonly kind?: unknown;
  readonly bookingId?: unknown;
}

/**
 * Refuses a turn whose effect rows charge one booking twice: two charge or pay link rows naming the same booking. Each
 * booking's one charge passes, as does every other effect (a card save, a calendar write).
 */
export function checkTurnCharges(effects: readonly EffectOfTurn[]): void {
  const charged = new Set<string>();
  for (const effect of effects) {
    if (!isChargeKind(effect.kind)) continue;
    const bookingId = effect.bookingId;
    if (typeof bookingId !== "string" || bookingId.length === 0) refuse("badInput", ["bookingId"]);
    if (charged.has(bookingId)) refuse("secondChargeInTurn", ["bookingId"]);
    charged.add(bookingId);
  }
}

/** One turn's ledger of the bookings it has charged: a second charge for one booking in the turn is refused. */
export class TurnCharges {
  readonly #turnId: string;
  readonly #charged = new Set<string>();

  constructor(turnId: string) {
    this.#turnId = turnId;
  }

  get turnId(): string {
    return this.#turnId;
  }

  /** Whether the booking was charged in this turn. */
  has(bookingId: string): boolean {
    return this.#charged.has(bookingId);
  }

  /** Refuses a second charge for the booking in this turn, without marking it. */
  check(bookingId: string): void {
    if (this.#charged.has(bookingId)) refuse("secondChargeInTurn", ["bookingId"]);
  }

  /** Marks the booking charged in this turn, once its charge is built. */
  mark(bookingId: string): void {
    this.check(bookingId);
    this.#charged.add(bookingId);
  }
}
