// T-514: the page answer kit's parts on their own, as a page shell (T-515, T-521) uses them: the form a question gives,
// the answer a posted form gives, the request built from it, the yes a posted yes form gives, and the request built
// from that. The flows on the shell are kit.test.ts's.
//
// Every value is a fixture's own placeholder or made up (rule 9).
import { describe, expect, it } from "vitest";
import { readWebConfig } from "../../shell/config";
import { testVars } from "../../shell/test-support";
import { characterCount, linesOf } from "./html";
import {
  AnswerKitError,
  answerRequestOf,
  fieldLabel,
  fieldsProblem,
  postedQuestionOf,
  readAnswerForm,
  renderQuestionForm,
  type PageQuestion,
} from "./question-form";
import { confirmRequestOf, readYesForm, renderReadBack } from "./read-back";
import { EVERY_KIND_QUESTION, S2_22_QUESTION, tagsOf, visibleText } from "./test-support";

const CONFIG = readWebConfig(testVars("staging"));

const ENVELOPE = {
  requestId: "req-dummy-0001",
  traceId: "4f1c2b7a-9d3e-4c5f-8a6b-1e2d3c4b5a69",
  sessionToken: "dummy-session-token-0001",
  linkCode: "dummy-link-code-0001",
};

/** A form as a browser posts S2-22's: its hidden fields and `values`. */
function s222Form(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams({
    requestId: "req-dummy-0001",
    step: "S2-22",
    question: "oq-s2-22-sam",
    ...values,
  });
}

describe("renderQuestionForm", () => {
  it("a question with no options and no fields shows its words and the button, and nothing else to fill in", () => {
    const question: PageQuestion = { ...S2_22_QUESTION, options: [], fields: [] };
    const html = renderQuestionForm(CONFIG, {
      question,
      action: "/dummy/answer",
      requestId: "req-dummy-0001",
      chosen: null,
      problem: null,
    });
    expect(html).toContain(`<p>${S2_22_QUESTION.words}</p>`);
    expect(tagsOf(html, "input").filter((tag) => tag.attributes.type !== "hidden")).toEqual([]);
    expect(tagsOf(html, "button")).toHaveLength(1);
    expect(tagsOf(html, "form")[0]?.attributes.action).toBe("/test/dummy/answer");
  });

  it("shows the option given as chosen picked, and none for an option the question does not hold", () => {
    const form = { question: S2_22_QUESTION, action: "/a", requestId: "req-dummy-0001", problem: null };
    const picked = (html: string) =>
      tagsOf(html, "input")
        .filter((tag) => "checked" in tag.attributes)
        .map((tag) => tag.attributes.value);
    expect(picked(renderQuestionForm(CONFIG, { ...form, chosen: "c-02" }))).toEqual(["c-02"]);
    expect(picked(renderQuestionForm(CONFIG, { ...form, chosen: "c-99" }))).toEqual([]);
  });

  it("escapes every word the server gave: the question, an option's label and a prefill", () => {
    const question: PageQuestion = {
      ...S2_22_QUESTION,
      words: 'Made-up <b>"question"</b> & more?',
      options: [{ choiceId: 'c-"01"', label: "1 <i>Made-up</i>" }],
      fields: [{ field: { name: "name", type: "text" }, prefill: '"><script>x</script>' }],
    };
    const html = renderQuestionForm(CONFIG, {
      question,
      action: "/a",
      requestId: "req-dummy-0001",
      chosen: null,
      problem: null,
    });
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;&quot;question&quot;&lt;/b&gt; &amp; more?");
    expect(tagsOf(html, "input").find((tag) => tag.attributes.type === "radio")?.attributes.value).toBe(
      'c-"01"',
    );
  });

  it("refuses a question no answer could carry back: a field's name an answer cannot carry, one name twice, a choice field with no options", () => {
    const form = { action: "/a", requestId: "req-dummy-0001", chosen: null, problem: null };
    const bad: PageQuestion[] = [
      { ...S2_22_QUESTION, fields: [{ field: { name: "Bad Name", type: "text" }, prefill: null }] },
      {
        ...S2_22_QUESTION,
        fields: [
          { field: { name: "name", type: "text" }, prefill: null },
          { field: { name: "name", type: "integer" }, prefill: null },
        ],
      },
      {
        ...S2_22_QUESTION,
        options: [],
        fields: [{ field: { name: "which", type: "choice" }, prefill: null }],
      },
    ];
    for (const question of bad)
      expect(() => renderQuestionForm(CONFIG, { ...form, question })).toThrow(AnswerKitError);
  });

  it("a yes-or-no field shows its prefill picked", () => {
    const question: PageQuestion = {
      ...S2_22_QUESTION,
      fields: [{ field: { name: "kept", type: "boolean" }, prefill: "Yes" }],
    };
    const html = renderQuestionForm(CONFIG, {
      question,
      action: "/a",
      requestId: "req-dummy-0001",
      chosen: null,
      problem: null,
    });
    const kept = tagsOf(html, "input").filter((tag) => tag.attributes.name === "field.kept");
    expect(kept.map((tag) => "checked" in tag.attributes)).toEqual([true, false]);
  });
});

describe("readAnswerForm and answerRequestOf", () => {
  it("reads the option and each field by its name, exactly as typed, and builds the request from the question's own ids", () => {
    const form = new URLSearchParams({
      requestId: "req-dummy-0001",
      step: EVERY_KIND_QUESTION.stepId,
      question: EVERY_KIND_QUESTION.questionId ?? "",
      choice: "c-02",
      "field.visits": " 2 ",
      "field.kept": "no",
      "field.which": "c-01",
      "field.price": "",
      "field.unknown": "never sent",
    });
    const read = readAnswerForm(form, EVERY_KIND_QUESTION);
    if (!read.ok) throw new Error("the form did not read");
    expect(answerRequestOf(ENVELOPE, EVERY_KIND_QUESTION, read.answer, ["upload-dummy-0001"])).toEqual({
      page: ENVELOPE,
      stepId: "S1-12",
      questionId: "oq-dummy-0001",
      choiceId: "c-02",
      fields: [
        { name: "visits", words: " 2 " },
        { name: "kept", words: "no" },
        { name: "which", words: "c-01" },
      ],
      uploadIds: ["upload-dummy-0001"],
    });
  });

  it("a page step's own form names no question: the request's question id is null", () => {
    const question: PageQuestion = { ...EVERY_KIND_QUESTION, questionId: null, options: [] };
    const form = new URLSearchParams({ requestId: "req-dummy-0001", step: "S1-12", question: "" });
    const read = readAnswerForm(form, { ...question, fields: [] });
    if (!read.ok) throw new Error("the form did not read");
    expect(answerRequestOf(ENVELOPE, question, read.answer)).toMatchObject({
      questionId: null,
      choiceId: null,
    });
  });

  it("words longer than a field may carry are not sent, and the field is named", () => {
    const question: PageQuestion = {
      ...S2_22_QUESTION,
      fields: [{ field: { name: "name", type: "text" }, prefill: null }],
    };
    const read = readAnswerForm(s222Form({ choice: "c-01", "field.name": "x".repeat(10_001) }), question);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem.status).toBe(400);
    expect(read.problem.marks).toEqual([
      {
        target: { kind: "field", name: "name" },
        words: "This is longer than 10000 characters. Make it shorter.",
      },
    ]);
    expect(read.chosen).toBe("c-01");
    expect(readAnswerForm(s222Form({ choice: "c-01", "field.name": "é".repeat(10_000) }), question).ok).toBe(
      true,
    );
  });

  it("a form that is not the page's own, or names another question, gives no answer", () => {
    expect(readAnswerForm(null, S2_22_QUESTION)).toMatchObject({ ok: false, problem: { status: 400 } });
    expect(readAnswerForm(s222Form({ requestId: "x" }), S2_22_QUESTION)).toMatchObject({ ok: false });
    expect(readAnswerForm(s222Form({ step: "S2-21", choice: "c-01" }), S2_22_QUESTION)).toMatchObject({
      ok: false,
      problem: { status: 409 },
    });
  });

  it("postedQuestionOf gives the step and question a posted form names, for a page shell to find its question", () => {
    expect(postedQuestionOf(s222Form({}))).toEqual({ stepId: "S2-22", questionId: "oq-s2-22-sam" });
    expect(postedQuestionOf(s222Form({ question: "" }))).toEqual({ stepId: "S2-22", questionId: null });
    expect(postedQuestionOf(new URLSearchParams({ question: "oq-s2-22-sam" }))).toBeNull();
  });

  it("fieldsProblem marks each field by its kind's words, and lists a field the question lacks under its name in words", () => {
    expect(fieldsProblem(EVERY_KIND_QUESTION, ["price", "not_here"]).marks).toEqual([
      { target: { kind: "field", name: "price" }, words: "Type an amount in dollars, like 45 or 45.50." },
      { target: { kind: "field", name: "not_here" }, words: "Rosie could not read this. Type it again." },
    ]);
    expect(fieldLabel("not_here")).toBe("Not here");
    expect(fieldLabel("place.id")).toBe("Place id");
    expect(fieldLabel("name")).toBe("Your name");
  });
});

describe("renderReadBack, readYesForm and confirmRequestOf", () => {
  const readBack = {
    readBackId: "rb-dummy-0001",
    words: "Made-up <words>\nand a second line",
    signature: "typedName" as const,
    expiresAt: "2026-10-21T13:11:00Z",
  };

  it("shows the words escaped, line for line, and a yes form that carries the read-back's id and asks the typed name", () => {
    const html = renderReadBack(CONFIG, {
      readBack,
      action: "/a/yes",
      backPath: "/a",
      requestId: "req-dummy-0002",
      changed: false,
    });
    expect(html).toContain("<blockquote><p>Made-up &lt;words&gt;<br>and a second line</p></blockquote>");
    expect(tagsOf(html, "form")[0]?.attributes.action).toBe("/test/a/yes");
    expect(tagsOf(html, "a")[0]?.attributes.href).toBe("/test/a");
    expect(visibleText(html)).toContain("Going back saves nothing.");
    expect(linesOf("a\r\nb\rc")).toBe("a<br>b<br>c");
  });

  it("a yes is only the yes button's own value; the typed name is taken only where the form says the read-back asks it", () => {
    const base = { requestId: "req-dummy-0002", readBack: "rb-dummy-0001" };
    expect(readYesForm(new URLSearchParams({ ...base, decision: "yes" }))).toEqual({
      ok: true,
      yes: { requestId: "req-dummy-0002", readBackId: "rb-dummy-0001", typedName: null },
    });
    expect(
      readYesForm(new URLSearchParams({ ...base, decision: "yes", typedName: "Sam Lee" })),
    ).toMatchObject({
      ok: true,
      yes: { typedName: null },
    });
    expect(
      readYesForm(
        new URLSearchParams({ ...base, decision: "yes", sign: "typedName", typedName: " Sam Lee " }),
      ),
    ).toMatchObject({ ok: true, yes: { typedName: " Sam Lee " } });
    expect(readYesForm(new URLSearchParams({ ...base, sign: "typedName", typedName: "Sam Lee" }))).toEqual({
      ok: false,
      why: "notYes",
    });
    expect(readYesForm(null)).toEqual({ ok: false, why: "badForm" });
    expect(readYesForm(new URLSearchParams({ ...base, decision: "yes", sign: "typedName" }))).toEqual({
      ok: false,
      why: "nameMissing",
    });
    expect(
      readYesForm(
        new URLSearchParams({ ...base, decision: "yes", sign: "typedName", typedName: "x".repeat(201) }),
      ),
    ).toEqual({ ok: false, why: "nameTooLong" });
  });

  it("the confirming request carries the read-back's id and the typed name alone, under the page's envelope", () => {
    expect(
      confirmRequestOf(ENVELOPE, {
        requestId: "req-dummy-0002",
        readBackId: "rb-dummy-0001",
        typedName: "Sam Lee",
      }),
    ).toEqual({ page: ENVELOPE, readBackId: "rb-dummy-0001", typedName: "Sam Lee" });
  });

  it("characters are counted as the schema counts them: code points, not UTF-16 units", () => {
    expect(characterCount("\u{1F600}".repeat(200))).toBe(200);
    expect(characterCount("Sam Lee")).toBe(7);
  });
});
