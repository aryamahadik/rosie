// Tests for infra/scripts/post-deploy-check.sh (factory spec 3 and 6; D-000 check 5; T-1321), run in ci.yml by
// `node --test "infra/ci/*.test.mjs"`. Fake curl and sleep commands (script-harness.mjs) answer or fail each
// request and record its --max-time and each pause, without any network or waiting, so the time a failing
// check can take is computed from what the script asked for. The check's one form POST (T-1321: T-1237's host rule
// on the edge, its security review's note b) goes to a curl stand-in of this file's own, which records it as the fake
// curl records a call and answers it as FAKE_POST says; it hands every other request to the fake curl as it is.
// The JOIN step (T-570: --join; DL-789's R6, ruled; DL-757) is tested against a stand-in for staging's Worker on this
// machine (stubWorker, below): the real curl reaches it, so each page call's body, which holds the check tester's
// token, is read as the Worker would read it, while a fake sleep records the poll's pause. Those runs use a throwaway
// checkout of their own (joinRig), so no test reads this checkout's .dev.vars, and every token is made up at random.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { describe, it } from "node:test";

import { releaseRoot } from "./release-harness.mjs";
import {
  REPO,
  SCRIPTS,
  cleanEnv,
  copyScript,
  fakeTools,
  namedIn,
  program,
  readLog,
  spies,
  tempDir,
  whereHeld,
  write,
} from "./script-harness.mjs";

const CHECK = path.join(SCRIPTS, "post-deploy-check.sh");
const BASE_URL = "https://rosie-staging.example.workers.dev/test";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** wrangler.jsonc as wrangler reads it: comments and trailing commas dropped outside strings. */
function readWranglerConfig() {
  const text = readFileSync(path.join(REPO, "wrangler.jsonc"), "utf8");
  let json = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      json += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("wrangler.jsonc: a /* comment is not closed");
      i = end + 1;
    } else if (c === "}" || c === "]") {
      json = json.replace(/,\s*$/, "") + c;
    } else {
      json += c;
    }
  }
  return JSON.parse(json);
}

/** This site's own origin, as the Worker builds it (web/src/shell/post-guard.ts siteOrigin): https:// + LINK_HOST. */
const SITE_ORIGIN = `https://${readWranglerConfig().env.staging.vars.LINK_HOST}`;

/** The sign-in form's path, where route auth.signIn takes a POST (web/src/auth/pages.ts SIGN_IN_PATH). */
const SIGN_IN_PATH = /^export const SIGN_IN_PATH = "([^"]+)";$/m.exec(
  readFileSync(path.join(REPO, "web", "src", "auth", "pages.ts"), "utf8"),
)?.[1];

/** The words on every page the stand-in answers the POST with: no output of the check may hold them. */
const PAGE_WORDS = "dummy-page-words";

// The curl stand-in (CommonJS). argv: <the fake curl> <curl's arguments...>. A request with --request POST is one line
// in $FAKE_LOG, as the fake curl records a call, and is answered as FAKE_POST says:
//   guard (the default)  the 403 from the guard: HTTP 403, the x-trace-id sent in the header and shown on the page;
//   edge-403             a 403 that is not the Worker's: no x-trace-id, and a page of the edge's own;
//   no-reference         HTTP 403 with the x-trace-id sent, on a page that does not show it;
//   <status>             that status (200, 302, 404, 405, 413, 500, 503), the x-trace-id sent, and a page;
//   none                 no answer: curl's timeout (exit 28).
// Every page holds PAGE_WORDS. Any other request goes to the fake curl with the same arguments.
const CURL_STAND_IN = String.raw`"use strict";
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const [fakeCurl, ...args] = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
if (valueOf("--request") !== "POST") {
  const run = spawnSync(fakeCurl, args, { stdio: "inherit" });
  process.exit(run.status === null ? 1 : run.status);
}
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: "curl", args, cwd: process.cwd(), env: {} }) + "\n");
const answer = process.env.FAKE_POST || "guard";
if (answer === "none") {
  process.stderr.write("curl: (28) Operation timed out after 3002 milliseconds with 0 bytes received\n");
  process.exit(28);
}
const sent = args
  .filter((_, i) => args[i - 1] === "--header")
  .map((header) => /^x-trace-id:\s*(\S+)$/i.exec(header))
  .filter((match) => match !== null)
  .map((match) => match[1])[0];
const status = ["guard", "edge-403", "no-reference"].includes(answer) ? 403 : Number(answer);
let headers = "HTTP/2 " + status + "\r\ncontent-type: text/html; charset=utf-8\r\n";
if (answer !== "edge-403") headers += "x-trace-id: " + sent + "\r\n";
if (status === 302) headers += "location: https://example.invalid/test/sign-in\r\n";
const shown = answer === "edge-403" || answer === "no-reference" ? "" : "<p>Reference: <code>" + sent + "</code></p>";
fs.writeFileSync(valueOf("--output"), "<!doctype html><h1>${PAGE_WORDS}</h1>" + shown);
fs.writeFileSync(valueOf("--dump-header"), headers + "\r\n");
process.stdout.write(String(status));
`;

/** Puts the curl stand-in at <dir>/bin/curl, over the fake curl at <dir>/harness/curl. */
function useStandIn(dir) {
  const fakeCurl = path.join(dir, "harness", "curl");
  fakeTools(dir)(fakeCurl, "curl");
  const standIn = path.join(dir, "fake", "curl-stand-in.cjs");
  write(standIn, CURL_STAND_IN);
  write(
    path.join(dir, "bin", "curl"),
    `#!/usr/bin/env bash\nexec "${process.execPath}" "${standIn}" "${fakeCurl}" "$@"\n`,
    0o755,
  );
}

/** True for the check's POST: a curl call with --request POST. */
function isPost(call) {
  const at = call.args.indexOf("--request");
  return at >= 0 && call.args[at + 1] === "POST";
}

/** The values a curl call gave one flag, in order. */
const valuesOf = (call, flag) => call.args.filter((_, at) => call.args[at - 1] === flag);

/** The value of the header a curl call sent under `name`, or undefined. */
const headerOf = (call, name) =>
  valuesOf(call, "--header")
    .find((header) => header.toLowerCase().startsWith(`${name}:`))
    ?.replace(/^[^:]+:\s*/, "");

/** The address a curl call asked for: its last argument. */
const addressOf = (call) => call.args[call.args.length - 1];

/** `text` as a regular expression that matches it alone. */
const literally = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function check(t, extra = {}, base = BASE_URL) {
  const dir = tempDir(t, "check");
  useStandIn(dir);
  fakeTools(dir)(path.join(dir, "bin", "sleep"), "sleep");
  const home = path.join(dir, "home");
  write(path.join(home, ".keep"), "");
  const log = path.join(dir, "calls.ndjson");
  const result = spawnSync("bash", [CHECK, base], {
    encoding: "utf8",
    env: cleanEnv(home, { PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, FAKE_LOG: log, ...extra }),
  });
  const calls = readLog(log);
  const requests = calls.filter((call) => call.tool === "curl");
  const gets = requests.filter((call) => !isPost(call));
  const posts = requests.filter(isPost);
  const pauses = calls.filter((call) => call.tool === "sleep").map((call) => Number(call.args[0]));
  const maxTimes = requests.map((call) => Number(call.args[call.args.indexOf("--max-time") + 1]));
  const worstCaseSeconds = [...maxTimes, ...pauses].reduce((sum, seconds) => sum + seconds, 0);
  const output = `${result.stdout}${result.stderr}`;
  return { ...result, output, requests, gets, posts, pauses, maxTimes, worstCaseSeconds };
}

describe("post-deploy-check.sh", () => {
  it("with the defaults, a failing check gives up within about 60 seconds (check 5's rollback)", (t) => {
    const result = check(t, { FAKE_CURL_MODE: "fail" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /check failed/);
    assert.ok(result.requests.length >= 3, `only ${result.requests.length} attempts`);
    const retrying = result.pauses.reduce((sum, seconds) => sum + seconds, 0);
    assert.ok(retrying >= 20, `a deployment that is still spreading gets only ${retrying} s of retries`);
    assert.ok(
      result.worstCaseSeconds <= 60,
      `worst case ${result.worstCaseSeconds} s: max times ${result.maxTimes.join(",")}, pauses ${result.pauses.join(",")}`,
    );
  });

  it("takes the attempts and the request timeout from CHECK_ATTEMPTS and CHECK_TIMEOUT_S", (t) => {
    const result = check(t, { FAKE_CURL_MODE: "fail", CHECK_ATTEMPTS: "3", CHECK_TIMEOUT_S: "2" });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.maxTimes, [2, 2, 2]);
    assert.equal(result.pauses.length, 2, "a pause between attempts, none after the last");
  });

  it("caps all requests of both checks together at CHECK_ATTEMPTS", (t) => {
    // health passes on the third request; the traced request still gets one attempt, and no more. The host rule's
    // one POST (T-1321) comes after them, outside CHECK_ATTEMPTS.
    const result = check(t, { FAKE_CURL_FAILS: "2", CHECK_ATTEMPTS: "3", CHECK_TIMEOUT_S: "1" });
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    assert.equal(result.gets.length, 4);
    assert.equal(result.posts.length, 1);
  });

  it("passes a healthy deployment: health, then one traced request whose trace id comes back", (t) => {
    const result = check(t, { FAKE_CURL_MODE: "ok", EXPECT_VERSION: "abc123", FAKE_VERSION: "abc123" });
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    assert.equal(result.gets.length, 2);
    assert.equal(result.posts.length, 1, "then the host rule's one POST (T-1321)");
    const traced = result.gets[1].args;
    const header = traced[traced.indexOf("--header") + 1];
    const traceId = header.replace(/^x-trace-id:\s*/, "");
    assert.match(traceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.match(result.stdout, new RegExp(`^trace_id=${traceId}$`, "m"));
    assert.deepEqual(result.pauses, []);
  });

  it("fails a deployment that reports another version", (t) => {
    const result = check(t, {
      FAKE_CURL_MODE: "ok",
      EXPECT_VERSION: "abc123",
      FAKE_VERSION: "old999",
      CHECK_ATTEMPTS: "2",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /version old999, expected abc123/);
  });

  for (const [name, value] of [
    ["CHECK_ATTEMPTS", "0"],
    ["CHECK_ATTEMPTS", "many"],
    ["CHECK_TIMEOUT_S", "0"],
    ["CHECK_TIMEOUT_S", "1.5"],
  ]) {
    it(`refuses ${name}=${value}`, (t) => {
      const result = check(t, { FAKE_CURL_MODE: "ok", [name]: value });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(name));
      assert.deepEqual(result.requests, [], "no request is made");
    });
  }
});

// T-1321 (T-1237's security review, note b; DL-601): the unit tests of the host rule parse each address with Node's
// URL parser, so only a live request shows that Cloudflare's edge hands the Worker the workers.dev host. After the
// GETs, the check sends one form POST to the sign-in route at the workers.dev base address, from this site's own
// origin, and only the 403 from the guard passes it.
describe("post-deploy-check.sh: one form POST to the workers.dev address must answer the 403 from the guard (T-1321)", () => {
  const POST_URL = `${BASE_URL}${SIGN_IN_PATH}`;

  it("the 403 from the guard passes: after the two GETs, one form POST to <base>/sign-in from the site's own origin, with a small form and a trace id of its own; its line holds the status and that id, never a body or a value", (t) => {
    assert.equal(typeof SIGN_IN_PATH, "string", "web/src/auth/pages.ts names SIGN_IN_PATH");
    const result = check(t, { EXPECT_VERSION: "abc123", FAKE_VERSION: "abc123" });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(
      result.requests.map((call) => (isPost(call) ? "POST" : "GET")),
      ["GET", "GET", "POST"],
      "the POST comes after both GETs, and it is the only one",
    );
    assert.deepEqual(result.gets.map(addressOf), [`${BASE_URL}/health`, `${BASE_URL}/health`]);
    for (const get of result.gets) {
      for (const flag of ["--request", "-X", "--data", "--data-binary", "--data-raw", "-d", "--form", "-F"]) {
        assert.ok(!get.args.includes(flag), `a GET carries no ${flag}`);
      }
    }

    const [post] = result.posts;
    assert.equal(
      addressOf(post),
      POST_URL,
      "the sign-in form's route (web/src/auth/pages.ts SIGN_IN_PATH) at the workers.dev base",
    );
    assert.equal(
      headerOf(post, "origin"),
      SITE_ORIGIN,
      "this site's own origin: https:// + env.staging's LINK_HOST in wrangler.jsonc",
    );
    assert.equal(headerOf(post, "content-type"), "application/x-www-form-urlencoded");
    const [body] = valuesOf(post, "--data-binary");
    assert.ok(body.length > 0 && body.length <= 64, `a small body: ${body.length} bytes`);
    assert.equal(new URLSearchParams(body).has("requestId"), false, "no request id: no handler would call");
    assert.deepEqual(valuesOf(post, "--max-time"), ["3"]);
    assert.ok(!post.args.includes("--location") && !post.args.includes("-L"), "no redirect is followed");
    assert.equal(post.args[0], "--disable", "first, so no ~/.curlrc can make curl follow one");

    const postId = headerOf(post, "x-trace-id");
    const tracedId = headerOf(result.gets[1], "x-trace-id");
    assert.match(postId, UUID);
    assert.notEqual(postId, tracedId, "the POST has a trace id of its own");
    assert.match(
      result.stdout,
      new RegExp(
        `check: host rule OK: POST ${literally(POST_URL)}: HTTP 403 from the guard, trace_id=${postId}$`,
        "m",
      ),
    );
    assert.match(result.stdout, new RegExp(`^trace_id=${tracedId}$`, "m"));
    for (const value of [body, SITE_ORIGIN, PAGE_WORDS]) {
      assert.ok(!result.output.includes(value), `the output holds ${value}`);
    }
  });

  for (const [answer, reason] of [
    ["200", /HTTP 200: the form was taken, so the host rule did not refuse it/],
    ["302", /HTTP 302: a redirect, not the 403 from the guard/],
    ["404", /HTTP 404: no route takes a POST at that address/],
    ["405", /HTTP 405: the route there does not take a POST/],
    ["413", /HTTP 413: refused for its size, not by the host rule/],
    ["500", /HTTP 500: the Worker failed/],
    ["503", /HTTP 503: the Worker failed/],
    ["edge-403", /HTTP 403, but not from the Worker: the x-trace-id sent did not come back/],
    ["no-reference", /HTTP 403, but not from the guard: the page does not show the trace id/],
    ["none", /no answer: curl: \(28\) Operation timed out/],
  ]) {
    it(`fails on ${answer === "none" ? "no answer" : answer}, with its reason, after its one POST: never retried`, (t) => {
      const result = check(t, { FAKE_POST: answer });
      assert.notEqual(result.status, 0, result.output);
      assert.equal(result.gets.length, 2, "both GETs passed first");
      assert.equal(result.posts.length, 1, "the POST is sent once");
      assert.deepEqual(result.pauses, [], "and never retried");
      const postId = headerOf(result.posts[0], "x-trace-id");
      const line = result.stdout.split("\n").find((text) => text.includes("check: host rule FAILED: "));
      assert.ok(line !== undefined, result.output);
      assert.ok(line.includes(`check: host rule FAILED: POST ${POST_URL}: `), line);
      assert.match(line, reason);
      assert.ok(line.endsWith(`, trace_id=${postId}`), line);
      assert.match(
        result.stderr,
        new RegExp(`check failed at ${literally(POST_URL)}: a form POST to the workers\\.dev`),
      );
      assert.doesNotMatch(result.stdout, /^trace_id=/m, "a failed check prints no trace id line");
      for (const value of [valuesOf(result.posts[0], "--data-binary")[0], SITE_ORIGIN, PAGE_WORDS]) {
        assert.ok(!result.output.includes(value), `the output holds ${value}`);
      }
    });
  }

  it("sends no POST anywhere but an https address on workers.dev, the site's own above all: one NOTICE line, and the GETs alone", (t) => {
    for (const base of [
      `${SITE_ORIGIN}/test`,
      "https://rosie-staging.example.invalid/test",
      "https://rosie-staging.example.workers.dev.example.invalid/test",
      "https://workers.dev/test",
      "http://rosie-staging.example.workers.dev/test",
    ]) {
      const result = check(t, {}, base);
      assert.equal(result.status, 0, `${base}: ${result.output}`);
      assert.deepEqual(result.posts, [], base);
      assert.deepEqual(result.gets.map(addressOf), [`${base}/health`, `${base}/health`], base);
      const notice = `check: host rule: NOTICE: no POST sent, as ${base} is not an https address on workers.dev`;
      assert.ok(result.stdout.includes(notice), `${base}: ${result.stdout}`);
    }
  });

  it("sends no POST when a GET check fails", (t) => {
    for (const extra of [
      { FAKE_CURL_MODE: "fail", CHECK_ATTEMPTS: "2" },
      { EXPECT_VERSION: "abc123", FAKE_VERSION: "old999", CHECK_ATTEMPTS: "2" },
    ]) {
      const result = check(t, extra);
      assert.notEqual(result.status, 0, JSON.stringify(extra));
      assert.deepEqual(result.posts, [], JSON.stringify(extra));
    }
  });

  it("the POST takes CHECK_TIMEOUT_S too; with the defaults, a check whose POST gets no answer gives up within 63 seconds", (t) => {
    // health passes on its tenth and last request, the traced request on its one, then the POST gets no answer.
    const slow = check(t, { FAKE_CURL_FAILS: "9", FAKE_POST: "none" });
    assert.notEqual(slow.status, 0, slow.output);
    assert.equal(slow.gets.length, 11);
    assert.equal(slow.posts.length, 1);
    assert.deepEqual(valuesOf(slow.posts[0], "--max-time"), ["3"]);
    assert.ok(
      slow.worstCaseSeconds <= 63,
      `worst case ${slow.worstCaseSeconds} s: max times ${slow.maxTimes.join(",")}, pauses ${slow.pauses.join(",")}`,
    );
    const short = check(t, { CHECK_TIMEOUT_S: "2" });
    assert.equal(short.status, 0, short.output);
    assert.deepEqual(valuesOf(short.posts[0], "--max-time"), ["2"]);
  });

  it("in a staging deploy: the 403 from the guard passes the deploy's check; a 200 fails it, and the deploy goes on to its rollback", (t) => {
    const rig = releaseRoot(t);
    useStandIn(rig.dir);
    const live = "00000000-0000-4000-8000-000000001321";
    const sha = "1321000000000000000000000000000000001321";
    const env = {
      GIT_SHA: sha,
      FAKE_VERSION: sha,
      FAKE_LIVE_VERSION: live,
      STAGING_BASE_URL: BASE_URL,
      CHECK_ATTEMPTS: "1",
    };
    /** The deploy's lines that name the check, the deploy or the rollback, without their times. */
    const lines = (stdout) =>
      stdout
        .split("\n")
        .map((line) => line.replace(/^\[[^\]]+\] /, ""))
        .filter((line) => /^(check:|deploy-staging:|rollback:)/.test(line));

    const passed = rig.run("deploy-staging.sh", [], env);
    assert.equal(passed.status, 0, passed.output);
    assert.ok(
      lines(passed.stdout).some((line) =>
        line.startsWith(`check: host rule OK: POST ${POST_URL}: HTTP 403 from the guard, trace_id=`),
      ),
      passed.output,
    );
    assert.ok(lines(passed.stdout).includes(`deploy-staging: done, version ${live} at ${BASE_URL}`));

    const failed = rig.run("deploy-staging.sh", [], { ...env, FAKE_POST: "200" });
    assert.equal(failed.status, 1, failed.output);
    const order = [
      `check: host rule FAILED: POST ${POST_URL}: HTTP 200`,
      `check: FAILED at ${BASE_URL}`,
      "deploy-staging: FAILED (exit 1) after step 2 started",
      `rollback: nothing to roll back, staging still runs ${live}`,
    ].map((start) => lines(failed.stdout).findIndex((line) => line.startsWith(start)));
    assert.ok(
      order.every((at, k) => at >= 0 && (k === 0 || at > order[k - 1])),
      lines(failed.stdout).join("\n"),
    );
    const posts = rig.calls().filter((call) => call.tool === "curl" && isPost(call));
    assert.deepEqual(
      posts.map(addressOf),
      [POST_URL, POST_URL],
      "one POST in each deploy, to the workers.dev base",
    );
  });
});

// T-570 (DL-789's R6, as the lead ruled it; DL-757): the JOIN step, only with --join. Test owner 1's JOIN (tp-01) goes
// through staging's test-phone page calls, K-21 v1 testPhoneSend and testPhoneParts, signed in with the check tester's
// token, and the check passes on exactly one new part to tp-01 after the send. The stand-in below answers as the page
// entry and T-565's handlers do; every token is made up at random, and the one number is tp-01's fictional 555-0100.

/** tp-01's number (K-21 v1 test-roster.json, last four 0100; db/seeds/skeleton.ts): in the fiction range. */
const TP01_NUMBER = "+15555550100";

/** tp-01's chat, as the stand-in's parts name it. */
const TP01_CHAT = "linq-chat-stub-sam";

/** The words of every part the stand-in records: no output of the check may hold them. */
const PART_WORDS = "dummy-reply-words";

/** A check tester's token in the form make-check-tester-token.mjs makes one: 32 random bytes as base64url. */
const madeToken = () => randomBytes(32).toString("base64url");

/** An instant as the test-phone line writes a part's time: RFC 3339 UTC, whole seconds. */
const utcSeconds = (ms) => new Date(ms).toISOString().replace(/[.][0-9]+Z$/, "Z");

/** One part to tp-01 recorded at `ms`, as K-21 v1 RecordedPart lists it (test-phone-parts.json's form). */
function partAt(ms, name) {
  const at = utcSeconds(ms);
  return {
    at,
    sent: {
      idempotencyKey: `out-stub-${name}/1/1`,
      to: TP01_NUMBER,
      chatId: TP01_CHAT,
      service: "imessage",
      kind: "words",
      text: `${PART_WORDS} ${name}`,
      calendarFile: null,
      options: [],
      link: null,
      photo: null,
      tapback: null,
      threadedReplyTo: null,
      typing: null,
      overrideOptout: false,
    },
    outcome: {
      result: "accepted",
      providerMessageId: `linq-msg-stub-${name}`,
      providerOptionIds: null,
      chatId: TP01_CHAT,
      service: "imessage",
      acceptedAt: at,
    },
  };
}

/**
 * A stand-in for staging's Worker on this machine, http://127.0.0.1:<port>/test. GET /test/health answers as the Worker
 * does (runtime/src/index.ts), reporting `environment`. POST /test/page-api/testPhoneParts and testPhoneSend answer as
 * the page entry and T-565's handlers do (runtime/src/gateway/pages/entry.ts; actions/src/page-calls/staging/test-phone):
 * the x-trace-id sent comes back, with a 200 and K-21 v1's outcome: signInNeeded unless the page envelope carries
 * `token`, notTestPhone for a phone other than tp-01, else tp-01's parts after `since` (every part with none), or the
 * send's answer with the gateway's 200 and a trace id of the stand-in's own (joinTraceId). Its options:
 *   environment  what /health reports (default "staging"; null: no environment at all)
 *   token        the token the check tester's live session has
 *   before       how many parts tp-01 has before the send (default 0)
 *   reply        when the JOIN's reply is recorded: "first" (default: at the send, so the first read after it finds it),
 *                "reread" (once the first read after the send is answered, so only the re-read finds it), "none" (the
 *                composer port forced to fail: no part ever), or "two" (two parts at the send)
 *   sendDelayMs  how long the send's answer is held back (default 0)
 *   answers      {[call]: (body, n) => answer or undefined}: the n-th call of that name (from 1) is answered with
 *                {status = 200, outcome, traceId = the one sent (null: none)} instead, when the function gives one
 * requests: each request in order, {method, path, headers, body (parsed when it is JSON), at (epoch ms)}.
 */
async function stubWorker(t, options = {}) {
  const {
    environment = "staging",
    token,
    before = 0,
    reply = "first",
    sendDelayMs = 0,
    answers = {},
  } = options;
  const requests = [];
  const parts = Array.from({ length: before }, (_, at) =>
    partAt(Date.parse("2026-11-14T12:00:00Z") + at * 1000, `before-${String(at + 1)}`),
  );
  const counts = { testPhoneParts: 0, testPhoneSend: 0 };
  const joinTraceId = randomUUID();
  let sent = false;
  let readsAfterSend = 0;
  const server = createServer((request, response) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => {
      const at = Date.now();
      const where = new URL(request.url ?? "/", "http://stub.invalid").pathname;
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON: kept as the text it is
      }
      requests.push({ method: request.method, path: where, headers: request.headers, body, at });
      const sentId = request.headers["x-trace-id"];
      const answer = (status, outcome, traceId = sentId) => {
        const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
        if (typeof traceId === "string") headers["x-trace-id"] = traceId;
        response.writeHead(status, headers);
        response.end(JSON.stringify(outcome));
      };
      if (request.method === "GET" && where === "/test/health") {
        const id = typeof sentId === "string" && UUID.test(sentId) ? sentId : randomUUID();
        const health = { ok: true, service: "rosie", environment, version: "abc123", trace_id: id };
        if (environment === null) delete health.environment;
        answer(200, health, id);
        return;
      }
      const call = /^\/test\/page-api\/(testPhoneParts|testPhoneSend)$/.exec(where)?.[1];
      if (request.method !== "POST" || call === undefined) {
        answer(404, { ok: false, error: "not_found" }, randomUUID());
        return;
      }
      counts[call] += 1;
      if (call === "testPhoneSend") sent = true;
      else if (sent) readsAfterSend += 1;
      const given = answers[call]?.(body, counts[call]);
      if (given !== undefined) {
        const { status = 200, outcome, traceId = sentId } = given;
        answer(status, outcome, traceId);
        return;
      }
      if (body?.page?.sessionToken !== token) {
        answer(200, { error: "signInNeeded" });
        return;
      }
      if (body.testPhoneId !== "tp-01") {
        answer(200, { error: "notTestPhone", testPhoneId: body.testPhoneId });
        return;
      }
      if (call === "testPhoneParts") {
        const since = body.since === null ? null : Date.parse(body.since);
        answer(200, {
          result: "parts",
          phone: { testPhoneId: "tp-01", last4: "0100", chatOpen: sent, stopped: false, stoppedAt: null },
          chatLink: null,
          parts: parts.filter((part) => since === null || Date.parse(part.at) > since),
          emails: [],
        });
        if (reply === "reread" && readsAfterSend === 1) parts.push(partAt(Date.now(), "reply"));
        return;
      }
      if (reply === "first") parts.push(partAt(at, "reply"));
      if (reply === "two") parts.push(partAt(at, "reply-1"), partAt(at, "reply-2"));
      const outcome = {
        result: "sent",
        eventId: "evt-stub-0100-0001",
        traceId: joinTraceId,
        gatewayStatus: 200,
      };
      setTimeout(() => {
        answer(200, outcome);
      }, sendDelayMs);
    });
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${String(port)}/test`,
    requests,
    joinTraceId,
    /** What the stand-in was asked, in order, as "<method> <path>". */
    asked: () => requests.map((entry) => `${entry.method} ${entry.path}`),
    /** The page calls it was sent, in order: {call, body, headers, at}. */
    pageCalls: () =>
      requests
        .filter((entry) => entry.path.startsWith("/test/page-api/"))
        .map((entry) => ({ ...entry, call: entry.path.slice("/test/page-api/".length) })),
  };
}

/** Runs a command without blocking this process, where the stand-in answers; resolves to its status and output. */
function runAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr, output: `${stdout}${stderr}` });
    });
  });
}

/**
 * A throwaway checkout for the JOIN step's runs: this repository's post-deploy-check.sh and lib.sh, with no .dev.vars
 * unless devVars gives the text of a made-up one, a fake sleep (script-harness.mjs: it records the pause and returns at
 * once), a fake curl too when fakeCurl is set (it records each call and reaches nothing), and an empty HOME. run()
 * starts the check under the real bash without waiting for it, so the stand-in in this process can answer, with none of
 * this shell's keys: STAGING_CHECK_TESTER_TOKEN is dropped unless the run gives one.
 */
function joinRig(t, { devVars, fakeCurl = false } = {}) {
  const dir = tempDir(t, "join");
  const root = path.join(dir, "rosie");
  for (const script of ["post-deploy-check.sh", "lib.sh"]) copyScript(script, root);
  if (devVars !== undefined) write(path.join(root, ".dev.vars"), devVars);
  const fake = fakeTools(dir);
  const bin = path.join(dir, "bin");
  fake(path.join(bin, "sleep"), "sleep");
  if (fakeCurl) fake(path.join(bin, "curl"), "curl");
  const home = path.join(dir, "home");
  write(path.join(home, ".keep"), "");
  const log = path.join(dir, "calls.ndjson");
  const script = path.join(root, "infra", "scripts", "post-deploy-check.sh");
  return {
    dir,
    /** Runs the check with `args` and the variables given; PATH is the fake tools' folder, then this shell's. */
    run(args, extra = {}, searchPath = `${bin}:${process.env.PATH}`) {
      const env = cleanEnv(home, {
        PATH: searchPath,
        FAKE_LOG: log,
        STAGING_CHECK_TESTER_TOKEN: undefined,
        CHECK_ATTEMPTS: "3",
        CHECK_TIMEOUT_S: "10",
        ...extra,
      });
      return runAsync(program("bash"), [script, ...args], { cwd: root, env });
    },
    /** The fake tools' calls so far. */
    calls: () => readLog(log),
    /** The pauses the check asked the fake sleep for, in seconds. */
    pauses: () =>
      readLog(log)
        .filter((call) => call.tool === "sleep")
        .map((call) => Number(call.args[0])),
  };
}

/** Every command the check and lib.sh start by name, but node and sleep (below), each behind a recorder. */
const CHECK_COMMANDS = ["basename", "curl", "date", "dirname", "mktemp", "rm", "tr"];

/**
 * A joinRig whose every command is spied (script-harness.mjs spies): PATH holds the recorders alone, so none starts
 * unseen; each keeps its arguments and its environment. run() also gives children, what the recorders kept.
 */
function spiedJoinRig(t, options) {
  const rig = joinRig(t, options);
  const spy = spies(rig.dir, CHECK_COMMANDS, {
    node: [process.execPath],
    sleep: [process.execPath, path.join(rig.dir, "fake", "record.cjs"), "sleep"],
  });
  return {
    ...rig,
    async run(args, extra = {}) {
      spy.clear();
      const result = await rig.run(args, extra, spy.bin);
      return { ...result, children: spy.children() };
    },
  };
}

/** A recorded command by its name. */
const nameOf = (child) => child.name;

/** The check's lines, each without its time. */
const linesOf = (stdout) => stdout.split("\n").map((line) => line.replace(/^\[[^\]]+\] /, ""));

/** The check's first line that starts with `start`, without its time; undefined when there is none. */
const lineStarting = (stdout, start) => linesOf(stdout).find((line) => line.startsWith(start));

/** Fails when the check's output holds the token, a part's words, tp-01's number in either form, or its chat. */
function assertNothingShown(result, token, what = "") {
  const shown = [
    ["the token", token],
    ["a part's words", PART_WORDS],
    ["tp-01's number", TP01_NUMBER.slice(2)],
    ["tp-01's number", "555-0100"],
    ["tp-01's chat", TP01_CHAT],
  ].filter(([, value]) => result.output.includes(value));
  assert.deepEqual(
    shown.map(([name]) => name),
    [],
    `${what}: the check's output holds a value it must never show`,
  );
}

describe("post-deploy-check.sh --join: test owner 1's JOIN through the test-phone page calls passes on exactly one new reply part (T-570; DL-789's R6; DL-757)", () => {
  it("one reply part at the first read passes: health and the traced request, then tp-01's parts, the send and one read after it, each signed in with the token; the JOIN's trace id from testPhoneSend's answer, the timing line, and both trace ids last", async (t) => {
    const token = madeToken();
    const stub = await stubWorker(t, { token });
    const rig = joinRig(t);
    const result = await rig.run(["--join", stub.base], { STAGING_CHECK_TESTER_TOKEN: token });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(
      stub.asked(),
      [
        "GET /test/health",
        "GET /test/health",
        "POST /test/page-api/testPhoneParts",
        "POST /test/page-api/testPhoneSend",
        "POST /test/page-api/testPhoneParts",
      ],
      "no host rule POST off workers.dev; the read before the send, the send, one read after it",
    );
    const [before, send, after] = stub.pageCalls();
    for (const call of [before, send, after]) {
      assert.equal(
        call.body.page.sessionToken === token,
        true,
        `${call.call}: the envelope carries the token`,
      );
      assert.equal(call.body.page.linkCode, null);
      assert.match(call.body.page.requestId, UUID);
      assert.match(call.body.page.traceId, UUID);
      assert.equal(
        call.headers["x-trace-id"],
        call.body.page.traceId,
        `${call.call}: x-trace-id is the envelope's`,
      );
      assert.equal(call.headers["content-type"], "application/json");
      assert.equal(call.body.testPhoneId, "tp-01");
    }
    for (const field of ["requestId", "traceId"]) {
      assert.equal(
        new Set([before, send, after].map((call) => call.body.page[field])).size,
        3,
        `a ${field} each`,
      );
    }
    assert.deepEqual(Object.keys(before.body).sort(), ["page", "since", "testPhoneId"]);
    assert.equal(before.body.since, null, "every part tp-01 has, before the send");
    assert.deepEqual(Object.keys(send.body).sort(), ["page", "testPhoneId", "threadedReplyTo", "words"]);
    assert.equal(send.body.words, "JOIN");
    assert.equal(send.body.threadedReplyTo, null);
    assert.deepEqual(Object.keys(after.body).sort(), ["page", "since", "testPhoneId"]);
    assert.match(after.body.since, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/);
    const since = Date.parse(after.body.since);
    assert.ok(
      since <= Math.floor(send.at / 1000) * 1000 - 1000,
      "since: the send's own second less one, or earlier",
    );
    assert.ok(since >= send.at - 5000, "since: no more than a few seconds before the send");

    const lines = linesOf(result.stdout);
    const healthId = lines
      .map((line) => /^check: health OK: environment=staging version=abc123 trace_id=(\S+)$/.exec(line)?.[1])
      .find((id) => id !== undefined);
    assert.match(healthId ?? "", UUID, `the health answer's trace id is printed:\n${result.stdout}`);
    assert.ok(
      lines.includes(
        `check: join sent: JOIN as tp-01 through testPhoneSend, the gateway answered 200: event_id=evt-stub-0100-0001 trace_id=${stub.joinTraceId}`,
      ),
      result.stdout,
    );
    const timing =
      /^check: join timing (OK|BREACH): ([0-9]+) ms from the send to testPhoneSend's answer with the gateway's 200 \(the connection's setup not counted\), (within|over) C-044's 1 s/.exec(
        lineStarting(result.stdout, "check: join timing ") ?? "",
      );
    assert.ok(timing, `a named timing line:\n${result.stdout}`);
    const within = Number(timing[2]) <= 1000;
    assert.deepEqual([timing[1], timing[3]], within ? ["OK", "within"] : ["BREACH", "over"], timing[0]);
    assert.match(
      lineStarting(result.stdout, "check: join OK: ") ?? "",
      new RegExp(
        `^check: join OK: exactly one new part to tp-01 after the send \\(at [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z, a words part, accepted; read 1 of 2\\): trace_id=${stub.joinTraceId}$`,
      ),
    );
    assert.deepEqual(
      result.stdout.trimEnd().split("\n").slice(-2),
      [`trace_id=${stub.requests[1].headers["x-trace-id"]}`, `join_trace_id=${stub.joinTraceId}`],
      "the traced request's trace id, then the JOIN's, last",
    );
    assert.deepEqual(rig.pauses(), [], "found at the first read: no re-read");
    assertNothingShown(result, token);
  });

  it("a reply part that only the re-read finds passes, after one pause that ends the poll within 30 s of the send", async (t) => {
    const token = madeToken();
    const stub = await stubWorker(t, { token, reply: "reread" });
    const rig = joinRig(t);
    const result = await rig.run(["--join", stub.base], { STAGING_CHECK_TESTER_TOKEN: token });
    assert.equal(result.status, 0, result.output);
    const calls = stub.pageCalls();
    assert.deepEqual(
      calls.map((call) => call.call),
      ["testPhoneParts", "testPhoneSend", "testPhoneParts", "testPhoneParts"],
    );
    assert.equal(
      calls[2].body.since,
      calls[3].body.since,
      "both reads after the send ask from the send's time",
    );
    const pauses = rig.pauses();
    assert.equal(pauses.length, 1, "one pause, before the one re-read");
    assert.ok(
      pauses[0] > 0 && pauses[0] + 10 <= 30,
      `a pause of ${String(pauses[0])} s and the re-read's 10 s`,
    );
    assert.ok(
      lineStarting(
        result.stdout,
        `check: join: no reply part to tp-01 yet (read 1 of 2); one re-read in ${String(pauses[0])} s, to end within 30 s of the send (DL-757)`,
      ),
      result.stdout,
    );
    assert.match(
      lineStarting(result.stdout, "check: join OK: ") ?? "",
      new RegExp(`; read 2 of 2\\): trace_id=${stub.joinTraceId}$`),
    );
    assertNothingShown(result, token);
  });

  it("no reply part (the composer port forced to fail) fails after one re-read within 30 s of the send, naming the missing reply and the JOIN's trace id; the token reaches no command", async (t) => {
    const token = madeToken();
    const stub = await stubWorker(t, { token, reply: "none" });
    const rig = spiedJoinRig(t);
    const result = await rig.run(["--join", stub.base], { STAGING_CHECK_TESTER_TOKEN: token });
    assert.notEqual(result.status, 0, result.output);
    assert.deepEqual(
      stub.pageCalls().map((call) => call.call),
      ["testPhoneParts", "testPhoneSend", "testPhoneParts", "testPhoneParts"],
      "one read, then one re-read, and no more",
    );
    const pageCurls = result.children.filter(
      (child) => child.name === "curl" && addressOf(child).includes("/page-api/"),
    );
    assert.equal(pageCurls.length, 4);
    for (const curl of pageCurls) assert.deepEqual(valuesOf(curl, "--max-time"), ["10"], addressOf(curl));
    const pauses = rig.pauses();
    assert.equal(pauses.length, 1);
    assert.ok(
      pauses[0] > 0 && pauses[0] + 10 <= 30,
      `the re-read starts ${String(pauses[0])} s after the read and may take 10 s: past 30 s from the send`,
    );
    assert.ok(
      lineStarting(
        result.stdout,
        `check: join FAILED: no reply part to tp-01 within 30 s of the send (2 reads through testPhoneParts): the reply is missing, trace_id=${stub.joinTraceId}`,
      ),
      result.stdout,
    );
    assert.match(
      result.stderr,
      new RegExp(
        `check failed at ${literally(stub.base)}/page-api/testPhoneParts: the JOIN's reply is missing \\(search trace_id=${stub.joinTraceId} in Workers Logs\\)`,
      ),
    );
    assert.doesNotMatch(result.stdout, /^(join_)?trace_id=/m, "a failed check prints no trace id line");
    assert.deepEqual(whereHeld(result.children, [token], nameOf), [], "a command holds the token");
    assert.deepEqual(namedIn(result.children, ["STAGING_CHECK_TESTER_TOKEN"], nameOf), []);
    assertNothingShown(result, token);
  });

  it("more than one new part fails at once: the reply is not exactly one part", async (t) => {
    const token = madeToken();
    const stub = await stubWorker(t, { token, reply: "two" });
    const rig = joinRig(t);
    const result = await rig.run(["--join", stub.base], { STAGING_CHECK_TESTER_TOKEN: token });
    assert.notEqual(result.status, 0, result.output);
    assert.deepEqual(
      stub.pageCalls().map((call) => call.call),
      ["testPhoneParts", "testPhoneSend", "testPhoneParts"],
    );
    assert.deepEqual(rig.pauses(), []);
    assert.ok(
      lineStarting(
        result.stdout,
        `check: join FAILED: 2 new parts to tp-01 after the send (read 1 of 2), not exactly one: trace_id=${stub.joinTraceId}`,
      ),
      result.stdout,
    );
    assert.match(result.stderr, /the JOIN's reply was not exactly one part/);
    assertNothingShown(result, token);
  });

  it("refuses before sending when tp-01 already has parts, naming the reset (a fresh seed): nothing is sent", async (t) => {
    for (const before of [1, 3]) {
      const token = madeToken();
      const stub = await stubWorker(t, { token, before });
      const result = await joinRig(t).run(["--join", stub.base], { STAGING_CHECK_TESTER_TOKEN: token });
      assert.notEqual(result.status, 0, result.output);
      assert.deepEqual(
        stub.pageCalls().map((call) => call.call),
        ["testPhoneParts"],
        "no send",
      );
      assert.match(
        result.stderr,
        new RegExp(
          `refused: tp-01 already has ${String(before)} part\\(s\\) on staging's test-phone line, so its JOIN would be no first text .*\\(a fresh seed: .*nothing was sent`,
        ),
      );
      assert.doesNotMatch(result.stdout, /^(join_)?trace_id=/m);
      assertNothingShown(result, token, `${String(before)} before`);
    }
  });

  it("refuses with no token, naming STAGING_CHECK_TESTER_TOKEN, before any request: none in the environment, none in .dev.vars", async (t) => {
    for (const devVars of [undefined, "# made up\nOTHER_NAME=1\n", "STAGING_CHECK_TESTER_TOKEN=\n"]) {
      const stub = await stubWorker(t, { token: madeToken() });
      const result = await joinRig(t, { devVars }).run(["--join", stub.base], {
        STAGING_CHECK_TESTER_TOKEN: "",
      });
      assert.notEqual(result.status, 0, result.output);
      assert.match(result.stderr, /refused: STAGING_CHECK_TESTER_TOKEN is not set .*nothing was sent/);
      assert.deepEqual(stub.requests, [], "nothing was sent");
    }
  });

  it("refuses a token that is not in the form it is made in, never showing it, before any request", async (t) => {
    const made = madeToken();
    for (const bad of [
      randomBytes(32).toString("hex"), // a sha256's form, the hash in the token's place
      made.slice(0, 42),
      `${made.slice(0, 42)}B`, // 43 signs whose last leaves bits set: not 32 bytes
      `${made.slice(0, 21)} ${made.slice(22)}`,
      `${made}A`,
    ]) {
      const stub = await stubWorker(t, { token: bad });
      const result = await joinRig(t).run(["--join", stub.base], { STAGING_CHECK_TESTER_TOKEN: bad });
      assert.notEqual(result.status, 0, result.output);
      assert.match(
        result.stderr,
        /refused: STAGING_CHECK_TESTER_TOKEN is not the check tester's token in the form/,
      );
      assert.equal(result.output.includes(bad), false, "the output holds the token given");
      assert.deepEqual(stub.requests, [], "nothing was sent");
    }
  });

  it("takes the token from the environment first, else from the checkout's .dev.vars by name", async (t) => {
    const fromFile = madeToken();
    const fromEnv = madeToken();
    const devVars = `# made up\nexport STAGING_CHECK_TESTER_TOKEN="${fromFile}"\n`;
    for (const [what, given, expected] of [
      ["the environment's", { STAGING_CHECK_TESTER_TOKEN: fromEnv }, fromEnv],
      [".dev.vars'", {}, fromFile],
    ]) {
      const stub = await stubWorker(t, { token: expected });
      const result = await joinRig(t, { devVars }).run(["--join", stub.base], given);
      assert.equal(result.status, 0, `${what}: ${result.output}`);
      assert.deepEqual(
        stub.pageCalls().map((call) => call.body.page.sessionToken === expected),
        [true, true, true],
        `${what} token in every page call`,
      );
      assertNothingShown(result, fromFile, what);
      assertNothingShown(result, fromEnv, what);
    }
  });

  it("the token reaches the Worker in each page call's body alone: from the environment or from .dev.vars, no command started holds it in its arguments or environment, or has its name", async (t) => {
    for (const source of ["the environment", ".dev.vars"]) {
      const token = madeToken();
      const stub = await stubWorker(t, { token });
      const fromFile = source === ".dev.vars";
      const rig = spiedJoinRig(t, fromFile ? { devVars: `STAGING_CHECK_TESTER_TOKEN='${token}'\n` } : {});
      const result = await rig.run(
        ["--join", stub.base],
        fromFile ? {} : { STAGING_CHECK_TESTER_TOKEN: token },
      );
      assert.equal(result.status, 0, `${source}: ${result.output}`);
      assert.deepEqual(
        stub.pageCalls().map((call) => call.body.page.sessionToken === token),
        [true, true, true],
        source,
      );
      const names = new Set(result.children.map(nameOf));
      for (const name of ["curl", "date", "dirname", "mktemp", "node", "rm"]) {
        assert.ok(names.has(name), `${source}: no ${name} was recorded`);
      }
      assert.deepEqual(
        whereHeld(result.children, [token], nameOf),
        [],
        `${source}: a command holds the token`,
      );
      assert.deepEqual(namedIn(result.children, ["STAGING_CHECK_TESTER_TOKEN"], nameOf), [], source);
      assertNothingShown(result, token, source);
    }
  });

  it("without --join the check is health, the traced request and the host rule alone (deploy-staging.sh's own): no page call, and a token in the caller's environment reaches no command", async (t) => {
    const token = madeToken();
    const stub = await stubWorker(t, { token });
    const result = await spiedJoinRig(t).run([stub.base], { STAGING_CHECK_TESTER_TOKEN: token });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(stub.asked(), ["GET /test/health", "GET /test/health"]);
    assert.equal(lineStarting(result.stdout, "check: join"), undefined, result.stdout);
    assert.deepEqual(result.stdout.trimEnd().split("\n").slice(-1), [
      `trace_id=${stub.requests[1].headers["x-trace-id"]}`,
    ]);
    assert.deepEqual(whereHeld(result.children, [token], nameOf), [], "a command holds the token");
    assert.deepEqual(namedIn(result.children, ["STAGING_CHECK_TESTER_TOKEN"], nameOf), []);
    assertNothingShown(result, token);
  });

  it("refuses a base URL whose /health reports any environment but staging: at once, with no retry and nothing more sent, with --join or without", async (t) => {
    for (const environment of ["production", "Staging", null]) {
      for (const join of [[], ["--join"]]) {
        const what = `${String(environment)}${join.length > 0 ? " --join" : ""}`;
        const token = madeToken();
        const stub = await stubWorker(t, { token, environment });
        const result = await joinRig(t).run([...join, stub.base], {
          STAGING_CHECK_TESTER_TOKEN: token,
          CHECK_ATTEMPTS: "5",
        });
        assert.notEqual(result.status, 0, `${what}: ${result.output}`);
        assert.deepEqual(stub.asked(), ["GET /test/health"], `${what}: one request, never retried`);
        const reported =
          environment === null
            ? "the Worker reports no environment, not staging"
            : `the Worker reports environment ${JSON.stringify(environment)}, not staging`;
        assert.ok(
          lineStarting(result.stdout, `check: health REFUSED: ${reported}`),
          `${what}: ${result.stdout}`,
        );
        assert.match(
          result.stderr,
          new RegExp(
            `refused: ${literally(stub.base)}/health reports an environment other than staging: check:staging checks staging alone, so nothing more was sent`,
          ),
          what,
        );
        assert.doesNotMatch(result.stdout, /^(join_)?trace_id=/m, what);
      }
    }
  });

  it("the timing line: a send answered after more than 1 s is a BREACH, a NEED for the architect and never a cache; the check still passes on its one reply part", async (t) => {
    const token = madeToken();
    const stub = await stubWorker(t, { token, sendDelayMs: 1200 });
    const result = await joinRig(t).run(["--join", stub.base], { STAGING_CHECK_TESTER_TOKEN: token });
    assert.equal(result.status, 0, result.output);
    const line = lineStarting(result.stdout, "check: join timing ") ?? "";
    const breach = new RegExp(
      "^check: join timing BREACH: ([0-9]+) ms from the send to testPhoneSend's answer with the gateway's 200 " +
        "\\(the connection's setup not counted\\), over C-044's 1 s: report it to the architect as a NEED, never fix " +
        "it with a cache \\(DL-757; ADR-014 section 2\\)\\. It bounds the gateway's part from above: the page entry's " +
        "own reads and one round trip are in it, and the gateway's receive span under " +
        `trace_id=${stub.joinTraceId} gives that part alone$`,
    ).exec(line);
    assert.ok(breach, result.stdout);
    assert.ok(Number(breach[1]) >= 1200, line);
    assert.ok(lineStarting(result.stdout, "check: join OK: "), result.stdout);
  });

  for (const [title, outcome, reason] of [
    [
      "the page entry's 503",
      { status: 503, outcome: { ok: false, error: "unavailable" } },
      /HTTP 503: the handler failed or is not connected/,
    ],
    [
      "the gateway's 401",
      { outcome: { result: "sent", eventId: "evt-stub", traceId: "trace-gateway-401", gatewayStatus: 401 } },
      /the gateway answered 401: the gateway refused the signature of the Linq double \(LINQ_WEBHOOK_SECRET\), not 200, trace_id=trace-gateway-401/,
    ],
    [
      "the gateway's 503",
      { outcome: { result: "sent", eventId: "evt-stub", traceId: "trace-gateway-503", gatewayStatus: 503 } },
      /the gateway answered 503: the gateway took nothing .*, not 200, trace_id=trace-gateway-503/,
    ],
    [
      "an answer with no trace id",
      { outcome: { result: "sent", eventId: "evt-stub", gatewayStatus: 200 } },
      /the answer carries no trace id/,
    ],
    ["transient", { outcome: { error: "transient" } }, /transient: nothing was done/],
    ["notTester", { outcome: { error: "notTester" } }, /notTester: the session of that token is neither/],
    [
      "an answer not from the page entry",
      {
        outcome: { result: "sent", eventId: "evt-stub", traceId: "trace-x", gatewayStatus: 200 },
        traceId: null,
      },
      /HTTP 200, but not from the page entry: the x-trace-id sent did not come back/,
    ],
  ]) {
    it(`a send answered with ${title} fails, with its reason, and nothing is read after it`, async (t) => {
      const token = madeToken();
      const stub = await stubWorker(t, { token, answers: { testPhoneSend: () => outcome } });
      const rig = joinRig(t);
      const result = await rig.run(["--join", stub.base], { STAGING_CHECK_TESTER_TOKEN: token });
      assert.notEqual(result.status, 0, result.output);
      const [, send] = stub.pageCalls();
      assert.deepEqual(
        stub.pageCalls().map((call) => call.call),
        ["testPhoneParts", "testPhoneSend"],
      );
      const line = lineStarting(result.stdout, "check: join FAILED: testPhoneSend as tp-01: ") ?? "";
      assert.match(line, reason, result.stdout);
      assert.ok(line.endsWith(`, page trace_id=${send.body.page.traceId}`), line);
      assert.match(
        result.stderr,
        /check failed at .*\/page-api\/testPhoneSend: the JOIN did not get the gateway's 200/,
      );
      assert.equal(
        lineStarting(result.stdout, "check: join timing "),
        undefined,
        "no timing line without the 200",
      );
      assert.deepEqual(rig.pauses(), []);
      assertNothingShown(result, token);
    });
  }

  for (const [title, options, reason] of [
    [
      "signInNeeded (no live session has the token)",
      { token: madeToken() },
      /signInNeeded: no live session has the check tester token \(STAGING_CHECK_TESTER_TOKEN\)/,
    ],
    [
      "notTester",
      { answers: { testPhoneParts: () => ({ outcome: { error: "notTester" } }) } },
      /notTester: /,
    ],
    [
      "notTestPhone",
      { answers: { testPhoneParts: () => ({ outcome: { error: "notTestPhone", testPhoneId: "tp-01" } }) } },
      /notTestPhone: staging has no test phone tp-01 \(npm run seed:staging\)/,
    ],
    [
      "stagingOnly",
      { answers: { testPhoneParts: () => ({ outcome: { error: "stagingOnly" } }) } },
      /stagingOnly: the Worker there is not staging, and it read nothing/,
    ],
    [
      "the page entry's 503",
      { answers: { testPhoneParts: () => ({ status: 503, outcome: { ok: false, error: "unavailable" } }) } },
      /HTTP 503: the handler failed or is not connected/,
    ],
    [
      "an error K-21 v1 does not give the call",
      { answers: { testPhoneParts: () => ({ outcome: { error: "linkExpired" } }) } },
      /an error K-21 v1 does not give this call/,
    ],
    [
      "the parts of another phone",
      {
        answers: {
          testPhoneParts: () => ({
            outcome: {
              result: "parts",
              phone: {
                testPhoneId: "tp-04",
                last4: "0104",
                chatOpen: false,
                stopped: false,
                stoppedAt: null,
              },
              chatLink: null,
              parts: [],
              emails: [],
            },
          }),
        },
      },
      /the parts of a phone other than tp-01/,
    ],
  ]) {
    it(`a read of tp-01's parts before the send answered with ${title} fails, with its reason, and nothing is sent`, async (t) => {
      const token = madeToken();
      const stub = await stubWorker(t, { token, ...options });
      const result = await joinRig(t).run(["--join", stub.base], { STAGING_CHECK_TESTER_TOKEN: token });
      assert.notEqual(result.status, 0, result.output);
      assert.deepEqual(
        stub.pageCalls().map((call) => call.call),
        ["testPhoneParts"],
        "no send",
      );
      assert.match(
        lineStarting(
          result.stdout,
          "check: join FAILED: tp-01's parts could not be read before the send: ",
        ) ?? "",
        reason,
        result.stdout,
      );
      assert.match(result.stderr, /the JOIN's read before the send failed; nothing was sent/);
      assertNothingShown(result, token);
    });
  }

  it("a first read after the send that fails is followed by the one re-read, which passes on the reply part", async (t) => {
    const token = madeToken();
    const stub = await stubWorker(t, {
      token,
      answers: {
        // The parts' second read, the first after the send: the page entry's 503.
        testPhoneParts: (_, n) =>
          n === 2 ? { status: 503, outcome: { ok: false, error: "unavailable" } } : undefined,
      },
    });
    const rig = joinRig(t);
    const result = await rig.run(["--join", stub.base], { STAGING_CHECK_TESTER_TOKEN: token });
    assert.equal(result.status, 0, result.output);
    assert.ok(
      lineStarting(result.stdout, "check: join: read 1 of 2 of tp-01's parts failed: HTTP 503: "),
      result.stdout,
    );
    assert.equal(rig.pauses().length, 1);
    assert.match(lineStarting(result.stdout, "check: join OK: ") ?? "", /; read 2 of 2\): trace_id=/);
  });

  it("refuses --join on a base URL that is neither https nor http on this machine's loopback, before any request", async (t) => {
    for (const base of [
      "http://rosie-staging.example.invalid/test",
      "http://127.0.0.2.example.invalid/test",
      "ftp://127.0.0.1/test",
      "rosie-staging.example.invalid/test",
    ]) {
      const rig = joinRig(t, { fakeCurl: true });
      const result = await rig.run(["--join", base], { STAGING_CHECK_TESTER_TOKEN: madeToken() });
      assert.notEqual(result.status, 0, `${base}: ${result.output}`);
      assert.match(
        result.stderr,
        /refused: --join sends the check tester's token, so <base-url> must be https, or http on this machine's own loopback/,
        base,
      );
      assert.deepEqual(
        rig.calls().filter((call) => call.tool === "curl"),
        [],
        `${base}: no request`,
      );
    }
  });

  it("takes --join once and one base URL: anything else is refused, with the usage and no argument echoed", async (t) => {
    const token = madeToken();
    const base = "https://rosie-staging.example.workers.dev/test";
    const cases = [[], ["--join"], ["--join", "--join", base], [`--${token}`, base], [base, base], [""]];
    for (const [at, args] of cases.entries()) {
      const what = `case ${String(at + 1)} of ${String(cases.length)}`;
      const rig = joinRig(t, { fakeCurl: true });
      const result = await rig.run(args, { STAGING_CHECK_TESTER_TOKEN: token });
      assert.notEqual(result.status, 0, what);
      assert.match(result.stderr, /usage: post-deploy-check\.sh \[--join\] <base-url>/, what);
      assert.equal(result.output.includes(token), false, `${what}: an argument was echoed`);
      assert.deepEqual(rig.calls(), [], `${what}: nothing was started`);
    }
  });
});
