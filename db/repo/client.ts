// The database client (C-152, C-034; ADR-007: postgres.js, Hyperdrive with caching off for decision reads).
//
// One client has two handles (arch 10 lines 504, 536, 538):
//   primary  every decision and every write, uncached. All of K-05 v1's calls use it.
//   replica  search and reports only. With no replica URL it is the primary handle itself, so a local database and a
//            launch with no replica work unchanged; `replicaIsPrimary` says so.
// In a Worker, pass `primaryUrl` from the Hyperdrive binding whose caching is off for decisions (the release
// engineer's wrangler config); `replicaUrl` may come from a binding that caches. Connection strings are never logged:
// the client names a handle ("primary", "replica"), never an address, and redacts both strings from any message.
import postgres from "postgres";
import { type ScopeHandle, type Sql, type Tx, withBusiness } from "./scope";

/** The local Docker database of infra/docker-compose.yml: local only, not a secret (db/README.md). */
const LOCAL_DATABASE_URL = "postgres://rosie:rosie@127.0.0.1:54329/rosie";
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export interface LogEntry {
  event: "db.ping_failed";
  handle: ScopeHandle;
  code?: string;
  message: string;
}

export interface ClientOptions {
  /** The primary's connection string. Default: DATABASE_URL, else the local database when CI is unset. */
  primaryUrl?: string;
  /** The replica's. Default: DATABASE_REPLICA_URL, else the primary handle is used for both. */
  replicaUrl?: string;
  /** A schema searched first, then public (previews and the test helper). Default: DB_SCHEMA, else none. */
  schema?: string;
  /** Connections per handle. Default 10. */
  max?: number;
  connectTimeoutSeconds?: number;
  /** Where log entries go. Default: one JSON line on console.warn. Entries never hold a connection string. */
  log?: (entry: LogEntry) => void;
  /** Environment to read the defaults from. Default: process.env. */
  env?: Record<string, string | undefined>;
}

export interface DbClient {
  readonly primary: Sql;
  readonly replica: Sql;
  readonly replicaIsPrimary: boolean;
  /**
   * One transaction scoped to `businessId` (row-level security), on the primary unless `on` is "replica" (then
   * read only). The scope lasts only inside the transaction.
   */
  withBusiness<T>(businessId: string, fn: (tx: Tx) => Promise<T>, options?: { on?: ScopeHandle }): Promise<T>;
  /**
   * `select 1` on a handle: `{ ok: true }`, or `{ ok: false }` after one log entry that names the handle and the error's
   * code alone, never its message (T-1314). Never throws.
   */
  ping(handle?: ScopeHandle): Promise<{ ok: boolean }>;
  /** Ends both handles (once, when they are one). */
  close(): Promise<void>;
}

/** The primary's connection string as `createClient` resolves it. Throws when CI is set and DATABASE_URL is not. */
export function resolvePrimaryUrl(options: ClientOptions = {}): string {
  const env = options.env ?? process.env;
  const url = options.primaryUrl ?? env.DATABASE_URL;
  if (url !== undefined && url !== "") {
    return url;
  }
  if (env.CI !== undefined && env.CI !== "") {
    throw new Error("DATABASE_URL is not set (the local default is never used when CI is set)");
  }
  return LOCAL_DATABASE_URL;
}

/**
 * Removes each connection string, and its user, password, host and port, from `text`. The host and port since T-1314,
 * as infra/scripts/db-url.mjs's scrub takes them out: the host with its port, the host name (an IPv6 address with and
 * without its brackets) and the port. The user and password go as written and decoded, each decoded on its own, so one
 * that does not decode still leaves the other's forms to go. Each part goes before any part inside it, and a port only
 * where it stands as a whole number, so the other digits of the text are left alone.
 */
export function redact(text: string, urls: readonly string[]): string {
  const decoded = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  let out = text;
  for (const url of urls) {
    const secrets = [url];
    try {
      const parsed = new URL(url);
      const hostName = parsed.hostname;
      for (const part of [parsed.password, parsed.username]) {
        secrets.push(part, decoded(part));
      }
      secrets.push(parsed.host, hostName, hostName.replace(/^\[|\]$/g, ""), parsed.port);
    } catch {
      // Not a parsable URL: the whole string is still removed.
    }
    const parts = [...new Set(secrets)].filter((part) => part !== "").sort((a, b) => b.length - a.length);
    for (const part of parts) {
      out = /^[0-9]+$/.test(part)
        ? out.replace(new RegExp(`(?<![0-9])${part}(?![0-9])`, "g"), "[redacted]")
        : out.split(part).join("[redacted]");
    }
  }
  return out;
}

function schemaFrom(options: ClientOptions, env: Record<string, string | undefined>): string | undefined {
  const raw = (options.schema ?? env.DB_SCHEMA ?? "").trim();
  if (raw === "" || raw === "public") {
    return undefined;
  }
  if (!SCHEMA_NAME.test(raw)) {
    throw new Error(`DB_SCHEMA "${raw}" is not a plain lower-case SQL name ([a-z_][a-z0-9_]*)`);
  }
  return raw;
}

export function createClient(options: ClientOptions = {}): DbClient {
  const env = options.env ?? process.env;
  const primaryUrl = resolvePrimaryUrl(options);
  const replicaSetting = options.replicaUrl ?? env.DATABASE_REPLICA_URL;
  const replicaUrl = replicaSetting !== undefined && replicaSetting !== "" ? replicaSetting : undefined;
  const schema = schemaFrom(options, env);
  const log =
    options.log ??
    ((entry: LogEntry) => {
      console.warn(JSON.stringify(entry));
    });

  const open = (url: string): Sql =>
    postgres(url, {
      max: options.max ?? 10,
      connect_timeout: options.connectTimeoutSeconds ?? 15,
      onnotice: () => undefined,
      connection: {
        application_name: "rosie",
        ...(schema === undefined ? {} : { search_path: `${schema}, public` }),
      },
    });

  const primary = open(primaryUrl);
  const replica = replicaUrl === undefined ? primary : open(replicaUrl);
  const handles: Record<ScopeHandle, Sql> = { primary, replica };

  return {
    primary,
    replica,
    replicaIsPrimary: replica === primary,
    withBusiness: (businessId, fn, scopeOptions = {}) => {
      const handle = scopeOptions.on ?? "primary";
      return withBusiness(handles[handle], businessId, fn, { readOnly: handle === "replica" });
    },
    ping: async (handle = "primary") => {
      try {
        await handles[handle]`select 1`;
        return { ok: true };
      } catch (error) {
        // The line names the handle and the error's code alone, when it is a plain code (Node's ECONNREFUSED,
        // postgres.js's CONNECT_TIMEOUT, a SQLSTATE such as 28P01), never the error's message or its other fields
        // (T-1314). The message names what no redaction of the URL can know: the address a host name resolved to
        // (connect ECONNREFUSED <address>:<port>), a certificate's names, the client's own address in PostgreSQL's
        // pg_hba refusal, or whatever a Worker's socket says.
        const raw = (error as { code?: unknown } | null | undefined)?.code;
        const code = typeof raw === "string" && /^[A-Z0-9_]{1,64}$/.test(raw) ? raw : undefined;
        log({
          event: "db.ping_failed",
          handle,
          ...(code === undefined ? {} : { code }),
          message: `the ping failed (${code === undefined ? "no code" : `code ${code}`})`,
        });
        return { ok: false };
      }
    },
    close: async () => {
      await Promise.all([
        primary.end({ timeout: 5 }),
        ...(replica === primary ? [] : [replica.end({ timeout: 5 })]),
      ]);
    },
  };
}
