// Tests for the phone scan (T-1317; phone-scan.mjs): no tracked file holds a phone number outside the fiction ranges
// but the named exceptions of phone-scan-exceptions.mjs, each at its own file. Run in ci.yml by
// `node --test "infra/ci/*.test.mjs"`. The planted lines below go into throwaway git repositories, never into this
// one; each of their numbers is no one's (area code 055, or area code 555 with exchange 555), and this file is
// listed for them. A drama-range UK number is fiction, so it needs no entry. A public line, a UK number outside
// Ofcom's drama blocks, the directory-assistance line and a 555 line in a Nevada area code are built from their parts
// when the test runs, so this file holds none of them. So is every number the glued-shape tests plant (T-1332): a
// number right after an escape's letter or a URL-encoded character, or a separated one right before a letter, and
// the cases T-1304's reader keeps unread.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { EXCEPTIONS, PUBLIC_LINES } from "./phone-scan-exceptions.mjs";
import {
  OFCOM_DRAMA,
  isFiction,
  listedNumber,
  phoneNumbersIn,
  scanRepository,
  scanTexts,
  trackedFiles,
} from "./phone-scan.mjs";
import { REPO, cleanEnv, tempDir, write } from "./script-harness.mjs";

const EXCEPTIONS_FILE = "infra/ci/phone-scan-exceptions.mjs";

/** The public lines' numbers, in E.164 form. */
const PUBLIC_NUMBERS = new Set(Object.values(PUBLIC_LINES).map((line) => listedNumber(line.number)));

/** The only files a public line may be listed at (DL-616): the master's trade text and what is built from it. */
const PUBLIC_LINE_FILES =
  /^(?:fixtures\/master\/engine\/work\/prof\/[a-z0-9-]+\.json|fixtures\/v1\/forms\/[a-z0-9-]+\.json|fixtures\/v1\/KNOWN-STALE\.md|compiler\/src\/slots\/slots\.test\.ts)$/;

/** Nevada's area codes: 702, its overlay 725, and 775. A 555 line there is never of the kind "555 exchange". */
const NEVADA_AREA_CODES = new Set(["702", "725", "775"]);

/** The 555 exchange's directory-assistance line, built from its parts so this file never writes it whole. */
const DIRECTORY_ASSISTANCE_LINE = "12".repeat(2);

/**
 * The parts of the numbers the glued-shape tests plant (T-1332), joined only when a test runs, so this file holds
 * none of them whole: area code 555 (no area) and exchange 555, then a line in the fiction block or one past it.
 */
const FIVES = "5".repeat(3);
const IN_BLOCK = "0142";
const PAST_BLOCK = "0200";

/** Ten digits in a row: area code and exchange 555, then the line. */
const ten = (line) => `${FIVES}${FIVES}${line}`;

/** Whether a listed number (E.164) is of its entry's kind, so it can be no one's line. */
function ofKind(kind, number) {
  const digits = number.slice(1);
  const northAmerican = digits.startsWith("1") && digits.length === 11;
  if (kind === "impossible code") return northAmerican && (/[01]/.test(digits[1]) || /[01]/.test(digits[4]));
  if (kind === "555 exchange") {
    // Never the directory-assistance line, and never in a Nevada area code (the security review's note d, DL-632).
    return (
      northAmerican &&
      /[2-9]/.test(digits[1]) &&
      digits.slice(4, 7) === "555" &&
      digits.slice(7) !== DIRECTORY_ASSISTANCE_LINE &&
      !NEVADA_AREA_CODES.has(digits.slice(1, 4))
    );
  }
  if (kind === "wrong length") {
    // Never seven digits after +1: a local number's length, which an area code could complete (DL-636).
    return digits.startsWith("1") && digits.length !== 11 && digits.length !== 8;
  }
  if (kind === "public line") return PUBLIC_NUMBERS.has(number);
  return kind === "not a phone number";
}

/** A listed +1 number as the master writes it: 1, then its area code, exchange and line, joined by dashes. */
function asMasterWrites(listed) {
  const digits = listedNumber(listed).slice(2);
  return `1-${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** A UK national number (with its 0, any spacing) in E.164 form. */
function ukE164(national) {
  return `+44${national.replace(/[^0-9]/g, "").slice(1)}`;
}

/** The UK national number `by` lines from a national number, with its 0: the line before or after a block's edge. */
function ukStep(national, by) {
  const digits = national.replace(/[^0-9]/g, "");
  return String(Number(digits) + by).padStart(digits.length, "0");
}

/**
 * A throwaway git repository: `tracked` (path to text) written and added to the index, then `untracked` written
 * and left out of it.
 */
function repository(t, tracked, untracked = {}) {
  const root = tempDir(t, "phone-scan");
  const home = tempDir(t, "phone-scan-home");
  const env = cleanEnv(home, { XDG_CONFIG_HOME: path.join(home, ".config") });
  execFileSync("git", ["init", "-q"], { cwd: root, env });
  for (const [file, text] of Object.entries(tracked)) write(path.join(root, file), text);
  execFileSync("git", ["add", "-A"], { cwd: root, env });
  for (const [file, text] of Object.entries(untracked)) write(path.join(root, file), text);
  return { root, env };
}

const scanned = scanRepository(REPO, EXCEPTIONS);

describe("the phone scan of every tracked file (T-1317)", () => {
  it("finds no number outside the fiction range in any file git ls-files lists, but each named exception at its own file", () => {
    assert.ok(scanned.files > 1000, `${scanned.files} tracked files`);
    assert.deepEqual(
      scanned.hits,
      [],
      `${scanned.hits.length} lines hold a number outside the fiction range. Swap each for a fiction-range one, ` +
        `or list a deliberate input in ${EXCEPTIONS_FILE} with why it is no real number:\n` +
        scanned.hits.join("\n"),
    );
  });

  it("lists only numbers their files still hold", () => {
    assert.deepEqual(
      scanned.stale,
      [],
      `listed in ${EXCEPTIONS_FILE} but no longer held:\n${scanned.stale.join("\n")}`,
    );
  });

  it("lists each exception once, with a tracked file, a kind its digits bear out, and why", () => {
    const tracked = new Set(trackedFiles(REPO));
    const seen = new Set();
    for (const entry of EXCEPTIONS) {
      const where = `${EXCEPTIONS_FILE}: ${entry.file}`;
      assert.deepEqual(Object.keys(entry).sort(), ["file", "kind", "numbers", "why"], where);
      assert.ok(tracked.has(entry.file), `${where} is not a tracked file`);
      assert.ok(typeof entry.why === "string" && entry.why.trim().length >= 10, `${where} says no why`);
      assert.ok(Array.isArray(entry.numbers) && entry.numbers.length > 0, `${where} lists no number`);
      for (const listed of entry.numbers) {
        assert.match(listed, /^\+[1-9][0-9]*(?:_[0-9]+)+$/, `${where}: write a number with underscores`);
        const number = listedNumber(listed);
        assert.ok(number.length >= 8 && number.length <= 16, `${where}: ${listed} is not 7 to 15 digits`);
        assert.ok(!isFiction(number), `${where}: ${listed} is in a fiction range, so needs no entry`);
        assert.ok(ofKind(entry.kind, number), `${where}: ${listed} is not of the kind "${entry.kind}"`);
        assert.ok(!seen.has(`${entry.file} ${number}`), `${where}: ${listed} is listed twice`);
        seen.add(`${entry.file} ${number}`);
      }
      if (entry.kind === "public line") {
        // DL-616: only at the master's trade text and what is built from it, one line per entry, named with its
        // operator.
        assert.match(
          entry.file,
          PUBLIC_LINE_FILES,
          `${where}: a public line is listed only where DL-616 allows`,
        );
        assert.equal(entry.numbers.length, 1, `${where}: one public line per entry`);
        const line = Object.values(PUBLIC_LINES).find(({ number }) => number === entry.numbers[0]);
        assert.ok(line !== undefined, `${where}: not one of PUBLIC_LINES`);
        assert.ok(entry.why.includes(line.name), `${where}: its why does not name the line`);
        assert.ok(entry.why.includes(line.operator), `${where}: its why does not name the operator`);
      }
    }
  });

  it("keeps the exception list free of any number the scan reads", () => {
    const text = readFileSync(path.join(REPO, EXCEPTIONS_FILE), "utf8");
    assert.deepEqual(scanTexts([[EXCEPTIONS_FILE, text]]).hits, []);
  });

  it("tells a number of each kind from one that could be someone's", () => {
    assert.ok(ofKind("impossible code", listedNumber("+1_055_555_0142")));
    assert.ok(ofKind("impossible code", listedNumber("+1_555_055_0142")));
    assert.ok(ofKind("555 exchange", listedNumber("+1_555_555_0200")));
    assert.ok(ofKind("wrong length", listedNumber("+1_555555")));
    assert.ok(ofKind("wrong length", listedNumber("+1_555_555_0142_0")));
    // Seven digits after +1, a local number's length, are never of the kind (DL-636); built here from its parts.
    assert.ok(!ofKind("wrong length", `+1${FIVES}${IN_BLOCK}`), "seven digits after +1");
    // A number whose area code and exchange the plan gives (built here from parts, never written whole).
    const ordinary = `+1${"2".repeat(3)}${"3".repeat(3)}${"4".repeat(4)}`;
    for (const kind of ["impossible code", "555 exchange", "wrong length", "public line"]) {
      assert.ok(!ofKind(kind, ordinary), `${kind} refuses an ordinary number`);
    }
    // The 555 exchange refuses the directory-assistance line in any area code, and any line in Nevada's area codes
    // (DL-632), while the same line in another area code stays of its kind. Each built here from its parts.
    const exchange = "5".repeat(3);
    const otherLine = "0200";
    for (const area of ["2".repeat(3), exchange]) {
      const directory = `+1${area}${exchange}${DIRECTORY_ASSISTANCE_LINE}`;
      assert.ok(!ofKind("555 exchange", directory), `the directory-assistance line in area code ${area}`);
      assert.ok(
        ofKind("555 exchange", `+1${area}${exchange}${otherLine}`),
        `another 555 line in area code ${area}`,
      );
    }
    assert.equal(NEVADA_AREA_CODES.size, 3);
    for (const area of NEVADA_AREA_CODES) {
      assert.ok(
        !ofKind("555 exchange", `+1${area}${exchange}${otherLine}`),
        `a 555 line in area code ${area}`,
      );
    }
    for (const line of Object.values(PUBLIC_LINES)) {
      assert.ok(ofKind("public line", listedNumber(line.number)), `${line.name} is a public line`);
    }
    assert.ok(!ofKind("impossible code", `+44${"2".repeat(10)}`));
    assert.ok(!ofKind("anything else", listedNumber("+1_055_555_0142")));
  });
});

describe("the phone scan on planted lines (T-1317)", () => {
  it("fails on a planted out-of-range line in a tracked file, naming its file and line, never its number", (t) => {
    const { root } = repository(t, {
      "fiction.txt": 'ROSIE_NUMBER="+15555550142"\ncall (555) 555-0199 or +1 555 555 0100\n',
      "deep/dir/planted.json": '{\n  "id": "evt-1",\n  "to": "+1 055 555 0142"\n}\n',
      "notes.md": "one\n(555) 555-0200\nthree 555.555.0200 and 1-555-555-0200\n",
      "with space.txt": "+10555550142\n",
    });
    const { hits, stale, files } = scanRepository(root);
    assert.equal(files, 4);
    assert.deepEqual(hits, ["deep/dir/planted.json:3", "notes.md:2", "notes.md:3", "with space.txt:1"]);
    assert.deepEqual(stale, []);
    for (const hit of hits) assert.doesNotMatch(hit, /[0-9]{4}/, "a hit names no number");
  });

  it("passes a listed number at its own file only, and nothing else in that file", (t) => {
    const { root } = repository(t, {
      "a.txt": "x\n+1 055 555 0142\ny +10555550142\n",
      "b.txt": "+1 055 555 0142\n",
      "c.txt": "fine\n",
      "d.txt": "+10555550142 and (555) 555-0200\n",
    });
    const exceptions = [
      { file: "a.txt", kind: "impossible code", numbers: ["+1_055_555_0142"], why: "a planted test input" },
      { file: "c.txt", kind: "impossible code", numbers: ["+1_055_555_0142"], why: "a planted test input" },
      { file: "d.txt", kind: "impossible code", numbers: ["+1_055_555_0142"], why: "a planted test input" },
    ];
    const { hits, stale } = scanRepository(root, exceptions);
    assert.deepEqual(hits, ["b.txt:1", "d.txt:1"]);
    assert.deepEqual(stale, ["c.txt: +1_055_555_0142"]);
    // Without its entry, the same line fails.
    assert.deepEqual(scanRepository(root, exceptions.slice(1)).hits, [
      "a.txt:2",
      "a.txt:3",
      "b.txt:1",
      "d.txt:1",
    ]);
  });

  it("passes each public line at its own files only, and fails on it anywhere else (DL-616)", (t) => {
    const listed = EXCEPTIONS.filter((entry) => entry.kind === "public line");
    for (const line of Object.values(PUBLIC_LINES)) {
      const written = asMasterWrites(line.number);
      // One of its own files, and a file listed only for another public line.
      const own = listed.find((entry) => entry.numbers.includes(line.number));
      const other = listed.find(
        (entry) => !listed.some((each) => each.file === entry.file && each.numbers.includes(line.number)),
      );
      assert.ok(own !== undefined && other !== undefined, `${line.name}: no own file, or no other one`);
      const { root } = repository(t, {
        [own.file]: `{\n  "danger": "call ${written}"\n}\n`,
        [other.file]: `{\n  "danger": "${asMasterWrites(other.numbers[0])}",\n  "planted": "${written}"\n}\n`,
        "docs/hotlines.md": `# Hotlines\n${written}\n`,
      });
      const { hits, stale } = scanRepository(root, [own, other]);
      assert.deepEqual(hits.toSorted(), [`${other.file}:3`, "docs/hotlines.md:2"].toSorted(), line.name);
      assert.deepEqual(stale, [], line.name);
      for (const hit of hits) assert.doesNotMatch(hit, /[0-9]{4}/, "a hit names no number");
      // Without its entry, the line at its own file fails too.
      assert.deepEqual(
        scanRepository(root, [other]).hits.toSorted(),
        [`${own.file}:2`, ...hits].toSorted(),
        line.name,
      );
    }
  });

  it("reads Ofcom's UK drama blocks as fiction: a London number in its block passes, one past it fails", (t) => {
    const london = OFCOM_DRAMA.find(([area]) => area === "London");
    assert.ok(london !== undefined, "London's block is listed");
    // The line just past London's block, built from its last line when the test runs, written with spaces.
    const past = ukE164(ukStep(london[2], 1)).replace(/^(\+44)(\d{2})(\d{4})(\d{4})$/, "$1 $2 $3 $4");
    const { root } = repository(t, {
      "drama.md": "Call +44 20 7946 0123, or +442079460999.\n",
      "past.md": `# Not fiction\nCall ${past}.\n`,
    });
    const { hits } = scanRepository(root);
    assert.deepEqual(hits, ["past.md:2"]);
    assert.doesNotMatch(hits[0], /[0-9]{4}/, "a hit names no number");
    // Nineteen blocks: Northern Ireland's cannot be confirmed against Ofcom's own page, so none is listed (DL-632).
    assert.equal(OFCOM_DRAMA.length, 19);
    assert.ok(
      OFCOM_DRAMA.every(([, first]) => !first.startsWith("028")),
      "no block in Northern Ireland's area code",
    );
    // Every block holds its first and last line, and neither line beside it, so no block is wider than Ofcom's.
    for (const [area, first, last] of OFCOM_DRAMA) {
      assert.equal(Number(ukStep(last, 0)) - Number(ukStep(first, 0)), 999, `${area}: a thousand lines`);
      assert.ok(isFiction(ukE164(first)) && isFiction(ukE164(last)), `${area}: its first and last lines`);
      assert.ok(!isFiction(ukE164(ukStep(first, -1))), `${area}: the line before its block`);
      assert.ok(!isFiction(ukE164(ukStep(last, 1))), `${area}: the line after its block`);
    }
  });

  it("reads only what git ls-files lists, and a symbolic link as its own target path", (t) => {
    const outside = tempDir(t, "phone-scan-outside");
    write(path.join(outside, "held.txt"), "+1 055 555 0142\n");
    const { root, env } = repository(
      t,
      { "tracked.txt": "nothing here\n", "gone.txt": "+1 055 555 0142\n" },
      { "untracked.txt": "+1 055 555 0142\n" },
    );
    symlinkSync(path.join(outside, "held.txt"), path.join(root, "link-out"));
    symlinkSync("elsewhere/+10555550142.txt", path.join(root, "link-number"));
    execFileSync("git", ["add", "link-out", "link-number"], { cwd: root, env });
    rmSync(path.join(root, "gone.txt"));
    const { hits, files } = scanRepository(root);
    assert.equal(files, 4);
    assert.deepEqual(hits, ["link-number:1"]);
  });

  it("refuses to scan outside a git repository", (t) => {
    assert.throws(() => scanRepository(tempDir(t, "phone-scan-no-git")), /git ls-files failed/);
  });
});

describe("the phone scan of a number glued to a letter (T-1332)", () => {
  // Each shape T-1332 reads (T-1317's security note b): a number right after an escape or a URL-encoded character,
  // whose last letter or digit ends no word, and a separated North American number right before a letter. Each is
  // written as a file would hold it, around a line under area code and exchange 555.
  const GLUED = {
    "the + form after an escaped newline in JSON": (line) => `{"text": "Call us\\n+1${ten(line)}"}`,
    "the + form with spaces after an escaped tab": (line) => `"name\\t+1 ${FIVES} ${FIVES} ${line}"`,
    "dashes after an escaped newline": (line) => `"Call us\\n${FIVES}-${FIVES}-${line}"`,
    "a bracketed area code after an escaped carriage return": (line) => `"one\\r(${FIVES}) ${FIVES}-${line}"`,
    "ten digits in a row after an escaped newline": (line) => `"one\\n${ten(line)}"`,
    "a URL-encoded plus": (line) => `sms:%2B1${ten(line)}?body=hi`,
    "a URL-encoded plus in lower case": (line) => `?To=%2b1${ten(line)}&From=rosie`,
    "a URL-encoded plus after a URL-encoded colon": (line) => `tel%3A%2B1${ten(line)}`,
    "ten digits in a row after a URL-encoded colon": (line) => `tel%3A${ten(line)}`,
    "ten digits in a row after a URL-encoded space": (line) => `body=Call%20${ten(line)}`,
    "dots after a URL-encoded newline": (line) => `body=one%0A${FIVES}.${FIVES}.${line}`,
    "dashes right before a letter, as an extension": (line) => `${FIVES}-${FIVES}-${line}x12`,
    "a bracketed area code right before a letter": (line) => `(${FIVES}) ${FIVES}-${line}ext`,
    "a 1 and dots right before a letter": (line) => `1.${FIVES}.${FIVES}.${line}Call`,
  };

  // The cases T-1304's reader keeps unread ("no id as a number", wrangler-env.test.mjs), each still unread, and one
  // that T-1332's escapes leave out. Each holds a line past the fiction block, so a reading would fail the scan.
  const KEPT = {
    "ten digits inside a hex id": (line) => `"id": "ab${ten(line)}cd"`,
    "ten digits at a hex id's end, right after a letter": (line) => `"id": "abc${ten(line)}"`,
    "ten digits in a row at an id's start, right before a letter": (line) => `"id": "${ten(line)}abc"`,
    "a longer run of digits": (line) => `9${ten(line)} ${ten(line)}9 +1${ten(line)}${line}9`,
    "a + inside a word, as base64 writes one, or in a sum": (line) => `"ab+1${ten(line)}" 2+1${ten(line)}`,
    "a URL-encoded plus inside a word": (line) => `ab%2B1${ten(line)}`,
    "an escape that hex digits follow, as \\u or \\x": (line) => `"\\u${ten(line)}" "\\x${ten(line)}"`,
  };

  it("reads each glued shape: a fiction number passes, one past the block fails, by file and line only", (t) => {
    const shapes = Object.entries(GLUED);
    for (const [shape, write] of shapes) {
      assert.deepEqual(phoneNumbersIn(write(IN_BLOCK)), [`+1${ten(IN_BLOCK)}`], shape);
      assert.deepEqual(phoneNumbersIn(write(PAST_BLOCK)), [`+1${ten(PAST_BLOCK)}`], shape);
    }
    const { root } = repository(t, {
      "fiction.json": `${shapes.map(([, write]) => write(IN_BLOCK)).join("\n")}\n`,
      "past.json": `${shapes.map(([, write]) => write(PAST_BLOCK)).join("\n")}\n`,
    });
    const { hits } = scanRepository(root);
    assert.deepEqual(
      hits,
      shapes.map((_, i) => `past.json:${i + 1}`),
    );
    for (const hit of hits) assert.doesNotMatch(hit, /[0-9]{4}/, "a hit names no number");
  });

  it("keeps T-1304's cases unread: an id's digits, a longer run of digits, a + inside a word or a sum", (t) => {
    const cases = Object.entries(KEPT);
    for (const [kept, write] of cases) assert.deepEqual(phoneNumbersIn(write(PAST_BLOCK)), [], kept);
    const { root } = repository(t, {
      "ids.json": `${cases.map(([, write]) => write(PAST_BLOCK)).join("\n")}\n`,
    });
    assert.deepEqual(scanRepository(root).hits, []);
    // A North American shape right after a + or a URL-encoded plus is the + form's number, read once, and never
    // also as a +1 number (T-1304).
    for (const plus of ["+", "%2B"]) {
      assert.deepEqual(phoneNumbersIn(`to ${plus}${ten(PAST_BLOCK)}`), [`+${ten(PAST_BLOCK)}`], plus);
    }
  });
});
