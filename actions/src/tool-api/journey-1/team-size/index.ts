// Journey 1's team size and emergency contact (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's
// S1-78 variant, a solo owner's emergency contact with their own yes by texting (S1-70 asks who works with you). Not
// built: its handler answers notBuilt and writes nothing until its task (T-649) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "team-size",
  entries: [
    {
      call: "saveSetupStep",
      step: "S1-78",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
