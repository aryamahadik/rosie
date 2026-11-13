// Tests for infra/scripts/worker-logins.sql, the Worker's two logins (ADR-014 piece 1; T-1252), run by
// `node --test "infra/ci/*.test.mjs"` on the local rosie-pg (npm run db:up), or on DATABASE_URL's server (CI sets it).
// They connect as that URL's login, which must be a superuser, as the local and CI containers' first user is.
//
// Logins are cluster-wide, and the build Mac's one server is shared: other builders' runs, and soon the Workers test rig
// (piece 5), which makes rosie_worker_job and rosie_worker_app there and sets their local passwords. So the file never
// runs here under its own names. Each run takes the file's text with its four names swapped for names of the run's own
// (t1252_<6 hex><case>_worker_job, _worker_app, _job and _app), checks that the swap left none of the four behind, and
// makes the two stand-ins for rosie_job and rosie_app NOLOGIN as 0012 makes those. One test below pins the names the
// file holds. Every role and the schema a run makes are dropped after it, pass or fail; another run's are never
// touched.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import postgres from "postgres";

import { REPO } from "./script-harness.mjs";

const FILE = path.join(REPO, "infra/scripts/worker-logins.sql");
const TEXT = readFileSync(FILE, "utf8");
const LOCAL_URL = "postgres://rosie:rosie@127.0.0.1:54329/rosie";
const RUN = `t1252_${randomBytes(3).toString("hex")}`;
const SCHEMA = `${RUN}_objects`;
// The file's four names, each with the part of a run's own name it is swapped for.
const SWAPS = [
  ["rosie_worker_job", "worker_job"],
  ["rosie_worker_app", "worker_app"],
  ["rosie_job", "job"],
  ["rosie_app", "app"],
];

/** The URL of the server the tests run on: DATABASE_URL, else the local rosie-pg (never when CI is set). */
function serverUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.CI)
    throw new Error("DATABASE_URL is not set, and with CI set the local database is never used");
  return LOCAL_URL;
}

const quote = (name) => `"${name.replaceAll('"', '""')}"`;

/** One case's names: its two logins and its two stand-in roles. */
function namesFor(caseName) {
  const prefix = `${RUN}${caseName}`;
  return Object.fromEntries(SWAPS.map(([, part]) => [part, `${prefix}_${part}`]));
}

/** The file's text with its four names swapped for the case's own; fails if one is left. */
function swapped(names) {
  let text = TEXT;
  for (const [from, part] of SWAPS) {
    const count = text.match(new RegExp(`\\b${from}\\b`, "g"))?.length ?? 0;
    assert.ok(count > 0, `the file no longer names ${from}`);
    text = text.replace(new RegExp(`\\b${from}\\b`, "g"), names[part]);
  }
  assert.doesNotMatch(text, /\brosie_(worker_)?(job|app)\b/, "the swap left one of the file's own names");
  return text;
}

let admin;

/** Makes the case's two stand-in roles, as 0012 makes rosie_app and rosie_job. */
async function standIns(names, which = ["job", "app"]) {
  for (const part of which) {
    await admin.unsafe(
      `create role ${quote(names[part])} nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
    );
  }
}

/** A login role's shape, read as the superuser: its flags, its memberships by member and as roleid, and pg_shdepend. */
async function shapeOf(login) {
  const [role] = await admin`
    select oid::text as oid, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
           rolpassword is null as no_password
    from pg_authid where rolname = ${login}`;
  if (role === undefined) return null;
  const own = await admin`
    select r.rolname as role, m.inherit_option as inherit, m.set_option as set, m.admin_option as admin
    from pg_auth_members m join pg_roles r on r.oid = m.roleid
    where m.member = ${role.oid}::oid order by r.rolname`;
  const granted = await admin`
    select r.rolname as member, m.inherit_option as inherit, m.set_option as set, m.admin_option as admin
    from pg_auth_members m join pg_roles r on r.oid = m.member
    where m.roleid = ${role.oid}::oid order by r.rolname`;
  const [{ named }] = await admin`
    select count(*)::int as named from pg_shdepend
    where refclassid = 'pg_authid'::regclass and refobjid = ${role.oid}::oid`;
  const { oid, ...flags } = role;
  return { oid, flags, own: [...own], granted: [...granted], named };
}

/** Everything the catalogs hold about these roles, for "changes nothing" and "left as it was". */
async function snapshot(logins) {
  const roles = await admin`select * from pg_authid where rolname = any(${logins}) order by rolname`;
  const members = await admin`
    select m.*, r.rolname as role_name, s.rolname as member_name from pg_auth_members m
    join pg_roles r on r.oid = m.roleid join pg_roles s on s.oid = m.member
    where r.rolname = any(${logins}) or s.rolname = any(${logins}) order by m.oid`;
  const named = await admin`
    select d.* from pg_shdepend d join pg_authid a on a.oid = d.refobjid
    where d.refclassid = 'pg_authid'::regclass and a.rolname = any(${logins}) order by d.classid, d.objid`;
  return JSON.parse(JSON.stringify({ roles, members, named }));
}

const RIGHT_FLAGS = {
  rolcanlogin: true,
  rolsuper: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolbypassrls: false,
  no_password: true,
};

/** Fails unless the login is in its shape: the flags, one membership (its role, inherit, no set, no admin), nothing. */
function assertRightShape(shape, role, what) {
  assert.ok(shape, `${what}: the login is missing`);
  assert.deepEqual(shape.flags, RIGHT_FLAGS, `${what}: flags`);
  assert.deepEqual(shape.own, [{ role, inherit: true, set: false, admin: false }], `${what}: memberships`);
  assert.equal(shape.named, 0, `${what}: pg_shdepend names it`);
}

/** Runs a text on a client and gives back the error it raised (undefined when it ran). */
async function failure(client, text) {
  try {
    await client.unsafe(text);
    return undefined;
  } catch (error) {
    return error;
  }
}

/** A login role that runs the file as staging's migrations' role would: CREATEROLE, not a superuser, with ADMIN OPTION
 * on the two roles it grants (PostgreSQL 16 asks the grantor for it). Returns a client connected as it. */
async function maker(names) {
  const name = `${names.job.slice(0, -"_job".length)}_maker`;
  const password = randomBytes(16).toString("hex");
  await admin.unsafe(`create role ${quote(name)} login createrole password '${password}'`);
  await admin.unsafe(`grant ${quote(names.job)}, ${quote(names.app)} to ${quote(name)} with admin option`);
  const url = new URL(serverUrl());
  url.username = name;
  url.password = password;
  const client = postgres(url.href, { max: 1, onnotice: () => undefined, connect_timeout: 15 });
  return { name, client };
}

before(async () => {
  admin = postgres(serverUrl(), { max: 3, onnotice: () => undefined, connect_timeout: 15 });
  const [server] = await admin`
    select current_setting('server_version_num')::int as version, rolsuper from pg_roles where rolname = current_user`;
  assert.ok(
    server.rolsuper,
    "the tests' login must be a superuser, as the local and CI containers' first user is",
  );
  // The file refuses anything older; a test server of 16 or later is what makes its run here mean anything.
  assert.ok(
    server.version >= 160000,
    `the test server is older than PostgreSQL 16 (${String(server.version)})`,
  );
  await admin.unsafe(`create schema ${quote(SCHEMA)}`);
});

after(async () => {
  if (admin === undefined) return;
  try {
    await admin.unsafe(`drop schema if exists ${quote(SCHEMA)} cascade`);
    const roles =
      await admin`select rolname from pg_roles where starts_with(rolname, ${RUN}) order by rolname`;
    for (const { rolname } of roles) {
      await admin.unsafe(`drop owned by ${quote(rolname)}`);
      await admin.unsafe(`drop role ${quote(rolname)}`);
    }
    const [{ left }] =
      await admin`select count(*)::int as left from pg_roles where starts_with(rolname, ${RUN})`;
    assert.equal(left, 0, `roles of this run are left on the server (${RUN}_*)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
});

describe("worker-logins.sql holds ADR-014's names and its own rules", () => {
  it("one DO block that makes and checks exactly rosie_worker_job (granted rosie_job) and rosie_worker_app (granted rosie_app)", () => {
    const pairs = "(values ('rosie_worker_job', 'rosie_job'), ('rosie_worker_app', 'rosie_app'))";
    // Once to make them, once to read them.
    assert.equal(TEXT.split(pairs).length - 1, 2, `the file's pairs are not ${pairs}, twice`);
    const code = TEXT.split("\n")
      .filter((line) => !/^\s*--/.test(line))
      .join("\n")
      .trim();
    assert.match(code, /^do \$\$\n[\s\S]*\n\$\$;$/, "the file is not one DO block and nothing else");
    assert.equal(code.split("$$").length - 1, 2, "the file holds more than one dollar-quoted body");
  });

  it("the version check comes first, every CREATE and GRANT runs through EXECUTE, and no password is set", () => {
    const body = TEXT.slice(TEXT.indexOf("begin\n"));
    const lines = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("--"));
    assert.equal(lines[1], "if pg_catalog.current_setting('server_version_num')::integer < 160000 then");
    const firstChange = body.search(/'(create role|grant) %I/);
    assert.ok(firstChange > body.indexOf("160000"), "a CREATE or GRANT comes before the version check");
    // No statement line of its own: a CREATE ROLE or GRANT written out would be parsed before the version check runs.
    assert.deepEqual(
      lines.filter((line) => /^(create\s+role|grant|alter\s+role)\b/i.test(line)),
      [],
      "a CREATE ROLE, GRANT or ALTER ROLE outside EXECUTE",
    );
    assert.ok(
      body.includes("'create role %I login nosuperuser nocreatedb nocreaterole noreplication nobypassrls'"),
    );
    assert.ok(body.includes("execute pg_catalog.format('grant %I to %I with inherit true, set false'"));
    const code = TEXT.split("\n").filter((line) => !/^\s*--/.test(line));
    assert.equal(
      code.some((line) => /password/i.test(line)),
      false,
      "the file's code names a password",
    );
  });
});

describe("worker-logins.sql on the server (names of this run's own)", () => {
  it("as a maker that is not a superuser: a first run makes both logins in their shape, the maker's own ADMIN row (roleid the login) does not count, and a second run changes nothing", async () => {
    const names = namesFor("m");
    await standIns(names);
    const { name, client } = await maker(names);
    try {
      assert.equal(await shapeOf(names.worker_job), null);
      assert.equal(await shapeOf(names.worker_app), null);
      await client.unsafe(swapped(names));
      for (const [login, role] of [
        [names.worker_job, names.job],
        [names.worker_app, names.app],
      ]) {
        const shape = await shapeOf(login);
        assertRightShape(shape, role, login);
        // PostgreSQL 16 granted the new login back to its maker: a row whose roleid is the login, never read.
        assert.deepEqual(shape.granted, [{ member: name, inherit: false, set: false, admin: true }], login);
      }
      const before = await snapshot([names.worker_job, names.worker_app]);
      await client.unsafe(swapped(names));
      assert.deepEqual(
        await snapshot([names.worker_job, names.worker_app]),
        before,
        "the second run changed something",
      );
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it("as a superuser, as on the local and CI servers: both logins in their shape, with no maker's row at all", async () => {
    const names = namesFor("s");
    await standIns(names);
    await admin.unsafe(swapped(names));
    for (const [login, role] of [
      [names.worker_job, names.job],
      [names.worker_app, names.app],
    ]) {
      const shape = await shapeOf(login);
      assertRightShape(shape, role, login);
      assert.deepEqual(shape.granted, [], login);
    }
    const before = await snapshot([names.worker_job, names.worker_app]);
    await admin.unsafe(swapped(names));
    assert.deepEqual(
      await snapshot([names.worker_job, names.worker_app]),
      before,
      "the second run changed something",
    );
  });

  // [the case's title, how the login is made beforehand, what the refusal names]. Each is made by the superuser.
  const BAD = [
    [
      "a second membership (pg_read_all_data, which a host might add)",
      async (n) => {
        await admin.unsafe(`create role ${quote(n.worker_job)} login`);
        await admin.unsafe(`grant ${quote(n.job)} to ${quote(n.worker_job)} with inherit true, set false`);
        await admin.unsafe(`grant pg_read_all_data to ${quote(n.worker_job)}`);
      },
      (n) =>
        `its memberships are pg_read_all_data (inherit true, set true, admin false), ${n.job} (inherit true, set false, admin false) where its one is ${n.job}`,
    ],
    [
      "SET TRUE on its membership",
      async (n) => {
        await admin.unsafe(`create role ${quote(n.worker_job)} login`);
        await admin.unsafe(`grant ${quote(n.job)} to ${quote(n.worker_job)} with inherit true, set true`);
      },
      (n) => `its memberships are ${n.job} (inherit true, set true, admin false) where its one is ${n.job}`,
    ],
    [
      "it owns a table",
      async (n) => {
        await admin.unsafe(`create role ${quote(n.worker_job)} login`);
        await admin.unsafe(`grant ${quote(n.job)} to ${quote(n.worker_job)} with inherit true, set false`);
        await admin.unsafe(`create table ${quote(SCHEMA)}.${quote(`${n.worker_job}_owned`)} (id int)`);
        await admin.unsafe(
          `alter table ${quote(SCHEMA)}.${quote(`${n.worker_job}_owned`)} owner to ${quote(n.worker_job)}`,
        );
      },
      () => "pg_shdepend names it: 1 object(s) it owns",
    ],
    [
      "BYPASSRLS",
      async (n) => {
        await admin.unsafe(`create role ${quote(n.worker_job)} login bypassrls`);
        await admin.unsafe(`grant ${quote(n.job)} to ${quote(n.worker_job)} with inherit true, set false`);
      },
      () => "BYPASSRLS",
    ],
    [
      "made but never granted",
      async (n) => {
        await admin.unsafe(`create role ${quote(n.worker_job)} login`);
      },
      (n) => `its memberships are none where its one is ${n.job}`,
    ],
    [
      "ADMIN TRUE on its membership",
      async (n) => {
        await admin.unsafe(`create role ${quote(n.worker_job)} login`);
        await admin.unsafe(
          `grant ${quote(n.job)} to ${quote(n.worker_job)} with admin true, inherit true, set false`,
        );
      },
      (n) => `its memberships are ${n.job} (inherit true, set false, admin true)`,
    ],
    [
      "INHERIT FALSE on its membership",
      async (n) => {
        await admin.unsafe(`create role ${quote(n.worker_job)} login`);
        await admin.unsafe(`grant ${quote(n.job)} to ${quote(n.worker_job)} with inherit false, set false`);
      },
      (n) => `its memberships are ${n.job} (inherit false, set false, admin false)`,
    ],
    [
      "the other side's role instead of its own",
      async (n) => {
        await admin.unsafe(`create role ${quote(n.worker_job)} login`);
        await admin.unsafe(`grant ${quote(n.app)} to ${quote(n.worker_job)} with inherit true, set false`);
      },
      (n) => `its memberships are ${n.app} (inherit true, set false, admin false) where its one is ${n.job}`,
    ],
    [
      "both roles",
      async (n) => {
        await admin.unsafe(`create role ${quote(n.worker_job)} login`);
        await admin.unsafe(
          `grant ${quote(n.job)}, ${quote(n.app)} to ${quote(n.worker_job)} with inherit true, set false`,
        );
      },
      (n) =>
        `its memberships are ${n.app} (inherit true, set false, admin false), ${n.job} (inherit true, set false, admin false)`,
    ],
    [
      "NOLOGIN",
      async (n) => {
        await admin.unsafe(`create role ${quote(n.worker_job)} nologin`);
        await admin.unsafe(`grant ${quote(n.job)} to ${quote(n.worker_job)} with inherit true, set false`);
      },
      () => "NOLOGIN",
    ],
    [
      "SUPERUSER (no password, dropped after)",
      async (n) => {
        await admin.unsafe(`create role ${quote(n.worker_job)} login superuser`);
        await admin.unsafe(`grant ${quote(n.job)} to ${quote(n.worker_job)} with inherit true, set false`);
      },
      () => "SUPERUSER",
    ],
    [
      "CREATEDB, CREATEROLE and REPLICATION",
      async (n) => {
        await admin.unsafe(`create role ${quote(n.worker_job)} login createdb createrole replication`);
        await admin.unsafe(`grant ${quote(n.job)} to ${quote(n.worker_job)} with inherit true, set false`);
      },
      () => "CREATEDB; CREATEROLE; REPLICATION",
    ],
    [
      "a grant of its own (SELECT on a table)",
      async (n) => {
        await admin.unsafe(`create role ${quote(n.worker_job)} login`);
        await admin.unsafe(`grant ${quote(n.job)} to ${quote(n.worker_job)} with inherit true, set false`);
        await admin.unsafe(`create table ${quote(SCHEMA)}.${quote(`${n.worker_job}_seen`)} (id int)`);
        await admin.unsafe(
          `grant select on ${quote(SCHEMA)}.${quote(`${n.worker_job}_seen`)} to ${quote(n.worker_job)}`,
        );
      },
      () => "pg_shdepend names it: 1 grant(s) of its own",
    ],
  ];

  for (const [index, [title, makeBad, fault]] of BAD.entries()) {
    it(`a login made beforehand in another shape is refused and left as it was: ${title}`, async () => {
      const names = namesFor(`b${String(index)}`);
      await standIns(names);
      await makeBad(names);
      const before = await snapshot([names.worker_job, names.worker_app]);
      const error = await failure(admin, swapped(names));
      assert.ok(error, `${title}: the run was not refused`);
      assert.equal(error.code, "55000", `${title}: ${String(error.message)}`);
      assert.ok(
        error.message.startsWith(`worker-logins.sql: refused: ${names.worker_job} is not in its shape (`),
        `${title}: ${String(error.message)}`,
      );
      assert.ok(error.message.includes(fault(names)), `${title}: ${String(error.message)}`);
      assert.ok(
        error.message.endsWith("It is left as it is: this file never repairs a login"),
        error.message,
      );
      // Left exactly as it was, and the other login, which this run made first, rolled back with the refusal.
      assert.deepEqual(await snapshot([names.worker_job, names.worker_app]), before, `${title}: changed`);
      assert.equal(await shapeOf(names.worker_app), null, `${title}: ${names.worker_app} was left made`);
    });
  }

  it("a refusal of the second login rolls back the first, which the same run made", async () => {
    const names = namesFor("r");
    await standIns(names);
    await admin.unsafe(`create role ${quote(names.worker_app)} login bypassrls`);
    await admin.unsafe(
      `grant ${quote(names.app)} to ${quote(names.worker_app)} with inherit true, set false`,
    );
    const before = await snapshot([names.worker_job, names.worker_app]);
    const error = await failure(admin, swapped(names));
    assert.ok(error, "the run was not refused");
    assert.ok(
      error.message.startsWith(`worker-logins.sql: refused: ${names.worker_app} is not in its shape (`),
    );
    assert.match(error.message, /\): BYPASSRLS\. It is left as it is/);
    assert.equal(await shapeOf(names.worker_job), null, `${names.worker_job} was left made`);
    assert.deepEqual(await snapshot([names.worker_job, names.worker_app]), before);
  });

  it("a role it cannot grant (missing) stops it with no login left made but not granted", async () => {
    const names = namesFor("g");
    await standIns(names, ["app"]);
    const error = await failure(admin, swapped(names));
    assert.ok(error, "the run was not refused");
    assert.equal(error.code, "42704", String(error.message));
    assert.equal(await shapeOf(names.worker_job), null);
    assert.equal(await shapeOf(names.worker_app), null);
  });

  it("two runs at once: the second finds a login made beside it, skips the duplicate, and both end with the logins in their shape", async () => {
    const names = namesFor("c");
    await standIns(names);
    const first = await admin.reserve();
    const second = postgres(serverUrl(), { max: 1, onnotice: () => undefined, connect_timeout: 15 });
    let open = false;
    try {
      const [{ pid }] = await second`select pg_backend_pid() as pid`;
      // The first run makes both logins inside a transaction it has not committed yet.
      await first`begin`;
      open = true;
      await first.unsafe(swapped(names));
      // The second run finds them missing (it cannot see them yet), and its CREATE waits on the first's.
      const secondRun = failure(second, swapped(names));
      let waiting = false;
      for (let tries = 0; tries < 200 && !waiting; tries += 1) {
        const [row] = await admin`select wait_event_type from pg_stat_activity where pid = ${pid}`;
        waiting = row?.wait_event_type === "Lock";
        if (!waiting) await sleep(25);
      }
      assert.ok(waiting, "the second run never waited on the first's CREATE ROLE");
      await first`commit`;
      open = false;
      assert.equal(await secondRun, undefined, "the second run was refused");
      assertRightShape(await shapeOf(names.worker_job), names.job, names.worker_job);
      assertRightShape(await shapeOf(names.worker_app), names.app, names.worker_app);
    } finally {
      if (open) await first`rollback`;
      first.release();
      await second.end({ timeout: 5 });
    }
  });
});
