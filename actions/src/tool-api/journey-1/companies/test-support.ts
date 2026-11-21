// Doubles and inputs for the companies folder's tests (T-1492). Never imported by the Worker. None of them is the code
// under test: the K-05 reads (items 79 and 72 and readTurnState's catalog facts, as db/repo answers them), T-633's and
// T-634's real writers over their own doubles (journey-1/kinds and journey-1/plug-ins test-support), and the walk's
// doubles of T-1461 and T-1491 (commit/walk/test-support: bundle v1 with S1-08 and S1-09, the question read, the
// stand-in S1-08 writer). Every value comes from the contracts' fixtures and fixture set v1: K-23 seed-company-two-kinds.json
// (Sam's companies and their company kinds), K-24's catalog as the kinds seed plans it from the trade files (T-212),
// K-04 seed-person-roles.json (handle-sam); the master's sample cast and the 555-01xx range (rule 9). T-1481 adds the
// answered S1-04's call as the walk hands it to S1-04's writer, from K-09 commit-s1-04.json (the roster world) and
// commit-s1-04-some-share.json (Sam's own answer), with another button or other fields where a case needs them.

import path from "node:path";
import { pathToFileURL } from "node:url";

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
import type { GateAndCommitRequest, StateWrite } from "../../../commit/types";
import { flowGraphOf, textSourceOf, type GraphStep, type StepWriterCall } from "../../../commit/walk";
import {
  contextOf,
  decidedOf,
  flowAWithPlan,
  passedPartOf,
  type WalkTestRepo,
} from "../../../commit/walk/test-support";
import { contractFile, fixture } from "../../test-support";
import { CONTRACTS_DIR } from "../../validator";
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

/** One catalog fact's value as K-24's catalog rows hold it: a kind's name or facts, a flow's switches; undefined if none. */
function catalogValueOf(fact: ReadTurnStateRequest["facts"][number]): string | string[] | undefined {
  const rows = catalogRows();
  const [kindId = "", letter] = fact.rowId.split("/");
  if (fact.table === "kinds") {
    const kind = rows.kinds.find((row) => row.id === kindId);
    if (kind === undefined) return undefined;
    return fact.column === "name" ? kind.name : [...kind.facts];
  }
  const flow = rows.kind_flows.find((row) => row.kind_id === kindId && row.flow === letter);
  return flow === undefined ? undefined : [...flow.switches_on];
}

/**
 * readTurnState's answer to the catalog facts asked, each from K-24's catalog rows by its column (a kind's `name` or
 * `facts`, a flow's `switches_on`), at version 1.
 */
function turnStateOf(request: ReadTurnStateRequest): SetupTurnStateOutcome {
  const facts: FactValue[] = [];
  for (const fact of request.facts) {
    const value = catalogValueOf(fact);
    if (value === undefined) return { error: "notFound", table: fact.table, rowId: fact.rowId };
    facts.push({ ...fact, value, version: 1 });
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

// ---------------------------------------------------------------------------------------------------------------
// T-1481: an answered S1-04 as the walk hands it to S1-04's writer (default 181: the answered step is written)

/** K-09 v1.11's two accepted S1-04 commit fixtures: the roster owner's "All share one", and Sam's "Some share one". */
export const COMMIT_S1_04 = "commit-s1-04.json";
export const COMMIT_S1_04_SOME_SHARE = "commit-s1-04-some-share.json";

/**
 * An S1-04 commit fixture as S1-04's writer's tests read it: its request, the state rows it states and its outcome's
 * parts (the choice each part committed, which buttonsAnswerCommit reads the button from).
 */
export interface CommitS1_04 {
  readonly request: GateAndCommitRequest;
  readonly given: { readonly stated: { readonly writes: { readonly state: StateWrite[] } } };
  readonly outcome: { readonly parts: { choiceId: string }[] };
}

/** One field an S1-04 answer carries (K-02 v1 field), its value and its source words. */
export interface AnswerField {
  readonly name: string;
  readonly value: string;
  readonly words: string;
}

/**
 * An S1-04 commit fixture, freshly parsed, its one part choosing `choiceId` (c-01 "Some share one", c-02 "All share one",
 * c-03 "Each is its own", as its context offers them) with `fields`, each when given, else the fixture's own. A choice
 * given is the outcome's committed part's too, so K-09's rules read the button the part chose.
 */
export function s1_04Exchange(file: string, choiceId?: string, fields?: readonly AnswerField[]): CommitS1_04 {
  const exchange = fixture(file) as CommitS1_04;
  const [entry] = decidedOf(exchange.request).decide.parts;
  if (entry.part.verb !== "choose") throw new Error(`${file}'s part chooses`);
  const [committed] = exchange.outcome.parts;
  if (committed === undefined) throw new Error(`${file}'s outcome commits its part`);
  if (choiceId !== undefined) {
    entry.part.choice = choiceId;
    committed.choiceId = choiceId;
  }
  if (fields !== undefined) entry.part.fields = fields.map((field) => ({ ...field }));
  return exchange;
}

/** K-09's buttonsAnswerCommit (tool-api.rules.mjs v1.11), the rule `npm run contracts:check` holds the fixtures to. */
type ButtonsAnswerCommit = (exchange: unknown) => string[];

/**
 * What K-09's buttonsAnswerCommit finds wrong with `exchange` when it states `state` as S1-04's rows (README defaults
 * 181 to 185 and 190: the rows' foreign-key order, the groups, the companies and their names): none when it holds them.
 * Each problem is the rule's own line, so a rule refusal shows up in the writer's own tests.
 */
export async function s1_04RuleProblems(
  exchange: CommitS1_04,
  state: readonly StateWrite[],
): Promise<string[]> {
  const file = path.join(CONTRACTS_DIR, "tool-api", "tool-api.rules.mjs");
  const rules = (await import(pathToFileURL(file).href)) as {
    buttonsAnswerCommit: ButtonsAnswerCommit;
  };
  const { stated } = exchange.given;
  return rules.buttonsAnswerCommit({
    ...exchange,
    given: { ...exchange.given, stated: { ...stated, writes: { ...stated.writes, state: [...state] } } },
  });
}

/** A step of T-1491's test graph (bundle v1's flow A with S1-08 and S1-09), as the walk reads it. */
export function graphStep(stepId: string): GraphStep {
  const step = flowGraphOf(flowAWithPlan(), "A").step(stepId);
  if (step === null) throw new Error(`the test graph holds ${stepId}`);
  return step;
}

/**
 * The call the walk makes of S1-04's writer for `request`'s one part (writes.ts `written`): the part and the choice it
 * names, the commit's context (WalkTestRepo), S1-04 as the test graph holds it unless another step is given, and the
 * writer context, whose row ids follow default 131 under `turnKey` as the walk's do.
 */
export function s1_04CallOf(
  request: GateAndCommitRequest,
  turnKey: string,
  step: GraphStep = graphStep("S1-04"),
): StepWriterCall<WalkTestRepo> {
  const part = passedPartOf(request);
  const { choice } = part;
  if (choice === null) throw new Error("the part names an offered choice");
  const turn = contextOf(request);
  const counts = new Map<string, number>();
  return {
    repo: turn.repo,
    step,
    part,
    choice,
    writer: {
      turn,
      why: { step: step.id, choice: choice.branch },
      zone: "America/New_York",
      writerLane: "owner",
      rowId: (kind) => {
        const n = (counts.get(kind) ?? 0) + 1;
        counts.set(kind, n);
        return `${kind}-${step.id.toLowerCase()}-${turnKey}-${String(n)}`;
      },
      text: () => textSourceOf(request),
    },
  };
}
