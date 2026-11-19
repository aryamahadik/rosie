// The commit's walk (C-087, T-1139): writesOf for bundle v0, the walk after a choice (arch 03 line 191) on the turn's
// pinned flow graph and each step's writes, as the commit's writesOf port (../types.ts CommitPorts). T-1141 binds it:
// `createWritesOf({ bundles })`, with the pinned bundle's flow graphs. T-1461 adds the answer to an open question's
// option: card F binds `questions` (the answered question's row, read on the call's transaction) and `writers` (the
// read-only step writers by step id). See writes.ts and walk.ts.

export { WalkNotBuiltError, WalkRefusedError, type WalkFault, type WalkSeam } from "./errors";
export {
  flowGraphOf,
  flowOfStep,
  type BranchTag,
  type Enclosing,
  type FlowGraph,
  type FlowLetter,
  type GraphBranch,
  type GraphCard,
  type GraphEffect,
  type GraphStep,
} from "./graph";
export { MAX_WALK, walkFrom, type Move, type Stop, type WalkStart, type Walked } from "./walk";
export {
  createWritesOf,
  firstHeld,
  stepHoldClass,
  textSourceOf,
  type BundleIdOf,
  type LiveQuestion,
  type StepRows,
  type StepWriter,
  type StepWriterCall,
  type StepWriters,
  type TextSource,
  type WalkBundles,
  type WalkDeps,
  type WalkQuestions,
  type WriterContext,
} from "./writes";
