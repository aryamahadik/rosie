// Question 2: can a test fire a Durable Object alarm on demand? (T-1128)
// Answer shown here: yes. runDurableObjectAlarm(stub) runs the actor's alarm() now, whatever time it was set for, and
// removes it. The real clock does not move, so no waiting and no fake timers.
import { evictDurableObject, reset, runDurableObjectAlarm } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { actors, publishSpikeActorAsHandleActor } from "./spike-actor";

const TEN_MINUTES = 10 * 60 * 1000;

let restoreMain: () => void;
beforeAll(() => {
  restoreMain = publishSpikeActorAsHandleActor();
});
afterAll(() => {
  restoreMain();
});
afterEach(async () => {
  await reset();
});

describe("a Durable Object alarm set for 10 minutes", () => {
  it("fires in the test without waiting, once, and is then gone", async () => {
    const actor = actors().get(actors().idFromName("handle-alarm"));
    const before = Date.now();
    const at = await actor.scheduleIn(TEN_MINUTES);
    expect(at).toBeGreaterThanOrEqual(before + TEN_MINUTES);
    expect(await actor.alarmAt()).toBe(at);
    expect((await actor.counter()).alarms).toBe(0);

    const ran = await runDurableObjectAlarm(actor);

    expect(ran).toBe(true);
    expect(Date.now() - before).toBeLessThan(TEN_MINUTES / 100);
    expect((await actor.counter()).alarms).toBe(1);
    expect(await actor.alarmAt()).toBeNull();
    expect(await runDurableObjectAlarm(actor)).toBe(false);
    expect((await actor.counter()).alarms).toBe(1);
  });

  it("returns false when no alarm is set", async () => {
    const actor = actors().get(actors().idFromName("handle-no-alarm"));

    expect(await runDurableObjectAlarm(actor)).toBe(false);
    expect((await actor.counter()).alarms).toBe(0);
  });

  it("is kept when the actor is evicted, and still fires", async () => {
    const actor = actors().get(actors().idFromName("handle-evicted"));
    const at = await actor.scheduleIn(TEN_MINUTES);

    await evictDurableObject(actor);

    expect(await actor.alarmAt()).toBe(at);
    expect(await runDurableObjectAlarm(actor)).toBe(true);
    expect((await actor.counter()).alarms).toBe(1);
  });

  it("is replaced, not added to, when the actor sets a new one (one alarm per actor)", async () => {
    const actor = actors().get(actors().idFromName("handle-one-alarm"));
    await actor.scheduleIn(TEN_MINUTES);
    const later = await actor.scheduleIn(15 * 60 * 1000);

    expect(await actor.alarmAt()).toBe(later);
    expect(await runDurableObjectAlarm(actor)).toBe(true);
    expect(await runDurableObjectAlarm(actor)).toBe(false);
  });

  it("is removed by reset(), so one test's alarm does not reach the next", async () => {
    const actor = actors().get(actors().idFromName("handle-reset"));
    await actor.scheduleIn(TEN_MINUTES);

    await reset();

    // A stub taken before reset() is dead ("Application called deleteAllDurableObjects()"): get a new one.
    const fresh = actors().get(actors().idFromName("handle-reset"));
    expect(await fresh.alarmAt()).toBeNull();
    expect(await runDurableObjectAlarm(fresh)).toBe(false);
  });
});
