// What a signed link's page may show, from openLink's answer (T-512; C-185; K-21 v1 openLink; FS line 701; S13-45:
// "Opening a link never counts").
//
// A link names which page, which business and whose page, never who is at the browser (K-21 v1 README, "A link is never
// the proof"). So the page counts an answer as proof of a person only when both hold:
//   - the request carried a session: the session cookie's token, the one thing a browser holds that a server can bind to
//     a person (auth/cookies.ts sessionTokenOf); and
//   - the answer says that session is the link's own person's: proof session, with someone it acts for.
// Any other answer, including one that claims proof for a request that carried no session (K-21 v1
// invalid/refuse-link-as-proof.json, which the schema refuses but a page never takes on trust), is shown as a link
// without proof is: what the page is for, the business's public name, its sections' names and the sign-in for the
// link's own account, both ways (the sign-in page offers both, whatever the answer's signIn lists, so it hints at
// nothing on file).
//
// The view never holds whom the call acts for (the answer's acting.personId stays out of the page) and holds the link's
// end time only with proof (before proof no time is shown: K-21 v1 README "Links"). securePageOnly is true only with
// proof, so a page type's own reads (T-515, the journey lanes) ask for secure-page-only fields only then.

import { isPageKind, isPageSection, type LinkOpen, type PageKind, type PageSection } from "./kinds";

/** What a link's page may show. */
export interface LinkView {
  /** What the page is for (K-21 v1 pageKind). */
  readonly pageKind: PageKind;
  /** The step that sent the link, for a page type's own content to choose by; never shown as it is. */
  readonly stepId: string;
  /** The business's public name (FS rows B02, B01). */
  readonly businessName: string;
  /** The page's sections, by name only here: their contents come from the page type's own reads. */
  readonly sections: readonly PageSection[];
  /** True only when a session came with the request and the answer acts for the link's own person. */
  readonly proven: boolean;
  /** True only when proven and the answer lets the page's secure-page-only fields show. */
  readonly securePageOnly: boolean;
  /** When the link lapses (K-21 v1 expiresAt), only when proven; null otherwise. */
  readonly expiresAt: string | null;
}

/** An openLink answer the page cannot show. Its message names nothing from the request or the answer. */
export class LinkViewError extends Error {
  override name = "LinkViewError";
}

/**
 * The view of `open`, openLink's answer to a request that carried a session (`sentSession` true) or none (false). See
 * the top of this file. Throws LinkViewError for a page kind K-21 v1 does not hold; a section it does not hold is left
 * out, so nothing unknown is shown.
 */
export function linkViewOf(open: LinkOpen, sentSession: boolean): LinkView {
  if (!isPageKind(open.pageKind))
    throw new LinkViewError("openLink answered a page kind K-21 v1 does not hold");
  const proven = sentSession && open.proof === "session" && open.acting !== null;
  return {
    pageKind: open.pageKind,
    stepId: open.stepId,
    businessName: open.businessName,
    sections: open.sections.filter((section) => isPageSection(section)),
    proven,
    securePageOnly: proven && open.securePageOnly,
    expiresAt: proven ? open.expiresAt : null,
  };
}
