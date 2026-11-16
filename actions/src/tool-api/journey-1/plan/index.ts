// Journey 1's plan (T-630): S1-08 lays out the plan from the companies and pf.rules. It has no write of its own, so no
// K-09 v1 call or saveSetupStep variant is its (README "Journeys 1 and 2": S1-08 is read through readSetup, which
// after-live registers, or is a message only), and this folder registers no entry. Its task (T-634) builds it here.

import type { SetupFolder } from "../index";

/** This folder, as journey 1's lane lists it (../index.ts JOURNEY_1_LANE): no entry. */
export const FOLDER: SetupFolder<unknown> = {
  folder: "plan",
  entries: [],
};
