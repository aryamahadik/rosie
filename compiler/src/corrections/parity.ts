// T-138 sweep, shared by the shard files (parity.shard-N.test.ts): all 243 trades x both flows, with C1 and C2 applied.
//
// For each trade and flow, over the compiled flow:
//   - no line says one business's texts stop or are off (C1);
//   - the reach card asks for a mobile, no longer asks for "number or email", no longer says "Calls only", and its
//     "Calls only" branch is off; the call steps (A4-87 or B4-109, and S13-33) are off (C2);
//   - every change carries the tag of its correction, and the diff has a tag on every line.
//
// One applyTrade() takes about 0.6 s: 243 trades x 2 flows is the cost, so the files are sharded over 8 and live in the
// parity project (outside `npm test`; the glob is compiler/src/**/parity.shard-*.test.ts). Every trade is in exactly
// one shard; none is sampled out. The first shard also checks that there are 243 trades and that the 8 shards
// together are every trade id, once.
import { describe, expect, it } from "vitest";
import { loadMaster } from "../load/flow";
import { listTradeIds, loadTrade } from "../load/trade";
import { applyTrade, type AppliedStep } from "../overlay/apply";
import { applyCorrections, renderDiff, tagOf } from "./framework";

/** How many shard files there are. */
export const SHARDS = 8;

/** Every `shards`-th trade id, starting at `shard` (0-based), of the sorted list of all trade ids. */
export function shardOf(ids: readonly string[], shard: number, shards: number): string[] {
  return ids.filter((_, k) => k % shards === shard);
}

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

/** The tests of one shard (0-based): each of its trades applied to both flows, corrected, and checked. */
export function correctionsShard(shard: number): void {
  const all = listTradeIds();
  const ids = shardOf(all, shard, SHARDS);
  const master = loadMaster();

  describe(`all 243 trades x both flows, shard ${String(shard + 1)} of ${String(SHARDS)}`, () => {
    it("has trades", () => {
      expect(ids.length).toBeGreaterThan(0);
    });

    if (shard === 0) {
      it("has 243 trades, and the shards together are every trade id, once", () => {
        expect(all).toHaveLength(243);
        const union = Array.from({ length: SHARDS }, (_, k) => shardOf(all, k, SHARDS)).flat();
        expect(union).toHaveLength(all.length);
        expect([...union].sort()).toStrictEqual([...all].sort());
      });
    }

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
            lines.every((line) => new RegExp(`^(${done.corrections.map(tagOf).join("|")}) [-+] `).test(line)),
            where,
          ).toBe(true);
        }
      }, 300_000);
    }
  });
}
