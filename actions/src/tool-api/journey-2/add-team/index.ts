// Journey 2's team (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S2-02 variant, the team
// with their roles, each added as invited with the owner's tick (gives added). Not built: its handler answers notBuilt and
// writes nothing until its task (T-657) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../../journey-1/index";

/** This folder's entries, as journey 2's lane registers them (../index.ts JOURNEY_2_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "add-team",
  entries: [
    {
      call: "saveSetupStep",
      step: "S2-02",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
