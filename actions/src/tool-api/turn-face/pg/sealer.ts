// The safety record's sealer on PostgreSQL, read-only (T-1141; DL-344: "the sealer is needed even for No, whose labels
// are sealed. Keep it read-only: the person's key already exists (the gateway made it at first sight), and runCore never
// makes one"; the security reviewer's note a on T-1140; db/repo/sealing.ts lines 227 to 240).
//
// T-182's seal() makes a person's data key on their first seal. The record must never do that: a key is made only at the
// gateway's first sight of a handle (K-05 v1.2 item 29, db/repo/handle-keys.ts), so a person with no key is a record the
// turn face will not guess around. So each seal runs in a read-only transaction of its own on the runtime client
// (sealing_keys is the runtime side's table: 0012), finds the person's key row first and refuses (noSealingKey) when
// there is none; and the transaction itself is READ ONLY, so PostgreSQL refuses any insert into sealing_keys (25006)
// should one ever be tried. The sealed bytes differ on each run (a fresh IV), as seal() makes them. Nothing here logs; an
// error carries a code, never a key, a plaintext or an id.

import { getSealingKeyInfo, seal, type WrappingKeys } from "../../../../../db/repo/sealing";
import type { Sql } from "../../../../../db/repo/scope";
import { inRuntimeTransaction } from "../../../../../db/repo/targets";
import type { WordsSealer } from "../../../domain/safety";
import { TurnFaceRefusedError } from "../errors";

/** Seals under a key that already exists, on `runtime` (rosie_job), in a read-only transaction; never makes a key. */
export function pgReadOnlySealer(runtime: Sql, keys: WrappingKeys): WordsSealer {
  return {
    seal: (plaintext, forPersonId) =>
      inRuntimeTransaction(runtime, { readOnly: true }, async (tx) => {
        if ((await getSealingKeyInfo(tx, forPersonId)) === null) {
          throw new TurnFaceRefusedError("noSealingKey");
        }
        return seal(tx, keys, forPersonId, plaintext);
      }),
  };
}
