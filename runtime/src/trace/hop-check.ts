// The hop check (T-260; C-044, C-046, C-124; K-08 v1; build prompt section 10, D-017: "the trace shows every hop once, in
// order"). It reads spans from log lines (one JSON line each, ADR-009) and judges one trace against the hops a K-08 trace
// names: each hop once, in K-08's order, under one trace id and one bundle id. A test or a replay reader uses it; the
// Worker does not (nothing here reads a file or the network, so it runs in the Workers runtime and under Node alike).
//
//   - Order is read from when each hop started (`at`, its earliest span): no hop may start before a hop the expected list
//     puts before it. Instants that are equal pass, since the Workers clock moves only between I/O steps. The spans' `seq`
//     is judged on its own (`seqProblems`): every writer that opens its own trace context numbers its spans from 1.
//   - What the merged runtime does not write yet is named by the caller, never dropped in silence: a `notWritten` hop leaves
//     the expected list, and one that shows up anyway is `unexpected`, so a writer that lands makes the caller take the hop
//     off its list. Spans the caller knows are written beside the expected ones are named by `extra` and set aside, and the
//     check hands them back, so the caller can hold its list of known extras to what was really written.
//   - `leaks` finds a raw phone number or one of the caller's secrets (a text's words, a number in another form) in any
//     string of a span. Its problems name the span by hop, seq and trace, and a secret by its place in the list, never the
//     secret itself.

import type { BundleId, Hop, Span, Trace } from "./types";

/** The fields ADR-009 puts beside a span's own on its log line. */
const LOG_FIELDS = new Set(["level", "msg", "environment", "version"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The spans among log lines, in the order they were written: each line whose `msg` is "span" (a JSON string, or an object
 * a log reader already parsed), without ADR-009's line fields. Any other line is passed over.
 */
export function spansOfLogLines(lines: Iterable<unknown>): Span[] {
  const spans: Span[] = [];
  for (const line of lines) {
    let value: unknown = line;
    if (typeof line === "string") {
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
    }
    if (!isRecord(value) || value.msg !== "span") continue;
    const span = Object.fromEntries(Object.entries(value).filter(([key]) => !LOG_FIELDS.has(key)));
    spans.push(span as unknown as Span);
  }
  return spans;
}

/** The spans of one trace id, by when each started; spans that started at one instant keep the order they were written in. */
export function spansOfTrace(spans: readonly Span[], traceId: string): Span[] {
  return spans
    .map((span, written) => ({ span, written }))
    .filter(({ span }) => span.trace_id === traceId)
    .sort((a, b) => Date.parse(a.span.at) - Date.parse(b.span.at) || a.written - b.written)
    .map(({ span }) => span);
}

/** A K-08 trace document's hops, in seq order. */
export function hopsOfTrace(trace: Pick<Trace, "spans">): Hop[] {
  return [...trace.spans].sort((a, b) => a.seq - b.seq).map((span) => span.hop);
}

export type HopProblemKind = "traceId" | "bundleId" | "missing" | "repeated" | "unexpected" | "outOfOrder";

export interface HopProblem {
  readonly kind: HopProblemKind;
  /** The hop the problem is about, by K-08's name. */
  readonly hop: Hop;
  readonly message: string;
}

export interface HopCheckOptions {
  /** The trace id every span must carry: one id from the webhook to the delivery receipt. */
  readonly traceId: string;
  /** The hops the trace must show once each, in this order (a K-08 trace's: `hopsOfTrace`). */
  readonly expected: readonly Hop[];
  /** Expected hops the merged runtime has no writer for yet: left out of the check, and unexpected if they show up. */
  readonly notWritten?: readonly Hop[];
  /** Spans known to be written beside the expected ones: set aside from the count and the order, and handed back. */
  readonly extra?: (span: Span) => boolean;
}

export interface HopCheck {
  /** True when no problem was found. */
  readonly ok: boolean;
  /** The expected hops less the ones not written yet: what was judged. */
  readonly judged: readonly Hop[];
  /** The hops of the spans judged (the extra ones set aside), in the order the spans were given. */
  readonly hops: readonly Hop[];
  /** The spans `extra` set aside, in the order given. */
  readonly extra: readonly Span[];
  readonly problems: readonly HopProblem[];
}

const sameBundle = (a: BundleId, b: BundleId): boolean => a.hash === b.hash && a.build === b.build;

const placeOf = (span: Span): string => `hop ${span.hop} (seq ${String(span.seq)})`;

/**
 * Judges `spans` (one trace's, as `spansOfTrace` gives them) against the expected hops: every span under the trace id and
 * the first span's bundle id; each judged hop once; no other hop; and no hop starting before one the list puts first.
 */
export function checkHops(spans: readonly Span[], options: HopCheckOptions): HopCheck {
  const notWritten = new Set(options.notWritten ?? []);
  const judged = options.expected.filter((hop) => !notWritten.has(hop));
  const isExtra = options.extra ?? (() => false);
  const extra = spans.filter((span) => isExtra(span));
  const own = spans.filter((span) => !isExtra(span));
  const problems: HopProblem[] = [];

  const bundle = spans[0]?.bundle_id;
  for (const span of spans) {
    if (span.trace_id !== options.traceId) {
      problems.push({
        kind: "traceId",
        hop: span.hop,
        message: `${placeOf(span)} is under another trace id: one trace id from the webhook to the delivery receipt`,
      });
    }
    if (bundle !== undefined && !sameBundle(span.bundle_id, bundle)) {
      problems.push({
        kind: "bundleId",
        hop: span.hop,
        message: `${placeOf(span)} names bundle build ${String(span.bundle_id.build)} ${span.bundle_id.hash.slice(0, 12)}, not the trace's: one bundle id per trace`,
      });
    }
  }

  const startsOf = new Map<Hop, number[]>();
  for (const span of own) {
    const starts = startsOf.get(span.hop) ?? [];
    starts.push(Date.parse(span.at));
    startsOf.set(span.hop, starts);
  }
  for (const hop of judged) {
    const runs = startsOf.get(hop)?.length ?? 0;
    if (runs === 0)
      problems.push({ kind: "missing", hop, message: `hop ${hop} is missing: every hop runs once` });
    else if (runs > 1) {
      problems.push({
        kind: "repeated",
        hop,
        message: `hop ${hop} runs ${String(runs)} times: every hop runs once`,
      });
    }
  }
  for (const hop of startsOf.keys()) {
    if (judged.includes(hop)) continue;
    problems.push({
      kind: "unexpected",
      hop,
      message: notWritten.has(hop)
        ? `hop ${hop} is written now: take it off the hops not written yet`
        : `hop ${hop} is not one of this trace's hops`,
    });
  }

  let latest: { hop: Hop; at: number } | null = null;
  for (const hop of judged) {
    const starts = startsOf.get(hop);
    if (starts === undefined) continue;
    const at = Math.min(...starts);
    if (latest !== null && at < latest.at) {
      problems.push({
        kind: "outOfOrder",
        hop,
        message: `hop ${hop} starts before hop ${latest.hop}, which the turn order puts first`,
      });
    }
    if (latest === null || at >= latest.at) latest = { hop, at };
  }

  return {
    ok: problems.length === 0,
    judged,
    hops: own.map((span) => span.hop),
    extra,
    problems,
  };
}

/**
 * Every way the spans' seq is not one run 1, 2, 3 ... (K-08 v1 README: a trace is read by filtering on trace_id and
 * ordering by seq): a seq taken twice, or a place missing from the run.
 */
export function seqProblems(spans: readonly Span[]): string[] {
  const problems: string[] = [];
  const taken = new Map<number, Hop>();
  for (const span of spans) {
    const other = taken.get(span.seq);
    if (other === undefined) taken.set(span.seq, span.hop);
    else problems.push(`seq ${String(span.seq)} is taken twice, by hop ${other} and hop ${span.hop}`);
  }
  [...taken.keys()]
    .sort((a, b) => a - b)
    .forEach((seq, place) => {
      if (seq !== place + 1) problems.push(`seq ${String(seq)} stands where ${String(place + 1)} comes next`);
    });
  return problems;
}

/** A raw phone number: a "+" and 7 to 15 digits (E.164 and the shorter forms a typo gives). */
const RAW_NUMBER = /\+[0-9]{7,15}/u;

/** Every string a value holds, at any depth. */
function stringsOf(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value as unknown[]) stringsOf(item, into);
  else if (isRecord(value)) for (const item of Object.values(value)) stringsOf(item, into);
  return into;
}

/**
 * Every span that holds a raw phone number, or one of `secrets` (each line of it, ignoring case: a text's words, a
 * number written another way), in any of its strings. Never the raw number or words (K-08 v1 README).
 */
export function leaks(spans: readonly Span[], secrets: readonly string[] = []): string[] {
  const lines = secrets.map((secret) =>
    secret
      .split("\n")
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length >= 4),
  );
  const problems: string[] = [];
  for (const span of spans) {
    const strings = stringsOf(span).map((text) => text.toLowerCase());
    const where = `${placeOf(span)} of trace ${span.trace_id}`;
    if (strings.some((text) => RAW_NUMBER.test(text))) problems.push(`${where} holds a raw phone number`);
    lines.forEach((parts, index) => {
      if (parts.some((part) => strings.some((text) => text.includes(part)))) {
        problems.push(`${where} holds secret ${String(index + 1)}`);
      }
    });
  }
  return problems;
}
