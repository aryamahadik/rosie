// T-1457: liveOpenQuestionsOfHandle, the open questions' read limits 3 and 4 make (K-05 v1.2's openQuestionRead), as the
// Tool API's role, rosie_app (the gate's real side; staging's HYPERDRIVE_APP), against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/repo/targets`). The schema comes from migrating a fresh test schema, dropped when the
// file ends.
//
// Under rosie_app the read failed with 42501 on outbox_parts, which 0012 grants rosie_job alone (T-1448's open question
// 1). Migration 0037's open_questions_went_out answers one question's sent_at and poll_id, only for a question of the
// caller's own business scope, and liveOpenQuestionsOfHandle reads through it for a role that may not select from
// outbox_parts; rosie_job keeps the join. Proved here, each read through a client whose connections run as the role named,
// with this file's schema first, scoped by withBusiness() as a Tool API call is scoped:
//   - as rosie_app under the barbershop's scope, the barbershop's live questions on Alex's handle answer exactly what
//     rosie_job's read answers under the same scope: one that went out as a poll, one whose decisive part was sent, one
//     with nothing gone; an email copy's part and another business's outbox row that asks the barbershop's question never
//     count; the yoga studio's question and a question with no business on the same handle are not answered;
//   - as rosie_app with no scope (never set, or ended: ''), nothing is answered, while rosie_job's read with no scope (the
//     guard's) lists every business's question with its join as before;
//   - the function called directly answers only a question of the caller's scope: another business's question, one with
//     no business, an id no question has, and any question with no scope answer no row;
//   - the catalog: rosie_app holds no privilege on turns, outbox_parts, person_handles, phones, handles or threads; the
//     function is 0037's narrow definer, run by rosie_app and rosie_job alone, reading three tables alone;
//   - the limits: limit 3's reader (questionReaderOf, also limit 4's question reader on main: createLimit4's default) as
//     rosie_app answers the barbershop's question with when it went out and its poll, as on rosie_job;
//   - the statements: rosie_app's read names the function and never reads outbox_parts or outbox_rows; rosie_job's is the
//     join, unchanged.
//
// Rows come only from fixture set v1 (rule 9): K-04's seed-outbox-row.json with its after chain (the shops, the cast and
// their handles, the bundle, Alex's turn and bookings, A7-03's question to Alex with its outbox row, its two parts and its
// email copy), loaded as the tables' owner, which row-level security does not bind. Made here under new ids, on the same
// cast and Alex's seeded turn: the barbershop's A7-05 and A7-31 to Alex, the yoga studio's question to Alex (its
// customer), a question with no business (S1-02), their outbox rows and parts, a part on A7-03's email copy, and an
// outbox row of the yoga studio's that asks A7-03. This file writes no number, address or name, and nothing here logs.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { questionReaderOf } from "../../actions/src/gate/limit-3/facts";
import { type Sql, type Tx, withBusiness } from "./scope";
import { liveOpenQuestionsOfHandle, type OpenQuestionRead } from "./targets";
import { createTestDatabase, type TestDatabase } from "./test-db";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface SeedFile {
  after: string[];
  rows: { table: string; values: Record<string, Json> }[];
}

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const TOOL_API_ROLE = "rosie_app";
const RUNTIME_ROLE = "rosie_job";
const SLOW = { timeout: 60_000 };

const BARBERSHOP = "biz-lees-barbershop";
const YOGA = "biz-yoga-studio";
const ALEX = "handle-alex";
/** K-04's seeded question to Alex (seed-open-question.json): A7-03, the barbershop's, a poll and its words delivered. */
const A7_03 = "oq-a7-03-alex";
/** The barbershop's, made here: nothing of it has gone (its one part pending). */
const A7_05 = "oq-t1457-a7-05-alex";
/** The barbershop's, made here: its words sent, its poll failed after Linq took it, the poll's options sent as words. */
const A7_31 = "oq-t1457-a7-31-alex";
/** The yoga studio's, made here, on the same handle: its words and poll delivered with no send time recorded. */
const YOGA_QUESTION = "oq-t1457-yoga-alex";
/** A question with no business, made here, on the same handle: its words sent. */
const SIGN_UP = "oq-t1457-signup-alex";
const NO_SUCH_QUESTION = "oq-t1457-none";
/** The function 0037 makes. */
const WENT_OUT = "open_questions_went_out";
/** Tables that span businesses, none of which rosie_app may hold (T-1448's security reviewer, note a). */
const NEVER_GRANTED = ["handles", "outbox_parts", "person_handles", "phones", "threads", "turns"];

/** A scope: a business's (withBusiness), none (null), or one set and then ended within the transaction (''). */
type Scope = string | null;
const ENDED = "";

/** The went-out answer of a question as liveOpenQuestionsOfHandle gives it: id, business, sentAt and pollId. */
const wentOf = (question: OpenQuestionRead): [string, string | null, string | null, string | null] => [
  question.id,
  question.businessId,
  question.sentAt,
  question.pollId,
];

/** One row of the function's answer. */
interface WentOut {
  sent_at: Date | null;
  poll_id: string | null;
}

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

/** A seed's rows after those of the seeds its `after` names; each seed once. */
function seedRows(file: string, seen: Set<string>): SeedFile["rows"] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const seed = readJson(new URL(file, CORE_DIR)) as SeedFile;
  return [...seed.after.flatMap((before) => seedRows(before, seen)), ...seed.rows];
}

/** A question to Alex, written by his seeded turn, as A7-03's row holds it but for what is named here. */
async function askAlex(
  tx: Db,
  id: string,
  business: string | null,
  booking: string | null,
  step: string,
  status: "waiting" | "open",
): Promise<void> {
  await tx`
    insert into open_questions (id, turn_id, handle_id, person_id, business_id, booking_id, step, options, readback,
                                versions_read, bundle_hash, bundle_build, clock, ask_count, status)
    select ${id}::text, turn_id, handle_id, person_id, ${business}::text, ${booking}::text, ${step}::text, '[]'::jsonb,
           null, '[]'::jsonb, bundle_hash, bundle_build, null, 1, ${status}::text
    from open_questions where id = ${A7_03}
  `;
}

/** An outbox row to Alex's handle asking `question`, of `business`, as A7-03's row holds it but for what is named here. */
async function outboxRow(
  tx: Db,
  id: string,
  question: string,
  business: string | null,
  booking: string | null,
): Promise<void> {
  await tx`
    insert into outbox_rows (id, turn_id, recipient_handle_id, recipient_person_id, business_id, booking_id, channel,
                             send_class, versions_read, open_question_id, state, bundle_hash, bundle_build, trace_id)
    select ${id}::text, turn_id, recipient_handle_id, recipient_person_id, ${business}::text, ${booking}::text,
           channel, send_class, versions_read, ${question}::text, 'sending', bundle_hash, bundle_build, trace_id
    from outbox_rows where id = 'out-a7-03-alex'
  `;
}

interface Part {
  row: string;
  partNo: 1 | 2;
  tryNo: number;
  kind: "words" | "poll";
  state: "pending" | "sent" | "delivered" | "failed";
  linq: string | null;
  sentAt?: string;
  deliveredAt?: string;
  failedAt?: string;
}

/** One part of an outbox row under its key (K-04: '<row>/<part>/<try>'). */
async function part(tx: Db, given: Part): Promise<void> {
  const key = `${given.row}/${String(given.partNo)}/${String(given.tryNo)}`;
  await tx`
    insert into outbox_parts (outbox_row_id, part_no, try_no, idempotency_key, kind, linq_message_id, state, sent_at,
                              delivered_at, failed_at)
    values (${given.row}, ${given.partNo}, ${given.tryNo}, ${key}, ${given.kind}, ${given.linq}, ${given.state},
            ${given.sentAt ?? null}, ${given.deliveredAt ?? null}, ${given.failedAt ?? null})
  `;
}

/** What each case below reads, made under new ids on K-04's seeded cast. */
async function madeHere(tx: Db): Promise<void> {
  await askAlex(tx, A7_05, BARBERSHOP, "booking-alex-haircut", "A7-05", "waiting");
  await askAlex(tx, A7_31, BARBERSHOP, "booking-alex-haircut", "A7-31", "open");
  await askAlex(tx, YOGA_QUESTION, YOGA, "booking-alex-workshop", "A7-03", "open");
  await askAlex(tx, SIGN_UP, null, null, "S1-02", "open");

  // A7-05: one part, pending: nothing of it has gone.
  await outboxRow(tx, "out-t1457-a7-05-alex", A7_05, BARBERSHOP, "booking-alex-haircut");
  await part(tx, {
    row: "out-t1457-a7-05-alex",
    partNo: 1,
    tryNo: 1,
    kind: "words",
    state: "pending",
    linq: null,
  });
  // A7-31: its words sent; its poll taken by Linq, then failed (never a send, never its poll); the poll's options then
  // sent as words, the latest send.
  await outboxRow(tx, "out-t1457-a7-31-alex", A7_31, BARBERSHOP, "booking-alex-haircut");
  await part(tx, {
    row: "out-t1457-a7-31-alex",
    partNo: 1,
    tryNo: 1,
    kind: "words",
    state: "sent",
    linq: "linq-msg-t1457-0001",
    sentAt: "2026-10-23T14:30:00Z",
  });
  await part(tx, {
    row: "out-t1457-a7-31-alex",
    partNo: 2,
    tryNo: 1,
    kind: "poll",
    state: "failed",
    linq: "linq-msg-t1457-0002",
    sentAt: "2026-10-23T14:30:05Z",
    failedAt: "2026-10-23T14:30:09Z",
  });
  await part(tx, {
    row: "out-t1457-a7-31-alex",
    partNo: 2,
    tryNo: 2,
    kind: "words",
    state: "sent",
    linq: "linq-msg-t1457-0003",
    sentAt: "2026-10-23T14:30:12Z",
  });
  // A7-03's email copy, to Alex's other handle: its part goes later, and never counts for the question's own handle.
  await part(tx, {
    row: "out-a7-03-alex-email",
    partNo: 1,
    tryNo: 1,
    kind: "poll",
    state: "sent",
    linq: "resend-msg-t1457-0004",
    sentAt: "2026-10-23T14:09:00Z",
  });
  // An outbox row of the yoga studio's that asks the barbershop's A7-03 on its own handle: under one business's scope it
  // is no row of that business, so neither role's scoped read counts it; the guard's join, with no scope, does.
  await outboxRow(tx, "out-t1457-a7-03-yoga", A7_03, YOGA, "booking-alex-workshop");
  await part(tx, {
    row: "out-t1457-a7-03-yoga",
    partNo: 1,
    tryNo: 1,
    kind: "poll",
    state: "sent",
    linq: "linq-msg-t1457-0005",
    sentAt: "2026-10-23T14:10:00Z",
  });
  // The yoga studio's question: its words and its poll delivered, Linq's acceptance never recorded (no send time).
  await outboxRow(tx, "out-t1457-yoga-alex", YOGA_QUESTION, YOGA, "booking-alex-workshop");
  await part(tx, {
    row: "out-t1457-yoga-alex",
    partNo: 1,
    tryNo: 1,
    kind: "words",
    state: "delivered",
    linq: "linq-msg-t1457-0006",
    deliveredAt: "2026-10-23T14:40:00Z",
  });
  await part(tx, {
    row: "out-t1457-yoga-alex",
    partNo: 2,
    tryNo: 1,
    kind: "poll",
    state: "delivered",
    linq: "linq-msg-t1457-0007",
    deliveredAt: "2026-10-23T14:40:06Z",
  });
  // The question with no business: its words sent.
  await outboxRow(tx, "out-t1457-signup-alex", SIGN_UP, null, null);
  await part(tx, {
    row: "out-t1457-signup-alex",
    partNo: 1,
    tryNo: 1,
    kind: "words",
    state: "sent",
    linq: "linq-msg-t1457-0008",
    sentAt: "2026-10-23T14:50:00Z",
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "targets_app" });
  toolApi = clientAs(TOOL_API_ROLE, "rosie-t1457-tool-api", toolApiSent);
  runtime = clientAs(RUNTIME_ROLE, "rosie-t1457-runtime", runtimeSent);
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
  const rows = seedRows("seed-outbox-row.json", new Set());
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
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

/** liveOpenQuestionsOfHandle on Alex's handle. */
const liveOnAlex = (tx: Tx): Promise<OpenQuestionRead[]> => liveOpenQuestionsOfHandle(tx, ALEX);

/** The function called directly for `questionId`. */
const wentOut =
  (questionId: string) =>
  async (tx: Tx): Promise<WentOut[]> => [
    ...(await tx<WentOut[]>`select sent_at, poll_id from open_questions_went_out(${questionId})`),
  ];

describe("T-1457: the open questions' read as the Tool API's role, through 0037's open_questions_went_out", () => {
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
    "as rosie_app under the barbershop's scope: its live questions on Alex's handle, each with when it went out and its poll, exactly rosie_job's answer under the same scope; the yoga studio's and the question with no business are not answered",
    SLOW,
    async () => {
      const app = await inScope(toolApi, BARBERSHOP, liveOnAlex);
      expect(app).toEqual(await inScope(runtime, BARBERSHOP, liveOnAlex));
      expect(app.map(wentOf)).toEqual([
        // A7-03 went out as a poll: its email copy's later part and the yoga studio's row that asks it never count.
        [A7_03, BARBERSHOP, "2026-10-23T14:05:05Z", "linq-msg-demo-0002"],
        [A7_05, BARBERSHOP, null, null],
        // A7-31's latest send is a sent part; its poll failed, so it has no poll.
        [A7_31, BARBERSHOP, "2026-10-23T14:30:12Z", null],
      ]);
      // A7-03 whole, as K-05 v1.2's targets-alex.json gives it to the guard.
      const fixture = readJson(new URL("data-access/fixtures/targets-alex.json", CONTRACTS)) as {
        outcome: { openQuestions: OpenQuestionRead[] };
      };
      expect(app[0]).toEqual(fixture.outcome.openQuestions[0]);

      // Under the yoga studio's scope, its own question alone, the same for both roles: parts delivered with no send time.
      const yoga = await inScope(toolApi, YOGA, liveOnAlex);
      expect(yoga).toEqual(await inScope(runtime, YOGA, liveOnAlex));
      expect(yoga.map(wentOf)).toEqual([
        [YOGA_QUESTION, YOGA, "2026-10-23T14:40:06Z", "linq-msg-t1457-0007"],
      ]);
    },
  );

  it(
    "as rosie_app with no scope, never set or ended (''), nothing is answered; rosie_job's read with no scope, the guard's, still lists every business's question with its join as before",
    SLOW,
    async () => {
      expect(await inScope(toolApi, null, liveOnAlex)).toEqual([]);
      expect(await inScope(toolApi, ENDED, liveOnAlex)).toEqual([]);
      const guard = await inScope(runtime, null, liveOnAlex);
      expect(guard.map(wentOf)).toEqual([
        // With no scope the guard's join counts every business's outbox row asking A7-03 on its handle, as on main.
        [A7_03, BARBERSHOP, "2026-10-23T14:10:00Z", "linq-msg-t1457-0005"],
        [A7_05, BARBERSHOP, null, null],
        [A7_31, BARBERSHOP, "2026-10-23T14:30:12Z", null],
        [SIGN_UP, null, "2026-10-23T14:50:00Z", null],
        [YOGA_QUESTION, YOGA, "2026-10-23T14:40:06Z", "linq-msg-t1457-0007"],
      ]);
    },
  );

  it(
    "the function answers only a question of the caller's scope: another business's, one with no business, an id no question has, one with nothing gone, and any question with no scope answer no row; both roles may run it",
    SLOW,
    async () => {
      for (const sql of [toolApi, runtime]) {
        expect(await inScope(sql, BARBERSHOP, wentOut(A7_03))).toEqual([
          { sent_at: new Date("2026-10-23T14:05:05Z"), poll_id: "linq-msg-demo-0002" },
        ]);
        expect(await inScope(sql, BARBERSHOP, wentOut(A7_31))).toEqual([
          { sent_at: new Date("2026-10-23T14:30:12Z"), poll_id: null },
        ]);
        // The yoga studio's question id handed in under the barbershop's scope: never trusted, nothing answered.
        expect(await inScope(sql, BARBERSHOP, wentOut(YOGA_QUESTION))).toEqual([]);
        expect(await inScope(sql, BARBERSHOP, wentOut(SIGN_UP))).toEqual([]);
        expect(await inScope(sql, BARBERSHOP, wentOut(NO_SUCH_QUESTION))).toEqual([]);
        expect(await inScope(sql, BARBERSHOP, wentOut(A7_05))).toEqual([]);
        // Under the yoga studio's scope: its own question; never the barbershop's A7-03, though its own row asks it.
        expect(await inScope(sql, YOGA, wentOut(YOGA_QUESTION))).toEqual([
          { sent_at: new Date("2026-10-23T14:40:06Z"), poll_id: "linq-msg-t1457-0007" },
        ]);
        expect(await inScope(sql, YOGA, wentOut(A7_03))).toEqual([]);
        // With no scope, never set or ended, nothing: neither A7-03 nor the question with no business.
        for (const scope of [null, ENDED]) {
          expect(await inScope(sql, scope, wentOut(A7_03))).toEqual([]);
          expect(await inScope(sql, scope, wentOut(SIGN_UP))).toEqual([]);
        }
      }
    },
  );

  it("the grants: rosie_app holds no privilege on turns, outbox_parts, person_handles, phones, handles or threads, and reading any is refused (42501)", async () => {
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

  it("the function is 0037's: security definer, stable, bound when made, search_path pinned, owned by the tables' owner, run by rosie_app and rosie_job alone (never PUBLIC), reading open_questions, outbox_rows and outbox_parts alone", async () => {
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
        join pg_class c on c.oid = ${`${db.schema}.open_questions`}::regclass
      where p.pronamespace = ${db.schema}::regnamespace and p.proname = ${WENT_OUT}
    `;
    expect(made).toEqual({
      definer: true,
      volatility: "s",
      config: ["search_path=pg_catalog, pg_temp"],
      bound: true,
      tablesOwner: true,
      args: "question_wanted text",
      result: "TABLE(sent_at timestamp with time zone, poll_id text)",
    });
    const runs = await db.sql<{ grantee: string }[]>`
      select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
      from pg_proc p cross join lateral aclexplode(p.proacl) a
      where p.pronamespace = ${db.schema}::regnamespace and p.proname = ${WENT_OUT} and a.privilege_type = 'EXECUTE'
      order by 1
    `;
    const [me] = await db.sql<{ name: string }[]>`select current_user as name`;
    expect(runs.map((row) => row.grantee)).toEqual([me?.name ?? "", TOOL_API_ROLE, RUNTIME_ROLE].sort());
    // What its body reads, as PostgreSQL recorded it when the function was made.
    const reads = await db.sql<{ name: string }[]>`
      select distinct c.relname as name
      from pg_depend d join pg_class c on c.oid = d.refobjid
      where d.classid = 'pg_proc'::regclass and d.refclassid = 'pg_class'::regclass
        and d.objid = ${`${db.schema}.${WENT_OUT}(text)`}::regprocedure
      order by 1
    `;
    expect(reads.map((row) => row.name)).toEqual(["open_questions", "outbox_parts", "outbox_rows"]);
  });

  it(
    "the limits' question read as rosie_app: limit 3's reader, limit 4's on main too, answers the barbershop's question with when it went out and its poll, as on rosie_job, and another business's question as none",
    SLOW,
    async () => {
      const app = await inScope(toolApi, BARBERSHOP, (tx) => questionReaderOf(tx).liveQuestion(ALEX, A7_03));
      expect(app).toEqual(
        await inScope(runtime, BARBERSHOP, (tx) => questionReaderOf(tx).liveQuestion(ALEX, A7_03)),
      );
      expect(app).toMatchObject({
        openQuestionId: A7_03,
        handleId: ALEX,
        businessId: BARBERSHOP,
        sentAt: "2026-10-23T14:05:05Z",
        pollId: "linq-msg-demo-0002",
      });
      expect(
        await inScope(toolApi, BARBERSHOP, (tx) => questionReaderOf(tx).liveQuestion(ALEX, YOGA_QUESTION)),
      ).toBeNull();
      expect(
        await inScope(toolApi, YOGA, (tx) => questionReaderOf(tx).liveQuestion(ALEX, YOGA_QUESTION)),
      ).toMatchObject({ sentAt: "2026-10-23T14:40:06Z", pollId: "linq-msg-t1457-0007" });
    },
  );

  it("the statements: rosie_app's read names open_questions_went_out and reads neither outbox_parts nor outbox_rows; rosie_job's is the join, unchanged", async () => {
    toolApiSent.length = 0;
    runtimeSent.length = 0;
    await inScope(toolApi, BARBERSHOP, liveOnAlex);
    await inScope(runtime, BARBERSHOP, liveOnAlex);
    const readOf = (sent: readonly string[]): string =>
      sent.find((text) => text.includes("from open_questions q")) ?? "";
    expect(readOf(toolApiSent)).toContain("left join lateral open_questions_went_out(q.id) went on true");
    for (const text of toolApiSent) {
      expect(text).not.toMatch(/\b(from|join)\s+outbox_(parts|rows)\b/u);
    }
    expect(readOf(runtimeSent)).toContain("join outbox_parts p on p.outbox_row_id = r.id");
    expect(readOf(runtimeSent)).not.toContain(WENT_OUT);
  });
});
