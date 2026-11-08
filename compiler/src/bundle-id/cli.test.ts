// `compiler build --build <n>` (compiler/src/cli/commands/build.ts, T-150): a numbered build writes the bundle under
// its own id, the content hash of its stored values with build number n, lists every input K-01 names, checks the id
// again from the files read back and names no stand-in for either. One trade only: the all-trades build is the CLI's,
// not a unit test (DL-099).
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main, type CliIo } from "../cli/index";
import { checkBundleDir, readBundleDir } from "../emit";
import { bundleIdProblems, bundleInputs } from "./index";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bundle-id-cli-"));
  made.push(dir);
  return dir;
}

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

describe("compiler build --build <n>", () => {
  it("writes the bundle under the content hash of its stored values with build n, and every input K-01 names", async () => {
    const out = join(tempDir(), "bundle");
    const run = capture();
    const code = await main(
      ["build", "--out", out, "--trades", "barber", "--build", "2", "--built-at", "2026-11-08T01:02:03Z"],
      run.io,
    );
    expect(run.err).toEqual([]);
    expect(code).toBe(0);
    expect(checkBundleDir(out)).toEqual([]);

    const { files, bundle } = readBundleDir(out);
    const values = files
      .filter((file) => file.path !== "manifest.json")
      .map((file) => [file.path.replace(/\.json$/, ""), sha256(file.text)] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    const hash = sha256(values.map(([part, digest]) => `${digest}  ${part}\n`).join(""));
    const manifest = bundle.manifest as { bundleId: unknown; inputs: unknown };
    expect(manifest.bundleId).toEqual({ hash, build: 2 });
    expect(bundleIdProblems(manifest)).toEqual([]);
    expect(manifest.inputs).toEqual(bundleInputs({ trades: ["barber"] }));

    const standIns = run.out
      .filter((line) => line.startsWith("stand-in: "))
      .map((line) => line.split(" from ")[0]);
    expect(standIns).not.toContain("stand-in: bundle id");
    expect(standIns).not.toContain("stand-in: inputs");
    expect(run.out).toContain(
      `bundle id: ${hash}/2, the content hash of the 3 stored values (K-01 v1) with build 2`,
    );
    expect(run.out).toContain(
      "inputs: 9, each with its sha256: masterFlow 2, trade 1, masterCorrections 1 (as of Nov 5 2026), lines 1, approvedOverlay 0, fixtureSetManifest 1, referenceCode 3",
    );
    expect(run.out).toContain(
      `bundle id read back from ${out}: the content hash of the stored values on disk is the id's hash`,
    );
  });

  it.each([
    [["--build", "0"], 2, /--build 0: expected a build number, a whole number from 1/],
    [["--build", "two"], 2, /--build two: expected a build number, a whole number from 1/],
    [
      ["--build", "1", "--bundle-id", `${"ab".repeat(32)}/1`],
      2,
      /--build and --bundle-id are given together/,
    ],
    [["--build"], 2, /--build needs a value/],
  ] as const)("refuses %j", async (args, exit, message) => {
    const run = capture();
    expect(await main(["build", "--out", join(tempDir(), "b"), "--trades", "barber", ...args], run.io)).toBe(
      exit,
    );
    expect(run.err.join("\n")).toMatch(message);
  });
});
