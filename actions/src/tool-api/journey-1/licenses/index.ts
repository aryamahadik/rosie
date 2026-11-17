// Journey 1's licenses (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S1-23 and S1-61
// variants, the license or registration kept as given, never checked (gives license; MC C4, C7; S1-60 picks which). Not
// built: each handler answers notBuilt and writes nothing until its task (T-638) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "licenses",
  entries: [
    {
      call: "saveSetupStep",
      step: "S1-23",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
    {
      call: "saveSetupStep",
      step: "S1-61",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
