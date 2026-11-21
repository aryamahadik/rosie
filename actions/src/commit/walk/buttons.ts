// The buttons settler port (T-1491; K-09 README default 199, from T-1515; DL-1033 ruling 7; rule-onekind.json card 6 as
// check-onekind.json corrects it): read-only code for one plain step whose message carries buttons (S1-04) that answers,
// once the walk has built the rows before that step, whether the step is asked as today or walked with the rows it
// answers. The walk takes these settlers by step id from its binding (WalkDeps.buttonsSettlers), beside the question
// read, the step writers and T-1502's split settlers, and asks one only where default 199 says (writes.ts):
//   - where the walk would stop at a plain step with no branches whose message has buttons (walk.ts: such a step asks
//     someone), with a settler bound for that step, and no hold keeping that step back (writes.ts firstHeld, as for any
//     row the walk writes);
//   - once, after the rows before that step are built and before anything of that step is written;
//   - never at a step the walk starts from (an answered S1-04 option, default 181's path, goes on from S1-04's next),
//     nor at a split (T-1502's `settlers` stay split-only and untouched), nor for a part a hold keeps back.
//
// What the walk does with the answer:
//   - "ask": the step is asked exactly as writes.ts default 10 asks it today (its question and its quick reply), and the
//     walk stops there;
//   - the step's rows (a step writer's StepRows): the step is written as walked, its rows added in the walk's order as a
//     writer's are, a key the step does not give refused (givesNotStep), and the walk goes on from the step's next under
//     the same loop check and MAX_WALK (walk.ts Stretch.walkOn), each later step written as today, holds re-checked;
//   - anything else is refused (settledNotRows), and a settler that refuses or whose read fails leaves as it was thrown:
//     either way the call fails closed with nothing written, and the step is not asked either.
// With no buttons settler bound the walk is exactly today's, byte for byte. S1-04's own settler and the S1-02 wrapper
// that places the one pick are T-1492's (journey-1/companies), bound by T-1493 and T-1494.

import type { Choice, SetupKey } from "../../gate/framework";
import type {
  Ask,
  CommitTurnContext,
  EventEntry,
  OpenQuestionClose,
  OutboxRowNew,
  PassedPart,
  RowRef,
  StateWrite,
} from "../types";
import { WalkRefusedError } from "./errors";
import type { GraphStep } from "./graph";
import type { StepRows } from "./writes";

/**
 * The rows a walk has built for its part so far, as a buttons settler reads them (default 199): each list a copy, in the
 * walk's order (the answered question's close and the version it was read at; each walked step's rows by its writer).
 */
export interface RowsBuilt {
  readonly versionsRead: readonly RowRef[];
  readonly state: readonly StateWrite[];
  readonly stateEvents: readonly EventEntry[];
  readonly asks: readonly Ask[];
  readonly closes: readonly OpenQuestionClose[];
  readonly messages: readonly OutboxRowNew[];
  /** The keys given so far, each once, in the order first given. */
  readonly gives: readonly SetupKey[];
}

/** One ask of a plain step's buttons settler: on the call's transaction, inside its business scope. */
export interface ButtonsSettlerCall<Repo = unknown> {
  /** The call's repo, inside its transaction and business scope (CommitTurnContext.repo): read through, never written. */
  readonly repo: Repo;
  /** The call's business (CommitTurnContext.businessId), never a request value. */
  readonly businessId: string;
  /** The plain step the walk would stop at, as the turn's pinned graph holds it: no branches, buttons on its message. */
  readonly step: GraphStep;
  /** The part the gate passed. */
  readonly part: PassedPart;
  /** The offered choice the part chose or entered, as the walk's writers are handed it. */
  readonly choice: Choice;
  /**
   * The turn as the commit hands it to writesOf: the same object the walk hands every writer of this run as
   * `writer.turn`, so a settler, a writer and a writer's wrapper can share one read for the walk.
   */
  readonly turn: CommitTurnContext<Repo>;
  /** The rows built so far in this walk, before this step. */
  readonly rows: RowsBuilt;
}

/** What a buttons settler answers: "ask" (the step is asked as today), or the step's rows (it is walked). */
export type ButtonsSettled = "ask" | StepRows;

/**
 * One plain step's buttons settler: read-only, it answers "ask" or the step's rows, or refuses by throwing. It writes
 * nothing; what it throws fails the call closed, as a writer's refusal does.
 */
export type ButtonsSettler<Repo = unknown> = (call: ButtonsSettlerCall<Repo>) => Promise<ButtonsSettled>;

/** The buttons settlers by step id: the settler bound to `stepId`, or null when none is. */
export type ButtonsSettlers<Repo = unknown> = (stepId: string) => ButtonsSettler<Repo> | null;

/** The five lists a step writer's rows hold, each present (empty when it has none). */
const STEP_ROWS_LISTS: readonly (keyof StepRows)[] = ["state", "stateEvents", "gives", "asks", "messages"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether an answer has a step writer's shape: an object whose five lists are each present as a list. */
function isStepRows(value: unknown): value is StepRows {
  return isRecord(value) && STEP_ROWS_LISTS.every((list) => Array.isArray(value[list]));
}

/**
 * Asks `settler` once at `call.step` and checks its answer: "ask", word for word, or rows in a step writer's shape. Any
 * other answer is refused (settledNotRows), naming the step alone, never the answer. What the settler throws leaves as
 * it was thrown. Whether the rows give only the step's own keys is the walk's check (givesNotStep), as for a writer's.
 */
export async function buttonsAnswer<Repo>(
  settler: ButtonsSettler<Repo>,
  call: ButtonsSettlerCall<Repo>,
): Promise<ButtonsSettled> {
  const answered: unknown = await settler(call);
  if (answered === "ask") return "ask";
  if (isStepRows(answered)) return answered;
  throw new WalkRefusedError("settledNotRows", [call.step.id]);
}
