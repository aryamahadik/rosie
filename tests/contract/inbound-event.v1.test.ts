// Contract test for K-06 v1, the inbound event (T-085; ops/plan/02-contracts.md K-06 "Contract test" and section 2
// item 12; contracts/inbound-event/README.md "Producers and consumers", "Named rule", "Named rule (v1.1)").
//
// This is the fixture part. The contract test has two parts: this one, which reads only the committed fixtures, and
// one part per producer or consumer side, added later by a QA side task that depends on this task and on that side's
// build task. SIDE_CHECKS (at the end) is the list where each side is added.
//
// K-06 is frozen at v1 and v1.1 (T-1069). fixtures/index.json lists both: every entry is checked against the schema
// its own `version` names (the T-003 harness: v1 entries against inbound-event.v1.schema.json, v1.1 entries against
// inbound-event.v1.1.schema.json, which is v1's shape by reference), so the v1.1 fixtures are checked here too.
//
// What this part proves:
//   1. every fixture in contracts/inbound-event/fixtures/index.json is checked against its schema: accepted ones are
//      accepted, refused ones are refused, none is left out;
//   2. the named rules run, none skipped: each entry's `rule` (scrubbed or scrubbedV1dot1, inbound-event.rules.mjs) is
//      run on its fixture; every accepted fixture passes it, every fixture it refuses passes the schema and is
//      refused by the rule alone, and put right (its tagged twin) it is accepted; every accepted v1 fixture also
//      passes scrubbedV1dot1, and v1's two refused-by-rule fixtures are refused by it too; each v1.1 refused fixture
//      is one v1's scrubbed passes (the widening is real); a rule's problem lines never print the number;
//   3. the schema is not vacuous: removing any one required field (of the event, or of the object inside it:
//      handle, scrubbed, poll, reaction, edit, status, failure, email, attachment) from a copy of an accepted fixture
//      makes the copy refused, and so does one field the schema does not know;
//   4. what the schema and the rule leave to code and the fixtures can show (the README's list), each also run on a
//      damaged copy to show that it fires: a duplicate event id is the same event that text-imessage.json is, only
//      received later, so it is dropped; `scrubbed`'s counts match the tags in the words; each kind fills the fields it
//      uses; a reaction from Rosie starts no turn; a receipt goes to the dispatcher, not the actor; the actor's order.
//   What needs a producer or consumer side is on SIDE_CHECKS, not checked here: the Linq and email doubles' parsed
//   output, the test-phone page's webhook, the actor accepting every valid fixture, the gateway really dropping a known
//   id, the scrub making the rule hold, and that a poll vote's ids are those of a poll part K-04 holds.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { CONTRACTS_ROOT, checkContractFixtures, formatErrors, type FixtureEntry } from "./_harness";

// ---------------------------------------------------------------------------------------------------------------
// The fixtures

const INBOUND_DIR = path.join(CONTRACTS_ROOT, "inbound-event");
const FIXTURES_DIR = path.join(INBOUND_DIR, "fixtures");

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** An index entry; `rule` names a rule of inbound-event.rules.mjs (contracts/common/fixtures-index.meta.schema.json). */
type Entry = FixtureEntry & { rule?: string };

const index = readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: Entry[] };
const fixture = (file: string): unknown => readJson(path.join(FIXTURES_DIR, ...file.split("/")));

/** A value a fixture must hold; the fixtures are checked against the schema first, so a miss is a broken test. */
function must<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("a fixture lacks a value this test reads");
  return value;
}

// What the checks read. The fixtures are checked against the schema first (part 1), so a cast to this shape reads
// only fields the schema requires.
interface InboundEvent {
  eventId: string;
  provider: "linq" | "email";
  handle: { kind: string; address: string };
  service: string | null;
  kind: string;
  messageId: string | null;
  chatId: string | null;
  sentAt: string | null;
  receivedAt: string;
  body: string | null;
  scrubbed: { cards: number; ssns: number };
  attachments: { attachmentId: string; mediaType: string }[];
  threadedReplyTo: string | null;
  poll: { pollId: string; optionId: string; optionWords: string } | null;
  reaction: { reaction: string; onMessageId: string } | null;
  edit: { messageId: string } | null;
  status: { messageId: string; at: string; failure: { code: string | null; reason: string } | null } | null;
  fromRosie: boolean;
  email: { replyAddress: string; subject: string; senderCheck: string } | null;
  traceId: string;
}

const entries = index.fixtures;
const acceptedEntries = entries.filter((entry) => entry.expect === "accept");
const refusedEntries = entries.filter((entry) => entry.expect === "refuse");
const eventOf = (file: string): InboundEvent => structuredClone(fixture(file)) as InboundEvent;
const entryOf = (file: string): Entry => must(entries.find((candidate) => candidate.file === file));
const acceptedFiles = acceptedEntries.map((entry) => entry.file);

// ---------------------------------------------------------------------------------------------------------------
// The schemas, one validator for everything (the harness's strict Ajv 2020-12 setup), and the named rules

const ajv = new Ajv2020({ strict: true, strictRequired: false });
for (const folder of ["common", "bundle", "model", "inbound-event"]) {
  const dir = path.join(CONTRACTS_ROOT, folder);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".schema.json"))
      ajv.addSchema(readJson(path.join(dir, entry.name)) as object);
  }
}

/** The validator of the schema an entry's version names (v1 and v1.1 each have their own file and $id). */
function validatorFor(entry: Entry): ValidateFunction {
  const file = `inbound-event.${entry.version}.schema.json`;
  const schema = readJson(path.join(INBOUND_DIR, file)) as { $id: string };
  const validate = ajv.getSchema(schema.$id);
  if (validate === undefined) throw new Error(`no schema for ${file}`);
  return validate;
}
const validatorOfVersion = (version: string): ValidateFunction => validatorFor({ version } as Entry);

/** The root fields a version's schema requires; a minor version that is its predecessor's shape refers to it. */
function requiredOf(version: string): string[] {
  const schema = readJson(path.join(INBOUND_DIR, `inbound-event.${version}.schema.json`)) as {
    required?: string[];
    $ref?: string;
  };
  if (schema.required !== undefined) return schema.required;
  if (schema.$ref === undefined) throw new Error(`inbound-event ${version} states no required fields`);
  const target = /inbound-event\.(v[0-9.]+?)\.schema\.json$/.exec(schema.$ref);
  return requiredOf(must(target?.[1]));
}

type Rule = (event: InboundEvent) => string[];
const rulesFile = path.join(INBOUND_DIR, "inbound-event.rules.mjs");
const rulesModule = (await import(pathToFileURL(rulesFile).href)) as {
  rules: Record<string, Rule>;
  CARD_TAG: string;
  SSN_TAG: string;
  toAsciiDigits: (words: string) => string;
};
const { rules, CARD_TAG, SSN_TAG, toAsciiDigits } = rulesModule;
const rule = (name: string): Rule => must(rules[name]);

// ---------------------------------------------------------------------------------------------------------------
// Checks that read only fixtures. Each returns one line per problem; an empty list means the check holds.

const countOf = (words: string, tag: string): number => words.split(tag).length - 1;

/** README, "What the schema and the rule leave to code": `scrubbed`'s counts match the tags left in the words. */
export function checkScrubbedCounts(event: InboundEvent): string[] {
  const problems: string[] = [];
  const words = [event.body, event.email?.subject, event.poll?.optionWords].filter(
    (part): part is string => typeof part === "string",
  );
  const cards = words.reduce((sum, part) => sum + countOf(part, CARD_TAG), 0);
  const ssns = words.reduce((sum, part) => sum + countOf(part, SSN_TAG), 0);
  if (cards !== event.scrubbed.cards)
    problems.push(`${String(cards)} ${CARD_TAG} tags but scrubbed.cards is ${String(event.scrubbed.cards)}`);
  if (ssns !== event.scrubbed.ssns)
    problems.push(`${String(ssns)} ${SSN_TAG} tags but scrubbed.ssns is ${String(event.scrubbed.ssns)}`);
  return problems;
}

const TO_ACTOR = ["text", "photo", "reaction", "pollVote", "voteRemoved", "edit"];
const TO_DISPATCHER = ["delivered", "sent", "failed"];

/** README "Routing": where an event goes, and whether it starts a turn (a reaction from Rosie starts none). */
export function routeOf(event: InboundEvent): { to: "actor" | "dispatcher"; startsTurn: boolean } {
  if (TO_DISPATCHER.includes(event.kind)) return { to: "dispatcher", startsTurn: false };
  return { to: "actor", startsTurn: !(event.kind === "reaction" && event.fromRosie) };
}

/** README default 2: the actor takes events in receivedAt order, a tie by eventId compared as a whole. */
export function actorOrder(events: InboundEvent[]): string[] {
  return [...events]
    .sort(
      (a, b) =>
        Date.parse(a.receivedAt) - Date.parse(b.receivedAt) ||
        (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
    )
    .map((event) => event.eventId);
}

/** README "Contract test": a retried event is dropped by its event id; the gateway lets the first one through. */
export function dropKnown(events: InboundEvent[]): InboundEvent[] {
  const known = new Set<string>();
  return events.filter((event) => {
    if (known.has(event.eventId)) return false;
    known.add(event.eventId);
    return true;
  });
}

/** duplicate-event.json is text-imessage.json's event retried 30 s later: the same event id, a later receipt. */
export function checkDuplicate(first: InboundEvent, retry: InboundEvent): string[] {
  const problems: string[] = [];
  if (first.eventId !== retry.eventId) problems.push("the retry has another event id");
  const apart = (Date.parse(retry.receivedAt) - Date.parse(first.receivedAt)) / 1000;
  if (apart !== 30) problems.push(`the retry is received ${String(apart)} s later, not 30 s`);
  const strip = (event: InboundEvent): object => ({ ...event, receivedAt: null, traceId: null });
  if (JSON.stringify(strip(first)) !== JSON.stringify(strip(retry)))
    problems.push("the retry differs from the first event beyond its receipt time and trace id");
  return problems;
}

/** A copy of `value` without the property at `where`. */
function without(value: unknown, where: (string | number)[]): unknown {
  const copy = structuredClone(value) as Record<string, unknown>;
  let node: unknown = copy;
  for (const step of where.slice(0, -1)) node = (node as Record<string | number, unknown>)[step];
  Reflect.deleteProperty(node as object, must(where.at(-1)));
  return copy;
}

/** Every path to a property inside a plain object of `value` (root properties included), arrays entered. */
function propertyPaths(value: unknown, prefix: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value)) return value.flatMap((item, at) => propertyPaths(item, [...prefix, at]));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    [...prefix, key],
    ...propertyPaths(child, [...prefix, key]),
  ]);
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Every fixture of the index, checked by the T-003 harness (each against the schema its version names)

// The harness checks the schema only: an entry that names a `rule` and is marked refuse passes the schema and is
// refused by the rule, so the harness reports it as accepted-but-marked-refuse. Those entries are checked below by the
// rule (part 2); every other entry must be ok in the harness.
const report = checkContractFixtures("inbound-event", { sharedFolders: ["common", "bundle", "model"] });
const refusedByRule = refusedEntries.filter((entry) => entry.rule !== undefined);
const refusedBySchema = refusedEntries.filter((entry) => entry.rule === undefined);

describe("inbound-event fixtures: the index and the count", () => {
  it("checks as many fixtures as fixtures/index.json lists, none left out", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(report.problems).toEqual([]);
    expect(report.entries.map((result) => result.file)).toEqual(entries.map((entry) => entry.file));
    expect(report.seedRows).toBe(0);
    expect(acceptedEntries.length + refusedBySchema.length + refusedByRule.length).toBe(entries.length);
    const onDisk = readdirSync(FIXTURES_DIR, { recursive: true, encoding: "utf8" })
      .map((file) => file.split(path.sep).join("/"))
      .filter((file) => file.endsWith(".json") && file !== "index.json");
    expect([...onDisk].sort()).toEqual(entries.map((entry) => entry.file).sort());
  });

  it("accepts every entry marked accept and refuses every entry marked refuse, by the schema or by its rule", () => {
    expect(report.passes).toBe(acceptedEntries.length);
    expect(report.refusals).toBe(refusedBySchema.length);
    for (const result of report.entries) {
      const entry = entryOf(result.file);
      if (entry.expect === "refuse" && entry.rule !== undefined) {
        // Passes the schema, so the rule alone decides it; the harness's "must be refused" line is for the schema.
        expect(result.outcome, `${result.file} must pass the schema`).toBe("accepted");
      } else {
        expect(result.problems, result.file).toEqual([]);
        expect(result.outcome, result.file).toBe(result.expect === "accept" ? "accepted" : "refused");
      }
    }
  });

  for (const entry of entries) {
    const how =
      entry.expect === "accept"
        ? "accepts"
        : entry.rule === undefined
          ? "refuses"
          : "passes the schema, refused by its rule:";
    it(`${how} ${entry.file} (${entry.version})`, () => {
      const result = must(report.entries.find((candidate) => candidate.file === entry.file));
      expect(result.schema).toBe(`inbound-event.${entry.version}.schema.json`);
      if (entry.expect === "refuse" && entry.rule !== undefined) {
        expect(result.outcome).toBe("accepted");
        expect(rule(entry.rule)(eventOf(entry.file)).length).toBeGreaterThan(0);
      } else {
        expect(result.problems).toEqual([]);
        expect(result.ok).toBe(true);
      }
    });
  }

  it("checks each entry against the schema its version names, and holds v1 and v1.1 (a later minor version adds its own)", () => {
    expect(new Set(entries.map((entry) => entry.version))).toContain("v1");
    expect(new Set(entries.map((entry) => entry.version))).toContain("v1.1");
    for (const result of report.entries) {
      expect(result.schema, result.file).toBe(`inbound-event.${result.version}.schema.json`);
    }
  });

  it("holds accepted and refused fixtures for v1 and for v1.1, selected by version and by what the entry says", () => {
    const of = (version: string, expectation: string): string[] =>
      entries
        .filter((entry) => entry.version === version && entry.expect === expectation)
        .map((entry) => entry.file);
    expect(of("v1", "accept").length).toBeGreaterThan(0);
    expect(of("v1.1", "accept").length).toBeGreaterThan(0);
    expect(of("v1", "refuse")).toEqual(
      expect.arrayContaining([
        "invalid/refuse-no-event-id.json",
        "invalid/refuse-unscrubbed-card.json",
        "invalid/refuse-unscrubbed-ssn.json",
      ]),
    );
    expect(of("v1.1", "refuse")).toEqual(
      expect.arrayContaining([
        "invalid/refuse-unscrubbed-card-next-to-digits.json",
        "invalid/refuse-unscrubbed-card-non-ascii-digits.json",
        "invalid/refuse-unscrubbed-card-wide-spaces.json",
        "invalid/refuse-unscrubbed-ssn-wide-form.json",
      ]),
    );
  });

  it("shows every kind, both providers, every service and Rosie's own reaction between the accepted fixtures", () => {
    const events = acceptedFiles.map(eventOf);
    expect(new Set(events.map((event) => event.kind))).toEqual(
      new Set([
        "text",
        "photo",
        "reaction",
        "pollVote",
        "voteRemoved",
        "edit",
        "delivered",
        "sent",
        "failed",
      ]),
    );
    expect(new Set(events.map((event) => event.provider))).toEqual(new Set(["linq", "email"]));
    expect(new Set(events.map((event) => event.service))).toEqual(
      new Set(["imessage", "sms", "email", null]),
    );
    expect(events.some((event) => event.kind === "reaction" && event.fromRosie)).toBe(true);
    expect(events.some((event) => event.kind === "reaction" && !event.fromRosie)).toBe(true);
    expect(
      new Set(events.filter((event) => event.email !== null).map((event) => must(event.email).senderCheck)),
    ).toEqual(new Set(["passed", "failed"]));
  });

  it("refuses refuse-no-event-id by the schema (it has no event id), and every other refused one by a named rule", () => {
    const bySchema = refusedEntries.filter((entry) => entry.rule === undefined).map((entry) => entry.file);
    expect(bySchema).toEqual(["invalid/refuse-no-event-id.json"]);
    expect(entryOf("text-imessage.json").rule).toBe("scrubbed");
  });

  it("refuses refuse-no-event-id for its stated reason: with text-imessage.json's event id put in, it is text-imessage.json and accepted", () => {
    const file = "invalid/refuse-no-event-id.json";
    const entry = entryOf(file);
    const validate = validatorFor(entry);
    const broken = eventOf(file);
    expect("eventId" in broken, "the fixture has no event id").toBe(false);
    expect(validate(broken)).toBe(false);
    expect(
      (validate.errors ?? []).map((error) => [
        error.keyword,
        (error.params as { missingProperty?: string }).missingProperty,
      ]),
      "the schema's only error is the missing eventId",
    ).toEqual([["required", "eventId"]]);
    const mended = { ...broken, eventId: eventOf("text-imessage.json").eventId };
    expect(mended, "mended, it is text-imessage.json").toEqual(eventOf("text-imessage.json"));
    expect(validate(mended), formatErrors(validate.errors).join("; ")).toBe(true);
    // A copy that also broke another field is refused for more than the id, so it would fail the checks above.
    const alsoBroken = eventOf(file);
    Reflect.deleteProperty(alsoBroken.handle, "address");
    const mendedTwice = { ...alsoBroken, eventId: eventOf("text-imessage.json").eventId };
    expect(mendedTwice).not.toEqual(eventOf("text-imessage.json"));
    expect(validate(mendedTwice)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The named rules, run for every entry that names one

describe("inbound-event fixtures: the named rules are run, none skipped", () => {
  it("has the rules each entry names in inbound-event.rules.mjs, and names a rule on every entry but one", () => {
    expect(Object.keys(rules)).toEqual(expect.arrayContaining(["scrubbed", "scrubbedV1dot1"]));
    expect(entries.filter((entry) => entry.rule === undefined).map((entry) => entry.file)).toEqual(
      refusedBySchema.map((entry) => entry.file),
    );
    for (const entry of entries) {
      if (entry.rule !== undefined) expect(typeof rules[entry.rule], entry.file).toBe("function");
    }
    expect(entries.filter((entry) => entry.version === "v1").every((e) => e.rule !== "scrubbedV1dot1")).toBe(
      true,
    );
    expect(
      entries
        .filter((entry) => entry.version === "v1.1" && entry.rule !== undefined)
        .every((e) => e.rule === "scrubbedV1dot1"),
    ).toBe(true);
  });

  for (const entry of entries) {
    if (entry.rule === undefined) continue;
    const name = entry.rule;
    it(`${entry.file}: the schema accepts it and ${name} ${entry.expect === "accept" ? "passes" : "refuses"} it`, () => {
      const event = eventOf(entry.file);
      const validate = validatorFor(entry);
      expect(validate(event), `${entry.file}: ${formatErrors(validate.errors).join("; ")}`).toBe(true);
      const problems = rule(name)(event);
      if (entry.expect === "accept") expect(problems, entry.file).toEqual([]);
      else expect(problems.length, `${entry.file} must be refused by ${name}`).toBeGreaterThan(0);
    });
  }

  it("has every accepted fixture pass scrubbedV1dot1 too, and v1's two refused-by-rule fixtures refused by it", () => {
    for (const entry of acceptedEntries.filter((e) => e.version === "v1" || e.version === "v1.1"))
      expect(rule("scrubbedV1dot1")(eventOf(entry.file)), entry.file).toEqual([]);
    for (const entry of refusedByRule.filter((e) => e.version === "v1")) {
      expect(rule("scrubbed")(eventOf(entry.file)).length, entry.file).toBeGreaterThan(0);
      expect(rule("scrubbedV1dot1")(eventOf(entry.file)).length, entry.file).toBeGreaterThan(0);
    }
  });

  it("has each v1.1 refused fixture pass v1's scrubbed, so the widening is real", () => {
    for (const entry of refusedEntries.filter((candidate) => candidate.version === "v1.1")) {
      expect(rule("scrubbed")(eventOf(entry.file)), entry.file).toEqual([]);
    }
  });

  it("has every accepted v1 fixture accepted by the v1.1 schema too (the shape is v1's)", () => {
    const validate = validatorOfVersion("v1.1");
    for (const entry of acceptedEntries.filter((candidate) => candidate.version === "v1")) {
      expect(validate(eventOf(entry.file)), entry.file).toBe(true);
    }
  });

  /**
   * The numbers (digits only) a body holds: each run of 9 or more digits, any script, with any spaces or dashes between
   * its digits taken out. A problem line must not print one: its digits-only form holds no 9-digit window of any.
   */
  const NUMBER_RUN = /\d(?:[\p{Zs}\t\p{Pd}]*\d)*/gu;
  const digitsOnly = (words: string): string => toAsciiDigits(words).replace(/[^0-9]/g, "");
  function numbersIn(words: string): string[] {
    return [...toAsciiDigits(words).matchAll(NUMBER_RUN)]
      .map((match) => digitsOnly(match[0]))
      .filter((digits) => digits.length >= 9);
  }
  function printedNumbers(line: string, words: string): string[] {
    const shown = digitsOnly(line);
    return numbersIn(words).filter((number) =>
      Array.from({ length: number.length - 8 }, (_, at) => number.slice(at, at + 9)).some((part) =>
        shown.includes(part),
      ),
    );
  }

  it("never prints the number a rule found in its problem lines, compared as digits only against the body's number", () => {
    for (const entry of refusedByRule) {
      const event = eventOf(entry.file);
      const words = must(event.body ?? event.poll?.optionWords);
      expect(numbersIn(words).length, `${entry.file}: the body holds a number to look for`).toBeGreaterThan(
        0,
      );
      const lines = rule(must(entry.rule))(event);
      expect(lines.length, entry.file).toBeGreaterThan(0);
      for (const line of lines) expect(printedNumbers(line, words), `${entry.file}: ${line}`).toEqual([]);
    }
  });

  it("has the number check fire on a damaged line, in any spacing or script of the digits", () => {
    const body = "My card is 4242 4242 4242 4242";
    expect(printedNumbers("body: holds a card number (4242 4242 4242 4242)", body)).toHaveLength(1);
    expect(printedNumbers("body: holds a card number (4242424242424242)", body)).toHaveLength(1);
    expect(printedNumbers("body: holds a card number (４２４２-４２４２-4242-4242)", body)).toHaveLength(1);
    expect(printedNumbers("body: holds a card number (19 characters)", body)).toEqual([]);
    expect(
      printedNumbers("body: holds a Social Security number (123 - 45 - 6789)", "SSN 123-45-6789"),
    ).toHaveLength(1);
    expect(
      printedNumbers("body: holds a Social Security number; it must be [SSN]", "SSN 123-45-6789"),
    ).toEqual([]);
  });

  // Each refused-by-rule fixture, the accepted one it names (the same event, with the tag in its place), and the kind
  // of number the fixture's index entry says it holds (fixtures/index.json: "card number" or "Social Security number").
  const CARD = "card number";
  const SSN = "Social Security number";
  const PAIRS: readonly [refused: string, tagged: string, kind: typeof CARD | typeof SSN][] = [
    ["invalid/refuse-unscrubbed-card.json", "text-with-card-number.json", CARD],
    ["invalid/refuse-unscrubbed-ssn.json", "text-with-ssn.json", SSN],
    ["invalid/refuse-unscrubbed-card-next-to-digits.json", "text-with-card-next-to-digits.json", CARD],
    ["invalid/refuse-unscrubbed-card-wide-spaces.json", "text-with-card-wide-spaces.json", CARD],
    ["invalid/refuse-unscrubbed-card-non-ascii-digits.json", "text-with-card-non-ascii-digits.json", CARD],
    ["invalid/refuse-unscrubbed-ssn-wide-form.json", "text-with-ssn-wide-form.json", SSN],
  ];

  it("refuses each rule-refused fixture for its kind: the lines name that kind and no other", () => {
    for (const [refused, tagged, kind] of PAIRS) {
      const entry = entryOf(refused);
      const lines = rule(must(entry.rule))(eventOf(refused));
      const other = kind === CARD ? SSN : CARD;
      expect(lines.length, refused).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, refused).toContain(`holds a ${kind}`);
        expect(line, refused).not.toContain(`holds a ${other}`);
      }
      const twin = eventOf(tagged);
      expect(twin.scrubbed, `${tagged} counts the tag of ${kind}`).toEqual(
        kind === CARD ? { cards: 1, ssns: 0 } : { cards: 0, ssns: 1 },
      );
      expect(must(twin.body), tagged).toContain(kind === CARD ? CARD_TAG : SSN_TAG);
      expect(must(twin.body), tagged).not.toContain(kind === CARD ? SSN_TAG : CARD_TAG);
    }
  });

  it("has each rule-refused fixture and its tagged twin differ only in the words and the counts", () => {
    expect(PAIRS.map(([refused]) => refused).sort()).toEqual(
      refusedByRule
        .filter((e) => e.version === "v1" || e.version === "v1.1")
        .map((e) => e.file)
        .sort(),
    );
    for (const [refused, tagged] of PAIRS) {
      const strip = (event: InboundEvent): object => ({ ...event, body: null, scrubbed: null });
      expect(strip(eventOf(refused)), `${refused} against ${tagged}`).toEqual(strip(eventOf(tagged)));
      expect(entryOf(tagged).expect).toBe("accept");
      expect(entryOf(tagged).rule).toBe(entryOf(refused).rule);
    }
  });

  it("accepts each rule-refused fixture put right: with its tagged twin's words, the rule passes it", () => {
    for (const [refused, tagged] of PAIRS) {
      const entry = entryOf(refused);
      const right = eventOf(refused);
      expect(must(entry.rule), refused).not.toBe("");
      expect(rule(must(entry.rule))(right).length, `${refused} is refused`).toBeGreaterThan(0);
      right.body = eventOf(tagged).body;
      right.scrubbed = eventOf(tagged).scrubbed;
      expect(rule(must(entry.rule))(right), `${refused} put right`).toEqual([]);
      const validate = validatorFor(entry);
      expect(validate(right), `${refused} put right: ${formatErrors(validate.errors).join("; ")}`).toBe(true);
    }
  });

  it("refuses an event with a card or a Social Security number put into an accepted fixture's subject or words", () => {
    const text = eventOf("text-imessage.json");
    text.body = "My card is 4242 4242 4242 4242";
    expect(rule("scrubbed")(text)).toHaveLength(1);
    expect(rule("scrubbedV1dot1")(text)).toHaveLength(1);
    const email = eventOf("email-reply-check-passed.json");
    must(email.email).subject = "Re: 123-45-6789";
    expect(rule("scrubbed")(email)).toEqual([
      "email.subject: holds a Social Security number; it must be [SSN]",
    ]);
    expect(rule("scrubbedV1dot1")(email)).toEqual([
      "email.subject: holds a Social Security number; it must be [SSN]",
    ]);
  });

  it("keeps nine bare digits as words under both rules (README default 1)", () => {
    const event = eventOf("text-with-nine-bare-digits.json");
    expect(must(event.body)).toContain("123456789");
    expect(rule("scrubbed")(event)).toEqual([]);
    expect(rule("scrubbedV1dot1")(event)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. The schema is not vacuous

describe("inbound-event fixtures: removing a required field makes an accepted fixture refused", () => {
  for (const entry of acceptedEntries) {
    it(`${entry.file} (${entry.version})`, () => {
      const validate = validatorFor(entry);
      const original = eventOf(entry.file);
      expect(validate(original), formatErrors(validate.errors).join("; ")).toBe(true);
      const paths = propertyPaths(original);
      const rootRequired = paths.filter((where) => where.length === 1);
      const schemaRequired = requiredOf(entry.version);
      expect(schemaRequired.length, "the schema requires fields").toBeGreaterThan(0);
      expect(
        rootRequired.map((where) => where[0]).sort(),
        "every field the schema requires is in the fixture",
      ).toEqual([...schemaRequired].sort());
      expect(paths.length, "the fixture has at least one field").toBeGreaterThan(schemaRequired.length);
      for (const where of paths) {
        expect(
          validate(without(original, where)),
          `${entry.file} without ${where.join(".")} must be refused`,
        ).toBe(false);
      }
      expect(
        validate({ ...original, notInTheSchema: 1 }),
        `${entry.file} with an unknown field must be refused`,
      ).toBe(false);
    });
  }

  it("checks the nested objects of the kinds that fill them: handle, scrubbed and each kind's own object", () => {
    const nested = new Set<string>();
    for (const file of acceptedFiles) {
      for (const where of propertyPaths(eventOf(file)).filter((path_) => path_.length > 1))
        nested.add(
          where
            .slice(0, -1)
            .filter((step) => typeof step === "string")
            .join("."),
        );
    }
    expect([...nested].sort()).toEqual(
      [
        "attachments",
        "email",
        "handle",
        "poll",
        "reaction",
        "edit",
        "scrubbed",
        "status",
        "status.failure",
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. What the schema and the rule leave to code, read from the fixtures

describe("inbound-event fixtures: the checks the schema leaves to code", () => {
  it("has `scrubbed`'s counts match the tags in every fixture that is not refused for its words", () => {
    for (const file of acceptedFiles) expect(checkScrubbedCounts(eventOf(file)), file).toEqual([]);
    expect(eventOf("text-with-card-number.json").scrubbed).toEqual({ cards: 1, ssns: 0 });
    expect(eventOf("text-with-ssn.json").scrubbed).toEqual({ cards: 0, ssns: 1 });
  });

  it("has `scrubbed`'s check fire on a damaged copy", () => {
    const card = eventOf("text-with-card-number.json");
    card.scrubbed.cards = 0;
    expect(checkScrubbedCounts(card)).toEqual(["1 [card number] tags but scrubbed.cards is 0"]);
    const ssn = eventOf("text-with-ssn.json");
    ssn.scrubbed.ssns = 2;
    expect(checkScrubbedCounts(ssn)).toEqual(["1 [SSN] tags but scrubbed.ssns is 2"]);
    const plain = eventOf("text-imessage.json");
    plain.body = "Haircut [card number] [SSN]";
    expect(checkScrubbedCounts(plain)).toEqual([
      "1 [card number] tags but scrubbed.cards is 0",
      "1 [SSN] tags but scrubbed.ssns is 0",
    ]);
    const subject = eventOf("email-reply-check-passed.json");
    must(subject.email).subject = "Re: [SSN]";
    expect(checkScrubbedCounts(subject)).toEqual(["1 [SSN] tags but scrubbed.ssns is 0"]);
  });

  it("has duplicate-event.json be text-imessage.json retried 30 s later, and the gateway's drop keep only the first", () => {
    const first = eventOf("text-imessage.json");
    const retry = eventOf("duplicate-event.json");
    expect(checkDuplicate(first, retry)).toEqual([]);
    expect(dropKnown([first, retry])).toEqual([first]);
    expect(dropKnown([retry, first])).toEqual([retry]);
  });

  it("has the drop leave every other accepted fixture in (no two accepted fixtures share an event id but the retry)", () => {
    const others = acceptedFiles.filter((file) => file !== "duplicate-event.json").map(eventOf);
    expect(dropKnown(others)).toHaveLength(others.length);
    const ids = acceptedFiles.map((file) => eventOf(file).eventId);
    const shared = ids.filter((id, at) => ids.indexOf(id) !== at);
    expect(shared).toEqual([eventOf("text-imessage.json").eventId]);
  });

  it("has the duplicate check fire on a damaged copy", () => {
    const first = eventOf("text-imessage.json");
    const other = eventOf("duplicate-event.json");
    other.eventId = "evt-alex-0002";
    expect(checkDuplicate(first, other)).toEqual([
      "the retry has another event id",
      "the retry differs from the first event beyond its receipt time and trace id",
    ]);
    const late = eventOf("duplicate-event.json");
    late.receivedAt = "2026-10-12T16:21:01Z";
    expect(checkDuplicate(first, late)).toEqual(["the retry is received 60 s later, not 30 s"]);
    const changed = eventOf("duplicate-event.json");
    changed.body = "Haircut?";
    expect(checkDuplicate(first, changed)).toEqual([
      "the retry differs from the first event beyond its receipt time and trace id",
    ]);
    expect(dropKnown([first, { ...first, eventId: "evt-alex-0002" }])).toHaveLength(2);
  });

  it("sends texts, photos, reactions, votes and edits to the actor and receipts to the dispatcher, in the kinds the schema names", () => {
    for (const file of acceptedFiles) {
      const event = eventOf(file);
      const route = routeOf(event);
      expect(route.to, file).toBe(TO_ACTOR.includes(event.kind) ? "actor" : "dispatcher");
      expect(event.status !== null, `${file}: only a receipt has a status`).toBe(route.to === "dispatcher");
    }
  });

  it("starts no turn on Rosie's own reaction, and a turn on every other event the actor takes", () => {
    expect(routeOf(eventOf("reaction-from-rosie.json"))).toEqual({ to: "actor", startsTurn: false });
    expect(routeOf(eventOf("reaction-from-customer.json"))).toEqual({ to: "actor", startsTurn: true });
    for (const file of acceptedFiles) {
      const event = eventOf(file);
      if (routeOf(event).to === "actor" && file !== "reaction-from-rosie.json") {
        expect(routeOf(event).startsTurn, file).toBe(true);
      }
    }
    const rosie = eventOf("reaction-from-customer.json");
    rosie.fromRosie = true;
    expect(routeOf(rosie).startsTurn).toBe(false);
  });

  it("has fromRosie false on every email fixture and on every Linq fixture but Rosie's own reaction", () => {
    for (const file of acceptedFiles) {
      const event = eventOf(file);
      expect(event.fromRosie, file).toBe(file === "reaction-from-rosie.json");
    }
  });

  it("has the actor take events in receivedAt order, a tie by event id compared whole", () => {
    const first = eventOf("text-imessage.json");
    const retry = eventOf("duplicate-event.json");
    const vote = eventOf("poll-vote.json");
    const edit = eventOf("edit-after-commit.json");
    const events = [edit, retry, vote, first];
    const ordered = actorOrder(events);
    const times = ordered.map((id) =>
      Date.parse(must(events.find((event) => event.eventId === id)).receivedAt),
    );
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const same = { ...first, eventId: "evt-alex-0000" };
    const tie = { ...first, eventId: "evt-alex-0002" };
    expect(actorOrder([tie, first, same])).toEqual(["evt-alex-0000", "evt-alex-0001", "evt-alex-0002"]);
    expect(
      actorOrder([
        { ...first, eventId: "evt-alex-10" },
        { ...first, eventId: "evt-alex-9" },
      ]),
    ).toEqual(["evt-alex-10", "evt-alex-9"]);
  });

  it("has a poll vote and its vote removed name the same poll and option, in K-04's seed ids", () => {
    const vote = must(eventOf("poll-vote.json").poll);
    const removed = must(eventOf("poll-vote-removed.json").poll);
    expect(removed).toEqual(vote);
    expect(vote.pollId).toBe("linq-msg-demo-0002");
    expect(vote.optionId).toBe("linq-opt-demo-2");
  });

  it("has the edit name an inbound message, Alex's reaction one of Rosie's parts and Rosie's reaction an inbound message", () => {
    expect(must(eventOf("edit-after-commit.json").edit).messageId).toMatch(/^linq-msg-demo-in-/);
    expect(must(eventOf("reaction-from-customer.json").reaction).onMessageId).toBe("linq-msg-demo-0001");
    expect(must(eventOf("reaction-from-rosie.json").reaction).onMessageId).toMatch(/^linq-msg-demo-in-/);
  });

  it("has every email fixture's sender check, reply address and kind as K-12 says", () => {
    const emails = acceptedFiles.map(eventOf).filter((event) => event.provider === "email");
    expect(emails.length).toBeGreaterThanOrEqual(2);
    for (const event of emails) {
      expect(event.service).toBe("email");
      expect(event.handle.kind).toBe("email");
      expect(event.chatId).toBeNull();
      expect(["text", "delivered", "failed"]).toContain(event.kind);
      if (event.kind === "text") expect(must(event.email).replyAddress).toMatch(/@reply\.example\.com$/);
    }
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
 * contracts/inbound-event/README.md "Producers and consumers". Each side is added later by a QA side task that depends
 * on this task and on that side's build task: it fills `check` (and moves its own test beside this one). Until then the
 * side is held here with what it must show, so none is forgotten.
 */
export const SIDE_CHECKS: readonly SideCheck[] = [
  {
    id: "producer-integrations",
    side: "producer",
    owner: "integrations engineer",
    components: ["C-207 Linq webhook events", "C-213 email (inbound replies and delivery events)"],
    needs:
      "The Linq and email doubles' parsed output, and the adapters' on the recorded samples, match this schema and the named rule: every Linq webhook event type of K-11 and every Resend inbound reply and delivery event comes out as one of the nine kinds with the fields the kind fills and the others null; the email sender check that did not run is failed; an email reply is kind text.",
  },
  {
    id: "producer-runtime",
    side: "producer",
    owner: "runtime engineer",
    components: [
      "C-044 gateway Worker (verifies through the port, seals, drops known event ids)",
      "C-045 card and SSN scrub",
    ],
    needs:
      "The gateway answers 401 and writes no event on a bad signature, 200 and drops an event id it already holds (duplicate-event.json against text-imessage.json: the actor never sees it twice), and seals every other event; the scrub makes scrubbed and scrubbedV1dot1 hold on every body and subject, with the tags and the counts the fixtures show and the leftmost-window placement of the v1.1 fixtures.",
  },
  {
    id: "producer-frontend",
    side: "producer",
    owner: "frontend engineer",
    components: ["C-205 test-phone page (signed webhooks through the Linq double, C-211)"],
    needs:
      "The test-phone page's text, signed and sent through the Linq double, comes out of the gateway as an event that matches this schema and the rule, field for field as test-phone-page.json shows.",
  },
  {
    id: "consumer-runtime",
    side: "consumer",
    owner: "runtime engineer",
    components: [
      "C-046 handle actor",
      "C-047 safety read on arrival",
      "C-048 batch",
      "C-049 turn lease",
      "C-055 clock arming",
      "C-127 two-part send",
      "C-184 duplicate, late or edited text",
    ],
    needs:
      "The actor accepts every valid fixture, refuses every invalid one, and takes its events in receivedAt order (a tie by event id compared whole); a reaction from Rosie starts no turn; the safety read sees each raw text before batching; an unknown poll option id reads as typed words; the clock arms at the first delivered receipt (sent on SMS); an edit after commit and a late or duplicate text are handled as the README says; a pollVote's ids are those of a poll part K-04 holds.",
  },
  {
    id: "consumer-action-layer",
    side: "consumer",
    owner: "action-layer engineer",
    components: ["C-083 limit 3"],
    needs:
      "Refuses every invalid fixture (nothing from an event the schema or the named rule refuses reaches it). A poll vote reaches limit 3 as an exact yes, and an edit after its turn committed as a new answer (S13-25 rules 20, 21); a tapback is never a yes.",
  },
];

describe("inbound-event.v1 sides: the list where each producer and consumer side is added", () => {
  const readme = readFileSync(path.join(INBOUND_DIR, "README.md"), "utf8");
  const start = readme.indexOf("## Producers and consumers");
  const listed = readme.slice(start, readme.indexOf("- **Contract test**", start));

  it("names each side once, with the producers and consumers of the README", () => {
    const ids = SIDE_CHECKS.map((side) => side.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SIDE_CHECKS.filter((side) => side.side === "producer")).toHaveLength(3);
    expect(SIDE_CHECKS.filter((side) => side.side === "consumer")).toHaveLength(2);
    for (const side of SIDE_CHECKS) {
      expect(side.owner, side.id).not.toBe("");
      expect(side.components.length, side.id).toBeGreaterThan(0);
      expect(side.needs, side.id).not.toBe("");
      if (side.side === "consumer") expect(side.needs, side.id).toMatch(/refuses every invalid/i);
    }
  });

  it("names every component the README's producers and consumers list, and no other", () => {
    expect(start).toBeGreaterThan(-1);
    const named = new Set(listed.match(/C-\d{3}/g));
    const held = new Set(SIDE_CHECKS.flatMap((side) => side.components.join(" ").match(/C-\d{3}/g) ?? []));
    expect(named.size).toBeGreaterThan(10);
    expect([...held].sort()).toEqual([...named].sort());
  });

  it("spells each side's owner and components as the README does", () => {
    for (const side of SIDE_CHECKS) {
      expect(listed, side.id).toContain(side.owner);
      for (const component of side.components) expect(listed, side.id).toContain(component);
    }
  });

  for (const side of SIDE_CHECKS) {
    if (side.check === undefined) continue;
    const check = side.check;
    it(`${side.side} side ${side.id}`, () => {
      expect(check()).toEqual([]);
    });
  }
});
