// The turn face's gate and commit (T-1141; C-074 over C-087; K-09 v1.5 gateAndCommit): T-305's one commit per turn bound
// to what it reads and calls, each port another task's, so the commit runs for real on the turn's pinned bundle:
//
//   - the limits: the flags, then limits 1 to 6 as registered (actions/src/gate/limits.ts), but for limit 1, which is given
//     the turn's bundle's step cards (STATE note 65: Limit1Deps.steps from the pinned bundle's flow graphs, read through
//     the bundles port, KV first: rosie_app holds no grant on bundle_values), so a step's side is read from its card;
//     limit 2 is T-300's as registered (no walk proposal and no K-26 read yet: a part that may carry an owner rule is
//     refused, any other passes);
//   - writesOf: T-1139's walk after the choice on the pinned bundle's flow graphs (createWritesOf({ bundles })), with,
//     where the wiring binds them (T-1468; DL-961 card F), the question read an answer closes its question through
//     (TurnCommitBinding.questions) and the read-only step writers by step id (TurnCommitBinding.writers:
//     signUpStepWriters, T-633's S1-02, S1-03 and S1-74 and T-634's S1-11). With neither bound, as before, every answer
//     to an open question is notBuilt;
//   - runCore: T-1140's createRunCore({ safety: { reader, sealer, lines, stopWords, telling } }), built for each call:
//       reader     K-05 v1.4's safety reads (T-1161): outcomeOfEvent, outcome, hold, holdOfOutcome, outboxRowWritten and
//                  businessZone on the call's own transaction (rosie_app) with the call's own business; ownerOf through
//                  readBusinessOwner, which needs the runtime side (rosie_app holds no grant on person_handles or
//                  handles: STATE note 59), in its own transaction under the call's business; notFound,
//                  moreThanOneOwner and transient thrown, never read as none (K-05 v1.4 default 61); arrivedAt null until
//                  T-1155, so a release that needs the arrival order fails closed (release.ts default 13);
//       sealer     read-only: the person's key already exists (the gateway made it at first sight, K-05 item 29), and
//                  this binding never makes one (sealer.ts);
//       lines      the pinned bundle's checked lines (pinnedSafetyLines below), under the core's line rule (lines.ts);
//       stopWords  PLUGIN_LISTS_NO_STOP_WORDS for the barbershop (K-09 v1.1 j3-safety-arrival-own-line.json), given by
//                  the wiring, never a default;
//       telling    the wiring's TellingPort (T-1443): the paging telling port (commit/core pagingTellingPort, built on
//                  each call's repo from the paging reads, the roster and ENVIRONMENT, each failing closed), or
//                  NOT_TOLD_YET, the default every binding names until the runtime binds the port (T-1444), so an
//                  outcome that must tell someone answers notBuilt;
//     and, beside the safety ports, runCore's paging port (CoreDeps.paging; T-1443) as the wiring binds it
//     (TurnCommitBinding.paging): left out, as until T-1444, handOff, answerHandOff, pageTeam, acknowledgePage and
//     openReviewItem answer notBuilt portNotWired;
//   - openHolds: K-05 v1.3 readOpenHolds on the call's transaction (rosie_app, the call's business), naming the turn's
//     texts the safety read reads (never a tapback: default 4) whose recordSafetyOutcome is not among the request's core
//     actions and every unread id the runtime's CommitContext carries, each hold cut to K-09 safetyHold's three fields,
//     joined with CommitContext.holds read at commit time, the actor's own hold included (DL-326 note c), and
//     CommitContext.unread kept whole (DL-133; DL-326 note e): any unread id holds;
//   - commitTurn: K-05 v1.1 commitTurn, the wiring's (pg: T-306's pgCommitTurn, its own runtime transaction).
//
// Every port only reads, inside the call's business scope or in a read-only runtime transaction of its own, and hands back
// what the commit is to write: a repeated turn runs them all again before K-05 answers repeated (STATE note 1). Nothing
// here logs; a throw names a read, a fault or a code, never a value.
//
// The keyword door's commit (T-1413; DL-864, DL-877; door.ts): keywordCommitDeps binds the same commit for a core-only
// turn whose caller names no business, run inside the door's one runtime-side transaction (rosie_job, no business scope,
// rosie.person_id unset), with the limits, writesOf, the sealer and commitTurn as above, and:
//   - the safety reader in its no-business forms (noBusinessSafetyReaderOf; K-05 v1.4's five record reads with businessId
//     null, db/repo/safety-reads.ts lines 24 to 27), on the door's transaction; the owner and the zone, which need a
//     business, answer notBuilt (fails closed; DL-864 note 2);
//   - the pinned bundle's lines with every danger outcome's line answering notBuilt (noBusinessSafetyLines): with no
//     business no line row can be built and no owner told (default 5 below);
//   - runCore's flags port (CoreDeps.flags: T-317's and T-307's readers, the ids, the event sources), by name, as the door
//     binds it over its own transaction (DL-872 item 4; DL-877 C1, C2), and the safety service's own T-317 and T-307
//     readers set to the same two (never a reader on any other side: C1);
//   - openHolds with no business: K-05 v1.3 readOpenHolds with businessId null, on the door's transaction.
// The business-scoped binding (turnCommitDeps) binds no flags port: in a business-scoped turn recordStopOrStart and
// setRecordFlag stay notBuilt portNotWired (DL-877 C5; their scoped binding is a card of its own after K-05 v1.18). The
// door binds no paging port (KeywordCommitBinding has none): a keyword turn carries no paging call (isKeywordTurn), and
// with no business no hand-off or page can be written (K-36 hand_offs.business_id is not null).
//
// Defaults used (for ops/QUESTIONS.md):
//   1. A hold the actor keeps that PostgreSQL has not recorded (CommitContext hold with no hold id), or one still waiting
//      for its read (rule unread), holds as an unread text does: its event id joins unreadEventIds, so every part but a
//      protective one is held. A hold id is never made up, and nothing the actor holds is dropped.
//   2. The actor's hold and K-34's hold with the same id are both kept, so the stricter binds (STATE note 21).
//   3. The pinned bundle's checked lines are K-01's fixed lines it holds words for (crisis words, an emergency, Unsure by
//      its danger words, and the outage line). A bundle that holds any step of section 3 (the safety steps, whose cards
//      carry their own lines) answers notBuilt for a danger outcome's line, since their card lines are not read here yet
//      (fail closed); bundle v0 holds none (S1-01 and S1-02 only).
//   4. The texts named to readOpenHolds are the turn's texts the safety read reads (T-1266; K-05 item 34: "the turn's
//      texts"): an event of the turn that decide's texts name only as a tapback (K-02 v1 text kind tapback, a K-06
//      reaction) is left out, since the safety read never reads one (runtime/src/safety/arrival.ts READ_KINDS) and so no
//      K-34 row can ever say it was read (0016: one outcome row per read text). Every other event whose record is not in
//      the commit is named as before (fail closed): one decide's texts do not hold (a keyword text, or an event K-02 has
//      no text for, such as a vote taken back), one they name as a text or a vote as well, and every event of a turn with
//      no decided texts (input coreOnly), where nothing tells a tapback from a text with no record. The runtime's unread
//      ids are kept whole (DL-133).
//   5. In the keyword door's commit a danger outcome answers notBuilt (DL-864 note 2's default, fails closed; the replies
//      run the turn again): with no business the safety service builds no line row (T-307's rows need a business:
//      domain/safety/record.ts lineRows) and tells no owner, and the owner's and zone's reads need one. So the door's lines
//      answer notBuilt for every outcome but No, before any line row is planned; No sends no line, and the outage line is
//      the bundle's, as the business-scoped binding's.

import type { CommitContext } from "../../../../runtime/src/actor";
import type {
  CommitDeps,
  CommitPorts,
  CommitTurnContext,
  CoreAction,
  GateAndCommitRequest,
  OpenHolds,
  SafetyHold,
} from "../../commit";
import { createRunCore, type CoreDeps, type CoreFlagsDeps, type CoreSafetyDeps } from "../../commit/core";
import {
  createWritesOf,
  type StepWriter,
  type StepWriters,
  type WalkDeps,
  type WalkQuestions,
} from "../../commit/walk";
import type { PagingDeps } from "../../domain/paging";
import type {
  OwnerContact,
  SafetyLineChoice,
  SafetyLines,
  SafetyReader,
  StopWords,
  StoredHold,
  StoredOutcome,
  TellingPort,
  WordsSealer,
} from "../../domain/safety";
import { flowsListed } from "../../frontier/assemble/bundle";
import type { BundleId, FlowLetter, FrontierBundles } from "../../frontier/assemble/types";
import { flagsFirst } from "../../gate/flags";
import type { LimitRegistry } from "../../gate/framework";
import { createLimit1, stepCardsOf, type StepCards } from "../../gate/limit-1";
import { limit2 } from "../../gate/limit-2";
import { limit3 } from "../../gate/limit-3";
import { limit4 } from "../../gate/limit-4";
import { limit5 } from "../../gate/limit-5";
import { limit6 } from "../../gate/limit-6";
import { NotBuiltError } from "../errors";
import { kindsWriters, type KindsWriterDeps } from "../journey-1/kinds";
import { createPlugInWriters, S1_11, type PlugInDeps } from "../journey-1/plug-ins";
import { TurnFaceReadError, TurnFaceRefusedError } from "./errors";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The runtime's commit-time context (runtime/src/actor/lease.ts CommitContext), handed on unchanged by the actor. */
export type CommitAt = CommitContext;

/** Nothing open at commit time: no hold and no unread text (a caller with no actor, such as a test of one call). */
export const NOTHING_OPEN_AT: CommitAt = { holds: [], unread: [] };

// ---- the K-05 reads and calls the commit binds, each the wiring's ---------------------------------------------------

/** A K-05 notFound answer (K-05 v1 notFoundError). */
export interface NotFoundAnswer {
  readonly error: "notFound";
  readonly table: string;
  readonly rowId: string;
}

/** K-05 v1.3 readOpenHolds.request (item 34). */
export interface OpenHoldsRequest {
  readonly handleId: string;
  readonly businessId: string | null;
  readonly eventIds: readonly string[];
}

/** K-05 v1.3 readOpenHolds.response, as far as the commit reads it: each hold's three safetyHold fields, the unread ids. */
export interface OpenHoldsAnswer {
  readonly result: "openHolds";
  readonly holds: readonly {
    readonly holdId: string;
    readonly releaseRule: SafetyHold["releaseRule"];
    readonly blocksBooking: boolean;
  }[];
  readonly unreadEventIds: readonly string[];
}

/**
 * K-05 v1.4's seven safety reads as the safety service's reader takes them (T-1161's db/repo/safety-reads.ts): six on the
 * call's own transaction (`repo`), each naming the call's business, and readBusinessOwner on the runtime side in a
 * transaction of its own. Each answers K-05's response or one of its errors; the binding throws on every error.
 */
export interface SafetyReads<Repo> {
  outcomeOfEvent(
    repo: Repo,
    request: { eventId: string; businessId: string },
  ): Promise<{ safetyOutcome: StoredOutcome | null } | ErrorAnswer>;
  outcome(
    repo: Repo,
    request: { outcomeId: string; businessId: string },
  ): Promise<{ safetyOutcome: StoredOutcome | null } | ErrorAnswer>;
  hold(
    repo: Repo,
    request: { holdId: string; businessId: string },
  ): Promise<{ hold: StoredHold | null } | ErrorAnswer>;
  holdOfOutcome(
    repo: Repo,
    request: { outcomeId: string; businessId: string },
  ): Promise<{ hold: StoredHold | null } | ErrorAnswer>;
  outboxRowWritten(
    repo: Repo,
    request: { outboxRowId: string; businessId: string },
  ): Promise<{ written: boolean } | ErrorAnswer>;
  businessZone(repo: Repo, request: { businessId: string }): Promise<{ timeZone: string } | ErrorAnswer>;
  /** The runtime side's read (rosie_job), in its own transaction under the business's scope. */
  businessOwner(request: { businessId: string }): Promise<{ owner: OwnerContact | null } | ErrorAnswer>;
}

/**
 * K-05 v1.4's five record reads (items 37 to 41) in their no-business forms, as the keyword door's commit reads them
 * (T-1413): each on the door's own runtime-side transaction (`repo`: rosie_job, no business scope) with businessId null,
 * which reads only the rows with no business (db/repo/safety-reads.ts lines 24 to 27: the read names `business_id is
 * null` itself, and refuses rosie_app before any read). The owner and the zone need a business, so the door has none of
 * them (noBusinessSafetyReaderOf answers notBuilt). Each answers K-05's response or one of its errors.
 */
export interface NoBusinessSafetyReads<Repo> {
  outcomeOfEvent(
    repo: Repo,
    request: { eventId: string; businessId: null },
  ): Promise<{ safetyOutcome: StoredOutcome | null } | ErrorAnswer>;
  outcome(
    repo: Repo,
    request: { outcomeId: string; businessId: null },
  ): Promise<{ safetyOutcome: StoredOutcome | null } | ErrorAnswer>;
  hold(
    repo: Repo,
    request: { holdId: string; businessId: null },
  ): Promise<{ hold: StoredHold | null } | ErrorAnswer>;
  holdOfOutcome(
    repo: Repo,
    request: { outcomeId: string; businessId: null },
  ): Promise<{ hold: StoredHold | null } | ErrorAnswer>;
  outboxRowWritten(
    repo: Repo,
    request: { outboxRowId: string; businessId: null },
  ): Promise<{ written: boolean } | ErrorAnswer>;
}

/** Any K-05 error answer: an object with its own "error" code. */
export interface ErrorAnswer {
  readonly error: string;
}

/** What the commit binding reads and calls: K-05's calls and the pinned bundle. */
export interface TurnCommitBinding<Repo> {
  /** The pinned bundle's manifest and flow graphs (the frontier's port: KV, or PostgreSQL's copy on a miss). */
  readonly bundles: FrontierBundles;
  /** K-05 v1.1 commitTurn (T-306's pgCommitTurn on PostgreSQL). */
  readonly commitTurn: CommitPorts<Repo>["commitTurn"];
  /** K-05 v1.3 readOpenHolds on the call's transaction (rosie_app, the call's business). */
  readonly readOpenHolds: (repo: Repo, request: OpenHoldsRequest) => Promise<OpenHoldsAnswer | ErrorAnswer>;
  /** K-05 v1.4's safety reads. */
  readonly safetyReads: SafetyReads<Repo>;
  /** Seals a read's words under a person's key that already exists; never makes a key (sealer.ts). */
  readonly sealer: WordsSealer;
  /**
   * The plug-in's stop words, named by the wiring, never a default (domain/safety/ports.ts): PLUGIN_LISTS_NO_STOP_WORDS
   * for the barbershop, whose plug-in lists none (DL-344).
   */
  readonly stopWords: StopWords;
  /**
   * Hand-offs and pages (T-319), named by the wiring (T-1443): the paging telling port (commit/core pagingTellingPort,
   * built on each call's repo), or NOT_TOLD_YET, the default until the runtime binds the port (T-1444), so an outcome that
   * must tell someone answers notBuilt.
   */
  readonly telling: TellingPort<Repo>;
  /**
   * runCore's paging port (CoreDeps.paging; T-1443): the paging service's reads, ids, ENVIRONMENT and staging's roster for
   * the paging core actions a turn carries (commit/core pagingDepsOf gives them, each failing closed). Left out, as until
   * the runtime binds it (T-1444), handOff, answerHandOff, pageTeam, acknowledgePage and openReviewItem answer notBuilt.
   */
  readonly paging?: PagingDeps<Repo>;
  /**
   * The safety service's other ports, as T-1140's CoreSafetyDeps names them (T-317's and T-307's readers, ids, visits).
   * Default: the service's own, on the call's transaction.
   */
  readonly safetyExtra?: Partial<
    Omit<CoreSafetyDeps<Repo>, "reader" | "sealer" | "lines" | "stopWords" | "telling">
  >;
  /** Default 131's turn key for the walk's row ids. Default: the turn's own id. */
  readonly turnKey?: WalkDeps["turnKey"];
  /** Limits 1 to 6 for a turn, given its bundle's step cards. Default: the registry with limit 1 given them. */
  readonly limits?: (steps: (bundleId: BundleId, flow: FlowLetter) => StepCards) => LimitRegistry<Repo>;
  /**
   * Where the walk reads the open question an answer closes (T-1468; commit/walk WalkDeps.questions): on the call's
   * transaction, the live question with that id sent to the turn's handle, with the version its row is read at. Left
   * out, every answer to an open question is notBuilt, as before.
   */
  readonly questions?: WalkQuestions<Repo>;
  /**
   * The walk's read-only step writers by step id (T-1468; commit/walk WalkDeps.writers): signUpStepWriters below for the
   * sign-up steps. Left out, no writer is bound, and a walked step that gives a key or tells someone is notBuilt, as
   * before (S1-01's thread aside, which the walk writes itself).
   */
  readonly writers?: StepWriters<Repo>;
}

/**
 * What the keyword door's commit binds (keywordCommitDeps; T-1413): the turn face's binding, with K-05 v1.4's record
 * reads in their no-business forms in place of the business-scoped seven, no paging port (the top of this file), and no
 * question read or step writers (T-1468): a keyword turn carries no part, so the door's commit never walks an answer.
 */
export type KeywordCommitBinding<Repo> = Omit<
  TurnCommitBinding<Repo>,
  "safetyReads" | "paging" | "questions" | "writers"
> & {
  readonly safetyReads: NoBusinessSafetyReads<Repo>;
};

// ---- the sign-up steps' read-only writers (T-1468) -------------------------------------------------------------------

/** What the sign-up steps' writers read with: the kinds folder's ports (T-633) and the plug-in folder's (T-634). */
export interface SignUpWriterDeps {
  /**
   * Items 78 and 79, and the stop home's reads when the runtime side binds them (journey-1/kinds KindsWriterDeps). With
   * `stop` left out, S1-03's and S1-74's messages answer notBuilt, so "One isn't on the list yet" and "Not a service we
   * book" write nothing.
   */
  readonly kinds: KindsWriterDeps;
  /** The pinned bundle's trade overlays (journey-1/plug-ins PlugInDeps). */
  readonly plugIns: PlugInDeps;
}

/**
 * The read-only step writers of the sign-up steps the walk walks on S1-02's answer (T-1468; DL-961 card F), by step id,
 * for TurnCommitBinding.writers. Each call builds one kindsWriters (T-633) and one createPlugInWriters (T-634), which
 * serve all four steps, so each keeps what it remembers of one walk for the steps after it:
 *   - S1-02: T-633's writer inside T-634's `kinds` wrapper, the wrapper outermost and nothing around or inside it, so the
 *     walk's own call (its turn context and the part's index) reaches both as it is: T-634's keeps the picks S1-11
 *     loads from, T-633's the answer S1-03 drafts from;
 *   - S1-03 and S1-74: T-633's, of the same kindsWriters as S1-02's;
 *   - S1-11: T-634's, of the same createPlugInWriters as the wrapper;
 *   - any other step id, S1-01 and S1-04 among them: null, so the walk writes S1-01's thread and S1-04's question
 *     itself, and refuses any other step that writes something (notBuilt).
 * It reads nothing and logs nothing. What a writer throws leaves as thrown and fails the call closed: a failed item 78
 * or item 79 read is KindsReadError, whose `answer` holds a SQLSTATE or a person's or a business's row id, so nothing
 * here catches, wraps or reports it (a caller that reports it names its name, read and fault alone).
 */
export function signUpStepWriters<Repo>(deps: SignUpWriterDeps): StepWriters<Repo> {
  const kinds = kindsWriters<Repo>(deps.kinds);
  const plugIns = createPlugInWriters<Repo>(deps.plugIns);
  const bound: ReadonlyMap<string, StepWriter<Repo>> = new Map<string, StepWriter<Repo>>([
    ["S1-02", plugIns.kinds(kinds["S1-02"])],
    ["S1-03", kinds["S1-03"]],
    ["S1-74", kinds["S1-74"]],
    [S1_11, plugIns.plugIns],
  ]);
  return (stepId) => bound.get(stepId) ?? null;
}

// ---- openHolds: K-05 readOpenHolds joined with the runtime's commit-time context ------------------------------------

/** The four K-34 release rules a safetyHold takes (K-09 v1 safetyHold.releaseRule). */
const RELEASE_RULES: readonly string[] = ["at_once", "when_private", "after_safe", "never"];

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

/** The event ids whose recordSafetyOutcome rides among the request's core actions (their outcome is this commit's). */
function recordedInThisCommit(core: readonly CoreAction[]): ReadonlySet<string> {
  const recorded = new Set<string>();
  for (const action of core) {
    if (action.call !== "recordSafetyOutcome") continue;
    const safety: unknown = (action.request as { safety?: unknown }).safety;
    if (isRecord(safety) && typeof safety.eventId === "string") recorded.add(safety.eventId);
  }
  return recorded;
}

/**
 * The turn's events the safety read never reads (default 4): each that decide's texts name as a tapback and as nothing
 * else. None for a turn with no decided texts.
 */
function neverReadIn(request: GateAndCommitRequest): ReadonlySet<string> {
  if (request.input.kind !== "decided") return new Set();
  const { texts } = request.input.decided.context;
  const textOrVote = new Set(texts.filter((text) => text.kind !== "tapback").map((text) => text.eventId));
  return new Set(
    texts
      .filter((text) => text.kind === "tapback" && !textOrVote.has(text.eventId))
      .map((text) => text.eventId),
  );
}

/** The actor's holds as the commit reads them (defaults 1 and 2): K-34 holds by id, every other one as an unread text. */
function actorHolds(at: CommitAt): { holds: SafetyHold[]; unread: string[] } {
  const holds: SafetyHold[] = [];
  const unread: string[] = [];
  for (const hold of at.holds) {
    if (hold.holdId !== null && RELEASE_RULES.includes(hold.rule)) {
      holds.push({
        holdId: hold.holdId,
        releaseRule: hold.rule as SafetyHold["releaseRule"],
        blocksBooking: hold.blocksBooking,
      });
    } else {
      unread.push(hold.eventId);
    }
  }
  return { holds, unread };
}

/**
 * The commit's openHolds port for one call: readOpenHolds on the call's transaction under its business (`businessOf`:
 * the call's own; the keyword door's, none), naming the turn's texts the safety read reads whose outcome does not ride in
 * this commit (never a tapback: default 4) and the runtime's unread ids, joined with what the runtime holds at commit
 * time (`at`). A read that answers an error fails the call closed.
 */
export function openHoldsPort<Repo>(
  at: CommitAt,
  readOpenHolds: TurnCommitBinding<Repo>["readOpenHolds"],
  businessOf: (turn: CommitTurnContext<Repo>) => string | null = (turn) => turn.businessId,
): CommitPorts<Repo>["openHolds"] {
  return async (turn: CommitTurnContext<Repo>): Promise<OpenHolds> => {
    const recorded = recordedInThisCommit(turn.request.core);
    const neverRead = neverReadIn(turn.request);
    const texts = turn.turn.eventIds.filter((id) => !recorded.has(id) && !neverRead.has(id));
    const eventIds = unique([...texts, ...at.unread]);
    const answer = await readOpenHolds(turn.repo, {
      handleId: turn.turn.handleId,
      businessId: businessOf(turn),
      eventIds,
    });
    if ("error" in answer) throw new TurnFaceReadError("readOpenHolds", answer.error);
    const actor = actorHolds(at);
    return {
      holds: [
        ...answer.holds.map((hold) => ({
          holdId: hold.holdId,
          releaseRule: hold.releaseRule,
          blocksBooking: hold.blocksBooking,
        })),
        ...actor.holds,
      ],
      unreadEventIds: unique([...answer.unreadEventIds, ...at.unread, ...actor.unread]),
    };
  };
}

// ---- runCore's safety reader over K-05 v1.4 ---------------------------------------------------------------------------

/** A read's answer, or its error thrown (default 61 of K-05 v1.4: an error is never read as none). */
function answered<T extends object>(read: string, answer: T | ErrorAnswer): T {
  if ("error" in answer) throw new TurnFaceReadError(read, answer.error);
  return answer;
}

/**
 * The safety service's reader for one call: every read names the call's own business, the In reads on the call's
 * transaction, the owner on the runtime side; arrivedAt null until T-1155 (release.ts default 13: fail closed).
 */
export function safetyReaderOf<Repo>(reads: SafetyReads<Repo>, repo: Repo, businessId: string): SafetyReader {
  return {
    async outcomeOfEvent(eventId) {
      return answered("readSafetyOutcomeOfEvent", await reads.outcomeOfEvent(repo, { eventId, businessId }))
        .safetyOutcome;
    },
    async outcome(outcomeId) {
      return answered("readSafetyOutcome", await reads.outcome(repo, { outcomeId, businessId }))
        .safetyOutcome;
    },
    async hold(holdId) {
      return answered("readSafetyHold", await reads.hold(repo, { holdId, businessId })).hold;
    },
    async holdOfOutcome(outcomeId) {
      return answered("readSafetyHoldOfOutcome", await reads.holdOfOutcome(repo, { outcomeId, businessId }))
        .hold;
    },
    async outboxRowWritten(rowId) {
      return answered(
        "readOutboxRowWritten",
        await reads.outboxRowWritten(repo, { outboxRowId: rowId, businessId }),
      ).written;
    },
    async ownerOf(asked) {
      // Only the call's own business is read: the service names it (record.ts lineRows), and another is refused.
      if (asked !== businessId) throw new TurnFaceReadError("readBusinessOwner", "otherBusiness");
      return answered("readBusinessOwner", await reads.businessOwner({ businessId })).owner;
    },
    async businessZone(asked) {
      if (asked !== businessId) throw new TurnFaceReadError("readBusinessZone", "otherBusiness");
      return answered("readBusinessZone", await reads.businessZone(repo, { businessId })).timeZone;
    },
    arrivedAt: () => Promise.resolve(null),
  };
}

/**
 * The safety service's reader for one call of the keyword door (T-1413): K-05 v1.4's five record reads in their
 * no-business forms (businessId null) on the door's own runtime-side transaction, `repo`, which reads only the rows with
 * no business (db/repo/safety-reads.ts lines 24 to 27). The business's owner and zone need a business, so with none each
 * answers notBuilt (fails closed; DL-864 note 2) and nothing is read; arrivedAt null until T-1155, as safetyReaderOf's.
 */
export function noBusinessSafetyReaderOf<Repo>(reads: NoBusinessSafetyReads<Repo>, repo: Repo): SafetyReader {
  const businessId = null;
  const needsBusiness = (): Promise<never> => Promise.reject(new NotBuiltError("recordSafetyOutcome"));
  return {
    async outcomeOfEvent(eventId) {
      return answered("readSafetyOutcomeOfEvent", await reads.outcomeOfEvent(repo, { eventId, businessId }))
        .safetyOutcome;
    },
    async outcome(outcomeId) {
      return answered("readSafetyOutcome", await reads.outcome(repo, { outcomeId, businessId }))
        .safetyOutcome;
    },
    async hold(holdId) {
      return answered("readSafetyHold", await reads.hold(repo, { holdId, businessId })).hold;
    },
    async holdOfOutcome(outcomeId) {
      return answered("readSafetyHoldOfOutcome", await reads.holdOfOutcome(repo, { outcomeId, businessId }))
        .hold;
    },
    async outboxRowWritten(rowId) {
      return answered(
        "readOutboxRowWritten",
        await reads.outboxRowWritten(repo, { outboxRowId: rowId, businessId }),
      ).written;
    },
    ownerOf: needsBusiness,
    businessZone: needsBusiness,
    arrivedAt: () => Promise.resolve(null),
  };
}

// ---- the pinned bundle's checked lines (default 3) and step cards (STATE note 65) ------------------------------------

/** K-01 v1's fixed lines a manifest holds words for (status asWritten, text given), by id. */
function heldFixedLines(manifest: Json): ReadonlySet<string> {
  const lists = isRecord(manifest.lists) ? manifest.lists : {};
  const fixedLines = isRecord(lists.fixedLines) ? lists.fixedLines : {};
  const lines: unknown[] = Array.isArray(fixedLines.lines) ? fixedLines.lines : [];
  return new Set(
    lines.flatMap((line) =>
      isRecord(line) &&
      typeof line.id === "string" &&
      line.status === "asWritten" &&
      typeof line.text === "string"
        ? [line.id]
        : [],
    ),
  );
}

/** The step ids one K-01 v1 flow graph holds. */
function stepIdsOf(graph: unknown): string[] {
  return isRecord(graph) && isRecord(graph.steps) ? Object.keys(graph.steps) : [];
}

/** A section 3 step (the safety steps A3-xx and their flow B twins B3-xx), whose card carries its own checked line. */
const SAFETY_SECTION = /^[AB]3-/u;

/** The pinned bundle's manifest, refused when neither KV nor PostgreSQL's copy holds it. */
async function manifestOf(bundles: FrontierBundles, bundleId: BundleId): Promise<Json> {
  const manifest = await bundles.manifest(bundleId);
  if (!isRecord(manifest)) throw new TurnFaceRefusedError("bundleMissing");
  return manifest;
}

/**
 * The checked lines of the turn's pinned bundle (default 3): K-01's crisis, emergency and outage lines it holds words
 * for, each to the writer; a danger outcome's line is refused (notBuilt) when the bundle holds a safety step, whose own
 * card line is not read here yet. The core's line rule goes on top (commit/core/lines.ts coreSafetyLines).
 */
export async function pinnedSafetyLines(bundles: FrontierBundles, bundleId: BundleId): Promise<SafetyLines> {
  const manifest = await manifestOf(bundles, bundleId);
  const held = heldFixedLines(manifest);
  const graphs = await Promise.all(flowsListed(manifest).map((flow) => bundles.flow(bundleId, flow)));
  const holdsSafetyStep = graphs.some((graph) => stepIdsOf(graph).some((id) => SAFETY_SECTION.test(id)));
  const line = (fixedLineId: string): SafetyLineChoice | null =>
    held.has(fixedLineId) ? { fixedLineId, to: "writer", hotline: null } : null;
  return {
    lineOf(outcome, wordKinds) {
      if (outcome === "No") return null;
      if (holdsSafetyStep) throw new NotBuiltError("recordSafetyOutcome");
      switch (outcome) {
        case "Crisis words":
          return line("safetyCrisis");
        case "An emergency":
          return line("safetyEmergency");
        case "Unsure":
          return line(wordKinds.includes("selfHarm") ? "safetyCrisis" : "safetyEmergency");
        default:
          return null;
      }
    },
    outageLine: () => (held.has("outage") ? "outage" : null),
  };
}

/**
 * The keyword door's checked lines over the pinned bundle's (default 5): No sends nothing, as everywhere; every other
 * outcome's line answers notBuilt, since with no business no line row is built and no owner is told; the outage line is
 * the bundle's own.
 */
export function noBusinessSafetyLines(lines: SafetyLines): SafetyLines {
  return {
    lineOf(outcome) {
      if (outcome === "No") return null;
      throw new NotBuiltError("recordSafetyOutcome");
    },
    outageLine: () => lines.outageLine(),
  };
}

/**
 * Limit 1's step cards for a turn (STATE note 65; T-299's Limit1Deps.steps): the turn's bundle's flow graphs it lists,
 * the context's flow first, read once when limit 1 first asks for a step. A bundle that cannot be read gives no card, so
 * every step's side is the business's (DL-188 ruling 1; fails closed).
 */
export function bundleStepCards(
  bundles: FrontierBundles,
): (bundleId: BundleId, flow: FlowLetter) => StepCards {
  return (bundleId, flow) => {
    let cards: Promise<StepCards> | null = null;
    const load = async (): Promise<StepCards> => {
      const manifest = await bundles.manifest(bundleId);
      if (!isRecord(manifest)) return stepCardsOf([]);
      const listed = flowsListed(manifest);
      const other: FlowLetter = flow === "A" ? "B" : "A";
      const order = [flow, other].filter((each) => listed.includes(each));
      return stepCardsOf(await Promise.all(order.map((each) => bundles.flow(bundleId, each))));
    };
    return { step: async (stepId) => (await (cards ??= load())).step(stepId) };
  };
}

/** The flags, then limits 1 to 6 as registered, limit 1 given the turn's bundle's step cards (STATE note 65). */
export function turnLimits<Repo>(
  steps: (bundleId: BundleId, flow: FlowLetter) => StepCards,
): LimitRegistry<Repo> {
  return flagsFirst([createLimit1({ steps }), limit2, limit3, limit4, limit5, limit6]);
}

// ---- the commit's deps for one call -----------------------------------------------------------------------------------

/** The walk's question read and step writers as a binding names them: each present only when bound (T-1468). */
type WalkAnswerDeps<Repo> = Pick<WalkDeps<Repo>, "questions" | "writers">;

/**
 * The commit's deps over one binding: the limits, writesOf and commitTurn as bound, runCore with the core's deps for the
 * turn's pinned lines (built for each action: DL-864 note 4), and openHolds under the business `businessOf` names.
 * writesOf is handed the walk's question read and step writers only as `answers` names them, each only when present
 * (T-1468): the turn face's binding's own, and none for the keyword door, whatever its binding object carries.
 */
function commitDepsWith<Repo>(
  binding: Omit<TurnCommitBinding<Repo>, "safetyReads" | "questions" | "writers">,
  answers: WalkAnswerDeps<Repo>,
  coreDeps: (lines: SafetyLines, turn: CommitTurnContext<Repo>) => CoreDeps<Repo>,
  businessOf?: (turn: CommitTurnContext<Repo>) => string | null,
): (at: CommitAt) => CommitDeps<Repo> {
  const { bundles } = binding;
  const steps = bundleStepCards(bundles);
  const writesOf = createWritesOf<Repo>({
    bundles,
    ...(binding.turnKey === undefined ? {} : { turnKey: binding.turnKey }),
    ...(answers.questions === undefined ? {} : { questions: answers.questions }),
    ...(answers.writers === undefined ? {} : { writers: answers.writers }),
  });
  const limitsOf = binding.limits ?? turnLimits;
  return (at) => {
    const runCore: CommitPorts<Repo>["runCore"] = async (action, turn, open) => {
      const lines = await pinnedSafetyLines(bundles, turn.turn.bundleId);
      const run = createRunCore<Repo>(coreDeps(lines, turn));
      return run(action, turn, open);
    };
    return {
      limits: limitsOf(steps),
      ports: {
        commitTurn: binding.commitTurn,
        writesOf,
        runCore,
        openHolds: openHoldsPort(at, binding.readOpenHolds, businessOf),
      },
    };
  };
}

/**
 * The commit's deps for one gateAndCommit call, given the runtime's commit-time context: the limits, writesOf, runCore,
 * openHolds and commitTurn as the top of this file binds them. No flags port is bound, so in this business-scoped commit
 * recordStopOrStart and setRecordFlag answer notBuilt portNotWired (DL-877 C5); the paging port is the binding's own
 * (TurnCommitBinding.paging), none until the runtime binds it (T-1444). The walk's question read and step writers are
 * the binding's own too (TurnCommitBinding.questions and .writers; T-1468): with either left out the walk runs without
 * it, as before.
 */
export function turnCommitDeps<Repo>(binding: TurnCommitBinding<Repo>): (at: CommitAt) => CommitDeps<Repo> {
  const { paging, questions, writers } = binding;
  const answers: WalkAnswerDeps<Repo> = {
    ...(questions === undefined ? {} : { questions }),
    ...(writers === undefined ? {} : { writers }),
  };
  return commitDepsWith(binding, answers, (lines, turn) => ({
    safety: {
      ...binding.safetyExtra,
      reader: (repo) => safetyReaderOf(binding.safetyReads, repo, turn.businessId),
      sealer: () => binding.sealer,
      lines,
      stopWords: binding.stopWords,
      telling: binding.telling,
    },
    ...(paging === undefined ? {} : { paging }),
  }));
}

/**
 * The keyword door's commit deps for one call (T-1413; door.ts), given the runtime's commit-time context: the same commit
 * as turnCommitDeps', on the runtime side with no business (the top of this file): the safety reader in its no-business
 * forms, the door's lines (default 5), the flags port `flags` the door binds over its own transaction (DL-872 item 4:
 * reader, messagesReader, ids, events, by name; runCore answers notBuilt portNotWired with any one missing), the safety
 * service's T-317 and T-307 readers set to the same two (DL-877 C1), and openHolds with no business. The walk gets no
 * question read and no step writer here (T-1468).
 */
export function keywordCommitDeps<Repo>(
  binding: KeywordCommitBinding<Repo>,
  flags: CoreFlagsDeps<Repo>,
): (at: CommitAt) => CommitDeps<Repo> {
  return commitDepsWith(
    binding,
    {},
    (lines) => ({
      safety: {
        ...binding.safetyExtra,
        flagsReader: flags.reader,
        messagesReader: flags.messagesReader,
        reader: (repo) => noBusinessSafetyReaderOf(binding.safetyReads, repo),
        sealer: () => binding.sealer,
        lines: noBusinessSafetyLines(lines),
        stopWords: binding.stopWords,
        telling: binding.telling,
      },
      flags,
    }),
    () => null,
  );
}
