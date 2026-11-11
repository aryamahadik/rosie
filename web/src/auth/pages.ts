// The sign-in pages (T-520; C-193; FS section 8): each one HTML made on the Worker, with no script, for the frame
// (shell/frame.ts). A page holds a form or a link and nothing that runs: what the server answered decides which page
// comes next.
//
// What a page may show (K-21 v1 README, "Sign-in and sessions"; S13-45):
//   - the way the code went (email or text), as signInStart's answer gives it, and never a word on whether an account
//     matched: the answer is the same either way, so the page's words are too;
//   - never what was typed (the mobile, the email, the code), and never a masked address, since K-21 gives none;
//   - on the text way only, the ready text signInStart gave for the person to send, which holds the code;
//   - after a right code, what the person is signed in as and the consoles that are theirs (consoles.ts).
// Every value that comes from a request, a cookie or an answer is escaped with escapeHtml, and a link back to a signed
// link's page is built with linkUrl from the config, never from the request's host.
//
// No source gives these pages' words beyond FS section 8's rules ("The code works for 10 minutes. Five wrong codes
// pause sign-in for 15 minutes. Rosie never asks for it by text or call"; "No password"); the rest are plain stand-ins.

import { linkUrl, type WebConfig } from "../shell/config";
import { escapeHtml } from "../shell/frame";
import type { RoutePage } from "../shell/route";
import { isStagingConfig } from "../staging/guard";
import { SIGNED_IN_AS_WORDS, type ConsoleLink, type SignedInAs } from "./consoles";

/** The sign-in page's path under BASE_PATH: the form that starts a sign-in. */
export const SIGN_IN_PATH = "/sign-in";
/** Where the code, or the word that the text was sent, is posted. */
export const SIGN_IN_CHECK_PATH = "/sign-in/check";
/** The sign-out page's path. */
export const SIGN_OUT_PATH = "/sign-out";

/** The two ways a code goes (K-21 v1 signInStart.way). */
export type SignInWay = "email" | "text";

/** A sign-in under way, as the page carries it from one form to the next: nothing in it says who anyone is. */
export interface Attempt {
  /** K-21 v1 attemptId: opaque, bound on the server to this browser's device token. */
  readonly attemptId: string;
  /** The way the code went, as signInStart answered it. */
  readonly way: SignInWay;
  /** The signed link the sign-in was opened from, or null for the portal's own sign-in. */
  readonly link: string | null;
}

/** A problem to show above a form, with the status the page then has. */
export interface Problem {
  readonly words: string;
  readonly status: number;
}

/** FS section 8, S13-45: said on every page that takes or shows a code. */
export const NEVER_ASKED = "Rosie never asks you for a sign-in code by text or call.";
/** FS section 8. */
export const FIVE_WRONG = "Five wrong codes pause sign-in for 15 minutes.";
/** The page's words for a form that did not arrive as the page sent it. */
export const BAD_FORM = "That form could not be read. Start again.";
/** The page's words when K-21 answered transient or bookingPaused: nothing was sent or checked. */
export const TRY_AGAIN = "That did not go through, and nothing was changed. Try again in a moment.";

const p = (words: string): string => `<p>${escapeHtml(words)}</p>`;
const problemLine = (problem: Problem | null): string[] =>
  problem === null ? [] : [`<p role="alert">${escapeHtml(problem.words)}</p>`];
const hidden = (name: string, value: string): string =>
  `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
const formTo = (config: WebConfig, path: string): string =>
  `<form method="post" action="${escapeHtml(`${config.basePath}${path}`)}">`;

/** The sign-in page's address on this site, for the portal or for a signed link's own sign-in. */
export function startHref(config: WebConfig, link: string | null): string {
  return `${config.basePath}${SIGN_IN_PATH}${link === null ? "" : `?link=${encodeURIComponent(link)}`}`;
}

const startAgain = (config: WebConfig, link: string | null, words = "Start again"): string =>
  `<p><a href="${escapeHtml(startHref(config, link))}">${escapeHtml(words)}</a></p>`;

/** How long until `until`, in plain words: whole minutes up to 90, then whole hours. */
export function waitWords(until: Date, now: Date): string {
  const minutes = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
  if (minutes === 1) return "1 minute";
  if (minutes <= 90) return `${String(minutes)} minutes`;
  return `${String(Math.ceil(minutes / 60))} hours`;
}

/** An instant as the page shows it: the time in UTC, with its date, since no script can read the reader's own zone. */
function timeTag(at: Date): string {
  const iso = at.toISOString().replace(".000Z", "Z");
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(`${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`)}</time>`;
}

/** "It works for 10 minutes." from the answer's own end time, or FS section 8's sentence when the page has none. */
function worksFor(expiresAt: Date | null, now: Date): string {
  return expiresAt !== null && expiresAt.getTime() > now.getTime()
    ? `It works for ${waitWords(expiresAt, now)}.`
    : "A code works for 10 minutes from when it was made.";
}

/** The fields every check form carries: this submit's own id and the attempt. */
function attemptFields(requestId: string, attempt: Attempt): string[] {
  return [
    hidden("requestId", requestId),
    hidden("attempt", attempt.attemptId),
    hidden("way", attempt.way),
    ...(attempt.link === null ? [] : [hidden("link", attempt.link)]),
  ];
}

/** The page that starts a sign-in: the portal's (type the mobile or email on file) or a signed link's own (no typing). */
export function startPage(
  config: WebConfig,
  form: { requestId: string; link: string | null },
  problem: Problem | null = null,
): RoutePage {
  const who =
    form.link === null
      ? [
          '<p><label for="account">Your mobile number or email on file</label><br>',
          '<input id="account" name="account" type="text" autocomplete="username" autocapitalize="none" maxlength="254" required></p>',
        ]
      : [
          hidden("link", form.link),
          p(
            "Sign in to open this page. A code goes only to the email or mobile on file for the page's own account.",
          ),
        ];
  const main = [
    "<h1>Sign in</h1>",
    ...problemLine(problem),
    p(
      `Owners, admins, staff and Rosie's team sign in the same way, with a code.${isStagingConfig(config) ? " So do testers on staging." : ""} There is no password.`,
    ),
    formTo(config, SIGN_IN_PATH),
    hidden("requestId", form.requestId),
    ...who,
    '<p><button name="way" value="email">Email me a code</button></p>',
    '<p><button name="way" value="text">Sign in with a text from my mobile</button></p>',
    "</form>",
    p(
      "By email, a code goes to the email on file and you type it here. By text, you send a short text from the mobile on file.",
    ),
    p(NEVER_ASKED),
  ].join("\n");
  return { title: "Sign in", main, forms: true, status: problem?.status ?? 200 };
}

/** The email way: the page names the way the code went and takes the code typed back. */
export function codePage(
  config: WebConfig,
  form: { requestId: string; attempt: Attempt; expiresAt: Date | null; now: Date },
  problem: Problem | null = null,
): RoutePage {
  const main = [
    "<h1>Type your code</h1>",
    ...problemLine(problem),
    p(
      `If an account matches what you typed, a code is on its way by email, to the email on file. ${worksFor(form.expiresAt, form.now)}`,
    ),
    formTo(config, SIGN_IN_CHECK_PATH),
    ...attemptFields(form.requestId, form.attempt),
    '<p><label for="code">Code</label><br>',
    '<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{4,12}" maxlength="12" required></p>',
    "<p><button>Sign in</button></p>",
    "</form>",
    p(FIVE_WRONG),
    p(NEVER_ASKED),
    startAgain(config, form.attempt.link),
  ].join("\n");
  return { title: "Type your code", main, forms: true, status: problem?.status ?? 200 };
}

/**
 * The text way: the page names the way and shows the ready text signInStart gave, for the person to send from the
 * mobile on file, then asks whether it was sent. The ready text holds the code, so it is shown here and nowhere else.
 */
export function textPage(
  config: WebConfig,
  form: {
    requestId: string;
    attempt: Attempt;
    readyText: string | null;
    textLink: string | null;
    expiresAt: Date | null;
    now: Date;
  },
): RoutePage {
  const main = [
    "<h1>Send this text</h1>",
    p("Your sign-in goes by text. From the mobile on file for the account, send Rosie these words:"),
    ...(form.readyText === null ? [] : [`<p><strong>${escapeHtml(form.readyText)}</strong></p>`]),
    // Only a link that opens Messages is ever placed in the page.
    ...(form.textLink?.startsWith("sms:") === true
      ? [`<p><a href="${escapeHtml(form.textLink)}">Open Messages with the text ready</a></p>`]
      : []),
    p(`${worksFor(form.expiresAt, form.now)} Send it only yourself, and only from that mobile.`),
    formTo(config, SIGN_IN_CHECK_PATH),
    ...attemptFields(form.requestId, form.attempt),
    "<p><button>I have sent it</button></p>",
    "</form>",
    startAgain(config, form.attempt.link),
  ].join("\n");
  return { title: "Send this text", main, forms: true };
}

/** The text way, asked again: the text has not come yet. The ready text is not shown a second time. */
export function waitingPage(
  config: WebConfig,
  form: { requestId: string; attempt: Attempt },
  problem: Problem | null = null,
): RoutePage {
  const main = [
    "<h1>Your text has not come yet</h1>",
    ...problemLine(problem),
    p("Send the text from the mobile on file for the account, then ask again here."),
    formTo(config, SIGN_IN_CHECK_PATH),
    ...attemptFields(form.requestId, form.attempt),
    "<p><button>I have sent it</button></p>",
    "</form>",
    startAgain(config, form.attempt.link),
  ].join("\n");
  return { title: "Your text has not come yet", main, forms: true, status: problem?.status ?? 200 };
}

/**
 * The pause: the page shows it and holds no form that checks a code, so nothing more is checked from here. `fiveWrong`
 * is signInCheck's pause (FS section 8); signInStart's may also be the day's codes used up, so it names no reason.
 */
export function pausedPage(
  config: WebConfig,
  pause: { until: Date | null; now: Date; link: string | null; fiveWrong: boolean },
): RoutePage {
  const runs = pause.until !== null && pause.until.getTime() > pause.now.getTime();
  const main = [
    "<h1>Sign-in is paused</h1>",
    ...(pause.fiveWrong ? [p(FIVE_WRONG)] : []),
    pause.until !== null && runs
      ? `<p>${escapeHtml(`You can try again in ${waitWords(pause.until, pause.now)}, at `)}${timeTag(pause.until)}.</p>`
      : p("You can try again when the pause ends."),
    p("Nothing more is checked until then."),
    startAgain(config, pause.link, "When the pause ends, start again"),
  ].join("\n");
  return { title: "Sign-in is paused", main };
}

/** After a right code: what the person is signed in as, the consoles that are theirs, and the way out. */
export function signedInPage(
  config: WebConfig,
  session: {
    as: readonly SignedInAs[];
    consoles: readonly ConsoleLink[];
    link: string | null;
    requestId: string;
  },
): RoutePage {
  const main = [
    "<h1>You are signed in</h1>",
    ...(session.as.length === 0
      ? []
      : [p(`Signed in as: ${session.as.map((as) => SIGNED_IN_AS_WORDS[as]).join(", ")}.`)]),
    ...(session.link === null
      ? []
      : [`<p><a href="${escapeHtml(linkUrl(config, session.link))}">Go back to your page</a></p>`]),
    ...(session.consoles.length === 0
      ? session.link === null
        ? [p("Nothing here is open to this account yet.")]
        : []
      : [
          "<ul>",
          ...session.consoles.map(
            (open) =>
              `<li><a href="${escapeHtml(`${config.basePath}${open.path}`)}">${escapeHtml(open.words)}</a></li>`,
          ),
          "</ul>",
        ]),
    ...signOutForm(config, session.requestId),
  ].join("\n");
  return { title: "You are signed in", main, forms: true };
}

/** The sign-out form, for the pages here and for any console: one button that posts to the sign-out page. */
export function signOutForm(config: WebConfig, requestId: string): string[] {
  return [
    formTo(config, SIGN_OUT_PATH),
    hidden("requestId", requestId),
    "<p><button>Sign out</button></p>",
    "</form>",
  ];
}

/** The sign-out page: the button alone. */
export function signOutPage(config: WebConfig, requestId: string, problem: Problem | null = null): RoutePage {
  const main = [
    "<h1>Sign out</h1>",
    ...problemLine(problem),
    p("This ends your session on this browser."),
    ...signOutForm(config, requestId),
  ].join("\n");
  return { title: "Sign out", main, forms: true, status: problem?.status ?? 200 };
}

/** A page with words and the way back to the sign-in form: a sign-in that ended without a session, or a sign-out. */
export function notePage(
  config: WebConfig,
  note: { title: string; lines: readonly string[]; link: string | null; again: string; status?: number },
): RoutePage {
  const main = [
    `<h1>${escapeHtml(note.title)}</h1>`,
    ...note.lines.map(p),
    startAgain(config, note.link, note.again),
  ].join("\n");
  return { title: note.title, main, status: note.status ?? 200 };
}
