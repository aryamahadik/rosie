// The composer (C-118, T-373): one Haiku call per outbox row, its K-03 v1.1 input in (slot facts and term facts), the
// row's K-03 message plan out (compose.ts), checked before it leaves the AI layer (check.ts), in K-03's own plan schema
// (schema.ts). Its system prompt is T-372's (prompt/).

export { COMPOSE_EFFORT, COMPOSE_ROLE, createComposer } from "./compose";
export {
  allowedFormatProblems,
  inputProblems,
  literalProblems,
  planAgainstInput,
  planProblems,
} from "./check";
export {
  CHANNELS,
  FORMATS,
  INPUT_FILE,
  LANGUAGE,
  LINE_ROLES,
  LINK_SLOTS,
  PLAN_DEF,
  PLAN_FILE,
  PLAN_SCHEMA,
  READER_ROLES,
  REACHES,
  SITUATIONS,
  SLOT_NAMES,
  SLOTTED_TEXT,
  TERM_FACT_SOURCE,
  TERM_FACT_VALUE,
  bundlePlanDefinition,
} from "./schema";
export {
  LITERAL_KINDS,
  REFUSAL_CHECKS,
  type ComposeAnswer,
  type ComposeCallOptions,
  type ComposeDown,
  type ComposeOk,
  type ComposeProblem,
  type ComposeRefused,
  type Composer,
  type ComposerOptions,
  type LiteralKind,
  type RefusalCheck,
} from "./types";
export {
  COMPOSER_PROMPT,
  composeInputText,
  type ComposeInput,
  type InputFact,
  type MessagePlan,
  type TermFact,
} from "./prompt";
