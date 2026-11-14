// The wrapping-key resolver staging's sealing calls take (T-1257; critic_collisions N4; NQ-DB-1's default: one environment
// key wraps every data key). K-05 v1.2 item 29's handleSealingKey (db/repo/handle-keys.ts) resolves a held key row by the
// wrapping key's name stored in that row, and accepts any upper-case name in a request (handle-keys.ts line 104); db/repo's
// seal() and the read-only sealer (actions' pgReadOnlySealer) resolve the same way. This resolver takes one name,
// SEALING_WRAP_KEY, the secret staging holds (T-1236, DL-518): any other name is refused and never read, so a row naming
// another secret opens nothing, and no secret of the Worker's env but this one can be read through it.
//
// The value is read from the env at each call, never when the root is built, and handed to the call alone: it is never
// kept, returned in an answer, logged or put in an error. A refusal names the one name the resolver takes, never the
// name it was asked for (a row's value) or any secret's value. P2a (T-1394, handleKey) and P4a (T-1398, the read-only
// sealer) are handed it by ./options.ts.

import type { WrappingKeys } from "@rosie/db/repo/sealing";

import { SEALING_WRAP_KEY } from "../real";

/** The resolver was asked for a name it does not take: anything but SEALING_WRAP_KEY. Names no value, and not that name. */
export class WrappingKeyNameError extends Error {
  constructor() {
    super(`the wrapping key resolver reads ${SEALING_WRAP_KEY} only`);
    this.name = "WrappingKeyNameError";
  }
}

/** The one secret the resolver reads, by its name: undefined (or missing) where it is not set. */
export interface WrappingKeyEnv {
  readonly SEALING_WRAP_KEY?: string | undefined;
}

/**
 * db/repo's WrappingKeys (sealing.ts; handle-keys.ts WrappingKeyResolver) over the Worker's env: `name` SEALING_WRAP_KEY
 * (the name a new key is wrapped under), and `resolve(name)` the value of SEALING_WRAP_KEY, read from `env` at each call
 * (undefined where it is not set, which db/repo refuses as wrapping_key_missing), for that name alone. Any other name
 * throws WrappingKeyNameError before anything is read.
 */
export function sealingWrapKeys(env: WrappingKeyEnv): WrappingKeys {
  return {
    name: SEALING_WRAP_KEY,
    resolve(name) {
      if (name !== SEALING_WRAP_KEY) throw new WrappingKeyNameError();
      return env.SEALING_WRAP_KEY;
    },
  };
}
