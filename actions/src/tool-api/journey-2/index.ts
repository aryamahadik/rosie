// Journey 2's Tool API folders (T-630; C-074; DL-867): one folder per call task of journey 2 (T-657 to T-664), each named
// as its task's May touch names it, so each task touches only its own folder and they run side by side (build prompt
// 3.5 (c)). Each folder gives its entries: saveSetupStep's journey 2 variants of K-09 v1 (README "Journeys 1 and 2: the
// setup calls"), each with its handler, which answers notBuilt and writes nothing until its task builds it. The registry
// that turns both journeys' entries into the base's handlers is ../journey-1's (setupHandlers, withSetupCalls), since
// saveSetupStep and readSetup are each one K-09 v1 call for both journeys; it takes this lane with journey 1's.

import type { SetupLane } from "../journey-1/index";
import * as addTeam from "./add-team";
import * as joinLinks from "./join-links";
import * as join from "./join";
import * as licenses from "./licenses";
import * as onCall from "./on-call";
import * as skills from "./skills";
import * as staffPage from "./staff-page";
import * as takeBookings from "./take-bookings";

/** Journey 2's folders, in the order of their tasks (T-657 to T-664). */
export const JOURNEY_2_LANE: SetupLane<unknown> = {
  lane: "journey-2",
  folders: [
    addTeam.FOLDER,
    joinLinks.FOLDER,
    join.FOLDER,
    staffPage.FOLDER,
    licenses.FOLDER,
    skills.FOLDER,
    onCall.FOLDER,
    takeBookings.FOLDER,
  ],
};
