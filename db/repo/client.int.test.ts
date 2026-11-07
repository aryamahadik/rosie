// T-180: the database client, the business scope and the test-database helper, against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/client`).
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
