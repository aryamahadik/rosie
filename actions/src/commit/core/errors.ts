// What runCore throws when a core action cannot ride in the turn's commit yet (T-1140). Each is the commit's own notBuilt
// (CommitNotBuiltError, seam runCore): the Tool API base answers gateAndCommit `notBuilt` and rolls the call back, so
// nothing of the turn is written and no part commits (fail closed: types.ts CommitPorts). The message names the core
// call and why, both labels code made, never a person's words, a number or an address (K-08 v1), and never a call name
// that is the caller's own text (an unknown name: tool-api/errors.ts UnknownCallRefusal).

import type { CallName } from "../../tool-api";
import { CommitNotBuiltError } from "../errors";

/**
 * Why a core action is not built in a turn's commit:
 *   - noService: no shared-core service runs it yet (M3b's other core calls, each its own task), or its name is no K-09
 *     v1 call at all;
 *   - portNotWired: its service is built, but a port it reads is not wired yet (the service's own NotBuiltError: K-34's
 *     reads, the sealer, the plug-in's stop words, hand-offs and pages).
 * A run that arms clock rows no question owns is no longer one (T-1156 retired T-1140's clockRows gap): its clock rows
 * ride in its writes (UnitWrites.clocks), and the turn's commit writes each (DL-341: no clock is ever dropped).
 */
export type CoreGap = "noService" | "portNotWired";

/** A core action that cannot ride in this turn's commit yet: gateAndCommit answers notBuilt, with nothing written. */
export class CoreNotBuiltError extends CommitNotBuiltError {
  override name = "CoreNotBuiltError";
  /** The core action's call, or null when its name is no K-09 v1 call (the caller's text, never echoed). */
  readonly core: CallName | null;
  readonly gap: CoreGap;

  constructor(core: CallName | null, gap: CoreGap, cause?: unknown) {
    super("runCore");
    this.message = `gateAndCommit: the core action ${core ?? "(no K-09 v1 call)"} is not built yet (${gap}); nothing was written`;
    this.core = core;
    this.gap = gap;
    if (cause !== undefined) this.cause = cause;
  }
}
