// The plug-in key map (T-143; Master Corrections R3; Q-39's default; K-01 v1 keyMap).
//
// Architecture section 12 says the compiler must "map the 2,344 plug-in keys, or mark them guidance only". Master
// Corrections R3 fixes how: code reads pf.facts, pf.switches, pf.settings and money.<flow> by name, as typed fields;
// every other pf key is free text, stored whole as one text block for the AI. Q-39's default settles what is left
// open: the 11 free-text pf keys are mapped as whole text blocks, and their sub-keys are guidance only (code reads
// none of them; FRONTEND-SPEC line 565 says they differ from file to file).
//
// What this file builds:
//
//   buildKeyMap()       K-01 v1's `keyMap` (the bundle's key-map.json): one entry per top key of a trade file, and
//                       `subKeys: "guidance"`. It has no room for a sub-key list or a count (additionalProperties is
//                       false), so those travel beside it:
//   countPlugInKeys()   the counted sub-keys of the trade files given to it: distinct top keys, distinct sub-key
//                       names, each sub-key under its parent key with the number of trades that use it (guidance
//                       only), and the page's 2,344 beside the counted total, marked not reproduced.
//   resolvePfKey()      what a pf key named by a step resolves to: a typed field, or a text block (a sub-key named
//                       under a text block resolves to that block, as guidance).
//   stepPfNeeds()       every step entry of the master flows that needs a pf key, with the keys it needs.
//
// It reads trades only through the loaders of T-132 and T-133 (a LoadedTrade holds each free-text block as the
// file's JSON text, unchanged, so a sub-key is a key of that text read back). It never reads a file itself.
import type { FlowGraph, FlowLetter } from "../graph/types.ts";
import { PF_TEXT_KEYS, type LoadedTrade, type PfTextKey, type TradeId } from "../load/trade";

/** How a top key of a trade file reaches the compiled overlay (K-01 keyMapEntry.as). */
export type KeyMapAs = "typed" | "textBlock" | "ops" | "leftOut";

/** One entry of the key map (K-01 keyMapEntry). `to` is left out for `leftOut`. */
export interface KeyMapEntry {
  key: string;
  as: KeyMapAs;
  to?: string;
  why: string;
}

/** K-01 v1's keyMap: the shared list the compiler writes into the manifest (K-01 sharedLists.keyMap). */
export interface KeyMap {
  keys: KeyMapEntry[];
  subKeys: "guidance";
}

/** The number architecture section 12 gives: "the 2,344 plug-in keys". No count of the trade files gives it. */
export const PAGE_PLUGIN_KEY_COUNT = 2344;

const TEXT_BLOCK_WHY =
  "MC R3: free text stored whole as a text block for the AI; Q-39 default (sub-keys guidance only); FRONTEND-SPEC.md line 565";
const AUTHORING_WHY = "MC R2: authoring fields";
const SAMPLE_WHY = "MC C6: the sample cast, names and story are illustrations";

/** The typed pf keys: the ones code reads by name (MC R3), with where each lands in a tradeOverlay. */
const TYPED_ENTRIES: readonly KeyMapEntry[] = [
  { key: "id", as: "typed", to: "trade/id", why: "SPEC-prof 3; MC R3 (top keys read by name)" },
  { key: "name", as: "typed", to: "trade/name", why: "SPEC-prof 3" },
  { key: "style", as: "typed", to: "trade/style", why: "SPEC-prof 3" },
  { key: "pattern", as: "typed", to: "trade/pattern", why: "SPEC-prof 2 items 5 and 8" },
  {
    key: "pf.facts",
    as: "typed",
    to: "facts",
    why: "MC R3: code reads pf.facts by name; MC C5's fills",
  },
  {
    key: "pf.switches",
    as: "typed",
    to: "flows/<flow>/switches",
    why: "MC R3; SPEC-master 5b (a per-flow value split per flow); no2 from S1-62 (SPEC-master 5j)",
  },
  {
    key: "pf.settings",
    as: "typed",
    to: "flows/<flow>/settings",
    why: "MC R3; MC C5 (none: arrive window and an empty cutoff)",
  },
  {
    key: "money",
    as: "typed",
    to: "flows/<flow>/money",
    why: "MC R3: money.<flow> read by name; SPEC-prof 3",
  },
];

/** The top keys compiled into the overlay's ops, renames and slot rows (SPEC-prof 3). */
const OPS_ENTRIES: readonly KeyMapEntry[] = [
  {
    key: "rename",
    as: "ops",
    to: "flows/<flow>/rename",
    why: "SPEC-prof 3 'rename'; overlay-core.js line 1800",
  },
  { key: "slots", as: "ops", to: "flows/<flow>/slotRows", why: "overlay-core.js profRecord line 1867" },
  { key: "A", as: "ops", to: "flows/A/ops", why: "SPEC-prof 3 'ops'; MC C8 (void offs dropped)" },
  { key: "B", as: "ops", to: "flows/B/ops", why: "SPEC-prof 3 'ops'; MC C8 (void offs dropped)" },
];

/** The top keys the overlay leaves out: authoring fields (MC R2) and the sample cast and story (MC C6). */
const LEFT_OUT_ENTRIES: readonly KeyMapEntry[] = [
  ...["notes", "basis", "keep", "from", "splitsKept", "keep_why"].map((key): KeyMapEntry => ({
    key,
    as: "leftOut",
    why: AUTHORING_WHY,
  })),
  ...["cast", "names", "story"].map((key): KeyMapEntry => ({ key, as: "leftOut", why: SAMPLE_WHY })),
];

/**
 * K-01 v1's key map: the typed keys, the 11 free-text keys as whole text blocks, the ops keys and the left-out
 * ones, with `subKeys: "guidance"` (Q-39's default). Every entry is a fresh object.
 */
export function buildKeyMap(): KeyMap {
  const textBlocks = PF_TEXT_KEYS.map((key): KeyMapEntry => ({
    key,
    as: "textBlock",
    to: `pluginText/${key}`,
    why: TEXT_BLOCK_WHY,
  }));
  const keys = [...TYPED_ENTRIES, ...textBlocks, ...OPS_ENTRIES, ...LEFT_OUT_ENTRIES];
  return { keys: keys.map((entry) => ({ ...entry })), subKeys: "guidance" };
}

/** What a pf key named by a step resolves to. */
export interface PfResolution {
  /** The key map entry it resolves to. */
  entry: KeyMapEntry;
  /** Where it lands in a tradeOverlay (the entry's `to`). */
  target: string;
  /** true when the key named a sub-key under a text block: it resolves to the whole block, as guidance. */
  guidance: boolean;
}

/**
 * Resolves a pf key (`pf.license`, `pf.facts`, or a sub-key such as `pf.money.tips`) to the field or text block it
 * lands in, or null when the map has no such key. Only typed and text-block entries resolve: they are the ones a
 * step can need (ops and left-out keys are not plug-in keys).
 */
export function resolvePfKey(map: KeyMap, key: string): PfResolution | null {
  for (const entry of map.keys) {
    if (entry.as !== "typed" && entry.as !== "textBlock") continue;
    if (!entry.key.startsWith("pf.")) continue;
    if (entry.to === undefined) continue;
    if (key === entry.key) return { entry, target: entry.to, guidance: false };
    if (entry.as === "textBlock" && key.startsWith(`${entry.key}.`) && key.length > entry.key.length + 1)
      return { entry, target: entry.to, guidance: true };
  }
  return null;
}

/** One step entry that needs plug-in keys. */
export interface StepPfNeed {
  flow: FlowLetter;
  step: string;
  /** The pf keys in the step's `needs`, in the step's order. */
  keys: string[];
}

/** Every step entry of the loaded flows (branch steps included) whose `needs` names a pf key. */
export function stepPfNeeds(graphs: Record<FlowLetter, FlowGraph>): StepPfNeed[] {
  const out: StepPfNeed[] = [];
  for (const flow of ["A", "B"] as const) {
    for (const step of Object.values(graphs[flow].steps)) {
      const keys = (step.needs ?? []).filter((need) => need.startsWith("pf."));
      if (keys.length > 0) out.push({ flow, step: step.id, keys });
    }
  }
  return out;
}

/** One sub-key under a free-text pf key, with the number of trades whose file has it. */
export interface SubKeyUse {
  name: string;
  trades: number;
}

/** The sub-keys of one free-text pf key, in name order. Guidance only: code reads none of them (Q-39). */
export interface SubKeyGuidance {
  key: PfTextKey;
  subKeys: SubKeyUse[];
}

/** What was counted over the trade files given to countPlugInKeys. */
export interface PlugInKeyCount {
  /** The number of trade files counted. */
  trades: number;
  /** Distinct top pf keys that some trade writes, sorted (14: the 11 free-text keys and the three typed ones). */
  topKeys: string[];
  /** Distinct sub-key names under the free-text keys, the parent ignored, sorted (2,369 on today's 243 files). */
  subKeyNames: string[];
  /** The same names lowercased, distinct (2,362 on today's 243 files). */
  subKeyNamesLowercase: number;
  /** Distinct `pf.<key>.<sub-key>` pairs under the 11 free-text keys (2,755). */
  textPairs: number;
  /** Distinct `pf.<key>.<name>` pairs under the typed keys: switch names and setting names (7). */
  typedPairs: number;
  /** Pairs under the free-text keys that exactly one trade uses, and that two or more use (1,833 and 922). */
  pairsUsedByOneTrade: number;
  pairsUsedByTwoOrMore: number;
  /** The page's number, 2,344, kept beside the count. */
  pageCount: number;
  /** false: no count of the trade files gives the page's number (specs.md section 5). */
  pageCountReproduced: boolean;
}

/** The count and the guidance list of the trade files. */
export interface PlugInKeyReport {
  count: PlugInKeyCount;
  guidance: SubKeyGuidance[];
}

function subKeysOf(block: string, at: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(block);
  } catch (error) {
    throw new Error(
      `${at}: the text block is not JSON text (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.keys(value);
}

/**
 * Counts the plug-in keys of the loaded trades. A sub-key is a key of a free-text block's value one level down (a
 * block that is a list or a plain text has none). The count never shapes itself to a target: the page's 2,344 is
 * carried as given, and `pageCountReproduced` says whether the counted names equal it.
 */
export function countPlugInKeys(trades: Record<TradeId, LoadedTrade>): PlugInKeyReport {
  const ids = Object.keys(trades).sort();
  const top = new Set<string>();
  const names = new Set<string>();
  const lower = new Set<string>();
  const typedPairs = new Set<string>();
  // parent key -> sub-key name -> trades that use it (a Map, since a sub-key may be named __proto__)
  const uses = new Map<PfTextKey, Map<string, number>>(PF_TEXT_KEYS.map((key) => [key, new Map()]));

  for (const id of ids) {
    const trade = trades[id];
    if (trade === undefined) throw new Error(`${id}: not loaded`);
    if (trade.facts !== null) top.add("pf.facts");
    if (trade.switches !== null) {
      top.add("pf.switches");
      for (const name of Object.keys(trade.switches)) typedPairs.add(`pf.switches.${name}`);
    }
    if (trade.settings !== null) {
      top.add("pf.settings");
      for (const name of Object.keys(trade.settings)) typedPairs.add(`pf.settings.${name}`);
    }
    for (const key of PF_TEXT_KEYS) {
      top.add(key); // the loader refuses a trade file without all 11 free-text blocks
      const parent = uses.get(key);
      if (parent === undefined) throw new Error(`${key}: no table`);
      for (const name of new Set(subKeysOf(trade.pluginText[key], `${id}.${key}`))) {
        names.add(name);
        lower.add(name.toLowerCase());
        parent.set(name, (parent.get(name) ?? 0) + 1);
      }
    }
  }

  const guidance: SubKeyGuidance[] = PF_TEXT_KEYS.map((key) => ({
    key,
    subKeys: [...(uses.get(key) ?? new Map<string, number>())]
      .map(([name, count]): SubKeyUse => ({ name, trades: count }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  }));
  const pairCounts = guidance.flatMap((entry) => entry.subKeys.map((sub) => sub.trades));
  const subKeyNames = [...names].sort();
  return {
    count: {
      trades: ids.length,
      topKeys: [...top].sort(),
      subKeyNames,
      subKeyNamesLowercase: lower.size,
      textPairs: pairCounts.length,
      typedPairs: typedPairs.size,
      pairsUsedByOneTrade: pairCounts.filter((n) => n === 1).length,
      pairsUsedByTwoOrMore: pairCounts.filter((n) => n >= 2).length,
      pageCount: PAGE_PLUGIN_KEY_COUNT,
      pageCountReproduced: subKeyNames.length === PAGE_PLUGIN_KEY_COUNT,
    },
    guidance,
  };
}

const commas = (n: number): string => n.toLocaleString("en-US");

/** The count report as the lines the card asks to print: counted numbers, and the page's number beside them. */
export function formatCountReport(count: PlugInKeyCount): string[] {
  return [
    `Plug-in key count over ${commas(count.trades)} trade files (Q-39: sub-keys are guidance only)`,
    `  distinct top keys: ${commas(count.topKeys.length)} (${count.topKeys.join(", ")})`,
    `  distinct sub-key names under the 11 free-text keys, parent ignored: ${commas(count.subKeyNames.length)}`,
    `  the same, lowercased: ${commas(count.subKeyNamesLowercase)}`,
    `  distinct pf.<key>.<sub-key> pairs: ${commas(count.textPairs)} free text, ${commas(count.typedPairs)} typed (${commas(count.textPairs + count.typedPairs)} in all)`,
    `  pairs used by one trade: ${commas(count.pairsUsedByOneTrade)}; by two or more: ${commas(count.pairsUsedByTwoOrMore)}`,
    count.pageCountReproduced
      ? `  the page's ${commas(count.pageCount)}: reproduced`
      : `  the page's ${commas(count.pageCount)}: not reproduced (no count of these files gives it; the closest is ${commas(count.subKeyNames.length)} distinct sub-key names)`,
  ];
}
