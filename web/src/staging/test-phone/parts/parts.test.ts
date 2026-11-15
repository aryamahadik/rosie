// T-524's proofs for the test-phone page's thread view (C-205; build prompt 9.4 "The test-phone page"; K-21 v1
// test-phone-parts.json; K-11 v1's send fixtures; T-513's chat-link component): test-phone-parts.json renders every part
// in order with its kind (a text, a poll with its options, a link card, a calendar file, a photo, typing dots, a
// tapback and a threaded reply, each from K-11 v1's frozen send fixture of that kind); the email double's output shows
// beside the texts; the phone's stop state shows as the response gives it; the chat link shows through the chat-link
// component. Beside them: the links for the user's own try (check again, send as this phone, choose another phone, and
// the send page's link here after a send), the tester login the view sits behind, the page of each other answer K-21 v1
// gives, every value escaped, and what no page of the view holds. staging-only.test.ts holds the proof that the view
// is absent in production (T-522).
//
// The view runs on the shell over the Tool API mock, which answers a frozen fixture's request alone and fails the test
// on any other (C-186), or over answers typed by K-21 v1 where no frozen fixture shows the case. Every value is made up
// or a fixture's own placeholder (rule 9). The one phone number written here is Rosie's line as the K-09 and K-21
// fixtures give it, a fiction-range placeholder (Q-51), whole; the test phones' own numbers are read from the fixtures,
// only to check that no page shows them.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cookieNames } from "../../../auth/cookies";
import { startHref } from "../../../auth/pages";
import { hiddenFields } from "../../../auth/test-support";
import type { OutcomeOf, RequestOf } from "../../../client/calls";
import { renderChatLink } from "../../../components/chat-link/chat-link";
import {
  anchorsOf,
  decodeSvg,
  onlyOne,
  svgsOf,
  visibleText,
} from "../../../components/chat-link/test-support";
import { readWebConfig } from "../../../shell/config";
import { REFERENCE_LABEL } from "../../../shell/error-pages";
import { escapeHtml } from "../../../shell/frame";
import { contentSecurityPolicy } from "../../../shell/serve";
import { TRACE_ID, testVars } from "../../../shell/test-support";
import { REFUSED_STATUS, REFUSED_WORDS } from "../../guard";
import { WORDS as PICKER_WORDS, pickerHref } from "../picker/page";
import { WORDS as SEND_WORDS, testPhoneHref } from "../send/page";
import { SENT, sendFormOf, sendPost, typedInto } from "../send/test-support";
import { CALENDAR_WORDS, FAILED_WORDS, KIND_WORDS, WORDS, partsHref, type RecordedPart } from "./page";
import {
  EVERY_KIND,
  PARTS,
  RECORDED,
  mockPartsShell,
  open,
  recordedOf,
  rowsAfter,
  sectionAfter,
  sessionOf,
  stubPartsShell,
} from "./test-support";

/** The fixture's page envelope: its request id, trace id and session token. */
const PAGE = PARTS.request.page;
/** The fixture's test phone: the first customer's, tp-03. */
const PHONE = PARTS.request.testPhoneId;
/** Rosie's line as the K-09 and K-21 fixtures give it: a fiction-range placeholder (Q-51), whole. */
const ROSIES_LINE = "+15555550188";

/** A part's line under its kind: Rosie sent it, when, and by which service. */
const fromRosie = (at: string, shown: string): string =>
  `<p>${WORDS.fromRosie}, <time datetime="${at}">${shown}</time>, ${WORDS.by} iMessage.</p>`;

/** What the view shows for test-phone-parts.json's two parts, in the answer's order, written out. */
const FIXTURE_ROWS = [
  [
    "<h3>Text</h3>",
    fromRosie("2026-10-23T14:05:03Z", "2026-10-23 14:05:03 UTC"),
    "<blockquote><p>Sure. Pick a new time for your haircut at Lee&#39;s Barbershop with Riley.<br>Which time works?</p></blockquote>",
    `<p>${WORDS.takenAs} <code>linq-msg-demo-0001</code>.</p>`,
  ].join("\n"),
  [
    "<h3>Poll</h3>",
    fromRosie("2026-10-23T14:05:05Z", "2026-10-23 14:05:05 UTC"),
    `<p>${WORDS.pollOptions}</p>`,
    "<ol>",
    "<li>Sat 12:00pm</li>",
    "<li>Sat 2:00pm</li>",
    "<li>Sat 3:30pm</li>",
    "</ol>",
    `<p>${WORDS.takenAs} <code>linq-msg-demo-0002</code>.</p>`,
  ].join("\n"),
];

/** Each kind's heading, in the order T-524's card lists the kinds, written out. */
const KIND_HEADINGS = [
  "<h3>Text</h3>",
  "<h3>Poll</h3>",
  "<h3>Link card</h3>",
  "<h3>Text with a calendar file</h3>",
  "<h3>Photo</h3>",
  "<h3>Typing dots</h3>",
  "<h3>Tapback</h3>",
  "<h3>Threaded reply</h3>",
];

/** K-11 v1's send fixtures, one of each kind, as the Linq double records them, in the card's order. */
const ALL_KINDS: readonly RecordedPart[] = EVERY_KIND.map(({ file }) => recordedOf(file));

/** The first line of a row: its kind's heading. */
const headingOf = (row: string): string | undefined => row.split("\n")[0];

/** The view as a signed-in tester opens it for tp-03 over the Tool API mock: test-phone-parts.json's request and answer. */
async function openFixture(): Promise<
  ReturnType<typeof mockPartsShell> & { response: Response; html: string }
> {
  const made = mockPartsShell({ traceId: PAGE.traceId, requestIds: [PAGE.requestId] });
  const response = await made.shell.fetch(open(partsHref(made.config, PHONE), sessionOf(made.config)));
  return { ...made, response, html: await response.text() };
}

/** The view as a signed-in tester opens it for tp-03 over `answer`, a K-21 v1 outcome no frozen fixture shows. */
async function openWith(
  answer: OutcomeOf<"testPhoneParts">,
): Promise<ReturnType<typeof stubPartsShell> & { response: Response; html: string }> {
  const made = stubPartsShell({ testPhoneParts: answer });
  const response = await made.shell.fetch(open(partsHref(made.config, PHONE), sessionOf(made.config)));
  return { ...made, response, html: await response.text() };
}

describe("test-phone-parts.json renders every part in order with its kind (text, poll with its options, link card, calendar file, photo, typing dots, tapback, threaded reply)", () => {
  it("opening the view for tp-03 sends test-phone-parts.json's request, a read of all the doubles keep under the page request's trace id, and answers 200", async () => {
    const { response, transport, lines } = await openFixture();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-trace-id")).toBe(PAGE.traceId);
    expect(transport.sent).toEqual([
      { call: "testPhoneParts", request: PARTS.request, traceId: PAGE.traceId },
    ]);
    expect(PARTS.request.since).toBeNull();
    expect(lines()).toEqual([
      { level: "info", msg: "page", trace_id: PAGE.traceId, route: "testPhone.parts", status: 200 },
    ]);
  });

  it("its two parts show in its order, the newest last: the words with the question, then the poll with its three options word for word", async () => {
    const { html } = await openFixture();
    expect(html).toContain(`<h1>${escapeHtml(WORDS.title)}</h1>`);
    expect(html).toContain(`<p>${WORDS.testPhone} <code>tp-03</code>, ${WORDS.ending} 0101.</p>`);
    expect(rowsAfter(html, WORDS.partsHeading)).toEqual(FIXTURE_ROWS);
    // The answer's order is the order the parts were sent, so the newest is last.
    const sentAt = RECORDED.parts.map((part) => part.at);
    expect([...sentAt].sort()).toEqual(sentAt);
  });

  it("K-11 v1's send fixtures, one of each kind, show in the answer's order, each with its kind in plain words, marked as Rosie's, with what it carried", async () => {
    expect(EVERY_KIND.map(({ kind }) => `<h3>${KIND_WORDS[kind]}</h3>`)).toEqual(KIND_HEADINGS);
    const { response, html } = await openWith({ ...RECORDED, parts: [...ALL_KINDS] });
    expect(response.status).toBe(200);
    const rows = rowsAfter(html, WORDS.partsHeading);
    expect(rows.map(headingOf)).toEqual(KIND_HEADINGS);
    for (const [at, row] of rows.entries())
      expect(row.split("\n")[1], KIND_HEADINGS[at]).toMatch(
        new RegExp(
          `^<p>${WORDS.fromRosie}, <time datetime="[^"]+">[^<]+</time>, ${WORDS.by} iMessage\\.</p>$`,
        ),
      );
    const [text, poll, linkCard, calendar, photo, typing, tapback, reply] = rows;

    // A text: its words, line by line, and the message the double took it as.
    expect(text).toContain(
      "<blockquote><p>Sure. Pick a new time for your haircut at Lee&#39;s Barbershop with Riley.<br>Which time works?</p></blockquote>",
    );
    expect(text).toContain(`<p>${WORDS.takenAs} <code>linq-msg-demo-0001</code>.</p>`);
    // A poll with its options, word for word, in their order.
    expect(poll).toContain(
      [
        `<p>${WORDS.pollOptions}</p>`,
        "<ol>",
        "<li>Sat 12:00pm</li>",
        "<li>Sat 2:00pm</li>",
        "<li>Sat 3:30pm</li>",
        "</ol>",
      ].join("\n"),
    );
    // A link card: the whole message, its https link, which opens as the phone's would.
    expect(linkCard).toContain(
      '<p><a href="https://rosie.example.com/b/booking-alex-haircut">https://rosie.example.com/b/booking-alex-haircut</a></p>',
    );
    // A calendar file: the words it rides with, its name, what it does, and its text.
    const file = ALL_KINDS[3]?.sent.calendarFile;
    if (file === null || file === undefined)
      throw new Error("send-calendar-file.json carries a calendar file");
    expect(file.action).toBe("new");
    expect(calendar).toContain(
      "<blockquote><p>You&#39;re booked with Riley at Lee&#39;s Barbershop.<br>Sat Nov 14, 11:00am</p></blockquote>",
    );
    expect(calendar).toContain(
      `<p>${WORDS.calendarFile} <code>lees-barbershop-haircut.ics</code>: ${escapeHtml(CALENDAR_WORDS.new)}</p>`,
    );
    expect(calendar).toContain(
      `<details><summary>${escapeHtml(WORDS.calendarText)}</summary><pre>${escapeHtml(file.ics)}</pre></details>`,
    );
    // A photo: its file and its type; the page shows no image.
    expect(photo).toContain(
      `<p>${escapeHtml(WORDS.photo)} <code>file-demo-lees-price-list</code>, <code>image/jpeg</code>.</p>`,
    );
    expect(photo).not.toContain("<img");
    // Typing dots, which make no message.
    expect(typing).toContain(`<p>${escapeHtml(WORDS.typingStart)}</p>`);
    expect(typing).toContain(`<p>${WORDS.taken}</p>`);
    // A tapback: Rosie's like on the phone's own message.
    expect(tapback).toContain(
      `<p>A like ${escapeHtml(WORDS.tapbackOn)} <code>linq-msg-demo-in-alex-0012</code>.</p>`,
    );
    expect(tapback).toContain(`<p>${WORDS.taken}</p>`);
    // A threaded reply: the message it sits under, which is the text above, part 1, then its words.
    expect(reply).toContain(
      [
        `<p>${WORDS.inReplyTo} <code>linq-msg-demo-0001</code> (${WORDS.partHere} 1).</p>`,
        "<blockquote><p>Done. Your haircut with Riley at Lee&#39;s Barbershop is now Sat 2:00pm.</p></blockquote>",
      ].join("\n"),
    );
  });

  it("the view keeps the answer's order and never sorts it: the same parts reversed show reversed, and the threaded reply names its part where it now is", async () => {
    const { html } = await openWith({ ...RECORDED, parts: [...ALL_KINDS].reverse() });
    const rows = rowsAfter(html, WORDS.partsHeading);
    expect(rows.map(headingOf)).toEqual([...KIND_HEADINGS].reverse());
    expect(rows[0]).toContain(
      `<p>${WORDS.inReplyTo} <code>linq-msg-demo-0001</code> (${WORDS.partHere} 8).</p>`,
    );
  });

  it("a threaded reply under a message that is not among the parts names the message alone", async () => {
    const reply = recordedOf("send-threaded-reply.json");
    const { html } = await openWith({ ...RECORDED, parts: [reply] });
    expect(rowsAfter(html, WORDS.partsHeading)[0]).toContain(
      `<p>${WORDS.inReplyTo} <code>linq-msg-demo-0001</code>.</p>`,
    );
  });

  it("each part shows what the Linq double answered: a part not sent says why, and only a part sent past an opt-out says so", async () => {
    const noAnswer: RecordedPart = {
      ...recordedOf("send-text.json"),
      outcome: {
        result: "failed",
        kind: "transient",
        httpStatus: null,
        code: null,
        reason: "Dummy network error",
        retryAfterSeconds: null,
        providerMessageId: null,
      },
    };
    const parts = [recordedOf("error-4006.json"), recordedOf("send-override-optout.json"), noAnswer];
    const { html } = await openWith({ ...RECORDED, parts });
    const rows = rowsAfter(html, WORDS.partsHeading);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain(
      `<p><strong>${WORDS.notSent}</strong> ${escapeHtml(FAILED_WORDS.mayStillDeliver)} (${WORDS.linqAnswered} 500, ${WORDS.linqCode} 4006): Message send timed out</p>`,
    );
    expect(rows[0]).not.toContain(WORDS.taken);
    expect(rows[1]).toContain(`<p>${WORDS.takenAs} <code>linq-msg-demo-0030</code>.</p>`);
    expect(rows[2]).toContain(
      `<p><strong>${WORDS.notSent}</strong> ${escapeHtml(FAILED_WORDS.transient)} (${WORDS.noAnswer}): Dummy network error</p>`,
    );
    expect(rows.map((row) => row.includes(`<p>${escapeHtml(WORDS.pastOptOut)}</p>`))).toEqual([
      false,
      true,
      false,
    ]);
  });

  // Each failure as K-11 v1 sendPart.errors' rules shape it (the codes and statuses each kind is read from).
  it.each([
    {
      kind: "optedOut",
      httpStatus: 403,
      code: "2024",
      retry: null,
      answered: "Linq answered 403, code 2024",
    },
    {
      kind: "mayStillDeliver",
      httpStatus: 500,
      code: "4001",
      retry: null,
      answered: "Linq answered 500, code 4001",
    },
    { kind: "rateLimited", httpStatus: 429, code: null, retry: 30, answered: "Linq answered 429" },
    { kind: "refused", httpStatus: 400, code: "1007", retry: null, answered: "Linq answered 400, code 1007" },
    { kind: "transient", httpStatus: null, code: null, retry: null, answered: "no answer came" },
  ] as const)(
    "a part that failed as $kind says why in its own words, with Linq's answer",
    async ({ kind, httpStatus, code, retry, answered }) => {
      const [text] = ALL_KINDS;
      if (text === undefined) throw new Error("send-text.json is a part");
      const failed: RecordedPart = {
        ...text,
        outcome: {
          result: "failed",
          kind,
          httpStatus,
          code,
          reason: "Dummy reason",
          retryAfterSeconds: retry,
          providerMessageId: null,
        },
      };
      const { html } = await openWith({ ...RECORDED, parts: [failed] });
      const [row] = rowsAfter(html, WORDS.partsHeading);
      expect(row).toContain(
        `<p><strong>${WORDS.notSent}</strong> ${escapeHtml(FAILED_WORDS[kind])} (${answered}): Dummy reason</p>`,
      );
      expect(row).not.toContain(WORDS.taken);
    },
  );
});

describe("the email double's output shows beside the texts", () => {
  it("test-phone-parts.json's email shows right after the texts and their links, before the phone's state: its subject, to whom, when and its words, line by line", async () => {
    const { html } = await openFixture();
    const headings = [WORDS.partsHeading, WORDS.emailsHeading, WORDS.stateHeading, WORDS.chatLinkHeading].map(
      (heading) => html.indexOf(`<h2>${escapeHtml(heading)}</h2>`),
    );
    expect(headings.every((at) => at !== -1)).toBe(true);
    expect([...headings].sort((a, b) => a - b)).toEqual(headings);
    expect(rowsAfter(html, WORDS.emailsHeading)).toEqual([
      [
        "<h3>Your haircut at Lee&#39;s Barbershop</h3>",
        `<p>${WORDS.emailTo} <code>alex.m@example.com</code>, <time datetime="2026-10-23T14:05:06Z">2026-10-23 14:05:06 UTC</time>.</p>`,
        "<blockquote><p>Sure. Pick a new time for your haircut at Lee&#39;s Barbershop with Riley.<br>Which time works?<br>Sat 12:00pm<br>Sat 2:00pm<br>Sat 3:30pm</p></blockquote>",
      ].join("\n"),
    ]);
  });

  it("several emails show in the answer's order; with none the view says so, and with no part either the texts' heading says so", async () => {
    const second = {
      at: "2026-10-23T14:07:00Z",
      to: "alex.m@example.com",
      subject: "Dummy second email",
      text: "Dummy words",
    };
    const { html } = await openWith({ ...RECORDED, emails: [...RECORDED.emails, second] });
    expect(rowsAfter(html, WORDS.emailsHeading).map(headingOf)).toEqual([
      "<h3>Your haircut at Lee&#39;s Barbershop</h3>",
      "<h3>Dummy second email</h3>",
    ]);

    const empty = await openWith({ ...RECORDED, parts: [], emails: [] });
    expect(empty.response.status).toBe(200);
    expect(rowsAfter(empty.html, WORDS.partsHeading)).toEqual([]);
    expect(sectionAfter(empty.html, WORDS.partsHeading)).toMatch(
      new RegExp(`^<p>${escapeHtml(WORDS.noParts)}</p>\n<p><a href=`),
    );
    expect(sectionAfter(empty.html, WORDS.emailsHeading)).toBe(`<p>${WORDS.noEmails}</p>`);
  });
});

describe("the phone's stop state shows as the response gives it", () => {
  const STOPPED = `<p><strong>${WORDS.stoppedMark}</strong> ${escapeHtml(WORDS.stoppedLine)}</p>`;
  const NOT_STOPPED = `<p><strong>${WORDS.notStoppedMark}</strong> ${escapeHtml(WORDS.notStoppedLine)}</p>`;
  const CHAT_OPEN = `<p><strong>${WORDS.chatOpenMark}</strong> ${escapeHtml(WORDS.chatOpenLine)}</p>`;
  const CHAT_CLOSED = `<p><strong>${WORDS.chatClosedMark}</strong> ${escapeHtml(WORDS.chatClosedLine)}</p>`;
  const LAST_STOP = `<p>${WORDS.lastStopped} <time datetime="2026-10-23T14:10:00Z">2026-10-23 14:10:00 UTC</time>.</p>`;

  it("test-phone-parts.json's phone: not stopped, never stopped, its chat open", async () => {
    expect(RECORDED.phone).toEqual({
      testPhoneId: "tp-03",
      last4: "0101",
      chatOpen: true,
      stopped: false,
      stoppedAt: null,
    });
    const { html } = await openFixture();
    expect(sectionAfter(html, WORDS.stateHeading)).toBe([NOT_STOPPED, CHAT_OPEN].join("\n"));
    expect(html).not.toContain(WORDS.stoppedMark);
  });

  it.each([
    {
      what: "stopped, its chat closed by the STOP",
      phone: { stopped: true, stoppedAt: "2026-10-23T14:10:00Z", chatOpen: false },
      shown: [STOPPED, LAST_STOP, CHAT_CLOSED],
    },
    {
      what: "stopped, with no time given",
      phone: { stopped: true, stoppedAt: null, chatOpen: false },
      shown: [STOPPED, CHAT_CLOSED],
    },
    {
      what: "started again: not stopped, its chat open, the last STOP's time given",
      phone: { stopped: false, stoppedAt: "2026-10-23T14:10:00Z", chatOpen: true },
      shown: [NOT_STOPPED, LAST_STOP, CHAT_OPEN],
    },
    {
      what: "never texted Rosie's number: not stopped, its chat not open",
      phone: { stopped: false, stoppedAt: null, chatOpen: false },
      shown: [NOT_STOPPED, CHAT_CLOSED],
    },
  ])("$what: shown as the answer gives it", async ({ phone, shown }) => {
    const { response, html } = await openWith({ ...RECORDED, phone: { ...RECORDED.phone, ...phone } });
    expect(response.status).toBe(200);
    expect(sectionAfter(html, WORDS.stateHeading)).toBe(shown.join("\n"));
  });

  it("the stopped line says, in plain words, that every business's texts are off until START", () => {
    expect(WORDS.stoppedLine).toBe(
      "Rosie's texts to this phone are off for every business until it texts START.",
    );
  });
});

describe("the chat link shows through the chat-link component", () => {
  const chatLink = RECORDED.chatLink;
  if (chatLink === null) throw new Error("test-phone-parts.json gives a chat link");

  it("test-phone-parts.json's chat link is the component's own HTML, byte for byte: the link, its QR code holding that link, and the ready text", async () => {
    const { html } = await openFixture();
    const section = sectionAfter(html, WORDS.chatLinkHeading);
    expect(section).toBe(renderChatLink(chatLink));
    expect(section).not.toBe("");
    expect(onlyOne(anchorsOf(section)).href).toBe(chatLink.link);
    expect(decodeSvg(onlyOne(svgsOf(html)))).toBe(chatLink.link);
    expect(section).toContain(`<p><strong>${escapeHtml(chatLink.readyText)}</strong></p>`);
    expect(visibleText(section)).toContain(chatLink.readyText);
  });

  it("Rosie's number never shows as text: it stays in the link's href, where the component puts it (CQ-326)", async () => {
    const { html } = await openFixture();
    expect(chatLink.link).toContain(ROSIES_LINE);
    expect(visibleText(html)).not.toContain(ROSIES_LINE);
  });

  it("with no chat link in the answer, the view shows nothing there: no heading, no link, no QR code and no ready text", async () => {
    const { response, html } = await openWith({ ...RECORDED, chatLink: null });
    expect(response.status).toBe(200);
    expect(renderChatLink(null)).toBe("");
    expect(html).not.toContain(WORDS.chatLinkHeading);
    for (const shown of ["sms:", "<svg", 'class="chat-link"', escapeHtml(chatLink.readyText)])
      expect(html).not.toContain(shown);
    // The phone's state is then the view's last section.
    expect(html).toContain(`${escapeHtml(WORDS.chatOpenLine)}</p>\n</main>`);
  });
});

describe("for the user's own try: links to check again, to send as this phone and to choose another", () => {
  it("under the texts, Check again opens this view again, Send a text as this phone opens the send page with this phone chosen, and Choose another phone opens the picker", async () => {
    const roster: OutcomeOf<"testRoster"> = { result: "testRoster", businesses: [], phones: [] };
    const { shell, config, sent } = stubPartsShell({ testPhoneParts: RECORDED, testRoster: roster });
    const html = await (await shell.fetch(open(partsHref(config, PHONE), sessionOf(config)))).text();
    // Right under the texts, so the newest part and the links sit together, before the emails.
    const links = anchorsOf(sectionAfter(html, WORDS.partsHeading));
    expect(links).toEqual([
      { href: "/test/staging/test-phone/parts?phone=tp-03", text: WORDS.checkAgain },
      { href: "/test/staging/test-phone?phone=tp-03", text: WORDS.sendAs },
      { href: "/test/staging/test-phone/phones", text: WORDS.choose },
    ]);
    expect(links.map((link) => link.href)).toEqual([
      partsHref(config, PHONE),
      testPhoneHref(config, PHONE),
      pickerHref(config),
    ]);
    const [again, send, choose] = links.map((link) => link.href);

    // Check again: this view read again, a plain reload, since the page runs no script.
    const reloaded = await shell.fetch(open(again ?? "", sessionOf(config)));
    expect(reloaded.status).toBe(200);
    expect(rowsAfter(await reloaded.text(), WORDS.partsHeading)).toEqual(FIXTURE_ROWS);
    expect(html).not.toContain("<script");

    // Send a text as this phone: T-523's send page with this phone chosen; opening it makes no call.
    const sendPage = await (await shell.fetch(open(send ?? "", sessionOf(config)))).text();
    const form = sendFormOf(sendPage);
    expect(hiddenFields(form).phone).toBe(PHONE);
    expect(form).toContain(`<button>${SEND_WORDS.sendAs} ${PHONE}</button>`);

    // Choose another phone: T-525's picker.
    const picker = await shell.fetch(open(choose ?? "", sessionOf(config)));
    expect(picker.status).toBe(200);
    expect(await picker.text()).toContain(`<h1>${PICKER_WORDS.title}</h1>`);
    expect(sent.map((call) => call.call)).toEqual(["testPhoneParts", "testPhoneParts", "testRoster"]);
  });

  it("after a send, the send page's link See this phone's texts opens this view for the same phone (T-523's own routes)", async () => {
    const { shell, config, sent } = stubPartsShell({ testPhoneSend: SENT, testPhoneParts: RECORDED });
    const page = await (await shell.fetch(open(testPhoneHref(config, PHONE), sessionOf(config)))).text();
    const after = await shell.fetch(
      sendPost(
        config,
        typedInto(hiddenFields(sendFormOf(page)), { words: "Can I move my haircut?" }),
        sessionOf(config),
      ),
    );
    expect(after.status).toBe(200);
    const see = anchorsOf(await after.text()).filter((anchor) => anchor.text === SEND_WORDS.seeTexts);
    expect(see).toEqual([{ href: partsHref(config, PHONE), text: SEND_WORDS.seeTexts }]);

    const view = await shell.fetch(open(onlyOne(see).href, sessionOf(config)));
    expect(view.status).toBe(200);
    expect(rowsAfter(await view.text(), WORDS.partsHeading)).toEqual(FIXTURE_ROWS);
    expect(sent.map((call) => call.call)).toEqual(["testPhoneSend", "testPhoneParts"]);
    const read = sent[1]?.request as RequestOf<"testPhoneParts">;
    expect(read.testPhoneId).toBe(PHONE);
    expect(read.since).toBeNull();
    expect(read.page.sessionToken).toBe(PAGE.sessionToken);
  });
});

describe("the view sits behind the tester login (T-520)", () => {
  /** Holds a page to the one that asks for sign-in, showing no texts. */
  function expectSignInFirst(html: string, signIn: string): void {
    expect(html).toContain(`<h1>${WORDS.signInTitle}</h1>`);
    expect(html).toContain(`<p>${escapeHtml(WORDS.signInLine)}</p>`);
    expect(html).toContain(`<p><a href="${signIn}">${WORDS.signIn}</a></p>`);
    expect(html).not.toContain(WORDS.partsHeading);
    expect(html).not.toContain(WORDS.emailsHeading);
  }

  it("opened with no session cookie: the page asks for sign-in, shows no texts and makes no call", async () => {
    const { shell, config, transport } = mockPartsShell();
    for (const address of [partsHref(config, PHONE), `${config.basePath}/staging/test-phone/parts`]) {
      const response = await shell.fetch(open(address));
      expect(response.status).toBe(200);
      expectSignInFirst(await response.text(), startHref(config, null));
    }
    expect(transport.sent).toEqual([]);
  });

  it("a cookie that does not read as a token, or production's own cookie: the same, with no call", async () => {
    const { shell, config, transport } = mockPartsShell();
    const production = readWebConfig(testVars("production"));
    expect(cookieNames(production).session).not.toBe(cookieNames(config).session);
    for (const cookie of [sessionOf(config, "dummy-short"), sessionOf(production)]) {
      const response = await shell.fetch(open(partsHref(config, PHONE), cookie));
      expect(response.status).toBe(200);
      expectSignInFirst(await response.text(), startHref(config, null));
    }
    expect(transport.sent).toEqual([]);
  });

  it("signInNeeded (no live session came): the page asks for sign-in again, 403, showing no texts", async () => {
    const { response, html, config, sent } = await openWith({ error: "signInNeeded" });
    expect(response.status).toBe(403);
    expectSignInFirst(html, startHref(config, null));
    expect(sent).toHaveLength(1);
  });
});

describe("with no test phone chosen, nothing is read", () => {
  it.each([
    { what: "no phone field", query: "" },
    { what: "an empty phone", query: "?phone=" },
    { what: "spaces alone", query: "?phone=%20%20" },
  ])("$what: the page says to choose one, links to the picker, and makes no call", async ({ query }) => {
    const { shell, config, transport } = mockPartsShell();
    const response = await shell.fetch(
      open(`${config.basePath}/staging/test-phone/parts${query}`, sessionOf(config)),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<h1>${WORDS.chooseTitle}</h1>`);
    expect(html).toContain(`<p>${escapeHtml(WORDS.noneChosen)}</p>`);
    expect(anchorsOf(html.slice(0, html.indexOf("<footer>")))).toContainEqual({
      href: pickerHref(config),
      text: WORDS.chooseLink,
    });
    expect(html).not.toContain('role="alert"');
    expect(transport.sent).toEqual([]);
  });

  it.each([
    { what: "a value with a space inside", phone: "tp 03" },
    { what: "a value with a line break inside", phone: "tp-03\ntp-04" },
    { what: "a value over 128 characters", phone: "t".repeat(129) },
  ])("$what: 400, said plainly, and no call", async ({ phone }) => {
    const { shell, config, transport } = mockPartsShell();
    const response = await shell.fetch(
      open(
        `${config.basePath}/staging/test-phone/parts?phone=${encodeURIComponent(phone)}`,
        sessionOf(config),
      ),
    );
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain(`<p role="alert">${escapeHtml(WORDS.badPhone)}</p>`);
    expect(html).not.toContain(WORDS.partsHeading);
    expect(transport.sent).toEqual([]);
  });

  it("a roster id given with spaces around it is read without them: the fixture's request is sent", async () => {
    const { shell, config, transport } = mockPartsShell({
      traceId: PAGE.traceId,
      requestIds: [PAGE.requestId],
    });
    const response = await shell.fetch(
      open(`${config.basePath}/staging/test-phone/parts?phone=%20tp-03%20`, sessionOf(config)),
    );
    expect(response.status).toBe(200);
    expect(transport.sent.map((call) => call.request)).toEqual([PARTS.request]);
  });
});

describe("each other answer K-21 v1 gives testPhoneParts has its page", () => {
  it("notTester: the account is neither a tester nor on Rosie's team, 403, showing no texts", async () => {
    const { response, html, config } = await openWith({ error: "notTester" });
    expect(response.status).toBe(403);
    expect(html).toContain(`<h1>${WORDS.notTesterTitle}</h1>`);
    expect(html).toContain(`<p>${escapeHtml(WORDS.notTesterLine)}</p>`);
    expect(html).toContain(`<p><a href="${startHref(config, null)}">${WORDS.signInAsOther}</a></p>`);
    expect(html).not.toContain(WORDS.partsHeading);
  });

  it("stagingOnly (the server is not on staging): the staging-only guard's refused page, never a phone's texts", async () => {
    const { response, html } = await openWith({ error: "stagingOnly" });
    expect(response.status).toBe(REFUSED_STATUS);
    expect(html).toContain(`<h1>${REFUSED_WORDS.title}</h1>`);
    for (const line of REFUSED_WORDS.lines) expect(html).toContain(`<p>${escapeHtml(line)}</p>`);
    expect(html).toContain(`<p>${REFERENCE_LABEL}: <code>${TRACE_ID}</code></p>`);
    expect(html).not.toContain(WORDS.partsHeading);
  });

  it("notTestPhone: 400, the page names the roster id and links to the picker, showing no texts", async () => {
    const { response, html, config } = await openWith({ error: "notTestPhone", testPhoneId: "tp-99" });
    expect(response.status).toBe(400);
    expect(html).toContain(`<p role="alert">tp-99 ${escapeHtml(WORDS.notOnRoster)}</p>`);
    expect(html).toContain(`<p><a href="${pickerHref(config)}">${WORDS.chooseLink}</a></p>`);
    expect(html).not.toContain(WORDS.partsHeading);
  });

  it("transient: nothing was read; 503, said plainly, with Check again for the same phone", async () => {
    const { response, html, config } = await openWith({ error: "transient", sqlstate: "40001" });
    expect(response.status).toBe(503);
    expect(html).toContain(`<p role="alert">${escapeHtml(WORDS.tryAgainLine)}</p>`);
    expect(anchorsOf(html.slice(0, html.indexOf("<footer>")))).toEqual([
      { href: partsHref(config, PHONE), text: WORDS.checkAgain },
    ]);
    expect(html).not.toContain(WORDS.partsHeading);
  });
});

describe("every value from the answer is escaped", () => {
  it("the parts, the emails, the phone's state and the roster id show as text, never as markup", async () => {
    const [text, poll, linkCard, calendar, photo, , tapback, reply] = ALL_KINDS;
    if (
      text === undefined ||
      poll === undefined ||
      linkCard === undefined ||
      calendar === undefined ||
      photo === undefined ||
      tapback === undefined ||
      reply === undefined
    )
      throw new Error("K-11 v1 gives a send fixture of each kind");
    const marked: OutcomeOf<"testPhoneParts"> = {
      ...RECORDED,
      phone: { testPhoneId: "tp-<em>", last4: "<i>", chatOpen: true, stopped: true, stoppedAt: "<b>" },
      parts: [
        {
          ...text,
          at: "<u>",
          sent: { ...text.sent, text: '<script>alert("dummy")</script> & more' },
          outcome: {
            result: "accepted",
            providerMessageId: "msg-<s>",
            providerOptionIds: null,
            chatId: "chat-dummy",
            service: "imessage",
            acceptedAt: "2026-10-23T14:05:03Z",
          },
        },
        { ...poll, sent: { ...poll.sent, options: ["<b>Sat</b>", "Sun & Mon"] } },
        { ...linkCard, sent: { ...linkCard.sent, link: 'https://example.com/?a=<b>&b="dummy"' } },
        {
          ...calendar,
          sent: {
            ...calendar.sent,
            calendarFile: { action: "move", fileName: "<b>.ics", ics: "BEGIN:VCALENDAR<i>" },
          },
        },
        { ...photo, sent: { ...photo.sent, photo: { fileId: "file-<u>", mediaType: "image/<s>" } } },
        {
          ...tapback,
          sent: { ...tapback.sent, tapback: { reaction: "like", onMessageId: "msg-<em>", onPoll: false } },
        },
        { ...reply, sent: { ...reply.sent, threadedReplyTo: { messageId: "msg-<b>" } } },
        {
          ...text,
          outcome: {
            result: "failed",
            kind: "refused",
            httpStatus: 400,
            code: "1007",
            reason: "<script>dummy</script>",
            retryAfterSeconds: null,
            providerMessageId: null,
          },
        },
      ],
      emails: [{ at: "<i>", to: "dummy<b>@example.com", subject: "<em>Dummy</em>", text: "<u>Words</u>" }],
    };
    const { html } = await openWith(marked);
    for (const markup of ["<script", "<b>", "<i>", "<u>", "<s>", "<em>"]) expect(html).not.toContain(markup);
    expect(html).toContain("&lt;script&gt;alert(&quot;dummy&quot;)&lt;/script&gt; &amp; more");
    expect(html).toContain(
      `<p>${WORDS.testPhone} <code>tp-&lt;em&gt;</code>, ${WORDS.ending} &lt;i&gt;.</p>`,
    );
    expect(html).toContain('<time datetime="&lt;u&gt;">&lt;u&gt;</time>');
    expect(html).toContain(`<p>${WORDS.lastStopped} <time datetime="&lt;b&gt;">&lt;b&gt;</time>.</p>`);
    expect(html).toContain("<code>msg-&lt;s&gt;</code>");
    expect(html).toContain("<li>&lt;b&gt;Sat&lt;/b&gt;</li>\n<li>Sun &amp; Mon</li>");
    expect(html).toContain(
      '<p><a href="https://example.com/?a=&lt;b&gt;&amp;b=&quot;dummy&quot;">https://example.com/?a=&lt;b&gt;&amp;b=&quot;dummy&quot;</a></p>',
    );
    expect(html).toContain(`<code>&lt;b&gt;.ics</code>: ${escapeHtml(CALENDAR_WORDS.move)}`);
    expect(html).toContain("<pre>BEGIN:VCALENDAR&lt;i&gt;</pre>");
    expect(html).toContain("<code>file-&lt;u&gt;</code>, <code>image/&lt;s&gt;</code>");
    expect(html).toContain("<code>msg-&lt;em&gt;</code>");
    expect(html).toContain(`${WORDS.inReplyTo} <code>msg-&lt;b&gt;</code>.`);
    expect(html).toContain("): &lt;script&gt;dummy&lt;/script&gt;</p>");
    expect(html).toContain("<h3>&lt;em&gt;Dummy&lt;/em&gt;</h3>");
    expect(html).toContain("<code>dummy&lt;b&gt;@example.com</code>");
    expect(html).toContain("<blockquote><p>&lt;u&gt;Words&lt;/u&gt;</p></blockquote>");
  });

  it("a link card whose link is not https shows it as text, never as a link", async () => {
    const [, , linkCard] = ALL_KINDS;
    if (linkCard === undefined) throw new Error("send-link-card.json is a part");
    const { html } = await openWith({
      ...RECORDED,
      parts: [{ ...linkCard, sent: { ...linkCard.sent, link: "javascript:void(0)" } }],
    });
    const [row] = rowsAfter(html, WORDS.partsHeading);
    expect(row).toContain("<p><code>javascript:void(0)</code></p>");
    expect(anchorsOf(row ?? "")).toEqual([]);
  });
});

/** Every page the view answers with, each with what it is: signed out, no phone, each answer's page and each view. */
async function everyPage(): Promise<{ what: string; response: Response }[]> {
  const pages: { what: string; response: Response }[] = [];
  const { shell, config } = mockPartsShell({ traceId: PAGE.traceId, requestIds: [PAGE.requestId] });
  pages.push({ what: "signed out", response: await shell.fetch(open(partsHref(config, PHONE))) });
  pages.push({
    what: "no phone",
    response: await shell.fetch(open(`${config.basePath}/staging/test-phone/parts`, sessionOf(config))),
  });
  pages.push({
    what: "a bad phone",
    response: await shell.fetch(
      open(`${config.basePath}/staging/test-phone/parts?phone=tp%2003`, sessionOf(config)),
    ),
  });
  pages.push({
    what: "the fixture",
    response: await shell.fetch(open(partsHref(config, PHONE), sessionOf(config))),
  });
  const answers: { what: string; answer: OutcomeOf<"testPhoneParts"> }[] = [
    { what: "every kind", answer: { ...RECORDED, parts: [...ALL_KINDS] } },
    {
      what: "not sent, and past an opt-out",
      answer: {
        ...RECORDED,
        parts: [recordedOf("error-4006.json"), recordedOf("send-override-optout.json")],
      },
    },
    {
      what: "stopped",
      answer: {
        ...RECORDED,
        phone: { ...RECORDED.phone, stopped: true, stoppedAt: "2026-10-23T14:10:00Z", chatOpen: false },
      },
    },
    { what: "empty, no chat link", answer: { ...RECORDED, parts: [], emails: [], chatLink: null } },
    { what: "stagingOnly", answer: { error: "stagingOnly" } },
    { what: "signInNeeded", answer: { error: "signInNeeded" } },
    { what: "notTester", answer: { error: "notTester" } },
    { what: "notTestPhone", answer: { error: "notTestPhone", testPhoneId: "tp-99" } },
    { what: "transient", answer: { error: "transient", sqlstate: "40001" } },
  ];
  for (const { what, answer } of answers) {
    const stub = stubPartsShell({ testPhoneParts: answer });
    pages.push({
      what,
      response: await stub.shell.fetch(open(partsHref(stub.config, PHONE), sessionOf(stub.config))),
    });
  }
  return pages;
}

describe("what no page of the view holds", () => {
  it("no form, script or session token; no phone's number, part key or chat id; no cookie set; no form may post", async () => {
    const pages = await everyPage();
    expect(pages).toHaveLength(13);
    expect([...new Set(pages.map((page) => page.response.status))].sort((a, b) => a - b)).toEqual([
      200, 400, 403, 503,
    ]);
    const parts = [
      ...RECORDED.parts,
      ...ALL_KINDS,
      recordedOf("error-4006.json"),
      recordedOf("send-override-optout.json"),
    ];
    for (const { what, response } of pages) {
      expect(response.headers.has("set-cookie"), what).toBe(false);
      expect(response.headers.get("content-security-policy"), what).toBe(contentSecurityPolicy());
      const html = await response.text();
      for (const held of ["<form", "<input", "<button", "<textarea", "<script", PAGE.sessionToken])
        expect(html, what).not.toContain(held);
      // A phone shows its last four digits alone: the number each part went to never shows, nor its key or chat.
      for (const { sent } of parts)
        for (const held of [
          sent.to,
          sent.chatId,
          ...(sent.idempotencyKey === null ? [] : [sent.idempotencyKey]),
        ])
          expect(html, what).not.toContain(held);
      expect(visibleText(html), what).not.toContain(ROSIES_LINE);
    }
  });

  it("its code reaches no number, signer or secret: the folder's own files import only the web app's shell, client, sign-in, staging guard, the chat-link component and the send page's and picker's addresses", () => {
    const folder = fileURLToPath(new URL("./", import.meta.url));
    const shipped = readdirSync(folder)
      .filter((name) => !name.endsWith(".test.ts") && name !== "test-support.ts")
      .sort();
    expect(shipped).toEqual(["page.ts", "parts.ts", "routes.ts"]);
    const allowed = [
      "../../../auth/cookies",
      "../../../auth/pages",
      "../../../client/calls",
      "../../../components/chat-link/chat-link",
      "../../../shell/config",
      "../../../shell/frame",
      "../../../shell/route",
      "../../guard",
      "../picker/page",
      "../send/page",
      "./page",
      "./parts",
    ];
    const imported = new Set<string>();
    for (const name of shipped) {
      const source = readFileSync(`${folder}${name}`, "utf8");
      for (const match of source.matchAll(/^import [^;]* from "([^"]+)";$/gm)) imported.add(match[1] ?? "");
      // No other way in: no dynamic import, no require, no Worker env.
      expect(source, name).not.toMatch(/\bimport\(|\brequire\(|\bprocess\.env\b|cloudflare:workers/);
    }
    expect([...imported].sort()).toEqual(allowed);
  });
});
