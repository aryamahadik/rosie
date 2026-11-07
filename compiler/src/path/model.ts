// The path model (T-136; K-01 v1 'path': { flow, price, before, after, booking, switches, facts, services, fixture }).
//
// A path is one way a booking can go: a money path (price|before|after), the booking values, the plug-in switches the
// trade has on, the plug-in facts it lists, and the record fixture or extra services it rides. For each trade this file
// gives the paths that are real for it:
//
//   - only the money paths the trade lists (money.<flow>.combos): a trade never gets a path it does not list, so
//     makeTradePath() refuses the others (cpa on list|card|counter);
//   - the trade's own switches (pf.switches, no2 derived as the master derives it) and its full list of facts, the
//     header-only ones included (documents, banktransfer ...): the path object is built directly, so lib.js
//     parsePath's `facts=` check, which refuses those 11 facts, never runs (specs.md 4.3, Q-35);
//   - each booking value alone, as check-prof walks them (every mix is for the checkers, not for the bundle);
//   - the record's fixtures (two-card, switched, ...) on every money path they ride.
//
// The set is made by the master's own pathsFor() (lib.js), run with the trade's switches and facts fixed, so nothing
// here re-states which paths exist. Words and lighting for a path are in words.ts.
import type { AfterChoice, BeforeChoice, FlowLetter, PriceChoice } from "../graph/types.ts";
import type { AppliedFlow, AppliedStep, AppliedTrade } from "../overlay/apply";
import type { LoadedTrade, TradeId } from "../load/trade";
import { loadPathScripts, type CorePath, type PathCore } from "./core";

/** Where a path comes from: the trade's money path, one booking value laid on it, or a record fixture riding it. */
export type PathKind = "money" | "booking" | "fixture";

/**
 * One path of one trade in one flow: the K-01 fields (flow, price, before, after, booking, switches, facts, services,
 * fixture) and, beside them, what the vendored functions need to read it back exactly.
 */
export interface TradePath {
  flow: FlowLetter;
  price: PriceChoice;
  before: BeforeChoice;
  after: AfterChoice;
  /** Booking values by group; a group left out has its first value. */
  booking?: Record<string, string>;
  /** The switches that are ON for this path, by name (a switch left out is off). */
  switches: Record<string, boolean>;
  /** The facts the trade lists (header-only ones included), or null when it lists none: then every fact-gated branch shows. */
  facts: string[] | null;
  /** Record service ids the booking adds to its own (a fixture's), when it has more than one service. */
  services?: string[];
  /** The record fixture the path rides, such as two-card. */
  fixture?: string;
  /** Not in K-01: how the path was made. */
  kind: PathKind;
  /**
   * Not in K-01: the fields the vendored functions add to a fixture's or a branch's path (`svc`, `fix`, `base`,
   * `setBy`, `pin`, `evSet`, `allFacts`), kept whole so the path reads back exactly. Present on fixture paths and on
   * paths read after a branch's `sets`.
   */
  engine?: Record<string, unknown>;
}

/** A path the model refuses to make. */
export class PathError extends Error {
  override name = "PathError";
}

/** A money path the trade does not list in money.<flow>.combos. */
export class UnlistedMoneyPathError extends PathError {
  override name = "UnlistedMoneyPathError";
  readonly trade: TradeId;
  readonly flow: FlowLetter;
  readonly money: string;

  constructor(trade: TradeId, flow: FlowLetter, money: string, listed: readonly string[]) {
    super(`${trade} flow ${flow}: ${money} is not one of its money paths (it lists ${listed.join(", ")})`);
    this.trade = trade;
    this.flow = flow;
    this.money = money;
  }
}

/** A path text that is not price|before|after, or is not a money path of the flow (lib.js validCombo). */
export class InvalidMoneyPathError extends PathError {
  override name = "InvalidMoneyPathError";
}

/** A booking value that is not a value of its group, or a group the master does not have. */
export class InvalidBookingError extends PathError {
  override name = "InvalidBookingError";
}

/** A fixture the record does not have, or one that does not ride the money path asked for. */
export class FixtureError extends PathError {
  override name = "FixtureError";
}

type Obj = Record<string, unknown>;

/** Fields of the vendored path that the K-01 fields cover; everything else rides in `engine`. */
const K01_FIELDS: ReadonlySet<string> = new Set(["price", "before", "after", "booking", "pf", "facts"]);

/** Makes the vendored tables read this applied flow (its money ways, D75 mark and record). Call before any lit/resolveVary. */
export function syncFlow(flow: AppliedFlow): void {
  loadPathScripts().core.syncWays(flow);
}

/**
 * The trade as overlay-core.js reads a trade file, for its three readers of the plug-in: switchesOf, factsOf and
 * bookingOf read `plugin`, `money.<flow>.booking` and the flow's ops (the $2 split gives no2). Nothing is changed.
 */
function overlayView(trade: LoadedTrade, flow: FlowLetter): Obj {
  const plugin: Obj = {};
  if (trade.facts !== null) plugin["pf.facts"] = trade.facts;
  if (trade.switches !== null) plugin["pf.switches"] = trade.switches;
  const part = trade.flows[flow];
  return {
    id: trade.id,
    plugin,
    money: { [flow]: { booking: part.money.booking } },
    [flow]: { ops: part.ops },
  };
}

/** The switches the trade has on in this flow (overlay-core.js switchesOf: true or { A, B }; no2 follows the $2 split). */
export function tradeSwitches(trade: LoadedTrade, flow: FlowLetter): Record<string, boolean> {
  return { ...loadPathScripts().core.switchesOf(overlayView(trade, flow), flow) };
}

/** The facts the trade lists, header-only ones included, or null when it lists none (insurance.json: C5 fills it, T-139). */
export function tradeFacts(trade: LoadedTrade): string[] | null {
  return trade.facts === null ? null : [...trade.facts];
}

/** The money paths the trade lists for a flow, in the file's order (money.<flow>.combos). */
export function listedMoneyPaths(trade: LoadedTrade, flow: FlowLetter): string[] {
  return [...trade.flows[flow].money.combos];
}

/**
 * The distinct (flow, money path) pairs the trades list: 23 in flow A and 23 in flow B across the 243 trade files, 46
 * in all (specs.md section 2: "46 distinct combos in use"). Each is `A list|card|counter`.
 */
export function distinctMoneyPaths(trades: Iterable<LoadedTrade>): string[] {
  const seen = new Set<string>();
  for (const trade of trades) {
    for (const flow of ["A", "B"] as const) {
      for (const combo of trade.flows[flow].money.combos) seen.add(`${flow} ${combo}`);
    }
  }
  return [...seen].sort();
}

function moneyParts(money: string): { price: PriceChoice; before: BeforeChoice; after: AfterChoice } {
  const parts = money.split("|");
  if (parts.length !== 3) throw new InvalidMoneyPathError(`${money} is not price|before|after`);
  return { price: parts[0] as PriceChoice, before: parts[1] as BeforeChoice, after: parts[2] as AfterChoice };
}

/** A path in the vendored shape, from a TradePath. The K-01 fields win over `engine`, so an edited path reads as edited. */
export function toCorePath(path: TradePath): CorePath {
  const out: CorePath = { price: path.price, before: path.before, after: path.after };
  Object.assign(out, structuredClone(path.engine ?? {}));
  out.price = path.price;
  out.before = path.before;
  out.after = path.after;
  if (path.booking !== undefined) out.booking = { ...path.booking };
  else delete out.booking;
  out.pf = { ...path.switches };
  out.facts = path.facts === null ? null : [...path.facts];
  return out;
}

/** A TradePath from a vendored path (a copy: nothing is shared with it). */
export function fromCorePath(core: CorePath, flow: FlowLetter, kind: PathKind): TradePath {
  const extra: Obj = {};
  for (const [key, value] of Object.entries(core)) {
    if (!K01_FIELDS.has(key)) extra[key] = structuredClone(value);
  }
  const switches: Record<string, boolean> = {};
  for (const [name, on] of Object.entries(core.pf ?? {})) if (on) switches[name] = true;
  const path: TradePath = {
    flow,
    price: core.price as PriceChoice,
    before: core.before as BeforeChoice,
    after: core.after as AfterChoice,
    switches,
    facts: core.facts ? [...core.facts] : null,
    kind,
  };
  if (core.booking !== undefined && Object.keys(core.booking).length > 0) path.booking = { ...core.booking };
  if (typeof core.fix === "string") path.fixture = core.fix;
  if (Array.isArray(core.svc)) {
    const ids = (core.svc as { id?: unknown }[])
      .map((service) => service.id)
      .filter((id): id is string => typeof id === "string" && id !== "own");
    if (ids.length > 0) path.services = ids;
  }
  if (Object.keys(extra).length > 0) path.engine = extra;
  return path;
}

/** The text of a path as the master names it in its messages: `list|deposit|counter +two-card with booking later` (lib.js pathName). */
export function pathName(path: TradePath): string {
  return loadPathScripts().lib.pathName(toCorePath(path));
}

/** The steps a trade shows: the ones an `off` op did not switch off, branches included (check-prof's live()). */
function liveSteps(steps: AppliedStep[]): AppliedStep[] {
  return steps
    .filter((step) => step.off === undefined)
    .map((step) => {
      if (step.branches === undefined) return step;
      return {
        ...step,
        branches: step.branches
          .filter((branch) => branch.off === undefined)
          .map((branch) => ({ ...branch, steps: liveSteps(branch.steps) })),
      };
    });
}

function checkApplied(applied: AppliedTrade, trade: LoadedTrade): FlowLetter {
  if (applied.trade !== trade.id)
    throw new PathError(`the applied flow is ${applied.trade}'s, but the trade given is ${trade.id}`);
  return applied.flow.id;
}

/** The trade's base path for one money path: its switches and facts, the booking at its defaults. */
function basePath(trade: LoadedTrade, flow: FlowLetter, money: string): CorePath {
  const { price, before, after } = moneyParts(money);
  return { price, before, after, pf: tradeSwitches(trade, flow), facts: tradeFacts(trade) };
}

/**
 * The paths a trade really has in one flow: each money path it lists with its own switches and facts, each booking
 * value it uses laid on alone, and the record fixtures that ride each money path (the master's pathsFor with the
 * trade's switches and facts fixed). `applied` is applyTrade() of this trade for the flow. Options leave a kind out:
 * `{ fixtures: false }` or `{ booking: false }`.
 */
export function tradePaths(
  applied: AppliedTrade,
  trade: LoadedTrade,
  options: { fixtures?: boolean; booking?: boolean } = {},
): TradePath[] {
  const flow = checkApplied(applied, trade);
  const { core, lib } = loadPathScripts();
  core.syncWays(applied.flow);
  const listed = listedMoneyPaths(trade, flow);
  for (const money of listed) {
    if (!lib.validCombo(flow, moneyParts(money)))
      throw new InvalidMoneyPathError(`${trade.id} flow ${flow}: ${money} is not a money path of the flow`);
  }
  const allowed = core.bookingOf(overlayView(trade, flow), flow, applied.flow);
  const raw = lib.pathsFor(
    listed.map((money) => basePath(trade, flow, money)),
    liveSteps(applied.flow.steps),
    allowed,
    true,
    { mix: false, fl: flow, record: options.fixtures !== false },
  );
  // pathsFor() leaves out a fixture that names a value its walk does not offer. With a record loaded, `privacy:
  // private` is a value only a branch's `sets` reaches, so the fixture private-call (calls only and private) is left
  // out of every trade's walk although the record has it and parsePath accepts it. The record's 11 fixtures are the
  // card's, so each such fixture is put back, riding the same money paths: the trade's own booking limits still apply.
  const record = core.record(flow);
  if (options.fixtures !== false && record?.fixtures !== undefined) {
    const reachable = reachableBooking(core, record.fixtures, allowed);
    const have = new Set(raw.map((path) => lib.pathName(path)));
    const seenBase = new Set<string>();
    for (const base of raw.filter((path) => typeof path.fix !== "string")) {
      const key = `${base.price}|${base.before}|${base.after}`;
      if (seenBase.has(key)) continue;
      seenBase.add(key);
      for (const added of lib.fixturePaths(base, flow, record.fixtures, reachable)) {
        const name = lib.pathName(added);
        if (have.has(name)) continue;
        have.add(name);
        raw.push(added);
      }
    }
  }

  const out: TradePath[] = [];
  const seenMoney = new Set<string>();
  for (const vendored of raw) {
    const money = `${vendored.price}|${vendored.before}|${vendored.after}`;
    let kind: PathKind;
    if (typeof vendored.fix === "string") kind = "fixture";
    else if (seenMoney.has(money)) kind = "booking";
    else {
      seenMoney.add(money);
      kind = "money";
    }
    if (kind === "booking" && options.booking === false) continue;
    out.push(fromCorePath(vendored, flow, kind));
  }
  return out;
}

/**
 * The booking values a fixture may name, for the trade: what its walk offers, plus any value only a branch's `sets`
 * reaches (with a record loaded, `privacy: private`). The trade's own limits on every other value stay.
 */
function reachableBooking(
  core: PathCore,
  fixtures: readonly { booking?: Record<string, string> }[],
  allowed: Record<string, string[]>,
): Record<string, string[]> {
  const reachable: Record<string, string[]> = { ...allowed };
  for (const fixture of fixtures) {
    for (const [group, value] of Object.entries(fixture.booking ?? {})) {
      const walked = reachable[group];
      if (core.setsOnly(value) && walked !== undefined && !walked.includes(value))
        reachable[group] = [...walked, value];
    }
  }
  return reachable;
}

/**
 * One path of a trade, built directly. `money` must be one of the money paths the trade lists for the flow
 * (UnlistedMoneyPathError otherwise). `booking` lays booking values on it; `fixture` makes it ride a record fixture.
 * The trade's own switches and full facts are put on, so no `facts=` check can refuse a header-only fact.
 */
export function makeTradePath(
  applied: AppliedTrade,
  trade: LoadedTrade,
  spec: { money: string; booking?: Record<string, string>; fixture?: string },
): TradePath {
  const flow = checkApplied(applied, trade);
  const { core, lib } = loadPathScripts();
  core.syncWays(applied.flow);
  const listed = listedMoneyPaths(trade, flow);
  if (!listed.includes(spec.money)) throw new UnlistedMoneyPathError(trade.id, flow, spec.money, listed);
  if (!lib.validCombo(flow, moneyParts(spec.money)))
    throw new InvalidMoneyPathError(
      `${trade.id} flow ${flow}: ${spec.money} is not a money path of the flow`,
    );

  for (const [group, value] of Object.entries(spec.booking ?? {})) {
    if (!(group in core.BOOKING)) throw new InvalidBookingError(`no booking group '${group}'`);
    if (core.GROUP_OF[value] !== group)
      throw new InvalidBookingError(`booking ${group}:${value}: '${value}' is not a value of ${group}`);
  }

  // The trade's own money path as its walk starts it: a group the trade does not use with its first value starts at
  // the first it does use (lib.js pathsFor 'firstOf'), so flow B's paths start at setstart for a set-start trade.
  const walked = tradePaths(applied, trade, { fixtures: false, booking: false }).find(
    (path) => `${path.price}|${path.before}|${path.after}` === spec.money,
  );
  if (walked === undefined)
    throw new InvalidMoneyPathError(`${trade.id} flow ${flow}: ${spec.money} is not walked`);
  const base = toCorePath(walked);
  if (spec.booking !== undefined && Object.keys(spec.booking).length > 0)
    base.booking = { ...base.booking, ...spec.booking };

  if (spec.fixture === undefined)
    return fromCorePath(base, flow, spec.booking === undefined ? "money" : "booking");

  const fixtures = core.record(flow)?.fixtures ?? [];
  const fixture = fixtures.find((candidate) => candidate.id === spec.fixture);
  if (fixture === undefined)
    throw new FixtureError(
      `${trade.id} flow ${flow}: no fixture '${spec.fixture}' (fixtures: ${fixtures.map((x) => x.id).join(", ")})`,
    );
  const allowed = reachableBooking(
    core,
    fixtures,
    core.bookingOf(overlayView(trade, flow), flow, applied.flow),
  );
  const made = lib.fixturePaths(base, flow, [fixture], allowed)[0];
  if (made === undefined)
    throw new FixtureError(
      `${trade.id} flow ${flow}: the fixture '${spec.fixture}' does not ride ${spec.money}`,
    );
  return fromCorePath(made, flow, "fixture");
}

/** A step of the applied flow by id, branch steps included (the first one found in page order). */
export function stepOf(applied: AppliedFlow, id: string): AppliedStep | undefined {
  const find = (steps: AppliedStep[]): AppliedStep | undefined => {
    for (const step of steps) {
      if (step.id === id) return step;
      for (const branch of step.branches ?? []) {
        const hit = find(branch.steps);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };
  return find(applied.steps);
}
