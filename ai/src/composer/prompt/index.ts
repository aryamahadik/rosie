// The composer's system prompt (T-372, C-119): prompt.ts for the cached system prompt and what it holds, examples.ts for
// its five worked examples, render.ts for how a row's input reads to the model (the per-turn part the composer sends).

export {
  COMPOSER_PROMPT,
  COMPOSER_PROMPT_TEXT,
  COMPOSER_PROMPT_VERSION,
  DATA_RULE,
  ESCAPE_NOTE,
  FACTS_RULE,
  LANGUAGE_RULE,
  MASTER_LINE_RULE,
  ROLE_SENTENCE,
  composerPromptText,
  exampleText,
} from "./prompt";
export { COMPOSER_EXAMPLES, type ComposerExample } from "./examples";
export { INPUT_TAGS, composeInputText, planText, type InputTag } from "./render";
export type {
  Audience,
  Channel,
  ComposeInput,
  ConversationMessage,
  Fact,
  Format,
  Inbound,
  InputTime,
  LineRole,
  LinkSlot,
  MessagePlan,
  OpenQuestion,
  Option,
  PlanLine,
  PlanQuestion,
  Reach,
  ReaderRole,
  Situation,
} from "./types";
