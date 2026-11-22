// The pages a signed link opens to (T-512; C-185; K-21 v1 openLink): each one HTML made on the Worker, with no script and
// no form, for the frame (shell/frame.ts).
//
//   openedPage   the page the link names (view.ts decides what it may show): its kind's title and purpose, the
//                business's public name and its sections' names. Without proof it offers the sign-in for the link's own
//                account, both ways, and shows no time and nothing on file for anyone. With proof it says the reader is
//                signed in and when the link lapses. The sections' contents are each page type's own (T-515, the journey
//                lanes, S10-8), never this page's.
//   expiredPage  a plain page for an unknown, lapsed or ended link (K-21 v1 linkExpired: one answer for all three), with
//                no field of the old page, so a guessed or stale code learns nothing. The same bytes for every code.
//   notOpenedPage  K-21 v1 transient or bookingPaused: nothing was read; try again. No field of the page either.
//
// Every value from an answer is escaped with escapeHtml, the sign-in link is built from the config with the address's own
// code (auth/pages.ts startHref), and no page here shows the link's code, whom a call acts for or the step id. No source
// gives these pages' words; they are plain stand-ins (D4 of the S1-10 ruling, DL-1125: Jay decides a page's wording).

import { SIGN_OUT_PATH, startHref } from "../auth/pages";
import { instantOf } from "../auth/cookies";
import type { WebConfig } from "../shell/config";
import { escapeHtml } from "../shell/frame";
import type { RoutePage } from "../shell/route";
import { PAGE_KIND_WORDS, SECTION_WORDS } from "./kinds";
import type { LinkView } from "./view";

/** The words of the sign-in offer on a link's page without proof (FS line 701; S13-45). */
export const SIGN_IN_WORDS = {
  heading: "Sign in to open this page",
  why: "Opening a link does not show who you are, so nothing on this page opens until you sign in.",
  ways: "Sign in with a code, by email to the email on file or by a text you send from the mobile on file. A code goes only to the email or mobile on file for this page's own account.",
  link: "Sign in",
} as const;

/** What a link's page says once the reader's own session came with it. */
export const SIGNED_IN_WORDS = "You are signed in.";

/** The heading over a page's sections. */
export const SECTIONS_HEADING = "On this page";

/** The expired page's words: the same for an unknown, a lapsed and an ended link. */
export const EXPIRED_WORDS = {
  title: "This link has expired",
  lines: [
    "This link no longer opens a page.",
    "If you still need the page, ask Rosie in your chat for a new link.",
  ],
} as const;

/** The expired page's status: one status for every code, known or not (K-21 v1 linkExpired). */
export const EXPIRED_STATUS = 410;

/** The words when openLink answered transient or bookingPaused. */
export const NOT_OPENED_WORDS = {
  title: "This page could not open just now",
  lines: ["Nothing was changed. Try again in a moment."],
} as const;

const p = (words: string): string => `<p>${escapeHtml(words)}</p>`;

/** An instant as the page shows it: its date and time in UTC, since no script can read the reader's own zone. */
function timeTag(utc: string): string | null {
  const at = instantOf(utc);
  if (at === null) return null;
  const iso = at.toISOString().replace(".000Z", "Z");
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(`${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`)}</time>`;
}

/** The page the link names, as `view` allows it (see the top of this file). `code` is the address's own link code. */
export function openedPage(config: WebConfig, code: string, view: LinkView): RoutePage {
  const kind = PAGE_KIND_WORDS[view.pageKind];
  const sections =
    view.sections.length === 0
      ? []
      : [
          `<h2>${escapeHtml(SECTIONS_HEADING)}</h2>`,
          "<ul>",
          ...view.sections.map((section) => `<li>${escapeHtml(SECTION_WORDS[section])}</li>`),
          "</ul>",
        ];
  const until = view.proven && view.expiresAt !== null ? timeTag(view.expiresAt) : null;
  const after = view.proven
    ? [
        ...(until === null ? [] : [`<p>${escapeHtml("This link works until ")}${until}.</p>`]),
        `<p><a href="${escapeHtml(`${config.basePath}${SIGN_OUT_PATH}`)}">Sign out</a></p>`,
      ]
    : [
        `<h2>${escapeHtml(SIGN_IN_WORDS.heading)}</h2>`,
        p(SIGN_IN_WORDS.why),
        p(SIGN_IN_WORDS.ways),
        `<p><a href="${escapeHtml(startHref(config, code))}">${escapeHtml(SIGN_IN_WORDS.link)}</a></p>`,
      ];
  const main = [
    `<h1>${escapeHtml(kind.title)}</h1>`,
    p(`For ${view.businessName}`),
    p(kind.purpose),
    ...(view.proven ? [p(SIGNED_IN_WORDS)] : []),
    ...sections,
    ...after,
  ].join("\n");
  return { title: kind.title, main };
}

/** The plain expired page (see the top of this file). */
export function expiredPage(): RoutePage {
  const main = [`<h1>${escapeHtml(EXPIRED_WORDS.title)}</h1>`, ...EXPIRED_WORDS.lines.map(p)].join("\n");
  return { title: EXPIRED_WORDS.title, main, status: EXPIRED_STATUS };
}

/** The page when the link could not be opened just now (see the top of this file). */
export function notOpenedPage(): RoutePage {
  const main = [`<h1>${escapeHtml(NOT_OPENED_WORDS.title)}</h1>`, ...NOT_OPENED_WORDS.lines.map(p)].join(
    "\n",
  );
  return { title: NOT_OPENED_WORDS.title, main, status: 503 };
}
