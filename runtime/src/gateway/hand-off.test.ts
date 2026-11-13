// The hand-off's output against K-06's own schema and named rules (T-243). Ajv builds code at run time, which the
// Workers runtime does not allow, so this runs in Node; the Workers tests (hand-off.worker.test.ts) run the same
// fixtures through the gateway. Every fixture of contracts/inbound-event (accepted and refused-raw) goes through
// prepareHandoff, the sealed words are put back, and what comes out must be a valid K-06 v1.1 event that the rule
// `scrubbedV1dot1` accepts.
//
// K-06 v1.2's sealed hand-off (T-1297; README "The sealed hand-off (v1.2)", items 1 to 7): what the actor is handed, as its
// inbox keeps it (event_json is JSON.stringify of the hand-off's event: runtime/src/actor/inbox.ts writeToInbox), is
// `#/$defs/sealedEvent`, its box opens to `#/$defs/sealedWords`, and the event rebuilt from them passes `scrubbedV1dot2`;
// a card number or a Social Security number typed as a new option is in no plain field and reads back tagged from the
// box; a hand-off made before v1.2 (`sealedEventV1`, its box `sealedBoxV1`) still opens to `sealedWordsV1`. Test values
// only: the fixtures' public test card 4242 4242 4242 4242 and the printed sample number 123-45-6789 (rule 9).

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { ACTOR_KINDS, prepareHandoff } from "./hand-off";
import { actorNameOf, openWords, optionWordsOf, sealWords, wordsOfEvent } from "./seal";
import { fakeKeyStore, present } from "./test-support";
import type { InboundEvent, SealedEvent } from "./types";

const DIR = fileURLToPath(new URL("../../../contracts/inbound-event/", import.meta.url));

interface RulesModule {
  scrubbed: (event: unknown) => string[];
  scrubbedV1dot1: (event: unknown) => string[];
  scrubbedV1dot2: (event: unknown) => string[];
}
const rules = (await import(pathToFileURL(`${DIR}inbound-event.rules.mjs`).href)) as RulesModule;

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(`${DIR}${file}`, "utf8")) as unknown;
}

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
for (const file of [
  "../common/formats.v1.schema.json",
  "../model/model.v1.schema.json",
  "inbound-event.v1.schema.json",
]) {
  ajv.addSchema(readJson(file) as object);
}
const validate = ajv.compile(readJson("inbound-event.v1.1.schema.json") as object);

const V1_2 = "https://rosie.invalid/contracts/inbound-event/inbound-event.v1.2.schema.json";
ajv.addSchema(readJson("inbound-event.v1.2.schema.json") as object);

/** K-06 v1.2's definition `name`'s problems with `value`; empty when it accepts it. */
function problemsAs(name: string, value: unknown): string[] {
  const check = present(ajv.getSchema(`${V1_2}#/$defs/${name}`), `K-06 v1.2 #/$defs/${name}`);
  if (check(value)) return [];
  return (check.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

const bundleId = { hash: "a".repeat(64), build: 1 };

function eventFiles(): string[] {
  const accepted = readdirSync(`${DIR}fixtures`).filter((f) => f.endsWith(".json") && f !== "index.json");
  const raw = readdirSync(`${DIR}fixtures/invalid`).filter((f) => f.startsWith("refuse-unscrubbed-"));
  return [...accepted, ...raw.map((f) => `invalid/${f}`)].map((f) => f);
}

describe("prepareHandoff over every K-06 fixture the Linq parse can produce", () => {
  const files = eventFiles().filter((file) => {
    const event = readJson(`fixtures/${file}`) as { provider: string };
    return event.provider === "linq";
  });

  it("finds the fixtures", () => {
    expect(files.length).toBeGreaterThanOrEqual(25);
  });

  it.each(files)("%s: the event the actor rebuilds is valid K-06 v1.1 and scrubbed", async (file) => {
    const event = readJson(`fixtures/${file}`) as InboundEvent;
    const keys = fakeKeyStore();

    const prepared = await prepareHandoff({ event, partKey: null, traceId: "t", bundleId }, keys);

    let rebuilt: Record<string, unknown>;
    if (prepared.door === "actor") {
      const { sealed, ...rest } = prepared.handoff.event;
      rebuilt = { ...rest, body: null };
      if (sealed !== null) {
        const key = keys.keyOf(event.handle);
        const words = await openWords(sealed, key, prepared.handoff.actorName, event.eventId);
        rebuilt.body = words.body;
        if (typeof rebuilt.email === "object" && rebuilt.email !== null) {
          rebuilt.email = { ...rebuilt.email, subject: words.subject };
        }
        // K-06 v1.2 seals a vote's option words too (T-1297): put back with the body and the subject (DL-554).
        if (typeof rebuilt.poll === "object" && rebuilt.poll !== null) {
          rebuilt.poll = { ...rebuilt.poll, optionWords: words.optionWords };
        }
      }
    } else {
      rebuilt = { ...prepared.handoff.event };
    }

    expect(validate(rebuilt), JSON.stringify(validate.errors)).toBe(true);
    expect(rules.scrubbedV1dot1(rebuilt)).toEqual([]);
  });

  it("an event with a card number is refused by v1's rule raw and passes it after the hand-off", async () => {
    const event = readJson("fixtures/invalid/refuse-unscrubbed-card.json") as InboundEvent;
    expect(rules.scrubbed(event).length).toBeGreaterThan(0);
    const keys = fakeKeyStore();

    const prepared = await prepareHandoff({ event, partKey: null, traceId: "t", bundleId }, keys);

    if (prepared.door !== "actor") throw new Error("a text goes to the actor");
    const key = keys.keyOf(event.handle);
    const words = await openWords(
      present(prepared.handoff.event.sealed, "the sealed box"),
      key,
      prepared.handoff.actorName,
      event.eventId,
    );
    expect(rules.scrubbed({ ...event, body: words.body })).toEqual([]);
  });
});

/** A copy of an object without one field. */
function without(value: object, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== field));
}

/** A fixture's hand-off to the handle's actor, with the key store it was sealed under. */
async function actorHandoffOf(file: string): Promise<{
  event: InboundEvent;
  prepared: Extract<Awaited<ReturnType<typeof prepareHandoff>>, { door: "actor" }>;
  keys: ReturnType<typeof fakeKeyStore>;
}> {
  const event = readJson(`fixtures/${file}`) as InboundEvent;
  const keys = fakeKeyStore();
  const prepared = await prepareHandoff({ event, partKey: null, traceId: "t", bundleId }, keys);
  if (prepared.door !== "actor") throw new Error(`${file} does not go to the actor`);
  return { event, prepared, keys };
}

/** The event as the actor's inbox keeps it, event_json (inbox.ts writeToInbox: JSON.stringify of the hand-off's event). */
const eventJsonOf = (event: SealedEvent): string => JSON.stringify(event);

describe("K-06 v1.2's sealed hand-off (T-1297): what the actor is handed and keeps", () => {
  // Every fixture the actor takes, from Linq and from email (the Resend door hands a reply over through prepareHandoff too).
  const actorFiles = eventFiles().filter((file) => {
    const event = readJson(`fixtures/${file}`) as { kind: string };
    return ACTOR_KINDS.includes(event.kind);
  });

  it("reads every fixture the actor takes, the votes, v1.2's twins and the email replies among them", () => {
    expect(actorFiles).toEqual(
      expect.arrayContaining([
        "poll-vote.json",
        "poll-vote-removed.json",
        "poll-vote-added-option-with-card.json",
        "vote-removed-added-option-with-ssn.json",
        "invalid/refuse-unscrubbed-card-in-added-option.json",
        "invalid/refuse-unscrubbed-ssn-in-added-option.json",
        "email-reply-check-passed.json",
        "email-reply-check-failed.json",
      ]),
    );
  });

  it.each(actorFiles)(
    "%s: event_json is #/$defs/sealedEvent, its box form 2 opens to #/$defs/sealedWords, and the event rebuilt from them passes scrubbedV1dot2",
    async (file) => {
      const { event, prepared, keys } = await actorHandoffOf(file);

      const kept = JSON.parse(eventJsonOf(prepared.handoff.event)) as SealedEvent;

      expect(problemsAs("sealedEvent", kept)).toEqual([]);
      if (kept.sealed === null) {
        // Only a reaction has no words to seal (item 2).
        expect(event.kind).toBe("reaction");
        return;
      }
      expect(kept.sealed.v).toBe(2);
      const words = await openWords(
        kept.sealed,
        keys.keyOf(event.handle),
        actorNameOf(event.handle),
        event.eventId,
      );
      expect(problemsAs("sealedWords", words)).toEqual([]);
      const rebuilt: Record<string, unknown> = { ...without(kept, "sealed"), body: words.body };
      if (typeof kept.email === "object" && kept.email !== null) {
        rebuilt.email = { ...kept.email, subject: words.subject };
      }
      if (typeof kept.poll === "object" && kept.poll !== null) {
        rebuilt.poll = { ...kept.poll, optionWords: words.optionWords };
        expect(optionWordsOf(kept, words)).toBe(words.optionWords);
      }
      expect(validate(rebuilt), JSON.stringify(validate.errors)).toBe(true);
      expect(rules.scrubbedV1dot2(rebuilt)).toEqual([]);
    },
  );

  it.each<[string, string, string[]]>([
    [
      "invalid/refuse-unscrubbed-card-in-added-option.json",
      "poll-vote-added-option-with-card.json",
      ["4242 4242 4242 4242", "4242424242424242"],
    ],
    [
      "invalid/refuse-unscrubbed-ssn-in-added-option.json",
      "vote-removed-added-option-with-ssn.json",
      ["123-45-6789", "123456789"],
    ],
  ])(
    "%s: no number in any plain field or in event_json, and the option reads back from the box as its tagged twin's, with the twin's count",
    async (raw, tagged, numbers) => {
      const { event, prepared, keys } = await actorHandoffOf(raw);
      const twin = readJson(`fixtures/${tagged}`) as {
        poll: { pollId: string; optionId: string; optionWords: string };
        scrubbed: { cards: number; ssns: number };
      };
      const typed = (event.poll as { optionWords: string }).optionWords;
      expect(numbers.some((number) => typed.includes(number))).toBe(true);
      expect(rules.scrubbedV1dot2(event).length).toBeGreaterThan(0);

      const kept = eventJsonOf(prepared.handoff.event);

      for (const number of numbers) {
        expect(kept).not.toContain(number);
        expect(JSON.stringify(prepared)).not.toContain(number);
      }
      expect(kept).not.toContain(typed);
      const sealed = JSON.parse(kept) as SealedEvent;
      expect(sealed.poll).toEqual({ pollId: twin.poll.pollId, optionId: twin.poll.optionId });
      expect(sealed.scrubbed).toEqual(twin.scrubbed);
      // K-08's scrub span counts what this scrub swapped in the option's words (v1.2 default 5).
      expect({ cards: prepared.scrub.cards, ssns: prepared.scrub.ssns }).toEqual(twin.scrubbed);
      const words = await openWords(
        present(sealed.sealed, "the vote's box"),
        keys.keyOf(event.handle),
        actorNameOf(event.handle),
        event.eventId,
      );
      expect(words).toEqual({ body: null, subject: null, optionWords: twin.poll.optionWords });
      expect(rules.scrubbedV1dot2({ ...without(sealed, "sealed"), body: null, poll: twin.poll })).toEqual([]);
    },
  );

  it("a hand-off made before v1.2 (sealedEventV1) still opens as it is: a text's form 1 box to sealedWordsV1, a vote's words from its plain poll", async () => {
    const keys = fakeKeyStore();
    const text = readJson("fixtures/text-imessage.json") as InboundEvent & { body: string };
    const vote = readJson("fixtures/poll-vote.json") as InboundEvent;
    const name = actorNameOf(text.handle);
    const key = await keys.getOrCreateKey(text.handle);
    // As T-243's gateway kept them: a text's body and subject in a form 1 box, a vote's option words plain with no box.
    const keptText = {
      ...without(text, "body"),
      sealed: await sealWords({ body: text.body, subject: null }, key, name, text.eventId),
    } as SealedEvent;
    const keptVote = { ...without(vote, "body"), sealed: null } as SealedEvent;

    expect(problemsAs("sealedEventV1", keptText)).toEqual([]);
    expect(problemsAs("sealedEventV1", keptVote)).toEqual([]);
    // Neither is the form v1.2 hands over: the box is form 1, and the vote's option words are plain.
    expect(problemsAs("sealedEvent", keptText)).not.toEqual([]);
    expect(problemsAs("sealedEvent", keptVote)).not.toEqual([]);

    const opened = await openWords(present(keptText.sealed, "the form 1 box"), key, name, text.eventId);

    expect(opened).toEqual({ body: text.body, subject: null });
    expect(problemsAs("sealedWordsV1", opened)).toEqual([]);
    expect(wordsOfEvent(keptText, opened)).toEqual({ body: text.body, subject: null });
    expect(wordsOfEvent(keptVote, null)).toEqual({ body: null, subject: null, optionWords: "Sat 2:00pm" });
    expect(optionWordsOf(keptVote, null)).toBe("Sat 2:00pm");
  });
});
