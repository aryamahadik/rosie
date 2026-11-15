// The outbound Linq probe (T-1121; K-11 v1; the lead note DL-841 on the card), behind probe.sh and probe.mjs. probe.sh
// reads the values by name and hands them to probe.mjs on standard input; probe.mjs calls runProbe. This file reads no
// environment variable, starts no other program, and writes only into the run's own output folder.
//
// The steps, run in this order, each only when chosen (see parseArgs and FINDINGS.md):
//   capability        Linq's iMessage and RCS capability checks for the destination: two reads, no message
//   contact           contacts/add for the destination: no message (its path is a TODO for phase 2: wire.mjs)
//   send              one text to the destination
//   stopped           one text, after the phone has texted STOP (403 with code 2024 expected)
//   stopped-override  one text after STOP, sent with override_optout (what it changes)
// A message step sends at most one message (MessageBudget), never retries, and its words say plainly that it is a Rosie
// staging test (WORDS).
//
// Before any request, every value is checked and the run is refused, naming the variable alone (a number at most by
// its last 2 digits), when: STAGING_LINQ_ALLOWLIST is missing, empty or holds an entry that is not E.164; the
// destination (LINQ_PROBE_TO, else the list's one number) is not on that list; LINQ_API_TOKEN is missing or unusable;
// neither ROSIE_NUMBER nor LINQ_FROM gives the sending line; or, in a dry run, any number is not a fiction one.
//
// The key goes in the Authorization header of each request and nowhere else. Every line printed and every file written
// passes maskJson or maskText first: each number shows its last 2 digits alone (***01), the key would show as [key], an
// email address as [email] and a name field as [name].

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { startStub } from "./stub.mjs";
import {
  API_PATH,
  CHAT_CREATE_PATH,
  CHECK_IMESSAGE_PATH,
  CHECK_RCS_PATH,
  CONTACT_ADD_PATH,
  LINQ_ORIGIN,
  capabilityBody,
  chatCreateBody,
  contactAddBody,
  readCapability,
  readContactAdd,
  readSend,
} from "./wire.mjs";

/** The repository's root, where a live run's default output folder is made (scratch/ is git-ignored). */
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** How long one request may take before the probe gives up on it (no retry follows). */
export const REQUEST_TIMEOUT_MS = 20_000;

/** The names the values come by (probe.sh reads them; the lead note, item 2). */
export const NAMES = Object.freeze({
  key: "LINQ_API_TOKEN",
  line: "ROSIE_NUMBER",
  lineElse: "LINQ_FROM",
  allowList: "STAGING_LINQ_ALLOWLIST",
  to: "LINQ_PROBE_TO",
});

/** Every step, in the order a run takes them. */
export const STEPS = Object.freeze(["capability", "contact", "send", "stopped", "stopped-override"]);

/** A live run with no --step: the two reads and one text. contact and the two stopped steps run only when named. */
export const LIVE_DEFAULT_STEPS = Object.freeze(["capability", "send"]);

/** The steps that send a message, one each at most. */
export const MESSAGE_STEPS = Object.freeze(["send", "stopped", "stopped-override"]);

/** The steps that need the phone to have texted STOP first (the lead note, item 4: only on the user's yes). */
export const AFTER_STOP = Object.freeze(["stopped", "stopped-override"]);

/** Each message step's words: plainly a Rosie staging test (the lead note, item 5). */
export const WORDS = Object.freeze({
  send: "Rosie staging test (T-1121): a test text from Rosie's line. No reply needed.",
  stopped: "Rosie staging test (T-1121): a test text sent after STOP. No reply needed.",
  "stopped-override":
    "Rosie staging test (T-1121): a test text sent after STOP with override_optout. No reply needed.",
});

export const USAGE = [
  "usage: bash adapters/spikes/linq-live/probe.sh --dry-run [--step <step>]... [--out <folder>] [--stub-url http://127.0.0.1:<port>]",
  "       bash adapters/spikes/linq-live/probe.sh --live [--step <step>]... [--out <folder>]",
  `steps: ${STEPS.join(", ")} (a dry run's default: all; a live run's: ${LIVE_DEFAULT_STEPS.join(", ")})`,
].join("\n");

/** A command line the probe does not take (exit 2). Its message never holds an argument. */
export class Misuse extends Error {}

/** A request the probe will not make. */
export class ProbeRefusal extends Error {}

// ---- numbers ----

const E164 = /^\+[1-9][0-9]{6,14}$/;
// The toll-free area codes, where 555-01xx is no fiction (infra/ci/phone-scan.mjs TOLL_FREE_AREA_CODES, T-1359).
const TOLL_FREE = ["800", "833", "844", "855", "866", "877", "888", "822", "880", "881"];
const TOLL_FREE_MORE = ["882", "883", "884", "885", "886", "887", "889"];
/** The +1 fiction range: +1, an area code that is not toll-free, then 555-0100 to 555-0199 (phone-scan.mjs). */
const FICTION = new RegExp(
  `^\\+1(?!(?:${[...TOLL_FREE, ...TOLL_FREE_MORE].join("|")}))[2-9][0-9]{2}55501[0-9]{2}$`,
);

export const isE164 = (value) => E164.test(value);
export const isFiction = (value) => FICTION.test(value);

/** A number as every output and sample shows it: its last 2 digits alone. */
export function masked(number) {
  return `***${String(number)
    .replace(/[^0-9]/g, "")
    .slice(-2)}`;
}

// ---- masking ----

const SEP = "[ ().-]*";
// A known number written any way: with or without +, 1 and the separators between its digits.
function knownNumber(number) {
  const digits = number.slice(1);
  const join = (text) => text.split("").join(SEP);
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : null;
  const forms =
    national === null ? `(?:\\+${SEP})?${join(digits)}` : `(?:\\+?${SEP}1${SEP})?${join(national)}`;
  return new RegExp(`(?<![0-9])${forms}(?![0-9])`, "g");
}
// Any other number, as a defence: a + and 7 to 15 digits; a North American number with separators; ten digits in a row.
const PLUS_NUMBER = /(?<![0-9A-Za-z])\+[1-9](?:[ ().-]{0,2}[0-9]){6,14}(?![0-9])/g;
const NANP_SEPARATED =
  /(?<![0-9A-Za-z+])(?:1[ .-])?(?:\([2-9][0-9]{2}\)[ .-]?|[2-9][0-9]{2}[ .-])[2-9][0-9]{2}[ .-][0-9]{4}(?![0-9])/g;
const NANP_RUN = /(?<![0-9A-Za-z+])1?[2-9][0-9]{2}[2-9][0-9]{2}[0-9]{4}(?![0-9A-Za-z])/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** A field that may hold a person's name (display_name, first_name, ...): its text is never kept. */
const NAME_FIELD = /name/i;

/**
 * Text as the probe may print or write it: the key as [key], each known number and any other number as its last 2
 * digits (***01), an email address as [email]. `secret` is {key, numbers}.
 */
export function maskText(text, secret) {
  let out = String(text);
  if (secret.key.length > 0) out = out.split(secret.key).join("[key]");
  for (const number of secret.numbers) out = out.replace(knownNumber(number), masked(number));
  out = out.replace(EMAIL, "[email]");
  for (const pattern of [PLUS_NUMBER, NANP_SEPARATED, NANP_RUN])
    out = out.replace(pattern, (found) => masked(found));
  return out;
}

/** A JSON value with maskText applied to every string and key, a name field's text replaced by [name]. */
export function maskJson(value, secret) {
  if (typeof value === "string") return maskText(value, secret);
  if (typeof value === "number" && Number.isInteger(value) && Math.abs(value) >= 1_000_000) {
    const text = String(value);
    return maskText(text, secret) === text ? value : masked(text);
  }
  if (Array.isArray(value)) return value.map((item) => maskJson(item, secret));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        maskText(name, secret),
        NAME_FIELD.test(name) && typeof item === "string" ? "[name]" : maskJson(item, secret),
      ]),
    );
  }
  return value;
}

// ---- the command line and the values ----

const STUB_URL = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/?$/;

/**
 * The command line: the mode first (--dry-run or --live), then --step <step> (repeatable), --out <folder> and, in a
 * dry run alone, --stub-url http://127.0.0.1:<port> (another local stand-in, such as the test's). Throws Misuse.
 */
export function parseArgs(argv) {
  const [first, ...rest] = argv;
  if (first !== "--dry-run" && first !== "--live")
    throw new Misuse("the first argument is --dry-run or --live");
  const mode = first.slice(2);
  const named = new Set();
  let out = null;
  let stubUrl = null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = rest[i + 1];
    if (arg === "--step") {
      if (!STEPS.includes(value)) throw new Misuse(`--step takes one of ${STEPS.join(", ")}`);
      named.add(value);
      i += 1;
    } else if (arg === "--out") {
      if (value === undefined || value === "" || value.startsWith("--"))
        throw new Misuse("--out takes a folder");
      out = value;
      i += 1;
    } else if (arg === "--stub-url") {
      const port = STUB_URL.exec(value ?? "")?.[1];
      if (port === undefined || Number(port) < 1 || Number(port) > 65535) {
        throw new Misuse(
          "--stub-url takes http://127.0.0.1:<port> alone: a dry run never leaves this machine",
        );
      }
      stubUrl = `http://127.0.0.1:${port}`;
      i += 1;
    } else {
      throw new Misuse("an argument it does not take (arguments are never echoed)");
    }
  }
  if (mode === "live" && stubUrl !== null)
    throw new Misuse("--stub-url is for a dry run: a live run calls Linq alone");
  const steps =
    named.size > 0
      ? STEPS.filter((step) => named.has(step))
      : mode === "live"
        ? [...LIVE_DEFAULT_STEPS]
        : [...STEPS];
  const afterStop = steps.filter((step) => AFTER_STOP.includes(step));
  if (mode === "live" && afterStop.length > 0 && afterStop.length < steps.length) {
    throw new Misuse("a live run takes the stopped steps alone, after the phone has texted STOP");
  }
  return { mode, steps, out, stubUrl };
}

/** The five values, one a line, in probe.sh's order. A missing line is "". */
export function parseValues(text) {
  const [key = "", rosieNumber = "", linqFrom = "", allowList = "", to = ""] = text.split("\n");
  return { key, rosieNumber, linqFrom, allowList, to };
}

/**
 * Checks the values before any request. Gives {problems, values}: each problem names its variable (a number at most
 * as ***01) and never holds a key; values is null unless there is none.
 */
export function checkValues(raw, mode) {
  const problems = [];
  const fiction = (name, number) => {
    if (mode === "dry-run" && !isFiction(number)) {
      problems.push(
        `${name}: a dry run takes fiction numbers alone (+1, an area code, then 555-0100 to 555-0199), and this one is not (no part of it is shown)`,
      );
    }
  };

  let list = null;
  if (raw.allowList.trim() === "") {
    problems.push(
      `${NAMES.allowList} is not set, or is empty: the probe sends nothing to a number off that list, so it sends nothing at all (E.164 numbers joined by commas, no space)`,
    );
  } else {
    const entries = raw.allowList.split(",");
    const bad = entries.flatMap((entry, i) => (isE164(entry) ? [] : [i + 1]));
    if (bad.length > 0) {
      problems.push(
        `${NAMES.allowList}: entry ${bad.join(", ")} of ${String(entries.length)} is not an E.164 number (+, then 7 to 15 digits, joined by commas with no space); no part of it is shown`,
      );
    } else {
      list = [...new Set(entries)];
      for (const entry of list) fiction(NAMES.allowList, entry);
    }
  }

  if (raw.key === "") {
    problems.push(`${NAMES.key} is not set: Linq's API key, read by name, is needed for every request`);
  } else if (raw.key.length < 8 || /[\s\p{Cc}]/u.test(raw.key)) {
    problems.push(
      `${NAMES.key} is not a usable key (fewer than 8 characters, or a space or control character in it); no part of it is shown`,
    );
  }

  let lineName = null;
  if (raw.rosieNumber !== "") lineName = NAMES.line;
  else if (raw.linqFrom !== "") lineName = NAMES.lineElse;
  const line = lineName === NAMES.line ? raw.rosieNumber : raw.linqFrom;
  if (lineName === null) {
    problems.push(
      `neither ${NAMES.line} nor ${NAMES.lineElse} is set: Rosie's sending line opens the probe's chat`,
    );
  } else if (!isE164(line)) {
    problems.push(`${lineName} is not an E.164 number; no part of it is shown`);
  } else {
    fiction(lineName, line);
  }

  let destination = null;
  if (raw.to !== "") {
    if (!isE164(raw.to)) problems.push(`${NAMES.to} is not an E.164 number; no part of it is shown`);
    else if (list !== null && !list.includes(raw.to)) {
      problems.push(
        `${NAMES.to} (${masked(raw.to)}) is not on ${NAMES.allowList}: the probe sends to no number off that list`,
      );
    } else destination = raw.to;
  } else if (list !== null && list.length > 1) {
    problems.push(
      `${NAMES.allowList} holds ${String(list.length)} numbers and ${NAMES.to} names none: name the one destination with ${NAMES.to}`,
    );
  } else if (list !== null) destination = list[0];
  if (destination !== null && lineName !== null && destination === line) {
    problems.push(
      `the destination is Rosie's own sending line (${lineName}): the probe never texts the line itself`,
    );
  }

  if (problems.length > 0 || list === null || destination === null || lineName === null) {
    return { problems, values: null };
  }
  return { problems, values: { key: raw.key, line, lineName, allowList: list, destination } };
}

/** At most one message for each step: a second one is refused before it is sent (the lead note, item 5). */
export class MessageBudget {
  #sent = new Set();

  take(step) {
    if (this.#sent.has(step))
      throw new ProbeRefusal(`step ${step} has sent its one message: no second one goes`);
    this.#sent.add(step);
  }
}

// ---- a run ----

const pad = (n) => String(n).padStart(2, "0");
const stampOf = (date) =>
  `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}Z`;

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The response headers a sample keeps; no other (never a cookie).
const KEPT_HEADERS = ["content-type", "retry-after", "x-request-id", "x-trace-id"];

function keptHeaders(headers) {
  return Object.fromEntries(
    KEPT_HEADERS.filter((name) => headers.has(name)).map((name) => [name, headers.get(name)]),
  );
}

/** What a request that got no answer says: the error's kind and code alone, never its message (it can hold a URL). */
function noAnswer(error) {
  const name = error instanceof Error ? error.name : "Error";
  const code =
    error instanceof Error && error.cause !== null && typeof error.cause === "object" ? error.cause.code : "";
  return typeof code === "string" && /^[A-Z_]+$/.test(code) ? `${name} (${code})` : name;
}

function describe(outcome) {
  if (outcome.call === "capabilityCheck" && outcome.result === "checked") {
    return `checked: ${outcome.check} available ${String(outcome.available)}${outcome.reason === null ? "" : ` (${outcome.reason})`}, service ${String(outcome.service)}`;
  }
  if (outcome.result === "accepted") return `accepted, service ${String(outcome.service)}`;
  if (outcome.result === "added") return "added";
  const parts = [outcome.result];
  if (outcome.kind !== undefined) parts.push(outcome.kind);
  if (outcome.code !== null && outcome.code !== undefined) parts.push(`code ${outcome.code}`);
  if (outcome.retryAfterSeconds !== undefined && outcome.retryAfterSeconds !== null) {
    parts.push(`retry after ${String(outcome.retryAfterSeconds)} s`);
  }
  return parts.join(", ");
}

async function outputFolder(args, now) {
  if (args.out !== null) {
    const dir = path.resolve(args.out);
    await mkdir(dir, { recursive: true });
    if ((await readdir(dir)).length > 0)
      throw new Misuse("the --out folder is not empty: give a new or empty one");
    return dir;
  }
  if (args.mode === "dry-run") return mkdtemp(path.join(tmpdir(), "linq-live-dry-run-"));
  const dir = path.join(REPO, "scratch", "linq-live", `live-${stampOf(now())}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * One run: the command line in argv, the values on stdin (probe.sh's five lines), lines out on stdout and stderr.
 * Returns the exit code: 0 every chosen step ran and each request had an answer (whatever Linq said); 1 refused before
 * any request, or a request had no answer (the later steps do not run); 2 misuse.
 */
export async function runProbe({ argv, stdin, stdout, stderr, now = () => new Date() }) {
  const say = (line) => stdout.write(`linq-live: ${line}\n`);
  const warn = (line) => stderr.write(`linq-live: ${line}\n`);
  const misuse = (error) => {
    warn(`misuse: ${error.message}`);
    stderr.write(`${USAGE}\n`);
    return 2;
  };

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof Misuse) return misuse(error);
    throw error;
  }
  if (stdin.isTTY === true) {
    return misuse(new Misuse("probe.mjs takes its values on standard input from probe.sh: run probe.sh"));
  }
  const { problems, values } = checkValues(parseValues(await readAll(stdin)), args.mode);
  if (values === null) {
    warn("refused before any request (nothing was sent):");
    for (const problem of problems) warn(`  - ${problem}`);
    return 1;
  }

  const secret = {
    key: values.key,
    numbers: [...new Set([values.destination, values.line, ...values.allowList])],
  };
  const mask = (text) => maskText(text, secret);
  let out;
  try {
    out = await outputFolder(args, now);
  } catch (error) {
    if (error instanceof Misuse) return misuse(error);
    throw error;
  }

  const startedAt = now();
  const runId = `${stampOf(startedAt)}-${randomUUID().slice(0, 8)}`;
  const stub = args.mode === "dry-run" && args.stubUrl === null ? await startStub() : null;
  const origin = args.mode === "live" ? LINQ_ORIGIN : (stub?.url ?? args.stubUrl);
  const where = args.mode === "live" ? "Linq's API (api.linqapp.com)" : "a local stand-in on 127.0.0.1";
  say(
    mask(
      `${args.mode} run ${runId} against ${where}: steps ${args.steps.join(", ")}; destination ${masked(values.destination)} (on ${NAMES.allowList}, ${String(values.allowList.length)} number(s)); sending line ${masked(values.line)} (${values.lineName})`,
    ),
  );

  const calls = [];
  let written = 0;
  const call = async (step, name, route, body, read) => {
    const url = new URL(`${origin}${API_PATH}${route}`);
    if (url.origin !== origin) throw new ProbeRefusal("a request would leave the run's one origin");
    const at = now().toISOString();
    const started = performance.now();
    let status = null;
    let headers = {};
    let text = "";
    let failure = null;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${values.key}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = response.status;
      headers = keptHeaders(response.headers);
      text = await response.text();
    } catch (error) {
      failure = noAnswer(error);
    }
    const elapsedMs = Math.round(performance.now() - started);
    const answer = parseJson(text);
    const outcome = failure === null ? read(status, answer) : { ...read(null, null), noAnswer: failure };
    const record = {
      card: "T-1121",
      run: runId,
      mode: args.mode,
      step,
      call: name,
      at,
      elapsedMs,
      request: { method: "POST", path: `${API_PATH}${route}`, body },
      response: failure === null ? { status, headers, body: answer ?? text } : { noAnswer: failure },
      port: outcome,
    };
    written += 1;
    const file = `${pad(written)}-${step}-${name}.json`;
    await writeFile(path.join(out, file), `${JSON.stringify(maskJson(record, secret), null, 2)}\n`);
    calls.push(maskJson({ file, step, call: name, status, elapsedMs, port: outcome }, secret));
    say(
      mask(
        `${step}: ${name} answered ${status === null ? "nothing" : String(status)} in ${String(elapsedMs)} ms: ${describe(outcome)}`,
      ),
    );
    return failure === null;
  };

  const budget = new MessageBudget();
  let code = 0;
  try {
    for (const step of args.steps) {
      if (stub !== null && AFTER_STOP.includes(step)) stub.simulateStop(values.destination);
      let answered = true;
      if (step === "capability") {
        const read = (which) => (status, answer) => readCapability(which, status, answer);
        answered = await call(
          step,
          "check_imessage",
          CHECK_IMESSAGE_PATH,
          capabilityBody(values.destination),
          read("imessage"),
        );
        if (answered) {
          answered = await call(
            step,
            "check_rcs",
            CHECK_RCS_PATH,
            capabilityBody(values.destination),
            read("rcs"),
          );
        }
      } else if (step === "contact") {
        answered = await call(
          step,
          "contact_add",
          CONTACT_ADD_PATH,
          contactAddBody(values.destination),
          readContactAdd,
        );
      } else {
        budget.take(step);
        const body = chatCreateBody({
          from: values.line,
          to: values.destination,
          text: WORDS[step],
          idempotencyKey: `t1121-${step}-${runId}`,
          overrideOptout: step === "stopped-override",
        });
        answered = await call(step, "send", CHAT_CREATE_PATH, body, readSend);
      }
      if (!answered) {
        warn(
          `${step}: a request had no answer; the probe never retries (a send may still have gone), and the later steps did not run`,
        );
        code = 1;
        break;
      }
    }
  } finally {
    await stub?.close();
  }

  const summary = {
    card: "T-1121",
    run: runId,
    mode: args.mode,
    startedAt: startedAt.toISOString(),
    steps: args.steps,
    destination: masked(values.destination),
    sendingLine: { variable: values.lineName, number: masked(values.line) },
    allowListNumbers: values.allowList.length,
    calls,
  };
  await writeFile(path.join(out, "run.json"), `${JSON.stringify(maskJson(summary, secret), null, 2)}\n`);
  say(mask(`wrote ${String(written + 1)} file(s) to ${out}`));
  return code;
}
