// The harness's own tests for the fixture checker (T-003). Run by `npm run test:contract`.
// The committed sample/ folder is the good case; every bad case is a copy of it changed in a temporary folder,
// so no bad fixture is ever committed.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkContractFixtures,
  describeContractFixtures,
  type EntryResult,
  type FixtureEntry,
} from "./fixtures";

const SAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "sample");
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface SampleCopy {
  /** The copy's folder (named sample, like the original). */
  dir: string;
  write(file: string, content: string): void;
  /** Rewrites fixtures/index.json through `change`. */
  editIndex(change: (fixtures: FixtureEntry[]) => FixtureEntry[]): void;
}

function copySample(): SampleCopy {
  const parent = mkdtempSync(path.join(tmpdir(), "rosie-harness-"));
  temporary.push(parent);
  const dir = path.join(parent, "sample");
  cpSync(SAMPLE, dir, { recursive: true });
  const write = (file: string, content: string): void => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  };
  return {
    dir,
    write,
    editIndex(change) {
      const indexPath = path.join(dir, "fixtures", "index.json");
      const index = JSON.parse(readFileSync(indexPath, "utf8")) as { fixtures: FixtureEntry[] };
      write("fixtures/index.json", JSON.stringify({ fixtures: change(index.fixtures) }));
    },
  };
}

const entryFor = (file: string, entries: EntryResult[]): EntryResult => {
  const found = entries.find((entry) => entry.file === file);
  if (found === undefined) throw new Error(`no entry for ${file}`);
  return found;
};

const OK_NOTE = '{"note":"n-9","amount":{"cents":100,"currency":"USD"},"kind":"class"}';

// The sample as the contract tests will use the harness: tests registered from the index.
const sampleReport = describeContractFixtures(SAMPLE);

describe("the committed sample contract", () => {
  it("gives one pass and one refusal", () => {
    expect(sampleReport.contract).toBe("sample");
    expect(sampleReport.problems).toEqual([]);
    expect(sampleReport.passes).toBe(1);
    expect(sampleReport.refusals).toBe(1);
    expect(sampleReport.seedRows).toBe(0);
    expect(sampleReport.ok).toBe(true);
    expect(sampleReport.entries.map((entry) => [entry.file, entry.outcome])).toEqual([
      ["note.ok.json", "accepted"],
      ["invalid/note.decimal-cents.json", "refused"],
    ]);
  });
});

describe("a fixture the index does not list", () => {
  it("fails the run", () => {
    const copy = copySample();
    copy.write("fixtures/forgotten.json", OK_NOTE);
    copy.write("fixtures/invalid/also-forgotten.json", "{}");
    const report = checkContractFixtures(copy.dir);
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      "fixtures/forgotten.json is not listed in fixtures/index.json",
      "fixtures/invalid/also-forgotten.json is not listed in fixtures/index.json",
    ]);
  });

  it("is also found when the index lists nothing but the unlisted file exists", () => {
    const copy = copySample();
    copy.editIndex(() => []);
    const report = checkContractFixtures(copy.dir);
    expect(report.ok).toBe(false);
    expect(report.problems).toContain(
      "fixtures/index.json lists no fixture: the contract test would prove nothing",
    );
    expect(report.problems).toContain("fixtures/note.ok.json is not listed in fixtures/index.json");
  });
});

describe("a refused fixture that the schema accepts", () => {
  it("fails the check instead of passing silently", () => {
    const copy = copySample();
    copy.write("fixtures/invalid/note.decimal-cents.json", OK_NOTE);
    const report = checkContractFixtures(copy.dir);
    const entry = entryFor("invalid/note.decimal-cents.json", report.entries);
    expect(report.ok).toBe(false);
    expect(entry.ok).toBe(false);
    expect(entry.outcome).toBe("accepted");
    expect(entry.problems).toEqual([
      "invalid/note.decimal-cents.json must be refused by sample.v1.schema.json (it shows: An amount written with a decimal is refused: money is whole cents), but is accepted",
    ]);
    expect(report.refusals).toBe(0);
  });
});

describe("an accepted fixture that the schema refuses", () => {
  it("fails the check and says why", () => {
    const copy = copySample();
    copy.write(
      "fixtures/note.ok.json",
      '{"note":"n-1","amount":{"cents":1.5,"currency":"USD"},"kind":"visit","extra":1}',
    );
    const report = checkContractFixtures(copy.dir);
    const entry = entryFor("note.ok.json", report.entries);
    expect(report.ok).toBe(false);
    expect(entry.outcome).toBe("refused");
    expect(entry.problems[0]).toBe("note.ok.json must be accepted by sample.v1.schema.json, but is refused:");
    expect(entry.problems.join("\n")).toContain("/amount/cents must be integer");
    expect(entry.problems.join("\n")).toContain("(root) must NOT have additional properties (extra)");
    expect(report.passes).toBe(0);
  });
});

describe("a fixture that cannot be checked", () => {
  it("fails when a listed file does not exist", () => {
    const copy = copySample();
    rmSync(path.join(copy.dir, "fixtures", "note.ok.json"));
    const report = checkContractFixtures(copy.dir);
    expect(report.ok).toBe(false);
    expect(entryFor("note.ok.json", report.entries).problems).toEqual([
      "fixtures/index.json lists note.ok.json, which does not exist",
    ]);
  });

  it("does not count a refused fixture that is not valid JSON as a refusal", () => {
    const copy = copySample();
    copy.write("fixtures/invalid/note.decimal-cents.json", "{ not json");
    const report = checkContractFixtures(copy.dir);
    const entry = entryFor("invalid/note.decimal-cents.json", report.entries);
    expect(report.ok).toBe(false);
    expect(entry.outcome).toBe("error");
    expect(entry.problems[0]).toContain("is not valid JSON");
    expect(report.refusals).toBe(0);
  });

  it("fails when the entry's version is not the schema file's version", () => {
    const copy = copySample();
    copy.editIndex((fixtures) => fixtures.map((entry) => ({ ...entry, version: "v2" })));
    const report = checkContractFixtures(copy.dir);
    expect(report.ok).toBe(false);
    expect(entryFor("note.ok.json", report.entries).problems).toEqual([
      "its schema sample.v2.schema.json does not exist in sample/ (or did not load)",
    ]);
  });

  it("fails when the listed schema is a different version from the entry's", () => {
    const copy = copySample();
    copy.editIndex((fixtures) => fixtures.map((entry) => ({ ...entry, schema: "sample.v1.1.schema.json" })));
    copy.write(
      "sample.v1.1.schema.json",
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://rosie.invalid/contracts/harness-sample/sample.v1.1.schema.json",
      }),
    );
    const report = checkContractFixtures(copy.dir);
    expect(report.ok).toBe(false);
    expect(entryFor("note.ok.json", report.entries).problems).toEqual([
      "is listed for v1 but checked against sample.v1.1.schema.json",
    ]);
  });

  it("fails when a file is listed twice", () => {
    const copy = copySample();
    copy.editIndex((fixtures) => [...fixtures, ...fixtures.slice(0, 1)]);
    const report = checkContractFixtures(copy.dir);
    expect(report.ok).toBe(false);
    expect(report.entries[2]?.problems).toEqual(["note.ok.json is listed twice in fixtures/index.json"]);
  });
});

describe("an entry that names its own schema and def", () => {
  const OTHER = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://rosie.invalid/contracts/harness-sample/other.v1.schema.json",
    $defs: {
      thing: {
        type: "object",
        properties: { n: { type: "integer" } },
        required: ["n"],
        additionalProperties: false,
      },
    },
  };
  const entry = (file: string, expect: "accept" | "refuse", def: string): FixtureEntry => ({
    file,
    version: "v1",
    schema: "other.v1.schema.json",
    def,
    expect,
    shows: "a thing",
    source: "T-003 sample",
  });

  it("checks against that schema's definition, not the contract's root", () => {
    const copy = copySample();
    copy.write("other.v1.schema.json", JSON.stringify(OTHER));
    copy.write("fixtures/thing.ok.json", '{"n":1}');
    copy.write("fixtures/invalid/thing.text.json", '{"n":"one"}');
    copy.editIndex((fixtures) => [
      ...fixtures,
      entry("thing.ok.json", "accept", "thing"),
      entry("invalid/thing.text.json", "refuse", "thing"),
    ]);
    const report = checkContractFixtures(copy.dir);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.passes).toBe(2);
    expect(report.refusals).toBe(2);
    expect(entryFor("thing.ok.json", report.entries).def).toBe("thing");
  });

  it("fails when the def does not exist under $defs", () => {
    const copy = copySample();
    copy.write("other.v1.schema.json", JSON.stringify(OTHER));
    copy.write("fixtures/thing.ok.json", '{"n":1}');
    copy.editIndex((fixtures) => [...fixtures, entry("thing.ok.json", "accept", "missing")]);
    const report = checkContractFixtures(copy.dir);
    expect(report.ok).toBe(false);
    expect(entryFor("thing.ok.json", report.entries).problems).toEqual([
      'other.v1.schema.json has no definition "missing" under $defs',
    ]);
  });
});

describe("a database seed row", () => {
  it("is counted and left to the part's own test", () => {
    const copy = copySample();
    copy.write("fixtures/visit.row.json", '{"id":"x"}');
    copy.editIndex((fixtures) => [
      ...fixtures,
      {
        file: "visit.row.json",
        version: "v1",
        table: "visits",
        expect: "accept",
        shows: "a row",
        source: "T-003 sample",
      },
    ]);
    const report = checkContractFixtures(copy.dir);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.seedRows).toBe(1);
    expect(report.passes).toBe(1);
    expect(entryFor("visit.row.json", report.entries).outcome).toBe("seed-row");
  });
});

describe("an index that cannot be read", () => {
  it("fails when index.json is missing", () => {
    const copy = copySample();
    rmSync(path.join(copy.dir, "fixtures", "index.json"));
    const report = checkContractFixtures(copy.dir);
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toContain("index.json does not exist");
  });

  it("fails when index.json is not JSON", () => {
    const copy = copySample();
    copy.write("fixtures/index.json", "{");
    const report = checkContractFixtures(copy.dir);
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toContain("index.json is not valid JSON");
  });

  it("fails when an entry breaks the index meta-schema", () => {
    const copy = copySample();
    copy.write(
      "fixtures/index.json",
      JSON.stringify({ fixtures: [{ file: "note.ok.json", version: "v1" }] }),
    );
    const report = checkContractFixtures(copy.dir);
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain(
      "fixtures/index.json: /fixtures/0 must have required property 'expect'",
    );
    expect(report.entries).toEqual([]);
  });

  it("fails when the shared index schema cannot be found", () => {
    const copy = copySample();
    const report = checkContractFixtures(copy.dir, { contractsRoot: path.join(copy.dir, "nowhere") });
    expect(report.ok).toBe(false);
    expect(report.problems.at(-1)).toContain("fixtures-index.meta.schema.json is missing");
  });
});

describe("agreement with the architect's contracts:check", () => {
  it("accepts the shared formats' fixtures and the contract tools' own sample", () => {
    for (const contract of ["common", "scripts/test-sample"]) {
      const report = checkContractFixtures(contract);
      expect(report.problems, contract).toEqual([]);
      expect(report.ok, contract).toBe(true);
      expect(report.passes + report.refusals, contract).toBeGreaterThan(0);
    }
  });
});
