// Journey 1's owner mobile and ID upload (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's
// S1-10 variant, the owner's mobile proven by their own text and the ID upload that counts as the ID confirmed (gives
// id_checked and mobile; MC C9, C10). The owner email's code is sendProofCode and proveCode, the shared core's calls,
// never this folder's. Not built: its handler answers notBuilt and writes nothing until its task (T-636) gives it its
// logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

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
