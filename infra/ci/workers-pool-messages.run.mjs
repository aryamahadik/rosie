// T-1207: the child process of workers-pool-messages.test.mjs. Usage: node workers-pool-messages.run.mjs <out.json>
// <test file>...
//
// Runs the given Workers test files with vitest.config.ts as it is, in one Vitest process with one worker, so each
// file's runner starts after the one before it has made the server transform its modules. Every message the Workers
// pool sends a runner is measured where the pool calls send() on its socket (miniflare's WebSocket), and what was
// measured is written to <out.json>:
//   - fsModuleCache: each project's resolved fsModuleCache;
//   - messages, and mostModules: the most modules' code any one message carried (a reply to the runner's fetch holds
//     one module; a fetchWarmModules reply maps ids to modules);
//   - largest: the largest message's bytes, the runner's file and what it carried;
//   - graphs: per runner's file, its modules, their code's bytes and its largest message;
//   - errors: errors outside the tests (a crashed runner, a file that failed to load). The tests' own results are
//     npm test's business, not this script's.
// A separate file, not `node --eval`: the pool starts worker threads that would inherit --input-type=module.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { structuredSerializableParse } from "@cloudflare/vitest-plugin";
import { WebSocket } from "miniflare";
import { createVitest } from "vitest/node";

const root = fileURLToPath(new URL("../../", import.meta.url));
const [out, ...files] = process.argv.slice(2);
if (out === undefined || files.length === 0) {
  console.error("usage: node workers-pool-messages.run.mjs <out.json> <test file>...");
  process.exit(2);
}

const runnerOf = new WeakMap();
const seen = new Map();
const graphs = {};
const largest = { bytes: 0, file: null, carried: null };
let messages = 0;
let mostModules = 0;

function measure(socket, data) {
  messages++;
  const bytes = Buffer.byteLength(data);
  let message;
  try {
    message = structuredSerializableParse(data);
  } catch {
    message = undefined;
  }
  // The run message names the runner's test file.
  if (message?.__vitest_worker_request__ === true && Array.isArray(message.context?.files)) {
    runnerOf.set(socket, message.context.files.map((f) => path.relative(root, f.filepath)).join(", "));
  }
  const file = runnerOf.get(socket) ?? "(before the runner's run message)";
  // The modules whose code this message carries, by id (an id and its url can share one entry of a warm reply).
  const reply =
    message?.t === "s" && message.r !== null && typeof message.r === "object" ? message.r : undefined;
  const modules = new Map();
  if (reply !== undefined && typeof reply.code === "string") {
    modules.set(String(reply.id), Buffer.byteLength(reply.code));
  } else if (reply !== undefined) {
    for (const entry of Object.values(reply)) {
      if (entry !== null && typeof entry === "object" && typeof entry.code === "string") {
        modules.set(String(entry.id), Buffer.byteLength(entry.code));
      }
    }
  }
  mostModules = Math.max(mostModules, modules.size);
  graphs[file] ??= { modules: 0, codeBytes: 0, largestMessage: 0 };
  const graph = graphs[file];
  if (!seen.has(file)) seen.set(file, new Set());
  const ids = seen.get(file);
  for (const [id, size] of modules) {
    if (ids.has(id)) continue;
    ids.add(id);
    graph.modules++;
    graph.codeBytes += size;
  }
  graph.largestMessage = Math.max(graph.largestMessage, bytes);
  if (bytes > largest.bytes) {
    const [only] = modules.keys();
    largest.bytes = bytes;
    largest.file = file;
    largest.carried = modules.size === 1 ? path.relative(root, only) : `${modules.size} modules`;
  }
}

const send = WebSocket.prototype.send;
WebSocket.prototype.send = function (data) {
  if (typeof data === "string") measure(this, data);
  return send.call(this, data);
};

const vitest = await createVitest("test", {
  config: path.join(root, "vitest.config.ts"),
  watch: false,
  maxWorkers: 1,
});
const fsModuleCache = Object.fromEntries(vitest.projects.map((p) => [p.name, p.config.fsModuleCache]));
const result = await vitest.start(files);
const errors = [
  ...result.unhandledErrors.map((e) => String(e?.message ?? e)),
  ...result.testModules.flatMap((m) => m.errors().map((e) => `${m.moduleId}: ${String(e?.message ?? e)}`)),
];
await vitest.close();
writeFileSync(out, JSON.stringify({ fsModuleCache, messages, mostModules, largest, graphs, errors }));
process.exit(0);
