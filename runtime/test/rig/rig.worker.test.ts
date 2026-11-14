// The Workers test rig's first tests (T-1253; ADR-014 section 4, "The rig's first tests (piece 5)"), run inside the
// Workers runtime by the workers project, through the pool's own Hyperdrive bindings only (vitest.config.ts): this
// file's pair, HYPERDRIVE_JOB_RIG and HYPERDRIVE_APP_RIG, names its own database, which the rig's globalSetup made from
// the run's migrated template and seeded with ./rig.seed.ts (infra/test-rig/files.mjs, key RIG), as the two Worker
// logins; the pool's own HYPERDRIVE_JOB and HYPERDRIVE_APP name rosie_rig_none, which is never made.
//
//   - Through each binding of the pair: current_user and current_database(), which also shows that the pool's strings,
//     not wrangler.jsonc's (database rosie), are in force.
//   - ADR-014 section 1's premise, on PostgreSQL 17: a policy written `to rosie_app` binds a login that inherits rosie_app.
//     As rosie_worker_app with no business scope, no business's row; with a scope set as withBusiness sets it
//     (db/repo/scope.ts), that business's rows only; a table that spans businesses refused (SQLSTATE 42501). As
//     rosie_worker_job with no scope, every business's rows.
//   - Through the pool's own HYPERDRIVE_JOB (and HYPERDRIVE_APP), the connect fails: code that reads the pool's env
//     fails closed.
// Every postgres.js client the file opens is ended, also when its test fails (opened equals ended, checked last).
import { env } from "cloudflare:workers";
import postgres from "postgres";
import { afterAll, describe, expect, inject, it } from "vitest";

import { withBusiness, type Sql, type Tx } from "../../../db/repo/scope";
import { RIG_BUSINESSES, RIG_PERSONS } from "./rig.seed";

/** This file's key in the rig's list (infra/test-rig/files.mjs). */
const KEY = "RIG";

/** The pool's Hyperdrive bindings, by name: this file's pair and the pool's own. */
const hyperdrives = env as unknown as Readonly<Record<string, Hyperdrive | undefined>>;

function binding(name: string): Hyperdrive {
  const found = hyperdrives[name];
  if (found === undefined) throw new Error(`the pool has no Hyperdrive binding ${name}`);
  return found;
}

const JOB = `HYPERDRIVE_JOB_${KEY}`;
const APP = `HYPERDRIVE_APP_${KEY}`;

let opened = 0;
let ended = 0;

/** Opens a postgres.js client on the binding, as the Worker would, runs `fn` on it, and ends it whatever happens. */
async function through<T>(name: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = postgres(binding(name).connectionString, {
    max: 1,
    connect_timeout: 15,
    onnotice: () => undefined,
  });
  opened += 1;
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
    ended += 1;
  }
}

/** How many rows of each business-scoped table, and which business heads, the client or transaction reads. */
async function counted(
  sql: Sql | Tx,
): Promise<{ businesses: string[]; roles: number; roleBusinesses: string[] }> {
  const heads = await sql<{ id: string }[]>`select id from businesses order by id`;
  const roles = await sql<
    { business_id: string }[]
  >`select business_id from person_roles order by business_id`;
  return {
    businesses: heads.map((row) => row.id),
    roles: roles.length,
    roleBusinesses: [...new Set(roles.map((row) => row.business_id))],
  };
}

const ALL_BUSINESSES = RIG_BUSINESSES.map((business) => business.id);
const ALL_ROLES = RIG_BUSINESSES.reduce((sum, business) => sum + business.people.length, 0);

afterAll(() => {
  expect(ended).toBe(opened);
});

describe("this file's pair: the two Worker logins on the file's own database", () => {
  const database = inject("rosieRigDatabases")?.[KEY];

  it("the rig made this file's database for the run", () => {
    expect(database).toMatch(/^rosie_rig_[0-9a-f]{8}_rig$/);
  });

  for (const [name, login] of [
    [JOB, "rosie_worker_job"],
    [APP, "rosie_worker_app"],
  ] as const) {
    it(`${name}: current_user and session_user are ${login}, on this file's database (the pool's string, not wrangler.jsonc's)`, async () => {
      const [row] = await through(name, (sql) => sql`select current_user, session_user, current_database()`);
      expect(row).toEqual({ current_user: login, session_user: login, current_database: database });
    });
  }

  it("the server is PostgreSQL 17, where the premise is measured", async () => {
    const [row] = await through(
      JOB,
      (sql) => sql<{ version: number }[]>`
      select current_setting('server_version_num')::int as version
    `,
    );
    expect(row?.version).toBeGreaterThanOrEqual(170000);
    expect(row?.version).toBeLessThan(180000);
  });
});

describe("ADR-014 section 1's premise: a policy written to rosie_app binds a login that inherits rosie_app", () => {
  it("as rosie_worker_app with no business scope: no business's row", async () => {
    expect(await through(APP, (sql) => counted(sql))).toEqual({
      businesses: [],
      roles: 0,
      roleBusinesses: [],
    });
  });

  for (const business of RIG_BUSINESSES) {
    it(`as rosie_worker_app with ${business.id}'s scope set as withBusiness sets it: that business's rows only`, async () => {
      const seen = await through(APP, (sql) => withBusiness(sql, business.id, (tx) => counted(tx)));
      expect(seen).toEqual({
        businesses: [business.id],
        roles: business.people.length,
        roleBusinesses: [business.id],
      });
    });
  }

  it("as rosie_worker_app, a table that spans businesses is refused (42501), with a scope and without", async () => {
    await through(APP, async (sql) => {
      await expect(sql`select count(*) from persons`).rejects.toMatchObject({ code: "42501" });
      const [business] = RIG_BUSINESSES;
      await expect(
        withBusiness(sql, business.id, (tx) => tx`select count(*) from persons`),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("as rosie_worker_job with no business scope: every business's rows", async () => {
    const seen = await through(JOB, async (sql) => ({
      ...(await counted(sql)),
      persons: (await sql<{ id: string }[]>`select id from persons order by id`).map((row) => row.id),
    }));
    expect(seen).toEqual({
      businesses: ALL_BUSINESSES,
      roles: ALL_ROLES,
      roleBusinesses: ALL_BUSINESSES,
      persons: [...RIG_PERSONS],
    });
  });
});

describe("the pool's own pair names rosie_rig_none, which is never made", () => {
  for (const [name, login] of [
    ["HYPERDRIVE_JOB", "rosie_worker_job"],
    ["HYPERDRIVE_APP", "rosie_worker_app"],
  ] as const) {
    it(`through the pool's own ${name} the connect fails (3D000), so code that reads the pool's env fails closed`, async () => {
      expect({ user: binding(name).user, database: binding(name).database }).toEqual({
        user: login,
        database: "rosie_rig_none",
      });
      await expect(through(name, (sql) => sql`select 1`)).rejects.toMatchObject({ code: "3D000" });
    });
  }
});
