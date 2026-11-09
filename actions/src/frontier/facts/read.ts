// How the frontier reads its facts (T-295): a decision read, so strong. arch 02 line 117: "Decision reads go to the
// primary, uncached"; arch 10 line 538: "Strong for decisions: the primary, with compare-and-set. The read replica
// serves search and reports only"; arch 10 lines 504 and 536: Hyperdrive caches reads 60 s by default, and decision
// reads skip its cache. Every read through the port below names its mode, and the frontier only ever asks STRONG_READ.
//
// The default port reads through K-05 v1.2 readTurnState on the call's repo (one transaction under the call's business,
// T-219), whose contract is that read: "Reads: the primary, uncached (arch 10 lines 504, 538)". It refuses any other
// mode rather than serve it. The PostgreSQL side of the reads is the database engineer's (the new question on frontier
// reads; T-306, D-017).

import type { FrontierRepo, ReadTurnStateErrors, ReadTurnStateRequest, TurnState } from "../assemble/types";

/** How a read is made: on the primary or a replica, and through a cache or not. */
export interface ReadMode {
  readonly primary: boolean;
  readonly cache: boolean;
}

/** A decision read: the primary, uncached (arch 02 line 117; arch 10 line 538). */
export const STRONG_READ: Readonly<{ primary: true; cache: false }> = Object.freeze({
  primary: true,
  cache: false,
});

/** Whether a mode is a decision read's. */
export function isStrong(mode: ReadMode): boolean {
  return mode.primary && !mode.cache;
}

/** One fact named by its key and its home: table, row and column (K-05 v1.2 factRef). */
export type FactRef = ReadTurnStateRequest["facts"][number];

/** One fact as the read gave it: its key and home, the column's value and the row's version (K-05 v1.2 factValue). */
export type FactRead = TurnState["facts"][number];

/** What a facts read answers: the facts in the request's order, read under one business, or K-05 v1.2's errors. */
export type FactsReadAnswer =
  { result: "facts"; businessId: string | null; facts: FactRead[] } | ReadTurnStateErrors;

/** The port the frontier reads its facts through. */
export interface FactsReadPort {
  readFacts(refs: readonly FactRef[], mode: ReadMode): Promise<FactsReadAnswer>;
}

/** The call a facts read runs for: its handle and the business the transaction is scoped to. */
export interface FactsScope {
  readonly handleId: string;
  readonly businessId: string;
}

/** A read asked of the default port that is not a decision read's: a builder fault, never served. */
export class WeakReadError extends Error {
  override name = "WeakReadError";

  constructor() {
    super("a decision read is strong: the primary, uncached (arch 10 line 538)");
  }
}

/** The default port: K-05 v1.2 readTurnState on the call's repo, the primary, uncached; strong reads only. */
export function turnStateFactsPort(repo: FrontierRepo, scope: FactsScope): FactsReadPort {
  return {
    async readFacts(refs, mode) {
      if (!isStrong(mode)) throw new WeakReadError();
      const read = await repo.readTurnState({
        handleId: scope.handleId,
        businessId: scope.businessId,
        bookingIds: [],
        facts: refs.map((ref) => ({ ...ref })),
      });
      if ("error" in read) return read;
      return { result: "facts", businessId: read.businessId, facts: read.facts };
    },
  };
}
