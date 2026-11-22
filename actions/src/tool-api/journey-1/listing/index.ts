// Journey 1's listing (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): S1-09's lookupListing, the listing by
// name and town or from a card photo with banned words never shown, and saveSetupStep's S1-09 variant, the listing
// confirmed (gives business; S1-76's review item and S1-77's helper path are its branches). The page path is not built:
// each handler answers notBuilt and writes nothing (K-09 README default 207), and this folder's entries stay so.
//
// T-635a (S1-09 design card 3; K-09 README defaults 200 to 208, DL-1124, DL-1133, DL-1138) builds S1-09 on the text path
// for the commit's walk: S1-09's settler (settle.ts, default 201, on default 191's port, WalkDeps.settlers) over the
// lookup (lookup.ts, default 202) and the optional banned-word read (default 206, bound nowhere: open gap 187); S1-09's
// read-only writer (writers.ts, default 204) over the reads open gap 193 asks for (reads.ts: item 79 and item 26); and
// S1-76's writer (writers.ts, default 205) with its review item's six fixed summaries (summary.ts, a leaf module the
// paging service's review.ts imports for its rule on a helper's claim). listingSteps builds the settler and both writers
// over one walk's readings, so they are bound together or not at all; the turn face (the ruling's card 7) binds them by
// step id, and staging's gate (card 8) hands in the Places port (the double, on allow-listed phones only: default 208).
// No photo (T-635b) and no S1-77 answer (T-635c) here.

import type { StepSettler } from "../../../commit/walk";
import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";
import { S1_09, walkReadings, s1_09Settler, type ListingReadingDeps } from "./settle";
import { listingWriters, type ListingWriterDeps, type ListingWriters } from "./writers";

export {
  ListingNotBuiltError,
  ListingReadError,
  ListingRefusedError,
  type ListingFault,
  type ListingReadFault,
  type ListingReadName,
  type ListingSeam,
} from "./errors";
export {
  candidateHolds,
  carriesBannedWord,
  foldMarks,
  holdsLetter,
  lookupListing,
  triesOf,
  type ListingSearch,
  type LookupFound,
  type NameAndTown,
} from "./lookup";
export {
  listingReadsOf,
  pgListingK05Reads,
  pgListingReads,
  type BusinessHead,
  type ListingK05Reads,
  type ListingReadRequest,
  type ListingReads,
  type TurnCompanyRequest,
} from "./reads";
export {
  BUSINESS,
  BUSINESS_FIELD,
  HELPS_RUN_IT,
  NO_MATCH,
  OWNER_MATCHES,
  S1_09,
  S1_76,
  businessWordsOf,
  claimOf,
  readS1_09,
  s1_09Settler,
  walkReadings,
  type AskReason,
  type BannedWords,
  type BannedWordsCall,
  type ListingReading,
  type ListingReadingDeps,
  type WalkReadings,
} from "./settle";
export {
  HELPER_LISTING_SUMMARIES,
  LISTING_REASONS,
  OWNER_LISTING_SUMMARIES,
  isOwnerListingSummary,
  listingSummaryOf,
  type ListingClaim,
  type ListingReason,
} from "./summary";
export {
  LISTING_MATCH_REVIEW,
  READ_BACK_LINE,
  listingWriters,
  type ListingWriterDeps,
  type ListingWriters,
} from "./writers";

/** What S1-09's settler and the two writers read with: the reading's ports and the writers' (each named there). */
export interface ListingStepsDeps<Repo = unknown> extends ListingReadingDeps<Repo>, ListingWriterDeps<Repo> {}

/** This folder's settlers by step id: S1-09's alone. */
export type ListingSettlers<Repo = unknown> = Readonly<Record<typeof S1_09, StepSettler<Repo>>>;

/** S1-09's settler and the S1-09 and S1-76 writers, over one walk's readings. */
export interface ListingSteps<Repo = unknown> {
  readonly settlers: ListingSettlers<Repo>;
  readonly writers: ListingWriters<Repo>;
}

/**
 * S1-09's settler and S1-09's and S1-76's writers over `deps`, sharing one walk's readings (settle.ts walkReadings, keyed
 * by the turn object the walk hands the settler as `turn` and each writer as `writer.turn`): the three are bound together
 * or not at all (defaults 201, 204 and 205). Building them reads nothing.
 */
export function listingSteps<Repo = unknown>(deps: ListingStepsDeps<Repo>): ListingSteps<Repo> {
  const readings = walkReadings<Repo>(deps);
  return {
    settlers: { [S1_09]: s1_09Settler(readings) },
    writers: listingWriters<Repo>(deps, readings),
  };
}

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "listing",
  entries: [
    { call: "lookupListing", handler: () => Promise.reject(new NotBuiltError("lookupListing")) },
    {
      call: "saveSetupStep",
      step: "S1-09",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
