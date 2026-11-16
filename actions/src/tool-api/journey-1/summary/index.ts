// Journey 1's one-page summary (T-630): S1-79 builds the summary from stored facts and sends its secure link. It has no
// write of its own (K-09 v1 README "Journeys 1 and 2": S1-79 is read through readSetup, which after-live registers, or is
// a message only), so this folder registers no entry. Its task (T-655) builds it here.

import type { SetupFolder } from "../index";

/** This folder, as journey 1's lane lists it (../index.ts JOURNEY_1_LANE): no entry. */
export const FOLDER: SetupFolder<unknown> = {
  folder: "summary",
  entries: [],
};
