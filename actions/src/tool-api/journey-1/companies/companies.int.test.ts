// T-1492's proof on local PostgreSQL (Lead note 1's Proves; K-09 README default 199 item (4), default 185): `npm run
// db:up`, then `npm run test:integration -- actions/src/tool-api/journey-1/companies`. Over a fresh schema migrated with
// every migration (commit/pg/test-support.ts: one schema per file, dropped when the file ends; the public schema is never
// touched), with K-04's seeds (bundle v0's registry, the three shops and their people: Sam Lee at Lee's Barbershop,
// handle-sam), K-23's seed-company-two-kinds.json (Sam's own company of Lee's Barbershop, with its barber company kind, as
// staging's roster world holds its barber kind), bundle v1's registry row from its own manifest, and K-24's catalog, the
// 243 trade-file kinds and their kind_flows as the kinds seed writes them from the trade files (T-212, insertCatalog).
//
// Real here: the one-kind wrapper and S1-04's settler (the code under test) over this folder's PostgreSQL binding
// (pgCompaniesK05Reads: item 79 and readTurnState's catalog facts as rosie_job, item 72 as rosie_app, each in its own
// read-only transaction); T-633's S1-02 writer over its own (pgKindsReads); T-632's matcher; T-634's `kinds` wrapper and
// S1-11 writer; T-1491's walk; the commit's request (build.ts) and K-05's commitTurn on the runtime side as rosie_job
// (commit/pg pgCommitTurn), with K-23's and K-24's tables, constraints, row-level security and grants as migrated.
// Doubles, because their tasks bind them: the walk's bundle port over T-1491's test graph (bundle v1's flow A with S1-08
// and S1-09) and its question read, S1-11's trade port over bundle v1's overlays, and S1-08's stand-in writer (T-1482's).
//
// Proven: "Plumbing" lands in one transaction (the commit's one transaction, all or nothing) with every foreign key
// holding: the plumbing company kind inserted under Sam's company and business before the pick, the pick inserted placed
// (company_id and business_id on its own insert), S1-11's eleven text blocks under the pick's business, S1-08's row and
// S1-09's question; read back through readPickedKinds (item 79) and readBusinessKinds (item 72), the barber company kind
// kept as seeded. And the pick left unplaced by a walk that asked S1-04 (the path before this card) is placed by the next
// one-kind walk, by an update at the version read, its eleven text blocks given the business in the same commit.
//
// T-1520 (DL-1056, DL-1076): S1-03 is bound as H1a binds it, T-633's writer inside the same instance's draft wrapper,
// with the stop home's reads its message is ruled with (the frozen seeds' double, as kinds.int.test.ts binds them). A
// one-kind "One isn't on the list yet" lands in one transaction with every foreign key holding: the drafted kind, its
// company kind, the placed pick and its draft under the pick's business (new_work_drafts_pick_business_fk); read back
// through item 79, the draft is answered beside its pick.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readBusinessKinds } from "../../../../../db/repo/catalog-reads";
import { catalogPlanOf, insertCatalog, openTradeSet, verifyTradeSet } from "../../../../../db/seeds/kinds";
import { buildCommitRequest } from "../../../commit/build";
import type { CommitTurnContext, StateWrite, UnitWrites } from "../../../commit";
import { pgCommitTurn } from "../../../commit/pg";
import { openCommitDatabase, seed, type CommitDatabase } from "../../../commit/pg/test-support";
import { createWritesOf, type ButtonsSettler, type StepRows, type StepWriter } from "../../../commit/walk";
import {
  NOTHING_OPEN,
  bundleV1Bundles,
  bundleV1Id,
  decidedOf,
  flowAWithPlan,
  questionsOver,
  tellingWriter,
  type WalkTestRepo,
} from "../../../commit/walk/test-support";
import { readsOn, seedWorld } from "../../../homes/stop/test-support";
import { kindsWriters, pgKindsReads } from "../kinds";
import { PACK_HIKES, turnWithWords } from "../kinds/test-support";
import { createPlugInWriters, PF_TEXT_KEYS } from "../plug-ins";
import { tradesOverV1 } from "../plug-ins/test-support";
import { companiesReadsOf, createOneKind, pgCompaniesK05Reads } from "./index";
import { SAM_BUSINESS, SAM_COMPANY, SAM_PERSON, catalogDefaults, companySeedRows } from "./test-support";

/** Connections per application client: the catalog, item 79 and item 72 reads each take one of their own. */
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
  cdb = await openCommitDatabase("j1_companies", POOL);
}, 180_000);

afterAll(async () => {
  await cdb.close();
});

/** What one walk wrote, step by step: S1-02's rows as placed, S1-11's, the settler's answer, and the walk's unit. */
interface Walked {
  readonly context: CommitTurnContext<WalkTestRepo>;
  readonly writes: UnitWrites;
  readonly rows: Map<string, StepRows | "ask">;
}

/**
 * Turn 2 choosing `choiceId` (default c-01, "All on the list") with `words`, its turn row's id `turnId` and turn key
 * `turnKey`, walked on T-1491's test graph with the writers H1a binds over PostgreSQL's reads; with `oneKind` false, the
 * walk before this card (S1-04 asked, S1-02's and S1-03's writers unwrapped).
 */
async function walked(
  words: string,
  turnId: string,
  turnKey: string,
  oneKind = true,
  choiceId = "c-01",
): Promise<Walked> {
  const turn = turnWithWords(choiceId, words);
  const context: CommitTurnContext<WalkTestRepo> = {
    ...turn.context,
    turn: { ...turn.context.turn, id: turnId },
  };
  const rows = new Map<string, StepRows | "ask">();
  const kept =
    (stepId: string, writer: StepWriter<WalkTestRepo>): StepWriter<WalkTestRepo> =>
    async (call) => {
      const got = await writer(call);
      rows.set(stepId, got);
      return got;
    };
  const kinds = kindsWriters<WalkTestRepo>({
    reads: pgKindsReads(cdb.toolApi, cdb.runtime),
    stop: readsOn(seedWorld(), null),
  });
  const plugIns = createPlugInWriters<WalkTestRepo>({ bundles: tradesOverV1().bundles });
  const placing = createOneKind<WalkTestRepo>({
    reads: companiesReadsOf(pgCompaniesK05Reads(cdb.toolApi, cdb.runtime)),
  });
  const s1_02 = oneKind ? placing.wrap(kinds["S1-02"]) : kinds["S1-02"];
  const s1_03 = oneKind ? placing.wrapDraft(kinds["S1-03"]) : kinds["S1-03"];
  const settler: ButtonsSettler<WalkTestRepo> = async (call) => {
    const got = await placing.settler(call);
    rows.set("S1-04", got);
    return got;
  };
  const byStep: Record<string, StepWriter<WalkTestRepo>> = {
    "S1-02": plugIns.kinds(kept("S1-02", s1_02)),
    "S1-03": kept("S1-03", s1_03),
    "S1-11": kept("S1-11", plugIns.plugIns),
    "S1-08": kept("S1-08", tellingWriter),
  };
  const writesOf = createWritesOf<WalkTestRepo>({
    bundles: bundleV1Bundles({ A: flowAWithPlan() }).bundles,
    turnKey: () => turnKey,
    questions: questionsOver().questions,
    writers: (stepId) => byStep[stepId] ?? null,
    ...(oneKind ? { buttonsSettlers: (stepId: string) => (stepId === "S1-04" ? settler : null) } : {}),
  });
  const writes = await writesOf(turn.part, context, NOTHING_OPEN);
  return { context, writes, rows };
}

/**
 * The walk's unit as this database can take it: every row it wrote but S1-02's question's close and the version it read,
 * since this schema holds no S1-02 question (turn 1's commit, K-09 commit-s1-01.json, is not run here).
 */
function landable(writes: UnitWrites): UnitWrites {
  return { ...writes, versionsRead: [], closes: [] };
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

/** Item 79 (readPickedKinds, as rosie_job) under the call's business and Sam's person, as the one-kind path reads it. */
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
    companyId: kind.companyId,
    kindId: kind.kindId,
    businessId: kind.businessId,
    tradeName: kind.tradeName,
    facts: kind.facts,
    switchesA: kind.switchesA,
    switchesB: kind.switchesB,
    version: kind.version,
  }));
}

/** The seeded barber company kind as item 72 answers it: facts and switches as seeded, version 1. */
function seededBarber() {
  const [barber] = companySeedRows("company_kinds").filter((row) => row.company_id === SAM_COMPANY);
  if (barber === undefined) throw new Error("the K-23 seed holds Sam's barber company kind");
  return {
    rowId: `${SAM_COMPANY}/barber`,
    companyId: SAM_COMPANY,
    kindId: "barber",
    businessId: SAM_BUSINESS,
    tradeName: null,
    facts: barber.pf_facts,
    switchesA: barber.pf_switches_a,
    switchesB: barber.pf_switches_b,
    version: 1,
  };
}

/** Every pick of Sam's with its company kind (the foreign key's two sides), as the owner reads the tables. */
async function picksWithKinds() {
  return cdb.db.sql<Record<string, unknown>[]>`
    select p.id, p.kind_id, p.company_id, p.business_id, p.version, ck.business_id as kind_business_id,
           c.business_id as company_business_id
    from picked_kinds p
    left join company_kinds ck on ck.company_id = p.company_id and ck.kind_id = p.kind_id
    left join companies c on c.id = p.company_id
    where p.owner_person_id = ${SAM_PERSON}
    order by p.id
  `;
}

/** Every draft of Sam's picks with its pick's business (new_work_drafts_pick_business_fk's two sides). */
async function draftsWithPicks() {
  return cdb.db.sql<Record<string, unknown>[]>`
    select d.id, d.picked_kind_id, d.business_id, d.state, d.version, p.business_id as pick_business_id
    from new_work_drafts d
    join picked_kinds p on p.id = d.picked_kind_id
    where p.owner_person_id = ${SAM_PERSON}
    order by d.id
  `;
}

/** The business of each of a pick's text blocks, by pf key, as the owner reads them. */
async function textBusinesses(pickId: string) {
  return cdb.db.sql<{ pf_key: string; business_id: string | null; version: number }[]>`
    select pf_key, business_id, version from picked_kind_texts where picked_kind_id = ${pickId} order by pf_key
  `;
}

describe("the one-kind commit on PostgreSQL", () => {
  it(
    "'Plumbing' lands in one transaction with every foreign key holding, S1-11's blocks under the pick's business",
    SLOW,
    async () => {
      await fresh();
      const { context, writes, rows } = await walked("Plumbing", "turn-s1-02-sam-one-kind", "sam-one-kind");
      // The walk: S1-02's rows placed, S1-11's under the pick's business, S1-04 settled with no row, S1-08, S1-09 asked.
      expect(rows.get("S1-04")).toEqual({
        state: [],
        stateEvents: [],
        gives: ["companies"],
        asks: [],
        messages: [],
      });
      expect(writes.asks.map((ask) => ask.question.step)).toEqual(["S1-09"]);
      const [kind, pick] = writes.state;
      expect(kind).toMatchObject({ op: "insert", table: "company_kinds" });
      expect(pick).toMatchObject({
        op: "insert",
        table: "picked_kinds",
        values: { company_id: SAM_COMPANY, business_id: SAM_BUSINESS },
      });

      const answer = await committed(context, landable(writes));
      expect(answer).toMatchObject({
        result: "committed",
        turnId: "turn-s1-02-sam-one-kind",
        repeated: false,
      });
      if (!("committed" in answer)) throw new Error("the commit wrote");
      const written = answer.committed.written;
      expect(written.slice(0, 13)).toEqual([
        { table: "company_kinds", rowId: `${SAM_COMPANY}/plumber`, version: 1 },
        { table: "picked_kinds", rowId: "pick-s1-02-sam-one-kind-1", version: 1 },
        ...PF_TEXT_KEYS.map((key) => ({
          table: "picked_kind_texts",
          rowId: `pick-s1-02-sam-one-kind-1/${key}`,
          version: 1,
        })),
      ]);
      expect(answer.committed.outboxRows.map((row) => row.id)).toEqual([
        "outbox-s1-08-sam-one-kind-1",
        "outbox-s1-09-sam-one-kind-1",
      ]);

      // Every foreign key holds: the pick's company kind and company are its business's.
      expect(await picksWithKinds()).toEqual([
        {
          id: "pick-s1-02-sam-one-kind-1",
          kind_id: "plumber",
          company_id: SAM_COMPANY,
          business_id: SAM_BUSINESS,
          version: 1,
          kind_business_id: SAM_BUSINESS,
          company_business_id: SAM_BUSINESS,
        },
      ]);

      // Read back through item 79: the pick placed, its eleven blocks under the business, Sam's company.
      const onFile = await picksOnFile();
      expect(onFile.companies.map((company) => company.id)).toEqual([SAM_COMPANY]);
      expect(onFile.picks).toHaveLength(1);
      const [read] = onFile.picks;
      expect(read).toMatchObject({
        id: "pick-s1-02-sam-one-kind-1",
        ownerPersonId: SAM_PERSON,
        position: 1,
        words: "Plumbing",
        outcome: "listed",
        kindId: "plumber",
        companyId: SAM_COMPANY,
        businessId: SAM_BUSINESS,
        version: 1,
        draft: null,
      });
      expect(read?.texts.map((text) => [text.pfKey, text.businessId, text.version])).toEqual(
        [...PF_TEXT_KEYS].sort().map((key) => [key, SAM_BUSINESS, 1]),
      );

      // Read back through item 72: the barber company kind kept as seeded, the plumbing one with the catalog's lists.
      const plumber = catalogDefaults("plumber");
      expect(await businessKinds()).toEqual([
        seededBarber(),
        {
          rowId: `${SAM_COMPANY}/plumber`,
          companyId: SAM_COMPANY,
          kindId: "plumber",
          businessId: SAM_BUSINESS,
          tradeName: null,
          facts: plumber.facts,
          switchesA: plumber.switchesA,
          switchesB: plumber.switchesB,
          version: 1,
        },
      ]);
    },
  );

  it(
    "the pick a walk left unplaced (S1-04 asked) is placed by the next one-kind walk, by an update at its version, its blocks given the business",
    SLOW,
    async () => {
      await fresh();
      // The walk before this card: "Plumbing" asks S1-04, and its pick and blocks land with no company and no business.
      const before = await walked("Plumbing", "turn-s1-02-sam-asked", "sam-asked", false);
      expect(before.writes.asks.map((ask) => ask.question.step)).toEqual(["S1-04"]);
      const s1_02 = before.rows.get("S1-02");
      const s1_11 = before.rows.get("S1-11");
      if (s1_02 === undefined || s1_02 === "ask" || s1_11 === undefined || s1_11 === "ask") {
        throw new Error("the walk wrote S1-02 and S1-11");
      }
      const state: StateWrite[] = [...s1_02.state, ...s1_11.state];
      const first = await committed(before.context, {
        ...landable(before.writes),
        state,
        asks: [],
        messages: [],
      });
      expect(first).toMatchObject({ result: "committed" });
      expect(await picksWithKinds()).toEqual([
        {
          id: "pick-s1-02-sam-asked-1",
          kind_id: "plumber",
          company_id: null,
          business_id: null,
          version: 1,
          kind_business_id: null,
          company_business_id: null,
        },
      ]);

      // The one-kind walk: the kind is picked again, so S1-02 inserts nothing and the settler places the pick on file.
      const { context, writes, rows } = await walked("Plumbing", "turn-s1-02-sam-placed", "sam-placed");
      const settled = rows.get("S1-04");
      expect(settled === "ask" ? settled : settled?.state.map((write) => [write.op, write.table])).toEqual([
        ["insert", "company_kinds"],
        ["update", "picked_kinds"],
        ...PF_TEXT_KEYS.map(() => ["update", "picked_kind_texts"]),
      ]);
      const answer = await committed(context, landable(writes));
      expect(answer).toMatchObject({ result: "committed", turnId: "turn-s1-02-sam-placed", repeated: false });
      if (!("committed" in answer)) throw new Error("the commit wrote");
      expect(answer.committed.written.slice(0, 2)).toEqual([
        { table: "company_kinds", rowId: `${SAM_COMPANY}/plumber`, version: 1 },
        { table: "picked_kinds", rowId: "pick-s1-02-sam-asked-1", version: 2 },
      ]);
      expect(await picksWithKinds()).toEqual([
        {
          id: "pick-s1-02-sam-asked-1",
          kind_id: "plumber",
          company_id: SAM_COMPANY,
          business_id: SAM_BUSINESS,
          version: 2,
          kind_business_id: SAM_BUSINESS,
          company_business_id: SAM_BUSINESS,
        },
      ]);
      expect(await textBusinesses("pick-s1-02-sam-asked-1")).toEqual(
        [...PF_TEXT_KEYS].sort().map((key) => ({ pf_key: key, business_id: SAM_BUSINESS, version: 2 })),
      );
      const [read] = (await picksOnFile()).picks;
      expect(read).toMatchObject({ companyId: SAM_COMPANY, businessId: SAM_BUSINESS, version: 2 });
      expect(read?.texts).toHaveLength(11);
    },
  );

  it(
    "a one-kind 'One isn't on the list yet' lands in one transaction with every foreign key holding, its draft under the pick's business, answered by item 79 beside its pick (T-1520)",
    SLOW,
    async () => {
      await fresh();
      const { context, writes, rows } = await walked(
        PACK_HIKES,
        "turn-s1-02-sam-one-new",
        "sam-one-new",
        true,
        "c-02",
      );
      expect(writes.asks.map((ask) => ask.question.step)).toEqual(["S1-09"]);
      const [drafted] = writes.state;
      if (drafted?.op !== "insert" || drafted.table !== "kinds")
        throw new Error("S1-02 drafts the kind first");
      const kindId = String(drafted.values.id);
      // S1-03's draft as the draft wrapper hands it on: under the business its one pick was placed under.
      const s1_03 = rows.get("S1-03");
      expect(s1_03 === "ask" ? s1_03 : s1_03?.state).toEqual([
        {
          op: "insert",
          table: "new_work_drafts",
          values: {
            id: "draft-s1-03-sam-one-new-1",
            picked_kind_id: "pick-s1-02-sam-one-new-1",
            business_id: SAM_BUSINESS,
            state: "drafting",
            drafted_at: context.request.now,
          },
        },
      ]);

      const answer = await committed(context, landable(writes));
      expect(answer).toMatchObject({
        result: "committed",
        turnId: "turn-s1-02-sam-one-new",
        repeated: false,
      });
      if (!("committed" in answer)) throw new Error("the commit wrote");
      expect(answer.committed.written.slice(0, 4)).toEqual([
        { table: "kinds", rowId: kindId, version: 1 },
        { table: "company_kinds", rowId: `${SAM_COMPANY}/${kindId}`, version: 1 },
        { table: "picked_kinds", rowId: "pick-s1-02-sam-one-new-1", version: 1 },
        { table: "new_work_drafts", rowId: "draft-s1-03-sam-one-new-1", version: 1 },
      ]);
      expect(answer.committed.outboxRows.map((row) => row.id)).toEqual([
        "outbox-s1-03-sam-one-new-1",
        "outbox-s1-08-sam-one-new-1",
        "outbox-s1-09-sam-one-new-1",
      ]);

      // Every foreign key holds: the pick's company kind and company are its business's, the draft's business its pick's.
      expect(await picksWithKinds()).toEqual([
        {
          id: "pick-s1-02-sam-one-new-1",
          kind_id: kindId,
          company_id: SAM_COMPANY,
          business_id: SAM_BUSINESS,
          version: 1,
          kind_business_id: SAM_BUSINESS,
          company_business_id: SAM_BUSINESS,
        },
      ]);
      expect(await draftsWithPicks()).toEqual([
        {
          id: "draft-s1-03-sam-one-new-1",
          picked_kind_id: "pick-s1-02-sam-one-new-1",
          business_id: SAM_BUSINESS,
          state: "drafting",
          version: 1,
          pick_business_id: SAM_BUSINESS,
        },
      ]);

      // Read back through item 79 (readPickedKinds, as rosie_job): the draft answered beside its pick, under the business.
      const onFile = await picksOnFile();
      expect(onFile.picks).toHaveLength(1);
      const [read] = onFile.picks;
      expect(read).toMatchObject({
        id: "pick-s1-02-sam-one-new-1",
        ownerPersonId: SAM_PERSON,
        position: 1,
        words: PACK_HIKES,
        outcome: "new_work",
        kindId,
        companyId: SAM_COMPANY,
        businessId: SAM_BUSINESS,
        version: 1,
        texts: [],
        draft: {
          id: "draft-s1-03-sam-one-new-1",
          businessId: SAM_BUSINESS,
          state: "drafting",
          version: 1,
          blocks: [],
        },
      });
    },
  );
});
