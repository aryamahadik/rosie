// Doubles and inputs for the companies folder's tests (T-1492). Never imported by the Worker. None of them is the code
// under test: the K-05 reads (items 79 and 72 and readTurnState's catalog facts, as db/repo answers them), T-633's and
// T-634's real writers over their own doubles (journey-1/kinds and journey-1/plug-ins test-support), and the walk's
// doubles of T-1461 and T-1491 (commit/walk/test-support: bundle v1 with S1-08 and S1-09, the question read, the
// stand-in S1-08 writer). Every value comes from the contracts' fixtures and fixture set v1: K-23 seed-company-two-kinds.json
// (Sam's companies and their company kinds), K-24's catalog as the kinds seed plans it from the trade files (T-212),
// K-04 seed-person-roles.json (handle-sam); the master's sample cast and the 555-01xx range (rule 9).

import type {
  BusinessKindRead,
  ReadBusinessKindsOutcome,
  ReadBusinessKindsRequest,
} from "../../../../../db/repo/catalog-reads";
import type {
  CompanyRead,
  PickedKindRead,
  ReadPickedKindsOutcome,
  ReadPickedKindsRequest,
} from "../../../../../db/repo/kinds-reads";
import type { SetupTurnStateOutcome } from "../../../../../db/repo/setup/turn-state";
import type { FactValue, ReadTurnStateRequest } from "../../../../../db/repo/turn-state";
import {
  catalogPlanOf,
  openTradeSet,
  verifyTradeSet,
  type KindsCatalogRows,
} from "../../../../../db/seeds/kinds";
import type { WalkTestRepo } from "../../../commit/walk/test-support";
import { contractFile } from "../../test-support";
import { READ_AT } from "../kinds/test-support";
import type { CompaniesK05Reads, KindDefaults } from "./reads";

/** Sam's business, the call's in commit-s1-02.json (K-04 seed-business-head.json's Lee's Barbershop). */
export const SAM_BUSINESS = "biz-lees-barbershop";

/** Sam's person and handle (K-04 seed-person-roles.json). */
export const SAM_PERSON = "person-sam";
export const SAM_HANDLE = "handle-sam";

/** The company the turn runs under: Sam's own company of Lee's Barbershop (K-23 seed-company-two-kinds.json). */
export const SAM_COMPANY = "company-lees-barbershop";

/** K-23 seed-company-two-kinds.json, as its rows are written. */
interface SeedFile {
  readonly rows: readonly { readonly table: string; readonly values: Record<string, unknown> }[];
}

/** The K-23 company seed's rows of `table`. */
export function companySeedRows(table: string): Record<string, unknown>[] {
  const seedFile = contractFile("db-schema/business-setup/fixtures/seed-company-two-kinds.json") as SeedFile;
  return seedFile.rows.filter((row) => row.table === table).map((row) => structuredClone(row.values));
}

/** A K-23 companies row as the seed writes it. */
interface CompanySeed {
  readonly id: string;
  readonly owner_person_id: string;
  readonly name: string;
  readonly business_id: string | null;
  readonly version: number;
}

/** A K-23 company_kinds row as the seed writes it. */
interface CompanyKindSeed {
  readonly company_id: string;
  readonly kind_id: string;
  readonly business_id: string | null;
  readonly trade_name: string | null;
  readonly pf_facts: readonly string[];
  readonly pf_switches_a: readonly string[];
  readonly pf_switches_b: readonly string[];
  readonly version: number;
}

/** The seed's companies as item 79 answers them (K-05 v1.19 companyRead). */
export function seedCompanies(): CompanyRead[] {
  return (companySeedRows("companies") as unknown as CompanySeed[]).map((row) => ({
    id: row.id,
    ownerPersonId: row.owner_person_id,
    name: row.name,
    businessId: row.business_id,
    version: row.version,
  }));
}

/** Sam's companies item 79 answers under Lee's Barbershop: that business's company alone (none with no business). */
export function samCompanies(): CompanyRead[] {
  return seedCompanies().filter((company) => company.businessId === SAM_BUSINESS);
}

/** The seed's company kinds of `businessId` as item 72 answers them (K-05 v1.18 businessKindRead; flows left out). */
export function seedCompanyKinds(businessId: string = SAM_BUSINESS): BusinessKindRead[] {
  return (companySeedRows("company_kinds") as unknown as CompanyKindSeed[])
    .filter((row) => row.business_id === businessId)
    .map((row) => ({
      rowId: `${row.company_id}/${row.kind_id}`,
      companyId: row.company_id,
      kindId: row.kind_id,
      businessId,
      tradeName: row.trade_name,
      facts: [...row.pf_facts],
      switchesA: [...row.pf_switches_a],
      switchesB: [...row.pf_switches_b],
      version: row.version,
      flows: [],
    }));
}

let plan: KindsCatalogRows | undefined;

/** K-24's catalog rows the kinds seed writes (T-212's catalogPlanOf over the trade files), planned once. */
export function catalogRows(): KindsCatalogRows {
  plan ??= catalogPlanOf(verifyTradeSet(openTradeSet())).rows;
  return plan;
}

/** A listed kind's facts and switches as K-24's catalog holds them (kinds.facts; kind_flows.switches_on in A and B). */
export function catalogDefaults(kindId: string): KindDefaults {
  const rows = catalogRows();
  const kind = rows.kinds.find((row) => row.id === kindId);
  const flow = (letter: "A" | "B"): readonly string[] | undefined =>
    rows.kind_flows.find((row) => row.kind_id === kindId && row.flow === letter)?.switches_on;
  const switchesA = flow("A");
  const switchesB = flow("B");
  if (kind === undefined || switchesA === undefined || switchesB === undefined) {
    throw new Error(`the catalog holds ${kindId} in both flows`);
  }
  return { facts: [...kind.facts], switchesA: [...switchesA], switchesB: [...switchesB] };
}

/** A pick of Sam's on file, as item 79 answers it: listed or drafted, not placed yet, with no text unless given. */
export function pickOnFile(over: Partial<PickedKindRead> & Pick<PickedKindRead, "id">): PickedKindRead {
  return {
    ownerPersonId: SAM_PERSON,
    position: 1,
    words: "Plumbing",
    outcome: "listed",
    kindId: "plumber",
    companyId: null,
    businessId: null,
    pickedAt: "2026-10-19T14:00:00Z",
    version: 1,
    texts: [],
    draft: null,
    ...over,
  };
}

/** One read the companies double was asked for, with the repo it was handed where it takes one. */
export type CompaniesAsked =
  | { readonly read: "readPickedKinds"; readonly request: ReadPickedKindsRequest }
  | { readonly read: "readBusinessKinds"; readonly repo: unknown; readonly request: ReadBusinessKindsRequest }
  | { readonly read: "readTurnState"; readonly repo: unknown; readonly request: ReadTurnStateRequest };

/** What the companies double answers, or an answer given whole, or an error a read rejects with. */
export interface CompaniesGiven {
  /** Item 79's picks (default: none). */
  readonly picks?: readonly PickedKindRead[];
  /** Item 79's companies (default: Sam's company of Lee's Barbershop). */
  readonly companies?: readonly CompanyRead[];
  /** Item 72's company kinds (default: the seed's barber company kind of Lee's Barbershop). */
  readonly companyKinds?: readonly BusinessKindRead[];
  readonly picked?: ReadPickedKindsOutcome;
  readonly businessKinds?: ReadBusinessKindsOutcome;
  readonly turnState?: SetupTurnStateOutcome;
  /** A read that rejects with this error, as db/repo throws. */
  readonly throws?: { readonly read: CompaniesAsked["read"]; readonly error: Error };
}

export interface FakeCompanies {
  readonly k05: CompaniesK05Reads<WalkTestRepo>;
  /** Every read, in order. */
  readonly asked: CompaniesAsked[];
}

/** readTurnState's answer to the catalog facts asked, each from K-24's catalog rows, at version 1. */
function turnStateOf(request: ReadTurnStateRequest): SetupTurnStateOutcome {
  const rows = catalogRows();
  const facts: FactValue[] = [];
  for (const fact of request.facts) {
    const [kindId = "", letter] = fact.rowId.split("/");
    const value =
      fact.table === "kinds"
        ? rows.kinds.find((row) => row.id === kindId)?.facts
        : rows.kind_flows.find((row) => row.kind_id === kindId && row.flow === letter)?.switches_on;
    if (value === undefined) return { error: "notFound", table: fact.table, rowId: fact.rowId };
    facts.push({ ...fact, value: [...value], version: 1 });
  }
  return {
    result: "turnState",
    handleId: request.handleId,
    handle: { kind: "phone", address: "+15555550100" },
    businessId: request.businessId,
    readAt: READ_AT,
    persons: [],
    roles: [],
    phone: null,
    openQuestions: [],
    bookings: [],
    pauses: [],
    consents: [],
    facts,
  };
}

/**
 * The three reads as db/repo answers them: item 79 the picks and companies given, item 72 the company kinds given, and
 * readTurnState the catalog's facts and switches. Each read is written down and answered as a copy.
 */
export function fakeCompaniesK05(given: CompaniesGiven = {}): FakeCompanies {
  const asked: CompaniesAsked[] = [];
  const thrown = (read: CompaniesAsked["read"]): Promise<never> | null =>
    given.throws?.read === read ? Promise.reject(given.throws.error) : null;
  return {
    asked,
    k05: {
      readPickedKinds(request) {
        asked.push({ read: "readPickedKinds", request: structuredClone(request) });
        const answer: ReadPickedKindsOutcome = given.picked ?? {
          result: "pickedKinds",
          businessId: request.businessId,
          personId: request.personId,
          readAt: READ_AT,
          picks: [...(given.picks ?? [])],
          companies: [...(given.companies ?? samCompanies())],
        };
        return thrown("readPickedKinds") ?? Promise.resolve(structuredClone(answer));
      },
      readBusinessKinds(repo, request) {
        asked.push({ read: "readBusinessKinds", repo, request: structuredClone(request) });
        const answer: ReadBusinessKindsOutcome = given.businessKinds ?? {
          result: "businessKinds",
          businessId: request.businessId,
          readAt: READ_AT,
          setup: null,
          kinds: [...(given.companyKinds ?? seedCompanyKinds(request.businessId))],
        };
        return thrown("readBusinessKinds") ?? Promise.resolve(structuredClone(answer));
      },
      readTurnState(repo, request) {
        asked.push({ read: "readTurnState", repo, request: structuredClone(request) });
        const answer = given.turnState ?? turnStateOf(request);
        return thrown("readTurnState") ?? Promise.resolve(structuredClone(answer));
      },
    },
  };
}
