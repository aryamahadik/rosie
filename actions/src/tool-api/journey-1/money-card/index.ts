// Journey 1's money card (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S1-13 variant, each
// service's way before and after, or no money through Rosie (gives ways and stripe; S1-14 explains them back). Not built:
// its handler answers notBuilt and writes nothing until its task (T-642) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "money-card",
  entries: [
    {
      call: "saveSetupStep",
      step: "S1-13",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
