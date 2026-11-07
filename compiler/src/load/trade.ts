// The trade file loader (T-133; Master Corrections R2 and R3).
//
// Reads one trade file, fixtures/master/engine/work/prof/<id>.json, or all 243, from fixture set v1's copy, checks it
// and returns one typed LoadedTrade. It parses JSON only (the master's CommonJS scripts are not loaded here) and
// reads a trade file by its TOP keys, as Master Corrections R3 says:
//
//   R3  code reads pf.facts, pf.switches, pf.settings and money.<flow> by name, as typed values. The other eleven
//       plug-in keys (pf.license ... pf.edges, PF_TEXT_KEYS) are free text: each is stored whole as one text block
//       for the AI, its sub-keys guidance only (K-01 pluginText; FRONTEND-SPEC line 565). A block is the file's
//       value written as JSON text, unchanged: JSON.stringify of the value as parsed.
//   R2  notes, basis, keep, from, splitsKept and keep_why are authoring fields and are dropped
//       (TRADE_AUTHORING_FIELDS). So are `src` and `prop` on a step an op adds, as in flow.ts.
//
// What it hands on, for the overlay applier (T-135) and the key map (T-143): the ops of each flow in the file's
// order, the rename pairs, the sample cast, names and story, and the trade's own record slot rows. It applies none of
// them. It fills nothing in either: a trade with no pf.facts has `facts: null` (insurance.json; C5's fill belongs to
// T-139), and a trade with no pf.settings has `settings: null` (12 trades; C5's start values belong to the compiler).
//
// The loader never counts or shapes anything to reach a number: what the file has is loaded, and a shape it does not
// expect is an error that names the path (TradeLoadError), never a silent skip. Names follow K-01 v1 (tradeOverlay,
// pluginText, tradeSettings, tradeMoney, overlayOp); the loaded forms are K-01's before the compiler's fills, so a few
// fields are optional here that K-01 makes required.
//
// This file imports only Node built-ins and TYPES, so Node runs it as it is.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AmountTable,
  FlowLetter,
  Gate,
  Lane,
  Message,
  MessageElements,
  Name,
  Pair,
  RecordService,
  RecordSlotRow,
  Step,
  StepId,
  Table,
  WordsPatch,
} from "../graph/types.ts";

/** A trade id, the trade file's name without `.json` (K-01 tradeId). */
export type TradeId = string;

/** The booking patterns of K-01 (SPEC-prof 2). */
export const PATTERNS = [
  "fix",
  "urgent",
  "project",
  "service",
  "dropoff",
  "chair",
  "clinic",
  "class",
  "event",
  "consult",
  "table",
] as const;
export type Pattern = (typeof PATTERNS)[number];

/** The 11 free-text pf keys, stored whole (K-01 pluginText; SPEC-master 8 'slot.gives'). */
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
] as const;
export type PfTextKey = (typeof PF_TEXT_KEYS)[number];

/** The 11 free-text pf blocks, each the file's value as JSON text, unchanged (K-01 pluginText). */
export type PluginText = Record<PfTextKey, string>;

/** Top-level keys of a trade file the loader drops (Master Corrections R2). */
export const TRADE_AUTHORING_FIELDS: readonly string[] = [
  "notes",
  "basis",
  "keep",
  "from",
  "splitsKept",
  "keep_why",
];

/** Fields of a step an op adds that the loader drops (R2, as in flow.ts). */
export const STEP_AUTHORING_FIELDS: readonly string[] = ["src", "prop"];

/** Where fixture set v1 keeps the trade files, from the repository root. */
export const TRADE_DIR = fileURLToPath(
  new URL("../../../fixtures/master/engine/work/prof/", import.meta.url),
);

/** A trade file that does not have the shape the loader reads. The message names the path to the offending value. */
export class TradeLoadError extends Error {
  override name = "TradeLoadError";
}

/** A value for both flows at once, or for one or both flows separately: `x`, or `{ A: x, B: y }` (SPEC-prof 3). */
export type PerFlow<T> = T | { A?: T; B?: T };

/** `arrive`: window (the default), setstart, or { window: hours } (SPEC-prof 3; K-01 tradeSettings). */
export type Arrive = "window" | "setstart" | { window: number };

/** pf.switches: a switch name to true, false, or a value per flow. Every switch left out is off (SPEC-master 5b). */
export type TradeSwitches = Record<Name, PerFlow<boolean>>;

/** pf.settings as the file writes them: either may be left out, and each may differ per flow (SPEC-prof 3). */
export interface TradeSettings {
  arrive?: PerFlow<Arrive>;
  cutoff?: PerFlow<string>;
}

/** One of the trade's own services in money.<flow>.services (K-01 service; the record's service shape). */
export type TradeService = Omit<RecordService, "amounts"> & {
  /** The service's own amounts; 388 of the 490 services in the trade files write them. */
  amounts?: Record<string, string>;
  /** Who pays: `credit` on one service (SPEC-master 5e 'paidby'). */
  paidby?: string;
};

/** money.<flow> (K-01 tradeMoney). */
export interface TradeMoney {
  main: string;
  combos: string[];
  examples: Record<string, string>;
  amounts: AmountTable;
  services?: Record<string, TradeService>;
  booking?: Record<Name, Name[]>;
  labels?: Record<string, Record<string, string>>;
}

/** A branch of a step an op adds. A branch that ends the path can have no steps. */
export interface OwnBranch {
  label: string;
  steps?: OwnStep[];
  end?: "merge" | "end";
  endText?: string;
  when?: Gate;
  sets?: Record<string, string>;
  flow?: FlowLetter;
}

/**
 * A step a trade adds (after, before and branch ops), as the file writes it: the master's step format
 * (SPEC-prof 3) with no `section`, which the applier gives it from its place.
 */
export type OwnStep = Omit<Step, "section" | "branches" | "say" | "vary" | "form"> & {
  say?: TradeMessage[];
  form?: FormRow[];
  vary?: Record<string, TradeWordsPatch>;
  branches?: OwnBranch[];
};

/** A screen row: [label, value], or [label] alone (one row in towing.json: B5-05 'Card'). */
export type FormRow = Pair | [label: string];

/**
 * A message in a trade file: [from, to, text], [from, to, text, elements], or [from, to, elements] with no text, where
 * the message is only a card, form or list (found in trade files, not in the master flows: 'say' in appraiser.json).
 */
export type TradeMessage = Message | [from: Lane, to: Lane, elements: MessageElements];

/** One `vary` entry of an op, whose `say` and `addSay` may hold messages with no text. */
export type TradeWordsPatch = Omit<WordsPatch, "say" | "addSay" | "form"> & {
  say?: TradeMessage[];
  addSay?: TradeMessage[];
  form?: FormRow[];
};

/** One op, as the file writes it, in the file's order (K-01 overlayOp before the compiler's changes). */
export type TradeOp =
  | { op: "off"; at: StepId; label?: string; why: string }
  | {
      op: "words";
      at: StepId;
      does?: string;
      more?: string[];
      say?: TradeMessage[];
      rule?: string;
      t?: string;
      form?: FormRow[];
      table?: Table;
      title?: string;
      who?: Lane;
      to?: Lane;
      vary?: Record<string, TradeWordsPatch>;
      tells?: Lane[];
      why?: string;
    }
  | { op: "more"; at: StepId; more: string[] }
  | { op: "after" | "before"; at: StepId; steps: OwnStep[] }
  | { op: "branch"; at: StepId; branch: OwnBranch };

/** What one trade writes for one flow. */
export interface LoadedTradeFlow {
  flow: FlowLetter;
  /** The trade's ops for this flow, in order. */
  ops: TradeOp[];
  /** The trade's rename pairs for this flow, in order (longer phrases first). Right sides are illustrations (C6). */
  rename: Pair[];
  /** money.<flow>, typed. */
  money: TradeMoney;
  /** The trade's own record slot rows for this flow, by slot name (the file's slots.<flow>); empty when it has none. */
  slotRows: Record<string, RecordSlotRow[]>;
  /** The sample cast and names of the story (illustrations, MC C6), or null where the file has none. */
  cast: Record<string, string> | null;
  names: Record<string, string> | null;
  /** The sample story (an illustration, MC C6). */
  story: string;
}

/** One trade file, loaded by its top keys. */
export interface LoadedTrade {
  id: TradeId;
  name: string;
  style: string;
  pattern: Pattern;
  /** pf.facts, or null when the file has none (insurance.json; C5's fill is T-139's). */
  facts: Name[] | null;
  /** pf.switches, or null when the file has none (99 trades). */
  switches: TradeSwitches | null;
  /** pf.settings, or null when the file has none (12 trades; C5: they start at window and an empty cutoff). */
  settings: TradeSettings | null;
  /** The 11 free-text pf blocks, each stored whole. */
  pluginText: PluginText;
  flows: Record<FlowLetter, LoadedTradeFlow>;
}

type Obj = Record<string, unknown>;

const FLOWS: readonly FlowLetter[] = ["A", "B"];
const LANE_NAMES: readonly string[] = ["owner", "san", "staff", "cust", "agent", "pay", "out", "other"];
const VIAS: readonly string[] = ["chat", "msg", "portal", "page", "sync", "auto", "visit", "call", "email"];
const MASTER_STEP_ID = /^[SAB](1[0-3]|[1-9])-[0-9]{2,3}$/;
const OWN_STEP_ID = /^[AB](1[0-3]|[1-9])-[a-z][0-9]{2,3}$/;
const COMBO = /^(list|photos|visit)\|(none|card|deposit|full)\|(none|counter|bill|card|own)$/;

const TOP_KEYS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "style",
  "pattern",
  "plugin",
  "cast",
  "names",
  "rename",
  "story",
  "money",
  "A",
  "B",
  "slots",
  ...TRADE_AUTHORING_FIELDS,
]);
const PLUGIN_KEYS: ReadonlySet<string> = new Set([...PF_TEXT_KEYS, "pf.facts", "pf.switches", "pf.settings"]);
const STEP_KEYS: ReadonlySet<string> = new Set([
  "id",
  "line",
  "who",
  "to",
  "as",
  "via",
  "t",
  "title",
  "q",
  "does",
  "more",
  "say",
  "rule",
  "form",
  "table",
  "needs",
  "gives",
  "tells",
  "reads",
  "when",
  "vary",
  "slot",
  "text",
  "visit",
  "took",
  "ev",
  "rec",
  "wr",
  "timing",
  "amounts",
  "layerAdd",
  "branches",
  "phase",
  "sec",
  "type",
  "kind",
  ...STEP_AUTHORING_FIELDS,
]);
const BRANCH_KEYS: ReadonlySet<string> = new Set([
  "label",
  "steps",
  "end",
  "endText",
  "when",
  "sets",
  "flow",
]);
const GATE_KEYS: ReadonlySet<string> = new Set([
  "price",
  "before",
  "after",
  "booking",
  "pf",
  "factOn",
  "factOff",
  "switchOn",
  "switchOff",
  "rec",
  "recOff",
  "took",
  "ev",
  "wr",
]);
const WORDS_KEYS: ReadonlySet<string> = new Set([
  "op",
  "at",
  "does",
  "more",
  "say",
  "rule",
  "t",
  "form",
  "table",
  "title",
  "who",
  "to",
  "vary",
  "tells",
  "why",
]);
const MONEY_KEYS: ReadonlySet<string> = new Set([
  "main",
  "combos",
  "examples",
  "amounts",
  "services",
  "booking",
  "labels",
]);
const SERVICE_KEYS: ReadonlySet<string> = new Set([
  "flow",
  "name",
  "price",
  "before",
  "after",
  "amounts",
  "paidby",
]);

function fail(at: string, message: string): never {
  throw new TradeLoadError(`${at}: ${message}`);
}

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function obj(value: unknown, at: string): Obj {
  if (!isObj(value)) return fail(at, "expected an object");
  return value;
}

function arr(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) return fail(at, "expected an array");
  return value as unknown[];
}

function str(value: unknown, at: string): string {
  if (typeof value !== "string") return fail(at, "expected a string");
  return value;
}

function bool(value: unknown, at: string): boolean {
  if (typeof value !== "boolean") return fail(at, "expected true or false");
  return value;
}

function strList(value: unknown, at: string): string[] {
  return arr(value, at).map((item, k) => str(item, `${at}[${String(k)}]`));
}

function strRecord(value: unknown, at: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(obj(value, at))) out[key] = str(item, `${at}.${key}`);
  return out;
}

function onlyKeys(raw: Obj, allowed: ReadonlySet<string>, at: string, what: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) fail(`${at}.${key}`, `unknown ${what}`);
  }
}

function lane(value: unknown, at: string): Lane {
  const text = str(value, at);
  if (!LANE_NAMES.includes(text)) return fail(at, `"${text}" is not one of the eight lanes`);
  return text as Lane;
}

function flowLetter(value: unknown, at: string): FlowLetter {
  const text = str(value, at);
  if (text !== "A" && text !== "B") return fail(at, `"${text}" is not a flow letter (A or B)`);
  return text;
}

function stepRef(value: unknown, at: string): StepId {
  const text = str(value, at);
  if (!MASTER_STEP_ID.test(text) && !OWN_STEP_ID.test(text)) return fail(at, `"${text}" is not a step id`);
  return text;
}

function pair(value: unknown, at: string): Pair {
  const items = arr(value, at);
  if (items.length !== 2) return fail(at, "expected two strings");
  return [str(items[0], `${at}[0]`), str(items[1], `${at}[1]`)];
}

function pairList(value: unknown, at: string): Pair[] {
  return arr(value, at).map((item, k) => pair(item, `${at}[${String(k)}]`));
}

function formRows(value: unknown, at: string): FormRow[] {
  return arr(value, at).map((row, k) => {
    const where = `${at}[${String(k)}]`;
    const items = arr(row, where);
    if (items.length === 1) return [str(items[0], `${where}[0]`)] as [string];
    return pair(row, where);
  });
}

function amountTable(value: unknown, at: string): AmountTable {
  const out: AmountTable = {};
  for (const [key, row] of Object.entries(obj(value, at))) out[key] = strRecord(row, `${at}.${key}`);
  return out;
}

function table(value: unknown, at: string): Table {
  const raw = obj(value, at);
  return {
    head: strList(raw.head, `${at}.head`),
    rows: arr(raw.rows, `${at}.rows`).map((row, k) => strList(row, `${at}.rows[${String(k)}]`)),
  };
}

/** A `when`: every key is a known gate key; the lists hold strings; the stamps hold a flow letter or false. */
function gate(value: unknown, at: string): Gate {
  const raw = obj(value, at);
  for (const [key, item] of Object.entries(raw)) {
    if (!GATE_KEYS.has(key)) return fail(`${at}.${key}`, "unknown gate key");
    if (key === "took" || key === "ev") flowLetter(item, `${at}.${key}`);
    else if (key === "wr") {
      if (item !== false) return fail(`${at}.${key}`, "expected false");
    } else strList(item, `${at}.${key}`);
  }
  return raw;
}

/**
 * One message: [from, to, text], [from, to, text, elements] or [from, to, elements]. The elements stay as written.
 */
function message(value: unknown, at: string): TradeMessage {
  const items = arr(value, at);
  if (items.length < 3 || items.length > 4)
    return fail(at, "expected [from, to, text], [from, to, text, elements] or [from, to, elements]");
  const from = lane(items[0], `${at}[0]`);
  const to = lane(items[1], `${at}[1]`);
  if (items.length === 3 && isObj(items[2])) return [from, to, items[2]];
  const head: [Lane, Lane, string] = [from, to, str(items[2], `${at}[2]`)];
  if (items.length === 3) return head;
  return [...head, obj(items[3], `${at}[3]`)] as Message;
}

function messages(value: unknown, at: string): TradeMessage[] {
  return arr(value, at).map((item, k) => message(item, `${at}[${String(k)}]`));
}

function vary(value: unknown, at: string): Record<string, TradeWordsPatch> {
  const raw = obj(value, at);
  for (const [key, patch] of Object.entries(raw)) {
    const inner = obj(patch, `${at}.${key}`);
    if ("say" in inner) messages(inner.say, `${at}.${key}.say`);
    if ("addSay" in inner) messages(inner.addSay, `${at}.${key}.addSay`);
    if ("more" in inner) strList(inner.more, `${at}.${key}.more`);
    if ("addMore" in inner) strList(inner.addMore, `${at}.${key}.addMore`);
    if ("swap" in inner) pairList(inner.swap, `${at}.${key}.swap`);
    if ("form" in inner) formRows(inner.form, `${at}.${key}.form`);
    if ("table" in inner) table(inner.table, `${at}.${key}.table`);
  }
  return raw as Record<string, TradeWordsPatch>;
}

/** A step an op adds: the master's fields, the authoring ones dropped (R2), its branches checked the same way. */
function ownStep(value: unknown, at: string): OwnStep {
  const raw = obj(value, at);
  onlyKeys(raw, STEP_KEYS, at, "step field");
  const id = str(raw.id, `${at}.id`);
  if (!OWN_STEP_ID.test(id)) fail(`${at}.id`, `"${id}" is not the id of a step a trade adds`);
  const where = `${at} (${id})`;
  if (strList(raw.line, `${where}.line`).length === 0) fail(`${where}.line`, "expected at least one line");
  lane(raw.who, `${where}.who`);
  if ("to" in raw) lane(raw.to, `${where}.to`);
  const via = str(raw.via, `${where}.via`);
  if (!VIAS.includes(via)) fail(`${where}.via`, `"${via}" is not a way a step happens`);
  str(raw.title, `${where}.title`);
  str(raw.does, `${where}.does`);
  for (const key of ["as", "t", "q", "rule", "text", "visit", "phase"]) {
    if (key in raw) str(raw[key], `${where}.${key}`);
  }
  for (const key of ["more", "needs", "gives", "reads"]) {
    if (key in raw) strList(raw[key], `${where}.${key}`);
  }
  if ("tells" in raw)
    arr(raw.tells, `${where}.tells`).forEach((item, k) => lane(item, `${where}.tells[${String(k)}]`));
  if ("say" in raw) messages(raw.say, `${where}.say`);
  if ("form" in raw) formRows(raw.form, `${where}.form`);
  if ("table" in raw) table(raw.table, `${where}.table`);
  if ("when" in raw) gate(raw.when, `${where}.when`);
  if ("vary" in raw) vary(raw.vary, `${where}.vary`);
  if ("sec" in raw && typeof raw.sec !== "number") fail(`${where}.sec`, "expected a number");
  if ("type" in raw && raw.type !== "split" && raw.type !== "step")
    fail(`${where}.type`, 'expected "split" or "step"');
  if ("kind" in raw && raw.kind !== "rule") fail(`${where}.kind`, 'expected "rule"');

  const isSplit = raw.type === "split";
  if (isSplit !== "branches" in raw)
    fail(
      `${where}.branches`,
      isSplit ? "a split without branches" : "branches on a step that is not a split",
    );
  if (isSplit && !("q" in raw)) fail(`${where}.q`, "a split without its question");

  const node: Obj = {};
  for (const [key, item] of Object.entries(raw)) {
    if (!STEP_AUTHORING_FIELDS.includes(key) && key !== "branches") node[key] = item;
  }
  if (isSplit) {
    node.branches = arr(raw.branches, `${where}.branches`).map((branch, k) =>
      ownBranch(branch, `${where}.branches[${String(k)}]`),
    );
  }
  return node as unknown as OwnStep;
}

function ownBranch(value: unknown, at: string): OwnBranch {
  const raw = obj(value, at);
  onlyKeys(raw, BRANCH_KEYS, at, "branch field");
  const label = str(raw.label, `${at}.label`);
  const where = `${at} ("${label}")`;
  if ("end" in raw && raw.end !== "merge" && raw.end !== "end")
    fail(`${where}.end`, 'expected "merge" or "end"');
  if ("endText" in raw) str(raw.endText, `${where}.endText`);
  if ("flow" in raw) flowLetter(raw.flow, `${where}.flow`);
  if ("when" in raw) gate(raw.when, `${where}.when`);
  if ("sets" in raw) strRecord(raw.sets, `${where}.sets`);
  const branch: Obj = {};
  for (const [key, item] of Object.entries(raw)) {
    if (key !== "steps") branch[key] = item;
  }
  if ("steps" in raw) {
    branch.steps = arr(raw.steps, `${where}.steps`).map((child, k) =>
      ownStep(child, `${where}.steps[${String(k)}]`),
    );
  }
  return branch as unknown as OwnBranch;
}

function op(value: unknown, at: string): TradeOp {
  const raw = obj(value, at);
  const kind = str(raw.op, `${at}.op`);
  const where = `${at} (${kind} ${typeof raw.at === "string" ? raw.at : "?"})`;
  stepRef(raw.at, `${where}.at`);
  switch (kind) {
    case "off": {
      onlyKeys(raw, new Set(["op", "at", "label", "why"]), where, "off field");
      if (str(raw.why, `${where}.why`) === "") fail(`${where}.why`, "an off needs its why");
      if ("label" in raw) str(raw.label, `${where}.label`);
      break;
    }
    case "words": {
      onlyKeys(raw, WORDS_KEYS, where, "words field");
      for (const key of ["does", "rule", "t", "title", "why"]) {
        if (key in raw) str(raw[key], `${where}.${key}`);
      }
      for (const key of ["who", "to"]) {
        if (key in raw) lane(raw[key], `${where}.${key}`);
      }
      if ("more" in raw) strList(raw.more, `${where}.more`);
      if ("say" in raw) messages(raw.say, `${where}.say`);
      if ("form" in raw) formRows(raw.form, `${where}.form`);
      if ("table" in raw) table(raw.table, `${where}.table`);
      if ("vary" in raw) vary(raw.vary, `${where}.vary`);
      if ("tells" in raw)
        arr(raw.tells, `${where}.tells`).forEach((item, k) => lane(item, `${where}.tells[${String(k)}]`));
      break;
    }
    case "more": {
      onlyKeys(raw, new Set(["op", "at", "more"]), where, "more field");
      strList(raw.more, `${where}.more`);
      break;
    }
    case "after":
    case "before": {
      onlyKeys(raw, new Set(["op", "at", "steps"]), where, `${kind} field`);
      const steps = arr(raw.steps, `${where}.steps`);
      if (steps.length === 0) fail(`${where}.steps`, "expected at least one step");
      return {
        op: kind,
        at: raw.at as StepId,
        steps: steps.map((step, k) => ownStep(step, `${where}.steps[${String(k)}]`)),
      };
    }
    case "branch": {
      onlyKeys(raw, new Set(["op", "at", "branch"]), where, "branch field");
      return { op: "branch", at: raw.at as StepId, branch: ownBranch(raw.branch, `${where}.branch`) };
    }
    default:
      return fail(`${at}.op`, `"${kind}" is not an op (off, words, more, after, before, branch)`);
  }
  return raw as unknown as TradeOp;
}

function combo(value: unknown, at: string): string {
  const text = str(value, at);
  if (!COMBO.test(text)) return fail(at, `"${text}" is not a money path (price|before|after)`);
  return text;
}

function money(value: unknown, at: string): TradeMoney {
  const raw = obj(value, at);
  onlyKeys(raw, MONEY_KEYS, at, "money field");
  const out: TradeMoney = {
    main: combo(raw.main, `${at}.main`),
    combos: arr(raw.combos, `${at}.combos`).map((item, k) => combo(item, `${at}.combos[${String(k)}]`)),
    examples: strRecord(raw.examples, `${at}.examples`),
    amounts: amountTable(raw.amounts, `${at}.amounts`),
  };
  for (const key of Object.keys(out.examples)) combo(key, `${at}.examples (key ${key})`);
  if ("services" in raw) {
    const services: Record<string, TradeService> = {};
    for (const [id, item] of Object.entries(obj(raw.services, `${at}.services`))) {
      const svc = obj(item, `${at}.services.${id}`);
      onlyKeys(svc, SERVICE_KEYS, `${at}.services.${id}`, "service field");
      flowLetter(svc.flow, `${at}.services.${id}.flow`);
      str(svc.name, `${at}.services.${id}.name`);
      const where = `${at}.services.${id}`;
      const path = [svc.price, svc.before, svc.after].map((part, k) =>
        str(part, `${where}.${["price", "before", "after"][k] ?? "?"}`),
      );
      combo(path.join("|"), where);
      if ("amounts" in svc) strRecord(svc.amounts, `${where}.amounts`);
      if ("paidby" in svc) str(svc.paidby, `${where}.paidby`);
      services[id] = svc as unknown as TradeService;
    }
    out.services = services;
  }
  if ("booking" in raw) {
    const booking: Record<Name, Name[]> = {};
    for (const [group, values] of Object.entries(obj(raw.booking, `${at}.booking`)))
      booking[group] = strList(values, `${at}.booking.${group}`);
    out.booking = booking;
  }
  if ("labels" in raw) {
    const labels: Record<string, Record<string, string>> = {};
    for (const [question, values] of Object.entries(obj(raw.labels, `${at}.labels`)))
      labels[question] = strRecord(values, `${at}.labels.${question}`);
    out.labels = labels;
  }
  return out;
}

/** `x` for both flows, or an object whose keys are only A and B: each side read by `inner`. */
function perFlow<T>(value: unknown, at: string, inner: (item: unknown, at: string) => T): PerFlow<T> {
  if (isObj(value)) {
    const keys = Object.keys(value);
    if (keys.length > 0 && keys.every((key) => key === "A" || key === "B")) {
      const out: { A?: T; B?: T } = {};
      for (const flow of FLOWS) {
        if (flow in value) out[flow] = inner(value[flow], `${at}.${flow}`);
      }
      return out;
    }
  }
  return inner(value, at);
}

function arrive(value: unknown, at: string): Arrive {
  if (value === "window" || value === "setstart") return value;
  if (isObj(value)) {
    const keys = Object.keys(value);
    const hours = value.window;
    if (keys.length === 1 && typeof hours === "number" && Number.isInteger(hours) && hours >= 1)
      return { window: hours };
  }
  return fail(at, 'expected "window", "setstart" or { "window": hours }');
}

function settings(value: unknown, at: string): TradeSettings {
  const raw = obj(value, at);
  onlyKeys(raw, new Set(["arrive", "cutoff"]), at, "setting");
  const out: TradeSettings = {};
  if ("arrive" in raw) out.arrive = perFlow(raw.arrive, `${at}.arrive`, arrive);
  if ("cutoff" in raw) out.cutoff = perFlow(raw.cutoff, `${at}.cutoff`, str);
  return out;
}

function switches(value: unknown, at: string): TradeSwitches {
  const out: TradeSwitches = {};
  for (const [name, item] of Object.entries(obj(value, at))) out[name] = perFlow(item, `${at}.${name}`, bool);
  return out;
}

function slotRows(value: unknown, at: string): Record<string, RecordSlotRow[]> {
  const out: Record<string, RecordSlotRow[]> = {};
  for (const [slot, rows] of Object.entries(obj(value, at))) {
    out[slot] = arr(rows, `${at}.${slot}`).map((row, k) => {
      const where = `${at}.${slot}[${String(k)}]`;
      const raw = obj(row, where);
      onlyKeys(raw, new Set(["when", "text"]), where, "slot row field");
      gate(raw.when, `${where}.when`);
      str(raw.text, `${where}.text`);
      return raw as unknown as RecordSlotRow;
    });
  }
  return out;
}

/** The part of a trade file one flow owns: `value[flow]` of each per-flow top key. */
function flowOf(raw: Obj, flow: FlowLetter, at: string): LoadedTradeFlow {
  const block = obj(raw[flow], `${at}.${flow}`);
  onlyKeys(block, new Set(["ops"]), `${at}.${flow}`, "flow field");
  const perFlowKey = (key: string): unknown => {
    const holder = raw[key];
    if (holder === undefined) return undefined;
    return obj(holder, `${at}.${key}`)[flow];
  };
  const optionalRecord = (key: string): Record<string, string> | null => {
    const item = perFlowKey(key);
    return item === undefined ? null : strRecord(item, `${at}.${key}.${flow}`);
  };
  const slots = perFlowKey("slots");
  const story = obj(raw.story, `${at}.story`);
  const renames = obj(raw.rename, `${at}.rename`);
  const moneyBlock = obj(raw.money, `${at}.money`);
  return {
    flow,
    ops: arr(block.ops, `${at}.${flow}.ops`).map((item, k) => op(item, `${at}.${flow}.ops[${String(k)}]`)),
    rename: pairList(renames[flow], `${at}.rename.${flow}`),
    money: money(moneyBlock[flow], `${at}.money.${flow}`),
    slotRows: slots === undefined ? {} : slotRows(slots, `${at}.slots.${flow}`),
    cast: optionalRecord("cast"),
    names: optionalRecord("names"),
    story: str(story[flow], `${at}.story.${flow}`),
  };
}

/** Checks that a per-flow top key holds only A and B. */
function flowKeysOnly(raw: Obj, key: string, at: string): void {
  if (key in raw) onlyKeys(obj(raw[key], `${at}.${key}`), new Set(FLOWS), `${at}.${key}`, "flow key");
}

/**
 * Checks one trade file's parsed JSON and returns it loaded. `id` is the trade the file must be (its name without
 * `.json`). Throws TradeLoadError, naming the path, on any shape it does not expect.
 */
export function parseTrade(data: unknown, id: TradeId): LoadedTrade {
  const at = `${id}.json`;
  const raw = obj(data, at);
  onlyKeys(raw, TOP_KEYS, at, "top-level key");
  if (raw.id !== id) fail(`${at}.id`, `expected "${id}"`);
  const pattern = str(raw.pattern, `${at}.pattern`);
  if (!(PATTERNS as readonly string[]).includes(pattern))
    fail(`${at}.pattern`, `"${pattern}" is not a booking pattern`);
  for (const key of ["cast", "names", "slots", "rename", "story", "money"]) flowKeysOnly(raw, key, at);

  const plugin = obj(raw.plugin, `${at}.plugin`);
  onlyKeys(plugin, PLUGIN_KEYS, `${at}.plugin`, "plug-in key");
  const pluginText = {} as PluginText;
  for (const key of PF_TEXT_KEYS) {
    if (!(key in plugin)) fail(`${at}.plugin.${key}`, "the free-text block is missing");
    const block: unknown = plugin[key];
    if (typeof block !== "object" && typeof block !== "string")
      fail(`${at}.plugin.${key}`, "expected text, an object or a list");
    if (block === null) fail(`${at}.plugin.${key}`, "expected text, an object or a list");
    pluginText[key] = JSON.stringify(block);
  }

  return {
    id,
    name: str(raw.name, `${at}.name`),
    style: str(raw.style, `${at}.style`),
    pattern: pattern as Pattern,
    facts: "pf.facts" in plugin ? strList(plugin["pf.facts"], `${at}.plugin.pf.facts`) : null,
    switches: "pf.switches" in plugin ? switches(plugin["pf.switches"], `${at}.plugin.pf.switches`) : null,
    settings: "pf.settings" in plugin ? settings(plugin["pf.settings"], `${at}.plugin.pf.settings`) : null,
    pluginText,
    flows: { A: flowOf(raw, "A", at), B: flowOf(raw, "B", at) },
  };
}

/** The trade ids in `dir` (default: fixture set v1's trade folder), sorted: one per `<id>.json`. */
export function listTradeIds(dir: string = TRADE_DIR): TradeId[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    throw new TradeLoadError(
      `${dir}: cannot list the folder (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

/** Reads and loads one trade file from `dir` (default: fixture set v1's trade folder). */
export function loadTrade(id: TradeId, dir: string = TRADE_DIR): LoadedTrade {
  const file = `${dir.replace(/\/+$/, "")}/${id}.json`;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new TradeLoadError(
      `${file}: cannot read it as JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return parseTrade(data, id);
}

/** Loads every trade file in `dir`, by trade id in sorted order (243 in fixture set v1). */
export function loadTrades(dir: string = TRADE_DIR): Record<TradeId, LoadedTrade> {
  const out: Record<TradeId, LoadedTrade> = {};
  for (const id of listTradeIds(dir)) out[id] = loadTrade(id, dir);
  return out;
}
