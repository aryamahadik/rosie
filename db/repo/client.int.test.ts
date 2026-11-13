// T-180: the database client, the business scope and the test-database helper, against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/client`).
import net from "node:net";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type DbClient, type LogEntry, redact, resolvePrimaryUrl } from "./client";
import { readBusinessScope, setBusinessScope, withBusiness } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

// Made-up ids in the shape of fixture set v1's demo shops; never a real business.
const LEES_BARBERSHOP = "biz-lees-barbershop";
const SUNRISE_YOGA = "biz-sunrise-yoga";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase({ name: "client" });
});

afterAll(async () => {
  await db.drop();
});

describe("withBusiness", () => {
  it("sets the scope inside its transaction and returns what the callback returns", async () => {
    const seen = await db.client.withBusiness(LEES_BARBERSHOP, async (tx) => {
      return { scope: await readBusinessScope(tx), again: await readBusinessScope(tx) };
    });
    expect(seen).toEqual({ scope: LEES_BARBERSHOP, again: LEES_BARBERSHOP });
  });

  it("is also exported for a caller that holds a bare handle", async () => {
    expect(await withBusiness(db.sql, SUNRISE_YOGA, readBusinessScope)).toBe(SUNRISE_YOGA);
    expect(await readBusinessScope(db.sql)).toBeNull();
  });

  it("leaves no scope after commit, even on the one connection the pool reuses", async () => {
    const single = createClient({ primaryUrl: resolvePrimaryUrl(), schema: db.schema, max: 1 });
    try {
      await single.withBusiness(LEES_BARBERSHOP, async (tx) => {
        await tx`select 1`;
      });
      expect(await readBusinessScope(single.primary)).toBeNull();
      // The setting reads '' (not unset) on a connection that once held a scope: both mean "no scope".
      const [raw] = await single.primary<{ value: string | null }[]>`
        select current_setting('rosie.business_id', true) as value
      `;
      expect(raw?.value ?? "").toBe("");
    } finally {
      await single.close();
    }
  });

  it("leaves no scope after a rollback", async () => {
    const single = createClient({ primaryUrl: resolvePrimaryUrl(), schema: db.schema, max: 1 });
    try {
      await expect(
        single.withBusiness(SUNRISE_YOGA, async (tx) => {
          expect(await readBusinessScope(tx)).toBe(SUNRISE_YOGA);
          throw new Error("callback failed");
        }),
      ).rejects.toThrow("callback failed");
      expect(await readBusinessScope(single.primary)).toBeNull();
    } finally {
      await single.close();
    }
  });

  it("keeps each transaction's own scope when many run at once", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `biz-demo-${String(i)}`);
    const seen = await Promise.all(
      ids.map((id) =>
        db.client.withBusiness(id, async (tx) => {
          await tx`select pg_sleep(0.01)`;
          return readBusinessScope(tx);
        }),
      ),
    );
    expect(seen).toEqual(ids);
    expect(await readBusinessScope(db.sql)).toBeNull();
  });

  it("lets a transaction change its scope for each write (the per write scope)", async () => {
    const seen = await db.sql.begin(async (tx) => {
      const before = await readBusinessScope(tx);
      await setBusinessScope(tx, LEES_BARBERSHOP);
      const first = await readBusinessScope(tx);
      await setBusinessScope(tx, SUNRISE_YOGA);
      return [before, first, await readBusinessScope(tx)];
    });
    expect(seen).toEqual([null, LEES_BARBERSHOP, SUNRISE_YOGA]);
    expect(await readBusinessScope(db.sql)).toBeNull();
  });

  it("refuses an empty business id before it opens a transaction", async () => {
    const callback = vi.fn(() => Promise.resolve());
    await expect(db.client.withBusiness("", callback)).rejects.toThrow(TypeError);
    await expect(db.client.withBusiness("   ", callback)).rejects.toThrow(TypeError);
    expect(callback).not.toHaveBeenCalled();
  });

  it("writes made under a scope are committed with the transaction and rolled back with it", async () => {
    await db.sql`create table scope_probe (id int primary key, business text not null)`;
    await db.client.withBusiness(LEES_BARBERSHOP, async (tx) => {
      await tx`insert into scope_probe (id, business) values (1, current_setting('rosie.business_id'))`;
    });
    await expect(
      db.client.withBusiness(SUNRISE_YOGA, async (tx) => {
        await tx`insert into scope_probe (id, business) values (2, current_setting('rosie.business_id'))`;
        throw new Error("undo");
      }),
    ).rejects.toThrow("undo");
    const rows = await db.sql<
      { id: number; business: string }[]
    >`select id, business from scope_probe order by id`;
    expect(rows).toEqual([{ id: 1, business: LEES_BARBERSHOP }]);
  });
});

describe("primary and replica handles", () => {
  it("uses the primary handle for both when no replica URL is given", () => {
    expect(db.client.replicaIsPrimary).toBe(true);
    expect(db.client.replica).toBe(db.client.primary);
  });

  it("opens a separate replica handle when a replica URL is given, read only for a scoped transaction", async () => {
    const both = createClient({
      primaryUrl: resolvePrimaryUrl(),
      replicaUrl: resolvePrimaryUrl(),
      schema: db.schema,
    });
    try {
      expect(both.replicaIsPrimary).toBe(false);
      expect(both.replica).not.toBe(both.primary);
      expect(await both.ping("primary")).toEqual({ ok: true });
      expect(await both.ping("replica")).toEqual({ ok: true });

      const scope = await both.withBusiness(LEES_BARBERSHOP, readBusinessScope, { on: "replica" });
      expect(scope).toBe(LEES_BARBERSHOP);

      await expect(
        both.withBusiness(
          LEES_BARBERSHOP,
          async (tx) => {
            await tx`create table replica_write_probe (id int)`;
          },
          { on: "replica" },
        ),
      ).rejects.toMatchObject({ code: "25006" });
      // The same write on the primary handle is allowed.
      await both.withBusiness(LEES_BARBERSHOP, async (tx) => {
        await tx`create table replica_write_probe (id int)`;
      });
    } finally {
      await both.close();
    }
  });

  it("reads DATABASE_REPLICA_URL from the environment it is given", async () => {
    const viaEnv = createClient({
      env: {
        DATABASE_URL: resolvePrimaryUrl(),
        DATABASE_REPLICA_URL: resolvePrimaryUrl(),
        DB_SCHEMA: db.schema,
      },
    });
    try {
      expect(viaEnv.replicaIsPrimary).toBe(false);
      const [row] = await viaEnv.primary<{ schema: string }[]>`select current_schema() as schema`;
      expect(row?.schema).toBe(db.schema);
    } finally {
      await viaEnv.close();
    }
  });

  it("never reads the local default when CI is set without DATABASE_URL", () => {
    expect(() => resolvePrimaryUrl({ env: { CI: "true" } })).toThrow("DATABASE_URL is not set");
    expect(resolvePrimaryUrl({ env: { CI: "true", DATABASE_URL: "postgres://x:y@h/db" } })).toBe(
      "postgres://x:y@h/db",
    );
  });

  it("refuses a schema name that is not a plain lower-case name", () => {
    expect(() => createClient({ primaryUrl: resolvePrimaryUrl(), schema: 'x"; drop schema public' })).toThrow(
      "DB_SCHEMA",
    );
  });
});

describe("test-database helper", () => {
  it("creates a migrated schema and drops it", async () => {
    const admin = createClient({ primaryUrl: resolvePrimaryUrl(), schema: "public" });
    const schemaCount = async (schema: string): Promise<number> => {
      const [row] = await admin.primary<{ n: string }[]>`
        select count(*) as n from information_schema.schemata where schema_name = ${schema}
      `;
      return Number(row?.n);
    };
    try {
      const own = await createTestDatabase({ name: "create-and-drop" });
      expect(own.schema).toMatch(/^t_create_and_drop_[0-9a-f]{8}$/);
      try {
        expect(await schemaCount(own.schema)).toBe(1);
        const [migrated] = await own.sql<
          { version: string }[]
        >`select version from schema_migrations order by version`;
        expect(migrated?.version).toBe("0001");
        const [schema] = await own.sql<{ schema: string }[]>`select current_schema() as schema`;
        expect(schema?.schema).toBe(own.schema);
      } finally {
        await own.drop();
      }
      expect(await schemaCount(own.schema)).toBe(0);
      await own.drop();
    } finally {
      await admin.close();
    }
  });

  it("gives each caller its own schema, so parallel files never see each other's rows", async () => {
    const [a, b] = await Promise.all([
      createTestDatabase({ name: "parallel" }),
      createTestDatabase({ name: "parallel" }),
    ]);
    try {
      expect(a.schema).not.toBe(b.schema);
      // The same table name and the same key in both: neither insert collides, neither sees the other's row.
      await Promise.all([
        a.sql`create table people (id int primary key, name text not null)`,
        b.sql`create table people (id int primary key, name text not null)`,
      ]);
      await Promise.all([
        a.sql`insert into people (id, name) values (1, 'Alex M.')`,
        b.sql`insert into people (id, name) values (1, 'Riley')`,
      ]);
      await b.sql`insert into people (id, name) values (2, 'Avery')`;
      const [fromA, fromB] = await Promise.all([
        a.sql<{ id: number; name: string }[]>`select id, name from people order by id`,
        b.sql<{ id: number; name: string }[]>`select id, name from people order by id`,
      ]);
      expect(fromA).toEqual([{ id: 1, name: "Alex M." }]);
      expect(fromB).toEqual([
        { id: 1, name: "Riley" },
        { id: 2, name: "Avery" },
      ]);
    } finally {
      await Promise.all([a.drop(), b.drop()]);
    }
  });

  it("does not touch this file's rows when another schema is dropped", async () => {
    await db.sql`create table survivors (id int primary key)`;
    await db.sql`insert into survivors (id) values (1)`;
    const other = await createTestDatabase({ name: "other" });
    await other.drop();
    const [row] = await db.sql<{ n: string }[]>`select count(*) as n from survivors`;
    expect(Number(row?.n)).toBe(1);
  });
});

describe("the connection string is never logged", () => {
  const LEAK_USER = "leak_user_zq81";
  const LEAK_PASSWORD = "leak-pw-Xk39vTq";
  const LEAK_URL = `postgres://${LEAK_USER}:${LEAK_PASSWORD}@127.0.0.1:1/leak_db`;

  it("keeps the URL, user and password out of every log line and console call", async () => {
    const entries: LogEntry[] = [];
    const consoleCalls: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
      }),
    );
    let failing: DbClient | undefined;
    let loggingToConsole: DbClient | undefined;
    try {
      // A client that cannot connect (nothing listens on port 1), with its own log sink...
      failing = createClient({
        primaryUrl: LEAK_URL,
        replicaUrl: LEAK_URL.replace("leak_db", "leak_replica"),
        connectTimeoutSeconds: 3,
        log: (entry) => entries.push(entry),
      });
      expect(await failing.ping("primary")).toEqual({ ok: false });
      expect(await failing.ping("replica")).toEqual({ ok: false });
      await expect(failing.withBusiness(LEES_BARBERSHOP, readBusinessScope)).rejects.toBeInstanceOf(Error);
      // ... and one that logs through the default sink (console.warn), failing the same way.
      loggingToConsole = createClient({ primaryUrl: LEAK_URL, connectTimeoutSeconds: 3 });
      expect(await loggingToConsole.ping()).toEqual({ ok: false });
      // Normal use of the working client and the helper.
      expect(await db.client.ping()).toEqual({ ok: true });
      await db.client.withBusiness(LEES_BARBERSHOP, readBusinessScope);
    } finally {
      await failing?.close();
      await loggingToConsole?.close();
      for (const spy of spies) {
        spy.mockRestore();
      }
    }

    // Not vacuous: failures were logged, once per failed ping, and the default sink wrote to the console.
    expect(entries.map((entry) => `${entry.event}:${entry.handle}`)).toEqual([
      "db.ping_failed:primary",
      "db.ping_failed:replica",
    ]);
    expect(consoleCalls.some((line) => line.includes("db.ping_failed"))).toBe(true);

    const captured = [...consoleCalls, ...entries.map((entry) => JSON.stringify(entry))].join("\n");
    const localUrl = resolvePrimaryUrl();
    for (const secret of [LEAK_URL, LEAK_USER, LEAK_PASSWORD, localUrl, "rosie:rosie@"]) {
      expect(captured).not.toContain(secret);
    }
  });

  it("redacts a URL, and its user and password, from any text", () => {
    const text = `could not connect to ${LEAK_URL} as ${LEAK_USER} with ${LEAK_PASSWORD}`;
    expect(redact(text, [LEAK_URL])).toBe("could not connect to [redacted] as [redacted] with [redacted]");
  });
});

// ---- T-1314: the ping's log line, and redact's host and port ------------------------------------------------------
//
// Each failure is raised for real on this Mac: a closed port (ECONNREFUSED), a host under .invalid (ENOTFOUND), a server
// that never answers the startup (CONNECT_TIMEOUT), a login the local database refuses (class 28, naming the user), and
// localhost on a closed port, whose error names an address the URL never does. The raw error of each is checked to hold
// what it names, so the check means something; the ping's line holds none of it. Rule 9: the probe's user, password,
// database and hosts are made up here (.invalid names). A check names what leaked, never its value.

describe("T-1314: the ping's log line holds no host, port, user or password", () => {
  const PROBE_USER = "t1314_ping_user";
  const PROBE_PASSWORD = "t1314-ping-password";
  const PROBE_DATABASE = "t1314_ping_db";
  /** RFC 6761: no name under .invalid ever resolves. */
  const UNRESOLVABLE_HOST = "rosie-t1314-ping.invalid";
  /** The port named with the host that never resolves: never dialled. */
  const SOME_PORT = 65125;

  const probeUrl = (host: string, port: number): string =>
    `postgres://${PROBE_USER}:${PROBE_PASSWORD}@${host}:${String(port)}/${PROBE_DATABASE}`;

  type Parts = Readonly<Record<string, string | number>>;

  /** Every text `value` holds, deeply: its own property names and values, enumerable or not (an error's stack too). */
  function textsOf(value: unknown, seen = new Set<object>()): string[] {
    if (typeof value === "string") {
      return [value];
    }
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
      return [String(value)];
    }
    if (typeof value !== "object" || value === null || seen.has(value)) {
      return [];
    }
    seen.add(value);
    const texts: string[] = [];
    for (const key of Object.getOwnPropertyNames(value)) {
      texts.push(key, ...textsOf((value as Record<string, unknown>)[key], seen));
    }
    return texts;
  }

  /** The names of the parts `value` holds anywhere: a text wherever it appears, a number (a port) as a whole number. */
  function leaksOf(value: unknown, parts: Parts): string[] {
    const texts = textsOf(value);
    return Object.entries(parts)
      .filter(([, part]) => {
        const pattern =
          typeof part === "number"
            ? new RegExp(`(^|[^0-9])${String(part)}([^0-9]|$)`)
            : new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        return texts.some((text) => pattern.test(text));
      })
      .map(([name]) => name);
  }

  /** A local port nothing listens on: one the system just handed out and took back. */
  async function closedPort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    return port;
  }

  /** A local server that takes each connection and never answers it, as a host gone silent would. */
  async function silentServer(): Promise<{ port: number; close: () => Promise<void> }> {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    return {
      port: typeof address === "object" && address !== null ? address.port : 0,
      close: () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) {
            socket.destroy();
          }
          server.close(() => {
            resolve();
          });
        }),
    };
  }

  /** The error postgres.js rejects `select 1` with on `url` (it must reject). */
  async function rawFailureOf(url: string, connectTimeoutSeconds: number): Promise<unknown> {
    const sql = postgres(url, { max: 1, connect_timeout: connectTimeoutSeconds, onnotice: () => undefined });
    try {
      await sql`select 1`;
    } catch (error) {
      return error;
    } finally {
      await sql.end({ timeout: 0 });
    }
    throw new Error("select 1 was answered");
  }

  /**
   * The same failure through a client's ping: one line, the handle and the code alone (one of `codes`), holding none of
   * `parts`; the raw error holds each of `holds`, so the check means something.
   */
  async function expectCodeAlone(
    url: string,
    parts: Parts,
    holds: readonly string[],
    codes: readonly string[],
    connectTimeoutSeconds = 3,
  ): Promise<void> {
    const raw = await rawFailureOf(url, connectTimeoutSeconds);
    expect(leaksOf(raw, parts)).toEqual(expect.arrayContaining([...holds]));
    const entries: LogEntry[] = [];
    const client = createClient({
      primaryUrl: url,
      max: 1,
      connectTimeoutSeconds,
      env: {},
      log: (entry) => entries.push(entry),
    });
    try {
      expect(await client.ping()).toEqual({ ok: false });
    } finally {
      await client.close();
    }
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(Object.keys(entry ?? {}).sort()).toEqual(["code", "event", "handle", "message"]);
    expect(codes).toContain(entry?.code);
    expect(entry).toMatchObject({
      event: "db.ping_failed",
      handle: "primary",
      message: `the ping failed (code ${entry?.code ?? ""})`,
    });
    expect(leaksOf(entry, parts)).toEqual([]);
  }

  it("a closed port (ECONNREFUSED): the line holds no host or port", async () => {
    const port = await closedPort();
    const parts = { host: "127.0.0.1", port, user: PROBE_USER, password: PROBE_PASSWORD };
    await expectCodeAlone(probeUrl("127.0.0.1", port), parts, ["host", "port"], ["ECONNREFUSED"]);
  });

  it("an unresolvable .invalid host (ENOTFOUND, or EAI_AGAIN with no resolver): the line holds no host", async () => {
    const parts = { host: UNRESOLVABLE_HOST, port: SOME_PORT, user: PROBE_USER, password: PROBE_PASSWORD };
    await expectCodeAlone(
      probeUrl(UNRESOLVABLE_HOST, SOME_PORT),
      parts,
      ["host"],
      ["ENOTFOUND", "EAI_AGAIN"],
    );
  });

  it("a server that never answers (postgres.js's CONNECT_TIMEOUT, write <host>:<port>): the line holds neither", async () => {
    const server = await silentServer();
    try {
      const parts = { host: "127.0.0.1", port: server.port, user: PROBE_USER, password: PROBE_PASSWORD };
      await expectCodeAlone(
        probeUrl("127.0.0.1", server.port),
        parts,
        ["host", "port"],
        ["CONNECT_TIMEOUT"],
        1,
      );
    } finally {
      await server.close();
    }
  });

  it("a login the local database refuses (class 28, naming the user): the line holds no user", async () => {
    const url = new URL(resolvePrimaryUrl());
    url.username = PROBE_USER;
    url.password = PROBE_PASSWORD;
    const port = url.port === "" ? 5432 : Number(url.port);
    const parts = { host: url.hostname, port, user: PROBE_USER, password: PROBE_PASSWORD };
    await expectCodeAlone(url.toString(), parts, ["user"], ["28P01", "28000"]);
  });

  it("localhost on a closed port: its error names an address the URL never does, and the line holds none of it", async () => {
    const port = await closedPort();
    const url = probeUrl("localhost", port);
    // The address localhost resolved to is in the raw error, and no redaction of the URL could know it.
    expect(leaksOf(await rawFailureOf(url, 3), { ipv4: "127.0.0.1", ipv6: "::1" }).length).toBeGreaterThan(0);
    const parts = {
      host: "localhost",
      ipv4: "127.0.0.1",
      ipv6: "::1",
      port,
      user: PROBE_USER,
      password: PROBE_PASSWORD,
    };
    await expectCodeAlone(url, parts, ["port"], ["ECONNREFUSED"]);
  });

  it("redact takes out the host and the port too, the port only where it stands as a whole number", () => {
    const url = "postgres://t1314_user:t1314%2Fpw@db-t1314.example.invalid:6543/t1314_db";
    const text =
      "connect ECONNREFUSED db-t1314.example.invalid:6543; getaddrinfo ENOTFOUND db-t1314.example.invalid; " +
      "write CONNECT_TIMEOUT on 6543; user t1314_user, password t1314/pw; 16543 and 65430 stay";
    expect(redact(text, [url])).toBe(
      "connect ECONNREFUSED [redacted]; getaddrinfo ENOTFOUND [redacted]; write CONNECT_TIMEOUT on [redacted]; " +
        "user [redacted], password [redacted]; 16543 and 65430 stay",
    );
  });

  it("redact takes out an IPv6 host with and without its brackets", () => {
    const url = "postgres://t1314_v6_user:t1314-v6-pw@[fd00::7]:6544/t1314_db";
    expect(redact("connect ECONNREFUSED fd00::7:6544, then [fd00::7]:6544", [url])).toBe(
      "connect ECONNREFUSED [redacted]:[redacted], then [redacted]",
    );
  });
});
