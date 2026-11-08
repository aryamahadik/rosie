// `compiler build` (compiler/src/cli/commands/build.ts, T-149): the command writes the bundle directory, packs the
// prompt and model files it is given, takes and names a stand-in for the rest (the bundle id's is 64 zeros and build
// 1), prints the tree's sha256, and refuses a command line it does not take. One trade only: the all-trades build is
// the card's CLI proof, not a unit test (DL-099).
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main, type CliIo } from "../cli/index";
import { STANDIN_BUNDLE_ID, checkBundlePart } from "./index";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "emit-cli-"));
  made.push(dir);
  return dir;
}

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

/** Every file under `dir`, as `path` (posix, from `dir`) to its text (each a UTF-8 JSON value). */
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(relative(dir, path).split("\\").join("/"), readFileSync(path, "utf8"));
    }
  };
  walk(dir);
  return out;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

describe("compiler build", () => {
  it("writes the bundle directory, packs the files it is given and prints the tree's sha256", async () => {
    const work = tempDir();
    const out = join(work, "bundle");
    writeFileSync(join(work, "safety.txt"), "Test safety read prompt (T-149 unit test).\n");
    const prompts = {
      safetyRead: { version: "test-1", file: "safety.txt" },
      decide: { version: "test-1", text: "Test decide prompt (T-149 unit test)." },
      planner: { version: "test-1", text: "Test planner prompt (T-149 unit test)." },
      composer: { version: "test-1", text: "Test composer prompt (T-149 unit test)." },
    };
    writeFileSync(join(work, "prompts.json"), JSON.stringify(prompts));
    const routing = {
      models: { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5" },
      policy: {
        low: { first: "haiku", second: "haiku" },
        high: { first: "sonnet", second: "haiku" },
        reread: "sonnet",
      },
    };
    writeFileSync(join(work, "models.json"), JSON.stringify(routing));

    const run = capture();
    const code = await main(
      [
        "build",
        "--out",
        out,
        "--trades",
        "barber",
        "--built-at",
        "2026-11-08T01:02:03Z",
        "--prompts",
        join(work, "prompts.json"),
        "--models",
        join(work, "models.json"),
      ],
      run.io,
    );
    expect(run.err).toEqual([]);
    expect(code).toBe(0);

    const files = tree(out);
    expect([...files.keys()].sort()).toEqual([
      "flow/A.json",
      "flow/B.json",
      "manifest.json",
      "trade/barber.json",
    ]);
    const manifest = JSON.parse(files.get("manifest.json") ?? "null") as {
      bundleId: unknown;
      builtAt: string;
      prompts: Record<string, { version: string; sha256: string; text: string }>;
      models: unknown;
      policy: unknown;
    };
    expect(checkBundlePart(manifest, "manifest")).toEqual([]);
    expect(manifest.bundleId).toEqual(STANDIN_BUNDLE_ID);
    expect(manifest.builtAt).toBe("2026-11-08T01:02:03Z");
    expect(manifest.prompts.safetyRead).toEqual({
      version: "test-1",
      sha256: sha256("Test safety read prompt (T-149 unit test).\n"),
      text: "Test safety read prompt (T-149 unit test).\n",
    });
    expect(manifest.prompts.composer?.text).toBe(prompts.composer.text);
    expect(manifest.models).toEqual(routing.models);
    expect(manifest.policy).toEqual(routing.policy);

    // The tree's sha256: one `<sha256>  <path>` line per file, sorted by path (what `shasum -a 256` prints per file).
    const lines = [...files.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, text]) => `${sha256(text)}  ${path}\n`)
      .join("");
    expect(run.out).toContain(`tree sha256: ${sha256(lines)} (4 files in ${out})`);
    expect(
      run.out.filter((line) => line.startsWith("stand-in: ")).map((line) => line.split(" from ")[0]),
    ).toEqual([
      "stand-in: bundle id",
      "stand-in: inputs",
      "stand-in: judgment rules",
      "stand-in: lists.fixedLines",
      "stand-in: lists.outOfScope",
    ]);
    expect(run.out).toContain(
      "validated against K-01 v1 (Ajv 2020-12, strict): the manifest, 2 flow graphs and 1 trade overlays",
    );
  });

  it("reads a relative --out from the folder npm was run in, and refuses a folder that is not empty", async () => {
    const caller = tempDir();
    mkdirSync(join(caller, "used"));
    writeFileSync(join(caller, "used", "old.json"), "{}");
    const before = process.env.INIT_CWD;
    process.env.INIT_CWD = caller;
    try {
      const run = capture();
      expect(await main(["build", "--out", "used", "--trades", "barber"], run.io)).toBe(2);
      expect(run.err.join("\n")).toMatch(/--out used: the folder is not empty/);
    } finally {
      if (before === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = before;
    }
  });

  it.each([
    [[], /--out <dir> is required/],
    [["--out"], /--out needs a value/],
    [["--out", "x", "--colour", "red"], /unknown argument "--colour"/],
    [["--out", "x", "--out", "y"], /--out is given twice/],
    [
      ["--out", "x", "--bundle-id", "abc/1"],
      /--bundle-id abc\/1: expected <64 lowercase hex>\/<build number>/,
    ],
  ] as const)("refuses %j", async (args, message) => {
    const run = capture();
    expect(await main(["build", ...args], run.io)).toBe(2);
    expect(run.err.join("\n")).toMatch(message);
  });

  it("an unknown trade fails, naming it", async () => {
    const run = capture();
    expect(await main(["build", "--out", join(tempDir(), "b"), "--trades", "no-such-trade"], run.io)).toBe(1);
    expect(run.err.join("\n")).toMatch(/no-such-trade/);
  });
});
