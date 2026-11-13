// T-1052: staging keeps exactly the two routes rosfield.com/test and rosfield.com/test/* (DL-023, DL-044), and the
// saved copy of the old /test page under infra/rosfield-test-backup/ matches its sha256 list (RK-51). And (T-1327)
// the saved copy holds no phone number: the old page's iMessage number is one named placeholder.
// Run in ci.yml by `node --test "infra/ci/*.test.mjs"`.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";

// The shapes T-1304's scanner reads a number in, and its reader, as phone-scan.mjs holds them since T-1317 (DL-620):
// a + and 7 to 15 digits, with spaces, dots, dashes or brackets between them; or a North American number without
// the +: an area code (bracketed or not), an exchange and a line, with a 1 or none. Neither shape crosses a line
// break, so reading a whole file finds what reading it line by line finds.
import { NANP_FORM, PLUS_FORM, phoneNumbersIn } from "./phone-scan.mjs";
import { REPO } from "./script-harness.mjs";

const WANTED = ["rosfield.com/test", "rosfield.com/test/*"];

// The repository is public (DL-436), so the saved copy holds the old page's iMessage number as one named
// placeholder, at assets/_assets_chat.js line 9 (T-1327; T-1317's finding 1, DL-616). The number is the user's own
// and stays outside the repository, as Rosie's does (T-1304, DL-542); the runbook's step 4 fills it in to restore.
const PLACEHOLDER = "ROSFIELD_TEST_IMESSAGE_NUMBER";
const PLACEHOLDER_FILE = "assets/_assets_chat.js";
const PLACEHOLDER_LINE = 9;
// A number in the fiction range (+1, an area code, then 555-0100 to 555-0199), written as the old line wrote its own.
const FICTION_NUMBER = "+1 (555) 555-0142";

// An SVG path's d attribute: drawing coordinates, never a number to call. The site's wordmark path in assets/_,
// _privacy and _terms holds digit runs these shapes read (T-1317 round 1: not a phone number).
const PATH_DATA = /<path\b[^>]*?\sd="([^"]*)"/g;

/** "<file>:<line>" for each line of the files (name to text) holding a number outside path data, never the number. */
function numberPlaces(files) {
  const places = [];
  for (const [name, text] of Object.entries(files)) {
    const drawn = [...text.matchAll(PATH_DATA)].map((m) => {
      const end = m.index + m[0].length - 1;
      return [end - m[1].length, end];
    });
    const lines = new Set();
    for (const form of [PLUS_FORM, NANP_FORM]) {
      for (const m of text.matchAll(form)) {
        const [from, to] = [m.index, m.index + m[0].length];
        if (!drawn.some(([start, end]) => start <= from && to <= end)) {
          lines.add(text.slice(0, from).split("\n").length);
        }
      }
    }
    for (const line of [...lines].sort((a, b) => a - b)) places.push(`${name}:${line}`);
  }
  return places;
}

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
  const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp4|webm)$/i;

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
      if (BINARY.test(name)) continue;
      const text = readFileSync(path.join(dir, name), "latin1");
      for (const re of patterns) assert.ok(!re.test(text), `${name} matches ${re}`);
    }
  });

  // T-1327: the old page's iMessage number is one named placeholder. No assertion here prints a line of the saved
  // copy: each names a file and line, or says what went wrong, so no number reaches a log.
  describe("its iMessage number (T-1327)", () => {
    const texts = Object.fromEntries(
      files.filter((n) => !BINARY.test(n)).map((n) => [n, readFileSync(path.join(dir, n), "utf8")]),
    );
    const here = `${PLACEHOLDER_FILE}:${PLACEHOLDER_LINE}`;

    it("is the placeholder, once in the whole copy, at assets/_assets_chat.js line 9", () => {
      const places = [];
      for (const name of files) {
        readFileSync(path.join(dir, name), "latin1")
          .split("\n")
          .forEach((line, i) => {
            for (let at = line.indexOf(PLACEHOLDER); at >= 0; at = line.indexOf(PLACEHOLDER, at + 1)) {
              places.push(`${name}:${i + 1}`);
            }
          });
      }
      assert.deepEqual(places, [here]);
    });

    it("leaves no number in any shape T-1304's scanner reads: none in its file, none outside path data", () => {
      assert.ok(PLACEHOLDER_FILE in texts);
      assert.deepEqual(numberPlaces(texts), []);
      const lines = texts[PLACEHOLDER_FILE].split("\n");
      assert.deepEqual(
        lines.flatMap((line, i) => (phoneNumbersIn(line).length > 0 ? [`${PLACEHOLDER_FILE}:${i + 1}`] : [])),
        [],
      );
    });

    it("filled with a fiction number, as the way back fills it, differs from the pinned copy only there", () => {
      const pinned = readFileSync(path.join(dir, PLACEHOLDER_FILE));
      const filled = Buffer.from(pinned.toString("utf8").replaceAll(PLACEHOLDER, FICTION_NUMBER), "utf8");
      // The longest shared head and tail of the bytes: what lies between them is all that changed.
      const shortest = Math.min(pinned.length, filled.length);
      let head = 0;
      while (head < shortest && pinned[head] === filled[head]) head++;
      let tail = 0;
      while (tail < shortest - head && pinned.at(-1 - tail) === filled.at(-1 - tail)) tail++;
      assert.ok(
        pinned.subarray(head, pinned.length - tail).toString() === PLACEHOLDER,
        "the pinned copy differs from the filled one beyond the placeholder",
      );
      assert.ok(
        filled.subarray(head, filled.length - tail).toString() === FICTION_NUMBER,
        "the filled copy differs from the pinned one beyond the number",
      );
      // Line by line: only line 9 changed, and T-1304's scanner reads one number on it, the fiction one.
      const before = pinned.toString("utf8").split("\n");
      const after = filled.toString("utf8").split("\n");
      assert.equal(after.length, before.length);
      assert.deepEqual(
        after.flatMap((line, i) => (line === before[i] ? [] : [i + 1])),
        [PLACEHOLDER_LINE],
      );
      assert.ok(
        isDeepStrictEqual(phoneNumbersIn(after[PLACEHOLDER_LINE - 1]), ["+15555550142"]),
        "the filled line holds other than the one fiction number",
      );
      assert.deepEqual(numberPlaces({ [PLACEHOLDER_FILE]: filled.toString("utf8") }), [here]);
    });

    it("would name the file and line of a number outside path data, never the number", () => {
      const page = [
        '<path fill="currentColor" d="M10 20 555.555.0142 30Z" />',
        '<path d="M10 20Z" aria-label="555.555.0142" />',
        `<p>Text me on iMessage at ${FICTION_NUMBER}.</p>`,
      ].join("\n");
      const found = numberPlaces({ "page.html": page });
      assert.deepEqual(found, ["page.html:2", "page.html:3"]);
      assert.ok(found.every((place) => !place.includes("0142")));
    });
  });
});
