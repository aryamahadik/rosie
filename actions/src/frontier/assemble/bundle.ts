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
  FlowLetter,
  FlowView,
  FrontierBundles,
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

function stepOf(id: string, value: unknown): BundleStep | null {
  if (!isRecord(value)) return null;
  if (value.id !== undefined && value.id !== id) return null;
  const branches = Array.isArray(value.branches)
    ? value.branches.flatMap((item): BundleBranch[] => {
        const branch = branchOf(item);
        return branch === null ? [] : [branch];
      })
    : [];
  return {
    id,
    asks: value.type === "split" || branches.length > 0,
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
  return {
    flow,
    alwaysOnSha256: typeof sha === "string" && /^[0-9a-f]{64}$/u.test(sha) ? sha : null,
    routing,
    step(id) {
      if (!cache.has(id)) {
        cache.set(id, Object.hasOwn(steps, id) ? stepOf(id, steps[id]) : null);
      }
      return cache.get(id) ?? null;
    },
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

/** The most steps one choice's walk follows before the builder gives up on it (unknown, the safer route). */
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

function stepReasons(step: BundleStep, effects: readonly BundleEffect[]): StakesReason[] {
  const reasons = effects.flatMap((effect): StakesReason[] => {
    const reason = effectReason(effect, step.id);
    return reason === null ? [] : [reason];
  });
  return [...reasons, ...givesReasons(step)];
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

/**
 * Why one option of an asked step is high, from its own walk (contracts/model README, "Stakes"): the asked step's gives
 * (written whichever option is picked), the branch's effects, then each step the branch walks to (its own steps, then,
 * unless it ends the journey, the path it rejoins: K-01 README, "A branch with no end merges"), until the first step
 * that asks someone or the end of the path (arch 03 line 191). A step a partial bundle does not hold is not reachable
 * (K-01 README, fixtures), so the walk stops there; in a full bundle, a missing step, a loop or a walk too long to
 * follow means the builder cannot walk the choice: unknown, the safer route. Empty: low (by its own walk).
 *
 * Another option of the same question being high is the assembler's to add, once the choices have their ids.
 */
export function ownStakes(
  bundle: BundleView,
  flow: FlowView,
  step: BundleStep,
  branch: BundleBranch,
): StakesReason[] {
  const reasons: StakesReason[] = [...givesReasons(step), ...stepReasons(step, branch.effects)];
  const unknown = (): StakesReason[] => unique([...reasons, { why: "unknown", step: null, ref: null }]);
  const listed = branch.steps;
  const rejoin = branch.end === "end" ? null : (branch.rejoinAt ?? step.next);
  const seen = new Set<string>([step.id]);
  let index = 0;
  let afterList = false;
  let cursor: string | null = null;
  for (let count = 0; count < MAX_WALK; count += 1) {
    let id: string | null;
    if (index < listed.length) {
      id = listed[index] ?? null;
      index += 1;
    } else if (!afterList) {
      id = rejoin;
      afterList = true;
    } else {
      id = cursor;
    }
    if (id === null) return unique(reasons);
    if (seen.has(id)) return unknown();
    seen.add(id);
    const visited = flow.step(id);
    if (visited === null) return bundle.partial ? unique(reasons) : unknown();
    if (visited.asks) return unique(reasons);
    reasons.push(...stepReasons(visited, visited.effects));
    cursor = visited.next;
  }
  return unknown();
}
