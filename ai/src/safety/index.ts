// The safety read (T-365, C-113): read.ts for the read itself (Haiku, then Sonnet, 2 s each, outside the AI gateway),
// prompt.ts for its cached system prompt and the per-call part, schema.ts for K-02's model-facing schema and the check
// of an answer, wire.ts for the one Messages API exchange. The danger-word lift and the 4 s marker's danger words are
// T-366's; what the actor does with a verdict is T-246's.

export {
  SAFETY_EFFORT,
  SAFETY_MODEL_ORDER,
  SAFETY_TRY_MS,
  SAFETY_VERDICT_MS,
  createSafetyReader,
  heldOutcomes,
} from "./read";
export {
  DATA_RULE,
  ESCAPE_NOTE,
  ROLE_SENTENCE,
  SAFETY_EXAMPLES,
  SAFETY_READ_PROMPT,
  SAFETY_READ_PROMPT_TEXT,
  SAFETY_READ_PROMPT_VERSION,
  answerText,
  exampleText,
  safetyReadPromptText,
  safetyReadTurn,
  type SafetyExample,
} from "./prompt";
export {
  SAFETY_READ_DEF,
  SAFETY_READ_SCHEMA,
  bundleLocalDefinition,
  isSafetyRead,
  safetyReadProblems,
} from "./schema";
export { exchange, NO_USAGE, type Exchange } from "./wire";
export {
  NOT_DANGER_TENSES,
  SAFETY_OUTCOMES,
  SAFETY_SOURCES,
  TENSES,
  type DangerWordMatch,
  type ModelCall,
  type SafetyLabel,
  type SafetyOutcome,
  type SafetyRead,
  type SafetyReadAnswer,
  type SafetyReadCallOptions,
  type SafetyReadInput,
  type SafetyReader,
  type SafetyReaderOptions,
  type SafetyResult,
  type SafetySource,
  type SafetyTry,
  type Tense,
} from "./types";
