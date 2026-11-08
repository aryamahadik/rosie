// Money as a person reads it, always from whole cents with their currency (CQ-09: "money in integer cents with a
// currency code"; formats.v1 `money`). An amount the record does not hold in that form is never shown: a decimal, a
// string such as "$35", a currency that is not an ISO 4217 code, or an amount below zero is refused, so the slot stays
// unfilled and the Values check stops the message (arch 07 line 409).

import type { Money } from "./types";

/** An amount that cannot be shown: the slot that reads it stays unfilled. */
export class MoneyFormatError extends Error {
  override name = "MoneyFormatError";
}

const CURRENCY = /^[A-Z]{3}$/;

let known: ReadonlySet<string> | null = null;

/** The ISO 4217 codes the runtime's Intl knows (Node and the Workers runtime both carry full ICU data). */
function knownCurrencies(): ReadonlySet<string> {
  known ??= new Set(Intl.supportedValuesOf("currency"));
  return known;
}

/** How many minor-unit digits a currency has: 2 for USD and EUR, 0 for JPY, 3 for KWD. */
function minorDigits(currency: string): number {
  return (
    new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ??
    2
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An amount as a text shows it: $35 for 3500 USD, $12.50 for 1250 USD, $1,200.50, €35, ¥3,500 (whole amounts without
 * cents, as the master writes them: SPEC-master 5h; overlay-core.js amountText line 618). Throws MoneyFormatError for
 * anything but whole cents (a safe integer, zero or more) with a known three-letter currency code.
 */
export function formatMoney(money: Money): string {
  const value: unknown = money;
  if (!isRecord(value)) throw new MoneyFormatError("an amount must be { cents, currency } (CQ-09)");
  const { cents, currency } = value;
  if (typeof cents !== "number" || !Number.isSafeInteger(cents))
    throw new MoneyFormatError("an amount must be whole cents, never a decimal (CQ-09)");
  if (cents < 0) throw new MoneyFormatError("an amount a person reads is never below zero");
  if (typeof currency !== "string" || !CURRENCY.test(currency) || !knownCurrencies().has(currency))
    throw new MoneyFormatError("an amount needs its ISO 4217 currency code, such as USD (CQ-09)");
  const digits = minorDigits(currency);
  const unit = 10 ** digits;
  const whole = cents % unit === 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: whole ? 0 : digits,
    maximumFractionDigits: digits,
  }).format(cents / unit);
}
