// Tests for the one unhandled error the Workers test rig's runs drop (T-1253; the lead's ruling DL-758, option (a)):
// infra/test-rig/closed-socket.mjs, whose filter is vitest.config.ts's test.onUnhandledError. It drops postgres.js's
// closed-socket rejection only when all four fields match: the name TypeError, the message "This socket has been
// closed." exactly, the type "Unhandled Rejection", and the first stack frame in node_modules/postgres/cf/polyfills.js.
// Each field alone mismatched is kept: here through the pure function and the filter, then through Vitest itself, where
// a kept error is one of the run's unhandled errors (which fail it) and the run prints its count as one line at close,
// holding no value of any error. No database and no Workers runtime: the errors are planted as Vitest hands them over.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLOSED_SOCKET,
  closedSocketFilter,
  droppedLine,
  droppedReport,
  firstFrameFile,
  isClosedSocketRejection,
} from "../test-rig/closed-socket.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const POLYFILLS = path.join(REPO, "node_modules/postgres/cf/polyfills.js");

/** A stack whose frames are at these locations, after the error's own line. */
const stackAt = (...locations) =>
  ["TypeError: This socket has been closed.", ...locations.map((at) => `    at ${at}`)].join("\n");

// postgres.js's rejection as Vitest hands it to onUnhandledError: the error's fields, and the type Vitest set.
const STACK = stackAt(`async read (${POLYFILLS}:201:39)`);
const rejection = (fields = {}) => ({
  name: "TypeError",
  message: "This socket has been closed.",
  type: "Unhandled Rejection",
  stack: STACK,
  ...fields,
});

const inRepo = (file) => path.join(REPO, file);

// Each of the four fields alone mismatched, with what is off; every case is kept.
const MISMATCHES = [
  ["name", "Error", { name: "Error" }],
  ["name", "RangeError", { name: "RangeError" }],
  ["name", "typeerror", { name: "typeerror" }],
  ["name", "none", { name: undefined }],
  ["message", "no full stop", { message: "This socket has been closed" }],
  ["message", "a space after it", { message: "This socket has been closed. " }],
  ["message", "lower case", { message: "this socket has been closed." }],
  ["message", "another socket error", { message: "Network connection lost." }],
  ["message", "none", { message: undefined }],
  ["type", "Unhandled Error", { type: "Unhandled Error" }],
  ["type", "Unhandled rejection", { type: "Unhandled rejection" }],
  ["type", "none", { type: undefined }],
  [
    "first frame",
    "a frame of ours first, polyfills.js second",
    { stack: stackAt(`run (${inRepo("runtime/src/x.ts")}:3:9)`, `read (${POLYFILLS}:201:39)`) },
  ],
  [
    "first frame",
    "postgres.js's Node build",
    { stack: stackAt(`read (${inRepo("node_modules/postgres/src/connection.js")}:9:1)`) },
  ],
  [
    "first frame",
    "another package's cf/polyfills.js",
    { stack: stackAt(`read (${inRepo("node_modules/not-postgres/cf/polyfills.js")}:9:1)`) },
  ],
  ["first frame", "polyfills.js.map", { stack: stackAt(`read (${POLYFILLS}.map:9:1)`) }],
  [
    "first frame",
    "polyfills.mjs",
    { stack: stackAt(`read (${inRepo("node_modules/postgres/cf/polyfills.mjs")}:9:1)`) },
  ],
  ["first frame", "no frame", { stack: "TypeError: This socket has been closed." }],
  ["first frame", "no stack", { stack: undefined }],
];

describe("closed-socket.mjs: the four fields", () => {
  it("names the four as the ruling does", () => {
    assert.deepEqual(
      { ...CLOSED_SOCKET },
      {
        name: "TypeError",
        message: "This socket has been closed.",
        type: "Unhandled Rejection",
        file: "node_modules/postgres/cf/polyfills.js",
      },
    );
    assert.ok(Object.isFrozen(CLOSED_SOCKET));
  });

  it("postgres.js's closed-socket rejection, all four matching, is dropped and counted", () => {
    const filter = closedSocketFilter();
    assert.equal(isClosedSocketRejection(rejection()), true);
    assert.equal(filter.onUnhandledError(rejection()), false, "false: Vitest drops it");
    assert.equal(filter.onUnhandledError(rejection({ stack: stackAt(`${POLYFILLS}:201:39`) })), false);
    assert.equal(filter.dropped(), 2);
  });

  for (const [field, off, change] of MISMATCHES) {
    it(`kept, so it still fails the run, with only the ${field} off (${off})`, () => {
      const error = rejection(change);
      const filter = closedSocketFilter();
      assert.equal(isClosedSocketRejection(error), false);
      assert.notEqual(filter.onUnhandledError(error), false, "anything but false: Vitest keeps it");
      assert.equal(filter.dropped(), 0, "a kept error is not counted");
    });
  }

  it("keeps what is not an error object at all", () => {
    const filter = closedSocketFilter();
    for (const thing of [null, undefined, "This socket has been closed.", 7, CLOSED_SOCKET.message]) {
      assert.equal(isClosedSocketRejection(thing), false);
      assert.equal(filter.onUnhandledError(thing), undefined);
    }
    assert.equal(filter.dropped(), 0);
  });
});

describe("closed-socket.mjs: the first frame of a stack", () => {
  it("reads the first frame's file in each V8 form, without its line, column, query or hash", () => {
    for (const [stack, file] of [
      [stackAt(`async read (${POLYFILLS}:201:39)`), POLYFILLS],
      [stackAt(`read (${POLYFILLS}:201:39)`, "run (/elsewhere/x.js:1:1)"), POLYFILLS],
      [stackAt(`${POLYFILLS}:201:39`), POLYFILLS],
      [stackAt(`new Socket (file://${POLYFILLS}:12:5)`), POLYFILLS],
      [stackAt(`read (${POLYFILLS}?mf_vitest_no_cjs_esm_shim:201:39)`), POLYFILLS],
      [stackAt("read (node_modules/postgres/cf/polyfills.js:201)"), "node_modules/postgres/cf/polyfills.js"],
      [stackAt("async Promise.all (index 0)"), "index 0"],
      ["TypeError: x\n    at\n    at read (/a/b.js:1:1)", "/a/b.js"],
    ]) {
      assert.equal(firstFrameFile(stack), file, stack);
    }
  });

  it("finds no frame in a stack without one, or in what is not text", () => {
    for (const stack of ["TypeError: This socket has been closed.", "", undefined, null, 42, ["at x"]]) {
      assert.equal(firstFrameFile(stack), undefined);
    }
  });
});

describe("closed-socket.mjs: the count, one line with no value", () => {
  it("droppedLine is one line with the count and none of the error's fields", () => {
    for (const count of [0, 1, 10, 2_048]) {
      const line = droppedLine(count);
      assert.doesNotMatch(line, /[\r\n]/);
      assert.match(line, new RegExp(`\\bdropped ${String(count)} unhandled rejection\\(s\\)`));
      // The only number but the card's and the ruling's (T-1253, DL-758) is the count.
      assert.deepEqual(
        line.match(/\d+/g)?.filter((digits) => !["1253", "758"].includes(digits)),
        [String(count)],
      );
      for (const value of [CLOSED_SOCKET.message, POLYFILLS, "postgres://", "TypeError"]) {
        assert.ok(!line.includes(value), `the line holds ${value}`);
      }
    }
    for (const notCount of [-1, 1.5, Number.NaN, "3", undefined, rejection()]) {
      assert.throws(() => droppedLine(notCount), /takes a count/);
    }
  });

  it("droppedReport prints the line once per run at its close, however many projects carry it", async () => {
    const filter = closedSocketFilter();
    const plugin = droppedReport(filter);
    const fakeRun = () => {
      const closers = [];
      const lines = [];
      return {
        vitest: { onClose: (fn) => closers.push(fn), logger: { log: (line) => lines.push(line) } },
        close: async () => {
          for (const fn of closers) await fn();
        },
        lines,
      };
    };
    const run = fakeRun();
    plugin.configureVitest({ vitest: run.vitest });
    plugin.configureVitest({ vitest: run.vitest });
    filter.onUnhandledError(rejection());
    filter.onUnhandledError(rejection({ type: "Unhandled Error" }));
    filter.onUnhandledError(rejection());
    assert.deepEqual(run.lines, [], "nothing before the close");
    await run.close();
    assert.deepEqual(run.lines, [droppedLine(2)]);

    const next = fakeRun();
    plugin.configureVitest({ vitest: next.vitest });
    await next.close();
    assert.deepEqual(next.lines, [droppedLine(2)], "another run gets its own line");
  });
});

describe("vitest.config.ts: the filter as Vitest runs it", () => {
  it("each mismatch is one of the run's unhandled errors (so the run fails), the match is not, and the close prints its count once", () => {
    const configPath = path.join(REPO, "vitest.config.ts");
    // Each planted error carries a label (a field Vitest keeps) and is handed over the way the pool hands one: Vitest's
    // state.catchError(error, type), which sets error.type and then asks the config's onUnhandledError.
    const planted = [
      { label: "match", ...rejection(), type: undefined, as: CLOSED_SOCKET.type },
      ...MISMATCHES.map(([field, off, change]) => {
        const { type, ...rest } = rejection(change);
        return { label: `${field}: ${off}`, ...rest, as: type };
      }),
    ];
    const script = `
      import { createVitest } from "vitest/node";
      const vitest = await createVitest("test", { config: ${JSON.stringify(configPath)}, watch: false });
      const sameFilter = vitest.config.onUnhandledError === vitest.state.onUnhandledError;
      for (const { as, ...error } of ${JSON.stringify(planted)}) vitest.state.catchError(error, as);
      const kept = vitest.state.getUnhandledErrors().map((error) => error.label);
      const ignored = vitest.config.dangerouslyIgnoreUnhandledErrors;
      await vitest.close();
      process.stdout.write(JSON.stringify({ sameFilter, kept, ignored }) + "\\n", () => process.exit(0));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(child.status, 0, child.stderr || String(child.error));
    const lines = child.stdout.trim().split("\n");
    const result = JSON.parse(lines.at(-1));
    assert.equal(result.sameFilter, true, "Vitest's state asks the config's onUnhandledError");
    assert.equal(result.ignored, false, "unhandled errors fail the run");
    assert.deepEqual(
      result.kept,
      planted.filter((error) => error.label !== "match").map((error) => error.label),
      "every mismatch is kept, and only the match is dropped",
    );
    assert.deepEqual(
      lines.filter((line) => line.includes("unhandled rejection(s)")),
      [droppedLine(1)],
      "the close prints one count line",
    );
  });
});
