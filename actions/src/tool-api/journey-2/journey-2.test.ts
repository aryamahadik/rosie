// T-630's proofs for journey 2's folders (DL-867), on K-09's own frozen fixtures and the base's recording scope, never a
// database:
//   - journey 2's folders are its call tasks' (T-657 to T-664), each with its index.ts, as JOURNEY_2_LANE lists them, and
//     JOURNEY_2_LANE is the second of the registry's lanes (../journey-1 JOURNEY_1_2_LANES);
//   - they register exactly saveSetupStep's journey 2 steps of K-09 v1, each once;
//   - each unbuilt handler answers notBuilt and writes nothing: through the base its transaction is rolled back, nothing
//     read and no row noted, and the handler itself touches neither its request nor its context.
// The registry's own proofs (every call and step resolving, registration's refusals, the skeleton's handlers unchanged)
// are ../journey-1/journey-1.test.ts's. Values come only from the contracts' fixtures (rule 9).

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NotBuiltError } from "../errors";
import { JOURNEY_1_2_LANES, SETUP_STEPS, withSetupCalls, type SetupFolder } from "../journey-1";
import { acceptedExchanges, callerOf, recordingScope, traceFor, type RecordingRepo } from "../test-support";
import { createToolApi, notBuiltHandlers } from "../tool-api";
import { createToolApiValidator } from "../validator";
import * as addTeam from "./add-team";
import { JOURNEY_2_LANE } from "./index";
import * as join from "./join";
import * as joinLinks from "./join-links";
import * as licenses from "./licenses";
import * as onCall from "./on-call";
import * as skills from "./skills";
import * as staffPage from "./staff-page";
import * as takeBookings from "./take-bookings";

const validator = createToolApiValidator();

/** This folder, actions/src/tool-api/journey-2/. */
const JOURNEY_2_DIR = fileURLToPath(new URL(".", import.meta.url));

/** Journey 2's call tasks' folders, in the order of their tasks (T-657 to T-664), as each task's May touch names it. */
const JOURNEY_2_FOLDERS = [
  "add-team",
  "join-links",
  "join",
  "staff-page",
  "licenses",
  "skills",
  "on-call",
  "take-bookings",
];

/** Each journey 2 folder's module, by the folder's name. */
const FOLDER_MODULES: Record<string, { FOLDER: SetupFolder<unknown> }> = {
  "add-team": addTeam,
  "join-links": joinLinks,
  join,
  "staff-page": staffPage,
  licenses,
  skills,
  "on-call": onCall,
  "take-bookings": takeBookings,
};

/** The step a journey 2 entry saves (each is saveSetupStep's), or its call when it is no saveSetupStep entry. */
function stepsOf(folder: SetupFolder<unknown>): string[] {
  return folder.entries.map((entry) => (entry.call === "saveSetupStep" ? entry.step : entry.call));
}

/** Every accepted K-09 v1 exchange that saves a journey 2 step. */
const J2_EXCHANGES = acceptedExchanges().filter(
  ({ exchange }) =>
    exchange.call === "saveSetupStep" &&
    String((exchange.request.step as { step?: unknown }).step).startsWith("S2-"),
);

describe("journey 2's folders", () => {
  it("are its call tasks' (T-657 to T-664), each with its index.ts, as JOURNEY_2_LANE lists them", () => {
    const folders = readdirSync(JOURNEY_2_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(folders).toEqual([...JOURNEY_2_FOLDERS].sort());
    expect(JOURNEY_2_LANE.lane).toBe("journey-2");
    expect(JOURNEY_2_LANE.folders.map(({ folder }) => folder)).toEqual(JOURNEY_2_FOLDERS);
    for (const folder of JOURNEY_2_LANE.folders) {
      expect(existsSync(path.join(JOURNEY_2_DIR, folder.folder, "index.ts")), folder.folder).toBe(true);
      expect(folder, folder.folder).toBe(FOLDER_MODULES[folder.folder]?.FOLDER);
    }
    expect(JOURNEY_1_2_LANES[1]).toBe(JOURNEY_2_LANE);
  });

  it("register exactly saveSetupStep's journey 2 steps of K-09 v1, each once", () => {
    const steps = JOURNEY_2_LANE.folders.flatMap((folder) => stepsOf(folder));
    expect(new Set(steps).size).toBe(steps.length);
    expect([...steps].sort()).toEqual(SETUP_STEPS.filter((step) => step.startsWith("S2-")).sort());
    expect(
      Object.fromEntries(JOURNEY_2_LANE.folders.map((folder) => [folder.folder, stepsOf(folder)])),
    ).toEqual({
      "add-team": ["S2-02"],
      "join-links": [],
      join: ["S2-05"],
      "staff-page": ["S2-06"],
      licenses: ["S2-11", "S2-29"],
      skills: ["S2-15"],
      "on-call": ["S2-27", "S2-31"],
      "take-bookings": ["S2-24"],
    });
  });
});

describe("each unbuilt journey 2 handler answers notBuilt and writes nothing", () => {
  it("K-09 v1 holds 8 accepted exchanges that save a journey 2 step, each caller naming a business", () => {
    expect(J2_EXCHANGES.map(({ file }) => file)).toHaveLength(8);
    for (const { file, exchange } of J2_EXCHANGES) {
      expect(typeof callerOf(exchange.request)?.businessId, file).toBe("string");
    }
  });

  for (const { file, exchange } of J2_EXCHANGES) {
    it(`${file}: saveSetupStep answers notBuilt inside its scope, rolled back, nothing read and no row noted`, async () => {
      const businessId = callerOf(exchange.request)?.businessId as string;
      const scope = recordingScope();
      const api = createToolApi<RecordingRepo>({
        validator,
        scope,
        handlers: withSetupCalls(notBuiltHandlers()),
      });
      const { trace, spans } = traceFor(exchange.request);
      const answered = await api.call(exchange.call, structuredClone(exchange.request), trace);
      expect(answered).toEqual({ error: "notBuilt", call: "saveSetupStep" });
      expect(scope.events).toEqual([{ what: "begin" }, { what: "scope", businessId }, { what: "rollback" }]);
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({ outcome: "refused", error_code: "notBuilt" });
      expect(spans[0]?.rows).toBeUndefined();
    });
  }

  it("each journey 2 handler itself rejects with NotBuiltError naming saveSetupStep, and touches neither its request nor its context", async () => {
    for (const { folder, entries } of JOURNEY_2_LANE.folders) {
      for (const entry of entries) {
        const touched: string[] = [];
        const watched = (what: string): object =>
          new Proxy(
            {},
            {
              get(_target, key) {
                touched.push(`${what}.${String(key)}`);
                return undefined;
              },
            },
          );
        const handler = entry.handler as unknown as (request: unknown, context: unknown) => Promise<unknown>;
        const settled = handler(watched("request"), watched("context"));
        await expect(settled, folder).rejects.toBeInstanceOf(NotBuiltError);
        await expect(settled, folder).rejects.toMatchObject({ call: "saveSetupStep" });
        expect(touched, folder).toEqual([]);
      }
    }
  });
});
