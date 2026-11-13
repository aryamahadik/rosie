// The commit's runCore (C-087 with C-104; T-1140; K-09 v1 coreAction and coreResult): each core action a turn carries,
// run inside the turn's one commit by its shared-core service, in the request's order (commit.ts step 3, which hands each
// one what is open in force and adds the hold a safety outcome opens to what binds the core actions and parts after it).
//
//   - recordSafetyOutcome and releaseSafetyHold go through the safety service (T-318, domain/safety:
//     recordSafetyOutcomeCore and releaseSafetyHoldCore), with every port it reads handed through (DL-330, DL-341): K-34's
//     reads with the texts' arrival, the sealer, the pinned bundle's checked lines (with the core's line rule on top:
//     lines.ts), the plug-in's stop words and who is told. Each text of a turn carries its record, No included (K-09
//     README default 5; runtime/src/turn/turn.ts), and its answer's hold binds what follows it.
//   - Every other core action answers notBuilt (CoreNotBuiltError), as does a name K-09 v1 does not hold: M3b's other core
//     calls are each their own task. So does a safety call whose port is not wired yet (the service's NotBuiltError), and
//     a run that arms clock rows no question owns (a threat's pause call-offs, T-319's escalations): UnitWrites has no
//     list for them until T-1156, and none is ever dropped (DL-341). gateAndCommit then answers notBuilt, and nothing of
//     the turn is written.
//   - A refused core action stops only itself (K-09 v1 coreResult): its error comes back in its result and it writes
//     nothing. What K-09 has no answer for (the safety service's SafetyRefusedError, a fault) fails the turn, unchanged.
//
// runCore only reads, through the ports it is given, and hands back what the commit is to write: nothing is sent,
// charged, stored or told outside the one K-05 request, since a repeated turn runs it again before K-05 answers
// `repeated` (STATE note 1; types.ts CommitPorts). Nothing here logs.
//
// Defaults used (for ops/QUESTIONS.md), beside lines.ts's:
//   3. A core action rides in its turn's commit as the turn's own call (K-09 v1 coreAction: "with caller.kind turn"): its
//      caller is kind turn, with the turn row's id and trace id, or the turn is refused before the action runs
//      (CommitRefusedError callerNotTurn, turnIdMismatch, traceIdMismatch). The safety service checks the business (its
//      otherBusiness), and a release does not check the caller's kind itself (DL-330 note d), so the turn's own is checked
//      here.
//   4. A safety call whose port is not wired (the service throws NotBuiltError for that call or for handOff) answers the
//      commit's notBuilt, naming the core call (gap portNotWired) with the service's error as its cause, so the turn is
//      answered notBuilt like every port not built, rather than failing as a thrown error.

import type {
  SafetyCoreRun,
  SafetyDeps,
  SafetyLines,
  SafetyReader,
  SafetyTelling,
  StopWords,
  WordsSealer,
} from "../../domain/safety";
import { recordSafetyOutcomeCore, releaseSafetyHoldCore } from "../../domain/safety";
import { NotBuiltError, isCallName, type CallName, type Caller } from "../../tool-api";
import { CommitRefusedError } from "../errors";
import type { CommitPorts, CommitTurnContext, CoreAction, CoreRun } from "../types";
import { CoreNotBuiltError } from "./errors";
import { coreSafetyLines } from "./lines";

/**
 * The safety service's ports as runCore takes them (DL-341): each port it reads is given by the wiring, by name, never left
 * to the service's fail-closed default (K-34's reads, the sealer, the pinned bundle's lines, the plug-in's stop words, who
 * is told). The rest keep the service's defaults: T-317's and T-307's reads on the call's database transaction, the
 * Worker's keyed ids, no reach cards and no visits known.
 */
export type CoreSafetyDeps<Repo> = SafetyDeps<Repo> & {
  /** K-34's reads on the call's transaction, with each text's arrival (release.ts default 13). */
  readonly reader: (repo: Repo) => SafetyReader;
  /** Seals the read's words under the writer's key (db/repo/sealing.ts seal, on the call's transaction). */
  readonly sealer: (repo: Repo) => WordsSealer;
  /** The pinned bundle's checked lines; the core's line rule goes on top of them (lines.ts). */
  readonly lines: SafetyLines;
  /** The plug-in's stop words (A3-26): PLUGIN_LISTS_NO_STOP_WORDS for a plug-in known to list none, the barbershop's. */
  readonly stopWords: StopWords;
  /** Hand-offs and pages (T-319); NOT_TOLD_YET until they land, so an outcome that must tell someone answers notBuilt. */
  readonly telling: SafetyTelling;
};

/** What runCore runs with: each shared-core service's ports. */
export interface CoreDeps<Repo> {
  readonly safety: CoreSafetyDeps<Repo>;
}

/** The turn's own call (default 3): caller kind turn, with the turn row's id and trace id. */
function checkCaller(caller: Caller, turn: CommitTurnContext): void {
  if (caller.kind !== "turn") throw new CommitRefusedError("callerNotTurn");
  if (caller.turnId !== turn.turn.id) throw new CommitRefusedError("turnIdMismatch");
  if (caller.traceId !== turn.turn.traceId) throw new CommitRefusedError("traceIdMismatch");
}

/**
 * One safety call's run as the commit takes it: a port not wired answers notBuilt (default 4), and so does a run that arms
 * clock rows the turn's commit has no list for (DL-341), so none is dropped; otherwise its result and writes.
 */
async function committable(core: CallName, run: () => Promise<SafetyCoreRun>): Promise<CoreRun> {
  let ran: SafetyCoreRun;
  try {
    ran = await run();
  } catch (error) {
    if (error instanceof NotBuiltError) throw new CoreNotBuiltError(core, "portNotWired", error);
    throw error;
  }
  if (ran.clocks.length > 0) throw new CoreNotBuiltError(core, "clockRows");
  return ran.run;
}

/** The name of a core action K-09 v1 does not hold, or holds with no service yet: never the caller's own text. */
function notBuilt(action: { readonly call: unknown }): never {
  throw new CoreNotBuiltError(isCallName(action.call) ? action.call : null, "noService");
}

/**
 * The commit's runCore port (types.ts CommitPorts.runCore) over each shared-core service's ports: runCore(action, turn,
 * open) runs one K-09 v1 core action of the turn, handed what is open in force, and answers its K-09 v1 coreResult with
 * what the commit is to write. Throws CoreNotBuiltError (notBuilt) for a core action it cannot run yet.
 */
export function createRunCore<Repo>(deps: CoreDeps<Repo>): CommitPorts<Repo>["runCore"] {
  const safety: SafetyDeps<Repo> = { ...deps.safety, lines: coreSafetyLines(deps.safety.lines) };
  return async (action: CoreAction, turn, open) => {
    switch (action.call) {
      case "recordSafetyOutcome":
        checkCaller(action.request.caller, turn);
        return await committable(action.call, () => recordSafetyOutcomeCore(action, turn, open, safety));
      case "releaseSafetyHold":
        checkCaller(action.request.caller, turn);
        return await committable(action.call, () => releaseSafetyHoldCore(action, turn, open, safety));
      default:
        return notBuilt(action);
    }
  };
}
