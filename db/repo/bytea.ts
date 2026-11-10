// A bytea value in K-04's text form, turned into its bytes before postgres.js sees it (T-1185; T-1141 round 1's
// Need 3; DL-364).
//
// K-05 carries the value of a column that is not JSON as PostgreSQL text input, as K-04's seed fixtures write it
// (K-05 v1 stateWrite; K-04 core README, "Seed and refused-row fixtures": "a bytea as \x and hex"). postgres.js does
// not read that form: it sends a string bound to a bytea parameter as the hex of the string's own characters
// (postgres/src/types.js, bytea.serialize: '\\x' + Buffer.from(x).toString('hex')). So "\x01ab" would be stored as
// the six bytes of its text, and a sealed value stored that way never opens (sealing.ts finds no format byte:
// bad_format). A Uint8Array is sent as its own bytes. So a write turns each bytea value it is given in that form into
// a Uint8Array here, and refuses anything else, which is then never stored (the state writes of commit-turn.ts and
// clocks.ts).
//
// The form (T-1185 default 1): "\x", then two hex digits for each byte, in upper or lower case, and nothing else. No
// whitespace between the pairs (PostgreSQL's own input allows it, but K-04's fixtures and actions' byteaText never
// write it), no escape format, no other type (a number, a list, an object, or bytes already made). "\x" alone is zero
// bytes.
//
// Nothing here logs or names a value: a caller's refusal names the table and the column only.

/** K-04's text form of a bytea value: "\x" and whole pairs of hex digits, nothing before, between or after. */
const BYTEA_TEXT = /^\\x(?:[0-9A-Fa-f]{2})*$/;

/** The bytes of a bytea value in K-04's text form ("\x" and hex digit pairs), or null when `value` is not that form. */
export function byteaFromText(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !BYTEA_TEXT.test(value)) {
    return null;
  }
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const at = 2 + 2 * index;
    bytes[index] = Number.parseInt(value.slice(at, at + 2), 16);
  }
  return bytes;
}
