// The harness's own tests for the double loader (T-003). Run by `npm run test:contract`.
// The only double used is the sample one beside these tests; no real port's shape is assumed.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DoubleLoadError, createDoubleLoader, type DoubleSpec } from "./doubles";
import { DOUBLE_SPECS, loadDouble } from "./registry";

const SAMPLE: DoubleSpec = {
  port: "sample",
  module: "tests/contract/_harness/sample/sample-double.ts",
  exports: ["SAMPLE_PORT", "createSampleDouble"],
};
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folderWith(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rosie-doubles-"));
  temporary.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  return dir;
}

describe("loading a double by port name", () => {
  it("imports the module and returns its exports", async () => {
    const loader = createDoubleLoader([SAMPLE]);
    expect(loader.ports()).toEqual(["sample"]);
    expect(loader.spec("sample")).toBe(SAMPLE);
    const loaded = await loader.load("sample");
    expect(loaded.SAMPLE_PORT).toBe("sample");
    const create = loaded.createSampleDouble as () => { calls: string[]; call(input: string): string };
    const double = create();
    expect(double.call("hello")).toBe("sample:hello");
    expect(double.calls).toEqual(["hello"]);
  });

  it("resolves the module from a root other than the repository", async () => {
    const root = folderWith({ "stub.mjs": "export const ping = () => 'pong';\n" });
    const loader = createDoubleLoader([{ port: "stub", module: "stub.mjs", exports: ["ping"] }], { root });
    const loaded = await loader.load("stub");
    expect((loaded.ping as () => string)()).toBe("pong");
  });

  it("refuses an unknown port and lists the registered ones", async () => {
    const loader = createDoubleLoader([SAMPLE]);
    await expect(loader.load("nope")).rejects.toThrow(DoubleLoadError);
    await expect(loader.load("nope")).rejects.toThrow(
      'double for port "nope": no such port is registered (registered: sample)',
    );
  });

  it("refuses a port whose module is not written yet", async () => {
    const loader = createDoubleLoader([
      { port: "later", module: "adapters/later/double.ts", exports: ["x"] },
    ]);
    await expect(loader.load("later")).rejects.toThrow(
      'double for port "later": adapters/later/double.ts is not written yet',
    );
  });

  it("refuses a module that lacks an expected export and names it", async () => {
    const loader = createDoubleLoader([
      { ...SAMPLE, exports: ["SAMPLE_PORT", "createSampleDouble", "reset", "seed"] },
    ]);
    await expect(loader.load("sample")).rejects.toThrow(
      'double for port "sample": tests/contract/_harness/sample/sample-double.ts does not export reset, seed',
    );
  });

  it("does not count an export that is undefined", async () => {
    const root = folderWith({ "empty.mjs": "export const ping = undefined;\n" });
    const loader = createDoubleLoader([{ port: "empty", module: "empty.mjs", exports: ["ping"] }], { root });
    await expect(loader.load("empty")).rejects.toThrow("does not export ping");
  });

  it("wraps an import that throws and keeps the cause", async () => {
    const root = folderWith({ "broken.mjs": "throw new Error('boom');\n" });
    const loader = createDoubleLoader([{ port: "broken", module: "broken.mjs", exports: ["x"] }], { root });
    const error = await loader.load("broken").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DoubleLoadError);
    expect((error as DoubleLoadError).port).toBe("broken");
    expect((error as DoubleLoadError).message).toBe(
      'double for port "broken": broken.mjs could not be imported',
    );
    expect(((error as DoubleLoadError).cause as Error).message).toBe("boom");
  });
});

describe("a double spec", () => {
  const spec = (change: Partial<DoubleSpec>): DoubleSpec => ({ ...SAMPLE, ...change });

  it.each([
    [{ port: "Sample" }, "a port name is lower-case"],
    [{ port: "" }, "a port name is lower-case"],
    [{ module: "/etc/double.ts" }, "must be a relative path inside the repository"],
    [{ module: "../outside/double.ts" }, "must be a relative path inside the repository"],
    [{ module: "adapters/../../x.ts" }, "must be a relative path inside the repository"],
    [{ module: "adapters/double.json" }, "must be a relative path inside the repository"],
    [{ exports: [] }, "name at least one export"],
    [{ exports: ["not valid"] }, '"not valid" is not an export name'],
  ] satisfies [Partial<DoubleSpec>, string][])("is refused when wrong: %j", (change, message) => {
    expect(() => createDoubleLoader([spec(change)])).toThrow(message);
  });

  it("is refused when its port is registered twice", () => {
    expect(() => createDoubleLoader([SAMPLE, SAMPLE])).toThrow(
      'double for port "sample": is registered twice',
    );
  });
});

describe("the registry of real doubles", () => {
  it("does not list the sample double, which is for the harness's own tests", async () => {
    expect(DOUBLE_SPECS.map((spec) => spec.port)).not.toContain("sample");
    await expect(loadDouble("sample")).rejects.toThrow(DoubleLoadError);
  });
});
