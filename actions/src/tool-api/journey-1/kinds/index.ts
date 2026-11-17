// Journey 1's kinds of work (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): S1-02's matchKinds, the owner's
// words matched to the closest kinds, and saveSetupStep's S1-02 variant (gives kinds; S1-74's not_booked is one of its
// picks), and saveSetupStep's S1-03 variant (new work drafted for Rosie's team to review). Not built: each handler answers
// notBuilt and writes nothing until its task (T-633) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "kinds",
  entries: [
    { call: "matchKinds", handler: () => Promise.reject(new NotBuiltError("matchKinds")) },
    {
      call: "saveSetupStep",
      step: "S1-02",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
    {
      call: "saveSetupStep",
      step: "S1-03",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
