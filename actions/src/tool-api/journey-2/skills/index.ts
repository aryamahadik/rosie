// Journey 2's skills (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S2-15 variant, skills,
// who OKs what, supervision and staff prices (gives team). Not built: its handler answers notBuilt and writes nothing
// until its task (T-662) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../../journey-1/index";

/** This folder's entries, as journey 2's lane registers them (../index.ts JOURNEY_2_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "skills",
  entries: [
    {
      call: "saveSetupStep",
      step: "S2-15",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
