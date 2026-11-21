// Inputs for the kind matcher's tests (T-632). Never imported by the Worker. No database and no model.
//   - The catalog: the 243 kinds rows the kinds seed writes (T-212, db/seeds/kinds.ts kindsPlanOf), planned from fixture
//     set v1 and the trade files, each set checked against its sha256 list before a file is parsed, as the seed checks
//     them; the rows' id, name, style, pattern and source, as K-24 v1 kinds holds them (README line 41).
//   - K-24 v1's frozen fixtures (contracts/db-schema/kinds-of-work/fixtures/): seed-business-kinds.json's picks (Sam's
//     S1-02 answer) and seed-new-work-draft.json's pick and drafted kind ("pack hikes").
//   - The sample words of T-631's spike (actions/spikes/q42-kind-matcher/samples.mjs, copied here word for word with the
//     kinds each fits by its step's words), and each one's outcome under method A in the spike's own table
//     (FINDINGS.md "Each sample", the A column; "none" there is K-09's new_work or not_booked).
//   - The texting guide's 1,344 inputs with the outcomes the matcher gave them before T-1518 (kinds-guide.json, built from
//     ops/reviews/kinds-guide/kinds-matcher.json, DL-1042: every row reproduced by the matcher before T-1518's change).
//     They are kind names and owner-style words for a kind of work, never a person or a phone number.
// Every name in them is the master's sample cast or a fixture's demo shop (Sam Lee; Lee's Barbershop; Jordan; Lee Home
// Services in Springfield), never a real person, and no phone number is used (rule 9).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { kindsPlanOf, openTradeSet, verifyTradeSet } from "../../../../db/seeds/kinds";
import { openFixtureSet, verifyFixtureSet } from "../../../../db/seeds/lib/fixture-set";
import type { CatalogKind, KindOutcome } from "./matcher";

/** The kinds rows the kinds seed (T-212) writes, as the matcher reads them. */
export function seededKinds(): CatalogKind[] {
  const plan = kindsPlanOf(verifyFixtureSet(openFixtureSet()), verifyTradeSet(openTradeSet()));
  return plan.rows.kinds.map((row) => ({
    id: row.id,
    name: row.name,
    style: row.style,
    pattern: row.pattern,
    source: row.source,
  }));
}

// ---- K-24 v1's frozen fixtures --------------------------------------------------------------------------------------

const K24_FIXTURES = fileURLToPath(
  new URL("../../../../contracts/db-schema/kinds-of-work/fixtures/", import.meta.url),
);

interface FixtureRow {
  readonly table: string;
  readonly values: Readonly<Record<string, unknown>>;
}

/** One K-24 v1 fixture file's own rows (its `after` chain is not read). */
export function k24Rows(file: string): FixtureRow[] {
  const parsed = JSON.parse(readFileSync(`${K24_FIXTURES}${file}`, "utf8")) as { rows?: FixtureRow[] };
  return parsed.rows ?? [];
}

/** A K-24 v1 picked_kinds row: the owner's words, the outcome picked and the kind (null for not_booked). */
export interface FixturePick {
  readonly position: number;
  readonly words: string;
  readonly outcome: string;
  readonly kindId: string | null;
}

/** A fixture's picked_kinds rows, in the order of their position. */
export function k24Picks(file: string): FixturePick[] {
  return k24Rows(file)
    .filter((row) => row.table === "picked_kinds")
    .map(({ values }) => ({
      position: Number(values.position),
      words: String(values.words),
      outcome: String(values.outcome),
      kindId: typeof values.kind_id === "string" ? values.kind_id : null,
    }))
    .sort((a, b) => a.position - b.position);
}

/** A fixture's kinds rows, as the matcher reads them. */
export function k24Kinds(file: string): CatalogKind[] {
  return k24Rows(file)
    .filter((row) => row.table === "kinds")
    .map(({ values }) => ({
      id: String(values.id),
      name: String(values.name),
      style: String(values.style),
      pattern: String(values.pattern),
      source: String(values.source),
    }));
}

// ---- T-631's sample words ---------------------------------------------------------------------------------------------

/** The spike's groups: S1-02 and its nine trades' words (owners), A4-03 and B4-04 (journey 4), the master's cast. */
export type SampleGroup = "S1-02" | "S1-02 trades" | "A4-03" | "B4-04" | "cast";

/** The outcome method A gave in the spike's table: listed or which with its kinds, or none. */
export interface SpikeOutcome {
  readonly outcome: "listed" | "which" | "none";
  readonly kinds: readonly string[];
}

export interface Sample {
  readonly group: SampleGroup;
  readonly words: string;
  /** The kinds the step's words fit (K-24 ids): one, two (a "which?" first) or none (not a service Rosie books). */
  readonly fits: readonly string[];
  readonly source: string;
  /** Method A's outcome in FINDINGS.md "Each sample". */
  readonly spikeA: SpikeOutcome;
}

const listed = (kind: string): SpikeOutcome => ({ outcome: "listed", kinds: [kind] });
const which = (first: string, second: string): SpikeOutcome => ({ outcome: "which", kinds: [first, second] });
const none: SpikeOutcome = { outcome: "none", kinds: [] };

/** The 47 sample words of T-631, in its order. */
export const SAMPLES: readonly Sample[] = [
  // S1-02, flow A: "Sam types the kinds of work in any words"; K-24 v1's seed-business-kinds.json picks these three.
  { group: "S1-02", words: "Barbershop", fits: ["barber"], source: "S1-02", spikeA: listed("barber") },
  { group: "S1-02", words: "plumbing", fits: ["plumber"], source: "S1-02", spikeA: listed("plumber") },
  {
    group: "S1-02",
    words: "electrical",
    fits: ["electrician"],
    source: "S1-02",
    spikeA: listed("electrician"),
  },
  // S1-02's "Means 'Not a service we book'" and "Gift cards are never set up either" (RULES 1.4; S1-74).
  { group: "S1-02", words: "Gift cards", fits: [], source: "S1-02", spikeA: listed("cardiologist") },
  {
    group: "S1-02",
    words: "goods with no visit",
    fits: [],
    source: "S1-02",
    spikeA: which("electrician", "handyman"),
  },
  { group: "S1-02", words: "delivery only", fits: [], source: "S1-02", spikeA: none },
  { group: "S1-02", words: "renting a thing alone", fits: [], source: "S1-02", spikeA: none },

  // S1-02's answer as nine trade files word it (the owner's line renamed), each part that names one kind.
  {
    group: "S1-02 trades",
    words: "Overnight camp",
    fits: ["camp"],
    source: "S1-02 camp",
    spikeA: listed("camp"),
  },
  {
    group: "S1-02 trades",
    words: "backyard camps",
    fits: ["camp"],
    source: "S1-02 camp",
    spikeA: listed("camp"),
  },
  {
    group: "S1-02 trades",
    words: "Golf academy",
    fits: ["golf-instructor"],
    source: "S1-02 golf-instructor",
    spikeA: listed("golf-instructor"),
  },
  {
    group: "S1-02 trades",
    words: "golf lessons",
    fits: ["golf-instructor"],
    source: "S1-02 golf-instructor",
    spikeA: which("golf-instructor", "music"),
  },
  {
    group: "S1-02 trades",
    words: "course coaching",
    fits: ["golf-instructor"],
    source: "S1-02 golf-instructor",
    spikeA: which("tennis-coach", "coach"),
  },
  {
    group: "S1-02 trades",
    words: "party rentals",
    fits: ["rentals"],
    source: "S1-02 rentals",
    spikeA: listed("rentals"),
  },
  {
    group: "S1-02 trades",
    words: "Ski school",
    fits: ["ski-instructor"],
    source: "S1-02 ski-instructor",
    spikeA: listed("ski-instructor"),
  },
  {
    group: "S1-02 trades",
    words: "ski lessons",
    fits: ["ski-instructor"],
    source: "S1-02 ski-instructor",
    spikeA: which("ski-instructor", "music"),
  },
  {
    group: "S1-02 trades",
    words: "snowboard lessons",
    fits: ["ski-instructor"],
    source: "S1-02 ski-instructor",
    spikeA: which("ski-instructor", "music"),
  },
  {
    group: "S1-02 trades",
    words: "private coaching",
    fits: ["sports-coach"],
    source: "S1-02 sports-coach",
    spikeA: listed("sports-coach"),
  },
  {
    group: "S1-02 trades",
    words: "Surf school",
    fits: ["surf-school"],
    source: "S1-02 surf-school",
    spikeA: listed("surf-school"),
  },
  {
    group: "S1-02 trades",
    words: "Swim school",
    fits: ["swim"],
    source: "S1-02 swim",
    spikeA: listed("swim"),
  },
  {
    group: "S1-02 trades",
    words: "Training studio",
    fits: ["trainer"],
    source: "S1-02 trainer",
    spikeA: which("cpr-training", "dog-trainer"),
  },
  {
    group: "S1-02 trades",
    words: "personal training",
    fits: ["trainer"],
    source: "S1-02 trainer",
    spikeA: listed("trainer"),
  },
  {
    group: "S1-02 trades",
    words: "massage",
    fits: ["massage"],
    source: "S1-02 trainer",
    spikeA: listed("massage"),
  },

  // A4-03 (flow A) and B4-04 (flow B): journey 4's words, the master's own and its trades'.
  {
    group: "A4-03",
    words: "haircut",
    fits: ["hair", "barber"],
    source: "A4-03 'a salon or a barbershop'",
    spikeA: which("hair", "hair-restoration"),
  },
  {
    group: "A4-03",
    words: "facial",
    fits: ["barber", "esthetician"],
    source: "A4-03 barber 'a barbershop or a skin care studio'",
    spikeA: none,
  },
  {
    group: "B4-04",
    words: "clog",
    fits: ["plumber"],
    source: "B4-04 'where the clog or leak is'",
    spikeA: none,
  },
  {
    group: "B4-04",
    words: "leak",
    fits: ["plumber"],
    source: "B4-04 'where the clog or leak is'",
    spikeA: none,
  },
  {
    group: "B4-04",
    words: "water heater",
    fits: ["plumber", "hvac"],
    source: "B4-04 plumber 'a plumber or a heating tech'",
    spikeA: listed("restoration"),
  },

  // The master's cast, flow A (Lee's Barbershop): the customers' and their AIs' requests, then the sample services.
  {
    group: "cast",
    words: "Book me a haircut at Lee's Barbershop on Saturday.",
    fits: ["barber"],
    source: "A3-02",
    spikeA: listed("barber"),
  },
  {
    group: "cast",
    words: "Walk-in for a haircut",
    fits: ["hair", "barber"],
    source: "A3-20",
    spikeA: which("dog-walker", "hair"),
  },
  {
    group: "cast",
    words: "Can Lee's Barbershop do a haircut on Saturday morning? What does it cost?",
    fits: ["barber"],
    source: "A3-27",
    spikeA: listed("barber"),
  },
  {
    group: "cast",
    words: "Groom's package",
    fits: ["barber"],
    source: "master-A",
    spikeA: listed("groomer"),
  },
  {
    group: "cast",
    words: "Signature cut and hot towel shave",
    fits: ["barber"],
    source: "master-A",
    spikeA: listed("pool-builder"),
  },
  {
    group: "cast",
    words: "Style consult",
    fits: ["hair", "barber"],
    source: "master-A",
    spikeA: which("college-admissions", "architect"),
  },
  { group: "cast", words: "Color and cut", fits: ["hair", "barber"], source: "master-A", spikeA: none },
  { group: "cast", words: "Color touch-up", fits: ["hair", "barber"], source: "master-A", spikeA: none },
  { group: "cast", words: "Color correction", fits: ["hair", "barber"], source: "master-A", spikeA: none },

  // The master's cast, flow B (Lee Home Services): the customers' and their AIs' requests, then the sample services.
  {
    group: "cast",
    words: "My kitchen drain is clogged. Can a plumber come Thursday morning? I'm in Springfield.",
    fits: ["plumber"],
    source: "B3-02",
    spikeA: listed("plumber"),
  },
  {
    group: "cast",
    words: "Hi, it's about a leaking pipe under my sink. A text back is fine.",
    fits: ["plumber"],
    source: "B3-42",
    spikeA: none,
  },
  {
    group: "cast",
    words: "Can a plumber clear a yard drain this Thursday? What does it cost?",
    fits: ["plumber"],
    source: "B3-05",
    spikeA: listed("plumber"),
  },
  {
    group: "cast",
    words: "Can you flush my water heater every year, too?",
    fits: ["plumber", "hvac"],
    source: "B4-44",
    spikeA: listed("restoration"),
  },
  {
    group: "cast",
    words: "Can Jordan also look at a dripping faucet?",
    fits: ["plumber"],
    source: "B4-48",
    spikeA: none,
  },
  { group: "cast", words: "Kitchen drain clearing", fits: ["plumber"], source: "master-B", spikeA: none },
  {
    group: "cast",
    words: "Water heater flush",
    fits: ["plumber", "hvac"],
    source: "master-B",
    spikeA: listed("restoration"),
  },
  {
    group: "cast",
    words: "Water pressure check",
    fits: ["plumber"],
    source: "master-B",
    spikeA: listed("pressure"),
  },
  {
    group: "cast",
    words: "Water heater replacement",
    fits: ["plumber", "hvac"],
    source: "master-B",
    spikeA: listed("restoration"),
  },
  {
    group: "cast",
    words: "Water heater fix",
    fits: ["plumber", "hvac"],
    source: "master-B",
    spikeA: which("restoration", "tv-repair"),
  },
  {
    group: "cast",
    words: "Leak repair",
    fits: ["plumber"],
    source: "master-B",
    spikeA: which("tv-repair", "appliance"),
  },
];

// ---- The texting guide's run (T-1518; DL-1042) ----------------------------------------------------------------------

/**
 * One input of the texting guide's run (ops/reviews/kinds-guide/kinds-matcher.json, copied as kinds-guide.json): the kind
 * it was written for, the input as typed, and the outcome the matcher gave it before T-1518, as the guide records it.
 */
export interface GuideInput {
  readonly kindId: string;
  readonly text: string;
  /** listed (one kind), which (two), new_work (none), or parts (parts that do not all list one kind). */
  readonly outcome: string;
  /** The kinds, closest first; for parts, each part as `outcome:kind,kind`. */
  readonly kinds: readonly string[];
}

const GUIDE_FILE = fileURLToPath(new URL("./kinds-guide.json", import.meta.url));

/** The guide's 1,344 inputs, in its order: by kind name, then the name, its lower case and its variants (variants.json). */
export function guideInputs(): GuideInput[] {
  const parsed = JSON.parse(readFileSync(GUIDE_FILE, "utf8")) as { inputs?: unknown };
  if (!Array.isArray(parsed.inputs)) throw new Error("kinds-guide.json: no inputs");
  return (parsed.inputs as unknown[]).map((row, index) => {
    if (!Array.isArray(row) || row.length < 3 || !row.every((cell) => typeof cell === "string")) {
      throw new Error(`kinds-guide.json: input ${String(index)} is not [kind id, text, outcome, ...kinds]`);
    }
    const [kindId, text, outcome, ...kinds] = row;
    return { kindId: kindId ?? "", text: text ?? "", outcome: outcome ?? "", kinds };
  });
}

/** The outcome K-09 matchKinds answers for a spike outcome: its "none" is new_work, unless the words are not booked. */
export function asMatchKinds(
  spike: SpikeOutcome,
  notBooked: boolean,
): { outcome: KindOutcome; kinds: string[] } {
  if (notBooked) return { outcome: "not_booked", kinds: [] };
  if (spike.outcome === "none") return { outcome: "new_work", kinds: [] };
  return { outcome: spike.outcome, kinds: [...spike.kinds] };
}
