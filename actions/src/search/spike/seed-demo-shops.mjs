#!/usr/bin/env node
// T-739 spike only, not product code: seeds the demo-shop sets the search spike measures on into one schema of its own
// on the local Docker database, in the order db/seeds/journey-states.int.test.ts seeds them (core, setup, kinds,
// services and rules, staff, availability, customers), then the map points (T-726) and the journey states (T-728, the
// reservations). setup-business takes a wrapping key, which the seed runner cannot hand it, so every set runs here as a
// function; the key is random bytes made for this run, in memory only, never written or printed.
//
//   DB_SCHEMA=spike_t739 npm run migrate
//   DB_SCHEMA=spike_t739 node actions/src/search/spike/seed-demo-shops.mjs
//
// Refuses any schema not named spike_<...> and any database but the local one, so public is never seeded.
import { registerHooks } from "node:module";
import postgres from "postgres";

const LOCAL_DATABASE_URL = "postgres://rosie:rosie@127.0.0.1:54329/rosie";
const SPIKE_SCHEMA = /^spike_[a-z0-9_]{1,40}$/;

// db/ imports its neighbours without an extension; complete a relative import from a .ts file as db/seeds/run.mjs does.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const parent = context.parentURL ?? "";
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (!relative || !parent.startsWith("file:") || !parent.endsWith(".ts")) throw error;
      for (const suffix of [".ts", "/index.ts"]) {
        try {
          return nextResolve(`${specifier}${suffix}`, context);
        } catch {
          // not this form: try the next one
        }
      }
      throw error;
    }
  },
});

const schema = process.env.DB_SCHEMA ?? "";
if (!SPIKE_SCHEMA.test(schema)) {
  console.error("seed-demo-shops: DB_SCHEMA must name a spike_<...> schema; nothing was written");
  process.exit(2);
}
if (process.env.DATABASE_URL !== undefined || process.env.CI !== undefined) {
  console.error(
    "seed-demo-shops: the local Docker database only (unset DATABASE_URL and CI); nothing was written",
  );
  process.exit(2);
}

const { seedCore } = await import("../../../../db/seeds/core.ts");
const { seedSetupBusiness } = await import("../../../../db/seeds/setup-business.ts");
const { seedKinds } = await import("../../../../db/seeds/kinds.ts");
const { seedSetupServicesRules } = await import("../../../../db/seeds/setup-services-rules.ts");
const { seedSetupStaff } = await import("../../../../db/seeds/setup-staff.ts");
const { seedSetupAvailability } = await import("../../../../db/seeds/setup-availability.ts");
const { seedCustomers } = await import("../../../../db/seeds/customers.ts");
const { seedSetupPoints } = await import("../../../../db/seeds/setup-points.ts");
const { seedJourneyStates } = await import("../../../../db/seeds/journey-states.ts");
const { DEFAULT_WRAPPING_KEY_NAME } = await import("../../../../db/repo/sealing.ts");

const wrapBytes = crypto.getRandomValues(new Uint8Array(32));
const wrappingKeys = {
  resolve: (name) => (name === DEFAULT_WRAPPING_KEY_NAME ? wrapBytes : undefined),
};

const sql = postgres(LOCAL_DATABASE_URL, {
  max: 1,
  connect_timeout: 15,
  onnotice: () => undefined,
  connection: { application_name: "t739-spike-seed", search_path: `${schema}, public` },
});

const steps = [
  ["core", () => seedCore(sql)],
  ["setup-business", () => seedSetupBusiness(sql, { wrappingKeys })],
  ["kinds", () => seedKinds(sql)],
  ["setup-services-rules", () => seedSetupServicesRules(sql)],
  ["setup-staff", () => seedSetupStaff(sql)],
  ["setup-availability", () => seedSetupAvailability(sql)],
  ["customers", () => seedCustomers(sql)],
  ["setup-points", () => seedSetupPoints(sql)],
  ["journey-states", () => seedJourneyStates(sql)],
];

try {
  const [where] = await sql`select current_schema() as current`;
  if (where.current !== schema) {
    throw new Error(`schema ${schema} is missing: run DB_SCHEMA=${schema} npm run migrate first`);
  }
  for (const [name, run] of steps) {
    const started = performance.now();
    await run();
    console.log(`seed-demo-shops: ${name} (${String(Math.round(performance.now() - started))} ms)`);
  }
  console.log(`seed-demo-shops: done, schema ${schema}`);
} catch (error) {
  console.error(`seed-demo-shops: failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
