// T-1518's tests (DL-1042): `npm run test:unit -- actions/src/domain/kind-matcher`. The kind matcher reads an owner's
// everyday words: (a) every kind's own name, as written and in lower case, lists exactly its own kind, a name with commas
// as one part; (b) each word the card names in Gives 2 and 3 lists the kind an owner means, or one "which?" between the
// two that fit; (c) the texting guide's 1,344 inputs (kinds-guide.json, from ops/reviews/kinds-guide/kinds-matcher.json)
// are a regression: exactly the inputs the card names move, each listed below, and every other keeps its outcome; (d) the
// guide's sample answers. Over the 243 kinds the kinds seed writes (seededKinds, equal to staging's catalogPlanOf rows by
// the guide's check). No model is called; every answer is held to K-09 v1.5 matchKinds.response.

import { describe, expect, it } from "vitest";

import { createToolApiValidator } from "../../tool-api";
import {
  createKindMatcher,
  EVERYDAY_WORDS,
  partSpans,
  splitParts,
  TRADE_FILE,
  wordKey,
  type CatalogKind,
  type KindMatch,
} from "./index";
import { guideInputs, k24Kinds, seededKinds, type GuideInput } from "./test-support";

const catalog = seededKinds();
const matcher = createKindMatcher(catalog);
const validator = createToolApiValidator();
const guide = guideInputs();

/** A part's words, outcome and kind ids. */
const brief = (part: KindMatch) => ({
  words: part.words,
  outcome: part.outcome,
  kinds: part.kinds.map((kind) => kind.kindId),
});

/** The parts a text gives, held to K-09 v1.5 matchKinds.response. */
function partsOf(text: string, over = matcher): KindMatch[] {
  const parts = over.match(text);
  expect(validator.check("matchKinds", "response", { parts })).toEqual([]);
  return parts;
}

/** A text's one part, as [outcome, ...kind ids]. */
function readAlone(text: string): string[] {
  const parts = partsOf(text);
  expect(parts).toHaveLength(1);
  return parts.flatMap((part) => [part.outcome, ...part.kinds.map((kind) => kind.kindId)]);
}

/**
 * What the guide records of an input's parts: one part, or parts that all list one kind, as that outcome and its kinds;
 * else `parts`, with each part as `outcome:kinds` (kinds-guide.json's "row" note).
 */
function readOf(parts: readonly KindMatch[]): string[] {
  const [first, ...rest] = parts;
  if (first === undefined) return ["none"];
  const ids = (part: KindMatch) => part.kinds.map((kind) => kind.kindId);
  const oneKind = (part: KindMatch) => part.outcome === "listed" && ids(part).join() === ids(first).join();
  if (rest.length === 0 || (first.outcome === "listed" && rest.every(oneKind))) {
    return [first.outcome, ...ids(first)];
  }
  return ["parts", ...parts.map((part) => `${part.outcome}:${ids(part).join(",")}`)];
}

const recorded = (input: GuideInput): string[] => [input.outcome, ...input.kinds];
const keyOf = (kindId: string, text: string): string => `${kindId} | ${text}`;

/** A kind's catalog row by id. */
function kindOf(id: string): CatalogKind {
  const kind = catalog.find((each) => each.id === id);
  if (kind === undefined) throw new Error(`no kind ${id}`);
  return kind;
}

// ---- (a) Gives 1 ------------------------------------------------------------------------------------------------------

/** The six names the guide found that did not list their own kind, with what they read as before T-1518. */
const NAMES_BEFORE: readonly (readonly [string, readonly string[]])[] = [
  ["art-classes", ["which", "art-classes", "martial-arts"]],
  ["auto-repair", ["which", "auto-repair", "auto-body"]],
  ["inspector", ["which", "inspector", "home-engineer"]],
  ["movers", ["which", "movers", "senior-move"]],
  ["painter", ["which", "painter", "face-painter"]],
  ["glass-doors", ["parts", "which:auto-glass,glass-doors", "listed:glass-doors"]],
];

describe("Gives 1: every kind's own name lists exactly its own kind", () => {
  it.each(catalog.map((kind) => [kind.id, kind] as const))(
    "%s: its name, as written and in lower case, is one part listed as that kind",
    (_id, kind) => {
      for (const text of [kind.name, kind.name.toLowerCase()]) {
        expect(partsOf(text).map(brief)).toEqual([{ words: text, outcome: "listed", kinds: [kind.id] }]);
      }
    },
  );

  it("all 243 names list their own kind, where the guide's run found 237", () => {
    const listing = catalog.filter((kind) =>
      [kind.name, kind.name.toLowerCase()].every((text) => {
        const parts = matcher.match(text);
        return parts.length === 1 && parts[0]?.outcome === "listed" && parts[0].kinds[0]?.kindId === kind.id;
      }),
    );
    expect(listing).toHaveLength(243);
    const before = guide.filter(
      (input) =>
        input.text === kindOf(input.kindId).name &&
        input.outcome === "listed" &&
        input.kinds[0] === input.kindId,
    );
    expect(before).toHaveLength(237);
  });

  it("the six names that failed: the guide recorded each, and each now lists its own kind", () => {
    for (const [id, was] of NAMES_BEFORE) {
      const kind = kindOf(id);
      for (const text of [kind.name, kind.name.toLowerCase()]) {
        const input = guide.find((each) => each.kindId === id && each.text === text);
        expect(input === undefined ? [] : recorded(input)).toEqual(was);
        expect(readOf(partsOf(text))).toEqual(["listed", id]);
      }
    }
  });

  it("a name with commas is one part as typed: 'Glass, window and door installer' settles as Glass, window and door installer", () => {
    expect(partsOf("Glass, window and door installer").map(brief)).toEqual([
      { words: "Glass, window and door installer", outcome: "listed", kinds: ["glass-doors"] },
    ]);
    const withCommas = catalog.filter((kind) => kind.name.includes(","));
    expect(withCommas).toHaveLength(15);
    for (const kind of withCommas) {
      expect(partsOf(kind.name).map(brief)).toEqual([
        { words: kind.name, outcome: "listed", kinds: [kind.id] },
      ]);
    }
  });

  it("in an answer of several parts, the name is one part among the others, kept as typed", () => {
    expect(partsOf("Barbershop,  Glass,window and door installer ; plumbing").map(brief)).toEqual([
      { words: "Barbershop", outcome: "listed", kinds: ["barber"] },
      { words: "Glass,window and door installer", outcome: "listed", kinds: ["glass-doors"] },
      { words: "plumbing", outcome: "listed", kinds: ["plumber"] },
    ]);
  });

  it("only commas join a name: its pieces apart at a semicolon or a line break, or in another order, are read as before", () => {
    const before = [
      { words: "Glass", outcome: "which", kinds: ["auto-glass", "glass-doors"] },
      { words: "window and door installer", outcome: "listed", kinds: ["glass-doors"] },
    ];
    expect(partsOf("Glass; window and door installer").map(brief)).toEqual(before);
    expect(partsOf("Glass\nwindow and door installer").map(brief)).toEqual(before);
    expect(partsOf("window and door installer, Glass").map(brief)).toEqual([before[1], before[0]]);
  });

  it("a name two kinds share by their words lists neither by name: the ranking reads it, as before", () => {
    const twin: CatalogKind = {
      id: "barbers",
      name: "Barbers",
      style: "Chair",
      pattern: "chair",
      source: TRADE_FILE,
    };
    const twins = createKindMatcher([...catalog, twin]);
    expect(partsOf("barber", twins).map(brief)).toEqual([
      { words: "barber", outcome: "which", kinds: ["barber", "barbers"] },
    ]);
    expect(partsOf("Plumber", twins).map(brief)).toEqual([
      { words: "Plumber", outcome: "listed", kinds: ["plumber"] },
    ]);
  });
});

// ---- (b) Gives 2 and 3 ------------------------------------------------------------------------------------------------

/** Each word T-1518 names in Gives 2 and 3, with its outcome now: [words, outcome, ...kinds]. */
const GIVES: readonly (readonly string[])[] = [
  // Gives 2: the wrong kind before.
  ["mechanic", "listed", "auto-repair"],
  ["car repair", "listed", "auto-repair"],
  ["tow truck", "listed", "towing"],
  ["heart doctor", "listed", "cardiologist"],
  ["eye doctor", "which", "optometrist", "ophthalmologist"],
  ["dental", "listed", "dentist"],
  ["upholstery", "listed", "upholstery"],
  ["house inspection", "listed", "inspector"],
  ["home inspection", "listed", "inspector"],
  ["moving company", "listed", "movers"],
  ["moving", "listed", "movers"],
  // Gives 2: new work before.
  ["vet", "listed", "vet"],
  ["attorney", "listed", "lawyer"],
  ["karate", "listed", "martial-arts"],
  ["roofing", "listed", "roofer"],
  ["fencing", "listed", "fence"],
  ["OBGYN", "listed", "obgyn"],
  ["cafe", "listed", "restaurant"],
  // Gives 3: a common word that fits one kind best.
  ["haircuts", "listed", "hair"],
  ["salon", "listed", "hair"],
  ["gym", "listed", "gym"],
  ["realtor", "listed", "realtor"],
  ["daycare", "listed", "daycare"],
  ["makeup", "listed", "makeup"],
  ["contractor", "listed", "contractor"],
  // Gives 3: a word that truly fits two stays one "which?" between those two only (no table entry: method A's reading).
  ["spa", "which", "medspa", "spa"],
  ["cleaning", "which", "commercial-cleaning", "cleaner"],
];

describe("Gives 2 and 3: each everyday word lists the kind an owner means", () => {
  it.each(GIVES.map((row) => [row[0] ?? "", row.slice(1)] as const))("%s", (text, outcome) => {
    expect(readAlone(text)).toEqual(outcome);
  });

  it("the word as an owner types it: any case, a plural, function words and punctuation around it", () => {
    for (const [text, outcome] of [
      ["Mechanics", ["listed", "auto-repair"]],
      ["We do haircuts", ["listed", "hair"]],
      ["I'm a mechanic!", ["listed", "auto-repair"]],
      ["Vets", ["listed", "vet"]],
      ["TOW TRUCKS", ["listed", "towing"]],
      ["Café", ["listed", "restaurant"]],
      ["OB/GYN", ["listed", "obgyn"]],
      ["Eye doctors", ["which", "optometrist", "ophthalmologist"]],
      ["a salon", ["listed", "hair"]],
    ] as const) {
      expect(readAlone(text)).toEqual(outcome);
    }
  });

  it("each kind offered carries its K-24 name, and a part of several words keeps method A's reading", () => {
    expect(partsOf("Barbershop, mechanic, eye doctor, vet").map((part) => part.kinds)).toEqual([
      [{ kindId: "barber", name: "Barber" }],
      [{ kindId: "auto-repair", name: "Auto repair" }],
      [
        { kindId: "optometrist", name: "Optometrist" },
        { kindId: "ophthalmologist", name: "Ophthalmologist" },
      ],
      [{ kindId: "vet", name: "Veterinarian" }],
    ]);
    // Words around an everyday word are ranked as before (the guide's own inputs, unchanged by T-1518).
    expect(readAlone("auto mechanic")).toEqual(["which", "boat-repair", "auto-glass"]);
    expect(readAlone("vet clinic")).toEqual(["which", "fertility", "sleep-clinic"]);
    expect(readAlone("upholstery cleaning")).toEqual(["listed", "carpet"]);
  });

  it("work Rosie never books is still read first: an everyday word beside 'delivery only' is not booked", () => {
    expect(partsOf("cafe delivery only").map(brief)).toEqual([
      { words: "cafe delivery only", outcome: "not_booked", kinds: [] },
    ]);
  });

  it("an entry lists only the kinds the catalog handed in offers, and none when neither is offered", () => {
    const some = createKindMatcher([kindOf("optometrist"), kindOf("plumber"), kindOf("hair")]);
    expect(partsOf("eye doctor", some).map(brief)).toEqual([
      { words: "eye doctor", outcome: "listed", kinds: ["optometrist"] },
    ]);
    const eight = createKindMatcher(k24Kinds("seed-kinds-sample.json"));
    expect(eight.match("mechanic").map(brief)).toEqual([
      { words: "mechanic", outcome: "new_work", kinds: [] },
    ]);
  });
});

describe("the everyday words table (everyday.ts): each entry cites the catalog", () => {
  const nameKeys = new Set(catalog.map((kind) => wordKey(kind.name)));

  it("every entry has words, one or two kinds of the 243 named in its why, and no two entries share their words", () => {
    const keys = EVERYDAY_WORDS.map((entry) => wordKey(entry.words));
    expect(keys.every((key) => key !== "")).toBe(true);
    expect(new Set(keys).size).toBe(EVERYDAY_WORDS.length);
    for (const entry of EVERYDAY_WORDS) {
      expect([1, 2]).toContain(entry.kinds.length);
      expect(new Set(entry.kinds).size).toBe(entry.kinds.length);
      for (const id of entry.kinds) expect(entry.why).toContain(kindOf(id).name);
    }
  });

  it("no entry is a kind's own name (the name is read first), and every entry is a word Gives 2 or 3 names", () => {
    expect(EVERYDAY_WORDS.filter((entry) => nameKeys.has(wordKey(entry.words)))).toEqual([]);
    const named = new Set(GIVES.map((row) => wordKey(row[0] ?? "")));
    expect(EVERYDAY_WORDS.filter((entry) => !named.has(wordKey(entry.words)))).toEqual([]);
    for (const entry of EVERYDAY_WORDS) {
      expect(readAlone(entry.words)).toEqual([entry.kinds.length === 1 ? "listed" : "which", ...entry.kinds]);
    }
  });
});

describe("words.ts helpers T-1518 adds", () => {
  it("wordKey: a text's words as one key", () => {
    expect(wordKey("We do haircuts")).toBe("haircut");
    expect([wordKey("OB/GYN"), wordKey("OB-GYN"), wordKey("ob gyn")]).toEqual(["ob gyn", "ob gyn", "ob gyn"]);
    expect([wordKey("Movers"), wordKey("Art classes"), wordKey("Hi! 42")]).toEqual([
      "mover",
      "art class",
      "",
    ]);
  });

  it("partSpans: splitParts' parts, in order, each where it sits in the text", () => {
    for (const text of [
      "Barbershop, plumbing, electrical",
      " Pet boarding and doggy daycare ;\r\n",
      ",, ; Glass,  window and door installer\n\nplumbing,",
      "",
      "Hi",
    ]) {
      const spans = partSpans(text);
      expect(spans.map((span) => span.part)).toEqual(splitParts(text));
      for (const span of spans) expect(text.slice(span.start, span.end)).toBe(span.part);
    }
  });
});

// ---- (c) The guide's 1,344 inputs -------------------------------------------------------------------------------------

/**
 * Every input of the guide's run whose outcome T-1518 moves, by the kind it was written for and its words, with its
 * outcome now: Gives 1's names (and "painters", the plural of Painter's name, which folds to it), Gives 2's and Gives 3's
 * words. Every other input keeps the outcome the guide recorded.
 */
const MOVED: readonly (readonly string[])[] = [
  // Gives 1: the names.
  ["art-classes", "Art classes", "listed", "art-classes"],
  ["art-classes", "art classes", "listed", "art-classes"],
  ["auto-repair", "Auto repair", "listed", "auto-repair"],
  ["auto-repair", "auto repair", "listed", "auto-repair"],
  ["glass-doors", "Glass, window and door installer", "listed", "glass-doors"],
  ["glass-doors", "glass, window and door installer", "listed", "glass-doors"],
  ["inspector", "Home inspector", "listed", "inspector"],
  ["inspector", "home inspector", "listed", "inspector"],
  ["movers", "Movers", "listed", "movers"],
  ["movers", "movers", "listed", "movers"],
  ["painter", "Painter", "listed", "painter"],
  ["painter", "painter", "listed", "painter"],
  ["painter", "painters", "listed", "painter"],
  // Gives 2.
  ["auto-repair", "mechanic", "listed", "auto-repair"],
  ["auto-repair", "car repair", "listed", "auto-repair"],
  ["towing", "tow truck", "listed", "towing"],
  ["cardiologist", "heart doctor", "listed", "cardiologist"],
  ["ophthalmologist", "eye doctor", "which", "optometrist", "ophthalmologist"],
  ["optometrist", "eye doctor", "which", "optometrist", "ophthalmologist"],
  ["dentist", "dental", "listed", "dentist"],
  ["upholstery", "upholstery", "listed", "upholstery"],
  ["inspector", "house inspection", "listed", "inspector"],
  ["inspector", "home inspection", "listed", "inspector"],
  ["movers", "moving company", "listed", "movers"],
  ["movers", "moving", "listed", "movers"],
  ["vet", "vet", "listed", "vet"],
  ["lawyer", "attorney", "listed", "lawyer"],
  ["martial-arts", "karate", "listed", "martial-arts"],
  ["roofer", "roofing", "listed", "roofer"],
  ["fence", "fencing", "listed", "fence"],
  ["obgyn", "OBGYN", "listed", "obgyn"],
  ["restaurant", "cafe", "listed", "restaurant"],
  // Gives 3.
  ["barber", "haircuts", "listed", "hair"],
  ["hair", "haircuts", "listed", "hair"],
  ["hair", "salon", "listed", "hair"],
  ["gym", "gym", "listed", "gym"],
  ["realtor", "realtor", "listed", "realtor"],
  ["daycare", "daycare", "listed", "daycare"],
  ["makeup", "makeup", "listed", "makeup"],
  ["contractor", "contractor", "listed", "contractor"],
];

describe("Gives 4: the guide's 1,344 inputs are a regression", () => {
  const moved = new Map(MOVED.map(([kindId, text, ...now]) => [keyOf(kindId ?? "", text ?? ""), now]));

  it("the fixture is the guide's run: 1,344 inputs, every kind's name, its lower case and its variants", () => {
    expect(guide).toHaveLength(1344);
    expect(new Set(guide.map((input) => keyOf(input.kindId, input.text))).size).toBe(1344);
    expect(new Set(guide.map((input) => input.kindId))).toEqual(new Set(catalog.map((kind) => kind.id)));
    for (const kind of catalog) {
      const texts = guide.filter((input) => input.kindId === kind.id).map((input) => input.text);
      expect(texts.slice(0, 2)).toEqual([kind.name, kind.name.toLowerCase()]);
    }
  });

  it("every input T-1518 does not name keeps the outcome the guide recorded", () => {
    const changed = guide
      .filter((input) => !moved.has(keyOf(input.kindId, input.text)))
      .filter((input) => readOf(partsOf(input.text)).join("|") !== recorded(input).join("|"))
      .map(
        (input) =>
          `${keyOf(input.kindId, input.text)}: ${recorded(input).join(" ")} -> ${readOf(matcher.match(input.text)).join(" ")}`,
      );
    expect(changed).toEqual([]);
  });

  it("exactly the 40 inputs T-1518 names move, each from the guide's outcome to its own", () => {
    expect(moved.size).toBe(40);
    for (const [kindId, text, ...now] of MOVED) {
      const input = guide.find((each) => each.kindId === kindId && each.text === text);
      expect(input, `${keyOf(kindId ?? "", text ?? "")} is a guide input`).toBeDefined();
      if (input === undefined) continue;
      expect(recorded(input)).not.toEqual(now);
      expect(readOf(partsOf(input.text))).toEqual(now);
    }
  });

  it("nothing that listed stops listing or changes kind, except the words Gives 2 and 3 move to the kind meant", () => {
    const listedBefore = guide.filter((input) => input.outcome === "listed");
    const stopped = listedBefore.filter((input) => {
      const now = readOf(matcher.match(input.text));
      return now[0] !== "listed" || now[1] !== input.kinds[0];
    });
    expect(stopped.map((input) => keyOf(input.kindId, input.text))).toEqual([
      "auto-repair | mechanic",
      "auto-repair | car repair",
      "cardiologist | heart doctor",
      "dentist | dental",
      "upholstery | upholstery",
      "inspector | house inspection",
      "movers | moving company",
      "ophthalmologist | eye doctor",
      "optometrist | eye doctor",
      "towing | tow truck",
    ]);
  });
});

// ---- (d) The guide's sample answers -----------------------------------------------------------------------------------

describe("the guide's eight sample answers (sample-answers.json): only 'We do haircuts' moves", () => {
  it.each([
    [
      "Barbershop, plumbing, electrical",
      [
        ["listed", "barber"],
        ["listed", "plumber"],
        ["listed", "electrician"],
      ],
    ],
    ["Plumbing", [["listed", "plumber"]]],
    ["We do haircuts", [["listed", "hair"]]],
    ["dog yoga", [["which", "yoga", "dog-trainer"]]],
    ["Barbershop, pack hikes", [["listed", "barber"], ["new_work"]]],
    ["candles and soap", [["new_work"]]],
    ["house cleaning and carpet cleaning", [["which", "cleaner", "carpet"]]],
    ["massage and facials", [["listed", "massage"]]],
  ] as const)("%s", (text, outcome) => {
    expect(partsOf(text).map((part) => [part.outcome, ...part.kinds.map((kind) => kind.kindId)])).toEqual(
      outcome,
    );
  });
});
