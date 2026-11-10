// What the turn face's own bindings throw (T-1141). Each is a fault that fails its call closed: the Tool API base rolls
// the call's transaction back and the handle actor maps the throw to noAnswer. A message names a read, a field or a
// code, never a value, an id, a number or anyone's words.

/**
 * A data-access read answered one of its errors where the binding has no answer for it (K-05 v1.4 default 61: "an error
 * is never read as none"): notFound, moreThanOneOwner or transient fail the call closed, never null or false.
 */
export class TurnFaceReadError extends Error {
  override name = "TurnFaceReadError";
  /** The K-05 read that answered it (a label). */
  readonly read: string;
  /** The read's error code (a label: notFound, moreThanOneOwner, transient). */
  readonly code: string;

  constructor(read: string, code: string) {
    super(`${read} answered ${code}: the call fails closed`);
    this.read = read;
    this.code = code;
  }
}

/** What the turn face refuses to give, never guessed (each a label). */
export type TurnFaceFault =
  /** The pinned bundle is in neither KV nor PostgreSQL's copy. */
  | "bundleMissing"
  /** The row's step is in no flow graph its bundle lists (K-05 v1.3 default 53). */
  | "stepMissing"
  /** The row's step has no line from Rosie to any reader the recipient's live roles read as (S13-31). */
  | "noReader"
  /** The row asks no question, so it names no step or line (K-05 v1.3 default 48): never guessed. */
  | "noLine"
  /** The row's question has no clock row, which the passed-on path withdraws with it (K-05 v1.3 default 54). */
  | "noClockRow"
  /** A sealer asked for a person who has no sealing key: the turn face never makes one. */
  | "noSealingKey";

/** The turn face could not bind what a call needs from what it read, so the call fails closed. */
export class TurnFaceRefusedError extends Error {
  override name = "TurnFaceRefusedError";
  readonly fault: TurnFaceFault;

  constructor(fault: TurnFaceFault) {
    super(`the turn face refuses: ${fault}`);
    this.fault = fault;
  }
}
