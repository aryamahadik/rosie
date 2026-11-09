// The gold store's other refusals and its checks of a set on disk (T-470, store.ts): written once and never rewritten,
// one set version per folder, no human-labelled live turn (BP rule 9), and a set whose files are not what its
// manifest lists is refused, to read and to write. Each run in a scratch root, never evals/gold/.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { check } from "prettier";
import { afterEach, describe, expect, it } from "vitest";

import type { GoldItem } from "../../../../contracts/generated/eval-set/eval-set.v1";
import { jsonFileText, prettierSettings } from "./json";
import { GOLD_ROOT, MANIFEST_FILE, REPO_ROOT, filesUnder, itemPathOf } from "./layout";
import {
  GoldItemRefused,
  GoldSetError,
  goldSetVersions,
  readGoldItem,
  readGoldItems,
  readGoldManifest,
  writeGoldItems,
} from "./store";
import { acceptedItem, acceptedItems, fixtureSetVersion, removeScratch, scratchRoot } from "./test-support";

afterEach(removeScratch);

const SET = fixtureSetVersion();
const TYPO = "item-typo-s1-02";
const TYPO_PATH = "journey-01/flow-A/item-typo-s1-02.json";

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

/** The problems of a refusal, after checking its kind. */
function problemsOf(error: unknown, kind: typeof GoldItemRefused | typeof GoldSetError): readonly string[] {
  expect(error).toBeInstanceOf(kind);
  return (error as GoldItemRefused | GoldSetError).problems;
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of filesUnder(dir)) out[file] = readFileSync(path.join(dir, ...file.split("/")), "utf8");
  return out;
}

/** A scratch store holding every accepted item fixture. */
async function storeOfFixtures(): Promise<{ root: string; dir: string; manifestSha256: string }> {
  const root = scratchRoot();
  const { dir, manifestSha256 } = await writeGoldItems(acceptedItems(), { setVersion: SET, root });
  return { root, dir, manifestSha256 };
}

/** The S1-02 typo item with other words: a new item under the same id. */
function retypedTypo(): GoldItem {
  const item = acceptedItem(TYPO);
  const text = item.turns[0].texts[0].text;
  text.words = "Movng and junk haulin";
  const field = item.turns[0].label.parts[0]?.fields[0];
  if (field === undefined) throw new Error("the typo item has the field kinds");
  field.value = text.words;
  return item;
}

describe("written once, never rewritten", () => {
  it("refuses an id the set already holds with other content, and changes nothing", async () => {
    const { root, dir } = await storeOfFixtures();
    const before = snapshot(dir);
    const problems = problemsOf(
      await caught(writeGoldItems([retypedTypo()], { setVersion: SET, root })),
      GoldItemRefused,
    );
    expect(problems).toEqual([
      `item 0 (${TYPO}): set ${SET} already holds this id at ${TYPO_PATH} with other content; an item is written once and never rewritten`,
    ]);
    expect(snapshot(dir)).toEqual(before);
  });

  it("keeps the first of one id given twice alike, and refuses one id given twice with other content", async () => {
    const root = scratchRoot();
    const result = await writeGoldItems([acceptedItem(TYPO), acceptedItem(TYPO)], { setVersion: SET, root });
    expect(result.written).toEqual([TYPO_PATH]);
    const problems = problemsOf(
      await caught(
        writeGoldItems([acceptedItem(TYPO), retypedTypo()], { setVersion: SET, root: scratchRoot() }),
      ),
      GoldItemRefused,
    );
    expect(problems).toEqual([`item 1 (${TYPO}): item 0 has the same id with other content`]);
  });

  it("refuses an item of another set version: a set's folder holds the items its version added", async () => {
    const root = scratchRoot();
    const item = acceptedItem(TYPO);
    item.setVersion = "gs-2";
    const problems = problemsOf(
      await caught(writeGoldItems([item], { setVersion: SET, root })),
      GoldItemRefused,
    );
    expect(problems).toEqual([
      `item 0 (${TYPO}): /setVersion is gs-2, but it is written to set ${SET}; an item is kept under the set version that added it`,
    ]);
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("what never enters the store", () => {
  it("refuses a human-labelled live turn: its words are a real person's (BP rule 9)", async () => {
    const root = scratchRoot();
    const item = acceptedItem("item-low-stakes-s1-02");
    item.labelledBy = "human";
    item.seed = {
      kind: "liveTurn",
      turnId: "turn-sample-s1-02",
      business: "biz-movers",
      openQuestions: [],
      booking: null,
      flags: [],
    };
    const problems = problemsOf(
      await caught(writeGoldItems([item], { setVersion: SET, root })),
      GoldItemRefused,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^item 0 \(item-low-stakes-s1-02\): \/labelledBy is human .*BP rule 9/);
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses what is not JSON, naming the item, and writes nothing", async () => {
    const root = scratchRoot();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const problems = problemsOf(
      await caught(writeGoldItems([undefined, 1n, cycle, ...acceptedItems()], { setVersion: SET, root })),
      GoldItemRefused,
    );
    expect(problems).toHaveLength(3);
    for (const problem of problems) expect(problem).not.toContain("\n");
    expect(problems[0]).toBe("item 0: is not a JSON value");
    expect(problems[1]).toMatch(/^item 1: is not a JSON value \(.*BigInt.*\)$/);
    expect(problems[2]).toMatch(/^item 2: is not a JSON value \(.*circular.*\)$/i);
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses a set whose place is a file, not a folder", async () => {
    const root = scratchRoot();
    writeFileSync(path.join(root, SET), "");
    const where = `gold set ${SET} (${path.join(root, SET)})`;
    const toRead = thrown(() => readGoldItems({ setVersion: SET, root }));
    expect(problemsOf(toRead, GoldSetError)).toEqual(["it is not a folder"]);
    expect((toRead as Error).message).toBe(`${where}:\n  it is not a folder`);
    const toWrite = await caught(writeGoldItems(acceptedItems(), { setVersion: SET, root }));
    expect(problemsOf(toWrite, GoldSetError)).toEqual(["it is not a folder"]);
  });

  it("refuses a set version that is not a plain folder name, to write and to read", async () => {
    for (const setVersion of ["../gs-1", "gs/1", "", ".gs-1", "x".repeat(61)]) {
      const root = scratchRoot();
      const problems = problemsOf(
        await caught(writeGoldItems(acceptedItems(), { setVersion, root })),
        GoldSetError,
      );
      expect(problems[0], setVersion).toMatch(/^a set version is letters, digits/);
      problemsOf(
        thrown(() => readGoldItems({ setVersion, root })),
        GoldSetError,
      );
      expect(readdirSync(root)).toEqual([]);
    }
  });

  it("reads no set that is not there, and a write of no items makes none", async () => {
    const root = scratchRoot();
    expect(
      problemsOf(
        thrown(() => readGoldItems({ setVersion: SET, root })),
        GoldSetError,
      ),
    ).toEqual(["no such set"]);
    const problems = problemsOf(await caught(writeGoldItems([], { setVersion: SET, root })), GoldItemRefused);
    expect(problems[0]).toMatch(/^no items given, and there is no set gs-1 to rebuild/);
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("a set on disk that is not what its manifest lists", () => {
  it("is refused when an item file changed, to read and to write, though its JSON reads the same", async () => {
    const { root, dir } = await storeOfFixtures();
    const file = path.join(dir, ...TYPO_PATH.split("/"));
    writeFileSync(file, readFileSync(file, "utf8").replace(/\n$/, " \n"));
    const line = `${TYPO_PATH}: its sha256 is not the one ${MANIFEST_FILE} lists; an item is never rewritten`;
    expect(
      problemsOf(
        thrown(() => readGoldItems({ setVersion: SET, root })),
        GoldSetError,
      ),
    ).toEqual([line]);
    const extra = acceptedItem(TYPO);
    extra.itemId = "item-typo-s1-02-b";
    expect(
      problemsOf(await caught(writeGoldItems([extra], { setVersion: SET, root })), GoldSetError),
    ).toEqual([line]);
  });

  it("is refused when an item file is there that the manifest does not list", async () => {
    const root = scratchRoot();
    const items = acceptedItems();
    const [first, ...rest] = items;
    if (first === undefined) throw new Error("there are item fixtures");
    const { dir } = await writeGoldItems(rest, { setVersion: SET, root });
    const file = path.join(dir, ...itemPathOf(first).split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, await jsonFileText(first, file));
    expect(
      problemsOf(
        thrown(() => readGoldItems({ setVersion: SET, root })),
        GoldSetError,
      ),
    ).toEqual([`${itemPathOf(first)} is not listed in ${MANIFEST_FILE}`]);
  });

  it("is refused when a listed item file is gone", async () => {
    const { root, dir } = await storeOfFixtures();
    rmSync(path.join(dir, ...TYPO_PATH.split("/")));
    expect(
      problemsOf(
        thrown(() => readGoldItems({ setVersion: SET, root })),
        GoldSetError,
      ),
    ).toEqual([`${TYPO_PATH} is listed in ${MANIFEST_FILE} but missing`]);
  });

  it("is refused when an item file sits outside the folder its journey, flow and id name", async () => {
    const { root, dir } = await storeOfFixtures();
    const moved = "journey-02/flow-A/item-typo-s1-02.json";
    mkdirSync(path.join(dir, "journey-02", "flow-A"), { recursive: true });
    renameSync(path.join(dir, ...TYPO_PATH.split("/")), path.join(dir, ...moved.split("/")));
    expect(
      problemsOf(
        thrown(() => readGoldItems({ setVersion: SET, root })),
        GoldSetError,
      ),
    ).toEqual([
      `${moved}: its journey, flow and id put it at ${TYPO_PATH}`,
      `${moved} is not listed in ${MANIFEST_FILE}`,
      `${TYPO_PATH} is listed in ${MANIFEST_FILE} but missing`,
    ]);
  });

  it("is refused when it holds a file that is no item file, and passes over dot files", async () => {
    const { root, dir } = await storeOfFixtures();
    writeFileSync(path.join(dir, ".DS_Store"), "");
    writeFileSync(path.join(dir, "journey-01", ".item-typo-s1-02.json.swp"), "");
    expect(readGoldItems({ setVersion: SET, root })).toHaveLength(acceptedItems().length);
    writeFileSync(path.join(dir, "journey-01", "notes.txt"), "a note");
    expect(
      problemsOf(
        thrown(() => readGoldItems({ setVersion: SET, root })),
        GoldSetError,
      ),
    ).toEqual([
      "journey-01/notes.txt is not an item file of the store (journey-<NN>/flow-<A|B>/<item id>.json)",
    ]);
  });

  it("is refused when its manifest belongs to another set", async () => {
    const { root, dir } = await storeOfFixtures();
    renameSync(dir, path.join(root, "gs-2"));
    const problems = problemsOf(
      thrown(() => readGoldItems({ setVersion: "gs-2", root })),
      GoldSetError,
    );
    expect(problems).toContain(`${MANIFEST_FILE}: /setVersion is "${SET}", not the set's own "gs-2"`);
    expect(problems).toContain(`${TYPO_PATH}: /setVersion is ${SET}, so it is not an item of set gs-2`);
  });

  it("is refused when its manifest's counts were changed by hand, and a write of no items rebuilds it", async () => {
    const { root, dir, manifestSha256 } = await storeOfFixtures();
    const file = path.join(dir, MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(file, "utf8")) as { measures: { dangerFound: number } };
    manifest.measures.dangerFound = 300;
    writeFileSync(file, JSON.stringify(manifest, null, 2));
    expect(
      problemsOf(
        thrown(() => readGoldManifest({ setVersion: SET, root })),
        GoldSetError,
      ),
    ).toEqual([
      `${MANIFEST_FILE} is not the manifest of its items (an entry or a count differs); a write of no items rebuilds it`,
    ]);
    const rebuilt = await writeGoldItems([], { setVersion: SET, root });
    expect(rebuilt.written).toEqual([]);
    expect(rebuilt.manifestSha256).toBe(manifestSha256);
    expect(readGoldManifest({ setVersion: SET, root }).sha256).toBe(manifestSha256);
  });

  it("names a missing item by its id", async () => {
    const { root } = await storeOfFixtures();
    expect(
      problemsOf(
        thrown(() => readGoldItem({ setVersion: SET, root, itemId: "item-none" })),
        GoldSetError,
      ),
    ).toEqual(["no item item-none"]);
  });
});

describe("the files the store writes", () => {
  it("are each as Prettier's check finds them with this repository's settings (npm run format:check)", async () => {
    const settings = await prettierSettings();
    const rc = JSON.parse(readFileSync(path.join(REPO_ROOT, ".prettierrc.json"), "utf8")) as {
      printWidth: number;
    };
    expect(settings.printWidth).toBe(rc.printWidth);
    const { dir } = await storeOfFixtures();
    const files = filesUnder(dir);
    expect(files).toContain(MANIFEST_FILE);
    for (const file of files) {
      const filepath = path.join(dir, ...file.split("/"));
      expect(await check(readFileSync(filepath, "utf8"), { ...settings, filepath }), file).toBe(true);
    }
  });

  it("go under evals/gold/ unless another root is given, and each set is a folder named by its version", async () => {
    expect(GOLD_ROOT).toBe(path.join(REPO_ROOT, "evals", "gold"));
    const root = scratchRoot();
    await writeGoldItems(acceptedItems(), { setVersion: SET, root });
    const later = acceptedItem(TYPO);
    later.itemId = "item-typo-s1-02-later";
    later.setVersion = "gs-2";
    await writeGoldItems([later], { setVersion: "gs-2", root });
    writeFileSync(path.join(root, "README.md"), "# gold\n");
    mkdirSync(path.join(root, ".cache"));
    expect(goldSetVersions(root)).toEqual([SET, "gs-2"]);
    expect(readGoldItems({ setVersion: "gs-2", root })).toStrictEqual([later]);
    expect(goldSetVersions(path.join(root, "none"))).toEqual([]);
  });
});
