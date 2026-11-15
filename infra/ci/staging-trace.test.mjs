// Tests for infra/scripts/staging-trace.sh and infra/scripts/staging-trace.mjs, `npm run staging:trace` (T-1407; D-017's
// walking skeleton; DL-809), run by `node --test "infra/ci/*.test.mjs"`. The script runs in throwaway checkouts
// (release-harness.mjs's releaseRoot, the two files copied in beside lib.sh and db-url.mjs), so no run reads this
// checkout's .dev.vars: a run that needs one gets a made-up one in a checkout of its own. The database is the local test
// database (DATABASE_URL, else the local Docker database): a throwaway schema made, migrated and dropped by
// db/repo/test-db.ts, read through DB_SCHEMA, standing in for staging's public schema. It holds one turn's rows written
// from K-04's fixtures (contracts/db-schema/core/fixtures: seed-turn.json, seed-outbox-row.json, seed-thread-messages.json,
// seed-event-log.json and seed-phone-chat-open.json, with every fixture their `after` names), and a few rows made here in
// their form: a parked turn that joined another text, an email-thread message and a failed part. Planted in them, all
// made up (rule 9): words, a 555-01xx number, an example.com address, a handle id, a chat id, a provider's message ids and
// a sealed value. None of them, nor any part of the URL, may reach the output. The fixtures' readable trace ids become
// made-up UUIDs, the one form a trace id takes on staging. Every other URL here is BAD_DATABASE_URLS' or names a .invalid
// host or port 1 of this machine.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { BAD_DATABASE_URLS, assertNoUrlPart, releaseRoot } from "./release-harness.mjs";
import {
  REPO,
  SCRIPTS,
  cleanEnv,
  copyScript,
  namedIn,
  program as realProgram,
  spies,
  tempDir,
  whereHeld,
} from "./script-harness.mjs";
import { HIDDEN, readOnly } from "../scripts/staging-trace.mjs";

// db/repo imports its neighbours without an extension, as the bundler resolves them: a relative import from a .ts file is
// completed with .ts or /index.ts, as seed-staging.test.mjs does.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const parent = context.parentURL ?? "";
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (!relative || !parent.startsWith("file:") || !parent.endsWith(".ts")) throw error;
      for (const suffix of [".ts", "/index.ts"]) {
        try {
          return nextResolve(`${specifier}${suffix}`, context);
        } catch {
          // not this form: try the next one
        }
      }
      throw error;
    }
  },
});
const { createTestDatabase } = await import(new URL("../../db/repo/test-db.ts", import.meta.url).href);
const { resolvePrimaryUrl } = await import(new URL("../../db/repo/client.ts", import.meta.url).href);

// ---- the rows -------------------------------------------------------------------------------------------------------

const FIXTURES = path.join(REPO, "contracts", "db-schema", "core", "fixtures");
const FIXTURE_FILES = [
  "seed-turn.json",
  "seed-outbox-row.json",
  "seed-thread-messages.json",
  "seed-event-log.json",
  "seed-phone-chat-open.json",
];

// The fixtures' trace ids as made-up UUIDs, and two traces of the turn made here: its own, and the text it joined.
const TRACE_A = "a1f0c2e4-7b3d-4c8e-9a61-d2e4b6f8a1c0"; // trace-alex-0007: turn-alex-move-1, its rows and its events
const TRACE_B = "b2e1f9a2-6d47-4b05-8e1c-a9f7b3d5e6c4"; // trace-alex-0001: turn-alex-first and its row
const TRACE_SWEEP = "c3d7e1f5-0a2b-4c6d-8e9f-a1b3c5d7e9f0"; // trace-sweep-0001: a job's entry, with no turn
const TRACE_JOINED_TURN = "d4c8a2e6-3f1b-4d7a-9c5e-b8f2a6d4c0e1"; // turn-t1407-joined's own
const TRACE_JOINED_TEXT = "e5b9f3d7-2c4a-4e8b-a6d1-c7e3b9f5d1a2"; // the text turn-t1407-joined took in
const TRACE_NONE = "f6a0e4c8-1d5b-4f9c-b7e2-d8f4c0a6e2b3"; // no row

// The canaries, all made up: the number in the fiction range, the address at example.com (RFC 2606).
const NUMBER = "+18605550147";
const ADDRESS = "t1407-canary@example.com";
const WORDS = `t1407 canary words: see you at the red door at noon, call ${NUMBER} or write ${ADDRESS}`;
const SEALED = "t1407 canary sealed value";
const RENAMED = new Map([
  ["trace-alex-0007", TRACE_A],
  ["trace-alex-0001", TRACE_B],
  ["trace-sweep-0001", TRACE_SWEEP],
  ["handle-alex", "handle-t1407-canary"],
  ["handle-alex-email", "handle-t1407-canary-email"],
  ["+15555550101", NUMBER],
  ["alex@example.com", ADDRESS],
  ["linq-chat-demo-alex", "linq-chat-t1407-canary"],
  ["linq-msg-demo-0001", "linq-msg-t1407-canary-1"],
  ["linq-msg-demo-0002", "linq-msg-t1407-canary-2"],
]);
const BUNDLE_HASH = "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037";

/** A value with each of RENAMED's texts swapped, in lists and objects too. */
function renamed(value) {
  if (typeof value === "string") return RENAMED.get(value) ?? value;
  if (Array.isArray(value)) return value.map(renamed);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, renamed(inner)]));
  }
  return value;
}

/** A fixture row's values with the canaries planted: in words, plans, final parts, the log's values and a name. */
function planted(table, values) {
  const out = renamed(values);
  if (table === "messages") out.words = WORDS;
  if (table === "persons" && out.id === "person-alex") out.name = WORDS;
  if (table === "outbox_rows") {
    if (out.plan) out.plan = { ...out.plan, t1407: WORDS };
    if (out.final_parts) out.final_parts = { ...out.final_parts, t1407: WORDS };
  }
  if (table === "event_log") {
    out.new_values = { ...out.new_values, t1407: WORDS };
    out.why = { ...out.why, t1407: WORDS };
    out.approved_by = { t1407: WORDS };
    out.proofs = { t1407: WORDS };
    if (out.sealed_values) out.sealed_values = Buffer.from(SEALED, "utf8");
  }
  return out;
}

/** A fixture's rows after those of the fixtures its `after` names, each fixture once, in order. */
function chainRows(file, loaded, chain = []) {
  if (loaded.has(file)) return [];
  if (chain.includes(file)) throw new Error(`the after chain loops at ${file}`);
  const content = JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8"));
  const first = content.after.flatMap((name) => chainRows(name, loaded, [...chain, file]));
  loaded.add(file);
  return [...first, ...content.rows];
}

// Made here in the fixtures' form: a parked turn on another handle that took in a second text (joined_trace_ids), an
// email copy's message on Alex's email thread (another handle's thread), and a failed part whose error code holds words.
const MADE_HERE = [
  {
    table: "turns",
    values: {
      id: "turn-t1407-joined",
      handle_id: "handle-sam",
      event_ids: ["evt-t1407-0001", "evt-t1407-0002"],
      state: "parked",
      lease_until: null,
      bundle_hash: BUNDLE_HASH,
      bundle_build: 1,
      trace_id: TRACE_JOINED_TURN,
      joined_trace_ids: [TRACE_JOINED_TEXT],
      tries: 2,
      committed_at: null,
      parked_at: "2026-10-24T09:00:00Z",
      version: 3,
    },
  },
  {
    table: "messages",
    values: {
      id: "msg-t1407-email-copy",
      thread_id: "thread-alex-haircut-email",
      business_id: "biz-lees-barbershop",
      booking_id: "booking-alex-haircut",
      direction: "out",
      channel: "email",
      from_role: "rosie",
      to_role: "customer",
      person_id: "person-alex",
      words: WORDS,
      outbox_row_id: "out-a7-03-alex-email",
      sent_at: "2026-10-23T14:05:07Z",
      version: 1,
    },
  },
  {
    table: "outbox_parts",
    values: {
      outbox_row_id: "out-a7-03-alex-email",
      part_no: 1,
      try_no: 1,
      idempotency_key: "out-a7-03-alex-email/1/1",
      attempts: 2,
      kind: "words",
      state: "failed",
      failed_at: "2026-10-23T14:05:08Z",
      error_code: WORDS,
      version: 2,
    },
  },
];

/** Writes every row (as the schema's owner), each jsonb value as JSON and each bytea value as its bytes. */
async function writeRows(db) {
  const typed = new Map(
    (
      await db.sql`
        select table_name || '.' || column_name as key, data_type as type from information_schema.columns
        where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
      `
    ).map((column) => [column.key, column.type]),
  );
  const loaded = new Set();
  const rows = [
    ...FIXTURE_FILES.flatMap((file) => chainRows(file, loaded)).map((row) => ({
      table: row.table,
      values: planted(row.table, row.values),
    })),
    ...MADE_HERE,
  ];
  for (const { table, values } of rows) {
    const row = {};
    for (const [column, value] of Object.entries(values)) {
      const type = typed.get(`${table}.${column}`);
      row[column] =
        value === null
          ? null
          : type === "jsonb"
            ? db.sql.json(value)
            : type === "bytea" && typeof value === "string"
              ? Buffer.from(value.replace(/^\\x/, ""), "hex")
              : value;
    }
    await db.sql`insert into ${db.sql(table)} ${db.sql(row)}`;
  }
}

/** Every table of the schema: its row count and an md5 of its rows, versions included. */
async function snapshot(db) {
  const tables = await db.sql`
    select table_name as name from information_schema.tables
    where table_schema = ${db.schema} and table_type = 'BASE TABLE' order by table_name
  `;
  const out = {};
  for (const { name } of tables) {
    const [row] = await db.sql`
      select count(*)::int as n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as digest
      from ${db.sql(db.schema)}.${db.sql(name)} as t
    `;
    out[name] = `${String(row.n)} rows, md5 ${row.digest}`;
  }
  return out;
}

// ---- what the report says -------------------------------------------------------------------------------------------

const header = (trace, schema) =>
  `staging-trace: trace ${trace} in schema ${schema} on the staging database (STAGING_DATABASE_URL), read only`;
const DONE = "staging-trace: done: read only, nothing was written";

const TURN_MOVE =
  "turn id turn-alex-move-1 state committed tries 1 event_count 1 lease_until null committed_at 2026-10-23T14:05:02.000Z parked_at null";
const TURN_FIRST =
  "turn id turn-alex-first state committed tries 1 event_count 1 lease_until null committed_at 2026-10-12T16:20:03.000Z parked_at null";
const TURN_JOINED =
  "turn id turn-t1407-joined state parked tries 2 event_count 2 lease_until null committed_at null parked_at 2026-10-24T09:00:00.000Z";
const EVENTS_A = [
  "event at 2026-10-23T14:05:02.000Z kind open_question.opened table_name open_questions actor_kind person turn_id set job_id null",
  "event at 2026-10-23T14:05:02.000Z kind booking.note_sealed table_name bookings actor_kind rosie turn_id set job_id null",
];
const EVENT_SWEEP =
  "event at 2026-11-01T13:00:00.000Z kind clock_row.armed table_name clock_rows actor_kind job turn_id null job_id set";
const ROW_A =
  "outbox_row id out-a7-03-alex state delivered channel imessage send_class quick_reply held_until null plan set final_parts set";
const ROW_A_EMAIL =
  "outbox_row id out-a7-03-alex-email state planned channel email send_class quick_reply held_until null plan set final_parts null";
const ROW_FIRST =
  "outbox_row id out-alex-first state delivered channel imessage send_class quick_reply held_until null plan null final_parts null";
const PARTS_A = [
  "outbox_part outbox_row_id out-a7-03-alex part_no 1 try_no 1 attempts 1 kind words state delivered sent_at 2026-10-23T14:05:03.000Z delivered_at 2026-10-23T14:05:04.000Z failed_at null error_code null",
  "outbox_part outbox_row_id out-a7-03-alex part_no 2 try_no 1 attempts 1 kind poll state delivered sent_at 2026-10-23T14:05:05.000Z delivered_at 2026-10-23T14:05:06.000Z failed_at null error_code null",
  // The error code holds words, a number and an address: not a label, so hidden.
  `outbox_part outbox_row_id out-a7-03-alex-email part_no 1 try_no 1 attempts 2 kind words state failed sent_at null delivered_at null failed_at 2026-10-23T14:05:08.000Z error_code ${HIDDEN}`,
];
const message = (id, direction, from, to, sentAt, deliveredAt = "null", channel = "text") =>
  `message id ${id} direction ${direction} channel ${channel} from_role ${from} to_role ${to} sent_at ${sentAt} delivered_at ${deliveredAt}`;
// Alex's chat thread, the thread of his phone's handle, in the order sent.
const CHAT = [
  message("msg-alex-0001", "in", "customer", "rosie", "2026-10-12T16:20:00.000Z"),
  message(
    "msg-alex-0002",
    "out",
    "rosie",
    "customer",
    "2026-10-12T16:20:04.000Z",
    "2026-10-12T16:20:05.000Z",
  ),
  message("msg-alex-0007", "in", "customer", "rosie", "2026-10-23T14:04:58.000Z"),
  message(
    "msg-alex-0008",
    "out",
    "rosie",
    "customer",
    "2026-10-23T14:05:03.000Z",
    "2026-10-23T14:05:04.000Z",
  ),
  message("msg-alex-0009", "in", "customer", "rosie", "2026-10-23T14:06:10.000Z"),
];
const EMAIL_COPY = message(
  "msg-t1407-email-copy",
  "out",
  "rosie",
  "customer",
  "2026-10-23T14:05:07.000Z",
  "null",
  "email",
);
const SINCE = "2026-10-23T14:05:05Z";

/** The report's lines for a trace (and a time), from what it lists in each table. */
function report(schema, trace, { since, turns = [], events = [], rows = [], parts = [], messages = [] }) {
  return [
    header(trace, schema),
    ...(since === undefined ? [] : [`staging-trace: and every row written at or after ${since}`]),
    `turns: ${String(turns.length)}`,
    ...turns,
    `event_log: ${String(events.length)}`,
    ...events,
    `outbox_rows: ${String(rows.length)}`,
    ...rows,
    `outbox_parts: ${String(parts.length)}`,
    ...parts,
    `messages: ${String(messages.length)}`,
    ...messages,
    DONE,
  ]
    .map((line) => `${line}\n`)
    .join("");
}

/** The reports, by run: [title, arguments, the trace the report names, what it lists]. */
const REPORTS = [
  [
    "trace A: its turn, its two events, its turn's two rows and three parts, and the turn's chat thread",
    [TRACE_A],
    TRACE_A,
    { turns: [TURN_MOVE], events: EVENTS_A, rows: [ROW_A, ROW_A_EMAIL], parts: PARTS_A, messages: CHAT },
  ],
  [
    "trace A in capitals: the same report, the trace id in lower case as the runtime keeps it",
    [TRACE_A.toUpperCase()],
    TRACE_A,
    { turns: [TURN_MOVE], events: EVENTS_A, rows: [ROW_A, ROW_A_EMAIL], parts: PARTS_A, messages: CHAT },
  ],
  [
    "trace B: its turn, no event, its turn's row with no part, and the same chat thread",
    [TRACE_B],
    TRACE_B,
    { turns: [TURN_FIRST], rows: [ROW_FIRST], messages: CHAT },
  ],
  [
    `trace B --since ${SINCE}: with the turn parked since, the job's event since, the rows with a part sent, delivered or failed since and their parts, and the email thread's message sent since`,
    [TRACE_B, "--since", SINCE],
    TRACE_B,
    {
      since: "2026-10-23T14:05:05.000Z",
      turns: [TURN_FIRST, TURN_JOINED],
      events: [EVENT_SWEEP],
      rows: [ROW_A, ROW_A_EMAIL, ROW_FIRST],
      parts: PARTS_A,
      messages: [...CHAT.slice(0, 4), EMAIL_COPY, CHAT[4]],
    },
  ],
  [
    "trace B --since= a time after every row: the trace's rows alone",
    [`--since=2026-12-01T00:00:00.5Z`, TRACE_B],
    TRACE_B,
    { since: "2026-12-01T00:00:00.500Z", turns: [TURN_FIRST], rows: [ROW_FIRST], messages: CHAT },
  ],
  [
    "a text that joined another's turn: the turn that holds it in joined_trace_ids (its handle has no thread)",
    [TRACE_JOINED_TEXT],
    TRACE_JOINED_TEXT,
    { turns: [TURN_JOINED] },
  ],
  ["a job's trace: its event alone", [TRACE_SWEEP], TRACE_SWEEP, { events: [EVENT_SWEEP] }],
  ["a trace that wrote nothing: every table empty", [TRACE_NONE], TRACE_NONE, {}],
];

// ---- what the output never holds ------------------------------------------------------------------------------------

/**
 * Fails when the output holds a canary (words, the number or seven digits in a row, an address or an @, a handle id, a
 * chat id, a provider's id, the sealed value, a person's name, a business's name) or `others`. The schema's name, which
 * the first line gives and which may hold digits, is taken out first. The failure names the fault, never the text.
 */
function assertNoCanary(result, what, schema = "", others = []) {
  const output = schema === "" ? result.output : result.output.replaceAll(schema, "[schema]");
  assert.doesNotMatch(output, /canary/i, `${what}: the output holds a planted canary`);
  assert.doesNotMatch(output, /[0-9]{7}/, `${what}: seven digits in a row`);
  assert.equal(output.includes(NUMBER.slice(-7)), false, `${what}: the planted number`);
  // bash -x's own line, "+ set +x", holds a + with no digit after it.
  assert.doesNotMatch(output, /@|\+[0-9]/, `${what}: an address or a number's +`);
  assert.doesNotMatch(output, /handle-/, `${what}: a handle id`);
  for (const text of ["Alex M.", "Lee's Barbershop", "Riley", ...others]) {
    assert.equal(output.includes(text), false, `${what}: a name, words or a value it must not show`);
  }
}

/**
 * Fails when the output holds the URL or any part of it: the URL, its user, password, host, port (as a whole number) and
 * database name. The local database's user, password and database are all "rosie", which is also a K-04 label the
 * report prints (a message's from_role or to_role, an event's actor_kind): those labels are taken out first, so the name
 * is caught anywhere else.
 */
function assertNoUrlShown(result, url, what) {
  const output = result.output.replace(/ (from_role|to_role|actor_kind) rosie(?= )/g, " $1 [role]");
  const { username, password, hostname, port, pathname } = new URL(url);
  for (const part of [url, username, password, hostname, pathname.slice(1)].filter((each) => each !== "")) {
    assert.equal(output.includes(part), false, `${what}: the output holds a part of the database URL`);
  }
  if (port !== "") {
    assert.doesNotMatch(output, new RegExp(`(?<![0-9])${port}(?![0-9])`), `${what}: the port`);
  }
  assert.doesNotMatch(output, /postgres(ql)?:/, `${what}: a database URL`);
}

// ---- the runs -------------------------------------------------------------------------------------------------------

/** A throwaway checkout with the two files copied in beside the release scripts (lib.sh and db-url.mjs among them). */
function traceRoot(t, devVars) {
  const rig = releaseRoot(t, devVars === undefined ? {} : { devVars });
  copyScript("staging-trace.sh", rig.root);
  copyScript("staging-trace.mjs", rig.root);
  return rig;
}

// Made up: a .invalid host never resolves (RFC 6761), and port 1 of this machine refuses a connection at once, so a run
// that reached for a database here would say so (ECONNREFUSED), not refuse as asked.
const OTHER_URL =
  "postgres://t1407_other_login:t1407-made-up-password@db-t1407-other.example.invalid:5432/t1407_other";
const NOWHERE_URL = "postgres://t1407_nowhere:t1407-nowhere-password@127.0.0.1:1/t1407_nowhere";
const CALLER_TEXT = "t1407 made-up caller text";

// One throwaway schema for the whole file, with its rows written once: nothing here writes to it (each run's snapshot
// is compared with this one), so every describe reads the same rows.
const cleanups = [];
const t = { after: (fn) => cleanups.push(fn) };
let db;
let url;
let before0;

before(async () => {
  db = await createTestDatabase({ name: "staging_trace" });
  await writeRows(db);
  url = resolvePrimaryUrl();
  before0 = await snapshot(db);
});

after(async () => {
  for (const cleanup of cleanups.reverse()) cleanup();
  await db?.drop();
});

describe("staging-trace.sh (npm run staging:trace) on a throwaway schema standing in for staging's", () => {
  let rig;

  before(() => {
    rig = traceRoot(t);
  });

  const traced = (args, extra = {}) =>
    rig.run("staging-trace.sh", args, { STAGING_DATABASE_URL: url, DB_SCHEMA: db.schema, ...extra });

  for (const [title, args, trace, lists] of REPORTS) {
    it(`prints each table's lines: ${title}; no canary, no part of the URL, nothing written`, async () => {
      const result = traced(args);
      assert.equal(result.status, 0, result.output);
      assert.equal(result.stdout, report(db.schema, trace, lists));
      assert.equal(result.stderr, "");
      assertNoCanary(result, title, db.schema);
      assertNoUrlShown(result, url, title);
      assert.deepEqual(await snapshot(db), before0, `${title}: a row changed`);
    });
  }

  it("refuses a schema that is not on the database (exit 1), reading nothing", () => {
    const result = traced([TRACE_A], { DB_SCHEMA: "t_t1407_no_such_schema" });
    assert.equal(result.status, 1, result.output);
    assert.equal(
      result.stderr,
      "staging-trace: refused: schema t_t1407_no_such_schema is not on the staging database, or rosie_job may not read it; nothing was read\n",
    );
    assert.equal(result.stdout, "");
  });

  it("a staging database URL that does not parse, or names a database that does not answer, fails (exit 1) with its code and its scrubbed message alone", () => {
    const reasons = {
      hash: /^staging-trace: refused: STAGING_DATABASE_URL does not parse: it holds a # .*; nothing was read$/m,
      hashAfterDigits: /^staging-trace: refused: STAGING_DATABASE_URL does not parse: it holds a # /m,
      comment: /^staging-trace: refused: STAGING_DATABASE_URL does not parse: it holds a quote or a space /m,
      refused: /^staging-trace: failed \(ECONNREFUSED\): .*\[redacted\]/m,
      notFound: /^staging-trace: failed \((ENOTFOUND|EAI_AGAIN)\): .*\[redacted\]/m,
    };
    for (const [name, reason] of Object.entries(reasons)) {
      const bad = BAD_DATABASE_URLS[name];
      // A .dev.vars line goes in a checkout of its own; a value from the environment runs in the shared one.
      const result =
        bad.devVars === undefined
          ? traced([TRACE_A], { STAGING_DATABASE_URL: bad.env })
          : traceRoot(t, bad.devVars).run("staging-trace.sh", [TRACE_A], { DB_SCHEMA: db.schema });
      assert.equal(result.status, 1, `${bad.name}: ${result.output}`);
      assert.match(result.stderr, reason, bad.name);
      assert.equal(result.stderr.split("\n").filter(Boolean).length, 1, `${bad.name}: one line`);
      assert.equal(result.stdout, "", bad.name);
      assertNoUrlPart(result, bad, bad.name);
    }
  });
});

describe("the reader's transaction (staging-trace.mjs readOnly)", () => {
  let sql;

  before(() => {
    sql = db.connect({ max: 1, onnotice: () => undefined });
  });

  after(async () => {
    await sql?.end({ timeout: 5 });
  });

  /** The session's role, path, scope, timeout and read-only flag. */
  const settings = async (on) => {
    const [row] = await on`
      select current_user as role, current_setting('search_path') as search_path,
             nullif(current_setting('rosie.business_id', true), '') as scope,
             current_setting('statement_timeout') as timeout,
             current_setting('transaction_read_only') as read_only
    `;
    return { ...row };
  };

  it("reads as rosie_job in the schema alone, read only, with the business scope empty and a 30 s timeout; none of it outlives the transaction", async () => {
    const outside = await settings(sql);
    const inside = await readOnly(sql, db.schema, async (tx) => {
      const [row] = await tx`
        select current_user as role, current_schema() as schema, current_setting('search_path') as search_path,
               current_setting('rosie.business_id', true) as scope,
               current_setting('statement_timeout') as timeout,
               current_setting('transaction_read_only') as read_only,
               (select count(*)::int from turns) as turns
      `;
      return { ...row };
    });
    assert.deepEqual(inside, {
      role: "rosie_job",
      schema: db.schema,
      search_path: db.schema,
      scope: "",
      timeout: "30s",
      read_only: "on",
      turns: 3,
    });
    assert.deepEqual(await settings(sql), outside);
    assert.equal(outside.read_only, "off");
  });

  it("refuses a write inside it (25006, read only): an insert, an update, a delete and a new table; nothing is written, and nothing it sets outlives it", async () => {
    const outside = await settings(sql);
    const writes = [
      [
        "an insert",
        (tx) => tx`
          insert into turns (id, handle_id, event_ids, state, bundle_hash, bundle_build, trace_id, committed_at)
          values ('turn-t1407-write', 'handle-sam', ${["evt-t1407-write"]}, 'committed', ${BUNDLE_HASH}, 1,
                  ${TRACE_NONE}, now())
        `,
      ],
      ["an update", (tx) => tx`update outbox_rows set held_until = now() where id = 'out-a7-03-alex'`],
      [
        "a delete",
        (tx) => tx`delete from person_handles where person_id = 'person-sam' and handle_id = 'handle-sam'`,
      ],
      ["a new table", (tx) => tx`create table t1407_written (id text)`],
    ];
    for (const [what, write] of writes) {
      await assert.rejects(
        readOnly(sql, db.schema, write),
        (error) => {
          assert.equal(error.code, "25006", `${what}: ${String(error.message)}`);
          return true;
        },
        what,
      );
      assert.deepEqual(await settings(sql), outside, `${what}: a setting outlived the transaction`);
    }
    assert.deepEqual(await snapshot(db), before0);
  });

  it("refuses, reading nothing, a schema that is not there and a name that is not a plain schema name", async () => {
    let read = false;
    const reader = async () => {
      read = true;
      return null;
    };
    await assert.rejects(readOnly(sql, "t_t1407_no_such_schema", reader), {
      message:
        "schema t_t1407_no_such_schema is not on the staging database, or rosie_job may not read it; nothing was read",
    });
    await assert.rejects(readOnly(sql, "public; drop table turns", reader), {
      message: "the schema is not a plain lower-case SQL name; nothing was read",
    });
    assert.equal(read, false);
  });
});

// The URL as seed-staging.sh hands it (T-1310, T-1343): a recorder (script-harness.mjs's spies) stands in front of every
// command the script and lib.sh start by name, and of node; PATH holds nothing else, so none starts unseen. Each keeps
// its environment and its arguments, and both are checked: the reader alone holds the URL, as STAGING_DATABASE_URL, in
// its environment; no command holds it in an argument, and no other command has a database URL's name at all.
describe("staging-trace.sh hands the staging database's URL to the reader alone, by name", () => {
  // Every command staging-trace.sh and lib.sh start by name, but node (below), and bash for any shell they would start.
  const COMMANDS = ["basename", "bash", "date", "dirname"];
  const URL_NAMES = ["STAGING_DATABASE_URL", "DATABASE_URL", "DATABASE_REPLICA_URL", "DB_SCHEMA"];
  let watched;
  let fromEnv;
  let fromFile;
  let fromQuotedFile;

  /** What a recorded command is: the reader (node running staging-trace.mjs), or its name. */
  const kindOf = (child) =>
    child.name === "node" && child.args.some((arg) => arg.endsWith("/infra/scripts/staging-trace.mjs"))
      ? "reader"
      : child.name;

  /** A trace root (with a made-up .dev.vars when devVars is given) whose every command is spied. */
  const spiedRoot = (devVars) => {
    const rig = traceRoot(t, devVars);
    const spy = spies(rig.dir, COMMANDS, { node: [process.execPath] });
    return {
      /** Runs staging-trace.sh with `args` under the real bash, `bash` holding its options, with the variables given. */
      trace(args, extra = {}, bash = []) {
        spy.clear();
        const result = spawnSync(
          realProgram("bash"),
          [...bash, path.join(rig.root, "infra", "scripts", "staging-trace.sh"), ...args],
          {
            cwd: rig.root,
            encoding: "utf8",
            env: cleanEnv(path.join(rig.dir, "home"), { PATH: spy.bin, DB_SCHEMA: db.schema, ...extra }),
          },
        );
        return { ...result, output: `${result.stdout}${result.stderr}`, children: spy.children() };
      },
    };
  };

  before(() => {
    const { username, password, host } = new URL(url);
    watched = [url, `${username}:${password}@${host}`];
    fromEnv = spiedRoot();
    fromFile = spiedRoot(`STAGING_DATABASE_URL=${url}\n`);
    fromQuotedFile = spiedRoot(
      `# the staging database (made up here)\n  export STAGING_DATABASE_URL="${url}"\n`,
    );
  });

  const sources = () => [
    ["from the environment", fromEnv, { STAGING_DATABASE_URL: url }],
    ["from .dev.vars", fromFile, {}],
    ["from .dev.vars, exported and quoted", fromQuotedFile, {}],
  ];

  /** Fails unless the run printed trace A's report and the URL reached the reader alone, by name. */
  function assertReaderAlone(result, what, others = []) {
    assert.equal(result.status, 0, `${what}: ${result.output}`);
    assert.equal(
      result.stdout,
      report(db.schema, TRACE_A, {
        turns: [TURN_MOVE],
        events: EVENTS_A,
        rows: [ROW_A, ROW_A_EMAIL],
        parts: PARTS_A,
        messages: CHAT,
      }),
      what,
    );
    const kinds = result.children.map(kindOf);
    assert.equal(kinds.filter((kind) => kind === "reader").length, 1, `${what}: the reader, once`);
    assert.ok(kinds.includes("dirname"), `${what}: no dirname was recorded`);
    assert.deepEqual(
      whereHeld(result.children, watched, kindOf),
      ["reader: env STAGING_DATABASE_URL"],
      `${what}: where the URL is`,
    );
    assert.deepEqual(
      namedIn(result.children, URL_NAMES, kindOf),
      ["reader: STAGING_DATABASE_URL"],
      `${what}: a database URL's name`,
    );
    const [reader] = result.children.filter((child) => kindOf(child) === "reader");
    assert.ok(reader.env.split("\n").includes(`STAGING_DATABASE_URL=${url}`), `${what}: the reader's URL`);
    assert.deepEqual(
      reader.args.filter((arg) => !arg.endsWith("/infra/scripts/staging-trace.mjs")),
      ["--trace", TRACE_A, "--schema", db.schema],
      `${what}: the reader's arguments`,
    );
    assert.deepEqual(whereHeld(result.children, others, kindOf), [], `${what}: a caller's text`);
    assertNoCanary(result, what, db.schema, others);
    assertNoUrlShown(result, url, what);
  }

  it("from the caller's environment, or from .dev.vars by name: the reader alone gets the URL, as STAGING_DATABASE_URL; DB_SCHEMA reaches it as an argument", () => {
    for (const [what, root, extra] of sources()) {
      const result = root.trace([TRACE_A], extra);
      assertReaderAlone(result, what);
      assert.equal(result.stderr, "", what);
    }
  });

  it("allexport, keyword and tracing from the caller, a caller's variables of the script's own names, a DATABASE_REPLICA_URL, and a DATABASE_URL equal to the URL: the reader alone gets the URL, and no command a caller's text", () => {
    const caller = Object.fromEntries(
      [
        "trace",
        "since",
        "schema",
        "reader",
        "db_url",
        "caller_url",
        "name",
        "file",
        "line",
        "value",
        "ROOT",
      ].map((name) => [name, CALLER_TEXT]),
    );
    const REPLICA_URL =
      "postgres://t1407_replica:t1407-replica-password@db-t1407-replica.example.invalid:5432/t1407_r";
    for (const [source, root, extra] of sources().slice(0, 2)) {
      // [mode, its variables, bash's options, what standard error holds: a trace begins and ends at set +x]
      for (const [mode, variables, bash, stderr] of [
        ["SHELLOPTS=allexport", { SHELLOPTS: "allexport" }, [], ""],
        ["bash -a -k", {}, ["-a", "-k"], ""],
        ["bash -x", {}, ["-x"], "+ set +x\n"],
        ["SHELLOPTS=xtrace", { SHELLOPTS: "xtrace" }, [], "+ set +x\n"],
        ["the caller's variables under allexport", { ...caller, SHELLOPTS: "allexport" }, [], ""],
        ["a DATABASE_REPLICA_URL", { DATABASE_REPLICA_URL: REPLICA_URL }, [], ""],
        ["a DATABASE_URL equal to the URL", { DATABASE_URL: url }, [], ""],
      ]) {
        const what = `${mode}, ${source}`;
        const result = root.trace([TRACE_A], { ...extra, ...variables }, bash);
        assertReaderAlone(result, what, [CALLER_TEXT, REPLICA_URL, "t1407-replica-password"]);
        assert.equal(result.stderr, stderr, `${what}: standard error`);
      }
    }
  });

  it("no STAGING_DATABASE_URL, from the environment or from .dev.vars, refuses before the reader starts (exit 1), naming the variable alone", () => {
    const NOT_SET =
      "staging-trace.sh: refused: STAGING_DATABASE_URL is not set (the staging database's URL, read by name from the environment, else from .dev.vars): nothing was read\n";
    const cases = [
      ["unset, with no .dev.vars", fromEnv, {}],
      ["empty", fromEnv, { STAGING_DATABASE_URL: "" }],
      ["a DATABASE_URL alone", fromEnv, { DATABASE_URL: url }],
      [
        ".dev.vars: a commented line, another name and an empty line",
        spiedRoot(`# STAGING_DATABASE_URL=${url}\nSTAGING_DATABASE_URL_OLD=${url}\nSTAGING_DATABASE_URL=\n`),
        {},
      ],
    ];
    for (const [what, root, extra] of cases) {
      const result = root.trace([TRACE_A], extra);
      assert.equal(result.status, 1, `${what}: ${result.output}`);
      assert.equal(result.stderr, NOT_SET, what);
      assert.equal(result.stdout, "", what);
      assert.deepEqual(
        result.children.map(kindOf).filter((kind) => kind === "reader"),
        [],
        `${what}: the reader started`,
      );
      assert.deepEqual(whereHeld(result.children, watched, kindOf), [], `${what}: where the URL is`);
      assertNoUrlShown(result, url, what);
    }
  });

  it("refuses before the reader starts (exit 1): a DATABASE_URL for another database, a DB_SCHEMA that is not a plain name, and --env", () => {
    const cases = [
      [
        "DATABASE_URL names another database",
        [TRACE_A],
        { STAGING_DATABASE_URL: url, DATABASE_URL: OTHER_URL },
        /^staging-trace\.sh: refused: DATABASE_URL is set and names a database other than STAGING_DATABASE_URL's: this script reads the staging database alone \(unset DATABASE_URL to read it\); nothing was read$/,
      ],
      [
        "DATABASE_URL names another database, the URL from .dev.vars",
        [TRACE_A],
        { DATABASE_URL: OTHER_URL },
        /refused: DATABASE_URL is set and names a database other than STAGING_DATABASE_URL's/,
        fromFile,
      ],
      ...["Public", "t-1407", "a b", "x".repeat(64), "1abc", "é"].map((schema) => [
        `DB_SCHEMA ${JSON.stringify(schema)}`,
        [TRACE_A],
        { STAGING_DATABASE_URL: url, DB_SCHEMA: schema },
        /^staging-trace\.sh: refused: DB_SCHEMA is not a plain lower-case SQL name \(a-z, 0-9 and _, at most 63 characters; unset, the reader reads public, the schema staging's Worker reads\): nothing was read$/,
      ]),
      ["--env production", [TRACE_A, "--env", "production"], { STAGING_DATABASE_URL: url }, /takes no --env/],
      ["--env=staging", ["--env=staging", TRACE_A], { STAGING_DATABASE_URL: url }, /takes no --env/],
    ];
    for (const [what, args, extra, message, root = fromEnv] of cases) {
      const result = root.trace(args, extra);
      assert.equal(result.status, 1, `${what}: ${result.output}`);
      assert.match(result.stderr.trimEnd(), message, what);
      assert.equal(result.stdout, "", what);
      assert.deepEqual(
        result.children.map(kindOf).filter((kind) => kind === "reader"),
        [],
        `${what}: the reader started`,
      );
      assert.deepEqual(
        whereHeld(result.children, [...watched, OTHER_URL, "t1407-made-up-password"], kindOf),
        [],
        `${what}: a URL reached a command`,
      );
      assertNoUrlShown(result, url, what);
      assertNoUrlShown(result, OTHER_URL, what);
    }
  });

  it("a malformed trace id, a --since that is not a UTC time, and an argument it does not take refuse before any connection (exit 2), echoing none of them", () => {
    const USAGE_LINE =
      "usage: staging-trace.sh <trace id> [--since <time>] (the trace id a UUID; the time in UTC, such as 2026-11-15T11:28:00Z)";
    // [title, arguments, the reason]
    const cases = [
      ["no trace id", [], /name the trace id/],
      ["an empty trace id", [""], /the trace id is not a UUID/],
      ["a fixture's readable trace id", ["trace-alex-0007"], /the trace id is not a UUID/],
      ["a phone number", [NUMBER], /the trace id is not a UUID/],
      ["an address", [ADDRESS], /the trace id is not a UUID/],
      ["a database URL", [OTHER_URL], /the trace id is not a UUID/],
      ["a UUID in braces", [`{${TRACE_A}}`], /the trace id is not a UUID/],
      ["a UUID with no hyphens", [TRACE_A.replaceAll("-", "")], /the trace id is not a UUID/],
      ["a UUID and a sign more", [`${TRACE_A}0`], /the trace id is not a UUID/],
      ["a UUID with a space after it", [`${TRACE_A} `], /the trace id is not a UUID/],
      ["a UUID with a line after it", [`${TRACE_A}\n${TRACE_B}`], /the trace id is not a UUID/],
      ["two trace ids", [TRACE_A, TRACE_B], /one trace id at a time/],
      ["--since alone", ["--since", SINCE], /name the trace id/],
      ["--since with no time", [TRACE_A, "--since"], /--since needs a time/],
      ["--since with an empty time", [TRACE_A, "--since", ""], /--since needs a time/],
      ["--since= with no time", [TRACE_A, "--since="], /--since needs a time/],
      [
        "--since twice",
        [TRACE_A, "--since", SINCE, "--since=2026-10-23T14:05:06Z"],
        /--since is given twice/,
      ],
      ["--since a date alone", [TRACE_A, "--since", "2026-10-23"], /--since is not a UTC time/],
      ["--since with no Z", [TRACE_A, "--since", "2026-10-23T14:05:05"], /--since is not a UTC time/],
      [
        "--since in another zone",
        [TRACE_A, "--since", "2026-10-23T14:05:05+02:00"],
        /--since is not a UTC time/,
      ],
      ["--since with a space", [TRACE_A, "--since", "2026-10-23 14:05:05Z"], /--since is not a UTC time/],
      ["--since a word", [TRACE_A, "--since", "yesterday"], /--since is not a UTC time/],
      ["--since with a number", [TRACE_A, "--since", NUMBER], /--since is not a UTC time/],
      ["an option it does not take", [TRACE_A, "--bogus"], /an option it does not take/],
      ["a short option", ["-x", TRACE_A], /an option it does not take/],
    ];
    for (const [what, args, reason] of cases) {
      // A database that refuses every connection: a run that reached for it would fail with ECONNREFUSED (exit 1).
      const result = fromEnv.trace(args, { STAGING_DATABASE_URL: NOWHERE_URL });
      assert.equal(result.status, 2, `${what}: ${result.output}`);
      assert.match(result.stderr, reason, what);
      assert.equal(result.stderr.split("\n").at(-2), USAGE_LINE, what);
      assert.equal(result.stdout, "", what);
      assert.deepEqual(
        result.children.map(kindOf).filter((kind) => kind === "reader"),
        [],
        `${what}: the reader started`,
      );
      for (const arg of args.filter((each) => !/^--(since(=)?)?$/.test(each) && each.trim() !== "")) {
        assert.equal(result.output.includes(arg), false, `${what}: an argument was echoed`);
      }
      assertNoCanary(result, what);
    }
  });

  it("a --since of a day that does not exist passes the script's form, and the reader refuses it (exit 2) before any client is built", () => {
    for (const since of ["2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-10-23T24:00:00Z"]) {
      // A database that refuses every connection: a reader that reached for it would fail with ECONNREFUSED (exit 1).
      const result = fromEnv.trace([TRACE_A, "--since", since], { STAGING_DATABASE_URL: NOWHERE_URL });
      assert.equal(result.status, 2, `${since}: ${result.output}`);
      assert.equal(
        result.stderr,
        "staging-trace: --since is not a UTC time such as 2026-11-15T11:28:00Z (it is not shown)\n" +
          "usage: node infra/scripts/staging-trace.mjs --trace <trace id> --schema <schema> [--since <time>]\n",
        since,
      );
      assert.equal(result.stdout, "", since);
      assert.equal(result.output.includes(since), false, `${since}: echoed`);
      assert.equal(result.children.map(kindOf).filter((kind) => kind === "reader").length, 1, since);
    }
  });

  it("an empty or unset DB_SCHEMA reads public, the schema staging's Worker reads: the reader is asked for it", () => {
    for (const [what, extra] of [
      ["DB_SCHEMA empty", { DB_SCHEMA: "" }],
      ["DB_SCHEMA unset", { DB_SCHEMA: undefined }],
    ]) {
      // A database that refuses every connection: the reader is started, asked for public, and fails at its connection.
      const result = fromEnv.trace([TRACE_A], { STAGING_DATABASE_URL: NOWHERE_URL, ...extra });
      assert.equal(result.status, 1, `${what}: ${result.output}`);
      assert.match(result.stderr, /^staging-trace: failed \(ECONNREFUSED\): .*\[redacted\]/, what);
      const [reader] = result.children.filter((child) => kindOf(child) === "reader");
      assert.deepEqual(
        reader?.args.filter((arg) => !arg.endsWith("/infra/scripts/staging-trace.mjs")),
        ["--trace", TRACE_A, "--schema", "public"],
        what,
      );
      assert.deepEqual(namedIn(result.children, URL_NAMES, kindOf), ["reader: STAGING_DATABASE_URL"], what);
      assertNoUrlShown(result, NOWHERE_URL, what);
    }
  });

  it("a recorder keeps a command's environment and arguments, and the checks find the URL in either (the control for the checks above)", (t) => {
    const control = spies(tempDir(t, "trace-spy-control"), ["date"]);
    spawnSync(path.join(control.bin, "date"), ["-u", `/made-up/${url}`], {
      env: { PATH: control.bin, DATABASE_URL: url },
      encoding: "utf8",
    });
    const children = control.children();
    assert.deepEqual(whereHeld(children, watched, kindOf), ["date: env DATABASE_URL, args 1"]);
    assert.deepEqual(namedIn(children, URL_NAMES, kindOf), ["date: DATABASE_URL"]);
  });

  it("no run above wrote a row", async () => {
    assert.deepEqual(await snapshot(db), before0);
  });
});

describe("staging-trace.sh keeps the URL in variables of its own", () => {
  const code = (file) =>
    readFileSync(path.join(SCRIPTS, file), "utf8")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line) && line.trim() !== "");

  /**
   * Every name the script, or lib.sh's load_dev_var, assigns, adds to or declares local, but the one given to one command
   * alone on its line (STAGING_DATABASE_URL, the reader's).
   */
  function ownNames() {
    const loader = /^load_dev_var\(\) \{\n([\s\S]*?)\n\}$/m.exec(code("lib.sh").join("\n"));
    assert.ok(loader, "lib.sh no longer holds: load_dev_var() { ... }");
    const text = `${code("staging-trace.sh").join("\n")}\n${loader[1]}`;
    const names = new Set();
    for (const [, name] of text.matchAll(/(?:^|;|&&|\|\||\))[ \t]*([A-Za-z_][A-Za-z0-9_]*)\+?=/gm))
      names.add(name);
    for (const [, name] of text.matchAll(/\bfor[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+in\b/g)) names.add(name);
    for (const [, words] of text.matchAll(/^[ \t]*local[ \t]+(.+)$/gm)) {
      for (const word of words.split(/[ \t]+/)) names.add(word.replace(/=.*$/, ""));
    }
    return [...names].filter((name) => name !== "STAGING_DATABASE_URL").sort();
  }

  it("switches tracing, allexport and keyword off first, drops every name it keeps a value under before anything is sourced or started, and takes the URLs from the environment right after", () => {
    const lines = code("staging-trace.sh");
    assert.deepEqual(lines.slice(0, 4), ["set +x", "set +a", "set +k", "set -euo pipefail"]);
    const unsets = [];
    let at = 4;
    for (; /^unset -v [A-Za-z_][A-Za-z0-9_ ]*$/.test(lines[at]); at += 1) {
      unsets.push(...lines[at].slice("unset -v ".length).split(" "));
    }
    assert.deepEqual(
      ownNames().filter((name) => !unsets.includes(name)),
      [],
      "staging-trace.sh or lib.sh's load_dev_var keeps a value under a name its unset lines leave out",
    );
    assert.deepEqual(lines.slice(at, at + 7), [
      'db_url="${STAGING_DATABASE_URL:-}"',
      'caller_url="${DATABASE_URL:-}"',
      "unset -v STAGING_DATABASE_URL DATABASE_URL DATABASE_REPLICA_URL",
      'schema="${DB_SCHEMA:-}"',
      "unset -v DB_SCHEMA",
      'source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"',
      'USAGE="usage: staging-trace.sh <trace id> [--since <time>] (the trace id a UUID; the time in UTC, such as 2026-11-15T11:28:00Z)"',
    ]);
    // The URL goes to one command, by name, on that command's line.
    assert.deepEqual(
      lines.filter((line) => line.includes("$db_url")),
      [
        'if [[ -z "$db_url" ]]; then',
        '[[ -n "$db_url" ]] ||',
        'if [[ -n "$caller_url" && "$caller_url" != "$db_url" ]]; then',
        'STAGING_DATABASE_URL="$db_url" node "$ROOT/infra/scripts/staging-trace.mjs" "${reader[@]}" || status=$?',
      ],
    );
  });

  it("has no here-document, here-string, file redirection, export or eval, and never switches tracing, allexport or keyword on", () => {
    const text = code("staging-trace.sh")
      .join("\n")
      .replace(/^USAGE=.*$/m, "");
    assert.doesNotMatch(text, /\bset\s+-[A-Za-z]*[xak]|xtrace|allexport|keyword/);
    assert.doesNotMatch(text, /</, "no here-document, here-string or input redirection");
    assert.doesNotMatch(text.replaceAll(">&2", ""), />/, "no redirection into a file");
    assert.doesNotMatch(text, /\b(mktemp|tee|eval)\b/);
    assert.doesNotMatch(text, /^[ \t]*(export|declare -x)\b/m, "an export");
  });
});
