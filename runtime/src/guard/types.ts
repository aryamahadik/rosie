// The guard's shapes (T-250; C-051; arch 02 step 3, architecture.txt line 115), written by hand from the frozen contracts,
// because the generated types are git-ignored (ADR-005) and the Worker must not depend on them:
//
//   - K-01 v1 `keywords` (contracts/bundle; the manifest's shared lists, `lists.keywords`): START, HELP, msgtext.js's 16
//     opt-out words, and the two of them that also flag the visit, CANCEL and CANCELAR;
//   - K-05 v1.2 `handleTargets` (contracts/data-access, item 27; QUESTIONS.md NQ-RT-2): the handle's people and their live
//     roles, every live open question sent to it, the bookings its people booked or are served by, its phone's flags;
//   - K-09 v1 `guardTargets` (contracts/tool-api): what the guard hands the frontier (`buildFrontier.request.targets`).
//
// Never logged or put in a span: a text's words. The ids, kinds and codes here are labels.

import type { SealedWords } from "../gateway/seal";

// ---- the keywords (K-01 v1) -----------------------------------------------------------------------------------------

/** What a keyword text is: one of the bundle's opt-out words (a stop), START or HELP. */
export type KeywordKind = "stop" | "start" | "help";

/** One keyword of the pinned bundle's list. */
export interface Keyword {
  readonly kind: KeywordKind;
  /** The word as the bundle's list writes it, such as "OPT OUT": the list's word, never the text as typed. */
  readonly word: string;
  /** True for a stop word that also flags the visit: CANCEL and CANCELAR (RULES 7.4; arch 02 line 115). */
  readonly flagsVisit: boolean;
}

// ---- the turn's texts -----------------------------------------------------------------------------------------------

/** One of the turn's texts as the guard reads it, opened by the turn, in arrival order. */
export interface GuardText {
  readonly eventId: string;
  /** Its K-06 kind: text, photo, reaction, pollVote, voteRemoved or edit. */
  readonly kind: string;
  /**
   * Its words, opened from the sealed box (K-06 `body`, an email's subject, and since K-06 v1.2 a vote's option words);
   * null when it has none. Never logged.
   */
  readonly words: SealedWords | null;
}

/** A text that is only a keyword, with its keyword: it goes to the fixed-reply path (T-267), never to decide. */
export interface KeywordText<T extends GuardText = GuardText> {
  readonly text: T;
  readonly keyword: Keyword;
}

// ---- the targets read (K-05 v1.2 handleTargets) ---------------------------------------------------------------------

/** A person's role at a business, as K-04 person_roles names it (K-05 v1.2 `role`; K-09 v1 GuardRole.role). */
export type Role = "owner" | "admin" | "staff" | "own_business" | "customer";

export const ROLES: readonly Role[] = ["owner", "admin", "staff", "own_business", "customer"];

/** K-05 v1.2 `handleTargets.request`. */
export interface HandleTargetsRequest {
  handleId: string;
}

/** One live role of a person (K-05 v1.2 `handleTargets.response.persons[].roles[]`). */
export interface TargetRole {
  roleId: string;
  businessId: string;
  role: Role;
  version: number;
}

/**
 * K-05 v1.2 `handleTargets.response`, as far as the guard reads it. An open question is K-05's `openQuestionRead` and a
 * booking its `bookingHead`; the fields the guard does not read ride along unread.
 */
export interface HandleTargetsResponse {
  result: "targets";
  handleId: string;
  readAt: string;
  persons: { personId: string; roles: TargetRole[] }[];
  openQuestions: { id: string; readonly [field: string]: unknown }[];
  bookings: { id: string; readonly [field: string]: unknown }[];
  phone: { stopped: boolean; chatOpen: boolean; version: number } | null;
}

/** K-05 v1.2 `handleTargets.errors`: no such handle, or the database could not answer now. */
export type HandleTargetsError =
  { error: "notFound"; table: string; rowId: string } | { error: "transient"; sqlstate: string };

export type HandleTargetsAnswer = HandleTargetsResponse | HandleTargetsError;

/**
 * K-05 v1.2's `handleTargets` (item 27): primary, uncached, on the runtime side across businesses (K-04 v1 rule 4 names the
 * actor's guard). Served by T-220; the actor's adapter joins at D-017 (T-556); a fake answers in tests.
 */
export interface HandleTargetsPort {
  handleTargets(request: HandleTargetsRequest): Promise<HandleTargetsAnswer>;
}

// ---- what the guard hands on (K-09 v1 guardTargets) -----------------------------------------------------------------

/** K-09 v1 `GuardRole`: one of the handle's roles, per business and person. */
export interface GuardRole {
  businessId: string;
  personId: string;
  role: Role;
}

/** K-09 v1 `guardTargets`: the frontier's input (`buildFrontier.request.targets`). */
export interface GuardTargets {
  roles: GuardRole[];
  openQuestionIds: string[];
  bookingIds: string[];
  /** True when there is no open question and no booking: the doors are offered (arch 03 line 165). */
  noTarget: boolean;
}

// ---- errors ---------------------------------------------------------------------------------------------------------

/**
 * Why the guard could not do its part, as a label (a span's `error_code`):
 * - `noKeywords`: the pinned bundle holds no keyword list the guard can read as K-01's, so no text can be split;
 * - `unwired`: no targets read is set yet (D-017);
 * - `noAnswer`: the targets read failed with no answer;
 * - `badAnswer`: an answer that is not K-05's shape, or that is another handle's;
 * - `notFound`, `transient`: K-05's own answers.
 */
export type GuardErrorCode = "noKeywords" | "unwired" | "noAnswer" | "badAnswer" | "notFound" | "transient";

/** The guard could not split the turn (`noKeywords`); its message is the code and never holds a word. */
export class GuardError extends Error {
  readonly code: GuardErrorCode;

  constructor(code: GuardErrorCode) {
    super(code);
    this.name = "GuardError";
    this.code = code;
  }
}

// ---- the guard's answer ---------------------------------------------------------------------------------------------

/** The texts that go on toward the frontier and decide, with the handle's targets. */
export interface OnwardWithTargets<T extends GuardText> {
  readonly read: "targets";
  /** Every text of the turn that is not a keyword, in arrival order. Never a keyword text. */
  readonly texts: readonly T[];
  readonly targets: GuardTargets;
}

/** The targets read failed: the texts may not go to decide on this run (the frontier needs the targets). */
export interface OnwardUnread<T extends GuardText> {
  readonly read: "failed";
  readonly texts: readonly T[];
  readonly errorCode: Exclude<GuardErrorCode, "noKeywords">;
}

export type Onward<T extends GuardText> = OnwardWithTargets<T> | OnwardUnread<T>;

/** What the guard made of one turn. */
export interface GuardResult<T extends GuardText> {
  /** The keyword texts, in arrival order, for the fixed-reply path (T-267): decided by code alone, before any read. */
  readonly keywords: readonly KeywordText<T>[];
  /** The other texts with the handle's targets; null when every text of the turn is a keyword. */
  readonly onward: Onward<T> | null;
}
