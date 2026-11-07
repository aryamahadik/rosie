// The record engine (T-137; K-01 v1 'record'; C-061).
//
// The booking record is the one place that holds each fact once: ten homes (the step that owns money, contact, proof,
// stop, clock, who, safety, change, the record and the $2), the 16 named slots with their rows, the money ways, one
// fee per booking, the ledger rules, the 11 fixtures and the live switches. This file compiles it, per flow from the
// master (compileRecord) and per trade (compileTradeRecord), into the K-01 `record` shape the bundle holds, and reads
// back which row of a slot fits a path (slotRowIndex).
//
// NQ-PB-2 answered WRAP: the record is not re-built here. overlay-core.js apply() has already laid a trade's record
// over the master's (profRecord, its line 1867: the master's rows renamed with the trade's pairs, the trade's own rows
// first, its own services joined), so the trade's record is read from the applied flow and checked against the trade's
// own rows. Which row fits a path is decided by the vendored slotRow(), run on the compiled record itself (useRecord),
// never by a second copy of the rule.
//
// What is refused, each naming the place (RecordError and its kinds):
//   - a record with the wrong homes, slots, ways, services, fixtures or rows (the shape K-01 names);
//   - a `hold` anywhere (D66: a slot {{hold}}, a way `hold`, a `before: hold` gate or service): HoldSlotError;
//   - onefee other than true (one fee per booking): OneFeeError;
//   - a trade slot row for a slot that is not one of the 16, or own rows that did not land first: TradeSlotError.
//
// The compiled record holds only K-01's fields: the authoring note `_about`, the trade's `_settings` and the `own`
// mark on a row are left out (Master Corrections R2). The trade's own rows are counted apart (`ownRows`).
import type {
  AmountTable,
  FlowGraph,
  FlowLetter,
  Gate,
  MasterGraphs,
  MasterRecord,
  RecordFixture,
  RecordLint,
  StepId,
} from "../graph/types.ts";
import type { LoadedTrade, TradeId, TradeService } from "../load/trade";
import type { AppliedTrade } from "../overlay/apply";
import { loadPathScripts, type CorePath, type PathCore } from "../path/core";
import { toCorePath, type TradePath } from "../path/model";

/** The ten homes, in the order of K-01 `homes` (master record.homes). */
export const HOME_NAMES = [
  "money",
  "contact",
  "proof",
  "stop",
  "clock",
  "who",
  "safety",
  "change",
  "record",
  "two",
] as const;
export type HomeName = (typeof HOME_NAMES)[number];

/** The 16 named record slots, in the order of K-03's slot vocabulary (contracts/message-plan/fixtures/slots.json). */
export const SLOT_NAMES = [
  "pay.asks",
  "pay.price",
  "pay.took",
  "pay.left",
  "pay.cancel",
  "pay.late",
  "pay.noshow",
  "pay.back",
  "pay.after",
  "pay.staff",
  "pay.failed",
  "clock.pay",
  "two.count",
  "reach.way",
  "reach.to",
  "who.ok",
] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

/** One row of a slot: the first row whose `when` fits wins; a row with no `when` fits every path. */
export interface CompiledSlotRow {
  when?: Gate;
  text: string;
}

/** One named slot with its rows in first-fit order (a trade's own rows, when it has some, come before the master's). */
export interface CompiledSlot {
  home: StepId;
  means: string;
  rows: CompiledSlotRow[];
}

/** One money way (K-01 record.ways.<way>): what is paid now, whether a card is saved, which fee, what goes back. */
export interface RecordWay {
  now: string;
  card: boolean | "asis";
  fee: string;
  back: string;
}

/** A record service: the master's example services and the trade's own (money.<flow>.services). */
export type CompiledService = TradeService;

/** The compiled record: exactly K-01 `record`. */
export interface CompiledRecord {
  from: Record<FlowLetter, StepId>;
  main: Record<FlowLetter, string>;
  ways: Record<string, RecordWay>;
  homes: Record<HomeName, StepId>;
  slots: Record<SlotName, CompiledSlot>;
  services: Record<string, CompiledService>;
  fixtures: RecordFixture[];
  lint: RecordLint;
  /** One fee per booking: the largest service fee (always true; anything else is refused). */
  onefee: true;
  live: MasterRecord["live"];
  /** The ledger rules in words (what `keep`, `due`, `paidnow` ... mean). */
  ledger_rules: string;
}

/** The compiled record of one flow, for the master (`trade` null) or for one trade. */
export interface CompiledRecordView {
  flow: FlowLetter;
  trade: TradeId | null;
  record: CompiledRecord;
  /** The flow's amount table the record's facts read (the trade's own for a trade): the vendored recordOf needs it. */
  amounts: AmountTable;
  /** How many rows at the front of each slot are the trade's own (all 0 for the master). */
  ownRows: Record<SlotName, number>;
}

/** A record that does not have the shape K-01 names, or breaks one of its rules. The message names the place. */
export class RecordError extends Error {
  override name = "RecordError";
}

/** A `hold` in the record (D66: nothing is held; a card is saved, a deposit or the full price is taken). */
export class HoldSlotError extends RecordError {
  override name = "HoldSlotError";
}

/** onefee is not true: the booking would not have one fee. */
export class OneFeeError extends RecordError {
  override name = "OneFeeError";
}

/** A trade's own rows for a slot the record does not have, or own rows that are not first in their slot. */
export class TradeSlotError extends RecordError {
  override name = "TradeSlotError";
  readonly trade: TradeId;
  readonly flow: FlowLetter;

  constructor(trade: TradeId, flow: FlowLetter, message: string) {
    super(`${trade} flow ${flow}: ${message}`);
    this.trade = trade;
    this.flow = flow;
  }
}

type Obj = Record<string, unknown>;

const STEP_ID = /^[SAB](1[0-3]|[1-9])-[0-9]{2,3}$/;
const FIXTURE_ID = /^[a-z0-9][a-z0-9-]*$/;
const FLOWS: readonly FlowLetter[] = ["A", "B"];
const PRICES: readonly string[] = ["list", "photos", "visit"];
const BEFORES: readonly string[] = ["none", "card", "deposit", "full"];
const AFTERS: readonly string[] = ["none", "counter", "bill", "card", "own"];
const WAY_FIELDS: readonly string[] = ["now", "card", "fee", "back"];
const GATE_LISTS: readonly string[] = [
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
];
const GATE_STAMPS: readonly string[] = ["took", "ev", "wr"];
const FIXTURE_KEYS: readonly string[] = ["id", "label", "add", "on", "facts", "booking"];
const LIVE_KEYS: readonly string[] = ["switches", "facts", "off", "merged"];
/** `{{hold}}`, `{{hold:$40}}` or `{{hold|words}}` (overlay-core.js AMOUNT_RE reads all three). */
const HOLD_SLOT = /\{\{\s*hold\s*(?:[:|}])/;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(at: string, message: string): never {
  throw new RecordError(`${at}: ${message}`);
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

function strList(value: unknown, at: string): string[] {
  return arr(value, at).map((item, k) => str(item, `${at}[${String(k)}]`));
}

function noHold(text: string, at: string): void {
  if (HOLD_SLOT.test(text)) throw new HoldSlotError(`${at}: {{hold}} is refused (D66: nothing is held)`);
}

function sameKeys(raw: Obj, names: readonly string[], at: string): void {
  for (const name of names) if (!(name in raw)) fail(`${at}.${name}`, "missing");
  for (const key of Object.keys(raw))
    if (!names.includes(key)) fail(`${at}.${key}`, "not part of the record");
}

function stepIdAt(value: unknown, at: string): StepId {
  const text = str(value, at);
  if (!STEP_ID.test(text)) return fail(at, `"${text}" is not a step id`);
  return text;
}

function flowMap(
  value: unknown,
  at: string,
  check: (value: unknown, at: string) => string,
): Record<FlowLetter, string> {
  const raw = obj(value, at);
  sameKeys(raw, FLOWS, at);
  return { A: check(raw.A, `${at}.A`), B: check(raw.B, `${at}.B`) };
}

/** A `when`: known keys only, lists of strings, record facts the vendored script knows, no `hold` choice. */
function gateAt(value: unknown, at: string, recFacts: readonly string[]): Gate {
  const raw = obj(value, at);
  for (const [key, item] of Object.entries(raw)) {
    if (GATE_LISTS.includes(key)) {
      const list = strList(item, `${at}.${key}`);
      if (key === "before" && list.includes("hold"))
        throw new HoldSlotError(`${at}.before: a hold choice is refused (D66)`);
      if (key === "rec" || key === "recOff") {
        for (const name of list)
          if (!recFacts.includes(name)) fail(`${at}.${key}`, `"${name}" is not a record fact`);
      }
    } else if (!GATE_STAMPS.includes(key)) fail(`${at}.${key}`, "unknown gate key");
  }
  const gate: Gate = structuredClone(raw);
  return gate;
}

function choice(value: unknown, at: string, allowed: readonly string[]): string {
  const text = str(value, at);
  if (text === "hold") throw new HoldSlotError(`${at}: a hold choice is refused (D66)`);
  if (!allowed.includes(text)) return fail(at, `"${text}" is not one of ${allowed.join(", ")}`);
  return text;
}

function waysAt(value: unknown, at: string): Record<string, RecordWay> {
  const out: Record<string, RecordWay> = {};
  for (const [name, entry] of Object.entries(obj(value, at))) {
    if (name === "hold") throw new HoldSlotError(`${at}.hold: a hold way is refused (D66)`);
    const raw = obj(entry, `${at}.${name}`);
    sameKeys(raw, WAY_FIELDS, `${at}.${name}`);
    if (typeof raw.card !== "boolean" && raw.card !== "asis")
      fail(`${at}.${name}.card`, 'expected true, false or "asis"');
    out[name] = {
      now: str(raw.now, `${at}.${name}.now`),
      card: raw.card,
      fee: str(raw.fee, `${at}.${name}.fee`),
      back: str(raw.back, `${at}.${name}.back`),
    };
  }
  if (Object.keys(out).length === 0) fail(at, "no money ways");
  return out;
}

function servicesAt(value: unknown, at: string): Record<string, CompiledService> {
  const out: Record<string, CompiledService> = {};
  for (const [id, entry] of Object.entries(obj(value, at))) {
    const raw = obj(entry, `${at}.${id}`);
    const where = `${at}.${id}`;
    if (!FLOWS.includes(raw.flow as FlowLetter)) fail(`${where}.flow`, "expected A or B");
    choice(raw.price, `${where}.price`, PRICES);
    choice(raw.before, `${where}.before`, BEFORES);
    choice(raw.after, `${where}.after`, AFTERS);
    if ("name" in raw) str(raw.name, `${where}.name`);
    if ("amounts" in raw) {
      for (const [field, amount] of Object.entries(obj(raw.amounts, `${where}.amounts`)))
        str(amount, `${where}.amounts.${field}`);
    }
    if ("paidby" in raw) str(raw.paidby, `${where}.paidby`);
    out[id] = structuredClone(raw) as unknown as CompiledService;
  }
  return out;
}

function fixturesAt(value: unknown, at: string, services: Record<string, CompiledService>): RecordFixture[] {
  const seen = new Set<string>();
  return arr(value, at).map((entry, k) => {
    const where = `${at}[${String(k)}]`;
    const raw = obj(entry, where);
    for (const key of Object.keys(raw))
      if (!FIXTURE_KEYS.includes(key)) fail(`${where}.${key}`, "unknown fixture field");
    const id = str(raw.id, `${where}.id`);
    if (!FIXTURE_ID.test(id)) fail(`${where}.id`, `"${id}" is not a fixture id`);
    if (seen.has(id)) fail(`${where}.id`, `"${id}" is used twice`);
    seen.add(id);
    str(raw.label, `${where}.label`);
    if ("on" in raw) str(raw.on, `${where}.on`);
    if ("facts" in raw) strList(raw.facts, `${where}.facts`);
    if ("add" in raw) {
      for (const service of strList(raw.add, `${where}.add`))
        if (!(service in services)) fail(`${where}.add`, `"${service}" is not one of the record's services`);
    }
    if ("booking" in raw) {
      for (const [group, name] of Object.entries(obj(raw.booking, `${where}.booking`)))
        str(name, `${where}.booking.${group}`);
    }
    return structuredClone(raw) as unknown as RecordFixture;
  });
}

function recFactsOf(core: PathCore): string[] {
  const facts = (core as unknown as { REC?: unknown }).REC;
  if (!Array.isArray(facts) || !facts.every((fact): fact is string => typeof fact === "string"))
    throw new RecordError("overlay-core.js does not export REC (the record facts)");
  return facts;
}

/** Checks one record table and returns it as K-01 `record`, the trade's own marks counted. `raw` is the master's table or a trade's. */
function build(raw: Obj, at: string): { record: CompiledRecord; own: Record<SlotName, number> } {
  const recFacts = recFactsOf(loadPathScripts().core);

  const homesRaw = obj(raw.homes, `${at}.homes`);
  sameKeys(homesRaw, HOME_NAMES, `${at}.homes`);
  const homes = {} as Record<HomeName, StepId>;
  for (const name of HOME_NAMES) homes[name] = stepIdAt(homesRaw[name], `${at}.homes.${name}`);
  const homeSteps = new Set<string>(Object.values(homes));

  const slotsRaw = obj(raw.slots, `${at}.slots`);
  sameKeys(slotsRaw, SLOT_NAMES, `${at}.slots`);
  const slots = {} as Record<SlotName, CompiledSlot>;
  const own = {} as Record<SlotName, number>;
  for (const name of SLOT_NAMES) {
    const where = `${at}.slots.${name}`;
    const slot = obj(slotsRaw[name], where);
    const home = stepIdAt(slot.home, `${where}.home`);
    if (!homeSteps.has(home)) fail(`${where}.home`, `${home} is not one of the record's homes`);
    const rows = arr(slot.rows, `${where}.rows`);
    if (rows.length === 0) fail(`${where}.rows`, "a slot with no rows");
    let leading = 0;
    let counting = true;
    slots[name] = {
      home,
      means: str(slot.means, `${where}.means`),
      rows: rows.map((entry, k) => {
        const rowAt = `${where}.rows[${String(k)}]`;
        const row = obj(entry, rowAt);
        const text = str(row.text, `${rowAt}.text`);
        noHold(text, `${rowAt}.text`);
        if (counting && row.own === true) leading += 1;
        else counting = false;
        const out: CompiledSlotRow = { text };
        if ("when" in row) out.when = gateAt(row.when, `${rowAt}.when`, recFacts);
        return out;
      }),
    };
    own[name] = leading;
    if (slots[name].rows.at(-1)?.when !== undefined)
      fail(
        `${where}.rows`,
        "the last row has a `when`: a path could fit no row and the slot would stay empty",
      );
  }

  const ways = waysAt(raw.ways, `${at}.ways`);
  const services = servicesAt(raw.services, `${at}.services`);
  const fixtures = fixturesAt(raw.fixtures, `${at}.fixtures`, services);

  if (raw.onefee !== true) throw new OneFeeError(`${at}.onefee: expected true (one fee per booking)`);

  const lint = obj(raw.lint, `${at}.lint`);
  sameKeys(lint, ["phrases", "pointers", "allow", "banned"], `${at}.lint`);
  obj(lint.phrases, `${at}.lint.phrases`);
  strList(lint.pointers, `${at}.lint.pointers`);
  obj(lint.allow, `${at}.lint.allow`);

  const live = obj(raw.live, `${at}.live`);
  sameKeys(live, LIVE_KEYS, `${at}.live`);
  strList(live.switches, `${at}.live.switches`);
  strList(live.facts, `${at}.live.facts`);
  obj(live.off, `${at}.live.off`);
  obj(live.merged, `${at}.live.merged`);

  const record: CompiledRecord = {
    from: flowMap(raw.from, `${at}.from`, stepIdAt),
    main: flowMap(raw.main, `${at}.main`, (value, where) => {
      const text = str(value, where);
      const parts = text.split("|");
      choice(parts[0], where, PRICES);
      choice(parts[1], where, BEFORES);
      choice(parts[2], where, AFTERS);
      if (parts.length !== 3) fail(where, `"${text}" is not price|before|after`);
      return text;
    }),
    ways,
    homes,
    slots,
    services,
    fixtures,
    lint: structuredClone(lint) as unknown as RecordLint,
    onefee: true,
    live: structuredClone(live) as unknown as MasterRecord["live"],
    ledger_rules: str(raw.ledger_rules, `${at}.ledger_rules`),
  };
  return { record, own };
}

/** The master's record for one flow, compiled (T-132's loaded flow). The homes are only checked for their spelling here: see compileRecords. */
export function compileRecord(graph: FlowGraph): CompiledRecordView {
  const { record, own } = build(graph.record as unknown as Obj, `master-${graph.flow}.json record`);
  return { flow: graph.flow, trade: null, record, amounts: structuredClone(graph.amounts), ownRows: own };
}

/** Both flows' master records, with every home and slot home checked against the steps of the two flows (flow B has no A9-21, `two`'s home). */
export function compileRecords(master: MasterGraphs): Record<FlowLetter, CompiledRecordView> {
  const out = { A: compileRecord(master.A), B: compileRecord(master.B) };
  for (const flow of FLOWS) {
    const { homes } = out[flow].record;
    for (const name of HOME_NAMES) {
      const id = homes[name];
      if (!(id in master.A.steps) && !(id in master.B.steps))
        fail(`master-${flow}.json record.homes.${name}`, `${id} is not a step of either flow`);
    }
  }
  return out;
}

/**
 * A trade's record for one flow: the record apply() left on the applied flow (the master's rows renamed, the trade's own
 * rows first, its own services joined), compiled and checked against the trade's own slot rows. `applied` is
 * applyTrade() of `trade` for the flow.
 */
export function compileTradeRecord(applied: AppliedTrade, trade: LoadedTrade): CompiledRecordView {
  const flow = applied.flow.id;
  if (applied.trade !== trade.id)
    throw new RecordError(`the applied flow is ${applied.trade}'s, but the trade given is ${trade.id}`);
  const at = `${trade.id} flow ${flow} record`;
  const { record, own } = build(applied.flow.record as unknown as Obj, at);

  const given = trade.flows[flow].slotRows;
  for (const name of Object.keys(given)) {
    if (!(SLOT_NAMES as readonly string[]).includes(name))
      throw new TradeSlotError(
        trade.id,
        flow,
        `slots.${name} is not one of the record's 16 slots (the vendored apply() would leave it out)`,
      );
  }
  for (const name of SLOT_NAMES) {
    const rows = given[name] ?? [];
    if (own[name] !== rows.length)
      throw new TradeSlotError(
        trade.id,
        flow,
        `${name} has ${String(rows.length)} own rows in the trade file but ${String(own[name])} first in the record`,
      );
    rows.forEach((row, k) => {
      const placed = record.slots[name].rows[k];
      const same = placed?.text === row.text && JSON.stringify(placed.when) === JSON.stringify(row.when);
      if (!same)
        throw new TradeSlotError(trade.id, flow, `${name} own row ${String(k + 1)} is not the trade's row`);
    });
  }
  return { flow, trade: trade.id, record, amounts: structuredClone(applied.flow.amounts), ownRows: own };
}

/** What a step is stamped with, as far as a slot's rows read it (overlay-core.js slotRow: `took`, `ev`, `wr`). */
export interface RowStamps {
  took?: FlowLetter | false;
  ev?: FlowLetter;
  wr?: false;
}

/** The slots and fills the vendored script exports beyond what path/core.ts types. */
interface RecordCore {
  useRecord(table: unknown, flow: FlowLetter, amounts: AmountTable | null): void;
  slotRow(
    name: string,
    path: CorePath,
    flow: FlowLetter,
    step: RowStamps,
  ): { i: number; text: string } | null;
}

/** The flow's main path, which a reader with no path gets (overlay-core.js mainPath: record.main). */
function mainPathOf(view: CompiledRecordView): CorePath {
  const [price = "", before = "", after = ""] = view.record.main[view.flow].split("|");
  return { price, before, after, booking: {} };
}

/**
 * The index of the row of `slot` that fits `path`, or null when none fits (a compiled slot always ends in a row with no
 * `when`, so null does not happen with a compiled record). `path` null is the flow's main path, as for a reader with
 * no path. The row is chosen by the vendored slotRow(), run on this very record.
 *
 * Side effect: the vendored tables are left reading this record (useRecord), as syncFlow() leaves them reading an
 * applied flow. The path functions of compiler/src/path sync them again on every call; so does any caller that mixes.
 */
export function slotRowIndex(
  view: CompiledRecordView,
  slot: SlotName,
  path: TradePath | null,
  stamps: RowStamps = {},
): number | null {
  if (!(SLOT_NAMES as readonly string[]).includes(slot))
    throw new RecordError(`${slot} is not one of the record's 16 slots`);
  if (path !== null && path.flow !== view.flow)
    throw new RecordError(`a flow ${path.flow} path was given to the flow ${view.flow} record`);
  const core = loadPathScripts().core as unknown as RecordCore;
  core.useRecord(view.record, view.flow, view.amounts);
  const row = core.slotRow(slot, path === null ? mainPathOf(view) : toCorePath(path), view.flow, stamps);
  return row === null ? null : row.i;
}
