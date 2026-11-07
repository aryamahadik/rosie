// The baseline for question 1 (T-1128): with no reset() the plugin keeps a Durable Object's storage from one test to
// the next in the same file. The two tests below depend on running in order, which Vitest does inside one file.
// These tests show why storage.worker.test.ts calls reset(); delete this file when T-244 has its own isolation tests.
import { reset } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { actors, publishSpikeActorAsHandleActor } from "./spike-actor";

let restoreMain: () => void;
beforeAll(() => {
  restoreMain = publishSpikeActorAsHandleActor();
});
afterAll(async () => {
  restoreMain();
  await reset();
});

describe("without reset(), storage is not isolated per test", () => {
  it("test 1 writes", async () => {
    await actors().get(actors().idFromName("handle-shared")).write("k", "written in test 1");
  });

  it("test 2 still sees what test 1 wrote", async () => {
    const actor = actors().get(actors().idFromName("handle-shared"));

    expect(await actor.read("k")).toBe("written in test 1");
  });
});
