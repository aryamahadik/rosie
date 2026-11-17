// Journey 1's listing (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): S1-09's lookupListing, the listing by
// name and town or from a card photo with banned words never shown, and saveSetupStep's S1-09 variant, the listing
// confirmed (gives business; S1-76's review item and S1-77's helper path are its branches). Not built: each handler
// answers notBuilt and writes nothing until its task (T-635) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "listing",
  entries: [
    { call: "lookupListing", handler: () => Promise.reject(new NotBuiltError("lookupListing")) },
    {
      call: "saveSetupStep",
      step: "S1-09",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
