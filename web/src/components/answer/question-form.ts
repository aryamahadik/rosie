// The answer form of the page answer kit (T-514; C-185; K-21 v1 answerOnPage; 02-contracts K-21: "answer through a page:
// the same as a chat answer (question, option, fields)"; arch 03 line 183). A question as a page shows it (K-21 v1
// `PageQuestion`: the card's question word for word, its options with their labels, the fields its answer carries and
// the uploads it may carry) becomes one form; the form posted becomes one answerOnPage request; nothing here writes.
//
// What the form is (RULES 4.11, 01-inventory C-185: WCAG 2.1 AA, no CAPTCHA):
//   - the options are radio buttons in a fieldset whose legend is the question's words, each with its own label, the
//     label the option's own words as the server gave them;
//   - each field is a text box with its own label (a yes-or-no field, or a field that names one of the options, is a
//     set of radio buttons in a fieldset of its own), with a hint where its kind has one and an autocomplete purpose
//     where the field is the person's own name, email or mobile (WCAG 1.3.5);
//   - one button sends it, and no script runs, so the form works by keyboard alone in any browser: Tab moves between
//     the groups and boxes, the arrow keys move inside a set of radio buttons, Enter or Space sends;
//   - a problem is said at the top in an alert with a link to each control it names (WCAG 3.3.1), each control it names
//     is marked invalid and described by its own message, and the page's title starts "Error:" (kit.ts);
//   - there is no CAPTCHA, no image to read and nothing timed on the form itself.
//
// What the request is (K-21 v1 answerOnPage.request): the question's own step and question id (from the question the
// page shell read, never from the browser), the option picked, which must be one of the question's own options, and
// each field of the question by its name with its words exactly as typed. A field left empty is left out (K-21 gives
// a field's words at least one character: a field the option needs then answers fieldsInvalid). A field the question
// does not hold is never sent. Upload ids come from the page shell (T-521), which binds them to this session.
//
// A field's typed words are never shown back: after a problem the form comes again with the server's own prefill and
// the option picked, as the sign-in pages show nothing typed back (auth/pages.ts). No source gives the form's words;
// they are plain stand-ins (D4 of the S1-10 ruling, DL-1125: Jay decides a page's wording).

import type { PageEnvelope, RequestOf, ResponseOf } from "../../client/calls";
import type { WebConfig } from "../../shell/config";
import { escapeHtml } from "../../shell/frame";
import { characterCount, formTo, hidden, p } from "./html";

/** A question as a page shows it (K-21 v1 `PageQuestion`), read off readRegistration's answer, never a generated name. */
export type PageQuestion = NonNullable<ResponseOf<"readRegistration">["screens"][number]["question"]>;

/** One field the question's answer carries, with the value the server gives to show (K-21 v1 `PageField`). */
export type PageField = PageQuestion["fields"][number];

/** A field's kind (K-01 v1 answerField.type). */
export type FieldType = PageField["field"]["type"];

/** K-21 v1 answerOnPage.request. */
export type AnswerRequest = RequestOf<"answerOnPage">;

/** One field's words as typed (K-21 v1 `PageFieldAnswer`). */
export type FieldAnswer = AnswerRequest["fields"][number];

/** A question the kit cannot show, or a page shell's mistake. Its message names nothing from a request or an answer. */
export class AnswerKitError extends Error {
  override name = "AnswerKitError";
}

/** The form's words: plain stand-ins (see the top of this file). */
export const FORM_WORDS = {
  /** The button that sends the answer; it saves nothing. */
  send: "Next: check your answer",
  /** Said under the button. */
  nothingYet: "Nothing is saved yet. Next you see your answer read back, and only your yes saves it.",
  /** The heading of the alert that lists what to fix. */
  problemHeading: "There is a problem",
  /** A form that did not arrive as the page sent it. */
  badForm: "That form could not be read, so nothing was sent. Answer again.",
  /** The question on the page is not the one the form answered. */
  changed:
    "The question on this page changed since you opened it, so nothing was sent. Answer it as it stands now.",
  /** No option was picked, or one the question does not hold. */
  pickOne: "Pick one of the options.",
  /** Said above the form when fields are named. */
  fixFields: "Nothing was sent. Check the answers named below.",
  /** A yes-or-no field's two options. */
  yes: "Yes",
  no: "No",
} as const;

/** The longest words one field may carry (K-21 v1 `PageFieldAnswer.words`). */
export const FIELD_WORDS_MAX = 10_000;

/** A field's name as an answer may carry it (K-21 v1 `PageFieldAnswer.name`). */
const FIELD_NAME = /^[a-z][a-z0-9_.]*$/;

/** A request id as a form may carry it back (as auth/sign-in.ts reads one). */
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** The words a field's kind is asked in, and said again when it does not parse (FORM_WORDS' stand-ins). */
const KIND_WORDS: Readonly<Record<FieldType, { readonly hint: string | null; readonly fix: string }>> = {
  text: { hint: null, fix: "Rosie could not read this. Type it again." },
  integer: { hint: "A whole number, like 2.", fix: "Type a whole number, like 2." },
  boolean: { hint: null, fix: "Pick yes or no." },
  money: {
    hint: "An amount in dollars, like 45 or 45.50.",
    fix: "Type an amount in dollars, like 45 or 45.50.",
  },
  time: { hint: "A day and a time, like Tuesday 3pm.", fix: "Type a day and a time, like Tuesday 3pm." },
  zone: { hint: "A time zone, like Eastern.", fix: "Type a time zone, like Eastern." },
  id: { hint: null, fix: "Rosie could not read this. Type it again." },
  choice: { hint: null, fix: "Pick one." },
};

/** The labels of the fields whose names a page knows; any other field's label is its own name in words. */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: "Your name",
  languages: "Languages you speak",
  email: "Email",
  mobile: "Mobile number",
};

/** The autocomplete purpose of a field that is the person's own (WCAG 1.3.5); none for any other. */
const AUTOCOMPLETE: Readonly<Record<string, string>> = { name: "name", email: "email", mobile: "tel" };

/** A field's label: FIELD_LABELS', else its name in words ("time_saved" reads "Time saved"). */
export function fieldLabel(name: string): string {
  const known = FIELD_LABELS[name];
  if (known !== undefined) return known;
  const words = name.replaceAll(/[_.]+/g, " ").trim();
  return words === "" ? name : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** The words that say a field of this kind did not parse. */
export function fieldFix(type: FieldType): string {
  return KIND_WORDS[type].fix;
}

/** Where a problem points: the question's options, or one field by its name. */
export type ProblemTarget = { readonly kind: "choice" } | { readonly kind: "field"; readonly name: string };

/** One control a problem names, with what to fix there. */
export interface ProblemMark {
  readonly target: ProblemTarget;
  readonly words: string;
}

/** What went wrong with an answer, said above the form, and the page's status. */
export interface FormProblem {
  readonly words: string;
  readonly status: number;
  readonly marks: readonly ProblemMark[];
}

/** The form as one page request shows it. */
export interface QuestionForm {
  readonly question: PageQuestion;
  /** Where the form posts, under BASE_PATH. */
  readonly action: string;
  /** This form's own request id (K-21 v1 `page.requestId`: made once per form, never reused). */
  readonly requestId: string;
  /** The option to show picked: one the question holds, or null. */
  readonly chosen: string | null;
  readonly problem: FormProblem | null;
}

const CHOICE_ID = "answer-choice";
const FIELD_ID = "answer-field";
const PROBLEM_ID = "answer-problem";

/** The id of a field's control (its first radio button for a set). */
function fieldId(name: string): string {
  return `${FIELD_ID}-${name}`;
}

/** The id the error summary links to for a target. */
function targetId(question: PageQuestion, target: ProblemTarget): string | null {
  if (target.kind === "choice") return question.options.length === 0 ? null : `${CHOICE_ID}-0`;
  const field = question.fields.find((shown) => shown.field.name === target.name);
  if (field === undefined) return null;
  return field.field.type === "boolean" || field.field.type === "choice"
    ? `${fieldId(target.name)}-0`
    : fieldId(target.name);
}

/** The words a problem says at one target, or null. */
function markAt(problem: FormProblem | null, target: ProblemTarget): string | null {
  const mark = problem?.marks.find(
    (one) =>
      one.target.kind === target.kind &&
      (one.target.kind === "choice" || (target.kind === "field" && one.target.name === target.name)),
  );
  return mark?.words ?? null;
}

/** The alert above the form: the problem's words, then a link to each control it names (WCAG 3.3.1). */
function problemSummary(question: PageQuestion, problem: FormProblem): string {
  const items = problem.marks.map((mark) => {
    const where = targetId(question, mark.target);
    const words =
      mark.target.kind === "field" ? `${fieldLabel(mark.target.name)}: ${mark.words}` : mark.words;
    return where === null
      ? `<li>${escapeHtml(words)}</li>`
      : `<li><a href="#${escapeHtml(where)}">${escapeHtml(words)}</a></li>`;
  });
  return [
    `<div role="alert" aria-labelledby="${PROBLEM_ID}-heading">`,
    `<h2 id="${PROBLEM_ID}-heading">${escapeHtml(FORM_WORDS.problemHeading)}</h2>`,
    p(problem.words),
    ...(items.length === 0 ? [] : ["<ul>", ...items, "</ul>"]),
    "</div>",
  ].join("\n");
}

/** A control's error message, its id for aria-describedby, or nothing. */
function errorLine(id: string, words: string | null): string[] {
  return words === null ? [] : [`<span id="${escapeHtml(id)}">${escapeHtml(`Error: ${words}`)}</span><br>`];
}

/** aria-describedby and aria-invalid for a control, from the ids that describe it. */
function described(ids: readonly string[], invalid: boolean): string {
  return [
    ...(ids.length === 0 ? [] : [` aria-describedby="${escapeHtml(ids.join(" "))}"`]),
    ...(invalid ? [' aria-invalid="true"'] : []),
  ].join("");
}

/** One radio button with its label after it, in a paragraph of its own. */
function radio(
  id: string,
  name: string,
  value: string,
  label: string,
  flags: { checked: boolean; required: boolean },
): string {
  return [
    `<p><input type="radio" id="${escapeHtml(id)}" name="${escapeHtml(name)}" value="${escapeHtml(value)}"`,
    flags.required ? " required" : "",
    flags.checked ? " checked" : "",
    `> <label for="${escapeHtml(id)}">${escapeHtml(label)}</label></p>`,
  ].join("");
}

/** The question's options: radio buttons in a fieldset whose legend is the question's words. */
function optionsGroup(form: QuestionForm): string {
  const { question } = form;
  const words = markAt(form.problem, { kind: "choice" });
  const errorId = `${CHOICE_ID}-error`;
  const chosen = question.options.some((option) => option.choiceId === form.chosen) ? form.chosen : null;
  return [
    `<fieldset${described(words === null ? [] : [errorId], false)}>`,
    `<legend>${escapeHtml(question.words)}</legend>`,
    ...(words === null ? [] : [`<p id="${errorId}">${escapeHtml(`Error: ${words}`)}</p>`]),
    ...question.options.map((option, k) =>
      radio(`${CHOICE_ID}-${String(k)}`, "choice", option.choiceId, option.label, {
        checked: option.choiceId === chosen,
        required: true,
      }),
    ),
    "</fieldset>",
  ].join("\n");
}

/** A field that is a set of radio buttons: yes or no, or one of the question's options. */
function radioField(form: QuestionForm, shown: PageField): string {
  const { name, type } = shown.field;
  const id = fieldId(name);
  const words = markAt(form.problem, { kind: "field", name });
  const choices =
    type === "boolean"
      ? [
          { value: "yes", label: FORM_WORDS.yes },
          { value: "no", label: FORM_WORDS.no },
        ]
      : form.question.options.map((option) => ({ value: option.choiceId, label: option.label }));
  return [
    `<fieldset${described(words === null ? [] : [`${id}-error`], false)}>`,
    `<legend>${escapeHtml(fieldLabel(name))}</legend>`,
    ...(words === null ? [] : [`<p id="${escapeHtml(`${id}-error`)}">${escapeHtml(`Error: ${words}`)}</p>`]),
    ...choices.map((choice, k) =>
      radio(`${id}-${String(k)}`, `field.${name}`, choice.value, choice.label, {
        checked: shown.prefill !== null && shown.prefill.toLowerCase() === choice.value.toLowerCase(),
        required: false,
      }),
    ),
    "</fieldset>",
  ].join("\n");
}

/** A field that is a text box: its label, its hint, its error and the box. */
function textField(form: QuestionForm, shown: PageField): string {
  const { name, type } = shown.field;
  const id = fieldId(name);
  const hint = KIND_WORDS[type].hint;
  const words = markAt(form.problem, { kind: "field", name });
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const inputmode = type === "integer" ? "numeric" : type === "money" ? "decimal" : null;
  const autocomplete = AUTOCOMPLETE[name] ?? null;
  return [
    `<p><label for="${escapeHtml(id)}">${escapeHtml(fieldLabel(name))}</label><br>`,
    ...(hint === null ? [] : [`<span id="${escapeHtml(hintId)}">${escapeHtml(hint)}</span><br>`]),
    ...errorLine(errorId, words),
    [
      `<input type="text" id="${escapeHtml(id)}" name="${escapeHtml(`field.${name}`)}"`,
      shown.prefill === null ? "" : ` value="${escapeHtml(shown.prefill)}"`,
      ` maxlength="${String(FIELD_WORDS_MAX)}"`,
      inputmode === null ? "" : ` inputmode="${inputmode}"`,
      autocomplete === null ? "" : ` autocomplete="${autocomplete}"`,
      described([...(hint === null ? [] : [hintId]), ...(words === null ? [] : [errorId])], words !== null),
      "></p>",
    ].join(""),
  ].join("\n");
}

function fieldControl(form: QuestionForm, shown: PageField): string {
  return shown.field.type === "boolean" || shown.field.type === "choice"
    ? radioField(form, shown)
    : textField(form, shown);
}

/** Throws AnswerKitError for a question no answer could carry back. */
function checkQuestion(question: PageQuestion): void {
  const names = new Set<string>();
  for (const shown of question.fields) {
    if (!FIELD_NAME.test(shown.field.name))
      throw new AnswerKitError(
        "a field's name is not one an answer can carry (K-21 v1 PageFieldAnswer.name)",
      );
    if (names.has(shown.field.name)) throw new AnswerKitError("the question names one field twice");
    names.add(shown.field.name);
    if (shown.field.type === "choice" && question.options.length === 0)
      throw new AnswerKitError("a field names one of the question's options, and the question has none");
  }
}

/**
 * The answer form for `form.question` (see the top of this file): the problem's alert when there is one, then the form
 * that posts to `form.action` under BASE_PATH. Throws AnswerKitError for a question no answer could carry back (a
 * field's name an answer cannot carry, one name twice, a field naming options the question does not have).
 */
export function renderQuestionForm(config: WebConfig, form: QuestionForm): string {
  const { question } = form;
  checkQuestion(question);
  const fields = question.fields.map((shown) => fieldControl(form, shown));
  const body =
    question.options.length > 0
      ? [optionsGroup(form), ...fields]
      : fields.length > 0
        ? ["<fieldset>", `<legend>${escapeHtml(question.words)}</legend>`, ...fields, "</fieldset>"]
        : [p(question.words)];
  return [
    ...(form.problem === null ? [] : [problemSummary(question, form.problem)]),
    formTo(config, form.action),
    hidden("requestId", form.requestId),
    hidden("step", question.stepId),
    hidden("question", question.questionId ?? ""),
    ...body,
    `<p><button type="submit">${escapeHtml(FORM_WORDS.send)}</button></p>`,
    "</form>",
    p(FORM_WORDS.nothingYet),
  ].join("\n");
}

/** Which question a posted form says it answered: its step and question id, as the form carried them. */
export interface PostedQuestion {
  readonly stepId: string;
  /** The open question's id, or null for a page step's own form. */
  readonly questionId: string | null;
}

/**
 * The step and question a posted answer form names, for a page shell to find the question it answered (by its own
 * read, never trusting the form); null when the form names none. The kit checks them against that question again.
 */
export function postedQuestionOf(form: URLSearchParams): PostedQuestion | null {
  const stepId = form.get("step");
  const questionId = form.get("question");
  if (stepId === null || stepId === "" || questionId === null) return null;
  return { stepId, questionId: questionId === "" ? null : questionId };
}

/** An answer read from a posted form, ready to send. */
export interface ReadAnswer {
  readonly requestId: string;
  readonly choiceId: string | null;
  readonly fields: readonly FieldAnswer[];
}

/** What a posted answer form gives: the answer, or the problem to show with the option to keep picked. */
export type AnswerFormResult =
  | { readonly ok: true; readonly answer: ReadAnswer }
  | { readonly ok: false; readonly problem: FormProblem; readonly chosen: string | null };

/**
 * The answer a posted form gives for `question` (see the top of this file), or the problem to show again with nothing
 * sent: a form that is not the page's own (400), a question that is no longer the page's (409), no option or one the
 * question does not hold (400), or words longer than a field may carry (400).
 */
export function readAnswerForm(form: URLSearchParams | null, question: PageQuestion): AnswerFormResult {
  const bad = (words: string, status: number, marks: readonly ProblemMark[] = []): AnswerFormResult => ({
    ok: false,
    problem: { words, status, marks },
    chosen: null,
  });
  if (form === null) return bad(FORM_WORDS.badForm, 400);
  const requestId = form.get("requestId") ?? "";
  if (!REQUEST_ID.test(requestId)) return bad(FORM_WORDS.badForm, 400);
  const posted = postedQuestionOf(form);
  if (posted === null) return bad(FORM_WORDS.badForm, 400);
  if (posted.stepId !== question.stepId || posted.questionId !== question.questionId)
    return bad(FORM_WORDS.changed, 409);

  const marks: ProblemMark[] = [];
  let choiceId: string | null = null;
  if (question.options.length > 0) {
    const picked = form.get("choice");
    choiceId = question.options.some((option) => option.choiceId === picked) ? picked : null;
    if (choiceId === null) marks.push({ target: { kind: "choice" }, words: FORM_WORDS.pickOne });
  }

  const fields: FieldAnswer[] = [];
  for (const shown of question.fields) {
    const { name } = shown.field;
    const words = form.get(`field.${name}`);
    if (words === null || words.trim() === "") continue;
    if (characterCount(words) > FIELD_WORDS_MAX) {
      marks.push({
        target: { kind: "field", name },
        words: `This is longer than ${String(FIELD_WORDS_MAX)} characters. Make it shorter.`,
      });
      continue;
    }
    fields.push({ name, words });
  }

  if (marks.length > 0)
    return { ok: false, problem: { words: FORM_WORDS.fixFields, status: 400, marks }, chosen: choiceId };
  return { ok: true, answer: { requestId, choiceId, fields } };
}

/**
 * The answerOnPage request for `answer` to `question`: the question's own step and question id, the option, each
 * field's words as typed, and the uploads the page shell gives (T-521), under `page`, the envelope of a signed-in page.
 */
export function answerRequestOf(
  page: PageEnvelope<string>,
  question: PageQuestion,
  answer: ReadAnswer,
  uploadIds: readonly string[] = [],
): AnswerRequest {
  return {
    page,
    stepId: question.stepId,
    questionId: question.questionId,
    choiceId: answer.choiceId,
    fields: answer.fields.map((field) => ({ name: field.name, words: field.words })),
    uploadIds: [...uploadIds],
  };
}

/** The problem fieldsInvalid's named fields give: each the question holds marked at its control, any other listed. */
export function fieldsProblem(question: PageQuestion, names: readonly string[]): FormProblem {
  const marks = names.map((name): ProblemMark => {
    const shown = question.fields.find((field) => field.field.name === name);
    return { target: { kind: "field", name }, words: fieldFix(shown?.field.type ?? "text") };
  });
  return { words: FORM_WORDS.fixFields, status: 400, marks };
}
