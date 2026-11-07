// Question 3: can a test deliver a queue message to a consumer? (T-1128)
// Answer shown here: yes, by calling the consumer's queue() handler with a batch made by createMessageBatch(), and
// reading the acknowledgements from getQueueResult(). The plugin does not run a real queue: env has no RETRY_QUEUE
// until T-566 (env.staging), and a consumer's dead-letter hop after max_retries is not simulated.
import { createExecutionContext, createMessageBatch, getQueueResult, reset } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { actors, publishSpikeActorAsHandleActor, spikeQueueConsumer, type SpikeMessage } from "./spike-actor";

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

async function deliver(messages: { id: string; body: SpikeMessage; attempts?: number }[]) {
  const batch = createMessageBatch<SpikeMessage>(
    "rosie-retry",
    messages.map(({ id, body, attempts }) => ({ id, timestamp: Date.now(), attempts: attempts ?? 1, body })),
  );
  const ctx = createExecutionContext();
  await spikeQueueConsumer.queue(batch);
  return getQueueResult(batch, ctx);
}

describe("a queue message delivered to a consumer", () => {
  it("is handled by the consumer, acknowledged, and its effect lands in the handle's actor", async () => {
    const result = await deliver([{ id: "m-1", body: { handle: "handle-q" } }]);

    expect(result.explicitAcks).toEqual(["m-1"]);
    expect(result.retryMessages).toEqual([]);
    expect(result.ackAll).toBe(false);
    expect(await actors().get(actors().idFromName("handle-q")).read("queued:m-1")).toBe("rosie-retry");
  });

  it("is retried with a delay when the consumer asks, and the other messages in the batch are still acknowledged", async () => {
    const result = await deliver([
      { id: "m-ok", body: { handle: "handle-q" } },
      { id: "m-bad", body: { handle: "handle-q", fail: true }, attempts: 4 },
    ]);

    expect(result.explicitAcks).toEqual(["m-ok"]);
    // The 30 s delay the consumer asked for is not reported back in retryMessages, so a test cannot check it.
    expect(result.retryMessages.map((retried) => retried.msgId)).toEqual(["m-bad"]);
    expect(await actors().get(actors().idFromName("handle-q")).keys()).toEqual(["queued:m-ok"]);
  });
});
