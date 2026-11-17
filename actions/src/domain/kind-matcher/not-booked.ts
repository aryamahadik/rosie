// Work Rosie never books, as code reads it in one part of an owner's words (T-632; C-130). The sources say what it is,
// in these words, and nothing else is read:
//   RULES 1.4  "Services, not goods. Nothing is set up for goods with no visit, delivery only, renting a thing or space
//              alone, or work the law bars. Gift cards are out. Horse boarding is in; stall-only rental is out. Shooting
//              lane-only is out. Wellness rooms with staff are in."
//   S1-02      "Means 'Not a service we book': goods with no visit, delivery only, renting a thing alone, or work the law
//              bars." "Gift cards are never set up either."
//   S1-74      "That's goods with no visit, delivery only, renting a thing or space alone, or work the law bars." "Gift
//              cards are out too." Its reply: "Rosie books services with a visit, so it can't set this one up."
//
// So a part is not booked when its words say one of:
//   giftCards  gift cards ("gift card", "gift cards", "giftcards")
//   noVisit    there is no visit: the part ends "no visit" or "without a visit" ("goods with no visit")
//   only       goods, delivery, or a space, stall or lane, next to "only" ("delivery only", "stall-only rental",
//              "Shooting lane-only")
//   alone      renting, goods, a thing, a space, a stall or a lane, with "alone" ("renting a thing alone")
// A kind of work that only rents with a visit stays a kind: "party rentals" is Party rentals, and "party rentals only"
// names no space, stall or lane, so it is read as the kind. Horse boarding is Horse boarding, riding lessons and stables.
// "Work the law bars" has no words code can read: such a part gets no kind or one kind like any other, and a drafted kind
// stays offline until Rosie's team reviews it (S1-02's safe default; S1-74: "A person on Rosie's team sees it within 1
// business day, in case it was misread").

import { plainTokens } from "./words";

/** Why a part is work Rosie never books (the list above). */
export type NotBookedReason = "giftCards" | "noVisit" | "only" | "alone";

const GIFT_CARDS: ReadonlySet<string> = new Set(["giftcard", "giftcards"]);
const CARDS: ReadonlySet<string> = new Set(["card", "cards"]);
const NO: ReadonlySet<string> = new Set(["no", "without"]);
const VISIT: ReadonlySet<string> = new Set(["visit", "visits"]);

// RULES 1.4's things that are not a service with a visit, with their plurals and the -ing form.
const GOODS = ["goods"];
const DELIVERY = ["delivery", "deliveries", "delivering"];
const SPACES = ["space", "spaces", "stall", "stalls", "lane", "lanes"];
const RENTING = ["renting", "rent", "rents", "rental", "rentals"];
const THINGS = ["thing", "things"];

/** The words that are not booked next to "only" (RULES 1.4: "delivery only", "stall-only rental", "lane-only"). */
const ONLY_OF: ReadonlySet<string> = new Set([...GOODS, ...DELIVERY, ...SPACES]);
/** The words that are not booked with "alone" (RULES 1.4: "renting a thing or space alone"). */
const ALONE_OF: ReadonlySet<string> = new Set([...GOODS, ...RENTING, ...THINGS, ...SPACES]);

/** Why a part of an owner's words is work Rosie never books, or null when it is not (the list at the top). */
export function notBookedReason(part: string): NotBookedReason | null {
  const tokens = plainTokens(part);
  const at = (index: number): string => tokens[index] ?? "";
  const last = tokens.length - 1;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = at(index);
    if (GIFT_CARDS.has(token) || (token === "gift" && CARDS.has(at(index + 1)))) return "giftCards";
  }
  // "no visit" or "without a visit" ends the part.
  if (VISIT.has(at(last)) && (NO.has(at(last - 1)) || (at(last - 1) === "a" && NO.has(at(last - 2))))) {
    return "noVisit";
  }
  for (let index = 0; index < tokens.length; index += 1) {
    if (at(index) === "only" && (ONLY_OF.has(at(index - 1)) || ONLY_OF.has(at(index + 1)))) return "only";
  }
  if (tokens.includes("alone") && tokens.some((token) => ALONE_OF.has(token))) return "alone";
  return null;
}
