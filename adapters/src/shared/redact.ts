// What may never reach a log line, a span or a saved sample (K-08 v1: "never the raw number or words"; BP rule 7: no
// key in a log; rule 9: no real customer data in a test). One list of patterns, used by the span helper and the
// sample loader.

export type PrivateKind = "phone" | "email" | "key";

/** The word a value is replaced by. It is a valid K-08 label, so a redacted span still validates. */
export const REDACTED = "redacted";

// A phone number in E.164 form (K-04 phones_number_form), or any run of seven or more digits with phone punctuation
// (the K-08 safeId "reads as a number" test).
const PHONE_E164 = /\+[1-9][0-9]{6,14}/;
const PHONE_LOOSE = /(?<![0-9])\+?[0-9](?:[ ().-]?[0-9]){6,14}(?![0-9])/;
const EMAIL = /[^@\s]+@[^@\s]+[.][^@\s]+/;
// The shapes of the vendors' keys and of a bearer header: Stripe (sk_, pk_, rk_, whsec_), Resend (re_), Anthropic
// (sk-ant-), Google (AIza), and "Bearer <token>".
const KEY =
  /\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{6,}|whsec_[A-Za-z0-9]{6,}|re_[A-Za-z0-9_]{12,}|sk-ant-[A-Za-z0-9_-]{6,}|AIza[A-Za-z0-9_-]{20,})|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i;

/**
 * The first kind of private value found in `text`, or undefined when none is. `looseNumbers: false` skips the
 * digit-run test, which reads a date such as 2026-10-19 as a number: the whole-line guard uses it, the per-value
 * checks do not.
 */
export function findPrivateValue(
  text: string,
  options: { looseNumbers?: boolean } = {},
): PrivateKind | undefined {
  if (KEY.test(text)) return "key";
  if (EMAIL.test(text)) return "email";
  if (PHONE_E164.test(text) || (options.looseNumbers !== false && PHONE_LOOSE.test(text))) return "phone";
  return undefined;
}

/** Free text with every phone number, email address and key-shaped value replaced by "[redacted]". */
export function redactFreeText(text: string): string {
  const global = (pattern: RegExp): RegExp =>
    new RegExp(pattern.source, pattern.flags.replace("g", "") + "g");
  return [KEY, EMAIL, PHONE_E164, PHONE_LOOSE].reduce(
    (out, pattern) => out.replace(global(pattern), `[${REDACTED}]`),
    text,
  );
}

/** The schema's safeId: letters, digits and _ . : / # -, starting with a letter or digit, and not a run that reads as a number. */
export function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:/#-]*$/.test(value) && !/^[0-9().+ -]{7,}$/.test(value);
}

/** The value when it is a safeId that holds no key, else "redacted". */
export function safeIdOrRedacted(value: string): string {
  return isSafeId(value) && findPrivateValue(value) === undefined ? value : REDACTED;
}
