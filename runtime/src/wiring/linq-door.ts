// The dispatcher's door to Linq (T-562; DL-317; K-05 v1.2 item 30; K-07 v1 outboxRow.port; DL-012, DL-031): what the
// composition root puts between the outbox dispatcher (runtime/src/dispatch) and the Linq port it sends each part through
// (./ports.ts linqSend.parts).
//
//   - Only a row whose claim names the linq port goes to Linq. K-05 v1.2's claim gives each row its port from its
//     channel (linq for imessage, rcs and sms, Linq's own services; email for email), and the dispatcher's limit 8 refuses
//     only an SMS port (dispatch/limit8 isSmsPort), so an email row would otherwise reach Linq. The door keeps each
//     claimed row's port, as the claim answered it, and answers a part of any row whose port is not linq, or whose claim
//     it never saw, as refused (code notLinqPort) without calling Linq: nothing reaches Linq. The dispatcher then records
//     the part failed under that label; its own retries refuse again at the door, until the row's tries end (T-273).
//   - A send has a time limit far below the claim's 60 s (K-07 default 2): with no answer from Linq within
//     SEND_TIMEOUT_MS the door answers as Linq's no answer (transient, no status, code sendTimeout), so the dispatcher
//     keeps the part pending under the same key (K-07 rule 1) while its claim still holds, and Linq answers a repeat of the
//     key with the first message (K-11 'Repeating it'). Past the claim only Linq's idempotency key stops a double send.
//
// Worker code: no double, no fixture, no key. Nothing here logs: the request holds a number and a person's words.

import type { LinqFailed, LinqPort, OutboxStore } from "../dispatch/types";

/** How long the door waits for Linq's answer to one part: far below the claim's 60 s (K-07 default 2; DL-317). */
export const SEND_TIMEOUT_MS = 15_000;
/** How many claimed rows' ports one isolate keeps; the oldest is forgotten first (a row it no longer knows is refused). */
export const PORT_MEMORY = 1024;
/** The label of a part refused at the door: its row's port is not linq (K-04 outbox_parts.error_code). */
export const NOT_LINQ_PORT = "notLinqPort";
/** The label of a send Linq did not answer within the door's time limit. */
export const SEND_TIMEOUT = "sendTimeout";

/** The row a part's key names: K-04 outbox_parts' '<row>/<part>/<try>', the row id being all before the last two. */
function rowOfPartKey(key: string): string | null {
  const parts = key.split("/");
  return parts.length < 3 ? null : parts.slice(0, -2).join("/");
}

/** A part refused at the door, as K-11 names a send the provider refused: nothing reached Linq. */
const refusedAtDoor = (): LinqFailed => ({
  result: "failed",
  kind: "refused",
  httpStatus: null,
  code: NOT_LINQ_PORT,
  reason: "the row's port is not linq",
  retryAfterSeconds: null,
  providerMessageId: null,
});

/** No answer from Linq within the door's time limit, as K-11 names a send with no answer. */
const timedOut = (): LinqFailed => ({
  result: "failed",
  kind: "transient",
  httpStatus: null,
  code: SEND_TIMEOUT,
  reason: "no answer from Linq within the send's time limit",
  retryAfterSeconds: null,
  providerMessageId: null,
});

/** The dispatcher's store and Linq port, as the root hands them on: each claimed row's port kept, each send checked. */
export class LinqDoor {
  private readonly ports = new Map<string, string>();

  constructor(private readonly timeoutMs: number = SEND_TIMEOUT_MS) {}

  /** The store as the dispatcher uses it: unchanged, but each claimed row's port is kept for the door. */
  watch(store: OutboxStore): OutboxStore {
    return {
      claimOutbox: async (request) => {
        const answer = await store.claimOutbox(request);
        if (!("error" in answer)) {
          // A claimed row with no port is linq's (dispatch/types.ts ClaimedRow.port: left out, it is linq).
          for (const row of answer.claimed) this.keep(row.outboxRowId, row.port ?? "linq");
        }
        return answer;
      },
      renewClaim: (request) => store.renewClaim(request),
      markPart: (request) => store.markPart(request),
      markRow: (request) => store.markRow(request),
    };
  }

  /** The Linq port as the dispatcher sends through it: a linq row's part only, within the door's time limit. */
  door(linq: LinqPort): LinqPort {
    return {
      sendPart: (request) => {
        const row = rowOfPartKey(request.idempotencyKey);
        if (row === null || this.ports.get(row) !== "linq") return Promise.resolve(refusedAtDoor());
        return this.inTime(linq.sendPart(request));
      },
    };
  }

  private keep(row: string, port: string): void {
    this.ports.delete(row);
    this.ports.set(row, port);
    while (this.ports.size > PORT_MEMORY) {
      const oldest = this.ports.keys().next().value;
      if (oldest === undefined) break;
      this.ports.delete(oldest);
    }
  }

  private async inTime<T>(send: Promise<T>): Promise<T | LinqFailed> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<LinqFailed>((resolve) => {
      timer = setTimeout(() => {
        resolve(timedOut());
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([send, late]);
    } finally {
      clearTimeout(timer);
    }
  }
}
