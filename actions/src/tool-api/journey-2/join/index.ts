// Journey 2's join (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S2-05 variant, the person
// joining by their own ready text from the mobile the owner entered ("Says yes"), or S2-09's wrong-number path. In a turn
// the ready text rides as the core action saveSetupStepInTurn, which the commit runs, and S2-08's STOP is
// recordStopOrStart, the shared core's. Not built: its handler answers notBuilt and writes nothing until its task (T-659)
// gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../../journey-1/index";

/** This folder's entries, as journey 2's lane registers them (../index.ts JOURNEY_2_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "join",
  entries: [
    {
      call: "saveSetupStep",
      step: "S2-05",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
