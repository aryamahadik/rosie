// T-633's proof on local PostgreSQL (the card's Proves; DL-988 item 8): `npm run db:up`, then
// `npm run test:integration -- actions/src/tool-api/journey-1/kinds`. Over a fresh schema migrated with every migration
// (commit/pg/test-support.ts: one schema per file, dropped when the file ends; the public schema is never touched), with
// K-04's seeds (bundle v0's registry, the three shops and their people: Sam Lee at Lee's Barbershop, handle-sam), bundle
// v1's registry row from its own manifest, and the 243 trade-file kinds the kinds seed plans from fixture set v1 (T-212).
//
// Real here: item 78 (readKindCatalog) on a client whose connections run as rosie_app and item 79 (readPickedKinds) on one
// as rosie_job, each through this folder's binding (pgKindsReads), each in its own read-only transaction; T-632's matcher;
// S1-02's and S1-03's writers through T-1461's walk; the commit's request (build.ts) and K-05's commitTurn on the runtime
// side as rosie_job (commit/pg pgCommitTurn), with K-24's and K-37's tables, constraints, row-level security and grants as
// migrated. Doubles, because their tasks bind them: the walk's bundle port over bundle v1's flow A and its question read
// (T-1461's), S1-11's stand-in writer (T-634's), the stop home's reads and T-319's paging reader (the frozen seeds'
// worlds: card F and T-1444 bind the runtime's).
//
// Proven: the rows the one commit writes from S1-02's writer land in K-24's business kinds (picked_kinds), as written; the
// next answer numbers its picks after item 79's, read as rosie_job; "One isn't on the list yet" lands its drafted kind,
// its new_work pick, the draft in review and one team review item in one commit; item 79 never runs as rosie_app.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { kindsPlanOf, openTradeSet, verifyTradeSet } from "../../../../../db/seeds/kinds";
import { openFixtureSet, verifyFixtureSet } from "../../../../../db/seeds/lib/fixture-set";
import { buildCommitRequest } from "../../../commit/build";
import type { CommitTurnContext, UnitWrites } from "../../../commit";
import { pgCommitTurn } from "../../../commit/pg";
import { openCommitDatabase, seed, type CommitDatabase } from "../../../commit/pg/test-support";
import { createWritesOf, type StepRows, type StepWriter } from "../../../commit/walk";
import {
  NOTHING_OPEN,
  bundleV1Bundles,
  bundleV1Id,
  decidedOf,
  questionsOver,
  s1_11Writer,
  writersOf,
  type WalkTestRepo,
} from "../../../commit/walk/test-support";
import { seededKinds } from "../../../domain/kind-matcher/test-support";
import { pagingWorld, readerOn } from "../../../domain/paging/test-support";
import { readsOn, seedWorld } from "../../../homes/stop/test-support";
import { kindsReadsOf, kindsWriters, pgKindsK05Reads, pgKindsReads, type KindsReads } from "./index";
import { PACK_HIKES, turnWithWords } from "./test-support";

/** Connections per application client: the catalog read and item 79 each take one of their own. */
const POOL = 4;

const SLOW = { timeout: 120_000 };

let cdb: CommitDatabase;

beforeAll(async () => {
  cdb = await openCommitDatabase("j1_kinds", POOL);
  await seed(cdb, ["seed-bundle-registry.json", "seed-person-roles.json"]);
  const { sql } = cdb.db;
  // Bundle v1's registry row, from its manifest (bundles/v1, T-1460): turn 2's row is pinned to it.
  const { hash, build } = bundleV1Id();
  await sql`
    insert into bundles (hash, build, manifest_key, built_at)
    values (${hash}, ${build}, ${`bundle/${hash}/${String(build)}/manifest`}, ${"2026-11-18T10:26:00Z"})
  `;
  // The 243 trade-file kinds the kinds seed writes, planned from fixture set v1 (T-212's kindsPlanOf).
  const plan = kindsPlanOf(verifyFixtureSet(openFixtureSet()), verifyTradeSet(openTradeSet()));
  await sql.begin(async (tx) => {
    for (const row of plan.rows.kinds) {
      await tx`
        insert into kinds (id, name, style, pattern, facts, source)
        values (${row.id}, ${row.name}, ${row.style}, ${row.pattern}, ${[...row.facts]}, ${row.source})
      `;
    }
  });
}, 180_000);

afterAll(async () => {
  await cdb.close();
});

/** The writers on PostgreSQL's reads (item 78 as rosie_app, item 79 as rosie_job), the other ports the seeds' doubles. */
function writersOn(reads: KindsReads, rows: Map<string, StepRows>): Record<string, StepWriter<WalkTestRepo>> {
  const writers = kindsWriters<WalkTestRepo>({
    reads,
    stop: readsOn(seedWorld(), null),
    paging: { reader: () => readerOn(pagingWorld()) },
  });
  const kept = (stepId: string, writer: StepWriter<WalkTestRepo>): StepWriter<WalkTestRepo> => {
    return async (call) => {
      const got = await writer(call);
      rows.set(stepId, got);
      return got;
    };
  };
  return {
    "S1-02": kept("S1-02", writers["S1-02"]),
    "S1-03": kept("S1-03", writers["S1-03"]),
    "S1-74": kept("S1-74", writers["S1-74"]),
    "S1-11": s1_11Writer,
  };
}

/** Turn 2 choosing `choiceId` with `words`, its turn row's id `turnId`, walked on bundle v1 with the writers on `reads`. */
async function walked(choiceId: string, words: string | undefined, turnId: string, turnKey: string) {
  const turn = turnWithWords(choiceId, words);
  const context: CommitTurnContext<WalkTestRepo> = {
    ...turn.context,
    turn: { ...turn.context.turn, id: turnId },
  };
  const rows = new Map<string, StepRows>();
  const writesOf = createWritesOf<WalkTestRepo>({
    bundles: bundleV1Bundles().bundles,
    turnKey: () => turnKey,
    questions: questionsOver().questions,
    writers: writersOf(writersOn(pgKindsReads(cdb.toolApi, cdb.runtime), rows)).writers,
  });
  await writesOf(turn.part, context, NOTHING_OPEN);
  return { context, rows };
}

/** One unit holding the rows of the steps named, as the walk wrote them, with S1-02's choice as its why. */
function unitOf(rows: Map<string, StepRows>, steps: readonly string[], choice: string): UnitWrites {
  const kept = steps.map((stepId) => {
    const got = rows.get(stepId);
    if (got === undefined) throw new Error(`the walk wrote ${stepId}`);
    return got;
  });
  return {
    why: { step: "S1-02", choice },
    versionsRead: [],
    state: kept.flatMap((each) => each.state),
    stateEvents: kept.flatMap((each) => each.stateEvents),
    asks: [],
    closes: [],
    clockCancels: [],
    messages: kept.flatMap((each) => each.messages),
    reservations: { confirm: [], release: [] },
    effects: { write: [], letGo: [] },
    gives: kept.flatMap((each) => each.gives),
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
  return pgCommitTurn<WalkTestRepo>(cdb.runtime, { now: () => new Date(context.request.now) })(request);
}

/** Sam's picks as the owner reads them back, in the order named. */
async function samsPicks(): Promise<Record<string, unknown>[]> {
  return cdb.db.sql<Record<string, unknown>[]>`
    select id, owner_person_id, position, words, outcome, kind_id, company_id, business_id,
           to_char(picked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as picked_at, version
    from picked_kinds
    where owner_person_id = 'person-sam'
    order by position
  `;
}

describe("item 78 and item 79 through this folder's binding, each as its own role", () => {
  it(
    "item 78 on the rosie_app client answers the 243 seeded kinds, field by field, in id order",
    SLOW,
    async () => {
      const catalog = await pgKindsReads(cdb.toolApi, cdb.runtime).catalog();
      // K-24's ids are lower-case letters, digits and hyphens (kinds_id_form), so code-unit order is their byte order.
      const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
      expect(catalog).toEqual([...seededKinds()].sort((a, b) => byId(a.id, b.id)));
      expect(catalog).toHaveLength(243);
    },
  );

  it(
    "item 79 runs on the runtime client: as rosie_app db/repo refuses it before any table is read",
    SLOW,
    async () => {
      const asApp = kindsReadsOf(pgKindsK05Reads(cdb.toolApi, cdb.toolApi));
      await expect(
        asApp.pickedKinds({ businessId: "biz-lees-barbershop", personId: "person-sam" }),
      ).rejects.toThrow(/rosie_job/u);
      const asJob = await pgKindsReads(cdb.toolApi, cdb.runtime).pickedKinds({
        businessId: "biz-lees-barbershop",
        personId: "person-sam",
      });
      expect(asJob).toMatchObject({
        result: "pickedKinds",
        businessId: "biz-lees-barbershop",
        personId: "person-sam",
      });
    },
  );
});

describe("the rows the one commit writes from S1-02's writer land in K-24's business kinds", () => {
  it(
    "commit-s1-02.json's 'All on the list': three picked_kinds rows, as written, version 1, no business yet",
    SLOW,
    async () => {
      const { context, rows } = await walked("c-01", undefined, "turn-s1-02-sam-kinds", "sam");
      const writes = unitOf(rows, ["S1-02"], "All on the list");
      expect(writes.gives).toEqual(["kinds"]);
      const answer = await committed(context, writes);
      expect(answer).toMatchObject({ result: "committed", turnId: "turn-s1-02-sam-kinds", repeated: false });
      if (!("committed" in answer)) throw new Error("the commit wrote");
      expect(answer.committed.written).toEqual([
        { table: "picked_kinds", rowId: "pick-s1-02-sam-1", version: 1 },
        { table: "picked_kinds", rowId: "pick-s1-02-sam-2", version: 1 },
        { table: "picked_kinds", rowId: "pick-s1-02-sam-3", version: 1 },
      ]);
      expect(await samsPicks()).toEqual(
        [
          ["Barbershop", "barber"],
          ["plumbing", "plumber"],
          ["electrical", "electrician"],
        ].map(([words, kindId], index) => ({
          id: `pick-s1-02-sam-${String(index + 1)}`,
          owner_person_id: "person-sam",
          position: index + 1,
          words,
          outcome: "listed",
          kind_id: kindId,
          company_id: null,
          business_id: null,
          picked_at: context.request.now,
          version: 1,
        })),
      );
      // Those rows as item 79 answers them now, read as rosie_job: the person's picks with no business.
      const onFile = await pgKindsReads(cdb.toolApi, cdb.runtime).pickedKinds({
        businessId: "biz-lees-barbershop",
        personId: "person-sam",
      });
      expect(onFile.picks.map((pick) => [pick.id, pick.position, pick.kindId, pick.businessId])).toEqual([
        ["pick-s1-02-sam-1", 1, "barber", null],
        ["pick-s1-02-sam-2", 2, "plumber", null],
        ["pick-s1-02-sam-3", 3, "electrician", null],
      ]);
    },
  );

  it(
    "the next answer numbers its picks after item 79's, and never picks a kind already picked",
    SLOW,
    async () => {
      const { rows } = await walked("c-01", "Barbershop, massage", "turn-s1-02-sam-again", "sam-again");
      const s1_02 = rows.get("S1-02");
      expect(
        s1_02?.state.map((write) =>
          write.op === "insert" ? [write.table, write.values.position, write.values.kind_id] : null,
        ),
      ).toEqual([["picked_kinds", 4, "massage"]]);
    },
  );

  it(
    "'One isn't on the list yet' lands its drafted kind, its new_work pick, the draft in review and one review item in one commit",
    SLOW,
    async () => {
      const { context, rows } = await walked("c-02", PACK_HIKES, "turn-s1-02-sam-new-work", "sam-new-work");
      const writes = unitOf(rows, ["S1-02", "S1-03"], "One isn't on the list yet");
      const answer = await committed(context, writes);
      expect(answer).toMatchObject({
        result: "committed",
        turnId: "turn-s1-02-sam-new-work",
        repeated: false,
      });
      if (!("committed" in answer)) throw new Error("the commit wrote");
      const [kindRow, pick, draft, item] = answer.committed.written;
      expect(kindRow).toMatchObject({ table: "kinds", version: 1 });
      expect(pick).toEqual({ table: "picked_kinds", rowId: "pick-s1-02-sam-new-work-1", version: 1 });
      expect(draft).toEqual({ table: "new_work_drafts", rowId: "draft-s1-03-sam-new-work-1", version: 1 });
      expect(item).toMatchObject({ table: "review_items", version: 1 });
      expect(answer.committed.written).toHaveLength(4);
      expect(answer.committed.outboxRows.map((row) => row.id)).toEqual(["outbox-s1-03-sam-new-work-1"]);
      const { sql } = cdb.db;
      const [drafted] = await sql<Record<string, unknown>[]>`
      select k.id, k.name, k.style, k.pattern, k.facts, k.source, p.position, p.outcome, p.business_id
      from picked_kinds p join kinds k on k.id = p.kind_id
      where p.id = 'pick-s1-02-sam-new-work-1'
    `;
      expect(drafted).toEqual({
        id: kindRow?.rowId,
        name: PACK_HIKES,
        style: null,
        pattern: "service",
        facts: null,
        source: "new_work",
        position: 4,
        outcome: "new_work",
        business_id: null,
      });
      const [review] = await sql<Record<string, unknown>[]>`
      select r.kind, r.business_id, r.subject_table, r.subject_row_id, r.state, d.state as draft_state, d.business_id as draft_business
      from review_items r join new_work_drafts d on d.id = r.subject_row_id
      where r.id = ${String(item?.rowId)}
    `;
      expect(review).toEqual({
        kind: "new_work",
        business_id: null,
        subject_table: "new_work_drafts",
        subject_row_id: "draft-s1-03-sam-new-work-1",
        state: "open",
        draft_state: "in_review",
        draft_business: null,
      });
      // Nothing here moves the business: its row is as seeded (S1-03's safe default keeps the drafted kind offline, and
      // the go-live check, S1-35, is not this card's).
      const [business] = await sql<{ status: string; version: number }[]>`
      select status, version from businesses where id = 'biz-lees-barbershop'
    `;
      expect(business).toEqual({ status: "live", version: 3 });
    },
  );
});
