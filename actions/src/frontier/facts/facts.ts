// The facts decide is given (T-295; C-075; arch 02 step 4, line 117; arch 03 line 181; K-02 v1 context.facts; K-09 v1
// buildFrontier: "Each fact comes once from its one home (S13-30); a second value for one key is refused, the home's
// value goes in and the step is flagged for a fix").
//
// For the choices the frontier gives decide, after the 60-choice cap:
//   1. The steps whose facts decide reads: the open questions' and hubs' steps (K-02 v1 fact: "One fact the open
//      questions' and hubs' steps need"; arch 03 line 181: full cards for open questions and hubs, "the facts those
//      steps need"), of the choices about the turn's target: the call's business, and the target booking or none.
//      Questions about other bookings add only their options (arch 03 line 159), so their steps bring no fact, and one
//      key never stands for two bookings.
//   2. What each of those steps needs: its K-01 v1 needs that have a home (homes.ts, needs.ts), and each place a fact
//      source says the step reads a key from (S13-30's "a step").
//   3. Each key once, from its one home: the home's row for the turn's target. A place a step reads a key from that is
//      not the key's home gives a second value for that key, refused before it is read (K-05 v1.2 factRef: "that the
//      request names each key once is the frontier's check (a second value for one key is refused there)"), so it never
//      reaches decide: the step gets the home's value, and is flagged for a fix (S13-30: "When a step and a home
//      disagree, the home wins, and the step gets fixed"). A key with no home, or whose home holds no row for the
//      target, is not given: never a value from a place that is not its home.
//   4. One read of every home, strong: the primary, uncached (read.ts).
//   5. Each fact with the row and version it came from (K-02 v1 fact; limit 4 compares them at the commit), and each
//      flagged step with the home's row and version that went in (K-09 v1 FlaggedStep).
// Nothing else reaches decide as a fact: not the frame's facts (the business's name and zone and the people's names
// that T-291 reads for the labels and the writer), no person's name or contact (homes.ts), and no key a step of the
// context's choices does not need. With no home listed (the default, homes.ts), nothing is read and no fact is given.

import type * as K02 from "../../../../contracts/generated/model/model.v1";
import type * as K09 from "../../../../contracts/generated/tool-api/tool-api.v1";
import type {
  BundleId,
  Choice,
  FlowLetter,
  FrontierBundles,
  FrontierRepo,
  ReadTurnStateErrors,
} from "../assemble/types";
import { NO_FACT_HOMES, homeRowId, type FactHome, type FactHomes, type FactTarget } from "./homes";
import { needsReader } from "./needs";
import {
  STRONG_READ,
  turnStateFactsPort,
  type FactRead,
  type FactRef,
  type FactsReadPort,
  type FactsScope,
} from "./read";

/** K-02 v1 fact: one fact a step needs, once, from its one home, with its row and version. */
export type Fact = K02.Fact;
/** K-09 v1 FlaggedStep: a step whose second value for one key was refused, and the home's row that went in. */
export type FlaggedStep = K09.FlaggedStep;

/** A place one step reads one key from, as a fact source gives it (S13-30's "a step"). */
export interface StepRead {
  readonly name: string;
  readonly step: string;
  readonly table: string;
  readonly rowId: string;
  readonly column: string;
}

/** What a fact source sees: the choices whose steps bring facts, and the turn's target. */
export interface FactsView {
  readonly choices: readonly Choice[];
  readonly target: FactTarget;
}

/** A source of the places steps read keys from: a journey's own reads, as its task lands. */
export interface FactSource {
  /** A label. */
  readonly name: string;
  reads(view: FactsView): readonly StepRead[];
}

/** buildFrontier's facts options (handler.ts FrontierOptions.facts). */
export interface FrontierFactsOptions {
  /** Each key's one home. Default: none listed yet (homes.ts NO_FACT_HOMES), so no fact is given. */
  homes?: FactHomes;
  /** Where steps read keys from, beside their K-01 needs. Default: none. */
  sources?: readonly FactSource[];
  /** The read port for the call. Default: K-05 v1.2 readTurnState on the call's repo (read.ts). */
  port?: (repo: FrontierRepo, scope: FactsScope) => FactsReadPort;
}

/** What the facts are found from, for one call. */
export interface FactsInput {
  /** The context's choices, after the cap. */
  readonly choices: readonly Choice[];
  readonly target: FactTarget;
  /** The turn's handle. */
  readonly handleId: string;
  /** The bundle each open question was asked under (K-04 open_questions bundle_hash and bundle_build), by its id. */
  readonly askedUnder: ReadonlyMap<string, BundleId>;
  /** The turn's pinned bundle: a hub's step is read from it. */
  readonly pinned: BundleId;
  /** The context's flow: a shared step is looked for in it first. */
  readonly flow: FlowLetter;
  readonly bundles: FrontierBundles;
  /** The call's repo, scoped to its business. */
  readonly repo: FrontierRepo;
}

/** A builder fault: the frontier named a fact the read refuses, or the read gave what it was not asked. */
export type FactsFault = "unknownFact" | "badState";

/** The facts and the flagged steps, or the read's notFound or transient (buildFrontier's own errors), or a fault. */
export type FactsAnswer =
  | { result: "facts"; facts: Fact[]; flagged: FlaggedStep[] }
  | Exclude<ReadTurnStateErrors, { error: "unknownFact" }>
  | { fault: FactsFault };

/** One key one step needs, and the place it says it reads it from (null: the key's home). */
interface Need {
  name: string;
  step: string;
  place: StepRead | null;
}

/** One key given once: its home, the home's row, the steps that need it, and the steps that named a second place. */
interface Given {
  home: FactHome;
  ref: FactRef;
  forSteps: string[];
  refused: string[];
}

function addOnce(list: string[], item: string): void {
  if (!list.includes(item)) list.push(item);
}

function samePlace(place: StepRead | FactRead, ref: FactRef): boolean {
  return (
    String(place.table) === String(ref.table) && place.rowId === ref.rowId && place.column === ref.column
  );
}

/** A column's value as K-02 v1 types a fact's; undefined for one it cannot carry (K-02's check holds the rest). */
function factValueOf(value: unknown): K02.FactValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value === "object" && !Array.isArray(value)) return value as K02.FactValue;
  return undefined;
}

/** Whether a choice's step brings facts: an option or a hub case, about the turn's target (see above). */
function bringsFacts(choice: Choice, target: FactTarget): boolean {
  if (choice.kind !== "option" && choice.kind !== "hub") return false;
  if (choice.target.businessId !== target.businessId) return false;
  return choice.target.bookingId === null || choice.target.bookingId === target.bookingId;
}

/** The facts the choices need, each once from its home, and the steps flagged for a second value (see above). */
export async function factsFor(input: FactsInput, options: FrontierFactsOptions = {}): Promise<FactsAnswer> {
  const homes = options.homes ?? NO_FACT_HOMES;
  const none: FactsAnswer = { result: "facts", facts: [], flagged: [] };
  if (homes.size === 0) return none;
  const { target } = input;

  // 1. The steps that bring facts.
  const asking = input.choices.filter((choice) => bringsFacts(choice, target));
  if (asking.length === 0) return none;

  // 2. What each needs: its K-01 needs, then the places the sources name.
  const needsOf = needsReader(input.bundles, input.flow);
  const needs: Need[] = [];
  for (const choice of asking) {
    const bundleId =
      choice.kind === "hub"
        ? input.pinned
        : choice.question === null
          ? undefined
          : input.askedUnder.get(choice.question);
    if (bundleId === undefined) continue;
    for (const name of await needsOf(bundleId, choice.step)) {
      needs.push({ name, step: choice.step, place: null });
    }
  }
  const steps = new Set(asking.map((choice) => choice.step));
  const view: FactsView = { choices: asking, target };
  for (const source of options.sources ?? []) {
    for (const place of source.reads(view)) {
      if (steps.has(place.step)) needs.push({ name: place.name, step: place.step, place });
    }
  }

  // 3. Each key once, from its home; a second place is refused before any read.
  const given = new Map<string, Given>();
  for (const need of needs) {
    const home = homes.get(need.name);
    if (home === undefined) continue;
    const rowId = homeRowId(home.row, target);
    if (rowId === null) continue;
    let entry = given.get(need.name);
    if (entry === undefined) {
      const table = home.table as unknown as FactRef["table"];
      entry = { home, ref: { key: home.name, table, rowId, column: home.column }, forSteps: [], refused: [] };
      given.set(need.name, entry);
    }
    addOnce(entry.forSteps, need.step);
    if (need.place !== null && !samePlace(need.place, entry.ref)) addOnce(entry.refused, need.step);
  }
  const entries = [...given.values()];
  if (entries.length === 0) return none;

  // 4. One strong read of every home.
  const port = (options.port ?? turnStateFactsPort)(input.repo, {
    handleId: input.handleId,
    businessId: target.businessId,
  });
  const answer = await port.readFacts(
    entries.map((entry) => entry.ref),
    STRONG_READ,
  );
  if ("error" in answer) return answer.error === "unknownFact" ? { fault: "unknownFact" } : answer;
  if (answer.businessId !== target.businessId) return { fault: "badState" };

  // 5. Each fact with its row and version; each flagged step with the home's row and version that went in.
  const facts: Fact[] = [];
  const flagged: FlaggedStep[] = [];
  for (const entry of entries) {
    const read = answer.facts.find((each) => each.key === entry.ref.key && samePlace(each, entry.ref));
    if (read === undefined) return { fault: "badState" };
    const value = factValueOf(read.value);
    if (value === undefined) return { fault: "unknownFact" };
    const kept = { table: entry.home.table, rowId: entry.ref.rowId, version: read.version };
    facts.push({
      name: entry.home.name,
      value,
      home: entry.home.home,
      table: kept.table,
      rowId: kept.rowId,
      version: kept.version,
      forSteps: [...entry.forSteps],
    });
    for (const step of entry.refused) flagged.push({ stepId: step, key: entry.home.name, kept: { ...kept } });
  }
  return { result: "facts", facts, flagged };
}
