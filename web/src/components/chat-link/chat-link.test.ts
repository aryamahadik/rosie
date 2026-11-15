// T-513's proofs for the chat-link component (C-185; MC C9; Q-03; K-09 v1 chat-link-after-contact-add.json and
// chat-link-contact-add-failed.json): with an issued chat link the link and its QR code render side by side, and
// decoding the QR here gives exactly that link; with a failed contact add neither a link nor a QR renders; the ready
// text shows as the response gives it, and the link and the QR have text alternatives. Beside them: the link and the
// QR text used exactly as given (K-09 v1 staff-join-link.json's %27), K-21 v1 test-phone-parts.json's chat link as
// T-524's parts view will pass it, the answers with no link to show, and the component inside a page of the shell. The
// QR's options and the test-only decoder's own proofs are qr-code.test.ts's.
//
// Every value is a fixture's own placeholder or made up, and the one phone number is the fixtures' fiction-range
// placeholder for Rosie's line (Q-51), written whole (rule 9).
import { describe, expect, it } from "vitest";
import { exchange } from "../../auth/test-support";
import { isPageError } from "../../client/calls";
import { escapeHtml, renderPage } from "../../shell/frame";
import type { RouteModule } from "../../shell/route";
import { contentSecurityPolicy } from "../../shell/serve";
import { TRACE_ID, get, testShell } from "../../shell/test-support";
import {
  CHAT_LINK_WORDS,
  chatLinkOf,
  renderChatLink,
  type ChatLinkFields,
  type IssueChatLinkResponse,
} from "./chat-link";
import {
  anchorsOf,
  decodeSvg,
  fieldsOf,
  issuedOf,
  onlyOne,
  readQrSvg,
  responseOf,
  svgsOf,
  visibleText,
} from "./test-support";

/** K-09 v1: Ben booked on the booking page and contacts/add worked for his mobile. */
const AFTER_ADD = "chat-link-after-contact-add.json";
/** K-09 v1: contacts/add failed for Alex's mobile. */
const ADD_FAILED = "chat-link-contact-add-failed.json";
/** K-09 v1: Riley's staff join link; its ready text holds the apostrophe of "Lee's", written %27 in the link. */
const STAFF_JOIN = "staff-join-link.json";

/** Rosie's line as the K-09 and K-21 fixtures give it: a fiction-range placeholder (Q-51), whole. */
const FIXTURE_LINE = "+15555550188";

/** K-21 v1 test-phone-parts.json's chat link: tp-03's, as K-09 v1 issueChatLink gave it, with no qrText. */
function partsChatLink(): ChatLinkFields | null {
  const { outcome } = exchange("test-phone-parts.json", "testPhoneParts");
  if (isPageError(outcome)) throw new Error("test-phone-parts.json's outcome is not a response");
  return outcome.chatLink;
}

/** A K-09 answer that waits for contacts/add, made up in K-09 v1's shape. */
const WAITING: IssueChatLinkResponse = { result: "waitingForContact", effectId: "effect-dummy-0001" };

/** One paragraph holding the anchor and, right after it, the QR code: the two side by side. */
const SIDE_BY_SIDE = /<p>(<a href="[^"]*">[^<]*<\/a>) (<svg [^>]*>[\s\S]*?<\/svg>)<\/p>/;

describe("With chat-link-after-contact-add.json the link and a QR code render side by side, and decoding the QR in the test gives exactly that link", () => {
  const issued = issuedOf(AFTER_ADD);
  const html = renderChatLink(chatLinkOf(issued));

  it("the anchor's href is the response's link, byte for byte, and the QR code decodes to exactly that link", () => {
    // In K-09's fixtures the link and the QR text are one string (MC C9: the QR's content is the same link).
    expect(issued.qrText).toBe(issued.link);
    expect(onlyOne(anchorsOf(html)).href).toBe(issued.link);
    expect(html).toContain(`<a href="${escapeHtml(issued.link)}">`);
    expect(decodeSvg(onlyOne(svgsOf(html)))).toBe(issued.link);
  });

  it("the link and the QR code sit side by side: one paragraph holds the anchor and, right after it, the QR code", () => {
    const pair = SIDE_BY_SIDE.exec(html);
    expect(pair).not.toBeNull();
    expect(onlyOne(anchorsOf(pair?.[1] ?? "")).href).toBe(issued.link);
    expect(decodeSvg(pair?.[2] ?? "")).toBe(issued.link);
  });

  it("chatLinkOf takes the issued answer's link, QR text, ready text and short code exactly as given", () => {
    expect(chatLinkOf(issued)).toEqual({
      link: issued.link,
      qrText: issued.qrText,
      readyText: issued.readyText,
      shortCode: issued.shortCode,
    });
  });

  it("the anchor takes the link and the QR code takes the QR text, each from its own field", () => {
    // Made up: a QR text unlike the link, so each field is seen to reach its own place.
    const qrText = `sms:${FIXTURE_LINE}&body=Made%20up%20QR%20text%20QR0001`;
    const both = renderChatLink({ ...fieldsOf(AFTER_ADD), qrText });
    expect(onlyOne(anchorsOf(both)).href).toBe(issued.link);
    expect(decodeSvg(onlyOne(svgsOf(both)))).toBe(qrText);
  });
});

describe("With chat-link-contact-add-failed.json neither a link nor a QR renders (Q-03)", () => {
  it("the component is the empty string: no anchor, no QR code, no number and no words", () => {
    const failed = responseOf(ADD_FAILED);
    expect(failed.result).toBe("contactAddFailed");
    expect(chatLinkOf(failed)).toBeNull();
    expect(renderChatLink(chatLinkOf(failed))).toBe("");
  });

  it("a page that shows the component then holds no chat link, QR code or ready text", () => {
    const page = renderPage({
      basePath: "/test",
      path: "/example",
      title: "Booked",
      main: ["<h1>Booked</h1>", renderChatLink(chatLinkOf(responseOf(ADD_FAILED)))].join("\n"),
      noindex: true,
    });
    expect(page).not.toContain("sms:");
    expect(page).not.toContain("<svg");
    expect(page).not.toContain(FIXTURE_LINE);
    expect(page).not.toContain('class="chat-link"');
  });

  it("nothing renders while contacts/add is still waiting either, nor for K-21's null chat link", () => {
    expect(chatLinkOf(WAITING)).toBeNull();
    expect(renderChatLink(chatLinkOf(WAITING))).toBe("");
    expect(renderChatLink(null)).toBe("");
  });
});

describe("The link shows its ready text as the response gives it, and both link and QR have text alternatives", () => {
  const issued = issuedOf(AFTER_ADD);
  const html = renderChatLink(chatLinkOf(issued));

  it("the ready text shows as plain text exactly as the response gives it, after the fallback's sentence and its short code", () => {
    expect(html).toContain(`<p><strong>${escapeHtml(issued.readyText)}</strong></p>`);
    expect(visibleText(html)).toContain(issued.readyText);
    expect(visibleText(html)).toContain(`${CHAT_LINK_WORDS.fallback} ${issued.shortCode}:`);
    expect(issued.readyText).toContain(issued.shortCode);
  });

  it("Rosie's number is never read out of the link: no text on the page shows it", () => {
    expect(issued.link).toContain(FIXTURE_LINE);
    expect(visibleText(html)).not.toContain(FIXTURE_LINE);
  });

  it("the link's text is words, never the raw link", () => {
    const anchor = onlyOne(anchorsOf(html));
    expect(anchor.text).toBe(CHAT_LINK_WORDS.link);
    expect(anchor.text).not.toContain("sms:");
  });

  it("the QR code is an image whose text alternative names what it opens, with the ready text", () => {
    const svg = onlyOne(svgsOf(html));
    expect(svg).toMatch(/^<svg [^>]*\brole="img"/);
    const qr = readQrSvg(svg);
    expect(qr.label).toBe(`${CHAT_LINK_WORDS.qr} ${issued.readyText}`);
    expect(qr.label).toContain("opens Messages");
    expect(qr.title).toBe(qr.label);
  });

  it("the QR code is not the only way to the link: the anchor and the words are beside it", () => {
    expect(onlyOne(anchorsOf(html)).href).toBe(issued.link);
    expect(visibleText(html)).toContain(issued.readyText);
  });

  it("a ready text with characters HTML reads is escaped everywhere, and reads back exactly as given", () => {
    // Made up: quotes, an apostrophe, an ampersand and a tag.
    const readyText = `Join <b>"Lee's" & co</b> on Rosie JOIN7R`;
    const escaped = renderChatLink({ ...fieldsOf(STAFF_JOIN), readyText });
    expect(escaped).not.toContain("<b>");
    expect(escaped).toContain(`<p><strong>${escapeHtml(readyText)}</strong></p>`);
    expect(visibleText(escaped)).toContain(readyText);
    expect(readQrSvg(onlyOne(svgsOf(escaped))).label).toBe(`${CHAT_LINK_WORDS.qr} ${readyText}`);
  });
});

describe("The link and the QR text are used exactly as the response gives them", () => {
  it("staff-join-link.json's %27 reaches the href and the QR code unchanged", () => {
    const staff = issuedOf(STAFF_JOIN);
    expect(staff.link).toContain("%27");
    const html = renderChatLink(chatLinkOf(staff));
    expect(html).toContain(`<a href="${escapeHtml(staff.link)}">`);
    expect(onlyOne(anchorsOf(html)).href).toBe(staff.link);
    expect(decodeSvg(onlyOne(svgsOf(html)))).toBe(staff.qrText);
    expect(staff.qrText).toContain("%27");
  });

  it("K-21's chat link, which has no qrText, renders with the QR code holding its link exactly", () => {
    const chatLink = partsChatLink();
    if (chatLink === null) throw new Error("test-phone-parts.json gives no chat link");
    expect(chatLink.qrText).toBeUndefined();
    const html = renderChatLink(chatLink);
    expect(SIDE_BY_SIDE.test(html)).toBe(true);
    expect(onlyOne(anchorsOf(html)).href).toBe(chatLink.link);
    expect(decodeSvg(onlyOne(svgsOf(html)))).toBe(chatLink.link);
    expect(html).toContain(`<p><strong>${escapeHtml(chatLink.readyText)}</strong></p>`);
  });

  it("a link or QR text that would not open Messages is never placed in the page", () => {
    // Made up: links of other schemes.
    const fields = fieldsOf(AFTER_ADD);
    for (const other of ["https://example.com/chat", "javascript:void(0)", "SMS-like text", ""]) {
      expect(renderChatLink({ ...fields, link: other })).toBe("");
      expect(renderChatLink({ ...fields, qrText: other })).toBe("");
    }
  });
});

describe("The component inside a page of the shell", () => {
  it("a route puts it in its page: served with the shell's headers, the QR code decoding to the link", async () => {
    const chatLink = partsChatLink();
    if (chatLink === null) throw new Error("test-phone-parts.json gives no chat link");
    const module: RouteModule = {
      folder: "components/chat-link",
      stagingOnly: false,
      routes: [
        {
          label: "example.chatLink",
          path: "/example/chat-link",
          methods: ["GET"],
          handle: (context) =>
            context.page({ title: "Chat link", main: `<h1>Chat link</h1>\n${renderChatLink(chatLink)}` }),
        },
      ],
    };
    const { shell } = testShell({ modules: [module] });
    const response = await shell.fetch(get("/test/example/chat-link", { "x-trace-id": TRACE_ID }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy());
    const html = await response.text();
    expect(onlyOne(anchorsOf(html.slice(0, html.indexOf("<footer>")))).href).toBe(chatLink.link);
    expect(decodeSvg(onlyOne(svgsOf(html)))).toBe(chatLink.link);
  });

  it("holds no script, style, image, frame or outside resource, so the frame's content security policy needs nothing more", () => {
    const html = renderChatLink(fieldsOf(AFTER_ADD));
    for (const refused of [
      /<script/i,
      /<style/i,
      /\sstyle=/i,
      /<img/i,
      /\ssrc=/i,
      /<link/i,
      /<iframe/i,
      /<object/i,
      /\son[a-z]+=/i,
    ])
      expect(html).not.toMatch(refused);
  });
});
