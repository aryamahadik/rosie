// The master flow loader (T-132; Master Corrections R1 and R2).
//
// Reads engine/work/master/master-A.json and master-B.json (with their `record`) from fixture set v1's copy under
// fixtures/master/, checks them, and returns one typed FlowGraph per flow (compiler/src/graph/types.ts). It parses
// JSON only: the master's CommonJS scripts are not loaded here (T-131 answered WRAP for those, and they belong to the
// overlay applier, T-135).
//
//   R1  lane `san` is Rosie and lane `agent` is the customer's own AI assistant (LANE_MEANING, laneMeaning).
//   R2  the authoring fields `src` and `prop` are dropped from every step (AUTHORING_FIELDS).
//
// The loader never counts or shapes anything to reach a number: a step or branch the master has is loaded, and a
// shape it does not expect is an error that names the path (MasterLoadError), not a silent skip. Every other field
// of a step and a branch is kept as the master writes it.
//
// This file imports only Node built-ins and TYPES, so Node runs it as it is (a CLI command can import it).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AmountTable,
  Branch,
  CatalogEntry,
  FlowGraph,
  FlowLetter,
  Gate,
  Lane,
  LayerLine,
  MasterGraphs,
  MasterMoney,
  MasterRecord,
  Message,
  NotInEntry,
  Pair,
  PluginSlot,
  Section,
  Step,
  StepId,
} from "../graph/types.ts";

/** The master's eight lanes, in the order of the flow files' `lanes` (SPEC-master 4). */
export const LANES = [
  "owner",
  "san",
  "staff",
  "cust",
  "agent",
  "pay",
  "out",
  "other",
] as const satisfies readonly Lane[];

/**
 * Who each lane is, in plain words (SPEC-master 4 'who / to'; Master Corrections R1: `san` is Rosie and `agent` is
 * the customer's own AI assistant; neither means anything else).
 */
export const LANE_MEANING: Readonly<Record<Lane, string>> = {
  owner: "the owner or office manager",
  san: "Rosie",
  staff: "the business's staff",
  cust: "the customer",
  agent: "the customer's own AI assistant",
  pay: "Stripe",
  out: "an outside service",
  other: "anyone else",
};

/** What a lane stands for (R1). */
export function laneMeaning(lane: Lane): string {
  return LANE_MEANING[lane];
}

/** Fields of a step the loader drops (Master Corrections R2: `src` pointers to old flowchart nodes, `prop` proposal ids). */
export const AUTHORING_FIELDS: readonly string[] = ["src", "prop"];

/** Where fixture set v1 keeps the master flows, from the repository root. */
export const MASTER_DIR = fileURLToPath(
  new URL("../../../fixtures/master/engine/work/master/", import.meta.url),
);

/** A master file that does not have the shape the loader reads. The message names the path to the offending value. */
export class MasterLoadError extends Error {
  override name = "MasterLoadError";
}

type Obj = Record<string, unknown>;

const VIAS: readonly string[] = ["chat", "msg", "portal", "page", "sync", "auto", "visit", "call", "email"];
const FLOWS: readonly string[] = ["A", "B"];
const STEP_ID = /^[SAB](1[0-3]|[1-9])-[0-9]{2,3}$/;

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
  ...AUTHORING_FIELDS,
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
const FLOW_KEYS: ReadonlySet<string> = new Set([
  "title",
  "short",
  "story",
  "intro",
  "cast",
  "names",
  "lanes",
  "amounts",
  "id",
  "steps",
  "notIn",
  "money",
  "d75",
  "switches",
  "facts",
  "record",
  "took",
  "layerLines",
]);

function fail(at: string, message: string): never {
  throw new MasterLoadError(`${at}: ${message}`);
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

function lane(value: unknown, at: string): Lane {
  const text = str(value, at);
  if (!(LANES as readonly string[]).includes(text))
    return fail(at, `"${text}" is not one of the eight lanes`);
  return text as Lane;
}

function laneList(value: unknown, at: string): Lane[] {
  return arr(value, at).map((item, k) => lane(item, `${at}[${String(k)}]`));
}

function flowLetter(value: unknown, at: string): FlowLetter {
  const text = str(value, at);
  if (!FLOWS.includes(text)) return fail(at, `"${text}" is not a flow letter (A or B)`);
  return text as FlowLetter;
}

function stepId(value: unknown, at: string): StepId {
  const text = str(value, at);
  if (!STEP_ID.test(text)) return fail(at, `"${text}" is not a step id`);
  return text;
}

function pair(value: unknown, at: string): Pair {
  const items = arr(value, at);
  if (items.length !== 2) return fail(at, "expected two strings");
  return [str(items[0], `${at}[0]`), str(items[1], `${at}[1]`)];
}

function amountTable(value: unknown, at: string): AmountTable {
  const out: AmountTable = {};
  for (const [key, row] of Object.entries(obj(value, at))) out[key] = strRecord(row, `${at}.${key}`);
  return out;
}

function table(value: unknown, at: string): { head: string[]; rows: string[][] } {
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

/** One message: [from, to, text] or [from, to, text, elements]. The elements stay as written. */
function message(value: unknown, at: string): Message {
  const items = arr(value, at);
  if (items.length < 3 || items.length > 4)
    return fail(at, "expected [from, to, text] or [from, to, text, elements]");
  const head: [Lane, Lane, string] = [
    lane(items[0], `${at}[0]`),
    lane(items[1], `${at}[1]`),
    str(items[2], `${at}[2]`),
  ];
  if (items.length === 3) return head;
  return [...head, obj(items[3], `${at}[3]`)] as Message;
}

function messages(value: unknown, at: string): Message[] {
  return arr(value, at).map((item, k) => message(item, `${at}[${String(k)}]`));
}

function vary(value: unknown, at: string): Obj {
  const raw = obj(value, at);
  for (const [key, patch] of Object.entries(raw)) {
    const inner = obj(patch, `${at}.${key}`);
    if ("say" in inner) messages(inner.say, `${at}.${key}.say`);
    if ("addSay" in inner) messages(inner.addSay, `${at}.${key}.addSay`);
    if ("more" in inner) strList(inner.more, `${at}.${key}.more`);
    if ("addMore" in inner) strList(inner.addMore, `${at}.${key}.addMore`);
    if ("swap" in inner)
      arr(inner.swap, `${at}.${key}.swap`).forEach((p, k) => pair(p, `${at}.${key}.swap[${String(k)}]`));
    if ("form" in inner)
      arr(inner.form, `${at}.${key}.form`).forEach((p, k) => pair(p, `${at}.${key}.form[${String(k)}]`));
    if ("table" in inner) table(inner.table, `${at}.${key}.table`);
  }
  return raw;
}

function pluginSlot(value: unknown, at: string): PluginSlot {
  const raw = obj(value, at);
  str(raw.fills, `${at}.fills`);
  strList(raw.reads, `${at}.reads`);
  strList(raw.gives, `${at}.gives`);
  return raw as unknown as PluginSlot;
}

/** The section a step id belongs to: the digits between the letter and the dash (SPEC-master 4). */
function idSection(id: StepId): number {
  return Number(id.slice(1, id.indexOf("-")));
}

interface Walk {
  flow: FlowLetter;
  index: Record<StepId, Step>;
}

/** Checks one step's fields, drops the authoring ones (R2) and returns the node, with its branches loaded. */
function parseStep(value: unknown, at: string, walk: Walk, section: number | null): Step {
  const raw = obj(value, at);
  for (const key of Object.keys(raw)) {
    if (!STEP_KEYS.has(key)) fail(`${at}.${key}`, "unknown step field");
  }
  const id = stepId(raw.id, `${at}.id`);
  const where = `${at} (${id})`;
  if (!id.startsWith("S") && !id.startsWith(walk.flow))
    fail(`${where}.id`, `a step of the other flow (flow ${walk.flow})`);
  if (id in walk.index) fail(`${where}.id`, "the id is used twice in the flow");

  const idSec = idSection(id);
  if ("sec" in raw) {
    const sec = raw.sec;
    if (typeof sec !== "number" || !Number.isInteger(sec) || sec < 1 || sec > 13)
      fail(`${where}.sec`, "expected 1 to 13");
    if (sec !== idSec)
      fail(`${where}.sec`, `${String(sec)} disagrees with the id's section ${String(idSec)}`);
  }
  if (section !== null && idSec !== section)
    fail(`${where}.id`, `section ${String(idSec)} inside a section ${String(section)} step`);

  if (strList(raw.line, `${where}.line`).length === 0)
    fail(`${where}.line`, "expected at least one LINES.md line");
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
  if ("layerAdd" in raw) layerLines(raw.layerAdd, `${where}.layerAdd`);
  if ("tells" in raw) laneList(raw.tells, `${where}.tells`);
  if ("say" in raw) messages(raw.say, `${where}.say`);
  if ("form" in raw)
    arr(raw.form, `${where}.form`).forEach((row, k) => pair(row, `${where}.form[${String(k)}]`));
  if ("table" in raw) table(raw.table, `${where}.table`);
  if ("when" in raw) gate(raw.when, `${where}.when`);
  if ("vary" in raw) vary(raw.vary, `${where}.vary`);
  if ("slot" in raw) pluginSlot(raw.slot, `${where}.slot`);
  if ("amounts" in raw) amountTable(raw.amounts, `${where}.amounts`);
  for (const key of ["took", "timing"]) {
    if (key in raw && raw[key] !== false) flowLetter(raw[key], `${where}.${key}`);
  }
  for (const key of ["ev", "rec"]) {
    if (key in raw) flowLetter(raw[key], `${where}.${key}`);
  }
  if ("wr" in raw && raw.wr !== false) fail(`${where}.wr`, "expected false");
  if ("kind" in raw && raw.kind !== "rule") fail(`${where}.kind`, 'expected "rule"');
  if ("type" in raw && raw.type !== "split" && raw.type !== "step")
    fail(`${where}.type`, 'expected "split" or "step"');

  const isSplit = raw.type === "split";
  if (isSplit !== "branches" in raw)
    fail(
      `${where}.branches`,
      isSplit ? "a split without branches" : "branches on a step that is not a split",
    );
  if (isSplit && !("q" in raw)) fail(`${where}.q`, "a split without its question");

  // R2: copy every field but the authoring ones. The node is registered before its branches load, so a branch step
  // that repeats an ancestor's id is caught as a duplicate.
  const node: Obj = {};
  for (const [key, item] of Object.entries(raw)) {
    if (!AUTHORING_FIELDS.includes(key) && key !== "branches") node[key] = item;
  }
  node.section = idSec;
  const step = node as unknown as Step;
  walk.index[id] = step;
  if (isSplit) {
    step.branches = arr(raw.branches, `${where}.branches`).map((branch, k) =>
      parseBranch(branch, `${where}.branches[${String(k)}]`, walk, idSec),
    );
  }
  return step;
}

function parseBranch(value: unknown, at: string, walk: Walk, section: number): Branch {
  const raw = obj(value, at);
  for (const key of Object.keys(raw)) {
    if (!BRANCH_KEYS.has(key)) fail(`${at}.${key}`, "unknown branch field");
  }
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
  branch.steps = arr(raw.steps, `${where}.steps`).map((child, k) =>
    parseStep(child, `${where}.steps[${String(k)}]`, walk, section),
  );
  return branch as unknown as Branch;
}

function sectionsOf(path: Step[], at: string): Section[] {
  const sections: Section[] = [];
  for (const step of path) {
    const last = sections.at(-1);
    if (last?.n === step.section) {
      last.steps.push(step.id);
    } else {
      if (step.section !== (last?.n ?? 0) + 1)
        fail(
          `${at} (${step.id})`,
          `section ${String(step.section)} does not follow section ${String(last?.n ?? 0)}`,
        );
      if (step.phase === undefined)
        fail(`${at} (${step.id})`, "the first step of a section has no phase (its title)");
      sections.push({ n: step.section, title: step.phase, steps: [step.id] });
    }
  }
  if (sections.length !== 13) fail(at, `expected 13 sections, found ${String(sections.length)}`);
  return sections;
}

function catalog(value: unknown, at: string): Record<string, CatalogEntry> {
  const out: Record<string, CatalogEntry> = {};
  for (const [key, entry] of Object.entries(obj(value, at))) {
    const raw = obj(entry, `${at}.${key}`);
    out[key] = { label: str(raw.label, `${at}.${key}.label`), means: str(raw.means, `${at}.${key}.means`) };
  }
  return out;
}

function money(value: unknown, at: string): MasterMoney {
  const raw = obj(value, at);
  const dims = obj(raw.dims, `${at}.dims`);
  for (const dim of ["price", "before", "after"]) {
    arr(dims[dim], `${at}.dims.${dim}`).forEach((choice, k) => {
      const entry = obj(choice, `${at}.dims.${dim}[${String(k)}]`);
      str(entry.k, `${at}.dims.${dim}[${String(k)}].k`);
      str(entry.label, `${at}.dims.${dim}[${String(k)}].label`);
    });
  }
  strList(raw.after, `${at}.after`);
  strList(raw.combos, `${at}.combos`);
  strRecord(raw.examples, `${at}.examples`);
  const ways = obj(raw.ways, `${at}.ways`);
  strList(ways.before, `${at}.ways.before`);
  bool(ways.restLater, `${at}.ways.restLater`);
  return raw as unknown as MasterMoney;
}

function layerLines(value: unknown, at: string): LayerLine[] {
  return arr(value, at).map((entry, k) => {
    const raw = obj(entry, `${at}[${String(k)}]`);
    str(raw.id, `${at}[${String(k)}].id`);
    gate(raw.when, `${at}[${String(k)}].when`);
    str(raw.line, `${at}[${String(k)}].line`);
    if ("to" in raw) laneList(raw.to, `${at}[${String(k)}].to`);
    return raw as unknown as LayerLine;
  });
}

function notIn(value: unknown, at: string): NotInEntry[] {
  return arr(value, at).map((entry, k) => {
    const raw = obj(entry, `${at}[${String(k)}]`);
    str(raw.line, `${at}[${String(k)}].line`);
    str(raw.why, `${at}[${String(k)}].why`);
    return raw as unknown as NotInEntry;
  });
}

/** The record: the parts the loader names are checked; the lint tables, ways and live lists stay as written. */
function record(value: unknown, at: string): MasterRecord {
  const raw = obj(value, at);
  for (const key of ["from", "main", "homes"]) strRecord(raw[key], `${at}.${key}`);
  obj(raw.ways, `${at}.ways`);
  obj(raw.slots, `${at}.slots`);
  obj(raw.services, `${at}.services`);
  arr(raw.fixtures, `${at}.fixtures`);
  obj(raw.lint, `${at}.lint`);
  bool(raw.onefee, `${at}.onefee`);
  obj(raw.live, `${at}.live`);
  str(raw.ledger_rules, `${at}.ledger_rules`);
  return raw as unknown as MasterRecord;
}

/**
 * Checks one master flow file's parsed JSON and returns its typed graph. `flow` is the flow the file must be.
 * Throws MasterLoadError, naming the path, on any shape it does not expect.
 */
export function parseFlow(data: unknown, flow: FlowLetter): FlowGraph {
  const at = `master-${flow}.json`;
  const raw = obj(data, at);
  for (const key of Object.keys(raw)) {
    if (!FLOW_KEYS.has(key)) fail(`${at}.${key}`, "unknown top-level key");
  }
  if (raw.id !== flow) fail(`${at}.id`, `expected "${flow}"`);
  const lanes = laneList(raw.lanes, `${at}.lanes`);
  if (lanes.join() !== LANES.join()) fail(`${at}.lanes`, `expected ${LANES.join(", ")}`);

  const walk: Walk = { flow, index: {} };
  const path = arr(raw.steps, `${at}.steps`).map((step, k) =>
    parseStep(step, `${at}.steps[${String(k)}]`, walk, null),
  );
  const sections = sectionsOf(path, `${at}.steps`);

  const tookAt = stepId(raw.took, `${at}.took`);
  if (!(tookAt in walk.index)) fail(`${at}.took`, `${tookAt} is not a step of the flow`);
  const lines = layerLines(raw.layerLines, `${at}.layerLines`);
  const lineIds = new Set(lines.map((line) => line.id));
  for (const step of Object.values(walk.index)) {
    for (const line of step.layerAdd ?? []) {
      if (!lineIds.has(line.id))
        fail(`${at} (${step.id}).layerAdd`, `"${line.id}" is not one of the flow's layer lines`);
    }
  }

  return {
    flow,
    title: str(raw.title, `${at}.title`),
    short: str(raw.short, `${at}.short`),
    story: str(raw.story, `${at}.story`),
    intro: str(raw.intro, `${at}.intro`),
    cast: strRecord(raw.cast, `${at}.cast`),
    names: strRecord(raw.names, `${at}.names`),
    lanes,
    amounts: amountTable(raw.amounts, `${at}.amounts`),
    path,
    steps: walk.index,
    sections,
    notIn: notIn(raw.notIn, `${at}.notIn`),
    money: money(raw.money, `${at}.money`),
    d75: bool(raw.d75, `${at}.d75`),
    switches: catalog(raw.switches, `${at}.switches`),
    facts: catalog(raw.facts, `${at}.facts`),
    record: record(raw.record, `${at}.record`),
    tookAt,
    layerLines: lines,
  };
}

/** Reads and loads one flow's master file from `dir` (default: fixture set v1's master folder). */
export function loadFlow(flow: FlowLetter, dir: string = MASTER_DIR): FlowGraph {
  const file = `${dir.replace(/\/+$/, "")}/master-${flow}.json`;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new MasterLoadError(
      `${file}: cannot read it as JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return parseFlow(data, flow);
}

/** Loads both flows and lists the S-steps they share (one node per id in each flow). */
export function loadMaster(dir: string = MASTER_DIR): MasterGraphs {
  const A = loadFlow("A", dir);
  const B = loadFlow("B", dir);
  const sharedIds = Object.keys(A.steps)
    .filter((id) => id.startsWith("S") && id in B.steps)
    .sort();
  return { A, B, sharedIds };
}

/** What a loaded flow holds: its steps (branch steps included), its splits and its branches. */
export function flowCounts(graph: FlowGraph): { steps: number; splits: number; branches: number } {
  const steps = Object.values(graph.steps);
  return {
    steps: steps.length,
    splits: steps.filter((step) => step.type === "split").length,
    branches: steps.reduce((total, step) => total + (step.branches?.length ?? 0), 0),
  };
}
