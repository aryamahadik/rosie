// The kind matcher's tests (T-632; C-130): `npm run test:unit -- actions/src/domain/kind-matcher`. Its card's "Proves it
// with" and its lead note (DL-914, item 4), over the 243 kinds the kinds seed reads (T-212), with T-631's sample words
// (test-support.ts) and K-24 v1's frozen fixtures as cases: each owner's word to its kind; a word that fits two kinds gets
// exactly one "which?" with both; work Rosie never books (S1-74) is not_booked with no kind; unknown work is new_work so
// S1-03 can draft it. No model is called, so no eval slice applies (lead note item 2). Every answer is held to K-09 v1.5
// matchKinds.response. T-631's limits are kept in view, not hidden (FINDINGS.md "Its limits").

import { describe, expect, it } from "vitest";

import { createToolApiValidator } from "../../tool-api";
import {
  createKindMatcher,
  fold,
  KindCatalogError,
  meets,
  notBookedReason,
  RATIO,
  splitParts,
  TRADE_FILE,
  words,
  type CatalogKind,
  type KindMatch,
} from "./index";
import { asMatchKinds, k24Kinds, k24Picks, SAMPLES, seededKinds, type Sample } from "./test-support";

const catalog = seededKinds();
const matcher = createKindMatcher(catalog);
const validator = createToolApiValidator();

/** A part's words, outcome and kind ids. */
const brief = (part: KindMatch) => ({
  words: part.words,
  outcome: part.outcome,
  kinds: part.kinds.map((kind) => kind.kindId),
});

/** The one part a text gives, held to K-09 v1.5 matchKinds.response. */
function onePart(text: string): KindMatch {
  const parts = matcher.match(text);
  expect(validator.check("matchKinds", "response", { parts })).toEqual([]);
  expect(parts).toHaveLength(1);
  const [part] = parts;
  if (part === undefined) throw new Error(`${text}: no part`);
  return part;
}

/** The sample whose words these are. */
function sample(text: string): Sample {
  const found = SAMPLES.find((each) => each.words === text);
  if (found === undefined) throw new Error(`no sample "${text}"`);
  return found;
}

/** The outcome the sample's step makes right: listed with its one kind, "which?" with both, or not booked. */
function isRight(each: Sample, part: KindMatch): boolean {
  const ids = part.kinds.map((kind) => kind.kindId);
  if (each.fits.length === 0) return part.outcome === "not_booked";
  if (each.fits.length === 1) return part.outcome === "listed" && ids[0] === each.fits[0];
  return part.outcome === "which" && each.fits.every((id) => ids.includes(id));
}

/** The words of the samples `keep` picks, in T-631's order. */
const wordsOf = (keep: (each: Sample) => boolean): string[] => SAMPLES.filter(keep).map((each) => each.words);

/** The S1-02 trade words method A does not list as their kind (T-631's table): each is asserted on its own below. */
const NOT_LISTED_BY_A: readonly string[] = [
  "golf lessons",
  "ski lessons",
  "snowboard lessons",
  "course coaching",
  "Training studio",
];

describe("the catalog handed in: the 243 kinds the kinds seed writes (T-212)", () => {
  it("is 243 trade-file kinds, each with an id, a name, a style and a pattern, and the matcher offers all of them", () => {
    expect(catalog).toHaveLength(243);
    expect(new Set(catalog.map((kind) => kind.id)).size).toBe(243);
    for (const kind of catalog) {
      expect(kind.source).toBe(TRADE_FILE);
      expect([kind.name, kind.style, kind.pattern].every((field) => field.trim() !== "")).toBe(true);
    }
    expect(matcher.size).toBe(243);
  });

  it("gives the kinds K-24 v1's seed-kinds-sample.json seeds their names, styles and patterns", () => {
    const seeded = k24Kinds("seed-kinds-sample.json");
    expect(seeded).toHaveLength(8);
    for (const kind of seeded) expect(catalog.find((each) => each.id === kind.id)).toEqual(kind);
  });
});

describe("S1-02: each owner's word to its kind", () => {
  it("Sam's answer gives K-24 v1's seed-business-kinds.json picks: three listed parts, in order, with their names", () => {
    const picks = k24Picks("seed-business-kinds.json");
    const answer = picks.map((pick) => pick.words).join(", ");
    expect(answer).toBe("Barbershop, plumbing, electrical");
    const parts = matcher.match(answer);
    expect(validator.check("matchKinds", "response", { parts })).toEqual([]);
    expect(parts.map(brief)).toEqual(
      picks.map((pick) => ({ words: pick.words, outcome: pick.outcome, kinds: [pick.kindId] })),
    );
    expect(parts.map((part) => part.kinds[0]?.name)).toEqual(["Barber", "Plumber", "Electrician"]);
  });

  it.each(wordsOf((each) => each.group === "S1-02 trades" && !NOT_LISTED_BY_A.includes(each.words)))(
    "S1-02 as a trade words it: %s is listed as its kind",
    (text) => {
      const part = onePart(text);
      expect(brief(part)).toEqual({ words: text, outcome: "listed", kinds: [...sample(text).fits] });
    },
  );

  it("golf, ski and snowboard lessons offer their kind first, with Music lessons second: one 'which?' from the shared word 'lessons' (T-631's limit 2)", () => {
    expect(["golf lessons", "ski lessons", "snowboard lessons"].map((text) => brief(onePart(text)))).toEqual([
      { words: "golf lessons", outcome: "which", kinds: ["golf-instructor", "music"] },
      { words: "ski lessons", outcome: "which", kinds: ["ski-instructor", "music"] },
      { words: "snowboard lessons", outcome: "which", kinds: ["ski-instructor", "music"] },
    ]);
  });

  it("T-631's two misses among the 18 owner's words stand: 'course coaching' and 'Training studio' need a meaning read", () => {
    const owners = SAMPLES.filter((each) => each.group.startsWith("S1-02") && each.fits.length === 1);
    expect(owners).toHaveLength(18);
    const first = owners.filter((each) => onePart(each.words).kinds[0]?.kindId === each.fits[0]);
    expect(owners.filter((each) => !first.includes(each)).map((each) => each.words)).toEqual([
      "course coaching",
      "Training studio",
    ]);
    expect(brief(onePart("course coaching")).kinds).toEqual(["tennis-coach", "coach"]);
    expect(brief(onePart("Training studio")).kinds).toEqual(["cpr-training", "dog-trainer"]);
  });
});

describe("a word that fits two kinds gets exactly one 'which?' with both, closest first", () => {
  it("'trainer' fits Dog trainer and Personal trainer: one part, outcome which, both kinds", () => {
    const part = onePart("trainer");
    expect(brief(part)).toEqual({ words: "trainer", outcome: "which", kinds: ["dog-trainer", "trainer"] });
    expect(part.kinds.map((kind) => kind.name)).toEqual(["Dog trainer", "Personal trainer"]);
  });

  it("in an answer of several parts, only the part that fits two kinds asks; the others are listed", () => {
    const parts = matcher.match("Barbershop, trainer, plumbing");
    expect(validator.check("matchKinds", "response", { parts })).toEqual([]);
    expect(parts.map(brief)).toEqual([
      { words: "Barbershop", outcome: "listed", kinds: ["barber"] },
      { words: "trainer", outcome: "which", kinds: ["dog-trainer", "trainer"] },
      { words: "plumbing", outcome: "listed", kinds: ["plumber"] },
    ]);
  });

  it("asks when the second kind scores at least RATIO of the first, and lists the first below it", () => {
    const [first, second] = matcher.rank("trainer");
    expect(first !== undefined && second !== undefined && second.score >= RATIO * first.score).toBe(true);
    const [barber, next] = matcher.rank("Barbershop");
    expect(barber?.id).toBe("barber");
    expect(next === undefined || (barber !== undefined && next.score < RATIO * barber.score)).toBe(true);
  });

  it("never offers more than two kinds, even when three kinds score alike", () => {
    for (const text of ["trainer", "studio", "repair", "coaching"]) {
      expect(onePart(text).kinds.length).toBeLessThanOrEqual(2);
    }
  });
});

describe("S1-74: work Rosie never books is not_booked, with no kind, so nothing is set up", () => {
  it.each(wordsOf((each) => each.group === "S1-02" && each.fits.length === 0))(
    "S1-02's 'Not a service we book': %s",
    (text) => {
      expect(brief(onePart(text))).toEqual({ words: text, outcome: "not_booked", kinds: [] });
    },
  );

  it("RULES 1.4's own examples: stall-only rental and shooting lane-only are out; horse boarding is in", () => {
    expect(brief(onePart("stall-only rental"))).toEqual({
      words: "stall-only rental",
      outcome: "not_booked",
      kinds: [],
    });
    expect(brief(onePart("Shooting lane-only"))).toEqual({
      words: "Shooting lane-only",
      outcome: "not_booked",
      kinds: [],
    });
    expect(brief(onePart("Horse boarding"))).toEqual({
      words: "Horse boarding",
      outcome: "listed",
      kinds: ["horse-riding"],
    });
  });

  it("names why: gift cards, no visit, only goods, delivery or a space, renting a thing alone", () => {
    expect(notBookedReason("Gift cards")).toBe("giftCards");
    expect(notBookedReason("goods with no visit")).toBe("noVisit");
    expect(notBookedReason("delivery only")).toBe("only");
    expect(notBookedReason("stall-only rental")).toBe("only");
    expect(notBookedReason("Shooting lane-only")).toBe("only");
    expect(notBookedReason("renting a thing alone")).toBe("alone");
  });

  it("reads only those words: a kind of work that rents, delivers or says only or alone is still a kind", () => {
    for (const text of [
      "party rentals",
      "party rentals only",
      "Horse boarding",
      "no visit fee",
      "I work alone",
      "cards",
    ]) {
      expect(notBookedReason(text)).toBeNull();
    }
    expect(brief(onePart("party rentals only"))).toEqual({
      words: "party rentals only",
      outcome: "listed",
      kinds: ["rentals"],
    });
  });

  it("never-booked work beside a service: the service goes on as usual (S1-74), and only that part is not booked", () => {
    const parts = matcher.match("Barbershop, gift cards");
    expect(validator.check("matchKinds", "response", { parts })).toEqual([]);
    expect(parts.map(brief)).toEqual([
      { words: "Barbershop", outcome: "listed", kinds: ["barber"] },
      { words: "gift cards", outcome: "not_booked", kinds: [] },
    ]);
  });
});

describe("S1-02 'One isn't on the list yet': unknown work is new_work, with no kind, so S1-03 can draft it", () => {
  it("K-24 v1's seed-new-work-draft.json: the owner's 'pack hikes' is new work", () => {
    const [pick] = k24Picks("seed-new-work-draft.json");
    expect(pick?.outcome).toBe("new_work");
    expect(brief(onePart(pick?.words ?? ""))).toEqual({
      words: "pack hikes",
      outcome: "new_work",
      kinds: [],
    });
  });

  it("a drafted kind is never offered: with the fixture's drafted kind handed in, 'pack hikes' is still new work", () => {
    const drafted = k24Kinds("seed-new-work-draft.json");
    expect(drafted.map((kind) => [kind.id, kind.source])).toEqual([["new-pack-hikes", "new_work"]]);
    const withDrafted = createKindMatcher([...catalog, ...drafted]);
    expect(withDrafted.size).toBe(243);
    expect(withDrafted.match("pack hikes").map(brief)).toEqual([
      { words: "pack hikes", outcome: "new_work", kinds: [] },
    ]);
  });
});

describe("the parts of an answer", () => {
  it("are split at commas, semicolons and line breaks, never at 'and', each kept as typed", () => {
    expect(splitParts("Barbershop, plumbing, electrical")).toEqual(["Barbershop", "plumbing", "electrical"]);
    expect(splitParts(" Pet boarding and doggy daycare ;\r\n")).toEqual(["Pet boarding and doggy daycare"]);
    expect(matcher.match("Pet boarding and doggy daycare").map(brief)).toEqual([
      { words: "Pet boarding and doggy daycare", outcome: "listed", kinds: ["boarding"] },
    ]);
  });

  it("leave out a part that names no work (a greeting, a number), so words that name none give no part", () => {
    expect(matcher.match("")).toEqual([]);
    expect(matcher.match("Hi!")).toEqual([]);
    expect(matcher.match(" , ; 42")).toEqual([]);
    expect(matcher.match("Hi, Barbershop, 42").map(brief)).toEqual([
      { words: "Barbershop", outcome: "listed", kinds: ["barber"] },
    ]);
  });
});

describe("T-631's words rules, unchanged", () => {
  it("words: lower case, possessives and function words dropped, plurals folded", () => {
    expect(words("Lee's Barbershop: plumbing & electrical, 2 barbers!")).toEqual([
      "lee",
      "barbershop",
      "plumbing",
      "electrical",
      "barber",
    ]);
    expect([fold("plumbers"), fold("services"), fold("batteries"), fold("brushes"), fold("glass")]).toEqual([
      "plumber",
      "service",
      "battery",
      "brush",
      "glass",
    ]);
  });

  it("meets: the same word 1; one starting the other, or a shared start of 5, by its share of the longer word", () => {
    expect(meets("plumber", "plumber")).toBe(1);
    expect(meets("barbershop", "barber")).toBe(6 / 10);
    expect(meets("haircut", "hair")).toBe(4 / 7);
    expect(meets("plumbing", "plumber")).toBe(5 / 8);
    expect(meets("electrical", "electrician")).toBeGreaterThan(meets("electrical", "electronics"));
    expect([meets("cut", "cutting"), meets("water", "watch"), meets("lawn", "lawyer")]).toEqual([0, 0, 0]);
  });
});

/** The one sample word whose outcome T-1518 moves (its Gives 3: "haircuts and salon: hair"; everyday.ts). */
const MOVED_BY_T1518 = "haircut";

describe("T-631's method A, kept: the spike's 47 sample words give its table's A outcomes, but the one T-1518 moves", () => {
  it.each(SAMPLES.filter((each) => each.words !== MOVED_BY_T1518).map((each) => [each.words, each] as const))(
    "%s",
    (text, each) => {
      const part = onePart(text);
      const notBooked = each.group === "S1-02" && each.fits.length === 0;
      expect({ outcome: part.outcome, kinds: part.kinds.map((kind) => kind.kindId) }).toEqual(
        asMatchKinds(each.spikeA, notBooked),
      );
    },
  );

  it("'haircut' now lists Hair salon (T-1518 Gives 3), where the spike's A asked 'which?' with Hair restoration clinic", () => {
    expect(sample(MOVED_BY_T1518).spikeA).toEqual({ outcome: "which", kinds: ["hair", "hair-restoration"] });
    expect(brief(onePart(MOVED_BY_T1518))).toEqual({ words: "haircut", outcome: "listed", kinds: ["hair"] });
  });

  it("every kind offered carries its K-24 name", () => {
    const names = new Map(catalog.map((kind) => [kind.id, kind.name]));
    for (const each of SAMPLES) {
      for (const kind of onePart(each.words).kinds) expect(kind.name).toBe(names.get(kind.kindId));
    }
  });
});

describe("T-631's limit kept in view: a customer's request is not matched by meaning (journey 4: CQ-348 (1), before M5)", () => {
  it("of journey 4's words (A4-03, B4-04) none gets the kinds its step names, and of the cast's 20, 4 do", () => {
    const right = (keep: (each: Sample) => boolean): string[] =>
      SAMPLES.filter(keep)
        .filter((each) => isRight(each, onePart(each.words)))
        .map((each) => each.words);
    expect(right((each) => each.group === "A4-03" || each.group === "B4-04")).toEqual([]);
    expect(right((each) => each.group === "cast")).toEqual([
      "Book me a haircut at Lee's Barbershop on Saturday.",
      "Can Lee's Barbershop do a haircut on Saturday morning? What does it cost?",
      "My kitchen drain is clogged. Can a plumber come Thursday morning? I'm in Springfield.",
      "Can a plumber clear a yard drain this Thursday? What does it cost?",
    ]);
  });

  it("none of the 12 sample words that fit two kinds (all customers') gets its 'which?' pair", () => {
    const pairs = SAMPLES.filter((each) => each.fits.length === 2);
    expect(pairs).toHaveLength(12);
    expect(pairs.filter((each) => isRight(each, onePart(each.words)))).toEqual([]);
  });
});

describe("the kinds list the matcher reads", () => {
  const kind = (id: string, source = TRADE_FILE, name = "Barber"): CatalogKind => ({
    id,
    name,
    style: "Chair",
    pattern: "chair",
    source,
  });

  it("is refused when it holds no trade-file kind, repeats an id, or holds an id not in K-24's form or a blank name", () => {
    expect(() => createKindMatcher([])).toThrow(KindCatalogError);
    expect(() => createKindMatcher([kind("new-pack-hikes", "new_work")])).toThrow(KindCatalogError);
    expect(() => createKindMatcher([kind("barber"), kind("barber")])).toThrow(/twice/u);
    expect(() => createKindMatcher([kind("Barber")])).toThrow(/K-24's form/u);
    expect(() => createKindMatcher([kind("barber", TRADE_FILE, " ")])).toThrow(/no name/u);
  });

  it("is read as handed in: over K-24 v1's eight sample kinds, work not in the list is new work", () => {
    const eight = createKindMatcher(k24Kinds("seed-kinds-sample.json"));
    expect(eight.size).toBe(8);
    expect(eight.match("Barbershop, plumbing, Swim school").map(brief)).toEqual([
      { words: "Barbershop", outcome: "listed", kinds: ["barber"] },
      { words: "plumbing", outcome: "listed", kinds: ["plumber"] },
      { words: "Swim school", outcome: "new_work", kinds: [] },
    ]);
  });
});
