// K-21's named rule (T-060, v1.1): what one JSON Schema cannot state about the page entry's swap of card numbers
// and Social Security numbers in typed words. `npm run contracts:check` runs the rule a fixtures/index.json entry
// names ("rule") on a fixture that has already passed its schema (contracts/scripts/check-fixtures.mjs). At runtime
// the page entry's swap (C-074's page entry, before the safety read and before any write: arch 02 lines 109 and 133)
// makes it hold; this file is its statement in the contract. README "v1.1", default 39.
//
// A rule takes one payload and returns its problems, one line each; an empty list passes.
// Rules are only ever added: a later minor version adds a rule under a new name and never changes this one.

import { CARD_TAG, SSN_TAG, cardRunsInV1dot1, hasSsnV1dot1 } from "../inbound-event/inbound-event.rules.mjs";

/**
 * scrubbedPassedOn (K-21 v1.1): one pageWordsSwap, a typed field as the browser sent it (typed) and as the page entry
 * passes it on (passedOn). passedOn holds no card number and no Social Security number, read the wider way K-06 v1.1's
 * scrubbedV1dot1 reads them; where typed held one, passedOn holds its tag ([card number] or [SSN], K-06 v1 README
 * default 1); and where typed held none, passedOn is typed unchanged, since the swap changes nothing else. Sources:
 * arch 02 line 109 ("Before any write it swaps card numbers (13 to 19 digits, Luhn) and Social Security numbers for a
 * tag"); arch 02 line 133 ("card and SSN scrub before any write ... Secure pages and the agent API"); RULES lines 199
 * and 200 ("Never kept at all: full card numbers outside the card box, full Social Security numbers"); the security
 * reviewer's gap 1 on T-060 dc9295e; the lead's round 2 ruling 1 (DL-166).
 * @param {{ typed?: unknown, passedOn?: unknown }} swap
 * @returns {string[]}
 */
export function scrubbedPassedOn(swap) {
  const { typed, passedOn } = swap;
  if (typeof typed !== "string" || typeof passedOn !== "string")
    return ["typed and passedOn must both be words"];
  const problems = [];
  for (const count of cardRunsInV1dot1(passedOn)) {
    problems.push(
      `passedOn: holds a card number (a 13 to 19 digit Luhn window in a run of ${String(count)} digits); it must be ${CARD_TAG}`,
    );
  }
  if (hasSsnV1dot1(passedOn))
    problems.push(`passedOn: holds a Social Security number; it must be ${SSN_TAG}`);
  const typedCards = cardRunsInV1dot1(typed).length;
  const typedSsn = hasSsnV1dot1(typed);
  if (typedCards > 0 && !passedOn.includes(CARD_TAG)) {
    problems.push(`passedOn: typed holds a card number, so passedOn must hold ${CARD_TAG} in its place`);
  }
  if (typedSsn && !passedOn.includes(SSN_TAG)) {
    problems.push(
      `passedOn: typed holds a Social Security number, so passedOn must hold ${SSN_TAG} in its place`,
    );
  }
  if (typedCards === 0 && !typedSsn && passedOn !== typed) {
    problems.push(
      "passedOn: typed holds no card number and no Social Security number, so passedOn must be typed unchanged",
    );
  }
  return problems;
}

/** The named rules fixtures/index.json may name. */
export const rules = Object.freeze({ scrubbedPassedOn });
