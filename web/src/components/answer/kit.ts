// The page answer kit (T-514; C-185; sign-up gate A3, DL-1186; K-21 v1 answerOnPage and confirmOnPage): answering a
// question through a page the same way as in the chat (question, option, fields), then the read-back, then the page's
// yes, an exact yes, with a typed name to sign where the read-back asks for one (02-contracts K-21; arch 03 line 183;
// FS line 630; arch 06 line 303; 01-inventory C-185).
//
// A page shell (T-515's secure page, the registration screens, the staff page) owns its routes and reads its own
// questions; the kit gives the three answers those routes make, each through the shell (shell/shell.ts), so the POST
// guards (the host, the origin, the body cap) have already run before any of them:
//   questionPage  GET of the question's page: its form (question-form.ts). Nothing is sent.
//   answer        POST of the answer form: the form read against the question the shell read (never the browser's),
//                 then answerOnPage, which writes nothing. Its read-back comes back as the read-back page with its yes
//                 (read-back.ts); any other answer comes back as the form again with what to fix, or a page that says
//                 why nothing was sent and the way back.
//   yes           POST of the read-back's yes form: confirmOnPage, sent only for the yes button's own value and only
//                 with the session, then a page that says it is saved, or why nothing was saved. readBackChanged gives
//                 the fresh read-back for a fresh yes (limit 4: arch 06 line 305).
// Leaving the read-back is a link back to the page, a GET that sends nothing: no path here sends confirmOnPage but the
// yes (the security reviewer's check: nothing commits without the exact yes).
//
// Who anyone is (K-21 v1 README, "No browser value says who anyone is"): the envelope carries this form's own request
// id, the page request's trace id, the session cookie's token and the signed link's code, nothing else. Without a
// session nothing is sent and the page asks for the sign-in of the link's own account (both calls need one: K-21 v1
// signedInPage). The server binds every answer and every yes to the session's person; the page never names a person, a
// business or a proof, and a typed name is a signature, never an identity claim.
//
// Accessible (RULES 4.11, 01-inventory C-185: WCAG 2.1 AA): each page has its heading, each control its label, a problem
// is announced (an alert, and a title starting "Error:"), and every page is a form or a link with no script, so it works
// by keyboard alone. The read-back is the review and the yes the confirmation before anything is saved (WCAG 3.3.4). The
// read-back's end time is the server's (K-21 README default 6: 10 minutes); the page says it up front, and after it the
// way back answers again for a fresh read-back. There is no CAPTCHA. No source gives these pages' words; they are plain stand-ins (D4 of the S1-10
// ruling, DL-1125: Jay decides a page's wording).

import { startHref } from "../../auth/pages";
import { sessionTokenOf } from "../../auth/cookies";
import { isPageError, type ErrorOf, type ResponseOf } from "../../client/calls";
import { escapeHtml } from "../../shell/frame";
import type { RouteContext, RoutePage } from "../../shell/route";
import { alertLine, linkTo, p } from "./html";
import {
  answerRequestOf,
  fieldsProblem,
  readAnswerForm,
  renderQuestionForm,
  type FormProblem,
  type PageQuestion,
} from "./question-form";
import {
  READ_BACK_WORDS,
  confirmRequestOf,
  readYesForm,
  renderReadBack,
  type ReadBackView,
} from "./read-back";

/** K-21 v1 answerOnPage's read-back (nothing written). */
export type AnswerReadBack = ResponseOf<"answerOnPage">;

/** K-21 v1 confirmOnPage's answer when the yes committed. */
export type AnswerCommitted = ResponseOf<"confirmOnPage">;

/** Where one question's page sits, as the page shell gives it for one request. */
export interface AnswerPage {
  /** The page's title and heading: the screen's own name. */
  readonly title: string;
  /** Where the answer form posts, under BASE_PATH. */
  readonly answerPath: string;
  /** Where the read-back's yes posts, under BASE_PATH. */
  readonly yesPath: string;
  /** Where leaving goes, under BASE_PATH: the page the question sits on, by GET, which sends nothing. */
  readonly backPath: string;
  /** The signed link the page was opened from, as the shell read it from its address, or null on the portal. */
  readonly linkCode: string | null;
}

/** What the kit takes from outside, replaceable in a test. */
export interface AnswerKitDeps {
  /** Makes a form's request id (K-21 v1 `page.requestId`: once per form, never reused); a random UUID when left out. */
  newRequestId?: () => string;
}

/** The kit's three answers (see the top of this file). */
export interface AnswerKit {
  /** The question's page, with its form. Sends nothing. */
  readonly questionPage: (context: RouteContext, page: AnswerPage, question: PageQuestion) => Response;
  /**
   * The answer form's POST, `form` as readPostedForm read it: answerOnPage for `question` (the question the shell read
   * for this request), with the upload ids the shell bound to this session (T-521), then the read-back or why not.
   */
  readonly answer: (
    context: RouteContext,
    page: AnswerPage,
    question: PageQuestion,
    form: URLSearchParams | null,
    uploadIds?: readonly string[],
  ) => Promise<Response>;
  /** The yes form's POST, `form` as readPostedForm read it: confirmOnPage only for the yes, then saved or why not. */
  readonly yes: (context: RouteContext, page: AnswerPage, form: URLSearchParams | null) => Promise<Response>;
}

/** The kit's pages' words: plain stand-ins (see the top of this file). */
export const KIT_WORDS = {
  /** The title's start on a page that says what went wrong. */
  errorTitle: "Error: ",
  signIn: {
    heading: "Sign in to answer",
    why: "Nothing was sent. Opening a link does not show who you are, so sign in first, then answer here.",
    link: "Sign in",
  },
  back: "Go back to the page",
  answerAgain: "Answer again",
  saved: { heading: "Saved", lines: ["Your yes is saved."] },
  notYes: {
    heading: "Nothing was saved",
    lines: ["You did not say yes, so nothing was saved."],
  },
  badYes: { heading: "Nothing was saved", lines: ["That form could not be read, so nothing was saved."] },
  nameMissing: {
    heading: "Your name is needed to sign",
    lines: [
      "This answer needs your name, typed, as your signature, and none came, so nothing was saved.",
      "Answer again to see it read back, then type your name and say yes.",
    ],
  },
  nameTooLong: {
    heading: "Your typed name is too long",
    lines: ["A typed name can be at most 200 characters, so nothing was saved. Answer again."],
  },
  expired: {
    heading: "That read-back has run out",
    lines: ["It was not saved. Answer again to see it read back."],
  },
  closed: {
    answered: "This question is already answered.",
    defaulted: "This question has closed with its default.",
    withdrawn: "This question was taken back.",
    heading: "This question is not open any more",
    after: "Nothing was sent.",
  },
  notAllowed: {
    heading: "This is not yours to answer here",
    notDecider: "Only the person who decides this can answer it.",
    unprovenSender: "This needs a code that proves it is you first.",
    wrongRole: "This step is for another role.",
    otherBusiness: "This page is another business's.",
    after: "Nothing was saved.",
  },
  safety: { heading: "Please read this first", after: "Nothing was booked or saved." },
  uploadMissing: {
    heading: "A file did not come through",
    lines: [
      "A file this answer carries did not arrive, so nothing was sent. Add it again, then answer again.",
    ],
  },
  paused: {
    heading: "Booking is paused just now",
    lines: ["Nothing was saved. Try again later."],
  },
  tryAgain: {
    heading: "That did not go through",
    lines: ["Nothing was changed. Try again in a moment."],
  },
  refused: {
    heading: "Nothing was saved",
    needsMissing: "Something this needs is not done yet, so nothing was saved.",
    notFound: "Something this names is no longer there, so nothing was saved.",
    versionChanged:
      "Something changed since you read it, so nothing was saved. Answer again to see what stands now.",
    constraint: "This could not be saved as it stands, so nothing was saved.",
  },
} as const;

const FORM_TYPE = "application/x-www-form-urlencoded";

/**
 * The form a page posted, or null when the body is not a form's (as auth/sign-in.ts reads one). The shell has already
 * held the body to its cap. A body is read once, so a page shell reads it here and hands it to the kit.
 */
export async function readPostedForm(request: Request): Promise<URLSearchParams | null> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  return type === FORM_TYPE ? new URLSearchParams(await request.text()) : null;
}

/** A page that says what happened: its heading, its lines (the first announced when it is a problem) and its links. */
function notePage(
  context: RouteContext,
  note: {
    heading: string;
    lines: readonly string[];
    links: readonly { path: string; words: string }[];
    status: number;
    problem: boolean;
  },
): RoutePage {
  const [first, ...rest] = note.lines;
  const main = [
    `<h1>${escapeHtml(note.heading)}</h1>`,
    ...(first === undefined ? [] : [note.problem ? alertLine(first) : p(first)]),
    ...rest.map(p),
    ...note.links.map((link) => linkTo(context.config, link.path, link.words)),
  ].join("\n");
  return {
    title: note.problem ? `${KIT_WORDS.errorTitle}${note.heading}` : note.heading,
    main,
    status: note.status,
  };
}

/** The answer kit, its request ids from `deps` (see the top of this file). */
export function answerKit(deps: AnswerKitDeps = {}): AnswerKit {
  const newRequestId = deps.newRequestId ?? ((): string => crypto.randomUUID());

  /** The question's page: its form, with a problem above it when there is one. */
  const formPage = (
    context: RouteContext,
    page: AnswerPage,
    question: PageQuestion,
    problem: FormProblem | null,
    chosen: string | null,
  ): RoutePage => ({
    title: problem === null ? page.title : `${KIT_WORDS.errorTitle}${page.title}`,
    main: [
      `<h1>${escapeHtml(page.title)}</h1>`,
      renderQuestionForm(context.config, {
        question,
        action: page.answerPath,
        requestId: newRequestId(),
        chosen,
        problem,
      }),
    ].join("\n"),
    forms: true,
    status: problem?.status ?? 200,
  });

  /** The read-back page with its yes form. */
  const readBackPage = (
    context: RouteContext,
    page: AnswerPage,
    readBack: ReadBackView,
    changed: boolean,
  ): RoutePage => ({
    title: changed
      ? `${KIT_WORDS.errorTitle}${READ_BACK_WORDS.heading}: ${page.title}`
      : `${READ_BACK_WORDS.heading}: ${page.title}`,
    main: [
      `<h1>${escapeHtml(READ_BACK_WORDS.heading)}</h1>`,
      p(page.title),
      renderReadBack(context.config, {
        readBack,
        action: page.yesPath,
        backPath: page.backPath,
        requestId: newRequestId(),
        changed,
      }),
    ].join("\n"),
    forms: true,
    status: changed ? 409 : 200,
  });

  /** The page that asks for the sign-in of the link's own account, with nothing sent. */
  const signInPage = (context: RouteContext, page: AnswerPage): RoutePage => {
    const words = KIT_WORDS.signIn;
    return {
      title: `${KIT_WORDS.errorTitle}${words.heading}`,
      main: [
        `<h1>${escapeHtml(words.heading)}</h1>`,
        alertLine(words.why),
        `<p><a href="${escapeHtml(startHref(context.config, page.linkCode))}">${escapeHtml(words.link)}</a></p>`,
      ].join("\n"),
      status: 403,
    };
  };

  const back = (page: AnswerPage): { path: string; words: string } => ({
    path: page.backPath,
    words: KIT_WORDS.back,
  });
  const again = (page: AnswerPage): { path: string; words: string } => ({
    path: page.backPath,
    words: KIT_WORDS.answerAgain,
  });

  /** A problem page with the way back. */
  const problemPage = (
    context: RouteContext,
    page: AnswerPage,
    note: { heading: string; lines: readonly string[] },
    status: number,
    link: "back" | "again" = "back",
  ): RoutePage =>
    notePage(context, {
      heading: note.heading,
      lines: note.lines,
      links: [link === "back" ? back(page) : again(page)],
      status,
      problem: true,
    });

  /** The page for one of answerOnPage's errors (nothing was written). */
  const answerErrorPage = (
    context: RouteContext,
    page: AnswerPage,
    question: PageQuestion,
    chosen: string | null,
    error: ErrorOf<"answerOnPage">,
  ): RoutePage => {
    switch (error.error) {
      case "signInNeeded":
        return signInPage(context, page);
      case "notAllowed":
        return problemPage(
          context,
          page,
          {
            heading: KIT_WORDS.notAllowed.heading,
            lines: [KIT_WORDS.notAllowed[error.why], KIT_WORDS.notAllowed.after],
          },
          403,
        );
      case "questionClosed":
        return problemPage(
          context,
          page,
          {
            heading: KIT_WORDS.closed.heading,
            lines: [KIT_WORDS.closed[error.state], KIT_WORDS.closed.after],
          },
          409,
        );
      case "fieldsInvalid":
        return formPage(context, page, question, fieldsProblem(question, error.fields), chosen);
      case "safetyFirst":
        // The checked line's words first, as the pinned bundle holds them, and nothing booked (arch 02 line 129).
        return notePage(context, {
          heading: KIT_WORDS.safety.heading,
          lines: [error.words, KIT_WORDS.safety.after],
          links: [back(page)],
          status: 200,
          problem: true,
        });
      case "uploadNotFound":
        return problemPage(context, page, KIT_WORDS.uploadMissing, 400);
      case "bookingPaused":
        return problemPage(context, page, KIT_WORDS.paused, 503);
      case "transient":
        return formPage(
          context,
          page,
          question,
          {
            words: `${KIT_WORDS.tryAgain.heading}. ${KIT_WORDS.tryAgain.lines.join(" ")}`,
            status: 503,
            marks: [],
          },
          chosen,
        );
    }
  };

  /** The page for one of confirmOnPage's errors (nothing was written). */
  const yesErrorPage = (
    context: RouteContext,
    page: AnswerPage,
    error: ErrorOf<"confirmOnPage">,
  ): RoutePage => {
    switch (error.error) {
      case "signInNeeded":
        return signInPage(context, page);
      case "readBackChanged":
        return readBackPage(context, page, error.readBack, true);
      case "readBackExpired":
        return problemPage(context, page, KIT_WORDS.expired, 409, "again");
      case "signatureNeeded":
        return problemPage(context, page, KIT_WORDS.nameMissing, 400, "again");
      case "notAllowed":
        return problemPage(
          context,
          page,
          {
            heading: KIT_WORDS.notAllowed.heading,
            lines: [KIT_WORDS.notAllowed[error.why], KIT_WORDS.notAllowed.after],
          },
          403,
        );
      case "needsMissing":
      case "notFound":
      case "versionChanged":
      case "constraint":
        return problemPage(
          context,
          page,
          { heading: KIT_WORDS.refused.heading, lines: [KIT_WORDS.refused[error.error]] },
          409,
          "again",
        );
      case "bookingPaused":
        return problemPage(context, page, KIT_WORDS.paused, 503);
      case "transient":
        return problemPage(context, page, KIT_WORDS.tryAgain, 503, "again");
    }
  };

  return {
    questionPage(context, page, question) {
      return context.page(formPage(context, page, question, null, null));
    },

    async answer(context, page, question, form, uploadIds = []) {
      const read = readAnswerForm(form, question);
      if (!read.ok) return context.page(formPage(context, page, question, read.problem, read.chosen));
      const sessionToken = sessionTokenOf(context.request, context.config);
      if (sessionToken === null) return context.page(signInPage(context, page));

      const { answer } = read;
      const outcome = await context.client.call(
        "answerOnPage",
        answerRequestOf(
          context.envelope({ requestId: answer.requestId, sessionToken, linkCode: page.linkCode }),
          question,
          answer,
          uploadIds,
        ),
      );
      if (isPageError(outcome))
        return context.page(answerErrorPage(context, page, question, answer.choiceId, outcome));
      return context.page(readBackPage(context, page, outcome, false));
    },

    async yes(context, page, form) {
      const read = readYesForm(form);
      if (!read.ok) {
        switch (read.why) {
          case "notYes":
            return context.page(problemPage(context, page, KIT_WORDS.notYes, 400));
          case "badForm":
            return context.page(problemPage(context, page, KIT_WORDS.badYes, 400, "again"));
          case "nameMissing":
            return context.page(problemPage(context, page, KIT_WORDS.nameMissing, 400, "again"));
          case "nameTooLong":
            return context.page(problemPage(context, page, KIT_WORDS.nameTooLong, 400, "again"));
        }
      }
      const sessionToken = sessionTokenOf(context.request, context.config);
      if (sessionToken === null) return context.page(signInPage(context, page));

      const outcome = await context.client.call(
        "confirmOnPage",
        confirmRequestOf(
          context.envelope({ requestId: read.yes.requestId, sessionToken, linkCode: page.linkCode }),
          read.yes,
        ),
      );
      if (isPageError(outcome)) return context.page(yesErrorPage(context, page, outcome));
      return context.page(
        notePage(context, {
          heading: KIT_WORDS.saved.heading,
          lines: KIT_WORDS.saved.lines,
          links: [back(page)],
          status: 200,
          problem: false,
        }),
      );
    },
  };
}
