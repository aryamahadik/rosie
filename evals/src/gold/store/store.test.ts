// The gold-set item store's proofs (T-470 "Proves it with"), on K-10 v1's own item fixtures as T-003's harness lists
// them, each run in a scratch root, never evals/gold/:
//   1. every K-10 item fixture round-trips unchanged;
//   2. refuse-item-without-field-values.json is refused, naming the missing field;
//   3. writing the same items twice gives the same manifest sha256;
//   4. the manifest lists counts per section 08 measure and per journey.
// integrity.test.ts has the store's other refusals and its checks of a set on disk.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AccuracyReport,
  GoldItem,
  MeasureName,
} from "../../../../contracts/generated/eval-set/eval-set.v1";
import { MEASURES } from "./counts";
import { MANIFEST_FILE, compareText, filesUnder, itemPathOf } from "./layout";
import { GoldItemRefused, readGoldItem, readGoldItems, readGoldManifest, writeGoldItems } from "./store";
import {
  REFUSED_ITEM_FILE,
  acceptedItems,
  evalSetJson,
  fixtureSetVersion,
  fixtureValue,
  removeScratch,
  scratchRoot,
} from "./test-support";

afterEach(removeScratch);

const SET = fixtureSetVersion();

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Every file of a folder, by its path inside it, with its bytes. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of filesUnder(dir)) out[file] = readFileSync(path.join(dir, ...file.split("/")), "utf8");
  return out;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe("every K-10 item fixture round-trips unchanged", () => {
  it("reads each accepted item fixture back exactly as the fixture holds it, key order included", async () => {
    const root = scratchRoot();
    const given = acceptedItems();
    expect(given).toHaveLength(8); // the eight sample items K-10's README lists
    const result = await writeGoldItems(given, { setVersion: SET, root });
    expect(result.written).toEqual(given.map(itemPathOf).sort(compareText));
    expect(result.unchanged).toEqual([]);
    expect(given).toStrictEqual(acceptedItems());
    for (const original of acceptedItems()) {
      const read = readGoldItem({ setVersion: SET, root, itemId: original.itemId });
      expect(read, original.itemId).toStrictEqual(original);
      expect(JSON.stringify(read)).toBe(JSON.stringify(original));
      const stored: unknown = JSON.parse(
        readFileSync(path.join(result.dir, ...itemPathOf(original).split("/")), "utf8"),
      );
      expect(JSON.stringify(stored)).toBe(JSON.stringify(original));
    }
    expect(readGoldItems({ setVersion: SET, root })).toStrictEqual(
      [...acceptedItems()].sort((a, b) => compareText(itemPathOf(a), itemPathOf(b))),
    );
  });

  it("keeps each under its set version, journey and flow, and reads them back by journey and by flow", async () => {
    const root = scratchRoot();
    const result = await writeGoldItems(acceptedItems(), { setVersion: SET, root });
    expect(result.dir).toBe(path.join(root, SET));
    expect(readdirSync(root)).toEqual([SET]);
    expect(result.written).toEqual(
      expect.arrayContaining([
        "journey-01/flow-A/item-low-stakes-s1-02.json",
        "journey-01/flow-A/item-whole-chat-j1.json",
        "journey-03/flow-A/item-danger-crisis-a3-22.json",
        "journey-06/flow-A/item-high-stakes-a6-02-accept.json",
        "journey-11/flow-B/item-two-requests-s11-12.json",
      ]),
    );
    const ids = (options: { journey?: number; flow?: "A" | "B" }): string[] =>
      readGoldItems({ setVersion: SET, root, ...options }).map((item) => item.itemId);
    expect(ids({ flow: "B" })).toEqual(["item-two-requests-s11-12"]);
    expect(ids({ journey: 3 })).toEqual(["item-danger-crisis-a3-22", "item-false-alarm-gas-leak"]);
    expect(ids({ journey: 1, flow: "A" })).toEqual([
      "item-low-stakes-s1-02",
      "item-spanish-s1-02",
      "item-typo-s1-02",
      "item-whole-chat-j1",
    ]);
    expect(ids({ journey: 6, flow: "B" })).toEqual([]);
    for (const item of acceptedItems()) {
      const found = readGoldItems({ setVersion: SET, root, journey: item.journey, flow: item.path.flow });
      expect(found.find((each) => each.itemId === item.itemId)).toStrictEqual(item);
    }
  });
});

describe("refuse-item-without-field-values.json is refused, naming the missing field", () => {
  const line =
    "item 0 (item-low-stakes-s1-02): /turns/0/label/parts/0/fields/0 must have required property 'value' (field \"kinds\")";

  it("is refused for the value its field kinds lacks, and nothing is written", async () => {
    const root = scratchRoot();
    const error = await caught(writeGoldItems([fixtureValue(REFUSED_ITEM_FILE)], { setVersion: SET, root }));
    expect(error).toBeInstanceOf(GoldItemRefused);
    expect((error as GoldItemRefused).problems).toEqual([line]);
    expect((error as GoldItemRefused).message).toContain(line);
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses the whole write it is in: the accepted items beside it are not written either", async () => {
    const root = scratchRoot();
    const given = [...acceptedItems(), fixtureValue(REFUSED_ITEM_FILE)];
    const error = await caught(writeGoldItems(given, { setVersion: SET, root }));
    expect(error).toBeInstanceOf(GoldItemRefused);
    expect((error as GoldItemRefused).problems).toEqual([
      line.replace("item 0", `item ${String(given.length - 1)}`),
    ]);
    expect(existsSync(path.join(root, SET))).toBe(false);
  });

  it("is refused for that one fault: with the value given, it is item-low-stakes-s1-02.json and is kept", async () => {
    const root = scratchRoot();
    const mended = fixtureValue(REFUSED_ITEM_FILE) as GoldItem;
    const field = mended.turns[0].label.parts[0]?.fields[0];
    if (field === undefined) throw new Error("the refused fixture has the field kinds");
    field.value = "Moving and junk hauling";
    const original = fixtureValue("item-low-stakes-s1-02.json");
    expect(mended).toStrictEqual(original);
    await writeGoldItems([mended], { setVersion: SET, root });
    expect(readGoldItem({ setVersion: SET, root, itemId: "item-low-stakes-s1-02" })).toStrictEqual(original);
  });
});

describe("writing the same items twice gives the same manifest sha256", () => {
  it("in one store: the second write keeps every file, the manifest included, byte for byte", async () => {
    const root = scratchRoot();
    const first = await writeGoldItems(acceptedItems(), { setVersion: SET, root });
    const before = snapshot(first.dir);
    const second = await writeGoldItems(acceptedItems(), { setVersion: SET, root });
    expect(second.manifestSha256).toBe(first.manifestSha256);
    expect(second.manifest).toStrictEqual(first.manifest);
    expect(second.written).toEqual([]);
    expect(second.unchanged).toEqual(first.written);
    expect(snapshot(first.dir)).toEqual(before);
    expect(sha256(readFileSync(path.join(first.dir, MANIFEST_FILE)))).toBe(first.manifestSha256);
    expect(readGoldManifest({ setVersion: SET, root }).sha256).toBe(first.manifestSha256);
  });

  it("in fresh stores too, whatever the order and however many writes", async () => {
    const one = await writeGoldItems(acceptedItems(), { setVersion: SET, root: scratchRoot() });
    const reversed = await writeGoldItems(acceptedItems().reverse(), {
      setVersion: SET,
      root: scratchRoot(),
    });
    const split = scratchRoot();
    const all = acceptedItems();
    await writeGoldItems(all.slice(0, 3), { setVersion: SET, root: split });
    const twice = await writeGoldItems(all.slice(3), { setVersion: SET, root: split });
    expect(reversed.manifestSha256).toBe(one.manifestSha256);
    expect(twice.manifestSha256).toBe(one.manifestSha256);
    expect(snapshot(reversed.dir)).toEqual(snapshot(one.dir));
    expect(snapshot(twice.dir)).toEqual(snapshot(one.dir));
  });

  it("names the items: other items give another manifest sha256", async () => {
    const all = await writeGoldItems(acceptedItems(), { setVersion: SET, root: scratchRoot() });
    const fewer = await writeGoldItems(acceptedItems().slice(1), { setVersion: SET, root: scratchRoot() });
    expect(fewer.manifestSha256).not.toBe(all.manifestSha256);
  });
});

describe("the manifest lists counts per section 08 measure and per journey", () => {
  const measureNames = (
    evalSetJson("eval-set.v1.schema.json") as { $defs: { measureName: { enum: MeasureName[] } } }
  ).$defs.measureName.enum;

  // K-10's own sample report of these eight items, in which every message a label lists was sent: its totals are what
  // the items hold for every measure but fallbackMessages, whose total is the messages that run's composer planned.
  const report = fixtureValue("report-code-only-change.json") as AccuracyReport;

  it("lists every section 08 measure in K-10 v1's order, over the set and in each journey", async () => {
    const { manifest } = await writeGoldItems(acceptedItems(), { setVersion: SET, root: scratchRoot() });
    expect([...MEASURES]).toEqual(measureNames);
    expect(Object.keys(manifest.measures)).toEqual(measureNames);
    expect(manifest.byJourney.map((entry) => entry.journey)).toEqual([1, 3, 6, 11]);
    for (const entry of manifest.byJourney) expect(Object.keys(entry.measures)).toEqual(measureNames);
  });

  it("counts what K-10's sample report of the same items counts, overall and per journey", async () => {
    const { manifest } = await writeGoldItems(acceptedItems(), { setVersion: SET, root: scratchRoot() });
    expect(manifest.items).toBe(report.items);
    expect(manifest.byJourney.map((entry) => entry.journey)).toEqual(report.journeys);
    for (const measure of MEASURES) {
      if (measure === "fallbackMessages") continue;
      expect(manifest.measures[measure], measure).toBe(report.measures[measure].total);
      for (const entry of manifest.byJourney) {
        const journey = report.byJourney.find((each) => each.journey === entry.journey);
        expect(entry.measures[measure], `journey ${String(entry.journey)} ${measure}`).toBe(
          journey?.measures[measure].total,
        );
      }
    }
    expect(manifest.measures.fallbackMessages).toBeNull();
    for (const entry of manifest.byJourney) expect(entry.measures.fallbackMessages).toBeNull();
  });

  it("counts the items, turns, texts and flows, over the set and per journey", async () => {
    const { manifest } = await writeGoldItems(acceptedItems(), { setVersion: SET, root: scratchRoot() });
    // Eight items: seven of one turn and the whole chat of two; one text a turn; only the two requests in flow B.
    expect([manifest.items, manifest.turns, manifest.texts, manifest.flows]).toEqual([
      8,
      9,
      9,
      { A: 7, B: 1 },
    ]);
    expect(
      manifest.byJourney.map(({ journey, items, turns, texts, flows }) => [
        journey,
        items,
        turns,
        texts,
        flows,
      ]),
    ).toEqual([
      [1, 4, 5, 5, { A: 4, B: 0 }],
      [3, 2, 2, 2, { A: 2, B: 0 }],
      [6, 1, 1, 1, { A: 1, B: 0 }],
      [11, 1, 1, 1, { A: 0, B: 1 }],
    ]);
  });

  it("lists every item file once, in path order, with the sha256 of its bytes", async () => {
    const result = await writeGoldItems(acceptedItems(), { setVersion: SET, root: scratchRoot() });
    const { files } = result.manifest;
    expect(files.map((file) => file.path)).toEqual(result.written);
    for (const file of files) {
      const item = acceptedItems().find((each) => each.itemId === file.itemId);
      expect(item, file.path).toBeDefined();
      if (item === undefined) continue;
      expect(file).toStrictEqual({
        path: itemPathOf(item),
        itemId: item.itemId,
        journey: item.journey,
        flow: item.path.flow,
        kind: item.kind,
        sha256: sha256(readFileSync(path.join(result.dir, ...file.path.split("/")))),
      });
    }
    expect(readGoldManifest({ setVersion: SET, root: path.dirname(result.dir) }).manifest).toStrictEqual(
      result.manifest,
    );
  });
});
