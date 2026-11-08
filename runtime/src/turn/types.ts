// The turn loop's shapes (T-251; C-046), written by hand from the frozen contracts, because the generated types are
// git-ignored (ADR-005) and the Worker must not depend on them. Only what the turn builds or reads is typed; every other
// field of a context, a decide result or an answer rides through untouched, as the far side gave it:
//
//   - K-09 v1 (contracts/tool-api), the turn face: `buildFrontier`, `closestEntries` and `gateAndCommit` (the `caller`,
//     the K-05 `turn`, the decided and core-only inputs, `recordSafetyOutcome` as a core action of the turn's one commit:
//     README defaults 5, 10 and 35);
//   - K-02 v1 (contracts/model): the turn's texts (`text`), the context decide is given, and decide's result with its
//     reads and its re-read flag (`decideResult`);
//   - K-08 v1: the model calls a decide stage reports for its span.
//
// Every outside call is a port (`TurnDeps`), set once per Worker isolate and joined at D-017 (T-552 onward): the Tool
// API's turn face (C-074: the frontier is C-075's, the gate C-080's, the commit C-087's), the AI layer's decide and its
// one Sonnet re-read (C-115, C-116: T-369, T-370), the handle's directory and sealing key, and each text's safety result.
// Never logged or put in a span: a text's words, a number, a key. The ids, kinds and codes here are labels.

import type { CommitContext, CommitTurnRef } from "../actor";
import type { HandleRef, SealingKeyStore } from "../gateway/seal";
import type { GuardTargets } from "../guard";
import type { SafetyResult } from "../safety/types";
import type { BundleId, TraceContext } from "../trace";
import type { ModelCall } from "../trace/types";

// ---- K-09 v1: who calls, and the turn ---------------------------------------------------------------------------------

/**
 * K-09 v1 `caller` for a call the handle actor's turn makes: kind turn, its turn id again as the key a repeat is known by
 * (README default 15). `businessId` is the business the call runs under (row-level security), null for a turn of keyword
 * texts alone, whose STOP, START and HELP cover every business (RULES 7.2; stop-recorded.json).
 */
export interface TurnCaller {
  kind: "turn";
  turnId: string;
  requestId: string;
  businessId: string | null;
  personId: string | null;
  traceId: string;
}

// ---- K-02 v1: the turn's texts, the context and decide's result --------------------------------------------------

/** K-02 v1 `text`: one text of the turn after the edge scrub, as the frontier and decide read it. Its words are never logged. */
export interface TurnText {
  eventId: string;
  /** text: words typed (a photo's caption, an edit's new words); pollVote: a vote in one of Rosie's polls; tapback. */
  kind: "text" | "pollVote" | "tapback";
  words: string;
  /** The sender's send time with the zone dates resolve in (S13-03; K-06: the gateway knows no zone). */
  sentAt: { utc: string; zone: string };
  attachments: { attachmentId: string; mediaType: string }[];
  poll: { pollId: string; optionId: string } | null;
  tapback: { reaction: string; onMessageId: string } | null;
}

/** One choice of the frontier, as far as the turn reads it (K-02 v1 `choice`). */
export interface Choice {
  readonly choiceId: string;
  readonly [field: string]: unknown;
}

/**
 * K-02 v1 `context`: what decide is given, built by the frontier (K-09 buildFrontier) and passed to decide and to the
 * gate unchanged (CQ-25). The turn reads its turn and bundle ids and counts its choices; the rest rides through.
 */
export interface DecideContext {
  readonly turnId: string;
  readonly bundleId: BundleId;
  readonly choices: readonly Choice[];
  readonly [field: string]: unknown;
}

/** K-02 v1 `decidePart`: one verb for one part of the text, with its exact quote. */
export interface DecidePart {
  readonly verb: string;
  readonly quote: string;
  readonly [field: string]: unknown;
}

/** K-02 v1 `resultPart`: go, or one question with nothing changed for the part (arch 02 line 119; Q-41). */
export interface ResultPart {
  readonly part: DecidePart;
  readonly outcome: "go" | "oneQuestion";
}

/** K-02 v1 `read`: one decide read, by which model and in which role (first, check, or the one re-read). */
export interface DecideRead {
  readonly model: "haiku" | "sonnet";
  readonly role: "first" | "check" | "reread";
  readonly output: unknown;
}

/** K-02 v1 `decideResult`: the reads, whether they agreed, whether the re-read ran, and each part with its outcome. */
export interface DecideResult {
  readonly turnId: string;
  readonly bundleId: BundleId;
  readonly stakes: "high" | "low";
  readonly routing: { readonly first: "haiku" | "sonnet"; readonly second: "haiku" | "sonnet" };
  readonly reads: readonly DecideRead[];
  readonly agreed: boolean;
  readonly reread: boolean;
  readonly language: string | null;
  readonly parts: readonly ResultPart[];
}

// ---- K-09 v1: the turn face ---------------------------------------------------------------------------------------

/** K-09 v1 `buildFrontier.request`: the turn, its texts and the guard's targets give K-02's context. */
export interface BuildFrontierRequest {
  caller: TurnCaller;
  turn: CommitTurnRef;
  texts: TurnText[];
  targets: GuardTargets;
  now: string;
}

/** K-09 v1 `buildFrontier.response`: the context, with what the builder flagged or collapsed. */
export interface BuildFrontierResponse {
  context: DecideContext;
  flagged: readonly unknown[];
  collapsedBookingIds: readonly string[];
}

/** A K-09 error: a JSON object with its own `error` code; nothing was written (`transient`: the same call may be sent again). */
export interface ToolApiError {
  readonly error: string;
  readonly [field: string]: unknown;
}

export type BuildFrontierAnswer = BuildFrontierResponse | ToolApiError;

/** K-09 v1 `closestEntries.request`: nothing fits, so the 3 closest entry steps join the choices (arch 03 line 189). */
export interface ClosestEntriesRequest {
  caller: TurnCaller;
  context: DecideContext;
  /** The quotes of the parts nothing fits. */
  quotes: string[];
}

/** K-09 v1 `closestEntries.response`: the context with the entries added (`meaningSearch`), and the steps added. */
export interface ClosestEntriesResponse {
  context: DecideContext;
  added: readonly string[];
}

export type ClosestEntriesAnswer = ClosestEntriesResponse | ToolApiError;

/** K-09 v1 `coreAction`: a shared-core call carried inside the turn's one commit, in order. */
export interface CoreAction {
  readonly call: string;
  readonly request: unknown;
}

/**
 * K-09 v1 `recordSafetyOutcome` as a core action of the turn: each text's outcome, No included, rides in the commit of
 * the turn its text joins (README default 5), the safety read's result unchanged (K-09 v1.1 freeze record).
 */
export interface RecordSafetyOutcomeAction extends CoreAction {
  readonly call: "recordSafetyOutcome";
  readonly request: {
    caller: TurnCaller;
    safety: SafetyResult;
    handleId: string;
    bookingId: null;
    sentByActor: null;
  };
}

/** K-09 v1 `gateAndCommit.request.input` for decided texts: the context and decide's result, as the gate reads them. */
export interface DecidedInput {
  kind: "decided";
  decided: { context: DecideContext; decide: DecideResult };
  /** The planner's verb after meaning search (C-117): not built yet, so null. */
  planner: null;
}

/** K-09 v1 `gateAndCommit.request.input` for a turn of keyword texts alone: only core actions (arch 02 line 115). */
export interface CoreOnlyInput {
  kind: "coreOnly";
}

/** K-09 v1 `gateAndCommit.request`: one commit under the turn id, with the turn's core actions in order. */
export interface GateAndCommitRequest {
  caller: TurnCaller;
  turn: CommitTurnRef;
  input: DecidedInput | CoreOnlyInput;
  core: CoreAction[];
  now: string;
}

/** K-08 v1 `limitResult`, as the gate gives each part's limits. */
export interface PartLimit {
  readonly limit: number;
  readonly result: "pass" | "fail" | "notChecked";
  readonly outcome: string | null;
}

/** K-09 v1 `partResult`: each agreed part, committed or stopped by a limit (which stops only that choice), held or asked. */
export interface PartResult {
  readonly part: number;
  readonly choiceId: string | null;
  readonly result: string;
  readonly limits: readonly PartLimit[];
  readonly stoppedBy: unknown;
  readonly gives: readonly string[];
  readonly dependsOnPart: number | null;
}

/** K-09 v1 `coreResult`: one core action's answer, in the order of the request. */
export interface CoreResult {
  readonly call: string;
  readonly response: unknown;
  readonly error: unknown;
}

/** K-09 v1 `gateAndCommit.committed`: one commit under the turn id; a repeat returns the first commit with `repeated`. */
export interface GateCommitted {
  readonly result: "committed";
  readonly turnId: string;
  readonly committedAt: string;
  readonly repeated: boolean;
  readonly parts: readonly PartResult[];
  readonly planner: unknown;
  readonly core: readonly CoreResult[];
  readonly written: {
    readonly written: readonly { readonly table: string; readonly rowId: string }[];
    readonly outboxRows: readonly { readonly id: string }[];
    readonly [field: string]: unknown;
  };
  readonly [field: string]: unknown;
}

export type GateAndCommitAnswer = GateCommitted | ToolApiError;

/**
 * K-09 v1's turn face, as the turn reaches it (C-074, the Tool API; joined at D-017). Each call is handed the turn's trace;
 * the turn records the call's own span (frontier, search, gate and commit), so a joined port records only what runs
 * beneath it, never the same hop again.
 */
export interface TurnFace {
  buildFrontier(request: BuildFrontierRequest, trace: TraceContext): Promise<BuildFrontierAnswer>;
  closestEntries(request: ClosestEntriesRequest, trace: TraceContext): Promise<ClosestEntriesAnswer>;
  /**
   * Gate and commit, behind the lease: `at` is the lease's CommitContext (the safety holds open and the texts not read yet
   * at commit time), passed on unchanged, which the gate reads as the commit's open holds (QUESTIONS.md CQ-65 with its
   * DL-127, DL-128 and DL-133 addenda; T-305's `openHolds`).
   */
  gateAndCommit(
    request: GateAndCommitRequest,
    at: CommitContext,
    trace: TraceContext,
  ): Promise<GateAndCommitAnswer>;
}

// ---- the AI layer: decide and its one re-read -------------------------------------------------------------------

/** What decide (T-369) or the re-read (T-370) answers: K-02's decide result and the model calls it made (K-08). */
export interface Decided {
  readonly result: "decided";
  readonly decide: DecideResult;
  /** The model calls the stage made, for its span (K-08 v1 requires at least one on decideReads and reread). */
  readonly modelCalls: readonly ModelCall[];
}

/** The stage could not give a result (both models down, a read refused, a context refused): a label, never words. */
export interface DecideFailed {
  readonly error: string;
}

export type DecideAnswer = Decided | DecideFailed;

/** Why the turn asks for its one Sonnet re-read (arch 02 line 119; arch 06 line 289; arch 03 line 189; Q-41). */
export type RereadWhy = "disagreed" | "noneFits" | "valueFailsWords";

/** What the re-read is given: the context (with meaning search's entries after nothing fit), the result so far, and why. */
export interface RereadRequest {
  readonly context: DecideContext;
  readonly decide: DecideResult;
  readonly why: RereadWhy;
  /** For valueFailsWords, the parts and fields the gate named (K-09 v1 gateAndCommit.errors); otherwise empty. */
  readonly failing: readonly { readonly part: number; readonly fields: readonly string[] }[];
}

/**
 * The AI layer's decide (K-02 v1): two reads that must agree on every choice and value (C-115, T-369), and the turn's
 * one Sonnet re-read (C-116, T-370). Joined at D-017; fakes answer K-02's fixtures in tests.
 */
export interface TurnDecide {
  decide(context: DecideContext, trace: TraceContext): Promise<DecideAnswer>;
  reread(request: RereadRequest, trace: TraceContext): Promise<DecideAnswer>;
}

// ---- the turn's own facts ------------------------------------------------------------------------------------------

/** Who the handle is, as K-04 names it, and the zone its texts' dates resolve in. */
export interface TurnParty {
  /** K-04 handles.id: the turn row's handle and the guard's targets read. */
  readonly handleId: string;
  /** The business the turn's calls run under (K-09 caller.businessId; row-level security), or null. */
  readonly businessId: string | null;
  /** The person behind the handle (K-09 caller.personId), or null when not known. */
  readonly personId: string | null;
  /** The zone the texts' dates resolve in (S13-03): K-02 text.sentAt.zone. */
  readonly zone: string;
}

/** The handle's directory: who an actor's handle is (K-04 handles, persons and roles). Null: not known, so no turn runs. */
export interface TurnDirectory {
  partyOf(request: { actorName: string; handle: HandleRef }): Promise<TurnParty | null>;
}

/**
 * Each text's safety result (K-02 v1 `safetyResult`), as the safety read on arrival gave it: the turn's commit records it
 * (K-09 README default 5). The actor keeps only labels (runtime/src/safety), so the store behind this joins at D-017.
 */
export interface TurnSafety {
  resultsOf(eventIds: readonly string[]): Promise<readonly SafetyResult[]>;
}

/** Everything the turn reaches outside the actor, set once per Worker isolate (`setTurnDeps`); joined at D-017. */
export interface TurnDeps {
  readonly directory: TurnDirectory;
  /** The handle's sealing key (NQ-RT-1): the turn opens its texts' sealed words, and only here. */
  readonly keys: SealingKeyStore;
  readonly safety: TurnSafety;
  readonly toolApi: TurnFace;
  readonly ai: TurnDecide;
  /** The time a K-09 request names as now, in UTC (the fake clock on staging: BP 9.4). */
  now(): string;
}
