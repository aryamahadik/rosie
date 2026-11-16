// Journey 1 after going live (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): readSetup, where the setup
// stands, each key given or missing, what is live, the team and who can be booked. No card names readSetup's builder;
// the README names its steps S1-50, S1-79 and S2-21 (with FS section 6.1's screens), and S1-50, "what is live", is this
// folder's, the first of them, so readSetup is registered here (T-630's default: the lead may move the entry by a card).
// S1-36's reminder, S1-37's MORE and S1-38's next kind have no write of their own. Not built: its handler answers notBuilt
// and reads nothing until its task (T-654) gives it its logic in this folder.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "after-live",
  entries: [{ call: "readSetup", handler: () => Promise.reject(new NotBuiltError("readSetup")) }],
};
