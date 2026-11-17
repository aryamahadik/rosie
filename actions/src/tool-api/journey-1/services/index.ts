// Journey 1's services (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S1-12 variant, the
// services read from the owner's price-list photo or typed list (gives services). Not built: its handler answers notBuilt
// and writes nothing until its task (T-640) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "services",
  entries: [
    {
      call: "saveSetupStep",
      step: "S1-12",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
