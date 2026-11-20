// Tests for bundle v1.1 (T-1501): check.mjs's checks 1 to 6 on bundles/v1.1/bundle/ and its KV bulk file, with no
// database; build.mjs's derivation gives the folder's bytes; and each pure check fails on what it must refuse. Run from
// the repository root: node --test bundles/v1.1/check.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  BUILD,
  BUNDLE_DIR,
  CHANGED,
  PROMPT_KINDS,
  V1_DIR,
  deriveBundle,
  label,
  load,
  promptsFromModules,
  sha256,
  v1PromptsFromModules,
} from "./build.mjs";
import { kvProblems, manifestDifferences, partDifferences, promptProblems, runChecks } from "./check.mjs";

const v1Text = readFileSync(join(V1_DIR, "manifest.json"), "utf8");
const v1Manifest = JSON.parse(v1Text);
const ourText = readFileSync(join(BUNDLE_DIR, "manifest.json"), "utf8");
const manifest = () => JSON.parse(ourText);

describe("bundle v1.1 (T-1501)", () => {
  it("passes checks 1 to 6 with no database, each line ok", async () => {
    const lines = await runChecks();
    const failed = lines.filter((line) => line.ok === false).map((line) => `${String(line.check)}: ${line.what}`);
    assert.deepEqual(failed, []);
    for (const check of [1, 2, 3, 4, 5, 6])
      assert.ok(
        lines.some((line) => line.check === check && line.ok === true),
        `check ${String(check)} ran`,
      );
    assert.ok(!lines.some((line) => line.check === 7), "no database check without --db");
  });

  it("is what build.mjs derives from bundle v1 and prompts.json, byte for byte (nothing reads a clock)", async () => {
    const emit = await load("compiler/src/emit/index.ts");
    const derived = await deriveBundle();
    const written = emit.readBundleDir(BUNDLE_DIR).files;
    assert.deepEqual(
      derived.files.map((file) => file.path),
      written.map((file) => file.path),
    );
    const differ = derived.files
      .filter((file, k) => file.text !== written[k].text)
      .map((file) => file.path);
    assert.deepEqual(differ, []);
    assert.equal(label(derived.bundleId), label(manifest().bundleId));
  });

  it("carries decide-2 as ai/src/decide gives it, under bundle v1's hash with build 2", async () => {
    const decide = await load("ai/src/decide/prompt.ts");
    const ours = manifest();
    assert.deepEqual(Object.keys(ours.prompts[CHANGED]), Object.keys(v1Manifest.prompts[CHANGED]));
    assert.equal(ours.prompts[CHANGED].version, "decide-2");
    assert.equal(ours.prompts[CHANGED].text, decide.DECIDE_2_PROMPT.text);
    assert.equal(ours.prompts[CHANGED].sha256, decide.DECIDE_2_PROMPT.sha256);
    assert.equal(ours.prompts[CHANGED].sha256, sha256(ours.prompts[CHANGED].text));
    assert.equal(v1Manifest.prompts[CHANGED].version, "decide-1");
    assert.equal(v1Manifest.prompts[CHANGED].sha256, decide.DECIDE_PROMPT.sha256);
    assert.equal(ours.bundleId.hash, v1Manifest.bundleId.hash);
    assert.equal(ours.bundleId.build, BUILD);
    assert.equal(BUILD, 2);
    assert.notEqual(label(ours.bundleId), label(v1Manifest.bundleId));
  });
});

describe("check 2: the parts but the manifest are bundle v1's", () => {
  const v1Files = [
    { path: "flow/A.json", text: '{"steps":{}}' },
    { path: "manifest.json", text: '{"v":1}' },
    { path: "trade/barber.json", text: '{"trade":"barber"}' },
  ];

  it("holds when only the manifest differs", () => {
    const files = v1Files.map((file) => (file.path === "manifest.json" ? { ...file, text: '{"v":2}' } : file));
    assert.deepEqual(partDifferences(files, v1Files), []);
  });

  it("fails on one changed byte, a missing part and an extra one", () => {
    const changed = v1Files.map((file) => (file.path === "trade/barber.json" ? { ...file, text: '{"trade":"barbe"}' } : file));
    assert.deepEqual(partDifferences(changed, v1Files), ["trade/barber.json: other bytes than bundle v1's"]);
    assert.deepEqual(partDifferences(v1Files.slice(0, 2), v1Files), ["trade/barber.json: bundle v1's, missing"]);
    assert.deepEqual(partDifferences([...v1Files, { path: "trade/cpa.json", text: "{}" }], v1Files), [
      "trade/cpa.json: not in bundle v1",
    ]);
  });
});

describe("check 3: the manifest is bundle v1's but prompts.decide and the bundle id", () => {
  it("holds for bundle v1.1's manifest, and for bundle v1's own", () => {
    assert.deepEqual(manifestDifferences(manifest(), v1Text), []);
    assert.deepEqual(manifestDifferences(v1Manifest, v1Text), []);
  });

  it("fails on any other change: the built at, another prompt, a stored value's sha256, a lint count", () => {
    const builtAt = manifest();
    builtAt.builtAt = "2026-11-20T00:00:00Z";
    assert.match(manifestDifferences(builtAt, v1Text).join(), /builtAt/);
    const composer = manifest();
    composer.prompts.composer.version = "composer-5";
    assert.match(manifestDifferences(composer, v1Text).join(), /prompts\.composer/);
    const storage = manifest();
    storage.storage.values[0].sha256 = "0".repeat(64);
    assert.match(manifestDifferences(storage, v1Text).join(), /storage/);
    const lint = manifest();
    lint.lint.rules[0].failures += 1;
    assert.match(manifestDifferences(lint, v1Text).join(), /lint/);
  });

  it("fails on a storage key under another bundle id than its own", () => {
    const keys = manifest();
    keys.storage.values[0].key = keys.storage.values[0].key.replace(`/${String(BUILD)}/`, "/9/");
    assert.match(manifestDifferences(keys, v1Text).join(), /storage/);
  });
});

describe("check 4: decide-2 in prompts.decide, bundle v1's other prompts", () => {
  it("holds for bundle v1.1's manifest", async () => {
    const given = await promptsFromModules();
    const v1Given = await v1PromptsFromModules();
    assert.deepEqual(promptProblems(manifest(), v1Manifest, given[CHANGED].prompt, v1Given), []);
    for (const kind of PROMPT_KINDS.filter((each) => each !== CHANGED))
      assert.deepEqual({ ...given[kind].prompt }, { ...v1Given[kind].prompt }, kind);
    assert.notEqual(given[CHANGED].prompt.sha256, v1Given[CHANGED].prompt.sha256);
  });

  it("fails on decide-1, a sha256 that is not the text's, and another prompt changed", async () => {
    const given = await promptsFromModules();
    const v1Given = await v1PromptsFromModules();
    const decide2 = given[CHANGED].prompt;
    const decide1 = manifest();
    decide1.prompts[CHANGED] = structuredClone(v1Manifest.prompts[CHANGED]);
    const one = promptProblems(decide1, v1Manifest, decide2, v1Given);
    assert.ok(one.includes(`prompts.${CHANGED} is decide-1, not decide-2 as its module gives it`), one.join("; "));
    assert.ok(one.includes(`prompts.${CHANGED} is bundle v1's`), one.join("; "));
    const badSha = manifest();
    badSha.prompts[CHANGED].sha256 = "0".repeat(64);
    assert.deepEqual(promptProblems(badSha, v1Manifest, { ...decide2, sha256: "0".repeat(64) }, v1Given), [
      `prompts.${CHANGED}'s sha256 is not its text's`,
    ]);
    const safety = manifest();
    safety.prompts.safetyRead.text += " ";
    assert.deepEqual(promptProblems(safety, v1Manifest, decide2, v1Given), ["prompts.safetyRead is not bundle v1's"]);
  });
});

describe("check 6: the KV bulk file", () => {
  const id = { hash: "a".repeat(64), build: 2 };
  const prefix = `bundle/${id.hash}/2/`;
  const files = [
    { path: "flow/A.json", text: '{"steps":{}}' },
    { path: "manifest.json", text: '{"v":2}' },
  ];
  const entries = [
    { key: `${prefix}flow/A`, value: '{"steps":{}}' },
    { key: `${prefix}manifest`, value: '{"v":2}' },
  ];

  it("holds for one entry per part under the bundle id, each the part's bytes", () => {
    assert.deepEqual(kvProblems(entries, files, id), []);
  });

  it("fails on no file, a key under bundle v1's build, other bytes, and a missing entry", () => {
    assert.deepEqual(kvProblems(null, files, id), ["no KV bulk file entries (run the publish)"]);
    const v1Key = [{ ...entries[0], key: `bundle/${id.hash}/1/flow/A` }, entries[1]];
    assert.deepEqual(kvProblems(v1Key, files, id), [`bundle/${id.hash}/1/flow/A: not under ${prefix}`]);
    const other = [entries[0], { ...entries[1], value: '{"v":1}' }];
    assert.deepEqual(kvProblems(other, files, id), [`${prefix}manifest: not the part's bytes`]);
    assert.deepEqual(kvProblems(entries.slice(0, 1), files, id), ["1 entries for 2 parts"]);
  });
});
