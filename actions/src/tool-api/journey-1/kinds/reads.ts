// What journey 1's kinds folder reads (T-633; K-05 v1.19 items 78 and 79, db/repo/kinds-reads.ts, T-1458), each read in a
// read-only transaction of its own, beside the call's own transaction, never on it:
//
//   catalog       item 78 readKindCatalog, the kind matcher's catalog: every K-24 kinds row whose source is trade_file,
//                 its id, name, style, pattern and source as T-632's CatalogKind takes them, field by field (version left
//                 unread). Run as rosie_app, the Tool API's client: kinds has no row-level security and rosie_app holds
//                 its SELECT (0021), so the rows are the same under any scope. Its own read-only transaction at repeatable
//                 read (readKindCatalog), since readKindCatalogIn refuses the call's read-committed transaction (T-1458's
//                 default 1; DL-970, DL-981).
//   pickedKinds   item 79 readPickedKinds, the owner's kinds so far: the call's business's picks and the person's picks
//                 with no business, with their drafts. Run as rosie_job on the runtime side, the one role that reads persons
//                 and sees a row with no business (db/repo refuses rosie_app before any table is read): never a read of
//                 persons as rosie_app (DL-982).
//
// The binding (pgKindsReads) takes two clients, each its own pool: `toolApi`, whose connections run as rosie_app, and
// `runtime`, whose connections run as rosie_job. Each read takes a connection of its client's own beside the one the
// call's transaction holds, so the Tool API's client needs at least 2 connections when a catalog read runs inside a call
// (DL-931): staging's client holds 1 (runtime/src/wiring/staging/db.ts CONNECTIONS_PER_CLIENT, used at its `max`), so
// card F opens the catalog read's client of its own there, as that file's header says a call that needs another
// connection does.
//
// Fails closed (K-05 README "Who reads them": "A notFound or transient answer ... throws and fails closed, never an empty
// list"): K-05's transient or notFound answer is thrown as KindsReadError carrying that answer, so matchKinds answers K-09's
// transient from it and a step writer fails its turn closed; whatever db/repo throws leaves as it was thrown. Nothing here
// logs; an error names the read and its fault, never the answer, a value or an id.

import {
  readKindCatalog,
  readPickedKinds,
  type KindCatalogRow,
  type ReadKindCatalogOutcome,
  type ReadKindCatalogRequest,
  type ReadPickedKindsOutcome,
  type ReadPickedKindsRequest,
  type ReadPickedKindsResponse,
} from "../../../../../db/repo/kinds-reads";
import type { Sql } from "../../../../../db/repo/scope";
import {
  createKindMatcher,
  KindCatalogError,
  type CatalogKind,
  type KindMatcher,
} from "../../../domain/kind-matcher";
import { KindsReadError } from "./errors";

/** The two K-05 v1.19 reads as db/repo answers them: a response or K-05's error answer (a test hands in fakes). */
export interface KindsK05Reads {
  readKindCatalog(request: ReadKindCatalogRequest): Promise<ReadKindCatalogOutcome>;
  readPickedKinds(request: ReadPickedKindsRequest): Promise<ReadPickedKindsOutcome>;
}

/** The reads as the folder's calls read them: each answer, or KindsReadError thrown (never read as none). */
export interface KindsReads {
  /** Item 78: the trade-file kinds as the matcher reads them, in id order. */
  catalog(): Promise<readonly CatalogKind[]>;
  /** Item 79: the owner's kinds so far, of the call's business and of the person with no business. */
  pickedKinds(request: ReadPickedKindsRequest): Promise<ReadPickedKindsResponse>;
}

/**
 * The reads on PostgreSQL: item 78 on `toolApi` (connections that run as rosie_app) and item 79 on `runtime` (connections
 * that run as rosie_job), each db/repo's standalone read in a read-only transaction at repeatable read of its own, on the
 * primary, uncached.
 */
export function pgKindsK05Reads(toolApi: Sql, runtime: Sql): KindsK05Reads {
  return {
    readKindCatalog: (request) => readKindCatalog(toolApi, request),
    readPickedKinds: (request) => readPickedKinds(runtime, request),
  };
}

/** Item 78's row as T-632's CatalogKind, field by field (K-05 v1.19 item 78 "The mapping"). */
function kindOf(row: KindCatalogRow): CatalogKind {
  return { id: row.id, name: row.name, style: row.style, pattern: row.pattern, source: row.source };
}

/** The folder's reads over `k05`: K-05's error answers thrown as KindsReadError, the catalog mapped field by field. */
export function kindsReadsOf(k05: KindsK05Reads): KindsReads {
  return {
    async catalog() {
      const outcome = await k05.readKindCatalog({});
      if ("error" in outcome) throw new KindsReadError("readKindCatalog", outcome.error, outcome);
      return outcome.kinds.map(kindOf);
    },
    async pickedKinds(request) {
      const outcome = await k05.readPickedKinds(request);
      if ("error" in outcome) throw new KindsReadError("readPickedKinds", outcome.error, outcome);
      return outcome;
    },
  };
}

/** The folder's reads on PostgreSQL (pgKindsK05Reads): item 78 as rosie_app, item 79 as rosie_job. */
export function pgKindsReads(toolApi: Sql, runtime: Sql): KindsReads {
  return kindsReadsOf(pgKindsK05Reads(toolApi, runtime));
}

/** The catalog read once and the matcher T-632 builds over it (its handoff: once per catalog read). */
export interface MatcherOf {
  readonly matcher: KindMatcher;
  /** The catalog's kinds by id, for a ranked kind's pattern. */
  readonly kinds: ReadonlyMap<string, CatalogKind>;
}

/**
 * Reads the catalog and builds the matcher over it. A list the matcher refuses (no trade-file kind: the catalog seed has
 * not run) throws KindsReadError noCatalog, so nothing is picked (K-05 v1.19 default 170; QUESTIONS.md CQ-348 (4)).
 */
export async function matcherOf(reads: Pick<KindsReads, "catalog">): Promise<MatcherOf> {
  const catalog = await reads.catalog();
  try {
    return { matcher: createKindMatcher(catalog), kinds: new Map(catalog.map((kind) => [kind.id, kind])) };
  } catch (error) {
    if (error instanceof KindCatalogError) throw new KindsReadError("readKindCatalog", "noCatalog", null);
    throw error;
  }
}
