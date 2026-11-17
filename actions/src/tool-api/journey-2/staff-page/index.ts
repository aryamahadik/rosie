// Journey 2's staff page (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S2-06 variant, each
// person's own profile from their staff page (gives profile). Not built: its handler answers notBuilt and writes nothing
// until its task (T-660) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../../journey-1/index";

/** This folder's entries, as journey 2's lane registers them (../index.ts JOURNEY_2_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "staff-page",
  entries: [
    {
      call: "saveSetupStep",
      step: "S2-06",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
