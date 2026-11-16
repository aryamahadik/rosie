// The commit's runCore (C-087 with C-104 and C-078; T-1140, T-1163; K-09 v1 coreAction and coreResult): each
// core action a turn carries, run inside the turn's one commit by its shared-core service, in the request's order
// (commit.ts step 3, which hands each one what is open in force and adds the hold a safety outcome opens to what
// binds the core actions and parts after it).
//
//   - recordSafetyOutcome and releaseSafetyHold go through the safety service (T-318, domain/safety:
//     recordSafetyOutcomeCore and releaseSafetyHoldCore), with every port it reads handed through (DL-330, DL-341): K-34's
//     reads with the texts' arrival, the sealer, the pinned bundle's checked lines (with the core's line rule on top:
//     lines.ts), the plug-in's stop words and who is told. Each text of a turn carries its record, No included (K-09
//     README default 5; runtime/src/turn/turn.ts), and its answer's hold binds what follows it.
//   - recordStopOrStart and setRecordFlag go through the flags service (T-317, domain/flags: stopOrStartCore
//     and recordFlagCore), with the flags port the wiring hands in by name (CoreDeps.flags; DL-864): a STOP or
//     START text and a record flag commit in the turn's one commit, the STOP's reply row among its outbox rows
//     (named by its result's reply), and a pause's call-off clock rows in its writes.
//   - The clock rows a run arms that no question owns (a threat's pause call-offs, S11-62; a pause's,
//     flag-paused.json; T-319's escalations), which a service hands back beside its writes, are handed over in
//     them (UnitWrites.clocks; T-1156's withClocks), so the turn's one commit writes each with its event-log
//     entry and none is ever dropped (DL-341).
//   - Every other core action answers notBuilt (CoreNotBuiltError), as does a name K-09 v1 does not hold: M3b's
//     other core calls are each their own task. So does a call whose port is not wired yet (the service's
//     NotBuiltError, or no flags port bound). gateAndCommit then answers notBuilt, and nothing of the turn is
//     written.
//   - A refused core action stops only itself (K-09 v1 coreResult): its error comes back in its result and it
//     writes nothing. What K-09 has no answer for (the safety service's SafetyRefusedError, the flags service's
//     FlagRefusedError, a fault) fails the turn, unchanged.
//
// runCore only reads, through the ports it is given, and hands back what the commit is to write: nothing is sent,
// charged, stored or told outside the one K-05 request, since a repeated turn runs it again before K-05 answers
// `repeated` (STATE note 1; types.ts CommitPorts). It keeps nothing from one action to the next (the turn face
// builds it for each action: DL-864 note 4). Nothing here logs.
//
// Defaults used (for ops/QUESTIONS.md), beside lines.ts's:
//   3. A core action rides in its turn's commit as the turn's own call (K-09 v1 coreAction: "with caller.kind
//      turn"): its caller is kind turn, with the turn row's id and trace id, or the turn is refused before the
//      action runs (CommitRefusedError callerNotTurn, turnIdMismatch, traceIdMismatch). The safety service checks
//      the business (its otherBusiness), and a release does not check the caller's kind itself (DL-330 note d),
//      so the turn's own is checked here. So is each flags call's (DL-864 note 3), whose caller may name no
//      business while the turn's names one (the guard's replies: runtime/src/guard/replies/replies.ts; a STOP
//      covers every business).
//   4. A safety call whose port is not wired (the service throws NotBuiltError for that call or for handOff)
//      answers the commit's notBuilt, naming the core call (gap portNotWired) with the service's error as its
//      cause, so the turn is answered notBuilt like every port not built, rather than failing as a thrown error.
//      So does a flags call's: an address pause with no address sealer (record-flag.ts default 6), or a read the
//      wiring's port answers notBuilt.
//   5. The flags calls read through the wiring's flags port alone, each of its four ports handed in by name
//      (T-317's reads, T-307's reads, its ids and the handle actor's event sources: DL-864 note 1), never the
//      service's default reader on the call's transaction: under the Tool API's scope that transaction is
//      rosie_app, which has no grant on phones and sees no no-business consent row. With no flags port bound, or
//      one of the four left out, both calls answer notBuilt (gap portNotWired) before anything is read. Its other
//      ports keep T-317's defaults: no visit's time known (a pause arms no call-off clock: record-flag.ts default
//      7) and no address sealer (default 4 above).
//   6. A flags call whose caller names a business other than the call's is refused before anything is read
//      (CoreRefusedError otherBusiness; fail closed), as the safety service refuses its own (arch 10 line 546):
//      the wiring's port reads with no business scope (default 5), so the call's scope no longer bounds what such
//      a call would read and write. A caller that names no business is let through (default 3).
//   7. runCore hands back a flags call's result and writes alone (CoreRun): the STOP's reply row is named by its
//      result (reply.outboxRowId), which is where the commit's stopped-flag check reads it (T-317 note b, outside
//      this card).

import type {
  SafetyDeps,
  SafetyLines,
  SafetyReader,
  SafetyTelling,
  StopWords,
  WordsSealer,
} from "../../domain/safety";
import { recordSafetyOutcomeCore, releaseSafetyHoldCore } from "../../domain/safety";
import {
  recordFlagCore,
  stopOrStartCore,
  type EventSources,
  type FlagIds,
  type FlagsDeps,
  type FlagsReader,
} from "../../domain/flags";
import type { MessagesReader } from "../../domain/messages-consent";
import { NotBuiltError, isCallName, type CallName, type Caller } from "../../tool-api";
import { CommitRefusedError } from "../errors";
import type { ClockNew, CommitPorts, CommitTurnContext, CoreAction, CoreRun } from "../types";
import { CoreNotBuiltError, CoreRefusedError } from "./errors";
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

/**
 * The flags service's ports as runCore takes them (T-317's FlagsDeps; DL-864 note 1): each of the four it reads
 * with is given by the wiring, by name, never left to the service's default reader on the call's transaction
 * (default 5). The rest keep the service's defaults: no visit's time known, no address sealer.
 */
export type CoreFlagsDeps<Repo> = FlagsDeps<Repo> & {
  /** T-317's K-04 and K-29 reads with no business scope: the only side a phone and a no-business STOP row show on. */
  readonly reader: (repo: Repo) => FlagsReader;
  /** T-307's reads for the reply rows, on the same side (T-1414 reads them too). */
  readonly messagesReader: (repo: Repo) => MessagesReader;
  /** The ids of the rows the calls write, keyed by the turn (KEYED_IDS in the Worker). */
  readonly ids: FlagIds;
  /** The handle each replayed text's event came from (the handle actor's own record). */
  readonly events: EventSources;
};

/** What runCore runs with: each shared-core service's ports. */
export interface CoreDeps<Repo> {
  readonly safety: CoreSafetyDeps<Repo>;
  /**
   * The flags service's ports (DL-864): none bound until the turn face binds them (T-1413), so
   * recordStopOrStart and setRecordFlag answer notBuilt (portNotWired) and nothing is read or written (default 5).
   */
  readonly flags?: CoreFlagsDeps<Repo>;
}

/** The four ports the flags calls read with, each handed in by name (default 5). */
const FLAGS_PORTS = ["reader", "messagesReader", "ids", "events"] as const;

/** The turn's own call (default 3): caller kind turn, with the turn row's id and trace id. */
function checkCaller(caller: Caller, turn: CommitTurnContext): void {
  if (caller.kind !== "turn") throw new CommitRefusedError("callerNotTurn");
  if (caller.turnId !== turn.turn.id) throw new CommitRefusedError("turnIdMismatch");
  if (caller.traceId !== turn.turn.traceId) throw new CommitRefusedError("traceIdMismatch");
}

/** A flags call under the call's business, or naming none (default 6): never another business's. */
function checkBusiness(core: CallName, caller: Caller, turn: CommitTurnContext): void {
  if (caller.businessId !== null && caller.businessId !== turn.businessId) {
    throw new CoreRefusedError(core, "otherBusiness");
  }
}

/**
 * The flags port the wiring bound, as T-317's core functions take it (default 5): none bound, or one of its four
 * ports left out, answers notBuilt (portNotWired), so the service never falls back to its default reader on the
 * call's transaction.
 */
function flagsPortOf<Repo>(core: CallName, port: CoreFlagsDeps<Repo> | undefined): FlagsDeps<Repo> {
  if (port === undefined) throw new CoreNotBuiltError(core, "portNotWired");
  // As the wiring handed them in: a wiring that leaves one out (its type says it cannot) is not bound either.
  const given: Readonly<Record<(typeof FLAGS_PORTS)[number], unknown>> = port;
  if (FLAGS_PORTS.some((name) => given[name] === undefined || given[name] === null)) {
    throw new CoreNotBuiltError(core, "portNotWired");
  }
  return port;
}

/**
 * A core action's run with the clock rows its service armed beside its writes handed over in them (UnitWrites.clocks,
 * after any the writes already carry), so the turn's one commit writes each (T-1156; DL-341: none is ever dropped). A run
 * that arms none is handed on as it is.
 */
function withClocks(run: CoreRun, clocks: readonly ClockNew[]): CoreRun {
  if (clocks.length === 0) return run;
  return { ...run, writes: { ...run.writes, clocks: [...(run.writes.clocks ?? []), ...clocks] } };
}

/**
 * A service's run of one core action (the safety service's SafetyCoreRun, the flags service's RecordFlagCoreRun):
 * its result and writes, and the clock rows it arms that no question owns, beside them.
 */
interface ServiceRun {
  readonly run: CoreRun;
  readonly clocks: readonly ClockNew[];
}

/**
 * One safety or flags call's run as the commit takes it: a port not wired answers notBuilt (default 4); otherwise
 * its result and writes, with the clock rows it arms that no question owns handed over in them (withClocks).
 */
async function committable(core: CallName, run: () => Promise<ServiceRun>): Promise<CoreRun> {
  let ran: ServiceRun;
  try {
    ran = await run();
  } catch (error) {
    if (error instanceof NotBuiltError) throw new CoreNotBuiltError(core, "portNotWired", error);
    throw error;
  }
  return withClocks(ran.run, ran.clocks);
}

/** A STOP's or START's run as the commit takes it (default 7): its result and writes, and no clock row of its own. */
async function stopOrStartRun<Repo>(
  action: Extract<CoreAction, { call: "recordStopOrStart" }>,
  turn: CommitTurnContext<Repo>,
  flags: FlagsDeps<Repo>,
): Promise<ServiceRun> {
  const { result, writes } = await stopOrStartCore(action, turn, flags);
  return { run: { result, writes }, clocks: [] };
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
      case "recordStopOrStart": {
        checkCaller(action.request.caller, turn);
        checkBusiness(action.call, action.request.caller, turn);
        const flags = flagsPortOf(action.call, deps.flags);
        return await committable(action.call, () => stopOrStartRun(action, turn, flags));
      }
      case "setRecordFlag": {
        checkCaller(action.request.caller, turn);
        checkBusiness(action.call, action.request.caller, turn);
        const flags = flagsPortOf(action.call, deps.flags);
        return await committable(action.call, () => recordFlagCore(action, turn, flags));
      }
      default:
        return notBuilt(action);
    }
  };
}
