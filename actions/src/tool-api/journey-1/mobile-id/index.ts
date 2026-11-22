// Journey 1's owner mobile and ID upload (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's
// S1-10 variant, the owner's mobile proven by their own text and the ID upload that counts as the ID confirmed (gives
// id_checked and mobile; MC C9, C10). The owner email's code is sendProofCode and proveCode, the shared core's calls,
// never this folder's. The page path is not built: its handler answers notBuilt and writes nothing (the upload is not
// open: D4; K-09 README default 212).
//
// T-1533 (the plan's T-636 re-scoped as T-636a; S1-10 slice card S10-3; K-09 README defaults 210 and 211; DL-1167) builds
// S1-10 at the walk on the text path: its read-only writer (writer.ts, default 210) over the reads open gap 201 asks for
// (reads.ts: item 79 and item 26), and the secure link's minting (link.ts, default 211), whose plain link waits in the
// turn face's stage until the face's hold hands it to finalize (turn-face/held.ts HeldLinks). mobileIdSteps builds S1-09's
// settler, S1-09's and S1-76's writers and S1-10's writer over one walk's readings, so the four are bound together or not
// at all: S1-10's writer reads S1-09's reading and refuses without it (claimUnknown). Nothing binds them here (the S1-09
// design ruling's card 7 binds them in the turn face; not in signUpSteps).

import type { StepSettler, StepWriter } from "../../../commit/walk";
import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";
import { S1_09, S1_76, s1_09Settler, walkReadings } from "../listing/settle";
import { listingWriters } from "../listing/writers";
import type { ListingStepsDeps } from "../listing";
import { MOBILE_ID_STEP, mobileIdWriter, type MobileIdWriterDeps } from "./writer";

export {
  MobileIdNotBuiltError,
  MobileIdReadError,
  MobileIdRefusedError,
  type MobileIdFault,
  type MobileIdReadFault,
  type MobileIdReadName,
  type MobileIdSeam,
} from "./errors";
export {
  LINK_CODE_BYTES,
  LINK_CODE_FORM,
  LINK_LIFE_MS,
  LinkCodeError,
  codeSha256,
  isLinkPlace,
  linkLifeOf,
  mintCode,
  secureLinkOf,
  utcSecond,
  type LinkPlace,
} from "./link";
export {
  mobileIdReadsOf,
  pgMobileIdReads,
  type AccountOnFile,
  type AccountRequest,
  type MobileIdReads,
  type TurnHandle,
  type TurnHandleRequest,
} from "./reads";
export {
  MOBILE,
  MOBILE_ID_STEP,
  SECURE_LINK_LINE,
  SETUP_ID_CHECK,
  mobileIdWriter,
  type LinkStage,
  type MobileIdWriterDeps,
  type SecureLinkDeps,
} from "./writer";

/** What S1-09's settler, S1-09's and S1-76's writers and S1-10's writer read with (each named in its own file). */
export interface MobileIdStepsDeps<Repo = unknown> extends ListingStepsDeps<Repo> {
  /** S1-10's writer's ports: its reads, and the secure link's port (the stop reads are the listing's own). */
  readonly mobileId: Omit<MobileIdWriterDeps<Repo>, "stop">;
}

/** S1-09's settler, and the S1-09, S1-76 and S1-10 writers, over one walk's readings. */
export interface MobileIdSteps<Repo = unknown> {
  readonly settlers: Readonly<Record<typeof S1_09, StepSettler<Repo>>>;
  readonly writers: Readonly<Record<typeof S1_09 | typeof S1_76 | typeof MOBILE_ID_STEP, StepWriter<Repo>>>;
}

/**
 * S1-09's settler and S1-09's, S1-76's and S1-10's writers over `deps`, sharing one walk's readings (listing/settle.ts
 * walkReadings, keyed by the turn object the walk hands the settler as `turn` and each writer as `writer.turn`): the four
 * are bound together or not at all (defaults 201, 204, 205 and 210). Building them reads nothing.
 */
export function mobileIdSteps<Repo = unknown>(deps: MobileIdStepsDeps<Repo>): MobileIdSteps<Repo> {
  const readings = walkReadings<Repo>(deps);
  const listing = listingWriters<Repo>(deps, readings);
  const stop = deps.stop === undefined ? {} : { stop: deps.stop };
  return {
    settlers: { [S1_09]: s1_09Settler(readings) },
    writers: {
      ...listing,
      [MOBILE_ID_STEP]: mobileIdWriter<Repo>({ ...deps.mobileId, ...stop }, readings),
    },
  };
}

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "mobile-id",
  entries: [
    {
      call: "saveSetupStep",
      step: "S1-10",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
