// The Worker's database handle and its guard in every call (T-1254; ./db.ts; ADR-014 section 2 and piece 6; the lead's
// notes DL-757 and DL-758), inside the Workers runtime on T-1253's rig (infra/test-rig/files.mjs, key DB) and through
// its pool bindings only (vitest.config.ts): this file's pair, HYPERDRIVE_JOB_DB and HYPERDRIVE_APP_DB, the two Worker
// logins on this file's own database (migrated, bundle v0 active, no seed); ADR-014 section 2's wrong logins, each behind
// HYPERDRIVE_DB_<CASE> on that database (each a rosie_rig_ login in the runtime side's shape plus its case, so the first
// check, session_user, refuses every one too, and each case's own check is read past it); and the pool's own
// HYPERDRIVE_JOB and HYPERDRIVE_APP, which name rosie_rig_none, never made. A test hands the handle an env of its own whose
// HYPERDRIVE_JOB and HYPERDRIVE_APP are pool bindings, or doubles over a pool binding (one that counts the reads of its
// connection string; one with a wrong password, which still reaches PostgreSQL through miniflare's Hyperdrive stand-in;
// one naming a closed port), never a binding of its own making.
//
//   - The guard passes on each right login through this file's pair; each side's client reads as its own login; db/repo's
//     calls run on it unchanged; every call runs the guard, and the binding's string is read at each call.
//   - Each refusal ADR-014 section 2 lists: the superuser; the two bindings crossed; a login that inherits both roles; a
//     member of the other role with INHERIT FALSE; the owner of businesses; a second membership (pg_read_all_data); a
//     schema named after the login; DB_SCHEMA set (no client opened: the counting double read 0 times). After each: the
//     call's code did not run, the row counts of this file's database are unchanged, the refusal carries the side, the
//     binding's name and the checks' labels and nothing else, and opened equals ended.
//   - The guard's own statement failing (the pool's own pair: its database does not exist), a wrong password and a closed
//     port: the call's name and SQLSTATE only; no log line or thrown text holds the host, the user or the password.
//   - Production's environment: no binding read. A call whose own code throws: opened equals ended. The connect and the
//     guard timed as two values. Two calls at once, each holding one side's client while it opens the other's, finish
//     under the cap.
//   - DL-758: the quiet socket's rule against a stand-in for cloudflare:sockets, then every client this file ends through
//     the handle: its read ended quietly, and no unhandled rejection (the closed socket's or any other) reached this
//     isolate, as this isolate's own listener sees it, with or without vitest.config.ts's filter.
// Test values only (rule 9): no row is seeded, and the names below are made up.
import { env } from "cloudflare:workers";
import { DataAccessDatabaseError } from "@rosie/db/repo/clocks";
import { readActiveBundle } from "@rosie/db/repo/bundles";
import { withBusiness, type Sql } from "@rosie/db/repo/scope";
import { transientOrThrow } from "@rosie/db/repo/targets";
import postgres from "postgres";
import { describe, expect, inject, it } from "vitest";

import {
  CONNECTIONS_PER_CLIENT,
  DB_SIDES,
  DbClosedError,
  DbGuardRefusal,
  dbHandle,
  failedChecks,
  guardChecks,
  QuietSocket,
  quietTally,
  type DbCallTiming,
  type DbEnv,
  type DbHandleOptions,
  type DbRefusalLine,
  type DbSide,
  type QuietSocketTarget,
  type RawSocket,
} from "./db";

/** This file's key in the rig's list (infra/test-rig/files.mjs). */
const KEY = "DB";
const JOB = `HYPERDRIVE_JOB_${KEY}`;
const APP = `HYPERDRIVE_APP_${KEY}`;
const wrongBinding = (name: string): string => `HYPERDRIVE_${KEY}_${name}`;

/** The pool's Hyperdrive bindings, by name. */
const pool = env as unknown as Readonly<Record<string, Hyperdrive | undefined>>;

function poolBinding(name: string): Hyperdrive {
  const found = pool[name];
  if (found === undefined) throw new Error(`the pool has no Hyperdrive binding ${name}`);
  return found;
}

const DATABASE = inject("rosieRigDatabases")?.[KEY];

// ---- the isolate's unhandled rejections (DL-758) --------------------------------------------------------------------

/** Every unhandled rejection this isolate reports while this file runs, whatever vitest.config.ts later does with it. */
const rejections: unknown[] = [];
addEventListener("unhandledrejection", (event) => {
  rejections.push(event.reason);
});

const isClosedSocket = (reason: unknown): boolean =>
  reason instanceof Error && reason.message === "This socket has been closed.";

// ---- helpers --------------------------------------------------------------------------------------------------------

/** An env for the handle (staging, DB_SCHEMA empty, unless the fields say otherwise) that records each key read. */
function envOf(fields: Readonly<Record<string, unknown>>): { env: DbEnv; read: string[] } {
  const read: string[] = [];
  const target: Record<string, unknown> = { ENVIRONMENT: "staging", DB_SCHEMA: "", ...fields };
  const proxied = new Proxy(target, {
    get(object, key, receiver): unknown {
      if (typeof key === "string") read.push(key);
      return Reflect.get(object, key, receiver);
    },
  });
  return { env: proxied as unknown as DbEnv, read };
}

/** A double over a pool binding that counts the reads of its connection string (and gives the pool binding's). */
function counted(binding: Hyperdrive): {
  binding: { readonly connectionString: string };
  reads: { n: number };
} {
  const reads = { n: 0 };
  return {
    binding: {
      get connectionString(): string {
        reads.n += 1;
        return binding.connectionString;
      },
    },
    reads,
  };
}

/** A double over a pool binding whose string has another password (it still reaches the stand-in's host). */
function withPassword(binding: Hyperdrive, password: string): { readonly connectionString: string } {
  const url = new URL(binding.connectionString);
  url.password = password;
  return { connectionString: url.href };
}

/** A double over a pool binding whose string names 127.0.0.1 on a port where nothing listens. */
function closedPort(binding: Hyperdrive): { readonly connectionString: string } {
  const url = new URL(binding.connectionString);
  url.hostname = "127.0.0.1";
  url.port = "1";
  return { connectionString: url.href };
}

/** A handle over `handleEnv` whose timings and refusal lines are kept. */
function handleOver(
  handleEnv: DbEnv,
  options: Pick<DbHandleOptions, "now"> = {},
): {
  handle: ReturnType<typeof dbHandle>;
  timings: DbCallTiming[];
  lines: DbRefusalLine[];
} {
  const timings: DbCallTiming[] = [];
  const lines: DbRefusalLine[] = [];
  const handle = dbHandle(handleEnv, {
    ...options,
    timing: (timing) => {
      timings.push(timing);
    },
    log: (line) => {
      lines.push(line);
    },
  });
  return { handle, timings, lines };
}

/** The call's code as a spy: it counts its runs (and would write nothing the row counts miss). */
function spyCall(): { fn: (sql: Sql) => Promise<string>; runs: { n: number } } {
  const runs = { n: 0 };
  return {
    fn: async (sql) => {
      runs.n += 1;
      await sql`select 1`;
      return "ran";
    },
    runs,
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * The exact row count of every table in this file's database, read as the superuser through HYPERDRIVE_DB_SUPERUSER (a
 * pool binding) on a client of its own over the handle's quiet socket, which ends with no rejection left.
 */
async function rowCounts(): Promise<Record<string, number>> {
  const tally = quietTally();
  const sockets: QuietSocket[] = [];
  const options = {
    max: 1,
    connect_timeout: 15,
    onnotice: () => undefined,
    socket: (target: QuietSocketTarget): QuietSocket => {
      const socket = new QuietSocket(target, tally);
      sockets.push(socket);
      return socket;
    },
  };
  const sql = postgres(poolBinding(wrongBinding("SUPERUSER")).connectionString, options);
  try {
    const rows = await sql<{ name: string; n: number }[]>`
      select pg_catalog.format('%I.%I', schemaname, tablename) as name,
             (pg_catalog.xpath('/row/n/text()', pg_catalog.query_to_xml(
               pg_catalog.format('select count(*) as n from %I.%I', schemaname, tablename), false, true, '')))[1]::text::int as n
        from pg_catalog.pg_tables
       where schemaname not in ('pg_catalog', 'information_schema')
       order by 1`;
    return Object.fromEntries(rows.map((row) => [row.name, row.n]));
  } finally {
    await sql.end({ timeout: 5 });
    await Promise.allSettled(sockets.map((socket) => socket.done));
  }
}

/** Whether `text` holds `part` as a whole name (not inside a longer name, such as rosie inside rosie_job). */
function holds(text: string, part: string): boolean {
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "u").test(text);
}

/** Every text holds none of the binding's string, host, user, password or database. */
function expectNothingOf(binding: { readonly connectionString: string }, texts: readonly string[]): void {
  const url = new URL(binding.connectionString);
  const parts = [
    binding.connectionString,
    url.host,
    url.hostname,
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
    decodeURIComponent(url.pathname.slice(1)),
  ].filter((part) => part !== "");
  expect(parts.length).toBeGreaterThanOrEqual(5);
  for (const text of texts) {
    for (const part of parts) {
      expect(holds(text, part), `a text holds a part of the binding's string`).toBe(false);
    }
  }
}

/**
 * The texts an error gives away: its message, its stack but for the frames (code locations, where rosie is the
 * repository's folder, as the superuser's name is rosie), its own fields as JSON, and the error as a string.
 */
function textsOf(error: unknown): string[] {
  if (!(error instanceof Error)) return [String(error)];
  const stack = (error.stack ?? "")
    .split("\n")
    .filter((line) => !/^\s+at\s/u.test(line))
    .join("\n");
  return [error.message, stack, JSON.stringify(error), String(error)];
}

const SIDE_WORDS: Readonly<Record<DbSide, string>> = {
  runtime: "the runtime side",
  toolApi: "the Tool API",
};

const callOn = <T>(
  handle: ReturnType<typeof dbHandle>,
  side: DbSide,
  call: string,
  fn: (sql: Sql) => Promise<T>,
): Promise<T> => (side === "runtime" ? handle.runtime(call, fn) : handle.toolApi(call, fn));

const R = guardChecks("runtime");
const T = guardChecks("toolApi");
const label = (labels: readonly string[], index: number): string => {
  const found = labels[index];
  if (found === undefined) throw new Error(`no check ${String(index)}`);
  return found;
};

// ---- the guard passes ----------------------------------------------------------------------------------------------

describe("the guard passes on each right login, through this file's pair", () => {
  it("the rig made this file's database", () => {
    expect(DATABASE).toMatch(/^rosie_rig_[0-9a-f]{8}_db$/u);
  });

  it("each side's client reads as its own login, on this file's database, and its timing names that login", async () => {
    const { env: handleEnv } = envOf({ HYPERDRIVE_JOB: poolBinding(JOB), HYPERDRIVE_APP: poolBinding(APP) });
    const { handle, timings, lines } = handleOver(handleEnv);
    // No role set (the session's role setting is none: no SET ROLE, no role startup parameter) and no search path sent
    // (the session's path is the server's default).
    const whoAmI = async (sql: Sql): Promise<unknown> => {
      const [row] = await sql`
        select session_user::text as session_user, current_user::text as current_user,
               current_database()::text as database, current_schema()::text as schema,
               current_setting('role') as role, current_setting('search_path') as search_path`;
      return row;
    };
    const unset = { schema: "public", role: "none", search_path: '"$user", public' };
    expect(await handle.runtime("whoAmI", whoAmI)).toEqual({
      session_user: "rosie_worker_job",
      current_user: "rosie_worker_job",
      database: DATABASE,
      ...unset,
    });
    expect(await handle.toolApi("whoAmI", whoAmI)).toEqual({
      session_user: "rosie_worker_app",
      current_user: "rosie_worker_app",
      database: DATABASE,
      ...unset,
    });
    expect(timings.map(({ call, side, binding, login }) => ({ call, side, binding, login }))).toEqual([
      { call: "whoAmI", side: "runtime", binding: "HYPERDRIVE_JOB", login: "rosie_worker_job" },
      { call: "whoAmI", side: "toolApi", binding: "HYPERDRIVE_APP", login: "rosie_worker_app" },
    ]);
    // DL-757: the login's name, and no other value the guard read.
    for (const timing of timings) {
      expect(Object.keys(timing).sort()).toEqual(["binding", "call", "connect", "guard", "login", "side"]);
    }
    expect(lines).toEqual([]);
    expect(handle.counts()).toEqual({
      opened: 2,
      ended: 2,
      connectionsOpen: 0,
      connectionsPeak: 1,
      quietReads: expect.any(Number) as number,
      quietWrites: 0,
    });
  });

  it("db/repo's calls run on each side's client unchanged: readActiveBundle as the runtime side, withBusiness as the Tool API", async () => {
    const { env: handleEnv } = envOf({ HYPERDRIVE_JOB: poolBinding(JOB), HYPERDRIVE_APP: poolBinding(APP) });
    const { handle } = handleOver(handleEnv);
    // The rig publishes bundle v0, active, in the template every file's database is made from.
    expect(await handle.runtime("readActiveBundle", (sql) => readActiveBundle(sql))).toMatchObject({
      result: "active",
    });
    // No business is seeded: under a business's scope the Tool API sees no row, and the scope is set and checked.
    const seen = await handle.toolApi("withBusiness", (sql) =>
      withBusiness(sql, "t1254-business-x", async (tx) => {
        const [row] = await tx<{ n: number }[]>`select count(*)::int as n from businesses`;
        return row?.n;
      }),
    );
    expect(seen).toBe(0);
    expect(handle.counts()).toMatchObject({ opened: 2, ended: 2, connectionsOpen: 0 });
  });

  it("every call runs the guard, and each binding's connection string is read at each call, never when the handle is made", async () => {
    const job = counted(poolBinding(JOB));
    const app = counted(poolBinding(APP));
    const { env: handleEnv } = envOf({ HYPERDRIVE_JOB: job.binding, HYPERDRIVE_APP: app.binding });
    const { handle, timings } = handleOver(handleEnv);
    expect([job.reads.n, app.reads.n]).toEqual([0, 0]);
    const one = (sql: Sql): Promise<unknown> => sql`select 1`;
    await handle.runtime("first", one);
    expect([job.reads.n, app.reads.n]).toEqual([1, 0]);
    await handle.runtime("second", one);
    await handle.toolApi("third", one);
    expect([job.reads.n, app.reads.n]).toEqual([2, 1]);
    // Never remembered: each call opened its own client and ran the guard on it.
    expect(timings.map((timing) => timing.call)).toEqual(["first", "second", "third"]);
    expect(handle.counts()).toMatchObject({ opened: 3, ended: 3, connectionsOpen: 0 });
  });
});

// ---- the refusals ---------------------------------------------------------------------------------------------------

interface RefusalCase {
  readonly name: string;
  readonly side: DbSide;
  /** The env's two bindings, as pool binding names. */
  readonly job: string;
  readonly app: string;
  /** The binding the side reads in that env. */
  readonly through: string;
  readonly checks: readonly string[];
}

const REFUSALS: readonly RefusalCase[] = [
  {
    name: "the superuser (the connecting login, rosie)",
    side: "runtime",
    job: wrongBinding("SUPERUSER"),
    app: APP,
    through: wrongBinding("SUPERUSER"),
    checks: [label(R, 0), label(R, 1), label(R, 2), label(R, 4), label(R, 5)],
  },
  {
    name: "the two bindings crossed: the runtime side reads the Tool API's login",
    side: "runtime",
    job: APP,
    app: JOB,
    through: APP,
    checks: [label(R, 0), label(R, 1), label(R, 2), label(R, 3), label(R, 4)],
  },
  {
    name: "the two bindings crossed: the Tool API reads the runtime side's login",
    side: "toolApi",
    job: APP,
    app: JOB,
    through: JOB,
    checks: [label(T, 0), label(T, 1), label(T, 2), label(T, 3), label(T, 4)],
  },
  {
    name: "a login that inherits both roles",
    side: "runtime",
    job: wrongBinding("BOTH_ROLES"),
    app: APP,
    through: wrongBinding("BOTH_ROLES"),
    checks: [label(R, 0), label(R, 1), label(R, 2), label(R, 4)],
  },
  {
    name: "a member of the other role with INHERIT FALSE",
    side: "runtime",
    job: wrongBinding("OTHER_ROLE"),
    app: APP,
    through: wrongBinding("OTHER_ROLE"),
    checks: [label(R, 0), label(R, 1), label(R, 2), label(R, 4)],
  },
  {
    name: "a login that owns businesses",
    side: "runtime",
    job: wrongBinding("OWNER"),
    app: APP,
    through: wrongBinding("OWNER"),
    checks: [label(R, 0), label(R, 1), label(R, 5)],
  },
  {
    name: "a login with a second membership (pg_read_all_data)",
    side: "runtime",
    job: wrongBinding("SECOND_MEMBERSHIP"),
    app: APP,
    through: wrongBinding("SECOND_MEMBERSHIP"),
    checks: [label(R, 0), label(R, 1), label(R, 2)],
  },
  {
    name: "a schema named after the login, so current_schema() is not public",
    side: "runtime",
    job: wrongBinding("LOGIN_SCHEMA"),
    app: APP,
    through: wrongBinding("LOGIN_SCHEMA"),
    checks: [label(R, 0), label(R, 1), label(R, 6)],
  },
];

describe("each refusal of ADR-014 section 2, through the rig's pool bindings", () => {
  for (const refusalCase of REFUSALS) {
    it(`${refusalCase.name}: refused by its checks; the code did not run, no row changed, opened equals ended`, async () => {
      const { side, checks } = refusalCase;
      const { binding } = DB_SIDES[side];
      const before = await rowCounts();
      const { env: handleEnv } = envOf({
        HYPERDRIVE_JOB: poolBinding(refusalCase.job),
        HYPERDRIVE_APP: poolBinding(refusalCase.app),
      });
      const { handle, timings, lines } = handleOver(handleEnv);
      const spy = spyCall();

      const refusal = await rejectionOf(callOn(handle, side, "guardedCall", spy.fn));

      expect(refusal).toBeInstanceOf(DbGuardRefusal);
      if (!(refusal instanceof DbGuardRefusal)) return;
      // The side, the binding's name and the failed checks' labels, in the table's order, and nothing else.
      expect({ side: refusal.side, binding: refusal.binding, checks: refusal.checks }).toEqual({
        side,
        binding,
        checks,
      });
      expect(refusal.message).toBe(
        `the guard refused ${SIDE_WORDS[side]}'s client from ${binding}: ${checks.join("; ")}`,
      );
      expect(Object.keys(refusal).sort()).toEqual(["binding", "checks", "name", "side"]);
      expect(lines).toEqual([{ level: "error", msg: "dbGuardRefused", side, binding, checks }]);
      expect(Object.keys(lines[0] ?? {}).sort()).toEqual(["binding", "checks", "level", "msg", "side"]);
      expectNothingOf(poolBinding(refusalCase.through), [
        ...textsOf(refusal),
        ...lines.map((line) => JSON.stringify(line)),
      ]);
      // Never transient: db/repo's transientOrThrow throws it as it is.
      expect(thrownBy(() => transientOrThrow(refusal, "guardedCall"))).toBe(refusal);

      expect(spy.runs.n).toBe(0);
      expect(timings).toEqual([]);
      expect(handle.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0 });
      expect(await rowCounts()).toEqual(before);
    });
  }

  it("DB_SCHEMA set (a preview's schema, or any value but empty, public too): no client is opened through either binding (the counting doubles read 0 times), and the call fails closed", async () => {
    const before = await rowCounts();
    for (const schema of ["preview_t1254", "public"]) {
      const job = counted(poolBinding(JOB));
      const app = counted(poolBinding(APP));
      const { env: handleEnv, read } = envOf({
        DB_SCHEMA: schema,
        HYPERDRIVE_JOB: job.binding,
        HYPERDRIVE_APP: app.binding,
      });
      const { handle, timings, lines } = handleOver(handleEnv);
      const spy = spyCall();
      for (const side of ["runtime", "toolApi"] as const) {
        const closed = await rejectionOf(callOn(handle, side, "guardedCall", spy.fn));
        expect(closed).toBeInstanceOf(DbClosedError);
        expect(closed).toMatchObject({
          call: "guardedCall",
          side,
          binding: DB_SIDES[side].binding,
          reason: "dbSchemaSet",
        });
      }
      expect([job.reads.n, app.reads.n]).toEqual([0, 0]);
      expect(read.filter((key) => key.startsWith("HYPERDRIVE"))).toEqual([]);
      expect(spy.runs.n).toBe(0);
      expect([timings, lines]).toEqual([[], []]);
      expect(handle.counts()).toMatchObject({ opened: 0, ended: 0, connectionsOpen: 0 });
    }
    expect(await rowCounts()).toEqual(before);
  });

  it("no binding: the call fails closed, and no binding named HYPERDRIVE is ever read", async () => {
    const legacy = counted(poolBinding(JOB));
    const { env: handleEnv, read } = envOf({ HYPERDRIVE: legacy.binding });
    const { handle } = handleOver(handleEnv);
    const spy = spyCall();
    for (const side of ["runtime", "toolApi"] as const) {
      expect(await rejectionOf(callOn(handle, side, "guardedCall", spy.fn))).toMatchObject({
        name: "DbClosedError",
        reason: "noBinding",
        binding: DB_SIDES[side].binding,
      });
    }
    expect(legacy.reads.n).toBe(0);
    expect(read).not.toContain("HYPERDRIVE");
    expect(read.filter((key) => key.startsWith("HYPERDRIVE"))).toEqual(["HYPERDRIVE_JOB", "HYPERDRIVE_APP"]);
    expect(spy.runs.n).toBe(0);
    expect(handle.counts()).toMatchObject({ opened: 0, ended: 0 });
  });

  it("a missing row, or an answer that cannot be read, fails the checks it cannot show", () => {
    expect(failedChecks(undefined, "runtime")).toEqual(R);
    expect(failedChecks(undefined, "toolApi")).toEqual(T);
    const right = {
      session_user_name: "rosie_worker_job",
      current_user_name: "rosie_worker_job",
      memberships: JSON.stringify([{ role: "rosie_job", inherit: true, set: false, admin: false }]),
      own_usage: true,
      other_member: false,
      row_security: true,
      schema_name: "public",
    };
    expect(failedChecks(right, "runtime")).toEqual([]);
    expect(failedChecks({ ...right, memberships: "not json" }, "runtime")).toEqual([label(R, 2)]);
    expect(failedChecks({ ...right, memberships: null }, "runtime")).toEqual([label(R, 2)]);
    expect(
      failedChecks(
        {
          ...right,
          memberships: JSON.stringify([{ role: "rosie_job", inherit: true, set: true, admin: false }]),
        },
        "runtime",
      ),
    ).toEqual([label(R, 2)]);
    expect(failedChecks({ ...right, own_usage: null, row_security: "t" }, "runtime")).toEqual([
      label(R, 3),
      label(R, 5),
    ]);
  });
});

// ---- errors through the handle (critic_collisions B7) ---------------------------------------------------------------

describe("a failure of the connect or of the guard's own statement: the call's name and SQLSTATE only", () => {
  const cases = [
    {
      name: "the pool's own HYPERDRIVE_JOB (its database, rosie_rig_none, does not exist)",
      side: "runtime",
      code: "3D000",
    },
    {
      name: "the pool's own HYPERDRIVE_APP (its database, rosie_rig_none, does not exist)",
      side: "toolApi",
      code: "3D000",
    },
  ] as const;
  for (const failureCase of cases) {
    it(`${failureCase.name}: ${failureCase.code}, the code not run, no host, user or password anywhere`, async () => {
      const own = poolBinding(DB_SIDES[failureCase.side].binding);
      const { env: handleEnv } = envOf({
        HYPERDRIVE_JOB: poolBinding("HYPERDRIVE_JOB"),
        HYPERDRIVE_APP: poolBinding("HYPERDRIVE_APP"),
      });
      const { handle, timings, lines } = handleOver(handleEnv);
      const spy = spyCall();
      const thrown = await rejectionOf(callOn(handle, failureCase.side, "guardedCall", spy.fn));
      expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
      expect(thrown).toMatchObject({
        call: "guardedCall",
        code: failureCase.code,
        table: null,
        constraint: null,
      });
      expect((thrown as Error).message).toBe(
        `guardedCall: the database refused the call (SQLSTATE ${failureCase.code})`,
      );
      expectNothingOf(own, textsOf(thrown));
      expect(lines).toEqual([]);
      expect(spy.runs.n).toBe(0);
      expect(timings).toEqual([]);
      expect(handle.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0 });
    });
  }

  it("a binding present with a wrong password: 28P01, the code not run, no host, user or either password anywhere", async () => {
    const wrong = withPassword(poolBinding(JOB), "t1254-not-the-password");
    const { env: handleEnv } = envOf({ HYPERDRIVE_JOB: wrong, HYPERDRIVE_APP: poolBinding(APP) });
    const { handle, lines } = handleOver(handleEnv);
    const spy = spyCall();
    const thrown = await rejectionOf(handle.runtime("guardedCall", spy.fn));
    expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
    expect(thrown).toMatchObject({ call: "guardedCall", code: "28P01", table: null, constraint: null });
    expectNothingOf(wrong, textsOf(thrown));
    expectNothingOf(poolBinding(JOB), textsOf(thrown));
    expect([lines, spy.runs.n]).toEqual([[], 0]);
    expect(handle.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0 });
  });

  it("a binding present but unreachable (a closed port): 08001, the code not run, no host, user or password anywhere", async () => {
    const unreachable = closedPort(poolBinding(JOB));
    const { env: handleEnv } = envOf({ HYPERDRIVE_JOB: unreachable, HYPERDRIVE_APP: poolBinding(APP) });
    const { handle, lines } = handleOver(handleEnv);
    const spy = spyCall();
    const thrown = await rejectionOf(handle.runtime("guardedCall", spy.fn));
    expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
    expect(thrown).toMatchObject({ call: "guardedCall", code: "08001", table: null, constraint: null });
    expectNothingOf(unreachable, textsOf(thrown));
    expect([lines, spy.runs.n]).toEqual([[], 0]);
    expect(handle.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0 });
  });
});

// ---- production, a throwing call, time, and two calls at once -------------------------------------------------------

describe("production, a call that throws, the time of the connect and the guard, and the cap", () => {
  it("in production's environment the handle reads no binding (the counting doubles: 0 reads)", async () => {
    const job = counted(poolBinding(JOB));
    const app = counted(poolBinding(APP));
    const { env: handleEnv, read } = envOf({
      ENVIRONMENT: "production",
      HYPERDRIVE_JOB: job.binding,
      HYPERDRIVE_APP: app.binding,
    });
    const { handle } = handleOver(handleEnv);
    const spy = spyCall();
    for (const side of ["runtime", "toolApi"] as const) {
      expect(await rejectionOf(callOn(handle, side, "guardedCall", spy.fn))).toMatchObject({
        name: "DbClosedError",
        reason: "notStaging",
        side,
      });
    }
    expect([job.reads.n, app.reads.n]).toEqual([0, 0]);
    expect(read.filter((key) => key.startsWith("HYPERDRIVE"))).toEqual([]);
    expect(spy.runs.n).toBe(0);
    expect(handle.counts()).toMatchObject({ opened: 0, ended: 0 });
  });

  it("opened equals ended after a call whose own code throws, inside a transaction or not, and its own error leaves as it is", async () => {
    const { env: handleEnv } = envOf({ HYPERDRIVE_JOB: poolBinding(JOB), HYPERDRIVE_APP: poolBinding(APP) });
    const { handle } = handleOver(handleEnv);
    const own = new Error("the call's own failure");
    expect(
      await rejectionOf(
        handle.runtime("throwing", async (sql) => {
          await sql`select 1`;
          throw own;
        }),
      ),
    ).toBe(own);
    expect(
      await rejectionOf(
        handle.toolApi("throwingInTransaction", (sql) =>
          sql.begin(async (tx) => {
            await tx`select 1`;
            throw own;
          }),
        ),
      ),
    ).toBe(own);
    expect(handle.counts()).toMatchObject({ opened: 2, ended: 2, connectionsOpen: 0 });
  });

  it("the connect and the guard are timed apart, as two values, each as the trace writers time a hop", async () => {
    // Four reads of the clock in order: the connect's start and end, then the guard's start and end.
    const ticks = [1_000, 1_096, 1_100, 1_119];
    const { env: handleEnv } = envOf({ HYPERDRIVE_JOB: poolBinding(JOB), HYPERDRIVE_APP: poolBinding(APP) });
    const fake = handleOver(handleEnv, { now: () => ticks.shift() ?? 9_999 });
    await fake.handle.runtime("timed", (sql) => sql`select 1`);
    expect(ticks).toEqual([]);
    expect(fake.timings.map(({ connect, guard }) => ({ connect, guard }))).toEqual([
      {
        connect: { at: new Date(1_000).toISOString(), ms: 96 },
        guard: { at: new Date(1_100).toISOString(), ms: 19 },
      },
    ]);

    // On the Workers clock: whole milliseconds, the guard after the connect.
    const real = handleOver(handleEnv);
    await real.handle.toolApi("timed", (sql) => sql`select 1`);
    const [timing] = real.timings;
    expect(timing).toBeDefined();
    if (timing === undefined) return;
    for (const step of [timing.connect, timing.guard]) {
      expect(Number.isInteger(step.ms) && step.ms >= 0).toBe(true);
      expect(new Date(step.at).toISOString()).toBe(step.at);
    }
    expect(Date.parse(timing.guard.at)).toBeGreaterThanOrEqual(
      Date.parse(timing.connect.at) + timing.connect.ms,
    );
  });

  it("each client holds at most CONNECTIONS_PER_CLIENT connections, statements sent at once included", async () => {
    expect(CONNECTIONS_PER_CLIENT).toBe(1);
    const { env: handleEnv } = envOf({ HYPERDRIVE_JOB: poolBinding(JOB), HYPERDRIVE_APP: poolBinding(APP) });
    const { handle } = handleOver(handleEnv);
    const pids = await handle.runtime("atOnce", (sql) =>
      Promise.all(
        [1, 2, 3].map(async () => {
          const [row] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid, pg_sleep(0.02)`;
          return row?.pid;
        }),
      ),
    );
    expect(new Set(pids).size).toBe(1);
    expect(handle.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0, connectionsPeak: 1 });
  });

  it("two calls at once, each holding one side's client while it opens the other's, finish under the cap (no deadlock)", async () => {
    const { env: handleEnv } = envOf({ HYPERDRIVE_JOB: poolBinding(JOB), HYPERDRIVE_APP: poolBinding(APP) });
    const { handle } = handleOver(handleEnv);
    // Each inner call waits until both are in, so all four clients are open at once.
    let arrived = 0;
    let bothIn: () => void = () => undefined;
    const allIn = new Promise<void>((resolve) => {
      bothIn = resolve;
    });
    const meet = async (): Promise<void> => {
      arrived += 1;
      if (arrived === 2) bothIn();
      await allIn;
    };
    const login = async (sql: Sql): Promise<string | undefined> => {
      await meet();
      const [row] = await sql<{ login: string }[]>`select current_user::text as login`;
      return row?.login;
    };
    const answers = await Promise.all([
      // A gate's shape: the Tool API's transaction held while a runtime-side call opens its client.
      handle.toolApi("gate", (app) =>
        app.begin(async (tx) => {
          await tx`select 1`;
          return handle.runtime("commitTurn", login);
        }),
      ),
      // The other way round: a runtime-side transaction held while a Tool API call opens its client.
      handle.runtime("sweep", (job) =>
        job.begin(async (tx) => {
          await tx`select 1`;
          return handle.toolApi("readScope", login);
        }),
      ),
    ]);
    expect(answers).toEqual(["rosie_worker_job", "rosie_worker_app"]);
    expect(handle.counts()).toMatchObject({
      opened: 4,
      ended: 4,
      connectionsOpen: 0,
      connectionsPeak: 4 * CONNECTIONS_PER_CLIENT,
    });
  });
});

// ---- the quiet socket (DL-758) --------------------------------------------------------------------------------------

interface StandIn extends RawSocket {
  readonly written: Uint8Array[];
  readonly closes: { n: number };
  push(bytes: Uint8Array): void;
  failRead(error: unknown): void;
  failClosed(error: unknown): void;
  failWrites(error: unknown): void;
}

/**
 * A stand-in for a cloudflare:sockets Socket: its close ends the pending read with workerd's "This socket has been
 * closed." and resolves `closed`, as the real socket does once postgres.js ends a client.
 */
function standIn(): StandIn {
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  let resolveClosed: () => void = () => undefined;
  let rejectClosed: (error: unknown) => void = () => undefined;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  const written: Uint8Array[] = [];
  const closes = { n: 0 };
  const writeFailure: { error?: unknown } = {};
  return {
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk: Uint8Array) {
        if ("error" in writeFailure) throw writeFailure.error;
        written.push(chunk);
      },
    }),
    closed,
    close: () => {
      closes.n += 1;
      source?.error(new TypeError("This socket has been closed."));
      resolveClosed();
      return closed;
    },
    written,
    closes,
    push: (bytes) => {
      source?.enqueue(bytes);
    },
    failRead: (error) => {
      source?.error(error);
    },
    failClosed: (error) => {
      rejectClosed(error);
    },
    failWrites: (error) => {
      writeFailure.error = error;
    },
  };
}

const TARGET: QuietSocketTarget = { host: ["t1254.invalid"], port: [5432], ssl: false, path: false };

/** A quiet socket over a stand-in, with the events it emits kept in order. */
function quietOver(raw: StandIn): {
  socket: QuietSocket;
  tally: ReturnType<typeof quietTally>;
  events: unknown[];
} {
  const tally = quietTally();
  const socket = new QuietSocket(TARGET, tally, () => raw);
  const events: unknown[] = [];
  socket.on("data", (data: Uint8Array) => events.push(["data", [...data]]));
  socket.on("error", (error: unknown) => events.push(["error", error]));
  socket.on("close", () => events.push("close"));
  return { socket, tally, events };
}

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe("the quiet socket (DL-758): one read ends quietly, every other failure reaches postgres.js", () => {
  it("its read, failing once postgres.js has ended it, ends quietly: no error, one close, counted", async () => {
    const raw = standIn();
    const { socket, tally, events } = quietOver(raw);
    raw.push(new Uint8Array([1, 2, 3]));
    await tick();
    expect(socket.readyState).toBe("open");
    socket.end(new Uint8Array([88, 0, 0, 0, 4]));
    await socket.done;
    await raw.closed;
    await tick();
    expect(events).toEqual([["data", [1, 2, 3]], "close"]);
    expect(raw.written.map((chunk) => [...chunk])).toEqual([[88, 0, 0, 0, 4]]);
    expect(raw.closes.n).toBe(1);
    expect(socket.readyState).toBe("closed");
    expect(tally).toEqual({ opened: 1, closed: 1, peak: 1, quietReads: 1, quietWrites: 0 });
  });

  it("a read that fails while the socket is open reaches postgres.js: error, then close", async () => {
    const raw = standIn();
    const { socket, tally, events } = quietOver(raw);
    const lost = new Error("Network connection lost.");
    raw.failRead(lost);
    await socket.done;
    expect(events).toEqual([["error", lost], "close"]);
    expect(tally.quietReads).toBe(0);
  });

  it("the socket's closed promise rejecting while it is open reaches postgres.js: error, then close", async () => {
    const raw = standIn();
    const { socket, tally, events } = quietOver(raw);
    const reset = new Error("Connection reset.");
    raw.failClosed(reset);
    await tick();
    expect(events).toEqual([["error", reset], "close"]);
    socket.destroy();
    await socket.done;
    expect(events).toEqual([["error", reset], "close"]);
    expect(socket.destroyed).toBe(true);
    expect(tally).toMatchObject({ closed: 1, quietReads: 1 });
  });

  it("a write that fails while the socket is open reaches postgres.js: error, then close", async () => {
    const raw = standIn();
    const { socket, tally, events } = quietOver(raw);
    const refused = new Error("the write was refused");
    raw.failWrites(refused);
    expect(socket.write(new Uint8Array([1]))).toBe(true);
    await tick();
    expect(events).toEqual([["error", refused], "close"]);
    expect(tally.quietWrites).toBe(0);
    socket.destroy();
    await socket.done;
  });

  it("a write that fails once the socket has closed ends quietly, counted: postgres.js has no listener left to reach", async () => {
    const raw = standIn();
    const { socket, tally, events } = quietOver(raw);
    // As postgres.js does at the close (node_modules/postgres/cf/src/connection.js closed()).
    socket.on("close", () => {
      socket.removeAllListeners();
    });
    const lost = new Error("Network connection lost.");
    raw.failRead(lost);
    await socket.done;
    // A connect that never opened: postgres.js's startup was written before the close and fails after it.
    raw.failWrites(new Error("the write was refused"));
    socket.write(new Uint8Array([1]));
    await tick();
    expect(events).toEqual([["error", lost], "close"]);
    expect(tally).toMatchObject({ quietReads: 0, quietWrites: 1 });
  });

  it("it takes one host and one port, with no TLS and no Unix socket, before it opens anything", () => {
    const opens = { n: 0 };
    const open = (): RawSocket => {
      opens.n += 1;
      return standIn();
    };
    for (const target of [
      { host: ["a.invalid", "b.invalid"], port: [5432, 5432] },
      { host: [], port: [] },
      { host: ["a.invalid"], port: [5432], ssl: "require" },
      { host: ["a.invalid"], port: [5432], ssl: true },
      { host: ["a.invalid"], port: [5432], path: "/tmp/.s.PGSQL.5432" },
    ]) {
      expect(thrownBy(() => new QuietSocket(target, quietTally(), open))).toBeInstanceOf(Error);
    }
    expect(opens.n).toBe(0);
  });

  it("every client this file ended through the handle ended its read quietly, and no closed-socket rejection reached this isolate", async () => {
    const { env: handleEnv } = envOf({ HYPERDRIVE_JOB: poolBinding(JOB), HYPERDRIVE_APP: poolBinding(APP) });
    const { handle } = handleOver(handleEnv);
    for (let i = 0; i < 3; i += 1) {
      await handle.runtime("ended", (sql) => sql`select 1`);
      await handle.toolApi("ended", (sql) => sql`select 1`);
    }
    await tick();
    expect(handle.counts()).toMatchObject({ opened: 6, ended: 6, connectionsOpen: 0 });
    expect(handle.counts().quietReads).toBeGreaterThanOrEqual(1);
    // The listener sees what Vitest is handed (checked once by hand: with the write rule off, it held the closed port's
    // "proxy request failed" rejection), so an empty list here is no rejection at all, with the filter or without it.
    expect(rejections.filter(isClosedSocket)).toEqual([]);
    expect(rejections.map((reason) => String(reason))).toEqual([]);
  });
});
