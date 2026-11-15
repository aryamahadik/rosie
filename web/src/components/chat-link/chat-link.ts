// The chat link with its QR code (T-513; C-185; MC C9; RULES 4.1b; Q-03; K-09 v1 issueChatLink; K-21 v1
// testPhoneParts' chatLink; K-03 v1's link.chat and link.chatqr slots): one component for every screen that shows a chat
// link (the booking page and its confirmation, the owner's team page, staging's test-phone page). HTML made on the
// Worker, with no script, for the frame (shell/frame.ts), as the shell's pages are made (T-511; T-523's page): a page
// puts what renderChatLink gives into its main content.
//
// Given a chat link's fields as a response holds them, it shows:
//   - the link: an anchor whose href is the response's `link` exactly as given (HTML escaping alone), with words for its
//     text, never the raw link;
//   - beside it, in the same paragraph, the QR code of the response's `qrText` exactly as given (qr-code.ts), whose text
//     alternative names what it opens. K-21 v1's chatLink carries no qrText: the QR then holds `link`, which is what
//     K-09 v1's qrText is ("The QR code's content: the same link (MC C9)");
//   - the fallback in plain words (T-1043, web/spikes/chat-link/FINDINGS.md, "Fallback in plain words"): the note's
//     sentence, with the short code, and the ready text as plain text a person can read and copy.
// It never builds, re-encodes or decodes the link or the QR text, and never reads anything out of them.
//
// What it never shows:
//   - Rosie's number as text: neither K-09 v1's issueChatLink response nor K-21 v1's chatLink holds it in a field of its
//     own, and it is never read out of the link, so the fallback's sentence names Rosie's number without showing it;
//   - anything at all when there is no link to show. A link shows only once the mobile was added as a Linq contact
//     (Q-03), so for K-09's contactAddFailed and waitingForContact answers, and for K-21's null chatLink, the component
//     is the empty string: no anchor, no QR, no number and no words. The screen around it shows the other ways in.
//   - a link or QR text that is not an sms: link, which would not open Messages: then too the component is the empty
//     string, as the sign-in page places no text link but an sms: one (auth/pages.ts).
//
// No source gives the component's words; they are plain stand-ins (CHAT_LINK_WORDS).

import type { ToolApiV1 } from "../../../../contracts/generated/tool-api/tool-api.v1";
import { escapeHtml } from "../../shell/frame";
import { qrSvg } from "./qr-code";

/** K-09 v1 issueChatLink's exchange, read off the root by its call, never by a generated name (DL-350). */
type IssueChatLinkExchange = Extract<ToolApiV1, { call: "issueChatLink" }>;

/**
 * K-09 v1 issueChatLink.response: the link (issued), or why it cannot be shown yet (waitingForContact: contacts/add
 * has not worked yet; contactAddFailed: it failed, so the person uses the booking page, email or their own AI).
 */
export type IssueChatLinkResponse = Exclude<IssueChatLinkExchange["outcome"], { error: string }>;

/**
 * A chat link's fields as a response holds them: K-09 v1 issueChatLink's issued answer (chatLinkOf gives them), or
 * K-21 v1 testPhoneParts' chatLink, as it is.
 */
export interface ChatLinkFields {
  /** The link that opens Messages to Rosie's number with the ready text (K-09 v1 link). */
  readonly link: string;
  /** The QR code's content, the same link (K-09 v1 qrText; MC C9). K-21 v1's chatLink has none: the QR holds `link`. */
  readonly qrText?: string;
  /** The ready text, with the short code in it (K-09 v1 readyText; RULES 4.1b). */
  readonly readyText: string;
  /** The short code in the ready text (K-09 v1 shortCode; K-29 v1 chat_links.short_code). */
  readonly shortCode: string;
}

/** The component's words: plain stand-ins (see the top of this file). */
export const CHAT_LINK_WORDS = {
  /** The link's text: what it does. */
  link: "Open Messages to text Rosie",
  /** The QR code's text alternative, before the ready text. */
  qr: "QR code that opens Messages on a phone, with this text to Rosie:",
  /** T-1043's fallback sentence, before the short code and a colon; the ready text follows it. */
  fallback:
    "If the link does not open Messages with the words filled in, open Messages and text Rosie's number with exactly these words, including the code",
} as const;

/** Only a link that opens Messages is placed in a page (as auth/pages.ts places a sign-in text link). */
const SMS_SCHEME = "sms:";

/**
 * The chat link's fields of a K-09 v1 issueChatLink response: an issued answer's link, QR text, ready text and short
 * code, exactly as given; null for waitingForContact and contactAddFailed, which have no link to show (Q-03).
 */
export function chatLinkOf(response: IssueChatLinkResponse): ChatLinkFields | null {
  if (response.result !== "issued") return null;
  return {
    link: response.link,
    qrText: response.qrText,
    readyText: response.readyText,
    shortCode: response.shortCode,
  };
}

/**
 * The chat-link component (see the top of this file): the link, its QR code beside it and the fallback in plain words,
 * as HTML for a page's main content, every value escaped with escapeHtml. The empty string when there is no link to
 * show: `fields` is null (chatLinkOf's answer when the contact add failed or is still waiting, or K-21's null chatLink),
 * or its link or QR text is not an sms: link.
 */
export function renderChatLink(fields: ChatLinkFields | null): string {
  if (fields === null) return "";
  const qrText = fields.qrText ?? fields.link;
  if (!fields.link.startsWith(SMS_SCHEME) || !qrText.startsWith(SMS_SCHEME)) return "";
  const anchor = `<a href="${escapeHtml(fields.link)}">${escapeHtml(CHAT_LINK_WORDS.link)}</a>`;
  const qr = qrSvg(qrText, `${CHAT_LINK_WORDS.qr} ${fields.readyText}`);
  return [
    '<div class="chat-link">',
    `<p>${anchor} ${qr}</p>`,
    `<p>${escapeHtml(`${CHAT_LINK_WORDS.fallback} ${fields.shortCode}:`)}</p>`,
    `<p><strong>${escapeHtml(fields.readyText)}</strong></p>`,
    "</div>",
  ].join("\n");
}
