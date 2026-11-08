// Limits 1 to 6, registered in the order the gate runs them (C-080, T-298; arch 06 lines 299 to 309). Each lives in its
// own folder, actions/src/gate/limit-N/index.ts, exporting `limitN`: the fail-closed stub until its task (T-299 to
// T-304) replaces that one file, so this registry never changes when a limit lands. The type check below holds each slot
// to its own limit, 1 to 6, whatever repo each limit reads.
//
// The record flags are checked before them (T-317; arch 03 line 175: "checked by the gate"): actions/src/gate/flags puts
// the check in front of limit 1 in slot 1, so a paused person's booking work or a deceased booking's new charge stops
// there, waiting for the owner, and no limit runs for it. Slots 2 to 6 hold the limits themselves.

import { flagsFirst } from "./flags";
import type { LimitRegistry } from "./framework/types";
import { limit1 } from "./limit-1";
import { limit2 } from "./limit-2";
import { limit3 } from "./limit-3";
import { limit4 } from "./limit-4";
import { limit5 } from "./limit-5";
import { limit6 } from "./limit-6";

/** The flags, then limits 1 to 6, in order: the registry gateAndCommit's gate runs (framework/gate.ts runGate). */
export const LIMITS = flagsFirst([
  limit1,
  limit2,
  limit3,
  limit4,
  limit5,
  limit6,
]) satisfies LimitRegistry<never>;
