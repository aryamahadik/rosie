// The context bundle (T-367, C-114): what decide, the re-read and the planner see, built from K-02 v1's context and laid
// out by the prompt cache (T-364). See builder.ts for the layout and what is refused, tags.ts for tagged data (S13-54
// rule 67), seed.ts for the shuffle each read records.

export {
  MAX_CHOICES,
  PREAMBLE,
  RECENT_DAYS,
  RECENT_LIMIT,
  buildContextPrompt,
  readSpanFacts,
  type ContextPrompt,
  type ReadRequest,
} from "./builder";
export { ContextRefusedError } from "./errors";
export { SEED_LIMIT, drawSeed, isSeed, shuffled } from "./seed";
export { escapeAttribute, escapeData, unescapeData } from "./tags";
export { timeLabel } from "./times";
export type {
  AnswerField,
  Choice,
  ChoiceKind,
  ContextMoney,
  ContextTime,
  DecideContext,
  Fact,
  FactValue,
  OpenQuestion,
  Person,
  RecentMessage,
  Target,
  TurnText,
} from "./types";
