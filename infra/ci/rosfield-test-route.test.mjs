// T-1052: staging keeps exactly the two routes rosfield.com/test and rosfield.com/test/* (DL-023, DL-044), and the
// saved copy of the old /test page under infra/rosfield-test-backup/ matches its sha256 list (RK-51).
// Run in ci.yml by `node --test "infra/ci/*.test.mjs"`.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { REPO } from "./script-harness.mjs";

const WANTED = ["rosfield.com/test", "rosfield.com/test/*"];

// Strips // and /* */ comments (outside strings) and trailing commas from JSONC, then parses it.
export function parseJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function patternsOf(section) {
  const list = [...(section?.routes ?? [])];
  if (section?.route) list.push(section.route);
  return list.map((r) => (typeof r === "string" ? r : r.pattern));
}

// Returns a list of problems; empty means the routes are as DL-023 / DL-044 require.
export function routeProblems(config) {
  const problems = [];
  const staging = patternsOf(config.env?.staging).filter((p) => p.includes("rosfield.com"));
  if (JSON.stringify([...staging].sort()) !== JSON.stringify([...WANTED].sort())) {
    problems.push(`staging rosfield.com routes are [${staging.join(", ")}], expected [${WANTED.join(", ")}]`);
  }
  for (const [name, section] of [
    ["top level", config],
    ...Object.entries(config.env ?? {}).filter(([n]) => n !== "staging"),
  ]) {
    const other = patternsOf(section).filter((p) => p.includes("rosfield.com"));
    if (other.length > 0) problems.push(`${name} holds a rosfield.com route: ${other.join(", ")}`);
  }
  return problems;
}

function loadConfig() {
  return parseJsonc(readFileSync(path.join(REPO, "wrangler.jsonc"), "utf8"));
}

describe("staging's rosfield.com routes", () => {
  it("are exactly rosfield.com/test and rosfield.com/test/*, and no other section has one", () => {
    assert.deepEqual(routeProblems(loadConfig()), []);
  });

  it("fail on a planted extra pattern", () => {
    const config = loadConfig();
    config.env.staging.routes.push({ pattern: "rosfield.com/test*", zone_name: "rosfield.com" });
    assert.notDeepEqual(routeProblems(config), []);
  });

  it("fail on a missing route", () => {
    const config = loadConfig();
    config.env.staging.routes.pop();
    assert.notDeepEqual(routeProblems(config), []);
  });

  it("fail on a route in the production section", () => {
    const config = loadConfig();
    config.routes = [{ pattern: "rosfield.com/test", zone_name: "rosfield.com" }];
    assert.notDeepEqual(routeProblems(config), []);
  });
});

describe("the saved copy of the old /test page", () => {
  const dir = path.join(REPO, "infra", "rosfield-test-backup");
  const listName = "SHA256SUMS";

  function walk(d) {
    return readdirSync(d).flatMap((n) => {
      const p = path.join(d, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  }
  const files = walk(dir)
    .map((p) => path.relative(dir, p).split(path.sep).join("/"))
    .filter((n) => n !== listName)
    .sort();
  const listed = new Map(
    readFileSync(path.join(dir, listName), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => {
        const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(l);
        assert.ok(m, `bad line in ${listName}: ${l}`);
        return [m[2], m[1]];
      }),
  );

  it("is index.html and 13 asset files, all on the list", () => {
    assert.equal(files.length, 14);
    assert.ok(files.includes("index.html"));
    assert.deepEqual([...listed.keys()].sort(), files);
  });

  it("matches its sha256 list", () => {
    for (const name of files) {
      const hash = createHash("sha256")
        .update(readFileSync(path.join(dir, name)))
        .digest("hex");
      assert.equal(hash, listed.get(name), `${name} differs from its listed sha256`);
    }
  });

  it("holds no key or token", () => {
    const patterns = [
      /sk_(live|test)_[A-Za-z0-9]{10,}/,
      /pk_live_[A-Za-z0-9]{10,}/,
      /AKIA[0-9A-Z]{16}/,
      /gh[pousr]_[A-Za-z0-9]{30,}/,
      /xox[baprs]-[A-Za-z0-9-]{10,}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/,
      /re_[A-Za-z0-9]{20,}/,
      /(api[_-]?key|secret|token|password)["']?\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{16,}["']/i,
    ];
    for (const name of files) {
      if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp4|webm)$/i.test(name)) continue;
      const text = readFileSync(path.join(dir, name), "latin1");
      for (const re of patterns) assert.ok(!re.test(text), `${name} matches ${re}`);
    }
  });
});
