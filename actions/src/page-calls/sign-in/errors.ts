// What makes signInStart give no K-21 outcome at all: the handler throws one of these before any write, and the page
// entry answers 503 with nothing sent, logging only the error's name (runtime/src/gateway/pages/entry.ts). Each names a
// label, never a value: no contact, token, id, hash or code from the request or a port.
//
// None of them depends on whether an account matches the typed contact: each is decided from the request alone, or from
// the binding (no hashing key), before any port that reads an account is reached, so a 503 tells nothing of one.

export type SignInErrorCode =
  /** The request is not K-21 v1's `signInStart.request` (the problems name its fields, never their values). */
  | "badRequest"
  /** The handler was handed another call's request: a wiring fault. */
  | "wrongCall"
  /**
   * Way `text` (MC C9's ready text): not served in ADR-016's lane (section 5; CQ-244), so it is refused with the entry's
   * 503 before any port is reached, writing nothing (K-05 v1.13 refuse-start-sign-in-text-way).
   */
  | "textWayNotServed"
  /**
   * The root bound no hashing port over PROOF_CODE_HASH_KEY, or one that names no secret or gives no HMAC-SHA-256 in
   * hex: no contact can be hashed, so nothing is started (fail closed).
   */
  | "noHashKey"
  /** The typed email or mobile cannot be read as an address or an E.164 number (default 3 in start.ts). */
  | "contactNotReadable"
  /**
   * K-05's startSignIn answered constraint: an id this call drew is taken, or a hash broke its form's CHECK. Nothing was
   * written; the page's resend of the same requestId draws new ids (K-05 v1.13 startSignIn.errors).
   */
  | "idTaken";

export class SignInError extends Error {
  override readonly name = "SignInError";
  readonly code: SignInErrorCode;
  /** For badRequest: the fields at fault, by name only. */
  readonly problems: readonly string[];

  constructor(code: SignInErrorCode, problems: readonly string[] = []) {
    super(code);
    this.code = code;
    this.problems = problems;
  }
}
