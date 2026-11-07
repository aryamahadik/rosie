// T-142 scan, shared by the shard files (parity.shard-N.test.ts): all 243 trades, both flows, applied, slotted and read.
//
// For each trade and flow:
//   - every message string of the flow (each step's `say`, each variant's `say`, `addSay` and swap words, the layer lines,
//     the record's rows) is read for sample names, businesses, dates, times, places, phones, codes and $ amounts left
//     outside a slot: none. These lines are a superset of the lines of any listed path, since a path shows a step's own
//     `say` and the variants its keys pick (pathLines), so the scan covers every path of the trade;
//   - three listed paths of the trade (the first money path, the first booking-value path and the first fixture path)
//     are walked with the master's own walk, and their lines are read again, each one among the flow's lines;
//   - every slot written is in K-03 v1's vocabulary (no unknown slot, no hold);
//   - Rosie's own fee terms ($2, the $49 cap, 1%) are as many after slotting as before, line for line, and stand in
//     S1-25, S1-29 and the record's two.count rows (A9-21's);
//   - the slots the master wrote (record, amount, ledger, svc.intext ...) are as many after as before.
//
// A path is walked at about 80 ms, one apply() at about 0.8 s: 243 trades x 2 flows x 2 applies is the cost, so the files
// are sharded over 8 and live in the parity project (outside `npm test`; the glob is compiler/src/**/parity.shard-*.test.ts).
import { describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { listTradeIds, loadTrade } from "../load/trade";
import { applyTrade } from "../overlay/apply";
import { tradePaths, walkPath, type TradePath } from "../path";
import { SLOT_NAMES } from "../record";
import {
  checkLines,
  countFeeTerms,
  flowLines,
  leftovers,
  pathLines,
  recordLines,
  sampleTable,
  slotApplied,
  slotCounts,
  slotNames,
} from "./index";

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

export function slotShard(shard: number): void {
  const ids = shardOf(listTradeIds(), shard, SHARDS);
  const master = loadMaster();
  const vocabulary = slotNames();

  describe(`slots scan shard ${String(shard + 1)} of ${String(SHARDS)}`, () => {
    it("has trades", () => {
      expect(ids.length).toBeGreaterThan(0);
    });
    for (const id of ids) {
      it(`${id}: both flows, no sample value outside a slot, every slot in K-03 v1, fee terms literal`, () => {
        const trade = loadTrade(id);
        for (const flow of FLOWS) {
          const at = `${id} flow ${flow}`;
          const applied = applyTrade(master[flow], trade);
          const table = sampleTable(master, flow, trade, applied.flow);
          const slotted = slotApplied(applied, table);
          const before = [...flowLines(applied.flow), ...recordLines(applied.flow)];
          const lines = [...flowLines(slotted.applied.flow), ...recordLines(slotted.applied.flow)];
          expect(lines, at).toHaveLength(before.length);

          // 1. nothing left outside a slot (each distinct line is read once)
          const seen = new Map<string, string[]>();
          const residue: string[] = [];
          for (const line of lines) {
            let found = seen.get(line.text);
            if (found === undefined) {
              found = leftovers(line.text, table).map((l) => `${l.kind} ${l.match}`);
              seen.set(line.text, found);
            }
            if (found.length > 0) residue.push(`${line.at}: ${found.join(", ")}: ${line.text.slice(0, 120)}`);
          }
          expect(residue, at).toEqual([]);

          // 2. every slot written is in the vocabulary (no unknown slot, no hold)
          expect(() => {
            checkLines(lines, vocabulary);
          }, at).not.toThrow();

          // 3. fee terms literal, line for line; the master's own slots as many as before
          let terms = 0;
          before.forEach((line, k) => {
            const was = countFeeTerms(line.text);
            const now = countFeeTerms(lines[k]?.text ?? "");
            if (JSON.stringify(was) !== JSON.stringify(now)) expect(now, `${at} ${line.at}`).toEqual(was);
            terms += was.$2 ?? 0;
          });
          expect(terms, `${at}: fee terms`).toBeGreaterThan(0);
          const wasSlots = slotCounts(before);
          const nowSlots = slotCounts(lines);
          for (const name of [...SLOT_NAMES, "due", "paidnow", "keep", "back", "later", "backlate"])
            expect(nowSlots.get(name) ?? 0, `${at}: ${name}`).toBe(wasSlots.get(name) ?? 0);

          // 4. listed paths, walked: their lines are among the flow's, and clean
          const all = new Set(lines.map((line) => `${line.at}\u0000${line.text}`));
          const paths = tradePaths(applied, trade);
          expect(paths.length, `${at}: paths`).toBeGreaterThan(0);
          for (const path of samplePaths(paths)) {
            const shown = pathLines(slotted.applied.flow, walkPath(applied, path));
            expect(shown.length, `${at}: ${path.kind} path lines`).toBeGreaterThan(0);
            for (const line of shown)
              expect(all.has(`${line.at}\u0000${line.text}`), `${at} ${line.at}`).toBe(true);
          }
        }
      }, 300_000);
    }
  });
}
