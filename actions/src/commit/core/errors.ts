// What runCore throws when a core action cannot ride in the turn's commit (T-1140, T-1163). A core action not
// built yet is the commit's own notBuilt (CoreNotBuiltError: CommitNotBuiltError, seam runCore): the Tool API base
// answers gateAndCommit `notBuilt` and rolls the call back, so nothing of the turn is written and no part commits
// (fail closed: types.ts CommitPorts). A core action refused before it runs, where K-09 has no answer for it, fails
// the turn the same way, with nothing written (CoreRefusedError). The message names the core call and why, both
// labels code made, never a person's words, a number or an address (K-08 v1), and never a call name that is the
// caller's own text (an unknown name: tool-api/errors.ts UnknownCallRefusal).

import type { CallName } from "../../tool-api";
import { CommitNotBuiltError } from "../errors";

/**
 * Why a core action is not built in a turn's commit:
 *   - noService: no shared-core service runs it yet (M3b's other core calls, each its own task), or its name is no K-09
 *     v1 call at all; or, for sendFixedLine, a line no service sends in a turn yet, or an actor's send to record
 *     (core.ts default 8);
 *   - portNotWired: its service is built, but a port it reads is not wired yet (the service's own NotBuiltError:
 *     K-34's reads, the sealer, the plug-in's stop words, hand-offs and pages, an address pause's sealer), or no
 *     flags port is bound for recordStopOrStart, setRecordFlag and sendFixedLine (core.ts defaults 5 and 8; DL-864).
 * A run that arms clock rows no question owns is no longer one (T-1156 retired T-1140's clockRows gap): its clock rows
 * ride in its writes (UnitWrites.clocks), and the turn's commit writes each (DL-341: no clock is ever dropped).
 */
export type CoreGap = "noService" | "portNotWired";

/**
 * Why runCore refuses a core action before it runs, where K-09 v1 has no answer for it:
 *   - otherBusiness: a flags call's caller names a business other than the call's (core.ts default 6), as the
 *     safety service refuses its own (arch 10 line 546). A caller that names no business is never refused for it.
 */
export type CoreFault = "otherBusiness";

/** A core action refused before anything is read: the turn fails, and nothing of it is written. */
export class CoreRefusedError extends Error {
  override name = "CoreRefusedError";
  readonly core: CallName;
  readonly fault: CoreFault;

  constructor(core: CallName, fault: CoreFault) {
    super(`gateAndCommit: the core action ${core} was refused (${fault}); nothing was written`);
    this.core = core;
    this.fault = fault;
  }
}

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
