// T-135 parity: for every trade and both flows, applyTrade() against overlay-core.js apply() called directly on the
// master's own JSON files. Shared by the shard test files (parity.shard-N.test.ts): one apply takes about half a
// second, so the 243 trades x 2 flows x 2 applies are split over files that Vitest runs side by side. Every trade is
// in exactly one shard (see applier.test.ts); none is sampled out.
//
// The reference side is built the way the master's step.js builds it (`lib.js` loaded by its own loader, then
// `CORE.apply(master, ov, fl)` on the JSON files as they are). The one difference is Master Corrections R2: the
// loaders drop `src` and `prop` from steps, so the reference drops them from the same steps. apply() reads neither.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { listTradeIds, loadTrade } from "../load/trade";
import { applyTrade } from "./apply";
import { makeCjsLoader } from "./cjs-load";
import type { CoreApplyResult } from "./core";

const WORK = fileURLToPath(new URL("../../../fixtures/master/engine/work/", import.meta.url));
const FLOWS: readonly FlowLetter[] = ["A", "B"];

type Obj = Record<string, unknown>;

/** Drops the authoring fields (R2) from steps and, through their branches, from the steps under them. */
function dropAuthoring(steps: unknown): void {
  if (!Array.isArray(steps)) return;
  for (const step of steps as Obj[]) {
    delete step.src;
    delete step.prop;
    if (Array.isArray(step.branches)) {
      for (const branch of step.branches as Obj[]) dropAuthoring(branch.steps);
    }
  }
}

function readJson(file: string): Obj {
  return JSON.parse(readFileSync(file, "utf8")) as Obj;
}

/** Every `shards`-th trade id, starting at `shard` (0-based), of the sorted list of all trade ids. */
export function shardOf(ids: readonly string[], shard: number, shards: number): string[] {
  return ids.filter((_, k) => k % shards === shard);
}

/** How many shard files there are. */
export const SHARDS = 8;

/** The tests of one shard: each trade applied to both flows, compared whole with apply() on the vendored copy. */
export function parityShard(shard: number): void {
  const ids = shardOf(listTradeIds(), shard, SHARDS);
  const master = loadMaster();
  const lib = makeCjsLoader()(`${WORK}build/lib.js`) as {
    CORE: { apply(m: unknown, o: unknown, f: FlowLetter): CoreApplyResult };
  };
  const rawMaster: Record<FlowLetter, Obj> = {
    A: readJson(`${WORK}master/master-A.json`),
    B: readJson(`${WORK}master/master-B.json`),
  };
  for (const flow of FLOWS) dropAuthoring(rawMaster[flow].steps);

  describe(`parity shard ${String(shard + 1)} of ${String(SHARDS)}`, () => {
    it("has trades", () => {
      expect(ids.length).toBeGreaterThan(0);
    });
    for (const id of ids) {
      it(`${id}: both flows deep-equal apply() on the vendored copy`, () => {
        const trade = loadTrade(id);
        const raw = readJson(`${WORK}prof/${id}.json`);
        for (const flow of FLOWS) {
          const ops = ((raw[flow] as Obj).ops as Obj[] | undefined) ?? [];
          for (const op of ops) {
            dropAuthoring(op.steps);
            if (op.branch) dropAuthoring([{ branches: [op.branch] }]);
          }
          const want = lib.CORE.apply(rawMaster[flow], raw, flow);
          const got = applyTrade(master[flow], trade);
          expect(want.errors, `${id} ${flow}: apply() complained`).toEqual([]);
          expect(got.flow, `${id} ${flow}`).toStrictEqual(want.flow);
          expect(got.slotProblems, `${id} ${flow} slot problems`).toStrictEqual(want.slotProblems ?? []);
        }
      }, 120_000);
    }
  });
}
