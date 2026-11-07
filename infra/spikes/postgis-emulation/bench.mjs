// Spike T-1125: timings and a result digest for the local PostGIS database.
// Usage: node infra/spikes/postgis-emulation/bench.mjs   (DATABASE_URL defaults to the local container)
// Works in a throwaway schema and drops it. Prints one JSON line.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? "postgres://rosie:rosie@127.0.0.1:54329/rosie";
const schema = `spike_${process.pid}`;
const ms = (t) => Math.round(Number(process.hrtime.bigint() - t) / 1e6);

const sql = postgres(url, { max: 1, onnotice: () => {} });
const out = { schema };

// 1. migration run in an empty schema
let t = process.hrtime.bigint();
const mig = spawnSync("node", ["infra/scripts/migrate.mjs"], {
  env: { ...process.env, DATABASE_URL: url, DB_SCHEMA: schema },
  encoding: "utf8",
});
out.migrate_ms = ms(t);
out.migrate_exit = mig.status;

await sql.unsafe(`SET search_path TO ${schema}, public`);
await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS postgis`);
await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS btree_gist`);

// 2. GiST EXCLUDE table: 2000 inserts, then 1 overlapping insert that must be refused
await sql.unsafe(`CREATE TABLE res (id serial PRIMARY KEY, worker int NOT NULL, slot tstzrange NOT NULL,
  EXCLUDE USING gist (worker WITH =, slot WITH &&))`);
t = process.hrtime.bigint();
for (let i = 0; i < 2000; i++) {
  const w = i % 20;
  const start = Math.floor(i / 20);
  await sql`INSERT INTO res (worker, slot) VALUES (${w}, tstzrange(
    timestamptz '2026-01-01' + ${start} * interval '1 hour',
    timestamptz '2026-01-01' + ${start + 1} * interval '1 hour', '[)'))`;
}
out.exclude_2000_inserts_ms = ms(t);
t = process.hrtime.bigint();
let refused = "accepted";
try {
  await sql`INSERT INTO res (worker, slot) VALUES (3, tstzrange(timestamptz '2026-01-01 00:30', timestamptz '2026-01-01 01:30'))`;
} catch (e) {
  refused = e.code;
}
out.exclude_refusal_ms = ms(t);

// 3. PostGIS distance query: 20000 points, 50 nearest to a point, 25 queries
await sql.unsafe(`CREATE TABLE pts (id int PRIMARY KEY, g geography(Point,4326))`);
await sql.unsafe(`INSERT INTO pts SELECT i, ST_SetSRID(ST_MakePoint(-74 + (i % 200) * 0.001, 40.6 + (i / 200) * 0.001), 4326)::geography
  FROM generate_series(1, 20000) i`);
await sql.unsafe(`CREATE INDEX pts_g ON pts USING gist (g)`);
t = process.hrtime.bigint();
let digest = createHash("sha256");
for (let q = 0; q < 25; q++) {
  const rows =
    await sql`SELECT id, round(ST_Distance(g, ST_SetSRID(ST_MakePoint(-73.95 + ${q} * 0.001, 40.65), 4326)::geography)::numeric, 2) AS d
    FROM pts ORDER BY g <-> ST_SetSRID(ST_MakePoint(-73.95 + ${q} * 0.001, 40.65), 4326)::geography, id LIMIT 50`;
  digest.update(JSON.stringify(rows));
}
out.distance_25_queries_ms = ms(t);
const count = await sql`SELECT count(*)::int AS n FROM res`;
digest.update(`${count[0].n}|${refused}`);
out.result_digest = digest.digest("hex").slice(0, 16);
out.rows = count[0].n;
out.refusal = refused;

await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
await sql.end();
console.log(JSON.stringify(out));
