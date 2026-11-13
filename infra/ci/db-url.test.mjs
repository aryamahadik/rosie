// Tests for infra/scripts/db-url.mjs, the database URL check and scrub that migrate.mjs, publish-bundle.sh and
// infra/flags/flags.mjs share (T-569; DL-363), run by `node --test "infra/ci/*.test.mjs"`. The scripts' own tests run
// each script with URLs it must refuse or fail on (the publish-bundle, flags, deploy-staging and migrate tests); these
// pin the parts and the scrub themselves, and (T-1210) that a URL the check takes names to postgres.js the one host it
// names to Node. Every URL here is made up: no such user, password or database exists, and a .invalid host never
// resolves (RFC 6761).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import postgres from "postgres";

import { DatabaseUrlFault, checkDatabaseUrl, describeError, scrub } from "../scripts/db-url.mjs";

// The made-up parts of T-1210's URLs: a user, a password, two hosts and a database name.
const USER = "owner_t1210";
const PASSWORD = "Pw4tR8vK2";
const HOST = "db-t1210.example.invalid";
const HOST2 = "db2-t1210.example.invalid";
const DATABASE = "t1210_db";
// What no refusal of them may hold: t1210 (in the user, each host and the database name), the password and its pieces
// around an @ or a comma, 127.0.0.1 and each port.
const T1210_PARTS = ["t1210", PASSWORD, "Pw4t", "R8vK2", "127.0.0.1", "5432", "6543"];

/** The hosts postgres.js connects to, in turn, read from a client that never connects (only a query connects). */
async function postgresHosts(raw) {
  const sql = postgres(raw, { max: 1 });
  const hosts = sql.options.host;
  await sql.end();
  return hosts;
}

/** checkDatabaseUrl refuses `raw` with a fault that starts with `fault` and holds no part of T-1210's URLs. */
function assertRefused(raw, fault, what) {
  assert.throws(
    () => checkDatabaseUrl(raw),
    (error) =>
      error instanceof DatabaseUrlFault &&
      error.message.startsWith(fault) &&
      !T1210_PARTS.some((part) => error.message.includes(part)),
    what,
  );
}

describe("db-url.mjs", () => {
  it("gives every part of a URL that no printed line may hold, as written and decoded, longest first", () => {
    const raw = "postgresql://owner%5Ft569:Pw%40rd9K@db-t569.example.invalid:6543/t569%5Fdb?sslmode=require";
    const parts = checkDatabaseUrl(raw);
    const expected = [
      raw,
      "owner%5Ft569",
      "owner_t569",
      "Pw%40rd9K",
      "Pw@rd9K",
      "db-t569.example.invalid:6543",
      "db-t569.example.invalid",
      "6543",
      "t569%5Fdb",
      "t569_db",
    ];
    for (const part of expected) assert.ok(parts.includes(part), part);
    assert.deepEqual(
      parts,
      [...parts].sort((a, b) => b.length - a.length),
    );
  });

  it("refuses a URL that would parse with the user as the host, naming the fault and no part of it", () => {
    const raw = "postgres://owner_t569:2718#Wm5yH8@db-t569.example.invalid:5432/t569_db";
    assert.throws(
      () => checkDatabaseUrl(raw),
      (error) =>
        error instanceof DatabaseUrlFault &&
        error.message.startsWith("it holds a # ") &&
        !["owner_t569", "2718", "Wm5yH8", "db-t569", "t569_db"].some((part) => error.message.includes(part)),
    );
  });

  it("takes a port out only where it stands as a whole number", () => {
    const parts = checkDatabaseUrl("postgres://owner_t569:Pw9sK2mX7@127.0.0.1:1/t569_db");
    assert.equal(
      scrub("connect ECONNREFUSED 127.0.0.1:1; port 1 of 1001, SQLSTATE 08001", parts),
      "connect ECONNREFUSED [redacted]; port [redacted] of 1001, SQLSTATE 08001",
    );
  });

  it("takes out the address, host name and port an error's own fields name, and prints no other field", () => {
    const parts = checkDatabaseUrl("postgres://owner_t569:Pw9sK2mX7@db-t569.example.invalid/t569_db");
    // The host name resolved to an address (192.0.2.0/24 is for documentation, RFC 5737): Node's error names it.
    const refused = Object.assign(new Error("connect ECONNREFUSED 192.0.2.7:5432"), {
      code: "ECONNREFUSED",
      syscall: "connect",
      address: "192.0.2.7",
      port: 5432,
    });
    assert.equal(
      describeError(refused, parts),
      " (ECONNREFUSED): connect ECONNREFUSED [redacted]:[redacted]",
    );
    // postgres.js's own connection error names each host and port in arrays.
    const timedOut = Object.assign(new Error("write CONNECT_TIMEOUT db-t569.example.invalid:5432"), {
      code: "CONNECT_TIMEOUT",
      address: ["db-t569.example.invalid"],
      port: [5432],
    });
    assert.equal(
      describeError(timedOut, parts),
      " (CONNECT_TIMEOUT): write CONNECT_TIMEOUT [redacted]:[redacted]",
    );
    // Node's URL error keeps the whole string in input: never printed.
    const unread = Object.assign(new TypeError("Invalid URL"), {
      code: "ERR_INVALID_URL",
      input: "postgres://owner_t569:Pw9sK2mX7@db-t569.example.invalid/t569_db",
    });
    assert.equal(describeError(unread, parts), " (ERR_INVALID_URL): Invalid URL");
  });

  it("refuses a second @ before the path, where Node and postgres.js read different hosts, naming no part of it", async () => {
    // T-201's security review, note a: Node ends the user and password at the last @, so it reads 127.0.0.1, a host
    // the seed runner calls local; postgres.js ends them at the first @, so it connects to the remote host first.
    const twoAt = `postgres://${USER}:${PASSWORD}@${HOST},x@127.0.0.1:5432/${DATABASE}`;
    assert.equal(new URL(twoAt).hostname, "127.0.0.1");
    assert.deepEqual(await postgresHosts(twoAt), [HOST, "x@127.0.0.1"]);
    assertRefused(twoAt, "it holds a second @ ", "two @ and a comma");
    // With no comma, or a third @: an @ in the user or password is written %40.
    assertRefused(
      `postgres://${USER}:Pw4t@R8vK2@127.0.0.1:5432/${DATABASE}`,
      "it holds a second @ ",
      "two @",
    );
    assertRefused(`postgres://${USER}@x:Pw4t@R8vK2@${HOST}/${DATABASE}`, "it holds a second @ ", "three @");
  });

  it("refuses a comma before the path, or %2C in the host: a list of hosts to postgres.js, naming no part of it", async () => {
    // postgres.js splits the host, decoded, at each comma into hosts it tries in turn; a deploy names one (CQ-192).
    const listed = `postgres://${USER}:${PASSWORD}@${HOST},${HOST2}/${DATABASE}`;
    assert.deepEqual(await postgresHosts(listed), [HOST, HOST2]);
    assertRefused(listed, "it names more than one host", "a list of hosts");
    const encoded = `postgres://${USER}:${PASSWORD}@${HOST}%2C127.0.0.1/${DATABASE}`;
    assert.deepEqual(await postgresHosts(encoded), [HOST, "127.0.0.1"]);
    assertRefused(encoded, "it names more than one host", "%2C in the host");
    for (const [what, raw] of [
      // libpq's form, which Node does not read as a URL: refused by name all the same.
      [
        "a list of hosts with ports",
        `postgres://${USER}:${PASSWORD}@${HOST}:5432,127.0.0.1:6543/${DATABASE}`,
      ],
      ["a list of hosts with no user", `postgres://${HOST},${HOST2}/${DATABASE}`],
      ["%2c in the host", `postgresql://${USER}:${PASSWORD}@${HOST}%2c${HOST2}:6543/${DATABASE}`],
      ["a comma in the password", `postgres://${USER}:Pw4t,R8vK2@${HOST}/${DATABASE}`],
      ["a comma in the user", `postgres://${USER},x:${PASSWORD}@${HOST}/${DATABASE}`],
    ]) {
      assertRefused(raw, "it names more than one host", what);
    }
  });

  it("still takes one host after one @ (an @ or a comma in the password written %40 or %2C), as postgres.js reads it", async () => {
    const urls = [
      `postgres://${USER}:Pw4t%40R8vK2@127.0.0.1:54329/${DATABASE}`,
      `postgresql://${USER}:Pw4t%2CR8vK2@${HOST}:6543/${DATABASE}?sslmode=require&application_name=t1210,seed`,
      `postgres://${USER}@localhost/${DATABASE}`,
      // The local Docker database's (factory spec 4: local only, not a secret).
      "postgres://rosie:rosie@127.0.0.1:54329/rosie",
    ];
    for (const raw of urls) {
      assert.doesNotThrow(() => checkDatabaseUrl(raw), raw);
      // The one host Node reads is the one postgres.js connects to.
      assert.deepEqual(await postgresHosts(raw), [new URL(raw).hostname], raw);
    }
    const parts = checkDatabaseUrl(urls[0]);
    for (const part of ["Pw4t%40R8vK2", "Pw4t@R8vK2", "127.0.0.1:54329", "54329", DATABASE]) {
      assert.ok(parts.includes(part), part);
    }
  });
});
