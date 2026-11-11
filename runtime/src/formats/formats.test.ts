// T-261 (C-128), run by `npm run test:unit -- runtime/src/formats`: for each outbox row, what this phone allows right
// now (arch 07 line 365, "How the AI picks the format", and the formats table, lines 377 to 393), never bold, read
// receipts (MC 8 'iPhone tests') or arch 07 line 393's Never row. First the card's list, in its order; then the channel
// rules and each format's rule of the table. The capability check is K-11 v1's, answered by the Linq double (C-211) and
// by capability.json, since no Linq line serves the new build yet (J-08). Phones and handles are K-04 v1's seed rows
// (Alex has voted in a poll, Riley has not, Tomás's chat is RCS, Ben's chat is closed); the answered text is K-06 v1's
// text-imessage.json; the typed options are msgtext.js's form of A6-02's buttons as bundle-mini-a.json writes it.
// Test values only (rule 9).
import { createLinqDouble, type LinqDouble } from "@rosie/adapters/linq/double";
import inboundEventV1 from "@rosie/contracts/inbound-event/inbound-event.v1.schema.json";
import textImessage from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import messagePlanV1 from "@rosie/contracts/message-plan/message-plan.v1.schema.json";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CAPABILITY_CACHE_MS, CapabilityCache } from "./capability";
import {
  CODE_FORMATS,
  FORMATS,
  NEVER_FORMATS,
  POLL_OPTIONS,
  UNTESTED_FORMATS,
  allowedFormatsFor,
  formatsOn,
  formatsToSend,
  typedOptionsFor,
} from "./formats";
import {
  ALEX,
  BEN,
  RILEY,
  SAM,
  TOMAS,
  answeredOf,
  fakeClock,
  fixturePort,
  seedPhone,
  textFrom,
} from "./test-support";
import type {
  AllowedFormats,
  AnsweredText,
  CalendarFile,
  CapabilityLookup,
  Channel,
  CodeFormat,
  Format,
  FormatsRow,
  InboundKind,
  InboundService,
  PhoneRecipient,
  Recipient,
  Situation,
  StepFacts,
} from "./types";

/** msgtext.js's text form of A6-02's buttons Accept, Another time, Decline (bundle-mini-a.json's plainText). */
const TYPED = "Reply 1 Accept, 2 Another time, 3 Decline.";

/** A step with each element the table reads: a closed question of 3 options, a secure link, a confirmation's file. */
const EVERY_ELEMENT: StepFacts = {
  optionCount: 3,
  pageTypes: [],
  allowedLinks: ["link.secure"],
  calendarFile: "new",
  openQuestionCount: 1,
  turnAllNoOp: false,
  situation: "moneyOrConsent",
};

/** A "thanks!" turn: every part no_op, no question open, the tag routine, nothing to show (arch 07 line 391). */
const THANKS: StepFacts = {
  optionCount: 0,
  pageTypes: [],
  allowedLinks: [],
  calendarFile: "none",
  openQuestionCount: 0,
  turnAllNoOp: true,
  situation: "routine",
};

/** An email address's handle (one handle per address: arch 01 line 55). */
const SAM_EMAIL: Recipient = { kind: "email", handleId: "handle-sam-email" };

/** What the double's capability check answers, each in turn (K-11 v1 capabilityCheck.response and .errors). */
const CAPABILITIES = [
  { result: "checked", imessage: true, service: "imessage" },
  { result: "checked", imessage: false, service: "rcs" },
  { result: "checked", imessage: false, service: "sms" },
  { result: "checked", imessage: true, service: null },
  { result: "checked", imessage: false, service: null },
  { result: "failed", code: "1007", reason: "Rate limit." },
] as const;

/** K-06 v1's services and kinds, from the schema itself. */
const SERVICES = inboundEventV1.$defs.service.enum as readonly InboundService[];
const KINDS = inboundEventV1.$defs.kind.enum as readonly InboundKind[];

/** K-03 v1's channels, tags and calendar files, from the schema itself. */
const CHANNELS = messagePlanV1.$defs.channel.enum as readonly Channel[];
const SITUATIONS = messagePlanV1.$defs.situation.enum as readonly Situation[];
const CALENDAR_FILES = messagePlanV1.$defs.calendarFile.enum as readonly CalendarFile[];

/** A lookup that throws, as a broken cache would. */
const BROKEN: CapabilityLookup = {
  lookup: () => Promise.reject(new Error("the cache is broken")),
};

/** Riley's phone, which has not voted in a poll. */
const riley = (): PhoneRecipient => seedPhone(RILEY);

function setUp(): { linq: LinqDouble; cache: CapabilityCache; clock: ReturnType<typeof fakeClock> } {
  const clock = fakeClock();
  const linq = createLinqDouble();
  return { linq, clock, cache: new CapabilityCache(linq, { now: clock.now }) };
}

/** The texts a row's turn may answer: none, one of the recipient's own on each service and kind, or someone else's. */
function answersFor(to: Recipient): (AnsweredText | null)[] {
  const own = (service: InboundService | null, kind: InboundKind): AnsweredText => ({
    fromHandleId: to.handleId,
    service,
    kind,
  });
  return [
    null,
    ...[null, ...SERVICES].map((service) => own(service, "text")),
    ...KINDS.map((kind) => own("imessage", kind)),
    answeredOf(textImessage),
  ];
}

const isListed = (list: readonly string[], name: string): boolean => list.includes(name);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the card's list (T-261 'Proves it with')", () => {
  it("an iMessage reply allows text, poll, link card and calendar file", async () => {
    const { linq, cache } = setUp();
    const alexText = answeredOf(textImessage);
    expect(alexText).toEqual({ fromHandleId: "handle-alex", service: "imessage", kind: "text" });

    const allowed = await allowedFormatsFor(
      { to: seedPhone(ALEX), answers: alexText, step: EVERY_ELEMENT },
      cache,
    );

    expect(allowed).toEqual({
      channel: "imessage",
      channelFrom: "answeredText",
      formats: ["text", "poll", "linkCard", "calendarFile"],
      codeFormats: ["typingDots"],
      choicesOnlyInPoll: true,
    });
    // The reply's own service told the channel: Linq was asked nothing.
    expect(linq.capabilityCheckRequests()).toEqual([]);
  });

  it("an RCS reply allows text and link card", async () => {
    const { linq, cache } = setUp();
    const tomas = seedPhone(TOMAS);

    const allowed = await allowedFormatsFor(
      { to: tomas, answers: textFrom(tomas, "rcs"), step: EVERY_ELEMENT },
      cache,
    );

    expect(allowed).toEqual({
      channel: "rcs",
      channelFrom: "answeredText",
      formats: ["text", "linkCard"],
      codeFormats: [],
      choicesOnlyInPoll: false,
    });
    expect(linq.capabilityCheckRequests()).toEqual([]);
  });

  it("capability.json's RCS answer for Tomás, with no text to answer, allows text and link card: no poll or file", async () => {
    const { port, asked } = fixturePort();
    const cache = new CapabilityCache(port, { now: fakeClock().now });

    const allowed = await allowedFormatsFor(
      { to: seedPhone(TOMAS), answers: null, step: EVERY_ELEMENT },
      cache,
    );

    expect(allowed.channel).toBe("rcs");
    expect(allowed.channelFrom).toBe("capabilityCheck");
    expect(allowed.formats).toEqual(["text", "linkCard"]);
    expect(asked).toEqual([TOMAS]);
  });

  it("an SMS-reported text allows text only (CQ-11)", async () => {
    const { linq, cache } = setUp();
    const steps = [EVERY_ELEMENT, THANKS, { ...EVERY_ELEMENT, pageTypes: ["visit"], openQuestionCount: 3 }];

    for (const step of steps) {
      const allowed = await allowedFormatsFor(
        { to: riley(), answers: textFrom(riley(), "sms"), step },
        cache,
      );
      expect(allowed).toEqual({
        channel: "sms",
        channelFrom: "answeredText",
        formats: ["text"],
        codeFormats: [],
        choicesOnlyInPoll: false,
      });
    }
    expect(linq.capabilityCheckRequests()).toEqual([]);
  });

  it("a capability-check failure gives text alone", async () => {
    const { linq, cache } = setUp();
    linq.setCapability(RILEY, { result: "failed", code: "1007", reason: "Rate limit." });

    // No text of Riley's to answer (a clock firing), so the check decides, and it fails.
    const allowed = await allowedFormatsFor({ to: riley(), answers: null, step: EVERY_ELEMENT }, cache);

    expect(allowed).toEqual({
      channel: null,
      channelFrom: "checkFailed",
      formats: ["text"],
      codeFormats: [],
      choicesOnlyInPoll: false,
    });
    expect(linq.capabilityCheckRequests()).toEqual([RILEY]);
  });

  it("a check that cannot tell, or a lookup that throws, gives text alone as well", async () => {
    const { linq, cache } = setUp();
    linq.setCapability(RILEY, { result: "checked", imessage: false, service: null });
    const row: FormatsRow = { to: riley(), answers: null, step: EVERY_ELEMENT };
    const textAlone = { channel: null, channelFrom: "checkFailed", formats: ["text"] };

    await expect(allowedFormatsFor(row, cache)).resolves.toMatchObject(textAlone);
    await expect(allowedFormatsFor(row, BROKEN)).resolves.toMatchObject(textAlone);
  });

  it("a second lookup inside 10 minutes uses the cache", async () => {
    const { linq, cache, clock } = setUp();
    const row: FormatsRow = { to: riley(), answers: null, step: EVERY_ELEMENT };

    const first = await allowedFormatsFor(row, cache);
    clock.advance(CAPABILITY_CACHE_MS - 1);
    const second = await allowedFormatsFor(row, cache);

    expect(first.channelFrom).toBe("capabilityCheck");
    expect(second.channelFrom).toBe("capabilityCache");
    expect(first.formats).toEqual(["text", "poll", "linkCard", "calendarFile"]);
    expect(second.formats).toEqual(first.formats);
    expect(linq.capabilityCheckRequests()).toEqual([RILEY]);

    // At 10 minutes the answer is old: Linq is asked again.
    clock.advance(1);
    await expect(allowedFormatsFor(row, cache)).resolves.toMatchObject({ channelFrom: "capabilityCheck" });
    expect(linq.capabilityCheckRequests()).toEqual([RILEY, RILEY]);
  });

  it("until the handle has voted in a poll, a poll plan also carries the options in text form", async () => {
    const { cache } = setUp();
    const notVoted = seedPhone(RILEY);
    const voted = seedPhone(ALEX);
    expect([notVoted.votedInPoll, voted.votedInPoll]).toEqual([false, true]);

    const beforeVote = await allowedFormatsFor(
      { to: notVoted, answers: textFrom(notVoted, "imessage"), step: EVERY_ELEMENT },
      cache,
    );
    const afterVote = await allowedFormatsFor(
      { to: voted, answers: textFrom(voted, "imessage"), step: EVERY_ELEMENT },
      cache,
    );
    expect(beforeVote.formats).toContain("poll");
    expect(afterVote.formats).toContain("poll");
    expect(beforeVote.choicesOnlyInPoll).toBe(false);
    expect(afterVote.choicesOnlyInPoll).toBe(true);

    // A poll plan: until the vote the words carry the options too; after it, the choices go only in the poll.
    expect(typedOptionsFor(beforeVote, ["text", "poll"], TYPED)).toBe(TYPED);
    expect(typedOptionsFor(afterVote, ["text", "poll"], TYPED)).toBeNull();
    // Without a poll, the words carry them either way (arch 07 line 365).
    expect(typedOptionsFor(beforeVote, ["text"], TYPED)).toBe(TYPED);
    expect(typedOptionsFor(afterVote, ["text"], TYPED)).toBe(TYPED);
    expect(typedOptionsFor(afterVote, ["text", "linkCard"], TYPED)).toBe(TYPED);
    // A step with no options has none to carry.
    expect(typedOptionsFor(beforeVote, ["text", "poll"], null)).toBeNull();

    // Where no poll is allowed (RCS), a poll plan goes as text alone, so the words carry the options even after a vote.
    const rcs: AllowedFormats = { ...afterVote, channel: "rcs", formats: ["text", "linkCard"] };
    expect(typedOptionsFor(rcs, ["text", "poll"], TYPED)).toBe(TYPED);
  });

  it("bold and read receipts are never listed (MC 8), nor anything on the Never row", async () => {
    // K-03 v1's closed list is the list allowed formats come from, and it holds neither (MC 8: off until tested).
    const k03Formats = messagePlanV1.$defs.format.enum;
    expect([...FORMATS]).toEqual(k03Formats);
    expect(UNTESTED_FORMATS).toEqual(["bold", "readReceipt"]);
    for (const name of [...UNTESTED_FORMATS, ...NEVER_FORMATS]) {
      expect(k03Formats).not.toContain(name);
      expect(isListed(CODE_FORMATS, name)).toBe(false);
    }

    // Every row this sweep makes: no list names one, and each holds only K-03 formats and code formats, text first.
    const seen = new Set<string>();
    const wrong: string[] = [];
    for (const capability of CAPABILITIES) {
      for (const to of [seedPhone(RILEY), seedPhone(ALEX), seedPhone(BEN), SAM_EMAIL]) {
        for (const answers of answersFor(to)) {
          for (const step of [
            EVERY_ELEMENT,
            THANKS,
            { ...THANKS, pageTypes: ["visit"], openQuestionCount: 2 },
          ]) {
            const { linq, cache } = setUp();
            if (to.kind === "phone") linq.setCapability(to.phone, capability);
            const allowed = await allowedFormatsFor({ to, answers, step }, cache);
            const named: readonly string[] = [...allowed.formats, ...allowed.codeFormats];
            for (const name of named) seen.add(name);
            const outside = named.filter((name) => !isListed(FORMATS, name) && !isListed(CODE_FORMATS, name));
            if (outside.length > 0 || allowed.formats[0] !== "text") wrong.push(named.join(","));
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    for (const name of [...UNTESTED_FORMATS, ...NEVER_FORMATS]) expect(seen.has(name)).toBe(false);
    // The sweep did reach every K-03 format and every code format.
    expect([...seen].sort()).toEqual([...FORMATS, ...CODE_FORMATS].sort());
  });
});

describe("the channel, first that tells (arch 07 line 365)", () => {
  it("an email row takes text alone and asks Linq nothing", async () => {
    const { linq, cache } = setUp();
    const emailed: AnsweredText = { fromHandleId: SAM_EMAIL.handleId, service: "email", kind: "text" };

    const allowed = await allowedFormatsFor({ to: SAM_EMAIL, answers: emailed, step: EVERY_ELEMENT }, cache);

    expect(allowed).toEqual({
      channel: "email",
      channelFrom: "email",
      formats: ["text"],
      codeFormats: [],
      choicesOnlyInPoll: false,
    });
    expect(linq.capabilityCheckRequests()).toEqual([]);
  });

  it("with no chat, text alone: Rosie never opens one, so Linq is asked nothing (Ben's, closed by STOP)", async () => {
    const { linq, cache } = setUp();
    const ben = seedPhone(BEN);
    expect(ben.chatOpen).toBe(false);

    for (const answers of [null, textFrom(ben, "imessage")]) {
      await expect(allowedFormatsFor({ to: ben, answers, step: EVERY_ELEMENT }, cache)).resolves.toEqual({
        channel: null,
        channelFrom: "noChat",
        formats: ["text"],
        codeFormats: [],
        choicesOnlyInPoll: false,
      });
    }
    expect(linq.capabilityCheckRequests()).toEqual([]);
  });

  it("another person's text never tells this row's channel: Alex's iMessage text, Sam's row by the check", async () => {
    const { linq, cache } = setUp();
    linq.setCapability(SAM, { result: "checked", imessage: false, service: "rcs" });

    const allowed = await allowedFormatsFor(
      { to: seedPhone(SAM), answers: answeredOf(textImessage), step: EVERY_ELEMENT },
      cache,
    );

    expect(allowed).toMatchObject({
      channel: "rcs",
      channelFrom: "capabilityCheck",
      formats: ["text", "linkCard"],
    });
    // Not a reply to Sam, so no typing dots or thread for Sam either.
    expect(allowed.codeFormats).toEqual([]);
    expect(linq.capabilityCheckRequests()).toEqual([SAM]);
  });

  it("an answered text whose service is none or email leaves the channel to the check", async () => {
    for (const service of [null, "email"] as const) {
      const { linq, cache } = setUp();
      const allowed = await allowedFormatsFor(
        { to: riley(), answers: textFrom(riley(), service), step: EVERY_ELEMENT },
        cache,
      );
      expect(allowed).toMatchObject({ channel: "imessage", channelFrom: "capabilityCheck" });
      expect(linq.capabilityCheckRequests()).toEqual([RILEY]);
    }
  });

  it.each<[string, (typeof CAPABILITIES)[number], Channel | null]>([
    ["iMessage", CAPABILITIES[0], "imessage"],
    ["RCS", CAPABILITIES[1], "rcs"],
    ["SMS", CAPABILITIES[2], "sms"],
    ["no service named, but iMessage", CAPABILITIES[3], "imessage"],
    ["no service named and no iMessage, so it cannot tell", CAPABILITIES[4], null],
    ["a failure", CAPABILITIES[5], null],
  ])("a check answering %s gives that channel", async (_name, capability, channel) => {
    const { linq, cache } = setUp();
    linq.setCapability(RILEY, capability);

    const allowed = await allowedFormatsFor({ to: riley(), answers: null, step: EVERY_ELEMENT }, cache);

    expect(allowed.channel).toBe(channel);
    expect(allowed.channelFrom).toBe(channel === null ? "checkFailed" : "capabilityCheck");
  });
});

/** A rule of the table: whether a channel, a step and the text a row replies to allow the format. */
type Rule = (channel: Channel | null, step: StepFacts, reply: AnsweredText | null) => boolean;

/** Each format as the table allows it (arch 07 lines 377 to 393), written out from the table. */
const TABLE: Readonly<Record<Format, Rule>> = {
  text: () => true,
  poll: (channel, step) =>
    channel === "imessage" && step.optionCount >= POLL_OPTIONS.min && step.optionCount <= POLL_OPTIONS.max,
  linkCard: (channel, step) =>
    (channel === "imessage" || channel === "rcs") &&
    (step.pageTypes.length > 0 ||
      step.allowedLinks.includes("link.secure") ||
      step.allowedLinks.includes("link.pay")),
  calendarFile: (channel, step) => channel === "imessage" && step.calendarFile !== "none",
  tapback: (channel, step, reply) =>
    channel === "imessage" &&
    reply !== null &&
    (reply.kind === "text" || reply.kind === "photo") &&
    step.turnAllNoOp &&
    step.openQuestionCount === 0 &&
    step.situation === "routine",
};

/** Code's own formats as the table allows them (arch 07 lines 385, 389). */
const CODE_TABLE: Readonly<Record<CodeFormat, Rule>> = {
  typingDots: (channel, _step, reply) => channel === "imessage" && reply !== null,
  threadedReply: (channel, step, reply) =>
    channel === "imessage" && reply !== null && step.openQuestionCount >= 2,
};

/** Every step the sweep reads: each count, list, file, tag and flag the table looks at. */
function everyStep(): StepFacts[] {
  const steps: StepFacts[] = [];
  for (const optionCount of [0, 1, 2, 3, 5, 6])
    for (const pageTypes of [[], ["visit"]])
      for (const allowedLinks of [[], ["link.secure"], ["link.pay"], ["link.chat", "link.chatqr"]])
        for (const calendarFile of CALENDAR_FILES)
          for (const openQuestionCount of [0, 1, 2, 3])
            for (const turnAllNoOp of [true, false])
              for (const situation of SITUATIONS)
                steps.push({
                  optionCount,
                  pageTypes,
                  allowedLinks,
                  calendarFile,
                  openQuestionCount,
                  turnAllNoOp,
                  situation,
                });
  return steps;
}

describe("each format as the table allows it (arch 07 lines 377 to 393)", () => {
  it("lists a format exactly when the table allows it, over every channel, step and reply", () => {
    const to = riley();
    const replies: (AnsweredText | null)[] = [
      null,
      ...(["text", "photo", "pollVote", "reaction", "edit"] as const).map((kind) =>
        textFrom(to, "imessage", kind),
      ),
      answeredOf(textImessage),
    ];
    const wrong: string[] = [];
    let rows = 0;
    for (const step of everyStep()) {
      for (const channel of [null, ...CHANNELS]) {
        for (const answers of replies) {
          rows += 1;
          const reply = answers?.fromHandleId === to.handleId ? answers : null;
          const listed = formatsOn(channel, { to, answers, step });
          const formats = FORMATS.filter((format) => TABLE[format](channel, step, reply));
          const code = CODE_FORMATS.filter((format) => CODE_TABLE[format](channel, step, reply));
          if (listed.formats.join() !== formats.join() || listed.codeFormats.join() !== code.join()) {
            wrong.push(JSON.stringify({ channel, step, answers, listed }));
          }
        }
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(rows).toBeGreaterThan(100_000);
  });

  it("a poll needs a closed question of 2 to 5 options, on iMessage", () => {
    const row = (optionCount: number): FormatsRow => ({
      to: riley(),
      answers: textFrom(riley(), "imessage"),
      step: { ...EVERY_ELEMENT, optionCount },
    });
    const pollAt = (count: number): boolean => formatsOn("imessage", row(count)).formats.includes("poll");

    expect([0, 1, 2, 5, 6].map(pollAt)).toEqual([false, false, true, true, false]);
    expect(formatsOn("rcs", row(3)).formats).not.toContain("poll");
  });

  it("a link card needs an action on a secure page: a page type, the secure link or the pay link", () => {
    const listsCard = (pageTypes: string[], allowedLinks: string[]): boolean =>
      formatsOn("rcs", {
        to: riley(),
        answers: null,
        step: { ...THANKS, pageTypes, allowedLinks },
      }).formats.includes("linkCard");

    expect(listsCard(["visit"], [])).toBe(true);
    expect(listsCard([], ["link.secure"])).toBe(true);
    expect(listsCard([], ["link.pay"])).toBe(true);
    // The chat link opens Messages, not a secure page; its QR code is never in a text.
    expect(listsCard([], ["link.chat", "link.chatqr"])).toBe(false);
    expect(listsCard([], [])).toBe(false);
  });

  it("a calendar file needs a confirmation, a move or a call-off, on iMessage", () => {
    const listsFile = (channel: Channel, calendarFile: CalendarFile): boolean =>
      formatsOn(channel, { to: riley(), answers: null, step: { ...THANKS, calendarFile } }).formats.includes(
        "calendarFile",
      );

    expect(CALENDAR_FILES.map((file) => listsFile("imessage", file))).toEqual(
      CALENDAR_FILES.map((file) => file !== "none"),
    );
    expect(listsFile("rcs", "new")).toBe(false);
    expect(listsFile("sms", "new")).toBe(false);
  });

  it("a tapback goes in place of a reply to a 'thanks!' on iMessage, never on a poll vote", async () => {
    const { cache } = setUp();
    const thanks = textFrom(riley(), "imessage");
    const tapback = (answers: AnsweredText | null, step: StepFacts, channel: Channel = "imessage"): boolean =>
      formatsOn(channel, { to: riley(), answers, step }).formats.includes("tapback");

    await expect(
      allowedFormatsFor({ to: riley(), answers: thanks, step: THANKS }, cache),
    ).resolves.toMatchObject({
      formats: ["text", "tapback"],
    });
    expect(tapback(textFrom(riley(), "imessage", "photo"), THANKS)).toBe(true);
    // Not on a poll (Linq rejects it), a reaction, or anything else with no message of the person's own.
    expect(tapback(textFrom(riley(), "imessage", "pollVote"), THANKS)).toBe(false);
    expect(tapback(textFrom(riley(), "imessage", "reaction"), THANKS)).toBe(false);
    // Not with a question open, a tag other than routine, a part that is not no_op, no reply, or off iMessage.
    expect(tapback(thanks, { ...THANKS, openQuestionCount: 1 })).toBe(false);
    expect(tapback(thanks, { ...THANKS, situation: "gentle" })).toBe(false);
    expect(tapback(thanks, { ...THANKS, turnAllNoOp: false })).toBe(false);
    expect(tapback(null, THANKS)).toBe(false);
    expect(tapback(thanks, THANKS, "rcs")).toBe(false);
  });

  it("typing dots go on an iMessage reply, and a threaded reply when several questions are open", () => {
    const reply = textFrom(riley(), "imessage");
    const code = (answers: AnsweredText | null, openQuestionCount: number, channel: Channel = "imessage") =>
      formatsOn(channel, { to: riley(), answers, step: { ...EVERY_ELEMENT, openQuestionCount } }).codeFormats;

    expect(code(reply, 1)).toEqual(["typingDots"]);
    expect(code(reply, 2)).toEqual(["typingDots", "threadedReply"]);
    expect(code(null, 2)).toEqual([]);
    expect(code(reply, 2, "rcs")).toEqual([]);
    expect(code(reply, 2, "sms")).toEqual([]);
  });
});

describe("a plan outside the list goes as text alone (arch 07 line 365)", () => {
  const rcs: AllowedFormats = {
    channel: "rcs",
    channelFrom: "answeredText",
    formats: ["text", "linkCard"],
    codeFormats: [],
    choicesOnlyInPoll: false,
  };

  it("keeps a plan whose formats this phone all allows now, in K-03's order", () => {
    expect(formatsToSend(rcs, ["linkCard", "text"])).toEqual(["text", "linkCard"]);
    expect(formatsToSend(rcs, ["text"])).toEqual(["text"]);
  });

  it("sends text alone for a format this phone does not allow, one that is not K-03's, or none at all", () => {
    expect(formatsToSend(rcs, ["text", "poll"])).toEqual(["text"]);
    expect(formatsToSend(rcs, ["text", "bold"])).toEqual(["text"]);
    expect(formatsToSend(rcs, ["readReceipt"])).toEqual(["text"]);
    expect(formatsToSend(rcs, [])).toEqual(["text"]);
  });
});

describe("what it gives and never does", () => {
  it("logs nothing, so no number or chat id reaches a log", async () => {
    const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
    const spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const { linq, cache, clock } = setUp();
    linq.setCapability(TOMAS, { result: "failed", code: null, reason: "The check failed." });

    for (const to of [seedPhone(RILEY), seedPhone(TOMAS), seedPhone(BEN), SAM_EMAIL]) {
      for (const answers of answersFor(to))
        await allowedFormatsFor({ to, answers, step: EVERY_ELEMENT }, cache);
      clock.advance(CAPABILITY_CACHE_MS);
    }
    await allowedFormatsFor({ to: riley(), answers: null, step: EVERY_ELEMENT }, BROKEN);

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("gives K-03's allowedFormats: at least one, each from its closed list", async () => {
    const { cache } = setUp();
    const minItems = messagePlanV1.$defs.composeInput.properties.allowedFormats.minItems;

    const allowed = await allowedFormatsFor({ to: riley(), answers: null, step: THANKS }, cache);

    expect(allowed.formats.length).toBeGreaterThanOrEqual(minItems);
    for (const format of allowed.formats) expect(messagePlanV1.$defs.format.enum).toContain(format);
  });
});
