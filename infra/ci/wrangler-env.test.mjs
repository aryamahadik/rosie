// Tests for wrangler.jsonc's env.production (T-1003): its own Worker and resource names (none shared with staging),
// the pinned account, the same binding names as the top level, no route (it stays a comment until the user says yes),
// and no key or secret value in the file. Also (T-1235) the link host, LINK_HOST, in each environment, and
// env.staging's own FILES bucket; and (T-1304) Rosie's own number, which no section names and no tracked config or
// script holds. Run in ci.yml by `node --test "infra/ci/*.test.mjs"`.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { REPO, SCRIPTS } from "./script-harness.mjs";

const ROSFIELD_ACCOUNT_ID = "ecb06e7bc9129fa81104d331e9652362";
// The host every link starts with (T-1235), set as the var LINK_HOST in each environment: a bare host, no scheme.
const LINK_HOST = "rosfield.com";

// Strip // and /* */ comments outside strings, then trailing commas, then parse.
function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// Every resource name a section binds: Worker, queues (and dead-letter), bucket, KV and Hyperdrive ids.
function resourceNames(section) {
  const names = [];
  if (section.name) names.push(section.name);
  for (const p of section.queues?.producers ?? []) names.push(p.queue);
  for (const c of section.queues?.consumers ?? []) {
    names.push(c.queue);
    if (c.dead_letter_queue) names.push(c.dead_letter_queue);
  }
  for (const b of section.r2_buckets ?? []) names.push(b.bucket_name);
  for (const k of section.kv_namespaces ?? []) names.push(k.id);
  for (const h of section.hyperdrive ?? []) names.push(h.id);
  return names;
}

// Returns a list of problems with env.production; empty means the card's rules hold.
function productionProblems(config) {
  const problems = [];
  const prod = config.env?.production;
  const staging = config.env?.staging;
  if (!prod) return ["env.production is missing"];
  if (!staging) problems.push("env.staging is missing");
  if (typeof prod.name !== "string" || prod.name === "") problems.push("env.production.name is missing");
  if (prod.name === staging?.name) problems.push("env.production.name equals env.staging.name");
  if (config.account_id !== ROSFIELD_ACCOUNT_ID) problems.push("top-level account_id is not the pinned one");
  if ("account_id" in prod && prod.account_id !== ROSFIELD_ACCOUNT_ID) {
    problems.push("env.production.account_id is not the pinned one");
  }
  // Names that staging, or the top level's local-run defaults (which point at staging's bucket), already use.
  const taken = new Set([...resourceNames(config), ...resourceNames(staging ?? {})]);
  for (const name of resourceNames(prod)) {
    if (taken.has(name)) problems.push(`env.production shares a name or id with another section: ${name}`);
    if (
      name !== prod.name &&
      typeof name === "string" &&
      !/^[0-9a-f]{32}$/.test(name) &&
      !name.includes("production")
    ) {
      problems.push(`env.production resource name does not say production: ${name}`);
    }
  }
  if (prod.routes !== undefined || prod.route !== undefined) problems.push("env.production has a route");
  if (prod.vars?.ENVIRONMENT !== "production")
    problems.push("env.production.vars.ENVIRONMENT is not production");
  // The link host (T-1235): the bare host production's links start with (Q-51's default; DL-014).
  if (prod.vars?.LINK_HOST !== LINK_HOST) problems.push(`env.production.vars.LINK_HOST is not ${LINK_HOST}`);
  if (JSON.stringify(prod.secrets) !== JSON.stringify({ required: [] }))
    problems.push("secrets.required is not []");
  for (const [k, v] of Object.entries(prod.vars ?? {})) {
    if (/(key|token|secret|password|pass)/i.test(k)) problems.push(`var name looks like a key: ${k}`);
    if (typeof v !== "string") problems.push(`var is not a string: ${k}`);
    else if (v.length > 0 && !/^[A-Za-z0-9_/.-]{0,40}$/.test(v)) problems.push(`var value looks odd: ${k}`);
    else if (/(sk_|pk_|AKIA|eyJ|re_[A-Za-z0-9]{10,})/.test(v))
      problems.push(`var value looks like a key: ${k}`);
  }
  // The same bindings the top level declares (wrangler does not inherit them into an environment).
  const bindingNames = (s) => ({
    durable: (s.durable_objects?.bindings ?? []).map((b) => `${b.name}:${b.class_name}`),
    kv: (s.kv_namespaces ?? []).map((k) => k.binding),
    queues: (s.queues?.producers ?? []).map((p) => p.binding),
    r2: (s.r2_buckets ?? []).map((b) => b.binding),
  });
  const want = bindingNames(config);
  const have = bindingNames(prod);
  if (JSON.stringify(have) !== JSON.stringify(want))
    problems.push("env.production bindings differ from the top level's");
  if (JSON.stringify(prod.migrations) !== JSON.stringify(config.migrations))
    problems.push("migrations differ");
  if (JSON.stringify(prod.triggers) !== JSON.stringify(config.triggers))
    problems.push("cron triggers differ");
  const consumers = prod.queues?.consumers ?? [];
  if (consumers.length !== 1 || consumers[0].max_retries !== 5 || !consumers[0].dead_letter_queue) {
    problems.push("retry queue is not one consumer with 5 tries and a dead-letter queue");
  }
  if ((prod.hyperdrive ?? []).map((h) => h.binding).join() !== "HYPERDRIVE")
    problems.push("no HYPERDRIVE binding");
  for (const h of prod.hyperdrive ?? []) {
    if (Object.keys(h).sort().join() !== "binding,id")
      problems.push("hyperdrive holds more than binding and id");
  }
  return problems;
}

const raw = readFileSync(path.join(REPO, "wrangler.jsonc"), "utf8");
const config = parseJsonc(raw);

describe("wrangler.jsonc env.production (T-1003)", () => {
  it("has its own names and ids, the pinned account, the top level's bindings and no route", () => {
    assert.deepEqual(productionProblems(config), []);
  });

  it("names the Worker rosie-production, not rosie-staging", () => {
    assert.equal(config.env.production.name, "rosie-production");
    assert.notEqual(config.env.production.name, config.env.staging.name);
  });

  it("uses the pinned account, set once at the top level and never overridden", () => {
    assert.equal(config.account_id, ROSFIELD_ACCOUNT_ID);
    assert.ok(
      !("account_id" in config.env.production) || config.env.production.account_id === ROSFIELD_ACCOUNT_ID,
    );
  });

  it("binds Durable Object, KV, R2, Queues, cron and Hyperdrive under production names", () => {
    const prod = config.env.production;
    assert.deepEqual(prod.durable_objects.bindings, [{ name: "HANDLE_ACTOR", class_name: "HandleActor" }]);
    assert.deepEqual(prod.triggers, { crons: ["* * * * *"] });
    assert.equal(prod.queues.producers[0].queue, "rosie-production-retry");
    assert.equal(prod.queues.consumers[0].dead_letter_queue, "rosie-production-retry-dlq");
    assert.equal(prod.r2_buckets[0].bucket_name, "rosie-production-files");
    assert.match(prod.kv_namespaces[0].id, /^0{31}1$/);
    assert.match(prod.hyperdrive[0].id, /^0{31}2$/);
  });

  it("keeps the production route as a comment: none in the parsed config, one in the text", () => {
    assert.equal(config.env.production.routes, undefined);
    assert.equal(config.env.production.route, undefined);
    assert.equal(config.routes, undefined);
    assert.match(raw, /^\s*\/\/ "routes": \[/m);
  });

  it("leaves staging's and the top level's own settings as they were", () => {
    assert.equal(config.name, "rosie");
    assert.equal(config.env.staging.name, "rosie-staging");
    assert.deepEqual(
      config.env.staging.kv_namespaces.map((kv) => kv.binding),
      ["BUNDLES"],
    );
    assert.equal(config.env.staging.hyperdrive, undefined);
    assert.deepEqual(
      config.env.staging.routes.map((r) => r.pattern),
      ["rosfield.com/test", "rosfield.com/test/*"],
    );
  });

  it("sets LINK_HOST in each environment, and gives env.staging its own FILES bucket, never production's (T-1235)", () => {
    assert.equal(config.vars.LINK_HOST, LINK_HOST);
    assert.equal(config.env.staging.vars.LINK_HOST, LINK_HOST);
    assert.equal(config.env.production.vars.LINK_HOST, LINK_HOST);
    assert.deepEqual(config.env.staging.r2_buckets, [
      { binding: "FILES", bucket_name: "rosie-staging-files" },
    ]);
    assert.deepEqual(config.env.production.r2_buckets, [
      { binding: "FILES", bucket_name: "rosie-production-files" },
    ]);
  });

  it("holds no var that looks like a key and no secret value anywhere in the file", () => {
    assert.deepEqual(config.env.production.secrets, { required: [] });
    const patterns = [
      /sk_(live|test)_[A-Za-z0-9]{10,}/,
      /pk_live_[A-Za-z0-9]{10,}/,
      /AKIA[0-9A-Z]{16}/,
      /gh[pousr]_[A-Za-z0-9]{30,}/,
      /xox[baprs]-[A-Za-z0-9-]{10,}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/,
      /re_[A-Za-z0-9]{20,}/,
      /postgres(ql)?:\/\//i,
      /(api[_-]?key|secret|token|password)["']?\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{16,}["']/i,
    ];
    for (const re of patterns) assert.ok(!re.test(raw), `wrangler.jsonc matches ${re}`);
  });
});

describe("env.production checks catch a broken copy", () => {
  const broken = (change) => {
    const copy = structuredClone(config);
    change(copy);
    return productionProblems(copy);
  };

  it("fail when env.production is missing", () => {
    assert.notDeepEqual(
      broken((c) => delete c.env.production),
      [],
    );
  });
  it("fail when the Worker name equals staging's", () => {
    assert.notDeepEqual(
      broken((c) => (c.env.production.name = c.env.staging.name)),
      [],
    );
  });
  it("fail on another account, at the top level or in the environment", () => {
    assert.notDeepEqual(
      broken((c) => (c.account_id = "0".repeat(32))),
      [],
    );
    assert.notDeepEqual(
      broken((c) => (c.env.production.account_id = "0".repeat(32))),
      [],
    );
  });
  it("fail when production reuses the staging bucket or a top-level queue", () => {
    assert.notDeepEqual(
      broken((c) => (c.env.production.r2_buckets[0].bucket_name = "rosie-staging-files")),
      [],
    );
    assert.notDeepEqual(
      broken((c) => (c.env.production.queues.producers[0].queue = "rosie-retry")),
      [],
    );
  });
  it("fail on a route", () => {
    assert.notDeepEqual(
      broken((c) => (c.env.production.routes = [{ pattern: "rosfield.com/x", zone_name: "rosfield.com" }])),
      [],
    );
  });
  it("fail on a var that looks like a key, or a secret that is listed with a value", () => {
    assert.notDeepEqual(
      broken((c) => (c.env.production.vars.API_KEY = "abc")),
      [],
    );
    assert.notDeepEqual(
      broken((c) => (c.env.production.vars.GREETING = "sk_live_abcdefghijklmnop")),
      [],
    );
    assert.notDeepEqual(
      broken((c) => (c.env.production.secrets = { required: ["X"] })),
      [],
    );
  });
  it("fail when production's LINK_HOST is missing, another host, or not a bare host", () => {
    const problem = [`env.production.vars.LINK_HOST is not ${LINK_HOST}`];
    assert.deepEqual(
      broken((c) => delete c.env.production.vars.LINK_HOST),
      problem,
    );
    assert.deepEqual(
      broken((c) => (c.env.production.vars.LINK_HOST = "links.example.test")),
      problem,
    );
    assert.ok(broken((c) => (c.env.production.vars.LINK_HOST = "https://rosfield.com")).includes(problem[0]));
  });
  it("fail when a binding is missing", () => {
    assert.notDeepEqual(
      broken((c) => delete c.env.production.hyperdrive),
      [],
    );
    assert.notDeepEqual(
      broken((c) => delete c.env.production.r2_buckets),
      [],
    );
  });
});

// Rosie's own number (T-1304; CQ-253 as DL-542 refines it): staging's Worker gets it only at deploy, by name
// (infra/scripts/deploy-staging.sh's --var ROSIE_NUMBER, from the environment or the git-ignored .dev.vars), since
// the repository is public (DL-436) and no real phone number goes in it. So no section of wrangler.jsonc names
// ROSIE_NUMBER, and no line of wrangler.jsonc, package.json or any infra/scripts file holds a phone number outside
// the fiction range: +1, an area code, then 555-0100 to 555-0199, as adapters/src/shared/samples.ts and the Linq
// double read it.
const FICTIONAL_PHONE = /^\+1[2-9][0-9]{2}55501[0-9]{2}$/;
// The ways a number is written: a + and 7 to 15 digits, with spaces, dots, dashes or brackets between them; or a
// North American number without the +: an area code (bracketed or not), an exchange and a line, with a 1 or none.
const PLUS_FORM = /(?<![0-9A-Za-z])\+[1-9](?:[ ().-]{0,2}[0-9]){6,14}(?![0-9])/g;
const NANP_FORM =
  /(?<![0-9A-Za-z+])(?:1[ .-]?)?(?:\([2-9][0-9]{2}\)|[2-9][0-9]{2})[ .-]?[2-9][0-9]{2}[ .-]?[0-9]{4}(?![0-9A-Za-z])/g;

/** Every phone number a line holds, each once, in E.164 form. */
function phoneNumbersIn(line) {
  const numbers = new Set();
  for (const [match] of line.matchAll(PLUS_FORM)) numbers.add(`+${match.replace(/[^0-9]/g, "")}`);
  for (const [match] of line.matchAll(NANP_FORM)) numbers.add(`+1${match.replace(/[^0-9]/g, "").slice(-10)}`);
  return [...numbers];
}

/** "<file>:<line>" for each line of the files (name to text) that holds a number outside the fiction range. */
function outsideFiction(files) {
  const found = [];
  for (const [name, text] of Object.entries(files)) {
    text.split("\n").forEach((line, index) => {
      if (phoneNumbersIn(line).some((number) => !FICTIONAL_PHONE.test(number)))
        found.push(`${name}:${index + 1}`);
    });
  }
  return found;
}

describe("Rosie's own number in no tracked config (T-1304)", () => {
  it("is named in no section of wrangler.jsonc: no var and no secret, at the top level or in either environment", () => {
    for (const [where, section] of [
      ["the top level", config],
      ["env.staging", config.env.staging],
      ["env.production", config.env.production],
    ]) {
      assert.ok(!Object.hasOwn(section.vars ?? {}, "ROSIE_NUMBER"), `${where}'s vars name ROSIE_NUMBER`);
      assert.ok(
        !(section.secrets?.required ?? []).includes("ROSIE_NUMBER"),
        `${where} requires ROSIE_NUMBER`,
      );
    }
  });

  it("finds no phone number outside the fiction range in wrangler.jsonc, package.json or any infra/scripts file", () => {
    const files = {
      "wrangler.jsonc": raw,
      "package.json": readFileSync(path.join(REPO, "package.json"), "utf8"),
    };
    for (const entry of readdirSync(SCRIPTS, { withFileTypes: true })) {
      if (entry.isFile())
        files[`infra/scripts/${entry.name}`] = readFileSync(path.join(SCRIPTS, entry.name), "utf8");
    }
    assert.ok("infra/scripts/deploy-staging.sh" in files);
    assert.deepEqual(outsideFiction(files), []);
  });

  it("reads a number however it is written, as E.164, and no id as a number", () => {
    for (const written of [
      "+15555550142",
      "+1 555 555 0142",
      "+1-555-555-0142",
      "+1 (555) 555-0142",
      "(555) 555-0142",
      "555-555-0142",
      "555.555.0142",
      "5555550142",
      "1-555-555-0142",
      "15555550142",
    ]) {
      assert.deepEqual(phoneNumbersIn(`ROSIE_NUMBER=${written} # Rosie's line`), ["+15555550142"], written);
    }
    assert.deepEqual(phoneNumbersIn('"+15555550199", "(555) 555-0100"'), ["+15555550199", "+15555550100"]);
    assert.deepEqual(phoneNumbersIn(`"${ROSFIELD_ACCOUNT_ID}", "${"0".repeat(31)}1", "2026-11-01"`), []);
  });

  it("lets the fiction range pass, and names the file and line of any other number, never the number", () => {
    assert.deepEqual(outsideFiction({ "a.sh": 'ROSIE_NUMBER="+15555550142"\necho "(555) 555-0199"\n' }), []);
    // Outside the range, yet no one's number: no North American area code starts with 0 or 1, so each number below
    // is a fiction-range line under an area code that cannot exist.
    const copy = structuredClone(config);
    copy.env.staging.vars.ROSIE_NUMBER = "+10555550142";
    const text = JSON.stringify(copy, null, 2);
    const at = text.split("\n").findIndex((line) => line.includes("ROSIE_NUMBER")) + 1;
    const found = outsideFiction({
      "wrangler.jsonc": text,
      "deploy.sh": 'set -e\n--var "ROSIE_NUMBER:+1 155 555 0142"\n',
    });
    assert.deepEqual(found, [`wrangler.jsonc:${at}`, "deploy.sh:2"]);
    assert.ok(found.every((place) => !place.includes("0142")));
  });
});
