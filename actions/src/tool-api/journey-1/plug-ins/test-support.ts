// Doubles for S1-11's writer's tests (T-634 part 1). Never imported by the Worker. Neither double stands in for the code
// under test: the bundles port hands the writer bundle v1's own trade overlays (bundles/v1, T-1460: every trade's
// compiled overlay, MC C5 applied at build time), and the stand-in for S1-02's writer (T-633's) gives picks as K-24's
// seed names Sam's kinds. Values come only from the contracts' fixtures and bundle v1 (the master's sample cast; rule 9).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { StateWrite } from "../../../commit/types";
import type { BundleIdOf, StepRows, StepWriter } from "../../../commit/walk";
import { bundleV1Id, type WalkTestRepo } from "../../../commit/walk/test-support";
import { copy } from "../../../gate/framework/test-support";
import { contractFile } from "../../test-support";
import { CONTRACTS_DIR } from "../../validator";
import type { PlugInBundles } from "./writer";

/** bundles/v1/bundle/trade/: bundle v1's trade overlays, one file per trade (K-01 v1 tradeOverlay). */
const TRADES_V1 = path.join(CONTRACTS_DIR, "..", "bundles", "v1", "bundle", "trade");

/** Every trade bundle v1 holds an overlay for, by id, in file order. */
export function tradesV1(): string[] {
  return readdirSync(TRADES_V1)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

/** One trade's overlay in bundle v1, freshly parsed (a test may change its copy). */
export function overlayV1(trade: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(TRADES_V1, `${trade}.json`), "utf8")) as Record<string, unknown>;
}

/** One read of the trade port: the bundle and the trade asked for. */
export interface TradeRead {
  readonly bundleId: BundleIdOf;
  readonly tradeId: string;
}

export interface TradesDouble {
  readonly bundles: PlugInBundles;
  /** Every read, in order. */
  readonly reads: TradeRead[];
}

/**
 * The trade port over bundle v1: the overlay of the trade asked for when the bundle id is bundle v1's and it holds that
 * trade (or `overlays`' own, given in its place), else null. Each read hands over a fresh copy and is written down.
 */
export function tradesOverV1(overlays: Readonly<Record<string, unknown>> = {}): TradesDouble {
  const pin = bundleV1Id();
  const held = new Set(tradesV1());
  const reads: TradeRead[] = [];
  return {
    reads,
    bundles: {
      trade(bundleId, tradeId) {
        reads.push({ bundleId: copy(bundleId), tradeId });
        if (bundleId.hash !== pin.hash || bundleId.build !== pin.build) return Promise.resolve(null);
        if (Object.hasOwn(overlays, tradeId)) return Promise.resolve(copy(overlays[tradeId] ?? null));
        return Promise.resolve(held.has(tradeId) ? overlayV1(tradeId) : null);
      },
    },
  };
}

/** One pick as a stand-in for S1-02's writer gives it: what it became and its kind. */
export interface StandInPick {
  readonly words: string;
  readonly outcome: "listed" | "new_work" | "not_booked";
  readonly kindId: string | null;
}

/** K-24's seed-business-kinds.json's picked kinds: Sam's "Barbershop, plumbing, electrical" as three listed picks. */
export function samSeedPicks(): StandInPick[] {
  const seed = contractFile("db-schema/kinds-of-work/fixtures/seed-business-kinds.json") as {
    rows: { table: string; values: Record<string, unknown> }[];
  };
  return seed.rows
    .filter((row) => row.table === "picked_kinds")
    .map(({ values }) => ({
      words: String(values.words),
      outcome: "listed",
      kindId: typeof values.kind_id === "string" ? values.kind_id : null,
    }));
}

/**
 * A stand-in for S1-02's writer (T-633's, which runs the matcher over the catalog): one K-24 picked_kinds insert per
 * pick in `picks`, in order, named by the walk's row ids (default 131, kind "pick"), owned by the call's person, of the
 * business `businessId` (null: not placed yet, K-24 README), giving kinds. It reads nothing.
 */
export function picksWriter(
  picks: readonly StandInPick[] = samSeedPicks(),
  businessId: string | null = null,
): StepWriter<WalkTestRepo> {
  return (call) => {
    const { request } = call.writer.turn;
    const state = picks.map((pick, index): StateWrite => ({
      op: "insert",
      table: "picked_kinds",
      values: {
        id: call.writer.rowId("pick"),
        owner_person_id: request.caller.personId,
        position: index + 1,
        words: pick.words,
        outcome: pick.outcome,
        kind_id: pick.kindId,
        business_id: businessId,
        picked_at: request.now,
      },
    }));
    const rows: StepRows = { state, stateEvents: [], gives: ["kinds"], asks: [], messages: [] };
    return Promise.resolve(rows);
  };
}
