// T-1481's proof on local PostgreSQL (the card's Proves; K-09 README v1.11 defaults 182 to 184 and 190): `npm run db:up`,
// then `npm run test:integration -- actions/src/tool-api/journey-1/companies`. Over a fresh schema migrated with every
// migration (commit/pg/test-support.ts: one schema per file, dropped when the file ends; the public schema is never
// touched), with K-04's seeds (bundle v0's registry, the three shops and their people: Sam Lee at Lee's Barbershop,
// handle-sam), K-23's seed-company-two-kinds.json (Sam's own company of Lee's Barbershop with its barber company kind),
// bundle v1's registry row and K-24's catalog, the 243 trade-file kinds and their kind_flows as the kinds seed writes them.
//
// Real here: S1-04's writer (the code under test) over this folder's PostgreSQL binding (pgCompaniesK05Reads: item 79
// and readTurnState's catalog facts as rosie_job, item 72 as rosie_app, each in a read-only transaction of its own); the
// commit's request (build.ts) and K-05's commitTurn as rosie_job (commit/pg pgCommitTurn), with K-23's and K-24's
// tables, constraints, row-level security and grants as migrated; and, to put Sam's three picks on file first, the turn
// before (T-633's S1-02 writer over pgKindsReads, T-634's `kinds` wrapper and S1-11 writer, T-1491's walk, as
// companies.int.test.ts lands it). Doubles, because their tasks bind them: the walk's bundle port over T-1491's test graph
// and its question read, S1-11's trade port over bundle v1's overlays, and S1-08's stand-in writer.
//
// Proven: one commit writes S1-04's rows in one transaction with every foreign key holding, read back through
// readPickedKinds (item 79) and readBusinessKinds (item 72): "All share one" (the party flag off) places the three picks
// in Sam's company of Lee's Barbershop, its barber company kind kept as seeded and the plumbing and electrical company
// kinds inserted, the barbershop's eleven blocks given the business; and Sam's own "Some share one" (the flag on) makes
// Lee Home Services, a new company of Sam's with no business, with its two company kinds, and places plumbing and
// electrical in it with no business, the barbershop in the company under way with its business.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readBusinessKinds } from "../../../../../db/repo/catalog-reads";
import { catalogPlanOf, insertCatalog, openTradeSet, verifyTradeSet } from "../../../../../db/seeds/kinds";
import { buildCommitRequest } from "../../../commit/build";
import type { CommitTurnContext, GateAndCommitRequest, StateWrite, UnitWrites } from "../../../commit";
import { pgCommitTurn } from "../../../commit/pg";
import { openCommitDatabase, seed, type CommitDatabase } from "../../../commit/pg/test-support";
import { createWritesOf, type StepRows, type StepWriter } from "../../../commit/walk";
import {
  NOTHING_OPEN,
  bundleV1Bundles,
  bundleV1Id,
  decidedOf,
  flowAWithPlan,
  questionsOver,
  requestTurnFields,
  tellingWriter,
  type WalkTestRepo,
} from "../../../commit/walk/test-support";
import { kindsWriters, pgKindsReads } from "../kinds";
import { turnWithWords } from "../kinds/test-support";
import { createPlugInWriters, PF_TEXT_KEYS } from "../plug-ins";
import { tradesOverV1 } from "../plug-ins/test-support";
import { companiesReadsOf, companiesWriter, pgCompaniesK05Reads } from "./index";
import {
  COMMIT_S1_04_SOME_SHARE,
  SAM_BUSINESS,
  SAM_COMPANY,
  SAM_PERSON,
  catalogDefaults,
  companySeedRows,
  s1_04CallOf,
  s1_04Exchange,
  type AnswerField,
} from "./test-support";

/** Connections per application client: item 79, item 72 and the catalog reads each take one of their own. */
const POOL = 4;

const SLOW = { timeout: 120_000 };

let cdb: CommitDatabase;

/** Empties the schema's heads and loads the seeds, bundle v1's registry row and K-24's catalog (each test starts here). */
async function fresh(): Promise<void> {
  await seed(cdb, ["seed-bundle-registry.json", "../../business-setup/fixtures/seed-company-two-kinds.json"]);
  const { sql } = cdb.db;
  const { hash, build } = bundleV1Id();
  await sql`
    insert into bundles (hash, build, manifest_key, built_at)
    values (${hash}, ${build}, ${`bundle/${hash}/${String(build)}/manifest`}, ${"2026-11-18T10:26:00Z"})
  `;
  const { rows } = catalogPlanOf(verifyTradeSet(openTradeSet()));
  await sql.begin(async (tx) => {
    await insertCatalog(tx, rows);
  });
}

beforeAll(async () => {
  cdb = await openCommitDatabase("j1_companies_s1_04", POOL);
}, 180_000);

afterAll(async () => {
  await cdb.close();
});

/** A unit that writes `state` alone, as the walk's unit for a part (no question, row or close here). */
function unitOf(state: readonly StateWrite[], why: UnitWrites["why"]): UnitWrites {
  return {
    why,
    versionsRead: [],
    state,
    stateEvents: [],
    asks: [],
    closes: [],
    clockCancels: [],
    messages: [],
    reservations: { confirm: [], release: [] },
    effects: { write: [], letGo: [] },
    gives: [],
  };
}

/** The unit committed through K-05's commitTurn as rosie_job, in one transaction, under the turn's row. */
async function committed(context: CommitTurnContext<WalkTestRepo>, writes: UnitWrites) {
  const { people } = decidedOf(context.request).context.writer;
  const personId = context.request.caller.personId;
  const person = people.find((each) => each.personId === personId);
  const request = buildCommitRequest({
    turn: context.turn,
    zone: "America/New_York",
    businessId: context.businessId,
    actor: {
      personId,
      roleAt: (businessId) => person?.roles.find((role) => role.businessId === businessId)?.role ?? null,
    },
    units: [{ writes, answer: null }],
  });
  const commitTurn = pgCommitTurn<WalkTestRepo>(cdb.runtime, { now: () => new Date(context.request.now) });
  return commitTurn(request, {
    repo: context.repo,
    businessId: context.businessId,
    span: { limits: [], rows: [] },
  });
}

/**
 * Sam's three picks on file, as the turn before lands them: "Barbershop, plumbing, electrical" walked with T-633's S1-02
 * writer and T-634's S1-11 writer over PostgreSQL's reads (S1-04 asked, as before the one-kind path), and S1-02's and
 * S1-11's state rows committed: three listed picks with no company and no business, the barbershop's eleven blocks.
 */
async function samPicksOnFile(): Promise<void> {
  const turn = turnWithWords("c-01", "Barbershop, plumbing, electrical");
  const context: CommitTurnContext<WalkTestRepo> = {
    ...turn.context,
    turn: { ...turn.context.turn, id: "turn-s1-02-sam-picks" },
  };
  const rows = new Map<string, StepRows>();
  const kept =
    (stepId: string, writer: StepWriter<WalkTestRepo>): StepWriter<WalkTestRepo> =>
    async (call) => {
      const got = await writer(call);
      rows.set(stepId, got);
      return got;
    };
  const kinds = kindsWriters<WalkTestRepo>({ reads: pgKindsReads(cdb.toolApi, cdb.runtime) });
  const plugIns = createPlugInWriters<WalkTestRepo>({ bundles: tradesOverV1().bundles });
  const byStep: Record<string, StepWriter<WalkTestRepo>> = {
    "S1-02": plugIns.kinds(kept("S1-02", kinds["S1-02"])),
    "S1-11": kept("S1-11", plugIns.plugIns),
    "S1-08": tellingWriter,
  };
  const writesOf = createWritesOf<WalkTestRepo>({
    bundles: bundleV1Bundles({ A: flowAWithPlan() }).bundles,
    turnKey: () => "sam-picks",
    questions: questionsOver().questions,
    writers: (stepId) => byStep[stepId] ?? null,
  });
  const walked = await writesOf(turn.part, context, NOTHING_OPEN);
  expect(walked.asks.map((ask) => ask.question.step)).toEqual(["S1-04"]);
  const state = [...(rows.get("S1-02")?.state ?? []), ...(rows.get("S1-11")?.state ?? [])];
  const answer = await committed(context, unitOf(state, walked.why));
  expect(answer).toMatchObject({ result: "committed" });
}

/** Sam's answer to S1-04 (commit-s1-04-some-share.json's turn, pinned to bundle v1 as the turn before), its turn's id. */
function samAnswer(choiceId: string, fields: readonly AnswerField[], turnId: string): GateAndCommitRequest {
  const { request } = s1_04Exchange(COMMIT_S1_04_SOME_SHARE, choiceId, fields);
  const turn = requestTurnFields(request);
  turn.id = turnId;
  turn.bundleId = { ...bundleV1Id() };
  return request;
}

/** S1-04's writer's rows for `request` over PostgreSQL's reads, committed in one transaction. */
async function writtenAndCommitted(request: GateAndCommitRequest, turnKey: string, partyRuleLive: boolean) {
  const write = companiesWriter<WalkTestRepo>({
    reads: companiesReadsOf(pgCompaniesK05Reads(cdb.toolApi, cdb.runtime)),
    partyRuleLive,
  });
  const call = s1_04CallOf(request, turnKey);
  const rows = await write(call);
  const answer = await committed(call.writer.turn, {
    ...unitOf(rows.state, call.writer.why),
    gives: rows.gives,
  });
  return { rows, answer };
}

/** Item 79 (readPickedKinds, as rosie_job) under Lee's Barbershop and Sam's person. */
async function picksOnFile() {
  return pgKindsReads(cdb.toolApi, cdb.runtime).pickedKinds({
    businessId: SAM_BUSINESS,
    personId: SAM_PERSON,
  });
}

/** Item 72 (readBusinessKinds, as rosie_app) of Lee's Barbershop: each company kind, its kind's flows left out. */
async function businessKinds() {
  const outcome = await readBusinessKinds(cdb.toolApi, { businessId: SAM_BUSINESS });
  if ("error" in outcome) throw new Error(`readBusinessKinds answered ${outcome.error}`);
  return outcome.kinds.map((kind) => ({
    rowId: kind.rowId,
    businessId: kind.businessId,
    tradeName: kind.tradeName,
    facts: kind.facts,
    switchesA: kind.switchesA,
    switchesB: kind.switchesB,
    version: kind.version,
  }));
}

/** A company kind as item 72 answers it: under Lee's Barbershop, no trade name, the lists given, at version 1. */
function kindRead(
  kindId: string,
  lists: { facts: readonly string[]; switchesA: readonly string[]; switchesB: readonly string[] },
) {
  return {
    rowId: `${SAM_COMPANY}/${kindId}`,
    businessId: SAM_BUSINESS,
    tradeName: null,
    facts: [...lists.facts],
    switchesA: [...lists.switchesA],
    switchesB: [...lists.switchesB],
    version: 1,
  };
}

/** The seeded barber company kind's lists (K-23 seed-company-two-kinds.json). */
function seededBarber() {
  const [barber] = companySeedRows("company_kinds").filter((row) => row.company_id === SAM_COMPANY);
  if (barber === undefined) throw new Error("the K-23 seed holds Sam's barber company kind");
  return kindRead("barber", {
    facts: barber.pf_facts as string[],
    switchesA: barber.pf_switches_a as string[],
    switchesB: barber.pf_switches_b as string[],
  });
}

/** Every pick of Sam's with its company kind and its company (each foreign key's two sides), as the owner reads them. */
async function picksWithKinds() {
  return cdb.db.sql<Record<string, unknown>[]>`
    select p.id, p.kind_id, p.company_id, p.business_id, p.version, ck.company_id as kind_company_id,
           ck.business_id as kind_business_id, c.business_id as company_business_id, c.owner_person_id as company_owner
    from picked_kinds p
    left join company_kinds ck on ck.company_id = p.company_id and ck.kind_id = p.kind_id
    left join companies c on c.id = p.company_id
    where p.owner_person_id = ${SAM_PERSON}
    order by p.position
  `;
}

/** The business and version of each of a pick's text blocks, by pf key, as the owner reads them. */
async function textBusinesses(pickId: string) {
  return cdb.db.sql<{ pf_key: string; business_id: string | null; version: number }[]>`
    select pf_key, business_id, version from picked_kind_texts where picked_kind_id = ${pickId} order by pf_key
  `;
}

/** Sam's three picks as the turn before lands them, the barbershop first (default 131's ids under turn key sam-picks). */
const BARBERSHOP = "pick-s1-02-sam-picks-1";
const PLUMBING = "pick-s1-02-sam-picks-2";
const ELECTRICAL = "pick-s1-02-sam-picks-3";
const PICKS = [BARBERSHOP, PLUMBING, ELECTRICAL];

/** The barbershop's eleven blocks as item 79 answers them, by pf key (K-05 v1.19 default 179), and so as written. */
const BLOCKS_BY_KEY = [...PF_TEXT_KEYS].sort();

describe("S1-04's writer: one commit writes its rows, every foreign key holding", () => {
  it(
    "'All share one' (the party flag off): the three picks in Sam's company of Lee's Barbershop, its barber kind kept",
    SLOW,
    async () => {
      await fresh();
      await samPicksOnFile();
      const request = samAnswer("c-02", [], "turn-s1-04-sam-all");
      const { rows, answer } = await writtenAndCommitted(request, "sam-all", false);
      expect(answer).toMatchObject({ result: "committed", turnId: "turn-s1-04-sam-all", repeated: false });
      if (!("committed" in answer)) throw new Error("the commit wrote");
      expect(rows.state.filter((write) => write.table === "companies")).toEqual([]);
      expect(answer.committed.written.slice(0, 16)).toEqual([
        { table: "company_kinds", rowId: `${SAM_COMPANY}/plumber`, version: 1 },
        { table: "company_kinds", rowId: `${SAM_COMPANY}/electrician`, version: 1 },
        ...PICKS.map((rowId) => ({ table: "picked_kinds", rowId, version: 2 })),
        ...BLOCKS_BY_KEY.map((key) => ({
          table: "picked_kind_texts",
          rowId: `${BARBERSHOP}/${key}`,
          version: 2,
        })),
      ]);

      // Every foreign key holds: each pick's company kind and company are its business's, the company Sam's.
      expect(await picksWithKinds()).toEqual(
        PICKS.map((id, index) => ({
          id,
          kind_id: ["barber", "plumber", "electrician"][index],
          company_id: SAM_COMPANY,
          business_id: SAM_BUSINESS,
          version: 2,
          kind_company_id: SAM_COMPANY,
          kind_business_id: SAM_BUSINESS,
          company_business_id: SAM_BUSINESS,
          company_owner: SAM_PERSON,
        })),
      );
      expect(await textBusinesses(BARBERSHOP)).toEqual(
        BLOCKS_BY_KEY.map((key) => ({ pf_key: key, business_id: SAM_BUSINESS, version: 2 })),
      );

      // Read back through item 79: three placed picks under the business, the barbershop's blocks with it.
      const onFile = await picksOnFile();
      expect(onFile.companies.map((company) => [company.id, company.businessId, company.version])).toEqual([
        [SAM_COMPANY, SAM_BUSINESS, 2],
      ]);
      expect(onFile.picks.map((pick) => [pick.id, pick.companyId, pick.businessId, pick.version])).toEqual(
        PICKS.map((id) => [id, SAM_COMPANY, SAM_BUSINESS, 2]),
      );
      expect(onFile.picks[0]?.texts.map((text) => text.businessId)).toEqual(
        PF_TEXT_KEYS.map(() => SAM_BUSINESS),
      );

      // Read back through item 72: the barber kind kept as seeded, plumbing and electrical with the catalog's lists.
      expect(await businessKinds()).toEqual([
        seededBarber(),
        kindRead("electrician", catalogDefaults("electrician")),
        kindRead("plumber", catalogDefaults("plumber")),
      ]);
    },
  );

  it(
    "Sam's 'Some share one' (the flag on): Lee Home Services made with no business, plumbing and electrical in it",
    SLOW,
    async () => {
      await fresh();
      await samPicksOnFile();
      const request = samAnswer(
        "c-01",
        [
          { name: "shared_kinds", value: "Plumbing and electrical", words: "Plumbing and electrical" },
          { name: "company_name", value: "Lee Home Services", words: "Lee Home Services" },
        ],
        "turn-s1-04-sam-some",
      );
      const { rows, answer } = await writtenAndCommitted(request, "sam-some", true);
      const made = "company-s1-04-sam-some-1";
      expect(rows.state[0]).toEqual({
        op: "insert",
        table: "companies",
        values: { id: made, owner_person_id: SAM_PERSON, name: "Lee Home Services", business_id: null },
      });
      expect(answer).toMatchObject({ result: "committed", turnId: "turn-s1-04-sam-some", repeated: false });
      if (!("committed" in answer)) throw new Error("the commit wrote");
      expect(answer.committed.written.slice(0, 6)).toEqual([
        { table: "companies", rowId: made, version: 1 },
        { table: "company_kinds", rowId: `${made}/plumber`, version: 1 },
        { table: "company_kinds", rowId: `${made}/electrician`, version: 1 },
        ...PICKS.map((rowId) => ({ table: "picked_kinds", rowId, version: 2 })),
      ]);

      // Every foreign key holds: the barbershop in the company under way with its business; plumbing and electrical in
      // the new company with no business, each beside its company kind there.
      expect(await picksWithKinds()).toEqual([
        {
          id: BARBERSHOP,
          kind_id: "barber",
          company_id: SAM_COMPANY,
          business_id: SAM_BUSINESS,
          version: 2,
          kind_company_id: SAM_COMPANY,
          kind_business_id: SAM_BUSINESS,
          company_business_id: SAM_BUSINESS,
          company_owner: SAM_PERSON,
        },
        ...[
          [PLUMBING, "plumber"],
          [ELECTRICAL, "electrician"],
        ].map(([id, kindId]) => ({
          id,
          kind_id: kindId,
          company_id: made,
          business_id: null,
          version: 2,
          kind_company_id: made,
          kind_business_id: null,
          company_business_id: null,
          company_owner: SAM_PERSON,
        })),
      ]);
      expect(await textBusinesses(BARBERSHOP)).toEqual(
        BLOCKS_BY_KEY.map((key) => ({ pf_key: key, business_id: SAM_BUSINESS, version: 2 })),
      );
      // The barbershop's blocks only: plumbing's and electrical's (none loaded yet) take no business.
      expect(await textBusinesses(PLUMBING)).toEqual([]);

      // Read back through item 79: both of Sam's companies (the new one with no business), the barbershop under the
      // business and the other two with none.
      const onFile = await picksOnFile();
      expect(
        onFile.companies.map((company) => [
          company.id,
          company.ownerPersonId,
          company.name,
          company.businessId,
        ]),
      ).toEqual([
        [SAM_COMPANY, SAM_PERSON, "Lee's Barbershop LLC", SAM_BUSINESS],
        [made, SAM_PERSON, "Lee Home Services", null],
      ]);
      expect(onFile.picks.map((pick) => [pick.id, pick.companyId, pick.businessId, pick.version])).toEqual([
        [BARBERSHOP, SAM_COMPANY, SAM_BUSINESS, 2],
        [PLUMBING, made, null, 2],
        [ELECTRICAL, made, null, 2],
      ]);

      // Read back through item 72: the business's company kinds alone, the barber kind kept as seeded; the new company's
      // kinds have no business yet, so no business scope sees them.
      expect(await businessKinds()).toEqual([seededBarber()]);
    },
  );
});
