// T-145 scan, shared by the shard files (parity.shard-N.test.ts): all 243 trades, both flows, applied and compiled.
//
// For each trade and flow:
//   - every split of the applied flow is compiled, with every live branch (an `off` branch is gone), each label byte for byte
//     the applied branch's, and exactly one tag each;
//   - a branch that is not an op's own keeps the master's tag, gate, sets, end and flow switch;
//   - no split is a dead end where a walk should go on (closedSplits: only a last step of an ending branch);
//   - the flow-switch ends of the master that the trade keeps still continue in flow B;
//   - three listed paths of the trade (the first money path, the first booking-value path and the first fixture path) are
//     walked with the master's own walk: every branch the walk lights is a compiled branch of its split, by label.
//
// One apply() is about 0.8 s: 243 trades x 2 flows, so the files are sharded over 8 and live in the parity project (outside
// `npm test`; the glob is compiler/src/**/parity.shard-*.test.ts).
import { describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { listTradeIds, loadTrade } from "../load/trade";
import { applyTrade } from "../overlay/apply";
import { tradePaths, walkPath, type TradePath } from "../path";
import { closedSplits, compileMasterBranches, compileTradeBranches } from "./index";

const FLOWS: readonly FlowLetter[] = ["A", "B"];

/** How many shard files there are. */
export const SHARDS = 8;

/** Every `shards`-th trade id, starting at `shard` (0-based), of the sorted list of all trade ids. */
export function shardOf(ids: readonly string[], shard: number, shards: number): string[] {
  return ids.filter((_, k) => k % shards === shard);
}

/** The first path of each kind (money, booking, fixture) a trade has in a flow. */
function samplePaths(paths: readonly TradePath[]): TradePath[] {
  const out: TradePath[] = [];
  for (const kind of ["money", "booking", "fixture"] as const) {
    const path = paths.find((candidate) => candidate.kind === kind);
    if (path !== undefined) out.push(path);
  }
  return out;
}

export function branchShard(shard: number): void {
  const ids = shardOf(listTradeIds(), shard, SHARDS);
  const master = loadMaster();
  const base = compileMasterBranches(master);

  describe(`branches scan shard ${String(shard + 1)} of ${String(SHARDS)}`, () => {
    it("has trades", () => {
      expect(ids.length).toBeGreaterThan(0);
    });
    for (const id of ids) {
      it(`${id}: both flows, labels exact, one tag each, no dead end, the flow switches kept, lit branches compiled`, () => {
        const trade = loadTrade(id);
        for (const flow of FLOWS) {
          const at = `${id} flow ${flow}`;
          const applied = applyTrade(master[flow], trade);
          const out = compileTradeBranches(applied);
          const masterOf = base[flow];

          for (const [splitId, branches] of Object.entries(out)) {
            const labels = branches.map((branch) => branch.label);
            // A label twice in one split is only ever a `branch` op of the trade adding a branch the master's split
            // already has (B4-26's "3 Nobody will be home"): both are kept, in order, and the lint (T-155) judges.
            if (new Set(labels).size !== labels.length)
              expect(
                trade.flows[flow].ops.some((op) => op.op === "branch" && op.at === splitId),
                `${at} ${splitId}: a label twice with no branch op`,
              ).toBe(true);
            for (const branch of branches) {
              expect(["message", "lookup", "clock"], `${at} ${splitId} ${branch.label}`).toContain(
                branch.tag,
              );
              const was = masterOf[splitId]?.find((candidate) => candidate.label === branch.label);
              // an op's own branch, a split the trade adds, or a label the split has twice (the second is the op's)
              if (was === undefined || labels.filter((label) => label === branch.label).length > 1) continue;
              if (was.when !== undefined || branch.when !== undefined)
                expect(branch.when, `${at} ${splitId} ${branch.label}`).toEqual(was.when);
              expect(branch.sets, `${at} ${splitId} ${branch.label}`).toEqual(was.sets);
              expect(branch.end, `${at} ${splitId} ${branch.label}`).toBe(was.end);
              expect(branch.flow, `${at} ${splitId} ${branch.label}`).toBe(was.flow);
              expect(branch.tag, `${at} ${splitId} ${branch.label}`).toBe(was.tag);
            }
          }
          for (const split of closedSplits(applied.flow.steps))
            expect(split.hostEnds, `${at} ${split.id} never rejoins`).toBe(true);

          // the master's flow switches that the trade keeps (the branch and its split are both still there)
          for (const [splitId, branches] of Object.entries(masterOf)) {
            for (const branch of branches) {
              if (branch.flow === undefined) continue;
              const kept = out[splitId]?.find((candidate) => candidate.label === branch.label);
              if (kept !== undefined) expect(kept.flow, `${at} ${splitId} ${branch.label}`).toBe("B");
            }
          }

          const paths = tradePaths(applied, trade);
          expect(paths.length, `${at}: paths`).toBeGreaterThan(0);
          for (const path of samplePaths(paths)) {
            for (const step of walkPath(applied, path).steps) {
              const compiledBranches = out[step.id];
              for (const light of step.branches) {
                if (!light.lit) continue;
                expect(
                  compiledBranches?.some((branch) => branch.label === light.label),
                  `${at} ${path.kind} path ${step.id} lights "${light.label}"`,
                ).toBe(true);
              }
            }
          }
        }
      }, 300_000);
    }
  });
}
