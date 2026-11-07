// Tests for the structured-outputs subset lint (T-011), run by `npm run contracts:check`. Nothing in contracts/ is
// changed: the negative cases are small schemas written here, and the throwaway copies live in the system temp folder.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { CONTRACTS_DIR, createAjv, readJson } from "./lib.mjs";
import {
  LIMITS,
  MODEL_FACING,
  bundleSchema,
  lintModelFacing,
  lintSchema,
  main,
  patternProblems,
} from "./structured-subset-lint.mjs";

const fixture = (file) => readJson(path.join(CONTRACTS_DIR, "model/fixtures", file));
const index = () => fixture("index.json").fixtures;
const bundled = (def) => bundleSchema({ schema: "model/model.v1.schema.json", def });

/** A one-object schema with the given property schema, for the negative cases. */
const withProperty = (property) => ({
  type: "object",
  properties: { x: property },
  required: ["x"],
  additionalProperties: false,
});
const errorsOf = (schema) => lintSchema(schema).errors.join("\n");

describe("structured-subset lint on the repository", () => {
  it("lists K-02's decide read, safety read and planner output", () => {
    assert.deepEqual(
      MODEL_FACING.map(({ schema, def }) => `${schema}#${def}`),
      [
        "model/model.v1.schema.json#decideRead",
        "model/model.v1.schema.json#safetyRead",
        "model/model.v1.schema.json#plannerOutput",
      ],
    );
  });

  it("passes every model-facing schema, bundled, inside the per-request limits", () => {
    for (const result of lintModelFacing()) {
      assert.deepEqual(result.errors, [], result.name);
      assert.ok(result.counts.optionalProperties <= LIMITS.optionalProperties, result.name);
      assert.ok(result.counts.unionParameters <= LIMITS.unionParameters, result.name);
    }
    const lines = [];
    assert.equal(main([], { write: (line) => lines.push(line) }), 0, lines.join("\n"));
  });

  it("bundles every $ref into the schema's own $defs: no external $ref is left", () => {
    for (const { def } of MODEL_FACING) {
      const text = JSON.stringify(bundled(def));
      assert.doesNotMatch(text, /schema\.json/, def);
      assert.doesNotMatch(text, /"\$(id|schema)"/, def);
      for (const ref of text.match(/"\$ref":"[^"]*"/g) ?? []) assert.match(ref, /"#\/\$defs\//, def);
    }
    const decide = bundled("decideRead");
    assert.ok(
      decide.$defs.money && decide.$defs.time && decide.$defs.currency,
      "formats.v1's money and time are copied in",
    );
  });

  it("keeps the meaning: the bundled forms accept and refuse the K-02 fixtures as the contract does", () => {
    const ajv = createAjv();
    const decide = ajv.compile(bundled("decideRead"));
    const safety = ajv.compile(bundled("safetyRead"));
    const planner = ajv.compile(bundled("plannerOutput"));
    let checked = 0;
    for (const entry of index()) {
      const payload = fixture(entry.file);
      if (entry.def === "decideResult") {
        for (const read of payload.reads) {
          assert.ok(decide(read.output), `${entry.file}: ${JSON.stringify(decide.errors)}`);
          checked += 1;
        }
      } else if (entry.def === "safetyResult" && payload.read !== null) {
        assert.ok(safety(payload.read), `${entry.file}: ${JSON.stringify(safety.errors)}`);
        checked += 1;
      } else if (entry.def === "decideRead") {
        assert.equal(decide(payload), entry.expect === "accept", entry.file);
        checked += 1;
      } else if (entry.def === "plannerOutput") {
        assert.equal(planner(payload), entry.expect === "accept", entry.file);
        checked += 1;
      }
    }
    assert.ok(checked >= 30, `only ${checked} payloads checked`);
  });
});

describe("structured-subset lint refuses what the subset leaves out", () => {
  it("refuses number and string-length limits", () => {
    for (const keyword of ["minimum", "maximum", "exclusiveMinimum", "multipleOf"]) {
      assert.match(
        errorsOf(withProperty({ type: "integer", [keyword]: 1 })),
        new RegExp(`"${keyword}" is outside`),
      );
    }
    for (const keyword of ["minLength", "maxLength"]) {
      assert.match(
        errorsOf(withProperty({ type: "string", [keyword]: 1 })),
        new RegExp(`"${keyword}" is outside`),
      );
    }
  });

  it("refuses array limits other than minItems 0 or 1, and tuples", () => {
    assert.match(
      errorsOf(withProperty({ type: "array", items: { type: "string" }, maxItems: 3 })),
      /"maxItems" is outside/,
    );
    assert.match(
      errorsOf(withProperty({ type: "array", items: { type: "string" }, minItems: 2 })),
      /"minItems" 2: only 0 or 1/,
    );
    assert.equal(errorsOf(withProperty({ type: "array", items: { type: "string" }, minItems: 1 })), "");
    assert.match(
      errorsOf(withProperty({ type: "array", items: [{ type: "string" }] })),
      /tuples are outside/,
    );
    assert.match(errorsOf(withProperty({ type: "array", uniqueItems: true })), /"uniqueItems" is outside/);
  });

  it("refuses additionalProperties other than false, and an object without it", () => {
    assert.match(
      errorsOf({ type: "object", properties: {}, additionalProperties: true }),
      /may only be false/,
    );
    assert.match(
      errorsOf({ type: "object", properties: {}, additionalProperties: { type: "string" } }),
      /may only be false/,
    );
    assert.match(errorsOf({ type: "object", properties: {} }), /must set "additionalProperties": false/);
    assert.match(
      errorsOf(withProperty({ type: "object", properties: { y: { type: "string" } } })),
      /#\/properties\/x: an object must set/,
    );
  });

  it("refuses recursive schemas, through the root or through $defs", () => {
    assert.match(errorsOf(withProperty({ $ref: "#" })), /recursive/);
    const cycle = {
      ...withProperty({ $ref: "#/$defs/a" }),
      $defs: { a: withProperty({ $ref: "#/$defs/b" }), b: withProperty({ $ref: "#/$defs/a" }) },
    };
    assert.match(errorsOf(cycle), /a recursive schema: a -> b -> a/);
  });

  it("refuses an external or unresolved $ref, and allOf with $ref", () => {
    assert.match(
      errorsOf(withProperty({ $ref: "../common/formats.v1.schema.json#/$defs/id" })),
      /is not local/,
    );
    assert.match(errorsOf(withProperty({ $ref: "#/$defs/missing" })), /does not resolve/);
    const allOf = { ...withProperty({ allOf: [{ $ref: "#/$defs/a" }] }), $defs: { a: { type: "string" } } };
    assert.match(errorsOf(allOf), /"allOf" with "\$ref" is not supported/);
  });

  it("refuses keywords outside the list: not, if, oneOf, dependentSchemas, patternProperties", () => {
    for (const keyword of ["not", "if", "oneOf", "dependentSchemas", "patternProperties", "propertyNames"]) {
      assert.match(
        errorsOf(withProperty({ type: "string", [keyword]: {} })),
        new RegExp(`"${keyword}" is outside`),
      );
    }
  });

  it("refuses complex enum values, an unsupported format, and a root that is not an object", () => {
    assert.match(errorsOf(withProperty({ enum: ["a", { b: 1 }] })), /no complex values/);
    assert.match(errorsOf(withProperty({ type: "string", format: "regex" })), /"format" "regex" is not one/);
    assert.equal(errorsOf(withProperty({ type: "string", format: "date-time" })), "");
    assert.match(errorsOf({ type: "string" }), /the root must be "type": "object"/);
  });

  it("refuses patterns with backreferences, lookarounds, word boundaries, open or large bounds", () => {
    assert.deepEqual(patternProblems("^[a-z]{2}$"), []);
    assert.deepEqual(patternProblems("\\S"), []);
    assert.deepEqual(patternProblems("^[0-9]{4}-[0-9]{2}$"), []);
    assert.deepEqual(patternProblems("[\\b]"), [], "a backspace in a class is not a word boundary");
    assert.deepEqual(patternProblems("(a)\\1"), ["a backreference"]);
    assert.deepEqual(patternProblems("(?=a)b"), ["a lookahead"]);
    assert.deepEqual(patternProblems("(?<!a)b"), ["a lookbehind"]);
    assert.deepEqual(patternProblems("\\bword\\b"), ["a word boundary"]);
    assert.deepEqual(patternProblems("a{2,}"), ["an open bound {2,}"]);
    assert.deepEqual(patternProblems("a{1,500}"), ["a bound over 100 {1,500}"]);
    assert.match(errorsOf(withProperty({ type: "string", pattern: "(?=x)" })), /"pattern" has a lookahead/);
  });

  it("counts optional properties and union parameters against the per-request limits", () => {
    const optional = (n) => ({
      type: "object",
      properties: Object.fromEntries(Array.from({ length: n }, (_, k) => [`p${k}`, { type: "string" }])),
      additionalProperties: false,
    });
    assert.equal(lintSchema(optional(24)).errors.length, 0);
    assert.match(errorsOf(optional(25)), /25 optional properties, over the limit of 24/);
    const unions = (n) => ({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: n }, (_, k) => [
          `p${k}`,
          k % 2 ? { anyOf: [{ type: "string" }, { type: "null" }] } : { type: ["string", "null"] },
        ]),
      ),
      required: Array.from({ length: n }, (_, k) => `p${k}`),
      additionalProperties: false,
    });
    assert.equal(lintSchema(unions(16)).counts.unionParameters, 16);
    assert.equal(lintSchema(unions(16)).errors.length, 0);
    assert.match(errorsOf(unions(17)), /17 parameters with a union type, over the limit of 16/);
  });
});

describe("structured-subset lint on a broken copy", () => {
  it("fails main when a model-facing schema leaves the subset", (t) => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "rosie-subset-")));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const part of ["common", "bundle", "model"]) {
      cpSync(path.join(CONTRACTS_DIR, part), path.join(dir, part), { recursive: true });
    }
    const file = path.join(dir, "model/model.v1.schema.json");
    const schema = readJson(file);
    schema.$defs.nonEmptyText.minLength = 1;
    schema.$defs.plannerAsk.additionalProperties = true;
    writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`);
    const lines = [];
    assert.equal(main(["--contracts", dir], { write: (line) => lines.push(line) }), 1);
    const text = lines.join("\n");
    assert.match(
      text,
      /decideRead #\/\$defs\/nonEmptyText: "minLength" is outside the structured-outputs subset/,
    );
    assert.match(text, /plannerOutput #\/\$defs\/plannerAsk: "additionalProperties" may only be false/);
    assert.match(text, /structured-subset lint: FAILED/);
  });
});
