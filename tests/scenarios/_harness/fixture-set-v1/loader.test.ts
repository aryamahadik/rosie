// T-007: the loader of fixture set v1 (scenario inputs). Run by `npm run test:scenario`.
// Tests that need a changed folder work on a temporary copy of fixtures/v1; a committed fixture is never edited.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FIXTURES_V1_ROOT, FixtureSetError, loadFixtureSetV1, type FixtureSetV1 } from "./index";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The shops that may have no stop words (T-001 architect ruling; KNOWN-STALE.md). Any other shop without them fails. */
const SHOPS_WITHOUT_STOP_WORDS = ["florist", "laundry", "shoe-repair", "tailor", "upholstery"];
/** The shops whose `messages_never` is empty (their pf.messages is plain text; KNOWN-STALE.md). */
const SHOPS_WITHOUT_MESSAGES_NEVER = ["architect", "art-appraiser", "hunting-guide", "pet-cremation"];

let set: FixtureSetV1;

beforeAll(() => {
  set = loadFixtureSetV1();
});

describe("the demo shops", () => {
  it("loads 243 trade demo shops plus test-mixed-A and test-mixed-B", () => {
    expect(set.root).toBe(FIXTURES_V1_ROOT);
    expect(set.shops).toHaveLength(245);
    expect(set.tradeShops).toHaveLength(243);
    expect(set.mixedShops.map((record) => record.id)).toEqual(["test-mixed-A", "test-mixed-B"]);
    expect(new Set(set.shops.map((record) => record.id)).size).toBe(245);
    expect(set.shop("dentist").shop.name).toBeTruthy();
    expect(() => set.shop("no-such-shop")).toThrow(FixtureSetError);
  });

  it("gives every shop at least one service with a money way", () => {
    for (const record of set.shops) {
      const services = Object.values(record.shop.flows).flatMap((flow) => flow.services);
      expect(services.length, record.id).toBeGreaterThan(0);
      for (const service of services) expect(service.combo, record.id).toMatch(/^[a-z]+\|[a-z]+\|[a-z]+$/);
    }
  });

  it("has stop words on every trade shop except the five the ruling names (G1 applied)", () => {
    const without = set.tradeShops.filter((record) => !record.hasStopWords).map((record) => record.id);
    expect(without).toEqual(SHOPS_WITHOUT_STOP_WORDS);
    for (const record of set.tradeShops) {
      if (SHOPS_WITHOUT_STOP_WORDS.includes(record.id)) continue;
      expect(record.stopWords.length, record.id).toBeGreaterThan(0);
      for (const word of record.stopWords) expect(word.trim(), record.id).not.toBe("");
    }
  });

  it("carries the stop words of a shop whose trade file gave them (dentist)", () => {
    expect(set.shop("dentist").stopWords).toHaveLength(3);
  });

  it("agrees with KNOWN-STALE.md on which shops keep a field empty", () => {
    const gapShops = (field: string): string[] =>
      set.knownGaps
        .filter((gap) => gap.field === field)
        .flatMap((gap) => gap.shops)
        .sort();
    expect(gapShops("safety_stop")).toEqual(SHOPS_WITHOUT_STOP_WORDS);
    expect(gapShops("messages_never")).toEqual(SHOPS_WITHOUT_MESSAGES_NEVER);
    for (const id of SHOPS_WITHOUT_MESSAGES_NEVER) expect(set.shop(id).shop.messages_never, id).toBe("");
    for (const record of set.tradeShops) {
      if (SHOPS_WITHOUT_MESSAGES_NEVER.includes(record.id)) continue;
      expect(record.shop.messages_never ?? "", record.id).not.toBe("");
    }
  });
});

describe("the scenarios", () => {
  it("loads the 56 money combo scenarios, each on a service its shop has", () => {
    expect(set.moneyComboScenarios).toHaveLength(56);
    const aquarium = set.moneyComboScenarios.find((scenario) => scenario.id === "A:list|none|none");
    expect(aquarium).toMatchObject({ shopId: "aquarium", serviceName: "Basic water test", flow: "A" });
    expect(aquarium?.expectations.length).toBeGreaterThanOrEqual(5);
    for (const scenario of set.moneyComboScenarios) {
      const services = set.shop(scenario.shopId).shop.flows[scenario.flow]?.services ?? [];
      expect(
        services.some((s) => s.combo === scenario.combo && s.name === scenario.serviceName),
        scenario.id,
      ).toBe(true);
    }
  });

  it("covers every money combo that coverage.json lists as used", () => {
    const combos = set.moneyComboScenarios.map((scenario) => scenario.id).sort();
    expect(combos).toEqual(Object.keys(set.coverage.used).sort());
    // The combos no profession uses are used by the two mixed shops alone, and their scenarios run there.
    expect(set.coverage.missing).toHaveLength(10);
    for (const id of set.coverage.missing) {
      expect(
        set.coverage.used[id]?.every((shopId) => shopId.startsWith("test-mixed-")),
        id,
      ).toBe(true);
      const scenario = set.moneyComboScenarios.find((s) => s.id === id);
      expect(scenario?.shopId, id).toMatch(/^test-mixed-[AB]$/);
    }
  });

  it("loads the cross-cutting cases with their line numbers in SCENARIOS.md", () => {
    expect(set.crossCuttingScenarios).toHaveLength(17);
    const lines = readFileSync(path.join(FIXTURES_V1_ROOT, "test-kit", "SCENARIOS.md"), "utf8").split("\n");
    for (const scenario of set.crossCuttingScenarios) {
      expect(lines[scenario.line - 1], scenario.id).toBe(
        `- **${scenario.title}**${scenario.ref === null ? "" : ` (${scenario.ref})`}: ${scenario.text}`,
      );
    }
    expect(set.scenarios).toHaveLength(56 + 17);
  });
});

describe("the known-stale lines", () => {
  it("flags test-kit.js lines 176 and 179 (SCENARIOS.md lines 528 and 531), and the noted line 529", () => {
    const listed = set.staleNotes.filter((note) => note.kind === "listed");
    expect(listed.map((note) => [note.testKitJsLine, note.scenariosLine, note.title])).toEqual([
      [179, 531, "First contact"],
      [176, 528, "Change where updates go"],
    ]);
    const noted = set.staleNotes.filter((note) => note.kind === "noted");
    expect(noted.map((note) => [note.testKitJsLine, note.scenariosLine, note.title])).toEqual([
      [null, 529, "Lost phone"],
    ]);
    expect(set.staleScenarios.map((scenario) => scenario.line)).toEqual([528, 529, 531]);
  });

  it("comes back flagged on the scenarios themselves", () => {
    const byLine = (line: number) => set.crossCuttingScenarios.find((scenario) => scenario.line === line);
    expect(byLine(528)?.stale?.useInstead).toContain("C9");
    expect(byLine(528)?.text).toContain("a code goes there");
    expect(byLine(531)?.stale?.useInstead).toContain("no SMS");
    expect(byLine(531)?.text).toContain("one SMS");
    expect(byLine(529)?.stale?.kind).toBe("noted");
    expect(set.crossCuttingScenarios.filter((scenario) => scenario.stale !== null)).toHaveLength(3);
  });

  it("leaves the flagged lines out of the scenarios a test may assert", () => {
    const stale = new Set<string>(set.staleScenarios.map((scenario) => scenario.id));
    expect(stale.size).toBe(3);
    expect(set.assertableScenarios).toHaveLength(set.scenarios.length - 3);
    for (const scenario of set.assertableScenarios) {
      expect(stale.has(scenario.id), scenario.id).toBe(false);
      expect(scenario.stale, scenario.id).toBeNull();
    }
    // Everything else stays in: the other cross-cutting cases and every money combo scenario.
    expect(set.assertableScenarios.filter((scenario) => scenario.type === "cross-cutting")).toHaveLength(14);
    expect(set.assertableScenarios.filter((scenario) => scenario.type === "money-combo")).toHaveLength(56);
  });
});

describe("the check before loading", () => {
  let work = "";
  let copy = "";

  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), "rosie-loader-v1-"));
    copy = path.join(work, "v1");
    cpSync(FIXTURES_V1_ROOT, copy, { recursive: true });
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("loads an unchanged copy and reads only inside that copy", () => {
    const loaded = loadFixtureSetV1({ root: copy });
    expect(loaded.root).toBe(copy);
    expect(loaded.shops).toHaveLength(245);
    expect(loaded.reads.length).toBeGreaterThan(245);
  });

  function flipOneByte(rel: string): void {
    const file = path.join(copy, rel);
    const bytes = readFileSync(file);
    const middle = Math.floor(bytes.length / 2);
    bytes.writeUInt8((bytes.readUInt8(middle) ^ 0x01) & 0xff, middle);
    writeFileSync(file, bytes);
  }

  it.each([
    "test-kit/shops/dentist.json",
    "test-kit/SCENARIOS.md",
    "test-kit/coverage.json",
    "forms/dentist.json",
  ])("refuses to run when verify.mjs fails because a byte of %s changed", (rel) => {
    flipOneByte(rel);
    expect(() => loadFixtureSetV1({ root: copy })).toThrow(FixtureSetError);
    expect(() => loadFixtureSetV1({ root: copy })).toThrow(`changed: ${rel}`);
    expect(() => loadFixtureSetV1({ root: copy })).toThrow("verify.mjs failed");
  });

  it("refuses to run when a demo shop is removed or one is added", () => {
    writeFileSync(path.join(copy, "test-kit", "shops", "extra.json"), "{}\n");
    expect(() => loadFixtureSetV1({ root: copy })).toThrow("not in the manifest: test-kit/shops/extra.json");
    rmSync(path.join(copy, "test-kit", "shops", "extra.json"));
    rmSync(path.join(copy, "test-kit", "shops", "dentist.json"));
    expect(() => loadFixtureSetV1({ root: copy })).toThrow("listed but missing: test-kit/shops/dentist.json");
  });

  it("refuses to run when the manifest itself is damaged", () => {
    writeFileSync(path.join(copy, "MANIFEST.sha256"), "not a hash line\n");
    expect(() => loadFixtureSetV1({ root: copy })).toThrow("verify.mjs failed");
  });
});

describe("where test data is read from", () => {
  /** The loader's own sources: every .ts file here that is not a test. */
  const sources = readdirSync(here)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ name, text: readFileSync(path.join(here, name), "utf8") }));

  it("reads only paths inside fixtures/v1, and only the files the loader uses", () => {
    const allowed = [/^KNOWN-STALE\.md$/, /^test-kit\/SCENARIOS\.md$/, /^test-kit\/coverage\.json$/];
    const shops = /^test-kit\/shops\/[A-Za-z0-9-]+\.json$/;
    const reads = set.reads.filter((rel) => rel !== "test-kit/shops/");
    expect(reads.length).toBe(3 + 245);
    for (const rel of reads) {
      expect(rel.startsWith("/") || rel.split("/").includes(".."), rel).toBe(false);
      expect(allowed.some((pattern) => pattern.test(rel)) || shops.test(rel), rel).toBe(true);
    }
    expect(set.reads).toContain("test-kit/shops/");
  });

  it("has the repository's fixtures/v1 as its only root, and one file that reads from disk", () => {
    expect(path.relative(path.resolve(here, "..", "..", "..", ".."), FIXTURES_V1_ROOT)).toBe(
      path.join("fixtures", "v1"),
    );
    const readers = sources.filter((source) =>
      /\b(readFileSync|readdirSync|readFile|readdir|createReadStream|opendir)\b/.test(source.text),
    );
    expect(readers.map((source) => source.name)).toEqual(["reader.ts"]);
  });

  it("names no path outside fixtures/v1 in the loader's sources", () => {
    expect(sources.map((source) => source.name).sort()).toEqual([
      "index.ts",
      "known-stale.ts",
      "loader.ts",
      "reader.ts",
      "scenarios.ts",
      "shops.ts",
      "types.ts",
    ]);
    const forbidden = [
      /Handover/i,
      /\/Users\//,
      /homedir/,
      /process\.cwd/,
      /\bHOME\b/,
      /\.env/,
      /node_modules/,
      /\bscratch\b/,
    ];
    for (const source of sources) {
      for (const pattern of forbidden) {
        // The comments may explain the rule; the code may not name such a path.
        const code = source.text
          .split("\n")
          .filter((line) => !line.trim().startsWith("//"))
          .join("\n");
        expect(pattern.test(code), `${source.name} matches ${String(pattern)}`).toBe(false);
      }
    }
    // Every path-like text the code spells (outside imports and messages) is one of the paths inside fixtures/v1 below.
    const allowedPaths = new Set([
      "KNOWN-STALE.md",
      "test-kit/SCENARIOS.md",
      "test-kit/coverage.json",
      "test-kit/shops",
      "verify.mjs",
      ".json",
      "/",
    ]);
    const spelled = sources.flatMap((source) =>
      source.text
        .split("\n")
        .filter(
          (line) => !line.trim().startsWith("//") && !/\bfrom\s+"/.test(line) && !/^import\s+"/.test(line),
        )
        .flatMap((line) => [...line.matchAll(/"([A-Za-z0-9_./-]+)"/g)].map((match) => match[1] ?? ""))
        .filter((text) => text.includes("/") || /[.](md|json|mjs|sha256|ts)$/.test(text)),
    );
    expect(spelled).toContain("test-kit/SCENARIOS.md");
    for (const text of spelled) expect(allowedPaths.has(text), text).toBe(true);
  });
});
