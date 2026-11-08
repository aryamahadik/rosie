// What may commit in this turn, decided before the gate runs and after it (T-305). Four rules, each a documented default
// the gate framework (T-298) left to the commit:
//
//   1. The turn (QUESTIONS.md CQ-69): the commit writes the turn row it is given, whose id the lease made (T-248's
//      turnIdOf over the texts' event ids); it never makes or changes a turn id. A call that is not the turn's own (another
//      caller kind, another turn id or trace id in the caller, the context or the decide result) is refused.
//   2. The bundle (CQ-72's default 2; K-09 v1 bundleMismatch): the turn row carries the bundle pinned at the turn's start
//      (K-05 v1 turn.bundleId; arch 10 line 548). A context or decide result naming another bundle is refused before any
//      limit runs: nothing is written.
//   3. Safety holds (CQ-65's replaced default, DL-119; arch 06 lines 315 to 329): while a hold is open on the handle, only
//      changes that only protect (a STOP, a death report, the A3-48 pause or the A3-50 private flag: the any-time rows
//      whose effect is a record flag, and their handler steps; a hand-off to a person) and the safety flow (the danger
//      read's own steps, a clear "we're safe" with a fresh read-back: A3-22 to A3-26) commit; every routine part is held
//      (K-09 v1 partResult `held`). A threat's hold (release rule never) lets only the protective changes through. Held
//      parts are held back before the gate, so no limit runs for them (K-09 v1 valueFailsWords: "parts a safety outcome
//      holds are held, not gated"). Every open hold holds, whatever its rule: an at-once hold binds until it is released.
//   4. One question first (CQ-73's default): a part the gate passed on the booking of a part decide ended in one question
//      (oneQuestion, or the verb ask) waits for the answer: it is answered `asked` and writes nothing.

import type { Choice, DecidePart, Decided } from "../gate/framework";
import { CommitRefusedError } from "./errors";
import type { BundleMismatch, GateAndCommitRequest, SafetyHold, TurnRow } from "./types";

// ---- 1. the turn ------------------------------------------------------------------------------------------------------

/**
 * The turn row the commit writes, checked against the call: a turn's own call (caller.kind turn), its caller, context and
 * decide result naming this turn and its trace. A clock's firing never reaches here (gateAndCommit refuses it first).
 */
export function checkTurn(request: GateAndCommitRequest, turn: TurnRow): void {
  const { caller, input } = request;
  if (caller.kind !== "turn") throw new CommitRefusedError("callerNotTurn");
  if (caller.turnId !== turn.id) throw new CommitRefusedError("turnIdMismatch");
  if (caller.traceId !== turn.traceId) throw new CommitRefusedError("traceIdMismatch");
  if (input.kind !== "decided") return;
  const { context, decide } = input.decided;
  if (context.turnId !== turn.id || decide.turnId !== turn.id) {
    throw new CommitRefusedError("turnIdMismatch");
  }
}

// ---- 2. the bundle ----------------------------------------------------------------------------------------------------

/** A bundle id as K-01 v1 writes it: its content hash and build number. */
interface BundleIdOf {
  readonly hash: string;
  readonly build: number;
}

const sameBundle = (a: BundleIdOf, b: BundleIdOf): boolean => a.hash === b.hash && a.build === b.build;

/**
 * K-09 v1 bundleMismatch when the context or the decide result names another bundle than the one the turn pinned (its
 * row's bundle id); null when every one names the pin. A turn of core actions only carries no other bundle.
 */
export function bundleMismatchOf(request: GateAndCommitRequest, turn: TurnRow): BundleMismatch | null {
  if (request.input.kind !== "decided") return null;
  const { context, decide } = request.input.decided;
  for (const given of [context.bundleId, decide.bundleId]) {
    if (!sameBundle(given, turn.bundleId)) {
      return {
        error: "bundleMismatch",
        turnBundleId: { hash: turn.bundleId.hash, build: turn.bundleId.build },
        givenBundleId: { hash: given.hash, build: given.build },
      };
    }
  }
  return null;
}

// ---- 3. safety holds --------------------------------------------------------------------------------------------------

/**
 * The any-time rows whose effect only protects, as a record flag (bundle v1 any-time table `flags`; arch 03 line 175; arch
 * 06 line 329: "Changes that only protect, such as a stop, stricter contact or a death report, commit at once"): stop
 * (stopped), death (deceased), threat (paused, A3-48) and child, elder or unsafe at home (private, A3-50).
 */
export const PROTECTIVE_ROWS: readonly string[] = [
  "stop",
  "death",
  "threat",
  "child-elder-or-unsafe-at-home",
];

/**
 * The handler steps of those rows (01-inventory any-time rows 2, 3, 5 and 6; QUESTIONS.md CQ-65: "the A3-48 pause"): the
 * threat's pause (A3-48, flow B's B3-30), the unsafe-at-home private booking (A3-50, B3-32), a death report (A7-81) and a
 * STOP (A7-11, B7-15; a staff member's at joining, S2-08). A choice at one of them is protective too.
 */
export const PROTECTIVE_STEPS: readonly string[] = [
  "A3-48",
  "B3-30",
  "A3-50",
  "B3-32",
  "A7-81",
  "A7-11",
  "B7-15",
  "S2-08",
];

/** The danger read's own any-time row: entering it is the safety flow (A3-22). */
export const SAFETY_ROW = "danger-or-crisis";

/**
 * The steps of the safety flow a hold lets through but a threat's (arch 06 lines 319 to 325; 01-inventory any-time rows 1
 * and 3): the danger outcome and its "we're safe" with a fresh read-back (A3-22 to A3-26; flow B's danger read, B3-17), and
 * the child or elder hotline with the team told that day (A3-49, B3-31). Flow B's own "we're safe" steps are not named in
 * the sources this task reads, so they are held until they are (fail closed).
 */
export const SAFETY_FLOW_STEPS: readonly string[] = [
  "A3-22",
  "A3-23",
  "A3-24",
  "A3-25",
  "A3-26",
  "A3-49",
  "B3-17",
  "B3-31",
];

/**
 * What a part is to a hold: protective (only protects: it commits under every hold), the safety flow (it commits under
 * every hold but a threat's), routine (held while any hold is open), or none (a verb that writes nothing: ask, no_op,
 * redact, none_fits).
 */
export type HoldClass = "protective" | "safetyFlow" | "routine" | "none";

export function holdClassOf(part: DecidePart, choice: Choice | null): HoldClass {
  switch (part.verb) {
    case "ask":
    case "no_op":
    case "redact":
    case "none_fits":
      return "none";
    case "hand_off":
      // A hand to a person adds no person, way in, money or authority: it only gets someone to look (arch 06 line 329).
      return "protective";
    case "pass_on":
      return "routine";
    case "choose":
    case "enter":
      if (choice === null) return "routine";
      if (choice.anytimeRow !== null && PROTECTIVE_ROWS.includes(choice.anytimeRow)) return "protective";
      if (PROTECTIVE_STEPS.includes(choice.step)) return "protective";
      if (choice.anytimeRow === SAFETY_ROW || SAFETY_FLOW_STEPS.includes(choice.step)) return "safetyFlow";
      return "routine";
    default:
      return "routine";
  }
}

/** Whether the open holds keep a part of this class back: a threat's (never) lets only protective changes through. */
export function isHeld(holdClass: HoldClass, holds: readonly SafetyHold[]): boolean {
  if (holds.length === 0) return false;
  switch (holdClass) {
    case "none":
    case "protective":
      return false;
    case "safetyFlow":
      return holds.some((hold) => hold.releaseRule === "never");
    case "routine":
      return true;
  }
}

/** The offered choice a choose or enter names; null for another verb, or a choice the context does not hold. */
export function choiceOf(decided: Decided, part: DecidePart): Choice | null {
  if (part.verb !== "choose" && part.verb !== "enter") return null;
  return decided.context.choices.find((offered) => offered.choiceId === part.choice) ?? null;
}

/** The parts of decide the open holds keep back, by index (empty for a turn with no decided texts or no hold). */
export function heldParts(request: GateAndCommitRequest, holds: readonly SafetyHold[]): ReadonlySet<number> {
  const held = new Set<number>();
  if (request.input.kind !== "decided" || holds.length === 0) return held;
  const { decided } = request.input;
  decided.decide.parts.forEach((entry, index) => {
    if (isHeld(holdClassOf(entry.part, choiceOf(decided, entry.part)), holds)) held.add(index);
  });
  return held;
}

// ---- 4. one question first --------------------------------------------------------------------------------------------

/** A target's booking as one key (its business and booking), or null when it is about no booking. */
export function bookingKey(target: {
  readonly businessId: string;
  readonly bookingId: string | null;
}): string | null {
  return target.bookingId === null ? null : JSON.stringify([target.businessId, target.bookingId]);
}

/**
 * The bookings of the parts decide ended in one question (K-02 v1 resultPart oneQuestion, or the verb ask): a choose or
 * enter's choice's booking, an ask's questions' bookings (K-02 v1 openQuestion.target).
 */
export function askedBookings(decided: Decided): ReadonlySet<string> {
  const keys = new Set<string>();
  const add = (key: string | null): void => {
    if (key !== null) keys.add(key);
  };
  for (const entry of decided.decide.parts) {
    const { part } = entry;
    if (part.verb === "ask") {
      for (const id of part.questions) {
        const question = decided.context.openQuestions.find((open) => open.openQuestionId === id);
        if (question !== undefined) add(bookingKey(question.target));
      }
    } else if (entry.outcome === "oneQuestion") {
      const choice = choiceOf(decided, part);
      if (choice !== null) add(bookingKey(choice.target));
    }
  }
  return keys;
}
