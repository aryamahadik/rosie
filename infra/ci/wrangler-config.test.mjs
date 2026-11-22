// Tests for wrangler.jsonc (T-276): the HANDLE_ACTOR Durable Object binding and its class migration, and that no
// production route or key is added. Run in ci.yml by `node --test "infra/ci/*.test.mjs"`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { REPO } from "./script-harness.mjs";

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

const raw = readFileSync(path.join(REPO, "wrangler.jsonc"), "utf8");
const config = parseJsonc(raw);

describe("wrangler.jsonc BUNDLES KV binding (T-277)", () => {
  it("declares exactly one KV namespace, bound as BUNDLES, with a placeholder id", () => {
    assert.equal(config.kv_namespaces.length, 1);
    const [kv] = config.kv_namespaces;
    assert.deepEqual(Object.keys(kv).sort(), ["binding", "id"]);
    assert.equal(kv.binding, "BUNDLES");
    assert.match(kv.id, /^0{32}$/);
  });

  it("gives env.staging its own BUNDLES binding and adds no other storage binding", () => {
    assert.deepEqual(
      config.env.staging.kv_namespaces.map((kv) => kv.binding),
      ["BUNDLES"],
    );
    for (const k of ["hyperdrive", "d1_databases"]) {
      assert.equal(config[k], undefined);
    }
  });

  it("adds no production route or key", () => {
    assert.equal(config.routes, undefined);
    assert.equal(config.route, undefined);
    assert.deepEqual(config.secrets, { required: [] });
    assert.ok(!/(sk_|token)/i.test(JSON.stringify(config.kv_namespaces)));
  });
});

// R2 (T-1059, T-1235): the top level's r2_buckets may be absent; when present it is exactly one binding named FILES
// with a bucket_name. env.staging names its own copy (T-1235): wrangler does not pass r2_buckets down to an
// environment, and the staging Worker is the one the R2 adapter stores files from (T-438, T-441). It binds FILES to
// staging's private bucket, rosie-staging-files (DL-027), and to nothing else.
const STAGING_FILES = [{ binding: "FILES", bucket_name: "rosie-staging-files" }];

function checkR2(cfg) {
  assert.deepEqual(
    cfg.env.staging.r2_buckets,
    STAGING_FILES,
    "env.staging binds FILES to rosie-staging-files and nothing else",
  );
  if (cfg.r2_buckets === undefined) return;
  assert.ok(Array.isArray(cfg.r2_buckets));
  assert.equal(cfg.r2_buckets.length, 1);
  const [bucket] = cfg.r2_buckets;
  assert.equal(bucket.binding, "FILES");
  assert.equal(typeof bucket.bucket_name, "string");
  assert.notEqual(bucket.bucket_name.trim(), "");
}

describe("wrangler.jsonc R2 FILES binding (T-1059)", () => {
  it("allows no top-level r2_buckets, or exactly one FILES binding with a bucket_name, and gives env.staging its own FILES binding on rosie-staging-files", () => {
    checkR2(config);
  });

  it("accepts an in-memory copy with a top-level FILES binding", () => {
    const copy = structuredClone(config);
    copy.r2_buckets = [{ binding: "FILES", bucket_name: "rosie-files" }];
    checkR2(copy);
  });

  it("rejects an in-memory copy with a second R2 binding", () => {
    const copy = structuredClone(config);
    copy.r2_buckets = [
      { binding: "FILES", bucket_name: "rosie-files" },
      { binding: "OTHER", bucket_name: "rosie-other" },
    ];
    assert.throws(() => checkR2(copy));
  });

  it("rejects an in-memory copy with a binding not named FILES", () => {
    const copy = structuredClone(config);
    copy.r2_buckets = [{ binding: "UPLOADS", bucket_name: "rosie-files" }];
    assert.throws(() => checkR2(copy));
  });

  it("rejects an in-memory copy with a FILES binding that has no bucket_name", () => {
    const copy = structuredClone(config);
    copy.r2_buckets = [{ binding: "FILES" }];
    assert.throws(() => checkR2(copy));
  });

  it("rejects an in-memory copy whose env.staging has no r2_buckets of its own", () => {
    const copy = structuredClone(config);
    copy.r2_buckets = [{ binding: "FILES", bucket_name: "rosie-files" }];
    delete copy.env.staging.r2_buckets;
    assert.throws(() => checkR2(copy), /env\.staging binds FILES to rosie-staging-files/);
  });

  it("rejects an in-memory copy whose env.staging binds another bucket, another name or a second bucket", () => {
    const stagingR2 = (r2) => {
      const copy = structuredClone(config);
      copy.env.staging.r2_buckets = r2;
      return () => checkR2(copy);
    };
    const refused = /env\.staging binds FILES to rosie-staging-files/;
    assert.throws(stagingR2([{ binding: "FILES", bucket_name: "rosie-files-staging" }]), refused);
    assert.throws(stagingR2([{ binding: "FILES", bucket_name: "rosie-production-files" }]), refused);
    assert.throws(stagingR2([{ binding: "UPLOADS", bucket_name: "rosie-staging-files" }]), refused);
    assert.throws(stagingR2([...STAGING_FILES, { binding: "OTHER", bucket_name: "rosie-other" }]), refused);
    assert.throws(stagingR2([]), refused);
  });
});

// The link host (T-1235; the web shell reads it, T-511; Q-51's default: the link host is a config value). Wrangler
// does not pass vars down to an environment, so the top level, env.staging and env.production each set LINK_HOST to
// rosfield.com (DL-014): a bare host as web/src/shell/config.ts reads one, with no scheme, no path and no capitals.
// A link is https://<LINK_HOST><BASE_PATH>/<short code>, so on staging the host plus BASE_PATH is the route staging
// answers on (DL-023, DL-036) and a staging link comes back to the staging Worker.
const LINK_HOST = "rosfield.com";
// web/src/shell/config.ts's HOST: labels of lowercase letters, digits and hyphens joined by dots, then a port or none.
const BARE_HOST =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[0-9]{1,5})?$/;

function checkLinkHost(cfg) {
  for (const [where, section] of [
    ["the top level", cfg],
    ["env.staging", cfg.env.staging],
    ["env.production", cfg.env.production],
  ]) {
    const host = section.vars?.LINK_HOST;
    assert.equal(typeof host, "string", `${where} sets LINK_HOST`);
    assert.match(host, BARE_HOST, `${where}'s LINK_HOST is a bare host`);
    assert.equal(host, LINK_HOST, `${where}'s LINK_HOST is ${LINK_HOST}`);
  }
}

function checkStagingLinkBase(cfg) {
  const { vars, routes } = cfg.env.staging;
  const base = `${vars.LINK_HOST}${vars.BASE_PATH}`;
  assert.deepEqual(
    routes.map((r) => r.pattern),
    [base, `${base}/*`],
    "staging's routes are LINK_HOST plus BASE_PATH, and all below it",
  );
}

describe("wrangler.jsonc LINK_HOST (T-1235)", () => {
  it("sets LINK_HOST to rosfield.com, a bare host, at the top level, in env.staging and in env.production", () => {
    checkLinkHost(config);
    assert.equal(config.vars.LINK_HOST, "rosfield.com");
    assert.equal(config.env.staging.vars.LINK_HOST, "rosfield.com");
    assert.equal(config.env.production.vars.LINK_HOST, "rosfield.com");
  });

  it("keeps staging's link base, LINK_HOST plus BASE_PATH, on the route staging answers on", () => {
    checkStagingLinkBase(config);
    assert.equal(
      `${config.env.staging.vars.LINK_HOST}${config.env.staging.vars.BASE_PATH}`,
      "rosfield.com/test",
    );
  });

  it("lists LINK_HOST as a var only, never as a secret", () => {
    for (const section of [config, config.env.staging, config.env.production]) {
      assert.ok(Array.isArray(section.secrets.required));
      assert.ok(!section.secrets.required.includes("LINK_HOST"));
    }
  });

  it("rejects an in-memory copy where the top level or an environment has no LINK_HOST", () => {
    for (const [where, pick] of [
      ["the top level", (c) => c],
      ["env.staging", (c) => c.env.staging],
      ["env.production", (c) => c.env.production],
    ]) {
      const copy = structuredClone(config);
      delete pick(copy).vars.LINK_HOST;
      assert.throws(() => checkLinkHost(copy), new RegExp(`${where.replace(".", "\\.")} sets LINK_HOST`));
    }
  });

  it("rejects an in-memory copy whose LINK_HOST carries a scheme, a path, a capital or nothing", () => {
    for (const host of ["https://rosfield.com", "rosfield.com/test", "rosfield.com/", "Rosfield.com", ""]) {
      const copy = structuredClone(config);
      copy.env.staging.vars.LINK_HOST = host;
      assert.throws(() => checkLinkHost(copy), /env\.staging's LINK_HOST is a bare host/, host);
    }
  });

  it("rejects an in-memory copy where one environment names another host", () => {
    for (const pick of [(c) => c, (c) => c.env.staging, (c) => c.env.production]) {
      const copy = structuredClone(config);
      pick(copy).vars.LINK_HOST = "links.example.test";
      assert.throws(() => checkLinkHost(copy), /LINK_HOST is rosfield\.com/);
    }
  });

  it("rejects an in-memory copy whose staging link base is off staging's routes", () => {
    const moved = structuredClone(config);
    moved.env.staging.vars.LINK_HOST = "links.example.test";
    assert.throws(() => checkStagingLinkBase(moved), /staging's routes are LINK_HOST plus BASE_PATH/);
    const rebased = structuredClone(config);
    rebased.env.staging.vars.BASE_PATH = "";
    assert.throws(() => checkStagingLinkBase(rebased), /staging's routes are LINK_HOST plus BASE_PATH/);
  });
});

// D-018's switch (T-572; DL-940): env.staging's var STAGING_LINQ_LINE, "real", puts staging on Rosie's real Linq line
// for the roster phones (T-1449 reads it; absent or any other value keeps the test-phone line alone). Wrangler does not
// pass vars down, so it is in env.staging alone: never at the top level or in env.production. It is a var, never a
// secret, and staging's vars hold nothing else new: no number, key or secret (those are put by name, and Rosie's number
// is the deploy's --var). Its comment says what it switches and how it rolls back.
const LINQ_LINE = "STAGING_LINQ_LINE";
const STAGING_VARS = ["BASE_PATH", "DB_SCHEMA", "ENVIRONMENT", "LINK_HOST", LINQ_LINE];

function checkLinqLine(cfg) {
  assert.equal(cfg.env.staging.vars[LINQ_LINE], "real", "env.staging's STAGING_LINQ_LINE is real");
  assert.deepEqual(
    Object.keys(cfg.env.staging.vars).sort(),
    STAGING_VARS,
    "env.staging's vars are its four and the switch",
  );
  for (const [where, section] of [
    ["the top level", cfg],
    ["env.production", cfg.env.production],
  ]) {
    assert.ok(!Object.hasOwn(section.vars ?? {}, LINQ_LINE), `${where} names no STAGING_LINQ_LINE`);
  }
  for (const section of [cfg, cfg.env.staging, cfg.env.production]) {
    assert.deepEqual(section.secrets, { required: [] }, "a section requires a secret");
  }
}

describe("wrangler.jsonc env.staging's STAGING_LINQ_LINE (T-572)", () => {
  it('is "real" in env.staging\'s vars alone, beside its four vars, and no section requires a secret', () => {
    checkLinqLine(config);
  });

  it("is commented in place: D-018's switch, and its rollback", () => {
    assert.match(raw, /^\s*\/\/ STAGING_LINQ_LINE is D-018's switch \(T-572; DL-940; T-1449 reads it\)/m);
    assert.match(
      raw,
      /^\s*\/\/ Rollback: remove this line or set it to "double", then npm run deploy:staging\.$/m,
    );
    assert.equal(raw.split(`"${LINQ_LINE}"`).length - 1, 1, "wrangler.jsonc names the switch once as a key");
  });

  it("rejects an in-memory copy that turns the switch off, names it elsewhere, or adds a var or a secret beside it", () => {
    const broken = (change) => {
      const copy = structuredClone(config);
      change(copy);
      return () => checkLinqLine(copy);
    };
    assert.throws(
      broken((c) => (c.env.staging.vars[LINQ_LINE] = "double")),
      /STAGING_LINQ_LINE is real/,
    );
    assert.throws(
      broken((c) => delete c.env.staging.vars.STAGING_LINQ_LINE),
      /STAGING_LINQ_LINE is real/,
    );
    assert.throws(
      broken((c) => (c.env.production.vars[LINQ_LINE] = "real")),
      /env\.production names no STAGING_LINQ_LINE/,
    );
    assert.throws(
      broken((c) => (c.vars[LINQ_LINE] = "real")),
      /the top level names no STAGING_LINQ_LINE/,
    );
    assert.throws(
      broken((c) => (c.env.staging.vars.STAGING_LINQ_ALLOWLIST = "+15555550150")),
      /its four and the switch/,
    );
    assert.throws(
      broken((c) => (c.env.staging.secrets = { required: ["LINQ_API_TOKEN"] })),
      /requires a secret/,
    );
  });
});

describe("wrangler.jsonc clock-sweep cron trigger (T-278)", () => {
  it("declares exactly one cron, every minute, at the top level", () => {
    assert.deepEqual(config.triggers, { crons: ["* * * * *"] });
  });

  it("gives env.staging its own copy of the cron", () => {
    assert.deepEqual(config.env.staging.triggers, config.triggers);
  });

  it("adds no production route or key", () => {
    assert.equal(config.routes, undefined);
    assert.equal(config.route, undefined);
    assert.deepEqual(config.secrets, { required: [] });
    assert.ok(!/(sk_|key|token)/i.test(JSON.stringify(config.triggers)));
  });
});

describe("wrangler.jsonc retry queue (T-279)", () => {
  it("declares the RETRY_QUEUE producer binding", () => {
    assert.deepEqual(config.queues.producers, [{ queue: "rosie-retry", binding: "RETRY_QUEUE" }]);
  });

  it("declares one consumer with 5 tries and a dead-letter queue", () => {
    assert.deepEqual(config.queues.consumers, [
      { queue: "rosie-retry", max_retries: 5, dead_letter_queue: "rosie-retry-dlq" },
    ]);
    assert.deepEqual(Object.keys(config.queues).sort(), ["consumers", "producers"]);
  });

  it("gives env.staging its own copy of the queues and adds no production route or key", () => {
    assert.deepEqual(config.env.staging.queues, config.queues);
    assert.equal(config.routes, undefined);
    assert.equal(config.route, undefined);
    assert.deepEqual(config.secrets, { required: [] });
    assert.ok(!/(sk_|key|token)/i.test(JSON.stringify(config.queues)));
  });
});

// The test-phone line (T-1186, DL-379, DL-388): env.staging repeats the top level's Durable Object bindings
// and migrations, then adds staging's TEST_PHONE_LINE (class TestPhoneLine) with its own migration tag. Never
// at the top level or in env.production, which never wire the test-phone page (DL-373 gap d). These checks
// come first, so the top-level copy below fails on its own check, not on staging's equality.
const LINE_BINDING = { name: "TEST_PHONE_LINE", class_name: "TestPhoneLine" };
const LINE_MIGRATION = { tag: "v2-test-phone-line", new_sqlite_classes: ["TestPhoneLine"] };

function checkStagingLine(cfg) {
  for (const [where, section] of [
    ["the top level", cfg],
    ["env.production", cfg.env.production],
  ]) {
    const bindings = section.durable_objects?.bindings ?? [];
    assert.ok(
      !bindings.some((b) => b.name === LINE_BINDING.name || b.class_name === LINE_BINDING.class_name),
      `${where} binds no TestPhoneLine`,
    );
    assert.ok(
      !JSON.stringify(section.migrations ?? []).includes(LINE_BINDING.class_name),
      `${where} migrates no TestPhoneLine`,
    );
  }
  assert.deepEqual(cfg.env.staging.durable_objects, {
    bindings: [...cfg.durable_objects.bindings, LINE_BINDING],
  });
  assert.deepEqual(cfg.env.staging.migrations, [...cfg.migrations, LINE_MIGRATION]);
}

/** checkStagingLine on an in-memory copy of wrangler.jsonc after `change`; the file is never written. */
const brokenCopy = (change) => {
  const copy = structuredClone(config);
  change(copy);
  return () => checkStagingLine(copy);
};

describe("wrangler.jsonc HandleActor binding", () => {
  it("declares exactly the HANDLE_ACTOR binding on class HandleActor", () => {
    assert.deepEqual(config.durable_objects, {
      bindings: [{ name: "HANDLE_ACTOR", class_name: "HandleActor" }],
    });
  });

  it("has one migration tag creating HandleActor as a SQLite class", () => {
    assert.equal(config.migrations.length, 1);
    const [m] = config.migrations;
    assert.equal(m.tag, "v1-handle-actor");
    assert.deepEqual(m.new_sqlite_classes, ["HandleActor"]);
    assert.equal(m.new_classes, undefined);
    assert.equal(m.deleted_classes, undefined);
    assert.equal(m.renamed_classes, undefined);
  });

  it("adds no production route or key", () => {
    assert.equal(config.routes, undefined);
    assert.equal(config.route, undefined);
    assert.deepEqual(config.secrets, { required: [] });
    checkStagingLine(config);
    assert.deepEqual(
      config.env.staging.routes.map((r) => r.pattern),
      ["rosfield.com/test", "rosfield.com/test/*"],
    );
    assert.equal(config.vars.ENVIRONMENT, "production");
    assert.ok(!/(sk_|key|token)\s*["']?\s*:/i.test(JSON.stringify(config.vars)));
  });

  it("rejects an in-memory copy that binds the test-phone line at the top level", () => {
    assert.throws(
      brokenCopy((c) => c.durable_objects.bindings.push(LINE_BINDING)),
      /the top level binds no TestPhoneLine/,
    );
  });

  it("rejects an in-memory copy that binds the test-phone line in env.production", () => {
    assert.throws(
      brokenCopy((c) => c.env.production.durable_objects.bindings.push(LINE_BINDING)),
      /env\.production binds no TestPhoneLine/,
    );
  });

  it("rejects an in-memory copy where env.production migrates TestPhoneLine", () => {
    assert.throws(
      brokenCopy((c) => c.env.production.migrations.push(LINE_MIGRATION)),
      /env\.production migrates no TestPhoneLine/,
    );
  });

  it("rejects an in-memory copy where env.staging loses the line, HandleActor or the line's migration", () => {
    assert.throws(brokenCopy((c) => c.env.staging.durable_objects.bindings.pop()));
    assert.throws(brokenCopy((c) => c.env.staging.durable_objects.bindings.shift()));
    assert.throws(brokenCopy((c) => c.env.staging.migrations.pop()));
  });
});

// Workers Logs never store a request URL (T-1527; T-512's security note; DL-1130): a signed link's path is its code
// (A4-42), the sign-in offer carries it in ?link=<code> (T-520), and a link's code never enters a log (K-21
// README:168). Observability stays on for the Worker's own console lines, stored (D-000 reads them by trace id), with
// no invocation log (logs.invocation_logs false: Cloudflare's per-request log, which stores the URL), query strings
// redacted from any URL still kept, and no traces (a span holds the URL too). wrangler passes observability down whole
// (wrangler-dist's inheritable()): an environment with no block of its own gets the top level's, and one with its own
// gets that block alone, never merged. So each section is checked on the block wrangler deploys for it.
const SECTIONS = [
  ["the top level", (c) => c],
  ["env.staging", (c) => c.env.staging],
  ["env.production", (c) => c.env.production],
];

/** The observability block wrangler deploys for a section: its own when it sets one, else the top level's. */
const observabilityOf = (cfg, section) =>
  section === cfg ? cfg.observability : (section.observability ?? cfg.observability);

function checkObservability(cfg) {
  for (const [where, pick] of SECTIONS) {
    const o = observabilityOf(cfg, pick(cfg));
    assert.equal(o?.enabled, true, `${where} keeps observability on`);
    assert.equal(o.logs?.enabled, true, `${where} keeps its own console lines`);
    assert.notEqual(o.logs.persist, false, `${where} stores its own console lines`);
    assert.equal(o.logs.invocation_logs, false, `${where} stores no invocation log`);
    assert.equal(o.redact_query_string, true, `${where} redacts query strings`);
    assert.notEqual(o.traces?.enabled, true, `${where} turns on no traces`);
  }
}

describe("wrangler.jsonc Workers Logs store no request URL (T-1527)", () => {
  it("keeps observability on with invocation_logs false and redact_query_string true, at the top level and as env.staging and env.production get it", () => {
    checkObservability(config);
    assert.deepEqual(config.observability, {
      enabled: true,
      redact_query_string: true,
      logs: { enabled: true, invocation_logs: false },
    });
    // Neither environment sets its own block, so each gets the top level's whole (wrangler's inheritable()).
    assert.equal(config.env.staging.observability, undefined);
    assert.equal(config.env.production.observability, undefined);
  });

  it("says why in place, in the comment right above the one observability block: K-21 README:168 and DL-1130", () => {
    assert.equal(raw.split('"observability"').length - 1, 1, "wrangler.jsonc has one observability block");
    const lines = raw.split("\n");
    const at = lines.findIndex((line) => /^\s*"observability": \{$/.test(line));
    let start = at;
    while (start > 0 && /^\s*\/\//.test(lines[start - 1])) start--;
    const comment = lines.slice(start, at).join(" ");
    for (const says of ["K-21 README:168", "DL-1130", "T-1527", "invocation_logs", "redact_query_string"]) {
      assert.ok(comment.includes(says), `the comment above observability names ${says}`);
    }
  });

  it("accepts an in-memory copy whose env.staging sets its own block with both keys", () => {
    const copy = structuredClone(config);
    copy.env.staging.observability = structuredClone(config.observability);
    checkObservability(copy);
  });

  it("rejects an in-memory copy that stores invocation logs, keeps query strings, turns on traces or turns logs off, in any section", () => {
    const broken = (change) => {
      const copy = structuredClone(config);
      change(copy);
      return () => checkObservability(copy);
    };
    for (const [where, pick] of SECTIONS) {
      const own = (change) =>
        broken((c) => {
          const section = pick(c);
          section.observability = structuredClone(c.observability);
          change(section.observability);
        });
      // An assertion's error reads "AssertionError [ERR_ASSERTION]: <message>" on its first line, and the message is
      // the check's alone.
      const at = (what) => new RegExp(`: ${where.replace(".", "\\.")} ${what}$`, "m");
      assert.throws(
        own((o) => (o.logs.invocation_logs = true)),
        at("stores no invocation log"),
      );
      assert.throws(
        own((o) => delete o.logs.invocation_logs),
        at("stores no invocation log"),
      );
      assert.throws(
        own((o) => (o.redact_query_string = false)),
        at("redacts query strings"),
      );
      assert.throws(
        own((o) => delete o.redact_query_string),
        at("redacts query strings"),
      );
      assert.throws(
        own((o) => (o.traces = { enabled: true })),
        at("turns on no traces"),
      );
      assert.throws(
        own((o) => (o.logs.persist = false)),
        at("stores its own console lines"),
      );
      assert.throws(
        own((o) => (o.logs.enabled = false)),
        at("keeps its own console lines"),
      );
      assert.throws(
        own((o) => (o.enabled = false)),
        at("keeps observability on"),
      );
    }
    // The block as it was before T-1527, `enabled` alone, which stores an invocation log per request.
    assert.throws(
      broken((c) => (c.observability = { enabled: true })),
      /: the top level keeps its own console lines$/m,
    );
    // An environment's own block replaces the top level's whole: one with only `enabled` drops both keys.
    assert.throws(
      broken((c) => (c.env.staging.observability = { enabled: true })),
      /: env\.staging keeps its own console lines$/m,
    );
    // With no block anywhere, the top level fails first.
    assert.throws(
      broken((c) => delete c.observability),
      /: the top level keeps observability on$/m,
    );
  });
});
