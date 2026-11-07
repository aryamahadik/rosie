// Reading a decision's rule lines (T-144): the Means, Never, Safe default and Clock lines the master writes in a step's
// `more`, and the first sentence of a step's `does`. Pure string work: nothing here knows a flow, a trade or a path.
//
// The master's conventions (SPEC-master 4 and 5k, counted over master-A.json and master-B.json):
//   - `Means '<branch label>': <what the branch means>.`  One per line, or several on one line (A3-51, A4-82).
//     Some labels are shortened in the line (`Means 'Passed': ...` for the branch `Passed: it goes ahead`), some lines
//     name two labels (`Means 'In Spanish' or 'Another language': ...`), some number them (`Means 1: keep it.`).
//   - `Never: ...` or `Never ...`: every line that starts with Never, word for word.
//   - `Safe default: <what the step does when nobody answers>.`
//   - `Clock: ...`: the step's own deadline (13 of 210 decisions).

/** The branch label a Means line names, and the definition it gives. */
export interface MeansEntry {
  label: string;
  /** What follows the line's colon, up to the next Means in the same line. */
  text: string;
}

/** A step that holds two Safe default lines or two Clock lines: a card has one of each. */
export class LineError extends Error {
  override name = "LineError";
}

const WORD_ABBREVIATIONS = /(?:\b(?:e\.g|i\.e|etc|vs|approx|a\.m|p\.m|No|Mr|Mrs|Ms|Dr|St)\.)$/;

/** Is a quotation still open at the end of this text (`the page asks 'Sorry to hear that.`)? An apostrophe is not a quote. */
function insideQuote(text: string): boolean {
  const opening = text.match(/(?:^|[\s(])'(?=\S)/g)?.length ?? 0;
  const closing = text.match(/(?<=\S)'(?=$|[\s.,;:!?)])/g)?.length ?? 0;
  return opening > closing;
}

/**
 * The first sentence of a text: up to the first full stop, question mark or exclamation mark that is followed by a space
 * and then a capital letter, a digit, a quote or a slot, or that ends the text. A stop after a known abbreviation does
 * not end it. A text with no such stop is its own first sentence.
 */
export function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const stops = /[.!?]+["')\]]*(?=\s|$)/g;
  let found: RegExpExecArray | null;
  while ((found = stops.exec(clean)) !== null) {
    const end = found.index + found[0].length;
    const before = clean.slice(0, end);
    const after = clean.slice(end).trimStart();
    if (WORD_ABBREVIATIONS.test(before) || insideQuote(before)) continue;
    if (after === "" || /^["'([{]?[A-Z0-9{]/.test(after)) return before;
  }
  return clean;
}

/** The lines of `more` that start with the word, in order. */
function startingWith(more: readonly string[], word: RegExp): string[] {
  return more.filter((line) => word.test(line));
}

/** Every Never line, word for word (the step's `more` lines that start with Never: `Never: ...` and `Never a ...`). */
export function neverLines(more: readonly string[]): string[] {
  return startingWith(more, /^Never\b/);
}

/**
 * The step's Safe default: the words after the first colon of its `Safe default` line (`Safe default: nothing changes.`
 * gives `nothing changes.`), or null when it has none. Two such lines are refused.
 */
export function safeDefaultOf(more: readonly string[], id: string): string | null {
  const lines = startingWith(more, /^Safe default\b/);
  if (lines.length > 1)
    throw new LineError(`${id}: ${String(lines.length)} Safe default lines (a card has one)`);
  const line = lines[0];
  if (line === undefined) return null;
  const colon = line.indexOf(":");
  const text = (colon === -1 ? line.replace(/^Safe default\b[,\s]*/, "") : line.slice(colon + 1)).trim();
  return text === "" ? null : text;
}

/** The step's Clock line, word for word (`Clock: Sam answers in 30 minutes; ...`), or null. Two such lines are refused. */
export function clockLineOf(more: readonly string[], id: string): string | null {
  const lines = startingWith(more, /^Clock\b/);
  if (lines.length > 1) throw new LineError(`${id}: ${String(lines.length)} Clock lines (a card has one)`);
  return lines[0] ?? null;
}

/** Does any line of `more` start with Means? (A decision with none is one of the 48 whose choices take a stand-in.) */
export function hasMeansLine(more: readonly string[]): boolean {
  return more.some((line) => /^Means\b/.test(line));
}

/** The starts of the Means segments of a line: at its start, or after a sentence end. */
function segmentsOf(line: string): string[] {
  const starts: number[] = [];
  const header = /(?:^|(?<=[.!?]['")\]]?\s))Means\s/g;
  let found: RegExpExecArray | null;
  while ((found = header.exec(line)) !== null) starts.push(found.index);
  return starts.map((start, k) => line.slice(start, starts[k + 1] ?? line.length).trim());
}

/** A quoted key and what follows it: `'One isn't on the list yet': a service ...` (labels hold apostrophes and colons). */
const KEY = /^'(.+?)'(?=\s*(?:\(|:|\s+or\s+'|$))/;

/** Which branch does a quoted key name? The exact label; else the one label it shortens (`Passed` for `Passed: it goes ahead`). */
function branchOfKey(key: string, labels: readonly string[]): string | null {
  const exact = labels.find((label) => label === key);
  if (exact !== undefined) return exact;
  const loose = labels.filter(
    (label) =>
      label.replace(/^\d+\s+/, "") === key || label.startsWith(`${key}:`) || label.endsWith(` ${key}`),
  );
  return loose.length === 1 ? (loose[0] ?? null) : null;
}

/** Which branch does `Means 3: ...` name? The one label that starts with 3 and a space (a numbered button). */
function branchOfNumber(n: string, labels: readonly string[]): string | null {
  const hits = labels.filter((label) => label.startsWith(`${n} `) || label.startsWith(`${n}:`));
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/**
 * The Means lines of a decision, matched to its branches: for each branch label the Means text the master gives it, in the
 * order the lines come. A segment that names a branch gives it the words after its colon (a parenthesis before the colon,
 * such as `(checks on only)`, is left out: the branch's own gate says it). A branch no segment names has no entry; the
 * first segment that names a branch wins. Segments that name no branch of this decision (`Means each case by what
 * happened...`, `Means in time: ...`) are left unread.
 */
export function meansOf(more: readonly string[], labels: readonly string[]): MeansEntry[] {
  const out: MeansEntry[] = [];
  const taken = new Set<string>();
  for (const line of more) {
    for (const segment of segmentsOf(line)) {
      let rest = segment.replace(/^Means\s+/, "");
      const named: string[] = [];
      for (;;) {
        const key = KEY.exec(rest);
        if (key === null) break;
        const label = branchOfKey(key[1] ?? "", labels);
        if (label !== null) named.push(label);
        rest = rest.slice(key[0].length).replace(/^\s+or\s+/, "");
      }
      let body: string | null = null;
      if (named.length > 0) {
        const colon = /^\s*(?:\([^)]*\))?\s*:\s*([\s\S]*)$/.exec(rest);
        body = colon === null ? null : (colon[1] ?? "").trim();
      } else {
        const number = /^(\d+):\s*([\s\S]*)$/.exec(rest);
        const label = number === null ? null : branchOfNumber(number[1] ?? "", labels);
        if (number !== null && label !== null) {
          named.push(label);
          body = (number[2] ?? "").trim();
        }
      }
      if (body === null || body === "") continue;
      for (const label of named) {
        if (taken.has(label)) continue;
        taken.add(label);
        out.push({ label, text: body });
      }
    }
  }
  return out;
}
