// T-146 scan, shared by the shard files (parity.shard-N.test.ts): all 243 trades, both flows, applied and routed.
//
// For each trade and flow, the routing tables compiled from the applied flow are checked:
//   - the hubs, doors and the any-time table are the master's (a trade's overlay moves no hub, door or handler), and every
//     step they name is a step of the applied flow;
//   - 50 rule nodes, the master's S13 steps, in the master's order;
//   - the 10 homes are the applied flow's record.homes, and are the master's.
//
// One apply() is about 0.8 s: 243 trades x 2 flows is the cost, so the files are sharded over 8 and live in the parity
// project (outside `npm test`; the glob is compiler/src/**/parity.shard-*.test.ts; DL-085, DL-099).
import { describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { listTradeIds, loadTrade } from "../load/trade";
import { applyTrade } from "../overlay/apply";
import { RULE_NODE_COUNT, compileRouting, compileTradeRouting } from "./index";

const FLOWS: readonly FlowLetter[] = ["A", "B"];

/** How many shard files there are. */
export const SHARDS = 8;

/** Every `shards`-th trade id, starting at `shard` (0-based), of the sorted list of all trade ids. */
export function shardOf(ids: readonly string[], shard: number, shards: number): string[] {
  return ids.filter((_, k) => k % shards === shard);
}

export function routingShard(shard: number): void {
  const ids = shardOf(listTradeIds(), shard, SHARDS);
  const master = loadMaster();
  const base = { A: compileRouting(master.A), B: compileRouting(master.B) };

  describe(`routing, trades of shard ${String(shard + 1)} of ${String(SHARDS)}`, () => {
    it("the shard holds trades", () => {
      expect(ids.length).toBeGreaterThan(0);
    });

    for (const id of ids) {
      it(`${id}: both flows route as the master does`, () => {
        const trade = loadTrade(id);
        for (const flow of FLOWS) {
          const applied = applyTrade(master[flow], trade);
          const own = compileTradeRouting(applied);
          expect(own.hubs, `${id} ${flow} hubs`).toEqual(base[flow].hubs);
          expect(own.doors, `${id} ${flow} doors`).toEqual(base[flow].doors);
          expect(own.anytime, `${id} ${flow} any-time`).toEqual(base[flow].anytime);
          expect(own.ruleNodes, `${id} ${flow} rule nodes`).toHaveLength(RULE_NODE_COUNT);
          expect(own.alwaysOn.steps, `${id} ${flow} rule steps`).toEqual(base[flow].alwaysOn.steps);
          expect(own.homes, `${id} ${flow} homes`).toEqual(applied.flow.record.homes);
          expect(own.homes, `${id} ${flow} homes are the master's`).toEqual(base[flow].homes);
        }
      });
    }
  });
}
