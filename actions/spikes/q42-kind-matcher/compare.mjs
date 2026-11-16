// The spike's comparison (T-631; Q-42): every plain-text candidate (matchers.mjs) on every sample (samples.mjs) over
// the 243 kinds (catalog.mjs), scored three ways:
//   right   K-09 matchKinds' outcome is the one the step's words make right: listed with the one kind; "which" with
//           both of two kinds; none (new_work or not_booked) for words that fit no kind
//   found   every kind the words fit is among the outcome's kinds (listed or "which"); for words that fit no kind, none
//   top 3   every kind the words fit is among the three closest: S1-02's pick-list ("Sam picks. A pick-list helps")
//
//   node actions/spikes/q42-kind-matcher/compare.mjs     prints the tables FINDINGS.md holds, then the cost measured
//
// The hit-rate tables are deterministic (q42-kind-matcher.test.mjs holds FINDINGS.md to them); the cost is measured on
// the machine that runs it.

import { pathToFileURL } from "node:url";
import { loadCatalog } from "./catalog.mjs";
import { buildTable, CANDIDATES, decide, rank, RATIO, tableBytes } from "./matchers.mjs";
import { GROUPS, SAMPLES } from "./samples.mjs";

/** The ratios the sensitivity table tries for "which?" (matchers.mjs RATIO is the one in force). */
export const RATIOS = [0.6, 0.7, 0.8, 0.9];

/** One sample's result under one candidate. */
export function judge(sample, ranked, options) {
  const decision = decide(ranked, options);
  const closest = ranked.slice(0, 3).map((kind) => kind.id);
  const { fits } = sample;
  const has = (ids, id) => ids.includes(id);
  let right;
  if (fits.length === 0) right = decision.outcome === "none";
  else if (fits.length === 1) right = decision.outcome === "listed" && decision.kinds[0] === fits[0];
  else right = decision.outcome === "which" && fits.every((id) => has(decision.kinds, id));
  const found = fits.length === 0 ? decision.outcome === "none" : fits.every((id) => has(decision.kinds, id));
  const top3 = fits.length === 0 ? null : fits.every((id) => has(closest, id));
  // The lowest place among the kinds the words fit (1 is the closest); null when one of them is not ranked at all.
  const places = fits.map((id) => ranked.findIndex((kind) => kind.id === id) + 1);
  const reach = fits.length === 0 || places.includes(0) ? null : Math.max(...places);
  return { ...decision, closest, right, found, top3, reach };
}

/** Every candidate's table over the catalog, and each sample's result. */
export function compare(catalog = loadCatalog(), options = {}) {
  const results = {};
  for (const [key, candidate] of Object.entries(CANDIDATES)) {
    const table = buildTable(catalog, candidate.fields);
    results[key] = SAMPLES.map((sample) => judge(sample, rank(table, sample.words), options));
  }
  return results;
}

const share = (hits, total) => (total === 0 ? "-" : `${String(hits)}/${String(total)}`);

/** The rows of the hit-rate table: each group, the words that fit two kinds (any group) and all. */
export function hitRows(results) {
  const slices = [
    ...GROUPS.map((group) => [group, (sample) => sample.group === group]),
    ["two kinds", (sample) => sample.fits.length === 2],
    ["all", () => true],
  ];
  return slices.map(([label, keep]) => {
    const picked = SAMPLES.map((sample, index) => [sample, index]).filter(([sample]) => keep(sample));
    const cells = [label, String(picked.length)];
    for (const key of Object.keys(CANDIDATES)) {
      const of = picked.map(([, index]) => results[key][index]);
      const ranked = of.filter((result) => result.top3 !== null);
      cells.push(
        share(of.filter((result) => result.right).length, of.length),
        share(of.filter((result) => result.found).length, of.length),
        share(ranked.filter((result) => result.top3).length, ranked.length),
      );
    }
    return cells;
  });
}

const outcomeText = (result) =>
  result.outcome === "none" ? "none" : `${result.outcome} ${result.kinds.join(", ")}`;

/** One row per sample: its words, step, the kinds it fits, and each candidate's outcome (a mark when right). */
export function sampleRows(results) {
  return SAMPLES.map((sample, index) => [
    sample.words,
    sample.source,
    sample.fits.length === 0 ? "none" : sample.fits.join(", "),
    ...Object.keys(CANDIDATES).map((key) => {
      const result = results[key][index];
      return `${result.right ? "✓ " : ""}${outcomeText(result)}`;
    }),
  ]);
}

/** The places a shortlist would take (top k), for words that fit a kind: how often every kind they fit is inside. */
export const SHORTLISTS = [1, 2, 3, 5, 10];

/** Per candidate and group of words that fit a kind: the share whose every kind is inside the top k, for each k. */
export function shortlistRows(results) {
  const slices = [
    ["owners (S1-02, S1-02 trades)", (sample) => sample.group.startsWith("S1-02")],
    ["customers (A4-03, B4-04, cast)", (sample) => !sample.group.startsWith("S1-02")],
  ];
  const rows = [];
  for (const key of Object.keys(CANDIDATES)) {
    for (const [label, keep] of slices) {
      const of = SAMPLES.map((sample, index) => [sample, results[key][index]])
        .filter(([sample]) => sample.fits.length > 0 && keep(sample))
        .map(([, result]) => result);
      rows.push([
        `${key} · ${label}`,
        String(of.length),
        ...SHORTLISTS.map((k) =>
          share(of.filter((result) => result.reach !== null && result.reach <= k).length, of.length),
        ),
      ]);
    }
  }
  return rows;
}

/** "right" over all samples for each ratio tried, per candidate (the floor kept). */
export function ratioRows(catalog = loadCatalog()) {
  const byRatio = RATIOS.map((ratio) => compare(catalog, { ratio }));
  return Object.keys(CANDIDATES).map((key) => [
    key,
    ...byRatio.map((results) => share(results[key].filter((result) => result.right).length, SAMPLES.length)),
  ]);
}

/** A markdown table, one line per row, each column padded to its widest cell (as Prettier lays a table out). */
export function markdownTable(header, rows) {
  const widths = header.map((cell, column) =>
    Math.max(3, cell.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells) => `| ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}

export const HIT_HEADER = [
  "Sample words",
  "n",
  ...Object.keys(CANDIDATES).flatMap((key) => [`${key} right`, `${key} found`, `${key} top 3`]),
];
export const SAMPLE_HEADER = [
  "Words",
  "Step",
  "Fits",
  ...Object.keys(CANDIDATES).map((key) => `${key} outcome`),
];
export const RATIO_HEADER = ["Candidate", ...RATIOS.map((ratio) => `right at ${String(ratio)}`)];
export const SHORTLIST_HEADER = ["Candidate · words", "n", ...SHORTLISTS.map((k) => `top ${String(k)}`)];

/**
 * The catalog as a model read would carry it (candidate C, not run): one "id · name · style" line per kind, the
 * K-24 columns the matcher reads. Its length in characters is exact; its tokens are only estimated (FINDINGS.md).
 */
export function catalogLines(catalog = loadCatalog()) {
  return catalog.map((kind) => `${kind.id} · ${kind.name} · ${kind.style}`).join("\n");
}

/** The median and 95th percentile (nearest rank) of a list of numbers. */
function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  return { p50: at(50), p95: at(95) };
}

/** Each candidate's cost on this machine: building its table, the table's size, and one match. */
export function measureCost(catalog = loadCatalog(), rounds = 200) {
  return Object.entries(CANDIDATES).map(([key, candidate]) => {
    const builds = [];
    let table;
    for (let index = 0; index < 5; index += 1) {
      const start = process.hrtime.bigint();
      table = buildTable(catalog, candidate.fields);
      builds.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    const matches = [];
    for (let round = 0; round < rounds; round += 1) {
      for (const sample of SAMPLES) {
        const start = process.hrtime.bigint();
        decide(rank(table, sample.words));
        matches.push(Number(process.hrtime.bigint() - start) / 1e3);
      }
    }
    const build = percentiles(builds);
    const match = percentiles(matches);
    return {
      key,
      buildMs: build.p50,
      words: table.postings.size,
      bytes: tableBytes(table),
      matchP50Us: match.p50,
      matchP95Us: match.p95,
      matches: matches.length,
    };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const catalog = loadCatalog();
  const results = compare(catalog);
  console.log(
    `Kinds: ${String(catalog.length)}; samples: ${String(SAMPLES.length)}; ratio ${String(RATIO)}\n`,
  );
  console.log(markdownTable(HIT_HEADER, hitRows(results)));
  console.log("");
  console.log(markdownTable(SAMPLE_HEADER, sampleRows(results)));
  console.log("");
  console.log(markdownTable(SHORTLIST_HEADER, shortlistRows(results)));
  console.log("");
  console.log(markdownTable(RATIO_HEADER, ratioRows(catalog)));
  console.log("");
  console.log(
    `The catalog as a model read would carry it: ${String(catalogLines(catalog).length)} characters`,
  );
  for (const cost of measureCost(catalog)) {
    console.log(
      `${cost.key}: build ${cost.buildMs.toFixed(1)} ms; ${String(cost.words)} words, ${String(cost.bytes)} B as JSON; ` +
        `match p50 ${cost.matchP50Us.toFixed(1)} µs, p95 ${cost.matchP95Us.toFixed(1)} µs (${String(cost.matches)} matches)`,
    );
  }
}
