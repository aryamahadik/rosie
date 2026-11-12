// Tests for infra/scripts/hyperdrive-list.mjs, the `hyperdrive list` parser (ADR-014; T-1252), run by
// `node --test "infra/ci/*.test.mjs"`. The parser and its first two tests moved here from the spike T-1124
// (infra/spikes/hyperdrive-host/helpers.mjs and probe.test.mjs); the parser now also gives each row's user cell. The
// listings are made up in wrangler 4.158.0's shape: no real id, user, host or database.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { hyperdriveRow } from "../scripts/hyperdrive-list.mjs";
import { REPO } from "./script-harness.mjs";

// The shape wrangler 4.158.0's `hyperdrive list` prints (logger.table): its columns, in its order.
const HEAD = [
  "id",
  "name",
  "user",
  "host",
  "port",
  "scheme",
  "database",
  "caching",
  "mtls",
  "origin_connection_limit",
];
const ID_A = "0123456789abcdef0123456789abcdef";
const ID_B = "fedcba9876543210fedcba9876543210";
const HOST = "origin-host.example.test";
const DATABASE = "made_up_database_t1252";
const listRow = (id, name, caching, user = "origin_user") => [
  id,
  name,
  user,
  HOST,
  "5432",
  "PostgreSQL",
  DATABASE,
  caching,
  "{}",
  "",
];
const table = (rows, head = HEAD) => {
  const line = (cells) => `│ ${cells.join(" │ ")} │`;
  return [
    " ⛅️ wrangler 4.158.0",
    "📋 Listing Hyperdrive configs",
    "┌────┬────┐",
    line(head),
    "├────┼────┤",
    ...rows.map(line),
    "└────┴────┘",
    "",
  ].join("\n");
};

/** The exit code a listing's read throws with, or 0 when it reads. */
const exitCode = (listing, name = "rosie-staging-hyperdrive") => {
  try {
    hyperdriveRow(listing, name);
    return 0;
  } catch (error) {
    return error.exitCode;
  }
};

describe("hyperdrive-list.mjs reads one configuration's row", () => {
  it("the list reader gives only the id, the user and the caching cell of the named configuration", () => {
    const listing = table([
      listRow(ID_B, "another-config", "max_age: 60, stale_while_revalidate: 15", "another_user"),
      listRow(ID_A, "rosie-staging-hyperdrive", "disabled"),
    ]);
    assert.deepEqual(hyperdriveRow(listing, "rosie-staging-hyperdrive"), {
      id: ID_A,
      user: "origin_user",
      caching: "disabled",
    });
    assert.deepEqual(hyperdriveRow(listing, "another-config"), {
      id: ID_B,
      user: "another_user",
      caching: "max_age: 60, stale_while_revalidate: 15",
    });
    assert.equal(hyperdriveRow(listing, "rosie-staging"), null);
    // No table at all: the account has no configuration (what the list printed on Nov 11 2026).
    assert.equal(
      hyperdriveRow(" ⛅️ wrangler 4.158.0\n📋 Listing Hyperdrive configs\n", "rosie-staging-hyperdrive"),
      null,
    );
    // Colour codes around the table, as on a terminal.
    const coloured = listing.replaceAll("│", "\u001b[90m│\u001b[39m");
    assert.deepEqual(hyperdriveRow(coloured, "rosie-staging-hyperdrive"), {
      id: ID_A,
      user: "origin_user",
      caching: "disabled",
    });
  });

  it("the list reader refuses what it cannot read", () => {
    const twice = table([
      listRow(ID_A, "rosie-staging-hyperdrive", "disabled"),
      listRow(ID_B, "rosie-staging-hyperdrive", "disabled"),
    ]);
    assert.equal(exitCode(twice), 3);
    assert.equal(exitCode(table([listRow("not-an-id", "rosie-staging-hyperdrive", "disabled")])), 2);
    assert.equal(exitCode(table([listRow(ID_A.toUpperCase(), "rosie-staging-hyperdrive", "disabled")])), 2);
    assert.equal(exitCode("rosie-staging-hyperdrive exists, in words"), 2);
    assert.equal(exitCode("│ title │ value │\n│ rosie-staging-hyperdrive │ x │\n"), 2);
  });

  it("the user cell: each row's own, an empty cell as empty, and null when the table has no user column", () => {
    const job = "rosie-staging-hyperdrive-job";
    const app = "rosie-staging-hyperdrive-app";
    const listing = table([
      listRow(ID_A, job, "disabled", "rosie_worker_job"),
      listRow(ID_B, app, "disabled", "rosie_worker_app"),
    ]);
    assert.equal(hyperdriveRow(listing, job)?.user, "rosie_worker_job");
    assert.equal(hyperdriveRow(listing, app)?.user, "rosie_worker_app");
    // wrangler prints an origin with no user as an empty cell (database.origin.user ?? "").
    assert.equal(hyperdriveRow(table([listRow(ID_A, job, "disabled", "")]), job)?.user, "");
    // A table without the column: the user is not known, which is not the same as an empty one.
    const noUser = HEAD.filter((column) => column !== "user");
    const withoutUser = listRow(ID_A, job, "disabled").filter((_, at) => HEAD[at] !== "user");
    assert.deepEqual(hyperdriveRow(table([withoutUser], noUser), job), {
      id: ID_A,
      user: null,
      caching: "disabled",
    });
  });

  it("the cells are found by the table's own head, in whatever order its columns come", () => {
    const head = ["caching", "user", "name", "host", "id"];
    const listing = table(
      [["disabled", "rosie_worker_app", "rosie-staging-hyperdrive-app", HOST, ID_B]],
      head,
    );
    assert.deepEqual(hyperdriveRow(listing, "rosie-staging-hyperdrive-app"), {
      id: ID_B,
      user: "rosie_worker_app",
      caching: "disabled",
    });
    // No caching column: "?", as before the move.
    const plain = table([[ID_A, "rosie-staging-hyperdrive-job", "rosie_worker_job"]], ["id", "name", "user"]);
    assert.equal(hyperdriveRow(plain, "rosie-staging-hyperdrive-job")?.caching, "?");
  });

  it("the host and the database cells never leave it", () => {
    const listing = table([listRow(ID_A, "rosie-staging-hyperdrive-job", "disabled", "rosie_worker_job")]);
    const row = hyperdriveRow(listing, "rosie-staging-hyperdrive-job");
    assert.deepEqual(Object.keys(row ?? {}).sort(), ["caching", "id", "user"]);
    const text = JSON.stringify(row);
    for (const cell of [HOST, DATABASE, "5432", "PostgreSQL"]) {
      assert.equal(text.includes(cell), false, `the row holds the cell ${cell}`);
    }
    // Nor does any message the reader throws.
    const twice = table([
      listRow(ID_A, "rosie-staging-hyperdrive-job", "disabled"),
      listRow(ID_B, "rosie-staging-hyperdrive-job", "disabled"),
    ]);
    assert.throws(
      () => hyperdriveRow(twice, "rosie-staging-hyperdrive-job"),
      (error) => !error.message.includes(HOST) && !error.message.includes(DATABASE),
    );
  });
});

describe("hyperdrive-list.mjs is the one parser, in the shape the installed wrangler prints", () => {
  it("the installed wrangler's `hyperdrive list` prints the columns the parser reads, in that order", () => {
    // Read in wrangler's own code, never run: src/hyperdrive/list.ts, bundled into wrangler-dist/cli.js.
    const lines = readFileSync(path.join(REPO, "node_modules/wrangler/wrangler-dist/cli.js"), "utf8").split(
      "\n",
    );
    const at = lines.findIndex((line) => line.includes("Listing Hyperdrive configs"));
    assert.ok(at > 0, "wrangler-dist/cli.js no longer prints: Listing Hyperdrive configs");
    const block = lines.slice(at, at + 20).join("\n");
    const map = /databases\.map\(\(database\) => \(\{\n([\s\S]*?)\n\s*\}\)\)/.exec(block);
    assert.ok(
      map,
      "the list's table is no longer one databases.map((database) => ({ ... })) after its banner",
    );
    const columns = Array.from(map[1].matchAll(/^\s*([a-z_]+):/gm), ([, column]) => column);
    assert.deepEqual(columns, HEAD);
    assert.match(map[1], /^\s*user: database\.origin\.user \?\? "",?$/m);
  });

  it("the spike's helpers.mjs imports it from here, keeps no parser of its own, and its row command still prints the id and the caching cell", () => {
    const helpers = path.join(REPO, "infra/spikes/hyperdrive-host/helpers.mjs");
    const text = readFileSync(helpers, "utf8");
    assert.match(text, /^import \{ hyperdriveRow \} from "\.\.\/\.\.\/scripts\/hyperdrive-list\.mjs";$/m);
    assert.doesNotMatch(text, /function hyperdriveRow|COLOUR_CODES/);
    const listing = table([listRow(ID_A, "rosie-staging-hyperdrive", "disabled", "made_up_user")]);
    const result = spawnSync(process.execPath, [helpers, "row", "rosie-staging-hyperdrive"], {
      input: listing,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    // run.sh reads "<id><tab><caching>" (its ${row%%$'\t'*} and ${row#*$'\t'}): no user cell is added there.
    assert.equal(result.stdout, `${ID_A}\tdisabled\n`);
    const twice = table([
      listRow(ID_A, "rosie-staging-hyperdrive", "disabled"),
      listRow(ID_B, "rosie-staging-hyperdrive", "disabled"),
    ]);
    const refused = spawnSync(process.execPath, [helpers, "row", "rosie-staging-hyperdrive"], {
      input: twice,
      encoding: "utf8",
    });
    assert.equal(refused.status, 3);
    assert.equal(refused.stdout, "");
  });
});
