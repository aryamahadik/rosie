// The typed in-memory master graph: what compiler/src/load/flow.ts returns for one flow (T-132).
//
// Names follow K-01 v1 (contracts/bundle/bundle.v1.schema.json: FlowLetter, StepId, Lane, Via, Gate, Branch, Step,
// Section, MasterMoney, CatalogEntry, LayerLine, AmountTable, FlowGraph). They are written here by hand and not
// imported from contracts/generated, for two reasons. First, K-01's step and flowGraph are the COMPILED shapes: they
// require what the compiler adds later (card, lint, fallbackText, pageTypes, next, routing, ...), which a loaded
// master does not have yet. Second, this file holds types only, so Node (which strips types and cannot resolve the
// extensionless imports the root tsconfig allows) runs flow.ts as it is, from a CLI command.
//
// Field names stay the master's own on a step and a branch (`sec`, `line`, `layerAdd`, `say` as
// [from, to, text, elements?] tuples, nested `branches[].steps`), so the overlay applier (T-135, which wraps
// overlay-core.js) takes the objects as they are. K-01 spells a few of them differently (section, lines,
// layerLines, messages as objects); the compiler maps them when it writes the bundle.
//
// Not carried: `src` and `prop` on a step (Master Corrections R2). Nothing else is dropped.

/** A flow: A, the customer comes to the business; B, the business goes to the customer (SPEC-master 1). */
export type FlowLetter = "A" | "B";

/**
 * A step id: S (shared), A or B, the section 1 to 13, a dash and two or three digits, such as S1-01 or B4-115
 * (K-01 stepId). The loader checks the spelling; the type is the plain string.
 */
export type StepId = string;

/**
 * Who acts or is told (SPEC-master 4 'who / to'; MC R1): owner, san (Rosie), staff, cust (the customer), agent (the
 * customer's own AI), pay (Stripe), out (an outside service), other (anyone else).
 */
export type Lane = "owner" | "san" | "staff" | "cust" | "agent" | "pay" | "out" | "other";

/** How a step happens (SPEC-master 4 'via'; K-01 via). */
export type Via = "chat" | "msg" | "portal" | "page" | "sync" | "auto" | "visit" | "call" | "email";

/** A money path's choices (K-01 price, before, after). */
export type PriceChoice = "list" | "photos" | "visit";
export type BeforeChoice = "none" | "card" | "deposit" | "full";
export type AfterChoice = "none" | "counter" | "bill" | "card" | "own";

/** A switch, fact, slot group or booking value name (K-01 name). */
export type Name = string;

/** A step's or branch's `when`: which paths light it (SPEC-master 5 item 2, 5d, 5e, 5i; K-01 gate). */
export interface Gate {
  price?: PriceChoice[];
  before?: BeforeChoice[];
  after?: AfterChoice[];
  booking?: Name[];
  pf?: Name[];
  factOn?: Name[];
  factOff?: Name[];
  switchOn?: Name[];
  switchOff?: Name[];
  rec?: Name[];
  recOff?: Name[];
  took?: FlowLetter;
  ev?: FlowLetter;
  wr?: false;
}

/** A booking value that changes mid-booking (SPEC-master 5e; K-01 sets). */
export type Sets = Record<string, string>;

/** Two strings: a screen row (label, value) or a swap pair (K-01 pair). */
export type Pair = [string, string];

/** A screen or chat table (K-01 table). */
export interface Table {
  head: string[];
  rows: string[][];
}

/**
 * A message's chat elements (SPEC-master 4; msgtext.js KEYS). The keys the master uses are named; `letters`
 * (msgtext.js) and any other key stay as written.
 */
export interface MessageElements {
  card?: { title?: string; lines?: string[]; button?: string; link?: string };
  buttons?: (string | Pair)[];
  stop?: boolean | "first";
  as?: string;
  list?: { head?: string[]; rows: string[][]; plain?: boolean; pick?: unknown; numbers?: unknown };
  times?: string[];
  photos?: string[];
  photoLink?: unknown;
  form?: string[];
  code?: string;
  pay?: { amount?: string; what?: string; link?: string };
  stars?: boolean;
  lang?: string;
  en?: string;
  [key: string]: unknown;
}

/** One message line as the master writes it: [from, to, text] or [from, to, text, elements] (SPEC-master 4 'say'). */
export type Message = [from: Lane, to: Lane, text: string, elements?: MessageElements];

/** Other words for some paths: one `vary` entry (SPEC-master 5 item 1, 5f; K-01 wordsPatch). */
export interface WordsPatch {
  does?: string;
  more?: string[];
  say?: Message[];
  rule?: string;
  t?: string;
  form?: Pair[];
  table?: Table;
  swap?: Pair[];
  addMore?: string[];
  addSay?: Message[];
}

/** Amount rows by path pattern (`*`, `list|card|counter`, `list|*|*`, ...); the values are illustrations (MC C6). */
export type AmountTable = Record<string, Record<string, string>>;

/** The plug-in slot node, S1-11 only (SPEC-master 8; K-01 pluginSlot). */
export interface PluginSlot {
  fills: string;
  reads: string[];
  gives: string[];
  examples?: unknown;
}

/** One branch of a split (SPEC-master 4), as the master writes it, with its steps nested as step objects. */
export interface Branch {
  /** The label, word for word: overlays match it exactly. */
  label: string;
  /** The branch's own steps, in order. Each is a node of the flow's `steps` index. */
  steps: Step[];
  /** merge: rejoins after the split; end: stops. Absent where the master leaves it out (the walker reads merge). */
  end?: "merge" | "end";
  endText?: string;
  when?: Gate;
  sets?: Sets;
  /** An ending branch that continues in the other flow (3 in flow A). */
  flow?: FlowLetter;
}

/**
 * One step as the master writes it, minus the authoring fields (`src`, `prop`: MC R2), plus `section`.
 * `who`, `to` and `tells` hold lane keys; read them with `laneMeaning` (MC R1).
 */
export interface Step {
  id: StepId;
  /** The step's section, 1 to 13. The master writes `sec` on top-level steps only; the loader derives this one for
   * every step from the id and checks it against the enclosing top-level step. */
  section: number;
  /** The master's own `sec`, on top-level steps. */
  sec?: number;
  /** The section's title, on the first step of a section (becomes `Section.title`). */
  phase?: string;
  /** The LINES.md lines it covers. */
  line: string[];
  /** `split` for a decision. Twelve steps of flow B carry `step`, as the master writes them. */
  type?: "split" | "step";
  /** `rule`: a section 13 node, a rule every step follows. */
  kind?: "rule";
  who: Lane;
  to?: Lane;
  as?: string;
  via: Via;
  t?: string;
  title: string;
  q?: string;
  does: string;
  more?: string[];
  say?: Message[];
  rule?: string;
  form?: Pair[];
  table?: Table;
  needs?: string[];
  gives?: string[];
  tells?: Lane[];
  reads?: string[];
  when?: Gate;
  vary?: Record<string, WordsPatch>;
  slot?: PluginSlot;
  text?: string;
  visit?: string;
  took?: FlowLetter | false;
  ev?: FlowLetter;
  rec?: FlowLetter;
  wr?: false;
  timing?: FlowLetter | false;
  amounts?: AmountTable;
  /** The flow's layer lines stamped on this step, each a copy of one of the flow's `layerLines` (the master writes
   * the whole line here; K-01 spells it `layerLines` and keeps the ids). */
  layerAdd?: LayerLine[];
  branches?: Branch[];
}

/** One of the 13 sections with its main path (K-01 section). */
export interface Section {
  n: number;
  title: string;
  /** The main-path steps of the section in order; branch steps are not listed. */
  steps: StepId[];
}

/** A money choice with its label (K-01 dimChoices). */
export interface DimChoice {
  k: Name;
  label: string;
}

/** A flow's money block (K-01 masterMoney; SPEC-master 5 and its D66 amendments). */
export interface MasterMoney {
  dims: { price: DimChoice[]; before: DimChoice[]; after: DimChoice[] };
  after: AfterChoice[];
  /** The flow's valid money paths, `price|before|after` (28 per flow). */
  combos: string[];
  examples: Record<string, string>;
  ways: { before: BeforeChoice[]; restLater: boolean };
}

/** A switch or fact with its label and meaning (K-01 catalogEntry). */
export interface CatalogEntry {
  label: string;
  means: string;
}

/** A layer line added to Rosie's messages to the people named (K-01 layerLine). */
export interface LayerLine {
  id: string;
  when: Gate;
  to?: Lane[];
  line: string;
  way?: Record<string, string>;
  sections?: number[];
  more?: boolean;
}

/** A line of LINES.md that the flow leaves out, with the reason (master 'notIn'). */
export interface NotInEntry {
  line: string;
  why: string;
  part?: string;
}

/** A row of a record slot: the first row whose `when` fits wins (master-A.json record.slots). */
export interface RecordSlotRow {
  when: Gate;
  text: string;
}

/** A named record slot (the 16: pay.asks ... who.ok). */
export interface RecordSlot {
  home: StepId;
  means: string;
  rows: RecordSlotRow[];
}

/** An example service the record's fixtures add to a booking (K-01 service). */
export interface RecordService {
  flow: FlowLetter;
  name: string;
  price: PriceChoice;
  before: BeforeChoice;
  after: AfterChoice;
  amounts: Record<string, string>;
}

/** A record fixture (master-A.json record.fixtures: two-card, switched, stopped, ...). */
export interface RecordFixture {
  id: string;
  label: string;
  add?: string[];
  on?: string;
  facts?: Name[];
  booking?: Record<string, string>;
}

/** The record's own lint tables (master-A.json record.lint): kept whole for the lint (C-065 to C-070). */
export interface RecordLint {
  phrases: Record<string, string[]>;
  [key: string]: unknown;
}

/** The booking record (master-A.json `record`; overlay-core.js recordOf / fillRecord). */
export interface MasterRecord {
  _about?: string;
  /** Where the event groups charge and contact are read from, by flow. */
  from: Record<FlowLetter, StepId>;
  /** The main money path by flow. */
  main: Record<FlowLetter, string>;
  ways: Record<string, Record<string, string | boolean>>;
  /** The record homes: money, contact, proof, stop, clock, who, safety, change, record, two. */
  homes: Record<string, StepId>;
  slots: Record<string, RecordSlot>;
  services: Record<string, RecordService>;
  fixtures: RecordFixture[];
  lint: RecordLint;
  onefee: boolean;
  live: {
    switches: Name[];
    facts: Name[];
    off: Record<string, Name[]>;
    merged: Record<string, Record<string, string>>;
  };
  ledger_rules: string;
}

/**
 * One flow's master graph as loaded from master-A.json or master-B.json (T-132). The compiled K-01 flowGraph is made
 * from this later; this one holds the master's own fields and nothing the compiler adds.
 */
export interface FlowGraph {
  flow: FlowLetter;
  /** The flow's own header: its title, short name, and the sample story, cast and names (illustrations, MC C6). */
  title: string;
  short: string;
  story: string;
  intro: string;
  cast: Record<string, string>;
  names: Record<string, string>;
  /** The master's lane list (R1 reads: `san` is Rosie, `agent` is the customer's own AI). */
  lanes: Lane[];
  amounts: AmountTable;
  /** The main path in the master's order, with branch steps nested inside `branches[].steps`. */
  path: Step[];
  /** Every step of the flow, branch steps included, by id. One node per id: the same objects as in `path`. */
  steps: Record<StepId, Step>;
  /** The 13 sections in order with their main-path step ids. */
  sections: Section[];
  notIn: NotInEntry[];
  money: MasterMoney;
  /** `true`: no not-safe mode (SPEC-master FIX7 amendments). */
  d75: boolean;
  switches: Record<Name, CatalogEntry>;
  facts: Record<Name, CatalogEntry>;
  record: MasterRecord;
  /** The money step from which what the booking took is read (the master's 'took': A5-04 in flow A, B5-02 in B). */
  tookAt: StepId;
  layerLines: LayerLine[];
}

/** Both flows, with the S-steps they share. */
export interface MasterGraphs {
  A: FlowGraph;
  B: FlowGraph;
  /** The ids of the S-steps present in both flows, sorted. Each is one node in each flow's `steps`. */
  sharedIds: StepId[];
}
