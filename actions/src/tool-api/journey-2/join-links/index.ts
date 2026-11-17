// Journey 2's join links (T-630): S2-05's join link and QR per added person for the owner to pass on, and S2-07's owner
// told once at 48 hours. The link is issueChatLink, the shared core's call, and S2-07 is its 48-hour clock's firing, a
// gateAndCommit (K-09 v1 README "The shared core" and "Journeys 1 and 2"); neither is a journey 1 or 2 call, so this
// folder registers no entry. Its task (T-658) builds them here.

import type { SetupFolder } from "../../journey-1/index";

/** This folder, as journey 2's lane lists it (../index.ts JOURNEY_2_LANE): no entry. */
export const FOLDER: SetupFolder<unknown> = {
  folder: "join-links",
  entries: [],
};
