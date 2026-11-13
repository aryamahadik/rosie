// The danger line's safety run and the safety-first order (T-1352; DL-687, DL-698; K-05 v1.14 item 67, defaults 129 to
// 135; RULES 4.12, 7.2), run inside the Workers runtime (Vitest project "workers") through the real dispatcher and limit 8
// against the fakes of ./test-support.ts, whose K-05 outbox double answers v1.14's safety-only claim. The rows are Sam's:
// an outage line's row (send class quick_reply, K-01's outage line among its fixed lines), routine rows and danger lines'
// rows (send class safety, safetyEmergency). The real actor's side is ../outage/ai/lease.worker.test.ts's (T-1337's rig),
// and the root's danger wake is ../wiring/root.test.ts's. Test values only (rule 9): the master's sample cast, 555-01xx.
import fixedLinesFixture from "../../../contracts/bundle/fixtures/fixed-lines.json";
import { describe, expect, it } from "vitest";

import { OUTAGE_LINE_ID } from "../outage/ai/outage";
import type { Span } from "../trace";
import { NOT_SAFETY_CLASS, runDispatch, type DispatchDeps, type DispatchReport } from "./dispatcher";
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
import type {
  ChatTarget,
  ClaimOutboxRequest,
  ClaimOutboxResponse,
  LinqFailed,
  OutboxStore,
  TransientError,
} from "./types";

const SAM: ChatTarget = { to: "+15555550100", chatId: "linq-chat-demo-sam", service: "imessage" };
const ALEX: ChatTarget = { to: "+15555550101", chatId: "linq-chat-demo-alex", service: "imessage" };
/** 10:06am in New York: inside every text hour, so no row here waits for them. */
const NOW = "2026-11-07T15:06:35.000Z";

/** A K-01 fixed line's words, as the fixture bundle holds them. */
const lineText = (id: string): string =>
  (fixedLinesFixture as { lines: { id: string; text: string | null }[] }).lines.find((line) => line.id === id)
    ?.text ?? `(no ${id} line)`;

/** An outage line's row, as the core writes it (K-09 sendFixedLine): row S's kind. */
const outageRow = (id: string, commitSeq: number): SeedRow => ({
  id,
  recipient: "handle-sam",
  commitSeq,
  sends: [words(lineText("outage"))],
  sendClass: "quick_reply",
  fixedLines: [OUTAGE_LINE_ID],
});

/** A routine row of a turn's commit. */
const routineRow = (id: string, commitSeq: number, overrides: Partial<SeedRow> = {}): SeedRow => ({
  id,
  recipient: "handle-sam",
  commitSeq,
  sends: [words("Test words: your visit is Saturday at 10.")],
  ...overrides,
});

/** A danger line's row, as the core writes it (K-09 recordSafetyOutcome's safetyLine): send class safety. */
const safetyRow = (id: string, commitSeq: number, overrides: Partial<SeedRow> = {}): SeedRow => ({
  id,
  recipient: "handle-sam",
  commitSeq,
  sends: [words(lineText("safetyEmergency"))],
  sendClass: "safety",
  fixedLines: ["safetyEmergency"],
  ...overrides,
});

/** Linq's no answer (K-11 transient): the part's next try goes under the same key (K-07 rule 1). */
const NO_ANSWER: LinqFailed = {
  result: "failed",
  kind: "transient",
  httpStatus: null,
  code: null,
  reason: "no answer",
  retryAfterSeconds: null,
  providerMessageId: null,
};

/** A gate a test opens: it holds a run at a point until `open` is called. */
function gate(): {
  entered: Promise<void>;
  markEntered: () => void;
  released: Promise<void>;
  open: () => void;
} {
  let markEntered = (): void => undefined;
  let open = (): void => undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { entered, markEntered, released, open };
}

interface Setup {
  clock: FakeClock;
  store: FakeOutboxStore;
  linq: FakeLinq;
  sendState: FakeSendState;
  spans: Span[];
  /** Each recipient T-1337's reading was asked for (it answers false: nothing waits). */
  asked: string[];
  /** The dispatcher's ports, over the outbox double or the store a test puts in front of it. */
  deps(store?: OutboxStore): DispatchDeps;
}

function setup(seeds: readonly SeedRow[]): Setup {
  const clock = new FakeClock(NOW);
  const store = new FakeOutboxStore(seeds);
  const linq = new FakeLinq(clock.now);
  const recipients = new FakeRecipients({ "handle-sam": SAM, "handle-alex": ALEX });
  const sendState = new FakeSendState();
  const spans: Span[] = [];
  const asked: string[] = [];
  const traceFor = traceCollector(spans);
  return {
    clock,
    store,
    linq,
    sendState,
    spans,
    asked,
    deps: (over = store) => ({
      store: over,
      linq,
      recipients,
      sendState,
      environment: "production",
      traceFor,
      now: clock.now,
      claimer: "dispatcher-1",
      mayHaveStopped: (recipientHandleId) => {
        asked.push(recipientHandleId);
        return Promise.resolve(false);
      },
    }),
  };
}

const outcomes = (report: DispatchReport): [string, string, number][] =>
  report.rows.map((row) => [row.outboxRowId, row.outcome, row.partsSent]);

const keys = (t: Setup): string[] => t.linq.requests.map((request) => request.idempotencyKey);

/** The rows a claim took, in its answer's order. */
function took(answer: ClaimOutboxResponse | TransientError): string[] {
  if ("error" in answer) throw new Error("the claim answered transient");
  return answer.claimed.map((row) => row.outboxRowId);
}

/** A claim of Sam's rows, with v1.14's field when `safety`. */
const claimOf = (now: string, limit: number, safety: boolean): ClaimOutboxRequest => ({
  claimer: "dispatcher-2",
  recipientHandleId: "handle-sam",
  now,
  limit,
  ...(safety ? { sendClass: "safety" as const } : {}),
});

describe("the danger line's safety run (T-1352; K-05 v1.14 item 67)", () => {
  it("takes its row past another run's live claim on an earlier row and sends it while that run is held before its send; that row then goes after it, once, and neither row goes twice", async () => {
    const t = setup([outageRow("out-sam-s", 1)]);
    // Row S's run (an outage line's writer's wake) claims row S and is held at S's renewal: no part of S has gone.
    const held = gate();
    const sRun = runDispatch(
      t.deps({
        claimOutbox: (request) => t.store.claimOutbox(request),
        renewClaim: async (request) => {
          if (request.outboxRowId === "out-sam-s") {
            held.markEntered();
            await held.released;
          }
          return t.store.renewClaim(request);
        },
        markPart: (request) => t.store.markPart(request),
        markRow: (request) => t.store.markRow(request),
      }),
      { recipientHandleId: "handle-sam" },
    );
    await held.entered;
    // The core writes the danger line's row D after S, and D's own wake runs its safety run.
    t.store.write(safetyRow("out-sam-d", 2));

    const danger = await runDispatch(t.deps(), { recipientHandleId: "handle-sam", sendClass: "safety" });

    expect(outcomes(danger)).toEqual([["out-sam-d", "sent", 1]]);
    expect(keys(t)).toEqual(["out-sam-d/1/1"]);
    expect(t.store.row("out-sam-d").state).toBe("sent");
    expect(t.store.row("out-sam-s").state).toBe("sending");
    // Two claims: S's run's took S, and the safety claim took D alone, passing S's live claim.
    expect(t.store.claims.map((claim) => [claim.request.sendClass ?? null, claim.took])).toEqual([
      [null, ["out-sam-s"]],
      ["safety", ["out-sam-d"]],
    ]);
    // A safety row is never asked (T-1337's ask is an outage row's alone).
    expect(t.asked).toEqual([]);

    held.open();
    expect(outcomes(await sRun)).toEqual([["out-sam-s", "sent", 1]]);
    expect(keys(t)).toEqual(["out-sam-d/1/1", "out-sam-s/1/1"]);
    expect(t.asked).toEqual(["handle-sam"]);
    // A later run of every class finds nothing more to send.
    expect((await runDispatch(t.deps(), { recipientHandleId: "handle-sam" })).claimed).toBe(0);
    expect(keys(t)).toHaveLength(2);
  });

  it("claims and sends no row of another class: a checked routine row and an outage row before the danger row stay as they are, unread and unsent", async () => {
    const t = setup([routineRow("out-sam-r", 1), outageRow("out-sam-s", 2), safetyRow("out-sam-d", 3)]);

    const danger = await runDispatch(t.deps(), { recipientHandleId: "handle-sam", sendClass: "safety" });

    expect(outcomes(danger)).toEqual([["out-sam-d", "sent", 1]]);
    expect(keys(t)).toEqual(["out-sam-d/1/1"]);
    expect(t.store.row("out-sam-r")).toMatchObject({ state: "checked", version: 3, claim: null });
    expect(t.store.row("out-sam-s")).toMatchObject({ state: "checked", version: 3, claim: null });
    // Limit 8 read D's send state alone, twice (before the send and again right before it); no row was asked.
    expect(t.sendState.reads).toEqual(["out-sam-d", "out-sam-d"]);
    expect(t.asked).toEqual([]);
  });

  it("the guard: a store or a wrapper that drops the field hands back rows of every class, and the safety run sends only its safety row; each other row is a store fault, never read, sent or marked, its claim left to lapse, so a later run of every class sends it once (RULES 7.2: fails closed)", async () => {
    const t = setup([routineRow("out-sam-r", 1), outageRow("out-sam-s", 2), safetyRow("out-sam-d", 3)]);
    const dropping: OutboxStore = {
      claimOutbox: (request) => {
        const copy = { ...request };
        delete copy.sendClass;
        return t.store.claimOutbox(copy);
      },
      renewClaim: (request) => t.store.renewClaim(request),
      markPart: (request) => t.store.markPart(request),
      markRow: (request) => t.store.markRow(request),
    };

    const danger = await runDispatch(t.deps(dropping), {
      recipientHandleId: "handle-sam",
      sendClass: "safety",
    });

    // v1.13's claim took all three; the danger row went first, and the other two were refused.
    expect(t.store.claims.map((claim) => claim.took)).toEqual([["out-sam-r", "out-sam-s", "out-sam-d"]]);
    expect(outcomes(danger)).toEqual([
      ["out-sam-d", "sent", 1],
      ["out-sam-r", "storeError", 0],
      ["out-sam-s", "storeError", 0],
    ]);
    expect(keys(t)).toEqual(["out-sam-d/1/1"]);
    expect(t.sendState.reads).toEqual(["out-sam-d", "out-sam-d"]);
    expect(t.asked).toEqual([]);
    expect(t.store.rowMarks).toEqual([]);
    expect(t.store.marks.map((mark) => mark.outcome)).toEqual(["sent"]);
    for (const id of ["out-sam-r", "out-sam-s"]) {
      expect(t.store.row(id)).toMatchObject({
        state: "sending",
        claim: { lapsesAt: "2026-11-07T15:07:35.000Z" },
      });
    }
    expect(t.spans.filter((span) => span.hop === "dispatch").map((span) => span.outcome)).toEqual([
      "ok",
      "refused",
      "refused",
    ]);
    expect(t.spans.find((span) => span.rows?.[0]?.id === "out-sam-r")).toMatchObject({
      outcome: "refused",
      decided: { result: "storeError", claimNo: 1 },
      error_code: NOT_SAFETY_CLASS,
    });

    // Once their claims lapse, a run of every class takes them again with every check of its own, T-1337's ask included.
    t.clock.advance(61_000);
    const later = await runDispatch(t.deps(), { recipientHandleId: "handle-sam" });
    expect(outcomes(later)).toEqual([
      ["out-sam-r", "sent", 1],
      ["out-sam-s", "sent", 1],
    ]);
    expect(keys(t)).toEqual(["out-sam-d/1/1", "out-sam-r/1/1", "out-sam-s/1/1"]);
    expect(t.asked).toEqual(["handle-sam"]);
  });

  it("repeats a transient claim (untilNotTransient): two transient answers, then the third claim takes the danger row and it goes; three in a row claim nothing and send nothing", async () => {
    const t = setup([safetyRow("out-sam-d", 1)]);
    t.store.transientClaims = 2;

    const danger = await runDispatch(t.deps(), { recipientHandleId: "handle-sam", sendClass: "safety" });

    expect(t.store.claims.map((claim) => claim.took)).toEqual(["transient", "transient", ["out-sam-d"]]);
    expect(outcomes(danger)).toEqual([["out-sam-d", "sent", 1]]);

    const again = setup([safetyRow("out-sam-d", 1)]);
    again.store.transientClaims = 3;
    const none = await runDispatch(again.deps(), { recipientHandleId: "handle-sam", sendClass: "safety" });
    expect(none).toEqual({ claimError: "transient", claimed: 0, passedHeld: [], rows: [] });
    expect(again.store.claims.map((claim) => claim.took)).toEqual(["transient", "transient", "transient"]);
    expect(again.linq.requests).toEqual([]);
  });

  it("unchanged: a run of every class does not repeat its transient claim", async () => {
    const t = setup([safetyRow("out-sam-d", 1)]);
    t.store.transientClaims = 1;

    const report = await runDispatch(t.deps(), { recipientHandleId: "handle-sam" });

    expect(report).toEqual({ claimError: "transient", claimed: 0, passedHeld: [], rows: [] });
    expect(t.store.claims.map((claim) => claim.took)).toEqual(["transient"]);
  });

  it("is refused before anything is claimed when it names no recipient, or asks for any other class (K-05 v1.14 defaults 133 and 134): never run as a claim of every class", async () => {
    const t = setup([routineRow("out-sam-r", 1), safetyRow("out-sam-d", 2)]);

    await expect(runDispatch(t.deps(), { sendClass: "safety" })).rejects.toThrow(TypeError);
    await expect(
      runDispatch(t.deps(), {
        recipientHandleId: "handle-sam",
        sendClass: "routine" as unknown as "safety",
      }),
    ).rejects.toThrow(TypeError);

    expect(t.store.claims).toEqual([]);
    expect(t.linq.requests).toEqual([]);
    expect(t.store.row("out-sam-r").state).toBe("checked");
    expect(t.store.row("out-sam-d").state).toBe("checked");
  });
});

describe("the outbox double answers K-05 v1.14's safety walk as item 67 and defaults 129 to 135 state it", () => {
  it("passes a live claim of any class, waiting_chat, planned and stale rows, a held row not yet due (not listed) and a row it cannot take as it stands; takes a held row that is due and a checked row in commit order; reads, waits for and counts no row of another class; passedHeld empty; writes nothing for a row it passes; takes a lapsed claim and skips a finished row", async () => {
    const t = setup([
      outageRow("out-sam-s", 1),
      safetyRow("out-sam-d1", 2),
      safetyRow("out-sam-d2", 3),
      safetyRow("out-sam-d3", 4),
      routineRow("out-sam-planned", 5, { planned: true }),
      safetyRow("out-sam-d4", 6, { planned: true }),
      safetyRow("out-sam-d5", 7, { heldUntil: "2026-11-08T14:00:00.000Z" }),
      safetyRow("out-sam-d6", 8, { sends: [words("one"), words("two"), words("three")] }),
      ...Array.from({ length: 10 }, (_, index) => routineRow(`out-sam-r${String(index + 1)}`, 9 + index)),
      safetyRow("out-sam-d7", 19, { heldUntil: "2026-11-07T15:00:00.000Z" }),
      safetyRow("out-sam-d8", 20),
      safetyRow("out-alex-d", 21, { recipient: "handle-alex" }),
    ]);
    // A run of every class takes S, D1, D2 and D3 and stops at the planned row (items 3, 13). Limit 8 then parks D2 for
    // its chat and finds D3 stale; S and D1 keep their live claims.
    expect(took(await t.store.claimOutbox(claimOf(NOW, 10, false)))).toEqual([
      "out-sam-s",
      "out-sam-d1",
      "out-sam-d2",
      "out-sam-d3",
    ]);
    for (const [id, outcome] of [
      ["out-sam-d2", "waitingChat"],
      ["out-sam-d3", "stale"],
    ] as const) {
      await t.store.markRow({ outboxRowId: id, expectVersion: 4, outcome, heldUntil: null, at: NOW });
    }
    const before = new Map(
      [...t.store.rows.entries()].map(([id, row]) => [id, { state: row.state, version: row.version }]),
    );

    // At most `limit` rows, counted among safety rows alone: the ten routine rows before D7 do not count.
    const first = await t.store.claimOutbox(claimOf(NOW, 1, true));
    expect(first).toMatchObject({ result: "claimed", passedHeld: [] });
    expect(took(first)).toEqual(["out-sam-d7"]);
    if ("error" in first) throw new Error("transient");
    expect(first.claimed[0]).toMatchObject({
      sendClass: "safety",
      recipientHandleId: "handle-sam",
      claimedFrom: "held",
      claim: { claimer: "dispatcher-2", claimNo: 1, lapsesAt: "2026-11-07T15:07:35.000Z" },
    });
    const second = await t.store.claimOutbox(claimOf(NOW, 10, true));
    expect(second).toMatchObject({ result: "claimed", passedHeld: [] });
    expect(took(second)).toEqual(["out-sam-d8"]);
    // Nothing was written for any row it passed or did not read.
    for (const [id, was] of before) {
      if (id === "out-sam-d7" || id === "out-sam-d8") continue;
      expect([id, t.store.row(id).state, t.store.row(id).version]).toEqual([id, was.state, was.version]);
    }

    // D8 goes (sent: a finished row). Past every claim's lapse, the safety claim takes the lapsed safety rows in commit
    // order (D1 claimed by the run of every class, D7 by the safety claim) and skips the finished D8; S's lapsed claim is
    // another class's.
    await t.store.markPart({
      outcome: "sent",
      idempotencyKey: "out-sam-d8/1/1",
      providerMessageId: "linq-msg-test-0001",
      providerOptionIds: null,
      at: NOW,
    });
    const later = new Date(Date.parse(NOW) + 61_000).toISOString();
    const lapsed = await t.store.claimOutbox(claimOf(later, 10, true));
    expect(took(lapsed)).toEqual(["out-sam-d1", "out-sam-d7"]);
    if ("error" in lapsed) throw new Error("transient");
    expect(lapsed.claimed.map((row) => [row.claimedFrom, row.claim.claimNo])).toEqual([
      ["sending", 2],
      ["sending", 2],
    ]);
    expect(t.store.row("out-sam-s").claim?.claimNo).toBe(1);
    expect(t.store.row("out-alex-d").state).toBe("checked");
  });

  it("waits for the recipient's lock another claim's open transaction holds, and is never skipped (default 129); a run of every class meanwhile skips the recipient, and so does one while the safety claim holds the lock (DL-698 note c)", async () => {
    const t = setup([routineRow("out-sam-r", 1), safetyRow("out-sam-d", 2)]);
    const letGo = t.store.holdLock("handle-sam");
    let answered = false;
    const safety = t.store.claimOutbox(claimOf(NOW, 10, true)).then((answer) => {
      answered = true;
      return answer;
    });
    expect(took(await t.store.claimOutbox(claimOf(NOW, 10, false)))).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(answered).toBe(false);
    expect(t.store.lockWaits).toBe(1);

    letGo();
    expect(took(await safety)).toEqual(["out-sam-d"]);
    expect(t.store.row("out-sam-r").state).toBe("checked");

    // While a safety claim holds the key, a run of every class for the recipient is skipped, and its rows wait for the
    // recipient's next run (CQ-290's class; a window of a transaction).
    t.store.write(safetyRow("out-sam-d2", 3));
    const holding = t.store.claimOutbox(claimOf(NOW, 10, true));
    const skipped = await t.store.claimOutbox(claimOf(NOW, 10, false));
    expect(took(skipped)).toEqual([]);
    expect(took(await holding)).toEqual(["out-sam-d2"]);
  });

  it("refuses the field with no recipient, or any value but safety, before anything is read", async () => {
    const t = setup([safetyRow("out-sam-d", 1)]);

    await expect(
      t.store.claimOutbox({ claimer: "dispatcher-2", now: NOW, limit: 10, sendClass: "safety" }),
    ).rejects.toThrow(TypeError);
    await expect(
      t.store.claimOutbox({ ...claimOf(NOW, 10, false), sendClass: "routine" as unknown as "safety" }),
    ).rejects.toThrow(TypeError);
    expect(t.store.claims).toEqual([]);
    expect(t.store.row("out-sam-d").state).toBe("checked");
  });
});

describe("safety rows first within a run (T-1352's rulings, rule 3; RULES 4.12; NQ-RT-9)", () => {
  it("a run of every class that claims several classes sends the recipient's safety rows first, then the rest, each group in commit order; only the outage row is asked", async () => {
    const t = setup([
      routineRow("out-sam-r1", 1),
      outageRow("out-sam-s", 2),
      safetyRow("out-sam-d1", 3),
      routineRow("out-sam-r2", 4),
      safetyRow("out-sam-d2", 5),
      routineRow("out-alex-r", 6, { recipient: "handle-alex" }),
      safetyRow("out-alex-d", 7, { recipient: "handle-alex" }),
    ]);

    const report = await runDispatch(t.deps());

    expect(outcomes(report)).toEqual([
      ["out-sam-d1", "sent", 1],
      ["out-sam-d2", "sent", 1],
      ["out-sam-r1", "sent", 1],
      ["out-sam-s", "sent", 1],
      ["out-sam-r2", "sent", 1],
      ["out-alex-d", "sent", 1],
      ["out-alex-r", "sent", 1],
    ]);
    const keysTo = (to: string): string[] =>
      t.linq.requests.filter((request) => request.to === to).map((request) => request.idempotencyKey);
    expect(keysTo(SAM.to)).toEqual([
      "out-sam-d1/1/1",
      "out-sam-d2/1/1",
      "out-sam-r1/1/1",
      "out-sam-s/1/1",
      "out-sam-r2/1/1",
    ]);
    expect(keysTo(ALEX.to)).toEqual(["out-alex-d/1/1", "out-alex-r/1/1"]);
    expect(t.asked).toEqual(["handle-sam"]);
  });

  it("LETS_LATER_PASS runs along that order: a safety row whose send does not finish holds back every row after it in the run, as a first row does", async () => {
    const t = setup([routineRow("out-sam-r", 1), safetyRow("out-sam-d", 2)]);
    t.linq.failures.set("out-sam-d/1/1", NO_ANSWER);

    const report = await runDispatch(t.deps(), { recipientHandleId: "handle-sam" });

    expect(outcomes(report)).toEqual([
      ["out-sam-d", "failed", 0],
      ["out-sam-r", "notReached", 0],
    ]);
    expect(keys(t)).toEqual(["out-sam-d/1/1"]);
  });

  it("the cost both rulings accept (DL-698 note a): once an earlier safety row's claim lapses, the safety claim takes both rows in one answer, and an earlier row's failed send leaves the later danger row notReached in that run", async () => {
    const t = setup([safetyRow("out-sam-d0", 1)]);
    t.linq.failures.set("out-sam-d0/1/1", NO_ANSWER);
    // D0's own safety run: no answer from Linq, so its part waits under its key and its claim holds 60 s.
    expect(
      outcomes(await runDispatch(t.deps(), { recipientHandleId: "handle-sam", sendClass: "safety" })),
    ).toEqual([["out-sam-d0", "failed", 0]]);

    // Past the lapse, a new danger row D is written and woken: its claim takes D0 again with D, and D0 goes first.
    t.clock.advance(61_000);
    t.store.write(safetyRow("out-sam-d", 2));
    const report = await runDispatch(t.deps(), { recipientHandleId: "handle-sam", sendClass: "safety" });

    expect(t.store.claims.map((claim) => claim.took)).toEqual([["out-sam-d0"], ["out-sam-d0", "out-sam-d"]]);
    expect(outcomes(report)).toEqual([
      ["out-sam-d0", "failed", 0],
      ["out-sam-d", "notReached", 0],
    ]);
    expect(keys(t)).toEqual(["out-sam-d0/1/1", "out-sam-d0/1/1"]);
  });
});
