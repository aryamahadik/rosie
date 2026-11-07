// Tests for wrangler.jsonc (T-276): the HANDLE_ACTOR Durable Object binding and its class migration, and that no
// production route or key is added. Run in ci.yml by `node --test "infra/ci/*.test.mjs"`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { REPO } from "./script-harness.mjs";

// Strip // and /* */ comments outside strings, then trailing commas, then parse.
function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const raw = readFileSync(path.join(REPO, "wrangler.jsonc"), "utf8");
const config = parseJsonc(raw);

describe("wrangler.jsonc HandleActor binding", () => {
  it("declares exactly the HANDLE_ACTOR binding on class HandleActor", () => {
    assert.deepEqual(config.durable_objects, {
      bindings: [{ name: "HANDLE_ACTOR", class_name: "HandleActor" }],
    });
  });

  it("has one migration tag creating HandleActor as a SQLite class", () => {
    assert.equal(config.migrations.length, 1);
    const [m] = config.migrations;
    assert.equal(m.tag, "v1-handle-actor");
    assert.deepEqual(m.new_sqlite_classes, ["HandleActor"]);
    assert.equal(m.new_classes, undefined);
    assert.equal(m.deleted_classes, undefined);
    assert.equal(m.renamed_classes, undefined);
  });

  it("adds no production route or key", () => {
    assert.equal(config.routes, undefined);
    assert.equal(config.route, undefined);
    assert.deepEqual(config.secrets, { required: [] });
    assert.equal(config.env.staging.durable_objects, undefined);
    assert.deepEqual(
      config.env.staging.routes.map((r) => r.pattern),
      ["rosfield.com/test", "rosfield.com/test/*"],
    );
    assert.equal(config.vars.ENVIRONMENT, "production");
    assert.ok(!/(sk_|key|token)\s*["']?\s*:/i.test(JSON.stringify(config.vars)));
  });
});
