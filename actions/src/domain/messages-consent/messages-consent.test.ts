// T-307's proofs (the card's "Proves it with"), on the frozen contracts' seed rows (K-04 v1's people, phones and threads;
// K-29 v1's consent rows and chat links) and fixtures (K-07 v1, K-29 v1, K-09 v1), through an in-memory reader, never a
// database:
//   - an outbox row for a phone with no open chat is not built as a text row (C9) and is reported to the caller;
//   - a consent row is append-only: an update is refused (refuse-consent-update.json);
//   - a STOP adds a row;
//   - an SMS channel is refused (refuse-sms-channel.json, DL-012);
//   - the row carries every version the read-back showed.
// And the base around them: the person's way decides the channel, a stopped mobile gets only what the stopped flag
// allows, a yes is bound to its read-back and counts only from the person themself, how each person is reached, one
// business per service, and answers that carry ids and labels only, with nothing logged.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import {
  CommitRefusedError,
  checkUnits,
  type CommitUnit,
  type OutboxRowNew,
  type RowRef,
  type StateWrite,
} from "../../commit";
import {
  ConsentRefusedError,
  assertConsentsAppendOnly,
  newestDecides,
  stateWriteOf,
  textsStanding,
  wordsSha256,
  type ConsentKind,
  type ConsentWrite,
} from "./consent";
import { createMessagesConsent, type MessageRequest, type MessagesConsent } from "./messages-consent";
import { OutboxRefusedError, SEND_CLASSES, checkChannelAndPort, portOf, versionsReadOf } from "./outbox";
import type { ReachCard, ReachCards } from "./reads";
import {
  ALEX_CARD,
  BARBERSHOP,
  YOGA_STUDIO,
  cardsOf,
  contractJson,
  k05Problems,
  k07Problems,
  phoneOf,
  phoneRow,
  readerOf,
  seedRecord,
  seedRows,
  stringsIn,
  withRows,
  type CardAsked,
  type ConsentRow,
  type TestRecord,
} from "./test-support";

const RECORD = seedRecord();

interface Setup {
  /** Default RECORD. */
  record?: TestRecord;
  /** Default: Alex's card at the barbershop. */
  cards?: ReachCards;
  /** The consent rows' scope; default the service's business, as row-level security shows them (K-29 rule 4). */
  scope?: string | null;
}

/** The service of one business over the record, as a Tool API call would make it under that business's scope. */
function serviceFor(businessId: string, setup: Setup = {}): MessagesConsent {
  return createMessagesConsent({
    businessId,
    reader: readerOf(setup.record ?? RECORD, setup.scope === undefined ? businessId : setup.scope),
    reachCards: setup.cards ?? cardsOf([ALEX_CARD]),
  });
}

/** A message to a person at the barbershop, quick reply, with the versions given. */
function message(id: string, to: MessageRequest["to"], fields: Partial<MessageRequest> = {}): MessageRequest {
  return {
    id,
    to,
    bookingId: null,
    openQuestionId: null,
    sendClass: "quick_reply",
    versionsRead: [],
    ...fields,
  };
}

/** The fault a check refuses its argument with (the service's refusals and the commit's own), or null when it passes. */
function faultOf<A>(check: (argument: A) => void, argument: A): string | null {
  try {
    check(argument);
    return null;
  } catch (error) {
    if (
      error instanceof OutboxRefusedError ||
      error instanceof ConsentRefusedError ||
      error instanceof CommitRefusedError
    ) {
      return error.fault;
    }
    throw error;
  }
}

/** One unit of the commit carrying these rows and state writes (the commit's own check runs on it). */
function unitOf(messages: readonly OutboxRowNew[], state: readonly StateWrite[] = []): CommitUnit {
  return {
    writes: {
      why: { step: "A7-03", choice: null },
      versionsRead: [],
      state,
      stateEvents: [],
      asks: [],
      closes: [],
      clockCancels: [],
      messages,
      reservations: { confirm: [], release: [] },
      effects: { write: [], letGo: [] },
      gives: [],
    },
    answer: null,
  };
}

/** A card at the barbershop for a person (RULES 4.8: a mobile, an email if they have one, and the way). */
function cardAt(personId: string, card: ReachCard): ReachCard & CardAsked {
  return { businessId: BARBERSHOP, personId, ...card };
}

/** The K-04 seed's outbox rows for A7-03 (seed-outbox-row.json), in K-05 v1 outboxRowNew's names. */
function seedA703Rows(): OutboxRowNew[] {
  return seedRows(["db-schema/core/fixtures/seed-outbox-row.json"])
    .filter((row) => row.table === "outbox_rows" && String(row.values.id).startsWith("out-a7-03-alex"))
    .map(({ values }) => ({
      id: values.id as string,
      recipientHandleId: values.recipient_handle_id as string,
      recipientPersonId: values.recipient_person_id as string,
      businessId: values.business_id as string,
      bookingId: values.booking_id as string,
      channel: values.channel as OutboxRowNew["channel"],
      sendClass: values.send_class as OutboxRowNew["sendClass"],
      openQuestionId: values.open_question_id as string,
      copyOfRowId: values.copy_of_row_id as string | null,
      versionsRead: values.versions_read as RowRef[],
    }));
}

/** A K-29 seed row's values with every column K-29 lists, nulls for those the seed leaves out (their default). */
function k29Row(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { handle_id: null, booking_id: null, chat_link_id: null, turn_id: null, revoked: false, ...values };
}

/** The values of one seed row of a K-29 fixture file, by id. */
function seedConsent(file: string, id: string): Record<string, unknown> {
  const seed = contractJson(`db-schema/conversations-consent/fixtures/${file}`) as {
    rows: { table: string; values: Record<string, unknown> }[];
  };
  const row = seed.rows.find((each) => each.table === "consents" && each.values.id === id);
  if (row === undefined) throw new Error(`no seed consent ${id}`);
  return k29Row(row.values);
}

/** The record with one more consent row, as the commit would append it (for the newest-row-decides reads). */
function appended(record: TestRecord, write: ConsentWrite): TestRecord {
  const { values } = write;
  const row: ConsentRow = {
    id: values.id,
    personId: values.person_id,
    businessId: values.business_id,
    kind: values.kind,
    revoked: values.revoked,
    handleId: values.handle_id,
    bookingId: values.booking_id,
    wordsSha256: values.words_sha256,
    at: new Date(values.at),
    channel: values.channel,
    chatLinkId: values.chat_link_id,
    turnId: values.turn_id,
    exactWords: values.exact_words,
  };
  return withRows(record, { consents: [row] });
}

describe("outbox rows: one message, one recipient, one channel (arch 01 line 65; K-05 v1 outboxRowNew; K-07 v1)", () => {
  it("Alex's A7-03 question gives K-04's own two rows: the iMessage row and its email copy (seed-outbox-row.json)", async () => {
    const answer = await serviceFor(BARBERSHOP).outboxRows(
      message(
        "out-a7-03-alex",
        { personId: "person-alex" },
        {
          bookingId: "booking-alex-haircut",
          openQuestionId: "oq-a7-03-alex",
          versionsRead: [{ table: "bookings", rowId: "booking-alex-haircut", version: 7 }],
        },
      ),
    );
    expect(answer).toEqual({ rows: seedA703Rows(), notBuilt: [] });
    expect(answer.rows.map((row) => row.copyOfRowId)).toEqual([null, "out-a7-03-alex"]);
    for (const row of answer.rows) expect(k05Problems("outboxRowNew", row)).toEqual([]);
    expect(faultOf(checkUnits, [unitOf(answer.rows)])).toBeNull();
  });

  it("the row carries every version the read-back showed, each row once, in the order shown", async () => {
    const fixture = contractJson("tool-api/fixtures/j3-confirm-business-booking-not-yet.json") as {
      request: { readBack: { versionsRead: RowRef[] } };
    };
    const shown = fixture.request.readBack.versionsRead;
    expect(shown).toHaveLength(6);
    const again = [shown[0], shown[3]].filter((ref): ref is RowRef => ref !== undefined);
    const { rows } = await serviceFor(BARBERSHOP).outboxRows(
      message("out-alex-readback", { personId: "person-alex" }, { versionsRead: [...shown, ...again] }),
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.versionsRead).toEqual(shown);
    // Each row holds its own copy: a change to one never reaches the other or the caller's list.
    const [textRow, emailRow] = rows;
    const firstRead = textRow?.versionsRead[0];
    if (emailRow === undefined || firstRead === undefined) throw new Error("two rows with their versions");
    firstRead.version = 99;
    expect(emailRow.versionsRead[0]?.version).toBe(shown[0]?.version);
    expect(versionsReadOf(shown)).toEqual(shown);
  });

  it("one row at two versions, or an entry that is not a table, a row id and a version from 1, is refused", async () => {
    const service = serviceFor(BARBERSHOP);
    const twice = [
      { table: "bookings", rowId: "booking-alex-haircut", version: 7 },
      { table: "bookings", rowId: "booking-alex-haircut", version: 8 },
    ];
    await expect(
      service.outboxRows(message("out-x", { personId: "person-alex" }, { versionsRead: twice })),
    ).rejects.toThrow(new OutboxRefusedError("versionTwice"));
    for (const bad of [
      { table: "Bookings", rowId: "booking-alex-haircut", version: 7 },
      { table: "bookings", rowId: " ", version: 7 },
      { table: "bookings", rowId: "booking-alex-haircut", version: 0 },
      { table: "bookings", rowId: "booking-alex-haircut", version: 1.5 },
    ]) {
      await expect(
        service.outboxRows(message("out-x", { personId: "person-alex" }, { versionsRead: [bad] })),
      ).rejects.toThrow(new OutboxRefusedError("versionNotWellFormed"));
    }
  });

  it("the mobile's chat decides the channel: rcs for Tomás, Linq's SMS service as sms (DL-031), iMessage when none is reported", async () => {
    const record = withRows(RECORD, {
      persons: [{ id: "person-sms-chat", name: "Dee W.", language: "en", version: 1 }],
      handles: [
        { id: "handle-sms-chat", kind: "phone", address: "+15555550108" },
        { id: "handle-no-way", kind: "phone", address: "+15555550109" },
      ],
      personHandles: [
        { personId: "person-sms-chat", handleId: "handle-sms-chat" },
        { personId: "person-sms-chat", handleId: "handle-no-way" },
      ],
      phones: [
        phoneRow("handle-sms-chat", "+15555550108", {
          chatOpen: true,
          chatOpenAt: new Date("2026-10-22T10:00:00Z"),
          chatWay: "sms",
        }),
        phoneRow("handle-no-way", "+15555550109", {
          chatOpen: true,
          chatOpenAt: new Date("2026-10-22T10:00:00Z"),
        }),
      ],
    });
    const service = serviceFor(BARBERSHOP, { record, cards: cardsOf([]) });
    const channelOf = async (personId: string, via: string): Promise<string[]> =>
      (await service.outboxRows(message(`out-${via}`, { personId, via }))).rows.map((row) => row.channel);
    expect(await channelOf("person-tomas", "handle-tomas")).toEqual(["rcs"]);
    expect(await channelOf("person-sms-chat", "handle-sms-chat")).toEqual(["sms"]);
    expect(await channelOf("person-sms-chat", "handle-no-way")).toEqual(["imessage"]);
    expect(portOf("sms")).toBe("linq");
  });

  it("the way email sends everything by email, and texts only works like texts (RULES 4.8; Q-07)", async () => {
    const email = serviceFor(BARBERSHOP, { cards: cardsOf([{ ...ALEX_CARD, way: "email" }]) });
    expect(await email.outboxRows(message("out-alex-1", { personId: "person-alex" }))).toEqual({
      rows: [
        {
          id: "out-alex-1",
          recipientHandleId: "handle-alex-email",
          recipientPersonId: "person-alex",
          businessId: BARBERSHOP,
          bookingId: null,
          channel: "email",
          sendClass: "quick_reply",
          openQuestionId: null,
          copyOfRowId: null,
          versionsRead: [],
        },
      ],
      notBuilt: [],
    });
    const textsOnly = serviceFor(BARBERSHOP, { cards: cardsOf([{ ...ALEX_CARD, way: "textsonly" }]) });
    const texts = serviceFor(BARBERSHOP);
    expect(await textsOnly.outboxRows(message("out-alex-2", { personId: "person-alex" }))).toEqual(
      await texts.outboxRows(message("out-alex-2", { personId: "person-alex" })),
    );
    const noEmail = serviceFor(BARBERSHOP, {
      cards: cardsOf([{ ...ALEX_CARD, way: "email", emailHandleId: null }]),
    });
    expect(await noEmail.outboxRows(message("out-alex-3", { personId: "person-alex" }))).toEqual({
      rows: [],
      notBuilt: [{ medium: "email", handleId: null, why: "noEmail" }],
    });
  });

  it("with no reach card the message goes back the way the person writes (S13-19's default); with no such handle, nothing", async () => {
    const service = serviceFor(BARBERSHOP, { cards: cardsOf([]) });
    expect(
      await service.outboxRows(message("out-sam-1", { personId: "person-sam", via: "handle-sam" })),
    ).toEqual({
      rows: [
        {
          id: "out-sam-1",
          recipientHandleId: "handle-sam",
          recipientPersonId: "person-sam",
          businessId: BARBERSHOP,
          bookingId: null,
          channel: "imessage",
          sendClass: "quick_reply",
          openQuestionId: null,
          copyOfRowId: null,
          versionsRead: [],
        },
      ],
      notBuilt: [],
    });
    const byEmail = await service.outboxRows(
      message("out-alex-4", { personId: "person-alex", via: "handle-alex-email" }),
    );
    expect(byEmail.rows.map((row) => [row.id, row.recipientHandleId, row.channel])).toEqual([
      ["out-alex-4", "handle-alex-email", "email"],
    ]);
    const recipients: MessageRequest["to"][] = [
      { personId: "person-sam" },
      { personId: "person-sam", via: null },
      { personId: "person-sam", via: "handle-never-seen" },
    ];
    for (const to of recipients) {
      expect(await service.outboxRows(message("out-sam-2", to))).toEqual({
        rows: [],
        notBuilt: [{ medium: "text", handleId: null, why: "noContact" }],
      });
    }
    const noWay = serviceFor(BARBERSHOP, { cards: cardsOf([{ ...ALEX_CARD, way: null }]) });
    expect(
      await noWay.outboxRows(message("out-alex-5", { personId: "person-alex", via: "handle-alex" })),
    ).toEqual({
      rows: [],
      notBuilt: [{ medium: "text", handleId: null, why: "noContact" }],
    });
  });

  it("a handle nobody is behind yet is answered on that handle, with no person (arch 03 line 165, the doors)", async () => {
    const record = withRows(RECORD, {
      handles: [{ id: "handle-new-sender", kind: "phone", address: "+15555550110" }],
      phones: [
        phoneRow("handle-new-sender", "+15555550110", {
          chatOpen: true,
          chatOpenAt: new Date("2026-10-22T11:00:00Z"),
          chatWay: "imessage",
        }),
      ],
    });
    const { rows, notBuilt } = await serviceFor(BARBERSHOP, { record }).outboxRows(
      message("out-new-sender", { personId: null, via: "handle-new-sender" }),
    );
    expect(notBuilt).toEqual([]);
    expect(rows.map((row) => [row.recipientHandleId, row.recipientPersonId, row.channel])).toEqual([
      ["handle-new-sender", null, "imessage"],
    ]);
  });

  it("a message reaches only the person: a handle that is not theirs is never a recipient (RULES 4.8; S13-19)", async () => {
    const service = serviceFor(BARBERSHOP, { cards: cardsOf([]) });
    expect(
      await service.outboxRows(message("out-alex-6", { personId: "person-alex", via: "handle-sam" })),
    ).toEqual({
      rows: [],
      notBuilt: [{ medium: "text", handleId: "handle-sam", why: "notTheirs" }],
    });
    // A card that names someone else's mobile: that contact is dropped, Alex's own email still gets it, alone.
    const leakyCard = serviceFor(BARBERSHOP, {
      cards: cardsOf([{ ...ALEX_CARD, mobileHandleId: "handle-sam" }]),
    });
    const answer = await leakyCard.outboxRows(message("out-alex-7", { personId: "person-alex" }));
    expect(answer.notBuilt).toEqual([{ medium: "text", handleId: "handle-sam", why: "notTheirs" }]);
    expect(answer.rows.map((row) => [row.id, row.recipientHandleId, row.copyOfRowId])).toEqual([
      ["out-alex-7-email", "handle-alex-email", null],
    ]);
  });
});

describe("C9: a mobile with no open chat is never built as a text row, and the caller is told (MC C9; RULES 4.1b)", () => {
  /** Pat's staff invite went unanswered (K-29 seed-chat-link.json): his phone has never texted Rosie's number. */
  it("Pat's mobile gets no text row for any send class, safety included, and each is reported", async () => {
    expect(phoneOf(RECORD, "handle-pat")).toMatchObject({
      chatOpen: false,
      stopped: false,
      chatOpenAt: null,
    });
    const service = serviceFor(BARBERSHOP, { cards: cardsOf([]) });
    for (const sendClass of SEND_CLASSES) {
      expect(
        await service.outboxRows(
          message(`out-pat-${sendClass}`, { personId: "person-pat", via: "handle-pat" }, { sendClass }),
        ),
      ).toEqual({ rows: [], notBuilt: [{ medium: "text", handleId: "handle-pat", why: "chatNotOpen" }] });
    }
  });

  it("a confirmation to a mobile whose chat was never opened goes by email alone, and the text is reported (MC C2, C9)", async () => {
    const record = withRows(RECORD, { phones: [phoneRow("handle-alex", "+15555550101", { chatWay: null })] });
    const { rows, notBuilt } = await serviceFor(BARBERSHOP, { record }).outboxRows(
      message(
        "out-alex-confirm",
        { personId: "person-alex" },
        { bookingId: "booking-alex-haircut", sendClass: "routine" },
      ),
    );
    expect(notBuilt).toEqual([{ medium: "text", handleId: "handle-alex", why: "chatNotOpen" }]);
    expect(rows.map((row) => [row.id, row.recipientHandleId, row.channel, row.copyOfRowId])).toEqual([
      ["out-alex-confirm-email", "handle-alex-email", "email", null],
    ]);
    expect(faultOf(checkUnits, [unitOf(rows)])).toBeNull();
  });

  it("a phone handle with no phone row, or a card with no mobile, gets no text row either", async () => {
    const record = withRows(RECORD, {
      handles: [{ id: "handle-alex-second", kind: "phone", address: "+15555550111" }],
      personHandles: [{ personId: "person-alex", handleId: "handle-alex-second" }],
    });
    const noPhoneRow = serviceFor(BARBERSHOP, {
      record,
      cards: cardsOf([{ ...ALEX_CARD, mobileHandleId: "handle-alex-second", emailHandleId: null }]),
    });
    expect(await noPhoneRow.outboxRows(message("out-alex-8", { personId: "person-alex" }))).toEqual({
      rows: [],
      notBuilt: [{ medium: "text", handleId: "handle-alex-second", why: "chatNotOpen" }],
    });
    const noMobile = serviceFor(BARBERSHOP, { cards: cardsOf([{ ...ALEX_CARD, mobileHandleId: null }]) });
    const answer = await noMobile.outboxRows(message("out-alex-9", { personId: "person-alex" }));
    expect(answer.notBuilt).toEqual([{ medium: "text", handleId: null, why: "noMobile" }]);
    expect(answer.rows.map((row) => row.id)).toEqual(["out-alex-9-email"]);
  });
});

describe("STOP: a stopped mobile gets only a safety line or the stop's one reply (RULES 7.2, 7.3; MC C1)", () => {
  /** Ben's phone (K-04 seed-phone-stopped.json): stopped, chat closed, once texted Rosie's number. */
  const BEN_CARD = cardAt("person-ben", {
    way: "texts",
    mobileHandleId: "handle-ben",
    emailHandleId: "handle-ben-email",
  });
  const RECORD_BEN_EMAIL = withRows(RECORD, {
    handles: [{ id: "handle-ben-email", kind: "email", address: "ben@example.com" }],
    personHandles: [{ personId: "person-ben", handleId: "handle-ben-email" }],
  });

  it("routine, quick reply and visit-now rows are not built for Ben's mobile and are reported stopped", async () => {
    expect(phoneOf(RECORD, "handle-ben")).toMatchObject({ stopped: true, chatOpen: false });
    const service = serviceFor(BARBERSHOP, { record: RECORD_BEN_EMAIL, cards: cardsOf([BEN_CARD]) });
    for (const sendClass of ["routine", "quick_reply", "visit_now"] as const) {
      const { rows, notBuilt } = await service.outboxRows(
        message(
          `out-ben-${sendClass}`,
          { personId: "person-ben" },
          { sendClass, bookingId: "booking-ben-haircut" },
        ),
      );
      expect(notBuilt).toEqual([{ medium: "text", handleId: "handle-ben", why: "stopped" }]);
      // STOP stops texts from the number it answers (RULES 7.2): his email still gets the message, alone.
      expect(rows.map((row) => [row.id, row.channel, row.copyOfRowId])).toEqual([
        [`out-ben-${sendClass}-email`, "email", null],
      ]);
    }
  });

  it("a safety line goes to Ben's mobile past the stop (arch 02 line 111; RULES 4.12), with its email copy", async () => {
    const service = serviceFor(BARBERSHOP, { record: RECORD_BEN_EMAIL, cards: cardsOf([BEN_CARD]) });
    const { rows, notBuilt } = await service.outboxRows(
      message("out-ben-safety", { personId: "person-ben" }, { sendClass: "safety" }),
    );
    expect(notBuilt).toEqual([]);
    expect(
      rows.map((row) => [row.id, row.recipientHandleId, row.channel, row.sendClass, row.copyOfRowId]),
    ).toEqual([
      ["out-ben-safety", "handle-ben", "imessage", "safety", null],
      ["out-ben-safety-email", "handle-ben-email", "email", "safety", "out-ben-safety"],
    ]);
  });

  it("the stop's one reply goes to Ben's mobile as a quick reply, with no email copy (K-09 stop-recorded.json; RULES 7.3)", async () => {
    const stopReply = message(
      "out-ben-stop-reply",
      { personId: "person-ben", via: "handle-ben" },
      { stopReply: true },
    );
    const expected = {
      rows: [
        {
          id: "out-ben-stop-reply",
          recipientHandleId: "handle-ben",
          recipientPersonId: "person-ben",
          businessId: BARBERSHOP,
          bookingId: null,
          channel: "imessage",
          sendClass: "quick_reply",
          openQuestionId: null,
          copyOfRowId: null,
          versionsRead: [],
        },
      ],
      notBuilt: [],
    };
    const service = serviceFor(BARBERSHOP, { record: RECORD_BEN_EMAIL, cards: cardsOf([BEN_CARD]) });
    expect(await service.outboxRows(stopReply)).toEqual(expected);
    // It answers the stop where it came from, even when his card's way is email.
    const byEmail = serviceFor(BARBERSHOP, {
      record: RECORD_BEN_EMAIL,
      cards: cardsOf([{ ...BEN_CARD, way: "email" }]),
    });
    expect(await byEmail.outboxRows(stopReply)).toEqual(expected);
    // With no handle it came from, there is nowhere to answer.
    expect(await service.outboxRows({ ...stopReply, to: { personId: "person-ben" } })).toEqual({
      rows: [],
      notBuilt: [{ medium: "text", handleId: null, why: "noContact" }],
    });
  });

  it("a stopped mobile that never texted Rosie's number gets nothing, safety and stop replies included (MC C9)", async () => {
    const record = withRows(RECORD, {
      phones: [
        phoneRow("handle-ben", "+15555550106", {
          stopped: true,
          stopAt: new Date("2026-10-20T13:00:00Z"),
          version: 2,
        }),
      ],
    });
    const service = serviceFor(BARBERSHOP, { record, cards: cardsOf([]) });
    const extras: Partial<MessageRequest>[] = [{ sendClass: "safety" }, { stopReply: true }];
    for (const extra of extras) {
      expect(
        await service.outboxRows(message("out-ben-x", { personId: "person-ben", via: "handle-ben" }, extra)),
      ).toEqual({ rows: [], notBuilt: [{ medium: "text", handleId: "handle-ben", why: "stopped" }] });
    }
  });
});

describe("an SMS channel is refused (refuse-sms-channel.json; DL-012)", () => {
  const REFUSED = contractJson("outbox-effects/fixtures/invalid/refuse-sms-channel.json") as {
    row: { channel: string; port: string };
  };

  it("K-07's refused row, sent by an SMS port, is refused; the same row through Linq passes (DL-031: text only)", () => {
    expect(REFUSED.row).toMatchObject({ channel: "sms", port: "sms" });
    expect(k07Problems(REFUSED)).not.toEqual([]);
    expect(faultOf(checkChannelAndPort, REFUSED.row)).toBe("smsPort");
    const throughLinq = { ...REFUSED, row: { ...REFUSED.row, port: "linq" } };
    expect(k07Problems(throughLinq)).toEqual([]);
    expect(faultOf(checkChannelAndPort, throughLinq.row)).toBeNull();
  });

  it("any channel by an SMS port is refused, and a port must follow its channel", () => {
    for (const channel of ["imessage", "rcs", "sms", "email"]) {
      expect(faultOf(checkChannelAndPort, { channel, port: "sms" })).toBe("smsPort");
    }
    expect(faultOf(checkChannelAndPort, { channel: "email", port: "linq" })).toBe("portNotOfChannel");
    expect(faultOf(checkChannelAndPort, { channel: "imessage", port: "email" })).toBe("portNotOfChannel");
    expect(faultOf(checkChannelAndPort, { channel: "voice", port: "linq" })).toBe("channelUnknown");
    for (const channel of ["imessage", "rcs", "sms"]) {
      expect(faultOf(checkChannelAndPort, { channel, port: "linq" })).toBeNull();
    }
    expect(faultOf(checkChannelAndPort, { channel: "email", port: "email" })).toBeNull();
  });

  it("every row the service builds goes by Linq or email, never an SMS port", async () => {
    const record = withRows(RECORD, {
      phones: [
        phoneRow("handle-alex", "+15555550101", {
          chatOpen: true,
          chatOpenAt: new Date("2026-10-12T16:20:00Z"),
          chatWay: "sms",
        }),
      ],
    });
    const { rows } = await serviceFor(BARBERSHOP, { record }).outboxRows(
      message("out-alex-sms", { personId: "person-alex" }),
    );
    expect(rows.map((row) => [row.channel, portOf(row.channel)])).toEqual([
      ["sms", "linq"],
      ["email", "email"],
    ]);
  });
});

describe("consent rows: append-only, bound to the read-back (K-29 v1; FS line 753)", () => {
  it("an update of a consent row is refused (refuse-consent-update.json); the same change as a new row passes", () => {
    const { refused } = contractJson(
      "db-schema/conversations-consent/fixtures/invalid/refuse-consent-update.json",
    ) as {
      refused: {
        action: string;
        table: string;
        set: Record<string, unknown>;
        where: Record<string, unknown>;
      };
    };
    expect(refused).toMatchObject({ action: "update", table: "consents" });
    const update: StateWrite = {
      op: "update",
      table: refused.table,
      key: refused.where,
      expectVersion: 1,
      set: refused.set,
    };
    // K-05's shape lets it through; the code refuses it before the commit, as the database would (42501).
    expect(k05Problems("stateWrite", update)).toEqual([]);
    expect(faultOf(assertConsentsAppendOnly, [update])).toBe("neverEdited");
    const asNewRow: StateWrite = {
      op: "insert",
      table: "consents",
      values: {
        ...seedConsent("seed-consent-fee-ok.json", "consent-sam-fee-ok-barbershop"),
        id: "consent-sam-fee-ok-off",
        ...refused.set,
      },
    };
    expect(faultOf(assertConsentsAppendOnly, [asNewRow])).toBeNull();
    // An update of any other table is not a consent edit.
    const phoneUpdate: StateWrite = {
      op: "update",
      table: "phones",
      key: { number: "+15555550106" },
      expectVersion: 3,
      set: { stopped: true },
    };
    expect(faultOf(assertConsentsAppendOnly, [phoneUpdate])).toBeNull();
  });

  it("a STOP adds a row: Ben's STOP is K-29's own seed row, a new revoked texts row for every business", async () => {
    const before = RECORD.consents.find((row) => row.id === "consent-ben-texts-yes");
    const stop = await serviceFor(BARBERSHOP).stop({
      id: "consent-ben-stop",
      personId: "person-ben",
      handleId: "handle-ben",
      words: "STOP",
      at: "2026-10-20T13:00:00Z",
      channel: "text",
    });
    expect(stop.op).toBe("insert");
    expect(stop.table).toBe("consents");
    expect(stop.values).toEqual(seedConsent("seed-consent-stop-row.json", "consent-ben-stop"));
    expect(k05Problems("stateWrite", stateWriteOf(stop))).toEqual([]);
    expect(faultOf(assertConsentsAppendOnly, [stateWriteOf(stop)])).toBeNull();
    expect(faultOf(checkUnits, [unitOf([], [stateWriteOf(stop)])])).toBeNull();

    // His earlier yes is never named by the STOP and stays as it was; the new row is the newest, so it decides.
    expect(before).toBeDefined();
    expect(stop.values.id).not.toBe("consent-ben-texts-yes");
    const after = appended(RECORD, stop);
    expect(after.consents.find((row) => row.id === "consent-ben-texts-yes")).toEqual(before);
    const runtimeSide = await readerOf(after, null).consentsOfPersons(["person-ben"]);
    expect(textsStanding(runtimeSide, "person-ben", BARBERSHOP, "handle-ben")).toMatchObject({
      id: "consent-ben-stop",
      revoked: true,
    });
    // One number serves every business, so the STOP decides at the yoga studio too (D102; RULES 7.2; MC C1).
    expect(textsStanding(runtimeSide, "person-ben", YOGA_STUDIO, "handle-ben")).toMatchObject({
      id: "consent-ben-stop",
      revoked: true,
    });
    const beforeStop = await readerOf(RECORD, null).consentsOfPersons(["person-ben"]);
    expect(textsStanding(beforeStop, "person-ben", BARBERSHOP, "handle-ben")).toMatchObject({
      id: "consent-ben-texts-yes",
      revoked: false,
    });
  });

  it("START is a new texts row for every business, and turns texts back on as the newest row (RULES 7.5)", async () => {
    const service = serviceFor(BARBERSHOP);
    const stop = await service.stop({
      id: "consent-ben-stop",
      personId: "person-ben",
      handleId: "handle-ben",
      words: "STOP",
      at: "2026-10-20T13:00:00Z",
      channel: "text",
    });
    const start = await service.start({
      id: "consent-ben-start",
      personId: "person-ben",
      handleId: "handle-ben",
      words: "START",
      at: "2026-10-22T09:00:00Z",
      channel: "text",
      turnId: "turn-ben-start",
    });
    expect(start.values).toMatchObject({
      id: "consent-ben-start",
      business_id: null,
      kind: "texts",
      revoked: false,
      handle_id: "handle-ben",
      exact_words: "START",
      words_sha256: await wordsSha256("START"),
      turn_id: "turn-ben-start",
    });
    const rows = await readerOf(appended(appended(RECORD, stop), start), null).consentsOfPersons([
      "person-ben",
    ]);
    expect(textsStanding(rows, "person-ben", YOGA_STUDIO, "handle-ben")).toMatchObject({
      id: "consent-ben-start",
      revoked: false,
    });
  });

  it("a yes is bound to the read-back it answered: Sam's fee OK is K-29's seed row, words and hash; its turn is kept", async () => {
    const seed = seedConsent("seed-consent-fee-ok.json", "consent-sam-fee-ok-barbershop");
    const request = {
      id: "consent-sam-fee-ok-barbershop",
      personId: "person-sam",
      kind: "fee_ok" as const,
      readBack: { words: seed.exact_words as string, turnId: null },
      at: "2026-10-19T14:20:00Z",
      channel: "text" as const,
      fromHandleId: "handle-sam",
    };
    const yes = await serviceFor(BARBERSHOP).yes(request);
    expect(yes.values).toEqual(seed);
    expect(yes.values.words_sha256).toBe("1c065e4d9d3e2a53701ddf2b34ff3458938c9a123574777f29f9511f45c5d290");
    // fee-consent.json: Sam's yes came in turn-sam-s1-25, the turn that commits the row.
    const inTurn = await serviceFor(BARBERSHOP).yes({
      ...request,
      readBack: { ...request.readBack, turnId: "turn-sam-s1-25" },
    });
    expect(inTurn.values).toEqual({ ...seed, turn_id: "turn-sam-s1-25" });
    expect(k05Problems("stateWrite", stateWriteOf(inTurn))).toEqual([]);
  });

  it("a ready text is the texts yes it gives: Ben's for his booking, Avery's to join (K-29 seed-chat-link.json; MC C9)", async () => {
    const service = serviceFor(BARBERSHOP);
    const ben = await service.yes({
      id: "consent-ben-texts-yes",
      personId: "person-ben",
      kind: "texts",
      readBack: { words: "Hey, send me further updates about my booking. Ref 4K7Q", turnId: null },
      at: "2026-10-05T17:00:00Z",
      channel: "text",
      handleId: "handle-ben",
      bookingId: "booking-ben-haircut",
      chatLinkId: "chatlink-ben-haircut",
      fromHandleId: "handle-ben",
    });
    expect(ben.values).toEqual(seedConsent("seed-chat-link.json", "consent-ben-texts-yes"));
    const avery = await service.yes({
      id: "consent-avery-texts-yes",
      personId: "person-avery",
      kind: "texts",
      readBack: { words: "YES. Ref R2V9", turnId: null },
      at: "2026-10-19T15:02:00Z",
      channel: "text",
      handleId: "handle-avery",
      chatLinkId: "chatlink-avery-invite",
      fromHandleId: "handle-avery",
    });
    expect(avery.values).toEqual(seedConsent("seed-chat-link.json", "consent-avery-texts-yes"));
  });

  it("a yes counts only from the person themself, for their own contact; a stop for another number changes nothing (RULES 7.1, 7.2)", async () => {
    const service = serviceFor(BARBERSHOP);
    const alexYes = {
      id: "consent-alex-texts-yes",
      personId: "person-alex",
      kind: "texts" as const,
      readBack: {
        words: "Texts about your haircut at Lee's Barbershop? Reply 1 Yes.",
        turnId: "turn-alex-yes",
      },
      at: "2026-10-23T14:00:00Z",
      channel: "text" as const,
      handleId: "handle-alex",
      bookingId: "booking-alex-haircut",
      fromHandleId: "handle-alex",
    };
    await expect(service.yes(alexYes)).resolves.toMatchObject({ op: "insert" });
    await expect(service.yes({ ...alexYes, handleId: "handle-sam" })).rejects.toThrow(
      new ConsentRefusedError("notTheirContact"),
    );
    await expect(service.yes({ ...alexYes, fromHandleId: "handle-sam" })).rejects.toThrow(
      new ConsentRefusedError("notFromThem"),
    );
    await expect(service.yes({ ...alexYes, fromHandleId: null })).rejects.toThrow(
      new ConsentRefusedError("notFromThem"),
    );
    // A yes on the secure page is proven by the page, not by a handle (K-21); a handle named is still his own.
    await expect(service.yes({ ...alexYes, channel: "page", fromHandleId: null })).resolves.toMatchObject({
      op: "insert",
    });
    await expect(service.yes({ ...alexYes, channel: "page", fromHandleId: "handle-sam" })).rejects.toThrow(
      new ConsentRefusedError("notFromThem"),
    );
    await expect(
      service.stop({
        id: "consent-alex-stop-ben",
        personId: "person-alex",
        handleId: "handle-ben",
        words: "STOP texting Ben",
        at: "2026-10-23T14:01:00Z",
        channel: "text",
      }),
    ).rejects.toThrow(new ConsentRefusedError("notTheirContact"));
  });

  it("for a stopped mobile only a fresh yes on a booking sent from that number counts; START turns on the rest (RULES 7.5; MC C1)", async () => {
    const service = serviceFor(BARBERSHOP);
    const benYes = {
      id: "consent-ben-texts-yes-2",
      personId: "person-ben",
      kind: "texts" as const,
      readBack: {
        words: "Texts about your booking with Lee's Barbershop? Reply 1 Yes.",
        turnId: "turn-ben-book-2",
      },
      at: "2026-10-25T10:00:00Z",
      channel: "text" as const,
      handleId: "handle-ben",
      bookingId: "booking-ben-haircut",
      fromHandleId: "handle-ben",
    };
    await expect(service.yes(benYes)).resolves.toMatchObject({
      values: { booking_id: "booking-ben-haircut" },
    });
    await expect(service.yes({ ...benYes, bookingId: null })).rejects.toThrow(
      new ConsentRefusedError("stoppedNumber"),
    );
    await expect(service.yes({ ...benYes, channel: "page", fromHandleId: null })).rejects.toThrow(
      new ConsentRefusedError("stoppedNumber"),
    );
  });

  it("K-29's rules hold before the commit: no face match, texts name a contact, terms a booking, words and a UTC time", async () => {
    const { refused } = contractJson(
      "db-schema/conversations-consent/fixtures/invalid/refuse-face-match-kind.json",
    ) as { refused: { values: Record<string, unknown> } };
    const service = serviceFor(BARBERSHOP);
    const faceMatch = {
      id: refused.values.id as string,
      personId: refused.values.person_id as string,
      kind: JSON.parse('"face_match"') as ConsentKind,
      readBack: { words: refused.values.exact_words as string, turnId: null },
      at: refused.values.at as string,
      channel: "page" as const,
    };
    await expect(service.yes(faceMatch)).rejects.toThrow(new ConsentRefusedError("kindUnknown"));
    // The same row as photos_shown passes, with the hash K-29's fixture states for those words.
    const photos = await service.yes({ ...faceMatch, kind: "photos_shown" });
    expect(photos.values.words_sha256).toBe(refused.values.words_sha256);

    const fee = {
      id: "consent-sam-x",
      personId: "person-sam",
      kind: "fee_ok" as ConsentKind,
      readBack: { words: "OK?", turnId: null },
      at: "2026-10-19T14:20:00Z",
      channel: "page" as const,
    };
    await expect(service.yes({ ...fee, kind: "texts" })).rejects.toThrow(
      new ConsentRefusedError("textsNeedContact"),
    );
    await expect(service.yes({ ...fee, kind: "ticked_terms" })).rejects.toThrow(
      new ConsentRefusedError("termsNeedBooking"),
    );
    await expect(service.yes({ ...fee, chatLinkId: "chatlink-ben-haircut" })).rejects.toThrow(
      new ConsentRefusedError("chatLinkOnlyTexts"),
    );
    await expect(service.yes({ ...fee, readBack: { words: "  ", turnId: null } })).rejects.toThrow(
      new ConsentRefusedError("wordsMissing"),
    );
    for (const at of ["2026-10-19 14:20:00", "2026-10-19T14:20:00-04:00", "2026-02-30T14:20:00Z"]) {
      await expect(service.yes({ ...fee, at })).rejects.toThrow(new ConsentRefusedError("timeNotUtc"));
    }
    await expect(service.yes({ ...fee, channel: JSON.parse('"call"') as "page" })).rejects.toThrow(
      new ConsentRefusedError("channelUnknown"),
    );
    await expect(
      service.stop({
        id: "consent-ben-x",
        personId: "person-ben",
        handleId: "handle-ben",
        words: "",
        at: fee.at,
        channel: "text",
      }),
    ).rejects.toThrow(new ConsentRefusedError("wordsMissing"));
  });

  it("the newest row decides, a tie to the lower id (K-29 README; K-05 v1.2 default 35)", () => {
    const at = new Date("2026-10-20T13:00:00Z");
    const rows = [
      { id: "b", at },
      { id: "a", at },
      { id: "c", at: new Date("2026-10-19T13:00:00Z") },
    ];
    expect(newestDecides(rows)).toEqual({ id: "a", at });
    expect(newestDecides([])).toBeNull();
  });
});

describe("how a person is reached: the way, chat open, stopped and stored language (RULES 4.8, 4.1b; K-04 v1)", () => {
  it("Alex at the barbershop: his card, his mobile with its open iMessage chat and thread, his email, English", async () => {
    const asked: CardAsked[] = [];
    const service = serviceFor(BARBERSHOP, { cards: cardsOf([ALEX_CARD], asked) });
    expect(await service.reach("person-alex")).toEqual({
      personId: "person-alex",
      language: "en",
      card: { way: "texts", mobileHandleId: "handle-alex", emailHandleId: "handle-alex-email" },
      mobiles: [
        {
          handleId: "handle-alex",
          chatOpen: true,
          chatWay: "imessage",
          stopped: false,
          chatThreadId: "thread-alex-chat",
          texts: null,
        },
      ],
      emails: [{ handleId: "handle-alex-email", texts: null }],
    });
    expect(asked).toEqual([{ businessId: BARBERSHOP, personId: "person-alex" }]);
  });

  it("Ben is stopped with his chat closed; under the scope his STOP row is hidden and the stopped flag tells it (K-29 rule 4)", async () => {
    const record = withRows(RECORD, {
      consents: [
        {
          id: "consent-ben-stop",
          personId: "person-ben",
          businessId: null,
          kind: "texts",
          revoked: true,
          handleId: "handle-ben",
          bookingId: null,
          wordsSha256: await wordsSha256("STOP"),
          at: new Date("2026-10-20T13:00:00Z"),
          channel: "text",
          chatLinkId: null,
          turnId: null,
          exactWords: "STOP",
        },
      ],
    });
    const scoped = await serviceFor(BARBERSHOP, { record, cards: cardsOf([]) }).reach("person-ben");
    expect(scoped).toEqual({
      personId: "person-ben",
      language: "en",
      card: null,
      mobiles: [
        {
          handleId: "handle-ben",
          chatOpen: false,
          chatWay: "imessage",
          stopped: true,
          chatThreadId: null,
          texts: { consentId: "consent-ben-texts-yes", revoked: false },
        },
      ],
      emails: [],
    });
    // On the runtime side, with every row read, the STOP is the row that decides.
    const runtime = await serviceFor(BARBERSHOP, { record, cards: cardsOf([]), scope: null }).reach(
      "person-ben",
    );
    expect(runtime?.mobiles[0]?.texts).toEqual({ consentId: "consent-ben-stop", revoked: true });
  });

  it("Pat's chat was never opened, Tomás chats by RCS, and a person not on the record is nobody", async () => {
    const service = serviceFor(BARBERSHOP, { cards: cardsOf([]) });
    expect((await service.reach("person-pat"))?.mobiles).toEqual([
      {
        handleId: "handle-pat",
        chatOpen: false,
        chatWay: null,
        stopped: false,
        chatThreadId: null,
        texts: null,
      },
    ]);
    expect((await service.reach("person-tomas"))?.mobiles[0]).toMatchObject({
      chatOpen: true,
      chatWay: "rcs",
    });
    expect(await service.reach("person-never-seen")).toBeNull();
  });

  it("another business's yes never counts here: Ben's texts yes is the barbershop's, not the yoga studio's", async () => {
    const yoga = await serviceFor(YOGA_STUDIO, { cards: cardsOf([]) }).reach("person-ben");
    expect(yoga?.mobiles[0]?.texts).toBeNull();
    // Even a reader that gives every business's rows changes nothing for another business's yes.
    const leaky = await serviceFor(YOGA_STUDIO, { cards: cardsOf([]), scope: null }).reach("person-ben");
    expect(leaky?.mobiles[0]?.texts).toBeNull();
  });
});

describe("one business per service, ids and labels only, nothing logged (K-08 v1; CQ-59)", () => {
  let spies: MockInstance[] = [];

  beforeEach(() => {
    spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  it("no read or row answer carries a name, a number, an address or a message's words, and nothing is logged", async () => {
    const privateValues = new Set(RECORD.privateValues);
    expect(privateValues).toContain("Alex M.");
    expect(privateValues).toContain("+15555550101");
    expect(privateValues).toContain("alex@example.com");
    expect(privateValues).toContain("Haircut at Lee's Barbershop this Saturday?");
    const people = [...new Set(RECORD.personHandles.map((link) => link.personId))];
    const answers: unknown[] = [];
    for (const businessId of [BARBERSHOP, YOGA_STUDIO]) {
      const service = serviceFor(businessId);
      for (const personId of people) {
        answers.push(await service.reach(personId));
        for (const sendClass of SEND_CLASSES) {
          for (const link of RECORD.personHandles.filter((each) => each.personId === personId)) {
            answers.push(
              await service.outboxRows(
                message(`out-${personId}`, { personId, via: link.handleId }, { sendClass }),
              ),
            );
          }
        }
      }
    }
    const strings = stringsIn(answers);
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.filter((value) => privateValues.has(value))).toEqual([]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("every row is the service's own business's, whichever business the card was asked for", async () => {
    const asked: CardAsked[] = [];
    const service = serviceFor(YOGA_STUDIO, { cards: cardsOf([ALEX_CARD], asked) });
    const { rows } = await service.outboxRows(
      message("out-alex-yoga", { personId: "person-alex", via: "handle-alex" }),
    );
    // Alex's card is the barbershop's: the yoga studio has none, so the message goes back the way he writes.
    expect(asked).toEqual([{ businessId: YOGA_STUDIO, personId: "person-alex" }]);
    expect(rows.map((row) => [row.businessId, row.recipientHandleId, row.copyOfRowId])).toEqual([
      [YOGA_STUDIO, "handle-alex", null],
    ]);
    const yes = await service.yes({
      id: "consent-alex-yoga",
      personId: "person-alex",
      kind: "plan_terms",
      readBack: { words: "Plan terms for the workshop series. Reply 1 OK.", turnId: "turn-alex-yoga" },
      at: "2026-10-23T15:00:00Z",
      channel: "text",
      fromHandleId: "handle-alex",
    });
    expect(yes.values.business_id).toBe(YOGA_STUDIO);
  });

  it("a missing id is refused naming the argument, a refusal names its fault, and neither carries a value", async () => {
    expect(() => createMessagesConsent({ businessId: "", reader: readerOf(RECORD, null) })).toThrow(
      new TypeError("businessId must be a non-empty id"),
    );
    const service = serviceFor(BARBERSHOP);
    await expect(service.reach(" ")).rejects.toThrow(new TypeError("personId must be a non-empty id"));
    await expect(service.outboxRows(message("", { personId: "person-alex" }))).rejects.toThrow(
      new TypeError("id must be a non-empty id"),
    );
    await expect(service.outboxRows(message("out-x", { personId: "" }))).rejects.toThrow(
      new TypeError("to.personId must be a non-empty id"),
    );
    await expect(
      service.outboxRows(
        message("out-x", { personId: "person-alex" }, { sendClass: JSON.parse('"later"') as "routine" }),
      ),
    ).rejects.toThrow(new OutboxRefusedError("sendClassUnknown"));
    const refusal = new ConsentRefusedError("notTheirContact");
    expect(refusal.message).toBe("consent row refused: notTheirContact");
    expect(new OutboxRefusedError("smsPort").message).toBe("outbox row refused: smsPort");
  });
});
