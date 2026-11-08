// The parts the Linq double sent (T-465; C-148): each part as K-11 v1 sendPart took it, with the outcome the double gave
// when it is known, in the order sent. On staging, K-21 v1 testPhoneParts gives exactly this (`RecordedPart`); locally,
// RecordingLinqDouble records it as the Linq double (C-211, T-411) answers.
//
// A part's words are the person's to read in a test, never the driver's to print: checkParts reports keys and counts.

import { LinqDouble, type LinqDoubleOptions } from "../../../adapters/src/linq/double";
import type { SendPartOutcome, SendPartRequest } from "../../../adapters/src/linq/double/types";

/** One part sent: K-21 v1's RecordedPart, with `at` and `outcome` null where the double that sent it keeps none. */
export interface SentPart {
  readonly at: string | null;
  readonly sent: SendPartRequest;
  readonly outcome: SendPartOutcome | null;
}

const wholeSeconds = (): string => new Date().toISOString().replace(/[.][0-9]+Z$/, "Z");

/**
 * The Linq double, recording each new part it takes with the outcome it gave (K-21 testPhoneParts' record). A repeat
 * under a key the double already holds is Linq's dedupe: no new message, so no new record (K-07 part keys).
 */
export class RecordingLinqDouble extends LinqDouble {
  readonly #clock: () => string;
  #parts: SentPart[] = [];

  constructor(options: LinqDoubleOptions = {}) {
    super(options);
    this.#clock = options.now ?? wholeSeconds;
  }

  override sendPart(request: unknown): SendPartOutcome {
    const before = this.sentRequests().length;
    const outcome = super.sendPart(request);
    const taken = this.sentRequests();
    const sent = taken[taken.length - 1];
    if (taken.length > before && sent !== undefined) {
      this.#parts.push({ at: this.#clock(), sent, outcome: structuredClone(outcome) });
    }
    return outcome;
  }

  /** Each new part taken, in order, with the outcome given. */
  recordedParts(): readonly SentPart[] {
    return structuredClone(this.#parts);
  }

  override reset(): void {
    super.reset();
    this.#parts = [];
  }
}

/** The parts a Linq double sent: its record when it keeps one, else its requests with no outcome. */
export function partsOf(linq: LinqDouble): SentPart[] {
  if (linq instanceof RecordingLinqDouble) return [...linq.recordedParts()];
  return linq.sentRequests().map((sent) => ({ at: null, sent, outcome: null }));
}

export interface PartsCheck {
  /** Parts sent, typing dots included. */
  readonly parts: number;
  /** Parts the provider accepted (or, where the outcome is not known, took). */
  readonly sends: number;
  /** Each `<row>/<part>` accepted under more than one key: the person got that part twice. */
  readonly duplicateSends: readonly string[];
  /** Each idempotency key recorded more than once. */
  readonly repeatedKeys: readonly string[];
}

/**
 * Counts the sends and finds duplicates: a part (`<row>/<part>` of K-07's `<row>/<part>/<try>` key) accepted under two
 * keys reached the person twice; a key recorded twice was sent twice. Typing dots carry no key and are not judged.
 */
export function checkParts(parts: readonly SentPart[]): PartsCheck {
  const accepted = new Map<string, number>();
  const keys = new Map<string, number>();
  let sends = 0;
  for (const { sent, outcome } of parts) {
    const key = sent.idempotencyKey;
    if (key === null) continue;
    keys.set(key, (keys.get(key) ?? 0) + 1);
    if (outcome !== null && outcome.result !== "accepted") continue;
    sends += 1;
    const part = key.split("/").slice(0, -1).join("/");
    accepted.set(part, (accepted.get(part) ?? 0) + 1);
  }
  const over = (counts: ReadonlyMap<string, number>): string[] =>
    [...counts].filter(([, n]) => n > 1).map(([name]) => name);
  return { parts: parts.length, sends, duplicateSends: over(accepted), repeatedKeys: over(keys) };
}
