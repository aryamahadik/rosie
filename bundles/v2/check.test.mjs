// Tests for bundle v2 (T-1477): check.mjs's checks 1 to 9 on bundles/v2/bundle/ and its KV bulk file, with no database
// and no full build; the manifest carries bundle v1.1's prompts and fixed lines plus signUpOpener; and each pure check
// fails on what it must refuse. Run from the repository root: node --test bundles/v2/check.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  BUILD,
  BUNDLE_DIR,
  NEW_STEPS,
  SIGN_UP_OPENER,
  STEPS,
  V11_DIR,
  V1_DIR,
  label,
  load,
  sha256,
  withSignUpOpener,
} from "./build.mjs";
import {
  NEW_MARKS,
  V1_MARKS,
  fixedLineDifferences,
  kvProblems,
  markProblems,
  promptDifferences,
  runChecks,
  s102Stakes,
  sentLines,
  slotsOf,
  walkProblems,
} from "./check.mjs";

const manifestText = readFileSync(join(BUNDLE_DIR, "manifest.json"), "utf8");
const manifest = () => JSON.parse(manifestText);
const flowText = readFileSync(join(BUNDLE_DIR, "flow", "A.json"), "utf8");
const steps = () => JSON.parse(flowText).steps;
const v11Manifest = JSON.parse(readFileSync(join(V11_DIR, "manifest.json"), "utf8"));
const v1Flow = JSON.parse(readFileSync(join(V1_DIR, "flow", "A.json"), "utf8"));

describe("bundle v2 (T-1477)", () => {
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

  it("holds bundle v1's six steps byte for byte, and S1-08 and S1-09 after S1-04", () => {
    const ours = steps();
    assert.deepEqual([...Object.keys(ours)].sort(), [...STEPS].sort());
    for (const id of Object.keys(v1Flow.steps)) assert.equal(JSON.stringify(ours[id]), JSON.stringify(v1Flow.steps[id]), id);
    assert.equal(ours["S1-04"].next, "S1-08");
    assert.equal(ours["S1-08"].next, "S1-09");
    assert.deepEqual(walkProblems(ours), []);
  });

  it("carries bundle v1.1's prompts (decide-2), models and routing, and its fixed lines plus signUpOpener", async () => {
    const decide = await load("ai/src/decide/prompt.ts");
    const ours = manifest();
    assert.deepEqual(promptDifferences(ours, v11Manifest), []);
    assert.equal(ours.prompts.decide.version, "decide-2");
    assert.equal(ours.prompts.decide.sha256, decide.DECIDE_2_PROMPT.sha256);
    assert.equal(ours.prompts.decide.sha256, sha256(ours.prompts.decide.text));
    assert.notEqual(ours.prompts.decide.sha256, decide.DECIDE_PROMPT.sha256);
    assert.deepEqual(ours.models, v11Manifest.models);
    assert.deepEqual(ours.policy, v11Manifest.policy);
    const lines = ours.lists.fixedLines.lines;
    assert.deepEqual(fixedLineDifferences(lines, v11Manifest.lists.fixedLines.lines), []);
    assert.deepEqual(lines.slice(0, -1), v11Manifest.lists.fixedLines.lines);
    assert.deepEqual(lines.at(-1), {
      id: "signUpOpener",
      text: "Hi! I'm Rosie, an automated assistant.",
      lang: "en",
      status: "asWritten",
      use: "On Rosie's first text to an owner in sign-up, read by the sign-up line, on a step that does not need business, in place of opener, with the privacy-notice link.",
      source:
        "MASTER-FLOW-A.md:28 (S1-02's first words); arch 07 line 361 (S1-02's opener before there is a business); RULES 1.11, 4.3; K-09 v1 finalize-pass.json",
    });
    assert.equal(Object.keys(lines.at(-1)).join(), "id,text,lang,status,use,source");
  });

  it("has a new bundle id, the content hash with build 1", () => {
    const ours = manifest();
    assert.equal(ours.bundleId.build, BUILD);
    assert.equal(BUILD, 1);
    assert.notEqual(ours.bundleId.hash, v11Manifest.bundleId.hash);
    assert.notEqual(label(ours.bundleId), label(v11Manifest.bundleId));
  });

  it("gives S1-02's three options their stakes from their own walk on bundle v2", async () => {
    const emit = await load("compiler/src/emit/index.ts");
    const stakes = await s102Stakes(emit.readBundleDir(BUNDLE_DIR).bundle);
    assert.ok(stakes !== null);
    assert.deepEqual(
      stakes.map((entry) => entry.option),
      ["All on the list", "One isn't on the list yet", "Not a service we book"],
    );
    for (const entry of stakes) assert.ok(entry.stakes === "low" || entry.stakes === "high", entry.option);
  });
});

describe("check 3: the walk from S1-04's answer", () => {
  it("fails when S1-04 or S1-08 lead elsewhere, or S1-09 is not a three-branch split with a safe default", () => {
    const moved = steps();
    moved["S1-04"].next = "S1-10";
    assert.ok(walkProblems(moved).includes("S1-04.next is S1-10, not S1-08"));
    const gone = steps();
    delete gone["S1-08"];
    assert.ok(walkProblems(gone).includes("S1-08 is not held"));
    const twoBranches = steps();
    twoBranches["S1-09"].branches = twoBranches["S1-09"].branches.slice(0, 2);
    assert.ok(walkProblems(twoBranches).some((line) => line.startsWith("S1-09 has 2 branches")));
    const noDefault = steps();
    delete noDefault["S1-09"].card.safeDefault;
    assert.ok(walkProblems(noDefault).includes("S1-09's card has no safe default"));
    const lookup = steps();
    lookup["S1-09"].branches[0].tag = "lookup";
    assert.ok(walkProblems(lookup).some((line) => line.includes("are not message branches")));
  });
});

describe("check 4: the lint marks", () => {
  it("names other marks and missing ones", () => {
    assert.deepEqual(markProblems(V1_MARKS, V1_MARKS), []);
    assert.deepEqual(markProblems([...V1_MARKS, "S1-08 unknown-slot"], V1_MARKS), ["other marks: S1-08 unknown-slot"]);
    assert.deepEqual(markProblems(V1_MARKS.slice(1), V1_MARKS), [`not found: ${V1_MARKS[0]}`]);
  });

  it("states S1-08's and S1-09's marks on those steps alone", () => {
    for (const mark of NEW_MARKS) assert.ok(NEW_STEPS.some((id) => mark.includes(id)), mark);
  });
});

describe("check 5: the slots each line Rosie sends names", () => {
  it("lists a message's slots in order, and only Rosie's messages", () => {
    assert.deepEqual(slotsOf("Hi {{biz.name}}, {{keep:x}} ok"), ["{{biz.name}}", "{{keep:x}}"]);
    assert.deepEqual(slotsOf("no slot"), []);
    const step = {
      say: [
        { from: "owner", to: "san", plainText: "{{owner}}" },
        { from: "san", to: "owner", plainText: "Saved for {{biz.name}}." },
      ],
    };
    assert.deepEqual(
      sentLines(step).map((line) => [line.at, line.to, line.slots]),
      [[1, "owner", ["{{biz.name}}"]]],
    );
  });
});

describe("check 6: the fixed lines are bundle v1.1's plus signUpOpener alone", () => {
  const v11Lines = v11Manifest.lists.fixedLines.lines;

  it("holds for bundle v1.1's lines with signUpOpener last", () => {
    assert.deepEqual(fixedLineDifferences(withSignUpOpener({ lines: v11Lines }).lines, v11Lines), []);
  });

  it("fails on signUpOpener missing, a line changed, a line added, and signUpOpener twice", () => {
    assert.deepEqual(fixedLineDifferences(v11Lines, v11Lines), ["signUpOpener (en) is missing"]);
    const changed = withSignUpOpener({ lines: v11Lines }).lines;
    changed[0] = { ...changed[0], text: `${String(changed[0].text)} ` };
    assert.equal(fixedLineDifferences(changed, v11Lines).length, 1);
    const added = [...withSignUpOpener({ lines: v11Lines }).lines, { ...SIGN_UP_OPENER, id: "otherLine" }];
    assert.deepEqual(fixedLineDifferences(added, v11Lines), ["otherLine (en) is added beyond signUpOpener"]);
    const twice = [...v11Lines, SIGN_UP_OPENER, SIGN_UP_OPENER];
    assert.ok(fixedLineDifferences(twice, v11Lines).includes("a fixed line's id is listed twice in one language"));
    assert.throws(() => withSignUpOpener({ lines: [...v11Lines, SIGN_UP_OPENER] }), /each id is listed once/);
  });
});

describe("check 6: the prompts are bundle v1.1's", () => {
  it("fails on decide-1 and on any other prompt changed", async () => {
    const decide = await load("ai/src/decide/prompt.ts");
    const decide1 = manifest();
    decide1.prompts.decide = {
      version: decide.DECIDE_PROMPT.version,
      sha256: decide.DECIDE_PROMPT.sha256,
      text: decide.DECIDE_PROMPT.text,
    };
    assert.deepEqual(promptDifferences(decide1, v11Manifest), ["prompts.decide is not bundle v1.1's"]);
    const composer = manifest();
    composer.prompts.composer.text += " ";
    assert.deepEqual(promptDifferences(composer, v11Manifest), ["prompts.composer is not bundle v1.1's"]);
  });
});

describe("check 9: the KV bulk file", () => {
  it("fails on a key under bundle v1.1's id", () => {
    const ours = manifest();
    const files = [{ path: "manifest.json", text: manifestText }];
    const entries = [{ key: `bundle/${v11Manifest.bundleId.hash}/2/manifest`, value: manifestText }];
    assert.deepEqual(kvProblems(entries, files, ours.bundleId), [
      `bundle/${v11Manifest.bundleId.hash}/2/manifest: not under bundle/${ours.bundleId.hash}/1/`,
    ]);
  });
});
