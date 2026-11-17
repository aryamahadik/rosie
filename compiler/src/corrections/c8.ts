// C8 (Master Corrections section 3; D96, DECISIONS.md line 1170; S1-32 and S1-10; 01-inventory C-228): the trade ops
// that switch off a whole step citing D96, on steps that check nothing, are void.
//
// The master says nothing of them: they are the trade files' own (`{"op": "off", "at": "S1-32", "why": "no license is
// checked for this work (D96)"}`, golf-instructor.json). MC C8 names them: S1-32 (the ID and control go-live gate),
// S2-22 (Sam's yes before staff take bookings), S11-48 (adding staff) and S11-57 (changing rules and previewing what AI
// assistants see) in 12 trades; and the own-word steps D96 relies on, S11-50 (27 trades), S13-11 (16), S13-15
// (fertility, lab, obgyn, sleep-clinic) and S2-11 (occupational-therapist, pain-management, sports-medicine). What holds:
// these offs are void, so each of those steps runs for every trade, and only its switch-"verify" branches stay hidden
// (C4). Every other D96 off in the trade files stays as written (C-228: its step or branch stays unreachable for the
// trades that turn it off; T-147 marks them), including the offs of the steps only switch "verify" lights.
//
// An off is a trade op, and overlay-core.js apply() sets the step's `off` from it (line 1853), while a branch's off
// sets the `off` of every step inside that branch (line 1852). So C8 acts on the trade, not on a step: it drops each
// void op from the trade's ops before the applier runs them, which a branch's off (kept) cannot be mistaken for. The
// compiled overlay then holds the ops without them (K-01 overlayOp: "C8's void offs are dropped"), as does every stage
// that reads the corrected trade (the opt-out line's walks, the trade compile).
//
// What this file gives:
//   VOID_STEPS      the eight steps whose whole-step D96 offs are void.
//   isVoidOff()     whether an op is one: an `off` with no branch label, at one of the eight, whose `why` cites D96.
//   voidOffs()      the trade with every void op dropped from both flows' ops, and each op dropped, tagged MC:C8.
//   renderVoided()  the dropped ops as diff lines, each starting with its tag, as framework.ts renderDiff() writes a step's.
//   c8              the correction in the frame's list: it changes no step (the ops are the trade's: voidOffs()).
import type { FlowLetter } from "../graph/types.ts";
import type { LoadedTrade, TradeId, TradeOp } from "../load/trade";
import type { Correction, CorrectionTag } from "./framework";

/** The steps whose whole-step D96 offs C8 voids, in MC C8's order. */
export const VOID_STEPS: readonly string[] = [
  "S1-32",
  "S2-22",
  "S11-48",
  "S11-57",
  "S11-50",
  "S13-11",
  "S13-15",
  "S2-11",
];

/** What an off's `why` must cite to be one of C8's: decision D96 (DECISIONS.md line 1170). */
export const D96 = /\bD96\b/;

const TAG: CorrectionTag = "MC:C8";
const FLOWS: readonly FlowLetter[] = ["A", "B"];

type OffOp = Extract<TradeOp, { op: "off" }>;

/** Whether an op is an off citing D96 (a whole step or one branch, at any step): C-228's class, 618 in fixture set v1. */
export function isD96Off(op: TradeOp): op is OffOp {
  return op.op === "off" && D96.test(op.why);
}

/**
 * Whether an op is one C8 voids: an off of a whole step at one of VOID_STEPS, citing D96. A whole step's off has no
 * branch label, or an empty one, as overlay-core.js apply() reads a label (line 1850).
 */
export function isVoidOff(op: TradeOp): op is OffOp {
  return isD96Off(op) && !op.label && VOID_STEPS.includes(op.at);
}

/** One op C8 dropped. */
export interface VoidedOff {
  tag: CorrectionTag;
  trade: TradeId;
  flow: FlowLetter;
  /** The op's place in the trade file's ops of that flow, from 0. */
  op: number;
  /** The step it switched off. */
  at: string;
  /** Its reason, as the trade wrote it. */
  why: string;
}

/** A trade with C8's void offs dropped, and each op dropped. */
export interface VoidedTrade {
  trade: LoadedTrade;
  voided: VoidedOff[];
}

/**
 * The trade with every void off (isVoidOff) dropped from the ops of both flows, the other ops kept in the file's order,
 * and each op dropped, tagged MC:C8. The trade given is not changed; one with none is given back as it is.
 */
export function voidOffs(trade: LoadedTrade): VoidedTrade {
  const voided: VoidedOff[] = [];
  let out = trade;
  for (const flow of FLOWS) {
    const ops = trade.flows[flow].ops;
    const kept: TradeOp[] = [];
    ops.forEach((op, n) => {
      if (isVoidOff(op)) voided.push({ tag: TAG, trade: trade.id, flow, op: n, at: op.at, why: op.why });
      else kept.push(op);
    });
    if (kept.length !== ops.length)
      out = { ...out, flows: { ...out.flows, [flow]: { ...out.flows[flow], ops: kept } } };
  }
  return { trade: out, voided };
}

/** The dropped ops as diff lines: `MC:C8 - <trade> <flow> ops[<n>]: {"op":"off","at":...,"why":...}`. */
export function renderVoided(voided: readonly VoidedOff[]): string[] {
  return voided.map(
    (one) =>
      `${one.tag} - ${one.trade} ${one.flow} ops[${String(one.op)}]: ${JSON.stringify({ op: "off", at: one.at, why: one.why })}`,
  );
}

/** C8: the void D96 offs. They are the trade's ops, dropped before the applier runs them, so the correction changes no step. */
export const c8: Correction = {
  id: "C8",
  title:
    "The trades' D96 offs of S1-32, S2-22, S11-48, S11-57, S11-50, S13-11, S13-15 and S2-11 are void; every other D96 off stays",
  source:
    "Master Corrections C8; D96 (DECISIONS.md line 1170); S1-32, S1-10; MASTER-FLOW-A.md line 1074; 01-inventory C-228",
  apply() {
    // No step changes: C8 drops the trade's void ops before the applier runs them (voidOffs).
  },
};
