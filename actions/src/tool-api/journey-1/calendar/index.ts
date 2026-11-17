// Journey 1's calendar status (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S1-24 variant,
// the calendar linked on a page already open, busy times from a schedule photo, or none booked yet (gives calendar). Not
// built: its handler answers notBuilt and writes nothing until its task (T-647) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "calendar",
  entries: [
    {
      call: "saveSetupStep",
      step: "S1-24",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
