// The home registry (T-586; S13-30), on both flow graphs of fixture set v1 as the merged bundle emitter compiles them
// (T-149, with T-137's record and T-144's cards): every home in both flows' record.homes resolves to exactly one module;
// an unknown home fails the build; a step whose words contradict its home (A7-11 following S13-55) gets the home's
// rule and a logged difference; a step that follows a home not built yet is held, never run on its own words.

import { beforeAll, describe, expect, it } from "vitest";
import { isLabel } from "../../../../runtime/src/trace";
import {
  HOME_MODULES,
  HOME_NAMES,
  HomeRegistryError,
  createHomeRegistry,
  isHomeName,
  type HomeLogLine,
  type HomeModule,
  type HomeRegistryOptions,
} from "./index";
import {
  A7_11_CLAIMS,
  A7_11_CONTRADICTING,
  A7_11_OWN_WORDS,
  CARD_HOMES,
  S13_19_REPLY_CLOCK,
  S13_55_SILENCE,
  contactStandIn,
  contradictingA711,
  emittedFlows,
  moneyStandIn,
  objAt,
  type EmittedFlows,
  type HomeContext,
} from "./test-support";

const FLOWS = ["A", "B"] as const;

let flows: EmittedFlows;

beforeAll(async () => {
  flows = await emittedFlows();
});

/** A registry on the emitted flows (or others given), its log lines kept. */
function registryOn(options: Partial<HomeRegistryOptions<HomeContext>> = {}): {
  lines: HomeLogLine[];
  registry: ReturnType<typeof createHomeRegistry<HomeContext>>;
} {
  const lines: HomeLogLine[] = [];
  const registry = createHomeRegistry<HomeContext>({
    flows,
    log: (line) => {
      lines.push(line);
    },
    ...options,
  });
  return { lines, registry };
}

/** The build's problems for these options, or [] when it builds. */
function buildProblems(options: HomeRegistryOptions<HomeContext>): readonly string[] {
  try {
    createHomeRegistry(options);
    return [];
  } catch (error) {
    if (error instanceof HomeRegistryError) return error.problems;
    throw error;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

describe("every home in both flows' record.homes resolves to exactly one module", () => {
  it("both flows compile the ten homes of K-01 v1, the same in record.homes and routing.homes", () => {
    for (const flow of FLOWS) {
      expect(objAt(flows[flow], ["record", "homes"]), flow).toEqual(CARD_HOMES);
      expect(objAt(flows[flow], ["routing", "homes"]), flow).toEqual(CARD_HOMES);
    }
  });

  it("each home names its step and its one module; the clock home goes to the runtime's due rule", () => {
    const { registry } = registryOn();
    for (const flow of FLOWS) {
      const homes = objAt(flows[flow], ["record", "homes"]);
      const modules = new Set<string>();
      for (const [name, step] of Object.entries(homes)) {
        if (!isHomeName(name)) throw new Error(`${name} is not a home`);
        const entry = registry.entry(name);
        expect(entry).toEqual({ home: name, step, ...HOME_MODULES[name], built: false });
        modules.add(entry.module);
      }
      expect(modules.size, flow).toBe(10);
    }
    expect(registry.entry("clock")).toMatchObject({
      layer: "runtime",
      module: "runtime/src/clocks/home",
      via: "dueRule",
      step: "S13-35",
    });
    for (const name of HOME_NAMES.filter((home) => home !== "clock"))
      expect(registry.entry(name)).toMatchObject({
        layer: "actions",
        module: `actions/src/homes/${name}`,
        via: "homeModule",
      });
  });

  it("a built module is that home's one module, and a second module for the same home fails the build", () => {
    const { registry } = registryOn({ modules: [moneyStandIn()] });
    expect(registry.entry("money")).toMatchObject({ built: true, module: "actions/src/homes/money" });
    expect(registry.entry("contact").built).toBe(false);
    expect(buildProblems({ flows, modules: [moneyStandIn(), moneyStandIn()] })).toEqual([
      "two modules are given for the money home: each home has exactly one",
    ]);
  });

  it("every step's follows list resolves to its homes; A7-11 follows money and contact", () => {
    const { registry } = registryOn();
    let following = 0;
    for (const flow of FLOWS)
      for (const [id, step] of Object.entries(objAt(flows[flow], ["steps"]))) {
        const reads = stringList(objAt(step, []).reads);
        expect(registry.follows(flow, id), `${flow} ${id}`).toEqual(
          HOME_NAMES.filter((name) => reads.includes(name)),
        );
        if (reads.length > 0) following += 1;
      }
    expect(following).toBeGreaterThan(0);
    expect(registry.follows("A", "A7-11")).toEqual(["money", "contact"]);
  });

  it("each named record slot resolves to the home its row names", () => {
    const { registry } = registryOn();
    for (const flow of FLOWS) {
      const homes = objAt(flows[flow], ["record", "homes"]);
      for (const [slot, raw] of Object.entries(objAt(flows[flow], ["record", "slots"]))) {
        const home = registry.homeOfSlot(flow, slot);
        expect(home, `${flow} ${slot}`).toBeDefined();
        if (home !== undefined) expect(homes[home]).toBe(objAt(raw, []).home);
      }
    }
    expect(registry.homeOfSlot("A", "pay.asks")).toBe("money");
    expect(registry.homeOfSlot("A", "clock.pay")).toBe("clock");
    expect(registry.homeOfSlot("B", "two.count")).toBe("two");
    expect(registry.homeOfSlot("B", "reach.way")).toBe("contact");
    expect(registry.homeOfSlot("A", "who.ok")).toBe("who");
    expect(registry.homeOfSlot("A", "pay.hold")).toBeUndefined();
  });
});

describe("an unknown home fails the build", () => {
  it("a step that follows a name that is not one of the ten homes", () => {
    const A = structuredClone(flows.A);
    const step = objAt(A, ["steps", "A7-11"]);
    step.reads = [...stringList(step.reads), "weather"];
    expect(buildProblems({ flows: { A, B: flows.B } })).toEqual([
      'flow A step A7-11 follows "weather", which is not one of the ten homes',
    ]);
    expect(() => createHomeRegistry({ flows: { A, B: flows.B } })).toThrow(HomeRegistryError);
  });

  it("a record.homes or routing.homes with an eleventh home, or with one of the ten missing", () => {
    const A = structuredClone(flows.A);
    objAt(A, ["record", "homes"]).tips = "S13-55";
    expect(buildProblems({ flows: { A, B: flows.B } })).toEqual([
      'flow A record.homes names "tips", which is not one of the ten homes',
    ]);
    const B = structuredClone(flows.B);
    const { two, ...nine } = objAt(B, ["routing", "homes"]);
    expect(two).toBe("A9-21");
    objAt(B, ["routing"]).homes = nine;
    expect(buildProblems({ flows: { A: flows.A, B } })).toEqual([
      "flow B routing.homes has no home two: every flow names all ten",
    ]);
  });

  it("a module for a name that is not a home, or one point settled by two homes", () => {
    const tips = { home: "tips", points: ["tip"], rule: () => "none" } as unknown as HomeModule<HomeContext>;
    expect(buildProblems({ flows, modules: [tips] })).toEqual([
      'a module is given for "tips", which is not one of the ten homes',
    ]);
    const twice: HomeModule<HomeContext> = { home: "two", points: ["chargeOnSilence"], rule: () => "none" };
    expect(buildProblems({ flows, modules: [moneyStandIn(), twice] })).toEqual([
      "the point chargeOnSilence is settled by both the money and the two home: each fact has one home",
    ]);
  });

  it("a home with two steps, routing and record disagreeing, or a slot whose home is no home's step", () => {
    const B = structuredClone(flows.B);
    objAt(B, ["record", "homes"]).money = "S13-17";
    objAt(B, ["routing", "homes"]).money = "S13-17";
    // The money slots move with their home, so flow B on its own stays whole: only the two flows disagree.
    for (const slot of Object.values(objAt(B, ["record", "slots"]))) {
      const row = objAt(slot, []);
      if (row.home === "S13-55") row.home = "S13-17";
    }
    expect(buildProblems({ flows: { A: flows.A, B } })).toEqual([
      "the money home has two steps, S13-55 in flow A and S13-17 in flow B",
    ]);
    const A = structuredClone(flows.A);
    objAt(A, ["routing", "homes"]).stop = "S13-33";
    objAt(A, ["record", "slots", "pay.asks"]).home = "S13-17";
    expect(buildProblems({ flows: { A, B: flows.B } })).toEqual([
      "flow A routing.homes.stop is S13-33, but record.homes.stop is not",
      "flow A record slot pay.asks: its home is not the step of one of the ten homes",
    ]);
  });
});

describe("a step whose words contradict its home gets the home's rule and a logged difference (A7-11, S13-55)", () => {
  it("the fixture: A7-11 as compiled, following S13-55, its own fee words turned against S13-55's line", () => {
    const steps = objAt(flows.A, ["steps"]);
    expect(stringList(objAt(steps, ["A7-11"]).reads)).toEqual(["money", "contact"]);
    expect(stringList(objAt(steps, ["S13-55"]).more)).toContain(S13_55_SILENCE);
    expect(stringList(objAt(steps, ["S13-19"]).more)).toContain(S13_19_REPLY_CLOCK);
    const words = JSON.stringify(objAt(flows.A, ["steps", "A7-11"]).say);
    expect(words).toContain(A7_11_OWN_WORDS);
    const turned = JSON.stringify(objAt(contradictingA711(flows.A), ["steps", "A7-11"]).say);
    expect(turned).not.toContain(A7_11_OWN_WORDS);
    expect(turned).toContain(A7_11_CONTRADICTING);
  });

  it("the money home's rule wins, and the difference is logged with labels and ids only, never words", () => {
    const { lines, registry } = registryOn({
      flows: { A: contradictingA711(flows.A), B: flows.B },
      modules: [moneyStandIn(), contactStandIn()],
    });
    const settled = registry.settle({
      flow: "A",
      step: "A7-11",
      claims: A7_11_CLAIMS,
      context: { signedSchedule: false },
    });
    expect(settled).toEqual({
      run: true,
      flow: "A",
      step: "A7-11",
      rulings: { chargeOnSilence: "none", replyClock: "onceReached" },
      differences: [
        {
          flow: "A",
          step: "A7-11",
          home: "money",
          homeStep: "S13-55",
          point: "chargeOnSilence",
          stepSaid: "charge",
          homeSaid: "none",
        },
      ],
      own: [],
    });
    expect(lines).toEqual([
      {
        level: "warn",
        msg: "home_wins",
        flow: "A",
        step: "A7-11",
        home: "money",
        home_step: "S13-55",
        point: "chargeOnSilence",
        step_said: "charge",
        home_said: "none",
      },
    ]);
    for (const value of Object.values(lines[0] ?? {})) expect(isLabel(value), String(value)).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(" ");
  });

  it("with a signed schedule the home's own value still wins over the step's charge", () => {
    const { lines, registry } = registryOn({ modules: [moneyStandIn(), contactStandIn()] });
    const settled = registry.settle({
      flow: "A",
      step: "A7-11",
      claims: A7_11_CLAIMS,
      context: { signedSchedule: true },
    });
    expect(settled.run && settled.rulings.chargeOnSilence).toBe("keepSignedShare");
    expect(lines.map((line) => line.home_said)).toEqual(["keepSignedShare"]);
  });

  it("words that agree with the home log nothing; a point the home does not settle stays the step's own", () => {
    const { lines, registry } = registryOn({ modules: [moneyStandIn(), contactStandIn()] });
    const settled = registry.settle({
      flow: "A",
      step: "A7-11",
      claims: [
        { home: "money", point: "chargeOnSilence", value: "none" },
        { home: "money", point: "tipWord", value: "never" },
      ],
      context: { signedSchedule: false },
    });
    expect(settled).toMatchObject({
      run: true,
      differences: [],
      own: [{ home: "money", point: "tipWord", value: "never" }],
    });
    expect(lines).toEqual([]);
  });

  it("refuses a claim in words, a point claimed twice and a home rule that answers in words", () => {
    const { registry } = registryOn({ modules: [moneyStandIn(), contactStandIn()] });
    const context = { signedSchedule: false };
    expect(() =>
      registry.settle({
        flow: "A",
        step: "A7-11",
        claims: [{ home: "money", point: "chargeOnSilence", value: "the fee is charged" }],
        context,
      }),
    ).toThrow(HomeRegistryError);
    expect(() =>
      registry.settle({ flow: "A", step: "A7-11", claims: [...A7_11_CLAIMS, ...A7_11_CLAIMS], context }),
    ).toThrow("A7-11 claims money/chargeOnSilence twice: one value per point");
    const wordy: HomeModule<HomeContext> = {
      home: "money",
      points: ["chargeOnSilence"],
      rule: () => "no fee",
    };
    const { registry: worded } = registryOn({ modules: [wordy, contactStandIn()] });
    expect(() => worded.settle({ flow: "A", step: "A7-11", claims: A7_11_CLAIMS, context })).toThrow(
      "the money home's rule for chargeOnSilence is not a label",
    );
  });
});

describe("an unbuilt home is no rule: a step that follows it is held, never run on its own words", () => {
  it("with no home built, A7-11 is held for money and contact, and each is logged by label", () => {
    const { lines, registry } = registryOn();
    const settled = registry.settle({
      flow: "A",
      step: "A7-11",
      claims: A7_11_CLAIMS,
      context: { signedSchedule: false },
    });
    expect(settled).toEqual({
      run: false,
      flow: "A",
      step: "A7-11",
      held: [
        { home: "money", homeStep: "S13-55", module: "actions/src/homes/money", task: "T-593" },
        { home: "contact", homeStep: "S13-19", module: "actions/src/homes/contact", task: "T-588" },
      ],
    });
    expect(lines.map((line) => [line.msg, line.home, line.task])).toEqual([
      ["home_not_built", "money", "T-593"],
      ["home_not_built", "contact", "T-588"],
    ]);
    expect(JSON.stringify(lines)).not.toContain(" ");
  });

  it("with money built and contact not, A7-11 is still held, for contact alone, and nothing is ruled", () => {
    const { registry } = registryOn({ modules: [moneyStandIn()] });
    const settled = registry.settle({
      flow: "A",
      step: "A7-11",
      claims: A7_11_CLAIMS,
      context: { signedSchedule: false },
    });
    expect(settled).toEqual({
      run: false,
      flow: "A",
      step: "A7-11",
      held: [{ home: "contact", homeStep: "S13-19", module: "actions/src/homes/contact", task: "T-588" }],
    });
  });

  it("a claim on a home the step does not follow goes to that home, and holds the step while it is unbuilt", () => {
    const { registry } = registryOn({ modules: [moneyStandIn(), contactStandIn()] });
    const settled = registry.settle({
      flow: "A",
      step: "A7-11",
      claims: [{ home: "proof", point: "proven", value: "yes" }],
      context: { signedSchedule: false },
    });
    expect(settled).toMatchObject({ run: false, held: [{ home: "proof", homeStep: "S13-45" }] });
  });

  it("a step that follows no home and claims nothing runs with no ruling; an unknown step is refused", () => {
    const { lines, registry } = registryOn();
    const free = Object.keys(objAt(flows.A, ["steps"])).find((id) => registry.follows("A", id).length === 0);
    expect(free).toBeDefined();
    if (free === undefined) return;
    expect(
      registry.settle({ flow: "A", step: free, claims: [], context: { signedSchedule: false } }),
    ).toEqual({ run: true, flow: "A", step: free, rulings: {}, differences: [], own: [] });
    expect(lines).toEqual([]);
    expect(() =>
      registry.settle({ flow: "B", step: "A7-11", claims: [], context: { signedSchedule: false } }),
    ).toThrow("A7-11 is not a step of flow B");
  });
});
