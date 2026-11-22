// What S1-09's writer reads (T-635a; K-09 README default 204 and open gap 193, which asks T-635a to name the frozen
// K-05 reads that give them). Each read is a port the binding hands in, with no default reader, so a writer with none
// bound cannot start:
//
//   turnCompany   item 79 readPickedKinds (K-05 v1.19), the caller's person's picks and companies under the call's
//                 business: the company the turn runs under is the one the caller's person owns whose business is the
//                 call's business (companies/reads.ts turnCompanyOf; default 182), and none refuses S1-09's writer
//                 (noCompany: default 204, "Whose rows"). T-633's and T-1492's binding of item 79 answers it as rosie_job in
//                 a read-only transaction of its own, and the binding may hand that same function in.
//   businessHead  item 26 readTurnState (K-05 v1.2), the core fact businesses.version of the call's business
//                 (db/repo/turn-state.ts FACT_HOMES businesses), whose version is the one S1-09's writer updates
//                 businesses.name and display_name at (limit 4). No name is read: the writer writes the typed name.
//   setupOnFile   item 26 readTurnState with T-667's setup homes (db/repo/setup/turn-state.ts), the fact
//                 business_setup.version of the call's business (db/repo/setup/fact-homes.ts business_setup, keyed by
//                 business_id): found is "on file", K-05's notFound naming that very row is "none on file", and any other
//                 answer fails closed. S1-09's writer inserts the row only when none is on file.
// Both item 26 reads are handed the call's repo, so the binding may run them on the call's own transaction
// (readTurnStateIn) or in a transaction of their own. readTurnState's first statement reads handles, which rosie_app
// does not select (0012; db/repo/sign-up-reads.ts's header), so on the Tool API's side the binding runs them as rosie_job
// (pgListingK05Reads, beside the call's transaction), as T-1492's companies binding runs its catalog facts.
//
// Fails closed (K-05 README "Who reads them": "A notFound or transient answer ... throws and fails closed, never an empty
// list"): listingReadsOf throws K-05's error answers as ListingReadError carrying that answer, and an answer it cannot
// read (another business's or person's, a fact answered twice or never, a version that is not a whole number) as
// notWellFormed; whatever db/repo throws leaves as it was thrown. Nothing here logs; an error names the read and its
// fault, never the answer, a value or an id. The handle's address readTurnState also answers is never read or handed on.

import {
  readPickedKinds,
  type CompanyRead,
  type ReadPickedKindsOutcome,
  type ReadPickedKindsRequest,
} from "../../../../../db/repo/kinds-reads";
import type { Sql } from "../../../../../db/repo/scope";
import { readTurnState, type SetupTurnStateOutcome } from "../../../../../db/repo/setup/turn-state";
import type { FactRef, ReadTurnStateRequest } from "../../../../../db/repo/turn-state";
import { turnCompanyOf } from "../companies/reads";
import { ListingReadError } from "./errors";

/** Which business's rows to read, for which turn (readTurnState is a turn's read: its handle, its business). */
export interface ListingReadRequest {
  /** The turn's handle (K-05 v1.2 readTurnState.request.handleId). */
  readonly handleId: string;
  /** The call's business, never a request value (CommitTurnContext.businessId). */
  readonly businessId: string;
}

/** Whose company to read: the call's business and the caller's person (item 79's request, the business never null). */
export interface TurnCompanyRequest {
  /** The call's business, never a request value (CommitTurnContext.businessId). */
  readonly businessId: string;
  /** The caller's person (K-09 caller.personId). */
  readonly personId: string;
}

/** The business head as S1-09's writer compares it: its version (K-04 v1 rule 2). */
export interface BusinessHead {
  readonly version: number;
}

/** The writer's reads, each answer or a thrown error (never read as none). `Repo` is the call's repo, as handed in. */
export interface ListingReads<Repo = unknown> {
  /** Item 79: the company the turn runs under (the caller's person's own, whose business is the call's), or null. */
  turnCompany(request: TurnCompanyRequest): Promise<CompanyRead | null>;
  /** Item 26: the call's business head's version, handed the call's repo. */
  businessHead(repo: Repo, request: ListingReadRequest): Promise<BusinessHead>;
  /** Item 26 with T-667's setup homes: whether the business's business_setup row is on file, handed the call's repo. */
  setupOnFile(repo: Repo, request: ListingReadRequest): Promise<boolean>;
}

/** The two K-05 reads as db/repo answers them: a response or K-05's error answer (a test hands in fakes). */
export interface ListingK05Reads<Repo = unknown> {
  readPickedKinds(request: ReadPickedKindsRequest): Promise<ReadPickedKindsOutcome>;
  /** K-05 v1.2 item 26 with T-667's setup homes (db/repo/setup/turn-state.ts). */
  readTurnState(repo: Repo, request: ReadTurnStateRequest): Promise<SetupTurnStateOutcome>;
}

/**
 * The two reads on PostgreSQL, each db/repo's standalone read in a read-only transaction of its own on `runtime`
 * (connections that run as rosie_job: item 79's role and item 26's, K-05 v1.2 default 25), on the primary, uncached. The
 * call's repo is not used. Each takes a connection of its own beside the one the call's transaction holds, so it is
 * never handed a client of one connection whose transaction the call holds.
 */
export function pgListingK05Reads(runtime: Sql): ListingK05Reads {
  return {
    readPickedKinds: (request) => readPickedKinds(runtime, request),
    readTurnState: (_repo, request) => readTurnState(runtime, request),
  };
}

/** The fact businessHead asks: the business head's version (the fact's own version is the row's). */
function headFact(businessId: string): FactRef {
  return { key: "business.version", table: "businesses", rowId: businessId, column: "version" };
}

/** The fact setupOnFile asks: the business's business_setup row's version. */
function setupFact(businessId: string): FactRef {
  return { key: "setup.version", table: "business_setup", rowId: businessId, column: "version" };
}

/** A version as K-04 holds it: a whole number of 1 or more. */
function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** The one fact `asked` in a turn-state answer, or notWellFormed (another business's answer, a fact twice or never). */
function oneFact(
  outcome: Extract<SetupTurnStateOutcome, { result: "turnState" }>,
  asked: FactRef,
  businessId: string,
): number {
  if (outcome.businessId !== businessId) throw new ListingReadError("readTurnState", "notWellFormed", null);
  const found = outcome.facts.filter(
    (each) =>
      each.key === asked.key &&
      each.table === asked.table &&
      each.rowId === asked.rowId &&
      each.column === asked.column,
  );
  const [fact, other] = found;
  if (fact === undefined || other !== undefined || !isVersion(fact.version)) {
    throw new ListingReadError("readTurnState", "notWellFormed", null);
  }
  return fact.version;
}

/** The writer's reads over `k05`: K-05's error answers thrown as ListingReadError, the answers checked as read. */
export function listingReadsOf<Repo>(k05: ListingK05Reads<Repo>): ListingReads<Repo> {
  return {
    async turnCompany(request) {
      const outcome = await k05.readPickedKinds(request);
      if ("error" in outcome) throw new ListingReadError("readPickedKinds", outcome.error, outcome);
      if (outcome.businessId !== request.businessId || outcome.personId !== request.personId) {
        throw new ListingReadError("readPickedKinds", "notWellFormed", null);
      }
      return turnCompanyOf(outcome, request.personId, request.businessId);
    },
    async businessHead(repo, request) {
      const asked = headFact(request.businessId);
      const outcome = await k05.readTurnState(repo, {
        handleId: request.handleId,
        businessId: request.businessId,
        bookingIds: [],
        facts: [asked],
      });
      if ("error" in outcome) throw new ListingReadError("readTurnState", outcome.error, outcome);
      return { version: oneFact(outcome, asked, request.businessId) };
    },
    async setupOnFile(repo, request) {
      const asked = setupFact(request.businessId);
      const outcome = await k05.readTurnState(repo, {
        handleId: request.handleId,
        businessId: request.businessId,
        bookingIds: [],
        facts: [asked],
      });
      if ("error" in outcome) {
        // K-05's notFound naming the business's own business_setup row: none on file. Anything else fails closed.
        if (outcome.error === "notFound" && outcome.table === asked.table && outcome.rowId === asked.rowId) {
          return false;
        }
        throw new ListingReadError("readTurnState", outcome.error, outcome);
      }
      oneFact(outcome, asked, request.businessId);
      return true;
    },
  };
}

/** The writer's reads on PostgreSQL (pgListingK05Reads): item 79 and item 26 as rosie_job. */
export function pgListingReads(runtime: Sql): ListingReads {
  return listingReadsOf(pgListingK05Reads(runtime));
}
