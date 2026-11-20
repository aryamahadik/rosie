// T-1456, under Node (Vitest project "unit"): the gateway's failure line (./answer.ts logFailure). A LinqWebhookError's
// line names its code, one of the adapter's four labels, beside the error's name, so each 503 the Linq verify answers for
// it says why (D-018's staging record: the receipts answered 503 after each inbound text, their reason not logged); every
// other error's line names its name alone, as before; and no line holds a body word, a number or a chat id, whatever an
// error's message or fields hold. Test values only (rule 9): made-up words and chat ids, whole fiction-range numbers.
//
// T-1465 (DL-978, DL-997): the hand-off's failure line. Handed the event's kind, the line gains two fields: `kind`, the
// K-06 kind when it is one the gateway routes (./hand-off.ts ACTOR_KINDS and RECEIPT_KINDS) and "unknown" for anything
// else; and `refusal`, the label a door's refusal carries (a WiringError's code, one of HANDOFF_REFUSALS) and "unlabeled"
// for every other error, so the next tail shows which kind failed and why. Neither is ever a field value: a kind or a
// code that is no label of its closed list is never written. A line of any other stage is as it was.
import { LinqWebhookError } from "@rosie/adapters/linq/webhook";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HANDOFF_REFUSALS, logFailure, type HandoffRefusal } from "./answer";
import { ACTOR_KINDS, RECEIPT_KINDS } from "./hand-off";

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

/** The door's refusal labels, as the gateway lists them (./answer.ts HANDOFF_REFUSALS): the closed list, written out. */
const REFUSALS: readonly HandoffRefusal[] = [
  "failedReceiptNoDoor",
  "smsSentReceiptNoDoor",
  "receiptKindNoDoor",
  "deliveredReceiptNoStatus",
  "outboxStoreNoAnswer",
];

/** Every K-06 kind the gateway hands on (./hand-off.ts): the actor's six and the receipt door's three. */
const KINDS: readonly string[] = [...ACTOR_KINDS, ...RECEIPT_KINDS];

describe("logFailure (T-1465): the hand-off's line names the event's kind and the door's refusal label, each from a closed list", () => {
  it("the closed list of refusal labels is these five, and the kinds are K-06's nine", () => {
    expect(Object.keys(HANDOFF_REFUSALS).sort()).toEqual([...REFUSALS].sort());
    expect([...KINDS].sort()).toEqual(
      ["delivered", "edit", "failed", "photo", "pollVote", "reaction", "sent", "text", "voteRemoved"].sort(),
    );
  });

  it.each(REFUSALS)(
    "a WiringError carrying %s: the line holds the stage, the error's name, the kind and that label, and nothing else",
    (refusal) => {
      const capture = captureLines();

      for (const kind of KINDS)
        logFailure(TRACE, "handoff", errorOf("WiringError", { code: refusal }), { kind });

      expect(capture.lines()).toEqual(
        KINDS.map((kind) => ({
          level: "error",
          msg: "gateway_failed",
          trace_id: TRACE,
          stage: "handoff",
          error: "WiringError",
          kind,
          refusal,
        })),
      );
    },
  );

  it("an error that carries no label of the list is unlabeled: a WiringError with no code or another code, and any other error whatever its code", () => {
    const capture = captureLines();
    const errors: [string, unknown][] = [
      ["WiringError", errorOf("WiringError")],
      ["WiringError", errorOf("WiringError", { code: CHAT_ID })],
      ["WiringError", errorOf("WiringError", { code: NUMBER })],
      ["WiringError", errorOf("WiringError", { code: "FailedReceiptNoDoor" })],
      ["WiringError", errorOf("WiringError", { code: "toString" })],
      ["WiringError", errorOf("WiringError", { code: "unlabeled" })],
      ["WiringError", errorOf("WiringError", { code: 503 })],
      ["WiringError", errorOf("WiringError", { code: null })],
      ["ArmingNotDone", errorOf("ArmingNotDone")],
      ["ArmingNotDone", errorOf("ArmingNotDone", { code: "failedReceiptNoDoor" })],
      ["DataAccessDatabaseError", errorOf("DataAccessDatabaseError", { code: "40001", chatId: CHAT_ID })],
      ["Error", new Error(`${BODY_WORD} ${NUMBER} ${CHAT_ID}`)],
      ["unknown", { name: "WiringError", code: "failedReceiptNoDoor", message: CHAT_ID }],
      ["unknown", `${BODY_WORD} ${NUMBER}`],
      ["unknown", null],
    ];

    for (const [, error] of errors) logFailure(TRACE, "handoff", error, { kind: "delivered" });

    expect(capture.lines()).toEqual(
      errors.map(([name]) => ({
        level: "error",
        msg: "gateway_failed",
        trace_id: TRACE,
        stage: "handoff",
        error: name,
        kind: "delivered",
        refusal: "unlabeled",
      })),
    );
  });

  it("a kind that is none of K-06's nine is written as unknown, never as it came", () => {
    const capture = captureLines();
    const kinds: unknown[] = [
      CHAT_ID,
      NUMBER,
      BODY_WORD,
      "",
      "Delivered",
      "toString",
      "constructor",
      "read",
      503,
      null,
      undefined,
      {},
    ];

    for (const kind of kinds) {
      logFailure(TRACE, "handoff", errorOf("WiringError", { code: "failedReceiptNoDoor" }), {
        kind: kind as string,
      });
    }

    expect(capture.lines()).toEqual(
      kinds.map(() => ({
        level: "error",
        msg: "gateway_failed",
        trace_id: TRACE,
        stage: "handoff",
        error: "WiringError",
        kind: "unknown",
        refusal: "failedReceiptNoDoor",
      })),
    );
  });

  it("a line with no kind handed is as it was: no kind and no refusal, even for a WiringError carrying a label", () => {
    const capture = captureLines();

    logFailure(TRACE, "handoff", errorOf("WiringError", { code: "failedReceiptNoDoor" }));
    logFailure(TRACE, "chat", errorOf("WiringError", { code: "outboxStoreNoAnswer" }));

    expect(capture.lines()).toEqual([
      { level: "error", msg: "gateway_failed", trace_id: TRACE, stage: "handoff", error: "WiringError" },
      { level: "error", msg: "gateway_failed", trace_id: TRACE, stage: "chat", error: "WiringError" },
    ]);
  });

  it("a LinqWebhookError at the hand-off keeps its code beside the two new fields", () => {
    const capture = captureLines();

    logFailure(TRACE, "handoff", new LinqWebhookError("badEvent"), { kind: "sent" });

    expect(capture.lines()).toEqual([
      {
        level: "error",
        msg: "gateway_failed",
        trace_id: TRACE,
        stage: "handoff",
        error: "LinqWebhookError",
        code: "badEvent",
        kind: "sent",
        refusal: "unlabeled",
      },
    ]);
  });

  it("no hand-off line holds a body word, a number or a chat id, whatever the error and the kind carry", () => {
    const capture = captureLines();

    for (const refusal of REFUSALS) {
      logFailure(TRACE, "handoff", errorOf("WiringError", { code: refusal, chatId: CHAT_ID }), {
        kind: "failed",
      });
    }
    logFailure(TRACE, "handoff", errorOf("WiringError", { code: CHAT_ID, address: NUMBER }), {
      kind: CHAT_ID,
    });
    logFailure(TRACE, "handoff", errorOf("Error", { code: NUMBER }), { kind: NUMBER });
    logFailure(TRACE, "handoff", `${BODY_WORD} ${NUMBER} ${CHAT_ID}`, { kind: BODY_WORD });

    const raw = capture.raw();
    expect(raw).toHaveLength(REFUSALS.length + 3);
    for (const line of raw) {
      for (const value of PRIVATE) expect(line.includes(value), `a line holds ${value}`).toBe(false);
    }
  });
});
