// Journey 1's Stripe Connect (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S1-27 variant,
// the connected account in the business's own name (gives stripe). Not built: its handler answers notBuilt and writes
// nothing until its task (T-651) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "stripe-connect",
  entries: [
    {
      call: "saveSetupStep",
      step: "S1-27",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
