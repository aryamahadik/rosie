// Tests for the Workers test rig's Node parts (T-1253; ADR-014 section 4's piece 5): infra/test-rig/local-url.mjs (the
// one helper for local strings), files.mjs (the named files), rig.mjs (the refusals, the databases it makes and drops,
// the logins, T-1254's wrong logins and the pool's bindings) and how vitest.config.ts runs it. Run by
// `npm run test:ci-scripts` on the local rosie-pg (npm run db:up), or on DATABASE_URL's server in CI, connecting as that
// URL's login, a superuser. The rig's own Workers tests (runtime/test/rig/rig.worker.test.ts) run in the workers project.
//
// The server is shared with other builders' runs, so these tests never make the rig's real none database
// (rosie_rig_none), which would stop every other run: the refusal is shown with startRig's `none` option naming a
// database every server has, and a test pins the default name. Each run here has a run id of its own (t + 8 hex
// digits), so "nothing was made" is "no database starts with rosie_rig_<that id>_"; a run that starts drops its
// databases in the test, pass or fail. The wrong logins of T-1254's file (rosie_rig_*) are cluster-wide and shared by
// every run, as the rig makes them, so they are left made; the plain login the superuser refusal needs is this file's
// own (t1253_<6 hex>_plain) and dropped after.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import postgres from "postgres";

import { RIG_FILES, WRONG_LOGINS } from "../test-rig/files.mjs";
import { localPassword, localString } from "../test-rig/local-url.mjs";
import {
  LOCAL_DATABASE_URL,
  NONE_DATABASE,
  PROVIDED,
  REPO,
  RigRefusal,
  WORKER_LOGINS,
  checkFiles,
  dropRunDatabases,
  poolBindings,
  serverUrl,
  shapeOf,
  startRig,
} from "../test-rig/rig.mjs";

/** The test server: DATABASE_URL, else the local rosie-pg (never when CI is set). */
function testServerUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.CI)
    throw new Error("DATABASE_URL is not set, and with CI set the local database is never used");
  return LOCAL_DATABASE_URL;
}

const SERVER = testServerUrl();
const ENV = { DATABASE_URL: SERVER };
const THIS_FILE = "infra/ci/test-rig.test.mjs";
const NO_SEED = "infra/ci/test-rig.no-such-seed.mjs";
const newRun = () => `t${randomBytes(4).toString("hex")}`;
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

/** Runs fn with console and the process's own output captured; returns what was written. */
function captured(fn) {
  const writes = [];
  const saved = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    out: process.stdout.write,
    err: process.stderr.write,
  };
  const keep = (...args) => {
    writes.push(args.map(String).join(" "));
    return true;
  };
  Object.assign(console, { log: keep, error: keep, warn: keep, info: keep });
  process.stdout.write = keep;
  process.stderr.write = keep;
  try {
    fn();
  } finally {
    Object.assign(console, { log: saved.log, error: saved.error, warn: saved.warn, info: saved.info });
    process.stdout.write = saved.out;
    process.stderr.write = saved.err;
  }
  return writes;
}

describe("local-url.mjs: one DATABASE_URL to a login's local string", () => {
  const CASES = [
    ["postgres://rosie:rosie@127.0.0.1:54329/rosie", "rosie_worker_job", "rosie_rig_ab12cd34_rig"],
    [
      "postgresql://ci:ci-pass@localhost:5432/ci?sslmode=disable&application_name=ci",
      "rosie_worker_app",
      "rosie_rig_none",
    ],
    ["postgres://rosie:rosie@[::1]:6543/rosie", "rosie_rig_owner", "rosie_rig_0f0f0f0f_db"],
    ["postgres://rosie:rosie@localhost/rosie", "rosie_worker_job", "postgres"],
  ];

  for (const [given, login, database] of CASES) {
    it(`keeps the scheme, host, port and query of ${new URL(given).protocol}//${new URL(given).host}; sets the user, password and database`, () => {
      const made = new URL(localString(given, { login, password: localPassword(login), database }));
      const source = new URL(given);
      assert.equal(made.protocol, source.protocol);
      assert.equal(made.hostname, source.hostname);
      assert.equal(made.port, source.port);
      assert.equal(made.search, source.search);
      assert.equal(made.username, login);
      assert.equal(made.password, login, "the local password is the login's own name");
      assert.equal(made.pathname, `/${database}`);
      assert.equal(made.hash, "");
    });
  }

  it("a login's local password is its own name", () => {
    assert.equal(localPassword("rosie_worker_job"), "rosie_worker_job");
  });

  it("writes a password that a URL would misread so that it reads back as given", () => {
    const password = "p@ss:w/rd?x#y%z";
    const made = new URL(localString(SERVER, { login: "someone", password, database: "rosie" }));
    assert.equal(decodeURIComponent(made.password), password);
    assert.equal(made.hostname, new URL(SERVER).hostname, "the host is still the URL's");
  });

  it("prints nothing, and its refusals name no part of the URL", () => {
    const secret = "Zq9vT2Lk4pXw";
    const host = "db-t1253.example.invalid";
    const writes = captured(() => {
      localString(`postgres://rosie:${secret}@127.0.0.1:54329/rosie`, {
        login: "rosie_worker_job",
        password: "rosie_worker_job",
        database: "rosie_rig_none",
      });
      for (const [bad, options] of [
        [`postgres://u:${secret}#x@${host}:5432/db`, { login: "a", password: "a", database: "db" }],
        [`postgres://u:${secret}@${host},other:5432/db`, { login: "a", password: "a", database: "db" }],
        [`postgres://u:${secret}@${host}:5432/db`, { login: "a", password: "a", database: "a/b?c" }],
        [`postgres://u:${secret}@${host}:5432/db`, { login: "", password: "a", database: "db" }],
      ]) {
        assert.throws(
          () => localString(bad, options),
          (error) => !error.message.includes(secret) && !error.message.includes(host),
        );
      }
    });
    assert.deepEqual(writes, []);
  });
});

describe("files.mjs: the named files, up front", () => {
  it("names the rig's own file, T-1254's, and each W5 and W6 part's file at the audit's path, with a seed beside each", () => {
    // order_d017.txt lines 29 to 49: P1a db (T-1254), P1c flags, P2a k05-receipt, P2b k05-turn, P3a models, P3b
    // bundle-safety, P4a tool-api-gate, P4b tool-api-rows, SR state-reads, P6b test-phone (T-1305), P5 send.
    const parts = [
      ["DB", "db"],
      ["FLAGS", "flags"],
      ["K05_RECEIPT", "k05-receipt"],
      ["K05_TURN", "k05-turn"],
      ["MODELS", "models"],
      ["BUNDLE_SAFETY", "bundle-safety"],
      ["TOOL_API_GATE", "tool-api-gate"],
      ["TOOL_API_ROWS", "tool-api-rows"],
      ["STATE_READS", "state-reads"],
      ["TEST_PHONE", "test-phone"],
      ["SEND", "send"],
    ];
    assert.deepEqual(RIG_FILES, [
      { key: "RIG", test: "runtime/test/rig/rig.worker.test.ts", seed: "runtime/test/rig/rig.seed.ts" },
      ...parts.map(([key, name]) => ({
        key,
        test: `runtime/src/wiring/staging/${name}.worker.test.ts`,
        seed: `runtime/src/wiring/staging/${name}.seed.ts`,
      })),
    ]);
    checkFiles();
  });

  it("refuses a key that is not new, plain or free, and a path outside the repository", () => {
    const entry = (key, test = "runtime/test/x.worker.test.ts") => ({
      key,
      test,
      seed: "runtime/test/x.seed.ts",
    });
    const wrong = { key: "A", cases: [] };
    for (const files of [
      [entry("A"), entry("A")],
      [entry("A"), entry("lower")],
      [entry("A"), entry("TEMPLATE")],
      [entry("A"), entry("NONE")],
      [entry("A"), entry("B-C")],
      [entry("A", "../outside.worker.test.ts")],
      [entry("A", "/abs/x.worker.test.ts")],
    ]) {
      assert.throws(() => checkFiles(files, wrong), /the rig's list/);
    }
    assert.throws(() => checkFiles([entry("B")], wrong), /names no file A/);
  });

  it("gives T-1254's file the wrong logins, each named rosie_rig_... but the superuser, which is the connecting login", () => {
    assert.equal(WRONG_LOGINS.key, "DB");
    assert.deepEqual(
      WRONG_LOGINS.cases.map((wrongCase) => [wrongCase.binding, wrongCase.login]),
      [
        ["SUPERUSER", null],
        ["BOTH_ROLES", "rosie_rig_both_roles"],
        ["OTHER_ROLE", "rosie_rig_other_role"],
        ["OWNER", "rosie_rig_owner"],
        ["SECOND_MEMBERSHIP", "rosie_rig_second_membership"],
        ["LOGIN_SCHEMA", "rosie_rig_login_schema"],
      ],
    );
  });
});

describe("rig.mjs: the pool's bindings", () => {
  const url = "postgres://rosie:rosie@127.0.0.1:54329/rosie";
  const parts = (string) => {
    const parsed = new URL(string);
    return {
      user: parsed.username,
      password: parsed.password,
      database: parsed.pathname.slice(1),
      host: parsed.host,
    };
  };

  it("names every binding up front: the pool's own pair, each named file's pair and T-1254's wrong logins", () => {
    const bindings = poolBindings(url, {});
    assert.deepEqual(
      Object.keys(bindings).sort(),
      [
        "HYPERDRIVE_APP",
        "HYPERDRIVE_JOB",
        ...RIG_FILES.flatMap(({ key }) => [`HYPERDRIVE_APP_${key}`, `HYPERDRIVE_JOB_${key}`]),
        ...WRONG_LOGINS.cases.map(({ binding }) => `HYPERDRIVE_DB_${binding}`),
      ].sort(),
    );
    for (const string of Object.values(bindings)) assert.equal(parts(string).host, "127.0.0.1:54329");
  });

  it("puts the pool's own pair and every file with no database on rosie_rig_none, a file's pair on its database", () => {
    const bindings = poolBindings(url, { RIG: "rosie_rig_ab12cd34_rig" });
    assert.equal(NONE_DATABASE, "rosie_rig_none");
    assert.deepEqual(parts(bindings.HYPERDRIVE_JOB), {
      user: "rosie_worker_job",
      password: "rosie_worker_job",
      database: "rosie_rig_none",
      host: "127.0.0.1:54329",
    });
    assert.deepEqual(parts(bindings.HYPERDRIVE_APP).user, "rosie_worker_app");
    assert.equal(parts(bindings.HYPERDRIVE_APP).database, "rosie_rig_none");
    assert.deepEqual(
      [parts(bindings.HYPERDRIVE_JOB_RIG), parts(bindings.HYPERDRIVE_APP_RIG)].map((p) => [
        p.user,
        p.database,
      ]),
      [
        ["rosie_worker_job", "rosie_rig_ab12cd34_rig"],
        ["rosie_worker_app", "rosie_rig_ab12cd34_rig"],
      ],
    );
    assert.equal(parts(bindings.HYPERDRIVE_JOB_SEND).database, "rosie_rig_none");
    assert.equal(parts(bindings.HYPERDRIVE_DB_OWNER).database, "rosie_rig_none");
  });

  it("binds T-1254's wrong logins on its database, the superuser case as the URL's own login", () => {
    const bindings = poolBindings(url, { DB: "rosie_rig_ab12cd34_db" });
    for (const { binding, login } of WRONG_LOGINS.cases) {
      const p = parts(bindings[`HYPERDRIVE_DB_${binding}`]);
      assert.equal(p.database, "rosie_rig_ab12cd34_db", binding);
      assert.deepEqual([p.user, p.password], login === null ? ["rosie", "rosie"] : [login, login], binding);
    }
  });

  it("names what it provides as provided.d.ts types it", () => {
    const types = readFileSync(path.join(REPO, "infra/test-rig/provided.d.ts"), "utf8");
    for (const name of Object.values(PROVIDED)) assert.match(types, new RegExp(`\\b${name}\\?:`));
  });
});

describe("rig.mjs: the refusals, before anything is made", () => {
  let admin;
  const plain = `t1253_${randomBytes(3).toString("hex")}_plain`;

  before(async () => {
    admin = postgres(SERVER, { max: 2, onnotice: () => undefined, connect_timeout: 15 });
    const [me] = await admin`select rolsuper from pg_roles where rolname = current_user`;
    assert.ok(
      me?.rolsuper,
      "the tests' login must be a superuser, as the local and CI containers' first user is",
    );
  });

  after(async () => {
    if (admin === undefined) return;
    try {
      const [left] = await admin`select count(*)::int as n from pg_roles where rolname = ${plain}`;
      if (left?.n > 0) {
        await admin.unsafe(`drop owned by ${quote(plain)}`);
        await admin.unsafe(`drop role ${quote(plain)}`);
      }
    } finally {
      await admin.end({ timeout: 5 });
    }
  });

  /** The databases on the server whose names start with the run's prefix. */
  const madeBy = async (run) =>
    (await admin`select datname from pg_database where starts_with(datname, ${`rosie_rig_${run}_`})`).map(
      (row) => row.datname,
    );

  it("DATABASE_URL, else the local default only when CI is unset", () => {
    assert.equal(
      serverUrl({ DATABASE_URL: "postgres://a:b@localhost:5432/c" }),
      "postgres://a:b@localhost:5432/c",
    );
    assert.equal(serverUrl({}), "postgres://rosie:rosie@127.0.0.1:54329/rosie");
    assert.throws(() => serverUrl({ CI: "true" }), RigRefusal);
  });

  it("a host that is not a loopback name: refused before any connection, naming no part of the URL", async () => {
    let connections = 0;
    const listener = net.createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise((resolve) => listener.listen(0, "0.0.0.0", resolve));
    const { port } = listener.address();
    try {
      for (const host of [
        "0.0.0.0",
        "127.0.0.2",
        "192.0.2.10",
        "[::ffff:127.0.0.1]",
        "db-t1253.example.invalid",
      ]) {
        const run = newRun();
        await assert.rejects(
          startRig({
            env: { DATABASE_URL: `postgres://rosie:Pw9sK2mX7@${host}:${String(port)}/rosie` },
            run,
          }),
          (error) =>
            error instanceof RigRefusal &&
            /host is not a loopback name/.test(error.message) &&
            !error.message.includes(host) &&
            !error.message.includes("Pw9sK2mX7"),
          host,
        );
        assert.deepEqual(await madeBy(run), [], host);
      }
      assert.equal(connections, 0, "a refused run connected");
    } finally {
      await new Promise((resolve) => listener.close(resolve));
    }
  });

  it("a login that is not a superuser, even one that may make databases: refused before anything is made", async () => {
    const password = randomBytes(12).toString("hex");
    await admin.unsafe(`create role ${quote(plain)} login createdb password '${password}'`);
    const url = new URL(SERVER);
    url.username = plain;
    url.password = password;
    const run = newRun();
    await assert.rejects(
      startRig({ env: { DATABASE_URL: url.href }, run }),
      (error) =>
        error instanceof RigRefusal &&
        /login is not one; nothing was made/.test(error.message) &&
        !error.message.includes(password),
    );
    assert.deepEqual(await madeBy(run), []);
    const [owned] = await admin`
      select count(*)::int as n from pg_database d join pg_roles r on r.oid = d.datdba where r.rolname = ${plain}`;
    assert.equal(owned.n, 0, "the plain login owns a database");
  });

  it("the none database present: refused before anything is made (shown on a database every server has)", async () => {
    const run = newRun();
    await assert.rejects(
      startRig({ env: ENV, run, none: "template1" }),
      (error) => error instanceof RigRefusal && /a database named template1 exists/.test(error.message),
    );
    assert.deepEqual(await madeBy(run), []);
  });
});

describe("rig.mjs: what a run makes, and what its teardown drops", () => {
  let admin;
  const started = [];

  before(() => {
    admin = postgres(SERVER, { max: 2, onnotice: () => undefined, connect_timeout: 15 });
  });

  after(async () => {
    for (const rig of started) await rig.stop().catch(() => undefined);
    await admin?.end({ timeout: 5 });
  });

  const databasesOf = async (run) =>
    (
      await admin`select datname from pg_database where starts_with(datname, ${`rosie_rig_${run}_`}) order by 1`
    ).map((row) => row.datname);

  const start = async (options) => {
    const rig = await startRig({ env: ENV, ...options });
    started.push(rig);
    return rig;
  };

  it("two runs at once: each makes a migrated template with bundle v0 and the file's seeded database; each teardown drops only its own", async () => {
    const files = [{ key: "RIG", test: THIS_FILE, seed: THIS_FILE }];
    const seeded = [];
    const importSeed = async () => ({
      seed: async (sql) => {
        const [row] = await sql`select current_database() as database`;
        seeded.push(row.database);
      },
    });
    const [a, b] = await Promise.all([
      start({ files, wrong: { key: "RIG", cases: [] }, importSeed }),
      start({ files, wrong: { key: "RIG", cases: [] }, importSeed }),
    ]);
    assert.notEqual(a.run, b.run);
    for (const rig of [a, b]) {
      assert.deepEqual(rig.made, [`rosie_rig_${rig.run}_template`, `rosie_rig_${rig.run}_rig`]);
      assert.deepEqual(rig.databases, { RIG: `rosie_rig_${rig.run}_rig` });
      assert.deepEqual(await databasesOf(rig.run), [
        `rosie_rig_${rig.run}_rig`,
        `rosie_rig_${rig.run}_template`,
      ]);
      const sql = postgres(new URL(`/rosie_rig_${rig.run}_rig`, SERVER).href, {
        max: 1,
        onnotice: () => undefined,
      });
      try {
        const [active] = await sql`select count(*)::int as n from bundles where active`;
        assert.equal(active.n, 1, "bundle v0 is published and active in the file's database");
        const [migrated] = await sql`select count(*)::int as n from schema_migrations`;
        assert.ok(migrated.n > 30, `the file's database is migrated (${String(migrated.n)} files)`);
      } finally {
        await sql.end({ timeout: 5 });
      }
      assert.equal(new URL(rig.hyperdrives.HYPERDRIVE_JOB_RIG).pathname, `/rosie_rig_${rig.run}_rig`);
    }
    assert.deepEqual(seeded.sort(), [`rosie_rig_${a.run}_rig`, `rosie_rig_${b.run}_rig`].sort());

    await a.stop();
    assert.deepEqual(await databasesOf(a.run), [], "a's databases are gone");
    assert.deepEqual(
      await databasesOf(b.run),
      [`rosie_rig_${b.run}_rig`, `rosie_rig_${b.run}_template`],
      "b's stay",
    );
    await b.stop();
    assert.deepEqual(await databasesOf(b.run), []);
  });

  it("never drops a database that is not the run's own", async () => {
    await assert.rejects(
      dropRunDatabases(SERVER, "t0000aaaa", [
        "rosie_rig_t0000aaaa_rig",
        "rosie_rig_t1111bbbb_rig",
        "rosie_rig_none",
      ]),
      /drops only its run's databases \(rosie_rig_t0000aaaa_\*\), never rosie_rig_t1111bbbb_rig, rosie_rig_none/,
    );
  });

  it("a failure on the way drops what the run made so far", async () => {
    const run = newRun();
    await assert.rejects(
      startRig({
        env: ENV,
        run,
        files: [{ key: "RIG", test: THIS_FILE, seed: THIS_FILE }],
        wrong: { key: "RIG", cases: [] },
        importSeed: async () => ({
          seed: async () => {
            throw new Error("the seed failed on purpose");
          },
        }),
      }),
      /the seed failed on purpose/,
    );
    assert.deepEqual(await databasesOf(run), []);
  });

  it("the Worker's two logins in piece 1's shape, each logging in with its local password", async () => {
    const rig = await start({
      files: [{ key: "RIG", test: THIS_FILE, seed: NO_SEED }],
      wrong: { key: "RIG", cases: [] },
    });
    for (const [login, role] of [
      [WORKER_LOGINS.job, "rosie_job"],
      [WORKER_LOGINS.app, "rosie_app"],
    ]) {
      const shape = await shapeOf(admin, login);
      assert.deepEqual(shape, {
        login: true,
        superuser: false,
        createdb: false,
        createrole: false,
        replication: false,
        bypassrls: false,
        memberships: `${role} (inherit true, set false, admin false)`,
        named_by: 0,
      });
      const binding = login === WORKER_LOGINS.job ? "HYPERDRIVE_JOB_RIG" : "HYPERDRIVE_APP_RIG";
      const sql = postgres(rig.hyperdrives[binding], {
        max: 1,
        onnotice: () => undefined,
        connect_timeout: 15,
      });
      try {
        const [row] = await sql`select current_user, current_database()`;
        assert.deepEqual({ ...row }, { current_user: login, current_database: rig.databases.RIG });
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    await rig.stop();
  });

  it("T-1254's wrong logins: each right but for its case, on the file's database, and gone with it", async () => {
    const rig = await start({ files: [{ key: "DB", test: THIS_FILE, seed: NO_SEED }], wrong: WRONG_LOGINS });
    const database = rig.databases.DB;
    const read = async (binding) => {
      const sql = postgres(rig.hyperdrives[`HYPERDRIVE_DB_${binding}`], {
        max: 1,
        onnotice: () => undefined,
        connect_timeout: 15,
      });
      try {
        const [row] = await sql`
          select current_user as user, current_database() as database, current_schema() as schema,
                 row_security_active('public.businesses') as rls,
                 pg_has_role(current_user, 'rosie_job', 'USAGE') as job_usage,
                 pg_has_role(current_user, 'rosie_app', 'USAGE') as app_usage,
                 pg_has_role(current_user, 'rosie_app', 'MEMBER') as app_member,
                 pg_has_role(current_user, 'pg_read_all_data', 'USAGE') as read_all,
                 (select rolsuper from pg_roles where rolname = current_user) as superuser`;
        return { ...row };
      } finally {
        await sql.end({ timeout: 5 });
      }
    };
    const right = {
      database,
      schema: "public",
      rls: true,
      job_usage: true,
      app_usage: false,
      app_member: false,
    };
    const seen = {};
    for (const { binding } of WRONG_LOGINS.cases) seen[binding] = await read(binding);
    // The superuser case is the connecting login itself, which row-level security does not bind.
    assert.equal(seen.SUPERUSER.user, new URL(SERVER).username);
    assert.equal(seen.SUPERUSER.superuser, true);
    assert.equal(seen.SUPERUSER.rls, false);
    assert.equal(seen.SUPERUSER.database, database);
    const expected = {
      BOTH_ROLES: { ...right, app_usage: true, app_member: true },
      OTHER_ROLE: { ...right, app_member: true },
      OWNER: { ...right, rls: false },
      SECOND_MEMBERSHIP: { ...right },
      LOGIN_SCHEMA: { ...right, schema: "rosie_rig_login_schema" },
    };
    for (const [binding, wanted] of Object.entries(expected)) {
      const login = WRONG_LOGINS.cases.find((wrongCase) => wrongCase.binding === binding).login;
      const { read_all: readAll, superuser, user, ...rest } = seen[binding];
      assert.deepEqual(rest, wanted, binding);
      assert.equal(user, login, binding);
      assert.equal(superuser, false, binding);
      assert.equal(readAll, binding === "SECOND_MEMBERSHIP", binding);
    }
    // What names the cluster-wide logins in the file's database (the table rosie_rig_owner owns, the schema grant to
    // rosie_rig_login_schema) is there while the run lives and goes with the database.
    const [{ oid }] = await admin`select oid from pg_database where datname = ${database}`;
    const namedThere = async () => {
      const [row] = await admin`
        select count(*)::int as n from pg_shdepend s join pg_roles r on r.oid = s.refobjid
        where s.refclassid = 'pg_authid'::regclass and s.dbid = ${oid}
          and r.rolname in ('rosie_rig_owner', 'rosie_rig_login_schema')`;
      return row.n;
    };
    assert.ok(
      (await namedThere()) >= 2,
      "the owner's table and the schema's grant are on the file's database",
    );
    await rig.stop();
    assert.deepEqual(await databasesOf(rig.run), []);
    assert.equal(await namedThere(), 0, "what named the logins went with the run's database");
  });
});

describe("vitest.config.ts runs the rig in both Workers projects", () => {
  const config = readFileSync(path.join(REPO, "vitest.config.ts"), "utf8");
  const project = (name) => {
    const start = config.indexOf(`name: "${name}"`);
    const next = config.indexOf('name: "', start + 1);
    return config.slice(config.lastIndexOf("plugins:", start), next === -1 ? undefined : next);
  };

  it("one pool function for both blocks, and the rig's globalSetup in each (e2e-workers keeps its own beside it)", () => {
    assert.match(config, /const RIG_SETUP = "infra\/test-rig\/global-setup\.mjs";/);
    assert.equal(config.split("cloudflareTest(workersPool)").length - 1, 2);
    assert.doesNotMatch(config, /cloudflareTest\(\{/, "a Workers project with options of its own");
    assert.match(project("workers"), /globalSetup: \[RIG_SETUP\]/);
    assert.match(
      project("e2e-workers"),
      /globalSetup: \["tests\/e2e\/_driver\/prefix\/global-setup\.ts", RIG_SETUP\]/,
    );
    assert.match(config, /hyperdrives,?\s*\}/, "the pool's hyperdrives are the rig's");
  });

  it("waits long enough for the rig's teardown to drop its databases", () => {
    const teardown = /^\s*teardownTimeout:\s*([0-9_]+),/m.exec(config);
    assert.ok(teardown, "teardownTimeout is set");
    assert.ok(Number(teardown[1].replaceAll("_", "")) >= 120_000);
  });
});
