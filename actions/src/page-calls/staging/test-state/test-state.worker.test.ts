// T-574 inside the Workers runtime (workerd), where a later runtime card joins the listing call to the Worker's page
// entry. With the Worker's own ENVIRONMENT (wrangler.jsonc env.staging), test-roster.json gives its response from rows
// handed through the ports, and the K-21 request check, the token's sha256 and the listing make no code from strings
// (workerd refuses Function and eval when it serves a request; this pool's workerd does not, so the test traps both, as
// ../test-phone/test-phone.worker.test.ts does, and the trap counts no call). With ENVIRONMENT "production" the call
// answers stagingOnly and reaches nothing. Values come only from the contract's fixture (rule 9).

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import testRosterFixture from "../../../../../contracts/page-api/fixtures/test-roster.json";
import type { PageRequest } from "../../../../../runtime/src/gateway";
import { DEFAULT_BUNDLE_ID } from "../../../../../runtime/src/gateway/answer";
import { openTrace } from "../../../../../runtime/src/trace";
import { sha256Hex } from "../test-phone/ids";
import { createTestStateHandlers } from "./handlers";
import type { RosterFlow, RosterRole, TestStateCaller, TestStateDeps } from "./types";

const TOKEN = testRosterFixture.request.page.sessionToken;
const { businesses: BUSINESSES, phones: PHONES } = testRosterFixture.outcome;

const numberOf = (last4: string): string => `+1555555${last4}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Traps Function and eval until the test ends, as validator.worker.test.ts does: each call is counted, then made. */
function trapCodeFromStrings(): { readonly calls: string[] } {
  const calls: string[] = [];
  const realFunction = globalThis.Function;
  const realEval = globalThis.eval;
  vi.stubGlobal(
    "Function",
    new Proxy(realFunction, {
      construct(target, args, newTarget) {
        calls.push("new Function");
        return Reflect.construct(target, args, newTarget) as object;
      },
      apply(target, self, args) {
        calls.push("Function()");
        return Reflect.apply(target, self, args) as unknown;
      },
    }),
  );
  vi.stubGlobal(
    "eval",
    new Proxy(realEval, {
      apply(target, self, args) {
        calls.push("eval()");
        return Reflect.apply(target, self, args) as unknown;
      },
    }),
  );
  return { calls };
}

function page(environment: string): PageRequest {
  return {
    call: "testRoster",
    request: testRosterFixture.request,
    trace: openTrace({ openedBy: "pageRequest", bundleId: DEFAULT_BUNDLE_ID, incomingTraceId: null }),
    environment,
  };
}

/** The ports over test-roster.json's own values: its roster as config, and its rows as the data-access calls print them. */
async function fixtureDeps(callers: TestStateCaller[]): Promise<TestStateDeps> {
  const tester = await sha256Hex(TOKEN);
  const phoneAt = (number: string): (typeof PHONES)[number] | undefined =>
    PHONES.find((phone) => numberOf(phone.last4) === number);
  const businessAt = (businessId: string): (typeof BUSINESSES)[number] | undefined =>
    BUSINESSES.find((business) => business.businessId === businessId);
  const seen = <T>(caller: TestStateCaller, answer: T): Promise<T> => {
    callers.push(caller);
    return Promise.resolve(answer);
  };
  return {
    access: { standing: (hash) => Promise.resolve(hash === tester ? "tester" : "noSession") },
    roster: {
      listing: (caller) =>
        seen(caller, {
          businesses: BUSINESSES.map((business) => ({
            businessId: business.businessId,
            flow: business.flow as RosterFlow,
          })),
          phones: PHONES.map((phone) => ({
            testPhoneId: phone.testPhoneId,
            number: numberOf(phone.last4),
            role: phone.role as RosterRole,
            label: phone.label,
            businessId: phone.businessId,
          })),
        }),
    },
    seeded: {
      business(businessId, caller) {
        const business = businessAt(businessId);
        return seen(
          caller,
          business === undefined
            ? null
            : {
                id: business.businessId,
                name: business.name,
                status: business.live ? "live" : "saved",
                timeZone: business.zone,
                textHoursStart: `${business.textHours.start}:00`,
                textHoursEnd: `${business.textHours.end}:00`,
              },
        );
      },
      kindIds: (businessId, caller) => seen(caller, businessAt(businessId)?.kindIds ?? []),
      signedUp: (businessId, caller) => seen(caller, businessAt(businessId)?.signedUp === true),
      phone(number, caller) {
        const phone = phoneAt(number);
        return seen(
          caller,
          phone === undefined
            ? null
            : {
                stopped: phone.stopped,
                linqContactAddedAt: phone.linqContact ? "2026-10-19T14:00:00Z" : null,
              },
        );
      },
      textHoursOverride(number, caller) {
        const state = phoneAt(number)?.textHoursOverride;
        return seen(
          caller,
          state === undefined || state.version === null
            ? null
            : { enabled: state.on, version: state.version },
        );
      },
      person: (number, caller) => seen(caller, phoneAt(number)?.personId ?? null),
      customer(number, businessId, caller) {
        const phone = phoneAt(number);
        const customer = phone?.businessId === businessId ? phone.seededCustomer : null;
        return seen(caller, customer === null ? null : { id: customer.customerId, name: customer.name });
      },
    },
    now: () => Date.parse(testRosterFixture.given.now),
  };
}

describe("the listing call in workerd", () => {
  it("with the Worker's staging ENVIRONMENT, test-roster.json gives its response and makes no code from strings", async () => {
    expect(env.ENVIRONMENT).toBe("staging");
    const callers: TestStateCaller[] = [];
    const deps = await fixtureDeps(callers);
    const request = page(env.ENVIRONMENT);
    const trap = trapCodeFromStrings();

    const answer = await createTestStateHandlers(deps).testRoster(request);

    expect(answer).toEqual(testRosterFixture.outcome);
    expect(trap.calls).toEqual([]);
    // Every read's caller is the entry's own trace, never the envelope's page.traceId.
    expect(callers.length).toBeGreaterThan(0);
    for (const caller of callers)
      expect(caller).toEqual({ traceId: request.trace.traceId, at: testRosterFixture.given.now });
    expect(request.trace.traceId).not.toBe(testRosterFixture.request.page.traceId);
  });

  it("with ENVIRONMENT production the call answers stagingOnly and reaches nothing", async () => {
    const touched: string[] = [];
    const deps = new Proxy<Record<string, never>>(
      {},
      {
        get(_target, key) {
          touched.push(String(key));
          throw new Error("a port was reached");
        },
      },
    ) as unknown as TestStateDeps;

    expect(await createTestStateHandlers(deps).testRoster(page("production"))).toEqual({
      error: "stagingOnly",
    });
    expect(touched).toEqual([]);
  });
});
