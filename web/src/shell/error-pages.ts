// The shell's error pages (T-511; C-185): what a reader sees when no page is at the address (404), when the address
// does not take what was sent (405) and when a page could not be shown (500). Each is a whole page inside the frame
// (frame.ts), so it has the language, the skip link, the main landmark and the footer's privacy link like any other
// page (RULES 4.11, 4.3), and each shows the request's trace id as a reference the reader can pass on, so the request
// can be found in the logs.
//
// An error page says nothing about the address asked for, the request or what went wrong inside: the same words for
// every reader, with only the trace id differing, and that is always a UUID (trace.ts). No source gives these words;
// they are plain stand-ins.

import { escapeHtml, renderPage } from "./frame";

/** The statuses the shell has a page for. */
export type ErrorStatus = 404 | 405 | 500;

interface ErrorWords {
  readonly title: string;
  readonly lines: readonly string[];
}

/** Each error page's words. */
export const ERROR_WORDS: Readonly<Record<ErrorStatus, ErrorWords>> = {
  404: {
    title: "Page not found",
    lines: ["There is no page at this address.", "Check the address and try again."],
  },
  405: {
    title: "This address cannot do that",
    lines: ["This address does not take what was sent to it.", "Go back and try again."],
  },
  500: {
    title: "Something went wrong",
    lines: ["This page could not be shown.", "Try again in a moment."],
  },
};

/** The words before the trace id on every error page. */
export const REFERENCE_LABEL = "Reference";

/** One error page for the frame. */
export interface ErrorPage {
  status: ErrorStatus;
  /** BASE_PATH as basePathOf reads it. */
  basePath: string;
  /** The request's trace id (trace.ts traceIdOf: always a UUID). */
  traceId: string;
}

/** The error page for `status`, a whole HTML document showing the trace id. */
export function renderErrorPage(page: ErrorPage): string {
  const words = ERROR_WORDS[page.status];
  const main = [
    `<h1>${escapeHtml(words.title)}</h1>`,
    ...words.lines.map((line) => `<p>${escapeHtml(line)}</p>`),
    `<p>${escapeHtml(REFERENCE_LABEL)}: <code>${escapeHtml(page.traceId)}</code></p>`,
  ].join("\n");
  // No page's own path: an error page is never the footer link's current page.
  return renderPage({ basePath: page.basePath, path: "", title: words.title, main, noindex: true });
}
