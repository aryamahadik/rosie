// Spike T-1124: the probe's queries from plain Node, against the local rosie-pg only (npm run db:up).
// Usage: node infra/spikes/hyperdrive-host/local.mjs [commits]
// Reads DATABASE_URL from the environment at run time (default: the local container, which is no secret) and never
// prints it. It refuses any host that is not this machine: the staging database is reached only from a Worker
// through the Hyperdrive binding (run.sh), never from here. Prints the probe's result as JSON; exit 1 when a step
// failed.
import { realpathSync } from "node:fs";
import postgres from "postgres";
import { clampCommits, makeRedactor, runProbe } from "./probe.mjs";

/** The local Docker database of infra/docker-compose.yml: local only, not a secret (db/README.md). */
export const LOCAL_DATABASE_URL = "postgres://rosie:rosie@127.0.0.1:54329/rosie";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The database URL a local run uses; throws, without naming the URL, when it is not on this machine. */
export function localDatabaseUrl(env = process.env) {
  const url =
    env.DATABASE_URL !== undefined && env.DATABASE_URL !== "" ? env.DATABASE_URL : LOCAL_DATABASE_URL;
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a URL (its value is not shown)");
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error("refused: DATABASE_URL is not on this machine; a local run uses only the local rosie-pg");
  }
  return url;
}

/** Runs the probe from Node against the local database. */
export async function runLocal({ commits = 60, inject, env = process.env } = {}) {
  const url = localDatabaseUrl(env);
  const open = (options) =>
    postgres(url, { max: 4, fetch_types: false, connect_timeout: 15, onnotice: () => undefined, ...options });
  return runProbe({ open, redact: makeRedactor([url]), commits: clampCommits(commits), via: "node", inject });
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename) {
  try {
    const result = await runLocal({ commits: process.argv[2] ?? 60 });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(`local.mjs: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
