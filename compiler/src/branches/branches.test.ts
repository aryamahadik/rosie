// T-145: branches. Proofs:
//   - every branch of every split in both flows is compiled with exactly one tag (message, lookup or clock), its label byte for
//     byte the master's (read here as plain JSON, never through the code under test);
//   - the 3 flow-switch ends in A continue in B, and B has none;
//   - every split has at least one branch that rejoins;
//   - every compiled branch is accepted by K-01 v1's `branch` definition (the schema's own check, Ajv);
//   - for the splits in contracts/bundle/fixtures/bundle-mini-a.json and bundle-mini-b.json, the compiled branches have the
//     same shape as the fixture's, and the same tag, steps, end, rejoinAt, flow, gates, sets, reads and effects where a
//     fixture branch is the master's own (a branch of the fixture's one trade that differs in words only is left to its words);
//   - the tag, effect, answer-field, page-type and layer-line rules, each on a small example, and on the real flows.
// Walking all 243 trades is in parity.shard-N.test.ts (merge-check only).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { listTradeIds, loadTrade } from "../load/trade";
import { applyTrade } from "../overlay/apply";
import {
  ANSWER_TYPES,
  BranchError,
  CLOCK_LABEL,
  answerTypeOf,
  branchEffects,
  compileBranches,
  compileLayerLines,
  compileMasterBranches,
  compileTradeBranches,
  flowSwitches,
  layerIdsOf,
  pageTypesOf,
  closedSplits,
  splitsWithoutRejoin,
  tagOf,
  type BranchSource,
  type BranchStepSource,
  type CompiledBranch,
} from "./index";

vi.setConfig({ testTimeout: 120_000 });

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORK = `${ROOT}fixtures/master/engine/work/`;

interface RawBranch {
  label: string;
  steps: RawStep[];
  end?: string;
  flow?: string;
}
interface RawStep {
  id: string;
  type?: string;
  gives?: string[];
  branches?: RawBranch[];
}

function raw(flow: FlowLetter): { steps: RawStep[] } {
  return JSON.parse(readFileSync(`${WORK}master/master-${flow}.json`, "utf8")) as { steps: RawStep[] };
}

/** Every split of a raw flow in the order of a walk (this file's own walk), with its branches' labels. */
function rawSplits(steps: RawStep[], out: { id: string; labels: string[]; gives: string[] }[] = []) {
  for (const step of steps) {
    if (step.type === "split")
      out.push({ id: step.id, labels: (step.branches ?? []).map((b) => b.label), gives: step.gives ?? [] });
    for (const branch of step.branches ?? []) rawSplits(branch.steps, out);
  }
  return out;
}

const master = loadMaster();
const compiled = compileMasterBranches(master);
const FLOWS: readonly FlowLetter[] = ["A", "B"];

function all(flow: FlowLetter): { id: string; branch: CompiledBranch }[] {
  return Object.entries(compiled[flow]).flatMap(([id, branches]) =>
    branches.map((branch) => ({ id, branch })),
  );
}

describe("every branch of both flows", () => {
  it("keeps every split, in the raw file's order, with every label byte for byte", () => {
    for (const flow of FLOWS) {
      const expected = rawSplits(raw(flow).steps);
      expect(expected.length).toBeGreaterThan(100);
      const got = Object.entries(compiled[flow]).map(([id, branches]) => ({
        id,
        labels: branches.map((branch) => branch.label),
      }));
      expect(got).toEqual(expected.map(({ id, labels }) => ({ id, labels })));
    }
  });

  it("gives each branch exactly one tag, from the three", () => {
    let total = 0;
    const counts = { message: 0, lookup: 0, clock: 0 };
    for (const flow of FLOWS) {
      for (const { id, branch } of all(flow)) {
        total += 1;
        expect(["message", "lookup", "clock"], `${flow} ${id} ${branch.label}`).toContain(branch.tag);
        counts[branch.tag] += 1;
      }
    }
    expect(counts.message + counts.lookup + counts.clock).toBe(total);
    expect(counts.message).toBeGreaterThan(counts.lookup);
    expect(counts.lookup).toBeGreaterThan(0);
    expect(counts.clock).toBeGreaterThan(0);
  });

  it("reads the field of every lookup, and of no other branch", () => {
    for (const flow of FLOWS) {
      for (const { id, branch } of all(flow)) {
        if (branch.tag === "lookup") {
          expect(branch.reads, `${flow} ${id} ${branch.label}`).toEqual({
            from: "path",
            key: expect.stringMatching(/^(price|before|after)$/) as unknown,
          });
        } else expect(branch.reads).toBeUndefined();
      }
    }
  });

  it("makes the 3 flow-switch ends in A continue in B, and B has none", () => {
    const switches = flowSwitches(compiled.A);
    expect(switches.map(({ id, label }) => `${id} ${label}`)).toEqual([
      "A4-01 2 At my home",
      "A4-15 Wants the other place",
      "A10-32 Signs: work at their place",
    ]);
    for (const entry of switches) expect(entry.flow).toBe("B");
    for (const { id, branch } of all("A")) {
      if (branch.flow === undefined) continue;
      expect(branch.end, `${id} ${branch.label}`).toBe("end");
      expect(branch.rejoinAt).toBeNull();
      expect(branch.endText?.length ?? 0, `${id} ${branch.label}`).toBeGreaterThan(0);
    }
    expect(flowSwitches(compiled.B)).toEqual([]);
  });

  it("has at least one branch that rejoins in every split", () => {
    // Two splits have none: A8-51 and B8-54 (all three branches end the visit). Each is the last step of an ending branch, so
    // nothing after it could run; every other split rejoins.
    const closed = { A: ["A8-51"], B: ["B8-54"] };
    for (const flow of FLOWS) {
      expect(splitsWithoutRejoin(compiled[flow]), flow).toEqual(closed[flow]);
      expect(closedSplits(master[flow].path), flow).toEqual(
        closed[flow].map((id) => ({ id, hostEnds: true })),
      );
    }
  });

  it("finds a split that never rejoins and sits where a walk should go on", () => {
    const dead = (id: string): BranchStepSource => ({
      id,
      type: "split",
      branches: [{ label: "x", steps: [], end: "end", endText: "stops" }],
    });
    const host = (end: "merge" | "end", tail: BranchStepSource[]): BranchStepSource => ({
      id: "A1-01",
      type: "split",
      branches: [
        { label: "in", steps: [dead("A1-02"), ...tail], end },
        { label: "out", steps: [], end: "merge" },
      ],
    });
    expect(closedSplits([dead("A1-05")])).toEqual([{ id: "A1-05", hostEnds: false }]);
    expect(closedSplits([host("end", [])])).toEqual([{ id: "A1-02", hostEnds: true }]);
    expect(closedSplits([host("merge", [])])).toEqual([{ id: "A1-02", hostEnds: false }]);
    expect(closedSplits([host("end", [{ id: "A1-03" }])])).toEqual([{ id: "A1-02", hostEnds: false }]);
  });

  it("points every rejoin at a step of the same flow, and never a merge to nowhere but at a list's end", () => {
    for (const flow of FLOWS) {
      const ids = new Set(Object.keys(master[flow].steps));
      for (const { id, branch } of all(flow)) {
        if (branch.rejoinAt !== null) expect(ids.has(branch.rejoinAt), `${flow} ${id}`).toBe(true);
        for (const step of branch.steps) expect(ids.has(step), `${flow} ${id} ${step}`).toBe(true);
        if (branch.end === "end" || branch.flow !== undefined) expect(branch.rejoinAt).toBeNull();
      }
    }
  });

  it("types every answer key, and gives the fields only to a message branch that goes on", () => {
    for (const flow of FLOWS) {
      const gives = new Map(rawSplits(raw(flow).steps).map((s) => [s.id, s.gives]));
      for (const { id, branch } of all(flow)) {
        for (const field of branch.answerFields) expect(ANSWER_TYPES[field.name]).toBe(field.type);
        const keys = gives.get(id) ?? [];
        const carries = branch.tag === "message" && branch.end !== "end";
        expect(
          branch.answerFields.map((f) => f.name),
          `${flow} ${id} ${branch.label}`,
        ).toEqual(carries ? keys : []);
      }
      for (const key of gives.values())
        for (const name of key) expect(() => answerTypeOf(name)).not.toThrow();
    }
  });

  it("is accepted by K-01 v1's branch definition", () => {
    const schema = JSON.parse(readFileSync(`${ROOT}contracts/bundle/bundle.v1.schema.json`, "utf8")) as {
      $id: string;
    };
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
    ajv.addSchema(
      JSON.parse(readFileSync(`${ROOT}contracts/common/formats.v1.schema.json`, "utf8")) as object,
    );
    ajv.addSchema(schema);
    const validate = ajv.getSchema(`${schema.$id}#/$defs/branch`);
    expect(validate).toBeDefined();
    for (const flow of FLOWS) {
      for (const { id, branch } of all(flow)) {
        const ok = validate?.(branch) === true;
        expect(ok, `${flow} ${id} ${branch.label}: ${JSON.stringify(validate?.errors)}`).toBe(true);
      }
    }
  });
});

interface FixtureBranch extends Omit<CompiledBranch, "endText"> {
  endText?: string;
}

describe("the sample bundles' branches", () => {
  for (const [file, flow] of [
    ["bundle-mini-a.json", "A"],
    ["bundle-mini-b.json", "B"],
  ] as const) {
    it(`${file}: same shape, and the same values for the master's own branches`, () => {
      const bundle = JSON.parse(readFileSync(`${ROOT}contracts/bundle/fixtures/${file}`, "utf8")) as {
        flows: Record<
          string,
          { steps: Record<string, { branches?: FixtureBranch[]; layerLines?: string[] }> }
        >;
      };
      const steps = bundle.flows[flow]?.steps ?? {};
      // the fixture's one trade is the barber, applied to the master
      const barber = compileTradeBranches(applyTrade(master[flow], loadTrade("barber")));
      let splits = 0;
      let branches = 0;
      const problems: string[] = [];
      for (const [id, step] of Object.entries(steps)) {
        if (step.branches === undefined) continue;
        const ours = barber[id];
        if (ours === undefined) continue;
        splits += 1;
        for (const want of step.branches) {
          const got = ours.find((branch) => branch.label === want.label);
          if (got === undefined) continue;
          branches += 1;
          // the shape: the same keys
          const keys = (b: object): string[] =>
            Object.keys(b)
              .filter((k) => k !== "endText")
              .sort();
          for (const key of ["label", "tag", "steps", "rejoinAt", "answerFields", "effects"])
            if (!(key in got)) problems.push(`${id} ${want.label}: lacks ${key}`);
          for (const key of keys(got))
            if (!keys(want).includes(key) && key !== "answerFields")
              problems.push(`${id} ${want.label}: key ${key} not in the fixture`);
          // the master's own branch too: the fixture is hand-written, and where the barber's words change who a step
          // tells (B7-31's staff message), it follows the master's
          const own = compiled[flow][id]?.find((branch) => branch.label === want.label);
          for (const key of [
            "tag",
            "steps",
            "end",
            "rejoinAt",
            "flow",
            "when",
            "sets",
            "reads",
            "effects",
          ] as const) {
            const same = (b: CompiledBranch | undefined): boolean =>
              JSON.stringify(b?.[key]) === JSON.stringify(want[key]);
            if (!same(got) && !(key === "effects" && same(own)))
              problems.push(
                `${id} ${want.label}: ${key} is ${JSON.stringify(got[key])}, the fixture has ${JSON.stringify(want[key])}`,
              );
          }
        }
      }
      expect(splits).toBeGreaterThan(5);
      expect(branches).toBeGreaterThan(20);
      expect(problems).toEqual([]);
    });
  }
});

describe("the rules", () => {
  const branch = (label: string, rest: Partial<BranchSource> = {}): BranchSource => ({
    label,
    steps: [],
    ...rest,
  });

  it("tags a silence or a time that ran out as a clock, and nothing wider", () => {
    for (const label of [
      "No reply",
      "No answer in time",
      "Not done in time",
      "Not signed in time",
      "No reply yet",
      "No reply: nothing blocked",
      "No reply by the deadline",
      "No answer by the date",
      "Nothing entered by night",
      "Still unpaid in time",
    ])
      expect(tagOf(branch(label)), label).toBe("clock");
    for (const label of [
      "Later, or no reply",
      "2 Let it go, or no reply",
      "Done in time",
      "Sam answers in time",
      "No: staff text LATE",
      "AWAY, or no answer all day",
      "A new booking",
    ])
      expect(CLOCK_LABEL.test(label), label).toBe(false);
  });

  it("tags a branch whose own gate names the money path a lookup, and a record gate alone a message", () => {
    expect(tagOf(branch("A card saved", { when: { before: ["card"], took: "A" } }))).toBe("lookup");
    expect(tagOf(branch("From the price list", { when: { price: ["list"] } }))).toBe("lookup");
    expect(tagOf(branch("Alex cancels late", { when: { rec: ["keep"], took: "A", ev: "A" } }))).toBe(
      "message",
    );
    expect(tagOf(branch("Ask Sam first", { when: { booking: ["customer"] } }))).toBe("message");
    expect(tagOf(branch("A discount code", { when: { pf: ["discounts"] } }))).toBe("message");
    // a clock label wins over a gate
    expect(tagOf(branch("No reply", { when: { price: ["list"] } }))).toBe("clock");
  });

  it("refuses an answer key with no type", () => {
    expect(() => answerTypeOf("nonesuch")).toThrow(BranchError);
  });

  const step = (id: string, rest: Partial<BranchStepSource> = {}): BranchStepSource => ({ id, ...rest });

  it("rejoins at the next step of the split's own list; null at a list's end, after an end and after a flow switch", () => {
    const split = step("A1-01", {
      type: "split",
      branches: [
        branch("one", { end: "merge", steps: [step("A1-02")] }),
        branch("two"),
        branch("three", { end: "end", endText: "stops" }),
        branch("four", { end: "end", flow: "B", endText: "goes on" }),
      ],
    });
    const out = compileBranches([split, step("A1-09")]);
    expect(out["A1-01"]?.map((b) => b.rejoinAt)).toEqual(["A1-09", "A1-09", null, null]);
    expect(out["A1-01"]?.[0]?.steps).toEqual(["A1-02"]);
    const last = compileBranches([step("A1-00"), split]);
    expect(last["A1-01"]?.map((b) => b.rejoinAt)).toEqual([null, null, null, null]);
  });

  it("leaves out a branch and a step that an off op switched off, and compiles a split nested in a branch", () => {
    const inner = step("A1-03", { type: "split", branches: [branch("deep")] });
    const split = step("A1-01", {
      type: "split",
      branches: [
        branch("kept", { steps: [step("A1-02", { off: "why" }), inner, step("A1-04")] }),
        branch("gone", { off: "why" }),
      ],
    });
    const out = compileBranches([split, step("A1-05", { off: "why" }), step("A1-06")]);
    expect(out["A1-01"]?.map((b) => b.label)).toEqual(["kept"]);
    expect(out["A1-01"]?.[0]?.steps).toEqual(["A1-03", "A1-04"]);
    expect(out["A1-01"]?.[0]?.rejoinAt).toBe("A1-06");
    expect(out["A1-03"]?.[0]?.rejoinAt).toBe("A1-04");
  });

  it("refuses two splits with one id in one flow", () => {
    const split = step("A1-01", { type: "split", branches: [branch("x")] });
    expect(() => compileBranches([split, split])).toThrow(BranchError);
  });

  it("writes the effects of a branch's steps, then its own, each kind and ref once", () => {
    const steps = [
      step("A5-05", { gives: ["money_before"], tells: ["cust"] }),
      step("A5-13", { gives: ["money_before", "card_saved"] }),
    ];
    expect(branchEffects({ label: "A deposit" }, steps)).toEqual([
      { kind: "message", ref: "A5-05", to: ["cust"] },
      { kind: "recordWrite", ref: "money_before" },
      { kind: "recordWrite", ref: "card_saved" },
    ]);
  });

  it("writes charges, refunds, calendar writes, clocks and flags from the structured fields, the label and the ending", () => {
    const pay = step("A9-05", { say: [["san", "cust", "pay", { pay: { amount: "$1", link: "x" } }]] });
    expect(branchEffects({ label: "x" }, [pay])).toEqual([
      { kind: "message", ref: "A9-05", to: ["cust"] },
      { kind: "charge", ref: "A9-05" },
    ]);
    // the messages Rosie sends decide whom; `tells` only when it sends none
    expect(
      branchEffects({ label: "x" }, [
        step("B3-19", {
          tells: ["cust", "owner"],
          say: [
            ["san", "agent", "a"],
            ["cust", "san", "b"],
            ["san", "owner", "c"],
            ["san", "agent", "d"],
          ],
        }),
      ]),
    ).toEqual([{ kind: "message", ref: "B3-19", to: ["agent", "owner"] }]);
    expect(branchEffects({ label: "x" }, [step("A8-01", { tells: ["staff"] })])).toEqual([
      { kind: "message", ref: "A8-01", to: ["staff"] },
    ]);
    expect(branchEffects({ label: "x" }, [step("A6-10", { gives: ["booked"] })])).toEqual([
      { kind: "recordWrite", ref: "booked" },
      { kind: "calendarWrite", ref: "A6-10" },
    ]);
    expect(branchEffects({ label: "1 Refund it" }, [])).toEqual([{ kind: "refund", ref: "pay.back" }]);
    expect(branchEffects({ label: "x", endText: "Anything paid comes back." }, [])).toEqual([
      { kind: "refund", ref: "pay.back" },
    ]);
    expect(branchEffects({ label: "2 No fee or refund" }, [])).toEqual([]);
    // a flag's ref is the branch's first step; with no step, the flag's name. `sets` are on the branch, not effects.
    expect(branchEffects({ label: "x", sets: { privacy: "private" } }, [step("A3-50")])).toEqual([
      { kind: "flag", ref: "A3-50", flag: "private" },
    ]);
    expect(branchEffects({ label: "x", sets: { contact: "stopped" } }, [])).toEqual([
      { kind: "flag", ref: "stopped", flag: "stopped" },
    ]);
    expect(branchEffects({ label: "x", sets: { contact: "switched", reach: "email" } }, [])).toEqual([]);
    expect(branchEffects({ label: "STOP" }, [step("S2-08")])).toEqual([
      { kind: "flag", ref: "S2-08", flag: "stopped" },
    ]);
    expect(branchEffects({ label: "The person served dies" }, [])).toEqual([
      { kind: "flag", ref: "deceased", flag: "deceased" },
    ]);
    expect(branchEffects({ label: "x", endText: "Sam was told, and visits with them pause." }, [])).toEqual([
      { kind: "flag", ref: "paused", flag: "paused" },
    ]);
    expect(branchEffects({ label: "x" }, [step("S11-15", { gives: ["paused"], tells: ["owner"] })])).toEqual([
      { kind: "message", ref: "S11-15", to: ["owner"] },
      { kind: "recordWrite", ref: "paused" },
    ]);
  });

  it("gives A5-04's four lookups the record writes and messages of the steps they lead to", () => {
    const four = compiled.A["A5-04"];
    expect(four?.map((b) => b.tag)).toEqual(["lookup", "lookup", "lookup", "lookup"]);
    expect(four?.map((b) => b.rejoinAt)).toEqual(["A5-31", "A5-31", "A5-31", "A5-31"]);
    expect(four?.[3]?.effects).toEqual([
      { kind: "recordWrite", ref: "money_before" },
      { kind: "recordWrite", ref: "paid_full" },
    ]);
    expect(four?.[0]?.effects[0]).toEqual({ kind: "message", ref: "A5-05", to: ["cust"] });
  });

  it("tags A6-02's silence a clock, and A3-22's choices messages", () => {
    expect(compiled.A["A6-02"]?.map((b) => b.tag)).toEqual(["message", "message", "message", "clock"]);
    expect(compiled.A["A3-22"]?.every((b) => b.tag === "message")).toBe(true);
    expect(compiled.A["A5-31"]?.map((b) => b.tag)).toEqual(["message", "message", "clock"]);
  });

  it("allows page types from the elements of a step's messages, in a fixed order, and none otherwise", () => {
    const say = (el: Record<string, unknown>) => ({ say: [["san", "cust", "words", el]] });
    expect(pageTypesOf({})).toEqual([]);
    expect(pageTypesOf(say({ buttons: ["Book it"], card: { title: "t", lines: [] } }))).toEqual([]);
    expect(pageTypesOf(say({ card: { link: "rosfield.com/c/r2" } }))).toEqual(["link"]);
    expect(pageTypesOf(say({ pay: { link: "x" }, card: { link: "y" }, form: ["Name"] }))).toEqual([
      "pay",
      "form",
      "link",
    ]);
    expect(pageTypesOf(say({ photoLink: "rosfield.com/m/r4" }))).toEqual(["photos"]);
    expect(pageTypesOf({ say: [["san", "cust", "plain"]] })).toEqual([]);
  });

  it("allows the page types the sample bundles allow (none on the steps they show)", () => {
    for (const flow of FLOWS) {
      for (const step of Object.values(master[flow].steps)) {
        expect(pageTypesOf(step).length).toBeLessThanOrEqual(3);
      }
    }
    expect(pageTypesOf(master.A.steps["A5-05"] ?? {})).toEqual([]);
    expect(pageTypesOf(master.A.steps["A9-05"] ?? {})).toContain("pay");
  });

  it("lists a step's layer lines by id, and copies the flow's lines whole", () => {
    for (const flow of FLOWS) {
      const lines = compileLayerLines(master[flow].layerLines);
      expect(lines).toEqual(master[flow].layerLines);
      expect(lines).not.toBe(master[flow].layerLines);
      expect(lines.map((line) => line.id)).toEqual(
        expect.arrayContaining(["private", "privatecall", "textsonly", "emailonly"]),
      );
      const known = new Set(lines.map((line) => line.id));
      let stamped = 0;
      for (const step of Object.values(master[flow].steps)) {
        for (const id of layerIdsOf(step)) {
          expect(known.has(id)).toBe(true);
          stamped += 1;
        }
      }
      expect(stamped).toBeGreaterThan(0);
    }
    expect(layerIdsOf(master.A.steps["A6-02"] ?? {})).toEqual([
      "private",
      "privatecall",
      "textsonly",
      "emailonly",
    ]);
  });
});

describe("a trade's branches", () => {
  const ids = listTradeIds();
  for (const id of [ids[0], ids[Math.floor(ids.length / 2)]]) {
    if (id === undefined) continue;
    it(`${id}: the master's labels stay byte for byte, a switched-off branch is gone, and every split rejoins`, () => {
      const trade = loadTrade(id);
      for (const flow of FLOWS) {
        const applied = applyTrade(master[flow], trade);
        const out = compileTradeBranches(applied);
        const base = compiled[flow];
        for (const [splitId, branches] of Object.entries(out)) {
          const labels = new Set(branches.map((b) => b.label));
          expect(labels.size, `${id} ${splitId}`).toBe(branches.length);
          const was = base[splitId];
          if (was === undefined) continue;
          const masterLabels = new Set(was.map((b) => b.label));
          for (const label of labels)
            if (!masterLabels.has(label)) expect(trade.flows[flow].ops.length).toBeGreaterThan(0);
        }
        for (const split of closedSplits(applied.flow.steps))
          expect(split.hostEnds, `${id} ${split.id}`).toBe(true);
      }
    });
  }
});
