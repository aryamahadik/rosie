// The Linq double's record of parts, as K-21 v1 testPhoneParts lists them (T-565; K-11 v1 README "The double": it
// "records every sendPart request in order"; BP 9.4: the page "shows, in order, each part the Linq double would have
// sent"). The double (T-411) keeps each request it records, but neither when it answered nor what; K-21's RecordedPart
// needs both. So staging's send path is this recorder: the dispatcher's K-11 sendPart goes through it to the double
// (runtime/src/wiring, T-1186), and beside each part the double recorded it keeps the time of the answer and the answer.
// A request the double does not record (one K-11 refuses, or a repeat under a key it already stored) is not listed here
// either: the list is the double's own record, in its order. In memory, as the double's record is: only the sends made
// through this recorder's isolate. Nothing here logs.

import type { LinqDouble, SendPartOutcome } from "@rosie/adapters/linq/double";

import type { PartsRecord, RecordedPart } from "./types";

/** What the recorder reaches of the Linq double: its send, and its record of requests. */
export type RecordedLinqDouble = Pick<LinqDouble, "sendPart" | "sentRequests">;

export interface PartsRecorderOptions {
  /** The clock, an RFC 3339 UTC time ending in Z. Default: the real clock in whole seconds, as the doubles' own. */
  readonly now?: () => string;
}

const defaultNow = (): string => new Date().toISOString().replace(/[.][0-9]+Z$/u, "Z");

export class PartsRecorder implements PartsRecord {
  readonly #double: RecordedLinqDouble;
  readonly #now: () => string;
  readonly #parts: RecordedPart[] = [];

  constructor(double: RecordedLinqDouble, options: PartsRecorderOptions = {}) {
    this.#double = double;
    this.#now = options.now ?? defaultNow;
  }

  /**
   * K-11 v1 sendPart through the double, answered as the double answers. When the double recorded the request, the part
   * is kept: the request as the double took it, the time of the answer and the answer. The double answers at once, so
   * nothing runs between its record and this one.
   */
  sendPart(request: unknown): Promise<SendPartOutcome> {
    const before = this.#double.sentRequests().length;
    const outcome = this.#double.sendPart(request);
    const recorded = this.#double.sentRequests();
    const sent = recorded.length > before ? recorded[recorded.length - 1] : undefined;
    if (sent !== undefined) this.#parts.push({ at: this.#now(), sent, outcome: structuredClone(outcome) });
    return Promise.resolve(outcome);
  }

  /** Each part recorded to this number, in the order it was sent: copies, so a reader cannot change the record. */
  partsTo(number: string): RecordedPart[] {
    return structuredClone(this.#parts.filter((part) => part.sent.to === number));
  }
}

/** The recorder in front of one Linq double. */
export function createPartsRecorder(
  double: RecordedLinqDouble,
  options: PartsRecorderOptions = {},
): PartsRecorder {
  return new PartsRecorder(double, options);
}
