// T-138: the corrections framework. Proofs of the card that belong to the layer, not to one correction:
//   - every change a correction makes carries its tag (`MC:C1`, `MC:C2`) in the diff output, and a change made any other
//     way is refused (UntaggedChangeError);
//   - the corrections run in id order, on a copy, and the applied flow they were given is left as it was;
//   - over all 243 trades x both flows (the last block), no compiled line says texts from one business stop or are off,
//     a mobile is asked for, "calls only" is not offered, and every changed line carries a tag.
//
// The last block applies each trade's overlay to both flows (the vendored apply(), about half a second each), so it
// takes minutes, not seconds. It is the card's "over all 243 trades x both flows" proof and is the part to move to the
// parity project (T-1067) if `npm test` must stay fast.
import { describe, expect, it, vi } from "vitest";
import { loadMaster } from "../load/flow";
import { listTradeIds, loadTrade } from "../load/trade";
import { applyTrade, type AppliedFlow, type AppliedStep, type AppliedTrade } from "../overlay/apply";
import {
  CORRECTIONS,
  CorrectionError,
  UntaggedChangeError,
  applyCorrections,
  pathText,
  renderDiff,
  tagOf,
  type Correction,
} from "./framework";

vi.setConfig({ testTimeout: 120_000 });

function demo(): AppliedTrade {
  const steps = [
    {
      id: "S1-01",
      kind: "rule",
      does: "Texts from Demo are off.",
      more: ["first", "second", "third"],
      say: [["san", "cust", "Hello", { buttons: ["One", "Two"] }]],
      branches: [
        { label: "Left", steps: [{ id: "S1-02", does: "inside a branch" }] },
        { label: "Right", steps: [] },
      ],
    },
  ];
  return { trade: "demo", flow: { id: "A", steps } as unknown as AppliedFlow, slotProblems: [] };
}

const edits: Correction = {
  id: "C1",
  title: "demo",
  source: "test",
  apply(ctx) {
    ctx.set("S1-01", ["does"], "Rosie's texts are off.");
    ctx.insert("S1-01", ["more"], 1, "inserted");
    ctx.remove("S1-01", ["more", 3]);
    ctx.set("S1-01", ["say", 0, 3, "buttons", 1], "Three");
    ctx.switchOff("S1-02", "why not");
    ctx.switchOffBranch("S1-01", "Right", "no longer offered");
  },
};

describe("the edit context", () => {
  it("records every edit with the tag the frame gives, and changes only a copy", () => {
    const applied = demo();
    const before = structuredClone(applied);
    const done = applyCorrections(applied, [edits]);

    expect(applied).toStrictEqual(before);
    expect(done.changes.map((change) => [change.tag, change.op, change.step, change.path])).toStrictEqual([
      ["MC:C1", "set", "S1-01", "does"],
      ["MC:C1", "insert", "S1-01", "more[1]"],
      ["MC:C1", "remove", "S1-01", "more[3]"],
      ["MC:C1", "set", "S1-01", "say[0][3].buttons[1]"],
      ["MC:C1", "set", "S1-02", "off"],
      ["MC:C1", "set", "S1-01", "branches[1].off"],
    ]);
    const step = done.flow.steps[0];
    expect(step?.more).toStrictEqual(["first", "inserted", "second"]);
    expect(step?.branches?.[0]?.steps[0]?.off).toBe("why not");
    expect(step?.branches?.[1]?.off).toBe("no longer offered");
    expect(done.corrections).toStrictEqual(["C1"]);
  });

  it("writes the diff with the tag on every line", () => {
    const done = applyCorrections(demo(), [edits]);
    const lines = renderDiff(done.changes);
    expect(lines).toStrictEqual([
      "MC:C1 - demo A S1-01 does: Texts from Demo are off.",
      "MC:C1 + demo A S1-01 does: Rosie's texts are off.",
      "MC:C1 + demo A S1-01 more[1]: inserted",
      "MC:C1 - demo A S1-01 more[3]: third",
      "MC:C1 - demo A S1-01 say[0][3].buttons[1]: Two",
      "MC:C1 + demo A S1-01 say[0][3].buttons[1]: Three",
      "MC:C1 + demo A S1-02 off: why not",
      "MC:C1 + demo A S1-01 branches[1].off: no longer offered",
    ]);
    expect(lines.every((line) => /^MC:C(?:[1-9]|10) [-+] /.test(line))).toBe(true);
  });

  it("refuses a change made without the context, through what step() returned", () => {
    const sneaky: Correction = {
      id: "C2",
      title: "sneaky",
      source: "test",
      apply(ctx) {
        (ctx.need("S1-01") as AppliedStep).does = "changed on the quiet";
      },
    };
    expect(() => applyCorrections(demo(), [sneaky])).toThrow(UntaggedChangeError);
  });

  it("refuses an edit of a step or a place that is not there", () => {
    const run = (apply: Correction["apply"]): unknown =>
      applyCorrections(demo(), [{ id: "C1", title: "x", source: "test", apply }]);
    expect(() => run((ctx) => ctx.need("S9-99"))).toThrow(CorrectionError);
    expect(() =>
      run((ctx) => {
        ctx.set("S1-01", ["more", 7], "x");
      }),
    ).toThrow(CorrectionError);
    expect(() =>
      run((ctx) => {
        ctx.set("S1-01", ["nothing", "here"], "x");
      }),
    ).toThrow(CorrectionError);
    expect(() =>
      run((ctx) => {
        ctx.remove("S1-01", ["more", 9]);
      }),
    ).toThrow(CorrectionError);
    expect(() =>
      run((ctx) => {
        ctx.remove("S1-01", ["rule"]);
      }),
    ).toThrow(CorrectionError);
    expect(() =>
      run((ctx) => {
        ctx.insert("S1-01", ["does"], 0, "x");
      }),
    ).toThrow(CorrectionError);
    expect(() =>
      run((ctx) => {
        ctx.insert("S1-01", ["more"], 9, "x");
      }),
    ).toThrow(CorrectionError);
    expect(() =>
      run((ctx) => {
        ctx.switchOffBranch("S1-01", "Middle", "x");
      }),
    ).toThrow(CorrectionError);
  });

  it("rewrites only the strings a rule changes, in the fields it is given", () => {
    const done = applyCorrections(demo(), [
      {
        id: "C1",
        title: "x",
        source: "test",
        apply(ctx) {
          expect(ctx.rewriteText("S1-01", (text) => text.toUpperCase(), ["more"])).toBe(3);
          expect(
            ctx.rewriteLines("S1-01", [
              ["Texts from Demo are off.", "exact"],
              [/^Hel(lo)$/, "pattern $1"],
            ]),
          ).toBe(2);
        },
      },
    ]);
    const step = done.flow.steps[0];
    expect(step?.more).toStrictEqual(["FIRST", "SECOND", "THIRD"]);
    expect(step?.does).toBe("exact");
    expect(JSON.stringify(step?.say)).toContain("pattern lo");
  });

  it("names a path as text", () => {
    expect(pathText(["more", 14])).toBe("more[14]");
    expect(pathText(["say", 1, 2])).toBe("say[1][2]");
    expect(pathText(["branches", 1, "off"])).toBe("branches[1].off");
  });

  it("refuses a flow where two steps have one id, so a change could not name it", () => {
    const applied = demo();
    (applied.flow.steps[0]?.branches?.[1] as { steps: unknown[] }).steps.push({ id: "S1-02" });
    expect(() => applyCorrections(applied, [])).toThrow(CorrectionError);
  });
});

describe("the list of corrections", () => {
  it("runs C1 and C2, in that order, and gives their ids the tag", () => {
    expect(CORRECTIONS.map((correction) => correction.id)).toStrictEqual(["C1", "C2"]);
    expect(tagOf("C2")).toBe("MC:C2");
    for (const correction of CORRECTIONS) {
      expect(correction.title.length).toBeGreaterThan(0);
      expect(correction.source).toContain(`Master Corrections ${correction.id}`);
    }
  });

  it("refuses a list out of order, with an id twice, or with an id Master Corrections does not have", () => {
    const make = (id: Correction["id"]): Correction => ({
      id,
      title: "x",
      source: "test",
      apply: () => undefined,
    });
    expect(() => applyCorrections(demo(), [make("C2"), make("C1")])).toThrow(CorrectionError);
    expect(() => applyCorrections(demo(), [make("C1"), make("C1")])).toThrow(CorrectionError);
    expect(() => applyCorrections(demo(), [make("C11")])).toThrow(CorrectionError);
    expect(() => applyCorrections(demo(), [make("C0")])).toThrow(CorrectionError);
    expect(applyCorrections(demo(), []).changes).toStrictEqual([]);
  });

  it("puts the changes of C1 before those of C2", () => {
    const applied = applyTrade(loadMaster().A, loadTrade("barber"));
    const done = applyCorrections(applied);
    const order = done.changes.map((change) => change.correction);
    expect(order).toContain("C1");
    expect(order).toContain("C2");
    expect(order.lastIndexOf("C1")).toBeLessThan(order.indexOf("C2"));
    expect(done.corrections).toStrictEqual(["C1", "C2"]);
  });
});

/** Every string anywhere in a flow: the words of every step, branch, variation and layer line. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out);
  else if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) allStrings(item, out);
  return out;
}

/** A text that says Rosie's texts from one business stop or are off, or that a business texts from its own number. */
const ONE_BUSINESS =
  /\btexts? from [^\n]{1,80}? (?:to this number )?(?:stop at once|are off|is off)\b|\btexts? from Rosie for\b|own Rosie number|texts? from its own number|text from ONE shared number/i;

function find(steps: AppliedStep[], id: string): AppliedStep | undefined {
  for (const step of steps) {
    if (step.id === id) return step;
    for (const branch of step.branches ?? []) {
      const hit = find(branch.steps, id);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

describe("all 243 trades x both flows", () => {
  const master = loadMaster();
  const ids = listTradeIds();

  it("has 243 trades", () => {
    expect(ids).toHaveLength(243);
  });

  for (const id of ids) {
    it(`${id}: no line says one business's texts stop; a mobile is asked for; calls only is not offered; every change is tagged`, () => {
      const trade = loadTrade(id);
      for (const flow of ["A", "B"] as const) {
        const applied = applyTrade(master[flow], trade);
        const done = applyCorrections(applied);
        const where = `${id} flow ${flow}`;

        // C1: nothing in the compiled flow says one business's texts stop or are off.
        const said = allStrings(done.flow.steps).filter((text) => ONE_BUSINESS.test(text));
        expect(said, `${where}: lines that name one business's texts`).toStrictEqual([]);

        // C2: the reach card, its branch and the three call steps.
        const card = find(done.flow.steps, flow === "A" ? "A4-82" : "B4-93");
        const asked = allStrings(card?.say).join(" ");
        expect(asked, `${where}: the reach card asks for a mobile`).toContain("mobile number");
        expect(asked, `${where}: the reach card no longer asks for 'number or email'`).not.toContain(
          "number or email",
        );
        expect(asked).not.toContain("Calls only");
        expect(card?.branches?.find((branch) => branch.label === "Calls only")?.off, where).toBeTypeOf(
          "string",
        );
        for (const call of [flow === "A" ? "A4-87" : "B4-109", "S13-33"])
          expect(find(done.flow.steps, call)?.off, `${where}: ${call} is off`).toBeTypeOf("string");

        // Tags: every change has one, the diff has it on every line, and the changes are all there is.
        for (const change of done.changes) expect(change.tag).toBe(tagOf(change.correction));
        const lines = renderDiff(done.changes);
        expect(lines.length).toBeGreaterThan(0);
        expect(
          lines.every((line) => /^MC:C[12] [-+] /.test(line)),
          where,
        ).toBe(true);
      }
    });
  }
});
