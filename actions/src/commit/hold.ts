// What may commit in this turn, decided before the gate runs and after it (T-305). Four rules, each a documented default
// the gate framework (T-298) left to the commit:
//
//   1. The turn (QUESTIONS.md CQ-69): the commit writes the turn row it is given, whose id the lease made (T-248's
//      turnIdOf over the texts' event ids); it never makes or changes a turn id. A call that is not the turn's own (another
//      caller kind, another turn id or trace id in the caller, the context or the decide result) is refused.
//   2. The bundle (CQ-72's default 2; K-09 v1 bundleMismatch): the turn row carries the bundle pinned at the turn's start
//      (K-05 v1 turn.bundleId; arch 10 line 548). A context or decide result naming another bundle is refused before any
//      limit runs: nothing is written.
//   3. Safety holds (CQ-65 with its DL-127 and DL-128 addenda; arch 06 lines 315 to 329). What is open at commit time is
//      each safety hold on the handle (K-09 v1 safetyHold) and each of the turn's texts not yet read (types.ts OpenHolds).
//      A part commits only if every open hold lets it through ("Several at once: The strictest holds", arch 06 line 327)
//      and, unless it only protects, no text is unread:
//        - every hold, and an unread text, lets the protective changes through ("Changes that only protect, such as a
//          stop, stricter contact or a death report, commit at once", arch 06 line 329; the A3-48 pause; A3-50's private
//          booking; their twins in the master): PROTECTIVE_ROWS and PROTECTIVE_STEPS;
//        - an emergency, crisis-words or unsure hold (release rule after_safe: "After a clear 'we're safe', with a fresh
//          read-back (A3-24, A3-25)", arch 06 line 323) also lets its own release through: SAFETY_FLOW_STEPS;
//        - nothing else. The other safety steps rejoin the booking, so they are held under every open hold: the danger
//          read A3-22 and its flow B twin B3-17 (their "No" and "Safety steps, then go on" branches rejoin:
//          MASTER-FLOW-A.md lines 1667 and 1670, MASTER-FLOW-B.md lines 1447 and 1450), A3-23 ("Then the booking goes
//          on, marked urgent", A line 1675), A3-26 ("Then the booking can go on", A line 1758), A3-49 ("the booking goes
//          on", A line 1731) and B3-31 (B line 1538). So is a hand-off, which is not in CQ-65's protective list: whoever
//          a safety outcome must tell, the outcome itself tells (arch 06 line 329).
//      A threat's hold (never), a hold released once the booking is private (when_private), an at-once hold until it is
//      released, and an unread text all let only the protective changes through. Held parts are held back before the
//      gate, so no limit runs for them (K-09 v1 valueFailsWords: "parts a safety outcome holds are held, not gated").
//   4. One question first (CQ-73's default): a part the gate passed on the booking of a part decide ended in one question
//      (oneQuestion, or the verb ask) waits for the answer: it is answered `asked` and writes nothing.

import type { Choice, DecidePart, Decided } from "../gate/framework";
import { CommitRefusedError } from "./errors";
import type { BundleMismatch, GateAndCommitRequest, OpenHolds, SafetyHold, TurnRow } from "./types";

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
 * The any-time rows whose effect is a protective record flag and whose handler is a protective step (bundle v1 any-time
 * table, contracts/bundle/fixtures/anytime-table.json): stop (flag stopped; handler A7-11), death (deceased; A7-81) and
 * threat (paused; A3-48). Not the child, elder or unsafe-at-home row: its handler is the danger read itself (A3-22), whose
 * hotline branch rejoins the booking (A3-49); only its private booking is protective, by its step (A3-50, B3-32).
 */
export const PROTECTIVE_ROWS: readonly string[] = ["stop", "death", "threat"];

/**
 * The steps whose change only protects (DL-128), each with its place in the master (A: MASTER-FLOW-A.md; B:
 * MASTER-FLOW-B.md). A flow B twin is the same step under the same heading and words:
 *   - a STOP: A7-11 "No more texts; the visit stays" (A line 3929, branch "Alex texts STOP or CANCEL" line 3927), its twin
 *     B7-15 (B line 3938), and a staff member's STOP to the invite, S2-08 "Confirms the stop; tells Sam" (A line 1290);
 *   - a death report: A7-81 "Stops texts and charges for a customer who died" (A line 4053) and its twin B7-73 (B line
 *     4067);
 *   - the A3-48 pause: A3-48 "Tells Sam at once about a threat" (A line 1709) and its twin B3-30 (B line 1516);
 *   - A3-50's private booking, which also makes contact stricter ("Their contact preferences get stricter", A line 1661;
 *     "Someone else's word only makes these stricter", line 1744): A3-50 "Makes the booking private and safe" (A line
 *     1738) and its twin B3-32 (B line 1545).
 * A choice at one of them is protective. Not here, so held while anything is open (fail closed): A7-98 and B7-88
 * (updates to a new phone or email, A line 3946, B line 3961), which add a way in; and A7-88 and B7-71 (a threat after
 * booking, A line 4014, B line 4029), which DL-128 does not name, while the threat row itself is protective (A3-48).
 */
export const PROTECTIVE_STEPS: readonly string[] = [
  "A7-11",
  "B7-15",
  "S2-08",
  "A7-81",
  "B7-73",
  "A3-48",
  "B3-30",
  "A3-50",
  "B3-32",
];

/**
 * The release an emergency, crisis-words or unsure hold (release rule after_safe) waits for, a clear "we're safe" with a
 * fresh read-back (arch 06 line 323): A3-24 "Sends the 911 safety message" ("After a clear 'we're safe, it's handled', the
 * booking may go on", A line 1690) and A3-25 "Gives the 988 crisis line" ("The booking may go on in this chat only after a
 * clear 'I'm safe right now'", A line 1701), and the flow B steps the master names with the same read-back: B3-19 (B line
 * 1475) and B3-20 (B line 1489). Only an after-safe hold lets them through.
 */
export const SAFETY_FLOW_STEPS: readonly string[] = ["A3-24", "A3-25", "B3-19", "B3-20"];

/**
 * What a part is to what is open: protective (it only protects: every hold and an unread text let it through), the
 * safety flow (an after-safe hold's own release: only an after-safe hold lets it through), routine (every other part,
 * the other safety steps and a hand-off included: held while any hold is open or any text is unread), or none (a verb
 * that writes nothing: ask, no_op, redact, none_fits; the gate answers it asked or noAction, so there is nothing to hold).
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
      // Held under every open hold (DL-128): it is not in CQ-65's protective list.
      return "routine";
    case "pass_on":
      return "routine";
    case "choose":
    case "enter":
      if (choice === null) return "routine";
      if (choice.anytimeRow !== null && PROTECTIVE_ROWS.includes(choice.anytimeRow)) return "protective";
      if (PROTECTIVE_STEPS.includes(choice.step)) return "protective";
      if (SAFETY_FLOW_STEPS.includes(choice.step)) return "safetyFlow";
      return "routine";
    default:
      return "routine";
  }
}

/** Whether one open hold lets a part of this class through (arch 06 lines 319 to 329; DL-128). */
export function letsThrough(hold: SafetyHold, holdClass: HoldClass): boolean {
  switch (holdClass) {
    case "none":
    case "protective":
      return true;
    case "safetyFlow":
      return hold.releaseRule === "after_safe";
    case "routine":
      return false;
  }
}

/**
 * Whether what is open keeps a part of this class back: it commits only if every open hold lets it through (the strictest
 * holds: arch 06 line 327) and, unless it is protective, none of the turn's texts is unread (CQ-65's DL-127 addendum).
 */
export function isHeld(
  holdClass: HoldClass,
  holds: readonly SafetyHold[],
  unreadEventIds: readonly string[] = [],
): boolean {
  if (holdClass === "none" || holdClass === "protective") return false;
  if (unreadEventIds.length > 0) return true;
  return holds.some((hold) => !letsThrough(hold, holdClass));
}

/** The offered choice a choose or enter names; null for another verb, or a choice the context does not hold. */
export function choiceOf(decided: Decided, part: DecidePart): Choice | null {
  if (part.verb !== "choose" && part.verb !== "enter") return null;
  return decided.context.choices.find((offered) => offered.choiceId === part.choice) ?? null;
}

/** The parts of decide that what is open keeps back, by index (empty for a turn with no decided texts, or nothing open). */
export function heldParts(request: GateAndCommitRequest, open: OpenHolds): ReadonlySet<number> {
  const held = new Set<number>();
  if (request.input.kind !== "decided") return held;
  if (open.holds.length === 0 && open.unreadEventIds.length === 0) return held;
  const { decided } = request.input;
  decided.decide.parts.forEach((entry, index) => {
    const holdClass = holdClassOf(entry.part, choiceOf(decided, entry.part));
    if (isHeld(holdClass, open.holds, open.unreadEventIds)) held.add(index);
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
