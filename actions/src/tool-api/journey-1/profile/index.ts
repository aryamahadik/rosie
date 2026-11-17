// Journey 1's About us and photos (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S1-84
// variant (gives profile). Not built: its handler answers notBuilt and writes nothing until its task (T-645) gives it its
// logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "profile",
  entries: [
    {
      call: "saveSetupStep",
      step: "S1-84",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
