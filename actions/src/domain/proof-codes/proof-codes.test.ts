// The proof-code calls (T-322; C-095), each run through the Tool API base (T-290), so every request and answer is held
// to K-09 v1.5's schema and every span is the one the base records. The store is test-support's double of K-22 v1;
// the hashing port is the real HMAC-SHA-256 over a fixed test pattern. The card's "Proves it with":
//   - proof-code-email.json and proof-code-text-from-mobile.json give their results;
//   - a code checked at 10 minutes 1 second fails;
//   - the 5th wrong try starts a 15-minute pause in which a right code fails;
//   - no text outbox row is ever built to a mobile with no open chat (MC C9);
//   - codes are stored hashed and never appear in a span (K-08);
// the draw and the token are draw.test.ts's.

import { describe, expect, it } from "vitest";

import type { EventEntry } from "../../commit";
import {
  createToolApiValidator,
  notBuiltHandlers,
  type CallAnswer,
  type CallName,
  type Handlers,
  type RequestOf,
} from "../../tool-api";
import {
  fixture,
  recordingScope,
  stringsIn,
  traceFor,
  type RecordingRepo,
} from "../../tool-api/test-support";
import { createToolApi } from "../../tool-api/tool-api";
import { EVENT_TRACE_SCHEMA_ID, definitionChecks } from "../../tool-api/validator";
import { proveCodeHandler, sendProofCodeHandler, type ProofCodeDeps } from "./handlers";
import { codeAsHashed, codeHashOf, hmacSha256Hash, ProofCodeHashError } from "./hashing";
import type { CodeSend } from "./ports";
import { CODE_LIFE_MINUTES, PAUSE_MINUTES, STORED_PURPOSE, WRONG_TRIES_TO_PAUSE } from "./rules";
import {
  JORDAN_MOBILE,
  K22Double,
  SAM_EMAIL,
  SAM_MOBILE,
  TEST_KEY_BYTES,
  TEST_KEY_NAME,
  drawFor,
  fixedIds,
  nodeCodeHash,
  readerOver,
  scriptedFill,
  testHash,
  type HandleOnFile,
} from "./test-support";

const validator = createToolApiValidator();
const checks = definitionChecks();
const MESSAGE_PLAN = "https://rosie.invalid/contracts/message-plan/message-plan.v1.schema.json";
const DATA_ACCESS = "https://rosie.invalid/contracts/data-access/data-access.v1.schema.json";

type SendRequest = RequestOf<"sendProofCode">;
type CheckRequest = RequestOf<"proveCode">;

interface Exchange<R> {
  readonly given: { readonly now: string };
  readonly request: R;
  readonly outcome: unknown;
}

const EMAIL_FIXTURE = fixture("proof-code-email.json") as Exchange<SendRequest>;
const TEXT_FIXTURE = fixture("proof-code-text-from-mobile.json") as Exchange<SendRequest>;

/** The sample cast's sign-in code (S11-52's 482913, K-22 README line 131). */
const CODE = "482913";
const T0 = EMAIL_FIXTURE.given.now;

const plus = (utc: string, minutes: number, seconds = 0): string =>
  new Date(Date.parse(utc) + minutes * 60_000 + seconds * 1000).toISOString().replace(/\.000Z$/u, "Z");

/** One world: K-22's double, Sam's and Jordan's handles, the test key and a scripted draw. */
interface World {
  readonly k22: K22Double;
  deps(now: string, draws?: readonly number[]): Promise<ProofCodeDeps<RecordingRepo>>;
}

function world(handles: readonly HandleOnFile[] = [SAM_EMAIL, SAM_MOBILE, JORDAN_MOBILE]): World {
  const k22 = new K22Double();
  return {
    k22,
    async deps(now, draws = [drawFor(CODE)]) {
      return {
        store: () => k22,
        reader: () => readerOver(handles),
        hash: await testHash(),
        random: scriptedFill(draws).fill,
        ids: fixedIds("proof-sam-signin-1", "out-sam-signin-code"),
        now: () => now,
      };
    },
  };
}

interface Ran {
  readonly answer: CallAnswer;
  readonly spans: unknown[];
}

/** One call through the Tool API base, with the proof-code handlers over `deps` and every other call a stub. */
async function run(call: CallName, request: unknown, deps: ProofCodeDeps<RecordingRepo>): Promise<Ran> {
  const { trace, spans } = traceFor(request);
  const handlers: Handlers<RecordingRepo> = {
    ...notBuiltHandlers(),
    sendProofCode: sendProofCodeHandler(deps),
    proveCode: proveCodeHandler(deps),
  };
  const api = createToolApi({ validator, scope: recordingScope(), handlers });
  const answer = await api.call(call, request, trace);
  return { answer, spans };
}

/** A sign-in's check on the page (K-21 signInCheck's K-09 call), keyed by its own request id. */
function checkRequest(
  requestId: string,
  typed: string,
  at: string,
  fromHandleId: string | null = null,
): CheckRequest {
  return {
    caller: {
      kind: "page",
      turnId: null,
      requestId,
      businessId: "biz-lees-barbershop",
      personId: null,
      traceId: "trace-page-sam-0201",
    },
    proofCodeId: "proof-sam-signin-1",
    typed,
    fromHandleId,
    at,
  };
}

/** Sends the email fixture's code (482913 unless told) at T0 into a fresh world. */
async function sentCode(draws?: readonly number[]): Promise<World> {
  const made = world();
  const { answer } = await run("sendProofCode", EMAIL_FIXTURE.request, await made.deps(T0, draws));
  expect(answer).toEqual(EMAIL_FIXTURE.outcome);
  return made;
}

function onlySend(k22: K22Double): CodeSend {
  expect(k22.sends).toHaveLength(1);
  const [send] = k22.sends;
  if (send === undefined) throw new Error("no send written");
  return send;
}

/** An entry as it lands in K-04's event_log (K-08 v1.1 eventLogRow), for a call with no turn. */
function logRowOf(entry: EventEntry, at: string, jobId: string, traceId: string): Record<string, unknown> {
  return {
    id: entry.id,
    at,
    zone: entry.zone,
    turn_id: null,
    job_id: jobId,
    trace_id: traceId,
    bundle_hash: null,
    bundle_build: null,
    business_id: entry.businessId,
    actor_kind: entry.actorKind,
    actor_person_id: entry.actorPersonId,
    actor_role: entry.actorRole,
    kind: entry.kind,
    table_name: entry.tableName,
    row_id: entry.rowId,
    old_values: entry.oldValues,
    new_values: entry.newValues,
    why: entry.why,
  };
}

function expectValid(schemaId: string, definition: string, value: unknown): void {
  const validate = checks(schemaId, definition);
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

// ---------------------------------------------------------------------------------------------------------------------

describe("sendProofCode gives K-09 v1's results", () => {
  it("proof-code-email.json: a sign-in code to the email on file, as one email row with its words", async () => {
    const made = world();
    const deps = await made.deps(EMAIL_FIXTURE.given.now, [drawFor("000000")]);
    const { answer } = await run("sendProofCode", EMAIL_FIXTURE.request, deps);
    expect(answer).toEqual(EMAIL_FIXTURE.outcome);

    const send = onlySend(made.k22);
    expect(send.key).toBe("req-portal-sam-signin-1");
    expect(send.code).toEqual({
      id: "proof-sam-signin-1",
      purpose: "sign_in",
      person_id: "person-sam",
      business_id: null,
      sent_to_handle_id: "handle-sam-email",
      channel: "email",
      code_hash: nodeCodeHash("000000"),
      hash_key_name: TEST_KEY_NAME,
      sent_at: "2026-10-26T13:00:00Z",
      expires_at: "2026-10-26T13:10:00Z",
    });
    expect(send.email?.row).toEqual({
      id: "out-sam-signin-code",
      recipientHandleId: "handle-sam-email",
      recipientPersonId: "person-sam",
      businessId: null,
      bookingId: null,
      channel: "email",
      sendClass: "quick_reply",
      openQuestionId: null,
      copyOfRowId: null,
      versionsRead: [],
      emailPurpose: "code",
      notAfter: "2026-10-26T13:10:00Z",
    });
    expect(send.email?.finalParts.sends).toEqual([
      {
        kind: "words",
        text: "Code 000000: type it on the sign-in page. It works for 10 minutes.",
        calendarFile: "none",
        options: [],
        link: null,
      },
    ]);
    expectValid(MESSAGE_PLAN, "rowPlan", send.email?.plan);
    expectValid(MESSAGE_PLAN, "finalParts", send.email?.finalParts);
    expect(send.events.map((each) => [each.id, each.kind])).toEqual([
      ["log-out-sam-signin-code-created", "outbox_row.created"],
      ["log-out-sam-signin-code-planned", "outbox_row.planned"],
      ["log-proof-sam-signin-1-sent", "proof_code.sent"],
    ]);
  });

  it("proof-code-text-from-mobile.json: a ready text to send from that mobile, and no outbox row", async () => {
    const made = world();
    const deps = await made.deps(TEXT_FIXTURE.given.now, [drawFor("000000")]);
    const { answer } = await run("sendProofCode", TEXT_FIXTURE.request, {
      ...deps,
      ids: fixedIds("proof-sam-signin-2", "out-never-written"),
    });
    expect(answer).toEqual(TEXT_FIXTURE.outcome);

    const send = onlySend(made.k22);
    expect(send.email).toBeNull();
    expect(send.code).toMatchObject({
      id: "proof-sam-signin-2",
      purpose: "sign_in",
      sent_to_handle_id: "handle-sam",
      channel: "text",
      expires_at: "2026-10-27T13:10:00Z",
    });
    expect(send.events.map((each) => each.kind)).toEqual(["proof_code.sent"]);
    expect(send.events[0]?.newValues).toEqual({
      person_id: "person-sam",
      purpose: "signIn",
      route: "textFromMobile",
      contact_handle_id: "handle-sam",
      expires_at: "2026-10-27T13:10:00Z",
      wrong_tries: 0,
    });
  });

  it("answers a repeated request id with the first code row, and writes no second code", async () => {
    const made = await sentCode();
    const again = await run("sendProofCode", EMAIL_FIXTURE.request, await made.deps(plus(T0, 1), [7]));
    expect(again.answer).toEqual({ ...(EMAIL_FIXTURE.outcome as object), repeated: true });
    expect(made.k22.sends).toHaveLength(1);
  });
});

describe("a code lives 10 minutes", () => {
  it("is proven by its right code at 10 minutes", async () => {
    const made = await sentCode();
    const { answer } = await run(
      "proveCode",
      checkRequest("req-check-1", CODE, plus(T0, CODE_LIFE_MINUTES)),
      await made.deps(T0),
    );
    expect(answer).toEqual({
      result: "proven",
      handleId: "handle-sam-email",
      controlBusinessId: null,
      redecideTurnId: null,
      repeated: false,
    });
    expect(made.k22.rows.get("proof-sam-signin-1")?.usedAt).toBe(plus(T0, 10));
  });

  it("fails when checked at 10 minutes 1 second, its right code included, before any try is made", async () => {
    const made = await sentCode();
    const { answer } = await run(
      "proveCode",
      checkRequest("req-check-1", CODE, plus(T0, 10, 1)),
      await made.deps(T0),
    );
    expect(answer).toEqual({ result: "expired", repeated: false });
    expect(made.k22.checkCalls).toBe(0);
    expect(made.k22.rows.get("proof-sam-signin-1")).toMatchObject({ usedAt: null, wrongTries: 0 });
  });
});

describe("5 wrong tries give a 15-minute pause", () => {
  it("starts the pause at the 5th wrong try, and a right code fails in it", async () => {
    const made = await sentCode();
    const deps = await made.deps(T0);
    const answers: CallAnswer[] = [];
    for (let index = 1; index <= WRONG_TRIES_TO_PAUSE; index += 1) {
      const at = plus(T0, 1, index * 10);
      answers.push(
        (await run("proveCode", checkRequest(`req-wrong-${String(index)}`, "000001", at), deps)).answer,
      );
    }
    const fifth = plus(T0, 1, 50);
    const pauseEnd = plus(fifth, PAUSE_MINUTES);
    expect(answers).toEqual([
      { result: "wrong", triesLeft: 4, repeated: false },
      { result: "wrong", triesLeft: 3, repeated: false },
      { result: "wrong", triesLeft: 2, repeated: false },
      { result: "wrong", triesLeft: 1, repeated: false },
      { result: "paused", until: pauseEnd, repeated: false },
    ]);
    expect(pauseEnd).toBe("2026-10-26T13:16:50Z");
    expect(made.k22.checkCalls).toBe(5);
    expect(made.k22.rows.get("proof-sam-signin-1")).toMatchObject({ wrongTries: 5, pausedUntil: pauseEnd });
    expect(made.k22.checkEvents.map((each) => each.newValues)).toEqual([
      { wrong_tries: 1 },
      { wrong_tries: 2 },
      { wrong_tries: 3 },
      { wrong_tries: 4 },
      { wrong_tries: 5, paused_until: pauseEnd },
    ]);

    // Inside the code's 10 minutes and inside the pause: the right code fails, and no try is made.
    const right = await run("proveCode", checkRequest("req-right-1", CODE, plus(T0, 2)), deps);
    expect(right.answer).toEqual({ result: "paused", until: pauseEnd, repeated: false });
    // A second before the pause ends, still paused; at its end the code is dead (its 10 minutes ended first).
    const late = await run("proveCode", checkRequest("req-right-2", CODE, plus(pauseEnd, 0, -1)), deps);
    expect(late.answer).toEqual({ result: "paused", until: pauseEnd, repeated: false });
    const after = await run("proveCode", checkRequest("req-right-3", CODE, pauseEnd), deps);
    expect(after.answer).toEqual({ result: "expired", repeated: false });
    expect(made.k22.checkCalls).toBe(5);
    expect(made.k22.rows.get("proof-sam-signin-1")?.usedAt).toBeNull();

    // A new code to that contact in the pause answers paused, and nothing is written.
    const resend = await run(
      "sendProofCode",
      {
        ...EMAIL_FIXTURE.request,
        caller: { ...EMAIL_FIXTURE.request.caller, requestId: "req-portal-sam-signin-9" },
      },
      await made.deps(plus(T0, 3)),
    );
    expect(resend.answer).toEqual({ error: "paused", until: pauseEnd });
    expect(made.k22.sends).toHaveLength(1);
  });

  it("answers a repeated check with its first result and counts no second try", async () => {
    const made = await sentCode();
    const deps = await made.deps(T0);
    const request = checkRequest("req-wrong-1", "000001", plus(T0, 1));
    expect((await run("proveCode", request, deps)).answer).toEqual({
      result: "wrong",
      triesLeft: 4,
      repeated: false,
    });
    expect((await run("proveCode", request, deps)).answer).toEqual({
      result: "wrong",
      triesLeft: 4,
      repeated: true,
    });
    expect(made.k22.rows.get("proof-sam-signin-1")?.wrongTries).toBe(1);
  });
});

describe("no text outbox row to a mobile with no open chat (MC C9)", () => {
  it("asks the person to text the code from that mobile, never texting it first", async () => {
    const made = world();
    const { answer } = await run(
      "sendProofCode",
      TEXT_FIXTURE.request,
      await made.deps(TEXT_FIXTURE.given.now),
    );
    expect(answer).toMatchObject({ outboxRowId: null, readyText: `My Rosie sign-in code is ${CODE}` });
    expect(SAM_MOBILE.chatOpen).toBe(false);
    expect(onlySend(made.k22).email).toBeNull();
  });

  it("refuses an email route to a mobile, writing nothing", async () => {
    const made = world();
    const request: SendRequest = { ...EMAIL_FIXTURE.request, contactHandleId: SAM_MOBILE.id };
    const { answer } = await run("sendProofCode", request, await made.deps(T0));
    expect(answer).toEqual({ error: "noContactOnFile" });
    expect(made.k22.sends).toHaveLength(0);
  });

  it("builds an outbox row for no purpose, route or contact but an email to an email address", async () => {
    const purposes = Object.keys(STORED_PURPOSE) as SendRequest["purpose"][];
    const routes: SendRequest["route"][] = ["emailOnFile", "textFromMobile", "listingEmail", "typedEmail"];
    const contacts: (HandleOnFile | null)[] = [SAM_EMAIL, SAM_MOBILE, JORDAN_MOBILE, null];
    const sends: CodeSend[] = [];
    let index = 0;
    // Sam's mobile with its chat not open, and again with it open; Jordan's mobile has never texted in.
    for (const chatOpen of [false, true]) {
      for (const purpose of purposes) {
        for (const route of routes) {
          for (const contact of contacts) {
            index += 1;
            const made = world([SAM_EMAIL, { ...SAM_MOBILE, chatOpen }, JORDAN_MOBILE]);
            const request = {
              caller: {
                ...EMAIL_FIXTURE.request.caller,
                requestId: `req-c9-${String(index)}`,
                personId: purpose === "signIn" || purpose === "emailCheck" ? null : "person-sam",
              },
              purpose,
              route,
              contactHandleId: contact === null ? null : contact.id,
              typedEmail: route === "typedEmail" ? "sam@example.com" : null,
              forPersonId: purpose === "control" ? null : (contact?.personId ?? "person-sam"),
            };
            await run("sendProofCode", request, await made.deps(T0));
            sends.push(...made.k22.sends);
          }
        }
      }
    }
    const rows = sends.flatMap((send) => (send.email === null ? [] : [send.email.row]));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.channel).toBe("email");
      expect(row.recipientHandleId).toBe(SAM_EMAIL.id);
    }
    const texted = sends.filter((each) => each.code.channel === "text");
    expect(texted.map((each) => each.code.sent_to_handle_id).sort()).toEqual([
      JORDAN_MOBILE.id,
      JORDAN_MOBILE.id,
      SAM_MOBILE.id,
      SAM_MOBILE.id,
    ]);
    for (const send of texted) expect(send.email).toBeNull();
  });

  it("sends no code to a contact that is not the person's own", async () => {
    const made = world();
    const request: SendRequest = { ...TEXT_FIXTURE.request, contactHandleId: JORDAN_MOBILE.id };
    const { answer } = await run("sendProofCode", request, await made.deps(T0));
    expect(answer).toEqual({ error: "noContactOnFile" });
    expect(made.k22.sends).toHaveLength(0);
  });

  it("proves a texted code only from the mobile it went to", async () => {
    const made = world();
    await run("sendProofCode", TEXT_FIXTURE.request, await made.deps(TEXT_FIXTURE.given.now));
    const deps = await made.deps(TEXT_FIXTURE.given.now);
    const at = plus(TEXT_FIXTURE.given.now, 1);
    const elsewhere = await run("proveCode", checkRequest("evt-other-1", CODE, at, JORDAN_MOBILE.id), deps);
    expect(elsewhere.answer).toEqual({
      error: "notFound",
      table: "proof_codes",
      rowId: "proof-sam-signin-1",
    });
    expect(made.k22.checkCalls).toBe(0);
    const own = await run("proveCode", checkRequest("evt-own-1", CODE, at, SAM_MOBILE.id), deps);
    expect(own.answer).toMatchObject({ result: "proven", handleId: SAM_MOBILE.id });
  });
});

describe("codes are stored hashed and never in a span or an entry (K-08)", () => {
  it("keeps only the code's keyed hash, and the code only in the email row's words", async () => {
    const made = world();
    const { answer, spans } = await run("sendProofCode", EMAIL_FIXTURE.request, await made.deps(T0));
    const send = onlySend(made.k22);
    const hash = nodeCodeHash(CODE);
    expect(send.code.code_hash).toBe(hash);
    expect(send.code.code_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(send.code.hash_key_name).toBe("PROOF_CODE_HASH_KEY");

    const holdsCode = (value: unknown): boolean => stringsIn(value).some((text) => text.includes(CODE));
    const holdsHash = (value: unknown): boolean => stringsIn(value).some((text) => text.includes(hash));
    expect(holdsCode(send.code)).toBe(false);
    expect(holdsCode(send.events)).toBe(false);
    expect(holdsHash(send.events)).toBe(false);
    expect(holdsCode(send.email?.row)).toBe(false);
    expect(holdsCode(send.email?.plan)).toBe(false);
    expect(holdsCode(send.email?.finalParts)).toBe(true);
    expect(holdsCode(answer)).toBe(false);

    expect(spans.length).toBeGreaterThan(0);
    expect(holdsCode(spans)).toBe(false);
    expect(holdsHash(spans)).toBe(false);
    for (const span of spans) expect(validator.checkSpan(span)).toEqual([]);

    for (const entry of send.events) {
      expectValid(DATA_ACCESS, "eventEntry", entry);
      expectValid(EVENT_TRACE_SCHEMA_ID, "eventLogRow", logRowOf(entry, T0, send.key, send.traceId));
    }
  });

  it("puts neither the ready text's code nor its hash in a span or an entry", async () => {
    const made = world();
    const { answer, spans } = await run("sendProofCode", TEXT_FIXTURE.request, await made.deps(T0));
    expect(answer).toMatchObject({ readyText: `My Rosie sign-in code is ${CODE}` });
    const send = onlySend(made.k22);
    for (const secret of [CODE, nodeCodeHash(CODE)]) {
      expect(stringsIn(spans).some((text) => text.includes(secret))).toBe(false);
      expect(stringsIn(send.events).some((text) => text.includes(secret))).toBe(false);
    }
  });

  it("checks a typed code by its keyed hash, with neither in a span or an entry", async () => {
    const made = await sentCode();
    const deps = await made.deps(T0);
    const wrong = await run("proveCode", checkRequest("req-wrong-1", "000001", plus(T0, 1)), deps);
    const right = await run("proveCode", checkRequest("req-right-1", "482 913", plus(T0, 2)), deps);
    expect(right.answer).toMatchObject({ result: "proven" });
    const secrets = [CODE, "000001", nodeCodeHash(CODE), nodeCodeHash("000001")];
    for (const secret of secrets) {
      expect(stringsIn([wrong.spans, right.spans]).some((text) => text.includes(secret))).toBe(false);
      expect(stringsIn(made.k22.checkEvents).some((text) => text.includes(secret))).toBe(false);
    }
    expect(made.k22.checkEvents.map((each) => [each.kind, each.newValues])).toEqual([
      ["proof_code.checked", { wrong_tries: 1 }],
      ["proof_code.checked", { proven_at: plus(T0, 2) }],
    ]);
    for (const entry of made.k22.checkEvents) {
      expectValid(
        EVENT_TRACE_SCHEMA_ID,
        "eventLogRow",
        logRowOf(entry, T0, "req-check", "trace-page-sam-0201"),
      );
    }
  });

  it("hashes through the root's port: HMAC-SHA-256 under the key, the code's own prefix, white space out", async () => {
    const hash = await hmacSha256Hash(TEST_KEY_NAME, TEST_KEY_BYTES);
    expect(await codeHashOf(hash, CODE)).toBe(nodeCodeHash(CODE));
    expect(await codeHashOf(hash, " 482 913 ")).toBe(nodeCodeHash(CODE));
    expect(codeAsHashed("482\t913")).toBe(CODE);
    expect(await codeHashOf(hash, "482-913")).not.toBe(nodeCodeHash(CODE));
    const other = await hmacSha256Hash(
      TEST_KEY_NAME,
      TEST_KEY_BYTES.map((byte) => byte ^ 0xff),
    );
    expect(await codeHashOf(other, CODE)).not.toBe(nodeCodeHash(CODE));
    await expect(hmacSha256Hash(TEST_KEY_NAME, new Uint8Array(31))).rejects.toThrow(ProofCodeHashError);
    await expect(hmacSha256Hash("proof_code_hash_key", TEST_KEY_BYTES)).rejects.toThrow(ProofCodeHashError);
    const broken = { keyName: TEST_KEY_NAME, hmacHex: () => Promise.resolve(CODE) };
    await expect(codeHashOf(broken, CODE)).rejects.toThrow(ProofCodeHashError);
  });
});

describe("until their ports are bound", () => {
  it("answers notBuilt for both calls and writes nothing", async () => {
    const send = await run("sendProofCode", EMAIL_FIXTURE.request, {});
    expect(send.answer).toEqual({ error: "notBuilt", call: "sendProofCode" });
    const check = await run("proveCode", checkRequest("req-check-1", CODE, plus(T0, 1)), {});
    expect(check.answer).toEqual({ error: "notBuilt", call: "proveCode" });
  });

  it("answers notBuilt for a purpose the sources give no words for, and for a turn's call", async () => {
    const made = world();
    const deps = await made.deps(T0);
    const newContact: SendRequest = {
      ...EMAIL_FIXTURE.request,
      caller: { ...EMAIL_FIXTURE.request.caller, personId: "person-sam" },
      purpose: "newContact",
    };
    expect((await run("sendProofCode", newContact, deps)).answer).toEqual({
      error: "notBuilt",
      call: "sendProofCode",
    });
    const inTurn: SendRequest = {
      ...EMAIL_FIXTURE.request,
      caller: {
        ...EMAIL_FIXTURE.request.caller,
        kind: "turn",
        turnId: "turn-sam-0001",
        requestId: "turn-sam-0001",
      },
    };
    expect((await run("sendProofCode", inTurn, deps)).answer).toEqual({
      error: "notBuilt",
      call: "sendProofCode",
    });
    expect(made.k22.sends).toHaveLength(0);
  });
});
