// T-133: the trade file loader. The inputs are fixture set v1's trade files
// (fixtures/master/engine/work/prof/<id>.json, 243 files), the sample shops of the master only: the cast, names and
// stories in them are illustrations (MC C6), never live values.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PATTERNS,
  PF_TEXT_KEYS,
  STEP_AUTHORING_FIELDS,
  TRADE_AUTHORING_FIELDS,
  TRADE_DIR,
  TradeLoadError,
  listTradeIds,
  loadTrade,
  loadTrades,
  parseTrade,
  type LoadedTrade,
  type TradeId,
} from "./trade";

const ids = listTradeIds();
const trades = loadTrades();

function readRaw(id: TradeId): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(TRADE_DIR, `${id}.json`), "utf8")) as Record<string, unknown>;
}

function readText(id: TradeId): string {
  return readFileSync(path.join(TRADE_DIR, `${id}.json`), "utf8");
}

function plugin(id: TradeId): Record<string, unknown> {
  return readRaw(id).plugin as Record<string, unknown>;
}

function all(): LoadedTrade[] {
  return ids.map((id) => {
    const trade = trades[id];
    if (trade === undefined) throw new Error(`${id} was not loaded`);
    return trade;
  });
}

/** Every key name used anywhere under a value, objects and arrays included. */
function keyNames(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keyNames(item, into);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      into.add(key);
      keyNames(item, into);
    }
  }
  return into;
}

/** A fresh, valid trade file to damage in a test: barber, as the file has it. */
const fresh = (): Record<string, unknown> => structuredClone(readRaw("barber"));
const flowBlock = (raw: Record<string, unknown>, flow: "A" | "B"): { ops: Record<string, unknown>[] } =>
  raw[flow] as { ops: Record<string, unknown>[] };

describe("loadTrades: the 243 trade files (specs.md section 2, counted Nov 5)", () => {
  it("loads 243 trades, one per file, each with its own id", () => {
    expect(ids).toHaveLength(243);
    expect(Object.keys(trades)).toEqual(ids);
    for (const trade of all()) {
      expect(trade.id).toBe(readRaw(trade.id).id);
      expect(PATTERNS as readonly string[]).toContain(trade.pattern);
      expect(trade.name.length).toBeGreaterThan(0);
      expect(Object.keys(trade.flows)).toEqual(["A", "B"]);
    }
  });

  it("loads a trade through loadTrade as through loadTrades", () => {
    expect(loadTrade("barber")).toEqual(trades.barber);
  });

  it("insurance.json is the only trade with no pf.facts (C5 fills it in T-139)", () => {
    expect(
      all()
        .filter((trade) => trade.facts === null)
        .map((trade) => trade.id),
    ).toEqual(["insurance"]);
    expect("pf.facts" in plugin("insurance")).toBe(false);
    expect(all().filter((trade) => trade.facts !== null)).toHaveLength(242);
  });

  it("12 trades have no pf.settings, and the loader fills nothing in for them", () => {
    const without = all()
      .filter((trade) => trade.settings === null)
      .map((trade) => trade.id);
    expect(without).toEqual([
      "art-classes",
      "band",
      "clown",
      "coding-classes",
      "comedian",
      "cooking-classes",
      "dance",
      "dj",
      "inspector",
      "insurance",
      "language-school",
      "party-characters",
    ]);
    for (const id of without) expect("pf.settings" in plugin(id)).toBe(false);
  });

  it("144 trades have pf.switches, with the counted names", () => {
    const withSwitches = all().filter((trade) => trade.switches !== null);
    expect(withSwitches).toHaveLength(144);
    const names: Record<string, number> = {};
    for (const trade of withSwitches) {
      for (const name of Object.keys(trade.switches ?? {})) names[name] = (names[name] ?? 0) + 1;
    }
    expect(names).toEqual({ sensitive: 69, cancelright: 46, welfare: 36, no2: 5, nomoney: 2 });
    for (const trade of withSwitches) {
      if (trade.switches?.no2 !== undefined) expect(trade.switches.no2).toBe(false);
    }
  });
});

describe("the ops of every trade (specs.md section 2: 25,136 in all)", () => {
  it("match the Nov 5 count: off 11,677, words 11,139, more 1,822, after 281, branch 166, before 51", () => {
    const counts: Record<string, number> = {};
    for (const trade of all()) {
      for (const flow of ["A", "B"] as const) {
        for (const op of trade.flows[flow].ops) counts[op.op] = (counts[op.op] ?? 0) + 1;
      }
    }
    expect(counts).toEqual({
      off: 11677,
      words: 11139,
      more: 1822,
      after: 281,
      branch: 166,
      before: 51,
    });
    expect(Object.values(counts).reduce((total, n) => total + n, 0)).toBe(25136);
  });

  it("keeps each flow's ops in the file's order and as the file writes them", () => {
    for (const id of ids) {
      const raw = readRaw(id);
      for (const flow of ["A", "B"] as const) {
        const loaded = trades[id]?.flows[flow].ops ?? [];
        const written = flowBlock(raw, flow).ops;
        expect(loaded.map((op) => [op.op, op.at])).toEqual(written.map((op) => [op.op, op.at]));
        // The ops that add nothing of their own are the file's objects exactly.
        loaded.forEach((op, k) => {
          if (op.op === "off" || op.op === "words" || op.op === "more") expect(op).toEqual(written[k]);
        });
      }
    }
  });

  it("keeps the steps and branches an op adds, with their nested branches", () => {
    let own = 0;
    for (const trade of all()) {
      for (const flow of ["A", "B"] as const) {
        for (const op of trade.flows[flow].ops) {
          if (op.op === "after" || op.op === "before") own += op.steps.length;
          if (op.op === "branch") expect(op.branch.label.length).toBeGreaterThan(0);
        }
      }
    }
    expect(own).toBeGreaterThanOrEqual(332);
    expect(loadTrade("barber").flows.A.ops.length).toBe(flowBlock(readRaw("barber"), "A").ops.length);
  });
});

describe("R2: authoring fields are dropped", () => {
  it("the trade files do carry notes, keep, from and splitsKept (and basis in 242, keep_why in 1)", () => {
    const seen: Record<string, number> = {};
    for (const id of ids) {
      for (const key of Object.keys(readRaw(id))) {
        if (TRADE_AUTHORING_FIELDS.includes(key)) seen[key] = (seen[key] ?? 0) + 1;
      }
    }
    expect(seen).toEqual({ notes: 243, keep: 243, from: 232, splitsKept: 243, basis: 242, keep_why: 1 });
  });

  it("no R2 field survives in any loaded trade, however deep", () => {
    for (const trade of all()) {
      const names = keyNames(trade);
      for (const field of [...TRADE_AUTHORING_FIELDS, ...STEP_AUTHORING_FIELDS])
        expect(names.has(field), `${trade.id}.${field}`).toBe(false);
    }
  });

  it("drops src and prop from a step an op adds and keeps the rest", () => {
    // Take an op that adds steps from a trade that has one, and give barber a copy of it.
    const donor = ids.map(readRaw).find((raw) => flowBlock(raw, "A").ops.some((op) => op.op === "after"));
    const found = flowBlock(donor ?? {}, "A").ops.find((op) => op.op === "after");
    if (found === undefined) throw new Error("no trade has an after op in flow A");
    const after = structuredClone(found) as { steps: Record<string, unknown>[] };
    const first = after.steps[0];
    if (first === undefined) throw new Error("the after op has no step");
    first.src = "an old node";
    first.prop = "P-12";
    const raw = fresh();
    flowBlock(raw, "A").ops.push(after);
    const loaded = parseTrade(raw, "barber").flows.A.ops.at(-1);
    expect(loaded?.op).toBe("after");
    const names = loaded?.op === "after" ? keyNames(loaded.steps) : new Set<string>();
    expect(names.has("src")).toBe(false);
    expect(names.has("prop")).toBe(false);
    expect(loaded?.op === "after" ? loaded.steps[0]?.title : undefined).toBe(first.title);
  });
});

describe("R3: typed pf.facts, pf.switches, pf.settings and money.<flow>, read by name", () => {
  it("keeps pf.facts, pf.switches and pf.settings as the file's values", () => {
    for (const trade of all()) {
      const pf = plugin(trade.id);
      expect(trade.facts).toEqual(pf["pf.facts"] ?? null);
      expect(trade.switches).toEqual(pf["pf.switches"] ?? null);
      expect(trade.settings).toEqual(pf["pf.settings"] ?? null);
    }
  });

  it("types a value for one flow only, and a window of hours", () => {
    const settingsOf = (id: TradeId): unknown => trades[id]?.settings;
    const every = all().flatMap((trade) => (trade.settings === null ? [] : [trade.settings]));
    expect(every.some((s) => typeof s.arrive === "string")).toBe(true);
    expect(every.some((s) => typeof s.arrive === "object" && "A" in s.arrive)).toBe(true);
    expect(JSON.stringify(every)).toContain('"window":2');
    expect(settingsOf("barber")).toEqual({ arrive: "setstart", cutoff: "24 hours before" });
    expect(trades.barber?.facts).toEqual(["children", "documents", "extrawork", "groups", "photos"]);
  });

  it("keeps money.<flow> by name, as the file writes it", () => {
    for (const trade of all()) {
      const raw = readRaw(trade.id).money as Record<string, unknown>;
      for (const flow of ["A", "B"] as const) {
        const money = trade.flows[flow].money;
        expect(money).toEqual(raw[flow]);
        expect(money.combos).toContain(money.main);
      }
    }
  });

  it("counts the money keys (specs.md section 2)", () => {
    const seen: Record<string, number> = {};
    for (const trade of all()) {
      for (const flow of ["A", "B"] as const) {
        for (const key of Object.keys(trade.flows[flow].money)) seen[key] = (seen[key] ?? 0) + 1;
      }
    }
    expect(seen).toMatchObject({
      main: 486,
      combos: 486,
      examples: 486,
      amounts: 486,
      services: 204,
      booking: 109,
      labels: 70,
    });
  });

  it("keeps the rename pairs, cast, names, story and slot rows for the applier", () => {
    for (const trade of all()) {
      const raw = readRaw(trade.id);
      const slots = (raw.slots ?? {}) as Record<string, unknown>;
      for (const flow of ["A", "B"] as const) {
        const loaded = trade.flows[flow];
        expect(loaded.rename).toEqual((raw.rename as Record<string, unknown>)[flow]);
        expect(loaded.story).toBe((raw.story as Record<string, unknown>)[flow]);
        expect(loaded.cast).toEqual(((raw.cast ?? {}) as Record<string, unknown>)[flow] ?? null);
        expect(loaded.names).toEqual(((raw.names ?? {}) as Record<string, unknown>)[flow] ?? null);
        expect(loaded.slotRows).toEqual(slots[flow] ?? {});
      }
    }
    expect(all().filter((trade) => trade.flows.A.cast !== null)).toHaveLength(198);
    expect(all().filter((trade) => trade.flows.A.names !== null)).toHaveLength(190);
    expect(all().filter((trade) => Object.keys(trade.flows.A.slotRows).length > 0)).toHaveLength(6);
    expect(all().filter((trade) => Object.keys(trade.flows.B.slotRows).length > 0)).toHaveLength(4);
  });
});

describe("R3: the 11 free-text pf blocks are stored whole, byte for byte", () => {
  it("names the 11 keys of the plug-in slot", () => {
    expect(PF_TEXT_KEYS).toHaveLength(11);
    expect(PF_TEXT_KEYS).toEqual([
      "pf.license",
      "pf.services",
      "pf.questions",
      "pf.safety",
      "pf.first_steps",
      "pf.visit",
      "pf.money",
      "pf.messages",
      "pf.staff",
      "pf.rules",
      "pf.edges",
    ]);
  });

  it("every trade holds all 11 blocks, and a block is JSON.stringify of the file's value", () => {
    for (const trade of all()) {
      expect(Object.keys(trade.pluginText)).toEqual([...PF_TEXT_KEYS]);
      const pf = plugin(trade.id);
      for (const key of PF_TEXT_KEYS) {
        expect(trade.pluginText[key], `${trade.id} ${key}`).toBe(JSON.stringify(pf[key]));
        expect(JSON.parse(trade.pluginText[key])).toEqual(pf[key]);
      }
    }
  });

  it("each block's text is the bytes of the trade file: the file's own lines for that key, indentation aside", () => {
    // The files are written with one space of indent (JSON.stringify(x, null, 1)). A block, pretty-printed the same
    // way at its depth, must appear verbatim in the file's text. This checks the file's bytes, not the parsed value.
    let checked = 0;
    for (const trade of all()) {
      const text = readText(trade.id);
      for (const key of PF_TEXT_KEYS) {
        const value: unknown = JSON.parse(trade.pluginText[key]);
        const inFile = `  ${JSON.stringify(key)}: ${JSON.stringify(value, null, 1).replaceAll("\n", "\n  ")}`;
        expect(text.includes(inFile), `${trade.id} ${key}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(243 * 11);
  });

  it("a block that is a string, a list or an object keeps its kind", () => {
    const kinds = new Set<string>();
    for (const trade of all()) {
      for (const key of PF_TEXT_KEYS) {
        const value: unknown = JSON.parse(trade.pluginText[key]);
        kinds.add(typeof value === "string" ? "string" : Array.isArray(value) ? "list" : "object");
      }
    }
    expect([...kinds].sort()).toEqual(["list", "object", "string"]);
    // Four trades write pf.messages as one string, five write pf.services as a list (counted by the loader's author).
    const asString = all().filter((trade) => typeof JSON.parse(trade.pluginText["pf.messages"]) === "string");
    expect(asString).toHaveLength(4);
  });

  it("the stop words stay inside the safety block, which code does not read", () => {
    // specs.md section 2: stop words sit under `stop` in 131 files and `stop_words` in 29.
    const keysOf = (trade: LoadedTrade): string[] =>
      Object.keys(JSON.parse(trade.pluginText["pf.safety"]) as Record<string, unknown>);
    expect(all().filter((trade) => keysOf(trade).includes("stop"))).toHaveLength(131);
    expect(all().filter((trade) => keysOf(trade).includes("stop_words"))).toHaveLength(29);
    for (const trade of all()) expect(Object.keys(trade)).not.toContain("safety");
  });
});

describe("parseTrade refuses a trade file it does not understand", () => {
  it("accepts an untouched copy", () => {
    expect(parseTrade(fresh(), "barber").id).toBe("barber");
  });

  it("names the path of an unknown top-level key", () => {
    const raw = fresh();
    raw.extra = 1;
    expect(() => parseTrade(raw, "barber")).toThrow(TradeLoadError);
    expect(() => parseTrade(raw, "barber")).toThrow(/barber\.json\.extra: unknown top-level key/);
  });

  it("refuses a file whose id is another trade's", () => {
    expect(() => parseTrade(fresh(), "hair")).toThrow(/hair\.json\.id: expected "hair"/);
  });

  it("refuses a pattern that is not one of the eleven", () => {
    const raw = fresh();
    raw.pattern = "walk-in";
    expect(() => parseTrade(raw, "barber")).toThrow(
      /barber\.json\.pattern: "walk-in" is not a booking pattern/,
    );
  });

  it("refuses a missing free-text block and an unknown plug-in key", () => {
    const missing = fresh();
    delete (missing.plugin as Record<string, unknown>)["pf.edges"];
    expect(() => parseTrade(missing, "barber")).toThrow(/plugin\.pf\.edges: the free-text block is missing/);
    const unknown = fresh();
    (unknown.plugin as Record<string, unknown>)["pf.extra"] = "x";
    expect(() => parseTrade(unknown, "barber")).toThrow(/plugin\.pf\.extra: unknown plug-in key/);
  });

  it("refuses settings and switches of the wrong shape", () => {
    const badArrive = fresh();
    ((badArrive.plugin as Record<string, unknown>)["pf.settings"] as Record<string, unknown>).arrive =
      "early";
    expect(() => parseTrade(badArrive, "barber")).toThrow(/pf\.settings\.arrive: expected "window"/);
    const badSwitch = fresh();
    (badSwitch.plugin as Record<string, unknown>)["pf.switches"] = { sensitive: "yes" };
    expect(() => parseTrade(badSwitch, "barber")).toThrow(/pf\.switches\.sensitive: expected true or false/);
    const badFacts = fresh();
    (badFacts.plugin as Record<string, unknown>)["pf.facts"] = "photos";
    expect(() => parseTrade(badFacts, "barber")).toThrow(/pf\.facts: expected an array/);
  });

  it("refuses an op that is unknown, an off without its why, and a step id that is nobody's", () => {
    const unknownOp = fresh();
    flowBlock(unknownOp, "A").ops.push({ op: "swap", at: "S1-01" });
    expect(() => parseTrade(unknownOp, "barber")).toThrow(/"swap" is not an op/);

    const noWhy = fresh();
    flowBlock(noWhy, "B").ops.push({ op: "off", at: "S1-01", why: "" });
    expect(() => parseTrade(noWhy, "barber")).toThrow(
      /B\.ops\[\d+\] \(off S1-01\)\.why: an off needs its why/,
    );

    const badAt = fresh();
    flowBlock(badAt, "A").ops.push({ op: "more", at: "X1-01", more: ["a line"] });
    expect(() => parseTrade(badAt, "barber")).toThrow(/"X1-01" is not a step id/);

    const extraField = fresh();
    flowBlock(extraField, "A").ops.push({ op: "more", at: "S1-01", more: ["a line"], extra: 1 });
    expect(() => parseTrade(extraField, "barber")).toThrow(/unknown more field/);
  });

  it("refuses money of the wrong shape", () => {
    const badMain = fresh();
    ((badMain.money as Record<string, unknown>).A as Record<string, unknown>).main = "list|card";
    expect(() => parseTrade(badMain, "barber")).toThrow(/money\.A\.main: "list\|card" is not a money path/);
    const extra = fresh();
    ((extra.money as Record<string, unknown>).B as Record<string, unknown>).hold = {};
    expect(() => parseTrade(extra, "barber")).toThrow(/money\.B\.hold: unknown money field/);
  });

  it("refuses a flow key that is neither A nor B", () => {
    const raw = fresh();
    (raw.rename as Record<string, unknown>).C = [];
    expect(() => parseTrade(raw, "barber")).toThrow(/rename\.C: unknown flow key/);
  });

  it("refuses a file that is not there", () => {
    expect(() => loadTrade("no-such-trade")).toThrow(/cannot read it as JSON/);
    expect(() => listTradeIds(path.join(TRADE_DIR, "missing"))).toThrow(/cannot list the folder/);
  });
});
