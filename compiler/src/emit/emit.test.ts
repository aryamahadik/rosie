// The bundle emitter (T-149): from fixture set v1's master flows and two trades (the barber shop, fixture set v1's
// demo shop, and insurance, the trade with no facts list), the bundle validates against K-01 v1 with Ajv, its files are
// the stored values its manifest lists, and two builds from the same inputs are byte for byte the same. The all-trades
// build runs only through the CLI (`npm run cli -w @rosie/compiler -- build --out <dir>`), never here (DL-099).
//
// The stand-in bundle id here is GIVEN_ID (ab repeated, build 7): a bundle id is T-150's, so the test passes one in,
// as the build command's --bundle-id does; the emitter's own stand-in (64 zeros, build 1) is checked in cli.test.ts.
//
// T-1116 (Q-30; DL-211): in barber's bundle, Rosie's first reply to a staff member (S2-06) and to the emergency contact
// (S1-78) carries the opt-out line once, with S13-01's word that the opener and the privacy link ride it, and no later
// reply to them carries it; and every message of the bundle carries the marker walkStops() gives it on barber's paths.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { S13_32_LINES } from "../corrections/c1";
import { FIRST_REPLY_LINES } from "../corrections/c9";
import { applyCorrections } from "../corrections/framework";
import { walkStops } from "../corrections/stops";
import { buildKeyMap } from "../keymap";
import { loadMaster } from "../load/flow";
import { loadTrade } from "../load/trade";
import { buildKeywords } from "../msgtext";
import { applyTrade, type AppliedStep } from "../overlay/apply";
import { tradePaths } from "../path";
import {
  buildBundle,
  byteLength,
  correctedFlow,
  markedRules,
  messageTuple,
  settingsFor,
  toScreenRows,
  treeSha256,
  type BuiltBundle,
} from "./index";

const GIVEN_ID = { hash: "ab".repeat(32), build: 7 };
const BUILT_AT = "2026-11-08T00:00:00Z";
const TRADES = ["barber", "insurance"];
const OPTIONS = { trades: TRADES, bundleId: GIVEN_ID, builtAt: BUILT_AT };

const ROOT = new URL("../../../", import.meta.url);
const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(path, ROOT), "utf8")) as Record<string, unknown>;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

type Obj = Record<string, unknown>;
interface Step {
  id: string;
  section: number;
  next: string | null;
  lint: string[];
  say?: { text: string }[];
  more?: string[];
  branches?: { label: string; steps: string[]; rejoinAt: string | null; tag: string }[];
  fallbackText?: string;
}
interface Flow {
  sections: { n: number; steps: string[] }[];
  steps: Record<string, Step>;
  routing: {
    hubs: Record<string, string>;
    doors: Record<string, string>;
    anytime: { rows: { handler: string | null }[] };
    alwaysOn: { steps: string[] };
    judgmentRules: unknown;
  };
}
interface Manifest {
  bundleId: { hash: string; build: number };
  builtAt: string;
  compiler: { version: string };
  inputs: { kind: string; path: string; sha256: string; trade?: string }[];
  prompts: Record<string, { version: string; sha256: string; text: string }>;
  models: unknown;
  policy: unknown;
  lint: {
    rules: { rule: string; failures: number }[];
    failures: { rule: string; flow: string; step: string; trade: string | null }[];
  };
  journeys: unknown[];
  storage: {
    manifestKey: string;
    values: { key: string; kind: string; flow?: string; trade?: string; bytes: number; sha256: string }[];
  };
  lists: Obj;
}

let built: BuiltBundle;
let again: BuiltBundle;
let manifest: Manifest;
let flows: Record<"A" | "B", Flow>;

// The emitter walks every path of each trade to place the opt-out line (T-1116): about 9 s for the first build of these
// two trades on a quiet build Mac (the second reuses the walks). The hook's own limit is a resource guard, as the
// project's 30 s is (T-1073), not part of any claim here.
beforeAll(async () => {
  built = await buildBundle(OPTIONS);
  again = await buildBundle(OPTIONS);
  manifest = built.bundle.manifest as unknown as Manifest;
  flows = built.bundle.flows as unknown as Record<"A" | "B", Flow>;
}, 120_000);

describe("the bundle validates against K-01 v1 with Ajv", () => {
  // The one validator (contracts file section 2 item 8): Ajv 8, its 2020-12 class, strict mode, as
  // contracts/scripts/lib.mjs sets it up; a second instance here, apart from the emitter's own.
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  ajv.addSchema(readJson("contracts/common/formats.v1.schema.json"));
  ajv.addSchema(readJson("contracts/bundle/bundle.v1.schema.json"));
  const ID = "https://rosie.invalid/contracts/bundle/bundle.v1.schema.json";
  const errorsOf = (value: unknown, def?: string): unknown[] => {
    const validate = ajv.getSchema(def === undefined ? ID : `${ID}#/$defs/${def}`);
    if (validate === undefined) throw new Error(`no ${def ?? "root"} in K-01 v1`);
    return validate(value) ? [] : (validate.errors ?? []);
  };

  it("as one document: the manifest, both flows and the trades", () => {
    expect(errorsOf(built.bundle)).toEqual([]);
  });

  it("each file against its own definition: manifest, flowGraph, tradeOverlay", () => {
    for (const file of built.files) {
      const value = JSON.parse(file.text) as unknown;
      const def =
        file.path === "manifest.json"
          ? "manifest"
          : file.path.startsWith("flow/")
            ? "flowGraph"
            : "tradeOverlay";
      expect(errorsOf(value, def), file.path).toEqual([]);
    }
  });
});

describe("the bundle directory is Q-34's layout: one manifest, one graph per flow, one overlay per trade", () => {
  it("holds one file per stored value, at its key's part", () => {
    expect(built.files.map((file) => file.path)).toEqual([
      "flow/A.json",
      "flow/B.json",
      "manifest.json",
      "trade/barber.json",
      "trade/insurance.json",
    ]);
  });

  it("each file is its value as stored: UTF-8 JSON with no spaces", () => {
    for (const file of built.files) expect(file.text).toBe(JSON.stringify(JSON.parse(file.text)));
  });

  it("the manifest's storage lists each value's key, size and sha256 under the bundle id it was given", () => {
    const prefix = `bundle/${GIVEN_ID.hash}/${String(GIVEN_ID.build)}/`;
    expect(manifest.bundleId).toEqual(GIVEN_ID);
    expect(manifest.storage.manifestKey).toBe(`${prefix}manifest`);
    const values = built.files.filter((file) => file.path !== "manifest.json");
    expect(manifest.storage.values).toEqual(
      values.map((file) => {
        const part = file.path.replace(/\.json$/, "");
        const [kind, name] = part.split("/") as ["flow" | "trade", string];
        return {
          key: `${prefix}${part}`,
          kind,
          ...(kind === "flow" ? { flow: name } : { trade: name }),
          bytes: byteLength(file.text),
          sha256: sha256(file.text),
        };
      }),
    );
  });
});

describe("two builds from the same inputs are byte-identical", () => {
  it("file for file, byte for byte", () => {
    expect(again.files.map((file) => file.path)).toEqual(built.files.map((file) => file.path));
    again.files.forEach((file, k) => {
      expect(file.text === built.files[k]?.text, file.path).toBe(true);
    });
  });

  it("the tree's sha256 is equal, and is the hash of the sorted `<sha256>  <path>` lines", () => {
    expect(treeSha256(again.files)).toBe(treeSha256(built.files));
    const lines = built.files.map((file) => `${sha256(file.text)}  ${file.path}\n`).join("");
    expect(treeSha256(built.files)).toBe(sha256(lines));
  });

  it("no clock time and no absolute path is in the output", () => {
    for (const file of built.files) expect(file.text).not.toContain(new URL(".", ROOT).pathname);
    expect(manifest.builtAt).toBe(BUILT_AT);
  });
});

describe("the manifest packs what it is given and names each stand-in", () => {
  it("the given bundle id and build time; the compiler's version", () => {
    expect(manifest.builtAt).toBe(BUILT_AT);
    expect(manifest.compiler).toEqual({
      version: (readJson("compiler/package.json") as { version: string }).version,
    });
  });

  it("the stand-ins taken are named, with who gives the real one", () => {
    expect(built.standIns.map((standIn) => standIn.what)).toEqual([
      "inputs",
      "prompts",
      "models and policy",
      "judgment rules",
      "lists.fixedLines",
      "lists.outOfScope",
    ]);
    for (const standIn of built.standIns) {
      expect(standIn.owner).not.toBe("");
      expect(standIn.from).not.toBe("");
    }
  });

  it("the inputs stand-in is fixtures/master/SHA256SUMS's lines for the files read", () => {
    const sums = new Map(
      readFileSync(new URL("fixtures/master/SHA256SUMS", ROOT), "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const [hash = "", path = ""] = line.split("  ");
          return [path, hash] as const;
        }),
    );
    expect(manifest.inputs.map((input) => input.path)).toEqual([
      "engine/design/LINES.md",
      "engine/work/build/lib.js",
      "engine/work/build/msgtext.js",
      "engine/work/build/overlay-core.js",
      "engine/work/master/master-A.json",
      "engine/work/master/master-B.json",
      "engine/work/prof/barber.json",
      "engine/work/prof/insurance.json",
    ]);
    for (const input of manifest.inputs) expect(input.sha256).toBe(sums.get(input.path));
  });

  it("each prompt with the sha256 of its text; the models and routing given", () => {
    const sample = readJson("contracts/bundle/fixtures/manifest.json") as unknown as Manifest;
    expect(manifest.prompts).toEqual(sample.prompts);
    for (const prompt of Object.values(manifest.prompts)) expect(prompt.sha256).toBe(sha256(prompt.text));
    expect(manifest.models).toEqual(sample.models);
    expect(manifest.policy).toEqual(sample.policy);
  });

  it("the shared lists: T-134's keywords and T-143's key map, collected from shared-list.ts", () => {
    expect(manifest.lists.keywords).toEqual(buildKeywords());
    expect(manifest.lists.keyMap).toEqual(buildKeyMap());
    expect(manifest.lists.fixedLines).toEqual(readJson("contracts/bundle/fixtures/fixed-lines.json"));
    expect(manifest.lists.outOfScope).toEqual(
      readJson("contracts/bundle/fixtures/out-of-scope-c9-first-texts.json"),
    );
    expect(built.listSources.keywords).toEqual([expect.stringMatching(/^emit\/shared-list\.ts: T-134/)]);
  });

  it("no journey is listed: the ship list is T-160's", () => {
    expect(manifest.journeys).toEqual([]);
  });

  it("both flows carry the given judgment rules", () => {
    const rules = readJson("contracts/bundle/fixtures/judgment-rules.json");
    expect(flows.A.routing.judgmentRules).toEqual(rules);
    expect(flows.B.routing.judgmentRules).toEqual(rules);
  });
});

describe("the lint marks the steps carry and the manifest's summary of them", () => {
  const marked = (): { flow: string; step: string; trade: string | null; rule: string }[] => {
    const out: { flow: string; step: string; trade: string | null; rule: string }[] = [];
    for (const flow of ["A", "B"] as const)
      for (const step of Object.values(flows[flow].steps))
        for (const rule of step.lint) out.push({ flow, step: step.id, trade: null, rule });
    for (const [trade, overlay] of Object.entries(built.bundle.trades)) {
      for (const flow of ["A", "B"] as const) {
        const ops = (overlay.flows as Record<string, { ops: { steps?: Step[] }[] }>)[flow]?.ops ?? [];
        for (const op of ops)
          for (const step of op.steps ?? [])
            for (const rule of step.lint) out.push({ flow, step: step.id, trade, rule });
      }
    }
    return out;
  };

  it("every mark is a failure of the summary, and every failure a mark", () => {
    const failures = manifest.lint.failures.map(({ rule, flow, step, trade }) => ({
      rule,
      flow,
      step,
      trade,
    }));
    const key = (entry: { flow: string; step: string; trade: string | null; rule: string }): string =>
      `${entry.trade ?? "-"} ${entry.flow} ${entry.step} ${entry.rule}`;
    expect(failures.map(key).sort()).toEqual(marked().map(key).sort());
  });

  it("each rule the marks cover is counted", () => {
    expect(manifest.lint.rules.map((entry) => entry.rule)).toEqual(markedRules());
    for (const entry of manifest.lint.rules)
      expect(entry.failures).toBe(
        manifest.lint.failures.filter((failure) => failure.rule === entry.rule).length,
      );
  });

  it("S1-37's 'Start' button fails guard-keyword-button in both flows (Q-14)", () => {
    expect(flows.A.steps["S1-37"]?.lint).toContain("guard-keyword-button");
    expect(flows.B.steps["S1-37"]?.lint).toContain("guard-keyword-button");
  });
});

describe("each flow graph is the master after the corrections and the slotting", () => {
  it("C1 holds in S13-32's lines (T-138)", () => {
    for (const flow of ["A", "B"] as const) {
      const more = flows[flow].steps["S13-32"]?.more ?? [];
      for (const [match, held] of S13_32_LINES) {
        if (typeof match !== "string") continue;
        expect(more).not.toContain(match);
        expect(more).toContain(held);
      }
    }
  });

  it("C2's switched-off steps are on no list: no section, branch or next leads to them", () => {
    for (const flow of ["A", "B"] as const) {
      const graph = flows[flow];
      const off = flow === "A" ? ["A4-87", "S13-33"] : ["B4-109", "S13-33"];
      const led = new Set<string>();
      for (const section of graph.sections) for (const id of section.steps) led.add(id);
      for (const step of Object.values(graph.steps)) {
        if (step.next !== null) led.add(step.next);
        for (const branch of step.branches ?? []) {
          for (const id of branch.steps) led.add(id);
          expect(branch.label).not.toBe("Calls only");
        }
      }
      for (const id of off) {
        expect(graph.steps[id], `${flow} ${id}`).toBeDefined();
        expect(led.has(id), `${flow} ${id}`).toBe(false);
      }
    }
  });

  it("no message line keeps the master's sample business names (C6, T-142)", () => {
    for (const flow of ["A", "B"] as const) {
      for (const step of Object.values(flows[flow].steps)) {
        for (const message of step.say ?? []) {
          expect(message.text, `${flow} ${step.id}`).not.toMatch(/Lee's Barbershop|Lee Home Services/);
        }
      }
    }
  });

  it("every step a list, a branch, a next or a routing table names is a step of the flow", () => {
    for (const flow of ["A", "B"] as const) {
      const graph = flows[flow];
      const named = new Set<string>();
      for (const section of graph.sections) for (const id of section.steps) named.add(id);
      for (const step of Object.values(graph.steps)) {
        if (step.next !== null) named.add(step.next);
        for (const branch of step.branches ?? []) {
          for (const id of branch.steps) named.add(id);
          if (branch.rejoinAt !== null) named.add(branch.rejoinAt);
        }
      }
      for (const id of [
        ...Object.values(graph.routing.hubs),
        ...Object.values(graph.routing.doors),
        ...graph.routing.alwaysOn.steps,
      ])
        named.add(id);
      for (const row of graph.routing.anytime.rows) if (row.handler !== null) named.add(row.handler);
      for (const id of named) expect(graph.steps[id], `${flow} ${id}`).toBeDefined();
    }
  });
});

describe("one compiled overlay per trade", () => {
  interface Op {
    op: string;
    at: string;
    first?: string;
    branch?: { label: string; tag: string; steps: string[]; rejoinAt: string | null };
    steps?: Step[];
  }
  const tradeFlow = (trade: string, flow: "A" | "B"): { settings: unknown; switches: unknown; ops: Op[] } =>
    (
      built.bundle.trades[trade]?.flows as Record<string, { settings: unknown; switches: unknown; ops: Op[] }>
    )[flow] ?? {
      settings: null,
      switches: null,
      ops: [],
    };

  it("the barber shop: who it is, its facts, its typed settings per flow", () => {
    const barber = built.bundle.trades.barber as Obj;
    expect(barber.trade).toEqual({ id: "barber", name: "Barber", style: "Chair", pattern: "chair" });
    expect(barber.facts).toEqual(["children", "documents", "extrawork", "groups", "photos"]);
    for (const flow of ["A", "B"] as const)
      expect(tradeFlow("barber", flow).settings).toEqual({ arrive: "setstart", cutoff: "24 hours before" });
  });

  it("the ops in the trade file's order, each of its kind at its step", () => {
    const loaded = loadTrade("barber");
    for (const flow of ["A", "B"] as const) {
      expect(tradeFlow("barber", flow).ops.map((op) => `${op.op} ${op.at}`)).toEqual(
        loaded.flows[flow].ops.map((op) => `${op.op} ${op.at}`),
      );
    }
  });

  it("the new branch on A7-02 is compiled, with its step A7-x01 placed between the master's", () => {
    const op = tradeFlow("barber", "A").ops.find(
      (candidate) => candidate.op === "branch" && candidate.at === "A7-02",
    );
    expect(op?.branch).toMatchObject({
      label: "Asks to add beard color",
      tag: "message",
      steps: ["A7-x01"],
      rejoinAt: "A8-01",
    });
    expect(op?.steps?.map((step) => step.id)).toEqual(["A7-x01"]);
    const step = op?.steps?.[0];
    expect(step).toMatchObject({ id: "A7-x01", section: 7, next: null });
    expect(step?.fallbackText).toMatch(/^Beard color needs a skin test/);
  });

  it("insurance lists no facts (C5's fill is T-139's), and its settings are typed for each flow", () => {
    const insurance = built.bundle.trades.insurance as Obj;
    expect(insurance.facts).toBeNull();
    for (const flow of ["A", "B"] as const) {
      const settings = tradeFlow("insurance", flow).settings as { arrive: unknown; cutoff: unknown };
      expect(
        ["window", "setstart"].includes(settings.arrive as string) || typeof settings.arrive === "object",
      ).toBe(true);
      expect(settings.cutoff === null || typeof settings.cutoff === "string").toBe(true);
    }
  });
});

describe("the values K-01 v1 writes otherwise than the sources", () => {
  it("settings: a value per flow ({ A, B }) is split; none starts at arrive window and an empty cutoff (MC C5)", () => {
    const perFlow = { arrive: { A: "setstart" as const, B: { window: 3 } }, cutoff: "24 hours before" };
    expect(settingsFor(perFlow, "A")).toEqual({ arrive: "setstart", cutoff: "24 hours before" });
    expect(settingsFor(perFlow, "B")).toEqual({ arrive: { window: 3 }, cutoff: "24 hours before" });
    expect(settingsFor({ arrive: { window: 2 } }, "B")).toEqual({ arrive: { window: 2 }, cutoff: null });
    expect(settingsFor({ cutoff: { A: "7am the day of" } }, "B")).toEqual({ arrive: "window", cutoff: null });
    expect(settingsFor(null, "A")).toEqual({ arrive: "window", cutoff: null });
  });

  it("a screen row written as its label alone is that label with an empty value (K-01 pair)", () => {
    expect(toScreenRows([["Card"], ["Name", "Alex"]], "test")).toEqual([
      ["Card", ""],
      ["Name", "Alex"],
    ]);
    expect(() => toScreenRows([["a", "b", "c"]], "test")).toThrow(/a form row is/);
    expect(() => toScreenRows("Card", "test")).toThrow(/a list of rows/);
  });

  it("timing: false (lib.js line 594) is a step with no timing stamp; a stamp is kept", () => {
    const master = loadMaster();
    const unstamped = Object.values(master.B.steps).filter((step) => step.timing === false);
    const stamped = Object.values(master.B.steps).filter((step) => step.timing === "B");
    expect(unstamped.length).toBeGreaterThan(0);
    expect(stamped.length).toBeGreaterThan(0);
    for (const step of unstamped) expect(flows.B.steps[step.id], step.id).not.toHaveProperty("timing");
    for (const step of stamped) expect(flows.B.steps[step.id], step.id).toHaveProperty("timing", "B");
  });

  it("a message a trade writes with no words, [from, to, elements], has the words '' and its elements fourth", () => {
    const photos = { photos: ["Price board"] };
    expect(messageTuple(["owner", "san", photos], "test")).toEqual(["owner", "san", "", photos]);
    expect(messageTuple(["san", "owner", "Hi", photos], "test")).toEqual(["san", "owner", "Hi", photos]);
    expect(messageTuple(["san", "owner", "Hi"], "test")).toEqual(["san", "owner", "Hi"]);
    expect(() => messageTuple(["san", "owner"], "test")).toThrow(/a message is/);
  });

  it("a flow B step the master types `step` is a plain step, with no type", () => {
    const master = loadMaster();
    const typed = Object.values(master.B.steps).filter((step) => step.type === "step");
    expect(typed.length).toBeGreaterThan(0);
    for (const step of typed) expect(flows.B.steps[step.id], step.id).not.toHaveProperty("type");
  });
});

// ---- T-1116: the opt-out line as corrections/stops.ts walkStops() places it, in the emitted bundle ----

/** A message as the bundle writes it (K-01 message). */
interface Said {
  from: string;
  to: string;
  text: string;
  elements?: { as?: unknown; stop?: unknown };
  plainText: string;
}
interface MarkedStep {
  say?: Said[];
  vary?: Record<string, { say?: Said[]; addSay?: Said[] }>;
}

const FIXED = readJson("contracts/bundle/fixtures/fixed-lines.json") as {
  lines: { id: string; text: string | null; use: string }[];
};
const OPT_OUT = FIXED.lines.find((line) => line.id === "optOutLine")?.text ?? "";

type Line = readonly unknown[];

/** The name a message gives its person (`as`), or undefined. */
function nameOf(message: Line): string | undefined {
  const elements = message[3];
  const as =
    typeof elements === "object" && elements !== null ? (elements as { as?: unknown }).as : undefined;
  return typeof as === "string" && as !== "" ? as : undefined;
}

/** How many times `part` is in `text`. */
function times(text: string, part: string): number {
  return text.split(part).length - 1;
}

/** Every step of an applied flow, branch steps too, by id. */
function stepsById(
  steps: readonly AppliedStep[],
  out = new Map<string, AppliedStep>(),
): Map<string, AppliedStep> {
  for (const step of steps) {
    out.set(step.id, step);
    for (const branch of step.branches ?? []) stepsById(branch.steps, out);
  }
  return out;
}

describe("barber's bundle: Rosie's first reply to staff (S2-06) and to the emergency contact (S1-78) carries the opt-out line and the privacy link once (T-1116; Q-30)", () => {
  let barber: BuiltBundle;
  beforeAll(async () => {
    barber = await buildBundle({ trades: ["barber"], bundleId: GIVEN_ID, builtAt: BUILT_AT });
  }, 120_000);

  const graphOf = (flow: FlowLetter): Record<string, MarkedStep> =>
    (barber.bundle.flows[flow] as { steps: Record<string, MarkedStep> }).steps;

  // Who each message goes to is read from the words the emitter compiles, before their sample names are slotted (the
  // bundle writes every staff member's `as` as {{pro.name}}): the person's own text opens their chat, and Rosie's next
  // text to the same lane and name is her first reply in it. The bundle holds the same messages at the same places.
  it.each([
    ["A", "S2-06", "staff"],
    ["B", "S2-06", "staff"],
    ["A", "S1-78", "other"],
    ["B", "S1-78", "other"],
  ] as const)(
    "flow %s %s: the %s's first reply has the line once; no other text to them in the step has it",
    (flow, id, lane) => {
      const words = stepsById(correctedFlow(loadMaster(), flow).flow.steps).get(id)?.say ?? [];
      const opened = words.findIndex((message) => message[0] === lane && message[1] === "san");
      expect(opened, `${flow} ${id}: the ${lane}'s own text opens their chat`).toBeGreaterThanOrEqual(0);
      const person = nameOf(words[opened] ?? []);
      expect(person, `${flow} ${id}: the person is named`).toBeTypeOf("string");
      const reply = words.findIndex(
        (message, k) =>
          k > opened && message[0] === "san" && message[1] === lane && nameOf(message) === person,
      );
      expect(reply, `${flow} ${id}: Rosie's first reply to ${String(person)}`).toBeGreaterThan(opened);

      const said = graphOf(flow)[id]?.say ?? [];
      expect(said).toHaveLength(words.length);
      const first = said[reply];
      expect(first?.elements?.stop, `${flow} ${id}: the line on the first reply, on every walk`).toBe(true);
      expect(times(first?.plainText ?? "", OPT_OUT), `${flow} ${id}: the opt-out line, once`).toBe(1);
      said.forEach((message, k) => {
        if (k === reply) return;
        expect(message.elements?.stop, `${flow} ${id} say[${String(k)}]`).toBeUndefined();
        expect(times(message.plainText, OPT_OUT), `${flow} ${id} say[${String(k)}]`).toBe(0);
      });
      // The opener and the privacy link are fixed lines the run time puts on the message the line renders on (C-089):
      // S13-01 says that reply carries them, and the bundle's fixed lines hold the opener, with the privacy-notice link.
      const s1301 = (graphOf(flow)["S13-01"] as { more?: string[] } | undefined)?.more ?? [];
      for (const line of FIRST_REPLY_LINES) expect(s1301).toContain(line);
      const lists = (barber.bundle.manifest as { lists: { fixedLines: typeof FIXED } }).lists;
      expect(lists.fixedLines.lines.find((line) => line.id === "optOutLine")?.text).toBe(OPT_OUT);
      expect(lists.fixedLines.lines.find((line) => line.id === "opener")?.use).toContain(
        "privacy-notice link",
      );
    },
  );

  it.each([
    ["A", "S2-06", "staff"],
    ["B", "S2-06", "staff"],
    ["A", "S1-78", "other"],
    ["B", "S1-78", "other"],
  ] as const)("flow %s %s: no later text to that %s has the line for sure", (flow, id, lane) => {
    // A person's texts anywhere in the flow, by the compiled words' own names: a message to the lane names its person
    // (`as`), or the step's `as` names the step's customer or staff member, or it is the lane's own person (the flow's
    // names). None but the first reply has `true`: a "first" shows the line only where the message is the first text
    // that person gets on the walk, which no text after a reply with the line on every walk is.
    const corrected = correctedFlow(loadMaster(), flow).flow;
    const steps = stepsById(corrected.steps);
    const own = steps.get(id)?.say ?? [];
    const opened = own.findIndex((message) => message[0] === lane && message[1] === "san");
    const person = nameOf(own[opened] ?? []);
    const reply = own.findIndex(
      (message, k) => k > opened && message[0] === "san" && message[1] === lane && nameOf(message) === person,
    );
    expect(reply).toBeGreaterThan(opened);
    const named: readonly string[] = ["cust", "staff"];
    const stepName = (step: AppliedStep): string | undefined =>
      typeof step.as === "string" && named.includes(lane) && (step.to === lane || step.who === lane)
        ? step.as
        : undefined;
    const theirs = (step: AppliedStep, message: Line): boolean =>
      message[0] === "san" &&
      message[1] === lane &&
      (nameOf(message) ?? stepName(step) ?? corrected.names[lane]) === person;
    const graph = graphOf(flow);
    const sure: string[] = [];
    let looked = 0;
    for (const [stepId, step] of steps) {
      const lists: [readonly Line[] | undefined, Said[] | undefined, string][] = [
        [step.say, graph[stepId]?.say, "say"],
      ];
      for (const [key, patch] of Object.entries(step.vary ?? {})) {
        const words = patch as { say?: Line[]; addSay?: Line[] };
        lists.push([words.say, graph[stepId]?.vary?.[key]?.say, `vary ${key} say`]);
        lists.push([words.addSay, graph[stepId]?.vary?.[key]?.addSay, `vary ${key} addSay`]);
      }
      for (const [words, said, where] of lists)
        (words ?? []).forEach((message, k) => {
          if (!theirs(step, message)) return;
          looked += 1;
          if (said?.[k]?.elements?.stop === true) sure.push(`${stepId} ${where}[${String(k)}]`);
        });
    }
    expect(looked, `${flow}: texts to ${String(person)}`).toBeGreaterThan(0);
    expect(sure, `${flow}: the line for sure in ${String(person)}'s chat`).toStrictEqual([
      `${id} say[${String(reply)}]`,
    ]);
  });

  it("every message of the bundle carries the marker walkStops() gives it on barber's paths", () => {
    // An independent walk of the same words: barber applied to the master, then corrected (as stops.test.ts and the
    // parity sweep walk it), every path, each lit step's settled words read by step and index. Checked on every step
    // whose words are the same on every path (no variant that writes messages) and that no words op of barber's writes:
    // the master graph's steps, and the steps barber's ops add. Over the paths, a message is `true` where every path that
    // shows it gives it the line for sure, "first" where some gives it the line, and has no marker anywhere else.
    const trade = loadTrade("barber");
    for (const flow of ["A", "B"] as const) {
      const done = applyCorrections(applyTrade(loadMaster()[flow], trade));
      const steps = stepsById(done.flow.steps);
      const written = new Set(
        trade.flows[flow].ops.flatMap((op) =>
          op.op === "words" && (op.say !== undefined || op.vary !== undefined) ? [op.at] : [],
        ),
      );
      const plain = (step: AppliedStep): boolean =>
        !written.has(step.id) &&
        Object.values(step.vary ?? {}).every((patch) => {
          const words = patch as { say?: unknown; addSay?: unknown };
          return words.say === undefined && words.addSay === undefined;
        });
      const seen = new Map<string, { line: boolean; always: boolean }>();
      for (const path of tradePaths(done, trade)) {
        for (const entry of walkStops(done, path).steps) {
          if (!plain(entry.step)) continue;
          (entry.words.say ?? []).forEach((message, k) => {
            const stop = ((message as Line)[3] as { stop?: unknown } | undefined)?.stop;
            const key = `${entry.id} ${String(k)}`;
            const was = seen.get(key) ?? { line: false, always: true };
            seen.set(key, {
              line: was.line || stop === true || stop === "first",
              always: was.always && stop === true,
            });
          });
        }
      }
      const want = (id: string, k: number): unknown => {
        const what = seen.get(`${id} ${String(k)}`);
        return what?.line === true ? (what.always ? true : "first") : undefined;
      };
      const graph = graphOf(flow);
      const added = new Map<string, MarkedStep>();
      const ops =
        (
          barber.bundle.trades.barber?.flows as Record<
            string,
            { ops: { steps?: (MarkedStep & { id: string })[] }[] }
          >
        )[flow]?.ops ?? [];
      for (const op of ops) for (const step of op.steps ?? []) added.set(step.id, step);
      let compared = 0;
      let lines = 0;
      for (const [id, step] of steps) {
        if (!plain(step)) continue;
        const said = (step.own === true ? added.get(id) : graph[id])?.say ?? [];
        expect(said, `${flow} ${id}`).toHaveLength(step.say?.length ?? 0);
        said.forEach((message, k) => {
          compared += 1;
          if (want(id, k) !== undefined) lines += 1;
          expect(message.elements?.stop, `${flow} ${id} say[${String(k)}]`).toBe(want(id, k));
        });
      }
      expect(compared, `${flow}: messages compared`).toBeGreaterThan(500);
      expect(lines, `${flow}: messages with the line`).toBeGreaterThan(10);
    }
  });
});
