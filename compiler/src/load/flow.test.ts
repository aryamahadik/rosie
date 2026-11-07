// T-132: the master flow loader and the CLI that later commands join. The inputs are fixture set v1's master files
// (fixtures/master/engine/work/master/master-A.json and master-B.json), the sample cast and shops of the master only.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { commandFiles, loadCommands, main, type CliIo } from "../cli/index";
import type { FlowGraph, FlowLetter, Step } from "../graph/types";
import {
  AUTHORING_FIELDS,
  LANES,
  LANE_MEANING,
  MASTER_DIR,
  MasterLoadError,
  flowCounts,
  laneMeaning,
  loadFlow,
  loadMaster,
  parseFlow,
} from "./flow";

const master = loadMaster();

function readRaw(flow: FlowLetter): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(MASTER_DIR, `master-${flow}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

/** Every step of a loaded flow found by walking its main path and branches, in master order. */
function walkPath(graph: FlowGraph): Step[] {
  const found: Step[] = [];
  const visit = (list: Step[]): void => {
    for (const step of list) {
      found.push(step);
      for (const branch of step.branches ?? []) visit(branch.steps);
    }
  };
  visit(graph.path);
  return found;
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

describe("loadFlow: the counts of the master (specs.md 1.2, counted Nov 5)", () => {
  it("flow A: 478 steps, 121 splits, 407 branches", () => {
    expect(flowCounts(master.A)).toEqual({ steps: 478, splits: 121, branches: 407 });
  });

  it("flow B: 493 steps, 131 splits (and 427 branches, counted by this test)", () => {
    expect(flowCounts(master.B)).toEqual({ steps: 493, splits: 131, branches: 427 });
  });

  it("loads the same graph through loadFlow as through loadMaster", () => {
    expect(loadFlow("A")).toEqual(master.A);
    expect(loadFlow("B")).toEqual(master.B);
  });

  it("keeps the master's header, money, record and layer lines", () => {
    for (const graph of [master.A, master.B]) {
      expect(graph.money.combos).toHaveLength(28);
      expect(Object.keys(graph.record.slots)).toHaveLength(16);
      expect(graph.record.fixtures).toHaveLength(11);
      expect(graph.layerLines.map((line) => line.id)).toEqual([
        "private",
        "privatecall",
        "textsonly",
        "emailonly",
      ]);
      expect(Object.keys(graph.switches)).toEqual(["verify"]);
      expect(Object.keys(graph.facts)).toHaveLength(11);
      expect(graph.d75).toBe(true);
    }
    expect(master.A.tookAt).toBe("A5-04");
    expect(master.B.tookAt).toBe("B5-02");
  });
});

describe("loadFlow: one node per step id", () => {
  it("every step appears once in the main path and branches, and the index holds that same object", () => {
    for (const graph of [master.A, master.B]) {
      const walked = walkPath(graph);
      const ids = walked.map((step) => step.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(Object.keys(graph.steps).sort()).toEqual([...ids].sort());
      for (const step of walked) expect(graph.steps[step.id]).toBe(step);
    }
  });

  it("the 204 S-steps in both flows are one node per id in each", () => {
    expect(master.sharedIds).toHaveLength(204);
    for (const id of master.sharedIds) {
      expect(id.startsWith("S")).toBe(true);
      for (const graph of [master.A, master.B]) {
        const nodes = walkPath(graph).filter((step) => step.id === id);
        expect(nodes).toHaveLength(1);
        expect(graph.steps[id]).toBe(nodes[0]);
      }
    }
  });

  it("the other S-steps and all A- and B-steps belong to one flow", () => {
    const onlyA = Object.keys(master.A.steps).filter((id) => id.startsWith("S") && !(id in master.B.steps));
    const onlyB = Object.keys(master.B.steps).filter((id) => id.startsWith("S") && !(id in master.A.steps));
    expect(onlyA.length + master.sharedIds.length).toBe(
      Object.keys(master.A.steps).filter((id) => id.startsWith("S")).length,
    );
    expect(onlyB.length + master.sharedIds.length).toBe(
      Object.keys(master.B.steps).filter((id) => id.startsWith("S")).length,
    );
    expect(Object.keys(master.A.steps).some((id) => id.startsWith("B"))).toBe(false);
    expect(Object.keys(master.B.steps).some((id) => id.startsWith("A"))).toBe(false);
  });

  it("gives each step its section, 13 sections in order, and nests branch steps in their split", () => {
    for (const graph of [master.A, master.B]) {
      expect(graph.sections.map((section) => section.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      expect(graph.sections.every((section) => section.title.length > 0 && section.steps.length > 0)).toBe(
        true,
      );
      expect(graph.sections.flatMap((section) => section.steps)).toEqual(graph.path.map((step) => step.id));
      for (const step of Object.values(graph.steps))
        expect(step.id).toMatch(new RegExp(`^[SAB]${String(step.section)}-`));
    }
    const split = master.A.steps["S1-02"];
    expect(split?.type).toBe("split");
    expect(split?.branches?.[1]?.steps.map((step) => step.id)).toContain("S1-03");
  });
});

describe("R2: authoring fields are dropped", () => {
  it("the master files do carry src and prop on steps", () => {
    for (const flow of ["A", "B"] as const) {
      const raw = JSON.stringify(readRaw(flow));
      expect(raw).toContain('"src"');
      expect(raw).toContain('"prop"');
    }
  });

  it("no loaded step or branch carries src or prop, however deep", () => {
    for (const graph of [master.A, master.B]) {
      const names = keyNames(graph.path);
      for (const field of AUTHORING_FIELDS) expect(names.has(field)).toBe(false);
      expect(keyNames(graph.steps).has("src")).toBe(false);
      expect(keyNames(graph.steps).has("prop")).toBe(false);
    }
  });

  it("everything else of a step and a branch is kept, as the master writes it", () => {
    for (const flow of ["A", "B"] as const) {
      const graph = master[flow];
      const stripped = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(stripped);
        if (typeof value !== "object" || value === null) return value;
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
          if (!AUTHORING_FIELDS.includes(key)) out[key] = stripped(item);
        }
        return out;
      };
      const expected = stripped(readRaw(flow).steps) as Record<string, unknown>[];
      // The loaded path is the master's steps minus src and prop, plus the derived `section` on every step.
      const withoutSection = (list: Step[]): unknown[] =>
        list.map((step) => {
          const copy: Record<string, unknown> = { ...step };
          delete copy.section;
          if (step.branches !== undefined) {
            copy.branches = step.branches.map((branch) => ({
              ...branch,
              steps: withoutSection(branch.steps),
            }));
          }
          return copy;
        });
      expect(withoutSection(graph.path)).toEqual(expected);
    }
  });
});

describe("R1: san is Rosie, agent is the customer's own AI", () => {
  it("maps the two lanes", () => {
    expect(laneMeaning("san")).toBe("Rosie");
    expect(laneMeaning("agent")).toBe("the customer's own AI assistant");
    expect(LANE_MEANING.agent).toContain("customer's own AI");
  });

  it("names all eight lanes, as the flow files list them", () => {
    expect(Object.keys(LANE_MEANING)).toEqual([...LANES]);
    expect(master.A.lanes).toEqual([...LANES]);
    expect(master.B.lanes).toEqual([...LANES]);
  });

  it("every lane a step or message uses is one of the eight, and Rosie and the customer's AI both act", () => {
    const used = new Set<string>();
    for (const graph of [master.A, master.B]) {
      for (const step of Object.values(graph.steps)) {
        used.add(step.who);
        if (step.to) used.add(step.to);
        for (const lane of step.tells ?? []) used.add(lane);
        for (const [from, to] of step.say ?? []) {
          used.add(from);
          used.add(to);
        }
      }
    }
    for (const lane of used) expect(LANES as readonly string[]).toContain(lane);
    expect(used.has("san")).toBe(true);
    expect(used.has("agent")).toBe(true);
  });
});

describe("parseFlow refuses a master it does not understand", () => {
  const fresh = (): Record<string, unknown> => structuredClone(readRaw("A"));
  const firstStep = (raw: Record<string, unknown>): Record<string, unknown> =>
    (raw.steps as Record<string, unknown>[])[0] ?? {};

  it("accepts an untouched copy", () => {
    expect(flowCounts(parseFlow(fresh(), "A")).steps).toBe(478);
  });

  it("names the path of an unknown step field", () => {
    const raw = fresh();
    firstStep(raw).extra = 1;
    expect(() => parseFlow(raw, "A")).toThrow(MasterLoadError);
    expect(() => parseFlow(raw, "A")).toThrow(/master-A\.json\.steps\[0\]\.extra: unknown step field/);
  });

  it("refuses a lane that is not one of the eight", () => {
    const raw = fresh();
    firstStep(raw).who = "rosie";
    expect(() => parseFlow(raw, "A")).toThrow(/S1-01\)\.who: "rosie" is not one of the eight lanes/);
  });

  it("refuses a file that is the other flow", () => {
    expect(() => parseFlow(fresh(), "B")).toThrow(/master-B\.json\.id: expected "B"/);
  });

  it("refuses a step id used twice", () => {
    const raw = fresh();
    const steps = raw.steps as Record<string, unknown>[];
    steps.push(structuredClone(steps[0] ?? {}));
    expect(() => parseFlow(raw, "A")).toThrow(/the id is used twice in the flow/);
  });

  it("refuses a split without branches and branches on a plain step", () => {
    const split = fresh();
    const second = (split.steps as Record<string, unknown>[])[1] ?? {};
    delete second.branches;
    expect(() => parseFlow(split, "A")).toThrow(/a split without branches/);
    const plain = fresh();
    firstStep(plain).branches = [];
    expect(() => parseFlow(plain, "A")).toThrow(/branches on a step that is not a split/);
  });

  it("refuses a step of the other flow and a section that disagrees with the id", () => {
    const other = fresh();
    firstStep(other).id = "B1-01";
    expect(() => parseFlow(other, "A")).toThrow(/a step of the other flow/);
    const wrongSection = fresh();
    firstStep(wrongSection).sec = 2;
    expect(() => parseFlow(wrongSection, "A")).toThrow(/disagrees with the id's section 1/);
  });

  it("refuses text that is not JSON on disk", () => {
    expect(() => loadFlow("A", path.join(MASTER_DIR, "missing"))).toThrow(/cannot read it as JSON/);
  });
});

describe("the CLI runs the command files of src/cli/commands/", () => {
  const roots: string[] = [];
  const makeDir = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), "rosie-cli-"));
    roots.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  });
  const capture = (): { io: CliIo; out: string[]; err: string[] } => {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
  };
  const commandSource = (name: string, summary: string, code: number): string =>
    `export const command = { name: ${JSON.stringify(name)}, summary: ${JSON.stringify(summary)}, run(args, io) { io.out(args.join("+")); return ${String(code)}; } };\n`;

  it("the repository's own folder loads whatever commands it holds, and help lists them", async () => {
    expect(commandFiles().map((file) => path.basename(file))).not.toContain(".gitkeep");
    const commands = await loadCommands();
    const { io, out } = capture();
    expect(await main([], io)).toBe(0);
    expect(out[0]).toContain("usage:");
    for (const name of commands.keys()) expect(out.join("\n")).toContain(name);
  });

  it("a command file joins by being added, with no edit to the CLI", async () => {
    const dir = makeDir();
    writeFileSync(path.join(dir, "alpha.mjs"), commandSource("alpha", "Does alpha", 0));
    writeFileSync(path.join(dir, "beta.mjs"), commandSource("beta", "Does beta", 3));
    writeFileSync(path.join(dir, "_helper.mjs"), "export const notACommand = true;\n");
    writeFileSync(path.join(dir, "alpha.test.ts"), "throw new Error('a test is not a command');\n");
    writeFileSync(path.join(dir, ".gitkeep"), "");
    expect(commandFiles(dir).map((file) => path.basename(file))).toEqual(["alpha.mjs", "beta.mjs"]);

    const listed = capture();
    expect(await main(["help"], listed.io, dir)).toBe(0);
    expect(listed.out.join("\n")).toMatch(/alpha {2}Does alpha\n {2}beta {3}Does beta/);

    const ran = capture();
    expect(await main(["beta", "x", "y"], ran.io, dir)).toBe(3);
    expect(ran.out).toEqual(["x+y"]);
  });

  it("runs a TypeScript command file", async () => {
    const dir = makeDir();
    writeFileSync(
      path.join(dir, "typed.ts"),
      'import type { Command } from "../index.ts";\nexport const command: Command = { name: "typed", summary: "Typed", run(args: string[]) { return args.length; } };\n',
    );
    expect(await main(["typed", "a", "b"], capture().io, dir)).toBe(2);
  });

  it("an unknown command is exit 2, and a bad command file is exit 1 with the file named", async () => {
    const dir = makeDir();
    writeFileSync(path.join(dir, "alpha.mjs"), commandSource("alpha", "Does alpha", 0));
    const unknown = capture();
    expect(await main(["gamma"], unknown.io, dir)).toBe(2);
    expect(unknown.err).toEqual(['unknown command "gamma"']);

    const bad = makeDir();
    writeFileSync(path.join(bad, "broken.mjs"), "export const other = 1;\n");
    const broken = capture();
    expect(await main(["broken"], broken.io, bad)).toBe(1);
    expect(broken.err.join("\n")).toMatch(/broken\.mjs: expected an export named "command"/);
  });

  it("refuses two files that define one command name", async () => {
    const dir = makeDir();
    writeFileSync(path.join(dir, "one.mjs"), commandSource("same", "One", 0));
    writeFileSync(path.join(dir, "two.mjs"), commandSource("same", "Two", 0));
    const { io, err } = capture();
    expect(await main(["same"], io, dir)).toBe(1);
    expect(err.join("\n")).toMatch(/two\.mjs: the command "same" is already defined/);
  });
});
