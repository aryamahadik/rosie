// T-1255 (ADR-014 section 4's piece 7): the run script of the live check of staging's two Hyperdrive configurations.
// The lead runs it on the build Mac, from the code folder, after the user's run of T-1252's script (npm run
// hyperdrive:staging:create) and once this card has merged, before the first deploy whose Worker opens a client through
// either binding (ADR-014's Order). It takes one argument, the postmaster start that run printed ("postmaster started
// ..."), quoted as one word, as the lead gives it; never a value of its own:
//   node infra/spikes/hyperdrive-roles/run.mjs '<that run's postmaster start, e.g. 2026-01-02 03:04:05.123456+00>'
//
// What it does, in order (README.md has what each line means); each refusal exits 1 before anything after it starts:
//  1. Lists the account's Hyperdrive configurations through cf.sh (`hyperdrive list`) and reads the list with T-1252's
//     parser (infra/scripts/hyperdrive-list.mjs). It refuses when rosie-staging-hyperdrive-job or
//     rosie-staging-hyperdrive-app is missing, when either's caching is not disabled (ADR-007), or when either's stored
//     user is not its login. The list names each origin's host and user: it is kept in this process, never printed,
//     and every host and every other user in it is taken out of any outside text this script prints.
//  2. Reads the version that serves staging (cf.sh deployments status --env staging --json), and stops when it cannot.
//  3. Writes a wrangler config to a new temporary folder (the system's temp folder, mode 700) that binds the two
//     configurations by those ids as HYPERDRIVE_JOB and HYPERDRIVE_APP, and nothing else, and starts a remote dev
//     session on it through cf.sh (`dev --env staging --remote`, CF_BUILD_DIR set to that folder), as the spike T-1124
//     did: no deploy, no version, no secret. The session's only variable is the run's random token, which every request
//     carries.
//  4. Calls /ready, then /probe once (worker.mjs, probe.mjs), stops the session, and reads the serving version again:
//     it must be the one from before (the session deployed nothing).
//  5. Prints the result, rebuilt for printing (probe.mjs's printable: no name but the two logins, their roles and
//     PostgreSQL's own; no password, connection string or host), then the verdict, recomputed here from what is
//     printed (probe.mjs's verdict), with each binding's postmaster start beside the run's.
// The temporary folder is removed at the end, on success and on failure (Ctrl-C included), and the session stopped.
//
// Exit: 0 every check passed and the persistence proof holds (every read came from a postmaster started after the
// run's); 3 every role check passed but the persistence proof does not hold yet (a read came from the run's own
// postmaster): NOT a pass, run again once the compute has suspended (DL-733); 1 refused or failed; 2 misuse.
// PROBE_PORT (default 8799): the local port of the dev session.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { hyperdriveRow } from "../../scripts/hyperdrive-list.mjs";
import { PROBE, SIDES, formatStart, parseStart, printable, verdict } from "./probe.mjs";

const PROGRAM = "hyperdrive-roles";
const HERE = import.meta.dirname;
const CF = path.join(HERE, "..", "..", "scripts", "cf.sh");
const WORKER = path.join(HERE, "worker.mjs");
// The Rosfield account: cf.sh pins the same id (ROSFIELD_ACCOUNT_ID) and refuses a config that names another.
export const ACCOUNT_ID = "ecb06e7bc9129fa81104d331e9652362";
const DEFAULT_PORT = 8799;
const READY_SECONDS = 120;
const PROBE_SECONDS = 600;
// Names no child is given: the database URLs (the probe needs none), the credentials wrangler would take before the
// Rosfield sign-in, and CF_BUILD_DIR (set here for the dev session alone).
const DROPPED_NAMES = [
  "STAGING_DATABASE_URL",
  "DATABASE_URL",
  "DATABASE_REPLICA_URL",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_API_TOKEN",
  "CF_API_KEY",
  "CF_EMAIL",
  "CF_BUILD_DIR",
];
export const EXIT = Object.freeze({ passed: 0, failed: 1, misuse: 2, notYetProved: 3 });

/** A run stopped on purpose: its message says why and holds no cell of the list but ids, caching and the logins. */
class Refusal extends Error {}
/** A command line it does not take (exit 2). */
class Misuse extends Error {}

const say = (line) => {
  process.stdout.write(`[${new Date().toISOString().slice(0, 19)}Z] ${line}\n`);
};

/** The environment of every child: this one's, without DROPPED_NAMES, and wrangler's logs kept off the disk. */
export function childEnvironment(env = process.env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !DROPPED_NAMES.includes(name)) out[name] = value;
  }
  out.WRANGLER_LOG_SANITIZE = "true";
  out.WRANGLER_WRITE_LOGS = "false";
  out.WRANGLER_SEND_METRICS = "false";
  return out;
}

/** Runs `bash cf.sh <args>` and keeps both of its outputs. */
function cf(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [CF, ...args], {
      env: childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        status: code ?? (signal === null ? 1 : 128),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

/** A terminal's colour codes, which wrangler may put around its table. */
const COLOUR_CODES = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * The texts of the list that no printed line may hold: every host cell, and every user cell but the two logins. Only
 * this script's own lines name the logins; outside text (an error, wrangler's log) is scrubbed of these.
 */
export function outsideTexts(listing, sides = SIDES) {
  const rows = String(listing)
    .replace(COLOUR_CODES, "")
    .split("\n")
    .filter((line) => line.startsWith("│"))
    .map((line) =>
      line
        .split("│")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  if (rows.length === 0) return [];
  const [head, ...data] = rows;
  const logins = new Set(sides.map((side) => side.login));
  const texts = new Set();
  for (const row of data) {
    const host = row[head.indexOf("host")];
    const user = row[head.indexOf("user")];
    if (typeof host === "string" && host.length >= 3) texts.add(host);
    if (typeof user === "string" && user.length >= 3 && !logins.has(user)) texts.add(user);
  }
  return [...texts];
}

/** A function that takes each of the texts out of a text, longest first. */
export function makeScrub(texts) {
  const ordered = [...new Set(texts.filter((text) => typeof text === "string" && text !== ""))].sort(
    (a, b) => b.length - a.length,
  );
  return (text) => {
    let out = String(text);
    for (const secret of ordered) out = out.split(secret).join("[redacted]");
    return out;
  };
}

/**
 * Each side's row of the list (T-1252's parser): its id, its caching disabled and its stored user its login, or a
 * Refusal that says which is not so, before anything is started. No refusal holds a cell but an id or caching.
 */
export function checkList(listing, sides = SIDES) {
  return sides.map((side) => {
    let row;
    try {
      row = hyperdriveRow(listing, side.name);
    } catch (error) {
      throw new Refusal(
        error.exitCode === 3
          ? `more than one Hyperdrive configuration is named ${side.name}; nothing was started`
          : `the Hyperdrive list could not be read (${String(error.message)}; its text is not shown: it names each origin's host and user); nothing was started`,
      );
    }
    if (row === null) {
      throw new Refusal(
        `${side.name} is not in the Hyperdrive list (the user's run of npm run hyperdrive:staging:create, T-1252, makes it); nothing was started`,
      );
    }
    if (row.caching !== "disabled") {
      throw new Refusal(
        `${side.name} (id ${row.id}) has caching ${row.caching}, not disabled (ADR-007: both sides make decision reads); nothing was started`,
      );
    }
    if (row.user !== side.login) {
      throw new Refusal(
        `${side.name} (id ${row.id}) stores ${row.user === null ? "a user the list does not show" : "another user (not shown)"}, not its login ${side.login}; nothing was started`,
      );
    }
    return { side, id: row.id, caching: row.caching };
  });
}

/**
 * The probe's own wrangler config, written to the temporary folder. Its top-level name is no Worker that exists (every
 * call names --env staging); env.staging.name is the one cf.sh requires. It binds the two configurations and nothing
 * else, so the Worker gets no other resource.
 */
export function probeConfig({ main, rows }) {
  return {
    name: "rosie-probe-t1255-never-deployed",
    account_id: ACCOUNT_ID,
    main,
    compatibility_date: "2026-11-01",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: true,
    preview_urls: true,
    env: {
      staging: {
        name: "rosie-staging",
        hyperdrive: rows.map(({ side, id }) => ({ binding: side.binding, id })),
      },
    },
  };
}

/**
 * The id of the version that serves the most traffic, from the text of `wrangler deployments status --json` (as the
 * spike T-1124's helpers.mjs reads it), or "" when the text does not say.
 */
export function liveVersion(statusText) {
  const text = String(statusText);
  try {
    const status = JSON.parse(text.slice(text.search(/^\{/m), text.lastIndexOf("}") + 1));
    const top = [...(status.versions ?? [])].sort((a, b) => b.percentage - a.percentage)[0];
    const id = top?.version_id ?? "";
    return /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ? id : "";
  } catch {
    return "";
  }
}

async function servingVersion() {
  const status = await cf(["deployments", "status", "--env", "staging", "--json"]);
  return status.status === 0 ? liveVersion(status.stdout) : "";
}

/** Whether something already answers on 127.0.0.1 at the port. */
function portAnswers(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}

/** GET with the run's token: { status, body } (body null when it is not JSON), or null when nothing answered. */
async function getJson(url, token, ms) {
  try {
    const response = await fetch(url, {
      headers: { "x-probe-token": token },
      redirect: "error",
      signal: AbortSignal.timeout(ms),
    });
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: response.status, body: null };
    }
  } catch {
    return null;
  }
}

// The dev session and its temporary folder: one of each in a run; scrub takes the run's token and the list's hosts and
// other users out of any outside text, from the moment each is known.
const session = { work: "", token: "", child: null, exited: true, scrub: (text) => String(text) };

/** Whether a read through a binding failed (an error, or a crossed read that did not answer). */
const readsFailed = (record) =>
  (Array.isArray(record?.sides) ? record.sides : []).some(
    (side) => Array.isArray(side?.errors) && side.errors.length > 0,
  ) || (Array.isArray(record?.crossed) ? record.crossed : []).some((entry) => entry?.answered !== true);

function signalGroup(pid, signal) {
  try {
    // The session runs in its own process group (detached), so workerd and esbuild stop with wrangler.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

async function exitedWithin(ms) {
  if (session.exited) return true;
  const child = session.child;
  return Promise.race([
    new Promise((resolve) => {
      child.once("exit", () => {
        resolve(true);
      });
    }),
    // Not ref'd: once the session has ended, this timer must not keep the run alive for the rest of `ms`.
    sleep(ms, undefined, { ref: false }).then(() => session.exited),
  ]);
}

async function stopSession() {
  if (session.child === null || session.exited) return;
  signalGroup(session.child.pid, "SIGTERM");
  if (!(await exitedWithin(10_000))) {
    signalGroup(session.child.pid, "SIGKILL");
    await exitedWithin(5_000);
  }
}

function removeWork() {
  if (session.work !== "") {
    rmSync(session.work, { recursive: true, force: true });
    session.work = "";
  }
}

function startSession(port) {
  const log = openSync(path.join(session.work, "dev.log"), "a");
  try {
    const child = spawn(
      "bash",
      [
        CF,
        "dev",
        "--env",
        "staging",
        "--remote",
        "--ip",
        "127.0.0.1",
        `--port=${String(port)}`,
        "--show-interactive-dev-session=false",
        "--var",
        `PROBE_TOKEN:${session.token}`,
      ],
      {
        env: { ...childEnvironment(), CF_BUILD_DIR: session.work },
        stdio: ["ignore", log, log],
        detached: true,
      },
    );
    session.child = child;
    session.exited = false;
    child.once("exit", () => {
      session.exited = true;
    });
    child.once("error", () => {
      session.exited = true;
    });
  } finally {
    closeSync(log);
  }
}

/** The end of the session's log, scrubbed, on standard error: after a failure only. */
function showLog(scrub) {
  try {
    const lines = readFileSync(path.join(session.work, "dev.log"), "utf8").split("\n").slice(-40);
    process.stderr.write(`${PROGRAM}: the end of wrangler's log (scrubbed):\n${scrub(lines.join("\n"))}\n`);
  } catch {
    process.stderr.write(`${PROGRAM}: wrangler's log could not be read\n`);
  }
}

async function waitReady(base) {
  for (let second = 0; second < READY_SECONDS; second += 1) {
    if (session.exited) return null;
    const got = await getJson(`${base}/ready`, session.token, 5_000);
    if (got?.status === 200 && got.body?.ready === true && got.body.probe === PROBE) return got.body;
    await sleep(1000);
  }
  return null;
}

function portOf(value) {
  if (value === undefined || value === "") return DEFAULT_PORT;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1024 || port > 65535) {
    throw new Misuse("PROBE_PORT must be a whole number from 1024 to 65535");
  }
  return port;
}

async function main(args) {
  if (args.length !== 1) {
    throw new Misuse(
      "it takes one argument: the postmaster start that T-1252's run printed, quoted as one word",
    );
  }
  let runStartUs;
  try {
    runStartUs = parseStart(args[0]);
  } catch (error) {
    throw new Misuse(
      `the run's postmaster start is not a timestamp with its time zone (${String(error.message)}); give it as that run printed it, such as '2026-01-02 03:04:05.123456+00'`,
    );
  }
  const port = portOf(process.env.PROBE_PORT);
  say(`the run's postmaster start, as given: ${formatStart(runStartUs)}`);

  // 1. The list, and the two configurations in it.
  const listed = await cf(["hyperdrive", "list"]);
  const listTexts = outsideTexts(listed.stdout);
  session.scrub = makeScrub(listTexts);
  if (listed.status !== 0) {
    if (listed.stderr.trim() !== "") process.stderr.write(`${session.scrub(listed.stderr.trim())}\n`);
    throw new Refusal(
      `cf.sh hyperdrive list failed (exit ${String(listed.status)}, for the reason above), so which configurations exist is not known; nothing was started`,
    );
  }
  const rows = checkList(listed.stdout);
  for (const { side, id, caching } of rows) {
    say(`${side.name}: id ${id}, caching ${caching}, stores ${side.login}: yes`);
  }

  // 2. The version that serves staging, before.
  const before = await servingVersion();
  if (before === "") {
    throw new Refusal(
      "the version that serves staging could not be read before the probe, so the before-and-after check could not be made; nothing was started. Check with: npm run cf -- deployments status --env staging",
    );
  }
  say(`staging: serves version ${before} before the probe`);
  if (await portAnswers(port)) {
    throw new Refusal(
      `port ${String(port)} on 127.0.0.1 already answers: set PROBE_PORT to a free port; nothing was started`,
    );
  }

  // 3. The temporary config, and the session on it.
  session.work = mkdtempSync(path.join(tmpdir(), "rosie-t1255-"));
  session.token = randomBytes(24).toString("hex");
  session.scrub = makeScrub([...listTexts, session.token]);
  const scrub = session.scrub;
  writeFileSync(
    path.join(session.work, "wrangler.jsonc"),
    `${JSON.stringify(probeConfig({ main: WORKER, rows }), null, 2)}\n`,
  );
  say(
    "remote: starting wrangler dev --remote through cf.sh from a temporary config that binds the two configurations (no deploy; the session ends with this run)",
  );
  startSession(port);
  const base = `http://127.0.0.1:${String(port)}`;
  const ready = await waitReady(base);
  if (ready === null) {
    showLog(scrub);
    throw new Refusal(
      session.exited
        ? "wrangler dev ended before the probe's Worker answered (the end of its log is above); nothing was read"
        : `the probe's Worker did not answer on ${base} within ${String(READY_SECONDS)} s (the end of wrangler's log is above); nothing was read`,
    );
  }
  const unbound = SIDES.filter((side) => ready.bindings?.[side.binding] !== true).map((side) => side.binding);
  if (unbound.length > 0) {
    throw new Refusal(`the session has no ${unbound.join(" or ")} binding; nothing was read`);
  }
  say(`remote: the probe's Worker answers on ${base} with HYPERDRIVE_JOB and HYPERDRIVE_APP bound`);

  // 4. The probe, then the session stopped and the serving version read again.
  say(
    "probe: running (through each binding: 50 reads outside a transaction, 5 inside one, then the crossed reads)",
  );
  const probe = await getJson(`${base}/probe`, session.token, PROBE_SECONDS * 1000);
  if (probe === null || probe.body === null) showLog(scrub);
  await stopSession();
  const after = await servingVersion();

  // 5. The record and the verdict.
  const problems = [];
  let record = null;
  let judged = { problems: [], lines: [], persistence: "unknown" };
  if (probe === null || probe.body === null) {
    problems.push(
      `the probe gave no result (${probe === null ? "no answer" : `HTTP ${String(probe.status)}, not JSON`})`,
    );
  } else {
    record = printable(probe.body, { scrub });
    say(
      `probe: HTTP ${String(probe.status)}; the result (no name but the two logins, their roles and PostgreSQL's own; no password, connection string or host):`,
    );
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    judged = verdict(record, { runStartUs });
    problems.push(...judged.problems);
  }
  if (after === "" || after !== before) {
    problems.push(
      after === ""
        ? `staging: the serving version could not be read after the probe (before: ${before}), so nothing shows that staging still serves it. Check with: npm run cf -- deployments status --env staging`
        : `staging: the serving version CHANGED during the probe: ${before} before, ${after} after. The probe deploys nothing, so look for another deploy in that time`,
    );
  } else {
    say(`staging: still serves version ${after}, the same as before the probe`);
  }
  for (const line of judged.lines) say(line);
  say(
    `caching: ${rows.map(({ side, caching }) => `${side.name} ${caching}`).join(", ")} (the list read before the session)`,
  );
  if (problems.length > 0) {
    say(`result: FAILED: ${String(problems.length)} problem(s):`);
    for (const problem of problems) say(`  - ${problem}`);
    if (readsFailed(record)) {
      say(
        "  A login refused once the compute has restarted since the run means Neon did not keep the password (DL-733): the Worker's ports stay closed, nothing is repaired by hand, and CQ-225 returns to the architect and the security reviewer.",
      );
    }
    return EXIT.failed;
  }
  if (judged.persistence === "not yet proved") {
    say(
      "result: NOT YET PROVED (exit 3): every read answered as its configuration's login with the table's expected answers and the crossed reads were refused, but the persistence proof does not hold yet: this is not a pass",
    );
    return EXIT.notYetProved;
  }
  say(
    "result: passed: every read through each configuration answered as its login with the table's expected answers, the crossed reads were refused, caching is disabled, and the persistence proof holds",
  );
  return EXIT.passed;
}

const AS_PROGRAM = process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename;

if (AS_PROGRAM) {
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.once(signal, () => {
      if (session.child !== null && !session.exited) signalGroup(session.child.pid, "SIGTERM");
      removeWork();
      process.exit(code);
    });
  }
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof Misuse) {
      process.stderr.write(
        `${PROGRAM}: ${error.message}\nusage: node infra/spikes/hyperdrive-roles/run.mjs '<the postmaster start T-1252's run printed>'\n`,
      );
      process.exitCode = EXIT.misuse;
    } else if (error instanceof Refusal) {
      process.stderr.write(`${PROGRAM}: refused: ${error.message}\n`);
      process.exitCode = EXIT.failed;
    } else {
      process.stderr.write(
        `${PROGRAM}: failed: ${session.scrub(error instanceof Error ? error.message : String(error))}\n`,
      );
      process.exitCode = EXIT.failed;
    }
  } finally {
    await stopSession();
    removeWork();
    session.token = "";
  }
}
