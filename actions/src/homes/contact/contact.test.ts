// The contact home (T-588; S13-19 with Master Corrections C2 and C9), on people T-307's reach() reads over the frozen
// K-04 and K-29 seeds, and on both flows as the merged bundle emitter compiles them. The card's proofs: an email-way
// person gets email only; a mobile with no open chat gets no text (C9); SMS is never returned (DL-012); a private
// booking's owner message carries the handling line; a business-added booking with no yes gets no message, nor one whose
// person's only yes their STOP withdrew (K-04 stopped, whatever the business-scoped texts row says); a reply clock
// starts only once reached. Then a STOP or a withdrawn yes (K-29), calls only unreachable (C-237), the default way with
// no card, the registry's S13-19 home, and a bundle the home cannot read.

import { beforeAll, describe, expect, it } from "vitest";
import { isLabel } from "../../../../runtime/src/trace";
import {
  SEND_CLASSES,
  type EmailContact,
  type Mobile,
  type Reach,
  type ReachCard,
  type SendClass,
  type TextsStanding,
} from "../../domain/messages-consent";
import { seedRecord, withRows } from "../../domain/messages-consent/test-support";
import type { RecordReading } from "../../finalize/slots/record";
import { createHomeRegistry, type HomeLogLine, type StepClaim } from "../registry";
import { moneyStandIn, objAt, type HomeContext } from "../registry/test-support";
import {
  CONTACT_POINTS,
  ContactHomeError,
  MESSAGE_WAYS,
  PRIVATE_BOOKING_LINE,
  contactHome,
  contactRule,
  contactWay,
  handlingLineFor,
  readContactRecord,
  replyClockMayStart,
  type Audience,
  type ContactDecision,
  type ContactHomeContext,
  type ContactMessage,
} from "./index";
import {
  PRIVATE_LINE_BY_EMAIL,
  S13_19_CALLS_ONLY,
  S13_19_PRIVATE_EXAMPLE,
  S13_19_RULES,
  BUSINESS,
  alexNotTextedIn,
  benStoppedWithEmail,
  benWithThread,
  bookingOf,
  cardOf,
  reachOf,
  sources,
  textsRow,
  type Sources,
} from "./test-support";

const FLOWS = ["A", "B"] as const;

let src: Sources;

// The bundle emitter compiles both master flows here. 120 s is a resource guard for a loaded build Mac
// (vitest.config.ts: a hook's own longer limit wins), not part of any test's claim.
beforeAll(async () => {
  src = await sources();
}, 120_000);

/** A message about no booking to a customer, routine unless said otherwise. */
function message(over: Partial<ContactMessage> = {}): ContactMessage {
  return { audience: "customer", sendClass: "routine", booking: null, ...over };
}

function decide(person: Reach, msg: ContactMessage, flow: "A" | "B" = "A"): ContactDecision {
  return contactWay(person, msg, src.records[flow]);
}

/** Alex's card with both his contacts (K-04 seed-person-roles: his mobile and his email). */
const alexCard = (way: ReachCard["way"]): ReachCard => cardOf(way, "handle-alex", "handle-alex-email");

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** S13-19's `more` lines in a flow graph. */
function moreOf(graph: Record<string, unknown>): string[] {
  return stringList(objAt(graph, ["steps", "S13-19"]).more);
}

describe("the compiled S13-19 holds the lines this home rules by", () => {
  it("both flows' S13-19 hold them word for word, and the record's contact home is S13-19", () => {
    for (const flow of FLOWS) {
      const lines = moreOf(src.flows[flow]);
      for (const line of [S13_19_PRIVATE_EXAMPLE, ...S13_19_CALLS_ONLY, ...S13_19_RULES])
        expect(lines, `${flow}: ${line}`).toContain(line);
      expect(objAt(src.flows[flow], ["record", "homes"]).contact).toBe("S13-19");
    }
  });

  it("the private booking line is read around the record's reach.way phrase for the email way", () => {
    for (const flow of FLOWS)
      expect(src.records[flow]).toEqual({
        flow,
        home: "S13-19",
        privateLine: {
          before: "Private booking: reach them only ",
          after: ", at the times they named. Never say why.",
        },
      });
  });
});

describe("an email-way person gets email only (S13-19: 'Email: everything goes by email')", () => {
  it("Alex, whose chat is open (K-04 seed), with the email way: every class goes to his email alone", async () => {
    const alex = await reachOf("person-alex", { card: alexCard("email") });
    expect(alex.mobiles).toMatchObject([{ handleId: "handle-alex", chatOpen: true, stopped: false }]);
    for (const sendClass of SEND_CLASSES)
      for (const via of [null, "handle-alex", "handle-alex-email"]) {
        const decision = decide(alex, message({ sendClass, via }));
        expect(decision, `${sendClass} ${String(via)}`).toEqual({
          way: "email",
          text: null,
          email: "handle-alex-email",
          held: [],
          replyClock: "onceReached",
          handling: null,
        });
      }
  });

  it("the email way with no email on file goes nowhere; the texts way texts his open chat with an email copy", async () => {
    const noEmail = await reachOf("person-alex", { card: cardOf("email", "handle-alex", null) });
    expect(decide(noEmail, message())).toEqual({
      way: "none",
      text: null,
      email: null,
      held: [{ medium: "email", handleId: null, why: "noEmail" }],
      replyClock: "never",
      handling: null,
    });
    for (const way of ["texts", "textsonly"] as const) {
      const alex = await reachOf("person-alex", { card: alexCard(way) });
      expect(decide(alex, message()), way).toMatchObject({
        way: "text",
        text: "handle-alex",
        email: "handle-alex-email",
        held: [],
      });
    }
  });
});

describe("a mobile with no open chat gets no text (MC C9: Rosie never writes first)", () => {
  it("Pat's phone never texted Rosie (K-29 seed-chat-link): nothing goes, whatever the class", async () => {
    const pat = await reachOf("person-pat", { card: cardOf("texts", "handle-pat", null) });
    expect(pat.mobiles).toMatchObject([{ handleId: "handle-pat", chatOpen: false, chatThreadId: null }]);
    for (const sendClass of SEND_CLASSES)
      expect(decide(pat, message({ sendClass })), sendClass).toEqual({
        way: "none",
        text: null,
        email: null,
        held: [{ medium: "text", handleId: "handle-pat", why: "chatNotOpen" }],
        replyClock: "never",
        handling: null,
      });
  });

  it("Alex's mobile before its first text: no text, and his email carries the message (MC C2)", async () => {
    const record = alexNotTextedIn();
    const alex = await reachOf("person-alex", { card: alexCard("texts"), record });
    expect(alex.mobiles).toMatchObject([{ handleId: "handle-alex", chatOpen: false, chatThreadId: null }]);
    for (const sendClass of SEND_CLASSES)
      expect(decide(alex, message({ sendClass })), sendClass).toEqual({
        way: "email",
        text: null,
        email: "handle-alex-email",
        held: [{ medium: "text", handleId: "handle-alex", why: "chatNotOpen" }],
        replyClock: "onceReached",
        handling: null,
      });
    const noCard = await reachOf("person-alex", { record });
    expect(decide(noCard, message({ via: "handle-alex" }))).toMatchObject({
      way: "none",
      text: null,
      held: [{ medium: "text", handleId: "handle-alex", why: "chatNotOpen" }],
    });
  });
});

describe("SMS is never returned (DL-012): no answer names a channel, and a text goes only into a chat they opened", () => {
  it("Tomás's chat is RCS (K-04 seed): the way is a text into that chat, and no channel is named", async () => {
    const tomas = await reachOf("person-tomas", { card: cardOf("texts", "handle-tomas", null) });
    expect(tomas.mobiles).toMatchObject([{ handleId: "handle-tomas", chatWay: "rcs" }]);
    const decision = decide(tomas, message());
    expect(decision).toEqual({
      way: "text",
      text: "handle-tomas",
      email: null,
      held: [],
      replyClock: "onceReached",
      handling: null,
    });
  });

  it("over every state of a mobile, its chat's service, each contact's consent, the card, the class and the booking", () => {
    const states = [
      { chatOpen: true, stopped: false, thread: true },
      { chatOpen: false, stopped: false, thread: false },
      { chatOpen: false, stopped: false, thread: true },
      { chatOpen: false, stopped: true, thread: true },
      { chatOpen: false, stopped: true, thread: false },
    ];
    const chatWays: Mobile["chatWay"][] = ["imessage", "rcs", "sms", null];
    const standings: (TextsStanding | null)[] = [
      null,
      { consentId: "consent-alex-yes", revoked: false },
      { consentId: "consent-alex-withdrawn", revoked: true },
    ];
    const emailCases: (EmailContact | null)[] = [
      null,
      ...standings.map((texts) => ({ handleId: "handle-alex-email", texts })),
    ];
    const cards: (ReachCard | null)[] = [
      null,
      alexCard("texts"),
      alexCard("textsonly"),
      alexCard("email"),
      cardOf(null, null, null),
    ];
    const bookings: (RecordReading | null)[] = [
      null,
      bookingOf(src, "A", { privacy: "private", reach: "texts" }),
      bookingOf(src, "A", { madeby: "shop" }),
    ];
    const classes: SendClass[] = ["routine", "safety"];
    const audiences: Audience[] = ["customer", "owner"];
    const keys = ["email", "handling", "held", "replyClock", "text", "way"];
    const problems: string[] = [];
    let count = 0;
    // The cases where a stopped mobile's texts row still shows a yes, as the business scope reads it (its STOP's row has
    // no business), and nothing else holds one: a booking the shop made gets nothing there (default 2).
    let stoppedYesHeld = 0;
    for (const state of states)
      for (const chatWay of chatWays)
        for (const texts of standings)
          for (const email of emailCases)
            for (const card of cards) {
              const mobile: Mobile = {
                handleId: "handle-alex",
                chatOpen: state.chatOpen,
                chatWay,
                stopped: state.stopped,
                chatThreadId: state.thread ? "thread-alex-chat" : null,
                texts,
              };
              const person: Reach = {
                personId: "person-alex",
                language: "en",
                card,
                mobiles: [mobile],
                emails: email === null ? [] : [email],
              };
              // A stopped mobile holds no yes, whatever its texts row says: its stopped flag tells the STOP (default 2).
              const yes = (!state.stopped && texts?.revoked === false) || email?.texts?.revoked === false;
              for (const sendClass of classes)
                for (const stopReply of [false, true])
                  for (const via of [null, "handle-alex"])
                    for (const audience of audiences)
                      for (const booking of bookings) {
                        count += 1;
                        const msg: ContactMessage = { audience, sendClass, stopReply, via, booking };
                        const decision = contactWay(person, msg, src.records.A);
                        const fail = (what: string): void => {
                          const at = {
                            state,
                            chatWay,
                            texts,
                            email,
                            card,
                            msg: { ...msg, booking: bookings.indexOf(booking) },
                          };
                          problems.push(`${what}: ${JSON.stringify(at)}`);
                        };
                        const pastStop = sendClass === "safety" || stopReply;
                        if (!(MESSAGE_WAYS as readonly string[]).includes(decision.way)) fail("way");
                        if (JSON.stringify(decision).includes("sms")) fail("sms");
                        if (JSON.stringify(Object.keys(decision).sort()) !== JSON.stringify(keys))
                          fail("keys");
                        if (decision.replyClock !== (decision.way === "none" ? "never" : "onceReached"))
                          fail("clock");
                        const bound = state.stopped || texts?.revoked === true;
                        const mayText = bound ? pastStop && state.thread : state.chatOpen;
                        if (decision.text !== null && !mayText) fail("text past C9 or a stop");
                        if (card?.way === "email" && !stopReply && decision.text !== null)
                          fail("text on the email way");
                        if (decision.email !== null && email?.texts?.revoked === true)
                          fail("email past a withdrawn yes");
                        const shop = audience === "customer" && booking === bookings[2];
                        if (shop && !pastStop && !yes && decision.way !== "none") fail("no yes");
                        if (shop && !pastStop && !yes && state.stopped && texts?.revoked === false)
                          stoppedYesHeld += 1;
                      }
            }
    expect(problems.slice(0, 5)).toEqual([]);
    expect(count).toBe(57_600);
    // 2 stopped states x 4 chat services x 3 emails holding no yes x 5 cards x 2 vias.
    expect(stoppedYesHeld).toBe(240);
  });
});

describe("a private booking's owner message carries the handling line (S13-19)", () => {
  it("Sam's message about a private booking of someone reached by email carries S13-19's line, in both flows", async () => {
    const sam = await reachOf("person-sam");
    for (const flow of FLOWS) {
      const booking = bookingOf(src, flow, { privacy: "private", reach: "email" });
      const decision = decide(sam, message({ audience: "owner", via: "handle-sam", booking }), flow);
      expect(decision, flow).toEqual({
        way: "text",
        text: "handle-sam",
        email: null,
        held: [],
        replyClock: "onceReached",
        handling: { line: PRIVATE_BOOKING_LINE, text: PRIVATE_LINE_BY_EMAIL },
      });
      expect(S13_19_PRIVATE_EXAMPLE).toBe(`Like this: '${decision.handling?.text ?? ""}'`);
    }
  });

  it("a staff message carries it too, with the person served's way as the record's reach.way phrase", async () => {
    const riley = await reachOf("person-riley");
    const lines = {
      texts: "Private booking: reach them only by text, at the times they named. Never say why.",
      textsonly: "Private booking: reach them only by text only, at the times they named. Never say why.",
      email: PRIVATE_LINE_BY_EMAIL,
    };
    for (const flow of FLOWS)
      for (const [reach, text] of Object.entries(lines)) {
        const booking = bookingOf(src, flow, { privacy: "private", reach: reach as keyof typeof lines });
        const decision = decide(riley, message({ audience: "staff", via: "handle-riley", booking }), flow);
        expect(decision.handling, `${flow} ${reach}`).toEqual({ line: PRIVATE_BOOKING_LINE, text });
        // S13-19's calls-only additions ("On a call: ...", "... No voicemail.") are never part of it (C-237).
        expect(text).not.toMatch(/call|voicemail/i);
      }
  });

  it("no line on the customer's own message, on an open booking, or on a message about no booking", async () => {
    const sam = await reachOf("person-sam");
    const alex = await reachOf("person-alex", { card: alexCard("texts") });
    const privateBooking = bookingOf(src, "A", { privacy: "private", reach: "email" });
    expect(decide(alex, message({ booking: privateBooking })).handling).toBeNull();
    const open = bookingOf(src, "A", { privacy: "open", reach: "email" });
    expect(decide(sam, message({ audience: "owner", via: "handle-sam", booking: open })).handling).toBeNull();
    expect(decide(sam, message({ audience: "owner", via: "handle-sam" })).handling).toBeNull();
  });
});

describe("a business-added booking with no yes to messages gets no message (S13-19; A3-30)", () => {
  it("Alex, who gave this business no yes (K-29 seeds), gets nothing about it, whatever his card says", async () => {
    const booking = bookingOf(src, "A", { madeby: "shop" });
    for (const way of ["texts", "textsonly", "email"] as const) {
      const alex = await reachOf("person-alex", { card: alexCard(way) });
      expect(alex.mobiles[0]?.texts ?? null).toBeNull();
      for (const sendClass of ["routine", "quick_reply", "visit_now"] as const)
        expect(decide(alex, message({ sendClass, booking })), `${way} ${sendClass}`).toEqual({
          way: "none",
          text: null,
          email: null,
          held: [{ medium: null, handleId: null, why: "noYes" }],
          replyClock: "never",
          handling: null,
        });
    }
  });

  it("his later yes (a K-29 texts row) lets messages go his way; a withdrawn yes stops them again", async () => {
    const booking = bookingOf(src, "A", { madeby: "shop" });
    const yes = withRows(seedRecord(), {
      consents: [textsRow("consent-alex-yes", "person-alex", "handle-alex", false, "2026-10-24T09:00:00Z")],
    });
    const alex = await reachOf("person-alex", { card: alexCard("texts"), record: yes });
    expect(decide(alex, message({ booking }))).toMatchObject({ way: "text", text: "handle-alex" });
    const withdrawn = withRows(yes, {
      consents: [
        textsRow("consent-alex-withdrawn", "person-alex", "handle-alex", true, "2026-10-25T09:00:00Z"),
      ],
    });
    const again = await reachOf("person-alex", { card: alexCard("texts"), record: withdrawn });
    expect(decide(again, message({ booking }))).toMatchObject({ way: "none", held: [{ why: "noYes" }] });
  });

  it("Ben's STOP withdrew his only yes: a booking the shop made gets nothing, though his email is on his card", async () => {
    const record = benStoppedWithEmail();
    // His yes at this business (K-29 seed-chat-link, Oct 5) and his STOP for every business (seed-consent-stop-row, Oct
    // 20): the newest row decides (K-29 README), so he holds no yes to messages.
    const rows = record.consents
      .filter((row) => row.personId === "person-ben")
      .map(({ id, businessId, revoked, at }) => ({ id, businessId, revoked, at: at.toISOString() }));
    expect(rows).toEqual([
      { id: "consent-ben-texts-yes", businessId: BUSINESS, revoked: false, at: "2026-10-05T17:00:00.000Z" },
      { id: "consent-ben-stop", businessId: null, revoked: true, at: "2026-10-20T13:00:00.000Z" },
    ]);
    for (const way of ["texts", "textsonly", "email"] as const) {
      const ben = await reachOf("person-ben", {
        card: cardOf(way, "handle-ben", "handle-ben-email"),
        record,
      });
      // The business scope never reads the STOP's row (it has no business), so his mobile's texts row still shows
      // the yes the STOP withdrew; K-04's stopped flag is what tells the STOP (T-307 Mobile.texts).
      expect(ben.mobiles).toEqual([
        {
          handleId: "handle-ben",
          chatOpen: false,
          chatWay: "imessage",
          stopped: true,
          chatThreadId: "thread-ben-chat",
          texts: { consentId: "consent-ben-texts-yes", revoked: false },
        },
      ]);
      expect(ben.emails).toEqual([{ handleId: "handle-ben-email", texts: null }]);
      for (const flow of FLOWS) {
        const booking = bookingOf(src, flow, { madeby: "shop" });
        for (const sendClass of SEND_CLASSES.filter((each) => each !== "safety")) {
          const decision = decide(ben, message({ sendClass, booking }), flow);
          expect(decision, `${way} ${flow} ${sendClass}`).toEqual({
            way: "none",
            text: null,
            email: null,
            held: [{ medium: null, handleId: null, why: "noYes" }],
            replyClock: "never",
            handling: null,
          });
          for (const handleId of ["handle-ben", "handle-ben-email"])
            expect(replyClockMayStart(decision, { handleId }), `${way} ${flow} ${sendClass}`).toBe(false);
        }
      }
    }
    // A safety line and his stop's one reply keep their exemption (default 2), into the chat his phone once opened.
    const ben = await reachOf("person-ben", {
      card: cardOf("texts", "handle-ben", "handle-ben-email"),
      record,
    });
    const booking = bookingOf(src, "A", { madeby: "shop" });
    expect(decide(ben, message({ sendClass: "safety", booking }))).toMatchObject({
      way: "text",
      text: "handle-ben",
    });
    expect(decide(ben, message({ stopReply: true, via: "handle-ben", booking }))).toEqual({
      way: "text",
      text: "handle-ben",
      email: null,
      held: [],
      replyClock: "onceReached",
      handling: null,
    });
  });

  it("the owner still hears about it; a safety line and the stop's one reply still go (default 2)", async () => {
    const booking = bookingOf(src, "A", { madeby: "shop" });
    const sam = await reachOf("person-sam");
    expect(decide(sam, message({ audience: "owner", via: "handle-sam", booking })).way).toBe("text");
    const alex = await reachOf("person-alex", { card: alexCard("texts") });
    expect(decide(alex, message({ sendClass: "safety", booking })).way).toBe("text");
    expect(decide(alex, message({ stopReply: true, via: "handle-alex", booking }))).toMatchObject({
      way: "text",
      text: "handle-alex",
      email: null,
    });
  });
});

describe("a reply clock starts only once they were reached their way (S13-19)", () => {
  it("the text way: only a delivery in his open chat starts it, never the email copy's alone (default 3)", async () => {
    const alex = await reachOf("person-alex", { card: alexCard("texts") });
    const decision = decide(alex, message());
    expect(decision.replyClock).toBe("onceReached");
    expect(replyClockMayStart(decision, { handleId: "handle-alex" })).toBe(true);
    expect(replyClockMayStart(decision, { handleId: "handle-alex-email" })).toBe(false);
    expect(replyClockMayStart(decision, null)).toBe(false);
  });

  it("the email way: only a delivery to his address starts it", async () => {
    const alex = await reachOf("person-alex", { card: alexCard("email") });
    const decision = decide(alex, message());
    expect(replyClockMayStart(decision, { handleId: "handle-alex-email" })).toBe(true);
    expect(replyClockMayStart(decision, { handleId: "handle-alex" })).toBe(false);
  });

  it("a message that reaches nobody starts no clock, whatever is reported", async () => {
    const pat = await reachOf("person-pat", { card: cardOf("texts", "handle-pat", null) });
    const decision = decide(pat, message());
    expect(decision.replyClock).toBe("never");
    for (const handleId of ["handle-pat", "handle-alex", "handle-alex-email"])
      expect(replyClockMayStart(decision, { handleId })).toBe(false);
  });
});

describe("a STOP or a withdrawn yes binds its contact, whatever the way (K-29; K-04 phones.stopped; MC C1)", () => {
  it("Ben's stopped phone (K-04 seed): no routine text; a safety line and his stop's one reply only into his chat", async () => {
    const card = cardOf("texts", "handle-ben", null);
    const ben = await reachOf("person-ben", { card, record: benWithThread() });
    expect(ben.mobiles).toMatchObject([{ handleId: "handle-ben", stopped: true, chatOpen: false }]);
    for (const sendClass of ["routine", "quick_reply", "visit_now"] as const)
      expect(decide(ben, message({ sendClass })), sendClass).toMatchObject({
        way: "none",
        held: [{ medium: "text", handleId: "handle-ben", why: "stopped" }],
        replyClock: "never",
      });
    expect(decide(ben, message({ sendClass: "safety" }))).toMatchObject({ way: "text", text: "handle-ben" });
    expect(decide(ben, message({ stopReply: true, via: "handle-ben" }))).toMatchObject({
      way: "text",
      text: "handle-ben",
      email: null,
    });
    // K-04's seeds hold no chat thread for him: a stopped phone that never opened its chat gets nothing at all.
    const never = await reachOf("person-ben", { card });
    expect(decide(never, message({ sendClass: "safety" }))).toMatchObject({ way: "none" });
  });

  it("after Ben's STOP, his email still carries every message their way (RULES 7.5: 'Reach them their way')", async () => {
    const record = withRows(benWithThread(), {
      handles: [{ id: "handle-ben-email", kind: "email", address: "ben@example.com" }],
      personHandles: [{ personId: "person-ben", handleId: "handle-ben-email" }],
    });
    const ben = await reachOf("person-ben", {
      card: cardOf("texts", "handle-ben", "handle-ben-email"),
      record,
    });
    expect(decide(ben, message())).toEqual({
      way: "email",
      text: null,
      email: "handle-ben-email",
      held: [{ medium: "text", handleId: "handle-ben", why: "stopped" }],
      replyClock: "onceReached",
      handling: null,
    });
  });

  it("a withdrawn texts row on Alex's mobile holds his texts but not a safety line; on his email, holds everything", async () => {
    const mobileWithdrawn = withRows(seedRecord(), {
      consents: [textsRow("consent-alex-moved", "person-alex", "handle-alex", true, "2026-10-24T09:00:00Z")],
    });
    const alex = await reachOf("person-alex", { card: alexCard("texts"), record: mobileWithdrawn });
    expect(decide(alex, message())).toMatchObject({
      way: "email",
      text: null,
      email: "handle-alex-email",
      held: [{ medium: "text", handleId: "handle-alex", why: "revoked" }],
    });
    expect(decide(alex, message({ sendClass: "safety" }))).toMatchObject({
      way: "text",
      text: "handle-alex",
    });

    const emailWithdrawn = withRows(seedRecord(), {
      consents: [
        textsRow("consent-alex-email-stop", "person-alex", "handle-alex-email", true, "2026-10-24T09:00:00Z"),
      ],
    });
    const byEmail = await reachOf("person-alex", { card: alexCard("email"), record: emailWithdrawn });
    for (const sendClass of SEND_CLASSES)
      expect(decide(byEmail, message({ sendClass })), sendClass).toEqual({
        way: "none",
        text: null,
        email: null,
        held: [{ medium: "email", handleId: "handle-alex-email", why: "revoked" }],
        replyClock: "never",
        handling: null,
      });
  });
});

describe("calls only is unreachable (MC C2; Q-07; C-237), and no line-type lookup decides anything (N-4)", () => {
  it("a card or a booking that says calls only is refused, never answered with a call or S13-19's call lines", async () => {
    const alex = await reachOf("person-alex");
    const callsOnly = { ...alex, card: { ...alexCard("texts"), way: "callsonly" } } as unknown as Reach;
    for (const audience of ["customer", "owner", "staff"] as const)
      expect(() => decide(callsOnly, message({ audience, via: "handle-alex" }))).toThrow(ContactHomeError);
    const booking = bookingOf(src, "A", { privacy: "private", reach: "callsonly" });
    const sam = await reachOf("person-sam");
    expect(() => decide(sam, message({ audience: "owner", via: "handle-sam", booking }))).toThrow(
      "calls only is never offered",
    );
    expect(() => decide(alex, message({ via: "handle-alex", booking }))).toThrow(ContactHomeError);
    expect(() => handlingLineFor(src.records.A, booking)).toThrow(ContactHomeError);
  });

  it("the way is read from the card and K-04's flags alone: the answer is made at once, with no lookup", async () => {
    const alex = await reachOf("person-alex", { card: alexCard("texts") });
    const decision: unknown = contactWay(alex, message(), src.records.A);
    expect(decision).not.toBeInstanceOf(Promise);
  });
});

describe("with no reach card, the channel they're using (S13-19 'Default'; T-307 default 1)", () => {
  it("back on the handle Alex writes from; nowhere with none, or on a handle that is not his", async () => {
    const alex = await reachOf("person-alex");
    expect(alex.card).toBeNull();
    expect(decide(alex, message({ via: "handle-alex" }))).toMatchObject({
      way: "text",
      text: "handle-alex",
      email: null,
    });
    expect(decide(alex, message({ via: "handle-alex-email" }))).toMatchObject({
      way: "email",
      text: null,
      email: "handle-alex-email",
    });
    expect(decide(alex, message())).toMatchObject({ way: "none", held: [{ why: "noContact" }] });
    expect(decide(alex, message({ via: "handle-sam" }))).toMatchObject({
      way: "none",
      held: [{ handleId: "handle-sam", why: "notTheirs" }],
    });
  });

  it("a card with no way goes nowhere; a card's contact that is not theirs carries nothing", async () => {
    const none = await reachOf("person-alex", { card: cardOf(null, null, null) });
    expect(decide(none, message({ via: "handle-alex" }))).toMatchObject({
      way: "none",
      held: [{ why: "noContact" }],
    });
    const other = await reachOf("person-alex", { card: cardOf("texts", "handle-sam", "handle-alex-email") });
    expect(decide(other, message())).toMatchObject({
      way: "email",
      text: null,
      email: "handle-alex-email",
      held: [{ medium: "text", handleId: "handle-sam", why: "notTheirs" }],
    });
  });

  it("a message the home cannot read is refused, naming no value", async () => {
    const alex = await reachOf("person-alex");
    const bad = [
      { ...message(), audience: "payer" },
      { ...message(), sendClass: "marketing" },
      { ...message(), via: "" },
      { ...message(), booking: { ...bookingOf(src, "A", {}), booking: { reach: "fax" } } },
    ] as unknown as ContactMessage[];
    for (const each of bad) expect(() => decide(alex, each)).toThrow(ContactHomeError);
  });
});

describe("the contact home registers with the home registry as the S13-19 home", () => {
  type Context = HomeContext & ContactHomeContext;

  function registryOn(): { lines: HomeLogLine[]; registry: ReturnType<typeof createHomeRegistry<Context>> } {
    const lines: HomeLogLine[] = [];
    const registry = createHomeRegistry<Context>({
      flows: src.flows,
      modules: [moneyStandIn(), contactHome()],
      log: (line) => {
        lines.push(line);
      },
    });
    return { lines, registry };
  }

  it("its entry is S13-19's, built, in actions/src/homes/contact (T-588)", () => {
    const registry = createHomeRegistry<ContactHomeContext>({ flows: src.flows, modules: [contactHome()] });
    expect(registry.entry("contact")).toEqual({
      home: "contact",
      step: "S13-19",
      layer: "actions",
      module: "actions/src/homes/contact",
      task: "T-588",
      via: "homeModule",
      built: true,
    });
    expect(contactHome().points).toEqual(CONTACT_POINTS);
  });

  it("A7-11 runs on the contact home's rulings: a step that says it texts a closed chat gets the home's email", async () => {
    const { lines, registry } = registryOn();
    const alex = await reachOf("person-alex", { card: alexCard("texts"), record: alexNotTextedIn() });
    const claims: StepClaim[] = [{ home: "contact", point: "reachWay", value: "text" }];
    const context: Context = {
      signedSchedule: false,
      contact: { person: alex, message: message(), record: src.records.A },
    };
    expect(registry.settle({ flow: "A", step: "A7-11", claims, context })).toEqual({
      run: true,
      flow: "A",
      step: "A7-11",
      rulings: {
        chargeOnSilence: "none",
        reachWay: "email",
        replyClock: "onceReached",
        handlingLine: "none",
      },
      differences: [
        {
          flow: "A",
          step: "A7-11",
          home: "contact",
          homeStep: "S13-19",
          point: "reachWay",
          stepSaid: "text",
          homeSaid: "email",
        },
      ],
      own: [],
    });
    expect(lines).toHaveLength(1);
    for (const value of Object.values(lines[0] ?? {})) expect(isLabel(value), String(value)).toBe(true);
  });

  it("a business-added booking with no yes rules none and never; a private booking's owner message its line", async () => {
    const { registry } = registryOn();
    const alex = await reachOf("person-alex", { card: alexCard("texts") });
    const shop: Context = {
      signedSchedule: false,
      contact: {
        person: alex,
        message: message({ booking: bookingOf(src, "A", { madeby: "shop" }) }),
        record: src.records.A,
      },
    };
    expect(registry.settle({ flow: "A", step: "A7-11", claims: [], context: shop })).toMatchObject({
      rulings: { reachWay: "none", replyClock: "never", handlingLine: "none" },
    });
    const sam = await reachOf("person-sam");
    const owner: ContactMessage = {
      audience: "owner",
      sendClass: "routine",
      via: "handle-sam",
      booking: bookingOf(src, "A", { privacy: "private", reach: "email" }),
    };
    const privateBooking: Context = {
      signedSchedule: false,
      contact: { person: sam, message: owner, record: src.records.A },
    };
    expect(registry.settle({ flow: "A", step: "A7-11", claims: [], context: privateBooking })).toMatchObject({
      rulings: { reachWay: "text", replyClock: "onceReached", handlingLine: PRIVATE_BOOKING_LINE },
    });
  });

  it("its rule refuses a point that is not its own and a context with no contact reading", async () => {
    const alex = await reachOf("person-alex", { card: alexCard("texts") });
    const context: ContactHomeContext = {
      contact: { person: alex, message: message(), record: src.records.A },
    };
    expect(() => contactRule("chargeOnSilence", context)).toThrow(ContactHomeError);
    expect(() => contactRule("reachWay", {} as ContactHomeContext)).toThrow("no contact reading");
  });
});

describe("a bundle the contact home cannot read fails closed", () => {
  it("S13-19 without its example line, or with one that does not hold the email way's phrase", () => {
    const without = structuredClone(src.flows.A);
    objAt(without, ["steps", "S13-19"]).more = moreOf(without).filter(
      (line) => line !== S13_19_PRIVATE_EXAMPLE,
    );
    expect(() => readContactRecord("A", without)).toThrow("step S13-19 does not give one example line");

    const reworded = structuredClone(src.flows.A);
    objAt(reworded, ["steps", "S13-19"]).more = moreOf(reworded).map((line) =>
      line === S13_19_PRIVATE_EXAMPLE ? line.replace("by email", "on file") : line,
    );
    expect(() => readContactRecord("A", reworded)).toThrow("phrase exactly once");
  });

  it("an example that is not one of the record's contact lines, or reach.way rows that read more than the booking", () => {
    const notContact = structuredClone(src.flows.B);
    objAt(notContact, ["record", "lint", "phrases"]).contact = ["^Calls only:"];
    expect(() => readContactRecord("B", notContact)).toThrow("not one of the record's contact lines");

    const rows = structuredClone(src.flows.B);
    const slot = objAt(rows, ["record", "slots", "reach.way"]);
    slot.rows = [{ when: { price: ["list"] }, text: "by text" }, { text: "by email" }];
    expect(() => readContactRecord("B", rows)).toThrow("reads more than the booking's values");
  });

  it("a flow with no contact home step, or that is not a flow graph", () => {
    const noHome = structuredClone(src.flows.A);
    delete objAt(noHome, ["record", "homes"]).contact;
    expect(() => readContactRecord("A", noHome)).toThrow("has no contact home step");
    expect(() => readContactRecord("A", null)).toThrow(ContactHomeError);
  });
});
