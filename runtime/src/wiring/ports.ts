// The walking skeleton's ports (T-550; C-046, C-044; build prompt section 10, D-017; ops/plan/02-contracts.md section 11):
// every outside call the Worker's gateway, the handle actor and the outbox dispatcher make, grouped into the twenty-one
// ports the composition root binds (./root.ts), in D-017's turn order. Each port's type is taken from the code that calls
// it (the runtime's own hand-written contract shapes), so a port and its caller cannot drift apart. Each join (T-552 to
// T-564) swaps one port's implementation, in the test environment and on staging (./picks.ts), for the real package:
//
//   port         what it carries                                                   joined by
//   linqVerify   K-11 verifyWebhook: the gateway's signature check and parse       T-552
//   sealing      the handle's sealing key: the gateway seals, the safety read      T-553
//                and the turn open
//   chatOpen     K-05 v1.7 openChatOnText: a number's text opens its chat at       T-1213
//                receipt, before its actor is reached
//   safetyRead   K-02's safety read on each raw text, on arrival                   T-554
//   turnRow      K-05's two calls that write a turn's one row (K-04 turns), once   T-555
//                per turn id: the commit (item 1) and the park (item 12)
//   bundles      K-05 v1 item 7's bundle reads (the active id and PostgreSQL's     T-556
//                copy; KV is the actor's own BUNDLES binding): the turn's pin, so
//                the guard's keyword list (K-01 lists.keywords), and the active id
//                each webhook's trace names
//   targets      K-05 v1.2 handleTargets: the guard's targets                      T-556
//   frontier     K-09 buildFrontier through @rosie/actions' turn face: the Tool     T-557
//                API base (its K-09 checks, the call's business scope, its span)
//                and the frontier over K-05 v1.2 readTurnState and the turn's
//                pinned bundle
//   stateReads   other reads of stored state: who a handle is, the safety read's   T-1242 on staging,
//                bundle lines and stopped flag (the clock arming's reads are the   each read failing
//                arming port's since T-564; each text's safety result is the       closed until a part
//                turn's own, read from its leased turn: ADR-015, T-1264)           of T-1154 binds it
//   turnFace     the rest of K-09's turn face (closest entries: meaning search)    no D-017 hop
//                and the shared core the safety read calls
//   decide       K-02's two reads and the one Sonnet re-read through @rosie/ai's   T-558
//                decider, one per bundle for both
//   gate         K-09 gateAndCommit through @rosie/actions' turn face: the gate    T-559
//                and one commit (K-05 commitTurn through the turn-row port),
//                under the turn id, on the turn's pinned bundle
//   composeInput K-09 composeInput through @rosie/actions' turn face: a committed  T-560
//                row's K-03 composer input, only what limit 7 lets its reader see,
//                never the frontier, its inbound text the words the turn's gate
//                request handed in
//   composer     K-03's message plan and its one rewrite through @rosie/ai's       T-560
//                composer, one per bundle for both
//   finalize     K-09 finalizeMessage: slots, fixed lines, the claim check and     T-561
//                the message checks
//   outbox       K-05 v1.2 claimOutbox, renewClaim, markPart and markRow: the      T-562
//                dispatcher's claim and marks, and the receipt door's mark
//   sendState    K-05 v1.2 sendState: limit 8's read of the recipient's send       T-562
//                state at send, and the chat the send goes to
//   dataAccess   K-05 writes: the turn's plans (the clock arming's writes are the  T-1242 on staging,
//                arming port's since T-564)                                        as stateReads
//   linqSend     K-11 sendPart: each part the dispatcher sends, through the Linq   T-563
//                line (@rosie/adapters' Linq double in a test)
//   arming       the clock arming at a part's first delivery receipt: K-05 v1      T-564
//                item 5's armClock and cancelClock, the question's facts the due
//                rule reads and where a handle's actor lives, split from
//                stateReads and dataAccess by T-564
//   linqDirect   the checked safety line sent straight through Linq while          no D-017 hop
//                PostgreSQL is down (arch 11 line 566), split from linqSend by T-563
//
// Beside them, the PostgreSQL-down path's two ports (T-1363; C-175; arch 11 'PostgreSQL down', line 566), kept apart from
// the twenty-one (`DOWN_PATH_PORTS`) so that D-017's list and its turn order stay as they are. Each carries a field of
// ../outage/db's DbOutageDeps that no port of the twenty-one carries; the root's `install()` joins them into
// `setDbOutageDeps` (T-1326; ./root.ts Root.outage) with the four fields it takes from the twenty-one (the probe over the
// bundles port's readActiveBundle, the sealing key store, the direct line and the safety read's directory):
//
//   port         what it carries                                                   joined by
//   stopOrStart  K-09 v1 recordStopOrStart for the actorOnReturn caller: each      no D-017 hop
//                STOP or START the handle actor took while PostgreSQL was down,
//                written on return (DbOutageDeps.core)
//   timerFire    the alerts of a safety timer due while PostgreSQL is down, fired  no D-017 hop
//                from the actor's copy with its address still sealed
//                (DbOutageDeps.timers); the address is opened only where the CTO
//                and the security reviewer rule (QUESTIONS.md CQ-101 (c))
//
// Not ports: the HandleActor namespace (the gateway's door to each handle's actor and the clock arming's way to it, a
// binding the root is handed), the clock, and the wiring between the parts the root builds (the lease runs the turn loop;
// the turn wakes the dispatcher; the receipt door marks the part delivered and arms its clock). Not bound here: the
// guard's fixed replies (`setReplyDeps`), the clock firing (`setClockDeps`), the actor's copies (`setCopyDeps`) and the
// Stripe and calendar doors, none of which a D-017 hop runs. The PostgreSQL-down path's deps (`setDbOutageDeps`) are
// bound from the ports by the root's `install()` (T-1326).

import type { CommitTurnOutcome, CommitTurnRequest } from "@rosie/db/repo/commit-turn";

import type { ArmingOptions } from "../clocks/arming";
import type { BundleDeps } from "../bundle/types";
import type {
  LinqPort as LinqSendCall,
  OutboxStore,
  RecipientDirectory,
  SendStateReader,
} from "../dispatch/types";
import type { SealingKeyStore } from "../gateway/seal";
import type { ChatOpenPort, LinqPort as LinqVerifyCall } from "../gateway/types";
import type { HandleTargetsPort } from "../guard/types";
import type { StopOrStartCore, TimerFirePort } from "../outage/db/types";
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

/** The twenty-one ports, in D-017's turn order (02-contracts section 11), the direct line, which no hop runs, last. */
export const PORTS = [
  "linqVerify",
  "sealing",
  "chatOpen",
  "safetyRead",
  "turnRow",
  "bundles",
  "targets",
  "frontier",
  "stateReads",
  "turnFace",
  "decide",
  "gate",
  "composeInput",
  "composer",
  "finalize",
  "outbox",
  "sendState",
  "dataAccess",
  "linqSend",
  "arming",
  "linqDirect",
] as const;

/**
 * The PostgreSQL-down path's two ports (T-1363; C-175), which no D-017 hop runs: K-09 recordStopOrStart on return and a
 * safety timer fired from the actor's copy. Kept apart from the twenty-one, each is picked in its own table
 * (./picks.ts DOWN_PATH_PICKS) and bound once beside them (./bind.ts).
 */
export const DOWN_PATH_PORTS = ["stopOrStart", "timerFire"] as const;

/** A port's name: one of D-017's twenty-one, or one of the PostgreSQL-down path's two. */
export type PortName = (typeof PORTS)[number] | (typeof DOWN_PATH_PORTS)[number];

/**
 * K-05's two calls that write a turn's one row in PostgreSQL (K-04 turns), each once per turn id (QUESTIONS.md NQ-RT-3's
 * default: the 60 s lease lives in the actor, and the row is written once, as committed or parked, never "leased"). The
 * turn id is the one the lease hashed from its batch's K-06 event ids (CQ-09; T-248 `turnIdOf`), so one batch is one row.
 */
export interface TurnRowPort {
  /**
   * K-05 v1.1 commitTurn (item 1; T-195): sent by the Tool API's gate and commit behind the lease's commit (C-087's
   * CommitPorts.commitTurn, which the gate port hands @rosie/actions' commit since T-559 joined it), in the generated K-05
   * types that commit reads.
   */
  commitTurn(request: CommitTurnRequest): Promise<CommitTurnOutcome>;
  /** K-05 v1 parkTurn (item 12; T-197): the turn's park after a third lapse with no commit (T-253, ../turn/park.ts). */
  parkTurn(request: ParkTurnRequest): Promise<ParkTurnAnswer>;
}

/**
 * Reads of stored state, by the part that reads them (K-04 rows through K-05). The bundle reads and the guard's targets
 * are ports of their own since T-556 joined them (`Ports.bundles`, `Ports.targets`), the dispatcher's send state since
 * T-562 joined it (`Ports.sendState`), and the clock arming's reads since T-564 joined it (`Ports.arming`). On staging
 * (T-1242) the port is real: each read over its own RootOptions input (./real.ts realStateReads), failing closed until
 * the part of T-1154 that binds it hands its reader in; a test binds its fake, production keeps it closed.
 */
export interface StateReads {
  /** The safety read's: the ids K-09 calls name for a handle, the bundle's checked lines and danger words, the stopped flag. */
  readonly safety: Pick<SafetyDeps, "directory" | "bundle" | "isStopped">;
  /**
   * The turn's: who the handle is (K-04 handles, persons, roles, zone). Each text's safety result is no state read: the
   * turn reads it from its leased turn, which the handle's own actor answers (ADR-015 sections 1 and 3; T-1264).
   */
  readonly turn: Pick<TurnDeps, "directory">;
}

/**
 * K-05 v1.2 sendState (T-562; item 28; NQ-RT-2): limit 8's read of a claimed row's recipient just before each send, and the
 * chat that same read gives the send (the phone's number, the thread's Linq chat id, the service Linq reports).
 */
export interface SendStatePort {
  readonly sendState: SendStateReader;
  readonly recipients: RecipientDirectory;
}

/**
 * K-09 buildFrontier (T-557): the turn's texts, its guard's targets and its pinned bundle give K-02's context, through
 * @rosie/actions' turn face, whose Tool API base records the call's one frontier span on the turn's trace (CQ-159). The
 * root tells the turn so (TurnFace.recordsFrontierSpan) where this port binds real.
 */
export type FrontierPort = Pick<TurnFace, "buildFrontier">;

/**
 * K-09 gateAndCommit (T-559): the turn's gate and its one commit under the turn id, through @rosie/actions' turn face, on
 * the turn's pinned bundle, its K-05 commitTurn through the turn-row port. The request comes with the service and Linq
 * chat id of the turn's last text on its turn (K-09 v1.5 default 135: the root copies them from that text's K-06 event).
 * The turn records the gate (one span per part, with its limits) and the commit itself, and the Tool API base records
 * neither (TURN_RECORDS_GATE; DL-376), so no flag is set for this hop.
 */
export type GatePort = Pick<TurnFace, "gateAndCommit">;

/**
 * K-09 composeInput (T-560): a committed outbox row's K-03 composer input through @rosie/actions' turn face, with only what
 * limit 7 lets its reader see and never the frontier, read under the call's business from K-05 v1.6 readOutboxRow and the
 * bundle the row was committed under; its inbound text is the words the turn's own gateAndCommit request handed in
 * (decided.context.texts, as the face holds them: T-1141's held.ts), sent as they are. The turn records the row's
 * fillAndChecks span and the Tool API base records none for this call (TURN_RECORDS_FILL_AND_CHECKS; DL-376), so no flag
 * is set for it.
 */
export type ComposeInputPort = Pick<TurnFace, "composeInput">;

/**
 * K-09's turn face less the frontier, the gate, compose input and finalize (each its own port), and the K-09 shared-core
 * calls the safety read makes. The frontier's span flag is the root's to set, from the frontier port's binding.
 */
export interface TurnFacePort extends Omit<
  TurnFace,
  "buildFrontier" | "gateAndCommit" | "composeInput" | "finalizeMessage" | "recordsFrontierSpan"
> {
  readonly safetyCore: SafetyCore;
}

/**
 * K-09 finalizeMessage (T-561; T-313, C-093): a committed outbox row's plan through @rosie/actions' turn face, read under the
 * call's business from K-05 v1.6 readOutboxRow and v1.3 readFixedLineFacts and the bundle the row was committed under:
 * its slots filled, its fixed lines added word for word (T-314: S13-01's opener, Q-30's STOP, HELP and rates line and
 * privacy link), the claim check and the message checks run, and the plan written into the row with its final parts
 * (T-196's writePlan); or the one rewrite asked for, then the step's fallback. The turn records the row's fillAndChecks
 * and rewriteOrFallback spans and the Tool API base records none (TURN_RECORDS_FILL_AND_CHECKS; DL-376), so no flag is set.
 */
export type FinalizePort = Pick<TurnFace, "finalizeMessage">;

/**
 * K-05's plan calls (the outbox's are a port of their own since T-562 joined them: `Ports.outbox`; the clock arming's
 * since T-564 joined it: `Ports.arming`). On staging (T-1242) the port is real, over RootOptions.planCalls (./real.ts
 * realDataAccess), failing closed until the part of T-1154 that binds them; a test binds its fake, production keeps it
 * closed.
 */
export interface DataAccess {
  /** K-05 v1 unplannedRows and writePlan: the turn's rows after its commit (its park is the turn-row port's). */
  readonly rows: Omit<TurnRows, "parkTurn">;
}

/**
 * The clock arming at a part's first delivery receipt (T-564; T-255's ArmingOptions; arch 02 step 9, line 127): K-05 v1
 * item 5's armClock and cancelClock (T-197), the question's facts the due rule reads (no K-05 call returns them yet: K-05
 * open gap 25), and where a handle's actor lives (the actor the arming tells of its newly armed row). The receipt door
 * hands it each part K-05 markPart newly marked delivered.
 */
export type ArmingPort = Pick<ArmingOptions, "data" | "facts" | "directory">;

/**
 * The dispatcher's Linq sends (T-563): K-11 v1 sendPart, each part of a claimed row, under its `<row>/<part>/<try>` key,
 * through the Linq line (@rosie/adapters' Linq double in a test). The checked safety line the actor sends straight through
 * Linq while PostgreSQL is down is a port of its own (`Ports.linqDirect`), which no D-017 hop runs.
 */
export interface LinqSend {
  /** K-11 sendPart: each part the dispatcher sends. */
  readonly parts: LinqSendCall;
}

/** One implementation of every port. */
export interface Ports {
  readonly linqVerify: LinqVerifyCall;
  readonly sealing: SealingKeyStore;
  /**
   * K-05 v1.7 openChatOnText (T-1213; item 46): the gateway's call at receipt, once per text or photo a phone handle sends
   * through Linq, after the key call and before the actor, with the handle's K-04 id the key call answered.
   */
  readonly chatOpen: ChatOpenPort;
  readonly safetyRead: SafetyReadPort;
  readonly turnRow: TurnRowPort;
  /**
   * K-05 v1 item 7's two bundle reads, primary and uncached (readActiveBundle, readBundleValue), and the bundle KV when
   * the port carries one (left out: the actor's own BUNDLES binding): the turn's pin at its start (T-249), whose manifest
   * holds the guard's keyword list (K-01 v1 lists.keywords), and the active bundle id each webhook's trace names.
   */
  readonly bundles: BundleDeps;
  /** K-05 v1.2 handleTargets (item 27): the guard's targets, primary and uncached, across businesses (T-250). */
  readonly targets: HandleTargetsPort;
  /** K-09 buildFrontier through @rosie/actions' turn face (T-557): the turn's closed list of choices from stored state. */
  readonly frontier: FrontierPort;
  readonly stateReads: StateReads;
  readonly turnFace: TurnFacePort;
  readonly decide: TurnDecide;
  /** K-09 gateAndCommit through @rosie/actions' turn face (T-559): the gate and the turn's one commit under its id. */
  readonly gate: GatePort;
  /** K-09 composeInput through @rosie/actions' turn face (T-560): each committed row's K-03 composer input. */
  readonly composeInput: ComposeInputPort;
  /** K-03's plan for each row and its one rewrite through @rosie/ai's composer (T-560), one per bundle for both. */
  readonly composer: TurnComposer;
  /** K-09 finalizeMessage through @rosie/actions' turn face (T-561): each row's final parts, written with its plan. */
  readonly finalize: FinalizePort;
  /**
   * K-05 v1.2's outbox calls (T-562): the dispatcher's claim in commit order, its renewal and marks, and the receipt
   * door's delivered mark, one store, since a receipt finds the part the dispatcher sent.
   */
  readonly outbox: OutboxStore;
  /** K-05 v1.2 sendState (T-562): limit 8's read at send, and the chat the send goes to. */
  readonly sendState: SendStatePort;
  readonly dataAccess: DataAccess;
  /** K-11 sendPart through the Linq line (T-563): each part the dispatcher sends, once per row-part-try key. */
  readonly linqSend: LinqSend;
  /** The clock arming at a part's first delivery receipt (T-564): K-05 armClock and cancelClock, its reads. */
  readonly arming: ArmingPort;
  /** A checked safety line straight through Linq while PostgreSQL is down (arch 11 line 566): no D-017 hop. */
  readonly linqDirect: DirectLineSender;
  /**
   * K-09 v1 recordStopOrStart for the actorOnReturn caller (T-1363; ../outage/db/types.ts StopOrStartCore): each STOP or
   * START the handle actor took while PostgreSQL was down, written once it answers again (the PostgreSQL-down path's
   * `core`, which the root's `install()` joins: T-1326). No D-017 hop. A call it does not take (a throw, or K-09's
   * transient) leaves the record with the actor for its next try.
   */
  readonly stopOrStart: StopOrStartCore;
  /**
   * The alerts of a safety timer due while PostgreSQL is down, fired from the actor's copy (T-1363; ../outage/db/types.ts
   * TimerFirePort; the PostgreSQL-down path's `timers`, which the root's `install()` joins: T-1326). No D-017 hop. The
   * copy comes with the job's address still sealed under its person's key: opening it is the CTO's call with the security
   * reviewer (QUESTIONS.md CQ-101 (c)). A throw: not fired, tried again 5 s on.
   */
  readonly timerFire: TimerFirePort;
}
