// Journey 2's on call (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S2-27 variant, who is on
// call for work sent now, and its S2-31 variant, nobody on call (gives on_call; S2-30 checks pf.services). Not built: each
// handler answers notBuilt and writes nothing until its task (T-663) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../../journey-1/index";

/** This folder's entries, as journey 2's lane registers them (../index.ts JOURNEY_2_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "on-call",
  entries: [
    {
      call: "saveSetupStep",
      step: "S2-27",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
    {
      call: "saveSetupStep",
      step: "S2-31",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
