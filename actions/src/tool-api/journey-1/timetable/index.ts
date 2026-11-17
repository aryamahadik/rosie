// Journey 1's class timetable (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S1-83 variant,
// a timetable photo's classes as sessions on the owner's yes (S1-82 checks whether the trade has classes). Not built: its
// handler answers notBuilt and writes nothing until its task (T-643) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "timetable",
  entries: [
    {
      call: "saveSetupStep",
      step: "S1-83",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
