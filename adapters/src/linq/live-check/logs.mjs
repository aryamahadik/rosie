// Staging's logs for the Linq live check (T-417, run live in T-1031; the card's lead note item 3). ES module, so strict
// mode is on.
//
// What staging logs: one JSON line per K-08 span (msg "span", the span's fields, environment and version; ADR-009,
// runtime/src/trace/context.ts logSink). The gateway's receive span says whether a webhook's signature held and what
// K-06 event it carried; its trace id is on every span of that event.
//
// How they are read today, with no new secret: wrangler tail, run through infra/scripts/cf.sh, which is what
// `npm run cf -- tail --env staging --format json` runs. cf.sh (the release engineer's) runs this checkout's wrangler with
// the Rosfield sign-in kept in ~/.config/rosfield, and checks the account and the Worker (rosie-staging) first. tail
// changes nothing: it streams the Worker's events as they happen, from the moment it connects, so the check opens it before
// its send. wrangler prints each event as one JSON value over several lines; TailJsonStream splits them.
//
// What is kept: of each event, its request's path (a webhook's is /webhooks/linq under the base path) and, of its log
// lines, the K-08 spans alone. Nothing else of the output is kept, printed or logged: no other request's headers, no other
// log line. The tail's standard error is drained unread, and its exit code is the only thing said about it.

import { spawn } from "node:child_process";
import path from "node:path";

/** The tail's arguments to cf.sh: staging alone, every event as JSON. */
export const TAIL_ARGS = Object.freeze(["tail", "--env", "staging", "--format", "json"]);

/** How the check says where it reads staging's logs. */
export const TAIL_DESCRIPTION = `npm run cf -- ${TAIL_ARGS.join(" ")} (wrangler tail on rosie-staging, the pinned Rosfield account)`;

/** The most text one event may hold before it is dropped unread, and the most spans kept waiting to be read. */
const MAX_EVENT_CHARS = 4 * 1024 * 1024;
const MAX_WAITING = 10_000;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Splits a stream of JSON objects written one after another (wrangler tail's json format: each event printed over
 * several lines) into the objects, however the text is cut into chunks. Text between objects is skipped; an object that
 * does not parse, or is longer than MAX_EVENT_CHARS, is dropped.
 */
export class TailJsonStream {
  #parts = [];
  #size = 0;
  #depth = 0;
  #inString = false;
  #escaped = false;
  #tooLong = false;

  /** The objects that end in this chunk, in order. */
  push(chunk) {
    const text = String(chunk);
    const values = [];
    let start = this.#depth > 0 ? 0 : -1;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (this.#depth === 0) {
        if (c === "{") {
          this.#depth = 1;
          this.#parts = [];
          this.#size = 0;
          this.#tooLong = false;
          start = i;
        }
        continue;
      }
      if (this.#inString) {
        if (this.#escaped) this.#escaped = false;
        else if (c === "\\") this.#escaped = true;
        else if (c === '"') this.#inString = false;
        continue;
      }
      if (c === '"') this.#inString = true;
      else if (c === "{" || c === "[") this.#depth += 1;
      else if (c === "}" || c === "]") {
        this.#depth -= 1;
        if (this.#depth === 0) {
          this.#keep(text.slice(start, i + 1));
          start = -1;
          const value = this.#finish();
          if (value !== undefined) values.push(value);
        }
      }
    }
    if (this.#depth > 0 && start >= 0) this.#keep(text.slice(start));
    return values;
  }

  #keep(piece) {
    if (this.#tooLong || this.#size + piece.length > MAX_EVENT_CHARS) {
      this.#tooLong = true;
      this.#parts = [];
      return;
    }
    this.#parts.push(piece);
    this.#size += piece.length;
  }

  #finish() {
    const text = this.#tooLong ? null : this.#parts.join("");
    this.#parts = [];
    this.#size = 0;
    this.#inString = false;
    this.#escaped = false;
    if (text === null) return undefined;
    try {
      const value = JSON.parse(text);
      return isObject(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
}

/** A log line's K-08 span: a JSON object (or JSON text of one) whose msg is "span"; else null. */
function spanOf(item) {
  let value = item;
  if (typeof item === "string") {
    if (!item.startsWith("{")) return null;
    try {
      value = JSON.parse(item);
    } catch {
      return null;
    }
  }
  return isObject(value) && value.msg === "span" ? value : null;
}

/** The path of a URL, or null for anything that is not one. */
function pathOf(url) {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/**
 * The K-08 spans one tail event logged, each with its request's path (null for an event that is no request, such as a
 * Durable Object's call), in the order logged. Every other log line is left out.
 */
export function recordsOfTailEvent(event) {
  if (!isObject(event)) return [];
  const request = isObject(event.event) && isObject(event.event.request) ? event.event.request : {};
  const where = pathOf(request.url);
  const records = [];
  for (const log of Array.isArray(event.logs) ? event.logs : []) {
    const message = isObject(log) && Array.isArray(log.message) ? log.message : [];
    for (const item of message) {
      const span = spanOf(item);
      if (span !== null) records.push({ span, path: where });
    }
  }
  return records;
}

/** A copy of `env` without the `dropped` names (and without any name whose value is not text), for the tail's process. */
export function tailEnv(env, dropped) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (!dropped.includes(name) && typeof value === "string") out[name] = value;
  }
  return out;
}

/** The spans read so far and not yet taken, then the tail's end. One reader at a time. */
class RecordQueue {
  #waiting = [];
  #ended = null;
  #reader = null;

  put(record) {
    if (this.#ended !== null) return;
    if (this.#reader !== null) {
      const reader = this.#reader;
      this.#reader = null;
      reader({ kind: "record", record });
    } else if (this.#waiting.length < MAX_WAITING) {
      this.#waiting.push(record);
    }
  }

  end(code) {
    if (this.#ended !== null) return;
    this.#ended = { kind: "ended", code: typeof code === "number" ? code : null };
    if (this.#reader !== null) {
      const reader = this.#reader;
      this.#reader = null;
      reader(this.#ended);
    }
  }

  /** The next span, or {kind: "timeout"} after timeoutMs, or {kind: "ended"} once the tail ended and every span is taken. */
  read(timeoutMs) {
    const next = this.#waiting.shift();
    if (next !== undefined) return Promise.resolve({ kind: "record", record: next });
    if (this.#ended !== null) return Promise.resolve(this.#ended);
    return new Promise((resolve) => {
      const done = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(
        () => {
          if (this.#reader === done) this.#reader = null;
          resolve({ kind: "timeout" });
        },
        Math.max(0, timeoutMs),
      );
      this.#reader = done;
    });
  }
}

/**
 * Opens staging's logs: starts `bash <root>/infra/scripts/cf.sh tail --env staging --format json` in `root` with `env`
 * (which must hold no key: the check hands in its own environment without the names it reads) and reads its standard
 * output into spans. `spawnProcess` is node:child_process spawn unless a test hands in its own. Gives read(timeoutMs) and
 * close(), which stops the tail (SIGINT, as Ctrl-C stops it; SIGKILL if it still runs 5 s later).
 */
export function openStagingTail({ root, env, spawnProcess = spawn }) {
  const queue = new RecordQueue();
  const stream = new TailJsonStream();
  let child;
  try {
    child = spawnProcess("bash", [path.join(root, "infra", "scripts", "cf.sh"), ...TAIL_ARGS], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    queue.end(null);
    return { read: (timeoutMs) => queue.read(timeoutMs), close: () => Promise.resolve() };
  }
  let closed = false;
  child.on("error", () => {
    closed = true;
    queue.end(null);
  });
  child.on("close", (code) => {
    closed = true;
    queue.end(code);
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    for (const event of stream.push(chunk)) for (const record of recordsOfTailEvent(event)) queue.put(record);
  });
  // Drained unread: wrangler's own lines are never printed.
  child.stderr?.on("data", () => undefined);
  return {
    read: (timeoutMs) => queue.read(timeoutMs),
    close: () =>
      new Promise((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        const hard = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.on("close", () => {
          clearTimeout(hard);
          resolve();
        });
        child.kill("SIGINT");
      }),
  };
}
