// C3 (Master Corrections section 3; D104, DECISIONS.md lines 1222-1229; HANDOVER.md line 211; QUESTIONS Q-12 and Q-09
// defaults): the customer's own AI books at once when nothing is due; with money due, the time is saved 15 minutes, never
// extended.
//
// D104 runs first for a booking by the customer's own AI (the Agent API or MCP) for a service that books at once; where
// the steps' words differ for this door, D104 wins. The steps MC C3 names stay as written (its Where column): A3-03 and
// B3-23 (only the customer's own yes counts), A4-21 and B4-23 (the time saved for 10 minutes, more time when asked, a plan
// check up to 1 hour, a document up to 24 hours), S12-03 and S12-04 (a quiet AI's 10 minutes, then one text), S12-05 and
// S13-31 (a relayed yes never counts), A5-08 and B5-06 (Sam's OK, up to 30 minutes) and the page clocks A5-31 and B5-43
// (one 10-minute clock, more time offered). They hold for every other door, and at this one for a request the owner OKs.
//
// What this file gives:
//   ownAiDoor()  the door as the compiler compiles it for one flow: who comes in by it, the steps it runs before, and its
//                rules. Nothing to pay or save before the visit (the flow's money way "none"): booked at once on the AI's
//                request, in place of the own-yes rule of A3-03, S12-05 and S13-31. Money due now (a deposit or the full
//                price) or a card to save (the flow's other money ways): the time is saved 15 minutes in place of the 10,
//                as a calendar reservation, never a card hold, with extensions 0 (none of the master's longer saves
//                applies; Q-12's default); the secure pay link goes to the AI for the customer, to their email and to an
//                open chat. Paid or saved in time: booked, and the master and D103 carry on. Not in time: the time is let
//                go, nothing is booked or charged, and nobody is chased, so S12-04's text is not sent.
//   c3           the correction. It changes no step, since they stay as written, and stops the build where a flow lacks
//                one of them (ctx.need).
//
// The own AI is the customer's, tied to them by a code they typed back (Q-09's default: the tie is required). Not here:
// the reservation timers that hold the 15 minutes at run time (the database's T-198) and the door at run time (the action
// layer's C-111 and its saved-time rules). K-01 v1 has no field for the door, so the bundle does not carry it.
import type { FlowLetter, StepId } from "../graph/types.ts";
import type { AppliedFlow, AppliedStep } from "../overlay/apply";
import type { Correction, CorrectionTag } from "./framework";

/** The steps MC C3 names, in each flow: D104 runs before them for this door, and they stay as written. */
export const DOOR_STEPS: Readonly<Record<FlowLetter, readonly StepId[]>> = {
  A: ["A3-03", "A4-21", "S12-03", "S12-04", "S12-05", "S13-31", "A5-08", "A5-31"],
  B: ["B3-23", "B4-23", "S12-03", "S12-04", "S12-05", "S13-31", "B5-06", "B5-43"],
};

/** The steps whose own-yes rule the door's "booked at once" stands in place of (MC C3): A3-03 (B3-23), S12-05, S13-31. */
export const OWN_YES_STEPS: Readonly<Record<FlowLetter, readonly StepId[]>> = {
  A: ["A3-03", "S12-05", "S13-31"],
  B: ["B3-23", "S12-05", "S13-31"],
};

/** The step whose text is not sent at this door: nobody is chased when the 15 minutes run out (MC C3). */
export const NOT_CHASED: readonly StepId[] = ["S12-04"];

/** The saved time at this door: 15 minutes, never extended (MC C3; QUESTIONS Q-12's default). */
export const OWN_AI_SAVE = { minutes: 15, extensions: 0 } as const;

/** The master's saved time that the 15 minutes stand in place of (A4-21, B4-23: "Saves the time for 10 minutes"). */
export const MASTER_SAVE_MINUTES = 10;

/** How many times the master offers more time before the saved time ends (A4-21: "at least once"; Q-12's default: once). */
export const MASTER_SAVE_EXTENSIONS = 1;

/** The money ways before the visit a flow may have when its header names none (overlay-core.js BEFORE_WAYS). */
const ALL_BEFORE_WAYS: readonly string[] = ["none", "card", "hold", "deposit", "full"];

/** The money way with nothing to pay or save before the visit. */
const NOTHING_DUE = "none";

/** A saved time: how long, and how many times it may be made longer. */
export interface SavedTime {
  minutes: number;
  extensions: number;
}

/** A save of the master's that does not apply at this door, and the steps that state it. */
export interface MasterSave {
  what: string;
  at: StepId[];
}

/** The own-AI door (D104) as the compiler compiles it for one flow. */
export interface OwnAiDoor {
  tag: CorrectionTag;
  flow: FlowLetter;
  /** Who comes in by it: the customer's own AI, through the Agent API or MCP, tied to the customer by a code (Q-09). */
  who: "agent";
  through: ["api", "mcp"];
  /** A service that books at once (booking value approval "now"). A request the owner OKs keeps the master's rules. */
  approval: "now";
  /** The steps D104 runs before. They stay as written; where their words differ for this door, D104 wins. */
  before: StepId[];
  /** Nothing to pay or save before the visit: booked at once on the AI's request, in place of these steps' own-yes rule. */
  atOnce: { ways: string[]; insteadOf: StepId[] };
  /** Money due now or a card to save: the time is saved, as a calendar reservation, never a card hold. */
  saved: {
    ways: string[];
    time: SavedTime;
    as: "calendar reservation";
    insteadOf: SavedTime;
    /** Who gets the secure pay link: the AI, for the customer; the customer's email; an open chat. */
    payLink: ["agent", "email", "chat"];
    /** Paid or card saved in time: booked, and the master and D103 carry on. */
    inTime: "booked";
    /** Not done in time: the time is let go; nothing booked or charged; nobody chased (these steps' texts are not sent). */
    notInTime: { booked: false; charged: false; chased: false; notSent: StepId[] };
  };
  /** The master's longer saves, none of which applies at this door: its 15 minutes are never extended. */
  notApplied: MasterSave[];
}

/** A flow that lacks a step the own-AI door runs before. */
export class OwnAiDoorError extends Error {
  override name = "OwnAiDoorError";
}

function stepIds(steps: readonly AppliedStep[], out = new Set<string>()): Set<string> {
  for (const step of steps) {
    out.add(step.id);
    for (const branch of step.branches ?? []) stepIds(branch.steps, out);
  }
  return out;
}

/** The flow's money ways before the visit (its header's money.ways.before), or every way when it names none. */
function beforeWays(flow: AppliedFlow): string[] {
  const ways = (flow.money.ways as { before?: unknown } | undefined)?.before;
  return Array.isArray(ways) && ways.every((way): way is string => typeof way === "string")
    ? [...ways]
    : [...ALL_BEFORE_WAYS];
}

/** The master's longer saves (MC C3, "The master says"), by the steps that state them in the flow. */
function masterSaves(flow: FlowLetter): MasterSave[] {
  const saveStep = flow === "A" ? "A4-21" : "B4-23";
  const pageClock = flow === "A" ? "A5-31" : "B5-43";
  const ownerOk = flow === "A" ? "A5-08" : "B5-06";
  return [
    { what: "more time, when asked or offered before the saved time ends", at: [saveStep, pageClock] },
    { what: "a plan check, up to 1 hour", at: [saveStep] },
    { what: "a document to sign, up to 24 hours", at: [saveStep, pageClock] },
    { what: "the owner's OK, up to 30 minutes", at: [ownerOk] },
  ];
}

/**
 * The own-AI door of one flow, compiled: the flow must hold every step MC C3 names (OwnAiDoorError otherwise), and its
 * money ways split the door's two rules. The same for every trade: a trade's ops never change D104.
 */
export function ownAiDoor(flow: AppliedFlow): OwnAiDoor {
  const ids = stepIds(flow.steps);
  const missing = DOOR_STEPS[flow.id].filter((id) => !ids.has(id));
  if (missing.length > 0)
    throw new OwnAiDoorError(`MC:C3 flow ${flow.id}: no step ${missing.join(", ")} for the own-AI door`);
  const ways = beforeWays(flow);
  return {
    tag: "MC:C3",
    flow: flow.id,
    who: "agent",
    through: ["api", "mcp"],
    approval: "now",
    before: [...DOOR_STEPS[flow.id]],
    atOnce: { ways: ways.filter((way) => way === NOTHING_DUE), insteadOf: [...OWN_YES_STEPS[flow.id]] },
    saved: {
      ways: ways.filter((way) => way !== NOTHING_DUE),
      time: { minutes: OWN_AI_SAVE.minutes, extensions: OWN_AI_SAVE.extensions },
      as: "calendar reservation",
      insteadOf: { minutes: MASTER_SAVE_MINUTES, extensions: MASTER_SAVE_EXTENSIONS },
      payLink: ["agent", "email", "chat"],
      inTime: "booked",
      notInTime: { booked: false, charged: false, chased: false, notSent: [...NOT_CHASED] },
    },
    notApplied: masterSaves(flow.id),
  };
}

/** C3: D104's own-AI door runs first; the steps it runs before stay as written. */
export const c3: Correction = {
  id: "C3",
  title: "The customer's own AI books at once with nothing due; else 15 minutes saved, never extended",
  source:
    "Master Corrections C3; D104 (DECISIONS.md lines 1222-1229); HANDOVER.md line 211; QUESTIONS Q-12 and Q-09 defaults",
  apply(ctx) {
    // The steps stay as written (MC C3): the correction only makes sure the flow still has each one.
    for (const id of DOOR_STEPS[ctx.flow]) ctx.need(id);
  },
};
