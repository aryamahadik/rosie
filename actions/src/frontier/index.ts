// The frontier (T-291; C-075): buildFrontier on the Tool API base, a closed list of choices assembled by code from
// pluggable sources over the turn's stored state, returned as K-02 v1's context. No model client is imported anywhere
// under actions/src/frontier (assemble/no-model-client.test.ts). See assemble/handler.ts and assemble/assemble.ts.

export { assemble, choiceIdOf, type Assembled } from "./assemble/assemble";
export { findStep, flowOfStep, ownStakes } from "./assemble/bundle";
export {
  MODEL_SCHEMA_ID,
  createFrontierChecker,
  defaultChecker,
  type FrontierChecker,
} from "./assemble/check";
export { DEFAULT_BUSINESS_LANGUAGE } from "./assemble/frame";
export {
  FrontierError,
  MAX_CHOICES,
  createBuildFrontierHandler,
  frontierHandlers,
  type FrontierFault,
  type FrontierOptions,
} from "./assemble/handler";
export { consoleSink, frontierLogger, type FrontierLogLine, type FrontierLogSink } from "./assemble/log";
export { FRONTIER_SOURCES, SLOT_NAMES } from "./assemble/registry";
export type {
  BuildFrontierAnswer,
  BuildFrontierRequest,
  DraftChoice,
  FrontierBundles,
  FrontierEvent,
  FrontierInput,
  FrontierLogger,
  FrontierRepo,
  FrontierSource,
  ReadTurnStateAnswer,
  SourceOffer,
  SourceSlot,
  TurnState,
  VisitTimesAnswer,
  VisitTimesRequest,
} from "./assemble/types";
export { OPEN_QUESTIONS, offerOpenQuestions, openQuestionsSource } from "./sources/open-questions";
