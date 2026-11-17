// Journey 1's preview, terms and bill card (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's
// S1-29 variant, the terms accepted and the bill card saved (gives terms and bill_card; S1-31 keeps unsigned work
// offline). Not built: its handler answers notBuilt and writes nothing until its task (T-652) gives it its logic in this
// folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "go-live-page",
  entries: [
    {
      call: "saveSetupStep",
      step: "S1-29",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
