// What the policy gate (C-080, T-298) reads and gives, and the one small interface each of limits 1 to 6 implements.
//
// The gate is gateAndCommit's first half (K-09 v1.5; arch 02 line 121; arch 06 lines 295 to 309): it takes the turn's
// context and decide's result (K-02 v1.1 contextAndDecide), confirms decide's output (arch 03 line 185), then runs limits
// 1 to 6 on each agreed part in order. Each limit lives in its own folder, actions/src/gate/limit-N/, registered in
// actions/src/gate/limits.ts; until its task lands (T-299 to T-304) the folder holds the fail-closed stub (stub.ts).
//
// Every type below that K-09 v1.5 or K-02 v1.1 defines is the generated contract type (`npm run contracts:types`;
// ADR-005), reached through the gateAndCommit request, so the gate and the Tool API base read one shape. Each keeps v1's
// meaning: v1.5 and K-02 v1.1 only add (a choice's door may be signUp; the turn may carry its last text's service and
// chat id; a part may give a later journey's key), and the rest are v1's definitions by reference.

import type * as K09 from "../../../../contracts/generated/tool-api/tool-api.v1.5";
import type { RequestOf } from "../../tool-api";

/** The gateAndCommit request (K-09 v1.5 `gateAndCommit.request`), as the Tool API base hands it to its handler. */
export type GateRequest = RequestOf<"gateAndCommit">;
/** A context with the decide result made from it, as the gate reads them (K-02 v1.1 `contextAndDecide`). */
export type Decided = K09.DecidedInput["decided"];
/** The turn's context: its texts, open questions and offered choices (K-02 v1.1 `context`). */
export type Context = Decided["context"];
/** Decide's result: the reads and the parts handed to the gate (K-02 v1.1 `decideResult`, v1's by reference). */
export type DecideResult = Decided["decide"];
/** One verb for one part of the text (K-02 v1.1 `decidePart`, v1's by reference). */
export type DecidePart = DecideResult["parts"][number]["part"];
/** One offered choice of the frontier (K-02 v1.1 `choice`, whose door may also be signUp). */
export type Choice = Context["choices"][number];
/** The verbs the limits gate: those whose part writes something in the commit (gate.ts, default 2). */
export type GatedVerbPart = Extract<DecidePart, { verb: "choose" | "enter" | "pass_on" | "hand_off" }>;

/** Each limit's outcomes when it fails (K-09 v1.5 `limit1Outcome` to `limit6Outcome`, v1's by reference). */
export interface LimitOutcomes {
  1: K09.Limit1Outcome;
  2: K09.Limit2Outcome;
  3: K09.Limit3Outcome;
  4: K09.Limit4Outcome;
  5: K09.Limit5Outcome;
  6: K09.Limit6Outcome;
}

/** A limit checked at the gate: 1 Allowed, 2 Owner rules, 3 Exact yes, 4 Versions, 5 Reserved, 6 Values (arch 06). */
export type LimitNumber = keyof LimitOutcomes;
/** The failed limit and its outcome (K-09 v1.5 `limitOutcome`, v1's by reference). */
export type LimitOutcome = K09.LimitOutcome;
/** One limit's result as the gate span and the part's result log it (K-08 v1 `limitResult`). */
export type LimitResult = K09.LimitResult;
/** What the gate did with one part, as gateAndCommit answers it (K-09 v1.5 `partResult`, v1.4's by reference). */
export type PartResult = K09.PartResult;
/** A key a part's step gives (K-09 v1.5 `stepKey`, `partResult.gives`), which the commit names on a committed part. */
export type SetupKey = K09.StepKey;
/** Decide's output broke a K-02 v1.1 named rule (K-09 v1.5 `gateAndCommit.errors` decideRefused). */
export type DecideRefused = K09.DecideRefusedError;
/** A value failed its words before decide's one re-read (K-09 v1.5 `gateAndCommit.errors` valueFailsWords). */
export type ValueFailsWords = K09.ValueFailsWordsError;
/** gateAndCommit's refusals that the gate itself answers: nothing is written (K-09 v1.5 `gateAndCommit.errors`). */
export type GateRefusal = DecideRefused | ValueFailsWords;

/** One agreed part as a limit checks it: its quote, its choice and every value's words already confirmed. */
export interface GatePart {
  /** The part's index in decide.parts (K-02 v1.1 `decideResult.parts`; K-09 v1.5 `partResult.part`). */
  readonly index: number;
  /** The part as decide agreed it: choose, enter, pass_on or hand_off. */
  readonly part: GatedVerbPart;
  /** The offered choice it chose or entered (found once in the context); null for pass_on and hand_off. */
  readonly choice: Choice | null;
}

/** The turn as every limit reads it, inside the call's business scope (the Tool API base: CallContext). */
export interface GateTurn<Repo = unknown> {
  /** The gateAndCommit request: its caller, turn, core actions and the time the gate reads 'now' at. */
  readonly request: GateRequest;
  readonly context: Context;
  readonly decide: DecideResult;
  /** The call's repo, inside its transaction, scoped to `businessId` (row-level security: arch 10 line 546). */
  readonly repo: Repo;
  readonly businessId: string;
}

/**
 * What one limit says about one part:
 *   - pass: the limit holds;
 *   - notChecked: the part has nothing the limit applies to (K-08 v1 limitResult: "notChecked when the turn has nothing
 *     it applies to"), such as limit 5 on a part that reserves nothing;
 *   - fail: the limit fails and runs its own outcome (K-09 v1 `limitNOutcome`, one kind per action), which stops the
 *     part and what depends on it (arch 02 line 121). `fields` names the part's fields at fault by K-02 `field.name`,
 *     never their words: limit 6 names the fields whose values fail their words, which the gate answers as
 *     `valueFailsWords` while decide has not re-read (K-09 v1 rule rereadBeforeQuestion);
 *   - notBuilt: the limit's own task has not landed (stub.ts): the part is refused, never passed.
 */
export type LimitVerdict<N extends LimitNumber> =
  | { readonly result: "pass" }
  | { readonly result: "notChecked" }
  | { readonly result: "fail"; readonly outcome: LimitOutcomes[N]; readonly fields?: readonly string[] }
  | { readonly result: "notBuilt" };

/**
 * One of limits 1 to 6. A limit only reads (inside the call's scope) and says what it found; what its outcome writes
 * (a code, a question, a read-back) goes in the turn's one commit (arch 02 line 121), never here. A limit that throws
 * fails the whole call: nothing is written and nothing passes.
 */
export interface Limit<N extends LimitNumber, Repo = unknown> {
  readonly limit: N;
  check(part: GatePart, turn: GateTurn<Repo>): Promise<LimitVerdict<N>>;
}

/** Limits 1 to 6, each in its own slot (actions/src/gate/limits.ts). */
export type LimitRegistry<Repo = unknown> = readonly [
  Limit<1, Repo>,
  Limit<2, Repo>,
  Limit<3, Repo>,
  Limit<4, Repo>,
  Limit<5, Repo>,
  Limit<6, Repo>,
];

/**
 * What the gate did with one part (K-09 v1 `partResult`, before the commit):
 *   - passed: every limit passed or did not apply; the commit writes the choice's effects (then K-09's `committed`);
 *   - stopped: a limit failed with its outcome (`stoppedBy`);
 *   - dependsOnStopped: it acts on the booking a stopped part acts on, so it stops too (`dependsOnPart`);
 *   - asked: decide ended it in one question (K-02 `oneQuestion`, or the verb ask), nothing changes;
 *   - noAction: no_op, redact or none_fits, which commit nothing for the part;
 *   - refused: a limit not built yet refused it (`refusedBy`); the gate then refuses the whole call (LimitNotBuiltError).
 */
export type GatedResult = "passed" | "stopped" | "dependsOnStopped" | "asked" | "noAction" | "refused";

export interface GatedPart {
  /** The part's index in decide.parts. */
  readonly part: number;
  /** The choice it chose or entered, or null for another verb (K-09 v1 `partResult.choiceId`). */
  readonly choiceId: string | null;
  readonly result: GatedResult;
  /** Limits 1 to 6 in order, each pass, fail (with its outcome's action as a label) or notChecked. */
  readonly limits: readonly LimitResult[];
  /** For stopped, the limit that failed and its outcome; null otherwise. */
  readonly stoppedBy: LimitOutcome | null;
  /** For refused, the limit not built yet; null otherwise. */
  readonly refusedBy: LimitNumber | null;
  /** For dependsOnStopped, the stopped part it depends on; null otherwise. */
  readonly dependsOnPart: number | null;
}

/**
 * The gate's verdict on one turn:
 *   - refused: decide's output broke a K-02 v1 named rule (`decideRefused`), or a value failed its words before decide's
 *     one re-read (`valueFailsWords`); the call answers this error and nothing is written;
 *   - gated: one result per decide part, in order (no part is `refused`); the commit writes the passed parts.
 * A limit not built yet never gives a verdict: the gate throws LimitNotBuiltError instead (fail closed).
 */
export type GateVerdict =
  | { readonly verdict: "refused"; readonly error: GateRefusal }
  | { readonly verdict: "gated"; readonly parts: readonly GatedPart[] };
