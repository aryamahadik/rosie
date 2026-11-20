// Journey 1's kinds of work (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): S1-02's matchKinds, the owner's
// words matched to the closest kinds, and saveSetupStep's S1-02 variant (gives kinds; S1-74's not_booked is one of its
// picks), and saveSetupStep's S1-03 variant (new work drafted for Rosie's team to review).
//
// T-633 (DL-961 card D; DL-988; DL-994) builds them for the walk: S1-02's, S1-03's and S1-74's read-only step writers
// (writers.ts kindsWriters, over answer.ts and reads.ts), which card F binds by step id into the turn face; the S1-02
// call, matchKinds (match-kinds.ts createMatchKinds); their reads (reads.ts: item 78 as rosie_app, item 79 as rosie_job;
// kindsReadsOf over any binding of the two K-05 reads, pgKindsReads over two PostgreSQL clients); and the review item's
// plan for a new-work draft (writers.ts newWorkReviewPlan), which the later checklist card calls and no writer here does.
// Nothing here binds them: the folder's registry entries below still answer notBuilt and write nothing, as journey 1's
// registry (../index.ts) and its tests hold them, until the card that binds the setup calls.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

export {
  ALL_ON_THE_LIST,
  KINDS,
  NO_PATTERN_MET,
  NOT_A_SERVICE,
  ONE_NOT_LISTED,
  answerOf,
  draftedKindId,
  ownerWordsOf,
  type DraftedKind,
  type KindsAnswer,
  type KindsPick,
  type PickOutcome,
} from "./answer";
export {
  KindsNotBuiltError,
  KindsReadError,
  KindsRefusedError,
  type KindsFault,
  type KindsReadFault,
  type KindsReadName,
  type KindsSeam,
} from "./errors";
export { createMatchKinds, type MatchKindsDeps } from "./match-kinds";
export {
  kindsReadsOf,
  matcherOf,
  pgKindsK05Reads,
  pgKindsReads,
  type KindsK05Reads,
  type KindsReads,
  type MatcherOf,
} from "./reads";
export {
  DRAFTING,
  IN_REVIEW,
  KINDS_STEPS,
  NEW_WORK_REVIEW,
  REVIEW_SUMMARY,
  kindsWriters,
  newWorkReviewPlan,
  type DraftOnFile,
  type KindsStep,
  type KindsWriterDeps,
  type KindsWriters,
  type NewWorkReviewPlan,
} from "./writers";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "kinds",
  entries: [
    { call: "matchKinds", handler: () => Promise.reject(new NotBuiltError("matchKinds")) },
    {
      call: "saveSetupStep",
      step: "S1-02",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
    {
      call: "saveSetupStep",
      step: "S1-03",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
