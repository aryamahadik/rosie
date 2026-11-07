// T-410: the span helper builds K-08 v1 spans for outside calls (provider, call, attempt) and redacts a phone number,
// message text and keys. Spans are checked against contracts/event-trace's own schema, and the one fixture of an
// outside call (span-places-call.json) is rebuilt from its inputs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";

import { REDACTED } from "./redact";
import {
  buildOutsideCallSpan,
  sanitizeFacts,
  spanLogLine,
  type OutsideCallSpan,
  type OutsideCallSpanInput,
} from "./spans";

const CONTRACTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../contracts");
const readJson = (relative: string): unknown =>
  JSON.parse(readFileSync(path.join(CONTRACTS, ...relative.split("/")), "utf8")) as unknown;

let validateSpan: (value: unknown) => boolean;
let errors: () => string;

beforeAll(() => {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  for (const file of [
    "common/formats.v1.schema.json",
    "bundle/bundle.v1.schema.json",
    "event-trace/event-trace.v1.schema.json",
  ])
    ajv.addSchema(readJson(file) as object);
  const validate = ajv.getSchema(
    "https://rosie.invalid/contracts/event-trace/event-trace.v1.schema.json#/$defs/span",
  );
  if (validate === undefined) throw new Error("the K-08 span definition is missing");
  validateSpan = (value) => validate(value) === true;
  errors = () => JSON.stringify(validate.errors);
});

const HASH = "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037";
const FAKE_PHONE = "+14155550123"; // the fictional 555-01xx block
const FAKE_KEY = ["sk_", "test_", "0123456789abcdefXYZ"].join(""); // key-shaped, not a key

function input(overrides: Partial<OutsideCallSpanInput> = {}): OutsideCallSpanInput {
  return {
    traceId: "trace-t410-0001",
    spanId: "span-t410-0001-03",
    seq: 3,
    hop: "portCall",
    at: new Date("2026-10-19T14:12:31.400Z"),
    ms: 120,
    bundleId: { hash: HASH, build: 1 },
    turnId: "turn-t410",
    handleRef: "handle-t410",
    provider: "linq",
    call: "sendPart",
    attempt: 1,
    outcome: "ok",
    ...overrides,
  };
}

function ok(span: OutsideCallSpan): OutsideCallSpan {
  expect(validateSpan(span), errors()).toBe(true);
  return span;
}

describe("buildOutsideCallSpan", () => {
  it("rebuilds the K-08 fixture of an outside call (span-places-call.json)", () => {
    const fixture = readJson("event-trace/fixtures/span-places-call.json");
    const span = ok(
      buildOutsideCallSpan({
        traceId: "trace-sam-0009",
        spanId: "span-sam-0009-08",
        seq: 8,
        hop: "portCall",
        at: new Date("2026-10-19T14:12:31.400Z"),
        ms: 340,
        bundleId: { hash: HASH, build: 1 },
        turnId: "turn-s1-09-sam",
        handleRef: "handle-sam",
        provider: "google_places",
        call: "search",
        attempt: 1,
        got: { step: "S1-09", searchBy: "nameAndTown" },
        decided: { candidates: 1, listing: "places-demo-lees-barbershop" },
        outcome: "ok",
      }),
    );
    expect(span).toMatchObject(fixture as object);
  });

  it("carries provider, call and attempt on each outside-call hop, and the result validates", () => {
    for (const hop of ["portCall", "effectRun", "dispatch"] as const) {
      const span = ok(buildOutsideCallSpan(input({ hop, provider: "stripe", call: "charge", attempt: 2 })));
      expect(span).toMatchObject({ hop, provider: "stripe", call: "charge", attempt: 2 });
    }
  });

  it("carries a provider's error code as a label and null when there is none", () => {
    expect(ok(buildOutsideCallSpan(input({ outcome: "failed", errorCode: 2024 }))).error_code).toBe("2024");
    expect(ok(buildOutsideCallSpan(input())).error_code).toBeNull();
  });

  it("redacts a phone number and message text, wherever they sit in what a hop got or decided", () => {
    const span = ok(
      buildOutsideCallSpan(
        input({
          got: {
            to: FAKE_PHONE,
            text: "yes",
            body: "I would like a haircut at 3pm",
            target: FAKE_PHONE,
            spaced: "(415) 555-0123",
            dashed: "415-555-0123",
            detail: "I would like a haircut at 3pm",
            parts: 2,
            hasPhoto: true,
            missing: null,
            kind: "text",
            optionIds: ["A7-03/2", FAKE_PHONE, "a haircut please"],
          },
          decided: { reply: "Sure, see you at 3pm", fromNumber: "+1 415 555 0123", sent: 1 },
        }),
      ),
    );
    expect(span.got).toEqual({
      to: REDACTED,
      text: REDACTED,
      body: REDACTED,
      target: REDACTED,
      spaced: REDACTED,
      dashed: REDACTED,
      detail: REDACTED,
      parts: 2,
      hasPhoto: true,
      missing: null,
      kind: "text",
      optionIds: ["A7-03/2", REDACTED, REDACTED],
    });
    expect(span.decided).toEqual({ reply: REDACTED, fromNumber: REDACTED, sent: 1 });
    const line = JSON.stringify(span);
    for (const leaked of ["4155550123", "415", "haircut", "3pm", "Sure"]) expect(line).not.toContain(leaked);
  });

  it("redacts a raw number or address given as an id or the handle reference", () => {
    const span = ok(
      buildOutsideCallSpan(
        input({
          handleRef: FAKE_PHONE,
          turnId: "4155550123",
          jobId: "a@example.com",
          eventId: "evt 1",
          businessId: "(415) 555-0123",
          errorCode: "bad request for +14155550123",
        }),
      ),
    );
    expect(span).toMatchObject({
      handle_ref: REDACTED,
      turn_id: REDACTED,
      job_id: REDACTED,
      event_id: REDACTED,
      business_id: REDACTED,
      error_code: REDACTED,
    });
    expect(JSON.stringify(span)).not.toMatch(/4155550123|example\.com/);
  });

  it("never carries a key, under a key's name or in a value", () => {
    const span = ok(
      buildOutsideCallSpan(
        input({
          got: {
            apiKey: "anything",
            authorization: "Bearer abcdef0123456789",
            note: FAKE_KEY,
            webhookSecret: "x",
          },
          decided: { ok: true },
          errorCode: FAKE_KEY,
        }),
      ),
    );
    expect(span.got).toEqual({
      apiKey: REDACTED,
      authorization: REDACTED,
      note: REDACTED,
      webhookSecret: REDACTED,
    });
    expect(span.error_code).toBe(REDACTED);
    expect(JSON.stringify(span)).not.toMatch(/sk_test|Bearer|abcdef0123456789/);
  });

  it("keeps only integers as numbers: a fraction or an object is redacted", () => {
    expect(sanitizeFacts({ count: 3, ratio: 0.5, nested: { a: 1 }, list: [1, "ok"] }, "got")).toEqual({
      count: 3,
      ratio: REDACTED,
      nested: REDACTED,
      list: [REDACTED, "ok"],
    });
  });

  it("omits got and decided when none is given, and rounds the time to whole milliseconds", () => {
    const span = ok(buildOutsideCallSpan(input({ ms: 120.6 })));
    expect(span.ms).toBe(121);
    expect("got" in span).toBe(false);
    expect("decided" in span).toBe(false);
  });

  it("refuses an input that cannot make a valid span, naming the field and never the value", () => {
    const bad =
      (overrides: Record<string, unknown>): (() => unknown) =>
      () =>
        buildOutsideCallSpan(input(overrides));
    expect(bad({ provider: "twilio" })).toThrow(/provider is not one of/);
    expect(bad({ hop: "receive" })).toThrow(/hop is not one of/);
    expect(bad({ outcome: "done" })).toThrow(/outcome is not one of/);
    expect(bad({ attempt: 0 })).toThrow(/attempt must be/);
    expect(bad({ attempt: 1.5 })).toThrow(/attempt must be/);
    expect(bad({ seq: 0 })).toThrow(/seq must be/);
    expect(bad({ call: "send part" })).toThrow(/call must be a label/);
    expect(bad({ call: FAKE_PHONE })).toThrow(/call must be a label/);
    expect(bad({ bundleId: { hash: "abc", build: 1 } })).toThrow(/bundleId.hash/);
    expect(bad({ bundleId: { hash: HASH, build: 0 } })).toThrow(/bundleId.build/);
    expect(bad({ at: new Date("nope") })).toThrow(/at must be/);
    expect(bad({ got: { provider: "linq" } })).toThrow(/got: a fact name/);
    expect(bad({ decided: { Bad_name: 1 } })).toThrow(/decided: a fact name/);
  });

  it("does not put a refused value in the error", () => {
    let message = "";
    try {
      buildOutsideCallSpan(input({ call: FAKE_PHONE }));
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe("call must be a label");
  });
});

describe("spanLogLine", () => {
  const context = { level: "info", environment: "staging", version: "test-sha" } as const;

  it("writes one JSON line with level, msg, trace_id, environment and version beside the span", () => {
    const span = ok(buildOutsideCallSpan(input({ got: { parts: 1 } })));
    const line = spanLogLine(span, context);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      level: "info",
      msg: "span",
      environment: "staging",
      version: "test-sha",
      ...span,
    });
  });

  it("refuses a line that still holds a number, an address or a key, without printing it", () => {
    const span = buildOutsideCallSpan(input());
    for (const value of [FAKE_PHONE, "a.b@example.com", FAKE_KEY]) {
      const tampered = { ...span, got: { slipped: value } } as unknown as OutsideCallSpan;
      let message = "";
      try {
        spanLogLine(tampered, context);
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message).toMatch(/^span line refused: it holds a (phone|email|key)$/);
      expect(message).not.toContain(value);
    }
  });
});
