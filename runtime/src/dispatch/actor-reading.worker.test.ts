// The recipient actor's reading of an outage line's row at send (T-1337; DL-656; RULES 7.2, 4.12), run inside the Workers
// runtime (Vitest project "workers") through the real dispatcher and limit 8 against the fakes of ./test-support.ts, which
// answer as K-05 v1.1's and K-11 v1's fixtures state. The row the shared core writes for K-01's outage line (K-09
// sendFixedLine, send class quick_reply) names the line among its final parts' fixed lines, as every fixed line's row
// does (K-05 README item 38; K-09 README default 139; compose-input-fixed-line-row.json names the stop reply's row by its
// line the same way). The port is a double here; ../outage/ai/lease.worker.test.ts proves it answered by the real actor,
// and ../wiring/root.test.ts proves the root joins it. Test values only (rule 9): the master's sample cast, 555-01xx.
import fixedLinesFixture from "../../../contracts/bundle/fixtures/fixed-lines.json";
import { describe, expect, it } from "vitest";

import { OUTAGE_LINE_ID } from "../outage/ai/outage";
import type { Span } from "../trace";
import {
  ACTOR_READING_MS,
  isOutageLine,
  runDispatch,
  type DispatchDeps,
  type DispatchReport,
} from "./dispatcher";
import {
  FakeClock,
  FakeLinq,
  FakeOutboxStore,
  FakeRecipients,
  FakeSendState,
  traceCollector,
  words,
  type SeedRow,
} from "./test-support";
import type { ChatTarget, ClaimedRow } from "./types";

const SAM: ChatTarget = { to: "+15555550100", chatId: "linq-chat-demo-sam", service: "imessage" };

/** K-01's outage line, word for word as the fixture bundle holds it: the words the core writes into the row. */
const OUTAGE_TEXT =
  (fixedLinesFixture as { lines: { id: string; text: string | null }[] }).lines.find(
    (line) => line.id === "outage",
  )?.text ?? "(no outage line)";

/** The outage line's row for one of Sam's texts, as the core writes it: one words part, quick_reply, the line's id. */
const outageRow = (overrides: Partial<SeedRow> = {}): SeedRow => ({
  id: "out-safety-evt-sam-0001-outage",
  recipient: "handle-sam",
  commitSeq: 1,
  sends: [words(OUTAGE_TEXT)],
  sendClass: "quick_reply",
  fixedLines: [OUTAGE_LINE_ID],
  ...overrides,
});

/** The actor's port as a double: what it answers, and each recipient it was asked for, in order. */
interface Port {
  answer: () => Promise<boolean>;
  readonly asked: string[];
  readonly ask: NonNullable<DispatchDeps["mayHaveStopped"]>;
}

function port(answer: () => Promise<boolean>): Port {
  const asked: string[] = [];
  const made: Port = {
    answer,
    asked,
    ask: (recipientHandleId) => {
      asked.push(recipientHandleId);
      return made.answer();
    },
  };
  return made;
}

/** A port whose answer is any value at all, as a reply over RPC can be: the dispatcher reads only exactly false. */
const answering = (value: unknown): Port => port(() => Promise.resolve(value as boolean));

interface Setup {
  clock: FakeClock;
  store: FakeOutboxStore;
  linq: FakeLinq;
  recipients: FakeRecipients;
  sendState: FakeSendState;
  spans: Span[];
  /** Every await of the run the test can see, in order: the send-state reads, the renewals, the ask and the send. */
  log: string[];
  deps: (reading: Port | null) => DispatchDeps;
}

function setup(seeds: readonly SeedRow[]): Setup {
  const clock = new FakeClock("2026-11-07T15:06:35.000Z");
  const store = new FakeOutboxStore(seeds);
  const linq = new FakeLinq(clock.now);
  const recipients = new FakeRecipients({ "handle-sam": SAM });
  const sendState = new FakeSendState();
  const spans: Span[] = [];
  const log: string[] = [];
  const traceFor = traceCollector(spans);
  return {
    clock,
    store,
    linq,
    recipients,
    sendState,
    spans,
    log,
    deps: (reading) => ({
      store: {
        claimOutbox: (request) => store.claimOutbox(request),
        renewClaim: (request) => {
          log.push("renewClaim");
          return store.renewClaim(request);
        },
        markPart: (request) => store.markPart(request),
        markRow: (request) => {
          log.push(`markRow:${request.outcome}`);
          return store.markRow(request);
        },
      },
      linq: {
        sendPart: (request) => {
          log.push("sendPart");
          return linq.sendPart(request);
        },
      },
      recipients,
      sendState: {
        sendStateFor: (row) => {
          log.push("sendState");
          return sendState.sendStateFor(row);
        },
      },
      environment: "production",
      traceFor,
      now: clock.now,
      claimer: "dispatcher-1",
      ...(reading === null
        ? {}
        : {
            mayHaveStopped: (recipientHandleId: string) => {
              log.push("mayHaveStopped");
              return reading.ask(recipientHandleId);
            },
          }),
    }),
  };
}

const outcomes = (report: DispatchReport): [string, string, number][] =>
  report.rows.map((row) => [row.outboxRowId, row.outcome, row.partsSent]);

describe("which rows the actor is asked about (T-1337)", () => {
  it("only a row whose final parts name K-01's outage line: the line's id is outage/ai's OUTAGE_LINE_ID", () => {
    const claimed = (fixedLines: string[], sendClass = "quick_reply"): ClaimedRow =>
      ({ sendClass, finalParts: { fixedLines } }) as unknown as ClaimedRow;
    expect(OUTAGE_LINE_ID).toBe("outage");
    expect(isOutageLine(claimed(["outage"]))).toBe(true);
    expect(isOutageLine(claimed(["opener", "outage"], "routine"))).toBe(true);
    expect(isOutageLine(claimed([]))).toBe(false);
    expect(isOutageLine(claimed(["stopReply"]))).toBe(false);
    expect(isOutageLine(claimed(["safetyEmergency"], "safety"))).toBe(false);
  });

  it("never a safety line, a stop reply, a routine row or a quick reply that carries no outage line: each goes as limit 8 decides, the port never asked", async () => {
    const t = setup([
      outageRow({ id: "out-sam-safety", sendClass: "safety", fixedLines: ["safetyEmergency"], commitSeq: 1 }),
      outageRow({ id: "out-sam-stop-reply", fixedLines: ["stopReply"], commitSeq: 2 }),
      outageRow({ id: "out-sam-routine", sendClass: "routine", fixedLines: [], commitSeq: 3 }),
      outageRow({ id: "out-sam-quick", fixedLines: [], commitSeq: 4 }),
    ]);
    const reading = answering(true);

    const report = await runDispatch(t.deps(reading));

    expect(outcomes(report)).toEqual([
      ["out-sam-safety", "sent", 1],
      ["out-sam-stop-reply", "sent", 1],
      ["out-sam-routine", "sent", 1],
      ["out-sam-quick", "sent", 1],
    ]);
    expect(reading.asked).toEqual([]);
  });
});

describe("the actor's reading decides an outage line's row at send (T-1337; RULES 7.2)", () => {
  it("false: the part goes once, under its part key, as limit 8 decided; a second run sends nothing more", async () => {
    const t = setup([outageRow()]);
    const reading = answering(false);

    expect(outcomes(await runDispatch(t.deps(reading)))).toEqual([
      ["out-safety-evt-sam-0001-outage", "sent", 1],
    ]);
    expect(
      t.linq.requests.map((request) => [request.idempotencyKey, request.text, request.overrideOptout]),
    ).toEqual([["out-safety-evt-sam-0001-outage/1/1", OUTAGE_TEXT, false]]);
    expect(reading.asked).toEqual(["handle-sam"]);

    expect((await runDispatch(t.deps(reading))).claimed).toBe(0);
    expect(t.linq.requests).toHaveLength(1);
    expect(reading.asked).toEqual(["handle-sam"]);
    // The pass is on the span as a label.
    expect(t.spans.find((span) => span.hop === "dispatch")).toMatchObject({
      outcome: "ok",
      decided: { result: "sent", actorReading: "notStopped" },
    });
  });

  it("is the last await before the send: once per part, after limit 8's read, the renewal and the stopped flag's second read, nothing awaited after it", async () => {
    const t = setup([outageRow({ sends: [words(OUTAGE_TEXT), words("Second part.")] })]);
    const reading = answering(false);

    await runDispatch(t.deps(reading));

    const part = ["sendState", "renewClaim", "sendState", "mayHaveStopped", "sendPart"];
    expect(t.log).toEqual([...part, ...part]);
    expect(reading.asked).toEqual(["handle-sam", "handle-sam"]);
  });

  it("true: nothing is sent and the row is dropped as stopped (markRow droppedStopped at the run's version); the span says the actor's reading decided it", async () => {
    const t = setup([outageRow()]);
    const reading = answering(true);

    const report = await runDispatch(t.deps(reading));

    expect(outcomes(report)).toEqual([["out-safety-evt-sam-0001-outage", "droppedStopped", 0]]);
    expect(t.linq.requests).toEqual([]);
    expect(t.store.marks).toEqual([]);
    expect(t.store.rowMarks).toEqual([
      {
        request: {
          outboxRowId: "out-safety-evt-sam-0001-outage",
          // Claimed at version 3 + 1: the claim's version, the one the run holds.
          expectVersion: 4,
          outcome: "droppedStopped",
          heldUntil: null,
          at: "2026-11-07T15:06:35.000Z",
        },
        answer: "droppedStopped",
      },
    ]);
    expect(t.store.row("out-safety-evt-sam-0001-outage").state).toBe("dropped_stopped");
    const dispatch = t.spans.find((span) => span.hop === "dispatch");
    expect(dispatch).toMatchObject({
      outcome: "dropped",
      limits: [{ limit: 8, result: "fail", outcome: "droppedStopped" }],
      decided: { result: "droppedStopped", actorReading: "stopped" },
      error_code: null,
    });
    // No send was attempted: the span names no provider call.
    expect(dispatch?.provider).toBeUndefined();
    expect(dispatch?.call).toBeUndefined();
    expect(JSON.stringify(t.spans)).not.toContain("Rosie is down");

    // Dropped, never held: a later run claims nothing and sends nothing.
    expect((await runDispatch(t.deps(answering(false)))).claimed).toBe(0);
    expect(t.linq.requests).toEqual([]);
  });

  it("a STOP the actor takes while the run waits on the chat lookup or the renewal is read at the ask: nothing is sent", async () => {
    for (const during of ["chatFor", "renewClaim"] as const) {
      const t = setup([outageRow()]);
      let stopTaken = false;
      const reading = port(() => Promise.resolve(stopTaken));
      if (during === "chatFor") {
        t.recipients.beforeAnswer = (): Promise<void> => {
          stopTaken = true;
          return Promise.resolve();
        };
      }
      const deps = t.deps(reading);
      const store = deps.store;
      const report = await runDispatch({
        ...deps,
        store: {
          ...store,
          renewClaim: (request) => {
            if (during === "renewClaim") stopTaken = true;
            return store.renewClaim(request);
          },
        },
      });

      expect(outcomes(report)).toEqual([["out-safety-evt-sam-0001-outage", "droppedStopped", 0]]);
      expect(t.linq.requests).toEqual([]);
    }
  });

  it("a mark the store does not take is storeError: nothing is sent, and the row keeps its claim for its lapse", async () => {
    const t = setup([outageRow()]);
    const deps = t.deps(answering(true));
    const report = await runDispatch({
      ...deps,
      store: {
        ...deps.store,
        markRow: () => Promise.resolve({ error: "transient", sqlstate: "40001" }),
      },
    });

    expect(outcomes(report)).toEqual([["out-safety-evt-sam-0001-outage", "storeError", 0]]);
    expect(t.linq.requests).toEqual([]);
    expect(t.store.row("out-safety-evt-sam-0001-outage").state).toBe("sending");
    expect(t.spans.find((span) => span.hop === "dispatch")).toMatchObject({
      decided: { result: "storeError", actorReading: "stopped" },
      error_code: "transient",
    });
  });
});

describe("the actor's reading fails closed: anything but exactly false drops the row with nothing sent (RULES 7.2: 'Unsure: treat it as a stop')", () => {
  const cases: { what: string; reading: () => Port | null; label: string; waitMs?: number }[] = [
    { what: "no port joined", reading: () => null, label: "noPort" },
    {
      what: "a port that throws",
      reading: () =>
        port(() => {
          throw new Error("the actor cannot be reached");
        }),
      label: "threw",
    },
    {
      what: "a rejected call (an actor that cannot be named)",
      reading: () => port(() => Promise.reject(new Error("no handle actor can be named"))),
      label: "threw",
    },
    {
      what: "an answer that is not a boolean: the word false",
      reading: () => answering("false"),
      label: "notBoolean",
    },
    { what: "an answer that is not a boolean: 0", reading: () => answering(0), label: "notBoolean" },
    { what: "an answer that is not a boolean: null", reading: () => answering(null), label: "notBoolean" },
    { what: "no answer at all: undefined", reading: () => answering(undefined), label: "notBoolean" },
    {
      what: "a call never answered within the wait",
      reading: () => port(() => new Promise<boolean>(() => undefined)),
      label: "noAnswer",
      waitMs: 30,
    },
  ];

  it.each(cases)("$what", async ({ reading, label, waitMs }) => {
    const t = setup([outageRow()]);
    const deps = t.deps(reading());

    const report = await runDispatch(waitMs === undefined ? deps : { ...deps, actorReadingMs: waitMs });

    expect(outcomes(report)).toEqual([["out-safety-evt-sam-0001-outage", "droppedStopped", 0]]);
    expect(t.linq.requests).toEqual([]);
    expect(t.store.row("out-safety-evt-sam-0001-outage").state).toBe("dropped_stopped");
    expect(t.spans.find((span) => span.hop === "dispatch")).toMatchObject({
      outcome: "dropped",
      decided: { result: "droppedStopped", actorReading: label },
    });
  });

  it("waits ACTOR_READING_MS by default: far below the claim's 60 s", () => {
    expect(ACTOR_READING_MS).toBe(5_000);
  });
});

describe("what stays as it was (T-1337)", () => {
  it("the recipient's safety line and stop reply claimed after the dropped row still go, with the override limit 8 sets", async () => {
    const t = setup([
      outageRow({ commitSeq: 1 }),
      outageRow({ id: "out-sam-safety", sendClass: "safety", fixedLines: ["safetyEmergency"], commitSeq: 2 }),
      outageRow({ id: "out-sam-stop-reply", fixedLines: ["stopReply"], commitSeq: 3 }),
    ]);
    const reading = answering(true);

    const report = await runDispatch(t.deps(reading));

    expect(outcomes(report)).toEqual([
      ["out-safety-evt-sam-0001-outage", "droppedStopped", 0],
      ["out-sam-safety", "sent", 1],
      ["out-sam-stop-reply", "sent", 1],
    ]);
    expect(t.linq.requests.map((request) => request.idempotencyKey)).toEqual([
      "out-sam-safety/1/1",
      "out-sam-stop-reply/1/1",
    ]);
    expect(reading.asked).toEqual(["handle-sam"]);

    // Once the STOP has committed (the stopped flag set), the safety line goes with the opt-out override, as today.
    const stopped = setup([
      outageRow({ id: "out-sam-safety", sendClass: "safety", fixedLines: ["safetyEmergency"], commitSeq: 2 }),
    ]);
    stopped.sendState.forHandle("handle-sam", { stopped: true, chatOpen: false });
    await runDispatch(stopped.deps(answering(true)));
    expect(stopped.linq.requests.map((request) => request.overrideOptout)).toEqual([true]);
  });

  it("after the STOP commits, limit 8 drops the row as it does today, before any ask", async () => {
    const t = setup([outageRow()]);
    t.sendState.forHandle("handle-sam", { stopped: true, chatOpen: false });
    const reading = answering(false);

    const report = await runDispatch(t.deps(reading));

    expect(outcomes(report)).toEqual([["out-safety-evt-sam-0001-outage", "droppedStopped", 0]]);
    expect(t.linq.requests).toEqual([]);
    expect(reading.asked).toEqual([]);
    expect(t.spans.find((span) => span.hop === "dispatch")?.decided).not.toHaveProperty("actorReading");
  });

  it("a stop that commits during the chat lookup is still dropped by the stopped flag's second read, before the ask", async () => {
    const t = setup([outageRow()]);
    t.recipients.beforeAnswer = (): Promise<void> => {
      t.sendState.forHandle("handle-sam", { stopped: true });
      return Promise.resolve();
    };
    const reading = answering(false);

    const report = await runDispatch(t.deps(reading));

    expect(outcomes(report)).toEqual([["out-safety-evt-sam-0001-outage", "droppedStopped", 0]]);
    expect(t.linq.requests).toEqual([]);
    expect(reading.asked).toEqual([]);
  });
});
