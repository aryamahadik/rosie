// A kind's plug-in as S1-11 loads it (T-634 part 1; DL-961 card E; DL-988): one trade's compiled overlay in the turn's
// pinned bundle (K-01 v1 tradeOverlay, stored whole under bundle/<hash>/<build>/trade/<trade id>), which K-05 v1.19's
// table names as S1-11's source ("The 11 blocks of a listed kind, whole": T-1455's README, section "What journey 1's
// first calls read"). The overlay is narrowed field by field, and refused whole (overlayNotWellFormed) when a field
// S1-11 loads is not K-01 v1's shape, never read in part:
//
//   - the 11 free-text plug-in blocks (K-01 v1 pluginText; K-24 v1 picked_kind_texts_key_known; T-143's key map sends
//     each to pluginText/<key>; Q-39's default: stored whole, sub-keys guidance only), each kept byte for byte as the
//     overlay holds it, the trade file's value written as JSON text (K-24 rule 6: `block is json`), and each checked to
//     be JSON text before any row names it, so the commit never meets K-24's CHECK with one;
//   - the facts (K-01 v1 tradeOverlay.facts: a list of names, or null for none), with MC C5's fill: insurance, the only
//     trade of 243 with no pf.facts, takes cpa.json's list (video, forms, firststeps, documents, in cpa.json's order:
//     QUESTIONS CQ-129 (a)'s default). The compiler applies it at build time (T-139: compiler/src/corrections/c5.ts, in
//     emitBundle), so bundle v1's overlay already lists them and the fill here changes nothing; an overlay built before
//     that change lists none, and the same fill applies, so S1-11 never loads insurance with every fact-gated branch on;
//   - each flow's sign-up settings (K-01 v1 tradeSettings: arrive window, setstart or { window: hours }; the free-cancel
//     time as worded, or null when empty), with MC C5's start values for a flow that has none (arrive window, the
//     free-cancel time empty: the 12 trades with no pf.settings, which the compiled overlay already holds so). Every
//     flow's settings are marked to confirm at S1-21: FS rows H06 and H07 start from pf.settings and the owner keeps or
//     changes them there, and an empty free-cancel time has nothing to keep, so S1-21 asks for it (MC C5: "the owner
//     confirms both at sign-up").
//
// What S1-11 writes is the 11 blocks alone (K-09 README's S1-11 row: picked_kind_texts, one row per pf key). The facts
// and settings are typed keys, which K-24 never stores per pick (picked_kind_texts_key_known refuses them): the trade's
// defaults are K-24's kinds and kind_flows (the catalog seed copies them from these overlays, README rule 7), and the
// business's own are K-23's company_kinds (S1-04) and flow_defaults (S1-21). So they are loaded here, checked, and handed
// on with the blocks, from the same overlay, one source in a call (T-1455's README, "T-634 ... reads C5's facts and
// settings ... from the same overlay"). Nothing here reads the database, logs, or puts a block's words in an error.

import type { FlowLetter } from "../../../commit/walk";
import type { SetupKey } from "../../../gate/framework";
import { PlugInRefusedError } from "./errors";

/**
 * The 11 free-text pf keys S1-11 gives, in K-01 v1 pluginText's order, which is S1-11's gives order in the master
 * (MASTER-FLOW-A S1-11: "gives pf.license pf.services ... pf.edges") and commit-s1-02.json's stated gives after kinds.
 */
export const PF_TEXT_KEYS = [
  "pf.license",
  "pf.services",
  "pf.questions",
  "pf.safety",
  "pf.first_steps",
  "pf.visit",
  "pf.money",
  "pf.messages",
  "pf.staff",
  "pf.rules",
  "pf.edges",
] as const satisfies readonly SetupKey[];

/** One of the 11 free-text pf keys. */
export type PfTextKey = (typeof PF_TEXT_KEYS)[number];

/** MC C5's trade with no pf.facts. */
export const C5_FACTS_TRADE = "insurance";

/** MC C5's facts for insurance: cpa.json's list, in cpa.json's order (CQ-129 (a)'s default; c5.ts INSURANCE_FACTS). */
export const C5_INSURANCE_FACTS: readonly string[] = ["forms", "firststeps", "documents", "video"];

/** Where the owner confirms a plug-in's sign-up settings: S1-21 (FS rows H06, H07; MC C5). */
export const CONFIRM_AT = "S1-21";

/** One plug-in text block, whole: the trade file's value as JSON text, exactly as the pinned overlay holds it. */
export interface PlugInBlock {
  readonly key: PfTextKey;
  readonly block: string;
}

/** One flow's sign-up settings as S1-11 loads them (K-01 v1 tradeSettings, with MC C5's start values). */
export interface PlugInSettings {
  /** H07: an arrival window or a set start time. */
  readonly arrive: "window" | "setstart";
  /** The window's length in hours when the trade gives one ({ window: 2 }), else null: the master's window. */
  readonly windowHours: number | null;
  /** H06: the free-cancel time as the trade words it, or null when empty (MC C5). */
  readonly cutoff: string | null;
  /** The step where the owner confirms them (FS rows H06, H07): always S1-21. */
  readonly confirmAt: typeof CONFIRM_AT;
}

/** A kind's plug-in, as S1-11 loads it from the pinned bundle's trade overlay. */
export interface LoadedPlugIn {
  /** The trade's id, which K-24's kinds.id and a listed pick's kind_id hold (K-01 v1 tradeId). */
  readonly kindId: string;
  /** The 11 plug-in text blocks, one per pf key, in PF_TEXT_KEYS order. */
  readonly blocks: readonly PlugInBlock[];
  /** The facts, with MC C5's fill; null when the trade lists none (every fact-gated branch shows: SPEC-master 5d). */
  readonly facts: readonly string[] | null;
  /** Each flow's sign-up settings, with MC C5's start values, marked to confirm at S1-21. */
  readonly settings: Readonly<Record<FlowLetter, PlugInSettings>>;
}

/** K-01 v1 name: a fact's form (lowercase letters and digits). */
const NAME = /^[a-z][a-z0-9]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The overlay is not K-01 v1's tradeOverlay of the kind: refused whole, naming the trade id and never a value. */
function notWellFormed(kindId: string): PlugInRefusedError {
  return new PlugInRefusedError("overlayNotWellFormed", ["S1-11", kindId]);
}

/** Whether `text` is JSON text, as K-24's `block is json` reads a block. */
function isJsonText(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** The 11 blocks: exactly K-01 v1 pluginText's keys, each a string of JSON text, kept as the overlay holds it. */
function blocksOf(value: unknown, kindId: string): PlugInBlock[] {
  if (!isRecord(value)) throw notWellFormed(kindId);
  const keys = Object.keys(value);
  if (
    keys.length !== PF_TEXT_KEYS.length ||
    !keys.every((key) => (PF_TEXT_KEYS as readonly string[]).includes(key))
  ) {
    throw notWellFormed(kindId);
  }
  return PF_TEXT_KEYS.map((key) => {
    const block = value[key];
    if (typeof block !== "string" || !isJsonText(block)) throw notWellFormed(kindId);
    return { key, block };
  });
}

/** The facts, a list of names or null, with MC C5's fill for insurance when it lists none. */
function factsOf(value: unknown, kindId: string): string[] | null {
  if (value === null) return kindId === C5_FACTS_TRADE ? [...C5_INSURANCE_FACTS] : null;
  if (!Array.isArray(value)) throw notWellFormed(kindId);
  const listed: unknown[] = value;
  return listed.map((fact) => {
    if (typeof fact !== "string" || !NAME.test(fact)) throw notWellFormed(kindId);
    return fact;
  });
}

/** One flow's settings (K-01 v1 tradeSettings), or MC C5's start values when the flow has none. */
function settingsOf(flow: unknown, kindId: string): PlugInSettings {
  if (!isRecord(flow)) throw notWellFormed(kindId);
  const { settings } = flow;
  if (settings === undefined)
    return { arrive: "window", windowHours: null, cutoff: null, confirmAt: CONFIRM_AT };
  if (!isRecord(settings) || Object.keys(settings).some((key) => key !== "arrive" && key !== "cutoff")) {
    throw notWellFormed(kindId);
  }
  const { arrive, cutoff } = settings;
  if (cutoff !== null && (typeof cutoff !== "string" || cutoff.trim() === "")) throw notWellFormed(kindId);
  if (arrive === "window" || arrive === "setstart") {
    return { arrive, windowHours: null, cutoff, confirmAt: CONFIRM_AT };
  }
  if (!isRecord(arrive) || Object.keys(arrive).length !== 1) throw notWellFormed(kindId);
  const hours = arrive.window;
  if (typeof hours !== "number" || !Number.isSafeInteger(hours) || hours < 1) throw notWellFormed(kindId);
  return { arrive: "window", windowHours: hours, cutoff, confirmAt: CONFIRM_AT };
}

/**
 * The plug-in of the kind `kindId` from the pinned bundle's trade overlay `overlay` (parsed): its 11 text blocks whole,
 * its facts and each flow's settings with MC C5's fills. Throws PlugInRefusedError (overlayNotWellFormed) when the overlay
 * is not K-01 v1's tradeOverlay of that kind. The overlay given is not changed.
 */
export function loadPlugIn(overlay: unknown, kindId: string): LoadedPlugIn {
  if (!isRecord(overlay) || overlay.contract !== "bundle.v1") throw notWellFormed(kindId);
  const { trade, flows } = overlay;
  if (!isRecord(trade) || trade.id !== kindId || !isRecord(flows)) throw notWellFormed(kindId);
  if (!Object.hasOwn(overlay, "facts")) throw notWellFormed(kindId);
  const blocks = blocksOf(overlay.pluginText, kindId);
  const facts = factsOf(overlay.facts, kindId);
  const settings = { A: settingsOf(flows.A, kindId), B: settingsOf(flows.B, kindId) };
  return { kindId, blocks, facts, settings };
}
