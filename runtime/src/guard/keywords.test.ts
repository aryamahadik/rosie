// The guard's keywords (T-250): read from the pinned bundle's list (K-01 v1 `lists.keywords`), never typed here.
// The words the tests send are the list's own, taken from K-01's keywords.json and the bundle's manifest.

import { beforeAll, describe, expect, it } from "vitest";

import type { Manifest } from "../bundle";
import { readContractJson } from "../trace/test-support";
import { keyOf, keywordOf, keywordsOf, type KeywordList } from "./keywords";
import { pinnedManifest, typed } from "./test-support";
import { GuardError, type GuardText } from "./types";

/** K-01 v1's keywords fixture (contracts/bundle/fixtures/keywords.json), which T-134's compiler output equals. */
interface KeywordsFixture {
  start: string;
  help: string;
  optOut: string[];
  flagsVisit: string[];
}

const FIXTURE = readContractJson("bundle/fixtures/keywords.json") as KeywordsFixture;
const OPT_OUT = FIXTURE.optOut;
const FLAGS_VISIT = FIXTURE.flagsVisit;

let manifest: Manifest;
let list: KeywordList;

beforeAll(async () => {
  manifest = await pinnedManifest();
  list = keywordsOf(manifest);
});

const title = (word: string): string =>
  word
    .toLowerCase()
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

/** A word as people type it: in any case, with trailing punctuation, with spaces or a line break around it. */
function typedForms(word: string): string[] {
  const lower = word.toLowerCase();
  return [
    word,
    lower,
    title(word),
    lower.replace(/[a-z]/gu, (letter, at: number) => (at % 2 === 0 ? letter.toUpperCase() : letter)),
    `${word}!`,
    `${lower}.`,
    `${title(word)}?`,
    `${lower}!!!`,
    `${word}...`,
    `${title(word)}…`,
    `  ${lower}  `,
    `${title(word)}\n`,
    `${lower} 🛑`,
  ];
}

/** The same word inside a sentence: never a keyword. */
function sentences(word: string): string[] {
  const lower = word.toLowerCase();
  return [
    `please ${lower}`,
    `${title(word)} texting me`,
    `I said ${lower}.`,
    `${word} ${word}`,
    `${lower} 2`,
    `can you ${lower} the reminders?`,
  ];
}

function kindOf(words: string): string | null {
  return keywordOf(typed(words), list)?.kind ?? null;
}

describe("the keyword list is the pinned bundle's (K-01 v1 lists.keywords)", () => {
  it("bundle v0's manifest holds START, HELP and the 16 opt-out words of K-01's keywords.json, in that order", () => {
    expect(OPT_OUT).toHaveLength(16);
    expect(list.all().map((keyword) => keyword.word)).toEqual([FIXTURE.start, FIXTURE.help, ...OPT_OUT]);
    expect(list.all().map((keyword) => keyword.kind)).toEqual([
      "start",
      "help",
      ...OPT_OUT.map(() => "stop"),
    ]);
  });

  it("only the words the list names in flagsVisit flag the visit: CANCEL and CANCELAR", () => {
    const flagged = list
      .all()
      .filter((keyword) => keyword.flagsVisit)
      .map((keyword) => keyword.word);
    expect(flagged).toEqual(FLAGS_VISIT);
    expect(FLAGS_VISIT).toEqual(["CANCEL", "CANCELAR"]);
  });

  it.each(["bundle-mini-a.json", "bundle-mini-b.json"])("%s's manifest carries the same list", (file) => {
    const whole = readContractJson(`bundle/fixtures/${file}`) as { manifest: { lists: unknown } };
    expect(keywordsOf(whole.manifest).all()).toEqual(list.all());
  });

  it("K-01's manifest.json fixture carries the same list", () => {
    const fixture = readContractJson("bundle/fixtures/manifest.json") as { lists: unknown };
    expect(keywordsOf(fixture).all()).toEqual(list.all());
  });

  it("a list the guard cannot read as K-01's is refused (noKeywords), so nothing is split", () => {
    const lists = manifest.lists as { keywords: KeywordsFixture };
    const broken: unknown[] = [
      undefined,
      {},
      { ...lists, keywords: undefined },
      { ...lists, keywords: { ...FIXTURE, optOut: "STOP" } },
      { ...lists, keywords: { ...FIXTURE, optOut: [] } },
      { ...lists, keywords: { ...FIXTURE, optOut: [...OPT_OUT, "  "] } },
      { ...lists, keywords: { ...FIXTURE, optOut: [...OPT_OUT, 7] } },
      { ...lists, keywords: { ...FIXTURE, optOut: [...OPT_OUT, "stop!"] } },
      { ...lists, keywords: { ...FIXTURE, start: "" } },
      { ...lists, keywords: { ...FIXTURE, help: null } },
      { ...lists, keywords: { ...FIXTURE, help: FIXTURE.start } },
      { ...lists, keywords: { ...FIXTURE, flagsVisit: ["CANCEL", "VISIT"] } },
      { ...lists, keywords: { ...FIXTURE, flagsVisit: "CANCEL" } },
    ];
    for (const value of broken) {
      let code: string | null = null;
      try {
        keywordsOf({ lists: value });
      } catch (error) {
        code = error instanceof GuardError ? error.code : "notAGuardError";
      }
      expect(code, JSON.stringify(value)).toBe("noKeywords");
    }
  });
});

describe("each of the 16 opt-out words alone is a stop", () => {
  it.each(OPT_OUT)("%s alone, in any case and with trailing punctuation, is a stop", (word) => {
    for (const form of typedForms(word)) {
      const keyword = keywordOf(typed(form), list);
      expect(keyword, JSON.stringify(form)).toEqual({
        kind: "stop",
        word,
        flagsVisit: FLAGS_VISIT.includes(word),
      });
    }
  });

  it.each(OPT_OUT)("%s inside a sentence is not a keyword", (word) => {
    for (const sentence of sentences(word)) expect(kindOf(sentence), sentence).toBeNull();
  });

  it("Spanish punctuation before the word is cut too: ¡BASTA!, ¡Para!, «fin»", () => {
    expect(kindOf("¡BASTA!")).toBe("stop");
    expect(kindOf("¡Para!")).toBe("stop");
    expect(kindOf("«fin»")).toBe("stop");
  });

  it("OPT OUT reads with any run of spaces inside it, and full-width letters read as plain ones", () => {
    expect(keywordOf(typed("opt   out"), list)?.word).toBe("OPT OUT");
    expect(keywordOf(typed("Opt\tOut!"), list)?.word).toBe("OPT OUT");
    expect(keywordOf(typed("ＳＴＯＰ"), list)?.word).toBe("STOP");
    expect(keyOf(" ¡Opt  Out! ")).toBe("OPT OUT");
  });
});

describe("START and HELP alone are recognised", () => {
  it.each([
    ["start", FIXTURE.start],
    ["help", FIXTURE.help],
  ])("%s alone, in any case and with trailing punctuation", (kind, word) => {
    for (const form of typedForms(word)) {
      expect(keywordOf(typed(form), list), JSON.stringify(form)).toEqual({ kind, word, flagsVisit: false });
    }
  });

  it.each([FIXTURE.start, FIXTURE.help])("%s inside a sentence is not a keyword", (word) => {
    for (const sentence of sentences(word)) expect(kindOf(sentence), sentence).toBeNull();
    expect(kindOf(`${title(word)} my booking`)).toBeNull();
  });

  it("a tap of S1-37's button 'Start' sends its words and reads as START (Q-14's default: the lint fails that step)", () => {
    const step = readContractJson("bundle/fixtures/invalid/refuse-guard-keyword-button.json") as {
      say: { elements?: { buttons?: string[] } }[];
    };
    const button = step.say.flatMap((message) => message.elements?.buttons ?? [])[0];
    expect(button).toBe("Start");
    expect(keywordOf(typed(button ?? ""), list)).toEqual({
      kind: "start",
      word: FIXTURE.start,
      flagsVisit: false,
    });
  });
});

describe("a bare CANCEL or CANCELAR is a stop that also flags the visit (RULES 7.4)", () => {
  it.each(["CANCEL", "CANCELAR"])("%s alone, in any case and with trailing punctuation", (word) => {
    expect(OPT_OUT).toContain(word);
    for (const form of typedForms(word)) {
      expect(keywordOf(typed(form), list), JSON.stringify(form)).toEqual({
        kind: "stop",
        word,
        flagsVisit: true,
      });
    }
  });

  it("no other keyword flags the visit", () => {
    for (const word of [
      FIXTURE.start,
      FIXTURE.help,
      ...OPT_OUT.filter((stop) => !FLAGS_VISIT.includes(stop)),
    ]) {
      expect(keywordOf(typed(word), list)?.flagsVisit, word).toBe(false);
    }
  });

  it("'cancel my 2pm haircut' is not a keyword (BP 9.4)", () => {
    expect(keywordOf(typed("cancel my 2pm haircut"), list)).toBeNull();
    expect(keywordOf(typed("Cancel my 2pm haircut."), list)).toBeNull();
    expect(keywordOf(typed("cancelar mi corte de las 2"), list)).toBeNull();
  });
});

describe("only typed words count", () => {
  it("a photo's caption and an edit's new words are read like a text", () => {
    expect(keywordOf(typed("STOP", "photo"), list)?.kind).toBe("stop");
    expect(keywordOf(typed("stop", "edit"), list)?.kind).toBe("stop");
    expect(keywordOf(typed("", "photo"), list)).toBeNull();
  });

  it("a reaction, a poll vote and a vote removed are never keywords (a vote answers its own poll)", () => {
    for (const kind of ["reaction", "pollVote", "voteRemoved"]) {
      const text: GuardText = { eventId: `evt-${kind}`, kind, words: { body: "STOP", subject: null } };
      expect(keywordOf(text, list), kind).toBeNull();
      expect(keywordOf({ ...text, words: null }, list), kind).toBeNull();
    }
  });

  it("an email is read by its body, and by its subject when the body holds no word", () => {
    const email = (body: string | null, subject: string | null): GuardText => ({
      eventId: "evt-email-0001",
      kind: "text",
      words: { body, subject },
    });
    expect(keywordOf(email("STOP", "Re: your haircut on Saturday"), list)?.kind).toBe("stop");
    expect(keywordOf(email("", "STOP"), list)?.kind).toBe("stop");
    expect(keywordOf(email(null, "Unsubscribe"), list)?.word).toBe("UNSUBSCRIBE");
    expect(keywordOf(email("Can I come at 3 instead?", "STOP"), list)).toBeNull();
    expect(keywordOf(email("", "Re: your haircut on Saturday"), list)).toBeNull();
  });

  it("no words, blank words or only punctuation are not a keyword", () => {
    for (const body of ["", "   ", "!!!", "🛑", "?"]) expect(kindOf(body), body).toBeNull();
    expect(keywordOf({ eventId: "evt-none", kind: "text", words: null }, list)).toBeNull();
  });
});

describe("a poll vote is read by its option's words, from its box (DL-540; T-1297)", () => {
  /** A vote as the turn and the down path open it: K-06 v1.2's box, its option's words and no body. */
  const vote = (optionWords: string | null, kind = "pollVote"): GuardText => ({
    eventId: `evt-vote-${kind}`,
    kind,
    words: { body: null, subject: null, optionWords },
  });

  it.each(OPT_OUT)(
    "a vote for an option that reads %s, in any case and with trailing punctuation, is a stop",
    (word) => {
      for (const form of typedForms(word)) {
        expect(keywordOf(vote(form), list), JSON.stringify(form)).toEqual({
          kind: "stop",
          word,
          flagsVisit: FLAGS_VISIT.includes(word),
        });
      }
    },
  );

  it("START and HELP as an option's words are read as START and HELP", () => {
    expect(keywordOf(vote("Start"), list)?.kind).toBe("start");
    expect(keywordOf(vote("help?"), list)?.kind).toBe("help");
  });

  it("an option of other words is not a keyword: Rosie's own (poll-vote.json's 'Sat 2:00pm'), or one with a stop word inside it", () => {
    for (const words of ["Sat 2:00pm", "Please stop texting me", "cancel my 2pm haircut", "", "   ", null]) {
      expect(keywordOf(vote(words), list), String(words)).toBeNull();
    }
  });

  it("a vote taken back is never a keyword, whatever its option's words", () => {
    expect(keywordOf(vote("STOP", "voteRemoved"), list)).toBeNull();
  });
});
