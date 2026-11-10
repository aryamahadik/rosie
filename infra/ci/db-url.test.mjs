// Tests for infra/scripts/db-url.mjs, the database URL check and scrub that migrate.mjs, publish-bundle.sh and
// infra/flags/flags.mjs share (T-569; DL-363), run by `node --test "infra/ci/*.test.mjs"`. The scripts' own tests run
// each script with URLs it must refuse or fail on (the publish-bundle, flags, deploy-staging and migrate tests); these
// pin the parts and the scrub themselves. Every URL here is made up: no such user, password or database exists, and a
// .invalid host never resolves (RFC 6761).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DatabaseUrlFault, checkDatabaseUrl, describeError, scrub } from "../scripts/db-url.mjs";

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
});
