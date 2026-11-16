// T-140, C7: trade text that says Rosie or Rosie's team checks, looks up or has read a license, permit, certificate,
// insurance or carrier status is the business's own word (MC C7; D96; RULES 10.1; S13-11); so is a free-text pf rule
// that waits on a paper that "checks out", or says one is "checked like a license", and names no one who checks (the
// lead's ruling on MC C7's count, DL-884), and a pf rule with another passive wording of a paper checked by no one named
// (its ruling on round 2's open question 1, DL-894). Proofs of the card that belong to C7:
//   - over all 243 trades, C7 flags the texts in the snapshot below, MC C7's five examples among them (acupuncturist,
//     camp, movers, tree, dog-walker), in 102 trade files: 61 whose texts name Rosie or Rosie's team as the one who
//     checks (c7.ts CLAIM_PATTERNS), and 41 more whose pf blocks only wait on, or show, a paper checked by no one named
//     (c7.ts PASSIVE_PATTERNS). The counts by round: run 1 counted 31 trade files (CLAIM_PATTERNS alone); round 2, 59
//     (the 28 passive files of DL-884: the pf.license blocks of 19 building trades; appraiser, energy-audit,
//     home-engineer, inspector, surveyor, locksmith, towing, property-manager and gym); round 3, 102 (DL-894):
//       a negation no longer reaches across a clause break, so "Where a lookup has no data feed, a person on Rosie's
//       team checks within 1 business day" (movers.json at S1-38, the security reviewer's FAIL) and the pf.license.check
//       rule "where there's none, a person on Rosie's team checks within 1 business day" of 15 repair trades are claims;
//       PAPER also reads the place a paper is checked where a lookup has no feed (a data feed, the state's own site, the
//       state's records, the city), which the line "Where a state has no data feed, a person on Rosie's team checks the
//       state's own site and keeps a screenshot" names in the words ops of 20 trades; with notary's, 30 files more
//       name Rosie or Rosie's team (61), and property-manager leaves the passive-only list;
//       PASSIVE_PATTERNS reads the other passive wordings: 14 files more (coach, cpa, dog-trainer, electrician,
//       funeral, gunsmith, hvac, lash-brow, lawyer, limo, pool-builder, realtor, speech-therapist, trainer), 41 in all.
//     MC C7 says the Nov 4 check listed 45 such trade files; that list is not available, so this build pins its own
//     count, 102, each phrase with its trade file's example in c7.ts (never padded or trimmed to 45);
//   - after it, no text a trade's compiled overlay holds says Rosie or Rosie's team checks a paper, no pf block waits on
//     or shows a paper no one named checks, and each text it flagged carries the C7 marker, the rest of each text as
//     written; the business's own word ("Rosie never looks a license up") is left as it is. Checked apart from
//     findClaims too: no compiled text keeps a negating clause, a comma, then Rosie or Rosie's team checks (38 trade
//     files had one), and a person on Rosie's team still checks in three texts only, fraud and cap flags that name no
//     paper;
//   - in the bundle, the compiled overlays of the five example trades, two passive ones (concrete, gym) and two of
//     DL-894's (carpet, hvac) say no such thing, and each flagged pf block carries the marker;
//   - a rename's or swap's first side (the master's own line) and a branch label are never changed: hair-restoration,
//     iv-hydration and plastic-surgeon keep the master's S1-38 lines ("Where a lookup has no data feed, a person on
//     Rosie's team checks ...") on their renames' first sides; a claim in a message a person reads stops the build;
//   - every change is tagged MC:C7, and C7 changes no step in the frame.
// Not here: an op's words that wait on a paper that checks out (movers' junk hauling, driving-school's learner's permit)
// belong to a step that waits, CQ-347's; C7 reads a passive wait in the pf blocks alone. S1-33's lines in Rosie's own
// voice ("We couldn't find barbershop license BS20981 ... on the state's lookup ... until our team checks it within 1
// business day": 25 trade files rename the master's line, laundry, shoe-repair and upholstery keeping "our team checks
// it", and 9 carry it in the say messages of words ops at S1-33, round 2's count) sit on C4's verify-only branch, switched
// off while verify is off, so no person reads them; C4 and T-147's markers cover them, and C7 leaves them as written
// (DL-894).
import { describe, expect, it, vi } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { buildBundle } from "../emit";
import { loadMaster } from "../load/flow";
import { listTradeIds, loadTrade, type LoadedTrade, type TradeOp } from "../load/trade";
import { applyTrade } from "../overlay/apply";
import {
  C7ClaimError,
  C7_MARKER,
  CLAIM_PATTERNS,
  OWN_WORD,
  WORD_PATTERNS,
  c7,
  findClaims,
  markClaims,
  ownWord,
  patternsAt,
  renderMarks,
  type MarkedTrade,
} from "./c7";
import { applyCorrections } from "./framework";

vi.setConfig({ testTimeout: 600_000 });

const FLOWS: readonly FlowLetter[] = ["A", "B"];
const ALL = listTradeIds();
const master = loadMaster();

/** MC C7's five examples: the trade and the text it names. */
const EXAMPLES: readonly (readonly [trade: string, where: string])[] = [
  ["acupuncturist", "pluginText.pf.license.check"],
  ["camp", "pluginText.pf.staff.license"],
  ["movers", "pluginText.pf.license.status_any_day"],
  ["tree", "pluginText.pf.license.trust"],
  ["dog-walker", "A ops[75].more[0]"],
];

/** Two pf rules that wait on a paper no one named checks (the lead's ruling, DL-884): the trade and the text. */
const PASSIVE_EXAMPLES: readonly (readonly [trade: string, where: string])[] = [
  ["concrete", "pluginText.pf.license.blocks[0]"],
  ["gym", "pluginText.pf.license.coachCertificate"],
];

/**
 * Two texts DL-894 marks: a claim after a negating clause, in a words op's line that names no paper itself (carpet, as
 * 21 more trades), and a pf rule with another passive wording (hvac).
 */
const ROUND3_EXAMPLES: readonly (readonly [trade: string, where: string])[] = [
  ["carpet", "A ops[0].more[1]"],
  ["hvac", "pluginText.pf.license.local rules"],
];

/** The 41 trade files C7 flags for a pf rule that waits on, or shows, a paper no one named checks, and for nothing else. */
const PASSIVE_ONLY: readonly string[] = [
  "appraiser",
  "closets",
  "coach",
  "concrete",
  "contractor",
  "cpa",
  "deck",
  "demolition",
  "dog-trainer",
  "drywall",
  "electrician",
  "energy-audit",
  "excavation",
  "foundation",
  "funeral",
  "glass-doors",
  "gunsmith",
  "gutters",
  "gym",
  "home-engineer",
  "hvac",
  "inspector",
  "insulation",
  "irrigation",
  "lash-brow",
  "lawyer",
  "limo",
  "locksmith",
  "masonry",
  "painter",
  "paving",
  "pool-builder",
  "radon",
  "realtor",
  "roofer",
  "security",
  "siding",
  "speech-therapist",
  "surveyor",
  "towing",
  "trainer",
];

/**
 * The security reviewer's 25 trade files (round 2's FAIL): a negating clause, a comma, then a person on Rosie's team or
 * Rosie checks. 22 hold it in their own words; the last 3 only on a rename's first side, the master's own S1-38 line.
 */
const REVIEWER_OWN_WORDS: readonly string[] = [
  "advisor",
  "carpet",
  "chef",
  "cleaner",
  "commercial-cleaning",
  "dog-walker",
  "driving-school",
  "duct-cleaning",
  "hearing",
  "holiday-lights",
  "insurance",
  "mortgage",
  "pharmacist",
  "pool",
  "pressure",
  "primary-care",
  "property-manager",
  "repair-shop",
  "snow",
  "tax",
  "wildlife",
  "windows",
];
const REVIEWER_FIRST_SIDES: readonly string[] = ["hair-restoration", "iv-hydration", "plastic-surgeon"];

/** The 38 trade files whose own words hold that shape before C7: the reviewer's 22, movers, notary and 14 repair trades' pf.license.check. */
const NEGATED_CLAUSE_FILES: readonly string[] = [
  "advisor",
  "auto-body",
  "auto-repair",
  "boat-repair",
  "carpet",
  "chef",
  "cleaner",
  "commercial-cleaning",
  "dog-walker",
  "driving-school",
  "duct-cleaning",
  "groomer",
  "hearing",
  "holiday-lights",
  "instrument-repair",
  "insurance",
  "mortgage",
  "motorcycle",
  "movers",
  "notary",
  "pharmacist",
  "pool",
  "pressure",
  "primary-care",
  "property-manager",
  "repair-shop",
  "rv-repair",
  "sharpening",
  "small-engine",
  "snow",
  "tax",
  "tires",
  "vehicle-inspection",
  "vehicle-wrap",
  "watch-jewelry",
  "wildlife",
  "window-tint",
  "windows",
];

const memo = new Map<string, { trade: LoadedTrade; done: MarkedTrade }>();
function marked(id: string): { trade: LoadedTrade; done: MarkedTrade } {
  let hit = memo.get(id);
  if (hit === undefined) {
    const trade = loadTrade(id);
    hit = { trade, done: markClaims(trade) };
    memo.set(id, hit);
  }
  return hit;
}

/**
 * Every string of a value with its path, but not a rename's or a swap's first side: the master's own line it matches
 * (the master's verify-only steps say Rosie checks; C4 switches them off and T-147 marks them).
 */
function texts(value: unknown, path: string, out: { path: string; text: string }[] = []): typeof out {
  if (typeof value === "string") out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((item, k) => texts(item, `${path}[${String(k)}]`, out));
  else if (typeof value === "object" && value !== null)
    for (const [key, item] of Object.entries(value)) {
      if ((key === "swap" || key === "rename") && Array.isArray(item))
        item.forEach((pair, k) => {
          if (Array.isArray(pair)) texts(pair[1], `${path}.${key}[${String(k)}][1]`, out);
        });
      else texts(item, `${path}.${key}`, out);
    }
  return out;
}

/** The texts of a loaded trade the compiled overlay holds: its pf blocks, and per flow its ops, renames, slot rows and money. */
function tradeTexts(trade: LoadedTrade): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const [name, block] of Object.entries(trade.pluginText))
    texts(JSON.parse(block) as unknown, `pluginText.${name}`, out);
  for (const flow of FLOWS) {
    const part = trade.flows[flow];
    texts({ ops: part.ops, rename: part.rename, slotRows: part.slotRows, money: part.money }, flow, out);
  }
  return out;
}

describe("what C7 counts as a claim", () => {
  it("finds MC C7's examples, and a paper checked by Rosie, on a lookup, read or seen", () => {
    for (const text of [
      "a person on Rosie's team checks within 1 business day when the lookup can't be read",
      "each number on the state board's official lookup",
      "the camp nurse's nursing license, checked on the state's lookup",
      "A carrier's status can change any day. Rosie re-checks it on the plug-in's schedule: before the business is offered.",
      "'Certified arborist' or 'insured' shows only once Rosie has read the certificate or the official lookup",
      "Where a permit is required, Quinn leads hikes only once Rosie's team checks it with the city, and Sam says yes.",
      "Licenses: Checked by Rosie on the state's lookup, Oct 19",
      "Rosie reminds 30 days before a permit's date and checks again on it",
      "Industry certificates show only as the business's own words, unless Rosie saw them on the certifier's own lookup.",
      "A PTIN has no public lookup: the preparer uploads the IRS's PTIN letter, and a person on Rosie's team reads it.",
    ])
      expect(findClaims(text), text).toHaveLength(1);
  });

  it("reads a claim after a negating clause, and the place a paper is checked where a lookup has no feed (DL-894)", () => {
    // A negation never reaches across a clause break (a comma, a semicolon or a sentence end): the "no" belongs to the
    // first clause, and the second says Rosie's team checks.
    for (const text of [
      "Where a lookup has no data feed, a person on Rosie's team checks within 1 business day.",
      "Where a state has no data feed, a person on Rosie's team checks the state's own site and keeps a screenshot.",
      "Where there's no data feed, a person on Rosie's team checks within 1 business day.",
      "Where a state has no lookup, a person on Rosie's team checks the state's own site and keeps a screenshot.",
      "the state's license lookup; where there's none, a person on Rosie's team checks within 1 business day",
      "Not back in 1 business day: a person on Rosie's team checks the state's records another way, and Sam is told.",
      "Not back in 1 business day: a person on Rosie's team checks with the city another way, and Sam is told.",
    ])
      expect(findClaims(text), text).toHaveLength(1);
    expect(
      ownWord("Where a lookup has no data feed, a person on Rosie's team checks within 1 business day."),
    ).toBe(OWN_WORD);
    // A negation inside the claim's own clause still takes it back; a check of no paper is no claim.
    for (const text of [
      "Where the city requires a park permit for group walks, Rosie checks no permit; the owner says when one lapses.",
      "anything shown is as given by the business, not checked by Rosie",
      "It never accuses anyone: it tells Sam, and a person on Rosie's team checks.",
      "Sam sees the flag, and a person on Rosie's team checks it within 1 business day.",
      "Rosie looks nothing up, so no screenshot is kept.",
    ])
      expect(findClaims(text, WORD_PATTERNS), text).toStrictEqual([]);
  });

  it("leaves the business's own word, a negation, a check of no paper and a text that names no paper", () => {
    for (const text of [
      "Rosie never looks a license up or says one is checked.",
      "none: Rosie never looks up, checks or confirms a license, insurance or registration (D96); anything shown is as given by the business, not checked by Rosie",
      "none: nothing is looked up; Rosie never says a certificate was checked by Rosie",
      "Where the city requires a park permit for group walks, Rosie checks no permit; the owner says when one lapses.",
      "Where the form licenses work only above a job size, Rosie checks each job against it: at booking.",
      "Rosie checks this before the secure page, so the page knows what to ask. Other insurance needs none.",
      "Sam says yes, with a change. Rosie reads it back, then asks Alex. Only a licensed seller holds this meeting.",
      "The classroom course's certificate is ready by a date. Rosie checks the date, and the desk texts READY.",
      "Rosie checks the calendar before a time is offered.",
      "Rosie looks up no licenses or checks (D96): nothing to re-check for band work.",
      OWN_WORD,
    ])
      expect(findClaims(text), text).toStrictEqual([]);
  });

  it("reads a wait on a paper that checks out, or one checked like a license, as a claim in a pf block alone", () => {
    const passive = [
      "No concrete work goes live until the company's registration or license checks out, where one is required",
      "A job above the owner's job-size limit is not offered until the firm's license checks out, where the state's form requires one",
      "Where the state licenses appraisers: no appraisal is offered until the company's and the appraiser's numbers check out.",
      "A person whose license doesn't check out is never sent.",
      "Where the state's form says a license is needed and none checks out, the work stays offline in that state.",
      "No moving goes live until the company's authority or permit checks out",
      "a switch from the state's form: where the state requires a certificate for a fitness coach, it's asked and checked like a license;",
      "the studio's number and each designer's are checked like any license.",
    ];
    for (const text of passive) {
      expect(findClaims(text, WORD_PATTERNS), text).toHaveLength(1);
      expect(findClaims(text), text).toStrictEqual([]);
    }
    expect(patternsAt("pluginText.pf.license.blocks[0]")).toBe(WORD_PATTERNS);
    expect(patternsAt("A ops[11].does")).toBe(CLAIM_PATTERNS);
    expect(patternsAt("B rename[7][1]")).toBe(CLAIM_PATTERNS);
    // An op's words that wait on a permit belong to a step that waits (CQ-347's): read with CLAIM_PATTERNS, they stay.
    expect(
      findClaims(
        "Junk hauling is set up, under the company's hauler permit. AI assistants can book it once the permit checks out.",
        patternsAt("A ops[11].say[2][2]"),
      ),
    ).toStrictEqual([]);
    for (const text of [
      "Nothing. No license is checked, so nothing waits on one.",
      "Nothing. No license is required and none is checked, so nothing waits on one.",
      "For movers, a driver whose truck's weight needs a commercial license gives it here, shown as given like a license, not checked.",
      "Any fact the state's rules require, like a license number, is on it.",
      "Rosie never says a license, certificate or insurance is confirmed; anything shown is the business's own word.",
      OWN_WORD,
    ])
      expect(findClaims(text, WORD_PATTERNS), text).toStrictEqual([]);
    expect(
      ownWord(
        "a switch from the state's form: where the state requires a certificate for a fitness coach, it's asked and checked like a license; otherwise a coach's certificate and CPR card are the business's word",
        WORD_PATTERNS,
      ),
    ).toBe(`${OWN_WORD} otherwise a coach's certificate and CPR card are the business's word`);
  });

  it("reads the other passive wordings of a paper checked by no one named as a claim in a pf block alone (DL-894)", () => {
    const passive = [
      "Where the state has no HVAC license, or licenses only some work, the city's or county's license is checked, by the customer's address.",
      "Where only a city or county licenses home electrical work, the license for the job's address is the one checked.",
      "No person license unless the state's form licenses designers for business spaces or a protected title. Then each one's number is checked before that work.",
      "A firewood, wood chip and mulch yard needs no state license; its business registration is checked.",
      "the company's license holder; electricians and plumbers each licensed where the rules require it; subcontractors' licenses checked before they're named on a job",
      "none for trainers or walkers; a certificate shows only once checked",
      "a national certificate is shown only once checked, and never counts as a state license",
      "the federal firearms license number (shown only as 'checked' once it is)",
      "where the state's form exempts brow threading, a threader is checked for what the form asks instead (an ID, a course, insurance) and is offered for threading only",
      "Checked on each renewal date from the state form; a lapsed license pauses that person's CPA-only bookings, and Sam is told.",
      "Checked each year, and on the date from the state's form. A lapsed registration pauses that adviser's bookings, and Sam is told.",
      "a certificate for each inspector who runs and signs a result, where the state's rules require one; checked at sign-up and re-checked",
      "Credentials show exactly as checked. An enrolled agent is never called 'certified'. A preparer with no credential shows as 'tax preparer'.",
      "The business registration number. A coaching credential a coach lists is their own word, shown as 'as stated' unless it's checked.",
      "a trainer's certificate (like NASM, ACE, NSCA or ACSM) and a CPR and AED card are what the business says; shown as the business's word unless checked, never as a license",
      "a coach's certificate and CPR card: a switch from the state's form (checked where required, otherwise the gym's word)",
      "identity checked; customers see no permit claim until it's confirmed",
    ];
    for (const text of passive) {
      expect(findClaims(text, WORD_PATTERNS), text).toHaveLength(1);
      expect(findClaims(text), text).toStrictEqual([]);
    }
    expect(
      ownWord("identity checked; customers see no permit claim until it's confirmed", WORD_PATTERNS),
    ).toBe(`identity checked; ${OWN_WORD}`);
    // A negation takes the check back, and a check of no business paper (an identity, a customer's record or ID, a job
    // against the license, a staff skill) is no claim.
    for (const text of [
      "no person license is checked for golf lessons; no engineer license is checked (D96);",
      "each acupuncturist's national board certificate kept on file as the business's own word, never shown as checked (Rosie's rule)",
      "Rosie shows nothing as checked, and never says a license is checked.",
      "Where none is required: identity checked, and 'license: what the business says'.",
      "a rabies certificate on file is checked for each later booking, repeat grooms too; asked again only if it runs out before the visit",
      "wear clothes you can kneel in; bring a photo ID (the card's name is checked against it); bring the online certificate for a blended course",
      "Where a license stops at a job size or a kind of work, each quote and extra job is checked against it before it's sent.",
      "Errands in a car, with an insured vehicle and a checked driver's license",
    ])
      expect(findClaims(text, WORD_PATTERNS), text).toStrictEqual([]);
  });

  it("replaces each run of claim sentences with OWN_WORD and keeps the text's other sentences", () => {
    expect(
      ownWord(
        "each number on the state board's official lookup; a person on Rosie's team checks within 1 business day when the lookup can't be read; the national board certificate and a clean-needle course record are kept on file as the business's own word",
      ),
    ).toBe(
      `${OWN_WORD} the national board certificate and a clean-needle course record are kept on file as the business's own word`,
    );
    expect(
      ownWord(
        "A carrier's status can change any day (an out-of-service order, a revoked authority). Rosie re-checks it on the plug-in's schedule: before the business is offered, and before an estimate or a deposit goes out.",
      ),
    ).toBe(
      `A carrier's status can change any day (an out-of-service order, a revoked authority). ${OWN_WORD}`,
    );
    expect(OWN_WORD).toContain(C7_MARKER);
    expect(ownWord(OWN_WORD)).toBe(OWN_WORD);
    expect(ownWord("Rosie never looks a license up.")).toBe("Rosie never looks a license up.");
  });
});

describe("C7 over all 243 trades", () => {
  it("flags the texts below, MC C7's five examples among them, in 102 trade files: 61 that name Rosie or Rosie's team, 41 more with a passive wording (run 1: 31; round 2: 59; MC C7: the Nov 4 check listed 45)", () => {
    expect(ALL).toHaveLength(243);
    const flagged: Record<string, string[]> = {};
    const namesRosie: string[] = [];
    for (const id of ALL) {
      const { done } = marked(id);
      const where = done.marked.map((one) => one.where);
      if (where.length > 0) flagged[id] = where;
      if (done.marked.some((one) => findClaims(one.before, CLAIM_PATTERNS).length > 0)) namesRosie.push(id);
    }
    for (const [id, where] of [...EXAMPLES, ...PASSIVE_EXAMPLES, ...ROUND3_EXAMPLES])
      expect(flagged[id], id).toContain(where);
    // 61 trade files name Rosie or Rosie's team as the one who checks (run 1's 31, and DL-894's 30); 41 more only wait
    // on, or show, a paper no one named checks, in their pf blocks (DL-884's 28 but property-manager, and DL-894's 14);
    // 102 in all, pinned as this build counts them (never padded or trimmed to MC C7's 45, whose list is not available).
    expect(namesRosie).toHaveLength(61);
    expect(Object.keys(flagged).filter((id) => !namesRosie.includes(id))).toStrictEqual(PASSIVE_ONLY);
    expect(Object.keys(flagged)).toHaveLength(102);
    expect(flagged).toMatchInlineSnapshot(`
      {
        "acupuncturist": [
          "pluginText.pf.license.check",
        ],
        "advisor": [
          "pluginText.pf.license.renewals",
          "A ops[15].more[0]",
          "B ops[15].more[0]",
        ],
        "appliance": [
          "A ops[2].more[0]",
          "B ops[10].more[0]",
        ],
        "appraiser": [
          "pluginText.pf.license.blocks_live",
        ],
        "auto-body": [
          "pluginText.pf.license.check",
        ],
        "auto-repair": [
          "pluginText.pf.license.check",
        ],
        "band": [
          "B rename[7][1]",
        ],
        "boat-repair": [
          "pluginText.pf.license.check",
        ],
        "camp": [
          "pluginText.pf.staff.license",
        ],
        "carpet": [
          "A ops[0].more[1]",
          "B ops[0].more[1]",
        ],
        "chef": [
          "A ops[5].does",
          "A ops[5].more[1]",
          "B ops[5].does",
          "B ops[5].more[1]",
        ],
        "cleaner": [
          "A ops[0].more[1]",
          "B ops[0].more[1]",
        ],
        "closets": [
          "pluginText.pf.license.blocks[0]",
        ],
        "clown": [
          "B rename[5][1]",
        ],
        "coach": [
          "pluginText.pf.license.ask",
        ],
        "comedian": [
          "B rename[5][1]",
        ],
        "commercial-cleaning": [
          "A ops[0].more[1]",
          "B ops[0].more[1]",
        ],
        "concrete": [
          "pluginText.pf.license.blocks[0]",
        ],
        "contractor": [
          "pluginText.pf.license.blocks[0]",
          "pluginText.pf.license.design_studio",
          "pluginText.pf.staff.licenses",
        ],
        "cpa": [
          "pluginText.pf.license.renewals",
        ],
        "dance": [
          "A ops[70].does",
          "B ops[56].does",
        ],
        "daycare": [
          "A ops[5].does",
          "A ops[84].does",
          "B ops[6].does",
          "B ops[81].does",
        ],
        "deck": [
          "pluginText.pf.license.blocks[0]",
        ],
        "demolition": [
          "pluginText.pf.license.blocks[0]",
        ],
        "detailing": [
          "A ops[11].does",
          "A ops[11].more[1]",
          "B ops[11].does",
          "B ops[11].more[1]",
        ],
        "dj": [
          "B rename[3][1]",
        ],
        "dog-trainer": [
          "pluginText.pf.staff.licenses",
        ],
        "dog-walker": [
          "A ops[8].more[1]",
          "A ops[23].does",
          "A ops[75].more[0]",
          "A ops[78].more[1]",
          "B ops[8].more[1]",
          "B ops[25].does",
          "B ops[112].more[1]",
        ],
        "driving-school": [
          "pluginText.pf.license.blocks",
          "A ops[3].more[0]",
          "A ops[103].does",
          "B ops[3].more[0]",
          "B ops[165].does",
        ],
        "drywall": [
          "pluginText.pf.license.blocks[0]",
        ],
        "duct-cleaning": [
          "A ops[0].more[1]",
          "B ops[0].more[1]",
        ],
        "electrician": [
          "pluginText.pf.license.local rules",
        ],
        "energy-audit": [
          "pluginText.pf.license.blocks_live",
        ],
        "excavation": [
          "pluginText.pf.license.blocks[0]",
        ],
        "farrier": [
          "A ops[45].does",
          "B ops[20].does",
        ],
        "foundation": [
          "pluginText.pf.license.blocks[0]",
        ],
        "funeral": [
          "pluginText.pf.license.renewals",
        ],
        "glass-doors": [
          "pluginText.pf.license.blocks[0]",
        ],
        "groomer": [
          "pluginText.pf.license.check",
        ],
        "gunsmith": [
          "pluginText.pf.license.ask[0]",
        ],
        "gutters": [
          "pluginText.pf.license.blocks[0]",
          "pluginText.pf.staff.licenses",
        ],
        "gym": [
          "pluginText.pf.license.coachCertificate",
          "pluginText.pf.staff.certificate",
        ],
        "hearing": [
          "A ops[66].more[0]",
          "B ops[40].more[0]",
        ],
        "holiday-lights": [
          "B ops[54].more[1]",
        ],
        "home-engineer": [
          "pluginText.pf.license.blocks_live",
        ],
        "hvac": [
          "pluginText.pf.license.local rules",
        ],
        "inspector": [
          "pluginText.pf.license.blocks_live",
        ],
        "instrument-repair": [
          "pluginText.pf.license.check",
        ],
        "insulation": [
          "pluginText.pf.license.blocks[0]",
        ],
        "insurance": [
          "A ops[8].more[0]",
          "B ops[8].more[0]",
        ],
        "interior": [
          "pluginText.pf.staff.licenses",
          "A rename[121][1]",
          "B rename[434][1]",
        ],
        "irrigation": [
          "pluginText.pf.license.blocks[0]",
          "pluginText.pf.staff.licenses",
        ],
        "lash-brow": [
          "pluginText.pf.license.threading",
        ],
        "lawyer": [
          "pluginText.pf.license.renewals",
        ],
        "limo": [
          "pluginText.pf.license.otherwise",
        ],
        "locksmith": [
          "pluginText.pf.license.blocks going live",
        ],
        "masonry": [
          "pluginText.pf.license.blocks[0]",
        ],
        "mortgage": [
          "pluginText.pf.license.renewals",
          "A ops[9].more[0]",
          "B ops[9].more[0]",
        ],
        "motorcycle": [
          "pluginText.pf.license.check",
        ],
        "movers": [
          "pluginText.pf.license.status_any_day",
          "pluginText.pf.license.blocks[0]",
          "pluginText.pf.staff.licenses",
          "A ops[11].more[1]",
          "B ops[11].more[1]",
        ],
        "music": [
          "pluginText.pf.license.need",
        ],
        "notary": [
          "B ops[3].more[0]",
        ],
        "orthopedist": [
          "B ops[63].does",
        ],
        "painter": [
          "pluginText.pf.license.blocks[0]",
        ],
        "party-characters": [
          "B rename[5][1]",
        ],
        "paving": [
          "pluginText.pf.license.blocks[0]",
        ],
        "pet-taxi": [
          "A ops[50].does",
          "B ops[20].does",
        ],
        "pet-waste": [
          "A ops[39].does",
          "B ops[19].does",
        ],
        "pharmacist": [
          "A ops[29].more[0]",
          "A ops[54].does",
          "B ops[28].more[0]",
          "B ops[53].does",
        ],
        "pool": [
          "A ops[0].more[2]",
          "A ops[1].more[1]",
          "B ops[0].more[2]",
          "B ops[1].more[1]",
        ],
        "pool-builder": [
          "pluginText.pf.staff.licenses",
        ],
        "pressure": [
          "A ops[0].more[3]",
          "B ops[0].more[3]",
        ],
        "primary-care": [
          "A ops[40].more[0]",
          "A ops[62].does",
          "B ops[44].more[0]",
          "B ops[66].does",
        ],
        "property-manager": [
          "pluginText.pf.license.blocks going live",
          "A ops[5].more[1]",
          "A ops[6].more[0]",
          "B ops[5].more[1]",
          "B ops[6].more[0]",
        ],
        "radon": [
          "pluginText.pf.license.blocks[0]",
        ],
        "realtor": [
          "pluginText.pf.license.renewals",
        ],
        "rentals": [
          "A ops[20].does",
          "B ops[20].does",
        ],
        "repair-shop": [
          "pluginText.pf.license.check",
          "A ops[45].more[1]",
          "B ops[33].more[1]",
        ],
        "restaurant": [
          "pluginText.pf.license.check",
          "pluginText.pf.license.renewals",
        ],
        "restoration": [
          "pluginText.pf.license.certifications",
        ],
        "roofer": [
          "pluginText.pf.license.blocks[0]",
          "pluginText.pf.staff.licenses",
        ],
        "rv-repair": [
          "pluginText.pf.license.check",
        ],
        "security": [
          "pluginText.pf.license.blocks[0]",
        ],
        "sharpening": [
          "pluginText.pf.license.check",
        ],
        "siding": [
          "pluginText.pf.license.blocks[0]",
          "pluginText.pf.staff.licenses",
        ],
        "sitter": [
          "A ops[3].does",
          "B ops[3].does",
        ],
        "small-engine": [
          "pluginText.pf.license.check",
        ],
        "snow": [
          "A ops[13].more[1]",
          "B ops[13].more[1]",
        ],
        "speech-therapist": [
          "pluginText.pf.license.national",
        ],
        "surveyor": [
          "pluginText.pf.license.blocks_live",
        ],
        "tax": [
          "pluginText.pf.license.titles",
          "A ops[80].does",
          "A ops[96].more[1]",
          "A ops[127].more[0]",
          "A ops[127].more[2]",
          "B ops[33].does",
          "B ops[49].more[1]",
          "B ops[176].more[0]",
          "B ops[176].more[2]",
        ],
        "tires": [
          "pluginText.pf.license.check",
          "A ops[35].does",
          "B ops[75].does",
        ],
        "towing": [
          "pluginText.pf.license.blocks going live",
        ],
        "trainer": [
          "pluginText.pf.license.certificates",
        ],
        "tree": [
          "pluginText.pf.license.blocks[0]",
          "pluginText.pf.license.trust",
          "pluginText.pf.license.wood_yard",
        ],
        "tutor": [
          "A ops[10].does",
          "A ops[179].does",
          "A ops[179].more[1]",
          "B ops[10].does",
          "B ops[260].does",
          "B ops[260].more[1]",
        ],
        "vehicle-inspection": [
          "pluginText.pf.license.check",
          "pluginText.pf.staff.licenses",
        ],
        "vehicle-wrap": [
          "pluginText.pf.license.check",
        ],
        "watch-jewelry": [
          "pluginText.pf.license.check",
        ],
        "wildlife": [
          "A ops[0].more[1]",
          "B ops[0].more[1]",
        ],
        "window-tint": [
          "pluginText.pf.license.check",
        ],
        "windows": [
          "A ops[3].more[1]",
          "B ops[4].more[1]",
        ],
      }
    `);
  });

  it("leaves no text the compiled overlay holds saying Rosie checks a paper, no pf block waiting on a paper no one named checks, and marks each text it changed", () => {
    for (const id of ALL) {
      const { trade, done } = marked(id);
      for (const leaf of tradeTexts(done.trade)) {
        expect(findClaims(leaf.text), `${id} ${leaf.path}`).toStrictEqual([]);
        expect(findClaims(leaf.text, patternsAt(leaf.path)), `${id} ${leaf.path}`).toStrictEqual([]);
      }
      for (const one of done.marked) {
        const patterns = patternsAt(one.where);
        expect(one.tag).toBe("MC:C7");
        expect(findClaims(one.before, patterns).length, `${id} ${one.where}`).toBeGreaterThan(0);
        expect(one.after, `${id} ${one.where}`).toContain(C7_MARKER);
        expect(one.after, `${id} ${one.where}`).toBe(ownWord(one.before, patterns));
      }
      // Every text it did not flag is as the trade wrote it.
      const changed = done.marked.map((one) => one.after);
      const before = tradeTexts(trade).map((leaf) => leaf.text);
      const after = tradeTexts(done.trade).map((leaf) => leaf.text);
      expect(after.length, id).toBe(before.length);
      after.forEach((text, k) => {
        if (text !== before[k]) expect(changed, `${id} ${String(k)}`).toContain(text);
      });
      expect(after.filter((text, k) => text !== before[k]).length, id).toBe(done.marked.length);
    }
  });

  it("marks movers.json's S1-38 line and every claim after a negating clause, checked apart from findClaims (DL-894)", () => {
    // The raw line the security reviewer named: movers.json, the words op at S1-38, more[1] (ops[11] in both flows).
    const line = "Where a lookup has no data feed, a person on Rosie's team checks within 1 business day.";
    const movers = marked("movers");
    for (const flow of FLOWS) {
      const k = movers.trade.flows[flow].ops.findIndex(
        (op) => op.op === "words" && op.at === "S1-38" && op.more?.[1] === line,
      );
      const where = `${flow} ops[${String(k)}].more[1]`;
      expect(where).toBe(`${flow} ops[11].more[1]`);
      const mark = movers.done.marked.find((one) => one.where === where);
      expect(mark?.tag, where).toBe("MC:C7");
      expect(mark?.after, where).toBe(OWN_WORD);
      expect((movers.done.trade.flows[flow].ops[k] as { more?: string[] }).more?.[1], where).toBe(OWN_WORD);
    }
    // The shape, read apart from findClaims and PAPER: a negation, a comma, then Rosie or Rosie's team checks.
    const shape =
      /(?:\b(?:no|none|not|never|nothing)\b|n't\b)[^.;!?]*,\s+(?:a person on Rosie's team|Rosie's team|Rosie)\s+(?:re-?)?checks\b/i;
    const before: string[] = [];
    for (const id of ALL) {
      const { trade, done } = marked(id);
      if (tradeTexts(trade).some((leaf) => shape.test(leaf.text))) before.push(id);
      for (const leaf of tradeTexts(done.trade))
        expect(shape.test(leaf.text), `${id} ${leaf.path}: ${leaf.text}`).toBe(false);
    }
    expect(before).toStrictEqual(NEGATED_CLAUSE_FILES);
    for (const id of REVIEWER_OWN_WORDS) expect(before, id).toContain(id);
    // The reviewer's other 3 hold it only on a rename's first side (the master's S1-38 lines), which stays.
    for (const id of REVIEWER_FIRST_SIDES) {
      const { trade, done } = marked(id);
      expect(before, id).not.toContain(id);
      expect(
        trade.flows.B.rename.filter((pair) => shape.test(pair[0])),
        id,
      ).toHaveLength(2);
      expect(
        done.trade.flows.B.rename.map((pair) => pair[0]),
        id,
      ).toStrictEqual(trade.flows.B.rename.map((pair) => pair[0]));
    }
    // After C7, a person on Rosie's team still checks in three texts only: a fraud flag and a booking cap's flag, which
    // name no paper.
    const team =
      /\b(?:a person on Rosie's team|Rosie's team)\s+(?:(?:also|then|first|again|only|still)\s+)?(?:re-?checks|checks|reads|looks|verifies|confirms)\b/i;
    expect(
      ALL.flatMap((id) =>
        tradeTexts(marked(id).done.trade)
          .filter((leaf) => team.test(leaf.text))
          .map((leaf) => `${id} ${leaf.path}`),
      ),
    ).toStrictEqual([
      "property-manager A.ops[262].does",
      "property-manager B.ops[274].does",
      "towing B.ops[239].more[2]",
    ]);
  });

  it("never changes a rename's or a swap's first side, a branch label or an op's step, nor the trade given, and finds nothing more to change", () => {
    const shape = (ops: readonly TradeOp[]): string =>
      JSON.stringify(ops, (key, value: unknown) =>
        typeof value === "string" && !["label", "at", "op", "id"].includes(key) ? "" : value,
      );
    for (const id of ALL) {
      const { trade, done } = marked(id);
      expect(markClaims(done.trade).marked, `${id}: nothing more`).toStrictEqual([]);
      for (const flow of FLOWS) {
        expect(
          done.trade.flows[flow].rename.map((pair) => pair[0]),
          `${id} ${flow}`,
        ).toStrictEqual(trade.flows[flow].rename.map((pair) => pair[0]));
        expect(shape(done.trade.flows[flow].ops), `${id} ${flow}`).toBe(shape(trade.flows[flow].ops));
      }
    }
    const band = marked("band");
    expect(band.done.trade.flows.B.rename[7]).toStrictEqual([band.trade.flows.B.rename[7]?.[0], OWN_WORD]);
    expect(loadTrade("band")).toStrictEqual(band.trade);
    expect(markClaims(loadTrade("barber")).marked).toStrictEqual([]);
  });

  it("stops the build on a claim in a message a person reads", () => {
    const barber = loadTrade("barber");
    const withSay = (say: unknown[]): LoadedTrade => ({
      ...barber,
      flows: {
        ...barber.flows,
        A: {
          ...barber.flows.A,
          ops: [...barber.flows.A.ops, { op: "words", at: "S1-02", say } as unknown as TradeOp],
        },
      },
    });
    expect(() =>
      markClaims(withSay([["san", "owner", "Rosie checks your license on the state's lookup."]])),
    ).toThrow(C7ClaimError);
    expect(() =>
      markClaims(
        withSay([
          [
            "san",
            "owner",
            "Done.",
            { card: { title: "License", lines: ["Checked by Rosie on the state's lookup"] } },
          ],
        ]),
      ),
    ).toThrow(C7ClaimError);
    expect(() =>
      markClaims(
        withSay([
          [
            "san",
            "owner",
            "Where a lookup has no data feed, a person on Rosie's team checks within 1 business day.",
          ],
        ]),
      ),
    ).toThrow(C7ClaimError);
  });
});

describe("C7 in the bundle", () => {
  it("leaves no claim in the compiled overlays of MC C7's five example trades, two passive ones and two of DL-894's, and marks each flagged pf block", async () => {
    const ids = [...EXAMPLES, ...PASSIVE_EXAMPLES, ...ROUND3_EXAMPLES].map(([id]) => id);
    const built = await buildBundle({ trades: ids, master });
    for (const id of ids) {
      const overlay = built.bundle.trades[id] as {
        pluginText: Record<string, string>;
        flows: Record<FlowLetter, Record<string, unknown>>;
      };
      for (const leaf of texts(overlay, id)) {
        // A pf block is stored whole as one text (K-01 pluginText): read it with the pf blocks' patterns.
        const patterns = leaf.path.startsWith(`${id}.pluginText.`) ? WORD_PATTERNS : CLAIM_PATTERNS;
        expect(findClaims(leaf.text, patterns), leaf.path).toStrictEqual([]);
      }
      for (const one of marked(id).done.marked) {
        const block = /^pluginText\.(pf\.[a-z_]+)/.exec(one.where)?.[1];
        if (block !== undefined) expect(overlay.pluginText[block], `${id} ${block}`).toContain(C7_MARKER);
      }
    }
    const dogWalker = built.bundle.trades["dog-walker"] as { flows: Record<FlowLetter, { ops: unknown[] }> };
    expect(JSON.stringify(dogWalker.flows.A.ops[75])).toContain(C7_MARKER);
    const carpet = built.bundle.trades.carpet as { flows: Record<FlowLetter, { ops: unknown[] }> };
    expect(JSON.stringify(carpet.flows.A.ops[0])).toContain(C7_MARKER);
  });
});

describe("C7's tags", () => {
  it("tags every change MC:C7 in its diff lines, and changes no step in the frame", () => {
    const { done } = marked("tree");
    const lines = renderMarks(done.marked);
    expect(lines.length).toBe(2 * done.marked.length);
    expect(lines.every((line) => /^MC:C7 [-+] tree /.test(line))).toBe(true);
    expect(lines).toContain(
      `MC:C7 + tree pluginText.pf.license.trust: ${OWN_WORD} otherwise it's the business's own words`,
    );
    const applied = applyTrade(master.A, loadTrade("tree"));
    expect(applyCorrections(applied, [c7]).changes).toStrictEqual([]);
    expect(c7.id).toBe("C7");
    expect(c7.source).toContain("Master Corrections C7");
    expect(c7.source).toContain("D96");
  });
});

// TEMP SCAN4 (removed before the commit)
import { writeFileSync as TMPW } from "node:fs";
import { PASSIVE_PATTERNS as TMPP, PAPER as TMPPAPER } from "./c7";
describe("SCAN5", () => {
  it("dumps", () => {
    const OUT =
      "/private/tmp/claude-501/-Users-aryamahadik-Downloads-Rosfield-Main-rosie/d9982744-6798-4bc7-ad8e-3fc2a5092574/scratchpad/";
    const NEG = /\b(?:never|not|no|nor|cannot|nothing|none|nobody)\b|n't\b/i;
    const LISTNEG = /^\s*(?:never|none|no|not|nothing|nobody)\s*:/i;
    const BRK = /[,;:.!?](?=\s|$)|[·•—–|/\n]/;
    const SENT = /((?<=[.;!?])\s+|\s+[·•|]\s+|\s*\n\s*)/;
    const wds = (s: string) => s.split(/\s+/).filter((w) => /[a-z]/i.test(w));
    const negIn = (text: string, at: number, reach: number): boolean => {
      const parts = text.split(SENT);
      let pos = 0;
      for (let k = 0; k < parts.length; k += 2) {
        const s = parts[k] ?? "";
        const sep = parts[k + 1] ?? "";
        if (at < pos + s.length + sep.length || k + 2 >= parts.length) {
          const rel = at - pos;
          const lm = LISTNEG.exec(s);
          if (lm !== null && lm[0].length <= rel) return true;
          const cl = s.slice(0, Math.max(0, rel)).split(BRK);
          const w = wds(cl[cl.length - 1] ?? "");
          return w.slice(Math.max(0, w.length - reach)).some((x) => NEG.test(x));
        }
        pos += s.length + sep.length;
      }
      return false;
    };
    const negAcross = (s: string, at: number, n: number) =>
      wds(s.slice(0, at))
        .slice(-n)
        .some((x) => NEG.test(x));
    const WHO = String.raw`(?:a person on Rosie's team|Rosie's team|Rosie)`;
    const NOPAPER_NEG = /^\s+(?:no|nothing|none)\b/i;
    const NOPAPER_OTHER = /^\s+(?:each job|the job|the total|the date|(?:this|that) before|(?:it |them )?back)\b/i;
    const SHAPES = [
      ...CLAIM_PATTERNS.map((p, k) => ({ name: `C${String(k)}`, re: p.pattern, reach: p.reach })),
      ...TMPP.map((p, k) => ({ name: `P${String(k)}`, re: p.pattern, reach: p.reach })),
      {
        name: "C0bare",
        re: new RegExp(
          String.raw`\b${WHO}\s+(?:(?:also|then|first|again|only|still)\s+)?(?:re-?checks|checks|looks\s+(?:[\w'-]+\s+){0,4}?up|has\s+read|reads|verifies|confirms)\b`,
        ),
        reach: 3,
      },
      { name: "C1bare", re: /\bRosie\s+[a-z]+s\b[^.;:]{0,80}?\band\s+(?:re-?)?checks\b/, reach: 3 },
      {
        name: "H4",
        re: /\b(?:licen[cs]es?|permits?|certificates?|certifications?|insurance|registrations?|credentials?|bonds?|authority|papers?)\b[^.;:!?·•|]{0,40}?\b(?:(?:re-?)?checked|verified|confirmed|looked\s+up)\b(?!\s+by\b)/i,
        reach: 3,
      },
    ];
    const NOTW = new Set([
      "id", "at", "op", "label", "who", "to", "via", "as", "line", "needs", "gives", "reads", "tells", "when", "sets",
      "flow", "phase", "type", "kind", "slot", "link", "stop",
    ]);
    type Leaf = { path: string; text: string; side: string; msg: boolean };
    const walk = (v: unknown, p: string, side: string, msg: boolean, out: Leaf[]): void => {
      if (typeof v === "string") out.push({ path: p, text: v, side, msg });
      else if (Array.isArray(v)) v.forEach((x, k) => walk(x, `${p}[${String(k)}]`, side, msg, out));
      else if (typeof v === "object" && v !== null)
        for (const [k, x] of Object.entries(v)) {
          const q = p === "" ? k : `${p}.${k}`;
          if ((k === "swap" || k === "rename") && Array.isArray(x))
            x.forEach((pair, j) => {
              if (Array.isArray(pair) && pair.length === 2) {
                walk(pair[0], `${q}[${String(j)}][0]`, "first", msg, out);
                walk(pair[1], `${q}[${String(j)}][1]`, side, msg, out);
              } else walk(pair, `${q}[${String(j)}]`, side, msg, out);
            });
          else if (NOTW.has(k)) walk(x, q, "notWords", msg, out);
          else if ((k === "say" || k === "addSay") && Array.isArray(x))
            x.forEach((m, j) => walk(m, `${q}[${String(j)}]`, side, true, out));
          else walk(x, q, side, msg, out);
        }
    };
    const leavesOf = (t: LoadedTrade): Leaf[] => {
      const out: Leaf[] = [];
      for (const [name, block] of Object.entries(t.pluginText))
        walk(JSON.parse(block) as unknown, `pluginText.${name}`, "new", false, out);
      for (const f of FLOWS) {
        const part = t.flows[f];
        walk(part.ops, `${f} ops`, "new", false, out);
        part.rename.forEach((pair, j) => {
          walk(pair[0], `${f} rename[${String(j)}][0]`, "first", false, out);
          walk(pair[1], `${f} rename[${String(j)}][1]`, "new", false, out);
        });
        walk(part.slotRows, `${f} slotRows`, "new", false, out);
        walk(part.money, `${f} money`, "new", false, out);
      }
      return out;
    };
    const hitsOf = (s: string) => {
      const hs: { name: string; phrase: string; at: number; reach: number }[] = [];
      for (const sh of SHAPES) {
        const g = new RegExp(sh.re.source, `${sh.re.flags.replace("g", "")}g`);
        for (const m of s.matchAll(g)) hs.push({ name: sh.name, phrase: m[0], at: m.index, reach: sh.reach });
      }
      return hs;
    };
    const isP = (n: string) => n.startsWith("P") || n === "H4";
    const VIN = /(?:re-?)?check(?:s|ed)?\b|verif(?:y|ies|ied)\b|confirm(?:s|ed)?\b|\blook(?:s|ed)?\b|\breads?\b|\bsaw\b|\bsees?\b|\bseen\b/gi;
    const reasonOf = (h: { name: string; phrase: string; at: number; reach: number }, text: string, msg: boolean) => {
      const vs = [...h.phrase.matchAll(VIN)].map((m) => m.index);
      const firstV = vs[0] ?? 0;
      const lastV = vs[vs.length - 1] ?? 0;
      if (negIn(text, h.at, h.reach) || negIn(text, h.at + lastV, 3) || NEG.test(h.phrase.slice(firstV)))
        return "negation";
      const after = text.slice(h.at + h.phrase.length);
      if (h.name.endsWith("bare") && NOPAPER_NEG.test(after)) return "negation";
      if (h.name.endsWith("bare") && NOPAPER_OTHER.test(after)) return "guard";
      if (msg && isP(h.name)) return "msg-wait";
      if (!TMPPAPER.test(text)) return "nopaper";
      return "REVIEW";
    };
    const all: string[] = [];
    const notw: string[] = [];
    const neg40 = new Set<string>();
    const neg40lines: string[] = [];
    const hitReasons: Record<string, number> = {};
    const textReasons: Record<string, number> = {};
    const filesReasons: Record<string, Set<string>> = {};
    let firstHits = 0;
    const firstFiles = new Set<string>();
    let markedTexts = 0;
    const per: { id: string; rl: Leaf[]; dl: Leaf[] }[] = [];
    for (const id of ALL) {
      const raw = loadTrade(id);
      const done = markClaims(raw).trade;
      const rl = leavesOf(raw);
      const dl = leavesOf(done);
      expect(dl.length).toBe(rl.length);
      per.push({ id, rl, dl });
      rl.forEach((r, i) => {
        const d = dl[i] as Leaf;
        expect(d.path).toBe(r.path);
        if (r.text !== d.text) markedTexts++;
        for (const h of hitsOf(r.text))
          if (/^P(?:[0-9]|1[01])$/.test(h.name) && negAcross(r.text, h.at, 3)) neg40.add(id);
        if (d.side === "first") {
          const n = hitsOf(d.text).length;
          firstHits += n;
          if (n > 0) firstFiles.add(id);
          return;
        }
        const scan = d.text.split(OWN_WORD).join(" § ");
        const hs = hitsOf(scan);
        if (hs.length === 0) return;
        if (d.side === "notWords") {
          notw.push(`${id} ${d.path} | ${hs.map((h) => `[${h.name}]«${h.phrase}»`).join(" ")} | ${scan}`);
          return;
        }
        const rs = hs.map((h) => reasonOf(h, scan, d.msg));
        rs.forEach((x) => (hitReasons[x] = (hitReasons[x] ?? 0) + 1));
        const key = [...new Set(rs)].sort().join("+");
        textReasons[key] = (textReasons[key] ?? 0) + 1;
        (filesReasons[key] ??= new Set()).add(id);
        all.push(
          `${key} | ${id} ${d.path}${d.msg ? " (msg)" : ""} | ${hs.map((h, k) => `[${h.name}:${rs[k] ?? ""}]«${h.phrase}»`).join(" ")} | ${scan.length > 300 ? `${scan.slice(0, 300)}…` : scan}`,
        );
      });
    }
    const neg40reasons: Record<string, Record<string, number>> = {};
    for (const { id, rl, dl } of per) {
      if (!neg40.has(id)) continue;
      rl.forEach((r, i) => {
        const d = dl[i] as Leaf;
        for (const h of hitsOf(r.text)) {
          if (!isP(h.name) || !negAcross(r.text, h.at, 3)) continue;
          let why: string;
          if (r.side === "first") why = "first side";
          else if (r.side === "notWords") why = "not words";
          else if (r.text !== d.text && !d.text.includes(h.phrase)) why = "marked";
          else why = reasonOf(h, r.text, r.msg);
          const m = (neg40reasons[id] ??= {});
          m[why] = (m[why] ?? 0) + 1;
          neg40lines.push(`${why} | ${id} ${r.path} | [${h.name}]«${h.phrase}» | ${r.text.length > 240 ? `${r.text.slice(0, 240)}…` : r.text}`);
        }
      });
    }
    all.sort();
    neg40lines.sort();
    TMPW(`${OUT}t140r4b-all.txt`, all.join("\n"));
    TMPW(`${OUT}t140r4b-review.txt`, all.filter((l) => /REVIEW|msg-wait/.test(l.split(" | ")[0] ?? "")).join("\n"));
    TMPW(`${OUT}t140r4b-notwords.txt`, notw.join("\n"));
    TMPW(`${OUT}t140r4b-neg40.txt`, neg40lines.filter((l) => !l.startsWith("first side")).join("\n"));
    TMPW(
      `${OUT}t140r4b-summary.json`,
      JSON.stringify(
        {
          markedTexts,
          firstHits,
          firstFiles: firstFiles.size,
          hitReasons,
          textReasons,
          filesReasons: Object.fromEntries(Object.entries(filesReasons).map(([k, v]) => [k, v.size])),
          neg40: [...neg40],
          neg40count: neg40.size,
          neg40reasons,
          notWords: notw.length,
        },
        null,
        1,
      ),
    );
  });
});
describe("SCANOLD", () => {
  it("dumps", () => {
    const OUT =
      "/private/tmp/claude-501/-Users-aryamahadik-Downloads-Rosfield-Main-rosie/d9982744-6798-4bc7-ad8e-3fc2a5092574/scratchpad/";
    const ALLP = [...CLAIM_PATTERNS, ...TMPP];
    const NEG = /\b(?:never|not|no|nor|cannot|nothing|none)\b|n't\b/i;
    const B_NEW = /[,;:.!?](?=\s|$)|[·•—–|/\n]/;
    const B_NOCOLON = /[,;.!?](?=\s|$)|[·•—–|/\n]/;
    const B_NOSLASH = /[,;:.!?](?=\s|$)|[·•—–|\n]/;
    const B_R3 = /[,;.!?](?=\s|$)/;
    const wds = (s: string) => s.split(/\s+/).filter((w) => /[a-z]/i.test(w));
    const negIn = (s: string, at: number, reach: number, brk: RegExp) => {
      const cl = s.slice(0, at).split(brk);
      const w = wds(cl[cl.length - 1] ?? "");
      return w.slice(Math.max(0, w.length - reach)).some((x) => NEG.test(x));
    };
    const negAcross = (s: string, at: number, n: number) =>
      wds(s.slice(0, at))
        .slice(-n)
        .some((x) => NEG.test(x));
    const WHO = String.raw`(?:a person on Rosie's team|Rosie's team|Rosie)`;
    const NOPAPER_NEG = /^\s+(?:no|nothing|none)\b/i;
    const NOPAPER_OTHER = /^\s+(?:each job|the job|the total|the date|(?:this|that) before|(?:it |them )?back)\b/i;
    const SHAPES = [
      ...CLAIM_PATTERNS.slice(2).map((p, k) => ({ name: `C${k + 2}`, re: p.pattern, reach: p.reach })),
      ...TMPP.map((p, k) => ({ name: `P${k}`, re: p.pattern, reach: p.reach })),
      {
        name: "C0bare",
        re: new RegExp(
          String.raw`\b${WHO}\s+(?:(?:also|then|first|again|only|still)\s+)?(?:re-?checks|checks|looks\s+(?:[\w'-]+\s+){0,4}?up|has\s+read|reads|verifies|confirms)\b`,
        ),
        reach: 3,
      },
      { name: "C1bare", re: /\bRosie\s+[a-z]+s\b[^.;:]{0,80}?\band\s+(?:re-?)?checks\b/, reach: 3 },
      {
        name: "VERBneg",
        re: /\b(?:re-?)?(?:check(?:s|ed|ing)?|verif(?:y|ies|ied)|confirm(?:s|ed)?)\b|\blook(?:s|ed)?\s+(?:[\w'-]+\s+){0,4}?up\b/i,
        reach: 3,
      },
      {
        name: "H4",
        re: /\b(?:licen[cs]es?|permits?|certificates?|certifications?|insurance|registrations?|credentials?|bonds?|authority|papers?)\b[^.;:!?·•|]{0,40}?\b(?:(?:re-?)?checked|verified|confirmed|looked\s+up)\b(?!\s+by\b)/i,
        reach: 3,
      },
    ];
    const NOTW = new Set([
      "id", "at", "op", "label", "who", "to", "via", "as", "line", "needs", "gives", "reads", "tells", "when", "sets",
      "flow", "phase", "type", "kind", "slot", "link", "stop",
    ]);
    type Leaf = { path: string; text: string; side: string; msg: boolean };
    const walk = (v: unknown, p: string, side: string, msg: boolean, out: Leaf[]): void => {
      if (typeof v === "string") out.push({ path: p, text: v, side, msg });
      else if (Array.isArray(v)) v.forEach((x, k) => walk(x, `${p}[${String(k)}]`, side, msg, out));
      else if (typeof v === "object" && v !== null)
        for (const [k, x] of Object.entries(v)) {
          const q = p === "" ? k : `${p}.${k}`;
          if ((k === "swap" || k === "rename") && Array.isArray(x))
            x.forEach((pair, j) => {
              if (Array.isArray(pair) && pair.length === 2) {
                walk(pair[0], `${q}[${String(j)}][0]`, "first", msg, out);
                walk(pair[1], `${q}[${String(j)}][1]`, side, msg, out);
              } else walk(pair, `${q}[${String(j)}]`, side, msg, out);
            });
          else if (NOTW.has(k)) walk(x, q, "notWords", msg, out);
          else if ((k === "say" || k === "addSay") && Array.isArray(x))
            x.forEach((m, j) => walk(m, `${q}[${String(j)}]`, side, true, out));
          else walk(x, q, side, msg, out);
        }
    };
    const leavesOf = (t: LoadedTrade): Leaf[] => {
      const out: Leaf[] = [];
      for (const [name, block] of Object.entries(t.pluginText))
        walk(JSON.parse(block) as unknown, `pluginText.${name}`, "new", false, out);
      for (const f of FLOWS) {
        const part = t.flows[f];
        walk(part.ops, `${f} ops`, "new", false, out);
        part.rename.forEach((pair, j) => {
          walk(pair[0], `${f} rename[${String(j)}][0]`, "first", false, out);
          walk(pair[1], `${f} rename[${String(j)}][1]`, "new", false, out);
        });
        walk(part.slotRows, `${f} slotRows`, "new", false, out);
        walk(part.money, `${f} money`, "new", false, out);
      }
      return out;
    };
    const hitsOf = (s: string) => {
      const hs: { name: string; phrase: string; at: number; reach: number }[] = [];
      for (const sh of SHAPES) {
        const g = new RegExp(sh.re.source, `${sh.re.flags.replace("g", "")}g`);
        for (const m of s.matchAll(g)) {
          if (sh.name === "VERBneg" && !negAcross(s, m.index, 3)) continue;
          hs.push({ name: sh.name, phrase: m[0], at: m.index, reach: sh.reach });
        }
      }
      return hs;
    };
    const lines: string[] = [];
    const throws: string[] = [];
    const diffs: string[] = [];
    const negPassiveFilesA = new Set<string>();
    const negPassiveFilesB = new Set<string>();
    const opPassive: string[] = [];
    const counts: Record<string, number> = {};
    const filesByReason: Record<string, Set<string>> = {};
    let rawHits = 0;
    let markedTexts = 0;
    for (const id of ALL) {
      const trade = loadTrade(id);
      for (const leaf of leavesOf(trade)) {
        for (const h of hitsOf(leaf.text)) {
          if (h.name.startsWith("P") && negAcross(leaf.text, h.at, 3)) negPassiveFilesA.add(id);
          if (/checked|checks out|check out/i.test(h.phrase) && negAcross(leaf.text, h.at, 3)) negPassiveFilesB.add(id);
        }
        const pred = leaf.side === "new" ? ownWord(leaf.text, ALLP) : leaf.text;
        const markedNow = pred !== leaf.text;
        if (markedNow) markedTexts++;
        if (markedNow && leaf.msg) throws.push(`${id} ${leaf.path} :: ${leaf.text}`);
        if (markedNow && !leaf.path.startsWith("pluginText.") && ownWord(leaf.text, CLAIM_PATTERNS) === leaf.text)
          opPassive.push(`${id} ${leaf.path} :: ${leaf.text}`);
        const rawH = hitsOf(leaf.text);
        rawHits += rawH.length;
        for (const h of rawH) {
          const a = negIn(leaf.text, h.at, h.reach, B_NEW);
          const b = negIn(leaf.text, h.at, h.reach, B_NOCOLON);
          const c = negIn(leaf.text, h.at, h.reach, B_NOSLASH);
          const d = negIn(leaf.text, h.at, h.reach, B_R3);
          if (a !== b || a !== c || a !== d)
            diffs.push(
              `${id} ${leaf.path} [${h.name}] new=${String(a)} nocolon=${String(b)} noslash=${String(c)} r3=${String(d)} «${h.phrase}» :: ${leaf.text.slice(Math.max(0, h.at - 90), h.at + h.phrase.length + 40)}`,
            );
        }
        const scan = pred.split(OWN_WORD).join(" § ");
        const hs = hitsOf(scan);
        if (hs.length === 0) continue;
        const reasons = hs.map((h) => {
          if (leaf.side === "first") return "first-side";
          if (leaf.side === "notWords") return "not-words";
          if (negIn(scan, h.at, h.reach, B_NEW)) return "negation";
          const after = scan.slice(h.at + h.phrase.length);
          if (h.name.endsWith("bare") && NOPAPER_NEG.test(after)) return "negation";
          if (h.name.endsWith("bare") && NOPAPER_OTHER.test(after)) return "nopaper-guard";
          if (!TMPPAPER.test(pred)) return "nopaper-text";
          return "REVIEW";
        });
        const rs = [...new Set(reasons)].sort().join("+");
        counts[rs] = (counts[rs] ?? 0) + 1;
        (filesByReason[rs] ??= new Set()).add(id);
        lines.push(
          `${rs} | ${id} ${leaf.path}${leaf.msg ? " (msg)" : ""} | ${hs.map((h) => `[${h.name}]«${h.phrase}»`).join(" ")} | ${scan.length > 400 ? `${scan.slice(0, 400)}…` : scan}`,
        );
      }
    }
    lines.sort();
    TMPW(`${OUT}t140r4-unmarked.txt`, lines.join("\n"));
    TMPW(`${OUT}t140r4-diffs.txt`, diffs.join("\n"));
    TMPW(`${OUT}t140r4-throws.txt`, throws.join("\n"));
    TMPW(`${OUT}t140r4-oppassive.txt`, opPassive.join("\n"));
    TMPW(
      `${OUT}t140r4-summary.json`,
      JSON.stringify(
        {
          rawHits,
          markedTexts,
          counts,
          filesByReason: Object.fromEntries(Object.entries(filesByReason).map(([k, v]) => [k, [...v].length])),
          negPassiveFilesA: [...negPassiveFilesA],
          negPassiveFilesB: [...negPassiveFilesB],
          throws: throws.length,
          diffs: diffs.length,
          opPassive: opPassive.length,
        },
        null,
        1,
      ),
    );
  });
});
