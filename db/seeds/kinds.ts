// T-212: the kinds seed (C-155, C-160; K-24 v1 kinds of work, frozen: contracts/db-schema/kinds-of-work, its table list
// and its README's rules 1 to 7; K-01 v1's key map, T-143; Master Corrections R3 and C5; build prompt rule 9). It fills
// K-24's catalog (migration 0021) from the 243 trade files, and gives each demo shop its kind of work with the trade
// file's 11 plug-in text blocks. It runs after the core seed (core.ts, T-200) and the setup seed (setup-business.ts,
// T-213), whose company kinds the demo shops' kinds are placed in:
//   kinds              one row per trade file: its id (the file's name), name, style (the booking type), pattern and
//                      pf.facts; insurance, the one trade with no pf.facts, takes the list cpa.json has (MC C5)
//   kind_flows         two rows per trade file, flows A and B: money.<flow>'s main path and the paths it lists; the
//                      switches on in the flow as K-01's tradeFlow has them (pf.switches split per flow, no2 from the $2
//                      split: compiler/src/path tradeSwitches, T-136); and pf.settings for the flow as K-01's
//                      tradeSettings reads them, with MC C5's start values where the file gives none (the 12 trades with
//                      no pf.settings, and any flow a file leaves out): arrive window and an empty cutoff (null). A
//                      window of hours ({ "window": 2 }) is arrive window with its hours; a cutoff is kept as worded.
//   picked_kinds       pick-demo-<shop>: each of the 243 demo shops with an owner form names its one kind of work, the
//                      shop's id (S1-02, a listed kind, first named), in the shop's own name for it, placed in the
//                      company kind the setup seed made (company-demo-<shop> at biz-demo-<shop>)
//   picked_kind_texts  the pick's 11 plug-in text blocks, pf.license to pf.edges (the key map's text blocks), each its
//                      trade file's value stored whole as JSON text, unchanged (K-01 pluginText: JSON.stringify of the
//                      value as parsed, T-133's loader). No sub-key of a block is read.
//
//   const result = await seedKinds(sql);   // result.tables.kinds: { rows: 243, inserted: 243, kept: 0 }
//
// What is read, and from where (rule 9; MC R3: code reads pf.facts, pf.switches, pf.settings and money.<flow> by name,
// and every other pf.* value is free text, stored whole and never parsed):
//   - the trade files, fixtures/master/engine/work/prof/<id>.json: T-130's vendored copy of the 243 trade files fixture
//     set v1 was made from (fixtures/v1/INPUTS.sha256 lists them at the same hashes), checked against
//     fixtures/master/SHA256SUMS and read by their top keys through T-133's loader (compiler/src/load/trade.ts). The rest
//     of a trade file (money examples, amounts, services, renames, ops, slot rows, the sample cast) is K-01's bundle and
//     is never stored here (K-24 README "Who owns what").
//   - the demo shops, fixtures/v1/test-kit/shops/, checked against fixtures/v1/MANIFEST.sha256, through the setup seed's
//     own plan (setupPlanOf), so each pick names the company kind that seed wrote and is dated as its rows are: when
//     fixture set v1 was made (test-kit/COVERAGE.md line 3). test-mixed-A and -B have no profession, so no kind.
//
// In order, stopping at the first failure: opens and checks both sets against their sha256 lists before any file is
// parsed (lib/fixture-set.ts for fixture set v1; verifyTradeSet below for the trade files), so only bytes that were
// hashed are parsed, and nothing is read outside fixtures/; reads every trade file and refuses, naming the file, any value
// it does not know how to read rather than guess; then, in one transaction as the job role rosie_job with no business
// scope (T-191; K-24 README rule 2: the catalog seed job writes kinds and kind_flows), checks that the setup seed's
// company kinds are there and writes the rows.
//
// Idempotent, as the core and setup seeds: a row is inserted only when its primary key is free (ON CONFLICT DO NOTHING),
// and nothing is updated or deleted, so a second run writes nothing and leaves every row as it was, version included; a
// row that went missing is written again as the first run wrote it. A clash on any other key (a second pick for one
// company kind) is an error, and the transaction rolls back. Nothing is printed: the caller prints the counts this
// returns.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { buildKeyMap } from "../../compiler/src/keymap/keymap";
import {
  type LoadedTrade,
  parseTrade,
  PF_TEXT_KEYS,
  type PfTextKey,
  type TradeSettings,
} from "../../compiler/src/load/trade";
import { tradeSwitches } from "../../compiler/src/path/model";
import { SCOPE_SETTING, type Sql, type Tx } from "../repo/scope";
import { type CoreSeedTableCount, SEED_ROLE } from "./core";
import {
  FixtureAccessError,
  FIXTURES_DIR,
  type FixtureSet,
  isInside,
  isPlainRelativePath,
  type ManifestEntry,
  openFixtureSet,
  type VerifiedFile,
  type VerifiedFixtureSet,
  verifyFixtureSet,
} from "./lib/fixture-set";
import { FACTS_FROM, type Flow, FLOWS, setupPlanOf } from "./setup-business";

/** T-130's vendored master inputs, among them the 243 trade files fixture set v1 was made from. */
export const TRADE_SET_DIR = path.join(FIXTURES_DIR, "master");
/** The set's sha256 list (T-130): "<sha256>  <path>" lines, as `shasum -a 256 -c` reads them. */
export const TRADE_SUMS_FILE = "SHA256SUMS";
/** The trade files inside the set: one <id>.json per kind of work. */
export const TRADES_DIR = "engine/work/prof/";
/** K-24: a kind seeded from a trade file. */
export const KIND_SOURCE = "trade_file";
/** S1-02's branch "All on the list": each demo shop's kind is a listed kind. */
export const DEMO_PICK_OUTCOME = "listed";
/** Each demo shop names one kind of work, so it is the first named (S1-02). */
export const DEMO_PICK_POSITION = 1;
/** MC C5: a flow with no arrival setting starts at window, the master's default (SPEC-prof.md line 127). */
export const START_ARRIVE = "window";

// Every file under this folder of the trade files' set must be listed in SHA256SUMS (as fixtures/master/manifest.test.ts
// checks): the flows, the trade files and the build scripts.
const TRADE_SET_TRACKED = "engine";
const SUMS_LINE = /^([0-9a-f]{64}) {2}(\S.*)$/;
const PROBLEMS_IN_MESSAGE = 10;
// A kind of work's id (kinds_id_form); a drafted kind's id starts with new- (kinds_new_work_id).
const KIND_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DRAFTED_KIND_PREFIX = "new-";
// A fact's or switch's name (kinds_facts_form, kind_flows_switches_form).
const NAME = /^[a-z0-9]+$/;
// A money path whose after is not one of the flow's (kind_flows_after_by_flow): own is flow B's, counter flow A's.
const AFTER_NOT_IN: Readonly<Record<Flow, RegExp>> = { A: /\|own$/, B: /\|counter$/ };

/** The trade files' set does not match SHA256SUMS. `problems` lists every mismatch found, one line each. */
export class TradeSetChecksumError extends Error {
  override readonly name = "TradeSetChecksumError";
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const shown = problems.slice(0, PROBLEMS_IN_MESSAGE).join("; ");
    const more =
      problems.length > PROBLEMS_IN_MESSAGE
        ? ` (and ${String(problems.length - PROBLEMS_IN_MESSAGE)} more)`
        : "";
    super(`the trade files do not match ${TRADE_SUMS_FILE}, so nothing was loaded: ${shown}${more}`);
    this.problems = problems;
  }
}

/** The trade files' set, checked: every file SHA256SUMS lists, with the bytes that were hashed. */
export interface VerifiedTradeSet {
  /** The set's folder (a real path). */
  readonly dir: string;
  /** The sha256 of SHA256SUMS itself, which names the whole set. */
  readonly sumsSha256: string;
  /** How many files SHA256SUMS lists; every one was checked. */
  readonly filesChecked: number;
  /** Every listed file, by path relative to the set. */
  readonly files: ReadonlyMap<string, VerifiedFile>;
}

export interface KindSeedRow {
  readonly id: string;
  readonly name: string;
  readonly style: string;
  readonly pattern: string;
  readonly facts: readonly string[];
  readonly source: typeof KIND_SOURCE;
}

export interface KindFlowSeedRow {
  readonly kind_id: string;
  readonly flow: Flow;
  readonly main_combo: string;
  readonly combos: readonly string[];
  readonly switches_on: readonly string[];
  readonly arrive: "setstart" | "window";
  readonly arrive_window_hours: number | null;
  readonly cutoff: string | null;
}

export interface PickedKindSeedRow {
  readonly id: string;
  readonly owner_person_id: string;
  readonly position: number;
  readonly words: string;
  readonly outcome: typeof DEMO_PICK_OUTCOME;
  readonly kind_id: string;
  readonly company_id: string;
  readonly business_id: string;
  readonly picked_at: Date;
}

export interface PickedKindTextSeedRow {
  readonly picked_kind_id: string;
  readonly pf_key: PfTextKey;
  readonly business_id: string;
  readonly block: string;
}

export interface KindsSeedRows {
  readonly kinds: readonly KindSeedRow[];
  readonly kind_flows: readonly KindFlowSeedRow[];
  readonly picked_kinds: readonly PickedKindSeedRow[];
  readonly picked_kind_texts: readonly PickedKindTextSeedRow[];
}

export type KindsSeedTable = keyof KindsSeedRows;

/** A setting a flow took MC C5's start value for, because its trade file gives none. */
export type StartedSetting = "arrive" | "cutoff";

/** One entry per kind: its trade file, and each value that did not come from that file. */
export interface SeededKind {
  /** The kind's id: its trade file's name. */
  readonly kindId: string;
  /** Its trade file, relative to the trade files' set, and the file's sha256 as checked against SHA256SUMS. */
  readonly source: string;
  readonly sha256: string;
  /** Each value not read from the kind's own file, by column, and the trade file it was read from (MC C5). */
  readonly valuesFrom: Readonly<Record<string, string>>;
  /** Per flow, the settings that took MC C5's start values: arrive window, an empty cutoff (null). */
  readonly startValues: Readonly<Record<Flow, readonly StartedSetting[]>>;
}

/** One entry per demo shop with a kind of work: its shop file, its trade file and every key the seed wrote. */
export interface SeededPick {
  readonly shopId: string;
  /** The demo shop's file, relative to fixture set v1, and its sha256 as checked against MANIFEST.sha256. */
  readonly source: string;
  readonly sha256: string;
  readonly pickId: string;
  readonly kindId: string;
  readonly companyId: string;
  readonly businessId: string;
  readonly ownerPersonId: string;
  /** The trade file the pick's text blocks are, relative to the trade files' set. */
  readonly blocksFrom: string;
}

export interface KindsSeedPlan {
  readonly rows: KindsSeedRows;
  /** One entry per kind, in code-point order of id. */
  readonly kinds: readonly SeededKind[];
  /** One entry per demo shop with a kind, in code-point order of shop id. */
  readonly picks: readonly SeededPick[];
  /** When the picks are dated (when fixture set v1 was made), and the file that says so. */
  readonly pickedAt: { readonly at: Date; readonly source: string };
}

export interface KindsSeedResult {
  /** The database role that wrote the rows (current_user inside the seed's transaction). */
  readonly ranAs: string;
  /** Fixture set v1, checked: its folder, its manifest's sha256 and how many files the manifest lists. */
  readonly fixtureSet: {
    readonly dir: string;
    readonly manifestSha256: string;
    readonly filesChecked: number;
  };
  /** The trade files' set, checked: its folder, the sha256 of SHA256SUMS and how many files it lists. */
  readonly tradeSet: {
    readonly dir: string;
    readonly sumsSha256: string;
    readonly filesChecked: number;
  };
  readonly pickedAt: { readonly at: Date; readonly source: string };
  readonly tables: Readonly<Record<KindsSeedTable, CoreSeedTableCount>>;
  readonly kinds: readonly SeededKind[];
  readonly picks: readonly SeededPick[];
}

export interface KindsSeedOptions {
  /** Fixture set v1's folder. Default fixtures/v1. Anything outside the repository's fixtures/ folder is refused. */
  fixturesDir?: string;
  /** The trade files' set. Default fixtures/master. Anything outside the repository's fixtures/ folder is refused. */
  tradesDir?: string;
}

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The plug-in keys stored whole as text blocks: the key map's textBlock entries (K-01 v1 keyMap, T-143), in its order.
 * They must be the trade loader's 11 free-text keys (T-133 PF_TEXT_KEYS), which picked_kind_texts_key_known holds.
 */
export function textBlockKeys(): PfTextKey[] {
  const keys = buildKeyMap()
    .keys.filter((entry) => entry.as === "textBlock")
    .map((entry) => entry.key);
  const loaded = new Set<string>(PF_TEXT_KEYS);
  const blocks = keys.filter((key): key is PfTextKey => loaded.has(key));
  // Exactly the 11, each once: every text block is a loader key, and no key is named twice.
  if (blocks.length !== keys.length || keys.length !== loaded.size || new Set(blocks).size !== loaded.size) {
    throw new Error("the key map's text blocks (T-143) are not the trade loader's 11 free-text keys (T-133)");
  }
  return blocks;
}

/** Opens the trade files' set for reading, as openFixtureSet opens fixture set v1 (inside fixtures/ only). */
export function openTradeSet(dir: string = TRADE_SET_DIR, options: { jail?: string } = {}): FixtureSet {
  return openFixtureSet(dir, options);
}

/**
 * Reads one file of the trade files' set: null when it does not exist. A path that is not plain, a symbolic link,
 * anything but a regular file, or a file whose real location is outside the set is refused before it is read.
 */
function readInsideSet(set: FixtureSet, relative: string): Uint8Array | null {
  if (!isPlainRelativePath(relative)) {
    throw new FixtureAccessError(
      `refusing to read ${JSON.stringify(relative)}: not a plain path inside the trade files' set`,
    );
  }
  const file = path.join(set.dir, ...relative.split("/"));
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat === undefined) {
    return null;
  }
  if (stat.isSymbolicLink()) {
    throw new FixtureAccessError(
      `refusing to read ${relative}: a symbolic link is not allowed in the trade files' set`,
    );
  }
  if (!stat.isFile()) {
    throw new FixtureAccessError(`refusing to read ${relative}: not a regular file`);
  }
  if (!isInside(realpathSync(file), set.dir)) {
    throw new FixtureAccessError(
      `refusing to read ${relative}: its real location is outside the trade files' set`,
    );
  }
  return readFileSync(file);
}

/** Every regular file under `relativeDir` of the set (none when it is missing). A symbolic link is refused. */
function filesInSet(set: FixtureSet, relativeDir: string, out: string[]): void {
  const folder = path.join(set.dir, ...relativeDir.split("/"));
  const stat = lstatSync(folder, { throwIfNoEntry: false });
  if (stat === undefined) {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new FixtureAccessError(
      `refusing to read ${relativeDir}: a symbolic link is not allowed in the trade files' set`,
    );
  }
  if (!stat.isDirectory()) {
    out.push(relativeDir);
    return;
  }
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new FixtureAccessError(
        `refusing to read ${relative}: a symbolic link is not allowed in the trade files' set`,
      );
    }
    if (entry.isDirectory()) {
      filesInSet(set, relative, out);
    } else if (entry.isFile()) {
      out.push(relative);
    } else {
      throw new FixtureAccessError(`refusing to read ${relative}: not a regular file`);
    }
  }
}

/**
 * Parses SHA256SUMS. A path that is not plain (absolute, `..`, `.`, a backslash) is a FixtureAccessError, thrown before
 * any listed file is read; a malformed or repeated line, or a list of no file, is a TradeSetChecksumError.
 */
export function parseTradeSums(text: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((line, index) => {
    if (line === "") {
      return;
    }
    const match = SUMS_LINE.exec(line);
    const sha256 = match?.[1];
    const listed = match?.[2];
    if (sha256 === undefined || listed === undefined) {
      problems.push(`${TRADE_SUMS_FILE} line ${String(index + 1)} is not "<sha256>  <path>"`);
      return;
    }
    if (!isPlainRelativePath(listed)) {
      throw new FixtureAccessError(
        `refusing ${TRADE_SUMS_FILE} line ${String(index + 1)}: ${JSON.stringify(listed)} is not a plain path inside the trade files' set`,
      );
    }
    if (seen.has(listed)) {
      problems.push(`${TRADE_SUMS_FILE} lists ${listed} twice`);
      return;
    }
    seen.add(listed);
    entries.push({ sha256, path: listed });
  });
  if (entries.length === 0 && problems.length === 0) {
    problems.push(`${TRADE_SUMS_FILE} lists no file`);
  }
  if (problems.length > 0) {
    throw new TradeSetChecksumError(problems);
  }
  return entries;
}

/**
 * Checks the whole trade files' set against SHA256SUMS (T-130), as verifyFixtureSet checks fixture set v1 against its
 * manifest: every listed file has its hash, and every file under engine/ is listed. Throws TradeSetChecksumError listing
 * every changed, missing or unlisted file, so a caller that loads only after this returns never loads a changed file.
 */
export function verifyTradeSet(set: FixtureSet): VerifiedTradeSet {
  const sums = readInsideSet(set, TRADE_SUMS_FILE);
  if (sums === null) {
    throw new TradeSetChecksumError([`${TRADE_SUMS_FILE} is missing from ${set.dir}`]);
  }
  const entries = parseTradeSums(new TextDecoder().decode(sums));
  const problems: string[] = [];
  const files = new Map<string, VerifiedFile>();
  for (const entry of entries) {
    const bytes = readInsideSet(set, entry.path);
    if (bytes === null) {
      problems.push(`listed but missing: ${entry.path}`);
      continue;
    }
    const sha256 = sha256Of(bytes);
    if (sha256 !== entry.sha256) {
      problems.push(`changed: ${entry.path}`);
      continue;
    }
    files.set(entry.path, { path: entry.path, sha256, bytes });
  }
  const listed = new Set(entries.map((entry) => entry.path));
  const onDisk: string[] = [];
  filesInSet(set, TRADE_SET_TRACKED, onDisk);
  for (const file of onDisk.sort(byCodePoint)) {
    if (!listed.has(file)) {
      problems.push(`not in ${TRADE_SUMS_FILE}: ${file}`);
    }
  }
  if (problems.length > 0) {
    throw new TradeSetChecksumError(problems);
  }
  return { dir: set.dir, sumsSha256: sha256Of(sums), filesChecked: entries.length, files };
}

/** One trade file, read by its top keys through T-133's loader. */
interface ReadTrade {
  readonly trade: LoadedTrade;
  readonly file: VerifiedFile;
}

/** Every trade file of the set (engine/work/prof/<id>.json), read through T-133's loader, in code-point order of id. */
function readTrades(verified: VerifiedTradeSet): ReadTrade[] {
  const files = [...verified.files.values()].filter((file) => file.path.startsWith(TRADES_DIR));
  const read = files.map((file): ReadTrade => {
    const name = file.path.slice(TRADES_DIR.length);
    if (!name.endsWith(".json") || name.includes("/")) {
      throw new Error(`${file.path}: not a trade file (${TRADES_DIR}<id>.json)`);
    }
    const id = name.slice(0, -".json".length);
    if (!KIND_ID.test(id) || id.startsWith(DRAFTED_KIND_PREFIX)) {
      throw new Error(
        `${file.path}: its name is not a trade's kind of work id (lower-case words and dashes, never new-...)`,
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(file.bytes));
    } catch (error) {
      throw new Error(`${file.path}: not JSON in UTF-8`, { cause: error });
    }
    try {
      return { trade: parseTrade(data, id), file };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${file.path}: ${reason}`, { cause: error });
    }
  });
  return read.sort((a, b) => byCodePoint(a.trade.id, b.trade.id));
}

/** A value for one flow: an object of A and B gives each flow its own (the loader's PerFlow), any other value both. */
function forFlow(value: unknown, flow: Flow): unknown {
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length > 0 && keys.every((key) => key === "A" || key === "B")) {
      return value[flow];
    }
  }
  return value;
}

/**
 * pf.settings for one flow, as K-01's tradeSettings has them (compiler/src/emit/trade.ts settingsFor), with MC C5's
 * start values where the file gives none: arrive window, an empty cutoff (null). `started` names those settings.
 */
function flowSettings(
  source: string,
  settings: TradeSettings | null,
  flow: Flow,
): Pick<KindFlowSeedRow, "arrive" | "arrive_window_hours" | "cutoff"> & { started: StartedSetting[] } {
  const arrive = forFlow(settings?.arrive, flow);
  const cutoff = forFlow(settings?.cutoff, flow);
  const started: StartedSetting[] = [];
  let arriveRow: Pick<KindFlowSeedRow, "arrive" | "arrive_window_hours">;
  if (arrive === undefined) {
    started.push("arrive");
    arriveRow = { arrive: START_ARRIVE, arrive_window_hours: null };
  } else if (arrive === "setstart" || arrive === "window") {
    arriveRow = { arrive, arrive_window_hours: null };
  } else if (
    isRecord(arrive) &&
    Object.keys(arrive).length === 1 &&
    typeof arrive.window === "number" &&
    Number.isSafeInteger(arrive.window) &&
    arrive.window >= 1
  ) {
    arriveRow = { arrive: "window", arrive_window_hours: arrive.window };
  } else {
    throw new Error(`${source}: flow ${flow}'s arrival setting is not setstart, window or a window of hours`);
  }
  if (cutoff === undefined) {
    started.push("cutoff");
    return { ...arriveRow, cutoff: null, started };
  }
  if (typeof cutoff !== "string" || cutoff.trim() === "") {
    throw new Error(
      `${source}: flow ${flow}'s free-cancel time is not words (an empty one is left out, MC C5)`,
    );
  }
  return { ...arriveRow, cutoff, started };
}

/** One flow of a trade: money.<flow>'s paths, the switches on (K-01 tradeFlow.switches) and the settings. */
function flowRowOf(read: ReadTrade, flow: Flow): { row: KindFlowSeedRow; started: StartedSetting[] } {
  const { trade, file } = read;
  const money = trade.flows[flow].money;
  if (!money.combos.includes(money.main)) {
    throw new Error(`${file.path}: money.${flow}'s main path is not among the paths it lists`);
  }
  if (money.combos.some((combo) => AFTER_NOT_IN[flow].test(combo))) {
    throw new Error(`${file.path}: money.${flow} lists a path whose after is not flow ${flow}'s`);
  }
  const on = tradeSwitches(trade, flow);
  const switchesOn = Object.keys(on).filter((name) => on[name] === true);
  if (!switchesOn.every((name) => NAME.test(name))) {
    throw new Error(`${file.path}: a switch's name is not lower-case letters and digits`);
  }
  const { started, ...settings } = flowSettings(file.path, trade.settings, flow);
  return {
    row: {
      kind_id: trade.id,
      flow,
      main_combo: money.main,
      combos: [...money.combos],
      switches_on: switchesOn,
      ...settings,
    },
    started,
  };
}

/**
 * Plans every row of the kinds seed from the two verified sets (pure: no database). Kinds are taken in code-point order
 * of id; the demo shops in the setup seed's order, so each pick names the company kind that seed plans.
 */
export function kindsPlanOf(shops: VerifiedFixtureSet, trades: VerifiedTradeSet): KindsSeedPlan {
  const read = readTrades(trades);
  if (read.length === 0) {
    throw new Error(`the trade files' set at ${trades.dir} has no trade file under ${TRADES_DIR}`);
  }
  const byId = new Map(read.map((entry) => [entry.trade.id, entry]));
  const textKeys = textBlockKeys();

  const rows = {
    kinds: [] as KindSeedRow[],
    kind_flows: [] as KindFlowSeedRow[],
    picked_kinds: [] as PickedKindSeedRow[],
    picked_kind_texts: [] as PickedKindTextSeedRow[],
  };
  const kinds: SeededKind[] = [];
  for (const entry of read) {
    const { trade, file } = entry;
    const valuesFrom: Record<string, string> = {};
    let facts = trade.facts;
    if (facts === null) {
      const from = byId.get(FACTS_FROM[trade.id] ?? "");
      const borrowed = from?.trade.facts ?? null;
      if (from === undefined || borrowed === null || borrowed.length === 0) {
        throw new Error(
          `${file.path}: it lists no facts (pf.facts), and MC C5 gives it no other trade's list`,
        );
      }
      facts = borrowed;
      valuesFrom.facts = from.file.path;
    }
    if (!facts.every((fact) => NAME.test(fact))) {
      throw new Error(`${file.path}: a fact's name is not lower-case letters and digits`);
    }
    rows.kinds.push({
      id: trade.id,
      name: trade.name,
      style: trade.style,
      pattern: trade.pattern,
      facts: [...facts],
      source: KIND_SOURCE,
    });
    const startValues: Record<Flow, StartedSetting[]> = { A: [], B: [] };
    for (const flow of FLOWS) {
      const { row, started } = flowRowOf(entry, flow);
      rows.kind_flows.push(row);
      startValues[flow] = started;
    }
    kinds.push({ kindId: trade.id, source: file.path, sha256: file.sha256, valuesFrom, startValues });
  }

  const setup = setupPlanOf(shops);
  const nameOf = new Map(setup.rows.companies.map((company) => [company.id, company.name]));
  const picks: SeededPick[] = [];
  for (const shop of setup.seeded) {
    if (shop.kindId === null) {
      continue;
    }
    const kind = byId.get(shop.kindId);
    if (kind === undefined) {
      throw new Error(
        `${shop.source}: its kind of work has no trade file (${TRADES_DIR}${shop.kindId}.json)`,
      );
    }
    const words = nameOf.get(shop.companyId);
    if (words === undefined) {
      throw new Error(`${shop.source}: the setup seed plans no company for it`);
    }
    const pickId = `pick-demo-${shop.shopId}`;
    rows.picked_kinds.push({
      id: pickId,
      owner_person_id: shop.ownerPersonId,
      position: DEMO_PICK_POSITION,
      words,
      outcome: DEMO_PICK_OUTCOME,
      kind_id: shop.kindId,
      company_id: shop.companyId,
      business_id: shop.businessId,
      picked_at: setup.seededAt.at,
    });
    for (const key of textKeys) {
      rows.picked_kind_texts.push({
        picked_kind_id: pickId,
        pf_key: key,
        business_id: shop.businessId,
        block: kind.trade.pluginText[key],
      });
    }
    picks.push({
      shopId: shop.shopId,
      source: shop.source,
      sha256: shop.sha256,
      pickId,
      kindId: shop.kindId,
      companyId: shop.companyId,
      businessId: shop.businessId,
      ownerPersonId: shop.ownerPersonId,
      blocksFrom: kind.file.path,
    });
  }
  if (picks.length === 0) {
    throw new Error(`the fixture set at ${shops.dir} has no demo shop with a kind of work`);
  }
  return { rows, kinds, picks, pickedAt: setup.seededAt };
}

/** Seeds the kinds of work and the demo shops' kinds from the trade files and fixture set v1 (see the top of this file). */
export async function seedKinds(sql: Sql, options: KindsSeedOptions = {}): Promise<KindsSeedResult> {
  return seedKindsFrom(sql, openFixtureSet(options.fixturesDir), openTradeSet(options.tradesDir));
}

/** The entry every seed set exports under one name, so a runner finds a set by its file name (T-201). */
export const seed = seedKinds;

/** Refuses to write before the setup seed: the company kind each demo shop's pick is placed in, at its business. */
async function requireSetupRows(tx: Tx, picks: readonly PickedKindSeedRow[]): Promise<void> {
  const companyIds = picks.map((pick) => pick.company_id);
  const found = await tx<{ company_id: string; kind_id: string; business_id: string }[]>`
    select company_id, kind_id, business_id from company_kinds where company_id = any(${companyIds}::text[])
  `;
  const have = new Set(found.map((row) => `${row.company_id} ${row.kind_id} ${row.business_id}`));
  const missing = picks.filter((pick) => !have.has(`${pick.company_id} ${pick.kind_id} ${pick.business_id}`));
  if (missing.length > 0) {
    throw new Error(
      `the setup seed's company kinds are missing for ${String(missing.length)} of ${String(picks.length)} demo shops: ` +
        `run db/seeds/setup-business.ts first (nothing was written)`,
    );
  }
}

/** seedKinds, from sets already opened (tests open temporary copies of the sets inside their own jails). */
export async function seedKindsFrom(
  sql: Sql,
  shopsSet: FixtureSet,
  tradeSet: FixtureSet,
): Promise<KindsSeedResult> {
  const shops = verifyFixtureSet(shopsSet);
  const trades = verifyTradeSet(tradeSet);
  const plan = kindsPlanOf(shops, trades);
  const { rows } = plan;

  const written = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${SEED_ROLE}`);
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    const [who] = await tx<{ role: string }[]>`select current_user as role`;
    await requireSetupRows(tx, rows.picked_kinds);

    const kinds = await tx`
      insert into kinds ${tx(rows.kinds, "id", "name", "style", "pattern", "facts", "source")}
      on conflict (id) do nothing
    `;
    const kindFlows = await tx`
      insert into kind_flows ${tx(
        rows.kind_flows,
        "kind_id",
        "flow",
        "main_combo",
        "combos",
        "switches_on",
        "arrive",
        "arrive_window_hours",
        "cutoff",
      )}
      on conflict (kind_id, flow) do nothing
    `;
    const pickedKinds = await tx`
      insert into picked_kinds ${tx(
        rows.picked_kinds,
        "id",
        "owner_person_id",
        "position",
        "words",
        "outcome",
        "kind_id",
        "company_id",
        "business_id",
        "picked_at",
      )}
      on conflict (id) do nothing
    `;
    const pickedKindTexts = await tx`
      insert into picked_kind_texts ${tx(rows.picked_kind_texts, "picked_kind_id", "pf_key", "business_id", "block")}
      on conflict (picked_kind_id, pf_key) do nothing
    `;
    return {
      ranAs: who?.role ?? "",
      inserted: {
        kinds: kinds.count,
        kind_flows: kindFlows.count,
        picked_kinds: pickedKinds.count,
        picked_kind_texts: pickedKindTexts.count,
      },
    };
  });

  const count = (table: KindsSeedTable): CoreSeedTableCount => {
    const total = rows[table].length;
    const inserted = written.inserted[table];
    return { rows: total, inserted, kept: total - inserted };
  };
  return {
    ranAs: written.ranAs,
    fixtureSet: { dir: shops.dir, manifestSha256: shops.manifestSha256, filesChecked: shops.filesChecked },
    tradeSet: { dir: trades.dir, sumsSha256: trades.sumsSha256, filesChecked: trades.filesChecked },
    pickedAt: plan.pickedAt,
    tables: {
      kinds: count("kinds"),
      kind_flows: count("kind_flows"),
      picked_kinds: count("picked_kinds"),
      picked_kind_texts: count("picked_kind_texts"),
    },
    kinds: plan.kinds,
    picks: plan.picks,
  };
}
