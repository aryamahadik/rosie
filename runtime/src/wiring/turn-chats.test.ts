// The service and Linq chat id of each run's last text (T-559; ./turn-chats.ts; K-09 v1.5 README default 135), under Node:
// the root's lease hooks keep them under the run's trace before the run's work starts, from the K-06 event of the turn's
// last text, the last of its event ids, both or neither; the root's gateAndCommit puts them on the request's turn by the
// trace it is handed, and on a trace that is no run's puts neither.
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import { describe, expect, it } from "vitest";

import type { LeasedTurn, LeaseHooks } from "../actor/lease";
import type { InboxEntry } from "../actor/inbox";
import { openTrace, type TraceContext } from "../trace";
import type { GateAndCommitRequest } from "../turn/types";
import { lastTextSourceOf, TurnChats, withTextSource } from "./turn-chats";
import { BUNDLE_V0, SAM_CHAT, TEST_OWNER_1 } from "./test-support";

type Json = Record<string, unknown>;

/** An inbox entry for a text in K-06 text-imessage.json's form, its words sealed away, with these fields. */
function entryOf(eventId: string, fields: Json = {}): InboxEntry {
  const event = structuredClone(textFixture) as Json;
  delete event.body;
  return {
    seq: 1,
    event: {
      ...event,
      eventId,
      handle: { ...TEST_OWNER_1.handle },
      sealed: null,
      ...fields,
    } as InboxEntry["event"],
    partKey: null,
    traceId: "trace-turn-chats",
    bundleId: BUNDLE_V0,
    startsTurn: true,
  };
}

function traceOf(): TraceContext {
  return openTrace({ openedBy: "textWebhook", bundleId: BUNDLE_V0, sink: () => undefined });
}

/** A leased turn as the lease's runTurn hook is handed it, as far as the hooks here read it. */
function leased(entries: InboxEntry[], trace: TraceContext): LeasedTurn {
  return { eventIds: entries.map((entry) => entry.event.eventId), entries, trace } as unknown as LeasedTurn;
}

/** A gateAndCommit request as the turn makes it: K-05's turn, with neither field. */
function requestOf(trace: TraceContext): GateAndCommitRequest {
  return {
    caller: {
      kind: "turn",
      turnId: "turn-turn-chats",
      requestId: "turn-turn-chats",
      businessId: TEST_OWNER_1.businessId,
      personId: TEST_OWNER_1.personId,
      traceId: trace.traceId,
    },
    turn: {
      id: "turn-turn-chats",
      handleId: TEST_OWNER_1.handleId,
      eventIds: ["evt-a", "evt-b"],
      bundleId: { ...BUNDLE_V0 },
      traceId: trace.traceId,
      joinedTraceIds: [],
      tries: 1,
    },
    input: { kind: "coreOnly" },
    core: [],
    now: "2026-10-19T14:01:55Z",
  };
}

/** The lease's hooks with a runTurn that only notes it ran. */
function hooksNoting(ran: string[]): Required<LeaseHooks> {
  return {
    runTurn: (turn) => {
      ran.push(turn.eventIds.join(","));
    },
    commit: () => Promise.resolve({ error: "unwired" }),
    park: () => Promise.resolve({ error: "unwired" }),
  };
}

describe("the service and chat id of a turn's last text (K-09 v1.5 default 135)", () => {
  it("are the K-06 event's of the last of the turn's event ids, both of them", () => {
    const turn = {
      eventIds: ["evt-a", "evt-b"],
      entries: [
        entryOf("evt-a", { service: "sms", chatId: "linq-chat-other" }),
        entryOf("evt-b", { chatId: SAM_CHAT }),
      ],
    };

    expect(lastTextSourceOf(turn)).toEqual({ service: "imessage", chatId: SAM_CHAT });
  });

  it("keep a chat id Linq did not report as null, never made up", () => {
    expect(lastTextSourceOf({ eventIds: ["evt-a"], entries: [entryOf("evt-a", { chatId: null })] })).toEqual({
      service: "imessage",
      chatId: null,
    });
  });

  it("are neither when the last event has no service, a chat id that is no id, or is not among the entries", () => {
    expect(
      lastTextSourceOf({ eventIds: ["evt-a"], entries: [entryOf("evt-a", { service: null })] }),
    ).toBeNull();
    expect(
      lastTextSourceOf({ eventIds: ["evt-a"], entries: [entryOf("evt-a", { service: "" })] }),
    ).toBeNull();
    expect(lastTextSourceOf({ eventIds: ["evt-a"], entries: [entryOf("evt-a", { chatId: "" })] })).toBeNull();
    expect(lastTextSourceOf({ eventIds: ["evt-a"], entries: [entryOf("evt-a", { chatId: 7 })] })).toBeNull();
    expect(lastTextSourceOf({ eventIds: ["evt-b"], entries: [entryOf("evt-a")] })).toBeNull();
    expect(lastTextSourceOf({ eventIds: [], entries: [] })).toBeNull();
  });

  it("go on the request's turn both together, beside K-05's seven fields, or not at all", () => {
    const request = requestOf(traceOf());

    expect(withTextSource(request, { service: "imessage", chatId: SAM_CHAT }).turn).toEqual({
      ...request.turn,
      service: "imessage",
      chatId: SAM_CHAT,
    });
    expect(withTextSource(request, null)).toBe(request);
    expect(request.turn).not.toHaveProperty("service");
  });
});

describe("the root's memory of each run's text source, by the run's trace", () => {
  it("keeps the run's last text's service and chat id before the run's work starts, and puts them on the request its trace carries", async () => {
    const chats = new TurnChats();
    const ran: string[] = [];
    const hooks = chats.around(hooksNoting(ran));
    const trace = traceOf();

    await hooks.runTurn(
      leased([entryOf("evt-a"), entryOf("evt-b", { service: "rcs", chatId: "linq-chat-b" })], trace),
    );

    expect(ran).toEqual(["evt-a,evt-b"]);
    expect(chats.of(trace)).toEqual({ service: "rcs", chatId: "linq-chat-b" });
    expect(chats.onTurn(requestOf(trace), trace).turn).toMatchObject({
      service: "rcs",
      chatId: "linq-chat-b",
    });
  });

  it("puts neither on a request whose trace is no run's, or whose run's last text gave none", async () => {
    const chats = new TurnChats();
    const hooks = chats.around(hooksNoting([]));
    const other = traceOf();
    const trace = traceOf();
    await hooks.runTurn(leased([entryOf("evt-a")], trace));
    // A rerun of the same trace whose last text gives none forgets the earlier one.
    await hooks.runTurn(leased([entryOf("evt-a", { service: null })], trace));

    expect(chats.of(other)).toBeNull();
    expect(chats.onTurn(requestOf(other), other).turn).not.toHaveProperty("chatId");
    expect(chats.of(trace)).toBeNull();
    expect(chats.onTurn(requestOf(trace), trace).turn).not.toHaveProperty("service");
  });

  it("passes the commit and park hooks on unchanged", () => {
    const base = hooksNoting([]);
    const hooks = new TurnChats().around(base);

    expect(hooks.commit).toBe(base.commit);
    expect(hooks.park).toBe(base.park);
  });
});
