// signInCheck's server side (T-1285; ADR-016 card B2, sections 4 and 6; C-193; K-21 v1 signInCheck; K-05 v1.13 items 60,
// 62 and 63): a handler of the gateway's page entry (runtime/src/gateway/pages, T-266). The call, its request, the trace
// the entry opened and the Worker's ENVIRONMENT in; the call's K-21 outcome out, and the check's entries after it.
//
// Before the answer, in this order, each step the same whether or not the attempt names an account or a code:
//   1. a request that is not K-21 v1's gives no outcome (SignInError badRequest: the entry answers 503, nothing done);
//   2. no hashing port bound (no PROOF_CODE_HASH_KEY in the root) gives no outcome either (noHashKey), nothing counted;
//   3. the device's sha256 (hashes.ts) and the typed code's keyed hash (T-322's codeHashOf, the code's own prefix) are
//      made, and the session a right code would start is drawn: its token, 32 bytes from Web Crypto's generator (T-322's
//      newSessionToken; card A), of which K-05 gets only the sha256, and its id, 128 bits from the same generator;
//   4. K-05 proveSignIn (item 60) on the Tool API's client: the binding (another device or an unknown id: attemptNotFound),
//      the repeat, the attempt's own state, the code, and the session, in one transaction by the database's clock, so
//      the check sends no time at all (DL-546 note a; K-05 default 112). A wrong try commits in that transaction, before
//      this call answers (DL-546 note c);
//   5. on signedIn only, K-05 personStanding (item 62) on the runtime side's client, by the person the check's commit
//      set, never a page value: the live roles, team and tester; tester only on staging (K-21 v1 schema line 853); a read
//      that fails answers no roles and both flags false (ADR-016 section 6: fail closed; each console checks again);
//   6. the answer, K-21's label alone: signedIn with the session's token (the one answer it ever leaves the server in:
//      K-21 README, "What leaves the server once") and the standing; secondProofNeeded with K-21's two ways (DL-610
//      note 1); alreadySignedIn;
//      wrong with its tries left; paused until its time; expired; or attemptNotFound or transient as K-05 gave them.
//      Never K-05's attempt id, code id, session id or repeated flag (DL-686): what differs between an attempt with an
//      account and its twin with none (proofCodeId) never leaves the server, so a wrong code answers alike on both paths.
//
// After the answer: K-05 signInEntries (item 63) for what the check changed (entries.ts), under the attempt's server id
// as the job id (K-05 default 117). Nothing here writes a log line of its own; its spans hold fixed labels alone, never
// the code, the token, the device token, an attempt's id, a session's id, a person or a hash.
//
// Every answer to a code that is not right comes from the attempt, by K-05 (item 60 step 5; ADR-016 section 4): this call
// reads no code row and applies no rule of its own to the tries or the pause (DL-546 note d's standing is the attempt's,
// read in proveSignIn's transaction), and it follows K-05 item 60, not K-21 README line 116 (its "How check_proof_code's
// outcomes answer", as T-1277 rules it), for a null code id's unknown: a wrong try, never attemptNotFound (DL-526).
//
// Defaults used (for ops/QUESTIONS.md):
//   1. A check with code null (K-21's text way's poll, which this lane does not serve: ADR-016 section 5; CQ-244; K-05
//      v1.13 serves no waitingForText) is checked as a code that is not right: its typed hash is codeHashOf over no digits,
//      which no code's hash equals (a code has 4 to 8 digits: K-21 schema; T-322 draws 6), so K-05 answers it from the
//      attempt as any wrong code, the same with or without an account; an attempt signed in, paused or past its 10
//      minutes answers that first (item 60 step 3; sign-in-already-signed-in.json). Never waitingForText: no text comes.
//   2. The session's id is "session-" and 22 base64url characters of 128 random bits from the token's generator, as
//      T-1282's ids are (DL-610), never made from the attempt, the device or the time.
//   3. The session is drawn for every check, with or without an account and whatever the code (K-05 proveSignIn.request:
//      "made for every check ... so both paths take the same steps"), and dropped on every answer but signedIn.
//   4. K-05's constraint on a check (the session drawn here taken: its id or its token's sha256) gives no outcome (503,
//      idTaken), as T-1282's start does: nothing was written, the code's use included, and the resend draws another.
//   5. A standing read that answers for another person than the one signed in is a failed read: no roles, both flags
//      false (fail closed, as ADR-016 section 6 rules for a read that fails).
//   6. The check's entries: proof_code.checked whenever K-05's answer names a code (signedIn, secondProofNeeded, wrong,
//      paused, expired), and session.started with signedIn. K-05 logs only what the rows have not logged yet, so asking
//      after a check that changed nothing writes nothing, and a later check writes what a lost earlier call left
//      unlogged. An answer naming no code (alreadySignedIn; an attempt with no code) asks nothing (DL-610 note 2).
//   7. tester is true only where ENVIRONMENT is exactly "staging", the page entry's own test for the staging-only calls.
//   8. A failed standing read writes one span before the answer: decided.standing failed, with K-05's error, or a thrown
//      error's name when it is a label, as its error code. The answer is the same signedIn, so it tells the page nothing.

import type { PageHandler, PageOutcome, PageRequest } from "../../../../runtime/src/gateway";
import { isLabel, type TraceContext } from "../../../../runtime/src/trace";
import {
  ProofCodeHashError,
  WEB_CRYPTO_FILL,
  codeHashOf,
  newSessionToken,
  type KeyedHash,
} from "../../domain/proof-codes";
import { entriesAfterAnswer, scheduleEntries } from "./entries";
import { SignInError } from "./errors";
import { deviceSha256Of, randomId } from "./hashes";
import { signInCheckProblems, type SignInCheckRequest } from "./request";
import { signOutHandler } from "./sign-out";
import type {
  CheckResult,
  PersonStandingOutcome,
  ProveSignInOutcome,
  SignInCheckDeps,
  SignInEntryAsk,
  SignedInPerson,
} from "./types";

/** The call served here (K-21 v1 `$defs/callName`). */
export const SIGN_IN_CHECK_CALL = "signInCheck";

/** The fixed word before a session id's random part (default 2). */
export const SESSION_ID_PREFIX = "session-";

/**
 * K-21 v1 SignInSecondProofNeeded.ways: both of K-21's ways, a page-call constant (DL-610 note 1), since K-05 v1.13
 * names none; the calls that finish either come with K-21 open gap 2's version. No tester reaches this answer.
 */
export const SECOND_PROOF_WAYS = ["emailCode", "idReCheck"] as const;

/** The one ENVIRONMENT a tester's standing is shown in (default 7; K-21 v1 schema line 853). */
const STAGING = "staging";

/** The handlers, for the page entry's handlers (runtime/src/gateway GatewayDeps.pages). */
export interface SignInCheckHandlers {
  readonly signInCheck: PageHandler;
  readonly signOut: PageHandler;
}

/** signInCheck's and signOut's handlers over their ports: the answer, then the entries handed to `later`. */
export function createSignInCheckHandlers(deps: SignInCheckDeps): SignInCheckHandlers {
  return {
    signInCheck: (page) => signInCheckHandler(page, deps),
    signOut: (page) => signOutHandler(page, deps),
  };
}

/** K-21 v1 signInCheck for the page entry: the answer, with the check's entries handed to `later`, never awaited. */
export async function signInCheckHandler(page: PageRequest, deps: SignInCheckDeps): Promise<PageOutcome> {
  const { outcome, afterAnswer } = await signInCheck(page, deps);
  scheduleEntries(page, deps.later, afterAnswer);
  // A plain copy: the page entry's PageOutcome, a record of the answer's named values.
  return { ...outcome };
}

/** The typed code's keyed hash (K-05 v1.13 proveSignIn.request.typedHash); a null code as no digits (default 1). */
async function typedHashOf(hash: KeyedHash, code: string | null): Promise<string> {
  try {
    return await codeHashOf(hash, code ?? "");
  } catch (error) {
    if (error instanceof ProofCodeHashError) throw new SignInError("noHashKey");
    throw error;
  }
}

/**
 * K-21 v1 signInCheck: steps 1 to 6, the answer, and the entries to run after it, or null when there is nothing to log.
 * Throws a SignInError, counting nothing, where K-21 gives no outcome.
 */
export async function signInCheck(page: PageRequest, deps: SignInCheckDeps): Promise<CheckResult> {
  if (page.call !== SIGN_IN_CHECK_CALL) throw new SignInError("wrongCall");
  const problems = signInCheckProblems(page.request);
  if (problems.length > 0) throw new SignInError("badRequest", problems);
  const request = page.request as unknown as SignInCheckRequest;
  const { hash } = deps;
  if (hash === null) throw new SignInError("noHashKey");

  const random = deps.random ?? WEB_CRYPTO_FILL;
  const deviceSha256 = await deviceSha256Of(request.deviceToken);
  const typedHash = await typedHashOf(hash, request.code);
  const session = await newSessionToken(random);
  const sessionId = randomId(SESSION_ID_PREFIX, random);

  const proved = await deps.check.proveSignIn({
    attemptId: request.attemptId,
    deviceSha256,
    requestId: request.page.requestId,
    typedHash,
    session: { id: sessionId, tokenSha256: session.tokenSha256 },
  });

  return answerOf(page, deps, proved, session.token);
}

/** Step 6: K-05's answer as K-21's, with the standing on signedIn, and the entries it calls for. */
async function answerOf(
  page: PageRequest,
  deps: SignInCheckDeps,
  proved: ProveSignInOutcome,
  sessionToken: string,
): Promise<CheckResult> {
  if ("error" in proved) {
    if (proved.error === "attemptNotFound") {
      return { outcome: { error: "attemptNotFound" }, afterAnswer: null };
    }
    if (proved.error === "transient") {
      return { outcome: { error: "transient", sqlstate: proved.sqlstate }, afterAnswer: null };
    }
    throw new SignInError("idTaken");
  }
  const entries = (asks: readonly SignInEntryAsk[]): CheckResult["afterAnswer"] =>
    entriesAfterAnswer(page, deps.afterCheck, proved.signInAttemptId, asks);
  switch (proved.outcome) {
    case "signedIn":
      return {
        outcome: {
          result: "signedIn",
          sessionToken,
          sessionExpiresAt: proved.sessionExpiresAt,
          person: await standingOf(page, deps, proved.personId),
        },
        afterAnswer: entries([
          { kind: "proof_code.checked", proofCodeId: proved.proofCodeId },
          { kind: "session.started", sessionId: proved.sessionId },
        ]),
      };
    case "secondProofNeeded":
      return {
        outcome: { result: "secondProofNeeded", ways: [...SECOND_PROOF_WAYS] },
        afterAnswer: entries(codeAsks(proved.proofCodeId)),
      };
    case "alreadySignedIn":
      return { outcome: { result: "alreadySignedIn" }, afterAnswer: null };
    case "wrong":
      return {
        outcome: { result: "wrong", triesLeft: proved.triesLeft },
        afterAnswer: entries(codeAsks(proved.proofCodeId)),
      };
    case "paused":
      return {
        outcome: { result: "paused", until: proved.until },
        afterAnswer: entries(codeAsks(proved.proofCodeId)),
      };
    case "expired":
      return { outcome: { result: "expired" }, afterAnswer: entries(codeAsks(proved.proofCodeId)) };
  }
}

/** The code's proof_code.checked when the answer names a code; none for an attempt with no code (DL-610 note 2). */
function codeAsks(proofCodeId: string | null): SignInEntryAsk[] {
  return proofCodeId === null ? [] : [{ kind: "proof_code.checked", proofCodeId }];
}

/**
 * Step 5: the signed-in person's standing, by K-05 personStanding, read by the person the check's commit set. A read
 * that fails, throws or answers for another person gives no roles and both flags false (fail closed; default 5).
 */
async function standingOf(
  page: PageRequest,
  deps: SignInCheckDeps,
  personId: string,
): Promise<SignedInPerson> {
  const closed: SignedInPerson = { personId, roles: [], team: false, tester: false };
  let read: PersonStandingOutcome;
  try {
    read = await deps.afterCheck.personStanding({ personId });
  } catch (error) {
    recordStandingFailed(page.trace, error instanceof Error && isLabel(error.name) ? error.name : "error");
    return closed;
  }
  if ("error" in read) {
    recordStandingFailed(page.trace, read.error);
    return closed;
  }
  if (read.personId !== personId) {
    recordStandingFailed(page.trace, "otherPerson");
    return closed;
  }
  return {
    personId,
    roles: read.roles.map(({ role, businessId }) => ({ role, businessId })),
    team: read.team,
    tester: read.tester && page.environment === STAGING,
  };
}

/** A failed standing read, for the server's span alone (default 8): labels only. A refused span is never logged. */
function recordStandingFailed(trace: TraceContext, why: string): void {
  try {
    trace.record({
      hop: "pageRequest",
      ms: 0,
      outcome: "failed",
      decided: { standing: "failed" },
      errorCode: isLabel(why) ? why : "error",
    });
  } catch {
    // Nothing is logged for a refused span: the answer stands.
  }
}
