// T-1255: checks of run.mjs itself. Run: node --test infra/spikes/hyperdrive-roles/run.test.mjs
// Nothing here reaches Cloudflare or a database, and no real key is read. run.mjs runs in a throwaway checkout (a
// temporary folder) beside copies of the real infra/scripts/cf.sh, lib.sh and hyperdrive-list.mjs, with a stand-in for
// wrangler behind them (standin-wrangler.mjs). The stand-in's session answers /probe with what probe.mjs's runProbe
// gives against standin-postgres.mjs, so the result run.mjs judges has the Worker's own shape. PATH there holds only
// recorders (infra/ci/script-harness.mjs's spies): every command run.mjs and cf.sh start writes down its environment
// and arguments, then becomes the real command. Every value is made up. Not part of npm test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { test } from "node:test";

import { ROSFIELD_ACCOUNT_ID, SCRIPTS, spies, tempDir, write } from "../../ci/script-harness.mjs";
import { SIDES, runProbe } from "./probe.mjs";
import { standinOpen } from "./standin-postgres.mjs";

const HERE = import.meta.dirname;
const [JOB, APP] = SIDES;

// Made-up values, put together here: no real id, host, role, password, key or time.
const ID_JOB = "0123456789abcdef0123456789abcdef";
const ID_APP = "fedcba9876543210fedcba9876543210";
const ID_SPIKE = "11111111111111111111111111111111";
const HOST = "ep-made-up-000000.made-up-region.example.test";
const OWNER = "made_up_owner_t1255";
const CALLER_URL = `postgres://${OWNER}:made-up-password-t1255@${HOST}/made_up_db?sslmode=require`;
const CALLER_TOKEN = "made-up-cloudflare-token-t1255";
const RUN_START = "2026-01-02 03:04:05.123456+00";
const LATER = "2026-01-02 04:05:06.000001+00";
const EARLIER = "2026-01-02 03:04:05.123455+00";
const VERSION_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const VERSION_B = "11111111-2222-4333-8444-555555555555";
const config = (side, change = {}) => ({
  name: side.name,
  id: side === JOB ? ID_JOB : ID_APP,
  user: side.login,
  host: HOST,
  database: "made_up_db",
  caching: "disabled",
  ...change,
});
// The spike's configuration, which stores the migrations' role, is on the list too until the user deletes it.
const SPIKE = {
  name: "rosie-staging-hyperdrive",
  id: ID_SPIKE,
  user: OWNER,
  host: HOST,
  database: "made_up_db",
  caching: "disabled",
};
const CONFIGS = [SPIKE, config(JOB), config(APP)];
const NEVER_SHOWN = [HOST, OWNER, CALLER_URL, CALLER_TOKEN];

// Every command run.mjs, cf.sh and lib.sh start by name. PATH holds nothing else.
const COMMANDS = ["bash", "basename", "date", "dirname", "node", "sed", "tr"];

/** What the probe's Worker would answer, from runProbe against the stand-in clients. */
async function probeResult({ start = LATER, change } = {}) {
  const { open } = standinOpen({ start, ...(change === undefined ? {} : { change }) });
  return runProbe({ open });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => {
    server.close(resolve);
  });
  return String(port);
}

/**
 * A throwaway checkout: run.mjs and its modules, the real cf.sh, lib.sh and hyperdrive-list.mjs, a wrangler.jsonc that
 * cf.sh accepts, the stand-in for wrangler, and the recorders. `plan` is the stand-in's (standin-wrangler.mjs).
 */
function checkout(t, plan) {
  const dir = tempDir(t, "t1255-run");
  const root = path.join(dir, "checkout");
  const probeDir = path.join(root, "infra", "spikes", "hyperdrive-roles");
  for (const file of ["run.mjs", "probe.mjs", "worker.mjs"]) {
    write(path.join(probeDir, file), readFileSync(path.join(HERE, file)));
  }
  for (const file of ["cf.sh", "lib.sh", "hyperdrive-list.mjs"]) {
    write(path.join(root, "infra", "scripts", file), readFileSync(path.join(SCRIPTS, file)));
  }
  write(
    path.join(root, "wrangler.jsonc"),
    JSON.stringify({
      name: "rosie",
      account_id: ROSFIELD_ACCOUNT_ID,
      env: { staging: { name: "rosie-staging" } },
    }),
  );
  const state = path.join(dir, "state");
  write(
    path.join(state, "plan.json"),
    JSON.stringify({ configs: CONFIGS, versions: [VERSION_A, VERSION_A], ...plan }),
  );
  const spy = spies(dir, COMMANDS);
  spy.put(path.join(root, "node_modules", ".bin", "wrangler"), "wrangler", [
    process.execPath,
    path.join(HERE, "standin-wrangler.mjs"),
    state,
  ]);
  const home = path.join(dir, "home");
  const tmp = path.join(dir, "tmp");
  mkdirSync(home);
  mkdirSync(tmp);
  /** Runs the checkout's run.mjs with exactly this environment, plus `env`. */
  return async (args, env = {}) => {
    const result = spawnSync(process.execPath, [path.join(probeDir, "run.mjs"), ...args], {
      cwd: root,
      env: { PATH: spy.bin, HOME: home, TMPDIR: tmp, PROBE_PORT: await freePort(), ...env },
      encoding: "utf8",
      timeout: 120_000,
    });
    const devFile = path.join(state, "dev.json");
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      said: `${result.stdout}\n${result.stderr}`,
      children: spy.children(),
      leftInTmp: readdirSync(tmp),
      dev: existsSync(devFile) ? JSON.parse(readFileSync(devFile, "utf8")) : null,
    };
  };
}

/** The wrangler commands the run sent (through cf.sh, after its --config <file>), as their first two words, sorted. */
const wranglerCalls = (children) =>
  children
    .filter((child) => child.name === "wrangler")
    .map((child) => child.args.slice(2, 4).join(" "))
    .sort();

function assertNeverShown(result, texts = NEVER_SHOWN) {
  texts.forEach((text, index) => {
    assert.equal(
      result.said.includes(text),
      false,
      `run.mjs showed made-up text number ${String(index + 1)}`,
    );
  });
}

/** Refused before anything was started: only the list was read, no session, no temporary folder left. */
function assertNothingStarted(result) {
  assert.equal(result.status, 1, result.said);
  assert.deepEqual(wranglerCalls(result.children), ["hyperdrive list"]);
  assert.equal(result.dev, null);
  assert.deepEqual(result.leftInTmp, []);
  assertNeverShown(result);
}

test("passes, with the persistence proof, when every read came from a postmaster started after the run's", async (t) => {
  const run = checkout(t, { probe: await probeResult({ start: LATER }) });
  const result = await run([RUN_START], {
    STAGING_DATABASE_URL: CALLER_URL,
    CLOUDFLARE_API_TOKEN: CALLER_TOKEN,
  });
  assert.equal(result.status, 0, result.said);
  for (const line of [
    `the run's postmaster start, as given: ${RUN_START}`,
    `rosie-staging-hyperdrive-job: id ${ID_JOB}, caching disabled, stores rosie_worker_job: yes`,
    `rosie-staging-hyperdrive-app: id ${ID_APP}, caching disabled, stores rosie_worker_app: yes`,
    `staging: serves version ${VERSION_A} before the probe`,
    "remote: the probe's Worker answers on http://127.0.0.1:",
    `staging: still serves version ${VERSION_A}, the same as before the probe`,
    "roles: HYPERDRIVE_JOB (rosie-staging-hyperdrive-job): 50 reads outside a transaction on 5 backend(s) (pid 4000, 4001, 4002, 4003, 4004) and 5 inside one on 1 backend(s) (pid 5001): every one answered as rosie_worker_job with the table's expected answers (session_user and current_user rosie_worker_job; memberships by member: rosie_job (inherit true, set false, admin false) only;",
    "roles: HYPERDRIVE_APP (rosie-staging-hyperdrive-app): 50 reads outside a transaction on 5 backend(s) (pid 4020, 4021, 4022, 4023, 4024) and 5 inside one on 1 backend(s) (pid 5003): every one answered as rosie_worker_app",
    "crossed: HYPERDRIVE_JOB read where the Tool API side's answers are expected: refused (session_user, current_user, memberships, pg_has_role(current_user, 'rosie_app', 'USAGE'), pg_has_role(current_user, 'rosie_job', 'MEMBER'))",
    "crossed: HYPERDRIVE_APP read where the runtime side's answers are expected: refused (",
    `postmaster: HYPERDRIVE_JOB: started ${LATER} (56 reads); HYPERDRIVE_APP: started ${LATER} (56 reads)`,
    `persistence: proved: every read through both bindings came from a postmaster started after the run's (${RUN_START})`,
    "caching: rosie-staging-hyperdrive-job disabled, rosie-staging-hyperdrive-app disabled",
    "result: passed: every read through each configuration answered as its login",
  ]) {
    assert.ok(result.stdout.includes(line), `no line: ${line}\n${result.said}`);
  }
  // The printed result is JSON, with each backend pid seen.
  assert.match(result.stdout, /"backends": \[\s*4000,\s*4001,\s*4002,\s*4003,\s*4004\s*\]/);
  // A list, the serving version before and after, and one remote dev session: no deploy, no other command.
  assert.deepEqual(wranglerCalls(result.children), [
    "deployments status",
    "deployments status",
    "dev --env",
    "hyperdrive list",
  ]);
  const devArgs = result.dev.args;
  assert.ok(devArgs.includes("--remote"));
  assert.deepEqual(devArgs.slice(0, 3), ["dev", "--env", "staging"]);
  // The temporary config binds the two configurations by the list's ids, for staging's name and the Rosfield account,
  // and its folder holds nothing but it (no variables file) and the session's log.
  assert.equal(result.dev.config.account_id, ROSFIELD_ACCOUNT_ID);
  assert.deepEqual(result.dev.config.env, {
    staging: {
      name: "rosie-staging",
      hyperdrive: [
        { binding: "HYPERDRIVE_JOB", id: ID_JOB },
        { binding: "HYPERDRIVE_APP", id: ID_APP },
      ],
    },
  });
  assert.deepEqual(result.dev.beside, ["dev.log", "wrangler.jsonc"]);
  // Removed at the end.
  assert.deepEqual(result.leftInTmp, []);
  // The run's token: in the session's arguments by design, in no child's environment, and never printed. The caller's
  // database URL and Cloudflare token reach no child at all.
  const token = /^PROBE_TOKEN:([0-9a-f]{48})$/.exec(devArgs[devArgs.indexOf("--var") + 1] ?? "")?.[1];
  assert.ok(token, "the session was given no token");
  assert.deepEqual(
    result.children.filter((child) => child.env.includes(token)).map((child) => child.name),
    [],
  );
  assert.deepEqual(
    result.children
      .filter((child) => child.args.some((arg) => arg.includes(token)))
      .map((child) => child.name)
      .sort(),
    ["bash", "wrangler"],
  );
  assert.deepEqual(
    result.children
      .filter((child) => [CALLER_URL, CALLER_TOKEN].some((text) => child.env.includes(text)))
      .map((child) => child.name),
    [],
  );
  assertNeverShown(result, [...NEVER_SHOWN, token]);
});

test("reports NOT YET PROVED, never a pass, when a read came from the run's own postmaster", async (t) => {
  const run = checkout(t, { probe: await probeResult({ start: RUN_START }) });
  const result = await run([RUN_START]);
  assert.equal(result.status, 3, result.said);
  assert.ok(
    result.stdout.includes(`postmaster: HYPERDRIVE_JOB: started ${RUN_START} (56 reads)`),
    result.said,
  );
  assert.ok(
    result.stdout.includes("persistence: NOT YET PROVED: a read came from the postmaster that started at"),
  );
  assert.ok(result.stdout.includes("result: NOT YET PROVED (exit 3)"));
  assert.ok(result.stdout.includes("this is not a pass"));
  assert.doesNotMatch(result.said, /result: passed|persistence: proved/);
  assert.deepEqual(result.leftInTmp, []);
});

test("fails when a read came from a postmaster started before the run's", async (t) => {
  const run = checkout(t, { probe: await probeResult({ start: EARLIER }) });
  const result = await run([RUN_START]);
  assert.equal(result.status, 1, result.said);
  assert.ok(result.stdout.includes("persistence: FAILED (below)"), result.said);
  assert.ok(result.stdout.includes("result: FAILED: 1 problem(s):"));
  assert.ok(
    result.stdout.includes(
      `persistence: a read came from a postmaster started before the run's (${RUN_START}): the time given is not the run's, or a binding reaches another server`,
    ),
  );
  assert.deepEqual(result.leftInTmp, []);
});

test("a backend that answers as another login fails the run, and that login is never shown", async (t) => {
  const probe = await probeResult({
    change: ({ binding, read, row }) =>
      binding === "HYPERDRIVE_APP" && read === 23
        ? { ...row, session_user_name: OWNER, current_user_name: OWNER }
        : row,
  });
  // As if the session had not hidden the name itself: run.mjs hides it again.
  const wrong = probe.sides[1].answers.find((group) => group.failed_checks.length > 0);
  wrong.session_user = OWNER;
  wrong.current_user = OWNER;
  const run = checkout(t, { probe, probeStatus: 500 });
  const result = await run([RUN_START]);
  assert.equal(result.status, 1, result.said);
  assert.ok(
    result.stdout.includes(
      "HYPERDRIVE_APP: 1 read(s) on 1 backend(s) (pid 4022) answered as another login: (not shown), failing the table's checks: session_user, current_user",
    ),
    result.said,
  );
  assert.ok(result.stdout.includes("roles: HYPERDRIVE_APP (rosie-staging-hyperdrive-app): FAILED"));
  assert.doesNotMatch(result.said, /result: passed/);
  assertNeverShown(result);
  assert.deepEqual(result.leftInTmp, []);
});

test("fails when fewer than 50 reads outside a transaction, or 5 inside one, came back", async (t) => {
  const probe = await probeResult();
  probe.sides[0].outside_transaction.answered = 49;
  probe.sides[0].answers[0].reads = 54;
  probe.sides[1].inside_transaction.answered = 4;
  probe.sides[1].answers[0].reads = 54;
  const run = checkout(t, { probe });
  const result = await run([RUN_START]);
  assert.equal(result.status, 1, result.said);
  assert.ok(
    result.stdout.includes("HYPERDRIVE_JOB: 49 reads outside a transaction answered, where 50 are needed"),
    result.said,
  );
  assert.ok(
    result.stdout.includes("HYPERDRIVE_APP: 4 reads inside a transaction answered, where 5 are needed"),
  );
  assert.deepEqual(result.leftInTmp, []);
});

test("refused before anything starts: rosie-staging-hyperdrive-job is missing", async (t) => {
  const run = checkout(t, { configs: [SPIKE, config(APP)] });
  const result = await run([RUN_START]);
  assertNothingStarted(result);
  assert.match(result.stderr, /refused: rosie-staging-hyperdrive-job is not in the Hyperdrive list/);
});

test("refused before anything starts: rosie-staging-hyperdrive-app is missing", async (t) => {
  const run = checkout(t, { configs: [SPIKE, config(JOB)] });
  const result = await run([RUN_START]);
  assertNothingStarted(result);
  assert.match(result.stderr, /refused: rosie-staging-hyperdrive-app is not in the Hyperdrive list/);
});

test("refused before anything starts: a configuration's caching is enabled", async (t) => {
  const run = checkout(t, {
    configs: [SPIKE, config(JOB, { caching: "max_age: 60, stale_while_revalidate: 15" }), config(APP)],
  });
  const result = await run([RUN_START]);
  assertNothingStarted(result);
  assert.match(
    result.stderr,
    /refused: rosie-staging-hyperdrive-job \(id 0123456789abcdef0123456789abcdef\) has caching max_age: 60, stale_while_revalidate: 15, not disabled/,
  );
});

test("refused before anything starts: a configuration stores another user, which is never shown", async (t) => {
  const run = checkout(t, { configs: [SPIKE, config(JOB), config(APP, { user: OWNER })] });
  const result = await run([RUN_START]);
  assertNothingStarted(result);
  assert.match(
    result.stderr,
    /refused: rosie-staging-hyperdrive-app \(id fedcba9876543210fedcba9876543210\) stores another user \(not shown\), not its login rosie_worker_app/,
  );
});

test("refused before anything starts: the list fails, or names a configuration twice", async (t) => {
  const failing = await checkout(t, { list: "fail" })([RUN_START]);
  assertNothingStarted(failing);
  assert.match(failing.stderr, /refused: cf\.sh hyperdrive list failed \(exit 1/);
  const twice = await checkout(t, { configs: [...CONFIGS, config(JOB)] })([RUN_START]);
  assertNothingStarted(twice);
  assert.match(
    twice.stderr,
    /refused: more than one Hyperdrive configuration is named rosie-staging-hyperdrive-job/,
  );
});

test("misuse: no start, a start without its time zone, or a second argument lists nothing", async (t) => {
  for (const args of [[], ["2026-01-02 03:04:05.123456"], [RUN_START, "more"], ["postmaster started"]]) {
    const result = await checkout(t, {})(args);
    assert.equal(result.status, 2, result.said);
    assert.match(result.stderr, /usage: node infra\/spikes\/hyperdrive-roles\/run\.mjs/);
    assert.deepEqual(wranglerCalls(result.children), []);
    assert.deepEqual(result.leftInTmp, []);
  }
});

test("stops before anything starts when the serving version cannot be read", async (t) => {
  const run = checkout(t, { versions: [""] });
  const result = await run([RUN_START]);
  assert.equal(result.status, 1, result.said);
  assert.match(result.stderr, /could not be read before the probe/);
  assert.deepEqual(wranglerCalls(result.children), ["deployments status", "hyperdrive list"]);
  assert.equal(result.dev, null);
  assert.deepEqual(result.leftInTmp, []);
});

test("fails when another version serves staging after the probe", async (t) => {
  const run = checkout(t, { probe: await probeResult(), versions: [VERSION_A, VERSION_B] });
  const result = await run([RUN_START]);
  assert.equal(result.status, 1, result.said);
  assert.ok(
    result.stdout.includes(
      `staging: the serving version CHANGED during the probe: ${VERSION_A} before, ${VERSION_B} after`,
    ),
    result.said,
  );
  assert.deepEqual(result.leftInTmp, []);
});

test("removes the temporary config when the session ends before it answers, and shows its log scrubbed", async (t) => {
  const run = checkout(t, { dev: "exit" });
  const result = await run([RUN_START]);
  assert.equal(result.status, 1, result.said);
  assert.match(result.stderr, /refused: wrangler dev ended before the probe's Worker answered/);
  // The stand-in printed the token and an origin's host to its log: both are taken out.
  assert.match(result.stderr, /could not start: token \[redacted\], origin \[redacted\]/);
  const token = /^PROBE_TOKEN:([0-9a-f]{48})$/.exec(
    result.dev.args[result.dev.args.indexOf("--var") + 1],
  )?.[1];
  assert.ok(token);
  assertNeverShown(result, [...NEVER_SHOWN, token]);
  assert.deepEqual(result.leftInTmp, []);
});

test("an error in the result that names an origin's host or another user is printed without them", async (t) => {
  const probe = await probeResult({
    change: ({ binding, row }) => {
      if (binding !== "HYPERDRIVE_APP") return row;
      throw Object.assign(new Error(`could not reach ${HOST} for ${OWNER}`), { code: "XX000" });
    },
  });
  const run = checkout(t, { probe, probeStatus: 500 });
  const result = await run([RUN_START]);
  assert.equal(result.status, 1, result.said);
  assert.ok(
    result.stdout.includes(
      "HYPERDRIVE_APP: 50 read(s) outside a transaction failed: XX000: could not reach [redacted] for [redacted]",
    ),
    result.said,
  );
  assert.ok(result.stdout.includes("persistence: NOT KNOWN (below)"));
  assert.ok(result.stdout.includes("means Neon did not keep the password (DL-733)"));
  assertNeverShown(result);
  assert.deepEqual(result.leftInTmp, []);
});
