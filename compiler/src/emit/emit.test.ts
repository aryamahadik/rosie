// The bundle emitter (T-149): from fixture set v1's master flows and two trades (the barber shop, fixture set v1's
// demo shop, and insurance, the trade with no facts list), the bundle validates against K-01 v1 with Ajv, its files are
// the stored values its manifest lists, and two builds from the same inputs are byte for byte the same. The all-trades
// build runs only through the CLI (`npm run cli -w @rosie/compiler -- build --out <dir>`), never here (DL-099).
//
// The stand-in bundle id here is GIVEN_ID (ab repeated, build 7): a bundle id is T-150's, so the test passes one in,
// as the build command's --bundle-id does; the emitter's own stand-in (64 zeros, build 1) is checked in cli.test.ts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";
import { buildKeyMap } from "../keymap";
import { loadTrade } from "../load/trade";
import { buildKeywords } from "../msgtext";
import { S13_32_LINES } from "../corrections/c1";
import { buildBundle, byteLength, markedRules, treeSha256, type BuiltBundle } from "./index";

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

beforeAll(async () => {
  built = await buildBundle(OPTIONS);
  again = await buildBundle(OPTIONS);
  manifest = built.bundle.manifest as unknown as Manifest;
  flows = built.bundle.flows as unknown as Record<"A" | "B", Flow>;
});

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
