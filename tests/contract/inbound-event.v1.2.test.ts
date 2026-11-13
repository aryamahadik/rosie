// Contract test for K-06 v1.2, the inbound event's minor version (T-1308, on T-1296's handoff; ops/plan/02-contracts.md
// K-06; contracts/inbound-event/README.md "v1.2 (T-1296)", "Named rule (v1.2)", "The sealed hand-off (v1.2)", the v1.2
// fixtures, "Defaults used (T-1296, v1.2)" and "Open gaps (v1.2)").
//
// T-085's test (inbound-event.v1.test.ts) checks every entry of fixtures/index.json against the schema its version names
// and runs the rule it names, the v1.2 entries included. This part proves what v1.2 adds:
//   1. the v1.2 fixtures: each accepted one passes the v1.2 schema and scrubbedV1dot2; each refused twin passes the
//      schema, v1's scrubbed and v1.1's scrubbedV1dot1, and scrubbedV1dot2 refuses it for its one stated reason (one
//      line, on poll.optionWords, for its kind of number); it differs from its accepted twin only in the option's words
//      and the counts, and mended with the twin's words and counts it is the twin and is accepted;
//   2. the rule over option words: scrubbedV1dot2 reads a poll's option words exactly as scrubbedV1dot1 reads the body,
//      `scrubbed` counts the tags in them (v1.2 default 5), and the rule only widens;
//   3. every earlier fixture is valid under v1.2: the v1.2 root is v1's event, so every accepted v1 and v1.1 fixture is
//      accepted and passes scrubbedV1dot2, and every refused one stays refused;
//   4. the sealed hand-off (README "The sealed hand-off (v1.2)", items 1 to 7): every accepted fixture the actor takes,
//      sealed in form 2 (sealedEvent, its box sealedBox opening to sealedWords) and in form 1 (sealedEventV1, its box
//      sealedBoxV1 opening to sealedWordsV1), is accepted by its definition and holds exactly the event's words; a plain
//      body, subject or option word is refused in both forms (a form 1 vote keeps its option words plain: item 5, the
//      one place a plain option word is form 1's own); the boxes' forms and members; the additional data; a reader that
//      takes the words by the form and fails closed (item 6); the form outside the additional data (item 7);
//   5. where the sealed-event fixtures live (CQ-261 (a)).
//
// CQ-261 (a), ruled here (T-1308): the sealed-event fixtures live in this file. They are made by code at run time from
// every accepted fixture the actor takes, in both forms, each box sealed with AES-256-GCM under a key made for the run,
// with the README's IV, tag and additional data (README "Open gaps (v1.2)": a box worth checking needs a key and a seal
// made by code). None is a file under contracts/inbound-event/fixtures/, so no frozen fixture or index entry moves, and the
// tests that read every fixture there as a root event (T-085's test, runtime/src/scrub/scrub.test.ts and
// runtime/src/gateway/hand-off.test.ts) never meet one, unchanged. Part 5 holds the ruling: it fails when a file under
// fixtures/ is a sealed event or an index entry names a `def`, because a sealed event kept there must first be skipped by
// those three readers.
//
// Test values only (rule 9): the fixtures' cast and ids, the public test card 4242 4242 4242 4242 and the printed sample
// number 123-45-6789. The keys are made at run time for this test and never kept.

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

/** A value a fixture must hold; the fixtures are checked against the schema first, so a miss is a broken test. */
function must<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("a fixture lacks a value this test reads");
  return value;
}

/** An index entry; `rule` names a rule of inbound-event.rules.mjs (contracts/common/fixtures-index.meta.schema.json). */
type Entry = FixtureEntry & { rule?: string };

const entries = (readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: Entry[] }).fixtures;
const entryOf = (file: string): Entry => must(entries.find((entry) => entry.file === file));
const acceptedEntries = entries.filter((entry) => entry.expect === "accept");
const earlierEntries = entries.filter((entry) => entry.version === "v1" || entry.version === "v1.1");

interface Handle {
  kind: string;
  address: string;
}

// What the checks read of a root event (v1.2's root is v1's event). The fixtures are checked against the schema first,
// so a cast to this shape reads only fields the schema requires.
interface InboundEvent {
  eventId: string;
  provider: "linq" | "email";
  handle: Handle;
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

/** A fresh copy of a fixture, read as a root event. */
const eventOf = (file: string): InboundEvent =>
  readJson(path.join(FIXTURES_DIR, ...file.split("/"))) as InboundEvent;

/** A vote's option words. */
const optionWordsOf = (event: InboundEvent): string => must(event.poll).optionWords;

/** A copy of a vote fixture with other option words. */
function withOptionWords(file: string, words: string): InboundEvent {
  const event = eventOf(file);
  must(event.poll).optionWords = words;
  return event;
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
// The schemas (the harness's strict Ajv 2020-12 setup, as in T-085's test), v1.2's definitions, and the named rules

const ajv = new Ajv2020({ strict: true, strictRequired: false });
for (const folder of ["common", "bundle", "model", "inbound-event"]) {
  const dir = path.join(CONTRACTS_ROOT, folder);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".schema.json"))
      ajv.addSchema(readJson(path.join(dir, entry.name)) as object);
  }
}

const schemaFile = (version: string): string =>
  path.join(INBOUND_DIR, `inbound-event.${version}.schema.json`);

/** The validator of a version's root, or of one of its definitions under $defs. */
function validatorOf(version: string, definition?: string): ValidateFunction {
  const { $id } = readJson(schemaFile(version)) as { $id: string };
  const target = definition === undefined ? $id : `${$id}#/$defs/${definition}`;
  const validate = ajv.getSchema(target);
  if (validate === undefined) throw new Error(`no schema at ${target}`);
  return validate;
}

const ROOT_V1 = validatorOf("v1");
const ROOT_V1DOT1 = validatorOf("v1.1");
const ROOT_V1DOT2 = validatorOf("v1.2");
const SEALED_EVENT = validatorOf("v1.2", "sealedEvent");
const SEALED_EVENT_V1 = validatorOf("v1.2", "sealedEventV1");
const SEALED_BOX = validatorOf("v1.2", "sealedBox");
const SEALED_BOX_V1 = validatorOf("v1.2", "sealedBoxV1");
const SEALED_WORDS = validatorOf("v1.2", "sealedWords");
const SEALED_WORDS_V1 = validatorOf("v1.2", "sealedWordsV1");

/** "accepted", or the validator's errors, so a failing check says why. */
function verdict(validate: ValidateFunction, value: unknown): string {
  return validate(value) ? "accepted" : formatErrors(validate.errors).join("; ");
}

type Rule = (event: unknown) => string[];
const rulesModule = (await import(pathToFileURL(path.join(INBOUND_DIR, "inbound-event.rules.mjs")).href)) as {
  rules: Record<string, Rule>;
  CARD_TAG: string;
  SSN_TAG: string;
};
const { CARD_TAG, SSN_TAG } = rulesModule;
const rule = (name: string): Rule => must(rulesModule.rules[name]);
const scrubbedRule = rule("scrubbed");
const scrubbedV1dot1 = rule("scrubbedV1dot1");
const scrubbedV1dot2 = rule("scrubbedV1dot2");

// ---------------------------------------------------------------------------------------------------------------
// The counts (README "Named rule (v1.2)", "The counts"; v1.2 default 5)

const countOf = (words: string, tag: string): number => words.split(tag).length - 1;

/** The words of a root event: the body, an email's subject and, unless left out, a poll's option words. */
function wordsIn(event: InboundEvent, withOptions = true): string[] {
  return [event.body, event.email?.subject, withOptions ? event.poll?.optionWords : undefined].filter(
    (part): part is string => typeof part === "string",
  );
}

/** `scrubbed`'s counts against the tags in the words; one line per count that does not match. */
function tagCountProblems(event: InboundEvent, withOptions = true): string[] {
  const words = wordsIn(event, withOptions);
  const cards = words.reduce((sum, part) => sum + countOf(part, CARD_TAG), 0);
  const ssns = words.reduce((sum, part) => sum + countOf(part, SSN_TAG), 0);
  const problems: string[] = [];
  if (cards !== event.scrubbed.cards)
    problems.push(`${String(cards)} ${CARD_TAG} tags but scrubbed.cards is ${String(event.scrubbed.cards)}`);
  if (ssns !== event.scrubbed.ssns)
    problems.push(`${String(ssns)} ${SSN_TAG} tags but scrubbed.ssns is ${String(event.scrubbed.ssns)}`);
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// 1. The v1.2 fixtures: each accepted one passes, each refused twin fails for its one reason, and its mend passes

const CARD = "card number";
const SSN = "Social Security number";

/**
 * The README's v1.2 table: each refused raw vote, its accepted tagged twin, the option's words in each, and the one line
 * scrubbedV1dot2 gives for the number left plain (README "Named rule (v1.2)": the field and a count of digits, never the
 * digits).
 */
const TWINS: readonly {
  refused: string;
  tagged: string;
  kind: "pollVote" | "voteRemoved";
  number: typeof CARD | typeof SSN;
  rawWords: string;
  taggedWords: string;
  line: string;
}[] = [
  {
    refused: "invalid/refuse-unscrubbed-card-in-added-option.json",
    tagged: "poll-vote-added-option-with-card.json",
    kind: "pollVote",
    number: CARD,
    rawWords: "Charge my card 4242 4242 4242 4242 instead",
    taggedWords: "Charge my card [card number] instead",
    line: "poll.optionWords: holds a card number (a 13 to 19 digit Luhn window in a run of 16 digits); it must be [card number]",
  },
  {
    refused: "invalid/refuse-unscrubbed-ssn-in-added-option.json",
    tagged: "vote-removed-added-option-with-ssn.json",
    kind: "voteRemoved",
    number: SSN,
    rawWords: "My SSN is 123-45-6789",
    taggedWords: "My SSN is [SSN]",
    line: "poll.optionWords: holds a Social Security number; it must be [SSN]",
  },
];

describe("inbound-event v1.2 fixtures: each accepted one passes, each refused twin fails for its one reason", () => {
  it("lists the four fixtures of the README's v1.2 table, each for scrubbedV1dot2, the refused ones in invalid/", () => {
    const listed = entries.filter((entry) => entry.version === "v1.2");
    expect(listed.map((entry) => entry.file).sort()).toEqual(
      TWINS.flatMap((twin) => [twin.refused, twin.tagged]).sort(),
    );
    for (const entry of listed) expect(entry.rule, entry.file).toBe("scrubbedV1dot2");
    for (const twin of TWINS) {
      expect([entryOf(twin.refused).expect, entryOf(twin.tagged).expect]).toEqual(["refuse", "accept"]);
      expect(twin.refused.startsWith("invalid/"), twin.refused).toBe(true);
      expect([eventOf(twin.refused).kind, eventOf(twin.tagged).kind]).toEqual([twin.kind, twin.kind]);
      expect(optionWordsOf(eventOf(twin.refused))).toBe(twin.rawWords);
      expect(optionWordsOf(eventOf(twin.tagged))).toBe(twin.taggedWords);
    }
    // The harness checks each against the v1.2 root; the refused twins pass it, so their rule alone refuses them.
    const report = checkContractFixtures("inbound-event", { sharedFolders: ["common", "bundle", "model"] });
    expect(report.problems).toEqual([]);
    const results = report.entries.filter((result) => result.version === "v1.2");
    expect(results.map((result) => result.file).sort()).toEqual(listed.map((entry) => entry.file).sort());
    for (const result of results) {
      expect([result.schema, result.def, result.outcome], result.file).toEqual([
        "inbound-event.v1.2.schema.json",
        null,
        "accepted",
      ]);
    }
  });

  for (const twin of TWINS) {
    it(`accepts ${twin.tagged}: the v1.2 schema and scrubbedV1dot2 pass it, its tag counted`, () => {
      const event = eventOf(twin.tagged);
      expect(verdict(ROOT_V1DOT2, event)).toBe("accepted");
      expect(scrubbedV1dot2(event)).toEqual([]);
      expect(scrubbedV1dot1(event)).toEqual([]);
      expect(scrubbedRule(event)).toEqual([]);
      expect(event.body).toBeNull();
      expect(event.scrubbed).toEqual(twin.number === CARD ? { cards: 1, ssns: 0 } : { cards: 0, ssns: 1 });
      expect(tagCountProblems(event)).toEqual([]);
    });

    it(`refuses ${twin.refused} for its one reason: the schema and the earlier rules pass it, and scrubbedV1dot2 finds one ${twin.number} in the option's words`, () => {
      const event = eventOf(twin.refused);
      expect(verdict(ROOT_V1DOT2, event)).toBe("accepted");
      // v1's and v1.1's rules read only the body and an email's subject (CQ-58's gap), so both pass it.
      expect(scrubbedRule(event)).toEqual([]);
      expect(scrubbedV1dot1(event)).toEqual([]);
      expect(scrubbedV1dot2(event)).toEqual([twin.line]);
      expect(event.scrubbed).toEqual({ cards: 0, ssns: 0 });
    });

    it(`has ${twin.refused} differ from ${twin.tagged} only in the option's words and the counts`, () => {
      const strip = (event: InboundEvent): object => ({
        ...event,
        poll: { ...must(event.poll), optionWords: null },
        scrubbed: null,
      });
      expect(strip(eventOf(twin.refused))).toEqual(strip(eventOf(twin.tagged)));
      expect(eventOf(twin.refused)).not.toEqual(eventOf(twin.tagged));
    });

    it(`mends ${twin.refused} with its twin's option words and counts: it is ${twin.tagged} and is accepted; either alone is not enough`, () => {
      const tagged = eventOf(twin.tagged);
      const mended = eventOf(twin.refused);
      expect(scrubbedV1dot2(mended)).toEqual([twin.line]);
      must(mended.poll).optionWords = optionWordsOf(tagged);
      mended.scrubbed = tagged.scrubbed;
      expect(mended).toEqual(tagged);
      expect(scrubbedV1dot2(mended)).toEqual([]);
      expect(verdict(ROOT_V1DOT2, mended)).toBe("accepted");
      expect(tagCountProblems(mended)).toEqual([]);
      // The words alone: the rule passes, but `scrubbed` does not count the tag (v1.2 default 5).
      const wordsOnly = withOptionWords(twin.refused, optionWordsOf(tagged));
      expect(scrubbedV1dot2(wordsOnly)).toEqual([]);
      expect(tagCountProblems(wordsOnly)).toHaveLength(1);
      // The counts alone: the number is still there.
      const countsOnly = eventOf(twin.refused);
      countsOnly.scrubbed = tagged.scrubbed;
      expect(scrubbedV1dot2(countsOnly)).toEqual([twin.line]);
    });

    it(`has the tag in ${twin.tagged} stand exactly where the number stood in ${twin.refused}`, () => {
      const parts = twin.taggedWords.split(twin.number === CARD ? CARD_TAG : SSN_TAG);
      expect(parts).toHaveLength(2);
      const before = must(parts[0]);
      const after = must(parts[1]);
      expect(twin.rawWords.startsWith(before) && twin.rawWords.endsWith(after)).toBe(true);
      const number = twin.rawWords.slice(before.length, twin.rawWords.length - after.length);
      expect(number).toMatch(/^[0-9](?:[ -]?[0-9])*$/);
      // The number alone is refused for its kind, and the words around it are not.
      expect(scrubbedV1dot2(withOptionWords(twin.refused, number))).toEqual([twin.line]);
      expect(scrubbedV1dot2(withOptionWords(twin.refused, `${before}${after}`))).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The rule over option words, and the counts

describe("inbound-event v1.2 rule: scrubbedV1dot2 reads a poll's option words, and `scrubbed` counts their tags", () => {
  it("has `scrubbed` count the tags in the body, the subject and the option's words of every accepted fixture", () => {
    for (const entry of acceptedEntries)
      expect(tagCountProblems(eventOf(entry.file)), entry.file).toEqual([]);
    // The v1.2 twins hold their tag in the option's words alone, so a count of the body and the subject misses it.
    for (const twin of TWINS) {
      expect(tagCountProblems(eventOf(twin.tagged), false), twin.tagged).toEqual([
        twin.number === CARD
          ? "0 [card number] tags but scrubbed.cards is 1"
          : "0 [SSN] tags but scrubbed.ssns is 1",
      ]);
    }
  });

  it("has the count check fire on a damaged copy: a tag in the option's words left uncounted, or a count with no tag", () => {
    const card = eventOf("poll-vote-added-option-with-card.json");
    card.scrubbed.cards = 0;
    expect(tagCountProblems(card)).toEqual(["1 [card number] tags but scrubbed.cards is 0"]);
    const ssn = eventOf("vote-removed-added-option-with-ssn.json");
    ssn.scrubbed.ssns = 2;
    expect(tagCountProblems(ssn)).toEqual(["1 [SSN] tags but scrubbed.ssns is 2"]);
    expect(tagCountProblems(withOptionWords("poll-vote.json", "Sat [card number] [SSN]"))).toEqual([
      "1 [card number] tags but scrubbed.cards is 0",
      "1 [SSN] tags but scrubbed.ssns is 0",
    ]);
  });

  it("reads a vote's and a vote removed's option words exactly as scrubbedV1dot1 reads the body, on the words of every fixture", () => {
    const samples = [...new Set(entries.flatMap((entry) => wordsIn(eventOf(entry.file))))];
    expect(samples.length).toBeGreaterThan(20);
    for (const words of samples) {
      const text = eventOf("text-imessage.json");
      text.body = words;
      const asBody = scrubbedV1dot1(text).map((line) => line.replace(/^body: /, "poll.optionWords: "));
      for (const file of ["poll-vote.json", "poll-vote-removed.json"]) {
        const vote = withOptionWords(file, words);
        expect(scrubbedV1dot2(vote), `${file}: ${words}`).toEqual(asBody);
        // Neither earlier rule reads the option's words (CQ-58's gap), so this widening is v1.2's own.
        expect([scrubbedRule(vote), scrubbedV1dot1(vote)], `${file}: ${words}`).toEqual([[], []]);
      }
    }
    // Every number a refused fixture holds, typed as an option instead, is refused.
    for (const entry of entries.filter(
      (candidate) => candidate.expect === "refuse" && candidate.rule !== undefined,
    )) {
      const refusedAsOption = wordsIn(eventOf(entry.file)).some(
        (words) => scrubbedV1dot2(withOptionWords("poll-vote.json", words)).length > 0,
      );
      expect(refusedAsOption, entry.file).toBe(true);
    }
  });

  it("only widens: on every fixture, scrubbedV1dot2 gives scrubbedV1dot1's lines first, then lines on the option's words alone", () => {
    for (const entry of entries) {
      const event = eventOf(entry.file);
      const earlier = scrubbedV1dot1(event);
      const lines = scrubbedV1dot2(event);
      expect(lines.slice(0, earlier.length), entry.file).toEqual(earlier);
      for (const line of lines.slice(earlier.length))
        expect(line, entry.file).toMatch(/^poll\.optionWords: /);
      if (scrubbedRule(event).length > 0) expect(lines.length, entry.file).toBeGreaterThan(0);
    }
  });

  it("keeps Rosie's own option words and nine bare digits as words (v1.2 default 1; README default 1)", () => {
    expect(optionWordsOf(eventOf("poll-vote.json"))).toBe("Sat 2:00pm");
    expect(scrubbedV1dot2(eventOf("poll-vote.json"))).toEqual([]);
    expect(scrubbedV1dot2(eventOf("poll-vote-removed.json"))).toEqual([]);
    expect(scrubbedV1dot2(withOptionWords("poll-vote.json", "My booking code is 123456789"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Every earlier fixture is valid under v1.2

describe("inbound-event v1.2: every earlier fixture is valid under v1.2", () => {
  it("has the v1.2 root be v1's event: v1, v1.1 and v1.2 decide every fixture alike, and v1.2 requires v1's fields", () => {
    const requiredOf = (version: string): string[] =>
      [...must((readJson(schemaFile(version)) as { required?: string[] }).required)].sort();
    expect(requiredOf("v1.2")).toEqual(requiredOf("v1"));
    for (const entry of entries) {
      const event = eventOf(entry.file);
      const byV1 = ROOT_V1(event);
      expect([ROOT_V1DOT1(event), ROOT_V1DOT2(event)], entry.file).toEqual([byV1, byV1]);
    }
  });

  it("accepts every accepted v1 and v1.1 fixture by the v1.2 schema, and scrubbedV1dot2 passes each", () => {
    const accepted = earlierEntries.filter((entry) => entry.expect === "accept");
    expect(new Set(accepted.map((entry) => entry.version))).toEqual(new Set(["v1", "v1.1"]));
    for (const entry of accepted) {
      const event = eventOf(entry.file);
      expect(verdict(ROOT_V1DOT2, event), entry.file).toBe("accepted");
      expect(scrubbedV1dot2(event), entry.file).toEqual([]);
    }
  });

  it("still refuses every refused v1 and v1.1 fixture under v1.2: by scrubbedV1dot2, or refuse-no-event-id by the schema", () => {
    const refused = earlierEntries.filter((entry) => entry.expect === "refuse");
    expect(refused.filter((entry) => entry.rule === undefined).map((entry) => entry.file)).toEqual([
      "invalid/refuse-no-event-id.json",
    ]);
    for (const entry of refused) {
      const event = eventOf(entry.file);
      if (entry.rule === undefined) {
        expect(ROOT_V1DOT2(event), entry.file).toBe(false);
      } else {
        expect(verdict(ROOT_V1DOT2, event), entry.file).toBe("accepted");
        expect(scrubbedV1dot2(event).length, entry.file).toBeGreaterThan(0);
        // No earlier fixture holds option words with a number, so v1.2 refuses each for v1.1's reasons exactly.
        expect(scrubbedV1dot2(event), entry.file).toEqual(scrubbedV1dot1(event));
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. The sealed hand-off, with the sealed-event fixtures made here (CQ-261 (a))

/** README "Routing": the kinds that go to the handle's actor, the only kinds a sealed event takes (item 2). */
const TO_ACTOR = ["text", "photo", "reaction", "pollVote", "voteRemoved", "edit"];
/** README item 2: every kind with words gets a box of form 2; a reaction has none. */
const WITH_WORDS = ["text", "photo", "edit", "pollVote", "voteRemoved"];
/** README item 5 and sealedEventV1: form 1 sealed only the body and the subject, so only these kinds had a box. */
const BOXED_IN_FORM_1 = ["text", "photo", "edit"];

interface Box {
  v: number;
  alg: string;
  iv: string;
  ct: string;
}

/** The event as the actor is handed it and keeps it, in either form (a form 1 vote's poll keeps its option words). */
interface SealedEvent {
  eventId: string;
  provider: string;
  handle: Handle;
  service: string | null;
  kind: string;
  messageId: string | null;
  chatId: string | null;
  sentAt: string | null;
  receivedAt: string;
  scrubbed: { cards: number; ssns: number };
  attachments: { attachmentId: string; mediaType: string }[];
  threadedReplyTo: string | null;
  poll: { pollId: string; optionId: string; optionWords?: string } | null;
  reaction: { reaction: string; onMessageId: string } | null;
  edit: { messageId: string } | null;
  status: null;
  fromRosie: boolean;
  email: { replyAddress: string; senderCheck: string } | null;
  traceId: string;
  sealed: Box | null;
}

/** An event's words, the three members of a box of form 2 (sealedWords). */
interface Words {
  body: string | null;
  subject: string | null;
  optionWords: string | null;
}

const wordsOf = (event: InboundEvent): Words => ({
  body: event.body,
  subject: event.email?.subject ?? null,
  optionWords: event.poll?.optionWords ?? null,
});

/** README item 3: the actor's name, '<handle.kind>:<handle.address>'. */
const actorNameOf = (handle: Handle): string => `${handle.kind}:${handle.address}`;

/** README item 3: the additional data, the UTF-8 text '<actor name>|<event id>'. */
const additionalData = (actorName: string, eventId: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new TextEncoder().encode(`${actorName}|${eventId}`));

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let at = 0; at < raw.length; at += 1) bytes[at] = raw.charCodeAt(at);
  return bytes;
}

/** A handle's data key (AES-256) for this run only, made from fresh random bytes and never kept. */
const keyForThisRun = (): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
const KEY = await keyForThisRun();
const OTHER_KEY = await keyForThisRun();

/**
 * README item 3: one JSON text sealed with AES-256-GCM under the handle's key, with a fresh random 96-bit IV and the
 * 128-bit tag after the cipher text, bound to its handle and event by the additional data; the box names its form `v`.
 */
async function seal(contents: unknown, v: number, actorName: string, eventId: string): Promise<Box> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(actorName, eventId), tagLength: 128 },
    KEY,
    new TextEncoder().encode(JSON.stringify(contents)),
  );
  return { v, alg: "A256GCM", iv: toBase64(iv), ct: toBase64(new Uint8Array(cipher)) };
}

/** Opens a box to the JSON it holds; throws unless the key, the handle and the event are the ones it was sealed for. */
async function open(box: Box, actorName: string, eventId: string, key = KEY): Promise<unknown> {
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(box.iv),
      additionalData: additionalData(actorName, eventId),
      tagLength: 128,
    },
    key,
    fromBase64(box.ct),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as unknown;
}

/** Whether a box opens for this handle and event under this key. */
async function opens(box: Box, actorName: string, eventId: string, key = KEY): Promise<boolean> {
  try {
    await open(box, actorName, eventId, key);
    return true;
  } catch {
    return false;
  }
}

/** README item 1: the event with every word a person typed taken out; form 1 kept a vote's option words (item 5). */
function withoutWords(event: InboundEvent, form: 1 | 2): Omit<SealedEvent, "sealed"> {
  const copy = structuredClone(event);
  Reflect.deleteProperty(copy, "body");
  if (copy.email !== null) Reflect.deleteProperty(copy.email, "subject");
  if (copy.poll !== null && form === 2) Reflect.deleteProperty(copy.poll, "optionWords");
  return copy as unknown as Omit<SealedEvent, "sealed">;
}

/** Form 2 (sealedEvent; items 1 to 3): the body, the subject and the option's words in one box of form 2. */
async function sealForm2(event: InboundEvent): Promise<SealedEvent> {
  const sealed = WITH_WORDS.includes(event.kind)
    ? await seal(wordsOf(event), 2, actorNameOf(event.handle), event.eventId)
    : null;
  return { ...withoutWords(event, 2), sealed };
}

/** Form 1 (sealedEventV1; item 5): the body and the subject in a box of form 1, a vote's words plain and unboxed. */
async function sealForm1(event: InboundEvent): Promise<SealedEvent> {
  const words = { body: event.body, subject: event.email?.subject ?? null };
  const sealed = BOXED_IN_FORM_1.includes(event.kind)
    ? await seal(words, 1, actorNameOf(event.handle), event.eventId)
    : null;
  return { ...withoutWords(event, 1), sealed };
}

/** The sealed-event fixtures (CQ-261 (a)): every accepted fixture the actor takes, sealed in both forms. */
const sealedFixtures = await Promise.all(
  acceptedEntries
    .map((entry) => ({ file: entry.file, event: eventOf(entry.file) }))
    .filter(({ event }) => TO_ACTOR.includes(event.kind))
    .map(async ({ file, event }) => ({
      file,
      event,
      form2: await sealForm2(event),
      form1: await sealForm1(event),
    })),
);
const sealedFixture = (file: string): (typeof sealedFixtures)[number] =>
  must(sealedFixtures.find((candidate) => candidate.file === file));

/** What a reader makes of a sealed event (item 6): its words, or why it refuses them, with nothing in them read. */
type Reading =
  | { words: Words }
  | { refused: "noBox" | "noOptionWords" | "unknownForm" | "doesNotOpen" | "notItsFormsMembers" };

/**
 * Items 5 and 6 as a reader of a kept event states them: the words by the box's form, failing closed. Form 2: all three
 * from the box, never from a plain field. Form 1: the body and the subject from the box. No box: a reaction, which has
 * no words, or a vote kept before v1.2, whose option words are its plain poll.optionWords.
 */
async function readWords(event: SealedEvent, key = KEY): Promise<Reading> {
  const box = event.sealed;
  if (box === null) {
    if (event.kind === "reaction") return { words: { body: null, subject: null, optionWords: null } };
    if (event.kind !== "pollVote" && event.kind !== "voteRemoved") return { refused: "noBox" };
    const plain = event.poll?.optionWords;
    if (plain === undefined) return { refused: "noOptionWords" };
    return { words: { body: null, subject: null, optionWords: plain } };
  }
  const members = box.v === 2 ? SEALED_WORDS : box.v === 1 ? SEALED_WORDS_V1 : undefined;
  if (members === undefined) return { refused: "unknownForm" };
  let opened: unknown;
  try {
    opened = await open(box, actorNameOf(event.handle), event.eventId, key);
  } catch {
    return { refused: "doesNotOpen" };
  }
  if (!members(opened)) return { refused: "notItsFormsMembers" };
  const words = opened as Words;
  return {
    words: { body: words.body, subject: words.subject, optionWords: box.v === 2 ? words.optionWords : null },
  };
}

/** Item 1 read back: the sealed event with its words put back in their fields. */
function withWords(event: SealedEvent, words: Words): InboundEvent {
  const copy = structuredClone(event) as unknown as Record<string, unknown>;
  Reflect.deleteProperty(copy, "sealed");
  copy.body = words.body;
  if (event.email !== null) copy.email = { ...event.email, subject: words.subject };
  if (event.poll !== null) copy.poll = { ...event.poll, optionWords: words.optionWords };
  return copy as unknown as InboundEvent;
}

describe("inbound-event v1.2 sealed hand-off: form 2 (sealedEvent) and form 1 (sealedEventV1) accepted", () => {
  it("makes a sealed event of every accepted fixture the actor takes: every kind, both providers, each member of the words", () => {
    expect(new Set(sealedFixtures.map(({ event }) => event.kind))).toEqual(new Set(TO_ACTOR));
    expect(new Set(sealedFixtures.map(({ event }) => event.provider))).toEqual(new Set(["linq", "email"]));
    for (const member of ["body", "subject", "optionWords"] as const) {
      expect(
        sealedFixtures.some(({ event }) => wordsOf(event)[member] !== null),
        member,
      ).toBe(true);
    }
    // The receipts go to the dispatcher, never to the actor (README "Routing"), so neither form takes one.
    const receipts = acceptedEntries
      .map((entry) => eventOf(entry.file))
      .filter((e) => !TO_ACTOR.includes(e.kind));
    expect(receipts.length).toBeGreaterThan(0);
    for (const receipt of receipts) {
      for (const status of [receipt.status, null]) {
        const handed = { ...withoutWords(receipt, 2), status, sealed: null };
        expect([SEALED_EVENT(handed), SEALED_EVENT_V1(handed)], receipt.eventId).toEqual([false, false]);
      }
    }
  });

  for (const { file, event, form2, form1 } of sealedFixtures) {
    it(`${file}: form 2 is a sealedEvent whose words are only in a sealedBox that opens to exactly its sealedWords`, async () => {
      expect(verdict(SEALED_EVENT, form2)).toBe("accepted");
      expect(Object.keys(form2)).not.toContain("body");
      if (form2.email !== null) expect(Object.keys(form2.email)).not.toContain("subject");
      if (form2.poll !== null) expect(Object.keys(form2.poll)).not.toContain("optionWords");
      if (WITH_WORDS.includes(event.kind)) {
        const box = must(form2.sealed);
        expect([verdict(SEALED_BOX, box), SEALED_BOX_V1(box)]).toEqual(["accepted", false]);
        const opened = await open(box, actorNameOf(form2.handle), form2.eventId);
        expect([verdict(SEALED_WORDS, opened), SEALED_WORDS_V1(opened)]).toEqual(["accepted", false]);
        expect(opened).toEqual(wordsOf(event));
        expect(SEALED_EVENT_V1(form2), "a box of form 2 is not form 1's").toBe(false);
      } else {
        // Item 2: a reaction has no words, so no box, and its sealed event is the same in both forms.
        expect(form2.sealed).toBeNull();
        expect(form2).toEqual(form1);
      }
      expect(await readWords(form2)).toEqual({ words: wordsOf(event) });
      expect(withWords(form2, wordsOf(event))).toEqual(event);
    });

    it(`${file}: form 1 is a sealedEventV1, the body and the subject in a sealedBoxV1 that opens to its sealedWordsV1`, async () => {
      expect(verdict(SEALED_EVENT_V1, form1)).toBe("accepted");
      expect(Object.keys(form1)).not.toContain("body");
      if (form1.email !== null) expect(Object.keys(form1.email)).not.toContain("subject");
      if (BOXED_IN_FORM_1.includes(event.kind)) {
        const box = must(form1.sealed);
        expect([verdict(SEALED_BOX_V1, box), SEALED_BOX(box)]).toEqual(["accepted", false]);
        const opened = await open(box, actorNameOf(form1.handle), form1.eventId);
        expect([verdict(SEALED_WORDS_V1, opened), SEALED_WORDS(opened)]).toEqual(["accepted", false]);
        expect(opened).toEqual({ body: event.body, subject: event.email?.subject ?? null });
        expect(SEALED_EVENT(form1), "a box of form 1 is not form 2's").toBe(false);
      } else {
        expect(form1.sealed).toBeNull();
      }
      if (event.poll !== null) {
        // Item 5: a vote kept before v1.2 has no box, its option words plain in its poll, which form 2 refuses.
        expect(form1.poll).toEqual(event.poll);
        expect(SEALED_EVENT(form1)).toBe(false);
      }
      expect(await readWords(form1)).toEqual({ words: wordsOf(event) });
      expect(withWords(form1, wordsOf(event))).toEqual(event);
    });
  }
});

describe("inbound-event v1.2 sealed hand-off: plain words refused, and the definitions not vacuous", () => {
  it("refuses a plain body, an email's plain subject or a vote's plain option words in form 2, and plain words beside the fields", () => {
    for (const { file, event, form2 } of sealedFixtures) {
      expect(verdict(SEALED_EVENT, form2), file).toBe("accepted");
      const words = event.body ?? event.poll?.optionWords ?? "Sat 2:00pm";
      expect(SEALED_EVENT({ ...form2, body: words }), `${file}: a plain body`).toBe(false);
      expect(SEALED_EVENT({ ...form2, subject: words }), `${file}: a plain subject`).toBe(false);
      expect(SEALED_EVENT({ ...form2, optionWords: words }), `${file}: plain option words`).toBe(false);
      if (form2.email !== null) {
        const subject = must(event.email).subject;
        expect(SEALED_EVENT({ ...form2, email: { ...form2.email, subject } }), `${file}: email.subject`).toBe(
          false,
        );
      }
      if (form2.poll !== null) {
        const optionWords = optionWordsOf(event);
        expect(
          SEALED_EVENT({ ...form2, poll: { ...form2.poll, optionWords } }),
          `${file}: poll.optionWords`,
        ).toBe(false);
      }
    }
    // Both nested checks above ran: on the email replies and on the votes.
    expect(sealedFixtures.filter(({ form2 }) => form2.email !== null).length).toBeGreaterThan(0);
    expect(sealedFixtures.filter(({ form2 }) => form2.poll !== null).length).toBeGreaterThan(0);
  });

  it("refuses a plain body or an email's plain subject in form 1, and plain option words anywhere but a form 1 vote's poll (item 5)", () => {
    const vote = { pollId: "linq-msg-demo-0002", optionId: "linq-opt-demo-2", optionWords: "Sat 2:00pm" };
    for (const { file, event, form1 } of sealedFixtures) {
      expect(verdict(SEALED_EVENT_V1, form1), file).toBe("accepted");
      const words = event.body ?? event.poll?.optionWords ?? "Sat 2:00pm";
      expect(SEALED_EVENT_V1({ ...form1, body: words }), `${file}: a plain body`).toBe(false);
      expect(SEALED_EVENT_V1({ ...form1, subject: words }), `${file}: a plain subject`).toBe(false);
      expect(SEALED_EVENT_V1({ ...form1, optionWords: words }), `${file}: plain option words`).toBe(false);
      if (form1.email !== null) {
        const subject = must(event.email).subject;
        expect(
          SEALED_EVENT_V1({ ...form1, email: { ...form1.email, subject } }),
          `${file}: email.subject`,
        ).toBe(false);
      }
      if (form1.poll === null) {
        // A text, a photo, an edit or a reaction has no poll, so no option words, plain or not.
        expect(SEALED_EVENT_V1({ ...form1, poll: vote }), `${file}: a poll with option words`).toBe(false);
      } else {
        // A form 1 vote's option words are plain by its definition (item 5): they are its only words.
        expect(form1.poll.optionWords, file).toBe(optionWordsOf(event));
        const ids = { pollId: form1.poll.pollId, optionId: form1.poll.optionId };
        expect(SEALED_EVENT_V1({ ...form1, poll: ids }), `${file}: a form 1 vote without its words`).toBe(
          false,
        );
      }
    }
  });

  it("refuses a sealed event of either form without any one of its fields, or with a field its definition does not know", () => {
    for (const { file, form2, form1 } of sealedFixtures) {
      for (const [validate, sealed, form] of [
        [SEALED_EVENT, form2, "form 2"],
        [SEALED_EVENT_V1, form1, "form 1"],
      ] as const) {
        expect(verdict(validate, sealed), `${file} ${form}`).toBe("accepted");
        const paths = propertyPaths(sealed);
        expect(paths.length, `${file} ${form}`).toBeGreaterThan(20);
        for (const where of paths) {
          expect(validate(without(sealed, where)), `${file} ${form} without ${where.join(".")}`).toBe(false);
        }
        expect(validate({ ...sealed, notInTheDefinition: 1 }), `${file} ${form} with an unknown field`).toBe(
          false,
        );
      }
    }
  });

  it("refuses a sealed event whose words are not where its kind and provider keep them, in either form", () => {
    const text = sealedFixture("text-imessage.json");
    const vote = sealedFixture("poll-vote.json");
    const reaction = sealedFixture("reaction-from-customer.json");
    const email = sealedFixture("email-reply-check-passed.json");
    const box2 = must(text.form2.sealed);
    const box1 = must(text.form1.sealed);
    // Form 2: a kind with words carries a box of form 2, a reaction none; a vote names its poll by ids, a text no poll;
    // an email reply carries its email, which only email has, as kind text.
    expect(SEALED_EVENT({ ...text.form2, sealed: null })).toBe(false);
    expect(SEALED_EVENT({ ...vote.form2, sealed: null })).toBe(false);
    expect(SEALED_EVENT({ ...reaction.form2, sealed: box2 })).toBe(false);
    expect(SEALED_EVENT({ ...vote.form2, poll: null })).toBe(false);
    expect(SEALED_EVENT({ ...text.form2, poll: vote.form2.poll })).toBe(false);
    expect(SEALED_EVENT({ ...email.form2, email: null })).toBe(false);
    expect(SEALED_EVENT({ ...text.form2, email: email.form2.email })).toBe(false);
    expect(
      SEALED_EVENT({ ...email.form2, kind: "edit", edit: { messageId: "email-msg-demo-alex-0001" } }),
    ).toBe(false);
    expect(SEALED_EVENT({ ...text.form2, sealed: box1 })).toBe(false);
    // Form 1: a text's box is of form 1, a vote and a reaction have none, a vote's poll keeps its words plain.
    expect(SEALED_EVENT_V1({ ...text.form1, sealed: null })).toBe(false);
    expect(SEALED_EVENT_V1({ ...vote.form1, sealed: box1 })).toBe(false);
    expect(SEALED_EVENT_V1({ ...reaction.form1, sealed: box1 })).toBe(false);
    expect(SEALED_EVENT_V1({ ...vote.form1, poll: null })).toBe(false);
    expect(SEALED_EVENT_V1({ ...text.form1, poll: vote.form1.poll })).toBe(false);
    expect(SEALED_EVENT_V1({ ...email.form1, email: null })).toBe(false);
    expect(SEALED_EVENT_V1({ ...text.form1, email: email.form1.email })).toBe(false);
    expect(SEALED_EVENT_V1({ ...text.form1, sealed: box2 })).toBe(false);
    // Each mutation above changes one field of a sealed event its definition accepts.
    for (const { file, form2, form1 } of [text, vote, reaction, email]) {
      expect([verdict(SEALED_EVENT, form2), verdict(SEALED_EVENT_V1, form1)], file).toEqual([
        "accepted",
        "accepted",
      ]);
    }
  });

  it("takes a box only as its form's definition says: its form, its algorithm, a 12-byte IV and the cipher text with its tag", () => {
    const { event, form2, form1 } = sealedFixture("text-imessage.json");
    const box2 = must(form2.sealed);
    const box1 = must(form1.sealed);
    expect([verdict(SEALED_BOX, box2), verdict(SEALED_BOX_V1, box1)]).toEqual(["accepted", "accepted"]);
    expect([SEALED_BOX(box1), SEALED_BOX_V1(box2)]).toEqual([false, false]);
    for (const [validate, box] of [
      [SEALED_BOX, box2],
      [SEALED_BOX_V1, box1],
    ] as const) {
      expect(validate({ ...box, v: 3 }), "a form it does not know").toBe(false);
      expect(validate({ ...box, v: String(box.v) }), "a form that is not a number").toBe(false);
      expect(validate({ ...box, alg: "A128GCM" }), "another algorithm").toBe(false);
      expect(box.iv).toHaveLength(16);
      expect(validate({ ...box, iv: box.iv.slice(1) }), "an IV too short").toBe(false);
      expect(validate({ ...box, iv: `${box.iv}AAAA` }), "an IV too long").toBe(false);
      expect(validate({ ...box, iv: `${box.iv.slice(2)}==` }), "an IV padded").toBe(false);
      expect(validate({ ...box, ct: box.ct.slice(1) }), "cipher text cut").toBe(false);
      expect(validate({ ...box, ct: `${box.ct} ` }), "cipher text with a space").toBe(false);
      expect(validate({ ...box, ct: box.ct.replace(/[A-Za-z0-9]/, "-") }), "URL-safe base64").toBe(false);
      expect(validate({ ...box, ct: "" }), "no cipher text").toBe(false);
      expect(validate({ ...box, aad: "phone:+15555550101|evt-alex-0001" }), "a member more").toBe(false);
    }
    // The cipher text is as long as the sealed JSON, with the 16-byte tag after it.
    const sealedJson = new TextEncoder().encode(JSON.stringify(wordsOf(event)));
    expect(fromBase64(box2.ct)).toHaveLength(sealedJson.length + 16);
    expect(fromBase64(box2.iv)).toHaveLength(12);
  });

  it("takes opened words only as the form's members: exactly three in form 2 and two in form 1, each a string or null", () => {
    const words = { body: "Haircut at Lee's Barbershop this Saturday?", subject: null, optionWords: null };
    expect(verdict(SEALED_WORDS, words)).toBe("accepted");
    expect(verdict(SEALED_WORDS_V1, { body: words.body, subject: words.subject })).toBe("accepted");
    expect(SEALED_WORDS({ body: words.body, subject: null }), "a member missing").toBe(false);
    expect(SEALED_WORDS({ ...words, more: "words" }), "a member more").toBe(false);
    expect(SEALED_WORDS({ ...words, optionWords: 2 }), "a member of another type").toBe(false);
    expect(SEALED_WORDS({ ...words, body: ["Haircut"] }), "a member of another type").toBe(false);
    expect(SEALED_WORDS_V1(words), "form 2's three members").toBe(false);
    expect(SEALED_WORDS_V1({ body: words.body }), "a member missing").toBe(false);
    expect(SEALED_WORDS_V1({ body: 1, subject: null }), "a member of another type").toBe(false);
  });
});

describe("inbound-event v1.2 sealed hand-off: the seal, and a reader that takes the words by the form", () => {
  it("opens a box only under its handle's key, for its own handle and event (item 3: the additional data)", async () => {
    const { event, form2 } = sealedFixture("text-imessage.json");
    const box = must(form2.sealed);
    const actorName = actorNameOf(form2.handle);
    expect(await open(box, actorName, form2.eventId)).toEqual(wordsOf(event));
    expect(await opens(box, actorName, "evt-alex-0002"), "copied onto another event").toBe(false);
    const otherHandle = actorNameOf({ kind: "email", address: "alex@example.com" });
    expect(await opens(box, otherHandle, form2.eventId), "copied onto another handle").toBe(false);
    expect(await opens(box, actorName, form2.eventId, OTHER_KEY), "under another key").toBe(false);
    const bytes = fromBase64(box.ct);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(await opens({ ...box, ct: toBase64(bytes) }, actorName, form2.eventId), "a changed byte").toBe(
      false,
    );
  });

  it("has a reader take the words by the box's form and fail closed (item 6): an unknown form, a box that does not open, members not its form's", async () => {
    const { event, form2 } = sealedFixture("text-imessage.json");
    const box = must(form2.sealed);
    const sealOnto = (contents: unknown, v: number): Promise<Box> =>
      seal(contents, v, actorNameOf(form2.handle), form2.eventId);
    expect(await readWords(form2)).toEqual({ words: wordsOf(event) });
    expect(await readWords({ ...form2, sealed: { ...box, v: 3 } })).toEqual({ refused: "unknownForm" });
    expect(await readWords({ ...form2, eventId: "evt-alex-0002" })).toEqual({ refused: "doesNotOpen" });
    expect(await readWords(form2, OTHER_KEY)).toEqual({ refused: "doesNotOpen" });
    const { body, subject, optionWords } = wordsOf(event);
    for (const contents of [
      { body, subject },
      { body, subject, optionWords, more: "words" },
      { body: 1, subject, optionWords },
      body,
    ]) {
      expect(
        await readWords({ ...form2, sealed: await sealOnto(contents, 2) }),
        JSON.stringify(contents),
      ).toEqual({
        refused: "notItsFormsMembers",
      });
    }
    expect(await readWords({ ...form2, sealed: await sealOnto({ body, subject, optionWords }, 1) })).toEqual({
      refused: "notItsFormsMembers",
    });
    expect(await readWords({ ...form2, sealed: null })).toEqual({ refused: "noBox" });
  });

  it("reads a form 2 vote's option words from its box only, and a form 1 vote's from its plain poll (items 5 and 6)", async () => {
    const { event, form2, form1 } = sealedFixture("poll-vote-added-option-with-card.json");
    const forged = {
      ...form2,
      poll: { ...must(form2.poll), optionWords: "Charge my card 4242 4242 4242 4242 instead" },
    };
    expect(SEALED_EVENT(forged)).toBe(false);
    // A reader never takes a plain field beside a box of form 2: it reads the box's words, the tag in place.
    expect(await readWords(forged)).toEqual({ words: wordsOf(event) });
    expect(optionWordsOf(event)).toBe("Charge my card [card number] instead");
    expect(form1.sealed).toBeNull();
    expect(await readWords(form1)).toEqual({ words: wordsOf(event) });
    const unworded = {
      ...form1,
      poll: { pollId: must(form1.poll).pollId, optionId: must(form1.poll).optionId },
    };
    expect(await readWords(unworded)).toEqual({ refused: "noOptionWords" });
  });

  it("keeps the form outside the additional data (item 7): a box relabeled to the other form still opens, and its members are refused", async () => {
    const { form2, form1 } = sealedFixture("text-imessage.json");
    const actorName = actorNameOf(form2.handle);
    const oneAsTwo = { ...must(form1.sealed), v: 2 };
    expect(verdict(SEALED_BOX, oneAsTwo)).toBe("accepted");
    expect(SEALED_WORDS(await open(oneAsTwo, actorName, form1.eventId))).toBe(false);
    expect(await readWords({ ...form2, sealed: oneAsTwo })).toEqual({ refused: "notItsFormsMembers" });
    const twoAsOne = { ...must(form2.sealed), v: 1 };
    expect(verdict(SEALED_BOX_V1, twoAsOne)).toBe("accepted");
    expect(SEALED_WORDS_V1(await open(twoAsOne, actorName, form2.eventId))).toBe(false);
    expect(await readWords({ ...form1, sealed: twoAsOne })).toEqual({ refused: "notItsFormsMembers" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Where the sealed-event fixtures live (CQ-261 (a))

describe("inbound-event v1.2: the sealed-event fixtures live here, apart from the fixtures read as root events (CQ-261 (a))", () => {
  it("keeps every sealed event out of contracts/inbound-event/fixtures/: no file there is one, and no index entry names a def", () => {
    const onDisk = readdirSync(FIXTURES_DIR, { recursive: true, encoding: "utf8" })
      .map((file) => file.split(path.sep).join("/"))
      .filter((file) => file.endsWith(".json") && file !== "index.json");
    expect([...onDisk].sort()).toEqual(entries.map((entry) => entry.file).sort());
    for (const file of onDisk) {
      const fixture = readJson(path.join(FIXTURES_DIR, ...file.split("/"))) as Record<string, unknown>;
      // T-085's test, scrub.test.ts and hand-off.test.ts read every file here as a root event.
      expect(Object.keys(fixture), `${file} is read as a root event`).not.toContain("sealed");
    }
    expect(entries.filter((entry) => entry.def !== undefined).map((entry) => entry.file)).toEqual([]);
  });

  it("never takes a root event for a sealed one, nor a sealed event of either form for a root one", () => {
    for (const entry of entries) {
      const event = eventOf(entry.file);
      expect([SEALED_EVENT(event), SEALED_EVENT_V1(event)], entry.file).toEqual([false, false]);
    }
    expect(sealedFixtures.length).toBeGreaterThan(15);
    for (const { file, form2, form1 } of sealedFixtures) {
      for (const sealed of [form2, form1]) {
        expect([ROOT_V1(sealed), ROOT_V1DOT1(sealed), ROOT_V1DOT2(sealed)], file).toEqual([
          false,
          false,
          false,
        ]);
      }
    }
  });
});
