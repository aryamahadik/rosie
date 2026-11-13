// T-1022 inside the Workers runtime (workerd): the prebuilt validators (`npm run build:validators`) hold K-09 v1's
// definitions alone, none of a lane's, so there the validator gives no lane checks and registering J5_LANE is refused
// (LaneRegistrationError): no lane call can run unvalidated inside the Worker, until infra/build/tool-api-validators.mjs
// builds a lane's definitions too. A base with no lane is made there as before.

import { describe, expect, it } from "vitest";

import type { BusinessScope } from "../scope";
import { LaneRegistrationError, createToolApi, notBuiltHandlers } from "../tool-api";
import { RUNS_IN_WORKERD, createToolApiValidator } from "../validator";
import { J5_LANE, J5_VERSION } from "./index";

/** A scope no call here reaches: registration is refused before any call. */
const scope: BusinessScope<unknown> = {
  withBusiness: () => Promise.reject(new Error("no call reaches the scope")),
};

describe("inside workerd, no lane is registered: the prebuilt code holds no lane's definitions", () => {
  it("runs in the Workers runtime, and validator.ts knows it", () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
    expect(RUNS_IN_WORKERD).toBe(true);
  });

  it("the validator gives no checks for any journey 5 call", () => {
    const validator = createToolApiValidator();
    for (const { call } of J5_LANE.calls) {
      expect(() => validator.laneChecks(J5_VERSION, call), call).toThrow("hold no lane's definitions");
    }
  });

  it("registering J5_LANE is refused, so no base answers a lane call unvalidated; with no lane the base is made", () => {
    const validator = createToolApiValidator();
    let refused: unknown;
    try {
      createToolApi({ validator, scope, handlers: notBuiltHandlers(), lanes: [J5_LANE] });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(LaneRegistrationError);
    expect(refused).toMatchObject({ lane: "j5", call: "showMoneyBefore", why: "version" });
    expect(() => createToolApi({ validator, scope, handlers: notBuiltHandlers() })).not.toThrow();
  });
});
