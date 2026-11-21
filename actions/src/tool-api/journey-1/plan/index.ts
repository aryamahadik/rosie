// Journey 1's plan (T-630): S1-08 lays out the plan from the companies and pf.rules. It has no write of its own, so no
// K-09 v1 call or saveSetupStep variant is its (README "Journeys 1 and 2": S1-08 is read through readSetup, which
// after-live registers, or is a message only), and this folder registers no entry. Its task (T-634) builds it here.
//
// T-1482 (K-09 README defaults 181, 189 and 199 item (5); DL-999 card 13; DL-1033; DL-1074) builds S1-08's read-only step
// writer for the commit's walk (writer.ts planWriter): the plan's one quick reply to the owner, written only when the stop
// home lets Rosie text them (readStop and mayText on the stop reads handed in). The turn face binds it (T-1493, H1a):
// WalkDeps.writers at S1-08 as planWriter({ stop }), with the runtime side's stop reads. The folder's entries stay none.

import type { SetupFolder } from "../index";

export { PlanNotBuiltError, PlanRefusedError, type PlanFault, type PlanSeam } from "./errors";
export { PLAN_STEP, planWriter, type PlanWriterDeps } from "./writer";

/** This folder, as journey 1's lane lists it (../index.ts JOURNEY_1_LANE): no entry. */
export const FOLDER: SetupFolder<unknown> = {
  folder: "plan",
  entries: [],
};
