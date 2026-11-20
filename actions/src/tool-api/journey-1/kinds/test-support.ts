// Doubles and inputs for the kinds folder's tests (T-633). Never imported by the Worker. None of them is the code under
// test: the K-05 reads (items 78 and 79, as db/repo answers them), the stop home's reads (T-317's and T-307's doubles over
// the frozen seeds, homes/stop/test-support), T-319's PagingReader (the paging world's, for the review item's plan alone),
// and the walk's doubles of T-1461
// (commit/walk/test-support: bundle v1, the question read, the stand-in writers). Every value comes from the contracts'
// fixtures and fixture set v1: K-09's commit-s1-02.json and match-kinds.json, K-24's seed-kinds-sample.json,
// seed-business-kinds.json and seed-new-work-draft.json ("pack hikes"), the master's S1-02 ("Gift cards are never set up
// either"), the kinds seed's 243 trade-file kinds (T-212); the master's sample cast and the 555-01xx range (rule 9).

import type {
  KindCatalogRow,
  PickedKindRead,
  ReadKindCatalogOutcome,
  ReadPickedKindsOutcome,
  ReadPickedKindsRequest,
} from "../../../../../db/repo/kinds-reads";
import type { Phone } from "../../../../../db/repo/phones";
import { decidedOf, turnTwoOnV1, type WalkTestRepo } from "../../../commit/walk/test-support";
import type { CatalogKind } from "../../../domain/kind-matcher";
import { k24Kinds, seededKinds } from "../../../domain/kind-matcher/test-support";
import type { PagingDeps } from "../../../domain/paging";
import { pagingWorld, readerOn, type PagingWorld } from "../../../domain/paging/test-support";
import { readsOn, seedWorld, withPhones, type World } from "../../../homes/stop/test-support";
import { fixture } from "../../test-support";
import { kindsReadsOf, type KindsK05Reads } from "./reads";
import type { KindsWriterDeps } from "./writers";

/** The moment the doubles' reads are read at: commit-s1-02.json's now. */
export const READ_AT = "2026-10-19T14:05:06Z";

/** K-24 seed-new-work-draft.json's owner's words for work he did not match to a listed kind. */
export const PACK_HIKES = "pack hikes";

/** The master's S1-02: "Gift cards are never set up either." */
export const GIFT_CARDS = "Gift cards";

/** Item 78's rows for a kinds list, as db/repo answers them (each at version 1). */
export function catalogRowsOf(kinds: readonly CatalogKind[]): KindCatalogRow[] {
  return kinds.map((kind) => ({
    id: kind.id,
    name: kind.name,
    style: kind.style,
    pattern: kind.pattern as KindCatalogRow["pattern"],
    source: "trade_file",
    version: 1,
  }));
}

/** The 243 trade-file kinds the kinds seed writes (T-212), as the matcher reads them. */
export function seededCatalog(): CatalogKind[] {
  return seededKinds();
}

/**
 * match-kinds.json's three kinds, as its outcome names them ("The kind ids illustrate K-24's id form"): barbershop
 * Barbershop, plumbing Plumbing and electrical Electrical, each with the style and pattern K-24's seed-kinds-sample.json
 * gives the trade it illustrates (barber, plumber, electrician).
 */
export function matchKindsCatalog(): CatalogKind[] {
  const sample = new Map(k24Kinds("seed-kinds-sample.json").map((kind) => [kind.id, kind]));
  return [
    ["barbershop", "Barbershop", "barber"],
    ["plumbing", "Plumbing", "plumber"],
    ["electrical", "Electrical", "electrician"],
  ].map(([id = "", name = "", trade = ""]) => {
    const like = sample.get(trade);
    if (like === undefined) throw new Error(`seed-kinds-sample.json holds ${trade}`);
    return { id, name, style: like.style, pattern: like.pattern, source: like.source };
  });
}

/** One read the K-05 double was asked for. */
export type K05Asked =
  | { readonly read: "readKindCatalog" }
  | { readonly read: "readPickedKinds"; readonly request: ReadPickedKindsRequest };

export interface FakeK05 {
  readonly k05: KindsK05Reads;
  /** Every read, in order. */
  readonly asked: K05Asked[];
}

/** What the K-05 double answers: the catalog's kinds and the owner's picks so far, or an answer given whole. */
export interface FakeK05Given {
  readonly kinds?: readonly CatalogKind[];
  readonly picks?: readonly PickedKindRead[];
  readonly catalog?: ReadKindCatalogOutcome;
  readonly picked?: ReadPickedKindsOutcome;
}

/**
 * The two reads as db/repo answers them: item 78 the catalog's rows (default: the 243 seeded kinds), item 79 the picks
 * given (default: none) for the request's business and person. Each read is written down and answered as a copy.
 */
export function fakeK05(given: FakeK05Given = {}): FakeK05 {
  const asked: K05Asked[] = [];
  const kinds = given.kinds ?? seededCatalog();
  return {
    asked,
    k05: {
      readKindCatalog() {
        asked.push({ read: "readKindCatalog" });
        const answer: ReadKindCatalogOutcome = given.catalog ?? {
          result: "kindCatalog",
          readAt: READ_AT,
          kinds: catalogRowsOf(kinds),
        };
        return Promise.resolve(structuredClone(answer));
      },
      readPickedKinds(request) {
        asked.push({ read: "readPickedKinds", request: structuredClone(request) });
        const answer: ReadPickedKindsOutcome = given.picked ?? {
          result: "pickedKinds",
          businessId: request.businessId,
          personId: request.personId,
          readAt: READ_AT,
          picks: structuredClone([...(given.picks ?? [])]),
          companies: [],
        };
        return Promise.resolve(structuredClone(answer));
      },
    },
  };
}

/**
 * An earlier pick of Sam's on file, as item 79 answers it: K-24 seed-business-kinds.json's barbershop pick (listed,
 * barber), not placed yet, at the position given.
 */
export function earlierPick(position = 1): PickedKindRead {
  return {
    id: "pick-sam-barbershop",
    ownerPersonId: "person-sam",
    position,
    words: "Barbershop",
    outcome: "listed",
    kindId: "barber",
    companyId: null,
    businessId: null,
    pickedAt: "2026-10-19T14:00:00Z",
    version: 1,
    texts: [],
    draft: null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The turn: commit-s1-02.json's second turn on bundle v1 (T-1461's turnTwoOnV1), with other words where a case needs them

/**
 * Turn 2 on bundle v1 choosing `choiceId` (c-01 "All on the list", c-02 "One isn't on the list yet", c-03 "Not a service
 * we book"), its answer's words set to `words` (the text, the part's quote and its kinds field's words and value) when
 * given, else commit-s1-02.json's own ("Barbershop, plumbing, electrical").
 */
export function turnWithWords(choiceId: string, words?: string): ReturnType<typeof turnTwoOnV1> {
  const turn = turnTwoOnV1(choiceId);
  if (words === undefined) return turn;
  const { part } = turn.part;
  if (part.verb !== "choose") throw new Error("commit-s1-02.json's part chooses");
  part.quote = words;
  for (const field of part.fields) {
    if (field.name === "kinds") {
      field.value = words;
      field.words = words;
    }
  }
  const [text] = decidedOf(turn.context.request).context.texts;
  text.words = words;
  return turn;
}

// ---------------------------------------------------------------------------------------------------------------
// The writers' other ports: the stop home's reads and T-319's paging reader

/** Sam's mobile as K-04 seed-phone-chat-open.json holds it, stopped from the time given (MC C1). */
export function stoppedWorld(stopAt: string): World {
  const world = seedWorld();
  const sam = world.record.phones.find((phone) => phone.handleId === "handle-sam");
  if (sam === undefined) throw new Error("seed-phone-chat-open.json holds Sam's mobile");
  const stopped: Phone = { ...sam, stopped: true, stopAt: new Date(stopAt), chatOpen: false };
  return { record: withPhones(world.record, [stopped]) };
}

/**
 * What the doubles hold: the stop home's world, which the writers read, and the paging world, which the review item's
 * plan alone reads (no writer is handed it).
 */
export interface WriterWorlds {
  readonly stop: World;
  readonly paging: PagingWorld;
}

export function writerWorlds(stop: World = seedWorld()): WriterWorlds {
  return { stop, paging: pagingWorld() };
}

/**
 * The writers' deps over the doubles: the K-05 reads given and the stop home's reads on the runtime side (scope none, as
 * the binding gives them). No paging port: the writers take none.
 */
export function writerDeps(k05: KindsK05Reads, worlds: WriterWorlds = writerWorlds()): KindsWriterDeps {
  return { reads: kindsReadsOf(k05), stop: readsOn(worlds.stop, null) };
}

/** A paging reader over the world, with every read written down (T-319's double). */
export type PagingReaderDouble = ReturnType<typeof readerOn>;

/**
 * T-319's ports for the review item's plan: the paging world's reader, one for the whole plan, so a test reads what the
 * plan asked it.
 */
export function planPaging(world: PagingWorld): {
  readonly paging: PagingDeps<WalkTestRepo>;
  readonly reader: PagingReaderDouble;
} {
  const reader = readerOn(world);
  return { paging: { reader: () => reader }, reader };
}

/** match-kinds.json, as its exchange is written. */
export interface MatchKindsExchange {
  request: { caller: Record<string, unknown>; words: string; flow: "A" | "B" };
  outcome: { parts: { words: string; outcome: string; kinds: { kindId: string; name: string }[] }[] };
}

export function matchKindsExchange(): MatchKindsExchange {
  return fixture("match-kinds.json") as MatchKindsExchange;
}
