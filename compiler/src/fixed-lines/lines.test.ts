// T-1146: the bundle's fixed lines (compiler/src/fixed-lines). The card's first check:
//   - privacyLink and the Spanish optOutLine are emitted with their sources: the Spanish line is msgtext.js line 32's
//     stop, rates and help, joined by one space; the privacy link is Q-30's default stand-in naming rosfield.com's
//     privacy notice and its address under the environment's base path, asWritten (never pendingJay), its source saying
//     Jay confirms it before production;
//   - K-01 v1's accepted lines go first, each unchanged, their English optOutLine msgtext.js line 31's words;
//   - the list is K-01 v1's fixedLines (Ajv 2020-12, strict), each id once per language.
//
// The reference side does not use the module under test: it reads msgtext.js's lines 31 and 32 by their numbers (as
// msgtext/keywords.test.ts reads line 29), K-01 v1's fixture and schema, and wrangler.jsonc's own text.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { BundleValidationError } from "../emit/validate";
import { BUILD_DIR } from "../overlay/core";
import {
  FixedLinesError,
  basePathIn,
  buildFixedLines,
  composeFixedLines,
  k01FixedLines,
  privacyLinkLine,
  privacyNoticeAddress,
  readBasePath,
  readStopLines,
  type FixedLine,
} from "./index";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

type Obj = Record<string, unknown>;

const readJson = (path: string): Obj => JSON.parse(readFileSync(`${ROOT}${path}`, "utf8")) as Obj;

/** K-01 v1's accepted fixed lines, read here from the fixture itself. */
const K01_LINES = (readJson("contracts/bundle/fixtures/fixed-lines.json") as { lines: FixedLine[] }).lines;

/** msgtext.js's line `n` (from 1), read by its number: its `<lang>: { ... }` words' stop, rates and help, joined by a space. */
function optOutWordsOnLine(n: number, lang: string): { line: string; words: string } {
  const line = readFileSync(`${BUILD_DIR}msgtext.js`, "utf8").split("\n")[n - 1] ?? "";
  const object = new RegExp(`\\b${lang}: \\{[^}]*\\}`).exec(line)?.[0] ?? "";
  const part = (key: string): string => new RegExp(`\\b${key}: "([^"]*)"`).exec(object)?.[1] ?? `(no ${key})`;
  return { line, words: [part("stop"), part("rates"), part("help")].join(" ") };
}

const PRODUCTION = { basePath: "" };
const STAGING = { basePath: "/test" };

const lineOf = (lines: readonly FixedLine[], id: string, lang: string): FixedLine | undefined =>
  lines.find((line) => line.id === id && line.lang === lang);

describe("the Spanish optOutLine: msgtext.js line 32, emitted with its source", () => {
  it("is WORDS.es's stop, rates and help (line 32), joined by one space as stopLine joins them, in Spanish, as written", () => {
    const reference = optOutWordsOnLine(32, "es");
    expect(reference.line).toMatch(/^\s*es: \{ reply: "Responda"/);
    const { lines } = buildFixedLines(PRODUCTION);
    const spanish = lineOf(lines, "optOutLine", "es");
    expect(spanish).toEqual({
      id: "optOutLine",
      text: reference.words,
      lang: "es",
      status: "asWritten",
      use: expect.stringContaining("Spanish") as unknown,
      source: expect.stringMatching(
        /^msgtext\.js line 32 \(WORDS\.es: stop, rates and help, joined by stopLine, line 41\); S13-02/,
      ) as unknown,
    });
    expect(spanish?.text).toBe(
      "Responda STOP para no recibir más. Pueden aplicarse tarifas de mensajes y datos. Responda HELP para recibir ayuda.",
    );
  });

  it("sits beside the English line, which stays K-01 v1's, msgtext.js line 31's words", () => {
    const reference = optOutWordsOnLine(31, "en");
    expect(reference.line).toMatch(/var WORDS = \{ en: \{ reply: "Reply"/);
    const { lines } = buildFixedLines(PRODUCTION);
    expect(lineOf(lines, "optOutLine", "en")).toEqual(lineOf(K01_LINES, "optOutLine", "en"));
    expect(lineOf(lines, "optOutLine", "en")?.text).toBe(reference.words);
    expect(lines.filter((line) => line.id === "optOutLine").map((line) => line.lang)).toEqual(["en", "es"]);
  });

  it("is read from msgtext.js itself: its stopLine() in English and Spanish, and the lines that write them", () => {
    expect(readStopLines()).toEqual({
      en: optOutWordsOnLine(31, "en").words,
      es: optOutWordsOnLine(32, "es").words,
      enLine: 31,
      esLine: 32,
      joinLine: 41,
    });
  });
});

describe("privacyLink: Q-30's default stand-in, emitted with its source", () => {
  it("names rosfield.com's privacy notice and its address, alone as one line, in production", () => {
    const privacy = lineOf(buildFixedLines(PRODUCTION).lines, "privacyLink", "en");
    expect(privacy?.text).toBe("Privacy notice: rosfield.com/privacy");
    expect(privacy?.use).toMatch(
      /^Alone on the last line of Rosie's first text to a handle about one business/,
    );
    expect(privacy?.text).not.toContain("\n");
  });

  it("on staging names the address under BASE_PATH: rosfield.com/test/privacy", () => {
    const privacy = lineOf(buildFixedLines(STAGING).lines, "privacyLink", "en");
    expect(privacy?.text).toBe("Privacy notice: rosfield.com/test/privacy");
    expect(privacy?.source).toContain("(the address under BASE_PATH /test)");
  });

  it("is marked as Q-30's default for Jay to confirm before production, as written and never pendingJay", () => {
    for (const options of [PRODUCTION, STAGING]) {
      const privacy = privacyLinkLine(options.basePath);
      expect(privacy.status).toBe("asWritten");
      expect(privacy.text).not.toBeNull();
      expect(privacy.lang).toBe("en");
      expect(privacy.source).toMatch(/^Q-30's default, for Jay to confirm before production: stand-in words/);
      expect(privacy.source).toContain("RULES 4.3");
      expect(privacy.source).toContain("arch 12 line 644");
    }
  });

  it("takes each environment's base path from wrangler.jsonc: /test on staging, none in production", () => {
    expect(readBasePath("staging")).toBe("/test");
    expect(readBasePath("production")).toBe("");
    const wrangler = readFileSync(`${ROOT}wrangler.jsonc`, "utf8");
    expect(wrangler).toContain('"BASE_PATH": "/test"');
    expect(basePathIn(wrangler, "staging")).toBe("/test");
  });
});

describe("the list as the bundle packs it: K-01 v1's lines, then the two lines added", () => {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  ajv.addSchema(readJson("contracts/common/formats.v1.schema.json"));
  ajv.addSchema(readJson("contracts/bundle/bundle.v1.schema.json"));
  const validate = ajv.getSchema(
    "https://rosie.invalid/contracts/bundle/bundle.v1.schema.json#/$defs/fixedLines",
  );
  if (validate === undefined) throw new Error("bundle.v1.schema.json has no $defs/fixedLines");

  it("keeps K-01 v1's accepted lines first, each unchanged and in order, then optOutLine in Spanish, then privacyLink", () => {
    const { lines } = buildFixedLines(STAGING);
    expect(k01FixedLines()).toEqual(K01_LINES);
    expect(lines.slice(0, K01_LINES.length)).toEqual(K01_LINES);
    expect(lines.slice(K01_LINES.length).map((line) => [line.id, line.lang])).toEqual([
      ["optOutLine", "es"],
      ["privacyLink", "en"],
    ]);
  });

  it("validates against K-01 v1's fixedLines with Ajv, in production and on staging", () => {
    for (const options of [PRODUCTION, STAGING]) {
      const ok = validate(buildFixedLines(options));
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    }
  });

  it("holds each id once per language; optOutLine alone is there in two, English and Spanish", () => {
    const { lines } = buildFixedLines(STAGING);
    const keys = lines.map((line) => `${line.id} ${line.lang}`);
    expect(new Set(keys).size).toBe(keys.length);
    const ids = lines.map((line) => line.id);
    expect(ids.filter((id, k) => ids.indexOf(id) !== k)).toEqual(["optOutLine"]);
  });

  it("is built fresh each call, so one caller's change never reaches another's", () => {
    const first = buildFixedLines(STAGING);
    first.lines.length = 0;
    expect(buildFixedLines(STAGING).lines).toHaveLength(K01_LINES.length + 2);
  });
});

describe("what the module refuses", () => {
  const stop = readStopLines();

  it("a base whose English optOutLine is not msgtext.js's line", () => {
    const changed = K01_LINES.map((line) =>
      line.id === "optOutLine" ? { ...line, text: "Reply STOP to opt out." } : line,
    );
    expect(() => composeFixedLines(changed, stop, STAGING)).toThrow(FixedLinesError);
    expect(() => composeFixedLines(changed, stop, STAGING)).toThrow(
      /optOutLine in English is not msgtext\.js's line/,
    );
    const none = K01_LINES.filter((line) => line.id !== "optOutLine");
    expect(() => composeFixedLines(none, stop, STAGING)).toThrow(/optOutLine in English/);
  });

  it("a base that already holds a line it adds, or holds one id twice in one language", () => {
    expect(() => composeFixedLines([...K01_LINES, privacyLinkLine("")], stop, STAGING)).toThrow(
      /already holds privacyLink in en/,
    );
    const spanish = { ...privacyLinkLine(""), id: "optOutLine", lang: "es" };
    expect(() => composeFixedLines([...K01_LINES, spanish], stop, STAGING)).toThrow(
      /already holds optOutLine in es/,
    );
    const opener = K01_LINES.find((line) => line.id === "opener");
    if (opener === undefined) throw new Error("K-01 v1 has no opener");
    expect(() => composeFixedLines([...K01_LINES, opener], stop, STAGING)).toThrow(
      /opener in en is listed twice/,
    );
  });

  it("a line K-01 v1 refuses", () => {
    const pending = K01_LINES.map((line) =>
      line.id === "opener" ? { ...line, status: "pendingJay" as const } : line,
    );
    expect(() => composeFixedLines(pending, stop, STAGING)).toThrow(BundleValidationError);
  });

  it("a base path that is not '' or /<segment>", () => {
    for (const basePath of ["test", "/test/", "/Test", "/a b", "//test"]) {
      expect(() => privacyNoticeAddress(basePath), basePath).toThrow(FixedLinesError);
      expect(() => buildFixedLines({ basePath }), basePath).toThrow(FixedLinesError);
    }
    expect(privacyNoticeAddress("/test")).toBe("rosfield.com/test/privacy");
  });

  it("a wrangler.jsonc with no base path for the environment, or that does not read as JSON with comments", () => {
    expect(() => basePathIn('{ "env": { "staging": { "vars": {} } } }', "staging")).toThrow(
      /env\.staging\.vars\.BASE_PATH is not set/,
    );
    expect(() =>
      basePathIn('{ "env": { "staging": { "vars": { "BASE_PATH": "test" } } } }', "staging"),
    ).toThrow(/is not a base path/);
    expect(() => basePathIn("{ env: }", "staging")).toThrow(/does not read as JSON with comments/);
    const jsonc =
      '// a comment\n{\n  "env": {\n    "staging": { "vars": { "BASE_PATH": "/test", }, },\n  },\n}\n';
    expect(basePathIn(jsonc, "staging")).toBe("/test");
  });
});
