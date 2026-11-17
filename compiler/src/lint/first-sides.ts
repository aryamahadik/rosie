// The first-side lint (T-1439; the security reviewer's new task on T-140 round 4 and its note b on round 5; MC C7's
// default 4): rename and swap pairs whose first side matches no text the master and the trade's own ops lay at their
// flow.
//
// A trade's rename pairs run on the master's words once, when its overlay is applied, before its ops (overlay-core.js
// apply, lines 1797-1800: the plug-in slots are filled with the trade's switches and settings, then renameAll runs every
// pair in order, whole words, as written, never inside a {{keep:...}} slot; profRecord runs them on the record's slot
// rows too). A swap pair (a variant's `swap`) runs later, on the words under it at its step. So a pair's first side is
// the master's own line it renames (C7's default 4 leaves it as written for that reason), or words an earlier pair of the
// same trade laid there. A pair whose first side is neither, nor words of the trade's own ops, renames nothing: no person
// reads either of its sides, and its first side is no master line, so default 4 does not hold for it.
//
// What this lint lists (firstSideFindings): every rename pair and every swap pair of each trade, in both flows, whose
// first side matches no text the master lays at that flow (its words as renameAll reads them, the trade's slots filled;
// and those words as the trade's earlier pairs left them, so a pair that renames words an earlier pair laid is matched)
// and no text the trade's own ops lay at that flow. Each with its trade file, its lines there, and its reason as found
// (REASONS, the first that holds). It reports and never throws for what it finds: no build stops on it (the card's "Not
// here"), and its unit test pins today's list by place (first-sides.places.txt, placesText). Pairs it does not list but
// that rename nothing all the same are counted (FirstSideReport.unlisted): a first side that is master text an earlier
// pair renamed first, or words of the trade's own ops only.
//
// What a person reads where a listed pair was meant to rename (the card's part 2), found by compiling the trade as the
// bundle does (bundleTrade, applyTrade, then Master Corrections; switch "verify" is off, C4): readLines() gives every word
// a person may read on a flow, compiledLines() a trade's, placeOf() the line a first side was meant for (meantFor: RUN
// words in a row shared), masterClaimLines() the master's own lines that hold a check claim (READ_PATTERNS: C7's, and a
// paper "confirmed on" a lookup), pairsAtClaimLines() the listed pairs meant for one of those, each with what a person
// reads there, and claimsWhileOff() whether a line claims a check made while verify is off (a sentence that says it holds
// only with checks on, or that checks are off now, does not).
//
// It reads fixture set v1 as the loader does (load/trade.ts, load/flow.ts) and the master's own functions for the slots
// (overlay-core.js, loaded once by overlay/core.ts); it changes nothing.
import { readFileSync } from "node:fs";
import { correctTrade } from "../corrections/c5";
import { OWN_WORD, WORD_PATTERNS, findClaims, markClaims, type ClaimPattern } from "../corrections/c7";
import { voidOffs } from "../corrections/c8";
import { applyCorrections } from "../corrections/framework";
import { correctedFlow, masterShape } from "../emit/flow";
import { correctWordsOps } from "../emit/words-corrections";
import type { FlowGraph, FlowLetter, MasterGraphs } from "../graph/types.ts";
import { TRADE_DIR, type LoadedTrade, type TradeId, type TradeOp } from "../load/trade";
import { applyTrade, type AppliedStep } from "../overlay/apply";
import { loadOverlayCore } from "../overlay/core";

/** The rule: its id, its name in a report line, and where it comes from. */
export const FIRST_SIDE_RULE = {
  id: "first-side-matches-nothing",
  name: "first side matches no master text",
  source:
    "T-1439; the security reviewer's new task on T-140 round 4 and note b on round 5 (DL-927); MC C7's default 4; overlay-core.js apply and renameAll",
} as const;

/** A key or an index on the way to a value in a JSON text. */
export type JsonPart = string | number;

/**
 * Each value's line (1-based) in a JSON text, by its path (JSON.stringify of its keys and indexes; the whole text's is
 * "[]"). The text must be valid JSON (the trade loader has parsed it already).
 */
export function jsonLines(text: string): Map<string, number> {
  const out = new Map<string, number>();
  let i = 0;
  let line = 1;
  const space = (): void => {
    while (i < text.length) {
      const c = text[i];
      if (c === "\n") line += 1;
      else if (c !== " " && c !== "\t" && c !== "\r") return;
      i += 1;
    }
  };
  const string = (): string => {
    const start = i;
    i += 1;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i += 1;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (path: readonly JsonPart[]): void => {
    space();
    out.set(JSON.stringify(path), line);
    const c = text[i];
    if (c === "{" || c === "[") {
      const object = c === "{";
      i += 1;
      space();
      let k = 0;
      while (i < text.length && text[i] !== (object ? "}" : "]")) {
        let part: JsonPart = k;
        if (object) {
          part = string();
          space();
          i += 1; // the colon
        }
        value([...path, part]);
        space();
        if (text[i] === ",") i += 1;
        space();
        k += 1;
      }
      i += 1;
      return;
    }
    if (c === '"') {
      string();
      return;
    }
    while (i < text.length && !/[\s,\]}]/.test(text[i] ?? "")) i += 1;
  };
  value([]);
  return out;
}

/** The part of overlay-core.js this lint calls: the first lines of apply(), up to its renames (lines 1795-1800). */
interface SlotCore {
  syncWays(flow: unknown): void;
  clone<T>(value: T): T;
  slotCtx(overlay: unknown, flow: FlowLetter): { pf?: unknown; settings?: unknown };
  hasSlots(flow: unknown): boolean;
  fillSteps(steps: unknown, ctx: unknown): unknown;
  eachStep(steps: unknown, visit: (step: Record<string, unknown>) => void): void;
}

function slotCore(): SlotCore {
  return loadOverlayCore() as unknown as SlotCore;
}

/**
 * The trade as apply() reads it for one flow (overlay/apply.ts overlayOf builds the same): its plug-in (facts, switches,
 * settings), its renames, story, money, slot rows and ops. The slots read its switches and settings from it.
 */
export function overlayView(trade: LoadedTrade, flow: FlowLetter): Record<string, unknown> {
  const part = trade.flows[flow];
  const plugin: Record<string, unknown> = {};
  if (trade.facts !== null) plugin["pf.facts"] = trade.facts;
  if (trade.switches !== null) plugin["pf.switches"] = trade.switches;
  if (trade.settings !== null) plugin["pf.settings"] = trade.settings;
  return structuredClone({
    id: trade.id,
    plugin,
    rename: { [flow]: part.rename },
    story: { [flow]: part.story },
    money: { [flow]: part.money },
    slots: { [flow]: part.slotRows },
    [flow]: { ops: part.ops },
  });
}

/**
 * Every word of a step a rename runs on (overlay-core.js renameAll, lines 1731-1740), in its order. A variant's swap
 * pairs give both sides, as renameAll renames both; with `laid`, only their new sides, the words a swap lays (its first
 * side is words it looks for, not words it lays).
 */
export function stepWords(step: Record<string, unknown>, visit: (text: string) => void, laid = false): void {
  const deep = (value: unknown): void => {
    if (typeof value === "string") visit(value);
    else if (Array.isArray(value)) for (const item of value) deep(item);
    else if (typeof value === "object" && value !== null)
      for (const [key, item] of Object.entries(value)) {
        if (laid && key === "swap" && Array.isArray(item))
          for (const pair of item as unknown[])
            deep(Array.isArray(pair) ? (pair as unknown[]).slice(1) : pair);
        else deep(item);
      }
  };
  for (const key of ["title", "does", "rule", "q", "t", "as"]) {
    const value = step[key];
    if (typeof value === "string") visit(value);
  }
  for (const key of ["more", "say", "vary", "form", "table"]) if (step[key]) deep(step[key]);
  const slot = step.slot;
  if (typeof slot === "object" && slot !== null)
    for (const [key, value] of Object.entries(slot)) if (key !== "examples") deep(value);
  if (step.amounts) deep(step.amounts);
  if (step.timed) deep(step.timed);
  for (const branch of (step.branches ?? []) as Record<string, unknown>[]) {
    if (typeof branch.label === "string") visit(branch.label);
    if (typeof branch.endText === "string") visit(branch.endText);
  }
}

/** A {{keep:...}} slot: a rename never changes its words (renameAll's fix, line 1728). */
const KEEP = /(\{\{\s*keep\s*:[^{}|]*\}\})/;

/** A text's parts a rename reads, apart: the text itself, or the parts between its keep slots. */
export function renamedParts(text: string): string[] {
  if (!text.includes("{{") || !/\{\{\s*keep\s*:/.test(text)) return [text];
  return text.split(KEEP).filter((_, k) => k % 2 === 0);
}

/** A separator no first side holds: two parts joined with it never match as one. */
const SEP = "\u0000";

/** How many parts go in one chunk: a pair is run only on the chunks that hold its first side. */
const CHUNK = 64;

/**
 * Words as a rename reads them: each text's parts (renamedParts) in chunks of joined parts, SEP before, between and after
 * them, so a first side never matches across two parts and every part starts and ends as renameAll's own string does.
 */
export type Words = string[];

/** Texts as Words. */
export function wordsOf(texts: Iterable<string>): Words {
  const parts: string[] = [];
  for (const text of texts) for (const part of renamedParts(text)) parts.push(part);
  const out: Words = [];
  for (let k = 0; k < parts.length; k += CHUNK)
    out.push(`${SEP}${parts.slice(k, k + CHUNK).join(SEP)}${SEP}`);
  return out;
}

const WORD = /[A-Za-z0-9]/;

/**
 * Whether `first` stands in the words as renameAll matches a first side: whole words, as written, with no letter or
 * digit right before or after it ("(^|[^A-Za-z0-9])" + first side + "(?![A-Za-z0-9])", lines 1723-1724).
 */
export function standsIn(first: string, words: Words): boolean {
  if (first === "") return words.length > 0;
  for (const chunk of words)
    for (let at = chunk.indexOf(first); at >= 0; at = chunk.indexOf(first, at + 1)) {
      const before = chunk[at - 1] ?? SEP;
      const after = chunk[at + first.length] ?? SEP;
      if (!WORD.test(before) && !WORD.test(after)) return true;
    }
  return false;
}

/** renameAll's pattern for one first side (line 1723). */
function renamePattern(first: string): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9])${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "g");
}

/**
 * Runs the pairs in order on the words, as renameAll does (each pair on the words the pairs before it left), and gives
 * whether each one renamed anything, and the words they leave.
 */
export function runPairs(
  pairs: readonly (readonly [first: string, second: string])[],
  words: Words,
): { renamed: boolean[]; words: Words } {
  let current = [...words];
  const renamed = pairs.map(([first, second]) => {
    const pattern = renamePattern(first);
    let hit = false;
    current = current.map((chunk) => {
      if (!chunk.includes(first)) return chunk;
      return chunk.replace(pattern, (_match, pre: string) => {
        hit = true;
        return pre + second;
      });
    });
    return hit;
  });
  return { renamed, words: current };
}

/** Each master flow's words by the slot fill they were read with (a trade's switches and settings), made once. */
const masterCache = new WeakMap<FlowGraph, Map<string, Words>>();

/**
 * The master's flow as a trade's renames read it (overlay-core.js apply, lines 1795-1800): the plug-in slots filled with
 * the trade's switches and settings (or, with no trade, the master's own example words), then every word a rename runs
 * on (stepWords), and the record's slot rows (profRecord, line 1874).
 */
export function masterWords(master: MasterGraphs, flow: FlowLetter, trade: LoadedTrade | null): Words {
  const core = slotCore();
  const graph = master[flow];
  const shape = masterShape(graph) as unknown as Record<string, unknown>;
  const ctx = core.slotCtx(trade === null ? null : overlayView(trade, flow), flow);
  const key = JSON.stringify([ctx.pf ?? null, ctx.settings ?? null]);
  const cache = masterCache.get(graph) ?? new Map<string, Words>();
  masterCache.set(graph, cache);
  const known = cache.get(key);
  if (known !== undefined) return known;
  core.syncWays(shape);
  const copy = core.clone(shape);
  if (core.hasSlots(shape)) core.fillSteps(copy.steps, ctx);
  const texts: string[] = [];
  core.eachStep(copy.steps, (step) => {
    stepWords(step, (text) => texts.push(text));
  });
  const record = copy.record as { slots?: Record<string, { rows?: { text?: unknown }[] }> } | undefined;
  for (const slot of Object.values(record?.slots ?? {}))
    for (const row of slot.rows ?? []) if (typeof row.text === "string") texts.push(row.text);
  const words = wordsOf(texts);
  cache.set(key, words);
  return words;
}

/** A slot with its example words: {{price:$35}}, {{arrive:8–10am|...}} (overlay-core.js SLOT_RE, AMOUNT_RE). */
const EXAMPLE_SLOT = /\{\{\s*[\w.]+\s*:([^{}|]*)(?:\|[^{}]*)?\}\}/g;

/** The master's words with its own example words in every slot (its own fill, then each amount slot's example). */
export function exampleWords(master: MasterGraphs, flow: FlowLetter): Words {
  return masterWords(master, flow, null).map((chunk) => chunk.replace(EXAMPLE_SLOT, "$1"));
}

/**
 * Every word the trade's own ops lay at one flow: a words op's fields, a more op's lines, the steps an op adds (a swap's
 * new side, never its first side).
 */
export function opWords(ops: readonly TradeOp[]): Words {
  const texts: string[] = [];
  const visit = (text: string): void => {
    texts.push(text);
  };
  const steps = (list: readonly unknown[]): void => {
    slotCore().eachStep(list, (step) => {
      stepWords(step, visit, true);
    });
  };
  for (const op of ops) {
    if (op.op === "words") stepWords(op as unknown as Record<string, unknown>, visit, true);
    else if (op.op === "more") for (const line of op.more) visit(line);
    else if (op.op === "after" || op.op === "before") steps(op.steps);
    else if (op.op === "branch") {
      visit(op.branch.label);
      if (op.branch.endText !== undefined) visit(op.branch.endText);
      steps(op.branch.steps ?? []);
    }
  }
  return wordsOf(texts);
}

/** One rename or swap pair of a trade file, with its place in the file. */
export interface TradePair {
  trade: TradeId;
  flow: FlowLetter;
  kind: "rename" | "swap";
  /** The pair's path in the trade file: ["rename", "A", 7], or ["A", "ops", 3, "vary", "pf:x", "swap", 0]. */
  path: JsonPart[];
  first: string;
  second: string;
  /** The lines of its first and second sides in the trade file. */
  lines: [number, number];
  /** The step a swap's op names; null for a rename. */
  at: string | null;
}

/** The trade file's text (default: fixture set v1's copy). */
export function tradeText(id: TradeId, dir: string = TRADE_DIR): string {
  return readFileSync(`${dir.replace(/\/+$/, "")}/${id}.json`, "utf8");
}

/** Every rename pair and every swap pair of a trade, flow A's then flow B's, each in the file's order, with its lines. */
export function tradePairs(trade: LoadedTrade, text: string): TradePair[] {
  const lines = jsonLines(text);
  const lineOf = (path: readonly JsonPart[]): number => lines.get(JSON.stringify(path)) ?? 0;
  const raw = JSON.parse(text) as Record<string, unknown>;
  const out: TradePair[] = [];
  for (const flow of ["A", "B"] as const) {
    trade.flows[flow].rename.forEach(([first, second], k) => {
      const path = ["rename", flow, k];
      out.push({
        trade: trade.id,
        flow,
        kind: "rename",
        path,
        first,
        second,
        lines: [lineOf([...path, 0]), lineOf([...path, 1])],
        at: null,
      });
    });
    const swaps = (value: unknown, path: JsonPart[], at: string | null): void => {
      if (Array.isArray(value)) value.forEach((item, k) => swaps(item, [...path, k], at));
      else if (typeof value === "object" && value !== null)
        for (const [key, item] of Object.entries(value)) {
          if (key !== "swap" || !Array.isArray(item)) {
            swaps(item, [...path, key], at);
            continue;
          }
          item.forEach((pair, k) => {
            if (!Array.isArray(pair)) return;
            const sides = pair as unknown[];
            if (sides.length !== 2 || typeof sides[0] !== "string" || typeof sides[1] !== "string") return;
            const where = [...path, key, k];
            out.push({
              trade: trade.id,
              flow,
              kind: "swap",
              path: where,
              first: sides[0],
              second: sides[1],
              lines: [lineOf([...where, 0]), lineOf([...where, 1])],
              at,
            });
          });
        }
    };
    const block = raw[flow] as { ops?: unknown } | undefined;
    const ops = Array.isArray(block?.ops) ? (block.ops as unknown[]) : [];
    ops.forEach((op, n) => {
      const at = (op as { at?: unknown }).at;
      swaps(op, [flow, "ops", n], typeof at === "string" ? at : null);
    });
  }
  return out;
}

/**
 * Why a listed pair's first side matches nothing, as found (the first that holds): it stands in the master's own line
 * with the master's example words in a slot the trade fills otherwise ("slot"); in the master's other flow ("other
 * flow"); in a new side of the same trade's pairs that itself renames nothing laid there ("dead new side"); it is
 * another trade's first side, word for word ("other trade's pair"), or another trade's new side ("other trade's new
 * side"); or none of these ("no source found").
 */
export const REASONS = {
  slot: "a master line that differs only in a slot: the trade fills it otherwise",
  "other flow": "the master's line in the other flow only",
  "dead new side": "a new side of the trade's own pairs that is never laid here",
  "other trade's pair": "a copy of another trade's first side",
  "other trade's new side": "a copy of another trade's new side",
  "no source found": "no master line, other flow, own new side or other trade's pair found",
} as const;

export type Reason = keyof typeof REASONS;

/** One pair the lint lists. */
export interface FirstSideFinding extends TradePair {
  /** The trade file's name: `vehicle-wrap.json`. */
  file: string;
  reason: Reason;
  /** The report line: `vehicle-wrap.json:413-414 A rename[7]: <reason>`. */
  line: string;
}

/** What the lint gives: every pair it read, and the pairs it lists. */
export interface FirstSideReport {
  rule: typeof FIRST_SIDE_RULE;
  /** How many rename and swap pairs it read. */
  pairs: { rename: number; swap: number };
  /**
   * Pairs not listed that rename nothing all the same, counted: a first side that is master text the trade's earlier
   * pairs renamed first ("shadowed"), or words of the trade's own ops only, which come after the renames ("own ops").
   */
  unlisted: { shadowed: number; "own ops": number };
  findings: FirstSideFinding[];
}

/** A trade to lint: the loaded file and its text (for the lines). */
export interface LintedTrade {
  trade: LoadedTrade;
  text: string;
}

/** Where a pair stands in its file, as a report line names it: `rename[7]`, `ops[3].vary['pf:x'].swap[0]`. */
function whereOf(pair: TradePair): string {
  const parts = pair.kind === "rename" ? ["rename", ...pair.path.slice(2)] : pair.path.slice(1);
  let out = "";
  for (const part of parts)
    out +=
      typeof part === "number"
        ? `[${String(part)}]`
        : out === ""
          ? part
          : /^[A-Za-z_]\w*$/.test(part)
            ? `.${part}`
            : `['${part}']`;
  return out;
}

/** The report line of a listed pair. */
function reportLine(pair: TradePair, reason: Reason): string {
  return `${pair.trade}.json:${String(pair.lines[0])}-${String(pair.lines[1])} ${pair.flow} ${whereOf(pair)}: ${REASONS[reason]}`;
}

/**
 * The first-side lint over the trades given (each with its file's text), in the order given: every rename and swap pair
 * whose first side matches no text the master and the trade's own ops lay at its flow, with its file, lines and
 * reason. Never throws for what it finds.
 */
export function firstSideFindings(master: MasterGraphs, trades: readonly LintedTrade[]): FirstSideReport {
  // Each trade's pairs, and every first and new side of every trade, for the reasons.
  const pairsOf = trades.map(({ trade, text }) => tradePairs(trade, text));
  const firstsBy = new Map<string, Set<TradeId>>();
  const secondsBy = new Map<string, Set<TradeId>>();
  for (const list of pairsOf)
    for (const pair of list) {
      const firsts = firstsBy.get(pair.first) ?? new Set<TradeId>();
      firsts.add(pair.trade);
      firstsBy.set(pair.first, firsts);
      const seconds = secondsBy.get(pair.second) ?? new Set<TradeId>();
      seconds.add(pair.trade);
      secondsBy.set(pair.second, seconds);
    }
  const examples = { A: exampleWords(master, "A"), B: exampleWords(master, "B") };
  const counts = { rename: 0, swap: 0 };
  const unlisted = { shadowed: 0, "own ops": 0 };
  const findings: FirstSideFinding[] = [];

  trades.forEach(({ trade }, n) => {
    const pairs = pairsOf[n] ?? [];
    const read = {} as Record<
      FlowLetter,
      { master: Words; renamed: boolean[]; after: Words; ops: Words; seconds: Words }
    >;
    for (const flow of ["A", "B"] as const) {
      const words = masterWords(master, flow, trade);
      const run = runPairs(trade.flows[flow].rename, words);
      read[flow] = {
        master: words,
        renamed: run.renamed,
        after: run.words,
        ops: opWords(trade.flows[flow].ops),
        seconds: wordsOf(trade.flows[flow].rename.map(([, second]) => second)),
      };
    }
    for (const pair of pairs) {
      counts[pair.kind] += 1;
      const at = read[pair.flow];
      const other = read[pair.flow === "A" ? "B" : "A"];
      const inMaster = standsIn(pair.first, at.master);
      // A rename is matched when it renamed something (renameAll); a swap, when its first side stands in the master's
      // words as the trade's pairs leave them, where the swap runs.
      const matched =
        pair.kind === "rename"
          ? at.renamed[pair.path[2] as number] === true
          : inMaster || standsIn(pair.first, at.after);
      if (matched || inMaster) {
        if (!matched) unlisted.shadowed += 1;
        continue;
      }
      if (standsIn(pair.first, at.ops)) {
        if (pair.kind === "rename") unlisted["own ops"] += 1;
        continue;
      }
      const reason: Reason = standsIn(pair.first, examples[pair.flow])
        ? "slot"
        : standsIn(pair.first, other.master)
          ? "other flow"
          : standsIn(pair.first, at.seconds)
            ? "dead new side"
            : [...(firstsBy.get(pair.first) ?? [])].some((id) => id !== pair.trade)
              ? "other trade's pair"
              : [...(secondsBy.get(pair.first) ?? [])].some((id) => id !== pair.trade)
                ? "other trade's new side"
                : "no source found";
      findings.push({
        ...pair,
        file: `${pair.trade}.json`,
        reason,
        line: reportLine(pair, reason),
      });
    }
  });
  return { rule: FIRST_SIDE_RULE, pairs: counts, unlisted, findings };
}

/** One reason letter per reason, for the list by place (placesText). */
const LETTER: Readonly<Record<Reason, string>> = {
  slot: "s",
  "other flow": "o",
  "dead new side": "d",
  "other trade's pair": "p",
  "other trade's new side": "n",
  "no source found": "x",
};

/**
 * The listed pairs by place, one line per trade file, flow and kind: `vehicle-wrap.json A rename: 413p 417p ...`, each
 * entry its first side's line and its reason's letter (s slot, o other flow, d dead new side, p other trade's pair, n
 * other trade's new side, x no source found), in the order listed.
 */
export function placesText(findings: readonly FirstSideFinding[]): string {
  const lines: string[] = [];
  let head = "";
  let entries: string[] = [];
  for (const one of findings) {
    const next = `${one.file} ${one.flow} ${one.kind}`;
    if (next !== head) {
      if (entries.length > 0) lines.push(`${head}: ${entries.join(" ")}`);
      head = next;
      entries = [];
    }
    entries.push(`${String(one.lines[0])}${LETTER[one.reason]}`);
  }
  if (entries.length > 0) lines.push(`${head}: ${entries.join(" ")}`);
  return `${lines.join("\n")}\n`;
}

/** A line a person may read on a flow: its step, its field there and its words. */
export interface ReadLine {
  step: string;
  /** `does`, `more[1]`, `say[0][2]`, `vary.booking:sentnow.say[1][2]`, `branch 'Matches'`. */
  field: string;
  text: string;
}

/** Whether a variant's key names switch "verify": its words are read only with it on, and C4 keeps it off. */
function verifyKey(key: string): boolean {
  return key.split("+").some((part) => part.trim() === "pf:verify");
}

/**
 * Every word a person may read on a flow while switch "verify" is off: each step and branch not switched off (an `off`
 * op, C4, C8), its title, does, rule, question, time, more, messages, form and table, its variants but those keyed on
 * switch "verify", and each branch's label and end words. A step's own `when` is not read: a step lit only on some
 * paths still counts.
 */
export function readLines(steps: readonly AppliedStep[], out: ReadLine[] = []): ReadLine[] {
  const deep = (value: unknown, step: string, field: string): void => {
    if (typeof value === "string") out.push({ step, field, text: value });
    else if (Array.isArray(value)) value.forEach((item, k) => deep(item, step, `${field}[${String(k)}]`));
    else if (typeof value === "object" && value !== null)
      for (const [key, item] of Object.entries(value)) deep(item, step, `${field}.${key}`);
  };
  for (const step of steps) {
    if (step.off !== undefined) continue;
    for (const key of ["title", "does", "rule", "q", "t", "more", "say", "form", "table"])
      if (step[key] !== undefined) deep(step[key], step.id, key);
    for (const [key, entry] of Object.entries(step.vary ?? {}))
      if (!verifyKey(key)) deep(entry, step.id, `vary.${key}`);
    for (const branch of step.branches ?? []) {
      if (branch.off !== undefined) continue;
      out.push({ step: step.id, field: `branch '${branch.label}'`, text: branch.label });
      if (typeof branch.endText === "string")
        out.push({ step: step.id, field: `branch '${branch.label}' endText`, text: branch.endText });
      readLines(branch.steps, out);
    }
  }
  return out;
}

/**
 * The phrases a check claim is read by here: C7's (c7.ts WORD_PATTERNS), and a paper confirmed, checked, verified or
 * looked up on or with a lookup or records, which C7's read only as checked, verified or looked up ("Everyone's
 * licenses are confirmed on the state's lookup.", the first side of 11 trade files; T-140 round 5's note b).
 */
export const READ_PATTERNS: readonly ClaimPattern[] = [
  ...WORD_PATTERNS,
  {
    pattern:
      /\b(?:confirmed|checked|re-?checked|verified|looked\s+up)\s+(?:again\s+)?(?:on|against|with)\s+(?:the|an?)\s+[\w' ]{0,40}?(?:lookup|records?)\b/i,
    reach: 3,
  },
];

/** The sentences of a text that hold a check claim by READ_PATTERNS, C7's own OWN_WORD left out. */
function claimSentences(text: string): string[] {
  return findClaims(text.split(OWN_WORD).join("§"), READ_PATTERNS);
}

/** Whether a text holds a check claim by READ_PATTERNS, C7's own OWN_WORD left out. */
export function holdsClaim(text: string): boolean {
  return claimSentences(text).length > 0;
}

/**
 * A sentence that says it holds only with checks on, or that checks are off now: the master's own S2-11 ("License
 * checks are off for now (D96). ... With checks on, Rosie checks the name, kind, status, places and end date.", which C4
 * keeps built because its words say so) and the "Means ..." lines of C4's off branches ("(license checks only; off
 * now)", "(checks on only)").
 */
const CHECKS_ON_ONLY = /\b(?:with checks on|checks on only|off now|checks are off)\b/i;

/**
 * Whether a text claims a check made while switch "verify" is off: a sentence that holds a check claim (READ_PATTERNS)
 * and does not say it holds only with checks on, or that checks are off (CHECKS_ON_ONLY).
 */
export function claimsWhileOff(text: string): boolean {
  return claimSentences(text).some((sentence) => !CHECKS_ON_ONLY.test(sentence));
}

/**
 * The trade as the bundle compiles it (emit.ts emitBundle's trade line): C5's facts, C7's marks, C8's void offs dropped,
 * then the words ops a Master Correction already corrected.
 */
export function bundleTrade(master: MasterGraphs, trade: LoadedTrade): LoadedTrade {
  return correctWordsOps(master, voidOffs(markClaims(correctTrade(trade).trade).trade).trade).trade;
}

/** Each trade as the bundle compiles it over one master, made once per loaded trade. */
const bundleCache = new WeakMap<MasterGraphs, WeakMap<LoadedTrade, LoadedTrade>>();

/** The lines a person may read on one compiled flow of a trade (bundleTrade, applyTrade, then Master Corrections). */
export function compiledLines(master: MasterGraphs, trade: LoadedTrade, flow: FlowLetter): ReadLine[] {
  const cache = bundleCache.get(master) ?? new WeakMap<LoadedTrade, LoadedTrade>();
  bundleCache.set(master, cache);
  let bundled = cache.get(trade);
  if (bundled === undefined) {
    bundled = bundleTrade(master, trade);
    cache.set(trade, bundled);
  }
  return readLines(applyCorrections(applyTrade(master[flow], bundled)).flow.steps);
}

/** The master's own lines that hold a check claim and that a person may read on a flow while verify is off. */
export function masterClaimLines(master: MasterGraphs, flow: FlowLetter): ReadLine[] {
  return readLines(correctedFlow(master, flow).flow.steps).filter((line) => holdsClaim(line.text));
}

/** A text's words, lower case, without punctuation. */
function plainWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .split(/[^a-z0-9']+/)
    .filter((word) => word !== "");
}

/** How many words in a row a first side shares with a line, at the least, to be meant for it. */
export const RUN = 5;

/** The words in a row a first side must share with a line to be meant for it: RUN, or all its words when fewer (3 at the least). */
function needed(first: string): number {
  const count = plainWords(first).length;
  return count < 3 ? Number.POSITIVE_INFINITY : Math.min(RUN, count);
}

/** Whether a first side was meant for a line: they share `needed` words in a row (case and punctuation aside). */
export function meantFor(first: string, line: string): boolean {
  return sharedRun(first, line) >= needed(first);
}

/** The longest run of words in a row two texts share (case and punctuation aside). */
export function sharedRun(first: string, line: string): number {
  const own = plainWords(first);
  const other = ` ${plainWords(line).join(" ")} `;
  let best = 0;
  for (let k = 0; k < own.length; k += 1)
    for (let n = best + 1; k + n <= own.length; n += 1) {
      if (!other.includes(` ${own.slice(k, k + n).join(" ")} `)) break;
      best = n;
    }
  return best;
}

/** Where a listed pair was meant to rename, found by compiling, and what a person reads there. */
export interface PairPlace {
  /** The line a person reads that the first side was meant for (meantFor) and shares the most words in a row with, or null. */
  line: ReadLine | null;
  /** How many words in a row they share. */
  run: number;
  /** Whether that line claims a check made while verify is off (claimsWhileOff). */
  claim: boolean;
}

/**
 * Where a first side was meant to rename on a compiled flow (compiledLines): of the lines a person reads there that it
 * was meant for (meantFor), the one it shares the most words in a row with (the first such in page order); null when it
 * was meant for none.
 */
export function placeOf(first: string, lines: readonly ReadLine[]): PairPlace {
  let best: ReadLine | null = null;
  let run = needed(first) - 1;
  for (const line of lines) {
    const shared = sharedRun(first, line.text);
    if (shared > run) {
      best = line;
      run = shared;
    }
  }
  return best === null
    ? { line: null, run: 0, claim: false }
    : { line: best, run, claim: claimsWhileOff(best.text) };
}

/** A listed pair meant for one of the master's claim lines, and what a person reads there on the trade's compiled flow. */
export interface PairAtClaimLine {
  finding: FirstSideFinding;
  /** The master's own line the pair was meant for (masterClaimLines). */
  line: ReadLine;
  /** What a person reads at the same step and field on the trade's compiled flow, or null where nothing is read there. */
  reads: string | null;
  /** Whether that text claims a check made while verify is off (claimsWhileOff). */
  claim: boolean;
}

/**
 * The listed pairs (firstSideFindings) meant for one of the master's own claim lines on their flow (masterClaimLines,
 * meantFor), each with what a person reads at that line's step and field on the trade's compiled flow (compiledLines)
 * while verify is off, and whether it claims a check made then (claimsWhileOff). `trades` are the loaded trades, by id.
 */
export function pairsAtClaimLines(
  master: MasterGraphs,
  findings: readonly FirstSideFinding[],
  trades: ReadonlyMap<TradeId, LoadedTrade>,
): PairAtClaimLine[] {
  const claims = { A: masterClaimLines(master, "A"), B: masterClaimLines(master, "B") };
  const compiled = new Map<string, ReadLine[]>();
  const out: PairAtClaimLine[] = [];
  for (const finding of findings)
    for (const line of claims[finding.flow]) {
      if (!meantFor(finding.first, line.text)) continue;
      const key = `${finding.trade} ${finding.flow}`;
      let lines = compiled.get(key);
      if (lines === undefined) {
        const trade = trades.get(finding.trade);
        if (trade === undefined) throw new Error(`${finding.file}: the trade was not given`);
        lines = compiledLines(master, trade, finding.flow);
        compiled.set(key, lines);
      }
      const read = lines.find((one) => one.step === line.step && one.field === line.field);
      const reads = read?.text ?? null;
      out.push({ finding, line, reads, claim: reads !== null && claimsWhileOff(reads) });
    }
  return out;
}
