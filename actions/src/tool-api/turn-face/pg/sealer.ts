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
//
// Every error that leaves the sealer is scrubbed (T-1351; T-1334's security review, new task b): whatever the transaction
// throws (its start, the sealing_keys read, the seal, the commit, or a rollback that failed in place of the error it
// rolled back for) leaves through db/repo's scrubbed (db/repo/clocks.ts) under the sealer's call's name, seal.
// PostgreSQL's refusal leaves as DataAccessDatabaseError: its SQLSTATE and the names of its table and constraint. An
// error of the database client or of its connection leaves as a new error with the call's name and the code alone: a
// lost connection, a statement postgres.js could not build or send (UNDEFINED_VALUE, a serializer's TypeError), a
// connect that never opened, a session refused at its start by a client's check (a TLS or certificate error). So none
// leaves with what postgres.js and Node put on it: the statement and its parameter (the person id), the error's
// message, detail or stack, or the connection's host, port, user, password or database. The sealer's own refusal
// (noSealingKey) and sealing.ts's SealingError leave as they are (a fixed message each, and a code or a fault).
// WordsSealer answers sealed bytes or throws, so its caller reads no transient answer: a lost or never-opened connection
// is thrown scrubbed too, as the frontier's end throws one (frontier.ts, T-1330). One failure carries nothing scrubbed
// knows it by: a reserve() that never connects in postgres.js's Workers build (no code, no statement, no mark of a
// connection). It is scrubbed where it is raised, at inRuntimeTransaction's reserve, once that reserves through T-1314's
// reserveConnection (T-1334), which passes it on as the code 08001 alone.

import { scrubbed } from "../../../../../db/repo/clocks";
import { getSealingKeyInfo, seal, type WrappingKeys } from "../../../../../db/repo/sealing";
import type { Sql } from "../../../../../db/repo/scope";
import { inRuntimeTransaction } from "../../../../../db/repo/targets";
import type { WordsSealer } from "../../../domain/safety";
import { TurnFaceRefusedError } from "../errors";

/**
 * The name a scrubbed error of the sealer carries (T-1351): its one call, WordsSealer's seal, which runs db/repo's
 * seal (T-182) under a key that already exists. No K-05 call names it.
 */
const SEALER_CALL = "seal";

/**
 * Seals under a key that already exists, on `runtime` (rosie_job), in a read-only transaction; never makes a key. What it
 * throws is scrubbed (see the top of this file).
 */
export function pgReadOnlySealer(runtime: Sql, keys: WrappingKeys): WordsSealer {
  return {
    seal: async (plaintext, forPersonId) => {
      try {
        return await inRuntimeTransaction(runtime, { readOnly: true }, async (tx) => {
          if ((await getSealingKeyInfo(tx, forPersonId)) === null) {
            throw new TurnFaceRefusedError("noSealingKey");
          }
          return seal(tx, keys, forPersonId, plaintext);
        });
      } catch (error) {
        throw scrubbed(SEALER_CALL, error);
      }
    },
  };
}
