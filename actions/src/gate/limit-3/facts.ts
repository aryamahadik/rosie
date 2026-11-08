// Where limit 3 (C-083, T-301) gets what it reads, each behind a port so the rule (exact-yes.ts) is plain code:
//   - the open question a yes answers, with the read-back an exact yes binds to (K-04 v1 open_questions: its readback,
//     versions_read, person, handle and ask count), read through K-05 v1.2's openQuestionRead on the call's scoped
//     transaction (db/repo/targets.ts liveOpenQuestionsOfHandle: when it went out and the poll it went out as);
//   - who decides (T-308's identity and access service, over K-04 v1 on the same transaction);
//   - what a secure page's yes (K-21) or an own AI's confirm (K-20; T-328) is bound to. Neither is built yet, so the
//     default binds nothing and limit 3 refuses both: it fails closed until their own tasks land.
//
// Every read gives ids, closed lists and the read-back's own words (Rosie's text, which limit 3 hashes and compares, and
// never logs); a person's words are never read here.

import type { Sql, Tx } from "../../../../db/repo/scope";
import { liveOpenQuestionsOfHandle, type OpenQuestionRead } from "../../../../db/repo/targets";
import {
  NOTHING_ON_FILE,
  NO_ADMIN_POWERS,
  createIdentityAccess,
  identityReaderOf,
  type AdminPowers,
  type IdentityAccess,
  type ServedFactsReader,
} from "../../domain/identity-access";
import type { GateRequest } from "../framework";

/** A row and the version it was read at (K-02 v1 fact; K-04 v1 versions_read). */
export interface RowRef {
  readonly table: string;
  readonly rowId: string;
  readonly version: number;
}

/**
 * One option of an open question as it went out (K-03 v1 option; K-04 v1 open_questions.options): its id, which the
 * K-02 choice for it carries, and its words, word for word what the person saw.
 */
export interface SentOption {
  readonly id: string;
  readonly label: string;
}

/** The open question a yes answers, live and sent to one handle (K-04 v1 open_questions; K-05 v1.2 openQuestionRead). */
export interface AskedQuestion {
  readonly openQuestionId: string;
  /** The handle it was sent to: the asked person's own one-to-one thread. */
  readonly handleId: string;
  /** The person asked, when known: the decider the read-back was sent to (arch 01 line 89). */
  readonly personId: string | null;
  readonly businessId: string | null;
  readonly bookingId: string | null;
  readonly step: string;
  /** The options as they went out, in order. */
  readonly options: readonly SentOption[];
  /** The read-back's exact words an exact yes binds to; null when the question has none (a plain question). */
  readonly readback: string | null;
  /** The versions the read-back was built from (limit 4 compares and sets them). */
  readonly versionsRead: readonly RowRef[];
  /** When it went out to its handle (UTC), or null while nothing of it has gone. */
  readonly sentAt: string | null;
  /** The poll it went out as (the Linq message id of its poll part), or null when it went out as text. */
  readonly pollId: string | null;
  /** How many times it was asked (K-04 ask_count): the fresh read-back is the same question asked again. */
  readonly askCount: number;
}

/** The open questions' read limit 3 makes, on the call's transaction. */
export interface QuestionReader {
  /** The open question `openQuestionId` when it is live (waiting or open) and was sent to `handleId`; else null. */
  liveQuestion(handleId: string, openQuestionId: string): Promise<AskedQuestion | null>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The options as stored (K-03 option objects); an entry that is not one is left out, so it can never match. */
function sentOptions(options: readonly unknown[]): SentOption[] {
  const sent: SentOption[] = [];
  for (const option of options) {
    if (isRecord(option) && typeof option.id === "string" && typeof option.label === "string") {
      sent.push({ id: option.id, label: option.label });
    }
  }
  return sent;
}

/** K-05 v1.2's openQuestionRead as limit 3 reads it, for the handle it was read for. */
export function askedQuestionOf(handleId: string, read: OpenQuestionRead): AskedQuestion {
  return {
    openQuestionId: read.id,
    handleId,
    personId: read.personId,
    businessId: read.businessId,
    bookingId: read.bookingId,
    step: read.step,
    options: sentOptions(read.options),
    readback: read.readback,
    versionsRead: read.versionsRead.map((row) => ({
      table: row.table,
      rowId: row.rowId,
      version: row.version,
    })),
    sentAt: read.sentAt,
    pollId: read.pollId,
    askCount: read.askCount,
  };
}

/**
 * The reader over the data-access call, on the call's own transaction: the Tool API's scoped repo (T-290), where
 * row-level security leaves the call's business's questions and outbox rows only (db/repo/targets.ts).
 */
export function questionReaderOf(db: Sql | Tx): QuestionReader {
  return {
    async liveQuestion(handleId, openQuestionId) {
      const live = await liveOpenQuestionsOfHandle(db, handleId);
      const found = live.find((question) => question.id === openQuestionId);
      return found === undefined ? null : askedQuestionOf(handleId, found);
    },
  };
}

// ---- what a page's yes or an own AI's confirm is bound to (K-21; K-20, T-328) ----------------------------------------

/** The read-back a yes given off the chat is bound to. */
export interface BoundYes {
  /** Whose yes it is: the page session's person, or the person the AI's token is bound to by a code they typed back. */
  readonly personId: string;
  /** The handle the read-back was sent to, whose open question the yes answers. */
  readonly handleId: string;
  /** The sha256 of the read-back's exact words the page showed or the AI confirmed, lowercase hex. */
  readonly readBackSha256: string;
  /** The versions those words were built from. */
  readonly versionsRead: readonly RowRef[];
}

export interface YesBindings {
  /**
   * What the yes of a page or agent call (`request.caller.kind`) to `openQuestionId` is bound to. A secure page's: the
   * read-back's words' sha256 and versions the page server kept with its session (K-21; K-09 v1.1 default 52). An own
   * AI's: the same, named with its confirm, and only while its token is bound to the person by a code they typed back
   * (Q-09: the tie is required; RULES 3.6; T-328). Null: nothing binds it, and the yes is refused.
   */
  boundYes(request: GateRequest, openQuestionId: string): Promise<BoundYes | null>;
}

/** Nothing bound: the default until K-21's yes capture and T-328's Agent API bind land, so every such yes is refused. */
export const NOTHING_BOUND: YesBindings = {
  boundYes: () => Promise.resolve(null),
};

// ---- the defaults over the call's database transaction ----------------------------------------------------------

/**
 * The call's repo as the data-access calls take it: the Tool API's scoped transaction (tool-api/scope.ts, a
 * postgres.js transaction, which is a tagged-template function). Anything else is not a database: limit 3 throws, so
 * the gate fails the whole call and nothing passes.
 */
export function databaseOf(repo: unknown): Sql | Tx {
  if (typeof repo !== "function") {
    throw new TypeError("limit 3 reads through the call's database transaction");
  }
  return repo as Sql | Tx;
}

export interface IdentityDefaults {
  /** Admins' powers (K-22 v1, T-321). Default NO_ADMIN_POWERS: the owner alone decides fees and refunds. */
  readonly adminPowers?: AdminPowers;
  /**
   * The person served's age band and parents or guardians (K-28; CQ-71). Default NOTHING_ON_FILE, chosen here: until
   * that reader lands, the person served decides as an adult (T-308 default 1).
   */
  readonly servedFacts?: ServedFactsReader;
}

/** T-308's service for the call's business, over the call's transaction. */
export function identityOver(
  repo: unknown,
  businessId: string,
  defaults: IdentityDefaults = {},
): IdentityAccess {
  return createIdentityAccess({
    businessId,
    reader: identityReaderOf(databaseOf(repo)),
    adminPowers: defaults.adminPowers ?? NO_ADMIN_POWERS,
    servedFacts: defaults.servedFacts ?? NOTHING_ON_FILE,
  });
}
