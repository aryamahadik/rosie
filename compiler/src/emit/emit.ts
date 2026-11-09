// The bundle emitter (T-149; C-058; K-01 v1; Q-34's layout): one manifest, one master graph per flow and one compiled
// overlay per trade, each its own value, written as a bundle directory that validates against K-01 v1.
//
//   emitBundle()    packs what it is given into the K-01 root document (manifest, flows, trades), checks the whole of it
//                   against K-01 v1 (validate.ts) and serializes each stored value: the files of the bundle directory.
//   buildBundle()   the same, with the stages' inputs loaded (fixture set v1's master flows and trade files), the shared
//                   lists collected from each module's shared-list.ts, and a named stand-in (standins.ts) for whatever
//                   K-01 requires and the build was not given.
//   writeBundle()   writes the files into a new or empty folder. treeSha256() is the hash of the written tree.
//
// The directory holds one file per stored value, at its KV key's part after bundle/<hash>/<build>/ (arch 10 line 536):
//   manifest.json  flow/A.json  flow/B.json  trade/<id>.json
// Each file is the value as stored, UTF-8 JSON with no spaces (K-01 storedValue: "as stored (UTF-8 JSON)"), so the
// manifest's storage.values give each file's bytes and sha256.
//
// The same inputs give the same bytes: nothing reads a clock, a random value or a path outside the inputs; the
// objects the emitter makes (the flows, the trades, the stored values, the lint summary) are in a fixed order (flows A
// then B, trades and stored values by id, steps in page order, lint rules in K-01's order); and what the stages copy
// from the master keeps the master's order, where order carries meaning (a step's `vary` layers apply in the order
// written: overlay-core.js resolveVary0).
//
// What the emitter writes and no stage computes: the manifest's storage table, and its lint summary of the marks the
// steps carry (validate.ts lintMarksOf). The journeys' ship list is T-160's, so `journeys` is empty here; the
// bundle id is T-150's, taken as given.
//
// Where the opt-out line goes (T-1116; Q-30): before either flow or any trade is compiled, stop-marks.ts placeStops()
// walks every path of every trade given, with corrections/stops.ts walkStops(), over each flow; every message the
// master graphs and the overlays hold then carries the marker those walks give it (true, "first" or none), so the line
// renders once in each person's chat, on Rosie's first reply in a chat the person opened.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FlowLetter, MasterGraphs } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { listTradeIds, loadTrade, type LoadedTrade, type TradeId } from "../load/trade";
import { compileFlow, correctedFlow, type JudgmentRules } from "./flow";
import { collectSharedLists, SHARED_LIST_NAMES, type SharedListName } from "./shared-lists";
import {
  PROMPT_KINDS,
  standInBuiltAt,
  standInBundleId,
  standInInputs,
  standInJudgmentRules,
  standInList,
  standInModelRouting,
  standInPrompts,
  type BundleId,
  type InputFile,
  type ModelRouting,
  type PromptTexts,
  type StandIn,
  type StandInValue,
} from "./standins";
import type { BundleStep } from "./steps";
import { placeStops, type StopMarks } from "./stop-marks";
import { compileTrade } from "./trade";
import { BundleValidationError, checkBundlePart, lintRuleOrder, stepSchemaChecks } from "./validate";

type Obj = Record<string, unknown>;

const FLOWS: readonly FlowLetter[] = ["A", "B"];

/** Everything emitBundle() packs: the stages' inputs, and what other tasks and roles give. */
export interface EmitInputs {
  master: MasterGraphs;
  /** The trades to compile, one overlay each (any order: the bundle holds them by id). */
  trades: readonly LoadedTrade[];
  bundleId: BundleId;
  /** When it was built, in UTC (K-01 manifest.builtAt). */
  builtAt: string;
  /** The compiler's version (K-01 manifest.compiler.version). */
  compilerVersion: string;
  inputs: readonly InputFile[];
  prompts: PromptTexts;
  routing: ModelRouting;
  judgmentRules: JudgmentRules;
  /** The four shared lists, in K-01's shape. */
  lists: Record<SharedListName, unknown>;
}

/** One file of the bundle directory: its path in the directory and its text, the value as stored (UTF-8 JSON). */
export interface BundleFile {
  path: string;
  text: string;
}

/** What emitBundle() gives: the bundle as one K-01 document, and its files in path order. */
export interface EmittedBundle {
  /** The K-01 root: { manifest, flows, trades }. */
  bundle: { manifest: Obj; flows: Record<string, Obj>; trades: Record<string, Obj> };
  files: BundleFile[];
}

/** What buildBundle() gives besides the bundle: the stand-ins it took, and where each shared list came from. */
export interface BuiltBundle extends EmittedBundle {
  standIns: StandIn[];
  listSources: Partial<Record<SharedListName, string[]>>;
}

/** The sha256 of a text's UTF-8 bytes, in lowercase hex (Q-36's hash). */
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The size of a text's UTF-8 bytes. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The value as stored: UTF-8 JSON, no spaces. */
function stored(value: unknown): string {
  return JSON.stringify(value);
}

/** A step that fails a rule, for the lint summary. */
interface Failure {
  rule: string;
  flow: FlowLetter;
  step: string;
  trade: string | null;
}

function failuresOf(steps: Map<string, BundleStep>, flow: FlowLetter, trade: string | null): Failure[] {
  const out: Failure[] = [];
  for (const step of steps.values())
    for (const rule of step.lint) out.push({ rule, flow, step: step.id, trade });
  return out;
}

/**
 * The rules the emitter's marks cover: those K-01 v1's step checks name (validate.ts stepSchemaChecks), except a check
 * that starts only on a field the emitter does not write (`walk`, the loop rule's walk: T-158's).
 */
export function markedRules(): string[] {
  const checks = stepSchemaChecks();
  const written = new Set(checks.filter((check) => check.field !== "walk").map((check) => check.rule));
  return lintRuleOrder().filter((rule) => written.has(rule));
}

/** The manifest's lint summary (K-01 `lintReport`) of the marks the steps carry. */
function lintSummary(failures: readonly Failure[]): Obj {
  const rules = markedRules().map((rule) => ({
    rule,
    failures: failures.filter((failure) => failure.rule === rule).length,
  }));
  return {
    rules,
    failures: failures.map((failure) => ({
      rule: failure.rule,
      flow: failure.flow,
      step: failure.step,
      trade: failure.trade,
      message:
        failure.trade === null
          ? `${failure.step} fails ${failure.rule}`
          : `${failure.trade}'s ${failure.step} fails ${failure.rule}`,
    })),
  };
}

/** The KV key of one stored value: bundle/<hash>/<build>/<part>. */
function kvKey(id: BundleId, part: string): string {
  return `bundle/${id.hash}/${String(id.build)}/${part}`;
}

/**
 * Packs the inputs into a bundle: compiles both flows and each trade, writes the manifest, checks the whole bundle
 * against K-01 v1 (BundleValidationError when it is refused) and serializes each stored value.
 */
export function emitBundle(input: EmitInputs): EmittedBundle {
  const byId = new Map(input.trades.map((trade) => [trade.id, trade]));
  if (byId.size !== input.trades.length) throw new Error("a trade is given twice");
  const sorted = [...byId].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const stops = {} as Record<FlowLetter, StopMarks>;
  for (const flow of FLOWS)
    stops[flow] = placeStops(
      input.master[flow],
      correctedFlow(input.master, flow),
      sorted.map(([, trade]) => trade),
    );

  const failures: Failure[] = [];
  const flows: Record<string, Obj> = {};
  for (const flow of FLOWS) {
    const compiled = compileFlow(input.master, flow, input.judgmentRules, stops[flow]);
    flows[flow] = compiled.graph;
    failures.push(...failuresOf(compiled.steps, flow, null));
  }

  const trades: Record<string, Obj> = {};
  const ids = [...byId.keys()].sort();
  for (const [id, trade] of sorted) {
    const compiled = compileTrade(input.master, trade, stops);
    trades[id] = compiled.overlay;
    for (const flow of FLOWS) failures.push(...failuresOf(compiled.steps[flow], flow, id));
  }

  const values: { part: string; kind: "flow" | "trade"; flow?: FlowLetter; trade?: string; text: string }[] =
    [];
  for (const flow of FLOWS)
    values.push({ part: `flow/${flow}`, kind: "flow", flow, text: stored(flows[flow]) });
  for (const id of ids)
    values.push({ part: `trade/${id}`, kind: "trade", trade: id, text: stored(trades[id]) });

  const prompts: Obj = {};
  for (const kind of PROMPT_KINDS) {
    const prompt = input.prompts[kind];
    prompts[kind] = { version: prompt.version, sha256: sha256(prompt.text), text: prompt.text };
  }
  const lists: Obj = {};
  for (const name of SHARED_LIST_NAMES) lists[name] = structuredClone(input.lists[name]);

  const manifest: Obj = {
    contract: "bundle.v1",
    bundleId: { hash: input.bundleId.hash, build: input.bundleId.build },
    builtAt: input.builtAt,
    compiler: { version: input.compilerVersion },
    inputs: structuredClone([...input.inputs]),
    prompts,
    models: structuredClone(input.routing.models),
    policy: structuredClone(input.routing.policy),
    lint: lintSummary(failures),
    journeys: [],
    storage: {
      manifestKey: kvKey(input.bundleId, "manifest"),
      values: values.map((value) => {
        const entry: Obj = { key: kvKey(input.bundleId, value.part), kind: value.kind };
        if (value.flow !== undefined) entry.flow = value.flow;
        if (value.trade !== undefined) entry.trade = value.trade;
        entry.bytes = byteLength(value.text);
        entry.sha256 = sha256(value.text);
        return entry;
      }),
    },
    lists,
  };

  const bundle = { manifest, flows, trades };
  const problems = checkBundlePart(bundle);
  if (problems.length > 0) throw new BundleValidationError("the emitted bundle", problems);

  const files: BundleFile[] = [
    { path: "manifest.json", text: stored(manifest) },
    ...values.map((value) => ({ path: `${value.part}.json`, text: value.text })),
  ];
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { bundle, files };
}

/** What buildBundle() may be given; anything left out is loaded (the stages' inputs) or a named stand-in. */
export interface BuildOptions {
  /** The trades to compile, by id (default: every trade of fixture set v1, 243). */
  trades?: readonly TradeId[];
  bundleId?: BundleId;
  builtAt?: string;
  inputs?: readonly InputFile[];
  prompts?: PromptTexts;
  routing?: ModelRouting;
  judgmentRules?: JudgmentRules;
  /** The compiler/src/ folder whose modules' shared-list.ts files give the shared lists (default: this compiler's). */
  srcDir?: string;
  /** The master flows, when already loaded (default: loadMaster()). */
  master?: MasterGraphs;
}

/** The compiler's version: compiler/package.json's. */
export function compilerVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  if (typeof pkg.version !== "string") throw new Error("compiler/package.json has no version");
  return pkg.version;
}

/**
 * Builds a bundle from fixture set v1: loads the master flows and the trades, collects the shared lists from each
 * module's shared-list.ts, takes a stand-in (standins.ts) for each part not given, and emits it (emitBundle).
 */
export async function buildBundle(options: BuildOptions = {}): Promise<BuiltBundle> {
  const standIns: StandIn[] = [];
  /** The value given, or else the stand-in's, which is then named. */
  const take = <T>(given: T | undefined, standIn: () => StandInValue<T>): T => {
    if (given !== undefined) return given;
    const made = standIn();
    standIns.push(made.standIn);
    return made.value;
  };

  const master = options.master ?? loadMaster();
  const tradeIds = options.trades ?? listTradeIds();
  const trades = tradeIds.map((id) => loadTrade(id));
  const bundleId = take(options.bundleId, standInBundleId);
  const builtAt = take(options.builtAt, standInBuiltAt);
  const inputs = take(options.inputs, () => standInInputs(tradeIds));
  const prompts = take(options.prompts, standInPrompts);
  const routing = take(options.routing, standInModelRouting);
  const judgmentRules = take(options.judgmentRules, standInJudgmentRules);

  const collected = await collectSharedLists(options.srcDir);
  const lists = {} as Record<SharedListName, unknown>;
  for (const name of SHARED_LIST_NAMES) lists[name] = take(collected.lists[name], () => standInList(name));

  const emitted = emitBundle({
    master,
    trades,
    bundleId,
    builtAt,
    compilerVersion: compilerVersion(),
    inputs,
    prompts,
    routing,
    judgmentRules,
    lists,
  });
  return { ...emitted, standIns, listSources: collected.sources };
}

/**
 * The tree's hash: the sha256 of one line `<sha256 of the file>  <path>` per file (the line `shasum -a 256` prints),
 * sorted by path, each ending in a newline.
 */
export function treeSha256(files: readonly BundleFile[]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${sha256(file.text)}  ${file.path}\n`);
  return sha256(lines.join(""));
}

/** Writes the files into `dir`, which must be new or empty, so the folder holds the bundle and nothing else. */
export function writeBundle(dir: string, files: readonly BundleFile[]): void {
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length > 0)
    throw new Error(`${dir} is not empty: a bundle is written into a new or empty folder`);
  for (const file of files) {
    const target = join(dir, ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.text, "utf8");
  }
}
