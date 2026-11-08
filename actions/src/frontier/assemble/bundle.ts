// The bundle as the frontier reads it (T-291; K-01 v1, contracts/bundle): steps, branches, cards and the always-on
// prefix's hash, narrowed from the parsed KV values field by field, so a value that is not K-01's shape gives no step
// rather than a wrong one. And each choice's stakes, from the walk K-02 v1's README states (contracts/model, "Stakes").
//
// The frontier never runs a step: it reads the graph to list choices (arch 03 line 151: "code knows the few steps that
// can apply right now"). Never logged: a step's words.

import type {
  AnswerField,
  BundleBranch,
  BundleEffect,
  BundleId,
  BundleStep,
  BundleView,
  Enclosing,
  FlowLetter,
  FlowView,
  FrontierBundles,
  SplitKind,
  StakesReason,
  StepCard,
} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const FLOWS: readonly FlowLetter[] = ["A", "B"];

/** K-01 v1 answerField.type, which K-02 v1 reuses (contracts/bundle answerField). */
const FIELD_TYPES: ReadonlySet<string> = new Set([
  "text",
  "integer",
  "boolean",
  "money",
  "time",
  "zone",
  "id",
  "choice",
]);

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function effectsOf(value: unknown): BundleEffect[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): BundleEffect[] =>
    isRecord(item) && typeof item.kind === "string"
      ? [{ kind: item.kind, ref: nullableString(item.ref) }]
      : [],
  );
}

function answerFieldsOf(value: unknown): AnswerField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AnswerField[] =>
    isRecord(item) &&
    typeof item.name === "string" &&
    item.name !== "" &&
    typeof item.type === "string" &&
    FIELD_TYPES.has(item.type)
      ? [{ name: item.name, type: item.type as AnswerField["type"] }]
      : [],
  );
}

function branchOf(value: unknown): BundleBranch | null {
  if (!isRecord(value) || typeof value.label !== "string" || value.label === "") return null;
  return {
    label: value.label,
    tag: typeof value.tag === "string" ? value.tag : "",
    steps: stringsOf(value.steps),
    end: nullableString(value.end),
    rejoinAt: nullableString(value.rejoinAt),
    answerFields: answerFieldsOf(value.answerFields),
    effects: effectsOf(value.effects),
  };
}

/** The card as K-01 holds it, when it has a question and its means; K-02's checker holds the rest to the contract. */
function cardOf(value: unknown): StepCard["card"] | null {
  if (!isRecord(value) || typeof value.question !== "string" || !Array.isArray(value.means)) return null;
  return value as unknown as StepCard["card"];
}

/** K-01 v1 branch.tag: message, the model may choose it; lookup, code settles it; clock, a clock row settles it. */
const TAGS: ReadonlySet<string> = new Set(["message", "lookup", "clock"]);

/**
 * What a split is to the stakes walk (types.ts SplitKind), from its branches' tags (arch 03 line 161: "only message
 * branches enter the list; code settles lookups and clock rows settle clocks"): asks, when a branch is a message or a
 * clock (the split asks someone or waits: arch 03 line 191); code, when every branch is a lookup. The step's `via` does
 * not decide it: K-01's own auto splits ask (bundle-mini-a's door A3-51 and hub A7-02) as well as settle (A5-04).
 * Unknown, when the walk cannot tell: no branch, a branch it cannot read or whose tag is none of the three, or a message
 * branch on a sync split (system to system: nobody there to ask, so the tags contradict the step). Null: not a split.
 */
function splitOf(
  value: Record<string, unknown>,
  branches: readonly BundleBranch[],
  listed: number,
): SplitKind | null {
  if (value.type !== "split" && listed === 0) return null;
  if (branches.length === 0 || branches.length < listed || branches.some((branch) => !TAGS.has(branch.tag))) {
    return "unknown";
  }
  const message = branches.some((branch) => branch.tag === "message");
  if (message && value.via === "sync") return "unknown";
  return message || branches.some((branch) => branch.tag === "clock") ? "asks" : "code";
}

function stepOf(id: string, value: unknown): BundleStep | null {
  if (!isRecord(value)) return null;
  if (value.id !== undefined && value.id !== id) return null;
  const listed: unknown[] = Array.isArray(value.branches) ? value.branches : [];
  const branches = listed.flatMap((item): BundleBranch[] => {
    const branch = branchOf(item);
    return branch === null ? [] : [branch];
  });
  return {
    id,
    split: splitOf(value, branches, listed.length),
    gives: stringsOf(value.gives),
    next: nullableString(value.next),
    branches,
    effects: effectsOf(value.effects),
    card: cardOf(value.card),
  };
}

/** One flow graph (K-01 v1 flowGraph), when `value` is K-01's graph of `flow`. */
export function flowViewOf(value: unknown, flow: FlowLetter): FlowView | null {
  if (!isRecord(value) || value.contract !== "bundle.v1" || value.flow !== flow) return null;
  const steps = isRecord(value.steps) ? value.steps : {};
  const routing = isRecord(value.routing) ? value.routing : {};
  const alwaysOn = isRecord(routing.alwaysOn) ? routing.alwaysOn : {};
  const sha = alwaysOn.prefixSha256;
  const cache = new Map<string, BundleStep | null>();
  const step = (id: string): BundleStep | null => {
    if (!cache.has(id)) {
      cache.set(id, Object.hasOwn(steps, id) ? stepOf(id, steps[id]) : null);
    }
    return cache.get(id) ?? null;
  };
  // Each listed step's branch, read once on the first ask: every split this graph holds, each branch's own steps.
  let holders: Map<string, Enclosing[]> | undefined;
  const enclosing = (id: string): readonly Enclosing[] => {
    if (holders === undefined) {
      const found = new Map<string, Enclosing[]>();
      for (const key of Object.keys(steps)) {
        const split = step(key);
        if (split === null) continue;
        for (const branch of split.branches) {
          for (const listedId of branch.steps)
            found.set(listedId, [...(found.get(listedId) ?? []), { split, branch }]);
        }
      }
      holders = found;
    }
    return holders.get(id) ?? [];
  };
  return {
    flow,
    alwaysOnSha256: typeof sha === "string" && /^[0-9a-f]{64}$/u.test(sha) ? sha : null,
    routing,
    step,
    enclosing,
  };
}

/** The flows a manifest lists among its stored values (K-01 v1 storage); both when it lists none. */
export function flowsListed(manifest: unknown): FlowLetter[] {
  const storage = isRecord(manifest) && isRecord(manifest.storage) ? manifest.storage : {};
  const values = Array.isArray(storage.values) ? storage.values : [];
  const listed = FLOWS.filter((flow) =>
    values.some((entry) => isRecord(entry) && entry.kind === "flow" && entry.flow === flow),
  );
  return listed.length > 0 ? listed : [...FLOWS];
}

/** A bundle's manifest as the frontier needs it: whether the bundle is partial, and the flows it lists. */
export interface ManifestView {
  readonly partial: boolean;
  readonly flows: FlowLetter[];
}

/** The bundle's manifest, or null when it is in neither KV nor PostgreSQL's copy. */
export async function readManifest(port: FrontierBundles, bundleId: BundleId): Promise<ManifestView | null> {
  const manifest = await port.manifest(bundleId);
  if (!isRecord(manifest)) return null;
  return { partial: manifest.partial === true, flows: flowsListed(manifest) };
}

/** The bundle with the flows asked for read (each it lists); a flow the bundle does not hold is left out. */
export async function readBundle(
  port: FrontierBundles,
  bundleId: BundleId,
  manifest: ManifestView,
  flows: readonly FlowLetter[],
): Promise<BundleView> {
  const wanted = FLOWS.filter((flow) => flows.includes(flow) && manifest.flows.includes(flow));
  const graphs = await Promise.all(wanted.map((flow) => port.flow(bundleId, flow)));
  const read: Partial<Record<FlowLetter, FlowView>> = {};
  wanted.forEach((flow, index) => {
    const view = flowViewOf(graphs[index], flow);
    if (view !== null) read[flow] = view;
  });
  return { bundleId, partial: manifest.partial, flows: read };
}

/** The flow letter a step id carries: A or B, or null for a shared (S) step (K-01 v1 stepId). */
export function flowOfStep(stepId: string): FlowLetter | null {
  if (stepId.startsWith("A")) return "A";
  if (stepId.startsWith("B")) return "B";
  return null;
}

/** A step and the flow graph holding it: its own flow's for an A or B step, the context's flow first for a shared one. */
export function findStep(
  bundle: BundleView,
  stepId: string,
  contextFlow: FlowLetter,
): { flow: FlowView; step: BundleStep } | null {
  const own = flowOfStep(stepId);
  const order: FlowLetter[] = own === null ? [contextFlow, contextFlow === "A" ? "B" : "A"] : [own];
  for (const letter of order) {
    const flow = bundle.flows[letter];
    const step = flow?.step(stepId) ?? null;
    if (flow !== undefined && step !== null) return { flow, step };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Stakes (contracts/model README, "Stakes"; arch 01 line 79)

/** The section 5 money keys (A-keys.md, B-keys.md: the money taken), whose record write makes a choice high. */
const MONEY_KEYS: ReadonlySet<string> = new Set(["money_before", "card_saved", "deposit_paid", "paid_full"]);

/**
 * The most steps one choice's walk follows (each step walked, along every path, and each list climbed out of) before
 * the builder gives up on it (unknown, the safer route).
 */
const MAX_WALK = 64;

function effectReason(effect: BundleEffect, step: string): StakesReason | null {
  if (effect.kind === "charge" || effect.kind === "refund" || effect.kind === "calendarWrite") {
    return { why: effect.kind, step, ref: effect.ref };
  }
  if (effect.kind === "recordWrite" && effect.ref === "booked") return { why: "booked", step, ref: "booked" };
  if (effect.kind === "recordWrite" && effect.ref !== null && MONEY_KEYS.has(effect.ref)) {
    return { why: "money", step, ref: effect.ref };
  }
  return null;
}

/** A step's gives keys as the record writes they are: booked, or a section 5 money key. */
function givesReasons(step: BundleStep): StakesReason[] {
  return step.gives.flatMap((key): StakesReason[] => {
    if (key === "booked") return [{ why: "booked", step: step.id, ref: key }];
    if (MONEY_KEYS.has(key)) return [{ why: "money", step: step.id, ref: key }];
    return [];
  });
}

/** The reasons a list of effects gives, each under the step whose branch or effect it is (K-02 v1 stakesReason.step). */
function effectsReasons(effects: readonly BundleEffect[], step: string): StakesReason[] {
  return effects.flatMap((effect): StakesReason[] => {
    const reason = effectReason(effect, step);
    return reason === null ? [] : [reason];
  });
}

/** A step's own reasons: its effects, then its gives keys. */
function stepReasons(step: BundleStep): StakesReason[] {
  return [...effectsReasons(step.effects, step.id), ...givesReasons(step)];
}

function unique(reasons: readonly StakesReason[]): StakesReason[] {
  const seen = new Set<string>();
  return reasons.filter((reason) => {
    const key = `${reason.why}|${reason.step ?? ""}|${reason.ref ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The builder could not walk (part of) the choice: high, the safer route (contracts/model README, "Stakes"). */
const UNKNOWN: StakesReason = { why: "unknown", step: null, ref: null };

/** A walk's reasons once: each the first time it was met, and unknown last when any path could not be walked. */
function settled(reasons: readonly StakesReason[]): StakesReason[] {
  const known = unique(reasons.filter((reason) => reason.why !== "unknown"));
  return reasons.some((reason) => reason.why === "unknown") ? [...known, { ...UNKNOWN }] : known;
}

/**
 * One choice's walk over one flow graph (ownStakes). Each step is walked once: its reasons are kept, so paths that meet
 * again (every branch of K-01's A5-04 rejoins at A5-31) cost nothing more, and a step met again on its own path is a
 * loop. `start`, the asked step, is on the path from the first.
 */
function stakesWalk(bundle: BundleView, flow: FlowView, start: string) {
  const walked = new Map<string, StakesReason[]>();
  const onPath = new Set<string>([start]);
  let spent = 0;
  /** One more step walked or climbed; false once the walk is longer than the builder follows. */
  const spend = (): boolean => {
    spent += 1;
    return spent <= MAX_WALK;
  };

  /** The reasons from step `id` on, along every path, to where each path stops. */
  function from(id: string): StakesReason[] {
    const known = walked.get(id);
    if (known !== undefined) return known;
    if (onPath.has(id) || !spend()) return [UNKNOWN];
    onPath.add(id);
    const reasons = unique(at(id));
    onPath.delete(id);
    walked.set(id, reasons);
    return reasons;
  }

  function at(id: string): StakesReason[] {
    const step = flow.step(id);
    if (step === null) return bundle.partial ? [] : [UNKNOWN];
    switch (step.split) {
      case "asks":
        return [];
      case "unknown":
        return [UNKNOWN];
      case "code":
        return [...stepReasons(step), ...step.branches.flatMap((branch) => down(step, branch))];
      case null:
        return [...stepReasons(step), ...(step.next === null ? climb(step) : from(step.next))];
    }
  }

  /** One branch taken: its effects, then its own steps (K-01 v1 branch.steps), else straight on to where it goes. */
  function down(split: BundleStep, branch: BundleBranch): StakesReason[] {
    const first = branch.steps[0];
    return [
      ...effectsReasons(branch.effects, split.id),
      ...(first === undefined ? after(split, branch) : from(first)),
    ];
  }

  /**
   * Where a branch goes once its own steps are done: an ending branch ends the path (K-01 v1 branch.end: "this path
   * stops"); a merging one (an end left out merges: K-01 README) rejoins after its split, at its rejoinAt or the split's
   * next, or, when the split is the last step of its own list, where the branch holding the split goes.
   */
  function after(split: BundleStep, branch: BundleBranch): StakesReason[] {
    if (branch.end === "end") return [];
    const rejoin = branch.rejoinAt ?? split.next;
    return rejoin === null ? climb(split) : from(rejoin);
  }

  /**
   * The list holding `step` ends with it (K-01 v1 step.next null: "the enclosing branch's end or rejoinAt decides"). On
   * the main path that ends the journey, as it does where a partial bundle does not hold the split (not reachable). A
   * step listed by two branches, or a list whose steps end before its last one, cannot be walked: unknown.
   */
  function climb(step: BundleStep): StakesReason[] {
    if (!spend()) return [UNKNOWN];
    const holders = flow.enclosing(step.id);
    const holder = holders[0];
    if (holder === undefined) return [];
    const last = holder.branch.steps[holder.branch.steps.length - 1];
    if (holders.length > 1 || last !== step.id) return [UNKNOWN];
    return after(holder.split, holder.branch);
  }

  return { down };
}

/**
 * Why one option of an asked step is high, from its own walk (contracts/model README, "Stakes": "the steps it walks to
 * before it stops at the first step that asks someone, waits or ends the journey", arch 03 line 191; arch 03 line 161:
 * "code settles lookups"): the asked step's gives (written whichever option is picked), the branch's effects, then each
 * step the branch walks to, along every path, until that path stops:
 *   - a plain step is counted (its effects and gives) and the walk goes on to its next;
 *   - a split that asks someone or waits (a message or a clock branch) stops the path, before it;
 *   - a split whose every branch is a lookup asks nobody: code settles it, so it is counted (its gives: A6-10's booked)
 *     and the walk goes down every branch (its effects, its own steps, then where it rejoins), taking the union;
 *   - a split the walk cannot classify (splitOf) is unknown;
 *   - where a list ends, the branch holding it decides where the walk goes (`after`, `climb`).
 * A step a partial bundle does not hold is not reachable (K-01 README, fixtures), so that path stops there; in a full
 * bundle, a missing step, a loop or a walk longer than MAX_WALK steps means the builder cannot walk the choice: unknown,
 * the safer route, listed last. Empty: low (by its own walk).
 *
 * Another option of the same question being high is the assembler's to add, once the choices have their ids.
 */
export function ownStakes(
  bundle: BundleView,
  flow: FlowView,
  step: BundleStep,
  branch: BundleBranch,
): StakesReason[] {
  return settled([...givesReasons(step), ...stakesWalk(bundle, flow, step.id).down(step, branch)]);
}
