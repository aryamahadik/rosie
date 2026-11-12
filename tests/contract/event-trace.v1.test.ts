// Contract test for K-08, the event log and trace format (T-087; ops/plan/02-contracts.md K-08 "Contract test" and
// section 2 item 12; contracts/event-trace/README.md "Producers and consumers (02-contracts K-08)", "Fixtures" and
// section "v1.1").
//
// This is the fixture part. The contract test has two parts: this one, which reads only the committed schemas, the
// README and the fixtures, and one part per producer or consumer side, added later by a QA side task that depends on
// this task and on that side's build task. SIDE_CHECKS (at the end) is the list where each side is added.
//
// K-08 is frozen at v1 (T-017) and v1.1 (T-1077). One fixtures/index.json lists both versions' fixtures, each entry
// naming its version. This file holds both, as DL-124 settled for K-06 (so the README's separately named
// event-trace.v1.1 test is covered here): every entry is checked against the schema its own `version` names
// (event-trace.<version>.schema.json, at its $defs entry `def`), and entries are selected by version and by what they
// state, never by a pinned list or count (DL-124, DL-125), so a later minor version's fixtures join every generic check
// when they land. The mends of part 2 are written for the refused fixtures of the versions frozen when this part was
// written (v1 and v1.1); a later version's mends join MENDS with its QA task.
//
// What this part proves:
//   1. every fixture in contracts/event-trace/fixtures/index.json is checked against the schema its version names (the
//      T-003 harness, and again here): accepted ones are accepted, refused ones are refused, none is left out, and the
//      number checked is the number of entries; an accepted fixture is accepted by every later minor version too (a
//      minor version only adds);
//   2. each refusal is tied to its reason (DL-124's mend-then-accept proof): each refused fixture is refused, the
//      schema's errors name the one field the README names, and its copy with that one field put right (README
//      "Fixtures": the handle id for the number, the words dropped, the bundle id added, open_questions for event_log;
//      v1.1: the accepted row it names, its one fault removed) is accepted, and is that accepted row where one is named;
//   3. the schema is not vacuous: removing any one required field, at any depth, from a copy of an accepted fixture
//      makes the copy refused, and so does one field the schema does not know (the required fields are read from the
//      schemas' own `required` lists, along the branch of each anyOf, oneOf, if and dependentSchemas the fixture takes);
//   4. what the schema leaves to the test (README "Producers and consumers", its contract test line; section "v1.1"),
//      each also run on a damaged copy the schema still accepts, to show that it fires: the skeleton trace's hops appear
//      once each, in D-017's order; no span carries a raw number or text; a trace's spans run seq 1, 2, 3 … with `at`
//      never going back, each on its trace's trace id, bundle id, turn and job; a joined trace's batch span names the
//      turn whose trace lists it; a commit's rows share one turn or job and one trace; a kind's subject matches its
//      table_name (the README's kinds tables); replyTime.ms is the difference of its two instants, which its turn's
//      traces give; each model call's cost follows from its tokens and the price list the README gives the fixtures;
//      no person's words, phone number or email address in a plain value at any depth; an export row is the stored row
//      unchanged; an invariant run names each breach's trace; v1.1: the columns each added kind's values name (with the
//      review item rows no fixture shows, which the README has this test build) and nothing that never appears inside
//      sealed bytes.
//   What needs a producer or consumer side is on SIDE_CHECKS, not checked here: the spans and rows each hop and commit
//   writes, and each consumer reading them and refusing every invalid one.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { CONTRACTS_ROOT, checkContractFixtures, formatErrors, type FixtureEntry } from "./_harness";

// ---------------------------------------------------------------------------------------------------------------
// The contract's files

const EVENT_TRACE_DIR = path.join(CONTRACTS_ROOT, "event-trace");
const FIXTURES_DIR = path.join(EVENT_TRACE_DIR, "fixtures");
/** Every schema's $id is this base plus its path inside contracts/ (ADR-005; contracts/scripts/lib.mjs). */
const ID_BASE = "https://rosie.invalid/contracts/";

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** A value a file must hold; a miss is a broken test, never a refusal. */
function must<T>(value: T | null | undefined, what = "a value this test reads"): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const index = readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: FixtureEntry[] };
const entries = index.fixtures;
const versions = [...new Set(entries.map((entry) => entry.version))];
const acceptedEntries = entries.filter((entry) => entry.expect === "accept");
const refusedEntries = entries.filter((entry) => entry.expect === "refuse");
const entryOf = (file: string): FixtureEntry =>
  must(
    entries.find((candidate) => candidate.file === file),
    `the index entry of ${file}`,
  );
const defOf = (entry: FixtureEntry): string => must(entry.def, `the $defs entry of ${entry.file}`);
const fixture = (file: string): unknown => readJson(path.join(FIXTURES_DIR, ...file.split("/")));
const sorted = (values: readonly string[]): string[] => [...values].sort();

/** A version's major and minor number: v1 is [1, 0], v1.1 is [1, 1]. */
function placeOf(version: string): [number, number] {
  const match = /^v(\d+)(?:\.(\d+))?$/.exec(version);
  if (match === null) throw new Error(`a version this test cannot place: ${version}`);
  return [Number(match[1]), Number(match[2] ?? "0")];
}

/** The versions of K-08's schema files in contracts/event-trace/. */
const SCHEMA_VERSIONS = readdirSync(EVENT_TRACE_DIR)
  .map((name) => /^event-trace\.(v\d+(?:\.\d+)?)\.schema\.json$/.exec(name)?.[1])
  .filter((version): version is string => version !== undefined);

/** The later minor versions of `version` (BP 6.4: a minor version only adds, so it accepts what `version` accepts). */
function laterMinorVersions(version: string): string[] {
  const [major, minor] = placeOf(version);
  return SCHEMA_VERSIONS.filter((other) => {
    const [otherMajor, otherMinor] = placeOf(other);
    return otherMajor === major && otherMinor > minor;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The schemas and the validators

/** Every `$ref` string in a schema. */
function refsIn(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(refsIn);
  if (!isObj(node)) return [];
  return Object.entries(node).flatMap(([key, child]) =>
    key === "$ref" && typeof child === "string" ? [child] : refsIn(child),
  );
}

/** The schema files K-08's own schemas reach by $ref, transitively (contracts-relative), with their schemas. */
function reachedSchemas(): Map<string, Obj> {
  const reached = new Map<string, Obj>();
  const visit = (relative: string): void => {
    if (reached.has(relative)) return;
    const schema = readJson(path.join(CONTRACTS_ROOT, ...relative.split("/"))) as Obj;
    if (schema.$id !== `${ID_BASE}${relative}`)
      throw new Error(`${relative} has the $id ${JSON.stringify(schema.$id)}`);
    reached.set(relative, schema);
    for (const ref of refsIn(schema)) {
      const target = new URL(ref, `${ID_BASE}${relative}`);
      target.hash = "";
      if (!target.href.startsWith(ID_BASE)) throw new Error(`${relative} refers outside contracts/: ${ref}`);
      visit(target.href.slice(ID_BASE.length));
    }
  };
  for (const name of readdirSync(EVENT_TRACE_DIR).sort()) {
    if (name.endsWith(".schema.json")) visit(`event-trace/${name}`);
  }
  return reached;
}

const SCHEMAS = reachedSchemas();
/** The folders whose schemas K-08's $refs reach (K-01's bundle and the shared formats): the harness loads them too. */
const SHARED_FOLDERS = [...new Set([...SCHEMAS.keys()].map((file) => must(file.split("/")[0])))].filter(
  (folder) => folder !== "event-trace",
);
/** Each loaded schema by its $id, for the schema reads and the required-field walk (part 3). */
const SCHEMA_BY_ID = new Map([...SCHEMAS.values()].map((schema) => [String(schema.$id), schema]));

// The strict Ajv 2020-12 setup of the harness (contracts/scripts/lib.mjs) for the checks; the same with every error,
// to read why a refused fixture is refused; and a loose one for the required-field walk, which compiles single
// branches of an anyOf, oneOf or if, where strict mode would miss the "type" their parent states.
const strictAjv = new Ajv2020({ strict: true, strictRequired: false });
const explainAjv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
const looseAjv = new Ajv2020({ strict: false });
for (const schema of SCHEMAS.values()) {
  strictAjv.addSchema(structuredClone(schema));
  explainAjv.addSchema(structuredClone(schema));
  looseAjv.addSchema(structuredClone(schema));
}

const schemaIdOf = (version: string): string => `${ID_BASE}event-trace/event-trace.${version}.schema.json`;

/** A schema version and the $defs entry a value is checked against (the root when none). */
interface SchemaTarget {
  version: string;
  def?: string | undefined;
}

/** The validator of the schema an entry's version names, at its $defs entry. */
function validatorFor(entry: SchemaTarget, ajv = strictAjv): ValidateFunction {
  const id = schemaIdOf(entry.version);
  const target = entry.def === undefined ? id : `${id}#/$defs/${entry.def}`;
  return must(ajv.getSchema(target), `the schema ${target}`);
}
const accepts = (entry: SchemaTarget, value: unknown): boolean => validatorFor(entry)(value);

// Compile every validator the checks call while the file loads, so no single test carries Ajv's compile time on a
// loaded machine (a resource guard, not part of any check). A schema that cannot be had is left to its entry's test.
for (const entry of entries) {
  try {
    validatorFor(entry);
    if (entry.expect === "refuse") validatorFor(entry, explainAjv);
    for (const later of laterMinorVersions(entry.version)) validatorFor({ version: later, def: entry.def });
  } catch {
    // Reported by the entry's own test, which calls validatorFor again.
  }
}

/** A $defs entry of a version's schema file, as the file holds it. */
function defNode(version: string, def: string): Obj {
  const schema = must(SCHEMA_BY_ID.get(schemaIdOf(version)), `the schema of ${version}`);
  const defs = must(schema.$defs as Record<string, Obj | undefined> | undefined, `${version}'s $defs`);
  return must(defs[def], `${version}'s $defs/${def}`);
}
/** A closed list a $defs entry holds. */
const enumOf = (version: string, def: string): string[] =>
  must(defNode(version, def).enum as string[] | undefined, `${version}'s $defs/${def} enum`);

// ---------------------------------------------------------------------------------------------------------------
// What the checks read. The fixtures are checked against the schema first (part 1), so a cast to these shapes reads
// only fields the schema gives them.

interface BundleId {
  hash: string;
  build: number;
}
interface ModelCall {
  model: string;
  role: string;
  purpose: string;
  input_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_micro_usd: number;
}
interface RowRef {
  table: string;
  id: string;
}
interface Span {
  trace_id: string;
  span_id: string;
  seq: number;
  hop: string;
  at: string;
  bundle_id: BundleId;
  turn_id: string | null;
  job_id?: string | null;
  event_id?: string | null;
  handle_ref: string | null;
  got?: Obj;
  decided?: Obj;
  rows?: RowRef[];
  model_calls?: ModelCall[];
  outcome: string;
}
interface Trace {
  trace_id: string;
  bundle_id: BundleId;
  turn_id: string | null;
  job_id: string | null;
  joined_trace_ids: string[];
  spans: Span[];
}
interface EventRow {
  id: string;
  turn_id?: string | null;
  job_id?: string | null;
  trace_id: string;
  business_id?: string | null;
  kind: string;
  table_name?: string | null;
  old_values?: Obj | null;
  new_values?: Obj | null;
  sealed_values?: string | null;
}
interface ExportRow {
  row: EventRow;
  sealed_key: string | null;
}
interface ReplyTime {
  trace_id: string;
  turn_id: string;
  bundle_id: BundleId;
  texts: number;
  last_text_event_id: string;
  last_text_at: string;
  first_part_row_id: string;
  first_part_accepted_at: string;
  ms: number;
  reread: boolean;
  rewrite: boolean;
}
interface InvariantRun {
  window_from: string;
  window_to: string;
  checked_at: string;
  checks: { invariant: string; breaches: number; trace_ids: string[] }[];
}

/** The event-log rows a document holds: a row, a commit's rows, or an export row's stored row. */
function rowsIn(def: string, value: unknown): EventRow[] {
  if (def === "eventLogRow") return [value as EventRow];
  if (def === "eventLogBatch") return (value as { rows: EventRow[] }).rows;
  if (def === "exportRow") return [(value as ExportRow).row];
  return [];
}
/** The traces a document holds: a trace, or a trace set's traces. */
function tracesIn(def: string, value: unknown): Trace[] {
  if (def === "trace") return [value as Trace];
  if (def === "traceSet") return (value as { traces: Trace[] }).traces;
  return [];
}
/** The spans a document holds: a span alone, or its traces' spans. */
function spansIn(def: string, value: unknown): Span[] {
  if (def === "span") return [value as Span];
  return tracesIn(def, value).flatMap((trace) => trace.spans);
}
/** What `pick` finds in every accepted fixture, each with its file. */
function inAccepted<T>(pick: (def: string, value: unknown) => T[]): { file: string; item: T }[] {
  return acceptedEntries.flatMap((entry) =>
    pick(defOf(entry), fixture(entry.file)).map((item) => ({ file: entry.file, item })),
  );
}
const acceptedOfDef = (def: string): FixtureEntry[] => acceptedEntries.filter((entry) => entry.def === def);

// ---------------------------------------------------------------------------------------------------------------
// The README's tables and lists the checks read

const README = readFileSync(path.join(EVENT_TRACE_DIR, "README.md"), "utf8");

/** The README's text from `heading` to `end` (the next heading that closes it). */
function sectionOf(heading: string, end: string): string {
  const start = README.indexOf(heading);
  if (start === -1) throw new Error(`the README has no "${heading}"`);
  const stop = README.indexOf(end, start + heading.length);
  if (stop === -1) throw new Error(`the README has no "${end}" after "${heading}"`);
  return README.slice(start, stop);
}

/** The body rows of the first Markdown table after `marker` in the README, each as its trimmed cells. */
function tableAfter(marker: string): string[][] {
  const start = README.indexOf(marker);
  if (start === -1) throw new Error(`the README has no "${marker}"`);
  const rows: string[][] = [];
  for (const line of README.slice(start).split("\n").slice(1)) {
    if (line.startsWith("|"))
      rows.push(
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );
    else if (rows.length > 0) break;
  }
  return rows.slice(2);
}
const unticked = (cell: string): string => cell.replaceAll("`", "");

/** README "Hops": every hop, in the table's order, which is D-017's turn order (BP section 10 D-017). */
const HOP_TABLE = tableAfter("### Hops").map((cells) => unticked(must(cells[0])));

/**
 * README "Event kinds (the closed list)": each subject's moves ("created, planned, state_changed; state_changed" for
 * two subjects), and the table a subject names in brackets ("`business` (businesses)"). A row of two subjects names no
 * table (outbox_row and outbox_part; effect and provider_event, whose bracket names K-07).
 */
const V1_KINDS_TABLE = tableAfter("### Event kinds (the closed list)").map((cells) => {
  const subjectCell = must(cells[0]);
  const subjects = [...subjectCell.matchAll(/`([a-z_]+)`/g)].map((match) => must(match[1]));
  const groups = must(cells[1]).split(";");
  if (groups.length !== subjects.length)
    throw new Error(`the kinds table's row ${subjectCell} gives moves for ${String(groups.length)} subjects`);
  const kinds = subjects.flatMap((subject, k) =>
    must(groups[k])
      .replace(/\(.*?\)/g, "")
      .split(",")
      .map((move) => `${subject}.${move.trim()}`),
  );
  const bracket = /\(([^)]*)\)/.exec(subjectCell)?.[1]?.split(",")[0]?.trim();
  const table =
    subjects.length === 1 && bracket !== undefined && /^[a-z][a-z0-9_]*$/.test(bracket) ? bracket : null;
  return { subjects, kinds, table };
});

/** README v1.1 "The added kinds": each added kind, its table, and who reads it (business or team only). */
const ADDED_KINDS_TABLE = tableAfter("### The added kinds").map((cells) => ({
  kind: must(/`([a-z_]+\.[a-z_]+)`/.exec(must(cells[0]))?.[1], `an added kind in ${String(cells[0])}`),
  table: must(/`([a-z_]+)`/.exec(must(cells[1]))?.[1], `a table in ${String(cells[1])}`),
  readBy: must(cells[3]),
}));

/** README v1.2 "The session kinds": each kind v1.2 adds and its table. */
const V12_KINDS_TABLE = tableAfter("### The session kinds").map((cells) => ({
  kind: must(/`([a-z_]+\.[a-z_]+)`/.exec(must(cells[0]))?.[1], `a session kind in ${String(cells[0])}`),
  table: must(/`([a-z_]+)`/.exec(must(cells[1]))?.[1], `a table in ${String(cells[1])}`),
}));

/** Each kind's subject (its part before the dot) and the table the README's kinds tables give it. */
const TABLE_OF = new Map<string, string>();
for (const [subject, table] of [
  ...V1_KINDS_TABLE.flatMap((row) =>
    row.table === null ? [] : [[must(row.subjects[0]), row.table] as const],
  ),
  ...ADDED_KINDS_TABLE.map((row) => [must(row.kind.split(".")[0]), row.table] as const),
  ...V12_KINDS_TABLE.map((row) => [must(row.kind.split(".")[0]), row.table] as const),
]) {
  const known = TABLE_OF.get(subject);
  if (known !== undefined && known !== table)
    throw new Error(`the README gives ${subject} two tables: ${known}, ${table}`);
  TABLE_OF.set(subject, table);
}

/**
 * README "Fixtures": "each cost follows from its tokens at illustrative per-million-token prices (Haiku $1 in, $0.10
 * cached, $1.25 cache write, $5 out; Sonnet $3, $0.30, $3.75, $15)". Read here as hundredths of a micro-dollar per token
 * ($1 a million tokens is 1 micro-dollar a token), so every sum is a whole number.
 */
interface Prices {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}
const PRICE_LINE =
  /\(Haiku \$([0-9.]+) in, \$([0-9.]+) cached, \$([0-9.]+) cache write, \$([0-9.]+) out; Sonnet \$([0-9.]+), \$([0-9.]+), \$([0-9.]+), \$([0-9.]+)\)/;
const priceMatch = must(PRICE_LINE.exec(README), "the README's illustrative prices");
const hundredths = (dollarsPerMillion: string | undefined): number =>
  Math.round(Number(must(dollarsPerMillion, "a price")) * 100);
const PRICES: Record<string, Prices | undefined> = {
  haiku: {
    input: hundredths(priceMatch[1]),
    cached: hundredths(priceMatch[2]),
    cacheWrite: hundredths(priceMatch[3]),
    output: hundredths(priceMatch[4]),
  },
  sonnet: {
    input: hundredths(priceMatch[5]),
    cached: hundredths(priceMatch[6]),
    cacheWrite: hundredths(priceMatch[7]),
    output: hundredths(priceMatch[8]),
  },
};

/**
 * README v1.1 "What each added kind holds": the columns each added kind's old and new values may name, and whether a
 * row of the kind is inserted ("new: ..."), so it has no old values and names every column. Held to the README's own
 * words in part 4 (each column is named in that kind's sentence, and "new:" only for the inserted ones).
 */
const ADDED_KIND_COLUMNS: Record<string, { inserts: boolean; columns: readonly string[] } | undefined> = {
  "safety_outcome.recorded": {
    inserts: true,
    columns: [
      "event_id",
      "source",
      "handle_id",
      "person_id",
      "booking_id",
      "turn_id",
      "read_at",
      "tries",
      "timed_out",
      "labels",
      "tenses",
      "danger_word_lists",
      "danger_word_kinds",
      "outcomes",
      "lifted_to_unsure",
    ],
  },
  "safety_hold.set": {
    inserts: true,
    columns: [
      "safety_outcome_id",
      "handle_id",
      "person_id",
      "booking_id",
      "turn_id",
      "release_rule",
      "blocks_booking",
      "held_at",
    ],
  },
  "safety_hold.released": {
    inserts: false,
    columns: ["released_at", "released_why", "released_by_turn_id", "released_by_outcome_id"],
  },
  "harm_report.filed": {
    inserts: true,
    columns: [
      "business_id",
      "kind",
      "safety_outcome_id",
      "reporter_person_id",
      "booking_id",
      "named_person_id",
      "hotline",
      "reported_at",
      "day_zone",
    ],
  },
  "hand_off.created": {
    inserts: true,
    columns: [
      "kind",
      "safety_outcome_id",
      "turn_id",
      "booking_id",
      "about_person_id",
      "told_person_id",
      "told_as",
      "alert_outbox_row_id",
      "summary",
      "handed_at",
      "escalate_at",
      "escalation_clock_row_id",
    ],
  },
  "hand_off.answered": { inserts: false, columns: ["answered_at", "answered_via", "answered_by_person_id"] },
  "hand_off.escalated": { inserts: false, columns: ["escalated_at"] },
  "team_page.opened": {
    inserts: true,
    columns: [
      "reason",
      "business_id",
      "hand_off_id",
      "harm_report_id",
      "review_item_id",
      "safety_timer_id",
      "turn_id",
      "named_person_id",
      "summary",
      "opened_at",
      "last_paged_at",
      "times_paged",
      "repeat_minutes",
      "next_page_clock_row_id",
      "state",
    ],
  },
  "team_page.paged_again": {
    inserts: false,
    columns: ["last_paged_at", "times_paged", "next_page_clock_row_id"],
  },
  "team_page.acknowledged": {
    inserts: false,
    columns: ["state", "acknowledged_at", "acknowledged_by_person_id", "acknowledged_via"],
  },
  "review_item.opened": {
    inserts: true,
    columns: [
      "kind",
      "business_id",
      "subject_table",
      "subject_row_id",
      "turn_id",
      "raised_by_person_id",
      "summary",
      "opened_at",
      "due_at",
      "state",
    ],
  },
  "review_item.waiting": { inserts: false, columns: ["state", "wait_until"] },
  "review_item.decided": {
    inserts: false,
    columns: ["state", "decided_at", "decided_by_person_id", "outcome"],
  },
  "gap_case.logged": {
    inserts: true,
    columns: ["business_id", "outcome", "open_question_ids", "versions_read", "logged_at", "review_state"],
  },
  "chat_link.issued": {
    inserts: true,
    columns: ["short_code", "purpose", "booking_id", "person_id", "given_via", "issued_at"],
  },
  "chat_link.given_again": { inserts: false, columns: ["given_via"] },
  "proof_code.sent": {
    inserts: true,
    columns: ["person_id", "purpose", "route", "contact_handle_id", "expires_at", "wrong_tries"],
  },
  "proof_code.checked": { inserts: false, columns: ["wrong_tries", "paused_until", "proven_at"] },
  "effect.claimed": {
    inserts: false,
    columns: ["state", "claimed_by", "claim_lapses_at", "first_try_at", "tries", "runs"],
  },
};

/**
 * The plain columns whose values may be words, because the README gives them a writer other than the person: the
 * safety read's labels and outcomes, K-02's outcome names ("labels plain, his words sealed": the index entry of
 * event-safety-outcome-hold.json), and Rosie's or the team's own words: a hand-off's summary ("only what the owner may
 * hear"), a page's ("ids and kinds, never a person's words"), a review item's summary and outcome ("carry no private
 * value", K-37 rule 4). Every other plain string is a label, a time or an id: a person's words go sealed (README "The
 * event log": "Private values (... words a person wrote ...) are left out and go into sealed_values").
 */
const WORDS_COLUMNS: Record<string, readonly string[] | undefined> = {
  "safety_outcome.recorded": ["labels", "outcomes"],
  "hand_off.created": ["summary"],
  "team_page.opened": ["summary"],
  "review_item.opened": ["summary"],
  "review_item.decided": ["outcome"],
};

/** v1.1's names and values that never appear in an added kind (BP rule 7; README v1.1 "Never in an added kind"). */
const NEVER_LOGGED = enumOf("v1.1", "neverLoggedColumn");
const isCodeLike = must(strictAjv.getSchema(`${schemaIdOf("v1.1")}#/$defs/codeLike`), "v1.1's codeLike") as (
  value: unknown,
) => boolean;
const ADDED_KINDS = new Set(enumOf("v1.1", "addedEventKind"));

// ---------------------------------------------------------------------------------------------------------------
// Paths into a JSON value

type Path = (string | number)[];

function getAt(value: unknown, where: Path): unknown {
  let node = value;
  for (const step of where) {
    if (Array.isArray(node) && typeof step === "number") node = node[step];
    else if (isObj(node) && typeof step === "string") node = node[step];
    else throw new Error(`no ${where.join(".")}`);
  }
  return node;
}

function setAt(value: unknown, where: Path, to: unknown): void {
  const parent = getAt(value, where.slice(0, -1));
  const last = must(where.at(-1));
  if (Array.isArray(parent) && typeof last === "number") parent[last] = to;
  else if (isObj(parent) && typeof last === "string") parent[last] = to;
  else throw new Error(`no ${where.join(".")}`);
}

/** Drops the property at `where` from `value` itself. */
function dropAt(value: unknown, where: Path): void {
  Reflect.deleteProperty(getAt(value, where.slice(0, -1)) as object, must(where.at(-1)));
}

/** A copy of `value` without the property at `where`. */
function without(value: unknown, where: Path): unknown {
  const copy = structuredClone(value);
  dropAt(copy, where);
  return copy;
}

/** The paths at which two values differ (a whole value where its kind or an array's length differs). */
function differences(a: unknown, b: unknown, at: Path = []): Path[] {
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((key) => differences(a[key], b[key], [...at, key]));
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length)
    return a.flatMap((item, k) => differences(item, b[k], [...at, k]));
  return isDeepStrictEqual(a, b) ? [] : [at];
}

/** The JSON pointer Ajv names an instance path by. */
const escaped = (step: string | number): string => String(step).replaceAll("~", "~0").replaceAll("/", "~1");
const pointerOf = (where: Path): string => where.map((step) => `/${escaped(step)}`).join("");

/** The places an Ajv error names: its instance path, and the property it is about (a missing or unknown one). */
function placesOf(error: ErrorObject): string[] {
  const places = [error.instancePath];
  const params = error.params as Record<string, unknown>;
  for (const name of [
    params.missingProperty,
    params.propertyName,
    params.additionalProperty,
    error.propertyName,
  ])
    if (typeof name === "string") places.push(`${error.instancePath}/${escaped(name)}`);
  return places;
}

/** A copy of an accepted fixture with one change, for the checks' damaged copies. */
function damaged<T>(file: string, change: (copy: T) => void): T {
  const copy = structuredClone(fixture(file)) as T;
  change(copy);
  return copy;
}

// ---------------------------------------------------------------------------------------------------------------
// What the schema leaves to the test (README "Producers and consumers", contract test; section "v1.1"). Each check
// returns one line per problem; an empty list means it holds.

const D017_MARK = "every hop of D-017 once, in order: ";

/** The hops of D-017 a skeleton fixture's index entry names, in order, or none for any other entry. */
function d017HopsOf(entry: FixtureEntry): string[] | null {
  const at = entry.shows.indexOf(D017_MARK);
  if (at === -1) return null;
  return entry.shows
    .slice(at + D017_MARK.length)
    .split(",")
    .map((hop) => hop.trim());
}

/** README contract test (BP section 10 D-017: "the trace shows every hop once, in order"): each hop once, in order. */
export function checkHopsOnceInOrder(trace: Trace, hops: readonly string[]): string[] {
  const problems: string[] = [];
  const ran = trace.spans.map((span) => span.hop);
  for (const hop of hops) {
    const times = ran.filter((other) => other === hop).length;
    if (times !== 1) problems.push(`hop ${hop} runs ${String(times)} times, not once`);
  }
  for (const hop of new Set(ran)) if (!hops.includes(hop)) problems.push(`hop ${hop} is no hop of D-017`);
  if (problems.length === 0 && !isDeepStrictEqual(ran, hops))
    problems.push(`the hops run ${ran.join(", ")}, not in D-017's order`);
  return problems;
}

/** A run of 7 or more digits reads as a number (the schema's safeId: "seven or more long, reads as a number"). */
const DIGIT_RUN = /[0-9]{7}/;

/**
 * README contract test "no span carries a raw number or text" ("Never the raw number or words": a count, a yes or no,
 * or a label: never spaces, + or @, never a long run of digits). Every string of the span but its start time and its
 * bundle's content hash is read, at any depth; and a count in what it got or decided never has 7 digits or more.
 */
export function checkNoRawNumberOrText(span: Span): string[] {
  const problems: string[] = [];
  const visit = (value: unknown, where: Path): void => {
    const at = `${span.span_id}${pointerOf(where)}`;
    if (typeof value === "string") {
      if (/\s/.test(value)) problems.push(`${at} holds words`);
      if (/[+@]/.test(value)) problems.push(`${at} holds a + or an @, a number or an address`);
      if (DIGIT_RUN.test(value)) problems.push(`${at} holds a run of 7 or more digits, a number`);
    } else if (typeof value === "number") {
      if ((where[0] === "got" || where[0] === "decided") && Math.abs(value) >= 1_000_000)
        problems.push(`${at} is a count of 7 or more digits, a number`);
    } else if (Array.isArray(value)) {
      value.forEach((item: unknown, k) => {
        visit(item, [...where, k]);
      });
    } else if (isObj(value)) {
      for (const [key, child] of Object.entries(value)) visit(child, [...where, key]);
    }
  };
  for (const [key, value] of Object.entries(span)) {
    // A start time and a bundle's content hash are no label a person's number could hide in.
    if (key !== "at" && key !== "bundle_id") visit(value, [key]);
  }
  return problems;
}

/**
 * README contract test ("seq runs 1, 2, 3 … and at never goes back; every span's bundle id is its trace's") and
 * "Traces" ("Each span carries the trace id, ... the turn id (null before the batch closes, and for a job), the job id
 * for a job"): a trace's spans in order, each on its trace's trace id, bundle id, turn and job.
 */
export function checkTraceSpans(trace: Trace): string[] {
  const problems: string[] = [];
  const batchAt = trace.spans.findIndex((span) => span.hop === "batch");
  trace.spans.forEach((span, k) => {
    const name = `${trace.trace_id} span ${span.span_id}`;
    if (span.seq !== k + 1) problems.push(`${name} has seq ${String(span.seq)}, not ${String(k + 1)}`);
    const before = trace.spans[k - 1];
    if (before !== undefined && Date.parse(span.at) < Date.parse(before.at))
      problems.push(`${name} starts at ${span.at}, before ${before.span_id} (${before.at})`);
    if (span.trace_id !== trace.trace_id) problems.push(`${name} names the trace ${span.trace_id}`);
    if (!isDeepStrictEqual(span.bundle_id, trace.bundle_id)) problems.push(`${name} names another bundle`);
    const turn = batchAt !== -1 && k < batchAt ? null : trace.turn_id;
    if (span.turn_id !== turn)
      problems.push(`${name} names the turn ${String(span.turn_id)}, not ${String(turn)}`);
    const job = span.job_id ?? null;
    if (job !== trace.job_id)
      problems.push(`${name} names the job ${String(job)}, not ${String(trace.job_id)}`);
  });
  return problems;
}

/**
 * README contract test ("a joined trace's batch span names the turn whose trace lists it") and "Traces" (CQ-06: each
 * other text's trace ends at its batch span with outcome joinedTurn): in a set of traces, each listed trace ends at its
 * batch span, joinedTurn, naming the listing trace's turn, and each trace that ends joinedTurn is listed once.
 */
export function checkJoinedTraces(traces: readonly Trace[]): string[] {
  const problems: string[] = [];
  const byId = new Map(traces.map((trace) => [trace.trace_id, trace]));
  const listers = new Map<string, string[]>();
  for (const trace of traces) {
    for (const joinedId of trace.joined_trace_ids) {
      listers.set(joinedId, [...(listers.get(joinedId) ?? []), trace.trace_id]);
      const joined = byId.get(joinedId);
      if (joined === undefined) {
        problems.push(`${trace.trace_id} lists ${joinedId}, which the set does not hold`);
        continue;
      }
      const last = joined.spans.at(-1);
      if (last?.hop !== "batch" || last.outcome !== "joinedTurn")
        problems.push(`${joinedId} does not end at its batch span with outcome joinedTurn`);
      else if (last.turn_id !== trace.turn_id)
        problems.push(
          `${joinedId}'s batch span names the turn ${String(last.turn_id)}, not ${String(trace.turn_id)}, whose trace lists it`,
        );
    }
  }
  for (const trace of traces) {
    const listedBy = listers.get(trace.trace_id) ?? [];
    if (trace.spans.at(-1)?.outcome === "joinedTurn" && listedBy.length !== 1)
      problems.push(
        `${trace.trace_id} ends joinedTurn, but ${String(listedBy.length)} traces of the set list it`,
      );
  }
  return problems;
}

/** README "The commit's batch" ($defs/eventLogBatch: "The rows one commit appends, in order, under one turn id and one trace id"). */
export function checkBatchRows(rows: readonly EventRow[]): string[] {
  const first = must(rows[0], "a commit's first row");
  const problems: string[] = [];
  for (const row of rows) {
    if ((row.turn_id ?? null) !== (first.turn_id ?? null) || (row.job_id ?? null) !== (first.job_id ?? null))
      problems.push(`${row.id} is not under ${first.id}'s turn or job`);
    if (row.trace_id !== first.trace_id) problems.push(`${row.id} is not under ${first.id}'s trace`);
  }
  return problems;
}

/** README contract test ("a kind's subject matches its table_name (the kinds table)"). */
export function checkKindTable(row: EventRow): string[] {
  const subject = must(row.kind.split(".")[0]);
  const table = TABLE_OF.get(subject);
  if (table === undefined) return [`${row.id}: the README's kinds tables name no table for ${subject}`];
  return row.table_name === table
    ? []
    : [`${row.id}: ${row.kind} names the table ${String(row.table_name)}, not ${table}`];
}

/** README contract test ("replyTime.ms is the difference of its two instants"). */
export function checkReplyTime(reply: ReplyTime): string[] {
  const between = Date.parse(reply.first_part_accepted_at) - Date.parse(reply.last_text_at);
  return reply.ms === between
    ? []
    : [`ms is ${String(reply.ms)}, but its two instants are ${String(between)} ms apart`];
}

/**
 * README "Measures read from traces" (Q-41, CQ-06): the reply time read again from its turn's traces: the turn's trace
 * on the same bundle, its texts (the turn's and those it joined), the last text's arrival (the start of its receive
 * span), the start of the turn's first providerAccepted span, the outbox row its commit wrote, the re-read and the
 * rewrite.
 */
export function checkReplyTimeFromTraces(reply: ReplyTime, traces: readonly Trace[]): string[] {
  const turn = traces.find((trace) => trace.trace_id === reply.trace_id);
  if (turn === undefined) return [`no trace ${reply.trace_id}`];
  const problems: string[] = [];
  if (turn.turn_id !== reply.turn_id) problems.push(`the trace carries the turn ${String(turn.turn_id)}`);
  if (!isDeepStrictEqual(turn.bundle_id, reply.bundle_id)) problems.push("the trace ran on another bundle");
  if (reply.texts !== 1 + turn.joined_trace_ids.length)
    problems.push(
      `texts is ${String(reply.texts)}, but the turn joined ${String(1 + turn.joined_trace_ids.length)}`,
    );
  const texts = [turn, ...traces.filter((trace) => turn.joined_trace_ids.includes(trace.trace_id))];
  const arrivals = texts
    .flatMap((trace) => trace.spans.filter((span) => span.hop === "receive"))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = arrivals.at(-1);
  if (last?.event_id !== reply.last_text_event_id || Date.parse(last.at) !== Date.parse(reply.last_text_at))
    problems.push("last_text_event_id and last_text_at are not the last text's arrival");
  const accepted = turn.spans.find((span) => span.hop === "providerAccepted");
  if (accepted === undefined || Date.parse(accepted.at) !== Date.parse(reply.first_part_accepted_at))
    problems.push("first_part_accepted_at is not the start of the turn's first providerAccepted span");
  const written = turn.spans.filter((span) => span.hop === "commit").flatMap((span) => span.rows ?? []);
  if (!written.some((row) => row.table === "outbox_rows" && row.id === reply.first_part_row_id))
    problems.push(`the turn's commit wrote no outbox row ${reply.first_part_row_id}`);
  if (reply.reread !== turn.spans.some((span) => span.hop === "reread"))
    problems.push(`reread is ${String(reply.reread)}, but the trace says otherwise`);
  if (reply.rewrite !== turn.spans.some((span) => span.hop === "rewriteOrFallback"))
    problems.push(`rewrite is ${String(reply.rewrite)}, but the trace says otherwise`);
  return problems;
}

/**
 * README contract test ("each model call's cost follows from its tokens and the price list in force"): for the
 * fixtures, the README's illustrative prices, by the model the call's role names; a cost is whole micro-dollars
 * (README default 7), so it is the exact sum to the nearest one.
 */
export function checkModelCallCosts(span: Span): string[] {
  const problems: string[] = [];
  (span.model_calls ?? []).forEach((call, k) => {
    const where = `${span.span_id} model_calls[${String(k)}]`;
    const prices = PRICES[call.role];
    if (prices === undefined) {
      problems.push(`${where}: no price for ${call.role}`);
      return;
    }
    if (!call.model.startsWith(`claude-${call.role}-`))
      problems.push(`${where}: ${call.model} is not the bundle's ${call.role} model`);
    const exact =
      call.input_tokens * prices.input +
      call.cached_tokens * prices.cached +
      call.cache_write_tokens * prices.cacheWrite +
      call.output_tokens * prices.output;
    if (Math.abs(call.cost_micro_usd * 100 - exact) > 50)
      problems.push(
        `${where}: costs ${String(call.cost_micro_usd)} micro-dollars, but its tokens cost ${String(exact / 100)}`,
      );
  });
  return problems;
}

const E164 = /[+][1-9][0-9]{6,14}/;
const EMAIL = /[^@\s]+@[^@\s]+[.][^@\s]+/;

/**
 * README contract test ("no person's words in a plain value, and no phone number or email address nested deeper than
 * the schema looks"): every string of the old and new values, at any depth, holds no E.164 number and no email address
 * (the schema's own patterns), and holds words only in a column WORDS_COLUMNS gives its kind.
 */
export function checkPlainValues(row: EventRow): string[] {
  const problems: string[] = [];
  const wordColumns = WORDS_COLUMNS[row.kind] ?? [];
  const visit = (value: unknown, where: Path): void => {
    const at = `${row.id}${pointerOf(where)}`;
    if (typeof value === "string") {
      if (E164.test(value)) problems.push(`${at} holds a phone number`);
      if (EMAIL.test(value)) problems.push(`${at} holds an email address`);
      if (/\s/.test(value) && !wordColumns.includes(String(where[1])))
        problems.push(`${at} holds words, which go sealed`);
    } else if (Array.isArray(value)) {
      value.forEach((item: unknown, k) => {
        visit(item, [...where, k]);
      });
    } else if (isObj(value)) {
      for (const [key, child] of Object.entries(value)) visit(child, [...where, key]);
    }
  };
  visit(row.old_values ?? null, ["old_values"]);
  visit(row.new_values ?? null, ["new_values"]);
  return problems;
}

/**
 * README "The export": "An export row is the stored row unchanged, sealed values still sealed ..., with sealed_key
 * saying whether the person's key was held or already erased" ($defs/exportRow: null for a row with none).
 */
export function checkExportRow(exported: ExportRow, stored: EventRow | undefined): string[] {
  const problems: string[] = [];
  const sealed = typeof exported.row.sealed_values === "string";
  if (sealed === (exported.sealed_key === null))
    problems.push(
      `sealed_key is ${String(exported.sealed_key)} for a row ${sealed ? "with" : "without"} sealed values`,
    );
  if (stored !== undefined && !isDeepStrictEqual(exported.row, stored))
    problems.push(`the export of ${exported.row.id} is not the stored row unchanged`);
  return problems;
}

/**
 * README "Measures read from traces" ("each with its breach count, the trace id of each breach ...") and
 * $defs/invariantRun: the three hard invariants once each, over one hour, read after it ends.
 */
export function checkInvariantRun(run: InvariantRun, invariants: readonly string[]): string[] {
  const problems: string[] = [];
  if (!isDeepStrictEqual(sorted(run.checks.map((check) => check.invariant)), sorted(invariants)))
    problems.push("the run does not check each hard invariant once");
  for (const check of run.checks)
    if (check.breaches !== check.trace_ids.length)
      problems.push(
        `${check.invariant}: ${String(check.breaches)} breaches with ${String(check.trace_ids.length)} trace ids`,
      );
  if (Date.parse(run.window_to) - Date.parse(run.window_from) !== 3_600_000)
    problems.push("the window is not one hour");
  if (Date.parse(run.checked_at) < Date.parse(run.window_to))
    problems.push("the run ended before its hour did");
  return problems;
}

/**
 * README v1.1 ("the columns each kind's values name"; "What each added kind holds"): an added kind's old and new values
 * name only its columns; an inserted row has no old values and names every column; and an effect claim names its old
 * and new state always, the claim's columns, first_try_at for a run that starts (from pending or outage), and tries and
 * runs for a run after an outage (tries back to 0, runs up by one).
 */
export function checkAddedKindColumns(row: EventRow): string[] {
  const own = ADDED_KIND_COLUMNS[row.kind];
  if (own === undefined) return [];
  const problems: string[] = [];
  const oldNames = Object.keys(row.old_values ?? {});
  const newNames = Object.keys(row.new_values ?? {});
  for (const name of new Set([...oldNames, ...newNames]))
    if (!own.columns.includes(name)) problems.push(`${row.id}: ${row.kind} names no column ${name}`);
  if (own.inserts) {
    if ((row.old_values ?? null) !== null)
      problems.push(`${row.id}: ${row.kind} inserts its row, with no old values`);
    for (const name of own.columns)
      if (!newNames.includes(name)) problems.push(`${row.id}: ${row.kind} leaves out ${name}`);
  } else if (newNames.length === 0) {
    problems.push(`${row.id}: ${row.kind} names no column it changed`);
  }
  if (row.kind === "effect.claimed") {
    const before = row.old_values ?? {};
    const after = row.new_values ?? {};
    for (const name of ["state", "claimed_by", "claim_lapses_at"])
      if (!(name in before) || !(name in after))
        problems.push(`${row.id}: a claim names ${name}, old and new`);
    if (after.state !== "running") problems.push(`${row.id}: a claim runs the effect`);
    const starts = before.state === "pending" || before.state === "outage";
    if (starts !== "first_try_at" in after)
      problems.push(`${row.id}: first_try_at goes with a run that starts, from pending or outage`);
    const afterOutage = before.state === "outage";
    if (afterOutage !== ("tries" in after && "runs" in after))
      problems.push(`${row.id}: tries and runs go with a run after an outage`);
    if (afterOutage && (after.tries !== 0 || after.runs !== Number(before.runs) + 1))
      problems.push(`${row.id}: after an outage, tries go back to 0 and runs up by one`);
  }
  return problems;
}

/** Sealed bytes as PostgreSQL writes a bytea ($defs/sealedBytes: \x and hex digits), read as UTF-8 text. */
function textOfSealed(sealed: string): string {
  const hex = sealed.slice(2);
  const bytes = new Uint8Array(hex.length / 2);
  for (let k = 0; k < bytes.length; k += 1) bytes[k] = Number.parseInt(hex.slice(2 * k, 2 * k + 2), 16);
  return new TextDecoder().decode(bytes);
}

/** Text as sealed bytes in the same form, for the damaged copies. */
const sealedOfText = (text: string): string =>
  `\\x${[...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

/**
 * README v1.1 ("nothing that never appears inside sealed bytes"; "Never in an added kind, plain or sealed: a key or
 * token"): an added kind's sealed bytes, read as text, hold none of the never-logged names and no code or hash.
 */
export function checkSealedBytes(row: EventRow): string[] {
  if (!ADDED_KINDS.has(row.kind) || typeof row.sealed_values !== "string") return [];
  const text = textOfSealed(row.sealed_values);
  const problems: string[] = [];
  for (const token of text.split(/[^A-Za-z0-9_]+/)) {
    if (NEVER_LOGGED.includes(token)) problems.push(`${row.id}: its sealed bytes name ${token}`);
    if (isCodeLike(token)) problems.push(`${row.id}: its sealed bytes hold a code or a hash`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// The required-field walk (part 3): the fields a schema requires of a value, read from the schemas' own `required`
// lists along the branch the value takes at each anyOf, oneOf and if.

/** A place in a loaded schema: the schema's $id and a JSON pointer into it. */
interface Place {
  doc: string;
  pointer: string;
}

const placeName = (place: Place): string => `${place.doc}#${place.pointer}`;

function nodeAt(place: Place): unknown {
  let node: unknown = must(SCHEMA_BY_ID.get(place.doc), `the schema ${place.doc}`);
  if (place.pointer === "") return node;
  for (const part of place.pointer.slice(1).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    node = Array.isArray(node) ? node[Number(key)] : isObj(node) ? node[key] : undefined;
    if (node === undefined) throw new Error(`${placeName(place)} does not exist`);
  }
  return node;
}

const childOf = (place: Place, ...steps: (string | number)[]): Place => ({
  doc: place.doc,
  pointer: `${place.pointer}${pointerOf(steps)}`,
});

function refPlace(ref: string, from: Place): Place {
  const url = new URL(ref, from.doc);
  const pointer = decodeURIComponent(url.hash.slice(1));
  url.hash = "";
  return { doc: url.href, pointer };
}

const looseValidators = new Map<string, ValidateFunction>();
/** Whether the schema at `place` takes `value` (the loose validator: only which branch applies is asked). */
function takes(place: Place, value: unknown): boolean {
  const key = place.pointer === "" ? place.doc : placeName(place);
  let validate = looseValidators.get(key);
  if (validate === undefined) {
    validate = must(looseAjv.getSchema(key), `a validator for ${key}`);
    looseValidators.set(key, validate);
  }
  return validate(value);
}

// JSON Schema 2020-12 keywords that hold no subschema a required field could sit in: annotations, assertions on the
// value itself, and applicators that only refuse (not, contains, propertyNames).
const LEAF_KEYWORDS = new Set([
  "$schema",
  "$comment",
  "$defs",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "type",
  "enum",
  "const",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "not",
  "contains",
  "propertyNames",
]);
// The keywords the walk follows.
const WALKED_KEYWORDS = new Set([
  "$ref",
  "allOf",
  "anyOf",
  "oneOf",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "dependentRequired",
  "properties",
  "patternProperties",
  "additionalProperties",
  "prefixItems",
  "items",
  "required",
]);

const keyOf = (where: Path): string => JSON.stringify(where);

/**
 * The paths (as keyOf strings) of the fields the schema at `place` requires of `value`, found at `at`: every `required`
 * name of every subschema that applies to the value, following $ref, allOf, the then or else an if picks, the
 * dependentSchemas of fields present, properties and items. At an anyOf or oneOf, a field counts only when every branch
 * the value takes requires it. A keyword the walk cannot read fails loudly.
 */
function requiredIn(place: Place, value: unknown, at: Path): Set<string> {
  const node = nodeAt(place);
  const found = new Set<string>();
  if (typeof node === "boolean") return found;
  if (!isObj(node)) throw new Error(`${placeName(place)} is no schema`);
  const addAll = (more: Set<string>): void => {
    for (const key of more) found.add(key);
  };
  for (const [keyword, setting] of Object.entries(node)) {
    if (LEAF_KEYWORDS.has(keyword) || WALKED_KEYWORDS.has(keyword)) continue;
    if (keyword === "$id" && place.pointer === "") continue;
    if ((keyword === "unevaluatedProperties" || keyword === "unevaluatedItems") && setting === false)
      continue;
    throw new Error(`${placeName(place)}: the required-field walk cannot read "${keyword}"`);
  }
  if (typeof node.$ref === "string") addAll(requiredIn(refPlace(node.$ref, place), value, at));
  if (Array.isArray(node.allOf))
    node.allOf.forEach((_branch, k) => {
      addAll(requiredIn(childOf(place, "allOf", k), value, at));
    });
  for (const keyword of ["anyOf", "oneOf"]) {
    const branches = node[keyword];
    if (!Array.isArray(branches)) continue;
    const taken = branches
      .map((_branch, k) => childOf(place, keyword, k))
      .filter((branch) => takes(branch, value));
    if (taken.length === 0)
      throw new Error(`${placeName(place)}: no ${keyword} branch takes ${pointerOf(at)}`);
    const [first, ...rest] = taken.map((branch) => requiredIn(branch, value, at));
    for (const key of must(first)) if (rest.every((set) => set.has(key))) found.add(key);
  }
  if (node.if !== undefined) {
    const branch = takes(childOf(place, "if"), value) ? "then" : "else";
    if (node[branch] !== undefined) addAll(requiredIn(childOf(place, branch), value, at));
  }
  if (isObj(value)) {
    const present = (name: unknown): name is string => typeof name === "string" && Object.hasOwn(value, name);
    for (const name of Array.isArray(node.required) ? node.required : []) {
      if (!present(name)) throw new Error(`${placeName(place)} requires ${String(name)} at ${pointerOf(at)}`);
      found.add(keyOf([...at, name]));
    }
    if (isObj(node.dependentRequired)) {
      for (const [name, names] of Object.entries(node.dependentRequired)) {
        if (!present(name) || !Array.isArray(names)) continue;
        for (const other of names) if (present(other)) found.add(keyOf([...at, other]));
      }
    }
    if (isObj(node.dependentSchemas)) {
      for (const name of Object.keys(node.dependentSchemas).filter(present))
        addAll(requiredIn(childOf(place, "dependentSchemas", name), value, at));
    }
    const properties = isObj(node.properties) ? node.properties : {};
    const patterns = isObj(node.patternProperties) ? Object.keys(node.patternProperties) : [];
    for (const [name, child] of Object.entries(value)) {
      let matched = Object.hasOwn(properties, name);
      if (matched) addAll(requiredIn(childOf(place, "properties", name), child, [...at, name]));
      for (const pattern of patterns.filter((candidate) => new RegExp(candidate, "u").test(name))) {
        matched = true;
        addAll(requiredIn(childOf(place, "patternProperties", pattern), child, [...at, name]));
      }
      if (!matched && isObj(node.additionalProperties))
        addAll(requiredIn(childOf(place, "additionalProperties"), child, [...at, name]));
    }
  }
  if (Array.isArray(value)) {
    const prefix = Array.isArray(node.prefixItems) ? node.prefixItems.length : 0;
    value.forEach((item: unknown, k) => {
      if (k < prefix) addAll(requiredIn(childOf(place, "prefixItems", k), item, [...at, k]));
      else if (isObj(node.items)) addAll(requiredIn(childOf(place, "items"), item, [...at, k]));
    });
  }
  return found;
}

/** The place of an entry's $defs entry in the schema its version names. */
const defPlace = (entry: FixtureEntry): Place => ({
  doc: schemaIdOf(entry.version),
  pointer: pointerOf(["$defs", defOf(entry)]),
});

/** The required paths of an entry's fixture, under the schema its version names, at its $defs entry. */
function requiredPathsOf(entry: FixtureEntry): Path[] {
  return [...requiredIn(defPlace(entry), fixture(entry.file), [])].map((key) => JSON.parse(key) as Path);
}

/** The `required` list of an entry's definition itself, through the $refs a minor version restates it by. */
function ownRequiredOf(entry: FixtureEntry): string[] {
  let place = defPlace(entry);
  for (;;) {
    const node = nodeAt(place);
    if (!isObj(node)) throw new Error(`${placeName(place)} is no schema`);
    if (Array.isArray(node.required)) return node.required as string[];
    if (typeof node.$ref !== "string") return [];
    place = refPlace(node.$ref, place);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Every fixture of the index, each against the schema its version names

const report = checkContractFixtures("event-trace", { sharedFolders: SHARED_FOLDERS });

describe("event-trace fixtures: the index and the count", () => {
  it("checks as many fixtures as fixtures/index.json lists, none left out", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(report.problems).toEqual([]);
    expect(report.entries.map((result) => result.file)).toEqual(entries.map((entry) => entry.file));
    expect(report.seedRows).toBe(0);
    expect(acceptedEntries.length + refusedEntries.length).toBe(entries.length);
    const onDisk = readdirSync(FIXTURES_DIR, { recursive: true, encoding: "utf8" })
      .map((file) => file.split(path.sep).join("/"))
      .filter((file) => file.endsWith(".json") && file !== "index.json");
    expect(sorted(onDisk)).toEqual(sorted(entries.map((entry) => entry.file)));
  });

  it("checks exactly as many fixtures as fixtures/index.json has entries, each by its own version's schema", () => {
    let checked = 0;
    for (const entry of entries) {
      const validate = validatorFor(entry);
      expect(
        validate(fixture(entry.file)),
        `${entry.file}: ${formatErrors(validate.errors).join("; ")}`,
      ).toBe(entry.expect === "accept");
      checked += 1;
    }
    expect(checked).toBe(entries.length);
    expect(report.entries).toHaveLength(checked);
    expect(report.passes + report.refusals).toBe(checked);
  });

  it("accepts every entry marked accept and refuses every entry marked refuse", () => {
    expect(report.passes).toBe(acceptedEntries.length);
    expect(report.refusals).toBe(refusedEntries.length);
    for (const result of report.entries) {
      expect(result.problems, result.file).toEqual([]);
      expect(result.outcome, result.file).toBe(result.expect === "accept" ? "accepted" : "refused");
    }
    expect(refusedEntries.length).toBeGreaterThan(0);
  });

  for (const entry of entries) {
    it(`${entry.expect === "accept" ? "accepts" : "refuses"} ${entry.file} (${entry.version}, ${String(entry.def)})`, () => {
      const result = must(report.entries.find((candidate) => candidate.file === entry.file));
      expect(result.schema).toBe(`event-trace.${entry.version}.schema.json`);
      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
      expect(accepts(entry, fixture(entry.file))).toBe(entry.expect === "accept");
    });
  }

  it("names a $defs entry on every fixture, and holds every version frozen.json names", () => {
    for (const entry of entries) expect(entry.def, entry.file).toBeDefined();
    const frozen = (readJson(path.join(EVENT_TRACE_DIR, "frozen.json")) as { frozen: string[] }).frozen;
    expect(frozen).toEqual(expect.arrayContaining(["v1", "v1.1"]));
    for (const version of frozen) expect(versions, version).toContain(version);
    for (const version of versions) {
      expect(SCHEMA_VERSIONS, `event-trace.${version}.schema.json`).toContain(version);
      expect(
        acceptedEntries.filter((entry) => entry.version === version).length,
        `${version} has accepted fixtures`,
      ).toBeGreaterThan(0);
    }
    for (const result of report.entries)
      expect(result.schema, result.file).toBe(`event-trace.${result.version}.schema.json`);
  });

  it("accepts every accepted fixture by every later minor version too (a minor version only adds)", () => {
    let checked = 0;
    for (const entry of acceptedEntries) {
      for (const later of laterMinorVersions(entry.version)) {
        const validate = validatorFor({ version: later, def: entry.def });
        expect(
          validate(fixture(entry.file)),
          `${entry.file} under ${later}: ${formatErrors(validate.errors).join("; ")}`,
        ).toBe(true);
        checked += 1;
      }
    }
    if (SCHEMA_VERSIONS.length > 1) expect(checked).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Each refusal tied to its reason (DL-124's mend-then-accept proof)

/** A refused fixture put right as its index entry and the README say ("with that one fault fixed it is accepted"). */
interface Mend {
  /** The one field the entry and the README name: the mend changes it and nothing else. */
  at: Path;
  /** The value put right there; with none, the field is dropped ("the words dropped"; "that fault removed"). */
  put?: () => unknown;
  /** The accepted fixture the README or the entry names: the mended copy is its `part`. */
  twin?: { file: string; part: Path };
}

const from =
  (file: string, where: Path): (() => unknown) =>
  () =>
    structuredClone(getAt(fixture(file), where));

/**
 * The mend of every refused fixture of the versions frozen when this part was written. README "Fixtures": "with that
 * one fault fixed (the handle id for the number, the words dropped, the bundle id added, the table open_questions for
 * event_log) it is accepted"; README v1.1: "Each refused fixture is the accepted row it names with one fault, and is
 * accepted once that fault is removed". The twins are the rows the entries name: the skeleton's receive span ("the
 * rest is the skeleton's receive span") and decide span, event-proof-code-sent.json, event-proof-code-checked.json and
 * event-harm-report.json's harm report row. A later minor version's refused fixtures are checked by part 1, and their
 * mends join this list with that version's QA task.
 */
const MENDED_VERSIONS = ["v1", "v1.1"];
const MENDS: Record<string, Mend | undefined> = {
  "invalid/refuse-raw-phone-in-span.json": {
    at: ["handle_ref"],
    put: from("trace-skeleton.json", ["spans", 0, "handle_ref"]),
    twin: { file: "trace-skeleton.json", part: ["spans", 0] },
  },
  "invalid/refuse-raw-text-in-span.json": { at: ["got", "words"] },
  "invalid/refuse-span-without-bundle-id.json": {
    at: ["bundle_id"],
    put: from("trace-skeleton.json", ["spans", 7, "bundle_id"]),
    twin: { file: "trace-skeleton.json", part: ["spans", 7] },
  },
  "invalid/refuse-event-update.json": { at: ["table_name"], put: () => "open_questions" },
  "invalid/refuse-proof-code-hash-in-clear.json": {
    at: ["new_values", "code_hash"],
    twin: { file: "event-proof-code-sent.json", part: [] },
  },
  "invalid/refuse-proof-code-typed-in-clear.json": {
    at: ["new_values", "typed"],
    twin: { file: "event-proof-code-checked.json", part: [] },
  },
  "invalid/refuse-harm-report-business-scope.json": {
    at: ["business_id"],
    put: from("event-harm-report.json", ["rows", 2, "business_id"]),
    twin: { file: "event-harm-report.json", part: ["rows", 2] },
  },
};

/** The copy of a refused fixture put right by its mend. */
function mended(file: string): unknown {
  const mend = must(MENDS[file], `the mend of ${file}`);
  const copy = structuredClone(fixture(file));
  if (mend.put === undefined) dropAt(copy, mend.at);
  else setAt(copy, mend.at, mend.put());
  return copy;
}

describe("event-trace fixtures: each refused fixture is refused for its one reason, and accepted put right", () => {
  it("holds a mend for every refused fixture of v1 and v1.1, selected by version, and no other", () => {
    expect(sorted(Object.keys(MENDS))).toEqual(
      sorted(
        refusedEntries.filter((entry) => MENDED_VERSIONS.includes(entry.version)).map((entry) => entry.file),
      ),
    );
  });

  for (const [file, mend] of Object.entries(MENDS)) {
    if (mend === undefined) continue;
    it(`${file}: refused for ${pointerOf(mend.at)}, and accepted with only that field put right`, () => {
      const entry = entryOf(file);
      expect(entry.expect).toBe("refuse");
      const refused = fixture(file);
      const right = mended(file);
      // The mend changes the field the entry names, and nothing else.
      const changed = differences(refused, right);
      expect(changed.length, "the mend changes something").toBeGreaterThan(0);
      for (const where of changed)
        expect(where.slice(0, mend.at.length), `${file} changes ${pointerOf(where)}`).toEqual(mend.at);
      // Refused by the schema, which names that field among its reasons; put right, it is accepted.
      const explain = validatorFor(entry, explainAjv);
      expect(explain(refused), `${file} is refused`).toBe(false);
      const at = pointerOf(mend.at);
      expect(
        (explain.errors ?? []).some((error) =>
          placesOf(error).some((place) => place === at || place.startsWith(`${at}/`)),
        ),
        `${file}: the schema's errors name ${at}: ${formatErrors(explain.errors).join("; ")}`,
      ).toBe(true);
      expect(
        accepts(entry, right),
        `${file} put right: ${formatErrors(validatorFor(entry).errors).join("; ")}`,
      ).toBe(true);
      if (mend.twin !== undefined) {
        expect(entryOf(mend.twin.file).expect, mend.twin.file).toBe("accept");
        expect(
          right,
          `${file} put right is ${mend.twin.file}'s ${pointerOf(mend.twin.part) || "whole"}`,
        ).toEqual(getAt(fixture(mend.twin.file), mend.twin.part));
      }
    });
  }

  it("refuses each mended copy again when it also carries a field the schema does not know", () => {
    for (const file of Object.keys(MENDS)) {
      const broken = { ...(mended(file) as Obj), notInTheSchema: 1 };
      expect(accepts(entryOf(file), broken), `${file} put right, with a field the schema does not know`).toBe(
        false,
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. The schema is not vacuous

describe("event-trace fixtures: removing a required field makes an accepted fixture refused", () => {
  for (const entry of acceptedEntries) {
    it(`${entry.file} (${entry.version}, ${String(entry.def)})`, () => {
      const validate = validatorFor(entry);
      const original = fixture(entry.file);
      expect(validate(original), formatErrors(validate.errors).join("; ")).toBe(true);
      const required = requiredPathsOf(entry);
      const root = required.filter((where) => where.length === 1).map((where) => String(where[0]));
      // The definition's own required fields, and at the root also those its dependentSchemas require of this value
      // (a person actor's id, the turn or the job, the person sealed values name, an outside call's provider).
      const own = ownRequiredOf(entry);
      expect(own.length, `${String(entry.def)} requires fields`).toBeGreaterThan(0);
      expect(root, "the walk finds the definition's own required fields").toEqual(
        expect.arrayContaining(own),
      );
      for (const where of required) {
        expect(
          validate(without(original, where)),
          `${entry.file} without ${pointerOf(where)} must be refused`,
        ).toBe(false);
      }
      expect(
        validate({ ...(original as Obj), notInTheSchema: 1 }),
        `${entry.file} with a field the schema does not know must be refused`,
      ).toBe(false);
    });
  }

  it("reads the required fields from the schemas: nested ones, the branch a value takes, and none that is optional", () => {
    const keys = (file: string): Set<string> => new Set(requiredPathsOf(entryOf(file)).map(keyOf));
    const holds = (file: string, wheres: Path[]): void => {
      const found = keys(file);
      for (const where of wheres) expect(found.has(keyOf(where)), `${file}: ${pointerOf(where)}`).toBe(true);
    };
    // Optional fields are present but never counted.
    const optional = (file: string, wheres: Path[]): void => {
      const found = keys(file);
      for (const where of wheres) {
        expect(getAt(fixture(file), where), `${file} has ${pointerOf(where)}`).toBeDefined();
        expect(found.has(keyOf(where)), `${file}: ${pointerOf(where)} is optional`).toBe(false);
      }
    };
    // A span's hop decides: receive names its provider, the safety read its model calls, the gate its limits, a dispatch
    // that sends its provider, call and attempt; and each nested bundle id, model call and limit has its own fields.
    holds("trace-skeleton.json", [
      ["spans", 0, "provider"],
      ["spans", 0, "bundle_id", "hash"],
      ["spans", 2, "model_calls"],
      ["spans", 2, "model_calls", 0, "cost_micro_usd"],
      ["spans", 8, "limits"],
      ["spans", 8, "limits", 0, "outcome"],
      ["spans", 12, "attempt"],
      ["spans", 15, "rows", 0, "id"],
    ]);
    optional("trace-skeleton.json", [
      ["spans", 0, "got"],
      ["spans", 0, "event_id"],
      ["spans", 0, "error_code"],
    ]);
    // A row names its turn (or its job); a person actor names the person; the answer and the proof have their fields.
    holds("event-commit.json", [
      ["rows", 0, "turn_id"],
      ["rows", 0, "actor_person_id"],
      ["rows", 0, "approved_by", "option_id"],
      ["rows", 0, "proofs", 0, "text_hash"],
      ["rows", 3, "actor_person_id"],
    ]);
    optional("event-commit.json", [
      ["rows", 0, "job_id"],
      ["rows", 0, "zone"],
      ["rows", 1, "approved_by"],
    ]);
    // Sealed values name the person whose key seals them; a consent row's approval names the consent.
    holds("event-stop-consent-row.json", [["sealed_for_person_id"], ["approved_by", "consent_id"]]);
    // A job's rows name the job, not a turn.
    holds("event-team-page-opened.json", [["rows", 0, "job_id"]]);
    optional("event-team-page-opened.json", [["rows", 0, "turn_id"]]);
    // An effect run and a port call name the vendor, the call and the try.
    holds("span-effect-run-retry.json", [["provider"], ["call"], ["attempt"]]);
    holds("span-places-call.json", [["provider"], ["call"], ["attempt"]]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. What the schema leaves to the test

describe("event-trace fixtures: the README's tables this test reads agree with the schemas", () => {
  it("lists the hops in the schema's order, and the kinds and their tables of v1 and v1.1", () => {
    expect(HOP_TABLE).toEqual(enumOf("v1", "hop"));
    expect(sorted(V1_KINDS_TABLE.flatMap((row) => row.kinds))).toEqual(sorted(enumOf("v1", "eventKind")));
    expect(sorted(ADDED_KINDS_TABLE.map((row) => row.kind))).toEqual(
      sorted(enumOf("v1.1", "addedEventKind")),
    );
    expect(
      sorted(ADDED_KINDS_TABLE.filter((row) => row.readBy === "team only").map((row) => row.kind)),
    ).toEqual(sorted(enumOf("v1.1", "teamOnlyEventKind")));
    // Each subject's table, where the README gives it, is a database table's name.
    expect(TABLE_OF.get("phone")).toBe("phones");
    expect(TABLE_OF.get("opener")).toBe("openers_sent");
    expect(TABLE_OF.get("effect")).toBe("effects");
    for (const table of TABLE_OF.values()) expect(table).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("reads the illustrative prices of README 'Fixtures', in hundredths of a micro-dollar a token", () => {
    expect(PRICES.haiku).toEqual({ input: 100, cached: 10, cacheWrite: 125, output: 500 });
    expect(PRICES.sonnet).toEqual({ input: 300, cached: 30, cacheWrite: 375, output: 1500 });
  });

  it("holds each added kind's columns and whether it inserts its row to the README's own sentence", () => {
    expect(sorted(Object.keys(ADDED_KIND_COLUMNS))).toEqual(sorted([...ADDED_KINDS]));
    const holds = sectionOf("### What each added kind holds", "### What the schema checks");
    for (const [kind, own] of Object.entries(ADDED_KIND_COLUMNS)) {
      if (own === undefined) continue;
      const start = holds.indexOf(`**\`${kind}\`**`);
      expect(start, kind).toBeGreaterThan(-1);
      const next = holds.indexOf("**`", start + kind.length + 4);
      const sentence = holds.slice(start, next === -1 ? undefined : next);
      for (const column of own.columns) expect(sentence, kind).toContain(`\`${column}\``);
      expect(sentence.includes("new:"), `${kind} inserts its row`).toBe(own.inserts);
    }
    for (const [kind, columns] of Object.entries(WORDS_COLUMNS))
      for (const column of columns ?? []) expect(ADDED_KIND_COLUMNS[kind]?.columns, kind).toContain(column);
  });
});

describe("event-trace fixtures: the skeleton trace's hops appear once each, in D-017's order", () => {
  const skeletons = acceptedOfDef("trace").filter((entry) => d017HopsOf(entry) !== null);

  it("names D-017's hops in the README's hop order (the turn order of BP section 10 D-017)", () => {
    expect(skeletons.length).toBeGreaterThan(0);
    for (const entry of skeletons) {
      const hops = must(d017HopsOf(entry));
      expect(hops.length, entry.file).toBeGreaterThan(10);
      const places = hops.map((hop) => HOP_TABLE.indexOf(hop));
      expect(places, `${entry.file}: every hop is in the README's table`).not.toContain(-1);
      expect(places, `${entry.file}: in the table's order`).toEqual([...places].sort((a, b) => a - b));
      expect(new Set(hops).size, entry.file).toBe(hops.length);
    }
  });

  it("runs every hop of D-017 once, in order, in each skeleton trace", () => {
    for (const entry of skeletons)
      expect(checkHopsOnceInOrder(fixture(entry.file) as Trace, must(d017HopsOf(entry))), entry.file).toEqual(
        [],
      );
  });

  it("fires on damaged copies the schema still takes: two hops swapped, a hop run twice", () => {
    const file = "trace-skeleton.json";
    const hops = must(d017HopsOf(entryOf(file)));
    const swapped = damaged<Trace>(file, (trace) => {
      must(trace.spans[4]).hop = "guard";
      must(trace.spans[5]).hop = "lease";
    });
    expect(accepts(entryOf(file), swapped), "the schema takes it").toBe(true);
    expect(checkHopsOnceInOrder(swapped, hops)).toEqual([expect.stringContaining("not in D-017's order")]);
    const twice = damaged<Trace>(file, (trace) => {
      must(trace.spans[5]).hop = "lease";
    });
    expect(accepts(entryOf(file), twice), "the schema takes it").toBe(true);
    expect(checkHopsOnceInOrder(twice, hops)).toEqual([
      "hop lease runs 2 times, not once",
      "hop guard runs 0 times, not once",
    ]);
  });
});

describe("event-trace fixtures: no span carries a raw number or text", () => {
  it("holds on every span of every accepted fixture", () => {
    const spans = inAccepted(spansIn);
    expect(spans.length).toBeGreaterThan(50);
    for (const { file, item } of spans) expect(checkNoRawNumberOrText(item), file).toEqual([]);
  });

  it("fires on damaged copies the schema still takes: a number inside a handle label, a number as a count", () => {
    const file = "trace-skeleton.json";
    const label = damaged<Trace>(file, (trace) => {
      must(trace.spans[0]).handle_ref = "handle-15555550100";
    });
    expect(accepts(entryOf(file), label), "the schema takes it").toBe(true);
    expect(checkNoRawNumberOrText(must(label.spans[0]))).toEqual([
      "span-sam-0000-01/handle_ref holds a run of 7 or more digits, a number",
    ]);
    const count = damaged<Trace>(file, (trace) => {
      must(must(trace.spans[5]).got).roles = 15555550100;
    });
    expect(accepts(entryOf(file), count), "the schema takes it").toBe(true);
    expect(checkNoRawNumberOrText(must(count.spans[5]))).toEqual([
      "span-sam-0000-06/got/roles is a count of 7 or more digits, a number",
    ]);
  });
});

describe("event-trace fixtures: each trace's spans run in order on its trace, bundle, turn and job", () => {
  it("holds on every trace of every accepted fixture", () => {
    const traces = inAccepted(tracesIn);
    expect(traces.length).toBeGreaterThan(4);
    for (const { file, item } of traces)
      expect(checkTraceSpans(item), `${file} ${item.trace_id}`).toEqual([]);
  });

  it("fires on damaged copies the schema still takes: seq, at, the bundle, the turn and the job", () => {
    const file = "trace-skeleton.json";
    const take = (trace: Trace, from = file): Trace => {
      expect(accepts(entryOf(from), trace), "the schema takes it").toBe(true);
      return trace;
    };
    const seq = take(
      damaged<Trace>(file, (trace) => {
        must(trace.spans[1]).seq = 3;
      }),
    );
    expect(checkTraceSpans(seq)).toEqual(["trace-sam-0000 span span-sam-0000-02 has seq 3, not 2"]);
    const back = take(
      damaged<Trace>(file, (trace) => {
        must(trace.spans[3]).at = "2026-10-19T14:01:49Z";
      }),
    );
    expect(checkTraceSpans(back)).toEqual([expect.stringContaining("span-sam-0000-04 starts at")]);
    const bundle = take(
      damaged<Trace>(file, (trace) => {
        must(trace.spans[6]).bundle_id = { ...trace.bundle_id, build: 2 };
      }),
    );
    expect(checkTraceSpans(bundle)).toEqual(["trace-sam-0000 span span-sam-0000-07 names another bundle"]);
    const early = take(
      damaged<Trace>(file, (trace) => {
        must(trace.spans[0]).turn_id = trace.turn_id;
      }),
    );
    expect(checkTraceSpans(early)).toEqual([
      "trace-sam-0000 span span-sam-0000-01 names the turn turn-s1-01-sam-join, not null",
    ]);
    const clock = "trace-clock-fire.json";
    const job = take(
      damaged<Trace>(clock, (trace) => {
        must(trace.spans[2]).job_id = "fire-clock-other";
      }),
      clock,
    );
    expect(checkTraceSpans(job)).toEqual([
      "trace-fire-oq-a7-03-alex-yoga span span-fire-alex-yoga-03 names the job fire-clock-other, not fire-clock-oq-a7-03-alex-yoga",
    ]);
  });
});

describe("event-trace fixtures: a joined trace's batch span names the turn whose trace lists it", () => {
  it("holds on every accepted trace set, and some trace there joins others", () => {
    const sets = acceptedOfDef("traceSet");
    expect(sets.length).toBeGreaterThan(0);
    let joined = 0;
    for (const entry of sets) {
      const traces = tracesIn("traceSet", fixture(entry.file));
      expect(checkJoinedTraces(traces), entry.file).toEqual([]);
      joined += traces.reduce((sum, trace) => sum + trace.joined_trace_ids.length, 0);
    }
    expect(joined).toBeGreaterThan(0);
    for (const entry of acceptedOfDef("trace"))
      expect(checkJoinedTraces(tracesIn("trace", fixture(entry.file))), entry.file).toEqual([]);
  });

  it("fires on damaged copies the schema still takes: another turn on the batch span, a joined trace not listed", () => {
    const file = "trace-batch-three-texts.json";
    const turn = damaged<{ traces: Trace[] }>(file, (set) => {
      must(must(set.traces[1]).spans.at(-1)).turn_id = "turn-alex-other";
    });
    expect(accepts(entryOf(file), turn), "the schema takes it").toBe(true);
    expect(checkJoinedTraces(turn.traces)).toEqual([
      "trace-alex-0004's batch span names the turn turn-alex-other, not turn-alex-three-1, whose trace lists it",
    ]);
    const unlisted = damaged<{ traces: Trace[] }>(file, (set) => {
      must(set.traces[0]).joined_trace_ids = ["trace-alex-0004"];
    });
    expect(accepts(entryOf(file), unlisted), "the schema takes it").toBe(true);
    expect(checkJoinedTraces(unlisted.traces)).toEqual([
      "trace-alex-0005 ends joinedTurn, but 0 traces of the set list it",
    ]);
  });
});

describe("event-trace fixtures: the rows of the event log", () => {
  const rows = inAccepted(rowsIn);

  it("puts each commit's rows under one turn or job and one trace", () => {
    const batches = acceptedOfDef("eventLogBatch");
    expect(batches.length).toBeGreaterThan(0);
    for (const entry of batches)
      expect(checkBatchRows(rowsIn("eventLogBatch", fixture(entry.file))), entry.file).toEqual([]);
    const file = "event-commit.json";
    const other = damaged<{ rows: EventRow[] }>(file, (batch) => {
      must(batch.rows[2]).trace_id = "trace-alex-0009";
    });
    expect(accepts(entryOf(file), other), "the schema takes it").toBe(true);
    expect(checkBatchRows(other.rows)).toEqual(["evlog-alex-0008-3 is not under evlog-alex-0008-1's trace"]);
  });

  it("names, for every row's kind, the table its subject names in the README's kinds tables", () => {
    expect(rows.length).toBeGreaterThan(20);
    for (const { file, item } of rows) expect(checkKindTable(item), file).toEqual([]);
    const file = "event-commit.json";
    const booking = damaged<{ rows: EventRow[] }>(file, (batch) => {
      must(batch.rows[1]).table_name = "bookings";
    });
    expect(accepts(entryOf(file), booking), "the schema takes it").toBe(true);
    expect(checkKindTable(must(booking.rows[1]))).toEqual([
      "evlog-alex-0008-2: reservation.booked names the table bookings, not reservations",
    ]);
    const harm = "event-harm-report.json";
    const page = damaged<{ rows: EventRow[] }>(harm, (batch) => {
      must(batch.rows[2]).table_name = "team_pages";
    });
    expect(accepts(entryOf(harm), page), "the schema takes it").toBe(true);
    expect(checkKindTable(must(page.rows[2]))).toEqual([
      "evlog-alex-0205-3: harm_report.filed names the table team_pages, not harm_reports",
    ]);
  });

  it("holds no person's words, phone number or email address in a plain value, at any depth", () => {
    for (const { file, item } of rows) expect(checkPlainValues(item), file).toEqual([]);
    // Words are found where the README puts Rosie's own words and the safety read's labels, and nowhere else.
    expect(rows.some(({ item }) => /\s/.test(JSON.stringify(item.new_values?.summary ?? "")))).toBe(true);
    const commit = "event-commit.json";
    const words = damaged<{ rows: EventRow[] }>(commit, (batch) => {
      must(must(batch.rows[0]).new_values).reply = "Sat 2pm works";
    });
    expect(accepts(entryOf(commit), words), "the schema takes it").toBe(true);
    expect(checkPlainValues(must(words.rows[0]))).toEqual([
      "evlog-alex-0008-1/new_values/reply holds words, which go sealed",
    ]);
    const email = damaged<{ rows: EventRow[] }>(commit, (batch) => {
      must(must(batch.rows[0]).new_values).answered_by = { who: { email: "alex@example.invalid" } };
    });
    expect(accepts(entryOf(commit), email), "the schema takes it, past the depth it looks").toBe(true);
    expect(checkPlainValues(must(email.rows[0]))).toEqual([
      "evlog-alex-0008-1/new_values/answered_by/who/email holds an email address",
    ]);
    const gap = "event-gap-case-logged.json";
    const phone = damaged<EventRow>(gap, (row) => {
      const read = must(must(row.new_values).versions_read as Obj[] | undefined);
      must(read[0]).note = "+15555550123";
    });
    expect(accepts(entryOf(gap), phone), "the schema takes it, past the depth it looks").toBe(true);
    expect(checkPlainValues(phone)).toEqual([
      "evlog-alex-0005-1/new_values/versions_read/0/note holds a phone number",
    ]);
  });

  it("exports the stored row unchanged, saying whether its key was held or erased", () => {
    const exports = acceptedOfDef("exportRow");
    expect(exports.length).toBeGreaterThan(0);
    const stored = (id: string): EventRow | undefined =>
      rows.find(({ file, item }) => item.id === id && entryOf(file).def !== "exportRow")?.item;
    let compared = 0;
    for (const entry of exports) {
      const exported = fixture(entry.file) as ExportRow;
      const row = stored(exported.row.id);
      if (row !== undefined) compared += 1;
      expect(checkExportRow(exported, row), entry.file).toEqual([]);
    }
    expect(compared, "an export row has its stored row among the fixtures").toBeGreaterThan(0);
    const file = "event-erased-person.json";
    const edited = damaged<ExportRow>(file, (exported) => {
      must(exported.row.new_values).stopped = false;
    });
    expect(accepts(entryOf(file), edited), "the schema takes it").toBe(true);
    expect(checkExportRow(edited, stored(edited.row.id))).toEqual([
      "the export of evlog-ben-stop-1 is not the stored row unchanged",
    ]);
    const keyless = damaged<ExportRow>(file, (exported) => {
      exported.sealed_key = null;
    });
    expect(accepts(entryOf(file), keyless), "the schema takes it").toBe(true);
    expect(checkExportRow(keyless, stored(keyless.row.id))).toEqual([
      "sealed_key is null for a row with sealed values",
    ]);
  });
});

describe("event-trace fixtures: the measures read from traces", () => {
  it("gives a reply time that is the difference of its two instants, and that its turn's traces give", () => {
    const replies = acceptedOfDef("replyTime");
    expect(replies.length).toBeGreaterThan(0);
    let readAgain = 0;
    for (const entry of replies) {
      const reply = fixture(entry.file) as ReplyTime;
      expect(checkReplyTime(reply), entry.file).toEqual([]);
      for (const source of acceptedEntries) {
        const traces = tracesIn(defOf(source), fixture(source.file));
        if (!traces.some((trace) => trace.trace_id === reply.trace_id && trace.turn_id === reply.turn_id))
          continue;
        expect(checkReplyTimeFromTraces(reply, traces), `${entry.file} against ${source.file}`).toEqual([]);
        readAgain += 1;
      }
    }
    expect(readAgain, "a reply time is read again from its turn's traces").toBeGreaterThan(0);
  });

  it("fires on damaged reply times the schema still takes: the time, the last text, the rewrite", () => {
    const file = "measure-reply-time.json";
    const traces = tracesIn("traceSet", fixture("trace-batch-three-texts.json"));
    const take = (reply: ReplyTime): ReplyTime => {
      expect(accepts(entryOf(file), reply), "the schema takes it").toBe(true);
      return reply;
    };
    const time = take(
      damaged<ReplyTime>(file, (reply) => {
        reply.ms = 6900;
      }),
    );
    expect(checkReplyTime(time)).toEqual(["ms is 6900, but its two instants are 6800 ms apart"]);
    const earlier = take(
      damaged<ReplyTime>(file, (reply) => {
        reply.last_text_event_id = "evt-alex-0004";
        reply.last_text_at = "2026-10-22T16:00:02Z";
        reply.ms = 8800;
      }),
    );
    expect(checkReplyTime(earlier)).toEqual([]);
    expect(checkReplyTimeFromTraces(earlier, traces)).toEqual([
      "last_text_event_id and last_text_at are not the last text's arrival",
    ]);
    const rewrite = take(
      damaged<ReplyTime>(file, (reply) => {
        reply.rewrite = true;
      }),
    );
    expect(checkReplyTimeFromTraces(rewrite, traces)).toEqual([
      "rewrite is true, but the trace says otherwise",
    ]);
  });

  it("costs each model call by its tokens at the README's prices, and sums a stated total", () => {
    const spans = inAccepted(spansIn);
    const calls = spans.flatMap(({ item }) => item.model_calls ?? []);
    expect(new Set(calls.map((call) => call.role))).toEqual(new Set(["haiku", "sonnet"]));
    expect(calls.some((call) => call.cache_write_tokens > 0)).toBe(true);
    for (const { file, item } of spans) expect(checkModelCallCosts(item), file).toEqual([]);
    let totals = 0;
    for (const entry of acceptedEntries) {
      const stated = /(\d+) micro-dollars in all/.exec(entry.shows)?.[1];
      if (stated === undefined) continue;
      const sum = spansIn(defOf(entry), fixture(entry.file))
        .flatMap((span) => span.model_calls ?? [])
        .reduce((total, call) => total + call.cost_micro_usd, 0);
      expect(sum, entry.file).toBe(Number(stated));
      totals += 1;
    }
    expect(totals, "a fixture states its total").toBeGreaterThan(0);
  });

  it("fires on damaged model calls the schema still takes: a cost off its tokens, a role off its model", () => {
    const file = "trace-model-call-cost.json";
    const cost = damaged<Trace>(file, (trace) => {
      must(must(trace.spans[8]).model_calls?.[0]).cost_micro_usd += 100;
    });
    expect(accepts(entryOf(file), cost), "the schema takes it").toBe(true);
    expect(checkModelCallCosts(must(cost.spans[8]))).toEqual([
      "span-sam-0042-09 model_calls[0]: costs 9010 micro-dollars, but its tokens cost 8910",
    ]);
    const role = damaged<Trace>(file, (trace) => {
      must(must(trace.spans[8]).model_calls?.[0]).role = "haiku";
    });
    expect(accepts(entryOf(file), role), "the schema takes it").toBe(true);
    expect(checkModelCallCosts(must(role.spans[8]))).toEqual([
      "span-sam-0042-09 model_calls[0]: claude-sonnet-5-5 is not the bundle's haiku model",
      "span-sam-0042-09 model_calls[0]: costs 8910 micro-dollars, but its tokens cost 2970",
    ]);
  });

  it("names each breach's trace in an hourly run of the three hard invariants", () => {
    // The hard invariants, as $defs/invariantCheck closes their list (arch 08 line 427).
    const known = must(
      ((defNode("v1", "invariantCheck").properties as Obj).invariant as Obj).enum as string[] | undefined,
      "invariantCheck's list of invariants",
    );
    expect(known).toHaveLength(3);
    const runs = acceptedOfDef("invariantRun");
    expect(runs.length).toBeGreaterThan(0);
    for (const entry of runs)
      expect(checkInvariantRun(fixture(entry.file) as InvariantRun, known), entry.file).toEqual([]);
    const file = "measure-invariant-run.json";
    const breach = damaged<InvariantRun>(file, (run) => {
      must(run.checks[0]).breaches = 1;
    });
    expect(accepts(entryOf(file), breach), "the schema takes it").toBe(true);
    expect(checkInvariantRun(breach, known)).toEqual([
      "noChargeWithoutBoundYes: 1 breaches with 0 trace ids",
    ]);
    const long = damaged<InvariantRun>(file, (run) => {
      run.window_to = "2026-10-23T16:00:00Z";
    });
    expect(accepts(entryOf(file), long), "the schema takes it").toBe(true);
    expect(checkInvariantRun(long, known)).toEqual([
      "the window is not one hour",
      "the run ended before its hour did",
    ]);
  });
});

describe("event-trace fixtures: v1.1's added kinds", () => {
  const rows = inAccepted(rowsIn);
  const added = rows.filter(({ item }) => ADDED_KINDS.has(item.kind));

  it("names in each added kind's values only its columns, every one when the row is inserted", () => {
    expect(added.length).toBeGreaterThan(15);
    for (const { file, item } of added) expect(checkAddedKindColumns(item), file).toEqual([]);
  });

  it("fires on damaged rows the schema still takes: a column of no kind, a column left out, a claim's tries", () => {
    const hold = "event-safety-outcome-hold.json";
    const extra = damaged<{ rows: EventRow[] }>(hold, (batch) => {
      must(must(batch.rows[2]).new_values).note = "urgent";
    });
    expect(accepts(entryOf(hold), extra), "the schema takes it").toBe(true);
    expect(checkAddedKindColumns(must(extra.rows[2]))).toEqual([
      "evlog-alex-0204-3: hand_off.created names no column note",
    ]);
    const link = "event-chat-link-issued.json";
    const short = damaged<EventRow>(link, (row) => {
      dropAt(row, ["new_values", "issued_at"]);
    });
    expect(accepts(entryOf(link), short), "the schema takes it").toBe(true);
    expect(checkAddedKindColumns(short)).toEqual([
      "evlog-page-ben-0001-1: chat_link.issued leaves out issued_at",
    ]);
    const outage = "event-effect-claimed-outage.json";
    const tries = damaged<EventRow>(outage, (row) => {
      must(row.new_values).tries = 1;
    });
    expect(accepts(entryOf(outage), tries), "the schema takes it").toBe(true);
    expect(checkAddedKindColumns(tries)).toEqual([
      "log-eff-cal-riley-alex-nov14-write-run-2-claim-1: after an outage, tries go back to 0 and runs up by one",
    ]);
    const pending = "event-effect-claimed-pending.json";
    const start = damaged<EventRow>(pending, (row) => {
      dropAt(row, ["new_values", "first_try_at"]);
    });
    expect(accepts(entryOf(pending), start), "the schema takes it").toBe(true);
    expect(checkAddedKindColumns(start)).toEqual([
      "log-eff-cal-riley-alex-nov14-write-run-1-claim-1: first_try_at goes with a run that starts, from pending or outage",
    ]);
  });

  it("builds the review item rows no fixture shows (waiting and decided), with no business, as the README asks", () => {
    // README v1.1 "Fixtures": "No fixture shows a review item waiting or decided: Rosie's team has no member in the
    // sample cast (K-37's open gap), so the contract test builds those rows." Built on event-review-item-opened.json's
    // item, with K-37's states (open, waiting with wait_until, done with decided_at, decided_by_person_id and outcome);
    // the team member is an id only, since the sample cast names none. Which kinds of item may wait (S11-52) is K-37's
    // rule, not K-08's: K-08 checks the kind, its columns, its table and that the row carries no business.
    const opened = fixture("event-review-item-opened.json") as EventRow & Obj;
    const decision = {
      ...opened,
      turn_id: null,
      job_id: "console-req-team-review-1",
      trace_id: "trace-console-team-review-1",
      actor_kind: "person",
      actor_person_id: "person-team-reviewer",
      actor_role: null,
    };
    const waiting = {
      ...decision,
      id: "evlog-console-team-review-1-1",
      at: "2026-10-20T15:00:00Z",
      kind: "review_item.waiting",
      old_values: { state: "open", wait_until: null },
      new_values: { state: "waiting", wait_until: "2026-10-23T15:00:00Z" },
    };
    const decided = {
      ...decision,
      id: "evlog-console-team-review-1-2",
      at: "2026-10-20T16:00:00Z",
      kind: "review_item.decided",
      old_values: { state: "waiting", decided_at: null, decided_by_person_id: null, outcome: null },
      new_values: {
        state: "done",
        decided_at: "2026-10-20T16:00:00Z",
        decided_by_person_id: "person-team-reviewer",
        outcome: "Services checked against the official rules; the plug-in may go live.",
      },
    };
    const v11 = { version: "v1.1", def: "eventLogRow" };
    for (const row of [waiting, decided]) {
      const validate = validatorFor(v11);
      expect(validate(row), `${row.kind}: ${formatErrors(validate.errors).join("; ")}`).toBe(true);
      expect(accepts({ version: "v1", def: "eventLogRow" }, row), `${row.kind} is no v1 kind`).toBe(false);
      expect(checkAddedKindColumns(row), row.kind).toEqual([]);
      expect(checkKindTable(row), row.kind).toEqual([]);
      expect(checkPlainValues(row), row.kind).toEqual([]);
      expect(
        accepts(v11, { ...row, business_id: "biz-lees-barbershop" }),
        `${row.kind} with a business`,
      ).toBe(false);
    }
  });

  it("holds nothing that never appears inside an added kind's sealed bytes", () => {
    const sealed = added.filter(({ item }) => typeof item.sealed_values === "string");
    expect(sealed.length).toBeGreaterThan(0);
    for (const { file, item } of added) expect(checkSealedBytes(item), file).toEqual([]);
    const harm = "event-harm-report.json";
    const typed = damaged<{ rows: EventRow[] }>(harm, (batch) => {
      must(batch.rows[2]).sealed_values = sealedOfText("typed=482913");
    });
    expect(accepts(entryOf(harm), typed), "the schema takes it").toBe(true);
    expect(checkSealedBytes(must(typed.rows[2]))).toEqual([
      "evlog-alex-0205-3: its sealed bytes name typed",
      "evlog-alex-0205-3: its sealed bytes hold a code or a hash",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The sides: where each producer and consumer side is added

export interface SideCheck {
  id: string;
  side: "producer" | "consumer";
  owner: string;
  components: string[];
  needs: string;
  /** Added by the QA side task for this side; it returns one line per problem. */
  check?: () => string[];
}

/**
 * ops/plan/02-contracts.md K-08 and section 2 item 12: each producer's output is checked, and each consumer accepts
 * every valid fixture and refuses every invalid one. Each side's components under their owner as
 * contracts/event-trace/README.md names them ("Producers and consumers (02-contracts K-08)", with v1.1's writers and
 * readers). Each side is added later by a QA side task that depends on this task and on that side's build task: it
 * fills `check` (and moves its own test beside this one), reusing this file's checks on what the side writes or reads.
 * Until then the side is held here with what it must show, so none is forgotten.
 */
export const SIDE_CHECKS: readonly SideCheck[] = [
  {
    id: "producer-runtime",
    side: "producer",
    owner: "runtime engineer",
    components: [
      "C-044 gateway",
      "C-046 to C-056",
      "C-124 to C-129",
      "C-047 safety read on arrival",
      "C-054 clock rows",
    ],
    needs:
      "Every hop the runtime runs (receive, scrub, safetyRead, batch, lease, guard, dispatch, providerAccepted, delivered, clockArmed, clockFired) writes one span, one log line, that passes `span`: one trace id from webhook to delivery receipt, seq from 1 with at never going back, every span on the trace's bundle id, the turn id from the batch on, never a raw number or words (checkTraceSpans, checkNoRawNumberOrText); a batched text's own trace ends at its batch span, joinedTurn, naming the turn whose trace lists it (checkJoinedTraces); the skeleton's trace runs every hop of D-017 once, in order (checkHopsOnceInOrder); and, v1.1, the outcome the safety read hands on and the clock firings that escalate a hand-off and repeat a page are written as the v1.1 fixtures show.",
  },
  {
    id: "producer-ai",
    side: "producer",
    owner: "AI engineer",
    components: ["C-113 safety read", "C-121 AI gateway"],
    needs:
      "The safety read, decide, re-read, planner and compose spans carry every model call with its model id, role, purpose, tokens, cached and cache-write tokens, cost and outcome (a refusal or a cut-off output is failed), and each cost follows from its tokens and the price list in force (checkModelCallCosts).",
  },
  {
    id: "producer-action-layer",
    side: "producer",
    owner: "action-layer engineer",
    components: [
      "C-074 Tool API",
      "C-080 policy gate",
      "C-087 one commit per turn",
      "C-109 effects runner",
      "C-110 Agent API",
      "C-104 safety and hand-offs",
      "C-095 proof codes",
      "C-103 chat link and QR",
      "C-117",
    ],
    needs:
      "The gate span logs limits 1 to 6, the commit appends its rows as one eventLogBatch under its turn or job and its trace (checkBatchRows), each row of a kind from the closed list naming its subject's table (checkKindTable), private values sealed under one person's key and no words, number or address in a plain value (checkPlainValues); the effects runner's and the Agent API's spans name provider, call and attempt; and, v1.1, every added kind is written with its columns (checkAddedKindColumns), a team-only kind with no business, nothing never-logged plain or sealed (checkSealedBytes), and effect.claimed once the K-05 minor version appends it.",
  },
  {
    id: "producer-integrations",
    side: "producer",
    owner: "integrations engineer",
    components: ["C-206 to C-220"],
    needs:
      "Every outside call an adapter makes is a span naming its provider from the closed list, its port call and its attempt (a dispatch's send, an effectRun, a portCall), with what it got and decided as counts, yes or no and labels: never the vendor in got or decided, never a raw number or words (checkNoRawNumberOrText).",
  },
  {
    id: "producer-frontend",
    side: "producer",
    owner: "frontend engineer",
    components: ["C-185 web app shell"],
    needs:
      "Each secure page's call to the Tool API opens its own trace (opened_by pageRequest) whose pageRequest span passes `span`, under the page's request id as its job, never a raw number or words.",
  },
  {
    id: "consumer-release",
    side: "consumer",
    owner: "release engineer",
    components: [
      "C-016 CI rollback job",
      "C-017 traces and dashboards",
      "C-018 breach and latency monitor",
      "C-037 warehouse export",
    ],
    needs:
      "The traces and dashboards read every accepted trace and trace set by trace_id ordered by seq, and filter by bundle and provider; the monitor reads reply time as the fixtures measure it and the hourly invariant run with each breach's trace id for the rollback alert; the export writes each stored row unchanged with sealed_key held or erased (checkExportRow), and v1.1's team-only rows carry no business; each refuses every invalid one.",
  },
  {
    id: "consumer-qa",
    side: "consumer",
    owner: "QA",
    components: ["C-140 eval harness", "C-142 replay", "C-143 cost meter", "C-148 end-to-end tests"],
    needs:
      "The eval harness and replay read the event log and traces in the fixtures' shapes, v1.1's added kinds included; the cost meter sums the spans' model calls (27300 micro-dollars for trace-model-call-cost.json); the end-to-end tests see every hop of D-017 once, in order, and a repeated webhook dropped at receipt; each refuses every invalid one.",
  },
  {
    id: "consumer-frontend",
    side: "consumer",
    owner: "frontend engineer",
    components: ["C-194 team console", "C-192 owner console"],
    needs:
      "The team console shows gap cases with their state, and v1.1's hand-offs, pages and review items, from rows in the fixtures' shapes; the owner console shows only the business's own hand-offs, never a team-only row; each refuses every invalid one.",
  },
  {
    id: "consumer-database",
    side: "consumer",
    owner: "database engineer",
    components: ["C-156 per-person sealing keys", "C-151"],
    needs:
      "Every accepted row, v1.1's added kinds included, lands in K-04 v1's event_log column for column, its sealed values under the key of sealed_for_person_id and unreadable once that key is erased, while the proofs stay; an edit of event_log itself is refused; it refuses every invalid one.",
  },
];

describe("event-trace sides: the list where each producer and consumer side is added", () => {
  const listed = sectionOf("## Producers and consumers (02-contracts K-08)", "## Fixtures");

  it("names each side once, with the README's producers and consumers, each consumer refusing every invalid one", () => {
    const ids = SIDE_CHECKS.map((side) => side.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SIDE_CHECKS.filter((side) => side.side === "producer").length).toBeGreaterThan(3);
    expect(SIDE_CHECKS.filter((side) => side.side === "consumer").length).toBeGreaterThan(3);
    for (const side of SIDE_CHECKS) {
      expect(side.owner, side.id).not.toBe("");
      expect(side.components.length, side.id).toBeGreaterThan(0);
      expect(side.needs, side.id).not.toBe("");
      if (side.side === "consumer") expect(side.needs, side.id).toMatch(/refuses every invalid one/i);
    }
  });

  it("names every component the README's producers and consumers list, and no other", () => {
    const named = new Set(listed.match(/C-\d{3}/g));
    const held = new Set(SIDE_CHECKS.flatMap((side) => side.components.join(" ").match(/C-\d{3}/g) ?? []));
    expect(named.size).toBeGreaterThan(20);
    expect(sorted([...held])).toEqual(sorted([...named]));
  });

  it("spells each side's owner and components as the README does", () => {
    for (const side of SIDE_CHECKS) {
      expect(listed, side.id).toContain(side.owner);
      for (const component of side.components) expect(listed, side.id).toContain(component);
    }
  });

  it("holds a producer side for every hop's lane and the consumers 02-contracts K-08 names", () => {
    const owners = (side: "producer" | "consumer"): Set<string> =>
      new Set(SIDE_CHECKS.filter((candidate) => candidate.side === side).map((candidate) => candidate.owner));
    for (const owner of [
      "runtime engineer",
      "AI engineer",
      "action-layer engineer",
      "integrations engineer",
      "frontend engineer",
    ])
      expect(owners("producer").has(owner), owner).toBe(true);
    for (const owner of ["release engineer", "QA", "frontend engineer", "database engineer"])
      expect(owners("consumer").has(owner), owner).toBe(true);
  });

  for (const side of SIDE_CHECKS) {
    if (side.check === undefined) continue;
    const check = side.check;
    it(`${side.side} side ${side.id}`, () => {
      expect(check()).toEqual([]);
    });
  }
});
