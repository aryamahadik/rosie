// The small pieces of HTML the page answer kit builds its forms and pages from (T-514; C-185). Every text placed here
// is escaped with escapeHtml (shell/frame.ts), and nothing here runs a script: a page is a form posted to this site or
// a link, as every page of the web app is (README, "Sign-in"; RULES 4.11: WCAG 2.1 AA).

import { instantOf } from "../../auth/cookies";
import type { WebConfig } from "../../shell/config";
import { escapeHtml } from "../../shell/frame";

/** One paragraph of plain words. */
export const p = (words: string): string => `<p>${escapeHtml(words)}</p>`;

/**
 * One paragraph a screen reader announces as soon as the page shows it (role alert): what went wrong, said first. A
 * page with no script moves no focus, so the announcement and the page's title carry it.
 */
export const alertLine = (words: string): string => `<p role="alert">${escapeHtml(words)}</p>`;

/** A hidden field of a form: a value the page carries to its next POST, never a control. */
export const hidden = (name: string, value: string): string =>
  `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;

/** A form that posts to `path` under BASE_PATH on this site (the shell's POST guards then run first). */
export const formTo = (config: WebConfig, path: string): string =>
  `<form method="post" action="${escapeHtml(`${config.basePath}${path}`)}">`;

/** A link to `path` under BASE_PATH on this site: a GET, which sends no call of its own. */
export const linkTo = (config: WebConfig, path: string, words: string): string =>
  `<p><a href="${escapeHtml(`${config.basePath}${path}`)}">${escapeHtml(words)}</a></p>`;

/**
 * An instant as a page shows it: its date and time in UTC, since no script can read the reader's own zone (as
 * link/pages.ts and auth/pages.ts show one), or null when `utc` is not a K-21 `utc`.
 */
export function timeTag(utc: string): string | null {
  const at = instantOf(utc);
  if (at === null) return null;
  const iso = at.toISOString().replace(".000Z", "Z");
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(`${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`)}</time>`;
}

/**
 * How many characters `text` holds as a K-21 schema's maxLength counts them: Unicode code points (JSON Schema 2020-12;
 * Ajv's ucs2length), so a name of 200 accented letters or emoji is still 200.
 */
export function characterCount(text: string): number {
  return Array.from(text).length;
}

/** Words that may hold line breaks, escaped, each break kept as one: a read-back's exact words keep their lines. */
export function linesOf(words: string): string {
  return words
    .split(/\r\n|\r|\n/)
    .map((line) => escapeHtml(line))
    .join("<br>");
}
