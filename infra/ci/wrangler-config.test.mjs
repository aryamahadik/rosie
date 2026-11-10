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

// R2 (T-1059): r2_buckets may be absent; when present it is exactly one top-level binding named FILES with a
// bucket_name, and env.staging has no copy of its own (T-441 adds the binding).
function checkR2(cfg) {
  assert.equal(cfg.env.staging.r2_buckets, undefined);
  if (cfg.r2_buckets === undefined) return;
  assert.ok(Array.isArray(cfg.r2_buckets));
  assert.equal(cfg.r2_buckets.length, 1);
  const [bucket] = cfg.r2_buckets;
  assert.equal(bucket.binding, "FILES");
  assert.equal(typeof bucket.bucket_name, "string");
  assert.notEqual(bucket.bucket_name.trim(), "");
}

describe("wrangler.jsonc R2 FILES binding (T-1059)", () => {
  it("allows no r2_buckets, or exactly one FILES binding with a bucket_name and no env.staging copy", () => {
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

  it("rejects an in-memory copy with an env.staging r2_buckets", () => {
    const copy = structuredClone(config);
    copy.r2_buckets = [{ binding: "FILES", bucket_name: "rosie-files" }];
    copy.env.staging.r2_buckets = [{ binding: "FILES", bucket_name: "rosie-files-staging" }];
    assert.throws(() => checkR2(copy));
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
    assert.deepEqual(config.env.staging.durable_objects, config.durable_objects);
    assert.deepEqual(
      config.env.staging.routes.map((r) => r.pattern),
      ["rosfield.com/test", "rosfield.com/test/*"],
    );
    assert.equal(config.vars.ENVIRONMENT, "production");
    assert.ok(!/(sk_|key|token)\s*["']?\s*:/i.test(JSON.stringify(config.vars)));
  });
});
