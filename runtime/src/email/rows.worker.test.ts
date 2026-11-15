// The email rows (T-1286; C-129), run inside the Workers runtime (Vitest project "workers"): the K-12 request a code row
// goes as, built from K-05 v1.13's own claimed code row (claim-sam-sign-in-code.json: Sam's sign-in code, an email row
// with no turn, purpose code) and from K-12's send-code.json (the code email's form), each checked against that form
// and against K-12's own shape checks (the email double's, which the Resend adapter's match: T-419); and the email rows
// not built here. Names and addresses are the fixtures' sample cast, on the reserved example domains (rule 9).
import { sendEmailProblems } from "@rosie/adapters/email/double";
import { describe, expect, it } from "vitest";

import claimSamSignInCode from "../../../contracts/data-access/fixtures/claim-sam-sign-in-code.json";
import sendCode from "../../../contracts/port-email/fixtures/send-code.json";
import type { ClaimedRow, PlannedSend } from "../dispatch/types";
import {
  ASSISTANT_LINE,
  CODE_SUBJECT,
  ROSIE_FROM_ADDRESS,
  ROSIE_NAME,
  codeEmailRequest,
  emailAddressOf,
  emailWordsOf,
} from "./rows";
import type { EmailSendRequest } from "./types";

/** K-12's code email (send-code.json), as the port's request type (its JSON gives its labels as plain strings). */
const SEND_CODE = sendCode.request as unknown as EmailSendRequest;
/** Sam's sign-in code's words, in its row's final parts (ADR-016 section 1; S11-52's example code). */
const SIGN_IN_WORDS = "Code 482913: type it on the sign-in page. It works for 10 minutes.";
/** Sam's proven address, his email handle's (K-22 seed-owner-id-upload.json; K-05 v1.13's sign-in fixtures). */
const SAM_ADDRESS = "sam@example.com";

const words = (text: string): PlannedSend => ({
  kind: "words",
  text,
  calendarFile: "none",
  options: [],
  link: null,
});

/** Sam's code row as K-05 v1.13 claims it (claim-sam-sign-in-code.json), in the dispatcher's shape, with what differs. */
function codeRow(overrides: Partial<ClaimedRow> = {}): ClaimedRow {
  const [claimed] = claimSamSignInCode.outcome.claimed;
  if (claimed === undefined) throw new Error("the fixture claims a row");
  return { ...(structuredClone(claimed) as unknown as ClaimedRow), ...overrides };
}

/** The row's final parts with these sends, and every other part as the code row's. */
const withSends = (...sends: PlannedSend[]): Partial<ClaimedRow> => ({
  finalParts: { ...codeRow().finalParts, sends },
});

/** send-code.json's text split as K-12 writes it: the assistant line, a blank line, then the words. */
function sendCodeWords(): string {
  const [line, blank, ...rest] = SEND_CODE.text.split("\n");
  expect([line, blank]).toEqual([SEND_CODE.assistantLine, ""]);
  return rest.join("\n");
}

describe("a code row about no business goes in K-12 send-code.json's form (ADR-016 section 1)", () => {
  it("Sam's sign-in code row: send-code.json's request with the row's key, his address, the line with no business and the row's words", () => {
    const built = emailWordsOf(codeRow());
    expect(built).toEqual({ words: SIGN_IN_WORDS });
    if (!("words" in built)) return;

    const request = codeEmailRequest({
      idempotencyKey: "out-sam-sign-in-nov02-code/1/1",
      words: built.words,
      to: SAM_ADDRESS,
      fromAddress: ROSIE_FROM_ADDRESS,
    });

    expect(request).toEqual({
      ...SEND_CODE,
      idempotencyKey: "out-sam-sign-in-nov02-code/1/1",
      to: SAM_ADDRESS,
      assistantLine: "This is Rosie, an automated assistant.",
      text: `This is Rosie, an automated assistant.\n\n${SIGN_IN_WORDS}`,
    });
    // What K-12 fixes for a code email about no booking is send-code.json's own, field for field.
    for (const field of [
      "purpose",
      "bookingId",
      "from",
      "replyTo",
      "subject",
      "manageLink",
      "chatLink",
      "thread",
    ] as const) {
      expect([field, request[field]]).toEqual([field, SEND_CODE[field]]);
    }
    // K-12's own checks (the double's, which the Resend adapter's match): the text starts with the line, which says
    // "automated"; an email about no booking has no reply address, manage link or thread; the From is on mail.rosfield.com.
    expect(sendEmailProblems(request)).toEqual([]);
  });

  it("a row built from send-code.json's request goes as that request, but for the one clause a row about no business has not", () => {
    const sendCodeText = sendCodeWords();
    const row = codeRow({ outboxRowId: "out-sam-email-check-code", ...withSends(words(sendCodeText)) });
    const built = emailWordsOf(row);
    expect(built).toEqual({ words: sendCodeText });
    if (!("words" in built)) return;

    const request = codeEmailRequest({
      idempotencyKey: SEND_CODE.idempotencyKey,
      words: built.words,
      to: SEND_CODE.to,
      fromAddress: ROSIE_FROM_ADDRESS,
    });

    // S1-10's code names the business it sets up ("setting up Lee's Barbershop"), whose name no claimed row carries
    // (T-264's); a row about no business takes ADR-016's line with no business, at the head of the same text.
    expect(SEND_CODE.assistantLine).toBe(`${ASSISTANT_LINE.slice(0, -1)}, setting up Lee's Barbershop.`);
    expect(request).toEqual({
      ...SEND_CODE,
      assistantLine: ASSISTANT_LINE,
      text: `${ASSISTANT_LINE}\n\n${sendCodeText}`,
    });
    expect(sendEmailProblems(request)).toEqual([]);
  });

  it("the subject, the From and the assistant line are K-12's and ADR-016's own", () => {
    expect([CODE_SUBJECT, ROSIE_NAME, ROSIE_FROM_ADDRESS]).toEqual([
      SEND_CODE.subject,
      SEND_CODE.from.name,
      SEND_CODE.from.address,
    ]);
    expect(ASSISTANT_LINE).toBe("This is Rosie, an automated assistant.");
    const request = codeEmailRequest({
      idempotencyKey: "out-sam-sign-in-nov02-code/1/2",
      words: SIGN_IN_WORDS,
      to: SAM_ADDRESS,
      fromAddress: "rosie-staging@mail.rosfield.com",
    });
    // The From address is the one the wiring hands in (K-12 default 2: a config value), under Rosie's name.
    expect(request.from).toEqual({ name: "Rosie", address: "rosie-staging@mail.rosfield.com" });
    expect(request.idempotencyKey).toBe("out-sam-sign-in-nov02-code/1/2");
    expect(request.text.split("\n")[0]).toBe(request.assistantLine);
  });
});

describe("the email rows not built here send nothing (T-264's)", () => {
  it("every purpose but a code, and a row that names none (an answer before K-05 v1.13)", () => {
    for (const purpose of ["confirmation", "copy", "emailWay", "nextWay", "notice", null] as const) {
      expect([purpose, emailWordsOf(codeRow({ emailPurpose: purpose }))]).toEqual([
        purpose,
        { notBuilt: "purposeNotBuilt" },
      ]);
    }
    const v112 = codeRow();
    delete v112.emailPurpose;
    expect(emailWordsOf(v112)).toEqual({ notBuilt: "purposeNotBuilt" });
  });

  it("a code row about a business, a booking or a question (S1-10's code at Lee's Barbershop among them)", () => {
    const rows: [string, ClaimedRow][] = [
      ["a business", codeRow({ businessId: "biz-lees-barbershop" })],
      ["a booking", codeRow({ bookingId: "booking-sam-nov20" })],
      ["a question", codeRow({ openQuestionId: "oq-sam-nov02" })],
    ];
    for (const [name, row] of rows) {
      expect([name, emailWordsOf(row)]).toEqual([name, { notBuilt: "aboutNotBuilt" }]);
    }
  });

  it("final parts that are not one words send of words alone", () => {
    const poll: PlannedSend = { ...words("Which works?"), kind: "poll", options: ["Sat", "Sun"] };
    const rows: [string, Partial<ClaimedRow>][] = [
      ["no send", withSends()],
      ["two sends", withSends(words(SIGN_IN_WORDS), words("And one more."))],
      ["a poll", withSends(poll)],
      [
        "a link card",
        withSends({ ...words(SIGN_IN_WORDS), kind: "linkCard", link: "https://example.com/x" }),
      ],
      ["a tapback", withSends({ ...words(SIGN_IN_WORDS), kind: "tapback" })],
      ["a calendar file", withSends({ ...words(SIGN_IN_WORDS), calendarFile: "new" })],
      ["an option", withSends({ ...words(SIGN_IN_WORDS), options: ["Yes"] })],
      ["a link", withSends({ ...words(SIGN_IN_WORDS), link: "https://example.com/x" })],
      ["no words", withSends({ ...words(SIGN_IN_WORDS), text: null })],
      ["blank words", withSends(words("  \n "))],
      ["a fixed line", { finalParts: { ...codeRow().finalParts, fixedLines: ["stopReply"] } }],
      ["a thread", { finalParts: { ...codeRow().finalParts, threadReplyTo: "msg-sam-0001" } }],
    ];
    for (const [name, overrides] of rows) {
      expect([name, emailWordsOf(codeRow(overrides))]).toEqual([name, { notBuilt: "partsNotBuilt" }]);
    }
  });
});

describe("the recipient's address, as K-12 sends to it (in lower case)", () => {
  it("takes an address in lower case, trimmed; anything else is none", () => {
    expect(emailAddressOf(SAM_ADDRESS)).toBe(SAM_ADDRESS);
    expect(emailAddressOf(" Sam@Lees-Barbershop.example ")).toBe("sam@lees-barbershop.example");
    for (const value of [
      null,
      undefined,
      "",
      "sam",
      "sam@",
      "@example.com",
      "sam @example.com",
      "a@b@c",
      7,
    ]) {
      expect([value, emailAddressOf(value)]).toEqual([value, null]);
    }
  });
});
