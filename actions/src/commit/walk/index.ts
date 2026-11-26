// The commit's walk (C-087, T-1139): writesOf for bundle v0, the walk after a choice (arch 03 line 191) on the turn's
// pinned flow graph and each step's writes, as the commit's writesOf port (../types.ts CommitPorts). T-1141 binds it:
// `createWritesOf({ bundles })`, with the pinned bundle's flow graphs. T-1461 adds the answer to an open question's
// option: card F binds `questions` (the answered question's row, read on the call's transaction) and `writers` (the
// read-only step writers by step id). T-1502 adds `settlers` (K-09 README default 191: a split's settler answers the
// branch from the owner's words, never the option decide named; T-1503 binds S1-02's). T-1491 adds `buttonsSettlers`
// (K-09 README default 199: a plain step with buttons that bound code settles is walked, not asked; T-1492 builds S1-04's
// one-kind settler, T-1493 binds it). T-1519 adds `chats` (K-05 v1.10 item 51's readChatHandle: S1-01 reuses the
// handle's own chat thread for the turn's chat instead of inserting a second one). T-1532 adds the wait at an event step
// (K-09 README default 209: EVENT_ONLY_KEYS, the stop waitsOnEvent and the refusal eventKeyAtWalk; nothing to bind).
// T-1562 (ruling T-1543 card B6; K-01 v1.1's stop; K-09 v1.14 defaults 223 and 226 to 229, 234 and 235) adds the stop
// field (graph.ts GraphStep.stop: asks-by-words stops and answers), `reachSettlers` (reach.ts: a split code settles where
// the walk reaches it, before atSplit), owner-lane asks and answers, the event table with control_proven (EVENT_TABLE),
// and the waiting-step starts (WalkStart "event" and "resume", with the writer call open to them: OpenStepWriter), which
// A11 makes; this card binds none of them. See writes.ts, buttons.ts, reach.ts, settle.ts and walk.ts.

export {
  buttonsAnswer,
  type ButtonsSettled,
  type ButtonsSettler,
  type ButtonsSettlerCall,
  type ButtonsSettlers,
  type RowsBuilt,
} from "./buttons";
export { WalkNotBuiltError, WalkRefusedError, type WalkFault, type WalkSeam } from "./errors";
export {
  REACH_ASKS,
  REACH_WAITS,
  reachAnswer,
  type ReachSettler,
  type ReachSettlerCall,
  type ReachSettlers,
} from "./reach";
export {
  isSplitStep,
  settledBranch,
  type StepSettler,
  type StepSettlerCall,
  type StepSettlers,
} from "./settle";
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
  type LineLanes,
  type StepStop,
  type WordsAnswerField,
} from "./graph";
export {
  EVENT_ONLY_KEYS,
  EVENT_TABLE,
  MAX_WALK,
  eventKeysIn,
  waitingKeyAt,
  walkFrom,
  walkStretchFrom,
  type EventWait,
  type Move,
  type ReachAnswer,
  type Stop,
  type Stretch,
  type WaitingStart,
  type WalkOptions,
  type WalkStart,
  type Walked,
} from "./walk";
export {
  createWritesOf,
  firstHeld,
  stepHoldClass,
  textSourceOf,
  type BundleIdOf,
  type LiveQuestion,
  type OpenStepWriter,
  type OpenStepWriterCall,
  type StartedWriterCall,
  type StepRows,
  type StepWriter,
  type StepWriterCall,
  type StepWriters,
  type TextSource,
  type WalkBundles,
  type WalkChats,
  type WalkDeps,
  type WalkQuestions,
  type WriterContext,
} from "./writes";
