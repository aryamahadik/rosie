// T-1456, under Node (Vitest project "unit"): the gateway's failure line (./answer.ts logFailure). A LinqWebhookError's
// line names its code, one of the adapter's four labels, beside the error's name, so each 503 the Linq verify answers for
// it says why (D-018's staging record: the receipts answered 503 after each inbound text, their reason not logged); every
// other error's line names its name alone, as before; and no line holds a body word, a number or a chat id, whatever an
// error's message or fields hold. Test values only (rule 9): made-up words and chat ids, whole fiction-range numbers.
import { LinqWebhookError } from "@rosie/adapters/linq/webhook";
import { afterEach, describe, expect, it, vi } from "vitest";

import { logFailure } from "./answer";

const TRACE = "4f1c2b7a-9d3e-4c5f-8a6b-1e2d3c4b5a69";
/** A word of a body, a number in its forms and a chat id, as a webhook could carry them (all made up). */
const BODY_WORD = "Haircut";
const NUMBER = "+15555550150";
const NUMBER_FORMS = [NUMBER, NUMBER.slice(1), NUMBER.slice(2), "555-0150"];
const CHAT_ID = "linq-chat-t1456-roster";
const PRIVATE = [BODY_WORD, ...NUMBER_FORMS, CHAT_ID];

/** The four codes of LinqWebhookError, as the adapter names them (adapters/src/linq/webhook/parse.ts). */
const CODES: readonly LinqWebhookError["code"][] = [
  "badEvent",
  "unsupportedWebhookVersion",
  "unknownService",
  "receiptHandleUnknown",
];

type Line = Record<string, unknown>;

/** Every line written on console.log, each parsed: logFailure writes one JSON line per failure. */
function captureLines(): { lines: () => Line[]; raw: () => string[] } {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const raw = (): string[] => log.mock.calls.map(([line]) => String(line));
  return { raw, lines: () => raw().map((line) => JSON.parse(line) as Line) };
}

/** An Error of `name` with `fields` as own properties, its message holding every private value. */
function errorOf(name: string, fields: Record<string, unknown> = {}): Error {
  const error = Object.assign(new Error(`${BODY_WORD} from ${NUMBER} on ${CHAT_ID}`), fields);
  error.name = name;
  return error;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logFailure (T-1456): a LinqWebhookError's line names its code beside its name; any other error's, its name alone", () => {
  it.each(CODES)("LinqWebhookError %s: one line naming the stage, the error's name and the code", (code) => {
    const capture = captureLines();

    logFailure(TRACE, "verify", new LinqWebhookError(code));

    expect(capture.lines()).toEqual([
      {
        level: "error",
        msg: "gateway_failed",
        trace_id: TRACE,
        stage: "verify",
        error: "LinqWebhookError",
        code,
      },
    ]);
  });

  it("any other error: its name alone, never its message or a field, and no code", () => {
    const capture = captureLines();
    const errors: [string, unknown][] = [
      ["TypeError", new TypeError(`${BODY_WORD} ${NUMBER} ${CHAT_ID}`)],
      ["MissingSecretError", errorOf("MissingSecretError")],
      ["NoDatabaseError", errorOf("NoDatabaseError", { code: "receiptHandleUnknown" })],
      ["DataAccessDatabaseError", errorOf("DataAccessDatabaseError", { code: "40001", chatId: CHAT_ID })],
    ];

    for (const [, error] of errors) logFailure(TRACE, "verify", error);

    expect(capture.lines()).toEqual(
      errors.map(([name]) => ({
        level: "error",
        msg: "gateway_failed",
        trace_id: TRACE,
        stage: "verify",
        error: name,
      })),
    );
  });

  it("an error named LinqWebhookError whose code is none of the four labels: its name alone, the code never written", () => {
    const capture = captureLines();
    const codes: unknown[] = [
      NUMBER,
      CHAT_ID,
      BODY_WORD,
      "",
      "ReceiptHandleUnknown",
      "toString",
      503,
      null,
      undefined,
      {},
    ];

    for (const code of codes) logFailure(TRACE, "verify", errorOf("LinqWebhookError", { code }));

    expect(capture.lines()).toEqual(
      codes.map(() => ({
        level: "error",
        msg: "gateway_failed",
        trace_id: TRACE,
        stage: "verify",
        error: "LinqWebhookError",
      })),
    );
  });

  it("something thrown that is no Error, even one shaped like a LinqWebhookError: unknown, with no code", () => {
    const capture = captureLines();
    const thrown: unknown[] = [
      { name: "LinqWebhookError", code: "receiptHandleUnknown", message: CHAT_ID },
      `${BODY_WORD} ${NUMBER}`,
      null,
    ];

    for (const value of thrown) logFailure(TRACE, "verify", value);

    expect(capture.lines()).toEqual(
      thrown.map(() => ({
        level: "error",
        msg: "gateway_failed",
        trace_id: TRACE,
        stage: "verify",
        error: "unknown",
      })),
    );
  });

  it("no line holds a body word, a number or a chat id, whatever the error carries", () => {
    const capture = captureLines();

    for (const code of CODES) logFailure(TRACE, "verify", new LinqWebhookError(code));
    logFailure(TRACE, "verify", errorOf("LinqWebhookError", { code: CHAT_ID }));
    logFailure(TRACE, "handoff", errorOf("Error", { chatId: CHAT_ID, address: NUMBER }));
    logFailure(TRACE, "chat", `${BODY_WORD} ${NUMBER} ${CHAT_ID}`);

    const raw = capture.raw();
    expect(raw).toHaveLength(CODES.length + 3);
    for (const line of raw) {
      for (const value of PRIVATE) expect(line.includes(value), `a line holds ${value}`).toBe(false);
    }
  });
});
