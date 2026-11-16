// C7 (Master Corrections section 3; D96; RULES 10.1; S13-11; `switches.verify`): trade text that says Rosie or Rosie's
// team checks, looks up or has read a license, permit, certificate, insurance or carrier status is the business's own
// word.
//
// The trade files were never read one by one by a reviewer (MC section 6), and some still say Rosie checks a paper on an
// official lookup: acupuncturist.json's pf.license.check, camp.json's pf.staff.license, movers.json's
// pf.license.status_any_day, tree.json's pf.license.trust, dog-walker.json's park permit ("Rosie's team checks it with
// the city"); the Nov 4 check listed 45 such trade files. What holds: Rosie checks nothing while switch "verify" is off
// (C4). Such text is the business's own word: Rosie never says a paper was checked by Rosie (S13-11), and a step that
// waits on such a check waits on the business's own yes alone (DD).
//
// What this file changes: the trade's own text, wherever the compiled overlay holds it (K-01 tradeOverlay): the 11
// free-text pf blocks (each stored whole, MC R3; K-01 pluginText says such text is the business's own word), every op's
// words (a words or more op's lines, an off's reason, the steps an after, before or branch op adds), the new words of
// its rename pairs and of its variants' swaps, its own slot rows and its money texts. Each sentence that makes such a
// claim (findClaims: a CLAIM_PATTERNS phrase that is not negated) is replaced with OWN_WORD, S13-11's words for a claim
// with the C7 marker, so no compiled line says Rosie checked a paper and each text C7 flags carries the marker. A run of
// such sentences becomes one OWN_WORD; the text's other sentences stay as written.
//
// What it leaves: a rename's or a swap's first side, which is the master's own line it matches (C4 switches off the
// master's verify-only steps, whose words say so; T-147 marks them); a branch label, which an off names exactly; and the
// sample cast, names and story, which the overlay does not hold (MC C6). A message a person reads that makes such a
// claim stops the build (C7ClaimError): OWN_WORD and its marker are not words for a person, and no trade of fixture set
// v1 has one.
//
// What this file gives:
//   CLAIM_PATTERNS, findClaims()  the phrases that say Rosie checks a paper, and the claims in one text.
//   markClaims()                  the trade with each claim replaced, and every text changed, tagged MC:C7.
//   renderMarks()                 the changes as diff lines, each starting with its tag.
//   c7                            the correction in the frame's list: it changes no step (the texts are the trade's).
import type { FlowLetter } from "../graph/types.ts";
import { PF_TEXT_KEYS, type LoadedTrade, type PluginText, type TradeId } from "../load/trade";
import type { Correction, CorrectionTag } from "./framework";

/** The marker every text C7 changes carries: the frame's tag for C7. */
export const C7_MARKER: CorrectionTag = "MC:C7";

/** What a sentence that says Rosie checks a paper becomes: S13-11's words for a claim ("shows only as the business's own word, never as checked by Rosie"), with the C7 marker. */
export const OWN_WORD = `The business's own word, never checked by Rosie (${C7_MARKER}).`;

/** Who checks, in a claim: Rosie, Rosie's team, or a person on it. */
const WHO = String.raw`(?:a person on Rosie's team|Rosie's team|Rosie)`;

/**
 * What follows a check verb when no paper is checked: a negation ("checks no permit", "checks nothing"); a job checked
 * against what the business says its license covers (S13-15: "Rosie checks each job against it", handyman.json); a date
 * ("Rosie checks the date", driving-school.json); a rule checked before a page or a meeting ("Rosie checks this before
 * the secure page", tattoo.json; "Rosie checks that before a home meeting is offered", funeral.json); a message read
 * back ("Rosie reads it back", funeral.json).
 */
const NO_PAPER = String.raw`(?:no|nothing|none|each job|the job|the total|the date|(?:this|that) before|(?:it |them )?back)\b`;

/** One phrase that says Rosie checks a paper, and how many words before it a negation takes it back (NEGATION). */
export interface ClaimPattern {
  pattern: RegExp;
  /** Words looked at before the phrase for a negation: a number, or the whole sentence before it (Infinity). */
  reach: number;
}

/**
 * The phrases that say Rosie or Rosie's team checks, looks up or has read a paper, each with an example from the trade
 * files. A phrase counts in a text that names a paper (PAPER), unless a negation comes within its reach before it.
 */
export const CLAIM_PATTERNS: readonly ClaimPattern[] = [
  // Rosie, or Rosie's team, checks, re-checks, looks up, has read, reads, verifies or confirms: "Rosie checks it on the
  // city's own records" (farrier.json), "a person on Rosie's team checks within 1 business day" (acupuncturist.json),
  // "Rosie re-checks it on the plug-in's schedule" (movers.json), "Rosie has read the certificate" (tree.json).
  {
    pattern: new RegExp(
      String.raw`\b${WHO}\s+(?:(?:also|then|first|again|only|still)\s+)?(?:re-?checks|checks|looks\s+(?:(?!no\b|nothing\b)[\w'-]+\s+){0,4}?up|has\s+read|reads|verifies|confirms)\b(?!\s+${NO_PAPER})`,
    ),
    reach: 3,
  },
  // Rosie does one thing and checks: "Rosie reminds 30 days before a permit's date and checks again on it"
  // (restaurant.json).
  {
    pattern: new RegExp(
      String.raw`\bRosie\s+[a-z]+s\b[^.;:]{0,80}?\band\s+(?:re-?)?checks\b(?!\s+${NO_PAPER})`,
    ),
    reach: 3,
  },
  // Checked by Rosie: "Licenses: Checked by Rosie on the state's lookup". Any negation before it in the sentence takes
  // it back ("Rosie never says a certificate was checked by Rosie", doula.json).
  {
    pattern: new RegExp(
      String.raw`\b(?:checked|re-?checked|verified|looked\s+up|confirmed|read)\s+by\s+${WHO}`,
      "i",
    ),
    reach: Infinity,
  },
  // Checked on an official lookup or record: "the camp nurse's nursing license, checked on the state's lookup"
  // (camp.json).
  {
    pattern:
      /\b(?:checked|re-?checked|verified|looked up)\s+(?:again\s+)?(?:on|against)\s+(?:the|an?)\s+[\w' ]{0,40}?(?:lookup|records?)\b/i,
    reach: 3,
  },
  // A paper on an official lookup, with no check verb of Rosie's around it: "each number on the state board's official
  // lookup" (acupuncturist.json). Any negation before it in the sentence takes it back ("never checks a paper on an
  // official lookup").
  { pattern: /\b(?:on|against)\s+(?:the|an?)\s+[\w' ]{0,40}?official\s+lookup\b/i, reach: Infinity },
  // Rosie saw a paper on a lookup: "unless Rosie saw them on the certifier's own lookup" (restoration.json).
  {
    pattern: new RegExp(
      String.raw`\b${WHO}\s+(?:saw|sees|has\s+seen)\b[^.;]{0,40}?\bon\s+(?:the|an?)\s+[\w' ]{0,40}?(?:lookup|records?)\b`,
    ),
    reach: 3,
  },
];

/** A text names a paper: a license, permit, certificate, registration, insurance, bond, credential, carrier or authority, or an official lookup. */
export const PAPER =
  /licen[cs]|permit|certif|insur|registration|credential|\bbond|carrier|\bauthority|lookup|\bpapers?\b/i;

/** A word that negates the phrase after it: "not checked by Rosie", "never as checked by Rosie". */
const NEGATION = /\b(?:never|not|no|nor|cannot|nothing|none)\b|n't\b/i;

/** One sentence and the separator after it, as a text splits (the separator is "" at the end). */
interface Sentence {
  text: string;
  after: string;
}

/** A text's sentences: each ends at ".", ";", "!" or "?" before white space, or at the end. */
function sentences(text: string): Sentence[] {
  const parts = text.split(/((?<=[.;!?])\s+)/);
  const out: Sentence[] = [];
  for (let k = 0; k < parts.length; k += 2) out.push({ text: parts[k] ?? "", after: parts[k + 1] ?? "" });
  return out;
}

/** Whether a negation comes within `reach` words (punctuation alone is no word) before `at` in the sentence. */
function negated(sentence: string, at: number, reach: number): boolean {
  const words = sentence
    .slice(0, at)
    .split(/\s+/)
    .filter((word) => /[a-z]/i.test(word));
  return words.slice(Number.isFinite(reach) ? -reach : 0).some((word) => NEGATION.test(word));
}

/** Whether a sentence says Rosie or Rosie's team checks a paper: some pattern matches where no negation takes it back. */
function claims(sentence: string): boolean {
  for (const { pattern, reach } of CLAIM_PATTERNS) {
    const global = new RegExp(pattern.source, `${pattern.flags}g`);
    for (const match of sentence.matchAll(global)) if (!negated(sentence, match.index, reach)) return true;
  }
  return false;
}

/** The sentences of a text that say Rosie or Rosie's team checks a paper, in order (none where the text names no paper). */
export function findClaims(text: string): string[] {
  if (!PAPER.test(text)) return [];
  return sentences(text)
    .map((sentence) => sentence.text)
    .filter(claims);
}

/** The text with each run of claim sentences replaced with one OWN_WORD; the text itself when it has none. */
export function ownWord(text: string): string {
  if (findClaims(text).length === 0) return text;
  let out = "";
  let inRun = false;
  for (const part of sentences(text)) {
    if (claims(part.text)) {
      if (!inRun) out += OWN_WORD;
      inRun = true;
      // The separator after the run's last sentence follows OWN_WORD.
      out = out.replace(/\s*$/, part.after);
      continue;
    }
    inRun = false;
    out += part.text + part.after;
  }
  return out;
}

/**
 * A claim in a message a person reads, which C7 cannot make the business's own word in OWN_WORD's terms. An Error, not
 * framework.ts's CorrectionError: the frame imports this file, so this file imports only its types (as c4.ts does).
 */
export class C7ClaimError extends Error {
  override name = "C7ClaimError";
}

/** One trade text C7 changed. */
export interface ClaimMark {
  tag: CorrectionTag;
  trade: TradeId;
  /** Where the text is: `pluginText.pf.license.check`, `A ops[23].does`, `B rename[7][1]`. */
  where: string;
  before: string;
  after: string;
}

/** A trade with C7's texts, and each text changed. */
export interface MarkedTrade {
  trade: LoadedTrade;
  marked: ClaimMark[];
}

const TAG: CorrectionTag = "MC:C7";
const FLOWS: readonly FlowLetter[] = ["A", "B"];

/** Keys whose values are never words: ids, lanes, gates and the names other ops match exactly (a branch label). */
const NOT_WORDS: ReadonlySet<string> = new Set([
  "id",
  "at",
  "op",
  "label",
  "who",
  "to",
  "via",
  "as",
  "line",
  "needs",
  "gives",
  "reads",
  "tells",
  "when",
  "sets",
  "flow",
  "phase",
  "type",
  "kind",
  "slot",
  "link",
  "stop",
]);

/** Keys that hold [old, new] pairs: only the new side is the trade's own words (the old side is the master's line). */
const PAIR_LISTS: ReadonlySet<string> = new Set(["swap"]);

/** Keys that hold messages: [from, to, text, elements], or [from, to, elements]. */
const MESSAGE_LISTS: ReadonlySet<string> = new Set(["say", "addSay"]);

type Mark = (where: string, before: string, after: string) => void;

function key(path: string, part: string | number): string {
  return typeof part === "number" ? `${path}[${String(part)}]` : path === "" ? part : `${path}.${part}`;
}

/**
 * The value with each claim in its words replaced (a copy where anything changed, the value itself where nothing did).
 * `inMessage` is the message the value lies in, when it lies in one.
 */
function rewrite(value: unknown, path: string, mark: Mark, inMessage: string | null): unknown {
  if (typeof value === "string") {
    const next = ownWord(value);
    if (next === value) return value;
    if (inMessage !== null)
      throw new C7ClaimError(
        `${path}: a message a person reads says Rosie checks a paper (MC C7); it needs the business's own words`,
      );
    mark(path, value, next);
    return next;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item, k) => {
      const next = rewrite(item, key(path, k), mark, inMessage);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [field, item] of Object.entries(value)) {
      const at = key(path, field);
      let next: unknown = item;
      if (NOT_WORDS.has(field)) next = item;
      else if (PAIR_LISTS.has(field) && Array.isArray(item)) next = newSides(item, at, mark, inMessage);
      else if (MESSAGE_LISTS.has(field) && Array.isArray(item)) next = messages(item, at, mark);
      else next = rewrite(item, at, mark, inMessage);
      if (next !== item) changed = true;
      out[field] = next;
    }
    return changed ? out : value;
  }
  return value;
}

/** A list of [old, new] pairs with each new side rewritten; the old side is the master's line, matched as written. */
function newSides(pairs: readonly unknown[], path: string, mark: Mark, inMessage: string | null): unknown[] {
  let changed = false;
  const out = pairs.map((pair, k) => {
    if (!Array.isArray(pair) || pair.length !== 2) return pair;
    const next = rewrite(pair[1], `${path}[${String(k)}][1]`, mark, inMessage);
    if (next === pair[1]) return pair;
    changed = true;
    return [pair[0], next];
  });
  return changed ? out : (pairs as unknown[]);
}

/** A list of messages, each read as a message a person reads: its lanes are not words. */
function messages(list: readonly unknown[], path: string, mark: Mark): unknown[] {
  let changed = false;
  const out = list.map((message, k) => {
    const at = `${path}[${String(k)}]`;
    if (!Array.isArray(message)) return rewrite(message, at, mark, at);
    const words = message.slice(2);
    const next = rewrite(words, at, mark, at) as unknown[];
    if (next === words) return message;
    changed = true;
    return [message[0], message[1], ...next];
  });
  return changed ? out : (list as unknown[]);
}

/**
 * The trade with every claim that Rosie or Rosie's team checks a paper replaced with OWN_WORD, in each text the compiled
 * overlay holds (see the top of this file), and each text changed, tagged MC:C7. The trade given is not changed; one
 * with no claim is given back as it is. Throws C7ClaimError for a claim in a message a person reads.
 */
export function markClaims(trade: LoadedTrade): MarkedTrade {
  const marked: ClaimMark[] = [];
  const mark: Mark = (where, before, after) => {
    marked.push({ tag: TAG, trade: trade.id, where, before, after });
  };
  let out = trade;

  let pluginText: PluginText | null = null;
  for (const name of PF_TEXT_KEYS) {
    const block: unknown = JSON.parse(trade.pluginText[name]);
    const next = rewrite(block, `pluginText.${name}`, mark, null);
    if (next === block) continue;
    pluginText ??= { ...trade.pluginText };
    pluginText[name] = JSON.stringify(next);
  }
  if (pluginText !== null) out = { ...out, pluginText };

  for (const flow of FLOWS) {
    const part = trade.flows[flow];
    const ops = rewrite(part.ops, `${flow} ops`, mark, null) as typeof part.ops;
    const rename = newSides(part.rename, `${flow} rename`, mark, null) as typeof part.rename;
    const slotRows = rewrite(part.slotRows, `${flow} slotRows`, mark, null) as typeof part.slotRows;
    const money = rewrite(part.money, `${flow} money`, mark, null) as typeof part.money;
    if (ops === part.ops && rename === part.rename && slotRows === part.slotRows && money === part.money)
      continue;
    out = { ...out, flows: { ...out.flows, [flow]: { ...part, ops, rename, slotRows, money } } };
  }
  return { trade: out, marked };
}

/** The changes as diff lines: `MC:C7 - <trade> <where>: <before>` and `MC:C7 + <trade> <where>: <after>`. */
export function renderMarks(marked: readonly ClaimMark[]): string[] {
  return marked.flatMap((one) => [
    `${one.tag} - ${one.trade} ${one.where}: ${one.before}`,
    `${one.tag} + ${one.trade} ${one.where}: ${one.after}`,
  ]);
}

/** C7: a trade's claims that Rosie checks a paper are the business's own word. They are the trade's texts, so the correction changes no step. */
export const c7: Correction = {
  id: "C7",
  title:
    "Trade text that says Rosie or Rosie's team checks a license, permit, certificate, insurance or carrier status is the business's own word",
  source:
    "Master Corrections C7; D96; RULES 10.1; S13-11; switches.verify in master-A.json and master-B.json",
  apply() {
    // No step changes: C7's texts are the trade's (markClaims).
  },
};
