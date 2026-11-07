// Question 1: can the workers project run a Durable Object with its own storage per test? (T-1128)
// Answer shown here: the DO runs and has its own SQLite-backed storage, but the plugin gives no automatic per-test
// storage isolation. A test file gets it with `afterEach(reset)` (this file) or with ids no other test uses.
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { actors, publishSpikeActorAsHandleActor, type SpikeActor } from "./spike-actor";

let restoreMain: () => void;
beforeAll(() => {
  restoreMain = publishSpikeActorAsHandleActor();
});
afterAll(() => {
  restoreMain();
});

describe("a Durable Object with storage, isolated per test by reset()", () => {
  afterEach(async () => {
    await reset();
  });

  it("test 1 writes to the actor's storage and reads it back", async () => {
    const actor = actors().get(actors().idFromName("handle-1"));
    await actor.write("draft", "half a message");

    expect(await actor.read("draft")).toBe("half a message");
    expect(await actor.keys()).toEqual(["draft"]);
  });

  it("test 2 finds the storage test 1 wrote gone (isolation checked)", async () => {
    const actor = actors().get(actors().idFromName("handle-1"));

    expect(await actor.read("draft")).toBeUndefined();
    expect(await actor.keys()).toEqual([]);
  });

  it("two names are two actors, each with its own storage", async () => {
    const first = actors().get(actors().idFromName("handle-a"));
    const second = actors().get(actors().idFromName("handle-b"));
    await first.write("k", "from a");

    expect(await second.read("k")).toBeUndefined();
    expect(await first.read("k")).toBe("from a");
  });

  it("SQL storage works too, and runInDurableObject reaches the instance and its state", async () => {
    const actor = actors().get(actors().idFromName("handle-sql"));

    const rows = await runInDurableObject(actor, (instance: SpikeActor) => instance.sqlRoundTrip("hello"));
    expect(rows).toEqual(["hello"]);

    const bodies = await runInDurableObject(actor, (_instance: SpikeActor, state) =>
      state.storage.sql
        .exec<{ body: string }>("SELECT body FROM notes")
        .toArray()
        .map((row) => row.body),
    );
    expect(bodies).toEqual(["hello"]);
  });

  it("eviction drops in-memory state but keeps storage", async () => {
    const actor = actors().get(actors().idFromName("handle-evict"));
    await actor.write("k", "kept");
    expect(await actor.hits()).toBe(1);

    await evictDurableObject(actor);

    expect(await actor.hits()).toBe(0);
    expect(await actor.read("k")).toBe("kept");
  });
});
