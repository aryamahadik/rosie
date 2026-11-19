// T-1463: readSignUpFactsIn (sign-up-reads.ts), limit 1's default 14 read of a sign-up's link and control (T-1459;
// DL-961, DL-964), and migration 0038's person_handles_linked, against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/repo/sign-up-reads`). The schema comes from migrating a fresh test schema, dropped when
// the file ends.
//
// Under rosie_app, T-1459's read of these facts (K-05 v1.2's readTurnState) failed with 42501 at its first table,
// handles, which 0012 grants rosie_job alone, as it does person_handles and persons. 0038's person_handles_linked answers
// whether a person writes from a handle, only for a handle with a live open question of the caller's own business scope,
// and readSignUpFactsIn reads the link through it for a role that may not select from person_handles; rosie_job reads
// person_handles directly. Proved here, each read through a client whose connections run as the role named, with this
// file's schema first, scoped by withBusiness() as a Tool API call is scoped:
//   - as rosie_app under the barbershop's scope: its business_setup row (control proven, version 4) and Alex's link to
//     the handle its live A7-03 went to, exactly what rosie_job reads under the same scope; a waiting question counts as
//     live; a person not linked, and no person asked, answer no link; a business_setup row with control not proven
//     answers its null, and a business with none answers none;
//   - the bound: as rosie_app a handle whose only live question is another business's or has no business, whose
//     question was answered, or that has none answers no link, where rosie_job's direct read answers the link as K-04
//     holds it; under the yoga studio's scope its own question's handle answers the link;
//   - the scope: a transaction with no scope (never set, or ended: ''), or another business's, is refused before any
//     table is read (BusinessScopeError), under both roles; a request of the wrong shape is refused before any statement;
//   - the function called directly: true only for a linked person on a handle with a live question of the caller's
//     scope's business; another business's question handle, a question with no business, an answered one, a handle with
//     none, a person not linked, an id no row has, a null, and any pair with no scope answer false; both roles may run it;
//   - the catalog: rosie_app holds no privilege on handles, person_handles, persons, phones or turns, and reading any is
//     refused (42501); the function is 0038's narrow definer, owned by the tables' owner, run by rosie_app and rosie_job
//     alone (never PUBLIC), reading open_questions and person_handles alone;
//   - the statements: rosie_app's read names person_handles_linked and reads no table that spans businesses; rosie_job's
//     reads person_handles directly and never names the function.
//
// Rows come only from fixture set v1 (rule 9): K-04's seed-open-question.json with its after chain (the shops, the cast
// and their handles, the bundle, Alex's turn and bookings, the barbershop's A7-03 to Alex, open) and K-23's
// seed-business-demo-shop.json's business_setup row (the barbershop's, control proven by the listing's code), loaded as
// the tables' owner, which row-level security does not bind. Made here under new ids, on the same cast and Alex's seeded
// turn: the yoga studio's live question to Alex on his email handle, the barbershop's waiting question to Avery, a live
// question with no business to Riley, the barbershop's answered question to Sam, and the movers' business_setup row with
// every column at its default (control not proven). This file writes no number, address or name, and nothing here logs.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BusinessScopeError, type Sql, type Tx, withBusiness } from "./scope";
import { readSignUpFactsIn, type SignUpFactsRead, type SignUpFactsRequest } from "./sign-up-reads";
import { createTestDatabase, type TestDatabase } from "./test-db";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface SeedFile {
  after: string[];
  rows: { table: string; values: Record<string, Json> }[];
}

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const SETUP_DIR = new URL("db-schema/business-setup/fixtures/", CONTRACTS);
const TOOL_API_ROLE = "rosie_app";
const RUNTIME_ROLE = "rosie_job";
const SLOW = { timeout: 60_000 };

const BARBERSHOP = "biz-lees-barbershop";
const YOGA = "biz-yoga-studio";
const MOVERS = "biz-movers";
const ALEX = "person-alex";
const SAM = "person-sam";
const AVERY = "person-avery";
const RILEY = "person-riley";
const TOMAS = "person-tomas";
/** Alex's phone handle: the barbershop's A7-03 went to it (seed-open-question.json), open. */
const ALEX_PHONE = "handle-alex";
/** Alex's email handle: the yoga studio's question to him, made here, is its one live question. */
const ALEX_EMAIL = "handle-alex-email";
/** Sam's handle: the barbershop's question to him, made here, was answered. */
const SAM_PHONE = "handle-sam";
/** Avery's handle: the barbershop's question to Avery, made here, is waiting. */
const AVERY_PHONE = "handle-avery";
/** Riley's handle: a question with no business, made here, is its one live question. */
const RILEY_PHONE = "handle-riley";
/** Tomás's handle: no question was ever sent to it. */
const TOMAS_PHONE = "handle-tomas";
const NO_SUCH_PERSON = "person-t1463-none";
const NO_SUCH_HANDLE = "handle-t1463-none";
/** The barbershop's business_setup row as K-23's seed-business-demo-shop.json holds it. */
const BARBERSHOP_SETUP = { controlProvenAt: "2026-10-19T18:10:00Z", version: 4 };
/** The function 0038 makes. */
const LINKED = "person_handles_linked";
/** Tables that span businesses, none of which rosie_app may hold (DL-950 note a; the card's catalog check). */
const NEVER_GRANTED = ["handles", "person_handles", "persons", "phones", "turns"];
/** A statement that reads one of those tables. */
const READS_ACROSS = /\b(from|join)\s+(handles|persons|phones|person_handles|turns)\b/u;

/** A scope: a business's (withBusiness), none (null), or one set and then ended within the transaction (''). */
type Scope = string | null;
const ENDED = "";

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

let db: TestDatabase;
/** The jsonb and bytea columns of this file's schema, by `table.column`. */
let typedColumns: Map<string, string>;
/** As rosie_app, the Tool API's role. */
let toolApi: Sql;
/** As rosie_job, the runtime side's role. */
let runtime: Sql;
/** The text of every statement each client sent, in order, never its values. */
const toolApiSent: string[] = [];
const runtimeSent: string[] = [];

/** A client of this file's schema whose connections run as `role`, writing down each statement's text as it sends it. */
function clientAs(role: string, name: string, sent: string[]): Sql {
  return db.connect({
    max: 4,
    onnotice: () => undefined,
    debug: (_connection: number, text: string) => {
      sent.push(text.trim());
    },
    connection: { application_name: name, search_path: `${db.schema}, public`, role },
  });
}

async function insertRow(sql: Db, table: string, row: Record<string, Json>): Promise<void> {
  const values: Record<string, never> = {};
  for (const [column, value] of Object.entries(row)) {
    const type = typedColumns.get(`${table}.${column}`);
    let converted: unknown = value;
    if (type === "jsonb" && value !== null) {
      converted = sql.json(value);
    } else if (type === "bytea" && typeof value === "string") {
      converted = fromHex(value.replace(/^\\x/, ""));
    }
    values[column] = converted as never;
  }
  await sql`insert into ${sql(table)} ${sql(values)}`;
}

/** A seed's rows after those of the seeds its `after` names, each named from its own file's folder; each seed once. */
function seedRows(file: URL, seen: Set<string>): SeedFile["rows"] {
  if (seen.has(file.href)) {
    return [];
  }
  seen.add(file.href);
  const seed = readJson(file) as SeedFile;
  return [...seed.after.flatMap((before) => seedRows(new URL(before, file), seen)), ...seed.rows];
}

interface Question {
  id: string;
  handle: string;
  person: string;
  business: string | null;
  step: string;
  status: "waiting" | "open" | "answered";
}

/** A question written by Alex's seeded turn, as A7-03's row holds it but for what is named here, about no booking. */
async function ask(tx: Db, question: Question): Promise<void> {
  const closedAt = question.status === "answered" ? "2026-10-23T14:20:00Z" : null;
  await tx`
    insert into open_questions (id, turn_id, handle_id, person_id, business_id, booking_id, step, options, readback,
                                versions_read, bundle_hash, bundle_build, clock, ask_count, status, closed_at)
    select ${question.id}::text, turn_id, ${question.handle}::text, ${question.person}::text,
           ${question.business}::text, null, ${question.step}::text, '[]'::jsonb, null, '[]'::jsonb, bundle_hash,
           bundle_build, null, 1, ${question.status}::text, ${closedAt}::timestamptz
    from open_questions where id = 'oq-a7-03-alex'
  `;
}

/** What each case below reads, made under new ids on K-04's seeded cast. */
async function madeHere(tx: Db): Promise<void> {
  await ask(tx, {
    id: "oq-t1463-yoga-alex-email",
    handle: ALEX_EMAIL,
    person: ALEX,
    business: YOGA,
    step: "A7-05",
    status: "open",
  });
  await ask(tx, {
    id: "oq-t1463-a7-05-avery",
    handle: AVERY_PHONE,
    person: AVERY,
    business: BARBERSHOP,
    step: "A7-05",
    status: "waiting",
  });
  await ask(tx, {
    id: "oq-t1463-signup-riley",
    handle: RILEY_PHONE,
    person: RILEY,
    business: null,
    step: "S1-02",
    status: "open",
  });
  await ask(tx, {
    id: "oq-t1463-answered-sam",
    handle: SAM_PHONE,
    person: SAM,
    business: BARBERSHOP,
    step: "S1-02",
    status: "answered",
  });
  await insertRow(tx, "business_setup", { business_id: MOVERS });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "sign_up_reads" });
  toolApi = clientAs(TOOL_API_ROLE, "rosie-t1463-tool-api", toolApiSent);
  runtime = clientAs(RUNTIME_ROLE, "rosie-t1463-runtime", runtimeSent);
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
  const seen = new Set<string>();
  const core = seedRows(new URL("seed-open-question.json", CORE_DIR), seen);
  // Of K-23's seed, its business_setup row alone (its after chain is core's, loaded above).
  const setup = seedRows(new URL("seed-business-demo-shop.json", SETUP_DIR), seen).filter(
    (row) => row.table === "business_setup",
  );
  await db.sql.begin(async (tx) => {
    for (const row of [...core, ...setup]) {
      await insertRow(tx, row.table, row.values);
    }
    await madeHere(tx);
  });
}, 120_000);

afterAll(async () => {
  await Promise.all([toolApi.end({ timeout: 5 }), runtime.end({ timeout: 5 })]);
  await db.drop();
});

/** `read` in one transaction of `sql`'s role under `scope`. */
async function inScope<T>(sql: Sql, scope: Scope, read: (tx: Tx) => Promise<T>): Promise<T> {
  if (scope !== null && scope !== ENDED) {
    return withBusiness(sql, scope, read);
  }
  const answer = await sql.begin(async (tx) => {
    if (scope === ENDED) {
      // The '' a scope that ended leaves on its connection (scope.ts readBusinessScope).
      await tx`select set_config('rosie.business_id', '', true)`;
    }
    return { value: await read(tx) };
  });
  return answer.value;
}

/** readSignUpFactsIn in one transaction of `sql`'s role under `scope`. */
const factsOf = (sql: Sql, scope: Scope, request: SignUpFactsRequest): Promise<SignUpFactsRead> =>
  inScope(sql, scope, (tx) => readSignUpFactsIn(tx, request));

/** 0038's function called directly, in one transaction of `sql`'s role under `scope`. */
const linkedOf = (sql: Sql, scope: Scope, personId: string, handleId: string): Promise<boolean | undefined> =>
  inScope(sql, scope, async (tx) => {
    const [row] = await tx<
      { linked: boolean }[]
    >`select person_handles_linked(${personId}, ${handleId}) as linked`;
    return row?.linked;
  });

describe("T-1463: default 14's link and control as the Tool API's role, through 0038's person_handles_linked", () => {
  it("the clients run as rosie_app and rosie_job, this file's schema first, with no business scope", async () => {
    for (const [sql, role] of [
      [toolApi, TOOL_API_ROLE],
      [runtime, RUNTIME_ROLE],
    ] as const) {
      const [row] = await sql<{ who: string; path: string; scope: string | null }[]>`
        select current_user as who, current_setting('search_path') as path,
               current_setting('rosie.business_id', true) as scope
      `;
      expect(row?.who).toBe(role);
      expect(row?.path).toBe(`${db.schema}, public`);
      expect(row?.scope ?? "").toBe("");
    }
  });

  it(
    "as rosie_app under the barbershop's scope: its business_setup row and Alex's link to the handle its live question went to, exactly rosie_job's answer under the same scope; a waiting question counts; a person not linked and no person asked answer no link; a row with control not proven answers its null, a business with none answers none",
    SLOW,
    async () => {
      for (const [handleId, personId, linked] of [
        [ALEX_PHONE, ALEX, true],
        // Avery's question is waiting: live, as liveOpenQuestionsOfHandle reads live.
        [AVERY_PHONE, AVERY, true],
        // Sam writes from his own handle, not Alex's.
        [ALEX_PHONE, SAM, false],
        [ALEX_PHONE, NO_SUCH_PERSON, false],
        [ALEX_PHONE, null, false],
      ] as const) {
        const request = { businessId: BARBERSHOP, handleId, personId };
        const app = await factsOf(toolApi, BARBERSHOP, request);
        expect(app, `${handleId} ${String(personId)}`).toEqual({ setup: BARBERSHOP_SETUP, linked });
        expect(await factsOf(runtime, BARBERSHOP, request), `${handleId} ${String(personId)}`).toEqual(app);
      }
      // The yoga studio has no business_setup row; the handle its own question went to answers the link.
      const yoga = { businessId: YOGA, handleId: ALEX_EMAIL, personId: ALEX };
      expect(await factsOf(toolApi, YOGA, yoga)).toEqual({ setup: null, linked: true });
      expect(await factsOf(runtime, YOGA, yoga)).toEqual({ setup: null, linked: true });
      // The movers' row, made with every default: control not proven, version 1.
      const movers = { businessId: MOVERS, handleId: TOMAS_PHONE, personId: null };
      const notProven = { setup: { controlProvenAt: null, version: 1 }, linked: false };
      expect(await factsOf(toolApi, MOVERS, movers)).toEqual(notProven);
      expect(await factsOf(runtime, MOVERS, movers)).toEqual(notProven);
    },
  );

  it(
    "the bound: as rosie_app a handle whose only live question is another business's or has no business, whose question was answered, or that has none answers no link, where rosie_job's direct read answers the link as K-04 holds it",
    SLOW,
    async () => {
      for (const [scope, handleId, personId] of [
        // The yoga studio's question is the only live one on Alex's email handle.
        [BARBERSHOP, ALEX_EMAIL, ALEX],
        // Under the yoga studio's scope, the barbershop's A7-03 is no question of its own.
        [YOGA, ALEX_PHONE, ALEX],
        // Riley's only live question has no business.
        [BARBERSHOP, RILEY_PHONE, RILEY],
        // The barbershop's question to Sam was answered.
        [BARBERSHOP, SAM_PHONE, SAM],
        // No question was ever sent to Tomás's handle.
        [MOVERS, TOMAS_PHONE, TOMAS],
      ] as const) {
        const request = { businessId: scope, handleId, personId };
        expect((await factsOf(toolApi, scope, request)).linked, `${scope} ${handleId}`).toBe(false);
        expect((await factsOf(runtime, scope, request)).linked, `${scope} ${handleId}`).toBe(true);
      }
    },
  );

  it(
    "the scope: with no scope, never set or ended (''), or under another business's scope, the read is refused (BusinessScopeError) before any table is read, under both roles; a request of the wrong shape is refused before any statement",
    SLOW,
    async () => {
      const request = { businessId: BARBERSHOP, handleId: ALEX_PHONE, personId: ALEX };
      for (const [sql, sent] of [
        [toolApi, toolApiSent],
        [runtime, runtimeSent],
      ] as const) {
        for (const scope of [null, ENDED, YOGA]) {
          sent.length = 0;
          await expect(factsOf(sql, scope, request), String(scope)).rejects.toBeInstanceOf(
            BusinessScopeError,
          );
          for (const text of sent) {
            expect(text, String(scope)).not.toMatch(/has_table_privilege|business_setup|person_handles/u);
          }
        }
      }
      for (const bad of [
        { ...request, businessId: "" },
        { ...request, handleId: "" },
        { ...request, personId: "" },
        { businessId: BARBERSHOP, handleId: ALEX_PHONE },
        { ...request, bookingIds: [] },
      ]) {
        runtimeSent.length = 0;
        await expect(
          readSignUpFactsIn(runtime, bad as unknown as SignUpFactsRequest),
          JSON.stringify(bad),
        ).rejects.toBeInstanceOf(TypeError);
        expect(runtimeSent).toEqual([]);
      }
    },
  );

  it(
    "the function called directly answers true only for a linked person on a handle with a live question of the caller's scope's business; another business's question handle, a question with no business, an answered one, a handle with none, a person not linked, an id no row has, a null, and any pair with no scope answer false; both roles may run it",
    SLOW,
    async () => {
      for (const sql of [toolApi, runtime]) {
        expect(await linkedOf(sql, BARBERSHOP, ALEX, ALEX_PHONE)).toBe(true);
        expect(await linkedOf(sql, BARBERSHOP, AVERY, AVERY_PHONE)).toBe(true);
        expect(await linkedOf(sql, YOGA, ALEX, ALEX_EMAIL)).toBe(true);
        for (const [scope, personId, handleId] of [
          // Linked, but the handle's only live question is another business's: never answered for the caller.
          [BARBERSHOP, ALEX, ALEX_EMAIL],
          [YOGA, ALEX, ALEX_PHONE],
          [BARBERSHOP, RILEY, RILEY_PHONE],
          [BARBERSHOP, SAM, SAM_PHONE],
          [MOVERS, TOMAS, TOMAS_PHONE],
          // A live question of the scope's business on the handle, but a person who does not write from it.
          [BARBERSHOP, SAM, ALEX_PHONE],
          [BARBERSHOP, NO_SUCH_PERSON, ALEX_PHONE],
          [BARBERSHOP, ALEX, NO_SUCH_HANDLE],
          // With no scope, never set or ended, nothing.
          [null, ALEX, ALEX_PHONE],
          [ENDED, ALEX, ALEX_PHONE],
          [null, ALEX, ALEX_EMAIL],
          [ENDED, RILEY, RILEY_PHONE],
        ] as const) {
          expect(
            await linkedOf(sql, scope, personId, handleId),
            `${String(scope)} ${personId} ${handleId}`,
          ).toBe(false);
        }
        const nulls = await inScope(sql, BARBERSHOP, async (tx) => {
          const [row] = await tx<{ person: boolean; handle: boolean }[]>`
            select person_handles_linked(null, ${ALEX_PHONE}) as person,
                   person_handles_linked(${ALEX}, null) as handle
          `;
          return row;
        });
        expect(nulls).toEqual({ person: false, handle: false });
      }
    },
  );

  it("the grants: rosie_app holds no privilege on handles, person_handles, persons, phones or turns, and reading any is refused (42501)", async () => {
    const held = await db.sql<{ table: string; whole: boolean; columns: boolean }[]>`
      select t.name as table,
             has_table_privilege(${TOOL_API_ROLE}, ${db.schema} || '.' || t.name,
                                 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as whole,
             has_any_column_privilege(${TOOL_API_ROLE}, ${db.schema} || '.' || t.name,
                                      'SELECT, INSERT, UPDATE, REFERENCES') as columns
      from unnest(${NEVER_GRANTED}::text[]) as t(name)
      order by t.name
    `;
    expect([...held]).toEqual(NEVER_GRANTED.map((table) => ({ table, whole: false, columns: false })));
    for (const table of NEVER_GRANTED) {
      await expect(
        inScope(toolApi, BARBERSHOP, (tx) => tx`select count(*) from ${tx(table)}`),
        table,
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("the function is 0038's: security definer, stable, bound when made, search_path pinned, owned by the tables' owner, run by rosie_app and rosie_job alone (never PUBLIC), reading open_questions and person_handles alone", async () => {
    const [made] = await db.sql<
      {
        definer: boolean;
        volatility: string;
        config: string[];
        bound: boolean;
        tablesOwner: boolean;
        args: string;
        result: string;
      }[]
    >`
      select p.prosecdef as definer, p.provolatile as volatility, p.proconfig as config,
             p.prosqlbody is not null as bound, p.proowner = c.relowner as "tablesOwner",
             pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as result
      from pg_proc p
        join pg_class c on c.oid = ${`${db.schema}.person_handles`}::regclass
      where p.pronamespace = ${db.schema}::regnamespace and p.proname = ${LINKED}
    `;
    expect(made).toEqual({
      definer: true,
      volatility: "s",
      config: ["search_path=pg_catalog, pg_temp"],
      bound: true,
      tablesOwner: true,
      args: "person_wanted text, handle_wanted text",
      result: "boolean",
    });
    const runs = await db.sql<{ grantee: string }[]>`
      select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
      from pg_proc p cross join lateral aclexplode(p.proacl) a
      where p.pronamespace = ${db.schema}::regnamespace and p.proname = ${LINKED} and a.privilege_type = 'EXECUTE'
      order by 1
    `;
    const [me] = await db.sql<{ name: string }[]>`select current_user as name`;
    expect(runs.map((row) => row.grantee)).toEqual([me?.name ?? "", TOOL_API_ROLE, RUNTIME_ROLE].sort());
    // What its body reads, as PostgreSQL recorded it when the function was made.
    const reads = await db.sql<{ name: string }[]>`
      select distinct c.relname as name
      from pg_depend d join pg_class c on c.oid = d.refobjid
      where d.classid = 'pg_proc'::regclass and d.refclassid = 'pg_class'::regclass
        and d.objid = ${`${db.schema}.${LINKED}(text, text)`}::regprocedure
      order by 1
    `;
    expect(reads.map((row) => row.name)).toEqual(["open_questions", "person_handles"]);
  });

  it("the statements: rosie_app's read names person_handles_linked and reads no table that spans businesses; rosie_job's reads person_handles directly and never names the function", async () => {
    const request = { businessId: BARBERSHOP, handleId: ALEX_PHONE, personId: ALEX };
    toolApiSent.length = 0;
    runtimeSent.length = 0;
    await factsOf(toolApi, BARBERSHOP, request);
    await factsOf(runtime, BARBERSHOP, request);
    const readOf = (sent: readonly string[]): string =>
      sent.find((text) => text.includes("left join business_setup s")) ?? "";
    expect(readOf(toolApiSent)).toContain(`${LINKED}(`);
    expect(toolApiSent.length).toBeGreaterThan(0);
    for (const text of toolApiSent) {
      expect(text).not.toMatch(READS_ACROSS);
    }
    expect(readOf(runtimeSent)).toContain("from person_handles ph");
    expect(readOf(runtimeSent)).not.toContain(LINKED);
  });
});
