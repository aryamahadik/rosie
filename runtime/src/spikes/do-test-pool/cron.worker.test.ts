// Question 4: can a test run a cron handler? (T-1128)
// Answer shown here: yes, by calling the handler's scheduled() with createScheduledController() and waiting for its
// waitUntil work with waitOnExecutionContext(). The plugin never fires wrangler.jsonc's "* * * * *" by itself, so
// a test chooses the cron string and the time. A sweep that sets an actor alarm can then be followed by
// runDurableObjectAlarm().
import {
  createExecutionContext,
  createScheduledController,
  reset,
  runDurableObjectAlarm,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { actors, publishSpikeActorAsHandleActor, spikeCronHandler } from "./spike-actor";

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

describe("a cron handler run by a test", () => {
  it("receives the cron string and time the test gives, and its waitUntil work is finished by waitOnExecutionContext", async () => {
    const scheduledTime = Date.UTC(2026, 10, 7, 12, 0, 0);
    const controller = createScheduledController({ scheduledTime, cron: "* * * * *" });
    const ctx = createExecutionContext();

    spikeCronHandler.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    const actor = actors().get(actors().idFromName("due-handle"));
    expect(await actor.read("swept-by")).toBe(`* * * * *@${String(scheduledTime)}`);
  });

  it("sets the due actor's alarm, which the test then fires on demand", async () => {
    const ctx = createExecutionContext();
    spikeCronHandler.scheduled(createScheduledController({ cron: "* * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);

    const actor = actors().get(actors().idFromName("due-handle"));
    expect(await actor.alarmAt()).not.toBeNull();
    expect(await runDurableObjectAlarm(actor)).toBe(true);
    expect((await actor.counter()).alarms).toBe(1);
  });

  it("starts from clean storage after the previous test", async () => {
    const actor = actors().get(actors().idFromName("due-handle"));

    expect(await actor.read("swept-by")).toBeUndefined();
    expect(await actor.alarmAt()).toBeNull();
  });
});
