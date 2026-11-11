// T-261 (C-128): the capability check's 10-minute cache, run by `npm run test:unit -- runtime/src/formats`. Arch 07
// line 365: "else Linq's capability check, cached 10 minutes, or text alone if it fails"; K-11 v1 capabilityCheck: "the
// caller caches it for 10 minutes" (cacheSeconds 600). The check is answered by K-11's fixture capability.json and by
// the Linq double (C-211), since no Linq line serves the new build yet (J-08). Numbers are K-04 v1's seed phones, the
// fictional 555-01xx (rule 9); the clock is a fake one, started at capability.json's own moment.
import { createLinqDouble } from "@rosie/adapters/linq/double";
import capabilityFixture from "@rosie/contracts/port-linq/fixtures/capability.json";
import { describe, expect, it } from "vitest";

import { CAPABILITY_CACHE_MS, CapabilityCache } from "./capability";
import { AVERY, RILEY, TOMAS, fakeClock, fixturePort } from "./test-support";
import type { CapabilityAnswer, CapabilityCheckPort } from "./types";

/** A port whose one answer the test gives when it chooses, to hold a check out. */
function heldPort(): {
  port: CapabilityCheckPort;
  asked: string[];
  answer: (outcome: CapabilityAnswer) => void;
} {
  const asked: string[] = [];
  let give: ((outcome: CapabilityAnswer) => void) | undefined;
  return {
    asked,
    answer: (outcome) => {
      give?.(outcome);
    },
    port: {
      capabilityCheck: ({ phone }) => {
        asked.push(phone);
        return new Promise<CapabilityAnswer>((resolve) => {
          give = resolve;
        });
      },
    },
  };
}

const IMESSAGE = { result: "checked", imessage: true, service: "imessage", cached: false } as const;

/** One call of the port, as a test writes it. */
type Check = (request: { readonly phone: string }) => CapabilityAnswer | PromiseLike<CapabilityAnswer>;

describe("the capability check's cache (arch 07 line 365; K-11 v1 capabilityCheck)", () => {
  it("keeps capability.json's answer for Tomás's number: RCS, no iMessage, for K-11's cacheSeconds", async () => {
    const clock = fakeClock();
    const { port, asked } = fixturePort();
    const cache = new CapabilityCache(port, { now: clock.now });
    expect(capabilityFixture.request.phone).toBe(TOMAS);

    await expect(cache.lookup(TOMAS)).resolves.toEqual({
      result: "checked",
      imessage: false,
      service: "rcs",
      cached: false,
    });
    expect(asked).toEqual([TOMAS]);
    // The fixture's cacheSeconds is the 10 minutes the cache keeps it.
    expect(capabilityFixture.outcome.cacheSeconds * 1000).toBe(CAPABILITY_CACHE_MS);
    expect(CAPABILITY_CACHE_MS).toBe(10 * 60 * 1000);
  });

  it("a second lookup inside 10 minutes uses the cache: Linq is asked once", async () => {
    const clock = fakeClock();
    const linq = createLinqDouble();
    const cache = new CapabilityCache(linq, { now: clock.now });

    await expect(cache.lookup(RILEY)).resolves.toEqual(IMESSAGE);
    clock.advance(5 * 60 * 1000);
    await expect(cache.lookup(RILEY)).resolves.toEqual({ ...IMESSAGE, cached: true });
    clock.advance(CAPABILITY_CACHE_MS - 5 * 60 * 1000 - 1);
    await expect(cache.lookup(RILEY)).resolves.toEqual({ ...IMESSAGE, cached: true });

    expect(linq.capabilityCheckRequests()).toEqual([RILEY]);
  });

  it("at 10 minutes the answer is old: the next lookup asks Linq again and keeps the new answer", async () => {
    const clock = fakeClock();
    const linq = createLinqDouble();
    const cache = new CapabilityCache(linq, { now: clock.now });

    await cache.lookup(RILEY);
    clock.advance(CAPABILITY_CACHE_MS);
    // The phone moved to Android in the meantime: the new answer is RCS.
    linq.setCapability(RILEY, { result: "checked", imessage: false, service: "rcs" });
    await expect(cache.lookup(RILEY)).resolves.toEqual({
      result: "checked",
      imessage: false,
      service: "rcs",
      cached: false,
    });
    await expect(cache.lookup(RILEY)).resolves.toEqual({
      result: "checked",
      imessage: false,
      service: "rcs",
      cached: true,
    });

    expect(linq.capabilityCheckRequests()).toEqual([RILEY, RILEY]);
  });

  it("keeps each number's own answer", async () => {
    const clock = fakeClock();
    const linq = createLinqDouble();
    linq.setCapability(TOMAS, { result: "checked", imessage: false, service: "rcs" });
    const cache = new CapabilityCache(linq, { now: clock.now });

    await cache.lookup(RILEY);
    await cache.lookup(TOMAS);
    await expect(cache.lookup(RILEY)).resolves.toEqual({ ...IMESSAGE, cached: true });
    await expect(cache.lookup(TOMAS)).resolves.toEqual({
      result: "checked",
      imessage: false,
      service: "rcs",
      cached: true,
    });

    expect(linq.capabilityCheckRequests()).toEqual([RILEY, TOMAS]);
  });

  it("a failed check is no answer: it says failed, keeps nothing, and the next lookup asks again", async () => {
    const clock = fakeClock();
    const linq = createLinqDouble();
    linq.setCapability(RILEY, { result: "failed", code: "1007", reason: "Rate limit." });
    const cache = new CapabilityCache(linq, { now: clock.now });

    await expect(cache.lookup(RILEY)).resolves.toEqual({ result: "failed", cached: false });
    expect(cache.size).toBe(0);
    await expect(cache.lookup(RILEY)).resolves.toEqual({ result: "failed", cached: false });

    expect(linq.capabilityCheckRequests()).toEqual([RILEY, RILEY]);
  });

  it.each<[string, Check]>([
    [
      "a call that throws",
      () => {
        throw new Error("network down");
      },
    ],
    ["a call that rejects", () => Promise.reject(new Error("network down"))],
    [
      "another number's answer",
      () => ({
        result: "checked",
        phone: TOMAS,
        imessage: true,
        service: "imessage",
        checkedAt: capabilityFixture.given.now,
        cacheSeconds: 600,
      }),
    ],
    [
      "a service K-11 does not name",
      ({ phone }) =>
        ({
          result: "checked",
          phone,
          imessage: false,
          service: "whatsapp",
          checkedAt: capabilityFixture.given.now,
          cacheSeconds: 600,
        }) as unknown as CapabilityAnswer,
    ],
    [
      "no iMessage flag",
      ({ phone }) =>
        ({
          result: "checked",
          phone,
          service: "imessage",
          checkedAt: capabilityFixture.given.now,
          cacheSeconds: 600,
        }) as unknown as CapabilityAnswer,
    ],
    ["no answer at all", () => null as unknown as CapabilityAnswer],
  ])("%s is no answer: failed, never thrown, and nothing kept", async (_name, capabilityCheck) => {
    const asked: string[] = [];
    const cache = new CapabilityCache(
      {
        capabilityCheck: (request) => {
          asked.push(request.phone);
          return capabilityCheck(request);
        },
      },
      { now: fakeClock().now },
    );

    await expect(cache.lookup(RILEY)).resolves.toEqual({ result: "failed", cached: false });
    await expect(cache.lookup(RILEY)).resolves.toEqual({ result: "failed", cached: false });
    expect(asked).toEqual([RILEY, RILEY]);
    expect(cache.size).toBe(0);
  });

  it("lookups made while a check is out share it: Linq is asked once", async () => {
    const held = heldPort();
    const cache = new CapabilityCache(held.port, { now: fakeClock().now });

    const first = cache.lookup(RILEY);
    const second = cache.lookup(RILEY);
    expect(held.asked).toEqual([RILEY]);
    held.answer({
      result: "checked",
      phone: RILEY,
      imessage: true,
      service: "imessage",
      checkedAt: capabilityFixture.given.now,
      cacheSeconds: 600,
    });

    await expect(first).resolves.toEqual(IMESSAGE);
    await expect(second).resolves.toEqual({ ...IMESSAGE, cached: true });
    await expect(cache.lookup(RILEY)).resolves.toEqual({ ...IMESSAGE, cached: true });
    expect(held.asked).toEqual([RILEY]);
  });

  it("a check out that fails fails every lookup sharing it, and the next lookup asks again", async () => {
    const held = heldPort();
    const cache = new CapabilityCache(held.port, { now: fakeClock().now });

    const first = cache.lookup(RILEY);
    const second = cache.lookup(RILEY);
    held.answer({ result: "failed", phone: RILEY, code: null, reason: "The check failed." });

    await expect(first).resolves.toEqual({ result: "failed", cached: false });
    await expect(second).resolves.toEqual({ result: "failed", cached: true });
    expect(cache.size).toBe(0);
    const third = cache.lookup(RILEY);
    expect(held.asked).toEqual([RILEY, RILEY]);
    held.answer({ result: "failed", phone: RILEY, code: null, reason: "The check failed." });
    await expect(third).resolves.toEqual({ result: "failed", cached: false });
  });

  it("drops answers 10 minutes old as lookups come, so it holds only live answers", async () => {
    const clock = fakeClock();
    const linq = createLinqDouble();
    const cache = new CapabilityCache(linq, { now: clock.now });

    await cache.lookup(RILEY);
    clock.advance(60 * 1000);
    await cache.lookup(TOMAS);
    expect(cache.size).toBe(2);

    // Riley's answer is 10 minutes old, Tomás's 9: a lookup for another number drops Riley's alone.
    clock.advance(CAPABILITY_CACHE_MS - 60 * 1000);
    await cache.lookup(AVERY);
    expect(cache.size).toBe(2);
    await expect(cache.lookup(TOMAS)).resolves.toEqual({ ...IMESSAGE, cached: true });

    clock.advance(CAPABILITY_CACHE_MS);
    await cache.lookup(RILEY);
    expect(cache.size).toBe(1);
  });
});
