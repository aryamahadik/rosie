// Journey 2's person licenses (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S2-11 and S2-29
// variants, each license kept as added, never looked up (gives license_checked; MC C4; S2-28 checks pf.license). Not
// built: each handler answers notBuilt and writes nothing until its task (T-661) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../../journey-1/index";

/** This folder's entries, as journey 2's lane registers them (../index.ts JOURNEY_2_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "licenses",
  entries: [
    {
      call: "saveSetupStep",
      step: "S2-11",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
    {
      call: "saveSetupStep",
      step: "S2-29",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
