// signInStart's server side (T-1282; ADR-016 card B1, sections 2, 4 and 5; C-193; K-21 v1 signInStart; K-05 v1.13 items
// 58 and 59): a handler of the gateway's page entry (runtime/src/gateway/pages, T-266). The call, its request, the trace
// the entry opened and the Worker's ENVIRONMENT in; the call's K-21 outcome out, and the code's send after it.
//
// Before the answer, in this order, each step the same whether or not an account matches the typed contact:
//   1. a request that is not K-21 v1's gives no outcome (SignInError badRequest: the entry answers 503, nothing done);
//   2. way text is refused the same way (textWayNotServed), before any port is reached: ADR-016 section 5 serves no
//      ready text in this lane (CQ-244), so nothing is written;
//   3. no hashing port bound (no PROOF_CODE_HASH_KEY in the root) gives no outcome either (noHashKey), nothing written;
//   4. the contact is read (an email in lower case, a mobile in E.164, or the page's link code for an account from the
//      link: K-22 default 15); a typed contact that is neither gives no outcome (contactNotReadable);
//   5. the two ids are drawn, 128 bits each, from Web Crypto's generator, and the device's sha256, the repeat key and
//      the contact's keyed hash are made (hashes.ts), so only hashes and ids go on;
//   6. K-05 startSignIn (item 58) on the runtime side: the hour's bound, the repeat, the contact's pause and the day's cap
//      under the contact's lock, then the account and the attempt, in one transaction by the database's clock;
//   7. the answer: started (the attempt id and its expiry: the same fields and values with or without an account, and a
//      repeat answers the first attempt), paused until its time (whichever rule held: hourBound, contactPause or
//      dayCap, none of which reads an account; the rule's name goes in the server's span alone), or transient as K-05
//      gave it; constraint gives no outcome (idTaken), so the page's resend draws new ids.
//
// After the answer, only for a start that is not a repeat, names a person (exactly one account: K-05 rule 4) and is not
// from a link (ADR-016 section 5: a link's sign-in sends nothing yet):
//   8. the code is drawn (T-322's drawCode: rejection sampling over Web Crypto, each of the million codes equally likely),
//      hashed through the same port with its own prefix (codeHashOf), and put in its words (wordsFor, codeRowPlan,
//      codeFinalParts): it lives only in memory and in the row's final parts;
//   9. K-05 sendSignInCode (item 59) writes the code row, its email row and three entries, or nothing (repeated,
//      notSent, or an error), and reads the person, the address and every time itself (K-05 defaults 112, 113);
//  10. one span on the call's trace says what became of it, in labels alone, and the report goes to the binding for the
//      dispatch of the row (ADR-016 section 2; T-1289). The send never rejects.
//
// So the answer waits on no write and no step the two paths do not share (ADR-016 section 4): with an account, the code,
// its hash, its row and its entries all come after it. Nothing here writes a log line of its own: its two spans go to the
// trace's sink, and neither holds the code, its words, the contact as typed or read, a hash, the device cookie, the
// page's request id or either of the attempt's ids.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. The code's send is built from T-322's own pieces (drawCode with WEB_CRYPTO_FILL, codeHashOf, wordsFor, codeRowPlan,
//      codeFinalParts and KEYED_CODE_IDS), not its buildCodeSend: K-05 v1.13's sendSignInCode takes only the code's id,
//      keyed hash and key name, the row's id, plan and final parts, and reads the person, the handle and every time
//      itself (defaults 112, 113), which buildCodeSend would need handed in.
//   2. The code's row ids are T-322's KEYED_CODE_IDS over the attempt's server id, so a resend after a transient names
//      the same rows, and K-05's own repeat (an attempt that names a code) answers the first send.
//   3. A typed contact that cannot be read (not one @ with no space, or not a number) gives no outcome (503), as a
//      request that is not K-21's does: no account can match it, and its format is the web app's to check first (C-193).
//   4. A typed mobile of ten digits, or eleven starting with 1, is read as a North American number (+1), as every
//      number in the sources and fixtures is; any other must be typed in E.164 with its +.
//   5. K-05's constraint answer on a start gives no outcome (503), not K-21's transient: nothing was written, and the
//      page's resend of the same requestId draws new ids, as K-05 v1.13 startSignIn.errors says.
//   6. The send's bundle is the trace's: the active bundle the page entry read at receipt (K-08 v1 README default 1),
//      and its trace id the entry's trace, never the envelope's page.traceId, a browser value only shape-checked.
//   7. The send's span is a second pageRequest span on the call's trace (K-21 README: every call writes one), with
//      decided.codeSend (sent, repeated, notSent or failed), decided.why for notSent, and a failure's label as its
//      error code. A paused start's rule goes in a pageRequest span of its own before the answer (decided.signInStart
//      paused and decided.by, an instant: ms 0), as K-05 v1.13 default 127 gives it to the server's span alone.

import type { PageHandler, PageOutcome, PageRequest } from "../../../../runtime/src/gateway";
import { isLabel, type TraceContext } from "../../../../runtime/src/trace";
import {
  KEYED_CODE_IDS,
  WEB_CRYPTO_FILL,
  codeFinalParts,
  codeHashOf,
  codeRowPlan,
  drawCode,
  wordsFor,
  type KeyedHash,
} from "../../domain/proof-codes";
import { SignInError } from "./errors";
import { contactHashOf, deviceSha256Of, drawStartIds, requestSha256Of } from "./hashes";
import { contactOf, signInStartProblems, type ReadContact, type SignInStartRequest } from "./request";
import type {
  AfterAnswer,
  SendReport,
  SendSignInCodeOutcome,
  SendSignInCodeRequest,
  SignInHandlerDeps,
  SignInStartDeps,
  StartResult,
  StartSignInRequest,
} from "./types";

/** The call served here (K-21 v1 `$defs/callName`). */
export const SIGN_IN_START_CALL = "signInStart";

/** The handler, for the page entry's handlers (runtime/src/gateway GatewayDeps.pages). */
export interface SignInHandlers {
  readonly signInStart: PageHandler;
}

/** The handler over its ports: the answer, then the send handed to `later` to run once the answer has gone. */
export function createSignInHandlers(deps: SignInHandlerDeps): SignInHandlers {
  return { signInStart: (page) => signInStartHandler(page, deps) };
}

/** K-21 v1 signInStart for the page entry: the answer, with the code's send handed to `later`, never awaited. */
export async function signInStartHandler(page: PageRequest, deps: SignInHandlerDeps): Promise<PageOutcome> {
  const { outcome, afterAnswer } = await signInStart(page, deps);
  if (afterAnswer !== null) {
    try {
      deps.later(afterAnswer, page);
    } catch {
      // A binding that cannot run the send loses the code, never the answer: it is the same as with no account.
      recordSend(page.trace.start("pageRequest"), { result: "failed", error: "notScheduled" });
    }
  }
  // A plain copy: the page entry's PageOutcome, a record of the answer's named values.
  return { ...outcome };
}

/** K-05 v1.13 signInContact: the read contact without the text its hash is made over. */
function k05Contact(contact: ReadContact): StartSignInRequest["contact"] {
  if (contact.kind === "email") return { kind: "email", address: contact.address };
  if (contact.kind === "mobile") return { kind: "mobile", number: contact.number };
  return { kind: "link" };
}

/**
 * K-21 v1 signInStart: steps 1 to 7, the answer, and the send to run after it (steps 8 to 10), or null when nothing is to
 * be sent. Throws a SignInError, writing nothing, where K-21 gives no outcome.
 */
export async function signInStart(page: PageRequest, deps: SignInStartDeps): Promise<StartResult> {
  if (page.call !== SIGN_IN_START_CALL) throw new SignInError("wrongCall");
  const problems = signInStartProblems(page.request);
  if (problems.length > 0) throw new SignInError("badRequest", problems);
  const request = page.request as unknown as SignInStartRequest;
  if (request.way !== "email") throw new SignInError("textWayNotServed");
  const { hash } = deps;
  if (hash === null) throw new SignInError("noHashKey");
  const contact = contactOf(request);
  if (contact === null) throw new SignInError("contactNotReadable");

  const ids = drawStartIds(deps.random ?? WEB_CRYPTO_FILL);
  const deviceSha256 = await deviceSha256Of(request.deviceToken);
  const requestSha256 = await requestSha256Of(deviceSha256, request.page.requestId);
  const contactHash = await contactHashOf(hash, contact);

  const started = await deps.store.startSignIn({
    id: ids.id,
    attemptId: ids.attemptId,
    requestSha256,
    deviceSha256,
    contact: k05Contact(contact),
    contactHash,
    hashKeyName: hash.keyName,
    way: "email",
  });

  if ("error" in started) {
    if (started.error === "transient") {
      return { outcome: { error: "transient", sqlstate: started.sqlstate }, afterAnswer: null };
    }
    throw new SignInError("idTaken");
  }
  if (started.result === "paused") {
    recordPaused(page.trace, started.by);
    return { outcome: { error: "paused", until: started.until }, afterAnswer: null };
  }
  const outcome = {
    result: "started",
    attemptId: started.attemptId,
    way: "email",
    expiresAt: started.expiresAt,
    readyText: null,
    textLink: null,
  } as const;
  // A repeat sends no second code (K-21 v1 schema line 688); no person or two, none; a link's sign-in sends nothing yet.
  const sends = !started.repeated && started.personId !== null && contact.kind !== "link";
  return { outcome, afterAnswer: sends ? sendAfterAnswer(page, deps, hash, started.id) : null };
}

/** The code's send for the attempt with this server id, to run after the answer: it never rejects. */
function sendAfterAnswer(
  page: PageRequest,
  deps: SignInStartDeps,
  hash: KeyedHash,
  attemptServerId: string,
): AfterAnswer {
  return async () => {
    const timing = page.trace.start("pageRequest");
    let report: SendReport;
    try {
      report = reportOf(await sendCode(page, deps, hash, attemptServerId));
    } catch (error) {
      report = { result: "failed", error: labelOf(error, "error") };
    }
    recordSend(timing, report);
    return report;
  };
}

/** Steps 8 and 9: the code drawn, hashed and put in its words, then K-05 sendSignInCode. */
async function sendCode(
  page: PageRequest,
  deps: SignInStartDeps,
  hash: KeyedHash,
  attemptServerId: string,
): Promise<SendSignInCodeOutcome> {
  const words = wordsFor("signIn");
  if (words === null) throw new TypeError("no words for a sign-in code");
  const ids = deps.codeIds ?? KEYED_CODE_IDS;
  const code = drawCode(deps.random ?? WEB_CRYPTO_FILL);
  const codeId = await ids.codeId(attemptServerId);
  const emailRowId = await ids.emailRowId(attemptServerId);
  const codeHash = await codeHashOf(hash, code);
  const plan = codeRowPlan(emailRowId);
  const finalParts = codeFinalParts(emailRowId, words.email(code));
  const [send] = finalParts.sends;
  const request: SendSignInCodeRequest = {
    signInAttemptId: attemptServerId,
    traceId: page.trace.traceId,
    bundle: { hash: page.trace.bundleId.hash, build: page.trace.bundleId.build },
    code: { id: codeId, codeHash, hashKeyName: hash.keyName },
    emailRowId,
    // K-05 v1.13 codeRowPlan and codeFinalParts are T-322's, field for field; only their lists are copied, to the
    // contract's own (mutable) list types.
    plan: { ...plan, plan: { ...plan.plan, formats: [...plan.plan.formats], lines: [] } },
    finalParts: {
      ...finalParts,
      sends: [{ ...send, options: [] }],
      fixedLines: [],
      slotValues: [],
    },
  };
  return deps.store.sendSignInCode(request);
}

/** K-05's answer to the send, as a report of labels and row ids. */
function reportOf(outcome: SendSignInCodeOutcome): SendReport {
  if ("error" in outcome) return { result: "failed", error: outcome.error };
  if (outcome.result === "notSent") return { result: "notSent", why: outcome.why };
  return {
    result: outcome.repeated ? "repeated" : "sent",
    outboxRowId: outcome.outboxRowId,
    proofCodeId: outcome.proofCodeId,
  };
}

/** A thrown error by its name, only when that name is a label (its message could carry a value); else the fallback. */
function labelOf(error: unknown, fallback: string): string {
  return error instanceof Error && isLabel(error.name) ? error.name : fallback;
}

/**
 * A paused start's rule, for the server's span alone (K-05 v1.13 default 127: hourBound, contactPause or dayCap, none of
 * which reads an account); the page gets K-21's paused and its time only. A span the contract refuses is never logged.
 */
function recordPaused(trace: TraceContext, by: string): void {
  try {
    trace.record({ hop: "pageRequest", ms: 0, outcome: "refused", decided: { signInStart: "paused", by } });
  } catch {
    // Nothing is logged for a refused span: the answer stands.
  }
}

/** Step 10: the send's one span, labels alone (default 7). A span the contract refuses is never logged. */
function recordSend(timing: ReturnType<TraceContext["start"]>, report: SendReport): void {
  const outcome = report.result === "notSent" ? "refused" : report.result === "failed" ? "failed" : "ok";
  try {
    timing.finish({
      outcome,
      decided: { codeSend: report.result, ...(report.result === "notSent" ? { why: report.why } : {}) },
      errorCode: report.result === "failed" ? (isLabel(report.error) ? report.error : "error") : null,
    });
  } catch {
    // Nothing is logged for a refused span: the send's report stands.
  }
}
