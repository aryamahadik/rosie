// T-1207 (DL-420, from T-560's round 3): the Workers pool sends a runner each module in a message of its own, so a large
// Workers test graph never closes workerd's runner socket.
//
// The cause. Vitest 5 hands a new runner, in one reply (fetchWarmModules), every module of its test file's graph that
// the run has already transformed and stored on disk (fsModuleCache, on by default). @cloudflare/vitest-plugin's pool
// reads those files and puts all of their code into that one WebSocket message. workerd closes the runner's socket on a
// message larger than SOCKET_LIMIT (close code 1009, "Message is too large"), and Vitest reports "Worker exited
// unexpectedly" for the file. Measured on 5d69f31 with the seeded four-file run (pages.worker, root.worker, test-phone,
// hop9): hop9's reply was 33,125,602 bytes (835 modules, 98.7% of the limit); with test-phone's old import of
// gateway/pages/test-support put back, test-phone's was 33,802,390 bytes and its runner crashed.
//
// The fix. vitest.config.ts's workers and e2e-workers projects set fsModuleCache: false: no module is stored on disk,
// so the reply carries no code, and each module reaches the runner in the reply to its own fetch. The largest message is
// then the largest single module, the Tool API's generated validators: 13,213,756 bytes (39.4% of the limit), however
// many modules a graph holds.
//
// This guard:
//   1. checks that workerd still takes a SOCKET_LIMIT-byte message on a Worker's accepted socket (the runner's shape:
//      a WebSocketPair, accept(), a 101 response) at wrangler.jsonc's compatibility date, and closes it on one byte
//      more, so the stated limit stays a measured fact;
//   2. collects test-phone's and root.worker's Workers tests (the largest graphs) through the workers project in one
//      Vitest process with one worker, so the second file's runner meets the modules the first one's made the server
//      transform, with every message the pool sends a runner measured. It fails when either workerd project does not
//      resolve fsModuleCache: false, when a message carries more than one module's code, or when a message is larger
//      than BUDGET (75% of the limit), naming the module: a module that grows that far needs splitting (or the pool a
//      larger socket) before it reaches the limit.
// miniflare comes with @cloudflare/vitest-plugin and wrangler (one copy in node_modules); the pool's socket is its
// WebSocket, measured where the pool calls send().
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** workerd's largest WebSocket message on the runner's socket, in bytes: 32 MiB (test 1 checks it). */
const SOCKET_LIMIT = 33_554_432;
/** The largest message the pool may send a runner: 24 MiB, 75% of SOCKET_LIMIT. */
const BUDGET = 25_165_824;
/** The Workers test files with the largest graphs (DL-420): the Tool API's validators, the root and its test doubles. */
const GRAPHS = ["runtime/src/wiring/test-phone.worker.test.ts", "runtime/src/wiring/root.worker.test.ts"];
const WORKERD_PROJECTS = ["workers", "e2e-workers"];
/** The Tool API's generated validators: git-ignored, written by `npm run build:validators` (npm test's pretest). */
const VALIDATORS = "actions/src/tool-api/generated/validators.js";

const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

// ---- 1. the socket's limit ---------------------------------------------------------------------------------------

// wrangler.jsonc's top-level compatibility date, which env.staging (the pool's environment) inherits.
const compatibilityDate = /"compatibility_date":\s*"([^"]+)"/.exec(
  readFileSync(path.join(root, "wrangler.jsonc"), "utf8"),
)?.[1];

// A Worker that accepts a WebSocket as the pool's runner does and answers each message with its length.
const ECHO_WORKER = `
export default {
  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    server.addEventListener("message", (event) => server.send(String(event.data.length)));
    server.addEventListener("error", () => {});
    return new Response(null, { status: 101, webSocket: client });
  },
};`;

/** Sends one message of `size` ASCII bytes on a new socket: "took <n>" or "closed <code> <reason>". */
async function sendOne(mf, size) {
  const response = await mf.dispatchFetch("http://localhost/", { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;
  assert.ok(socket, "the echo Worker answers with a WebSocket");
  socket.accept();
  const answer = new Promise((resolve) => {
    const timer = setTimeout(() => resolve("no answer in 60 s"), 60_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      resolve(`took ${String(event.data)}`);
    });
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve(`closed ${event.code} ${event.reason}`);
    });
  });
  socket.send("x".repeat(size));
  const result = await answer;
  try {
    socket.close();
  } catch {
    // already closed by workerd
  }
  return result;
}

test(
  `workerd's runner socket takes a ${SOCKET_LIMIT}-byte message and closes on one byte more`,
  { timeout: 180_000 },
  async () => {
    assert.ok(compatibilityDate, "wrangler.jsonc has a compatibility_date");
    const mf = new Miniflare({
      ...convertV4MiniflareOptions({
        workers: [
          {
            name: "socket-limit",
            modules: true,
            script: ECHO_WORKER,
            compatibilityDate,
            compatibilityFlags: ["nodejs_compat"],
          },
        ],
      }),
      // workerd also logs the refused message as an uncaught exception: that line is left out, as the close it causes
      // is what this test reads; any other log line still shows.
      handleStructuredLogs: ({ level, message }) => {
        if (!message.includes("Message is too large"))
          process.stderr.write(`[workerd ${level}] ${message}\n`);
      },
    });
    try {
      await mf.ready;
      assert.equal(await sendOne(mf, SOCKET_LIMIT), `took ${SOCKET_LIMIT}`);
      assert.equal(await sendOne(mf, SOCKET_LIMIT + 1), "closed 1009 Message is too large");
    } finally {
      await mf.dispose();
    }
  },
);

// ---- 2. the messages the pool sends test-phone's and root.worker's runners --------------------------------------------

// workers-pool-messages.run.mjs in a child Node: the files run in one Vitest process with one worker and every message
// the pool sends a runner measured. Returns what it measured.
function runMeasured(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rosie-pool-messages-"));
  const out = path.join(dir, "measured.json");
  try {
    const child = spawnSync(
      process.execPath,
      [path.join(root, "infra/ci/workers-pool-messages.run.mjs"), out, ...files],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 540_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    assert.equal(
      child.status,
      0,
      `the measured run failed:\n${(child.stderr || String(child.error)).slice(-4000)}`,
    );
    return JSON.parse(readFileSync(out, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "test-phone's and root.worker's graphs reach their runners one module per message, each within the budget",
  { timeout: 600_000 },
  (t) => {
    assert.ok(
      existsSync(path.join(root, VALIDATORS)),
      `${VALIDATORS} is missing: run npm run build:validators first`,
    );
    const measured = runMeasured(GRAPHS);

    // What was measured, before any check, so a failing run shows its numbers too.
    for (const [file, graph] of Object.entries(measured.graphs)) {
      t.diagnostic(
        `${file}: ${graph.modules} modules, ${mib(graph.codeBytes)} of code, largest message ${graph.largestMessage} bytes`,
      );
    }
    const { bytes, file, carried } = measured.largest;
    t.diagnostic(
      `largest message: ${bytes} bytes (${carried}, to ${file}): ${((100 * bytes) / BUDGET).toFixed(1)}% of the ` +
        `${BUDGET}-byte budget, ${((100 * bytes) / SOCKET_LIMIT).toFixed(1)}% of the ${SOCKET_LIMIT}-byte socket limit`,
    );

    for (const name of GRAPHS) {
      const graph = measured.graphs[name];
      assert.ok(
        graph !== undefined && graph.modules > 0,
        `${name}'s runner was measured getting its modules (${measured.messages} messages measured, to: ` +
          `${Object.keys(measured.graphs).join(" | ") || "no runner"})`,
      );
    }
    assert.ok(
      measured.mostModules <= 1,
      `a message carried ${measured.mostModules} modules' code: the pool sent a runner its modules together`,
    );
    assert.ok(
      bytes <= BUDGET,
      `the pool sent ${file}'s runner a ${bytes}-byte message (${carried}), over the ${BUDGET}-byte budget ` +
        `(${mib(BUDGET)}, 75% of workerd's ${SOCKET_LIMIT}-byte socket limit): split that module before it reaches the limit`,
    );
    for (const name of WORKERD_PROJECTS) {
      assert.equal(measured.fsModuleCache[name], false, `the ${name} project resolves fsModuleCache: false`);
    }
    assert.deepEqual(measured.errors, [], "no runner crashed and every file loaded");
  },
);
