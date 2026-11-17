// Journey 1's fee consent (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S1-25 variant,
// the owner's yes to Rosfield's fee kept as a fee_ok consent row with the exact words shown (S1-62 takes the $2 branch).
// Not built: its handler answers notBuilt and writes nothing until its task (T-650) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "fee-consent",
  entries: [
    {
      call: "saveSetupStep",
      step: "S1-25",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
