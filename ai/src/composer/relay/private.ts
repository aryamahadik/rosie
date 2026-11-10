// Private words reach the model only as "a private detail" (T-375, C-118; arch 07 line 397: <conversation> is "redacted
// as <inbound> is", and <inbound> comes "only in a reply to its sender, redacted words as 'a private detail' (RULES
// 4.5)"; K-03 conversationMessage.text and inbound.text: "with private words given as 'a private detail'").
//
// The row read gives a person's words redacted (K-09's compose input; decide's redact verb names the words, K-02), and
// the composer gives what the model reads the same way, whatever reaches it: the edge scrub's tags, "[card number]" for
// a card number and "[SSN]" for a Social Security number (K-06 v1 default 1; the gateway's scrub, T-242 and T-1070),
// read "a private detail" too, since a card number is a money detail beyond an amount and a Social Security number an
// ID number, both private (RULES 4.5; S13-28 rule 42). It does so in the three places a person's own words reach the
// model: <conversation>, <inbound> and a relay's quote (the relay.quote fact). Nothing else of them changes, and the
// row's input itself is never changed: only what the model reads (../prompt/render.ts).

import { CARD_TAG, SSN_TAG } from "../../../../runtime/src/scrub/scrub";

/** How a private part of a person's words reads to the model (arch 07 line 397; RULES 4.5). */
export const PRIVATE_DETAIL = "a private detail";

/** The edge scrub's tags (K-06 v1 default 1), each a private part of a person's words. */
export const PRIVATE_TAGS: readonly string[] = Object.freeze([CARD_TAG, SSN_TAG]);

/** A person's words as the model reads them: each of the edge scrub's tags as "a private detail", the rest as it is. */
export function withPrivateDetails(text: string): string {
  return PRIVATE_TAGS.reduce((words, tag) => words.split(tag).join(PRIVATE_DETAIL), text);
}
