// The routing tables (T-146; K-01 v1 'routingTables'; C-058): where the model enters a flow.
//
// Per flow this gives the hubs by the target booking's stage, the doors for something new, the any-time table (21 rows in
// arch 03's order, each with its handler step in the flow), the 50 rule nodes as the cached prefix, and the ten homes
// read from the flow's record. K-02 v1 names these as choice kinds (hub case, any-time row, door); building the frontier
// from them is the action layer's (C-075 to C-077), not here.
//
// Sources: arch 03 line 163 (hubs), 165 (doors), 169-177 (the any-time table, its order, flags and flag homes), 181 (the
// 50 rules as a cached prefix); arch 01 line 75; QUESTIONS Q-40 (handlers are derived from the master, starting from the
// steps BP's M3b row names; a row with no clear step goes to Jay, never guessed).
//
// What is refused (RoutingError): a hub, door, handler, rule node or home that is not a step of the flow, a flow without
// exactly 50 section 13 rule nodes, a record whose homes are not the ten named.
//
// Not here: the 67 judgment rules (`judgmentRules` of K-01's routingTables) belong to their own task; compileRouting
// returns the other five fields.
import { createHash } from "node:crypto";
import type { FlowGraph, FlowLetter, StepId } from "../graph/types.ts";
import type { AppliedTrade } from "../overlay/apply";
import { HOME_NAMES, type HomeName } from "../record";

/** A routing table that names a step the flow does not have, or a flow without its 50 rule nodes. The message names the place. */
export class RoutingError extends Error {
  override name = "RoutingError";
}

/** The hub of each stage and of the owner, settings and team (arch 03 line 163), in K-01's `hubs` field names. */
export type HubName = "entry" | "booked" | "checkedIn" | "done" | "owner" | "settings" | "team";
export const HUB_NAMES: readonly HubName[] = [
  "entry",
  "booked",
  "checkedIn",
  "done",
  "owner",
  "settings",
  "team",
];

/** The doors (arch 03 line 165), in K-01's `doors` field names. */
export type DoorName =
  "newBooking" | "existingBooking" | "ownerCommand" | "teamChange" | "unclearOwnerOrHelp";
export const DOOR_NAMES: readonly DoorName[] = [
  "newBooking",
  "existingBooking",
  "ownerCommand",
  "teamChange",
  "unclearOwnerOrHelp",
];

/** Arch 03 line 163: entry A3-51 (B3-40); booked A7-02 (B7-05); checked in A8-32 (B8-22); done A10-06 (B10-07); owner S11-12; settings S11-53; team S11-42. */
export const HUBS: Readonly<Record<FlowLetter, Readonly<Record<HubName, StepId>>>> = {
  A: {
    entry: "A3-51",
    booked: "A7-02",
    checkedIn: "A8-32",
    done: "A10-06",
    owner: "S11-12",
    settings: "S11-53",
    team: "S11-42",
  },
  B: {
    entry: "B3-40",
    booked: "B7-05",
    checkedIn: "B8-22",
    done: "B10-07",
    owner: "S11-12",
    settings: "S11-53",
    team: "S11-42",
  },
};

/** Arch 03 line 165: a new booking or a question A3-51 (B3-40); a booking already made A3-43 (B3-35); an owner command S11-12; a team change S11-42; an unclear owner text or HELP S11-21. */
export const DOORS: Readonly<Record<FlowLetter, Readonly<Record<DoorName, StepId>>>> = {
  A: {
    newBooking: "A3-51",
    existingBooking: "A3-43",
    ownerCommand: "S11-12",
    teamChange: "S11-42",
    unclearOwnerOrHelp: "S11-21",
  },
  B: {
    newBooking: "B3-40",
    existingBooking: "B3-35",
    ownerCommand: "S11-12",
    teamChange: "S11-42",
    unclearOwnerOrHelp: "S11-21",
  },
};

/** K-01 `anytimeRow.row`, in arch 03 line 171's order (which is also the order they run within one turn, line 173). */
export const ANYTIME_ROW_NAMES = [
  "danger-or-crisis",
  "threat",
  "child-elder-or-unsafe-at-home",
  "problem-getting-worse",
  "death",
  "stop",
  "wrong-party-or-language",
  "third-party-or-privacy",
  "contact-change",
  "payment-problem",
  "complaint-or-dispute",
  "damage",
  "owner-command",
  "cancel",
  "move",
  "running-late",
  "business-cant-make-it",
  "scope-change-or-new-request",
  "question-or-unclear-reply",
  "platform-or-ai-failure",
  "due-items",
] as const;
export type AnytimeRowName = (typeof ANYTIME_ROW_NAMES)[number];

/** The record flags a row's effects set (arch 03 line 175). */
export type AnytimeFlag = "deceased" | "stopped" | "private" | "paused";

/** One row of the any-time table, as K-01 `anytimeRow`. `handler` null: no clear step; the row is listed for Jay (Q-40). */
export interface AnytimeRow {
  row: AnytimeRowName;
  order: number;
  safetyReadOnly: boolean;
  handler: StepId | null;
  flags: AnytimeFlag[];
}

interface RowSource {
  row: AnytimeRowName;
  /** The three rows the safety read alone sets (arch 03 line 173). */
  safety: boolean;
  /** The handler step per flow; null: no clear step (Q-40). */
  handler: Record<FlowLetter, StepId | null>;
  flags: AnytimeFlag[];
  /** Where the handler comes from: the steps BP's M3b row names, or the architecture line that names the step for the row. */
  from: string;
  /** For a row with no handler: the steps of the master that come near, for Jay (never used as the handler). */
  candidates?: Record<FlowLetter, StepId[]>;
  /** For a row with no handler: why no step is clear. */
  why?: string;
}

const NONE: Record<FlowLetter, null> = { A: null, B: null };

/**
 * The 21 rows. A handler is taken only from what the sources name: BP's M3b steps (A3-22 to A3-26, A3-48 to A3-50, B3-17;
 * A7-11, B7-15, A7-98, B7-88, S2-08; S12-09 to S12-12), the step arch 03 line 175 names for a flag (A7-81 deceased, A3-48
 * paused, A3-50 private) and the owner-command hub (arch 03 line 163, 165). B's step is the one of the same title in flow B.
 * Every other row has no clear step (the master has several near steps and no one that the sources name): null, listed in
 * unresolved-anytime.json with the near steps, for Jay.
 */
const ROWS: readonly RowSource[] = [
  {
    row: "danger-or-crisis",
    safety: true,
    handler: { A: "A3-22", B: "B3-17" },
    flags: [],
    from: "M3b: A3-22 and B3-17 check every message for danger; A3-24 (911) and A3-25 (988) are its branches",
  },
  {
    row: "threat",
    safety: true,
    handler: { A: "A3-48", B: "B3-30" },
    flags: ["paused"],
    from: "M3b: A3-48; arch 03 line 175 (paused, A3-48); B3-30 is flow B's step of the same title",
  },
  {
    row: "child-elder-or-unsafe-at-home",
    safety: true,
    handler: { A: "A3-22", B: "B3-17" },
    flags: ["private"],
    from: "M3b: the danger check A3-22 and B3-17, whose branches are A3-49 and A3-50 (B3-31, B3-32); arch 03 line 175 (private, A3-50)",
  },
  {
    row: "problem-getting-worse",
    safety: false,
    handler: NONE,
    flags: [],
    from: "none",
    candidates: { A: ["A7-13", "A8-86"], B: ["B7-17", "B8-97"] },
    why: "before the visit a worse problem has a step (A7-13, B7-17), during the visit another (A8-86, B8-97); no source says which is the row's",
  },
  {
    row: "death",
    safety: false,
    handler: { A: "A7-81", B: "B7-73" },
    flags: ["deceased"],
    from: "arch 03 line 175 (deceased, A7-81); B7-73 is flow B's step of the same title",
  },
  {
    row: "stop",
    safety: false,
    handler: { A: "A7-11", B: "B7-15" },
    flags: ["stopped"],
    from: "M3b: A7-11 and B7-15 (S2-08 is the confirm before a person has joined)",
  },
  {
    row: "wrong-party-or-language",
    safety: false,
    handler: NONE,
    flags: [],
    from: "none",
    candidates: { A: ["A3-12"], B: ["B3-13"] },
    why: "a wrong number has a step (A3-12, B3-13); the master has no step for a wrong language",
  },
  {
    row: "third-party-or-privacy",
    safety: false,
    handler: NONE,
    flags: [],
    from: "none",
    candidates: { A: ["A3-41", "A7-80", "A10-40"], B: ["B3-33", "B7-72", "B10-33"] },
    why: "one step per stage (new conversation, before the visit, after it) and no source names one",
  },
  {
    row: "contact-change",
    safety: false,
    handler: { A: "A7-98", B: "B7-88" },
    flags: [],
    from: "M3b: A7-98 and B7-88",
  },
  {
    row: "payment-problem",
    safety: false,
    handler: NONE,
    flags: [],
    from: "none",
    candidates: { A: ["S12-25", "S12-16", "S11-24"], B: ["S12-25", "S12-16", "S11-24"] },
    why: "a declined card, a Stripe outage and a fee that cannot be charged are separate steps; no source names one",
  },
  {
    row: "complaint-or-dispute",
    safety: false,
    handler: NONE,
    flags: [],
    from: "none",
    candidates: { A: ["A10-14", "A10-16"], B: ["B10-13", "B10-14"] },
    why: "a complaint and a bank dispute are separate steps; no source names one",
  },
  {
    row: "damage",
    safety: false,
    handler: NONE,
    flags: [],
    from: "none",
    candidates: { A: ["A8-39"], B: ["B8-35"] },
    why: "one step covers damage during the visit; no source names it for the row, and damage found after the visit has none",
  },
  {
    row: "owner-command",
    safety: false,
    handler: { A: "S11-12", B: "S11-12" },
    flags: [],
    from: "arch 03 lines 163 and 165: an owner command, S11-12",
  },
  {
    row: "cancel",
    safety: false,
    handler: NONE,
    flags: [],
    from: "none",
    candidates: { A: ["A7-05", "A7-06"], B: ["B7-08", "B7-10"] },
    why: "an in-time cancel and a late cancel (with a fee) are separate steps; which one fits is decided by the clock",
  },
  {
    row: "move",
    safety: false,
    handler: NONE,
    flags: [],
    from: "none",
    candidates: { A: ["A7-03"], B: ["B7-07"] },
    why: "one step moves a visit before it; no source names it for the row",
  },
  {
    row: "running-late",
    safety: false,
    handler: NONE,
    flags: [],
    from: "none",
    candidates: { A: ["A7-70", "A7-14"], B: ["B7-27", "B7-18"] },
    why: "the customer running late and the pro running late are separate steps",
  },
  {
    row: "business-cant-make-it",
    safety: false,
    handler: NONE,
    flags: [],
    from: "none",
    candidates: { A: ["A7-93"], B: ["B7-90"] },
    why: "a split of six cases (pro cannot come, runs late, Sam moves it, business cancels, too few booked); no one step",
  },
  {
    row: "scope-change-or-new-request",
    safety: false,
    handler: NONE,
    flags: [],
    from: "none",
    candidates: { A: ["A7-31", "A8-33"], B: ["B7-31", "B8-23"] },
    why: "before the visit and during it are separate steps",
  },
  {
    row: "question-or-unclear-reply",
    safety: false,
    handler: NONE,
    flags: [],
    from: "none",
    candidates: { A: ["A7-12", "S11-21"], B: ["B7-16", "S11-21"] },
    why: "a customer's question and an owner's unclear text (S11-21) are separate steps",
  },
  {
    row: "platform-or-ai-failure",
    safety: false,
    handler: { A: "S12-11", B: "S12-11" },
    flags: [],
    from: "M3b: S12-11 (S12-09, S12-10 and S12-12 are the texting outage and the backup, one case each)",
  },
  {
    row: "due-items",
    safety: false,
    handler: NONE,
    flags: [],
    from: "none",
    candidates: { A: ["A7-94"], B: ["B7-91"] },
    why: "one step covers a plan or count due before the visit; no source names it for the row",
  },
];

/** The rows with no handler in a flow, for Jay (Q-40): the shape of unresolved-anytime.json. */
export interface UnresolvedRow {
  row: AnytimeRowName;
  order: number;
  /** The flows in which the row has no handler step. */
  flows: FlowLetter[];
  why: string;
  /** Steps that come near, per flow: for Jay to choose from, never a handler. */
  candidates: Record<FlowLetter, StepId[]>;
}

const FLOW_LETTERS: readonly FlowLetter[] = ["A", "B"];

/** The rows that no source gives a step for, in table order, with the near steps and the reason. */
export function unresolvedAnytime(): UnresolvedRow[] {
  const out: UnresolvedRow[] = [];
  ROWS.forEach((source, k) => {
    const flows = FLOW_LETTERS.filter((flow) => source.handler[flow] === null);
    if (flows.length === 0) return;
    out.push({
      row: source.row,
      order: k + 1,
      flows,
      why: source.why ?? "",
      candidates: source.candidates ?? { A: [], B: [] },
    });
  });
  return out;
}

/** The step ids the any-time table, hubs and doors name in a flow (so a test can show that they all exist). */
export function namedSteps(flow: FlowLetter): StepId[] {
  const ids = new Set<StepId>([...Object.values(HUBS[flow]), ...Object.values(DOORS[flow])]);
  for (const source of ROWS) {
    const handler = source.handler[flow];
    if (handler !== null) ids.add(handler);
    for (const near of source.candidates?.[flow] ?? []) ids.add(near);
  }
  return [...ids];
}

/** What routing reads of a step: its id, its words and its branches' steps. */
interface RoutedStep {
  id: StepId;
  kind?: string;
  title: string;
  does: string;
  more?: string[];
  rule?: string;
  branches?: { steps: RoutedStep[] }[];
}

/** One rule node: a section 13 step, a rule every step follows (SPEC-master 4 'kind'). */
export interface RuleNode {
  id: StepId;
  title: string;
  text: string;
}

/** The always-on rules as the cached prefix: K-01 `routingTables.alwaysOn`. */
export interface AlwaysOn {
  steps: StepId[];
  prefixText: string;
  prefixSha256: string;
}

/** One flow's routing tables: K-01 `routingTables` without `judgmentRules`. */
export interface CompiledRouting {
  flow: FlowLetter;
  hubs: Record<HubName, StepId>;
  doors: Record<DoorName, StepId>;
  anytime: { rows: AnytimeRow[] };
  alwaysOn: AlwaysOn;
  homes: Record<HomeName, StepId>;
  /** The 50 rule nodes the prefix is made of, in the flow's order. */
  ruleNodes: RuleNode[];
}

/** The number of rule nodes in a flow: one per section 13 step (arch 03 line 153: '717 steps + 50 rules'; arch 03 line 181). */
export const RULE_NODE_COUNT = 50;

function eachStep(steps: readonly RoutedStep[], visit: (step: RoutedStep) => void): void {
  for (const step of steps) {
    visit(step);
    for (const branch of step.branches ?? []) eachStep(branch.steps, visit);
  }
}

/** The text of one rule node as the prefix holds it: id and title, what it does, its lines, and its rule. */
function ruleText(step: RoutedStep): string {
  const lines = [`${step.id} ${step.title}`, step.does, ...(step.more ?? [])];
  if (step.rule !== undefined && step.rule !== "") lines.push(`Rule: ${step.rule}`);
  return lines.join("\n");
}

function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The rule nodes of a flow, in its order: every `kind: rule` step, each a section 13 step, 50 of them. */
function ruleNodesOf(steps: readonly RoutedStep[], at: string): RuleNode[] {
  const nodes: RuleNode[] = [];
  const seen = new Set<StepId>();
  eachStep(steps, (step) => {
    if (step.kind !== "rule") return;
    if (!step.id.startsWith("S13-"))
      throw new RoutingError(`${at}: rule node ${step.id} is not a section 13 step`);
    if (seen.has(step.id)) throw new RoutingError(`${at}: rule node ${step.id} is listed twice`);
    seen.add(step.id);
    nodes.push({ id: step.id, title: step.title, text: ruleText(step) });
  });
  eachStep(steps, (step) => {
    if (step.id.startsWith("S13-") && !seen.has(step.id))
      throw new RoutingError(`${at}: ${step.id} is a section 13 step but not a rule node`);
  });
  if (nodes.length !== RULE_NODE_COUNT)
    throw new RoutingError(`${at}: ${String(nodes.length)} rule nodes, expected ${String(RULE_NODE_COUNT)}`);
  return nodes;
}

function need(ids: ReadonlySet<StepId>, id: StepId, at: string): StepId {
  if (!ids.has(id)) throw new RoutingError(`${at}: ${id} is not a step of the flow`);
  return id;
}

function compile(
  flow: FlowLetter,
  steps: readonly RoutedStep[],
  recordHomes: Record<string, StepId>,
  at: string,
): CompiledRouting {
  const ids = new Set<StepId>();
  eachStep(steps, (step) => ids.add(step.id));

  const hubs = {} as Record<HubName, StepId>;
  for (const name of HUB_NAMES) hubs[name] = need(ids, HUBS[flow][name], `${at} hubs.${name}`);
  const doors = {} as Record<DoorName, StepId>;
  for (const name of DOOR_NAMES) doors[name] = need(ids, DOORS[flow][name], `${at} doors.${name}`);

  const rows: AnytimeRow[] = ROWS.map((source, k) => {
    const handler = source.handler[flow];
    return {
      row: source.row,
      order: k + 1,
      safetyReadOnly: source.safety,
      handler: handler === null ? null : need(ids, handler, `${at} any-time row ${source.row}`),
      flags: [...source.flags],
    };
  });

  const homes = {} as Record<HomeName, StepId>;
  const given = Object.keys(recordHomes);
  for (const key of given)
    if (!(HOME_NAMES as readonly string[]).includes(key))
      throw new RoutingError(`${at} homes.${key}: not one of the ten homes`);
  for (const name of HOME_NAMES) {
    const home = recordHomes[name];
    if (home === undefined) throw new RoutingError(`${at} homes.${name}: missing`);
    // Flow B's record.homes.two is A9-21: the $2 counts at the first check-in in flow A's step, and flow B has no such step.
    homes[name] =
      name === "two" && home.startsWith(flow === "A" ? "B" : "A")
        ? home
        : need(ids, home, `${at} homes.${name}`);
  }

  const ruleNodes = ruleNodesOf(steps, at);
  const prefixText = ruleNodes.map((node) => node.text).join("\n\n");
  return {
    flow,
    hubs,
    doors,
    anytime: { rows },
    alwaysOn: { steps: ruleNodes.map((node) => node.id), prefixText, prefixSha256: sha256Of(prefixText) },
    homes,
    ruleNodes,
  };
}

/** The routing tables of the master's flow (T-132's loaded flow). */
export function compileRouting(graph: FlowGraph): CompiledRouting {
  return compile(graph.flow, graph.path, graph.record.homes, `master-${graph.flow}.json routing`);
}

/** The routing tables of one trade's flow: the master's tables with the trade's words in the rules and the trade's record homes. */
export function compileTradeRouting(applied: AppliedTrade): CompiledRouting {
  const flow = applied.flow;
  return compile(flow.id, flow.steps, flow.record.homes, `${applied.trade} flow ${flow.id} routing`);
}
