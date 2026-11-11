// Spike T-1124: checks of the probe. Run: node --test infra/spikes/hyperdrive-host/probe.test.mjs
// The database tests need the local rosie-pg (npm run db:up) with migration 0001's three extensions; they run the
// probe's own queries from Node and use only the schema spike_hyperdrive. Not part of npm test.
import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "postgres";
import { hostKind, hyperdriveRow, liveVersion, passed, spikeConfig } from "./helpers.mjs";
import { LOCAL_DATABASE_URL, localDatabaseUrl, runLocal } from "./local.mjs";
import { SCHEMA, clampCommits, makeRedactor, percentile, summarize } from "./probe.mjs";
import worker, { refusedBy } from "./worker.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const request = (path, token) =>
  new Request(
    `http://probe.invalid${path}`,
    token === undefined ? {} : { headers: { "x-probe-token": token } },
  );

async function schemaCount() {
  const sql = postgres(localDatabaseUrl({}), { max: 1, onnotice: () => undefined });
  try {
    const [row] = await sql`select count(*)::int as n from pg_namespace where nspname = ${SCHEMA}`;
    return row.n;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// The shape wrangler 4.158.0's `hyperdrive list` prints (logger.table): its columns, in its order.
const HEAD = [
  "id",
  "name",
  "user",
  "host",
  "port",
  "scheme",
  "database",
  "caching",
  "mtls",
  "origin_connection_limit",
];
const ID_A = "0123456789abcdef0123456789abcdef";
const ID_B = "fedcba9876543210fedcba9876543210";
const listRow = (id, name, caching) => [
  id,
  name,
  "origin-user",
  "origin-host.example.test",
  "5432",
  "PostgreSQL",
  "main",
  caching,
  "{}",
  "",
];
const table = (rows) => {
  const line = (cells) => `│ ${cells.join(" │ ")} │`;
  return [
    " ⛅️ wrangler 4.158.0",
    "📋 Listing Hyperdrive configs",
    "┌────┬────┐",
    line(HEAD),
    "├────┼────┤",
    ...rows.map(line),
    "└────┴────┘",
    "",
  ].join("\n");
};

test("the list reader gives only the id and the caching cell of the named configuration", () => {
  const listing = table([
    listRow(ID_B, "another-config", "max_age: 60, stale_while_revalidate: 15"),
    listRow(ID_A, "rosie-staging-hyperdrive", "disabled"),
  ]);
  assert.deepEqual(hyperdriveRow(listing, "rosie-staging-hyperdrive"), { id: ID_A, caching: "disabled" });
  assert.deepEqual(hyperdriveRow(listing, "another-config"), {
    id: ID_B,
    caching: "max_age: 60, stale_while_revalidate: 15",
  });
  assert.equal(hyperdriveRow(listing, "rosie-staging"), null);
  // No table at all: the account has no configuration (what the list printed on Nov 11 2026).
  assert.equal(
    hyperdriveRow(" ⛅️ wrangler 4.158.0\n📋 Listing Hyperdrive configs\n", "rosie-staging-hyperdrive"),
    null,
  );
  // Colour codes around the table, as on a terminal.
  const coloured = listing.replaceAll("│", "\u001b[90m│\u001b[39m");
  assert.deepEqual(hyperdriveRow(coloured, "rosie-staging-hyperdrive"), { id: ID_A, caching: "disabled" });
});

test("the list reader refuses what it cannot read", () => {
  const exitCode = (listing) => {
    try {
      hyperdriveRow(listing, "rosie-staging-hyperdrive");
      return 0;
    } catch (error) {
      return error.exitCode;
    }
  };
  const twice = table([
    listRow(ID_A, "rosie-staging-hyperdrive", "disabled"),
    listRow(ID_B, "rosie-staging-hyperdrive", "disabled"),
  ]);
  assert.equal(exitCode(twice), 3);
  assert.equal(exitCode(table([listRow("not-an-id", "rosie-staging-hyperdrive", "disabled")])), 2);
  assert.equal(exitCode("rosie-staging-hyperdrive exists, in words"), 2);
  assert.equal(exitCode("│ title │ value │\n│ rosie-staging-hyperdrive │ x │\n"), 2);
});

test("a pooled host is told from a direct one, and nothing else passes for a database URL", () => {
  assert.equal(
    hostKind("postgresql://u:p@ep-example-123456.us-east-1.aws.example.test/main?sslmode=require"),
    "direct",
  );
  assert.equal(hostKind("postgres://u:p@ep-example-123456-pooler.us-east-1.aws.example.test/main"), "pooled");
  assert.throws(() => hostKind("https://example.test/"), /not a postgres:\/\/ URL/);
  assert.throws(() => hostKind(""), /not a URL/);
});

test("the spike's wrangler config names staging's Worker and binds only Hyperdrive", () => {
  const remote = spikeConfig({
    main: "/repo/worker.mjs",
    account: "acct",
    mode: "remote",
    id: ID_A,
    localUrl: "x",
  });
  assert.equal(remote.account_id, "acct");
  assert.equal(remote.main, "/repo/worker.mjs");
  assert.deepEqual(remote.env, {
    staging: { name: "rosie-staging", hyperdrive: [{ binding: "HYPERDRIVE", id: ID_A }] },
  });
  assert.notEqual(remote.name, "rosie");
  assert.equal("routes" in remote || "routes" in remote.env.staging, false);
  const local = spikeConfig({
    main: "/repo/worker.mjs",
    account: "acct",
    mode: "local",
    id: "0".repeat(32),
    localUrl: LOCAL_DATABASE_URL,
  });
  assert.equal(local.env.staging.hyperdrive[0].localConnectionString, LOCAL_DATABASE_URL);
  assert.throws(() => spikeConfig({ main: "m", account: "a", mode: "production", id: ID_A, localUrl: "x" }));
});

test("a run passes only when the probe says ok and its schema is dropped", () => {
  assert.equal(passed(JSON.stringify({ ok: true, cleanup: { schema_dropped: true } })), true);
  assert.equal(passed(JSON.stringify({ ok: true, cleanup: { schema_dropped: false } })), false);
  assert.equal(passed(JSON.stringify({ ok: false, cleanup: { schema_dropped: true } })), false);
  assert.equal(passed(JSON.stringify({ ok: true })), false);
  assert.equal(passed("<html>bad gateway</html>"), false);
});

test("the serving version is the one with the most traffic, or nothing when the text does not say", () => {
  const old = "11111111-2222-4333-8444-555555555555";
  const live = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const status = {
    versions: [
      { version_id: old, percentage: 10 },
      { version_id: live, percentage: 90 },
    ],
  };
  assert.equal(liveVersion(` ⛅️ wrangler 4.158.0\n${JSON.stringify(status, null, 2)}\n`), live);
  assert.equal(
    liveVersion(JSON.stringify({ versions: [{ version_id: "not-a-version", percentage: 100 }] })),
    "",
  );
  assert.equal(liveVersion(JSON.stringify({ versions: [] })), "");
  assert.equal(liveVersion("wrangler could not tell"), "");
});

test("percentile is the nearest rank", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => 100 - i);
  assert.equal(percentile(hundred, 50), 50);
  assert.equal(percentile(hundred, 95), 95);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([3, 1, 2], 50), 2);
  assert.equal(percentile([], 50), null);
});

test("summarize gives n, min, p50, p95, max and mean with one decimal", () => {
  const sixty = Array.from({ length: 60 }, (_, i) => i + 1);
  assert.deepEqual(summarize(sixty), { n: 60, min_ms: 1, p50_ms: 30, p95_ms: 57, max_ms: 60, mean_ms: 30.5 });
  assert.deepEqual(summarize([1.26]), {
    n: 1,
    min_ms: 1.3,
    p50_ms: 1.3,
    p95_ms: 1.3,
    max_ms: 1.3,
    mean_ms: 1.3,
  });
  assert.equal(summarize([]).p95_ms, null);
});

test("a run times at least 50 and at most 200 commits per shape", () => {
  assert.equal(clampCommits(1), 50);
  assert.equal(clampCommits("60"), 60);
  assert.equal(clampCommits(100000), 200);
  assert.equal(clampCommits("many"), 60);
});

test("the redactor removes the URL, its password, user and host, encoded or not", () => {
  const url = "postgres://app%2Buser:p%40ss%2Fw0rd@db.example.test:5432/main?sslmode=require";
  const redact = makeRedactor([url]);
  const message = `connect to ${url} failed: role "app+user" at db.example.test with p@ss/w0rd or p%40ss%2Fw0rd`;
  const out = redact(message);
  for (const secret of [url, "p@ss/w0rd", "p%40ss%2Fw0rd", "app+user", "app%2Buser", "db.example.test"]) {
    assert.equal(out.includes(secret), false, `still holds ${secret}`);
  }
  assert.match(out, /\[redacted\]/);
  assert.equal(makeRedactor(["not a url"])("it says not a url here"), "it says [redacted] here");
});

test("a local run refuses a database that is not on this machine, without naming it", () => {
  assert.equal(localDatabaseUrl({}), LOCAL_DATABASE_URL);
  assert.equal(localDatabaseUrl({ DATABASE_URL: "" }), LOCAL_DATABASE_URL);
  const remote = "postgres://someone:secret-word@db.example.test/main";
  assert.throws(
    () => localDatabaseUrl({ DATABASE_URL: remote }),
    (error) => /not on this machine/.test(error.message) && !error.message.includes("secret-word"),
  );
  assert.throws(
    () => localDatabaseUrl({ DATABASE_URL: "secret-word" }),
    /is not a URL \(its value is not shown\)/,
  );
});

test("the Worker refuses every request without the run's token, and an expired probe", async () => {
  assert.equal(refusedBy(request("/probe", TOKEN), {}), "no probe token is configured");
  assert.equal(
    refusedBy(request("/probe", "short"), { PROBE_TOKEN: "short" }),
    "no probe token is configured",
  );
  assert.equal(refusedBy(request("/probe"), { PROBE_TOKEN: TOKEN }), "the probe token is missing or wrong");
  assert.equal(
    refusedBy(request("/probe", `${TOKEN}x`), { PROBE_TOKEN: TOKEN }),
    "the probe token is missing or wrong",
  );
  assert.equal(refusedBy(request("/probe", TOKEN), { PROBE_TOKEN: TOKEN }), null);
  assert.equal(
    refusedBy(request("/probe", TOKEN), { PROBE_TOKEN: TOKEN, PROBE_EXPIRES: "2000" }, 1000),
    null,
  );
  assert.equal(
    refusedBy(request("/probe", TOKEN), { PROBE_TOKEN: TOKEN, PROBE_EXPIRES: "2000" }, 3000),
    "this probe has expired",
  );
  assert.equal(
    refusedBy(request("/probe", TOKEN), { PROBE_TOKEN: TOKEN, PROBE_EXPIRES: "soon" }, 1000),
    "this probe has expired",
  );

  const refused = await worker.fetch(request("/probe"), { PROBE_TOKEN: TOKEN });
  assert.equal(refused.status, 403);
  const ready = await worker.fetch(request("/ready", TOKEN), { PROBE_TOKEN: TOKEN });
  assert.deepEqual(await ready.json(), {
    ready: true,
    probe: "T-1124 hyperdrive-host",
    hyperdrive_bound: false,
  });
  const unbound = await worker.fetch(request("/probe", TOKEN), { PROBE_TOKEN: TOKEN });
  assert.equal(unbound.status, 500);
  assert.deepEqual(await unbound.json(), { ok: false, error: "no HYPERDRIVE binding" });
  const unknown = await worker.fetch(request("/elsewhere", TOKEN), { PROBE_TOKEN: TOKEN });
  assert.equal(unknown.status, 404);
});

test("the probe passes on the local rosie-pg and drops its schema", { timeout: 120_000 }, async () => {
  const result = await runLocal({ commits: 50, env: {} });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.deepEqual(result.failed_steps, []);
  assert.deepEqual(result.extensions.missing, []);
  assert.equal(result.exclude.sqlstate, "23P01");
  assert.equal(result.exclude.overlapping_insert, "refused");
  for (const shape of ["one_statement", "transaction", "transaction_pipelined"]) {
    assert.equal(result.cas[shape].n, 50);
    assert.equal(typeof result.cas[shape].p50_ms, "number");
    assert.equal(typeof result.cas[shape].p95_ms, "number");
  }
  assert.equal(result.cas.stale_version_commit, "changed nothing");
  assert.equal(result.cas.replayed_turn_id, "refused (23505)");
  assert.equal(result.read_after_write.stale_reads, 0);
  assert.equal(result.transaction.backends_inside_transaction, 1);
  assert.equal(result.transaction.row_lock_while_open, "held (55P03)");
  assert.equal(result.transaction.set_local_value_leaked_to_pool, false);
  assert.equal(result.cleanup.schema_dropped, true);
  assert.equal(await schemaCount(), 0);
  // The result never holds the database's address or password.
  assert.equal(JSON.stringify(result).includes("127.0.0.1"), false);
  assert.equal(JSON.stringify(result).includes("rosie:rosie"), false);
});

test("a run that fails part way still drops its schema", { timeout: 120_000 }, async () => {
  let schemaSeenInside = null;
  const result = await runLocal({
    commits: 50,
    env: {},
    inject: async (sql) => {
      const [row] = await sql`select count(*)::int as n from pg_namespace where nspname = ${SCHEMA}`;
      schemaSeenInside = row.n;
      // Break what the later steps need, then fail.
      await sql.unsafe(`drop table ${SCHEMA}.turn, ${SCHEMA}.booking`);
      throw new Error(`injected failure at ${LOCAL_DATABASE_URL}`);
    },
  });
  assert.equal(schemaSeenInside, 1);
  assert.equal(result.ok, false);
  assert.equal(result.injected.ok, false);
  assert.equal(result.injected.error.message.includes("rosie:rosie"), false);
  assert.match(result.injected.error.message, /\[redacted\]/);
  assert.ok(result.failed_steps.includes("exclude"));
  assert.ok(result.failed_steps.includes("cas"));
  assert.equal(result.cleanup.present_before, true);
  assert.equal(result.cleanup.schema_dropped, true);
  assert.equal(await schemaCount(), 0);
});
