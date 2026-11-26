// The walk after a choice (T-1139; arch 03 line 191: "Code's walk after a choice stops at the first step that asks
// someone, waits on a clock or event, or ends the journey. The compiler rejects loops"). From where the part's choice
// starts it (a door's or an any-time row's step entered, or a split's branch chosen), code follows the pinned flow graph
// (K-01 v1) one path, in order:
//
//   - a plain step is walked (its own writes apply: its gives) and the walk goes on to its next;
//   - a plain step whose message carries buttons asks someone, its question being those buttons (T-1461; DL-965's lead
//     note: S1-04 in bundle v1), so the walk stops there and never walks past it; one with no buttons is walked on;
//   - a plain step walked whose gives hold a key only an event gives (T-1532; K-09 README default 209: EVENT_ONLY_KEYS,
//     id_checked alone) is walked as any plain step is, and the walk stops right after it, waiting on that event
//     (waitsOnEvent): its next is not read in that turn;
//   - a split stops the walk: one with a message branch asks someone, one with a clock branch waits on a clock; one whose
//     branches are all lookups is settled by code from a field it reads, which the walk does not read yet (notBuilt);
//   - a chosen branch is taken (its effects apply: what the choice causes, read by the compiler from the branch's own
//     steps), then its own steps are walked in order, as plain steps are (T-1461: their own writes are the branch's
//     effects), each stopping the walk where a step on a list would, then it goes on: an ending branch ends the path
//     with its end text, a merging one rejoins at its rejoinAt or its split's next;
//   - where a list ends (next null), its section's main path ends the journey, and a branch's list goes where its branch
//     goes.
//
// It only reads the graph: what each step writes is writes.ts's. A step the pinned bundle does not hold is refused, never
// guessed (K-01 README: "a step a bundle does not hold is not reachable"), with one documented default below.
//
// A walk in stretches (T-1491; K-09 README default 199): where a stretch stops at a plain step whose message carries
// buttons, writes.ts may ask that step's bound buttons settler (buttons.ts) once the rows before it are built; when the
// settler answers the step's rows, the walk goes on past it (Stretch.walkOn): the step counts as walked, and the next
// stretch starts at its next as the walk on from any plain step does, under the same loop check and MAX_WALK, so a step
// met again in a later stretch is refused (loop) and every stretch's steps count toward the one cap. walkFrom is the
// first stretch alone, exactly as before.
//
// A plain step's button answered (T-1480; K-09 README default 181; the S1-04 design ruling's card 11, DL-999): an open
// question's option at a step that is no split starts the walk at that step (WalkStart "button", which writes.ts gives
// an option once it reads the step in the turn's pinned graph). Its branch must be one of the step's button labels in
// that graph, word for word (graph.ts buttonLabels), else the part is refused (branchNotInBundle) with nothing walked.
// The step is applied as answered (a step move naming the button: writes.ts closes its question and writes its gives,
// never its message again), and the walk goes on from its next, as from any plain step walked, so it never stops at the
// answered step and no buttons settler is asked there (default 199).
//
// The wait at an event step (T-1532; K-09 README default 209; S1-10 slice card S10-2, DL-1151): a table lists the keys
// a turn never gives (EVENT_ONLY_KEYS: id_checked alone, given only when the owner's ID upload lands on the secure page,
// never in a chat: MASTER-FLOW-A line 183, MC C10). Where the walk applies as a move a plain step with no gate and no
// buttons (on a list, on a chosen branch, or in a later stretch after a buttons settler's: default 199) whose gives in
// the pinned graph hold a key of the table, the step is walked as any plain step is (its rows by its own writer:
// writes.ts default 9), and the walk stops right after it: the stop waitsOnEvent, naming the step and the table's keys it
// gives (arch 03 line 191: "waits on a clock or event"). Its next is never read in that turn, so a next the bundle does
// not hold (S1-75 in bundle v3) is neither reached nor refused; every step the walk does reach is still read from the
// pinned graph, and one the bundle does not hold is still refused (stepNotInBundle). The stop asks no one and starts no
// clock: writes.ts writes no question, question row or clock row for it, and a stretch that stops there has no walk on.
// The rule reads only the step's own gives and this table, the same for every bundle and step, and only ends a walk
// earlier, never later. A writer never gives a key of the table (writes.ts: eventKeyAtWalk).
//
// Defaults used (for ops/QUESTIONS.md):
//   1. An ending branch's own step that the bundle does not hold, when one of the branch's message effects names it, is
//      accounted for by that effect: the compiler reads a branch's effects from its own steps (a message per step that
//      tells someone, a record write per gives key, a charge, a calendar write: compiler/src/branches/effects.ts), and
//      the path ends after the branch's steps anyway. So S1-02's "Not a service we book" ends with its end text on bundle
//      v0, which does not hold S1-74 (ADR-013 section 6; DL-322 ruling 3), while "One isn't on the list yet" and "All on
//      the list", which merge at S1-11, are refused at S1-03 and S1-11. Any other step the bundle does not hold is
//      refused. Writing the answer still refuses such a step (writes.ts: an answer writes each step of its branch through
//      that step's writer), so this default tells where the path goes, never what it writes.
//   2. A step with its own gate (K-01 v1 step.when) is not walked yet: its gate reads the path, the plug-in and the
//      record (notBuilt). A chosen branch's own gate was the frontier's to read when it offered the branch.
//   3. (T-1480) The answered plain step's own gate is not read again, as an answered split's is not: the step was asked
//      before (the walk asks no gated step: default 2), and the frontier offered its buttons. Every step after it is
//      visited as any step walked is, its gate included.
//   4. (T-1532) The wait applies only where default 209 says, at a plain step with no gate and no buttons the walk
//      applies as a move. A gated step is still notBuilt (default 2), a split or a plain step with buttons still stops the
//      walk as it did (asks or waits), and the step a button start answers (default 181) or a buttons settler writes as
//      walked (default 199) carries buttons, so the walk goes on from it as before; their writers still never give a key
//      of the table (writes.ts: eventKeyAtWalk), so none of them gives id_checked either.
//   5. (T-1532) The stop names the table's keys the step gives in the order its gives list them (S1-10: id_checked), and
//      the walk reads nothing else of the event: who sends it and what writes it are the call's that gives the key
//      (README default 209: K-21 finishUpload), not the walk's.
//
// The text path's walk (T-1562; ruling T-1543 card B6 with K-01 v1.1's stop and K-09 v1.14 defaults 223 and 226 to 229,
// 234 and 235):
//
//   - the stop field (K-01 v1.1; default 228): a plain step's own `stop` is read before its buttons. An asks-by-words
//     step stops the walk asked (an "asks" stop: an open question with no options, writes.ts default 10's way), even
//     where a later line from Rosie carries buttons (a read-back's: R38), and no buttons settler is asked there. A
//     waits-on-event step is walked as a move and stops the walk right after it, waitsOnEvent naming the field's keys
//     (default 209's stop, read from the field). A step with no `stop` keeps default 209's table and default 214.
//   - the event table (default 223): EVENT_ONLY_KEYS, still a list of keys, holds id_checked and control_proven, each
//     with its one waiting step beside it (EVENT_TABLE: id_checked at S1-10, control_proven at S1-32), so no writer gives
//     either (writes.ts eventKeyAtWalk), and a reach settler's "wait" at S1-32 stops waitsOnEvent on control_proven.
//   - reach settlers (default 227; R1): where the walk reaches a split for which its caller says a reach settler is
//     bound (WalkOptions.reaches), it stops there before atSplit (a "reaches" stop) and its stretch takes the settler's
//     answer once (Stretch.reach): a branch label of that split, word for word, is taken as walked (the branch move
//     `reached`: writes.ts writes the split as a walked step, never as an answer), then its steps and where it goes, as
//     for a chosen branch; "wait", only at a split the event table lists, stops waitsOnEvent on that split's key with no
//     move of it; "ask" stops the walk asking that split (an "asks" stop, asked as writes.ts asks any step it stops at);
//     a label the split lacks, or "wait" at a split the table does not list, is refused (settledNotInBundle). With no
//     reach settler bound the split stops as today (atSplit).
//   - an asks-by-words answer (defaults 228 and 116; WalkStart "words"): the walk starts at that step, applied as
//     answered (a step move whose `answered` is null: writes.ts closes its question and writes its gives and its later
//     lines through its writer), then goes on from its next, as from any plain step walked.
//   - the waiting-step starts (defaults 226, 234 (1) and 235; WalkStart "event" and "resume"): the start names the
//     waiting step and its key, which must be a pair of the event table (else eventKeyAtWalk). From a waiting plain step
//     (S1-10) the walk goes on from its next with no move of the step, so nothing of it is written again; at a waiting
//     split (S1-32) it stops "reaches" again where a reach settler is bound (else as today, atSplit), and goes on from the
//     branch the settler answers, or waits again (waitsOnEvent, nothing written). The step's own gate is not read again,
//     as an answered step's is not (default 3): the walk stopped at it before. Which turn makes these starts, and the
//     writer lane, zone, service and business they carry, are A11's (writes.ts writerLaneOf).
//
// Defaults used (T-1562, for ops/QUESTIONS.md), after T-1532's:
//   6. A reach settler's "ask" stops the walk asking the split itself (an "asks" stop, whatever its branches' tags), so
//      the split is asked as writes.ts's asked() asks any step: S1-75 (san -> owner by text, with its card) is asked of
//      the owner; S1-32 (san -> out) is refused there, notBuilt recipient, as K-09 v1.14 default 225 says. "Today's
//      stop" (R1) read as atSplit would make S1-32's "ask" notBuilt lookup instead, against default 225.
//   7. "wait" and "ask" are reserved at every split, as settle.ts default 1 reserves "ask": no bundle holds a branch
//      labelled either. "wait" at a split the event table does not list is a label that split lacks (settledNotInBundle).
//   8. An event or resume start whose key and step are not a pair of the event table is refused, with nothing walked:
//      the walk never starts past a step that does not wait on that key. Its fault is eventKeyAtWalk, naming the step and
//      the key alone: the walk's fault list is K-09 v1.13 default 217's, each classed in tool-api/refusal.ts (outside
//      this card), so the start takes the event table's own final fault rather than a new one. (The gate never makes
//      such a start: the event input pairs them, `refuse-event-step-outside-table.json`, and the resume reads the
//      walk's own waiting step: A11.)
//   9. A waits-on-event field names the keys it lists (K-01 v1.1 `eventKey`: id_checked), in its order; the table is
//      read only for a step with no field, so a field's stop never falls back to the table.

import { WalkNotBuiltError, WalkRefusedError } from "./errors";
import type { FlowGraph, GraphBranch, GraphStep } from "./graph";

/** The most steps one walk follows before it is refused (walkTooLong): far past any path the master holds. */
export const MAX_WALK = 64;

/** One row of the event table (K-09 README default 223): a key only an event gives, and the one step that waits for it. */
export interface EventWait {
  readonly key: string;
  readonly step: string;
}

/**
 * The event table (T-1562; K-09 v1.14 README default 223, from default 209's): each key a turn never gives, with the one
 * step that waits for it.
 *   - `id_checked` waits at S1-10: given only when the owner's ID upload lands on the secure page (K-21 v1 finishUpload;
 *     K-22 v1 id_uploads), never in a chat (MASTER-FLOW-A line 183; MC C10);
 *   - `control_proven` waits at S1-32: given only by Rosie's team's done decision that proves control (K-09 v1
 *     decideReviewItem; defaults 205 and 215), waited on where S1-32's reach settler answers "wait" (default 227).
 * A key joins only by a later version naming its source and its waiting step.
 */
export const EVENT_TABLE: readonly EventWait[] = [
  { key: "id_checked", step: "S1-10" },
  { key: "control_proven", step: "S1-32" },
];

/**
 * The keys a turn never gives (T-1532; K-09 README default 209, widened by v1.14 default 223): each given only by an
 * event outside any chat, so a walked plain step with no stop field whose gives hold one ends the walk (waitsOnEvent),
 * and no writer may give one (eventKeyAtWalk). The event table's keys, in its order.
 */
export const EVENT_ONLY_KEYS: readonly string[] = EVENT_TABLE.map((row) => row.key);

/** The keys of the event-only table (EVENT_ONLY_KEYS) that `gives` holds, in the order `gives` lists them. */
export function eventKeysIn(gives: readonly string[]): string[] {
  return gives.filter((key) => EVENT_ONLY_KEYS.includes(key));
}

/** The key the event table has wait at step `stepId` (default 223), or null when no key waits there. */
export function waitingKeyAt(stepId: string): string | null {
  return EVENT_TABLE.find((row) => row.step === stepId)?.key ?? null;
}

/**
 * A waiting step's start (T-1562; K-09 v1.14 defaults 226, 234 (1) and 235): the walk goes on from the step that waits
 * on `key`, its key now given. A11 makes these starts; the walk only walks them.
 */
export type WaitingStart =
  /** An event turn's start: the event's own step, key and ref (K-09 v1.14 `gateAndCommit.event`). */
  | { readonly kind: "event"; readonly step: string; readonly key: string; readonly ref: string }
  /** The handle's next turn resuming a walk held at the step, its key now on file (default 235): no ref. */
  | { readonly kind: "resume"; readonly step: string; readonly key: string };

/** Where a choice starts the walk. */
export type WalkStart =
  /** A step entered: a door's, an any-time row's or a search entry's step (K-02 v1 choice.step). */
  | { readonly kind: "step"; readonly step: string }
  /** A branch chosen at a split: an open question's option or a hub's case (K-02 v1 choice.step and choice.branch). */
  | { readonly kind: "branch"; readonly step: string; readonly branch: string }
  /**
   * A plain step's button answered (T-1480; K-09 README default 181): an open question's option at a step that is no
   * split, its branch one of that step's button labels, word for word (K-02 v1 choice.step and choice.branch).
   */
  | { readonly kind: "button"; readonly step: string; readonly branch: string }
  /**
   * An asks-by-words step answered (T-1562; K-09 v1.14 default 228): an open question's option in default 116's shape
   * at a step whose stop in the pinned graph is asksByWords (K-01 v1.1). No label: the answer carries its fields.
   */
  | { readonly kind: "words"; readonly step: string }
  /** A waiting step's start (WaitingStart): an event's or a resume's, made by A11. */
  | WaitingStart;

/** What the walk applies, in order. */
export type Move =
  /**
   * A plain step walked, on a list or on a chosen branch: its own writes apply. On the step a button start answers
   * (T-1480), `answered` names the button: its question is closed and its gives written, its message not sent again. On
   * the step an asks-by-words answer starts at (T-1562), `answered` is null: its question is closed, and its gives and
   * its later lines are written, its line 0 not sent again.
   */
  | { readonly kind: "step"; readonly step: GraphStep; readonly answered?: string | null }
  /**
   * A branch taken: its effects apply (its own steps follow it, each a move of its own). `reached` (T-1562; default 227)
   * when a reach settler answered it where the walk reached the split: the split is written as walked, never as an
   * answer (no question closed, its tells kept); left out for a chosen branch.
   */
  | {
      readonly kind: "branch";
      readonly split: GraphStep;
      readonly branch: GraphBranch;
      readonly reached?: true;
    };

/** Where the walk stops. */
export type Stop =
  /**
   * A step that asks someone: a split with a message branch, a plain step whose message carries buttons (T-1461), a
   * plain step whose stop is asksByWords (T-1562), or a split whose reach settler answered "ask". Its question goes out,
   * and the walk waits for the answer.
   */
  | { readonly kind: "asks"; readonly step: GraphStep }
  /** A split a clock settles (a clock branch, no message branch). */
  | { readonly kind: "waits"; readonly step: GraphStep }
  /**
   * The walk waits on an event (T-1532; K-09 README default 209; T-1562): a plain step walked whose stop is waitsOnEvent,
   * or, with no stop field, whose gives hold a key of the table, is the walk's last move, its rows by its own writer, its
   * next not read; or a split whose reach settler answered "wait" (default 227), with no move of it. No question goes
   * out and no clock starts. `keys`: the field's keys, the table's keys the step gives, or the split's table key.
   */
  | { readonly kind: "waitsOnEvent"; readonly step: GraphStep; readonly keys: readonly string[] }
  /**
   * A split reached for which a reach settler is bound (T-1562; default 227): the walk asks the settler before atSplit
   * and takes its answer through the stretch's `reach`. Nothing of the split is written for the stop itself.
   */
  | { readonly kind: "reaches"; readonly step: GraphStep }
  /** An ending branch: the path stops with its end text. */
  | {
      readonly kind: "ends";
      readonly split: GraphStep;
      readonly branch: GraphBranch;
      readonly text: string | null;
    }
  /** The end of a section's main path: the journey ends. */
  | { readonly kind: "journeyEnds"; readonly step: GraphStep };

export interface Walked {
  readonly moves: readonly Move[];
  readonly stop: Stop;
}

/**
 * One stretch of a walk (T-1491; K-09 README default 199): its own moves and where it stops, and the walk on past the
 * stop when that is a plain step whose message carries buttons.
 */
export interface Stretch extends Walked {
  /**
   * The next stretch, once bound code settles the plain step this one stops at (its rows written as walked): from the
   * step's next, as the walk goes on from any plain step walked (a list's end climbs as `climb` does), under this walk's
   * loop check and MAX_WALK, so both stretches count as one walk. Null for any other stop. Called once: a second call
   * meets the step's next again, a loop.
   */
  readonly walkOn: (() => Stretch) | null;
  /**
   * The next stretch once the split this one stops at ("reaches") is answered by its reach settler (T-1562; default
   * 227): a branch taken as walked and walked on, a wait, or an ask. Null for any other stop. Called once.
   */
  readonly reach: ((answer: ReachAnswer) => Stretch) | null;
}

/** A reach settler's answer, as the walk takes it (T-1562; K-09 v1.14 default 227; reach.ts checks it first). */
export type ReachAnswer =
  /** A branch label of the split, word for word: taken as walked. */
  | { readonly kind: "branch"; readonly label: string }
  /** Only at a split the event table lists (S1-32): the walk waits on its key, nothing written. */
  | { readonly kind: "wait" }
  /** The split is asked, as the walk asks any step it stops at. */
  | { readonly kind: "ask" };

/** What the walk's caller tells it of the graph's splits (T-1562). */
export interface WalkOptions {
  /** Whether a reach settler is bound for the split `stepId` (default 227). Left out, none is. */
  readonly reaches?: (stepId: string) => boolean;
}

/** Default 1: an ending branch's message effect names the step the bundle does not hold. */
function accountedFor(branch: GraphBranch, stepId: string): boolean {
  return (
    branch.end === "end" &&
    branch.effects.some((effect) => effect.kind === "message" && effect.ref === stepId)
  );
}

/** The walk from `start` along the graph, to where it stops. Throws WalkRefusedError or WalkNotBuiltError. */
export function walkFrom(graph: FlowGraph, start: WalkStart, options: WalkOptions = {}): Walked {
  const { moves, stop } = walkStretchFrom(graph, start, options);
  return { moves, stop };
}

/**
 * The walk's first stretch from `start` along the graph (walkFrom's moves and stop), with the walk on past a plain step
 * with buttons it stops at (Stretch.walkOn), or past a split a reach settler answers (Stretch.reach). Throws
 * WalkRefusedError or WalkNotBuiltError, here or on a later stretch.
 */
export function walkStretchFrom(graph: FlowGraph, start: WalkStart, options: WalkOptions = {}): Stretch {
  const reaches = options.reaches ?? (() => false);
  /** The moves of the stretch being walked: each stretch takes its own and leaves the next an empty list. */
  let moves: Move[] = [];
  const walked = new Set<string>();

  /** One more step on the walk: refused when it comes back to a walked step or the walk runs past MAX_WALK. */
  const enter = (id: string): void => {
    if (walked.has(id)) throw new WalkRefusedError("loop", [id]);
    if (walked.size >= MAX_WALK) throw new WalkRefusedError("walkTooLong", [id]);
    walked.add(id);
  };

  const held = (id: string): GraphStep => {
    const step = graph.step(id);
    if (step === null) throw new WalkRefusedError("stepNotInBundle", [id]);
    return step;
  };

  /** A split stops the walk: it asks someone, or waits on a clock; a split code settles is not read yet. */
  const atSplit = (split: GraphStep): Stop => {
    if (split.branches.some((branch) => branch.tag === "message")) return { kind: "asks", step: split };
    if (split.branches.some((branch) => branch.tag === "clock")) return { kind: "waits", step: split };
    throw new WalkNotBuiltError("lookup", [split.id]);
  };

  /** A split stops the walk: a reach settler bound for it is asked first (default 227), else atSplit. */
  const atReachedSplit = (split: GraphStep): Stop =>
    reaches(split.id) ? { kind: "reaches", step: split } : atSplit(split);

  /**
   * One step entered: where it stops the walk (a split; a plain step whose stop asks by words, or, with none, whose
   * message carries buttons: its question is those buttons), or null when it is walked, applied as a move. A step walked
   * whose stop waits on an event, or, with no stop field, whose gives hold a key of the event-only table, is applied as a
   * move and then stops the walk (waitsOnEvent: default 209), so its next is never read.
   */
  const visit = (entered: GraphStep): Stop | null => {
    enter(entered.id);
    if (entered.gated) throw new WalkNotBuiltError("stepGate", [entered.id]);
    if (entered.split) return atReachedSplit(entered);
    // The step's own stop is read before its buttons (K-01 v1.1; default 228): a later line's buttons are a read-back's.
    const { stop } = entered;
    if (stop?.kind === "asksByWords") return { kind: "asks", step: entered };
    if (stop === undefined && entered.buttons > 0) return { kind: "asks", step: entered };
    moves.push({ kind: "step", step: entered });
    const keys = stop?.kind === "waitsOnEvent" ? stop.keys : eventKeysIn(entered.gives);
    return keys.length === 0 ? null : { kind: "waitsOnEvent", step: entered, keys };
  };

  /** From step `id` along its own list (each step's next), each plain step applied, to where the walk stops. */
  const from = (id: string): Stop => {
    let walking = held(id);
    for (;;) {
      const stop = visit(walking);
      if (stop !== null) return stop;
      if (walking.next === null) return climb(walking);
      walking = held(walking.next);
    }
  };

  /** Where a branch goes once its own steps are done: an ending one stops; a merging one rejoins. */
  const after = (split: GraphStep, branch: GraphBranch): Stop => {
    if (branch.end === "end") return { kind: "ends", split, branch, text: branch.endText };
    if (branch.flow !== null && branch.flow !== graph.flow)
      throw new WalkNotBuiltError("otherFlow", [split.id]);
    const rejoin = branch.rejoinAt ?? split.next;
    return rejoin === null ? climb(split) : from(rejoin);
  };

  /**
   * A branch taken: its effects, then its own steps in order, each walked as a step on a list is (what a plain one writes
   * is what the branch's effects name, which the compiler reads from it: T-1461), then where the branch goes.
   */
  const take = (split: GraphStep, branch: GraphBranch, reached = false): Stop => {
    moves.push(reached ? { kind: "branch", split, branch, reached } : { kind: "branch", split, branch });
    for (const id of branch.steps) {
      const own = graph.step(id);
      if (own === null) {
        if (accountedFor(branch, id)) continue;
        throw new WalkRefusedError("stepNotInBundle", [id]);
      }
      const stop = visit(own);
      if (stop !== null) return stop;
    }
    return after(split, branch);
  };

  /**
   * The list holding `step` ends with it (K-01 v1 step.next null: "the enclosing branch's end or rejoinAt decides"). On
   * its section's main path the journey ends; on a branch's list, the walk goes where that branch goes. Refused when no
   * split of the bundle lists it, two do, or it is not its branch's last step: the walk cannot tell where the path goes.
   */
  const climb = (step: GraphStep): Stop => {
    const holders = graph.enclosing(step.id);
    if (holders.length === 0 && graph.onMainPath(step.id)) return { kind: "journeyEnds", step };
    const [holder] = holders;
    if (holders.length !== 1 || holder?.branch.steps.at(-1) !== step.id) {
      throw new WalkRefusedError("pathNotInBundle", [step.id]);
    }
    return after(holder.split, holder.branch);
  };

  /**
   * A stretch that has stopped at `stop`, with the moves walked since the stretch before it; one that stops at a plain
   * step (its message carries buttons) can walk on from that step's next.
   */
  const stretch = (stop: Stop): Stretch => {
    const own = moves;
    moves = [];
    if (stop.kind === "reaches") return { moves: own, stop, walkOn: null, reach: reachOn(stop.step) };
    // An asks-by-words step is asked, never settled by a buttons settler (default 228).
    if (stop.kind !== "asks" || stop.step.split || stop.step.stop !== undefined) {
      return { moves: own, stop, walkOn: null, reach: null };
    }
    const settled = stop.step;
    return {
      moves: own,
      stop,
      walkOn: () => stretch(settled.next === null ? climb(settled) : from(settled.next)),
      reach: null,
    };
  };

  /**
   * A reached split's answer (default 227): a branch label of it, word for word, taken as walked and walked on; "wait",
   * only at a split the event table lists, a waitsOnEvent stop on its key with no move of it; "ask", the split asked.
   * Anything else is refused (settledNotInBundle), naming the split alone.
   */
  const reachOn =
    (split: GraphStep) =>
    (answer: ReachAnswer): Stretch => {
      if (answer.kind === "ask") return stretch({ kind: "asks", step: split });
      if (answer.kind === "wait") {
        const key = waitingKeyAt(split.id);
        if (key === null) throw new WalkRefusedError("settledNotInBundle", [split.id]);
        return stretch({ kind: "waitsOnEvent", step: split, keys: [key] });
      }
      const branch = split.branches.find((each) => each.label === answer.label);
      if (branch === undefined) throw new WalkRefusedError("settledNotInBundle", [split.id]);
      return stretch(take(split, branch, true));
    };

  /**
   * A waiting step's start (defaults 226 and 235): refused unless its key and step are a pair of the event table; from
   * a waiting plain step, on from its next with no move of it; at a waiting split, its reach settler asked again (else
   * as today). The step is entered, so a walk that comes back to it is a loop.
   */
  const resume = (start: WaitingStart): Stop => {
    if (!EVENT_TABLE.some((row) => row.key === start.key && row.step === start.step)) {
      throw new WalkRefusedError("eventKeyAtWalk", [start.step, start.key]);
    }
    const waiting = held(start.step);
    enter(waiting.id);
    if (waiting.split) return atReachedSplit(waiting);
    return waiting.next === null ? climb(waiting) : from(waiting.next);
  };

  /**
   * An asks-by-words step answered (default 228): refused unless the pinned graph holds it as a plain step whose stop is
   * asksByWords; else applied as answered, and the walk goes on from its next, as for a button answered.
   */
  const answerWords = (id: string): Stop => {
    const answered = held(id);
    if (answered.split || answered.stop?.kind !== "asksByWords") {
      throw new WalkRefusedError("branchNotInBundle", [answered.id]);
    }
    enter(answered.id);
    moves.push({ kind: "step", step: answered, answered: null });
    return answered.next === null ? climb(answered) : from(answered.next);
  };

  /**
   * A plain step's button answered (default 181): refused unless the step is no split and the branch is one of its
   * button labels in the pinned graph, word for word; else applied as answered, and the walk goes on from its next (a
   * list's end climbs, as for any plain step walked), so it never stops at the answered step.
   */
  const answer = (id: string, button: string): Stop => {
    const answered = held(id);
    if (answered.split || !answered.buttonLabels.includes(button)) {
      throw new WalkRefusedError("branchNotInBundle", [answered.id]);
    }
    enter(answered.id);
    moves.push({ kind: "step", step: answered, answered: button });
    return answered.next === null ? climb(answered) : from(answered.next);
  };

  if (start.kind === "step") return stretch(from(start.step));
  if (start.kind === "button") return stretch(answer(start.step, start.branch));
  if (start.kind === "words") return stretch(answerWords(start.step));
  if (start.kind === "event" || start.kind === "resume") return stretch(resume(start));
  const split = held(start.step);
  const branch = split.branches.find((each) => each.label === start.branch);
  if (branch === undefined) throw new WalkRefusedError("branchNotInBundle", [split.id]);
  enter(split.id);
  return stretch(take(split, branch));
}
