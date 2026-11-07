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
  /** `select 1` on a handle: `{ ok: true }`, or `{ ok: false }` after one redacted log entry. Never throws. */
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

/** Removes each connection string, and its user and password, from `text`. */
export function redact(text: string, urls: readonly string[]): string {
  let out = text;
  for (const url of urls) {
    const secrets = [url];
    try {
      const parsed = new URL(url);
      for (const part of [parsed.password, decodeURIComponent(parsed.password), parsed.username]) {
        if (part !== "") {
          secrets.push(part);
        }
      }
    } catch {
      // Not a parsable URL: the whole string is still removed.
    }
    for (const secret of secrets) {
      out = out.split(secret).join("[redacted]");
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
  const urls = replicaUrl === undefined ? [primaryUrl] : [primaryUrl, replicaUrl];
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
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: unknown }).code;
        log({
          event: "db.ping_failed",
          handle,
          ...(typeof code === "string" ? { code } : {}),
          message: redact(message, urls),
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
