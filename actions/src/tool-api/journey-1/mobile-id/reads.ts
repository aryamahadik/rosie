// What S1-10's writer reads (T-1533; K-09 README default 210 and open gap 201, which asks S10-3 to name the frozen K-05
// reads that give them). Each read is a port the binding hands in, with no default reader, so a writer with none bound
// cannot start. The two K-05 reads are T-635a's (listing/reads.ts ListingK05Reads), so a binding hands the same object:
//
//   turnCompany  item 79 readPickedKinds (K-05 v1.19): the company the turn runs under is the one the caller's person
//                owns whose business is the call's business (companies/reads.ts turnCompanyOf; default 182), and none
//                refuses S1-10's writer (noCompany), as default 204 holds S1-09's.
//   turnHandle   item 26 readTurnState (K-05 v1.2) with no fact: the turn's handle's kind (phone or email), its people
//                (person_handles, for noPerson) and its phones row's number (null: none on file, noPhoneRow). The handle's
//                address is never read or handed on: the number is the phones row's own (accounts.mobile refers to it:
//                accounts_mobile_fk).
//   account      item 26 readTurnState with T-667's setup homes (db/repo/setup/turn-state.ts): the caller's person's K-22
//                accounts row's mobile, mobile_proven_at and version (fact-homes.ts accounts, keyed by person_id, read only
//                as one of the request handle's people's: UNSCOPED_ROWS "person"). Found is "on file"; K-05's notFound
//                naming that very row is "none on file", and any other answer fails closed.
// No read asks whether another person's account holds the number (default 210's mobileTaken): the lead's ruling
// (DL-1167 (1)) has the commit's accounts_mobile_key refusal stand in for it (23505, answered constraint, rolled back,
// nothing written, no one named), so the writer reads no other person's account. A frozen K-05 read for it is a later
// card before production.
//
// readTurnState's first statement reads handles, which rosie_app does not select (0012), and accounts are scoped none with
// no Tool API grant (0020 line 516), so the binding runs both item 26 reads as rosie_job, each in a read-only transaction
// of its own beside the call's (listing/reads.ts pgListingK05Reads), one at a time.
//
// Fails closed (K-05 README "Who reads them"): K-05's error answers are thrown as MobileIdReadError carrying that answer,
// and an answer it cannot read (another handle's, business's or person's, a fact answered twice or never, a version that
// is not a whole number, a mobile or a time that is not text) as notWellFormed; whatever db/repo throws leaves as it was
// thrown. Nothing here logs; an error names the read and its fault, never the answer, a number or an id.

import type { CompanyRead } from "../../../../../db/repo/kinds-reads";
import type { Sql } from "../../../../../db/repo/scope";
import type { SetupTurnStateOutcome } from "../../../../../db/repo/setup/turn-state";
import type { FactRef } from "../../../../../db/repo/turn-state";
import { turnCompanyOf } from "../companies/reads";
import { pgListingK05Reads, type ListingK05Reads, type TurnCompanyRequest } from "../listing/reads";
import { MobileIdReadError } from "./errors";

/** Which turn's handle to read, under which business (readTurnState is a turn's read: its handle, its business). */
export interface TurnHandleRequest {
  /** The turn's handle (K-05 v1.2 readTurnState.request.handleId). */
  readonly handleId: string;
  /** The call's business, never a request value (CommitTurnContext.businessId). */
  readonly businessId: string;
}

/** Whose accounts row to read: the caller's person, read through the turn's handle under the call's business. */
export interface AccountRequest extends TurnHandleRequest {
  /** The caller's person (K-09 caller.personId), one of the handle's people. */
  readonly personId: string;
}

/** The turn's handle as S1-10's writer reads it: its kind, its people and its phones row's number. */
export interface TurnHandle {
  readonly kind: "phone" | "email";
  /** The handle's people (K-04 person_handles), in K-05's order. */
  readonly people: readonly string[];
  /** The number of the handle's K-04 phones row, or null when none is on file. Never logged. */
  readonly phoneNumber: string | null;
}

/** The caller's K-22 accounts row as S1-10's writer compares it. */
export interface AccountOnFile {
  /** accounts.mobile, or null. Never logged. */
  readonly mobile: string | null;
  /** accounts.mobile_proven_at (UTC), or null. */
  readonly mobileProvenAt: string | null;
  /** The row's version (K-04 v1 rule 2), which an update names. */
  readonly version: number;
}

/** The writer's reads, each answer or a thrown error (never read as none). `Repo` is the call's repo, as handed in. */
export interface MobileIdReads<Repo = unknown> {
  /** Item 79: the company the turn runs under (the caller's person's own, whose business is the call's), or null. */
  turnCompany(request: TurnCompanyRequest): Promise<CompanyRead | null>;
  /** Item 26 with no fact: the turn's handle's kind, people and phones row, handed the call's repo. */
  turnHandle(repo: Repo, request: TurnHandleRequest): Promise<TurnHandle>;
  /** Item 26 with T-667's setup homes: the caller's accounts row, or null when none is on file, handed the call's repo. */
  account(repo: Repo, request: AccountRequest): Promise<AccountOnFile | null>;
}

/** The three facts `account` asks of the caller's accounts row, in this order. */
function accountFacts(personId: string): [FactRef, FactRef, FactRef] {
  const fact = (column: string): FactRef => ({
    key: `account.${column}`,
    table: "accounts",
    rowId: personId,
    column,
  });
  return [fact("mobile"), fact("mobile_proven_at"), fact("version")];
}

/** A version as K-04 holds it: a whole number of 1 or more. */
function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

const notWellFormed = (read: "readPickedKinds" | "readTurnState"): MobileIdReadError =>
  new MobileIdReadError(read, "notWellFormed", null);

type TurnState = Extract<SetupTurnStateOutcome, { result: "turnState" }>;

/** The answer for the handle and business asked, or notWellFormed. */
function answerFor(outcome: TurnState, request: TurnHandleRequest): TurnState {
  if (outcome.handleId !== request.handleId || outcome.businessId !== request.businessId) {
    throw notWellFormed("readTurnState");
  }
  return outcome;
}

/** The one fact `asked` in a turn-state answer, or notWellFormed (a fact twice or never). */
function oneFact(outcome: TurnState, asked: FactRef): { value: unknown; version: number } {
  const found = outcome.facts.filter(
    (each) =>
      each.key === asked.key &&
      each.table === asked.table &&
      each.rowId === asked.rowId &&
      each.column === asked.column,
  );
  const [fact, other] = found;
  if (fact === undefined || other !== undefined || !isVersion(fact.version)) {
    throw notWellFormed("readTurnState");
  }
  return { value: fact.value, version: fact.version };
}

const textOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";

/** The writer's reads over `k05`: K-05's error answers thrown as MobileIdReadError, the answers checked as read. */
export function mobileIdReadsOf<Repo>(k05: ListingK05Reads<Repo>): MobileIdReads<Repo> {
  return {
    async turnCompany(request) {
      const outcome = await k05.readPickedKinds(request);
      if ("error" in outcome) throw new MobileIdReadError("readPickedKinds", outcome.error, outcome);
      if (outcome.businessId !== request.businessId || outcome.personId !== request.personId) {
        throw notWellFormed("readPickedKinds");
      }
      return turnCompanyOf(outcome, request.personId, request.businessId);
    },
    async turnHandle(repo, request) {
      const outcome = await k05.readTurnState(repo, {
        handleId: request.handleId,
        businessId: request.businessId,
        bookingIds: [],
        facts: [],
      });
      if ("error" in outcome) throw new MobileIdReadError("readTurnState", outcome.error, outcome);
      const { handle, persons, phone } = answerFor(outcome, request);
      // Read as the answer came over the port: a kind or a number that is not one is refused, never guessed.
      const kind: unknown = handle.kind;
      const number: unknown = phone?.number ?? null;
      if ((kind !== "phone" && kind !== "email") || !textOrNull(number) || number === "") {
        throw notWellFormed("readTurnState");
      }
      return { kind, people: persons.map((person) => person.personId), phoneNumber: number };
    },
    async account(repo, request) {
      const asked = accountFacts(request.personId);
      const outcome = await k05.readTurnState(repo, {
        handleId: request.handleId,
        businessId: request.businessId,
        bookingIds: [],
        facts: [...asked],
      });
      if ("error" in outcome) {
        // K-05's notFound naming the caller's own accounts row: none on file. Anything else fails closed.
        if (
          outcome.error === "notFound" &&
          outcome.table === "accounts" &&
          outcome.rowId === request.personId
        ) {
          return null;
        }
        throw new MobileIdReadError("readTurnState", outcome.error, outcome);
      }
      const answer = answerFor(outcome, request);
      const [mobile, provenAt, version] = asked.map((fact) => oneFact(answer, fact)) as [
        { value: unknown; version: number },
        { value: unknown; version: number },
        { value: unknown; version: number },
      ];
      const rowVersion = version.value;
      if (
        !textOrNull(mobile.value) ||
        !textOrNull(provenAt.value) ||
        !isVersion(rowVersion) ||
        mobile.version !== rowVersion ||
        provenAt.version !== rowVersion ||
        version.version !== rowVersion
      ) {
        throw notWellFormed("readTurnState");
      }
      return { mobile: mobile.value, mobileProvenAt: provenAt.value, version: rowVersion };
    },
  };
}

/** The writer's reads on PostgreSQL (listing/reads.ts pgListingK05Reads): item 79 and item 26 as rosie_job. */
export function pgMobileIdReads(runtime: Sql): MobileIdReads {
  return mobileIdReadsOf(pgListingK05Reads(runtime));
}
