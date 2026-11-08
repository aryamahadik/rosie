// The shared lists (T-149): collected from each module's shared-list.ts, so a later list joins the bundle without an
// edit to the emitter (T-147's compiler/src/scope/shared-list.ts is the first planned). A list no module gives is taken
// from its K-01 v1 fixture, named as a stand-in, and drops away once a module gives it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildKeyMap } from "../keymap";
import { buildKeywords } from "../msgtext";
import {
  SharedListError,
  buildBundle,
  collectSharedLists,
  mergeSharedLists,
  sharedListFiles,
  type SharedListPart,
} from "./index";
import { sharedLists as emitterLists } from "./shared-list";

const FIXTURES = new URL("../../../contracts/bundle/fixtures/", import.meta.url);
const fixtureText = (file: string): string => readFileSync(new URL(file, FIXTURES), "utf8");
const fixture = (file: string): Record<string, unknown> =>
  JSON.parse(fixtureText(file)) as Record<string, unknown>;

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A compiler/src-like folder with one module per entry, each holding the given shared-list.ts text. */
function srcDir(modules: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "emit-lists-"));
  made.push(dir);
  for (const [name, text] of Object.entries(modules)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "shared-list.ts"), text);
  }
  mkdirSync(join(dir, "nolist"), { recursive: true });
  writeFileSync(join(dir, "nolist", "index.ts"), "export const nothing = 1;\n");
  return dir;
}

/** A shared-list.ts that gives `list` as the JSON `value` (plain JavaScript, so any loader reads it). */
function moduleText(parts: { list: string; source: string; value: unknown }[]): string {
  const items = parts.map(
    (part) =>
      `{ list: ${JSON.stringify(part.list)}, source: ${JSON.stringify(part.source)}, build: () => (${JSON.stringify(part.value)}) }`,
  );
  return `export const sharedLists = [${items.join(", ")}];\n`;
}

const markers = (fixture("out-of-scope-c9-first-texts.json").markers as { component: string }[]).map(
  (marker) => structuredClone(marker),
);

describe("the emitter's own shared-list.ts", () => {
  it("gives T-134's keyword list and T-143's key map, as those modules build them", () => {
    const byList = new Map(emitterLists.map((part) => [part.list, part.build()]));
    expect([...byList.keys()]).toEqual(["keywords", "keyMap"]);
    expect(byList.get("keywords")).toEqual(buildKeywords());
    expect(byList.get("keyMap")).toEqual(buildKeyMap());
    expect(`${JSON.stringify(byList.get("keywords"), null, 2)}\n`).toBe(fixtureText("keywords.json"));
  });

  it("is found in compiler/src/ like any module's, and the lists no module gives yet are reported missing", async () => {
    expect(sharedListFiles().map((file) => file.split("/").slice(-2).join("/"))).toContain(
      "emit/shared-list.ts",
    );
    const collected = await collectSharedLists();
    expect(collected.lists.keywords).toEqual(buildKeywords());
    expect(collected.lists.keyMap).toEqual(buildKeyMap());
    expect(collected.sources.keywords?.[0]).toMatch(/^emit\/shared-list\.ts: T-134/);
    for (const name of collected.missing) expect(collected.lists[name]).toBeUndefined();
  });
});

describe("a later module's shared-list.ts joins without an edit to the emitter", () => {
  it("each module folder's shared-list.ts is found, in folder-name order", async () => {
    const dir = srcDir({
      scope: moduleText([
        { list: "outOfScope", source: "T-147 (test)", value: { markers: markers.slice(0, 1) } },
      ]),
      zeta: moduleText([
        { list: "outOfScope", source: "T-148 (test)", value: { markers: markers.slice(1) } },
      ]),
      alpha: moduleText([
        { list: "fixedLines", source: "fixed lines (test)", value: fixture("fixed-lines.json") },
      ]),
    });
    expect(sharedListFiles(dir).map((file) => file.split("/").slice(-2).join("/"))).toEqual([
      "alpha/shared-list.ts",
      "scope/shared-list.ts",
      "zeta/shared-list.ts",
    ]);
    const collected = await collectSharedLists(dir);
    expect(collected.lists.outOfScope).toEqual({ markers });
    expect(collected.lists.fixedLines).toEqual(fixture("fixed-lines.json"));
    expect(collected.sources.outOfScope).toEqual([
      "scope/shared-list.ts: T-147 (test)",
      "zeta/shared-list.ts: T-148 (test)",
    ]);
    expect(collected.missing).toEqual(["keywords", "keyMap"]);
  });

  it("the bundle takes a module's list in place of the stand-in", async () => {
    const dir = srcDir({
      scope: moduleText([
        { list: "outOfScope", source: "T-147 (test)", value: { markers: markers.slice(0, 2) } },
      ]),
    });
    const built = await buildBundle({ trades: ["barber"], srcDir: dir });
    const lists = built.bundle.manifest.lists as Record<string, unknown>;
    expect(lists.outOfScope).toEqual({ markers: markers.slice(0, 2) });
    const standIns = built.standIns.map((standIn) => standIn.what);
    expect(standIns).not.toContain("lists.outOfScope");
    // No module of this folder gives the other three: each is its K-01 fixture, named as a stand-in.
    expect(standIns).toEqual(expect.arrayContaining(["lists.keywords", "lists.fixedLines", "lists.keyMap"]));
    expect(lists.fixedLines).toEqual(fixture("fixed-lines.json"));
  });
});

describe("what a shared-list.ts may not do", () => {
  const part = (
    list: SharedListPart["list"],
    value: unknown,
    source = "test",
  ): { file: string; part: SharedListPart } => ({
    file: `${list}/shared-list.ts`,
    part: { list, source, build: () => value },
  });

  it("a whole list (keywords, keyMap) comes from one module only", () => {
    expect(() =>
      mergeSharedLists([part("keywords", buildKeywords()), part("keywords", buildKeywords())]),
    ).toThrow(SharedListError);
  });

  it("a part K-01 v1 refuses is refused, naming its file", () => {
    expect(() => mergeSharedLists([part("outOfScope", { markers: [] })])).toThrow(
      /outOfScope\/shared-list\.ts/,
    );
    expect(() => mergeSharedLists([part("keyMap", { keys: [] })])).toThrow(SharedListError);
  });

  it("a file must export sharedLists, each with a known list, a source and a build()", async () => {
    const noExport = srcDir({ broken: "export const lists = [];\n" });
    await expect(collectSharedLists(noExport)).rejects.toThrow(/sharedLists/);
    const badList = srcDir({
      broken: 'export const sharedLists = [{ list: "prompts", source: "x", build: () => ({}) }];\n',
    });
    await expect(collectSharedLists(badList)).rejects.toThrow(SharedListError);
  });
});
