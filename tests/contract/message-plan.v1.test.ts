// Contract test for K-03 v1, the composer's message plan and slots (T-082; ops/plan/02-contracts.md K-03 "Contract
// test" and section 2 item 12; contracts/message-plan/README.md "Producers and consumers").
//
// This is the fixture part. The contract test has two parts: this one, which reads only the committed fixtures, and
// one part per producer or consumer side, added later by a QA side task that depends on this task and on that side's
// build task. SIDE_CHECKS (at the end) is the list where each side is added.
//
// K-03 is frozen at v1 and v1.1 (T-1104), and fixtures/index.json lists both versions' fixtures. The checks here are
// v1's own and read v1's entries only, selected by `version` (DL-125, DL-153). The T-003 harness still checks every
// entry against the schema its own `version` names, and each entry that names a rule is run through that rule, as
// inbound-event.v1.test.ts does. v1.1's own part is QA's task (contracts/message-plan/README.md "v1.1").
//
// What this part proves:
//   1. every fixture in contracts/message-plan/fixtures/index.json is checked against its $defs entry (the T-003
//      harness): accepted ones are accepted, refused ones are refused (an entry that names a rule of
//      message-plan.rules.mjs passes the schema and is decided by that rule), none is left out; v1's counts are v1's
//      own; each refused v1 fixture is refused for its one reason (put right, it is accepted);
//   2. the schema is not vacuous: removing any one required field from a copy of an accepted fixture makes the copy
//      refused, and so does one field the schema does not know;
//   3. what the schema cannot check and the fixtures can show (the README's list), each also run on a damaged copy
//      to show that it fires:
//        - slotName, the slottedText pattern, linkSlot and slots.json name the same 52 slots, each once, with the
//          kinds, proposed names, filler and sensitive forms the README states; K-01's closed slot list less hold is
//          35 names, all here; every slot the K-01 sample bundles use, and every slot the K-03 fixtures use, is in
//          slots.json (02-contracts K-03 "Contract test");
//        - for the pair input-s1-02 with plan-s1-02: the plan's formats, page type, option ids, links and thread
//          target are the input's (C-092, C-128 judge this on any pair; here the pair the fixtures hold);
//        - a plan's shape: the lines in order, a tapback alone, a poll with 2 to 5 option ids, at most two sends;
//        - an email copy reuses its text row's plan; the final parts follow the plan (the sends its formats name,
//          its lines with every slot filled), keep the fixed lines K-01 knows and carry the card's own link;
//        - a check result: each check once, a detail only where it failed, its outcome following from its attempt
//          and its failed checks, and the fault each failed check names visible in the checked parts (and not
//          visible where it passed); each check-* fixture states one expected result.
//   What needs a producer or consumer side is on SIDE_CHECKS, not checked here: the message checks themselves
//   (C-092; T-312), the composer, the allowed-format rules, the fill of slots and fixed lines, the claim check.

import { readdirSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  CONTRACTS_ROOT,
  checkContractFixtures,
  formatErrors,
  type EntryResult,
  type FixtureEntry,
} from "./_harness";

// ---------------------------------------------------------------------------------------------------------------
// The fixtures

const PLAN_DIR = path.join(CONTRACTS_ROOT, "message-plan");
const FIXTURES_DIR = path.join(PLAN_DIR, "fixtures");
const BUNDLE_DIR = path.join(CONTRACTS_ROOT, "bundle");
const BUNDLE_FIXTURES_DIR = path.join(BUNDLE_DIR, "fixtures");
const SCHEMA_FILE = "message-plan.v1.schema.json";

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** An index entry; `rule` names a rule of message-plan.rules.mjs (contracts/common/fixtures-index.meta.schema.json). */
type Entry = FixtureEntry & { rule?: string };

const index = readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: Entry[] };
/** v1's entries of the shared index (v1 and v1.1 list their fixtures in it): v1's counts and checks read these. */
const entries = index.fixtures.filter((entry) => entry.version === "v1");
const fixture = (file: string): unknown => readJson(path.join(FIXTURES_DIR, ...file.split("/")));
const bundleFixture = (file: string): unknown => readJson(path.join(BUNDLE_FIXTURES_DIR, ...file.split("/")));

/** A value a fixture must hold; the fixtures are checked against the schema first, so a miss is a broken test. */
function must<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("a fixture lacks a value this test reads");
  return value;
}

// What the checks read. The fixtures are checked against the schema first (part 1), so a cast to these shapes
// reads only fields the schema requires.
interface Line {
  role: string;
  text: string;
}
interface Question {
  text: string;
  optionIds: string[];
}
interface Plan {
  formats: string[];
  lines: Line[];
  question: Question | null;
  pageType: string | null;
  threadReplyTo: string | null;
}
interface RowPlan {
  row: string;
  channel: string;
  copyOf: string | null;
  plan: Plan;
}
interface Option {
  id: string;
  label: string;
}
interface ComposeInput {
  row: string;
  turn: string;
  conversation: unknown[];
  masterText: { step: string; text: string };
  allowedFormats: string[];
  allowedLinks: string[];
  options: Option[];
  pageTypes: string[];
  openQuestions: { id: string; text: string }[];
  inbound: { text: string } | null;
}
interface Fact {
  slot: string;
  value: string;
}
interface Send {
  kind: string;
  text: string | null;
  calendarFile: string;
  options: Option[];
  link: string | null;
}
interface FinalParts {
  row: string;
  channel: string;
  sends: Send[];
  fixedLines: string[];
  slotValues: Fact[];
  threadReplyTo: string | null;
}
interface CheckOutcome {
  check: string;
  passed: boolean;
  detail: string | null;
}
interface CheckResult {
  row: string;
  attempt: string;
  checked: FinalParts;
  checks: CheckOutcome[];
  outcome: string;
  questionWithdrawn: boolean;
  teamPaged: boolean;
}
interface Slot {
  name: string;
  kind: string;
  status: string;
  means: string;
  filledBy: string;
  sensitiveForm: string;
}
interface SlotVocabulary {
  slots: Slot[];
}

const acceptedFiles = entries.filter((entry) => entry.expect === "accept").map((entry) => entry.file);
const checkFiles = acceptedFiles.filter((file) => file.startsWith("check-"));
const planFiles = acceptedFiles.filter((file) => file.startsWith("plan-") && file !== "plan-email-copy.json");

const vocabulary = fixture("slots.json") as SlotVocabulary;
const input = fixture("input-s1-02.json") as ComposeInput;
const plan = fixture("plan-s1-02.json") as Plan;
const confirmation = fixture("plan-confirmation-a6-14.json") as Plan;
const emailCopy = fixture("plan-email-copy.json") as RowPlan;
const finalParts = fixture("final-two-sends.json") as FinalParts;
const checkResults = new Map(checkFiles.map((file) => [file, fixture(file) as CheckResult]));
const checkResult = (file: string): CheckResult => must(checkResults.get(file));

// ---------------------------------------------------------------------------------------------------------------
// The schema, one validator for everything (the harness's strict Ajv 2020-12 setup, and the bundle schema that the
// plan's masterText and fixedLines refer to)

const ajv = new Ajv2020({ strict: true, strictRequired: false });
for (const folder of [path.join(CONTRACTS_ROOT, "common"), BUNDLE_DIR, PLAN_DIR]) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".schema.json"))
      ajv.addSchema(readJson(path.join(folder, entry.name)) as object);
  }
}
const schema = readJson(path.join(PLAN_DIR, SCHEMA_FILE)) as {
  $id: string;
  $defs: Record<string, { required?: string[]; enum?: string[]; pattern?: string }>;
};

const defValidator = (def: string): ValidateFunction => {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${def}`);
  if (validate === undefined) throw new Error(`no schema for ${def}`);
  return validate;
};
function validatorFor(entry: FixtureEntry): ValidateFunction {
  return defValidator(must(entry.def));
}
const requiredOf = (entry: FixtureEntry): string[] => schema.$defs[must(entry.def)]?.required ?? [];

// The named rules (message-plan.rules.mjs, v1.1's): an entry that names one is decided by it once the schema
// takes it, as contracts/scripts/check-fixtures.mjs runs it. No v1 entry names a rule.
type Rule = (payload: unknown) => string[];
const rulesFile = path.join(PLAN_DIR, "message-plan.rules.mjs");
const { rules } = (await import(pathToFileURL(rulesFile).href)) as { rules: Record<string, Rule> };
const rule = (name: string): Rule => must(rules[name]);

// ---------------------------------------------------------------------------------------------------------------
// Checks that read only fixtures. Each returns one line per problem; an empty list means the check holds.

const SLOT_USE = /\{\{\s*([^{}:|\s]+)\s*(?=[:|}])/g;

/** The slot names a text uses ({{name}}, {{name:example}}, {{name:example|other}}; SPEC-master 5h). */
export function slotsIn(text: string): string[] {
  return [...text.matchAll(SLOT_USE)].map((match) => must(match[1]));
}

/** Every string a JSON value holds, at any depth. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

/** The slots a value uses that the vocabulary lacks. */
export function slotsOutsideVocabulary(value: unknown, names: ReadonlySet<string>): string[] {
  return [...new Set(strings(value).flatMap(slotsIn))].filter((name) => !names.has(name)).sort();
}

const duplicates = (names: string[]): string[] => names.filter((name, i) => names.indexOf(name) !== i);
const unescapeName = (name: string): string => name.replaceAll("\\.", ".");

/** The names the slottedText pattern lists (its first group, after the opening of a slot). */
export function namesOfPattern(pattern: string): string[] {
  const group = /\\\{\\\{\(([^)]*)\)\(:/.exec(pattern)?.[1];
  return (group ?? "").split("|").map(unescapeName);
}

/** The names K-01's closed slot list holds (bundle.v1.schema.json, messagesWithUnknownSlot). */
export function namesOfBundleList(pattern: string): string[] {
  const group = /\(\?!\(([^)]*)\)/.exec(pattern)?.[1];
  return (group ?? "").split("|").map(unescapeName);
}

const KIND_COUNTS: Record<string, number> = {
  record: 16,
  autofill: 8,
  amount: 6,
  ledger: 5,
  send: 2,
  link: 4,
  compiler: 11,
};
const SENSITIVE_FORMS: Record<string, string> = {
  "alex.staff": "initials",
  "name.staff": "initials",
  "svc.intext": "emptyOrAlternate",
  name: "emptyOrAlternate",
  "biz.name": "displayName",
};

interface Lists {
  enumNames: string[];
  patternNames: string[];
  linkNames: string[];
  bundleNames: string[];
}

/** README, The slot vocabulary: the four lists name the same slots, each once; kinds, proposed names, fillers, forms. */
export function checkSlotVocabulary(vocab: SlotVocabulary, lists: Lists): string[] {
  const problems: string[] = [];
  const names = vocab.slots.map((slot) => slot.name);
  const wanted = [...lists.enumNames].sort();
  for (const [label, held] of [
    ["slots.json", names],
    ["the slottedText pattern", lists.patternNames],
    ["slotName", lists.enumNames],
  ] as const) {
    for (const name of duplicates(held)) problems.push(`${label} names ${name} twice`);
    if (!isDeepStrictEqual([...held].sort(), wanted)) {
      const missing = wanted.filter((name) => !held.includes(name));
      const extra = held.filter((name) => !wanted.includes(name));
      problems.push(
        `${label} and slotName differ (missing: ${missing.join(", ")}; extra: ${extra.join(", ")})`,
      );
    }
  }
  const linkKind = vocab.slots.filter((slot) => slot.kind === "link").map((slot) => slot.name);
  if (!isDeepStrictEqual([...lists.linkNames].sort(), [...linkKind].sort())) {
    problems.push("linkSlot is not the slots of kind link");
  }
  for (const [kind, count] of Object.entries(KIND_COUNTS)) {
    const held = vocab.slots.filter((slot) => slot.kind === kind).length;
    if (held !== count)
      problems.push(`${String(held)} slots of kind ${kind}, the README states ${String(count)}`);
  }
  for (const slot of vocab.slots) {
    const proposed = slot.kind === "link" || slot.kind === "compiler";
    if ((slot.status === "proposedCQ17") !== proposed) {
      problems.push(
        `${slot.name} (${slot.kind}) is ${slot.status}: only link and compiler slots are proposedCQ17`,
      );
    }
    if (proposed && !slot.means.includes("Proposed name (CQ-17)")) {
      problems.push(`${slot.name} is proposed but its means does not say "Proposed name (CQ-17)"`);
    }
    if ((slot.filledBy === "send") !== (slot.kind === "send")) {
      problems.push(`${slot.name} is filled by ${slot.filledBy} but is of kind ${slot.kind}`);
    }
    const form = SENSITIVE_FORMS[slot.name] ?? "asIs";
    if (slot.sensitiveForm !== form) {
      problems.push(`${slot.name} has the sensitive form ${slot.sensitiveForm}, the README states ${form}`);
    }
  }
  // K-01's list: 36 names with hold; hold is refused since D66, so 35 are here, and they are the slots that are not
  // proposed, less today and tomorrow (filled at send).
  if (lists.bundleNames.length !== 36) {
    problems.push(`K-01's closed slot list holds ${String(lists.bundleNames.length)} names, not 36`);
  }
  if (names.includes("hold")) problems.push("hold is a slot, but it is refused since D66");
  const bundleLess = lists.bundleNames.filter((name) => name !== "hold");
  for (const name of bundleLess) {
    if (!names.includes(name)) problems.push(`K-01's slot ${name} is not in slots.json`);
  }
  const sourced = vocab.slots
    .filter((slot) => slot.status === "source" && slot.kind !== "send")
    .map((slot) => slot.name);
  if (!isDeepStrictEqual([...sourced].sort(), [...bundleLess].sort())) {
    problems.push("the slots with status source (less today and tomorrow) are not K-01's list less hold");
  }
  return problems;
}

/** README, Order and Formats: the plan's formats, page type, option ids, links and thread target are the input's. */
export function checkPlanAgainstInput(candidate: Plan, given: ComposeInput): string[] {
  const problems: string[] = [];
  for (const format of candidate.formats) {
    if (!given.allowedFormats.includes(format))
      problems.push(`the plan's format ${format} is not an allowed format`);
  }
  if (candidate.pageType !== null && !given.pageTypes.includes(candidate.pageType)) {
    problems.push(`the plan's page type ${candidate.pageType} is not one of the input's page types`);
  }
  const optionIds = given.options.map((option) => option.id);
  for (const id of candidate.question?.optionIds ?? []) {
    if (!optionIds.includes(id)) problems.push(`the plan offers option ${id}, which the input does not list`);
  }
  const texts = [...candidate.lines.map((line) => line.text), candidate.question?.text ?? ""];
  for (const name of new Set(texts.flatMap(slotsIn))) {
    if (name.startsWith("link.") && !given.allowedLinks.includes(name)) {
      problems.push(`the plan carries the link ${name}, which the input does not allow`);
    }
  }
  const asked = given.openQuestions.map((question) => question.id);
  if (candidate.threadReplyTo !== null && !asked.includes(candidate.threadReplyTo)) {
    problems.push(
      `the plan threads under ${candidate.threadReplyTo}, which is not an open question of the input`,
    );
  }
  return problems;
}

/** The composer's input: text always allowed, no repeats, at most 6 messages (a code check named in the schema). */
export function checkInput(given: ComposeInput, masterLine: string | undefined): string[] {
  const problems: string[] = [];
  if (!given.allowedFormats.includes("text")) problems.push("the allowed formats do not include text");
  for (const [label, held] of [
    ["allowed formats", given.allowedFormats],
    ["allowed links", given.allowedLinks],
    ["option ids", given.options.map((option) => option.id)],
    ["open question ids", given.openQuestions.map((question) => question.id)],
  ] as const) {
    for (const name of duplicates([...held])) problems.push(`${label} list ${name} twice`);
  }
  if (given.conversation.length > 6)
    problems.push(`the conversation holds ${String(given.conversation.length)} messages, not at most 6`);
  if (masterLine !== undefined && given.masterText.text !== masterLine) {
    problems.push(`the master text is not ${given.masterText.step}'s line in the sample bundle`);
  }
  return problems;
}

const ROLE_ORDER = ["first", "fact", "action"];

/** README, Order and the combination rules: lines in order, a tapback alone, 2 to 5 poll options, at most two sends. */
export function checkPlanShape(candidate: Plan): string[] {
  const problems: string[] = [];
  const { formats, lines, question } = candidate;
  for (const name of duplicates(formats)) problems.push(`the format ${name} is listed twice`);
  const roles = lines.map((line) => line.role);
  if (
    !isDeepStrictEqual(
      [...roles].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b)),
      roles,
    )
  ) {
    problems.push("the lines are not in order: first, fact lines, action");
  }
  if (roles.filter((role) => role === "first").length > 1) problems.push("more than one first line");
  if (roles.filter((role) => role === "fact").length > 4) problems.push("more than four fact lines");
  if (roles.filter((role) => role === "action").length > 1) problems.push("more than one action line");
  if (formats.includes("tapback")) {
    if (formats.length !== 1 || lines.length > 0 || question !== null)
      problems.push("a tapback is not alone");
  } else if (lines.length === 0) {
    problems.push("a plan without lines is not a tapback");
  }
  if (formats.includes("poll") && formats.includes("linkCard"))
    problems.push("both a poll and a link card: three sends");
  if (formats.includes("poll")) {
    const count = question?.optionIds.length ?? 0;
    if (count < 2 || count > 5) problems.push(`a poll with ${String(count)} options, not 2 to 5`);
  }
  if (question !== null) {
    for (const name of duplicates(question.optionIds)) problems.push(`option ${name} is offered twice`);
  }
  if (formats.includes("linkCard")) {
    const action = lines.find((line) => line.role === "action");
    if (action === undefined || !slotsIn(action.text).some((name) => name.startsWith("link."))) {
      problems.push("a link card without an action line that carries a link");
    }
  }
  return problems;
}

/** README, Final parts: an email copy is its own row on email that reuses its text row's plan. */
export function checkEmailCopy(copy: RowPlan, textRow: string, textPlan: Plan): string[] {
  const problems: string[] = [];
  if (copy.copyOf === null) problems.push("an email copy names no text row");
  if (copy.copyOf !== null && copy.copyOf === copy.row) problems.push("an email copy is a copy of itself");
  if (copy.copyOf !== textRow)
    problems.push(`the copy names ${String(copy.copyOf)}, not the text row ${textRow}`);
  if (copy.channel !== "email") problems.push(`an email copy goes on email, not ${copy.channel}`);
  if (!isDeepStrictEqual(copy.plan, textPlan)) problems.push("the copy's plan is not its text row's plan");
  return problems;
}

/** The text of a plan with each slot replaced by its code-supplied value; a slot with no value is left as it is. */
export function fillPlan(candidate: Plan, values: Fact[]): string {
  const fill = (text: string): string =>
    text.replace(/\{\{\s*([^{}:|\s]+)[^{}]*\}\}/g, (whole, name: string) => {
      return values.find((value) => value.slot === name)?.value ?? whole;
    });
  return candidate.lines.map((line) => fill(line.text)).join("\n");
}

/** README, Final parts: the sends the plan's formats name, the first one carrying the words with every slot filled. */
export function checkFinalAgainstPlan(parts: FinalParts, candidate: Plan): string[] {
  const problems: string[] = [];
  const wanted: string[] = [];
  if (candidate.formats.includes("tapback")) wanted.push("tapback");
  if (candidate.formats.includes("text") || candidate.formats.includes("calendarFile")) wanted.push("words");
  if (candidate.formats.includes("poll")) wanted.push("poll");
  if (candidate.formats.includes("linkCard")) wanted.push("linkCard");
  const kinds = parts.sends.map((send) => send.kind);
  if (!isDeepStrictEqual(kinds, wanted)) {
    problems.push(`the sends are [${kinds.join(", ")}], the plan's formats name [${wanted.join(", ")}]`);
  }
  const words = parts.sends.find((send) => send.kind === "words");
  if (words !== undefined) {
    if ((words.calendarFile !== "none") !== candidate.formats.includes("calendarFile")) {
      problems.push("the words carry a calendar file only when the plan's formats name one");
    }
    if (candidate.question === null && words.text !== fillPlan(candidate, parts.slotValues)) {
      problems.push("the words are not the plan's lines with every slot filled");
    }
  }
  const used = new Set(
    [...candidate.lines.map((line) => line.text), candidate.question?.text ?? ""].flatMap(slotsIn),
  );
  const filled = new Set(parts.slotValues.map((fact) => fact.slot));
  for (const name of used) if (!filled.has(name)) problems.push(`the plan's slot ${name} has no value`);
  for (const name of filled)
    if (!used.has(name)) problems.push(`a value is given for ${name}, which the plan does not use`);
  return problems;
}

/** README, Final parts: the sends in order, files only with the words, a card's own link, fixed lines K-01 knows. */
export function checkFinalParts(parts: FinalParts, fixedLineIds: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const kinds = parts.sends.map((send) => send.kind);
  if (kinds[0] === "tapback" && kinds.length > 1) problems.push("a tapback is not alone");
  if (kinds[0] !== undefined && !["words", "tapback"].includes(kinds[0])) {
    problems.push(`the first send is ${kinds[0]}, not the words`);
  }
  if (kinds[1] !== undefined && !["poll", "linkCard"].includes(kinds[1])) {
    problems.push(`the second send is ${kinds[1]}, not a poll or a card`);
  }
  for (const send of parts.sends) {
    if (send.kind !== "words" && send.calendarFile !== "none")
      problems.push(`a ${send.kind} send carries a calendar file`);
    if (send.kind === "linkCard") {
      const links = parts.slotValues
        .filter((fact) => fact.slot.startsWith("link."))
        .map((fact) => fact.value);
      if (send.link === null || !links.includes(send.link)) {
        problems.push("the link card's link is not the value of a link slot");
      }
      const name = parts.slotValues.find((fact) => fact.slot === "biz.name")?.value;
      if (name !== undefined && send.text !== name)
        problems.push("the link card's preview is not the business name alone");
    }
  }
  for (const id of parts.fixedLines) {
    if (!fixedLineIds.has(id)) problems.push(`the fixed line ${id} is not a fixed line of K-01`);
  }
  for (const name of duplicates(parts.slotValues.map((fact) => fact.slot))) {
    problems.push(`${name} has two values`);
  }
  return problems;
}

// The check result ---------------------------------------------------------------------------------------------

const CHECK_NAMES = [
  "fixedLines",
  "values",
  "oneQuestion",
  "neverInMessage",
  "shape",
  "lengthAndReading",
  "format",
];
/** The first four block (arch 07 line 417); the others never block. */
const BLOCKING = new Set(["fixedLines", "values", "oneQuestion", "neverInMessage"]);
/** Words that are only an opt-out word (arch 07 line 415: "Cancel visit", never "Cancel"). */
const OPT_OUT_WORDS = new Set(["cancel", "stop", "quit", "end", "unsubscribe"]);

const wordsOf = (parts: FinalParts): string[] =>
  parts.sends.flatMap((send) => (send.kind === "poll" || send.text === null ? [] : [send.text]));
const labelsOf = (parts: FinalParts): string[] =>
  parts.sends.flatMap((send) => send.options.map((option) => option.label));

/** What happens next (arch 02 line 123; arch 07 line 417), from the attempt and the failed checks. */
export function expectedOutcome(attempt: string, checks: CheckOutcome[]): string {
  const failed = checks.filter((check) => !check.passed);
  if (failed.length === 0) return "send";
  if (attempt === "composed") return "rewrite";
  const blocked = failed.some((check) => BLOCKING.has(check.check));
  if (attempt === "rewrite") return blocked ? "fallback" : "sendAndLog";
  return blocked ? "passedOn" : "sendAndLog";
}

/** The fault a check names, seen in the checked parts alone; undefined for a check the parts cannot show. */
export function faultSeen(check: string, parts: FinalParts): boolean | undefined {
  const texts = wordsOf(parts);
  const given = parts.slotValues.map((fact) => fact.value);
  const unsupported = (found: string[]): boolean =>
    found.some((item) => !given.some((value) => value.toLowerCase().includes(item.toLowerCase())));
  switch (check) {
    case "oneQuestion":
      return texts.some((text) => text.split("?").length - 1 > 1);
    case "neverInMessage":
      return (
        [...texts, ...labelsOf(parts)].some((text) => /\p{Extended_Pictographic}/u.test(text)) ||
        labelsOf(parts).some((label) =>
          OPT_OUT_WORDS.has(
            label
              .trim()
              .toLowerCase()
              .replace(/[^a-z]/g, ""),
          ),
        )
      );
    case "values":
      return texts.some(
        (text) =>
          text.includes("{{") ||
          /\b(null|undefined)\b/.test(text) ||
          unsupported(text.match(/\$\d[\d,]*(?:\.\d\d)?/g) ?? []) ||
          unsupported(text.match(/\b\d{1,2}(?::\d\d)?\s?(?:am|pm)\b/gi) ?? []),
      );
    default:
      return undefined;
  }
}

/** README, The check result: each check once, a detail only where it failed, the outcome from the ladder, the fault shown. */
export function checkCheckResult(result: CheckResult): string[] {
  const problems: string[] = [];
  const names = result.checks.map((check) => check.check);
  for (const name of duplicates(names)) problems.push(`the check ${name} appears twice`);
  for (const name of CHECK_NAMES) if (!names.includes(name)) problems.push(`the check ${name} is missing`);
  if (result.row !== result.checked.row) problems.push("the result's row is not the checked parts' row");
  for (const check of result.checks) {
    if (check.passed && check.detail !== null) problems.push(`${check.check} passed but has a detail`);
    if (!check.passed && (check.detail === null || check.detail.trim() === "")) {
      problems.push(`${check.check} failed but says nothing of what failed`);
    }
    const seen = faultSeen(check.check, result.checked);
    if (seen !== undefined && seen !== !check.passed) {
      problems.push(
        check.passed
          ? `${check.check} passed but the checked parts show its fault`
          : `${check.check} failed but the checked parts show no such fault`,
      );
    }
  }
  const outcome = expectedOutcome(result.attempt, result.checks);
  if (result.outcome !== outcome) {
    problems.push(
      `the outcome is ${result.outcome}, but a ${result.attempt} attempt with these checks gives ${outcome}`,
    );
  }
  return problems;
}

/** What each check-* fixture states (its `shows` in fixtures/index.json): the failed check and the outcome. */
const STATED: Record<string, { failed: string[]; attempt: string; outcome: string }> = {
  "check-pass.json": { failed: [], attempt: "composed", outcome: "send" },
  "check-two-questions.json": { failed: ["oneQuestion"], attempt: "composed", outcome: "rewrite" },
  "check-raw-price.json": { failed: ["values"], attempt: "composed", outcome: "rewrite" },
  "check-emoji.json": { failed: ["neverInMessage"], attempt: "composed", outcome: "rewrite" },
  "check-unfilled-slot.json": { failed: ["values"], attempt: "composed", outcome: "rewrite" },
  "check-optout-only-option.json": { failed: ["neverInMessage"], attempt: "composed", outcome: "rewrite" },
  "check-fallback.json": { failed: ["values"], attempt: "rewrite", outcome: "fallback" },
  "check-passed-on.json": { failed: ["values"], attempt: "fallback", outcome: "passedOn" },
};

// ---------------------------------------------------------------------------------------------------------------
// 1. Every fixture of the index, checked by the T-003 harness (the plan refers to the bundle schema: it is shared)

// The harness checks every entry of the shared index against the schema its `version` names, and checks the
// schema only: an entry that names a `rule` and is marked refuse (v1.1's two refused pairs) passes the schema and
// is refused by its rule, so the harness reports it as accepted-but-marked-refuse. Each entry that names a rule is
// run through that rule here; every other entry must be ok in the harness. The counts and checks after that are
// v1's own.
const report = checkContractFixtures("message-plan", { sharedFolders: ["common", "bundle"] });
const resultOf = (file: string): EntryResult => must(report.entries.find((result) => result.file === file));
const v1Results = report.entries.filter((result) => result.version === "v1");
const refusedBySchema = index.fixtures.filter(
  (entry) => entry.expect === "refuse" && entry.rule === undefined,
);
const refusedByRule = index.fixtures.filter((entry) => entry.expect === "refuse" && entry.rule !== undefined);
/** The harness's passes and refusals (FixtureReport), counted over some of its results: v1's. */
const passesOf = (results: EntryResult[]): number =>
  results.filter((result) => result.expect === "accept" && result.outcome === "accepted").length;
const refusalsOf = (results: EntryResult[]): number =>
  results.filter((result) => result.expect === "refuse" && result.outcome === "refused").length;

describe("message-plan fixtures", () => {
  it("has a valid fixtures/index.json that lists every fixture file and every file it lists", () => {
    expect(report.problems).toEqual([]);
  });

  it("checks every entry of the shared index: accepted, refused by the schema, or refused by its named rule", () => {
    expect(report.entries.map((result) => result.file)).toEqual(index.fixtures.map((entry) => entry.file));
    expect(report.passes).toBe(index.fixtures.filter((entry) => entry.expect === "accept").length);
    expect(report.refusals).toBe(refusedBySchema.length);
    expect(report.passes + report.refusals + refusedByRule.length).toBe(index.fixtures.length);
    for (const entry of index.fixtures) {
      if (entry.rule !== undefined) expect(typeof rules[entry.rule], entry.file).toBe("function");
    }
  });

  for (const entry of index.fixtures) {
    const name = entry.rule;
    if (entry.expect === "refuse" && name !== undefined) {
      it(`refuses ${entry.file} by its rule ${name}, after the schema takes it`, () => {
        const result = resultOf(entry.file);
        expect(result.schema).toBe(`message-plan.${entry.version}.schema.json`);
        // The schema takes it, so the harness's one problem is its own "must be refused" line.
        expect(result.outcome, `${entry.file} must pass the schema`).toBe("accepted");
        expect(result.problems).toHaveLength(1);
        const problems = rule(name)(fixture(entry.file));
        expect(problems.length, `${entry.file} must be refused by ${name}`).toBeGreaterThan(0);
      });
    } else {
      it(`${entry.expect === "accept" ? "accepts" : "refuses"} ${entry.file}`, () => {
        const result = resultOf(entry.file);
        expect(result.problems).toEqual([]);
        expect(result.ok).toBe(true);
        if (name !== undefined) {
          expect(rule(name)(fixture(entry.file)), `${entry.file} must pass ${name}`).toEqual([]);
        }
      });
    }
  }
});

describe("message-plan.v1 fixtures: the index and the count", () => {
  it("checks as many fixtures as fixtures/index.json lists, none left out", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(v1Results.map((result) => result.file)).toEqual(entries.map((entry) => entry.file));
    expect(report.seedRows).toBe(0);
    expect(passesOf(v1Results) + refusalsOf(v1Results)).toBe(entries.length);
  });

  it("accepts every entry marked accept and refuses every entry marked refuse", () => {
    expect(passesOf(v1Results)).toBe(acceptedFiles.length);
    expect(refusalsOf(v1Results)).toBe(entries.filter((entry) => entry.expect === "refuse").length);
    for (const result of v1Results) {
      expect(result.outcome, result.file).toBe(result.expect === "accept" ? "accepted" : "refused");
    }
  });

  it("names its definition in every entry and holds each of the six documents and the three refusals", () => {
    // Every entry read here is v1's: the harness checked each against v1's schema, whose $defs this file uses.
    expect(v1Results.map((result) => result.schema)).toEqual(entries.map(() => SCHEMA_FILE));
    expect(entries.every((entry) => entry.def !== undefined)).toBe(true);
    const defs = new Set(entries.filter((entry) => entry.expect === "accept").map((entry) => entry.def));
    expect([...defs].sort()).toEqual(
      ["checkResult", "composeInput", "finalParts", "plan", "rowPlan", "slotVocabulary"].sort(),
    );
    const refused = entries.filter((entry) => entry.expect === "refuse").map((entry) => entry.file);
    expect(refused.sort()).toEqual([
      "invalid/refuse-format-not-allowed.json",
      "invalid/refuse-frontier-in-input.json",
      "invalid/refuse-hold-slot.json",
    ]);
  });
});

describe("message-plan.v1 fixtures: each refused fixture is refused for its one reason", () => {
  const refused = (file: string): Record<string, unknown> => fixture(file) as Record<string, unknown>;

  it("refuse-format-not-allowed: put right (no contact card), it is accepted", () => {
    const entry = must(
      entries.find((candidate) => candidate.file === "invalid/refuse-format-not-allowed.json"),
    );
    const validate = validatorFor(entry);
    const original = refused(entry.file);
    expect(validate(original)).toBe(false);
    const right = structuredClone(original) as unknown as Plan;
    right.formats = right.formats.filter((format) => format !== "contactCard");
    expect(validate(right), formatErrors(validate.errors).join("; ")).toBe(true);
  });

  it("refuse-frontier-in-input: put right (no frontier), it is accepted", () => {
    const entry = must(
      entries.find((candidate) => candidate.file === "invalid/refuse-frontier-in-input.json"),
    );
    const validate = validatorFor(entry);
    const original = refused(entry.file);
    expect(validate(original)).toBe(false);
    expect("frontier" in original).toBe(true);
    const right = Object.fromEntries(
      Object.entries(structuredClone(original)).filter(([key]) => key !== "frontier"),
    );
    expect(validate(right), formatErrors(validate.errors).join("; ")).toBe(true);
    // The refused input is the accepted one plus the frontier.
    expect(right).toEqual(input);
  });

  it("refuse-hold-slot: put right ({{hold}} read as {{deposit}}), it is accepted", () => {
    const entry = must(entries.find((candidate) => candidate.file === "invalid/refuse-hold-slot.json"));
    const validate = validatorFor(entry);
    const original = refused(entry.file);
    expect(validate(original)).toBe(false);
    const right = JSON.parse(JSON.stringify(original).replace("{{hold:$89}}", "{{deposit:$89}}")) as unknown;
    expect(validate(right), formatErrors(validate.errors).join("; ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The schema is not vacuous

/** A copy of `value` without the property or element at `where`. */
function without(value: unknown, where: (string | number)[]): unknown {
  const copy = structuredClone(value) as Record<string, unknown>;
  let node: unknown = copy;
  for (const step of where.slice(0, -1)) node = (node as Record<string | number, unknown>)[step];
  Reflect.deleteProperty(node as object, String(must(where.at(-1))));
  return copy;
}

describe("message-plan.v1 fixtures: removing a required field makes an accepted fixture refused", () => {
  for (const entry of entries.filter((candidate) => candidate.expect === "accept")) {
    it(`${entry.file} (${must(entry.def)})`, () => {
      const validate = validatorFor(entry);
      const original = fixture(entry.file) as Record<string, unknown>;
      expect(validate(original), formatErrors(validate.errors).join("; ")).toBe(true);
      const required = requiredOf(entry);
      expect(required.length, "the schema requires at least one field here").toBeGreaterThan(0);
      for (const field of required) {
        expect(field in original, `${entry.file} has the required field ${field}`).toBe(true);
        expect(validate(without(original, [field])), `${entry.file} without ${field} must be refused`).toBe(
          false,
        );
      }
      expect(
        validate({ ...original, notInTheSchema: 1 }),
        `${entry.file} with an unknown field must be refused`,
      ).toBe(false);
    });
  }

  it("also refuses a copy without a field a nested definition requires", () => {
    const cases: [string, string, (string | number)[]][] = [
      ["plan-s1-02.json", "plan", ["lines", 0, "text"]],
      ["plan-s1-02.json", "plan", ["question", "optionIds"]],
      ["input-s1-02.json", "composeInput", ["masterText", "step"]],
      ["input-s1-02.json", "composeInput", ["inbound", "sentAt"]],
      ["input-s1-02.json", "composeInput", ["audience", "handlingLine"]],
      ["slots.json", "slotVocabulary", ["slots", 0, "example"]],
      ["final-two-sends.json", "finalParts", ["sends", 0, "link"]],
      ["final-two-sends.json", "finalParts", ["slotValues", 0, "value"]],
      ["check-optout-only-option.json", "checkResult", ["checked", "sends", 1, "options", 0, "label"]],
      ["check-pass.json", "checkResult", ["checks", 0, "detail"]],
      ["plan-email-copy.json", "rowPlan", ["plan", "pageType"]],
    ];
    for (const [file, def, where] of cases) {
      const validate = defValidator(def);
      const original = fixture(file);
      expect(validate(original), file).toBe(true);
      expect(validate(without(original, where)), `${file} without ${where.join(".")} must be refused`).toBe(
        false,
      );
    }
  });

  it("holds the conditions the schema writes: a poll's options, a card's link, passedOn's two flags", () => {
    const validateParts = defValidator("finalParts");
    const twoSends = structuredClone(finalParts);
    must(twoSends.sends[1]).kind = "poll";
    expect(validateParts(twoSends), "a poll without 2 to 5 options and with words").toBe(false);
    const noLink = structuredClone(finalParts);
    must(noLink.sends[1]).link = null;
    expect(validateParts(noLink), "a link card without its link").toBe(false);
    const fileOnCard = structuredClone(finalParts);
    must(fileOnCard.sends[1]).calendarFile = "new";
    expect(validateParts(fileOnCard), "a calendar file on a card").toBe(false);
    const three = structuredClone(finalParts);
    three.sends.push(must(three.sends[1]));
    expect(validateParts(three), "three sends").toBe(false);

    const validateResult = defValidator("checkResult");
    const passedOn = structuredClone(checkResult("check-passed-on.json"));
    passedOn.teamPaged = false;
    expect(validateResult(passedOn), "passedOn without the team paged").toBe(false);
    const sent = structuredClone(checkResult("check-pass.json"));
    sent.questionWithdrawn = true;
    expect(validateResult(sent), "a send with the question withdrawn").toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. What the schema cannot check, read from the fixtures

describe("message-plan.v1 fixtures: the slot vocabulary", () => {
  const enumNames = must(schema.$defs.slotName?.enum);
  const lists: Lists = {
    enumNames,
    patternNames: namesOfPattern(must(schema.$defs.slottedText?.pattern)),
    linkNames: must(schema.$defs.linkSlot?.enum),
    bundleNames: namesOfBundleList(
      (
        readJson(path.join(BUNDLE_DIR, "bundle.v1.schema.json")) as {
          $defs: { messagesWithUnknownSlot: { contains: { properties: { text: { pattern: string } } } } };
        }
      ).$defs.messagesWithUnknownSlot.contains.properties.text.pattern,
    ),
  };
  const names = new Set(enumNames);

  it("has slotName, the slottedText pattern, linkSlot and slots.json naming the same 52 slots, each once", () => {
    expect(enumNames).toHaveLength(52);
    expect(vocabulary.slots).toHaveLength(52);
    expect(lists.patternNames).toHaveLength(52);
    expect(checkSlotVocabulary(vocabulary, lists)).toEqual([]);
  });

  it("accepts each slot in the three forms of the master's syntax and refuses a name that is not a slot", () => {
    const validate = defValidator("slottedText");
    for (const name of enumNames) {
      for (const text of [
        `a {{${name}}} b`,
        `{{${name}:words}}`,
        `{{${name}:words|other words}}`,
        `{{${name}}}{{${name}}}`,
      ]) {
        expect(validate(text), text).toBe(true);
      }
    }
    for (const text of [
      "{{hold}}",
      "{{hold:$89}}",
      "{{pay}}",
      "{{price2}}",
      "{{link}}",
      "{{day",
      "{{}}",
      "{{ day}}",
    ]) {
      expect(validate(text), text).toBe(false);
    }
  });

  it("has every slot the K-01 sample bundles use in slots.json", () => {
    const bundleIndex = (
      readJson(path.join(BUNDLE_FIXTURES_DIR, "index.json")) as { fixtures: FixtureEntry[] }
    ).fixtures;
    const sample = bundleIndex.filter((entry) => entry.expect === "accept");
    expect(sample.length).toBeGreaterThan(0);
    const used = new Set<string>();
    for (const entry of sample) {
      const value = bundleFixture(entry.file);
      expect(slotsOutsideVocabulary(value, names), entry.file).toEqual([]);
      for (const name of strings(value).flatMap(slotsIn)) used.add(name);
    }
    expect(used.size, "the sample bundles use slots").toBeGreaterThan(10);
    // The slots the sample bundles use are all in the vocabulary, and the vocabulary has not left a record slot out.
    for (const name of used) expect(names.has(name), name).toBe(true);
  });

  it("has every slot the K-03 fixtures use in slots.json", () => {
    for (const entry of entries.filter((candidate) => candidate.expect === "accept")) {
      expect(slotsOutsideVocabulary(fixture(entry.file), names), entry.file).toEqual([]);
    }
  });

  it("fires on a damaged copy: a slot twice, a slot left out, a wrong kind or form, hold, a slot of no list", () => {
    const damaged = (): SlotVocabulary => structuredClone(vocabulary);
    const twice = damaged();
    twice.slots[1] = { ...must(twice.slots[1]), name: must(twice.slots[0]).name };
    expect(checkSlotVocabulary(twice, lists).join("\n")).toContain("slots.json names pay.asks twice");

    const left = damaged();
    left.slots.pop();
    expect(checkSlotVocabulary(left, lists).join("\n")).toContain(
      "slots.json and slotName differ (missing: relay.quote",
    );

    const kind = damaged();
    must(kind.slots.find((slot) => slot.name === "price")).kind = "ledger";
    expect(checkSlotVocabulary(kind, lists).join("\n")).toContain(
      "slots of kind amount, the README states 6",
    );

    const form = damaged();
    must(form.slots.find((slot) => slot.name === "svc.intext")).sensitiveForm = "asIs";
    expect(checkSlotVocabulary(form, lists)).toEqual([
      "svc.intext has the sensitive form asIs, the README states emptyOrAlternate",
    ]);

    const proposed = damaged();
    must(proposed.slots.find((slot) => slot.name === "link.pay")).status = "source";
    expect(checkSlotVocabulary(proposed, lists).join("\n")).toContain("link.pay (link) is source");

    const filler = damaged();
    must(filler.slots.find((slot) => slot.name === "today")).filledBy = "slotFiller";
    expect(checkSlotVocabulary(filler, lists).join("\n")).toContain("today is filled by slotFiller");

    const hold = damaged();
    must(hold.slots.find((slot) => slot.name === "keep")).name = "hold";
    expect(checkSlotVocabulary(hold, lists).join("\n")).toContain("hold is a slot");

    const pattern = { ...lists, patternNames: lists.patternNames.slice(1) };
    expect(checkSlotVocabulary(vocabulary, pattern).join("\n")).toContain(
      "the slottedText pattern and slotName differ",
    );

    const link = { ...lists, linkNames: lists.linkNames.slice(1) };
    expect(checkSlotVocabulary(vocabulary, link)).toEqual(["linkSlot is not the slots of kind link"]);

    const bundle = { ...lists, bundleNames: lists.bundleNames.filter((name) => name !== "keep") };
    expect(checkSlotVocabulary(vocabulary, bundle).join("\n")).toContain(
      "K-01's closed slot list holds 35 names",
    );
  });

  it("finds a slot outside the vocabulary in a copy of a sample bundle and of a plan", () => {
    expect(slotsOutsideVocabulary({ say: [{ text: "You pay {{hold:$89}} and {{day}}" }] }, names)).toEqual([
      "hold",
    ]);
    // K-01's refused sample names {{visit.place}}, a slot K-01's closed list lacks and K-03 proposes (CQ-17).
    const refusedBundle = bundleFixture("invalid/refuse-unknown-slot.json");
    expect(slotsOutsideVocabulary(refusedBundle, new Set(lists.bundleNames))).toEqual(["visit.place"]);
    expect(slotsOutsideVocabulary(refusedBundle, names)).toEqual([]);
    expect(slotsOutsideVocabulary(fixture("invalid/refuse-hold-slot.json"), names)).toEqual(["hold"]);
  });
});

describe("message-plan.v1 fixtures: the composer's input and the plan for it", () => {
  const skeleton = bundleFixture("bundle-v0-skeleton.json") as {
    flows: Record<string, { steps: Record<string, { say?: { text: string }[] }> }>;
  };
  const masterLine = skeleton.flows.A?.steps[input.masterText.step]?.say?.[0]?.text;

  it("has input-s1-02 hold S1-02's line from the sample bundle, text allowed, no repeats", () => {
    expect(masterLine, "the skeleton holds S1-02's first message").toBeDefined();
    expect(checkInput(input, masterLine)).toEqual([]);
  });

  it("has plan-s1-02 within the formats, links, options, page types and open questions of input-s1-02", () => {
    expect(checkPlanAgainstInput(plan, input)).toEqual([]);
  });

  it("has a shape that holds for every plan fixture", () => {
    for (const file of [...planFiles, "invalid/refuse-hold-slot.json"]) {
      expect(checkPlanShape(fixture(file) as Plan), file).toEqual([]);
    }
    expect(checkPlanShape(confirmation)).toEqual([]);
  });

  it("fires on a damaged copy of the plan and of the input", () => {
    const wide = structuredClone(plan);
    wide.formats = ["text", "poll"];
    expect(checkPlanAgainstInput(wide, input)).toEqual(["the plan's format poll is not an allowed format"]);

    const page = structuredClone(plan);
    page.pageType = "payment";
    expect(checkPlanAgainstInput(page, input)).toEqual([
      "the plan's page type payment is not one of the input's page types",
    ]);

    const option = structuredClone(plan);
    must(option.question).optionIds = ["S1-02/9"];
    expect(checkPlanAgainstInput(option, input)).toEqual([
      "the plan offers option S1-02/9, which the input does not list",
    ]);

    const link = structuredClone(plan);
    must(link.lines[1]).text += " {{link.secure}}";
    expect(checkPlanAgainstInput(link, input)).toEqual([
      "the plan carries the link link.secure, which the input does not allow",
    ]);

    const thread = structuredClone(plan);
    thread.threadReplyTo = "outbox-nothing";
    expect(checkPlanAgainstInput(thread, input)).toEqual([
      "the plan threads under outbox-nothing, which is not an open question of the input",
    ]);

    // With the input widened to match, the same plans pass: each miss above is the one check firing.
    const allowing = structuredClone(input);
    allowing.allowedFormats = ["text", "poll"];
    allowing.pageTypes = ["payment"];
    allowing.options = [{ id: "S1-02/9", label: "Yes" }];
    allowing.allowedLinks = ["link.secure"];
    allowing.openQuestions = [{ id: "outbox-nothing", text: "Anything?" }];
    for (const damaged of [wide, page, option, link, thread]) {
      expect(checkPlanAgainstInput(damaged, allowing)).toEqual([]);
    }

    const noText = structuredClone(input);
    noText.allowedFormats = ["poll"];
    expect(checkInput(noText, masterLine)).toEqual(["the allowed formats do not include text"]);
    const repeat = structuredClone(input);
    repeat.allowedLinks = ["link.secure", "link.secure"];
    expect(checkInput(repeat, masterLine)).toEqual(["allowed links list link.secure twice"]);
    const long = structuredClone(input);
    long.conversation = Array.from({ length: 7 }, () => ({}));
    expect(checkInput(long, masterLine)).toEqual(["the conversation holds 7 messages, not at most 6"]);
    const other = structuredClone(input);
    other.masterText.text = "Hello.";
    expect(checkInput(other, masterLine)).toEqual([
      "the master text is not S1-02's line in the sample bundle",
    ]);

    const bare = structuredClone(plan);
    bare.formats = ["tapback"];
    expect(checkPlanShape(bare)).toEqual(["a tapback is not alone"]);
    const noLines = structuredClone(plan);
    noLines.lines = [];
    expect(checkPlanShape(noLines)).toEqual(["a plan without lines is not a tapback"]);
    const order = structuredClone(plan);
    order.lines.reverse();
    expect(checkPlanShape(order)).toEqual(["the lines are not in order: first, fact lines, action"]);
    const five = structuredClone(plan);
    five.lines = [
      { role: "first", text: "a" },
      ...Array.from({ length: 5 }, () => ({ role: "fact", text: "b" })),
    ];
    expect(checkPlanShape(five)).toEqual(["more than four fact lines"]);
    const twoFirst = structuredClone(plan);
    twoFirst.lines = [
      { role: "first", text: "a" },
      { role: "first", text: "b" },
    ];
    expect(checkPlanShape(twoFirst)).toEqual(["more than one first line"]);
    const poll = structuredClone(plan);
    poll.formats = ["text", "poll"];
    expect(checkPlanShape(poll)).toEqual(["a poll with 0 options, not 2 to 5"]);
    const six = structuredClone(plan);
    six.formats = ["text", "poll"];
    must(six.question).optionIds = ["a", "b", "c", "d", "e", "f"];
    expect(checkPlanShape(six)).toEqual(["a poll with 6 options, not 2 to 5"]);
    const three = structuredClone(confirmation);
    three.formats = ["text", "poll", "linkCard"];
    expect(checkPlanShape(three)).toContain("both a poll and a link card: three sends");
    const card = structuredClone(confirmation);
    card.lines = card.lines.filter((line) => line.role !== "action");
    expect(checkPlanShape(card)).toEqual(["a link card without an action line that carries a link"]);
    const twice = structuredClone(plan);
    twice.formats = ["text", "text"];
    expect(checkPlanShape(twice)).toEqual(["the format text is listed twice"]);
  });
});

describe("message-plan.v1 fixtures: the email copy and the final parts", () => {
  const fixedLineIds = new Set(
    (bundleFixture("fixed-lines.json") as { lines: { id: string }[] }).lines.map((line) => line.id),
  );

  it("has plan-email-copy reuse the plan of the text row that final-two-sends sends, word for word", () => {
    expect(checkEmailCopy(emailCopy, finalParts.row, confirmation)).toEqual([]);
  });

  it("has final-two-sends follow plan-confirmation-a6-14: its sends, its lines with every slot filled", () => {
    expect(checkFinalAgainstPlan(finalParts, confirmation)).toEqual([]);
  });

  it("has well-formed final parts in final-two-sends and in every check result", () => {
    expect(checkFinalParts(finalParts, fixedLineIds)).toEqual([]);
    for (const file of checkFiles) {
      expect(checkFinalParts(checkResult(file).checked, fixedLineIds), file).toEqual([]);
    }
  });

  it("fires on a damaged copy of the email copy and of the final parts", () => {
    const text = structuredClone(emailCopy);
    text.channel = "imessage";
    expect(checkEmailCopy(text, finalParts.row, confirmation)).toEqual([
      "an email copy goes on email, not imessage",
    ]);
    const own = structuredClone(emailCopy);
    own.copyOf = own.row;
    expect(checkEmailCopy(own, finalParts.row, confirmation)).toContain("an email copy is a copy of itself");
    const none = structuredClone(emailCopy);
    none.copyOf = null;
    expect(checkEmailCopy(none, finalParts.row, confirmation)).toContain("an email copy names no text row");
    const words = structuredClone(emailCopy);
    must(words.plan.lines[0]).text += " Bring cash.";
    expect(checkEmailCopy(words, finalParts.row, confirmation)).toEqual([
      "the copy's plan is not its text row's plan",
    ]);

    const reordered = structuredClone(finalParts);
    reordered.sends.reverse();
    expect(checkFinalAgainstPlan(reordered, confirmation).join("\n")).toContain(
      "the sends are [linkCard, words]",
    );
    expect(checkFinalParts(reordered, fixedLineIds).join("\n")).toContain(
      "the first send is linkCard, not the words",
    );

    const noFile = structuredClone(finalParts);
    must(noFile.sends[0]).calendarFile = "none";
    expect(checkFinalAgainstPlan(noFile, confirmation)).toEqual([
      "the words carry a calendar file only when the plan's formats name one",
    ]);

    const changed = structuredClone(finalParts);
    must(changed.sends[0]).text = must(must(changed.sends[0]).text).replace("5160", "5161");
    expect(checkFinalAgainstPlan(changed, confirmation)).toEqual([
      "the words are not the plan's lines with every slot filled",
    ]);

    const lacking = structuredClone(finalParts);
    lacking.slotValues = lacking.slotValues.filter((fact) => fact.slot !== "visit.code");
    expect(checkFinalAgainstPlan(lacking, confirmation).join("\n")).toContain(
      "the plan's slot visit.code has no value",
    );

    const spare = structuredClone(finalParts);
    spare.slotValues.push({ slot: "fee", value: "$2" });
    expect(checkFinalAgainstPlan(spare, confirmation)).toEqual([
      "a value is given for fee, which the plan does not use",
    ]);

    const card = structuredClone(finalParts);
    must(card.sends[1]).link = "rosfield.com/v/other";
    expect(checkFinalParts(card, fixedLineIds)).toEqual([
      "the link card's link is not the value of a link slot",
    ]);

    const preview = structuredClone(finalParts);
    must(preview.sends[1]).text = "Lee's Barbershop, Sat Oct 24";
    expect(checkFinalParts(preview, fixedLineIds)).toEqual([
      "the link card's preview is not the business name alone",
    ]);

    const fileOnCard = structuredClone(finalParts);
    must(fileOnCard.sends[1]).calendarFile = "new";
    expect(checkFinalParts(fileOnCard, fixedLineIds)).toEqual(["a linkCard send carries a calendar file"]);

    const fixed = structuredClone(finalParts);
    fixed.fixedLines = ["opener", "madeUp"];
    expect(checkFinalParts(fixed, fixedLineIds)).toEqual([
      "the fixed line madeUp is not a fixed line of K-01",
    ]);

    const twice = structuredClone(finalParts);
    twice.slotValues.push(must(twice.slotValues[0]));
    expect(checkFinalParts(twice, fixedLineIds)).toEqual(["biz.name has two values"]);

    const second = structuredClone(finalParts);
    must(second.sends[1]).kind = "words";
    expect(checkFinalParts(second, fixedLineIds).join("\n")).toContain(
      "the second send is words, not a poll or a card",
    );
  });
});

describe("message-plan.v1 fixtures: the check results", () => {
  it("holds a check-* fixture for each result the index states, and no other", () => {
    expect([...checkFiles].sort()).toEqual(Object.keys(STATED).sort());
  });

  for (const file of checkFiles) {
    const stated = must(STATED[file]);
    describe(file, () => {
      const result = checkResult(file);
      it(`states one result: ${stated.attempt}, ${stated.failed.length === 0 ? "no check failed" : `${stated.failed.join(", ")} failed`}, ${stated.outcome}`, () => {
        expect(result.attempt).toBe(stated.attempt);
        expect(result.checks.filter((check) => !check.passed).map((check) => check.check)).toEqual(
          stated.failed,
        );
        expect(result.outcome).toBe(stated.outcome);
      });
      it("lists each check once, a detail only where one failed, an outcome the ladder gives, and the fault in the parts", () => {
        expect(checkCheckResult(result)).toEqual([]);
        expect(result.checks.map((check) => check.check)).toEqual(CHECK_NAMES);
      });
    });
  }

  it("fires on a damaged copy: a check twice or missing, a detail that is out of place, a wrong outcome", () => {
    const damaged = (file: string): CheckResult => structuredClone(checkResult(file));

    const twice = damaged("check-pass.json");
    twice.checks[1] = must(twice.checks[0]);
    const lines = checkCheckResult(twice).join("\n");
    expect(lines).toContain("the check fixedLines appears twice");
    expect(lines).toContain("the check values is missing");

    const detail = damaged("check-pass.json");
    must(detail.checks[0]).detail = "Something.";
    expect(checkCheckResult(detail)).toEqual(["fixedLines passed but has a detail"]);

    const silent = damaged("check-two-questions.json");
    must(silent.checks[2]).detail = null;
    expect(checkCheckResult(silent)).toEqual(["oneQuestion failed but says nothing of what failed"]);

    const row = damaged("check-pass.json");
    row.row = "outbox-other";
    expect(checkCheckResult(row)).toEqual(["the result's row is not the checked parts' row"]);

    const sent = damaged("check-two-questions.json");
    sent.outcome = "send";
    expect(checkCheckResult(sent)).toEqual([
      "the outcome is send, but a composed attempt with these checks gives rewrite",
    ]);

    const ahead = damaged("check-two-questions.json");
    ahead.outcome = "fallback";
    expect(checkCheckResult(ahead)).toEqual([
      "the outcome is fallback, but a composed attempt with these checks gives rewrite",
    ]);

    const stuck = damaged("check-passed-on.json");
    stuck.outcome = "fallback";
    expect(checkCheckResult(stuck)).toEqual([
      "the outcome is fallback, but a fallback attempt with these checks gives passedOn",
    ]);

    const logged = damaged("check-fallback.json");
    for (const check of logged.checks)
      if (check.check === "values") Object.assign(check, { passed: true, detail: null });
    logged.checked.sends = logged.checked.sends.map((send) => ({
      ...send,
      text: send.text?.replace("10:30am instead", "11:00am") ?? null,
    }));
    must(logged.checks.find((check) => check.check === "shape")).passed = false;
    must(logged.checks.find((check) => check.check === "shape")).detail = "Too many lines.";
    expect(checkCheckResult(logged).join("\n")).toContain(
      "the outcome is fallback, but a rewrite attempt with these checks gives sendAndLog",
    );
    expect(expectedOutcome("rewrite", logged.checks)).toBe("sendAndLog");
    expect(expectedOutcome("fallback", logged.checks)).toBe("sendAndLog");
    expect(expectedOutcome("composed", logged.checks)).toBe("rewrite");
  });

  it("fires on a damaged copy: a fault in the parts that no check names, and a named fault that is not there", () => {
    const damaged = (file: string): CheckResult => structuredClone(checkResult(file));
    const set = (result: CheckResult, text: string): void => {
      must(result.checked.sends[0]).text = text;
    };

    const asked = damaged("check-pass.json");
    set(asked, "Riley says yes. Is that fine? Or not?");
    expect(checkCheckResult(asked)).toEqual(["oneQuestion passed but the checked parts show its fault"]);
    const calm = damaged("check-two-questions.json");
    set(calm, "Your visit is Sat Oct 24 at 11:00am. Does that still work?");
    expect(checkCheckResult(calm)).toEqual(["oneQuestion failed but the checked parts show no such fault"]);

    const emoji = damaged("check-pass.json");
    set(emoji, "Riley says yes. 🎉");
    expect(checkCheckResult(emoji)).toEqual(["neverInMessage passed but the checked parts show its fault"]);
    const plain = damaged("check-emoji.json");
    set(plain, "You're booked! Sat Oct 24 at 11:00am with Riley.");
    expect(checkCheckResult(plain)).toEqual([
      "neverInMessage failed but the checked parts show no such fault",
    ]);

    const cancel = damaged("check-optout-only-option.json");
    must(must(cancel.checked.sends[1]).options[1]).label = "Cancel visit";
    expect(checkCheckResult(cancel)).toEqual([
      "neverInMessage failed but the checked parts show no such fault",
    ]);
    const stop = damaged("check-pass.json");
    stop.checked.sends.push({
      kind: "poll",
      text: null,
      calendarFile: "none",
      options: [
        { id: "x/1", label: "Stop." },
        { id: "x/2", label: "Yes" },
      ],
      link: null,
    });
    expect(checkCheckResult(stop)).toEqual(["neverInMessage passed but the checked parts show its fault"]);

    const price = damaged("check-raw-price.json");
    set(price, "Alex M. booked a Skin fade for Sat Oct 24 at 11:00am. It costs $40.");
    expect(checkCheckResult(price)).toEqual(["values failed but the checked parts show no such fault"]);
    const typed = damaged("check-pass.json");
    set(typed, "Riley says yes. It costs $45.");
    expect(checkCheckResult(typed)).toEqual(["values passed but the checked parts show its fault"]);
    const clock = damaged("check-pass.json");
    set(clock, "Riley says yes, at 3pm.");
    expect(checkCheckResult(clock)).toEqual(["values passed but the checked parts show its fault"]);
    const open = damaged("check-pass.json");
    set(open, "Riley says {{pro.name}}.");
    expect(checkCheckResult(open)).toEqual(["values passed but the checked parts show its fault"]);
    const filled = damaged("check-unfilled-slot.json");
    set(filled, "A reminder: your visit at Lee's Barbershop is Sat Oct 24 at 11:00am.");
    expect(checkCheckResult(filled)).toEqual(["values failed but the checked parts show no such fault"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The side list. Part two of the contract test: each producer and consumer side of K-03 v1 (02-contracts K-03
// "Contract test"; contracts/message-plan/README.md "Producers and consumers"). A side is added by its own QA side
// task, which depends on this task and on that side's build task and is planned by the lane that builds the side:
// the task sets `check` on its entry (a function that returns one line per problem, empty when the side holds) and
// nothing else here changes. An entry without `check` is a side whose task has not run yet; it is listed, never
// skipped.

export interface SideCheck {
  /** A short id for the side. */
  id: string;
  side: "producer" | "consumer";
  /** The role that builds the side. */
  owner: string;
  /** The components, spelled as the README spells them. */
  components: string;
  /** What the side's check does, so the QA side task knows what to build. */
  needs: string;
  /** Set by the side's QA task. */
  check?: () => string[];
}

export const SIDE_CHECKS: readonly SideCheck[] = [
  {
    id: "producer-composer",
    side: "producer",
    owner: "AI engineer",
    components: "C-118 composer, C-119 composer prompt and style rules",
    needs:
      "The composer's plan, for each composeInput fixture (and for the input the action layer serves for it), is accepted by $defs/plan, stays inside the structured-outputs subset, uses only slots of slots.json and, with its input, passes the pair check above (formats, page type, option ids, links and thread target are the input's); a recorded-model double stands in until Q-20.",
  },
  {
    id: "producer-action-layer-input",
    side: "producer",
    owner: "action-layer engineer",
    components: "C-090 situation tag, C-091 claim check",
    needs:
      "The compose input the Tool API serves (K-09) is accepted by $defs/composeInput, never carries the frontier, gives only the facts limit 7 lets the reader see (a secure-page-only field reads 'Read it on the secure page'; a field the reader may never see is left out), at most 6 conversation messages, and the first fitting situation tag.",
  },
  {
    id: "producer-runtime-formats",
    side: "producer",
    owner: "runtime engineer",
    components: "C-128 allowed formats and format rules",
    needs:
      "The allowed formats and links served in the input follow the channel, whether the chat exists and the step's elements; a plan outside them goes as text alone and is logged as the non-blocking format check; the combination rules (at most two sends, a tapback alone, 2 to 5 poll options, at most 5 buttons) hold on every plan.",
  },
  {
    id: "consumer-action-layer-checks",
    side: "consumer",
    owner: "action-layer engineer",
    components:
      "C-088 slot filler, C-089 fixed-line inserter, C-091 claim check, C-092 message checks, C-093 rewrite and fallback path",
    needs:
      "The slot filler and fixed-line inserter turn plan-confirmation-a6-14 into final-two-sends; the message checks (C-092; T-312), run on each check-* fixture's checked parts, give the stated results of STATED above, including the checks this part cannot show (fixed lines word for word, shape, length and reading, format against the input); the claim check cuts or replaces a field past its audience; one rewrite, then the fallback, then the passed-on line, with the question withdrawn.",
  },
  {
    id: "consumer-runtime-dispatch",
    side: "consumer",
    owner: "runtime engineer",
    components: "C-124 outbox dispatcher, C-127 two-part send, C-129 email rows",
    needs:
      "The dispatcher reads finalParts as the schema writes them: the second send waits for the first's delivery receipt (10 s at most), a link card is the whole message, a tapback stands alone, and an email row takes its text row's plan (plan-email-copy).",
  },
  {
    id: "consumer-database-outbox",
    side: "consumer",
    owner: "database engineer",
    components: "the outbox row stores the plan (K-04, K-07)",
    needs:
      "The outbox row stores a rowPlan as it is (every fixture of $defs/rowPlan round-trips through the table), and the row's plan and its copyOf are read back unchanged.",
  },
  {
    id: "consumer-playbook-slots",
    side: "consumer",
    owner: "playbook engineer",
    components: "C-062 sample-value slotting and C-064 element text forms (slot names)",
    needs:
      "Every slot the compiler writes into a bundle message is in slots.json, and the proposed CQ-17 names are the ones it makes; a name outside the list fails unknown-slot until K-01 v1.1 adds the proposed ones.",
  },
  {
    id: "consumer-qa-eval",
    side: "consumer",
    owner: "QA and eval engineer",
    components: "C-140 eval harness",
    needs:
      "The eval harness reads the plan, the final parts and the check result as the schema writes them, and scores messages that misstate the record, show a field past its audience or miss a needed value.",
  },
];

describe("message-plan.v1 sides: the list where each producer and consumer side is added", () => {
  const readme = readFileSync(path.join(PLAN_DIR, "README.md"), "utf8");

  it("names each side once, with the producers and consumers of the README", () => {
    const ids = SIDE_CHECKS.map((side) => side.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SIDE_CHECKS.filter((side) => side.side === "producer")).toHaveLength(3);
    expect(SIDE_CHECKS.filter((side) => side.side === "consumer")).toHaveLength(5);
    for (const side of SIDE_CHECKS) {
      expect(side.owner, side.id).not.toBe("");
      expect(side.needs, side.id).not.toBe("");
    }
  });

  it("spells each side's owner and components as the README does", () => {
    for (const side of SIDE_CHECKS) expect(readme, side.id).toContain(side.owner);
    for (const side of SIDE_CHECKS) expect(readme, side.id).toContain(side.components);
  });

  for (const side of SIDE_CHECKS) {
    if (side.check === undefined) continue;
    const check = side.check;
    it(`${side.side} side ${side.id}`, () => {
      expect(check()).toEqual([]);
    });
  }
});
