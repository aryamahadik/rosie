// The sample values of one trade in one flow (T-142; Master Corrections C6).
//
// C6: the flows' `cast` and `names`; each trade's `cast`, `names`, the right side of each `rename`, and `story`; and the
// dates, times and $ amounts in example lines are illustrations, never live values. This file lists the names, places and
// amounts a trade's lines can show as such, from the sources C6 names:
//
//   - the master's fixed cast (SPEC-master section 6: Sam Lee, Pat, Riley and Avery, Jordan and Casey, Alex M., Ben, Dee,
//     Kim, Morgan; Lee's Barbershop, Lee Home Services; 88 Elm St, 1200 Main St, 42 Oak St, Springfield) and each flow's
//     own `names` and `cast`;
//   - the trade's `cast` and `names` for the flow;
//   - the right side of each rename pair whose left side is one of the master's sample names (Riley -> Iris,
//     Lee's Barbershop -> Lee Family Care, 88 Elm St -> 30 Cedar Ave, Springfield -> Millbrook): the trade's own sample.
//
// Not listed: a name that appears only inside a longer rename phrase (an invented customer in a trade's example line,
// such as Lily or Max) and the owner's team examples (Harper, Lin ...): no cast names them, so no rule can say what they
// are. The scan reports them as residue (scan.ts), never as slotted.
import type { AmountTable, FlowLetter, MasterGraphs, MasterRecord } from "../graph/types.ts";
import type { LoadedTrade, TradeId } from "../load/trade";

/** The slots a sample name becomes (K-03 v1: the compiler slots, status proposedCQ17, and alex.staff, name.staff). */
export type NameSlot = "biz.name" | "owner.name" | "pro.name" | "alex.staff" | "name.staff" | "visit.place";

/** One sample name, place or business, and the slot it becomes. */
export interface SampleName {
  text: string;
  slot: NameSlot;
}

/** The amount fields of a flow's amount table (overlay-core.js AMOUNTS), as the slots they fill. */
export type AmountField = "price" | "fee" | "deposit" | "rest" | "paid";

/** What a trade's flow shows as a sample, ready for slotting and scanning. */
export interface SampleTable {
  flow: FlowLetter;
  trade: TradeId | null;
  /** Names, longest first. */
  names: SampleName[];
  /** One pattern over all names: a whole word, longest alternative first. */
  nameRe: RegExp;
  /** The slot of each name, by its text. */
  slotOf: Map<string, NameSlot>;
  /** The towns (a place with no street): an address may end with one (`88 Elm St, Springfield`). */
  towns: string[];
  /** The check-in codes the flows' elements carry (5160, 3906 ...), filled in by the code elements the walk meets. */
  codes: Set<string>;
  /** Each $ amount of the flow's amount table and the record's example services, with the fields that hold it. */
  amounts: Map<string, Set<AmountField>>;
}

/** What the table needs from a flow: the header an applied flow or a master flow both have. */
export interface FlowHeader {
  cast: Record<string, string>;
  names: Record<string, string>;
  amounts: AmountTable;
  record: Pick<MasterRecord, "services">;
}

const MASTER_BUSINESSES: readonly string[] = [
  "Lee's Barbershop LLC",
  "Lee Home Services LLC",
  "Lee Plumbing and Lee Electric",
  "Lee Home Services",
  "Lee's Barbershop",
  "Lee Plumbing",
  "Lee Electric",
];
const MASTER_OWNER: readonly string[] = ["Sam Lee", "Sam"];
const MASTER_PROS: readonly string[] = [
  "Riley Chen",
  "Riley",
  "Avery Diaz",
  "Avery",
  "Jordan Price",
  "Jordan",
  "Casey Moore",
  "Casey",
];
const MASTER_CUSTOMER: readonly string[] = ["Alex M.", "Alex"];
/** Other people of the cast: the office manager and the other customers (SPEC-master section 6). */
const MASTER_OTHERS: readonly string[] = ["Pat", "Ben T.", "Ben", "Dee W.", "Dee", "Kim", "Morgan"];
const MASTER_ADDRESSES: readonly string[] = ["1200 Main St", "88 Elm St", "42 Oak St"];
const MASTER_STREETS: readonly string[] = ["Main St", "Elm St", "Oak St"];
/** Springfield is the cast's town; Riverton is the master's own out-of-area example (B4-31, S12-08). */
const MASTER_TOWNS: readonly string[] = ["Springfield", "Riverton"];

/** A whole-word pattern needs a name to start and end with a letter, digit, or the dot of initials. */
const NAME_OK = /^[A-Z0-9][\p{L}\p{N}'’ .&-]*$/u;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "A.M." for "Alex M.": the form a sensitive trade's lines show (D41). */
function initialsOf(name: string): string | null {
  const parts = name.split(" ");
  if (parts.length !== 2) return null;
  const [first, last] = parts as [string, string];
  if (!/^[A-Z][a-z]+$/.test(first) || !/^[A-Z]\.$/.test(last)) return null;
  return `${first.slice(0, 1)}.${last}`;
}

/** The people a cast line names: `Iris (behavior analyst) and Elise (behavior technician)` gives Iris and Elise. */
export function castPeople(text: string): string[] {
  const people: string[] = [];
  for (const m of text.matchAll(/\((?:[^()]*\s)?(?:of|for|named)\s+([A-Z][a-z]+)\b/g))
    people.push(m[1] ?? "");
  const bare = text.replace(/\([^)]*\)/g, ",");
  for (const part of bare.split(/\s+and\s+|\s*[,·]\s*/)) {
    const name = part.trim();
    if (/^[A-Z][a-z]+(?: [A-Z]\.)?$/.test(name)) people.push(name);
  }
  return people.filter((name) => name !== "");
}

type Adder = (text: string, slot: NameSlot) => void;

interface ExamplePerson {
  full: string;
  first: string | null;
  slot: NameSlot;
}

const EXAMPLE_SLOT = /\{\{\s*(alex|name)\.staff\s*:([^{}|]*)(?:\|[^{}]*)?\}\}/g;
const examplePeople = new WeakMap<MasterGraphs, ExamplePerson[]>();

/**
 * The people the master's own lines name in a `{{name.staff:Sofia G.}}` or `{{alex.staff:Alex M.}}` slot: the master says
 * these are another person's name and the customer's. Read once per master from the steps of both flows.
 */
function slotExamplePeople(master: MasterGraphs): ExamplePerson[] {
  const known = examplePeople.get(master);
  if (known !== undefined) return known;
  const seen = new Map<string, ExamplePerson>();
  for (const letter of ["A", "B"] as const) {
    for (const step of Object.values(master[letter].steps)) {
      const json = JSON.stringify([step.say, step.vary, step.does, step.more, step.title, step.rule]);
      for (const m of json.matchAll(EXAMPLE_SLOT)) {
        const full = (m[2] ?? "").trim();
        if (full === "" || !NAME_OK.test(full) || seen.has(full)) continue;
        const word = /^([A-Z][a-z]{2,})\b/.exec(full)?.[1];
        const slot: NameSlot = m[1] === "alex" ? "alex.staff" : "name.staff";
        seen.set(full, { full, first: word !== undefined && word !== full ? word : null, slot });
      }
    }
  }
  const list = [...seen.values()];
  examplePeople.set(master, list);
  return list;
}

function namesOfHeader(add: Adder, header: Pick<FlowHeader, "cast" | "names">, ownCast: boolean): void {
  for (const [key, value] of Object.entries(header.names)) {
    if (key === "owner") add(value, "owner.name");
    else if (key === "staff" || key === "pro") add(value, "pro.name");
    else if (key === "cust") add(value, "alex.staff");
    else if (key === "biz" || key === "business") add(value, "biz.name");
  }
  if (!ownCast) return;
  for (const [key, value] of Object.entries(header.cast)) {
    if (key === "business") add(value.trim(), "biz.name");
    else if (key === "staff") for (const name of castPeople(value)) add(name, "pro.name");
    else if (key === "cust") {
      const people = castPeople(value);
      for (const name of people) add(name, name.startsWith("Alex") ? "alex.staff" : "name.staff");
    }
  }
}

/** Strips a trailing `'s` or `'` (a possessive): the name is what the slot stands for. */
function bare(text: string): string {
  return text.replace(/['’]s?$/, "");
}

function amountFields(table: AmountTable, record: FlowHeader["record"]): Map<string, Set<AmountField>> {
  const out = new Map<string, Set<AmountField>>();
  const fields: readonly AmountField[] = ["price", "fee", "deposit", "rest", "paid"];
  const put = (row: Record<string, string> | undefined): void => {
    if (row === undefined) return;
    for (const field of fields) {
      const value = row[field];
      if (typeof value !== "string" || !value.startsWith("$")) continue;
      const set = out.get(value) ?? new Set<AmountField>();
      set.add(field);
      out.set(value, set);
    }
  };
  for (const row of Object.values(table)) put(row);
  for (const service of Object.values(record.services)) put(service.amounts);
  return out;
}

/**
 * The sample table of one flow for the master (`trade` null) or one trade. `master` supplies both flows' names (the
 * shared steps name both businesses), `header` the flow as laid out for this trade (applied flow, or master flow).
 */
export function sampleTable(
  master: MasterGraphs,
  flow: FlowLetter,
  trade: LoadedTrade | null,
  header: FlowHeader,
): SampleTable {
  const seen = new Map<string, NameSlot>();
  const add: Adder = (text, slot) => {
    const name = text.trim();
    if (name.length < 2 || name.includes("{{") || !NAME_OK.test(name)) return;
    if (!seen.has(name)) seen.set(name, slot);
  };
  const towns = new Set<string>();
  const masterSlots = new Map<string, NameSlot>();
  const base = (list: readonly string[], slot: NameSlot): void => {
    for (const name of list) {
      add(name, slot);
      masterSlots.set(name, slot);
      const initials = initialsOf(name);
      if (initials !== null) add(initials, slot);
    }
  };
  base(MASTER_BUSINESSES, "biz.name");
  base(MASTER_OWNER, "owner.name");
  base(MASTER_PROS, "pro.name");
  base(MASTER_CUSTOMER, "alex.staff");
  base(MASTER_OTHERS, "name.staff");
  base(MASTER_ADDRESSES, "visit.place");
  base(MASTER_STREETS, "visit.place");
  base(MASTER_TOWNS, "visit.place");
  for (const town of MASTER_TOWNS) towns.add(town);
  for (const letter of ["A", "B"] as const) namesOfHeader(add, master[letter], false);
  // The people the master itself shows as another person's name: {{name.staff:Sofia G.}}, {{name.staff:Tessa}}.
  for (const person of slotExamplePeople(master)) {
    base([person.full], person.slot);
    if (person.first !== null) base([person.first], person.slot);
  }
  namesOfHeader(add, header, trade !== null);

  if (trade !== null) {
    const own = trade.flows[flow];
    if (own.names !== null) namesOfHeader(add, { cast: {}, names: own.names }, false);
    const masterRe = new RegExp(
      `(?<![\\p{L}\\p{N}])(?:${[...masterSlots.keys()]
        .sort((a, b) => b.length - a.length)
        .map(escape)
        .join("|")})(?![\\p{L}\\p{N}])`,
      "gu",
    );
    for (const [left, right] of own.rename) {
      const slot = masterSlots.get(bare(left.trim()));
      let sample: string | null = null;
      let sampleSlot: NameSlot = "name.staff";
      if (slot !== undefined) {
        sample = bare(right.trim());
        sampleSlot = slot;
      } else {
        // A phrase pair that changes one sample name: "I'm in Springfield." -> "I'm in Riverton." gives Riverton.
        const hits = [...left.matchAll(masterRe)];
        const hit = hits.length === 1 ? hits[0] : undefined;
        const found = hit === undefined ? undefined : masterSlots.get(hit[0]);
        if (hit !== undefined && found !== undefined) {
          const prefix = left.slice(0, hit.index);
          const suffix = left.slice(hit.index + hit[0].length);
          if (
            right.startsWith(prefix) &&
            right.endsWith(suffix) &&
            right.length > prefix.length + suffix.length
          ) {
            sample = bare(right.slice(prefix.length, right.length - suffix.length).trim());
            sampleSlot = found;
          }
        }
      }
      if (
        sample === null ||
        !/^[A-Z0-9]/.test(sample) ||
        sample.split(" ").length > 4 ||
        /[!?:;,{}]/.test(sample)
      )
        continue;
      add(sample, sampleSlot);
      if (sampleSlot === "visit.place") {
        if (/^\d/.test(sample)) {
          const street = sample.replace(/^\d+\s+/, "");
          add(street, "visit.place");
        } else if (!/\s(?:St|Ave|Ln|Rd|Blvd|Dr|Way|Ct|Street)$/.test(sample)) towns.add(sample);
      }
    }
  }

  const names = [...seen.entries()]
    .map(([text, slot]): SampleName => ({ text, slot }))
    .sort((a, b) => b.text.length - a.text.length || a.text.localeCompare(b.text));
  const alternatives = names.map((name) => escape(name.text)).join("|");
  const nameRe = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "gu");
  return {
    flow,
    trade: trade?.id ?? null,
    names,
    nameRe,
    slotOf: new Map(names.map((name) => [name.text, name.slot])),
    towns: [...towns].sort((a, b) => b.length - a.length),
    codes: new Set<string>(),
    amounts: amountFields(header.amounts, header.record),
  };
}
