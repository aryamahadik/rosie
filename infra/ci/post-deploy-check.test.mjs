// Tests for infra/scripts/post-deploy-check.sh (factory spec 3 and 6; D-000 check 5), run in ci.yml by
// `node --test "infra/ci/*.test.mjs"`. Fake curl and sleep commands (script-harness.mjs) answer or fail each
// request and record its --max-time and each pause, without any network or waiting, so the time a failing
// check can take is computed from what the script asked for.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";

import { SCRIPTS, cleanEnv, fakeTools, readLog, tempDir, write } from "./script-harness.mjs";

const CHECK = path.join(SCRIPTS, "post-deploy-check.sh");
const BASE_URL = "https://rosie-staging.example.workers.dev/test";

function check(t, extra = {}) {
  const dir = tempDir(t, "check");
  const fake = fakeTools(dir);
  fake(path.join(dir, "bin", "curl"), "curl");
  fake(path.join(dir, "bin", "sleep"), "sleep");
  const home = path.join(dir, "home");
  write(path.join(home, ".keep"), "");
  const log = path.join(dir, "calls.ndjson");
  const result = spawnSync("bash", [CHECK, BASE_URL], {
    encoding: "utf8",
    env: cleanEnv(home, { PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, FAKE_LOG: log, ...extra }),
  });
  const calls = readLog(log);
  const requests = calls.filter((call) => call.tool === "curl");
  const pauses = calls.filter((call) => call.tool === "sleep").map((call) => Number(call.args[0]));
  const maxTimes = requests.map((call) => Number(call.args[call.args.indexOf("--max-time") + 1]));
  const worstCaseSeconds = [...maxTimes, ...pauses].reduce((sum, seconds) => sum + seconds, 0);
  return { ...result, requests, pauses, maxTimes, worstCaseSeconds };
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
    // health passes on the third request; the traced request still gets one attempt, and no more.
    const result = check(t, { FAKE_CURL_FAILS: "2", CHECK_ATTEMPTS: "3", CHECK_TIMEOUT_S: "1" });
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    assert.equal(result.requests.length, 4);
  });

  it("passes a healthy deployment: health, then one traced request whose trace id comes back", (t) => {
    const result = check(t, { FAKE_CURL_MODE: "ok", EXPECT_VERSION: "abc123", FAKE_VERSION: "abc123" });
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    assert.equal(result.requests.length, 2);
    const traced = result.requests[1].args;
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
