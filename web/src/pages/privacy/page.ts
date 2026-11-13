// The privacy notice page at BASE_PATH + "/privacy" (T-1171): rosfield.com/test/privacy on staging, the address Rosie's
// first text names on its last line (bundle v0's privacyLink, T-1146), and rosfield.com/privacy in production.
// It shows the notice's stand-in words (notice.ts) under a draft note, inside the page frame, whose footer links here
// as every page's does (RULES 4.3; Q-30). Static: the same page for every reader, with no form, script, cookie, tracking
// or personal data.
import { PRIVACY_PATH, escapeHtml, htmlComment, renderPage } from "../../shell/frame";
import {
  DRAFT_NOTE,
  NOTICE_INTRO,
  NOTICE_SECTIONS,
  NOTICE_TITLE,
  PAGE_TITLE,
  STAND_IN_MARKER,
  type NoticeSection,
} from "./notice";

function renderSection(section: NoticeSection): string {
  const headingId = `notice-${section.id}`;
  return [
    `<section aria-labelledby="${escapeHtml(headingId)}">`,
    `<h2 id="${escapeHtml(headingId)}">${escapeHtml(section.heading)}</h2>`,
    ...section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph.text)}</p>`),
    "</section>",
  ].join("\n");
}

/** The privacy notice page, a whole HTML document, for BASE_PATH `basePath`. */
export function renderPrivacyPage(basePath: string): string {
  const main = [
    // The stand-in marker sits in the page's source; the draft note says the same to every reader.
    htmlComment(STAND_IN_MARKER),
    '<article data-words="stand-in">',
    `<h1>${escapeHtml(NOTICE_TITLE)}</h1>`,
    `<p class="draft" role="note"><strong>Draft.</strong> ${escapeHtml(DRAFT_NOTE)}</p>`,
    `<p>${escapeHtml(NOTICE_INTRO.text)}</p>`,
    ...NOTICE_SECTIONS.map(renderSection),
    "</article>",
  ].join("\n");
  return renderPage({ basePath, path: PRIVACY_PATH, title: PAGE_TITLE, main, noindex: true });
}
