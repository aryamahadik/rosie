// Reads fixtures/v1/test-kit/shops/*.json into typed demo shops. The files are checked for the fields a scenario
// needs (id equal to the file name, flows with services that carry a money way); a file that is not in that shape
// is an error. Nothing is filled in or repaired: a field the file leaves empty stays empty (see KNOWN-STALE.md).

import { FixtureSetError, type FixtureReader } from "./reader";
import type { DemoShop, DemoShopRecord, ShopKind } from "./types";

const SHOPS_DIR = "test-kit/shops";
const MIXED_IDS: readonly string[] = ["test-mixed-A", "test-mixed-B"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkShop(file: string, raw: unknown): DemoShop {
  const fail = (what: string): never => {
    throw new FixtureSetError(`${file}: ${what}`);
  };
  if (!isRecord(raw)) return fail("is not a JSON object");
  const id = file.slice(file.lastIndexOf("/") + 1, -".json".length);
  if (raw.id !== id) fail(`id is ${JSON.stringify(raw.id)}, not "${id}"`);
  for (const key of ["name", "booking_type", "pattern"]) {
    if (typeof raw[key] !== "string") fail(`"${key}" is not a text`);
  }
  if (!isRecord(raw.flows)) return fail('"flows" is not an object');
  const flowIds = Object.keys(raw.flows);
  if (flowIds.length === 0 || flowIds.some((flow) => flow !== "A" && flow !== "B")) {
    fail('"flows" must hold flow A, flow B or both');
  }
  for (const [flowId, flow] of Object.entries(raw.flows)) {
    if (!isRecord(flow) || !Array.isArray(flow.services) || flow.services.length === 0) {
      fail(`flow ${flowId} has no services`);
    }
    const services: unknown[] =
      isRecord(flow) && Array.isArray(flow.services) ? (flow.services as unknown[]) : [];
    for (const service of services) {
      const ok =
        isRecord(service) &&
        typeof service.combo === "string" &&
        typeof service.name === "string" &&
        typeof service.due_now_at_booking === "number";
      if (!ok) fail(`flow ${flowId} has a service without combo, name or due_now_at_booking`);
    }
  }
  if (
    raw.safety_stop !== undefined &&
    !(Array.isArray(raw.safety_stop) && raw.safety_stop.every((s) => typeof s === "string"))
  ) {
    fail('"safety_stop" is not a list of texts');
  }
  // The shape is checked above; the cast tells TypeScript what the checks proved.
  return raw as unknown as DemoShop;
}

/** The demo shops, sorted by file name. */
export function loadShops(reader: FixtureReader): DemoShopRecord[] {
  const files = reader.listDir(SHOPS_DIR).filter((name) => name.endsWith(".json"));
  const records = files.map((name): DemoShopRecord => {
    const file = `${SHOPS_DIR}/${name}`;
    let raw: unknown;
    try {
      raw = JSON.parse(reader.readText(file));
    } catch (error) {
      if (error instanceof FixtureSetError) throw error;
      throw new FixtureSetError(`${file}: not valid JSON`);
    }
    const shop = checkShop(file, raw);
    const stopWords = shop.safety_stop ?? [];
    const kind: ShopKind = MIXED_IDS.includes(shop.id) ? "mixed" : "trade";
    return { id: shop.id, kind, file, shop, stopWords, hasStopWords: stopWords.length > 0 };
  });
  for (const id of MIXED_IDS) {
    if (!records.some((record) => record.id === id))
      throw new FixtureSetError(`${SHOPS_DIR}/${id}.json is missing`);
  }
  return records;
}
