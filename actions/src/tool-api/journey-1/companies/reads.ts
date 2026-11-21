// What journey 1's companies folder reads (T-1492; K-09 README default 199 item (4); the ruling's decision (c) and (d);
// K-05 README's table for S1-04), and the helpers T-1481's S1-04 writer reuses (the turn's company; a company kind on
// file; a kind's facts and switches for its company kind). Each read is a port the binding hands in (T-1493, H1a), with
// no default reader, so a call with none bound cannot start:
//
//   pickedKinds    item 79 readPickedKinds, the owner's kinds so far: the call's business's picks and the person's picks
//                  with no business, with their texts and drafts, and the companies of both (K-05 v1.19). T-633's reads
//                  (journey-1/kinds reads.ts KindsReads.pickedKinds) answer it as rosie_job in a read-only transaction of
//                  its own, and the binding may hand that same function in ("item 79 as now").
//   businessKinds  item 72 readBusinessKinds, the call's business's K-23 company_kinds rows with their kind_flows (K-05
//                  v1.18): which company kinds are on file. Handed the call's repo, so the binding may run it on the
//                  call's own transaction as rosie_app (readBusinessKindsIn) or in a transaction of its own.
//   kindDefaults   K-24's catalog by id: a listed kind's kinds.facts and its kind_flows.switches_on in flows A and B,
//                  through K-05 v1.2 item 26 readTurnState's setup facts (T-667's homes; K-05 README's table for S1-04:
//                  "kinds.facts and kind_flows.switches_on by id through readTurnState"), the rows `<kind id>`,
//                  `<kind id>/A` and `<kind id>/B` (item 77's names), in one read. Handed the call's repo too.
//
// Fails closed (K-05 README "Who reads them": "A notFound or transient answer ... throws and fails closed, never an empty
// list"): companiesReadsOf throws K-05's error answers as CompaniesReadError carrying that answer, and an answer it cannot
// read (a value that is not a list of plug-in names, another business's answer) as notWellFormed; whatever db/repo throws
// leaves as it was thrown. Nothing here logs; an error names the read and its fault, never the answer, a value or an id.
//
// pgCompaniesK05Reads binds the three to db/repo, each in a read-only transaction of its own beside the call's (the
// integration test's binding, and the binding's where each read may take a connection of its own): item 79 and
// readTurnState on `runtime` (rosie_job: item 79's role, and item 26's, K-05 v1.2 default 25), item 72 on `toolApi`
// (rosie_app, the Tool API's client: item 72's role). Each takes a connection of its own beside the one the call's
// transaction holds, so it is never handed a client of one connection whose transaction the call holds (on staging,
// runtime/src/wiring/staging/db.ts CONNECTIONS_PER_CLIENT stays 1: there the binding hands item 72 and the catalog the
// call's own transaction, H1a's and H2a's to rule).
//
// Defaults used (for ops/QUESTIONS.md), beside one-kind.ts's:
//   R1. A trade-file kind whose kinds.facts is null (K-24 allows it: kinds_drafted_facts_on_draft holds only a drafted
//       kind to null) has no default fact on: its company kind's pf_facts is the empty list, as company_kinds.pf_facts'
//       own default ('{}'). Every trade-file kind the kinds seed writes has a list (db/seeds/kinds.ts).
//   R2. A drafted (new work) kind's company kind is default 182's: pf_facts the protective facts, `documents` then
//       `forms`, then each answered block's factsOn in block order, each name once; pf_switches_a and pf_switches_b both
//       the answered blocks' switchesOn in block order, each once. With no draft on file, or no block answered (every
//       draft the walk makes: S1-03's writer drafts it with no block), that is ["documents", "forms"] and two empty lists.
//       Default 182 (K-09 v1.11, the architect's answer to check-merge.json:472's question) says "never empty lists",
//       so it is taken over the "empty ones" of the lead's note, which quotes check-merge.json:472; the drafted kind
//       stays offline either way, since no live booking reads a kind its draft has not cleared.
//   R3. The turn's company is the companies row item 79 answers whose owner is the caller's person and whose business is
//       the call's business (default 182: "the caller's person's own company whose business is the call's business");
//       K-23's companies_business_key holds at most one company per business, so there is one or none.

import type {
  BusinessKindRead,
  ReadBusinessKindsOutcome,
  ReadBusinessKindsRequest,
  ReadBusinessKindsResponse,
} from "../../../../../db/repo/catalog-reads";
import { readBusinessKinds } from "../../../../../db/repo/catalog-reads";
import {
  readPickedKinds,
  type CompanyRead,
  type NewWorkDraftRead,
  type ReadPickedKindsOutcome,
  type ReadPickedKindsRequest,
  type ReadPickedKindsResponse,
} from "../../../../../db/repo/kinds-reads";
import type { Sql } from "../../../../../db/repo/scope";
import { readTurnState, type SetupTurnStateOutcome } from "../../../../../db/repo/setup/turn-state";
import type { FactRef, ReadTurnStateRequest } from "../../../../../db/repo/turn-state";
import { CompaniesReadError } from "./errors";

/** Which listed kind's catalog defaults to read, for which turn (readTurnState is a turn's read: its handle, its business). */
export interface KindDefaultsRequest {
  /** The turn's handle (K-05 v1.2 readTurnState.request.handleId). */
  readonly handleId: string;
  /** The call's business, never a request value (CommitTurnContext.businessId). */
  readonly businessId: string;
  /** The listed kind (a trade file's id). */
  readonly kindId: string;
}

/** A kind's facts and the switches on in each flow, for its company kind (K-23 company_kinds' three lists). */
export interface KindDefaults {
  readonly facts: readonly string[];
  readonly switchesA: readonly string[];
  readonly switchesB: readonly string[];
}

/** The folder's reads, each answer or a thrown error (never read as none). `Repo` is the call's repo, as handed in. */
export interface CompaniesReads<Repo = unknown> {
  /** Item 79: the owner's kinds so far, of the call's business and of the person with no business, with the companies. */
  pickedKinds(request: ReadPickedKindsRequest): Promise<ReadPickedKindsResponse>;
  /** Item 72: the call's business's company kinds, handed the call's repo. */
  businessKinds(repo: Repo, request: ReadBusinessKindsRequest): Promise<ReadBusinessKindsResponse>;
  /** K-24's catalog by id: a listed kind's facts and its switches in flows A and B, handed the call's repo. */
  kindDefaults(repo: Repo, request: KindDefaultsRequest): Promise<KindDefaults>;
}

/** The three K-05 reads as db/repo answers them: a response or K-05's error answer (a test hands in fakes). */
export interface CompaniesK05Reads<Repo = unknown> {
  readPickedKinds(request: ReadPickedKindsRequest): Promise<ReadPickedKindsOutcome>;
  readBusinessKinds(repo: Repo, request: ReadBusinessKindsRequest): Promise<ReadBusinessKindsOutcome>;
  /** K-05 v1.2 item 26 with T-667's setup homes (db/repo/setup/turn-state.ts). */
  readTurnState(repo: Repo, request: ReadTurnStateRequest): Promise<SetupTurnStateOutcome>;
}

/**
 * The three reads on PostgreSQL, each db/repo's standalone read in a read-only transaction of its own, on the primary,
 * uncached: item 79 and readTurnState on `runtime` (connections that run as rosie_job), item 72 on `toolApi`
 * (connections that run as rosie_app). The call's repo is not used. Never hand in a client of one connection whose
 * transaction the call holds (the top of this file).
 */
export function pgCompaniesK05Reads(toolApi: Sql, runtime: Sql): CompaniesK05Reads {
  return {
    readPickedKinds: (request) => readPickedKinds(runtime, request),
    readBusinessKinds: (_repo, request) => readBusinessKinds(toolApi, request),
    readTurnState: (_repo, request) => readTurnState(runtime, request),
  };
}

/** A plug-in name (K-26's form; company_kinds_names_form, kinds_facts_form, kind_flows_switches_form). */
const PLUGIN_NAME = /^[a-z0-9]+$/;

/** A value as a list of plug-in names, or null when it is not one. */
function namesOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "string" || !PLUGIN_NAME.test(item)) return null;
    names.push(item);
  }
  return names;
}

/** The catalog facts one kindDefaults read asks readTurnState for: the kind's facts and its two flows' switches. */
function catalogFacts(kindId: string): FactRef[] {
  return [
    { key: "kind.facts", table: "kinds", rowId: kindId, column: "facts" },
    { key: "kind.switches.A", table: "kind_flows", rowId: `${kindId}/A`, column: "switches_on" },
    { key: "kind.switches.B", table: "kind_flows", rowId: `${kindId}/B`, column: "switches_on" },
  ];
}

/** The folder's reads over `k05`: K-05's error answers thrown as CompaniesReadError, the catalog facts read as lists. */
export function companiesReadsOf<Repo>(k05: CompaniesK05Reads<Repo>): CompaniesReads<Repo> {
  return {
    async pickedKinds(request) {
      const outcome = await k05.readPickedKinds(request);
      if ("error" in outcome) throw new CompaniesReadError("readPickedKinds", outcome.error, outcome);
      if (outcome.businessId !== request.businessId || outcome.personId !== request.personId) {
        throw new CompaniesReadError("readPickedKinds", "notWellFormed", null);
      }
      return outcome;
    },
    async businessKinds(repo, request) {
      const outcome = await k05.readBusinessKinds(repo, request);
      if ("error" in outcome) throw new CompaniesReadError("readBusinessKinds", outcome.error, outcome);
      if (outcome.businessId !== request.businessId) {
        throw new CompaniesReadError("readBusinessKinds", "notWellFormed", null);
      }
      return outcome;
    },
    async kindDefaults(repo, request) {
      const asked = catalogFacts(request.kindId);
      const outcome = await k05.readTurnState(repo, {
        handleId: request.handleId,
        businessId: request.businessId,
        bookingIds: [],
        facts: asked,
      });
      if ("error" in outcome) throw new CompaniesReadError("readTurnState", outcome.error, outcome);
      const values = asked.map((fact) => {
        const found = outcome.facts.filter(
          (each) => each.key === fact.key && each.table === fact.table && each.rowId === fact.rowId,
        );
        if (found.length !== 1) throw new CompaniesReadError("readTurnState", "notWellFormed", null);
        return found[0]?.value;
      });
      const [facts, switchesA, switchesB] = values;
      // Default R1: a trade-file kind's facts may be null, read as no fact on.
      const factNames = facts === null ? [] : namesOf(facts);
      const a = namesOf(switchesA);
      const b = namesOf(switchesB);
      if (factNames === null || a === null || b === null) {
        throw new CompaniesReadError("readTurnState", "notWellFormed", null);
      }
      return { facts: factNames, switchesA: a, switchesB: b };
    },
  };
}

// ---- the helpers T-1481 reuses ------------------------------------------------------------------------------------------

/**
 * The company the turn runs under (default R3; default 182): of item 79's companies, the one the caller's person owns
 * whose business is the call's business, or null when there is none.
 */
export function turnCompanyOf(
  onFile: Pick<ReadPickedKindsResponse, "companies">,
  personId: string,
  businessId: string,
): CompanyRead | null {
  return (
    onFile.companies.find(
      (company) => company.ownerPersonId === personId && company.businessId === businessId,
    ) ?? null
  );
}

/** The company kind on file for `companyId` and `kindId` in item 72's answer (K-23 company_kinds' key), or null. */
export function companyKindOnFile(
  kinds: Pick<ReadBusinessKindsResponse, "kinds">,
  companyId: string,
  kindId: string,
): BusinessKindRead | null {
  return kinds.kinds.find((kind) => kind.companyId === companyId && kind.kindId === kindId) ?? null;
}

/** The protective facts that start on for a drafted kind, under their live names in K-26's registry (default 182). */
export const PROTECTIVE_FACTS: readonly string[] = ["documents", "forms"];

/** Each name once, in the order first named. */
function once(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/**
 * A drafted (new work) kind's facts and switches for its company kind (default R2; default 182): the protective facts,
 * then each answered block's facts, and in both flows each answered block's switches, each name once, in block order.
 * `draft` is the pick's draft as item 79 answers it, or null when none is on file (a pick drafted in this walk).
 */
export function draftedDefaults(draft: Pick<NewWorkDraftRead, "blocks"> | null): KindDefaults {
  const answered = [...(draft?.blocks ?? [])]
    .filter((block) => block.outcome === "answered")
    .sort((first, second) => first.block - second.block);
  const switches = once(answered.flatMap((block) => block.switchesOn));
  return {
    facts: once([...PROTECTIVE_FACTS, ...answered.flatMap((block) => block.factsOn)]),
    switchesA: switches,
    switchesB: [...switches],
  };
}
