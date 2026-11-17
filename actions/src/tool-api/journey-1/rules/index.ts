// Journey 1's suggested rules (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S1-21 variant,
// the plug-in's rules as one tap list, each kept, changed or unticked (gives booking_rules and price_oks). Not built: its
// handler answers notBuilt and writes nothing until its task (T-644) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "rules",
  entries: [
    {
      call: "saveSetupStep",
      step: "S1-21",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
