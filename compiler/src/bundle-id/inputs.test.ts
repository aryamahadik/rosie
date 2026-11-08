// The manifest's inputs (T-150; K-01 v1 manifest.inputs and inputFile; Q-36): every input K-01 names, each with the
// sha256 of the bytes the compiler reads: both flows, the 243 trades, the Master Corrections version, LINES.md, the
// approved overlays, fixture set v1's manifest (fixtures/v1/MANIFEST.sha256) and the reference scripts. A vendored file
// whose bytes are not the ones fixtures/master/SHA256SUMS records stops the build.
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkBundlePart } from "../emit";
import { listTradeIds } from "../load/trade";
import {
  INPUT_KINDS,
  InputHashError,
  MASTER_CORRECTIONS,
  bundleInputs,
  readSha256Sums,
  tradePath,
} from "./index";

const ROOT = new URL("../../../", import.meta.url);
const bytesOf = (path: string): Buffer => readFileSync(new URL(path, ROOT));
const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const SUMS_FILE = fileURLToPath(new URL("fixtures/master/SHA256SUMS", ROOT));

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const TRADES = listTradeIds();
const ALL = bundleInputs({ trades: TRADES });
const ofKind = (kind: string) => ALL.filter((input) => input.kind === kind);

describe("a full build lists every input K-01 names, each with its sha256", () => {
  it("the two master flows", () => {
    expect(ofKind("masterFlow").map((input) => input.path)).toEqual([
      "engine/work/master/master-A.json",
      "engine/work/master/master-B.json",
    ]);
  });

  it("the 243 trades, one each, with its trade id", () => {
    const trades = ofKind("trade");
    expect(TRADES).toHaveLength(243);
    expect(trades).toHaveLength(243);
    expect(trades.map((input) => input.trade).sort()).toEqual(TRADES);
    for (const input of trades) expect(input.path).toBe(`engine/work/prof/${String(input.trade)}.json`);
  });

  it("the Master Corrections version, with the hash K-01 v1's own sample manifest records for that file", () => {
    const sample = JSON.parse(
      readFileSync(new URL("contracts/bundle/fixtures/manifest.json", ROOT), "utf8"),
    ) as {
      inputs: { kind: string }[];
    };
    const recorded = sample.inputs.find((input) => input.kind === "masterCorrections");
    expect(ofKind("masterCorrections")).toEqual([MASTER_CORRECTIONS]);
    expect(recorded).toEqual(MASTER_CORRECTIONS);
    expect(MASTER_CORRECTIONS.version).toBe("as of Nov 5 2026");
  });

  it("LINES.md and the three reference scripts parity runs against", () => {
    expect(ofKind("lines").map((input) => input.path)).toEqual(["engine/design/LINES.md"]);
    expect(ofKind("referenceCode").map((input) => input.path)).toEqual([
      "engine/work/build/lib.js",
      "engine/work/build/msgtext.js",
      "engine/work/build/overlay-core.js",
    ]);
  });

  it("fixture set v1's committed manifest, fixtures/v1/MANIFEST.sha256, at the file's own sha256", () => {
    expect(ofKind("fixtureSetManifest")).toEqual([
      {
        kind: "fixtureSetManifest",
        path: "fixtures/v1/MANIFEST.sha256",
        sha256: sha256(bytesOf("fixtures/v1/MANIFEST.sha256")),
      },
    ]);
  });

  it("no approved overlay, since none is given (none exists yet: Q-17, J-18)", () => {
    expect(ofKind("approvedOverlay")).toEqual([]);
  });

  it("nothing else: 2 flows, 243 trades, Master Corrections, LINES.md, fixture set v1's manifest, 3 scripts", () => {
    expect(ALL).toHaveLength(2 + 243 + 1 + 1 + 1 + 3);
    for (const input of ALL) expect(INPUT_KINDS).toContain(input.kind);
  });

  it("each master file's sha256 is its own bytes' under fixtures/master/, and the line SHA256SUMS records", () => {
    const sums = readSha256Sums(SUMS_FILE);
    const vendored = ALL.filter((input) => !["masterCorrections", "fixtureSetManifest"].includes(input.kind));
    expect(vendored).toHaveLength(2 + 243 + 1 + 3);
    for (const input of vendored) {
      expect(input.sha256, input.path).toBe(sha256(bytesOf(`fixtures/master/${input.path}`)));
      expect(input.sha256, input.path).toBe(sums.get(input.path));
    }
  });

  it("each entry is a K-01 v1 inputFile", () => {
    for (const input of ALL) expect(checkBundlePart(input, "inputFile"), input.path).toEqual([]);
  });

  it("in K-01's kind order, then by path, and the same for the same inputs", () => {
    const rank = (kind: string): number => (INPUT_KINDS as readonly string[]).indexOf(kind);
    for (let k = 1; k < ALL.length; k += 1) {
      const [before, after] = [ALL[k - 1], ALL[k]] as [(typeof ALL)[number], (typeof ALL)[number]];
      const order = rank(before.kind) - rank(after.kind) || (before.path < after.path ? -1 : 1);
      expect(order, `${before.path} before ${after.path}`).toBeLessThan(0);
    }
    expect(bundleInputs({ trades: [...TRADES].reverse() })).toEqual(ALL);
  });
});

describe("a partial build lists the trades it holds", () => {
  it("one trade: barber's file and no other", () => {
    const inputs = bundleInputs({ trades: ["barber"] });
    expect(inputs.filter((input) => input.kind === "trade")).toEqual([
      {
        kind: "trade",
        path: "engine/work/prof/barber.json",
        sha256: sha256(bytesOf("fixtures/master/engine/work/prof/barber.json")),
        trade: "barber",
      },
    ]);
    expect(inputs).toHaveLength(2 + 1 + 1 + 1 + 1 + 3);
  });

  it.each([
    [["no-such-trade"], /SHA256SUMS has no line for engine\/work\/prof\/no-such-trade\.json/],
    [["../master/master-A"], /"\.\.\/master\/master-A" is not a trade id/],
    [["barber", "barber"], /the trade barber is given twice/],
  ] as const)("refuses %j", (trades, message) => {
    expect(() => bundleInputs({ trades })).toThrow(InputHashError);
    expect(() => bundleInputs({ trades })).toThrow(message);
  });
});

/**
 * A small copy of the repository's inputs in a temporary folder: fixtures/master/ with the two flows, LINES.md, the
 * three scripts and barber's file (and SHA256SUMS's lines for them), and fixtures/v1/MANIFEST.sha256.
 */
function copyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bundle-inputs-"));
  made.push(root);
  const paths = [
    "engine/work/master/master-A.json",
    "engine/work/master/master-B.json",
    "engine/design/LINES.md",
    "engine/work/build/lib.js",
    "engine/work/build/msgtext.js",
    "engine/work/build/overlay-core.js",
    tradePath("barber"),
  ];
  const sums = readSha256Sums(SUMS_FILE);
  const lines: string[] = [];
  for (const path of paths) {
    const to = join(root, "fixtures", "master", ...path.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(new URL(`fixtures/master/${path}`, ROOT), to);
    lines.push(`${String(sums.get(path))}  ${path}\n`);
  }
  writeFileSync(join(root, "fixtures", "master", "SHA256SUMS"), lines.join(""));
  mkdirSync(join(root, "fixtures", "v1"), { recursive: true });
  cpSync(new URL("fixtures/v1/MANIFEST.sha256", ROOT), join(root, "fixtures", "v1", "MANIFEST.sha256"));
  return root;
}

describe("the hashes are of the bytes the compiler reads", () => {
  it("the copy lists what the repository lists", () => {
    expect(bundleInputs({ trades: ["barber"], root: copyRoot() })).toEqual(
      bundleInputs({ trades: ["barber"] }),
    );
  });

  it("a trade file changed after SHA256SUMS was written stops the build, naming the file", () => {
    const root = copyRoot();
    const file = join(root, "fixtures", "master", "engine", "work", "prof", "barber.json");
    const text = readFileSync(file, "utf8");
    expect(text).toContain('"name": "Barber",');
    writeFileSync(file, text.replace('"name": "Barber",', '"name": "Barbers",'));
    expect(() => bundleInputs({ trades: ["barber"], root })).toThrow(InputHashError);
    expect(() => bundleInputs({ trades: ["barber"], root })).toThrow(
      /fixtures\/master\/engine\/work\/prof\/barber\.json is not the file fixtures\/master\/SHA256SUMS records/,
    );
  });

  it("changing one trade file, with its line, changes that trade's hash and no other", () => {
    const root = copyRoot();
    const before = bundleInputs({ trades: ["barber"], root });
    const file = join(root, "fixtures", "master", "engine", "work", "prof", "barber.json");
    const changed = readFileSync(file, "utf8").replace('"name": "Barber",', '"name": "Barbers",');
    writeFileSync(file, changed);
    const sumsFile = join(root, "fixtures", "master", "SHA256SUMS");
    const old = sha256(bytesOf("fixtures/master/engine/work/prof/barber.json"));
    writeFileSync(sumsFile, readFileSync(sumsFile, "utf8").replace(old, sha256(changed)));
    const after = bundleInputs({ trades: ["barber"], root });
    expect(after.find((input) => input.kind === "trade")?.sha256).toBe(sha256(changed));
    expect(after.find((input) => input.kind === "trade")?.sha256).not.toBe(old);
    expect(after.filter((input) => input.kind !== "trade")).toEqual(
      before.filter((input) => input.kind !== "trade"),
    );
  });

  it("a missing input stops the build, naming it", () => {
    const root = copyRoot();
    rmSync(join(root, "fixtures", "v1", "MANIFEST.sha256"));
    expect(() => bundleInputs({ trades: ["barber"], root })).toThrow(
      /fixture set v1's manifest: cannot read/,
    );
  });

  it("a malformed SHA256SUMS line stops the build", () => {
    const root = copyRoot();
    writeFileSync(join(root, "fixtures", "master", "SHA256SUMS"), "not a hash line\n");
    expect(() => bundleInputs({ trades: ["barber"], root })).toThrow(/line 1 is not "<sha256> {2}<path>"/);
  });
});

describe("an approved overlay the build is given", () => {
  it("is listed by its repository path, with its sha256 and its approval date, between LINES.md and fixture set v1", () => {
    const root = copyRoot();
    mkdirSync(join(root, "overlays"));
    const text = '{"journey":1,"fix":"test overlay (T-150 unit test)"}\n';
    writeFileSync(join(root, "overlays", "journey-1.json"), text);
    const inputs = bundleInputs({
      trades: ["barber"],
      root,
      approvedOverlays: [{ path: "overlays/journey-1.json", version: "approved 2026-11-08 (test)" }],
    });
    expect(inputs.map((input) => input.kind)).toEqual([
      "masterFlow",
      "masterFlow",
      "trade",
      "masterCorrections",
      "lines",
      "approvedOverlay",
      "fixtureSetManifest",
      "referenceCode",
      "referenceCode",
      "referenceCode",
    ]);
    const overlay = inputs.find((input) => input.kind === "approvedOverlay");
    expect(overlay).toEqual({
      kind: "approvedOverlay",
      path: "overlays/journey-1.json",
      sha256: sha256(text),
      version: "approved 2026-11-08 (test)",
    });
    expect(checkBundlePart(overlay, "inputFile")).toEqual([]);
  });

  it.each([
    [{ path: "../outside.json", version: "x" }, /is not a path from the repository root/],
    [{ path: "/abs/outside.json", version: "x" }, /is not a path from the repository root/],
    [{ path: "overlays/none.json", version: "x" }, /the approved overlay overlays\/none\.json: cannot read/],
    [{ path: "overlays/none.json", version: " " }, /has no approval date/],
  ] as const)("refuses %j", (overlay, message) => {
    const root = copyRoot();
    expect(() => bundleInputs({ trades: ["barber"], root, approvedOverlays: [overlay] })).toThrow(message);
  });
});
