// T-1213's chat-open port, under Node (Vitest project "unit"): the K-05 v1.7 double the test environment feeds it
// (./test-support.ts fakeDispatchData's openChat) answers as db/repo's openChatOnText answers (T-1212), each v1.7 fixture's
// request after its given with its outcome, the three refused fixtures refused as db/repo refuses them; and the root's
// real chat-open port (./real.ts realChatOpen) sends the gateway's request to K-05 field for field and hands back K-05's
// answer as the gateway reads it, failing closed with no call bound. Test values only (rule 9): the K-04 seeds' sample
// cast and their fictional 555-01xx numbers.
import openChatAlex from "@rosie/contracts/data-access/fixtures/open-chat-alex-already-open.json";
import openChatEmail from "@rosie/contracts/data-access/fixtures/open-chat-apple-id-email.json";
import openChatBen from "@rosie/contracts/data-access/fixtures/open-chat-ben-stopped.json";
import openChatDee from "@rosie/contracts/data-access/fixtures/open-chat-dee-closed-chat.json";
import openChatSamRepeat from "@rosie/contracts/data-access/fixtures/open-chat-first-text-sam-repeat.json";
import openChatSam from "@rosie/contracts/data-access/fixtures/open-chat-first-text-sam.json";
import refuseNoEvent from "@rosie/contracts/data-access/fixtures/invalid/refuse-open-chat-no-event.json";
import refuseStopped from "@rosie/contracts/data-access/fixtures/invalid/refuse-open-chat-stopped-number.json";
import refuseWithNumber from "@rosie/contracts/data-access/fixtures/invalid/refuse-open-chat-with-number.json";
import seedPersonRoles from "@rosie/contracts/db-schema/core/fixtures/seed-person-roles.json";
import seedPhoneChatOpen from "@rosie/contracts/db-schema/core/fixtures/seed-phone-chat-open.json";
import seedPhoneStopped from "@rosie/contracts/db-schema/core/fixtures/seed-phone-stopped.json";
import seedOwnerIdUpload from "@rosie/contracts/db-schema/people-access/fixtures/seed-owner-id-upload.json";
import type { OpenChatOnTextOutcome, OpenChatOnTextRequest } from "@rosie/db/repo/chat-open";
import type { PhoneRead } from "@rosie/db/repo/send-state";
import { describe, expect, it } from "vitest";

import type { ChatOpenAnswer, ChatOpenRequest } from "../gateway/types";
import { ChatOpenRequestError, NoDatabaseError, realChatOpen } from "./index";
import { fakeDispatchData, fakeTurnRows, type FakeDispatchData, type HandleTable } from "./test-support";

type Values = Readonly<Record<string, unknown>>;

interface SeedFile {
  readonly rows: readonly { readonly table: string; readonly values: Values }[];
}

interface Exchange {
  readonly given: { readonly now: string };
  readonly request: OpenChatOnTextRequest;
  readonly outcome: unknown;
}

const SEEDS = [
  seedPersonRoles,
  seedPhoneChatOpen,
  seedPhoneStopped,
  seedOwnerIdUpload,
] as readonly SeedFile[];

/**
 * Dee W.'s handle and phone row as v1.1's chain writes them (commit-adds-dee-booking: her mobile +15555550107 saved by
 * Sam's booking, version 1, no chat open, never stopped, no time or way), which open-chat-dee-closed-chat.json's given
 * reaches through mark-waiting-chat.
 */
const DEE = { id: "handle-dee", kind: "phone", address: "+15555550107" };

/** K-04's handles as the seeds hold them, with Dee's. */
const HANDLES: HandleTable = (handleId) => {
  if (handleId === DEE.id) return { kind: DEE.kind, address: DEE.address };
  for (const seed of SEEDS) {
    const row = seed.rows.find((each) => each.table === "handles" && each.values.id === handleId);
    if (row !== undefined) return { kind: String(row.values.kind), address: String(row.values.address) };
  }
  return null;
};

/** A K-04 phones row as K-05 v1.2's phoneRead reads it. */
function phoneReadOf(values: Values): PhoneRead {
  const nullable = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    number: String(values.number),
    stopped: values.stopped === true,
    stopAt: nullable(values.stop_at),
    chatOpen: values.chat_open === true,
    chatWay: nullable(values.chat_way) as PhoneRead["chatWay"],
    linqContactAddedAt: nullable(values.linq_contact_added_at),
    pollVotedAt: nullable(values.poll_voted_at),
    optoutLineDeliveredAt: nullable(values.optout_line_delivered_at),
    version: Number(values.version),
  };
}

/** The double over the seeds' handles, its phone rows the seeds' (and Dee's, closed), its clock `now`. */
function seededDouble(now: string): FakeDispatchData {
  const double = fakeDispatchData(fakeTurnRows(), new Map(), () => Date.parse(now), HANDLES);
  for (const seed of SEEDS) {
    for (const row of seed.rows) {
      if (row.table !== "phones") continue;
      const handleId = String(row.values.handle_id);
      double.phones.set(handleId, phoneReadOf(row.values));
      double.chatOpenedAt.set(
        handleId,
        typeof row.values.chat_open_at === "string" ? row.values.chat_open_at : null,
      );
    }
  }
  double.phones.set(
    DEE.id,
    phoneReadOf({ number: DEE.address, chat_open: false, stopped: false, version: 1 }),
  );
  double.chatOpenedAt.set(DEE.id, null);
  return double;
}

/** The K-04 event_log row an answer's entry is appended as (K-08 v1 eventLogRow, K-04's column names). */
function entryRowOf(exchange: Exchange): Values {
  const event = (exchange.outcome as { readonly event: Values }).event;
  return {
    id: event.id,
    at: exchange.given.now,
    zone: null,
    turn_id: null,
    job_id: exchange.request.eventId,
    trace_id: exchange.request.traceId,
    bundle_hash: null,
    bundle_build: null,
    business_id: null,
    actor_kind: "provider",
    actor_person_id: null,
    actor_role: null,
    kind: "phone.chat_opened",
    table_name: "phones",
    row_id: exchange.request.handleId,
    old_values: event.oldValues,
    new_values: event.newValues,
    sealed_values: null,
    sealed_for_person_id: null,
    why: event.why,
    approved_by: null,
    proofs: null,
  };
}

describe("the K-05 v1.7 double answers as db/repo's openChatOnText: each v1.7 fixture's request after its given, its outcome", () => {
  it("open-chat-first-text-sam: Sam's first text inserts his phone row, its number his handle's address, with one phone.chat_opened entry; its repeat answers repeated and writes nothing (open-chat-first-text-sam-repeat)", async () => {
    const first = openChatSam as unknown as Exchange;
    const repeat = openChatSamRepeat as unknown as Exchange;
    const double = seededDouble(first.given.now);
    double.phones.delete("handle-sam");
    double.chatOpenedAt.delete("handle-sam");

    expect(await double.openChat(first.request)).toEqual(first.outcome);
    const row = double.phones.get("handle-sam");
    expect(row).toEqual({
      number: "+15555550100",
      stopped: false,
      stopAt: null,
      chatOpen: true,
      chatWay: "imessage",
      linqContactAddedAt: null,
      pollVotedAt: null,
      optoutLineDeliveredAt: null,
      version: 1,
    });
    expect(double.chatEntries).toEqual([entryRowOf(first)]);

    expect(await double.openChat(repeat.request)).toEqual(repeat.outcome);
    expect(double.phones.get("handle-sam")).toEqual(row);
    expect(double.chatEntries).toHaveLength(1);
  });

  it.each<[string, Exchange, string]>([
    ["open-chat-alex-already-open", openChatAlex as unknown as Exchange, "handle-alex"],
    ["open-chat-ben-stopped", openChatBen as unknown as Exchange, "handle-ben"],
  ])(
    "%s: answered as the fixture, nothing written, every field and the version unchanged",
    async (_name, exchange, handleId) => {
      const double = seededDouble(exchange.given.now);
      const before = structuredClone(double.phones.get(handleId));

      expect(await double.openChat(exchange.request)).toEqual(exchange.outcome);
      expect(double.phones.get(handleId)).toEqual(before);
      expect(double.chatEntries).toEqual([]);
    },
  );

  it("open-chat-dee-closed-chat: a closed chat that is not stopped opens, its version raised, with the closed chat's old values in its entry", async () => {
    const exchange = openChatDee as unknown as Exchange;
    const double = seededDouble(exchange.given.now);

    expect(await double.openChat(exchange.request)).toEqual(exchange.outcome);
    expect(double.phones.get(DEE.id)).toMatchObject({ chatOpen: true, chatWay: "imessage", version: 2 });
    expect(double.chatEntries).toEqual([entryRowOf(exchange)]);
  });

  it("open-chat-apple-id-email: an email handle answers notAPhone, and nothing is written", async () => {
    const exchange = openChatEmail as unknown as Exchange;
    const double = seededDouble(exchange.given.now);
    const phones = structuredClone([...double.phones]);

    expect(await double.openChat(exchange.request)).toEqual(exchange.outcome);
    expect([...double.phones]).toEqual(phones);
    expect(double.chatEntries).toEqual([]);
  });

  it("a handle K-04 does not hold answers notFound (table handles), and nothing is written", async () => {
    const double = seededDouble(openChatSam.given.now);

    expect(
      await double.openChat({ ...openChatSam.request, handleId: "handle-nobody" } as OpenChatOnTextRequest),
    ).toEqual({
      error: "notFound",
      table: "handles",
      rowId: "handle-nobody",
    });
    expect(double.chatEntries).toEqual([]);
  });

  it("refused: a request carrying the number and one naming no event throw before anything is read or written; refuse-open-chat-stopped-number's request gets its twin's answer, stopped", async () => {
    const double = seededDouble(openChatSam.given.now);
    double.phones.delete("handle-sam");
    const phones = structuredClone([...double.phones]);

    await expect(double.openChat(refuseWithNumber as unknown as OpenChatOnTextRequest)).rejects.toThrow(
      TypeError,
    );
    await expect(double.openChat(refuseNoEvent as unknown as OpenChatOnTextRequest)).rejects.toThrow(
      TypeError,
    );
    expect([...double.phones]).toEqual(phones);
    expect(double.chatEntries).toEqual([]);

    const refused = refuseStopped as unknown as Exchange;
    expect(await double.openChat(refused.request)).toEqual(openChatBen.outcome);
    expect(double.chatEntries).toEqual([]);
  });

  it("transient once (a lost connection): nothing is written, and the same request again inserts the row", async () => {
    const exchange = openChatSam as unknown as Exchange;
    const double = seededDouble(exchange.given.now);
    double.phones.delete("handle-sam");
    double.failNextChatOpen = { error: "transient", sqlstate: "08006" };

    expect(await double.openChat(exchange.request)).toEqual({ error: "transient", sqlstate: "08006" });
    expect(double.phones.has("handle-sam")).toBe(false);
    expect(await double.openChat(exchange.request)).toEqual(exchange.outcome);
  });
});

/** The gateway's request for Sam's first text, as ../gateway/chat-open.ts builds it. */
const GATEWAY_REQUEST: ChatOpenRequest = { ...openChatSam.request };

describe("the real chat-open port (T-1213): K-05 v1.7 openChatOnText with its database bound", () => {
  it("sends the gateway's request to K-05 field for field, and hands back each result and each error by its name alone", async () => {
    const sent: OpenChatOnTextRequest[] = [];
    const answers: OpenChatOnTextOutcome[] = [
      openChatSam.outcome as unknown as OpenChatOnTextOutcome,
      openChatSamRepeat.outcome as unknown as OpenChatOnTextOutcome,
      openChatAlex.outcome as unknown as OpenChatOnTextOutcome,
      openChatDee.outcome as unknown as OpenChatOnTextOutcome,
      openChatBen.outcome as unknown as OpenChatOnTextOutcome,
      openChatEmail.outcome as unknown as OpenChatOnTextOutcome,
      { error: "notFound", table: "handles", rowId: "handle-sam" } as unknown as OpenChatOnTextOutcome,
      { error: "transient", sqlstate: "40001" },
    ];
    const port = realChatOpen({
      call: (request) => {
        sent.push(structuredClone(request));
        const answer = answers.shift();
        if (answer === undefined) throw new Error("no answer left");
        return Promise.resolve(answer);
      },
    });

    const got: ChatOpenAnswer[] = [];
    for (let k = 0; k < 8; k += 1) got.push(await port.openChatOnText(GATEWAY_REQUEST));

    expect(got).toEqual([
      { result: "inserted" },
      { result: "repeated" },
      { result: "alreadyOpen" },
      { result: "opened" },
      { result: "stopped" },
      { error: "notAPhone" },
      { error: "notFound" },
      { error: "transient" },
    ]);
    expect(sent).toEqual(Array.from({ length: 8 }, () => openChatSam.request));
  });

  it("refuses a service that is not Linq's before K-05 is reached", async () => {
    let calls = 0;
    const port = realChatOpen({
      call: () => {
        calls += 1;
        return Promise.resolve(openChatSam.outcome as unknown as OpenChatOnTextOutcome);
      },
    });

    await expect(port.openChatOnText({ ...GATEWAY_REQUEST, service: "email" })).rejects.toThrow(
      ChatOpenRequestError,
    );
    expect(calls).toBe(0);
  });

  it("passes a throw on unchanged (no answer: the gateway answers 503), and fails closed with no database bound (the Worker until T-567)", async () => {
    const thrown = Object.assign(
      new Error("openChatOnText: the database refused the call (SQLSTATE 23505)"),
      {
        name: "OpenChatOnTextDatabaseError",
      },
    );
    const port = realChatOpen({ call: () => Promise.reject(thrown) });

    await expect(port.openChatOnText(GATEWAY_REQUEST)).rejects.toBe(thrown);
    await expect(realChatOpen({ call: null }).openChatOnText(GATEWAY_REQUEST)).rejects.toThrow(
      new NoDatabaseError("openChatOnText"),
    );
  });
});
