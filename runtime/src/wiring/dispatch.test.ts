// T-562's ports, in Node: the outbox port over K-05 v1.2's four outbox calls, the send-state port over K-05 v1.2 sendState
// (./real.ts realOutbox, realSendState), and the root's Linq door (./linq-door.ts). Each K-05 call is a double answering
// as the frozen fixtures state (contracts/data-access/fixtures: claim-in-order-with-port.json, renew-claim-reads-phone.json,
// send-state-owner.json, send-state-stopped.json), so what the port hands the dispatcher is checked field by field
// against K-05's own answers. Test values only (rule 9): the fixtures' sample cast and the fictional 555-01xx numbers.
import claimInOrderWithPort from "@rosie/contracts/data-access/fixtures/claim-in-order-with-port.json";
import renewClaimReadsPhone from "@rosie/contracts/data-access/fixtures/renew-claim-reads-phone.json";
import sendStateOwner from "@rosie/contracts/data-access/fixtures/send-state-owner.json";
import sendStateStopped from "@rosie/contracts/data-access/fixtures/send-state-stopped.json";
import type {
  ClaimOutboxV12Outcome,
  MarkPartV12Outcome,
  MarkRowV12Outcome,
  RenewClaimOutcome,
} from "@rosie/db/repo/outbox";
import type { SendStateOutcome, SendStateResponse } from "@rosie/db/repo/send-state";
import { describe, expect, it } from "vitest";

import { runDispatch } from "../dispatch/dispatcher";
import {
  FakeClock,
  FakeLinq,
  FakeOutboxStore,
  FakeSendState,
  traceCollector,
  words,
} from "../dispatch/test-support";
import type { LinqAccepted, LinqPort, OutboxStore } from "../dispatch/types";
import type { Span } from "../trace";
import {
  LinqDoor,
  NOT_LINQ_PORT,
  NoDatabaseError,
  realOutbox,
  realSendState,
  SEND_TIMEOUT,
  SendStateError,
  type OutboxCalls,
} from "./index";

type ClaimAnswer = Extract<ClaimOutboxV12Outcome, { result: "claimed" }>;

const CLAIMED = claimInOrderWithPort.outcome as unknown as ClaimAnswer;
const RENEWED = renewClaimReadsPhone.outcome as unknown as RenewClaimOutcome;
const OWNER_STATE = sendStateOwner.outcome as unknown as SendStateResponse;
const STOPPED_STATE = sendStateStopped.outcome as unknown as SendStateResponse;

/** K-05's four outbox calls answering as given, each request kept. */
function outboxCalls(answers: {
  claim?: ClaimOutboxV12Outcome;
  renew?: RenewClaimOutcome;
  markPart?: MarkPartV12Outcome;
  markRow?: MarkRowV12Outcome;
}): OutboxCalls & { readonly requests: unknown[] } {
  const requests: unknown[] = [];
  const answer = <T>(value: T | undefined, request: unknown): Promise<T> => {
    requests.push(request);
    if (value === undefined) return Promise.reject(new Error("no answer given"));
    return Promise.resolve(structuredClone(value));
  };
  return {
    requests,
    claimOutboxV12: (request) => answer(answers.claim, request),
    renewClaim: (request) => answer(answers.renew, request),
    markPartV12: (request) => answer(answers.markPart, request),
    markRowV12: (request) => answer(answers.markRow, request),
  };
}

describe("the outbox port: the dispatcher's OutboxStore over K-05 v1.2's four outbox calls (T-562)", () => {
  it("hands each claimed row on as K-05 v1.2 claimed it (claim-in-order-with-port.json): its claim, the state it was claimed from, its port and its final parts", async () => {
    const calls = outboxCalls({ claim: CLAIMED });
    const store = realOutbox({ calls });
    const answer = await store.claimOutbox({
      claimer: "dispatcher-1",
      now: "2026-11-07T15:06:35Z",
      limit: 10,
    });
    // The request goes to claimOutboxV12 as it is.
    expect(calls.requests).toEqual([{ claimer: "dispatcher-1", now: "2026-11-07T15:06:35Z", limit: 10 }]);
    if ("error" in answer) throw new Error("the claim answered an error");
    expect(answer.passedHeld).toEqual([]);
    expect(answer.claimed).toHaveLength(CLAIMED.claimed.length);
    answer.claimed.forEach((row, index) => {
      const given = CLAIMED.claimed[index];
      if (given === undefined) throw new Error("no such claimed row");
      expect(row).toEqual({
        outboxRowId: given.outboxRowId,
        version: given.version,
        commitSeq: given.commitSeq,
        recipientHandleId: given.recipientHandleId,
        recipientPersonId: given.recipientPersonId,
        businessId: given.businessId,
        bookingId: given.bookingId,
        openQuestionId: given.openQuestionId,
        channel: given.channel,
        port: "linq",
        sendClass: given.sendClass,
        versionsRead: given.versionsRead,
        // The final parts as finalize wrote them, less what the dispatcher never reads (the slot values).
        finalParts: {
          row: given.finalParts.row,
          channel: given.finalParts.channel,
          sends: given.finalParts.sends,
          fixedLines: given.finalParts.fixedLines,
          threadReplyTo: given.finalParts.threadReplyTo,
        },
        parts: given.parts,
        traceId: given.traceId,
        claim: given.claim,
        claimedFrom: "checked",
      });
    });
  });

  it("hands a poll's K-03 options ({id, label}) on as their labels, the words Linq shows", async () => {
    const [first] = CLAIMED.claimed;
    if (first === undefined) throw new Error("the fixture claims a row");
    const poll = {
      ...first,
      finalParts: {
        ...first.finalParts,
        sends: [
          {
            kind: "poll",
            text: "Which works?",
            calendarFile: "none",
            options: [
              { id: "opt-1", label: "Saturday" },
              { id: "opt-2", label: "Sunday" },
            ],
            link: null,
          },
        ],
      },
    };
    const store = realOutbox({
      calls: outboxCalls({ claim: { ...CLAIMED, claimed: [poll] } as unknown as ClaimOutboxV12Outcome }),
    });
    const answer = await store.claimOutbox({
      claimer: "dispatcher-1",
      now: "2026-11-07T15:06:35Z",
      limit: 10,
    });
    if ("error" in answer) throw new Error("the claim answered an error");
    expect(answer.claimed[0]?.finalParts.sends).toEqual([
      {
        kind: "poll",
        text: "Which works?",
        calendarFile: "none",
        options: ["Saturday", "Sunday"],
        link: null,
      },
    ]);
  });

  it("renews as renew-claim-reads-phone.json answers; a renewal that read no phone row is unreadable (notFound for the phone row), never read as not stopped", async () => {
    const request = renewClaimReadsPhone.request;
    const store = realOutbox({ calls: outboxCalls({ renew: RENEWED }) });
    expect(await store.renewClaim(request)).toEqual({
      result: "renewed",
      outboxRowId: request.outboxRowId,
      claim: renewClaimReadsPhone.outcome.claim,
    });
    const noPhone = realOutbox({
      calls: outboxCalls({ renew: { ...RENEWED, recipient: null } }),
    });
    expect(await noPhone.renewClaim(request)).toEqual({
      error: "notFound",
      table: "phones",
      rowId: request.outboxRowId,
    });
  });

  it("marks a part and a row through markPartV12 and markRowV12, the row after the mark handed back; errors pass through", async () => {
    const marked = {
      result: "marked",
      outboxRowId: "out-alex-booked-riley",
      partNo: 1,
      tryNo: 1,
      attempts: 1,
      repeated: false,
      firstDelivery: false,
      openQuestionId: null,
      nextKey: null,
      row: { state: "sent", version: 4 },
    } as unknown as MarkPartV12Outcome;
    const calls = outboxCalls({
      markPart: marked,
      markRow: { error: "versionChanged", changed: [] } as unknown as MarkRowV12Outcome,
    });
    const store = realOutbox({ calls });
    const sent = {
      outcome: "sent" as const,
      idempotencyKey: "out-alex-booked-riley/1/1",
      providerMessageId: "linq-msg-0001",
      providerOptionIds: null,
      at: "2026-11-07T15:06:36Z",
    };
    expect(await store.markPart(sent)).toEqual(marked);
    const held = {
      outboxRowId: "out-alex-booked-riley",
      expectVersion: 3,
      outcome: "held" as const,
      heldUntil: "2026-11-08T13:00:00Z",
      at: "2026-11-07T15:06:36Z",
    };
    expect(await store.markRow(held)).toEqual({ error: "versionChanged", changed: [] });
    expect(calls.requests).toEqual([sent, held]);
  });

  it("fails every call closed with no database bound (the Worker until T-567)", async () => {
    const store = realOutbox({ calls: null });
    await expect(store.claimOutbox({ claimer: "d", now: "2026-11-07T15:06:35Z", limit: 1 })).rejects.toThrow(
      new NoDatabaseError("claimOutbox"),
    );
    await expect(store.renewClaim(renewClaimReadsPhone.request)).rejects.toThrow(
      new NoDatabaseError("renewClaim"),
    );
    await expect(
      store.markRow({ outboxRowId: "r", expectVersion: 1, outcome: "withdrawn", heldUntil: null, at: "x" }),
    ).rejects.toThrow(new NoDatabaseError("markRow"));
  });
});

describe("the send-state port: limit 8's read and the recipient's chat over K-05 v1.2 sendState (T-562)", () => {
  const row = (recipientHandleId: string) =>
    ({ outboxRowId: OWNER_STATE.outboxRowId, recipientHandleId }) as Parameters<
      ReturnType<typeof realSendState>["sendState"]["sendStateFor"]
    >[0];

  it("reads send-state-owner.json as limit 8's send state: the phone's flags, the audience, the zone and hours, the versions now", async () => {
    const port = realSendState({ call: () => Promise.resolve(structuredClone(OWNER_STATE)) });
    expect(await port.sendState.sendStateFor(row("handle-sam"))).toEqual({
      stopped: false,
      stopAt: null,
      textsConsent: null,
      chatOpen: true,
      audience: "owner",
      visitZone: null,
      businessZone: "America/New_York",
      textHours: { start: "08:00", end: "20:00" },
      textHoursOverride: false,
      currentVersions: OWNER_STATE.currentVersions,
      closed: { booking: false, question: false },
    });
    // That read holds no chat thread for Sam, so no chat is known to send to.
    expect(await port.recipients.chatFor("handle-sam")).toBeNull();
  });

  it("maps the phone's stopped flag, its stop time and the texts consent row across unchanged (send-state-stopped.json), never deriving stopped from a consent row", async () => {
    const port = realSendState({ call: () => Promise.resolve(structuredClone(STOPPED_STATE)) });
    const state = await port.sendState.sendStateFor(row(STOPPED_STATE.recipient.handleId));
    if ("error" in state) throw new Error("the read answered an error");
    expect(state.stopped).toBe(STOPPED_STATE.phone?.stopped);
    expect(state.stopAt).toBe(STOPPED_STATE.phone?.stopAt);
    expect(state.textsConsent).toEqual(STOPPED_STATE.textsConsent);
    // A consent row that withdraws texts with a phone row not stopped leaves the flag as the phone has it.
    const revokedOnly = realSendState({
      call: () =>
        Promise.resolve({
          ...structuredClone(OWNER_STATE),
          textsConsent: {
            consentId: "consent-1",
            businessId: null,
            revoked: true,
            at: "2026-11-07T15:00:00Z",
          },
        }),
    });
    const notStopped = await revokedOnly.sendState.sendStateFor(row("handle-sam"));
    if ("error" in notStopped) throw new Error("the read answered an error");
    expect(notStopped.stopped).toBe(false);
  });

  it("gives the chat the read names: the phone's number, the thread's Linq chat id and the service Linq reports", async () => {
    const withChat: SendStateResponse = {
      ...structuredClone(OWNER_STATE),
      chat: { threadId: "thread-s1-01-sam-1", linqChatId: "linq-chat-demo-sam", version: 1 },
    };
    const port = realSendState({ call: () => Promise.resolve(withChat) });
    await port.sendState.sendStateFor(row("handle-sam"));
    expect(await port.recipients.chatFor("handle-sam")).toEqual({
      to: "+15555550100",
      chatId: "linq-chat-demo-sam",
      service: "imessage",
    });
    // A recipient no read was made for has no chat: nothing is sent.
    expect(await port.recipients.chatFor("handle-alex")).toBeNull();
  });

  it("reads a number with no phone row as no open chat (the row waits for the chat), and gives it no chat", async () => {
    const noPhone: SendStateResponse = {
      ...structuredClone(OWNER_STATE),
      phone: null,
      chat: { threadId: "thread-s1-01-sam-1", linqChatId: "linq-chat-demo-sam", version: 1 },
    };
    const port = realSendState({ call: () => Promise.resolve(noPhone) });
    const state = await port.sendState.sendStateFor(row("handle-sam"));
    if ("error" in state) throw new Error("the read answered an error");
    expect([state.stopped, state.chatOpen, state.stopAt]).toEqual([false, false, null]);
    expect(await port.recipients.chatFor("handle-sam")).toBeNull();
  });

  it("passes a transient answer back, throws on a row K-05 cannot find, and fails closed with no database bound", async () => {
    const transient = realSendState({
      call: () => Promise.resolve({ error: "transient", sqlstate: "40001" } as SendStateOutcome),
    });
    expect(await transient.sendState.sendStateFor(row("handle-sam"))).toEqual({
      error: "transient",
      sqlstate: "40001",
    });
    const missing = realSendState({
      call: () =>
        Promise.resolve({ error: "notFound", table: "outbox_rows", rowId: "gone" } as SendStateOutcome),
    });
    await expect(missing.sendState.sendStateFor(row("handle-sam"))).rejects.toThrow(SendStateError);
    await expect(realSendState({ call: null }).sendState.sendStateFor(row("handle-sam"))).rejects.toThrow(
      new NoDatabaseError("sendState"),
    );
  });
});

describe("the root's Linq door (T-562; DL-317)", () => {
  const accepted: LinqAccepted = {
    result: "accepted",
    providerMessageId: "linq-msg-1",
    providerOptionIds: null,
    chatId: "linq-chat-demo-sam",
    service: "imessage",
    acceptedAt: "2026-11-07T15:06:36Z",
  };
  const send = (idempotencyKey: string): Parameters<LinqPort["sendPart"]>[0] => ({
    idempotencyKey,
    to: "+15555550100",
    chatId: "linq-chat-demo-sam",
    service: "imessage",
    kind: "words",
    text: "Hello",
    calendarFile: null,
    options: [],
    link: null,
    photo: null,
    tapback: null,
    threadedReplyTo: null,
    typing: null,
    overrideOptout: false,
  });
  /** A store whose claim answers one row by `port` (left out: no port given). */
  const storeClaiming = (rowId: string, port?: string): OutboxStore => {
    const [first] = CLAIMED.claimed;
    if (first === undefined) throw new Error("the fixture claims a row");
    const claimed = realOutbox({
      calls: outboxCalls({
        claim: {
          ...CLAIMED,
          claimed: [{ ...first, outboxRowId: rowId, ...(port === undefined ? {} : { port }) }],
        } as unknown as ClaimOutboxV12Outcome,
      }),
    });
    return claimed;
  };

  it("lets only a part of a row whose claim named the linq port reach Linq; any other port, or a row it never saw claimed, is refused unsent", async () => {
    const door = new LinqDoor();
    const sent: string[] = [];
    const linq = door.door({
      sendPart: (request) => {
        sent.push(request.idempotencyKey);
        return Promise.resolve(accepted);
      },
    });
    await door
      .watch(storeClaiming("row/with/slashes", "linq"))
      .claimOutbox({ claimer: "d", now: "x", limit: 1 });
    await door.watch(storeClaiming("out-email-1", "email")).claimOutbox({ claimer: "d", now: "x", limit: 1 });

    expect(await linq.sendPart(send("row/with/slashes/1/1"))).toEqual(accepted);
    const refused = { result: "failed", kind: "refused", httpStatus: null, code: NOT_LINQ_PORT };
    expect(await linq.sendPart(send("out-email-1/1/1"))).toMatchObject(refused);
    expect(await linq.sendPart(send("out-never-claimed/1/1"))).toMatchObject(refused);
    expect(sent).toEqual(["row/with/slashes/1/1"]);
  });

  it("answers a send Linq does not answer within its time limit as no answer (transient, no status), so the part keeps its key", async () => {
    const door = new LinqDoor(20);
    await door.watch(storeClaiming("out-slow-1", "linq")).claimOutbox({ claimer: "d", now: "x", limit: 1 });
    const linq = door.door({ sendPart: () => new Promise<never>(() => undefined) });
    expect(await linq.sendPart(send("out-slow-1/1/1"))).toMatchObject({
      result: "failed",
      kind: "transient",
      httpStatus: null,
      code: SEND_TIMEOUT,
    });
  });

  it("through the dispatcher: an email-port row claimed for a run never reaches Linq", async () => {
    const clock = new FakeClock("2026-11-07T15:06:35.000Z");
    const store = new FakeOutboxStore([
      { id: "out-email-1", recipient: "handle-alex", commitSeq: 1, sends: [words("Hello")], port: "email" },
    ]);
    const linq = new FakeLinq(clock.now);
    const door = new LinqDoor();
    const spans: Span[] = [];
    const report = await runDispatch({
      store: door.watch(store),
      linq: door.door(linq),
      recipients: {
        chatFor: () =>
          Promise.resolve({ to: "+15555550101", chatId: "linq-chat-demo-alex", service: "imessage" }),
      },
      sendState: new FakeSendState(),
      environment: "test",
      traceFor: traceCollector(spans),
      now: clock.now,
      claimer: "dispatcher-1",
    });
    expect(linq.requests).toEqual([]);
    expect(report.rows.map((row) => [row.outboxRowId, row.partsSent])).toEqual([["out-email-1", 0]]);
    expect(store.marks.map((mark) => mark.outcome === "failed" && mark.errorCode)).toEqual([NOT_LINQ_PORT]);
  });
});
