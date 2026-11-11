// The email door held to the frozen schemas (T-265), run under Node because Ajv cannot run in the Workers runtime: what
// the door hands the email port (K-12 v1 verifyWebhook.request and readReply.request), the event it hands each door (a
// reply, with its sealed words put back, is K-06 v1's event and K-12's replyEvent; a delivery event is K-12's
// receiptEvent) and every span it writes (K-08 v1 span). The door runs as the Worker runs it, with the same doubles as the
// Workers tests: the email double signs and checks each webhook under the test environment's made-up secret.
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import bounced from "../../../../contracts/port-email/fixtures/bounced.json";
import delivered from "../../../../contracts/port-email/fixtures/delivered.json";
import replyFailed from "../../../../contracts/port-email/fixtures/inbound-reply-failed-check.json";
import replyPassed from "../../../../contracts/port-email/fixtures/inbound-reply-passed.json";
import badSignature from "../../../../contracts/port-email/fixtures/verify-bad-signature.json";
import ignoredDelayed from "../../../../contracts/port-email/fixtures/verify-ignored-delivery-delayed.json";
import { readContractJson, schemaErrors } from "../../trace/test-support";
import { present } from "../test-support";
import { handleResendWebhook } from "./resend-webhook";
import {
  captureLog,
  resendRequest,
  signedFixture,
  signedReply,
  unsealed,
  worldAt,
  type VerifyExchange,
  type World,
} from "./test-support";

const ID_BASE = "https://rosie.invalid/contracts/";
const K06 = "inbound-event/inbound-event.v1.schema.json";
const K06_V1_1 = "inbound-event/inbound-event.v1.1.schema.json";
const K12 = "port-email/port-email.v1.schema.json";

/** Every schema file K-06 and K-12 reach. */
const SCHEMA_FILES = [
  "common/formats.v1.schema.json",
  "bundle/bundle.v1.schema.json",
  "model/model.v1.schema.json",
  "message-plan/message-plan.v1.schema.json",
  K06,
  K06_V1_1,
  "outbox-effects/outbox-effects.v1.schema.json",
  K12,
];

let ajv: Ajv2020 | undefined;

/** The schema's problems with `value` against a frozen schema file's root, or one of its definitions; empty when accepted. */
function problems(file: string, definition: string | null, value: unknown): string[] {
  if (ajv === undefined) {
    // The contract check's own settings (contracts/scripts/lib.mjs createAjv).
    const created = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
    for (const schema of SCHEMA_FILES) created.addSchema(readContractJson(schema) as object);
    ajv = created;
  }
  const validate = ajv.getSchema(`${ID_BASE}${file}${definition === null ? "" : `#/$defs/${definition}`}`);
  if (validate === undefined) throw new Error(`${file} has no definition ${definition ?? "(root)"}`);
  if (validate(value)) return [];
  return (validate.errors ?? []).map(
    (error) => `${error.instancePath === "" ? "(root)" : error.instancePath} ${error.message ?? ""}`,
  );
}

const WHERE = { environment: "staging", version: "test-sha" };

/** What the door handed the port was K-12's, whatever the answer. */
function expectPortRequestsOfK12(world: World): void {
  expect(world.port.verified.length).toBeGreaterThan(0);
  for (const request of world.port.verified) {
    expect(problems(K12, "verifyWebhook.request", request)).toEqual([]);
  }
  for (const request of world.port.reads) expect(problems(K12, "readReply.request", request)).toEqual([]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the email door against the frozen schemas", () => {
  it.each([
    ["inbound-reply-passed", replyPassed],
    ["inbound-reply-failed-check", replyFailed],
  ])(
    "%s: the requests are K-12's, the event the actor rebuilds is K-06's and K-12's replyEvent, each span is K-08's",
    async (_name, exchange) => {
      const log = captureLog();
      const world = worldAt(exchange.given.now);

      const response = await handleResendWebhook(
        resendRequest(await signedReply(world.double, exchange.outcome.event)),
        world.deps,
        WHERE,
      );

      expect(response.status).toBe(200);
      expectPortRequestsOfK12(world);
      expect(world.port.reads).toHaveLength(1);
      const event = await unsealed(present(world.actor.written[0], "the hand-off"), world.keys);
      expect(problems(K06, null, event)).toEqual([]);
      expect(problems(K06_V1_1, null, event)).toEqual([]);
      expect(problems(K12, "replyEvent", event)).toEqual([]);
      const spans = log.spans();
      expect(spans.map((span) => span.hop)).toEqual(["receive", "portCall", "scrub"]);
      for (const span of spans) expect(schemaErrors("span", span)).toEqual([]);
    },
  );

  it.each<[string, VerifyExchange & { outcome: { rfcMessageId: string | null } }]>([
    ["delivered", delivered],
    ["bounced", bounced],
  ])(
    "%s: the request is K-12's, the event the receipt door gets is K-06's and K-12's receiptEvent, the span is K-08's",
    async (_name, exchange) => {
      const log = captureLog();
      const world = worldAt(exchange.given.now);

      const response = await handleResendWebhook(
        resendRequest(await signedFixture(world.double, exchange)),
        world.deps,
        WHERE,
      );

      expect(response.status).toBe(200);
      expectPortRequestsOfK12(world);
      const handoff = present(world.receipts.written[0], "the hand-off");
      expect(problems(K06, null, handoff.event)).toEqual([]);
      expect(problems(K12, "receiptEvent", handoff.event)).toEqual([]);
      // What the port answered, as the door handed it on: K-12's own response, the Message-ID beside the event.
      expect(
        problems(K12, "verifyWebhook.response", {
          result: "event",
          httpStatus: 200,
          event: handoff.event,
          rfcMessageId: handoff.rfcMessageId,
        }),
      ).toEqual([]);
      expect(handoff.rfcMessageId).toBe(exchange.outcome.rfcMessageId);
      const spans = log.spans();
      expect(spans.map((span) => span.hop)).toEqual(["receive"]);
      for (const span of spans) expect(schemaErrors("span", span)).toEqual([]);
    },
  );

  it("its refusals, drops and failures write spans K-08 accepts", async () => {
    const log = captureLog();
    const answers: number[] = [];
    const send = async (world: World, exchange: VerifyExchange): Promise<void> => {
      const webhook = resendRequest(await signedFixture(world.double, exchange));
      answers.push((await handleResendWebhook(webhook, world.deps, WHERE)).status);
      expectPortRequestsOfK12(world);
    };

    await send(worldAt(badSignature.given.now), badSignature);
    await send(worldAt(ignoredDelayed.given.now), ignoredDelayed);
    const transient = worldAt(replyPassed.given.now);
    const reply = await signedReply(transient.double, replyPassed.outcome.event);
    transient.double.failNextRead({ kind: "transient" });
    answers.push((await handleResendWebhook(resendRequest(reply), transient.deps, WHERE)).status);
    transient.double.failNextRead({ kind: "unreadable" });
    answers.push((await handleResendWebhook(resendRequest(reply), transient.deps, WHERE)).status);
    expectPortRequestsOfK12(transient);

    expect(answers).toEqual([401, 200, 503, 200]);
    const spans = log.spans();
    expect(spans.map((span) => [span.hop, span.outcome])).toEqual([
      ["receive", "refused"],
      ["receive", "dropped"],
      ["receive", "failed"],
      ["portCall", "failed"],
      ["receive", "dropped"],
      ["portCall", "dropped"],
    ]);
    for (const span of spans) expect(schemaErrors("span", span)).toEqual([]);
  });
});
