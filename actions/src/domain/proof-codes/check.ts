// proveCode (K-09 v1; T-322; C-095; RULES 6.2; S13-45; S11-52): a code typed back, or texted from the mobile it proves,
// checked by the code id the server kept, never one the person sends (K-22 v1 rule 4).
//
// For one call made alone, in this order:
//   1. a repeat (the page request or inbound event id) answers its first result and counts nothing;
//   2. the code's row without its hash (K-22 v1 rule 5's SELECT): none answers notFound;
//   3. a code that went by text is proven only from the mobile it went to (K-09: "for textFromMobile it must be the
//      mobile it proves");
//   4. its standing by RULES 6.2 in code (rules.ts standingAt): a code past its 10 minutes is expired, one inside the
//      15-minute pause its fifth wrong code set is paused, and a used one works no more; each fails here, before any try,
//      so a right code fails too;
//   5. only a live code is checked: the typed code is hashed through the root's port and K-22 v1 check_proof_code counts
//      the try in the database, under the row's lock (ProofCodeStore.check), then its entry is written in the same
//      transaction: right proves the contact, a wrong code counts one of 5 tries, and the fifth pauses the code 15
//      minutes from that wrong code.
//
// The typed code and its hash never reach an answer, an entry, a span or an error (K-08 v1.1: "Never, sealed or plain:
// the code, its hash, the code as typed").
//
// Defaults used (for ops/QUESTIONS.md; send.ts holds 1 to 5):
//   6. Only a sign-in code's check is built: its proven answer names the contact the code went to. Any other purpose
//      answers notBuilt before a try is made (a limit 1 code's redecideTurnId, the owner email's account and handle
//      writes and a control code's K-23 write are their own cards'); so does a turn's call (it rides in its commit).
//   7. A code that went by text, checked from any other handle, answers notFound and counts nothing: it proves nothing
//      there, and no one else can use up its tries.
//   8. A used code checked again under a new key answers expired: a code works once (RULES 6.1).
//   9. A code with five wrong tries whose pause is over answers expired: it never works again (K-22 v1
//      proof_codes_used_in_time), and its 10 minutes ended before its pause did.
//  10. A check writes its proof_code.checked entry only when it changed the code (right, a wrong try): the actor is the
//      code's person for a right code (their own act, K-08 v1 default 12) and Rosie for a wrong one, whose typist is not
//      known.

import type { EventEntry } from "../../commit";
import { NotBuiltError, type AnswerOf, type RequestOf } from "../../tool-api";
import { sha256Hex } from "./draw";
import { codeHashOf, type KeyedHash } from "./hashing";
import type { CheckResult, ProofCodeStore } from "./ports";
import { pauseEndOf, standingAt, triesLeftAfter, type CodeState } from "./rules";

export type CheckRequest = RequestOf<"proveCode">;
export type CheckAnswer = AnswerOf<"proveCode">;

/** What proveCode reads and writes through. */
export interface CheckDeps {
  readonly store: ProofCodeStore;
  /** The root's hashing port; null: none bound, so no code is checked (notBuilt). */
  readonly hash: KeyedHash | null;
}

/** A check's broken answer from the store (a wrong try with no row, say): the call fails, naming no value. */
export class ProofCodeStoreError extends Error {
  override name = "ProofCodeStoreError";
}

/** K-09 v1 notFoundError for the code id. */
function notFound(codeId: string): CheckAnswer {
  return { error: "notFound", table: "proof_codes", rowId: codeId };
}

/** The row after a check that changed or read it: the store must give it. */
function rowOf(result: CheckResult): CodeState {
  if (result.code === null) throw new ProofCodeStoreError("a check answered with no code row");
  return result.code;
}

/**
 * A check's answer: right proves the contact the sign-in code went to; a wrong code tells the tries left; a paused one
 * (the fifth wrong code, or one the database found paused) its end, 15 minutes from the fifth wrong code; used and
 * expired, expired (default 8); unknown, notFound.
 */
export function answerOfCheck(result: CheckResult, codeId: string): CheckAnswer {
  const { repeated } = result;
  switch (result.outcome) {
    case "unknown":
      return notFound(codeId);
    case "right":
      return {
        result: "proven",
        handleId: rowOf(result).sentToHandleId,
        controlBusinessId: null,
        redecideTurnId: null,
        repeated,
      };
    case "wrong":
      return { result: "wrong", triesLeft: triesLeftAfter(rowOf(result).wrongTries), repeated };
    case "paused": {
      const { lastWrongAt } = rowOf(result);
      if (lastWrongAt === null) throw new ProofCodeStoreError("a paused code has no last wrong try");
      return { result: "paused", until: pauseEndOf(lastWrongAt), repeated };
    }
    case "used":
    case "expired":
      return { result: "expired", repeated };
  }
}

/** The proof_code.checked entry of a check that changed the code (default 10), or none. */
async function checkedEntries(key: string, before: CodeState, result: CheckResult): Promise<EventEntry[]> {
  if (result.outcome !== "right" && result.outcome !== "wrong" && result.outcome !== "paused") return [];
  const after = rowOf(result);
  if (after.wrongTries === before.wrongTries && after.usedAt === before.usedAt) return [];
  const right = result.outcome === "right";
  const newValues: Record<string, unknown> = right
    ? { proven_at: after.usedAt }
    : {
        wrong_tries: after.wrongTries,
        ...(after.pausedUntil === null ? {} : { paused_until: after.pausedUntil }),
      };
  return [
    {
      id: `log-${before.id}-checked-${(await sha256Hex(key)).slice(0, 16)}`,
      kind: "proof_code.checked",
      zone: null,
      businessId: null,
      actorKind: right && before.personId !== null ? "person" : "rosie",
      actorPersonId: right ? before.personId : null,
      actorRole: null,
      tableName: "proof_codes",
      rowId: before.id,
      oldValues: right ? { proven_at: null } : { wrong_tries: before.wrongTries },
      newValues,
      sealed: null,
      why: { step: "S13-45" },
      approvedBy: null,
      proofs: null,
    },
  ];
}

/** The check's answer, and whether it reached the database's check (for the call's span: nothing else). */
export interface CheckOutcomeOf {
  readonly answer: CheckAnswer;
  /** The code row the check touched, when check_proof_code ran: its table and id, never a value. */
  readonly touched: { readonly table: string; readonly id: string } | null;
}

/** proveCode for one call made alone. */
export async function proveCode(request: CheckRequest, deps: CheckDeps): Promise<CheckOutcomeOf> {
  const answered = (answer: CheckAnswer): CheckOutcomeOf => ({ answer, touched: null });
  if (request.caller.kind === "turn") throw new NotBuiltError("proveCode");
  if (deps.hash === null) throw new NotBuiltError("proveCode");
  const key = request.caller.requestId;
  const codeId = request.proofCodeId;

  const first = await deps.store.checkedFor(key, codeId);
  if (first !== null) return answered(answerOfCheck({ ...first, repeated: true }, codeId));

  const code = await deps.store.code(codeId);
  if (code?.id !== codeId) return answered(notFound(codeId));
  if (code.purpose !== "sign_in") throw new NotBuiltError("proveCode");
  if (code.channel === "text" && request.fromHandleId !== code.sentToHandleId) {
    return answered(notFound(codeId));
  }

  const standing = standingAt(code, request.at);
  if (standing.standing === "paused") {
    return answered({ result: "paused", until: standing.until, repeated: false });
  }
  if (standing.standing !== "live") return answered({ result: "expired", repeated: false });

  const typedHash = await codeHashOf(deps.hash, request.typed);
  const result = await deps.store.check({ key, codeId, typedHash, at: request.at });
  if (!result.repeated) {
    const events = await checkedEntries(key, code, result);
    if (events.length > 0) await deps.store.logCheck(key, events);
  }
  return { answer: answerOfCheck(result, codeId), touched: { table: "proof_codes", id: codeId } };
}
