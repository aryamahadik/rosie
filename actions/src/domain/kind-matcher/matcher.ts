// The kind matcher (T-632; C-130; arch 05 line 237; S1-02, S1-03, S1-74; RULES 1.4): an owner's words at sign-up, part by
// part, to the closest of the 243 kinds of work, as K-09 v1 matchKinds answers them (listed, which, new_work,
// not_booked). The method is T-631's, A (Q-42; DL-890; actions/spikes/q42-kind-matcher/FINDINGS.md "The named method"):
// plain text on K-24 v1's kinds.name, style and pattern of the trade_file rows, with no model and no stored index
// (QUESTIONS.md M4.1). Pure: the caller hands in the kinds list (K-24 v1 kinds rows) and holds the matcher, built once
// per catalog (FINDINGS "Notes for T-632" 1); nothing here reads a database, a bundle or the clock.
//
// How a part is matched, every setting T-631's, unchanged (FINDINGS defaults 4 and 5):
//   1. Work Rosie never books (not-booked.ts: RULES 1.4, S1-02, S1-74) is not_booked, with no kind: nothing is set up
//      and the reply says so plainly (S1-74).
//   2. Else the trade_file kinds are ranked by Okapi BM25 (k1 1.2, b 0.75) over each kind's name (its words counted
//      NAME_WEIGHT times), style and pattern, a person's word counting every catalog word it meets (words.ts).
//   3. Nothing reaches FLOOR: new_work, with no kind ("One isn't on the list yet"), so S1-03 can draft it (S1-02's safe
//      default: "draft it as new work, offline until Rosie's team reviews it").
//   4. The second scores at least RATIO of the first: which, with both, closest first: one "which?" (arch 05 line 237).
//   5. Else listed, with the first.
// A part with no word left after the function words and numbers (a greeting, a number alone) names no work and gets no
// part (words.ts words).
//
// Its limits (FINDINGS "Its limits, which T-632 and T-633 must not hide"): it matches an owner's words, which name a
// trade, not a customer's request by meaning (T-631: the right kind for 4 of 25 customer words); a "which?" comes from a
// shared word, not from meaning; and work the law bars is not read (not-booked.ts).

import type { ResponseOf } from "../../tool-api/calls";
import { notBookedReason } from "./not-booked";
import { meets, MIN_WHOLE, splitParts, words } from "./words";

/** K-09 v1.5 matchKinds' response (v1's): each part of the owner's words, in order, with its outcome and kinds. */
export type MatchKindsResponse = ResponseOf<"matchKinds">;
/** One part of the words with its outcome (K-09 `KindMatch`). */
export type KindMatch = MatchKindsResponse["parts"][number];
/** listed, which, new_work or not_booked (K-09 `KindMatch.outcome`). */
export type KindOutcome = KindMatch["outcome"];
/** A kind offered: its id and K-24 kinds.name (K-09 `KindFound`). */
export type KindFound = KindMatch["kinds"][number];

/** K-24 v1 kinds.source of the 243 trade-file kinds: the only kinds the matcher offers (K-24 README "Open gaps"). */
export const TRADE_FILE = "trade_file";

/** BM25's term-frequency saturation (T-631). */
export const K1 = 1.2;
/** BM25's length normalization (T-631). */
export const LENGTH_NORM = 0.75;
/** A kind's name words count this many times (T-631). */
export const NAME_WEIGHT = 3;
/** The second kind fits too ("which?") when its score is at least this share of the first's (T-631). */
export const RATIO = 0.8;
/** Below this score nothing fits: only words most kinds use were met (T-631). */
export const FLOOR = 1.5;

// K-24 v1 kinds_id_form (K-09 `kindId`): lowercase words joined by hyphens.
const KIND_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** One K-24 v1 kinds row as the matcher reads it (README line 41: name, style and pattern; source picks the rows). */
export interface CatalogKind {
  readonly id: string;
  readonly name: string;
  /** The booking type in words, such as "Home visit". */
  readonly style: string;
  /** The booking pattern, such as "fix". */
  readonly pattern: string;
  /** trade_file for the 243; new_work for a kind an owner drafted, which the matcher never offers. */
  readonly source: string;
}

/** A kinds list the matcher cannot read: no trade_file kind, a repeated id, an id not in K-24's form, or a blank name. */
export class KindCatalogError extends Error {
  override readonly name = "KindCatalogError";
}

/** A kind's place in a ranking: its id, name and score. */
export interface RankedKind {
  readonly id: string;
  readonly name: string;
  readonly score: number;
}

export interface KindMatcher {
  /** How many kinds it offers: the trade_file kinds handed in. */
  readonly size: number;
  /**
   * The owner's words, part by part (split at commas, semicolons and line breaks), each with its outcome and kinds. A
   * part that names no work is left out, so words that name none give no part (K-09's response needs one: the caller
   * asks again).
   */
  match(text: string): KindMatch[];
  /** Every kind one part's words meet, highest score first, ties by id (the ranking step 2 names). */
  rank(part: string): RankedKind[];
}

interface TableKind {
  readonly id: string;
  readonly name: string;
  readonly length: number;
}

interface Table {
  readonly kinds: readonly TableKind[];
  /** Each catalog word's kinds, by index, with the word's weighted count in that kind. */
  readonly postings: ReadonlyMap<string, readonly (readonly [number, number])[]>;
  /** The catalog words of at least MIN_WHOLE letters, by their first MIN_WHOLE letters: all a longer word can meet. */
  readonly starts: ReadonlyMap<string, readonly string[]>;
  readonly averageLength: number;
}

const byId = (a: { readonly id: string }, b: { readonly id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** What method A reads of a kind (K-24 v1 as frozen): [text, weight] pairs. */
function fieldsOf(kind: CatalogKind): readonly (readonly [string, number])[] {
  return [
    [kind.name, NAME_WEIGHT],
    [kind.style, 1],
    [kind.pattern, 1],
  ];
}

/** The trade_file kinds of a list, checked (KindCatalogError otherwise), in code-point order of id. */
function offered(kinds: readonly CatalogKind[]): CatalogKind[] {
  const trade = kinds.filter((kind) => kind.source === TRADE_FILE);
  if (trade.length === 0) throw new KindCatalogError("the kinds list holds no trade_file kind to match");
  const seen = new Set<string>();
  for (const kind of trade) {
    if (!KIND_ID.test(kind.id)) {
      throw new KindCatalogError(`kind ${JSON.stringify(kind.id)}: its id is not K-24's form`);
    }
    if (seen.has(kind.id)) throw new KindCatalogError(`kind ${kind.id} is in the list twice`);
    if (kind.name.trim() === "") throw new KindCatalogError(`kind ${kind.id} has no name`);
    seen.add(kind.id);
  }
  return [...trade].sort(byId);
}

/** Method A's word table over the offered kinds: each kind's length, each word's postings, the words by their start. */
function buildTable(kinds: readonly CatalogKind[]): Table {
  const counted = kinds.map((kind) => {
    const counts = new Map<string, number>();
    let length = 0;
    for (const [text, weight] of fieldsOf(kind)) {
      for (const word of words(text)) {
        counts.set(word, (counts.get(word) ?? 0) + weight);
        length += weight;
      }
    }
    return { kind: { id: kind.id, name: kind.name, length }, counts };
  });
  const postings = new Map<string, (readonly [number, number])[]>();
  counted.forEach(({ counts }, index) => {
    for (const [word, count] of counts) {
      const list = postings.get(word) ?? [];
      list.push([index, count]);
      postings.set(word, list);
    }
  });
  const starts = new Map<string, string[]>();
  for (const word of postings.keys()) {
    if (word.length < MIN_WHOLE) continue;
    const start = word.slice(0, MIN_WHOLE);
    const list = starts.get(start) ?? [];
    list.push(word);
    starts.set(start, list);
  }
  const tableKinds = counted.map(({ kind }) => kind);
  const averageLength = tableKinds.reduce((sum, kind) => sum + kind.length, 0) / tableKinds.length;
  return { kinds: tableKinds, postings, starts, averageLength };
}

/** The catalog words a person's word meets, each with its weight (words.ts meets). */
function meetingsOf(table: Table, word: string): (readonly [string, number])[] {
  if (word.length < MIN_WHOLE) return table.postings.has(word) ? [[word, 1]] : [];
  const found: (readonly [string, number])[] = [];
  for (const catalogWord of table.starts.get(word.slice(0, MIN_WHOLE)) ?? []) {
    const weight = meets(word, catalogWord);
    if (weight > 0) found.push([catalogWord, weight]);
  }
  return found;
}

/** Every kind a text's words meet, by Okapi BM25, highest score first (ties by id). */
function rankIn(table: Table, text: string): RankedKind[] {
  const total = table.kinds.length;
  const scores = new Map<number, number>();
  for (const word of new Set(words(text))) {
    const frequency = new Map<number, number>();
    for (const [catalogWord, weight] of meetingsOf(table, word)) {
      for (const [index, count] of table.postings.get(catalogWord) ?? []) {
        frequency.set(index, (frequency.get(index) ?? 0) + count * weight);
      }
    }
    if (frequency.size === 0) continue;
    const idf = Math.log(1 + (total - frequency.size + 0.5) / (frequency.size + 0.5));
    for (const [index, f] of frequency) {
      const kind = table.kinds[index];
      if (kind === undefined) continue;
      const lengthRatio = kind.length / table.averageLength;
      const saturation = K1 * (1 - LENGTH_NORM + LENGTH_NORM * lengthRatio);
      scores.set(index, (scores.get(index) ?? 0) + (idf * f * (K1 + 1)) / (f + saturation));
    }
  }
  const ranked: RankedKind[] = [];
  for (const [index, score] of scores) {
    const kind = table.kinds[index];
    if (kind !== undefined) ranked.push({ id: kind.id, name: kind.name, score });
  }
  return ranked.sort((a, b) => b.score - a.score || byId(a, b));
}

const found = (kind: RankedKind): KindFound => ({ kindId: kind.id, name: kind.name });

/** K-09 matchKinds' outcome for one part from its ranking (steps 3 to 5). */
function outcomeOf(ranked: readonly RankedKind[]): Pick<KindMatch, "outcome" | "kinds"> {
  const [first, second] = ranked;
  if (first === undefined || first.score < FLOOR) return { outcome: "new_work", kinds: [] };
  if (second !== undefined && second.score >= RATIO * first.score) {
    return { outcome: "which", kinds: [found(first), found(second)] };
  }
  return { outcome: "listed", kinds: [found(first)] };
}

/**
 * The matcher over a kinds list (K-24 v1 kinds rows), built once: only the trade_file kinds are offered. Throws
 * KindCatalogError when the list holds none, repeats an id, or holds an id not in K-24's form or a blank name.
 */
export function createKindMatcher(kinds: readonly CatalogKind[]): KindMatcher {
  const table = buildTable(offered(kinds));
  return {
    size: table.kinds.length,
    rank: (part) => rankIn(table, part),
    match(text) {
      const parts: KindMatch[] = [];
      for (const part of splitParts(text)) {
        if (words(part).length === 0) continue;
        if (notBookedReason(part) !== null) {
          parts.push({ words: part, outcome: "not_booked", kinds: [] });
          continue;
        }
        parts.push({ words: part, ...outcomeOf(rankIn(table, part)) });
      }
      return parts;
    },
  };
}
