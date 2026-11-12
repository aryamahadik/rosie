#!/usr/bin/env node
// The live check of the Resend send adapter (T-419, run in T-1032; K-12 v1; DL-028; Q-23; NQ-R2). ES module, so strict
// mode is on.
//
//   node adapters/src/email/resend-send/live-check.mjs
//
// Sends one email through the adapter (index.ts beside this file, the code staging runs) to Resend's test inbox,
// delivered@resend.dev ("simulates a successfully delivered email": Resend's "Send test emails" page, read Nov 12 2026),
// from Rosie's address on mail.rosfield.com (DL-028), and prints what Resend answered. It takes no argument.
//
// Who runs it, and where (NQ-R2; T-1032): the lead, on the build Mac, in an interactive session with the user present,
// from the code folder (the checkout whose git-ignored variables file holds the key by name). Never headless and never in
// CI: with CI set it refuses. The one email counts against the account's daily quota (Resend Free: 100 a day; J-14).
//
// The key (rule 7): RESEND_API_KEY, read by name: from the environment when it is set there, else from its own line of
// the variables file `.dev.vars` in the folder this runs from, as infra/scripts/lib.sh's load_dev_var reads one name
// (`export` and one pair of quotes allowed). Nothing else is read from that file. The key goes to the adapter alone,
// which sends it only as Resend's Authorization header; no line printed holds it, and any error's text is printed with
// it taken out.
//
// Where it can send: the adapter's allow-list (K-12 default 19, STAGING_TEST_INBOXES) is set here to Resend's test inbox
// alone, so no other address can be sent to, whatever the environment holds.
//
// What it prints, and its exit code:
//   live-check: PASS: Resend accepted the email: provider message id <id> ...           0
//   live-check: FAIL: Resend answered <kind> (HTTP <status>, <code>): <reason>          1
//   live-check: refused: <why>; nothing was sent                                       1 (2 for an argument)
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The name the key is read by (K-12 default 1; the adapter's own RESEND_API_KEY). */
export const KEY_NAME = "RESEND_API_KEY";
/** The allow-list's name (the adapter's TEST_INBOXES), set here to the test inbox alone. */
export const LIST_NAME = "STAGING_TEST_INBOXES";
/** Resend's test inbox. */
export const TEST_INBOX = "delivered@resend.dev";
/** The git-ignored variables file of the folder this runs from. */
export const VARS_FILE = ".dev.vars";
/** The email's From: Rosie's own name and an address on mail.rosfield.com (K-12 defaults 2 and 3; DL-028). */
export const FROM = { name: "Rosie", address: "rosie@mail.rosfield.com" };

const ASSISTANT_LINE = "This is Rosie, an automated assistant.";
const REDACTED = "[redacted]";

/** The key once it is read, so a stray error's text can be printed without it. */
const loaded = { key: "" };

/** `text` with the key taken out. */
function scrub(text, key) {
  const line = String(text);
  return key === "" ? line : line.split(key).join(REDACTED);
}

/** An error as printed: its name and its message, the key taken out; never its other fields. */
function describeError(error, key) {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return scrub(`${name}: ${message}`, key);
}

/**
 * The value of one name in a variables file: the first line `NAME=value` (an `export ` before it and spaces around the
 * `=` allowed), trimmed, with one pair of quotes around it taken off. Undefined when the file or the line is missing.
 */
export function readDevVar(file, name) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const line = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=(.*)$`);
  for (const row of text.split(/\r?\n/)) {
    const match = line.exec(row);
    if (match === null) continue;
    const value = match[1].trim();
    const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
    return quoted === null ? value : quoted[1];
  }
  return undefined;
}

/** The one email the live check sends: a K-12 v1 email about no booking, to the test inbox, under a key of its own. */
export function liveCheckEmail(at, nonce) {
  return {
    idempotencyKey: `live-check-t1032-${at.replace(/[-:]/g, "")}-${nonce}/1/1`,
    purpose: "notice",
    bookingId: null,
    from: { ...FROM },
    to: TEST_INBOX,
    replyTo: null,
    subject: "Rosie live check",
    text: `${ASSISTANT_LINE}\n\nThis is a live check of Rosie's email adapter (T-1032). Nothing needs doing.`,
    assistantLine: ASSISTANT_LINE,
    manageLink: null,
    chatLink: null,
    thread: { inReplyTo: null, references: [] },
  };
}

const wholeSeconds = () => new Date().toISOString().replace(/[.][0-9]+Z$/, "Z");

/**
 * The live check, with what it reads and writes handed in: `env` and `cwd` (where the key is read), `fetch` and `now`
 * for the adapter (its defaults when absent), and `out` and `err` for lines. Returns the exit code.
 */
export async function runLiveCheck(io) {
  const { argv = [], env, cwd, out, err } = io;
  let key = "";
  const say = (write, line) => write(scrub(line, key));
  try {
    if (argv.length > 0) {
      say(err, "live-check: refused: it takes no argument; nothing was sent");
      return 2;
    }
    if (typeof env.CI === "string" && env.CI !== "") {
      say(
        err,
        "live-check: refused: CI is set, and a live check runs only in an interactive session (NQ-R2); nothing was sent",
      );
      return 1;
    }
    const fromEnv = env[KEY_NAME];
    key =
      typeof fromEnv === "string" && fromEnv.trim() !== ""
        ? fromEnv
        : (readDevVar(path.join(cwd, VARS_FILE), KEY_NAME) ?? "");
    loaded.key = key;
    if (key.trim() === "") {
      say(
        err,
        `live-check: refused: ${KEY_NAME} is not set, in the environment or in ${VARS_FILE} in the folder this runs ` +
          "from (run it from the code folder); nothing was sent",
      );
      return 1;
    }

    const { createResendSender } = await import("./index.ts");
    const sender = createResendSender({
      env: { [KEY_NAME]: key, [LIST_NAME]: TEST_INBOX },
      fetch: io.fetch,
      now: io.now,
    });
    const email = liveCheckEmail((io.now ?? wholeSeconds)(), randomUUID().slice(0, 8));
    say(
      out,
      `live-check: sending one email to Resend's test inbox ${TEST_INBOX} under idempotency key ${email.idempotencyKey}`,
    );
    const outcome = await sender.sendEmail(email);
    if (outcome.result === "accepted") {
      say(
        out,
        `live-check: PASS: Resend accepted the email: provider message id ${outcome.providerMessageId}, accepted at ` +
          outcome.acceptedAt,
      );
      return 0;
    }
    say(
      err,
      `live-check: FAIL: Resend answered ${outcome.kind} (HTTP ${outcome.httpStatus ?? "none"}, ` +
        `${outcome.code ?? "no code"}): ${outcome.reason}`,
    );
    return 1;
  } catch (error) {
    say(err, `live-check: failed: ${describeError(error, key)}`);
    return 1;
  }
}

function runAsScript() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runAsScript()) {
  // An error no catch takes is printed as its name and message, the key taken out, never with its fields.
  for (const event of ["uncaughtException", "unhandledRejection"]) {
    process.on(event, (error) => {
      console.error(`live-check: failed: ${describeError(error, loaded.key)}`);
      process.exit(1);
    });
  }
  // The adapter's files import each other without an extension, as the bundler resolves them; Node completes a relative
  // import from a .ts file with .ts or /index.ts here, as db/seeds/run.mjs and infra/flags/flags.mjs do.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const parent = context.parentURL ?? "";
        const relative = specifier.startsWith("./") || specifier.startsWith("../");
        if (!relative || !parent.startsWith("file:") || !parent.endsWith(".ts")) throw error;
        for (const suffix of [".ts", "/index.ts"]) {
          try {
            return nextResolve(`${specifier}${suffix}`, context);
          } catch {
            // not this form: try the next one
          }
        }
        throw error;
      }
    },
  });
  process.exitCode = await runLiveCheck({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
