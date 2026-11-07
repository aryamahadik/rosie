// The hand-off's output against K-06's own schema and named rules (T-243). Ajv builds code at run time, which the
// Workers runtime does not allow, so this runs in Node; the Workers tests (hand-off.worker.test.ts) run the same
// fixtures through the gateway. Every fixture of contracts/inbound-event (accepted and refused-raw) goes through
// prepareHandoff, the sealed words are put back, and what comes out must be a valid K-06 v1.1 event that the rule
// `scrubbedV1dot1` accepts.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { prepareHandoff } from "./hand-off";
import { openWords } from "./seal";
import { fakeKeyStore, present } from "./test-support";
import type { InboundEvent } from "./types";

const DIR = fileURLToPath(new URL("../../../contracts/inbound-event/", import.meta.url));

interface RulesModule {
  scrubbed: (event: unknown) => string[];
  scrubbedV1dot1: (event: unknown) => string[];
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
