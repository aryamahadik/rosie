// The privacy notice's words (T-1171; RULES 4.3: "Every page and first text links to a plain privacy notice").
//
// STAND-IN WORDS, WAITING FOR JAY'S WORDS BEFORE PRODUCTION (Q-30; CQ-171 (b)). No source gives the notice's words yet,
// so these are Q-30's default stand-in, as T-1146's privacyLink line is: each paragraph says one rule of RULES.md in
// plain words, with that rule as its source, and says nothing the rules do not (RULES 1.7: only what is true). The page
// shows them as a draft (DRAFT_NOTE), never as the final notice, and asks search engines not to index them. Jay's words
// replace this file before production; they are not settled here.
//
// The words hold no personal data: the page is the same for every reader.

/** Where these words stand: Q-30's default stand-in, never final. */
export const NOTICE_STATUS = {
  words: "standIn",
  waitingFor: "Jay's words (Q-30), before production",
  source:
    "Q-30's default stand-in (T-1171; DL-351; CQ-171 (b)), from the rules in RULES.md each paragraph names",
} as const;

/** The marker the page's HTML carries, so its source shows the words are a stand-in. */
export const STAND_IN_MARKER =
  "Stand-in words (Q-30's default), waiting for the final words before production. Never final.";

/** One paragraph of the notice, with the rule it says. */
export interface NoticeParagraph {
  text: string;
  source: string;
}

/** One section of the notice. */
export interface NoticeSection {
  /** The heading's id on the page. */
  id: string;
  heading: string;
  paragraphs: readonly NoticeParagraph[];
}

export const NOTICE_TITLE = "Privacy notice";

/** The page's title: the notice's, marked as a draft wherever the title shows (a tab, a link preview). */
export const PAGE_TITLE = "Privacy notice (draft) · Rosie by Rosfield";

/** Shown first on the page, after "Draft.", so the stand-in words are never taken as the final notice. */
export const DRAFT_NOTE =
  "These stand-in words are not Rosfield's final privacy notice, which replaces them before Rosie launches.";

export const NOTICE_INTRO: NoticeParagraph = {
  text: "Rosie is Rosfield's automated booking assistant: it books services for service businesses. This notice says what Rosie keeps, how it is used and what you can ask for.",
  source:
    "RULES 1.1 (Rosie is run by an AI agent and books services for any service business); RULES 1.11 (an automated assistant)",
};

export const NOTICE_SECTIONS: readonly NoticeSection[] = [
  {
    id: "automated",
    heading: "Rosie is not a person",
    paragraphs: [
      {
        text: "Rosie says it is an automated assistant in every chat and email, and in the first text of every thread. Ask if it is a person and it says no, and offers you one.",
        source: "RULES 1.11",
      },
    ],
  },
  {
    id: "keeps",
    heading: "What Rosie keeps",
    paragraphs: [
      {
        text: "What a booking needs: your mobile number, an email if you give one, how you want to be reached, and the booking itself.",
        source: "RULES 4.8 (one card asks a mobile, an email if they have one, and the way)",
      },
      {
        text: "Private details, such as health, a child's details, money details beyond an amount, ID numbers and door codes, never go in a text or an email. They stay on a secure page, and each view is logged.",
        source: "RULES 4.5",
      },
      {
        text: "Never kept at all: full card numbers outside the card box, full Social Security numbers and passwords.",
        source: "RULES 4.5",
      },
    ],
  },
  {
    id: "use",
    heading: "How it is used",
    paragraphs: [
      {
        text: "A business's customer data is used only for that business. It is never sold, never used for ads or to train an AI, and never joined across businesses.",
        source: "RULES 4.10",
      },
      {
        text: "Booking texts carry only the booking: no offers, news or invites.",
        source: "RULES 4.4",
      },
      {
        text: "Except to you and the people you added, Rosie never says whether you are a customer, booked, came in or will come.",
        source: "RULES 4.9",
      },
    ],
  },
  {
    id: "kept",
    heading: "How long it is kept",
    paragraphs: [
      {
        text: "Records and every yes are kept for 7 years, or longer where a trade's rules say so.",
        source: "RULES 4.10",
      },
    ],
  },
  {
    id: "ask",
    heading: "What you can ask for",
    paragraphs: [
      {
        text: "You can ask for a copy of your data, or for it to be deleted. It is done within 45 days of a check that it is you; once, it may take 45 days more, and you are told why. At a health practice, a copy is due within 30 days.",
        source: "RULES 4.10",
      },
      {
        text: "The record that you asked for no texts, and the proof of every yes, are kept.",
        source: 'RULES 4.10 (the "don\'t text me" record and the proof of every yes stay)',
      },
      {
        text: "Reply STOP to stop Rosie's texts to your phone, for every business. Reply START to turn them back on, or HELP for help.",
        source: "RULES 7.2 and 7.5; RULES 4.3 (the STOP, rates and HELP line)",
      },
    ],
  },
  {
    id: "wrong",
    heading: "If something goes wrong",
    paragraphs: [
      {
        text: "If a private detail reaches the wrong person, it is stopped, the business is told within 1 business day, and each person affected is told in plain words.",
        source: "RULES 4.10",
      },
    ],
  },
  {
    id: "children",
    heading: "Children",
    paragraphs: [
      {
        text: "If a child under 13 books alone, Rosie stops, asks for a parent and keeps nothing, unless there is danger.",
        source: "RULES 4.7",
      },
    ],
  },
];
