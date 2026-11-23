// T-514: each of answerOnPage's and confirmOnPage's errors (K-21 v1 `$defs/answerOnPage.errors`,
// `$defs/confirmOnPage.errors`) gives its own page, says nothing was sent or saved, and sends no second call; a fresh
// read-back (readBackChanged) is shown for a fresh yes, whose own yes alone sends the next confirm. No frozen fixture
// shows these answers, so a stub gives each, typed by K-21 v1. The answers themselves are the server's; the page only
// shows them.
//
// Every value is made up (rule 9).
import { describe, expect, it } from "vitest";
import { cookieNames } from "../../auth/cookies";
import type { ErrorOf, OutcomeOf, RequestOf } from "../../client/calls";
import { TEST_LINK_HOST } from "../../shell/test-support";
import {
  EVERY_KIND_QUESTION,
  LINK,
  S2_22_QUESTION,
  answerShell,
  formPost,
  getWith,
  post,
  sessionCookie,
  tagsOf,
  titleOf,
  visibleText,
  type AnswerShell,
} from "./test-support";

const COOKIE_TOKEN = "dummy-session-token-0001";

const answerPath = (shell: AnswerShell): string => `${shell.config.basePath}/${LINK}/answer`;
const yesPath = (shell: AnswerShell): string => `${shell.config.basePath}/${LINK}/answer/yes`;
const cookieOf = (shell: AnswerShell): Record<string, string> => sessionCookie(shell.config, COOKIE_TOKEN);

/** A made-up read-back in K-21 v1's shape. */
function readBack(readBackId: string, words: string): OutcomeOf<"answerOnPage"> {
  return {
    result: "readBack",
    readBackId,
    stepId: "S2-22",
    questionId: "oq-s2-22-sam",
    words,
    shown: [{ table: "staff", rowId: "staff-dummy-0001", version: 5 }],
    signature: "none",
    expiresAt: "2026-10-21T13:21:00Z",
  };
}

/** The page answerOnPage's `error` gives, with the calls sent. */
async function answerError(
  error: ErrorOf<"answerOnPage">,
  values: Record<string, string> = { choice: "c-01" },
): Promise<{ status: number; html: string; shell: AnswerShell }> {
  const shell = answerShell({ question: EVERY_KIND_QUESTION, stubs: { answerOnPage: () => error } });
  const form = await (await shell.shell.fetch(getWith(answerPath(shell), cookieOf(shell)))).text();
  const response = await shell.shell.fetch(post(answerPath(shell), formPost(form, values), cookieOf(shell)));
  return { status: response.status, html: await response.text(), shell };
}

/** The page confirmOnPage's `outcome` gives to the yes on a read-back, with the calls sent and the confirms taken. */
async function yesOutcome(
  outcomes: readonly OutcomeOf<"confirmOnPage">[],
): Promise<{ status: number; html: string; shell: AnswerShell; confirms: RequestOf<"confirmOnPage">[] }> {
  const confirms: RequestOf<"confirmOnPage">[] = [];
  const shell = answerShell({
    stubs: {
      answerOnPage: () => readBack("rb-dummy-0001", "Made-up read-back words."),
      confirmOnPage: (request) => {
        confirms.push(request);
        const outcome = outcomes[confirms.length - 1];
        if (outcome === undefined) throw new Error("more confirms than the test gave answers for");
        return outcome;
      },
    },
  });
  const form = await (await shell.shell.fetch(getWith(answerPath(shell), cookieOf(shell)))).text();
  const page = await (
    await shell.shell.fetch(post(answerPath(shell), formPost(form, { choice: "c-01" }), cookieOf(shell)))
  ).text();
  const response = await shell.shell.fetch(
    post(yesPath(shell), formPost(page, { decision: "yes" }), cookieOf(shell)),
  );
  return { status: response.status, html: await response.text(), shell, confirms };
}

const backLink = (shell: AnswerShell, html: string): boolean =>
  tagsOf(html, "a").some((tag) => tag.attributes.href === answerPath(shell));

describe("answerOnPage's errors: nothing was written, and the page says why", () => {
  const cases: [string, ErrorOf<"answerOnPage">, number, string][] = [
    [
      "notAllowed notDecider",
      { error: "notAllowed", why: "notDecider" },
      403,
      "Only the person who decides this can answer it.",
    ],
    [
      "notAllowed unprovenSender",
      { error: "notAllowed", why: "unprovenSender" },
      403,
      "This needs a code that proves it is you first.",
    ],
    [
      "notAllowed wrongRole",
      { error: "notAllowed", why: "wrongRole" },
      403,
      "This step is for another role.",
    ],
    [
      "notAllowed otherBusiness",
      { error: "notAllowed", why: "otherBusiness" },
      403,
      "This page is another business's.",
    ],
    [
      "questionClosed answered",
      { error: "questionClosed", questionId: "oq-dummy-0001", state: "answered" },
      409,
      "This question is already answered.",
    ],
    [
      "questionClosed defaulted",
      { error: "questionClosed", questionId: "oq-dummy-0001", state: "defaulted" },
      409,
      "This question has closed with its default.",
    ],
    [
      "questionClosed withdrawn",
      { error: "questionClosed", questionId: "oq-dummy-0001", state: "withdrawn" },
      409,
      "This question was taken back.",
    ],
    [
      "uploadNotFound",
      { error: "uploadNotFound", uploadId: "upload-dummy-0001" },
      400,
      "A file this answer carries did not arrive",
    ],
    [
      "bookingPaused",
      { error: "bookingPaused", retryAfterSeconds: 30 },
      503,
      "Nothing was saved. Try again later.",
    ],
  ];
  for (const [name, error, status, words] of cases) {
    it(`${name}: status ${String(status)}, its words in an alert, the way back, and no second call`, async () => {
      const page = await answerError(error);
      expect(page.status).toBe(status);
      expect(titleOf(page.html)).toMatch(/^Error: /);
      expect(page.html).toContain('<p role="alert">');
      expect(visibleText(page.html)).toContain(words);
      expect(backLink(page.shell, page.html)).toBe(true);
      expect(page.shell.sent.map((one) => one.call)).toEqual(["answerOnPage"]);
      // No form here: nothing on the page can send anything.
      expect(page.html).not.toContain("<form");
    });
  }

  it("signInNeeded: the sign-in of the link's own account, and no second call", async () => {
    const page = await answerError({ error: "signInNeeded" });
    expect(page.status).toBe(403);
    expect(tagsOf(page.html, "a").map((tag) => tag.attributes.href)).toContain(
      `${page.shell.config.basePath}/sign-in?link=${LINK}`,
    );
    expect(page.shell.sent.map((one) => one.call)).toEqual(["answerOnPage"]);
  });

  it("safetyFirst: the checked line's words first, nothing booked, no form, and no second call", async () => {
    const page = await answerError({
      error: "safetyFirst",
      outcomeId: "safety-dummy-0001",
      fixedLineId: "line-dummy-0001",
      words: "Made-up safety line <b>as given</b>.",
    });
    expect(page.status).toBe(200);
    expect(page.html).toContain('<p role="alert">Made-up safety line &lt;b&gt;as given&lt;/b&gt;.</p>');
    expect(visibleText(page.html)).toContain("Nothing was booked or saved.");
    expect(page.html).not.toContain("<form");
    expect(page.shell.sent.map((one) => one.call)).toEqual(["answerOnPage"]);
  });

  it("fieldsInvalid: the form again with the option kept and the fields named, and nothing more sent", async () => {
    const page = await answerError(
      { error: "fieldsInvalid", fields: ["visits"] },
      { choice: "c-02", "field.visits": "two" },
    );
    expect(page.status).toBe(400);
    const checked = tagsOf(page.html, "input").filter(
      (tag) => tag.attributes.name === "choice" && "checked" in tag.attributes,
    );
    expect(checked.map((tag) => tag.attributes.value)).toEqual(["c-02"]);
    expect(visibleText(page.html)).toContain("Visits: Type a whole number, like 2.");
    expect(page.shell.sent.map((one) => one.call)).toEqual(["answerOnPage"]);
  });

  it("transient: the form again to send once more, with a fresh request id, and nothing more sent", async () => {
    const page = await answerError({ error: "transient", sqlstate: "40001" });
    expect(page.status).toBe(503);
    expect(visibleText(page.html)).toContain(
      "That did not go through. Nothing was changed. Try again in a moment.",
    );
    const ids = tagsOf(page.html, "input").filter((tag) => tag.attributes.name === "requestId");
    expect(ids.map((tag) => tag.attributes.value)).toEqual(["req-made-in-test-2"]);
    expect(page.shell.sent.map((one) => one.call)).toEqual(["answerOnPage"]);
  });
});

describe("confirmOnPage's errors: nothing was written, and the page says why", () => {
  const cases: [string, ErrorOf<"confirmOnPage">, number, string][] = [
    [
      "readBackExpired",
      { error: "readBackExpired" },
      409,
      "It was not saved. Answer again to see it read back.",
    ],
    ["signatureNeeded", { error: "signatureNeeded" }, 400, "none came, so nothing was saved"],
    [
      "notAllowed notDecider",
      { error: "notAllowed", why: "notDecider" },
      403,
      "Only the person who decides this can answer it.",
    ],
    [
      "needsMissing",
      { error: "needsMissing", step: "S1-29", missing: ["terms"] },
      409,
      "Something this needs is not done yet",
    ],
    [
      "notFound",
      { error: "notFound", table: "staff", rowId: "staff-dummy-0001" },
      409,
      "Something this names is no longer there",
    ],
    [
      "versionChanged",
      {
        error: "versionChanged",
        changed: [{ table: "staff", rowId: "staff-dummy-0001", readVersion: 5, currentVersion: 6 }],
      },
      409,
      "Answer again to see what stands now.",
    ],
    [
      "constraint",
      { error: "constraint", sqlstate: "23514", constraint: "dummy_check" },
      409,
      "This could not be saved as it stands",
    ],
    [
      "bookingPaused",
      { error: "bookingPaused", retryAfterSeconds: 30 },
      503,
      "Nothing was saved. Try again later.",
    ],
    [
      "transient",
      { error: "transient", sqlstate: "40001" },
      503,
      "Nothing was changed. Try again in a moment.",
    ],
  ];
  for (const [name, error, status, words] of cases) {
    it(`${name}: status ${String(status)}, its words in an alert, the way back, and no second confirm`, async () => {
      const page = await yesOutcome([error]);
      expect(page.status).toBe(status);
      expect(titleOf(page.html)).toMatch(/^Error: /);
      expect(page.html).toContain('<p role="alert">');
      expect(visibleText(page.html)).toContain(words);
      expect(backLink(page.shell, page.html)).toBe(true);
      expect(page.confirms).toHaveLength(1);
      expect(page.html).not.toContain("<form");
    });
  }

  it("signInNeeded: the sign-in of the link's own account, and no second confirm", async () => {
    const page = await yesOutcome([{ error: "signInNeeded" }]);
    expect(page.status).toBe(403);
    expect(tagsOf(page.html, "a").map((tag) => tag.attributes.href)).toContain(
      `${page.shell.config.basePath}/sign-in?link=${LINK}`,
    );
    expect(page.confirms).toHaveLength(1);
  });

  it("readBackChanged: the fresh read-back's words for a fresh yes, which alone sends the next confirm, with the fresh id", async () => {
    const fresh = readBack("rb-dummy-0002", "Made-up fresh read-back words.");
    if ("error" in fresh) throw new Error("not a read-back");
    const page = await yesOutcome([
      { error: "readBackChanged", readBack: fresh },
      {
        result: "committed",
        readBackId: "rb-dummy-0002",
        yesEventId: "pageyes-dummy-0002",
        served: {
          call: "saveSetupStep",
          response: {
            step: "S2-22",
            gives: [],
            branch: null,
            written: [],
            openQuestionId: null,
            outboxRowIds: [],
            clockRowIds: [],
            effects: [],
            reviewItemId: null,
            repeated: false,
          },
        },
      },
    ]);
    expect(page.status).toBe(409);
    expect(visibleText(page.html)).toContain("Something changed since you read it, so nothing was saved.");
    expect(page.html).toContain("<blockquote><p>Made-up fresh read-back words.</p></blockquote>");
    expect(page.html).not.toContain("Made-up read-back words.</p>");
    expect(page.confirms.map((one) => one.readBackId)).toEqual(["rb-dummy-0001"]);

    // Leaving it sends nothing; its own yes sends the next confirm, for the fresh read-back.
    const { shell } = page;
    const answer = await shell.shell.fetch(
      post(yesPath(shell), formPost(page.html, { decision: "yes" }), cookieOf(shell)),
    );
    expect(answer.status).toBe(200);
    expect(page.confirms.map((one) => one.readBackId)).toEqual(["rb-dummy-0001", "rb-dummy-0002"]);
    expect(page.confirms[1]?.page.requestId).not.toBe(page.confirms[0]?.page.requestId);
  });
});

describe("the yes form's own refusals send nothing", () => {
  it("a yes form that is not this page's (no read-back id, a bad request id, a body that is not a form) sends nothing", async () => {
    const shell = answerShell({ stubs: { answerOnPage: () => readBack("rb-dummy-0001", "Made-up words.") } });
    const form = await (await shell.shell.fetch(getWith(answerPath(shell), cookieOf(shell)))).text();
    const page = await (
      await shell.shell.fetch(post(answerPath(shell), formPost(form, { choice: "c-01" }), cookieOf(shell)))
    ).text();
    for (const values of [{ readBack: "" }, { requestId: "short" }, { sign: "somethingElse" }]) {
      const response = await shell.shell.fetch(
        post(yesPath(shell), formPost(page, { decision: "yes", ...values }), cookieOf(shell)),
      );
      expect(response.status).toBe(400);
      expect(visibleText(await response.text())).toContain(
        "That form could not be read, so nothing was saved.",
      );
    }
    const notForm = await shell.shell.fetch(
      new Request(`https://${TEST_LINK_HOST}${yesPath(shell)}`, {
        method: "POST",
        headers: {
          origin: `https://${TEST_LINK_HOST}`,
          "content-type": "application/json",
          cookie: `${cookieNames(shell.config).session}=${COOKIE_TOKEN}`,
        },
        body: JSON.stringify({ decision: "yes", readBack: "rb-dummy-0001" }),
      }),
    );
    expect(notForm.status).toBe(400);
    expect(shell.sent.map((one) => one.call)).toEqual(["answerOnPage"]);
  });

  it("an answer form that is not this page's (no request id, no question named, not a form) sends nothing", async () => {
    const shell = answerShell({ question: S2_22_QUESTION });
    const form = await (await shell.shell.fetch(getWith(answerPath(shell), cookieOf(shell)))).text();
    for (const values of [{ requestId: "" }, { step: "" }]) {
      const response = await shell.shell.fetch(
        post(answerPath(shell), formPost(form, { choice: "c-01", ...values }), cookieOf(shell)),
      );
      expect(response.status).toBe(400);
      expect(visibleText(await response.text())).toContain(
        "That form could not be read, so nothing was sent.",
      );
    }
    expect(shell.sent).toEqual([]);
  });
});
