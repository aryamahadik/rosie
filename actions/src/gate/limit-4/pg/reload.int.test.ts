// T-1448: limit 4's reload re-reads the setup rows an open question's versions_read names, within the stored question
// row's bound, on local PostgreSQL (`npm run db:up`, then `npm run test:integration -- actions/src/gate/limit-4`; DL-938;
// T-1436's open question 3 and its security reviewer's note b). The schema comes from migrating a fresh test schema (the
// commit path's pg/test-support.ts openCommitDatabase), dropped when the file ends.
//
// Real here: the shipped limit 4, with its question read (K-05 v1.2's openQuestionRead: db/repo/targets.ts
// liveOpenQuestionsOfHandle, each row with its turn) and its reload (db/repo/send-state.ts currentVersionsOf, handed the
// stored row's bound), PostgreSQL with every migration, and the application roles. That question read joins outbox_parts,
// which rosie_job alone may read (0012), so the whole limit runs as rosie_job: under the barbershop's scope, as
// db/repo/turn-state.int.test.ts reads limit 3's reader, and with no scope, where row-level security shows every
// business's row and the bound alone keeps another business's out. As rosie_app under the barbershop (the Tool API's own
// side) the reload alone is read, with the bound of the row as limit 4 reads it.
//
// Rows come only from fixture set v1's demo shops (rule 9): the contracts' seeds with their after chains, K-04's turn
// seed (the bundle, the shops, the cast and their handles), K-22's sessions with Sam's account and the staging testers'
// (another person's account and session), K-25's price list (K-23's demo shop and K-24's sample kinds behind it), K-24's
// business kinds (K-23's two-kind company) and K-35's licenses. Made here under new ids: a committed turn of Sam's and one
// of Riley's, and S2-22's open question to Sam (K-09 v1 commit-limit-4-changed.json's), its row K-04's
// seed-open-question.json's with the business, the turn and the versions read each case names. Every number is a seed's
// own 555-01xx number: this file writes none, and nothing here logs.

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withBusiness, type Sql, type Tx } from "../../../../../db/repo/scope";
import { SETUP_FACT_HOMES } from "../../../../../db/repo/setup/fact-homes";
import { rowNameSql } from "../../../../../db/repo/setup/row-names";
import {
  RUNTIME_ROLE,
  TOOL_API_ROLE,
  insertRow,
  openCommitDatabase,
  type CommitDatabase,
} from "../../../commit/pg/test-support";
import type { GateTurn } from "../../framework";
import type { RowRef } from "../../limit-3/facts";
import { exchangeRequest, partOf, turnOf } from "../../limit-3/test-support";
import {
  freshYesOutcome,
  limit4,
  saidWhatChangedOutcome,
  setupBoundOf,
  storedQuestionReaderOf,
  todayReaderOf,
  type VersionsDecision,
} from "../index";
import { LIMIT_4_FIXTURE, S2_22 } from "../test-support";

const SLOW = { timeout: 60_000 };
/** Connections per client. */
const POOL = 4;

const BARBERSHOP = "biz-lees-barbershop";
const HOME_SERVICES = "biz-lee-home-services";
/** A committed turn of Sam's handle, which writes S2-22's row unless a case says otherwise. */
const SAM_TURN = { id: "turn-t1448-sam", handleId: "handle-sam" };
/** A committed turn of Riley's handle: the join after which S2-22 asks Sam (K-09 v1 staff-join-ready-text.json). */
const RILEY_TURN = { id: "turn-t1448-riley", handleId: "handle-riley" };

const CONTRACTS = new URL("../../../../../contracts/", import.meta.url);
const DB_SCHEMA = new URL("db-schema/", CONTRACTS);
const SEEDS: readonly URL[] = [
  "core/fixtures/seed-turn.json",
  "people-access/fixtures/seed-session.json",
  "people-access/fixtures/seed-staging-tester.json",
  "services-prices/fixtures/seed-services-price-list.json",
  "kinds-of-work/fixtures/seed-business-kinds.json",
  "documents-licenses/fixtures/seed-license-as-given.json",
].map((path) => new URL(path, DB_SCHEMA));

type Values = Record<string, unknown>;

interface SeedFile {
  readonly after: readonly string[];
  readonly rows: readonly { readonly table: string; readonly values: Values }[];
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));

/** A seed's rows after those of the seeds its `after` names, each path read from the seed's own folder; each seed once. */
function seedRows(seed: URL, seen: Set<string>): SeedFile["rows"] {
  if (seen.has(seed.href)) return [];
  seen.add(seed.href);
  const file = readJson(seed) as SeedFile;
  return [...file.after.flatMap((before) => seedRows(new URL(before, seed), seen)), ...file.rows];
}

/** K-04's open question seed row (A7-03's to Alex), whose columns S2-22's row takes, with its own values over them. */
function questionSeed(): Values {
  const [row] = (readJson(new URL("core/fixtures/seed-open-question.json", DB_SCHEMA)) as SeedFile).rows;
  if (row?.table !== "open_questions") throw new Error("seed-open-question.json changed");
  return row.values;
}

let cdb: CommitDatabase;
/** The jsonb and bytea columns of this file's schema, by `table.column`. */
let typed: Map<string, string>;
/** As rosie_job, this file's schema first: the runtime side's role. */
let runtime: Sql;
/** As rosie_app, this file's schema first: the Tool API's role. */
let toolApi: Sql;
/** Every statement both clients sent, in order: the text alone, never its values. */
const sent: string[] = [];

beforeAll(async () => {
  cdb = await openCommitDatabase("limit_4_reload", POOL);
  const keep = (text: string): void => {
    sent.push(text);
  };
  runtime = cdb.client(RUNTIME_ROLE, "rosie-t1448-runtime", POOL, keep);
  toolApi = cdb.client(TOOL_API_ROLE, "rosie-t1448-tool-api", POOL, keep);
  const columns = await cdb.db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${cdb.db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typed = new Map(columns.map((column) => [column.key, column.type]));
  const seen = new Set<string>();
  const rows = SEEDS.flatMap((seed) => seedRows(seed, seen));
  const asked = questionSeed();
  await cdb.db.sql.begin(async (tx) => {
    for (const row of rows) await insertRow(tx, typed, row.table, row.values);
    for (const turn of [SAM_TURN, RILEY_TURN]) {
      await insertRow(tx, typed, "turns", {
        id: turn.id,
        handle_id: turn.handleId,
        event_ids: [`evt-${turn.id}`],
        state: "committed",
        bundle_hash: asked.bundle_hash,
        bundle_build: asked.bundle_build,
        trace_id: `trace-${turn.id}`,
        committed_at: "2026-10-21T12:50:00Z",
      });
    }
  });
}, 180_000);

afterAll(async () => {
  await Promise.all([runtime.end({ timeout: 5 }), toolApi.end({ timeout: 5 })]);
  await cdb.close();
});

/** A row's version now, as the tables' owner reads it by its name alone; the row must be there. */
async function nowAt(table: string, rowId: string): Promise<RowRef> {
  const { sql } = cdb.db;
  const home = Object.hasOwn(SETUP_FACT_HOMES, table) ? SETUP_FACT_HOMES[table] : undefined;
  const [row] =
    home === undefined
      ? await sql<{ version: number }[]>`select version from ${sql(table)} where id = ${rowId}`
      : await sql<{ version: number }[]>`
          select version from ${sql(table)} where ${rowNameSql(sql, home.key)} = ${rowId}
        `;
  if (row === undefined) throw new Error(`the test names a ${table} row that is not there: ${rowId}`);
  return { table, rowId, version: row.version };
}

/**
 * S2-22's open question to Sam, live on his handle, naming `versionsRead`: the barbershop's, written by Sam's turn and
 * asked once, unless `row` says otherwise. Any earlier row of it goes first.
 */
async function ask(
  versionsRead: readonly RowRef[],
  row: { readonly businessId?: string; readonly turnId?: string } = {},
): Promise<void> {
  const { sql } = cdb.db;
  await sql`delete from open_questions where id = ${S2_22}`;
  await insertRow(sql, typed, "open_questions", {
    ...questionSeed(),
    id: S2_22,
    turn_id: row.turnId ?? SAM_TURN.id,
    handle_id: SAM_TURN.handleId,
    person_id: "person-sam",
    business_id: row.businessId ?? BARBERSHOP,
    booking_id: null,
    step: "S2-22",
    options: [
      { id: "c-01", label: "1 Yes, all of them" },
      { id: "c-02", label: "2 Not yet, or no reply" },
    ],
    readback: null,
    versions_read: versionsRead.map((ref) => ({ table: ref.table, rowId: ref.rowId, version: ref.version })),
    ask_count: 1,
    status: "open",
    version: 1,
  });
}

/** Sam's "1" to S2-22 (K-09 v1 commit-limit-4-changed.json): the request names the barbershop and his answering turn. */
const request = exchangeRequest(LIMIT_4_FIXTURE);

/** The shipped limit 4's decision on Sam's "1", reading through `tx`. */
function decideOn(tx: Tx): Promise<VersionsDecision> {
  const turn: GateTurn = { ...turnOf(request), repo: tx };
  return limit4.decide(partOf(request), turn);
}

/** As rosie_job under the barbershop's scope. */
const underBarbershop = (): Promise<VersionsDecision> => withBusiness(runtime, BARBERSHOP, decideOn);
/** As rosie_job with no scope: row-level security shows every business's row. */
const withNoScope = (): Promise<VersionsDecision> => runtime.begin((tx) => decideOn(tx));

/** The last read of `table` sent: its text alone. */
function readOf(table: string): string {
  const read = [...sent].reverse().find((text) => text.includes(`from "${table}"`));
  if (read === undefined) throw new Error(`no read of ${table} was sent`);
  return read;
}

/** A row shown that no longer answers. */
const gone = (row: RowRef) => ({
  table: row.table,
  rowId: row.rowId,
  readVersion: row.version,
  currentVersion: null,
});

/** No longer possible: a row shown is gone. */
function saidGone(...rows: RowRef[]): VersionsDecision {
  return {
    result: "fail",
    outcome: saidWhatChangedOutcome(),
    next: {
      kind: "saidWhatChanged",
      openQuestionId: S2_22,
      step: "S2-22",
      bookingId: null,
      why: "rowGone",
      changed: rows.map(gone),
    },
  };
}

describe("T-1448: limit 4's reload re-reads an open question's setup rows within its stored row's bound (DL-938)", () => {
  it(
    "a question naming a one-column and a two-column setup row passes with each at its version now; each moved version then shows as changed: today's facts and a fresh yes",
    SLOW,
    async () => {
      const shown: RowRef[] = [
        // One column, by its business id; then K-05 v1.18 item 77's "business id/flow".
        await nowAt("business_setup", BARBERSHOP),
        await nowAt("flow_defaults", `${BARBERSHOP}/A`),
        // S2-22's own: Riley's license, by its id; and the shop's barber kind, "company id/kind id".
        await nowAt("documents", "doc-riley-barber-license"),
        await nowAt("company_kinds", "company-lees-barbershop/barber"),
        // The shared catalog, one column and two ("kind id/flow").
        await nowAt("kinds", "barber"),
        await nowAt("kind_flows", "barber/A"),
      ];
      await ask(shown);
      sent.length = 0;
      expect(await underBarbershop()).toEqual({ result: "pass", compareAndSet: shown });

      // Each read names the stored row's business beside the row's name (built whole from its own columns for two); the
      // catalog's names none.
      expect(readOf("business_setup")).toMatch(/where "business_id" = \$1\s+and "business_id" = \$2/);
      expect(readOf("flow_defaults")).toMatch(
        /where \("business_id"::text \|\| '\/' \|\| "flow"::text\) = \$1\s+and "business_id" = \$2/,
      );
      expect(readOf("documents")).toMatch(/where "id" = \$1\s+and "business_id" = \$2/);
      expect(readOf("company_kinds")).toMatch(
        /where \("company_id"::text \|\| '\/' \|\| "kind_id"::text\) = \$1\s+and "business_id" = \$2/,
      );
      expect(readOf("kind_flows")).toMatch(/where \("kind_id"::text \|\| '\/' \|\| "flow"::text\) = \$1\s*$/);

      // Each row moves on, as a commit moves it.
      await cdb.db.sql.begin(async (tx) => {
        await tx`update business_setup set version = version + 1 where business_id = ${BARBERSHOP}`;
        await tx`update flow_defaults set version = version + 1 where business_id = ${BARBERSHOP} and flow = 'A'`;
        await tx`update documents set version = version + 1 where id = 'doc-riley-barber-license'`;
        await tx`
          update company_kinds set version = version + 1
          where company_id = 'company-lees-barbershop' and kind_id = 'barber'
        `;
        await tx`update kinds set version = version + 1 where id = 'barber'`;
        await tx`update kind_flows set version = version + 1 where kind_id = 'barber' and flow = 'A'`;
      });
      const moved = shown.map((row) => ({ ...row, version: row.version + 1 }));
      expect(await underBarbershop()).toEqual({
        result: "fail",
        outcome: freshYesOutcome(),
        next: {
          kind: "freshYes",
          openQuestionId: S2_22,
          step: "S2-22",
          bookingId: null,
          askCount: 2,
          changed: shown.map((row) => ({
            table: row.table,
            rowId: row.rowId,
            readVersion: row.version,
            currentVersion: row.version + 1,
          })),
          versionsToday: moved,
        },
      });
      // Asked again from today's versions, it passes.
      await ask(moved);
      expect(await underBarbershop()).toEqual({ result: "pass", compareAndSet: moved });
    },
  );

  it(
    "another business's row reads as gone, no longer possible: under the barbershop's scope, and with no scope, where only the bound keeps it out; a row stored for that business reads its rows instead, whatever business the request names",
    SLOW,
    async () => {
      const shop = await nowAt("business_setup", BARBERSHOP);
      // Lee Home Services' plumbing kind ("company id/kind id") and its company, one column.
      const plumbing = await nowAt("company_kinds", "company-lee-home-services/plumber");
      const company = await nowAt("companies", "company-lee-home-services");
      await ask([shop, plumbing, company]);
      expect(await underBarbershop()).toEqual(saidGone(plumbing, company));
      sent.length = 0;
      expect(await withNoScope()).toEqual(saidGone(plumbing, company));
      expect(readOf("companies")).toMatch(/where "id" = \$1\s+and "business_id" = \$2/);

      // The same names in a row stored for Lee Home Services: its rows answer and the barbershop's reads as gone, while
      // the request still names the barbershop.
      await ask([shop, plumbing, company], { businessId: HOME_SERVICES });
      expect(request.caller.businessId).toBe(BARBERSHOP);
      expect(await withNoScope()).toEqual(saidGone(shop));
    },
  );

  it(
    "a person's row answers only for the people of the turn that wrote the question, never the request's turn or the question's own handle",
    SLOW,
    async () => {
      const account = await nowAt("accounts", "person-sam");
      const session = await nowAt("sessions", "session-sam-oct26");
      const another = await nowAt("accounts", "person-tester-one");
      await ask([account, session, another]);
      sent.length = 0;
      expect(await underBarbershop()).toEqual(saidGone(another));
      expect(readOf("sessions")).toMatch(
        /where "id" = \$1\s+and person_id in \(\s*select ph\.person_id from turns t join person_handles ph on ph\.handle_id = t\.handle_id where t\.id = \$2\s*\)/,
      );
      await ask([account, session]);
      expect(await underBarbershop()).toEqual({ result: "pass", compareAndSet: [account, session] });

      // The same question to Sam, written by Riley's turn: Sam's rows are none of Riley's handle's people's, though the
      // question is live on Sam's handle and Sam's turn answers it.
      await ask([account, session], { turnId: RILEY_TURN.id });
      expect(await underBarbershop()).toEqual(saidGone(account, session));
    },
  );

  it(
    "a question that names no setup row reads its core rows as before: the barbershop's head passes, and with no scope another business's head still answers",
    SLOW,
    async () => {
      const head = await nowAt("businesses", BARBERSHOP);
      const other = await nowAt("businesses", HOME_SERVICES);
      await ask([head]);
      expect(await underBarbershop()).toEqual({ result: "pass", compareAndSet: [head] });
      await ask([head, other]);
      expect(await underBarbershop()).toEqual(saidGone(other));
      expect(await withNoScope()).toEqual({ result: "pass", compareAndSet: [head, other] });
    },
  );

  it(
    "as rosie_app under the barbershop, the reload within the stored row's bound reads the business's setup rows at their versions now and another business's as gone, and a person's row is refused (42501), failing closed",
    SLOW,
    async () => {
      const shop = await nowAt("business_setup", BARBERSHOP);
      const flow = await nowAt("flow_defaults", `${BARBERSHOP}/B`);
      const plumbing = await nowAt("company_kinds", "company-lee-home-services/plumber");
      const session = await nowAt("sessions", "session-sam-oct26");
      await ask([shop, flow, plumbing]);
      const question = await withBusiness(runtime, BARBERSHOP, (tx) =>
        storedQuestionReaderOf(tx).liveQuestion(SAM_TURN.handleId, S2_22),
      );
      if (question === null) throw new Error("S2-22 is not live on Sam's handle");
      expect({ turnId: question.turnId, versionsRead: question.versionsRead }).toEqual({
        turnId: SAM_TURN.id,
        versionsRead: [shop, flow, plumbing],
      });
      const bound = setupBoundOf(question);
      expect(bound).toEqual({ businessId: BARBERSHOP, turnId: SAM_TURN.id });
      expect(
        await withBusiness(toolApi, BARBERSHOP, (tx) =>
          todayReaderOf(tx).currentVersions(question.versionsRead, bound),
        ),
      ).toEqual([shop, flow]);
      // The people a person's row must be of come from turns and person_handles, which rosie_app holds no grant on.
      await expect(
        withBusiness(toolApi, BARBERSHOP, (tx) => todayReaderOf(tx).currentVersions([session], bound)),
      ).rejects.toMatchObject({ code: "42501" });
    },
  );
});
