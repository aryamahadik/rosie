// S1-09's lookup (T-635a; K-09 README default 202, as DL-1133's Fixes 3, 4 and 6 restate it), and the banned-word check
// (default 206, DL-1133's Fix 2): code alone, over the K-15 v1 port (T-434's double now, the real adapter once J-16 lands).
//
//   The fold    U+2018 and U+2019 become the apostrophe U+0027, U+201C and U+201D the quotation mark U+0022, before the
//               split, the search and the hold; nothing else changes (case, spaces and every other character as typed),
//               so an iPhone's "Lee’s" is split, searched and held as "Lee's".
//   The split   K-15 searches by name and town, both required, and S1-09's one `business` field holds one span, so code
//               splits it. A separator is a comma, or the word "in" standing alone (any case, no letter or digit next to
//               it). At most three tries, in this order: (1) the words before the first separator, and the words after it
//               up to the next comma (or the end); (2) the words before the last separator, and the words after it; (3)
//               the words before the first separator, and the words after the last. Each side is trimmed of spaces and of
//               a closing period and must hold a letter; a try with a side that does not, or with the same name and town
//               as an earlier try, is skipped. No try left is a name with no town (the settler's "ask").
//   The search  one K-15 search a try, {"by": "nameAndTown", "name", "town"}, with the try's words after the fold, in the
//               order above. The first try that holds a candidate decides and no later try is searched: one held
//               candidate is the match, two or more no match (twoListings). A try that holds none (noMatch, or no
//               candidate holds) goes on to the next; after the last, no match (noListing). A failed search on any try
//               (an error answer, an answer of no K-15 shape, or the port throwing) is placesUnavailable at once, and no
//               later try is searched. So a walk makes at most three searches, each for a pair no earlier try asked.
//   The hold    a candidate holds when every word of the try's name is a word of its name and every word of the try's
//               town is a word of its address, words as wordsOf gives them (actions/src/values/words.ts: each run of
//               letters and digits after foldWords, so case, accents and punctuation aside), in any order and not
//               necessarily next to each other, as limit 6 holds a text value to its words. Never holdsWords.
//   Banned      once a list is bound (no binding hands one in today: open gap 187), a word on it found in the one held
//               candidate's name or address, as whole words with case and punctuation aside, makes that candidate no
//               match (bannedWord). The words are read only for a held match, through the optional port the binding
//               hands in; a failed read leaves as it was thrown, never read as no word.
//
// Nothing here logs, and nothing it throws names the name, the town or a candidate's name, address, phone or website
// (K-15 README "No name, address, phone or words in a span or log"): the span's got and decided are the port's, and a
// refusal names its fault, the step and K-15's error code alone. The candidates are read here and never handed on: what
// the lookup answers holds the deciding try (the owner's own typed words) and no field of a candidate (default 204).

import type { ListingCandidate, PlacesPort, SearchOutcome } from "../../../../../adapters/src/places/double";
import { wordsOf } from "../../../values/words";
import { ListingRefusedError } from "./errors";

/** The K-15 v1 call S1-09's settler makes: search alone (T-434's PlacesPort, or the real adapter once J-16 lands). */
export type ListingSearch = Pick<PlacesPort, "search">;

/** One try: a name and a town, as typed with the four marks folded. */
export interface NameAndTown {
  readonly name: string;
  readonly town: string;
}

/** What the lookup found: the match, two held candidates, or none; each deciding answer with the try that decided. */
export type LookupFound =
  | { readonly found: "match"; readonly decidedBy: NameAndTown; readonly candidate: ListingCandidate }
  | { readonly found: "twoListings"; readonly decidedBy: NameAndTown }
  | { readonly found: "noListing" };

/** U+2018 and U+2019 to the apostrophe, U+201C and U+201D to the quotation mark; nothing else (DL-1133 Fix 4). */
export function foldMarks(words: string): string {
  return words.replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"');
}

/** Whether words hold a letter (a side of a try, or the details at all: default 201 (i)). */
export function holdsLetter(words: string): boolean {
  return /\p{L}/u.test(words);
}

/** A comma, or "in" standing alone: no letter or digit right before or after it, in any case. */
const SEPARATOR = /,|(?<![\p{L}\p{N}])in(?![\p{L}\p{N}])/giu;

interface Separator {
  readonly at: number;
  readonly end: number;
  readonly comma: boolean;
}

function separatorsOf(text: string): Separator[] {
  return [...text.matchAll(SEPARATOR)].map((found) => ({
    at: found.index,
    end: found.index + found[0].length,
    comma: found[0] === ",",
  }));
}

/** A side of a try, trimmed of spaces and of a closing period; null when it holds no letter. */
function sideOf(words: string): string | null {
  const trimmed = words.trim();
  const side = (trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed).trim();
  return holdsLetter(side) ? side : null;
}

/** The tries for folded words, at most three, in default 202's order, skipped ones left out; none for no separator. */
export function triesOf(folded: string): NameAndTown[] {
  const separators = separatorsOf(folded);
  const first = separators[0];
  const last = separators[separators.length - 1];
  if (first === undefined || last === undefined) return [];
  const nextComma = separators.find((each) => each.comma && each.at >= first.end);
  const asked: { readonly name: string; readonly town: string }[] = [
    { name: folded.slice(0, first.at), town: folded.slice(first.end, nextComma?.at ?? folded.length) },
    { name: folded.slice(0, last.at), town: folded.slice(last.end) },
    { name: folded.slice(0, first.at), town: folded.slice(last.end) },
  ];
  const tries: NameAndTown[] = [];
  for (const each of asked) {
    const name = sideOf(each.name);
    const town = sideOf(each.town);
    if (name === null || town === null) continue;
    if (tries.some((earlier) => earlier.name === name && earlier.town === town)) continue;
    tries.push({ name, town });
  }
  return tries;
}

/** Whether a candidate holds a try's words: each word of the name in its name, each of the town in its address. */
export function candidateHolds(
  candidate: Pick<ListingCandidate, "name" | "address">,
  attempt: NameAndTown,
): boolean {
  const named = new Set(wordsOf(candidate.name));
  const placed = new Set(wordsOf(candidate.address));
  return (
    wordsOf(attempt.name).every((word) => named.has(word)) &&
    wordsOf(attempt.town).every((word) => placed.has(word))
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A candidate as K-15 v1 gives it, as far as the hold reads it: a name and an address, each text. */
function isCandidate(value: unknown): value is ListingCandidate {
  return isRecord(value) && typeof value.name === "string" && typeof value.address === "string";
}

/**
 * The candidates one try's search found, or none (noMatch). Throws placesUnavailable on a K-15 error, on an answer of
 * no K-15 shape, or when the port throws: nothing is known about the listing then (K-15 README "Not found, no match and
 * errors"), so the call fails closed. The port's own error is not handed on, since a real adapter's may hold the words.
 */
async function searched(
  places: ListingSearch,
  attempt: NameAndTown,
  stepId: string,
): Promise<ListingCandidate[]> {
  let outcome: SearchOutcome;
  try {
    outcome = await places.search(
      { by: "nameAndTown", name: attempt.name, town: attempt.town },
      { step: stepId },
    );
  } catch {
    throw new ListingRefusedError("placesUnavailable", [stepId]);
  }
  const answer: unknown = outcome;
  if (!isRecord(answer)) throw new ListingRefusedError("placesUnavailable", [stepId]);
  if (typeof answer.error === "string")
    throw new ListingRefusedError("placesUnavailable", [stepId, answer.error]);
  if (answer.result === "noMatch") return [];
  const { candidates } = answer;
  if (answer.result !== "found" || !Array.isArray(candidates) || !candidates.every(isCandidate)) {
    throw new ListingRefusedError("placesUnavailable", [stepId]);
  }
  return candidates;
}

/**
 * Default 202's lookup over `tries` (triesOf's, in order): one search a try until one holds a candidate. Throws
 * ListingRefusedError placesUnavailable when a search fails, and searches no later try then.
 */
export async function lookupListing(
  places: ListingSearch,
  tries: readonly NameAndTown[],
  stepId: string,
): Promise<LookupFound> {
  for (const attempt of tries) {
    const held = (await searched(places, attempt, stepId)).filter((each) => candidateHolds(each, attempt));
    const [one, other] = held;
    if (one === undefined) continue;
    if (other !== undefined) return { found: "twoListings", decidedBy: attempt };
    return { found: "match", decidedBy: attempt, candidate: one };
  }
  return { found: "noListing" };
}

/** Whether `words` stand as a run, word for word, somewhere in `within`. */
function runIn(within: readonly string[], words: readonly string[]): boolean {
  for (let at = 0; at + words.length <= within.length; at += 1) {
    if (words.every((word, index) => within[at + index] === word)) return true;
  }
  return false;
}

/**
 * Whether a held candidate's name or address carries a banned word (default 206): an entry of the list found there as
 * whole words, case and punctuation aside (wordsOf). An entry with no word in it bans nothing.
 */
export function carriesBannedWord(
  candidate: Pick<ListingCandidate, "name" | "address">,
  banned: readonly string[],
): boolean {
  const name = wordsOf(candidate.name);
  const address = wordsOf(candidate.address);
  return banned.some((entry) => {
    const words = wordsOf(entry);
    return words.length > 0 && (runIn(name, words) || runIn(address, words));
  });
}
