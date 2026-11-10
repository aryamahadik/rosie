// The bundle's fixed lines (T-1146; C-089, the fixed lines' words; K-01 v1 `fixedLines`, the manifest's lists.fixedLines).
//
// Architecture section 07, "Fixed lines" (line 361): they "are added by code, match their source word for word in
// section 06's language, and sit outside the Shape and Length counts". On Rosie's first text to a handle about one
// business they are the opener and the privacy-notice link (RULES 1.11, 4.3), and on a number's texts until one is
// delivered the STOP, HELP and rates line (RULES 4.3). Q-30's default puts them on Rosie's first reply in a chat the
// person opened, the privacy link alone on the last line, as arch 12's links row (line 644) said for the old
// first-contact SMS. T-314's inserter (actions/src/finalize/fixed-lines) reads each line by id in the reader's language,
// else in English, and refuses a first text whole while the bundle has no privacyLink (lineNotInBundle) or holds it
// with no words (pendingJay: lineWaitsForJay).
//
// buildFixedLines() gives, in this order:
//   1. K-01 v1's accepted lines (contracts/bundle/fixtures/fixed-lines.json), each as it is, with its own source: the
//      lines every bundle has carried so far as the emitter's stand-in (emit/standins.ts). Their English optOutLine
//      must be msgtext.js's own line, or the list is refused.
//   2. optOutLine in Spanish: msgtext.js's WORDS.es stop, rates and help (line 32), joined by msgtext.js's own stopLine()
//      for a text that says none of them yet, as it joins the English line (T-314's handoff item 3).
//   3. privacyLink (T-314's PRIVACY_LINK_LINE). No source gives its words yet, so they are Q-30's default stand-in:
//      "Privacy notice: " and the address of rosfield.com's privacy notice, rosfield.com/privacy under the environment's
//      base path (wrangler.jsonc vars.BASE_PATH: "" in production, /test on staging, so rosfield.com/test/privacy
//      there). The line says it is Q-30's default for Jay to confirm before production. Its status is asWritten, never
//      pendingJay, which would refuse every first text.
// msgtext.js is loaded as it is (overlay/cjs-load.ts), as msgtext/script.ts loads it: none of its words is typed here.
//
// Not yet in every build: a shared-list.ts in this folder would have the emitter pack this list in place of K-01's
// stand-in, which moves pinned values of the emitter's own tests (emit/emit.test.ts: the stand-ins and lists.fixedLines;
// emit/cli.test.ts: the printed stand-ins), outside T-1146's card. Until a task adds it, bundles/v0/build.mjs packs this
// list into bundle v0.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertBundlePart } from "../emit/validate";
import { MSGTEXT_FILE } from "../msgtext/script";
import { makeCjsLoader } from "../overlay/cjs-load";

/** One fixed line as K-01 v1 writes it (bundle.v1.schema.json `$defs/fixedLine`). */
export interface FixedLine {
  id: string;
  /** The words, <business> the one placeholder; null while they wait for Jay (status pendingJay). */
  text: string | null;
  lang: string;
  status: "asWritten" | "pendingJay";
  use?: string;
  source: string;
}

/** K-01 v1's fixed lines (`$defs/fixedLines`). */
export interface FixedLines {
  lines: FixedLine[];
}

/** K-01 v1's STOP, HELP and rates line (fixed-lines.json; T-314's OPT_OUT_LINE). */
export const OPT_OUT_LINE = "optOutLine";

/** The privacy-notice link, alone on the last line of a first text (T-314's PRIVACY_LINK_LINE; Q-30). */
export const PRIVACY_LINK_LINE = "privacyLink";

/**
 * The privacy notice the link names: rosfield.com's, at rosfield.com/privacy (the lead's ruling for Q-30's default,
 * DL-330 and T-1146's card; T-314's stand-in words, actions/src/finalize/fixed-lines/test-support.ts). RULES 4.3: "Every
 * page and first text links to a plain privacy notice."
 */
export const PRIVACY_NOTICE = { label: "Privacy notice", host: "rosfield.com", path: "/privacy" } as const;

/** The environments wrangler.jsonc names, each with its own base path (ADR-008). */
export type Environment = "staging" | "production";

/** What the list depends on besides its sources: the base path of the environment the bundle is for. */
export interface FixedLinesOptions {
  /**
   * The environment's base path under rosfield.com (wrangler.jsonc env.<name>.vars.BASE_PATH): "" in production, "/test"
   * on staging. The privacy link's address sits under it.
   */
  basePath: string;
}

/** msgtext.js's opt-out line in English and in Spanish, and where the script writes the words and joins them. */
export interface MsgTextStopLines {
  /** stopLine() for an English text that says none of its parts yet. */
  en: string;
  /** stopLine() for a Spanish text (lang "es") that says none of its parts yet. */
  es: string;
  /** msgtext.js's lines, from 1: WORDS.en, WORDS.es and `function stopLine`. */
  enLine: number;
  esLine: number;
  joinLine: number;
}

/** A list, a base path or a source this module cannot build the fixed lines from. */
export class FixedLinesError extends Error {
  override name = "FixedLinesError";
}

const K01_FIXED_LINES = new URL("../../../contracts/bundle/fixtures/fixed-lines.json", import.meta.url);

/** The Worker's config, which sets each environment's base path (ADR-008: env.<name>.vars.BASE_PATH). */
export const WRANGLER_FILE = fileURLToPath(new URL("../../../wrangler.jsonc", import.meta.url));

/** A base path: "" or one or more /segments of lowercase letters, digits and hyphens (no closing slash). */
const BASE_PATH = /^(?:\/[a-z0-9][a-z0-9-]*)*$/;

/** K-01 v1's accepted fixed lines, as contracts/bundle/fixtures/fixed-lines.json writes them, a fresh copy each call. */
export function k01FixedLines(): FixedLine[] {
  const parsed = JSON.parse(readFileSync(K01_FIXED_LINES, "utf8")) as unknown;
  assertBundlePart(parsed, "contracts/bundle/fixtures/fixed-lines.json", "fixedLines");
  return (parsed as FixedLines).lines;
}

/** The one line of `source` that `pattern` matches, from 1; throws unless exactly one does. */
function lineOf(source: string, pattern: RegExp, what: string): number {
  const found = source.split("\n").flatMap((line, k) => (pattern.test(line) ? [k + 1] : []));
  const [line] = found;
  if (found.length !== 1 || line === undefined)
    throw new FixedLinesError(
      `${MSGTEXT_FILE}: expected one line with ${what}, found ${String(found.length)}`,
    );
  return line;
}

/** The part of msgtext.js this module calls (its exports, line 116). */
interface StopLineScript {
  /** The opt-out line a first text ends with (S13-02): STOP, then the rates and HELP parts unless the text says them. */
  stopLine: (elements: { lang: string }, text: string) => string;
}

/** msgtext.js's opt-out line in English and Spanish, as its own stopLine() joins them, with the lines that write them. */
export function readStopLines(): MsgTextStopLines {
  const source = readFileSync(MSGTEXT_FILE, "utf8");
  const script = makeCjsLoader()(MSGTEXT_FILE) as Partial<StopLineScript> | null;
  const stopLine = script?.stopLine;
  if (typeof stopLine !== "function") throw new FixedLinesError(`${MSGTEXT_FILE} does not export stopLine()`);
  return {
    en: stopLine({ lang: "en" }, ""),
    es: stopLine({ lang: "es" }, ""),
    enLine: lineOf(source, /\bWORDS = \{ en: \{/, "WORDS.en"),
    esLine: lineOf(source, /^\s*es: \{ reply: /, "WORDS.es"),
    joinLine: lineOf(source, /^\s*function stopLine\(/, "function stopLine"),
  };
}

/** Throws unless `basePath` is a base path: "" or /<segment>, as wrangler.jsonc's BASE_PATH writes one. */
function checkBasePath(basePath: string, where: string): void {
  if (!BASE_PATH.test(basePath))
    throw new FixedLinesError(
      `${where}: "${basePath}" is not a base path ("" or /<segment>, no closing slash)`,
    );
}

/** An environment's base path as `text`, wrangler.jsonc's JSON with comments, sets it: env.<environment>.vars.BASE_PATH. */
export function basePathIn(text: string, environment: Environment, file = "wrangler.jsonc"): string {
  // JSON with comments: whole-line // comments and trailing commas left out (wrangler.jsonc writes no other kind).
  const json = text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
  let config: unknown;
  try {
    config = JSON.parse(json);
  } catch (error) {
    throw new FixedLinesError(
      `${file} does not read as JSON with comments: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const env = (config as { env?: Record<string, { vars?: { BASE_PATH?: unknown } }> } | null)?.env;
  const basePath = env?.[environment]?.vars?.BASE_PATH;
  if (typeof basePath !== "string")
    throw new FixedLinesError(`${file}: env.${environment}.vars.BASE_PATH is not set`);
  checkBasePath(basePath, `${file} env.${environment}.vars.BASE_PATH`);
  return basePath;
}

/** An environment's base path, read from wrangler.jsonc (or `file`). */
export function readBasePath(environment: Environment, file: string = WRANGLER_FILE): string {
  return basePathIn(readFileSync(file, "utf8"), environment, file);
}

/** The privacy notice's address under `basePath`, as the line writes it: rosfield.com<basePath>/privacy. */
export function privacyNoticeAddress(basePath: string): string {
  checkBasePath(basePath, "the privacy notice's base path");
  return `${PRIVACY_NOTICE.host}${basePath}${PRIVACY_NOTICE.path}`;
}

/** The privacy-notice link (see the top of this file): Q-30's default stand-in, marked so, for the base path given. */
export function privacyLinkLine(basePath: string): FixedLine {
  const address = privacyNoticeAddress(basePath);
  return {
    id: PRIVACY_LINK_LINE,
    text: `${PRIVACY_NOTICE.label}: ${address}`,
    lang: "en",
    status: "asWritten",
    use: "Alone on the last line of Rosie's first text to a handle about one business, below the opt-out line, with the opener (Q-30's default; arch 12 line 644). Every page also carries the link (RULES 4.3).",
    source: `Q-30's default, for Jay to confirm before production: stand-in words naming rosfield.com's privacy notice at ${address}${basePath === "" ? "" : ` (the address under BASE_PATH ${basePath})`}; RULES 4.3 ("Every page and first text links to a plain privacy notice"), RULES 1.11; arch 07 line 361; arch 12 line 644`,
  };
}

/** optOutLine in Spanish: msgtext.js's own line for lang "es" (see the top of this file). */
export function spanishOptOutLine(stop: MsgTextStopLines): FixedLine {
  return {
    id: OPT_OUT_LINE,
    text: stop.es,
    lang: "es",
    status: "asWritten",
    use: "On Rosie's first reply in a chat the person opened, which is the first text that number gets (Q-30), when the reader's language is Spanish: the English optOutLine's place, in section 06's language (arch 07 line 361).",
    source: `msgtext.js line ${String(stop.esLine)} (WORDS.es: stop, rates and help, joined by stopLine, line ${String(stop.joinLine)}); S13-02; S13-32; RULES 4.3; Q-30`,
  };
}

/**
 * The bundle's fixed lines from `base` (K-01 v1's accepted lines) and msgtext.js's opt-out lines (`stop`): `base` as it
 * is, then optOutLine in Spanish, then the privacy link under `options.basePath`, each id once per language, checked
 * against K-01 v1's `fixedLines`. Throws FixedLinesError when `base`'s English optOutLine is not msgtext.js's line, or
 * `base` already holds either added line.
 */
export function composeFixedLines(
  base: readonly FixedLine[],
  stop: MsgTextStopLines,
  options: FixedLinesOptions,
): FixedLines {
  const english = base.filter((line) => line.id === OPT_OUT_LINE && line.lang === "en");
  if (english.length !== 1 || english[0]?.text !== stop.en)
    throw new FixedLinesError(
      `K-01 v1's ${OPT_OUT_LINE} in English is not msgtext.js's line (line ${String(stop.enLine)}, joined by stopLine, line ${String(stop.joinLine)})`,
    );
  const added = [spanishOptOutLine(stop), privacyLinkLine(options.basePath)];
  for (const line of added)
    if (base.some((held) => held.id === line.id && held.lang === line.lang))
      throw new FixedLinesError(`the base list already holds ${line.id} in ${line.lang}`);
  const lines = [...base.map((line) => structuredClone(line)), ...added];
  const seen = new Set<string>();
  for (const line of lines) {
    const key = `${line.id} ${line.lang}`;
    if (seen.has(key)) throw new FixedLinesError(`${line.id} in ${line.lang} is listed twice`);
    seen.add(key);
  }
  const list: FixedLines = { lines };
  assertBundlePart(list, "the fixed lines", "fixedLines");
  return list;
}

/** The bundle's fixed lines for an environment's base path (see the top of this file), a fresh list each call. */
export function buildFixedLines(options: FixedLinesOptions): FixedLines {
  return composeFixedLines(k01FixedLines(), readStopLines(), options);
}
