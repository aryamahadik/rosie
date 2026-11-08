// T-134: the guard's keyword list. Proofs of the card:
//   - the opt-out list has exactly msgtext.js OPTOUT's 16 words (line 29 of the vendored copy), in its order;
//   - the emitted keywords.json validates against K-01 v1's keywords with Ajv, and equals the contract's fixture
//     contracts/bundle/fixtures/keywords.json in shape (and, as emitted, byte for byte).
//
// The reference side does not use the module under test: it reads msgtext.js's line 29 by its number, and asks
// msgtext.js itself, as lib.js loads it, which button labels are opt-out words (uiProblems, line 95: a button that is
// only an opt-out word would stop the texts).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { makeCjsLoader } from "../overlay/cjs-load";
import { BUILD_DIR } from "../overlay/core";
import { MSGTEXT_FILE, buildKeywords, keywordsJson, parseOptOut, readOptOut } from "./index";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = `${ROOT}contracts/bundle/fixtures/keywords.json`;

type Obj = Record<string, unknown>;

/** msgtext.js's shape checks as step.js's library reaches them: lib.js's MSG, from a loader of the test's own. */
const MSG = (makeCjsLoader()(`${BUILD_DIR}lib.js`) as { MSG: { uiProblems(elements: unknown): string[] } })
  .MSG;

/** Whether msgtext.js refuses `label` as a button because it is an opt-out word (msgtext.js line 95). */
function refusedAsOptOut(label: string): boolean {
  return MSG.uiProblems({ buttons: [label] }).some((problem) => problem.includes("is an opt-out word"));
}

/** msgtext.js's line 29, read by its number, and the list it holds. */
function line29(): { text: string; words: unknown } {
  const text = readFileSync(`${BUILD_DIR}msgtext.js`, "utf8").split("\n")[28] ?? "";
  return { text, words: JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) };
}

describe("the opt-out words are msgtext.js's OPTOUT", () => {
  it("are the 16 words of msgtext.js line 29, in its order", () => {
    const reference = line29();
    expect(reference.text).toMatch(/^\s*var OPTOUT = \[/);
    const read = readOptOut();
    expect(read.words).toEqual(reference.words);
    expect(read.words).toHaveLength(16);
    expect(new Set(read.words).size).toBe(16);
    expect(read.line).toBe(29);
    expect(read.file).toBe(MSGTEXT_FILE);
    expect(MSGTEXT_FILE).toBe(`${BUILD_DIR}msgtext.js`);
    expect(buildKeywords().optOut).toEqual(reference.words);
  });

  it("are each a label msgtext.js itself refuses as a button, in any case; START, HELP and longer labels are not", () => {
    const { words } = readOptOut();
    for (const word of words) {
      expect(refusedAsOptOut(word), word).toBe(true);
      expect(refusedAsOptOut(` ${word.toLowerCase()} `), word).toBe(true);
    }
    for (const label of [
      "START",
      "HELP",
      "Start",
      "Cancel visit",
      "Stop texts",
      "STOP ALL",
      "OPT-OUT",
      "Parar ya",
    ])
      expect(refusedAsOptOut(label), label).toBe(false);
  });

  it("refuses a script whose OPTOUT line is missing or doubled, or does not hold a list of words, each once", () => {
    const line = 'var OPTOUT = ["STOP", "FIN"];';
    expect(parseOptOut(`a\n  ${line}\nb`, "x.js")).toEqual({ words: ["STOP", "FIN"], file: "x.js", line: 2 });
    expect(() => parseOptOut("var KEYS = [];", "x.js")).toThrow(
      /x\.js: expected one "var OPTOUT = \[\.\.\.\]" line, found 0/,
    );
    expect(() => parseOptOut(`${line}\n${line}`, "x.js")).toThrow(/found 2/);
    expect(() => parseOptOut("var OPTOUT = [STOP];", "x.js")).toThrow(
      /x\.js line 1: OPTOUT is not a list of quoted words/,
    );
    expect(() => parseOptOut("var OPTOUT = [];", "x.js")).toThrow(/OPTOUT is not a list of words/);
    expect(() => parseOptOut('var OPTOUT = ["STOP", 3];', "x.js")).toThrow(/OPTOUT is not a list of words/);
    expect(() => parseOptOut('var OPTOUT = ["STOP", " "];', "x.js")).toThrow(/OPTOUT is not a list of words/);
    expect(() => parseOptOut('var OPTOUT = ["STOP", "STOP"];', "x.js")).toThrow(/OPTOUT names a word twice/);
  });

  it("gives each caller its own copy", () => {
    const first = readOptOut();
    first.words.length = 0;
    expect(readOptOut().words).toHaveLength(16);
  });
});

describe("the keyword list is K-01 v1's keywords", () => {
  const schema = JSON.parse(readFileSync(`${ROOT}contracts/bundle/bundle.v1.schema.json`, "utf8")) as Obj;
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  ajv.addSchema(JSON.parse(readFileSync(`${ROOT}contracts/common/formats.v1.schema.json`, "utf8")) as Obj);
  ajv.addSchema(schema);
  const validate = ajv.getSchema(
    "https://rosie.invalid/contracts/bundle/bundle.v1.schema.json#/$defs/keywords",
  );
  if (validate === undefined) throw new Error("bundle.v1.schema.json has no $defs/keywords");

  it("validates against $defs/keywords with Ajv, as emitted", () => {
    const emitted: unknown = JSON.parse(keywordsJson());
    const ok = validate(emitted);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("is not a vacuous check: a wrong list is refused", () => {
    const good = buildKeywords();
    expect(validate({ ...good, optOut: good.optOut.slice(1) })).toBe(false);
    expect(validate({ ...good, optOut: [...good.optOut.slice(1), "HALT"] })).toBe(false);
    expect(validate({ ...good, optOut: good.optOut.map((word) => word.toLowerCase()) })).toBe(false);
    expect(validate({ ...good, start: "Start" })).toBe(false);
    expect(validate({ ...good, flagsVisit: ["STOP"] })).toBe(false);
    expect(validate({ start: good.start, help: good.help, optOut: good.optOut })).toBe(false);
    expect(validate({ ...good, extra: [] })).toBe(false);
  });

  it("equals the contract's fixture keywords.json: the same shape, the same words, byte for byte as emitted", () => {
    const fixtureText = readFileSync(FIXTURE, "utf8");
    const fixture = JSON.parse(fixtureText) as Obj;
    const emitted = JSON.parse(keywordsJson()) as Obj;
    expect(Object.keys(emitted)).toEqual(Object.keys(fixture));
    for (const key of Object.keys(fixture)) expect(typeof emitted[key], key).toBe(typeof fixture[key]);
    expect(emitted).toEqual(fixture);
    expect(keywordsJson()).toBe(fixtureText);
  });

  it("holds START, HELP and the opt-out words: the guard keywords K-01 names, each once", () => {
    const keywords = buildKeywords();
    const defs = schema.$defs as Record<string, { enum?: string[] }>;
    expect([keywords.start, keywords.help, ...keywords.optOut]).toEqual(defs.guardKeyword?.enum);
    expect(keywords.optOut).not.toContain("START");
    expect(keywords.optOut).not.toContain("HELP");
  });

  it("flags the visit for CANCEL and CANCELAR, both opt-out words", () => {
    const keywords = buildKeywords();
    expect(keywords.flagsVisit).toEqual(["CANCEL", "CANCELAR"]);
    for (const word of keywords.flagsVisit) expect(keywords.optOut).toContain(word);
  });

  it("is built fresh each time, so one caller's change never reaches another's", () => {
    const first = buildKeywords();
    first.optOut.length = 0;
    first.flagsVisit.push("STOP");
    const second = buildKeywords();
    expect(second.optOut).toHaveLength(16);
    expect(second.flagsVisit).toEqual(["CANCEL", "CANCELAR"]);
  });
});
