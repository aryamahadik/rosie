#!/usr/bin/env node
// T-1407: what one trace wrote on staging's database, labels and states alone (D-017's walking skeleton; DL-809: the
// first live JOIN got no reply, and the lead had no sanctioned way to see where it stopped without reading a key,
// DL-604). infra/scripts/staging-trace.sh (npm run staging:trace) starts it, and nothing else does:
//
//   STAGING_DATABASE_URL=<url> node infra/scripts/staging-trace.mjs --trace <trace id> --schema <schema> [--since <time>]
//
// It reads; it never writes. Before any client is built, each argument is checked again (staging-trace.sh checks them
// first; one this program does not take is refused, exit 2, and never echoed), and then the URL (infra/scripts/db-url.mjs,
// as db/seeds/run.mjs checks its own): from then on every part of the URL is taken out of every line printed, and a
// failure prints only describeError's line, its code and its message scrubbed. One connection and one transaction: READ
// ONLY, so PostgreSQL refuses any write in it (25006); its search path the schema alone; as rosie_job, the runtime side's
// role, which the login STAGING_DATABASE_URL names may SET ROLE to (0035), with the business scope empty, so row-level
// security shows every business's rows through rosie_job's own policies (0012), never by bypass; and a statement timeout
// of 30 s. Every setting is LOCAL, so the role, the search path, the scope and the timeout end with the transaction.
//
// What it prints for the trace (with --since, also every row written at or after that time), by K-04's column names: each
// text a K-08 label (letters, digits and _ . : / # -, never spaces, "+" or "@", never a run that reads as a number;
// runtime/src/trace/validate.ts) or else "[hidden]", each time in UTC, "null" for a null, and "set" where the line says
// only that a value is there:
//   turns         whose trace_id is the trace or whose joined_trace_ids hold it (--since: whose lease_until, committed_at
//                 or parked_at is at or after the time): id, state, tries, the count of its event ids, lease_until,
//                 committed_at, parked_at;
//   event_log     with that trace_id (--since: whose at is at or after the time): at, kind, table_name, actor_kind, and
//                 whether a turn id and a job id are set;
//   outbox_rows   of those turns or with that trace_id (--since: with a part sent, delivered or failed at or after the
//                 time): id, state, channel, send_class, held_until, and whether plan and final_parts are set;
//   outbox_parts  of those rows: the row's id, part_no, try_no, attempts, kind, state, sent_at, delivered_at, failed_at,
//                 error_code;
//   messages      of the threads of those turns' handles (--since: sent or delivered at or after the time): id, direction,
//                 channel, from_role, to_role, sent_at, delivered_at.
// Never read into this program, so never printed: a text's words, a phone number, an email address, a person, a handle id
// (the threads are found from the turns' handles inside the query), a chat id, a provider's ids, the contents of plan and
// final_parts, old_values, new_values, sealed_values, why, approved_by and proofs.
//
// No index serves a trace id (turns, event_log and outbox_rows have none on trace_id) or a time alone, so those reads
// scan their tables, which staging's few rows allow; the parts are read by their primary key and the messages by
// messages_thread_sent_idx.
//
// Exit: 0 the report printed; 1 refused (the URL is not set or does not parse, the schema is not there) or failed; 2
// misuse (an argument it does not take).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { DatabaseUrlFault, checkDatabaseUrl, describeError, printStrayErrors } from "./db-url.mjs";

/** A trace id as the runtime makes and keeps one: a UUID (runtime/src/trace/context.ts isValidTraceId; ADR-009). */
const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A time in UTC, as K-01's utc writes it, to the millisecond. */
const UTC_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/;
/** A plain lower-case SQL name, as the seed runner and the client take DB_SCHEMA. */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
// K-08's label (runtime/src/trace/validate.ts SAFE_ID and LOOKS_LIKE_NUMBER), at most LABEL_MAX long.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/#-]*$/;
const LOOKS_LIKE_NUMBER = /^[0-9().+ -]{7,}$/;
const LABEL_MAX = 200;
/** What a value that is not a label, a time or a whole number prints as. */
export const HIDDEN = "[hidden]";
/** The runtime side's role (0012), which reads every table here, and the business scope it reads with none set. */
const READER_ROLE = "rosie_job";
const SCOPE_SETTING = "rosie.business_id";
const USAGE =
  "usage: node infra/scripts/staging-trace.mjs --trace <trace id> --schema <schema> [--since <time>]";

/** A command line this program does not take (exit 2). */
class Misuse extends Error {}
/** A read refused before anything was read (exit 1). */
export class Refusal extends Error {}

/** The arguments, each given once and checked; no value is echoed. */
function parseArgs(argv) {
  const given = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!["--trace", "--schema", "--since"].includes(flag)) throw new Misuse("an argument it does not take");
    if (given.has(flag)) throw new Misuse(`${flag} is given twice`);
    if (i + 1 >= argv.length) throw new Misuse(`${flag} needs a value`);
    given.set(flag, argv[i + 1]);
  }
  const trace = given.get("--trace");
  if (trace === undefined || !TRACE_ID.test(trace)) {
    throw new Misuse("the trace id is not a UUID, the form the runtime gives every trace (it is not shown)");
  }
  const schema = given.get("--schema");
  if (schema === undefined || !SCHEMA_NAME.test(schema)) {
    throw new Misuse("the schema is not a plain lower-case SQL name");
  }
  const since = given.has("--since") ? sinceOf(given.get("--since")) : null;
  return { trace: trace.toLowerCase(), schema, since };
}

/** --since as an instant: a UTC time such as 2026-11-15T11:28:00Z, on a day that exists. */
function sinceOf(text) {
  const at = UTC_TIME.test(text) ? new Date(text) : null;
  if (at === null || Number.isNaN(at.getTime()) || at.toISOString().slice(0, 19) !== text.slice(0, 19)) {
    throw new Misuse("--since is not a UTC time such as 2026-11-15T11:28:00Z (it is not shown)");
  }
  return at.toISOString();
}

/**
 * Runs `read` in the reader's one transaction (see the top of this file): READ ONLY, the search path `schema` alone, as
 * rosie_job with the business scope empty, a 30 s statement timeout, each setting LOCAL. Refuses, reading nothing, when
 * the transaction is not read only or the schema is not one rosie_job can read.
 */
export async function readOnly(sql, schema, read) {
  if (typeof schema !== "string" || !SCHEMA_NAME.test(schema)) {
    throw new Refusal("the schema is not a plain lower-case SQL name; nothing was read");
  }
  return sql.begin("read only", async (tx) => {
    await tx`
      select set_config('search_path', quote_ident(${schema}), true),
             set_config('statement_timeout', '30s', true)
    `;
    await tx`set local role rosie_job`;
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    const [state] = await tx`
      select current_schema() as schema, current_setting('transaction_read_only') as read_only
    `;
    if (state?.read_only !== "on") throw new Refusal("the transaction is not read only; nothing was read");
    if (state.schema !== schema) {
      throw new Refusal(
        `schema ${schema} is not on the staging database, or ${READER_ROLE} may not read it; nothing was read`,
      );
    }
    return read(tx);
  });
}

/** What the trace wrote (see the top of this file): the rows of each table, their printed columns alone. */
export async function readTrace(tx, { trace, since }) {
  // An empty fragment where --since adds nothing; a new one each time.
  const none = () => tx``;
  const turns = await tx`
    select id, state, tries, cardinality(event_ids) as event_count, lease_until, committed_at, parked_at
    from turns
    where trace_id = ${trace} or ${trace} = any(joined_trace_ids)
      ${since === null ? none() : tx`or lease_until >= ${since}::timestamptz or committed_at >= ${since}::timestamptz or parked_at >= ${since}::timestamptz`}
    order by coalesce(committed_at, parked_at, lease_until), id
  `;
  const turnIds = turns.map((turn) => turn.id);
  const events = await tx`
    select at, kind, table_name, actor_kind, turn_id is not null as has_turn, job_id is not null as has_job
    from event_log
    where trace_id = ${trace} ${since === null ? none() : tx`or at >= ${since}::timestamptz`}
    order by at, id
  `;
  const rows = await tx`
    select r.id, r.state, r.channel, r.send_class, r.held_until, r.plan is not null as has_plan,
           r.final_parts is not null as has_final_parts
    from outbox_rows r
    where r.turn_id = any(${turnIds}::text[]) or r.trace_id = ${trace}
      ${
        since === null
          ? none()
          : tx`or exists (
              select 1 from outbox_parts s
              where s.outbox_row_id = r.id
                and (s.sent_at >= ${since}::timestamptz or s.delivered_at >= ${since}::timestamptz
                  or s.failed_at >= ${since}::timestamptz)
            )`
      }
    order by r.commit_seq
  `;
  const parts = await tx`
    select p.outbox_row_id, p.part_no, p.try_no, p.attempts, p.kind, p.state, p.sent_at, p.delivered_at, p.failed_at,
           p.error_code
    from outbox_parts p
    join outbox_rows r on r.id = p.outbox_row_id
    where p.outbox_row_id = any(${rows.map((row) => row.id)}::text[])
    order by r.commit_seq, p.part_no, p.try_no
  `;
  const messages = await tx`
    select m.id, m.direction, m.channel, m.from_role, m.to_role, m.sent_at, m.delivered_at
    from messages m
    where m.thread_id in (
        select h.id from threads h where h.handle_id in (select t.handle_id from turns t where t.id = any(${turnIds}::text[]))
      )
      ${since === null ? none() : tx`or m.sent_at >= ${since}::timestamptz or m.delivered_at >= ${since}::timestamptz`}
    order by m.sent_at, m.id
  `;
  return { turns, events, rows, parts, messages };
}

/** A text as printed: a K-08 label, "null", or HIDDEN. */
function label(value) {
  if (value === null) return "null";
  const isLabel =
    typeof value === "string" &&
    value.length <= LABEL_MAX &&
    SAFE_ID.test(value) &&
    !LOOKS_LIKE_NUMBER.test(value);
  return isLabel ? value : HIDDEN;
}

/** A time as printed: UTC to the millisecond, "null", or HIDDEN. */
function time(value) {
  if (value === null) return "null";
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : HIDDEN;
}

/** A whole number as printed, or HIDDEN. */
const whole = (value) => (Number.isSafeInteger(value) ? String(value) : HIDDEN);

/** Whether a value is there: "set" or "null". */
const isSet = (value) => (value === true ? "set" : "null");

/** The report's lines (see the top of this file). */
export function reportLines({ trace, since, schema }, { turns, events, rows, parts, messages }) {
  const lines = [
    `staging-trace: trace ${trace} in schema ${schema} on the staging database (STAGING_DATABASE_URL), read only`,
  ];
  if (since !== null) lines.push(`staging-trace: and every row written at or after ${since}`);
  lines.push(`turns: ${String(turns.length)}`);
  for (const t of turns) {
    lines.push(
      `turn id ${label(t.id)} state ${label(t.state)} tries ${whole(t.tries)} event_count ${whole(t.event_count)} ` +
        `lease_until ${time(t.lease_until)} committed_at ${time(t.committed_at)} parked_at ${time(t.parked_at)}`,
    );
  }
  lines.push(`event_log: ${String(events.length)}`);
  for (const e of events) {
    lines.push(
      `event at ${time(e.at)} kind ${label(e.kind)} table_name ${label(e.table_name)} ` +
        `actor_kind ${label(e.actor_kind)} turn_id ${isSet(e.has_turn)} job_id ${isSet(e.has_job)}`,
    );
  }
  lines.push(`outbox_rows: ${String(rows.length)}`);
  for (const r of rows) {
    lines.push(
      `outbox_row id ${label(r.id)} state ${label(r.state)} channel ${label(r.channel)} ` +
        `send_class ${label(r.send_class)} held_until ${time(r.held_until)} plan ${isSet(r.has_plan)} ` +
        `final_parts ${isSet(r.has_final_parts)}`,
    );
  }
  lines.push(`outbox_parts: ${String(parts.length)}`);
  for (const p of parts) {
    lines.push(
      `outbox_part outbox_row_id ${label(p.outbox_row_id)} part_no ${whole(p.part_no)} try_no ${whole(p.try_no)} ` +
        `attempts ${whole(p.attempts)} kind ${label(p.kind)} state ${label(p.state)} sent_at ${time(p.sent_at)} ` +
        `delivered_at ${time(p.delivered_at)} failed_at ${time(p.failed_at)} error_code ${label(p.error_code)}`,
    );
  }
  lines.push(`messages: ${String(messages.length)}`);
  for (const m of messages) {
    lines.push(
      `message id ${label(m.id)} direction ${label(m.direction)} channel ${label(m.channel)} ` +
        `from_role ${label(m.from_role)} to_role ${label(m.to_role)} sent_at ${time(m.sent_at)} ` +
        `delivered_at ${time(m.delivered_at)}`,
    );
  }
  lines.push("staging-trace: done: read only, nothing was written");
  return lines;
}

async function main(argv, env, secrets) {
  const { trace, schema, since } = parseArgs(argv);
  const url = env.STAGING_DATABASE_URL ?? "";
  try {
    secrets.parts = checkDatabaseUrl(url);
  } catch (error) {
    if (!(error instanceof DatabaseUrlFault)) throw error;
    const why = url === "" ? "is not set" : `does not parse: ${error.message}`;
    throw new Refusal(`STAGING_DATABASE_URL ${why}; nothing was read`);
  }
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 15,
    onnotice: () => undefined,
    connection: { application_name: "rosie-staging-trace" },
  });
  try {
    const found = await readOnly(sql, schema, (tx) => readTrace(tx, { trace, since }));
    for (const line of reportLines({ trace, since, schema }, found)) console.log(line);
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Whether this file is the program node was asked to run (a test imports it and runs nothing). */
function isMain() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  // The parts of the URL taken out of every line printed: the whole string until it is checked, then each part. An error
  // no catch takes is printed the same way, never its fields.
  const secrets = { parts: [process.env.STAGING_DATABASE_URL ?? ""] };
  printStrayErrors("staging-trace", () => secrets.parts);
  try {
    process.exitCode = await main(process.argv.slice(2), process.env, secrets);
  } catch (error) {
    if (error instanceof Misuse) {
      console.error(`staging-trace: ${error.message}\n${USAGE}`);
      process.exitCode = 2;
    } else if (error instanceof Refusal) {
      console.error(`staging-trace: refused: ${error.message}`);
      process.exitCode = 1;
    } else {
      console.error(`staging-trace: failed${describeError(error, secrets.parts)}`);
      process.exitCode = 1;
    }
  }
}
