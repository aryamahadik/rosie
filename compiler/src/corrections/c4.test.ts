// T-139, C4: switch "verify" is off and not launched, so what only it lights is not built (D96). Proofs of the card that
// belong to C4:
//   - on every path of the trades swept below (every money, booking and fixture path of barber; every money path of the
//     others), S1-33, S2-12, S2-13, S2-14, S11-99, S12-19, S13-41 and S13-43 and the verify branches of S1-32, S2-11 and
//     S11-42 are unlit; on barber's money paths also with switch "verify" turned on, where before C4 they are lit;
//   - S2-11 is lit wherever its trade keeps it, with its branch "Matches" alone, and gives license_checked; a trade's own
//     off of it stays (occupational-therapist: C8 is T-140's);
//   - over all 243 trade files, none turns switch "verify" on or adds a branch, step or words gated on it, so the master's
//     branches and steps are all there are; the corrected master the bundle holds has each of them off;
//   - each is switched off with C4's reason (a trade's own off kept), found by its place even where a trade renamed its
//     label, and the build stops where the master no longer gates one on switch "verify" alone;
//   - every changed line carries MC:C4, in a step of the card.
// Every trade applied and corrected, all 243 x both flows, runs in the parity project (parity.ts: every change tagged).
import { describe, expect, it, vi } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { correctedFlow } from "../emit/flow";
import { loadMaster } from "../load/flow";
import { listTradeIds, loadTrade, type LoadedTrade } from "../load/trade";
import { applyTrade, type AppliedBranch, type AppliedStep, type AppliedTrade } from "../overlay/apply";
import { tradePaths, walkPath, type PathWalk, type TradePath } from "../path";
import {
  KEPT_STEP,
  LICENSE_CHECKED,
  VERIFY,
  VERIFY_BRANCHES,
  VERIFY_OFF,
  VERIFY_STEPS,
  VerifyGateError,
  c4,
  onlyWithVerify,
} from "./c4";
import { CorrectionError, applyCorrections, renderDiff, type CorrectedTrade } from "./framework";

vi.setConfig({ testTimeout: 300_000 });

const master = loadMaster();
const FLOWS: readonly FlowLetter[] = ["A", "B"];
const ALL = listTradeIds();

/** The steps only switch "verify" lights: those of its branches, and its own. */
const UNLIT: readonly string[] = [...VERIFY_BRANCHES.map(([, holds]) => holds), ...VERIFY_STEPS];
/** The steps C4 may change: those that hold its branches, and its own. */
const CHANGED: ReadonlySet<string> = new Set([...VERIFY_BRANCHES.map(([at]) => at), ...VERIFY_STEPS]);
/** The split that holds S2-11, and its branch that does. */
const S2_11_SPLIT = "S2-28";

/**
 * The trades swept: barber (the master's words), aba (its own D96 offs of all but one), deck, occupational-therapist
 * (its own off of S2-11), golf-instructor (its own off of S1-32), and every 48th trade.
 */
const SWEPT: readonly string[] = [
  ...new Set([
    "barber",
    "aba",
    "deck",
    "occupational-therapist",
    "golf-instructor",
    ...ALL.filter((_, k) => k % 48 === 0),
  ]),
];

interface Corrected {
  trade: LoadedTrade;
  applied: AppliedTrade;
  done: CorrectedTrade;
}

const memo = new Map<string, Corrected>();
function corrected(id: string, flow: FlowLetter): Corrected {
  const key = `${id} ${flow}`;
  let hit = memo.get(key);
  if (hit === undefined) {
    const trade = loadTrade(id);
    const applied = applyTrade(master[flow], trade);
    hit = { trade, applied, done: applyCorrections(applied, [c4]) };
    memo.set(key, hit);
  }
  return hit;
}

/** Each money path of the trade, walked over the flow C4 corrected (made once). */
const walkMemo = new Map<string, { path: TradePath; walk: PathWalk }[]>();
function moneyWalks(id: string, flow: FlowLetter): { path: TradePath; walk: PathWalk }[] {
  const key = `${id} ${flow}`;
  let hit = walkMemo.get(key);
  if (hit === undefined) {
    const { trade, done } = corrected(id, flow);
    hit = tradePaths(done, trade, { booking: false, fixtures: false }).map((path) => ({
      path,
      walk: walkPath(done, path),
    }));
    walkMemo.set(key, hit);
  }
  return hit;
}

function find(steps: readonly AppliedStep[], id: string): AppliedStep | undefined {
  for (const step of steps) {
    if (step.id === id) return step;
    for (const branch of step.branches ?? []) {
      const hit = find(branch.steps, id);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** The branch of `at` that holds the step `holds`. */
function branchOf(steps: readonly AppliedStep[], at: string, holds: string): AppliedBranch | undefined {
  return find(steps, at)?.branches?.find((branch) => branch.steps.some((step) => step.id === holds));
}

/** The path with switch "verify" turned on. */
function withVerify(path: TradePath): TradePath {
  return { ...path, switches: { ...path.switches, [VERIFY]: true } };
}

/** What a walk lights that only switch "verify" lights: its steps, and the verify branches it shows lit. */
function verifyLit(walk: PathWalk): string[] {
  const out = walk.steps.map((entry) => entry.id).filter((id) => UNLIT.includes(id));
  for (const entry of walk.steps)
    for (const [at, holds] of VERIFY_BRANCHES) {
      if (entry.id !== at) continue;
      const k = (entry.step.branches ?? []).findIndex((branch) =>
        branch.steps.some((step) => step.id === holds),
      );
      if (entry.branches[k]?.lit === true) out.push(`${at} branch with ${holds}`);
    }
  return out;
}

function nameOf(path: TradePath): string {
  const booking = Object.entries(path.booking ?? {})
    .map(([group, value]) => `${group}:${value}`)
    .join(",");
  const fixture = path.fixture === undefined ? "" : ` +${path.fixture}`;
  return `${path.price}|${path.before}|${path.after}${booking === "" ? "" : ` ${booking}`}${fixture}`;
}

/** Every object anywhere in a value. */
function objects(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const item of value) objects(item, out);
  else if (typeof value === "object" && value !== null) {
    out.push(value as Record<string, unknown>);
    for (const item of Object.values(value)) objects(item, out);
  }
  return out;
}

describe("C4: what only switch verify lights is switched off", () => {
  it("switches off each verify branch and step with C4's reason, in both flows (barber: no off of its own)", () => {
    for (const flow of FLOWS) {
      const { applied, done } = corrected("barber", flow);
      for (const [at, holds] of VERIFY_BRANCHES) {
        expect(branchOf(applied.flow.steps, at, holds)?.off, `${flow} ${at}: before C4`).toBeUndefined();
        const branch = branchOf(done.flow.steps, at, holds);
        expect(onlyWithVerify(branch?.when), `${flow} ${at}`).toBe(true);
        expect(branch?.off, `${flow} ${at} branch with ${holds}`).toBe(VERIFY_OFF);
      }
      for (const id of VERIFY_STEPS) {
        expect(find(applied.flow.steps, id)?.off, `${flow} ${id}: before C4`).toBeUndefined();
        expect(find(done.flow.steps, id)?.off, `${flow} ${id}`).toBe(VERIFY_OFF);
      }
    }
  });

  it("keeps a trade's own off as the trade wrote it (aba's D96 offs), and records no change there", () => {
    for (const flow of FLOWS) {
      const { applied, done } = corrected("aba", flow);
      for (const [at, holds] of VERIFY_BRANCHES) {
        if (at === "S11-42") continue; // aba keeps S11-42's branch: C4 switches it off (below).
        const own = branchOf(applied.flow.steps, at, holds)?.off;
        expect(own, `${flow} ${at}`).toMatch(/^D96: /);
        expect(branchOf(done.flow.steps, at, holds)?.off, `${flow} ${at}`).toBe(own);
      }
      for (const id of VERIFY_STEPS) {
        const own = find(applied.flow.steps, id)?.off;
        expect(own, `${flow} ${id}`).toMatch(/^D96: /);
        expect(find(done.flow.steps, id)?.off, `${flow} ${id}`).toBe(own);
      }
      const leaves = find(done.flow.steps, "S11-42")?.branches ?? [];
      const k = leaves.findIndex((branch) => branch.steps.some((step) => step.id === "S11-99"));
      expect(done.changes.map((change) => `${change.step} ${change.path}`)).toStrictEqual([
        `S11-42 branches[${String(k)}].off`,
      ]);
      expect(leaves[k]?.off).toBe(VERIFY_OFF);
    }
  });

  it("finds each branch by the step it holds, so a trade's renamed label is still switched off", () => {
    const { applied } = corrected("barber", "A");
    const mine: AppliedTrade = { ...applied, flow: structuredClone(applied.flow) };
    const renamed = branchOf(mine.flow.steps, "S11-42", "S11-99");
    if (renamed === undefined) throw new Error("S11-42 holds no branch with S11-99");
    renamed.label = "The credential holder leaves";
    const done = applyCorrections(mine, [c4]);
    const branch = branchOf(done.flow.steps, "S11-42", "S11-99");
    expect(branch?.label).toBe("The credential holder leaves");
    expect(branch?.off).toBe(VERIFY_OFF);
  });

  it("stops the build where the master no longer has one where C4 finds it, gated on switch verify alone", () => {
    const { applied } = corrected("barber", "B");
    const run = (change: (flow: AppliedTrade["flow"]) => void): unknown => {
      const mine: AppliedTrade = { ...applied, flow: structuredClone(applied.flow) };
      change(mine.flow);
      return applyCorrections(mine, [c4]);
    };
    expect(() =>
      run((flow) => {
        const step = find(flow.steps, "S12-19");
        if (step !== undefined) delete step.when;
      }),
    ).toThrow(VerifyGateError);
    expect(() =>
      run((flow) => {
        const branch = branchOf(flow.steps, "S2-11", "S2-13");
        if (branch !== undefined) branch.when = { switchOn: [VERIFY, "standin"] };
      }),
    ).toThrow(VerifyGateError);
    expect(() =>
      run((flow) => {
        const step = find(flow.steps, "S1-32");
        if (step?.branches !== undefined)
          step.branches = step.branches.filter((branch) => !branch.steps.some((one) => one.id === "S1-33"));
      }),
    ).toThrow(CorrectionError);
    expect(() =>
      run((flow) => {
        const step = find(flow.steps, KEPT_STEP);
        if (step !== undefined) step.when = { switchOn: [VERIFY] };
      }),
    ).toThrow(VerifyGateError);
    expect(() =>
      run((flow) => {
        const step = find(flow.steps, KEPT_STEP);
        if (step !== undefined) step.gives = [];
      }),
    ).toThrow(VerifyGateError);
  });
});

describe("C4 on every path: nothing only switch verify lights is lit", () => {
  it("lights none of them on any money, booking or fixture path of barber", () => {
    for (const flow of FLOWS) {
      const { trade, done } = corrected("barber", flow);
      const paths = tradePaths(done, trade);
      expect(paths.some((path) => path.kind === "booking")).toBe(true);
      expect(paths.some((path) => path.kind === "fixture")).toBe(true);
      for (const path of paths)
        expect(verifyLit(walkPath(done, path)), `${flow} ${nameOf(path)}`).toStrictEqual([]);
    }
  });

  it("lights none of them on barber's money paths with switch verify on, where before C4 they are lit", () => {
    for (const flow of FLOWS) {
      const { applied, done } = corrected("barber", flow);
      const paths = moneyWalks("barber", flow).map((one) => withVerify(one.path));
      // Control: with switch verify on, the flow before C4 lights each of them on some path.
      const before = new Set(paths.flatMap((path) => verifyLit(walkPath(applied, path))));
      for (const id of UNLIT)
        expect(before.has(id), `${flow}: ${id} lit with verify on before C4`).toBe(true);
      for (const [at, holds] of VERIFY_BRANCHES)
        expect(before.has(`${at} branch with ${holds}`), `${flow} ${at}`).toBe(true);
      for (const path of paths)
        expect(verifyLit(walkPath(done, path)), `${flow} ${nameOf(path)} with verify on`).toStrictEqual([]);
    }
  });

  it(`lights none of them on any money path of ${String(SWEPT.length)} trades`, () => {
    for (const id of SWEPT)
      for (const flow of FLOWS) {
        const walks = moneyWalks(id, flow);
        expect(walks.length, `${id} ${flow}`).toBeGreaterThan(0);
        for (const { path, walk } of walks)
          expect(verifyLit(walk), `${id} ${flow} ${nameOf(path)}`).toStrictEqual([]);
      }
  });

  it("lights S2-11 on every money path where its trade keeps it, with 'Matches' alone, and S2-11 gives license_checked", () => {
    let kept = 0;
    for (const id of SWEPT)
      for (const flow of FLOWS) {
        const { done } = corrected(id, flow);
        const step = find(done.flow.steps, KEPT_STEP);
        expect(step?.gives, `${id} ${flow}`).toContain(LICENSE_CHECKED);
        // Kept: neither S2-11, nor the branch of S2-28 that holds it, nor S2-28 is switched off by the trade.
        const keeps =
          step?.off === undefined &&
          branchOf(done.flow.steps, S2_11_SPLIT, KEPT_STEP)?.off === undefined &&
          find(done.flow.steps, S2_11_SPLIT)?.off === undefined;
        if (keeps) kept += 1;
        for (const { path, walk } of moneyWalks(id, flow)) {
          const lit = walk.steps.find((entry) => entry.id === KEPT_STEP);
          expect(lit !== undefined, `${id} ${flow} ${nameOf(path)}: S2-11 lit`).toBe(keeps);
          if (lit === undefined) continue;
          expect(
            lit.branches.filter((branch) => branch.lit).map((branch) => branch.label),
            `${id} ${flow} ${nameOf(path)}`,
          ).toStrictEqual(["Matches"]);
        }
      }
    expect(kept).toBeGreaterThan(0);
    for (const flow of FLOWS) {
      expect(find(corrected("barber", flow).done.flow.steps, KEPT_STEP)?.off).toBeUndefined();
      expect(find(corrected("occupational-therapist", flow).done.flow.steps, KEPT_STEP)?.off).toMatch(
        /^D96: /,
      );
    }
  });
});

describe("C4 over all 243 trades", () => {
  it("no trade turns switch verify on, or adds a branch, step or words gated on it", () => {
    expect(ALL).toHaveLength(243);
    for (const id of ALL) {
      const trade = loadTrade(id);
      expect(Object.keys(trade.switches ?? {}), id).not.toContain(VERIFY);
      for (const flow of FLOWS) {
        const gated = objects(trade.flows[flow].ops).filter(
          (item) =>
            (Array.isArray(item.switchOn) && item.switchOn.includes(VERIFY)) ||
            (Array.isArray(item.switchOff) && item.switchOff.includes(VERIFY)) ||
            Object.keys(item).some((key) => key.split("+").includes(`pf:${VERIFY}`)),
        );
        expect(gated, `${id} ${flow}`).toStrictEqual([]);
      }
    }
  });

  it("the corrected master the bundle holds has each verify branch and step off, and S2-11 built", () => {
    for (const flow of FLOWS) {
      const steps = correctedFlow(master, flow).flow.steps;
      for (const [at, holds] of VERIFY_BRANCHES)
        expect(branchOf(steps, at, holds)?.off, `${flow} ${at}`).toBe(VERIFY_OFF);
      for (const id of VERIFY_STEPS) expect(find(steps, id)?.off, `${flow} ${id}`).toBe(VERIFY_OFF);
      const kept = find(steps, KEPT_STEP);
      expect(kept?.off).toBeUndefined();
      expect(kept?.gives).toContain(LICENSE_CHECKED);
      expect(kept?.branches?.find((branch) => branch.label === "Matches")?.off).toBeUndefined();
    }
  });
});

describe("C4 on the whole", () => {
  it("changes only the steps of the card, and every changed line carries MC:C4", () => {
    for (const id of ["barber", "aba", "deck"])
      for (const flow of FLOWS) {
        const { done } = corrected(id, flow);
        expect(done.changes.length, `${id} ${flow}`).toBeGreaterThan(0);
        for (const change of done.changes) {
          expect(change.tag).toBe("MC:C4");
          expect(CHANGED.has(change.step), `${id} ${flow}: ${change.step}`).toBe(true);
          expect(change.path === "off" || /^branches\[\d+\]\.off$/.test(change.path), change.path).toBe(true);
        }
        expect(renderDiff(done.changes).every((line) => line.startsWith("MC:C4 "))).toBe(true);
      }
  });

  it("finds nothing more to change in a flow it has already corrected", () => {
    for (const flow of FLOWS)
      expect(applyCorrections(corrected("barber", flow).done, [c4]).changes).toStrictEqual([]);
  });

  it("is C4's own, from Master Corrections C4", () => {
    expect(c4.id).toBe("C4");
    expect(c4.source).toContain("Master Corrections C4");
    expect(c4.source).toContain("D96");
  });
});
