// Journey 1's plug-in per kind (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S1-11 variant,
// each kind's plug-in loaded into the business (the 11 pf keys, with C5's fills).
//
// T-634 part 1 (DL-961 card E; DL-988) builds S1-11's read-only step writer for the walk (./writer.ts, ./plug-in.ts):
// createPlugInWriters gives `plugIns`, which card F binds to S1-11 in the turn face (turn-face/commit.ts:566,
// createWritesOf's writers), and `kinds`, which card F wraps around S1-02's writer (T-633's) so S1-11 knows the picks the
// same walk gives. The registry entry below stays as T-630 made it: saveSetupStep's S1-11 variant alone (a page's, the
// console's or a job's call) answers notBuilt and writes nothing until its own card.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

export { PlugInRefusedError, type PlugInFault } from "./errors";
export {
  C5_FACTS_TRADE,
  C5_INSURANCE_FACTS,
  CONFIRM_AT,
  loadPlugIn,
  PF_TEXT_KEYS,
  type LoadedPlugIn,
  type PfTextKey,
  type PlugInBlock,
  type PlugInSettings,
} from "./plug-in";
export {
  createPlugInWriters,
  S1_11,
  type PickedKind,
  type PlugInBundles,
  type PlugInDeps,
  type PlugInWriters,
} from "./writer";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "plug-ins",
  entries: [
    {
      call: "saveSetupStep",
      step: "S1-11",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};
