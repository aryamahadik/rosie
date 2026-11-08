// The policy gate framework (C-080, T-298): decide's output checked, then limits 1 to 6 on each agreed part, each limit
// in its own folder (actions/src/gate/limit-N/) registered in actions/src/gate/limits.ts. See gate.ts.

export {
  CHOOSE_KINDS,
  DECIDE_VERBS,
  ENTER_KINDS,
  RULE_OF_CHECK,
  checkDecideOutput,
  findDecideProblems,
  type DecideCheck,
  type DecideProblem,
  type DecideWhy,
} from "./checks";
export { GateLimitError, LimitNotBuiltError, type LimitFault } from "./errors";
export {
  LIMIT_ACTIONS,
  LIMIT_NUMBERS,
  NOT_BUILT,
  VALUE_FAILS_WORDS,
  bookingOf,
  partResultOf,
  runGate,
} from "./gate";
export { notBuiltLimit } from "./stub";
export type {
  Choice,
  Context,
  DecidePart,
  DecideRefused,
  DecideResult,
  Decided,
  GatePart,
  GateRefusal,
  GateRequest,
  GateTurn,
  GateVerdict,
  GatedPart,
  GatedResult,
  GatedVerbPart,
  Limit,
  LimitNumber,
  LimitOutcome,
  LimitOutcomes,
  LimitRegistry,
  LimitResult,
  LimitVerdict,
  PartResult,
  SetupKey,
  ValueFailsWords,
} from "./types";
