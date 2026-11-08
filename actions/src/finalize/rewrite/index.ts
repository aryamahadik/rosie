// The rewrite and fallback path (C-093, T-313): the parts code builds from a plan, one attempt's checks and what happens
// next, what the one rewrite is told, and the passed-on path. The finalize call that runs them is ../index.ts.

export { NOT_FILLED, checkAttempt, outcomeOf, problemFaults, type AttemptCheck } from "./attempt";
export { FinalizeNotBuiltError, FinalizeRefusedError, type FinalizeFault, type FinalizeSeam } from "./errors";
export { buildParts, type Built, type PartFaults, type PartsInput } from "./parts";
export { PASSED_ON_LINE, passedOnParts, passedOnReview, passedOnWords, withdrawRequest } from "./passed-on";
export { rewriteTold, type Told } from "./told";
export {
  PASSED_ON_REVIEW,
  type Attempt,
  type AttemptOutcome,
  type CalendarFile,
  type CancelClockAnswer,
  type CancelClockRequest,
  type Channel,
  type CheckOutcome,
  type CheckResult,
  type FinalParts,
  type FinalizeAnswer,
  type FinalizeDeps,
  type FinalizeError,
  type FinalizeNote,
  type FinalizeOutcome,
  type FinalizePorts,
  type FinalizeRequest,
  type FinalizeResponse,
  type FinalizeRow,
  type NotFound,
  type PassedOnReview,
  type Plan,
  type PlanLine,
  type PlanQuestion,
  type QuestionClock,
  type ReviewItemAnswer,
  type RowPlan,
  type RowRead,
  type RowState,
  type Send,
  type Transient,
  type WritePlanAnswer,
  type WritePlanRequest,
} from "./types";
