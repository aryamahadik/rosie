// Staging's send, all or nothing (the D-017 path audit's P5: ops/reviews/D-017-path-audit/order_d017.txt line 49; T-1401).
// T-1257 made this file with its final signature; T-1401 binds it and edits nothing else.
//
// T-1401 gives RootOptions.outboxCalls, sendStateCall and armingCalls (db/repo's outbox, send-state, clocks and arming
// reads, each on one job-side client per call, part.db.runtime) and linqSendCall (staging's test-phone line, from
// part.env.TEST_PHONE_LINE), the four bound together or none (DL-468; critic_collisions B7). Until then each is null, as
// the Worker's root has always handed: every claim, send-state read, send and arming fails closed (../real.ts
// NoDatabaseError and NoLinqLineError), so nothing is claimed or sent, and a delivery receipt is answered 503 with no part
// marked. Nothing here reads a binding.

import type { ArmingCalls, LinqSendCall, OutboxCalls, SendStateCall } from "../real";
import type { StagingPart } from "./part";

/** What T-1401's builder is handed: the env (TEST_PHONE_LINE, HYPERDRIVE_JOB) and the root's handle. */
export type SendPart = StagingPart;

/** The send's four RootOptions inputs: all bound, or all null. */
export interface SendInputs {
  readonly outboxCalls: OutboxCalls | null;
  readonly sendStateCall: SendStateCall | null;
  readonly linqSendCall: LinqSendCall | null;
  readonly armingCalls: ArmingCalls | null;
}

/** None of the four bound: each fails closed as its port does with nothing bound. */
export const NO_SEND_INPUTS: SendInputs = Object.freeze({
  outboxCalls: null,
  sendStateCall: null,
  linqSendCall: null,
  armingCalls: null,
});

/** RootOptions.outboxCalls, sendStateCall, linqSendCall and armingCalls for staging: all null until T-1401 binds them. */
export const stagingSendCalls: (part: SendPart) => SendInputs = () => NO_SEND_INPUTS;
