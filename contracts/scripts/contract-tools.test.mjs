// Tests for the contract tools (T-006), run by `npm run contracts:check` (the contracts workspace's check script:
// `node --test "scripts/*.test.mjs"`). Each test works on a throwaway copy in the system temp folder; nothing in
// contracts/ is changed.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parseFrozen } from "../../infra/ci/contract-freeze-guard.mjs";
import { checkContracts, main as checkMain, tableProblems } from "./check-fixtures.mjs";
import { generateTypes, typedSchemas } from "./gen-types.mjs";
import { CONTRACTS_DIR, createAjv, idFor, readJson } from "./lib.mjs";

const GUARD = fileURLToPath(new URL("../../infra/ci/contract-freeze-guard.mjs", import.meta.url));
const SAMPLE = "scripts/test-sample";
const REFUSED = `${SAMPLE}/fixtures/invalid/quote.decimal-cents.json`;
const ACCEPTED = `${SAMPLE}/fixtures/quote.ok.json`;
const TABLES = `${SAMPLE}/test-sample.v1.tables.json`;

function tempDir(t, label) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `rosie-contracts-${label}-`)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A copy of what the tools read: the shared formats and meta-schemas, and the sample. */
function copyContracts(t) {
  const dir = tempDir(t, "copy");
  for (const part of ["common", "db-schema/tables.meta.schema.json", SAMPLE]) {
    cpSync(path.join(CONTRACTS_DIR, part), path.join(dir, part), { recursive: true });
  }
  const at = (file) => path.join(dir, file);
  return {
    dir,
    write(file, data) {
      mkdirSync(path.dirname(at(file)), { recursive: true });
      writeFileSync(at(file), typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
    },
    read: (file) => readJson(at(file)),
    remove: (file) => rmSync(at(file)),
    check: () => checkContracts(dir),
  };
}

/** A minimal contract "widget" with v1 (frozen or not), for the frozen.json checks. */
function writeWidget(copy, { frozen } = {}) {
  copy.write("widget/widget.v1.schema.json", {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: idFor("widget/widget.v1.schema.json"),
    type: "object",
    properties: { a: { type: "integer" } },
    required: ["a"],
    additionalProperties: false,
  });
  copy.write("widget/fixtures/index.json", {
    fixtures: [
      { file: "a.ok.json", version: "v1", expect: "accept", shows: "an integer", source: "T-006 test" },
    ],
  });
  copy.write("widget/fixtures/a.ok.json", { a: 1 });
  if (frozen !== undefined) copy.write("widget/frozen.json", frozen);
}

describe("contracts check", () => {
  it("passes on the repository's contracts, the sample included", () => {
    const { errors, counts } = checkContracts();
    assert.deepEqual(errors, []);
    assert.ok(counts.accepted >= 1 && counts.refused >= 1, JSON.stringify(counts));
    assert.ok(counts.tableLists >= 1, JSON.stringify(counts));
  });

  it("passes the sample: its accepted fixture is accepted and its refused fixture refused", (t) => {
    const copy = copyContracts(t);
    const { errors, counts } = copy.check();
    assert.deepEqual(errors, []);
    const index = copy.read(`${SAMPLE}/fixtures/index.json`);
    assert.deepEqual(
      index.fixtures.map((entry) => entry.expect),
      ["accept", "refuse"],
    );
    assert.ok(counts.refused >= 1);
  });

  it("fails when the refused fixture is accepted", (t) => {
    const copy = copyContracts(t);
    copy.write(REFUSED, readFileSync(path.join(CONTRACTS_DIR, ACCEPTED), "utf8"));
    const { errors } = copy.check();
    assert.equal(errors.length, 1, errors.join("\n"));
    assert.match(
      errors[0],
      /quote\.decimal-cents\.json: must be refused by test-sample\.v1\.schema\.json .*but is accepted/,
    );
    const lines = [];
    assert.equal(checkMain(["--contracts", copy.dir], { write: (line) => lines.push(line) }), 1);
    assert.match(lines.join("\n"), /contracts check: FAILED/);
  });

  it("fails when the accepted fixture is refused", (t) => {
    const copy = copyContracts(t);
    copy.write(ACCEPTED, readFileSync(path.join(CONTRACTS_DIR, REFUSED), "utf8"));
    const { errors } = copy.check();
    assert.match(
      errors.join("\n"),
      /quote\.ok\.json: must be accepted by test-sample\.v1\.schema\.json, but is refused/,
    );
    assert.match(errors.join("\n"), /\/price\/cents must be integer/);
  });

  it("fails an unlisted fixture, a listed fixture that is missing, and a fixture listed for the wrong version", (t) => {
    const copy = copyContracts(t);
    copy.write(`${SAMPLE}/fixtures/stray.json`, { quote: "x" });
    const index = copy.read(`${SAMPLE}/fixtures/index.json`);
    index.fixtures.push({ file: "gone.json", version: "v1", expect: "accept", shows: "x", source: "x" });
    index.fixtures[0].version = "v1.1";
    copy.write(`${SAMPLE}/fixtures/index.json`, index);
    const text = copy.check().errors.join("\n");
    assert.match(text, /stray\.json: is not listed/);
    assert.match(text, /lists gone\.json, which does not exist/);
    assert.match(text, /quote\.ok\.json: its schema .*test-sample\.v1\.1\.schema\.json does not exist/);
  });

  it("fails an index that breaks the fixtures-index meta-schema", (t) => {
    const copy = copyContracts(t);
    const index = copy.read(`${SAMPLE}/fixtures/index.json`);
    index.fixtures[0].expect = "maybe";
    delete index.fixtures[1].source;
    copy.write(`${SAMPLE}/fixtures/index.json`, index);
    const text = copy.check().errors.join("\n");
    assert.match(text, /\/fixtures\/0\/expect must be equal to one of the allowed values/);
    assert.match(text, /\/fixtures\/1 must have required property 'source'/);
  });

  it("fails a schema whose $id or name does not follow the convention", (t) => {
    const copy = copyContracts(t);
    const schema = copy.read(`${SAMPLE}/test-sample.v1.schema.json`);
    schema.$id = "https://example.invalid/elsewhere.json";
    copy.write(`${SAMPLE}/test-sample.v1.schema.json`, schema);
    copy.write(`${SAMPLE}/other.v1.schema.json`, {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: idFor(`${SAMPLE}/other.v1.schema.json`),
    });
    const text = copy.check().errors.join("\n");
    assert.match(text, /test-sample\.v1\.schema\.json: "\$id" must be/);
    assert.match(text, /other\.v1\.schema\.json: a contract's schema file is named after its folder/);
  });

  it("fails a minor version that refuses what the older version accepts", (t) => {
    const copy = copyContracts(t);
    const schema = copy.read(`${SAMPLE}/test-sample.v1.schema.json`);
    schema.$id = idFor(`${SAMPLE}/test-sample.v1.1.schema.json`);
    schema.properties.note = { type: "string" };
    schema.required.push("note");
    copy.write(`${SAMPLE}/test-sample.v1.1.schema.json`, schema);
    const text = copy.check().errors.join("\n");
    assert.match(
      text,
      /quote\.ok\.json: is accepted by test-sample\.v1\.schema\.json but refused by test-sample\.v1\.1\.schema\.json/,
    );
  });

  it("passes a minor version that only adds an optional field", (t) => {
    const copy = copyContracts(t);
    const schema = copy.read(`${SAMPLE}/test-sample.v1.schema.json`);
    schema.$id = idFor(`${SAMPLE}/test-sample.v1.1.schema.json`);
    schema.properties.note = { type: "string" };
    copy.write(`${SAMPLE}/test-sample.v1.1.schema.json`, schema);
    assert.deepEqual(copy.check().errors, []);
  });
});

describe("frozen.json", () => {
  it("accepts the convention's shape at contracts/<name>/frozen.json", (t) => {
    const copy = copyContracts(t);
    writeWidget(copy, { frozen: { frozen: ["v1"] } });
    const { errors, counts } = copy.check();
    assert.deepEqual(errors, []);
    assert.equal(counts.frozen, 1);
  });

  it("refuses another shape, a version with no file, and a frozen.json where the guard does not look", (t) => {
    const copy = copyContracts(t);
    writeWidget(copy, { frozen: { frozen: ["v1", "v2"] } });
    copy.write(`${SAMPLE}/frozen.json`, { frozen: ["v1"] });
    copy.write("common/fixtures/frozen.json", '{"frozen":"v1"}\n');
    const text = copy.check().errors.join("\n");
    assert.match(text, /widget\/frozen\.json: freezes v2, but no schema or tables file of v2/);
    assert.match(
      text,
      /scripts\/test-sample\/frozen\.json: the frozen-contract guard reads frozen\.json only at contracts\/<name>\/frozen\.json/,
    );
    assert.match(text, /common\/fixtures\/frozen\.json/);
  });

  it('refuses a frozen.json that is not {"frozen": [versions]}', (t) => {
    const copy = copyContracts(t);
    writeWidget(copy, { frozen: { frozen: "v1" } });
    assert.match(copy.check().errors.join("\n"), /widget\/frozen\.json: \/frozen must be array/);
  });
});

describe("db-schema table list meta-schema", () => {
  const meta = readJson(path.join(CONTRACTS_DIR, "db-schema/tables.meta.schema.json"));
  const validate = createAjv().compile(meta);
  const sample = () => readJson(path.join(CONTRACTS_DIR, TABLES));
  const errorsOf = (list) =>
    validate(list) ? [] : validate.errors.map((e) => `${e.instancePath} ${e.message}`);

  it("accepts the sample table list, which holds every kind of entry item 3 names", () => {
    const list = sample();
    assert.deepEqual(errorsOf(list), []);
    assert.deepEqual(tableProblems(list), []);
    const [table] = list.tables;
    assert.ok(table.columns.length > 0 && table.primaryKey.length > 0);
    assert.ok(table.foreignKeys.length > 0 && table.unique.length > 0 && table.indexes.length > 0);
    assert.ok(table.exclude.length > 0 && table.checks.length > 0);
    assert.equal(table.rowLevelSecurity.scope, "business");
    assert.equal(table.versioned, true);
    assert.equal(table.effectiveDates, true);
    assert.ok(table.columns.some((column) => column.sealedBy !== undefined));
    assert.ok(table.columns.some((column) => column.writtenOnceAtBooking === true));
    const audiences = new Set(table.columns.map((column) => JSON.stringify(column.audience)));
    assert.ok(audiences.has('"never"') && audiences.has('"secure-page-only"'));
    assert.ok([...audiences].some((audience) => audience.startsWith("[")));
  });

  it("refuses a column without an audience, and an audience outside the list", () => {
    const list = sample();
    delete list.tables[0].columns[0].audience;
    list.tables[0].columns[1].audience = ["everyone"];
    const errors = errorsOf(list).join("\n");
    assert.match(errors, /\/tables\/0\/columns\/0 must have required property 'audience'/);
    assert.match(errors, /\/tables\/0\/columns\/1\/audience/);
  });

  it("refuses a table without its row-level security scope, version flag or effective-date flag", () => {
    for (const key of ["rowLevelSecurity", "versioned", "effectiveDates"]) {
      const list = sample();
      Reflect.deleteProperty(list.tables[0], key);
      assert.match(errorsOf(list).join("\n"), new RegExp(`must have required property '${key}'`), key);
    }
  });

  it("refuses a business scope without its column, and a versioned table without its version column", () => {
    const list = sample();
    list.tables[0].rowLevelSecurity = { scope: "business" };
    delete list.tables[0].versionColumn;
    const errors = errorsOf(list).join("\n");
    assert.match(errors, /\/tables\/0\/rowLevelSecurity/);
    assert.match(errors, /must have required property 'versionColumn'/);
  });

  it("refuses an EXCLUDE or CHECK constraint without its source", () => {
    const list = sample();
    delete list.tables[0].exclude[0].source;
    delete list.tables[0].checks[0].source;
    const errors = errorsOf(list).join("\n");
    assert.match(errors, /\/tables\/0\/exclude\/0 must have required property 'source'/);
    assert.match(errors, /\/tables\/0\/checks\/0 must have required property 'source'/);
  });

  it("reports a key, constraint or seal that names a column the table does not have", (t) => {
    const list = sample();
    list.tables[0].exclude[0].elements[0].column = "room_id";
    list.tables[0].columns.find((column) => column.sealedBy !== undefined).sealedBy = "owner_id";
    const problems = tableProblems(list).join("\n");
    assert.match(problems, /exclude sample_reservations_no_overlap names column room_id/);
    assert.match(problems, /sealedBy names column owner_id/);
    const copy = copyContracts(t);
    copy.write(TABLES, list);
    assert.match(
      copy.check().errors.join("\n"),
      /test-sample\.v1\.tables\.json: table sample_reservations: exclude/,
    );
  });
});

describe("contract types", () => {
  it("types every contract schema, but no meta-schema and not the tools' sample", () => {
    const files = typedSchemas();
    assert.ok(files.includes("common/formats.v1.schema.json"), files.join(", "));
    assert.ok(!files.some((file) => file.endsWith(".meta.schema.json") || file.startsWith("scripts/")));
  });

  it("writes TypeScript for the sample, with the shared formats resolved through $ref", async (t) => {
    const out = tempDir(t, "types");
    const written = await generateTypes({ outDir: out, files: [`${SAMPLE}/test-sample.v1.schema.json`] });
    assert.deepEqual(written, [`${SAMPLE}/test-sample.v1.ts`]);
    const code = readFileSync(path.join(out, written[0]), "utf8");
    assert.match(code, /Generated by contracts\/scripts\/gen-types\.mjs .*never edit or commit/);
    assert.match(code, /export interface TestSampleV1 \{/);
    assert.match(code, /price: Money;/);
    assert.match(code, /cents: number;/);
    assert.match(code, /kind: "visit" \| "class";/);
  });
});

// The frozen-contract guard of T-005 (infra/ci/contract-freeze-guard.mjs), run on the sample laid out as a real
// contract, contracts/test-sample/, in a throwaway git repository with a fake origin/main.
describe("frozen-contract guard on the sample", () => {
  function gitEnvironment(dir) {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith("GIT_") && !key.startsWith("GITHUB_")) env[key] = value;
    }
    return {
      ...env,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CEILING_DIRECTORIES: path.dirname(dir),
      GIT_AUTHOR_NAME: "Contract Test",
      GIT_AUTHOR_EMAIL: "contract-test@example.invalid",
      GIT_COMMITTER_NAME: "Contract Test",
      GIT_COMMITTER_EMAIL: "contract-test@example.invalid",
    };
  }

  function sampleRepo(t, { freeze }) {
    const dir = tempDir(t, "guard");
    const env = gitEnvironment(dir);
    const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: "pipe" });
    git("init", "-q", "-b", "main");
    cpSync(path.join(CONTRACTS_DIR, SAMPLE), path.join(dir, "contracts/test-sample"), { recursive: true });
    if (freeze) writeFileSync(path.join(dir, "contracts/test-sample/frozen.json"), '{ "frozen": ["v1"] }\n');
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("switch", "-q", "-c", "task/T-999");
    return {
      edit(file, change) {
        const at = path.join(dir, "contracts/test-sample", file);
        const before = readFileSync(at, "utf8");
        const after = change(before);
        assert.notEqual(after, before, `the test's edit to ${file} changed nothing`);
        writeFileSync(at, after);
      },
      add(file, text) {
        const at = path.join(dir, "contracts/test-sample", file);
        mkdirSync(path.dirname(at), { recursive: true });
        writeFileSync(at, text);
      },
      guard: () => spawnSync(process.execPath, [GUARD], { cwd: dir, env, encoding: "utf8" }),
    };
  }

  const loosen = (text) => text.replace('"enum": ["visit", "class"]', '"enum": ["visit", "class", "trip"]');

  it("the frozen.json the convention writes is what the guard reads", (t) => {
    const copy = copyContracts(t);
    const text = '{ "frozen": ["v1", "v1.1"] }\n';
    copy.write("widget/frozen.json", text);
    writeWidget(copy);
    copy.write("widget/widget.v1.1.schema.json", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: idFor("widget/widget.v1.1.schema.json"),
    });
    assert.deepEqual(copy.check().errors, []);
    assert.deepEqual([...parseFrozen(text)], ["1", "1.1"]);
  });

  it("fails an edit to the sample's schema and to its refused fixture once v1 is frozen", (t) => {
    const repo = sampleRepo(t, { freeze: true });
    repo.edit("test-sample.v1.schema.json", loosen);
    repo.edit("fixtures/invalid/quote.decimal-cents.json", (text) => text.replace("45.5", "45"));
    const run = repo.guard();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /contracts\/test-sample\/test-sample\.v1\.schema\.json: edits a file of v1/);
    assert.match(run.stdout, /quote\.decimal-cents\.json: edits a fixture of v1/);
  });

  it("passes adding a minor version beside the frozen v1", (t) => {
    const repo = sampleRepo(t, { freeze: true });
    repo.add("test-sample.v1.1.schema.json", "{}\n");
    const run = repo.guard();
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });

  it("passes the same edit while v1 is not frozen", (t) => {
    const repo = sampleRepo(t, { freeze: false });
    repo.edit("test-sample.v1.schema.json", loosen);
    const run = repo.guard();
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
});
