// Tests for `npm run db:logins` (infra/test-rig/db-logins.mjs; T-1253, ADR-014 section 4's piece 5): the Worker's two
// logins and their local passwords for plain `wrangler dev`, the same two steps as the Workers test rig's, with the same
// refusal of any server but a local or CI one. The script runs as npm runs it, in a child Node, on the local rosie-pg
// (npm run db:up), or on DATABASE_URL's server in CI, as a superuser. The two logins are cluster-wide, and the Workers
// test rig makes them on every server it runs on, so these tests use their real names: the script makes them only when
// missing and sets a password only when the login cannot log in with its own, which is what the second run shows.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import postgres from "postgres";

import { LOCAL_DATABASE_URL, REPO } from "../test-rig/rig.mjs";

const SCRIPT = path.join(REPO, "infra/test-rig/db-logins.mjs");

/** The test server: DATABASE_URL, else the local rosie-pg (never when CI is set). */
function testServerUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.CI)
    throw new Error("DATABASE_URL is not set, and with CI set the local database is never used");
  return LOCAL_DATABASE_URL;
}

const SERVER = testServerUrl();

/** Runs the script with DATABASE_URL set to `databaseUrl`, as `npm run db:logins` runs it. */
function dbLogins(databaseUrl) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: REPO,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr, output: `${stdout}${stderr}` }));
  });
}

describe("db-logins.mjs: npm run db:logins", () => {
  let admin;

  before(async () => {
    admin = postgres(SERVER, { max: 1, onnotice: () => undefined, connect_timeout: 15 });
    const [me] = await admin`select rolsuper from pg_roles where rolname = current_user`;
    assert.ok(
      me?.rolsuper,
      "the tests' login must be a superuser, as the local and CI containers' first user is",
    );
  });

  after(async () => {
    await admin?.end({ timeout: 5 });
  });

  /** Each login's catalog row (its attributes and stored password verifier, by md5), memberships and pg_shdepend rows. */
  const fingerprint = async () =>
    Array.from(
      await admin`
        select a.rolname,
               md5(row(a.*)::text) as authid_row,
               (select string_agg(r.rolname || ' ' || m.inherit_option || ' ' || m.set_option || ' ' || m.admin_option,
                                  ', ' order by r.rolname)
                  from pg_auth_members m join pg_roles r on r.oid = m.roleid where m.member = a.oid) as memberships,
               (select count(*)::int from pg_shdepend s
                 where s.refclassid = 'pg_authid'::regclass and s.refobjid = a.oid) as named_by
        from pg_authid a where a.rolname in ('rosie_worker_job', 'rosie_worker_app') order by 1`,
      (row) => ({ ...row }),
    );

  it("refuses a host that is not a loopback name before it connects, printing no part of the URL", async () => {
    let connections = 0;
    const listener = net.createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise((resolve) => listener.listen(0, "0.0.0.0", resolve));
    try {
      const { port } = listener.address();
      const result = await dbLogins(`postgres://rosie:Hn4wQ8zR2t1253@0.0.0.0:${String(port)}/rosie`);
      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, /^db:logins: refused: .*host is not a loopback name/);
      assert.equal(result.stdout, "");
      for (const part of ["Hn4wQ8zR2t1253", "0.0.0.0", String(port)]) {
        assert.ok(!result.output.includes(part), `the output holds ${part}`);
      }
      assert.equal(connections, 0, "the refused run connected");
    } finally {
      await new Promise((resolve) => listener.close(resolve));
    }
  });

  it("twice on the test server: both logins in piece 1's shape, and the second run changes nothing", async () => {
    const first = await dbLogins(SERVER);
    assert.equal(first.status, 0, first.output);
    const between = await fingerprint();
    const second = await dbLogins(SERVER);
    assert.equal(second.status, 0, second.output);
    assert.deepEqual(await fingerprint(), between, "the second run changed a login");
    assert.deepEqual(
      between.map(({ rolname, memberships, named_by: namedBy }) => [rolname, memberships, namedBy]),
      [
        ["rosie_worker_app", "rosie_app true false false", 0],
        ["rosie_worker_job", "rosie_job true false false", 0],
      ],
    );
    assert.deepEqual(second.stdout.trim().split("\n"), [
      "db:logins: rosie_worker_job: LOGIN yes, SUPERUSER no, CREATEDB no, CREATEROLE no, REPLICATION no, BYPASSRLS no; " +
        "memberships rosie_job (inherit true, set false, admin false); named by 0 row(s) of pg_shdepend; local password kept",
      "db:logins: rosie_worker_app: LOGIN yes, SUPERUSER no, CREATEDB no, CREATEROLE no, REPLICATION no, BYPASSRLS no; " +
        "memberships rosie_app (inherit true, set false, admin false); named by 0 row(s) of pg_shdepend; local password kept",
      "db:logins: done",
    ]);
    assert.equal(second.stderr, "");
  });
});
