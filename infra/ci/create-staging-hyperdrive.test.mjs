// Tests for infra/scripts/create-staging-hyperdrive.sh and .mjs (npm run hyperdrive:staging:create; ADR-014 piece 2;
// T-1252; T-1239's round 2 security review, notes b, c and d), run by `node --test "infra/ci/*.test.mjs"` with the local
// rosie-pg (npm run db:up), or DATABASE_URL's server in CI, whose login must be a superuser. Nothing here reaches
// Cloudflare, staging or the network, and no real key, token or password is read.
//
// The script runs in a throwaway checkout: copies of it, its .mjs, worker-logins.sql, hyperdrive-list.mjs, db-url.mjs,
// lib.sh and the real cf.sh, this repository's wrangler.jsonc, and node_modules/postgres linked to this repository's.
// Around it, stand-ins that never leave this machine:
//  - wrangler (node_modules/.bin/wrangler, behind the real cf.sh): `hyperdrive list` prints, in wrangler 4.158.0's
//    table, the configurations the stand-in API holds; `auth token --json` prints a made-up sign-in's oauth token, or
//    the other credential or text a test asks for;
//  - Cloudflare's API: an HTTP server on a loopback port. The stand-in node loads a module first that points fetch's
//    https://api.cloudflare.com at it and refuses every other address;
//  - the database: the local server behind a TLS proxy on a loopback port, with a certificate made for the run (for
//    127.0.0.1), which the script trusts only through NODE_EXTRA_CA_CERTS. So it connects as it would to staging, the
//    certificate and its name checked, and the proxy counts its connections. It also records every byte each client
//    sends it after TLS, read as PostgreSQL's messages (T-1369's recording database client: what the server got, each
//    call's Parse and Bind among it), and each message the server answers (T-1371: its errors' fields). It hands the
//    server each client message whole, after a case's hook has seen it: a hook may hold one while it changes something
//    on the server, or send another in its place (T-1371). For the older server, a stand-in that speaks just enough
//    PostgreSQL, behind the same certificate, to report server_version_num 150004;
//  - every command on PATH (bash, node, sed, tr, dirname, basename) and wrangler: a recorder that writes down its
//    arguments and environment and then runs the real one, so no child starts unseen.
// The logins: as worker-logins.test.mjs explains, never their own names here. In the copies, rosie_worker_job,
// rosie_worker_app, rosie_job and rosie_app become names of this run's own (t1252_<6 hex><case>_...), and staging's
// migrations' role is a login made here (CREATEROLE, not a superuser). Every role this run makes is dropped after it.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { after, before, describe, it } from "node:test";

import postgres from "postgres";

import { REPO, SCRIPTS, copyScript, tempDir, write } from "./script-harness.mjs";

const SCRIPT = "create-staging-hyperdrive.sh";
const PROGRAM = "create-staging-hyperdrive.mjs";
const JOB = "rosie-staging-hyperdrive-job";
const APP = "rosie-staging-hyperdrive-app";
const LOCAL_URL = "postgres://rosie:rosie@127.0.0.1:54329/rosie";
const RUN = `t1252_${randomBytes(3).toString("hex")}`;
const ACCOUNT = /ROSFIELD_ACCOUNT_ID="([0-9a-f]{32})"/.exec(
  readFileSync(path.join(SCRIPTS, "cf.sh"), "utf8"),
)?.[1];
// The made-up sign-in's token: no token of anything.
const TOKEN = `t1252-made-up-oauth-token-${randomBytes(12).toString("hex")}`;
const ID_THERE = "00112233445566778899aabbccddeeff";
// The names a caller's shell might hold, which wrangler would take as credentials before the sign-in.
const DECOYS = {
  CLOUDFLARE_API_TOKEN: "t1252-made-up-api-token-decoy",
  CLOUDFLARE_API_KEY: "t1252-made-up-api-key-decoy",
  CLOUDFLARE_EMAIL: "made-up-decoy@example.test",
  CF_API_TOKEN: "t1252-made-up-old-api-token-decoy",
};
// The file's four names, each with the part of a case's own name it is swapped for (worker-logins.test.mjs).
const SWAPS = [
  ["rosie_worker_job", "worker_job"],
  ["rosie_worker_app", "worker_app"],
  ["rosie_job", "job"],
  ["rosie_app", "app"],
];
// Every command the script, lib.sh and cf.sh start by name. PATH holds nothing else.
const COMMANDS = ["bash", "sed", "tr", "dirname", "basename"];
// How much of a text answer from the API the script shows, read from its source (T-1271).
const ERROR_TEXT_CUT = Number(
  /^const ERROR_TEXT_CUT = (\d+);$/m.exec(readFileSync(path.join(SCRIPTS, PROGRAM), "utf8"))?.[1],
);
// The temporary function that sets each password, the words its handler raises, and the call that carries the password
// as its second bound value (T-1371), read from the script's source.
const FUNCTION = /^const PASSWORD_FUNCTION = "([a-z_]+)";$/m.exec(
  readFileSync(path.join(SCRIPTS, PROGRAM), "utf8"),
)?.[1];
const FUNCTION_FAULT = /^const FUNCTION_FAULT =\s+"([^"]+)";$/m.exec(
  readFileSync(path.join(SCRIPTS, PROGRAM), "utf8"),
)?.[1];
const CALL = `select pg_temp.${String(FUNCTION)}($1, $2)`;

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const shellQuoted = (text) => `'${text.replaceAll("'", `'\\''`)}'`;

function serverUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.CI)
    throw new Error("DATABASE_URL is not set, and with CI set the local database is never used");
  return LOCAL_URL;
}

function isProgram(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The real program of that name: the first on this run's PATH. */
function program(command) {
  const file = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((folder) => path.join(folder, command))
    .find(isProgram);
  assert.ok(file, `${command} is not on PATH`);
  return file;
}

// ---------------------------------------------------------------------------------------------------------------------
// A certificate for 127.0.0.1, made for the run with node's crypto alone (no package, no openssl): self-signed, CA true,
// so the one file is both what the stand-in servers present and what the script is told to trust.

function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  const size = [];
  for (let n = body.length; n > 0; n >>= 8) size.unshift(n & 0xff);
  const length = body.length < 0x80 ? Buffer.from([body.length]) : Buffer.from([0x80 | size.length, ...size]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}
const sequence = (...parts) => der(0x30, ...parts);
function objectId(text) {
  const [first, second, ...rest] = text.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let value = n >> 7; value > 0; value >>= 7) chunk.unshift(0x80 | (value & 0x7f));
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}
const utcTime = (date) =>
  der(
    0x17,
    Buffer.from(
      date.toISOString().replace(/^\d\d(\d\d)-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d).*$/, "$1$2$3$4$5$6Z"),
    ),
  );
const TRUE = der(0x01, Buffer.from([0xff]));

function certificate() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const algorithm = sequence(objectId("1.2.840.10045.4.3.2"));
  const name = sequence(der(0x31, sequence(objectId("2.5.4.3"), der(0x0c, Buffer.from("t1252 stand-in")))));
  const serial = randomBytes(8);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const extensions = der(
    0xa3,
    sequence(
      sequence(objectId("2.5.29.19"), TRUE, der(0x04, sequence(TRUE))),
      sequence(
        objectId("2.5.29.17"),
        der(0x04, sequence(der(0x82, Buffer.from("localhost")), der(0x87, Buffer.from([127, 0, 0, 1])))),
      ),
    ),
  );
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    algorithm,
    name,
    sequence(utcTime(new Date(Date.now() - 3_600_000)), utcTime(new Date(Date.now() + 86_400_000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signed = sequence(tbs, algorithm, der(0x03, Buffer.from([0]), sign("sha256", tbs, privateKey)));
  const lines = signed.toString("base64").match(/.{1,64}/g) ?? [];
  const cert = ["-----BEGIN CERTIFICATE-----", ...lines, "-----END CERTIFICATE-----", ""].join("\n");
  return { cert, key: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

const SSL_REQUEST = 80877103;
const isSslRequest = (data) =>
  data.length === 8 && data.readInt32BE(0) === 8 && data.readInt32BE(4) === SSL_REQUEST;

/** Accepts PostgreSQL's SSLRequest, then hands the TLS socket on; a client that does not ask for TLS gets nothing. */
function tlsServer(context, onSecure) {
  const counts = { connections: 0, plain: 0 };
  const server = net.createServer((raw) => {
    counts.connections += 1;
    raw.on("error", () => undefined);
    raw.once("data", (first) => {
      if (!isSslRequest(first)) {
        counts.plain += 1;
        raw.destroy();
        return;
      }
      raw.write("S");
      const secure = new tls.TLSSocket(raw, { isServer: true, secureContext: context });
      secure.on("error", () => raw.destroy());
      onSecure(secure);
    });
  });
  return { server, counts };
}

// One clock for the recording proxy and the stand-in API, so the order of what each received can be compared.
const clock = { n: 0 };
const tick = () => (clock.n += 1);

/**
 * What one client sent the proxy after TLS (T-1369's recording database client): every byte, the user its startup
 * message names, and each message after it (a type byte and a length), with the clock's reading and the time when it
 * was whole. Each whole message goes on through `forward`, in order, after a case's hook (shared.hook, T-1371) has seen
 * it: the hook may hold it (it goes on when the hook is done) or give a message to send in its place. `replies` holds
 * what the server answered, read the same way (replyReader).
 */
function recording(secure, forward) {
  const session = { at: tick(), user: "", bytes: [], messages: [], replies: [], hookErrors: [] };
  let buffer = Buffer.alloc(0);
  let started = false;
  let chain = Promise.resolve();
  const pass = (raw, sent) => {
    chain = chain.then(async () => {
      let out = raw;
      if (sent !== undefined && shared.hook !== undefined) {
        try {
          out = (await shared.hook(session, sent)) ?? raw;
        } catch (error) {
          session.hookErrors.push(error);
        }
      }
      forward(out);
    });
  };
  session.drained = () => chain;
  secure.on("data", (chunk) => {
    session.bytes.push(Buffer.from(chunk));
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (!started) {
        if (buffer.length < 8 || buffer.length < buffer.readInt32BE(0)) return;
        const size = buffer.readInt32BE(0);
        const fields = buffer.toString("utf8", 8, size).split("\0");
        for (let at = 0; at + 1 < fields.length; at += 2) {
          if (fields[at] === "user") session.user = fields[at + 1];
        }
        pass(Buffer.from(buffer.subarray(0, size)));
        buffer = buffer.subarray(size);
        started = true;
        continue;
      }
      if (buffer.length < 5 || buffer.length < 1 + buffer.readInt32BE(1)) return;
      const size = 1 + buffer.readInt32BE(1);
      const sent = {
        at: tick(),
        time: Date.now(),
        type: String.fromCharCode(buffer[0]),
        body: Buffer.from(buffer.subarray(5, size)),
      };
      session.messages.push(sent);
      pass(Buffer.from(buffer.subarray(0, size)), sent);
      buffer = buffer.subarray(size);
    }
  });
  return session;
}

/** Reads what the server sends a recorded session into its `replies`, each message with the clock and the time. */
function replyReader(session) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 5 && buffer.length >= 1 + buffer.readInt32BE(1)) {
      const size = 1 + buffer.readInt32BE(1);
      session.replies.push({
        at: tick(),
        time: Date.now(),
        type: String.fromCharCode(buffer[0]),
        body: Buffer.from(buffer.subarray(5, size)),
      });
      buffer = buffer.subarray(size);
    }
  };
}

/** A simple Query's or an extended Parse's text, or null for any other message. */
function textOf(sent) {
  if (sent.type === "Q") return sent.body.toString("utf8", 0, sent.body.length - 1);
  if (sent.type === "P") {
    const nameEnd = sent.body.indexOf(0);
    return sent.body.toString("utf8", nameEnd + 1, sent.body.indexOf(0, nameEnd + 1));
  }
  return null;
}

/** The text of each query a recorded session sent, in order: a simple Query's, or an extended Parse's. */
function queriesOf(session) {
  return session.messages.flatMap((sent) => {
    const text = textOf(sent);
    return text === null ? [] : [{ at: sent.at, text }];
  });
}

/** Every byte a recorded session sent. */
const bytesOf = (session) => Buffer.concat(session.bytes);

/** How many times a text stands in a buffer (byte for byte). */
const countIn = (buffer, text) => buffer.toString("latin1").split(text).length - 1;

/** A Bind message's portal, statement and parameter values (each a Buffer, or null). */
function bindOf(body) {
  let at = 0;
  const cstringAt = () => {
    const end = body.indexOf(0, at);
    const text = body.toString("utf8", at, end);
    at = end + 1;
    return text;
  };
  const portal = cstringAt();
  const statement = cstringAt();
  at += 2 + 2 * body.readInt16BE(at);
  const count = body.readInt16BE(at);
  at += 2;
  const values = [];
  for (let n = 0; n < count; n += 1) {
    const size = body.readInt32BE(at);
    at += 4;
    if (size === -1) {
      values.push(null);
      continue;
    }
    values.push(Buffer.from(body.subarray(at, at + size)));
    at += size;
  }
  return { portal, statement, values };
}

/**
 * Each call of the password function the recorded sessions sent (T-1371): its Parse, the Bind that follows it, and the
 * login and the password, its two bound values.
 */
function callsOf(sessions) {
  return sessions.flatMap((session) => {
    const calls = [];
    let parse = null;
    for (const sent of session.messages) {
      if (sent.type === "P") parse = textOf(sent) === CALL ? sent : null;
      else if (sent.type === "Q") parse = null;
      else if (sent.type === "B" && parse !== null) {
        const { values } = bindOf(sent.body);
        calls.push({
          at: sent.at,
          time: sent.time,
          session,
          parse,
          bind: sent,
          values,
          login: values[0]?.toString("utf8"),
          password: values[1]?.toString("utf8"),
        });
        parse = null;
      }
    }
    return calls;
  });
}

/** The fields of each ErrorResponse the server sent a recorded session, by their one-letter codes, and when. */
function errorsOf(session) {
  return session.replies
    .filter((reply) => reply.type === "E")
    .map((reply) => {
      const fields = {};
      let at = 0;
      while (at < reply.body.length && reply.body[at] !== 0) {
        const end = reply.body.indexOf(0, at + 1);
        fields[String.fromCharCode(reply.body[at])] = reply.body.toString("utf8", at + 1, end);
        at = end + 1;
      }
      return { at: reply.at, time: reply.time, fields };
    });
}

/** The local server behind TLS: what the script connects to as staging's database. */
function tlsProxy(context, upstream, sessions) {
  return tlsServer(context, (secure) => {
    const out = net.connect(upstream.port, upstream.host);
    const session = recording(secure, (raw) => {
      if (!out.destroyed) out.write(raw);
    });
    sessions.push(session);
    out.on("data", replyReader(session));
    out.pipe(secure);
    const close = () => {
      secure.destroy();
      out.destroy();
    };
    out.on("error", close);
    // What the client sent before it closed reaches the server first.
    secure.on("close", () => {
      void session.drained().then(close);
    });
    out.on("close", close);
  });
}

const int32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const int16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
};
const cstring = (text) => Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0])]);
const message = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
};

/**
 * A stand-in PostgreSQL 15 behind TLS: it takes any login, answers the first simple query with one row (each column the
 * query names "as <name>": server_version_num 150004, the others made up), records every query, and answers anything
 * more with an error.
 */
function oldServer(context) {
  const queries = [];
  const made = tlsServer(context, (secure) => {
    let buffer = Buffer.alloc(0);
    let started = false;
    secure.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
          buffer = buffer.subarray(buffer.readInt32BE(0));
          started = true;
          secure.write(
            Buffer.concat([
              message("R", int32(0)),
              message("S", cstring("server_version"), cstring("15.4")),
              message("K", int32(4242), int32(7)),
              message("Z", Buffer.from("I")),
            ]),
          );
          continue;
        }
        if (buffer.length < 5 || buffer.length < 1 + buffer.readInt32BE(1)) return;
        const type = String.fromCharCode(buffer[0]);
        const body = buffer.subarray(5, 1 + buffer.readInt32BE(1));
        buffer = buffer.subarray(1 + buffer.readInt32BE(1));
        if (type === "X") {
          secure.end();
          return;
        }
        const text = type === "Q" ? body.toString("utf8", 0, body.length - 1) : `(protocol message ${type})`;
        queries.push(text);
        if (type === "Q" && queries.length === 1) {
          const columns = Array.from(text.matchAll(/\bas (\w+)/g), ([, column]) => column);
          const value = (column) => (column === "version_num" ? "150004" : column === "pid" ? "4242" : "100");
          secure.write(
            Buffer.concat([
              message(
                "T",
                int16(columns.length),
                ...columns.map((column) =>
                  Buffer.concat([
                    cstring(column),
                    int32(0),
                    int16(0),
                    int32(25),
                    int16(-1),
                    int32(-1),
                    int16(0),
                  ]),
                ),
              ),
              message(
                "D",
                int16(columns.length),
                ...columns.map((column) =>
                  Buffer.concat([int32(value(column).length), Buffer.from(value(column))]),
                ),
              ),
              message("C", cstring("SELECT 1")),
              message("Z", Buffer.from("I")),
            ]),
          );
        } else {
          secure.write(
            Buffer.concat([
              message(
                "E",
                Buffer.from("S"),
                cstring("ERROR"),
                Buffer.from("C"),
                cstring("0A000"),
                Buffer.from("M"),
                cstring("the stand-in answers one query"),
                Buffer.from([0]),
              ),
              message("Z", Buffer.from("I")),
            ]),
          );
        }
      }
    });
  });
  return { ...made, queries };
}

const listen = (server) =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
const closeServer = (server) =>
  new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });

// ---------------------------------------------------------------------------------------------------------------------
// The stand-ins in the throwaway checkout.

// Loaded first into every node the script and cf.sh start: fetch reaches only the stand-in API.
const REDIRECT = String.raw`"use strict";
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (url.origin === "https://api.cloudflare.com" && process.env.FAKE_API_ORIGIN) {
    return realFetch(new URL(url.pathname + url.search, process.env.FAKE_API_ORIGIN), init);
  }
  return Promise.reject(new Error("the test allows no fetch to " + url.origin));
};
`;

// wrangler 4.158.0 as cf.sh runs it: --config <file> <words>. Its state: $FAKE_STATE_DIR/plan.json (list: "fail";
// token: "oauth" (default), "api_token", "api_key", "text", "no_token", "short", "fail" or "fail_json"), token.txt (the sign-in's
// token) and configs.json (the configurations, which the stand-in API adds to).
const STANDIN_WRANGLER = String.raw`"use strict";
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.FAKE_STATE_DIR;
const all = process.argv.slice(2);
const words = all.filter((arg, at) => arg !== "--config" && all[at - 1] !== "--config").join(" ");
// Each call's words, in the order the calls ran (no value is ever among them).
fs.appendFileSync(path.join(dir, "calls.log"), words + "\n");
const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
const configsFile = path.join(dir, "configs.json");
const configs = fs.existsSync(configsFile) ? JSON.parse(fs.readFileSync(configsFile, "utf8")) : [];
if (words === "hyperdrive list") {
  if (plan.list === "fail") {
    process.stderr.write("✘ [ERROR] A request to the Cloudflare API failed.\n");
    process.exit(1);
  }
  process.stdout.write(" ⛅️ wrangler 4.158.0\n📋 Listing Hyperdrive configs\n");
  if (configs.length > 0) {
    const head = ["id", "name", "user", "host", "port", "scheme", "database", "caching", "mtls", "origin_connection_limit"];
    const line = (cells) => "│ " + cells.join(" │ ") + " │";
    const rows = configs.map((c) => [c.id, c.name, c.user, c.host, String(c.port), "PostgreSQL", c.database, c.caching, "{}", ""]);
    process.stdout.write(["┌────┬────┐", line(head), "├────┼────┤", ...rows.map(line), "└────┴────┘", ""].join("\n"));
  }
  process.exit(0);
}
if (words === "auth token --json") {
  const token = fs.readFileSync(path.join(dir, "token.txt"), "utf8");
  const mode = plan.token ?? "oauth";
  if (mode === "fail" || mode === "fail_json") {
    // The worst a failing wrangler could do: the token on standard output, alone or inside its JSON, and in its error.
    process.stdout.write(mode === "fail" ? token + "\n" : JSON.stringify({ type: "oauth", token }, null, 4) + "\n");
    process.stderr.write("✘ [ERROR] Not logged in. Please run wrangler login to authenticate (" + token + ").\n");
    process.exit(1);
  }
  if (mode === "text") {
    process.stdout.write(token + "\n");
    process.exit(0);
  }
  const answers = {
    oauth: { type: "oauth", token },
    api_token: { type: "api_token", token },
    api_key: { type: "api_key", key: token, email: "made-up@example.test" },
    no_token: { type: "oauth" },
    short: { type: "oauth", token: "abc" },
  };
  process.stdout.write(JSON.stringify(answers[mode], null, 4) + "\n");
  process.exit(0);
}
process.stderr.write("stand-in wrangler: no answer for: " + words + "\n");
process.exit(64);
`;

/** A recorder: writes down its environment and arguments, then becomes `command` with the same arguments. */
function recorder(spy, name, command) {
  const record = `${shellQuoted(path.join(spy, name))}.$$`;
  return [
    "#!/bin/sh",
    `/usr/bin/env >>${record}.env`,
    `printf '%s\\n' \${1+"$@"} >>${record}.argv`,
    `exec ${command.map(shellQuoted).join(" ")} \${1+"$@"}`,
    "",
  ].join("\n");
}

/** One case's names: its two logins, the stand-ins for rosie_job and rosie_app, and its maker. */
function namesFor(caseName) {
  const prefix = `${RUN}${caseName}`;
  return {
    ...Object.fromEntries(SWAPS.map(([, part]) => [part, `${prefix}_${part}`])),
    maker: `${prefix}_maker`,
  };
}

/** A file's text with the four names swapped for the case's own; fails if one is left. */
function swapped(text, names) {
  let out = text;
  for (const [from, part] of SWAPS) {
    assert.match(out, new RegExp(`\\b${from}\\b`), `the copy no longer names ${from}`);
    out = out.replace(new RegExp(`\\b${from}\\b`, "g"), names[part]);
  }
  assert.doesNotMatch(out, /\brosie_(worker_)?(job|app)\b/, "the swap left one of the file's own names");
  return out;
}

let admin;
let shared;

/**
 * The case's database side: the two stand-in roles, and the maker (CREATEROLE, ADMIN OPTION on both). `databaseName`:
 * a database of the case's own (ownDatabase) for the maker's URL, in place of the server URL's (T-1371).
 */
async function database(names, { setPrivilege = true, settings = {}, databaseName } = {}) {
  for (const part of ["job", "app"]) {
    await admin.unsafe(
      `create role ${quote(names[part])} nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
    );
  }
  const password = `t1252-made-up-${randomBytes(12).toString("hex")}`;
  await admin.unsafe(`create role ${quote(names.maker)} login createrole password '${password}'`);
  await admin.unsafe(
    `grant ${quote(names.job)}, ${quote(names.app)} to ${quote(names.maker)} with admin option`,
  );
  if (setPrivilege) {
    await admin.unsafe(
      `grant set on parameter log_statement, log_min_error_statement to ${quote(names.maker)}`,
    );
  }
  for (const [setting, value] of Object.entries(settings)) {
    await admin.unsafe(`alter role ${quote(names.maker)} set ${setting} = '${value}'`);
  }
  const database = databaseName ?? new URL(serverUrl()).pathname.slice(1);
  const url = `postgres://${names.maker}:${password}@127.0.0.1:${String(shared.proxyPort)}/${database}?sslmode=require`;
  return { url, password, database };
}

/**
 * The stand-in API of one case: each create answered as `answers` says, in order ("ok" when it runs out). T-1271 adds
 * "long:password", "long:token" and "long:host": a text answer longer than the script's cut, with that value across it.
 */
async function api(rig, answers = []) {
  const posts = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const record = {
        at: tick(),
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        headers: request.rawHeaders.join("\n"),
        text,
      };
      posts.push(record);
      const reply = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (
        request.method !== "POST" ||
        request.url !== `/client/v4/accounts/${String(ACCOUNT)}/hyperdrive/configs`
      ) {
        reply(404, { success: false, errors: [{ code: 7003, message: "No route for that URI" }] });
        return;
      }
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        reply(401, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
        return;
      }
      const body = JSON.parse(text);
      const answer = answers[posts.length - 1] ?? "ok";
      if (answer === "fail") {
        const o = body.origin;
        reply(500, {
          success: false,
          errors: [
            {
              code: 2008,
              message: `could not reach ${o.host}:${String(o.port)} as ${o.user} with password ${o.password} (Bearer ${TOKEN})`,
            },
          ],
        });
        return;
      }
      if (answer.startsWith("long:")) {
        // Not JSON, and longer than the cut: the value's first half (rounded up) before the cut, the rest after it.
        const value = { password: body.origin.password, token: TOKEN, host: body.origin.host }[
          answer.slice(5)
        ];
        const kept = Math.ceil(value.length / 2);
        response.writeHead(502, { "content-type": "text/plain" });
        response.end(`${"x".repeat(ERROR_TEXT_CUT - kept)}${value}${"y".repeat(500)}`);
        return;
      }
      const id = randomBytes(16).toString("hex");
      const configs = rig.configs();
      configs.push({
        id,
        name: body.name,
        user: body.origin.user,
        host: body.origin.host,
        port: body.origin.port,
        database: body.origin.database,
        caching: body.caching?.disabled === true ? "disabled" : "enabled",
      });
      writeFileSync(rig.configsFile, JSON.stringify(configs));
      if (answer === "hang-up") {
        request.socket.destroy();
        return;
      }
      // The answer holds the origin without its password, which Cloudflare never returns.
      const origin = Object.fromEntries(Object.entries(body.origin).filter(([key]) => key !== "password"));
      reply(200, {
        success: true,
        errors: [],
        messages: [],
        result: { id, name: body.name, origin, caching: body.caching },
      });
    });
  });
  const port = await listen(server);
  rig.after(() => closeServer(server));
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    posts,
    /** The bodies of the creates the API received. */
    creates: () => posts.filter((post) => post.method === "POST").map((post) => JSON.parse(post.text)),
  };
}

/**
 * A throwaway checkout for one case (see the top of this file). configs: the configurations "Cloudflare" holds at the
 * start; plan: the stand-in wrangler's plan; devVars: a .dev.vars text.
 */
function checkout(t, caseName, { configs = [], plan = {}, devVars } = {}) {
  const dir = tempDir(t, "create-hyperdrive");
  const root = path.join(dir, "rosie");
  const names = namesFor(caseName);
  for (const file of [
    SCRIPT,
    PROGRAM,
    "worker-logins.sql",
    "hyperdrive-list.mjs",
    "db-url.mjs",
    "lib.sh",
    "cf.sh",
  ]) {
    copyScript(file, root);
  }
  for (const file of [PROGRAM, "worker-logins.sql"]) {
    const target = path.join(root, "infra", "scripts", file);
    writeFileSync(target, swapped(readFileSync(target, "utf8"), names));
  }
  copyFileSync(path.join(REPO, "wrangler.jsonc"), path.join(root, "wrangler.jsonc"));
  mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  symlinkSync(
    realpathSync(path.join(REPO, "node_modules", "postgres")),
    path.join(root, "node_modules", "postgres"),
  );
  if (devVars !== undefined) write(path.join(root, ".dev.vars"), devVars);
  const at = (...parts) => path.join(dir, ...parts);
  for (const folder of ["bin", "spy", "state", "home", "tmp", "fake"])
    mkdirSync(at(folder), { recursive: true });
  write(at("state", "plan.json"), JSON.stringify(plan));
  write(at("state", "token.txt"), TOKEN);
  write(at("state", "configs.json"), JSON.stringify(configs));
  write(at("fake", "redirect.cjs"), REDIRECT);
  write(at("fake", "wrangler.cjs"), STANDIN_WRANGLER);
  write(
    at("bin", "node"),
    recorder(at("spy"), "node", [process.execPath, "--require", at("fake", "redirect.cjs")]),
    0o755,
  );
  for (const command of COMMANDS)
    write(at("bin", command), recorder(at("spy"), command, [program(command)]), 0o755);
  write(
    path.join(root, "node_modules", ".bin", "wrangler"),
    recorder(at("spy"), "wrangler", [process.execPath, at("fake", "wrangler.cjs")]),
    0o755,
  );
  const configsFile = at("state", "configs.json");
  return {
    dir,
    root,
    names,
    spy: at("spy"),
    state: at("state"),
    configsFile,
    configs: () => JSON.parse(readFileSync(configsFile, "utf8")),
    after: (fn) => t.after(fn),
    /** Runs the script: `bash` holds options for bash itself; `env` is all of its environment beyond the basics. */
    run: (stand, { env = {}, bash = [], args = [] } = {}) =>
      new Promise((resolve, reject) => {
        const before = shared.proxy.connections;
        const sessionsBefore = shared.sessions.length;
        const child = spawn(
          program("bash"),
          [...bash, path.join(root, "infra", "scripts", SCRIPT), ...args],
          {
            cwd: root,
            env: {
              PATH: at("bin"),
              HOME: at("home"),
              TMPDIR: at("tmp"),
              FAKE_STATE_DIR: at("state"),
              FAKE_API_ORIGIN: stand.origin,
              NODE_EXTRA_CA_CERTS: shared.caFile,
              ...env,
            },
          },
        );
        const out = [];
        const err = [];
        child.stdout.on("data", (chunk) => out.push(chunk));
        child.stderr.on("data", (chunk) => err.push(chunk));
        const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
        child.on("error", reject);
        child.on("close", (status) => {
          clearTimeout(timer);
          const stdout = Buffer.concat(out).toString("utf8");
          const stderr = Buffer.concat(err).toString("utf8");
          resolve({
            status,
            stdout,
            stderr,
            output: `${stdout}${stderr}`,
            connections: shared.proxy.connections - before,
            // What each connection through the proxy sent, in the order they opened (recording above).
            sessions: shared.sessions.slice(sessionsBefore),
          });
        });
      }),
  };
}

/** What each recorded process was given: its name, its arguments (one per line) and its environment. */
function childrenOf(rig) {
  return readdirSync(rig.spy)
    .filter((file) => file.endsWith(".env"))
    .map((file) => {
      const record = file.slice(0, -".env".length);
      return {
        name: record.split(".")[0],
        argv: readFileSync(path.join(rig.spy, `${record}.argv`), "utf8"),
        env: readFileSync(path.join(rig.spy, file), "utf8"),
      };
    });
}

/** The node process that is the script itself: it alone is meant to hold STAGING_DATABASE_URL, by that name. */
const isScript = (child) => child.name === "node" && child.argv.split("\n")[0].endsWith(`/${PROGRAM}`);

/** The names of an environment's variables whose value holds one of the texts. */
function holders(env, texts) {
  const names = new Set();
  let name = "(no variable)";
  for (const line of env.split("\n")) {
    name = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1] ?? name;
    if (texts.some((text) => line.includes(text))) names.add(name);
  }
  return [...names].sort();
}

/** The variable names of an environment. */
const namesIn = (env) =>
  env
    .split("\n")
    .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1])
    .filter((name) => name !== undefined);

/**
 * The wrangler calls, in the order they ran, as "<words>" without cf.sh's --config: the stand-in's own log, checked
 * against the recorders' records of wrangler (which come in no order).
 */
function wranglerCalls(rig) {
  const logFile = path.join(rig.state, "calls.log");
  const logged = existsSync(logFile)
    ? readFileSync(logFile, "utf8")
        .split("\n")
        .filter((line) => line !== "")
    : [];
  const recorded = childrenOf(rig)
    .filter((child) => child.name === "wrangler")
    .map((child) => {
      const args = child.argv.split("\n").filter((line) => line !== "");
      return args.filter((arg, at) => arg !== "--config" && args[at - 1] !== "--config").join(" ");
    });
  assert.deepEqual([...recorded].sort(), [...logged].sort(), "the stand-in's log and the recorders disagree");
  return logged;
}

/** Every file under dir that holds one of the texts, but those under `except`. */
function filesHolding(dir, texts, except = []) {
  const held = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (except.some((skipped) => file === skipped || file.startsWith(`${skipped}${path.sep}`))) continue;
    if (entry.isDirectory()) held.push(...filesHolding(file, texts, except));
    else if (entry.isFile()) {
      const text = readFileSync(file, "utf8");
      if (texts.some((value) => text.includes(value))) held.push(file);
    }
  }
  return held;
}

/**
 * Fails when any password the API received, the token, the database URL or the maker's password is where it must not
 * be: in a child's arguments or environment (the script's own node alone holds STAGING_DATABASE_URL, by that name), in
 * a file of the checkout, its home or its temporary folder, or in the output. Every child is checked, cf.sh's and
 * wrangler's among them.
 */
function assertNothingLeaked(rig, result, db, passwords, what) {
  const children = childrenOf(rig);
  assert.ok(children.some(isScript), `${what}: the script's node was not recorded`);
  const url = db?.url ?? "";
  const dbTexts = url === "" ? [] : [url, db.password];
  for (const child of children) {
    const which = `${what}, ${child.name} ${child.argv.split("\n")[0]}`;
    assert.deepEqual(
      holders(child.env, [...passwords, TOKEN]),
      [],
      `${which}: its environment holds a password or the token`,
    );
    const args = child.argv.split("\n");
    assert.equal(
      args.some((arg) => [...passwords, TOKEN, ...dbTexts].some((text) => text !== "" && arg.includes(text))),
      false,
      `${which}: an argument holds a value`,
    );
    // The script's own node alone holds the URL, as STAGING_DATABASE_URL: no other process does under any name, the
    // .sh's own dirname included, wherever the caller put it.
    const meant = isScript(child) ? ["STAGING_DATABASE_URL"] : [];
    assert.deepEqual(
      holders(child.env, dbTexts).filter((name) => !meant.includes(name)),
      [],
      `${which}: its environment holds the database URL or its password`,
    );
    if (!isScript(child)) {
      assert.equal(
        namesIn(child.env).includes("STAGING_DATABASE_URL"),
        false,
        `${which}: STAGING_DATABASE_URL`,
      );
    }
    // What the script starts (cf.sh and all it starts, wrangler among them) goes without the credential names wrangler
    // would take before the sign-in. Those processes carry the settings the script gives every child.
    if (
      child.env.includes("\nWRANGLER_WRITE_LOGS=false\n") ||
      child.env.startsWith("WRANGLER_WRITE_LOGS=false\n")
    ) {
      assert.deepEqual(
        namesIn(child.env).filter((name) => name in DECOYS),
        [],
        `${which}: its environment has a credential's name`,
      );
    }
    if (child.name === "wrangler") {
      const settings = Object.fromEntries(
        child.env
          .split("\n")
          .map((line) => /^([A-Z_]+)=(.*)$/.exec(line))
          .filter((match) => match !== null)
          .map(([, name, value]) => [name, value]),
      );
      assert.deepEqual(
        [
          settings.WRANGLER_LOG_SANITIZE,
          settings.WRANGLER_WRITE_LOGS,
          settings.WRANGLER_SEND_METRICS,
          settings.CLOUDFLARE_ACCOUNT_ID,
        ],
        ["true", "false", "false", ACCOUNT],
        `${which}: wrangler's settings`,
      );
      assert.equal(
        settings.XDG_CONFIG_HOME,
        path.join(rig.dir, "home", ".config", "rosfield"),
        `${which}: the sign-in`,
      );
    }
  }
  for (const text of [...passwords, TOKEN, ...dbTexts]) {
    assert.equal(result.output.includes(text), false, `${what}: the output holds a value`);
  }
  assert.deepEqual(filesHolding(rig.dir, passwords, [rig.spy]), [], `${what}: a file holds a password`);
  assert.deepEqual(
    filesHolding(rig.dir, [TOKEN], [rig.spy, path.join(rig.state, "token.txt")]),
    [],
    `${what}: a file holds the token`,
  );
}

/** A login's shape on the server, read as the superuser. */
async function shapeOf(login) {
  const [role] = await admin`
    select oid::text as oid, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
           rolpassword is not null as has_password
    from pg_authid where rolname = ${login}`;
  if (role === undefined) return null;
  const own = await admin`
    select r.rolname as role, m.inherit_option as inherit, m.set_option as set, m.admin_option as admin
    from pg_auth_members m join pg_roles r on r.oid = m.roleid
    where m.member = ${role.oid}::oid order by r.rolname`;
  return { ...role, own: [...own] };
}

/** A login's stored password as the superuser reads it (pg_authid.rolpassword): its verifier, or null. */
async function secretOf(login) {
  const [row] = await admin`select rolpassword as secret from pg_authid where rolname = ${login}`;
  return row?.secret ?? null;
}

/** Whether a password logs in as the login, straight to the server. */
async function logsIn(login, password) {
  const url = new URL(serverUrl());
  url.username = login;
  url.password = password;
  const client = postgres(url.href, { max: 1, onnotice: () => undefined, connect_timeout: 15 });
  try {
    const [row] = await client`select current_user as who`;
    return row.who === login;
  } catch {
    return false;
  } finally {
    await client.end({ timeout: 5 });
  }
}

/** Fails unless both logins are in their shape. */
async function assertLogins(names, what) {
  for (const [login, role] of [
    [names.worker_job, names.job],
    [names.worker_app, names.app],
  ]) {
    const shape = await shapeOf(login);
    assert.ok(shape, `${what}: ${login} is missing`);
    assert.deepEqual(
      [
        shape.rolcanlogin,
        shape.rolsuper,
        shape.rolcreatedb,
        shape.rolcreaterole,
        shape.rolreplication,
        shape.rolbypassrls,
      ],
      [true, false, false, false, false, false],
      `${what}: ${login}'s flags`,
    );
    assert.deepEqual(
      shape.own,
      [{ role, inherit: true, set: false, admin: false }],
      `${what}: ${login}'s memberships`,
    );
  }
}

/** Fails unless a run was refused before any password: no create, and no login holds a password. */
async function assertNoPassword(stand, names, result, what) {
  assert.equal(result.status, 1, `${what}: ${result.output}`);
  assert.deepEqual(stand.posts, [], `${what}: the API was called`);
  for (const login of [names.worker_job, names.worker_app]) {
    const shape = await shapeOf(login);
    assert.equal(shape?.has_password ?? false, false, `${what}: ${login} holds a password`);
  }
}

/**
 * A case whose maker also has pg_stat_statements keeping utility statements' text (placeholders, as the test server
 * has no such module): the run is still refused before any password, for the reason given and not for that (T-1369).
 */
async function assertRefusedBesideStatements(t, caseName, setPrivilege, settings, reason) {
  const rig = checkout(t, caseName);
  const db = await database(rig.names, { setPrivilege, settings });
  const stand = await api(rig);
  const refused = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
  assert.match(
    refused.stderr,
    /^create-staging-hyperdrive: refused: this session would write the ALTER ROLE's text, password included, to the server log or keep it: .*No password was made \(ADR-014, open question 3\)$/m,
  );
  assert.match(refused.stderr, reason);
  assert.doesNotMatch(refused.stderr, /pg_stat_statements/, `${caseName}: pg_stat_statements was named`);
  // Only track_utility is set, so track reads as not set (null), which pg_stat_statements takes as top.
  assert.match(refused.stdout, /pg_stat_statements\.track null, pg_stat_statements\.track_utility on$/m);
  assert.equal(refused.connections, 1);
  assert.deepEqual(wranglerCalls(rig), ["hyperdrive list"]);
  await assertNoPassword(stand, rig.names, refused, caseName);
  assert.equal(callsOf(refused.sessions).length, 0, `${caseName}: a password was sent`);
  assert.equal(await shapeOf(rig.names.worker_job), null, `${caseName}: a login was made`);
}

const created = (name) => new RegExp(`^${name} created: id ([0-9a-f]{32}), caching disabled$`, "m");
const summary = (name, login) =>
  new RegExp(`^${name}: id ([0-9a-f]{32}), caching disabled, stores ${login}: yes$`, "m");

before(async () => {
  admin = postgres(serverUrl(), { max: 3, onnotice: () => undefined, connect_timeout: 15 });
  const [server] = await admin`
    select current_setting('server_version_num')::int as version, rolsuper,
           current_setting('pg_stat_statements.track_utility', true) as pgss
    from pg_roles where rolname = current_user`;
  assert.ok(
    server.rolsuper,
    "the tests' login must be a superuser, as the local and CI containers' first user is",
  );
  assert.ok(
    server.version >= 160000,
    `the test server is older than PostgreSQL 16 (${String(server.version)})`,
  );
  assert.equal(
    server.pgss,
    null,
    "pg_stat_statements is loaded on the test server: every run would be refused",
  );
  assert.ok(ACCOUNT, "cf.sh no longer pins ROSFIELD_ACCOUNT_ID");
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "rosie-t1252-tls-")));
  const { cert, key } = certificate();
  const caFile = path.join(dir, "test-ca.crt");
  writeFileSync(caFile, cert);
  const context = tls.createSecureContext({ cert, key });
  const upstream = new URL(serverUrl());
  const sessions = [];
  const proxy = tlsProxy(
    context,
    { host: upstream.hostname, port: Number(upstream.port || "5432") },
    sessions,
  );
  const old = oldServer(context);
  shared = {
    dir,
    caFile,
    sessions,
    proxy: proxy.counts,
    proxyServer: proxy.server,
    proxyPort: await listen(proxy.server),
    old,
    oldPort: await listen(old.server),
  };
});

after(async () => {
  if (shared !== undefined) {
    await closeServer(shared.proxyServer);
    await closeServer(shared.old.server);
    rmSync(shared.dir, { recursive: true, force: true });
  }
  if (admin === undefined) return;
  try {
    // The databases a case made for itself (T-1371) go first, with any connection still open to them.
    const databases = await admin`select datname from pg_database where starts_with(datname, ${RUN})`;
    for (const { datname } of databases) {
      await admin.unsafe(`drop database if exists ${quote(datname)} with (force)`);
    }
    const roles =
      await admin`select rolname from pg_roles where starts_with(rolname, ${RUN}) order by rolname`;
    for (const { rolname } of roles) {
      await admin.unsafe(`drop owned by ${quote(rolname)}`);
      await admin.unsafe(`drop role ${quote(rolname)}`);
    }
    const [{ left }] =
      await admin`select count(*)::int as left from pg_roles where starts_with(rolname, ${RUN})`;
    assert.equal(left, 0, `roles of this run are left on the server (${RUN}_*)`);
    const [{ kept }] =
      await admin`select count(*)::int as kept from pg_database where starts_with(datname, ${RUN})`;
    assert.equal(kept, 0, `databases of this run are left on the server (${RUN}*)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
});

describe("create-staging-hyperdrive.sh makes what is missing, and each password goes only to PostgreSQL as one bound value of one call, and to the API's body (T-1371)", () => {
  it("with neither configuration: one connection as the migrations' role and one check as each login, both logins in their shape, each with a password only the API got, both created with caching disabled and each id printed; then a second run connects to nothing", async (t) => {
    const rig = checkout(t, "a");
    // debug_print_parse and debug_print_rewritten on for the maker: the script sets them off for its session.
    const db = await database(rig.names, {
      settings: { debug_print_parse: "on", debug_print_rewritten: "on" },
    });
    const stand = await api(rig);
    // The caller's shell holds credentials wrangler would use before the sign-in, and the URL under another name.
    const result = await rig.run(stand, {
      env: { STAGING_DATABASE_URL: db.url, DATABASE_URL: db.url, ...DECOYS },
    });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.stderr, "");
    // One connection as the migrations' role: the session whose log settings were checked set both passwords, each
    // through one call (T-1371). Then one connection as each login, its check (T-1369), and nothing else.
    assert.equal(result.connections, 3);
    assert.deepEqual(
      result.sessions.map((session) => session.user),
      [rig.names.maker, rig.names.worker_job, rig.names.worker_app],
    );
    // Each session by its place, never whole (a failing deepEqual of recorded bytes builds a diff too large to print).
    const calls = callsOf(result.sessions);
    assert.deepEqual(
      calls.map((call) => [call.login, result.sessions.indexOf(call.session)]),
      [
        [rig.names.worker_job, 0],
        [rig.names.worker_app, 0],
      ],
    );
    for (const login of [rig.names.worker_job, rig.names.worker_app]) {
      for (const line of [
        `${login}: its transaction held plan_cache_mode force_generic_plan and lock_timeout 500 ms, below deadlock_timeout 1000 ms`,
        `${login}: its password is set (the second bound value of one call of pg_temp.${String(FUNCTION)}, never a statement's text), and its shape after the commit is its own`,
        `${login}: a connection as it with its password answered current_user ${login}`,
        `${login}: the kept-text count: skipped (no pg_stat_statements view is readable in this database)`,
      ]) {
        assert.ok(
          result.stdout.includes(`\ncreate-staging-hyperdrive: ${line}\n`),
          `${line}\n${result.stdout}`,
        );
      }
    }
    assert.match(
      result.stdout,
      /^create-staging-hyperdrive: the database: server_version_num \d+, postmaster started \d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?[+-]\d\d(:\d\d)?, max_connections \d+$/m,
    );
    assert.match(
      result.stdout,
      /^create-staging-hyperdrive: this session's plans and bound values: debug_print_plan off, log_parameter_max_length_on_error 0, log_statement_stats off, log_parser_stats off, log_planner_stats off, log_executor_stats off, auto_explain not loaded, no pg_stat_monitor or pg_store_plans setting$/m,
    );
    assert.match(
      result.stdout,
      /^create-staging-hyperdrive: this session's temporary function: TEMPORARY on its database yes, plpgsql usable$/m,
    );
    // For the record, deciding nothing: shared_preload_libraries only where the role may read it (the maker may not).
    assert.match(
      result.stdout,
      /^create-staging-hyperdrive: for the record: log_min_messages \w+, log_error_verbosity \w+, log_lock_waits (on|off), deadlock_timeout 1s, log_parameter_max_length -?\d+\w*, password_encryption [\w-]+, shared_preload_libraries \(not readable\)$/m,
    );
    assert.match(
      result.stdout,
      new RegExp(`^create-staging-hyperdrive: ${rig.names.worker_job}: not on the server yet$`, "m"),
    );
    assert.match(
      result.stdout,
      /^create-staging-hyperdrive: this session's logging: log_statement none, log_min_error_statement panic, log_min_duration_statement -1, log_min_duration_sample -1, log_statement_sample_rate 1, log_transaction_sample_rate 0, debug_print_parse off, debug_print_rewritten off, pg_stat_statements not loaded$/m,
    );
    assert.match(
      result.stdout,
      /^create-staging-hyperdrive: the API token: the Rosfield sign-in's, type oauth \(not shown\)$/m,
    );
    const jobId = created(JOB).exec(result.stdout)?.[1];
    const appId = created(APP).exec(result.stdout)?.[1];
    assert.ok(jobId && appId, result.stdout);
    assert.equal(summary(JOB, rig.names.worker_job).exec(result.stdout)?.[1], jobId);
    assert.equal(summary(APP, rig.names.worker_app).exec(result.stdout)?.[1], appId);
    assert.deepEqual(wranglerCalls(rig), ["hyperdrive list", "auth token --json", "hyperdrive list"]);

    // The API's two creates: the sign-in's token, JSON, the origin of STAGING_DATABASE_URL with the login as user.
    assert.equal(stand.posts.length, 2);
    for (const post of stand.posts) {
      assert.equal(post.authorization, `Bearer ${TOKEN}`);
      assert.equal(post.contentType, "application/json");
    }
    const creates = stand.creates();
    const passwords = creates.map((body) => body.origin.password);
    for (const [index, [name, login]] of [
      [JOB, rig.names.worker_job],
      [APP, rig.names.worker_app],
    ].entries()) {
      const body = creates[index];
      assert.deepEqual(Object.keys(body).sort(), ["caching", "name", "origin"]);
      assert.equal(body.name, name);
      assert.deepEqual(body.caching, { disabled: true });
      assert.deepEqual(
        { ...body.origin, password: "(checked below)" },
        {
          scheme: "postgres",
          host: "127.0.0.1",
          port: shared.proxyPort,
          database: db.database,
          user: login,
          password: "(checked below)",
        },
      );
      assert.match(body.origin.password, /^[0-9a-f]{64}$/);
      // The password the API received is the one the call set: it logs in as that login.
      assert.equal(
        await logsIn(login, body.origin.password),
        true,
        `${login}: the API's password does not log in`,
      );
      assert.equal(calls[index].password, body.origin.password, `${login}: the call set another password`);
    }
    assert.notEqual(passwords[0], passwords[1]);
    // For each login in turn: its call, then its check (one query, as it), then its create (T-1369, T-1371).
    for (const [index, login] of [rig.names.worker_job, rig.names.worker_app].entries()) {
      const check = result.sessions[index + 1];
      const checked = queriesOf(check);
      assert.equal(checked.length, 1, `${login}: its check sent another query`);
      assert.match(checked[0].text, /^select current_user\b/);
      assert.ok(
        calls[index].at < check.at && checked[0].at < stand.posts[index].at,
        `${login}: not its call, then its check, then its create`,
      );
    }
    assert.ok(stand.posts[0].at < calls[1].at, "the app login's password was set before the job's create");
    await assertLogins(rig.names, "the first run");
    assertNothingLeaked(rig, result, db, passwords, "the first run");

    // A second run: both exist and store their logins, so it connects to nothing and makes no password.
    const again = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
    assert.equal(again.status, 0, again.output);
    assert.equal(again.stderr, "");
    assert.equal(again.connections, 0, "the second run connected to the database");
    assert.equal(stand.posts.length, 2, "the second run called the API");
    assert.match(again.stdout, new RegExp(`^${JOB} already exists: id ${jobId}, caching disabled$`, "m"));
    assert.match(again.stdout, new RegExp(`^${APP} already exists: id ${appId}, caching disabled$`, "m"));
    assert.match(
      again.stdout,
      /^create-staging-hyperdrive: both configurations exist and store their logins: nothing was connected to, and no password was made$/m,
    );
    assert.equal(summary(JOB, rig.names.worker_job).exec(again.stdout)?.[1], jobId);
    assert.equal(await logsIn(rig.names.worker_job, passwords[0]), true, "the second run changed a password");
    assert.equal(await logsIn(rig.names.worker_app, passwords[1]), true, "the second run changed a password");
    assertNothingLeaked(rig, again, db, passwords, "both runs");
  });

  it("with one configuration there, storing its login: it is left as it is, its user checked, and only the other is made (the URL from .dev.vars by name)", async (t) => {
    const names = namesFor("b");
    const rig = checkout(t, "b", {
      configs: [
        {
          id: ID_THERE,
          name: JOB,
          user: names.worker_job,
          host: "127.0.0.1",
          port: 5432,
          database: "made_up_db",
          caching: "disabled",
        },
      ],
    });
    const db = await database(rig.names);
    write(
      path.join(rig.root, ".dev.vars"),
      `OTHER_MADE_UP_KEY=t1252-other\nSTAGING_DATABASE_URL=${db.url}\n`,
    );
    const stand = await api(rig);
    const result = await rig.run(stand);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, new RegExp(`^${JOB} already exists: id ${ID_THERE}, caching disabled$`, "m"));
    assert.doesNotMatch(result.stdout, new RegExp(`^${JOB} created`, "m"));
    assert.ok(created(APP).test(result.stdout), result.stdout);
    assert.equal(stand.creates().length, 1);
    assert.equal(stand.creates()[0].name, APP);
    assert.match(result.stdout, summary(JOB, rig.names.worker_job));
    assert.match(result.stdout, summary(APP, rig.names.worker_app));
    // Both logins are made by worker-logins.sql; only the missing configuration's login gets a password.
    await assertLogins(rig.names, "one there");
    assert.equal((await shapeOf(rig.names.worker_job))?.has_password, false);
    const password = stand.creates()[0].origin.password;
    assert.equal(await logsIn(rig.names.worker_app, password), true);
    assertNothingLeaked(rig, result, db, [password], "one there");
    // .dev.vars itself holds the URL; no other file does.
    assert.deepEqual(
      filesHolding(rig.dir, [db.url, db.password], [rig.spy, path.join(rig.root, ".dev.vars")]),
      [],
    );
  });
});

describe("create-staging-hyperdrive.sh leaves a configuration with caching on as it is, and says so", () => {
  it("both there, storing their logins, one with caching on: nothing is connected to or made, and the run ends 1", async (t) => {
    const names = namesFor("z");
    const row = (id, name, user, caching) => ({
      id,
      name,
      user,
      host: "127.0.0.1",
      port: 5432,
      database: "x",
      caching,
    });
    const rig = checkout(t, "z", {
      configs: [
        row(ID_THERE, JOB, names.worker_job, "disabled"),
        row(
          "ffeeddccbbaa99887766554433221100",
          APP,
          names.worker_app,
          "max_age: 60, stale_while_revalidate: 15",
        ),
      ],
    });
    const stand = await api(rig);
    // A URL that is never connected to: with both there, the script connects to nothing.
    const result = await rig.run(stand, {
      env: { STAGING_DATABASE_URL: "postgres://made_up_owner:t1252-made-up-pass@127.0.0.1:9/main" },
    });
    assert.equal(result.status, 1, result.output);
    assert.equal(result.connections, 0);
    assert.deepEqual(stand.posts, []);
    assert.deepEqual(wranglerCalls(rig), ["hyperdrive list"]);
    assert.match(result.stdout, summary(JOB, names.worker_job));
    assert.match(
      result.stdout,
      new RegExp(
        `^${APP}: id ffeeddccbbaa99887766554433221100, caching max_age: 60, stale_while_revalidate: 15, stores ${names.worker_app}: yes\\ncreate-staging-hyperdrive: ${APP}'s caching is not disabled, as ADR-007 needs: it is left as it is here; turn it off in Cloudflare's dashboard before T-567 binds it$`,
        "m",
      ),
    );
  });
});

describe("create-staging-hyperdrive.sh refuses before any password", () => {
  it("a configuration that exists and stores another user stops the run before anything is connected to or made, and that user is never shown", async (t) => {
    const other = "made_up_owner_t1252";
    const rig = checkout(t, "c", {
      configs: [
        {
          id: ID_THERE,
          name: APP,
          user: other,
          host: "127.0.0.1",
          port: 5432,
          database: "made_up_db",
          caching: "disabled",
        },
      ],
    });
    const db = await database(rig.names);
    const stand = await api(rig);
    const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
    assert.equal(result.status, 1, result.output);
    assert.equal(result.connections, 0);
    assert.match(result.stdout, new RegExp(`^${APP} already exists: id ${ID_THERE}, caching disabled$`, "m"));
    assert.match(
      result.stderr,
      new RegExp(
        `^create-staging-hyperdrive: refused: ${APP} exists and stores another user \\(not shown\\), not its login ${rig.names.worker_app}: it is left as it is`,
        "m",
      ),
    );
    assert.equal(result.output.includes(other), false, "the other user was shown");
    assert.deepEqual(wranglerCalls(rig), ["hyperdrive list"]);
    await assertNoPassword(stand, rig.names, result, "another user");
    assert.equal(await shapeOf(rig.names.worker_job), null, "a login was made");
    assert.deepEqual(rig.configs().length, 1);
  });

  // [title, the maker's SET privilege on the two settings, its settings, what the refusal names]
  const LOGGING = [
    [
      "log_min_error_statement at its default, error, which the maker may not lower",
      false,
      {},
      /log_min_error_statement is error/,
    ],
    [
      "log_statement ddl, which the maker may not lower",
      false,
      { log_statement: "ddl", log_min_error_statement: "panic" },
      /log_statement is ddl/,
    ],
    [
      "log_min_duration_statement 0",
      true,
      { log_min_duration_statement: "0" },
      /log_min_duration_statement is 0/,
    ],
    [
      "log_min_duration_sample 0, sampled at 1",
      true,
      { log_min_duration_sample: "0" },
      /log_min_duration_sample is 0 with log_statement_sample_rate 1/,
    ],
    [
      "log_transaction_sample_rate 0.5",
      true,
      { log_transaction_sample_rate: "0.5" },
      /log_transaction_sample_rate is 0\.5/,
    ],
  ];
  for (const [index, [title, setPrivilege, settings, reason]] of LOGGING.entries()) {
    it(`log settings that would log the ALTER ROLE: ${title}`, async (t) => {
      const rig = checkout(t, `l${String(index)}`);
      const db = await database(rig.names, { setPrivilege, settings });
      const stand = await api(rig);
      const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
      assert.match(
        result.stderr,
        /^create-staging-hyperdrive: refused: this session would write the ALTER ROLE's text, password included, to the server log or keep it: .*No password was made \(ADR-014, open question 3\)$/m,
      );
      assert.match(result.stderr, reason);
      assert.equal(result.connections, 1);
      // Refused before the token and before worker-logins.sql: no login made, no password, no create.
      assert.deepEqual(wranglerCalls(rig), ["hyperdrive list"]);
      await assertNoPassword(stand, rig.names, result, title);
      assert.equal(await shapeOf(rig.names.worker_job), null, `${title}: a login was made`);
      assertNothingLeaked(rig, result, db, [], title);
    });
  }

  it("pg_stat_statements with track top and track_utility on runs through (T-1371: top keeps only each statement the run sends, and none holds a password; with no view in the database the kept-text count is skipped); every other stop rule still stops beside it; with its tracking off it runs", async (t) => {
    // The module is not loaded on the test server: its two settings, set for the maker as placeholders, stand in, as
    // staging's are (track top, track_utility on: CQ-225's answer, DL-540).
    const rig = checkout(t, "p");
    const db = await database(rig.names, {
      settings: { "pg_stat_statements.track": "top", "pg_stat_statements.track_utility": "on" },
    });
    const stand = await api(rig);
    const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /pg_stat_statements\.track top, pg_stat_statements\.track_utility on$/m);
    for (const login of [rig.names.worker_job, rig.names.worker_app]) {
      assert.ok(
        result.stdout.includes(
          `\ncreate-staging-hyperdrive: ${login}: the kept-text count: skipped (no pg_stat_statements view is readable in this database)\n`,
        ),
        result.stdout,
      );
    }
    assert.equal(stand.creates().length, 2);
    assert.match(result.stdout, summary(JOB, rig.names.worker_job));
    assert.match(result.stdout, summary(APP, rig.names.worker_app));
    // What track top could keep: the text of each statement the run's own connection sent, and none holds a password;
    // each password went as the second value of its call's Bind.
    const passwords = stand.creates().map((body) => body.origin.password);
    const calls = callsOf(result.sessions);
    assert.deepEqual(
      calls.map((call) => [call.login, call.password]),
      [
        [rig.names.worker_job, passwords[0]],
        [rig.names.worker_app, passwords[1]],
      ],
    );
    for (const query of queriesOf(result.sessions[0])) {
      assert.equal(
        passwords.some((password) => query.text.includes(password)),
        false,
        "a statement's text holds a password",
      );
    }
    assertNothingLeaked(rig, result, db, passwords, "pg_stat_statements");

    // Beside it, the server log's rules still stop the run before any password, and name only their own. (pgaudit's
    // case beside it is the last suite's: a pgaudit.log placeholder set here would fail the T-1271 suite's first check.)
    for (const [caseName, settings, reason] of [
      [
        "pl",
        { "pg_stat_statements.track_utility": "on", log_statement: "ddl", log_min_error_statement: "panic" },
        /log_statement is ddl/,
      ],
      ["pe", { "pg_stat_statements.track_utility": "on" }, /log_min_error_statement is error/],
    ]) {
      await assertRefusedBesideStatements(t, caseName, false, settings, reason);
    }

    const quiet = checkout(t, "q");
    const quietDb = await database(quiet.names, {
      settings: { "pg_stat_statements.track": "none", "pg_stat_statements.track_utility": "on" },
    });
    const quietApi = await api(quiet);
    const ran = await quiet.run(quietApi, { env: { STAGING_DATABASE_URL: quietDb.url } });
    assert.equal(ran.status, 0, ran.output);
    assert.match(ran.stdout, /pg_stat_statements\.track none, pg_stat_statements\.track_utility on$/m);
    assert.match(ran.stdout, /: the kept-text count: skipped \(no pg_stat_statements view is readable/);
    assert.equal(quietApi.creates().length, 2);
  });

  it("a pooled host is refused before anything is listed or connected to", async (t) => {
    const rig = checkout(t, "h");
    const stand = await api(rig);
    const url =
      "postgres://made_up_owner:t1252-made-up-pass@ep-made-up-000000-pooler.made-up-region.example.test/main?sslmode=require";
    const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: url } });
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.stderr,
      /^create-staging-hyperdrive: refused: STAGING_DATABASE_URL names a pooled host \(-pooler\)/m,
    );
    assert.equal(result.output.includes("ep-made-up"), false);
    assert.deepEqual(wranglerCalls(rig), []);
    assert.equal(result.connections, 0);
    assert.deepEqual(stand.posts, []);
  });

  it("an older server is refused after its first answer, before anything else is sent on that connection", async (t) => {
    const rig = checkout(t, "o");
    const stand = await api(rig);
    const before = shared.old.queries.length;
    const url = `postgres://made_up_owner:t1252-made-up-pass@127.0.0.1:${String(shared.oldPort)}/main?sslmode=require`;
    const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: url } });
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.stderr,
      /^create-staging-hyperdrive: refused: the database is older than PostgreSQL 16 \(server_version_num 150004\): a grant WITH INHERIT TRUE, SET FALSE needs 16 or later; no password was made$/m,
    );
    const sent = shared.old.queries.slice(before);
    assert.equal(sent.length, 1, `more than the one query reached the older server: ${sent.join(" | ")}`);
    assert.match(sent[0], /current_setting\('server_version_num'\)/);
    assert.deepEqual(wranglerCalls(rig), ["hyperdrive list"]);
    assert.deepEqual(stand.posts, []);
  });

  // [the stand-in's token answer, what the refusal says]
  const TOKENS = [
    ["api_token", /gave a credential of type api_token, and only the sign-in's oauth token is taken/],
    ["api_key", /gave a credential of type api_key, and only the sign-in's oauth token is taken/],
    ["text", /what cf\.sh auth token --json printed is not JSON \(it is not shown\)/],
    ["no_token", /gave no token in a bearer token's form/],
    ["short", /gave no token in a bearer token's form/],
    ["fail", /cf\.sh auth token --json failed \(exit 1, for the reason above/],
    ["fail_json", /cf\.sh auth token --json failed \(exit 1, for the reason above/],
  ];
  for (const [mode, reason] of TOKENS) {
    it(`a token that is not the sign-in's oauth token refuses before any password: ${mode}`, async (t) => {
      const rig = checkout(t, `t${mode.replaceAll("_", "")}`, { plan: { token: mode } });
      const db = await database(rig.names);
      const stand = await api(rig);
      const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
      assert.match(result.stderr, reason);
      assert.deepEqual(wranglerCalls(rig), ["hyperdrive list", "auth token --json"]);
      await assertNoPassword(stand, rig.names, result, mode);
      // Refused before worker-logins.sql: no login was made.
      assert.equal(await shapeOf(rig.names.worker_job), null, `${mode}: a login was made`);
      // A failing wrangler's own words are shown, with the token it printed taken out, alone or from inside its JSON.
      if (mode.startsWith("fail")) {
        assert.match(
          result.stderr,
          /Not logged in\. Please run wrangler login to authenticate \(\[redacted\]\)/,
        );
      }
      assertNothingLeaked(rig, result, db, [], mode);
    });
  }

  it("NODE_TLS_REJECT_UNAUTHORIZED=0 is refused before anything is listed, read or made", async (t) => {
    const rig = checkout(t, "n");
    const db = await database(rig.names);
    const stand = await api(rig);
    const result = await rig.run(stand, {
      env: { STAGING_DATABASE_URL: db.url, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    });
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.stderr,
      /^create-staging-hyperdrive: refused: NODE_TLS_REJECT_UNAUTHORIZED=0 would turn off the certificate check of the API call and of the database connection \(unset it\); nothing was listed, read or made$/m,
    );
    assert.deepEqual(wranglerCalls(rig), []);
    assert.equal(result.connections, 0);
    assert.deepEqual(stand.posts, []);
  });

  it("a server whose certificate it cannot check is refused before any password, whatever the URL's sslmode says", async (t) => {
    const rig = checkout(t, "v");
    const db = await database(rig.names);
    const stand = await api(rig);
    // No NODE_EXTRA_CA_CERTS: the proxy's certificate is not trusted. The URL still says sslmode=require.
    const result = await rig.run(stand, {
      env: { STAGING_DATABASE_URL: db.url, NODE_EXTRA_CA_CERTS: undefined },
    });
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.stderr,
      /^create-staging-hyperdrive: refused: could not connect to STAGING_DATABASE_URL's server with its certificate checked, or read its version \(.+\): .+; no password was made$/m,
    );
    assert.equal(shared.proxy.plain, 0, "a client connected without TLS");
    await assertNoPassword(stand, rig.names, result, "an unchecked certificate");
    assertNothingLeaked(rig, result, db, [], "an unchecked certificate");
  });

  it("a list that fails is refused before anything is connected to or made", async (t) => {
    const rig = checkout(t, "f", { plan: { list: "fail" } });
    const db = await database(rig.names);
    const stand = await api(rig);
    const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /A request to the Cloudflare API failed\./);
    assert.match(
      result.stderr,
      /^create-staging-hyperdrive: refused: the list before anything is made: cf\.sh hyperdrive list failed \(exit 1, for the reason above\)/m,
    );
    assert.equal(result.connections, 0);
    assert.deepEqual(stand.posts, []);
  });

  it("an argument is misuse (exit 2), never echoed, and nothing is read or started", async (t) => {
    const rig = checkout(t, "u");
    const stand = await api(rig);
    for (const args of [["--env", "production"], ["--force"], ["t1252-made-up-pasted-value"]]) {
      const result = await rig.run(stand, {
        args,
        env: { STAGING_DATABASE_URL: "postgres://u:p@127.0.0.1/x" },
      });
      assert.equal(result.status, 2, result.output);
      assert.equal(
        result.stderr,
        "create-staging-hyperdrive.sh: it takes no arguments (they are never echoed)\n" +
          "usage: create-staging-hyperdrive.sh   (no arguments: it makes rosie-staging-hyperdrive-job and -app, each only when missing)\n",
      );
      assert.equal(result.stdout, "");
    }
    assert.deepEqual(
      childrenOf(rig).filter((child) => child.name !== "dirname" && child.name !== "basename"),
      [],
    );
  });
});

describe("create-staging-hyperdrive.sh: a failure between the password and the create is safe to repeat", () => {
  it("the API refuses the create: Cloudflare's words are shown without the password, the token or the host, and the next run sets a fresh password and makes it", async (t) => {
    const rig = checkout(t, "e");
    const db = await database(rig.names);
    const stand = await api(rig, ["fail"]);
    const failed = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
    assert.equal(failed.status, 1, failed.output);
    assert.match(
      failed.stderr,
      new RegExp(
        `^create-staging-hyperdrive: refused: Cloudflare's API did not create ${JOB} \\(HTTP 500: 2008: could not reach \\[redacted\\] as ${rig.names.worker_job} with password \\[redacted\\] \\(Bearer \\[redacted\\]\\)\\)\\. ${rig.names.worker_job} now holds a password nobody has, so this is safe to repeat: the next run, finding no configuration, sets a fresh one$`,
        "m",
      ),
    );
    assert.equal(failed.output.includes("127.0.0.1"), false, "the host was shown");
    const first = stand.creates()[0].origin.password;
    // The login holds the password that went nowhere but Cloudflare's refusal.
    assert.equal(await logsIn(rig.names.worker_job, first), true);
    assert.equal(stand.creates().length, 1, "the run went on after the failed create");
    assertNothingLeaked(rig, failed, db, [first], "the failed create");

    const again = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
    assert.equal(again.status, 0, again.output);
    const creates = stand.creates();
    assert.equal(creates.length, 3);
    const fresh = creates[1].origin.password;
    assert.equal(creates[1].name, JOB);
    assert.notEqual(fresh, first, "the password was made again, not fresh");
    assert.equal(await logsIn(rig.names.worker_job, fresh), true);
    assert.equal(await logsIn(rig.names.worker_job, first), false, "the first password still logs in");
    assert.match(again.stdout, summary(JOB, rig.names.worker_job));
    assert.match(again.stdout, summary(APP, rig.names.worker_app));
    assertNothingLeaked(
      rig,
      again,
      db,
      creates.map((body) => body.origin.password),
      "both runs",
    );
  });

  it("a create that reached Cloudflare but did not answer is found by the next run's list, and no new password is set for it", async (t) => {
    const rig = checkout(t, "d");
    const db = await database(rig.names);
    const stand = await api(rig, ["hang-up"]);
    const failed = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
    assert.equal(failed.status, 1, failed.output);
    assert.match(
      failed.stderr,
      new RegExp(
        `^create-staging-hyperdrive: refused: Cloudflare's API did not answer the create of ${JOB}(: | \\(\\w+\\): ).+\\. ${rig.names.worker_job} now holds a password nobody has, so this is safe to repeat: the next run lists first, finds ${JOB} if the create reached Cloudflare \\(and sets no new password for it\\), or else sets a fresh password and creates it$`,
        "m",
      ),
    );
    const first = stand.creates()[0].origin.password;
    assert.equal(rig.configs().length, 1, "the stand-in did not keep the configuration");

    const again = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
    assert.equal(again.status, 0, again.output);
    assert.match(again.stdout, new RegExp(`^${JOB} already exists: id [0-9a-f]{32}, caching disabled$`, "m"));
    assert.equal(stand.creates().length, 2);
    assert.equal(stand.creates()[1].name, APP);
    // No new password for the configuration that reached Cloudflare: the first one still logs in.
    assert.equal(await logsIn(rig.names.worker_job, first), true);
    assert.match(again.stdout, summary(JOB, rig.names.worker_job));
    assertNothingLeaked(
      rig,
      again,
      db,
      stand.creates().map((body) => body.origin.password),
      "both runs",
    );
  });
});

describe("create-staging-hyperdrive.sh hands no value to what it starts, whatever the caller's shell holds", () => {
  const code = () =>
    readFileSync(path.join(SCRIPTS, SCRIPT), "utf8")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line) && line.trim() !== "");

  it("it switches tracing, allexport and keyword off first, drops its working names and the database URLs before anything starts, and ends by exec'ing node with the URL alone", () => {
    const lines = code();
    assert.deepEqual(lines.slice(0, 8), [
      "set +x",
      "set +a",
      "set +k",
      "set -euo pipefail",
      "unset -v USAGE url name file line value BASH_REMATCH",
      'url="${STAGING_DATABASE_URL-}"',
      "unset -v STAGING_DATABASE_URL DATABASE_URL",
      'source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"',
    ]);
    assert.deepEqual(lines.slice(-6), [
      'if [[ -z "$url" ]]; then',
      "  load_dev_var STAGING_DATABASE_URL",
      '  url="${STAGING_DATABASE_URL-}"',
      "  unset -v STAGING_DATABASE_URL",
      "fi",
      'STAGING_DATABASE_URL="$url" exec node "$ROOT/infra/scripts/create-staging-hyperdrive.mjs"',
    ]);
    const text = lines.join("\n");
    assert.doesNotMatch(text, /\bset\s+-[A-Za-z]*[xak]|xtrace|allexport|keyword/);
    assert.doesNotMatch(text, /</, "no here-document, here-string or input redirection");
    assert.doesNotMatch(text.replaceAll(">&2", ""), />/, "no redirection into a file");
    assert.doesNotMatch(text, /\b(mktemp|tee|eval|export|declare)\b/);
    // Its own variables and load_dev_var's locals are exactly the unset line's names.
    const loader = /^load_dev_var\(\) \{\n([\s\S]*?)\n\}$/m.exec(
      readFileSync(path.join(SCRIPTS, "lib.sh"), "utf8"),
    );
    assert.ok(loader, "lib.sh no longer holds: load_dev_var() { ... }");
    const names = new Set();
    for (const [, name] of text.matchAll(/(?:^|;|&&|\|\|)[ \t]*([A-Za-z_][A-Za-z0-9_]*)\+?=/gm))
      names.add(name);
    for (const [, words] of loader[1].matchAll(/^[ \t]*local[ \t]+(.+)$/gm)) {
      for (const word of words.split(/[ \t]+/)) names.add(word.replace(/=.*$/, ""));
    }
    // STAGING_DATABASE_URL is assigned only as node's own environment, on the exec line, and is dropped on its own
    // unset line before anything starts.
    assert.deepEqual([...names].sort(), [
      "STAGING_DATABASE_URL",
      "USAGE",
      "file",
      "line",
      "name",
      "url",
      "value",
    ]);
  });

  // [title, the caller's environment beyond the URL, options for bash itself]
  const CALLERS = [
    [
      "the working names in the caller's environment, and bash -a",
      "w",
      {
        USAGE: "t1252 caller",
        name: "t1252 caller",
        file: "t1252 caller",
        line: "t1252 caller",
        value: "t1252 caller",
        BASH_REMATCH: "t1252 caller",
      },
      ["-a"],
    ],
    ["SHELLOPTS=allexport:keyword", "k", { SHELLOPTS: "allexport:keyword" }, []],
    ["bash -k", "j", {}, ["-k"]],
    ["bash -x: the trace stops at set +x", "x", {}, ["-x"]],
  ];
  for (const [title, caseName, extra, bash] of CALLERS) {
    it(`no child holds a value: ${title}`, async (t) => {
      const rig = checkout(t, caseName);
      const db = await database(rig.names);
      const stand = await api(rig);
      const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url, ...extra }, bash });
      assert.equal(
        result.status,
        0,
        `${title}: exit ${String(result.status)} (${String(result.output.length)} characters of output)`,
      );
      if (bash.includes("-x")) {
        assert.match(result.stderr, /set \+x/);
        assert.doesNotMatch(result.stderr, /load_dev_var|exec node|STAGING_DATABASE_URL/);
        assert.equal(result.stderr.includes(db.url), false);
      } else {
        assert.equal(
          result.stderr,
          "",
          `${title}: standard error is not empty (${String(result.stderr.length)} characters)`,
        );
      }
      assert.equal(stand.creates().length, 2);
      assertNothingLeaked(
        rig,
        result,
        db,
        stand.creates().map((body) => body.origin.password),
        title,
      );
      // None of the working names reached node or anything after it with the caller's text.
      for (const child of childrenOf(rig)) {
        assert.deepEqual(
          holders(child.env, ["t1252 caller"]),
          [],
          `${title}: ${child.name} has the caller's text`,
        );
      }
    });
  }
});

describe("create-staging-hyperdrive's names, account, npm script and wrangler's auth token", () => {
  const source = (file) => readFileSync(path.join(REPO, file), "utf8");

  it("npm run hyperdrive:staging:create runs the script", () => {
    assert.equal(
      JSON.parse(source("package.json")).scripts["hyperdrive:staging:create"],
      `bash infra/scripts/${SCRIPT}`,
    );
  });

  it("its configurations, logins and roles are ADR-014's, and its account is the one cf.sh pins", () => {
    const text = source(`infra/scripts/${PROGRAM}`);
    assert.match(
      text,
      /const PAIRS = \[\n {2}\{ name: "rosie-staging-hyperdrive-job", login: "rosie_worker_job", role: "rosie_job" \},\n {2}\{ name: "rosie-staging-hyperdrive-app", login: "rosie_worker_app", role: "rosie_app" \},\n\];/,
    );
    assert.equal(/const ACCOUNT_ID = "([0-9a-f]{32})";/.exec(text)?.[1], ACCOUNT);
    assert.match(
      text,
      /const CREATE_URL = `https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/\$\{ACCOUNT_ID\}\/hyperdrive\/configs`;/,
    );
    // It never hands wrangler a password: its code runs no hyperdrive create and passes no origin password or
    // connection string option.
    const codeLines = text.split("\n").filter((line) => !/^\s*\/\//.test(line));
    assert.deepEqual(
      codeLines.filter((line) => /"create"|origin-password|connection-string/.test(line)),
      [],
    );
    assert.deepEqual(
      codeLines.filter((line) => /cf\(\[/.test(line)).map((line) => line.trim()),
      [
        'const listed = await cf(["hyperdrive", "list"]);',
        'const got = await cf(["auth", "token", "--json"], { keepStderr: true });',
      ],
    );
  });

  it("the installed wrangler's `auth token --json` prints the sign-in's oauth token as {type, token} (read in its code, never run)", () => {
    const wrangler = JSON.parse(source("node_modules/wrangler/package.json"));
    const cli = source("node_modules/wrangler/wrangler-dist/cli.js");
    assert.match(cli, /command: "wrangler auth token",\n\s*definition: authTokenCommand/);
    const start = cli.indexOf("authTokenCommand = createCommand({");
    assert.ok(start > 0, `wrangler ${String(wrangler.version)} defines no authTokenCommand`);
    const body = cli.slice(start, cli.indexOf("authKeyringCommand = createCommand({", start));
    assert.match(body, /json: \{\n\s*type: "boolean"/, "the command takes no --json");
    // The environment's credentials come first (the script drops their names), then the sign-in's oauth token.
    assert.match(
      body,
      /if \("apiToken" in authFromEnv\) \{\n\s*result = \{ type: "api_token", token: authFromEnv\.apiToken \};/,
    );
    assert.match(body, /result = \{ type: "oauth", token \};/);
    // With --json, the answer alone, as JSON on standard output, and no banner.
    assert.match(body, /printBanner: \/\* @__PURE__ \*\/ __name\(\(args\) => !args\.json, "printBanner"\)/);
    assert.match(body, /if \(json2\) \{\n\s*logger2\.json\(result\);/);
    assert.match(
      cli,
      /json = \/\* @__PURE__ \*\/ __name\(\(data\) => \{\n\s*console\.log\(JSON\.stringify\(data, null, 4\)\);/,
    );
    // The credential names it reads from the environment, which every child of the script goes without.
    for (const [name, old] of [
      ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"],
      ["CLOUDFLARE_API_KEY", "CF_API_KEY"],
      ["CLOUDFLARE_EMAIL", "CF_EMAIL"],
    ]) {
      assert.match(cli, new RegExp(`variableName: "${name}",\\n\\s*deprecatedName: "${old}"`));
      assert.match(source(`infra/scripts/${PROGRAM}`), new RegExp(`"${name}",\\n\\s*"`));
      assert.ok(source(`infra/scripts/${PROGRAM}`).includes(`"${old}"`), `the script does not drop ${old}`);
    }
  });
});

describe("create-staging-hyperdrive.sh, hardened before its live run (T-1271: T-1252's security review, notes a to e, and its database review, note a)", () => {
  const source = (file) => readFileSync(path.join(REPO, file), "utf8");
  const refusedForLogging =
    /^create-staging-hyperdrive: refused: this session would write the ALTER ROLE's text, password included, to the server log or keep it: .*No password was made \(ADR-014, open question 3\)$/m;
  const triedPanic =
    /^create-staging-hyperdrive: log_min_error_statement could not be set to panic for this session \(no SET privilege on it\); its value is read next$/m;
  /** Each recorded wrangler call's value of one variable. */
  const wranglerValues = (rig, name) =>
    childrenOf(rig)
      .filter((child) => child.name === "wrangler")
      .map((child) => new RegExp(`^${name}=(.*)$`, "m").exec(child.env)?.[1]);

  before(async () => {
    const [server] = await admin`select current_setting('pgaudit.log', true) as pgaudit`;
    assert.equal(
      server.pgaudit,
      null,
      "pgaudit is loaded on the test server: its placeholders would not stand in",
    );
  });

  // Note a.
  it("log_min_error_statement at log, which the maker may not change, is refused after the script's own try to set panic, before any password, and nothing is made", async (t) => {
    const rig = checkout(t, "sl");
    const db = await database(rig.names, {
      setPrivilege: false,
      settings: { log_statement: "none", log_min_error_statement: "log" },
    });
    const stand = await api(rig);
    const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
    assert.match(result.stdout, triedPanic);
    assert.match(
      result.stdout,
      /^create-staging-hyperdrive: this session's logging: log_statement none, log_min_error_statement log, /m,
    );
    assert.match(result.stderr, refusedForLogging);
    assert.match(
      result.stderr,
      /log_min_error_statement is log \(the statement's text is logged with any message at that level or above, and log ranks above error: only fatal and panic are taken\)/,
    );
    assert.equal(result.connections, 1);
    // Refused before the token and before worker-logins.sql: no login made, no password, no create.
    assert.deepEqual(wranglerCalls(rig), ["hyperdrive list"]);
    await assertNoPassword(stand, rig.names, result, "log_min_error_statement log");
    assert.equal(await shapeOf(rig.names.worker_job), null, "log_min_error_statement log: a login was made");
    assertNothingLeaked(rig, result, db, [], "log_min_error_statement log");
  });

  for (const level of ["fatal", "panic"]) {
    it(`log_min_error_statement at ${level}, which the maker may not change, still runs; each wrangler call (two lists and the token) has WRANGLER_WRITE_LOGS=false (note e)`, async (t) => {
      const rig = checkout(t, `s${level}`);
      const db = await database(rig.names, {
        setPrivilege: false,
        settings: { log_statement: "none", log_min_error_statement: level },
      });
      const stand = await api(rig);
      const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
      assert.equal(result.status, 0, result.output);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, triedPanic);
      assert.match(
        result.stdout,
        new RegExp(
          `^create-staging-hyperdrive: this session's logging: log_statement none, log_min_error_statement ${level}, `,
          "m",
        ),
      );
      assert.match(
        result.stdout,
        /^create-staging-hyperdrive: this session's audit logging: pgaudit not loaded$/m,
      );
      assert.equal(stand.creates().length, 2);
      assert.match(result.stdout, summary(JOB, rig.names.worker_job));
      assert.match(result.stdout, summary(APP, rig.names.worker_app));
      assert.deepEqual(wranglerCalls(rig), ["hyperdrive list", "auth token --json", "hyperdrive list"]);
      assert.deepEqual(wranglerValues(rig, "WRANGLER_WRITE_LOGS"), ["false", "false", "false"]);
      assertNothingLeaked(
        rig,
        result,
        db,
        stand.creates().map((body) => body.origin.password),
        `log_min_error_statement ${level}`,
      );
    });
  }

  it("the levels of log_min_error_statement it takes are exactly the ones the server ranks above log: fatal and panic", async () => {
    const [setting] = await admin`
      select enumvals, extra_desc from pg_settings where name = 'log_min_error_statement'`;
    assert.match(String(setting.extra_desc), /Each level includes all the levels that follow it\./);
    const levels = setting.enumvals;
    assert.deepEqual(levels.slice(levels.indexOf("error")), ["error", "log", "fatal", "panic"]);
    assert.match(
      source(`infra/scripts/${PROGRAM}`),
      /\nconst QUIET_ERROR_LEVELS = new Set\(\["fatal", "panic"\]\);\n/,
    );
  });

  // Note b. [case, the maker's pgaudit.log: a placeholder, as T-1252 set pg_stat_statements' (pgaudit is not loaded
  // on the test server)]
  const AUDITED = [
    ["ga", "role"],
    ["gb", "ddl"],
    ["gc", "all"],
    ["gd", "read, write, ROLE"],
    ["ge", "misc,-read , Ddl"],
    ["gf", "all, -role"],
    ["gg", "every_statement"],
  ];
  for (const [caseName, value] of AUDITED) {
    it(`pgaudit loaded with pgaudit.log "${value}" is refused before any password, and nothing is made`, async (t) => {
      const rig = checkout(t, caseName);
      const db = await database(rig.names, { settings: { "pgaudit.log": value } });
      const stand = await api(rig);
      const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
      assert.ok(
        result.stdout.includes(
          `create-staging-hyperdrive: this session's audit logging: pgaudit.log ${value}\n`,
        ),
        result.stdout,
      );
      assert.match(result.stderr, refusedForLogging);
      assert.ok(
        result.stderr.includes(
          `pgaudit is loaded and pgaudit.log is ${value} (it names role, ddl or all, or a class not known here: its audit log could keep the ALTER ROLE's text)`,
        ),
        result.stderr,
      );
      assert.equal(result.connections, 1);
      assert.deepEqual(wranglerCalls(rig), ["hyperdrive list"]);
      await assertNoPassword(stand, rig.names, result, value);
      assert.equal(await shapeOf(rig.names.worker_job), null, `${value}: a login was made`);
      assertNothingLeaked(rig, result, db, [], value);
    });
  }

  // Since T-1371 any class but none is refused (CQ-225's ruling): the classes that leave ALTER ROLE out, this test's
  // second case before, are refused in the T-1371 suite.
  it("pgaudit loaded with pgaudit.log none runs", async (t) => {
    for (const [caseName, value] of [["gn", "none"]]) {
      const rig = checkout(t, caseName);
      const db = await database(rig.names, { settings: { "pgaudit.log": value } });
      const stand = await api(rig);
      const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
      assert.equal(result.status, 0, result.output);
      assert.ok(
        result.stdout.includes(
          `create-staging-hyperdrive: this session's audit logging: pgaudit.log ${value}\n`,
        ),
        result.stdout,
      );
      assert.equal(stand.creates().length, 2);
      assert.match(result.stdout, summary(JOB, rig.names.worker_job));
      assertNothingLeaked(
        rig,
        result,
        db,
        stand.creates().map((body) => body.origin.password),
        value,
      );
    }
  });

  // Note c.
  it("Cloudflare's text answer, longer than the cut, with the password, the token or the host across the cut, is shown with none of them: scrubbed whole, then cut", async (t) => {
    assert.ok(Number.isInteger(ERROR_TEXT_CUT) && ERROR_TEXT_CUT > 100, "the script names no ERROR_TEXT_CUT");
    const rig = checkout(t, "sc");
    const db = await database(rig.names);
    const kinds = ["password", "token", "host"];
    const stand = await api(
      rig,
      kinds.map((kind) => `long:${kind}`),
    );
    for (const [index, kind] of kinds.entries()) {
      const failed = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
      assert.equal(failed.status, 1, failed.output);
      const body = stand.creates()[index];
      assert.equal(body.name, JOB);
      const value = { password: body.origin.password, token: TOKEN, host: body.origin.host }[kind];
      const kept = Math.ceil(value.length / 2);
      // A cut first would have shown this much of the value.
      const part = value.slice(0, kept);
      const shown = `${"x".repeat(ERROR_TEXT_CUT - kept)}${`[redacted]${"y".repeat(500)}`.slice(0, kept)}`;
      assert.ok(
        failed.stderr.includes(
          `refused: Cloudflare's API did not create ${JOB} (HTTP 502: ${shown}). ${rig.names.worker_job} now holds a password nobody has`,
        ),
        `${kind}: ${failed.stderr}`,
      );
      assert.equal(failed.output.includes(part), false, `${kind}: part of it was shown`);
      assertNothingLeaked(
        rig,
        failed,
        db,
        stand.creates().map((created) => created.origin.password),
        kind,
      );
    }
  });

  // Note d.
  it("a pooled host written in capitals is refused before anything is listed or connected to: Node keeps a postgres:// host's case", async (t) => {
    const rig = checkout(t, "su");
    const stand = await api(rig);
    for (const host of [
      "ep-made-up-000000-POOLER.made-up-region.example.test",
      "EP-MADE-UP-000000-Pooler.MADE-UP-REGION.EXAMPLE.TEST",
    ]) {
      const url = `postgres://made_up_owner:t1252-made-up-pass@${host}/main?sslmode=require`;
      assert.equal(new URL(url).hostname, host, "Node lowers a postgres:// host's case now");
      const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: url } });
      assert.equal(result.status, 1, result.output);
      assert.match(
        result.stderr,
        /^create-staging-hyperdrive: refused: STAGING_DATABASE_URL names a pooled host \(-pooler\)/m,
      );
      assert.equal(result.output.toLowerCase().includes("ep-made-up"), false);
      assert.equal(result.connections, 0);
    }
    assert.deepEqual(wranglerCalls(rig), []);
    assert.deepEqual(stand.posts, []);
  });

  // Note e: read in the installed wrangler's own code, never run to see.
  it("the installed wrangler writes its log file only while WRANGLER_WRITE_LOGS is not false or 0, and the script sets it false for every child", () => {
    const wrangler = JSON.parse(source("node_modules/wrangler/package.json"));
    const cli = source("node_modules/wrangler/wrangler-dist/cli.js");
    assert.match(
      cli,
      /function shouldLogToDisk\(isTestEnvironment = typeof vitest !== "undefined"\) \{\n\s*if \(isTestEnvironment\) \{\n\s*return false;\n\s*\}\n\s*const setting = process\.env\.WRANGLER_WRITE_LOGS\?\.toLowerCase\(\);\n\s*return setting !== "false" && setting !== "0";\n\}/,
      `wrangler ${String(wrangler.version)} does not read WRANGLER_WRITE_LOGS as 4.158.0 does`,
    );
    assert.equal(
      cli.match(/WRANGLER_WRITE_LOGS/g)?.length,
      1,
      "wrangler reads or sets WRANGLER_WRITE_LOGS elsewhere",
    );
    // A logged line reaches the file only through appendToDebugLogFile, called once, under shouldLogToDisk(); and only
    // that function writes the file.
    assert.equal(
      cli.match(/appendToDebugLogFile\(/g)?.length,
      2,
      "appendToDebugLogFile is not defined and called once",
    );
    assert.match(
      cli,
      /if \(shouldLogToDisk\(\)\) \{\n\s*void appendToDebugLogFile\(messageLevel, message\);\n\s*\}/,
    );
    assert.equal(cli.match(/appendFile\(debugLogFilepath, entry\)/g)?.length, 1);
    assert.equal(
      /(?:writeFile|writeFileSync|appendFileSync|createWriteStream)\(debugLogFilepath/.test(cli),
      false,
    );
    assert.match(source(`infra/scripts/${PROGRAM}`), /\n {2}env\.WRANGLER_WRITE_LOGS = "false";\n/);
  });

  // The database engineer's note a, restated for T-1371's route: the ALTER ROLE runs only inside the temporary
  // function, and the call that runs it is followed at once by statements of the script's own, the last of them the
  // last of its transaction.
  it("each ALTER ROLE is followed at once by one more statement of the script's own, the last of its transaction", () => {
    const lines = source(`infra/scripts/${PROGRAM}`)
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line) && line.trim() !== "");
    const alters = lines.flatMap((line, at) => (/["'`]\s*alter\s+role\b/i.test(line) ? [at] : []));
    // Since T-1371 no statement the script sends holds an ALTER ROLE: the function's body builds it from its
    // parameters, inside the server.
    assert.deepEqual(
      alters.map((at) => lines[at].trim()),
      ["execute pg_catalog.format('alter role %I password %L', login, secret);"],
    );
    const calls = lines.flatMap((line, at) =>
      /\bCALL_TEXT\b/.test(line) && /\brun\(/.test(line) ? [at] : [],
    );
    assert.deepEqual(
      calls.map((at) => lines[at].trim()),
      ['await run("the call", CALL_TEXT, [pair.login, password]);'],
    );
    for (const at of calls) {
      assert.equal(
        lines[at + 1]?.trim(),
        'await run("drop function", DROP_TEXT);',
        "drop function was taken out of its place after the call",
      );
      assert.equal(
        lines[at + 2]?.trim(),
        'await run("the follow-up or commit", "select pg_catalog.pg_backend_pid()::pg_catalog.text as pid");',
        "the statement after the call was taken out or moved",
      );
      assert.equal(
        lines[at + 3]?.trim(),
        "});",
        "the statement after the call is not the last of its transaction",
      );
    }
  });
});

/** Who a password logs in as, straight to the server: the login's name, or the refusal's SQLSTATE. */
async function loginAnswer(login, password) {
  const url = new URL(serverUrl());
  url.username = login;
  url.password = password;
  const client = postgres(url.href, { max: 1, onnotice: () => undefined, connect_timeout: 15 });
  try {
    const [row] = await client`select current_user as who`;
    return String(row.who);
  } catch (error) {
    return String(error?.code);
  } finally {
    await client.end({ timeout: 5 });
  }
}

/** piece 1's file, its four names swapped for the case's own. */
const loginsSql = (names) => swapped(readFileSync(path.join(SCRIPTS, "worker-logins.sql"), "utf8"), names);

// T-1369's verifier tests left with the verifier (T-1371; CQ-225's ruling, DL-733): QA records them in
// tests/QUARANTINE.md. Its login check stays, and so does its test, restated for the call.
describe("create-staging-hyperdrive.sh checks each login with its password before Cloudflare stores it (T-1369)", () => {
  it("a login check the server refuses (28P01) stops the run before the create: Cloudflare is given nothing, and the next login is not touched", async (t) => {
    const rig = checkout(t, "lc");
    const db = await database(rig.names);
    // Both logins made by the maker in their shape, as the run would make them, and the job login's password expired:
    // PostgreSQL then refuses it any password (28P01), whatever its verifier. Piece 1's file finds them as they are.
    await admin.begin(async (tx) => {
      await tx.unsafe(`set local role ${quote(rig.names.maker)}`);
      await tx.unsafe(loginsSql(rig.names));
      await tx.unsafe(`alter role ${quote(rig.names.worker_job)} valid until '2000-01-01'`);
    });
    const stand = await api(rig);
    const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.stderr,
      new RegExp(
        `^create-staging-hyperdrive: refused: the login check of ${rig.names.worker_job} failed \\(28P01\\): .+\\. ${JOB} was not created, so Cloudflare holds no password that cannot log in\\. ${rig.names.worker_job} now holds a password nobody has, so this is safe to repeat: the next run, finding no configuration, sets a fresh one$`,
        "m",
      ),
    );
    assert.deepEqual(stand.posts, [], "the API was called");
    assert.deepEqual(wranglerCalls(rig), ["hyperdrive list", "auth token --json"]);
    // Its password was set through its call and committed, then its check ran as it and was refused, and nothing came
    // after.
    const calls = callsOf(result.sessions);
    assert.deepEqual(
      calls.map((call) => call.login),
      [rig.names.worker_job],
    );
    assert.equal(
      (await shapeOf(rig.names.worker_job))?.has_password,
      true,
      "the job login holds no password",
    );
    assert.deepEqual(
      result.sessions.map((session) => session.user),
      [rig.names.maker, rig.names.worker_job],
    );
    assert.ok(calls[0].at < result.sessions[1].at);
    assert.equal((await shapeOf(rig.names.worker_app))?.has_password, false, "the next login got a password");
    assert.doesNotMatch(result.output, /[0-9a-f]{64}/, "the output holds 64 hex characters");
    assertNothingLeaked(rig, result, db, [calls[0].password], "a refused login check");
  });

  it("beside pg_stat_statements keeping utility statements' text, pgaudit naming role still stops the run before any password (its placeholder set here, after the T-1271 suite's check that none is set)", async (t) => {
    await assertRefusedBesideStatements(
      t,
      "pa",
      true,
      { "pg_stat_statements.track_utility": "on", "pgaudit.log": "role" },
      /pgaudit is loaded and pgaudit\.log is role/,
    );
  });
});

/** Both logins made by the case's maker, as a run makes them: PostgreSQL then grants each back to it WITH ADMIN. */
async function loginsByMaker(names) {
  await admin.begin(async (tx) => {
    await tx.unsafe(`set local role ${quote(names.maker)}`);
    await tx.unsafe(loginsSql(names));
  });
}

/**
 * Runs `during` while another session holds the login's row of pg_authid: an ALTER ROLE of it in a transaction that is
 * rolled back once `during` is done. Returns what `during` gave.
 */
async function whileRowHeld(login, during) {
  const holder = postgres(serverUrl(), { max: 1, onnotice: () => undefined, connect_timeout: 15 });
  const done = new Error("rolled back on purpose");
  let result;
  try {
    await holder.begin(async (tx) => {
      await tx.unsafe(`alter role ${quote(login)} valid until 'infinity'`);
      result = await during();
      throw done;
    });
  } catch (error) {
    if (error !== done) throw error;
  } finally {
    await holder.end({ timeout: 5 });
  }
  return result;
}

/**
 * A database of the case's own (T-1371), made by the superuser from template1 and dropped after the case: its name and
 * a superuser client on it.
 */
async function ownDatabase(t, rig, part) {
  const name = `${rig.names.maker.slice(0, -"_maker".length)}_${part}`;
  await admin.unsafe(`create database ${quote(name)}`);
  const url = new URL(serverUrl());
  url.pathname = `/${name}`;
  const client = postgres(url.href, { max: 1, onnotice: () => undefined, connect_timeout: 15 });
  t.after(async () => {
    await client.end({ timeout: 5 });
    await admin.unsafe(`drop database if exists ${quote(name)} with (force)`);
  });
  return { name, client };
}

/**
 * rosie-pg's own log since `since` (`docker compose -f infra/docker-compose.yml logs rosie-pg`), read again for up to 5
 * seconds until it holds `expected`; or null where the server is not that container (CI's DATABASE_URL names a
 * service of its own, whose log no test reads).
 */
async function serverLog(since, expected) {
  if (serverUrl() !== LOCAL_URL) return null;
  const docker = program("docker");
  for (let tries = 0; ; tries += 1) {
    const read = spawnSync(
      docker,
      [
        "compose",
        "-f",
        path.join(REPO, "infra", "docker-compose.yml"),
        "logs",
        "--no-color",
        "--since",
        since,
        "rosie-pg",
      ],
      { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
    );
    assert.equal(read.status, 0, `docker compose logs rosie-pg ended ${String(read.status)}`);
    const text = `${read.stdout}${read.stderr}`;
    if (text.includes(expected) || tries >= 10) return text;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

describe("create-staging-hyperdrive.sh gives PostgreSQL each password only as the second bound value of one call of a temporary function that runs ALTER ROLE inside the server (T-1371; CQ-225's ruling, DL-733)", () => {
  const refusedForLogging =
    /^create-staging-hyperdrive: refused: this session would write the ALTER ROLE's text, password included, to the server log or keep it: .*No password was made \(ADR-014, open question 3\)$/m;

  /** Fails unless a run was refused at step 4: one connection, no token, no login made, no call, no create. */
  async function assertRefusedAtStep4(rig, stand, db, result, title) {
    assert.equal(result.status, 1, `${title}: ${result.output}`);
    assert.equal(result.connections, 1, `${title}: its connections`);
    assert.deepEqual(wranglerCalls(rig), ["hyperdrive list"], `${title}: its wrangler calls`);
    assert.equal(callsOf(result.sessions).length, 0, `${title}: a password was sent`);
    await assertNoPassword(stand, rig.names, result, title);
    assert.equal(await shapeOf(rig.names.worker_job), null, `${title}: a login was made`);
    assertNothingLeaked(rig, result, db, [], title);
  }

  /** The faults a step-4 refusal names: exactly one when a stop rule stands alone. */
  const faultsNamed = (stderr) =>
    (/keep it: (.*)\. No password was made \(ADR-014, open question 3\)$/m.exec(stderr)?.[1] ?? "").split(
      "; ",
    );

  it("a: the route sets each password: a connection as the login with it answers current_user as that login, a wrong one gets 28P01, and every role of the case is dropped after", async (t) => {
    const rig = checkout(t, "ra");
    const db = await database(rig.names);
    const stand = await api(rig);
    const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
    assert.equal(result.status, 0, result.output);
    const passwords = stand.creates().map((body) => body.origin.password);
    assert.equal(passwords.length, 2);
    for (const [index, login] of [rig.names.worker_job, rig.names.worker_app].entries()) {
      const password = passwords[index];
      assert.equal(await loginAnswer(login, password), login, `${login}: its password does not log in`);
      const wrong = `${password.slice(0, -1)}${password.endsWith("0") ? "1" : "0"}`;
      assert.equal(await loginAnswer(login, wrong), "28P01", `${login}: a wrong password was taken`);
      // Stored by the server in its own form (password_encryption), never as the text it was given.
      const secret = String(await secretOf(login));
      assert.match(secret, /^SCRAM-SHA-256\$/);
      assert.equal(secret.includes(password), false, `${login}: stored as given`);
    }
    // Every role of the case dropped: the two logins, the two stand-in roles and the maker.
    for (const role of [
      rig.names.worker_job,
      rig.names.worker_app,
      rig.names.job,
      rig.names.app,
      rig.names.maker,
    ]) {
      await admin.unsafe(`drop owned by ${quote(role)}`);
      await admin.unsafe(`drop role ${quote(role)}`);
    }
    const [{ left }] =
      await admin`select count(*)::int as left from pg_roles where starts_with(rolname, ${`${RUN}ra_`})`;
    assert.equal(left, 0, "a role of the case was left");
  });

  it("b and e: each password is on the run's own connection once, as the second value of one Bind after its call's Parse, and in no Parse, Query or other message; never on a login check's connection; in the stand-in API only in its own create's body; in no output, argument, environment or file; each transaction sets plan_cache_mode and lock_timeout, reads them back, then makes, calls and drops the function", async (t) => {
    const rig = checkout(t, "rb");
    const db = await database(rig.names);
    const stand = await api(rig);
    const result = await rig.run(stand, {
      env: { STAGING_DATABASE_URL: db.url, DATABASE_URL: db.url, ...DECOYS },
    });
    assert.equal(result.status, 0, result.output);
    const passwords = stand.creates().map((body) => body.origin.password);
    assert.equal(passwords.length, 2);
    const logins = [rig.names.worker_job, rig.names.worker_app];
    const [own, ...checks] = result.sessions;
    assert.deepEqual(
      result.sessions.map((session) => session.user),
      [rig.names.maker, ...logins],
    );
    // Sessions are compared by their place, never whole: a failing deepEqual of their recorded bytes would build a
    // diff too large to print.
    const calls = callsOf(result.sessions);
    assert.deepEqual(
      calls.map((call) => [call.login, result.sessions.indexOf(call.session)]),
      logins.map((login) => [login, 0]),
    );
    for (const [index, password] of passwords.entries()) {
      const call = calls[index];
      // The run's own connection: the password's bytes once, as the second of the call's two bound values.
      assert.equal(countIn(bytesOf(own), password), 1, `${logins[index]}: not once on the run's connection`);
      assert.equal(call.values.length, 2);
      assert.equal(call.password, password);
      assert.deepEqual(
        own.messages.flatMap((sent, at) => (sent.body.includes(password) ? [at] : [])),
        [own.messages.indexOf(call.bind)],
        `${logins[index]}: a message other than its call's Bind holds its password`,
      );
      assert.equal(textOf(call.parse), CALL);
      // Never on a login check's connection.
      for (const check of checks) {
        assert.equal(bytesOf(check).includes(password), false, `${check.user}'s check: a password`);
      }
      // The API: its own create's body, once, as origin.password; no other body, address or header.
      const post = stand.posts[index];
      assert.equal(post.text.split(password).length - 1, 1, `create ${String(index)}: its password not once`);
      assert.equal(JSON.parse(post.text).origin.password, password);
      for (const other of stand.posts) {
        if (other !== post)
          assert.equal(other.text.includes(password), false, "a body holds another password");
        assert.equal(other.url.includes(password), false, "an address holds a password");
        assert.equal(other.headers.includes(password), false, "a header holds a password");
      }
    }
    // Each password's transaction, in order: begin; the session read again; plan_cache_mode and lock_timeout set
    // for the transaction and read back; the function made; the call; the function dropped; one more statement; commit.
    const texts = queriesOf(own).map((query) => query.text);
    const begins = texts.flatMap((text, at) => (/^begin\s*$/.test(text) ? [at] : []));
    assert.equal(begins.length, 2, "not one transaction for each password");
    const steps = [
      /^begin\s*$/,
      /^select\s+pg_catalog\.current_setting\('log_statement'\) as log_statement,/,
      /^set local plan_cache_mode = force_generic_plan$/,
      /^set local lock_timeout = '500ms'$/,
      /^select\s+pg_catalog\.current_setting\('plan_cache_mode'\) as plan_cache_mode,/,
      new RegExp(
        `^create function pg_temp\\.${String(FUNCTION)}\\(login text, secret text\\) returns void\\nlanguage plpgsql set search_path = pg_catalog as \\$body\\$\\n`,
      ),
      new RegExp(`^${CALL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      new RegExp(`^drop function pg_temp\\.${String(FUNCTION)}\\(text, text\\)$`),
      /^select pg_catalog\.pg_backend_pid\(\)::pg_catalog\.text as pid$/,
      /^commit$/,
    ];
    for (const at of begins) {
      const sent = texts.slice(at, at + steps.length);
      assert.equal(sent.length, steps.length);
      for (const [index, step] of steps.entries()) assert.match(sent[index], step);
    }
    // The function's text holds no value: neither login, no password; its handler raises the script's own words.
    const made = texts.filter((text) => text.startsWith("create function"));
    assert.equal(made.length, 2);
    for (const text of made) {
      for (const value of [...passwords, ...logins]) {
        assert.equal(text.includes(value), false, "the function's text holds a value");
      }
      assert.ok(
        text.includes(
          `\n  execute pg_catalog.format('alter role %I password %L', login, secret);\nexception\n  when others or query_canceled then\n    raise exception using errcode = sqlstate, message = '${String(FUNCTION_FAULT)}';\nend\n`,
        ),
        text,
      );
    }
    // e: what each transaction read back, as printed.
    for (const login of logins) {
      assert.ok(
        result.stdout.includes(
          `\ncreate-staging-hyperdrive: ${login}: its transaction held plan_cache_mode force_generic_plan and lock_timeout 500 ms, below deadlock_timeout 1000 ms\n`,
        ),
        result.stdout,
      );
    }
    assertNothingLeaked(rig, result, db, passwords, "recorded");
  });

  it("c: ALTER ROLE refused inside the function (42501: the maker's ADMIN on the login revoked) or cancelled there (57014: statement_timeout while another session holds the login's row) stops the run before the login check and the create, with nothing set and no function left; no field of the server's error, no printed line and no line of rosie-pg's own log holds the password", async (t) => {
    const since = new Date(Date.now() - 60_000).toISOString();
    const outcomes = [];

    // 42501: the logins made by the maker, then the grant that gave it ADMIN on the job login taken back.
    const refused = checkout(t, "ca");
    const refusedDb = await database(refused.names);
    await loginsByMaker(refused.names);
    await admin.unsafe(`revoke ${quote(refused.names.worker_job)} from ${quote(refused.names.maker)}`);
    const [{ admins }] = await admin`
      select count(*)::int as admins from pg_auth_members m
      where m.roleid = (select oid from pg_roles where rolname = ${refused.names.worker_job})
        and m.member = (select oid from pg_roles where rolname = ${refused.names.maker}) and m.admin_option`;
    assert.equal(admins, 0, "the maker still holds ADMIN on the job login");
    const refusedApi = await api(refused);
    outcomes.push({
      rig: refused,
      db: refusedDb,
      stand: refusedApi,
      code: "42501",
      result: await refused.run(refusedApi, { env: { STAGING_DATABASE_URL: refusedDb.url } }),
    });

    // 57014: a statement_timeout of 3 s, below the 10 s lock_timeout the script sets from a deadlock_timeout of 20 s,
    // while another session holds the job login's row.
    const cancelled = checkout(t, "cc");
    const cancelledDb = await database(cancelled.names, {
      settings: { statement_timeout: "3s", deadlock_timeout: "20s" },
    });
    await loginsByMaker(cancelled.names);
    const cancelledApi = await api(cancelled);
    outcomes.push({
      rig: cancelled,
      db: cancelledDb,
      stand: cancelledApi,
      code: "57014",
      result: await whileRowHeld(cancelled.names.worker_job, () =>
        cancelled.run(cancelledApi, { env: { STAGING_DATABASE_URL: cancelledDb.url } }),
      ),
    });

    const passwords = [];
    for (const { rig, db, stand, code, result } of outcomes) {
      assert.equal(result.status, 1, `${code}: ${result.output}`);
      // The line printed: the SQLSTATE and the script's own words only.
      assert.match(
        result.stderr,
        new RegExp(
          `^create-staging-hyperdrive: refused: ${rig.names.worker_job}'s password was not set \\(${code}, at the call; the server's own words are not shown\\)\\. Its transaction rolled back, so nothing was set and no function is left, and Cloudflare was given nothing\\. Nothing is tried again, and the password is never put in a statement's text$`,
          "m",
        ),
      );
      // Before the login check and the create: no connection as either login, no create, one call and no other try.
      assert.deepEqual(stand.posts, [], `${code}: the API was called`);
      assert.deepEqual(
        result.sessions.map((session) => session.user),
        [rig.names.maker],
        `${code}: a login check ran`,
      );
      const [own] = result.sessions;
      const calls = callsOf(result.sessions);
      assert.deepEqual(
        calls.map((call) => call.login),
        [rig.names.worker_job],
        `${code}: not one call`,
      );
      const { password } = calls[0];
      assert.match(password, /^[0-9a-f]{64}$/);
      passwords.push(password);
      // Nothing set: neither login holds a password. No function left: after the call its transaction rolled back,
      // with no drop and no commit, and no function of that name is on the server.
      for (const login of [rig.names.worker_job, rig.names.worker_app]) {
        assert.equal((await shapeOf(login))?.has_password, false, `${code}: ${login} holds a password`);
      }
      assert.deepEqual(
        queriesOf(own)
          .filter((query) => query.at > calls[0].at)
          .map((query) => query.text),
        ["rollback"],
        `${code}: after the call`,
      );
      const [{ functions }] =
        await admin`select count(*)::int as functions from pg_proc where proname = ${String(FUNCTION)}`;
      assert.equal(functions, 0, `${code}: a function is left`);
      // The server's error: no field of any error holds the password (without the handler, the context, W, would);
      // the call's holds the caught SQLSTATE and the function's own words.
      const errors = errorsOf(own);
      for (const error of errors) {
        for (const [field, value] of Object.entries(error.fields)) {
          assert.equal(
            value.includes(password),
            false,
            `${code}: the error's field ${field} holds the password`,
          );
        }
      }
      const raised = errors.find((error) => error.at > calls[0].at);
      assert.ok(raised, `${code}: no error answered the call`);
      assert.equal(raised.fields.C, code);
      assert.equal(raised.fields.M, FUNCTION_FAULT);
      assert.equal(result.output.includes(password), false, `${code}: a printed line holds the password`);
      assertNothingLeaked(rig, result, db, [password], code);
    }

    // rosie-pg's own log: it holds the function's words, and neither password.
    const log = await serverLog(since, String(FUNCTION_FAULT));
    if (log === null) {
      t.diagnostic("rosie-pg's own log was not read: the server is DATABASE_URL's, not the local container");
    } else {
      assert.ok(log.includes(String(FUNCTION_FAULT)), "rosie-pg's log does not hold the function's error");
      for (const password of passwords) {
        assert.equal(log.includes(password), false, "rosie-pg's own log holds a password");
      }
    }
  });

  it("e: a wait on the login's row inside the function is cancelled by the transaction's lock_timeout (half of deadlock_timeout: 55P03), before deadlock_timeout, after which a lock wait could be logged", async (t) => {
    const rig = checkout(t, "le");
    const db = await database(rig.names, { settings: { deadlock_timeout: "4s" } });
    await loginsByMaker(rig.names);
    const stand = await api(rig);
    const result = await whileRowHeld(rig.names.worker_job, () =>
      rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } }),
    );
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.stderr,
      new RegExp(
        `^create-staging-hyperdrive: refused: ${rig.names.worker_job}'s password was not set \\(55P03, at the call; `,
        "m",
      ),
    );
    const [own] = result.sessions;
    const calls = callsOf(result.sessions);
    assert.equal(calls.length, 1);
    const texts = queriesOf(own).map((query) => query.text);
    assert.ok(texts.includes("set local lock_timeout = '2000ms'"), texts.join("\n"));
    const raised = errorsOf(own).find((error) => error.at > calls[0].at);
    assert.equal(raised?.fields.C, "55P03");
    assert.equal(raised?.fields.M, FUNCTION_FAULT);
    const waited = raised.time - calls[0].time;
    assert.ok(waited >= 1900 && waited < 4000, `the wait lasted ${String(waited)} ms`);
    assert.deepEqual(stand.posts, []);
    for (const login of [rig.names.worker_job, rig.names.worker_app]) {
      assert.equal((await shapeOf(login))?.has_password, false, `${login} holds a password`);
    }
    assertNothingLeaked(rig, result, db, [calls[0].password], "lock_timeout");
  });

  // d: each new stop rule alone. [case, title, the maker's settings (placeholders where the test server has no such
  // module), what the refusal names]
  const ALONE = [
    [
      "da",
      "pg_stat_statements.track all",
      { "pg_stat_statements.track": "all" },
      /^pg_stat_statements\.track is all \(it keeps the text of the statements a function runs/,
    ],
    [
      "db",
      "auto_explain.log_min_duration 0",
      { "auto_explain.log_min_duration": "0" },
      /^auto_explain\.log_min_duration is 0 \(auto_explain would log the call's plan and values\)$/,
    ],
    [
      "dc",
      "a pg_stat_monitor setting",
      { "pg_stat_monitor.pgsm_track": "top" },
      /^pg_stat_monitor or pg_store_plans is there \(pg_stat_monitor\.pgsm_track\)/,
    ],
    [
      "dd",
      "a pg_store_plans setting",
      { "pg_store_plans.track": "top" },
      /^pg_stat_monitor or pg_store_plans is there \(pg_store_plans\.track\)/,
    ],
    ["de", "log_statement_stats on", { log_statement_stats: "on" }, /^log_statement_stats is on \(/],
    ["df", "log_parser_stats on", { log_parser_stats: "on" }, /^log_parser_stats is on \(/],
    ["dg", "log_planner_stats on", { log_planner_stats: "on" }, /^log_planner_stats is on \(/],
    ["dh", "log_executor_stats on", { log_executor_stats: "on" }, /^log_executor_stats is on \(/],
    [
      "di",
      'pgaudit.log "read"',
      { "pgaudit.log": "read" },
      /^pgaudit is loaded and pgaudit\.log is read \(any class but none could log the call/,
    ],
    [
      "dj",
      'pgaudit.log "READ, write, Function, misc, misc_set, -role" (which T-1271 let run)',
      { "pgaudit.log": "READ, write, Function, misc, misc_set, -role" },
      /^pgaudit is loaded and pgaudit\.log is READ, write, Function, misc, misc_set, -role \(any class but none/,
    ],
    [
      "dk",
      "pgaudit.log_parameter on (pgaudit.log none)",
      { "pgaudit.log": "none", "pgaudit.log_parameter": "on" },
      /^pgaudit\.log_parameter is on \(pgaudit would log the call's bound values\)$/,
    ],
  ];
  for (const [caseName, title, settings, reason] of ALONE) {
    it(`d: ${title}, alone, stops the run before any password`, async (t) => {
      const rig = checkout(t, caseName);
      const db = await database(rig.names, { settings });
      const stand = await api(rig);
      const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
      assert.match(result.stderr, refusedForLogging);
      const named = faultsNamed(result.stderr);
      assert.equal(named.length, 1, `${title}: ${named.join(" | ")}`);
      assert.match(named[0], reason);
      await assertRefusedAtStep4(rig, stand, db, result, title);
    });
  }

  // [case, the setting, what the script sets it to, what the proxy turns that SET into, what the refusal names: the
  // value as current_setting shows it, with its unit]
  for (const [caseName, setting, from, to, reason] of [
    [
      "dl",
      "log_parameter_max_length_on_error",
      "0",
      "64",
      /^log_parameter_max_length_on_error is 64B after this session set it to 0 \(/,
    ],
    ["dm", "debug_print_plan", "off", "on", /^debug_print_plan is on \(each plan is logged\)$/],
  ]) {
    it(`d: ${setting} reading ${to} after the script's own SET stops the run before any password (the proxy turns that SET into ${to}, as on a server where it does not hold)`, async (t) => {
      const rig = checkout(t, caseName);
      const db = await database(rig.names);
      const stand = await api(rig);
      let turned = 0;
      shared.hook = (session, sent) => {
        if (session.user !== rig.names.maker || textOf(sent) !== `set ${setting} = '${from}'`)
          return undefined;
        turned += 1;
        return message("Q", cstring(`set ${setting} = '${to}'`));
      };
      t.after(() => {
        shared.hook = undefined;
      });
      const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
      shared.hook = undefined;
      assert.equal(turned, 1, `the script's SET of ${setting} was not seen once`);
      assert.match(result.stderr, refusedForLogging);
      const named = faultsNamed(result.stderr);
      assert.equal(named.length, 1, named.join(" | "));
      assert.match(named[0], reason);
      await assertRefusedAtStep4(rig, stand, db, result, setting);
    });
  }

  it("d: a database where the maker has no TEMPORARY privilege, or with no plpgsql, stops the run before any password (each a database the test makes for itself)", async (t) => {
    for (const [caseName, part, change, reason, line] of [
      [
        "dt",
        "notemp",
        (own) => admin.unsafe(`revoke temporary on database ${quote(own.name)} from public`),
        "this role has no TEMPORARY privilege on its database (the function lives in pg_temp)",
        "TEMPORARY on its database no, plpgsql usable",
      ],
      [
        "dp",
        "noplpgsql",
        (own) => own.client.unsafe("drop extension plpgsql"),
        "plpgsql is not in its database",
        "TEMPORARY on its database yes, plpgsql not in its database",
      ],
    ]) {
      const rig = checkout(t, caseName);
      const own = await ownDatabase(t, rig, part);
      await change(own);
      const db = await database(rig.names, { databaseName: own.name });
      const stand = await api(rig);
      const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
      assert.ok(
        result.stdout.includes(`\ncreate-staging-hyperdrive: this session's temporary function: ${line}\n`),
        result.stdout,
      );
      assert.ok(
        result.stderr.includes(
          `create-staging-hyperdrive: refused: this session cannot make the temporary function that sets each password: ${reason}. No password was made\n`,
        ),
        result.stderr,
      );
      await assertRefusedAtStep4(rig, stand, db, result, part);
    }
  });

  it("d: a login whose shape changes after its password's commit (a second membership, granted by another session) stops the run before its login check and its create", async (t) => {
    const rig = checkout(t, "ws");
    const db = await database(rig.names);
    const stand = await api(rig);
    let committed = false;
    let granted = false;
    // The first statement after the job login's commit is held until the grant is in: it is the shape's re-read.
    shared.hook = async (session, sent) => {
      const text = textOf(sent);
      if (session.user !== rig.names.maker || text === null || granted) return undefined;
      if (text === "commit" && callsOf([session]).length > 0) committed = true;
      else if (committed) {
        granted = true;
        await admin.unsafe(`grant pg_read_all_data to ${quote(rig.names.worker_job)}`);
      }
      return undefined;
    };
    t.after(() => {
      shared.hook = undefined;
    });
    const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
    shared.hook = undefined;
    assert.equal(granted, true, "the statement after the commit was not seen");
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.stderr,
      new RegExp(
        `^create-staging-hyperdrive: refused: ${rig.names.worker_job} is not in its shape after its password's commit: its memberships are pg_read_all_data \\(inherit true, set true, admin false\\), ${rig.names.job} \\(inherit true, set false, admin false\\) where its one is ${rig.names.job} \\(inherit true, set false, admin false\\)\\. ${JOB} was not created, and Cloudflare was given nothing; the login is left as it is \\(never repaired here\\)$`,
        "m",
      ),
    );
    assert.deepEqual(stand.posts, [], "the API was called");
    assert.deepEqual(
      result.sessions.map((session) => session.user),
      [rig.names.maker],
      "a login check ran",
    );
    const calls = callsOf(result.sessions);
    assert.deepEqual(
      calls.map((call) => call.login),
      [rig.names.worker_job],
    );
    assert.equal((await shapeOf(rig.names.worker_job))?.has_password, true);
    assert.equal((await shapeOf(rig.names.worker_app))?.has_password, false, "the next login got a password");
    assertNothingLeaked(rig, result, db, [calls[0].password], "a shape changed after the commit");
  });

  it("d: a readable pg_stat_statements view (a stand-in, in a database of the test's own) whose kept texts name each login without its password prints 0 and goes on; one that keeps a text holding the password stops the run after the login check and before the create", async (t) => {
    const quiet = checkout(t, "k0");
    const own = await ownDatabase(t, quiet, "kept");
    await own.client.unsafe("create table public.t1371_kept (query text not null)");
    await own.client.unsafe(
      "create view public.pg_stat_statements as select k.query from public.t1371_kept k",
    );
    await own.client.unsafe("grant select on public.pg_stat_statements to public");
    // On each call's Bind, before it reaches the server: the text a pg_stat_statements tracking all statements would
    // keep of the ALTER ROLE the function runs, with the password, or with other words in its place.
    const keeping = (maker, withPassword) => async (session, sent) => {
      if (session.user !== maker || sent.type !== "B") return undefined;
      const call = callsOf([session]).find((each) => each.bind === sent);
      if (call === undefined) return undefined;
      const secret = withPassword ? call.password : "not-the-password";
      await own.client.unsafe("insert into public.t1371_kept (query) values ($1)", [
        `alter role ${String(call.login)} password '${String(secret)}'`,
      ]);
      return undefined;
    };
    t.after(() => {
      shared.hook = undefined;
    });

    const quietDb = await database(quiet.names, { databaseName: own.name });
    const quietApi = await api(quiet);
    shared.hook = keeping(quiet.names.maker, false);
    const ran = await quiet.run(quietApi, { env: { STAGING_DATABASE_URL: quietDb.url } });
    shared.hook = undefined;
    assert.equal(ran.status, 0, ran.output);
    for (const login of [quiet.names.worker_job, quiet.names.worker_app]) {
      assert.ok(
        ran.stdout.includes(
          `\ncreate-staging-hyperdrive: ${login}: kept texts in pg_stat_statements that hold its password: 0\n`,
        ),
        ran.stdout,
      );
    }
    assert.equal(quietApi.creates().length, 2);

    const rig = checkout(t, "k1");
    const db = await database(rig.names, { databaseName: own.name });
    const stand = await api(rig);
    shared.hook = keeping(rig.names.maker, true);
    const result = await rig.run(stand, { env: { STAGING_DATABASE_URL: db.url } });
    shared.hook = undefined;
    assert.equal(result.status, 1, result.output);
    assert.ok(
      result.stdout.includes(
        `\ncreate-staging-hyperdrive: ${rig.names.worker_job}: kept texts in pg_stat_statements that hold its password: 1\n`,
      ),
      result.stdout,
    );
    assert.match(
      result.stderr,
      new RegExp(
        `^create-staging-hyperdrive: refused: pg_stat_statements keeps 1 text\\(s\\) that hold ${rig.names.worker_job}'s password \\(none is shown\\): ${JOB} was not created, and Cloudflare was given nothing\\. This goes back to the architect and the security reviewer \\(CQ-225\\) before any other run$`,
        "m",
      ),
    );
    assert.deepEqual(stand.posts, [], "the API was called");
    // Its login check ran before the count, and nothing after it; the count sent the login, never the password.
    assert.deepEqual(
      result.sessions.map((session) => session.user),
      [rig.names.maker, rig.names.worker_job],
    );
    const calls = callsOf(result.sessions);
    assert.equal(calls.length, 1);
    assert.equal(countIn(bytesOf(result.sessions[0]), calls[0].password), 1, "the password was sent again");
    assertNothingLeaked(rig, result, db, [calls[0].password], "a kept text holding the password");
  });
});
