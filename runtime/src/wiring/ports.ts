// The walking skeleton's ports (T-550; C-046, C-044; build prompt section 10, D-017; ops/plan/02-contracts.md section 11):
// every outside call the Worker's gateway, the handle actor and the outbox dispatcher make, grouped into the eleven ports
// the composition root binds (./root.ts), in D-017's turn order. Each port's type is taken from the code that calls it
// (the runtime's own hand-written contract shapes), so a port and its caller cannot drift apart. Each join (T-552 to
// T-564) swaps one port's implementation, in the test environment and on staging (./picks.ts), for the real package:
//
//   port         what it carries                                                   joined by
//   linqVerify   K-11 verifyWebhook: the gateway's signature check and parse       T-552
//   sealing      the handle's sealing key: the gateway seals, the safety read      T-553
//                and the turn open
//   safetyRead   K-02's safety read on each raw text, on arrival                   T-554
//   turnRow      K-05's two calls that write a turn's one row (K-04 turns), once   T-555
//                per turn id: the commit (item 1) and the park (item 12)
//   stateReads   reads of stored state: the bundle (K-05 v1 item 7 and KV), the    T-556, T-557, T-562, T-564
//                guard's targets (K-05 v1.2), who a handle is, each text's safety
//                result, a recipient's chat and send state, a question's facts
//   turnFace     K-09's turn face (frontier, closest entries, gate and commit,     T-557, T-559, T-560
//                compose input) and the shared core the safety read calls
//   decide       K-02's two reads and the one Sonnet re-read                       T-558
//   composer     K-03's message plan and its one rewrite                           T-560
//   finalize     K-09 finalizeMessage: slots, fixed lines, the claim check and     T-561
//                the message checks
//   dataAccess   K-05 writes: the turn's plans, the outbox claim and marks, the     T-562, T-564
//                clock arming
//   linqSend     K-11 sendPart, and the checked safety line sent straight through  T-563
//                Linq while PostgreSQL is down
//
// Not ports: the HandleActor namespace (the gateway's door to each handle's actor and the clock arming's way to it, a
// binding the root is handed), the clock, and the wiring between the parts the root builds (the lease runs the turn loop;
// the turn wakes the dispatcher; the receipt door marks the part delivered and arms its clock). Not bound here: the
// guard's fixed replies (`setReplyDeps`), the clock firing (`setClockDeps`), the actor's copies (`setCopyDeps`) and the
// Stripe and calendar doors, none of which a D-017 hop runs.

import type { CommitTurnOutcome, CommitTurnRequest } from "@rosie/db/repo/commit-turn";

import type { ArmingOptions } from "../clocks/arming";
import type { ArmingData } from "../clocks/types";
import type { BundleDeps } from "../bundle/types";
import type { DispatchDeps } from "../dispatch/dispatcher";
import type { LinqPort as LinqSendCall, OutboxStore } from "../dispatch/types";
import type { SealingKeyStore } from "../gateway/seal";
import type { LinqPort as LinqVerifyCall } from "../gateway/types";
import type { HandleTargetsPort } from "../guard/types";
import type { DirectLineSender, SafetyCore, SafetyDeps, SafetyReadPort } from "../safety/types";
import type {
  ParkTurnAnswer,
  ParkTurnRequest,
  TurnComposer,
  TurnDecide,
  TurnDeps,
  TurnFace,
  TurnRows,
} from "../turn/types";

/** The eleven ports, in D-017's turn order (02-contracts section 11). */
export const PORTS = [
  "linqVerify",
  "sealing",
  "safetyRead",
  "turnRow",
  "stateReads",
  "turnFace",
  "decide",
  "composer",
  "finalize",
  "dataAccess",
  "linqSend",
] as const;

export type PortName = (typeof PORTS)[number];

/**
 * K-05's two calls that write a turn's one row in PostgreSQL (K-04 turns), each once per turn id (QUESTIONS.md NQ-RT-3's
 * default: the 60 s lease lives in the actor, and the row is written once, as committed or parked, never "leased"). The
 * turn id is the one the lease hashed from its batch's K-06 event ids (CQ-09; T-248 `turnIdOf`), so one batch is one row.
 */
export interface TurnRowPort {
  /**
   * K-05 v1.1 commitTurn (item 1; T-195): sent by the Tool API's gate and commit behind the lease's commit (C-087's
   * CommitPorts.commitTurn, which @rosie/actions takes when T-559 joins it), in the generated K-05 types that commit reads.
   */
  commitTurn(request: CommitTurnRequest): Promise<CommitTurnOutcome>;
  /** K-05 v1 parkTurn (item 12; T-197): the turn's park after a third lapse with no commit (T-253, ../turn/park.ts). */
  parkTurn(request: ParkTurnRequest): Promise<ParkTurnAnswer>;
}

/** Reads of stored state, by the part that reads them (K-04 rows through K-05, and the bundle store). */
export interface StateReads {
  /** K-05 v1 item 7 and the bundle KV: the pin's reads, and the active bundle id each webhook's trace names. */
  readonly bundles: BundleDeps;
  /** The safety read's: the ids K-09 calls name for a handle, the bundle's checked lines and danger words, the stopped flag. */
  readonly safety: Pick<SafetyDeps, "directory" | "bundle" | "isStopped">;
  /** K-05 v1.2 handleTargets: the guard's targets. */
  readonly targets: HandleTargetsPort;
  /** The turn's: who the handle is (K-04 handles, persons, roles, zone), and each text's safety result. */
  readonly turn: Pick<TurnDeps, "directory" | "safety">;
  /** The dispatcher's: a recipient's chat, and limit 8's send state (K-05 v1.2 sendState). */
  readonly dispatch: Pick<DispatchDeps, "recipients" | "sendState">;
  /** The clock arming's: an open question's facts, and the actor name of a handle. */
  readonly arming: Pick<ArmingOptions, "facts" | "directory">;
}

/** K-09's turn face less finalize (its own port), and the K-09 shared-core calls the safety read makes. */
export interface TurnFacePort extends Omit<TurnFace, "finalizeMessage"> {
  readonly safetyCore: SafetyCore;
}

/** K-09 finalizeMessage (T-313, C-093). */
export type FinalizePort = Pick<TurnFace, "finalizeMessage">;

/** K-05 writes. */
export interface DataAccess {
  /** K-05 v1 unplannedRows and writePlan: the turn's rows after its commit (its park is the turn-row port's). */
  readonly rows: Omit<TurnRows, "parkTurn">;
  /** K-05 v1.1 claimOutbox, renewClaim, markRow and markPart: the dispatcher's and the receipt door's. */
  readonly outbox: OutboxStore;
  /** K-05 v1 armClock and cancelClock: the clock arming's. */
  readonly clocks: ArmingData;
}

/** The Linq sends. */
export interface LinqSend {
  /** K-11 sendPart: each part the dispatcher sends. */
  readonly parts: LinqSendCall;
  /** A checked safety line straight through Linq while PostgreSQL is down (arch 11 line 566). */
  readonly direct: DirectLineSender;
}

/** One implementation of every port. */
export interface Ports {
  readonly linqVerify: LinqVerifyCall;
  readonly sealing: SealingKeyStore;
  readonly safetyRead: SafetyReadPort;
  readonly turnRow: TurnRowPort;
  readonly stateReads: StateReads;
  readonly turnFace: TurnFacePort;
  readonly decide: TurnDecide;
  readonly composer: TurnComposer;
  readonly finalize: FinalizePort;
  readonly dataAccess: DataAccess;
  readonly linqSend: LinqSend;
}
