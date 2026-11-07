// The loader of fixture set v1 (T-007; C-028, C-147): reads fixtures/v1/test-kit/ into typed demo shops and
// scenario inputs for the scenario tests.
//
//  - It runs `node fixtures/v1/tools/verify.mjs` first and refuses to read anything when that fails (a changed
//    byte, a missing or an extra file): the data is only handed out for a folder that matches MANIFEST.sha256.
//  - It reads only inside the fixtures/v1 folder (FixtureReader). Test data never comes from the handover's own
//    forms/ or test-kit/ (rule 9).
//  - The scenario lines that KNOWN-STALE.md marks stale come back flagged, and are left out of
//    `assertableScenarios`: C9 wins in tests (Q-36).

import { execFileSync } from "node:child_process";

import { parseKnownStale } from "./known-stale";
import { FIXTURES_V1_ROOT, FixtureReader, FixtureSetError, VERIFY_SCRIPT } from "./reader";
import { parseScenarios } from "./scenarios";
import { loadShops } from "./shops";
import type { Coverage, DemoShopRecord, FixtureSetV1, Scenario } from "./types";

export interface LoadOptions {
  /** A copy of fixtures/v1 to load instead of the committed folder (the tests use a temporary copy). */
  root?: string;
}

/** Runs the committed verify.mjs against `root`. Returns what it printed; throws FixtureSetError when it fails. */
export function verifyFixtureSet(root: string): string {
  try {
    return execFileSync(process.execPath, [VERIFY_SCRIPT, "--root", root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: string; stderr?: string };
    const output = `${failed.stdout ?? ""}${failed.stderr ?? ""}`.trim();
    throw new FixtureSetError(
      `fixture set v1 is not loaded: verify.mjs failed (exit ${String(failed.status ?? "unknown")}):\n${output}`,
    );
  }
}

function parseCoverage(text: string): Coverage {
  const raw = JSON.parse(text) as Partial<Coverage>;
  const keys = ["used", "missing", "types", "switches", "facts", "mixed", "flagged"] as const;
  for (const key of keys) {
    if (raw[key] === undefined) throw new FixtureSetError(`test-kit/coverage.json has no "${key}"`);
  }
  return raw as Coverage;
}

/** Loads fixture set v1. Throws FixtureSetError, and reads nothing, when verify.mjs fails. */
export function loadFixtureSetV1(options: LoadOptions = {}): FixtureSetV1 {
  const reader = new FixtureReader(options.root ?? FIXTURES_V1_ROOT);
  const verifyOutput = verifyFixtureSet(reader.root);

  const { staleNotes, knownGaps } = parseKnownStale(reader.readText("KNOWN-STALE.md"));
  const parsed = parseScenarios(reader.readText("test-kit/SCENARIOS.md"), staleNotes);
  const coverage = parseCoverage(reader.readText("test-kit/coverage.json"));
  const shops = loadShops(reader);

  const byId = new Map<string, DemoShopRecord>(shops.map((record) => [record.id, record]));
  const shop = (id: string): DemoShopRecord => {
    const record = byId.get(id);
    if (record === undefined) throw new FixtureSetError(`no demo shop "${id}" in fixture set v1`);
    return record;
  };

  // A money-combo scenario must run on a service the named shop really has.
  for (const scenario of parsed.moneyCombos) {
    const services = shop(scenario.shopId).shop.flows[scenario.flow]?.services ?? [];
    if (!services.some((s) => s.combo === scenario.combo && s.name === scenario.serviceName)) {
      throw new FixtureSetError(
        `SCENARIOS.md line ${String(scenario.line)}: shop ${scenario.shopId} has no "${scenario.serviceName}" with ${scenario.combo} in flow ${scenario.flow}`,
      );
    }
  }

  const scenarios: Scenario[] = [...parsed.moneyCombos, ...parsed.crossCutting];
  return {
    root: reader.root,
    verifyOutput,
    shops,
    tradeShops: shops.filter((record) => record.kind === "trade"),
    mixedShops: shops.filter((record) => record.kind === "mixed"),
    shop,
    moneyComboScenarios: parsed.moneyCombos,
    crossCuttingScenarios: parsed.crossCutting,
    scenarios,
    assertableScenarios: scenarios.filter((scenario) => scenario.stale === null),
    staleScenarios: parsed.crossCutting.filter((scenario) => scenario.stale !== null),
    staleNotes,
    knownGaps,
    coverage,
    reads: reader.reads,
  };
}
