// The home registry (T-586; C-074; S13-30): each step's "follows" home resolves to its home's code, and the home wins
// over the step's own words.
//
// S13-30: "Then each rule has one home ... A step points to a home only by meaning. It never restates it ... The build
// lists what each step follows ... When a step and a home disagree, the home wins, and the step gets fixed." The build's
// list is each compiled step's `reads` (K-01 v1 step `reads`: "the record homes it reads"; step.js prints it as
// "follows: money (S13-55) · contact (S13-19)"). Arch 02 line 117 (step 4, the frontier): each fact once, from its one
// home; "a second value for one key is refused: the home's value goes in and the step is flagged for a fix".
//
// Built once per bundle (createHomeRegistry), from both flow graphs as K-01 v1 writes them. The build fails, naming
// every problem, when:
//   - a flow's record.homes or routing.homes names a home that is not one of the ten, misses one, or the two disagree;
//   - a home has two steps (the flows disagree), two homes share a step, or a home's step is in neither flow;
//   - a step follows a name that is not one of the ten homes (an unknown home fails the build);
//   - a record slot's home is not a home's step;
//   - a module is given for a name that is not a home, two modules for one home, or one point is settled by two homes.
//
// Settling a step (settle): the step's own words reach the registry as claims, a point and a value per home, labels
// only, since the action layer never reads free text (arch 02 line 139). Every home the step follows or a claim names
// must have its module: a home not built yet is no rule, so the step is held and never run on its own words (lead
// note, T-586). Otherwise each home rules on each of its points; where a claim's value differs, the home's value wins
// and the difference is logged with labels and ids only, never words. A claim on a point its home does not settle is
// the step's own ("a rule that names its cases covers only those cases", S13-30).

import { isLabel } from "../../../../runtime/src/trace";
import { HOME_MODULES, HOME_NAMES, isHomeName, type HomeModuleRef, type HomeName } from "./homes";

export type FlowLetter = "A" | "B";

const FLOWS: readonly FlowLetter[] = ["A", "B"];

/** What a step's own words decide on one point of one home: labels only, never words. */
export interface StepClaim {
  readonly home: HomeName;
  readonly point: string;
  readonly value: string;
}

/**
 * A home's code (T-587 to T-596): the points it settles and its rule for each. A rule answers a label for one of its
 * points, read from the context the caller gives (the booking, the person, the record).
 */
export interface HomeModule<Context = unknown> {
  readonly home: HomeName;
  readonly points: readonly string[];
  rule(point: string, context: Context): string;
}

/** One home as the registry holds it: its step in the bundle, its module and whether that module is built. */
export interface HomeEntry extends HomeModuleRef {
  readonly home: HomeName;
  /** The home's step, from both flows' record.homes. */
  readonly step: string;
  readonly built: boolean;
}

/** A step's words that differ from its home: the home's value went in, and the step is flagged for a fix. */
export interface HomeDifference {
  readonly flow: FlowLetter;
  readonly step: string;
  readonly home: HomeName;
  readonly homeStep: string;
  readonly point: string;
  readonly stepSaid: string;
  readonly homeSaid: string;
}

/** A home a step follows whose module is not built: no rule, so the step is held. */
export interface HeldHome {
  readonly home: HomeName;
  readonly homeStep: string;
  readonly module: string;
  readonly task: string;
}

/** The step runs on its homes' rules. */
export interface StepRuns {
  readonly run: true;
  readonly flow: FlowLetter;
  readonly step: string;
  /** Each point of each home involved, as its home rules. */
  readonly rulings: Readonly<Record<string, string>>;
  readonly differences: readonly HomeDifference[];
  /** The claims on points no home involved settles: the step's own. */
  readonly own: readonly StepClaim[];
}

/** The step is held: a home it follows has no rule yet. */
export interface StepHeld {
  readonly run: false;
  readonly flow: FlowLetter;
  readonly step: string;
  readonly held: readonly HeldHome[];
}

export type Settlement = StepRuns | StepHeld;

/** One log line: labels and ids only (K-08 v1 "never the raw number or words"; a value that is not a label never gets here). */
export interface HomeLogLine {
  readonly level: "warn";
  readonly msg: "home_wins" | "home_not_built";
  readonly flow: FlowLetter;
  readonly step: string;
  readonly home: HomeName;
  readonly home_step: string;
  readonly point?: string;
  readonly step_said?: string;
  readonly home_said?: string;
  readonly task?: string;
}

export interface SettleRequest<Context> {
  readonly flow: FlowLetter;
  readonly step: string;
  readonly claims: readonly StepClaim[];
  readonly context: Context;
}

export interface HomeRegistry<Context = unknown> {
  /** The ten homes, in K-01 order. */
  readonly homes: readonly HomeName[];
  /** A home's entry: its step, its one module, and whether it is built. */
  entry(home: HomeName): HomeEntry;
  /** The homes a step follows (its `reads`), in K-01 order. */
  follows(flow: FlowLetter, step: string): readonly HomeName[];
  /** The home of a named record slot (K-01 record.slots.<slot>.home), or undefined for a name that is not a slot. */
  homeOfSlot(flow: FlowLetter, slot: string): HomeName | undefined;
  /** The step's claims settled by its homes: the home wins, or the step is held. */
  settle(request: SettleRequest<Context>): Settlement;
}

export interface HomeRegistryOptions<Context> {
  /** Both flow graphs as K-01 v1 writes them (a bundle's .../flow/A and .../flow/B values). */
  readonly flows: Readonly<Record<FlowLetter, unknown>>;
  /** The homes built so far; every other home is a named entry that fails closed. */
  readonly modules?: readonly HomeModule<Context>[];
  /** Where a log line goes. Default: one JSON line on console.warn. */
  readonly log?: (line: HomeLogLine) => void;
}

/** The registry cannot be built from these flows and modules, or a settle request is not one it can settle. */
export class HomeRegistryError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(problems.length === 0 ? message : `${message}: ${problems.join("; ")}`);
    this.name = "HomeRegistryError";
    this.problems = problems;
  }
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One flow as the registry reads it. */
interface FlowView {
  readonly homes: ReadonlyMap<HomeName, string>;
  readonly follows: ReadonlyMap<string, readonly HomeName[]>;
  readonly slotHomes: ReadonlyMap<string, string>;
}

/** A homes table (record.homes or routing.homes): each of the ten once, each a step id, and nothing else. */
function readHomes(value: unknown, at: string, problems: string[]): Map<HomeName, string> {
  const homes = new Map<HomeName, string>();
  if (!isObj(value)) {
    problems.push(`${at} is not a table of the ten homes`);
    return homes;
  }
  for (const [name, step] of Object.entries(value)) {
    if (!isHomeName(name)) {
      problems.push(`${at} names ${JSON.stringify(name)}, which is not one of the ten homes`);
      continue;
    }
    if (!isLabel(step)) {
      problems.push(`${at}.${name} is not a step id`);
      continue;
    }
    homes.set(name, step);
  }
  for (const name of HOME_NAMES)
    if (!(name in value)) problems.push(`${at} has no home ${name}: every flow names all ten`);
  return homes;
}

function readFlow(flow: FlowLetter, value: unknown, problems: string[]): FlowView {
  const at = `flow ${flow}`;
  const empty: FlowView = { homes: new Map(), follows: new Map(), slotHomes: new Map() };
  if (!isObj(value)) {
    problems.push(`${at} is not a flow graph`);
    return empty;
  }
  if (value.flow !== flow) problems.push(`${at} is the graph of flow ${JSON.stringify(value.flow)}`);
  const record = isObj(value.record) ? value.record : {};
  const routing = isObj(value.routing) ? value.routing : {};
  const homes = readHomes(record.homes, `${at} record.homes`, problems);
  const routed = readHomes(routing.homes, `${at} routing.homes`, problems);
  for (const [name, step] of routed)
    if (homes.has(name) && homes.get(name) !== step)
      problems.push(`${at} routing.homes.${name} is ${step}, but record.homes.${name} is not`);

  const follows = new Map<string, readonly HomeName[]>();
  if (!isObj(value.steps)) problems.push(`${at} has no steps`);
  else
    for (const [id, step] of Object.entries(value.steps)) {
      if (!isObj(step) || step.id !== id || !isLabel(id)) {
        problems.push(`${at} step ${JSON.stringify(id)} is not a step with that id`);
        continue;
      }
      const reads: unknown = step.reads ?? [];
      if (!Array.isArray(reads)) {
        problems.push(`${at} step ${id}: what it follows (reads) is not a list`);
        continue;
      }
      const names: readonly unknown[] = reads;
      for (const name of names)
        if (!isHomeName(name))
          problems.push(
            `${at} step ${id} follows ${JSON.stringify(name)}, which is not one of the ten homes`,
          );
      follows.set(
        id,
        HOME_NAMES.filter((name) => names.includes(name)),
      );
    }

  const slotHomes = new Map<string, string>();
  const homeSteps = new Set(homes.values());
  if (isObj(record.slots))
    for (const [slot, raw] of Object.entries(record.slots)) {
      const home = isObj(raw) ? raw.home : undefined;
      if (typeof home !== "string" || !homeSteps.has(home)) {
        problems.push(`${at} record slot ${slot}: its home is not the step of one of the ten homes`);
        continue;
      }
      slotHomes.set(slot, home);
    }
  else problems.push(`${at} record.slots is not a table of named slots`);
  return { homes, follows, slotHomes };
}

function readModules<Context>(
  modules: readonly HomeModule<Context>[],
  problems: string[],
): Map<HomeName, HomeModule<Context>> {
  const byHome = new Map<HomeName, HomeModule<Context>>();
  const pointHome = new Map<string, HomeName>();
  for (const module of modules) {
    const home: unknown = module.home;
    if (!isHomeName(home)) {
      problems.push(`a module is given for ${JSON.stringify(home)}, which is not one of the ten homes`);
      continue;
    }
    if (byHome.has(home)) {
      problems.push(`two modules are given for the ${home} home: each home has exactly one`);
      continue;
    }
    byHome.set(home, module);
    for (const point of module.points) {
      if (!isLabel(point)) {
        problems.push(`the ${home} home settles a point that is not a label`);
        continue;
      }
      const owner = pointHome.get(point);
      if (owner !== undefined) {
        problems.push(
          `the point ${point} is settled by both the ${owner} and the ${home} home: each fact has one home`,
        );
        continue;
      }
      pointHome.set(point, home);
    }
  }
  return byHome;
}

function warnToConsole(line: HomeLogLine): void {
  console.warn(JSON.stringify(line));
}

/** Builds the registry for one bundle; throws HomeRegistryError, naming each problem, when it cannot be built. */
export function createHomeRegistry<Context = unknown>(
  options: HomeRegistryOptions<Context>,
): HomeRegistry<Context> {
  const problems: string[] = [];
  const views: Record<FlowLetter, FlowView> = {
    A: readFlow("A", options.flows.A, problems),
    B: readFlow("B", options.flows.B, problems),
  };
  const modules = readModules(options.modules ?? [], problems);
  const log = options.log ?? warnToConsole;

  // Each home has exactly one step, the same in both flows, a step of one of them, and no two homes share one.
  const homeSteps = new Map<HomeName, string>();
  const homeOfStep = new Map<string, HomeName>();
  for (const name of HOME_NAMES) {
    const a = views.A.homes.get(name);
    const b = views.B.homes.get(name);
    if (a === undefined || b === undefined) continue;
    if (a !== b) {
      problems.push(`the ${name} home has two steps, ${a} in flow A and ${b} in flow B`);
      continue;
    }
    if (!views.A.follows.has(a) && !views.B.follows.has(a))
      problems.push(`the ${name} home's step ${a} is a step of neither flow`);
    const other = homeOfStep.get(a);
    if (other !== undefined) problems.push(`the ${other} and ${name} homes share the step ${a}`);
    homeSteps.set(name, a);
    homeOfStep.set(a, name);
  }
  if (problems.length > 0) throw new HomeRegistryError("the home registry cannot be built", problems);

  const stepOf = (home: HomeName): string => {
    const step = homeSteps.get(home);
    if (step === undefined) throw new HomeRegistryError(`the ${home} home has no step`);
    return step;
  };
  const followsOf = (flow: FlowLetter, step: string): readonly HomeName[] => {
    const follows = views[flow].follows.get(step);
    if (follows === undefined) throw new HomeRegistryError(`${step} is not a step of flow ${flow}`);
    return follows;
  };

  return {
    homes: HOME_NAMES,

    entry(home) {
      if (!isHomeName(home))
        throw new HomeRegistryError(`${JSON.stringify(home)} is not one of the ten homes`);
      return { home, step: stepOf(home), ...HOME_MODULES[home], built: modules.has(home) };
    },

    follows: followsOf,

    homeOfSlot(flow, slot) {
      const step = views[flow].slotHomes.get(slot);
      return step === undefined ? undefined : homeOfStep.get(step);
    },

    settle({ flow, step, claims, context }) {
      if (!FLOWS.includes(flow)) throw new HomeRegistryError(`${JSON.stringify(flow)} is not flow A or B`);
      const follows = followsOf(flow, step);
      const claimed = new Set<string>();
      for (const claim of claims) {
        if (!isHomeName(claim.home)) throw new HomeRegistryError(`a claim of ${step} names no home`);
        if (!isLabel(claim.point) || !isLabel(claim.value))
          throw new HomeRegistryError(
            `a claim of ${step} is not labels: a point and a value are never words`,
          );
        const key = `${claim.home}/${claim.point}`;
        if (claimed.has(key)) throw new HomeRegistryError(`${step} claims ${key} twice: one value per point`);
        claimed.add(key);
      }

      const involved = HOME_NAMES.filter(
        (name) => follows.includes(name) || claims.some((claim) => claim.home === name),
      );
      const built: HomeModule<Context>[] = [];
      const held: HeldHome[] = [];
      for (const home of involved) {
        const module = modules.get(home);
        if (module !== undefined) {
          built.push(module);
          continue;
        }
        const homeStep = stepOf(home);
        const { module: where, task } = HOME_MODULES[home];
        held.push({ home, homeStep, module: where, task });
        log({ level: "warn", msg: "home_not_built", flow, step, home, home_step: homeStep, task });
      }
      if (held.length > 0) return { run: false, flow, step, held };

      const rulings: Record<string, string> = {};
      for (const module of built)
        for (const point of module.points) {
          const said = module.rule(point, context);
          if (!isLabel(said))
            throw new HomeRegistryError(`the ${module.home} home's rule for ${point} is not a label`);
          rulings[point] = said;
        }

      const differences: HomeDifference[] = [];
      const own: StepClaim[] = [];
      for (const claim of claims) {
        const homeSaid = modules.get(claim.home)?.points.includes(claim.point)
          ? rulings[claim.point]
          : undefined;
        if (homeSaid === undefined) {
          own.push(claim);
          continue;
        }
        if (homeSaid === claim.value) continue;
        const difference: HomeDifference = {
          flow,
          step,
          home: claim.home,
          homeStep: stepOf(claim.home),
          point: claim.point,
          stepSaid: claim.value,
          homeSaid,
        };
        differences.push(difference);
        log({
          level: "warn",
          msg: "home_wins",
          flow,
          step,
          home: difference.home,
          home_step: difference.homeStep,
          point: difference.point,
          step_said: difference.stepSaid,
          home_said: difference.homeSaid,
        });
      }
      return { run: true, flow, step, rulings, differences, own };
    },
  };
}
