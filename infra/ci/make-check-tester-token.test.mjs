// Tests for infra/scripts/make-check-tester-token.mjs, `npm run check-tester:token:make` (T-1303; K-05 v1.12 default
// 105; QUESTIONS.md CQ-214 (a); DL-561; build prompt rule 7: keys are named, never shown), run by
// `node --test "infra/ci/*.test.mjs"`. The script runs in throwaway checkouts: a copy of it and a made-up .dev.vars, with
// HOME a folder of the test's own and no value of the token's name from this shell (script-harness.mjs), so no run reads
// or writes this Mac's .dev.vars. Every token here is made by the script under test in the run, or made up in the run
// from random bytes, and every other value is made up, so no key-shaped text sits in this file. seed-staging.test.mjs
// runs a token this script makes through seed:staging, and through T-1302's set in place of its hash.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { REPO, SCRIPTS, cleanEnv, copyScript, tempDir, write } from "./script-harness.mjs";

const SCRIPT = "make-check-tester-token.mjs";
const NAME = "STAGING_CHECK_TESTER_TOKEN";
const MADE = `${NAME} made and kept in .dev.vars: npm run seed:staging hands its sha256 to the check-tester set\n`;
const ALREADY = `${NAME} already set in .dev.vars: left as it is (--rotate makes a new one)\n`;
const REPLACED = `${NAME} replaced in .dev.vars (--rotate): npm run seed:staging -- --set check-tester seeds its sha256, which ends the old token's session\n`;
const MISUSE = `${SCRIPT}: an argument it does not take (arguments are never echoed)\nusage: ${SCRIPT} [--rotate]\n`;
const NOT_MADE_FORM = `${SCRIPT}: refused: .dev.vars holds ${NAME} in a form other than the one it is made in (43 characters of base64url that are 32 bytes), so seed:staging refuses it; it is left as it is, and no part of it is shown: --rotate replaces it\n`;
const ENV_NOTE = `${SCRIPT}: ${NAME} is also set in this shell's environment (its value is not shown), and seed:staging reads the environment before .dev.vars: unset it there to use the token .dev.vars holds\n`;

/** A token in the made form, made up in the run: 32 random bytes as base64url, no token of anything. */
const madeUpToken = () => randomBytes(32).toString("base64url");
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// Lines of other names a checkout's .dev.vars holds beside the token, in the build Mac's forms, with made-up values (the
// addresses on domains kept for examples, rule 9): never read or changed. Two of them only look like the token's line.
const OTHER_LINES = [
  "# made-up values for T-1303's tests",
  "STAGING_DATABASE_URL=postgres://made_up_t1303:Qp7rT2xW9@db-t1303.example.invalid:5432/t1303_staging",
  `ANTHROPIC_API_KEY=t1303-made-up-model-key-${"5e1d".repeat(6)}`,
  "  export RESEND_API_KEY='t1303-made-up-email-key-77b2'",
  'STAGING_TEST_INBOXES="t1303-one@example.com,t1303-two@example.net"',
  "",
  `# ${NAME}=t1303-a-commented-line-is-no-value`,
  `${NAME}_OLD=t1303-another-name-is-no-value`,
];
const OTHER_TEXT = `${OTHER_LINES.join("\n")}\n`;

/**
 * A throwaway checkout: the script copied into infra/scripts, and a .dev.vars of the given text and mode (left out: none).
 * run() starts the script with node, as the npm line does; this shell's value of the name never reaches it.
 */
function checkout(t, { devVars, mode } = {}) {
  const dir = tempDir(t, "check-tester-token");
  const root = path.join(dir, "rosie");
  const script = copyScript(SCRIPT, root);
  const file = path.join(root, ".dev.vars");
  if (devVars !== undefined) write(file, devVars, mode);
  const home = path.join(dir, "home");
  write(path.join(home, ".keep"), "");
  const run = (args = [], extra = {}) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: "utf8",
      env: cleanEnv(home, { [NAME]: undefined, ...extra }),
    });
    return { ...result, output: `${result.stdout}${result.stderr}` };
  };
  // The test's own made-up file, never this Mac's.
  const read = () => readFileSync(file, "utf8");
  return { dir, root, file, run, read };
}

/** The value of the first line of the name, as the test writes it plainly. */
const tokenIn = (text) => new RegExp(`^${NAME}=(.*)$`, "m").exec(text)?.[1];

/** Fails unless a text is a token in the made form: 43 signs of base64url that are 32 bytes, never a sha256's form. */
function assertMadeForm(token, what) {
  assert.ok(typeof token === "string", `${what}: no token`);
  assert.match(
    token,
    /^[A-Za-z0-9_-]{43}$/,
    `${what}: not 43 signs of base64url (${String(token.length)} characters)`,
  );
  const bytes = Buffer.from(token, "base64url");
  assert.equal(bytes.length, 32, `${what}: bytes`);
  assert.equal(bytes.toString("base64url"), token, `${what}: base64url as written from its own bytes`);
  assert.doesNotMatch(token, /^[0-9a-f]{64}$/, `${what}: in a sha256's form`);
}

/**
 * Fails when a run's stdout or stderr holds any of the texts or their sha256s, or any part of one ten signs long. The
 * failure names the fault, never the text.
 */
function assertNoValueShown(result, texts, what) {
  for (const text of texts) {
    for (const value of [text, sha256(text)]) {
      const pieces = [];
      for (let at = 0; at + 10 <= value.length; at += 1) pieces.push(value.slice(at, at + 10));
      assert.equal(
        pieces.some((piece) => result.output.includes(piece)),
        false,
        `${what}: the output holds a value, its hash or a part of one`,
      );
    }
  }
}

/** The files under dir that hold the text, other than `except`. */
function filesHolding(dir, text, except) {
  const held = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) held.push(...filesHolding(file, text, except));
    else if (entry.isFile() && !except.includes(file) && readFileSync(file, "utf8").includes(text))
      held.push(file);
  }
  return held;
}

/** The names in the checkout's root folder: .dev.vars and infra/ alone, so no temporary file stays. */
const rootNames = (rig) => readdirSync(rig.root).sort();

describe("make-check-tester-token.mjs (npm run check-tester:token:make) makes the token and keeps it in .dev.vars by name", () => {
  it("no .dev.vars: makes one holding the name's line alone, readable by its owner alone, and prints only the name", (t) => {
    const rig = checkout(t);
    const result = rig.run();
    assert.equal(result.status, 0, `exit ${String(result.status)}`);
    assert.equal(result.stdout, MADE);
    assert.equal(result.stderr, "");
    const token = tokenIn(rig.read());
    assertMadeForm(token, "the token");
    assert.equal(rig.read(), `${NAME}=${token}\n`);
    assert.equal(statSync(rig.file).mode & 0o777, 0o600);
    assertNoValueShown(result, [token], "a first run");
    assert.deepEqual(rootNames(rig), [".dev.vars", "infra"]);
    assert.deepEqual(filesHolding(rig.dir, token, [rig.file]), []);
  });

  it("a .dev.vars with other lines: the token goes on a new line at the end, every other line stays byte for byte, and the file keeps its mode", (t) => {
    for (const [title, text] of [
      ["lines that end in a line end", OTHER_TEXT],
      ["a last line with no line end", OTHER_TEXT.slice(0, -1)],
      ["lines that end in CR LF", OTHER_TEXT.replaceAll("\n", "\r\n")],
      ["an empty file", ""],
    ]) {
      const rig = checkout(t, { devVars: text, mode: 0o640 });
      const result = rig.run();
      assert.equal(result.status, 0, `${title}: exit ${String(result.status)}`);
      assert.equal(result.stdout, MADE, title);
      assert.equal(result.stderr, "", title);
      const after = rig.read();
      const token = tokenIn(after.replaceAll("\r", ""));
      assertMadeForm(token, title);
      const joint = text === "" || text.endsWith("\n") ? "" : "\n";
      assert.equal(after, `${text}${joint}${NAME}=${token}\n`, title);
      assert.equal(statSync(rig.file).mode & 0o777, 0o640, `${title}: the mode`);
      assertNoValueShown(result, [token], title);
      assert.deepEqual(rootNames(rig), [".dev.vars", "infra"], title);
    }
  });

  it("a first line of the name with no value is filled in place, as load_dev_var reads the first line of a name", (t) => {
    for (const line of [
      `${NAME}=`,
      `${NAME}=""`,
      `${NAME}=''`,
      `${NAME}=   `,
      `  export ${NAME}=`,
      `${NAME} =`,
    ]) {
      // A later line of the name is never read, so it stays as it is too.
      const later = `${NAME}=t1303-a-later-line-is-never-read`;
      const text = `${OTHER_TEXT}${line}\nRESEND_FROM=t1303@example.com\n${later}\n`;
      const rig = checkout(t, { devVars: text });
      const result = rig.run();
      assert.equal(result.status, 0, `${line}: exit ${String(result.status)}`);
      assert.equal(result.stdout, MADE, line);
      assert.equal(result.stderr, "", line);
      const token = tokenIn(rig.read());
      assertMadeForm(token, line);
      assert.equal(rig.read(), text.replace(`${line}\n`, `${NAME}=${token}\n`), line);
      assertNoValueShown(result, [token], line);
    }
  });

  it("a token already there, in any form load_dev_var reads, is left exactly as it is: the file is not even written", (t) => {
    const token = madeUpToken();
    for (const line of [
      `${NAME}=${token}`,
      `${NAME}="${token}"`,
      `${NAME}='${token}'`,
      `  export ${NAME}=${token}  `,
      `${NAME} = ${token}`,
    ]) {
      const text = `${OTHER_TEXT}${line}\n`;
      const rig = checkout(t, { devVars: text, mode: 0o600 });
      const before = statSync(rig.file);
      for (const run of [1, 2]) {
        const result = rig.run();
        const what = `${line.replace(token, "<token>")}, run ${String(run)}`;
        assert.equal(result.status, 0, `${what}: exit ${String(result.status)}`);
        assert.equal(result.stdout, ALREADY, what);
        assert.equal(result.stderr, "", what);
        assertNoValueShown(result, [token], what);
      }
      assert.equal(rig.read(), text);
      const after = statSync(rig.file);
      assert.equal(after.ino, before.ino, "the file was written again");
      assert.equal(after.mtimeMs, before.mtimeMs, "the file was written again");
      assert.deepEqual(rootNames(rig), [".dev.vars", "infra"]);
    }
  });

  it("--rotate replaces the token on its line with a new one, keeping the line's end, every other line and the file's mode", (t) => {
    const token = madeUpToken();
    for (const line of [`${NAME}=${token}`, `  export ${NAME}='${token}'`, `${NAME}="${token}"`]) {
      const what = line.replace(token, "<token>");
      for (const end of ["\n", "\r\n"]) {
        const text = `${OTHER_TEXT}${line}${end}RESEND_FROM=t1303@example.com\n`;
        const rig = checkout(t, { devVars: text, mode: 0o640 });
        const result = rig.run(["--rotate"]);
        assert.equal(result.status, 0, `${what}: exit ${String(result.status)}`);
        assert.equal(result.stdout, REPLACED, what);
        assert.equal(result.stderr, "", what);
        const made = tokenIn(rig.read().replaceAll("\r", ""));
        assertMadeForm(made, what);
        assert.notEqual(made, token, `${what}: the token was not replaced`);
        assert.equal(rig.read(), text.replace(`${line}${end}`, `${NAME}=${made}${end}`), what);
        assert.equal(statSync(rig.file).mode & 0o777, 0o640, `${what}: the mode`);
        assertNoValueShown(result, [token, made], what);
        assert.deepEqual(rootNames(rig), [".dev.vars", "infra"], what);
      }
    }
  });

  it("each run makes a token of its own: rotations and checkouts share none, and a run after a rotation leaves the new one alone", (t) => {
    const seen = [];
    for (let run = 1; run <= 3; run += 1) {
      const rig = checkout(t);
      assert.equal(rig.run().status, 0);
      seen.push(tokenIn(rig.read()));
      for (let again = 1; again <= 2; again += 1) {
        const result = rig.run(["--rotate"]);
        assert.equal(result.status, 0);
        assert.equal(result.stdout, REPLACED);
        seen.push(tokenIn(rig.read()));
      }
      const last = rig.read();
      const left = rig.run();
      assert.equal(left.stdout, ALREADY);
      assert.equal(rig.read(), last);
    }
    for (const token of seen) assertMadeForm(token, "a token");
    assert.equal(new Set(seen).size, seen.length, "a token was made twice");
  });

  it("the caller's environment holding the name too: .dev.vars still gets the token, and a note says the environment is read first, never showing either", (t) => {
    const callers = madeUpToken();
    const rig = checkout(t, { devVars: OTHER_TEXT });
    const result = rig.run([], { [NAME]: callers });
    assert.equal(result.status, 0, `exit ${String(result.status)}`);
    assert.equal(result.stdout, MADE);
    assert.equal(result.stderr, ENV_NOTE);
    const token = tokenIn(rig.read());
    assertMadeForm(token, "the token");
    assert.notEqual(token, callers, "the caller's value was kept");
    assertNoValueShown(result, [token, callers], "the caller's value");
  });
});

describe("make-check-tester-token.mjs refuses, leaving .dev.vars as it was", () => {
  it("a token already there in another form is left as it is, and the run says so without showing it (exit 1); --rotate replaces it", (t) => {
    const token = madeUpToken();
    const bytes = Buffer.from(token, "base64url");
    for (const [title, value] of [
      ["its sha256", sha256(token)],
      ["the 32 bytes as base64", bytes.toString("base64")],
      ["42 signs", token.slice(0, 42)],
      ["44 signs", `${token}A`],
      ["a last sign 32 bytes never end in", `${token.slice(0, 42)}B`],
      ["a + of base64 inside", `${token.slice(0, 5)}+${token.slice(6)}`],
    ]) {
      const text = `${OTHER_TEXT}${NAME}=${value}\n`;
      const rig = checkout(t, { devVars: text });
      const result = rig.run();
      assert.equal(result.status, 1, `${title}: exit ${String(result.status)}`);
      assert.equal(result.stdout, "", title);
      assert.equal(result.stderr, NOT_MADE_FORM, title);
      assert.equal(rig.read(), text, title);
      assertNoValueShown(result, [value], title);
      const rotated = rig.run(["--rotate"]);
      assert.equal(rotated.status, 0, `${title}, --rotate: exit ${String(rotated.status)}`);
      assert.equal(rotated.stdout, REPLACED, title);
      const made = tokenIn(rig.read());
      assertMadeForm(made, title);
      assert.equal(rig.read(), `${OTHER_TEXT}${NAME}=${made}\n`, title);
      assertNoValueShown(rotated, [value, made], title);
    }
  });

  it("an argument it does not take (exit 2), never echoed, before .dev.vars is read", (t) => {
    // A .dev.vars that cannot be read: a run that read it first would stop with another message.
    const rig = checkout(t, { devVars: OTHER_TEXT, mode: 0o000 });
    const pasted = madeUpToken();
    for (const args of [
      ["--bogus"],
      ["--rotate", "--rotate"],
      ["rotate"],
      ["--rotate=yes"],
      ["-r"],
      ["--env", "staging"],
      ["--env=production"],
      ["--force"],
      [""],
      [pasted],
      ["--rotate", pasted],
      [`--token=${pasted}`],
    ]) {
      const what = JSON.stringify(args).replaceAll(pasted, "<a pasted token>");
      const result = rig.run(args);
      assert.equal(result.status, 2, `${what}: exit ${String(result.status)}`);
      assert.equal(result.stdout, "", what);
      assert.equal(result.stderr, MISUSE, what);
      assertNoValueShown(result, [pasted], what);
    }
    chmodSync(rig.file, 0o600);
    assert.equal(rig.read(), OTHER_TEXT);
  });

  it("a .dev.vars that cannot be read, or is a folder: nothing is made or written (exit 1)", (t) => {
    const unreadable = checkout(t, { devVars: OTHER_TEXT, mode: 0o000 });
    for (const args of [[], ["--rotate"]]) {
      const result = unreadable.run(args);
      assert.equal(result.status, 1, `exit ${String(result.status)}`);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr,
        `${SCRIPT}: refused: this checkout's .dev.vars cannot be read (EACCES), so whether it holds the token is not known; nothing was made or written\n`,
      );
    }
    chmodSync(unreadable.file, 0o600);
    assert.equal(unreadable.read(), OTHER_TEXT);
    assert.deepEqual(rootNames(unreadable), [".dev.vars", "infra"]);

    const folder = checkout(t);
    mkdirSync(folder.file);
    const result = folder.run();
    assert.equal(result.status, 1, `exit ${String(result.status)}`);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^make-check-tester-token\.mjs: refused: this checkout's \.dev\.vars cannot be read \(ENOTFILE\)/,
    );
    assert.deepEqual(readdirSync(folder.file), []);
  });

  it("a folder it cannot write in: .dev.vars stays as it was, and no file is left beside it (exit 1)", (t) => {
    for (const [title, text] of [
      ["no token yet", OTHER_TEXT],
      ["a token to rotate", `${OTHER_TEXT}${NAME}=${madeUpToken()}\n`],
      ["no .dev.vars", undefined],
    ]) {
      const rig = checkout(t, { devVars: text });
      chmodSync(rig.root, 0o555);
      try {
        const result = rig.run(text === undefined ? [] : ["--rotate"]);
        assert.equal(result.status, 1, `${title}: exit ${String(result.status)}`);
        assert.equal(result.stdout, "", title);
        assert.equal(
          result.stderr,
          `${SCRIPT}: failed: .dev.vars could not be written (EACCES); it is as it was, and the token made for it is dropped\n`,
          title,
        );
      } finally {
        chmodSync(rig.root, 0o755);
      }
      if (text === undefined) assert.deepEqual(rootNames(rig), ["infra"], title);
      else {
        assert.equal(rig.read(), text, title);
        assert.deepEqual(rootNames(rig), [".dev.vars", "infra"], title);
      }
    }
  });
});

describe("make-check-tester-token.mjs follows a link and starts no command", () => {
  it("a .dev.vars that is a link: the file it names gets the token, and the link stays a link", (t) => {
    const rig = checkout(t);
    const real = path.join(rig.dir, "keys", "staging.vars");
    write(real, OTHER_TEXT, 0o600);
    symlinkSync(real, rig.file);
    const result = rig.run();
    assert.equal(result.status, 0, `exit ${String(result.status)}`);
    assert.equal(result.stdout, MADE);
    assert.ok(lstatSync(rig.file).isSymbolicLink(), "the link was replaced");
    const token = tokenIn(readFileSync(real, "utf8"));
    assertMadeForm(token, "the token");
    assert.equal(readFileSync(real, "utf8"), `${OTHER_TEXT}${NAME}=${token}\n`);
    assert.deepEqual(readdirSync(path.dirname(real)), ["staging.vars"]);
    assertNoValueShown(result, [token], "a link");
  });

  it("the token is made, checked and written in the script's own process: it imports node's own modules alone and starts no command", () => {
    const source = readFileSync(path.join(SCRIPTS, SCRIPT), "utf8");
    const imports = Array.from(
      source.matchAll(/^import [\s\S]*? from "([^"]+)";$/gm),
      ([, from]) => from,
    ).sort();
    assert.deepEqual(imports, ["node:crypto", "node:fs", "node:path", "node:url"]);
    // A regular expression's .exec( is no command; a bare exec( or execFile( would be one.
    assert.doesNotMatch(source, /child_process|\bspawn|(?<!\.)\bexec(File|Sync)?\(|\bimport\(|\brequire\(/);
    // Its one generator: node's crypto.randomBytes, 32 bytes as base64url.
    assert.match(source, /randomBytes\(TOKEN_BYTES\)\.toString\("base64url"\)/);
    assert.match(source, /^const TOKEN_BYTES = 32;$/m);
  });

  it("npm run check-tester:token:make runs the script", () => {
    const scripts = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).scripts;
    assert.equal(scripts["check-tester:token:make"], `node infra/scripts/${SCRIPT}`);
  });
});

// T-1310 (DL-586; T-1303's security review, note b): a run killed between its write and its rename leaves its temporary
// file, which holds the new token. The next run removes such files, matched by the script's own name pattern alone,
// before it writes. Each leftover here is planted as such a run leaves it: .dev.vars' whole text with a made-up token,
// under the name writeWhole gives its file.
describe("make-check-tester-token.mjs removes the temporary files an earlier run left (T-1310)", () => {
  const NOTE = (n) =>
    `${SCRIPT}: removed ${String(n)} leftover temporary file${n === 1 ? "" : "s"} beside .dev.vars (a run stopped between its write and its rename leaves one); what ${n === 1 ? "it" : "they"} held is not shown\n`;
  /** A leftover's name beside the file called `name`: <name>.<12 lower-case hex>.tmp. */
  const leftoverName = (name) => `${name}.${randomBytes(6).toString("hex")}.tmp`;
  // Names that only look like a leftover's, each kept as it is: no signs, 11 and 13 signs, capitals, a sign that is not
  // hex, other endings, and other files' names.
  const LOOK_ALIKES = [
    ".dev.vars.tmp",
    `.dev.vars.${"a1".repeat(5)}a.tmp`,
    `.dev.vars.${"a1".repeat(6)}a.tmp`,
    `.dev.vars.${"A1".repeat(6)}.tmp`,
    `.dev.vars.${"g1".repeat(6)}.tmp`,
    `.dev.vars.${"a1".repeat(6)}.tmp.bak`,
    `.dev.vars.${"a1".repeat(6)}.temp`,
    `.dev.vars.local.${"a1".repeat(6)}.tmp`,
    `x.dev.vars.${"a1".repeat(6)}.tmp`,
  ];
  const KEPT = "t1310 not a leftover\n";

  it("a leftover holding a token is removed on the next run, before it writes; every look-alike, and a folder or a link under a leftover's name, stays; no token is shown", (t) => {
    const old = madeUpToken();
    const rig = checkout(t, { devVars: OTHER_TEXT });
    const leftover = path.join(rig.root, leftoverName(".dev.vars"));
    write(leftover, `${OTHER_TEXT}${NAME}=${old}\n`, 0o600);
    for (const name of LOOK_ALIKES) write(path.join(rig.root, name), KEPT);
    // Not files the script writes, so never removed: a folder, and a link to a file outside.
    const folder = path.join(rig.root, leftoverName(".dev.vars"));
    mkdirSync(folder);
    const outside = path.join(rig.dir, "outside.txt");
    write(outside, KEPT);
    const link = path.join(rig.root, leftoverName(".dev.vars"));
    symlinkSync(outside, link);
    const before = rootNames(rig);
    const result = rig.run();
    assert.equal(result.status, 0, `exit ${String(result.status)}`);
    assert.equal(result.stdout, MADE);
    assert.equal(result.stderr, NOTE(1));
    assert.equal(existsSync(leftover), false, "the leftover is still there");
    assert.deepEqual(
      rootNames(rig),
      before.filter((name) => name !== path.basename(leftover)),
    );
    for (const name of LOOK_ALIKES) assert.equal(readFileSync(path.join(rig.root, name), "utf8"), KEPT, name);
    assert.ok(statSync(folder).isDirectory(), "the folder was removed");
    assert.ok(lstatSync(link).isSymbolicLink(), "the link was removed");
    assert.equal(readFileSync(outside, "utf8"), KEPT, "the file the link names changed");
    const token = tokenIn(rig.read());
    assertMadeForm(token, "the token");
    assert.notEqual(token, old, "the leftover's token was kept");
    assertNoValueShown(result, [token, old], "a leftover");
    assert.deepEqual(filesHolding(rig.dir, old, []), [], "a file still holds the leftover's token");
  });

  it("with the token already set the run writes nothing, and still removes the leftovers: two beside the file a link names, one beside the link", (t) => {
    const token = madeUpToken();
    const rig = checkout(t);
    const real = path.join(rig.dir, "keys", "staging.vars");
    const text = `${OTHER_TEXT}${NAME}=${token}\n`;
    write(real, text, 0o600);
    symlinkSync(real, rig.file);
    const olds = [madeUpToken(), madeUpToken(), madeUpToken()];
    const leftovers = [
      path.join(path.dirname(real), leftoverName("staging.vars")),
      path.join(path.dirname(real), leftoverName("staging.vars")),
      // Left while .dev.vars was a file of its own, before it became a link.
      path.join(rig.root, leftoverName(".dev.vars")),
    ];
    for (const [index, file] of leftovers.entries())
      write(file, `${OTHER_TEXT}${NAME}=${olds[index]}\n`, 0o600);
    const written = statSync(real);
    const result = rig.run();
    assert.equal(result.status, 0, `exit ${String(result.status)}`);
    assert.equal(result.stdout, ALREADY);
    assert.equal(result.stderr, NOTE(3));
    for (const file of leftovers) assert.equal(existsSync(file), false, "a leftover is still there");
    assert.deepEqual(readdirSync(path.dirname(real)), ["staging.vars"]);
    assert.deepEqual(rootNames(rig), [".dev.vars", "infra"]);
    assert.equal(readFileSync(real, "utf8"), text);
    assert.equal(statSync(real).mtimeMs, written.mtimeMs, "the file was written");
    assertNoValueShown(result, [token, ...olds], "the token already set");
  });

  it("a leftover it cannot remove, or a folder it cannot read, stops the run before anything is written (exit 1), never showing what the leftover holds", (t) => {
    const old = madeUpToken();
    const rig = checkout(t, { devVars: OTHER_TEXT });
    const name = leftoverName(".dev.vars");
    write(path.join(rig.root, name), `${OTHER_TEXT}${NAME}=${old}\n`, 0o600);
    // [the root folder's mode, the reason]: one it cannot write in, then one it can search but not read.
    for (const [mode, reason] of [
      [
        0o555,
        `${SCRIPT}: refused: a temporary file an earlier run left beside .dev.vars, ${name}, which may hold a token, cannot be removed (EACCES); remove it (its contents are never shown), then run this again; nothing was made or written\n`,
      ],
      [
        0o311,
        `${SCRIPT}: refused: the folder of .dev.vars cannot be read (EACCES), so a temporary file an earlier run left there, which may hold a token, cannot be removed; nothing was made or written\n`,
      ],
    ]) {
      chmodSync(rig.root, mode);
      try {
        for (const args of [[], ["--rotate"]]) {
          const what = `mode ${mode.toString(8)}, ${JSON.stringify(args)}`;
          const result = rig.run(args);
          assert.equal(result.status, 1, `${what}: exit ${String(result.status)}`);
          assert.equal(result.stdout, "", what);
          assert.equal(result.stderr, reason, what);
          assertNoValueShown(result, [old], what);
        }
      } finally {
        chmodSync(rig.root, 0o755);
      }
    }
    assert.equal(rig.read(), OTHER_TEXT);
    assert.deepEqual(rootNames(rig), [".dev.vars", name, "infra"]);
  });
});
