// T-1255: the probe's own select on a real PostgreSQL, the local rosie-pg (npm run db:up) or DATABASE_URL's server,
// reached as that URL's login, which must be a superuser (as the local and CI containers' first user is). Run:
//   node --test infra/spikes/hyperdrive-roles/local-db.test.mjs
// What the stand-ins cannot show: that guardQuery runs on PostgreSQL 17 and gives, for logins made as ADR-014 section 1
// says, exactly the table's expected answers (memberships read by member included); that the crossed reads and a
// superuser are refused; and that the two forms of the postmaster's start agree to the microsecond. Not Hyperdrive:
// each binding is a postgres.js client straight to the server.
// Logins are cluster-wide and the build Mac's server is shared, so the run never uses the real names (as T-1252's
// worker-logins.test.mjs does not): it makes logins of its own, t1255_<6 hex>_worker_job and _worker_app, each granted
// its own stand-in role (t1255_<6 hex>_job or _app, NOLOGIN as 0012 makes rosie_job and rosie_app) WITH INHERIT TRUE,
// SET FALSE, and a database of its own with a businesses table under row-level security, and drops every one of them
// after, pass or fail. The logins' password is made for the run, on this server only, and never printed. Not part of
// npm test.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";

import postgres from "postgres";

import { SIDES, makeRedactor, parseStart, printable, runProbe, verdict } from "./probe.mjs";

const LOCAL_URL = "postgres://rosie:rosie@127.0.0.1:54329/rosie";
const RUN = `t1255_${randomBytes(3).toString("hex")}`;
const PASSWORD = randomBytes(16).toString("hex");
const DATABASE = `${RUN}_db`;
const quiet = () => undefined;

/** The URL of the server the tests run on: DATABASE_URL, else the local rosie-pg (never when CI is set). */
function serverUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.CI)
    throw new Error("DATABASE_URL is not set, and with CI set the local database is never used");
  return LOCAL_URL;
}

/** The server's URL with another user, password and database. */
function urlAs({ user, password, database }) {
  const url = new URL(serverUrl());
  if (user !== undefined) url.username = user;
  if (password !== undefined) url.password = password;
  url.pathname = `/${database}`;
  return url.href;
}

// The run's own sides: the real ones with the run's names for the logins and their roles.
const sides = SIDES.map((side) => ({
  ...side,
  login: `${RUN}_worker_${side.side}`,
  role: `${RUN}_${side.side}`,
  other: `${RUN}_${side.side === "job" ? "app" : "job"}`,
}));
const [JOB, APP] = sides;
const loginUrl = (side) => urlAs({ user: side.login, password: PASSWORD, database: DATABASE });
const redact = makeRedactor(
  [serverUrl(), ...sides.map(loginUrl)],
  sides.map((side) => side.login),
);

/** A client through a "binding": each binding's login, unless `as` names another URL for it. */
const openWith =
  (as = {}) =>
  (binding, options) => {
    const side = sides.find((entry) => entry.binding === binding);
    return postgres(as[binding] ?? loginUrl(side), {
      fetch_types: false,
      connect_timeout: 15,
      onnotice: quiet,
      ...options,
    });
  };

describe("the probe's select on PostgreSQL, as logins made as ADR-014 section 1 says", () => {
  let admin;

  before(async () => {
    admin = postgres(serverUrl(), { max: 1, onnotice: quiet });
    const [{ version }] = await admin`select current_setting('server_version_num')::int as version`;
    assert.ok(version >= 160000, "the grant WITH INHERIT TRUE, SET FALSE needs PostgreSQL 16 or later");
    for (const side of sides) {
      await admin.unsafe(
        `create role ${side.role} nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
      );
    }
    for (const side of sides) {
      await admin.unsafe(
        `create role ${side.login} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '${PASSWORD}'`,
      );
      await admin.unsafe(`grant ${side.role} to ${side.login} with inherit true, set false`);
    }
    // From template0: the probe needs no extension, and copying template1's PostGIS is slow on the emulated server.
    await admin.unsafe(`create database ${DATABASE} template template0`);
    const owner = postgres(urlAs({ database: DATABASE }), { max: 1, onnotice: quiet });
    try {
      await owner.unsafe("create table public.businesses (id int primary key)");
      await owner.unsafe("alter table public.businesses enable row level security");
    } finally {
      await owner.end({ timeout: 5 });
    }
  });

  after(async () => {
    if (admin === undefined) return;
    try {
      await admin.unsafe(`drop database if exists ${DATABASE} with (force)`);
      for (const side of sides) await admin.unsafe(`drop role if exists ${side.login}`);
      for (const side of sides) await admin.unsafe(`drop role if exists ${side.role}`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });

  it("answers as each login with the table's expected answers, refuses the crossed reads, and reads the start in two forms that agree", async () => {
    const result = await runProbe({ open: openWith(), sides, redact });
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.deepEqual(
      result.crossed.map((entry) => [entry.binding, entry.refused]),
      [
        ["HYPERDRIVE_JOB", true],
        ["HYPERDRIVE_APP", true],
      ],
    );
    const [{ us }] =
      await admin`select ((extract(epoch from pg_postmaster_start_time()) * 1000000)::int8)::text as us`;
    for (const [index, side] of sides.entries()) {
      const got = result.sides[index];
      assert.equal(got.answers.length, 1);
      assert.equal(got.answers[0].session_user, side.login);
      assert.deepEqual(got.answers[0].memberships, [
        { role: side.role, inherit: true, set: false, admin: false },
      ]);
      assert.equal(got.inside_transaction.backends.length, 1);
      assert.deepEqual(
        got.postmaster_starts.map((start) => start.start_us),
        [us],
      );
      assert.equal(parseStart(got.postmaster_starts[0].start), BigInt(us));
    }
    const record = printable(result, { sides });
    const same = verdict(record, { runStartUs: BigInt(us), sides });
    assert.deepEqual(same.problems, []);
    assert.equal(same.persistence, "not yet proved");
    const later = verdict(record, { runStartUs: BigInt(us) - 1n, sides });
    assert.deepEqual(later.problems, []);
    assert.equal(later.persistence, "proved");
    assert.equal(JSON.stringify(result).includes(PASSWORD), false);
  });

  it("refuses a binding that stores a superuser (the migrations' role's kind) on every read, and never shows its name", async () => {
    const result = await runProbe({
      open: openWith({ HYPERDRIVE_JOB: urlAs({ database: DATABASE }) }),
      sides,
      redact,
    });
    assert.equal(result.ok, false);
    const [job, app] = result.sides;
    assert.equal(app.ok, true);
    assert.equal(job.ok, false);
    // A superuser holds every role's rights (pg_has_role answers true, so the USAGE check alone would pass), has no
    // membership of its own, and row-level security is not in force for it.
    assert.deepEqual(
      job.answers.map((group) => [group.reads, group.session_user, group.failed_checks]),
      [
        [
          55,
          "(not shown)",
          [
            "session_user",
            "current_user",
            "memberships",
            `pg_has_role(current_user, '${APP.role}', 'MEMBER')`,
            "row_security_active('businesses')",
          ],
        ],
      ],
    );
    assert.equal(job.answers[0].own_usage, true);
    assert.equal(job.answers[0].row_security, false);
    // The superuser's crossed read where the Tool API side's answers are expected is refused too.
    assert.equal(result.crossed[0].refused, true);
    assert.equal(result.crossed[0].answer.session_user, "(not shown)");
    const judged = verdict(printable(result, { sides }), { runStartUs: 0n, sides });
    const label = (text) => text.replace(/[()]/g, "\\$&");
    assert.deepEqual(
      judged.problems.map((problem) =>
        new RegExp(
          `^HYPERDRIVE_JOB: 55 read\\(s\\) on \\d+ backend\\(s\\) \\(pid [\\d, ]+\\) answered as another login: \\(not shown\\), failing the table's checks: session_user, current_user, memberships, ${label(`pg_has_role(current_user, '${APP.role}', 'MEMBER')`)}, ${label("row_security_active('businesses')")}$`,
        ).test(problem),
      ),
      [true],
      judged.problems.join("\n"),
    );
    assert.notEqual(JOB.login, result.sides[0].answers[0].current_user);
  });
});
