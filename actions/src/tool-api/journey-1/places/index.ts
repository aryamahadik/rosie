// Journey 1's places (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S1-43 variant, where
// each service may be done and flow B's travel area. Not built: its handler answers notBuilt and writes nothing until its
// task (T-641) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "places",
  entries: [
    {
      call: "saveSetupStep",
      step: "S1-43",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
