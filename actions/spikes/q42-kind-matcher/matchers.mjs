// The plain-text candidates of the kind matcher's spike (T-631; Q-42), and the one rule that turns a ranking into
// K-09 v1 matchKinds' outcome. No model and no stored index: each candidate builds its word table in memory from the
// catalog (catalog.mjs) and ranks the 243 kinds for a person's words with Okapi BM25 (k1 1.2, b 0.75), where a
// person's word counts every catalog word it meets (words.mjs), weighed by how much of the word they share.
//
//   A0 kinds.name alone (style and pattern are booking types many kinds share: 14 styles, 11 patterns)
//   A  K-24 v1 as frozen: kinds.name, style and pattern of the trade_file rows (README line 41; QUESTIONS M4.1)
//   B  A, plus each trade's pf.services and pf.questions text blocks (K-01 v1 tradeOverlay.pluginText, read whole)
//
// A kind's name words count NAME_WEIGHT times in both, so a name outweighs a passing mention.

import { TEXT_BLOCKS } from "./catalog.mjs";
import { meets, MIN_WHOLE, splitParts, words } from "./words.mjs";

/** BM25's term-frequency saturation. */
export const K1 = 1.2;
/** BM25's length normalization. */
export const LENGTH_NORM = 0.75;
/** A kind's name words count this many times. */
export const NAME_WEIGHT = 3;
/** The second kind fits too ("which?") when its score is at least this share of the first's. */
export const RATIO = 0.8;
/** Below this score nothing fits: only words most kinds use were met. */
export const FLOOR = 1.5;

/** What each candidate reads of a kind: [text, weight] pairs. */
export const CANDIDATES = {
  A0: {
    title: "A0 · plain text on kinds.name alone",
    fields: (kind) => [[kind.name, NAME_WEIGHT]],
  },
  A: {
    title: "A · plain text on kinds.name, style and pattern (K-24 v1 as frozen)",
    fields: (kind) => [
      [kind.name, NAME_WEIGHT],
      [kind.style, 1],
      [kind.pattern, 1],
    ],
  },
  B: {
    title: "B · A plus each trade's pf.services and pf.questions text (K-01 pluginText)",
    fields: (kind) => [
      [kind.name, NAME_WEIGHT],
      [kind.style, 1],
      [kind.pattern, 1],
      ...TEXT_BLOCKS.map((key) => [kind.blocks[key], 1]),
    ],
  },
};

/**
 * One candidate's word table over the catalog: each kind's word counts and length, each word's kinds (postings), and
 * the words grouped by their first MIN_WHOLE letters, the only words a longer word can meet.
 */
export function buildTable(catalog, fields) {
  const kinds = catalog.map((kind) => {
    const counts = new Map();
    let length = 0;
    for (const [text, weight] of fields(kind)) {
      for (const word of words(text)) {
        counts.set(word, (counts.get(word) ?? 0) + weight);
        length += weight;
      }
    }
    return { id: kind.id, name: kind.name, counts, length };
  });
  const postings = new Map();
  kinds.forEach((kind, index) => {
    for (const [word, count] of kind.counts) {
      const list = postings.get(word) ?? [];
      list.push([index, count]);
      postings.set(word, list);
    }
  });
  const starts = new Map();
  for (const word of postings.keys()) {
    if (word.length < MIN_WHOLE) continue;
    const start = word.slice(0, MIN_WHOLE);
    const list = starts.get(start) ?? [];
    list.push(word);
    starts.set(start, list);
  }
  const averageLength = kinds.reduce((sum, kind) => sum + kind.length, 0) / kinds.length;
  return { kinds, postings, starts, averageLength };
}

/** The catalog words a person's word meets, each with its weight (words.mjs meets). */
function meetingsOf(table, word) {
  if (word.length < MIN_WHOLE) return table.postings.has(word) ? [[word, 1]] : [];
  const found = [];
  for (const catalogWord of table.starts.get(word.slice(0, MIN_WHOLE)) ?? []) {
    const weight = meets(word, catalogWord);
    if (weight > 0) found.push([catalogWord, weight]);
  }
  return found;
}

/** Every kind a text's words meet, highest score first (ties by id): [{ id, name, score }]. */
export function rank(table, text) {
  const total = table.kinds.length;
  const scores = new Map();
  for (const word of new Set(words(text))) {
    const frequency = new Map();
    for (const [catalogWord, weight] of meetingsOf(table, word)) {
      for (const [index, count] of table.postings.get(catalogWord)) {
        frequency.set(index, (frequency.get(index) ?? 0) + count * weight);
      }
    }
    if (frequency.size === 0) continue;
    const idf = Math.log(1 + (total - frequency.size + 0.5) / (frequency.size + 0.5));
    for (const [index, f] of frequency) {
      const lengthRatio = table.kinds[index].length / table.averageLength;
      const saturation = K1 * (1 - LENGTH_NORM + LENGTH_NORM * lengthRatio);
      scores.set(index, (scores.get(index) ?? 0) + (idf * f * (K1 + 1)) / (f + saturation));
    }
  }
  return [...scores]
    .map(([index, score]) => ({ id: table.kinds[index].id, name: table.kinds[index].name, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * K-09 v1 matchKinds' outcome from a ranking: "listed" with one kind; "which" with two when the second is close
 * (RATIO); "none" when nothing reaches FLOOR. K-09 splits "none" into new_work and not_booked (S1-02's other two
 * branches; RULES 1.4): plain text cannot tell them apart, so the spike reports "none".
 */
export function decide(ranked, { ratio = RATIO, floor = FLOOR } = {}) {
  const [first, second] = ranked;
  if (first === undefined || first.score < floor) return { outcome: "none", kinds: [] };
  if (second !== undefined && second.score >= ratio * first.score) {
    return { outcome: "which", kinds: [first.id, second.id] };
  }
  return { outcome: "listed", kinds: [first.id] };
}

/** matchKinds' parts for an owner's words: each part with its outcome, kinds and the three closest (the pick-list). */
export function matchKinds(table, text, options) {
  return splitParts(text).map((part) => {
    const ranked = rank(table, part);
    return { words: part, ...decide(ranked, options), closest: ranked.slice(0, 3).map((kind) => kind.id) };
  });
}

/** The word table as one stored value would hold it (kinds' ids, names and lengths; each word's postings), in bytes. */
export function tableBytes(table) {
  const value = {
    kinds: table.kinds.map((kind) => [kind.id, kind.name, kind.length]),
    words: Object.fromEntries(table.postings),
  };
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
