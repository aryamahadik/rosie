// T-630's proofs for the journey 1 and 2 page calls (DL-867), on K-21 v1's own frozen schema and README:
//   - JOURNEY_1_2_PAGE_CALLS are the K-21 v1 calls T-665 (registration/ and staff/) and T-666 (ports/) serve, in K-21's
//     `$defs/callName` order, each one the page entry routes;
//   - each names the journey 1 and 2 Tool API call (and step) K-21's README "Served by" names for it, and each of those has
//     its entry in the Tool API's journey 1 and 2 registry;
//   - each handler refuses until its task builds it: it rejects with the page entry's PageNotConnectedError naming its
//     call, before it reads the request.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PAGE_CALLS } from "../../../../runtime/src/gateway/pages/calls";
import { PageNotConnectedError } from "../../../../runtime/src/gateway/pages/entry";
import type { PageRequest } from "../../../../runtime/src/gateway/pages/types";
import { JOURNEY_1_2_LANES } from "../../tool-api/journey-1";
import { CONTRACTS_DIR } from "../../tool-api/validator";
import { JOURNEY_1_2_PAGE_CALLS, journey12PageHandlers } from "./index";

/** K-21 v1's calls, in its `$defs/callName` order. */
function k21Calls(): string[] {
  const file = path.join(CONTRACTS_DIR, "page-api", "page-api.v1.schema.json");
  const schema = JSON.parse(readFileSync(file, "utf8")) as { $defs: { callName: { enum: string[] } } };
  return schema.$defs.callName.enum;
}

/** The "Served by" cell of K-21's README row for `call` (section "The calls"). */
function servedByCell(call: string): string {
  const readme = readFileSync(path.join(CONTRACTS_DIR, "page-api", "README.md"), "utf8").split("\n");
  const row = readme.find((line) => line.startsWith(`| \`${call}\``));
  if (row === undefined) throw new Error(`K-21's README has no row for ${call}`);
  return row.split("|")[3]?.trim() ?? "";
}

/** Each setup call, and saveSetupStep's each step, the Tool API's journey 1 and 2 registry holds an entry for. */
function registeredSetup(): Set<string> {
  const names = new Set<string>();
  for (const { folders } of JOURNEY_1_2_LANES) {
    for (const { entries } of folders) {
      for (const entry of entries)
        names.add(entry.call === "saveSetupStep" ? `saveSetupStep ${entry.step}` : entry.call);
    }
  }
  return names;
}

describe("the journey 1 and 2 page calls", () => {
  it("are the K-21 v1 calls T-665 and T-666 serve, in K-21's order, each one the page entry routes", () => {
    const calls = JOURNEY_1_2_PAGE_CALLS.map(({ call }) => call);
    expect(calls).toEqual(k21Calls().filter((call) => (calls as readonly string[]).includes(call)));
    expect(calls.every((call) => (PAGE_CALLS as readonly string[]).includes(call))).toBe(true);
    expect(Object.fromEntries(JOURNEY_1_2_PAGE_CALLS.map(({ call, folder }) => [call, folder]))).toEqual({
      readRegistration: "registration",
      answerOnPage: "registration",
      confirmOnPage: "registration",
      readStaffPage: "staff",
      signedUpload: "ports",
      finishUpload: "ports",
      stripeOnboardingStart: "ports",
      stripeOnboardingReturn: "ports",
      billCard: "ports",
      calendarConnectStart: "ports",
      calendarConnectReturn: "ports",
    });
  });

  it("each names the journey 1 and 2 call K-21's README serves it by, and that call (and step) has its registry entry", () => {
    const registered = registeredSetup();
    for (const { call, servedBy } of JOURNEY_1_2_PAGE_CALLS) {
      const cell = servedByCell(call);
      if (servedBy === null) {
        expect(cell, call).not.toMatch(/`(readSetup|saveSetupStep|matchKinds|lookupListing)`/u);
        continue;
      }
      expect(cell, call).toContain(`K-09 v1 \`${servedBy.call}\``);
      if (servedBy.step === null) {
        expect(cell, call).not.toMatch(/ for S\d-\d\d/u);
        expect(registered.has(servedBy.call) || servedBy.call === "saveSetupStep", call).toBe(true);
      } else {
        expect(cell, call).toContain(`for ${servedBy.step}`);
        expect(registered.has(`saveSetupStep ${servedBy.step}`), call).toBe(true);
      }
    }
  });

  it("each handler rejects with PageNotConnectedError naming its call, before it reads the request", async () => {
    const handlers = journey12PageHandlers();
    expect(Object.keys(handlers)).toEqual(JOURNEY_1_2_PAGE_CALLS.map(({ call }) => call));
    for (const { call } of JOURNEY_1_2_PAGE_CALLS) {
      const touched: string[] = [];
      const page = new Proxy(
        {},
        {
          get(_target, key) {
            touched.push(String(key));
            return undefined;
          },
        },
      ) as PageRequest;
      const settled = handlers[call](page);
      await expect(settled, call).rejects.toBeInstanceOf(PageNotConnectedError);
      await expect(settled, call).rejects.toMatchObject({ name: "PageNotConnectedError", call });
      expect(touched, call).toEqual([]);
    }
  });
});
