// Staging's two K-05 calls at receipt (the D-017 path audit's P2a: ops/reviews/D-017-path-audit/order_d017.txt line 31;
// T-1394). T-1257 made this file with its final signature; T-1394 binds it and edits nothing else.
//
// T-1394 gives RootOptions.handleKey (K-05 v1.2 item 29, db/repo/handle-keys.ts handleSealingKey, with the resolver it is
// handed: SEALING_WRAP_KEY alone, read at each call, ./secrets.ts) and RootOptions.chatOpenCall (K-05 v1.7 item 46,
// db/repo/chat-open.ts openChatOnText), each on one job-side client per call (part.db.runtime). Until then each is null, as
// the Worker's root has always handed: every seal and every chat open fails closed (../real.ts NoDatabaseError naming the
// call), so the gateway answers 503 with nothing stored. Nothing here reads a binding.

import type { WrappingKeys } from "@rosie/db/repo/sealing";

import type { HandleSealingKeyCall, OpenChatOnTextCall } from "../real";
import type { StagingPart } from "./part";

/** What T-1394's builder is handed: the env, the root's handle and the SEALING_WRAP_KEY-only resolver (./secrets.ts). */
export interface ReceiptPart extends StagingPart {
  readonly keys: WrappingKeys;
}

/** The receipt's two RootOptions inputs, each null where it is not bound. */
export interface ReceiptInputs {
  readonly handleKey: HandleSealingKeyCall | null;
  readonly chatOpenCall: OpenChatOnTextCall | null;
}

/** Neither call bound: each fails closed as its port does with nothing bound. */
export const NO_RECEIPT_INPUTS: ReceiptInputs = Object.freeze({ handleKey: null, chatOpenCall: null });

/** RootOptions.handleKey and chatOpenCall for staging: both null until T-1394 binds them. */
export const stagingReceiptCalls: (part: ReceiptPart) => ReceiptInputs = () => NO_RECEIPT_INPUTS;
