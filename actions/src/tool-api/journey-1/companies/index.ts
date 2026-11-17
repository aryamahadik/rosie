// Journey 1's companies (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S1-04 variant, which
// kinds share one company (gives companies). Not built: its handler answers notBuilt and writes nothing until its task
// (T-634) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "companies",
  entries: [
    {
      call: "saveSetupStep",
      step: "S1-04",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
