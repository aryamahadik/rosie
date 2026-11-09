// The frontier's facts (T-295; C-075): each fact the context's choices need, once, from its one home, with its row and
// version, read strong (the primary, uncached); a second value for one key refused and its step flagged. See facts.ts.

export {
  factsFor,
  type Fact,
  type FactSource,
  type FactsAnswer,
  type FactsFault,
  type FactsInput,
  type FactsView,
  type FlaggedStep,
  type FrontierFactsOptions,
  type StepRead,
} from "./facts";
export {
  FactHomeError,
  NO_FACT_HOMES,
  factHomes,
  homeRowId,
  type FactHome,
  type FactHomes,
  type FactTarget,
  type HomeKind,
  type HomeRow,
} from "./homes";
export { needsIn, needsReader } from "./needs";
export {
  STRONG_READ,
  WeakReadError,
  isStrong,
  turnStateFactsPort,
  type FactRead,
  type FactRef,
  type FactsReadAnswer,
  type FactsReadPort,
  type FactsScope,
  type ReadMode,
} from "./read";
