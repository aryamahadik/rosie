// What the one commit per turn reads, builds and calls (C-087, T-305; arch 01 line 39: "State, one outbox row per
// outgoing message and the event-log entry commit together under the turn id"; arch 02 line 121; arch 10 line 508).
//
// gateAndCommit's second half: the gate (T-298, ../gate/framework) passes or stops each agreed part; the commit turns the
// parts that may go into one K-05 commitTurn request (K-05 v1, with K-05 v1.1's effect rows) and sends it once. The
// K-05 request and its answer are the generated contract types (`npm run contracts:types`; ADR-005); so are K-09 v1.5's
// request and answer (T-1150: K-09 v1's call, by v1.5's definitions of the same name), reached through the Tool API's
// call types, so the commit and the base read one shape.
//
// What a passed part writes (the walk after its choice, its step's writes: arch 03 line 191), what a core action writes
// (the shared-core calls), what is open now (the safety holds and the turn's unread texts) and the K-05 call itself are
// ports, given to the commit: each is another task's (CommitPorts below), so the commit is tested with doubles and fails
// closed while one is not built.

import type * as K05 from "../../../contracts/generated/data-access/data-access.v1.1";
import type * as K05V1dot21 from "../../../contracts/generated/data-access/data-access.v1.21";
import type * as K05V1dot22 from "../../../contracts/generated/data-access/data-access.v1.22";
import type { Choice, GatedVerbPart, GateRequest, LimitRegistry, SetupKey } from "../gate/framework";
import type { CallContext, ErrorsOf, RequestOf, ResponseOf } from "../tool-api";
import type { TurnCommitRequest } from "./build";

// ---- K-05 v1.1 commitTurn (contracts/data-access) -------------------------------------------------------------------

/** K-05 v1.1 `commitTurn.request`: the turn row, the versions read and every write, all or nothing, once. */
export type CommitTurnRequest = K05.CommitTurnRequest;
/** K-05 v1.1 `commitTurn.response`: committed; a repeated turn id returns the first commit with `repeated` true. */
export type CommitTurnResponse = K05.CommitTurnResponse;
/** K-05 v1.1 `commitTurn.errors`: refused, nothing written. */
export type CommitTurnError = K05.CommitTurnErrors;
/**
 * K-05 v1.21's one more refusal (README item 81.2; `openQuestionWrongStateError`): wrongState for an open question the
 * request asks again that is not live at the version read. Only a request that asks a question again may answer it
 * (K-05 v1.21 default 199; build.ts AskAgainCommitRequest), so a request that raises nothing answers v1.1's errors alone.
 */
export type AskAgainWrongState = K05V1dot21.OpenQuestionWrongStateError;
/** What the commit's K-05 port answers: committed, v1.1's refusals, or, for a request that asks again, v1.21's wrongState. */
export type CommitTurnAnswer = CommitTurnResponse | CommitTurnError | AskAgainWrongState;
/** K-05 v1.21 `openQuestionAskAgain`: the question asked again, by its id and the version the turn read it at. */
export type OpenQuestionAskAgain = K05V1dot21.OpenQuestionAskAgain;
/** K-05 v1.1 `writes`. */
export type Writes = K05.Writes;
/** K-05 v1 `turn`: the turn row the commit writes, once, as committed. */
export type TurnRow = K05.Turn;
export type RowRef = K05.RowRef;
export type StateWrite = K05.StateWrite;
export type OpenQuestionNew = K05.OpenQuestionNew;
export type OpenQuestionClose = K05.OpenQuestionClose;
export type ClockNew = K05.ClockNew;
export type ClockCancel = K05.ClockCancel;
/**
 * K-05 v1.22 `outboxRowNew` (T-1474; README item 82): v1's ten fields and, from v1.22, the step whose line the row carries
 * to its reader and that line's index (`step` and `lineNo`, both or neither), which the walk writes on every row it writes
 * (walk/writes.ts defaults 15 and 16; T-1479). Every v1 row, with neither, is a v1.22 row (README default 206).
 */
export type OutboxRowNew = K05V1dot22.OutboxRowNew;
export type ReservationConfirm = K05.ReservationConfirm;
export type ReservationLetGo = K05.ReservationLetGo;
/** K-05 v1.1 `effectNew` (K-07 v1 effectRow's fields); its kind's rules are schema rules the commit checks in code. */
export type EffectNew = K05.EffectNew;
export type EffectLetGo = K05.EffectLetGo;
/** K-05 v1 `eventEntry`, written in K-08 v1's shapes (kinds, `why`, `approvedBy`). */
export type EventEntry = K05.EventEntry;

// ---- K-09 v1.5 gateAndCommit (contracts/tool-api), through the Tool API's call types ------------------------------

/**
 * K-09 v1.5 `gateAndCommit.request`: its turn (`gateAndCommit.turn`) is K-05 v1's seven fields with, on a turn of texts,
 * the service and the chat id of the turn's last text, both or neither (default 135): the walk's inputs, never the turn
 * row's (build.ts k05TurnRow).
 */
export type GateAndCommitRequest = RequestOf<"gateAndCommit">;
/** What gateAndCommit answers: its response or one of its errors (each "Refused, nothing written"). */
export type GateAndCommitAnswer = ResponseOf<"gateAndCommit"> | ErrorsOf<"gateAndCommit">;
/** K-09 v1.5 `gateAndCommit.committed`. */
export type Committed = Extract<ResponseOf<"gateAndCommit">, { result: "committed" }>;
/** K-09 v1.5 `partResult`. */
export type PartResult = Committed["parts"][number];
/** K-09 v1.5 `coreAction`: a shared-core call carried inside the turn's one commit. */
export type CoreAction = GateAndCommitRequest["core"][number];
/** K-09 v1.5 `coreResult`. */
export type CoreResult = Committed["core"][number];
/** K-09 v1.5 `effectWritten`. */
export type EffectWritten = Committed["effects"][number];
/** K-07 v1 `effectKind`. */
export type EffectKind = EffectWritten["kind"];
/** K-09 v1.5 `BundleMismatchError`. */
export type BundleMismatch = Extract<ErrorsOf<"gateAndCommit">, { error: "bundleMismatch" }>;
/**
 * K-09 v1.5 `safetyHold`: an open hold on the handle's routine actions (K-34 v1 safety_holds; arch 06 lines 315 to
 * 327).
 */
export type SafetyHold = NonNullable<
  NonNullable<Extract<CoreResult, { call: "recordSafetyOutcome" }>["response"]>["hold"]
>;

/**
 * What is open on the turn's handle at commit time (QUESTIONS.md CQ-65 with its DL-127 and DL-128 addenda): the safety
 * holds, and the turn's texts not yet read, by event id (K-06 v1 eventId): each text still being read, unwired, given up
 * with no hold row, or with no safety row. An unread text holds every part but a protective one, as a threat's hold does
 * (hold.ts). T-1088's runtime CommitContext carries the same event ids beside the holds; T-251 wires the two.
 */
export interface OpenHolds {
  readonly holds: readonly SafetyHold[];
  readonly unreadEventIds: readonly string[];
}

// ---- what a part or a core action writes ---------------------------------------------------------------------------

/**
 * Why a unit's rows were written, as K-08 v1 `why` names it (arch 09 line 457): the step whose branch made the write and,
 * for a choice, its label as the bundle writes it (never a person's own words). Every event-log entry the commit writes for
 * the unit's rows carries it.
 */
export interface Why {
  readonly step: string;
  readonly choice: string | null;
}

/**
 * An open question a unit opens: the step the walk stopped at (arch 03 line 191). The commit writes it waiting, with its
 * clock row unarmed (no due time: K-05 v1 clockNew), which arms at the question's first delivery receipt (arch 02 line 127;
 * K-05 v1 armClock), and the event-log entries of both.
 */
export interface Ask {
  readonly question: OpenQuestionNew;
  /** What the clock applies at the deadline: the step's safe default as the bundle writes it, or null when it names none. */
  readonly safeDefault: string | null;
}

/**
 * What one unit writes in the turn's commit: a part the gate passed (the effects of the choice decide picked: arch 02 line
 * 121; K-09 v1 README "In a turn or alone"), or one core action of the turn. Every list is present, empty when it has none,
 * but `clocks`, which may be left out (none). The commit adds the rows it owns (an asked question's clock row) and the
 * event-log entry of every row it writes, a unit's own clock rows among them; the state writes' own entries come with
 * them, since only the domain knows their kind (`stateEvents`; K-08 v1.1 open gap: setup writes have no kind yet, CQ-56).
 */
export interface UnitWrites {
  readonly why: Why;
  /** Every row the unit's decision rests on, at the version read (limit 4: arch 06 line 305). */
  readonly versionsRead: readonly RowRef[];
  readonly state: readonly StateWrite[];
  readonly stateEvents: readonly EventEntry[];
  readonly asks: readonly Ask[];
  /**
   * The unit's own clock rows, beside the clock rows the commit makes for its asked questions (T-1156; DL-341): clock rows
   * no question of the unit owns, in K-05 v1's clockNew shape as its service makes them, such as a threat's pause
   * call-offs (S11-62: armed at the commit, with their due time) and T-319's escalations. The commit writes each as given,
   * once, with its event-log entry (build.ts), so none is ever dropped. Optional, unlike the other lists, so every unit
   * built without it (the walk's, T-317's unitWritesOf) stays as it is: left out, the unit has none.
   */
  readonly clocks?: readonly ClockNew[];
  /** The open questions it closes: answered, defaulted or withdrawn. */
  readonly closes: readonly OpenQuestionClose[];
  /** The clock rows it cancels: a closed question's own clock. */
  readonly clockCancels: readonly ClockCancel[];
  /** One outbox row per message, with no plan: words go in after the commit (arch 01 line 41; K-07 v1 `planned`). */
  readonly messages: readonly OutboxRowNew[];
  readonly reservations: {
    readonly confirm: readonly ReservationConfirm[];
    readonly release: readonly ReservationLetGo[];
  };
  /** Effect rows, each on one idempotency key (arch 10 line 508; K-07 v1), and effects in outage let go (K-05 v1.1). */
  readonly effects: { readonly write: readonly EffectNew[]; readonly letGo: readonly EffectLetGo[] };
  /**
   * For a part, the keys its step gives that these writes write (K-09 v1.5 `partResult.gives`); empty for a core action.
   */
  readonly gives: readonly SetupKey[];
  /**
   * The open question the unit asks again (K-09 v1.12 defaults 192 and 194; K-05 v1.21 item 81): its raise at the
   * version the turn's live read gave, with what the raise's event-log entry names (K-05 v1.21 default 196). Optional, as
   * `clocks` is: left out, the unit asks none again. Only the commit's own asked unit carries it (ask-again.ts), beside
   * the one row that sends the question again; the commit writes the raise into K-05 v1.21's `openQuestions.askAgain`
   * (build.ts).
   */
  readonly askAgain?: AskAgain;
}

/**
 * An open question asked again (K-05 v1.21 item 81): the raise K-05 takes, and the question's step, business and ask
 * count as the turn read them, for the raise's `open_question.asked_again` entry (K-05 v1.21 default 196: ask_count from
 * the count read to one more, why the step).
 */
export interface AskAgain {
  readonly raise: OpenQuestionAskAgain;
  readonly step: string;
  readonly businessId: string | null;
  readonly askCount: number;
}

/** One core action run inside the turn: its result (K-09 v1.5 `coreResult`) and what it writes (none when refused). */
export interface CoreRun {
  readonly result: CoreResult;
  readonly writes: UnitWrites;
}

/** A part the gate passed, as the source of its writes reads it. */
export interface PassedPart {
  /** The part's index in decide.parts. */
  readonly index: number;
  readonly part: GatedVerbPart;
  /** The offered choice it chose or entered; null for pass_on and hand_off. */
  readonly choice: Choice | null;
}

/** The turn as the commit's ports read it, inside the call's business scope. */
export interface CommitTurnContext<Repo = unknown> {
  /**
   * The gateAndCommit request (K-09 v1.5): the walk reads the service and the chat id of the turn's last text here, on
   * `request.turn` (default 135), and never from the turn row below.
   */
  readonly request: GateAndCommitRequest;
  /**
   * The turn row the commit writes (K-05 v1 turn): its id is the lease's (T-248, CQ-69), its bundle the pinned one. The
   * row written holds its seven fields alone (build.ts k05TurnRow).
   */
  readonly turn: TurnRow;
  readonly repo: Repo;
  readonly businessId: string;
}

/**
 * What the commit calls, each another task's:
 *   - commitTurn: K-05 v1.1 commitTurn (T-306 wires the database engineer's data-access call; tests use a fake), from
 *     T-1505 also K-05 v1.21's for a request that asks an open question again (build.ts TurnCommitRequest), which alone
 *     may answer v1.21's wrongState (CommitTurnAnswer);
 *   - writesOf: what a passed part's choice writes (the walk after a choice, arch 03 line 191, and each step's writes);
 *   - runCore: one shared-core call made in the turn (K-09 v1.5 `coreAction`; M3b's calls), in the request's order;
 *   - openHolds: what is open on the turn's handle, read at commit time (OpenHolds: the safety holds and the turn's
 *     unread texts; QUESTIONS.md CQ-65: the commit path reads them again, so a hold opened mid-turn binds this commit
 *     too). K-05 v1.2 has no read for K-34's holds yet (its open gap 26).
 * runCore and writesOf are handed what is open in force: the holds open on the handle with those the turn's earlier core
 * actions opened (a safety outcome's hold binds the core actions after it), and the unread texts. So a core call that is
 * not protective holds itself back with its own answer (K-09 v1 coreResult: "A refused core action stops only itself"),
 * and while anything is open a protective part's walk stops at its first routine row (DL-128: A3-50's answer rejoins the
 * booking, MASTER-FLOW-A.md lines 1736 and 1745; T-251 builds both).
 * openHolds, runCore and writesOf must have no outside effect: a repeated turn (a lost reply, a lapsed turn's rerun) runs
 * all three again before K-05 answers `repeated` (K-05 v1 item 1), so each only reads, inside the call's business scope,
 * and hands back what the commit is to write. Nothing is sent, charged, stored or told outside the one K-05 request
 * (arch 10 line 508: exactly once).
 * Each throws CommitNotBuiltError until its task lands (notBuiltPorts), so the commit fails closed.
 */
export interface CommitPorts<Repo = unknown> {
  commitTurn(request: TurnCommitRequest, call: CallContext<Repo>): Promise<CommitTurnAnswer>;
  writesOf(part: PassedPart, turn: CommitTurnContext<Repo>, open: OpenHolds): Promise<UnitWrites>;
  runCore(action: CoreAction, turn: CommitTurnContext<Repo>, open: OpenHolds): Promise<CoreRun>;
  openHolds(turn: CommitTurnContext<Repo>): Promise<OpenHolds>;
}

/**
 * An open question as the commit reads it on the call's transaction: the fields of K-05 v1.2 openQuestionRead it reads, so
 * the rows db/repo/targets.ts reads (OpenQuestionRead, its version read from the row at targets.ts:564) bind as they are.
 * The walk reads it to close an answered question (walk/writes.ts default 11); the commit reads it to send the turn's one
 * open question again (ask-again.ts; K-09 v1.12 default 192 (d) and (e)), which needs its person, booking, read-back and
 * ask count too (T-1505: widened with what openQuestionRead already answers).
 */
export interface LiveQuestion {
  readonly id: string;
  readonly step: string;
  /** The business it is about (open_questions.business_id), or null before there is one. */
  readonly businessId: string | null;
  /** The booking it is about (open_questions.booking_id), or null for a question about no booking (S1-02). */
  readonly bookingId: string | null;
  /** The person it was asked of (open_questions.person_id), or null. */
  readonly personId: string | null;
  /** The options as they went out (K-04 open_questions.options); empty for a question asked with none (S1-02). */
  readonly options: readonly unknown[];
  /** The read-back an exact yes binds to (open_questions.readback), or null (S1-02). */
  readonly readback: string | null;
  /** How many times it has been asked (open_questions.ask_count, at least 1). */
  readonly askCount: number;
  /** The row's version, which a close or a raise compares and sets (K-05 v1 openQuestionClose.expectVersion; limit 4). */
  readonly version: number;
}

/** Where the commit and its walk read a live open question: the call's transaction (walk/writes.ts default 11). */
export interface LiveQuestions<Repo = unknown> {
  /**
   * The open question `openQuestionId` when it is live (waiting or open) and was sent to the handle `handleId`, as its
   * row stands on the call's transaction `repo`; else null. Card F binds K-05 v1.2's read of a handle's live questions
   * (db/repo/targets.ts liveOpenQuestionsOfHandle, as limit 3 reads them), whose rows carry their versions.
   */
  liveQuestion(repo: Repo, handleId: string, openQuestionId: string): Promise<LiveQuestion | null>;
}

/**
 * What an asked turn needs to send its one open question again (K-09 v1.12 defaults 192 to 198; ask-again.ts): the live
 * question read (the walk's own, handed in by the binding: commit/walk WalkDeps.questions) and default 131's turn key, for
 * the row's id. It only reads, on the call's transaction, and is asked only when the turn's other conditions hold.
 */
export interface AskAgainDeps<Repo = unknown> {
  readonly questions: LiveQuestions<Repo>;
  /** Default 131's turn key, from the turn row. Default: the turn's own id. */
  readonly turnKey?: (turn: TurnRow) => string;
}

/** What gateAndCommit runs with: limits 1 to 6 (../gate/limits.ts in the Worker) and the commit's ports. */
export interface CommitDeps<Repo = unknown> {
  readonly limits: LimitRegistry<Repo>;
  readonly ports: CommitPorts<Repo>;
  /**
   * Where an asked turn reads its one open question to send it again (K-09 v1.12; T-1505), as the binding hands in the
   * walk's question read. Left out, an asked turn writes nothing of its own, as before v1.12 (default 198's silence).
   */
  readonly askAgain?: AskAgainDeps<Repo>;
}

/** The gateAndCommit request, as the gate reads it. */
export type { GateRequest };
