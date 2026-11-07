// T-143: the plug-in key map. Proofs of the card:
//   - the emitted key map validates against K-01 v1's keyMap (bundle.v1.schema.json) with Ajv, and equals the fixture
//     key-map.json of the contract;
//   - the count report prints the distinct top keys (14), the distinct sub-key names (2,369 on today's 243 files) and
//     the page's 2,344 as not reproduced;
//   - every pf key named by the step entries that need one (315 across both flows) resolves to a field or a text
//     block;
//   - pf.facts, pf.switches, pf.settings and money are typed fields, the 11 free-text pf keys are whole text blocks,
//     and every sub-key is listed as guidance only (Q-39's default).
//
// The expected numbers come from the master's own files, counted here from the raw JSON by code that does not use the
// module under test: the 243 trade files (engine/work/prof) and the two flow files (engine/work/master). How they
// were counted: the distinct names are the keys one level down in each of the eleven free-text values of
// `plugin` (a list or a plain text has none), over all 243 files, each name once whatever its parent. The step
// entries are the steps of master-A.json and master-B.json, branch steps included, whose `needs` holds a `pf.` key.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { PF_TEXT_KEYS, loadTrades, type LoadedTrade } from "../load/trade";
import {
  PAGE_PLUGIN_KEY_COUNT,
  buildKeyMap,
  countPlugInKeys,
  formatCountReport,
  resolvePfKey,
  stepPfNeeds,
} from "./index";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORK = `${ROOT}fixtures/master/engine/work/`;

type Obj = Record<string, unknown>;

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const master = loadMaster();
const trades = loadTrades();
const report = countPlugInKeys(trades);

/** A copy of the barber trade, loaded, for a test to damage. */
function barberCopy(): LoadedTrade {
  const barber = trades.barber;
  if (barber === undefined) throw new Error("barber was not loaded");
  return structuredClone(barber);
}

/** The raw trade files, parsed straight from the master's folder: the reference side of every count below. */
const rawTrades: Obj[] = readdirSync(`${WORK}prof`)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => {
    const data = readJson(`${WORK}prof/${name}`);
    if (!isObj(data)) throw new Error(`${name}: not an object`);
    return data;
  });

function rawPlugin(trade: Obj): Obj {
  const plugin = trade.plugin;
  if (!isObj(plugin)) throw new Error("a trade file has no plugin object");
  return plugin;
}

/** The keys one level down in a free-text value, or none for a list or a text. */
function rawSubKeys(value: unknown): string[] {
  return isObj(value) ? Object.keys(value) : [];
}

describe("the key map is K-01 v1's keyMap", () => {
  const schema = readJson(`${ROOT}contracts/bundle/bundle.v1.schema.json`) as Obj;
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  ajv.addSchema(readJson(`${ROOT}contracts/common/formats.v1.schema.json`) as Obj);
  ajv.addSchema(schema);
  const validate = ajv.getSchema(
    "https://rosie.invalid/contracts/bundle/bundle.v1.schema.json#/$defs/keyMap",
  );
  if (validate === undefined) throw new Error("bundle.v1.schema.json has no $defs/keyMap");

  it("validates against $defs/keyMap with Ajv", () => {
    const ok = validate(buildKeyMap());
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("is not a vacuous check: a wrong map is refused", () => {
    const wrongAs = buildKeyMap();
    wrongAs.keys.push({ key: "pf.extra", as: "guidanceOnly" as "typed", to: "x", why: "x" });
    expect(validate(wrongAs)).toBe(false);

    const leftOutWithTarget = buildKeyMap();
    leftOutWithTarget.keys.push({ key: "extra", as: "leftOut", to: "x", why: "x" });
    expect(validate(leftOutWithTarget)).toBe(false);

    const noTarget = buildKeyMap();
    noTarget.keys.push({ key: "pf.extra", as: "textBlock", why: "x" });
    expect(validate(noTarget)).toBe(false);

    expect(validate({ ...buildKeyMap(), subKeys: "read" })).toBe(false);
  });

  it("equals the contract's fixture key-map.json", () => {
    expect(buildKeyMap()).toEqual(readJson(`${ROOT}contracts/bundle/fixtures/key-map.json`));
  });

  it("is built fresh each time, so one caller's change never reaches another's", () => {
    const first = buildKeyMap();
    first.keys.length = 0;
    const second = buildKeyMap();
    expect(second.keys.length).toBeGreaterThan(0);
    const entry = second.keys[0];
    if (entry === undefined) throw new Error("no entry");
    entry.why = "changed";
    expect(buildKeyMap().keys[0]?.why).not.toBe("changed");
  });
});

describe("what each key maps to (MC R3; Q-39's default)", () => {
  const map = buildKeyMap();
  const byKey = new Map(map.keys.map((entry) => [entry.key, entry]));

  it("maps pf.facts, pf.switches, pf.settings and money to typed fields", () => {
    for (const key of ["pf.facts", "pf.switches", "pf.settings", "money"]) {
      const entry = byKey.get(key);
      expect(entry?.as, key).toBe("typed");
      expect(entry?.to, key).toBeTruthy();
    }
    expect(byKey.get("pf.facts")?.to).toBe("facts");
    expect(byKey.get("pf.switches")?.to).toBe("flows/<flow>/switches");
    expect(byKey.get("pf.settings")?.to).toBe("flows/<flow>/settings");
    expect(byKey.get("money")?.to).toBe("flows/<flow>/money");
  });

  it("maps each of the 11 free-text pf keys to one whole text block, with its sub-keys guidance only", () => {
    expect(PF_TEXT_KEYS).toHaveLength(11);
    for (const key of PF_TEXT_KEYS) {
      const entry = byKey.get(key);
      expect(entry?.as, key).toBe("textBlock");
      expect(entry?.to, key).toBe(`pluginText/${key}`);
    }
    expect(map.subKeys).toBe("guidance");
  });

  it("has an entry for every top key of every one of the 243 trade files, and no entry twice", () => {
    expect(rawTrades).toHaveLength(243);
    const topKeys = new Set<string>();
    const pluginKeys = new Set<string>();
    for (const trade of rawTrades) {
      for (const key of Object.keys(trade)) topKeys.add(key);
      for (const key of Object.keys(rawPlugin(trade))) pluginKeys.add(key);
    }
    expect(map.keys).toHaveLength(byKey.size);
    // the `plugin` key is not an entry of its own: its keys are (pf.facts ... pf.edges)
    for (const key of topKeys) {
      if (key === "plugin") continue;
      expect(byKey.has(key), `top key ${key}`).toBe(true);
    }
    for (const key of pluginKeys) expect(byKey.has(key), `plugin key ${key}`).toBe(true);
  });

  it("leaves out the authoring fields and the sample cast and story, with no target", () => {
    for (const key of [
      "notes",
      "basis",
      "keep",
      "from",
      "splitsKept",
      "keep_why",
      "cast",
      "names",
      "story",
    ]) {
      const entry = byKey.get(key);
      expect(entry?.as, key).toBe("leftOut");
      expect(entry && "to" in entry, key).toBe(false);
    }
  });
});

describe("the count report (specs.md section 5; Q-39)", () => {
  const { count } = report;

  it("prints 14 distinct top keys, the distinct sub-key names, and the page's 2,344 as not reproduced", () => {
    const lines = formatCountReport(count);
    for (const line of lines) console.log(line);
    expect(lines.join("\n")).toContain("distinct top keys: 14");
    expect(lines.join("\n")).toContain(
      "distinct sub-key names under the 11 free-text keys, parent ignored: 2,369",
    );
    expect(lines.join("\n")).toContain("the page's 2,344: not reproduced");
  });

  it("counts 14 distinct top keys: the 11 free-text keys and pf.facts, pf.switches, pf.settings", () => {
    const raw = new Set<string>();
    for (const trade of rawTrades) for (const key of Object.keys(rawPlugin(trade))) raw.add(key);
    expect(raw.size).toBe(14);
    expect(count.topKeys).toEqual([...raw].sort());
    expect(count.topKeys).toEqual([...PF_TEXT_KEYS, "pf.facts", "pf.switches", "pf.settings"].sort());
    expect(count.trades).toBe(243);
  });

  it("counts the distinct sub-key names as the raw files have them: 2,369", () => {
    const raw = new Set<string>();
    const rawLower = new Set<string>();
    const rawPairs = new Set<string>();
    for (const trade of rawTrades) {
      const plugin = rawPlugin(trade);
      for (const key of PF_TEXT_KEYS) {
        for (const name of rawSubKeys(plugin[key])) {
          raw.add(name);
          rawLower.add(name.toLowerCase());
          rawPairs.add(`${key}\u0000${name}`);
        }
      }
    }
    expect(raw.size).toBe(2369);
    expect(rawLower.size).toBe(2362);
    expect(rawPairs.size).toBe(2755);
    expect(count.subKeyNames).toEqual([...raw].sort());
    expect(count.subKeyNames).toHaveLength(2369);
    expect(count.subKeyNamesLowercase).toBe(2362);
    expect(count.textPairs).toBe(2755);
  });

  it("counts the typed keys' own names apart: 7 pairs, 2,762 with the free-text ones", () => {
    const raw = new Set<string>();
    for (const trade of rawTrades) {
      const plugin = rawPlugin(trade);
      for (const key of ["pf.switches", "pf.settings"]) {
        for (const name of rawSubKeys(plugin[key])) raw.add(`${key}.${name}`);
      }
    }
    expect(raw.size).toBe(7);
    expect(count.typedPairs).toBe(7);
    expect(count.textPairs + count.typedPairs).toBe(2762);
  });

  it("counts the pairs one trade uses and the pairs several use: 1,833 and 922", () => {
    expect(count.pairsUsedByOneTrade).toBe(1833);
    expect(count.pairsUsedByTwoOrMore).toBe(922);
    expect(count.pairsUsedByOneTrade + count.pairsUsedByTwoOrMore).toBe(count.textPairs);
  });

  it("carries the page's 2,344 as given, not reproduced: no count of the files gives it", () => {
    expect(PAGE_PLUGIN_KEY_COUNT).toBe(2344);
    expect(count.pageCount).toBe(2344);
    expect(count.pageCountReproduced).toBe(false);
    expect(count.subKeyNames.length).not.toBe(2344);
    // the other readings of the same files miss it too: lowercased, with the typed keys' names, at any depth
    expect(count.subKeyNamesLowercase).not.toBe(2344);
    expect(count.textPairs).not.toBe(2344);
    expect(count.textPairs + count.typedPairs).not.toBe(2344);
  });

  it("says reproduced only when the counted names equal the page's number", () => {
    const names = Array.from({ length: 2344 }, (_, k) => `k${String(k)}`);
    const fake = barberCopy();
    fake.pluginText["pf.license"] = JSON.stringify(Object.fromEntries(names.map((name) => [name, "x"])));
    for (const key of PF_TEXT_KEYS) if (key !== "pf.license") fake.pluginText[key] = '"text"';
    const small = countPlugInKeys({ barber: fake });
    expect(small.count.subKeyNames).toHaveLength(2344);
    expect(small.count.pageCountReproduced).toBe(true);
    expect(formatCountReport(small.count).join("\n")).toContain("the page's 2,344: reproduced");
  });
});

describe("every sub-key is listed as guidance only", () => {
  const { guidance } = report;

  it("lists, under each of the 11 free-text keys, every sub-key the raw files have, with its number of trades", () => {
    expect(guidance.map((entry) => entry.key)).toEqual([...PF_TEXT_KEYS]);
    for (const entry of guidance) {
      const raw = new Map<string, number>();
      for (const trade of rawTrades) {
        for (const name of rawSubKeys(rawPlugin(trade)[entry.key])) raw.set(name, (raw.get(name) ?? 0) + 1);
      }
      expect(
        entry.subKeys.map((sub) => [sub.name, sub.trades]),
        entry.key,
      ).toEqual([...raw].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
    }
  });

  it("finds the most shared sub-keys in 239 files each (specs.md section 5)", () => {
    const uses = (key: string, name: string): number | undefined =>
      guidance.find((entry) => entry.key === key)?.subKeys.find((sub) => sub.name === name)?.trades;
    expect(uses("pf.license", "need")).toBe(239);
    expect(uses("pf.money", "tips")).toBe(239);
    expect(uses("pf.messages", "languages")).toBe(239);
  });

  it("reads a sub-key named like an Object property without trouble", () => {
    const odd = barberCopy();
    odd.pluginText["pf.license"] = '{"__proto__":"a","constructor":"b","toString":"c"}';
    const out = countPlugInKeys({ barber: odd });
    const license = out.guidance.find((entry) => entry.key === "pf.license");
    expect(license?.subKeys.map((sub) => sub.name)).toEqual(["__proto__", "constructor", "toString"]);
  });

  it("gives no sub-keys for a block that is a list or a plain text (15 such blocks among the 243 files)", () => {
    const text = barberCopy();
    text.pluginText["pf.messages"] = '"just words"';
    text.pluginText["pf.first_steps"] = '["a","b"]';
    const out = countPlugInKeys({ barber: text });
    expect(out.guidance.find((entry) => entry.key === "pf.messages")?.subKeys).toEqual([]);
    expect(out.guidance.find((entry) => entry.key === "pf.first_steps")?.subKeys).toEqual([]);
  });

  it("refuses a block that is not JSON text, naming the trade and the key", () => {
    const bad = barberCopy();
    bad.pluginText["pf.rules"] = "not json";
    expect(() => countPlugInKeys({ barber: bad })).toThrow(/barber\.pf\.rules/);
  });
});

describe("the pf keys the steps need (315 step entries across both flows)", () => {
  const map = buildKeyMap();
  const needs = stepPfNeeds(master);

  /** The reference count: walk the raw flow files' nested steps, as the master's own tools do. */
  function rawNeeds(flow: FlowLetter): { steps: number; keys: Set<string> } {
    const data = readJson(`${WORK}master/master-${flow}.json`) as Obj;
    const out = { steps: 0, keys: new Set<string>() };
    const walk = (steps: unknown): void => {
      if (!Array.isArray(steps)) return;
      for (const step of steps as Obj[]) {
        const pf = Array.isArray(step.needs)
          ? (step.needs as string[]).filter((need) => need.startsWith("pf."))
          : [];
        if (pf.length > 0) {
          out.steps += 1;
          for (const key of pf) out.keys.add(key);
        }
        if (Array.isArray(step.branches)) {
          for (const branch of step.branches as Obj[]) walk(branch.steps);
        }
      }
    };
    walk(data.steps);
    return out;
  }

  it("finds 315 step entries that need a pf key: 153 in flow A and 162 in flow B", () => {
    const a = rawNeeds("A");
    const b = rawNeeds("B");
    expect(a.steps).toBe(153);
    expect(b.steps).toBe(162);
    expect(needs.filter((need) => need.flow === "A")).toHaveLength(a.steps);
    expect(needs.filter((need) => need.flow === "B")).toHaveLength(b.steps);
    expect(needs).toHaveLength(315);
  });

  it("resolves every pf key a step needs to a typed field or a whole text block", () => {
    const named = new Set<string>();
    for (const need of needs) {
      for (const key of need.keys) {
        named.add(key);
        const resolved = resolvePfKey(map, key);
        expect(resolved, `${need.flow} ${need.step} needs ${key}`).not.toBeNull();
        expect(["typed", "textBlock"], `${need.step} ${key}`).toContain(resolved?.entry.as);
        expect(resolved?.guidance).toBe(false);
      }
    }
    expect([...named].sort()).toEqual([...new Set([...rawNeeds("A").keys, ...rawNeeds("B").keys])].sort());
    // the 10 free-text keys the steps name resolve to their own whole text block
    expect(named.size).toBe(10);
    for (const key of named) {
      expect(resolvePfKey(map, key)).toMatchObject({ target: `pluginText/${key}`, guidance: false });
    }
  });

  it("resolves every key the slot of S1-11 gives (the 11 free-text keys, pf.edges included)", () => {
    const slot = master.A.steps["S1-11"]?.slot;
    expect(slot?.gives).toHaveLength(11);
    for (const key of slot?.gives ?? []) {
      expect(resolvePfKey(map, key), key).toMatchObject({ target: `pluginText/${key}` });
    }
  });

  it("resolves the typed pf keys to their fields", () => {
    expect(resolvePfKey(map, "pf.facts")).toMatchObject({ target: "facts", guidance: false });
    expect(resolvePfKey(map, "pf.switches")).toMatchObject({ target: "flows/<flow>/switches" });
    expect(resolvePfKey(map, "pf.settings")).toMatchObject({ target: "flows/<flow>/settings" });
  });

  it("resolves a sub-key under a text block to that block, as guidance only", () => {
    expect(resolvePfKey(map, "pf.money.tips")).toMatchObject({
      target: "pluginText/pf.money",
      guidance: true,
    });
    // a sub-key under a typed key is not a text block's guidance
    expect(resolvePfKey(map, "pf.switches.sensitive")).toBeNull();
  });

  it("does not resolve a key the map does not have, a lookalike, or a key that is not a plug-in key", () => {
    for (const key of [
      "pf.nonsense",
      "pf.licensed",
      "pf.",
      "pf",
      "license",
      "rename",
      "A",
      "notes",
      "money",
    ]) {
      expect(resolvePfKey(map, key), key).toBeNull();
    }
  });
});
