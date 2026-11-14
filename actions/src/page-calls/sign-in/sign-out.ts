// signOut's server side (T-1285; ADR-016 card B2, section 6; C-193; K-21 v1 signOut; K-05 v1.13 items 61 and 63): a
// handler of the gateway's page entry (runtime/src/gateway/pages, T-266).
//
// Before the answer:
//   1. a request that is not K-21 v1's (its page a signedInPage, whose session token is required) gives no outcome
//      (SignInError badRequest: the entry answers 503, nothing done);
//   2. the session token's sha256 is made, the one form of it K-22 keeps (sessions_token_hash_form), as the token's
//      sha256 was made when the session started (T-322's newSessionToken): the token itself never leaves this call
//      (refuse-end-session-token-not-hash);
//   3. K-05 endSession (item 61) on the Tool API's client, in one transaction by the database's clock: session_for_token
//      finds the live session and its person, and only that person's own live session ends (K-22 rule 5's update
//      policy), signed_out;
//   4. the answer: signedOut, repeated false when a session ended now, true for an ended, expired or unknown one (K-21
//      v1 signOut's repeat rule); or transient as K-05 gave it. Never the session's id or its person.
//
// After the answer, only when a session ended now: K-05 signInEntries (item 63) for its session.ended, under the
// sign-out's own K-21 page.requestId as the job id, since no attempt is part of it (K-05 item 63, CQ-258 (a)). Nothing
// here writes a log line of its own, and its one span (entries.ts) holds fixed labels alone.

import type { PageOutcome, PageRequest } from "../../../../runtime/src/gateway";
import { sha256Hex } from "../../domain/proof-codes";
import { entriesAfterAnswer, scheduleEntries } from "./entries";
import { SignInError } from "./errors";
import { signOutProblems, type SignOutRequest } from "./request";
import type { SignOutDeps, SignOutResult } from "./types";

/** The call served here (K-21 v1 `$defs/callName`). */
export const SIGN_OUT_CALL = "signOut";

/** K-21 v1 signOut for the page entry: the answer, with the session.ended entry handed to `later`, never awaited. */
export async function signOutHandler(page: PageRequest, deps: SignOutDeps): Promise<PageOutcome> {
  const { outcome, afterAnswer } = await signOut(page, deps);
  scheduleEntries(page, deps.later, afterAnswer);
  // A plain copy: the page entry's PageOutcome, a record of the answer's named values.
  return { ...outcome };
}

/**
 * K-21 v1 signOut: steps 1 to 4, the answer, and the session.ended entry to run after it, or null when nothing ended.
 * Throws a SignInError, changing nothing, where K-21 gives no outcome.
 */
export async function signOut(page: PageRequest, deps: SignOutDeps): Promise<SignOutResult> {
  if (page.call !== SIGN_OUT_CALL) throw new SignInError("wrongCall");
  const problems = signOutProblems(page.request);
  if (problems.length > 0) throw new SignInError("badRequest", problems);
  const request = page.request as unknown as SignOutRequest;

  const ended = await deps.check.endSession({ tokenSha256: await sha256Hex(request.page.sessionToken) });

  if ("error" in ended) {
    return { outcome: { error: "transient", sqlstate: ended.sqlstate }, afterAnswer: null };
  }
  if (ended.repeated) {
    return { outcome: { result: "signedOut", repeated: true }, afterAnswer: null };
  }
  return {
    outcome: { result: "signedOut", repeated: false },
    afterAnswer: entriesAfterAnswer(page, deps.afterCheck, request.page.requestId, [
      { kind: "session.ended", sessionId: ended.sessionId },
    ]),
  };
}
