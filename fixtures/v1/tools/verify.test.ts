// T-002: fixture set v1 is checked against MANIFEST.sha256 on every branch (no master copy needed).
// Each test works on a temporary copy of fixtures/v1 and runs verify.mjs as a command, as CI and later tasks do.
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const committed = path.resolve(here, "..");
const verify = path.join(here, "verify.mjs");

interface Result {
  status: number;
  output: string;
}

function run(args: string[]): Result {
  try {
    const stdout = execFileSync("node", [verify, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, output: stdout };
  } catch (error) {
    const e = error as { status: number; stdout: string; stderr: string };
    return { status: e.status, output: e.stdout + e.stderr };
  }
}

let work = "";
let root = "";

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "rosie-fixtures-v1-"));
  root = path.join(work, "v1");
  cpSync(committed, root, { recursive: true });
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Changes one byte of a file in the temporary copy. */
function flipOneByte(rel: string): void {
  const file = path.join(root, rel);
  const bytes = readFileSync(file);
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  writeFileSync(file, bytes);
}

const firstFile = (dir: string): string => {
  const name = readdirSync(path.join(root, dir)).sort()[0];
  return `${dir}/${name}`;
};

describe("fixture set v1 verify", () => {
  it("passes on the committed files", () => {
    const result = run(["--root", root]);
    expect(result.output).toContain("OK");
    expect(result.status).toBe(0);
  });

  it("lists forms, test-kit shops and the profession map in the manifest", () => {
    const lines = readFileSync(path.join(root, "MANIFEST.sha256"), "utf8").split("\n").filter(Boolean);
    expect(lines.filter((l) => l.includes("  forms/"))).toHaveLength(243);
    expect(lines.filter((l) => l.includes("  test-kit/shops/"))).toHaveLength(245);
    expect(lines.filter((l) => l.endsWith("  PROFESSION-MAP.md"))).toHaveLength(1);
    for (const line of lines) expect(line).toMatch(/^[0-9a-f]{64} {2}\S/);
  });

  it.each([
    ["a form", () => firstFile("forms")],
    ["a demo shop", () => firstFile("test-kit/shops")],
    ["the coverage file", () => "test-kit/COVERAGE.md"],
    ["the scenarios file", () => "test-kit/SCENARIOS.md"],
    ["the profession map", () => "PROFESSION-MAP.md"],
  ])("fails when one byte of %s changes", (_name, pick) => {
    flipOneByte(pick());
    const result = run(["--root", root]);
    expect(result.status).toBe(1);
    expect(result.output).toContain(`changed: ${pick()}`);
  });

  it("fails when a file is added to forms/, test-kit/ or the folder itself", () => {
    for (const rel of ["forms/extra.json", "test-kit/shops/extra.json", "test-kit/extra.md", "extra.txt"]) {
      writeFileSync(path.join(root, rel), "{}\n");
      const result = run(["--root", root]);
      expect(result.status, rel).toBe(1);
      rmSync(path.join(root, rel));
    }
    expect(run(["--root", root]).status).toBe(0);
  });

  it("fails when a listed file is removed", () => {
    const rel = firstFile("forms");
    rmSync(path.join(root, rel));
    const result = run(["--root", root]);
    expect(result.status).toBe(1);
    expect(result.output).toContain(`listed but missing: ${rel}`);
  });

  it("fails when the manifest has a line that is not a hash line", () => {
    appendFileSync(path.join(root, "MANIFEST.sha256"), "not a hash line\n");
    expect(run(["--root", root]).status).toBe(1);
  });

  it("fails when the G1-G3 patch changes", () => {
    appendFileSync(path.join(root, "patch/G1-G3.patch"), "\n");
    const result = run(["--root", root]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("input changed: ./patch/G1-G3.patch");
  });

  it("compares a rebuild apart from the three date lines", () => {
    const rebuilt = path.join(work, "rebuilt");
    cpSync(root, rebuilt, { recursive: true });
    for (const rel of ["PROFESSION-MAP.md", "test-kit/COVERAGE.md", "test-kit/SCENARIOS.md"]) {
      const file = path.join(rebuilt, rel);
      const lines = readFileSync(file, "utf8").split("\n");
      lines[2] = (lines[2] ?? "").replace(/\d{2}:\d{2}(:\d{2})?/, "23:59");
      writeFileSync(file, lines.join("\n"));
    }
    expect(run(["--root", root, "--compare", rebuilt]).status).toBe(0);
    appendFileSync(path.join(rebuilt, firstFile("forms")), " ");
    const result = run(["--root", root, "--compare", rebuilt]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("rebuild differs");
  });

  it("rejects a wrong command line with exit code 2", () => {
    expect(run(["--nope"]).status).toBe(2);
  });
});
