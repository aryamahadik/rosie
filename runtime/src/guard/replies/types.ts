// The guard's fixed replies (T-267; C-052): the shapes, written by hand from the frozen contracts, because the generated
// types are git-ignored (ADR-005) and the Worker must not depend on them:
//
//   - K-09 v1 (contracts/tool-api): the shared core's `recordStopOrStart` and `sendFixedLine`, each a core action carried
//     in the turn's one commit (`CoreAction`, `CoreResult`; README defaults 6, 10, 15 and 35: a bare STOP runs in its own
//     core-only turn, as stop-recorded.json shows), and v1.1's `businessesTold` (README default 50), which a v1.1 call
//     always returns and a v1 call leaves out;
//   - K-05 v1 (contracts/data-access): `unplannedRows` and `writePlan`, which put a fixed line's words into its row after
//     the commit, with a plan of no lines of its own (write-plan-alex-safety.json: "K-01's fixed line ... word for word,
//     which code adds");
//   - K-03 v1 (contracts/message-plan): the row plan and the final parts written.
//
// Never logged or put in a span: a number, a text's words, a reply's words. The ids, kinds and codes here are labels.

// ---- K-09 v1: the core actions of a keyword turn --------------------------------------------------------------------

/**
 * K-09 v1 `caller` for a call the handle actor's turn makes: kind turn, the turn id again as the key a repeat is known by
 * (README default 15). `businessId` is null: a STOP, a START and the guard's HELP cover every business, since one number
 * serves them all (RULES 7.2; MC C1; stop-recorded.json).
 */
export interface TurnCaller {
  kind: "turn";
  turnId: string;
  requestId: string;
  businessId: null;
  personId: string | null;
  traceId: string;
}

/** K-09 v1 `recordStopOrStart.request`, as the guard sends a STOP or a START: from the text's own number and event. */
export interface RecordStopOrStartRequest {
  caller: TurnCaller;
  kind: "stop" | "start";
  /** The number the STOP or START came from, never another (RULES 7.2, 7.5). Never logged. */
  phoneNumber: string;
  /** The text's K-06 event: required for a START (RULES 7.5; MC C1). */
  inboundEventId: string;
  /** The person's own words, kept as the consent row's exact words (K-29 v1 consents.exact_words). Never logged. */
  words: string;
  /** CANCEL or CANCELAR: also flags the visit (RULES 7.4). */
  alsoCancelVisit: boolean;
  workPhoneBusinessIds: null;
  /** Null: the call writes the reply's row (README default 6); the actor's own send while PostgreSQL is down is T-269's. */
  sentByActor: null;
}

/** A fixed line and the row it goes in (K-09 v1 `StopReply`): null `outboxRowId` when no row was written. */
export interface FixedLineRow {
  fixedLineId: string;
  outboxRowId: string | null;
}

/**
 * K-09 v1.1 `BusinessToldTextsOff` (README default 50): a business with an open booking for the stopped phone, told by one
 * row to its owner with the one fixed line "Texts to this customer are off. Reach them their way." (RULES 7.5).
 */
export interface BusinessTold {
  businessId: string;
  fixedLineId: string;
  outboxRowId: string | null;
}

/** K-09 v1 `recordStopOrStart.response`, with v1.1's `businessesTold`. */
export interface RecordStopOrStartResponse {
  consentRowIds: string[];
  /** K-04 phones.stopped after the call: one flag for the number, so for every business. */
  stopped: boolean;
  chatOpen: boolean;
  phoneVersion: number;
  /** The stop or start reply, or null for a work phone's STOP, which asks instead (T-268). */
  reply: FixedLineRow | null;
  askedWhichTexts: { openQuestionId: string; clockRowId: string } | null;
  flaggedBookingIds: string[];
  repeated: boolean;
  /** v1.1: left out only by a v1 call. */
  businessesTold?: BusinessTold[];
}

/** K-09 v1 `sendFixedLine.request`, as the guard sends HELP's reply (a reply in the same turn: Q-15). */
export interface SendFixedLineRequest {
  caller: TurnCaller;
  fixedLineId: string;
  recipientHandleId: string;
  sendClass: "quick_reply";
  sentByActor: null;
}

/** K-09 v1 `sendFixedLine.response`. */
export interface SendFixedLineResponse {
  outboxRowId: string | null;
  repeated: boolean;
}

/**
 * A K-09 error: a JSON object with its own `error` code, such as `notFromThatPhone`, `notAWorkPhone`, `phoneStopped`,
 * `notFound`, `versionChanged` or `transient` (nothing written).
 */
export interface CoreError {
  error: string;
  readonly [field: string]: unknown;
}

/** K-09 v1 `CoreAction`: the two the guard's replies make. */
export type ReplyCoreAction =
  | { call: "recordStopOrStart"; request: RecordStopOrStartRequest }
  | { call: "sendFixedLine"; request: SendFixedLineRequest };

/** K-09 v1 `CoreResult`: one core action's answer, in the order of the actions. */
export type ReplyCoreResult =
  | { call: "recordStopOrStart"; response: RecordStopOrStartResponse | null; error: CoreError | null }
  | { call: "sendFixedLine"; response: SendFixedLineResponse | null; error: CoreError | null };

/** The keyword turn's core actions, for its one commit. */
export interface CoreCommitRequest {
  caller: TurnCaller;
  actions: ReplyCoreAction[];
}

/** K-09 v1 `gateAndCommit.response` as far as the replies read it: committed, with each core action's answer. */
export interface CoreCommitted {
  result: "committed";
  turnId: string;
  /** True when this turn committed before: the first commit's answers come back (a rerun after a crash). */
  repeated: boolean;
  core: ReplyCoreResult[];
}

export type CoreCommitAnswer = CoreCommitted | CoreError;

/**
 * The shared core as the guard's replies reach it: the turn's core actions, carried in its one commit (K-09 v1
 * `gateAndCommit` with input coreOnly, beside each text's `recordSafetyOutcome`, which the turn loop adds: README defaults
 * 5, 10 and 35). Served by the Tool API (C-074) through the turn loop (T-251), joined at D-017; a fake answers in tests.
 * An answer with an `error` means nothing was written.
 */
export interface ReplyCore {
  commitCore(request: CoreCommitRequest): Promise<CoreCommitAnswer>;
}

// ---- K-05 v1 and K-03 v1: the fixed line's words, written into its row after the commit -------------------------

/** K-05 v1 `channel`. */
export type Channel = "imessage" | "rcs" | "sms" | "email";

/** One row of K-05 v1 `unplannedRows.response`: a row of the turn that has no plan yet. */
export interface UnplannedRow {
  outboxRowId: string;
  version: number;
  commitSeq: number;
  recipientHandleId: string;
  channel: Channel;
  copyOfRowId: string | null;
}

/** K-05 `transientError`: nothing was read or written; the same call may be sent again. */
export interface TransientError {
  error: "transient";
  sqlstate: string;
}

export type UnplannedRowsAnswer = { result: "rows"; rows: UnplannedRow[] } | TransientError;

/** K-03 v1 `send`: the words of a fixed line, one part. */
export interface WordsSend {
  kind: "words";
  /** Never logged. */
  text: string;
  calendarFile: "none";
  options: readonly string[];
  link: null;
}

/**
 * K-03 v1 `rowPlan` for a fixed line's row: a plan of no lines of its own, since the line goes word for word and code adds
 * it (write-plan-alex-safety.json).
 */
export interface FixedRowPlan {
  row: string;
  channel: Channel;
  copyOf: null;
  plan: {
    formats: ["text"];
    lines: readonly never[];
    question: null;
    pageType: null;
    threadReplyTo: null;
  };
}

/** K-03 v1 `finalParts` for a fixed line's row: one words part, the line's id in `fixedLines`, no slot filled. */
export interface FixedFinalParts {
  row: string;
  channel: Channel;
  sends: readonly WordsSend[];
  /** The fixed line code added, by its K-01 id: `stopReply` is what lets limit 8 send it to a stopped phone. */
  fixedLines: readonly string[];
  slotValues: readonly never[];
  threadReplyTo: null;
}

/** K-05 v1 `writePlan.request`. */
export interface WritePlanRequest {
  outboxRowId: string;
  expectVersion: number;
  plan: FixedRowPlan;
  finalParts: FixedFinalParts;
}

/** K-05 v1 `writePlan.response`, or one of its errors (`alreadyPlanned`: the row holds a plan, which stays). */
export type WritePlanAnswer =
  | { result: "written"; outboxRowId: string; version: number }
  | { error: "alreadyPlanned"; outboxRowId: string; version: number }
  | CoreError;

/**
 * The two K-05 v1 calls that put a fixed line's words into its row after the commit (the database engineer's C-152; the
 * actor's adapter joins at D-017; a fake answers in tests).
 */
export interface ReplyRows {
  unplannedRows(request: { turnId: string }): Promise<UnplannedRowsAnswer>;
  writePlan(request: WritePlanRequest): Promise<WritePlanAnswer>;
}

// ---- what the replies need, and what they give --------------------------------------------------------------------

/** What the guard's replies need from outside, set once per Worker isolate (`setReplyDeps`); joins at D-017. */
export interface ReplyDeps {
  core: ReplyCore;
  rows: ReplyRows;
  /**
   * Rosie's one number (D102), as HELP's reply gives it: a config value (K-09 README default 21 and open gap 9; Q-51),
   * not a secret. Blank: HELP's reply has no number to give, so its words are not written.
   */
  rosieNumber: string;
}

/** Where a reply's words came from: K-01's line in the pinned bundle, or Q-01's drafted default while it has none. */
export type WordsFrom = "bundle" | "q01Default";

/** A fixed line's words, ready to send. Never logged. */
export interface ReplyWords {
  /** The K-01 line the words are (K-03 `finalParts.fixedLines` names it): the core's id, or K-01's for a K-09 alias. */
  readonly lineId: string;
  readonly text: string;
  readonly from: WordsFrom;
}

/**
 * How one keyword text ended:
 * - `replied`: recorded, and its reply's words written by code into its row (the dispatcher sends it, limit 8 deciding);
 * - `recordedNoReply`: recorded with no reply row for this path (a work phone's STOP asks which texts: T-268);
 * - `noWords`: recorded, but its reply's words could not be written into its row now (`errorCode` says why);
 * - `refused`: the core refused it and wrote nothing for it (`phoneStopped`: HELP from a stopped number, whose one
 *   reply is T-268's; `notFromThatPhone`; ...), or the turn has no number to record it for (`noPhone`);
 * - `notRecorded`: nothing was recorded: the commit failed, gave no answer, or is not wired. The turn must run again.
 *
 * The codes beside an outcome (a span's `error_code`, a label): the core's own error codes, and `unwired` (no deps set
 * yet: D-017), `noAnswer` (the commit or a K-05 call failed with no answer), `badAnswer` (an answer that is not the
 * contract's), `noPhone`, `noWords` (no words for the line: none in the bundle and no Q-01 default, or HELP with no
 * number), `rowsUnread` (the turn's unplanned rows could not be read) and `planNotWritten` (writePlan refused the row).
 */
export type ReplyOutcome = "replied" | "recordedNoReply" | "noWords" | "refused" | "notRecorded";
