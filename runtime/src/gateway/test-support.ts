// Doubles for the gateway's tests (T-243). Not imported by the Worker.

import { actorNameOf, type HandleRef, type SealingKeyStore } from "./seal";

export interface FakeKeyStore extends SealingKeyStore {
  /** The handles a key was asked for, in order. */
  readonly asked: HandleRef[];
  /** The key made for a handle, for a test that opens a box itself; throws when none was made. */
  keyOf(handle: HandleRef): Uint8Array;
}

/** A value a test needs to be there: throws, with the name, when it is not. */
export function present<T>(value: T | null | undefined, name = "value"): T {
  if (value === undefined || value === null) throw new Error(`${name} is missing`);
  return value;
}

/** A key store that makes a random 32-byte key for a handle on first sight and gives the same one after. */
export function fakeKeyStore(): FakeKeyStore {
  const keys = new Map<string, Uint8Array>();
  const asked: HandleRef[] = [];
  return {
    asked,
    keyOf: (handle) => present(keys.get(actorNameOf(handle)), "the handle's key"),
    getOrCreateKey(handle) {
      asked.push(handle);
      const name = actorNameOf(handle);
      let key = keys.get(name);
      if (key === undefined) {
        key = crypto.getRandomValues(new Uint8Array(32));
        keys.set(name, key);
      }
      return Promise.resolve(key);
    },
  };
}
