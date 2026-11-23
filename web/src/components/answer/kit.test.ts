// T-514's proofs for the page answer kit (C-185; K-21 v1 answerOnPage and confirmOnPage; answer-from-page.json,
// fee-consent-ok.json, go-live.json): answer-from-page.json's question renders, the chosen option and fields are sent,
// the returned read-back shows, and only the yes on the read-back sends the confirming call; leaving the read-back
// without a yes sends nothing that commits; a typed name is taken as the signature where the response asks for one.
// Each runs on the shell (the POST guards first) over the Tool API mock, which answers a frozen fixture's request and
// fails loudly on any other; a stub answers only the calls no frozen fixture shows. The accessibility proofs are
// access.test.ts's; each answer's error page is errors.test.ts's.
//
// Every value is a fixture's own placeholder or made up (rule 9).
import { describe, expect, it } from "vitest";
import type { OutcomeOf, RequestOf } from "../../client/calls";
import { escapeHtml } from "../../shell/frame";
import { TRACE_ID } from "../../shell/test-support";
import type { AnswerReadBack } from "./kit";
import {
  ANSWER_FROM_PAGE,
  FEE_CONSENT_OK,
  GO_LIVE,
  LINK,
  S2_22_QUESTION,
  answerShell,
  decidedCard,
  formPost,
  getWith,
  post,
  s206Question,
  sessionCookie,
  tagsOf,
  textOfId,
  titleOf,
  visibleText,
  type AnswerShell,
} from "./test-support";

const ANSWER_PATH = (shell: AnswerShell): string => `${shell.config.basePath}/${LINK}/answer`;
const YES_PATH = (shell: AnswerShell): string => `${shell.config.basePath}/${LINK}/answer/yes`;

/** An answerOnPage outcome that must be its read-back. */
function readBackOf(outcome: OutcomeOf<"answerOnPage">): AnswerReadBack {
  if ("error" in outcome) throw new Error("the outcome is not a read-back");
  return outcome;
}

/** answer-from-page.json's request and its read-back. */
const ANSWER = ANSWER_FROM_PAGE.request;
const READ_BACK = readBackOf(ANSWER_FROM_PAGE.outcome);

/** The shell for answer-from-page.json: its trace id, and its request id as the question form's own. */
function fixtureShell(): AnswerShell {
  return answerShell({
    traceId: ANSWER.page.traceId,
    requestIds: [ANSWER.page.requestId, "req-yes-made-in-test-0001"],
  });
}

/** Sam's session cookie, as answer-from-page.json's request carries its token. */
const samCookie = (shell: AnswerShell): Record<string, string> =>
  sessionCookie(shell.config, ANSWER.page.sessionToken);

/** A committed answer to the yes on answer-from-page.json's read-back, made up in K-21 v1's shape. */
function committedFor(request: RequestOf<"confirmOnPage">): OutcomeOf<"confirmOnPage"> {
  return {
    result: "committed",
    readBackId: request.readBackId,
    yesEventId: "pageyes-dummy-0001",
    served: {
      call: "saveSetupStep",
      response: {
        step: "S2-22",
        gives: [],
        branch: "1 Yes, all of them",
        written: [],
        openQuestionId: null,
        outboxRowIds: [],
        clockRowIds: [],
        effects: [],
        reviewItemId: null,
        repeated: false,
      },
    },
  };
}

describe("answer-from-page.json's question renders", () => {
  it("S2_22_QUESTION is S2-22's card question and its options' labels, word for word, as K-09 v1's decided turn holds them", () => {
    const card = decidedCard("commit-limit-3-no-exact-yes.json", "S2-22", "oq-s2-22-sam");
    expect(S2_22_QUESTION.words).toBe(card.question);
    expect(S2_22_QUESTION.options).toEqual(card.choices);
    // The question the fixture answers: its step, its question id, and the option it picks among the options.
    expect(S2_22_QUESTION.stepId).toBe(ANSWER.stepId);
    expect(S2_22_QUESTION.questionId).toBe(ANSWER.questionId);
    expect(S2_22_QUESTION.options.map((option) => option.choiceId)).toContain(ANSWER.choiceId);
    // The read-back's words are the card's question and the option's label (the fixture's note).
    expect(READ_BACK.words).toBe(`${card.question} ${card.choices[0]?.label ?? ""}`);
  });

  it("the page shows the question as the legend of its options, each option a radio button labelled with its own words, and sends nothing", async () => {
    const shell = fixtureShell();
    const response = await shell.shell.fetch(getWith(ANSWER_PATH(shell), samCookie(shell)));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<legend>${escapeHtml(S2_22_QUESTION.words)}</legend>`);
    const radios = tagsOf(html, "input").filter((tag) => tag.attributes.type === "radio");
    expect(radios.map((tag) => tag.attributes.value)).toEqual(["c-01", "c-02"]);
    for (const [k, option] of S2_22_QUESTION.options.entries()) {
      const id = radios[k]?.attributes.id ?? "";
      expect(html).toContain(`<label for="${id}">${escapeHtml(option.label)}</label>`);
      expect(radios[k]?.attributes.name).toBe("choice");
    }
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(shell.sent).toEqual([]);
  });

  it("the form posts to the page's own answer address, carrying this form's own request id, the step and the question", async () => {
    const shell = fixtureShell();
    const html = await (await shell.shell.fetch(getWith(ANSWER_PATH(shell), samCookie(shell)))).text();
    const [form] = tagsOf(html, "form");
    expect(form?.attributes).toEqual({ method: "post", action: ANSWER_PATH(shell) });
    expect(formPost(html, {})).toEqual({
      requestId: ANSWER.page.requestId,
      step: "S2-22",
      question: "oq-s2-22-sam",
    });
  });
});

describe("the chosen option and fields are sent", () => {
  it("answering S2-22 with '1 Yes, all of them' sends exactly answer-from-page.json's request, and nothing else", async () => {
    const shell = fixtureShell();
    const html = await (await shell.shell.fetch(getWith(ANSWER_PATH(shell), samCookie(shell)))).text();
    const response = await shell.shell.fetch(
      post(ANSWER_PATH(shell), formPost(html, { choice: "c-01" }), samCookie(shell)),
    );
    expect(response.status).toBe(200);
    expect(shell.sent).toHaveLength(1);
    expect(shell.sent[0]?.call).toBe("answerOnPage");
    expect(shell.sent[0]?.request).toEqual(ANSWER);
    expect(shell.sent[0]?.traceId).toBe(ANSWER.page.traceId);
  });

  it("S2-06's two fields are sent by their names with their words as typed; an empty field and a field the question does not hold are not", async () => {
    const question = s206Question();
    const sentAnswers: RequestOf<"answerOnPage">[] = [];
    const shell = answerShell({
      question,
      requestIds: ["req-staff-made-in-test-0001"],
      stubs: {
        answerOnPage: (request) => {
          sentAnswers.push(request);
          return { ...READ_BACK, stepId: "S2-06", questionId: null, readBackId: "rb-dummy-s2-06-1" };
        },
      },
    });
    const cookie = sessionCookie(shell.config, "dummy-session-token-0001");
    const html = await (await shell.shell.fetch(getWith(ANSWER_PATH(shell), cookie))).text();
    // The name's prefill shows for Riley to confirm; the languages have none.
    expect(tagsOf(html, "input").find((tag) => tag.attributes.name === "field.name")?.attributes.value).toBe(
      "Riley",
    );
    await shell.shell.fetch(
      post(
        ANSWER_PATH(shell),
        formPost(html, {
          "field.name": "  Riley A. ",
          "field.languages": "English, Spanish",
          "field.extra": "x",
        }),
        cookie,
      ),
    );
    expect(sentAnswers).toEqual([
      {
        page: {
          requestId: "req-staff-made-in-test-0001",
          traceId: TRACE_ID,
          sessionToken: "dummy-session-token-0001",
          linkCode: LINK,
        },
        stepId: "S2-06",
        questionId: null,
        choiceId: null,
        fields: [
          { name: "name", words: "  Riley A. " },
          { name: "languages", words: "English, Spanish" },
        ],
        uploadIds: [],
      },
    ]);

    // Left empty, the languages are left out (K-21 gives a field's words at least one character).
    const again = answerShell({
      question,
      requestIds: ["req-staff-made-in-test-0002"],
      stubs: {
        answerOnPage: (request) => {
          sentAnswers.push(request);
          return { ...READ_BACK, stepId: "S2-06", questionId: null, readBackId: "rb-dummy-s2-06-2" };
        },
      },
    });
    const form = await (await again.shell.fetch(getWith(ANSWER_PATH(again), cookie))).text();
    await again.shell.fetch(
      post(ANSWER_PATH(again), formPost(form, { "field.name": "Riley", "field.languages": "   " }), cookie),
    );
    expect(sentAnswers[1]?.fields).toEqual([{ name: "name", words: "Riley" }]);
  });

  it("the upload ids the page shell binds to the session go with the answer (T-521), never an object key", async () => {
    let sentRequest: RequestOf<"answerOnPage"> | null = null;
    const shell = answerShell({
      uploadIds: ["upload-dummy-0001"],
      requestIds: ["req-upload-made-in-test-0001"],
      stubs: {
        answerOnPage: (request) => {
          sentRequest = request;
          return READ_BACK;
        },
      },
    });
    const cookie = sessionCookie(shell.config, "dummy-session-token-0001");
    const html = await (await shell.shell.fetch(getWith(ANSWER_PATH(shell), cookie))).text();
    await shell.shell.fetch(post(ANSWER_PATH(shell), formPost(html, { choice: "c-02" }), cookie));
    expect(sentRequest).toMatchObject({ choiceId: "c-02", uploadIds: ["upload-dummy-0001"] });
  });

  it("with no option picked, or one the question does not hold, nothing is sent and the form asks again", async () => {
    for (const choice of [null, "c-99"]) {
      const shell = fixtureShell();
      const html = await (await shell.shell.fetch(getWith(ANSWER_PATH(shell), samCookie(shell)))).text();
      const response = await shell.shell.fetch(
        post(ANSWER_PATH(shell), formPost(html, choice === null ? {} : { choice }), samCookie(shell)),
      );
      expect(response.status).toBe(400);
      const again = await response.text();
      expect(titleOf(again)).toMatch(/^Error: /);
      expect(visibleText(again)).toContain("Pick one of the options.");
      expect(shell.sent).toEqual([]);
    }
  });

  it("a form whose question is not the one the page shows now sends nothing and shows the question as it stands", async () => {
    const shell = fixtureShell();
    const html = await (await shell.shell.fetch(getWith(ANSWER_PATH(shell), samCookie(shell)))).text();
    const response = await shell.shell.fetch(
      post(
        ANSWER_PATH(shell),
        formPost(html, { choice: "c-01", question: "oq-s1-70-sam" }),
        samCookie(shell),
      ),
    );
    expect(response.status).toBe(409);
    expect(visibleText(await response.text())).toContain("The question on this page changed");
    expect(shell.sent).toEqual([]);
  });

  it("without a session nothing is sent, and the page offers the sign-in of the link's own account", async () => {
    const shell = fixtureShell();
    const html = await (await shell.shell.fetch(getWith(ANSWER_PATH(shell)))).text();
    const response = await shell.shell.fetch(post(ANSWER_PATH(shell), formPost(html, { choice: "c-01" })));
    expect(response.status).toBe(403);
    const page = await response.text();
    expect(tagsOf(page, "a").map((tag) => tag.attributes.href)).toContain(
      `${shell.config.basePath}/sign-in?link=${LINK}`,
    );
    expect(shell.sent).toEqual([]);
  });
});

describe("the returned read-back shows", () => {
  it("the read-back's exact words show, word for word, with when it lapses, and the yes form carries its id alone", async () => {
    const shell = fixtureShell();
    const html = await (await shell.shell.fetch(getWith(ANSWER_PATH(shell), samCookie(shell)))).text();
    const response = await shell.shell.fetch(
      post(ANSWER_PATH(shell), formPost(html, { choice: "c-01" }), samCookie(shell)),
    );
    const page = await response.text();
    expect(page).toContain(`<blockquote><p>${escapeHtml(READ_BACK.words)}</p></blockquote>`);
    expect(visibleText(page)).toContain(READ_BACK.words);
    expect(page).toContain('<time datetime="2026-10-21T13:11:00Z">2026-10-21 13:11 UTC</time>');
    expect(formPost(page, {})).toEqual({
      requestId: "req-yes-made-in-test-0001",
      readBack: READ_BACK.readBackId,
    });
    const [form] = tagsOf(page, "form");
    expect(form?.attributes.action).toBe(YES_PATH(shell));
    // The rows and versions it shows stay on the server: no row id or version is in the page.
    for (const row of READ_BACK.shown) expect(page).not.toContain(row.rowId);
    // S2-22's read-back signs with the yes alone: no name to type.
    expect(tagsOf(page, "input").filter((tag) => tag.attributes.type !== "hidden")).toEqual([]);
  });
});

describe("only the yes on the read-back sends the confirming call; leaving the read-back without a yes sends nothing that commits", () => {
  /** The shell with the read-back of answer-from-page.json on the page, and every confirm the stub took. */
  async function onReadBack(): Promise<{
    shell: AnswerShell;
    page: string;
    confirms: RequestOf<"confirmOnPage">[];
  }> {
    const confirms: RequestOf<"confirmOnPage">[] = [];
    const shell = answerShell({
      traceId: ANSWER.page.traceId,
      requestIds: [ANSWER.page.requestId, "req-yes-made-in-test-0001", "req-made-in-test-0003"],
      stubs: {
        confirmOnPage: (request) => {
          confirms.push(request);
          return committedFor(request);
        },
      },
    });
    const form = await (await shell.shell.fetch(getWith(ANSWER_PATH(shell), samCookie(shell)))).text();
    const page = await (
      await shell.shell.fetch(post(ANSWER_PATH(shell), formPost(form, { choice: "c-01" }), samCookie(shell)))
    ).text();
    return { shell, page, confirms };
  }

  it("answering sends answerOnPage alone, which writes nothing: no confirming call comes with it", async () => {
    const { shell, confirms } = await onReadBack();
    expect(shell.sent.map((one) => one.call)).toEqual(["answerOnPage"]);
    expect(confirms).toEqual([]);
  });

  it("the yes on the read-back sends exactly one confirmOnPage, with its own request id, the read-back's id and no typed name", async () => {
    const { shell, page, confirms } = await onReadBack();
    const response = await shell.shell.fetch(
      post(YES_PATH(shell), formPost(page, { decision: "yes" }), samCookie(shell)),
    );
    expect(response.status).toBe(200);
    expect(visibleText(await response.text())).toContain("Your yes is saved.");
    expect(shell.sent.map((one) => one.call)).toEqual(["answerOnPage", "confirmOnPage"]);
    expect(confirms).toEqual([
      {
        page: {
          requestId: "req-yes-made-in-test-0001",
          traceId: ANSWER.page.traceId,
          sessionToken: ANSWER.page.sessionToken,
          linkCode: LINK,
        },
        readBackId: READ_BACK.readBackId,
        typedName: null,
      },
    ]);
  });

  it("the yes button is the read-back form's one button, and its value is the only yes", async () => {
    const { page } = await onReadBack();
    const buttons = tagsOf(page, "button");
    expect(buttons.map((tag) => tag.attributes)).toEqual([
      { type: "submit", name: "decision", value: "yes" },
    ]);
  });

  it("leaving by the link back is a GET of the question's page: nothing is sent, and the question is there to answer again", async () => {
    const { shell, page, confirms } = await onReadBack();
    const leave = tagsOf(page, "a").find((tag) => visibleText(page.slice(tag.at)).startsWith("No, go back"));
    expect(leave?.attributes.href).toBe(ANSWER_PATH(shell));
    const response = await shell.shell.fetch(getWith(leave?.attributes.href ?? "", samCookie(shell)));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`<legend>${escapeHtml(S2_22_QUESTION.words)}</legend>`);
    expect(shell.sent.map((one) => one.call)).toEqual(["answerOnPage"]);
    expect(confirms).toEqual([]);
  });

  it("a post of the read-back's form without the yes (no button, another value) sends nothing and says nothing was saved", async () => {
    for (const values of [{}, { decision: "no" }, { decision: "YES" }, { decision: "yes " }]) {
      const { shell, page, confirms } = await onReadBack();
      const response = await shell.shell.fetch(
        post(YES_PATH(shell), formPost(page, values), samCookie(shell)),
      );
      expect(response.status).toBe(400);
      expect(visibleText(await response.text())).toContain("You did not say yes, so nothing was saved.");
      expect(shell.sent.map((one) => one.call)).toEqual(["answerOnPage"]);
      expect(confirms).toEqual([]);
    }
  });

  it("a GET of the yes address answers 405 and sends nothing", async () => {
    const { shell, confirms } = await onReadBack();
    const response = await shell.shell.fetch(getWith(YES_PATH(shell), samCookie(shell)));
    expect(response.status).toBe(405);
    expect(shell.sent.map((one) => one.call)).toEqual(["answerOnPage"]);
    expect(confirms).toEqual([]);
  });

  it("a yes without a session sends nothing and asks for the sign-in", async () => {
    const { shell, page, confirms } = await onReadBack();
    const response = await shell.shell.fetch(post(YES_PATH(shell), formPost(page, { decision: "yes" })));
    expect(response.status).toBe(403);
    expect(visibleText(await response.text())).toContain("Sign in to answer");
    expect(confirms).toEqual([]);
  });

  it("a yes posted from another site is refused by the shell before the kit runs: nothing is sent", async () => {
    const { shell, page, confirms } = await onReadBack();
    const response = await shell.shell.fetch(
      post(YES_PATH(shell), formPost(page, { decision: "yes" }), samCookie(shell), {
        origin: "https://elsewhere.example",
      }),
    );
    expect(response.status).toBe(403);
    expect(shell.sent.map((one) => one.call)).toEqual(["answerOnPage"]);
    expect(confirms).toEqual([]);
  });
});

describe("a typed name is taken as the signature where the response asks for one", () => {
  /** A made-up read-back in K-21 v1's shape, with the id a frozen confirmOnPage fixture says yes to. */
  function readBackFor(readBackId: string, signature: "none" | "typedName"): OutcomeOf<"answerOnPage"> {
    return {
      result: "readBack",
      readBackId,
      stepId: readBackId === "rb-sam-s1-29-1" ? "S1-29" : "S1-25",
      questionId: null,
      words: "Made-up read-back words for a test.\nA second line of them.",
      shown: [],
      signature,
      expiresAt: "2026-10-19T15:11:00Z",
    };
  }

  /**
   * The shell on the read-back `readBackId` (answerOnPage stubbed: no frozen answerOnPage fixture holds these
   * read-backs), with the yes form's request id and trace id the frozen confirmOnPage fixture holds, so its yes goes to
   * the Tool API mock and gets that fixture's answer, or fails loudly.
   */
  async function onReadBack(
    fixture: typeof FEE_CONSENT_OK,
    signature: "none" | "typedName",
  ): Promise<{ shell: AnswerShell; page: string; cookie: Record<string, string> }> {
    const shell = answerShell({
      traceId: fixture.request.page.traceId,
      requestIds: ["req-answer-made-in-test-0001", fixture.request.page.requestId],
      stubs: { answerOnPage: () => readBackFor(fixture.request.readBackId, signature) },
    });
    const cookie = sessionCookie(shell.config, fixture.request.page.sessionToken);
    const form = await (await shell.shell.fetch(getWith(ANSWER_PATH(shell), cookie))).text();
    const page = await (
      await shell.shell.fetch(post(ANSWER_PATH(shell), formPost(form, { choice: "c-01" }), cookie))
    ).text();
    return { shell, page, cookie };
  }

  it("go-live.json: the read-back asks a typed name, the page asks for it in a labelled box, and the name typed goes as the signature", async () => {
    const { shell, page, cookie } = await onReadBack(GO_LIVE, "typedName");
    const box = tagsOf(page, "input").find((tag) => tag.attributes.type === "text");
    expect(box?.attributes).toMatchObject({ name: "typedName", autocomplete: "name", maxlength: "200" });
    expect(box?.attributes).toHaveProperty("required");
    const id = box?.attributes.id ?? "";
    expect(page).toContain(`<label for="${id}">Type your full name to sign</label>`);
    expect(textOfId(page, box?.attributes["aria-describedby"] ?? "")).toBe(
      "Typing your name here is your signature on the words above.",
    );
    // The read-back's two lines keep their break.
    expect(page).toContain("Made-up read-back words for a test.<br>A second line of them.");

    const response = await shell.shell.fetch(
      post(YES_PATH(shell), formPost(page, { decision: "yes", typedName: "Sam Lee" }), cookie),
    );
    expect(response.status).toBe(200);
    expect(shell.sent[1]?.request).toEqual(GO_LIVE.request);
    expect(visibleText(await response.text())).toContain("Your yes is saved.");
  });

  it("fee-consent-ok.json: the read-back asks none, so the page has no name box and no name is sent, even one posted", async () => {
    const { shell, page, cookie } = await onReadBack(FEE_CONSENT_OK, "none");
    expect(tagsOf(page, "input").filter((tag) => tag.attributes.type !== "hidden")).toEqual([]);
    const response = await shell.shell.fetch(
      post(YES_PATH(shell), formPost(page, { decision: "yes", typedName: "Sam Lee" }), cookie),
    );
    expect(response.status).toBe(200);
    expect(shell.sent[1]?.request).toEqual(FEE_CONSENT_OK.request);
  });

  it("where a name is asked, a yes with no name, or only spaces, sends nothing and asks for the name", async () => {
    for (const typedName of [null, "", "   "]) {
      const { shell, page, cookie } = await onReadBack(GO_LIVE, "typedName");
      const response = await shell.shell.fetch(
        post(
          YES_PATH(shell),
          formPost(page, typedName === null ? { decision: "yes" } : { decision: "yes", typedName }),
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const answer = await response.text();
      expect(titleOf(answer)).toBe("Error: Your name is needed to sign");
      expect(shell.sent.map((one) => one.call)).toEqual(["answerOnPage"]);
    }
  });

  it("a name longer than 200 characters is not sent; one of exactly 200 is sent as typed", async () => {
    const long = await onReadBack(GO_LIVE, "typedName");
    const refused = await long.shell.shell.fetch(
      post(
        YES_PATH(long.shell),
        formPost(long.page, { decision: "yes", typedName: "S".repeat(201) }),
        long.cookie,
      ),
    );
    expect(refused.status).toBe(400);
    expect(long.shell.sent.map((one) => one.call)).toEqual(["answerOnPage"]);

    let typed: string | null = null;
    const shell = answerShell({
      requestIds: ["req-answer-made-in-test-0001", "req-yes-made-in-test-0002"],
      stubs: {
        answerOnPage: () => readBackFor("rb-dummy-sign-1", "typedName"),
        confirmOnPage: (request) => {
          typed = request.typedName;
          return committedFor(request);
        },
      },
    });
    const cookie = sessionCookie(shell.config, "dummy-session-token-0001");
    const form = await (await shell.shell.fetch(getWith(ANSWER_PATH(shell), cookie))).text();
    const page = await (
      await shell.shell.fetch(post(ANSWER_PATH(shell), formPost(form, { choice: "c-01" }), cookie))
    ).text();
    const name = `${"é".repeat(199)}a`;
    await shell.shell.fetch(
      post(YES_PATH(shell), formPost(page, { decision: "yes", typedName: name }), cookie),
    );
    expect(typed).toBe(name);
  });
});
