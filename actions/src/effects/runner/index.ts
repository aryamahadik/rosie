// The effects runner core (C-109, C-036; T-323): claims due effect rows, calls each kind's port on the row's one
// idempotency key, tries network errors again up to 5 times in 10 minutes before that service's outage row, never tries
// a decline again, and records each result. See runner.ts.

export { epochOf, systemClock, utc } from "./clock";
export { endsInOutage, resultEntry, resultRequest, type TryRecord } from "./entry";
export { EffectsRunnerConfigError, EffectsRunnerError, type RowFailure } from "./errors";
export { DEFAULT_CLAIM_LIMIT, ENDED_MEMORY, RESULT_SENDS, createEffectsRunner } from "./runner";
export {
  CLAIM_MS,
  EFFECT_TRIES,
  EFFECT_WINDOW_MS,
  PORT_CALL_BUDGET_MS,
  TRY_SPACING_MS,
  claimLeavesBudget,
  nextTryAt,
} from "./schedule";
export type {
  ClaimEffectsError,
  ClaimEffectsRequest,
  ClaimEffectsResponse,
  ClaimedEffect,
  EffectRepo,
  EffectResultRequest,
  EffectSpans,
  EffectsRunner,
  EffectsRunnerDeps,
  EventEntry,
  RecordEffectResultError,
  RecordEffectResultResponse,
  Refusal,
  RowEnd,
  RowReport,
  RunReport,
  RunnerClock,
  SpanRefusedReport,
} from "./types";
