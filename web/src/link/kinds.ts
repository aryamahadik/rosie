// What each page a signed link opens is for, and each of its sections' names, in plain words (T-512; C-185; K-21 v1
// `$defs/pageKind` and `$defs/pageSection`). Before proof a link's page shows only these, with the business's public
// name: what the page is for and its sections' names, never their contents (K-21 v1 README "Links": "shows only what
// the page is for (pageKind, stepId, sections) and the business's public name"; S13-45). The step id is the server's
// own and is not shown.
//
// No source gives these words (D4 of the S1-10 ruling, DL-1125: Jay decides a page's wording, and a plain default stands
// meanwhile), so they are plain stand-ins. Each page type's own content comes with its own card (T-515, the journey
// lanes; S1-10's honest page is S10-8). Nothing here names a person or anything on file for one.

import type { ResponseOf } from "../client/calls";

/** K-21 v1 `openLink.response`: the page a link opens and what it may show now. */
export type LinkOpen = ResponseOf<"openLink">;

/** K-21 v1 `$defs/pageKind`: what a signed link opens in v1. */
export type PageKind = LinkOpen["pageKind"];

/** K-21 v1 `$defs/pageSection`: a section a link's page may have. */
export type PageSection = LinkOpen["sections"][number];

/** A page kind in plain words: the page's title and one line on what it is for. */
export interface PageKindWords {
  readonly title: string;
  readonly purpose: string;
}

/** Each page kind's words (K-21 v1 pageKind's description names what each one is). */
export const PAGE_KIND_WORDS: Readonly<Record<PageKind, PageKindWords>> = {
  // S1-10's secure page: the ID upload and the owner's email (MC C9, C10).
  setupIdCheck: {
    title: "Secure ID check",
    purpose: "This secure page is for the ID check in this business's setup with Rosie.",
  },
  // S1-77's owner link: the owner's own ID check, "Are you an owner of this business?", the email, the preview, the
  // fee and the Stripe account.
  ownerConfirm: {
    title: "Owner check",
    purpose: "This secure page is for confirming an owner of this business.",
  },
  // The owner's registration screens 0 to 24 (FS section 6.1).
  registration: {
    title: "Registration",
    purpose: "This secure page holds this business's registration with Rosie.",
  },
  // S2-06's secure page for a team member.
  staffPage: {
    title: "Staff page",
    purpose: "This secure page is a team member's own page for this business.",
  },
};

/** Each section's name (K-21 v1 pageSection's description names each one's source). */
export const SECTION_WORDS: Readonly<Record<PageSection, string>> = {
  idUpload: "Upload a photo of an ID document",
  ownerEmail: "The owner's email",
  confirmOwner: "Confirm an owner",
  preview: "How AI assistants see the business",
  feeConsent: "Rosfield's fee",
  stripe: "Connect Stripe for payments",
  billCard: "The card for Rosfield's bill",
  goLive: "Go live",
  registrationScreens: "Registration steps",
  profile: "Profile",
  license: "License",
  calendar: "Connect a calendar",
  emergencyContact: "Emergency contact",
};

/** True when `kind` is a page kind of K-21 v1, by its exact spelling. */
export function isPageKind(kind: string): kind is PageKind {
  return Object.hasOwn(PAGE_KIND_WORDS, kind);
}

/** True when `section` is a section of K-21 v1, by its exact spelling. */
export function isPageSection(section: string): section is PageSection {
  return Object.hasOwn(SECTION_WORDS, section);
}
