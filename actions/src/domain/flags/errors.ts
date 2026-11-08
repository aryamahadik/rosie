// What the flags service refuses before anything is written (T-317; C-078): fail closed, nothing goes in the commit for
// it. Each fault names a rule, never a value: no number, no address, no person's words (K-08 v1 "Never the raw number or
// words"). A refusal K-09 v1 lists for the call (notFromThatPhone, notAllowed, notFound, versionChanged) is an answer,
// not a throw; these are the cases K-09 has no answer for, so the call fails and its transaction rolls back.

export type FlagFault =
  /** private and deceased are on a booking; paused on a person, a phone, an address or a pause row (K-09 v1 setRecordFlag.target). */
  | "targetNotOfFlag"
  /** setRecordFlag runs under one business's scope: a pause names the business whose owner clears it (K-04 pauses.business_id). */
  | "noBusiness"
  /** A clear names no version read: K-09 v1 "a clear compares the row's version (limit 4)". */
  | "versionNotRead"
  /** A pause on a phone number no handle holds (K-04 pauses_phone_fk). */
  | "noSuchPhone"
  /** A turn's STOP or START rides in its own commit (gateAndCommit's core actions), never alone. */
  | "turnRidesInCommit"
  /** The hard invariant: a row to a stopped phone that the stopped flag does not let through (arch 03 line 175; RULES 7.2). */
  | "textAfterStop";

export class FlagRefusedError extends Error {
  readonly fault: FlagFault;
  /** The rows at fault, by id (never a value). */
  readonly rowIds: readonly string[];

  constructor(fault: FlagFault, rowIds: readonly string[] = []) {
    super(`flags refused: ${fault}`);
    this.name = "FlagRefusedError";
    this.fault = fault;
    this.rowIds = [...rowIds];
  }
}
