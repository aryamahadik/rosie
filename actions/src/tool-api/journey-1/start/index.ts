// Journey 1's sign-up start (T-630): the owner's mobile on screen 0, the contact add, then the chat link whose ready text
// opens S1-01. S1-01 gives thread in its turn's own commit, the walking skeleton's gateAndCommit (T-315's turn face, which
// staging runs today: DL-867 item 2), and the chat link is issueChatLink, the shared core's; neither is a journey 1 or 2
// call, so this folder registers no entry and nothing here can stand in front of the skeleton's path. Its task (T-656)
// builds the start here.

import type { SetupFolder } from "../index";

/** This folder, as journey 1's lane lists it (../index.ts JOURNEY_1_LANE): no entry. */
export const FOLDER: SetupFolder<unknown> = {
  folder: "start",
  entries: [],
};
