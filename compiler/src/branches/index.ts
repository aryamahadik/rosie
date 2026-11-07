// Branches: tags, gates, ends, answer fields, effects, layer lines and page types (T-145; compiler/src/branches).
import type { FlowLetter, MasterGraphs, StepId } from "../graph/types.ts";
import type { AppliedTrade } from "../overlay/apply";
import { compileBranches, type CompiledBranch } from "./branch";

export {
  ANSWER_TYPES,
  BranchError,
  CLOCK_LABEL,
  answerTypeOf,
  closedSplits,
  compileBranches,
  flowSwitches,
  rejoins,
  splitsWithoutRejoin,
  tagOf,
  type AnswerField,
  type AnswerType,
  type BranchReads,
  type BranchSource,
  type BranchStepSource,
  type BranchTag,
  type CompiledBranch,
} from "./branch";
export { branchEffects, type Effect, type EffectKind, type FlagName } from "./effects";
export { compileLayerLines, layerIdsOf, pageTypesOf, type PageType } from "./pages";

/** The master's branches for both flows, by split id. */
export function compileMasterBranches(
  master: MasterGraphs,
): Record<FlowLetter, Record<StepId, CompiledBranch[]>> {
  return { A: compileBranches(master.A.path), B: compileBranches(master.B.path) };
}

/** One trade's branches for one flow, from the applied flow (its own words and branches in, switched-off ones out). */
export function compileTradeBranches(applied: AppliedTrade): Record<StepId, CompiledBranch[]> {
  return compileBranches(applied.flow.steps);
}
