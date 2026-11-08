// T-200: opening and checking fixture set v1 for a seed (db/seeds/lib/fixture-set.ts), without a database. The
// expectations are read here from fixtures/v1 itself (node:fs, node:crypto). Nothing is written anywhere.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  filesUnder,
  FIXTURE_SET_V1_DIR,
  FIXTURES_DIR,
  FixtureAccessError,
  FixtureChecksumError,
  isInside,
  isPlainRelativePath,
  openFixtureSet,
  parseManifest,
  verifyFixtureSet,
} from "./fixture-set";

const FIXTURES = path.resolve(fileURLToPath(new URL("../../../fixtures", import.meta.url)));
const V1 = path.join(FIXTURES, "v1");
const HASH = "a".repeat(64);

describe("where a seed may read", () => {
  it("is the repository's fixtures/ folder, and fixture set v1 by default", () => {
    expect(FIXTURES_DIR).toBe(FIXTURES);
    expect(FIXTURE_SET_V1_DIR).toBe(V1);
    expect(openFixtureSet()).toEqual({ dir: realpathSync(V1), jail: realpathSync(FIXTURES) });
  });

  it("refuses a folder outside fixtures/, written plainly or climbing out with `..`", () => {
    for (const dir of [tmpdir(), path.join(V1, "..", "..", "db"), path.join(V1, "..", ".."), "/"]) {
      expect(() => openFixtureSet(dir), dir).toThrow(FixtureAccessError);
    }
  });

  it("refuses a folder that does not exist", () => {
    expect(() => openFixtureSet(path.join(V1, "no-such-folder"))).toThrow(FixtureAccessError);
  });

  it("tells inside from outside by whole path steps", () => {
    expect(isInside("/a/fixtures/v1", "/a/fixtures")).toBe(true);
    expect(isInside("/a/fixtures", "/a/fixtures")).toBe(true);
    expect(isInside("/a/fixtures-old/v1", "/a/fixtures")).toBe(false);
    expect(isInside("/a", "/a/fixtures")).toBe(false);
    expect(isInside("/a/fixtures/..data", "/a/fixtures")).toBe(true);
  });

  it("takes only plain relative paths from a manifest", () => {
    for (const plain of ["PROFESSION-MAP.md", "test-kit/shops/barber.json", "forms/a..b.json"]) {
      expect(isPlainRelativePath(plain), plain).toBe(true);
    }
    for (const bad of ["", "/etc/hosts", "../x", "a/../b", "a//b", "./a", "a/.", "a\\b", "C:\\x", "a\0b"]) {
      expect(isPlainRelativePath(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("parseManifest", () => {
  it("reads `<sha256>  <path>` lines and skips blank ones", () => {
    expect(parseManifest(`${HASH}  forms/a.json\n\n${HASH}  PROFESSION-MAP.md\n`)).toEqual([
      { sha256: HASH, path: "forms/a.json" },
      { sha256: HASH, path: "PROFESSION-MAP.md" },
    ]);
  });

  it("refuses a path that leaves the set as an access error, before any file is read", () => {
    for (const bad of ["../../package.json", "/etc/hosts", "forms/../../x", "./forms/a.json"]) {
      expect(() => parseManifest(`${HASH}  forms/a.json\n${HASH}  ${bad}\n`), bad).toThrow(
        FixtureAccessError,
      );
    }
  });

  it("refuses a malformed line, a path listed twice and an empty manifest as a checksum error", () => {
    const refused = (text: string): readonly string[] => {
      try {
        parseManifest(text);
      } catch (error) {
        expect(error).toBeInstanceOf(FixtureChecksumError);
        return (error as FixtureChecksumError).problems;
      }
      throw new Error("the manifest was accepted");
    };
    expect(refused(`${HASH}  a.json\nnot a hash line\n`)).toEqual([
      'MANIFEST.sha256 line 2 is not "<sha256>  <path>"',
    ]);
    expect(refused(`${HASH.toUpperCase()}  a.json\n`)).toEqual([
      'MANIFEST.sha256 line 1 is not "<sha256>  <path>"',
    ]);
    expect(refused(`${HASH} a.json\n`)).toEqual(['MANIFEST.sha256 line 1 is not "<sha256>  <path>"']);
    expect(refused(`${HASH}  a.json\n${HASH}  a.json\n`)).toEqual(["MANIFEST.sha256 lists a.json twice"]);
    expect(refused("\n")).toEqual(["MANIFEST.sha256 lists no file"]);
  });
});

describe("verifyFixtureSet on the committed fixture set v1", () => {
  const listed = readFileSync(path.join(V1, "MANIFEST.sha256"), "utf8").split("\n").filter(Boolean);

  it("checks every file the manifest lists and hands back the bytes it hashed", () => {
    const verified = verifyFixtureSet(openFixtureSet());
    expect(verified.dir).toBe(realpathSync(V1));
    expect(verified.filesChecked).toBe(listed.length);
    expect(verified.manifestSha256).toBe(
      createHash("sha256")
        .update(readFileSync(path.join(V1, "MANIFEST.sha256")))
        .digest("hex"),
    );
    for (const line of listed) {
      const [hash, file] = line.split("  ");
      const got = verified.files.get(file ?? "");
      expect(got?.sha256, file).toBe(hash);
      expect(
        createHash("sha256")
          .update(got?.bytes ?? "")
          .digest("hex"),
        file,
      ).toBe(hash);
    }
  });

  it("lists the 245 demo shop files under test-kit/shops/ in code-point order", () => {
    const shops = filesUnder(verifyFixtureSet(openFixtureSet()), "test-kit/shops/");
    expect(shops).toHaveLength(245);
    const paths = shops.map((shop) => shop.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain("test-kit/shops/test-mixed-A.json");
    expect(paths).toContain("test-kit/shops/test-mixed-B.json");
  });
});
