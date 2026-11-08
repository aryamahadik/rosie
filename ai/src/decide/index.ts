// Decide, one read (T-368, C-115): read.ts for the read itself (step 1, then step 2 per part side by side, through the
// AI gateway), prompt.ts for its cached system prompt and each step's tail, schema.ts for the two steps' structured-output
// schemas cut from K-02, map.ts for the mapping into K-02's `decideRead`, check.ts for the validator a read passes before
// it leaves the AI layer. Two reads and their agreement are T-369's.

export { DECIDE_EFFORT, createDecideReader } from "./read";
export {
  DECIDE_EXAMPLES,
  DECIDE_PROMPT,
  DECIDE_PROMPT_TEXT,
  DECIDE_PROMPT_VERSION,
  ROLE_SENTENCE,
  decidePromptText,
  exampleText,
  stageOneTail,
  stageTwoTail,
  type DecideExample,
} from "./prompt";
export {
  FIELD_VERBS,
  MODEL_FILE,
  PART_DEF,
  PART_KEYS,
  STAGE1_SCHEMA,
  STAGE2_SCHEMAS,
  bundleContractDefinition,
  stage2Schema,
  type FieldVerb,
} from "./schema";
export { MAX_PARTS, asTyped, mapPart, readStageOne, type MappedPart, type StageOne } from "./map";
export {
  CHOOSE_KINDS,
  ENTER_KINDS,
  decidePartProblems,
  decideReadProblems,
  foundIn,
  isDecideRead,
  partRuleProblems,
  readProblems,
  ruleView,
  type RuleView,
} from "./check";
export { DecideRequestError } from "./errors";
export {
  DECIDE_PURPOSES,
  HAND_OFF_ABOUT,
  READ_ROLES,
  ROLE_OF,
  VERBS,
  type AskPart,
  type ChoosePart,
  type DecideCallOptions,
  type DecideContext,
  type DecidePart,
  type DecidePurpose,
  type DecideRead,
  type DecideReadAnswer,
  type DecideReadDown,
  type DecideReader,
  type DecideReaderOptions,
  type DecideReadOk,
  type DecideReadRefused,
  type DecideReadRequest,
  type EnterPart,
  type Field,
  type FieldValue,
  type HandOffAbout,
  type HandOffPart,
  type ModelCall,
  type ModelRole,
  type Money,
  type NoOpPart,
  type NoneFitsPart,
  type PartHead,
  type PassOnPart,
  type Read,
  type ReadRole,
  type RedactPart,
  type Time,
  type Verb,
} from "./types";
