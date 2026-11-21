// The kind matcher (T-632; C-130; arch 05 line 237; S1-02, S1-03, S1-74; RULES 1.4): an owner's words at sign-up, part by
// part, to the closest of the 243 kinds of work, as K-09 v1 matchKinds answers them (listed, which, new_work,
// not_booked). The method is T-631's, A (Q-42; DL-890; actions/spikes/q42-kind-matcher/FINDINGS.md "The named method"):
// plain text on K-24 v1's kinds.name, style and pattern of the trade_file rows, with no model and no stored index
// (QUESTIONS.md M4.1). Pure: the caller hands in the kinds list (K-24 v1 kinds rows) and holds the matcher, built once
// per catalog (FINDINGS "Notes for T-632" 1); nothing here reads a database, a bundle or the clock.
//
// How a part is matched, every setting T-631's, unchanged (FINDINGS defaults 4 and 5), with T-1518's two whole-part reads
// before the ranking (DL-1042: run on all 243 kinds, 6 kinds' own names and common everyday words read wrong):
//   1. Work Rosie never books (not-booked.ts: RULES 1.4, S1-02, S1-74) is not_booked, with no kind: nothing is set up
//      and the reply says so plainly (S1-74).
//   2. A part whose words are exactly one kind's own name (K-24 kinds.name, compared by wordKey: case, plurals, function
//      words and punctuation do not matter) is listed, with that kind (T-1518 Gives 1: "Painter", "art classes").
//   3. A part whose words are exactly an everyday word of the table (everyday.ts) is listed with its kind, or asks one
//      "which?" between its two (T-1518 Gives 2 and 3: "mechanic", "vet", "salon"; "eye doctor").
//   4. Else the trade_file kinds are ranked by Okapi BM25 (k1 1.2, b 0.75) over each kind's name (its words counted
//      NAME_WEIGHT times), style and pattern, a person's word counting every catalog word it meets (words.ts).
//   5. Nothing reaches FLOOR: new_work, with no kind ("One isn't on the list yet"), so S1-03 can draft it (S1-02's safe
//      default: "draft it as new work, offline until Rosie's team reviews it").
//   6. The second scores at least RATIO of the first: which, with both, closest first: one "which?" (arch 05 line 237).
//   7. Else listed, with the first.
// A part with no word left after the function words and numbers (a greeting, a number alone) names no work and gets no
// part (words.ts words). The words are split into parts at commas, semicolons and line breaks (words.ts splitParts),
// except that a kind's own name typed with its commas ("Glass, window and door installer") is one part (T-1518 Gives 1).
// Steps 2 and 3 read a part whole, so a part with any other word is ranked as before: every input of the texting guide's
// run keeps its outcome but those T-1518 names (kinds-guide.test.ts).
//
// Its limits (FINDINGS "Its limits, which T-632 and T-633 must not hide"): it matches an owner's words, which name a
// trade, not a customer's request by meaning (T-631: the right kind for 4 of 25 customer words); a "which?" comes from a
// shared word, not from meaning; and work the law bars is not read (not-booked.ts).

import type { ResponseOf } from "../../tool-api/calls";
import { EVERYDAY_WORDS, type EverydayWord } from "./everyday";
import { notBookedReason } from "./not-booked";
import { meets, MIN_WHOLE, partSpans, splitParts, wordKey, words } from "./words";

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
   * The owner's words, part by part (split at commas, semicolons and line breaks, but a kind's own name typed with its
   * commas is one part), each with its outcome and kinds. A part that names no work is left out, so words that name none
   * give no part (K-09's response needs one: the caller asks again).
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
  /** Each kind's own name by its wordKey, with the kind's index; a key two kinds' names share is left out (step 2). */
  readonly names: ReadonlyMap<string, number>;
  /** The most parts splitParts cuts one kind's name into: how many parts at most can be one name. */
  readonly nameParts: number;
  /** The everyday words by their wordKey, with the indexes of their kinds that are offered, closest first (step 3). */
  readonly everyday: ReadonlyMap<string, readonly number[]>;
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

/**
 * Method A's word table over the offered kinds: each kind's length, each word's postings, the words by their start; and
 * T-1518's whole-part reads: the kinds' own names and the everyday words, by their wordKey.
 */
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
  return {
    kinds: tableKinds,
    postings,
    starts,
    averageLength,
    ...namesOf(kinds),
    everyday: everydayOf(kinds, EVERYDAY_WORDS),
  };
}

/** Each kind's own name by its wordKey (a key two names share is left out), and the most parts one name splits into. */
function namesOf(kinds: readonly CatalogKind[]): Pick<Table, "names" | "nameParts"> {
  const names = new Map<string, number>();
  const shared = new Set<string>();
  let nameParts = 1;
  kinds.forEach((kind, index) => {
    const key = wordKey(kind.name);
    nameParts = Math.max(nameParts, splitParts(kind.name).length);
    if (key === "") return;
    if (names.has(key)) shared.add(key);
    names.set(key, index);
  });
  for (const key of shared) names.delete(key);
  return { names, nameParts };
}

/** The everyday words by their wordKey, each with its kinds that are offered (by index, in the table's order). */
function everydayOf(
  kinds: readonly CatalogKind[],
  table: readonly EverydayWord[],
): ReadonlyMap<string, readonly number[]> {
  const indexOf = new Map(kinds.map((kind, index) => [kind.id, index]));
  const everyday = new Map<string, readonly number[]>();
  for (const entry of table) {
    const key = wordKey(entry.words);
    const offeredKinds = entry.kinds.flatMap((id) => {
      const index = indexOf.get(id);
      return index === undefined ? [] : [index];
    });
    if (key !== "" && offeredKinds.length > 0 && !everyday.has(key)) everyday.set(key, offeredKinds);
  }
  return everyday;
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

const found = (kind: { readonly id: string; readonly name: string }): KindFound => ({
  kindId: kind.id,
  name: kind.name,
});

/** K-09 matchKinds' outcome for one part from its ranking (steps 5 to 7). */
function outcomeOf(ranked: readonly RankedKind[]): Pick<KindMatch, "outcome" | "kinds"> {
  const [first, second] = ranked;
  if (first === undefined || first.score < FLOOR) return { outcome: "new_work", kinds: [] };
  if (second !== undefined && second.score >= RATIO * first.score) {
    return { outcome: "which", kinds: [found(first), found(second)] };
  }
  return { outcome: "listed", kinds: [found(first)] };
}

/** The kinds of the table at these indexes, as K-09 names them (KindFound); an index with no kind gives none. */
function foundAt(table: Table, indexes: readonly number[]): KindFound[] {
  return indexes.flatMap((index) => {
    const kind = table.kinds[index];
    return kind === undefined ? [] : [found(kind)];
  });
}

/** K-09 matchKinds' outcome for one part that names work and is not work Rosie never books (steps 2 to 7). */
function readPart(table: Table, part: string): Pick<KindMatch, "outcome" | "kinds"> {
  const key = wordKey(part);
  const [named] = foundAt(table, [table.names.get(key) ?? -1]);
  if (named !== undefined) return { outcome: "listed", kinds: [named] };
  const [first, second] = foundAt(table, table.everyday.get(key) ?? []);
  if (first !== undefined && second !== undefined) return { outcome: "which", kinds: [first, second] };
  if (first !== undefined) return { outcome: "listed", kinds: [first] };
  return outcomeOf(rankIn(table, part));
}

/**
 * The parts of an owner's words (words.ts splitParts), except that parts that together are exactly one kind's own name,
 * split only at its commas, are kept as the one part they are, as typed ("Glass, window and door installer"; T-1518).
 */
function partsIn(table: Table, text: string): string[] {
  const spans = partSpans(text);
  const parts: string[] = [];
  let at = 0;
  while (at < spans.length) {
    const first = spans[at];
    if (first === undefined) break;
    let last = at;
    for (let end = Math.min(spans.length, at + table.nameParts) - 1; end > at; end -= 1) {
      const whole = text.slice(first.start, spans[end]?.end ?? first.end);
      if (!/[;\r\n]/u.test(whole) && table.names.has(wordKey(whole))) {
        last = end;
        break;
      }
    }
    parts.push(last === at ? first.part : text.slice(first.start, spans[last]?.end ?? first.end));
    at = last + 1;
  }
  return parts;
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
      for (const part of partsIn(table, text)) {
        if (words(part).length === 0) continue;
        if (notBookedReason(part) !== null) {
          parts.push({ words: part, outcome: "not_booked", kinds: [] });
          continue;
        }
        parts.push({ words: part, ...readPart(table, part) });
      }
      return parts;
    },
  };
}
