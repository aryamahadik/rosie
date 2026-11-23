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
//     to an open question is notBuilt. And, where the wiring binds them (T-1502; K-09 README default 191; T-1503 binds
//     them on staging), the read-only settlers by step id (TurnCommitBinding.settlers: signUpSteps, S1-02's settler over
//     the same kinds ports and one catalog read per walk shared with S1-02's writer), so the owner's words, not the option
//     decide named, settle S1-02's branch. Left out, the walk is exactly as before. And, where the wiring binds it
//     (T-1519; DL-1048), K-05 v1.10 item 51's readChatHandle on the runtime side (TurnCommitBinding.readChatHandle), which
//     the walk asks for the turn's Linq chat id, handed only the handle id it answers (walkChatsOf, never the number), so
//     S1-01 reuses the handle's own chat thread for that chat instead of inserting a second one (commit/walk writes.ts
//     default 12). Left out, S1-01's thread is inserted as before. And, where the wiring binds them (T-1493, H1a; K-09
//     README default 199; DL-1033, DL-1075), the read-only buttons settlers by step id (TurnCommitBinding.buttonsSettlers:
//     signUpSteps' S1-04 one-kind settler, T-1492's), so an owner who names exactly one kind of work is never asked S1-04:
//     the walk settles S1-04 and goes on to S1-08's row and S1-09's question. Left out, S1-04 is asked as before. And,
//     where the wiring hands signUpSteps the same companies reads and S1-04's writer's own deps (T-1484, H1b; K-09 README
//     defaults 181 to 185 and 190; DL-1033, DL-1121: SignUpWriterDeps.s1_04Writer, with the party rule's flag), S1-04's
//     own writer by step id (T-1481's companiesWriter) among TurnCommitBinding.writers, so an owner's answer to an S1-04
//     that was asked ("All share one", in words or by its button) closes the question, places the kept picks in the
//     companies the button gives (a second company only with the flag on) and walks on to S1-08's row and S1-09's
//     question. Left out, an answered S1-04 is notBuilt (gives), as before. And, where the wiring hands signUpSteps the
//     listing deps (T-1537, S1-09 design card 7 extended to S1-10; DL-1171; K-09 README defaults 201 to 211:
//     SignUpWriterDeps.listing, with the Places port, S1-09's and S1-10's K-05 reads, the stop reads, the paging ports
//     and the secure link's port whose stage is the face's HeldLinks), S1-09's settler among TurnCommitBinding.settlers
//     and the S1-09, S1-76 and S1-10 writers among TurnCommitBinding.writers, all four over one walk's readings (T-635a's
//     walkReadings, as T-1533's mobileIdSteps builds them), so an owner's typed details settle S1-09's branch, write
//     the typed name, the read-back or S1-76's row and review item, and S1-10's accounts row, link row and text, and
//     the walk waits at S1-10 (T-1532); words with no details or no town answer "ask", so S1-09 is sent again once
//     (T-1528, default 7). Left out, S1-09 has no settler and none of the three writers is bound, as before;
//   - askAgain (T-1505; K-09 v1.12 defaults 192 to 198): where the binding hands in the walk's question read
//     (TurnCommitBinding.questions), the commit is handed the same read with the walk's turn key (CommitDeps.askAgain),
//     so a turn whose parts decide ended in one question, with exactly one open question, sends that question again once
//     with K-05 v1.21's raise of its ask count (commit/ask-again.ts). Left out, an asked turn writes nothing, as before;
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
//   6. (T-1493; restated by T-1484, H1b) signUpSteps' new deps are independent of each other. `companies` binds S1-02's
//      one-kind wrapper and S1-04's buttons settler together, from one createOneKind instance (never one without the
//      other: T-1492's default O6). `s1_04Writer` (T-1484) binds S1-04's own writer, T-1481's companiesWriter over those
//      same `companies` reads, with the party rule's flag it carries, and is read only beside `companies` (with no reads
//      there is nothing to write with, so S1-04 gets no writer). It is a dep of its own, not `companies` alone, so a
//      binding that hands `companies` and not it (staging's since T-1494, H2a) keeps H1a's writers, step for step, until
//      its own card hands it in (H2b, T-1485: runtime/src/wiring/real.ts). `plan` binds S1-08's writer alone, whenever it
//      is given, with or without `companies`: S1-08 is reached both by a one-kind S1-02 answer (the settler) and by an
//      answered S1-04 (its writer), so a caller hands `plan` wherever it binds S1-08's stop reads, not only beside
//      `companies` (H1a's and H2a's reviewers' note: real.ts signUpOneKindOf, H2b's to change). With `companies` and no
//      `plan`, either walk reaches S1-08 with no writer and is refused (notBuilt) with nothing written, as with `plan` and
//      no stop reads; without `companies` and `s1_04Writer`, S1-04 has no writer, so an answer to it is notBuilt, as
//      before. signUpStepWriters reads none of them: it binds no settler, and a wrapper bound without its settler would
//      place a pick and still ask S1-04.
//   7. (T-1537; K-09 README defaults 201, 203 (a) and (c), 207; open gap 179; T-1528's handoff (1)) signUpSteps' `listing`
//      binds S1-09's settler, S1-09's and S1-76's writers (T-635a) and S1-10's writer (T-1533) together over one
//      walkReadings, or none of them; it is independent of `companies`, `s1_04Writer` and `plan` (default 6), and
//      signUpStepWriters never reads it (a writer with no settler refuses notSettled or claimUnknown). S1-09's settler is
//      T-635a's s1_09Settler over those readings, but for the reading's "ask" (no details, or a name with no town), which
//      it answers as the walk's reserved SETTLER_ASKS instead of refusing listingNeedsDetails: default 201 has the
//      binding change for T-1528, and listing/settle.ts keeps the reading's three outcomes so only the binding changes.
//      The banned-word read is never handed in (default 206; open gap 187), and the secure link's generator is never
//      handed in either, so the code is always crypto.getRandomValues' (link.ts WEB_CRYPTO_FILL; T-1533's security note
//      a): the binding copies the link's host, base path, clock and stage alone.

import type { CommitContext } from "../../../../runtime/src/actor";
import type {
  AskAgainDeps,
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
  type ButtonsSettlers,
  type StepSettler,
  type StepSettlers,
  type StepWriter,
  type StepWriters,
  type WalkChats,
  type WalkDeps,
  type WalkQuestions,
} from "../../commit/walk";
import { SETTLER_ASKS } from "../../commit/walk/settle";
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
import type { StopHomeReads } from "../../homes/stop";
import { NotBuiltError } from "../errors";
import {
  S1_04,
  companiesWriter,
  createOneKind,
  type CompaniesReads,
  type OneKind,
} from "../journey-1/companies";
import { kindsSteps, kindsWriters, type KindsWriterDeps, type KindsWriters } from "../journey-1/kinds";
import type { ListingSearch } from "../journey-1/listing/lookup";
import type { ListingReads } from "../journey-1/listing/reads";
import { S1_09, S1_76, s1_09Settler, walkReadings } from "../journey-1/listing/settle";
import { listingWriters } from "../journey-1/listing/writers";
import type { LinkPlace } from "../journey-1/mobile-id/link";
import type { MobileIdReads } from "../journey-1/mobile-id/reads";
import { MOBILE_ID_STEP, mobileIdWriter } from "../journey-1/mobile-id/writer";
import { PLAN_STEP, planWriter, type PlanWriterDeps } from "../journey-1/plan";
import { createPlugInWriters, S1_11, type PlugInDeps, type PlugInWriters } from "../journey-1/plug-ins";
import { TurnFaceReadError, TurnFaceRefusedError } from "./errors";
import type { HeldLinks } from "./held";

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

/** K-05 v1.10 readChatHandle.request (item 51): Linq's chat id alone. */
export interface ChatHandleRequest {
  readonly linqChatId: string;
}

/**
 * K-05 v1.10 readChatHandle.response, as far as the commit reads it: the id of the phone handle whose chat thread holds
 * the chat id, or null when none does. The number it also answers is never read here nor handed to the walk.
 */
export interface ChatHandleAnswer {
  readonly handleId: string | null;
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
  /**
   * The walk's read-only settlers by step id (T-1502; K-09 README default 191; commit/walk WalkDeps.settlers): signUpSteps
   * below for S1-02, built with the writers over one catalog read per walk. The walk asks one only at a split step, for a
   * passed part that chooses an option of that step's open question and that no hold keeps back. Left out, no settler is
   * bound and the walk is exactly as before: the option decide named is walked, and S1-02's writer refuses a branch that
   * does not fit the words (branchNotWords).
   */
  readonly settlers?: StepSettlers<Repo>;
  /**
   * The walk's read-only buttons settlers by step id (T-1493, H1a; K-09 README default 199; commit/walk
   * WalkDeps.buttonsSettlers): signUpSteps' S1-04 one-kind settler (T-1492's), built from the same createOneKind instance
   * as the wrapper around S1-02's writer, so the settler and the wrapper share one walk's reads and placement. The walk asks
   * one only where it would stop at a plain step with buttons (S1-04) and no hold keeps that step back. Left out, no
   * buttons settler is bound and S1-04 is asked exactly as before.
   */
  readonly buttonsSettlers?: ButtonsSettlers<Repo>;
  /**
   * K-05 v1.10 item 51's readChatHandle (T-1519; DL-1048): the phone handle whose chat thread holds a Linq chat id, read on
   * the runtime side (rosie_job, no business scope, a read-only transaction of its own: threads and handles are scoped
   * none, and rosie_app holds no grant on either), never on the call's transaction. The walk asks it once for the turn's
   * chat id when S1-01 writes the handle's thread, and reuses the handle's own chat thread when the answer names the
   * turn's handle (commit/walk writes.ts default 12); an error answer fails the call closed. Left out, S1-01's thread is
   * inserted as before.
   */
  readonly readChatHandle?: (request: ChatHandleRequest) => Promise<ChatHandleAnswer | ErrorAnswer>;
}

/**
 * What the keyword door's commit binds (keywordCommitDeps; T-1413): the turn face's binding, with K-05 v1.4's record
 * reads in their no-business forms in place of the business-scoped seven, no paging port (the top of this file), and no
 * question read, step writers, settlers, buttons settlers or chat read (T-1468, T-1502, T-1493, T-1519): a keyword turn
 * carries no part, so the door's commit never walks.
 */
export type KeywordCommitBinding<Repo> = Omit<
  TurnCommitBinding<Repo>,
  "safetyReads" | "paging" | "questions" | "writers" | "settlers" | "buttonsSettlers" | "readChatHandle"
> & {
  readonly safetyReads: NoBusinessSafetyReads<Repo>;
};

// ---- the sign-up steps' read-only writers (T-1468) -------------------------------------------------------------------

/**
 * S1-04's writer's own deps beside the companies reads (T-1484, H1b; journey-1/companies CompaniesWriterDeps without its
 * reads, which are SignUpWriterDeps.companies): the party rule's flag.
 */
export interface S1_04WriterDeps {
  /**
   * Whether the party rule is live (K-09 README default 184; open gap 149): true lets an S1-04 answer write a second
   * company ("Some share one" or "Each is its own" whose groups come to more than one company); left out, or anything but
   * true, it is off, and such an answer is refused (CompaniesRefusedError secondCompany) with nothing written and the
   * question left open. Staging leaves it off until K-05's party version and its db/repo read are live (cards 17 to 19).
   */
  readonly partyRuleLive?: boolean;
}

/**
 * What the sign-up steps' writers read with: the kinds folder's ports (T-633) and the plug-in folder's (T-634), and,
 * for signUpSteps alone (T-1493, H1a; T-1484, H1b), the one-kind path's reads (T-1492), which S1-04's writer (T-1481)
 * reads through too, given its own deps, and S1-08's writer's own deps (T-1482). `Repo` is the call's repo, which the
 * companies reads are handed (item 72 and the catalog by id and names).
 */
export interface SignUpWriterDeps<Repo = unknown> {
  /**
   * Items 78 and 79, and the stop home's reads when the runtime side binds them (journey-1/kinds KindsWriterDeps). With
   * `stop` left out, S1-03's and S1-74's messages answer notBuilt, so "One isn't on the list yet" and "Not a service we
   * book" write nothing. S1-08's writer never reads this `stop`: it has its own (`plan`; CQ-360).
   */
  readonly kinds: KindsWriterDeps;
  /** The pinned bundle's trade overlays (journey-1/plug-ins PlugInDeps). */
  readonly plugIns: PlugInDeps;
  /**
   * The one-kind path's reads (T-1493; K-09 README default 199 items (1) to (4); journey-1/companies CompaniesReads: item
   * 79, item 72 and K-24's catalog by id and names, each answer or a thrown error). Given, signUpSteps builds one
   * createOneKind over them per call and binds S1-02 as T-634's `kinds` wrapper around T-1492's one-kind wrapper around
   * T-633's writer, and S1-04's buttons settler from the same instance (SignUpSteps.buttonsSettlers), so an owner with
   * exactly one kept kind of work is never asked S1-04; and, with `s1_04Writer` too (T-1484, H1b), S1-04's own writer
   * over the same reads. Left out, none of them: S1-02 is bound as before, S1-04 is asked, and an answer to it is
   * notBuilt. signUpStepWriters never reads it (it binds no settler, so a placed pick with S1-04 still asked could never
   * happen).
   */
  readonly companies?: CompaniesReads<Repo>;
  /**
   * S1-04's writer's own deps (T-1484, H1b; K-09 README defaults 181 to 185 and 190; default 6), read only beside
   * `companies`. Given (`{}` included), signUpSteps binds T-1481's companiesWriter at S1-04 over the `companies` reads,
   * with the party rule's flag off unless `partyRuleLive` is exactly true, so an answer to an S1-04 that was asked closes
   * it at its version, places the caller's kept picks in the companies its button gives and walks on to S1-08. Left out,
   * or with `companies` left out, no writer is bound at S1-04, as before: an answered S1-04 is notBuilt (gives).
   */
  readonly s1_04Writer?: S1_04WriterDeps;
  /**
   * S1-08's writer's own deps (T-1493; T-1482's PlanWriterDeps; K-09 README defaults 189 and 199 item (5)): the stop
   * home's reads S1-08's writer rules its one quick reply with, a field of S1-08's own beside `kinds.stop`, which S1-03's
   * and S1-74's writers keep as they are (CQ-360). Given, signUpSteps binds planWriter(plan) at S1-08, with or without
   * `companies` (default 6: a one-kind S1-02 answer and an answered S1-04 both walk on to S1-08); with its `stop` left
   * out that writer answers notBuilt (stopNotWired), so a walk that reaches S1-08 is refused with nothing written. Left
   * out, no writer is bound at S1-08, as before, and a walk that reaches it is refused the same way (notBuilt: S1-08 tells
   * the owner). signUpStepWriters never reads it.
   */
  readonly plan?: PlanWriterDeps;
  /**
   * S1-09's, S1-76's and S1-10's deps (T-1537; S1-09 design card 7 extended to S1-10, DL-1171; K-09 README defaults 201
   * to 211; default 7), handed in together. Given, signUpSteps binds S1-09's settler and the S1-09, S1-76 and S1-10
   * writers over one walk's readings, so the owner's typed details, not the option decide named, settle S1-09's branch
   * (the Places lookup alone says whether the listing matches), the walk writes S1-09's and S1-76's rows and S1-10's,
   * and waits at S1-10 (T-1532), and words that give no details or no town are asked again once (T-1528). Left out,
   * S1-09 has no settler and none of the three writers is bound, as before: a decided S1-09 answer is refused (notBuilt)
   * with nothing written. signUpStepWriters never reads it.
   */
  readonly listing?: SignUpListingDeps<Repo>;
}

/**
 * S1-10's secure link's port as the turn face binds it (T-1537; K-09 README default 211; T-1533's handoff): the Worker's
 * LINK_HOST and BASE_PATH, the writer's clock, and the face's own HeldLinks as the stage, the same object the caller hands
 * the face as TurnFaceCalls.links and the row bindings as RowBinding.links (pg/calls.ts pgTurnCalls takes it from here),
 * so the code a fresh commit wrote reaches finalize's link.secure and nothing else. No generator is taken: the code is
 * always crypto.getRandomValues' (default 7).
 */
export interface SignUpLinkDeps extends LinkPlace {
  /** The writer's clock, read once per S1-10 write: the link's issued_at (default 211). */
  readonly now: () => Date;
  /** The face's hold (held.ts HeldLinks): S1-10's writer stages the plain link in it, by its turn and outbox row. */
  readonly stage: HeldLinks;
}

/**
 * What S1-09's settler and the S1-09, S1-76 and S1-10 writers read with, every port required (T-1537; default 7), each
 * named in its own file (journey-1/listing, journey-1/mobile-id). `Repo` is the call's repo, which the item 26 reads are
 * handed (and never read through on PostgreSQL: pgListingReads and pgMobileIdReads run as rosie_job beside the call's).
 */
export interface SignUpListingDeps<Repo = unknown> {
  /**
   * K-15's search (T-434's PlacesPort), which S1-09's settler alone reads, at most three searches a part (default 202).
   * While J-16 is open, staging's is the double, on allow-listed phones only (default 208).
   */
  readonly places: ListingSearch;
  /** S1-09's writer's reads: item 79 and item 26 (journey-1/listing pgListingReads(runtime): rosie_job). */
  readonly reads: ListingReads<Repo>;
  /**
   * The stop home's reads, bound on the runtime side: S1-09's read-back, S1-76's message and S1-10's text are each
   * written only where mayText lets Rosie text this owner (default 189).
   */
  readonly stop: StopHomeReads;
  /**
   * T-319's paging ports for S1-76's one listing_match review item: a reader that answers reviewItem (with its summary),
   * row("businesses", id) and businessZone, and the ids (default: the Worker's keyed ids).
   */
  readonly paging: PagingDeps<Repo>;
  /** S1-10's writer's own ports (T-1533). */
  readonly mobileId: {
    /** Item 79 and item 26 (journey-1/mobile-id pgMobileIdReads(runtime): the same K-05 reads as `reads`'). */
    readonly reads: MobileIdReads<Repo>;
    /** The secure link's port, its stage the face's HeldLinks. */
    readonly link: SignUpLinkDeps;
  };
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
 * here catches, wraps or reports it (a caller that reports it names its name, read and fault alone). The one-kind path,
 * S1-04's writer, S1-08's writer and the listing's settler and writers (SignUpWriterDeps.companies, .s1_04Writer, .plan
 * and .listing) are signUpSteps' alone: this map never reads them.
 */
export function signUpStepWriters<Repo>(deps: SignUpWriterDeps<Repo>): StepWriters<Repo> {
  return stepWritersOf(kindsWriters<Repo>(deps.kinds), createPlugInWriters<Repo>(deps.plugIns));
}

/**
 * What signUpSteps adds to the step-id map (T-1493, T-1484, T-1537): S1-02's one-kind wrapper, S1-04's writer, S1-08's
 * writer and the listing's three writers, each where given.
 */
interface OneKindWriters<Repo> {
  /** The one createOneKind instance of the call, whose wrapper goes around S1-02's writer; null: none. */
  readonly oneKind: OneKind<Repo> | null;
  /** S1-04's writer (T-1481's companiesWriter over the same companies reads); null: no writer at S1-04. */
  readonly companies: StepWriter<Repo> | null;
  /** S1-08's writer's deps; undefined: no writer at S1-08. */
  readonly plan: PlanWriterDeps | undefined;
  /** S1-09's, S1-76's and S1-10's writers over one walk's readings (T-1537, default 7); null: none of them. */
  readonly listing: ListingStepsBound<Repo> | null;
}

/**
 * signUpStepWriters' step-id map over one kindsWriters and one createPlugInWriters; with `added` (signUpSteps, T-1493,
 * T-1484, T-1537), S1-02's writer inside T-1492's one-kind wrapper inside T-634's `kinds` wrapper, S1-03's inside the same
 * instance's draft wrapper (T-1520), S1-04's writer (T-1481), S1-08's writer and the S1-09, S1-76 and S1-10 writers, each
 * where given.
 */
function stepWritersOf<Repo>(
  kinds: KindsWriters<Repo>,
  plugIns: PlugInWriters<Repo>,
  added: OneKindWriters<Repo> = { oneKind: null, companies: null, plan: undefined, listing: null },
): StepWriters<Repo> {
  const { oneKind, companies, plan, listing } = added;
  const s1_02 = oneKind === null ? kinds["S1-02"] : oneKind.wrap(kinds["S1-02"]);
  const s1_03 = oneKind === null ? kinds["S1-03"] : oneKind.wrapDraft(kinds["S1-03"]);
  const entries: [string, StepWriter<Repo>][] = [
    ["S1-02", plugIns.kinds(s1_02)],
    ["S1-03", s1_03],
    ["S1-74", kinds["S1-74"]],
    [S1_11, plugIns.plugIns],
  ];
  if (companies !== null) entries.push([S1_04, companies]);
  if (plan !== undefined) entries.push([PLAN_STEP, planWriter<Repo>(plan)]);
  if (listing !== null) entries.push(...listing.writers);
  const bound: ReadonlyMap<string, StepWriter<Repo>> = new Map<string, StepWriter<Repo>>(entries);
  return (stepId) => bound.get(stepId) ?? null;
}

/** S1-09's settler and the S1-09, S1-76 and S1-10 writers of one call, over one walk's readings (default 7). */
interface ListingStepsBound<Repo> {
  readonly settler: StepSettler<Repo>;
  readonly writers: readonly [string, StepWriter<Repo>][];
}

/**
 * S1-09's settler and the S1-09, S1-76 and S1-10 writers over `deps` and one walkReadings (default 7), as T-1533's
 * mobileIdSteps builds them, with the settler answering the reading's "ask" as SETTLER_ASKS (T-1528). It copies from
 * `deps` only the ports each piece reads: no banned-word read, and the link's host, base path, clock and stage with no
 * generator. Building them reads nothing and logs nothing.
 */
function listingStepsOf<Repo>(deps: SignUpListingDeps<Repo>): ListingStepsBound<Repo> {
  const { places, reads, stop, paging, mobileId } = deps;
  const readings = walkReadings<Repo>({ places });
  const listing = listingWriters<Repo>({ reads, stop, paging }, readings);
  const { host, basePath, now, stage } = mobileId.link;
  const s1_10 = mobileIdWriter<Repo>(
    { reads: mobileId.reads, stop, link: { host, basePath, now, stage } },
    readings,
  );
  const settle = s1_09Settler<Repo>(readings);
  const settler: StepSettler<Repo> = async (call) => {
    // Another step is s1_09Settler's own refusal (wrongStep), before anything is read.
    if (call.step.id !== S1_09) return settle(call);
    // The reading is read once per turn object and part: s1_09Settler then answers its branch, or refuses as it does.
    const reading = await readings.read(call);
    return reading.outcome === "ask" ? SETTLER_ASKS : settle(call);
  };
  return {
    settler,
    writers: [
      [S1_09, listing[S1_09]],
      [S1_76, listing[S1_76]],
      [MOBILE_ID_STEP, s1_10],
    ],
  };
}

/**
 * The sign-up steps' writers and settlers, for TurnCommitBinding.writers and .settlers (signUpSteps), and, where the
 * one-kind path is bound (T-1493), S1-04's buttons settler for TurnCommitBinding.buttonsSettlers: a binding that spreads
 * this object into itself carries each field this object has, and none it lacks.
 */
export interface SignUpSteps<Repo> {
  readonly writers: StepWriters<Repo>;
  readonly settlers: StepSettlers<Repo>;
  /** S1-04's one-kind settler by step id (T-1492's buttonsSettlers); present only with SignUpWriterDeps.companies. */
  readonly buttonsSettlers?: ButtonsSettlers<Repo>;
}

/**
 * The sign-up steps' read-only writers and settlers (T-1502; K-09 README default 191; DL-1018 card 4), for
 * TurnCommitBinding.writers and .settlers, handed in together: what T-1503 binds on staging in place of
 * signUpStepWriters. One kindsSteps (T-633's writers with S1-02's settler, over one catalog read per walk, so the
 * settler's reading and S1-02's writer's are one) and one createPlugInWriters (T-634's) serve them all:
 *   - writers: signUpStepWriters' map, step for step (S1-02's writer inside T-634's wrapper; S1-03, S1-74, S1-11; null
 *     for any other id), the kinds writers being kindsSteps' own;
 *   - settlers: S1-02's settler for S1-02, and null for any other step id, S1-04 among them (default 191 never asks a
 *     settler at a step with no branches: S1-04's is a buttons settler, below).
 * And the one-kind path (T-1493, H1a; K-09 README default 199; DL-1033, DL-1075), from the deps the caller hands in:
 *   - with `companies`: one createOneKind({ reads: companies }) per call (T-1492's handoff: the wrapper and the settler
 *     from one instance, sharing one walk's reads and placement), S1-02 bound as
 *     plugIns.kinds(oneKind.wrap(kinds.writers["S1-02"])), so the one kept pick is placed on its own insert and S1-11's
 *     blocks take its business, S1-03 as oneKind.wrapDraft(kinds.writers["S1-03"]) (T-1520), so the draft for that
 *     pick takes its business too, and `buttonsSettlers` = oneKind.buttonsSettlers (S1-04's settler alone);
 *   - with `companies` and `s1_04Writer` (T-1484, H1b; K-09 README defaults 181 to 185 and 190; DL-1121): S1-04's own
 *     writer, companiesWriter({ reads: companies, partyRuleLive }) (T-1481), over the same reads (item 79, item 72, the
 *     catalog by id and kinds' names by id), so an answer to an S1-04 that was asked closes it at its version, places the
 *     caller's kept picks in the companies its button gives and walks on to S1-08 (the walk never asks the settler for
 *     an answered S1-04: default 199). The party rule's flag is on only when s1_04Writer.partyRuleLive is exactly true,
 *     so otherwise an answer that needs a second company is refused (secondCompany) with nothing written. With
 *     `companies` and no `s1_04Writer`, no writer at S1-04: H1a's writers, step for step (default 6);
 *   - with `plan`: S1-08's writer, planWriter(plan) (T-1482), at S1-08, with or without `companies` (default 6).
 * And S1-09 (T-1537; S1-09 design card 7 extended to S1-10, DL-1171; K-09 README defaults 201 to 211; default 7):
 *   - with `listing`: one walkReadings per call, over which S1-09's settler (settlers, beside S1-02's) and the S1-09,
 *     S1-76 and S1-10 writers (writers) are bound together, so S1-10's writer reads the claim from S1-09's own reading
 *     of the same turn object; the settler answers "ask" (SETTLER_ASKS) where the reading does, so the commit sends
 *     S1-09's question again once (T-1528). With or without the other deps (default 7).
 * With all four left out, the object is today's, field for field: `writers` and `settlers` alone, no `buttonsSettlers`
 * key, no writer at S1-04, S1-08, S1-09, S1-76 or S1-10 and no settler at S1-09. Building them reads nothing and logs
 * nothing. What a settler or writer throws leaves as thrown and fails the call closed, as signUpStepWriters says.
 */
export function signUpSteps<Repo>(deps: SignUpWriterDeps<Repo>): SignUpSteps<Repo> {
  const kinds = kindsSteps<Repo>(deps.kinds);
  const plugIns = createPlugInWriters<Repo>(deps.plugIns);
  const { companies, s1_04Writer, plan } = deps;
  const listing = deps.listing === undefined ? null : listingStepsOf<Repo>(deps.listing);
  const settledEntries: [string, StepSettler<Repo>][] = [["S1-02", kinds.settlers["S1-02"]]];
  if (listing !== null) settledEntries.push([S1_09, listing.settler]);
  const settled: ReadonlyMap<string, StepSettler<Repo>> = new Map<string, StepSettler<Repo>>(settledEntries);
  const settlers: StepSettlers<Repo> = (stepId) => settled.get(stepId) ?? null;
  if (companies === undefined && plan === undefined && listing === null) {
    return { writers: stepWritersOf(kinds.writers, plugIns), settlers };
  }
  const oneKind = companies === undefined ? null : createOneKind<Repo>({ reads: companies });
  const s1_04 =
    companies === undefined || s1_04Writer === undefined
      ? null
      : companiesWriter<Repo>({ reads: companies, partyRuleLive: s1_04Writer.partyRuleLive === true });
  return {
    writers: stepWritersOf(kinds.writers, plugIns, { oneKind, companies: s1_04, plan, listing }),
    settlers,
    ...(oneKind === null ? {} : { buttonsSettlers: oneKind.buttonsSettlers }),
  };
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

// ---- the walk's chat read (T-1519) ------------------------------------------------------------------------------------

/**
 * The walk's chat read over K-05 v1.10 item 51's readChatHandle (T-1519; commit/walk WalkChats, writes.ts default 12):
 * the answer's handle id alone, or null when no chat thread of a phone handle holds the chat id. An error answer
 * (transient) is thrown, never read as none (K-05 v1.4 default 61), so the call fails closed. The number the read also
 * answers is dropped here; nothing is logged.
 */
export function walkChatsOf(read: NonNullable<TurnCommitBinding<unknown>["readChatHandle"]>): WalkChats {
  return {
    async chatHandle(linqChatId) {
      const answer = await read({ linqChatId });
      if ("error" in answer) throw new TurnFaceReadError("readChatHandle", answer.error);
      return answer.handleId;
    },
  };
}

// ---- the commit's deps for one call -----------------------------------------------------------------------------------

/**
 * The walk's question read, step writers, settlers, buttons settlers and chat read as a binding names them: each present
 * only when bound.
 */
type WalkAnswerDeps<Repo> = Pick<
  WalkDeps<Repo>,
  "questions" | "writers" | "settlers" | "buttonsSettlers" | "chats"
>;

/**
 * The commit's deps over one binding: the limits, writesOf and commitTurn as bound, runCore with the core's deps for the
 * turn's pinned lines (built for each action: DL-864 note 4), and openHolds under the business `businessOf` names.
 * writesOf is handed the walk's question read, step writers, settlers, buttons settlers and chat read only as `answers`
 * names them, each only when present (T-1468, T-1502, T-1493, T-1519): the turn face's binding's own, and none for the
 * keyword door, whatever its binding object carries. The commit is handed that same question read, with the binding's
 * turn key, as CommitDeps.askAgain (T-1505), only when `answers` names it, so the keyword door never sends a question
 * again.
 */
function commitDepsWith<Repo>(
  binding: Omit<
    TurnCommitBinding<Repo>,
    "safetyReads" | "questions" | "writers" | "settlers" | "buttonsSettlers" | "readChatHandle"
  >,
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
    ...(answers.settlers === undefined ? {} : { settlers: answers.settlers }),
    ...(answers.buttonsSettlers === undefined ? {} : { buttonsSettlers: answers.buttonsSettlers }),
    ...(answers.chats === undefined ? {} : { chats: answers.chats }),
  });
  const limitsOf = binding.limits ?? turnLimits;
  // The asked turn's question read (T-1505; K-09 v1.12): the walk's own, with the walk's turn key, only where bound.
  const askAgain: AskAgainDeps<Repo> | undefined =
    answers.questions === undefined
      ? undefined
      : {
          questions: answers.questions,
          ...(binding.turnKey === undefined ? {} : { turnKey: binding.turnKey }),
        };
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
      ...(askAgain === undefined ? {} : { askAgain }),
    };
  };
}

/**
 * The commit's deps for one gateAndCommit call, given the runtime's commit-time context: the limits, writesOf, runCore,
 * openHolds and commitTurn as the top of this file binds them. No flags port is bound, so in this business-scoped commit
 * recordStopOrStart and setRecordFlag answer notBuilt portNotWired (DL-877 C5); the paging port is the binding's own
 * (TurnCommitBinding.paging), none until the runtime binds it (T-1444). The walk's question read, step writers,
 * settlers, buttons settlers and chat read are the binding's own too (TurnCommitBinding.questions, .writers, .settlers,
 * .buttonsSettlers and .readChatHandle through walkChatsOf; T-1468, T-1502, T-1493, T-1519): with any left out the walk
 * runs without it, as before. Where the question read is bound, the commit reads an asked turn's one open question
 * through it too (CommitDeps.askAgain; T-1505).
 */
export function turnCommitDeps<Repo>(binding: TurnCommitBinding<Repo>): (at: CommitAt) => CommitDeps<Repo> {
  const { paging, questions, writers, settlers, buttonsSettlers, readChatHandle } = binding;
  const answers: WalkAnswerDeps<Repo> = {
    ...(questions === undefined ? {} : { questions }),
    ...(writers === undefined ? {} : { writers }),
    ...(settlers === undefined ? {} : { settlers }),
    ...(buttonsSettlers === undefined ? {} : { buttonsSettlers }),
    ...(readChatHandle === undefined ? {} : { chats: walkChatsOf(readChatHandle) }),
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
 * question read, no step writer, no settler, no buttons settler and no chat read here (T-1468, T-1502, T-1493, T-1519).
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
