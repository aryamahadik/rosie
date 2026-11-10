// What makes a test-phone call give no K-21 outcome at all: the handler throws one of these, and the page entry answers
// 503 with nothing sent, logging only the error's name (runtime/src/gateway/pages/entry.ts). Each names a label, never a
// value: no word, number, token or id from the request, the roster or the gateway's answer.

export type TestPhoneErrorCode =
  /** The request is not K-21 v1's `<call>.request` (the problems name its fields, never their values). */
  | "badRequest"
  /** The handler was handed another call's request: a wiring fault. */
  | "wrongCall"
  /** The roster's phone has no E.164 number: a setup fault in staging's config. */
  | "badRosterPhone"
  /** The gateway answered a status K-21 v1 testPhoneSent.gatewayStatus has no room for (not 200, 401 or 503). */
  | "gatewayStatus"
  /** The gateway's answer carried no trace id in x-trace-id. */
  | "gatewayTrace";

export class TestPhoneError extends Error {
  override readonly name = "TestPhoneError";
  readonly code: TestPhoneErrorCode;
  /** For badRequest: the fields at fault, by name only. */
  readonly problems: readonly string[];

  constructor(code: TestPhoneErrorCode, problems: readonly string[] = []) {
    super(code);
    this.code = code;
    this.problems = problems;
  }
}
