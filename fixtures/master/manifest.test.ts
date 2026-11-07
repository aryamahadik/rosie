// T-130: the compiler's master inputs are vendored under fixtures/master and checked against SHA256SUMS
// (the hashes recorded from the handover copy). CI and builders compile without the handover folder.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const v1Inputs = path.resolve(here, "..", "v1", "INPUTS.sha256");

/** Hashes taken from the handover files (read only) for the four inputs fixtures/v1/INPUTS.sha256 does not list. */
const handoverOnly: Record<string, string> = {
  "engine/design/LINES.md": "55ab0383ac6190c4b94b763bc834a7566469f9d98a31312f8d03f62541f9aaed",
  "engine/work/build/lib.js": "8b11317cecbda085d4ef414d3454a57d4a788f08935994736caab496ccafc48d",
  "engine/work/build/msgtext.js": "7928feb90897c5ae2e053e45313f631f20827959c1dc9207b1885ae4f1119bc4",
  "engine/work/build/overlay-core.js": "a01c993c84ce7ed3b20cbfe470bffa1d300b8e7e4cd35d45a2c5ba1e13bfa18c",
};

function parse(file: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (!m) throw new Error(`not a hash line: ${line}`);
    map.set(m[2] as string, m[1] as string);
  }
  return map;
}

const sums = parse(path.join(here, "SHA256SUMS"));
const sha256 = (rel: string): string => createHash("sha256").update(readFileSync(path.join(here, rel))).digest("hex");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

describe("fixtures/master inputs", () => {
  it("lists 2 flow files, 243 trade files, LINES.md, overlay-core.js, lib.js and msgtext.js", () => {
    const keys = [...sums.keys()];
    expect(keys.filter((k) => /^engine\/work\/master\/master-[AB]\.json$/.test(k))).toHaveLength(2);
    expect(keys.filter((k) => /^engine\/work\/prof\/[a-z0-9-]+\.json$/.test(k))).toHaveLength(243);
    for (const k of [
      "engine/design/LINES.md",
      "engine/work/build/overlay-core.js",
      "engine/work/build/lib.js",
      "engine/work/build/msgtext.js",
    ]) {
      expect(keys.filter((x) => x === k)).toHaveLength(1);
    }
    expect(keys).toHaveLength(2 + 243 + 4);
  });

  it("has on disk exactly the listed files, and nothing from forms/ or test-kit/", () => {
    const onDisk = walk(here)
      .map((f) => path.relative(here, f).split(path.sep).join("/"))
      .filter((f) => f !== "SHA256SUMS" && f !== "manifest.test.ts")
      .sort();
    expect(onDisk).toEqual([...sums.keys()].sort());
    expect(onDisk.some((f) => f.startsWith("forms/") || f.startsWith("test-kit/") || f.includes("/forms/"))).toBe(false);
  });

  it("has every file at the hash recorded in SHA256SUMS", () => {
    for (const [rel, hash] of sums) {
      expect(existsSync(path.join(here, rel)), rel).toBe(true);
      expect(sha256(rel), rel).toBe(hash);
    }
  });

  it("agrees with the handover hashes in fixtures/v1/INPUTS.sha256 for every file both list", () => {
    const inputs = parse(v1Inputs);
    let shared = 0;
    for (const [rel, hash] of sums) {
      const other = inputs.get(rel);
      if (other === undefined) continue;
      shared += 1;
      expect(hash, rel).toBe(other);
    }
    expect(shared).toBe(2 + 243);
  });

  it("has the four scripts and notes at the hashes recorded from the handover", () => {
    for (const [rel, hash] of Object.entries(handoverOnly)) {
      expect(sums.get(rel), rel).toBe(hash);
      expect(sha256(rel), rel).toBe(hash);
    }
  });
});
