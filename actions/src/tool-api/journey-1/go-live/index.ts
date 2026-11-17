// Journey 1's go-live check and going live (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's
// S1-32 variant, the ID upload and control read back for every trade, and its S1-35 variant, the business live with the
// notice by email only (gives live). Not built: each handler answers notBuilt and writes nothing until its task (T-653)
// gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "go-live",
  entries: [
    {
      call: "saveSetupStep",
      step: "S1-32",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
    {
      call: "saveSetupStep",
      step: "S1-35",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
