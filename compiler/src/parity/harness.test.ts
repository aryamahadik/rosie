// T-161: the parity harness. The card's proofs (with its lead note, DL-867):
//   1. 5 trades x 3 paths x both flows: the compiler's pre-correction words equal the vendored functions' words, for
//      each step the path lights (does, more, say as plain text, form, rule, the lit branches and the keys that chose
//      them), read as step.js reads a path; and again with the opt-out marker settled and with a branch's `sets` followed.
//   2. For the paths step.js can express (no header-only fact, the trade's switches written into pf=), the reference's
//      words equal what `node <master copy>/work/build/step.js` prints. The master copy is outside git: each such test
//      skips itself, saying why, where there is none (CI); fixture set v1's vendored lib.js and overlay-core.js are the
//      reference there.
//   3. A word changed in a test copy is reported with its trade, flow, path, step and field.
//
// The five trades are fixture set v1's own (rule 9):
//   aba          switches sensitive and welfare; lists the header-only fact monthlybill, so step.js cannot say its paths
//   lactation    switches sensitive and welfare in both flows; no header-only fact
//   dietitian    sensitive in flow A, sensitive and welfare in flow B, whose paths start at a set start
//   pet-waste    no switch; flow A starts at a set start, flow B at a set time with a window
//   insurance    no facts list (before C5 gives it one): every fact-gated branch shows
// The three paths of each trade and flow: its first money path, the first booking value laid on it, and the record
// fixture two-full where it rides (else its first fixture path).
import { describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { loadTrade } from "../load/trade";
import { applyTrade, type AppliedTrade } from "../overlay/apply";
import { stepOf, tradePaths, type TradePath } from "../path";
import {
  Reference,
  compareStepJs,
  compareWords,
  comparePath,
  compilerWords,
  findMasterCopy,
  formatDifference,
  masterCopyCandidates,
  masterCopyDiffers,
  runStepJs,
  stepJsHead,
  stepJsLines,
  type PathWords,
  type WordDifference,
  type WordsOptions,
} from "./harness";

const TRADES = ["aba", "lactation", "dietitian", "pet-waste", "insurance"] as const;
const FLOWS: readonly FlowLetter[] = ["A", "B"];

const master = loadMaster();
const reference = new Reference();

// One apply takes about half a second: each trade and flow is applied once.
const appliedCache = new Map<string, AppliedTrade>();
function applied(trade: string, flow: FlowLetter): AppliedTrade {
  const key = `${trade} ${flow}`;
  let hit = appliedCache.get(key);
  if (hit === undefined) {
    hit = applyTrade(master[flow], loadTrade(trade));
    appliedCache.set(key, hit);
  }
  return hit;
}

/** The three paths of a trade and flow (the model's, T-136): first money path, first booking value, two-full or the first fixture. */
function picks(trade: string, flow: FlowLetter): TradePath[] {
  const paths = tradePaths(applied(trade, flow), loadTrade(trade));
  const money = paths.find((path) => path.kind === "money");
  const booking = paths.find((path) => path.kind === "booking");
  const fixture =
    paths.find((path) => path.fixture === "two-full") ?? paths.find((path) => path.kind === "fixture");
  if (money === undefined || booking === undefined || fixture === undefined)
    throw new Error(`${trade} flow ${flow}: a money path, a booking path and a fixture path are needed`);
  return [money, booking, fixture];
}

/** Each difference as a report line, so a failure names trade, flow, path, step and field. */
const lines = (differences: readonly WordDifference[]): string[] => differences.map(formatDifference);

/** Every trade x flow x path of the matrix, with what the comparison saw. */
function runMatrix(
  trade: string,
  options: WordsOptions,
): { walks: number; steps: number; words: PathWords[] } {
  let walks = 0;
  let steps = 0;
  const words: PathWords[] = [];
  for (const flow of FLOWS) {
    for (const path of picks(trade, flow)) {
      const parity = comparePath(reference, applied(trade, flow), path, options);
      expect(lines(parity.differences), `${trade} flow ${flow} ${parity.compiler.path}`).toEqual([]);
      expect(parity.reference?.steps.length ?? 0).toBe(parity.compiler.steps.length);
      expect(parity.compiler.steps.length, `${trade} flow ${flow} ${parity.compiler.path}`).toBeGreaterThan(
        100,
      );
      if (parity.reference !== null) words.push(parity.reference);
      walks += 1;
      steps += parity.compiler.steps.length;
    }
  }
  return { walks, steps, words };
}

describe("5 trades x 3 paths x both flows: the compiler's pre-correction words equal the vendored functions'", () => {
  for (const trade of TRADES) {
    it(`${trade}: read as step.js reads a path (each step with the walked path alone, the opt-out marker as written)`, () => {
      const { walks, steps, words } = runMatrix(trade, {});
      expect(walks).toBe(6);
      expect(steps).toBeGreaterThan(600);
      // the comparison is not empty-handed: messages carry their plain-text forms, and splits light some branches only
      const all = words.flatMap((walk) => walk.steps);
      expect(all.some((step) => step.say.some((message) => message.includes("\n")))).toBe(true);
      expect(all.some((step) => step.branches.length >= 2)).toBe(true);
      expect(all.some((step) => step.keys.length > 0)).toBe(true);
    }, 300_000);
  }

  it("with the opt-out marker settled (applyStops over firstTexts of the walked path, walkPath's default)", () => {
    let walks = 0;
    for (const trade of TRADES) walks += runMatrix(trade, { stops: "settled" }).walks;
    expect(walks).toBe(30);
  }, 600_000);

  it("with a branch's sets followed (lib.js litSteps' walk)", () => {
    let walks = 0;
    let readings = 0;
    for (const trade of TRADES) {
      const run = runMatrix(trade, { sets: true });
      walks += run.walks;
      readings += run.words.reduce(
        (sum, walk) => sum + new Set(walk.steps.map((step) => step.reading)).size,
        0,
      );
    }
    expect(walks).toBe(30);
    // a path read after a branch's sets is a reading of its own
    expect(readings).toBeGreaterThan(30);
  }, 600_000);

  it("aba's switches are on every path: A10-01 shows its pf:sensitive words (the step.js --prof trap is avoided)", () => {
    const trade = loadTrade("aba");
    expect(trade.switches).not.toBeNull();
    const [money] = picks("aba", "A");
    if (money === undefined) throw new Error("aba has no money path in flow A");
    expect(money.switches).toEqual({ sensitive: true, welfare: true });
    const parity = comparePath(reference, applied("aba", "A"), money);
    expect(lines(parity.differences)).toEqual([]);
    const receipt = parity.reference?.steps.find((step) => step.id === "A10-01");
    expect(receipt?.keys).toContain("pf:sensitive");
    expect(parity.compiler.steps.find((step) => step.id === "A10-01")).toStrictEqual(receipt);
  }, 120_000);

  it("a path the reference does not walk is reported as a path difference", () => {
    const [money] = picks("lactation", "A");
    if (money === undefined) throw new Error("lactation has no money path in flow A");
    const listed = loadTrade("lactation").flows.A.money.combos;
    const unlisted = ["visit|none|counter", "photos|card|card", "list|full|none"].find(
      (combo) => !listed.includes(combo),
    );
    if (unlisted === undefined) throw new Error("lactation lists every candidate");
    const [price, before, after] = unlisted.split("|") as [
      TradePath["price"],
      TradePath["before"],
      TradePath["after"],
    ];
    const elsewhere: TradePath = { ...money, price, before, after };
    const parity = comparePath(reference, applied("lactation", "A"), elsewhere);
    expect(parity.reference).toBeNull();
    expect(parity.differences).toHaveLength(1);
    expect(parity.differences[0]).toMatchObject({ trade: "lactation", flow: "A", step: "", field: "path" });
  }, 120_000);
});

describe("a word changed in a test copy is reported with its trade, flow, path, step and field", () => {
  const trade = "lactation";
  const flow: FlowLetter = "A";

  /** The compiler's copy of the applied flow, one step changed by `change`. */
  function changed(id: string, change: (step: Record<string, unknown>) => void): AppliedTrade {
    const copy = structuredClone(applied(trade, flow));
    const step = stepOf(copy.flow, id);
    if (step === undefined) throw new Error(`${id} is not in ${trade}'s flow ${flow}`);
    change(step);
    return copy;
  }

  it("in a step's does, a more line, a message and a branch label", () => {
    const [path] = picks(trade, flow);
    if (path === undefined) throw new Error("no path");
    const referencePath = reference.pathFor(trade, flow, path);
    if (referencePath === null) throw new Error("the reference has no such path");
    const want = reference.words(trade, flow, referencePath);
    const name = want.path;
    const before = want.steps.find((step) => step.id === "S1-02");
    if (before === undefined) throw new Error("S1-02 is not lit");
    expect(compareWords(compilerWords(applied(trade, flow), path), want)).toEqual([]);

    const at = { trade, flow, path: name, step: "S1-02", side: "compiler" };
    const swap = (text: string): string => text.replace("kinds", "sorts");

    const does = changed("S1-02", (step) => {
      step.does = swap(String(step.does));
    });
    expect(compareWords(compilerWords(does, path), want)).toEqual([
      { ...at, field: "does", index: null, got: swap(before.does ?? ""), want: before.does },
    ]);

    const more = changed("S1-02", (step) => {
      const list = step.more as string[];
      list[1] = `${String(list[1])} Today.`;
    });
    expect(compareWords(compilerWords(more, path), want)).toEqual([
      { ...at, field: "more", index: 1, got: `${String(before.more[1])} Today.`, want: before.more[1] },
    ]);

    const say = changed("S1-02", (step) => {
      const message = (step.say as unknown[][])[0];
      if (message === undefined) throw new Error("S1-02 says nothing");
      message[2] = swap(String(message[2]));
    });
    expect(compareWords(compilerWords(say, path), want)).toEqual([
      { ...at, field: "say", index: 0, got: swap(before.say[0] ?? ""), want: before.say[0] },
    ]);

    const label = changed("S1-02", (step) => {
      const branch = (step.branches as { label: string }[])[0];
      if (branch === undefined) throw new Error("S1-02 has no branch");
      branch.label = "All of them on the list";
    });
    const differences = compareWords(compilerWords(label, path), want);
    expect(differences).toEqual([
      { ...at, field: "branches", index: 0, got: "All of them on the list", want: before.branches[0]?.label },
    ]);
    const [first] = differences;
    if (first === undefined) throw new Error("no difference");
    expect(formatDifference(first)).toBe(
      `lactation flow A "${name}" S1-02 branches[0]: compiler "All of them on the list", the reference "All on the list"`,
    );
  }, 120_000);

  it("a step the compiler's copy leaves out, and a step it lights besides", () => {
    const [path] = picks(trade, flow);
    if (path === undefined) throw new Error("no path");
    const parity = comparePath(reference, applied(trade, flow), path);
    const want = parity.reference;
    if (want === null) throw new Error("the reference has no such path");
    const off = changed("S1-02", (step) => {
      step.off = "a test copy switches it off";
    });
    const missing = compareWords(compilerWords(off, path), want).filter((d) => d.field === "step");
    expect(missing[0]).toMatchObject({
      trade,
      flow,
      path: want.path,
      step: "S1-02",
      field: "step",
      got: null,
    });
    expect(missing.every((difference) => difference.got === null)).toBe(true);

    // the other way: a step the reference lacks (a copy of its words without S1-02) is one the compiler lights besides
    const at = want.steps.findIndex((step) => step.id === "S1-02");
    const fewer: PathWords = { ...want, steps: want.steps.filter((step) => step.id !== "S1-02") };
    expect(compareWords(parity.compiler, fewer)).toEqual([
      {
        trade,
        flow,
        path: want.path,
        step: "S1-02",
        field: "step",
        index: at,
        side: "compiler",
        got: `S1-02 on ${want.path}`,
        want: null,
      },
    ]);
  }, 120_000);

  it("in step.js's printout: the reference printed as step.js prints it compares equal, and a changed word is reported", () => {
    const [path] = picks(trade, flow);
    if (path === undefined) throw new Error("no path");
    const referencePath = reference.pathFor(trade, flow, path);
    if (referencePath === null) throw new Error("the reference has no such path");
    const want = reference.words(trade, flow, referencePath);
    const printout = want.steps
      .flatMap((step) => [
        `### ${step.id} · a title`,
        "- lines 1.1 · san · msg",
        stepJsHead(step),
        ...stepJsLines(step).map((x) => x.line),
      ])
      .join("\n");
    expect(compareStepJs(want, `${printout}\n`)).toEqual([]);
    const s102 = want.steps.find((step) => step.id === "S1-02");
    if (s102 === undefined || s102.does === null) throw new Error("S1-02 has no does");
    const does = s102.does;
    const edited = printout.replace(`  ${does}`, () => `  ${does.replace("kinds", "sorts")}`);
    expect(compareStepJs(want, edited)).toEqual([
      {
        trade,
        flow,
        path: want.path,
        step: "S1-02",
        field: "does",
        index: null,
        side: "step.js",
        got: `  ${does.replace("kinds", "sorts")}`,
        want: `  ${does}`,
      },
    ]);
  }, 120_000);
});

describe("the reference equals step.js's printout where step.js --path can say the path", () => {
  const copy = findMasterCopy();

  it("the master copy is found from this checkout, or from a linked worktree's main checkout", () => {
    const candidates = masterCopyCandidates();
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0]?.endsWith("scratch/master-copy/engine")).toBe(true);
  });

  it("the master copy reads fixture set v1's inputs, byte for byte", (context) => {
    if ("reason" in copy) {
      context.skip(copy.reason);
      return;
    }
    expect(masterCopyDiffers(copy.engine, TRADES)).toEqual([]);
  });

  for (const trade of TRADES) {
    it(`${trade}: every path step.js can express prints the reference's words; the others say why not`, (context) => {
      if ("reason" in copy) {
        context.skip(copy.reason);
        return;
      }
      let ran = 0;
      for (const flow of FLOWS) {
        for (const path of picks(trade, flow)) {
          const referencePath = reference.pathFor(trade, flow, path);
          if (referencePath === null) throw new Error(`${trade} flow ${flow}: no reference path`);
          const said = reference.stepJsPath(trade, flow, referencePath);
          if ("reason" in said) {
            // aba lists monthlybill, a header-only fact that step.js --path refuses (specs.md 4.3)
            expect(trade, said.reason).toBe("aba");
            expect(said.reason).toContain("no plug-in fact 'monthlybill'");
            continue;
          }
          const want = reference.words(trade, flow, referencePath);
          const output = runStepJs(
            copy.stepJs,
            trade,
            flow,
            [...new Set(want.steps.map((step) => step.id))],
            said.text,
          );
          expect(lines(compareStepJs(want, output)), `${trade} flow ${flow} --path "${said.text}"`).toEqual(
            [],
          );
          if (path.switches.sensitive === true) expect(said.text).toContain("pf=sensitive");
          ran += 1;
        }
      }
      expect(ran).toBe(trade === "aba" ? 0 : 6);
    }, 600_000);
  }
});
