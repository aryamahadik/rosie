// Duplicate sends, counted per try (T-465 round 2, after the architect's review of 0d92cd1): what reached the person is
// read from K-07 v1's part states (the local outbox reader) or the Linq double's reports, never from accepted outcomes
// alone. A retry after a timeout or crash reuses its key (contracts/outbox-effects README, retry rule 1; part move
// pending -> pending, "same key, attempts + 1"; fixtures/outbox-claim-lapsed.json) and Linq dedupes by it
// (contracts/port-linq README, sendPart), so a key sent twice is one message. An accepted part reported failed goes again
// under its next key and reached the person once (K-07 row move sent -> checked, part move sent -> failed;
// fixtures/outbox-poll-failed-plain.json). Each correct path passes, and the real duplicate beside it fails. The requests
// are K-11 v1's send-text.json and send-poll.json under the K-07 fixtures' keys: the checks read keys, message ids and
// states only. Run by `npm run test:e2e -- _driver`.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { LinqDouble } from "../../../adapters/src/linq/double";
import type { DoubleEvent, SendPartOutcome, SendPartRequest } from "../../../adapters/src/linq/double/types";
import type { OutboxLife } from "../../../contracts/generated/outbox-effects/outbox-effects.v1";
import { CONTRACTS_ROOT } from "../../contract/_harness";
import {
  RecordingLinqDouble,
  asTrace,
  checkOutboxRows,
  checkParts,
  checkRun,
  partsOf,
  type RunReport,
  type SentPart,
} from "./index";

function json(...parts: string[]): unknown {
  return JSON.parse(readFileSync(path.join(CONTRACTS_ROOT, ...parts), "utf8"));
}

const skeleton = asTrace(json("event-trace", "fixtures", "trace-skeleton.json"));
const sendText = (json("port-linq", "fixtures", "send-text.json") as { request: SendPartRequest }).request;
const sendPoll = (json("port-linq", "fixtures", "send-poll.json") as { request: SendPartRequest }).request;
/** Maya's row: try 1 sent, the dispatcher died before Linq answered, the same key sent again (attempts 2), delivered. */
const claimLapsed = json("outbox-effects", "fixtures", "outbox-claim-lapsed.json") as OutboxLife;
/** Alex's row: the words, the poll accepted then reported failed (poll.failed), the options typed under /2/2. */
const pollFailedPlain = json("outbox-effects", "fixtures", "outbox-poll-failed-plain.json") as OutboxLife;
/** Sam's row: try 1 failed with 4006 and no receipt came within the minute, so try 2 went under a new key. */
const fourOhOhSix = json("outbox-effects", "fixtures", "outbox-4006-new-key.json") as OutboxLife;

const AT = "2026-10-23T14:05:03Z";

const words = (key: string): SendPartRequest => ({ ...sendText, idempotencyKey: key });
const poll = (key: string): SendPartRequest => ({ ...sendPoll, idempotencyKey: key });
/** A refused poll's plain retry: words, the options typed (arch 07 line 367). */
const typedOptions = (key: string): SendPartRequest => ({
  ...sendText,
  idempotencyKey: key,
  text: sendPoll.options.join("\n"),
});

function accepted(messageId: string): SendPartOutcome {
  return {
    result: "accepted",
    providerMessageId: messageId,
    providerOptionIds: null,
    chatId: sendText.chatId,
    service: "imessage",
    acceptedAt: AT,
  };
}

/** A K-07 fixture row as written under the skeleton's trace, so the outbox reader reads it under that trace. */
function underSkeleton(life: OutboxLife): OutboxLife {
  const copy = structuredClone(life);
  return { ...copy, row: { ...copy.row, traceId: skeleton.trace_id } };
}

/** The run's report: the skeleton's trace, the double's parts and reports, and these outbox rows (null: no reader). */
async function report(linq: LinqDouble, rows: readonly OutboxLife[] | null = null): Promise<RunReport> {
  return checkRun({
    target: "local",
    traceId: skeleton.trace_id,
    trace: skeleton,
    traceProblems: [],
    parts: partsOf(linq),
    linqEvents: linq.events(),
    outbox: rows === null ? null : await checkOutboxRows(rows.map(underSkeleton), skeleton.trace_id),
  });
}

describe("a retry under the same key is one message (K-07 retry rule 1; Linq dedupes by the key)", () => {
  const key = "out-maya-class-joined/1/1";

  it("no answer, then K-07's retry on the same key: C-211 records the key twice, and the run passes", async () => {
    const linq = new RecordingLinqDouble();
    linq.failNextSend({ kind: "transient", httpStatus: null });
    expect(linq.sendPart(words(key))).toMatchObject({
      result: "failed",
      kind: "transient",
      httpStatus: null,
    });
    expect(linq.sendPart(words(key))).toMatchObject({ result: "accepted" });
    const parts = partsOf(linq);
    expect(parts.map((part) => [part.sent.idempotencyKey, part.outcome?.result])).toEqual([
      [key, "failed"],
      [key, "accepted"],
    ]);
    expect(checkParts(parts, { events: linq.events() })).toEqual({
      parts: 2,
      sends: 1,
      duplicateSends: [],
      unjudgedSends: [],
      repeatedKeys: [key],
    });
    expect((await report(linq)).problems).toEqual([]);
    const withRow = await report(linq, [claimLapsed]);
    expect(withRow.problems).toEqual([]);
    expect([withRow.outboxRows, withRow.parts.sends]).toEqual([1, 1]);
  });

  it("accepted, then sent again on the same key after the claim lapsed: one message whether the double records the repeat or not", async () => {
    // K-11 v1 README, "The double": "records every sendPart request in order".
    const every = new RecordingLinqDouble({ recordRepeats: true });
    const first = every.sendPart(words(key));
    expect(every.sendPart(words(key))).toEqual(first);
    // A request K-11 refuses is no part, either way.
    expect(every.sendPart({ ...words(key), kind: "fax" })).toMatchObject({
      result: "failed",
      kind: "refused",
    });
    expect(every.rejectedRequests()).toHaveLength(1);
    expect(partsOf(every).map((part) => [part.sent.idempotencyKey, part.outcome])).toEqual([
      [key, first],
      [key, first],
    ]);
    expect(checkParts(partsOf(every), { events: every.events() })).toEqual({
      parts: 2,
      sends: 1,
      duplicateSends: [],
      unjudgedSends: [],
      repeatedKeys: [key],
    });
    expect((await report(every, [claimLapsed])).problems).toEqual([]);

    // C-211's own record (adapters/src/linq/double/double.ts, sendPart): a repeat under a stored key, once.
    const once = new RecordingLinqDouble();
    once.sendPart(words(key));
    once.sendPart(words(key));
    expect(partsOf(once)).toHaveLength(1);
    expect((await report(once, [claimLapsed])).problems).toEqual([]);
  });

  it("still fails the part when it also went under its next key with no failure reported: two messages", async () => {
    const next = "out-maya-class-joined/1/2";
    const linq = new RecordingLinqDouble();
    linq.failNextSend({ kind: "transient", httpStatus: null });
    linq.sendPart(words(key));
    linq.sendPart(words(key));
    linq.sendPart(words(next));
    expect(checkParts(partsOf(linq), { events: linq.events() })).toEqual({
      parts: 3,
      sends: 2,
      duplicateSends: [
        {
          part: "out-maya-class-joined/1",
          deliveries: [
            { key, messageId: "linq-msg-double-0001" },
            { key: next, messageId: "linq-msg-double-0002" },
          ],
        },
      ],
      unjudgedSends: [],
      repeatedKeys: [key],
    });
    expect((await report(linq)).problems).toEqual([
      "part out-maya-class-joined/1 reached the person 2 times (out-maya-class-joined/1/1 (linq-msg-double-0001), out-maya-class-joined/1/2 (linq-msg-double-0002)): each part once",
    ]);
  });

  it("still fails one key accepted as two messages: Linq's dedupe did not hold", () => {
    const one: SentPart = { at: AT, sent: words(key), outcome: accepted("linq-msg-demo-0080") };
    const other: SentPart = { at: AT, sent: words(key), outcome: accepted("linq-msg-demo-0081") };
    expect(checkParts([one, one], { events: [] }).duplicateSends).toEqual([]);
    expect(checkParts([one, other], { events: [] })).toEqual({
      parts: 2,
      sends: 2,
      duplicateSends: [
        {
          part: "out-maya-class-joined/1",
          deliveries: [
            { key, messageId: "linq-msg-demo-0080" },
            { key, messageId: "linq-msg-demo-0081" },
          ],
        },
      ],
      unjudgedSends: [],
      repeatedKeys: [key],
    });
  });
});

describe("a part accepted, then reported failed, and sent again under its next key reached the person once (K-07 sent -> failed)", () => {
  const theWords = "out-a7-03-alex-again/1/1";
  const thePoll = "out-a7-03-alex-again/2/1";
  const typed = "out-a7-03-alex-again/2/2";

  /** outbox-poll-failed-plain.json's three sends through the double: the words, the poll, the options typed. */
  function sendAll(linq: LinqDouble, beforeTyped: () => void = () => undefined): void {
    linq.sendPart(words(theWords));
    linq.sendPart(poll(thePoll));
    beforeTyped();
    linq.sendPart(typedOptions(typed));
  }

  it("by K-07's part states from the outbox reader, when the failure reached the gateway but not the double's record", async () => {
    const linq = new RecordingLinqDouble();
    sendAll(linq);
    expect(linq.events()).toEqual([]);
    expect(checkParts(partsOf(linq), { events: linq.events(), rows: [pollFailedPlain] })).toEqual({
      parts: 3,
      sends: 2,
      duplicateSends: [],
      unjudgedSends: [],
      repeatedKeys: [],
    });
    const run = await report(linq, [pollFailedPlain]);
    expect(run.problems).toEqual([]);
    expect([run.outboxRows, run.parts.sends]).toEqual([1, 2]);
  });

  it("by the Linq double's failure report on the poll's key (fakeFailure), with no outbox reader", async () => {
    const linq = new RecordingLinqDouble();
    sendAll(linq, () => {
      expect(linq.fakeFailure("poll.failed", thePoll, "poll failed")).toMatchObject({
        kind: "failed",
        partKey: thePoll,
        messageId: "linq-msg-double-0002",
      });
    });
    expect(checkParts(partsOf(linq), { events: linq.events() })).toMatchObject({
      sends: 2,
      duplicateSends: [],
      unjudgedSends: [],
    });
    expect((await report(linq)).problems).toEqual([]);
  });

  it("by a failure report that names the poll's message and no key, as Linq's poll.failed does", () => {
    const linq = new RecordingLinqDouble();
    sendAll(linq);
    const failed: DoubleEvent = {
      kind: "failed",
      at: AT,
      partKey: null,
      messageId: "linq-msg-double-0002",
      code: "poll.failed",
      reason: "poll failed",
    };
    expect(checkParts(partsOf(linq), { events: [failed] })).toMatchObject({ sends: 2, duplicateSends: [] });
  });

  it("still fails two live deliveries of one part: both tries accepted and neither reported failed", async () => {
    const linq = new RecordingLinqDouble();
    sendAll(linq);
    const twice = {
      part: "out-a7-03-alex-again/2",
      deliveries: [
        { key: thePoll, messageId: "linq-msg-double-0002" },
        { key: typed, messageId: "linq-msg-double-0003" },
      ],
    };
    expect(checkParts(partsOf(linq), { events: linq.events() })).toEqual({
      parts: 3,
      sends: 3,
      duplicateSends: [twice],
      unjudgedSends: [],
      repeatedKeys: [],
    });
    expect((await report(linq)).problems).toEqual([
      "part out-a7-03-alex-again/2 reached the person 2 times (out-a7-03-alex-again/2/1 (linq-msg-double-0002), out-a7-03-alex-again/2/2 (linq-msg-double-0003)): each part once",
    ]);
    // K-07's part states that say both tries were delivered.
    const bothDelivered = structuredClone(pollFailedPlain);
    bothDelivered.parts = bothDelivered.parts.map((part) =>
      part.idempotencyKey === thePoll ? { ...part, state: "delivered" as const } : part,
    );
    expect(checkParts(partsOf(linq), { events: [], rows: [bothDelivered] }).duplicateSends).toEqual([twice]);
  });

  it("still fails it when the failure reported is another part's (the words'), not the poll's", () => {
    const linq = new RecordingLinqDouble();
    sendAll(linq, () => linq.fakeFailure("4001", theWords));
    expect(checkParts(partsOf(linq), { events: linq.events() })).toMatchObject({
      sends: 2,
      duplicateSends: [{ part: "out-a7-03-alex-again/2" }],
    });
  });
});

describe("a 4006 (K-07 retry rule 2): a new key only if no receipt came", () => {
  const first = "out-sam-booked-riley/1/1";
  const second = "out-sam-booked-riley/1/2";

  it("no receipt within the minute, then the new key: one message (outbox-4006-new-key.json)", async () => {
    const linq = new RecordingLinqDouble();
    linq.failNextSend({ kind: "mayStillDeliver", code: "4006" });
    expect(linq.sendPart(words(first))).toMatchObject({ result: "failed", kind: "mayStillDeliver" });
    linq.sendPart(words(second));
    expect(checkParts(partsOf(linq), { events: linq.events() })).toMatchObject({
      sends: 1,
      duplicateSends: [],
    });
    expect((await report(linq, [fourOhOhSix])).problems).toEqual([]);
  });

  it("its receipt came, so the try reached the person: alone it is one message, and a new key beside it is a duplicate", () => {
    const linq = new RecordingLinqDouble();
    linq.failNextSend({ kind: "mayStillDeliver", code: "4006" });
    linq.sendPart(words(first));
    linq.fakeDelivered(first);
    expect(checkParts(partsOf(linq), { events: linq.events() })).toMatchObject({
      sends: 1,
      duplicateSends: [],
    });
    linq.sendPart(words(second));
    expect(checkParts(partsOf(linq), { events: linq.events() }).duplicateSends).toEqual([
      {
        part: "out-sam-booked-riley/1",
        deliveries: [
          { key: first, messageId: null },
          { key: second, messageId: "linq-msg-double-0001" },
        ],
      },
    ]);
  });
});

describe("a target that reads no K-07 part state and no failure report (staging: K-21 v1 testPhoneParts)", () => {
  it("neither clears a part sent under two keys nor calls it a duplicate: one delivery cannot be shown", () => {
    const linq = new RecordingLinqDouble();
    linq.sendPart(poll("out-a7-03-alex-again/2/1"));
    linq.sendPart(typedOptions("out-a7-03-alex-again/2/2"));
    const deliveries = [
      { key: "out-a7-03-alex-again/2/1", messageId: "linq-msg-double-0001" },
      { key: "out-a7-03-alex-again/2/2", messageId: "linq-msg-double-0002" },
    ];
    expect(checkParts(partsOf(linq))).toEqual({
      parts: 2,
      sends: 2,
      duplicateSends: [],
      unjudgedSends: [{ part: "out-a7-03-alex-again/2", deliveries }],
      repeatedKeys: [],
    });
    const run = checkRun({
      target: "staging",
      traceId: skeleton.trace_id,
      trace: skeleton,
      traceProblems: [],
      parts: partsOf(linq),
      linqEvents: null,
      outbox: null,
    });
    expect(run.problems).toEqual([
      "part out-a7-03-alex-again/2 went as 2 messages (out-a7-03-alex-again/2/1 (linq-msg-double-0001), out-a7-03-alex-again/2/2 (linq-msg-double-0002)) and no K-07 part state or Linq double report was read for them: one delivery cannot be shown",
    ]);
  });

  it("takes a retry on the same key as one message there too", () => {
    const linq = new RecordingLinqDouble();
    linq.failNextSend({ kind: "transient", httpStatus: null });
    linq.sendPart(words("out-a7-03-alex/1/1"));
    linq.sendPart(words("out-a7-03-alex/1/1"));
    expect(checkParts(partsOf(linq))).toEqual({
      parts: 2,
      sends: 1,
      duplicateSends: [],
      unjudgedSends: [],
      repeatedKeys: ["out-a7-03-alex/1/1"],
    });
  });
});
