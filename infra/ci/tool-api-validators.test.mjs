// Tests for infra/build/tool-api-validators.mjs, `npm run build:validators` (T-1215; T-1153's security review, new
// task 2), run in ci.yml by `node --test "infra/ci/*.test.mjs"`: the build reads only inside contracts/. Every $ref and
// every fixture index's file entry is resolved, "..", absolute paths and symbolic links followed, and one that leads
// outside contracts/ is refused before anything is read from it; a file that is not JSON fails naming the file only.
// The preview runs this build on a branch before review (infra/scripts/deploy-preview.sh), so a branch's contract
// must not make it print a file from outside contracts/ (JSON.parse's message quotes a text's first characters) or
// copy one into ajv-answers.js.
//
// Each test works on a throwaway checkout in the system temp folder: the build script, a copy of contracts/ and
// node_modules linked to this repository's, with outside.txt and outside.json beside contracts/, which no build may
// read. Their text holds SEEN, which must appear nowhere the build prints or writes.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  MESSAGE_PLAN_FILES,
  ajvAnswers,
  composeInputAnswers,
  composeInputDefinitionsOf,
  definitionsOf,
  readSchemas,
} from "../build/tool-api-validators.mjs";
import { REPO, cleanEnv, tempDir, write } from "./script-harness.mjs";

const BUILD = path.join("infra", "build", "tool-api-validators.mjs");
const GENERATED = path.join("actions", "src", "tool-api", "generated");
const GENERATED_FILES = [
  "validators.js",
  "validators.d.ts",
  "ajv-answers.js",
  "ajv-answers.d.ts",
  "compose-input-validators.js",
  "compose-input-validators.d.ts",
  "compose-input-answers.js",
  "compose-input-answers.d.ts",
];

/** The first characters of outside.txt, and outside.json's key: neither may appear in what the build prints or writes. */
const SEEN = "zq7Xv9";
const OUTSIDE_TEXT = `${SEEN} stands for a file outside contracts/ that no build may read (T-1215); it is not JSON\n`;
const OUTSIDE_JSON = `{ "${SEEN}": "stands for a JSON file outside contracts/ that no build may read (T-1215)" }\n`;

/** How each refusal ends. */
const REFUSED = "refused, and nothing was read from it";

/**
 * A throwaway checkout, laid out as the preview's worktree is for the build: package.json (an ES module package, as
 * this repository's is), the build script, a copy of contracts/ (without the git-ignored contracts/generated/) and
 * node_modules linked to this repository's, so Ajv and the generated code's run-time helpers resolve. Beside
 * contracts/: outside.txt and outside.json. Returns { root, contracts }.
 */
function checkout(t) {
  const root = tempDir(t, "validators");
  write(path.join(root, "package.json"), '{ "type": "module" }\n');
  write(path.join(root, BUILD), readFileSync(path.join(REPO, BUILD), "utf8"));
  const contractTypes = path.join(REPO, "contracts", "generated");
  cpSync(path.join(REPO, "contracts"), path.join(root, "contracts"), {
    recursive: true,
    filter: (source) => source !== contractTypes,
  });
  symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "dir");
  write(path.join(root, "outside.txt"), OUTSIDE_TEXT);
  write(path.join(root, "outside.json"), OUTSIDE_JSON);
  return { root, contracts: path.join(root, "contracts") };
}

/** Runs the checkout's build as the preview does (node, from the checkout's root): { status, stdout, stderr }. */
function build(t, root) {
  return spawnSync(process.execPath, [BUILD], {
    cwd: root,
    env: cleanEnv(tempDir(t, "validators-home")),
    encoding: "utf8",
    timeout: 120_000,
  });
}

/** The generated files the checkout's build left in place. */
const generated = (root) => GENERATED_FILES.filter((name) => existsSync(path.join(root, GENERATED, name)));

/** The build failed with exactly one FAIL line, `message`; it printed nothing of SEEN and wrote no generated file. */
function assertFailed(root, run, message) {
  assert.equal(run.status, 1, `exit code ${String(run.status)}; stderr: ${run.stderr}`);
  assert.equal(run.stdout, `FAIL tool-api validators: ${message}\n`);
  assert.ok(!run.stdout.includes(SEEN), "stdout holds text from outside contracts/");
  assert.ok(!run.stderr.includes(SEEN), "stderr holds text from outside contracts/");
  assert.deepEqual(generated(root), []);
}

/** A file of contracts/ by its path relative to contracts/. */
const at = (contracts, file) => path.join(contracts, ...file.split("/"));
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

/** Gives the schema `file` (relative to contracts/) a definition t1215 that is only a $ref to `ref`. */
function addRef(contracts, file, ref) {
  const schema = readJson(at(contracts, file));
  schema.$defs = { ...schema.$defs, t1215: { $ref: ref } };
  writeJson(at(contracts, file), schema);
}

/**
 * Puts an entry first in the fixture index `index` (relative to contracts/): its first entry with `def` and `file`. Each
 * def given is one the build checks, so the build before T-1215 read that file.
 */
function addEntry(contracts, index, def, file) {
  const value = readJson(at(contracts, index));
  value.fixtures.unshift({ ...value.fixtures[0], def, file });
  writeJson(at(contracts, index), value);
}

/** Replaces `file` (relative to contracts/) with a symbolic link to `target`. */
function link(contracts, file, target) {
  rmSync(at(contracts, file), { recursive: true, force: true });
  symlinkSync(target, at(contracts, file));
}

/** ajvAnswers on `contracts`: the checks of the Tool API's, the span's and K-02's fixtures. */
function answers(contracts) {
  const schemas = readSchemas(contracts);
  return ajvAnswers(schemas, definitionsOf(schemas), contracts);
}

/** composeInputAnswers on `contracts`: the checks of compose input's fixtures. */
function composeAnswers(contracts) {
  const schemas = readSchemas(contracts, MESSAGE_PLAN_FILES);
  return composeInputAnswers(schemas, composeInputDefinitionsOf(schemas), contracts);
}

describe("tool-api-validators.mjs reads only inside contracts/ (T-1215)", () => {
  it("refuses a $ref that leaves contracts/ through '..': nothing of its target printed, nothing written", (t) => {
    for (const target of ["outside.txt", "outside.json"]) {
      const { root, contracts } = checkout(t);
      addRef(contracts, "event-trace/event-trace.v1.1.schema.json", `../../${target}`);
      assertFailed(
        root,
        build(t, root),
        `event-trace/event-trace.v1.1.schema.json's $ref "../../${target}" leads outside contracts/: ${REFUSED}`,
      );
    }
  });

  it("refuses a fixture index entry that leaves contracts/ through '..': nothing printed, nothing in ajv-answers.js", (t) => {
    for (const target of ["outside.json", "outside.txt"]) {
      const { root, contracts } = checkout(t);
      addEntry(contracts, "tool-api/fixtures/index.json", "composeInput.request", `../../../${target}`);
      assertFailed(
        root,
        build(t, root),
        `tool-api/fixtures/index.json's file "../../../${target}" leads outside contracts/: ${REFUSED}`,
      );
    }
  });

  it("refuses a symbolic link out of contracts/: nothing of its target printed, nothing written", (t) => {
    const { root, contracts } = checkout(t);
    link(contracts, "event-trace/event-trace.v1.1.schema.json", path.join(root, "outside.txt"));
    assertFailed(
      root,
      build(t, root),
      `the schema file "event-trace/event-trace.v1.1.schema.json" leads outside contracts/ through a symbolic link: ${REFUSED}`,
    );
  });

  it("names only the file when a file it reads in contracts/ is not JSON, never its first characters", (t) => {
    const { root, contracts } = checkout(t);
    writeFileSync(at(contracts, "common/formats.v1.schema.json"), OUTSIDE_TEXT);
    assertFailed(root, build(t, root), "common/formats.v1.schema.json is not valid JSON");
  });

  it("builds this repository's contracts: exit 0 and the eight files written", (t) => {
    const { root } = checkout(t);
    const run = build(t, root);
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(
      run.stdout,
      /^tool-api validators: \d+ standalone validators from \d+ schema files written to actions\/src\/tool-api\/generated /,
    );
    assert.deepEqual(generated(root), GENERATED_FILES);
  });

  it("refuses an entry leaving contracts/ in each fixture index, at each place the build reads one", (t) => {
    const places = [
      ["tool-api/fixtures/index.json", "composeInput.request", answers],
      ["event-trace/fixtures/index.json", "span", answers],
      ["model/fixtures/index.json", "choice", answers],
      ["message-plan/fixtures/index.json", "composeInput", composeAnswers],
      ["tool-api/fixtures/index.json", "composeInput.exchange", composeAnswers],
    ];
    for (const [index, def, run] of places) {
      const { contracts } = checkout(t);
      addEntry(contracts, index, def, "../../../outside.json");
      assert.throws(
        () => run(contracts),
        { message: `${index}'s file "../../../outside.json" leads outside contracts/: ${REFUSED}` },
        `${index}, ${def}, read by ${run.name}`,
      );
    }
  });

  it("refuses a $ref by an absolute path, and one by $id that climbs out of contracts/", (t) => {
    const { root, contracts } = checkout(t);
    const outside = path.join(root, "outside.json");
    addRef(contracts, "event-trace/event-trace.v1.1.schema.json", outside);
    assert.throws(() => readSchemas(contracts), {
      message: `event-trace/event-trace.v1.1.schema.json's $ref ${JSON.stringify(outside)} leads outside contracts/: ${REFUSED}`,
    });

    const byId = "https://rosie.invalid/contracts/../outside.json";
    addRef(contracts, "event-trace/event-trace.v1.1.schema.json", byId);
    assert.throws(() => readSchemas(contracts), {
      message: `event-trace/event-trace.v1.1.schema.json's $ref "${byId}" leads outside contracts/: ${REFUSED}`,
    });
  });

  it("refuses a fixture index entry by an absolute path", (t) => {
    const { root, contracts } = checkout(t);
    const outside = path.join(root, "outside.json");
    addEntry(contracts, "tool-api/fixtures/index.json", "composeInput.request", outside);
    assert.throws(() => answers(contracts), {
      message: `tool-api/fixtures/index.json's file ${JSON.stringify(outside)} leads outside contracts/: ${REFUSED}`,
    });
  });

  it("refuses a fixture, and a folder of fixtures, that is a symbolic link out of contracts/", (t) => {
    const { root, contracts } = checkout(t);
    const index = "tool-api/fixtures/index.json";
    const { file } = readJson(at(contracts, index)).fixtures[0];
    link(contracts, `tool-api/fixtures/${file}`, path.join(root, "outside.json"));
    assert.throws(() => answers(contracts), {
      message: `${index}'s file "${file}" leads outside contracts/ through a symbolic link: ${REFUSED}`,
    });

    const folder = checkout(t);
    write(path.join(folder.root, "outside-folder", "outside.json"), OUTSIDE_JSON);
    symlinkSync(path.join(folder.root, "outside-folder"), at(folder.contracts, "tool-api/fixtures/linked"));
    addEntry(folder.contracts, index, "composeInput.request", "linked/outside.json");
    assert.throws(() => answers(folder.contracts), {
      message: `${index}'s file "linked/outside.json" leads outside contracts/ through a symbolic link: ${REFUSED}`,
    });
  });

  it("refuses a path that only begins with contracts/'s own name", (t) => {
    const { root, contracts } = checkout(t);
    write(path.join(root, "contracts-other", "outside.json"), OUTSIDE_JSON);
    addRef(contracts, "event-trace/event-trace.v1.1.schema.json", "../../contracts-other/outside.json");
    assert.throws(() => readSchemas(contracts), {
      message: `event-trace/event-trace.v1.1.schema.json's $ref "../../contracts-other/outside.json" leads outside contracts/: ${REFUSED}`,
    });
  });

  it("follows '..' and symbolic links that stay inside contracts/, and records each file by its own name", (t) => {
    const { contracts } = checkout(t);
    mkdirSync(at(contracts, "common/kept"));
    cpSync(at(contracts, "common/formats.v1.schema.json"), at(contracts, "common/kept/formats.json"));
    link(contracts, "common/formats.v1.schema.json", at(contracts, "common/kept/formats.json"));
    addRef(
      contracts,
      "event-trace/event-trace.v1.1.schema.json",
      "../model/../common/formats.v1.schema.json",
    );
    const read = readSchemas(contracts);
    const main = readSchemas(path.join(REPO, "contracts"));
    assert.deepEqual(
      read.map(({ file }) => file),
      main.map(({ file }) => file),
    );
    const formats = (schemas) => schemas.find(({ file }) => file === "common/formats.v1.schema.json")?.sha256;
    assert.equal(formats(read), formats(main));
  });

  it("names only the file when a fixture it reads is not JSON, never its first characters", (t) => {
    const { contracts } = checkout(t);
    writeFileSync(at(contracts, "tool-api/fixtures/not-json.json"), OUTSIDE_TEXT);
    addEntry(contracts, "tool-api/fixtures/index.json", "composeInput.request", "not-json.json");
    assert.throws(() => answers(contracts), { message: "tool-api/fixtures/not-json.json is not valid JSON" });
  });
});
