// Tests for T-1329's guard (DL-612, DL-617, DL-625): `npm run typecheck` refuses, in every file under db/ but its test
// files, the syntax Node's type stripping cannot run (parameter properties, enums, namespaces), and allows it
// elsewhere. Run by `npm run test:ci-scripts`.
//
// Node runs db/ straight from TypeScript (db/seeds/run.mjs, infra/flags/flags.mjs, seed-staging.test.mjs) and stops
// at such a line with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX, as train 143's CI script tests did at db/repo/clocks.ts.
// db/tsconfig.json checks db/ a second time with erasableSyntaxOnly; wrangler and Vitest transform the rest of the
// repository, and Vitest runs db/'s own *.test.ts files, so the syntax stays allowed there.
//
// Each case builds a throwaway repository with this repository's tsconfig.base.json, tsconfig.json and
// db/tsconfig.json, its typecheck script line and its node_modules (a link), plants files there and runs
// `npm run typecheck` as written. Nothing is planted in this repository. No database, no network.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { REPO, cleanEnv, tempDir, write } from "./script-harness.mjs";

const CONFIGS = ["tsconfig.base.json", "tsconfig.json", "db/tsconfig.json"];
const TYPECHECK = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).scripts.typecheck;

const lines = (...text) => `${text.join("\n")}\n`;

// A parameter property, as DataAccessDatabaseError's constructor had it before T-1268's round 4 (line 2).
const PARAMETER_PROPERTY = lines(
  "export class Refused extends Error {",
  "  constructor(readonly call: string) {",
  "    super(call);",
  "  }",
  "}",
);
// An enum and a namespace that holds a value (line 1 each).
const ENUM = lines("export enum Answer {", '  Yes = "yes",', "}");
const NAMESPACE = lines("export namespace Keys {", '  export const first = "a";', "}");
// The same class without the syntax: the field declared, then set in the constructor (T-1268's round 4).
const PLAIN = lines(
  "export class Refused extends Error {",
  "  readonly call: string;",
  "  constructor(call: string) {",
  "    super(call);",
  "    this.call = call;",
  "  }",
  "}",
);

// A throwaway repository holding this repository's three tsconfig files, its typecheck script line, a link to its
// node_modules, and `files` (path to text).
function repository(t, files) {
  const root = tempDir(t, "erasable-repo");
  for (const config of CONFIGS) {
    write(path.join(root, config), readFileSync(path.join(REPO, config), "utf8"));
  }
  const manifest = {
    name: "erasable-check",
    private: true,
    type: "module",
    scripts: { typecheck: TYPECHECK },
  };
  write(path.join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "dir");
  for (const [file, text] of Object.entries(files)) write(path.join(root, file), text);
  return root;
}

// `npm run typecheck` in that repository: its exit status, its output, and each error as "<file>:<line> <code>".
function typecheck(t, root) {
  const env = cleanEnv(tempDir(t, "erasable-home"));
  const result = spawnSync("npm", ["run", "typecheck"], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.error, undefined, `npm did not start: ${String(result.error)}`);
  const output = `${result.stdout}${result.stderr}`;
  const errors = [...output.matchAll(/^(\S[^(\n]*)\((\d+),\d+\): error (TS\d+):/gm)]
    .map(([, file, line, code]) => `${file}:${line} ${code}`)
    .sort();
  return { status: result.status, output, errors };
}

describe("npm run typecheck and the syntax Node's type stripping cannot run", () => {
  it("the typecheck script runs the root program, then db/tsconfig.json's", () => {
    assert.equal(TYPECHECK, "tsc --noEmit -p . && tsc --noEmit -p db");
    const db = readFileSync(path.join(REPO, "db/tsconfig.json"), "utf8");
    assert.match(db, /"extends": "\.\.\/tsconfig\.json"/);
    assert.match(db, /"erasableSyntaxOnly": true/);
    assert.match(db, /"include": \["\*\*\/\*"\]/);
    assert.match(db, /"exclude": \["\*\*\/\*\.test\.ts"\]/);
    const root = readFileSync(path.join(REPO, "tsconfig.json"), "utf8");
    assert.doesNotMatch(root, /erasableSyntaxOnly"\s*:/);
  });

  it("refuses a parameter property, an enum and a namespace in db/, naming each line, and no runtime/ file", (t) => {
    const root = repository(t, {
      "db/repo/planted-parameter.ts": PARAMETER_PROPERTY,
      "db/seeds/lib/planted-enum.ts": ENUM,
      "db/test/planted-namespace.ts": NAMESPACE,
      "runtime/src/planted-parameter.ts": PARAMETER_PROPERTY,
    });
    const { status, output, errors } = typecheck(t, root);
    assert.notEqual(status, 0, output);
    assert.deepEqual(
      errors,
      [
        "db/repo/planted-parameter.ts:2 TS1294",
        "db/seeds/lib/planted-enum.ts:1 TS1294",
        "db/test/planted-namespace.ts:1 TS1294",
      ],
      output,
    );
    assert.doesNotMatch(output, /runtime\//);
  });

  it("allows the same syntax in runtime/ files, beside a db/ file written without it", (t) => {
    const root = repository(t, {
      "db/repo/plain.ts": PLAIN,
      "runtime/src/planted-parameter.ts": PARAMETER_PROPERTY,
      "runtime/src/planted-enum.ts": ENUM,
      "runtime/src/planted-namespace.ts": NAMESPACE,
    });
    const { status, output, errors } = typecheck(t, root);
    assert.deepEqual(errors, [], output);
    assert.equal(status, 0, output);
  });

  it("allows the same syntax in db/'s own test files, which Vitest runs (DL-625)", (t) => {
    // A parameter property as the RolledBack class of db/'s integration tests holds it, an enum and a namespace, each
    // in a db/ test file of one of the two names Vitest runs there, beside a db/ file written without the syntax.
    const root = repository(t, {
      "db/repo/plain.ts": PLAIN,
      "db/repo/planted-parameter.int.test.ts": PARAMETER_PROPERTY,
      "db/seeds/lib/planted-enum.test.ts": ENUM,
      "db/test/planted-namespace.int.test.ts": NAMESPACE,
    });
    const { status, output, errors } = typecheck(t, root);
    assert.deepEqual(errors, [], output);
    assert.equal(status, 0, output);
  });
});
