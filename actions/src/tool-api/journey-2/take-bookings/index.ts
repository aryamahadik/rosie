// Journey 2's take bookings (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S2-24 variant,
// each person told they can be booked on the owner's yes to S2-22 (gives staff_live; S2-23 asks again in the morning).
// S2-21's who can be booked where is read through readSetup, which journey 1's after-live registers. Not built: its
// handler answers notBuilt and writes nothing until its task (T-664) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../../journey-1/index";

/** This folder's entries, as journey 2's lane registers them (../index.ts JOURNEY_2_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "take-bookings",
  entries: [
    {
      call: "saveSetupStep",
      step: "S2-24",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
