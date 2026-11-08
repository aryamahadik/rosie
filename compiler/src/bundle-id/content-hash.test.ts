// The bundle id's content hash (T-150; CQ-09; K-01 v1 manifest.bundleId): the hash K-01 spells, from the stored values'
// key parts and sha256s, sorted by part; the same values give the same hash, any change to one value changes it, and
// the manifest (its build time, its id) is not hashed. K-01 v1's own sample bundles carry ids made by the same rule.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BundleIdError,
  bundleIdProblems,
  contentHash,
  contentHashOfFiles,
  parseBuildNumber,
  storedDigestsOfFiles,
  storedDigestsOfManifest,
  type StoredDigest,
} from "./index";

const FIXTURES = new URL("../../../contracts/bundle/fixtures/", import.meta.url);
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as Record<string, unknown>;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const A = sha256("flow A's value");
const B = sha256("flow B's value");
const BARBER = sha256("barber's overlay");
const VALUES: StoredDigest[] = [
  { part: "trade/barber", sha256: BARBER },
  { part: "flow/B", sha256: B },
  { part: "flow/A", sha256: A },
];

describe("contentHash: K-01 v1's bundle id hash", () => {
  it("is the sha256 of one `<sha256>  <part>` line per stored value, sorted by part, each ending in a newline", () => {
    expect(contentHash(VALUES)).toBe(sha256(`${A}  flow/A\n${B}  flow/B\n${BARBER}  trade/barber\n`));
  });

  it("is the same for the same values in any order", () => {
    const hash = contentHash(VALUES);
    expect(contentHash([...VALUES].reverse())).toBe(hash);
    expect(contentHash([VALUES[1], VALUES[2], VALUES[0]] as StoredDigest[])).toBe(hash);
  });

  it("changes when one value changes, is added, is taken away or moves to another key", () => {
    const hash = contentHash(VALUES);
    const changed = VALUES.map((value) =>
      value.part === "trade/barber"
        ? { ...value, sha256: sha256("barber's overlay, one word changed") }
        : value,
    );
    expect(contentHash(changed)).not.toBe(hash);
    expect(contentHash([...VALUES, { part: "trade/plumber", sha256: sha256("plumber") }])).not.toBe(hash);
    expect(contentHash(VALUES.slice(1))).not.toBe(hash);
    const moved = VALUES.map((value) =>
      value.part === "trade/barber" ? { ...value, part: "trade/hair" } : value,
    );
    expect(contentHash(moved)).not.toBe(hash);
  });

  it.each([
    [[], /at least one stored value/],
    [[{ part: "manifest", sha256: A }], /"manifest" is not a stored value's key part/],
    [[{ part: "flow/C", sha256: A }], /"flow\/C" is not a stored value's key part/],
    [[{ part: "trade/Barber", sha256: A }], /"trade\/Barber" is not a stored value's key part/],
    [[{ part: "flow/A", sha256: A.toUpperCase() }], /flow\/A: ".*" is not a sha256 in lowercase hex/],
    [[{ part: "flow/A", sha256: A.slice(1) }], /flow\/A: ".*" is not a sha256 in lowercase hex/],
    [
      [
        { part: "flow/A", sha256: A },
        { part: "flow/A", sha256: B },
      ],
      /flow\/A is listed twice/,
    ],
  ] as const)("refuses %j", (values, message) => {
    expect(() => contentHash(values)).toThrow(BundleIdError);
    expect(() => contentHash(values)).toThrow(message);
  });
});

describe("the hash of a bundle's files", () => {
  const files = [
    { path: "flow/A.json", text: '{"steps":"A"}' },
    { path: "flow/B.json", text: '{"steps":"B"}' },
    { path: "manifest.json", text: '{"builtAt":"2026-11-08T00:00:00Z"}' },
    { path: "trade/barber.json", text: '{"name":"Barber’s"}' },
  ];

  it("hashes every file but manifest.json, at its path without .json, by the sha256 of its UTF-8 bytes", () => {
    expect(storedDigestsOfFiles(files)).toEqual([
      { part: "flow/A", sha256: sha256('{"steps":"A"}') },
      { part: "flow/B", sha256: sha256('{"steps":"B"}') },
      { part: "trade/barber", sha256: sha256('{"name":"Barber’s"}') },
    ]);
    // ’ is 3 bytes in UTF-8: the hash is of the bytes as stored, not of UTF-16 code units.
    expect(storedDigestsOfFiles(files)[2]?.sha256).toBe(
      createHash("sha256").update(new TextEncoder().encode('{"name":"Barber’s"}')).digest("hex"),
    );
  });

  it("does not read the manifest: another build time or id leaves the hash as it was", () => {
    const hash = contentHashOfFiles(files);
    const later = files.map((file) =>
      file.path === "manifest.json" ? { ...file, text: '{"builtAt":"2026-12-01T09:30:00Z"}' } : file,
    );
    expect(contentHashOfFiles(later)).toBe(hash);
    expect(contentHashOfFiles(files.filter((file) => file.path !== "manifest.json"))).toBe(hash);
  });

  it("changes when one value's file changes by one character", () => {
    const hash = contentHashOfFiles(files);
    const changed = files.map((file) =>
      file.path === "trade/barber.json" ? { ...file, text: '{"name":"Barbers"}' } : file,
    );
    expect(contentHashOfFiles(changed)).not.toBe(hash);
  });
});

describe("K-01 v1's sample bundles carry ids made by this rule", () => {
  it.each([
    ["manifest.json", (value: Record<string, unknown>) => value],
    ["bundle-mini-a.json", (value: Record<string, unknown>) => value.manifest],
    ["bundle-mini-b.json", (value: Record<string, unknown>) => value.manifest],
    ["bundle-v0-skeleton.json", (value: Record<string, unknown>) => value.manifest],
  ] as const)("%s: its bundle id's hash is the content hash of its storage.values", (name, manifestOf) => {
    const manifest = manifestOf(fixture(name)) as { bundleId: { hash: string } };
    expect(bundleIdProblems(manifest)).toEqual([]);
    expect(contentHash(storedDigestsOfManifest(manifest))).toBe(manifest.bundleId.hash);
  });
});

describe("bundleIdProblems: a manifest whose id does not hold", () => {
  const good = (): Record<string, unknown> => structuredClone(fixture("manifest.json"));
  const prefix = (manifest: Record<string, unknown>): string => {
    const id = manifest.bundleId as { hash: string; build: number };
    return `bundle/${id.hash}/${String(id.build)}/`;
  };

  it("finds a hash that is not the content hash of the stored values listed", () => {
    const manifest = good();
    const values = (manifest.storage as { values: { sha256: string }[] }).values;
    (values[2] as { sha256: string }).sha256 = sha256("another overlay");
    expect(bundleIdProblems(manifest)).toEqual([
      expect.stringMatching(
        /^bundleId\.hash is [0-9a-f]{64}, but the content hash of the stored values listed is/,
      ),
    ]);
  });

  it("finds a key under another id, the manifest's own key among them", () => {
    const manifest = good();
    const storage = manifest.storage as { manifestKey: string; values: { key: string }[] };
    storage.manifestKey = "bundle/" + "0".repeat(64) + "/1/manifest";
    expect(bundleIdProblems(manifest)).toEqual([`storage.manifestKey is not ${prefix(manifest)}manifest`]);
    const other = good();
    const value = (other.storage as { values: { key: string }[] }).values[0] as { key: string };
    value.key = value.key.replace(/\/1\//, "/2/");
    expect(bundleIdProblems(other)).toEqual([`${value.key} is not under the bundle id ${prefix(other)}`]);
  });

  it("finds a build number that does not count from 1, and a malformed hash", () => {
    const zero = good();
    (zero.bundleId as { build: number }).build = 0;
    expect(bundleIdProblems(zero)).toEqual(["bundleId.build is not a build number (a whole number from 1)"]);
    const upper = good();
    const id = upper.bundleId as { hash: string };
    id.hash = id.hash.toUpperCase();
    expect(bundleIdProblems(upper)).toEqual(["bundleId.hash is not a sha256 in lowercase hex"]);
    expect(bundleIdProblems({})).toEqual(["the manifest has no bundleId"]);
  });
});

describe("parseBuildNumber", () => {
  it("reads a whole number from 1", () => {
    expect(parseBuildNumber("1")).toBe(1);
    expect(parseBuildNumber("42")).toBe(42);
  });

  it.each(["0", "-1", "01", "1.5", "1e3", " 1", "x", "", "9007199254740993"])("refuses %j", (text) => {
    expect(() => parseBuildNumber(text)).toThrow(BundleIdError);
  });
});
