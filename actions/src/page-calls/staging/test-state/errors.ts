// What makes the listing call give no K-21 outcome at all: the handler throws one of these, and the page entry answers
// 503 with nothing sent, logging only the error's name (runtime/src/gateway/pages/entry.ts). Each names a label, never a
// value: no number, name, token or id from the request, the roster or a seeded row.

export type TestStateErrorCode =
  /** The request is not K-21 v1's `testRoster.request` (the problems name its fields, never their values). */
  | "badRequest"
  /** The handler was handed another call's request: a wiring fault. */
  | "wrongCall"
  /**
   * Staging's roster is not one the listing can show: an entry with no id, an id named twice, a number that is not
   * E.164, a role, label or flow K-21 v1 has no room for, or a phone seated at a business the roster does not name. A
   * setup fault in staging's config.
   */
  | "badRoster"
  /** The roster names a test business that has no K-04 business row: staging's seed has not run, or names another id. */
  | "notSeeded"
  /** A seeded row came back in a form K-21 v1 has no room for (the problems name its columns, never their values). */
  | "badSeededRow";

export class TestStateError extends Error {
  override readonly name = "TestStateError";
  readonly code: TestStateErrorCode;
  /** The fields or columns at fault, by name only. */
  readonly problems: readonly string[];

  constructor(code: TestStateErrorCode, problems: readonly string[] = []) {
    super(code);
    this.code = code;
    this.problems = problems;
  }
}
