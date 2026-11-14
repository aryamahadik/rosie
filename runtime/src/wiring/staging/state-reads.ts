// Staging's state reads (the D-017 path audit's SR: ops/reviews/D-017-path-audit/order_d017.txt line 42; T-1400). T-1257
// made this file with its final signature; T-1400 binds it and edits nothing else.
//
// T-1400 gives RootOptions.turnDirectory (../turn/types.ts TurnDirectory) over K-05 v1.11 item 52's readTurnParty, on one
// job-side client per call (part.db.runtime). handleDirectory and stoppedFlags are typed as the ports they feed only
// (../safety/types.ts HandleDirectory; ../real.ts StoppedFlagRead): no K-05 call names either read yet (K-05 README "What
// v1.10 does not name" and "What v1.11 does not name"), so they stay null on staging until a K-05 version names them.
// The bundle's safety lines are ./bundle-safety.ts's. Until then each is null, as the Worker's root has always handed:
// every read fails closed (../real.ts NoStateReadError naming it), so a run of a turn ends noDirectory with nothing
// opened, read or written. Nothing here reads a binding.

import type { HandleDirectory } from "../../safety/types";
import type { TurnDirectory } from "../../turn/types";
import type { StoppedFlagRead } from "../real";
import type { StagingPart } from "./part";

/** What T-1400's builder is handed: the env and the root's handle. */
export type DirectoryPart = StagingPart;

/** The state reads' RootOptions inputs this part owns, each null where it is not bound. */
export interface DirectoryInputs {
  readonly turnDirectory: TurnDirectory | null;
  readonly handleDirectory: HandleDirectory | null;
  readonly stoppedFlags: StoppedFlagRead | null;
}

/** None of the three bound: each read fails closed (NoStateReadError). */
export const NO_DIRECTORY_INPUTS: DirectoryInputs = Object.freeze({
  turnDirectory: null,
  handleDirectory: null,
  stoppedFlags: null,
});

/** RootOptions.turnDirectory, handleDirectory and stoppedFlags for staging: all null until T-1400 binds turnDirectory. */
export const stagingDirectories: (part: DirectoryPart) => DirectoryInputs = () => NO_DIRECTORY_INPUTS;
