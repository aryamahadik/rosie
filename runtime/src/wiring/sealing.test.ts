// T-553's sealing join, under Node (Vitest project "unit"): the root's real sealing port (./real.ts realSealing), fed K-05
// v1.2's handleSealingKey as a double answering as the handle-key-*.json fixtures (DL-313 ruling 4), and the gateway's
// seal and open (runtime/src/gateway/seal.ts) with the key object K-05 hands over (T-182's form; K-05 README default 27),
// beside the raw-bytes path every double still takes (DL-313 ruling 1). Test values only (rule 9): the fixtures' 555-01xx
// number and keys made for the run.
import firstSight from "@rosie/contracts/data-access/fixtures/handle-key-first-sight.json";
import repeat from "@rosie/contracts/data-access/fixtures/handle-key-first-sight-repeat.json";
import type { HandleSealingKeyRequest } from "@rosie/db/repo/handle-keys";
import { describe, expect, it } from "vitest";

import { actorNameOf, openWords, sealWords, type HandleRef } from "../gateway/seal";
import { composeRoot, NoDatabaseError, realSealing, SEALING_WRAP_KEY, SealingKeyError } from "./index";
import { fakeHandleKeys, skeletonFakes } from "./test-support";

/** handle-key-first-sight.json's number: a new owner's first text (S1-01). */
const HANDLE: HandleRef = firstSight.request.handle;
const ACTOR = actorNameOf(HANDLE);
const WORDS = { body: "Do you have Saturday at 10?", subject: null };
const REFUSED = "sealing key is not a non-exportable AES-256-GCM key";

/** An AES key object made for the run. */
async function keyObject(
  algorithm: { name: string; length: number },
  extractable: boolean,
  usages: ("encrypt" | "decrypt")[],
): Promise<CryptoKey> {
  return (await crypto.subtle.generateKey(algorithm, extractable, usages)) as CryptoKey;
}

describe("the real sealing port: K-05 v1.2 handleSealingKey (item 29) with its database bound", () => {
  it("the double answers as handle-key-first-sight.json and handle-key-first-sight-repeat.json: one handle, one key", async () => {
    const keys = fakeHandleKeys(() => Date.parse(firstSight.given.now));

    const made = await keys.call(firstSight.request as HandleSealingKeyRequest);
    const found = await keys.call(repeat.request as HandleSealingKeyRequest);

    expect(made.outcome).toEqual(firstSight.outcome);
    expect(found.outcome).toEqual(repeat.outcome);
    expect(found.dataKey).toBe(made.dataKey);
  });

  it("asks with new ids on every call, taken from its id source and never from the address, and names the wrapping key", async () => {
    const keys = fakeHandleKeys();
    let n = 0;
    const port = realSealing({ handleKey: keys.call, newId: () => `id-${String((n += 1))}` });

    await port.getOrCreateKey(HANDLE);
    await port.getOrCreateKey(HANDLE);
    await realSealing({ handleKey: keys.call }).getOrCreateKey(HANDLE);

    expect(keys.requests.slice(0, 2)).toEqual([
      { ...firstSight.request, newHandleId: "handle-id-1", newPersonId: "person-id-2" },
      { ...firstSight.request, newHandleId: "handle-id-3", newPersonId: "person-id-4" },
    ]);
    const byDefault = keys.requests[2];
    if (byDefault === undefined) throw new Error("no third request");
    expect(byDefault.newHandleId).not.toBe(byDefault.newPersonId);
    for (const id of [byDefault.newHandleId, byDefault.newPersonId]) {
      expect(id).not.toContain(HANDLE.address.slice(1));
    }
    expect(new Set(keys.requests.map((request) => request.wrappingKeyName))).toEqual(
      new Set([SEALING_WRAP_KEY]),
    );
  });

  it("answers the data key K-05 hands over, a key object that cannot be exported, the same one for the number's next text", async () => {
    const keys = fakeHandleKeys();
    const port = realSealing({ handleKey: keys.call });

    const first = await port.getOrCreateKey(HANDLE);
    const again = await port.getOrCreateKey(HANDLE);

    expect(first).toBe(keys.keyOf(HANDLE.address));
    expect(again).toBe(first);
    expect({ type: first.type, extractable: first.extractable, algorithm: first.algorithm }).toEqual({
      type: "secret",
      extractable: false,
      algorithm: { name: "AES-GCM", length: 256 },
    });
  });

  it("fails closed, so the gateway answers 503: no database bound, K-05's transient or constraint answer, a handle K-04 does not hold", async () => {
    await expect(realSealing({ handleKey: null }).getOrCreateKey(HANDLE)).rejects.toThrow(
      new NoDatabaseError("handleSealingKey"),
    );
    const keys = fakeHandleKeys();
    const port = realSealing({ handleKey: keys.call });

    keys.failWith = { error: "transient", sqlstate: "40001" };
    await expect(port.getOrCreateKey(HANDLE)).rejects.toThrow(new SealingKeyError("transient"));
    keys.failWith = { error: "constraint", sqlstate: "23505", constraint: "handles_pkey" };
    await expect(port.getOrCreateKey(HANDLE)).rejects.toThrow(new SealingKeyError("constraint"));
    keys.failWith = null;
    await expect(port.getOrCreateKey({ kind: "fax", address: HANDLE.address })).rejects.toThrow(
      new SealingKeyError("badHandle"),
    );

    expect(keys.requests).toHaveLength(2);
  });
});

describe("the root's sealing port (DL-324): real under test and on staging, fed K-05's call through RootOptions", () => {
  const VARS = { ENVIRONMENT: "staging", GIT_SHA: "test-sha" };
  const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

  it("binds it to the key K-05 hands over: the gateway's seal, the safety read and the turn all take it", async () => {
    const keys = fakeHandleKeys();
    const root = composeRoot({
      environment: "test",
      sets: { fake: skeletonFakes().ports },
      actors: null,
      vars: VARS,
      handleKey: keys.call,
    });

    const key = await root.gateway.keys.getOrCreateKey(HANDLE);

    expect(key).toBe(keys.keyOf(HANDLE.address));
    expect(root.safety.keys).toBe(root.gateway.keys);
    expect(root.turn.keys).toBe(root.gateway.keys);
    expect(root.bindings.find((binding) => binding.port === "sealing")?.implementation).toBe("real");
    // Its new ids are handle-<uuid> and person-<uuid>: K-05's assertId takes any non-empty id with no NUL.
    expect(keys.requests).toEqual([
      {
        handle: { kind: HANDLE.kind, address: HANDLE.address },
        newHandleId: expect.stringMatching(new RegExp(`^handle-${UUID}$`)) as unknown,
        newPersonId: expect.stringMatching(new RegExp(`^person-${UUID}$`)) as unknown,
        wrappingKeyName: SEALING_WRAP_KEY,
      },
    ]);
  });

  it("with no K-05 call handed in, as in the Worker's root until T-567 binds its database, every seal fails closed", async () => {
    const root = composeRoot({
      environment: "test",
      sets: { fake: skeletonFakes().ports },
      actors: null,
      vars: VARS,
    });

    await expect(root.gateway.keys.getOrCreateKey(HANDLE)).rejects.toThrow(
      new NoDatabaseError("handleSealingKey"),
    );
  });
});

describe("the gateway's seal and open with the key object (T-182's form)", () => {
  it("seals and opens under it; the box is unreadable without it, under another key, or moved to another event", async () => {
    const keys = fakeHandleKeys();
    const key = await realSealing({ handleKey: keys.call }).getOrCreateKey(HANDLE);

    const box = await sealWords(WORDS, key, ACTOR, "evt-seal-1");

    expect(JSON.stringify(box)).not.toContain(WORDS.body);
    expect(await openWords(box, key, ACTOR, "evt-seal-1")).toEqual(WORDS);
    const other = await keyObject({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await expect(openWords(box, other, ACTOR, "evt-seal-1")).rejects.toThrow();
    await expect(
      openWords(box, crypto.getRandomValues(new Uint8Array(32)), ACTOR, "evt-seal-1"),
    ).rejects.toThrow();
    await expect(openWords(box, key, ACTOR, "evt-seal-2")).rejects.toThrow();
  });

  it("refuses a key object that can be exported, is not AES-GCM, is not 256 bits, or may not do the work, naming no key", async () => {
    const refused = [
      await keyObject({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]),
      await keyObject({ name: "AES-GCM", length: 128 }, false, ["encrypt", "decrypt"]),
      await keyObject({ name: "AES-CBC", length: 256 }, false, ["encrypt", "decrypt"]),
      await keyObject({ name: "AES-GCM", length: 256 }, false, ["decrypt"]),
    ];
    for (const key of refused) {
      await expect(sealWords(WORDS, key, ACTOR, "evt-seal-1")).rejects.toThrow(new Error(REFUSED));
    }
    const sealOnly = await keyObject({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const box = await sealWords(WORDS, sealOnly, ACTOR, "evt-seal-1");
    await expect(openWords(box, sealOnly, ACTOR, "evt-seal-1")).rejects.toThrow(new Error(REFUSED));
  });

  it("keeps the raw-bytes path every double takes: 32 bytes seal and open; another length is refused", async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));

    const box = await sealWords(WORDS, raw, ACTOR, "evt-seal-1");

    expect(await openWords(box, raw, ACTOR, "evt-seal-1")).toEqual(WORDS);
    await expect(sealWords(WORDS, raw.slice(0, 16), ACTOR, "evt-seal-1")).rejects.toThrow(
      new Error("sealing key has the wrong length"),
    );
  });
});
