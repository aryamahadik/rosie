// The one unhandled error the Workers test rig's runs drop (T-1253; the lead's ruling DL-758, option (a)), and the only
// place that drops one: vitest.config.ts's test.onUnhandledError is closedSocketFilter's, and its Workers projects carry
// droppedReport, which prints the count.
//
// Why. postgres.js 3.4.9's Workers build ends a client by closing its socket (node_modules/postgres/cf/polyfills.js):
// close() removes the socket's listeners, then the read still pending on that socket rejects ("This socket has been
// closed."), and error() emits it with no listener left, so the async read() rejects with nothing to catch it. Every
// client a Workers test ends leaves one such rejection, and Vitest fails the run on it. It is the library's own, after
// its own close: a query that fails still rejects its own promise, which our code and tests handle, so dropping this one
// rejection hides no failure of ours. T-1254's quiet-close socket (option (b)) removes this file if it leaves none.
//
// What is dropped: an unhandled error whose four fields all match CLOSED_SOCKET (its name, its message exactly, the type
// Vitest gives it, and the file of the first frame of its stack). Any other error, one field off included, is kept, so
// it still fails the run. Each drop is counted, and the run prints the count as one line that holds no value of any
// error (droppedLine).

/** postgres.js's closed-socket rejection, as Vitest hands it to onUnhandledError. */
export const CLOSED_SOCKET = Object.freeze({
  name: "TypeError",
  message: "This socket has been closed.",
  type: "Unhandled Rejection",
  file: "node_modules/postgres/cf/polyfills.js",
});

// A frame line of a V8 stack: "at <function> (<location>)" or "at <location>".
const FRAME = /^\s*at\s+(\S.*)$/;
// A location's line and column, at its end.
const LINE_AND_COLUMN = /:\d+(?::\d+)?$/;

/**
 * The file of the first frame of a V8 stack (the first line that starts with "at", after the error's own lines): its
 * location without the line, column, query or hash, with "/" between folders and no file:// in front. Undefined when
 * the stack is not text or has no frame.
 */
export function firstFrameFile(stack) {
  if (typeof stack !== "string") return undefined;
  for (const line of stack.split("\n")) {
    const frame = FRAME.exec(line);
    if (frame === null) continue;
    let location = frame[1].trim();
    if (location.endsWith(")") && location.includes(" (")) {
      location = location.slice(location.lastIndexOf(" (") + 2, -1);
    }
    location = location.replace(LINE_AND_COLUMN, "").replace(/[?#].*$/, "");
    if (location.startsWith("file://")) location = location.slice("file://".length);
    return location.replaceAll("\\", "/");
  }
  return undefined;
}

/** Whether a file is postgres.js's Workers polyfills: the path ends with node_modules/postgres/cf/polyfills.js. */
function isPolyfills(file) {
  return file === CLOSED_SOCKET.file || (file?.endsWith(`/${CLOSED_SOCKET.file}`) ?? false);
}

/**
 * Whether an unhandled error, as Vitest hands it to onUnhandledError (with its type set), is postgres.js's
 * closed-socket rejection: all four of CLOSED_SOCKET's fields match. Pure.
 */
export function isClosedSocketRejection(error) {
  if (error === null || typeof error !== "object") return false;
  return (
    error.name === CLOSED_SOCKET.name &&
    error.message === CLOSED_SOCKET.message &&
    error.type === CLOSED_SOCKET.type &&
    isPolyfills(firstFrameFile(error.stack))
  );
}

/** The one line a run prints: how many it dropped, and no value of any error. */
export function droppedLine(count) {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("droppedLine takes a count");
  return (
    `vitest.config.ts dropped ${String(count)} unhandled rejection(s), each postgres.js's own read on a socket ` +
    `it had closed (infra/test-rig/closed-socket.mjs; T-1253, DL-758)`
  );
}

/**
 * vitest.config.ts's filter: onUnhandledError returns false (Vitest drops the error) for postgres.js's closed-socket
 * rejection alone, and counts it; for any other error it returns undefined, so Vitest keeps it and the run fails.
 * dropped() is the count so far.
 */
export function closedSocketFilter() {
  let dropped = 0;
  return {
    onUnhandledError: (error) => {
      if (!isClosedSocketRejection(error)) return undefined;
      dropped += 1;
      return false;
    },
    dropped: () => dropped,
  };
}

/**
 * A Vite plugin for the Workers projects: when the run closes, Vitest's logger prints droppedLine with the filter's
 * count, once for the run however many of its projects carry the plugin.
 */
export function droppedReport(filter) {
  const runs = new WeakSet();
  return {
    name: "rosie:closed-socket-count",
    configureVitest({ vitest }) {
      if (runs.has(vitest)) return;
      runs.add(vitest);
      vitest.onClose(() => {
        vitest.logger.log(droppedLine(filter.dropped()));
      });
    },
  };
}
