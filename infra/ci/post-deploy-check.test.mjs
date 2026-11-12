// Tests for infra/scripts/post-deploy-check.sh (factory spec 3 and 6; D-000 check 5; T-1321), run in ci.yml by
// `node --test "infra/ci/*.test.mjs"`. Fake curl and sleep commands (script-harness.mjs) answer or fail each
// request and record its --max-time and each pause, without any network or waiting, so the time a failing
// check can take is computed from what the script asked for. The check's one form POST (T-1321: T-1237's host rule
// on the edge, its security review's note b) goes to a curl stand-in of this file's own, which records it as the fake
// curl records a call and answers it as FAKE_POST says; it hands every other request to the fake curl as it is.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { releaseRoot } from "./release-harness.mjs";
import { REPO, SCRIPTS, cleanEnv, fakeTools, readLog, tempDir, write } from "./script-harness.mjs";

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
