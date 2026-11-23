// The read-back and the page's yes, in the page answer kit (T-514; C-185; K-21 v1 answerOnPage's read-back and
// confirmOnPage; FS line 630: "every change is read back and confirmed first"; arch 06 line 303, limit 3: the exact yes
// is the decider's own "yes on the secure page ... bound to the read-back's exact text and versions").
//
// The read-back page shows the read-back's exact words, as the server gave them, word for word and line for line, and
// when it lapses. Under them is the one form that can save anything: a yes button. Beside it is a link back to the page,
// which is a GET and sends nothing, so leaving the read-back without the yes saves nothing (and the question stays open
// for the chat, as in the chat when no yes comes).
//
// The yes form carries only what confirmOnPage takes (K-21 v1 confirmOnPage.request): its own request id, the read-back's
// id, and, where the read-back asks for one (signature typedName), the person's name as they type it, which is their
// signature (01-inventory C-185: "a typed name signs"; S1-72's agreement). The words and versions the yes is bound to
// stay on the server under the read-back's id, so nothing of the read-back can change between the two calls, and
// nothing on the form says who anyone is (K-21 v1 README, "No browser value says who anyone is"): the server binds the
// yes to the session's person, and a typed name is a signature, never a claim of who is at the browser.
//
// readYesForm gives a yes only for the yes button's own value: any other post (no button, another value, a form that is
// not this page's) gives no yes, and the kit then sends nothing (kit.ts). The typed name is taken only when the form
// says the read-back asked for one; without that, a name posted is never sent. The read-back page is any read-back of
// K-21's shape (v1's answerOnPage and readBackChanged, and the later minor versions' read-backs), so a page shell can
// show its own with it. No source gives these words; they are plain stand-ins (D4 of the S1-10 ruling, DL-1125).

import type { PageEnvelope, RequestOf } from "../../client/calls";
import type { WebConfig } from "../../shell/config";
import { escapeHtml } from "../../shell/frame";
import { alertLine, characterCount, formTo, hidden, linesOf, linkTo, p, timeTag } from "./html";

/** K-21 v1 confirmOnPage.request. */
export type ConfirmRequest = RequestOf<"confirmOnPage">;

/** What a read-back page shows of a K-21 read-back: its id, its exact words, whether the yes signs, and its end. */
export interface ReadBackView {
  readonly readBackId: string;
  /** The exact words, as the server gave them (K-21 v1 read-back words). */
  readonly words: string;
  /** none: the yes alone; typedName: the yes also takes the person's typed name as their signature. */
  readonly signature: "none" | "typedName";
  /** When the read-back lapses unconfirmed (K-21 v1 expiresAt; README default 6: 10 minutes). */
  readonly expiresAt: string;
}

/** The read-back page's words: plain stand-ins (see the top of this file). */
export const READ_BACK_WORDS = {
  heading: "Check your answer",
  intro: "This is what your answer saves, word for word. Nothing is saved until you say yes.",
  /** Before the read-back's end time. */
  until: "Say yes by ",
  untilAfter: ". After that, answer again.",
  /** Said when a row the read-back showed changed, and this is the fresh one. */
  changed:
    "Something changed since you read it, so nothing was saved. This is what stands now. Say yes only if it is right.",
  signLabel: "Type your full name to sign",
  signHint: "Typing your name here is your signature on the words above.",
  yes: "Yes, save this",
  leave: "No, go back without saving",
  leaveNote: "Going back saves nothing.",
} as const;

/** The yes button's name and its one value: only this value is a yes. */
export const YES_FIELD = "decision";
export const YES_VALUE = "yes";

/** The hidden field that says the read-back asked for a typed name, and the typed name's own field. */
const SIGN_FIELD = "sign";
const TYPED_NAME_FIELD = "typedName";

/** The longest typed name (K-21 v1 confirmOnPage.request.typedName), in characters. */
export const TYPED_NAME_MAX = 200;

/** A request id as a form may carry it back (as auth/sign-in.ts reads one). */
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
/** A read-back id as a form may carry it back: K-21's ids are opaque, so any visible characters, held to a length. */
const READ_BACK_ID = /^[\x21-\x7E]{1,256}$/;

const TYPED_NAME_ID = "answer-typed-name";

/** The read-back page's yes form as one page request shows it. */
export interface ReadBackForm {
  readonly readBack: ReadBackView;
  /** Where the yes posts, under BASE_PATH. */
  readonly action: string;
  /** Where leaving goes, under BASE_PATH: the page again, by GET. */
  readonly backPath: string;
  /** This form's own request id (K-21 v1 `page.requestId`: made once per form, never reused). */
  readonly requestId: string;
  /** True when this is the fresh read-back of a readBackChanged answer. */
  readonly changed: boolean;
}

/**
 * The read-back and its yes (see the top of this file): the read-back's exact words, when it lapses, the yes form with
 * the typed name to sign where the read-back asks for one, and the link back that saves nothing.
 */
export function renderReadBack(config: WebConfig, form: ReadBackForm): string {
  const { readBack } = form;
  const until = timeTag(readBack.expiresAt);
  const signs = readBack.signature === "typedName";
  return [
    ...(form.changed ? [alertLine(READ_BACK_WORDS.changed)] : []),
    p(READ_BACK_WORDS.intro),
    `<blockquote><p>${linesOf(readBack.words)}</p></blockquote>`,
    ...(until === null
      ? []
      : [`<p>${escapeHtml(READ_BACK_WORDS.until)}${until}${escapeHtml(READ_BACK_WORDS.untilAfter)}</p>`]),
    formTo(config, form.action),
    hidden("requestId", form.requestId),
    hidden("readBack", readBack.readBackId),
    ...(signs
      ? [
          hidden(SIGN_FIELD, "typedName"),
          `<p><label for="${TYPED_NAME_ID}">${escapeHtml(READ_BACK_WORDS.signLabel)}</label><br>`,
          `<span id="${TYPED_NAME_ID}-hint">${escapeHtml(READ_BACK_WORDS.signHint)}</span><br>`,
          `<input type="text" id="${TYPED_NAME_ID}" name="${TYPED_NAME_FIELD}" autocomplete="name" maxlength="${String(TYPED_NAME_MAX)}" required aria-describedby="${TYPED_NAME_ID}-hint"></p>`,
        ]
      : []),
    `<p><button type="submit" name="${YES_FIELD}" value="${YES_VALUE}">${escapeHtml(READ_BACK_WORDS.yes)}</button></p>`,
    "</form>",
    linkTo(config, form.backPath, READ_BACK_WORDS.leave),
    p(READ_BACK_WORDS.leaveNote),
  ].join("\n");
}

/** A yes read from the yes form, ready to send. */
export interface ReadYes {
  readonly requestId: string;
  readonly readBackId: string;
  /** The typed name, exactly as typed, where the read-back asked for one; else null. */
  readonly typedName: string | null;
}

/** Why a posted yes form gives no yes: no yes, a form that is not this page's, or a typed name missing or too long. */
export type NoYes = "notYes" | "badForm" | "nameMissing" | "nameTooLong";

/** What a posted yes form gives. */
export type YesFormResult =
  { readonly ok: true; readonly yes: ReadYes } | { readonly ok: false; readonly why: NoYes };

/**
 * The yes a posted yes form gives (see the top of this file), or why it gives none. Only the yes button's own value is
 * a yes. The typed name is taken where the form says the read-back asked for one, exactly as typed, and must hold more
 * than spaces and at most TYPED_NAME_MAX characters; without that, no name is taken.
 */
export function readYesForm(form: URLSearchParams | null): YesFormResult {
  if (form?.get(YES_FIELD) !== YES_VALUE) return { ok: false, why: form === null ? "badForm" : "notYes" };
  const requestId = form.get("requestId") ?? "";
  const readBackId = form.get("readBack") ?? "";
  if (!REQUEST_ID.test(requestId) || !READ_BACK_ID.test(readBackId)) return { ok: false, why: "badForm" };
  const sign = form.get(SIGN_FIELD);
  if (sign === null) return { ok: true, yes: { requestId, readBackId, typedName: null } };
  if (sign !== "typedName") return { ok: false, why: "badForm" };
  const typedName = form.get(TYPED_NAME_FIELD) ?? "";
  if (typedName.trim() === "") return { ok: false, why: "nameMissing" };
  if (characterCount(typedName) > TYPED_NAME_MAX) return { ok: false, why: "nameTooLong" };
  return { ok: true, yes: { requestId, readBackId, typedName } };
}

/** The confirmOnPage request for `yes`, under `page`, the envelope of a signed-in page. */
export function confirmRequestOf(page: PageEnvelope<string>, yes: ReadYes): ConfirmRequest {
  return { page, readBackId: yes.readBackId, typedName: yes.typedName };
}
