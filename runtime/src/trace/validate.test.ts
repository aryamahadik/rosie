// Tests of the span check (T-240; K-08 v1). The check is code because the Worker cannot run Ajv; so every test that
// matters here holds it to the contract's own schema: it accepts every span of K-08's accepted fixtures, refuses the
// refused fixtures, and agrees with the schema on each fault below (the schema loaded with Ajv 2020, the common and
// bundle schemas included). Test values only: the fixtures' sample cast and the 555-01xx range (rule 9).

import { describe, expect, it } from "vitest";

import { eventTraceFixture, schemaErrors } from "./test-support";
import { bundleIdProblems, isLabel, spanProblems } from "./validate";

type Json = Record<string, unknown>;

/** Every span in a fixture, whether it is a span, a trace or a trace set. */
function spansOf(document: unknown): Json[] {
  const json = document as Json;
  if (Array.isArray(json.traces)) return (json.traces as Json[]).flatMap((trace) => spansOf(trace));
  if (Array.isArray(json.spans)) return json.spans as Json[];
  return [json];
}

const ACCEPTED = [
  "trace-skeleton.json",
  "trace-duplicate-webhook.json",
  "trace-batch-three-texts.json",
  "trace-clock-fire.json",
  "trace-model-call-cost.json",
  "span-effect-run-retry.json",
  "span-places-call.json",
];

const BUNDLE = { hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037", build: 1 };

/** A valid span to break one rule at a time. */
function span(extra: Json = {}): Json {
  return {
    trace_id: "trace-test-0001",
    span_id: "span-test-0001-01",
    seq: 1,
    hop: "guard",
    at: "2026-10-22T16:00:00Z",
    ms: 5,
    bundle_id: BUNDLE,
    turn_id: null,
    handle_ref: "handle-alex",
    outcome: "ok",
    ...extra,
  };
}

describe("K-08 v1 accepted fixtures", () => {
  for (const file of ACCEPTED) {
    it(`every span of ${file} passes the check and the schema`, () => {
      const spans = spansOf(eventTraceFixture(file));
      expect(spans.length).toBeGreaterThan(0);
      for (const one of spans) {
        expect(schemaErrors("span", one)).toEqual([]);
        expect(spanProblems(one)).toEqual([]);
      }
    });
  }
});

describe("K-08 v1 refused fixtures", () => {
  it("refuse-raw-phone-in-span.json: a phone number as the handle reference is refused, and accepted as the handle id", () => {
    const refused = eventTraceFixture("invalid/refuse-raw-phone-in-span.json") as Json;
    expect(schemaErrors("span", refused)).not.toEqual([]);
    expect(spanProblems(refused)).toEqual([expect.stringContaining("handle_ref")]);
    const fixed = { ...refused, handle_ref: "handle-sam" };
    expect(schemaErrors("span", fixed)).toEqual([]);
    expect(spanProblems(fixed)).toEqual([]);
  });

  it("refuse-raw-text-in-span.json: a person's words in got are refused, and accepted once dropped", () => {
    const refused = eventTraceFixture("invalid/refuse-raw-text-in-span.json") as Json;
    expect(schemaErrors("span", refused)).not.toEqual([]);
    expect(spanProblems(refused)).toEqual([expect.stringContaining("got.words")]);
    const fixed = { ...refused, got: { kind: "text", service: "imessage" } };
    expect(schemaErrors("span", fixed)).toEqual([]);
    expect(spanProblems(fixed)).toEqual([]);
  });

  it("refuse-span-without-bundle-id.json: a span without a bundle id is refused, and accepted once it has one", () => {
    const refused = eventTraceFixture("invalid/refuse-span-without-bundle-id.json") as Json;
    expect(schemaErrors("span", refused)).not.toEqual([]);
    expect(spanProblems(refused)).toEqual(["bundle_id is missing"]);
    const fixed = { ...refused, bundle_id: BUNDLE };
    expect(schemaErrors("span", fixed)).toEqual([]);
    expect(spanProblems(fixed)).toEqual([]);
  });
});

describe("no personal value and no key in a span", () => {
  const words = "Barbershop, plumbing, electrical";
  const faults: [string, Json][] = [
    ["a phone number in E.164 form as a fact", span({ got: { number: "+15555550100" } })],
    ["a phone number of bare digits as a fact", span({ got: { number: "15555550100" } })],
    ["a phone number written with punctuation as a fact", span({ got: { number: "(555) 555-0100" } })],
    ["a phone number as the handle reference", span({ handle_ref: "+15555550100" })],
    ["a phone number as the handle reference without the plus", span({ handle_ref: "555-555-0100" })],
    ["message words as a fact", span({ got: { words } })],
    ["a short message with a space as a fact", span({ decided: { choice: "move it please" } })],
    ["message words in a list of labels", span({ got: { eventIds: ["evt-1", "see you at 3"] } })],
    ["an email address as a fact", span({ got: { address: "sam@example.com" } })],
    ["an email address as the business id", span({ business_id: "sam@example.com" })],
    ["words as the handle reference", span({ handle_ref: "Alex M." })],
    ["words as an error code", span({ error_code: "the phone was off" })],
    ["words as a call", span({ hop: "portCall", provider: "geo", call: "look up 12 Main St", attempt: 1 })],
    ["a card number as a fact", span({ got: { card: "4242 4242 4242 4242" } })],
    ["a fractional number as a fact", span({ got: { price: 12.5 } })],
    ["a nested object as a fact", span({ got: { person: { name: "Alex" } } })],
    ["the vendor as a fact name", span({ got: { provider: "linq" } })],
    ["a field the contract does not have", span({ text: words })],
    ["a field the contract does not have: a key", span({ api_key: "sk_live_abc" })],
  ];

  for (const [name, fault] of faults) {
    it(`refuses ${name}, as the schema does`, () => {
      expect(spanProblems(fault)).not.toEqual([]);
      expect(schemaErrors("span", fault)).not.toEqual([]);
    });
  }

  it("keeps ids, labels, counts, yes or no and lists of labels", () => {
    const fine = span({
      got: { texts: 3, eventIds: ["evt-alex-0003", "evt-alex-0004"], kind: "text", service: "imessage" },
      decided: { signatureValid: true, keyword: null, step: "A7-03", choice: "A7-03/2" },
      error_code: "503",
    });
    expect(spanProblems(fine)).toEqual([]);
    expect(schemaErrors("span", fine)).toEqual([]);
  });
});

describe("the contract's other rules", () => {
  const faults: [string, Json][] = [
    ["an outside call without its provider, call and attempt", span({ hop: "portCall" })],
    ["an effect run without its attempt", span({ hop: "effectRun", provider: "stripe", call: "charge" })],
    ["a dispatch that sends without its provider", span({ hop: "dispatch" })],
    ["a webhook's receive without its provider", span({ hop: "receive" })],
    ["a gate without its limits", span({ hop: "gate" })],
    ["a gate with an empty list of limits", span({ hop: "gate", limits: [] })],
    ["a model hop without its model calls", span({ hop: "planner" })],
    ["a provider off the closed list", span({ hop: "receive", provider: "twilio" })],
    ["a hop off the list", span({ hop: "mystery" })],
    ["an outcome off the list", span({ outcome: "great" })],
    ["a bundle hash in capitals", span({ bundle_id: { hash: BUNDLE.hash.toUpperCase(), build: 1 } })],
    ["a build number of 0", span({ bundle_id: { hash: BUNDLE.hash, build: 0 } })],
    ["a seq of 0", span({ seq: 0 })],
    ["a negative time", span({ ms: -1 })],
    ["a time not in UTC", span({ at: "2026-10-22T12:00:00-04:00" })],
    ["an attempt of 0", span({ hop: "portCall", provider: "geo", call: "geocode", attempt: 0 })],
    ["a limit 9", span({ hop: "gate", limits: [{ limit: 9, result: "pass", outcome: null }] })],
    [
      "a missing handle_ref",
      Object.fromEntries(Object.entries(span()).filter(([key]) => key !== "handle_ref")),
    ],
  ];

  for (const [name, fault] of faults) {
    it(`refuses ${name}, as the schema does`, () => {
      expect(spanProblems(fault)).not.toEqual([]);
      expect(schemaErrors("span", fault)).not.toEqual([]);
    });
  }

  it("lets a dispatch that sends nothing (dropped) omit provider, call and attempt", () => {
    const dropped = span({ hop: "dispatch", outcome: "dropped" });
    expect(spanProblems(dropped)).toEqual([]);
    expect(schemaErrors("span", dropped)).toEqual([]);
  });
});

describe("labels and bundle ids", () => {
  it("isLabel follows K-08 v1's safe id", () => {
    expect(isLabel("handle-alex")).toBe(true);
    expect(isLabel("A7-03/2")).toBe(true);
    expect(isLabel("2026-10-22")).toBe(false);
    expect(isLabel("+15555550100")).toBe(false);
    expect(isLabel("")).toBe(false);
    expect(isLabel(7)).toBe(false);
  });

  it("bundleIdProblems asks for 64 lowercase hex characters and a build from 1", () => {
    expect(bundleIdProblems(BUNDLE)).toEqual([]);
    expect(bundleIdProblems(undefined)).not.toEqual([]);
    expect(bundleIdProblems({ hash: "abc", build: 1 })).not.toEqual([]);
    expect(bundleIdProblems({ hash: BUNDLE.hash, build: 1, extra: true })).not.toEqual([]);
  });
});
