// T-146: the routing tables.
//   - the hubs are A3-51/B3-40, A7-02/B7-05, A8-32/B8-22, A10-06/B10-07, S11-12, S11-53, S11-42; the doors include
//     A3-43/B3-35 and S11-21;
//   - the any-time table has 21 rows in arch 03's order; each row has a handler in A and in B, or is in
//     unresolved-anytime.json for Jay (Q-40), and every step it names is a step of the flow;
//   - each flow compiles 50 rule nodes, one per S13 step of the step index (S13-01 to S13-57, 50 of the 57 numbers);
//   - the 10 homes are the flow's record.homes;
//   - the any-time table validates against K-01 v1 (bundle.v1.schema.json, anytimeTable), and flow A's matches the
//     contract's own fixture (anytime-table.json).
// Walking all 243 trades is in the parity shards (parity.shard-N.test.ts), not here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import type { FlowGraph, FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { loadTrade } from "../load/trade";
import { applyTrade } from "../overlay/apply";
import { HOME_NAMES } from "../record";
import {
  ANYTIME_ROW_NAMES,
  DOORS,
  RULE_NODE_COUNT,
  RoutingError,
  compileRouting,
  compileTradeRouting,
  namedSteps,
  unresolvedAnytime,
} from "./index";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HERE = fileURLToPath(new URL("./", import.meta.url));
const FLOWS: readonly FlowLetter[] = ["A", "B"];

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const master = loadMaster();
const tables = { A: compileRouting(master.A), B: compileRouting(master.B) };

describe("hubs and doors", () => {
  it("the hubs are the ones arch 03 line 163 names", () => {
    expect(tables.A.hubs).toEqual({
      entry: "A3-51",
      booked: "A7-02",
      checkedIn: "A8-32",
      done: "A10-06",
      owner: "S11-12",
      settings: "S11-53",
      team: "S11-42",
    });
    expect(tables.B.hubs).toEqual({
      entry: "B3-40",
      booked: "B7-05",
      checkedIn: "B8-22",
      done: "B10-07",
      owner: "S11-12",
      settings: "S11-53",
      team: "S11-42",
    });
  });

  it("the doors are the ones arch 03 line 165 names", () => {
    expect(tables.A.doors).toEqual({
      newBooking: "A3-51",
      existingBooking: "A3-43",
      ownerCommand: "S11-12",
      teamChange: "S11-42",
      unclearOwnerOrHelp: "S11-21",
    });
    expect(tables.B.doors).toEqual({
      newBooking: "B3-40",
      existingBooking: "B3-35",
      ownerCommand: "S11-12",
      teamChange: "S11-42",
      unclearOwnerOrHelp: "S11-21",
    });
  });

  it.each(FLOWS)("every hub and door of flow %s is a step of that flow", (flow) => {
    for (const id of [...Object.values(tables[flow].hubs), ...Object.values(tables[flow].doors)])
      expect(master[flow].steps[id], id).toBeDefined();
  });

  it("a hub that is not a step of the flow is refused, naming it", () => {
    const flow = structuredClone(master.A);
    flow.path = flow.path.filter((step) => step.id !== "S11-53");
    expect(() => compileRouting(flow)).toThrow(RoutingError);
  });

  it("the tables name no step outside the two flows", () => {
    for (const flow of FLOWS)
      for (const id of namedSteps(flow)) expect(master[flow].steps[id], id).toBeDefined();
    expect(DOORS.A.existingBooking).toBe("A3-43");
  });
});

describe("the any-time table", () => {
  it.each(FLOWS)("flow %s has 21 rows in arch 03's order, each once", (flow) => {
    const rows = tables[flow].anytime.rows;
    expect(rows).toHaveLength(21);
    expect(rows.map((row) => row.row)).toEqual([...ANYTIME_ROW_NAMES]);
    expect(rows.map((row) => row.order)).toEqual(Array.from({ length: 21 }, (_, k) => k + 1));
    expect(rows.filter((row) => row.safetyReadOnly).map((row) => row.order)).toEqual([1, 2, 3]);
  });

  it("the rows are the words of arch 03 line 171, in its order", () => {
    const words = [
      "Danger or crisis",
      "Threat",
      "Child, elder or unsafe at home",
      "Problem getting worse",
      "Death",
      "STOP",
      "Wrong party or language",
      "Third party or privacy",
      "Contact change",
      "Payment problem",
      "Complaint or dispute",
      "Damage",
      "Owner command",
      "Cancel",
      "Move",
      "Running late",
      "Business can’t make it",
      "Scope change or new request",
      "Question or unclear reply",
      "Platform or AI failure",
      "Due items",
    ];
    const slug = (text: string): string =>
      text
        .toLowerCase()
        .replace(/’/g, "")
        .replace(/[^a-z0-9]+/g, "-");
    expect(words.map(slug)).toEqual([...ANYTIME_ROW_NAMES]);
  });

  it("each row has a handler in A and in B, or is listed for Jay in both", () => {
    const unresolved = new Map(unresolvedAnytime().map((entry) => [entry.row, entry]));
    for (const [k, name] of ANYTIME_ROW_NAMES.entries()) {
      const a = tables.A.anytime.rows[k];
      const b = tables.B.anytime.rows[k];
      expect(a?.row).toBe(name);
      if (a?.handler === null || b?.handler === null) {
        expect(unresolved.get(name), `${name} is in unresolved-anytime.json`).toBeDefined();
        expect(a?.handler, name).toBeNull();
        expect(b?.handler, name).toBeNull();
      } else {
        expect(unresolved.has(name), `${name} is not listed for Jay`).toBe(false);
        expect(a?.handler, name).toBeTypeOf("string");
        expect(b?.handler, name).toBeTypeOf("string");
      }
    }
  });

  it("the handlers that Q-40 starts from are there, with their flags", () => {
    const at = (flow: FlowLetter, row: string) => tables[flow].anytime.rows.find((r) => r.row === row);
    expect(at("A", "danger-or-crisis")?.handler).toBe("A3-22");
    expect(at("B", "danger-or-crisis")?.handler).toBe("B3-17");
    expect(at("A", "threat")).toMatchObject({ handler: "A3-48", flags: ["paused"] });
    expect(at("A", "death")).toMatchObject({ handler: "A7-81", flags: ["deceased"] });
    expect(at("A", "stop")).toMatchObject({ handler: "A7-11", flags: ["stopped"] });
    expect(at("B", "stop")?.handler).toBe("B7-15");
    expect(at("A", "contact-change")?.handler).toBe("A7-98");
    expect(at("B", "contact-change")?.handler).toBe("B7-88");
    expect(at("A", "owner-command")?.handler).toBe("S11-12");
    expect(at("B", "platform-or-ai-failure")?.handler).toBe("S12-11");
    expect(at("A", "child-elder-or-unsafe-at-home")?.flags).toEqual(["private"]);
  });

  it("unresolved-anytime.json is the table's own list of rows with no step", () => {
    const written = readJson(`${HERE}unresolved-anytime.json`) as { rows: unknown };
    expect(written.rows).toEqual(JSON.parse(JSON.stringify(unresolvedAnytime())));
    for (const entry of unresolvedAnytime()) {
      for (const flow of FLOWS)
        for (const id of entry.candidates[flow])
          expect(master[flow].steps[id], `${entry.row} ${id}`).toBeDefined();
    }
  });

  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  ajv.addSchema(readJson(`${ROOT}contracts/common/formats.v1.schema.json`));
  ajv.addSchema(readJson(`${ROOT}contracts/bundle/bundle.v1.schema.json`));
  const validate = ajv.getSchema(
    "https://rosie.invalid/contracts/bundle/bundle.v1.schema.json#/$defs/anytimeTable",
  );

  function accepted(value: unknown): string[] {
    if (validate === undefined) throw new Error("K-01 has no anytimeTable definition");
    if (validate(value) === true) return [];
    return (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
  }

  it.each(FLOWS)("flow %s's table validates against K-01 v1", (flow) => {
    expect(accepted(tables[flow].anytime)).toEqual([]);
  });

  it("the contract's own anytime-table.json validates, and flow A's table is it", () => {
    const fixture = readJson(`${ROOT}contracts/bundle/fixtures/anytime-table.json`);
    expect(accepted(fixture)).toEqual([]);
    expect(tables.A.anytime).toEqual(fixture);
  });

  it("a table with 20 rows is not K-01's (the schema is not vacuous)", () => {
    const short = { rows: tables.A.anytime.rows.slice(1) };
    expect(accepted(short).length).toBeGreaterThan(0);
  });
});

describe("the 50 rule nodes", () => {
  function s13Ids(graph: FlowGraph): string[] {
    return Object.keys(graph.steps)
      .filter((id) => id.startsWith("S13-"))
      .sort();
  }

  it.each(FLOWS)("flow %s compiles one rule node per S13 step of the step index", (flow) => {
    const ids = s13Ids(master[flow]);
    expect(ids).toHaveLength(RULE_NODE_COUNT);
    expect(tables[flow].ruleNodes.map((node) => node.id).sort()).toEqual(ids);
    expect(tables[flow].alwaysOn.steps).toEqual(tables[flow].ruleNodes.map((node) => node.id));
    for (const id of ids) expect(id).toMatch(/^S13-(0[1-9]|[1-4][0-9]|5[0-7])$/);
  });

  it("the prefix is the nodes' text in order, and its sha256 is the hash of its UTF-8 bytes", async () => {
    const { createHash } = await import("node:crypto");
    for (const flow of FLOWS) {
      const { alwaysOn, ruleNodes } = tables[flow];
      expect(alwaysOn.prefixText).toBe(ruleNodes.map((node) => node.text).join("\n\n"));
      expect(alwaysOn.prefixSha256).toBe(
        createHash("sha256").update(alwaysOn.prefixText, "utf8").digest("hex"),
      );
      expect(alwaysOn.prefixSha256).toMatch(/^[0-9a-f]{64}$/);
      for (const node of ruleNodes) expect(alwaysOn.prefixText).toContain(node.title);
    }
  });

  it("a flow without one of its rule nodes is refused", () => {
    const flow = structuredClone(master.B);
    const last = flow.path.findIndex((step) => step.id === "S13-52");
    flow.path.splice(last, 1);
    expect(() => compileRouting(flow)).toThrow(/49 rule nodes/);
  });

  it("a rule node that is not section 13 is refused", () => {
    const flow = structuredClone(master.A);
    const rule = flow.path.find((step) => step.id === "S13-23");
    if (rule === undefined) throw new Error("S13-23 missing");
    rule.id = "S12-99";
    expect(() => compileRouting(flow)).toThrow(RoutingError);
  });
});

describe("the homes", () => {
  it.each(FLOWS)("flow %s compiles the 10 homes of its record.homes", (flow) => {
    expect(Object.keys(tables[flow].homes)).toEqual([...HOME_NAMES]);
    expect(tables[flow].homes).toEqual(master[flow].record.homes);
    expect(tables[flow].homes).toMatchObject({
      money: "S13-55",
      contact: "S13-19",
      proof: "S13-45",
      stop: "S13-32",
      clock: "S13-35",
      who: "S13-31",
      safety: "S13-10",
      change: "S13-56",
      record: "S13-57",
      two: "A9-21",
    });
  });

  it("a record with a home that is not a step, or an eleventh home, is refused", () => {
    const missing = structuredClone(master.B);
    missing.record.homes.two = "B9-99";
    expect(() => compileRouting(missing)).toThrow(/homes\.two/);
    const extra = structuredClone(master.A);
    extra.record.homes.extra = "S13-01";
    expect(() => compileRouting(extra)).toThrow(/homes\.extra/);
  });
});

describe("a trade's routing", () => {
  it.each(["aba", "cpa"])("%s's flows route as the master does, with its own homes and rules", (id) => {
    const trade = loadTrade(id);
    for (const flow of FLOWS) {
      const own = compileTradeRouting(applyTrade(master[flow], trade));
      expect(own.hubs).toEqual(tables[flow].hubs);
      expect(own.doors).toEqual(tables[flow].doors);
      expect(own.anytime).toEqual(tables[flow].anytime);
      expect(own.alwaysOn.steps).toEqual(tables[flow].alwaysOn.steps);
      expect(own.ruleNodes).toHaveLength(RULE_NODE_COUNT);
      expect(own.homes).toEqual(tables[flow].homes);
    }
  });
});
