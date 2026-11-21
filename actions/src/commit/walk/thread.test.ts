// T-1519 (DL-1048, from T-1517's round 2): S1-01's thread write reuses the handle's existing chat thread instead of
// inserting a second one. K-04 holds one chat thread per handle (0005 threads_one_chat_per_handle) and one per Linq chat
// id (threads_linq_chat_key), so a JOIN from a number whose chat thread exists (a re-JOIN, the user's phone after T-1517's
// roster reset) made commitTurn answer constraint, and JOIN got no reply. With the chat read bound (WalkDeps.chats: K-05
// v1.10 item 51's readChatHandle), the walk asks it once for the turn's chat id:
//   - the turn's own handle holds it: no thread row and no thread.created entry; S1-02's question and its quick reply as
//     commit-s1-01.json states them; the part still gives thread (writes.ts default 12);
//   - none, or another handle: the thread is inserted exactly as with no read bound (commit-s1-01.json's rows), so a clash
//     is still the database's to refuse, as before.
// Turn 1 is commit-s1-01.json's part on K-01's bundle-v0-skeleton.json (the walk's own fixtures, test-support.ts); the
// read is the one double beside the bundles port, its values the fixture's (handle-sam, linq-chat-demo-sam) and the
// master's sample cast. From T-1479 the quick reply is commit-s1-01.json's plus its step and line (S1-02, line 0: K-05
// v1.22 item 82), and the built request is held to K-05 v1.22's commitTurn.request.

import { describe, expect, it } from "vitest";

import { buildCommitRequest } from "../build";
import { contractChecks, eventLogRowsOf } from "../test-support";
import type { OpenHolds, OutboxRowNew, UnitWrites } from "../types";
import { WalkNotBuiltError, createWritesOf, type WalkChats } from "./index";
import {
  NOTHING_OPEN,
  SAM,
  chatsOver,
  hold,
  k05v122,
  requestTurnFields,
  skeletonBundles,
  turnOne,
  type WalkTestRepo,
} from "./test-support";

/** commit-s1-01.json's outbox rows as the walk writes them: each naming S1-02 and line 0 (writes.ts default 15). */
function statedRowsLined(): OutboxRowNew[] {
  return turnOne().exchange.given.stated.writes.outboxRows.map((row) => ({
    ...row,
    step: "S1-02",
    lineNo: 0,
  }));
}

/** The handle and chat commit-s1-01.json's turn carries (K-09 v1.5 default 135). */
const HANDLE = "handle-sam";
const CHAT = "linq-chat-demo-sam";

/** Another handle of the master's sample cast, whose chat thread would hold the chat id. */
const OTHER_HANDLE = "handle-alex";

/** Turn 1's writes on bundle v0 with commit-s1-01.json's turn key, the chat read `chats` bound (or none). */
async function turnOneWith(
  chats: WalkChats | undefined,
  open: OpenHolds = NOTHING_OPEN,
  change: (turn: Record<string, unknown>) => void = () => undefined,
): Promise<UnitWrites> {
  const { bundles } = skeletonBundles();
  const writesOf = createWritesOf<WalkTestRepo>({
    bundles,
    turnKey: () => SAM,
    ...(chats === undefined ? {} : { chats }),
  });
  const { part, context } = turnOne();
  change(requestTurnFields(context.request));
  return writesOf(part, context, open);
}

/** What a run threw, or null. */
async function thrownBy(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => null,
    (error: unknown) => error,
  );
}

describe("the handle's own chat thread holds the turn's chat id: S1-01 reuses it (writes.ts default 12)", () => {
  it("writes no thread row and no thread.created entry; S1-02's question and quick reply are commit-s1-01.json's, and the part gives thread", async () => {
    const { exchange } = turnOne();
    const stated = exchange.given.stated.writes;
    const chats = chatsOver(HANDLE);
    const writes = await turnOneWith(chats.chats);
    expect(writes).toEqual({
      why: { step: "S1-01", choice: "Business onboarding" },
      versionsRead: [],
      state: [],
      stateEvents: [],
      asks: writes.asks,
      closes: [],
      clockCancels: [],
      messages: statedRowsLined(),
      reservations: { confirm: [], release: [] },
      effects: { write: [], letGo: [] },
      gives: ["thread"],
    });
    expect(writes.asks.map((ask) => ask.question)).toEqual(stated.openQuestions);
    // The part gives exactly what commit-s1-01.json's part gives: the thread is the handle's, reused.
    expect(writes.gives).toEqual(exchange.given.stated.gives);
    expect(writes.gives).toEqual(exchange.outcome.parts[0]?.gives);
    // The read was asked once, for the turn's own chat id.
    expect(chats.reads).toEqual([CHAT]);
    expect(requestTurnFields(exchange.request).chatId).toBe(CHAT);
  });

  it("the rows the reuse leaves go into the commit's one K-05 request as they are: K-05 v1.22 and K-08 v1.1 take it, with no threads write and no entry of one", async () => {
    const { exchange, context } = turnOne();
    const writes = await turnOneWith(chatsOver(HANDLE).chats);
    const request = buildCommitRequest({
      turn: context.turn,
      zone: "America/New_York",
      businessId: context.businessId,
      actor: { personId: exchange.request.caller.personId, roleAt: () => null },
      units: [{ writes, answer: null }],
    });
    const checks = contractChecks();
    expect(k05v122("commitTurn.request", request)).toEqual([]);
    const rows = eventLogRowsOf(request, "2026-10-19T18:05:05Z");
    for (const row of rows) expect(checks.k08("eventLogRow", row), String(row.id)).toEqual([]);
    expect(checks.k08("eventLogBatch", { rows })).toEqual([]);
    expect(request.writes.state).toEqual([]);
    expect(request.writes.events.map((entry) => entry.kind)).not.toContain("thread.created");
    expect(request.writes.events.map((entry) => entry.tableName)).not.toContain("threads");
    // What commit-s1-01.json's commit wrote, but the thread: S1-02's question, its clock row and the one outbox row.
    expect([
      ...request.writes.openQuestions.open.map((question) => question.id),
      ...request.writes.clockRows.make.map((clock) => String(clock.id)),
    ]).toEqual(
      exchange.outcome.written.written.filter((row) => row.table !== "threads").map((row) => row.rowId),
    );
    expect(request.writes.outboxRows.map((row) => row.id)).toEqual(
      exchange.outcome.written.outboxRows.map((row) => row.id),
    );
    // The chat id is in no write and no entry: its one home is the thread row, which already holds it.
    expect(JSON.stringify(request.writes)).not.toContain(CHAT);
  });

  it("two runs give equal writes and ask the read once each, changing nothing they were given (a repeated turn)", async () => {
    const chats = chatsOver(HANDLE);
    const first = await turnOneWith(chats.chats);
    const second = await turnOneWith(chats.chats);
    expect(second).toEqual(first);
    expect(chats.reads).toEqual([CHAT, CHAT]);
  });
});

describe("no chat thread of the turn's handle holds the turn's chat id: S1-01 inserts the thread exactly as before", () => {
  it("none holds it: the thread is inserted as with no read bound, field for field commit-s1-01.json's, with its entry", async () => {
    const { exchange } = turnOne();
    const chats = chatsOver(null);
    const writes = await turnOneWith(chats.chats);
    expect(writes).toEqual(await turnOneWith(undefined));
    expect(writes.state).toEqual(exchange.given.stated.writes.state);
    expect(writes.stateEvents.map((entry) => [entry.kind, entry.rowId])).toEqual([
      ["thread.created", "thread-s1-01-sam-1"],
    ]);
    expect(writes.gives).toEqual(["thread"]);
    expect(chats.reads).toEqual([CHAT]);
  });

  it("another handle's chat thread holds it: the insert stays as before, so the database refuses the clash as it always did", async () => {
    const chats = chatsOver(OTHER_HANDLE);
    const writes = await turnOneWith(chats.chats);
    expect(writes).toEqual(await turnOneWith(undefined));
    expect(writes.state.map((write) => write.table)).toEqual(["threads"]);
    expect(chats.reads).toEqual([CHAT]);
  });

  it("the read is asked for each run's own chat id: the handle's thread holding another chat leaves the insert as before (default 12's open case)", async () => {
    const chats = chatsOver(HANDLE, CHAT);
    const writes = await turnOneWith(chats.chats, NOTHING_OPEN, (turn) => {
      turn.chatId = "linq-chat-demo-alex";
    });
    const [thread] = writes.state;
    expect(thread?.op === "insert" ? thread.values.linq_chat_id : null).toBe("linq-chat-demo-alex");
    expect(chats.reads).toEqual(["linq-chat-demo-alex"]);
  });
});

describe("the read is asked only for a thread the walk would write", () => {
  it("with no read bound, nothing changes: commit-s1-01.json's thread, question and quick reply", async () => {
    const { exchange } = turnOne();
    const writes = await turnOneWith(undefined);
    expect(writes.state).toEqual(exchange.given.stated.writes.state);
    expect(writes.messages).toEqual(statedRowsLined());
  });

  it("an email turn is not built before the read is asked", async () => {
    const chats = chatsOver(HANDLE);
    const error = await thrownBy(
      turnOneWith(chats.chats, NOTHING_OPEN, (turn) => {
        turn.service = "email";
      }),
    );
    expect(error).toBeInstanceOf(WalkNotBuiltError);
    expect(error).toMatchObject({ seam: "threadByEmail", ids: ["S1-01"] });
    expect(chats.reads).toEqual([]);
  });

  it("a turn with no chat id is refused before the read is asked", async () => {
    const chats = chatsOver(HANDLE);
    const error = await thrownBy(
      turnOneWith(chats.chats, NOTHING_OPEN, (turn) => {
        Reflect.deleteProperty(turn, "chatId");
      }),
    );
    expect(error).toMatchObject({ name: "WalkRefusedError", fault: "noServiceOrChatId" });
    expect(chats.reads).toEqual([]);
  });

  it("a hold that stops the walk at S1-01 writes nothing and asks nothing", async () => {
    const chats = chatsOver(HANDLE);
    const writes = await turnOneWith(chats.chats, { holds: [hold()], unreadEventIds: [] });
    expect(writes.state).toEqual([]);
    expect(writes.asks).toEqual([]);
    expect(writes.gives).toEqual([]);
    expect(chats.reads).toEqual([]);
  });

  it("a read that fails fails the part closed: what it throws leaves as thrown, and no row is handed back", async () => {
    const failing = new Error("readChatHandle answered transient: the call fails closed");
    const chats: WalkChats = { chatHandle: () => Promise.reject(failing) };
    expect(await thrownBy(turnOneWith(chats))).toBe(failing);
  });
});
