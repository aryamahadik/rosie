// Tests for bundle v3 (T-1526): check.mjs's checks 1 to 9 on bundles/v3/bundle/ and its KV bulk file, with no database
// and no full build; the manifest carries bundle v2's prompts (decide-2), models and fixed lines; S1-09's options and
// branches, and the shapes of S1-10, S1-77 and S1-76, as the frontier and the commit's walk read them; and each pure
// check fails on what it must refuse. No model is called. Run from the repository root: node --test
// bundles/v3/check.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BUILD, BUNDLE_DIR, NEW_STEPS, STEPS, V2_DIR, V2_STEPS, label, load, sha256 } from "./build.mjs";
import {
  NEW_MARKS,
  V2_MARKS,
  branchProblems,
  cardOptions,
  fixedLineDifferences,
  graphStepOf,
  kvProblems,
  markProblems,
  promptDifferences,
  runChecks,
  sentLines,
  shapeOf,
  walkOn,
  walkWords,
} from "./check.mjs";

const manifestText = readFileSync(join(BUNDLE_DIR, "manifest.json"), "utf8");
const manifest = () => JSON.parse(manifestText);
const flowText = readFileSync(join(BUNDLE_DIR, "flow", "A.json"), "utf8");
const steps = () => JSON.parse(flowText).steps;
const v2Manifest = JSON.parse(readFileSync(join(V2_DIR, "manifest.json"), "utf8"));
const v2Flow = JSON.parse(readFileSync(join(V2_DIR, "flow", "A.json"), "utf8"));

/** Bundle v3 as the frontier and the walk read it: its manifest and flow A. */
const bundle = () => ({ manifest: manifest(), flows: { A: JSON.parse(flowText) } });

describe("bundle v3 (T-1526)", () => {
  it("passes checks 1 to 9 with no database and no full build, each line ok", async () => {
    const lines = await runChecks();
    const failed = lines.filter((line) => line.ok === false).map((line) => `${String(line.check)}: ${line.what}`);
    assert.deepEqual(failed, []);
    for (const check of [1, 2, 3, 4, 5, 6, 7, 8, 9])
      assert.ok(
        lines.some((line) => line.check === check && line.ok === true),
        `check ${String(check)} ran`,
      );
    assert.ok(!lines.some((line) => line.check === 10 || line.check === 11), "no --full or --db check without the flag");
  });

  it("holds bundle v2's eight steps byte for byte, in v2's order, and S1-77, S1-76 and S1-10", () => {
    const ours = steps();
    assert.deepEqual([...Object.keys(ours)].sort(), [...STEPS].sort());
    assert.deepEqual(Object.keys(v2Flow.steps), Object.keys(ours).filter((id) => V2_STEPS.includes(id)));
    for (const id of V2_STEPS) assert.equal(JSON.stringify(ours[id]), JSON.stringify(v2Flow.steps[id]), id);
    for (const id of NEW_STEPS) assert.ok(ours[id] !== undefined, id);
    assert.deepEqual(branchProblems(ours), []);
  });

  it("carries bundle v2's prompts (decide-2), models, routing and fixed lines byte for byte", async () => {
    const decide = await load("ai/src/decide/prompt.ts");
    const ours = manifest();
    assert.deepEqual(promptDifferences(ours, v2Manifest), []);
    assert.equal(ours.prompts.decide.version, "decide-2");
    assert.equal(ours.prompts.decide.sha256, decide.DECIDE_2_PROMPT.sha256);
    assert.equal(ours.prompts.decide.sha256, sha256(ours.prompts.decide.text));
    assert.notEqual(ours.prompts.decide.sha256, decide.DECIDE_PROMPT.sha256);
    assert.deepEqual(ours.models, v2Manifest.models);
    assert.deepEqual(ours.policy, v2Manifest.policy);
    assert.equal(JSON.stringify(ours.lists.fixedLines), JSON.stringify(v2Manifest.lists.fixedLines));
    assert.equal(ours.lists.fixedLines.lines.at(-1).id, "signUpOpener");
    assert.deepEqual(ours.journeys, []);
  });

  it("has a new bundle id, the content hash with build 1", () => {
    const ours = manifest();
    assert.equal(ours.bundleId.build, BUILD);
    assert.equal(BUILD, 1);
    assert.notEqual(ours.bundleId.hash, v2Manifest.bundleId.hash);
    assert.notEqual(label(ours.bundleId), label(v2Manifest.bundleId));
  });
});

describe("check 3: S1-09's options and branches", () => {
  it("offers S1-09's three card options, each with its fields and stakes, and every branch's target is held", async () => {
    const options = await cardOptions(bundle(), "S1-09");
    assert.ok(options !== null);
    assert.deepEqual(
      options.map((entry) => entry.option),
      steps()["S1-09"].card.means.map((means) => means.branch),
    );
    for (const entry of options) {
      assert.equal(entry.offered, true, entry.option);
      assert.ok(entry.fields.length > 0, entry.option);
      assert.ok(entry.stakes === "low" || entry.stakes === "high", entry.option);
    }
    assert.equal(steps()["S1-09"].next, "S1-10");
  });

  it("fails when a branch goes to a step the bundle does not hold", () => {
    const gone = steps();
    delete gone["S1-77"];
    assert.ok(branchProblems(gone).some((line) => line.includes("S1-77")));
    const noRejoin = steps();
    delete noRejoin["S1-10"];
    assert.equal(branchProblems(noRejoin).filter((line) => line.includes("S1-10")).length, 3);
    const none = steps();
    delete none["S1-09"];
    assert.deepEqual(branchProblems(none), ["S1-09 is not held"]);
  });

  it("walks each S1-09 branch with the commit's walk, and names where it stops or what it refuses", async () => {
    for (const branch of steps()["S1-09"].branches) {
      const walked = await walkOn(bundle(), { kind: "branch", step: "S1-09", branch: branch.label });
      const words = walkWords(walked);
      assert.ok(words.length > 0, branch.label);
      if (walked.error === undefined) assert.equal(walked.moves[0].kind, "branch", branch.label);
    }
    const refused = await walkOn(bundle(), { kind: "branch", step: "S1-09", branch: "No such branch" });
    assert.equal(walkWords(refused), "reads S1-09 in turn; refused branchNotInBundle at S1-09");
  });
});

describe("check 4: the compiled shapes", () => {
  it("reads S1-10, S1-77 and S1-76 as the walk does", async () => {
    for (const id of NEW_STEPS) {
      const shape = shapeOf(await graphStepOf(bundle(), id));
      assert.ok(["walked", "asked", "waits", "lookup", "gated"].includes(shape.kind), id);
    }
    assert.equal(shapeOf(await graphStepOf(bundle(), "S1-75")).kind, "notHeld");
  });

  it("names each shape from the walk's fields", () => {
    const plain = { gated: false, split: false, branches: [], buttons: 0, buttonLabels: [] };
    assert.equal(shapeOf(null).kind, "notHeld");
    assert.equal(shapeOf(plain).kind, "walked");
    assert.equal(shapeOf({ ...plain, buttons: 2, buttonLabels: ["Yes", "No"] }).kind, "asked");
    assert.equal(shapeOf({ ...plain, gated: true }).kind, "gated");
    assert.equal(shapeOf({ ...plain, split: true, branches: [{ tag: "clock" }] }).kind, "waits");
    assert.equal(shapeOf({ ...plain, split: true, branches: [{ tag: "lookup" }, { tag: "message" }] }).kind, "asked");
    assert.equal(shapeOf({ ...plain, split: true, branches: [{ tag: "lookup" }] }).kind, "lookup");
  });
});

describe("check 5: the lint marks", () => {
  it("names other marks and missing ones", () => {
    assert.deepEqual(markProblems(V2_MARKS, V2_MARKS), []);
    assert.deepEqual(markProblems([...V2_MARKS, "S1-10 unknown-slot"], V2_MARKS), ["other marks: S1-10 unknown-slot"]);
    assert.deepEqual(markProblems(V2_MARKS.slice(1), V2_MARKS), [`not found: ${V2_MARKS[0]}`]);
  });

  it("states the new steps' marks on those steps alone", () => {
    for (const mark of NEW_MARKS) assert.ok(NEW_STEPS.some((id) => mark.includes(id)), mark);
  });
});

describe("check 6: the slots each line Rosie sends names", () => {
  it("lists a line for each new step that Rosie sends", () => {
    for (const id of NEW_STEPS) assert.ok(sentLines(steps()[id]).length > 0, id);
  });
});

describe("check 7: the prompts and fixed lines are bundle v2's", () => {
  const v2Lines = v2Manifest.lists.fixedLines.lines;

  it("fails on decide-1 and on any other prompt changed", async () => {
    const decide = await load("ai/src/decide/prompt.ts");
    const decide1 = manifest();
    decide1.prompts.decide = {
      version: decide.DECIDE_PROMPT.version,
      sha256: decide.DECIDE_PROMPT.sha256,
      text: decide.DECIDE_PROMPT.text,
    };
    assert.deepEqual(promptDifferences(decide1, v2Manifest), ["prompts.decide is not bundle v2's"]);
    const composer = manifest();
    composer.prompts.composer.text += " ";
    assert.deepEqual(promptDifferences(composer, v2Manifest), ["prompts.composer is not bundle v2's"]);
  });

  it("fails on a fixed line missing, changed or added", () => {
    assert.deepEqual(fixedLineDifferences(v2Lines, v2Lines), []);
    assert.deepEqual(fixedLineDifferences(v2Lines.slice(0, -1), v2Lines), ["signUpOpener (en) is missing"]);
    const changed = structuredClone(v2Lines);
    changed[0] = { ...changed[0], text: `${String(changed[0].text)} ` };
    assert.equal(fixedLineDifferences(changed, v2Lines).length, 1);
    const added = [...v2Lines, { ...v2Lines.at(-1), id: "otherLine" }];
    assert.deepEqual(fixedLineDifferences(added, v2Lines), ["otherLine (en) is added"]);
  });
});

describe("check 9: the KV bulk file", () => {
  it("fails on a key under bundle v2's id", () => {
    const ours = manifest();
    const files = [{ path: "manifest.json", text: manifestText }];
    const entries = [{ key: `bundle/${v2Manifest.bundleId.hash}/1/manifest`, value: manifestText }];
    assert.deepEqual(kvProblems(entries, files, ours.bundleId), [
      `bundle/${v2Manifest.bundleId.hash}/1/manifest: not under bundle/${ours.bundleId.hash}/1/`,
    ]);
  });
});
