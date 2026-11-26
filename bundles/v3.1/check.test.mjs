// Tests for bundle v3.1 (T-1556): check.mjs's checks 1 to 9 and 12 on bundles/v3.1/bundle/ and its KV bulk file, with
// no database and no full build; build.mjs's derivation gives the folder's bytes; prompts.json is bundle v3's but
// decide; and each pure check fails on what it must refuse. No model is called. Run from the repository root:
// node --test bundles/v3.1/check.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  BUILD,
  BUNDLE_DIR,
  CHANGED,
  PROMPTS_FILE,
  PROMPT_KINDS,
  V3_DIR,
  V3_PROMPTS_FILE,
  deriveBundle,
  label,
  load,
  promptsFromModules,
  promptsText,
  sha256,
  v3PromptsFromModules,
} from "./build.mjs";
import {
  V3_CHECKS_AS_THEY_ARE,
  manifestDifferences,
  partDifferences,
  promptProblems,
  runChecks,
} from "./check.mjs";

const v3Text = readFileSync(join(V3_DIR, "manifest.json"), "utf8");
const v3Manifest = JSON.parse(v3Text);
const ourText = readFileSync(join(BUNDLE_DIR, "manifest.json"), "utf8");
const manifest = () => JSON.parse(ourText);

describe("bundle v3.1 (T-1556)", () => {
  it("passes checks 1 to 9 and 12 with no database and no full build, each line ok, bundle v3's own checks among them", async () => {
    const lines = await runChecks();
    const failed = lines.filter((line) => line.ok === false).map((line) => `${String(line.check)}: ${line.what}`);
    assert.deepEqual(failed, []);
    for (const check of [1, 2, 3, 4, 5, 6, 7, 8, 9, 12])
      assert.ok(
        lines.some((line) => line.check === check && line.ok === true),
        `check ${String(check)} ran`,
      );
    assert.ok(!lines.some((line) => line.check === 10 || line.check === 11), "no --full or --db check without the flag");
    assert.deepEqual(V3_CHECKS_AS_THEY_ARE, [1, 2, 3, 4, 5, 6, 9, 10]);
  });

  it("is what build.mjs derives from bundle v3 and prompts.json, byte for byte (nothing reads a clock)", async () => {
    const emit = await load("compiler/src/emit/index.ts");
    const derived = await deriveBundle();
    const written = emit.readBundleDir(BUNDLE_DIR).files;
    assert.deepEqual(
      derived.files.map((file) => file.path),
      written.map((file) => file.path),
    );
    const differ = derived.files.filter((file, k) => file.text !== written[k].text).map((file) => file.path);
    assert.deepEqual(differ, []);
    assert.equal(label(derived.bundleId), label(manifest().bundleId));
  });

  it("carries decide-3 as ai/src/decide gives it, under bundle v3's hash with build 2", async () => {
    const decide = await load("ai/src/decide/prompt.ts");
    const ours = manifest();
    assert.deepEqual(Object.keys(ours.prompts[CHANGED]), Object.keys(v3Manifest.prompts[CHANGED]));
    assert.equal(ours.prompts[CHANGED].version, "decide-3");
    assert.equal(ours.prompts[CHANGED].text, decide.DECIDE_3_PROMPT.text);
    assert.equal(ours.prompts[CHANGED].sha256, decide.DECIDE_3_PROMPT.sha256);
    assert.equal(ours.prompts[CHANGED].sha256, "17728e880dc94681556a1de4f24ccdcf70c8e2598718247a0e8a93dc64070b09");
    assert.equal(ours.prompts[CHANGED].sha256, sha256(ours.prompts[CHANGED].text));
    assert.equal(v3Manifest.prompts[CHANGED].version, "decide-2");
    assert.equal(v3Manifest.prompts[CHANGED].sha256, decide.DECIDE_2_PROMPT.sha256);
    assert.equal(ours.bundleId.hash, v3Manifest.bundleId.hash);
    assert.equal(ours.bundleId.build, BUILD);
    assert.equal(BUILD, 2);
    assert.notEqual(label(ours.bundleId), label(v3Manifest.bundleId));
  });

  it("writes prompts.json as bundle v3's but decide, byte for byte", async () => {
    const given = await promptsFromModules();
    const v3Bytes = readFileSync(V3_PROMPTS_FILE, "utf8");
    const ours = readFileSync(PROMPTS_FILE, "utf8");
    assert.equal(ours, promptsText(v3Bytes, given[CHANGED].prompt));
    const v3Decide = JSON.parse(v3Bytes)[CHANGED];
    assert.equal(promptsText(ours, v3Decide), v3Bytes);
    assert.throws(() => promptsText(v3Bytes.trimEnd(), given[CHANGED].prompt), /not in the form/);
  });
});

describe("check 12: only the decide prompt differs from bundle v3", () => {
  const v3Files = [
    { path: "flow/A.json", text: '{"steps":{}}' },
    { path: "manifest.json", text: '{"v":1}' },
    { path: "trade/barber.json", text: '{"trade":"barber"}' },
  ];

  it("holds when only the manifest differs", () => {
    const files = v3Files.map((file) => (file.path === "manifest.json" ? { ...file, text: '{"v":2}' } : file));
    assert.deepEqual(partDifferences(files, v3Files), []);
  });

  it("fails on one changed byte, a missing part and an extra one", () => {
    const changed = v3Files.map((file) => (file.path === "trade/barber.json" ? { ...file, text: '{"trade":"barbe"}' } : file));
    assert.deepEqual(partDifferences(changed, v3Files), ["trade/barber.json: other bytes than bundle v3's"]);
    assert.deepEqual(partDifferences(v3Files.slice(0, 2), v3Files), ["trade/barber.json: bundle v3's, missing"]);
    assert.deepEqual(partDifferences([...v3Files, { path: "trade/cpa.json", text: "{}" }], v3Files), [
      "trade/cpa.json: not in bundle v3",
    ]);
  });

  it("holds for bundle v3.1's manifest, and for bundle v3's own", () => {
    assert.deepEqual(manifestDifferences(manifest(), v3Text), []);
    assert.deepEqual(manifestDifferences(v3Manifest, v3Text), []);
  });

  it("fails on any other change: the built at, another prompt, a fixed line, a stored value's sha256, a lint count", () => {
    const builtAt = manifest();
    builtAt.builtAt = "2026-11-26T00:00:00Z";
    assert.match(manifestDifferences(builtAt, v3Text).join(), /builtAt/);
    const composer = manifest();
    composer.prompts.composer.version = "composer-5";
    assert.match(manifestDifferences(composer, v3Text).join(), /prompts\.composer/);
    const fixed = manifest();
    fixed.lists.fixedLines.lines.pop();
    assert.match(manifestDifferences(fixed, v3Text).join(), /lists/);
    const storage = manifest();
    storage.storage.values[0].sha256 = "0".repeat(64);
    assert.match(manifestDifferences(storage, v3Text).join(), /storage/);
    const lint = manifest();
    lint.lint.rules[0].failures += 1;
    assert.match(manifestDifferences(lint, v3Text).join(), /lint/);
  });

  it("fails on a storage key under another bundle id than its own", () => {
    const keys = manifest();
    keys.storage.values[0].key = keys.storage.values[0].key.replace(`/${String(BUILD)}/`, "/9/");
    assert.match(manifestDifferences(keys, v3Text).join(), /storage/);
  });
});

describe("check 7: decide-3 in prompts.decide, bundle v3's other prompts", () => {
  it("holds for bundle v3.1's manifest", async () => {
    const given = await promptsFromModules();
    const v3Given = await v3PromptsFromModules();
    assert.deepEqual(promptProblems(manifest(), v3Manifest, given[CHANGED].prompt, v3Given), []);
    for (const kind of PROMPT_KINDS.filter((each) => each !== CHANGED))
      assert.deepEqual({ ...given[kind].prompt }, { ...v3Given[kind].prompt }, kind);
    assert.notEqual(given[CHANGED].prompt.sha256, v3Given[CHANGED].prompt.sha256);
  });

  it("fails on decide-2 (bundle v3's), decide-1, a sha256 that is not the text's, and another prompt changed", async () => {
    const decide = await load("ai/src/decide/prompt.ts");
    const given = await promptsFromModules();
    const v3Given = await v3PromptsFromModules();
    const decide3 = given[CHANGED].prompt;
    const decide2 = manifest();
    decide2.prompts[CHANGED] = structuredClone(v3Manifest.prompts[CHANGED]);
    const two = promptProblems(decide2, v3Manifest, decide3, v3Given);
    assert.ok(two.includes(`prompts.${CHANGED} is decide-2, not decide-3 as its module gives it`), two.join("; "));
    assert.ok(two.includes(`prompts.${CHANGED} is bundle v3's`), two.join("; "));
    const decide1 = manifest();
    decide1.prompts[CHANGED] = {
      version: decide.DECIDE_PROMPT.version,
      sha256: decide.DECIDE_PROMPT.sha256,
      text: decide.DECIDE_PROMPT.text,
    };
    const one = promptProblems(decide1, v3Manifest, decide3, v3Given);
    assert.ok(one.includes(`prompts.${CHANGED} is decide-1, not decide-3 as its module gives it`), one.join("; "));
    const badSha = manifest();
    badSha.prompts[CHANGED].sha256 = "0".repeat(64);
    assert.deepEqual(promptProblems(badSha, v3Manifest, { ...decide3, sha256: "0".repeat(64) }, v3Given), [
      `prompts.${CHANGED}'s sha256 is not its text's`,
    ]);
    const safety = manifest();
    safety.prompts.safetyRead.text += " ";
    assert.deepEqual(promptProblems(safety, v3Manifest, decide3, v3Given), ["prompts.safetyRead is not bundle v3's"]);
  });
});
