// Spike T-1124: the probe. The same queries run from a Worker through the Hyperdrive binding (worker.mjs) and from
// plain Node against the local rosie-pg (local.mjs, probe.test.mjs).
//
// What it answers, each with the query it ran and what came back:
//   extensions        postgis, btree_gist and pgcrypto are installed, and each one works (a distance, an EXCLUDE, a digest)
//   exclude           an EXCLUDE constraint refuses an overlapping insert (SQLSTATE 23P01)
//   cas               the time of a one-row compare-and-set commit, in three shapes, p50 and p95 beside 300 ms (arch 04)
//   reads             the time of a one-row read, beside 150 ms (arch 04, "Build the frontier")
//   read_after_write  a repeated, identical SELECT never returns an older row (what Hyperdrive's cache would do)
//   transaction       a transaction keeps one backend, one transaction id, its SET LOCAL value and its row lock while
//                     other queries run through the pool, and a rollback leaves nothing behind
//
// Every table lives in the schema spike_hyperdrive. The probe drops that schema first (a run that died earlier) and
// again at the end, on failure too, and reports whether it is gone. It creates no extension and changes nothing
// outside that schema. It never reads, prints or returns a connection string: the caller hands it `open`, which
// makes the postgres.js clients, and `redact`, which every error message passes through.

export const SCHEMA = "spike_hyperdrive";
/** Architecture 04, "Latency budget targets": gate and commit at most 300 ms; build the frontier at most 150 ms. */
export const COMMIT_BUDGET_MS = 300;
export const READ_BUDGET_MS = 150;
export const MIN_COMMITS = 50;
export const MAX_COMMITS = 200;
/** Untimed commits before each timed loop: the first ones pay for the connection and the statement's plan. */
const WARM_UP = 5;

/** The p-th percentile by nearest rank (p50 of 60 samples is the 30th smallest), or null for no samples. */
export function percentile(samples, p) {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p * sorted.length) / 100)));
  return sorted[rank - 1];
}

const round = (value) => (value === null ? null : Math.round(value * 10) / 10);

/** n, min, p50, p95, max and mean of the samples, in milliseconds with one decimal. */
export function summarize(samples) {
  const n = samples.length;
  return {
    n,
    min_ms: round(n === 0 ? null : Math.min(...samples)),
    p50_ms: round(percentile(samples, 50)),
    p95_ms: round(percentile(samples, 95)),
    max_ms: round(n === 0 ? null : Math.max(...samples)),
    mean_ms: round(n === 0 ? null : samples.reduce((sum, value) => sum + value, 0) / n),
  };
}

/** The whole number of timed commits a run uses: `raw` when it is 50 to 200, else the nearest of the two. */
export function clampCommits(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return 60;
  }
  return Math.min(MAX_COMMITS, Math.max(MIN_COMMITS, Math.trunc(value)));
}

/**
 * A function that removes each connection string from a text, with its password, user and host on their own (as
 * written and percent-decoded). The probe passes every error message through it before the message is returned.
 */
export function makeRedactor(urls) {
  const secrets = new Set();
  for (const url of urls) {
    if (typeof url !== "string" || url === "") {
      continue;
    }
    secrets.add(url);
    try {
      const parsed = new URL(url);
      for (const part of [parsed.password, parsed.username, parsed.hostname]) {
        if (part !== "") {
          secrets.add(part);
          try {
            secrets.add(decodeURIComponent(part));
          } catch {
            // Not percent-encoded text: the part as written is still removed.
          }
        }
      }
    } catch {
      // Not a parsable URL: the whole string is still removed.
    }
  }
  // Longest first, so a password that contains the user name is removed whole.
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text);
    for (const secret of ordered) {
      out = out.split(secret).join("[redacted]");
    }
    return out;
  };
}

function describe(error, redact) {
  const code = typeof error?.code === "string" ? error.code : null;
  const message = redact(error instanceof Error ? error.message : String(error));
  return { code, message: message.slice(0, 300) };
}

/** Runs `fn` and returns the error it throws, or null when it does not throw. */
async function refusal(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

async function schemaExists(sql) {
  const [row] = await sql`select count(*)::int as n from pg_namespace where nspname = ${SCHEMA}`;
  return row.n > 0;
}

async function serverStep(sql) {
  const [row] = await sql`
    select current_setting('server_version') as version,
           pg_is_in_recovery() as in_recovery,
           current_setting('synchronous_commit', true) as synchronous_commit,
           current_setting('transaction_isolation') as isolation,
           current_setting('search_path') as search_path`;
  // Not readable by every role on every host, so a refusal is recorded and is not a failure of the probe.
  const standby = await refusal(async () => {
    const [names] = await sql`select current_setting('synchronous_standby_names', true) as names`;
    row.synchronous_standby_names = names.names;
  });
  if (standby !== null) {
    row.synchronous_standby_names = `not readable (${standby.code ?? "error"})`;
  }
  return { ok: true, ...row };
}

async function extensionsStep(sql) {
  const rows = await sql`
    select extname as name, extversion as version, extnamespace::regnamespace::text as schema
    from pg_extension
    where extname in ('postgis', 'btree_gist', 'pgcrypto')
    order by extname`;
  const found = Object.fromEntries(
    rows.map((row) => [row.name, { version: row.version, schema: row.schema }]),
  );
  const missing = ["postgis", "btree_gist", "pgcrypto"].filter((name) => !(name in found));
  return {
    ok: missing.length === 0,
    query: "select extname, extversion, extnamespace from pg_extension where extname in (the three)",
    found,
    missing,
  };
}

async function setupStep(sql) {
  // A run that died before its cleanup leaves the schema behind: start from nothing.
  await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`);
  await sql.unsafe(`create schema ${SCHEMA}`);
  await sql.unsafe(`
    create table ${SCHEMA}.booking (
      id bigint generated always as identity primary key,
      worker_id uuid not null,
      during tstzrange not null,
      constraint booking_no_overlap exclude using gist (worker_id with =, during with &&)
    )`);
  await sql.unsafe(`
    create table ${SCHEMA}.place (
      id int primary key,
      name text not null,
      geog geography(Point, 4326) not null
    )`);
  await sql.unsafe(`create index place_geog on ${SCHEMA}.place using gist (geog)`);
  await sql.unsafe(`
    create table ${SCHEMA}.state (
      id int primary key,
      version bigint not null,
      last_turn uuid
    )`);
  await sql.unsafe(`
    create table ${SCHEMA}.turn (
      turn_id uuid primary key,
      state_id int not null references ${SCHEMA}.state (id),
      committed_at timestamptz not null default now()
    )`);
  await sql.unsafe(`create table ${SCHEMA}.txn (id int primary key, note text not null)`);
  // Row 1: the compare-and-set loops. Row 2: read after write. Row 3: the row lock of the transaction check.
  await sql.unsafe(`insert into ${SCHEMA}.state (id, version) values (1, 0), (2, 0), (3, 0)`);
  return { ok: true, tables: ["booking", "place", "state", "turn", "txn"] };
}

async function postgisStep(sql) {
  await sql`
    insert into spike_hyperdrive.place (id, name, geog) values
      (1, 'Cambridge MA', ST_SetSRID(ST_MakePoint(-71.1097, 42.3736), 4326)::geography),
      (2, 'Boston MA', ST_SetSRID(ST_MakePoint(-71.0589, 42.3601), 4326)::geography),
      (3, 'Worcester MA', ST_SetSRID(ST_MakePoint(-71.8023, 42.2626), 4326)::geography)`;
  // 10 miles is 16,093.44 m. Boston is about 4.4 km from Cambridge; Worcester about 58 km.
  const near = await sql`
    select name, round(ST_Distance(geog, ST_SetSRID(ST_MakePoint(-71.1097, 42.3736), 4326)::geography)) as meters
    from spike_hyperdrive.place
    where ST_DWithin(geog, ST_SetSRID(ST_MakePoint(-71.1097, 42.3736), 4326)::geography, 16093.44)
    order by meters, id`;
  const [versions] = await sql`
    select PostGIS_Version() as postgis,
           encode(digest('spike_hyperdrive', 'sha256'), 'hex') as pgcrypto_sha256`;
  const names = near.map((row) => row.name);
  // pgcrypto's digest must equal the same SHA-256 worked out here, by the runtime's own Web Crypto.
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("spike_hyperdrive"));
  const expected = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    ok: names.join("|") === "Cambridge MA|Boston MA" && versions.pgcrypto_sha256 === expected,
    query: "ST_DWithin(geog, point, 16093.44) over a gist index; PostGIS_Version(); digest(text, 'sha256')",
    within_10_miles: near.map((row) => ({ name: row.name, meters: Number(row.meters) })),
    postgis_version: versions.postgis,
    pgcrypto_digest_matches_web_crypto: versions.pgcrypto_sha256 === expected,
  };
}

async function excludeStep(sql) {
  const workerA = "00000000-0000-4000-8000-00000000000a";
  const workerB = "00000000-0000-4000-8000-00000000000b";
  const insert = (worker, from, to) => sql`
    insert into spike_hyperdrive.booking (worker_id, during)
    values (${worker}, tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)'))`;
  await insert(workerA, "2027-01-07T15:00:00Z", "2027-01-07T16:00:00Z");
  const overlap = await refusal(() => insert(workerA, "2027-01-07T15:30:00Z", "2027-01-07T16:30:00Z"));
  // Back to back is not an overlap ('[)' ranges), and another worker's same time is not either.
  const adjacent = await refusal(() => insert(workerA, "2027-01-07T16:00:00Z", "2027-01-07T17:00:00Z"));
  const otherWorker = await refusal(() => insert(workerB, "2027-01-07T15:30:00Z", "2027-01-07T16:30:00Z"));
  const [count] = await sql`select count(*)::int as n from spike_hyperdrive.booking`;
  return {
    ok: overlap?.code === "23P01" && adjacent === null && otherWorker === null && count.n === 3,
    query:
      "exclude using gist (worker_id with =, during with &&); insert 15:00-16:00, then 15:30-16:30 for the same worker",
    overlapping_insert: overlap === null ? "accepted" : "refused",
    sqlstate: overlap?.code ?? null,
    constraint: overlap?.constraint_name ?? null,
    adjacent_insert: adjacent === null ? "accepted" : `refused (${adjacent.code ?? "error"})`,
    other_worker_insert: otherWorker === null ? "accepted" : `refused (${otherWorker.code ?? "error"})`,
    rows: count.n,
  };
}

async function casStep(sql, commits) {
  let version = 0;
  const moved = (rows, shape) => {
    if (rows.length !== 1) {
      throw new Error(
        `${shape}: the compare-and-set matched ${String(rows.length)} rows at version ${String(version)}`,
      );
    }
    version = Number(rows[0].version);
  };

  // Shape 1: one statement, one round trip. The row moves only when it still holds the version that was read.
  const oneStatement = [];
  for (let i = 0; i < WARM_UP + commits; i++) {
    const { ms, value } = await timed(
      () => sql`
        update spike_hyperdrive.state set version = version + 1
        where id = 1 and version = ${version}
        returning version`,
    );
    moved(value, "one statement");
    if (i >= WARM_UP) {
      oneStatement.push(ms);
    }
  }

  // A commit that read an older version changes nothing.
  const stale = await sql`
    update spike_hyperdrive.state set version = version + 1
    where id = 1 and version = ${version - 1}
    returning version`;

  // Shape 2: the turn's commit as a transaction, four round trips (begin, the turn id, the compare-and-set, commit).
  const transaction = [];
  let lastTurn = null;
  for (let i = 0; i < WARM_UP + commits; i++) {
    const turn = crypto.randomUUID();
    const { ms } = await timed(() =>
      sql.begin(async (tx) => {
        await tx`insert into spike_hyperdrive.turn (turn_id, state_id) values (${turn}, 1)`;
        const rows = await tx`
          update spike_hyperdrive.state set version = version + 1, last_turn = ${turn}
          where id = 1 and version = ${version}
          returning version`;
        moved(rows, "transaction");
      }),
    );
    lastTurn = turn;
    if (i >= WARM_UP) {
      transaction.push(ms);
    }
  }

  // The same turn id again: the unique key refuses it, and the whole transaction rolls back (the version stays).
  const versionBefore = version;
  const replay = await refusal(() =>
    sql.begin(async (tx) => {
      await tx`
        update spike_hyperdrive.state set version = version + 1, last_turn = ${lastTurn}
        where id = 1 and version = ${versionBefore}`;
      await tx`insert into spike_hyperdrive.turn (turn_id, state_id) values (${lastTurn}, 1)`;
    }),
  );
  const [afterReplay] = await sql`select version from spike_hyperdrive.state where id = 1`;

  // Shape 3: the same transaction with both statements sent together (postgres.js pipelines an array).
  const pipelined = [];
  for (let i = 0; i < WARM_UP + commits; i++) {
    const turn = crypto.randomUUID();
    const { ms, value } = await timed(() =>
      sql.begin((tx) => [
        tx`insert into spike_hyperdrive.turn (turn_id, state_id) values (${turn}, 1)`,
        tx`
          update spike_hyperdrive.state set version = version + 1, last_turn = ${turn}
          where id = 1 and version = ${version}
          returning version`,
      ]),
    );
    moved(value[1], "pipelined transaction");
    if (i >= WARM_UP) {
      pipelined.push(ms);
    }
  }

  const [turns] = await sql`select count(*)::int as n from spike_hyperdrive.turn`;
  const shapes = {
    one_statement: summarize(oneStatement),
    transaction: summarize(transaction),
    transaction_pipelined: summarize(pipelined),
  };
  const expectedVersion = 3 * (WARM_UP + commits);
  return {
    ok:
      stale.length === 0 &&
      replay?.code === "23505" &&
      Number(afterReplay.version) === versionBefore &&
      version === expectedVersion &&
      turns.n === 2 * (WARM_UP + commits) &&
      Object.values(shapes).every((shape) => shape.n >= MIN_COMMITS),
    query:
      "update state set version = version + 1 where id = 1 and version = $read returning version; alone, " +
      "then inside begin / insert turn (turn_id primary key) / commit, then with both statements sent together",
    budget_ms: COMMIT_BUDGET_MS,
    warm_up_commits_not_timed: WARM_UP,
    ...shapes,
    p95_within_budget: Object.fromEntries(
      Object.entries(shapes).map(([name, shape]) => [
        name,
        shape.p95_ms !== null && shape.p95_ms <= COMMIT_BUDGET_MS,
      ]),
    ),
    stale_version_commit: stale.length === 0 ? "changed nothing" : "CHANGED THE ROW",
    replayed_turn_id: replay === null ? "ACCEPTED" : `refused (${replay.code ?? "error"})`,
    version_after_replay_unchanged: Number(afterReplay.version) === versionBefore,
    final_version: version,
    turn_rows: turns.n,
  };
}

async function readsStep(sql, commits) {
  const samples = [];
  for (let i = 0; i < WARM_UP + commits; i++) {
    const { ms } = await timed(() => sql`select version, last_turn from spike_hyperdrive.state where id = 1`);
    if (i >= WARM_UP) {
      samples.push(ms);
    }
  }
  const summary = summarize(samples);
  return {
    ok: summary.n >= MIN_COMMITS,
    query: "select version, last_turn from state where id = 1",
    budget_ms: READ_BUDGET_MS,
    ...summary,
    p95_within_budget: summary.p95_ms !== null && summary.p95_ms <= READ_BUDGET_MS,
  };
}

async function readAfterWriteStep(sql) {
  // The SELECT's text and parameters are the same every round: a cache keyed on them would answer with an older row.
  const rounds = 20;
  let stale = 0;
  for (let i = 0; i < rounds; i++) {
    const [written] = await sql`
      update spike_hyperdrive.state set version = version + 1 where id = 2 returning version`;
    const [read] = await sql`select version from spike_hyperdrive.state where id = 2`;
    if (read.version !== written.version) {
      stale++;
    }
  }
  return {
    ok: stale === 0,
    query:
      "update state ... where id = 2 returning version; then the same select version ... where id = 2, 20 times",
    rounds,
    stale_reads: stale,
  };
}

class RollBack extends Error {}

async function transactionStep(sql, other) {
  const rounds = 5;
  const inside = { pids: new Set(), txids: new Set(), markers: new Set(), ownRowSeen: 0 };
  const outsidePids = new Set();
  let seenOutside = null;
  let lockWhileHeld = null;

  const rolledBack = await refusal(() =>
    sql.begin(async (tx) => {
      // SET LOCAL, as db/repo/scope.ts scopes a transaction to one business.
      await tx`select set_config('spike_hyperdrive.marker', 'held', true)`;
      await tx`insert into spike_hyperdrive.txn (id, note) values (1, 'never committed')`;
      await tx`select id from spike_hyperdrive.state where id = 3 for update`;
      for (let i = 0; i < rounds; i++) {
        // Other work goes through the pool while the transaction stays open: the same client's other connections,
        // and a second client.
        const busy = await Promise.all([
          sql`select pg_backend_pid() as pid`,
          sql`select pg_backend_pid() as pid`,
          other`select pg_backend_pid() as pid`,
        ]);
        for (const [row] of busy) {
          outsidePids.add(row.pid);
        }
        const [row] = await tx`
          select pg_backend_pid() as pid,
                 txid_current()::text as txid,
                 current_setting('spike_hyperdrive.marker', true) as marker,
                 (select count(*)::int from spike_hyperdrive.txn where id = 1) as own_row`;
        inside.pids.add(row.pid);
        inside.txids.add(row.txid);
        inside.markers.add(row.marker);
        inside.ownRowSeen += row.own_row;
      }
      const [count] = await other`select count(*)::int as n from spike_hyperdrive.txn where id = 1`;
      seenOutside = count.n;
      lockWhileHeld = await refusal(
        () => other`select id from spike_hyperdrive.state where id = 3 for update nowait`,
      );
      throw new RollBack("the probe rolls this transaction back");
    }),
  );
  if (!(rolledBack instanceof RollBack)) {
    throw rolledBack ?? new Error("the transaction did not reach its rollback");
  }

  const [afterRollback] = await other`select count(*)::int as n from spike_hyperdrive.txn where id = 1`;
  const lockAfter = await refusal(
    () => other`select id from spike_hyperdrive.state where id = 3 for update nowait`,
  );
  // The SET LOCAL value must not outlive the transaction on any pooled connection.
  const leaked = await Promise.all([
    sql`select current_setting('spike_hyperdrive.marker', true) as marker`,
    sql`select current_setting('spike_hyperdrive.marker', true) as marker`,
    sql`select current_setting('spike_hyperdrive.marker', true) as marker`,
    other`select current_setting('spike_hyperdrive.marker', true) as marker`,
  ]);
  const markerLeaked = leaked.some(([row]) => row.marker !== null && row.marker !== "");

  await sql.begin(async (tx) => {
    await tx`insert into spike_hyperdrive.txn (id, note) values (2, 'committed')`;
    await tx`update spike_hyperdrive.state set version = version + 1 where id = 3`;
  });
  const [committed] = await other`
    select (select count(*)::int from spike_hyperdrive.txn where id = 2) as row_count,
           (select version from spike_hyperdrive.state where id = 3) as version`;

  const held =
    inside.pids.size === 1 &&
    inside.txids.size === 1 &&
    inside.markers.size === 1 &&
    inside.markers.has("held") &&
    inside.ownRowSeen === rounds;
  return {
    ok:
      held &&
      seenOutside === 0 &&
      lockWhileHeld?.code === "55P03" &&
      afterRollback.n === 0 &&
      lockAfter === null &&
      !markerLeaked &&
      committed.row_count === 1 &&
      Number(committed.version) === 1,
    query:
      "begin; set_config(marker, 'held', true); insert; select ... for update; then 5 rounds of " +
      "pg_backend_pid(), txid_current(), current_setting(marker) while 3 other queries run; rollback",
    rounds,
    backends_inside_transaction: inside.pids.size,
    transaction_ids_inside: inside.txids.size,
    set_local_value_held: inside.markers.size === 1 && inside.markers.has("held"),
    own_uncommitted_row_seen_inside: inside.ownRowSeen === rounds,
    uncommitted_row_seen_outside: seenOutside !== 0,
    row_lock_while_open: lockWhileHeld === null ? "NOT HELD" : `held (${lockWhileHeld.code ?? "error"})`,
    row_after_rollback: afterRollback.n === 0 ? "gone" : "STILL THERE",
    row_lock_after_rollback: lockAfter === null ? "free" : `still held (${lockAfter.code ?? "error"})`,
    set_local_value_leaked_to_pool: markerLeaked,
    committed_transaction_visible: committed.row_count === 1 && Number(committed.version) === 1,
    backends_seen_outside_transaction: outsidePids.size,
  };
}

/** Drops the probe's schema when it exists and says whether it was there before and after. Changes nothing else. */
export async function dropSchema(sql) {
  const before = await schemaExists(sql);
  await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`);
  const after = await schemaExists(sql);
  return { ok: !after, schema: SCHEMA, present_before: before, schema_dropped: !after };
}

/**
 * Runs the whole probe and returns its result: one entry per step, each with `ok`, and `ok` for the run.
 *   open(options)  makes a postgres.js client for the database under test (called twice: 4 connections, then 1)
 *   redact(text)   removes the connection string and its parts from an error message
 *   commits        timed commits per shape, 50 to 200
 *   via            "worker" or "node", copied into the result
 *   inject(sql)    tests only: runs after the tables exist, to make a run fail part way
 */
export async function runProbe({
  open,
  redact = (text) => String(text),
  commits = 60,
  via = "node",
  inject,
}) {
  const started = Date.now();
  const timedCommits = clampCommits(commits);
  const result = {
    probe: "T-1124 hyperdrive-host",
    via,
    schema: SCHEMA,
    timed_commits_per_shape: timedCommits,
    ok: false,
    failed_steps: [],
  };
  const step = async (name, fn) => {
    try {
      result[name] = await fn();
    } catch (error) {
      result[name] = { ok: false, error: describe(error, redact) };
    }
    if (result[name].ok !== true) {
      result.failed_steps.push(name);
    }
    return result[name].ok === true;
  };

  const sql = open({ max: 4 });
  const other = open({ max: 1 });
  try {
    const connected = await step("connect", async () => {
      const first = await timed(() => sql`select 1 as one`);
      const second = await timed(() => other`select 1 as one`);
      return { ok: true, first_query_ms: round(first.ms), second_client_first_query_ms: round(second.ms) };
    });
    if (connected) {
      await step("server", () => serverStep(sql));
      await step("extensions", () => extensionsStep(sql));
      if (await step("setup", () => setupStep(sql))) {
        if (inject !== undefined) {
          await step("injected", async () => {
            await inject(sql);
            return { ok: true };
          });
        }
        await step("postgis", () => postgisStep(sql));
        await step("exclude", () => excludeStep(sql));
        await step("cas", () => casStep(sql, timedCommits));
        await step("reads", () => readsStep(sql, timedCommits));
        await step("read_after_write", () => readAfterWriteStep(sql));
        await step("transaction", () => transactionStep(sql, other));
      }
    }
  } finally {
    // On failure too. The second client is the fallback when the first can no longer run a statement.
    const dropped = await step("cleanup", () => dropSchema(sql));
    if (!dropped) {
      result.failed_steps.pop();
      await step("cleanup", () => dropSchema(other));
    }
    await Promise.allSettled([sql.end({ timeout: 5 }), other.end({ timeout: 5 })]);
  }
  result.ok = result.failed_steps.length === 0;
  result.elapsed_ms = Date.now() - started;
  return result;
}
