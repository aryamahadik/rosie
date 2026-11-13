#!/usr/bin/env node
// The check tester's token, made on the build Mac (T-1303; K-05 v1.12 default 105; QUESTIONS.md CQ-214 (a) and CQ-218;
// DL-542, DL-561; build prompt rule 7: keys are named, never shown):
//   npm run check-tester:token:make                  (node infra/scripts/make-check-tester-token.mjs)
//   npm run check-tester:token:make -- --rotate
// The token is staging's check tester's session token: T-570's check and T-467's run sign in to staging's test-phone page
// with it, and seed:staging (infra/scripts/seed-staging.sh) hands T-1302's check-tester set its sha256 alone, by name, so
// the database holds only the hash. It is made here as T-322's newSessionToken makes a session token
// (actions/src/domain/proof-codes/draw.ts): 32 random bytes from node's crypto.randomBytes (node's own cryptographic
// generator; no package), written as 43 characters of base64url with no padding. That form is not a sha256's (64
// lower-case hex characters), so the set refuses the token handed in where its hash belongs (DL-561).
//
// It is kept in this checkout's git-ignored .dev.vars, by name, on one line STAGING_CHECK_TESTER_TOKEN=<token>, where
// seed:staging reads it as lib.sh's load_dev_var reads a name (the first line of the name; an export in front, spaces
// around the value and one pair of quotes around it taken off), and nowhere else: it is never printed, logged, put in a
// command's arguments or environment, or written to another file that stays. No command is started: the token is made,
// checked and written in this one process. Standard output gets one line, and nothing else:
//   STAGING_CHECK_TESTER_TOKEN made and kept in .dev.vars: ...
//       .dev.vars had no value for the name (no line, or the name's first line empty): a new token went on that line, or
//       on a new line at the end (a .dev.vars that did not exist is made, readable by its owner alone).
//   STAGING_CHECK_TESTER_TOKEN already set in .dev.vars: left as it is (--rotate makes a new one)
//       .dev.vars holds a token in the made form. It is never replaced without --rotate: the token in .dev.vars is the
//       one whose sha256 staging holds, so a new one opens nothing until seed:staging seeds it.
//   STAGING_CHECK_TESTER_TOKEN replaced in .dev.vars (--rotate): ...
//       with --rotate, the name's line holds a new token. The old token's session stays live until
//       `npm run seed:staging -- --set check-tester` seeds the new one's sha256, which ends it (T-1302).
// A token already in .dev.vars that is not in the made form is left as it is too, unless --rotate is given: the run says
// so on standard error, never showing it, and exits 1, since seed:staging refuses it.
// Every other line .dev.vars holds stays as it is, byte for byte, and the file keeps its mode. A changed .dev.vars is
// written whole to a new file beside it, readable by its owner alone, which then takes its place (a rename), so a run
// that stops part way leaves the old file as it was. Its name, .dev.vars.<random>.tmp, is git-ignored; it is removed if
// the run fails before the rename. A run killed between the write and the rename cannot remove it, and it holds the new
// token (T-1310; T-1303's security review, note b). So each run, once it has read .dev.vars and before it writes
// anything, removes such files an earlier run left beside the file it writes (the file a link names) and beside
// .dev.vars itself, matched by this script's own name pattern alone (that file's name, a dot, 12 lower-case hex signs,
// .tmp; regular files only, so nothing else in the folder is touched), and standard error says how many, never what
// they held. Two runs at once on one checkout could so remove each other's file: the later rename then fails, and
// .dev.vars stays as it was.
// When the caller's environment holds STAGING_CHECK_TESTER_TOKEN too, standard error says so (never its value):
// seed:staging reads the environment before .dev.vars.
// Exit: 0 .dev.vars holds a token in the made form (made now, or already there); 1 refused or failed (a .dev.vars that
// cannot be read or written, a leftover file that cannot be removed, a token already there that is not in the made form,
// a generator gone wrong), with .dev.vars as it was; 2 misuse (an argument it does not take, never echoed), found before
// anything is read.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The name the token is kept under, in .dev.vars, and read by (seed-staging.sh, T-570's check). */
const TOKEN_NAME = "STAGING_CHECK_TESTER_TOKEN";
/** The token's random bytes (ADR-016 section 6: 256 bits; T-322's SESSION_TOKEN_BYTES). */
const TOKEN_BYTES = 32;
/** The random bytes in a temporary file's name, written as lower-case hex: <the file's name>.<hex>.tmp (writeWhole). */
const TEMP_NAME_BYTES = 6;

const SCRIPT = "make-check-tester-token.mjs";
const USAGE = `usage: ${SCRIPT} [--rotate]`;
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEV_VARS = path.join(ROOT, ".dev.vars");
// What bash's [[:space:]] takes in lib.sh's load_dev_var, and its pattern for a line of the name.
const SPACE = "[ \\t\\n\\v\\f\\r]";
const LINE = new RegExp(`^${SPACE}*(?:export${SPACE}+)?${TOKEN_NAME}${SPACE}*=([\\s\\S]*)$`);
const EDGE_SPACE = new RegExp(`^${SPACE}+|${SPACE}+$`, "g");

/** A run that stops: its exit code and its one line on standard error. Never holds a value. */
class Stop extends Error {
  constructor(code, line) {
    super(line);
    this.code = code;
  }
}

/** Whether a text is a token in the made form: 43 signs of base64url that are 32 bytes written as base64url. */
function isMadeForm(text) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return false;
  const bytes = Buffer.from(text, "base64url");
  return bytes.length === TOKEN_BYTES && bytes.toString("base64url") === text;
}

/** A line's value as load_dev_var reads it: spaces at both ends, then one pair of quotes around it, taken off. */
function valueOf(raw) {
  const value = raw.replace(EDGE_SPACE, "");
  const quoted = /^"([\s\S]*)"$/.exec(value) ?? /^'([\s\S]*)'$/.exec(value);
  return quoted === null ? value : quoted[1];
}

/** A failed file call as printed: its code alone, never its message (which names no value, but is not needed). */
const codeOf = (error) =>
  typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : "unknown";

/** --rotate, or nothing: any other argument is misuse (exit 2), never echoed (one could be a pasted token). */
function parseArgs(argv) {
  let rotate = false;
  for (const arg of argv) {
    if (arg !== "--rotate" || rotate) {
      throw new Stop(2, `${SCRIPT}: an argument it does not take (arguments are never echoed)\n${USAGE}`);
    }
    rotate = true;
  }
  return rotate;
}

/**
 * .dev.vars as it stands: the file to write (the real file behind a link), its mode, its text, and the first line of the
 * name (its index among the lines, or -1, and its value as load_dev_var reads it).
 */
function readDevVars() {
  let present = true;
  try {
    lstatSync(DEV_VARS);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") {
      throw new Stop(
        1,
        `${SCRIPT}: refused: this checkout's .dev.vars cannot be read (${codeOf(error)}); nothing was made or written`,
      );
    }
    present = false;
  }
  if (!present) return { target: DEV_VARS, mode: 0o600, lines: [], at: -1, value: "" };
  let target;
  let mode;
  let text;
  try {
    target = realpathSync(DEV_VARS);
    const stats = statSync(target);
    if (!stats.isFile()) throw Object.assign(new Error("not a file"), { code: "ENOTFILE" });
    mode = stats.mode & 0o777;
    text = readFileSync(target, "utf8");
  } catch (error) {
    throw new Stop(
      1,
      `${SCRIPT}: refused: this checkout's .dev.vars cannot be read (${codeOf(error)}), so whether it holds the token is not known; nothing was made or written`,
    );
  }
  // Each line with its own line end, so every other line is written back byte for byte.
  const lines = text === "" ? [] : text.split(/(?<=\n)/);
  for (const [index, line] of lines.entries()) {
    const match = LINE.exec(line.replace(/\n$/, ""));
    if (match !== null) return { target, mode, lines, at: index, value: valueOf(match[1]) };
  }
  return { target, mode, lines, at: -1, value: "" };
}

/** A new token: 32 random bytes as base64url, checked to be exactly the made form before it is kept. */
function newToken() {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  if (!isMadeForm(token)) {
    throw new Stop(
      1,
      `${SCRIPT}: refused: node did not give 32 random bytes as base64url (what it gave is not shown); nothing was written`,
    );
  }
  return token;
}

/** Whether a name is one writeWhole gives a temporary file beside the target: <its name>.<12 lower-case hex>.tmp. */
function isTempName(name, target) {
  const base = `${path.basename(target)}.`;
  const middle = name.slice(base.length, -".tmp".length);
  return (
    name.startsWith(base) &&
    name.endsWith(".tmp") &&
    name.length === base.length + 2 * TEMP_NAME_BYTES + ".tmp".length &&
    /^[0-9a-f]+$/.test(middle)
  );
}

/**
 * Removes the temporary files an earlier run left beside the target (see the top of this file): regular files whose
 * name is this script's own pattern, and nothing else. Returns how many it removed. A folder that cannot be read, or a
 * leftover that cannot be removed, stops the run before anything is written.
 */
function removeLeftovers(target) {
  const folder = path.dirname(target);
  let entries;
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    throw new Stop(
      1,
      `${SCRIPT}: refused: the folder of .dev.vars cannot be read (${codeOf(error)}), so a temporary file an earlier run left there, which may hold a token, cannot be removed; nothing was made or written`,
    );
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !isTempName(entry.name, target)) continue;
    try {
      rmSync(path.join(folder, entry.name));
      removed += 1;
    } catch (error) {
      if (codeOf(error) === "ENOENT") continue;
      throw new Stop(
        1,
        `${SCRIPT}: refused: a temporary file an earlier run left beside .dev.vars, ${entry.name}, which may hold a token, cannot be removed (${codeOf(error)}); remove it (its contents are never shown), then run this again; nothing was made or written`,
      );
    }
  }
  return removed;
}

/** Writes the text whole to a new file beside the target, with the target's mode, and renames it over the target. */
function writeWhole(target, mode, text) {
  const temp = `${target}.${randomBytes(TEMP_NAME_BYTES).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
    chmodSync(temp, mode);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new Stop(
      1,
      `${SCRIPT}: failed: .dev.vars could not be written (${codeOf(error)}); it is as it was, and the token made for it is dropped`,
    );
  }
}

/** The run (see the top of this file): its exit code. Writes only the one line of standard output and a note. */
function main(argv, env, out, err) {
  const rotate = parseArgs(argv);
  const { target, mode, lines, at, value } = readDevVars();
  // Beside the file written (a link's target), and beside .dev.vars itself, where a run wrote while it was no link.
  const removed = removeLeftovers(target) + (target === DEV_VARS ? 0 : removeLeftovers(DEV_VARS));
  if (removed > 0) {
    err(
      `${SCRIPT}: removed ${String(removed)} leftover temporary file${removed === 1 ? "" : "s"} beside .dev.vars (a run stopped between its write and its rename leaves one); what ${removed === 1 ? "it" : "they"} held is not shown`,
    );
  }
  if (value !== "" && !rotate) {
    if (!isMadeForm(value)) {
      throw new Stop(
        1,
        `${SCRIPT}: refused: .dev.vars holds ${TOKEN_NAME} in a form other than the one it is made in (43 characters of base64url that are 32 bytes), so seed:staging refuses it; it is left as it is, and no part of it is shown: --rotate replaces it`,
      );
    }
    out(`${TOKEN_NAME} already set in .dev.vars: left as it is (--rotate makes a new one)`);
  } else {
    const token = newToken();
    let text;
    if (at >= 0) {
      const end = /\r?\n$/.exec(lines[at])?.[0] ?? "";
      text = [...lines.slice(0, at), `${TOKEN_NAME}=${token}${end}`, ...lines.slice(at + 1)].join("");
    } else {
      const before = lines.join("");
      text = `${before}${before === "" || before.endsWith("\n") ? "" : "\n"}${TOKEN_NAME}=${token}\n`;
    }
    writeWhole(target, mode, text);
    out(
      value !== ""
        ? `${TOKEN_NAME} replaced in .dev.vars (--rotate): npm run seed:staging -- --set check-tester seeds its sha256, which ends the old token's session`
        : `${TOKEN_NAME} made and kept in .dev.vars: npm run seed:staging hands its sha256 to the check-tester set`,
    );
  }
  if ((env[TOKEN_NAME] ?? "") !== "") {
    err(
      `${SCRIPT}: ${TOKEN_NAME} is also set in this shell's environment (its value is not shown), and seed:staging reads the environment before .dev.vars: unset it there to use the token .dev.vars holds`,
    );
  }
  return 0;
}

try {
  process.exitCode = main(
    process.argv.slice(2),
    process.env,
    (line) => process.stdout.write(`${line}\n`),
    (line) => process.stderr.write(`${line}\n`),
  );
} catch (error) {
  if (error instanceof Stop) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.code;
  } else {
    process.stderr.write(`${SCRIPT}: failed (${codeOf(error)}); .dev.vars is as it was\n`);
    process.exitCode = 1;
  }
}
